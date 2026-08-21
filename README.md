# Vantage v3.3.0

> **V3.3 — the Security, Integrity, and Reliability Release.** Every finding
> in the v3.3 roadmap (1–52) is closed. Every permission decision is
> server-authoritative and pinned by a 51-row matrix; every personnel access
> change is audited; every important input is validated server-side with the
> refusal named under the exact field; every evaluation claim is sourced or
> labeled a Vantage heuristic; every destructive operation is reversible; and
> a transfer immediately produces the correct access state — proven through
> the real UI, not just the API. The Definition-of-Done below records what
> was verified, by which suite, and the short list that needs your
> deployment to verify. Every authorization finding from the v3.3 roadmap's Phase 1 is
> closed and pinned by an adversarial test suite. What remains open is listed
> honestly below — read it, and read "Before real names go in it," before any
> real records land on this build.

## How to hand this build back to a working session

Upload two things together: this zip **and the v3.3 roadmap document** (the
52-finding review). The ledger below records what is done against those
numbers; the roadmap holds the full text of what remains. With both in hand, a
session can resume at the exact finding where this one stopped — nothing lives
only in a chat transcript.

## v3.3 ledger — closed in this build

Wired, enforced at the API, and each pinned by `tests/security.test.mjs`:

- **1 — role-editing privilege escalation.** Role create/edit/grant/delete all
  route through `server/roleGuard.js`. Edits are validated on the **merged**
  result, so a permission bit can't ride in through a partial update. An
  editor can only place bits they themselves hold in the unit at stake, only
  below their own position, and `ADMINISTRATOR` never delegates.
- **2 — transfers revoke old-unit access.** `server/lifecycle.js
  transferMember`: old-unit role grants are revoked in the same transaction
  that moves the assignment, sessions are invalidated when scope changes, and
  the default role follows to the new unit. `retain_role_ids` exists for
  legitimate collateral duties — and each retention re-runs the full grant
  check, so "retain" cannot keep alive a role the actor couldn't grant.
- **3 — sessions, end to end.** Server side landed in 3.2.1 (true session
  cookie, 60-min idle / 12-hr absolute). This build finishes the client half:
  the browser stores **no token at all** — the HttpOnly cookie is the
  credential, every request carries the `x-vantage-client` CSRF header, and a
  non-sensitive presence cookie lets a signed-out page skip the boot probe.
- **4 — account deactivation.** Deactivate / reactivate endpoints; a
  deactivated account cannot sign in, its live sessions die immediately, and
  it leaves the roster. A last-active-administrator guard refuses the
  deactivation that would lock everyone out.
- **5 — resource-specific sharing.** Goals require `CREATE_SHARED_GOALS`,
  work records require `CREATE_SHARED_WORK`; holding one no longer implies
  the other.
- **6 / 7 — role scope.** Custom roles carry a unit scope; non-administrators
  must scope roles inside their own authority, org-wide definitions are
  admin-only, and a lower position no longer permits editing or deleting a
  foreign command's role.
- **8 — assignment authority.** Moving a Marine requires `MANAGE_MEMBERS`
  over **both** source and destination, and a Marine holding a role at or
  above the actor's own position cannot be moved by them.
- **10 — unit-scoped audit.** `GET /api/audit/unit?unit_id=` for
  `VIEW_AUDIT` holders, scoped to their reach.
- **11 / 21 — input validation.** Every write validates against
  `server/validate.js` schemas; failures return `{ error, fieldErrors }`.
  Readiness scores are **rejected** out of range, never clamped. Includes a
  calendar fix found while testing: `Date.parse` silently rolls 2026-02-31
  into March, so dates now round-trip their components. v3.2.4 corrects the
  rifle framing: the ARQ has **no 0–350 total** — it classifies by destroys
  plus drills (Expert 43–50, Sharpshooter 31–42, Marksman 15–30, per MCO
  3574.2M); the 0–350 field is now labeled as the entry-level tables it is.
- **12 / 13 — bulk import.** 500-row ceiling, every row validated before any
  insert, and a server-side `sha256(user | date | title | quantity | dollars)`
  fingerprint makes re-imports land each row exactly once — the response
  reports `{ created, duplicates, duplicateRows }`. Manual single entries set
  no fingerprint by design; duplicate protection is an import-path concern.
