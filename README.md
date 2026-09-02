# Vantage 3.7

Vantage is a self-hosted performance, work, readiness, and career-record system for Marine Corps teams. It combines individual capture with exact-unit permissions, auditable administration, reporting, notifications, and official MARADMIN tracking.

## Capabilities

- Quick Log and structured performance records
- Work, goals, training, recognition, readiness, and reports
- Exact-unit memberships, roles, ownership, and audit trails
- Leader-managed profiles plus self-service rank update requests
- First-party notifications and a searchable command menu
- Cached MARADMIN ingestion from the official Marines.mil RSS feed
- Restricted owner console for safe, non-secret instance configuration
- Opt-in, exact-unit read-only API for approved enterprise integrations
- Confidential incident and vulnerability reporting with an operator-only triage queue
- Responsive light/dark interface with no advertising or third-party analytics

## Architecture

- React 18, Vite, Tailwind CSS, Radix UI, and Recharts
- Node.js 22, Express 5, and SQLite with versioned migrations
- A guarded SQLite-to-PostgreSQL preparation toolkit for the managed-database transition
- One production process serving the API and compiled application
- HttpOnly revocable sessions, `scrypt` password hashing, CSP, HSTS, CSRF checks, and audited protected actions
- Docker and Render deployment with a persistent disk

SQLite requires one application instance per database. Use a persistent, encrypted volume and tested off-host backups.

The application runtime is not yet PostgreSQL-capable. The [PostgreSQL migration path](docs/POSTGRESQL-MIGRATION.md) provides the canonical target schema, a verified transactional export/import package, Render provisioning guidance, and the mandatory runtime/cutover gates. It deliberately prevents a premature database switch.

## Development

Requirements: Node.js 22 and npm 10 or newer.

```bash
npm ci
cp .env.example .env
npm run dev
```

The local Vite server proxies `/api` to Express. Development is intended for synthetic or specifically authorized test information.

## Configuration

Reviewed non-secret defaults live in [`config/app.yaml`](config/app.yaml). Production secrets belong in the hosting provider’s secret manager.

| Variable | Purpose |
| --- | --- |
| `VANTAGE_DB` | Absolute persistent SQLite path |
| `VANTAGE_SETUP_TOKEN` | Protected first-run setup secret |
| `VANTAGE_OPERATOR_ID` | Durable owner-console account UUID |
| `VANTAGE_OPERATOR` | Bootstrap operator username |
| `VANTAGE_PUBLIC_URL` | Public application origin |
| `VANTAGE_ADMIN_URL` | Restricted owner-console origin |
| `VANTAGE_DATA_MODE` | `evaluation` or `operational` |
| `TRUST_PROXY` | Trusted reverse-proxy hop configuration |
| `VANTAGE_MARADMIN_ENABLED` | Enable official-feed ingestion |
| `VANTAGE_MARADMIN_REFRESH_MINUTES` | Feed cache interval |
| `VANTAGE_INTEGRATIONS_ENABLED` | Enable the approved read-only integration surface |
| `VANTAGE_INTEGRATION_REQUESTS_PER_15_MINUTES` | Per-client/source read limit |

CAC/PIV support remains disabled until an approved certificate-verifying proxy is configured. See `.env.example` and `config/app.yaml` for the full supported surface.

The enterprise API is disabled by default. Its credentials are created and revoked in the restricted Owner Console, are bound to one exact unit, and are shown only once. See [`docs/ENTERPRISE-API.md`](docs/ENTERPRISE-API.md) for the v1 contract and security boundary.

Security reports are visible only to the reporter and Instance Operator and never enter unit exports or integration responses. See [`docs/SECURITY-INCIDENTS.md`](docs/SECURITY-INCIDENTS.md) for lifecycle, access, audit, and operational boundaries.

## Render deployment

[`render.yaml`](render.yaml) defines a single Docker web service, one persistent `/data` disk, health checks, and these production origins:

- `https://vantageusmc.com`
- `https://admin.vantageusmc.com/operator`

After applying the Blueprint:

1. Confirm the service region, plan, and `/data` disk before first-run setup.
2. Set `VANTAGE_OPERATOR`, then replace it with the account UUID in `VANTAGE_OPERATOR_ID` after setup.
3. Point the apex domain to the Render hostname using the DNS provider’s ANAME/ALIAS record.
4. Point `admin` to the same Render hostname using a CNAME record.
5. Remove conflicting AAAA records and verify both domains in Render.
6. Keep the deployment in `evaluation` mode until the required operational approvals are complete.

Owner-console APIs are host-gated in production, so they only answer on the configured admin hostname.

## Backup and recovery

The owner console downloads a consistent, audited SQLite snapshot. To restore, stop the service, preserve the current database and WAL companions, replace the mounted database with a verified snapshot, then restart one instance and validate `/api/health`.

To prepare a PostgreSQL rehearsal package without changing the live database, run `npm run migrate:postgres:prepare -- --source /absolute/vantage.db --output /secure/vantage-postgres.sql`. The source is snapshotted read-only, integrity and audit checks run first, and existing output files are never overwritten.

Lost-operator recovery requires shell access and explicit intent:

```bash
VANTAGE_RECOVERY=1 npm run recover -- <canonical-username>
```

## Verification

```bash
npm run lint
npm test
npm run test:browser
```

The suite covers configuration, migrations, permissions, tenancy, lifecycle recovery, attachments, imports, API behavior, mobile layouts, accessibility, and multi-persona isolation.

## Rights and provenance

Vantage is proprietary and distributed without a license grant. See [`NOTICE`](NOTICE) and [`PROVENANCE.json`](PROVENANCE.json) for the canonical rights and source record.
