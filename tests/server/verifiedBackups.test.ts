import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SCHEMA_VERSION } from '../../server/db/index.ts';
import { sha256File } from '../../server/db/copies.ts';
import { checkBackup } from '../../server/services/backupCheck.ts';
import { backupHistory } from '../../server/services/backupLog.ts';
import { drillHistory } from '../../server/services/drillLog.ts';
import { auditDrills, auditServerBackups } from '../../server/services/recovery.ts';
import { FIXTURE_DIR, damagePages } from './fixtureDatabases.ts';
import { startApp, type TestApp } from './helpers.ts';

// Every backup is checked, and a restore can be rehearsed with the service running (ADR-0041)

const SECRET = 'test-secret-test-secret-test-secret-1234';
const envFor = (path: string, extra: Record<string, string | undefined> = {}) => {
  const env: Record<string, string | undefined> = { ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: path, VANTAGE_SECRET: SECRET, VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_MARADMIN_ENABLED: 'false', ...extra };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env as NodeJS.ProcessEnv;
};
const run = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, args, { env, encoding: 'utf8' });
const runAsync = promisify(execFile);
const entries = (app: TestApp, action: string) => app.ctx.db.prepare('SELECT detail FROM audit_log WHERE action = ? ORDER BY seq').all(action) as Array<{ detail: string }>;
const filesIn = (dir: string) => readdirSync(dir).sort();

async function liveService() {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-verified-'));
  const path = join(dir, 'vantage.db');
  const app = await startApp({ VANTAGE_DB: path });
  const owner = await app.setupOperator();
  const made = await app.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Reconciled the travel ledger', visibility: 'unit' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return { dir, path, app, owner };
}