- **14 — assignees.** A task/goal assignee must be visible to the author,
  active, and actually serve in the record's unit.
- **15 — project deletion unlinks.** Tasks and activities lose their
  `project_id` in the same transaction, audited with counts — the client's
  claim is now true.
- **16 — password change.** `POST /api/me/password` (verifies the current
  password, keeps this session, revokes the rest) and an admin reset that
  revokes everything. Settings now carries the change-password form; the
  admin reset lives on the member page.
- **17 — login throttling.** `server/security.js` wired at `/api/login` and
  `/api/setup`: 15 failures per account, 10 per IP, 300 global per 15-minute
  window → 429 with `Retry-After`; account lockouts are audited; unknown-user
  and wrong-password paths take the same time.
- **18 — TRUST_PROXY.** Explicit resolver (defaults: 1 in production, off in
  dev; accepts false/counts/subnets). `fly.toml` and `render.yaml` now pin
  `TRUST_PROXY = "1"` so throttling counts real client IPs, not the edge.
- **24 — audit coverage.** Login, logout, lockout, password changes, session
  revocations, transfers (old→new, roles revoked/retained), deactivations,
  role create/edit/delete/grant/revoke, exports, access reviews, and
  `unit_id` on record create/edit/delete/restore.
- **25 — export moved server-side.** `GET /api/export?unit_id=` enforces
  `EXPORT_DATA`, exports the subtree, and **never** includes private records.
- **29 / 30 / 33** — versioned migrations, insert-only seeding, single
  version source (landed in 3.2.1, unchanged).
- **36 — optimistic concurrency.** Every record carries `version`; a stale
  edit gets `409 { code: "stale", current }` with the winning copy instead of
  silently overwriting it.
- **38 — record/unit consistency.** A record can only be pinned to a unit its
  author serves in or holds the relevant share permission for.
