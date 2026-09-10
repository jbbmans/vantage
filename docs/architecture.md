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

Added since: `source_files`, `import_jobs`, `work_items`, `work_actions`, `work_views` (spreadsheet intake and
the workbench); `report_drafts`, `report_revisions` (Report Studio, one revision per save with its own source
snapshots); `contacts`, `threads`, `thread_messages`, `thread_links`, `connectors` (correspondence); and
`product_events` (usage and reliability).

## Correspondence

A thread carries three separate dates, not one: `response_at` when somebody replied, `ksd_at` when the
knowledge that was asked for arrived, and `resolved_at` when the matter closed. They move independently,
because a reply that answers nothing is still a reply. Links between a thread and the work it is about live in
`thread_links`, so one email about a hundred documents is stored once and counted once.

Imported HTML is sanitized on the server before it is stored, from an allowlist. Remote images are removed
rather than fetched, and the reader is told. Mailbox connectors record which Microsoft national cloud they
belong to; it is never inferred from an address, because a US-Gov tenant answers on different hosts and asking
the commercial ones reads nothing while looking like success.

## Product events

`server/services/telemetry.ts` holds a closed catalog: every event name and every property is declared there,
and anything undeclared is dropped with a reason rather than stored. A property may be a number, a boolean, or
one of a fixed set of words, so there is nowhere for a draft, a workbook cell, an email body, or a keystroke to
go. Outcome events (rows committed, a thread moved, a revision saved) are raised by the server, where the
count is exact; intent, timing and abandonment are raised by the client, because a form somebody closed never
reached the server. Nothing is raised twice.

Three durations are kept in three columns and never added: how long a form was open, an estimate of active
editing, and the work duration a person confirmed. `server/services/usage.ts` reports them side by side, and
withholds any breakdown fewer than three people produced.

## Offline

The service worker caches the app shell and hashed assets; API calls never touch the cache. Quick Log saves that fail with a network error go to an IndexedDB outbox and replay when `online` fires or the user taps the queued badge. Duplicate replays are absorbed by the fingerprint unique index.

## Client conventions

- Pages under `src/pages`, one per route; shared UI in `src/components/ui`; API and query hooks in `src/lib`.
- Theme tokens are CSS variables (`--canvas`, `--surface`, `--ink`, `--accent`, semantic colors) on `:root`, switched by `data-theme` and `data-accent`; Tailwind maps them with alpha support.
- Forms use a generic `RecordDialog` that handles validation errors, version conflicts, and toasts.

## Testing

- `tests/server`: node:test against an in-memory database, HTTP level, 240+ cases including permission boundaries, MFA, passkeys (mocked), imports, digests, AI mock, instance export/import, the typed metric engine, workbook parsing, the workbench, typed goals, report provenance, correspondence and connectors, and the analytics catalog.
- `tests/browser`: Playwright against the built client and a test-mode server: setup, sign-in, quick log, CSV round-trip, PDF, TOTP, passkeys (CDP virtual authenticator), invites, unit dashboard, counseling, offline queue, axe accessibility in both themes, phone layout, metric drill-down, the workbench, Report Studio, correspondence, and the usage console.
