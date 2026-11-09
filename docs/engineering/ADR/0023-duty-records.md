# ADR-0023 · Duty records: duty stood, worked out and scored on the server, waiting for review

**Status:** accepted · **Date:** 2026-11-09 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0012](0012-unit-manager-console.md), [ADR-0013](0013-security-audit-least-privilege.md),
[ADR-0015](0015-core-record-architecture.md), [ADR-0018](0018-record-timeframes.md),
[ADR-0019](0019-import-export-restore.md), [ADR-0020](0020-reports-printable-output.md)

## Context

Task 17 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P1) is the Duty Tracker: "Duty is a first-class
record." Its fields may include the Marine, duty type, title, unit, location, start and end date and time, duration,
overnight, multi-day, notes, attachments, submitted by, submission date, approval status, reviewer, approval date,
rejection or return reason, calculated points, approved points and the scoring policy and version. Duty types are
configurable (DNCO, ADNCO, Barracks Duty, SAF, Color Guard, Funeral Detail, Range Support, Working Party, Event Support,
Command Duty).

Task 18 (Duty Approval, Permissions and Scoring) follows: submit, then pending review, then approve, return or reject;
self-entered duty does not count until approved; calculated and approved points kept apart; overrides need authority
and a reason; scoring versioned by effective date; and historical scores never silently recalculated.

What main held before this Task (at `9e7e0ba`):

