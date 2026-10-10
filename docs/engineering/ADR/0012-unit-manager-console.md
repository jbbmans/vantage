# ADR-0012 · Unit Manager console: unit-scoped administration

**Status:** accepted · **Date:** 2026-10-09 · **Builds on:** [ADR-0006](0006-centralized-tenancy-and-authority.md),
[ADR-0008](0008-unit-instance-data-isolation.md), [ADR-0010](0010-vantage-administrator-and-unit-manager.md),
[ADR-0011](0011-vantage-administrator-console-operations.md)

## Context

Task 6 of the governing specification (VANTAGE_CLAUDE_MASTER.md) asks for unit-scoped administration that
manages personnel, organization, teams, billets, local roles, duty configuration, training configuration,
reports, FM workflow settings, unit imports and exports, and the unit audit trail, while enterprise
security stays centrally controlled. §19 lists what a unit controls (teams, billets, duty types, duty
scoring values, local workflow configuration, report defaults, local roles within enterprise limits) and
says unit configuration can never weaken enterprise controls.

The Unit Manager console on `main` at `9bc78e6` already had:

- members and their roles (People);
- units, as a flat list;
- the personnel feed, retention, holds, the privacy inventory and Vantage access;
- the latest 200 audit entries, filtered by action in the browser;
- the structure export;
- the Unit Instance's name and Vantage access policy under Settings.

It had none of these:

- billets, duty or training;
- a view of teams;
- unit roles across the instance;
- work or report settings;
- a roster export or a configuration import;
- any view of what Vantage sets for everyone.

On 2026-10-09 John chose, on the Task 6 decision card, to bring **versioned duty scoring policies** forward
from Task 18 into this Task ("Duty scoring too"). Recording duty (Task 17) and approvals, point overrides
and fairness reports (Task 18) stay where they are.

## Decision

### 1. Where each item lives

| Specification item | Console page | Permission |
|---|---|---|
| Personnel | People and Personnel feed (unchanged) | `org.members`, `org.personnel` |
| Organization | Units and teams; Settings | `org.units`; `org.settings` |
| Teams | Units and teams → Teams (squads and fire teams) | `org.units` |
| Billets | Billets: the list and the billet roster | `org.config`; assigning goes through the member's unit |
| Local roles | Unit roles | `org.roles`, `org.members` or `org.owners` to list; granting through `/api/org` as before |
| Duty configuration | Duty: duty types and scoring versions | `org.config` |
| Training configuration | Training: requirements | `org.config` |
| Reports | Work and reports → report default | `org.config` |
| FM workflow settings | Work and reports → claim expiry | `org.config` |
| Unit imports and exports | Imports and exports | `org.export` (roster, structure, configuration); `org.config` (configuration import); `org.members` (accounts) |
| Unit audit | Audit trail | `org.audit` |
| Enterprise controls | Settings → Set by Vantage (read-only) | `org.view` |

Every route is under `/api/orgs/:orgId`. Like the rest of the console, it needs a recent step-up, and it
checks its permission on the server (`inOrg`):

- someone with no role in the instance, or asking about another instance, gets 404;
- a role without the permission gets 403 `org_permission`.

Reading the configuration needs only `org.view`, so a Unit Auditor sees every page and no control that
changes anything.

### 2. A new Unit Instance permission, `org.config`

- **Who holds it.** Lead Unit Managers through `ALL_ORG`, and Unit Managers, who are now given it. Records
  Officers and Unit Auditors do not.
- **What it covers.** Billets, duty types, scoring versions, training requirements, work settings, report
  defaults and configuration import.
- **What it never reaches.** Sign-in, sessions, attachments, audit or any other enterprise setting.

### 3. Configuration tables

- **Four tables, each with `org_id`.** `schema.sql` adds `unit_billets`, `duty_types`,
  `training_requirements` and `duty_scoring_policies`.
- **Retired, never deleted.** A row is retired (`active = 0`), so whatever the audit trail names still
  resolves. Titles and codes are unique among a Unit Instance's rows in use.
- **Units named stay inside the instance.** A billet or requirement may name one of the instance's own
  active units, or none (the whole instance). A row keeps a unit archived after it was named, so its title
  can still be corrected, and the console marks the unit archived. A row brought back into use needs an
  active unit, or none.
  - The service refuses another instance's unit without saying whether that unit exists.
  - **Migration 020** adds triggers (`*_unit_same_org_insert`, `*_unit_same_org_update`) through
    `instanceBoundaryTriggers`, so the database refuses it too (`cross_instance`).
  - `instanceBoundaryViolations` counts any rows that predate the triggers.
- **Exports and privacy.** The tables are in the instance export (`EXPORT_TABLES`) and the privacy
  inventory.

### 4. Settings within enterprise limits

`organizations.settings` gains two settings (`shared/unitConfig.ts`):

- `work.claimExpiryHours`: 4 to 336 hours, default 72.
- `reports.defaultPeriod`.

