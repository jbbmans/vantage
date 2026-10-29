# ADR-0021 · Financial error reports: each filed as it stood, compared report to report

**Status:** accepted · **Date:** 2026-10-29 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0012](0012-unit-manager-console.md), [ADR-0013](0013-security-audit-least-privilege.md),
[ADR-0014](0014-mcen-operations.md), [ADR-0015](0015-core-record-architecture.md),
[ADR-0019](0019-import-export-restore.md), [ADR-0020](0020-reports-printable-output.md)

## Context

Task 15 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P1) is "Financial Error Report Upload & KPI
Comparison": configurable operational reports (ULO, OCMT, UMT, IOH, Sync Errors and future categories), uploaded as
CSV or XLSX; snapshots stored and compared (New, Still Open, Resolved, Reopened, Amount Changed, Owner Changed, Status
Changed); metrics (total count, dollar value, by type, by unit, by Marine, average age, oldest, resolution rate,
recurrence, persistent errors, value resolved, resolution velocity); and every KPI drilling to its source records.
Section 18 adds that an error snapshot never silently overwrites history.

What main held before this Task (at `7fa756d`):

- **Spreadsheet intake** (`server/services/intake.ts`): upload (size, quota, magic bytes, malware scan, withheld per
  Unit Instance by ADR-0014), inspect, header row and key columns (damaged identifiers and duplicates refused), map,
  preview, and import into the unit's work queue. A re-import updates the case its key matches. The queue holds each
  case as it stands now; nothing kept what a report said on a given day.
- **Reports** (ADR-0020): Financial KPI and Error report read the unit's cases.
- **Record kinds** (ADR-0015): the Financial Error Snapshot was listed as planned for Task 15, written by an uploaded
  report and corrected by nobody: a later upload is a new snapshot.

## Decision

### 1. Each Unit Instance keeps its kinds of error report

`error_report_types` (code, name, description, active; a code once per Unit Instance) sits beside duty types in the
Unit Manager console (Error reports), with the same rules: `org.config` writes, every change is audited in the
unit-configuration family, a type is retired and restored, never deleted, and the active ones travel in the
configuration file. The **standard five** are ULO (unliquidated obligations), OCMT (open commitments), UMT (unmatched
transactions), IOH (invoices on hold) and SYNC (sync errors). An instance with none is given them the first time anyone
opens its error reports or its configuration; the audit entry names no one. Unit Managers add their own kinds for future
categories.

### 2. A report is filed from an upload, as it stood on its day

The file goes through the intake's own upload (`/api/work/sources`), scan, reader and identifier rules, so every limit
and refusal there applies. It is shared with the unit when the filer belongs to it. A leader filing for a unit beneath
theirs uploads it as their own, since the intake shares a file only with a unit its uploader belongs to. The report
keeps every row either way. The uploader chooses:

| Choice | Notes |
| --- | --- |
| Unit, report type, the day it stands on | A day that has not come yet, or a retired type, is refused |
| Sheet and heading row | As for an import: the heading row is one of the first 20 rows, the ones the upload's inspection shows |
| One or two identifying columns | Taken exactly as written. A row without one, or repeating one, is refused and listed |
| A role for each other column | Reference, description, error type, amount, owner, status, unit or office, opened date, age in days, kept, or left out |
| Statuses that mean closed | The first report of a series starts with the usual words ticked; later ones start from the last report's choice |

An amount, opened date or age Vantage cannot read is noted, and the row is filed without it. An **owner** counts toward
a Marine only when it names exactly one Marine of the unit or the units beneath it, by username, email, DoD ID or a
form of their name. A name two Marines share names neither. Every column kept is filed with the row as the file had
it. The next report of a series starts with the last one's layout.

The **preview** writes nothing. It shows the rows, open count and value, refusals and notes, the statuses found, owners
named and matched, and what changed against the report before. Filing is refused for the same file twice in a series
(by SHA-256) and for a second report on one day while the first stands.

### 3. Kept as filed: never changed, never deleted, withdrawn with a reason

`error_snapshots` holds the report: its file's name and hash, its layout, its counts and its refusals. `error_snapshot_rows`
holds one row per identifier: the fields given roles, every column kept (`data`), and the Marine an owner names.
Database triggers refuse any change to a filed report or its rows and any deletion (outside the demo database).

A report filed in error (the wrong file, day or unit) is **withdrawn**, with a reason of at least five characters. It
is kept with its rows, listed as withdrawn with who, when and why, and left out of every comparison. A withdrawal is
final; a trigger and a CHECK hold it. Its file may then be filed again, for the right day. The unique indexes count only
reports that stand. A series whose every report is withdrawn still opens, as its history: every report listed, with
why, and nothing compared.

### 4. Two reports of a series compare

A series is a unit and a type. By default the latest report is compared with the one before it; any earlier one may be
chosen. For each identifier:

| Standing | Meaning |
| --- | --- |
| New | Open now, and on no earlier report of the series |
| Still open | Open on both |
| Reopened | Open now, not open on the earlier report, but on some report before it (open or closed) |
| Resolved | Open on the earlier report; gone, or closed, now |

Flags on an identifier on both reports: **amount changed**, **owner changed** (compared without case, spacing or
punctuation) and **status changed**. A row closed on both has no standing, but its flags still count.

The figures (`summarize` in `shared/errorReports.ts`):

