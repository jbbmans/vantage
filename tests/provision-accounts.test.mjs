import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { verifyPassword } from '../server/auth.js';

const root = mkdtempSync(join(tmpdir(), 'vantage-provision-test-'));
const database = join(root, 'vantage.db');
const input = join(root, 'provision.json');

const seed = spawnSync(process.execPath, ['--input-type=module', '-e', `
  process.env.VANTAGE_DB = ${JSON.stringify(database)};
  const { getDb } = await import('./server/db.js');
  getDb().close();
`], { cwd: process.cwd(), encoding: 'utf8' });
assert.equal(seed.status, 0, seed.stderr);

writeFileSync(`${database}.maintenance`, 'factory-reset test\n', { mode: 0o600 });

writeFileSync(input, JSON.stringify({
  root_owner_username: 'leader.one',
  units: [{
    code: 'MFR-TEST', name: 'Test Fire Team', short_name: 'Test', echelon: 'fire_team',
    parent_code: 'MFR', owner_username: 'leader.one',
  }],
  accounts: [
    {
      first_name: 'Leader', last_name: 'One', username: 'leader.one', email: 'leader.one@example.mil',
      password: 'leader-random-passphrase-927', unit_code: 'MFR-TEST',
      billet_title: 'Fire Team Leader', role_key: 'fire-team-leader',
    },
    {
      first_name: 'Marine', last_name: 'Two', username: 'marine.two', email: 'marine.two@example.mil',
      password: 'marine-random-passphrase-481', unit_code: 'MFR-TEST',
      billet_title: 'Accounting Clerk', role_key: 'marine',
    },
  ],
}), { mode: 0o600 });
chmodSync(input, 0o600);

const run = spawnSync(process.execPath, [
  'scripts/provision-accounts.mjs', '--input', input, '--delete-input',
], {
  cwd: process.cwd(), encoding: 'utf8',
  env: { ...process.env, VANTAGE_DB: database, VANTAGE_PROVISION: '1' },
});
assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
assert.doesNotMatch(run.stdout, /leader-random|marine-random/);
assert.equal(existsSync(input), false);
assert.equal(existsSync(`${database}.maintenance`), false);

const db = new Database(database, { readonly: true });
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 2);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM users WHERE must_change_password = 1').get().count, 2);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM units').get().count, 2);
assert.equal(db.prepare('SELECT COUNT(*) AS count FROM roles').get().count, 12);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billets WHERE title = 'Accounting Clerk'").get().count, 1);
const leader = db.prepare("SELECT * FROM users WHERE username = 'leader.one'").get();
assert.equal(verifyPassword('leader-random-passphrase-927', leader.password_hash), true);
assert.equal(db.prepare("SELECT owner_user_id FROM units WHERE id = 'MFR'").get().owner_user_id, leader.id);
assert.equal(db.prepare("SELECT owner_user_id FROM units WHERE id = 'MFR-TEST'").get().owner_user_id, leader.id);
assert.deepEqual(db.pragma('foreign_key_check'), []);
db.close();

rmSync(root, { recursive: true, force: true });
console.log('  PASS  private one-time provisioning creates units, accounts, ownership and forced password changes');
