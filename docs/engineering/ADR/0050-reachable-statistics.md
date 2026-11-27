# ADR-0050 · A Marine's Analysis from their page, one's own activity, and one person's trail

**Status:** accepted · **Date:** 2026-11-26 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md) (the Unit
Instance boundary), [ADR-0035](0035-fresh-authority-across-waits.md) (authority read again before a file leaves),
[ADR-0040](0040-security-fixes-for-later-features.md) §11 (what is done to a private entry is filed under no unit),
[ADR-0038](0038-custom-date-ranges.md) (the one range rule) · **Amends:** [ADR-0011](0011-vantage-administrator-console-operations.md)
§9 and [ADR-0012](0012-unit-manager-console.md) §11 (a person filter on both trails)

## Context

Read on `cf82fa9`:

- `/reports/analysis` read `?user=` and `?unit=`, but nothing in the app built such a link: a leader reached another
  Marine's Analysis only by typing its address. It opened on the saved view whatever the link said.
- One rule chose whose records the six `/api/reports*` routes read (`reportTarget`): for another Marine, the unit asked
  for, a unit of the same Unit Instance where the reader opens them, or their first such unit, with 403 `forbidden` and
  403 `cross_instance`. Every reader then counted that one unit only (`user_id = ? AND unit_id = ? AND visibility =
  'unit'`), and so did the Report library's member target. The member page (`GET /api/org/team/:id`) listed and counted
  every unit the reader opens the Marine in, across Unit Instances, and its figure grid asked `/api/metrics` with no unit,
  which read every unit the reader reads records in. The same Marine had three different totals.
- The grid was headed "fiscal year to date" and read the last 12 months.
- A Marine could read who looked at their record (Settings → Security). What they did themselves, and what happened on
  their account that nobody did (a failed sign-in, a session Vantage ended), was only in the personal export file.
- The unit access log, the Unit Instance trail and the platform trail had no person filter. The trails' text search
  matched names loosely; the unit log paged only.
- `GET /api/me/audit` sent an entry's words unmasked, so an `edipi_corrected` entry put two whole EDIPIs on the screen.

## Decision

### 1. A Marine's Analysis counts one Unit Instance's units, as their page does

1. **One subject rule**, `subjectUnits(ctx, scope, subjectId, askedUnitId, refusal)` in `server/authz/scope.ts`. The
   anchor unit is chosen exactly as before, with the same refusals. What is read is the anchor and every other unit of
   the anchor's Unit Instance where the reader opens the Marine's records (`detailUnitsFor`: `VIEW_MEMBER_DETAIL` and a
   higher position), never a unit of another instance. A unit in no Unit Instance is read alone. One's own records are
   read whole, private ones included, as before.
2. **Every reader about another Marine reads that set**: `unit_id IN (SELECT value FROM json_each(?)) AND visibility =
   'unit'`, in `/api/reports`, `/api/reports/delta`, `/api/reports/analysis`, `/api/reports/analysis.pdf`,
   `/api/reports/pdf`, `/api/reports/csv`, `/api/metrics` and `/api/metrics/contributors` (whose rows for a subject are
   the set alone), and the Report library's member runs and files. Goals keep `visibility = 'unit'`. A private entry is
   never read about another Marine.
3. **Files and checks follow the set.** The CSV needs `EXPORT_DATA` in every unit it reads, and the Report library
   offers CSV, XLSX and JSON only then, PDF otherwise. A PDF is sent only while the reader still opens the Marine in
   every unit it was drawn from, read afresh (403 `access_changed`, no `export_pdf`).
4. **Each unit read keeps the read in its access log.** About another Marine, `build_report` (every `/api/reports*`
   route) and the Report library's `view_report`, `print_report` and `export_report` are written once for each unit
   read, with that unit; the member page writes `view_member` once for each unit it lists; and
   `/api/metrics/contributors`, which returns their records, writes `list_records` for each unit they came from, at most
   once in five minutes per reader, Marine and unit, as every list of records does. The figures of `/api/metrics` stay
   unaudited, as before: the page that shows them has written its `view_member`.
5. **The answer names the set**: `units: [{ id, name, short_name }]` on `/api/reports` and `/api/reports/analysis`, whose
   `unit` now carries its id. The report PDF's unit line and the analysis PDF's cover list every unit read.