- **Duty types** (`duty_types`, ADR-0012): each Unit Instance's catalogue, with codes, retired rather than deleted.
- **Scoring versions** (`duty_scoring_policies`, ADR-0012, brought forward from Task 18 on John's Task 6 card): immutable
  versions that take effect tomorrow or later, after every version not withdrawn, and can be withdrawn only before they
  take effect. `policyOn` picks the version in force on a day; `calculatePoints` applies its rule and multipliers. ADR-0012
  asked Task 17 to store, with each duty, the version and the points.
- **No duty record.** `RECORD_KINDS` named duty as planned for Task 17. The timeline listed it as not yet recorded; the
  personnel record counted Operations activities as "duty"; the Duty report printed configuration only; an import
  listed duty rows and left them out; the console said "Vantage does not record duty yet".
- **Decisions that bind it.** Task 9 card: nothing moves out of Activities on upgrade; each Marine moves the entries that
  are really duty, with lineage and undo. Task 12 card: an entry across two periods counts in each. Task 13 card: an
  import brings in others' records about the Marine as the Marine's own copies.

## Decision

### 1. A record table, `duties` (migration 031)

`duties` is a record table like awards and training, so the registries (`RECORD_SCHEMAS`, `TABLES`, `RECORD_COLUMNS`,
`TABLE_LABELS`, `TIMEFRAMES`, `RECORD_KINDS`) carry it into the generic routes, the recycle bin, holds, purge, freezing,
capacity, attachments, comments, the personal export and import, the record download and the instance archive.

| Column | What it is |
| --- | --- |
| `user_id` | the Marine who stood it |
| `unit_id` NOT NULL, `visibility` = `'unit'` | the unit it was stood for; duty is never a private note |
| `duty_type_id` NOT NULL | one of the Unit Instance's duty types, in use when chosen |
| `title`, `location`, `notes` | free text |
| `date`, `start_time`, `end_date`, `end_time` | all four required: the wall clock where it was stood (ADR-0018) |
| `hours`, `days`, `overnight`, `multi_day` | worked out by the server, never taken from a client or a file |
| `conditions` | JSON list of the scoring conditions it is scored with |
| `recorded_by`, `submitted_at` | who submitted it, and when |
| `approval_status` | `pending` (all Task 17 writes), `approved`, `returned`, `rejected` |
| `reviewed_by`, `reviewed_at`, `review_reason`, `approved_points` | Task 18's to fill |
| `scoring_policy_id`, `scoring_version`, `calculated_points`, `scoring_basis` | the version it was scored under, its points, and how |

CHECKs hold the review columns together: a decided duty names its reviewer and time; approved points only on approved
duty; a returned or rejected duty has its reason; a scoring version id and number come together. Hours are above zero and
at most 720; duty days 1 to 30.

Migration 031 creates the table (from `schema.sql`), rebuilds `record_lineage` so its table CHECKs allow `duties` (rows,
rowids and indexes kept), and re-runs the instance-boundary and timeframe triggers. No data moves.

### 2. What a duty ran to is worked out, not entered

`shared/duty.ts` is pure, so the form shows what the server will store:

- **Hours** are the minutes from start to end over 60, to two places. No time-zone conversion (ADR-0018).
- **Duty days** are each 24 hours or part of them, at least one. **Overnight**: it ran past midnight. **Multi-day**: more
  than 24 hours. **Weekend**: some day it covered was a Saturday or Sunday. A duty ending at 0000 did not stand the day
  that begins then.
- **Conditions.** Weekend and overnight come from its times. Holiday, short notice, extended and consecutive are claimed
  by whoever records it, and a reviewer checks them (Task 18).
- **Rules.** All four of start and end day and time are required; the end is after the start; it is 30 days at most
  (record a longer period as one duty for each part); and it ends today or earlier in the deployment's zone, because duty
  is recorded once it has been stood.

### 3. Scored once, under the version of its first day, and kept

The server scores a duty when it is recorded, with `policyOn(versions, start day)` and `calculatePoints`, the arithmetic
the console's Try it shows. It stores the version's id and number, the points and the basis (day, version, rule in words,
base, factor, conditions applied, hours, days, and why there are no points when there are none). It scores again only
when its days, times, type, claimed conditions or unit change, and then under the version in force on its first day.
The weekend and overnight its times give are not claims: a form that sends back only what was claimed changes nothing,
and an edit that is not scored again keeps the conditions the duty has. It never rescores on read.

Because versions take effect tomorrow or later and only a version not yet in force can be withdrawn, the version in force
on a duty's first day never changes after the duty is stood. With no version in force a duty is recorded with no points
and says so; a version that does not score its type gives none. A configuration file (ADR-0019) loads scoring versions
only into a Unit Instance that has none, and, when that instance already holds duty, only if none of them takes effect
by today, so a file cannot reach back over duty stood under no version.

### 4. Who records and corrects it

- **The Marine** records their own duty, for a unit they serve in: a membership, not Counsel that a role in a parent
  unit carries down (whoever records their own duty must be able to correct it, and correcting it asks the same). The
  same holds when they move an activity to Duty, change a duty's unit, import duty naming a unit, or undo an import
  that moved one.
- **A leader with Counsel members in a unit** records duty for a Marine there (the awards and counselings rule:
  `detailUnitsFor ∩ Counsel`). `recorded_by` names them. The Marine is notified ("Duty recorded for you"), sees it, and
  cannot change it. The leader and a records manager in the unit can.
- **Correcting** follows `canEdit`: its recorder or a records manager while it is pending or returned. **Approved and
  rejected duty is refused any edit, delete or move** (`duty_decided`), so Task 18's decisions stand.
- `GET /api/record/duty/options` gives the form the units the caller may record in (for `?for=` a Marine, those units
  they counsel in), each Unit Instance's duty types in use and its published versions' content (never who published them
  or why). A duty type from another Unit Instance is answered as one that is not there.

### 5. Kept inside its Unit Instance (ADR-0008)

Triggers refuse, on insert and update, a duty whose unit, duty type or scoring version belong to different Unit
Instances, and refuse moving a duty type to another instance while duty names it. `instanceBoundaryViolations` checks
existing rows. A duty is placed only in a unit of the instance the record is in.

### 6. Activities that were duty move, if their owner says so (Task 9 card)

`GET /api/record/duty/candidates` lists the person's activities whose words read like duty they stood (DNCO, SAF, OOD,
working party, fire watch, duty…) and not like work about duty (building a roster, scheduling a watch bill). Nothing is
stored and nothing moves on its own. Records → Duty offers each: **Record as duty** opens the duty form filled from the
activity, and the owner gives its type and times; **Keep as activity** stops the suggestion. A move never carries anyone else's
comments or files out of the Unit Instance they were added in, including from an activity in no unit, as an edit that
shares it would not (ADR-0008). The move is
`POST /api/records/activities/:id/move` with `to: 'duties'`, in one transaction with its files, comments, lineage and
audit, and Undo puts the activity back exactly as it was (`record_lineage`, `LINEAGE_TABLES`).

