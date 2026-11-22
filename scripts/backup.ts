import Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { backupHistory, recordBackup } from '../server/services/backupLog.ts';
import { checkBackup, describeCheck, fileFaults, TRAIL_FAULTS } from '../server/services/backupCheck.ts';
import { SCHEMA_VERSION, backupDatabase } from '../server/db/index.ts';
import { checksumFileOf, writeChecksumFile } from '../server/db/copies.ts';

/**
 * A consistent copy of the database, taken on the server: `node scripts/backup.ts /backups/vantage-2026-10-02.db`.
 * Uses SQLite's online backup, so it is safe while Vantage runs. The copy is readable by its owner only; encrypt it
 * and move it wherever the data's classification allows. On an accredited host this replaces the browser download
 * (VANTAGE_BROWSER_BACKUPS=false). The database then records that a backup was taken, so the Vantage Administrator
 * console can show how fresh the last one is, and the service puts it in the audit trail.
 *
 * Every copy is checked before it counts (ADR-0041): SQLite's full integrity check, one self-contained file, a Vantage
 * schema this build knows, and the audit trail when VANTAGE_SECRET is set here. A copy that fails is removed and the
 * script exits 1, saying whether the live database passes the same check. A sound copy gets its SHA-256 beside it, as
 * `<file>.sha256` in the form `sha256sum -c` reads, and in the record.
 *
 * `node scripts/backup.ts --verify <backup.db>` runs the same check on any backup, writes nothing, and says whether this
 * database recorded it. It exits 0 when the backup is sound and 1 when it is not.
 */
const USAGE = `Usage:
  node scripts/backup.ts <destination file>     take a backup, check it and record it
  node scripts/backup.ts --verify <backup.db>   check a backup; nothing is written`;

const source = process.env.VANTAGE_DB || resolve(import.meta.dirname, '..', 'data', 'vantage.db');
const args = process.argv.slice(2);
// The trail is checked under the service's secret when it is set here. The script never needs it to take a backup.
const secret = process.env.VANTAGE_SECRET || '';
const secrets = secret
  ? { secret, previousSecrets: (process.env.VANTAGE_SECRET_PREVIOUS || '').split(',').map((s) => s.trim()).filter((s) => s && s !== secret) }
  : null;
const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

if (args[0] === '--verify') {
  if (!args[1] || args.length > 2) { console.error(USAGE); process.exit(2); }
  const file = resolve(args[1]);
  const check = checkBackup(file, { config: secrets });
  console.log(`${file}\n${describeCheck(check)}`);
  if (check.ok && !secrets) console.log('Set VANTAGE_SECRET to the service\'s secret to check its audit trail too.');
  if (check.sha256 && existsSync(source) && resolve(source) !== file) {
    try {
      const live = new Database(source, { readonly: true, fileMustExist: true });
      try {
        const record = backupHistory(live).find((r) => r.sha256 === check.sha256);
        console.log(record
          ? `This database recorded it: a ${record.method === 'server' ? 'server' : 'console'} backup taken ${when(record.at)}${record.seq ? `, through audit entry ${record.seq}` : ''}.`
          : 'This database has no record of a backup with this SHA-256: it was taken from another database, before the last twenty backups, or before backups kept one, or it changed after it was taken.');
      } finally { live.close(); }
    } catch { /* a database that cannot be read here says nothing about the backup */ }
  }
  process.exit(check.ok ? 0 : 1);
}

if (!args[0] || args[0].startsWith('--') || args.length > 1) { console.error(USAGE); process.exit(2); }
const dest = resolve(args[0]);
if (dest === resolve(source)) { console.error('That is the live database itself.'); process.exit(2); }
// A directory made for the copies is the service account's alone; one that exists keeps its own permissions.
mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
// A copy taken over an older one is a new copy: the older one's SHA-256 goes with it.
rmSync(checksumFileOf(dest), { force: true });
const db = new Database(source, { readonly: true, fileMustExist: true });
await backupDatabase(db, dest);
db.close();
// The copy is one self-contained file, with no write-ahead log beside it to lose in the move (ADR-0014).
try {
  const copy = new Database(dest, { fileMustExist: true });
  copy.pragma('journal_mode = DELETE');
  copy.close();
} catch { /* the check below says what is wrong with it */ }

