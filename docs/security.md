# Security model

## Identities and sessions

- Usernames plus a 15-character-minimum password, checked against common patterns, hashed with PBKDF2-HMAC-SHA256 (600,000 iterations by default, `VANTAGE_PBKDF2_ITERATIONS`, at least 210,000 in production), the FIPS 140 approved choice. Hashes made with scrypt by earlier versions still verify and are replaced the next time the person signs in. Verification runs off the event loop.
- Passkeys (WebAuthn, discoverable credentials) with the site hostname as relying party. Passkeys sign in without a password.
- Authenticator app (TOTP, RFC 6238) as a second step for password sign-in, with eight single-use recovery codes. Each code is accepted once, and a code older than the last one used is refused. Setting up a new authenticator leaves the current one in force until the new one is confirmed.
- Sessions are random 256-bit tokens stored only as SHA-256 digests, in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie. Idle timeout 15 minutes, 10 for an instance owner (`VANTAGE_IDLE_MINUTES`, `VANTAGE_OPERATOR_IDLE_MINUTES`), absolute 12 hours, at most 8 active per user. A background poll (the notification bell) is marked as such and does not count as activity, so an open tab still times out. The client is told when the session will end and asks two minutes before.
- Lockout: three consecutive failures (a wrong password at sign-in, a wrong second factor, or a wrong password at a step-up or password change) lock the account for 15 minutes (`VANTAGE_LOCKOUT_ATTEMPTS`, `VANTAGE_LOCKOUT_MINUTES`). The count is kept in the database, so a restart does not lift it. The right password does not open a locked account; a passkey or CAC still does. An owner can unlock from the Accounts tab, and issuing a temporary password unlocks too. Each lock and unlock is audited.
- Notice and consent: `VANTAGE_CONSENT_BANNER=dod` shows the standard DoD Notice and Consent Banner before sign-in, and the server refuses to create an account or a session for a client that has not accepted it. `custom` shows `VANTAGE_CONSENT_TEXT`. Off by default, because it states the conditions of a U.S. Government system.
- Step-up: sensitive changes require the password again within a 10-minute window (`sudo_until` on the session).
- Password change, role change, membership change, MFA reset, and deactivation revoke the affected user's other sessions.
- Accounts can be created in bulk from a roster only by the Instance Operator, after re-entering their password. Temporary passwords in the roster must meet the password policy, and every imported account has to set its own password before it can do anything else.

## Authorization

- A user always reads and writes their own records.
- Records have `visibility` of `private` or `unit`, and a `unit_id`. Only `unit` records in a unit where the reader holds `VIEW_RECORDS` are visible to others; `VIEW_MEMBER_DETAIL` opens a Marine's page; `MANAGE_RECORDS` edits shared entries; `COUNSEL` records counselings and award recommendations.
- Permissions are a bitmask on roles, and roles belong to one unit. Authority flows down the unit tree, never up: a role in a command carries into every team beneath it, one position above that team's own role of the same rank, so a command leader outranks a team leader in the team. A role in a team confers nothing in the command above it.
- Members see an overview of their own team and of each command above it: the roster, the goals, and aggregate totals. Totals built from fewer than three contributors are withheld, so an overview never reveals one person's entries. Shared records, member pages and dashboards still need `VIEW_RECORDS` or `VIEW_MEMBER_DETAIL` in that unit or a unit above it.
- Moving a Marine between teams needs `MANAGE_MEMBERS` in both teams and a higher position than the Marine in each. It runs as one transaction, is audited as `move_member`, revokes the Marine's sessions, and carries a role only where the mover may grant it.
- A role is granted, invited or put on a join code only by someone who could have defined it: it sits below their own position and carries no permission they lack. Unit Leader moves only by ownership transfer.
- Enrolling an existing account skips that person's consent, so it is limited to Marines the leader already leads (below them in a unit where they manage members) and to the Instance Operator. Everyone else joins with an invitation or join code they accept themselves, and the directory offers only people the searcher could enroll.
- The instance owner (operator) manages accounts and settings but has no read access to private records.
- Every cross-person read is audited (`view_member`, `view_record`, `list_records`, `view_readiness`, `build_report`, `export_*`) with actor, subject, unit, IP.

