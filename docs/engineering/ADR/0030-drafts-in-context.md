# ADR-0030 · Drafts in context: a draft lives with its own kind, and the Drafts page reads them all

**Status:** accepted · **Date:** 2026-11-14 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0013](0013-security-audit-least-privilege.md), [ADR-0015](0015-core-record-architecture.md),
[ADR-0017](0017-personnel-records.md), [ADR-0019](0019-import-export-restore.md),
[ADR-0026](0026-workflow-and-auth-continuity.md), [ADR-0027](0027-counseling-workflow-navmc-2795.md)

## Context

Task 23 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P2) is the Drafts Redesign:

> Drafts should become contextual. Examples: Draft Counseling, Draft Report, Draft Goal, Draft Award, Draft Training
> Entry, Draft Personnel Change, Draft Task. A central Drafts page may aggregate these. It should not be a separate
> duplicate data silo.

What main held before this Task (at `f5c1e0e`):

- **Records → Drafts** (`/record/drafts`) listed one kind only: entries drawn from a case the person worked
  (`record_drafts`, "Prepare a private draft from my work"). Its menu count counted those.
- **Counseling** already had a draft stage (`counselings.stage`, ADR-0027). It is only its counselor's until it is shared
  for review or finalized.
- **Report packages** (`report_drafts`, ADR-0020) are working documents. A saved revision is a checkpoint, never final.
- **Correspondence** written and not sent is a thread in state `draft`. A message brought in from Outlook (.eml) also
  makes a `draft` thread until someone changes its state.
- **Goals, awards, training entries, tasks and billet or assignment changes had no draft.** Their form saved straight
  into the record, or nothing was kept. Closing the dialog lost what was typed. `src/lib/drafts.ts` keeps unsaved form
  text in session storage, which is lost when the tab closes and at sign-out, and which no other page can list.

## Decision

### 1. A draft lives with its kind. Nothing is copied

- **A counseling** is drafted where it always was: its own stage (ADR-0027).
- **A report package** is its own working draft.
- **Correspondence** not sent is its own thread, in state `draft`.
- **An entry from work** is its own `record_drafts` row, as before. Three things change:
  - one case gives one open draft. Asking again opens the one already started instead of making a second copy;
  - it is drawn only from a case its author can still open (`readable`, `server/services/work.ts`). Someone who has
    left the case's unit gets 404, as for a case that does not exist, and cannot read its title or who else worked on
    it. Main ignored the scope here. An entry they already drew stays theirs.
  - once kept, an entry is changed in the record, not in its draft (409 `already_recorded`).
- **The five kinds with no draft** (goal, award, training entry, task, personnel change) are kept, until they are sent,
  in one new table, `form_drafts` (migration 037). A row there is the unsent form: its values, as the form holds them.
  It is not a record, and no record table holds it.

**When a saved form is sent**, it goes through its kind's own route:
- `POST /api/records/:table?draft=<id>&draft_version=<n>` for a goal, award, training or task;
- `PUT /api/org/units/:unit/members/:user?draft=…` for a personnel change.

That route checks it as it checks any new record or change. The draft is removed in the **same transaction**
(`consumeDraft`, `server/services/drafts.ts`). So after it is sent, the record is the only copy. Until then, the draft is.
At no point do two copies exist.

**The Drafts page stores nothing.** `GET /api/drafts` (`listAllDrafts`) reads, for the person asking, from each kind's
own table, each time it is asked, newest first:
- saved forms;
- entries from work not yet kept;
- counselings they are writing about someone else at stage `draft` or `review`;
- every report package they have (the title says "revision N" or "not saved yet");
- threads they own in state `draft` that hold no inbound message.

It never lists a draft about the person that someone else is writing.

### 2. Why one new table, and not a draft stage on four record tables

A `stage` column on goals, awards, trainings and tasks would have to be excluded on every read that counts or lists those
records. Main has 36 named queries over those four tables in 13 server files, plus 49 queries over a table name in 17
files (`createRecord`, `listRecords`, the timeline, analytics, the unit dashboard, the digest, the report center, AI
inputs and the personal export). Each would need the exclusion, and any one that missed it would leak.

The leak would be worst for an award. A leader's award recommendation is owned by the Marine it is about
(`awards.user_id`), as a counseling is. So a recommendation "stage" would show up on every one of that Marine's own reads.
ADR-0027 had to close exactly that gap for counselings.

