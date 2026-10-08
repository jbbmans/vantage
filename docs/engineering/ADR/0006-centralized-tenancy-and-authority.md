# ADR-0006 · One central service, organizations as tenants, three tiers of authority

**Status:** accepted · **Date:** 2026-10-05 · **Amended by:** [ADR-0007](0007-mcen-enterprise-deployment-and-unit-instances.md), [ADR-0010](0010-vantage-administrator-and-unit-manager.md) (role names; an owner may no longer give themselves a role that reads records; organization roles last only while their holder is a member)

## Context

Vantage was built to be installed by each command on its own server. One "Instance Operator" flag gave
a person every power on that installation: settings, accounts, backups, every unit and every record. A
top-level unit stood in for an organization, and anyone could create up to five of them.

Vantage now runs as one service at vantageusmc.com, operated by the Vantage team, for many commands.
On a shared service, the people who run the service and the people who run a command are not the same
people. Neither should be able to do the other's job by default.

## Decision

### Tenancy

- **An organization is the tenant.** Typically it is a command or a staff section (for example,
  "MARFORRES G-8").
  - It owns a tree of units, their shared work, their roster feed, retention schedules, legal holds and
    audit trail.
  - Every unit belongs to exactly one organization (`units.org_id`). The organization's root unit is the
    top of that tree.
- **An account is the Marine's, not the organization's.** One person keeps one account across moves
  between commands.
  - Their private entries, career plan, readiness and personal export stay theirs.
  - An organization's access to a person comes only from that person's membership in its units.

### Three tiers of authority

No tier implies another.

| Tier | Who | Holds | Never holds |
|---|---|---|---|
| **Platform** (`platform_roles`) | Vantage staff | The service: organizations as containers, platform settings, sign-in support, email, AI, integrity, backups | Any organization's data, unless that organization has approved time-limited access |
| **Organization** (`org_roles`) | A command's owners and administrators | The organization: members, units, roles, roster feed, retention, holds, audit, privacy inventory, export, Vantage access approvals | Marines' records, unless they also hold a unit role that reads them |
| **Unit** (`roles`, `member_roles`) | The chain of command | The work and the records shared with a unit, flowing down the chain: the existing unit permissions | Anything above their units; anything in another organization |

Each tier has its own permission catalogue (`shared/permissions.ts`), and each catalogue entry says
what it lets a person do and what it does not.

#### Platform roles

| Role | Powers |
|---|---|
| Owner | Everything at platform level, including managing Vantage staff |
| Administrator | Organizations, platform settings, accounts, email, AI, integrity |
| Support | Account sign-in help and the platform support queue; may request access to an organization |
| Auditor | Platform audit trail and integrity, read-only |

#### Organization roles

| Role | Powers |
|---|---|
| Owner | Everything at organization level, including owners and the Vantage-access policy |
| Administrator | Members, units, unit roles, roster feed, invitations, export |
| Records officer | Retention schedules, legal holds, privacy inventory, audit trail |
| Auditor | Audit trail and privacy inventory, read-only |

#### How organization roles reach units

Organization owners and administrators manage the structure of every unit in the organization: members,
roles and sub-units. That is the structural part of the unit permission set. It never includes reading
shared records, member detail or the access log.

A command's administrator (often the S-6 or the ISSM's delegate) is therefore not, by holding that role,
a reader of every counseling in the command. They staff other people's roles; they cannot give themselves
reach into records by any door (a role, a unit's leadership, their own join code, widening a role they
hold). An owner can, and the grant is audited and the organization's other owners are told.

### Vantage access: the only way staff see an organization's data

A Vantage support or administrator account may request access to one organization. The request carries
a reason and a duration (four hours by default, never more than 24).

- **Approval.** The organization's owners are notified. Access begins only when an owner approves.
  - This is the default. An organization may instead choose "notify": access begins at once and its
    owners are told.
- **What access allows.** Read-only: the units and the work and records shared with them. Never member
  detail, never private entries, never changes.
- **When it ends.** Access ends at its expiry, or the moment an owner revokes it.
- **Audit.** Each request, decision, start and end is in both the organization's audit trail and the
  platform's.

### Time-bound grants and explanation

- **Time-bound grants.** A unit role or an organization role may be granted until a date, for example an
  acting SNCOIC during a leave period. An expired grant confers nothing, and a sweep removes it.
- **Explanation.** "Why can they?" names, for each permission a person holds in a unit, where it comes
  from:
  - the role, and the unit it was granted in, when it reaches down the chain of command;
  - unit ownership;
  - organization administration;
  - Vantage access.

### Two consoles

- **Vantage admin dashboard** (`/admin`, `/api/platform`) is for Vantage staff. It covers:
  - the organizations on the service;
  - platform settings and maintenance;
  - accounts' sign-in help;
  - Vantage staff;
  - access requests and their history;
  - email, AI, the MARADMIN feed, integrity, usage and platform backups.
- **Owner console** (`/console`, `/api/orgs/:orgId`) is for an organization's owners, administrators,
  records officers and auditors. It covers:
  - that organization's settings, members, units, roster feed, retention and holds;
  - its privacy inventory and audit trail;
  - its export;
  - the Vantage access requests it approves.

  A person with roles in several organizations switches between them.

They are different applications on different paths (and, where configured, different hosts). The API
behind each answers only its own audience.

## Migration from a single-instance database

Migration `015_organizations` runs once and adds before it changes anything.

- **Organizations.** Each top-level unit becomes an organization. Its id is the unit's id, and every unit
  beneath it carries its `org_id`.
- **Platform owners.** Every former Instance Operator becomes a platform owner.
  - `users.is_operator` is no longer read.
  - `VANTAGE_OPERATOR` still names bootstrap owners, as an alias of `VANTAGE_PLATFORM_OWNERS`.
- **Organization owners.** Each organization's owners are its root unit's leader. If the root unit has no
  leader, every former operator becomes owner, so no organization is left without one.
- **Data that belonged to the instance becomes the organization's.**
  - With one organization, all of it goes to that organization.
  - With several, the audit trail is attributed by unit. The roster feed, schedules and holds go to the
    first organization, and the migration records that it did so.

## Consequences

- **Organizations are created by Vantage staff, or by a person when the platform allows self-service.**
  Self-service creation keeps its per-person limit, and the creator becomes the new organization's owner.
- **Roster separations become organization-scoped.**
  - A Marine missing from an organization's extract, or marked Separated in it, leaves that organization.
    Their memberships there end and their claims are released.
  - The account is turned off only when they belong to no other organization.
  - Listed again as active, they are restored to the units the feed removed them from.
- **Credential resets are Vantage staff's.**
  - Resetting another person's password or second factor is Vantage support's job, because an account
    can belong to several organizations.
  - An organization's owners may unlock and sign out their own members.
- **Self-hosting is no longer offered.** Instance export and import remain as the platform's disaster
  recovery, in the admin dashboard.
- **The unit permission bits are unchanged.** Existing roles keep working. What changed is everything
  around them: who can hold them, for how long, and what the two tiers above may do.
