# ADR-0028 · Unified analytics: figures that answer a question, drill into the records they count, and print with their table

**Status:** accepted · **Date:** 2026-11-14 · **Builds on:** [ADR-0013](0013-security-audit-least-privilege.md),
[ADR-0016](0016-information-architecture.md), [ADR-0018](0018-record-timeframes.md),
[ADR-0020](0020-reports-printable-output.md), [ADR-0024](0024-duty-review-permissions-scoring.md)

## Context

Task 21 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P1) is Unified Analytics:

- "Create reusable analytics components. Potential visuals: KPI cards, trends, aging, distributions, completion rates,
  resolution rates, dollar trends, duty workload, training progress, personnel distribution, performance history."
- "Every visualization must answer an operational question. Every value should be traceable to source records. Charts
  need accessible alternatives."
- Definition of done, analytics: "useful graphs exist; graphs drill into source records; accessibility alternatives
  exist". Reporting: "graphs print; render charts clearly; underlying metrics traceable".
- Recharts is named as a dependency to add only if the current chart system is inadequate.

What main held before this Task (at `7f1b203`):

- **Two chart components** in `src/components/charts/index.tsx`: `AreaChart` (an SVG line over months, a hover
  tooltip, one `role="img"` label for the whole chart) and `BarList` (labelled bars). Four pages used them: the Unit
  dashboard (one metric by month, outcomes by category), the personal analysis (entries per month with a dashed money
  line, by area, by category), the error report series (open on each report) and the home dashboard (who holds what).
- **None drilled into records**, except the metric figures (`MetricTotalsGrid`, ADR-0016), which open their
  contributors. No chart had a table alternative; a screen-reader user heard one sentence for the whole trend.
- **Figures that did not trace.** The dashboard's "Where the work landed" added `outcomes` across every metric an
  outcome carried, so an outcome with dollars and hours counted twice. A training contributor linked to the reader's own
  training page whoever's training it was.
- **The Unit dashboard covered output only**: shared outcomes, readiness, members. Casework, duty, training standing and
  the roster had figures in the report center (ADR-0020) and on their own pages, but no analytics.
- **Report charts** (ADR-0020) were horizontal bars only, named the table they came from without saying so on the page,
  and could split across a page in the PDF. Time series (months, weeks, reports) read as bars.

## Decision

### 1. No chart library

The charts the Task needs (bars, stacked bars, columns over time, paired columns, a rate) are drawn in HTML on the
design tokens. That keeps them in both themes and every accent, prints them in colour (`print-color-adjust: exact`),
lets every bar be a real button, and adds no dependency, bundle weight or supply-chain review. Recharts is not added.

### 2. One figure engine, shared

`shared/unitAnalytics.ts` is pure. A section reads its source records once; each record says which bar of which visual
it counts in, under which series, with what value (its *memberships*). `tally` adds memberships into figures; `drillOf`
filters the same memberships to one bar. A figure and its drill are one list, so **a drill lists exactly the records its
figure counts, and their values add up to it**: a record in two series of one bar (a case opened and closed in the same
month) is one record of that bar, and values are added before they are rounded, in the figure and the drill alike. Fixed
bars (age bands, months, statuses) keep their order and zeros; others sort by size.

### 3. Four sections of the Unit dashboard

`GET /api/org/units/:unitId/analytics/:section?from&to` returns a section's visuals;
`GET .../analytics/:section/drill?from&to&visual&key&series` returns the records behind one figure (the first 200, with
the count and total of all). Sections:

| Section | Questions |
|---|---|
| Casework (`work`) | Where does the casework stand? How long have the open cases been open? Are cases closed as fast as they arrive? How much money was resolved each month? Where are the open cases waiting? How many of the window's cases were resolved? |
| Duty | How much duty is being stood, and how much counts yet? Who (or which units) carry the load? What duty is stood? Hours each month? How long has duty waited for review? How much is approved? |
| Training | How much training is done? Are Marines current on required training? Which requirements are falling behind? Hours each month? What kinds? |
| Personnel | Who is on the roster, and where are the gaps? Grades, teams, MOSs. |

