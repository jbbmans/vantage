# ADR-0015 · Core record architecture: each record kind keeps its own store

**Status:** accepted · **Date:** 2026-10-18 · **Builds on:** [ADR-0002](0002-append-only-case-events.md),
[ADR-0012](0012-unit-manager-console.md), [ADR-0013](0013-security-audit-least-privilege.md),
[ADR-0014](0014-mcen-operations.md)

## Context

Task 9 of the governing specification (VANTAGE_CLAUDE_MASTER.md) is the core record architecture, at P0. It asks
Vantage to:

- stop flattening unrelated records into Activities;
- normalize the domain models;
- preserve existing data through controlled migrations;
- clearly define who owns the source of truth.

Section 11 of the specification lists the concepts Vantage should hold as authoritative entities, from Identity to
Audit Event. It says an Activity may provide a unified timeline, and must not replace the authoritative structured
record: a duty record, an award or a course may appear on the timeline, and stays the record.

What main held before this Task:

- **Awards, training, counselings and goals already had tables of their own.** `trainings.type` already kept PME,
  courses, qualifications, certifications, education and skills apart. `awards.type` already covered personal and unit
  awards and recognition (meritorious mast, certificate, letter of appreciation, coin). The flattening was in how
  entries were written.
- **Quick Log always saved an Activity.** Its parser filed award and course text under the activity categories
  "Recognition" and "Training & PME" (`CATEGORY_HINTS` in `shared/quickLog.ts`).
- **The Record overview invited it.** It described what a Marine records themselves as "PME, PT, volunteering,
  qualifications" (`src/pages/RecordHub.tsx`).
- **The CSV import takes activities only** (`importActivities`).
- **Duplicates already existed.** The FITREP worksheet writer lists a course logged both as training and as an
  activity once (`shared/writer/worksheet.ts`).
- **A recommended award was its subject's to change.** An award a leader recommends is stored with the Marine as its
  owner, and nothing recorded who entered it. By `canEdit` (`server/authz/records.ts`), the Marine could then mark it
  approved. Counselings already kept the counselor apart from the subject (ADR-0013).
- **Nothing said where each kind of record lives,** who writes it, who may correct it, or which system outside
  Vantage holds the official copy.
- **Activities drawn from a financial case** are tied back to it by a fingerprint prefix (`work:`, `case:`, `draft:`)
  and by `work_actions.activity_id` and `record_drafts.activity_id`.

## Decision

### 1. A registry of record kinds

`shared/recordKinds.ts` exports `RECORD_KINDS`: one entry for each concept in section 11, and one for Professional
Military Education, which the training table already keeps apart. Each entry gives:

| Field | What it says |
| --- | --- |
| `store` | its table and, where one table holds several kinds, which rows (for example `trainings` with `type 'pme'`); null for a kind no Task has built yet |
| `plannedIn` | the Task that builds a kind with no store |
| `writtenBy` | who writes it |
| `correctedBy` | who may correct it |
| `systemOfRecord` | the system outside Vantage whose copy is official, where there is one; Vantage's copy is the person's working record |
| `timeline` | whether it appears on the person's timeline (section 3) |
| `activity` | whether it is recorded as an Activity: true for Activity alone |

The record kinds a Marine writes about themselves:

| Kind | Store | Written by | Corrected by | Official copy |
| --- | --- | --- | --- | --- |
| Activity | `activities` | the person, about their own work; a financial case they worked, through a draft they word | the person; a unit leader with Edit others' records, on a shared entry | none |
| Training | `trainings` (`training`, `course`, `skill`) | the person | the person; a unit leader with Edit others' records, on a shared one | MCTIMS, and MarineNet for distance education |
| PME | `trainings` (`pme`) | the person | as for training | MCTIMS and MarineNet; MOL for the credit it earns |
| Education, Certification, Qualification | `trainings` (`education`, `certification`, `qualification`) | the person | the person | the school's transcript; the certifying body; MCTIMS |
| Award, Recognition | `awards` (`personal_award`, `unit_award`; the other types) | the person, or a leader who recommends them | whoever recorded it (section 5); never the subject of a recommendation | iAPS and MOL, for an award |
| Counseling | `counselings` | the counselor, or the person for their own notes | the counselor until it is acknowledged; never its subject | the signed counseling the command keeps |
| Goal | `goals` | the person, or a leader who assigns it | its owner; its assignee for status and progress | none |
| Duty | none yet: Task 17 | | | |
| Financial Error Snapshot | none yet: Task 15 | | | the report it was uploaded from |

