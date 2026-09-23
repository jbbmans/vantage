# Migration plan

Two migrations are in play: the **schema** (additive, applied automatically) and the **database engine**
(SQLite → PostgreSQL, planned in ADR-0003).

## Schema migrations

Numbered migrations live in `server/db/index.ts`. `schema.sql` is replayed on every boot and only
creates tables and indexes that do not exist yet. Each migration runs once, in a transaction, and
records `schema_version` in `meta`. No migration deletes or rewrites user data.

| # | Name | What it does |
|---|---|---|
| 001–007 | existing | unchanged |
| 008 | `008_case_history` | Adds `work_items.stage`, `waiting_category`, `waiting_since`, `blocked_reason`, `procedure_key` and `procedure_version`, and `users.demo_workspace_id`. Backfills `stage` from `state`. Backfills one `action_recorded` event per existing work action and one `claimed` event per current claim, each marked `backfilled`. New tables (`work_events`, `record_drafts`, `career_steps`, `career_profiles`, `demo_workspaces`) come from `schema.sql`. |

**Tested:** `tests/server/migrations.test.ts` builds a database at version 7 with real rows, opens it,
checks the stage and history backfill, and opens it again to show nothing changes the second time.

**Upgrade procedure (current):** stop the service, back up the database file (`docs/operations.md`),
start the new version. The migration runs at startup inside a transaction. There is no automatic
downgrade: restore the backup to roll back.

## Engine migration (SQLite → PostgreSQL)

Stages, per ADR-0003. None has started.

- [ ] 1. Data-access port with a SQLite adapter; move cases, record and demo onto it.
- [ ] 2. Portable SQL across the remaining services.
- [ ] 3. PostgreSQL adapter and migration set, including the append-only triggers.
- [ ] 4. Server suite green on both engines in CI.
- [ ] 5. File storage moved out of the database behind a local-volume abstraction.
- [ ] 6. Verified SQLite → PostgreSQL data migration tool: dry run, counts, checksums, attachment hashes.

## Product migration (the old interface to this one)

This is not a separate cutover. The same database serves the same routes. Old paths redirect with
their query strings. Nothing a Marine recorded moves or changes meaning. Activities, training, awards,
counseling, goals, reports and correspondence are all where the parity checklist says they are.