## Integrity

- The audit log is an HMAC hash chain under a chain key kept in the database and sealed with `VANTAGE_SECRET`; the head is stored separately and verified on the owner overview. Case histories are chained the same way, and a history whose seals were removed reads as broken.
- Both chains detect a change made by somebody who has the database but not the secret. Against somebody who holds the whole server, the evidence is a copy they do not control: `VANTAGE_AUDIT_SYSLOG` sends every audit record, with its hash, to a syslog collector as it is committed (see `docs/operations.md`).
- `VANTAGE_SECRET` can be changed: set the old one as `VANTAGE_SECRET_PREVIOUS` for one start and every stored secret is re-sealed.
- Records carry a `version`; concurrent edits are rejected with the current copy (409) and the client offers reload or overwrite.
- CSV import screens exact and near duplicates; the database enforces a per-user fingerprint.

## Transport and browser

- The owner console can have a host of its own (`VANTAGE_CONSOLE_URL`). There, only owners can sign in, its session cookie is its own, and administration (`/api/admin`) answers on that host alone, so a session stolen from the app can never reach it.
- HTTPS only in production (every configured address must be `https://`), HSTS with preload, a strict CSP with hashed inline bootstrap and `connect-src` limited to this server and the GenAI.mil gateway (the owner console checks from the browser whether the gateway is reachable), `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`.
- CSRF: state-changing requests must carry `x-vantage-client`; cookies are `SameSite=Lax`.
- Rate limits per IP and per account on sign-in, registration, reset, MFA, and mutations. The current-password check on the change-password form shares the sign-in limit. Reset emails are capped at three an hour per account, and mail sent on a user's request (address confirmation, digests, invitations) at ten per 15 minutes.
- Links a user saves as evidence must be `http`, `https` or `mailto`, checked the way a browser reads a scheme (ignoring control characters and whitespace). MARADMIN links are kept only when they are `https`.
- Attachments are sniffed for type (PDF, PNG, JPEG, plain text, CSV), size-limited, hashed, stored in the database, and served with `Content-Disposition: attachment`.
- Every upload (evidence attachments, imported workbooks, saved `.eml` messages) is scanned when a scanner is configured: clamd over its socket (`VANTAGE_CLAMD=tcp://host:3310` or a unix socket path) or the `clamdscan` command (`VANTAGE_SCANNER_COMMAND`). A rejected file is never stored. `VANTAGE_SCAN_REQUIRED=true` refuses a file that could not be scanned instead of keeping it marked "not scanned".
- A workbook is charged against its size limit by what it really expands to, not by the sizes it declares.

## AI

- Only through GenAI.mil, with the key server-side. Each workflow sends a bounded payload of the caller's own data (or exact-unit aggregates for command briefs); inputs are labeled untrusted in the system prompt.
- Per-user daily token limits and an instance budget. A key lock from the gateway pauses AI and notifies owners.
- Nothing is written from an AI result without the user pressing save.

## Correspondence and mailboxes

- Message HTML is sanitized server-side from an allowlist before storage; scripts, handlers, and non-`http(s)`/`mailto`/`tel` links never survive. Every attribute the sanitizer writes is re-quoted with its quotes escaped, so a value cannot close its attribute and add another.
- Remote images are stripped rather than proxied. A tracking pixel would otherwise report when a Marine opened their mail, and from which network.
- Mailbox connectors are read-only (`offline_access`, `User.Read`, `Mail.Read`) and name their national cloud explicitly. Delta sync keys on the provider's message ids, and a message deleted upstream never deletes the local record of the work.
- Live syncing is not wired to a token flow in this build. The authorization plan is shown before anything is authorized, and an unauthorized sync says so rather than reporting an empty mailbox.