- **Read through the report center's own readers** (`casesOf`, `CASE_AGE_BANDS`, `requirementStandings`, the
  personnel roster, `countedPoints`), so a figure here is the figure on the printed report: the casework resolution
  rate is the financial report's, the training standing is the training report's, the roster count is the personnel
  report's (tested).
- **Duty counts as ADR-0024 says**: approved duty, at its approved points. Awaiting review is all pending duty whenever
  stood.
- **The window** is the dashboard's (30 to 365 days; the server refuses more than 731). A day not on the calendar
  (2026-02-30) is refused here, on the dashboard and in the report center, never read as another day or answered with a
  server error. An entry across the window's edge counts in it (ADR-0018), and in a month series in the first month it
  touches. Personnel stands on today.
- The dashboard's section and window are in the address (`?show=work&days=365`), and "Print or file" opens the report
  that section is (financial, duty, training, personnel; Output stays the unit report) for the window on screen, so the
  printed figures are the dashboard's. The report library shows those dates (named as the link's, in the Period
  field's description and placeholder) until a period is chosen. Saving keeps the rolling period that matches (30 days,
  90 days, the last 12 months), never the dates of the day it was saved; the 180-day window matches none, so it is saved
  only once a period is chosen. Personnel stands on today and carries no window.

### 4. Who may read what

- `getUnit` first (404), then `VIEW_RECORDS` in the unit (403). Unit Managers and platform staff hold no such
  permission and are refused; a Vantage access read grant (`VIEW_UNIT | VIEW_RECORDS | VIEW_AUDIT`) sees no figures by
  Marine, and the roster as its Roster page shows it.
- **The units beneath are read only where the reader views their records too**, so a role at position 0 reads its own
  unit. This is stricter than the dashboard's and report center's single check on the root unit; see Not done here.
- Only shared records count (`visibility = 'unit'`), never private ones, drafts or another Unit Instance's.
- **A record names a Marine only where the reader opens member records** (`VIEW_MEMBER_DETAIL`) in its unit. Without
  it, duty load is by unit, and the training standing shows counts with no drill (its records are Marines). A Marine
  not named is listed under a number, never their account id, which the roster would put a name to. A duty a
  retention schedule anonymized names nobody and has no title. The Personnel section is the roster, read with
  `personnelRoster` as the Roster page and the personnel report read it, so it lists Marines as they do and its count is
  theirs (a deactivated account only for whoever manages it).
- **A drill links to a record only where the reader may open it**: a case at `/work/items/:id` to a member of its unit,
  as `readable()` opens a shared case (a leader above it counts it but does not open it); a Marine at `/team/:id` only
  where `detailUnitsFor` says they may, never themselves and never a deactivated account (its page answers 404).
- A Marine who trained is named by the courses the reader may see by name, and only those are added to their line; a
  Marine not named is listed under a number. A grade's bar is the grade alone (E-8 is MSgt and 1stSgt).
- **Audited**: `view_unit_analytics` for every read (section and window), `drill_unit_analytics` for every drill
  (visual, bar, window, records listed). A drill that names Marines' duty, training or training standing also writes
  `list_records` for each Marine (deduplicated within five minutes, as lists are).

### 5. The kit

`src/components/analytics/` draws any visual: `KpiTiles`, `BarChart` (single or stacked), `ColumnChart` (single or
paired, over time), `RateMeter`, in a `FigureFrame` whose heading is the question, with a one-sentence summary, a
Chart/Table switch (`FigureTable`, the accessible alternative, captioned by the question), and a source note.

- **Every counting bar, column, tile and table cell is a button** named with its label, value, any qualifying hint and
  what it opens ("Under 7 days: 3. Show the 3 cases"), reachable by keyboard with a visible focus ring; a figure that
  cannot drill is an image named the same way.
- **The switch is tabs with their panels** (`aria-controls`, `role="tabpanel"`), and every framed visual has its table,
  rates included. A table's first column is named for what a bar is (`axis`: "Open for", "Requirement", "Month"). Paired
  columns (opened and closed) have no "All": added together they count no record.
