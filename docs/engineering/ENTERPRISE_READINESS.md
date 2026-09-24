# Enterprise readiness

What an organization evaluating Vantage for real use can rely on today, what is partial, and what
waits on a decision only the owner can make. Written 2026-09-24 against version 5.0.0, schema 9.

Vantage holds no DoD, USMC, RMF, ATO or other security accreditation and claims none. Nothing below
says otherwise.

## At a glance

| Area | Status |
| --- | --- |
| Access levels and people management | **In place** |
| Sign-in, MFA, sessions | **In place**; single sign-on needs an owner decision |
| Audit | **In place** |
| Privacy controls, retention, legal holds | **In place** |
| Health probes, backups, restore, move | **In place** |
| Migrations | **In place** |
| Accessibility | **In place** for tested pages |
| Database at scale (PostgreSQL) | **Planned** (ADR-0003); not implemented |
| Encryption of the database file at rest | **Host's job**; the app encrypts MFA secrets only |
| Off-host backup destination, SIEM export | **Owner decision** |

## Access and people

- **Three access levels** (`shared/access.ts`), held per team:
  - **Personal** is for their own record, work, goals and career. They see their team's roster and totals.
  - **Team leader** also sees each member's workload and shared records. Every open is logged. They assign and reassign work, correct shared records, export team data, read the team's access log, and bring people onto the team.
  - **Administrator** also sets access levels and manages the team's roles and sub-teams.
  - An **organization administrator** (the instance owner) is an administrator on every team. They also manage accounts: suspend, restore, reset two-step sign-in, issue a temporary password, sign out everywhere.
- **How levels are stored.** Each level is a system role, so a team's own custom roles keep working. The level shown is always what the team's permissions add up to.
- **Who can change what.** Changes follow a strict hierarchy:
  - nobody changes their own access;
  - nobody raises anyone to or above their own position;
  - only a team's owner or an organization administrator makes a team administrator;
  - the owner changes only by transferring ownership.
- **After every change.** The person is signed out so the change applies at once. The change is written to the audit log with the before and after levels.
- **Where it's managed.** **People** (`/people`) has:
  - one table for level, team membership and, for organization administrators, sign-in facts (two-step status, last sign-in, temporary password);
  - invitations at a chosen level.
  
  Organization-wide actions ask for the password again (step-up).
- **Teams are open to their members.** Every member sees their team's roster, levels and totals. Every signed-in person sees the list of teams: names and sizes, never the people on a team they are not on. Per-person workload and records remain for team leaders (PD-019).

## Sign-in and sessions

- **Passwords.** Sign-in uses passwords with a strength policy and throttling per connection.
- **Two-step sign-in.** Supported through an authenticator app (TOTP, secret encrypted at rest with `VANTAGE_SECRET`), recovery codes, or passkeys (WebAuthn).
- **Session expiry.** Sessions have an idle timeout (default 60 minutes) and an absolute lifetime (default 12 hours).
- **Session limits and step-up.** Each person may hold at most 8 sessions. Sensitive actions require step-up re-authentication, valid for 10 minutes.
- **Revocation.** Changing someone's roles, access level or team membership revokes their sessions.
- **Certificate proxy mode.** `CAC_MODE=proxy` can accept a certificate identity asserted by a trusted reverse proxy (see `docs/cac-and-records.md`). This is a mechanism, not an accreditation.
- **Not in place: SAML or OIDC single sign-on, and SCIM provisioning.** Choosing an identity provider (for example Microsoft Entra ID or Okta) is an owner decision. It changes who controls sign-in and needs the provider's tenant details. The personnel feed (`/api/admin/personnel`) already lets an authoritative roster own profile fields, and is the natural place for SCIM to land.

## Audit

- **Hash-chained log.** Security-relevant actions are written to a hash-chained audit log, and `verifyAuditChain` detects edits or gaps. Covered actions include:
  - sign-in;
  - role, level and membership changes;
  - record opens by leaders;
  - exports;
  - backups;
  - retention runs.
- **Per-team access log.** Each team has an access log that its leaders and administrators can read.
- **Scope.** The log records who did what to whom, never record contents.

## Privacy and records

- **Private by default.** Records are private unless shared with a team, and a leader never sees private entries or drafts.
- **Record kinds.** Each kind (work, education, certification, training, volunteer, extracurricular, fitness, award) saves only the fields it asks for (`shared/recordKinds.ts`).
- **Retention.** Retention schedules and legal holds are run from the owner console. Dispositions are logged.
- **Inventory and export.** A privacy inventory lists every table holding personal data and its purpose. Each person can download their own export.
- **Analytics.** There is no third-party analytics outside the synthetic demo. In the demo, PostHog receives only catalogued event names, and only when configured.

## Operations

- **Probes:**
  - `GET /api/health/live` answers while the process is up; use it for restarts.
  - `GET /api/health/ready` checks that the database answers and is at the schema this build expects, and returns 503 otherwise. Use it to decide whether to send traffic.
  - `GET /api/health` is unchanged and still used by the Dockerfile and `render.yaml`.
- **Backups:**
  - `npm run backup -- --dir /var/backups/vantage --keep 14` takes an online copy, verifies it with a full integrity check, writes a SHA-256 beside it, and prunes to the newest copies.
  - It exits non-zero if the copy is bad, so a scheduler reports the failure.
  - The owner console's download uses the same API.
  - See `docs/operations.md` for a schedule and restore steps.
- **Maintenance and moves.** The toolkit covers:
  - maintenance mode;
  - export and import of a whole instance;
  - an owner-recovery command;
  - a factory reset that needs a typed confirmation.
- **Migrations.** Migrations are numbered and each runs in a transaction. Tests start from real prior-version databases (`tests/server/migrations.test.ts`), including 009, which adds record details and the level roles.
- **Production safety.** Production refuses to start in demo or no-auth mode. A demo database and a real one refuse each other.

## Scale

- **Current limits.** Vantage runs as one Node process on SQLite (WAL). This suits a unit or section of hundreds of people on one host (`docs/deployment-scale.md`). It does not scale horizontally.
- **PostgreSQL.** The staged path is in ADR-0003; none of it is implemented yet. Adopting it means recurring infrastructure cost and a production cutover, so it waits on the owner.

## Accessibility and quality

- **Automated checks.** The browser suite runs axe checks in light and dark themes on the main pages, the People page and the record form.
- **Motion and input.** Reduced motion is honoured, and the product can be driven entirely by keyboard.
- **Test suites.** The server suite covers permissions, privacy gates, migrations, the demo boundary, probes and backups. The browser suite covers the main journeys on desktop and a phone.
- **Security testing.** No third-party penetration test has been done.

## Decisions for the owner

| Decision | Why it is the owner's | What it unlocks |
| --- | --- | --- |
| Single sign-on provider (SAML or OIDC) and SCIM | A new identity provider, and who controls sign-in | Central account lifecycle, no local passwords |
| PostgreSQL | Recurring cost, and a production cutover | More than one app server, managed backups |
| Off-host backup destination | Recurring cost, and where the data may live | Backups that survive losing the host |
| SIEM or log export target | A content-receiving third party | Audit review in the organization's own tools |
| Disk encryption and hosting location | The host and the data's classification | Encryption of the database file at rest |
