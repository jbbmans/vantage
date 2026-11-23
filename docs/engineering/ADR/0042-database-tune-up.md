# ADR-0042 · Database tune-up: the missing indexes, one size measure, scheduled upkeep and overwritten deletions

**Status:** accepted · **Date:** 2026-11-23 · **Builds on:** [ADR-0011](0011-vantage-administrator-console-operations.md)
(the console's health checks and database tasks), [ADR-0032](0032-performance-accessibility-responsive.md) (the
period indexes), [ADR-0041](0041-verified-backups-and-safer-upgrades.md) (fixtures and fingerprints)

## Context

Several reads still read a whole table. Nothing indexed `goals.assignee_id`, so every goals read shaped
`(user_id = ? OR assignee_id = ?)` scanned goals: the records list, the member page, analytics, the weekly digest, the
personal export, personnel counts, the report center and the timeline. `work_items.owner_id`, `contacts.owner_id`,
`tokens.user_id` and `support_tickets.unit_id` had no index either: revoking a person's links read every token of that
kind, an organization sign-in that linked an account read every token, the open Vantage support count and the privacy
inventory read every ticket, and with foreign keys on, deleting an account read goals, work items, contacts and tokens
in full. The recycle bin purge, every six hours, read all eight record tables, attachments and comments in full to find
the rows deleted more than 30 days ago.

The size of the database was measured four ways. Record creation, workbook uploads, attachments and import attachments
compared the main file's size on disk, which leaves out everything still in the write-ahead log and is skipped for a
database in memory. The health check used `page_count * page_size`, and the Overview showed the file's size, so one page
could show two sizes. The copy before an upgrade counted the pages in use, and Compact the main file. A record refused
at the threshold went out as `record_quota`, the others as `database_capacity`.

Upkeep was manual. The console's database tasks run on the service's own thread when someone runs them, the start runs
`PRAGMA optimize` once, and nothing checked the database for damage on a schedule.

SQLite leaves deleted rows' bytes on free pages until something writes over them, so a removed record's text stayed
readable in the file, and in any copy taken from it, until Compact.

The unit window indexes from migration 039 key on the last day each record covers, so only `last >= from` bounded the
index range. The window's other end (`date <= to`) was tested after a seek into the table. The read of the window before
the current one (the comparison figures) visited every row of the current window too, and All time's earlier window
visited every shared entry of the unit to return none.

## Decision

1. **Migration 043 `043_tune_up_indexes`, indexes only.** No table, column, trigger or row changes.
   - `idx_goals_assignee ON goals(assignee_id) WHERE assignee_id IS NOT NULL`: an equality on the assignee implies the
     predicate, so every read above uses it, as one branch of the OR beside `idx_goals_user`.
   - `idx_work_items_owner ON work_items(owner_id, visibility, unit_id)`, `idx_contacts_owner ON contacts(owner_id)`,
     `idx_tokens_user ON tokens(user_id, kind)`, `idx_support_unit ON support_tickets(unit_id, state)`.
   - `idx_<table>_deleted ON <table>(deleted_at) WHERE deleted_at IS NOT NULL` for the eight record tables,
     attachments and comments. They hold only what is in the bin, so live writes barely touch them and no live read can
     pick them; the purge reads only the rows it removes.
   - The three unit window indexes are rebuilt under the same names with `date` after the last-day expression, so
     both ends of a window are tested on the index before any row of the table is read. A database whose indexes
     already end in `date` keeps them.
   - Every statement is `CREATE INDEX IF NOT EXISTS` or guarded, so a rerun does nothing. As with 039, the indexes live in
     the migration, not in `schema.sql`; a new database runs it like an old one.
2. **The work list reads by its indexes.** `listItems` (`server/services/work.ts`) wrote the personal part of its
   visibility as one condition with an OR inside, which no index serves. It is now three OR branches, each testing one
   indexed column (the owner, the holder, the units read), with the same meaning.
3. **One size measure.** `databaseSize(db)` (`server/db/size.ts`) gives `bytes`, every page of the database as it now
   stands (`page_count * page_size`: what is still in the write-ahead log counts, and free pages count until Compact
   gives them back), with `usedBytes` and `freeBytes`. No comparison reads the file. `databaseRoom` gives one refusal,
   HTTP 507 `database_capacity`, for records, workbook uploads and attachments alike, on a file or an in-memory
   database. An import's attachments are held to the same room one by one: one that does not fit is listed among the
   import's problems, and the rest of the import goes in. The health check, the Overview (which now also shows the free pages inside and takes its tone
   from the health check), Compact and the space check before an upgrade's copy read the same function: Compact and the
   copy plan around `usedBytes`, which is what they write.
