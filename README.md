# VANTAGE 3.6

VANTAGE is a command-ready performance, productivity, career, and operational-record workspace built for Marine Corps teams. It gives every Marine a fast way to capture work as it happens, gives leaders an exact-unit view of authorized activity, and turns source records into useful dashboards, goals, evaluation inputs, bullet packages, and change reports.

VANTAGE is deliberately self-contained. Records stay on the deployment's server, reports are composed from stored facts, and no external generative AI, advertising network, or third-party analytics SDK receives application data.

## The VANTAGE experience

- **Command center:** a chart-first operational picture with recorded impact, transaction volume, completeness, work hours, next actions, attention items, recent activity, record health, goals, and a clickable fiscal tape.
- **Quick Log:** an always-available capture drawer that understands plain-language work entries and exposes the inferred date, quantity, units, dollar amount, transaction type, organization, system, evaluation area, visibility, outcome, and notes before save.
- **Records:** a searchable activity ledger with fiscal and calendar periods, quality filters, exact values, duplicate screening, import, export, soft deletion, restoration, and optional supporting files.
- **Work:** task and project workspaces with priorities, ownership, deadlines, status, progress, visibility, and exact-unit sharing.
- **Goals:** measurable targets with manual progress or automatic counting from matching activity categories.
- **Career:** a distinct progression workspace for Training & PME, Recognition, Readiness, Goals, and package preparation.
- **Readiness:** rank-aware JEPES and FITREP preparation views that separate official references, personal data, and coaching guidance without inventing an official score.
- **Report studio:** evaluation narratives, bullet packages, and period-over-period change reports with personal or authorized exact-unit scope, copy, download, print, and workbook export.
- **Team:** roster, assignment, membership, guest access, account lifecycle, session recovery, and access-review tools for authorized leaders.
- **Units and roles:** a readable organization tree plus editable unit-local roles, position hierarchy, additive permissions, and explicit unit ownership.
- **Settings console:** personal interface preferences, password and session management, access history, import/export, backup, aggregate experience metrics, and operator-managed runtime configuration.
- **Field guide:** a searchable in-app VANTAGE 3.6 operating guide that follows the signed-in Marine's JEPES or FITREP track.
- **Keyboard workflow:** `N` for Quick Log, `/` or `Cmd/Ctrl-K` for search and jump, `?` for shortcuts, and two-key `G` navigation.

## Designed for daily use

VANTAGE turns performance documentation into a short habit instead of an end-of-period reconstruction.

1. Press `N` when meaningful work happens.
2. Describe the action naturally: `Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday.`
3. Confirm the facts VANTAGE extracted and add the outcome.
4. Save once; Command, Goals, Career, Readiness, and Reports update from the same source.
5. Open Report studio when an evaluation, counseling session, award package, or command brief is due.

Quick Log and full record forms preserve in-progress work in the current browser session. Stale-edit protection shows the newest saved copy before an intentional overwrite, and server refresh failures leave the last loaded view in place with a visible retry action.

## Command center

The Command center follows an at-a-glance hierarchy: essential measures and the primary trend appear first, attention and recent activity follow, and customizable supporting views stay below the operational picture.

- Select This week, Last 12 weeks, Fiscal year, or All time.
- Switch the primary chart between Impact, Transactions, Hours, and Records.
- Open any metric or attention item to reach its supporting view.
- Drag Today, Fiscal tape, Record quality, and Goals into the order that fits the mission, then collapse or hide them from Display.
- Keep a personalized Command layout across devices through account preferences.
- Start an empty workspace through a direct Log first activity action instead of an uninformative zero chart.

## Exact-unit access model

VANTAGE treats every unit as its own authorization boundary.

- A self-registered account begins unattached and personal-only.
- Unit data appears only after an authorized leader creates an active membership in that exact unit.
- Personal records are owner-only and do not require a unit.
- Private records retain exact-unit context while remaining owner-only.
- Unit records are shared only with members holding the necessary permission in that exact unit.
- Org-chart parent and child relationships provide breadcrumbs and structure; they never cascade access.
- Roles are copied into each unit and configured from that team's Edit team workspace, including drag-and-drop hierarchy ordering and keyboard controls.
- The Instance Operator manages infrastructure recovery and approved instance settings without becoming a universal application-record reader.
- Protected cross-person reads, exports, backups, role changes, lifecycle actions, and configuration changes are audited.

A fresh database starts with Marine Forces Reserve (`MFR`, displayed as `MARFORRES`) and six editable unit-local roles: Marine, NCO, Fire Team Leader, SNCO, SNCOIC, and Unit Leader. It contains no subordinate organization, live personnel roster, or performance data.