6. **No composite score about another Marine.** For another Marine, `coverage.avgStrength` is null: the summary, the
   coverage line and the PDF leave the average entry strength out. Each entry's own score stays, as the record shows it
   to a leader.
7. **The page.** `GET /api/org/team/:id` gains `detailInstances: [{ org_id, org_name, units }]`, the page's units grouped
   by Unit Instance in the page's order. The member page offers **Analysis**
   (`/reports/analysis?user=<id>&unit=<first unit of the instance>&view=analysis`), one for each Unit Instance where the
   reader opens the Marine, labelled "Analysis in <instance>" when there is more than one, and **Access log**
   (`/team/access-log?unit=<unit>&person=<id>`) when the reader holds `VIEW_AUDIT` in one of them. Its figure grid is
   headed "Shared outcomes, last 12 months" and counts the first instance's set; with more than one instance the heading
   names those units. The Reports page opens on the view a link names (`?view=`) each time the address's Marine or
   view changes, and on the reader's saved view otherwise, without saving the link's; a view the reader picks is saved
   and leaves the address. It names the Marine from the report rather than the roster, and says "Drawn from what <Marine> shared with <units>. Private entries are never
   included."

### 2. Your activity

1. `GET /api/me/activity`: the entries the reader wrote (`actor_id = me`) and those on their account nobody did
   (`actor_id IS NULL AND subject_id = me`), newest first, a page at a time (`before`, `next`, `limit` 1 to 1000,
   default 100), filtered by category, action and UTC days under the one range rule. Two reads, one down
   `idx_audit_actor` and one down `idx_audit_subject`, merged by `seq`. No parameter names another person; `user`,
   `actor` and the rest are dropped. Not audited and not rate limited, as `/api/me/audit`.
2. Each row is `{ seq, id, at, action, category, entity, detail, by }`. `by` is `account` when nobody did it, or for
   `password_reset_requested` and `login_lockout`, which are written with the account as actor but which anyone can set
   off while its owner is signed out; `you` otherwise. A row carries no address, user agent, unit or Unit Instance
   field, entity id, seal, or id of anyone: EDIPIs are masked and every id in the words is blanked (`…`). It is less than the
   personal export gives for the same entries.
3. Every Unit Instance the person acted in, as the personal export gives it. Nothing anyone else did appears: a leader's
   look at their record stays in Who has looked at your record.
4. Settings gains a **Your activity** tab (`/settings?tab=activity`) with Category, Action and From/To (UTC) filters and
   Load older. Rows on the account are marked "On your account".
5. `GET /api/me/audit` masks EDIPIs in its rows (`withoutEdipis`). Its query is unchanged.

### 3. One person's trail

1. `person` (one user id, 1 to 64 characters) joins the audit query: the entries they wrote, and those about them that
   somebody else or nobody wrote (`subject_id = ? AND actor_id IS NOT ?`), read as two `UNION ALL` branches through
   `idx_audit_actor` and `idx_audit_subject`, each inside the trail's own filter, merged newest first. It is accepted by
   `GET /api/orgs/:orgId/audit` and `/export`, `GET /api/platform/audit` and `/export`, and
   `GET /api/org/units/:unitId/audit`.
2. **It only narrows.** The person never becomes part of the trail's own SQL, so its chain count and action list stay
   the trail's; a first page narrowed by person alone still carries the trail's whole action list (`carriesActionList`),
   the same as the unfiltered first page, and a page narrowed by anything more carries none. An unknown id, one from another Unit Instance and
   one that never acted there all get the same empty page (200), chain included, so the page says nothing an
   unfiltered read does not. How long it takes is not hidden: it grows with that person's entries elsewhere (see
   Consequences). Another instance's trail is still 404.
3. Exports name the filter as `person=<user id>`, never a name or a username (one Vantage made from a card is an
   EDIPI), in `organization_audit_exported` and `platform_audit_exported`; a JSON file carries it in `filter`.
4. **The unit access log** takes `person` inside `unit_id = ?`, so an entry filed under no unit (one about a private
   entry, ADR-0040 §11) never comes in. `VIEW_AUDIT` is still decided before anything is read. Its rows now carry
   `subject_id`, the id of a subject whose name they already showed.
