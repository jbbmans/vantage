import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { openDatabase } from '../../server/db/index.ts';
import { databaseRoom, databaseSize } from '../../server/db/size.ts';
import { startSchedulers } from '../../server/app.ts';
import { revokeTokens } from '../../server/auth/tokens.ts';
import { purgeDeleted } from '../../server/services/records.ts';
import { composeDigest } from '../../server/services/digest.ts';
import { databaseUpkeepTick, lastUpkeep, problemCount, reloadStatistics, runDatabaseUpkeep, upkeepDue, upkeepRunning } from '../../server/services/databaseUpkeep.ts';
import { upkeepWork } from '../../server/services/databaseUpkeepWorker.ts';
import { maintenanceState, runMaintenanceTask, startMaintenance } from '../../server/services/maintenance.ts';
import { audit } from '../../server/services/audit.ts';
import type { SessionUser } from '../../server/context.ts';
import { clearJobs, healthReport, jobStatus } from '../../server/services/operations.ts';

/**
 * The database tune-up (ADR-0042): the reads that scanned a table use the indexes added for them, one measure of the
 * database's size, the scheduled upkeep on a thread of its own, and deleted text overwritten where it lay.
 */

type Person = { token: string; id: string };
type Seen = { sql: string; args: unknown[] };
let app: TestApp;
let op: Person;
let marine: Person;

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  marine = await app.register('mercer');
  await enroll(app, op.token, 'G8', marine.id);
  marine.token = (await app.login('mercer')).body.token;
});
after(async () => { await app?.close(); });

/** Every statement run while `fn` runs, with the arguments it ran with. */
async function statements(db: Database.Database, fn: () => unknown): Promise<Seen[]> {
  const seen: Seen[] = [];
  const prepare = db.prepare;
  const runs = new Set<PropertyKey>(['all', 'get', 'run', 'iterate']);
  db.prepare = function (this: typeof db, sql: string) {
    const stmt = prepare.call(this, sql);
    return new Proxy(stmt, {
      get(target, key) {
        const value = Reflect.get(target, key, target) as unknown;
        if (typeof value !== 'function') return value;
        if (!runs.has(key)) return value.bind(target);
        return (...args: unknown[]) => { seen.push({ sql, args }); return value.apply(target, args); };
      },
    });
  } as typeof db.prepare;
  try { await fn(); } finally { db.prepare = prepare; }
  return seen;
}

const planOf = (db: Database.Database, s: Seen) => (db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.args) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
const ok = <T extends { status: number; body: unknown }>(res: T): T => { assert.ok(res.status < 300, JSON.stringify(res.body)); return res; };

