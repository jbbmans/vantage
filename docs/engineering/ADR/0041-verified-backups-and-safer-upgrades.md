# ADR-0041 · Checked backups, restore drills, a copy before every upgrade, and schema fingerprints

**Status:** accepted · **Date:** 2026-11-22 · **Builds on:** [ADR-0014](0014-mcen-operations.md) (backups and restore),
[ADR-0040](0040-security-fixes-for-later-features.md) (every database copy private from its first page)

## Context

A backup was a consistent, private copy, but nothing said it could be restored. `scripts/backup.ts` wrote the file and
recorded it; nothing read it back. A copy damaged on its way to the backup disk, or taken from a database already
damaged, was found the day it was needed. The one way to rehearse a restore, `restore.ts --dry-run`, took the
database's exclusive lock, so it could only run with the service stopped, and so it was rarely run. It also could not
read the audit trail of a backup older than the organization columns (`no such column: org_id`).

An upgrade migrated the database in place. The run book said to take a backup first; nothing made sure one existed, and
a start that failed halfway through a migration left the operator with whatever their last backup was.

The migrations had no test that an upgraded database ends up with the schema a new one gets. A new database runs
`schema.sql` and then every migration, so a migration edited after release (a CHECK widened, an index added in place)
changes new databases and leaves every upgraded one behind, and every test still passes. Fingerprinting the migration
source would trip on every comment edit and miss what actually changed.

## Decision

1. **Every backup is checked before it counts.** `checkBackup` (`server/services/backupCheck.ts`) reads a copy the way
   a restore will: the file is there and is a SQLite database; it is one file (a non-empty `-wal` or `-journal` beside it
   is a fault, since a backup is one file); SQLite's full `integrity_check` passes; it holds Vantage's tables at a schema
   this build knows and names its database; its audit trail verifies under the service's secret when one is given; and
   any `<file>.sha256` beside it still matches. A copy with side files or in WAL mode is read through a private
   temporary copy, so the check never writes beside a backup or replays a log onto it. The faults are named, so a
   corrupted backup is reported as corrupt, a truncated one as not a database, and one changed after it was taken as a
   checksum mismatch.
2. **Taking a backup refuses a copy that fails.** `scripts/backup.ts`, the browser download and the start-over copy run
   the check on the copy they just took. A file fault removes the copy: the script exits 1 and says whether the live
   database passes the same integrity check (if it does, the copy was damaged on its way; if not, the database is, and
   the last good backup is the way back); the download answers `500 backup_unsound` and sends nothing. A trail fault does
   not refuse a fresh copy, since the copy holds exactly what the live database holds; it is reported, and the record
   says so. Audit entries with no chain key or head to check them against are a trail that does not verify. A file the
   check cannot read, or a `.sha256` that is not a file, is a named fault, never a crash. A live database at a newer
   schema than this build's is refused as that, with no disk blamed. A sound copy gets its SHA-256 beside it as
   `<file>.sha256` (`sha256sum -c` format), in its backup record
   and audit entry, and on a download as `Content-Digest` (RFC 9530). A copy taken over an older one leaves the older
   `.sha256` in place until it passes, so a run that fails still leaves a copy that can be told apart. Every `.sha256` is
   written to a new file made exclusively and renamed into place, so a link planted at its name is never followed. A
   download is sent whole whatever the request asks (no ranges, no conditional answer), after the session is checked
   again once the copy has passed, and never kept by a cache on the way (`no-store`, no validators). The download's
   check runs on a worker thread, so the service keeps answering other requests while a large copy is read; only the two
   secrets go to that thread. A copy that cannot
   be sent is answered with an error that carries none of the file's headers. `backup.ts --verify <file>`
   runs the check on any backup, writes nothing, and says whether this database recorded taking it.
