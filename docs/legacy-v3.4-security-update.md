# Vantage v3.4.1-security.2 — Security Update

## Release status

This tree is a **security maintenance candidate**, not an authorized operational
system and not yet a fully verified release. The source changes below were
implemented after the completed residual scan in `../security-scan/`. The scan
is intentionally preserved as immutable evidence of the pre-remediation
snapshot; this document records the later source changes and their verification
limits.

The candidate is suitable for continued development and a controlled evaluation
using synthetic or specifically authorized test data. It must not be promoted to
an operational personnel-data service until the dependency-backed release gate,
hosting review, privacy review, data-classification decision, and applicable
authorization process are complete.

## Remediation status

“Implemented” below means the source path was changed and a source-level
invariant test covers the intended boundary. It does **not** mean runtime closure
unless the dependency-backed tests named in the verification section also pass.

| Scan finding | Source status | What changed | Remaining validation |
| --- | --- | --- | --- |
| Critical — case-variant operator identity | Implemented | Usernames are normalized and case-insensitively unique; migration 009 refuses ambiguous legacy collisions; immutable `VANTAGE_OPERATOR_ID` bindings take precedence. | Migration and API tests on a legacy database. |
| High — cross-unit coupling through migrated roles | Implemented | Migration 009 forks mismatched role definitions into the destination unit; composite indexes and insert/update triggers enforce role/grant unit equality; authorization also checks equality defensively. | Run the migration suite and inspect the migration report on a copy of production data. |
| High — former members retain mutation rights | Implemented | Unit-visible records require live unit authority for later edits; membership removal and transfer freeze originating-unit shared records as history. | API and tenancy tests for every record table. |
| High — lower manager removes superior and revokes global sessions | Implemented | Position hierarchy is enforced for removal; unit-local removal no longer revokes unrelated account sessions; every request re-evaluates live authorization. | Scenario tests for multi-unit accounts and simultaneous sessions. |
| High — membership bypasses `VIEW_RECORDS` | Implemented | Shared-record list visibility derives from units where the actor holds `VIEW_RECORDS`, not from every membership. | Full permission matrix and tenancy suite. |
| High — stale client data crosses account boundaries | Implemented | Central identity transitions clear records, org state, preferences, pending state, errors, and account-scoped drafts before another identity hydrates. | Production build plus browser sign-out/session-loss/account-switch tests. |
| Medium — guest self-promotion | Implemented | Self-service membership-kind and expiry changes are denied; guests require a future expiry and are capped to 30 days by default. | API tests around expiry boundaries and role combinations. |
| Medium — roster leaks a foreign primary assignment | Implemented | Another user receives only a projection from an authorized shared unit; username, email, EAS, and legacy admin flags are removed from roster projections. | Tenancy response-shape tests. |
| Medium — manager re-homes another person’s record | Implemented | A non-author cannot change the visibility/unit ownership of another person’s record. | API tests across all six record types. |
| Medium — unit manager mints global identities | Implemented | Global account issuance is Instance-Operator-only. Unit leaders use an audited, prefix-only directory to enroll an existing account into an authorized exact unit. | Browser flow and concurrency tests; enterprise identity replaces issuance in an official deployment. |
| Medium — sensitive browser drafts use global cleartext keys | Implemented | Drafts are account-scoped, session-only, cleared at identity transitions, and never store passwords. | Shared-workstation browser tests and storage inspection. |
| Medium — client exports bypass `EXPORT_DATA` | Partially implemented | Personal export is limited to the signed-in user. Unit CSV export calls the audited server endpoint and is shown only with `EXPORT_DATA`. | Browser/API tests; manual copy/print remains a residual disclosure channel for data already rendered to an authorized reader. |
| Medium — list reads lack subject-visible auditing | Implemented | Bounded list-read receipts are written per actor/subject/table/unit/time window to avoid both invisibility and audit amplification. | Load test the receipt bound and confirm user/unit audit views. |
| Medium — backups invisible to units | Implemented | Backups are mode `0600`, centrally audited, and fan out a `backup_included` audit event to every active unit before streaming. | Runtime backup/restore drill and audit readback. |
| Medium — shared resource exhaustion | Partially implemented | Per-account mutation limits, session caps, per-user record ceilings, guest bounds, and a database high-water mark are present. | Pagination, asynchronous password verification, external rate limiting, monitoring, alerting, retention, and managed capacity remain for the official architecture. |
| Medium — client reports logout success without confirmation | Implemented | The client declares success only after a successful logout or confirmed unauthenticated response; otherwise it warns the user that the session may remain and to close the browser. | Network-failure browser test. |
| Medium — username lockout can be weaponized | Implemented | A correct password is still verified at the account threshold and clears the counter; bad attempts remain throttled and audited. | Timing and distributed-rate-limit testing behind the real proxy. |
| Medium — weak password denylist | Partially implemented | The local policy rejects contextual predictable phrases, repeated phrases, and known weak variants while retaining the 15-character minimum. | Replace local authentication with approved CAC/PIV federation for official use; if passwords remain for evaluation, add a maintained compromised-password corpus and password-hash upgrade policy. |

