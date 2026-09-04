# Vantage

Performance records for Marines. Log what you did in one sentence, keep the evidence, and turn it into a JEPES or FITREP input, a bullet package, and a PDF when the evaluation comes due. Leaders see only what their Marines chose to share, and every look is logged.

Vantage 5 is a ground-up rewrite: TypeScript end to end, a fresh schema, passkeys and authenticator sign-in, offline capture on phones, counseling and award tracking, unit dashboards, weekly email digests, CSV that round-trips, and GenAI.mil drafting with the model of your choice.

## What it does

- **Analyst-grade reports.** The Reports page's Full analysis view and its PDF read the record the way a board or a reporting senior would: period against prior period, run rate and pace, monthly trend, composition by area, category, value type, system and organization, concentration of value, logging cadence, coverage and data quality, goals, career record, the narrative and bullet package, and a full entry ledger as the appendix.
- **Complete export.** Settings → Your data downloads everything tied to an account as a zip: profile, rank, units and roles, every record including the recycle bin, readiness, attachments, notifications, preferences, audit trail, AI usage, email history; one JSON file plus a CSV per dataset.
- **Configurable metrics.** The Owner console's Metrics tab renames the money metric, defines the value types that roll into the headline total, and sets the categories and unit suggestions, so shops other than a comptroller section can track what they actually do.
- **Quick Log.** Press `N`, type "Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday". Vantage extracts the date, quantity, dollars, system, category, and evaluation area. Works offline; entries queue on the device and sync later.
- **Records.** Filter by period, category, area, and quality (missing outcome, untagged, duplicates). Edit, attach evidence files, restore from a 30-day recycle bin.
- **Reports.** Section I narrative to the character limit, bullet package by area, period-over-period comparison, PDF and CSV export. JEPES for E-1 to E-4, FITREP for E-5 and up, switchable.
- **Work, Goals, Career.** Tasks and projects, goals that update themselves from the log, training hours, award pipeline from recommendation to presentation, counselings with acknowledgement.
- **Readiness.** JEPES pillars or FITREP attribute coverage, plus ranked coaching on where the points are, with citations to the governing orders.
- **Team.** Roster, unit dashboard built from shared entries only, roles with per-unit permissions, invitations by link or email, access log.
- **Security.** 15-character minimum passwords (scrypt), passkeys (WebAuthn), TOTP with recovery codes, step-up confirmation for sensitive settings, device session list, CSRF and rate limiting, HMAC-chained audit log. Private records are never readable by leaders or the owner through the app.
- **Owner console.** Instance settings, AI model allowlist, accounts, units, audit chain check, SQLite backup download, and a JSON export/import that moves the whole instance to any host.

## Run it locally

```bash
npm install
cp .env.example .env
npm run dev          # API on :8787, Vite on :5173
```

Open http://localhost:5173, create the owner account and first unit.

Scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | API with `--watch` plus the Vite dev server |
| `npm run check` | lint, typecheck, server tests, production build |
| `npm test` | server test suite (in-memory SQLite) |
| `npm run test:browser` | builds the client and runs the Playwright suite (desktop, phone, axe) |
| `npm run build` | production client into `dist/` |
| `npm start` | production server (`node server/index.ts`), serves `dist/` |
| `VANTAGE_RECOVERY=1 npm run recover-operator -- <username>` | grant owner authority and a temporary password from the shell |
| `VANTAGE_FACTORY_RESET=1 npm run factory-reset -- ERASE-EVERYTHING` | delete the database; the next start runs first-time setup |

Requirements: Node 22.18 or newer. No build step for the server; Node runs the TypeScript directly.

## Deploy

The reference deployment is one Render Starter web service with a 1 GB disk, auto-deploying from `main`, at https://vantageusmc.com. `render.yaml` describes it; `Dockerfile` builds it.

- [Render deployment](docs/deploy-render.md)
- [Namecheap DNS](docs/dns-namecheap.md)
- [Email (Resend or SMTP)](docs/email.md)
- [Operations: backups, restore, moving hosts](docs/operations.md)
- [Security model](docs/security.md)
- [Architecture](docs/architecture.md)

## Configuration

Everything is an environment variable. `.env.example` lists them with defaults. The ones that matter in production:

| Variable | Purpose |
| --- | --- |
| `VANTAGE_PUBLIC_URL` | HTTPS origin of the site; drives passkeys, cookies, and email links |
| `VANTAGE_SECRET` | 32+ random characters; signs tokens, encrypts MFA secrets, chains the audit log |
| `VANTAGE_SETUP_TOKEN` | 24+ characters; required once, to create the owner account |
| `VANTAGE_DB` | SQLite path on the persistent disk |
| `TRUST_PROXY` | `true` behind Render or any reverse proxy |
| `VANTAGE_EMAIL_PROVIDER` | `none`, `resend`, or `smtp` |
| `VANTAGE_AI_ENABLED`, `VANTAGE_GENAI_API_KEY`, `VANTAGE_GENAI_MODELS` | GenAI.mil drafting help and the model allowlist |

## Status

Vantage is not a system of record. Marine Online is. Point tables and orders change; the app cites what it relies on and never computes an official score.

See `NOTICE` for terms.
