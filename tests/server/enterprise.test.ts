import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, SCHEMA_VERSION } from '../../server/db/index.ts';
import { startApp } from './helpers.ts';

test('liveness answers without the database; readiness checks the database and its schema', async () => {
  const app = await startApp();
  try {
    const live = await app.call('GET', '/api/health/live');
    assert.equal(live.status, 200);
    assert.equal(live.body.ok, true);
    const ready = await app.call('GET', '/api/health/ready');
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body.checks, { database: 'ok', schema: 'ok' });
    // A database a newer build migrated, or one a migration never reached, is not ready for this build.
    app.ctx.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION - 1));
    const behind = await app.call('GET', '/api/health/ready');
    assert.equal(behind.status, 503);
    assert.equal(behind.body.checks.schema, `at ${SCHEMA_VERSION - 1}, expected ${SCHEMA_VERSION}`);
    app.ctx.db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
    assert.equal((await app.call('GET', '/api/health/ready')).status, 200);
  } finally { await app.close(); }
});

test('the backup command writes a checked, fingerprinted, owner-only copy and keeps the newest few', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-backup-'));
  try {
    const path = join(dir, 'vantage.db');
    const db = openDatabase(path);
    db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES ('u1', 'avery', 'x', 'Jordan', 'Avery', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    db.close();
    const out = join(dir, 'backups');
    mkdirSync(out);
    // Two older copies from earlier runs; with --keep 2 the oldest goes.
    for (const old of ['vantage-20200101-000000.db', 'vantage-20200102-000000.db']) { writeFileSync(join(out, old), 'old'); writeFileSync(join(out, `${old}.sha256`), 'x'); }
    writeFileSync(join(out, 'notes.txt'), 'not a backup, never touched');

    const env = { ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_SECRET: 'test-secret-test-secret-test-secret-1234', VANTAGE_DB: path, VANTAGE_EMAIL_PROVIDER: 'none' };
    const run = spawnSync(process.execPath, ['scripts/backup.ts', '--dir', out, '--keep', '2'], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
    assert.equal(result.ok, true);
    assert.equal(result.users, 1);
    assert.equal(Number(result.schema_version), SCHEMA_VERSION);
    assert.deepEqual(result.removed, ['vantage-20200101-000000.db']);

    const files = readdirSync(out).sort();
    assert.ok(files.includes('notes.txt'));
    assert.ok(!files.includes('vantage-20200101-000000.db') && !files.includes('vantage-20200101-000000.db.sha256'));
    assert.ok(files.includes('vantage-20200102-000000.db'));
    const copy = result.file as string;
    assert.ok(existsSync(copy));
    assert.equal(statSync(copy).mode & 0o777, 0o600, 'owner-only');
    const digest = createHash('sha256').update(readFileSync(copy)).digest('hex');
    assert.equal(readFileSync(`${copy}.sha256`, 'utf8'), `${digest}  ${copy.split('/').at(-1)}\n`);
    const opened = new Database(copy, { readonly: true });
    assert.equal(opened.pragma('integrity_check', { simple: true }), 'ok');
    assert.equal((opened.prepare('SELECT username FROM users').get() as { username: string }).username, 'avery');
    opened.close();
    const live = new Database(path, { readonly: true });
    assert.ok((live.prepare("SELECT value FROM meta WHERE key = 'last_backup_at'").get() as { value: string } | undefined)?.value, 'the owner console can show when the last backup ran');
    live.close();

    const refused = spawnSync(process.execPath, ['scripts/backup.ts', '--keep', '0'], { env, encoding: 'utf8' });
    assert.equal(refused.status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
