# Security model

This extends `docs/security.md`, which covers identities, sessions, authorization, integrity,
transport, AI and correspondence. It is not repeated here. This file covers the access modes, the case
history, the Record, and the synthetic demo. Deployment authorization is recorded by the responsible
authority, outside this repository.

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

- Summary, assigned work, contributions, drafts (`/api/record/drafts`, `/api/drafts`) and career routes take no user parameter. They serve
  only the session's own data. Drafts and career steps answer 404, not 403, to anyone else, so they do
  not confirm that the record exists.
- One exception names someone else: a saved form about a Marine (`POST /api/drafts/forms` with `subject_id` and
  `unit_id`, an award recommendation or a personnel change, ADR-0030). It is still its author's alone, and it is saved,
  saved again, read as sendable and sent only while its author may act for that Marine in that unit: Counsel where
  they may see the Marine, or Manage members above them. It answers what the kind's own route answers (403, 404,
  `hierarchy`), so it learns nothing sending the form would not. Its unit is fixed when it is created.
- The per-person workload breakdown needs `VIEW_MEMBER_DETAIL` in the unit, and each view is audited
  (`view_team_workload`). Section totals need `VIEW_RECORDS`.

## Discussion and notices

What is said on a record or a work case, and what Vantage tells people about it (ADR-0031,
`server/services/comments.ts`, `server/services/notifications.ts`).

- **Who may speak** is one rule, `speaks()`: an active person who reads the record by their own access, on a record
  neither frozen nor anonymized, and who belongs to its Unit Instance, or is its Marine on a record that is private or
  in no unit. Their permissions are recomputed without Vantage access (`ownScope`), so staff reading through an access
  grant never write, are never asked or named, and are never told what is said. The same rule decides who may be
  asked, named, offered in the person picker or told of a new comment. Anyone else who reads the record reads its
  discussion and is refused a write (403 `not_a_speaker`). Removing another's comment takes `MANAGE_RECORDS` in the
  record's unit by one's own access.
- **Mentions** are looked up only among the record's Marine and the members of its Unit Instance, then kept only where
  that person speaks. A message names at most 10 people (400); an e-mail address is no mention.
- **A counseling's comments before it was final** (`private`) are read only by its counselor and its Marine, after it
  is final too, and every action on one answers 404 to anyone else. While a counseling is a draft or in review, its
  mentions and requests reach only those two.
- **Rate limits:** 30 questions and review requests an hour per person; the person picker has its own limit (300
  lookups in 15 minutes) and offers at most 10 people.
- **Notices carry no words.** One about a record holds the event and who; the record's name is read when the notice is
  read, after the access check. `GET /api/me/notifications` hides, and leaves out of the unread count, any notice whose
  record or work case its reader can no longer open. A person's export applies the same check.
- **Lifecycle:** notices are kept 180 days, except under a legal hold on the person or their Unit Instance; a destroyed
  or anonymized record takes its notices with it, and anonymizing redacts every comment, request and answer on it,
  except what a person under a legal hold said, which goes at the next run after the hold is released. A record
  anonymized before migration 038 has its discussion redacted at the next run of its schedule. A notice about a Unit
  Instance names it even when it names no record, so an instance hold keeps it.
- **One Unit Instance:** a `BEFORE INSERT` trigger (`comments_same_org_insert`, migration 038) refuses an entry whose
  unit is in another Unit Instance than its record's, and `instanceBoundaryViolations` counts live entries by anyone
  but the record's Marine across the boundary.

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
