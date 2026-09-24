# Security model

This extends `docs/security.md`, which covers identities, sessions, authorization, integrity,
transport, AI and correspondence. It is not repeated here. This file covers the access modes, the case
history, the Record, and the synthetic demo. Nothing here is a claim of accreditation: no DoD, USMC,
MCEN, NETACT-RES, RMF or CAC approval has been sought or granted.

## Access modes

| Mode | How people get in | Where it may run |
|---|---|---|
| `accounts` (default) | Local accounts: 15+ character passwords (scrypt), passkeys, TOTP, step-up, sessions with idle and absolute expiry, rate limits. Optionally CAC through `CAC_MODE=direct` (mTLS) or `CAC_MODE=proxy` (a trusted reverse proxy that must present a 32+ character shared secret). | Evaluation and operation |
| `demo` | No sign-in form. Each visitor receives a disposable workspace of synthetic people and a session as one of them. | Only a non-production instance, on its own database |

Enterprise identity (an approved OIDC/SAML provider or authenticating proxy) is a boundary to be
implemented when the provider is chosen. The existing CAC proxy mode is the model for a trusted
header boundary: configured secret, header validation, and refusal to start when misconfigured. No CAC
PIN is ever collected. See `docs/engineering/INFRASTRUCTURE_QUESTIONS.md`.

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
- **Limit.** A database administrator can drop triggers or edit rows. The audit log's HMAC chain detects
  removed or altered audit entries. Case events are not chained. Chaining them is a candidate follow-up
  if evaluators require tamper evidence at that level.
- Every write re-reads the row in a transaction and checks the caller's authority from the session:
  - read: owner, holder, or unit member for unit-visible work;
  - claim: `CLAIM_WORK`;
  - act and record: holder, owner, or `MANAGE_RECORDS`;
  - move stage: the same, plus `RESOLVE_WORK` to close or reopen;
  - reassign: `REASSIGN_WORK` or `MANAGE_RECORDS`.
  
  Optimistic concurrency returns 409 `version_conflict`.
- A handoff target must be able to read and claim the item on their own authority. The candidate list
  returns only names and ranks of such people, and only to the holder or a reassigner.

## The Record

- Summary, assigned work, contributions, drafts and career routes take no user parameter. They serve
  only the session's own data. Drafts and career steps answer 404, not 403, to anyone else, so they do
  not confirm that the record exists.
- The per-person workload breakdown needs `VIEW_MEMBER_DETAIL` in the unit, and each view is audited
  (`view_team_workload`). Section totals are open to anyone on the team (`VIEW_UNIT` or `VIEW_RECORDS`),
  since they count work the team's queue already shows every member (PD-019).
- A record keeps only the fields its kind asks for (`shared/recordKinds.ts`). The server applies this on
  create, update and import, so a non-work record never stores money, a system of record or detail keys
  outside the fixed list.

## Teams and access levels

- **Roster.** A roster (names, ranks, billets, roles, access levels) is visible to members of that team:
  `rosterUnitIds` is the teams where the caller holds `VIEW_UNIT` or `VIEW_RECORDS`. Nobody sees the
  roster of a team they are not on. `GET /api/org/teams` lists every active team's name, echelon and
  member count, and no people; in the demo it lists only the visitor's own section.
- **Opening a record is separate.** Opening a person's record still needs `VIEW_MEMBER_DETAIL`, a shared
  team and a higher position (`detailUnitsFor`), and each open is audited.
- **Levels.** Personal, Team leader and Administrator (`shared/access.ts`) are read from the permission
  bits in each team, and granted through the system roles `team-leader` (position 50) and
  `team-administrator` (90). `server/services/people.ts` enforces who may set them:
  - nobody changes their own access;
  - `MANAGE_ROLES` sets only levels whose role sits below the caller's position, for people below it;
  - a team's owner sets any level in their team, and the owner changes only by ownership transfer.
- **Organization administrator.** The instance owner can act on every team from People. Outside the
  teams they belong to, every such action, and the organization-wide list with its sign-in facts
  (email, two-step status, last sign-in), needs step-up re-authentication (`sudo_required`).
- **Applying and recording changes.** Every level or membership change revokes the person's sessions
  and writes `set_access_level`, `add_member` or `remove_member` to the audit chain with the before
  and after state.
- **Demo.** Level changes work inside the synthetic section. Adding or removing members is closed, as
  it already was for the unit membership routes.

## Browser and network

- The page loads nothing from third parties. Google Tag Manager was removed, the CSP is
  `script-src 'self'` plus hashed inline bootstrap, `frame-src 'none'`, and fonts are local.
- With AI and the MARADMIN feed off (the defaults), the server makes no outbound requests.
- PostHog forwarding (`VANTAGE_POSTHOG_KEY`) is refused unless the instance is the synthetic demo.
  When set there, the server posts catalogued, pseudonymous events to PostHog from the server side.
  The browser still loads nothing from third parties and the CSP is unchanged. See PD-017 and
  `server/services/posthog.ts`.
- CSV exports neutralize formula injection (`shared/csv.ts`).
- Telemetry accepts only declared events with scalar properties. It holds no free text, identifiers,
  document numbers or keystroke timing (PD-012).

## Data handling

Synthetic data only in development, tests, screenshots and the demo. Deploying the software is not
authorization to process any category of real data. That is a separate decision for the data owner.