/** A database file of its own, with the app on it. */
async function onDisk(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-tuneup-'));
  const path = join(dir, 'vantage.db');
  const disk = await startApp({ VANTAGE_DB: path, ...env });
  return { disk, path, dir, done: async () => { await disk.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const upkeepEntries = (db: Database.Database) => db.prepare("SELECT actor_id, category, entity, entity_id, detail, org_id, unit_id FROM audit_log WHERE action = 'database_upkeep' ORDER BY seq").all() as Array<Record<string, string | null>>;

// The reads that scanned a table

test('the reads that scanned a table use the index added for them, captured from the code that runs them', async () => {
  const db = app.ctx.db;
  const digestUser = { id: marine.id, email: 'mercer@example.mil', first_name: 'Mercer', last_name: 'Marine', prefs: '{}', digest_last_sent_at: null };
  const cases: Array<[string, () => unknown, RegExp, RegExp]> = [
    ['goals: the records list', async () => ok(await app.call('GET', '/api/records/goals', { token: marine.token })), /FROM goals t WHERE .*assignee_id = \?/s, /idx_goals_assignee \(assignee_id=\?\)/],
    ['goals: the timeline', async () => ok(await app.call('GET', '/api/record/timeline', { token: marine.token })), /FROM goals WHERE \(user_id = @me OR assignee_id = @me\)/, /idx_goals_assignee \(assignee_id=\?\)/],
    ['goals: the weekly digest', () => composeDigest(app.ctx, digestUser), /FROM goals WHERE \(user_id = \? OR assignee_id = \?\)/, /idx_goals_assignee \(assignee_id=\?\)/],
    ['work items: the work list', async () => ok(await app.call('GET', '/api/work/items', { token: marine.token })), /FROM work_items w/, /idx_work_items_owner \(owner_id=\?\)/],
    ['contacts: the contact list', async () => ok(await app.call('GET', '/api/correspondence/contacts', { token: marine.token })), /FROM contacts c/, /idx_contacts_owner \(owner_id=\?\)/],
    ['tokens: revoking a kind of link', () => revokeTokens(app.ctx, 'reset', marine.id), /UPDATE tokens SET/, /idx_tokens_user \(user_id=\? AND kind=\?\)/],
    ['support tickets: the open Vantage queue', async () => ok(await app.call('GET', '/api/platform/overview', { token: op.token })), /FROM support_tickets WHERE/, /idx_support_unit \(unit_id=\?\)/],
  ];
  for (const [label, run, which, index] of cases) {
    const reads = (await statements(db, run)).filter((s) => which.test(s.sql));
    assert.ok(reads.length > 0, `${label}: the read ran`);
    for (const s of reads) {
      const plan = planOf(db, s);
      assert.match(plan, index, `${label}\n${s.sql}\n${plan}`);
      assert.doesNotMatch(plan, /(^|\| )SCAN (goals|work_items|w|contacts|c|tokens|support_tickets)\b/, `${label}: no table is read whole\n${plan}`);
    }
  }
});

test('the recycle bin purge reads only what is in the bin, by the index on when each row was deleted', async () => {
  const db = app.ctx.db;
  const sweep = (await statements(db, () => purgeDeleted(app.ctx))).filter((s) => /deleted_at IS NOT NULL AND deleted_at < \?/.test(s.sql));
  const tables = new Set<string>();
  for (const s of sweep) {
    const table = /FROM (\w+) WHERE/.exec(s.sql)![1];
    tables.add(table);
    const plan = planOf(db, s);
    assert.match(plan, new RegExp(`USING (COVERING )?INDEX idx_${table}_deleted \\(deleted_at>\\? AND deleted_at<\\?\\)`), `${s.sql}\n${plan}`);
  }
  assert.deepEqual([...tables].sort(), ['activities', 'attachments', 'awards', 'comments', 'counselings', 'duties', 'goals', 'projects', 'tasks', 'trainings']);
});

test('deleting an account checks the rows that name it by index, not by reading each table', () => {
  const db = app.ctx.db;
  const roots = new Map((db.prepare("SELECT rootpage, name FROM sqlite_schema WHERE type = 'index'").all() as Array<{ rootpage: number; name: string }>).map((r) => [r.rootpage, r.name]));
  const opened = (db.prepare('EXPLAIN DELETE FROM users WHERE id = ?').all('nobody') as Array<{ opcode: string; p2: number }>)
    .filter((c) => c.opcode === 'OpenRead').map((c) => roots.get(c.p2)).filter(Boolean);
  for (const index of ['idx_goals_assignee', 'idx_work_items_owner', 'idx_contacts_owner', 'idx_tokens_user']) assert.ok(opened.includes(index), `${index} in ${opened.join(', ')}`);
});

test('a unit window tests both of its ends in the index, before any row of the table is read', async () => {
  const db = app.ctx.db;
  for (const index of ['idx_activities_unit_last', 'idx_trainings_unit_last', 'idx_duties_unit_last']) {
    const keys = (db.prepare('SELECT name FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno').all(index) as Array<{ name: string | null }>).map((k) => k.name);
    assert.equal(keys.at(-1), 'date', `${index}: ${JSON.stringify(keys)}`);
  }
  const seen = await statements(db, async () => ok(await app.call('GET', '/api/metrics?unit_id=G8&period=all', { token: op.token })));
  const windowed = seen.filter((s) => /INDEXED BY idx_(activities|trainings)_unit_last/.test(s.sql));
  assert.ok(windowed.length >= 4, 'the window and the window before it, for both tables');
  const root = (name: string) => (db.prepare('SELECT rootpage FROM sqlite_schema WHERE name = ?').get(name) as { rootpage: number }).rootpage;
  for (const s of windowed) {
    const index = /INDEXED BY (idx_\w+)/.exec(s.sql)![1];
    const table = /FROM (\w+) t INDEXED BY/.exec(s.sql)![1];
    const code = db.prepare(`EXPLAIN ${s.sql}`).all(...s.args) as Array<{ opcode: string; p1: number; p2: number }>;
    const indexCursor = code.find((c) => c.opcode === 'OpenRead' && c.p2 === root(index))!.p1;
    const tableCursor = code.find((c) => c.opcode === 'OpenRead' && c.p2 === root(table))!.p1;
    const dateKey = (db.prepare("SELECT seqno FROM pragma_index_xinfo(?) WHERE name = 'date'").get(index) as { seqno: number }).seqno;
    const firstRow = code.findIndex((c) => c.opcode === 'Column' && c.p1 === tableCursor);
    const dateRead = code.findIndex((c) => c.opcode === 'Column' && c.p1 === indexCursor && c.p2 === dateKey);
    assert.ok(dateRead >= 0 && firstRow > dateRead, `${index}: the window's end is tested on the index (at ${dateRead}) before the table is read (at ${firstRow})`);
  }
});

// One size measure

test('the size of the database counts what is still in the write-ahead log and its free pages, and never reads the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-size-'));
  const path = join(dir, 'vantage.db');
  const db = openDatabase(path);
  const reader = new Database(path);
  try {
    // A reader keeps the log from being folded into the file, as anyone reading at that moment does.
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM users').get();
    db.exec('CREATE TABLE ballast (x BLOB)');
    db.prepare('INSERT INTO ballast SELECT randomblob(4096) FROM (WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 512) SELECT v FROM n)').run();
    const size = databaseSize(db);
    assert.equal(size.bytes, Number(db.pragma('page_count', { simple: true })) * size.pageSize);
    assert.ok(size.bytes - statSync(path).size > 1_500_000, `${size.bytes} counted, ${statSync(path).size} in the file`);
    reader.exec('COMMIT');
    db.exec('DELETE FROM ballast');
    const after = databaseSize(db);
    assert.ok(after.freeBytes > 1_500_000, 'deleted rows leave free pages, which count until compacting gives them back');
    assert.equal(after.bytes, size.bytes);
    assert.equal(after.usedBytes, after.bytes - after.freeBytes);
    assert.equal(databaseRoom(db, after.bytes), 0);
    assert.equal(databaseRoom(db, after.bytes + 10), 10);
    assert.equal(databaseRoom(db, 1), 0, 'never below nothing');
  } finally { reader.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('at the threshold a record, a workbook, an attachment and an import’s files are refused alike, in memory too, and the console says so', async () => {
  const limits = app.ctx.config.limits;
  const was = limits.maxDatabaseBytes;
  const other = await app.register('okafor');
  other.token = (await app.login('okafor')).body.token;
  const record = ok(await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Reconciled the ledger', date: today(), visibility: 'private' } })).body;
  // The files of an import: a JSON restore first, its ZIP after, as a Marine moving records brings them.
  const award = ok(await app.call('POST', '/api/records/awards', { token: marine.token, body: { name: 'Certificate of Appreciation', type: 'certificate', status: 'presented', date: '2026-04-04' } })).body;
  ok(await app.call('POST', `/api/records/awards/${award.id}/attachments`, { token: marine.token, raw: Buffer.from('%PDF-1.4\n% the certificate\n%%EOF\n'), headers: { 'content-type': 'application/pdf', 'x-vantage-filename': 'certificate.pdf' } }));
  const json = ok(await app.call('GET', '/api/me/export?format=json&sections=awards', { token: marine.token }));
  const zip = ok(await app.call('GET', '/api/me/export?format=zip&sections=awards,attachments', { token: marine.token, binary: true }));
  const stage = (data: Buffer, filename: string, type: string) => app.call('POST', '/api/me/imports', { token: other.token, raw: data, headers: { 'content-type': type, 'x-filename': filename } });
  const first = ok(await stage(Buffer.from(JSON.stringify(json.body)), 'mercer.json', 'application/json')).body;
  ok(await app.call('POST', `/api/me/imports/${first.id}/commit`, { token: other.token, body: { expected: { new: first.counts.new, update: first.counts.update } } }));
  const files = ok(await stage(zip.buffer!, 'mercer.zip', 'application/zip')).body;
  assert.equal(files.attachments.included, 1, JSON.stringify(files.attachments));
  try {
    limits.maxDatabaseBytes = databaseSize(app.ctx.db).bytes;
    const refused = [
      await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'One more', date: today(), visibility: 'private' } }),
      await app.call('POST', '/api/work/sources', { token: op.token, raw: Buffer.from('Document,Description\nULO-1,Clear it\n'), headers: { 'content-type': 'text/csv', 'x-filename': 'work.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' } }),
      await app.call('POST', `/api/records/activities/${record.id}/attachments`, { token: op.token, raw: Buffer.from('%PDF-1.4\n% evidence\n%%EOF\n'), headers: { 'content-type': 'application/pdf', 'x-vantage-filename': 'evidence.pdf' } }),
    ];
    for (const res of refused) assert.deepEqual([res.status, res.body?.code], [507, 'database_capacity'], JSON.stringify(res.body));
    const committed = ok(await app.call('POST', `/api/me/imports/${files.id}/commit`, { token: other.token, body: { expected: { new: files.counts.new, update: files.counts.update } } }));
    assert.match(JSON.stringify(committed.body), /too close to its safety threshold for that file/);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE uploaded_by = ? AND deleted_at IS NULL').get(other.id) as { n: number }).n, 0, 'the import brought no file in');

    const health = healthReport(app.ctx).checks.find((c) => c.id === 'database')!;
    assert.equal(health.status, 'fail');
    const overview = ok(await app.call('GET', '/api/platform/overview', { token: op.token })).body;
    assert.equal(overview.database.status, 'fail', 'the Overview takes its tone from the same check');
    assert.ok(overview.database.sizeBytes >= limits.maxDatabaseBytes && typeof overview.database.freeBytes === 'number', JSON.stringify(overview.database));
  } finally { limits.maxDatabaseBytes = was; }
  assert.equal((await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'One more', date: today(), visibility: 'private' } })).status, 201, 'below it again, records are taken');
});

