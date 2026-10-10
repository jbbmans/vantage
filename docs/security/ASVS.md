# OWASP ASVS 5.0.0: where Vantage stands

_Assessed 2026-10-10 against `main` plus Task 7 ([ADR-0013](../engineering/ADR/0013-security-audit-least-privilege.md))._

This is a self-assessment written by the people who built Vantage. It is not an accreditation, a penetration
test or a third-party verification. No DoD, USMC, MCEN, NETACT-RES or RMF approval has been sought or granted.
Dynamic scanning (HawkScan) was not run for this assessment.

## Source and provenance

- **Standard:** OWASP Application Security Verification Standard 5.0.0, tag `v5.0.0`.
- **File used:** `5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv`, from
  <https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv>.
- **SHA-256 of that file:** `98c8fe911b9edb403af8ee05d3ce8201ecac2659e313b053890a62847cdcf680` (345 requirements in
  17 chapters).
- **Licence:** the ASVS is © the OWASP Foundation, licensed under Creative Commons Attribution-ShareAlike 4.0
  (CC BY-SA 4.0).
- **What this document takes from it:** requirement, section and chapter identifiers, levels, and section titles.
  No requirement text is copied. Each topic below is described in our own words, so read the standard itself for
  what a requirement says. The repository's [NOTICE](../../NOTICE) records this reference.

To check the file again:

```sh
curl -sSL https://raw.githubusercontent.com/OWASP/ASVS/v5.0.0/5.0/docs_en/OWASP_Application_Security_Verification_Standard_5.0.0_en.csv | sha256sum
```

## How to read it

- **V8 Authorization** and **V16 Security Logging and Error Handling** are assessed one requirement per row. Task 7
  is about these two.
- **Every other chapter** is assessed one section per row. The status there is the section as a whole, and the gaps
  name the requirements that fall short.

| Status | Meaning |
|---|---|
| Met | The code does it. A test or a document listed as evidence shows it. |
| Partly | Some of it is done; the notes say what is missing. |
| Not met | Not done. |
| Not applicable | Vantage has no such feature, or the host provides it, not the application. |

Vantage targets Level 2. Level 3 rows are assessed too, so the gaps are on the record.

Paths are relative to the repository root. Tests named `tests/server/x` are `tests/server/x.test.ts`; browser specs
are under `tests/browser`.

## Summary

| Chapter | Assessed | Met | Partly | Not met | Not applicable |
|---|---|---|---|---|---|
| V8 Authorization (requirements) | 13 | 7 | 5 | 1 | 0 |
| V16 Security Logging and Error Handling (requirements) | 17 | 8 | 9 | 0 | 0 |
| Other 15 chapters (sections) | 71 | 39 | 21 | 1 | 10 |

## V8 Authorization

