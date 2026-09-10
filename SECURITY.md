# Security

Report a vulnerability privately to the repository owner rather than in a public issue. Include the version (`/api/health` reports it), steps to reproduce, and impact.

## What the app guarantees

- Private records are private. No role, including the instance owner, can read another Marine's `private` entries through the API. Only `unit` entries reach leaders, and only inside the unit they were shared with.
- Every cross-person read is logged with actor, subject, unit, and time, and the log is a hash chain keyed by `VANTAGE_SECRET`. The owner console verifies the chain.
- Passwords are scrypt hashed; sessions are stored as digests; TOTP secrets are AES-GCM encrypted at rest; passkeys use WebAuthn with the site's domain as relying party.
- Sensitive changes (email, MFA, passkeys, owner console) require re-entering the password within a ten-minute window.
- Sign-in, registration, reset, and MFA are rate limited per IP and per account. Mutations require a client header (CSRF).
- The GenAI.mil key stays on the server. AI requests send only the fields the workflow needs and never another Marine's private data.

See `docs/security.md` for the full model and the threat list.
