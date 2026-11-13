# Security model

This extends `docs/security.md`, which covers identities, sessions, authorization, integrity,
transport, AI and correspondence. It is not repeated here. This file covers the access modes, the case
history, the Record, and the synthetic demo. Nothing here is a claim of accreditation: no DoD, USMC,
MCEN, NETACT-RES, RMF or CAC approval is established by this repository. Deployment authorization is a separate decision for the responsible authority.

## Access modes

| Mode | How people get in | Where it may run |
|---|---|---|
| `accounts` (default) | Local accounts: 15+ character passwords (PBKDF2-HMAC-SHA256), passkeys, TOTP, step-up, a lockout after three failures, sessions with 15-minute idle and absolute expiry, rate limits. Optionally CAC through `CAC_MODE=direct` (mTLS) or `CAC_MODE=proxy` (a trusted reverse proxy that must present a 32+ character shared secret). | Evaluation and operation |
| `demo` | No sign-in form. Each visitor receives a disposable workspace of synthetic people and a session as one of them. | Only a non-production instance, on its own database |

OIDC organization sign-in is implemented in `server/auth/oidc.ts` and `server/routes/auth.ts`; the deployment must choose and configure an approved provider. SAML is not implemented. CAC direct and proxy modes remain separate configured boundaries. The proxy requires a secret and validated headers, and refuses unsafe configuration. Vantage never collects a CAC PIN. See `docs/engineering/INFRASTRUCTURE_QUESTIONS.md`.

Passkey challenges live in the database for restart continuity, expire after five minutes, and are atomically consumed before verification. Registration and authentication are separate purposes. The store is bounded to 2,000 pending challenges; expiry cleanup also runs with session cleanup. Pending challenges are excluded from portable archives and personal exports, cleared on restore/import, and classified in the privacy inventory. This does not make the SQLite deployment a distributed service.

## Synthetic demo safeguards (tested in `tests/server/demo.test.ts`)

- `VANTAGE_ACCESS_MODE=demo` is refused with `NODE_ENV=production`, with CAC enabled, with a real email
  provider, with AI enabled, and with the MARADMIN feed enabled.
- The database guard (`assertDatabaseMatchesMode`) works in both directions:
  - A demo server refuses a database that holds any real account.
  - A database first opened in demo mode is flagged `meta.demo_database = '1'`, and an accounts server
    refuses to start on it.
- Demo mode is never entered because an authentication call failed. The client asks the server which
  mode it is in; on an accounts instance `/api/demo/*` is a 404.
- Protected APIs still require a session. With no demo session, `/api/work/items`, `/api/record/*` and
  `/api/me` return 401.
- Synthetic people have unusable password hashes, no email, and no operator authority. Sign-in,
  registration, reset, invitation, administration, support, M365 connectors, AI, unit creation, join
  codes and the directory are closed in demo mode (`demoGuard`).
- Workspaces are isolated by membership, the same scope every read goes through. Items cannot be read,
  claimed or handed across workspaces (tested).
- A workspace expires after `VANTAGE_DEMO_TTL_HOURS` (default 24) and is removed whole. Dependents are
  found through the schema's foreign keys, the removal checks that nothing dangles, and the demo
  database's audit chain is resealed. That reseal refuses to run anywhere but a demo database.
- Starting a workspace needs the CSRF header, is rate-limited per connection, and is capped by
  `VANTAGE_DEMO_MAX_WORKSPACES` (503 with a plain message when full).

## Case history

- `work_events` is append-only at the database. Triggers refuse UPDATE always and DELETE outside a demo
  database. Corrections are new events that name the one they supersede.
- Case events have HMAC-backed hash chains in `work_event_seals` and `work_event_heads`, implemented in `server/services/caseSeal.ts`; case views report integrity. The audit log has its own HMAC chain. **Limit:** an administrator controlling both the database and the sealing keys can rewrite local evidence. Independently retained, off-host audit records are still needed.
- Every write re-reads the row in a transaction and checks the caller's authority from the session:
  - read: owner, holder, or unit member for unit-visible work;
  - claim: `CLAIM_WORK`;
  - act and record: holder, owner, or `MANAGE_RECORDS`;
  - move stage: the same, plus `RESOLVE_WORK` to close or reopen;
  - reassign: `REASSIGN_WORK` or `MANAGE_RECORDS`.
  
  Optimistic concurrency returns 409 `version_conflict`.
- A handoff target must be able to read and claim the item on their own authority. The candidate list
  returns only names and ranks of such people, and only to the holder or a reassigner.
- Bulk claim, release and handoff accept at most 100 distinct case IDs with selected versions. Preview is read-only. Apply rechecks each case in its existing transaction and reports partial refusals individually. Actor-, case- and payload-bound request identifiers prevent retries from repeating history; replay still requires current read access. Bulk operations do not close cases, bypass funds checks, or create financial credit.

## The Record

- Summary, assigned work, contributions, drafts and career routes take no user parameter. They serve
  only the session's own data. Drafts and career steps answer 404, not 403, to anyone else, so they do
  not confirm that the record exists.
- The per-person workload breakdown needs `VIEW_MEMBER_DETAIL` in the unit, and each view is audited
  (`view_team_workload`). Section totals need `VIEW_RECORDS`.

## Browser and network

- The page loads nothing from third parties. Google Tag Manager was removed, the CSP is
  `script-src 'self'` plus hashed inline bootstrap, `frame-src 'none'`, and fonts are local.
- With AI and the MARADMIN feed off (the defaults), the server makes no outbound requests.
- CSV exports neutralize formula injection (`shared/csv.ts`).
- Telemetry accepts only declared events with scalar properties. It holds no free text, identifiers,
  document numbers or keystroke timing (PD-012).

## Data handling

Synthetic data only in development, tests, screenshots and the demo. Deploying the software is not
authorization to process any category of real data. That is a separate decision for the data owner.
