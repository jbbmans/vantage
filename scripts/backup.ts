// A verified backup of the configured database, safe while the app runs.
//
//   node scripts/backup.ts [--dir <path>] [--keep <n>]
//
// It takes a consistent copy with SQLite's online backup API (the same one Owner console → Download
// backup uses), opens the copy and runs a full integrity check, writes a SHA-256 beside it in
// `sha256sum` format, records the time in the database so the owner console can show it, and keeps
// the newest <n> copies. A copy that fails its check is deleted and the command exits non-zero, so a
// scheduler (cron, a systemd timer, a Render cron job) reports the failure instead of keeping a bad file.
//
// Defaults: --dir is $VANTAGE_BACKUP_DIR, else a `backups` folder beside the database; --keep is
// $VANTAGE_BACKUP_KEEP, else 14. The directory is created owner-only (0700) and every file is 0600.
// A backup holds everything the database does; store it where the data's classification allows.
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { loadConfig } from '../server/config.ts';

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const fail = (message: string): never => { console.error(JSON.stringify({ ok: false, error: message })); process.exit(1); };

const { databasePath } = loadConfig();
if (databasePath === ':memory:') fail('The configured database is in memory; there is nothing on disk to back up.');
if (!existsSync(databasePath)) fail(`No database at ${databasePath}.`);

const dir = resolve(option('dir') || process.env.VANTAGE_BACKUP_DIR || join(dirname(databasePath), 'backups'));
const keep = Number(option('keep') || process.env.VANTAGE_BACKUP_KEEP || 14);
if (!Number.isInteger(keep) || keep < 1) fail('--keep must be a whole number of 1 or more.');
mkdirSync(dir, { recursive: true, mode: 0o700 });

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const dest = join(dir, `vantage-${stamp}.db`);
if (existsSync(dest)) fail(`${basename(dest)} already exists; wait a second and run again.`);

const source = new Database(databasePath, { fileMustExist: true });
source.pragma('busy_timeout = 5000');
try {
  await source.backup(dest);
} catch (error) {
  try { unlinkSync(dest); } catch { /* nothing was written */ }
  fail(`The backup could not be written: ${(error as Error).message}`);
}
chmodSync(dest, 0o600);

// A copy nobody has opened is a hope, not a backup.
const copy = new Database(dest, { readonly: true, fileMustExist: true });
const integrity = copy.pragma('integrity_check', { simple: true });
const schemaVersion = (copy.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value ?? null;
const users = (copy.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
copy.close();
if (integrity !== 'ok') {
  unlinkSync(dest);
  source.close();
  fail(`The copy failed its integrity check (${String(integrity)}) and was removed. The live database was not changed.`);
}

const sha256 = createHash('sha256').update(readFileSync(dest)).digest('hex');
writeFileSync(`${dest}.sha256`, `${sha256}  ${basename(dest)}\n`, { mode: 0o600 });
source.prepare("INSERT INTO meta (key, value) VALUES ('last_backup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
source.close();

const all = readdirSync(dir).filter((f) => /^vantage-\d{8}-\d{6}\.db$/.test(f)).sort().reverse();
const removed = all.slice(keep);
for (const f of removed) {
  unlinkSync(join(dir, f));
  if (existsSync(join(dir, `${f}.sha256`))) unlinkSync(join(dir, `${f}.sha256`));
}

console.log(JSON.stringify({ ok: true, file: dest, bytes: statSync(dest).size, sha256, schema_version: schemaVersion, users, kept: Math.min(all.length, keep), removed }));
