import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { recordBackup } from '../server/services/backupLog.ts';

/**
 * A consistent copy of the database, taken on the server: `npm run backup -- /backups/vantage-2026-10-02.db`.
 * Uses SQLite's online backup, so it is safe while Vantage runs. The copy is readable by its owner only; encrypt it
 * and move it wherever the data's classification allows. On an accredited host this replaces the browser download
 * (VANTAGE_BROWSER_BACKUPS=false). The database then records that a backup was taken, so the Vantage Administrator
 * console can show how fresh the last one is.
 */
const source = process.env.VANTAGE_DB || resolve(import.meta.dirname, '..', 'data', 'vantage.db');
const dest = process.argv[2];
if (!dest) {
  console.error('Usage: npm run backup -- <destination file>');
  process.exit(2);
}
mkdirSync(dirname(resolve(dest)), { recursive: true });
const db = new Database(source, { readonly: true, fileMustExist: true });
await db.backup(resolve(dest));
db.close();
chmodSync(resolve(dest), 0o600);
const bytes = statSync(resolve(dest)).size;
console.log(`Backed up ${source} to ${resolve(dest)} (${bytes} bytes).`);

// The copy is made whatever happens next. Recording it is a convenience, never a reason to fail the backup.
try {
  const live = new Database(source, { fileMustExist: true });
  live.pragma('busy_timeout = 5000');
  recordBackup(live, { method: 'server', bytes, by: null, file: basename(resolve(dest)) });
  live.close();
} catch (error) {
  console.warn(`The backup was taken, but the database could not record it for the console: ${(error as Error).message}`);
}
