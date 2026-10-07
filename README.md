# Vantage

**Do the work once. Keep the record. Know what comes next.**

Vantage is a Marine Corps work, accountability, performance-record and career-development platform. A Marine claims work, researches and completes it, and keeps an attributed record of their part without retyping it. A leader sees workload, waiting and blockers without a roll call. The same Marine logs what happens outside a tasker, keeps goals, plans their career, and builds supported JEPES or FITREP input.

Five destinations: **Today · Work · Record · Goals · Career**, the **Reference**, and **Team**: your fire team and the command above it.

- **Today**: your work with its next step, what is waiting on someone else, what is open to claim, what changed, quick capture, and your goals and next career step. Leaders see their section first: unassigned, overdue, blocked and waiting work, and who holds what.
- **Work**: the queue of tasker items (open work, open to claim, mine), taskers and projects, tasks, and correspondence. Each item has its own page with an append-only history. Every claim, handoff, stage, wait, observation, decision, submission, funds check and verification is attributed and dated.
- **FMRA procedures**: the 2-Way UMT (v0.2.0, an unvalidated SME walkthrough) plus eight procedures from the FMRAC training reference (OCMT, UDOU, DOU, OTO, the four-stage UMT, invoice holds, feeder rejects, interface errors), each pinned per case, with cited steps, conditional branches, evidence gates shown before they refuse, calculations in exact cents that go stale when an input is corrected, and resolution only on a verified outcome.
- **Reference**: the FMRA desk reference inside the app (lifecycle, purchase methods and their supporting documents, normal and abnormal conditions, roles and separation of duties, data elements, glossary, limits), every statement cited and labelled source, editorial or discrepancy, and a balance **diagnoser** that reads commitment, obligation, delivered and paid in the reference's order and opens a case with the figures already recorded.
- **Record**: assigned work (claiming is not credit), contributions counted from the work's own history (one document counts once), your own entries, and private accomplishment drafts built only from your own cited facts.
- **Goals** and **Career**: measurable goals; a private plan with next steps that record where their guidance came from and whether anyone checked it; training, awards, counseling and readiness.
- **Views**: switch between the whole command and each team beneath it (press `V`). Leaders see a command rolled up across its teams; Marines see an overview of their team and their command, with totals from fewer than three people withheld.
- **Team → Workload**: section totals and per-person counts beside definitions and stated limits. People are never labelled.

See `docs/product/` for the product, `docs/domain/` for the financial model and SME questions, `docs/PROGRESS.md` for status, and `docs/demo/BOARD_DEMO.md` for the demonstration script.

## One service, organizations as tenants

Vantage runs as one central service at vantageusmc.com, operated by the Vantage team, for many commands ([ADR-0006](docs/engineering/ADR/0006-centralized-tenancy-and-authority.md)).

- **Organizations.** Each command or staff section is an organization: a tree of units with its own members, roles, personnel feed, retention schedules, legal holds and audit trail, kept apart from every other organization's.
- **Accounts belong to the Marine.** One account follows a person between commands; their private entries, career plan and export stay theirs.
- **Three tiers of authority, none implying another.**

  | Tier | Who | Runs | Never |
  |---|---|---|---|
  | Platform roles | Vantage staff (owner, admin, support, auditor) | The service: organizations as containers, settings, sign-in help, email, AI, integrity, backups | An organization's data, unless it approves time-limited, read-only access |
  | Organization roles | A command's owners, administrators, records officers, auditors | Its members, units, unit roles, roster feed, retention, holds, audit trail, export, access approvals | Marines' records, unless they also hold a unit role that reads them |
  | Unit roles | The chain of command | The work and records shared with a unit, down the chain | Anything above their units, or in another organization |

- **Grants can end on a date**, and "Why can they?" names every grant behind a person's authority.
- **Two consoles.** The **Vantage admin dashboard** (`/admin`) is for Vantage staff. The **owner console** (`/console`) is for an organization's owners and administrators. Each is its own app, and the API behind each answers only its own audience.

## Access modes