A value outside its limit is refused when saved and clamped when read. Each change is audited as
`unit_settings_updated`, with before and after.

- **Claim expiry.** `releaseStaleClaims` now uses the setting of each work item's Unit Instance, so one
  instance's choice never changes another's queue. The case history and the audit trail record the window
  that applied.
- **Report default.** `/api/me` returns `unitDefaults.reportPeriod`, taken from the instance of the
  person's primary unit. Reports and Records open on it when the person has not chosen a period themselves.

### 5. What Vantage sets, read-only

Settings shows **Set by Vantage** (`enterpriseControls`):

- which sign-in methods are on, and whether a card is required;
- the session limits: idle, console idle, absolute and step-up;
- whether attachments are on, and their size limit;
- whether the audit trail is forwarded;
- whether AI, email and the MARADMIN feed are on.

It shows configuration only: no secret, no host name and nothing about another Unit Instance.

### 6. Units, teams and unit roles

- **Units and teams** lists the instance's units as a tree; the Teams filter shows squads and fire teams.
  - Creating, editing, moving, archiving and naming leaders go through the existing `/api/org/units`
    routes, so the ADR-0010 rules hold unchanged.
  - A unit made through a Unit Instance role is led from above until its leader is named. A unit made
    where the creator leads through the chain of command is theirs.
- **Unit roles** lists every unit's roles and holders across the instance (`GET /unit-roles`).
  - Granting, removing, defining and deleting roles go through `/api/org` as before, so no self-grant or
    record-reading rule changes.
  - A grant made from the console may carry an end date, for an acting billet or a leave period.

### 7. Billets

- **The billet list** is the instance's catalogue of billets, per unit or for the whole instance.
- **The billet roster** shows, for each unit, its billets, who fills each one (matched by the membership's
  billet title) and which are vacant.
- **Assigning a billet** writes the membership's billet through the existing membership route, so
  membership history records it.

### 8. Duty types and training requirements

- **Duty types** are a catalogue with codes. An instance can start from the specification's list (DNCO,
  ADNCO, Barracks Duty, SAF, Color Guard, Funeral Detail, Range Support, Working Party, Event Support,
  Command Duty) or add its own.
- **Training requirements** name a kind, an optional course code, how often they recur and where they
  apply.
- **Nothing uses them yet.** Nothing records duty or checks anyone's training; Tasks 17 and 19 use these
  lists.

### 9. Duty scoring versions (Task 18, brought forward)

- **What a version holds** (`shared/dutyScoring.ts`):
  - a rule for each duty type in use, scored fixed, per day, per hour, or by length (hour bands starting
    at 0);
  - multipliers for weekend, holiday, overnight, short-notice, extended and consecutive duty;
  - when several multipliers apply, whether to take the highest or multiply them all.
  A version scores at least one duty type.
- **Vantage sets the bounds for every instance:** 0 to 100 points, multipliers 1 to 5 (a multiplier never
  lowers points), hours 0 to 168, and at most 12 bands. Rules name duty types by id, since codes can be
  edited.
- **Published once.** `POST /duty-scoring` takes the day the version takes effect and a required reason.
  The day is tomorrow or later, in the deployment's time zone: a version that took effect today would
  score duty already stood today, and could not be withdrawn. The database refuses any change to a
  published version, its id included (`duty_scoring_policies_published`); a change is a new version.
- **In order, never backwards.** Each version takes effect after every version not withdrawn
  (`scoring_order`), so none reaches back over duty already stood. A version can be withdrawn only before
  it takes effect; once it is in force, the request is refused (`in_force`). A withdrawn version stays on
  the record and stays withdrawn (`duty_scoring_policies_withdrawn`).
- **The database holds the order too.** `duty_scoring_policies_order` refuses a row, not withdrawn, that
  would take effect out of version order, whichever order rows are inserted in (so an archive restore is
  held to it). `duty_scoring_policies_in_force` refuses withdrawing a version that took effect before
  today in UTC: a day's grace against the deployment's time zone, so it never refuses a withdrawal the
  service allows. Deleting a version is not refused by a trigger, since the whole-service restore and the
  demo reset delete rows; nothing in the application deletes one.
- **Scoring.**
  - `policyOn(versions, day)` picks the latest version, not withdrawn, that takes effect on or before the
    duty's day. `calculatePoints` applies its rule and multipliers.
  - The console's **Try it** uses the same function Task 17 will use.
  - A later version never rescores earlier duty: duty in March, scored under a January version, keeps its
    points when a July version takes effect.
  - Task 17 should store, with each duty it scores, the version's id and the points, so a score stays
    explainable even if the version were removed by hand.
- **Audited** in the instance's trail as `duty_scoring_policy_published` (version, day, counts and reason)
  and `duty_scoring_policy_withdrawn`.

### 10. Imports and exports

