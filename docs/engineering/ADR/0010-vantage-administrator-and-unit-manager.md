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
| Platform | `admin` | **Vantage Administrator** | Unit Instances, platform settings, account support, email, AI, integrity, audit, usage |
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
  - A **roster separation** leaves the role dormant rather than ending it. The feed restores a person it
    separated by mistake, with their unit roles, when a later extract lists them again. Their Unit
    Instance role returns with them, for the same reason.
- **Who may end someone's role by removing them.** Taking a holder of a Unit Instance role out of their
  last unit ends that role. So it is a Lead Unit Manager's to do, as it already was in the console
  (`org.owners`), and never to the instance's last Lead Unit Manager.
- **Counts and notices.** "Last Lead Unit Manager" checks, owner counts, notices and console sign-in count
  only holders who are still members. A Unit Instance whose Lead Unit Managers have all left shows as
  having none, and a Vantage Administrator names a new one (section 5).

### 4. Nobody elevates themselves

**A Unit Manager:**

- never grants, extends or changes their own Unit Instance roles (unchanged);
- never gives themselves reach into Marines' records through Unit Instance authority. That covers every
  door:
  - granting themselves a role;
  - naming themselves a unit's leader, or taking leadership by transfer;
  - redeeming their own join code or invitation;
  - widening a role they hold.

  This is now refused for **Lead Unit Managers too** (`guardSelfReach`, code `self_grant`). Another Unit
  Manager, or the unit's chain of command, grants it, and the audit trail shows who did;
- cannot reach platform authority. `/api/platform` refuses anyone without a platform role
  (`not_staff`). Enterprise settings live only there. A Unit Instance's own settings (its name and its
  Vantage-access policy) cannot change them, and the `mcen` profile locks the settings that would
  loosen it (ADR-0007).

**A Vantage Administrator:**

- never grants themselves a platform role (unchanged);
- never names themselves a Unit Instance's Lead Unit Manager. That holds in the create form, in "name a
  Lead Unit Manager", and in a provisioning manifest (`self_grant`);
- never founds a Unit Instance by creating a top-level unit in the app. `platform.orgs` no longer skips
  the self-service switch. Unit Instances are created in the Vantage Administrator console or from a
  manifest, which gives their creator no role in them;
- still holds no unit permission through a platform role. An approved, time-limited, read-only Vantage
  access grant remains the only way in (ADR-0006).

### 5. Who assigns Unit Managers

- **Lead Unit Managers** assign the Unit Instance's roles (`org.owners`), never their own.
- **A Vantage Administrator** (`platform.orgs`) names the first Lead Unit Manager of a Unit Instance that
  has none, never themselves.
  - When the named person is not a member, they are seated in the top unit (start reason
    `manager_assigned`), so the role confers authority.
  - When nobody leads the top unit, they lead it, as before.
- **Open question.** The specification lists Unit Manager assignment among the capabilities a Vantage
  Administrator may hold. Whether a Vantage Administrator should also assign or remove Unit Managers in a
  running Unit Instance is a governance question for MCEN and John (INFRASTRUCTURE_QUESTIONS I-27). It is
  not built. Building it would be one more `platform.*` permission and route, with the same rules:
  never yourself, members only, and the instance's Lead Unit Managers told.

### 6. A known exception: first-run setup

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
    when they leave their last unit (a roster separation excepted).
  - Removing a Unit Instance role holder from their last unit needs a Lead Unit Manager.
  - Names shown change, as in section 1.
- **Unchanged:** stored role and permission keys, API paths, audit action names, archive formats, and
  the unit permission bits.
- **Not done here:**
  - Vantage Administrators assigning Unit Managers in running instances (I-27).
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
- **Ending Unit Instance roles on a roster separation too.** Rejected. A mistaken extract would strip an
  instance of its Lead Unit Managers, and only the platform could put one back. A dormant role that the
  feed's own restore brings back is safer. It confers nothing in the meantime.
