# ADR-0017 · Personnel records: one structured record per Marine, its history kept by the database, changed one at a time or in bulk

**Status:** accepted · **Date:** 2026-10-22 · **Builds on:** [ADR-0008](0008-unit-instance-data-isolation.md),
[ADR-0009](0009-identity-and-unit-membership.md), [ADR-0010](0010-vantage-administrator-and-unit-manager.md),
[ADR-0012](0012-unit-manager-console.md), [ADR-0013](0013-security-audit-least-privilege.md),
[ADR-0015](0015-core-record-architecture.md), [ADR-0016](0016-information-architecture.md)

## Context

Task 11 of the governing specification (VANTAGE_CLAUDE_MASTER.md) is the personnel management redesign, at P0:
"Personnel should become a structured administrative source of truth." It lists rank, grade, MOS, billet, primary
unit, secondary unit, team or fire team, supervisor, leadership chain, Vantage roles, functional responsibilities,
account status, check-in, assignment start and end, training, education, awards, counseling, duty, goals and
work/performance links, and asks that history be preserved and bulk operations supported.

What main held before this Task (at `34600b6`):

- **Who the Marine is** lived on `users`: name, rank (grade from `ranks`), MOS and EAS, set by the person, by a leader
  (PUT /api/org/team/:id/profile) or by the personnel feed (`personnel_roster`, ADR-0009). Changes left nothing but
  the audit trail. The leader route did not honour the feed's fields, which the person's own route refused.
- **Where they serve** lived on `unit_members`: unit, primary flag, billet as free text, the day the account joined.
  `unit_membership_periods` kept every stretch of a membership, written by triggers (ADR-0009). Teams and fire teams
  are units of those echelons. A secondary unit is any membership that is not primary.
- **Billets** were a Unit Instance catalogue (`unit_billets`, ADR-0012), matched to holders by title only.
- **Roles** were `member_roles`, `org_roles` and `platform_roles` (ADR-0010). Account status was shown only in the Unit
  Manager console.
- **Records** (training, education, awards, counseling, goals, tasks, activities) were on the Marine page, read by the
  rules ADR-0015 kept. Duty is logged as an Operations activity until Task 17.
- **Nothing** held a supervisor, a leadership chain, a functional responsibility, a check-in date, or when an
  assignment began and is due to end. The roster had no bulk actions.

## Decision

### 1. The record and where each part lives

| Fact | Where | Per |
| --- | --- | --- |
| Name, rank, grade, MOS, EAS | `users` (grade from `ranks`) | person |
| Account status | `users`: active, locked, never signed in, must change password, deactivated; a second factor (authenticator or passkey) and CAC proven | person |
| Unit, primary or secondary, team / fire team | `unit_members`, units by echelon; the deepest is their team | membership |
| Billet | `unit_members.billet_id` → `unit_billets`, with `billet` keeping the title | membership |
| Assignment start and end | `unit_members.assignment_start`, `assignment_end` (calendar days) | membership |
| Supervisor, check-in | `personnel_records` (org_id, user_id) | person per Unit Instance |
| Functional responsibilities | `personnel_responsibilities`, ended and never deleted | person per Unit Instance |
| Leadership chain | derived: the supervisor chain upward, then the seated leaders of their primary unit and above | person per Unit Instance |
| Vantage roles | `member_roles`, `org_roles` (unchanged) | membership / Unit Instance |
| Training, education, awards, counseling, duty, goals, work | their own tables (unchanged, ADR-0015); the record counts and links them | person |
| History | `unit_membership_periods` (unchanged) and `personnel_events` (new) | person |

A supervisor and a check-in belong to a Unit Instance, not a unit: a Marine moved between teams keeps them, and one
who serves in two instances answers to a supervisor in each. A billet and assignment dates belong to the membership.

**Being someone's supervisor confers nothing.** Neither does a place in the leadership chain or a responsibility.
What a person may read or change is still decided by the roles they hold (ADR-0010, ADR-0013). An informational
field set by those who manage the roster never becomes a grant.

### 2. History is written by the database (migration 024)

As ADR-0009 did for memberships, triggers write `personnel_events`, so every path that changes a fact leaves its
history: the person, a leader, the personnel feed, Vantage support, an import or a script.

- `personnel_profile_changed`: rank, MOS, EAS and account status (active or deactivated) on `users`, with `org_id`
  NULL, since they are the person's wherever they serve. A name is not tracked: it is the person, not a personnel
  fact, and the audit trail already says who changed it.
