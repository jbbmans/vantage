# Architecture

A modular monolith. One Node.js process serves the API and the compiled client. The data layer today
is SQLite. The production target is PostgreSQL (ADR-0003). `docs/architecture.md` has the earlier
overview; this file supersedes it where they differ.

```
browser (React 19, Vite build, Tailwind, TanStack Query; every asset served locally)
   │  HTTPS 443 → reverse proxy (TLS) → app
   │  /api/* JSON · cookie session · x-vantage-client CSRF header
   ▼
Node 22 · Express 5 · TypeScript run directly (no server build step)
   ├─ auth/      sessions, TOTP, passkeys, CAC (direct mTLS or trusted proxy), limiter
   ├─ authz/     scope resolved per request from the session; record visibility
   ├─ routes/    auth, me, records, work, record, org, correspondence, support, admin, demo, misc
   ├─ services/  work (queue, claims), cases (history, stages, entries, handoffs, calculation),
   │             record (Record, workload, drafts, career), intake (imports), demo, org, metrics,
   │             reports, correspondence, retention, personnel, audit, telemetry, ai, email
   └─ db/        schema.sql (idempotent), numbered migrations, ranks seed
   ▼
SQLite (better-sqlite3, WAL) on a local volume · attachments and source files as BLOBs today
```

`shared/` holds domain logic used by both sides:
- `caseModel.ts`: stages, event kinds and their zod schemas
- `procedures.ts`: the 2-Way UMT procedure, progress derivation, the candidate calculation
- `money.ts`: exact cents
- `record.ts`: definitions and limits; career schemas
- the existing parsers, metrics and permissions

## Module boundaries

| Boundary | Owns | Talks to |
|---|---|---|
| Identity and sessions | accounts, sessions, MFA, CAC | authz |
| Organization and authorization | units, memberships, roles, scope | everything, read-only |
| Work | work items, queue, claims | cases, intake, correspondence |
| Cases | `work_events`, stages, research, controls, handoffs | work, procedures |
| Imports | source files, jobs, lineage | work, cases |
| Record and career | projections of events; drafts; career | cases (read), records |
| Records (personal documentation) | activities, training, awards, counseling, goals | metrics, reports |
| Reporting | metrics, reports, analysis, workload | read-only over the above |
| Audit and telemetry | audit chain, product events | written by all |
| Administration | runtime settings, governance, exports | operators only |
| Demo | synthetic workspaces | org, work, cases (demo database only) |

## Request path for a case write

route → `scopeFor(session)` → service opens a transaction → reload the row → authorize against the row
→ check the version → validate the body per kind → append an event → update the row and its version
→ commit. The client invalidates the item, the queue, the Record and the workload queries after every
write.

## Configuration

Environment variables, validated at startup (`server/config.ts`). Dangerous combinations are refused:
- production without a 32+ character secret, a setup token, or an HTTPS public URL;
- CAC proxy mode without a shared secret;
- demo mode in production or alongside CAC, email, AI or the MARADMIN feed.

See `.env.example`.

## Tests

- `tests/server/`: node:test, HTTP level, in-memory SQLite. 361+ cases, including the case model,
  Record, demo isolation, and migrations from a v7 database.
- `tests/browser/`: Playwright on the built client:
  - `server.ts` runs an accounts-mode instance;
  - `demo-server.ts` runs a demo instance for `22-demo.spec.ts`;
  - axe runs in both themes;
  - four viewports are checked for sideways scrolling.

SQLite passing is not proof of PostgreSQL behavior (ADR-0003).
