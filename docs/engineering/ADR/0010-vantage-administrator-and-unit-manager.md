# ADR-0010 · Vantage Administrator and Unit Manager: explicit roles, granular permissions, no self-elevation

**Status:** accepted · **Date:** 2026-10-08 · **Amends:** [ADR-0006](0006-centralized-tenancy-and-authority.md),
[ADR-0007](0007-mcen-enterprise-deployment-and-unit-instances.md)

## Context

Task 4 of the governing specification (VANTAGE_CLAUDE_MASTER.md) asks for:

- an explicit Vantage Administrator and an explicit Unit Manager, in place of ambiguous "Admin" concepts;
- granular permissions, enforced by the server;
- a Unit Manager scoped to the Unit Instances they are assigned to;
- a Unit Manager who cannot elevate themselves.

The code already had most of the model. ADR-0006 built three tiers of authority (platform, organization,
unit), each with its own permission catalogue in `shared/permissions.ts`. ADR-0007 mapped the
specification's terms onto them and left the role names themselves to this task.

What the code still had on `main` at `9a5cc9d`:

- **"Administrator" named three different things.** The platform role `admin`, the Unit Instance role
  `admin`, and the unit permission `ADMINISTRATOR` (every permission in one unit and the units beneath
  it). "Owner" named the platform `owner`, the Unit Instance `owner`, and, informally, a unit's leader.
- **A Unit Instance owner could give themselves a role that reads records.** ADR-0006 allowed it and
  told the other owners afterwards. That is self-elevation, and the notice came after the reading could
  start.
- **Vantage staff could found a Unit Instance through the app.** Holding `platform.orgs` skipped the
  self-service switch on creating a top-level unit, even under the `mcen` profile, where that switch is
  locked off. The founder became the new instance's owner and the leader of its top unit.
- **A Vantage Administrator could name themselves a Unit Instance's first owner.** That was possible in
  the create form, in "name an owner" for an instance that had none, and in a provisioning manifest.
  Where nobody led the top unit, they then led it and read its records.
- **A Unit Instance role outlived its holder's membership.** A Unit Manager removed from every unit,
  separated by the roster feed, or released by the old command after a transfer, still ran the instance.
- **Some checks named roles instead of permissions,** for example `roles.includes('owner')`.

## Decision

### 1. The explicit roles

| Tier | Stored key | Name shown | What it holds |
|---|---|---|---|
| Platform | `owner` | **Lead Vantage Administrator** | Every platform permission, including Vantage staff and backups |
| Platform | `admin` | **Vantage Administrator** | Unit Instances and Unit Manager assignment, platform settings, account support, Vantage access requests, the support queue, email, AI, integrity, audit, usage |
| Platform | `support` | Vantage Support | Account sign-in help, the support queue, access requests |
| Platform | `auditor` | Vantage Auditor | The platform audit trail and integrity, read-only |
| Unit Instance | `owner` | **Lead Unit Manager** | A Unit Manager who also assigns the instance's roles, governs Vantage access, and runs retention, holds and the privacy inventory |
| Unit Instance | `admin` | **Unit Manager** | Members, units, unit roles, the personnel feed, the structure export, the audit trail |
| Unit Instance | `records` | Records Officer | Retention, legal holds, the privacy inventory, the audit trail |
| Unit Instance | `auditor` | Unit Auditor | The audit trail and the privacy inventory, read-only |
| Unit | permission `ADMINISTRATOR` | Full unit authority | Every permission in one unit and the units beneath it: what its Unit Leader holds |

- **A Vantage Administrator** holds the platform `owner` or `admin` role (`VANTAGE_ADMINISTRATOR_ROLES`).
  Everyone who holds any platform role is Vantage staff.
- **A Unit Manager** holds the Unit Instance `owner` or `admin` role in that Unit Instance
  (`UNIT_MANAGER_ROLES`). A Lead Unit Manager is a Unit Manager.
- **Full unit authority** is a unit permission. It is neither a Unit Manager role nor a Vantage
  Administrator role, and it confers nothing above its unit.
- **Stored keys do not change.** Role keys are held by `CHECK` constraints and appear in audit details,
  archives and the API. Permission keys appear in exports. As in ADR-0007, the stored and machine-facing
  names are the contract, and only the names people read change.
