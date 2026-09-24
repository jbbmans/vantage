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
- **Navigation is Today · Work · Record · Goals · Career · Team**, with People for team leaders and
  administrators. Nothing was removed: Readiness is under Career and activities are under Record, and
  old links still work.
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

## Premium visual layer (2026-09-24)

The signed-in app now has depth, light and ambient motion on the existing brand (PD-018,
DESIGN_SYSTEM → Premium layer):
- an ambient light field and grain behind everything, and glass header, tabs and overlays;
- a lit navy rail whose active pill slides between destinations;
- cards with a lit edge and tinted shadows, and a border that follows the cursor;
- flat, crisp buttons (the glossy first version was dropped on owner feedback), page titles that blur in, and a hero band on Today;
- a beam around the next task, live status dots, and cascading entrances.

- On owner feedback: flat buttons; a light, frosted sidebar with a unit switcher, counts,
  keyboard routes and the profile menu; and fewer, calmer boxes, with grouped figures in one
  strip, no boxes inside boxes, and quick capture folded into Today's hero.

Reduced motion stops all of it. It was checked at four sizes in both themes. The component
libraries the owner named were not added; PD-018 records why for each.

## Enterprise slice (2026-09-24)

On the owner's request ("make teams public for everyone", "projects", "add education, volunteer,
extracurricular", "save all records, not just financial", "a way better user management system:
personal, team leader and administrator", "make this enterprise ready"):
- **Teams are open to their members** (PD-019). Team is a primary destination for everyone. Each member sees:
  - the roster with each person's access level;
  - the team's totals and where its work stands;
  - a list of every team in the organization.

  Per-person workload and opening records stay with team leaders, and each open is logged.
- **Three access levels and a People page** (PD-020). Personal, Team leader and Administrator are held per team. People sets them, adds and removes members and invites at a level. An organization administrator also manages accounts: suspend, restore, reset two-step, temporary password, sign out everywhere. The demo has one persona per level.
- **Records of every kind** (PD-021). Work, education, certification, training or PME, volunteer, extracurricular, physical fitness, and award. Each has its own fields, and the server saves exactly those (migration 009).
- **"Projects"** replaces "Taskers and projects" (PD-022).
- **Operations:**
  - `/api/health/live` and `/api/health/ready`;
  - `npm run backup`, a verified, fingerprinted, pruned backup, with the time shown in the owner console;
  - importing an archive from an older version fills newer columns with their defaults.
- **Readiness.** `docs/engineering/ENTERPRISE_READINESS.md` is an honest checklist of what an evaluator can rely on and what waits on the owner: single sign-on, PostgreSQL, off-host backups, audit export.

## Verification (this branch, 2026-09-23; tooling slice 2026-09-24; enterprise slice 2026-09-24)

Enterprise slice:
- `npm run lint` and `npm run typecheck`: clean.
- `npm test`: **377 / 377 pass**. New coverage is `people`, `enterprise` (probes and backup), migration 009, record kinds, category hints, and archive import across versions.
- `npm run test:browser`, full run: 66 passed and 6 failed.
  - Two failures were new and are fixed: the demo banner overflowed a 390px phone once it held two persona buttons, and axe read the People page mid theme-fade.
  - After the fixes, the demo, People, navigation, team and phone specs re-run clean: 14 / 14.
  - The other four failures are the pre-existing public-site checks below.
- Screens checked by eye in `artifacts/enterprise/`: Team as a member, the roster, record kinds, People in light and dark, and People on a phone.

Earlier slices:

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
  - A restore drill on a real host. The backup command itself is tested (`tests/server/enterprise.test.ts`).
  - Single sign-on (not built; owner decision).
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
2. ~~Is "Taskers and projects" the right name for the Work tab?~~ **Answered:** "Projects" (PD-022).
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

8. **Third-party UI components.** Approve (or not) adding code from Magic UI, Vengeance UI or
   similar registries. The current premium layer is written for Vantage and needs no such code.

## Owner decisions from the enterprise request

9. **Single sign-on.** Choose an identity provider (SAML or OIDC; for example Microsoft Entra ID or Okta), and
   whether accounts should be provisioned from it (SCIM). Nothing is wired until the owner names one.
10. **PostgreSQL** (ADR-0003): approve the staged move and its hosting cost, or keep SQLite on one host.
11. **Where backups go.** `npm run backup` keeps verified copies on the same host. Choose an off-host destination.
12. **Audit export.** Should the audit log feed a SIEM or log service, and which one?
13. **Rosters across teams.** Teams are open to their own members (PD-019). Should every signed-in person
    also see the people on teams they are not on? That is a privacy reduction, so it is the owner's call.

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
