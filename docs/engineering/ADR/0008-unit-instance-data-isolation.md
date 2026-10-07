# ADR-0008 · The Unit Instance is a backend security boundary

**Status:** accepted · **Date:** 2026-10-07 · **Builds on:** [ADR-0006](0006-centralized-tenancy-and-authority.md), [ADR-0007](0007-mcen-enterprise-deployment-and-unit-instances.md)

## Context

ADR-0006 made the tenant a row in `organizations`; ADR-0007 named that tenant a **Unit Instance** and
set MCEN as the production target. Both left the boundary itself implicit: authorization is decided
per unit, from the permission bits `scopeFor` computes for each unit a person stands in. For anyone
who serves in one Unit Instance that is already airtight, because the only units in their scope are
its units.

It is not airtight for two cases, and an inspection of every data-access path (routes, services, SQL)
found both:

1. **A person who stands in two Unit Instances.** A Marine attached to two commands, or a leader who
   also founded a unit of their own, holds real authority in each. Every check of the form "does this
   person hold this permission in this unit?" passes on both sides, so a *pair* of units from
   different instances satisfies both halves of a two-unit operation: moving a Marine from a team in
   one into a team in the other (and, with it, their entries), enrolling someone led in one directly
   into the other, re-placing another Marine's record from one into the other, or taking a primary
   unit in one by enrolling in the other.
2. **A reference carried by id.** Where a row names another row by id — `project_id` on an activity, a
   task or a queue item, `contact_id` on a thread, a `thread_links` row, an imported source file, a
   record cited by a report revision — the id was checked for readability but not for which instance
   it belonged to. The person submitting it may legitimately read both sides (case 1), so readability
   alone let one instance's row become part of another's.

Neither case is a privilege escalation in the permission model. Both move or disclose one Unit
Instance's data inside another, which is what the boundary exists to prevent, and MCEN hosting makes
the consequence concrete: the data belongs to the command, not to the service.

## Decision

### 1. The boundary is checked where two units meet

`sameInstance(ctx, a, b)` and `assertSameInstance(ctx, a, b, message)` live beside the permission
helpers in `server/authz/scope.ts` and read `units.org_id`. A unit with no organization matches
nothing. Where either side has no unit, nothing is across the boundary: a person's own unplaced
record belongs to no instance.

Every operation that names two units, or a unit and a row from another unit, asserts it:

| Operation | Rule |
|---|---|
| Moving a Marine between teams (`moveMember`) | both teams in one Unit Instance, checked after authority over both, so someone who manages neither learns nothing about which units belong together |
| Enrolling an account directly (`mayEnrollDirectly`, the directory, `POST members`) | the actor must lead them in a unit of the destination's own instance |
| The primary unit (`addMember`, `PUT members/:userId`, the fallback in `removeMember`, the personnel feed's restore) | enrollment or departure in one instance never takes or moves the primary unit held in another; the refusal does not say where it is held; a feed that moved a primary unit when a Marine left its roster gives it back when they return |
| An entry, task or queue item filed under a project (`assertFileableProject`) | the project's unit and the row's unit in one instance, checked on create, on edit and when the row moves |
| Moving a project (`updateRecord`) | only where everything filed under it can follow: a project with another person's work filed under it stays in that work's instance |
| Re-placing a record somebody else wrote (`updateRecord`) | a record manager or counselor may correct and re-place it inside its own instance only; only its Marine takes it out of every unit, so "out, then across" is not a way round; a record placed nowhere is placed only in an instance its Marine serves in |
| Moving one's own record to another instance (`updateRecord`) | refused while it carries anyone else's comments or attachments, or anyone else's work filed under it; both instances' trails record the move without naming the other side |
| A contact on a thread, a thread or contact moved, a thread linked to work (`correspondence`) | one instance, from both ends: a contact stays where the threads naming it are; a thread shows only links to work its reader may open |
| Importing an uploaded sheet (`previewImport`) | a file shared with a unit is imported only into its own instance |
| A report revision's citations, and the sources offered (`reportStudio`) | a report placed in a unit cites only that instance's records; a report about another Marine placed in no unit cites one instance's records |
| A report or export asked for against another Marine's unit (`reportTarget`) | it falls back only to a unit the caller leads them in inside the requested unit's instance; with none there it is refused, never answered with another instance's figures |
| Linking an EDIPI (`POST /api/orgs/:orgId/personnel/link`) | refused for another account that serves in another instance or holds a platform role, because the EDIPI is the CAC sign-in key; a changed EDIPI ends that account's sessions |
| The personnel feed (`personnel.ts`) | never renames or deactivates an account that holds a platform role |
| Importing an instance archive (`importInstance`) | refused whole if, once loaded, it joins records across instances (`instanceBoundaryViolations`) |

Refusals carry the code `cross_instance`, so a client can tell them from an ordinary permission
refusal. Two deliberately do not, because the code itself would tell the caller something: direct
enrollment keeps `invite_required`, which it already answered for anyone not led by the caller, and
a refused primary unit is a plain `forbidden` that does not say the Marine serves elsewhere.

**What stays allowed.** A person who stands in two Unit Instances still works in both: they read and
write each instance's data with the authority they hold there, and they may re-place **their own**
records among the units they belong to, including across instances, because the record is theirs and
both placements are ones they hold rights in. What they cannot do is carry anybody else's data, or a
reference to it, from one instance into the other.

### 2. The database keeps the boundary as a second line

Migration `016_unit_instance_isolation` adds triggers (`instanceBoundaryTriggers` in
`server/db/index.ts`) that refuse, in the engine:

- a change to `units.org_id` once it is set (`units_org_immutable`), beside the existing
  `units_stay_in_org`, which refuses a parent in another instance;
- an `activities`, `tasks` or `work_items` row filed under a project whose unit is in another
  instance, on insert and on update, and a project moving to an instance other than the work filed
  under it;
- a thread naming a contact from another instance, and a contact moving away from the threads that
  name it;
- a `thread_links` row joining a thread and a queue item in different instances, on insert and on
  update, and either end of a link moving away from the other.

They are defense in depth, not the mechanism: authorization is decided in the server, and the triggers
exist so that a defect or a hand-written statement cannot quietly cross the boundary. They refuse only
a pairing that is really across it: two units whose organizations are both known and differ (`<>`,
which is not true when either side is NULL). A row with no unit is left alone, a unit an archive has
not yet given its organization is not taken to differ, and a reference to a row that is not in the
database yet passes, because an archive is restored table by table; `importInstance` therefore checks
the whole archive once it is in. An update is checked only when it changes the reference or a unit,
so a row joined across before this migration can still be edited.

Each trigger's message begins `cross_instance:`. The API answers such an engine refusal as a 403 with
the code `cross_instance`, not a server error, and writes `cross_instance_refused` to the audit trail
with who asked, so a request that only the engine stopped is still seen.

The migration runs in the runner's transaction, creates its triggers with `IF NOT EXISTS`, and changes
no row. Rows already joined across the boundary when it runs are left as they are, so nothing is lost,
and counted by kind into `meta.instance_boundary_violations`, so an operator can find them. A
single-instance database, which is every database before ADR-0006's organizations, cannot hold one.

### 3. PostgreSQL row-level security: evaluated, deferred to the PostgreSQL work

The specification names RLS as defense in depth "if appropriate". It is appropriate, and it cannot be
built yet:

- RLS is a PostgreSQL feature. SQLite has no equivalent. The repository runs on `better-sqlite3`, and
  PostgreSQL is a staged plan that is not implemented ([ADR-0003](0003-postgresql-migration-path.md)).
- Writing RLS policies now would mean writing them against a schema the PostgreSQL migration set does
  not yet produce, with no way to run or test them. Untested security policy is worse than none,
  because it reads as a control that is in place.
- The equivalent the engine does offer today is triggers, which is what section 2 uses.

When ADR-0003 step 3 lands the PostgreSQL adapter, the policy is: every table carrying `unit_id` or
`org_id` gets `ENABLE ROW LEVEL SECURITY` with a policy keyed on a session variable the request sets
from the authenticated scope, the application role is not the table owner (so it cannot bypass
policies), and the test suite in step 4 runs the negative tests of
`tests/server/unitIsolation.test.ts` against both engines. Carrying the triggers of section 2 to
PL/pgSQL is already part of step 3.

## Consequences

- `tests/server/unitIsolation.test.ts` is the proof the specification asks for: two Unit Instances, a
  Marine in each, and a leader with real authority in both. It covers personnel, records and ids,
  attachments, reports, exports, metrics and dashboards, imports, correspondence, Report Studio,
  membership moves and enrollment, the audit trail, and the database triggers.
- One behavior changed. A leader who creates a top-level unit of their own founds a new Unit Instance,
  and could previously enrol a Marine they lead elsewhere into it directly. That is now an enrollment
  across the boundary: the Marine joins by invitation or join code, as anyone outside an instance
  does. `tests/server/securityHardening.test.ts` records both halves of this rule.
- An archive written before this ADR by a multi-instance deployment could, in principle, carry a
  cross-instance project link, contact or thread link. Importing it is refused whole, with the
  crossings it found, rather than loading data the boundary forbids. A single-instance archive, which
  is every archive the legacy format can hold, cannot contain one, and still restores.
- `reportTarget` no longer answers a unit id from another instance with the caller's own unit. Within
  one instance it still falls back as before.
- An organization's administrator can no longer link or change the EDIPI of an account that also
  serves in another Unit Instance or runs the service. That account links its own EDIPI by signing in
  with its CAC; who may change it otherwise is part of shared-account governance below.
- A view with no unit, such as a person's own metrics across everything they may read, counts what
  they can read in each instance they serve in. It is shown only to them and stores nothing, so
  nothing crosses; every view, report or export for a unit carries that unit's instance only.

## Found in review, and left for later Tasks

The code and security reviews of this decision found ways across the boundary that the first cut
missed; each is closed above and proved in `tests/server/unitIsolation.test.ts`. They also found
issues that are real but belong to other work, recorded here so they are not lost:

- **Shared-account governance (Task 3).** An account that serves in two instances is still one
  account: either instance's owners can sign it out, and Vantage support resets its credentials. Who
  may change its profile, EDIPI or sessions, and how both instances are told, is a policy decision for
  the role and access work. Within one instance, an administrator linking an EDIPI to a member's
  account is still a powerful act; it is audited and ends that account's sessions.
- **Audit append-only and an external anchor (Task 7).** The chain detects a rewrite by anyone without
  `VANTAGE_SECRET` and syslog keeps a copy outside the server. Truncating the tail together with the
  head, and append-only triggers on `audit_log`, wait for the audit work, because the synthetic demo
  database deletes and reseals audit rows today. An instance import names its actor in the entry's
  detail rather than its actor field.
- **Smaller items.** Support's delivery log lists emails across instances (Task 7, with audit and
  support access). Unit codes are one namespace, so a taken code says a unit with it exists somewhere.
  A Marine importing their own copy of a shared sheet with no unit is allowed: it becomes a private
  record of theirs.
- Isolation is enforced per unit **and** per instance, so the cost is one `units.org_id` lookup on the
  paths above. `idx_units_org` already exists; the lookups are by primary key.