## Additional product hardening in this candidate

- Explicit Unit Owner succession with a current-member requirement, audit
  receipt, and removal of former-owner administrator-bit grants.
- Controlled closing of an otherwise empty unit by its sole owner, while
  preserving frozen history.
- Default-role enrollment for existing accounts, with temporary guest expiry.
- Session credentials stored only as SHA-256 digests; production browser
  authentication is cookie-only with `HttpOnly`, `Secure`, and
  `SameSite=Strict` protections.
- Strict production setup secret, no-store API responses, HSTS, CSP,
  clickjacking protection, and explicit proxy trust configuration.
- XLSX parsing removed. Imports are bounded CSV/TSV and exported cells are
  neutralized against spreadsheet-formula execution.
- `.github/workflows/ci.yml` performs a clean locked install, lint, high-severity
  production dependency audit, all server/security/migration tests, production
  build, and Chromium UI/accessibility/mobile coverage on pushes and pull
  requests. The workflow still needs its first successful run.

## Verification evidence

Executed successfully in the review workspace:

```text
node tests/static.test.mjs             48/48 passed
node tests/hardening-static.test.mjs   16/16 passed
node tests/delimited.test.mjs           5/5 passed
node --check server/*.js scripts/*.mjs src/lib/*.js tests/*.mjs
git diff --no-index --check <original> <candidate>
```

The repository did not include `node_modules`, and package-registry access was
not available. A direct dependency-backed test attempt stopped at
`ERR_MODULE_NOT_FOUND: date-fns`. Therefore these were **not** executed here:

- API, security, scenario, matrix, tenancy, and migration suites;
- Vite production build;
- Chromium functional, shared-workstation, accessibility, and mobile suites;
- container build, deployed health check, proxy/TLS check, backup/restore
  drill, and load/resource tests.

## Mandatory release gate

Run these from a clean environment using the locked dependency graph:

```bash
npm ci
npm audit --omit=dev
npm test
npm run build
npm run test:browser
docker build --pull --no-cache -t vantage:3.4.1-security.2 .
```

Then deploy only to an isolated evaluation environment and verify:

1. migrations 006–009 on a sanitized copy of the oldest supported database;
2. username collision refusal and operator UUID binding;
3. exact-unit permission matrix, membership removal, transfer, ownership
   succession, guest expiry, export, and audit receipts;
4. session-loss, sign-out network failure, and two-account shared-browser flows;
5. TLS, proxy IP attribution, cookie flags, CSP/HSTS, cache headers, and error
   responses at the real edge;
6. backup creation, encrypted storage, restore, checksum, and recovery drill;
7. resource ceilings under concurrent import, login, export, and record-write
   load;
8. keyboard, screen-reader, 320/430/768/1024/1440-pixel visual QA;
9. software composition analysis, secret scan, container scan, and the
   applicable DISA STIG/SRG checklist;
10. rollback using a pre-migration backup and the prior container image.

## Operational boundary

An MCEN connection, CAC login, cloud provider claim, or passing test suite does
not itself authorize operational use. The official deployment needs an
appointed system owner and authorizing path, data categorization, privacy and
records determinations, selected/implemented/assessed controls, a current
authorization decision, and continuous monitoring. Until those decisions are
documented, keep `VANTAGE_DATA_MODE=evaluation` and use synthetic or expressly
authorized test data only.