| Req. | L | Topic | Status | Evidence | Notes |
|---|---|---|---|---|---|
| V8.1.1 | 1 | Documented rules for function and data access | Met | `docs/security.md` (Authorization, tenancy, ADR-0010, Unit Instance boundary); ADR-0006, ADR-0008, ADR-0010, ADR-0012, ADR-0013; `shared/permissions.ts` | Each permission is named in one catalogue for unit, Unit Instance and platform roles. |
| V8.1.2 | 2 | Documented rules for field-level reads and writes | Partly | `docs/security.md` (Least visibility; Exports are audited and minimal); ADR-0012 §10, §11; ADR-0013 §6 | Field rules exist feature by feature: EDIPI-derived usernames are hidden from Unit Instance trails, email recipients show only to `platform.email`, the support delivery log is reduced for unit queues, and the roster CSV leaves out EDIPI and email. No single document defines field-level access across the API. |
| V8.1.3 | 3 | Documented environmental and contextual attributes | Partly | `docs/security.md` (step-up window, idle timeouts, console hosts, consent banner, rate limits); ADR-0011 | The attributes used are the request's host (which console), the age of the last step-up, session idle time and the client IP (for rate limits and audit only). They are described but not collected in one place. |
| V8.1.4 | 3 | Documented use of context in decisions, with thresholds and outcomes | Partly | `docs/security.md` (step-up, lockout, idle limits); `server/auth/middleware.ts` | Fixed thresholds are documented: a 10-minute step-up window, 15 or 10 idle minutes, three failures to lock. There is no risk scoring. |
| V8.2.1 | 1 | Functions restricted to explicit permissions | Met | `server/authz/platform.ts` (`requirePlatform`), `server/routes/orgs.ts` (`inOrg`), `server/authz/scope.ts`; `server/authz/privilegedRoutes.ts`; tests `roleModel` (every role of both catalogues against the console routes), `privilegedRoutes` (an ordinary member refused on every privileged route, nothing changed), `tenancy`, `unitManagerConsole`, `adminConsole` | The privileged-route manifest fails the suite when a mutating route is added without being declared. |
| V8.2.2 | 1 | Data items restricted to explicit permissions (no IDOR or BOLA) | Met | `server/authz/scope.ts`, `server/authz/records.ts`; tests `unitIsolation` ("IDs cannot be manipulated to cross boundaries", "file downloads enforce record and unit authorization"), `securityHardening`, `records`, `support` | Another Unit Instance's ids answer 404. Drafts and career steps answer 404 to anyone but their owner. |
| V8.2.3 | 2 | Fields restricted to explicit permissions (no BOPLA) | Partly | zod schemas through `parse()` on every write (no mass assignment); `server/services/support.ts` (`deliveryFor`); `server/services/auditQuery.ts` (EDIPI usernames left out of instance trails); tests `support`, `unitManagerConsole`, `adminConsole` (no record marker reaches a platform read) | Writes accept only declared fields. Reads are trimmed where a feature was reviewed, not by a general field-level model. |
| V8.2.4 | 3 | Adaptive controls from context, at sign-in and during a session | Not met | — | Step-up, idle limits and host separation are fixed rules. Nothing weighs device, location or time of day. |
| V8.3.1 | 1 | Authorization enforced at a trusted service layer | Met | Every route checks on the server (`server/routes/*`, `server/services/*`); `docs/security.md`; ADR-0013 §11 | The client hides controls for usability only. Tests drive the API directly. |
| V8.3.2 | 3 | Authorization changes take effect at once | Met | `server/authz/scope.ts` (authority computed per request, expired grants ignored at once, `seatedOrgRole`, `seatedLeader`); sessions revoked on role, membership and credential changes; tests `tenancy` ("a role granted until a date ends on that date"), `roleModel`, `leastPrivilege` | Server sessions are database rows, not self-contained tokens, so nothing needs to wait for a token to expire. |
| V8.3.3 | 3 | Access decided by the originating user, not an intermediary | Met | `server/services/ai.ts` (sends only data the caller's own authority already reached); `server/services/access.ts` (Vantage access is a read-only grant to a named person) | Vantage calls no downstream service that makes data decisions on a user's behalf. |
| V8.4.1 | 2 | Cross-tenant controls in a multi-tenant application | Met | ADR-0008; `server/authz/scope.ts` (`sameInstance`, `assertSameInstance`); database triggers from migrations 016 and 020; tests `unitIsolation`, `tenancy`, `identityMembership` | The Unit Instance is the tenant. The engine refuses crossings even when code is bypassed (`cross_instance`). |
| V8.4.2 | 3 | Several layers of protection on administrative interfaces | Partly | Separate console hosts (`hosts`); staff-only sign-in on the Vantage Administrator console's host; step-up on every call to `/api/platform` and `/api/orgs`; 10-minute staff idle limit; the support two-person rule (`credentialApprovals`); console read limit; `access_denied` audit | Layers of identity and session control are in place. There is no device posture or contextual risk analysis. |

## V16 Security Logging and Error Handling

| Req. | L | Topic | Status | Evidence | Notes |
|---|---|---|---|---|---|
| V16.1.1 | 2 | An inventory of logging: layers, events, formats, storage, use, access and retention | Partly | `docs/security.md` (Logs); `shared/auditCatalog.ts` (every audit action and its category); `docs/operations.md` (Audit records off the host) | The inventory names every log, its format, where it goes and who reads it. The retention of the audit log is not decided (INFRASTRUCTURE_QUESTIONS I-32). |
| V16.2.1 | 2 | Each entry says when, where, who and what | Met | `server/services/audit.ts` (`at`, `actor_id`, `ip`, `action`, `entity`, `entity_id`, `subject_id`, `unit_id`, `org_id`, `category`, `detail`); tests `auditCoverage`, `auditCatalog` | — |
| V16.2.2 | 2 | Synchronised clocks; UTC timestamps | Partly | `server/lib/ids.ts` (`now()` is ISO 8601 in UTC); RFC 5424 lines carry the same timestamp (`server/services/auditSink.ts`) | Timestamps are UTC. Keeping the host's clock synchronised belongs to the host (INFRASTRUCTURE_QUESTIONS I-01, I-08). |
| V16.2.3 | 2 | Logs go only to documented destinations | Met | `docs/security.md` (Logs); `server/services/auditSink.ts` (only `VANTAGE_AUDIT_SYSLOG` and `VANTAGE_AUDIT_STDOUT`) | — |
| V16.2.4 | 2 | Logs readable by the log processor in use | Met | One JSON line per audit record on stdout; RFC 5424 syslog with octet-counted framing over TCP and TLS; tests `auditForwarding` | The category travels in the JSON message, not as structured data (ADR-0013, Consequences). |
| V16.2.5 | 2 | Sensitive data logged according to its protection level | Partly | Passwords, tokens, codes and temporary passwords are never written; a failed sign-in for an unknown name records no name; `counseling_amended` names fields, never values; Unit Instance trails leave out EDIPI-derived usernames; tests `auditCoverage`, `unitManagerConsole` | The platform trail's `edipi_corrected` detail carries the EDIPI before and after. Usernames made from a card (the EDIPI) appear in the platform trail. Both are read only by holders of `platform.audit`. |
| V16.3.1 | 2 | All authentication operations logged, with the method | Partly | Each sign-in method writes its action (`AUDIT_ACTION_FAMILIES.sign_in`); `login_failed` (password, second factor), `login_lockout`, `account_unlock`, `recovery_code_used`, `cac_rejected`, `cac_step_up_refused`, `oidc_rejected`, `logout`; tests `auditCoverage`, `cac` ("every certificate decision is on the audit trail"), `oidc` | A failed passkey assertion and a wrong password at step-up count towards the limits and the lockout, but are not written one by one. The lockout they cause is. |
| V16.3.2 | 2 | Failed authorization logged (L3: every decision and sensitive access) | Partly | `access_denied` for 403s at `/api/platform`, `/api/orgs` and `/api/org` (`server/app.ts`, `auditDenial`); `cross_instance_refused`; every cross-person read (`view_member`, `view_record`, `list_records`, `export_*`); tests `auditCoverage` | Refusals elsewhere in the API are counted by route family in product events (`security.authorization_denied`), without the person. `access_denied` is written once in ten minutes for a repeated refusal, which keeps the trail readable but is not every decision (L3). |
| V16.3.3 | 2 | Documented security events logged, and attempts to bypass controls | Partly | `shared/auditCatalog.ts` defines the events; `tests/server/auditCatalog` holds the code to it; `access_denied`, `cross_instance_refused`, `upload_rejected`, `console_sign_in_refused`, `self_grant` and `unproven_own_account` refusals | Validation failures (400), missing CSRF headers and rate-limit refusals (429) are answered but not audited. |
| V16.3.4 | 2 | Unexpected errors and security control failures logged | Partly | `server/app.ts` (unhandled errors to stderr and a `reliability.request_failed` event); the syslog sink keeps `lastError`, `dropped` and `queued` and the Vantage Administrator console shows them; scheduled jobs record failures and their last error (ADR-0011) | Failures of the forwarding connection are shown in the console and counted, not written to the audit trail. |
| V16.4.1 | 2 | Log encoding prevents injection | Met | `server/services/auditSink.ts` (records serialised with `JSON.stringify`; syslog header fields limited to printable ASCII); details capped at 1000 characters; tests `auditForwarding` ("a syslog line carries the action as its message id and never a control character") | — |
| V16.4.2 | 2 | Logs protected from unauthorised access and change | Met | Append-only triggers (`audit_log_no_update`, `audit_log_no_delete`, migration 021); HMAC chain under a key sealed with `VANTAGE_SECRET`; reading needs `platform.audit` or `org.audit`; tests `auditAppendOnly`, `unitIsolation` ("audit events cannot be silently rewritten…"), `org`, `secretRotation` | Someone who holds the database can drop a trigger. The chain then shows the rewrite to anyone without the secret, and the anchors kept off the host show it to anyone with it (ADR-0013 §2, §3). |
| V16.4.3 | 2 | Logs sent to a logically separate system | Partly | `VANTAGE_AUDIT_SYSLOG` (`udp`, `tcp`, `tls`), `VANTAGE_AUDIT_STDOUT`; the daily `audit_anchor` job and `POST /api/platform/integrity/verify`; tests `auditForwarding`, `auditCoverage` ("an anchor goes off the host like every entry") | Forwarding is off until a deployment names a collector. Who keeps the copy and how often it is compared is open (INFRASTRUCTURE_QUESTIONS I-08, I-30). |
| V16.5.1 | 2 | A generic message for unexpected or sensitive errors | Met | `server/app.ts` error handler ("The server could not complete that request.", code `server_error`); refusals carry a plain message and a code, never a stack, query or secret; `sourcemap: false` in `vite.config.ts` | — |
| V16.5.2 | 2 | Operating securely when an outside resource fails | Met | AI, the MARADMIN feed and mailbox connectors are optional and fail closed with a message; mail is queued and retried (`email_queue`); syslog records are queued while the collector is away; tests `ai`, `directMail`, `auditForwarding` | — |
| V16.5.3 | 2 | Failing securely, never open | Met | Each change runs in a transaction that rolls back on error; `useApproval` refuses unless the approval fits; `VANTAGE_SCAN_REQUIRED` refuses unscanned files; CRL checks fail closed; CAC policy OIDs fail closed; tests `credentialApprovals`, `stigControls`, `cacRevocation`, `cac` | — |
| V16.5.4 | 3 | A last-resort handler for unhandled exceptions | Partly | `server/app.ts` (the final Express error handler catches every request error, synchronous or asynchronous); scheduled jobs catch and record their own failures (`trackedJob`) | No process-level `uncaughtException` or `unhandledRejection` handler. An error outside a request or job ends the process, and the service manager restarts it. |

## Other chapters, by section

### V1 Encoding and Sanitization

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V1.1 Encoding and sanitization architecture | Met | Input decoded once by the JSON body parser and zod; output encoded by React and by `shared/csv.ts` at the point of use | — |
| V1.2 Injection prevention | Met | Every query is a better-sqlite3 prepared statement with bound parameters; the few built SQL fragments are made from constants (`server/db/index.ts`, `server/authz/scope.ts`); no shell is run with user input; CSV formula cells written as text (`shared/csv.ts`) | — |
| V1.3 Sanitization | Met | `server/lib/sanitizeHtml.ts` (allowlist, re-quoted attributes); link schemes checked as a browser reads them; remote images stripped; direct mail refuses private addresses (SSRF); tests `securityHardening`, `correspondenceParsing`, `stigControls` | — |
| V1.4 Memory, string and unmanaged code | Not applicable | TypeScript on Node.js; no unmanaged code of Vantage's own | — |
| V1.5 Safe deserialization | Met | JSON only, parsed by the platform; workbooks and archives charged by their real expanded size (`server/lib/zip.ts`, `server/lib/workbook.ts`); tests `workbook`, `parserFuzz` | — |

### V2 Validation and Business Logic

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V2.1 Validation and business logic documentation | Partly | zod schemas in `shared/schemas.ts`, `shared/recordSchemas.ts`, `shared/caseSchemas.ts`; limits written into ADR-0011, ADR-0012 and ADR-0013 | No single document lists every validation rule and business limit. |
| V2.2 Input validation | Met | `parse()` with zod on every route that takes input; server-side checks repeat any the client makes | — |
| V2.3 Business logic security | Met | Steps in order: work stages, scoring versions in order, approvals before credential changes; optimistic concurrency (409 `version_conflict`); single-use codes, links and approvals; tests `cases`, `dutyScoring`, `credentialApprovals`, `invariants` | — |
| V2.4 Anti-automation | Partly | Rate limits per IP and per account on sign-in, registration, reset, MFA and mutations; per-person console read limit; mail caps per account; tests `auth`, `securityHardening`, `leastPrivilege` | No minimum human timing on business flows (V2.4.2, L3). |

### V3 Web Frontend Security

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V3.1 Web frontend security documentation | Met | `docs/security.md` (Transport and browser), `docs/security/SECURITY_MODEL.md` (Browser and network) | — |
| V3.2 Unintended content interpretation | Met | `Content-Disposition: attachment`, `nosniff`, sniffed upload types, sanitized message HTML | — |
| V3.3 Cookie setup | Partly | `HttpOnly`, `Secure`, `SameSite=Lax` (`server/routes/auth.ts`, `server/auth/sessions.ts`); each console's cookie is its own host's | The cookies are named `vantage_session` and `vantage_signed_in`, without the `__Host-` or `__Secure-` prefix (V3.3.1, V3.3.3). |
| V3.4 Browser security mechanism headers | Met | Strict CSP with hashed inline bootstrap, HSTS with preload, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, CORP and `Origin-Agent-Cluster` (`server/app.ts`); tests `securityHardening` | — |
| V3.5 Browser origin separation | Met | CSRF client header on every state change, `SameSite`, separate hosts for each console, each API answering only on its host; tests `auth` ("cookie sessions require the client header for writes"), `hosts` | — |
| V3.6 External resource integrity | Met | The page loads nothing from third parties; fonts are local (`docs/security/SECURITY_MODEL.md`) | — |
| V3.7 Other browser security considerations | Partly | Redirects only to the deployment's own configured hosts (`server/app.ts`, `server/lib/hosts.ts`); HSTS preload header sent | Whether the production domain is on the browsers' preload list depends on the deployment (V3.7.4). No interstitial for links out of the application (V3.7.3). |

### V4 API and Web Service

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V4.1 Generic web service security | Partly | JSON with its content type; `TRUST_PROXY` names the proxy whose headers count; `VANTAGE_CLIENT_IP=cloudflare` trusts the forwarded address only from Cloudflare's ranges | No per-message signatures (V4.1.5, L3). Unused methods are answered 404 by the router, not explicitly blocked (V4.1.4). |
| V4.2 HTTP message structure validation | Partly | Body size limit (4 MB, 413 `too_large`), malformed JSON refused (400 `bad_json`); Node's HTTP parser | Request smuggling defences rest on Node and the reverse proxy (INFRASTRUCTURE_QUESTIONS I-06). |
| V4.3 GraphQL | Not applicable | No GraphQL | — |
| V4.4 WebSocket | Not applicable | No WebSockets | — |

### V5 File Handling

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V5.1 File handling documentation | Partly | `docs/security.md` (attachments, scanning, workbook limits) | Permitted types and sizes are in code and the security model, not in one file-handling document. |
| V5.2 File upload and content | Met | Types sniffed (PDF, PNG, JPEG, text, CSV), size limits, real expanded size charged, clamd scanning with an option to refuse unscanned files; tests `stigControls`, `workbook` | — |
| V5.3 File storage | Met | Files stored in the database, never on a path a user names; served only through authorization checks | — |
| V5.4 File download | Met | `Content-Disposition: attachment`, record and unit authorization on every download; tests `unitIsolation` ("file downloads enforce record and unit authorization") | — |

### V6 Authentication

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V6.1 Authentication documentation | Met | `docs/security.md` (Identities and sessions), `docs/cac-and-records.md`, ADR-0009 | — |
| V6.2 Password security | Partly | 15 characters minimum, 256 maximum, any characters, NFC-normalised, a blocked list and predictable-term check (`shared/password.ts`); PBKDF2-HMAC-SHA256 at 600,000 iterations; current password required to change it | No check against the top 3,000 or a breached-password set (V6.2.4, V6.2.12). The context-word list is in code, not documented (V6.2.11). |
| V6.3 General authentication security | Met | Lockout after three failures kept in the database; a name with no account answers as a real one does; card-only and provider-only deployments close every password path; tests `auth`, `stigControls`, `cac` | — |
| V6.4 Authentication factor lifecycle and recovery | Met | Single-use reset links; recovery codes used once; a new authenticator replaces the old only once confirmed; credential changes on an account with authority need a second staff member (ADR-0013 §5); tests `auth`, `credentialApprovals` | — |
| V6.5 General multi-factor authentication | Met | TOTP with replay refusal, recovery codes, passkeys, CAC as two factors; tests `auth`, `securityHardening`, `cac` | — |
| V6.6 Out-of-band authentication | Partly | Email is used only for a reset link and sign-in details, capped and single use | No out-of-band authenticator (push or SMS) is offered. Email recovery is not assessed as an authenticator. |
| V6.7 Cryptographic authentication | Met | WebAuthn passkeys bound to the site's domain; CAC client certificates checked against the configured CAs and CRLs; tests `cac`, `cacRevocation`, `hosts` | — |
| V6.8 Authentication with an identity provider | Met | OIDC with PKCE, single-use state and nonce, signature against the provider's keys, `none` and HMAC refused, issuer, audience and expiry checked, account bound to one subject; tests `oidc` | — |

### V7 Session Management

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V7.1 Session management documentation | Met | `docs/security.md` (sessions, idle and absolute limits) | — |
| V7.2 Fundamental session management security | Met | 256-bit random tokens stored as SHA-256 digests, new token at sign-in; tests `auth` | — |
| V7.3 Session timeout | Met | 15 idle minutes (10 for staff), 12 hours absolute, a background poll not counted as activity; tests `stigControls` | — |
| V7.4 Session termination | Met | Sign-out deletes the session; password, role, membership, MFA and EDIPI changes revoke other sessions; device list; tests `auth` ("password change, sudo, and session revocation") | — |
| V7.5 Defenses against session abuse | Met | Step-up within 10 minutes for sensitive changes; at most 8 sessions per person; tests `auth` ("sudo-gated actions refuse stale sessions") | — |
| V7.6 Federated re-authentication | Partly | An organization sign-in starts a Vantage session only after the person acts | A step-up cannot be done at the identity provider (INFRASTRUCTURE_QUESTIONS I-26). How the provider's session ends is not tied to Vantage's. |

### V9 Self-contained Tokens

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V9.1 Token source and integrity | Met | Vantage issues no self-contained tokens. The OIDC ID tokens it receives are verified against the provider's keys, with `none` and HMAC refused (`server/auth/oidc.ts`); tests `oidc` | — |
| V9.2 Token content | Met | Issuer, audience, expiry and nonce checked; tests `oidc` ("a forged, misdirected, expired or replayed ID token is refused") | — |

### V10 OAuth and OIDC

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V10.1 Generic OAuth and OIDC security | Partly | Tokens stay on the server; PKCE and state on every flow | Mailbox connector tokens are not wired in this build (`docs/security.md`, Correspondence). |
| V10.2 OAuth client | Met | Code flow with PKCE, single-use hashed state (`server/auth/oidc.ts`); tests `oidc` | — |
| V10.3 OAuth resource server | Not applicable | Vantage accepts no OAuth access tokens | — |
| V10.4 OAuth authorization server | Not applicable | Vantage is not an authorization server | — |
| V10.5 OIDC client | Met | Nonce, issuer, audience and subject binding; one subject per account; tests `oidc` | — |
| V10.6 OpenID provider | Not applicable | Vantage is not an OpenID provider | — |
| V10.7 Consent management | Not applicable | Consent belongs to the authorization server | — |

### V11 Cryptography

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V11.1 Cryptographic inventory and documentation | Partly | Algorithms and key handling described in `docs/security.md` (Identities, Integrity, Outbound email) and `docs/operations.md` (secret rotation) | No formal key-management policy, maintained inventory or post-quantum migration plan (V11.1.1, V11.1.2, V11.1.4). |
| V11.2 Secure cryptography implementation | Met | Node's `crypto` module only (`server/lib/crypto.ts`); PBKDF2-HMAC-SHA256 as the FIPS 140 approved password hash | — |
| V11.3 Encryption algorithms | Met | AES-256-GCM for TOTP secrets, the DKIM key and queued mail | — |
| V11.4 Hashing and hash-based functions | Met | SHA-256 digests for sessions and tokens; HMAC-SHA256 for the audit and case chains; PBKDF2 for passwords | — |
| V11.5 Random values | Met | `crypto.randomBytes` for tokens, ids and secrets (`server/lib/ids.ts`) | — |
| V11.6 Public key cryptography | Met | WebAuthn, CAC certificate verification, OIDC signature checks, DKIM signing | — |
| V11.7 In-use data cryptography | Not met | — | Data is not protected in memory while in use (L3). |

### V12 Secure Communication

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V12.1 General TLS security guidance | Partly | Every configured address must be `https://` in production; CAC client certificates validated before use; CRLs checked in direct mode | TLS versions, ciphers, OCSP stapling and ECH are set at the reverse proxy that terminates TLS (INFRASTRUCTURE_QUESTIONS I-06). |
| V12.2 HTTPS with external-facing services | Met | HTTPS only in production, HSTS with preload, `upgrade-insecure-requests` | — |
| V12.3 Service-to-service communication | Partly | Syslog over TLS with an optional CA bundle; SMTP relay; GenAI.mil over HTTPS | Direct mail uses opportunistic STARTTLS, as mail servers do. The database is a local file; a PostgreSQL connection's TLS is open (INFRASTRUCTURE_QUESTIONS I-04). |

### V13 Configuration

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V13.1 Configuration documentation | Partly | `docs/operations.md`, `docs/deploy-mcen.md`, deployment profiles (ADR-0007); the Vantage Administrator console lists every outbound connection | No single list of every external service and its expected configuration for each deployment. |
| V13.2 Backend communication configuration | Partly | Outbound connections refused by the MCEN profile unless approved; direct mail refuses private addresses | Service accounts and least privilege for backend connections are the host's (INFRASTRUCTURE_QUESTIONS I-04, I-15). |
| V13.3 Secret management | Partly | `VANTAGE_SECRET` seals stored secrets and can be rotated with `VANTAGE_SECRET_PREVIOUS`; the AI key stays on the server; tests `secretRotation` | Secrets come from the environment, not a vault or hardware module (V13.3.1, V13.3.3). |
| V13.4 Unintended information leakage | Met | `x-powered-by` off; no source maps in the build; generic 500 message; no directory listings; the API answers only on its own host | — |

### V14 Data Protection

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V14.1 Data protection documentation | Met | `server/services/privacyInventory.ts` declares every table and column; `docs/security/SECURITY_MODEL.md` (Data handling) | — |
| V14.2 General data protection | Partly | Secrets never in URLs; API responses `Cache-Control: no-store`; no third-party trackers; retention schedules, legal holds and disposition (`server/services/retention.ts`); minimal exports | No defined retention for the audit log (INFRASTRUCTURE_QUESTIONS I-32). Metadata in uploaded files is not stripped (V14.2.8). |
| V14.3 Client-side data protection | Partly | API responses not cached; the session cookie is `HttpOnly` | Local storage holds interface preferences, recent pages and writing-assistant choices; session storage holds unsaved form drafts until the tab closes (V14.3.3). No `Clear-Site-Data` header at sign-out (V14.3.1). |

### V15 Secure Coding and Architecture

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V15.1 Secure coding and architecture documentation | Partly | ADR-0001 to ADR-0013; `docs/engineering/ARCHITECTURE.md`; `package-lock.json` | No SBOM yet (CycloneDX planned, INFRASTRUCTURE_QUESTIONS I-11). No documented update and remediation time frames for dependencies. |
| V15.2 Security architecture and dependencies | Partly | `npm audit` with no known vulnerabilities at the last release check; linear-time parsers; resource limits on uploads and workbooks; test sign-in refused in production | Dependency confusion is mitigated only by the lockfile and the public registry (V15.2.4). |
| V15.3 Defensive coding | Met | Null-prototype registries for lookups by a request's key; zod schemas against mass assignment; static tests that hold invariants (`auditCatalog`, `privilegedRoutes`, `leastPrivilege`) | — |
| V15.4 Safe concurrency | Met | SQLite transactions for every multi-step change; optimistic versions; approvals used with a guarded `UPDATE` in the change's transaction | — |

### V17 WebRTC

| Section | Status | Evidence | Gaps |
|---|---|---|---|
| V17.1 TURN server | Not applicable | No WebRTC | — |
| V17.2 Media | Not applicable | No WebRTC | — |
| V17.3 Signaling | Not applicable | No WebRTC | — |

## Gaps worth acting on

These are the Level 2 gaps above. Each is a candidate for a later Task, not a promise.

1. Check passwords against a breached-password set and the top 3,000 (V6.2.4, V6.2.12).
2. Rename the session cookie with the `__Host-` prefix (V3.3.1, V3.3.3). Everyone would have to sign in again once.
3. Audit failed passkey assertions and wrong step-up passwords one by one (V16.3.1). Audit validation, CSRF and
   rate-limit refusals at the administration routes (V16.3.3).
4. Decide the audit log's retention, and who keeps and compares the off-host copy (V16.1.1, V16.4.3;
   INFRASTRUCTURE_QUESTIONS I-30, I-32).
5. Keep secrets in a vault when MCEN names one (V13.3.1), and write a key-management policy and cryptographic
   inventory (V11.1).
6. Produce a CycloneDX SBOM with each release (V15.1; INFRASTRUCTURE_QUESTIONS I-11).
