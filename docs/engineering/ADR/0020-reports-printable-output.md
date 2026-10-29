# ADR-0020 · Reports and printable output: one document, drawn for the screen, the page and every file

**Status:** accepted · **Date:** 2026-10-29 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0012](0012-unit-manager-console.md), [ADR-0013](0013-security-audit-least-privilege.md),
[ADR-0016](0016-information-architecture.md), [ADR-0017](0017-personnel-records.md),
[ADR-0018](0018-record-timeframes.md), [ADR-0019](0019-import-export-restore.md)

## Context

Task 14 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P0) is "Rebuild reports": Individual Performance,
Unit Performance, Personnel, Duty, Training, Financial KPI, Error Report, Workload, Activity, Leadership and Custom,
with filters, and PDF, Print, CSV, XLSX and JSON where useful. "Use real printable layouts. Do not print the normal
browser UI. Reuse PDFKit infrastructure." Section 17's definition of done for reports adds a title, the unit, the date
or reporting period, the generated date and the active filters on every report; deliberate page breaks; table headers
repeated on each page; nothing clipped; clear charts; screen-only controls hidden; and a PDF that is never a screenshot.

What main held before this Task (at `8ae2e1a`):

- **Packages** (`/reports`): JEPES and FITREP drafts with cited, versioned sources (ADR-0015).
- **Analysis** (`/reports/analysis`): one Marine's record, period against period, with a PDF of the evaluation input
  (`server/services/pdf.ts`), an analysis PDF (`server/services/analyticsPdf.ts`) and an activities CSV.
- **The unit dashboard, workload and roster**: screens only. Nothing printed or filed them.
- **Financial cases** (`work_items`, ADR-0011) with procedure, stage, amount and holder: no report.
- **Training requirements, duty types and duty scoring versions** (ADR-0012): configuration nothing read.
- **`@media print`** hid `.no-print` and flattened cards, so printing a page printed the app around it.

## Decision

### 1. One catalog and one document

`shared/reportCatalog.ts` lists the eleven reports: the question each answers, whom it may be about (yourself, a
Marine you lead, a unit and the units beneath it), its filters, the period it starts on, and who may run it, in words
the library shows. It also defines the query (`reportQuerySchema`) and **one document**, `vantage-report/1`:

| Part | Holds |
| --- | --- |
| `title`, `about`, `unit` | What the report is and whom it is about ("G-8 Comptroller and 1 unit beneath it") |
| `period` | Its label and days, or none for a report that stands on one day |
| `generated` | When and by whom |
| `filters` | Every filter in force, the period first |
| `marking` | The handling line (§6) |
| `summary`, `sections` | Figures; sections of figures, bar charts and tables with typed columns |
| `notes` | What the figures rest on and what they leave out |
| `primary` | The table a CSV holds |

The screen, the print page, the PDF, the CSV, the workbook and the JSON are all drawn from that one document, so they
never say different things.

### 2. Each report is built from the code that already computes it

`server/services/reportCenter.ts`:

| Report | Drawn from | About |
| --- | --- | --- |
| Individual performance | `buildAnalysisReport` (the Analysis page) | yourself, a Marine |
| Activity | the activity ledger, by `periodClause` (ADR-0018) | yourself, a Marine, a unit |
| Training | courses, and **standing against the unit's training requirements** (new) | yourself, a Marine, a unit |
| Unit performance, Leadership | `unitDashboard` | a unit |
| Personnel | `personnelRoster` (ADR-0017), with its own read rule | a unit |
| Workload | `teamWorkload` | a unit |
| Duty | duty types and the scoring version in force (`policyOn`) | a unit |
| Financial KPI, Error report | the unit's shared cases | a unit |
| Custom | a dataset, its columns, grouping and order | yourself, a Marine, a unit |

- **Training against requirements.** A requirement is met by a completed course whose title is the requirement's, or
  holds its course code. A recurring one falls due its interval after the last completion: past due before the day the
  report stands on, due soon within 60 days of it, met otherwise. No completed course is "No record", since only what a
  Marine shared is read for anyone but themselves. A requirement for a unit applies to that unit and the units beneath
  it. The Unit Manager console's training requirements now say the report checks them.
- **Financial cases.** A case is in a period when it was open on any day of it. Open now, the amount open, overdue,
  unassigned and age are as of today; opened, resolved, the resolution rate and days to resolve are for the period.
  The error report lists each case by its error type (its procedure), reference, stage, amount, holder, due date and
  age, open by default, with state, procedure and overdue filters. Amounts are added as each case records them; a
  case does not say what kind of amount it holds, and the report says so.
- **Duty** shows the duty types and how duty is scored on a given day, every version with its status. Duty records
  begin with Task 17, and the report says so rather than showing zeros.
- **Custom** reads activities, training, awards, counselings, goals, tasks, or (for a unit) its financial cases, with
  the columns, grouping (by a column or by month, with totals of its measures) and order chosen. A counseling is listed
  by its date, type, counselor and follow-up, **never its words**.

### 3. Who may see what (server side, every format)

`resolveTarget` decides before anything is read:

- **Yourself:** always, private records included, every format.
- **A Marine:** where the reader may open that Marine's records (`detailUnitsFor`: `VIEW_MEMBER_DETAIL` and a higher
  position, as the Analysis page). The report holds only what the Marine shared with that unit. Named in a unit the
  reader cannot open them in, it falls back to one they can **in the same Unit Instance**; named in another Unit
  Instance it is refused (`cross_instance`). A PDF and the print page are allowed; a CSV, workbook or JSON needs
  `EXPORT_DATA` in that unit, as the activities CSV does.
