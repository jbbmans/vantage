# Progress

_Updated 2026-09-23 · branch `claude/vantage-restore-enterprise-llq8d8` · base `main` @ `ac51ce9`_

## Phase

- **A (recover and plan):** done.
- **B (prove the experience):** built and tested on the real application. It now waits on the owner's
  review of the running screens.
- **C onward:** not started.

## What changed, in product terms

- **The synthetic demo opens straight onto Today.** There is no sign-in form. One banner names the
  synthetic persona and how long changes last. The visitor can view as the Marine or as the section
  lead, or start over.
- **Navigation is Today · Work · Record · Goals · Career**, with Team for leaders. Nothing was removed:
  Readiness is under Career and activities are under Record, and old links still work.
- **Today** shows your work with its next step, what is waiting on someone else, what is open to claim,
  what changed, quick capture, and your goals and next career step. A leader's Today puts unassigned,
  overdue, blocked and waiting work first, with who holds what.
- **Work** shows document numbers, stages and holders by name, and defaults to open work. Each item has
  its own page: the procedure checklist, a form for the current step, the candidate calculation with
  every input cited, any kind of entry, an append-only history, and who worked it.
- **2-Way UMT:** research, a candidate calculation in exact cents (the reference case gives +$2,775.00),
  an explicit decision with its reason, and separate prepared, submitted, approved and posted
  facts. A failed or missing funds check blocks submission. Resolution waits on verifying that the
  condition cleared.
- **Record** keeps three things apart: what you hold (not credit), what you contributed (from the work's
  own history; one document counts once), and what you logged yourself. It also holds private drafts
  built only from your own cited facts.
- **Career** now has a plan and next steps. Each step says where its guidance came from, and is marked
  "Not verified" until someone checks it.
- **Team → Workload** shows section and per-person counts beside definitions and stated limits.
- **Removed:** Google Tag Manager, and keystroke-derived "active editing" timing. The MARADMIN feed is
  now off by default, so nothing leaves the server.

## Verification (this branch, 2026-09-23)

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` (server, web, browser tests) | clean |
| `npm test`: server suite, in-memory SQLite | **363 / 363 pass**. Includes new `cases`, `record` and `demo` suites and the 008 migration test |
| `npm run test:browser`: Playwright, Chromium, built client | **63 pass, 4 fail**. All 4 failures are the public-site checks below, and they fail identically on untouched `main` |
| Flagship journey, demo mode, real server | Automated in `tests/browser/22-demo.spec.ts`: claim, research, calculate, decide, hand off, both contributors, private draft, quick capture, goal update, career step, leader workload |
| Accessibility | axe finds no serious or critical violations in either theme on Today, Work, the item page, Record, Contributions, Career, Goals and Team → Workload, plus the existing page set |
| Viewports | No sideways scrolling at 1440×900, 1280×800, 768×1024 and 390×844 on Today, Work, the item page, Record and Career (automated). Screens were captured and inspected at all four sizes in light, and at 1440 in dark |

### Failing and incomplete checks

- **Pre-existing on `main`, not caused here:** `20-public-site` ("is fully visible before anybody
  scrolls", "carries its substance in the first render", "every walkthrough offered … actually plays")
  and `06-a11y` "public display page". They expect a "See the work" section and walkthrough videos that
  the owner unpublished in `91566f1`/`ac51ce9`. Left for the owner to decide: restore the section, or
  update the tests to the new public page.
- **Not verified:**
  - PostgreSQL. Not implemented (ADR-0003); nothing here claims PostgreSQL behavior.
  - Windows Server.
  - A real CAC.
  - An MCEN or restricted-network host.
  - Backup and restore drills.
  - Clean install from an offline dependency bundle.
  - Keyboard-only walkthrough of the new item page beyond axe and label checks.
- **Not done:**
  - An observed usability check with someone new to Vantage (contract §29).
  - Field guide text for the new navigation.

## Blockers

None blocks continued work. Two decisions are the owner's:

1. **Confirm the reference product.** This work treats `jbbmans/vantage` `main` (Vantage 5.0.0) as the
   "old Vantage" (PD-001). If a different commit, repository (`vantage-main`?) or set of screenshots
   is the one the owner prefers, the parity check is re-run against it.
2. **Review the new screens.** The visual identity is unchanged; the hierarchy on each screen is new.
   It is not treated as approved until the owner has seen it.

## Owner feedback needed (specific)

1. Should Today put the leader's section block above the leader's own work, as it does now, or below?
2. Is "Taskers and projects" the right name for the Work tab that holds projects, or does the shop say
   something else?
3. The 2-Way UMT page shows one step's form at a time, with the whole checklist on the right. Is that
   the right balance for an experienced analyst, or should all remaining fields be on one form?
4. In the Record, is "Documents researched / Research entries / Submitted / Verified outcomes /
   Resolved" the right set of measures, with the right names?
5. Keep the demo's 24-hour workspace lifetime, or shorten it for a public host?

## Open questions

- Financial: `docs/domain/SME_QUESTIONS.md` (Q-01 … Q-15).
- Infrastructure: `docs/engineering/INFRASTRUCTURE_QUESTIONS.md` (I-01 … I-12).

## Next actions

1. Walk through the demo with the owner (`docs/demo/BOARD_DEMO.md`) and adjust from their answers above.
2. Run an observed usability check with a Marine new to Vantage, and fix what confuses them.
3. Phase C: the data-access port and PostgreSQL adapter (ADR-0003, stages 1–4). A reviewer role.
4. Phase D: a versioned UMT import recipe that applies the procedure at import; batch assignment;
   load test with 500–1,000 rows.
5. Update the Field guide once the navigation is accepted.