- **The consoles are named for the roles they serve.**
  - "Owner console" becomes the **Unit Manager console**.
  - "Admin dashboard" and "Vantage admin" become the **Vantage Administrator console**.
  - Their paths (`/console`, `/admin`, `/api/orgs`, `/api/platform`) do not change.

### 2. Permissions decide, never role names

Every authorization check asks for a permission from a catalogue.

- **Removing a role holder.** Taking a holder of a Unit Instance role out of the instance asks for
  `org.owners`, not for the `owner` role.
- **Staffing units.** Defining and granting unit roles through Unit Instance authority asks for
  `org.roles`.
- **Structural unit permissions.** What a Unit Instance permission confers in every unit of that
  instance is mapped one to one (`ORG_STRUCTURE_GRANTS`):

  | Unit Instance permission | Unit permission |
  |---|---|
  | `org.members` | `MANAGE_MEMBERS` |
  | `org.units` | `MANAGE_UNITS` |
  | `org.roles` | `MANAGE_ROLES` |
  | any of them | `VIEW_UNIT` |

  None of them confers a permission that reads records. Lead Unit Managers and Unit Managers hold all
  three, so what they could do is unchanged. Records Officers and Unit Auditors hold none, as before.
- **Role names label people.** They never decide what a person may do.

`tests/server/roleModel.test.ts` drives every role of both catalogues against the routes its permissions
open and the routes they do not.

### 3. Unit Managers are scoped to the Unit Instances they are assigned to

- **The assignment.** A Unit Manager is assigned by a row in `org_roles` for one Unit Instance, granted
  to a member of it. Holding roles in several instances means several rows. Every Unit Instance route
  names the instance and checks the role there; another instance answers "not found" (ADR-0006,
  ADR-0008).
- **Membership.** A Unit Instance role confers authority only while its holder belongs to a unit of that
  instance (`seatedOrgRole` in `server/authz/scope.ts`). Whatever path ends the membership, the authority
  ends with it on the next request.
- **Leaving ends the role.**
  - When a member leaves their last unit in the instance, their Unit Instance roles there end. This
    covers removal from the unit page, from the Unit Manager console, and archiving a unit they alone
    belonged to. Each ending is audited as `org_role_ended`.
  - A move between units of the same instance never ends a role.
  - A **roster separation** ends it too. The roles it ends are kept in the roster row with the separated
    memberships, so when a later extract lists the person again the feed restores both, audited as
    `org_role_restored`, unless a role's end date has passed meanwhile.
- **Who may end someone's role by removing them.** Taking someone else who holds a Unit Instance role out
  of their last unit ends that role, so it is a Lead Unit Manager's to do (`org.owners`), as it already
  was in the console.
  - The roster feed follows the same rule. An extract run by someone without `org.owners` holds back the
    separation of a role holder as a conflict, and they stay on the roster, so the next extract raises it
    again (`holdBackRoleHolders`).
  - Leaving your own last unit, or archiving it, needs nobody else, because it reduces authority.
  - No path takes out the instance's last Lead Unit Manager: not removal, leaving, archiving, nor a
    separation in the feed, which holds it back until another is named.
- **Counts and notices.** "Last Lead Unit Manager" checks, owner counts, notices and console sign-in count
  only holders who are still members. A Unit Instance whose Lead Unit Managers have all left shows as
  having none, and a Vantage Administrator names a new one (section 5).

### 4. Nobody elevates themselves

**A Unit Manager:**

- never grants, extends or changes their own Unit Instance roles (unchanged);
- never gives themselves, through Unit Instance authority, unit authority the chain of command has not
  given them. Reading Marines' records is the case that matters most, but a role that only makes units or
  manages members is refused too, because making a unit and then leading it reaches the same records.
  That covers every door:
  - granting themselves a role;
  - naming themselves a unit's leader, or taking leadership by transfer;
  - redeeming their own join code or invitation;
  - widening a role they hold.

  This is now refused for **Lead Unit Managers too** (`guardSelfReach`, code `self_grant`). Another Unit
  Manager, or the unit's chain of command, grants it, and the audit trail shows who did. Each check runs
  before anything is written;