- **A unit:** `VIEW_RECORDS` there (Personnel also takes `MANAGE_MEMBERS`, as the roster does). It reads the unit and
  the units beneath it, only what is shared with them. **Figures by Marine** (the member tables of Unit performance,
  Workload and Training, the counseling and readiness lists of Leadership) need `VIEW_MEMBER_DETAIL`; without it they
  are left out and the report says so. A custom report of a unit's counselings needs it outright. **Any file** of a
  unit's report needs `EXPORT_DATA` there; viewing and printing do not.
- A unit that does not exist is 404 and one the reader may not read is 403, as the unit dashboard answers.
- Each response says which files the reader may take (`files`), and the library offers only those.

### 4. Audit

| Action | When |
| --- | --- |
| `view_report` | A report about anyone but the reader, on screen |
| `print_report` | Every print page, about anyone |
| `export_report` | Every file, about anyone |
| `report_definition_saved`, `report_definition_deleted` | A saved report changes |

Each names the report, the format, the period and the row count, with the Marine as subject for a member report and
the unit for a unit's. A refusal writes only the usual `access_denied`. A unit report's workload part also writes
`view_team_workload`, as the page does. `GET /api/report-center/export` is listed as a bulk route in
`server/authz/privilegedRoutes.ts`, so the sweep proves an ordinary member and a Unit Auditor are refused.

### 5. Formats

`GET /api/report-center/run` answers the document (`purpose=print` for the print page); `GET /api/report-center/export`
draws a file:

- **PDF**, by PDFKit (`server/lib/pdfReport.ts`): a cover block with the title, whom it is about, unit, period and
  generated line; a filters box; the summary grid; bars with their labels and figures; tables whose cells wrap, never
  cut, with the header again after each page break and "(continued)"; the handling line at the top and foot of every
  page; "Page n of m". Landscape when a table is wider than eight columns (`LANDSCAPE_COLUMNS`). A cell over 600
  characters is shortened in print, and the PDF says so.
- **CSV:** the report's main table, raw values (amounts as numbers, a flag as Yes or No), formula-like cells written as
  text (`shared/csv.ts`), with a byte-order mark for Excel.
- **XLSX:** an About sheet (title, handling line, about, unit, period, generated, filters, summary, notes) and a sheet
  per table, by `writeWorkbook` (ADR-0019), which writes inline strings so nothing runs as a formula.
- **JSON:** the document itself.
- Files are named for what they are, whom they are about and the day: `vantage-error-report-g-8-comptroller-…-2026-10-29.pdf`.

### 6. The handling line

A Vantage Administrator sets one line printed on every report, on screen, at the top and foot of every printed and PDF
page, and in every file (runtime `reportMarking`, Identity panel of the Vantage Administrator console, one line, never
blank). It defaults to "Working paper", what the analysis PDF already said, and the analysis PDF now prints the line
set. The JEPES and FITREP input PDF prints no handling line, as before. **The wording MCEN requires for these reports
(for example a CUI marking) is MCEN's to give;** Vantage only prints what is set.

### 7. Printing

`/reports/print` renders the document **outside the app's frame**: no menu, header, footer or tab bar, and its two
buttons never print. Its stylesheet lays the page out for Letter paper: the handling line and the report's name head
and foot every page (a presentational frame table whose header and footer repeat); each table's header repeats on every
page it reaches; a row never splits between pages; a table's title, header and first row go to the next page together;
figures and charts are kept whole; dates and figures stay on one line, and only a run of text with no space long enough
to push a table off the page may break mid-word. A report with a table wider than eight columns prints landscape, by a
named page, as the PDF does. The library's Print opens it in a new tab and opens the print dialog; opening it is
audited as `print_report`.

### 8. Saved reports (migration 028)

`report_definitions` keeps a report's **choices, never its data**: its type and filters, under a name, private or
shared with one unit. Only the keys a report takes are kept, and they are checked as a run checks them. A report is
shared only with a unit the person belongs to and whose shared records they view, and a shared one **names no Marine**
(its `user_id` is dropped). Whoever opens one runs it with their own authority. Only its owner changes or deletes it.
At most 100 per person. The table is in the infrastructure backup and the privacy inventory; like saved work views it
is not in the personal export. Migration 028 adds nothing to read or reshape; the table comes from the schema, as
027's did.

### 9. The app

Reports & Analytics → **Report library** (`/reports/library`): the eleven reports by group, whom each is about, its
filters, the document as it prints, Print, the files the reader may take, and saved reports. The unit dashboard,
Workload, Roster and Analysis link to their report. Packages and Analysis, and their exports, are unchanged.

## Consequences

- A leader prints or files any report with its title, unit, period, filters, date and handling line, and what goes on
  paper is what was on screen.
- Every report about someone else is in the audit trail when it is read, printed or filed.
- The training requirements the Unit Manager console sets are now read, from shared records only: a Marine who did not
  share a course shows "No record" for it.
- Rolling periods are read through tomorrow (`shared/metrics.ts`) so work dated a day ahead east of the server counts;
  a report shows them ending today.
- Browser printing is tested in Chromium (the browser test prints the page to PDF). Which browsers MCEN fields is not
  recorded here; one that does not repeat a table's header and footer on every printed page loses the running handling
  line after the first page, and the PDF carries it everywhere.
- Left to other Tasks: duty records (17) and their scoring (18) fill the Duty report; financial error snapshots and
  comparison (15); one set of analytics components (21).
