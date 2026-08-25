/**
 * Release a completed factory reset for ordinary first-run setup.
 *
 * This command does not alter application data. It removes the deployment
 * maintenance lock only after proving that the database is the verified,
 * empty MFR baseline produced by factory-reset.mjs.
 *
 *   VANTAGE_MAINTENANCE=1 npm run maintenance:off -- \
 *     --confirm "OPEN VANTAGE"
 */

import Database from 'better-sqlite3';
import { existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { config, resolveStoragePath } from '../server/config.js';

const CONFIRMATION = 'OPEN VANTAGE';
const EXPECTED_ROLES = ['Marine', 'NCO', 'Fire Team Leader', 'SNCO', 'SNCOIC', 'Unit Leader'];

function valueAfter(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] || null;
}

function refuse(message) {
  console.error(`Refusing to release maintenance: ${message}`);
  process.exit(1);
}

if (process.env.VANTAGE_MAINTENANCE !== '1') {
  refuse('set VANTAGE_MAINTENANCE=1 for this one invocation.');
}
if (valueAfter('--confirm') !== CONFIRMATION) {
  refuse(`pass --confirm "${CONFIRMATION}" exactly.`);
}

const requestedPath = resolveStoragePath(config.storage.database_path);
if (!isAbsolute(requestedPath) || requestedPath === resolve('/') || !existsSync(requestedPath)) {
  refuse('VANTAGE_DB must resolve to an existing database file.');
}
const requestedStat = lstatSync(requestedPath);
if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) {
  refuse('the database path must be a regular file, not a symbolic link.');
}

const databasePath = realpathSync(requestedPath);
const maintenancePath = `${databasePath}.maintenance`;
if (!existsSync(maintenancePath)) refuse('no maintenance lock exists.');
const maintenanceStat = lstatSync(maintenancePath);
if (!maintenanceStat.isFile() || maintenanceStat.isSymbolicLink()) {
  refuse('the maintenance lock is not a regular file.');
}

const db = new Database(databasePath, { readonly: true, fileMustExist: true });
let valid = false;
try {
  const units = db.prepare(
    'SELECT code, name, short_name FROM units WHERE active = 1 ORDER BY code'
  ).all();
  const roles = db.prepare(
    'SELECT name FROM roles WHERE unit_id = ? ORDER BY position'
  ).all('MFR').map((row) => row.name);
  const users = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  const violations = db.pragma('foreign_key_check');
  const integrity = db.pragma('integrity_check');
  valid = users === 0
    && JSON.stringify(units) === JSON.stringify([{
      code: 'MFR', name: 'Marine Forces Reserve', short_name: 'MARFORRES',
    }])
    && JSON.stringify(roles) === JSON.stringify(EXPECTED_ROLES)
    && violations.length === 0
    && integrity.length === 1
    && integrity[0].integrity_check === 'ok';
} catch {
  valid = false;
} finally {
  db.close();
}

if (!valid) {
  refuse('the database is not the verified empty MFR baseline; leave maintenance active and inspect it.');
}

unlinkSync(maintenancePath);
console.log('Maintenance lock released. Restart Vantage and complete first-run setup.');