- **19 / 20 — the JEPES estimator is gone; a preparation dashboard replaced
  it.** The peer-percentile point tables live in MCO 1616.1's Appendix B and
  on MOL — they are not publicly reproducible, so per the roadmap's own rule
  Vantage took Option B: **no composite score is displayed, by design.** The
  page shows the public four-pillar framework as input status (entered /
  missing / Vantage's coaching read), a standing **MOS Qualification** pointer
  at the MOL/MCTIMS table (MARADMIN 046/24) with an explicit "Vantage will
  not estimate these," and the old invented "+37 pts" gains are gone from
  every recommendation.
- **22 / 47 / 49 — claims labeled, evidence never presented as evaluation.**
  Every recommendation on both tracks now carries a kind chip — *Official
  reference*, *From your log*, or *Coaching heuristic*. The FITREP "PME
  hard-cap" and "PFT table stakes" claims, which MCO 1610.7B does not
  support, were rewritten as labeled coaching. Attribute coverage speaks in
  "possible supporting evidence" / "no obvious evidence found," never
  "covered."
- **23 / 48 / 50 — one citation source.** `src/lib/evalRefs.js` holds every
  order, MARADMIN, date, and official marines.mil URL, with a
  verified-on date. FITREP surfaces cite **MCO 1610.7B (5 Jun 2023)**; JEPES
  cites MCO 1616.1 plus MARADMINs 025/21, 367/21, 272/22, 046/24; the
  Readiness pages render a References panel linking only official sources
  (including the 2026 PFT changes, MARADMINs 613/25 and 066/26, as notes).
- **9 — billet/role ambiguity retired (Option A).** A billet is an
  organizational position; permissions come only from role grants. The legacy
  `assignments.role` label is no longer written (migration 005 blanks the old
  values — decorative metadata, not records), and the Team dialog now says in
  so many words that picking a billet only pre-fills the role suggestion.
- **26 — one visibility definition everywhere.** The server always meant
  *unit = everyone assigned to that exact unit*; the picker and the SOP said
  "peers as well as your leaders." The copy now matches the code: unit is the
  exact unit, chain is what travels up and down the tree.
- **31 — backups in the product.** Settings → Database (admin-only): size,
  schema version, last backup, and a one-click consistent snapshot taken
  while the server keeps running (`better-sqlite3` backup API). Every
  download is audited. The restore procedure is documented below.
- **32 — administrator recovery, documented and auditable.** `VANTAGE_RECOVERY=1
  npm run recover -- <username>` on the deployment shell resets the account
  to a printed one-time password, revokes every session it held, and writes
  an `admin_recovery` audit row. No backdoor: it requires shell access and an
  explicit per-invocation flag, and it cannot run silently.
- **35 — failed saves stop costing work.** The activity editor mirrors
  unsaved edits into local storage keyed to the record and the version they
  were made against; a fresh visit offers the draft back (with a discard)
  only when the server copy hasn't moved. The quick-log dialog keeps its text
  through a failed save or an accidental close, and says so.
- **39 — the permission matrix is a suite.** `tests/matrix.test.mjs`: 51
  rows of role × unit relationship × action (read, share, manage, grant,
  audit, export, unit creation), each asserted allow or deny, run by
  `npm test`. A future change that widens or narrows anyone's reach fails
  with the exact row that moved.
- **44 — failure states that tell the truth.** A refresh that fails
  mid-session keeps the last loaded records on screen and raises a banner
  with Retry instead of silently rendering an empty account; the store no
  longer overwrites loaded data with `[]` on error. The full-screen
  can't-reach-server gate now applies only before sign-in.
- **42 — accessibility is a gate, not an aspiration.** `tests/browser-a11y.test.mjs`
  runs axe-core over the login screen and all eleven signed-in routes and
  **fails the build on any serious or critical violation** — it runs in
  `npm run test:browser`. Getting it green took three real fixes: `Field` now
  associates every label with its control (which also names Radix select
  triggers), bare `Select`s fall back to their placeholder as an accessible
  name, and the `text-3` token was brightened to ≥4.5:1 on every surface in
  both themes. Remaining manual pass (full keyboard walk, screen-reader
  audit) is listed in the DoD below.
- **43 — mobile is a gate too.** `tests/browser-mobile.test.mjs` proves every
  route fits a 375px phone and a 768px tablet with no page-level horizontal
  overflow, and that the phone drawer opens and navigates. It caught a real
  one: the References citations couldn't wrap and dragged the readiness page
  53px sideways.
- **45 — the dashboard answers "what should I do today?"** A Today block
  leads the Command Center: overdue tasks, goals inside two weeks of period
  end, recent entries missing outcomes, incomplete readiness fields, and the
  FITREP countdown on the fitrep track — each row a link to the fix, and an
  empty list says so plainly.
- **46 — record health.** A dashboard section reporting how usable the log is
  as evidence: missing outcomes, untagged and undated entries, five-figure
  dollar claims without an evidence link (labeled a Vantage heuristic),
  duplicate candidates, stale goals, and empty readiness fields — counts and
  routes, never a judgement of the Marine. `src/lib/health.js`, unit-tested.
- **34 — errors land under their fields.** Every server refusal that names a
  field now renders inline under that exact input — activity editor, both
  readiness tracks, the member dialog, the role dialog, goals, tasks and
  projects — with `aria-invalid` and `aria-describedby`, so screen readers
  hear the refusal too. Typing in a field clears its own error and nothing
  else; the toast still summarizes.
- **35 — no form loses work, full stop.** Draft mirroring now also covers
  member creation and new-role definitions (sessionStorage, restored with a
  visible note; explicit Cancel discards, a successful save clears). With
  the activity editor's version-keyed local drafts and the quick-log's
  session draft, every form the roadmap listed survives a failed save.
- **36 — reload-or-overwrite everywhere.** The full conflict dialog (shared
  `ConflictDialog`) now fronts goals, tasks and projects as well as the
  activity editor: see the winning copy and its version, load it into the
  form, or knowingly overwrite it.
- **41 — the security-sensitive flows run through the real UI.** The browser
  suite drives: a scoped role-manager attempting escalation (the ungrantable
  permission renders disabled; the position push is refused; the API
  confirms the role unchanged), and a transfer via the Team page (the
  assignment moves and the old-unit role grant is proven revoked) — plus the
  stale-edit conflict and the deactivate → reactivate cycle from v3.2.6.
- **40 — the security suite.** `tests/security.test.mjs`: 49 tests that
  attack the server on purpose — escalation, transfer leakage, session
  survival, CSRF, garbage inputs, duplicate imports, stale writes, audit and
  export scoping, throttling. `npm test` runs it.

- **27 / 28 — access review, session & account management, now with
  screens.** Settings shows every session the signed-in Marine holds (device,
  IP, last used, "This device"), with per-session sign-out and a
  sign-out-others action. A Marine's page gains an **Account and access**
  panel for anyone the server lets administer them — roles held (orphaned
  grants flagged), live sessions, last sign-in, the review's findings, and
  the actions: force sign-out, reset password, deactivate (confirmed, with
  consequences stated). A deactivated Marine, invisible everywhere else on
  purpose, still resolves at their old URL as a management card with
  Reactivate. Authority is decided server-side: the panel appears because
  `GET /api/team/:id/access` answered, not because the client guessed.
- **34 — user-grade errors.** `ApiError` now carries the server's `code`,
  `fieldErrors`, and (on 409) the winning copy; refusal toasts across the
  record, roster, roles, units, and readiness pages render the field-level
  messages, so "Could not save" became "dollar_amount must be a non-negative
  number."
- **36 (client) — the stale-edit choice.** When a save comes back
  `409 stale`, the activity editor opens a conflict dialog: load the newest
  copy, or knowingly overwrite it. Nothing is lost silently in either
  direction.

## v3.3 ledger — partial

- **Manual QA remainder only.** The axe gate covers what automation can
  see; a full keyboard walk and a screen-reader session are still a human's
  job, as is visual QA at 320/430/1024/1440px (375 and 768 are gated
  automatically). Folded into the pre-deploy checklist in the DoD below.

## v3.3 ledger — open

- Nothing. Findings 1–50 are closed or explicitly scoped above; 51 and 52
  are the process items answered by this README's ledger and the
  Definition-of-Done checklist below.

## Behavior changes to know about when upgrading

- Non-admin role managers must now scope new roles to a unit they manage.
  **Pre-existing org-wide custom roles need an administrator** to either
  rescope them or manage them going forward.
- Transfers revoke old-unit roles by default; keeping one is an explicit,
  re-validated `retain_role_ids` choice.
- Fifteen wrong passwords lock an account for the 15-minute window; the
  lockout lands in the audit log.
- Stale edits return `409` instead of last-writer-wins.
- Deactivated accounts disappear from the roster and every API surface.
- The JEPES page no longer shows an estimated composite score — that removal
  is the feature, not a regression. The official number is on MOL.
- Recommendation objects no longer carry a `gain` point value; they carry a
  `kind` ('data' | 'heuristic' | 'official') instead.
- `assignments.role` is retired: new writes store `''`, migration 005 blanks
  historical values, and billets' `default_role` only pre-fills the role
  suggestion in the Team dialog. Permissions come from role grants, full stop.
- A failed mid-session refresh keeps the last loaded data on screen behind a
  Retry banner rather than rendering everything empty.
- The `text-3` color token brightened in both themes to clear WCAG AA; muted
  metadata reads slightly lighter than before, deliberately.
- `Field` now wires labels to controls (`aria-labelledby`); custom inputs
  passing their own `aria-label` keep it. It also renders inline errors with
  `aria-invalid`/`aria-describedby` when a save is refused.
- Fresh-install bootstrap no longer writes the retired assignment role label
  (matches migration 005 everywhere).

## Backups, restore, and administrator recovery

**Backup.** Settings → Database (administrators only) downloads a consistent
snapshot of the live SQLite file; no downtime, and every download is written
to the audit log. Treat the file like the personnel data it is.

**Restore.** Stop the server. Replace the database file at the path shown in
Settings → Database (the `VANTAGE_DB` location) with the backup. Start the
server — migrations bring an older snapshot forward automatically. Never
restore a snapshot taken by a *newer* Vantage onto older code.

**Lost administrator.** On the deployment shell:

```bash
VANTAGE_RECOVERY=1 npm run recover -- <username>
```

It prints a one-time password exactly once, revokes every session the account
held, reactivates the account if needed, and writes an `admin_recovery` audit
row. It refuses to run without the flag, refuses to guess between multiple
administrators, and there is no in-app equivalent — recovery requires the
same shell access that could read the database anyway, which is the point.

---
## Rank decides the tool

Private through Corporal are on **JEPES** (MCO 1616.1). Sergeant and above —
SNCOs, warrants, officers — are on **fitness reports** (MCO 1610.7 series).
Vantage reads rank and switches: the area tags on every entry, the Readiness
page, and the narrative on Reports.

The two are different games, so the tool plays them differently. JEPES is a
composite you grind — four pillars, monthly recalculation, a cutting score,
and three quarters of it in your own hands. A FITREP is a document somebody
else writes: fourteen attributes marked by a Reporting Senior against every
Marine they have ever reported on. There is no score to grind, only the
quality of the evidence in front of the RS when the pen comes out.

So a Corporal gets a points-per-effort advisor. A Sergeant gets attribute
coverage across sections D–H, a reporting-period countdown, and a printable
input package. A leader viewing a Marine sees *that Marine's* track — a
Corporal team lead opening a Sergeant's record gets FITREP framing, because
that is what the Sergeant needs.

Tags carry across the boundary. A year of entries tagged with JEPES areas does
not turn into "Unassigned" the day you pin on Sergeant.

## The SOP is in the app

`/help` carries the full operating procedure — sixteen sections covering
logging, visibility, both evaluation tracks, roles, units, reports, data
handling and security posture, with a search box. It ships inside the tool so
it cannot drift from the version you are running.

## What changed from v2

v2 was a single-user tool that kept everything in one browser's IndexedDB.
v3 is a self-hosted, multi-user system with ranks, billets, units, and a real
chain-of-command visibility model.

| | v2 | v3.2 |
|---|---|---|
| Storage | IndexedDB, one browser | SQLite, hosted |
| Users | one | a whole section |
| Org model | none | ranks, billets, editable unit tree |
| Access | none | stackable roles, permission bits |
| Sharing | none | private / unit / chain |
| Evaluation | JEPES only | JEPES and FITREP, by rank |
| Reports | bullets | narrative, bullets, change report |
| Dashboard | fixed | collapsible, hideable, saved per user |
| Docs | README | searchable in-app SOP |

---

## Deploying it

One container, one process, one SQLite file on a mounted volume.

**Fly.io**

```bash
fly launch --no-deploy
fly volumes create vantage_data --size 1
fly deploy
```

**Render** — point it at `render.yaml`; the disk block is already there.

**Anything that runs Docker**

```bash
docker build -t vantage .
docker run -p 8080:8080 -v vantage_data:/data vantage
```

The first visit offers a one-time setup screen that creates the initial
administrator. Once a user exists, that route is closed permanently.

**The volume is not optional.** SQLite on an ephemeral filesystem means every
deploy silently wipes the section's records. If you take one thing from this
file, take that.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port. Platforms usually inject their own. |
| `VANTAGE_DB` | `vantage.db` | SQLite path. Point at the volume in production. |
| `NODE_ENV` | `development` | `production` turns on secure cookies and HSTS. |
| `TRUST_PROXY` | `true` | Set `false` only when there is no proxy in front. |

Back up by copying the file, or `fly ssh console -C "sqlite3 /data/vantage.db .dump"`.

**What production mode turns on:** secure `HttpOnly` `SameSite=Strict` cookies,
HSTS, a strict CSP with the inline theme script allow-listed by hash rather than
`unsafe-inline`, `X-Frame-Options: DENY`, login throttling at ten attempts per
IP per fifteen minutes, a `/api/health` probe that checks the database actually
answers, and graceful SIGTERM shutdown so a deploy doesn't leave a hot WAL.

For local work, `npm run dev` runs the API and Vite together with `/api`
proxied.

---

## Roles and permissions

Roles are rows, permissions are bits, and a Marine can hold several — the union
of them is what they can do. A role is granted **in a unit**, and `cascades`
decides whether it reaches the units beneath it. That one flag is the entire
difference between a fire team leader and a section head.

**Access comes from your role, not your rank.** A Sergeant running a fire team
outranks a Corporal in another section but has no business in that section's
records, and the model says so.

| Permission | What it allows |
|---|---|
| `VIEW_UNIT` | See the unit and its roster |
| `VIEW_RECORDS` | See shared work. Never covers anything marked private |
| `VIEW_MEMBER_DETAIL` | Open a Marine's record and pull their JEPES input |
| `MANAGE_RECORDS` | Correct someone's entry before a package goes up |
| `CREATE_SHARED_WORK` | Push tasks and projects to the unit |
| `CREATE_SHARED_GOALS` | Set goals the unit tracks against |
| `MANAGE_MEMBERS` | Add Marines and move them between units |
| `MANAGE_ROLES` | Create roles and hand them out |
| `MANAGE_UNITS` | Create and restructure units beneath this one |
| `VIEW_AUDIT` | Read the unit's access log |
| `EXPORT_DATA` | Pull the unit's records out as a workbook |
| `ADMINISTRATOR` | Everything, everywhere |

Ships with **Marine**, **Fire Team Leader**, **Training NCO**, **NCOIC**,
**Section Head** and **Administrator**. Make your own for anything else — a
Training NCO who should see PME across a section but open nobody's record is
two checkboxes, not a schema change.

Two rules keep this from being decorative, and both are enforced server-side:

- You cannot create, edit, delete or grant a role **at or above your own
  position**.
- You cannot grant a **permission you do not hold**.

Without the first, anyone who can manage roles promotes themselves to
administrator. Both have tests that try it.

### Units

Anyone with `MANAGE_UNITS` on a parent can create beneath it, so a section head
stands up their own fire teams without an administrator in the loop. Units are
archived rather than deleted, and archiving refuses while Marines or sub-units
are still attached.

Each record carries a visibility:

| Visibility | Who sees it |
|---|---|
| `private` | Only the owner. Not the team lead, not the section head |
| `unit` | Peers in that unit, plus leaders above |
| `chain` | That unit and everything beneath it |

A Marine's own work defaults to `chain`, which is how logged work rolls up into
a JEPES input without anyone chasing it. A leader posting a task at section
level with `chain` visibility pushes it down to every fire team.

**Every read of someone else's record writes an audit row.** A Marine can see
who has opened their record, on their own Settings page. That's deliberate: a
system that lets leaders read personnel data without a trace is one that
shouldn't hold personnel data.

Deletes are soft. A performance record that vanishes without trace is the
failure mode that gets a system thrown out of a shop.

---

## JEPES advisor

JEPES scores four pillars at 250 points each. **Three of the four are entirely
in the Marine's own hands** — rifle and MCMAP, PFT and CFT, MarineNet and
off-duty education — and only Command Input needs somebody else.

Marines routinely grind the one they don't control while leaving fifty free
points in a belt they never advanced. The Readiness page ranks every available
lever by points against effort and says which one to spend the next three
months on.

It estimates, and it says so. The official conversion is percentile-based
against your peer group in your grade and MOS, the tables differ between Lance
Corporal and Corporal, and HQMC republishes them. Your worksheet on MOL is
authoritative. Anything not entered reads as **unknown**, never as zero — "your
Warfighting is terrible" is a bad thing to tell someone whose rifle score simply
hasn't been typed in yet.

## Reports

**JEPES accomplishment narrative** — everything logged in the period, written as
professional prose, hard-capped at 1000 characters. It composes to a budget:
headline figures for each scored area first, then supporting detail round-robin
so one busy area can't starve the other two. What didn't fit is reported rather
than silently dropped.

**Bullet package** — three genuinely different styles. JEPES names the org and
system; FITREP strips filler the report header already carries; Résumé expands
acronyms on first use, because nobody outside the Marine Corps knows what a ULO
is. Truncation is always disclosed.

**Change report** — the current period against the equivalent window before it.
Fiscal quarters compare against fiscal quarters. Every figure carries its prior
value and the movement between them.

## The dashboard

Every section collapses to its title bar or hides entirely. The Display menu
lists them all; the chevron on each section collapses in place. Layout saves to
your account, so it follows you between the duty computer and your phone.

Collapsed and hidden are deliberately different: collapsed keeps the title bar
as a reminder the data exists, hidden takes it off the page until Display
brings it back. A clerk who never touches goals should not scroll past a goals
panel every morning.

Print any of them. The print stylesheet strips the app chrome, adds a masthead
with the reporting window, and keeps bullets and comparison rows from splitting
across pages.

---

## Org data

Ranks (E-1 through O-10, including warrant officers), billets, and the
MARFORRES tree ship as seed data and are re-applied on every boot, so a schema
change never loses them.

The tree covers MARFORRES down to Command Element → G-8 → FMRAC, with FHG,
4th MarDiv, 4th MAW and 4th MLG stubbed at the level where a unit administrator
takes over. Billets carry a `default_role`, so assigning someone as Fire Team
Leader gives them a fire team without anyone reasoning about permissions.

Both are database rows. A command that can't add its own billet titles stops
using the tool inside a week.

---

## Tests

```bash
npm test              # logic + API + scenario + security
npm run test:browser  # build, then drive the real UI in Chromium
```

- `tests/logic.test.mjs` — fiscal math, bullet composition, narrative ceiling,
  duplicate detection, JEPES estimation, track resolution and tag migration
- `tests/api.test.mjs` — auth, the permission boundary, privilege escalation,
  preferences, schema migration
- `tests/scenario.test.mjs` — a whole section, end to end
- `tests/security.test.mjs` — 49 deliberate attacks: role escalation through
  every route, transfer leakage, sessions outliving deactivation, CSRF,
  hand-built garbage requests, duplicate imports, stale overwrites, audit and
  export scoping, login throttling
- `tests/browser.test.mjs` — every route, failing on any console error
- `tests/browser-ui.test.mjs` — dashboard collapse and persistence, the SOP
- `tests/browser-track.test.mjs` — a real Sergeant and a real Corporal, proving
  the rank fork through the interface rather than through a unit test

At this commit: logic 82/82, api 49/49, scenario 16/16, security 49/49,
matrix 51/51, browser 57/57, browser-ui 13/13, browser-track 14/14,
a11y 12/12 pages, mobile 24/24 — ten suites, ~370 assertions, all wired
into `npm test` / `npm run test:browser`.

## V3.3 Definition of Done — status

Verified in this build, by the suite named:

- **Security** — escalation/IDOR/cross-unit/private-record leaks (security +
  matrix suites); server-side role enforcement, edit-escalation,
  transfer revocation, deactivation session-cut, session-cookie behavior,
  password-change invalidation, audit coverage (security suite).
- **Data** — validation, bulk limits, duplicate protection, concurrency
  (security suite); backup + restore procedure (this README, Settings →
  Database, proven recovery flow); migration versioning (001–005); project
  unlinking (security suite).
- **Organization** — assignment authority, role scope, billet/role clarity
  (migration 005), deactivation, transfer (security + matrix suites).
- **Evaluation** — reviewed against MCO 1616.1 / MCO 1610.7B / MCO 6100.13A /
  MCO 3574.2M (verified 2026-08-20, `src/lib/evalRefs.js`); MOS quals
  addressed without invented values; raw scores validated; heuristics
  labeled; no evidence presented as evaluation.
- **UX** — loading/error/retry states; inline field errors on every major
  form; draft protection on every form the roadmap listed (activities,
  quick log, member creation, role definitions); conflict dialogs on every
  record editor; mobile gate; a11y gate; permission explanations; access
  review.
- **Testing** — `npm test` (5 suites) and `npm run test:browser` (5 suites)
  pass; production `vite build` passes.

Not verifiable in this environment, honestly — the pre-deploy checklist:
the **Docker image build** and a **production smoke test against a deployed
instance** (deploy configs ship ready, `TRUST_PROXY=1`; check `/api/health`
reports 3.3.0), plus the manual accessibility pass (keyboard walk, screen
reader) and visual QA at 320px/430px/1024px/1440px. Everything else in the
roadmap's Definition of Done is enforced by the suites above.

The permission tests spend most of their effort trying to break in rather than
confirming things work. What they caught during this build:

- a leader seeing subordinates' **private** records through the list endpoint
- the same leak again through the member-detail endpoint
- a role able to grant a permission its holder didn't have
- Mental Agility scoring an empty profile as zero rather than unknown
- the app's own CSP blocking the app's own inline script
- dashboard layout lost when the page was reloaded inside the save debounce
- an old-shape database missing columns the new code queried, which would have
  broken the first deploy over an existing install
- `Date.parse` accepting 2026-02-31 by silently rolling it into March
- the transfer route dropping `retain_role_ids` on the floor (key-name
  mismatch), so "keep this collateral duty" quietly kept nothing
- unit-consistency refusals answering 400 where the older suite rightly
  expected an authorization 403

All have regression tests.

---

## Before real names go in it

Hosting this publicly puts other Marines' PII and performance data on a
commercial provider's infrastructure. That is outside any authorised system
boundary, and it needs your ISSM before real records go in — not because the
software is wrong, but because that decision isn't the developer's to make.

Built to make the answer *can* be yes: no third-party services, no telemetry,
one container and one file you control, role-gated access, an audit row on
every read of someone else's record, and soft deletes so nothing vanishes
without trace. Use it with your own data and test names freely.
