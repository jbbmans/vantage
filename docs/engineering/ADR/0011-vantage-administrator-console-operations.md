# ADR-0011 · Vantage Administrator console: enterprise operations

**Status:** accepted · **Date:** 2026-10-08 · **Builds on:** [ADR-0006](0006-centralized-tenancy-and-authority.md),
[ADR-0007](0007-mcen-enterprise-deployment-and-unit-instances.md),
[ADR-0010](0010-vantage-administrator-and-unit-manager.md)

## Context

Task 5 of the governing specification (VANTAGE_CLAUDE_MASTER.md) asks for an enterprise operations console
that includes, as authorized, Unit Instances, application version, schema version, health, backup status,
migration status, feature flags, authentication health, enterprise audit, controlled maintenance and Unit
Manager assignment, and that avoids unnecessary visibility into operational records.

The Vantage Administrator console on `main` at `2710d42` already had:

- **Unit Instances** as containers: status, counts, Lead Unit Managers, last activity, Vantage access
  requests (ADR-0006).
- **Unit Manager assignment**, any time, never yourself (ADR-0010 §5).
- **The version and schema number** on the overview, and a public `/api/health` that says whether the
  database answers.
- **The audit chain** verified on the overview, and the platform trail as the latest 300 entries,
  filtered in the browser and downloaded from the browser's copy.
- **A maintenance switch** (`runtime.maintenance`) under Settings and again under Backup and recovery,
  with no reason, no notice to the other staff, and no message for the people it stops. It sat behind
  `platform.settings` with the service's name and announcement.
- **Runtime switches** (self-registration, self-service Unit Instances, attachments, the MARADMIN feed,
  AI) on Settings and the AI page, and deployment flags only in the environment.

What it did not have:

- a health check beyond "the database answers";
- a record of backups beyond the time of the last browser download (`meta.last_backup_at`), so a backup
  taken on the server, the way MCEN takes them, left no trace;
- any record of which migrations ran, when, or under which build;
- any view of the scheduled jobs (expiry sweep, mail retry, case anchors), whose failures went only to
  the log;
- any view of whether CAC, organization sign-in or second factors still work: an expired CRL refuses
  every card its CA issued, and nothing said so before the first Marine was turned away;
- an audit trail that could be searched or paged past its latest 300 entries, or exported as a record.

## Decision

### 1. Where each item lives

| Specification item | Console page | Permission |
|---|---|---|
| Unit Instances | Unit Instances (unchanged) | `platform.view`, `platform.orgs` |
| Unit Manager assignment | Unit Instances → Unit Managers (unchanged) | `platform.managers` |
| Application version, schema version | Operations → Build, Schema and migrations; one line on Overview | `platform.view` |
| Health | Operations → Health; a strip on Overview | `platform.view` |
| Backup status | Operations → Backups; Backup and recovery | `platform.view` (status), `platform.data` (taking one) |
| Migration status | Operations → Schema and migrations | `platform.view` |
| Feature flags | Feature flags | `platform.view` to read, `platform.settings` to change |
| Authentication health | Sign-in health | `platform.view` |
| Enterprise audit | Audit trail | `platform.audit` |
| Controlled maintenance | Maintenance; a banner on every page while it is on | `platform.view` to read, `platform.maintenance` to act |

Every route is under `/api/platform`, behind staff and a recent step-up like the rest of the console, and
each checks its permission on the server (`requirePlatform`). The client hides what a role cannot use.

### 2. Health

`GET /api/platform/operations` runs `healthReport` (`server/services/operations.ts`). Each check is `ok`,
`warn`, `fail` or `info`, and the service's status is the worst of them:

- **Database:** it answers, and its size against `VANTAGE_MAX_DB_BYTES` (attention at 80%, failing at
  100%, where new records already pause).
- **Disk:** free space where the database lives (attention under 15%, failing under 5%).
- **Schema:** the database's schema against this build's (section 3).
- **Audit trail:** the chain verifies; audit forwarding is on, connected and dropping nothing. On MCEN,
  forwarding off needs attention.
- **Backups:** section 4.
- **Email:** sent and failed in the last day, and whether queued mail has waited more than six hours.
- **Scheduled jobs:** section 5.
- **Sign-in:** revocation lists, trusted CAs and staff second factors (section 6).
- **Maintenance:** on, and whether it ran past its expected end.
- **Unit Instances:** an active one with no Lead Unit Manager.

The public `/api/health` is unchanged: whether the service and its database answer, for the platform's
probe. The full report is for staff.

### 3. Build, schema and migrations