3. **A restore drill runs beside the live service.** `restore.ts DRILL --from <file>` needs no `VANTAGE_RESTORE` and
   takes no lock: it opens the live database read-only, checks the backup with the trail required, copies it into a
   private scratch file beside the database (and refuses if the copy's SHA-256 differs from the backup's), applies every
   step a restore applies, opens the result with this build as the next start would, upgrading an older backup and
   refusing one whose rows the upgrade changes, checks it again under `VANTAGE_SECRET` alone, says what a restore would
   undo, and removes the scratch file. `--dry-run` is the same drill plus the authorization check, and also runs with the
   service up. Only a real restore takes the exclusive lock. A drill of another database's backup passes and says so; the
   dry run and the restore still refuse one without `--different-database`. Who may authorize is read from the live
   database, or from the backup when the live database or its accounts cannot be read; a database from before platform
   roles names its owners by `users.is_operator`, as the migration to roles read them. A throw before the restored copy
   is in place removes the scratch copy, and a drill or dry run that stops so is recorded as stopped. Signals keep their
   default in a drill, since the work is synchronous and a handler would only run once it was done: Ctrl-C stops a
   drill at once and can leave its scratch copy. A restore handles a signal while it draws its safety copy, its one
   wait, by removing what was drawn; a stop that comes while that copy falls back to copying the files byte by byte
   (synchronously) is handled before the step ends, so the restore still stops with nothing replaced. What a restore
   undoes is read from the database it replaces; one too damaged to give it still restores.
4. **Drills are recorded and audited.** Each drill and dry run, passed or failed, is kept in the live database's
   `drill_history`: every one not yet audited (up to 200), and the last twenty audited; host history that a restore
   carries over. The running service writes each into the platform audit trail as `restore_drill` within five minutes
   (the backup audit job), and a failed one notifies the staff who hold platform data, a drill of a backup that is not
   there among them. A dry run stopped for who authorized it or another database's backup, and a drill or dry run
   stopped for too little room, is recorded as refused, audited as refused before the backup was rehearsed, and
   notifies no one. One that stopped on an error is audited as stopped, and staff are told to drill again once that is
   put right. **Backup and restore → Restore drills** lists them and **Operations → Backups** shows the last, a stopped
   one as stopped, never as failed; there, who ran each, the host account and the name a refused dry run gave are
   shown only to staff holding `platform.data` or `platform.audit`, and other staff see any path on the host in a
   drill's message by its file name alone.
5. **A start keeps a copy before it migrates.** When a file database is below this build's schema, `openDatabase` runs
   `quick_check`, vacuums the database into `vantage-before-upgrade-<from>-to-<to>-<stamp>-<tag>.db` in
   `VANTAGE_UPGRADE_COPY_DIR` (default: beside the database), owner-only before its first byte, with its `.sha256`, and
   checks the copy (sound, at the old schema, every audit entry). `<tag>` is the first eight hexadecimal characters of
   the SHA-256 of the database's resolved path, so two databases sharing a copy directory never prune each other's
   copies. Only then does the first migration run. A damaged database, too little room or a copy that does not check
   out stops the start before any migration, at the old schema. The newest `VANTAGE_UPGRADE_COPIES_KEPT` copies of each
   database stay (default 3, 1 to 20), the one just made always among them; older ones the service made of that
   database are removed and nothing else in the directory is touched. A failed upgrade records the database as the
   start left it (`left`: its id, schema, newest audit entry, row count outside `meta`, and a SHA-256 of every row of
   every table, its settings included but for the upgrade history the failed start writes after it). A start after it
   reuses the copy the failed start recorded, and makes and prunes nothing, while that file is there, matches its
   `.sha256` and the database is still as `left` says: a migration that fails on every start would otherwise prune the
   database as it was out of the directory within a few restarts. Once anything was written since, a row added, removed
   or only changed, or a setting (the previous build served it, someone corrected a row by hand, or a restore put
   another state in place), the start takes a copy of the database as it now is. Reading every row takes a while on a
   large database, and is done only when an upgrade has failed. The copies failed starts
   named since the last upgrade that completed are never pruned.
   A file database that records no schema version but holds rows in any table other than its settings is refused
   with nothing copied or migrated, since this build cannot tell which migrations it ran; the error names the tables.
   A new database holds rows only in its settings until its first migration records schema 1. The upgrade record and its audit entries name the
   copy. There is no setting that skips it; a new database, one at the current schema and an in-memory one need none.