test('a server backup is checked, keeps its SHA-256 beside it, and --verify knows it again', async () => {
  const { dir, path, app, owner } = await liveService();
  try {
    const dest = join(dir, 'backups', 'copy.db');
    const taken = run(['scripts/backup.ts', dest], envFor(path));
    assert.equal(taken.status, 0, taken.stderr);
    const sha = sha256File(dest);
    assert.match(taken.stdout, new RegExp(`Checked: SQLite's integrity check passes, schema ${SCHEMA_VERSION}, the audit trail verifies over \\d+ entries`));
    assert.match(taken.stdout, new RegExp(`SHA-256 ${sha}, kept beside it as copy\\.db\\.sha256`));
    // The form sha256sum reads, owner-only like the copy.
    assert.equal(readFileSync(`${dest}.sha256`, 'utf8'), `${sha}  copy.db\n`);
    assert.equal((statSync(`${dest}.sha256`).mode & 0o777).toString(8), '600');
    assert.equal(spawnSync('sha256sum', ['-c', 'copy.db.sha256'], { cwd: join(dir, 'backups'), encoding: 'utf8' }).status, 0);
    const record = backupHistory(app.ctx.db).at(-1)!;
    assert.equal(record.sha256, sha);
    assert.equal(record.verified, true);
    assert.equal(record.trail, 'verified');
    assert.equal(auditServerBackups(app.ctx), 1);
    assert.match(entries(app, 'backup').at(-1)!.detail, new RegExp(`as copy\\.db; checked, SHA-256 ${sha}$`));

    const verified = run(['scripts/backup.ts', '--verify', dest], envFor(path));
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /^Sound: SQLite's integrity check passes; schema \d+; \d+ audit entries, the newest \d+; the trail verifies over \d+; its \.sha256 matches\./m);
    assert.match(verified.stdout, /This database recorded it: a server backup taken /);

    // Without the secret the copy is still taken and checked; the trail is left to the drill.
    const plain = run(['scripts/backup.ts', join(dir, 'backups', 'plain.db')], envFor(path, { VANTAGE_SECRET: undefined }));
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /The audit trail was not checked here: VANTAGE_SECRET is not set/);
    assert.equal(backupHistory(app.ctx.db).at(-1)!.trail, 'not_checked');

    // A download carries its SHA-256 as its Content-Digest, and the record and the trail keep it.
    const download = await app.call('GET', '/api/platform/backup', { token: owner.token, binary: true });
    assert.equal(download.status, 200);
    const digest = createHash('sha256').update(download.buffer!).digest();
    assert.equal(download.headers.get('content-digest'), `sha-256=:${digest.toString('base64')}:`);
    const browser = backupHistory(app.ctx.db).at(-1)!;
    assert.equal(browser.method, 'browser');
    assert.equal(browser.sha256, digest.toString('hex'));
    assert.equal(browser.verified, true);
    assert.match(entries(app, 'backup').at(-1)!.detail, new RegExp(`checked, SHA-256 ${digest.toString('hex')}`));
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a damaged backup is reported as such, and the drill and the restore refuse it without writing it', async () => {
  const { dir, path, app } = await liveService();
  try {
    const good = join(dir, 'good.db');
    assert.equal(run(['scripts/backup.ts', good], envFor(path)).status, 0);
    const damaged: Record<string, { make: (file: string) => void; says: RegExp }> = {
      'damaged pages': { make: (f) => damagePages(f), says: /fails SQLite's integrity check/ },
      truncated: { make: (f) => truncateSync(f, Math.floor(statSync(f).size / 2)), says: /fails SQLite's integrity check|cannot be read through|SQLite cannot open it/ },
      'not a database': { make: (f) => writeFileSync(f, 'quarterly ledger export\n'.repeat(400)), says: /is not a SQLite database/ },
      'changed since it was taken': {
        // A byte of the header SQLite keeps unused: the database is sound, and is no longer the copy that was taken.
        make: (f) => { const fd = openSync(f, 'r+'); try { writeSync(fd, Buffer.from([0x5a]), 0, 1, 80); } finally { closeSync(fd); } },
        says: /no longer match .*\.sha256 beside it .*changed after it was taken/,
      },
      'a log beside it': { make: (f) => writeFileSync(`${f}-wal`, Buffer.alloc(4096, 1)), says: /holds part of it: a backup is one file/ },
    };
    const cases = Object.entries(damaged).map(([name, { make, says }], i) => {
      const file = join(dir, `damaged-${i}.db`);
      copyFileSync(good, file);
      copyFileSync(`${good}.sha256`, `${file}.sha256`);
      writeFileSync(`${file}.sha256`, readFileSync(`${good}.sha256`, 'utf8').replace('good.db', `damaged-${i}.db`));
      make(file);
      return { name, file, says, sha: sha256File(file) };
    });
    const before = filesIn(dir);
    for (const c of cases) {
      assert.equal(checkBackup(c.file, { config: { secret: SECRET, previousSecrets: [] } }).ok, false, c.name);
      const verify = run(['scripts/backup.ts', '--verify', c.file], envFor(path));
      assert.equal(verify.status, 1, `${c.name}: ${verify.stdout}`);
      assert.match(verify.stdout, c.says, c.name);
      const drill = run(['scripts/restore.ts', 'DRILL', '--from', c.file], envFor(path));
      assert.equal(drill.status, 1, `${c.name}: ${drill.stdout}`);
      assert.match(drill.stderr, /^The backup cannot be restored\./m, c.name);
      assert.match(drill.stderr, c.says, c.name);
      assert.match(drill.stderr, /Nothing was replaced\.$/m);
      assert.equal(sha256File(c.file), c.sha, `${c.name}: the backup is never written`);
    }
    assert.deepEqual(filesIn(dir), before, 'nothing is left beside the backups or the database');
    const drills = drillHistory(app.ctx.db);
    assert.equal(drills.length, cases.length);
    assert.ok(drills.every((d) => !d.ok && d.failure && d.kind === 'drill'));
    assert.equal(auditDrills(app.ctx), cases.length);
    assert.equal(entries(app, 'restore_drill').filter((e) => / failed at /.test(e.detail)).length, cases.length);

    // The restore itself refuses each, with the service stopped.
    await app.close();
    for (const c of cases) {
      const ran = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', c.file, '--by', 'boletz', '--reason', 'Testing a damaged backup is refused'], envFor(path, { VANTAGE_RESTORE: '1' }));
      assert.equal(ran.status, 1, `${c.name}: ${ran.stdout}`);
      assert.match(ran.stderr, c.says, c.name);
      assert.ok(!readdirSync(dir).some((f) => f.startsWith('vantage-before-restore-')), 'nothing was replaced, so nothing was kept');
    }
  } finally { await app.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

test('the backup script refuses a copy that fails its check, removes it, and says the live database fails too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-verified-'));
  try {
    const live = join(dir, 'vantage.db');
    copyFileSync(join(FIXTURE_DIR, 'main-caebfab.db'), live);
    damagePages(live);
    const recorded = (() => { const d = new Database(live, { readonly: true }); try { return (d.prepare("SELECT value FROM meta WHERE key = 'backup_history'").get() as { value: string } | undefined)?.value ?? null; } finally { d.close(); } })();
    const dest = join(dir, 'nightly.db');
    const taken = run(['scripts/backup.ts', dest], envFor(live));
    assert.equal(taken.status, 1, taken.stdout);
    assert.match(taken.stderr, /^The backup failed its check and was removed\. It fails SQLite's integrity check/m);
    assert.match(taken.stderr, /The live database fails SQLite's integrity check too/);
    assert.ok(!existsSync(dest) && !existsSync(`${dest}.sha256`), 'a copy that fails is not left to be mistaken for a backup');
    const after = (() => { const d = new Database(live, { readonly: true }); try { return (d.prepare("SELECT value FROM meta WHERE key = 'backup_history'").get() as { value: string } | undefined)?.value ?? null; } finally { d.close(); } })();
    assert.equal(after, recorded, 'and it is not recorded as one');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a restore drill passes beside the running service, replaces nothing, writes nothing to the backup, and is audited once', async () => {
  const { dir, path, app, owner } = await liveService();
  try {
    const backups = join(dir, 'backups');
    const dest = join(backups, 'nightly.db');
    assert.equal(run(['scripts/backup.ts', dest], envFor(path)).status, 0);
    const sha = sha256File(dest);
    const backupFiles = filesIn(backups);
    // The service keeps writing while the drill runs.
    let writing = true;
    let written = 0;
    const writer = (async () => {
      while (writing) {
        const r = await app.call('POST', '/api/records/activities', { token: owner.token, body: { title: `Entry ${written}`, visibility: 'private' } });
        assert.equal(r.status, 201);
        written += 1;
      }
    })();
    const drill = await runAsync(process.execPath, ['scripts/restore.ts', 'DRILL', '--from', dest], { env: envFor(path), encoding: 'utf8' }).finally(() => { writing = false; });
    await writer;
    assert.ok(written > 0, 'the service answered while the drill ran');
    assert.match(drill.stdout, /Would undo: {3}\d+ audit entries after the backup/);
    assert.match(drill.stdout, /Drill: {4}restored into a scratch copy beside .*, opened with this build \(.+\): SQLite's integrity check passes and the trail verifies over \d+ entries under VANTAGE_SECRET alone\. The copy was removed/);
    assert.match(drill.stdout, /Drill passed: nothing was replaced\./);
    assert.match(drill.stdout, /this database recorded taking it/);
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('.vantage-drill-')), 'no scratch copy is left');
    assert.equal(sha256File(dest), sha);
    assert.deepEqual(filesIn(backups), backupFiles, 'nothing is written beside the backup');
    const titles = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM activities WHERE title LIKE 'Entry %'").get() as { n: number };
    assert.equal(titles.n, written, 'the live database is the one the service kept writing');

    const [record] = drillHistory(app.ctx.db);
    assert.equal(record.ok, true, record.failure ?? '');
    assert.equal(record.kind, 'drill');
    assert.equal(record.backup.sha256, sha);
    assert.equal(record.backup.recorded, true);
    assert.equal(record.sameDatabase, true);
    assert.ok(record.wouldUndo!.entries > 0);
    assert.equal(record.upgraded, null);
    assert.ok(record.trail! > 0);
    assert.equal(auditDrills(app.ctx), 1);
    assert.equal(auditDrills(app.ctx), 0, 'a drill is audited once');
    const [entry] = entries(app, 'restore_drill');
    assert.match(entry.detail, new RegExp(`^A restore drill of nightly\\.db \\(SHA-256 ${sha}\\) passed at .*: restored into a scratch copy, opened and checked, the trail verifying over \\d+ entries; restoring it would undo \\d+ audit entries`));

    // The dry run of a restore is the same drill, and needs the service stopped no more than the drill does.
    const dry = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', dest, '--by', 'boletz', '--reason', 'Rehearsing before the host move', '--dry-run'], envFor(path, { VANTAGE_RESTORE: '1' }));
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Authorized by boletz: Rehearsing before the host move/);
    assert.match(dry.stdout, /Dry run: nothing was replaced\./);
    assert.equal(drillHistory(app.ctx.db).at(-1)!.kind, 'dry_run');
    assert.equal(drillHistory(app.ctx.db).at(-1)!.by, 'boletz');
    const recovery = await app.call('GET', '/api/platform/recovery', { token: owner.token });
    assert.equal(recovery.status, 200);
    assert.deepEqual(recovery.body.backups.drills.map((d: { kind: string; ok: boolean }) => [d.kind, d.ok]), [['dry_run', true], ['drill', true]]);

    // A real restore still waits for the service to stop, and keeps what it replaces with its SHA-256.
    const busy = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', dest, '--by', 'boletz', '--reason', 'Going back to last night'], envFor(path, { VANTAGE_RESTORE: '1' }));
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /Stop Vantage/);
    await app.close();
    const restored = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', dest, '--by', 'boletz', '--reason', 'Going back to last night'], envFor(path, { VANTAGE_RESTORE: '1' }));
    assert.equal(restored.status, 0, restored.stderr);
    const safety = readdirSync(dir).find((f) => /^vantage-before-restore-.*\.db$/.test(f))!;
    assert.equal(readFileSync(join(dir, `${safety}.sha256`), 'utf8'), `${sha256File(join(dir, safety))}  ${safety}\n`);
    const back = await startApp({ VANTAGE_DB: path });
    try { assert.equal(drillHistory(back.ctx.db).length, 2, 'the drills run on this host are kept through a restore, like its backups'); } finally { await back.close(); }
  } finally { await app.close().catch(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

test('a drill upgrades an older backup as the next start would, and a backup of another database still drills', async () => {
  const { dir, path, app } = await liveService();
  try {
    const old = join(dir, 'v5.0.0.db');
    copyFileSync(join(FIXTURE_DIR, 'v5.0.0.db'), old);
    const drill = run(['scripts/restore.ts', 'DRILL', '--from', old], envFor(path));
    assert.equal(drill.status, 0, drill.stderr);
    assert.match(drill.stdout, new RegExp(`upgraded from schema 14 to ${SCHEMA_VERSION}`));
    assert.match(drill.stdout, /another database/);
    const record = drillHistory(app.ctx.db).at(-1)!;
    assert.deepEqual(record.upgraded, { from: 14, to: SCHEMA_VERSION, status: 'verified' });
    assert.equal(record.sameDatabase, false);
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('.vantage-drill-') || f.startsWith('vantage-before-upgrade-')), 'the scratch copy is upgraded with no copy of its own, and removed');
    // The dry run of a restore refuses another database's backup, as the restore does.
    const dry = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', old, '--by', 'boletz', '--reason', 'Rehearsing an old backup', '--dry-run'], envFor(path, { VANTAGE_RESTORE: '1' }));
    assert.equal(dry.status, 1);
    assert.match(dry.stderr, /another Vantage database than the one here/);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});
