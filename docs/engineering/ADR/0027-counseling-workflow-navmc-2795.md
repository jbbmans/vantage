# ADR-0027 · Counseling as structured data: a draft, a review, a final text that changes only by amendment, and a NAVMC 2795 worksheet

**Status:** accepted · **Date:** 2026-11-13 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0013](0013-security-audit-least-privilege.md), [ADR-0015](0015-core-record-architecture.md),
[ADR-0019](0019-import-export-restore.md), [ADR-0020](0020-reports-printable-output.md)

## Context

Task 20 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P1) is Counseling + NAVMC 2795:

- "Counseling must be structured data. Support: draft, review, finalization, amendment history, preview, professional
  PDF, print."
- "Generate NAVMC 2795-compatible output where appropriate."
- "Do not make PDF the only stored representation. Reuse Vantage PDF infrastructure."

What main held before this Task (at `dae67db`):

- **One flat, mutable row.** `counselings` held the date, type, counselor's name, summary, strengths, areas to improve,
  goals set, follow-up date, `counselor_id`, `acknowledged_at` and `version`. No stage, no draft, no history. An edit
  overwrote the row, and the audit trail kept only the names of the fields changed (`counseling_amended`).
- **Read at once.** The Marine read a counseling the moment it was written, and was asked to acknowledge it then.
- **Acknowledgement not bound to the text.** `POST .../acknowledge` took no version, so a correction that landed while
  the Marine read could be acknowledged unread. After acknowledgement nobody could change anything, not even to correct
  a wrong date.
- **No preview, print or PDF.** One counseling downloaded as JSON or a CSV row.

### NAVMC 2795, as found

- NAVMC 2795 is the *USMC User's Guide to Counseling* (21 Jul 86, PCN 100 013485 00), a publication, not a numbered
  fillable form. It is published at <https://www.marines.mil/portals/1/publications/navmc%202795.pdf>.
- Its Appendix A holds two *suggested* worksheets: **Figure A-1**, "Counseling Worksheet - Lance Corporal and Below",
  and **Figure A-2**, "Counseling Worksheet - Corporal and Above". Their labels (Name, Date, Grade, MOS, Billet, ICS /
  Follow-on, the narrative blocks, the two signature lines, the target date for the next session) were read from the
  published PDF, which is a scan: the labels come from its text layer, and **the visual layout has not been checked
  against the printed figure**. John should hold a printed worksheet next to the figure before relying on it.
- Paragraphs 2001-2002 name three kinds of session: the initial counseling session (ICS), follow-on sessions, and
  event-related ones.
- Paragraph 3005.1.i: documentation of a counseling session "is for use only by the senior and the junior".
- Both figures print an SSN block. Vantage never records or prints an SSN (DoDI 1000.30, reduction of SSN use).

## Decision

### 1. A counseling a leader writes has a stage

`counselings.stage` is `draft`, `review` or `final` (migration 035, CHECK). A counseling written by a counselor about
another Marine (`counselorWritten`: `counselor_id` set and not the Marine) moves through them. A Marine's own notes of a
counseling they received are always `final` and keep the rules they had: theirs to edit, nothing to acknowledge.

| Stage | Who reads it | What it is |
|---|---|---|
| `draft` | its counselor alone | Being written. Nobody else, whatever they hold in its unit, sees it or counts it. |
| `review` | its counselor and its Marine | Shared with the Marine to read and answer in its comments. Not yet theirs to acknowledge. |
| `final` | as every counseling was read before (ADR-0013) | The record. The Marine is asked to acknowledge it. |

- **Nothing else counts a counseling that is not final**: the timeline, the unit dashboard's last counseling, the
  digest, analysis, the report center and Report Studio sources, the AI's prepared input, the personnel record's
  counts, the member page (to anyone but its counselor), the personal export of its Marine, comment mentions and comment
  notices. Its counselor still sees their drafts where they work on them: their counseling list, the Marine's page, their
  recycle bin and their own export.
- **A draft one may not read is no such record**: reading, editing, deleting, restoring, commenting, every workflow
  step, its revisions, its worksheet and its PDF answer 404, not 403, so its existence is not disclosed. A final
  counseling one may not read still answers 403, as before.