The registry's other entries cover identity, accounts, membership, the personnel roster, units, teams, billets,
roles, permissions, duty types and scoring, tasks, financial cases and actions, reports, attachments, imports,
exports and the audit trail, each with its store and who corrects it.

### 2. An Activity is one kind, and never stands in for another

- **Only work a person did is an Activity.** An award received, a course completed or a counseling keeps a record
  of its own, and so will a duty once Task 17 builds duty records.
- **A conservative classifier** (`recordKindOf`) reads an entry's words and says whether they read like an award the
  person received or training they completed:
  - **An award received:** an award's name, one of its common abbreviations or award words (medal, commendation,
    meritorious mast, challenge coin), with words of receiving ("received", "awarded", "was presented"). Work done for
    others' awards stays an Activity: drafting, processing, routing or submitting them, "for my Marines", "for LCpl
    Diaz", "12 award packages". "LOA" is left out on purpose: on a financial desk it is a line of accounting far more
    often than a letter of appreciation.
  - **Training completed:** words of completing ("completed", "graduated", "passed") with course, PME, school,
    degree, certification or qualification words. Teaching, leading, running or building training for others stays
    an Activity. Rifle, pistol, range, PFT, CFT, MCMAP, swim qualification and the gas chamber are left to the
    readiness snapshot.
  - **When the words could be either, it says nothing,** and the entry stays an Activity.
- **It only ever suggests.** Nothing is moved without its owner. It is used where a person writes or reviews an
  entry: Quick Log and the activity form, the list of entries that may belong elsewhere (section 4), and the CSV
  import's count (section 7).