## Personal and operator configuration

Every signed-in account can configure these options in Settings:

- light, dark, or device-matched theme;
- comfortable or compact information density;
- default Command reporting period;
- default Report period and opening format;
- focused or expanded Quick Log fields;
- ordered, visible, and collapsed Command sections;
- password and active sessions; and
- FITREP reporting preferences where applicable.

Instance Operators can apply these validated controls directly in the application:

- self-registration;
- attachment availability;
- per-file attachment size;
- files per activity;
- maximum guest-membership duration;
- default theme for the instance; and
- first-party aggregate experience metrics.

Security-sensitive controls stay deployment-managed: proxy trust, CAC/PIV identity headers, database paths, session policy, retention guarantees, and secrets. This keeps routine operation inside VANTAGE while preserving a reviewed boundary around infrastructure security.

## Architecture

- React 18, Vite, Tailwind CSS, Radix UI, Lucide icons, and Recharts
- Node.js 22 and Express 5
- SQLite through `better-sqlite3`, WAL mode, foreign keys, and versioned migrations
- One same-origin production process serving both the API and built application
- Opaque revocable sessions stored as one-way digests
- `scrypt` password hashing and a minimum 15-character local-password policy
- SameSite HttpOnly session cookies, CSRF defense-in-depth, CSP, HSTS in production, and layered throttling
- Docker, Render, and Fly.io deployment definitions
- First-party allow-listed aggregate experience metrics
- No external runtime fonts, AI service, advertising telemetry, or analytics SDK

SQLite provides a strong single-instance deployment shape. PostgreSQL is the planned datastore for horizontal scaling or a shared enterprise service.

## Quick start

### Requirements

- Node.js 22
- npm 10 or a compatible package manager
- a persistent writable path for the production database

### Development

```bash
npm ci
cp .env.example .env
npm run dev
```

The development command starts Express and Vite together. The web process proxies `/api` to the local API. Use synthetic data in development.

### Production-shaped local run

```bash
npm ci
npm run build
NODE_ENV=production \
VANTAGE_DB=/absolute/path/vantage.db \
VANTAGE_SETUP_TOKEN='<random-secret-at-least-24-characters>' \
VANTAGE_OPERATOR='<bootstrap-username>' \
npm start
```

Open the application, complete first-run setup, and bind the Instance Operator. `VANTAGE_OPERATOR_ID` is the preferred durable binding once the account UUID is known; `VANTAGE_OPERATOR` remains the canonical-username bootstrap option.

## Configuration

[`config/app.yaml`](config/app.yaml) contains the reviewed non-secret deployment configuration. The loader accepts a deliberately small YAML subset and rejects unknown settings, duplicate keys, unsafe ranges, unsupported syntax, and automatic personnel-record purging.

Common environment overrides include:

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP listen port |
| `NODE_ENV` | Development or production behavior |
| `VANTAGE_DB` | Absolute persistent SQLite path |
| `VANTAGE_DATA_MODE` | `evaluation` or `operational` |
| `TRUST_PROXY` | Trusted reverse-proxy hop configuration |
| `VANTAGE_SETUP_TOKEN` | Protected first-run setup secret |
| `VANTAGE_OPERATOR_ID` | Immutable Instance Operator account UUID |
| `VANTAGE_OPERATOR` | Bootstrap operator username |
| `VANTAGE_SELF_REGISTRATION` | Registration availability |
| `VANTAGE_CAC_ENABLED` | CAC/PIV adapter availability |
| `VANTAGE_AUTH_PROVIDER` | `password` or `cac_piv` |

Secrets belong in the hosting platform's secret manager, never in YAML or source control. CAC/PIV deployments also require a high-entropy `VANTAGE_CAC_PROXY_SECRET` shared only with the approved identity proxy.

## Deployment

### Docker

```bash
docker build -t vantage:3.6.0 .
docker run --read-only --tmpfs /tmp \
  -p 8080:8080 \
  -v vantage-data:/data \
  -e NODE_ENV=production \
  -e VANTAGE_DB=/data/vantage.db \
  -e VANTAGE_SETUP_TOKEN='<random-secret>' \
  -e VANTAGE_OPERATOR='<bootstrap-username>' \
  vantage:3.6.0
```

Terminate TLS at a trusted edge, use an encrypted persistent volume, restrict platform logs, and maintain encrypted off-host backups. Run one application replica per SQLite database.

### Render