- **Default `final`.** Every counseling written before 035, every archive from before it, an import, and an API caller
  that writes one for a Marine without naming a stage, get a final counseling, as they would have before. A final one
  written for a Marine needs its date, as finalizing does.

### 2. Who moves it, decided once

`counselingAuthority` (server) works out what the reader holds over one counseling:

- **counselor**: they wrote it (`counselor_id`) and still counsel its Marine: Counsel members in a unit the Marine
  serves in, where they may open the Marine's record (`stillCounsels`, the rule writing one took). A counselor who has
  moved on keeps reading and printing what they wrote, but no longer shares, finalizes or amends it.
- **manager**: Manage shared records in its unit, on a counseling shared with that unit, never one about themselves.
  They corrected such a counseling before; they amend it now.
- **subject**: it is about them.

One pure function in `shared/counseling.ts`, `counselingOptions`, turns that and the row into what the reader may do
(`edit`, `share`, `withdraw`, `finalize`, `amend`, `acknowledge`). The server enforces it, and sends it with every
counseling as `workflow`, so the page offers exactly what the server will accept. Nothing moves on a counseling that is
deleted, frozen because its Marine left the unit, or anonymized, except that its Marine may still say they read it.
Every step checks who may take it **before** it reads the request's body, so a caller with no right to it learns
nothing from a validation error.

### 3. Draft, review, final

- `POST /api/records/counselings` with `stage: 'draft' | 'review' | 'final'` writes one at that stage. An edit
  (`PUT`) never sets a stage.
- `POST .../share` (draft → review) and `.../withdraw` (review → draft), by its counselor, against the version they
  read (409 `stale` otherwise). Sharing tells the Marine.
- `POST .../finalize` (draft or review → final), by its counselor, against the version read. It needs the session's date.
  It stamps `finalized_at` and `finalized_by`, and keeps the **particulars** the worksheet prints as they stand at that
  moment (`particulars`, JSON): the Marine's name, rank, grade, MOS, billet and unit, and the counselor's name and rank.
  A promotion or a new billet later does not rewrite a finalized worksheet. The Marine is told, and asked to acknowledge.
- A counselor-written counseling is edited, deleted and re-placed only while it is a draft or in review, and only by
  its counselor. Once final, its words change only by amendment, and nobody deletes or re-places it.

### 4. Amendment history

`POST .../amend` changes a final counseling: the fields that change, a reason (required, at most 1,000 characters), and
the version the amender read. At least one field must change. Its counselor (who still counsels its Marine) or a manager
amends it; its Marine never does (they answer in its comments).

- The text it replaces is kept in **`counseling_revisions`**: which revision it was, what it said and its particulars,
  when that revision was finalized or written, whether and when the Marine had acknowledged it, who amended it, when,
  why, and which fields changed. One row per amendment, `UNIQUE (counseling_id, revision)`.
- **Append-only.** Triggers refuse any change to a revision row, except replacing its words and reason with the
  retention notice when a schedule anonymizes the counseling. It is destroyed with its counseling (`ON DELETE CASCADE`).
  Its `unit_id` is the counseling's, and the Unit Instance boundary triggers (ADR-0008) keep it there.
- The counseling's `revision` goes up by one, and its **acknowledgement is cleared**: the Marine is told and
  acknowledges the amended text. Its counselor is told when a manager amended it.
- `GET .../revisions` lists the history to whoever may read the counseling, with the amender's name, never their id.

### 5. Acknowledgement is bound to the text read

`POST .../acknowledge` takes the `version` the Marine read; if the counseling changed since, it answers 409 `stale` and
nothing is recorded. A counseling not yet final answers 409 `counseling_stage`. Acknowledging again changes nothing.
Its counselor is told. Acknowledging means they read it, not that they agree; the page says so.

### 6. One worksheet: the preview, the print page and the PDF

The record is the source. `GET .../worksheet` builds one structured document from it (`CounselingDocument`,
`shared/counseling.ts`), and three things draw that document:

- the **preview** in the counseling's dialog (Record | Worksheet);
- the **print page** at `/career/counseling/:id/print`, outside the app's frame as a report's is (ADR-0020): Letter,
  the toolbar never prints, `?autoprint=1` opens the print dialog, `?revision=N` prints an earlier text;
