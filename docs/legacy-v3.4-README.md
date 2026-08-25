# Vantage v3.4.1-security.2

> **Security maintenance candidate.** This source implements remediation for the validated
> account-takeover, cross-unit member-detail, unsafe XLSX parsing, unrestricted
> top-level-unit creation, raw-session-token, global-role-metadata, and legacy
> billet-administration paths found in the v3.4.0 Phase 1 review. Source-only
> checks pass; dependency-backed API, migration, build, browser, accessibility,
> and mobile verification is still required before this candidate can be called
> release-ready. See `SECURITY-UPDATE.md`.
>
> Account-wide recovery now belongs only to the environment-configured
> **Instance Operator**. Unit leaders manage unit membership; they cannot reset
> or deactivate a multi-unit account. Production login is cookie-only, SQLite
> stores SHA-256 session digests, operator resets are temporary and force a
> password change, local passwords require 15 characters, and production
> first-run setup requires `VANTAGE_SETUP_TOKEN`.
>
> XLSX import/export was replaced with bounded CSV/TSV import and
> formula-neutralized CSV export because the npm `xlsx` release had unresolved
> security advisories. The default deployment mode is **evaluation**, which
> displays a persistent synthetic/authorized-test-data-only banner.

> **V3.4 Phase 1 — Tenancy.** A unit is now a sovereign boundary. Its roles,
> its members, its records, its audit log; nothing crosses without an explicit,
> audited act by someone inside it. Two units in the same database are
> strangers.
>
> No authorization decision reads the org chart — enforced by a static test
> that fails the build, not by discipline. `roles.unit_id` is `NOT NULL`, so
> there is no global role definition. An `ADMINISTRATOR` grant in one unit
> confers nothing in any other. `chain` visibility is gone from schema, API and
> UI. Personal scope is unreadable by every other principal including the
> Instance Operator. Migrations 006–009 are covered against a captured v3.3.0
> database with a permission oracle taken before any v3.4 code existed.
>
> **Read "Upgrading to v3.4" before running this against a v3.3 database.** The
> migration is one-way, it reduces visibility on purpose, and it deliberately
> declines to carry one v3.3 permission forward.
>
> This candidate adds explicit owner succession, controlled enrollment of an
> existing account, temporary guest expiry, frozen originating-unit history,
> and stronger per-unit audit receipts. Formal share packages, authoritative
> per-record classification, retention automation, and an approved enterprise
> identity adapter are not in this build.
> v3.3's ledger and its open items are still below, and **"Before real names go
> in it" still applies** — Phase 3's Minimal mode is what changes that answer.

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
  that moves the assignment, authorization is recomputed from live membership
  on every subsequent request, originating-unit shared records are frozen, and
  the default role follows to the new unit. Other-unit sessions remain valid;
  a unit-local reassignment is not account-wide session authority.
  `retain_role_ids` exists for
  legitimate collateral duties — and each retention re-runs the full grant
  check, so "retain" cannot keep alive a role the actor couldn't grant.
- **3 — sessions, end to end.** Server side landed in 3.2.1 (true session
  cookie, 60-min idle / 12-hr absolute). This build finishes the client half:
  the browser stores **no token at all** — the HttpOnly cookie is the
  credential, every request carries the `x-vantage-client` CSRF header, and a
  non-sensitive presence cookie lets a signed-out page skip the boot probe.
- **4 — account deactivation.** Instance-Operator-only deactivate / reactivate endpoints; a
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
- **16 — password change.** `POST /api/me/password` verifies the current
  password, requires a different 15-character-or-longer replacement, keeps
  this session, and revokes the rest. An Instance Operator reset revokes every
  session and marks the new password temporary; all other API routes remain
  blocked until the account holder replaces it.
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
  `EXPORT_DATA`, exports that exact unit, and **never** includes private or
  personal records.
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
  "peers as well as your leaders." The copy now matches the code: unit means
  current members of that exact unit. The retired `chain` scope is not offered.
- **31 — backups in the product.** Settings → Database (Instance-Operator-only): size,
  schema version, last backup, and a one-click consistent snapshot taken
  while the server keeps running (`better-sqlite3` backup API). Every
  download is audited. The restore procedure is documented below.
- **32 — administrator recovery, documented and auditable.** `VANTAGE_RECOVERY=1
  npm run recover -- <username>` on the deployment shell resets the account
  to a printed one-time password, revokes every session it held, and writes
  an `admin_recovery` audit row. No backdoor: it requires shell access and an
  explicit per-invocation flag, and it cannot run silently.