- **The summary answers the question.** Where the question is about some series (`lead`: past due and no record), it
  names the bar with the most of them; where each bar is a level on its day (`level`: errors open on each report), it
  gives the latest and how it moved, and never adds the levels up.
- **`DrillDialog`** lists the records: title, detail, whom (where named), unit, status, date, value and a link; says
  "first 200 of N" when cut; and checks the sum against the figure, saying so if it does not match. Its read is
  audited, so it is made once while open and not repeated on focus or failure.
- **Printed**, a chart carries its table under it and drops its switch; a frame is not split across pages.
- `clientVisual` builds a visual from figures a page already holds, for the personal analysis, the error report
  series and the home dashboard.

### 6. The existing charts move onto it

- **Unit dashboard, Output**: one metric month by month (choose which) and the same metric by category, each month and
  category opening its outcomes (`ContributorsDialog`, now exported, narrowed to a month's contributors or a category,
  and checked against that figure). The double-counting "outcomes by category" is gone.
- **Personal analysis**: entries or money per month, by area, by category, each bar opening its entries from the
  analysis's own ledger (each ledger row now carries the month it counts in and whether its value adds to the
  headline). Entry titles in the ledger and the largest-entry tables open the entry. Their tables no longer nest a row
  in a row.
- **Error report series**: open on each report as columns with a table. **Home dashboard**: who holds what as bars.
- A training contributor links to one's own training page only when it is one's own.
- `src/components/charts/` is removed.

### 7. Reports print their charts clearly and say where the figures are

- `ReportChart` names its source table **and column** (`column`), and may be `shape: 'columns'` for a figure over time.
  On screen, in print and in the PDF a chart ends "From the table X, column Y." A test checks that every chart's table
  is in its section, the column is in that table, and every bar's figure is in that column.
- Time series draw as columns: the individual report's months, the unit report's weeks, the comparison's reports. The
  unit report's weeks are every week of the period up to this one, a quiet week at zero, so its gaps show; a week not
  yet begun is not a quiet week, and a window longer than ten years lists only its weeks with entries
  (`server/services/dashboard.ts`). The months of "All time" start at the first month with an entry, and a series of
  months keeps its latest 121.
- One rule for what a chart draws, on screen and in the PDF (`chartBars`): the first 30 bars, or the latest 60 columns so
  a long period still ends today, and the source line says how many the table holds when it is cut. Column labels never
  crowd the last one (`labelledColumn`).
- New charts: the financial report's open cases by age; the training report's Marines who met each requirement; the
  duty report's hours by duty type (a new "By duty type" section and table); the personnel report's Marines on each
  unit's roster (a new "Unit by unit" section, when there is more than one unit).
- The PDF keeps a chart on one page where it fits, and a section's heading on the page of its chart (tested).

## Alternatives considered

- **Recharts.** Adequate for drawing, but its SVG charts need a custom accessible table and keyboard drill anyway, do
  not take the theme tokens without wrapping, and print in grey unless forced. It would add a dependency for less.
- **Charts from the report center's documents.** The report document is built for paper: it holds rows, not record
  ids, and would need every report reshaped to drill. The analytics reuse its readers instead, and say the same.
- **Drill by re-querying with filters** (as the metric contributors do). It works where a filter exists, but a bar such
  as "open 31 to 90 days" or "waited 8 to 30 days" would need a filter per bar and could drift from the figure.
  Memberships make the drill and the figure one computation.

## Not done here

- No analytics for awards, counseling or goals: the Output section and the report center cover them.
- The custom report grouped by month still draws bars, newest first, with every month labelled; making it columns would
  need its quiet months filled as the unit report's weeks now are.
- A position-0 role now reads only its own unit's analytics while the dashboard's Output and the report center still
  read the subtree on the root check. Aligning those is a change to ADR-0020's rule and is left for John.
- Performance history across periods (the spec's "performance history") is the individual report and the personal
  analysis, which already compare against the period before; no new trend across years was added.
- HawkScan did not run (no API key).

## Consequences

- One way to draw a figure, one way to open what it counts, and a table for every chart.
- The Unit dashboard grows four sections; each read is an audit row, as the dashboard's always was.
- A new section of analytics is a builder that emits memberships, with no new drawing.
- No migration.
