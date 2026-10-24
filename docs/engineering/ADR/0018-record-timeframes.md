# ADR-0018 · Record timeframes: a start, an end, optional times and "ongoing", one rule for what falls in a period

**Status:** accepted · **Date:** 2026-10-24 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0013](0013-security-audit-least-privilege.md), [ADR-0015](0015-core-record-architecture.md), [ADR-0017](0017-personnel-records.md)

## Context

Task 12 of the governing specification (VANTAGE_CLAUDE_MASTER.md) is record timeframes: "Add: start date, end date,
optional start/end time, ongoing/present. Apply across appropriate domains. Server must reject end-before-start.
Reports, analytics, imports, exports, filters, and history must understand ranges."

What main held before this Task (at `2e0a548`):

- **Activities and training** had one `date`. A five-day course, a deployment or a month of audit support was one day.
- **Awards** had one `date`, labelled "Period end / award date"; the start of the period it recognizes had no field.
- **Goals** (`period_start`, `period_end`), **projects** (`start_date`, `target_date`), **assignments**
  (`unit_members.assignment_start`, `assignment_end`, ADR-0017) and **functional responsibilities**
  (`personnel_responsibilities.starts_on`, `ends_on`) already had two days. Goals and projects were not checked for
  order at all; assignments and responsibilities were checked by the personnel service only.
- **Every reader picked records by one date**: the record lists' period filter (goals by their end), JEPES and FITREP
  inputs, the analysis page, metrics, the dashboard, the weekly digest, the AI context, the timeline and the CSV export.
  Each wrote its own `date BETWEEN ? AND ?`.
- **Counselings and tasks** happen on a day (a counseling session, a due date) and have no span. A Report Studio
  report's period already refused an end before its start and is not a record.

## Decision

### 1. Which records have a timeframe

One registry, `TIMEFRAMES` in `shared/timeframe.ts`, says for each record type which columns hold its first and last
day, whether it takes times and "ongoing", whether a missing day leaves that side open, and how a period picks it. The
database triggers, the server's checks, the SQL period clause, analysis, imports, exports and the forms all read it.

| Record | First day | Last day | Times | Ongoing | A missing day | In a period when |
| --- | --- | --- | --- | --- | --- | --- |
| Activity | `date` | `end_date` (new) | ✓ (new) | ✓ (new) | no end: one day | any day of it is in the period |
| Training, course, PME, education | `date` | `end_date` (new) | ✓ (new) | ✓ (new) | no end: one day | any day of it is in the period |
| Award | `period_start` (new) | `date` | | | open start | its award date is in the period |
| Goal | `period_start` | `period_end` | | | open | any day of it is in the period |
| Project | `start_date` | `target_date` | | | open | any day of it is in the period |
| Assignment (`unit_members`) | `assignment_start` | `assignment_end` | | | open | any day of it is in the period |
| Responsibility | `starts_on` | `ends_on` | | | open | any day of it is in the period |

Counselings and tasks keep their one date: they happen on a day. Duty records are Task 17's and will take the same
registry.

- **Days** are calendar days (YYYY-MM-DD) and **times** are the wall clock where it happened (HH:MM, 24-hour), as the
  date already was: nothing is converted between time zones. The forms take a time as Marines write it ("0800",
  "08:00", "800") and show it as "0800".
- **Ongoing** is begun and not finished. It has a start and no end date or end time; it counts in every period from
  its start until someone gives it an end. A completed course cannot be ongoing (the server refuses it; a course still
  running is in progress or scheduled).
- **An award** keeps its date as the day it was given, which every reader already used. The new `period_start` is the
  start of the period it recognizes, optional, and never decides which report the award falls in.

### 2. A record never ends before it starts

The rules, in `timeframeProblems`:

- the last day is not before the first;
- an activity or course with an end date has a start date;
- an ongoing record has a start, and no end date or end time;
- a time needs the day it goes with;
- on a single day, the end time is not before the start time (a night shift that runs past midnight ends on the next
  day).

They are enforced three times, in the same words:

1. **The forms** check before anything is sent and mark the field (`timeframeCheck`; `RecordDialog` now takes field
   errors from a check).
2. **The server** refuses the write with 400 and an error per field (`checkTimeframe` in the record service, the move
   service and the activity import; the personnel service for assignments and responsibilities). An edit is judged as
   it would be saved: the stored row with the change laid over it, so moving only the end date before the stored start
   is refused.
3. **The database** refuses any other writer (migration 026): a trigger per table on insert and on any change to its
   timeframe columns, raising `timeframe: …`, which the API answers as 400 `timeframe` rather than a server error. A
   script, the personnel feed, an import or a future route cannot store a record out of order. The training status rule
   is the server's only.

**Rows already out of order are kept.** A goal or project saved before 026 with its end before its start stays as it
was. Migration 026 counts them by type into `meta.timeframe_violations`, and the Vantage Administrator console's
migration status shows the live count. An edit that leaves the dates alone is not checked, so such a row can still be
renamed or completed; whoever next changes its dates is asked to put them in order. Nothing guesses which day was meant.

### 3. One rule for what falls in a period

**A record is in a period when any day of it is**, both ends of the period included and either end left open. An
ongoing record covers every day from its start; an open goal or assignment every day on its open side. An award is in
the period of its award date.