- the **PDF** at `GET .../export?format=pdf[&revision=N]`, drawn on demand by `server/lib/pdfCounseling.ts` with the
  report PDF's pieces: `pdfText` for the standard fonts, `drawMark`, Letter, and the handling line at the top and foot
  of every page with "Page N of N". **It is never stored.** The same revision draws the same file (its creation date is
  the finalization's), long text runs on to the next page rather than being cut, and the file name names the record and
  revision, never the Marine (`vantage-counseling-<id8>-r<revision>[-draft|-review].pdf`).

What the document holds:

- **Figure A-1** for a Marine whose grade is E-1 to E-3, **Figure A-2** for everyone else (and for an unknown grade).
- The head boxes as the figure has them (`worksheetHead`), then two Vantage adds: the unit and the type of session.
  A-2's ICS / Follow-on boxes are ticked from the type (initial → ICS; monthly, quarterly, semi-annual → follow-on); an
  event-related session says so. **The SSN block is left out**, and the worksheet says why.
- The narrative blocks in the figure's order, each Vantage field where the guide asks for it (`worksheetBlocks`):

  | Field | Figure A-1 | Figure A-2 |
  |---|---|---|
  | Goals set | Tasks Assigned Next Period | Targets for Coming Period and/or Comments |
  | Summary | Subjects on Which Guidance Was Provided | Agenda/Subjects Discussed |
  | Strengths | Major Accomplishments and/or Comments | Major Accomplishments |
  | Areas to improve | Major Accomplishments and/or Comments, labelled | Targets for Coming Period and/or Comments, labelled |

- The two signature lines, **Marine Counseled** and **Marine Performing Counseling**, with what Vantage knows under
  each: acknowledged on a date (and that it means read, not agreed), finalized on a date and by whom. They stay lines to
  sign on paper; Vantage does not sign.
- The target date for the next session, the amendment history (newest first, at most 50, with the total), the notices
  (para 3005.1.i; no SSN; for own notes, that no counselor signed them; for a counseling finalized before 035, that its
  particulars are as they are now), and a source line: "Counseling worksheet in the layout of NAVMC 2795 … Not an
  official form; produced by Vantage from the structured record."
- A band when it is not the final current text: `DRAFT - NOT FINAL`, `DRAFT FOR REVIEW - NOT FINAL`,
  `REVISION n OF m - REPLACED BY AN AMENDMENT ON <day>`, or `AMENDED - REVISION m`.
- The handling line is the instance's (runtime `reportMarking`, set in the Vantage Administrator console, ADR-0020 §6),
  "Working paper" when none is set. Vantage adds no classification or CUI marking of its own.
- Its dates are days in the reader's time zone, as its "generated on" is.
- Anonymized under a retention schedule, it names nobody: the particulars, the amenders and the reasons carry the
  retention notice.

### 7. Audit

| Action | When |
|---|---|
| `create` | detail `counseling draft`, `counseling review` or `counseling final` |
| `counseling_shared`, `counseling_withdrawn` (new) | shared for review, taken back |
| `counseling_finalized` (new) | detail `from draft` or `from review`, and the revision |
| `counseling_amended` | an edit of a draft or a counseling in review, detail `counselor edit; changed: …`, as an edit of one was before; an amendment, detail `counselor amendment` or `manager amendment`, the new revision, the fields changed (by name, never their words), and whether an acknowledgement was cleared |
| `acknowledge_counseling` | detail: the revision acknowledged |
| `print_counseling` (new) | the print page asked for the worksheet, with the revision and stage |
| `export_record` | the PDF, detail `pdf; revision n` |
| `view_record` | someone other than its Marine previewed its worksheet |

No counseling's words, and no amendment's reason, go into the audit trail or a notification.

### 8. Exports, imports, retention

- The **personal export** carries a counseling about the Marine once it is final, and every one they wrote, with each
  one's amendment history (`counseling_revisions`, amenders by name, the exporter as "me"); the ZIP adds
  `counseling-revisions.csv`. The **instance export** carries `counseling_revisions`.
- An **import** brings a counseling in as the Marine's own notes, as it reads now (John's Task 13 decision), so it is
  final; its history stays in the export it came from. A counseling draft about the Marine is never matched against or
  named by an import.