4. **Scheduled upkeep, its long read off the service's thread** (`server/services/databaseUpkeep.ts`,
   `databaseUpkeepWorker.ts`).
   - An hourly scheduled job runs it once the last run is `VANTAGE_DB_UPKEEP_HOURS` old (24 by default, 1 to 168), so
     a service restarted every day still runs it. Never during maintenance, and never for a database in memory.
   - A worker thread opens its own connection and runs SQLite's `integrity_check`, then a passive checkpoint that folds
     in what was written meanwhile. Neither takes the write lock.
   - The two steps that take the write lock run back on the service's own connection, without waiting for it:
     `PRAGMA optimize(0x10012)` (every table whose statistics are stale, each under SQLite's analysis limit) and a
     truncating checkpoint. Another process holding the lock, or a reader in the log, leaves the step for the next run.
     On a second connection these steps made the service's transactions that read before they write (every audit
     entry) fail at once with `SQLITE_BUSY`: SQLite does not wait for a lock a transaction already reading would have to
     take. On the service's connection they cannot meet its transactions, and its planner uses the new statistics at
     once. They took 45 ms for 40 stale tables in a 126 MB database in the container.
   - The run is kept in `meta` (`database_upkeep`, which an instance archive does not replace) and audited as
     `database_upkeep`, with no actor, in the enterprise category: what it found, the tables refreshed and the log
     pages folded in, never a record. It shows under Maintenance as "Scheduled upkeep", under Scheduled jobs, and as the
     **Database upkeep** health check.
   - Damage the integrity check finds tells the staff who view the platform and fails the health check until a later
     run finds none; a count at the check's limit of 100 is said as at least 100. Damage that stops the check
     (`SQLITE_CORRUPT`, such as a schema SQLite cannot parse, or `SQLITE_NOTADB`) is damage too. On a damaged database
     the statistics and the log are left as they are. A run that stops (an error, or more than an hour) is recorded and
     audited the same way and needs attention; the next waits its interval like any other. A stopped run keeps the last
     damage found, so the health check keeps failing until a run finds none. No run for twice its interval needs
     attention too.
   - A worker thread cannot be stopped inside a call into SQLite: told to stop, it ends when that step returns. So the
     time limit records the run at once, naming the step, and the thread is held as running until it ends; no tick
     starts another beside it. Starting maintenance stops a run under way and records nothing, and Compact and
     emptying the log refuse (409 `upkeep_running`) until the thread has ended: its read keeps the log from being
     emptied.
   - The Maintenance page lists the last 30 steps people took and, beside them, the last 5 scheduled runs, so a daily
     run never pushes an operator's step off the page.
5. **Deleted text is overwritten.** Every connection `openDatabase` opens, and the restore's working copy, which
   removes sessions, links and queued mail, sets `secure_delete = ON`:
   a deleted row's bytes are zeroed where they lay, in the page and in the free pages, so they are not in the file or
   any copy taken from it once the log is folded in. What was deleted before this build stays on free pages until
   Compact.
6. **`unit-metrics-stall`:** the rebuilt window indexes are the index part. The register item stays open for the
   single-pass metrics read and the per-bucket rescans in the engine, which are most of the remaining time.

## Consequences

- Each listed read's plan uses its index, captured from the code that runs it, and the purge and the window reads are
  held to theirs: `tests/server/databaseTuneUp.test.ts`. The migration's indexes, its rebuild and its rerun:
  `tests/server/migrations.test.ts`. Every frozen fixture upgrades to a new database's schema at 43, and the ledger
  records 43: `tests/server/databaseFixtures.test.ts`.
- A database that grows by what is still in the log now reaches the threshold when its pages do, not when a checkpoint
  catches up. A database in memory is held to the threshold too.
- Deletes write more: a freed page is written as zeros. Purges and Compact take a little longer.
- An upgrade to 043 builds the new indexes and rebuilds the three window indexes, which on a large database takes some
  seconds at the first start. The indexes take some disk; the deleted indexes hold only what is in the bin.
- Statistics the upkeep refreshes are approximate (the analysis limit). The start still runs a full `optimize` once.
- A service stopped during a run exits when SQLite ends the step it is in. The full integrity check took about 1.5 s
  for a 288 MB database held in memory in the container; read from disk it takes longer. While it reads, the log
  cannot be emptied, so it grows by what is written meanwhile. The thread's passive checkpoint folds that in right
  after; a write the service commits in that instant can fold it in itself, holding that request for the copy.
- The statistics and the truncating checkpoint hold the service's thread while they run, once a run: tens of
  milliseconds at the sizes measured.
- Rolling back means the build before this one, which refuses schema 43: restore the copy the start kept before the
  upgrade, or the backup taken before it.