// Scheduled upkeep

test('the upkeep runs on a thread of its own, is audited, and runs again only once it is due', async () => {
  const { disk, done } = await onDisk();
  const ctx = disk.ctx;
  try {
    await disk.setupOperator();
    assert.equal(lastUpkeep(ctx), null);
    assert.equal(upkeepDue(ctx), true, 'a database never kept up is due');
    assert.equal(healthReport(ctx).checks.find((c) => c.id === 'upkeep')!.status, 'info');
    let turned = false;
    setImmediate(() => { turned = true; });
    const run = await runDatabaseUpkeep(ctx);
    assert.ok(turned, 'the service kept answering while it ran');
    assert.equal(run!.outcome, 'done');
    assert.equal(run!.problems, 0);
    assert.ok(run!.analyzed.length > 0, 'the tables written since the start had stale statistics');
    assert.equal(run!.reloaded, true);
    assert.deepEqual(run!.checkpoint && [run!.checkpoint.emptied, run!.checkpoint.folded === run!.checkpoint.pages], [true, true]);
    assert.deepEqual(lastUpkeep(ctx), run, 'kept beside the database');

    const [entry] = upkeepEntries(ctx.db);
    assert.deepEqual([entry.actor_id, entry.category, entry.entity, entry.entity_id, entry.org_id, entry.unit_id], [null, 'enterprise', 'database', 'done', null, null]);
    assert.match(entry.detail!, /^No damage found\. Statistics refreshed for \d+ tables?\. Log emptied/);
    assert.ok(maintenanceState(ctx).history.some((h) => (h as { action: string }).action === 'database_upkeep'), 'it shows among the maintenance steps');
    assert.equal(healthReport(ctx).checks.find((c) => c.id === 'upkeep')!.status, 'ok');

    assert.equal(upkeepDue(ctx), false);
    assert.equal(await databaseUpkeepTick(ctx), null, 'the next tick runs nothing');
    assert.equal(upkeepEntries(ctx.db).length, 1);
    const tomorrow = Date.now() + 24 * 3_600_000 + 60_000;
    assert.equal((await databaseUpkeepTick(ctx, tomorrow))?.outcome, 'done', 'once the interval has passed it runs again');
    assert.equal(upkeepEntries(ctx.db).length, 2);

    ctx.config.operations.upkeepHours = 2;
    try { assert.equal(upkeepDue(ctx, Date.now() + 2 * 3_600_000 + 60_000), true, 'VANTAGE_DB_UPKEEP_HOURS sets the interval'); } finally { ctx.config.operations.upkeepHours = 24; }
    ctx.runtime.maintenance = true;
    try {
      assert.equal(await databaseUpkeepTick(ctx, tomorrow + 24 * 3_600_000), null, 'never during maintenance');
      assert.equal(upkeepEntries(ctx.db).length, 2);
    } finally { ctx.runtime.maintenance = false; }
    const late = healthReport(ctx, Date.now() + 50 * 3_600_000).checks.find((c) => c.id === 'upkeep')!;
    assert.deepEqual([late.status, /^Late/.test(late.summary)], ['warn', true], 'not run for twice its interval needs attention');
  } finally { await done(); }
});