- never sets a new end date on a unit role they already hold, making an acting billet permanent, unless
  the chain of command gives them full unit authority in that unit;
- never links or changes the CAC (EDIPI) of someone else who holds a Unit Instance role. That is a Lead
  Unit Manager's (`org_permission`), or a Unit Manager could link their own card to a Lead Unit Manager's
  account and sign in as them;
- cannot reach platform authority. `/api/platform` refuses anyone without a platform role
  (`not_staff`). Enterprise settings live only there. A Unit Instance's own settings (its name and its
  Vantage-access policy) cannot change them, and the `mcen` profile locks the settings that would
  loosen it (ADR-0007).

**A Vantage Administrator:**

- never grants themselves a platform role (unchanged);
- never names themselves a Unit Instance's Lead Unit Manager. That holds in the create form, in "name a
  Lead Unit Manager", and in a provisioning manifest (`self_grant`);
- never founds a Unit Instance by creating a top-level unit in the app while self-service is off, which
  it always is under the `mcen` profile. `platform.orgs` no longer skips that switch, or the per-person
  limit that goes with it. Unit Instances are created in the Vantage Administrator console or from a
  manifest, which gives their creator no role in them. Where a legacy deployment turns self-service on,
  staff may found one as anyone may, and run it as its founder;
- still holds no unit permission through a platform role. An approved, time-limited, read-only Vantage
  access grant remains the only way in (ADR-0006).

### 5. Who assigns Unit Managers

- **Lead Unit Managers** assign the Unit Instance's roles (`org.owners`), never their own.
- **A Vantage Administrator** (`platform.orgs`) names the first Lead Unit Manager of a Unit Instance that
  has none, never themselves.
  - When the named person is not a member, they are seated in the top unit (start reason
    `manager_assigned`), so the role confers authority. This is the one place staff put an account into
    a unit without that person accepting; the Unit Instance has nobody else to do it.
  - When nobody leads the top unit, they lead it, as before.
  - An earlier role row for that person (one whose holder had left, say) is replaced, with no end date.
- **A Vantage Administrator also assigns Unit Managers in a running Unit Instance** (`platform.managers`,
  "Unit Manager assignment"). John decided this on 2026-10-08, answering I-27: any time, not only when the
  instance has no Lead Unit Manager.
  - They add or remove a Lead Unit Manager or a Unit Manager in any Unit Instance
    (`POST /api/platform/orgs/:orgId/managers`, `DELETE /api/platform/orgs/:orgId/managers/:userId/:role`,
    and **Unit Managers** on each Unit Instance in the Vantage Administrator console).
  - Never themselves (`self_grant`), and only a member of the instance: the platform names who runs a
    command, it does not add people to one.
  - Never the last Lead Unit Manager (`last_owner`).
  - The person and the instance's Lead Unit Managers are told each time. Each step is in the instance's
    audit trail (`org_role_granted`, `org_role_revoked`) and the platform's (`platform_manager_assigned`,
    `platform_manager_removed`).
  - Lead Vantage Administrators and Vantage Administrators hold it; Vantage Support and Vantage Auditors
    do not.

### 6. Vantage support on an account is visible to the Unit Instance

Account support (`platform.accounts`) can set a temporary password, reset a second factor, correct an
EDIPI, and deactivate or reactivate an account. On the account of a Unit Manager, that is enough to sign
in as them. So each of those steps is written into the audit trail of every Unit Instance the person
belongs to (`vantage_account_support`), and where they hold a Unit Instance role or lead a unit there,
its Lead Unit Managers are told. This detects a takeover; it does not prevent one. Requiring a second
person for these steps on such an account belongs to Task 7.

### 7. A known exception: first-run setup

First-run setup (`POST /api/auth/setup`, with `VANTAGE_SETUP_TOKEN` in production) creates one account
that is three things at once:

- the Lead Vantage Administrator;
- the first Unit Instance's Lead Unit Manager;
- the leader of that instance's top unit.

That is a bootstrap, not a model. [deploy-mcen.md](../../deploy-mcen.md) gives the hand-off that ends it:

