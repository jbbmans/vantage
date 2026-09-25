# Security model

## Identities and sessions

- Usernames plus a 15-character-minimum password, checked against common patterns, hashed with scrypt.
- Passkeys (WebAuthn, discoverable credentials) with the site hostname as relying party. Passkeys sign in without a password.
- Authenticator app (TOTP, RFC 6238) as a second step for password sign-in, with eight single-use recovery codes. Each code is accepted once, and a code older than the last one used is refused. Setting up a new authenticator leaves the current one in force until the new one is confirmed.
- Sessions are random 256-bit tokens stored only as SHA-256 digests, in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie. Idle timeout 60 minutes, absolute 12 hours, at most 8 active per user.
- Step-up: sensitive changes require the password again within a 10-minute window (`sudo_until` on the session).
- Password change, role change, membership change, MFA reset, and deactivation revoke the affected user's other sessions.
- Accounts can be created in bulk from a roster only by the Instance Operator, after re-entering their password. Temporary passwords in the roster must meet the password policy, and every imported account has to set its own password before it can do anything else.

## Authorization

- A user always reads and writes their own records.
- Records have `visibility` of `private` or `unit`, and a `unit_id`. Only `unit` records in a unit where the reader holds `VIEW_RECORDS` are visible to others; `VIEW_MEMBER_DETAIL` opens a Marine's page; `MANAGE_RECORDS` edits shared entries; `COUNSEL` records counselings and award recommendations.
- Permissions are a bitmask on roles; roles belong to one unit; nothing inherits across the unit tree. The unit owner holds `ADMINISTRATOR` in that unit only.
- A role is granted, invited or put on a join code only by someone who could have defined it: it sits below their own position and carries no permission they lack. Unit Leader moves only by ownership transfer.
- Enrolling an existing account skips that person's consent, so it is limited to Marines the leader already leads (below them in a unit where they manage members) and to the Instance Operator. Everyone else joins with an invitation or join code they accept themselves, and the directory offers only people the searcher could enroll.
- The instance owner (operator) manages accounts and settings but has no read access to private records.
- Every cross-person read is audited (`view_member`, `view_record`, `list_records`, `view_readiness`, `build_report`, `export_*`) with actor, subject, unit, IP.

## Integrity

- The audit log is an HMAC hash chain keyed by `VANTAGE_SECRET`; the head is stored separately and verified on the owner overview.
- Records carry a `version`; concurrent edits are rejected with the current copy (409) and the client offers reload or overwrite.
- CSV import screens exact and near duplicates; the database enforces a per-user fingerprint.

## Transport and browser

- HTTPS only in production (`VANTAGE_PUBLIC_URL` must be `https://`), HSTS with preload, a strict CSP with hashed inline bootstrap and `connect-src` limited to this server and the GenAI.mil gateway (the owner console checks from the browser whether the gateway is reachable), `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`.
- CSRF: state-changing requests must carry `x-vantage-client`; cookies are `SameSite=Lax`.
- Rate limits per IP and per account on sign-in, registration, reset, MFA, and mutations. The current-password check on the change-password form shares the sign-in limit. Reset emails are capped at three an hour per account, and mail sent on a user's request (address confirmation, digests, invitations) at ten per 15 minutes.
- Links a user saves as evidence must be `http`, `https` or `mailto`, checked the way a browser reads a scheme (ignoring control characters and whitespace). MARADMIN links are kept only when they are `https`.
- Attachments are sniffed for type (PDF, PNG, JPEG, plain text, CSV), size-limited, hashed, stored in the database, and served with `Content-Disposition: attachment`.

## AI

- Only through GenAI.mil, with the key server-side. Each workflow sends a bounded payload of the caller's own data (or exact-unit aggregates for command briefs); inputs are labeled untrusted in the system prompt.
- Per-user daily token limits and an instance budget. A key lock from the gateway pauses AI and notifies owners.
- Nothing is written from an AI result without the user pressing save.

## Correspondence and mailboxes

- Message HTML is sanitized server-side from an allowlist before storage; scripts, handlers, and non-`http(s)`/`mailto`/`tel` links never survive. Every attribute the sanitizer writes is re-quoted with its quotes escaped, so a value cannot close its attribute and add another.
- Remote images are stripped rather than proxied. A tracking pixel would otherwise report when a Marine opened their mail, and from which network.
- Mailbox connectors are read-only (`offline_access`, `User.Read`, `Mail.Read`) and name their national cloud explicitly. Delta sync keys on the provider's message ids, and a message deleted upstream never deletes the local record of the work.
- Live syncing is not wired to a token flow in this build. The authorization plan is shown before anything is authorized, and an unauthorized sync says so rather than reporting an empty mailbox.

## Product analytics

- The event catalog is closed. A client can only send names and properties declared in `server/services/telemetry.ts`; anything else is dropped with a reason.
- No property can hold free text. Values are numbers, booleans, or one of a fixed set of words, so passwords, keystrokes, cancelled drafts, email bodies, and workbook cells have nowhere to go.
- The actor is taken from the session, never from the request body, and a client cannot raise an event the server is responsible for.
- The Owner role grants no privilege over privacy here: the console reports counts and distributions only, and withholds any breakdown fewer than three people produced.
- Events are retained for a bounded window and can be pruned from the console.

## Threats considered

| Threat | Mitigation |
| --- | --- |
| Credential stuffing | Rate limits, long passwords, passkeys, TOTP |
| Replaying an observed authenticator code | Each code accepted once per account |
| Pulling a Marine into your own unit to read them | Direct enrollment only for Marines already led; everyone else by invitation |
| Escalating through a lower role | Grants limited to permissions the granter holds |
| Flooding an inbox with reset or confirmation mail | Per-account caps on every email a user can trigger |
| Sidestepping the demo's closed routes | Paths compared case-insensitively, without trailing slashes |
| Session theft | Digest storage, short idle timeout, revocation on sensitive changes, device list |
| Insider read of private records | Not reachable through the API; audit of every shared read |
| Tampering with the audit trail | HMAC chain verified by the owner |
| CSRF / clickjacking | Client header, `SameSite`, `frame-ancestors 'none'` |
| Malicious upload | Type sniffing, size cap, attachment disposition, no inline render |
| Prompt injection via records | Data labeled untrusted; no tool access; output is a draft |
| Disk full | Write refusal near the size threshold; backups from the console |
| Tracking pixel in imported mail | Remote images stripped, never fetched; the reader is told |
| Script in an email body | Allowlist sanitizer; scripts and handlers dropped before storage |
| Reading a government mailbox from the wrong cloud | The national cloud is declared, never inferred from an address |
| Content leaking into analytics | Closed catalog with scalar-only properties; undeclared values dropped |
| De-anonymizing a small cohort | Breakdowns under three contributors withheld |