- **Release history.** Each start records the version and build (`RENDER_GIT_COMMIT`, `VANTAGE_BUILD_ID`
  or the client bundle's hash) in `meta.release_history` when they differ from the last start's. The
  last 20 are kept. The page shows when each build first served this database.
- **Migration history.** `migrate()` already ran each migration in its own transaction. Each now also
  appends `{ id, name, at, ms, version }` to `meta.migration_history` in that transaction, so a migration
  and its record land together or not at all. A database that migrated before this records from which
  schema its history begins (`meta.migration_history_since`). The page lists every migration this build
  carries, whether it ran, when, how long it took and under which version.
- **Ahead and behind.** A database at a newer schema than the build (an older build started after an
  upgrade) needs attention: the old build runs, but on a schema it was not written for. Behind cannot
  persist, since starting migrates.
- **Migration 019** adds `idx_audit_action ON audit_log(action, at)`, for the sign-in counts and the
  audit filter.

### 4. Backups

- **What is recorded.** A download from the console and `npm run backup` on the server each append
  `{ at, method, bytes, by, file }` to `meta.backup_history` in the database they copied (last 20).
  `scripts/backup.ts` opens the live database after the copy is made. If recording fails, the backup
  still succeeds and the script says so. `server/services/backupLog.ts` imports only the database
  helpers, so the script needs no application context.
- **Fresh or stale.** A backup older than `VANTAGE_BACKUP_MAX_AGE_HOURS` (default 168, weekly, as the
  run book says) or none at all needs attention.
- **What is not recorded.** A snapshot the hosting environment takes on its own never passes through
  Vantage. The page says so, and I-28 asks whether MCEN can report one.
- **Who is named.** Which Lead Vantage Administrator downloaded a backup is shown only to holders of
  `platform.data` or `platform.audit`.

### 5. Scheduled jobs

`startSchedulers` wraps each job in `trackedJob`, which records its runs, failures, last run, last
success, last error (shortened) and duration in memory for this process. The log lines are as before. A
job that fails on its last run, or has not run for twice its interval plus a minute, needs attention. No
scheduled jobs in the process at all needs attention too, since nothing sweeps expired access, sessions
or mail then.

### 6. Sign-in health

`GET /api/platform/sign-in-health` (`server/services/signInHealth.ts`):

- **CAC in direct mode.** Every CRL in `CAC_CRL_DIR` is read with its issuer, `thisUpdate` and
  `nextUpdate`, from the DER (`crlDates` in `server/auth/crl.ts`; Node has no CRL parser). No list, an
  unreadable list or a list past its next update is failing: past it, the TLS layer refuses every card
  that CA issued. Within 48 hours of it
  needs attention. That threshold is ours, not a DoD figure: it means the refresh job has stopped.
  Every CA in `CAC_CA_BUNDLE` is listed with its expiry (attention within 30 days, failing once every CA
  has expired).
- **CAC in proxy mode.** The gateway checks revocation; Vantage cannot see its lists and says so.
- **Organization sign-in.** The issuer's host, how first sign-ins link, and **Check the provider**: the
  discovery document read fresh and the keys it publishes (`probeProvider`). Audited as `oidc_checked`.
  It reaches only the configured issuer.
- **Lockout policy**, accounts locked now, open sessions by method.
- **Second factors:** Vantage staff with no authenticator or passkey (attention), and Unit Managers who
  sign in with a password alone (a note).
- **The last 24 hours** from the platform trail: sign-ins by method, lockouts, cards refused,
  organization sign-ins refused, people turned away from a console, card confirmations refused.

All of it is counts, dates and configuration. Nobody is named; account support finds the people.

### 7. Feature flags

`GET /api/platform/flags` lists the platform-level switches in one place:

- **Runtime flags**, changed here by `platform.settings`: self-registration, self-service Unit Instances
  and their limit, attachments, the MARADMIN feed and AI. Each shows what the deployment profile locks
  (`lockedRuntime`), what it cannot do without (AI without a model key), the connection it opens and how
  MCEN treats it, and who last changed it. A change goes through `PUT /runtime` as before, after a
  confirmation.
- **Environment flags**, read-only: the public site, browser backups, the consent banner, CAC only,
  organization sign-in only, provisioning from CAC or organization sign-in, spreadsheet intake and a
  required malware scan.
- **The audit trail keeps before and after.** `edit_configuration` now records each switch or short value
  as `key: before → after` (for example `attachmentsEnabled: true → false`), and longer settings by name.

Flags are service-wide. A Unit Instance's own settings are its Unit Managers' (Task 6), and nothing here
turns a feature on for one Unit Instance.

### 8. Controlled maintenance

- **Its own permission.** `platform.maintenance`, held by Lead Vantage Administrators and Vantage
  Administrators; `platform.settings` no longer switches maintenance. `PUT /runtime` with `maintenance`
  is refused (`use_maintenance`).
- **A reason.** `POST /api/platform/maintenance` with `enabled: true` requires a reason of at least ten
  characters. It may carry a message for everyone else (up to 240 characters) and an expected end within
  a week. The window (`runtime.maintenanceWindow`) records who started it and when. Starting twice is
  refused (`maintenance_on`).
- **Everyone else is told what and until when.** Every refused request's 503 and the sign-in page carry
  the message and the expected end in the deployment's time zone. The reason stays with staff and the
  audit trail. Maintenance ends only when somebody ends it; an expected end that passes needs attention.
- **Ending** may leave a note. Ending when it is off changes and records nothing.
- **Audited and told.** `maintenance_on` records the reason and the expected end; `maintenance_off`
  records how long it lasted and the note. The other staff are told each time.
- **Database tasks**, an allowlist (`MAINTENANCE_TASKS`), never a statement typed in: check the database
  for damage (`quick_check`), check references (`foreign_key_check`), fold the write-ahead log in
  (`wal_checkpoint(TRUNCATE)`), refresh query statistics (`optimize`), clear expired sessions, verify the
  audit trail and case histories, and compact the database (`VACUUM`). Compacting holds the database for
  its whole run, so it runs only during maintenance, and only with free disk of 1.2 times the database.
  Each run is audited as `maintenance_task` with its result. Results are counts and table names.
- **Who sees what.** Every staff role sees the window and the history; only `platform.maintenance` acts.

### 9. Enterprise audit

- `GET /api/platform/audit` filters on the server, by text (action, detail, usernames, an exact IP or
  entity id), action and UTC dates, and pages back with `before`. The chain is verified, and the list of
  actions read, on the first page only.
- `GET /api/platform/audit/export?format=csv|json` exports the filtered trail (up to 50,000 rows) and is
  itself audited as `platform_audit_exported` with the filter and the row count. CSV cells a spreadsheet
  would run as formulas are written as text.
- The platform trail stays what ADR-0006 made it: what staff did, sign-ins and access requests. A Unit
  Instance's internal actions stay in its own trail.

### 10. Visibility

- No page or route added here reads a record, a comment, a file or a work item. Counts at most.
  `tests/server/adminConsole.test.ts` writes a marker into a Unit Instance's records and checks that no
  platform read returns it.
- **The overview's recent email** names recipients only to `platform.email` holders.
- **Who took a backup** is shown only to `platform.data` and `platform.audit` holders.
- **Maintenance reasons** stay with staff; everyone else reads the message.

## Consequences

- One schema migration (019, an index). `meta` gains `release_history`, `migration_history`,
  `migration_history_since` and `backup_history`; `last_backup_at` is still written for anything that
  reads it. `runtime` gains `maintenanceWindow`, which is dropped on load whenever maintenance is off.
- New audit actions: `maintenance_task`, `oidc_checked` and `platform_audit_exported`. `maintenance_on`
  and `maintenance_off` now carry details. `edit_configuration` details show before and after.
- New configuration: `VANTAGE_BACKUP_MAX_AGE_HOURS`.
- New permission `platform.maintenance`. Lead Vantage Administrators and Vantage Administrators hold it
  through their roles, so nobody loses anything on upgrade.
- `POST /api/platform/maintenance` now needs `platform.maintenance`, and a reason to start. A script that
  sent `{ enabled: true }` alone is refused with a validation error.
- Job tracking is per process and starts empty on each start. Several processes on one database each
  report their own.
- **Not done here, by design:**
  - per-Unit-Instance version, backup and restore, which belong to Task 8;
  - auditing of deployments, configuration and migrations as their own events, and separation of duties
    (a second person for maintenance or a backup), which belong to Task 7;
  - Unit Instance settings, which belong to Task 6.

## Alternatives considered

- **A free-form SQL or shell console for maintenance.** Rejected: a typed statement is a way around every
  permission and boundary in the service. An allowlist covers the routine work, and anything else is done
  on the host under its own controls.
- **Leaving maintenance under `platform.settings`.** Rejected: closing the service to every Unit Instance
  is not the same act as renaming it, and the specification lists controlled maintenance separately.
- **Exposing the full health report at `/api/health`.** Rejected: it names configuration and counts that
  are for staff. The platform's probe needs only whether the service answers.
- **Per-Unit-Instance feature flags.** Not now. The specification puts Unit Instance settings in the Unit
  Manager console (Task 6), and a flag per instance would let staff change how one command works without
  its Unit Managers.
- **Recording backups in a table rather than `meta`.** Rejected for now: twenty entries need no schema,
  and the script must write them without the application.
