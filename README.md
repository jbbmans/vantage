# VANTAGE 3.5.0-rc.2

VANTAGE is a self-hosted performance, productivity, and operational-record workspace designed for Marine Corps sections. It turns short activity entries into a searchable ledger, a command-level operational picture, project and task views, career narratives, and exportable reports without sending records to an external AI or analytics provider.

This is a release candidate for controlled evaluation. It is not an official Marine Corps system, is not approved for MCEN, and has not received an Authority to Operate. Keep `app.data_mode: evaluation` until the hosting environment and intended data types are formally authorized.

## Product experience

- **Command:** data-first dashboard with impact, throughput, completeness, open actions, trend charts, attention items, and latest activity.
- **Records:** searchable activity and transaction ledger with date ranges, quality filters, CSV/TSV import, CSV export, and optional supporting files.
- **Quick Capture:** a fixed Log activity action accepts plain language, then exposes the parsed date, amount, transaction type, quantity, units, category, organization, system, visibility, outcome, and notes before save.
- **Work:** task-flow board and project portfolio with priorities, deadlines, status, progress, and goals.
- **Career:** development, recognition, readiness, and narrative tools organized as a distinct career workspace.
- **Reports:** fiscal and evaluation-period reporting built only from stored records; VANTAGE composes and aggregates but does not invent claims.
- **Team and Roles:** exact-unit membership, scoped role grants, enrollment of existing accounts, guest expiry, and auditable personnel administration.
- **Settings:** account, password, sessions, backup, YAML configuration, aggregate experience metrics, access history, import/export, and data-location controls.

## Data and access model

VANTAGE is a multi-user system with exact-unit tenancy:

- A self-registered account starts unattached and personal-only.
- Unit information becomes visible only after an authorized leader attaches the identity to a unit.
- Personal records are readable only by their owner.
- Private records retain unit context but remain owner-only.
- Unit records are shared with current members of that exact unit; hierarchy does not widen access.
- The Instance Operator is an infrastructure-recovery identity, not a global content-reader role.
- Protected reads, exports, backups, role changes, and lifecycle actions are audited.

A fresh database contains one active unit—Marine Forces Reserve (`MFR`, displayed as
`MARFORRES`)—and six editable, unit-local roles: Marine, NCO, Fire Team Leader,
SNCO, SNCOIC, and Unit Leader. No subordinate org chart or live personnel data
ships with the application.

See [SECURITY-REVIEW.md](SECURITY-REVIEW.md) for the security model, residual risks, and production gates.

## Architecture

- React 18, Vite, Tailwind CSS, Radix UI, Lucide icons, and Recharts
- Node.js 22 and Express
- SQLite through `better-sqlite3`, with WAL mode and versioned migrations
- One same-origin process in production: Express serves both the API and the built SPA
- Docker, Render, and Fly.io deployment definitions
- No third-party analytics, advertising telemetry, or external generative AI

PostgreSQL is the target datastore for an official multi-instance or horizontally scaled deployment. SQLite remains appropriate for the current single-process evaluation architecture when the database is stored on a persistent encrypted volume and backed up.

## Configuration

Non-secret operator settings live in [`config/app.yaml`](config/app.yaml). The loader accepts a deliberately small YAML subset and rejects unknown keys, unsafe ranges, unsupported syntax, and nonzero automatic-purge settings at startup.

Editable settings include application mode and region, proxy trust, palette, local registration, disabled-by-default CAC/PIV settings, session bounds, capacity limits, attachment policy, retention, and first-party aggregate experience metrics.

Secrets do not belong in YAML. Keep these in the hosting provider's secret manager:

- `VANTAGE_SETUP_TOKEN` — random first-run secret, at least 24 characters
- `VANTAGE_OPERATOR_ID` — preferred immutable operator account UUID
- `VANTAGE_OPERATOR` — temporary canonical-username fallback
- `VANTAGE_CAC_PROXY_SECRET` — high-entropy secret shared only with the approved mTLS identity proxy

Host-specific environment variables such as `PORT`, `NODE_ENV`, `TRUST_PROXY`, `VANTAGE_DB`, and `VANTAGE_DATA_MODE` remain available. Copy `.env.example` for local development.

## Local development

Requirements: Node.js 22 and npm 10 or pnpm 10.

```bash
npm ci
cp .env.example .env
npm run dev
```

The development command starts the API and Vite together. The frontend proxies `/api` to the API process. Do not use production data in a development database.

To build and run the production shape locally:

```bash
npm run build
NODE_ENV=production VANTAGE_DB=/absolute/path/vantage.db npm start
```

Production first-run setup requires `VANTAGE_SETUP_TOKEN`. After creating the initial owner, set `VANTAGE_OPERATOR_ID` to the account UUID shown by `/api/me` and remove the username fallback when practical.

## Deployment

### Docker

```bash
docker build -t vantage:3.5.0-rc.2 .
docker run --read-only --tmpfs /tmp \
  -p 8080:8080 \
  -v vantage-data:/data \
  -e NODE_ENV=production \
  -e VANTAGE_DB=/data/vantage.db \
  -e VANTAGE_SETUP_TOKEN='<random-secret>' \
  -e VANTAGE_OPERATOR='<bootstrap-username>' \
  vantage:3.5.0-rc.2
```

Use TLS at the trusted edge, an encrypted persistent volume, centralized platform logs with restricted access, and off-host encrypted backups. Never deploy SQLite on an ephemeral filesystem.

### Render

`render.yaml` provisions one web service and a persistent `/data` disk in evaluation mode. Set the operator binding in the Render dashboard. Confirm the chosen service region is in the United States and matches the approved hosting decision.

