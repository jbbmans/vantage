# Security model

## Identities and sessions

- Usernames plus a 15-character-minimum password, checked against common patterns, hashed with scrypt.
- Passkeys (WebAuthn, discoverable credentials) with the site hostname as relying party. Passkeys sign in without a password.
- Authenticator app (TOTP, RFC 6238) as a second step for password sign-in, with eight single-use recovery codes.
- Sessions are random 256-bit tokens stored only as SHA-256 digests, in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie. Idle timeout 60 minutes, absolute 12 hours, at most 8 active per user.
- Step-up: sensitive changes require the password again within a 10-minute window (`sudo_until` on the session).
- Password change, role change, membership change, MFA reset, and deactivation revoke the affected user's other sessions.

## Authorization

- A user always reads and writes their own records.
- Records have `visibility` of `private` or `unit`, and a `unit_id`. Only `unit` records in a unit where the reader holds `VIEW_RECORDS` are visible to others; `VIEW_MEMBER_DETAIL` opens a Marine's page; `MANAGE_RECORDS` edits shared entries; `COUNSEL` records counselings and award recommendations.
- Permissions are a bitmask on roles; roles belong to one unit; nothing inherits across the unit tree. The unit owner holds `ADMINISTRATOR` in that unit only.
- The instance owner (operator) manages accounts and settings but has no read access to private records.
- Every cross-person read is audited (`view_member`, `view_record`, `list_records`, `view_readiness`, `build_report`, `export_*`) with actor, subject, unit, IP.

## Integrity

- The audit log is an HMAC hash chain keyed by `VANTAGE_SECRET`; the head is stored separately and verified on the owner overview.
- Records carry a `version`; concurrent edits are rejected with the current copy (409) and the client offers reload or overwrite.
- CSV import screens exact and near duplicates; the database enforces a per-user fingerprint.

## Transport and browser

- HTTPS only in production (`VANTAGE_PUBLIC_URL` must be `https://`), HSTS, a strict CSP with hashed inline bootstrap, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: same-origin`.
- CSRF: state-changing requests must carry `x-vantage-client`; cookies are `SameSite=Lax`.
- Rate limits per IP and per account on sign-in, registration, reset, MFA, and mutations.
- Attachments are sniffed for type (PDF, PNG, JPEG, plain text, CSV), size-limited, hashed, stored in the database, and served with `Content-Disposition: attachment`.

## AI

- Only through GenAI.mil, with the key server-side. Each workflow sends a bounded payload of the caller's own data (or exact-unit aggregates for command briefs); inputs are labeled untrusted in the system prompt.
- Per-user daily token limits and an instance budget. A key lock from the gateway pauses AI and notifies owners.
- Nothing is written from an AI result without the user pressing save.

## Threats considered

| Threat | Mitigation |
| --- | --- |
| Credential stuffing | Rate limits, long passwords, passkeys, TOTP |
| Session theft | Digest storage, short idle timeout, revocation on sensitive changes, device list |
| Insider read of private records | Not reachable through the API; audit of every shared read |
| Tampering with the audit trail | HMAC chain verified by the owner |
| CSRF / clickjacking | Client header, `SameSite`, `frame-ancestors 'none'` |
| Malicious upload | Type sniffing, size cap, attachment disposition, no inline render |
| Prompt injection via records | Data labeled untrusted; no tool access; output is a draft |
| Disk full | Write refusal near the size threshold; backups from the console |
