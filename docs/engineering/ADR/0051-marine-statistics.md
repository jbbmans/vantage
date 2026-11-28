# ADR-0051 · One Statistics tab per Marine

**Status:** accepted · **Date:** 2026-11-27 · **Builds on:** [ADR-0050](0050-reachable-statistics.md) (one subject rule,
one Unit Instance's units at a time), [ADR-0038](0038-custom-date-ranges.md) (the one range rule),
[ADR-0020](0020-reports-printable-output.md) (the Report library's files and checks), [ADR-0040](0040-security-fixes-for-later-features.md)
§10 (last sign-in only to a leader who manages the Marine), [ADR-0010](0010-vantage-administrator-and-unit-manager.md)
(consoles get account activity, not record statistics)

## Context

Read on `d2ef1ba`:

- A Marine's figures were spread over pages that each counted one part: the Analysis (entries, outcomes, areas,
  categories, coverage, months, training, awards, counseling), the Duty report (duty, hours, approved points, awaiting
  review), the member page's grid and its counts. No one view put them side by side over a chosen range, for the Marine
  or for a leader, and no file carried them together.
- `buildAnalysisReport` already reads a Marine's record for a range, about oneself (private entries included) or about
  another Marine through `subjectUnits`. The Duty report counts duty with `periodClause` and approved points as approved
  duty at its approved points (`countedPoints`).
- Nothing in the repository holds a Privacy Act statement. The privacy inventory refers to "the instance Privacy Act
  statement", but no setting, page or file carries one, and the official-status facts it would come with are deferred
  until their wording is approved.

## Decision

### 1. One read

1. `server/services/statistics.ts`. `statisticsTarget` decides whom the read is about before anything is read: oneself
   with no `user_id` (or one's own), every record one keeps; another Marine through `subjectUnits` with the refusal "You
   cannot see that Marine's statistics." (403 `forbidden`), and 403 `cross_instance` for a unit of another Unit
   Instance. A reader outside the Marine's chain, a Unit Instance role and Vantage staff never pass `subjectUnits`
   (ADR-0010).
2. `statisticsProfile` reads, for one range resolved once (ADR-0038):
   - **Entries and outcomes, training and awards, counseling**: `buildAnalysisReport` with the arguments the Analysis
     page sends (the Marine, the unit, the units, the period, the days), so each figure is the Analysis figure. Every
     other read takes the days the Analysis resolved.
   - **Duty**: `subjectWhere` plus `periodClause('duties')`: count, hours, approved points (approved duty at its approved
     points), approved, awaiting review, returned, rejected, by duty type and by month (`anchorDay`), as the Duty report
     counts it.
   - **Activity in Vantage**: counts of what the Marine added, by when each record was added on the instance clock
     (`created_at` within the range's days): entries added, duty they recorded themselves (not duty a leader recorded
     for them), training added, goals they set, and counselings a leader wrote that they acknowledged in the range (by
     `acknowledged_at`). By month, and the last entry added. About another Marine only what they shared with the units
     read. Never a list of records, never a page opened or time spent.
   - **Last sign-in**: only to a reader who manages the Marine (`personnelAccess(...).manageIn`), as the member page
     decides (ADR-0040 §10). Not shown about oneself: one's own sign-ins are in Settings.
3. The answer (`shared/marineStatistics.ts`) is five sections (`entries`, `duty`, `training`, `counseling`,
   `activity`), each a title, a line on what it counts, kit visuals (KPI rows, rates, columns, bars, built with
   `visualOf` from `shared/unitAnalytics.ts`), dated facts and notes; the units read; the range; `privacy_act`; and the
   files the reader may take.
4. **Own history only.** No ranking, no comparison with anyone, no composite score, no projection. About another
   Marine the answer says so in a note.
5. `GET /api/statistics?user_id&unit_id&period&from&to` (`server/routes/misc.ts`). About another Marine it writes
   `view_statistics` (entity `user`, the Marine as subject, `detail` the range's days) once for each unit read, so each
   unit's access log and the Marine's "Who has looked at your record" show it. One's own read writes nothing.

### 2. The export

1. A Report library type `statistics` (Your record; about oneself or a Marine; filter: period; default the last 12
   months), built by `buildStatistics` from the same `statisticsProfile`, so a file says what the tab says.
2. Each section's KPI row becomes figures; each other visual a table (label, value, records), the first month series a
   chart; facts become dated figures. Its primary table is the month by month figures (entries, the headline value,
   duty hours, training hours, records added), which is the CSV.
3. The Report library's checks stand as for every report about a Marine: the PDF to any reader who may open the
   statistics, CSV, XLSX and JSON with `EXPORT_DATA` in every unit read, `view_report`, `print_report` and
   `export_report` in each unit read, and authority read afresh before a file leaves (ADR-0020, ADR-0035).

### 3. The Privacy Act statement

1. `VANTAGE_PRIVACY_ACT_STATEMENT` (`server/config.ts`): the deployment's statement as plain text, at most 4,000
   characters, `\n` for a paragraph break. Markup and control characters refuse the start. Unset or empty, there is
   none.
2. When set, the Statistics tab and the own view show it above the figures, under the heading "Privacy Act statement",
   and the Statistics report carries it: on screen and in print, at the head of the PDF, first on the workbook's About
   sheet, and as `privacy` in the JSON. The CSV is the month table alone.
3. When unset nothing is shown and no wording is supplied: the statement is the command's to give. Changing where the
   text comes from (an instance setting, the official-status facts once approved) changes only `privacyActStatement`
   and its one reader.

### 4. The pages

1. `src/components/MarineStatistics.tsx`: the period picker (in the address, ADR-0038), a Unit Instance choice when the
   reader opens the Marine in more than one, the units read and that the view was logged, the Privacy Act statement,
   the five sections (KPI row first, the other figures two to a row on wide screens, each with its table view), and
   **Export statistics** with the files `files` lists. Read once a minute at most and never again on focus.
2. The member page gains a **Statistics** tab, read only while the tab is open.
3. Reports & Analytics gains **Statistics** (`/reports/statistics`), one's own.

## Consequences

- A leader's look at a Marine's statistics is one more entry in each unit's access log, beside `view_member` and
  `build_report`. Opening the tab again within a minute reads nothing new; changing the range reads again.
- The figures cannot drift from the Analysis or the Duty report: they are those reads. A change to either changes the
  statistics with it.
- The activity counts are by when a record was added, not by its date, so an entry dated last year and added this week
  counts this week. Duty a leader recorded is not counted as the Marine's doing. A goal a leader set for them is not a
  goal they set.
- The tab draws no drill into a bar. The records behind each figure are on the member page's own tabs and the Analysis
  ledger.
- With no statement set there is no Privacy Act note anywhere. MCEN's statement is I-39.

## Tests

`tests/server/marineStatistics.test.ts`: the setting's rules; one's own statistics (private entries, another instance's
records, nothing audited) equal one's Analysis; another Marine's through FISCAL read FISCAL and BUDGET, never MANPOWER
or a private record, equal the Analysis (entries, value, actions counted, areas, months, training hours, counselings) and
the Duty report (duty stood, hours, approved points, awaiting review) for the same range and units, with no ranking or
score among the figures and `view_statistics` once per unit read; a Marine of the unit, a Marine reading their leader,
an id nobody has, a Unit Manager and Vantage staff refused with 403 `forbidden`, another instance's unit with 403
`cross_instance`, nothing logged; last sign-in to the SNCOIC and not to a Fire Team Leader; custom days and the range
rule; the Statistics report's figures and tables equal the tab's, `view_report` and `export_report` per unit, the
statement on the screen, the PDF, the workbook and the JSON, and only the PDF without `EXPORT_DATA` in every unit.
Browser: `66-marine-statistics` (nothing read before the tab opens, the units note, the statement, the export menu and
its request, the period in the address, one's own view with private entries, a refusal, axe).
