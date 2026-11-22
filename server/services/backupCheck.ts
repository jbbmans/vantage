import Database from 'better-sqlite3';
import { closeSync, existsSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AppConfig } from '../config.ts';
import { SCHEMA_VERSION, copyFilePrivate } from '../db/index.ts';
import { readChecksumFile, sha256File } from '../db/copies.ts';
import { readChainKey } from '../lib/keys.ts';
import { verifyAuditChainOf } from './audit.ts';

/**
 * Whether a backup is sound (ADR-0041): one check for every copy Vantage takes and for any backup a person brings to
 * restore or rehearse. It reads the file and never writes it, nor anything beside it.
 *
 * - It is a SQLite database, one self-contained file: no write-ahead log beside it holds part of it.
 * - SQLite's full integrity check passes.
 * - It is a Vantage database at a schema this build knows.
 * - Its bytes match the `.sha256` beside it, when there is one: otherwise it changed after it was taken.
 * - Its audit trail verifies, when the caller gives the secret it is sealed under.
 *
 * Broken foreign keys are counted and reported; they are data to look at, not a damaged file.
 */

export type BackupFault =
  | 'missing' | 'not_sqlite' | 'unreadable' | 'not_self_contained' | 'corrupt' | 'not_vantage' | 'schema_newer'
  | 'checksum_mismatch' | 'checksum_unreadable' | 'sealed_elsewhere' | 'trail_broken';

/** Faults in the trail, not the file: a fresh copy has them only when the live database does too. */
export const TRAIL_FAULTS: ReadonlySet<BackupFault> = new Set(['sealed_elsewhere', 'trail_broken']);

export interface BackupCheck {
  ok: boolean;
  /** Each fault found, with a sentence on it, in the order checked. */
  faults: Array<{ fault: BackupFault; message: string }>;
  file: string;
  bytes: number | null;
  sha256: string | null;
  /** What the `.sha256` beside it says: it matches, it does not, there is none, or it cannot be read. */
  checksum: 'match' | 'mismatch' | 'none' | 'unreadable';
  /** The first lines of SQLite's integrity check: `ok` when sound. Null when the file could not be opened. */
  integrity: string | null;
  schema: number | null;
  databaseId: string | null;
  /** The audit entries it holds: how many, and the newest. */
  audit: { count: number; seq: number | null; at: string | null } | null;
  /** The audit trail, when the caller gave a secret: whether it verifies, over how many entries, and why not. */
  trail: { ok: boolean; count: number; reason?: string } | null;
  /** Rows whose foreign key names a row that is not there. */
  foreignKeyBreaks: number | null;
}

const HEADER = Buffer.from('SQLite format 3\0', 'latin1');

function readHeader(path: string): Buffer | null {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(100);
    const n = readSync(fd, buf, 0, 100, 0);
    return n === 100 ? buf : null;
  } finally { closeSync(fd); }
}

/**
 * Checks the backup at `path`. `config` brings the secret its trail is checked under; `requireTrail` makes a trail that
 * cannot be checked a fault. `ignoreChecksumFile` is for a copy just taken over an older one: the `.sha256` beside it is
 * still the older copy's until this one passes.
 */