- Open count and value, and open on the earlier report.
- Each standing and flag. Resolved is valued as the earlier report had it; amount changed is the net change.
- **Resolution rate:** resolved, of those open on the earlier report.
- **Value resolved.**
- **Resolved a week:** the resolved count over the days between the two reports.
- **Days to resolve:** the average, for those resolved, from when each was opened.
- **Average age and oldest.** An age runs from the opened date, else the stated age, else the first report the error
  was open on.
- **Recurring:** open now, after being gone or closed on a report since it was first open.
- **Persistent:** open on each of the last three live reports, the latest among them. It is not known until a series
  has three.

Figures are grouped by error type, by the unit or office the report names, and by Marine. The page also shows a trend
of the last 26 reports.

### 5. Every figure opens exactly the rows it counts

The figure and its rows come from the same compared rows. `inDrill` decides membership for both, and the tests hold
each count to its drill's row count and value. A line of a group opens its own rows. Each row shows:

- the file and day it came from, and its row number;
- every column it carried;
- its standing and flags, and its amount then and now;
- its age and how the age was found;
- the case in the unit's queue with the same identifier, when the unit imported it there from the same report. Two
  reports can key their rows by the same document number. A case whose columns are another report's is not offered,
  by the import's own test (`sameReport`).

A resolved row is shown as the earlier report had it.

### 6. Where it lives

- **Work → Error reports** (`/work/error-reports`): the unit's series, filing, the comparison, its rows, withdrawing.
  It is shown to whoever may read the unit's shared records.
- **Report library → Error report comparison** (Financial work): the same comparison as one `vantage-report/1` document
  (ADR-0020). It has the series in brief, what changed, the groups, the oldest, the trend and every report filed, and it
  prints and leaves as PDF, CSV, XLSX or JSON under Task 14's rules.
- **Unit Manager console → Error reports:** the kinds of report.

### 7. Authorization, decided on the server before anything is read

| To | Needs, in the unit |
| --- | --- |
| Read its error reports | `VIEW_RECORDS`, as the Financial KPI report |
| See figures and rows by Marine | `VIEW_MEMBER_DETAIL` as well; without it, rows show the owner as written but name no Marine |
| File or withdraw | `CREATE_SHARED_WORK` as well, as importing into its queue; refused where intake is withheld (ADR-0014) |
| Take the comparison as a file | `EXPORT_DATA`, as every unit report |
| Keep the kinds of report | `org.config` in the Unit Instance (Unit Managers) |

A unit reads the series filed for it and for each unit beneath whose shared records the reader may view, never those
above. A role with no authority (position 0) reaches no lower than its own unit, so neither does the overview. Which
Marine an owner names travels only to a reader with `VIEW_MEMBER_DETAIL`: the figures carry no rows, and the preview's
sample names no Marine otherwise. A report, its type and its file are
one Unit Instance's. The service checks it, and migration 029's boundary triggers refuse it in the database. Another
instance's type, report or upload answers 404 or 403 without saying whether it exists.

### 8. Audited

`error_snapshot_filed`, `error_snapshot_withdrawn` (with the reason), `view_error_report` for every overview, comparison
and drill read (what was read, and the rows counted), `error_report_type_created`, `error_report_type_updated`,
`error_report_type_retired`, `error_report_type_restored` and `error_report_types_standard_added`. The report
library's choices (names and days, no figures) are not audited; its runs and files are, as `view_report`,
`print_report` and `export_report`.

### 9. Carried everywhere else a record is

The tables are in the instance archive, the privacy inventory (every column classified) and `RECORD_KINDS`. The
Financial Error Snapshot is no longer "planned". The error report type is a configuration kind written by Unit
Managers.

### 10. What filing does not do

It never creates or changes a case. The queue is still filled by Import (ADR-0019 and before), and a row links to its
case. A queue that kept only the latest state could not say what a report said last month. Error reports keep exactly
that, and the queue keeps the work.

## Defaults John can change

- Reading follows the Financial KPI report (`VIEW_RECORDS`), not queue membership.
- Filing follows importing into the queue (`CREATE_SHARED_WORK`).
- A row missing from the later report is resolved. A report that lists closed rows says so through its status.
- Persistent means three live reports in a row.
- The owner as the report wrote it is the report's, shown to every reader. Only the match to a Marine needs
  `VIEW_MEMBER_DETAIL`.

## Alternatives considered

- **Update the queue's cases from each report.** Rejected: it overwrites what the case said, and §18 forbids losing
  history silently. The queue keeps its import.
- **Store only the differences between reports.** Rejected: a comparison against any earlier report, and rows shown
  with every column, need each report whole. Rows are capped by the intake's limits.
- **Match identifiers loosely** (case, spacing, leading zeros). Rejected: two documents that differ only in case are
  two documents to an accounting system. Identifiers are taken as written, and damaged ones are refused, as for import.
- **Decide closed statuses without asking.** Rejected: the words differ between reports. The usual ones are ticked
  and shown, and the uploader decides.

## Consequences

- A unit has a history of each report, report by report, that no later upload can change.
- Comparisons are computed on request from the stored rows, and nothing derived from them is stored. A withdrawal
  changes every comparison at once, and no figure can drift from the rows behind it.
- A wrong filing is corrected by withdrawing it and filing again. Both stay visible.
- Migration 029 reads, moves and reshapes nothing already written.
