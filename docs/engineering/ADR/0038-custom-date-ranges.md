# ADR-0038 · Custom date ranges: one range rule on the server, one picker on the page

**Status:** accepted · **Date:** 2026-11-20 · **Builds on:** [ADR-0015](0015-core-record-architecture.md) (Timeline),
[ADR-0018](0018-record-timeframes.md) (an entry counts in every period it touches), [ADR-0020](0020-reports-printable-output.md)
(the report center), [ADR-0033](0033-counseling-worksheet-form-and-edipi.md) (the latest interim edit)

## Context

Round 2, item 12: a custom date-to-date choice on everything with a records time selector. This is part 1; part 2
covers the window selectors (Unit dashboard `?days=`, Workload, Your record
`?window=`, Timeline's own window, Report Studio) and from/to on the unit, instance and report-center exports.

Before this change, each endpoint that reads records by days had its own check, or none:

- The `/api/reports` family read `from` and `to` as bare text. `abc` gave a 500, `2026-02-30` rolled into March in
  the casework window, a single day was dropped without a word, `/reports/delta` ignored the days altogether and
  `/reports/csv` ignored them when the period was All time.
- `/api/metrics` checked real days and order but had no cap and no `period`, so All time was sent as 1970 to today.
- Record summary, contributions and workload took any `YYYY-MM-DD` and filled a missing side. Timeline left a side
  open. The duty list did not refuse a backwards range. Records lists had no check. The report center ignored a single
  day and took `to=9999-12-31`. The audit trails had no order check and no cap. The unit dashboard and its analytics
  had two checks of their own, with a 731-day cap on analytics only.
- On the page, `PeriodSelect` offered presets only. Records showed a badge for dates that came in a link; Analysis
  never sent dates; Duty and Today worked days out on the browser's clock; and two `useParam` setters in a row kept
  only the last change, so a page could not write a period and its days together.

## Decision

1. **One rule, in one place.** `shared/dateRange.ts` holds it: a range is two real calendar days from 1940 to 2100
   (the bounds `isoDate` already used), both or neither, the first not after the last, at most 731 days with both ends
   counted (`MAX_RANGE_DAYS`, which replaces `ANALYTICS_MAX_DAYS`). `rangeProblems(from, to)` returns field errors and
   one summary sentence (`RANGE_TEXT`), so the server's 400 and the picker's message use the same words. `isoDate` is
   built on the same day check.
2. **The server applies it on every records endpoint** through `server/lib/dateRange.ts`. `checkRange` throws a
   `validation` 400 that names `fieldErrors.from` or `fieldErrors.to`. The fields stay plain text in each schema, so a
   bad day reaches `checkRange` rather than failing in Zod with a different message. It runs on the `/reports` family
   (report, analysis and its PDF, delta, report PDF, CSV), `/metrics` and its contributors, record summary,
   contributions, workload, timeline, the duty list, records lists, the report center (run, export, saved
   definitions), the platform and Unit Instance audit trails and their exports, and the unit dashboard, overview,
   analytics and drill.
3. **`custom` is a period value, not a preset.** `period=custom` needs both days. `PERIOD_OPTIONS` does not gain it,
   so the instance default, saved preferences and rolling saved reports never hold it. Two days given with a preset
   still win, as links have always sent them. A preset is never capped, so All time keeps answering; a request names a
   preset with `period`, and `/api/metrics` gained `period` for that.
4. **The family reads the range it is given.** `/reports/delta` compares the days given with the span before them.
   `/reports/csv` with All time and two days exports those days; All time with none still exports every entry.
5. **Clocks.** Each endpoint keeps the clock it used for presets (the user's zone or the instance's). Custom days are
   exact days, so no clock applies to them. All time on `/api/metrics`, which pages used to send as 1970 to the
   browser's today, runs through tomorrow on the reader's zone, as the rolling periods do, so work a reader east of the
   instance dates today is in All time as it is in the last 30 days.
6. **The picker.** `DateRangePicker` is the Period select with Custom dates after the presets. Choosing it opens From
   and To (native date fields), filled with the days the period before covered (or the default period's days, when
   that was All time). The range is handed on only once both days pass the rule; until then the page keeps the last
   good range, and the field shows the rule's message once the person leaves it. A date field reports each part of a
   day as it is typed (a year passes through 0002 and 0020), so a message at every keystroke would announce errors
   nobody made. A form that runs on demand (the Report library) is handed every
   edit (`everyEdit`) and will not run or save while the range is wrong.
7. **The address.** `usePeriodParam` reads and writes `period`, `from` and `to` in one URL change, through pure
   functions in `src/lib/periodParams.ts` that the server tests load. Two days in a link with no period are custom
   dates. Days that break the rule are not used: the page shows its usual period and says why (`ignored`), linked from
   the select by `aria-describedby`. Today keeps its preset in preferences (`presetsInUrl: false`) and custom dates in
   the address only.
8. **The five pages.** Records, Analysis, the Report library, Duty and Today's outcomes use the picker. Custom dates
   reach Records' CSV, both Analysis PDFs, its CSV and Print or file, the Report library's run, print, files and
   saved reports, Duty's list and Today's metrics. A preset still saves as the preference where it did; a custom range
   never does. The Report library saves custom dates as dates only when Custom dates was chosen; days that came in a
   link still become the rolling period they match, or block saving, as before.
9. **Callers the rule would break, fixed here.** Timeline and the audit trails ask for a window only when both days
   are set, and name the missing or wrong day at its field. Getting started no longer asks for a 26-year summary; the
   default summary carries `personal.any_activity`.

## Consequences

- Every records endpoint answers a bad day, a backwards range, a single day and 732 days with the same 400 and the
  field named, and answers 731 days (`tests/server/dateRanges.test.ts`, every endpoint in one table).
- `2026-02-30` is refused everywhere instead of rolling into March, and nothing in the family returns a 500 for a
  word in place of a day.
- A request from a browser still holding the build before this change sends All time to `/api/metrics` as 1970 to
  today, which is now refused; the page reads again once it is reloaded.
- With one day set, the Timeline shows what is missing in place of the list, and an audit filter is not applied, until
  the other day is set.
- The rule's words are in one table, so the picker, the forms and the server cannot drift apart.

## Not done

- The window selectors and the export dates, which are part 2, as above.
- Presets on different endpoints still use different clocks (the user's zone on some, the instance's on others).
- `/api/platform/usage` returns a 500 for a `to` that is not a day; it reads usage, not records, and is left as it was.
- Date ranges inside AI assist request bodies and Report Studio's `period_start` and `period_end` are not checked by
  this rule.
