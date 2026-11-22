import Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fchmodSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statfsSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

type Db = Database.Database;

/**
 * Copies of the database that are checked and can be checked again (ADR-0041): the copy a start keeps before it
 * upgrades the database, and the SHA-256 kept beside every copy. Like upgrades.ts, this imports nothing from
 * server/db/index.ts, which imports it.
 */

/** The SHA-256 of a file's bytes, in hex, read a megabyte at a time. */
export function sha256File(path: string): string {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1 << 20);
    for (let n = readSync(fd, chunk, 0, chunk.length, null); n > 0; n = readSync(fd, chunk, 0, chunk.length, null)) hash.update(chunk.subarray(0, n));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

/** Where a copy's SHA-256 is kept: beside it, in the form `sha256sum -c` reads. */
export const checksumFileOf = (file: string) => `${file}.sha256`;

/**
 * Writes `<file>.sha256` beside a copy, owner-only like the copy: `<hex>  <file name>`. It is written into a new file of
 * its own, made exclusively, and renamed into place, so a link another account planted at either name is replaced and
 * never followed, and a reader sees the old line or the new one, never half of one.
 */
export function writeChecksumFile(file: string, sha256: string): string {
  const path = checksumFileOf(file);
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${sha256}  ${basename(file)}\n`);
    closeSync(fd);
    renameSync(temp, path);
  } catch (error) {
    try { closeSync(fd); } catch { /* closed */ }
    rmSync(temp, { force: true });
    throw error;
  }
  return path;
}

/**
 * What the `.sha256` beside a copy says of it: its SHA-256, `null` when there is no such file, `unreadable` when the file
 * is not in that form, and `other` when it names another file.
 */
export function readChecksumFile(file: string): string | null {
  const path = checksumFileOf(file);
  if (!existsSync(path)) return null;
  const line = readFileSync(path, 'utf8').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line);
  if (!m) return 'unreadable';
  return m[2] === basename(file) ? m[1].toLowerCase() : 'other';
}

/**
 * A consistent copy of the database this connection reads, taken at once by SQLite vacuuming into a new file: the file
 * is made owner-only before SQLite writes a byte to it, and removed when the copy fails. It holds what the connection
 * sees, write-ahead log included, and needs no log of its own. Unlike `backupDatabase` it does not wait, so a start can take one before it
 * migrates. It runs outside any transaction.
 */
export function copyDatabaseInto(db: Db, dest: string): void {
  writeFileSync(dest, '', { flag: 'wx', mode: 0o600 });
  chmodSync(dest, 0o600);
  try { db.prepare('VACUUM INTO ?').run(dest); }
  catch (error) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${dest}${suffix}`, { force: true });
    throw error;
  }
  chmodSync(dest, 0o600);
}

/** The copy a start kept before it upgraded the database, as the upgrade record names it. */
/** A copy kept before an upgrade. `trail` says whether its audit trail verified when it was taken, where a start checked. */
export interface UpgradeCopy { file: string; bytes: number; sha256: string; trail?: { ok: boolean; reason?: string } }

export interface UpgradeCopyOptions {
  /** Where the copies go: the database's own directory unless VANTAGE_UPGRADE_COPY_DIR says otherwise. */
  dir?: string | null;
  /** How many of these copies stay in that directory, newest first (VANTAGE_UPGRADE_COPIES_KEPT). */
  keep?: number;
  /**
   * Checks the copy's audit trail under the service's secret (the start passes checkTrailOf). A copy whose trail does
   * not verify is still kept, since the database's own trail fails the same way, but a restore refuses it, and the start
   * says so before it migrates.
   */
  trail?: (copy: Database.Database) => { ok: boolean; reason?: string };
}

/**
 * What a database holds: its name, its schema, its newest audit entry, how many rows it holds outside `meta`, and a
 * SHA-256 of every row of every table, `meta` included but for the upgrade history (which the failed start writes after
 * this is taken). A failed upgrade records it as the start left the database, so the next start can tell whether
 * anything at all was written to the database since: a row added, removed or changed, or a setting, by a restore, by
 * the previous build serving it, or by hand. Reading every row takes a while on a large database; it is done only when
 * an upgrade has failed, by that start and by the next.
 */
export interface DatabaseState { databaseId: string | null; schema: string | null; seq: number | null; hash: string | null; rows: number; contents?: string }