export function checkBackup(path: string, options: { config?: Pick<AppConfig, 'secret' | 'previousSecrets'> | null; requireTrail?: boolean; ignoreChecksumFile?: boolean } = {}): BackupCheck {
  const result: BackupCheck = {
    ok: false, faults: [], file: basename(path), bytes: null, sha256: null, checksum: 'none', integrity: null, schema: null,
    databaseId: null, audit: null, trail: null, foreignKeyBreaks: null,
  };
  const fault = (f: BackupFault, message: string) => { result.faults.push({ fault: f, message }); };
  const done = () => { result.ok = result.faults.length === 0; return result; };
  // A file this account cannot read, or a sidecar that is not a file, is a fault the check names, never a crash: the
  // drill records it like any other failure (ADR-0041).
  let recorded: string | null;
  try {
    if (!existsSync(path) || !statSync(path).isFile()) { fault('missing', `There is no backup at ${path}.`); return done(); }
    result.bytes = statSync(path).size;
    result.sha256 = sha256File(path);
  } catch (error) {
    fault('unreadable', `${basename(path)} cannot be read here: ${(error as Error).message}.`);
    return done();
  }
  if (options.ignoreChecksumFile) recorded = null;
  else { try { recorded = readChecksumFile(path); } catch { recorded = 'unreadable'; } }
  if (recorded === 'unreadable' || recorded === 'other') {
    result.checksum = 'unreadable';
    fault('checksum_unreadable', `${basename(path)}.sha256 beside it ${recorded === 'other' ? 'names another file' : 'is not a SHA-256 line'}, so the copy cannot be matched to the one taken.`);
  } else if (recorded) {
    result.checksum = recorded === result.sha256 ? 'match' : 'mismatch';
    if (result.checksum === 'mismatch') fault('checksum_mismatch', `Its bytes no longer match ${basename(path)}.sha256 beside it (${recorded.slice(0, 12)} when it was taken, ${result.sha256.slice(0, 12)} now): it changed after it was taken.`);
  }
  let header: Buffer | null;
  try { header = readHeader(path); } catch (error) { fault('unreadable', `${basename(path)} cannot be read here: ${(error as Error).message}.`); return done(); }
  if (!header || !header.subarray(0, 16).equals(HEADER)) { fault('not_sqlite', `${basename(path)} is not a SQLite database${result.bytes === 0 ? ': it is empty' : ''}.`); return done(); }
  const beside = ['-wal', '-journal', '-shm'].filter((suffix) => existsSync(`${path}${suffix}`));
  for (const suffix of beside.filter((x) => x !== '-shm' && statSync(`${path}${x}`).size > 0)) {
    fault('not_self_contained', `A ${suffix.slice(1)} file beside it (${basename(path)}${suffix}) holds part of it: a backup is one file. Take it again with node scripts/backup.ts.`);
  }
  // Opened where it lies, a copy left in write-ahead-log mode grows a log and a shared-memory file beside it, and SQLite
  // would act on a log or journal already there. Such a copy is read through a private copy of the file alone.
  const walMode = header[18] === 2 || header[19] === 2;
  const privately = walMode || beside.length > 0;
  let scratch: string | null = null;
  let source = path;
  let db: Database.Database | null = null;
  // SQLite says a damaged file is malformed, or not a database, as it opens it: that is a corrupt backup, not an unreadable one.
  const damaged = (error: unknown) => /^SQLITE_(CORRUPT|NOTADB)/.test(String((error as { code?: string }).code ?? ''));
  try {
    if (privately) {
      try {
        scratch = mkdtempSync(join(tmpdir(), 'vantage-check-'));
        source = join(scratch, 'copy.db');
        copyFilePrivate(path, source);
      } catch (error) {
        fault('unreadable', `It could not be copied aside to be read: ${(error as Error).message}.`);
        return done();
      }
    }
    try {
      db = new Database(source, { readonly: !privately, fileMustExist: true });
      if (walMode) db.pragma('journal_mode = DELETE');
    } catch (error) {
      if (damaged(error)) fault('corrupt', `It fails SQLite's integrity check: ${(error as Error).message}.`);
      else fault('unreadable', `SQLite cannot open it: ${(error as Error).message}.`);
      return done();
    }
    try {
      const lines = (db.pragma('integrity_check(20)') as Array<{ integrity_check: string }>).map((r) => r.integrity_check);
      result.integrity = lines.join('; ').slice(0, 1000);
      if (result.integrity !== 'ok') fault('corrupt', `It fails SQLite's integrity check: ${result.integrity.slice(0, 300)}.`);
    } catch (error) {
      result.integrity = (error as Error).message;
      fault('corrupt', `It fails SQLite's integrity check: ${(error as Error).message}.`);
    }
    const table = (name: string) => { try { return Boolean(db!.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)); } catch { return false; } };
    if (!table('meta') || !table('users') || !table('audit_log')) {
      // A file SQLite cannot read through has no tables to find: it is corrupt, and saying it is not Vantage's would mislead.
      if (!result.faults.some((f) => f.fault === 'corrupt')) fault('not_vantage', 'It is not a Vantage database: it has no meta, users or audit_log table.');
      return done();
    }
    try {
      const meta = (key: string) => (db!.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
      const schema = meta('schema_version');
      result.schema = schema && /^\d+$/.test(schema) ? Number(schema) : null;
      result.databaseId = meta('database_id');
      if (!result.schema) fault('not_vantage', 'It records no schema: it is not a Vantage 5 database.');
      else if (result.schema > SCHEMA_VERSION) fault('schema_newer', `It is at schema ${result.schema}, newer than this build's ${SCHEMA_VERSION}. Check and restore it with the build that took it.`);
      const newest = db.prepare('SELECT seq, at FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; at: string } | undefined;
      result.audit = { count: (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, seq: newest?.seq ?? null, at: newest?.at ?? null };
      result.foreignKeyBreaks = (db.pragma('foreign_key_check') as unknown[]).length;
    } catch (error) {
      if (!result.faults.some((f) => f.fault === 'corrupt')) fault('corrupt', `It cannot be read through: ${(error as Error).message}.`);
      return done();
    }
    // Entries with neither a chain key nor a head to check them against: whatever they say, nothing shows they were not
    // changed. Case seals do not help, since they are sealed with the chain key that is missing.
    const unchained = Boolean(result.audit?.count) && (() => {
      try { return !db!.prepare("SELECT 1 FROM meta WHERE key IN ('chain_key', 'audit_head')").get(); } catch { return false; }
    })();
    if (options.config && unchained) {
      result.trail = { ok: false, count: 0, reason: 'no chain key or audit head' };
      fault('trail_broken', `Its audit trail does not verify: it holds ${result.audit!.count} entries but no chain key or head to check them against.`);
    } else if (options.config) {
      let opened: ReturnType<typeof readChainKey>;
      try { opened = readChainKey(db, options.config); } catch { opened = { key: null, reason: 'sealed_elsewhere' }; }
      if (opened.key === null && opened.reason === 'sealed_elsewhere') {
        fault('sealed_elsewhere', 'Its audit trail is sealed under another secret: neither VANTAGE_SECRET nor VANTAGE_SECRET_PREVIOUS opens it.');
      } else if (opened.key !== null) {
        const chain = verifyAuditChainOf(db, opened.key);
        result.trail = { ok: chain.ok, count: chain.count, ...(chain.ok ? {} : { reason: chain.reason }) };
        if (!chain.ok) fault('trail_broken', `Its audit trail does not verify (${chain.reason}): it was changed after it was written, or it is damaged.`);
      } else if (result.audit?.count) {
        // Entries with no chain key or head to check them against: whatever they say, nothing shows they were not changed.
        result.trail = { ok: false, count: 0, reason: 'no chain key or audit head' };
        fault('trail_broken', `Its audit trail does not verify: it holds ${result.audit.count} entries but no chain key or head to check them against.`);
      } else result.trail = { ok: true, count: 0 };
    } else if (options.requireTrail) fault('sealed_elsewhere', 'Its audit trail was not checked: VANTAGE_SECRET is not set here.');
    return done();
  } finally {
    try { db?.close(); } catch { /* already closed */ }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** The faults that make the file itself unusable, leaving out the trail's. */
export const fileFaults = (check: BackupCheck) => check.faults.filter((f) => !TRAIL_FAULTS.has(f.fault));

/** The check in one line for a log or a terminal: what it holds when sound, every fault when not. */
export function describeCheck(check: BackupCheck): string {
  if (!check.ok) return check.faults.map((f) => f.message).join(' ');
  const parts = [
    `schema ${check.schema}`,
    `${check.audit?.count ?? 0} audit entries${check.audit?.seq ? `, the newest ${check.audit.seq}` : ''}`,
    check.trail ? `the trail verifies over ${check.trail.count}` : 'the trail not checked here',
    check.checksum === 'match' ? 'its .sha256 matches' : null,
    check.foreignKeyBreaks ? `${check.foreignKeyBreaks} rows name a row that is not there` : null,
  ].filter(Boolean);
  return `Sound: SQLite's integrity check passes; ${parts.join('; ')}. SHA-256 ${check.sha256}.`;
}