- **Roster CSV** (`org.export`): name, rank, username, status, unit, billet, primary, unit roles and Unit
  Instance roles, for every member. No EDIPI, email or record: a username Vantage made from a card
  (`edipi-` and the number) is left blank. Audited as `organization_roster_exported`.
- **Configuration file** (`org.export` to export, `org.config` to import): the billets, duty types,
  training requirements and settings in use, as `vantage-unit-configuration/1`.
  - An import shows a plan first, then applies it in one transaction.
  - It adds billets, duty types and requirements that are missing, and restores retired duty types. It
    never removes or overwrites one. Settings in the file replace the instance's, within their limits, and
    the plan shows each change; each is audited as `unit_settings_updated`.
  - A row naming a unit that is not the instance's own is skipped, so a file from another instance brings
    its catalogue, never a reference into that instance.
  - Settings stay within their limits.
  - Audited as `unit_configuration_imported`, naming up to 20 of the rows it added or restored. The
    instance name a file carries is recorded as the file's claim, not as a fact.
- **Scoring versions are not in the configuration file.** Each takes effect on a date, carries a reason
  and belongs to one instance's history, so it is published by hand.
- **Accounts and personnel** import through the existing account import and personnel feed.

### 11. The Unit Instance's audit trail

- **Filtered on the server.** `GET /audit` filters as the platform trail does (ADR-0011): by words
  (action, detail, usernames, people's names, an exact IP or entity id), action, unit and UTC dates. It
  pages back with `before`.
- **Shared code.** The query is shared with the platform trail (`server/services/auditQuery.ts`), and so
  is the page (`src/components/AuditTrail.tsx`).
- **Export.** `GET /audit/export?format=csv|json` exports the filtered trail. It refuses more than 50,000
  entries and is audited as `organization_audit_exported`.
- **Chain check.** It tells an instance whether the service's chain holds and how many entries are its own.
  It never gives the service's count, or which entry broke the chain, since that entry may be another
  instance's. Verifying reads the whole service's trail, so the answer is reused for a minute.
- **No EDIPI.** Usernames Vantage made from a card are left out of the instance's pages and exports, and
  the search does not match them: the trail is read by Records Officers and Unit Auditors, who never see
  an EDIPI.
- **What it still shows of the service.** Entry numbers (`seq`) and the chain's hashes are the service's,
  so their gaps show that other instances write to the trail, though not what or how. This was so before
  Task 6.

## Consequences

- One schema migration (020, the boundary triggers for the new tables), and four new tables from
  `schema.sql`.
- New permission `org.config`, held by Lead Unit Managers and Unit Managers; nobody loses anything.
- New audit actions:
  - `billet_created`, `billet_updated`, `billet_retired` and `billet_restored`, and the same four for
    `duty_type_*` and `training_requirement_*`;
  - `duty_types_standard_added`, `unit_settings_updated` and `unit_configuration_imported`;
  - `organization_roster_exported`, `organization_audit_exported` and `unit_configuration_exported`;
  - `duty_scoring_policy_published` and `duty_scoring_policy_withdrawn`.
- `releaseStaleClaims` takes its window from each instance. Passing `afterHours` still forces one window
  for every claim.
- The Unit Manager console's audit route now takes `q`, `unit`, `from`, `to` and `before`, and returns
  `next` and `actions`. Its old `?action=` and `?limit=` still work within the platform trail's bounds:
  a limit of 1 to 1000 and an action of up to 60 characters, where before an out-of-range value was cut
  to fit; now it is refused.
- `orgMembers` takes a limit: 500 for a page as before, none for the roster.
- **Not done here, by design:**
  - recording duty, swaps and availability (Task 17);
  - approvals, point overrides, fairness, and reports on points (Task 18);
  - training compliance (Task 19);
  - per-unit settings below the instance: each setting is the whole instance's;
  - scoring versions in the configuration file (section 10);
  - FM procedures, which stay code reviewed against their references (ADR-0005); the console sets only
    the work queue's claim window;
  - the Task 2 and Task 4 findings deferred to Task 7;
  - a cap on how many billets, duty types, requirements or scoring versions an instance keeps, and paging
    of the scoring history: each is small in practice, and every change is audited.

## Alternatives considered

- **Letting a Unit Manager change sign-in, session or attachment settings for their instance.** Rejected:
  §19 keeps enterprise security central. The console shows them read-only.
- **Editing a scoring policy in place and recalculating.** Rejected: the specification forbids silently
  recalculating historical scores. Versions with effective dates, immutable in the database, keep every
  score explainable by the version of its day.
- **Allowing a version to take effect in the past.** Rejected: it would change points for duty already
  stood. Correcting one duty's points is an override with a reason, which belongs to Task 18.
- **Clamping out-of-range settings on save.** Rejected: a Unit Manager who asks for something Vantage does
  not allow is told so. Clamping on read stays, for imported files and older rows.
- **Deleting retired configuration rows.** Rejected: the audit trail, and later duty records, name them.
