# ADR-0007 · MCEN enterprise deployment, Unit Instances, and deployment profiles

**Status:** accepted · **Date:** 2026-10-07 · **Amends:** [ADR-0006](0006-centralized-tenancy-and-authority.md)

## Context

ADR-0006 moved Vantage from one installation per command to one service run for many commands. Its
hosting assumption was the public internet: a Render web service at vantageusmc.com, behind
Cloudflare, with a public marketing site, search-engine notices, a commercial mail API (Resend) and
self-registration. That service is owned and operated by the developer.

The governing specification (VANTAGE_CLAUDE_MASTER.md, Task 1) sets a different target:

- Production is an enterprise application hosted on the **Marine Corps Enterprise Network (MCEN)**.
- Public SaaS and self-hosting are not the target.
- Each command is a **Unit Instance**.
- **Vantage Administrators** run the platform, and **Unit Managers** run their assigned Unit Instances.
- MCEN infrastructure facts that are not known from authorized documentation must not be invented.
  They are isolated behind configuration and recorded as open questions.

The code already has most of the enterprise model ADR-0006 built: tenants, three tiers of authority,
time-limited staff access, audit chains, CAC and OIDC sign-in. It is not thrown away. What changes is
the deployment around it, and the names.

## Decision

### 1. A Unit Instance is the tenant ADR-0006 calls an organization

| Spec term | Code today (kept for compatibility) | Where |
|---|---|---|
| Unit Instance | organization: `organizations` table, `units.org_id`, `/api/orgs/:orgId`, the owner console | `server/services/organizations.ts`, `server/routes/orgs.ts`, `src/console/` |
| Vantage Administrator | platform roles (owner, admin, support, auditor) | `platform_roles`, `shared/permissions.ts`, `/api/platform`, `/admin` |
| Unit Manager | organization roles owner and admin | `org_roles`, `ORG_ROLES` |
| Unit records and audit roles | organization roles records and auditor | `org_roles` |
| Unit leadership | unit roles flowing down the chain of command | `roles`, `member_roles`, `PERMISSIONS` |

- The admin dashboard and the owner console now say "Unit Instance" wherever they named the tenant.
- Table names, API paths, permission keys and audit action names keep their ADR-0006 names. Renaming
  them would break stored audit records, archives and clients for no gain in isolation. The mapping
  above is the contract.
- The final naming of the roles themselves (for example, "Unit Manager" in place of "Owner") belongs
  to Task 4.

### 2. Deployment profiles

`VANTAGE_DEPLOYMENT_PROFILE` names the environment a deployment answers to (`server/config.ts`,
`readDeploymentConfig`).

| Profile | For | Public site | What it refuses at start |
|---|---|---|---|
| `mcen` | Production on MCEN, the target | none | See the refusals below |
| `legacy-public` | The pre-MCEN public site at vantageusmc.com, until it is retired | yes | Nothing new |
| `development` | Workstations, CI, tests, the synthetic demo | yes | Running with `NODE_ENV=production` |

- **Unset profile.** A production start runs as `legacy-public`, so the live Render service keeps
  working. It logs a warning and shows that the profile was inferred in the admin dashboard. Outside
  production, an unset profile is `development`.
- **Independent of `NODE_ENV`.** `mcen` can run outside production, so the test suite exercises it.

`mcen` refuses, all in one message:

- the synthetic demo;
- IndexNow;
- search-engine verification tokens;
- Cloudflare client-address mode;
- the Resend and direct-MX mail providers (`smtp` to an enterprise relay, or `none`, are allowed);
- self-registration;
- `VANTAGE_CONSENT_BANNER=off`;
- a public-site address different from the application's.

`mcen` defaults to:

- the DoD Notice and Consent Banner;
- self-registration off;
- browser downloads of the database and service archive off (an explicit opt-in remains);
- no public marketing site.
  - `/` is the application.
  - `/about`, `/display`, `sitemap.xml`, `llms.txt` and `public.html` answer 404.
  - `robots.txt` disallows everything.
  - The plain-language security, accessibility, privacy and changes pages stay, served noindex. Every
    served document has the public build's canonical links, link-preview cards and structured data
    removed (`unpublished` in `server/app.ts`).

`mcen` holds two runtime settings off, whatever an earlier deployment saved
(`server/services/deployment.ts`):

- `selfRegistration`
- `selfServiceUnits`

The admin dashboard refuses to turn either on (`locked_by_profile`). Unit Instances are provisioned by
Vantage Administrators.

### 3. Topology: how many Unit Instances one deployment holds

`VANTAGE_TOPOLOGY` is `shared` (the default) or `dedicated`.

- **`shared`.** One service and one database hold many Unit Instances, isolated by `org_id` and the
  authorization layer. This is the ADR-0006 model. Task 2 hardens that boundary.