test('statistics another connection refreshed reach the service’s planner only when it takes them up, and it does not wait for the lock to', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-stats-'));
  const path = join(dir, 'vantage.db');
  const db = openDatabase(path);
  const writer = new Database(path);
  try {
    db.exec('CREATE TABLE upkeep_probe (a INTEGER, b INTEGER); CREATE INDEX upkeep_probe_a ON upkeep_probe(a); CREATE INDEX upkeep_probe_b ON upkeep_probe(b)');
    db.prepare('WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v + 1 FROM n WHERE v < 20000) INSERT INTO upkeep_probe (a, b) SELECT v % 2, v FROM n').run();
    const plan = () => (db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM upkeep_probe WHERE a = 1 AND b BETWEEN 19990 AND 19999').all() as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    assert.match(plan(), /upkeep_probe_a/, 'with no statistics, the planner guesses');
    const work = upkeepWork(path);
    assert.ok(work.analyzed.includes('upkeep_probe'));
    assert.match(plan(), /upkeep_probe_a/, 'statistics another connection wrote are not seen yet');
    writer.exec('BEGIN IMMEDIATE');
    const started = performance.now();
    assert.equal(reloadStatistics(db), false, 'another holds the write lock: not now');
    assert.ok(performance.now() - started < 1000, 'and it did not wait');
    assert.equal(Number(db.pragma('busy_timeout', { simple: true })), 5000, 'the connection waits as long as before for everything else');
    writer.exec('COMMIT');
    assert.equal(reloadStatistics(db), true);
    assert.match(plan(), /upkeep_probe_b/, 'taken up, the statistics change the plan');
  } finally { writer.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a reader in the log at that moment keeps it from being emptied, and nothing waits on it', async () => {
  const { disk, path, done } = await onDisk();
  const reader = new Database(path);
  try {
    await disk.setupOperator();
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) FROM users').get();
    disk.ctx.db.prepare("INSERT INTO meta (key, value) VALUES ('upkeep_test', 'written after the reader began')").run();
    const started = performance.now();
    const run = await runDatabaseUpkeep(disk.ctx);
    assert.ok(performance.now() - started < 4000);
    assert.equal(run!.outcome, 'done');
    assert.equal(run!.checkpoint!.emptied, false);
    assert.match(upkeepEntries(disk.ctx.db).at(-1)!.detail!, /the log was in use, so it was left for the next run/);
  } finally { reader.close(); await done(); }
});

