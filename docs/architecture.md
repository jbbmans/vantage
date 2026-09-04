# Architecture

```
browser (React 19, Vite, Tailwind, TanStack Query, service worker + IndexedDB outbox)
   │  /api/* JSON, cookie session, x-vantage-client header
   ▼
Express 5 on Node 22 (TypeScript run directly, no build step)
   ├─ auth/       sessions, TOTP, passkeys, tokens, limiter, middleware
   ├─ authz/      per-request permission scope, record visibility rules
   ├─ services/   records, org, reports, pdf, dashboard, digest, ai, email, maradmins, exports, audit
   ├─ routes/     auth, me, records, org, misc (reports, ai, maradmins, search), admin
   └─ db/         schema.sql, migrations, ranks seed
   ▼
SQLite (better-sqlite3, WAL) on a persistent disk
```

`shared/` holds the domain logic used on both sides: the quick-log parser, metrics, bullet and narrative composition, period comparison, duplicate screening, CSV mapping, JEPES and FITREP coaching, permissions, and the zod schemas that validate every write.

## Data model (fresh in 5.0)

`users`, `ranks`, `sessions`, `tokens`, `passkeys`, `recovery_codes`, `units` (tree), `roles` (per unit, bitmask), `unit_members`, `member_roles`, seven record tables (`activities`, `projects`, `tasks`, `goals`, `trainings`, `awards`, `counselings`) sharing `user_id`, `unit_id`, `visibility`, `version`, `frozen_at`, `deleted_at`, plus `readiness`, `attachments`, `notifications`, `audit_log`, `email_log`, `maradmins`, `maradmin_user_state`, `ai_usage_daily`, `meta`.

## Offline

The service worker caches the app shell and hashed assets; API calls never touch the cache. Quick Log saves that fail with a network error go to an IndexedDB outbox and replay when `online` fires or the user taps the queued badge. Duplicate replays are absorbed by the fingerprint unique index.

## Client conventions

- Pages under `src/pages`, one per route; shared UI in `src/components/ui`; API and query hooks in `src/lib`.
- Theme tokens are CSS variables (`--canvas`, `--surface`, `--ink`, `--accent`, semantic colors) on `:root`, switched by `data-theme` and `data-accent`; Tailwind maps them with alpha support.
- Forms use a generic `RecordDialog` that handles validation errors, version conflicts, and toasts.

## Testing

- `tests/server`: node:test against an in-memory database, HTTP level, 60+ cases including permission boundaries, MFA, passkeys (mocked), imports, digests, AI mock, instance export/import.
- `tests/browser`: Playwright against the built client and a test-mode server: setup, sign-in, quick log, CSV round-trip, PDF, TOTP, passkeys (CDP virtual authenticator), invites, unit dashboard, counseling, offline queue, axe accessibility in both themes, phone layout.
