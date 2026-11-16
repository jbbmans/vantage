# ADR-0032 · Performance, accessibility and responsive layout at MCEN scale

**Status:** accepted · **Date:** 2026-11-16 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0013](0013-security-audit-least-privilege.md), [ADR-0016](0016-information-architecture.md),
[ADR-0017](0017-personnel-records.md), [ADR-0020](0020-reports-printable-output.md),
[ADR-0021](0021-financial-error-reports.md), [ADR-0024](0024-duty-review-permissions-scoring.md),
[ADR-0028](0028-unified-analytics.md), [ADR-0031](0031-workflow-messages-and-notices.md)

## Context

Task 25 of the governing specification (VANTAGE_CLAUDE_MASTER.md, P1) is Performance / Accessibility / Responsive MCEN UX:

> Optimize: personnel tables, reports, error snapshots, audit logs, duty history, analytics. Use: pagination, indexing,
> efficient queries, lazy loading where appropriate. Maintain WCAG 2.2 AA. Test: keyboard, focus, labels, errors, charts,
> responsive layout. Use Playwright + axe.

Main at `93a91ea` was measured before any change, on a seeded database at MCEN scale (a battalion of about 1,000
Marines, five years of records, up to 1M audit entries) and on the built app in Chromium at 320, 390, 768 and 1280 px,
light and dark (the plan, `task25/PLAN.md`, lists every finding). What mattered most:

- **Lists cut before they were checked.** Report Studio read 400 records and then dropped what the reader could not cite;
  the people directory took 50 and then dropped whom the reader could not enroll. That is the Task 24 bug class: a reader
  with access to row 401 never saw it, and a page could come back short or empty while more existed. The unit dashboard,
  unit overview and report center read child units through a position-0 role, which reaches no child unit anywhere else.
- **Silent cuts.** "Open now" and the open-case report stopped at 50,000 rows before filtering; a Unit Instance export
  dropped members past 500; CSV and XLSX files stopped at 5,000 rows without a word; totals were sums of cut lists.
- **Slow reads.** The roster asked for each row's permissions twice (45,000 statements, 2.4 to 2.9 s at 3,000 rows); the
  audit trail recomputed its whole hash chain on every first page (9.3 s at 1.05M entries); the duty page loaded every
  duty (27.6 MB); error snapshot history grew with the whole history; a windowed unit read had no lower bound in any
  index, so 90 days cost five years.
- **WCAG 2.2 AA gaps.** A shadowed button, card or active tab hid the focus ring (2.4.7); focus landed under the sticky
  header and the phone tab bar (2.4.11); 14 of 15 dialogs dropped focus to the page on close (2.4.3); wide tables could
  not be scrolled by keyboard and had no caption (2.1.1, 1.3.1); the phone menu was not a dialog; single-key shortcuts
  could not be turned off (2.1.4); a loading button dropped focus; several record dialogs reported errors only in a toast
  (3.3.1); a few pages scrolled sideways at 320 px (1.4.10); some targets were under 24 px (2.5.8); two colours failed
  contrast; the Tabs primitive had no arrow keys or tab panels.

## Decision

### 1. Authorization is decided before a list is cut, and a cut list says so

Every list that is limited decides which rows the reader may see first, in SQL where it can, then limits, then still
checks each row it returns (defence in depth). Report Studio's sources use `readableClause` and the Unit Instance
filter before `LIMIT`; the directory and the supervisor search check candidates in keyset batches until the page is full
and answer `more`; the duty list decides readable rows before its cursor. A list that stops at a bound answers how many
there were (`total`, `more`, `next_cursor`, `next_offset`, `audit_trail_cut`, `X-Vantage-Rows: shown/total`), and the
page or file says so in words. Nothing is cut without a word.

The dashboard, overview and report center now read only the units the reader may read and list only Marines the reader
may open there, the same rule `/metrics` and ADR-0028 already used. **A position-0 role at a parent unit no longer shows
its child units on these three pages**, as it already did not anywhere else.

### 2. Permissions for many people are built at once, by the same builder

`scopeFor` is a loader (`loadScopeRows`) and a pure builder (`buildScope`). `scopesFor(ctx, ids)` loads many people's
rows in five statements (ids go in as one JSON value, `json_each`) and builds each scope with the same builder, so each is
exactly what `scopeFor` gives. A parity test covers leaders, unseated leaders, position-0 and position>0 roles, expired
and self-granted roles, Unit Manager roles, a suspended Unit Instance, archived units and Vantage access, and was also run
against main's own `scopeFor`. Ties in ordering break on ids, so a scope never depends on how many were read together.
`detailUnitsFor` takes a target scope. The roster reads a constant 43 statements whether it shows 900 people or 3,800.

### 3. Lists page, totals come from SQL, and slow reads are bounded