- **Quick Log and the New entry form save an award or training to its own record** when its owner chooses to ("Save
  as award", "Save as training"). Only activities wait in the offline outbox, so offline the entry is kept as an
  activity or saved once the connection is back.
- **"Keep as activity" is remembered.** An entry saved after its owner chose it is created with `kind_confirmed: true`,
  which sets `kind_confirmed_at`, and it is never suggested for a move.
- **An activity drawn from a financial case stays an Activity, tied to that case:** a fingerprint that starts
  `work:`, `case:` or `draft:` (`isDrawnFromWork`), or one `work_actions` or `record_drafts` points at.

### 3. The timeline is read on request and never stored

`GET /api/record/timeline` (`server/services/timeline.ts`) reads the person's own records from each kind's own table
every time it is asked for:

- **What it reads:**
  - their activities;
  - their training, as `pme`, `education`, `certification`, `qualification` or `training`;
  - their awards, as `award` (personal and unit awards) or `recognition`;
  - counselings where they are the subject, and their own notes;
  - goals they own or hold that were achieved.

  Deleted entries are left out.
- **Its date** is the record's own: an award's presentation, else its approval, else its date; a goal's completion,
  else its period's end, else its last update; for the others, the entry's date. Failing those, when it was created.
- **What it returns:**
  - items newest first, each with its kind, table, id, date, title, a detail line, its status, whether it was drawn
    from a financial case, and `href` to its own record's page;
  - `kind`, the kind it holds (null for every kind), so the page never shows one kind's entries as another's while
    the next answer is on its way;
  - `counts` by kind, `total`, and `truncated` when there were more than were returned;
  - `pending`: the timeline kinds that have no store yet, today Duty (Task 17), so an empty lane is not read as none.
- **Its window:** `from` and `to` as `YYYY-MM-DD`, refused when invalid or reversed; `limit` 200 by default, 500 at
  most, taken as a whole number.
- **One kind:** `kind` returns that kind's newest entries rather than those among everything's newest. `counts` stays
  every kind's, for the filters, and `truncated` is against that kind's count.
- **Only the person's own.** What a leader may read of someone else's records stays on that person's own pages.
- **Why never stored:** a stored timeline is a second copy that can disagree with the records it shows. Read from
  each store, it cannot, and an Activity never has to stand in for anything to appear on it. The client shows it as
  **Record → Timeline** (`/record/timeline`).

### 4. Moving an entry between activities, awards and training

`server/services/recordMoves.ts`. Only the entry's owner moves it, and only between the three tables in
`MOVABLE_TABLES`: `activities`, `awards` and `trainings`.

**`POST /api/records/:table/:id/move`** takes `{ to, fields?, reason?, version? }` and answers 201
`{ table, id, lineage_id, record }`.

- **What it becomes.** `movedFields` (`shared/recordKinds.ts`) maps what carries across, and fills sensible values
  for the rest.
  - An activity becomes an award named for the award its words name, or by its title.
  - An activity becomes training typed from its words, with its hours when the activity counted hours, and its
    organization as the provider.
  - An award or training becomes an activity under Recognition or Training & PME.

  An activity's result, notes and evidence links, and an award's citation, go into the new entry's notes. `fields`
  holds the owner's corrections, such as an award's type or a course's hours. Only the target type's fields are
  taken, and the result is checked as a new record of that type is. Two fields are never taken from a correction:
  `project_id`, which is checked against the projects the person may file under when the entry is edited, and
  `dollar_type`, which is checked against the instance's value types the same way. A correction that clears a field
  the target table requires (an empty `status`) leaves the value the move gives it.
- **An award named from its words keeps them.** When the award's name comes from what the activity says ("Navy and
  Marine Corps Achievement Medal" from "Received the NAM from the CO"), the activity's title opens the award's notes.
- **What it keeps.** The owner, unit, visibility and creation time. It gets a new id in its new table.
  - An award moved in is recorded by its owner (`recorded_by`), so it stays theirs.
  - An activity moved in gets a fresh fingerprint and is marked as one its owner confirmed (`kind_confirmed_at`).
- **One transaction:**
  1. inserts the entry in its new table;
  2. carries its attachments and comments across, whoever added them, kept or in the bin. A file the entry already
     holds where it lands (the same file stored twice) is binned rather than doubled;
  3. deletes the entry from its old table;
  4. writes a `record_lineage` row: from, to, the whole source row as it stood (`snapshot`), `method: 'move'`, the
     reason (up to 500 characters), who moved it and when.

  Whatever has no place in the new type, such as an activity's dollar value, is kept in the snapshot.
- **Audited at both ends.** `record_moved` is written twice, once against each end, each naming the other, in the
  entry's unit. It is user activity in the catalogue (`shared/auditCatalog.ts`), so the trail of either id says where
  the entry went or came from.

**It is refused when:**

| Code | Status | When |
| --- | --- | --- |
| `owner_only` | 403 | the caller is not the Marine the entry belongs to |
| `forbidden` | 403 | the caller may not read the entry, as when opening it |
| `deleted` | 403 | the entry is in its owner's recycle bin; anyone else is told it does not exist (404) |
| `frozen` | 403 | it was frozen when its unit membership ended |
| `drawn_from_work` | 403 | an activity drawn from a financial case (section 2) |
| `recorded_by_other` | 403 | an award a leader recorded for its subject (section 5) |
| `legal_hold` | 403 | an unreleased hold covers its Unit Instance, its record type or its owner |
| `placement` | 403 | the owner may no longer place it where it sits in its new type, for example after leaving its unit |
| `stale` | 409 | `version` was sent and the entry has changed since |
| `duplicate` | 409 | an identical activity already exists for that date |
| `nothing_to_undo` | 409 | an undo, when the entry's newest lineage is not a move into it |
| `already_restored` | 409 | an undo, when the entry it came from is already back |
| `lineage_unreadable` | 409 | an undo, when the move's snapshot cannot be read |
| `kept_for_hold` | 403 | an undo, when the move's lineage is kept only because a legal hold covered it as the entry was anonymized (section 7) |
| `record_moved` | 409 | a file upload whose entry moved while the file was being scanned. The check runs with nothing awaited between it and the insert, so the file is never stored against an entry that is gone |

Asking to move an entry to the type it is already in is a 400, and any table but the three is a 404.

**`POST /api/records/:table/:id/undo-move`** puts back the entry this one was moved from, and answers
`{ table, id, record }`:

- under its original id, with its content as the snapshot holds it;
- where it sits now: the current owner, unit and visibility, so an undo never carries back across a boundary what was
  added after the move;
- with its version one past the snapshot's, and live and unfrozen;
- with the files and comments it has gathered since;
- back in Activities, with its project only while its owner may still file under it from where the entry sits now
  (`assertFileableProject`); otherwise without one.

The same refusals apply. The undo writes its own lineage row (`method: 'undo'`, holding the row it replaces) and is
audited as `record_move_undone` at both ends. An entry moved back to Activities is marked as its owner confirmed. An
undo is not itself undone: moving the entry again is a new move.

**`GET /api/records/:table/:id/lineage`** answers anyone who may read the entry:

- every move and undo in its chain, across each id the entry has had, newest first;
- for each: from, to, method, when, and whether its owner made it.

What it said before each move (`before`) and the reason are its owner's only, because a reader of the entry now is
not thereby a reader of what it said before. `undo` is set only for the owner, and only when the newest lineage row
is a move into this record that may still be undone.

**Entries that may belong elsewhere.** `GET /api/record/move-candidates` answers `{ candidates, total }`:

- **What it reads:** the person's own live, unfrozen activities that its owner has not kept, newest first, up to
  5,000.
- **What it offers:** each one the classifier reads as an award or training and that may move, with the reading
  and the suggested target. The first 200 are returned, with the total.
- It is worked out on request and never stored. The client lists them in Activities, where each is moved or kept.

**`POST /api/records/activities/:id/keep`** is its owner saying an entry is work they did. It sets
`kind_confirmed_at` once, audited once as `record_kind_confirmed`, and the entry is not suggested again. It changes
nothing the entry says.

### 5. An award keeps who recorded it

- **`awards.recorded_by`** names who entered the award: the Marine, or the leader who recommended them.
  `createRecord` stamps the person creating it. A leader who holds Counsel members (`COUNSEL`) over the Marine
  recommends an award as before: it is stored with the Marine as its owner, shared with the unit.
- **A recommendation is never its subject's to change.** `recordedByOther(row)` is true when `recorded_by` is set
  and is not the owner. For such an award, `canEdit`:
  - refuses its subject, who therefore can neither edit nor delete it, and cannot move it (`recorded_by_other`);
  - lets its recorder edit it while it is shared with its unit and they hold `COUNSEL` there;
  - otherwise applies the shared-entry rule: `MANAGE_RECORDS` in its unit, on an award shared with it.

  A frozen award stays unchangeable.
- **The subject is told who.** Award lists, and an award opened on its own, add `recorder_name` ("Rank Lastname") to
  an award someone else recorded, for everyone reading it but the recorder. Not on an award a retention schedule has
  anonymized: its recommending official is gone, and the recorder's name would put it back. A recorder's change is
  audited as `edit` with "recorder edit".
- **This is the rule counselings already follow** (ADR-0013). An award the Marine recorded themselves, or moved in,
  is theirs as before.

### 6. Migration 023 moves nothing

`023_record_lineage`:

- **Adds `record_lineage`**, through `schema.sql`, with indexes on each end and on its owner. `unit_id` is the unit
  the entry sat in when it moved, so the move belongs to that Unit Instance's trail and archive.
- **Adds `awards.recorded_by` and `activities.kind_confirmed_at`.** Each column is added only when missing.
- **Fills `recorded_by` for older awards** (`backfillAwardRecorders` in `server/db/index.ts`): the actor of the
  award's first `create` entry in the audit trail, which for a recommendation is the leader, when that account still
  exists and the award is still shared with its unit; otherwise the award's owner. A Marine could make a recommendation
  private before 023, and a leader is never handed a Marine's private entry. The trail is read once, joined to the
  awards, rather than asked once per award.
- **Moves no row and declares no `reshapes`,** so ADR-0014's upgrade check has nothing to excuse.

**Decided by John, 2026-10-17 19:42 UTC, on the Task 9 thread's decision card: "Marine confirms"**, the recommended
option. Nothing moves when Vantage upgrades. Each Marine sees the entries in their Activities that read like awards
or training, and moves the ones that really are. Each move keeps its lineage and can be undone.

### 7. Exports, imports, retention and privacy

- **The instance archive** carries `record_lineage` (`EXPORT_TABLES`), so an undo still works on the host it moves
  to. Importing an archive from before 023 fills its awards' recorders as the migration does.
- **The personal export** carries the person's moves, with what each entry said before, as `record_moves` and
  `record-moves.csv`.
- **The CSV import** still writes activities, as asked. It returns `elsewhere`, the number of rows it put in that
  read like an award or training and will be offered for a move: not a duplicate it skipped, not an entry its owner
  kept as an activity, not one drawn from a financial case. The person moves them from Activities.
- **An edit keeps where an entry came from.** An activity drawn from a financial case keeps its `work:`, `case:` or
  `draft:` fingerprint when it is edited or updated by import, so it stays tied to the case.
- **Destroying or anonymizing a record removes its lineage.** That covers the recycle bin's purge and a retention
  schedule that destroys or anonymizes. Every lineage row in the record's chain goes with it, because each holds an
  earlier copy of it.
- **A legal hold keeps a chain.** A chain stays when an open hold covers its owner, any record type the entry has
  been, or the whole instance, because it holds what the entry said as a record of a held type. It stays only as
  evidence: its rows are marked `kept_for_hold_at`, nobody reads what they said back through the lineage, the owner
  included, and no move is undone from them (`kept_for_hold`), so a hold never puts an anonymized entry's words back
  in use. The retention run passes its own Unit Instance's holds; the purge passes every open hold. Each recycle-bin
  purge then lets go of what a hold kept once nothing holds it, even if the record has been written to since, and of
  a chain no standing record belongs to (`sweepLineage`).
- **What moves with the entry stays in view.** Comments are read and written on training as on awards, and Career
  shows the files an award or a course holds.
- **The privacy inventory** declares `record_lineage`, `awards.recorded_by` and `activities.kind_confirmed_at`.
  Readers of an entry see that it moved; what it said before is its owner's only.

### 8. Left to other Tasks

- **Duty (Task 17).** It has no store. The registry lists it as planned, the timeline names it as pending, and nothing
  suggests moving an entry to it. A duty logged as an Activity stays one until Task 17 builds duty records.
- **Financial error snapshots (Task 15).** No store yet. The registry lists it as planned, off the timeline.
- **Semantic import and export (Task 13).** Importing awards, training and the other kinds into their own records is
  Task 13's. Until then the activities import counts what reads as belonging elsewhere and changes nothing.
- **Navigation and naming (Task 10)**, and **training evidence (Task 19)**.

## Consequences

- **Activities still hold the award and training entries they held before,** until their owners move them. The
  FITREP worksheet's rule for a course logged both as training and as an activity is still needed.
- **A move gives the entry a new id.** A link or bookmark to the old id finds nothing until the move is undone. An
  undo brings back the original id.
- **A Marine cannot correct a typo in an award a leader recorded for them.** They ask the recorder, as the page tells
  them. A recorder who no longer holds Counsel members in the award's unit can no longer change it, unless they hold
  Edit others' records there.
- **The backfill trusts the audit trail.** An award with no `create` entry that names a living account, such as one
  seeded or imported that way, is taken as its owner's own and stays theirs to change.
- **The classifier misses some entries, on purpose.** An entry it cannot read stays an Activity, and its owner can
  still move it from its page.
- **A recommendation made private before 023 becomes its Marine's own,** since the backfill names a leader only on
  a shared award.
- **A chain kept under a hold outlives its record** until the first purge after the hold is released. While it is
  kept, an anonymized entry's move cannot be undone, and its owner's personal export still carries the rows, as it
  carries everything Vantage holds about them.

## Alternatives considered

- **Move automatically.** The card's second option: the upgrade moves clear matches into Awards and Training. Not
  chosen. Matching by wording can misread an entry ("Prepared 5 award recommendations" is admin work, not an award),
  and a misread entry stays moved until its owner moves it back. A guess from wording can silently misfile someone's
  record; the owner knows what each entry is.
- **New entries only.** The card's third option: existing entries stay as they are with no suggestions, and only new
  ones are steered to their own records. Not chosen. It leaves what is already recorded as it is, with nothing to
  point its owner to it.
- **A stored timeline.** Rejected: a second copy of every record, which could disagree with the records themselves.
- **One record table with a kind column.** Rejected: the record tables already exist with their own fields, rules and
  screens, and section 11 asks for authoritative entities, not one table for all of them.
- **Moving by copying, and leaving the original in place.** Rejected: two live copies of one entry is the duplication
  this Task removes. The snapshot keeps the original for an undo.

## Verification

- **`tests/server/recordArchitecture.test.ts`:**
  - the registry against the schema, and the timeline's kinds against the tables it reads;
  - the classifier, and what is drawn from a financial case;
  - moves to Awards and to Training and back, with corrections, new ids, files, comments, lineage and the audit at
    both ends;
  - an undo under the first id, and a second undo refused;
  - lineage as its owner reads it and as a leader who reads the entry does;
  - only the owner moving, and only an entry that is theirs alone;
  - a recommendation being its recorder's and the chain's to change, never its subject's;
  - move candidates, and the import's count;
  - the timeline: the person's own records, newest first, windowed, limited, never stored;
  - migration 023 from schema 22: recorders from create entries, and no activity moved;
  - lineage in the instance archive, an undo where it lands, and an archive from before 023;
  - the personal export, and destroying a moved record with its whole lineage chain;
  - an upload refused when its entry moves while the file is scanned, against a scanner that answers on cue;
  - an undo with the same file on both sides, corrections that cannot set a project or value type, a title kept in
    a named award's notes, and a project dropped on undo when it can no longer be filed under;
  - a recorder's edits only while the award is shared, and no recorder named on an anonymized award;
  - a hold keeping a chain after its record is purged, and the purge after release letting it go;
  - a chain a hold keeps as its entry is anonymized: no undo, nothing read back, and gone after release even once
    the entry has been written to;
  - the timeline's kind filter and whole-number limit, a work fingerprint kept through edit and import, the import's
    count, and an entry saved as kept.
- **`tests/server/auditCoverage.test.ts`** audits each migration through this build's last, now 023.
- **`tests/browser/38-record-architecture.spec.ts`** (8 tests): Quick Log saving an award and a course to their own
  records and keeping an ordinary entry; the Activities suggestions, a move to Awards and its undo; keeping an entry;
  the New entry form saving an award or keeping one, and the CSV import's count; a move to Training from an entry's
  page and its undo; and the Timeline page, with axe, including that a kind still on its way shows neither the last
  kind's entries nor "none".