- **Retention**: anonymizing a counseling also replaces its particulars, and the words and reasons of its amendment
  history, with the retention notice; which revision, who, when and which fields stay. Destroying it destroys its history.
- The **privacy inventory** lists the new columns and `counseling_revisions`.

### 9. Migration 035

`035_counseling_workflow` adds `stage` (default `final`), `revision` (default 1), `finalized_at`, `finalized_by` and
`particulars` to a database that lacks them, with the CHECKs a new database gets, and the index
`idx_counselings_stage (counselor_id, stage)`. `counseling_revisions` and its triggers come from `schema.sql`, which is
safe to replay. Every counseling already written is final at revision 1 with no finalization stamp or particulars:
nothing recorded them, and its worksheet says its particulars are as they are now. No row is removed or reshaped, and no
counseling's text, people, unit or acknowledgement is touched. It is idempotent, and leaves no Unit Instance boundary
violation and no foreign-key error (`tests/server/migrations.test.ts`).

### 10. Where it shows

- **The Marine's page → Counseling** (for a leader with Counsel members): New counseling opens the form with **Save
  draft**, **Share with Marine** and **Finalize**. Each counseling shows its stage, Print, and the steps the reader may
  take (Edit, Share with Marine, Take back, Finalize, Amend…), and an amended one its amendment history.
- **Records → Counseling** (`/career/counseling`): the list says where each stands (Draft, Shared for review, To
  acknowledge, Awaiting acknowledgement, Acknowledged, Amended, Self-recorded). The dialog says in one sentence where it
  stands and what happens next, shows the record or its worksheet, its amendment history, its comments, Download (the
  worksheet as a PDF first, then JSON and CSV), Print, and the reader's steps. Finalizing asks first. Amending shows the
  form with the reason and what changes.
- Links stay `/career/counseling?open=<id>`; no menu entry is added.

## Behavior that changes

- A final counselor-written counseling is no longer edited, deleted or re-placed by anyone. It is amended, and what it
  said before is kept. (Before, its counselor or a manager edited it in place until it was acknowledged, and nobody
  could correct it after.)
- A records manager no longer deletes a counselor-written counseling; they amend a unit-shared one.
- A counseling written through the API without a stage is final, as before; one written final needs its date.
- The Marine's acknowledgement must name the version read.
- A comment on a counseling tells its counselor, so a Marine's answer to a draft shared for review reaches them.
- On a final counseling, its counselor (who still counsels its Marine) adds and removes files, such as a signed copy of
  the worksheet, though its words no longer change.

## Decided, and defaults John can change

- **The review is the Marine's** (the decision card in the Task 20 thread recommends it; it is unanswered as this is
  written). If John picks "A senior reviews it too", a reviewer step is added between review and final; if "No review
  step", share and take back are removed and drafts go straight to final.
- **A manager may amend** a unit-shared counseling, as they could correct it before.
- **Particulars are kept at finalization** and not refreshed.

## Alternatives considered

- **Store the PDF.** Refused by the specification ("Do not make PDF the only stored representation"), and a stored file
  would drift from the record it was drawn from. The PDF is drawn from the record each time and is the same for the same
  revision.
- **Fill an official form.** NAVMC 2795's worksheets are suggested layouts in a publication, not a fillable form, and
  both print an SSN. Vantage draws the layout, says it is not an official form, and leaves the SSN out.
- **Version every edit of a draft.** A draft is the counselor's own working text; the audit trail names the fields each
  edit changed. Only what a Marine could have read and relied on, a final text, is kept by revision.
- **Let an acknowledgement survive an amendment.** It would say the Marine read words they never saw.

## Not done here

- A senior reviewer step (see the decision card).
- Electronic signature. The worksheet keeps the figure's two signature lines for paper; CAC signing is not built.
- Checking the worksheet's layout against the printed figure (above), and any USMC or MCEN marking beyond the instance's
  configured report marking.
- HawkScan (no API key in this environment).

## Consequences

- Counseling is structured data with a lifecycle: the record is authoritative, and every printed or downloaded worksheet
  is a reading of one revision of it.
- A Marine always acknowledges the text they read, and a correction never erases what was there before.
- Drafts are invisible beyond their counselor, which every new read path for counselings must keep: use
  `finalCounselings()` or the counselor-aware clause in `server/authz/records.ts`.