A personnel change cannot have a stage at all. The history triggers on `unit_members` and `personnel_records`
(`server/db/index.ts`, `unit_membership_changed`, `personnel_record_changed`, `personnel_assignment_dated`) fire on any
change to those columns.

Rejected:
- **A draft stage on each record table**, for the reasons above.
- **Browser-only drafts** (`src/lib/drafts.ts`, session storage): lost when the tab closes and at sign-out, and not listed
  anywhere else. That storage still holds unsaved text for the Quick Log and is cleared at sign-out.

### 3. A saved form is its author's alone

- **Only its author reaches it.** Anyone else gets 404, the same answer as for a draft that does not exist
  (`draft_gone`). Reading, updating, discarding, listing and sending are all checked against the author.
- **Nothing counts or lists it.** It is in no record table, so no list, count, report, export of another person, digest,
  notification or AI input reads it.
- **An award recommendation names its Marine.** The Marine is not told of it, does not see it, and does not get it in
  their own export (`personalExport.ts` includes only saved forms with no subject). It names its unit too.
- **Its author's own export includes their saved forms** that are about nobody else (`saved_drafts`, ZIP
  `saved-drafts.csv`). A recommendation or a personnel change about someone else stays out of it. It is about another
  person, and its author can read it in the app.
- **The audit trail records** `save_draft` and `discard_draft` (author's own actions, with no subject and no unit, so they
  are never in anyone else's or any unit's view) and `drafts_expired` (enterprise). A record made from a draft says
  "from saved form" in its own `create` or `edit_membership` entry.

### 4. Authority is checked at save, at read and at send

**An award recommendation draft** needs, in its unit:
- the right to see the Marine there (`detailUnitsFor`);
- Counsel.

**A personnel change draft** needs Manage members in its unit, above the Marine there (`personnelAccess().manageIn`). The
same refusals apply as for the change itself: not a member there (404); not above them (403, `hierarchy`).

**These are checked:**
- when the draft is saved;
- when it is saved again;
- every time it is read (its `can_submit` and `blocked`);
- when it is sent.

**Kind, Marine and unit are fixed when the draft is created.** An update changes its values and nothing else. A
recommendation's own values name that unit too, set at every save, so opened again and sent, it goes to the unit it was
drafted in. (The form's unit list is its author's own units, which can name one where they may not counsel the Marine.)

**When the author loses that authority**, the draft stays theirs to read and to discard. It cannot be saved again or sent
(403, `draft_authority`). Its reason names no unit and no whereabouts. A personnel change's "what it was" is no longer
returned.

**Sending checks that the draft matches the request**, and refuses otherwise, creating nothing:
- the author;
- its kind;
- its Marine (`draft_mismatch`);
- for a recommendation, its unit (`draft_mismatch`). A recommendation goes to the unit its draft was saved in, or
  nowhere: `createRecord` never places it somewhere else;
- the version the sender read (`draft_changed`, with the current copy);
- the author's authority (`draft_authority`).

It is removed only if exactly one row is removed (`draft_gone` otherwise). A second send of the same draft, from a
retry or another window, finds no draft and creates nothing.

**The server never turns an id in a saved form's values into a name or a place.** A saved form's values are checked
loosely. The kind's own route checks them strictly when the form is sent. So reading a name or a unit for an assignee,
project, billet, supervisor or unit taken from those values would let a crafted save look up people and commands across
Unit Instances. Only the Marine and unit a draft is about, which were checked when it was saved, are named on the server
(`subject_label`).

A personnel change keeps the supervisor's name as its author's form showed it (`supervisor_label`). Its "what it was"
(`was`) is read by the server from the assignment itself at each save. That is the reader's own Manage-members view.

### 5. Bounded, kept 90 days, and held by any legal hold

**Bounds:**
- values: up to 32 KB as JSON;
- one value: 8,000 characters;
- goal filters: 40 keys;
- drafts per person: 200 (`draft_quota`).

The fields a kind keeps are that kind's own (`TABLES[table].fields`, plus visibility and unit). Anything else is dropped.

**Expiry.** A saved form is removed 90 days after it was last saved. A sweep runs every six hours (`form_drafts_expire`).

**Legal holds** keep it, as they keep everything else (`holdState`):
- an instance-wide hold keeps every saved form;
- a hold on `form_drafts` keeps every saved form. The holds consoles offer it (`HOLDABLE_TYPES`). Like a hold on
  `source_files`, one placed by any organization keeps them everywhere, which keeps more, never less;