- `personnel_record_opened` and `personnel_record_changed`: supervisor and check-in.
- `personnel_assignment_dated`: assignment start and end on a membership; `personnel_assignment_opened` (migration
  025) records the dates a membership is created with, as set from nothing, so a script that inserts one dated leaves
  its history too.
- Billet and primary-unit changes stay in `unit_membership_periods`, as before.

The service then names who made each change, how (`source`: self, leader, feed, support, departure), why (`reason`,
optional, up to 200 characters) and the bulk change it belongs to (`batch_id`), by marking the newest row before it
writes and naming the unnamed rows after (`personnelMark`, `notePersonnelChanges`). Rows are named, never removed.

Migration 024 adds the membership columns, links each membership whose billet title matches exactly one active
billet of its Unit Instance, creates the triggers and re-runs the boundary triggers. It removes and reshapes no row.
The instance archive carries the three new tables; loading one lifts the history triggers, as it lifts the membership
triggers, and puts them back before it commits. An archive from before 024 has its billets linked the same way.

### 3. The Unit Instance boundary keeps the new links

Added to `instanceBoundaryTriggers` (ADR-0008), with the same `cross_instance:` refusals and counts in
`instanceBoundaryViolations`:

- a membership fills a billet of its own unit's Unit Instance, and a billet does not move instances under its holders;
- a responsibility names a unit of its own Unit Instance (the configuration tables' rule);
- a supervisor serves in the Unit Instance they supervise in.

Within an instance, a billet that a Marine holds in a unit is not narrowed to another unit, which would leave the
membership holding a billet its unit does not have. The Unit Manager console refuses it (409 `billet_held`) and asks
for the holders to be given another billet first; `unit_billets_holders_fit` (migration 025) refuses any other writer.
A billet already out of step when 025 runs is left for its Unit Managers.

### 4. Who may read what

| Part | The Marine | Sees them on a roster (Read records or Manage members in a unit of theirs) | Manages them (Manage members, above them) | Opens their records (ADR-0015) |
| --- | --- | --- | --- | --- |
| Identity, rank, grade, MOS, EAS | ✓ | ✓ | ✓ | ✓ |
| Assignments, team, billet, dates, supervisor, check-in, chain, responsibilities held, roles | ✓ all | in those Unit Instances, in units they may see | ✓ | ✓ |
| Account status | ✓ | | ✓ | |
| History, ended responsibilities | ✓ all | | their instance's part | their instance's part |
| Record counts and links | ✓ all | | | what they may open |

A leader's history is their Unit Instance's part: periods and events there, in units they can view, and changes to
the person (rank, MOS, EAS, account) since the Marine first joined the instance, without the name of whoever made
one. Units the reader cannot view are left out inside each query, before its limit (300 events, 200 periods), so a
busy team elsewhere never pushes the reader's own rows out; the member page's membership history does the same. A Unit
Manager, who never reads records (ADR-0010), sees the roster and the personnel record and no record counts. Opening someone else's personnel record is audited as `view_personnel`.

A deactivated account keeps its memberships (Vantage support turns sign-in off, not the assignment). Those who manage
the Marine keep them on the roster and keep their personnel record, marked Deactivated, and may still change or end
the assignment; nobody opens their records from it, since the records route serves active accounts only. To anyone
else the account is gone, as it is everywhere else in Vantage. A deactivated account supervises nobody: Vantage
support's deactivation leaves every Marine it supervised, in any Unit Instance, without a supervisor, in their history
with the source `support`. Reactivation does not restore the links.

### 5. Who may change what

Every change follows the rule membership changes already followed: **Manage members in the Marine's unit, and above
the Marine there unless leading the unit.** Never one's own: a second person sets anyone's billet from the catalogue,
assignment dates, supervisor, check-in and responsibilities (`self_membership_change`). A Marine may still type their
own billet title and choose their own primary unit, as before.

- **Supervisor:** another active member of the same Unit Instance whom the actor can see; never the Marine; no loop
  however far up it would close (`supervisor_cycle`). A record shows the nearest ten supervisors.
- **Ending a responsibility:** whoever manages the Marine in its unit, or anywhere in its Unit Instance when it names
  no unit or the Marine has since moved to another team. The record says, per responsibility, whether the reader may
  end it.
- **Billet:** an active billet of the Unit Instance, for this unit or every unit; it sets the title too. Typing a
  title instead leaves the catalogue. The Unit Manager console's billet roster now matches holders by the link, and
  by title only for memberships that have none. The command's list and a unit's own can share a title; the dialog
  then asks which, starting from the one the Marine holds, so a save that changes only a date never swaps them.
- **Dates:** real calendar days; an end never before its start.
- **Responsibilities:** up to 80 characters, at most 20 held at once, no title held twice.
- **Profile:** a leader's correction of rank, MOS or EAS now takes Manage members above the Marine (it took reading
  their records), so a Unit Manager corrects a rank without opening anything the Marine wrote. It is refused for
  fields the personnel feed sets (`field_is_sourced`), as the Marine's own edit is. Only the Unit Instance that holds
  the Marine's primary unit edits it, and never for a deactivated account; the record says whether the reader may
  (`canEditProfile`), by the rule the profile route applies (`profileUnitsFor`).