### Fly.io

`fly.toml` targets `dfw`, forces HTTPS, keeps one machine available, and mounts `vantage_data` at `/data`. Create the volume and secrets before the first deploy.

Do not run more than one application replica against the same SQLite database. Migrate to PostgreSQL before horizontal scaling.

## CAC/PIV target

The CAC/PIV endpoint is implemented but disabled. It accepts identity only from an approved certificate-verifying reverse proxy that verifies the certificate, strips browser-supplied identity headers, injects trusted identity headers and a proxy secret, and forwards over a protected hop.

Existing password identities require an explicit operator-controlled link before the same username can sign in through CAC/PIV. Enabling the adapter is a deployment and authorization project, not a YAML-only switch.

## Attachments

Attachments are optional supporting material, never a completeness requirement. The server enforces record authorization, byte-based file inspection, size and count limits, forced download disposition, audited access, and soft deletion. PDF, PNG, JPEG, TXT, and CSV are allowed by default. Files are stored in SQLite so database backups remain complete.

The evaluation defaults permit 10 files per activity and 10 MB per file. Reassess capacity, malware-scanning, and content-disarm requirements before broader use.

## Experience metrics

VANTAGE stores only allow-listed daily aggregate event counts. It does not store user IDs, session IDs, IP addresses, route parameters, record IDs, filenames, file content, or free text in the metrics table. There is no third-party analytics SDK. Platform access logs remain part of the hosting boundary and must be configured separately.

## Backup and recovery

The Instance Operator can download a consistent SQLite snapshot from Settings. Every backup is audited. Store backups encrypted, off-host, access-controlled, and tested through restoration drills.

Restore procedure:

1. stop the application process;
2. make a protected copy of the current database and any `-wal`/`-shm` companions;
3. verify the selected backup hash and ownership;
4. replace the mounted database file;
5. start one application instance; and
6. verify `/api/health`, schema version, sign-in, recent records, attachments, and the audit log.

Lost-operator recovery requires shell access and an explicit flag:

```bash
VANTAGE_RECOVERY=1 npm run recover -- <canonical-username>
```

The command prints a one-time password, revokes existing sessions, forces password replacement, and writes an audit event.

### Authorized factory reset and initial provisioning

Factory reset is shell-only and deliberately requires two independent signals of
intent. It validates that the target is a Vantage SQLite database, creates a
mode-`0600` backup beside the live database, runs SQLite integrity verification,
deletes all application rows in one transaction, rebuilds normal reference data,
and then verifies exactly zero users, one `MFR` unit, and the six default roles.
Before reading or changing the database it creates a database-adjacent maintenance
lock; while that lock exists, every API endpoint except `/api/health` returns 503.

```bash
VANTAGE_FACTORY_RESET=1 npm run reset:factory -- \
  --confirm "WIPE ALL LIVE DATA"
```

The verified backup is retained under `<database-directory>/backups/`. Never
leave `VANTAGE_FACTORY_RESET` configured on a service; set it for only this
command. A failure leaves maintenance active and preserves the private input for
inspection; do not manually reopen the service until the database is verified.

For a controlled initial roster, place the data in a temporary JSON file on the
deployment host, protect it with `chmod 600`, and run:

```bash
VANTAGE_PROVISION=1 npm run provision:accounts -- \
  --input /tmp/vantage-provision.json --delete-input
```

The provisioning command runs only against a freshly reset database. It creates
the supplied unit hierarchy, unit-local default role copies, billets, accounts,
memberships, assignments, and explicit Unit Leaders in one transaction. Every
local password is hashed with scrypt, every account must change its temporary
password at first sign-in, and passwords are never printed. After successful
verification, the command deletes the private input and releases maintenance.
Real names, emails, or temporary passwords must never be committed to either a
public or private source repository. Restart the service before sign-in.

To use the normal first-run owner flow instead of batch provisioning, release
maintenance only after the reset has produced the verified empty baseline:

```bash
VANTAGE_MAINTENANCE=1 npm run maintenance:off -- \
  --confirm "OPEN VANTAGE"
```

This command refuses to reopen any database that contains users, a different
unit structure, role drift, integrity errors, or foreign-key violations.

## Verification

```bash
npm run lint
npm test
npm run build
```

The automated suite covers configuration validation, attachment inspection, static authorization invariants, CSV hardening, domain logic, API behavior, multi-role scenarios, escalation attempts, the permission matrix, exact-unit tenancy, and migration of a captured v3.3 fixture.

Browser suites are also provided with `npm run test:browser`. They exercise signed-in routes, security-sensitive flows, accessibility, mobile overflow, and navigation. Complete a human keyboard and screen-reader pass before broad release.

## Production gates

The code can be deployed for controlled evaluation, but “deployable” is not the same as “authorized.” Before real operational use:

1. obtain sponsoring-authority and data-owner decisions;
2. complete privacy, records-management, legal, OPSEC, and cybersecurity review;
3. document the system boundary, data flows, administrators, and incident response;
4. select an approved US-region environment and verify encryption, logging, backup, vulnerability-management, and support controls;
5. complete CAC/PIV integration and identity-linking procedures;
6. define retention and legal-hold policy despite the current no-automatic-purge setting;
7. add malware scanning or content-disarm controls if attachment risk requires them;
8. migrate to PostgreSQL before horizontal scaling or an official shared-service architecture; and
9. complete MCEN integration and the applicable RMF/ATO process.

## License and ownership

No license is granted by this README. Confirm intellectual-property, government-work, branding, and distribution requirements before publication or official adoption.