- a hold on a person keeps the forms they wrote and the forms about them.

A form discarded or sent while a hold keeps it is hidden (`deleted_at`), not deleted. The sweep removes it once the hold
no longer applies. Every run records a disposition run, including those a hold stopped. Removals are audited as
`drafts_expired`.

**Export and import:**
- the instance export (`EXPORT_TABLES`) includes `form_drafts`;
- the personal export includes the person's own saved forms (§3);
- a personal import counts them and brings none back. A draft is unfinished; it stays in the export, to be finished as a
  new entry;
- the privacy inventory declares every column.

### 6. The forms

- **Save draft.** A new goal, award (one's own, or a recommendation from a Marine's page), training entry or task
  (`RecordDialog`'s `formDraft`) has Save draft, and so does a billet or assignment change (`AssignmentDialog`):
  - Save draft skips the form's validation (a draft may be half written) and is never counted as a completed capture
    (`capture.abandoned`, state `saved_draft`);
  - the form says what each button does: "Save draft keeps it to you. Adding it puts it in the record now, and … is
    told";
  - an edit of an existing record has no Save draft: it is already in the record.
- **Closing a form with unsaved text asks first:** Keep editing, Discard changes, or Save draft. Drafts are still never
  saved on their own (ADR-0026).
  - Keep editing puts focus back in the field the person was typing in. A dialog opened by state has no trigger to
    return focus to, so the leave check and every confirm (`ConfirmDialog`, `useReturnFocus`) put it back themselves.
  - While Save draft is on its way, nothing else can be chosen: the form closes when it is saved.
  - A draft its author may no longer send cannot be saved again, so Save draft is not offered; the check says the
    changes will be lost.
  - If Save draft finds the draft gone or changed, the check closes and the form says what happened.
- **Opening a draft.**
  - A page opens one of its own drafts from `?draft=<id>`. The form is seeded once, and the draft's id and version are
    kept beside the form, never in it.
  - If the draft is gone (sent or discarded in another window), the form keeps what was typed and offers "Add it as new"
    or "Save it as a new draft". If it was saved again elsewhere, it offers "Load the newer version" or "Keep mine".
  - A link to a draft that is gone says so and opens nothing. One that could not be read (offline, or a server error)
    says that, and the link stays, to be tried again.
- **A drafted personnel change, opened again,** shows the change over the assignment as it is now. It says in words
  which fields someone else changed since it was saved. If the change is already in place, it offers to discard the
  draft.
- **Each page lists its own drafts** above its list ("Your drafts", the newest three, then "All N in Drafts"):
  - Goals, Training, Tasks;
  - Awards, which includes recommendations the person drafted, each opening on its Marine's page;
  - a Marine's page, for award recommendations;
  - the Personnel tab, for billet changes.
- **The Drafts page** lists every draft, filterable by kind:
  - each says who else can read it ("Only you", "Shared with … to review", "Your unit can open it");
  - each opens where it is finished;
  - each saved form says how long it is kept, in words, and warns, in words, in its last 14 days;
  - "Waiting on you" is what the menu counts. A counseling shared for review waits on its Marine, and a report package
    not worked on in 30 days is listed under "Not waiting on you", not counted;
  - a form its author may no longer send is read on the Drafts page, with Discard. Every list sends it there, which
    needs no access to its Marine;
  - an entry from work is still worded there. One already kept is read there, with a link to the entry;
  - each kind lists its newest 200. Past that the page says so, and the count still counts every draft.
- **Today** shows the newest three drafts waiting on the person.

## Consequences

- The spec's seven kinds are all drafts in context. Five are new; counseling, report and the entry from work already
  were. Correspondence is listed too.
- No count, list, report, analytic, export of another person or notification changed. None reads `form_drafts`.
- A saved form is a second place unsent text lives, beside session storage, until it is sent or removed. It is bounded,
  expires and is held as above.
- Unsaved section text in Report Studio, and a counseling's unsaved text, still have no draft of their own beyond what
  those editors already save.
- **Not done:**
  - a goal, training or task draft has no unit column (it is about nobody else), so the privacy inventory counts those
    per author, not per unit;
  - a person leaving a command keeps their recommendation and personnel drafts about its Marines until they expire.
    They cannot send them, because their authority is checked at send;
  - reading the Drafts list does not audit the review-stage counselings it names. Opening one does.
