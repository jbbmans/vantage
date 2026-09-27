import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, PASSWORD } from './helpers.ts';

const ADMIN_PASSWORD = 'harbor-quartz-lantern-4471';
const ROSTER = [
  'Rank,First Name,Last Name,L2 Command,Fire Team,Username,Email,Temporary Password,Role',
  'SSgt,Avery,Stone,TESTCMD,Alpha Cell,avery.stone,avery.stone@example.mil,QuartzHarborLane4!,Fire Team Leader',
  'Cpl,Blake,Rivers,TESTCMD,Alpha Cell,blake.rivers,,CedarMeadowRun7#,Marine',
  'Cpl,Casey,Bad,TESTCMD,Alpha Cell,casey bad,,CedarMeadowRun7#,Marine',
].join('\n');

// Asynchronous on purpose: the server under test runs in this process and must keep serving while the script runs.
function run(_dir: string, db: string, args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['scripts/start-over.ts', ...args], {
      env: {
        ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: db, VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_MARADMIN_ENABLED: 'false',
        VANTAGE_SECRET: 'test-secret-test-secret-test-secret-1234', VANTAGE_PUBLIC_URL: 'http://localhost:5173', ...env,
      },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('starting over from the shell erases everything in place, then creates the owner and the roster while the server runs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-start-over-'));
  const db = join(dir, 'vantage.db');
  const roster = join(dir, 'roster.csv');
  writeFileSync(roster, ROSTER);
  const app = await startApp({ VANTAGE_DB: db });
  try {
    const op = await app.setupOperator();
    const old = await app.register('oldmarine');
    assert.equal((await app.call('POST', '/api/records/activities', { token: old.token, body: { title: 'Before the reset', date: '2026-09-01' } })).status, 201);

    const refused = await run(dir, db, ['ERASE-EVERYTHING', '--unit', 'Test Command'], { VANTAGE_ADMIN_PASSWORD: ADMIN_PASSWORD });
    assert.notEqual(refused.status, 0, 'the confirmation variable is required');
    const weak = await run(dir, db, ['ERASE-EVERYTHING', '--unit', 'Test Command'], { VANTAGE_START_OVER: '1', VANTAGE_ADMIN_PASSWORD: 'short' });
    assert.notEqual(weak.status, 0);
    assert.match(weak.stderr, /VANTAGE_ADMIN_PASSWORD/);
    assert.equal((await app.call('GET', '/api/me', { token: op.token })).status, 200, 'a refused run changes nothing');

    const done = await run(dir, db, ['ERASE-EVERYTHING', '--unit', 'Test Command', '--short', 'TESTCMD', '--roster', roster], { VANTAGE_START_OVER: '1', VANTAGE_ADMIN_PASSWORD: ADMIN_PASSWORD });
    assert.equal(done.status, 0, done.stderr);
    assert.match(done.stdout, /Backed up the current database/);
    assert.match(done.stdout, /Imported 2 accounts/);
    assert.match(done.stdout, /skipped row 4 \(casey bad\)/);
    assert.ok(readdirSync(dir).some((f) => f.startsWith('vantage-before-start-over-')), 'a backup is kept beside the database');

    assert.equal((await app.call('GET', '/api/me', { token: op.token })).status, 401, 'every earlier session is gone, without a restart');
    assert.equal((await app.login('boletz', PASSWORD)).status, 401);
    assert.equal((await app.login('oldmarine', PASSWORD)).status, 401);
    const admin = await app.login('vantage.admin', ADMIN_PASSWORD);
    assert.equal(admin.status, 200);
    const me = await app.call('GET', '/api/me', { token: admin.body.token });
    assert.equal(me.body.user.is_operator, 1);
    assert.deepEqual(me.body.ownedUnitIds, ['TESTCMD']);
    assert.deepEqual(me.body.views.map((v: { id: string; level: string }) => `${v.id}:${v.level}`), ['TESTCMD:full', 'ALPHA-CELL:full'], 'the whole command and its team, both led from the top');
    assert.equal((await app.call('GET', '/api/records/activities', { token: admin.body.token })).body.length, 0);

    const avery = await app.login('avery.stone', 'QuartzHarborLane4!');
    assert.equal(avery.status, 200);
    assert.equal(avery.body.mustChangePassword, true);
    const integrity = await app.call('GET', '/api/admin/integrity', { token: admin.body.token });
    assert.equal(integrity.status, 200);
    assert.equal(integrity.body.audit?.ok ?? integrity.body.ok, true, JSON.stringify(integrity.body).slice(0, 300));
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