`periodClause` (`server/services/timeframes.ts`) writes that rule in SQL from the registry, and `inPeriod` in
`shared/timeframe.ts` in TypeScript. Every reader that picked records by date now uses one of them: the record lists'
period filter (activities, training, awards, goals, projects) and the Records page's own filter; JEPES and FITREP
inputs; the analysis page and its PDF; metrics and their contributors; the dashboard; the progress delta; the weekly
digest; the AI context; the timeline window; and the CSV export.

**Counted once.** Inside one report, analysis or metric an entry is counted once however many days it covers. A series
puts it in one bucket: its first day, or the window's first day when it began before the window (`anchorDay`). Totals
over a window therefore never double count, and a monthly chart shows a long entry in the month it began, or in the
first month shown.

**Training hours** count in full in every period the course touches. Splitting hours by day would invent a precision
the record does not have.

John decided how an entry crossing period lines counts ("How should an entry spanning two periods count in
reports?", 2026-10-24): every period it touches, the recommended option, over only the period it starts in (as before)
or only the period it ends in. Changing the rule later is one function in each language.

### 4. History, retention, moves, imports, exports

- **History.** A record's version history (ADR-0015) carries the new columns like any other field. The timeline lists an
  entry when any day of it falls in the window asked for, and shows its range.
- **Retention.** A record's retention clock runs from its end: `COALESCE(end_date, date)` for activities and training.
  An ongoing one is never due, since it has not ended.
- **Moves** between activities, training and awards (ADR-0015) carry the range: an activity's start and end become an
  award's period start and award date, and back. An activity still going on becomes a course in progress. The move is
  checked against the target's rules like any other write.
- **CSV import** of activities reads the columns `End Date` (also "Through", "Until"), `Start Time`, `End Time` and
  `Ongoing` (also "Present"), and an end date of "Present", "Ongoing", "Current" or "Now" as ongoing. Times are read
  from "0800", "8:00", "08:00:00" and "8:00 PM". A row out of order is shown in the preview in the same words and
  refused by the server with its row number. A row that updates an entry is judged with the entry's other dates.
- **CSV export** writes the same columns, with "Present" for an ongoing end, so an export imports back as it was.
- **The instance archive** (ADR-0008) carries the new columns. An archive from before 026 loads with each missing column
  at its default, as the migration would have left it. The triggers are lifted while it loads and put back before it
  commits, and the out-of-order rows it brought are counted as the migration counts them, and named on the import's
  audit entry beside any boundary crossings.
- **The AI context** names an activity's end date and whether it is ongoing, so a drafted bullet does not call a running
  effort finished. Bullets and the PDF record print the range.

### 5. Migration 026

- `activities` and `trainings` gain `end_date`, `start_time`, `end_time` (each checked as HH:MM on a 24-hour clock) and
  `ongoing` (0 or 1, default 0). `awards` gains `period_start`. Every existing row keeps its meaning: one day, not
  ongoing, no period start.
- The timeframe triggers are created on all seven tables (`<table>_timeframe_written`, `<table>_timeframe_changed`).
- Rows out of order are counted into `meta.timeframe_violations` and kept.

It removes and reshapes no row and is safe to run twice. Code from before 026 ignores the added columns; the handoff
gives the rollback steps.

### 6. Security and isolation

Nothing here changes who may read or write a record. The new columns are fields of records already scoped by owner,
unit and Unit Instance (ADR-0008, ADR-0015), so every rule that decided who sees a record decides who sees its range.
The period clause only narrows queries that were already scoped, and binds its days as parameters. The privacy
inventory lists the new columns under their records' categories. A refusal by the triggers names the table and nothing
from the row.

## Consequences

- An evaluation input, an analysis or a chart no longer misses work the Marine was doing during the period because it
  began earlier. The range is printed beside each entry, so the overlap is visible.
- Dates out of order cannot be stored by any path from 026 on; the few stored before it are counted, shown, and put in
  order when next edited.
- A goal is now in a period when any day of it is, where the list's filter used to pick it by its end alone.
- Overlap queries test two columns, so the index on `date` serves only the "starts before the period ends" half. An
  index on the last day is left for the performance Task (25), measured against real sizes.
- `activityFingerprint` (first day, title, amount, value) gains the start time when there is one, so a day watch and a
  night watch of one title on one day are two entries; an entry with no time keeps the fingerprint it always had. The
  end date is left out of it: re-importing a file that now has end dates updates the rows that carry their Vantage ID
  and skips the others as duplicates, rather than adding them again.

## Alternatives considered

- **A separate `timeframes` table** joined to each record. Every reader would join it, every write would touch two
  tables, and the archive and moves would carry it separately. Rejected for columns on each record, described by one
  registry.
- **Only the period an entry starts in** (as before). Simple, but an evaluation period would never show a deployment or
  a course that began before it. Offered to John, who chose every period it touches.
- **Splitting an entry's amount or hours across periods by days.** Invents a precision the record does not hold: thirty
  ULOs over three months were not ten a month. Rejected.
- **Timestamps with a time zone.** Marines record when it happened on that day's clock where it happened; the record
  has never been time-zone aware and nothing compares it to the server's clock. Rejected for wall-clock HH:MM.
- **Repairing out-of-order rows in the migration** (swapping the days). Would guess what the person meant and rewrite
  their record without them. Rejected: kept, counted and asked for at the next edit.