| Area | Contract |
|---|---|
| Personnel | Directory and supervisor search `{ results, more }`; Unit Instance members `{ members, more, next }`, and the export pages through all of them; member page counts are real counts, lists at most 500 each. |
| Reports | `GET /api/studio/reports` `{ drafts, next_cursor }`; open cases and requirement history filtered in SQL; totals from SQL; report tables show 200 rows with "Show more" (print shows all); files still stop at 5,000 rows (ADR-0020) and say so; only a few PDF or file renders run at once (429 `exports_busy`), and PDF drawing yields to other requests. |
| Error snapshots | A series' history read by key; drill rows paged by the server after its checks (`offset`, `limit`, `next_offset`); the overview reads counts and the latest two snapshots per series. |
| Audit logs | `/api/me/audit` `{ rows, next }`, the unit log `{ unit_id, rows, next }`, both with "Load older"; the chain check on a trail's first page is cached for up to 60 s, while the explicit integrity checks stay fresh and stream rows; an export larger than its limit is refused after a count, before any row is read; the unit log names people. |
| Duty history | `GET /api/record/duty/list` (paged by keyset cursor, per tab) and `GET /api/record/duty/summary` (totals in SQL); the review queue and deep links keep working. |
| Analytics | `/metrics` validates its dates (at most 240 months) and stops sending every contributor (a drill reads them); drills batch their permission checks; Today survives a failed `/metrics`; the members table shows 25 with "Show all"; PDF text fitting is a binary search. |

Reads that are audited (the roster, a Marine's page, reports, analytics, audit logs) are kept for 60 s and are not read
again when the person comes back to the window, so switching tabs writes no audit entry. A Marine's page is the
exception once its read is a minute old or a change made it stale: coming back reads it again, so a training the Marine
took back is not still shown.

### 4. Indexes in migration 039, each asserted by its read's plan

Migration 039 (`039_performance_indexes`) adds indexes only: no table, column, trigger or row changes. It lives in a
migration because several indexes are on columns earlier migrations added, which `schema.sql` runs before. The period
indexes are on the exact expression `periodClause` writes for the last day a record covers, and the analytics reads name
them with `INDEXED BY`, so a change to that expression without its index fails a test instead of silently scanning. Each
indexed read has an `EXPLAIN QUERY PLAN` assertion. No `ANALYZE` is run; `PRAGMA optimize` at open keeps statistics.

### 5. Accessibility is built into the primitives

- **Focus** is a 2 px outline that no component shadow can replace (`:root :focus-visible`); the skip link's target
  shows none. Keyboard focus is kept clear of the sticky header and the phone tab bar: `scroll-padding` for anchors, and
  `keepFocusClear` (`src/lib/keyboard.ts`) for focus itself, because Chromium does not apply scroll padding to focus.
- **Dialogs** give focus back to what opened them, whether they close or their owner unmounts them; a body longer than
  the dialog takes a Tab stop. The phone menu is a dialog named "Menu". The command palette and Quick Log return focus.
- **Tables** require a `label`, their caption; their scroller is a named, focusable region only while it overflows
  (`ScrollRegion`, `useOverflow`). The work queue has `aria-sort` and keeps focus when sorting.
- **Tabs** move with the arrow keys, Home and End, and name their panel (`TabPanel`).
- **Buttons** that are busy keep focus (`aria-disabled`, presses ignored) instead of becoming disabled.
- **Forms** in record dialogs put each refusal on its field and move focus to the first one (`useRefusal`, `missing()`).
- **Shortcuts.** Single-key shortcuts can be turned off in Settings, Appearance (a `shortcuts` preference; on by default).
  The work queue's single keys (J, K, Space, Enter, C) act only with focus in its rows, as the shortcuts list says.
- **Layout and colour.** Pages reflow at 320 px; targets are at least 24 px; `--warn` is darker (5.2:1 at least as text
  and on its badge, on every light palette); each console section has its own page title.
- **Startup.** The app, the Unit Manager console and the Vantage Administrator console draw without the schema library
  or the list of changes; draft and request kinds are named from small modules.

### 6. Tests

Server tests cover each behaviour change: authorization before limits, every new page and cursor, counts, validation,
the plans above, statement budgets where an N+1 was removed, and the parity of `scopesFor`. Browser spec 55 runs axe with
the WCAG 2.0, 2.1 and 2.2 A and AA tags, at every impact, on the signed-out pages, every core page, both consoles and the
dialogs people open most, at 320, 390, 768 and 1280 px (light and dark at 390 and 1280), and fails any page that scrolls
sideways. Spec 56 walks the keyboard: focus visible at every stop, never covered on a phone, given back by dialogs and
the phone menu, kept by a busy button, moved to the first field a save refuses; shortcuts off and on; tabs by arrow keys.

## Consequences

- API shapes changed for the lists above (objects with paging fields instead of bare arrays). Every client in this
  repository is updated; there is no other client.
- A position-0 role at a parent unit sees less on the dashboard, overview and report center (section 1).
- Defaults that can change later without a new decision: 200 rows before "Show more" in reports, 25 members on the
  dashboard, 100 entries per page of a person's own audit log and 200 of a unit's log or an audit trail; the audit chain status on a trail's first page may be up to 60 s old.

## Not done

- **Tagged PDFs** (PDF/UA): pdfkit has the flags, but the hand-drawn report tables need structure elements and a layout
  rewrite, and nothing here can verify the result (veraPDF or a screen reader).
- **Virtualizing every table**: capped lists with "Show more", server paging and the Workbench's existing windowing
  cover the measured cases without changing print or find-in-page.
- **Segmented filters** still use `role="tablist"` without panels (the roster's "Show" filter among them); a
  toggle-button or radio-group variant is a follow-up.
- **Validators** in a few callers (Work, record detail, member detail, the move dialog) still return a message, shown
  as a toast, not on a field.
- **Audit text search** is not bounded by an entry window, and a 50,000-row audit export is built in memory, not
  streamed.
- **Invitations index**: an index on the invitations list's expression was tried; without statistics the planner keeps
  the existing kind index, and the list is small, so it was left out.