5. **The pages.** The shared trail (`src/components/AuditTrail.tsx`, both consoles) and the Team access log take
   `?person=` from the address. Each name in the Actor (Who) and Subject columns has an icon button, "Show only <name>",
   and a chip "Only <name>" clears it ("Show everyone"); exports carry it. The console's People list links each member to
   the trail filtered to them for holders of `org.audit`; the admin Accounts list links each account to the platform
   trail for holders of `platform.audit`.

## Consequences

- A leader who opens a Marine through one unit now reads what the Marine shared with every unit of that Unit Instance
  where the leader opens them. That is what their page lists for that instance; the Analysis, the report, the files and
  the grid now agree with it, and never cross into another instance.
- More entries in the trail: one `build_report`, `view_report`, `print_report`, `export_report` or `view_member` for
  each unit read instead of one, and `list_records` for a drill into another Marine's figures. `export_pdf` and
  `export_csv` stay one entry under the anchor unit; the `build_report` of the same request is in every unit read.
  Who has looked at your record and the reader's Your activity carry no unit, so one open by a leader of two units
  shows there as two rows that read alike. Each is a sealed entry of its own; neither screen merges them.
- A reader who opens a Marine in two Unit Instances has two Analysis buttons, and the page's grid counts the first
  instance. The page still lists records from both, as before.
- The average entry strength of another Marine is no longer shown anywhere. Before, only a typed address showed it.
- Your activity can still show short unit or Unit Instance codes and usernames where an entry's words hold them (an
  access approval names its instance; some unit administration names an account), as the personal export already does.
  It guarantees no unit or instance field and no id in the words.
- A person filter lists, on the Unit Instance trail, the actions on that Marine's private entries, which ADR-0040 §11
  keeps there, and on the platform trail the entries about records in no instance. Each was already readable by paging;
  the filter adds no row a reader could not read. Entries written before ADR-0040 keep their unit, so a unit log filtered
  to a Marine lists their older private-entry rows more readily than paging did.
- Records Officers and Unit Auditors hold `org.audit` but not the People page, and the Vantage Auditor holds
  `platform.audit` but not Accounts: they filter from a name in the trail or from a link.
- A person read walks that person's entries in the whole service's index and keeps those inside the trail. For a
  person with many entries elsewhere and few or none here, a page takes longer, though its body is the same as for an
  id with nothing anywhere; the time is not hidden. So does a narrow, old date range for a very busy person. A page
  still returns at most its limit.

## Tests

`tests/server/memberAnalysis.test.ts`: a Marine in FISCAL and BUDGET (one Unit Instance) and MANPOWER (another); a
leader of both opening them through FISCAL reads FISCAL and BUDGET and never MANPOWER or a private entry, from the
analysis, the report, the delta, the CSV, the PDF, the metrics and their contributors, and the Report library; MANPOWER
asked by a leader of another instance is 403 `cross_instance`; the page's count equals the Analysis count; goals (a
private one included) and case work from the same units only; `build_report`, the library's entries, the page's
`view_member` and the contributors' `list_records` in every unit read; the CSV refused without `EXPORT_DATA` in every
unit; both PDFs held back while access changes; the instances' names; the average strength absent for another Marine
and present for oneself. `tests/server/ownActivity.test.ts`: the Marine's own entries in both instances, nothing a
leader of either did about them, events nobody did marked `account`, no address, no unit or Unit Instance field and no id of anyone in any row,
`?user=` and `?actor=` changing nothing, no entry written by reading it, filters and paging, an id holding ten digits
in a row blanked whole, EDIPIs masked here and in `/api/me/audit`, and the two index plans. `tests/server/auditPerson.test.ts`: the same empty page for a Marine of another
instance as for an id nobody has, every filtered row the person's and already in the trail, the unit log filtered to a
Marine holding no private-entry row, entries nobody wrote coming back once in the trail they are filed in, the filter
with the others and with `before`, the chain count and action list unchanged, and exports naming the filter by id. `tests/server/auditScale.test.ts`: the person branches read through their
two indexes and merged, never sorted, and AUD-2 with `person`. Browser: `63-member-analysis` (the link's view, the saved view kept), `64-own-activity`
(axe at desktop and 390 px, paging to the oldest entry) and `65-audit-person` (the People and Accounts links, the
chip's name and the Action list on a narrowed page).
