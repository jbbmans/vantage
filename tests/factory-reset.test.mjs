import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

const root = mkdtempSync(join(tmpdir(), 'vantage-reset-test-'));
const database = join(root, 'vantage.db');
const backupDir = join(root, 'backups');

const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
  process.env.VANTAGE_DB = ${JSON.stringify(database)};
  const { getDb, bootstrapAdmin } = await import('./server/db.js');
  getDb();
  bootstrapAdmin({
    username: 'reset-test', password: 'correct-horse-battery-staple-927',
    first_name: 'Reset', last_name: 'Test', unit_code: 'MFR',
  });
  getDb().close();
`], { cwd: process.cwd(), encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);

const refused = spawnSync(process.execPath, [
  'scripts/factory-reset.mjs', '--confirm', 'WIPE ALL LIVE DATA', '--backup-dir', backupDir,
], {
  cwd: process.cwd(), encoding: 'utf8',
  env: { ...process.env, VANTAGE_DB: database },
});
assert.notEqual(refused.status, 0, 'reset must require the environment gate');
let check = new Database(database, { readonly: true });
assert.equal(check.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
check.close();

const reset = spawnSync(process.execPath, [
  'scripts/factory-reset.mjs', '--confirm', 'WIPE ALL LIVE DATA', '--backup-dir', backupDir,
], {
  cwd: process.cwd(), encoding: 'utf8',
  env: { ...process.env, VANTAGE_DB: database, VANTAGE_FACTORY_RESET: '1' },
});
assert.equal(reset.status, 0, `${reset.stdout}\n${reset.stderr}`);
assert.match(reset.stdout, /Factory reset complete and verified/);

check = new Database(database, { readonly: true });
assert.equal(check.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0);
assert.deepEqual(check.prepare('SELECT code, name, short_name FROM units').all(), [{
  code: 'MFR', name: 'Marine Forces Reserve', short_name: 'MARFORRES',
}]);
assert.deepEqual(
  check.prepare('SELECT name FROM roles ORDER BY position').all().map((row) => row.name),
  ['Marine', 'NCO', 'Fire Team Leader', 'SNCO', 'SNCOIC', 'Unit Leader'],
);
assert.deepEqual(check.pragma('foreign_key_check'), []);
check.close();
assert.equal(existsSync(`${database}.maintenance`), true);

const backups = readdirSync(backupDir);
assert.equal(backups.length, 1);
const backupPath = join(backupDir, backups[0]);
assert.equal(existsSync(backupPath), true);
const old = new Database(backupPath, { readonly: true });
assert.equal(old.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
old.close();

const refusedOpen = spawnSync(process.execPath, [
  'scripts/maintenance-off.mjs', '--confirm', 'OPEN VANTAGE',
], {
  cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, VANTAGE_DB: database },
});
assert.notEqual(refusedOpen.status, 0, 'reopening must require the environment gate');
assert.equal(existsSync(`${database}.maintenance`), true);

const reopened = spawnSync(process.execPath, [
  'scripts/maintenance-off.mjs', '--confirm', 'OPEN VANTAGE',
], {
  cwd: process.cwd(), encoding: 'utf8',
  env: { ...process.env, VANTAGE_DB: database, VANTAGE_MAINTENANCE: '1' },
});
assert.equal(reopened.status, 0, `${reopened.stdout}\n${reopened.stderr}`);
assert.equal(existsSync(`${database}.maintenance`), false);

rmSync(root, { recursive: true, force: true });
console.log('  PASS  guarded factory reset creates a verified backup and rebuilds only MFR + six roles');
