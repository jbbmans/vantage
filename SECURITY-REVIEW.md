# VANTAGE 3.5.0-rc.1 Security Review

## Executive result

VANTAGE is suitable for controlled evaluation with synthetic or specifically authorized data when deployed as documented on a protected US-region host. It is not ready to be represented as an official MCEN system and has not received an ATO.

The release candidate materially improves the original application: exact-unit authorization is server-enforced, personal and private scopes fail closed, self-registration does not create unit access, sessions are revocable and cookie-only, high-risk lifecycle actions are operator-bound, imports and attachments are bounded, security events are audited, and production dependencies currently report zero known advisories through `npm audit --omit=dev`.

## Review scope and evidence

- Express API, authentication, authorization, role and lifecycle logic
- SQLite schema, migrations, constraints, backup, attachments, and retention behavior
- React client authentication state, sensitive drafts, imports/exports, settings, and visibility controls
- Docker, Render, Fly.io, environment, and YAML configuration
- 399 automated checks across configuration, parsing, logic, API, scenario, escalation, tenancy, permission matrix, and migration suites
- Production dependency audit after upgrading React Router and Recharts
- Authenticated cloud-browser review of Command, Quick Capture, Records, Work, and Settings

The Codex Security deep-scan coordinator was not available in this session, so this report does not claim a completed plugin-generated multi-pass scan. The repository's focused attack tests and manual architecture review were completed instead. An independent security assessment remains a production gate.

## What is strong

### Tenant and personnel-data isolation

- Authorization never derives access from the display-only organization tree.
- Roles are defined inside one exact unit; there is no global role definition.
- Unit ownership, membership, role grants, record visibility, audit, and export are evaluated independently.
- Personal records have no unit and are unreadable by every other application principal, including the Instance Operator.
- Private records remain owner-only even when they carry unit context.
- Unit records stop at the exact unit; parents and siblings receive nothing automatically.
- Member-detail access requires an authorized shared unit and leadership position over the target, preventing subordinate or peer browsing.
- Transfers revoke old-unit role grants and invalidate stale reach without deleting originating-unit history.

### Authentication and sessions

- Password hashes use scrypt with per-password random salts.
- Unknown-user sign-in burns an equivalent verification to reduce username timing differences.
- Local passwords require at least 15 characters and reject common/predictable forms.
- Production sessions use random opaque credentials in HttpOnly, SameSite=Strict, Secure session cookies.
- SQLite stores only SHA-256 session digests, not reusable tokens.
- Idle, absolute, and active-session bounds are configurable.
- Password changes revoke other sessions; operator resets revoke all sessions and force replacement.
- First-run production setup is locked behind a high-entropy deployment secret.
- Cookie-authenticated writes require a client header as a CSRF backstop.
- Account and connection throttles reduce credential-stuffing and brute-force exposure.

### Authorization administration

- Role editors cannot add permissions they do not hold.
- Roles at or above the editor's position cannot be created, edited, granted, or deleted by that editor.
- Account-wide reset, deactivation, force-logout, backup, and top-level-unit operations require the environment-bound Instance Operator.
- Self-registration creates an unattached personal-only identity and cannot become a unit authorization path.
- Enrolling an existing identity creates a primary assignment when required, closing a transfer-authorization edge case.

### Data integrity and safe processing

- Server-side schemas validate every persisted field and reject rather than clamp impossible values.
- Optimistic concurrency prevents silent last-write-wins overwrites.
- Deletes are soft and auditable; project deletion unlinks dependent records transactionally.
- CSV/TSV import is capped, validated as a whole, duplicate-resistant, and formula-neutralized on export.
- The previously vulnerable XLSX parser is absent.
- Attachment content is detected from bytes, filenames are cleaned, MIME types and sizes are bounded, downloads are forced as attachments, access is audited, and deletion is soft.
- Attachments remain optional and are not used as a hidden completeness requirement.
- Experience metrics accept only an allow-list of aggregate event names and persist no user, session, IP, record, filename, or free-text fields.

### Browser and deployment controls

- Same-origin API architecture avoids a CORS trust surface.
- CSP restricts scripts, connections, frames, objects, base URIs, and form targets.
- HSTS, no-sniff, frame denial, no-referrer, restrictive permissions policy, and no-store API responses are set.
- Proxy trust is explicit and documented per deployment.
- Render and Fly examples pin a US region and a persistent data volume.
- The runtime container uses a non-root user and omits build tools and source not needed by the API.
- Production configuration is copied into the runtime image; secrets remain outside YAML.