- **35 — failed saves stop costing work.** The activity editor mirrors
  unsaved edits into account-scoped session storage keyed to the record and the version they
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
  panel for the Instance Operator — roles held (orphaned
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

- The original v3.3 finding numbers are implemented or explicitly scoped
  above, but this security candidate still has release and product work:
  dependency-backed verification, an approved enterprise identity adapter,
  formal cross-unit share packages, per-record classification and retention,
  managed operational monitoring, and an authorized hosting boundary. The
  security review and MCEN readiness plan are authoritative for those items.

## Upgrading to v3.4 — read this before you run it

v3.4 changes what Vantage *is*. v3.3 made one command's instance defensible;
v3.4 makes a unit a sovereign boundary, the way a Discord guild is. Two units
in the same database are strangers. That is an architectural break, not an
increment, and the migration is one-way.

**Take a backup first.** `GET /api/admin/backup`, or copy the `.db` file with
the server stopped. Migrations 006 and 007 rewrite the roles table and record
visibility; migration 008 digests stored session credentials and adds the
temporary-password-change flag; migration 009 canonicalizes usernames and
enforces role/grant unit consistency. There is no down-migration. Migration
009 refuses startup if legacy usernames collide case-insensitively so an
operator can resolve the identity ambiguity deliberately.

### The three things that change under you

**1. Hierarchy stops conveying authority.**

`parent_id` and the L1–L4 levels still describe the org chart, and Vantage
still draws it. They no longer grant anything. A battalion sees nothing from a
company unless the company sent it. Concretely: a role granted at a parent unit
used to cascade over every unit beneath it, and that expansion is gone.

Migration 006 does not simply drop those grants — it **materialises** them.
Every permission a cascading role was computing at read time becomes an
explicit grant row in each unit it reached, so nobody loses access on upgrade.
What you gain is that those grants are now visible and revocable one unit at a
time, instead of implied by a tree.

**2. `chain` visibility is deleted, and this hides things.**

`chain` meant "the unit and everyone above and below it," and it was the
**default** on activities, recognitions and trainings. A Marine logging work
with the default setting was publishing it up and down the org chart without
ever deciding to.

Migration 007 rewrites every `chain` row to `unit`. This is a visibility
*reduction*: it cannot leak, it can only hide something that used to be visible
to somebody outside the owning unit. **Tell your users before you upgrade.** A
leader two levels up who could see a Marine's logged work on Monday will not
see it on Tuesday, and that is correct — but it will look like data loss if
nobody warned them. Nothing is deleted; the records are in their own unit.

The planned upward-sharing workflow has someone inside the owning unit generate
a share package. That must be a deliberate act with a recipient, purpose,
expiry, timestamp, and audit row; it is not implemented in this candidate.

**3. There is no cross-tenant administrator any more.**

In v3.3, an `ADMINISTRATOR` grant in one unit conferred every permission in
every unit in the database, and legacy `users.is_admin` did the same. Any unit
handing out its own Administrator role handed out read access to every other
shop's personnel records. That is deleted.

It is replaced by two things that are *not* permission bits:

| | Unit Owner | Instance Operator |
|---|---|---|
| Scope | One unit, completely | The container |
| Stored as | `units.owner_user_id` | `VANTAGE_OPERATOR_ID` env var; username fallback supported |
| Can | Everything inside that unit | Issue accounts, recover a lost owner, back up, read instance operations |
| Cannot | Reach any other unit | Read unit records silently, or read personal scope at all |
| Revoked by | Ownership transfer only — no role edit can remove it | Restarting the process with a different value |

**This is the one place migration 006 deliberately does not preserve a
permission.** Carrying the fan-out forward would mean writing an administrator
grant into every unit, which is precisely the leak. Instead your administrator
becomes Unit Owner of every unit they were actually a member of, keeps every
unit-scoped permission they held, and loses reach into units they were never
in. What was dropped is counted in `meta.migration_006_report` and written to
the instance audit — check it after upgrading:

```sh
sqlite3 vantage.db "SELECT value FROM meta WHERE key='migration_006_report';"
```

If you genuinely need instance-wide operations, prefer immutable account UUIDs
in `VANTAGE_OPERATOR_ID`. After the first account exists, copy its UUID from
the database into deployment configuration and restart. `VANTAGE_OPERATOR`
remains a case-insensitive compatibility fallback:

```sh
VANTAGE_OPERATOR_ID=<account-uuid> node server/index.js
```

An operator is designated by environment variable rather than a database row on
purpose: a row can be written by anything that can write to that table, while
an environment variable can only be changed by whoever can restart the process
— which is the correct authority for "who runs this box." No SQL injection,
role edit or invite redemption can mint one.

### After the migration

Some units may come out **ownerless**. Migration 006 will only promote someone
who was already administering a unit — held both `MANAGE_ROLES` and
`MANAGE_MEMBERS` there — because promoting anyone else would hand out authority
the migration invented. Units with no such person are left ownerless on purpose
and listed in `left_ownerless` in the report. An Instance Operator claims each
one:

```
POST /api/org/units/:unitId/claim
{ "owner_user_id": "<user id>", "template_id": "section" }
```

This refuses a unit that already has an owner. Reassigning a live unit is a
different operation with a different consent story, and merging the two would
make this a quiet takeover primitive.

### Roles are now per-unit copies

`roles.unit_id` is `NOT NULL`. There is no such thing as an org-wide role
definition, so two SNCOICs at two commands can finally have a "Training NCO"
that means different things — under v3.3 editing one edited both.

Migration 006 forks every global role: for each unit holding a grant against
it, a unit-local copy is created and the grants are repointed. No role with
live grants is ever deleted. Expect your role list to get longer and your role
ids to change shape (`G8-FMRAC:sncoic` rather than `section-head`); anything
scripted against a role id needs updating.

`is_system` now means only "this row came from a template." It confers no edit
protection — the owning unit may rename, re-colour, re-permission or delete any
of its own roles. New units ship **three** roles plus an Owner (Marine, NCO,
SNCOIC) rather than six; the full twelve-bit editor is unchanged and one click
away, but a SNCOIC should never have to open it.

### Two new scopes worth knowing

**Personal** — `unit_id IS NULL`, readable by its author and nobody else,
ever, including the Unit Owner and the Instance Operator. It is where a Marine
keeps their own running log before, between or outside any unit, and it is
excluded from exports and share packages by predicate rather than by
convention. A Marine with no unit at all can still record everything.

**Guest** — ordinary membership with `kind = 'guest'` and a required expiry,
carrying a normal unit-local role. Built as membership rather than a parallel
authorization path so that every existing permission check already covers it
and no second code path can drift. Guests are bounded by the sharing
permissions that members and owners are exempt from, because a guest is in the
unit by invitation with a narrow role.

### What still works exactly as before

Everything inside one unit. If you run a single shop, the only differences you
will notice are the visibility reduction, the shorter default role set, and
that your administrator is now called an Owner.

## Behavior changes to know about when upgrading (v3.3)

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

## Backups, restore, and Instance Operator recovery

**Backup.** Settings → Database (Instance Operator only) downloads a consistent
snapshot of the live SQLite file; no downtime, and every download is written
to the audit log. Treat the file like the personnel data it is.

**Restore.** Stop the server. Replace the database file at the path shown in
Settings → Database (the `VANTAGE_DB` location) with the backup. Start the
server — migrations bring an older snapshot forward automatically. Never
restore a snapshot taken by a *newer* Vantage onto older code.

**Lost Instance Operator account.** On the deployment shell:

```bash
VANTAGE_RECOVERY=1 npm run recover -- <username>
```

It prints a one-time password exactly once, marks it for mandatory replacement,
revokes every session the account held, reactivates the account if needed, and
writes an `admin_recovery` audit row. It refuses to run without the flag,
refuses to guess between multiple configured operators, and there is no in-app
equivalent — recovery requires the same shell access that could read the
database anyway, which is the point.

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

| | v2 | v3.4 |
|---|---|---|
| Storage | IndexedDB, one browser | SQLite, hosted |
| Users | one | a whole section |
| Org model | none | ranks, billets, editable unit tree |
| Access | none | stackable roles, permission bits |
| Sharing | none | personal / private / exact unit; no hierarchy cascade |
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

**Render** — point it at `render.yaml`; the disk block and generated setup
secret are already declared. Use `VANTAGE_OPERATOR` only for first bootstrap,
then bind `VANTAGE_OPERATOR_ID` to the resulting immutable account UUID.

**Anything that runs Docker**

```bash
docker build -t vantage .
docker run -p 8080:8080 -v vantage_data:/data \
  -e VANTAGE_SETUP_TOKEN='<at-least-24-random-characters>' \
  -e VANTAGE_OPERATOR='<bootstrap-username>' \
  -e VANTAGE_DATA_MODE=evaluation vantage
```

The first visit offers a one-time setup screen that creates the initial
operator account. In production the screen also requires the deployment secret
from `VANTAGE_SETUP_TOKEN`. Once a user exists, that route is closed.
After setup, read the new account UUID from `/api/me`, replace the username
fallback with `VANTAGE_OPERATOR_ID`, and restart.

**The volume is not optional.** SQLite on an ephemeral filesystem means every
deploy silently wipes the section's records. If you take one thing from this
file, take that.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP port. Platforms usually inject their own. |
| `VANTAGE_DB` | `vantage.db` | SQLite path. Point at the volume in production. |
| `NODE_ENV` | `development` | `production` turns on secure cookies and HSTS. |
| `TRUST_PROXY` | `1` in production | Number of trusted proxy hops. Set `false` only when directly exposed. |
| `VANTAGE_SETUP_TOKEN` | none | Required in production before an empty database can be initialized; minimum 24 characters. |
| `VANTAGE_OPERATOR_ID` | none | Preferred comma/space-separated immutable account UUIDs for instance recovery, account issuance, and backups. |
| `VANTAGE_OPERATOR` | bootstrap fallback | Compatibility bootstrap using canonical usernames; replace with `VANTAGE_OPERATOR_ID` after setup. |
| `VANTAGE_DATA_MODE` | `evaluation` | `evaluation` displays the controlled-test-data banner; use `operational` only after authorization. |
| `VANTAGE_IDLE_MINUTES` | `60` | Local-password inactivity timeout (minimum 5 minutes). |
| `VANTAGE_SESSION_HOURS` | `12` | Absolute local-password session lifetime (minimum 1 hour). |
| `VANTAGE_MAX_SESSIONS` | `8` | Maximum concurrent local-password sessions per account. |
| `VANTAGE_MUTATIONS_PER_15_MINUTES` | `240` | Authenticated state-changing requests allowed per account per 15 minutes. |
| `VANTAGE_MAX_RECORDS_PER_USER` | `10000` | Per-account record ceiling, including soft-deleted history. |
| `VANTAGE_MAX_DB_BYTES` | `786432000` | Refuse record growth after the SQLite database reaches this high-water mark. |
| `VANTAGE_MAX_GUEST_DAYS` | `30` | Maximum duration of a temporary guest enrollment. |

Back up through Settings as the Instance Operator, or copy the file only while
the server is stopped. Treat every backup as the same sensitivity as the live
database and keep it only in approved encrypted storage.

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
of them is what they can do. A role is granted **in a unit**, and it applies
**in that unit and nowhere else**. There is no cascade: reaching into another
unit requires a grant in that unit. (v3.3 had an `inherits_down` flag that
expanded a grant across a subtree; v3.4 removed it, because a battalion should
not acquire a company's records by sitting above it on an org chart.)

Every role belongs to exactly one unit. Units get their roles by **copying a
template** at creation, and the copies diverge immediately and permanently — so
two commands can each have a "Training NCO" that means what they need it to
mean.

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
| `MANAGE_UNITS` | Rename this unit and create sub-units under it |
| `VIEW_AUDIT` | Read the unit's access log |
| `EXPORT_DATA` | Pull this unit's shared records out as a CSV |
| `ADMINISTRATOR` | Everything — **inside this unit only** |

A new unit ships with **Marine**, **NCO**, **SNCOIC** and an **Owner**. A
section is eight to twenty Marines with one SNCOIC and two or three NCOs; six
roles and a twelve-bit editor is a correct piece of engineering aimed at a
problem most units do not have on day one. The full editor is unchanged and one
click away, and other templates ("Section with Training NCO", "Company", "Just
me for now") are selectable at creation. A Training NCO who should see PME
across a section but open nobody's record is still two checkboxes.

Two rules keep this from being decorative, and both are enforced server-side:

- You cannot create, edit, delete or grant a role **at or above your own
  position in that unit**. Position is a per-unit scale — position 30 in one
  shop has no relationship to position 30 in another.
- You cannot grant a **permission you do not hold in that unit**.

Without the first, anyone who can manage roles promotes themselves to
administrator. Both have tests that try it.

### Units

**Only the Instance Operator can stand up a top-level organization.** Allowing
any authenticated account to mint an unlimited sovereign tenant created an
uncontrolled directory and ownership boundary. A new command should be
onboarded through an approved operator/invitation workflow; unit leaders can
still create sub-units beneath units they manage.

Creating a **sub-unit** still needs `MANAGE_UNITS` in the named parent — not
because the tree conveys authority, but because naming a unit as your parent is
a claim about *their* org chart.

Units are archived rather than deleted. Archiving refuses while sub-units or
other members remain attached; a sole Unit Owner may close an otherwise empty
unit, which freezes its shared history and clears ownership in one transaction.

### Membership

Membership is **stated**, not inferred. `unit_members` answers "is this person
in this unit"; `assignments` keeps billet, dates and history and no longer
answers membership questions. That separation is what makes a Marine in two
units, a member holding no billet, and an ended assignment that should still
read as history all expressible — none of which v3.3 could say.

A grant without a membership row confers nothing, and the API refuses it rather
than accepting it quietly.

Each record carries a visibility:

| Visibility | Who sees it |
|---|---|
| `personal` | Only the owner; no unit is attached and it is excluded from unit exports |
| `private` | Only the owner, while retaining an exact-unit association |
| `unit` | Current members holding the required permission in that exact unit |

A Marine's logged work defaults to `unit`. Nothing travels to a parent,
sub-unit, sibling, or headquarters through the org chart. Cross-unit or HQ
roll-up must use an explicit, audited share package when that workflow lands.

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
takes over. Removing a membership ends live assignments and role grants in
that unit, freezes shared records as originating-unit history, and retains
unrelated sessions because authorization is re-evaluated on every request. It
does not deactivate or reset the global account.

Both are database rows. A command that can't add its own billet titles stops
using the tool inside a week.

---

## Tests

```bash
npm test              # static + hardening + logic + API + scenario + security + matrix + tenancy + migration
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

These boundary suites each exist for a reason the others cannot
cover:

- `tests/static.test.mjs` — **grep with a grudge.** Every other suite here is
  behavioural, which is the right way to test a decision and the wrong way to
  hold a boundary: a behavioural test proves the unit tree is not read *today*,
  by the paths it happens to exercise. It cannot stop a subtree walk appearing
  in a route written six months from now, because that route arrives with its
  own passing test. So this one reads source and fails the build if `parent_id`,
  `subtreeIds`, `ancestorIds` or `ancestorChain` turns up in an authorization
  module. It strips comments and string literals first, so the suite can survive
  its own documentation.
- `tests/hardening-static.test.mjs` — pins the v3.4.1 boundaries without any
  third-party package: cookie-only production login, digested sessions,
  operator-only account lifecycle and top-level creation, scoped member
  detail, atomic visibility/unit writes, the absence of XLSX, protected setup,
  and non-cacheable API responses.
- `tests/tenancy.test.mjs` — for every endpoint, tries to reach Unit B's data
  while holding **every** permission in Unit A, with Unit B sitting under Unit A
  on the org chart so that every v3.3 instinct would let it through.
- `tests/migration.test.mjs` — runs migrations 006–009 against a **captured
  v3.3.0 database**, not a synthetic one, and replays a permission oracle taken
  from v3.3.0's own code before any v3.4 code existed. See
  `tests/fixtures/README.md`.

Current verification results belong in `SECURITY-UPDATE.md`; do not treat old
point-in-time counts in an earlier release as proof for this source tree. A
release is ready only when the dependency-backed API, migration, build, browser,
accessibility, and mobile suites have been rerun in the build environment.

The matrix suite carries **13 rows whose expectation was deliberately
reversed** by v3.4. Each keeps its v3.3 assertion inline as `was:` with the
finding that changed it, per the roadmap's instruction not to delete a security
test to make it pass. A bare "deny" tells a reader what the system does; "deny
— was allow under finding 2" tells them it used to do the opposite and somebody
decided otherwise. If a future change flips one back, the diff shows a v3.3
expectation being restored, which is the moment to stop.

## Release verification status

The source-only syntax and security-invariant checks that do not need installed
packages pass in the review environment. Dependency-backed API, migration,
tenancy, production build, browser, accessibility, and mobile suites could not
run there because the supplied archive did not include `node_modules` and the
package registry was unavailable. See `SECURITY-UPDATE.md` for the exact
commands and evidence. Do not promote this source to production until those
suites, a container build, and a deployed smoke test all pass.

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

Built to make an authorized deployment achievable: no built-in analytics or
advertising telemetry, one container and one database, role-gated access, an
audit row on every member-detail read, and soft deletes so records do not
vanish without trace. Until the hosting boundary and data use are approved,
use synthetic data or specifically authorized evaluation data only.