6. **Migrations are tested by the schema they produce.** `server/db/schemaShape.ts` reads every table, index, trigger
   and view from the database's own `sqlite_master`, drops comments, spacing and letter case outside quotes, keeps a
   table's column and constraint definitions as a sorted list (so a column an upgrade appended matches one a new
   database declares in the middle), and hashes the result. Frozen fixtures in
   `tests/fixtures/databases/` are databases that released builds wrote through their own API (`v5.0.0.db` at schema 14,
   then schema 22 and 42 from main), each with a manifest entry giving its ref, commit, SHA-256, row counts and what the
   build answered to each scenario step. `tests/server/databaseFixtures.test.ts` upgrades each fixture with this build's
   migrations and requires its schema to equal a new database's; a difference names the object and the migration that
   last changed it. `fingerprints.json` records the fresh-database fingerprint for each released schema version; a new
   database at a recorded version must match it, so a migration edited after release fails the test and a reworded
   comment does not. A fingerprint shows only that a new database is unchanged; a migration edited in place is caught on
   upgrade only by a fixture frozen at or after its version, which already ran it as it shipped. So every recorded
   version below the newest must be reached by a frozen fixture: the ledger test fails otherwise, and
   `fingerprint --write` refuses to record a new version until the previous one has its fixture.
   `scripts/database-fixtures.ts freeze <ref>` builds a fixture from a git ref in a temporary worktree (removed even when
   the run is interrupted; a stop writes nothing, and a build that crashes is reported as the failure it is),
   `fingerprint --write` records a new version (it never changes a recorded one), and `check`
   runs the parity test.
7. **Old trails verify.** `verifyAuditChainOf(db, key)` reads a trail from whatever columns its table has, reading the
   missing ones as NULL, which is how those entries were sealed. The backup check and the restore use it, so a backup
   from before organizations can be checked, drilled and restored.

## Consequences

- A corrupted, truncated or altered backup is named as such by `--verify`, the drill and the restore, and the restore
  refuses it. Tests: `tests/server/verifiedBackups.test.ts` (five damaged cases, a sidecar that cannot be read, a
  damaged copy in log mode, a trail with no chain, the drill against a database being written, the upgrade of the
  schema 14 fixture during a drill, a drill and dry run against a pre-organization database, refused dry runs, the
  drill history's cap, who-ran redaction and host paths, a ranged or conditional download, one that cannot be sent, a
  download checked on a thread of its own, a live database at a newer schema, a restore over damaged accounts, a drill over a live trail it cannot read past, a
  drill stopped by an error it did not expect, a stop while a restore copies the database it replaces) and `tests/server/databaseFixtures.test.ts` (the copy before an upgrade, per-database pruning, a copy
  reused across failed starts and not once a row was added, changed or a setting written, an unversioned database refused for rows in any table, a refused start, a changed migration, a reworded one,
  no recorded version without a fixture).
- Operators can rehearse a restore on any day without a maintenance window; the console shows when the last drill ran
  and what it found.
- An upgrade needs free room for one more database in the copy directory. The copies are for undoing an upgrade on that
  host and do not replace backups kept off it.
- A new migration must keep the fixtures upgrading to a new database's schema. When it ships, `fingerprint --write`
  records its version and a new fixture is frozen from the release (`freeze <tag>`). The fixtures are binary files kept
  in git (1 to 2 MB each).
- No migration: `drill_history` lives in `meta`, and the backup record's new fields are optional.

## Not done

- Backups are not encrypted by Vantage; the run book still says to encrypt them before they leave the host.
- Nothing schedules drills. The run book asks for one after each upgrade, at least monthly and before any restore.