## Findings fixed during this release pass

1. **Moderate dependency advisories — fixed.** React Router 6 was affected by two moderate advisories. The application and both lockfiles now use React Router DOM 7.18.2. The post-upgrade production audit reports zero vulnerabilities.
2. **Stale chart dependency — fixed.** Recharts 2 was outside its active support branch. The build now uses Recharts 3.10.1 and retains the chart-first Command experience.
3. **Incomplete Docker runtime — fixed.** The runtime image did not copy `config/app.yaml`, so production boot could not reliably load the reviewed configuration. The Dockerfile now includes `config/`.
4. **Attachment pressure disguised as quality — fixed.** Large-dollar records were flagged when no evidence link existed. Missing attachments no longer lower record health or Quick Capture quality.
5. **Registration form mismatch — fixed.** The create-account button could enable before required names were entered, and registration used the wrong password autocomplete hint. Client behavior now matches server requirements.
6. **Migration assertion drift — fixed.** The captured-database migration suite still expected schema 9 after migrations 10–12 were added. It now asserts the current schema 12 and passes.

## Residual risks and recommended fixes

### High priority before real operational data

1. **No MFA for local-password unit access.** Unattached registration limits initial exposure, but an attached account is still single-factor. Require phishing-resistant CAC/PIV for MCEN or add standards-based MFA for the interim evaluation environment. Do not treat attachment approval as an MFA substitute.
2. **CAC/PIV is a scaffold, not an integration.** The adapter is disabled and depends on a correctly configured mTLS reverse proxy. Complete certificate-policy validation, trusted-header stripping, operator-controlled identity linking, failure-mode testing, and sponsor approval before enabling it.
3. **No ATO or approved system boundary.** Code controls cannot decide whether real names, financial activity, work hours, fitness scores, awards, or other personnel-linked information may be processed on the current cloud host. Complete privacy, records, OPSEC, legal, cybersecurity, and RMF review.
4. **Attachment malware handling.** Byte sniffing blocks type confusion but is not antivirus, sandboxing, or content disarm. Add malware scanning/quarantine or restrict attachments to links and approved repositories if the authorization boundary requires it.
5. **Backups and recovery are operational controls.** The app can create a consistent snapshot, but off-host encryption, access restriction, rotation, monitoring, restoration drills, and legal hold require platform procedures.

### Medium priority before a larger rollout

1. **SQLite is a single-process architecture.** Do not run multiple writers or replicas against the same file. Migrate to PostgreSQL before horizontal scaling, multi-instance availability, or official shared-service adoption.
2. **In-memory rate limits do not coordinate across replicas.** This is acceptable only while one process is authoritative. Use a shared limiter after PostgreSQL/Redis or equivalent infrastructure is introduced.
3. **No automatic purge is not a complete retention policy.** The requested setting preserves history, but indefinite retention increases breach impact and may conflict with records schedules. Define authority, legal hold, correction, archival, and true-removal procedures.
4. **Infrastructure telemetry remains external to the app.** VANTAGE has no third-party analytics, but Render/Fly/load-balancer logs may retain IPs, user agents, paths, and errors. Configure access and retention at the platform.
5. **CSP permits inline styles.** `style-src 'unsafe-inline'` is materially safer than allowing inline scripts but is weaker than a nonce/hash-only style policy. Remove it if the component stack can be migrated without breaking runtime styles.

### Lower priority / engineering hardening

- Add a signed software bill of materials and provenance attestations to release CI.
- Add secret scanning, container scanning, and dependency audit gates to CI.
- Add automated backup-restore and disaster-recovery exercises.
- Add audit-log export to an append-only protected sink for stronger operator accountability.
- Add structured security-event alerting for lockouts, operator actions, unusual exports, backup downloads, and repeated denied access.
- Add a formal root `SECURITY.md` only after the owner approves disclosure contacts, reportability rules, accepted risks, and scope exclusions.

## Security acceptance statement

Within the code boundary, the release candidate has strong least-privilege and tenant-isolation controls and no known production dependency advisory at the time of this review. It should be deployed only in evaluation mode until the high-priority operational and authorization items above are closed.
