/**
 * Destructive, deployment-level Vantage factory reset.
 *
 * This command is intentionally unavailable from the web application. It
 * requires shell access, a one-invocation environment gate, and the exact
 * confirmation phrase. A verified SQLite backup is completed before a single
 * live row is removed.
 *
 *   VANTAGE_FACTORY_RESET=1 npm run reset:factory -- \
 *     --confirm "WIPE ALL LIVE DATA"
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  chmodSync, createReadStream, existsSync, lstatSync, mkdirSync, realpathSync, statfsSync, statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { config, resolveStoragePath } from '../server/config.js';

const CONFIRMATION = 'WIPE ALL LIVE DATA';

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function refuse(message) {
  console.error(`Refusing factory reset: ${message}`);
  process.exit(1);
}

if (process.env.VANTAGE_FACTORY_RESET !== '1') {
  refuse('set VANTAGE_FACTORY_RESET=1 for this one invocation.');
}
if (valueAfter('--confirm') !== CONFIRMATION) {
  refuse(`pass --confirm "${CONFIRMATION}" exactly.`);
}

const requestedPath = resolveStoragePath(config.storage.database_path);
if (!isAbsolute(requestedPath) || requestedPath === resolve('/') || !existsSync(requestedPath)) {
  refuse('VANTAGE_DB must resolve to an existing database file.');
}
if (lstatSync(requestedPath).isSymbolicLink() || !lstatSync(requestedPath).isFile()) {
  refuse('the database path must be a regular file, not a directory or symbolic link.');
}
const databasePath = realpathSync(requestedPath);
const databaseBytes = statSync(databasePath).size;
if (databaseBytes < 4096) refuse('the database file is too small to be a Vantage database.');

const backupRootArg = valueAfter('--backup-dir');
const backupRoot = backupRootArg
  ? (isAbsolute(backupRootArg) ? backupRootArg : resolve(process.cwd(), backupRootArg))
  : join(dirname(databasePath), 'backups');
mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
if (!lstatSync(backupRoot).isDirectory() || lstatSync(backupRoot).isSymbolicLink()) {
  refuse('the backup destination must be a real directory.');
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = join(realpathSync(backupRoot), `${basename(databasePath)}.pre-reset-${stamp}`);
const filesystem = statfsSync(realpathSync(backupRoot));
const availableBytes = filesystem.bavail * filesystem.bsize;
const requiredBytes = databaseBytes + Math.max(64 * 1024 * 1024, Math.ceil(databaseBytes * 0.1));
if (availableBytes < requiredBytes) {
  refuse(`the backup destination needs at least ${requiredBytes} free bytes before reset.`);
}

const maintenancePath = `${databasePath}.maintenance`;
if (existsSync(maintenancePath)) refuse('a maintenance lock already exists; inspect the prior maintenance attempt first.');
writeFileSync(maintenancePath, `factory-reset ${stamp}\n`, { flag: 'wx', mode: 0o600 });

const live = new Database(databasePath, { fileMustExist: true });
live.pragma('busy_timeout = 10000');

const requiredTables = ['meta', 'users', 'units', 'roles', 'audit_log'];
const tables = live.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((row) => row.name);
const missing = requiredTables.filter((name) => !tables.includes(name));
if (missing.length) {
  live.close();
  refuse(`the file is not a recognized Vantage database (missing ${missing.join(', ')}).`);
}

const schemaVersion = live.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
if (!schemaVersion || !/^\d+$/.test(schemaVersion)) {
  live.close();
  refuse('the database has no valid Vantage schema version.');
}

console.log(`Database: ${databasePath}`);
console.log(`Creating verified backup: ${backupPath}`);
await live.backup(backupPath);
chmodSync(backupPath, 0o600);

const backup = new Database(backupPath, { fileMustExist: true });
const integrity = backup.pragma('integrity_check');
const backupUserCount = backup.prepare('SELECT COUNT(*) AS count FROM users').get().count;
backup.pragma('wal_checkpoint(TRUNCATE)');
backup.close();
chmodSync(backupPath, 0o600);
if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') {
  live.close();
  refuse('backup integrity verification failed; live data was not changed.');
}

const digest = createHash('sha256');
const stream = createReadStream(backupPath);
stream.on('data', (chunk) => digest.update(chunk));
await finished(stream);
const backupSha256 = digest.digest('hex');

try {
  live.pragma('foreign_keys = OFF');
  live.exec('BEGIN EXCLUSIVE');
  for (const table of tables) {
    const identifier = `"${table.replaceAll('"', '""')}"`;
    live.exec(`DELETE FROM ${identifier}`);
  }
  live.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(schemaVersion);
  live.exec('COMMIT');
} catch (error) {
  try { live.exec('ROLLBACK'); } catch { /* transaction was not active */ }
  live.close();
  console.error(`Factory reset failed; verified backup remains at ${backupPath}`);
  throw error;
}
live.close();

// Re-run the normal schema/migration/seed path instead of maintaining a
// second copy of production seed logic in this script.
const { getDb } = await import('../server/db.js');
const rebuilt = getDb(databasePath);
const units = rebuilt.prepare(
  'SELECT code, name, short_name FROM units WHERE active = 1 ORDER BY code'
).all();
const roles = rebuilt.prepare(
  'SELECT name FROM roles WHERE unit_id = ? ORDER BY position'
).all('MFR').map((row) => row.name);
const users = rebuilt.prepare('SELECT COUNT(*) AS count FROM users').get().count;
const violations = rebuilt.pragma('foreign_key_check');
const integrityAfter = rebuilt.pragma('integrity_check');
rebuilt.close();

const expectedRoles = ['Marine', 'NCO', 'Fire Team Leader', 'SNCO', 'SNCOIC', 'Unit Leader'];
const valid = users === 0
  && units.length === 1
  && units[0].code === 'MFR'
  && units[0].name === 'Marine Forces Reserve'
  && units[0].short_name === 'MARFORRES'
  && JSON.stringify(roles) === JSON.stringify(expectedRoles)
  && violations.length === 0
  && integrityAfter.length === 1
  && integrityAfter[0].integrity_check === 'ok';

if (!valid) {
  console.error(`Post-reset verification failed. Restore from: ${backupPath}`);
  process.exit(2);
}

console.log(`Backup SHA-256: ${backupSha256}`);
console.log(`Backup contained ${backupUserCount} user account(s).`);
console.log('Factory reset complete and verified.');
console.log('Live state: 0 users, 1 unit (MFR), 6 approved default roles.');
console.log('Maintenance remains active. Provision accounts next, or run maintenance:off to reopen first-run setup.');
