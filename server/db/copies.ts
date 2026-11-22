import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
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

/** Writes `<file>.sha256` beside a copy, owner-only like the copy: `<hex>  <file name>`. */
export function writeChecksumFile(file: string, sha256: string): string {
  const path = checksumFileOf(file);
  writeFileSync(path, `${sha256}  ${basename(file)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
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
export interface UpgradeCopy { file: string; bytes: number; sha256: string }

export interface UpgradeCopyOptions {
  /** Where the copies go: the database's own directory unless VANTAGE_UPGRADE_COPY_DIR says otherwise. */
  dir?: string | null;
  /** How many of these copies stay in that directory, newest first (VANTAGE_UPGRADE_COPIES_KEPT). */
  keep?: number;
}

const COPY_NAME = /^vantage-before-upgrade-(\d+)-to-(\d+)-(\d{8}T\d{9})\.db$/;
const stampNow = () => new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18);
const metaRead = (db: Db, key: string) => (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
const hasTable = (db: Db, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
const auditCount = (db: Db) => (hasTable(db, 'audit_log') ? (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n : null);
const mb = (bytes: number) => Math.max(1, Math.ceil(bytes / 1_048_576));

/** The copies a start kept before upgrades, in one directory, oldest first. */
export function upgradeCopiesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => COPY_NAME.test(f)).sort((a, b) => COPY_NAME.exec(a)![3].localeCompare(COPY_NAME.exec(b)![3]) || a.localeCompare(b));
}

/**
 * Before a start upgrades a database from schema `from` to `to`, it checks the database and keeps a copy of it as it is
 * (ADR-0041): `quick_check` on the database, then a copy vacuumed into a private file in the copy directory
 * (copyDatabaseInto), which is checked in turn (sound, at schema `from`, holding every audit entry) and gets its
 * `.sha256`. Only the newest `keep` of these copies stay. Anything that goes wrong throws, before a single migration
 * runs: a database that fails the check is not migrated, and neither is one that cannot be copied.
 */
export function copyBeforeUpgrade(db: Db, path: string, from: number, to: number, options: UpgradeCopyOptions = {}): UpgradeCopy {
  const dir = resolve(options.dir || dirname(path));
  const keep = Math.max(1, Math.floor(options.keep ?? 3));
  const refuse = (why: string): never => {
    throw new Error(`Vantage keeps a copy of the database before it upgrades it from schema ${from} to ${to}, and ${why} Nothing was migrated; the database is still at schema ${from}.`);
  };
  const check = String(db.pragma('quick_check', { simple: true }));
  if (check !== 'ok') refuse(`the database fails SQLite's integrity check (${check.slice(0, 300)}), so it is neither copied nor upgraded. Restore the last good backup, then start again.`);
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const needed = (Number(db.pragma('page_count', { simple: true })) - Number(db.pragma('freelist_count', { simple: true }))) * pageSize;
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (error) { refuse(`could not make ${dir} for it: ${(error as Error).message}.`); }
  let free: number | null = null;
  try { const fs = statfsSync(dir); free = Number(fs.bavail) * Number(fs.bsize); } catch { free = null; }
  if (free !== null && free < needed + (1 << 20)) refuse(`${dir} has ${mb(free)} MB free where the copy needs about ${mb(needed)} MB. Make room there, or set VANTAGE_UPGRADE_COPY_DIR to a directory with room, and start again.`);
  const dest = join(dir, `vantage-before-upgrade-${from}-to-${to}-${stampNow()}.db`);
  try { copyDatabaseInto(db, dest); } catch (error) { refuse(`could not write it to ${dest}: ${(error as Error).message}. Make room there, or set VANTAGE_UPGRADE_COPY_DIR to a directory with room, and start again.`); }
  try {
    const copy = new Database(dest, { readonly: true, fileMustExist: true });
    try {
      const copied = String(copy.pragma('quick_check', { simple: true }));
      if (copied !== 'ok') throw new Error(`the copy fails SQLite's integrity check (${copied.slice(0, 300)})`);
      if (metaRead(copy, 'schema_version') !== String(from)) throw new Error(`the copy is not at schema ${from}`);
      if (auditCount(copy) !== auditCount(db)) throw new Error('the copy does not hold every audit entry');
    } finally { copy.close(); }
  } catch (error) {
    rmSync(dest, { force: true });
    refuse(`the copy it made did not check out: ${(error as Error).message}.`);
  }
  const sha256 = sha256File(dest);
  writeChecksumFile(dest, sha256);
  const copies = upgradeCopiesIn(dir);
  for (const old of copies.slice(0, Math.max(0, copies.length - keep))) {
    for (const f of [join(dir, old), checksumFileOf(join(dir, old)), `${join(dir, old)}-journal`]) rmSync(f, { force: true });
  }
  return { file: basename(dest), bytes: statSync(dest).size, sha256 };
}