/** One value as the hash reads it: its type, then its bytes, so no two different rows can read alike. */
function hashValue(hash: ReturnType<typeof createHash>, value: unknown) {
  if (value === null || value === undefined) { hash.update('n;'); return; }
  if (Buffer.isBuffer(value)) { hash.update(`b${value.length}:`); hash.update(value); hash.update(';'); return; }
  const text = String(value);
  hash.update(`${typeof value === 'number' || typeof value === 'bigint' ? 'i' : 's'}${Buffer.byteLength(text)}:`);
  hash.update(text);
  hash.update(';');
}

export function databaseState(db: Db): DatabaseState {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  let rows = 0;
  const contents = createHash('sha256');
  for (const table of tables) {
    hashValue(contents, table);
    const where = table === 'meta' ? " WHERE key <> 'upgrade_history'" : '';
    // In the order the table keeps its rows; a table without row ids, in the order of its columns.
    let read: Database.Statement;
    try { read = db.prepare(`SELECT * FROM "${table}"${where} ORDER BY rowid`); }
    catch {
      const count = (db.prepare(`SELECT COUNT(*) AS n FROM pragma_table_info(?)`).get(table) as { n: number }).n;
      read = db.prepare(`SELECT * FROM "${table}"${where} ORDER BY ${Array.from({ length: count }, (_, i) => i + 1).join(', ')}`);
    }
    let n = 0;
    for (const row of read.raw(true).iterate() as Iterable<unknown[]>) { n += 1; for (const value of row) hashValue(contents, value); contents.update('\n'); }
    hashValue(contents, n);
    if (table !== 'meta') rows += n;
  }
  let newest: { seq: number; entry_hash: string | null } | undefined;
  try { newest = hasTable(db, 'audit_log') ? db.prepare('SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as typeof newest : undefined; } catch { newest = undefined; }
  return { databaseId: metaRead(db, 'database_id'), schema: metaRead(db, 'schema_version'), seq: newest?.seq ?? null, hash: newest?.entry_hash ?? null, rows, contents: contents.digest('hex') };
}

/** Whether two states are of the same database holding the same rows. A state recorded without its contents never is. */
export const sameState = (a: DatabaseState, b: DatabaseState) =>
  Boolean(a.contents && b.contents) && a.contents === b.contents &&
  a.databaseId === b.databaseId && a.schema === b.schema && a.seq === b.seq && a.hash === b.hash && a.rows === b.rows;

/**
 * The copy names: the schemas, when, and a tag for the database they were taken of (from its path), so databases that
 * share a directory each prune only their own copies.
 */
const COPY_NAME = /^vantage-before-upgrade-(\d+)-to-(\d+)-(\d{8}T\d{9})-([0-9a-f]{8})\.db$/;
/** The tag in the names of one database's copies: the start of the SHA-256 of its full path. */
export const copyTagOf = (path: string) => createHash('sha256').update(resolve(path)).digest('hex').slice(0, 8);
const stampNow = () => new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18);
const metaRead = (db: Db, key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const hasTable = (db: Db, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const auditCount = (db: Db) => (hasTable(db, 'audit_log') ? (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n : null);
const mb = (bytes: number) => Math.max(1, Math.ceil(bytes / 1_048_576));

/** The copies starts kept before upgrades, in one directory, oldest first: all of them, or one database's (by its path). */
export function upgradeCopiesIn(dir: string, of?: string): string[] {
  if (!existsSync(dir)) return [];
  const tag = of ? copyTagOf(of) : null;
  return readdirSync(dir)
    .filter((f) => { const m = COPY_NAME.exec(f); return Boolean(m) && (!tag || m![4] === tag); })
    .sort((a, b) => COPY_NAME.exec(a)![3].localeCompare(COPY_NAME.exec(b)![3]) || a.localeCompare(b));
}

/**
 * The copy an earlier start took before an upgrade that then failed, when it is still there and still the file it took.
 * The caller passes it only when the database is as that failed start left it (databaseState): then a start keeps that
 * copy rather than taking another of the half-upgraded database, since only that copy is the database as the previous
 * build left it (ADR-0041).
 */
export function copyStillKept(copy: UpgradeCopy | null | undefined, dir: string): UpgradeCopy | null {
  if (!copy?.file || basename(copy.file) !== copy.file) return null;
  const file = join(dir, copy.file);
  try {
    if (!existsSync(file) || readChecksumFile(file) !== copy.sha256 || sha256File(file) !== copy.sha256) return null;
  } catch { return null; }
  return copy;
}

/**
 * Before a start upgrades a database from schema `from` to `to`, it checks the database and keeps a copy of it as it is
 * (ADR-0041): `quick_check` on the database, then a copy vacuumed into a private file in the copy directory
 * (copyDatabaseInto), which is checked in turn (sound, at schema `from`, holding every audit entry) and gets its
 * `.sha256`. Only the newest `keep` of these copies stay. Anything that goes wrong throws, before a single migration
 * runs: a database that fails the check is not migrated, and neither is one that cannot be copied.
 */
export function copyBeforeUpgrade(db: Db, path: string, from: number, to: number, options: UpgradeCopyOptions & { kept?: UpgradeCopy | null; protect?: readonly string[] } = {}): UpgradeCopy {
  const dir = resolve(options.dir || dirname(path));
  const keep = Math.max(1, Math.floor(options.keep ?? 3));
  const refuse = (why: string): never => {
    throw new Error(`Vantage keeps a copy of the database before it upgrades it from schema ${from} to ${to}, and ${why} Nothing was migrated; the database is still at schema ${from}.`);
  };
  const check = String(db.pragma('quick_check', { simple: true }));
  if (check !== 'ok') refuse(`the database fails SQLite's integrity check (${check.slice(0, 300)}), so it is neither copied nor upgraded. Restore the last good backup, then start again.`);
  // After a failed upgrade, the copy that start took is the one to keep: nothing is copied or pruned.
  const kept = copyStillKept(options.kept, dir);
  if (kept) return kept;
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const needed = (Number(db.pragma('page_count', { simple: true })) - Number(db.pragma('freelist_count', { simple: true }))) * pageSize;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (error) { refuse(`could not make ${dir} for it: ${(error as Error).message}.`); }
  let free: number | null = null;
  try { const fs = statfsSync(dir); free = Number(fs.bavail) * Number(fs.bsize); } catch { free = null; }
  if (free !== null && free < needed + (1 << 20)) refuse(`${dir} has ${mb(free)} MB free where the copy needs about ${mb(needed)} MB. Make room there, or set VANTAGE_UPGRADE_COPY_DIR to a directory with room, and start again.`);
  const dest = join(dir, `vantage-before-upgrade-${from}-to-${to}-${stampNow()}-${copyTagOf(path)}.db`);
  try { copyDatabaseInto(db, dest); } catch (error) { refuse(`could not write it to ${dest}: ${(error as Error).message}. Make room there, or set VANTAGE_UPGRADE_COPY_DIR to a directory with room, and start again.`); }
  let trail: UpgradeCopy['trail'];
  try {
    const copy = new Database(dest, { readonly: true, fileMustExist: true });
    try {
      const copied = String(copy.pragma('quick_check', { simple: true }));
      if (copied !== 'ok') throw new Error(`the copy fails SQLite's integrity check (${copied.slice(0, 300)})`);
      if (metaRead(copy, 'schema_version') !== String(from)) throw new Error(`the copy is not at schema ${from}`);
      if (auditCount(copy) !== auditCount(db)) throw new Error('the copy does not hold every audit entry');
      if (options.trail) {
        try { trail = options.trail(copy); } catch (error) { trail = { ok: false, reason: `Its audit trail could not be checked: ${(error as Error).message}.` }; }
      }
    } finally { copy.close(); }
  } catch (error) {
    rmSync(dest, { force: true });
    refuse(`the copy it made did not check out: ${(error as Error).message}.`);
  }
  const sha256 = sha256File(dest);
  writeChecksumFile(dest, sha256);
  // This database's copies only, never the one just made, and never one a failed start since the last upgrade that
  // completed named: one of those is the database as the previous build left it. The newest keep - 1 others stay.
  const protect = new Set(options.protect ?? []);
  const others = upgradeCopiesIn(dir, path).filter((f) => f !== basename(dest) && !protect.has(f));
  for (const old of others.slice(0, Math.max(0, others.length - (keep - 1)))) {
    for (const f of [join(dir, old), checksumFileOf(join(dir, old)), `${join(dir, old)}-journal`]) rmSync(f, { force: true });
  }
  // Said before a single migration runs. The upgrade still goes ahead: the trail was broken before it, and refusing would
  // stop every later upgrade too, since nothing mends an append-only chain.
  if (trail && !trail.ok) {
    console.warn(`Kept ${basename(dest)} before upgrading, but its audit trail fails its check, as the database's own does: ${trail.reason ?? 'it does not verify.'} A restore refuses a backup whose trail does not verify, so this copy cannot be put back with scripts/restore.ts. Keep the last backup whose trail verifies; see Upgrades in docs/operations.md.`);
  }
  return { file: basename(dest), bytes: statSync(dest).size, sha256, ...(trail ? { trail } : {}) };
}
