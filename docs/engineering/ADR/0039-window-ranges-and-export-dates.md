# ADR-0039 · Custom dates on the window selectors, and dates on the exports

**Status:** accepted · **Date:** 2026-11-22 · **Builds on:** [ADR-0038](0038-custom-date-ranges.md) (the range rule and
the picker), [ADR-0018](0018-record-timeframes.md) (an entry counts in every period it touches),
[ADR-0028](0028-unified-analytics.md) (the Unit dashboard's window and Print or file),
[ADR-0015](0015-core-record-architecture.md) (Timeline)

## Context

Round 2, item 12, part 2. ADR-0038 put one range rule on the server and Custom dates on the five Period pages. The
pages that choose a window of days, the Timeline, Report Studio and the unit export were left as they were:

- The Unit dashboard kept `?days=` (30, 90, 180, 365 as "Last year", default 90) and read it twice, once for the page
  and once for Print or file. "Export unit data" sent no dates and held every shared record, yet named the file after
  the window's last day.
- Workload kept 30 or 90 days in component state, not in the address, and the control sat inside the loaded branch, so
  it unmounted while a new window loaded. Print or file from Workload carried no window.
- Your record kept `?window=` (30, 90, 365 as "12 months", default 90) in a tablist. An unknown value reached the
  server as `NaN-NaN-NaN` and showed a failure. The figure tiles to Contributions dropped the window.
- The Timeline had two raw From and To fields written to the address on every keystroke, with a typing guard of its
  own and no presets.
- Report Studio's New report dialog offered seven presets in its own words. The server checked real days and order
  with no cap, and named no field for order. A revision could name a period, checked for order only.
- The Command brief took the dashboard's window, but the AI payload checked only the shape of a day.

## Decision

1. **One window shape in the address.** A window page keeps its preset under its own key: `days` on the Unit
   dashboard, `window` on Your record and Workload, the default left out. Custom dates are always
   `period=custom&from&to` with the preset key removed, as on a Period page, so a link built for one reads on the
   other. Two days in a link with no preset key are custom dates. Days that break the rule are not used: the page shows
   its preset and says why (`ignored`). A preset the page does not offer is its default, never a failure.
2. **Pure helpers, one hook, one picker.** `readWindow`, `writeWindow`, `windowDays`, `windowLink` and `lastDays` are in
   `src/lib/periodParams.ts`, which the server tests load; `useWindowParam` is beside `usePeriodParam`; the three
   windows are constants in `src/lib/windows.ts`. `DateRangePicker` takes optional `presets`, `label` and `seed`, and
   without them behaves as ADR-0038 describes. Each window keeps its own choices and words ("Last year", "12 months",
   "30 days"), because a window's "30 days" is 30 days ending today on the reader's calendar, not the period preset's
   31 through tomorrow.
3. **"Last year" and `?window=365` keep their meaning:** 365 days ending today, never the last 12 months period. The
   links people already have open on the same days.
4. **Unit dashboard.** The Window choice gains Custom dates; its name stays "Window". Print or file sends
   `period=custom&from&to` for custom dates, so the Report library runs and saves them as dates, and bare `from` and
   `to` for a preset, as before (ADR-0028). "Export unit data" is a menu, "These dates" (the window on screen) and
   "Every date" (what it always held); on Personnel, where no window shows, it stays one button for every date. The file
   is named for what it holds. The Command brief applies the range rule to its window and names the field.
5. **Workload.** The window is in the address (`?window=`, default 30) with Custom dates; the control stays on screen
   while another window loads or fails. Print or file from Workload carries its window.
6. **Your record.** The reporting window is the picker: 30 days, 90 days, 12 months, Custom dates. The figure tiles to
   Contributions keep the window, and the default leaves the address bare. The "Your timeline" link opens the Timeline
   on the window's days as custom dates, whichever window is shown, because the Timeline offers periods, not windows.
7. **Timeline.** The two fields become the standard Period choice (All time by default, the presets, Custom dates)
   through `usePeriodParam('all')` and `periodDays`, as Duty has it. Old `?from&to` links open as custom dates. Show
   everything clears the kind and the period in one change.
8. **Report Studio.** The New report dialog's Period gains Custom dates, its seven presets and words kept. It is handed
   every edit, so Start creates the range shown and no other, and Start waits while the range is wrong. The server
   applies the rule to `period_start` and `period_end` on create (`checkNamedRange`), and on a revision only when the
   revision names a period, so a package stored before the rule still opens and saves. The 400 names `period_start` or
   `period_end`, and the dialog shows it at the day it is about.
9. **Unit export.** `checkRange(req.query)`, with no default. With two days it holds only the shared records in them,
   each by the days it covers (`periodClause`), a task by its due day; an undated record is in no range. With neither
   day it holds every shared record, as before. The file says its range (`range`, or null), and the audit entry names
   it (`2024-06-01..2024-06-30` or "every date"). `recordPeriodClause` in `server/services/timeframes.ts` is the one
   branch the export, `listRecords` and the report center's custom rows use. The roster is the unit today either way.
10. **Report center export.** No server change: ADR-0038 finished it. Tests show a file holds only the records in its
    range, and that the Report library's Download carries the days.
11. **Unit Instance export.** It is a structure snapshot and holds no records by design (`docs/security.md`), so it
    stays as it is; its dates live on the Unit Instance audit export, which already takes them.

## Consequences

- Every window page keeps its range in the address and sends it with each request; a reload, a bookmark or a shared
  link opens on the same days (`tests/browser/58-date-ranges.spec.ts`).
- 732 days are refused at the field on every surface, in the server's words, and by the unit export, the Command brief
  and Report Studio with the field named (`tests/server/dateRanges.test.ts`, `tests/server/reportStudio.test.ts`).
- A unit export for chosen days holds no record outside them; the audit trail says which days were taken.
- A call to the unit export or the Command brief with no days behaves as it did, so the isolation and readiness tests
  that call them that way are unchanged.
- No migration.

## Not done

- The personal export and the service archive stay whole: a ranged archive would not restore.
- AI workflows other than the Command brief keep their own date handling (the award citation sends `to` alone by
  design).
- Report Studio does not re-check a cited record later moved outside its package's period.
- `/api/platform/usage` is unchanged, as ADR-0038 notes.