| `VANTAGE_ACCESS_MODE` | What it is |
|---|---|
| `accounts` (default) | Real accounts: passwords, passkeys, TOTP, optional CAC. Evaluation and operation. |
| `demo` | The synthetic demonstration. No sign-in form: each visitor gets a disposable workspace of invented people and records, removed after 24 hours. Refused in production, on a database with real accounts, and alongside CAC, email, AI or outbound feeds. |

```bash
# Synthetic demo on this machine
npm ci && npm run build
VANTAGE_ACCESS_MODE=demo VANTAGE_DB=:memory: VANTAGE_EMAIL_PROVIDER=none npm start   # http://localhost:8787
```

## Everything else Vantage does

Nothing from the earlier product was removed. It moved: activities are under Record → Your entries, and Readiness is under Career. See `docs/product/FEATURE_PARITY.md`.


- **Analyst-grade reports.** The Reports page's Analysis tab and its PDF read the record the way a board or a reporting senior would: period against prior period, run rate and pace, monthly trend, composition by area, category, value type, system and organization, concentration of value, logging cadence, coverage and data quality, goals, career record, the narrative and bullet package, and a full entry ledger as the appendix.
- **Complete export.** Settings → Your data downloads everything tied to an account as a zip: profile, rank, units and roles, every record including the recycle bin, readiness, attachments, notifications, preferences, audit trail, AI usage, email history; one JSON file plus a CSV per dataset.
- **Configurable metrics.** The admin dashboard's Metrics page renames the money metric, defines the value types that roll into the headline total, and sets the categories and unit suggestions, so shops other than a comptroller section can track what they actually do.
- **Quick Log.** Press `N`, type "Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday". Vantage extracts the date, quantity, dollars, system, category, and evaluation area. Works offline; entries queue on the device and sync later.
- **Records.** Filter by period, category, area, and quality (missing outcome, untagged, duplicates). Edit, attach evidence files, restore from a 30-day recycle bin.
- **JEPES and FITREP input.** Section I narrative to the character limit, bullet package by area, period-over-period comparison, PDF and CSV export. JEPES for E-1 to E-4, FITREP for E-5 and up, switchable.
- **Work.** One destination for everything with a next action, in four tabs. *Queue*: bring a spreadsheet in and the rows become work a team can hold — sort, filter, claim, act, and have the action write your own record; the original workbook is never modified, and reimporting the same file changes nothing. *Taskers and projects* and *Tasks*: what it rolls up to and what you owe. *Correspondence*: the emails behind the work, linked to the work they are about, where a reply, the knowledge you asked for, and a closed matter are three separate facts with three separate dates — import saved `.eml` files, or connect a Microsoft 365 mailbox read-only, in the national cloud you name.
- **Skill, not dependence.** Vantage checks your work; it does not do your thinking. The balance diagnoser has a read-it-yourself-first mode that hides its reading until you name the open condition, then tells you whether you matched. A case calculation takes your own figure first and compares. Your Record lists the procedures you have worked and how many reached a verified outcome: evidence of what you can do that holds up without the tool in the room.
- **Less friction.** Search offers what you opened recently, Today shows where you left off, any entry can be logged again as a starting point, a first-week list walks new accounts through what matters, and hours typed into an entry total with hours logged.
- **Reports.** Two tabs over one body of evidence. *Packages*: write against the records it cites; every save re-reads those records inside the same transaction and refuses if one changed, so an exported revision is provably what was reviewed. *Analysis*: what the record actually shows, before you claim it.
- **AI where the work is.** Drafting help sits on the page you are working on rather than in a separate destination, and every result says what it cost. Nothing is saved without you pressing save.
- **Usage and reliability.** The admin dashboard reports whether the product is working: adoption, where captures are abandoned, import conversion, failures. It reports counts across people, never a person's row, and it cannot hold anything anyone typed.
- **Goals and Career.** Goals that update themselves from the log; training hours, the award pipeline from recommendation to presentation, counselings with acknowledgement, and the MARADMINs that change what any of it requires.
- **Readiness.** JEPES pillars or FITREP attribute coverage, plus ranked coaching on where the points are, with citations to the governing orders.
- **Team.** Roster, unit dashboard built from shared entries only and rolled up from the teams beneath a command, roles with per-unit permissions that flow down the chain of command, moving a Marine between teams in one audited step, emailing the whole team from Vantage's own domain, invitations by link or email, access log.
- **Email from your own domain.** Vantage can deliver its own mail straight to each recipient's mail server, DKIM-signed with a key it generates, with no email service. The admin dashboard's Email page shows the DNS records to publish, checks them, tests the path out, and retries mail a receiver asks to resend later. From the owner console's People page an organization's administrators can email everyone their sign-in details: their username and a one-time link to choose a password, never a password itself.
- **CAC / PIV sign-in.** Optional certificate sign-in in either a direct-mTLS or behind-a-gateway shape, binding on the EDIPI alone and counting as both factors. Off by default; proxy mode refuses to start without a shared secret, because a forged header would otherwise be a sign-in as anybody. See `docs/cac-and-records.md`.
- **Authoritative personnel.** A roster extract from an upstream personnel system becomes the source for rank, unit, MOS and EAS; those fields stop being self-editable, every change is audited field by field, a sync never deletes anybody, and an extract that would separate a large share of the roster stops and asks.
- **Records management.** Retention schedules with their citation, legal holds that suspend every deletion path (scheduled disposition, the recycle-bin purge and source-file pruning alike) and always win, previews before anything acts, and disposition evidence for every run. Nothing disposes until somebody enables it.
- **Privacy inventory.** A PIA data inventory generated from the live schema, with every table declared, so it cannot quietly stop being true; unclassified and stale columns are reported as the gaps they are.
- **Security.** 15-character minimum passwords (PBKDF2-HMAC-SHA256, FIPS approved), passkeys (WebAuthn), TOTP with recovery codes, a lockout after three failures kept in the database, 15-minute idle sessions (10 in either console), the DoD Notice and Consent Banner on request, step-up confirmation for sensitive settings, device session list, CSRF and rate limiting, HMAC-chained audit log that can be copied to a SIEM as it is written, a signed hash chain over every case history, malware scanning of every upload through clamd, and a secret that can be rotated. Access to a unit's work follows current membership and flows down the chain of command, never up. Private records are never readable through the app by leaders, organization owners or Vantage staff.
- **Owner console.** One organization at a time: its people and organization roles, units and their leaders, the personnel feed, retention and holds, Vantage access approvals, the privacy inventory, its audit trail and a structure export.
- **Vantage admin dashboard.** Organizations, sign-in help for any account, Vantage staff, access requests, platform settings, metrics, AI, email, usage, the platform audit trail, platform-wide holds, backups and whole-service recovery.

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
| `npm run check` | lint (including the explicit-`any` budget in `scripts/any-budget.json`, which may only go down), typecheck, server tests, production build |
| `npm test` | server test suite (in-memory SQLite) |
| `npm run test:browser` | builds the client and runs the Playwright suite (desktop, phone, axe) |
| `npm run build` | production client into `dist/` |
| `npm start` | production server (`node server/index.ts`), serves `dist/` |
| `VANTAGE_RECOVERY=1 npm run recover-operator -- <username>` | make an account a platform owner and give it a temporary password, from the shell |
| `VANTAGE_FACTORY_RESET=1 npm run factory-reset -- ERASE-EVERYTHING` | delete the database; the next start runs first-time setup |
| `VANTAGE_START_OVER=1 VANTAGE_ADMIN_PASSWORD=… node scripts/start-over.ts ERASE-EVERYTHING --unit … [--roster file]` | erase everything in place, create a platform owner and the first organization, and import a roster; see [operations.md](docs/operations.md#starting-over) |

Requirements: Node 22.18 or newer. No build step for the server; Node runs the TypeScript directly.

## Deploy

Vantage is operated centrally by the Vantage team; commands do not install it. The service at https://www.vantageusmc.com runs on a Render web service (`render.yaml`, `Dockerfile`): one Node 22 process, a persistent volume, and TLS at the edge. It makes no outbound requests with the defaults (AI, the MARADMIN feed and IndexNow are off), and the browser loads nothing from third parties. PostgreSQL is the production target and is not yet implemented (`docs/engineering/ADR/0003-postgresql-migration-path.md`).

A database from before organizations is migrated in place at boot (migration `015_organizations`): each top-level unit becomes an organization, former Instance Operators become platform owners, and each organization's owner is its top unit's leader.

- [Render deployment](docs/deploy-render.md)
- [DNS: Namecheap and Cloudflare](docs/dns-namecheap.md)
- [Email (Resend or SMTP)](docs/email.md)
- [Search engines: what the code does, and Search Console and Bing setup](docs/seo.md)
- [Operations: backups, restore, recovery](docs/operations.md)
- [Security model](docs/security.md)
- [Architecture](docs/architecture.md)

## Configuration

Everything is an environment variable. `.env.example` lists them with defaults. The ones that matter in production:

| Variable | Purpose |
| --- | --- |
| `VANTAGE_PUBLIC_URL` | HTTPS origin of the service on one address: the public page, the app, the owner console at `/console` and the admin dashboard at `/admin` |
| `VANTAGE_SITE_URL`, `VANTAGE_APP_URL`, `VANTAGE_CONSOLE_URL`, `VANTAGE_ADMIN_URL` | Give each its own address instead (for example `www.`, `secure.`, `dev.` and `admin.`): the public page, sign-in and the app, the owner console, and the admin dashboard. Email links use the app's; the platform API answers only on the admin dashboard's host, an organization's only on the owner console's. Each falls back to the one before it (the admin dashboard to the console's host, at `/admin`), and the first to `VANTAGE_PUBLIC_URL`. See `docs/deploy-render.md` |
| `VANTAGE_RP_ID` | The domain passkeys belong to; by default the one the app and console share |
| `VANTAGE_SECRET` | 32+ random characters; signs tokens, encrypts MFA secrets, chains the audit log |
| `VANTAGE_SETUP_TOKEN` | 24+ characters; required once, to create the first platform owner and organization |
| `VANTAGE_PLATFORM_OWNERS` | Comma-separated usernames made platform owners at every start (`VANTAGE_OPERATOR` is the older name) |
| `VANTAGE_DB` | SQLite path on the persistent disk |
| `TRUST_PROXY` | `true` behind Render or any reverse proxy |
| `VANTAGE_EMAIL_PROVIDER` | `none`, `direct` (send from your own domain with no email service; see `docs/email.md`), `resend`, or `smtp` |
| `VANTAGE_AI_ENABLED`, `VANTAGE_GENAI_API_KEY`, `VANTAGE_GENAI_MODELS` | GenAI.mil drafting help and the model allowlist (off by default) |
| `VANTAGE_ACCESS_MODE` | `accounts` (default) or `demo` (synthetic, no sign-in; never in production) |
| `VANTAGE_DEMO_TTL_HOURS`, `VANTAGE_DEMO_MAX_WORKSPACES` | How long a demo workspace lasts, and how many may exist at once |
| `VANTAGE_MARADMIN_ENABLED` | The MARADMIN feed from marines.mil. Off by default: it is the only outbound request unless IndexNow is on |
| `VANTAGE_INDEXNOW` | Tell Bing, Edge, DuckDuckGo, Yahoo and Yandex when a deploy changes the public page (off by default). See `docs/seo.md` |
| `VANTAGE_GOOGLE_SITE_VERIFICATION`, `VANTAGE_BING_SITE_VERIFICATION` | Ownership tokens for Google Search Console and Bing Webmaster Tools |
| `VANTAGE_M365_CLIENT_ID`, `VANTAGE_M365_CLIENT_SECRET`, `VANTAGE_M365_TENANT` | Microsoft Entra application for read-only mailbox sign-in (off until set). See `docs/deploy-render.md` |

## Status

Vantage is not a system of record. Marine Online is. Point tables and orders change; the app cites what it relies on and never computes an official score.

See `NOTICE` for terms.
