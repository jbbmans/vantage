import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs, { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { SCHEMA_VERSION } from '../../server/db/index.ts';
import { sha256File, writeChecksumFile } from '../../server/db/copies.ts';
import { checkBackup } from '../../server/services/backupCheck.ts';
import { backupHistory } from '../../server/services/backupLog.ts';
import { drillHistory, markDrillsAudited, recordDrill } from '../../server/services/drillLog.ts';
import { auditDrills, auditServerBackups } from '../../server/services/recovery.ts';
import { FIXTURE_DIR, damagePages, freshDatabase } from './fixtureDatabases.ts';
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
const readDb = <T>(file: string, read: (db: Database.Database) => T): T => { const d = new Database(file, { readonly: true, fileMustExist: true }); try { return read(d); } finally { d.close(); } };

/** A Vantage staff member in this role, granted by the owner. */
async function staffMember(app: TestApp, ownerToken: string, username: string, role: string) {
  const person = await app.register(username);
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(person.id);
  const granted = await app.call('POST', '/api/platform/staff', { token: ownerToken, body: { user_id: person.id, role } });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(person.id);
  return { id: person.id, token: (await app.login(username)).body.token as string };
}

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

    // A download carries its SHA-256 as its Content-Digest, and the record and the trail keep it. Its check runs on a
    // thread of its own, and the service's thread keeps turning while the copy is read.
    let answered = false;
    const turned: boolean[] = [];
    const onWorker = () => { setImmediate(() => turned.push(!answered)); };
    process.on('worker', onWorker);
    let download;
    try { download = await app.call('GET', '/api/platform/backup', { token: owner.token, binary: true }); answered = true; } finally { process.off('worker', onWorker); }
    assert.deepEqual(turned, [true], 'one check thread, and a turn of the event loop before the copy was answered');
    assert.equal(download.status, 200);
    const digest = createHash('sha256').update(download.buffer!).digest();
    assert.equal(download.headers.get('content-digest'), `sha-256=:${digest.toString('base64')}:`);
    const browser = backupHistory(app.ctx.db).at(-1)!;
    assert.equal(browser.method, 'browser');
    assert.equal(browser.sha256, digest.toString('hex'));
    assert.equal(browser.verified, true);
    assert.match(entries(app, 'backup').at(-1)!.detail, new RegExp(`checked, SHA-256 ${digest.toString('hex')}`));

    // A download asked for in part is sent whole, so its Content-Digest is always the SHA-256 of what arrives.
    const ranged = await app.call('GET', '/api/platform/backup', { token: owner.token, binary: true, headers: { range: 'bytes=0-99' } });
    assert.equal(ranged.status, 200);
    assert.ok(ranged.buffer!.length > 100);
    assert.equal(ranged.headers.get('content-digest'), `sha-256=:${createHash('sha256').update(ranged.buffer!).digest('base64')}:`);
    // A conditional request gets the new copy too, never a 304 carrying a digest of a copy it did not receive.
    const conditional = await app.call('GET', '/api/platform/backup', { token: owner.token, binary: true, headers: { 'if-none-match': '*', 'if-modified-since': new Date(Date.now() + 86_400_000).toUTCString() } });
    assert.equal(conditional.status, 200);
    assert.equal(conditional.headers.get('content-digest'), `sha-256=:${createHash('sha256').update(conditional.buffer!).digest('base64')}:`);
    assert.match(download.headers.get('cache-control') ?? '', /no-store/, 'no cache on the way keeps a copy of the database');
    assert.equal(download.headers.get('etag'), null);
    // A copy that cannot be read out to the browser is answered, with none of the file's headers.
    const streams = fs.createReadStream;
    fs.createReadStream = ((file: Parameters<typeof streams>[0], options?: Parameters<typeof streams>[1]) => {
      const stream = streams(file, options);
      if (String(file).includes('vantage-backup-')) process.nextTick(() => stream.destroy(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })));
      return stream;
    }) as typeof streams;
    let unsent;
    try { unsent = await app.call('GET', '/api/platform/backup', { token: owner.token }); } finally { fs.createReadStream = streams; }
    assert.equal(unsent.status, 500);
    assert.equal(unsent.body.code, 'backup_send_failed');
    for (const header of ['content-digest', 'content-disposition', 'etag', 'last-modified']) assert.equal(unsent.headers.get(header), null, header);
    assert.match(unsent.headers.get('content-type') ?? '', /^application\/json/);

    // Taken again over the same file, the copy gets its own SHA-256. A run that fails keeps the copy that was there
    // with its own, so it is still told apart from anything else.
    const again = run(['scripts/backup.ts', dest], envFor(path));
    assert.equal(again.status, 0, again.stderr);
    assert.equal(readFileSync(`${dest}.sha256`, 'utf8'), `${sha256File(dest)}  copy.db\n`);
    const kept = readFileSync(`${dest}.sha256`, 'utf8');
    const nowhere = run(['scripts/backup.ts', dest], envFor(join(dir, 'not-here.db')));
    assert.notEqual(nowhere.status, 0);
    assert.equal(readFileSync(`${dest}.sha256`, 'utf8'), kept);
    assert.equal(run(['scripts/backup.ts', '--verify', dest], envFor(path)).status, 0);
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
    // The service keeps writing while the drill runs, at a person's pace: a few entries a second, well inside the
    // per-account write limit however long the drill takes on a slow host.
    let writing = true;
    let written = 0;
    const writer = (async () => {
      while (writing && written < 100) {
        const r = await app.call('POST', '/api/records/activities', { token: owner.token, body: { title: `Entry ${written}`, visibility: 'private' } });
        assert.equal(r.status, 201);
        written += 1;
        await new Promise((done) => setTimeout(done, 25));
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

test('the check names a sidecar it cannot read, a damaged copy in log mode as corrupt, and entries with nothing to check them against', async () => {
  const { dir, path, app } = await liveService();
  try {
    const good = join(dir, 'good.db');
    assert.equal(run(['scripts/backup.ts', good], envFor(path)).status, 0);
    const config = { secret: SECRET, previousSecrets: [] };

    // A .sha256 that cannot be read is a fault the check names, and the drill records it like any other.
    const odd = join(dir, 'odd.db');
    copyFileSync(good, odd);
    mkdirSync(`${odd}.sha256`);
    const unreadable = checkBackup(odd, { config });
    assert.equal(unreadable.checksum, 'unreadable');
    assert.deepEqual(unreadable.faults.map((f) => f.fault), ['checksum_unreadable']);
    const drill = run(['scripts/restore.ts', 'DRILL', '--from', odd], envFor(path));
    assert.equal(drill.status, 1, drill.stdout);
    assert.match(drill.stderr, /odd\.db\.sha256 beside it is not a SHA-256 line/);
    assert.match(drillHistory(app.ctx.db).at(-1)!.failure!, /is not a SHA-256 line/);
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('.vantage-drill-')));

    // A damaged copy left in write-ahead-log mode is read through a private copy, and named corrupt.
    const wal = join(dir, 'wal.db');
    copyFileSync(good, wal);
    damagePages(wal);
    const fd = openSync(wal, 'r+');
    try { writeSync(fd, Buffer.from([2, 2]), 0, 2, 18); } finally { closeSync(fd); }
    const before = filesIn(dir);
    const corrupt = checkBackup(wal, { config });
    assert.ok(corrupt.faults.some((f) => f.fault === 'corrupt'), JSON.stringify(corrupt.faults));
    assert.ok(!corrupt.faults.some((f) => f.fault === 'unreadable' || f.fault === 'not_vantage'), JSON.stringify(corrupt.faults));
    assert.deepEqual(filesIn(dir), before, 'nothing is written beside it');

    // Audit entries with no chain key or head to check them against do not verify.
    const bare = join(dir, 'bare.db');
    copyFileSync(good, bare);
    const d = new Database(bare);
    try { d.prepare("DELETE FROM meta WHERE key IN ('chain_key', 'audit_head')").run(); } finally { d.close(); }
    const unchained = checkBackup(bare, { config });
    assert.equal(unchained.ok, false);
    assert.deepEqual(unchained.trail, { ok: false, count: 0, reason: 'no chain key or audit head' });
    assert.match(unchained.faults.find((f) => f.fault === 'trail_broken')!.message, /holds \d+ entries but no chain key or head to check them against/);
    // Taken from such a database, the copy is kept, the fault is said, and the record says the trail is broken.
    const taken = run(['scripts/backup.ts', join(dir, 'from-bare.db')], envFor(bare));
    assert.equal(taken.status, 0, taken.stderr);
    assert.match(taken.stderr, /no chain key or head to check them against\. The copy holds what the live database holds/);
    assert.doesNotMatch(taken.stdout, /the audit trail verifies/);
    assert.equal(readDb(bare, (b) => backupHistory(b).at(-1)!.trail), 'broken');
    // Case seals are sealed with the chain key that is missing, so they change nothing.
    const sealed = new Database(bare);
    try {
      sealed.pragma('foreign_keys = OFF');
      sealed.prepare("INSERT INTO work_event_heads (work_item_id, hash, count, mac, updated_at) VALUES ('case-1', 'aa', 1, 'bb', '2026-11-22T00:00:00.000Z')").run();
    } finally { sealed.close(); }
    const withSeals = checkBackup(bare, { config });
    assert.deepEqual(withSeals.trail, { ok: false, count: 0, reason: 'no chain key or audit head' });
    assert.deepEqual(withSeals.faults.map((f) => f.fault), ['trail_broken']);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a dry run refused for who authorized it is audited but tells no one the backup failed, and only staff who hold backups see who ran a drill', async () => {
  const { dir, path, app, owner } = await liveService();
  try {
    const nightly = join(dir, 'nightly.db');
    assert.equal(run(['scripts/backup.ts', nightly], envFor(path)).status, 0);
    const refused = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', nightly, '--by', 'nobody', '--reason', 'Rehearsing under the wrong name', '--dry-run'], envFor(path, { VANTAGE_RESTORE: '1' }));
    assert.equal(refused.status, 1, refused.stdout);
    assert.match(refused.stderr, /nobody is not an active Lead Vantage Administrator of this service/);
    // A backup whose .sha256 names another file fails for the backup itself.
    const other = join(dir, 'other.db');
    copyFileSync(nightly, other);
    copyFileSync(`${nightly}.sha256`, `${other}.sha256`);
    const failed = run(['scripts/restore.ts', 'DRILL', '--from', other], envFor(path));
    assert.equal(failed.status, 1, failed.stdout);
    assert.match(failed.stderr, /names another file/);
    assert.deepEqual(drillHistory(app.ctx.db).map((r) => [r.kind, r.ok, r.refused ?? null]), [['dry_run', false, 'authorization'], ['drill', false, null]]);

    assert.equal(auditDrills(app.ctx), 2);
    const [refusal, failure] = entries(app, 'restore_drill');
    assert.match(refusal.detail, /^A dry run of a restore of nightly\.db \(SHA-256 [0-9a-f]{64}\) was refused at .*, before the backup was rehearsed: nobody is not/);
    assert.match(failure.detail, /^A restore drill of other\.db .* failed at /);
    const told = app.ctx.db.prepare("SELECT title FROM notifications WHERE title LIKE 'A restore drill of %'").all() as Array<{ title: string }>;
    assert.ok(told.length > 0, 'a drill that failed is told');
    assert.ok(told.every((n) => n.title === 'A restore drill of other.db failed'), JSON.stringify(told));

    const dry = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', nightly, '--by', 'boletz', '--reason', 'Rehearsing before the host move', '--dry-run'], envFor(path, { VANTAGE_RESTORE: '1' }));
    assert.equal(dry.status, 0, dry.stderr);
    const full = await app.call('GET', '/api/platform/operations', { token: owner.token });
    assert.equal(full.status, 200);
    assert.ok(full.body.backups.drills.some((d: { by: string | null; hostUser: string | null }) => d.by === 'boletz' && d.hostUser));
    const support = await staffMember(app, owner.token, 'drillsupport', 'support');
    const seen = await app.call('GET', '/api/platform/operations', { token: support.token });
    assert.equal(seen.status, 200);
    assert.equal(seen.body.backups.drills.length, 3);
    assert.ok(seen.body.backups.drills.every((d: { by: string | null; hostUser: string | null }) => d.by === null && d.hostUser === null), 'support staff see that drills ran, not who ran them');
    const shown = seen.body.backups.drills.find((d: { refused?: string }) => d.refused === 'authorization');
    assert.equal(shown.failure, 'The person named as authorizing it is not an active Lead Vantage Administrator.', 'nor the name a refused dry run gave');
    assert.match(full.body.backups.drills.find((d: { refused?: string }) => d.refused === 'authorization').failure, /^nobody is not/);

    // A drill of a backup that is not there fails, and is recorded and told like any other.
    const missing = run(['scripts/restore.ts', 'DRILL', '--from', join(dir, 'nigthly.db')], envFor(path));
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(missing.stderr, /There is no backup at .*nigthly\.db/);
    assert.equal(drillHistory(app.ctx.db).at(-1)!.backup.file, 'nigthly.db');

    // Staff who do not hold the backups see where it was looked for by its file name, not the host's directories.
    const missed = (body: { backups: { drills: Array<{ backup: { file: string }; failure: string | null }> } }) => body.backups.drills.find((d) => d.backup.file === 'nigthly.db')!.failure;
    assert.equal(missed((await app.call('GET', '/api/platform/operations', { token: support.token })).body), 'The backup cannot be restored. There is no backup at nigthly.db.');
    assert.equal(missed((await app.call('GET', '/api/platform/operations', { token: owner.token })).body), `The backup cannot be restored. There is no backup at ${join(dir, 'nigthly.db')}.`);

    // A drill that stops on an error it did not expect (here a trigger planted in a copy of the backup refuses the
    // step that signs everyone out) is recorded as stopped, leaves no scratch copy, and is told with no word against
    // the backup.
    const planted = join(dir, 'planted.db');
    copyFileSync(nightly, planted);
    const plant = new Database(planted);
    try {
      assert.ok((plant.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n > 0);
      plant.exec("CREATE TRIGGER stop_the_drill BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'planted to stop the drill'); END");
    } finally { plant.close(); }
    const halted = run(['scripts/restore.ts', 'DRILL', '--from', planted], envFor(path));
    assert.equal(halted.status, 1, halted.stdout);
    assert.match(halted.stderr, /^The drill stopped: planted to stop the drill\nNothing was replaced\./m);
    const last = drillHistory(app.ctx.db).at(-1)!;
    assert.deepEqual([last.backup.file, last.ok, last.stopped ?? false, last.failure], ['planted.db', false, true, 'The drill stopped: planted to stop the drill']);
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('.vantage-drill-')), 'no scratch copy is left');
    assert.equal(auditDrills(app.ctx), 3);
    assert.match(entries(app, 'restore_drill').at(-1)!.detail, /^A restore drill of planted\.db \(SHA-256 [0-9a-f]{64}\) stopped at .* before it finished: The drill stopped: planted to stop the drill$/);
    const notices = app.ctx.db.prepare("SELECT title, message FROM notifications WHERE title LIKE 'A restore drill of %'").all() as Array<{ title: string; message: string }>;
    assert.ok(notices.some((n) => n.title === 'A restore drill of nigthly.db failed'));
    const stopped = notices.find((n) => n.title === 'A restore drill of planted.db stopped')!;
    assert.match(stopped.message, /says nothing yet about the backup/);
    assert.doesNotMatch(stopped.message, /Take a new backup/);
  } finally { await app.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the drill history keeps every drill the service has not audited yet, and the last twenty it has', () => {
  const db = freshDatabase();
  try {
    const drill = {
      kind: 'drill' as const, ok: true, failure: null, upgraded: null, trail: 1, sameDatabase: true, wouldUndo: null, by: null, hostUser: null, version: 'test', ms: 1,
      backup: { file: 'nightly.db', bytes: 1, sha256: null, schema: SCHEMA_VERSION, seq: 1, at: null, recorded: true },
    };
    for (let i = 0; i < 25; i += 1) recordDrill(db, drill);
    assert.equal(drillHistory(db).length, 25, 'none is dropped before it is in the audit trail');
    markDrillsAudited(db, new Set(drillHistory(db).map((r) => r.id)));
    const newest = recordDrill(db, drill);
    const kept = drillHistory(db);
    assert.equal(kept.filter((r) => r.audited).length, 20);
    assert.equal(kept.length, 21);
    assert.equal(kept.at(-1)!.id, newest.id);
  } finally { db.close(); }
});

test('a drill and a dry run work against a database from before organizations, its owner named as that build named them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-verified-'));
  try {
    const live = join(dir, 'vantage.db');
    copyFileSync(join(FIXTURE_DIR, 'v5.0.0.db'), live);
    const nightly = join(dir, 'nightly.db');
    const taken = run(['scripts/backup.ts', nightly], envFor(live));
    assert.equal(taken.status, 0, taken.stderr);
    const drill = run(['scripts/restore.ts', 'DRILL', '--from', nightly], envFor(live));
    assert.equal(drill.status, 0, drill.stderr);
    assert.match(drill.stdout, /Would undo: {3}0 audit entries after the backup/);
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('.vantage-drill-')), 'no scratch copy is left');
    const dry = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', nightly, '--by', 'boletz', '--reason', 'Rehearsing before the upgrade', '--dry-run'], envFor(live, { VANTAGE_RESTORE: '1' }));
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /Authorized by boletz: Rehearsing before the upgrade/);
    assert.deepEqual(readDb(live, (d) => drillHistory(d).map((r) => [r.kind, r.ok, r.sameDatabase])), [['drill', true, true], ['dry_run', true, true]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the backup script says a live database newer than this build is for the build that runs it, with no disk to blame', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-verified-'));
  try {
    const live = join(dir, 'vantage.db');
    copyFileSync(join(FIXTURE_DIR, 'main-caebfab.db'), live);
    const d = new Database(live);
    try { d.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1)); } finally { d.close(); }
    const dest = join(dir, 'nightly.db');
    const taken = run(['scripts/backup.ts', dest], envFor(live));
    assert.equal(taken.status, 1, taken.stdout);
    assert.match(taken.stderr, new RegExp(`The live database is at schema ${SCHEMA_VERSION + 1}, newer than this build's ${SCHEMA_VERSION}: take the backup with the build that runs it\\.`));
    assert.doesNotMatch(taken.stderr, /on its way|Check that disk/);
    assert.ok(!existsSync(dest) && !existsSync(`${dest}.sha256`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a restore over a database whose accounts cannot be read is authorized by the backup, and keeps what it replaced with its SHA-256', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-verified-'));
  try {
    const live = join(dir, 'vantage.db');
    copyFileSync(join(FIXTURE_DIR, 'main-caebfab.db'), live);
    const good = join(dir, 'good.db');
    assert.equal(run(['scripts/backup.ts', good], envFor(live)).status, 0);
    // A change to someone's authority after the backup, which a restore undoes and lists by whom it was about.
    const later = new Database(live);
    try {
      const columns = (later.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>).map((c) => c.name);
      const pick = columns.map((c) => (c === 'seq' ? 'seq + 1' : c === 'id' ? 'lower(hex(randomblob(16)))' : c === 'action' ? "'grant_role'" : c === 'subject_id' ? "(SELECT id FROM users WHERE username = 'boletz')" : c));
      later.prepare(`INSERT INTO audit_log (${columns.join(', ')}) SELECT ${pick.join(', ')} FROM audit_log ORDER BY seq DESC LIMIT 1`).run();
    } finally { later.close(); }
    // The accounts table's first page no longer says what kind of page it is: SQLite opens the file and cannot read the accounts.
    const { root, size } = readDb(live, (d) => ({ root: (d.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'users'").get() as { rootpage: number }).rootpage, size: Number(d.pragma('page_size', { simple: true })) }));
    const fd = openSync(live, 'r+');
    try { writeSync(fd, Buffer.from([0]), 0, 1, (root - 1) * size); } finally { closeSync(fd); }
    const env = envFor(live, { VANTAGE_RESTORE: '1' });
    const reason = ['--reason', 'Going back past a damaged accounts table'];

    const stranger = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', good, '--by', 'nobody', ...reason], env);
    assert.equal(stranger.status, 1, stranger.stdout);
    assert.match(stranger.stderr, /nobody is not an active Lead Vantage Administrator in the backup/);
    assert.ok(!readdirSync(dir).some((f) => f.startsWith('vantage-before-restore-')));

    const ran = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', good, '--by', 'boletz', ...reason], env);
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /The accounts in .* cannot be read \(.*\), so the backup's Lead Vantage Administrators authorize this\./);
    assert.match(ran.stdout, /Authorized by boletz: Going back past a damaged accounts table/);
    assert.match(ran.stdout, /Undoes: {3}1 audit entries after the backup, in 1 Unit Instances; 1 of them change accounts, authority or holds/);
    const safety = readdirSync(dir).find((f) => /^vantage-before-restore-.*\.db$/.test(f))!;
    assert.equal(readFileSync(join(dir, `${safety}.sha256`), 'utf8'), `${sha256File(join(dir, safety))}  ${safety}\n`);
    assert.equal(readDb(live, (d) => (d.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'boletz'").get() as { n: number }).n), 1, 'the accounts read again');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a drill goes on when what a restore would undo cannot be read from the live trail, and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-verified-'));
  try {
    const live = join(dir, 'vantage.db');
    copyFileSync(join(FIXTURE_DIR, 'main-caebfab.db'), live);
    const good = join(dir, 'good.db');
    assert.equal(run(['scripts/backup.ts', good], envFor(live)).status, 0);
    // Enough entries after the backup to fill many pages of the trail, then one of those pages damaged: the newest entry
    // still reads, the entries between the backup and it do not.
    const later = new Database(live);
    try {
      const columns = (later.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>).map((c) => c.name);
      const pick = columns.map((c) => (c === 'seq' ? 'seq + 1' : c === 'id' ? 'lower(hex(randomblob(16)))' : c === 'detail' ? 'hex(randomblob(300))' : c));
      const add = later.prepare(`INSERT INTO audit_log (${columns.join(', ')}) SELECT ${pick.join(', ')} FROM audit_log ORDER BY seq DESC LIMIT 1`);
      later.transaction(() => { for (let i = 0; i < 400; i += 1) add.run(); })();
      later.pragma('wal_checkpoint(TRUNCATE)');
    } finally { later.close(); }
    const { page, size } = readDb(live, (d) => {
      const leaves = (d.prepare("SELECT pageno FROM dbstat WHERE name = 'audit_log' AND pagetype = 'leaf' ORDER BY path").all() as Array<{ pageno: number }>).map((r) => r.pageno);
      return { page: leaves.at(-2)!, size: Number(d.pragma('page_size', { simple: true })) };
    });
    // The page no longer says what kind of page it is, so SQLite stops on it rather than read past it.
    const fd = openSync(live, 'r+');
    try { writeSync(fd, Buffer.from([0]), 0, 1, (page - 1) * size); } finally { closeSync(fd); }

    const drill = run(['scripts/restore.ts', 'DRILL', '--from', good], envFor(live));
    assert.equal(drill.status, 0, drill.stderr);
    assert.match(drill.stdout, /What a restore would undo could not be read from .*vantage\.db \(.*malformed.*\)\./);
    assert.doesNotMatch(drill.stdout, /Would undo:/);
    assert.match(drill.stdout, /Drill passed: nothing was replaced\./);
    assert.equal(readDb(live, (d) => drillHistory(d).at(-1)!.ok), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a stop while a restore copies the database it replaces, byte by byte, removes the copy and replaces nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-verified-'));
  try {
    const live = join(dir, 'vantage.db');
    copyFileSync(join(FIXTURE_DIR, 'main-caebfab.db'), live);
    const good = join(dir, 'good.db');
    assert.equal(run(['scripts/backup.ts', good], envFor(live)).status, 0);
    const before = sha256File(live);
    // SQLite's online copy fails, so the restore copies the files as they are, synchronously; Ctrl-C comes meanwhile.
    const plant = join(dir, 'plant.mjs');
    writeFileSync(plant, `import { createRequire } from 'node:module';
const Database = createRequire(${JSON.stringify(join(process.cwd(), 'package.json'))})('better-sqlite3');
Database.prototype.backup = function () { process.kill(process.pid, 'SIGINT'); return Promise.reject(new Error('the online copy failed')); };
`);
    const env = envFor(live, { VANTAGE_RESTORE: '1', NODE_OPTIONS: `--import=${pathToFileURL(plant).href}` });
    const ran = run(['scripts/restore.ts', 'REPLACE-DATABASE', '--from', good, '--by', 'boletz', '--reason', 'Stopped while the safety copy is drawn'], env);
    assert.equal(ran.status, 1, ran.stdout);
    assert.match(ran.stderr, /The restore was interrupted \(SIGINT\) while the database it replaces was being copied\.\nNothing was replaced\./);
    assert.equal(sha256File(live), before, 'the live database is as it was');
    assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith('vantage-before-restore-') || f.startsWith('.vantage-restore-')), [], 'nothing drawn is left');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a SHA-256 file is written in place of a link planted at its name, never through it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-verified-'));
  try {
    const copy = join(dir, 'copy.db');
    writeFileSync(copy, 'a copy');
    const victim = join(dir, 'service-owned.conf');
    writeFileSync(victim, 'keep me\n');
    symlinkSync(victim, `${copy}.sha256`);
    writeChecksumFile(copy, 'a'.repeat(64));
    assert.equal(readFileSync(victim, 'utf8'), 'keep me\n', 'the file the link named is untouched');
    assert.ok(lstatSync(`${copy}.sha256`).isFile(), 'the link was replaced by the SHA-256 file');
    assert.equal(readFileSync(`${copy}.sha256`, 'utf8'), `${'a'.repeat(64)}  copy.db\n`);
    assert.equal((statSync(`${copy}.sha256`).mode & 0o777).toString(8), '600');
    assert.deepEqual(readdirSync(dir).sort(), ['copy.db', 'copy.db.sha256', 'service-owned.conf'], 'no temporary file is left');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