const check = checkBackup(dest, { config: secrets });
const broken = fileFaults(check);
if (broken.length) {
  // Whether the live database passes the same check tells a fault on the way to the copy from one in the database.
  const liveFails = (why: string) => `The live database fails SQLite's integrity check too (${why.slice(0, 300)}). Rehearse the last good backup with node scripts/restore.ts DRILL --from <backup.db>, then restore it.`;
  let live: string;
  // A schema this build does not know is the live database's own, not damage on the way: no disk is to blame.
  if (broken.every((f) => f.fault === 'schema_newer' || f.fault === 'not_vantage')) {
    live = check.schema && check.schema > SCHEMA_VERSION
      ? `The live database is at schema ${check.schema}, newer than this build's ${SCHEMA_VERSION}: take the backup with the build that runs it.`
      : `The live database is not one this build can back up: ${broken.map((f) => f.message).join(' ')}`;
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${dest}${suffix}`, { force: true });
    console.error(`The backup failed its check and was removed. ${live}`);
    process.exit(1);
  }
  try {
    const l = new Database(source, { readonly: true, fileMustExist: true });
    try {
      const result = (l.pragma('integrity_check(5)') as Array<{ integrity_check: string }>).map((r) => r.integrity_check).join('; ');
      live = result === 'ok'
        ? `The live database passes SQLite's integrity check, so the copy was damaged on its way to ${dirname(dest)}. Check that disk, then take the backup again.`
        : liveFails(result);
    } finally { l.close(); }
  } catch (error) {
    // SQLite stops a check it cannot read through, and says the file is malformed: that is a failed check too.
    live = /^SQLITE_(CORRUPT|NOTADB)/.test(String((error as { code?: string }).code ?? '')) ? liveFails((error as Error).message) : `The live database could not be checked: ${(error as Error).message}.`;
  }
  for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(`${dest}${suffix}`, { force: true });
  console.error(`The backup failed its check and was removed. ${broken.map((f) => f.message).join(' ')}\n${live}`);
  process.exit(1);
}
writeChecksumFile(dest, check.sha256!);
const seq = check.audit?.seq ?? null;
console.log(`Backed up ${source} to ${dest} (${check.bytes} bytes${seq ? `, through audit entry ${seq}` : ''}).`);
console.log(`Checked: SQLite's integrity check passes, schema ${check.schema}${check.trail ? `, the audit trail verifies over ${check.trail.count} entries` : ''}${check.foreignKeyBreaks ? `; ${check.foreignKeyBreaks} rows name a row that is not there, as in the live database` : ''}.`);
console.log(`SHA-256 ${check.sha256}, kept beside it as ${basename(checksumFileOf(dest))}.`);
const trailFaults = check.faults.filter((f) => TRAIL_FAULTS.has(f.fault));
// A fresh copy's trail is the live database's: the copy is kept, and the fault is the live database's to answer.
if (trailFaults.length) console.warn(`${trailFaults.map((f) => f.message).join(' ')} The copy holds what the live database holds; see Audit integrity in the console.`);
else if (!secrets) console.log('The audit trail was not checked here: VANTAGE_SECRET is not set. The drill checks it: node scripts/restore.ts DRILL --from <backup.db>.');

// The copy is made whatever happens next. Recording it is a convenience, never a reason to fail the backup. The running
// service writes it into the audit trail within five minutes (auditServerBackups): the script has no need of the secret
// the trail is sealed with.
try {
  const live = new Database(source, { fileMustExist: true });
  live.pragma('busy_timeout = 5000');
  recordBackup(live, {
    method: 'server', bytes: check.bytes, by: null, file: basename(dest), seq, audited: false, sha256: check.sha256, verified: true,
    trail: check.trail ? (check.trail.ok ? 'verified' : 'broken') : trailFaults.some((f) => f.fault === 'trail_broken') ? 'broken' : 'not_checked',
  });
  live.close();
} catch (error) {
  console.warn(`The backup was taken, but the database could not record it for the console: ${(error as Error).message}`);
}
