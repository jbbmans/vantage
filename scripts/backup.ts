import Database from 'better-sqlite3';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * A consistent copy of the database, taken on the server: `npm run backup -- /backups/vantage-2026-10-02.db`.
 * Uses SQLite's online backup, so it is safe while Vantage runs. The copy is readable by its owner only; encrypt it
 * and move it wherever the data's classification allows. On an accredited host this replaces the browser download
 * (VANTAGE_BROWSER_BACKUPS=false).
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
console.log(`Backed up ${source} to ${resolve(dest)} (${statSync(resolve(dest)).size} bytes).`);