## Outbound email

- In direct mode Vantage signs every message with DKIM. The private key is generated on the server, stored in `meta` encrypted with `VANTAGE_SECRET` (AES-256-GCM), and never leaves the instance; only the public key is shown, for DNS.
- Mail a receiver asks to retry is queued in `email_queue` encrypted with the same secret, and deleted once delivered or given up: 30 minutes for a reset link, two days at most otherwise.
- Delivery uses opportunistic STARTTLS, as mail servers do between themselves; a receiver that offers no TLS still gets the message in the clear, which is the norm for server-to-server mail.
- Direct delivery resolves each mail host itself and never connects to a private, loopback, link-local or reserved address, so a recipient domain cannot point delivery into the host's own network. It connects to the address it checked. `VANTAGE_EMAIL_ALLOW_PRIVATE=true` is for a network whose mail hosts really are private.
- The Owner console's email checks are operator-only behind step-up confirmation, and each run is audited (`email_setup_checked`).
- Team messages need `MANAGE_MEMBERS` in the unit, go to each member separately so no address is shared, set Reply-To to the sender, are limited to five an hour per sender, and are audited (`team_message`). Subjects are flattened to one line, so typed text cannot add mail headers.

## Product analytics

- The event catalog is closed. A client can only send names and properties declared in `server/services/telemetry.ts`; anything else is dropped with a reason.
- No property can hold free text. Values are numbers, booleans, or one of a fixed set of words, so passwords, keystrokes, cancelled drafts, email bodies, and workbook cells have nowhere to go.
- The actor is taken from the session, never from the request body, and a client cannot raise an event the server is responsible for.
- The Owner role grants no privilege over privacy here: the console reports counts and distributions only, and withholds any breakdown fewer than three people produced.
- Events are retained for a bounded window and can be pruned from the console.

## Threats considered

| Threat | Mitigation |
| --- | --- |
| Credential stuffing | Rate limits, a lockout after three failures kept in the database, long passwords, passkeys, TOTP |
| Replaying an observed authenticator code | Each code accepted once per account |
| Pulling a Marine into your own unit to read them | Direct enrollment only for Marines already led; everyone else by invitation |
| Escalating through a lower role | Grants limited to permissions the granter holds |
| Flooding an inbox with reset or confirmation mail | Per-account caps on every email a user can trigger |
| Sidestepping the demo's closed routes | Paths compared case-insensitively, without trailing slashes |
| Session theft | Digest storage, short idle timeout, revocation on sensitive changes, device list |
| Insider read of private records | Not reachable through the API; audit of every shared read |
| Tampering with the audit trail | HMAC chain verified by the owner; a copy of every record sent off the host |
| A revoked CAC | Direct mode checks the issuing CAs' CRLs and fails closed; proxy mode relies on the gateway's check |
| A workbook that expands without limit | Real expanded size charged against the limit |
| Malware in an upload | clamd scan of every upload; optionally refuse what could not be scanned |
| Mail delivery aimed at the host's own network | Private and reserved addresses refused |
| A copy of the whole instance walking out | Browser downloads can be turned off; every other owner is notified of each one |
| CSRF / clickjacking | Client header, `SameSite`, `frame-ancestors 'none'` |
| Malicious upload | Type sniffing, size cap, attachment disposition, no inline render |
| Prompt injection via records | Data labeled untrusted; no tool access; output is a draft |
| Disk full | Write refusal near the size threshold; backups from the console |
| Tracking pixel in imported mail | Remote images stripped, never fetched; the reader is told |
| Script in an email body | Allowlist sanitizer; scripts and handlers dropped before storage |
| Reading a government mailbox from the wrong cloud | The national cloud is declared, never inferred from an address |
| Content leaking into analytics | Closed catalog with scalar-only properties; undeclared values dropped |
| De-anonymizing a small cohort | Breakdowns under three contributors withheld |