### 6. Leaving a Unit Instance

When the last membership in a Unit Instance ends (`removeMember` ending its Unit Instance roles, so never a move
between its units), the personnel record there ends with it: no supervisor and no check-in there, the
responsibilities held there ended (`left`), and nobody there supervised by them any longer. All of it is in the
history with the source `departure`.

A separation the personnel feed makes keeps what it ends so a later extract can give it back (ADR-0009): with each
membership its billet from the list and assignment dates, and with the first the supervisor and check-in. A return
restores them, the billet while the unit still staffs it and the supervisor while they still serve in the Unit
Instance. Ended responsibilities stay ended; a leader adds them again. The Marine's personal export (Settings → Your
data) carries their personnel record, responsibilities and history.

### 7. Bulk operations

`POST /api/org/units/:unitId/personnel/bulk` changes up to 200 Marines in a unit and the units beneath it at once:
supervisor, check-in, assignment start, assignment end, billet, a new responsibility, or a move to another team.

- Every row is decided exactly as its single change would be, inside one transaction with a savepoint per row.
- **All or nothing.** A preview (`dry_run`) always rolls back and returns what each row would do. An apply with a
  refused row rolls back too and answers 409 `bulk_refused` with the reason for each row; the person fixes the
  selection and applies again.
- Each row is audited as its single change (`edit_membership`, `add_responsibility`, `move_member`), and the whole as
  `personnel_bulk` with the batch id that also names every history row it wrote.
- Moved Marines are told only after the change commits.
- A move goes to a team inside the view the change was opened on (`outside_view` otherwise); the dialog offers only
  those, and no move when there is none. One Marine's move from their row still goes to any team the leader manages.

The new change routes are in the privileged route inventory (ADR-0013), so the tests hold that an ordinary member and
a Unit Auditor are refused on each and nothing changes.

### 8. Where it shows

- **Personnel → Roster** is rebuilt on `GET /api/org/units/:unitId/personnel`: team, billet, supervisor, check-in,
  responsibilities and roles; account status for those the reader manages; filters for no supervisor, no billet and
  assignments ending within 90 days; and, for those who manage members, row selection with a bulk action bar that
  previews before it applies. Phones get a list.
- **A Marine's page** opens on a new **Personnel** tab: assignments, leadership chain, responsibilities, roles,
  account status, record links with counts, and history (membership periods and personnel events together). Someone
  who sees a Marine on a roster but may not open their records sees this tab and nothing else.
- **Settings** links to the person's own record.

## Consequences

- One place answers who the Marine is, where they serve, in what billet, under whom, since when and until when, and
  what changed. The roster and the Marine page read the same service.
- History is complete whichever path changed a fact, as it is for memberships. What the service cannot name stays
  unnamed (no actor) rather than guessed.
- Bulk changes are as safe as single ones: the same checks, the same audit, nothing half-applied.
- Duty is counted from Operations activities until Task 17 gives it records of its own. A CSV of the personnel roster
  is Task 13's. Role-change history stays in the audit trail.

## Alternatives considered

- **Supervisor and check-in on the membership.** A move between teams would lose them, and a supervisor is not a
  property of the team row a Marine sits in. Rejected for a record per Unit Instance.
- **History written by the service only.** The personnel feed, Vantage support and scripts each write `users`
  directly, so history would have gaps. Rejected for triggers, as ADR-0009 chose.
- **Bulk changes that keep the rows that pass.** Leaves a half-changed roster to reconcile. Rejected for all or nothing
  with a preview.
- **Supervisors reading the records of those they supervise.** Would make an informational field a grant and bypass
  roles. Rejected: authority stays in roles.