### 7. Import and export (ADR-0019)

A Duty sheet or CSV imports as duty. The duty type is matched by code or name among the importer's Unit Instance's
types; one it does not find is a problem to correct on the review, never a guess. A row updating one's own duty finds
its type in the instance of the unit the row moves it to, when that is a unit its owner serves in; a unit they do not
serve in is never searched, so the row is refused for its unit and says nothing of another instance's types. Its conditions are compared as claims, so a sheet listing them
in another order, or without the weekend and overnight its times give, changes nothing. Review status, reviewer, approved and
calculated points, scoring version and length are never read from a file: they are worked out again or start as
submitted. Duplicates are found on duty type, start day and start time. A duty always comes in shared with a unit, the
row's own or the person's home unit, and the review says when that is not the unit the row named. Exports carry the
worked-out columns (Duty Hours, Duty Days, Review Status, Calculated Points, Scoring Version, Recorded On) for reading.

### 8. Where duty shows

- **Records → Duty** (`/record/duty`): the person's duty with its hours, points and status; Record duty; Import and
  Export; the suggestions; a detail with its scoring basis, files, lineage and comments. A leader also sees the duty they
  recorded for others, and what their units hold.
- **A Marine's page**: a Duty tab, and Record duty for a leader who counsels them.
- **Timeline**: a duty source. **Personnel record**: duty counts duty records.
- **Duty report** (ADR-0020): about oneself, a Marine or a unit, for a period, the duty stood with hours, calculated
  points, version and status, by Marine where the reader may see figures by Marine, beside the types and scoring. About
  oneself or a Marine it lists what each version scores, as the form does; why a version changed, who published it and
  the versions withdrawn before they took effect are on the unit's report only, read with its shared records. A report
  about oneself that holds duty stood in more than one Unit Instance names each duty's instance and gives the types and
  versions of each instance the reader serves in now, named in each table's title as well, since a version number means
  nothing outside its instance. Duty stood in an instance they have left keeps its type and the version it was scored
  under, but that instance's configuration is its members'; someone who serves in no instance is shown none.
- **Retention**: the clock starts at its end day; anonymizing clears title, location, notes and review reason, and keeps
  its type, times, length and score. Nothing names a person beside an anonymized duty again (`isAnonymizedDuty`): not a
  list, a Marine's page, an export or the unit's Duty report, whose totals count it and whose by-Marine tally leaves it
  out. **Privacy inventory**: every column declared.

## Decided, and defaults John can change

- Duty is always shared with a unit; it has no private form.
- The end must be today or earlier, and one duty is at most 30 days.
- Times are required: a duty without them cannot be scored per hour or by length.
- Weekend is any part on a Saturday or Sunday; holidays are claimed, since Vantage keeps no holiday calendar.
- Points are scored under the version of the duty's first day, not split across versions.

## Alternatives considered

- **Score on read.** Rejected: a score would change if a version were ever removed by hand, and the specification says
  never silently recalculate. Stored with its basis, a score is explained by itself.
- **Let the client send hours and points.** Rejected: points must be the server's.
- **Move duty-like activities on upgrade.** Rejected by John's Task 9 decision.
- **A private duty.** Rejected: duty is stood for a unit and reviewed there.

## Not done here

- Approve, return, reject, approved points, overrides, self-approval authority and duty-specific permissions (Task 18).
- Duty swaps and availability, which ADR-0012 listed for Task 17 but the specification's Task 17 does not include.
- A duty dataset in the Custom report; demo duty.

## Consequences

- Every duty carries the version and points it was scored under, and why.
- Task 18 adds decisions to rows that already hold their review columns, guarded so a decision stands.
- Migration 031 adds one empty table and rebuilds `record_lineage` with its rows; nothing already written is reshaped.