`render.yaml` defines one web service, a persistent `/data` disk, explicit proxy trust, and evaluation mode. Configure the operator binding and secrets in the Render dashboard, then confirm the selected US region and disk mount before first-run setup.

### Fly.io

`fly.toml` targets `dfw`, forces HTTPS, mounts `vantage_data` at `/data`, and keeps a single machine available. Create the volume and secrets before deployment.

## CAC/PIV integration

The CAC/PIV sign-in path is built into VANTAGE and remains disabled until an approved certificate-verifying reverse proxy is in place. The proxy must:

1. verify the client certificate;
2. strip identity headers supplied by the browser;
3. inject the verified subject and identity fields;
4. include the shared proxy-verification secret; and
5. forward to VANTAGE over a protected hop.

Existing password identities require an explicit, operator-controlled link before the same username signs in through CAC/PIV. Password authentication can remain available during an approved transition or be disabled through deployment configuration.

## Attachments

Attachments provide optional supporting context without becoming a completeness requirement. The server enforces record authorization, byte-based inspection, configured type/size/count limits, forced download disposition, audited access, and recoverable deletion.

PDF, PNG, JPEG, TXT, and CSV are enabled by default. Files are stored with the application data so a consistent database backup includes the complete record.

## Import and export

Settings accepts CSV and TSV files, proposes a column map, validates required fields, and screens exact duplicates before creating records. Importing the same source twice does not duplicate the selected fiscal period.

Workbook and text exports include only records the current identity is authorized to read. Spreadsheet-formula prefixes are neutralized, and unit-wide exports require the exact-unit Export data permission.

## Backup, restore, and recovery

The Instance Operator can download a consistent SQLite snapshot from Settings while VANTAGE remains online. Every download is audited.

Restore procedure:

1. stop the application process;
2. preserve the current database and any `-wal` or `-shm` companions;
3. verify the selected backup hash and ownership;
4. replace the mounted database file;
5. start exactly one application instance; and
6. verify `/api/health`, sign-in, schema version, recent records, attachments, and audit history.

Lost-operator recovery requires shell access and explicit intent:

```bash
VANTAGE_RECOVERY=1 npm run recover -- <canonical-username>
```

The command creates a one-time password, revokes existing sessions, requires password replacement, and writes an audit event.

## Controlled reset and roster provisioning

Factory reset is a shell-only maintenance workflow protected by an environment flag and exact confirmation phrase. It validates the target database, creates a mode-`0600` backup, verifies integrity, resets application rows in one transaction, restores reference data, and confirms the empty baseline.

```bash
VANTAGE_FACTORY_RESET=1 npm run reset:factory -- \
  --confirm "WIPE ALL LIVE DATA"
```

For an approved initial roster, place the provisioning JSON in a protected temporary file and run:

```bash
chmod 600 /tmp/vantage-provision.json
VANTAGE_PROVISION=1 npm run provision:accounts -- \
  --input /tmp/vantage-provision.json --delete-input
```

The provisioner creates the unit hierarchy, unit-local roles, billets, identities, memberships, assignments, and explicit Unit Leaders in one transaction. Temporary passwords are hashed with `scrypt`, accounts must replace them at first sign-in, and passwords are never printed.

To reopen a verified empty baseline for the normal first-run flow:

```bash
VANTAGE_MAINTENANCE=1 npm run maintenance:off -- \
  --confirm "OPEN VANTAGE"
```

## Verification

```bash
npm run lint
npm test
npm run test:browser
```

The automated suite covers strict configuration parsing, runtime-configuration authorization, attachment inspection, password/session behavior, CSV hardening, domain logic, API contracts, stale edits, lifecycle recovery, permission matrices, escalation attempts, exact-unit tenancy, migrations, desktop routes, keyboard behavior, mobile layouts, console errors, and accessibility.

The standard server suite includes an isolated 50-account workload:

```bash
npm run test:load50
```

It creates fifty synthetic identities in a temporary database, signs every account in, performs 250 core writes and 250 authenticated reads, and verifies that personal records do not cross account boundaries. No deployed VANTAGE data is touched.

## Deployment governance

VANTAGE exposes an explicit `evaluation` mode for controlled testing with synthetic or specifically authorized information and an `operational` mode for an approved environment. A production program can pair the application with command sponsorship, data-owner approval, privacy and records-management decisions, an approved US-region host, encrypted backups, incident response, vulnerability management, CAC/PIV, MCEN integration, and the applicable RMF/ATO process.

## Ownership

VANTAGE was designed and built by John Bernard Boletz. No license is granted by this repository; confirm intellectual-property, government-work, branding, and distribution requirements before official publication or adoption.