1. Name the command's own Lead Unit Manager.
2. Transfer the top unit's leadership.
3. The administrator gives up their own Unit Instance role. That needs nobody else, because it reduces
   authority.

## Consequences

- **Behavior changes:**
  - A Lead Unit Manager can no longer give themselves a role that reads records. ADR-0006's "an owner
    may, and the other owners are told" is withdrawn.
  - Vantage staff found Unit Instances only in the Vantage Administrator console or from a manifest.
  - A Vantage Administrator cannot name themselves a Unit Instance's Lead Unit Manager.
  - A Unit Instance role confers nothing while its holder belongs to no unit of the instance, and ends
    when they leave their last unit, a roster separation included; the feed's restore gives it back.
  - Removing someone else who holds a Unit Instance role from their last unit, directly or through the
    roster feed, needs a Lead Unit Manager.
  - A Unit Manager can no longer give themselves a unit role that makes units or manages members, extend
    a unit role they hold, or link a CAC to another role holder's account.
  - Vantage Administrators add and remove Unit Managers in any Unit Instance (`platform.managers`).
  - Vantage support on a role holder's account is recorded in their Unit Instance and told to its Lead
    Unit Managers.
  - The per-person limit on self-service Unit Instances now applies to Vantage staff too.
  - Names shown change, as in section 1.
- **Unchanged:** stored role and permission keys, existing API paths and audit action names, archive
  formats, and the unit permission bits. New: the `platform.managers` permission, the two
  `/api/platform/orgs/:orgId/managers` routes, and the audit actions `org_role_restored`,
  `platform_manager_assigned`, `platform_manager_removed`, `platform_owner_named` and
  `vantage_account_support`. The roster row's `removed_units` stays the list it was; the Unit Instance roles a
  separation ended ride on its first entry (`orgRoles`), so a version from before this change still
  restores the memberships.
- **Upgrading.** A Lead Unit Manager made by migration 015's operator fallback who belongs to no unit of
  the instance holds no authority after this change. Their instance shows as having no Lead Unit
  Manager, and a Vantage Administrator names one.
- **Known limits, left for Task 7:**
  - **A second identity.** A Unit Manager who can create accounts (account import) or seat people
    (invitations, join codes) can make a second account and grant it what they may not grant
    themselves. The checks here stop a person, not a person with two accounts. Identity proofing
    closes it: under MCEN every account signs in with its own CAC.
  - **Vantage support takeover** is detected (section 6), not prevented.
  - **Unit leadership is not tied to membership** the way Unit Instance roles are: a unit's leader who
    leaves it still leads it until leadership is transferred.
  - A sole Lead Unit Manager who misuses the role cannot be removed by anyone in the instance; a Vantage
    Administrator names a second and then removes them.
  - Some of these rules live in routes rather than services, so a new route must call them.
- **Not done here:**
  - The consoles themselves, which are Tasks 5 and 6.
  - A separation-of-duties view of dual-hatted accounts, which belongs to Task 7.

## Alternatives considered

- **Renaming the stored keys** (`owner` to `lead_manager`, `ADMINISTRATOR` to `FULL_AUTHORITY`).
  Rejected. It needs a migration that rebuilds two tables with `CHECK` constraints. It also changes
  audit details, archives and the export format, for no gain in what anyone may do. The names people
  read are what was ambiguous.
- **One Unit Manager role, merging owner and admin.** Rejected. Either every Unit Manager would also
  assign the instance's roles and approve Vantage access, or none would. Two levels keep that power with
  fewer people.
- **Keeping the owner's self-grant with a notice** (ADR-0006). Rejected. The specification says a Unit
  Manager cannot elevate themselves, and a notice after the grant does not stop the reading.
- **Leaving a separated holder's Unit Instance role dormant.** The first version of this change did that,
  so the feed's restore would bring it back. Rejected in review: a dormant role came back whenever the
  person was seated again by any path, a join code or invitation included, not only the feed's restore.
  Ending it and keeping it with the separated memberships gives a mistaken extract the same remedy, and
  holding back the last Lead Unit Manager's separation stops an extract stripping the instance.
- **Vantage Administrators naming Unit Managers only when an instance has none.** That was this ADR's
  first proposal (I-27). John chose "any time" on 2026-10-08, with the rules in section 5.