test('damage the check finds is recorded, told to the staff who view the platform, and fails the health check until a run finds none', async () => {
  const { disk, path, done } = await onDisk();
  const ctx = disk.ctx;
  try {
    const staff = await disk.setupOperator();
    // One index entry changed on disk: SQLite's integrity check finds the row it no longer indexes.
    ctx.db.exec("CREATE TABLE upkeep_probe (x TEXT); CREATE INDEX upkeep_probe_x ON upkeep_probe(x); INSERT INTO upkeep_probe VALUES ('probe-key-aaaa')");
    ctx.db.pragma('wal_checkpoint(TRUNCATE)');
    const root = (ctx.db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'upkeep_probe_x'").get() as { rootpage: number }).rootpage;
    const pageSize = Number(ctx.db.pragma('page_size', { simple: true }));
    const fd = openSync(path, 'r+');
    try {
      const page = Buffer.alloc(pageSize);
      readSync(fd, page, 0, pageSize, (root - 1) * pageSize);
      const at = page.indexOf('probe-key-aaaa');
      assert.ok(at > 0);
      writeSync(fd, Buffer.from('probe-key-zzzz'), 0, 14, (root - 1) * pageSize + at);
    } finally { closeSync(fd); }

    await assert.rejects(runDatabaseUpkeep(ctx), /integrity check found 1 problem in the database/);
    const last = lastUpkeep(ctx)!;
    assert.deepEqual([last.outcome, last.problems, last.messages], ['damaged', 1, ['row 1 missing from index upkeep_probe_x']]);
    const entry = upkeepEntries(ctx.db).at(-1)!;
    assert.equal(entry.entity_id, 'damaged');
    assert.match(entry.detail!, /found 1 problem: row 1 missing from index upkeep_probe_x/);
    const told = ctx.db.prepare("SELECT action_url FROM notifications WHERE user_id = ? AND title LIKE '%found damage%'").all(staff.id) as Array<{ action_url: string }>;
    assert.deepEqual(told.map((n) => n.action_url), ['/admin/operations']);
    const report = healthReport(ctx);
    assert.equal(report.checks.find((c) => c.id === 'upkeep')!.status, 'fail');
    assert.equal(report.status, 'fail');

    ctx.db.exec('REINDEX upkeep_probe_x');
    assert.equal((await runDatabaseUpkeep(ctx))!.outcome, 'done');
    assert.equal(healthReport(ctx).checks.find((c) => c.id === 'upkeep')!.status, 'ok');
  } finally { await done(); }
});

/** Until the upkeep thread on this database has ended, at most five seconds. */
async function threadEnded(ctx: TestApp['ctx']) {
  for (let i = 0; i < 100 && upkeepRunning(ctx); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return !upkeepRunning(ctx);
}

test('a run past its time limit is recorded at the limit with the step it was in, and none starts beside its thread; nothing is scheduled for a database in memory', async () => {
  const { disk, done } = await onDisk();
  try {
    await disk.setupOperator();
    // A thread cannot be stopped inside a call into SQLite, so the limit settles the run and the thread ends after its step.
    await assert.rejects(runDatabaseUpkeep(disk.ctx, { timeoutMs: 1 }), /^Error: Database upkeep stopped: it was still (starting|checking the database for damage|refreshing the query statistics|folding in the write-ahead log) after 1 minute, so it was told to stop; SQLite ends that step first$/);
    assert.equal(upkeepRunning(disk.ctx), true, 'its thread is still ending');
    assert.equal(await databaseUpkeepTick(disk.ctx, Date.now() + 48 * 3_600_000), null, 'no run starts beside it, even when one is due');
    const last = lastUpkeep(disk.ctx)!;
    assert.equal(last.outcome, 'failed');
    assert.equal(upkeepEntries(disk.ctx.db).at(-1)!.entity_id, 'failed');
    const check = healthReport(disk.ctx).checks.find((c) => c.id === 'upkeep')!;
    assert.deepEqual([check.status, /stopped: it was still .+, so it was told to stop/.test(check.summary)], ['warn', true]);
    assert.equal(upkeepDue(disk.ctx), false, 'a stopped run waits its interval like any other');
    assert.equal(await threadEnded(disk.ctx), true, 'the thread ends');
    assert.equal(upkeepEntries(disk.ctx.db).length, 1, 'and what it went on to find is not recorded');

    const stop = startSchedulers(disk.ctx);
    try { assert.ok(jobStatus(disk.ctx).some((j) => j.name === 'database_upkeep')); } finally { stop(); clearJobs(disk.ctx); }
  } finally { await done(); }

  assert.equal(await databaseUpkeepTick(app.ctx), null);
  assert.equal(upkeepDue(app.ctx), false);
  assert.equal(healthReport(app.ctx).checks.find((c) => c.id === 'upkeep'), undefined);
  const stop = startSchedulers(app.ctx);
  try { assert.ok(!jobStatus(app.ctx).some((j) => j.name === 'database_upkeep')); } finally { stop(); clearJobs(app.ctx); }
});

test('starting maintenance stops a run under way, and Compact and emptying the log wait for its thread', async () => {
  const { disk, done } = await onDisk();
  const ctx = disk.ctx;
  try {
    const staff = await disk.setupOperator();
    const actor = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(staff.id) as SessionUser;
    const run = runDatabaseUpkeep(ctx);
    assert.equal(upkeepRunning(ctx), true);
    assert.throws(() => runMaintenanceTask(ctx, actor, 'checkpoint'), { status: 409, code: 'upkeep_running' });
    startMaintenance(ctx, actor, { reason: 'Compacting the database file' });
    assert.throws(() => runMaintenanceTask(ctx, actor, 'vacuum'), { status: 409, code: 'upkeep_running', message: /scheduled upkeep is finishing a step/ });
    assert.equal(runMaintenanceTask(ctx, actor, 'database_check').ok, true, 'a check that only reads runs beside it');
    assert.equal(await run, null, 'stopped, it records nothing');
    assert.equal(lastUpkeep(ctx), null);
    assert.equal(upkeepEntries(ctx.db).length, 0);
    assert.equal(upkeepRunning(ctx), false);
    assert.equal(runMaintenanceTask(ctx, actor, 'vacuum').ok, true, 'once it has ended, Compact runs');

    // A month of daily runs does not push who ran Compact off the Maintenance page.
    for (let i = 0; i < 40; i += 1) audit(ctx, { actor_id: null, action: 'database_upkeep', entity: 'database', entity_id: 'done', detail: 'No damage found.' });
    const actions = maintenanceState(ctx).history.map((h) => (h as { action: string }).action);
    assert.equal(actions.filter((a) => a === 'database_upkeep').length, 5);
    assert.deepEqual(actions.filter((a) => a !== 'database_upkeep'), ['maintenance_task', 'maintenance_task', 'maintenance_on']);
  } finally { await done(); }
});

test('a run whose statistics cannot be taken up is kept, and only the reload is tried again', async () => {
  const { disk, done } = await onDisk();
  const ctx = disk.ctx;
  try {
    await disk.setupOperator();
    const exec = ctx.db.exec;
    let failing = true;
    ctx.db.exec = function (this: typeof ctx.db, sql: string) {
      if (failing && sql === 'ANALYZE sqlite_schema') throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
      return exec.call(this, sql);
    } as typeof ctx.db.exec;
    try {
      const run = await runDatabaseUpkeep(ctx);
      assert.deepEqual([run!.outcome, run!.reloaded], ['done', false]);
      assert.ok(run!.skipped.includes('taking up the new statistics: disk I/O error'), JSON.stringify(run!.skipped));
      assert.match(upkeepEntries(ctx.db).at(-1)!.detail!, /taken up on a later tick\. .*Not run: taking up the new statistics: disk I\/O error\./);
      assert.equal(await databaseUpkeepTick(ctx), null, 'a failing reload does not stop the tick, and the run is not due again');
      assert.equal(lastUpkeep(ctx)!.reloaded, false);
      failing = false;
      assert.equal(await databaseUpkeepTick(ctx), null);
      assert.equal(lastUpkeep(ctx)!.reloaded, true, 'the next tick takes them up');
      assert.equal(upkeepEntries(ctx.db).length, 1, 'without running the upkeep again');
    } finally { ctx.db.exec = exec; }
  } finally { await done(); }
});

test('damage past the check’s limit is said as at least that many', () => {
  assert.deepEqual([problemCount(1), problemCount(99), problemCount(100)], ['1 problem', '99 problems', 'at least 100 problems']);
});

// Deleted text overwritten

test('a purged record’s text is gone from the database file, where with secure_delete off it stays', async () => {
  for (const secure of [true, false]) {
    const { disk, path, done } = await onDisk();
    try {
      if (!secure) disk.ctx.db.pragma('secure_delete = OFF');
      else assert.equal(Number(disk.ctx.db.pragma('secure_delete', { simple: true })), 1, 'on for every connection the service opens');
      const owner = await disk.setupOperator();
      const marker = 'quartz-heron-71830';
      const made = await disk.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Reconciled the ledger', date: today(), result: `Found ${marker} in the ledger`, visibility: 'private' } });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      assert.equal((await disk.call('DELETE', `/api/records/activities/${made.body.id}`, { token: owner.token })).status, 200);
      disk.ctx.db.prepare("UPDATE activities SET deleted_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(made.body.id);
      assert.equal(purgeDeleted(disk.ctx).records, 1);
      disk.ctx.db.pragma('wal_checkpoint(TRUNCATE)');
      assert.equal(readFileSync(path).includes(Buffer.from(marker)), !secure, secure ? 'overwritten where it lay' : 'left on a free page');
    } finally { await done(); }
  }
});