- **`dedicated`.** The service and its database hold exactly one Unit Instance.
  - The rule is a temporary trigger on the database connection (`installTopologyGuard`), installed at
    every start from configuration and not stored in the file. Every path that could found a second
    Unit Instance is refused the same way: the admin dashboard, a top-level unit, an archive import, a
    provisioning script, a raw insert, `INSERT OR IGNORE` included.
  - A database already holding more than one refuses to start as dedicated.
  - The service layer refuses first, with a 409 and the code `dedicated_topology`.
  - The synthetic demo cannot run dedicated.

Which of these MCEN uses is not decided here; it is question I-13. Separate schemas inside one
PostgreSQL database are a third option once ADR-0003's move to PostgreSQL happens. Either way, adding a
unit never needs a source branch: it is a provisioning action in a deployment that already exists, or a
new deployment of the same build with `VANTAGE_TOPOLOGY=dedicated`.

### 4. Provisioning

A Vantage Administrator provisions a Unit Instance in the admin dashboard, or repeatably from a
manifest:

```
VANTAGE_PROVISION=1 node scripts/provision-instance.ts --by <administrator> manifest.json [--dry-run]
```

The script (`server/services/provisioning.ts`):

- reuses `createOrganization` and `nameFirstOwner`, so the result is identical to the dashboard's;
- requires the named account to hold `platform.orgs`;
- names the first Unit Manager by username or DoD ID;
- checks everything before writing anything;
- is idempotent;
- audits `unit_instance_provisioned` to the administrator who ran it.

How MCEN requests and approves a new Unit Instance is question I-21.

### 5. Configuration boundaries

| Boundary | Who sets it | Where | Examples |
|---|---|---|---|
| Infrastructure | The hosting environment | Environment variables, read once at start | profile, topology, addresses, TLS and CAC mode, database path, relay, SIEM, scanner, secrets |
| Enterprise | Vantage Administrators | `meta.runtime`, the admin dashboard's Settings | display name, announcement, AI on or off, MARADMIN feed, maintenance, metrics |
| Unit Instance | Unit Managers | `organizations.settings`, the owner console | name, Vantage-access policy, members, units, roles, roster feed, retention, holds |

The profile can hold enterprise settings off. Unit Managers cannot change either of the levels above
theirs.

### 6. Data and file-storage boundaries

- **Database.** One SQLite database per deployment, in WAL mode (ADR-0003 plans PostgreSQL).
  - Every unit-scoped row carries the unit or Unit Instance it belongs to.
  - Under `dedicated`, the database itself is the Unit Instance boundary.
- **Files.** Attachments and imported source files are stored as BLOBs in the same database
  (`attachments.content`, `source_files`).
  - There is no external object store and no shared file path, so file storage has exactly the
    database's boundary.
  - Moving files out is ADR-0003 stage 5 and question I-14.
- **Backups.**
  - Under `mcen`, backups are the hosting environment's job (`scripts/backup.ts` on the host).
  - Downloading the whole database through a browser is off unless explicitly enabled.

### 7. Outbound connections

Every connection the server can open is listed, with its destination (host only, never credentials),
whether it is on, and how MCEN treats it. The list is `outboundConnections` and appears in the admin
dashboard's overview.

| Connection | Default | MCEN |
|---|---|---|
| GenAI.mil (AI) | off | needs an approved connection (I-18). Core functions never depend on it. |
| marines.mil MARADMIN RSS | off | needs an approved connection (I-19) |
| Microsoft Graph (mailbox connectors) | off | needs an approved connection (I-22) |
| Mail: SMTP relay | off | enterprise service (I-15) |
| Mail: Resend, direct MX | off | refused |
| IndexNow | off | refused |
| OIDC issuer, syslog SIEM, clamd | off | enterprise services |

The browser loads nothing from outside the deployment. The CSP is `'self'` plus the AI origin when AI
is configured. Fonts and scripts are local.

## Consequences

- The live legacy site keeps running unchanged. Its blueprint (`render.yaml`) names
  `legacy-public`. Retiring it is a decision for John, not a code change.
- An MCEN deployment cannot start with a public-internet dependency switched on by mistake. An
  operator sees every outbound connection in one place.
- `/api/health` reports the profile. The startup line names profile and topology.
- **Still open, and not invented here.** The isolation model, storage backend, relay, hostnames,
  identity path, SIEM, deployment mechanism and approvals are listed in
  [INFRASTRUCTURE_QUESTIONS.md](../INFRASTRUCTURE_QUESTIONS.md), I-13 to I-22.
- **Server wording lags the UI.** Server-side messages and some app wording still say
  "organization". Changing those, and the role names, is part of Task 4.
- [deployment-scale.md](../../deployment-scale.md) argued for one instance per command. That is the
  `dedicated` topology here, now one supported choice rather than an unstated assumption.
