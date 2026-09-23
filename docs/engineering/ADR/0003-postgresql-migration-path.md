# ADR-0003 · PostgreSQL as the production database, reached in stages

**Status:** accepted (plan) · not implemented · **Date:** 2026-09-23

## Context

The contract names PostgreSQL as the production target and allows SQLite for development, test and
demo. Today every service calls `better-sqlite3` synchronously: `db.prepare(...).get/all/run`, and
`db.transaction(fn)()`. That is roughly 40 modules and a few hundred statements. The SQL uses SQLite
specifics:
- `json_extract` and `json_object`;
- `INSERT OR IGNORE`;
- partial indexes;
- `COLLATE NOCASE`;
- `PRAGMA` calls;
- `rowid` ordering;
- BLOB content.

An earlier attempt (`codex/vantage-postgresql-migration-path`) was closed unmerged.

## Decision

Reach PostgreSQL in stages, each shippable, without a big-bang rewrite:

1. **Introduce a data-access port.** Add a narrow async interface (`query`, `one`, `exec`, `tx`) with a
   SQLite adapter that wraps the current connection. Move services onto it one module at a time. The
   case, record and demo modules go first, because they are new. Behavior and tests are unchanged.
2. **Make SQL portable.** Replace SQLite-only constructs:
   - JSON through adapter helpers;
   - upserts written as `ON CONFLICT`;
   - explicit sequence columns instead of `rowid`;
   - `lower()` comparisons instead of `COLLATE NOCASE`;
   - PRAGMA calls moved behind the adapter.
3. **Add the PostgreSQL adapter** (`pg`, parameterized queries only) and a numbered PostgreSQL migration
   set that produces the same schema. Carry the append-only triggers to PL/pgSQL.
4. **Run the whole server test suite against both engines** in CI, with PostgreSQL in a service
   container. Passing on SQLite alone is never reported as passing on PostgreSQL.
5. **Move files out of the database** to the storage abstraction (local volume by default: generated
   keys, SHA-256, original-name metadata).
6. **Provide a one-way, verified data migration** from a SQLite instance: row counts and checksums per
   table, attachment hashes. It is dry-run first and never destructive to the source.

## Consequences

SQLite remains supported for development, the demo and small evaluations. PostgreSQL behavior is
claimed only for what the dual-engine suite covers. `MIGRATION_PLAN.md` tracks progress.
