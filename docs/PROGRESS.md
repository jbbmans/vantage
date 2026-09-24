# Progress

_Updated 2026-09-24 · branch `claude/vantage-restore-enterprise-llq8d8` · base `main` @ `ac51ce9`_

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

## Owner-requested tooling (2026-09-24)

- **Motion: GSAP, Anime.js, Motion and React Spring**, one job each (DESIGN_SYSTEM → Motion, PD-016).
  Tabs and segmented controls slide their selection. Claimed work folds out of one list and into
  another. Toasts make room. The next step's form rises in, and new history entries slide in. Progress
  meters spring to new readings. A fresh calculation plays its arithmetic in order (GSAP), and a
  completed step draws its check mark (Anime.js). Nothing moves at rest, no figure is ever tweened,
  and reduced motion stops all four. The first download grew by about 34 KB gzipped; GSAP, Anime.js
  and Motion's layout features load on demand.
- **PostHog, demo only** (PD-017). `VANTAGE_POSTHOG_KEY` forwards the existing first-party event
  catalog from a synthetic-demo instance: screens as page views, plus procedure steps, stage moves,
  calculations, hand-offs and funds-check refusals as named events. Visitors are pseudonymous and the
  demo banner discloses it. There is no browser SDK, autocapture or replay. The key is refused in
  accounts mode. **Off until the owner supplies a key.**
- **Graphify.** `graphify extract . --code-only` builds a local knowledge graph of the code (about
  2,500 nodes, 15 s, no API key). `CLAUDE.md` tells agents to query it before reading files. The
  output is generated, not committed. A session-start hook to rebuild it in every web session was
  **not** installed, because changing Claude Code's hook settings is the owner's decision.
- Fixed along the way: `work.created` and `work.assigned` were raised but missing from the event
  catalog, so they were silently dropped. Two browser specs now wait for the item page itself
  rather than its URL.

## Verification (this branch, 2026-09-23, tooling slice re-run 2026-09-24)

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run typecheck` (server, web, browser tests) | clean |
| `npm test`: server suite, in-memory SQLite | **366 / 366 pass**. Includes `cases`, `record`, `demo`, `posthog` and the 008 migration test |
| `npm run test:browser`: Playwright, Chromium, built client | **66 pass, 4 fail**. All 4 failures are the public-site checks below, and they fail identically on untouched `main` |
| Motion | `tests/browser/23-motion.spec.ts`: a fresh calculation animates with exact figures on every frame, a reopened case plays nothing, tabs and meters settle correctly, reduced motion stops everything, and axe passes on the settled page. Frames captured and inspected |
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

## Owner decisions from the tooling request

6. **PostHog.** Supply a project key for the demo host, or leave it off. Anything wider (a browser SDK,
   session replay, real instances) would change contract §24, not configuration. To let Claude read the
   results, connect the PostHog connector at claude.ai.
7. **Graphify session hook.** If agents should rebuild the graph at the start of every web session, add a
   SessionStart hook (the command is in `CLAUDE.md`). Claude did not change hook settings itself.

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
