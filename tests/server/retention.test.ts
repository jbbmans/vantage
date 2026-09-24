import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.ts';
import { saveSchedule, placeHold, runDisposition, REDACTED } from '../../server/services/retention.ts';
import { buildInventory, inventoryMarkdown, DECLARATIONS } from '../../server/services/privacyInventory.ts';
import { purgeDeleted } from '../../server/services/records.ts';
import { pruneSources } from '../../server/services/intake.ts';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

async function withOldRecords() {
  const app = await startApp();
  const op = await app.setupOperator();
  const insert = (date: string, title: string) =>
    app.call('POST', '/api/records/activities', { token: op.token, body: { title, date, category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment' } });
  await insert(daysAgo(1200), 'Very old entry');
  await insert(daysAgo(900), 'Old entry');
  await insert(daysAgo(10), 'Recent entry');
  return { app, op };
}

test('nothing is disposed of until somebody enables a schedule', async () => {
  const { app, op } = await withOldRecords();
  try {
    // A schedule that exists but is off does nothing at all.
    saveSchedule(app.ctx, { record_type: 'activities', retain_days: 365, disposition: 'destroy', enabled: false }, op.id);
    const result = runDisposition(app.ctx, { dryRun: false, actorId: op.id });
    assert.equal(result.lines.length, 0, 'a disabled schedule is not run');
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 3);
  } finally { await app.close(); }
});

test('a dry run reports what would go without touching anything', async () => {
  const { app, op } = await withOldRecords();
  try {
    saveSchedule(app.ctx, { record_type: 'activities', retain_days: 365, disposition: 'destroy', enabled: true, authority: 'GRS 2.2 item 010' }, op.id);
    const dry = runDisposition(app.ctx, { dryRun: true, actorId: op.id });
    const line = dry.lines.find((l) => l.record_type === 'activities')!;
    assert.equal(line.eligible, 2, 'the two entries older than a year are eligible');
    assert.equal(line.acted, 0, 'a dry run acts on nothing');
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 3);

    const applied = runDisposition(app.ctx, { dryRun: false, actorId: op.id });
    assert.equal(applied.lines.find((l) => l.record_type === 'activities')!.acted, 2);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 1, 'only the recent entry survives');
  } finally { await app.close(); }
});

test('an instance-wide legal hold stops everything, and is recorded as having done so', async () => {
  const { app, op } = await withOldRecords();
  try {
    saveSchedule(app.ctx, { record_type: 'activities', retain_days: 365, disposition: 'destroy', enabled: true }, op.id);
    placeHold(app.ctx, { scope: 'instance', reason: 'IG inquiry 2026-14' }, op.id);

    const result = runDisposition(app.ctx, { dryRun: false, actorId: op.id });
    assert.match(result.blocked || '', /legal hold/i);
    assert.equal(result.lines.length, 0);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 3, 'nothing was removed');

    const run = app.ctx.db.prepare('SELECT * FROM disposition_runs ORDER BY at DESC LIMIT 1').get() as { detail: string };
    assert.match(run.detail, /hold/i, 'the blocked run is still on the record');
  } finally { await app.close(); }
});

test('a hold on one person spares their records and no one else’s', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const other = await app.register('rivera');
    const insert = (token: string, title: string) =>
      app.call('POST', '/api/records/activities', { token, body: { title, date: daysAgo(900), category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment' } });
    await insert(op.token, 'Operator old entry');
    await insert(other.token, 'Rivera old entry');

    saveSchedule(app.ctx, { record_type: 'activities', retain_days: 365, disposition: 'destroy', enabled: true }, op.id);
    placeHold(app.ctx, { scope: 'user', subject_id: other.id, reason: 'pending board action' }, op.id);

    const result = runDisposition(app.ctx, { dryRun: false, actorId: op.id });
    const line = result.lines.find((l) => l.record_type === 'activities')!;
    assert.equal(line.acted, 1, 'only the unheld record went');
    assert.equal(line.held, 1, 'the held one is reported, not silently skipped');

    const remaining = app.ctx.db.prepare('SELECT user_id FROM activities').all() as Array<{ user_id: string }>;
    assert.deepEqual(remaining.map((r) => r.user_id), [other.id], 'the held person keeps their record');
  } finally { await app.close(); }
});

test('anonymize keeps the countable facts and drops the words about a person', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    await app.call('POST', '/api/records/activities', {
      token: op.token,
      body: { title: 'Reconciled 30 ULOs', date: daysAgo(900), category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', quantity: 30, unit_label: 'ULOs', result: 'cleared the backlog', notes: 'spoke to the vendor' },
    });
    saveSchedule(app.ctx, { record_type: 'activities', retain_days: 365, disposition: 'anonymize', enabled: true }, op.id);
    runDisposition(app.ctx, { dryRun: false, actorId: op.id });

    const row = app.ctx.db.prepare('SELECT * FROM activities LIMIT 1').get() as Record<string, unknown>;
    assert.equal(row.title, REDACTED, 'free text is replaced by a marker that says why it is gone');
    assert.equal(row.result, REDACTED);
    assert.equal(row.notes, REDACTED);
    assert.equal(row.quantity, 30, 'the quantity survives, so aggregate history stays true');
    assert.equal(row.date, daysAgo(900), 'and so does the date it is counted in');
  } finally { await app.close(); }
});

test('the disposition log records every run, including the ones that removed nothing', async () => {
  const { app, op } = await withOldRecords();
  try {
    saveSchedule(app.ctx, { record_type: 'activities', retain_days: 36_000, disposition: 'destroy', enabled: true }, op.id);
    runDisposition(app.ctx, { dryRun: false, actorId: op.id });
    const runs = app.ctx.db.prepare('SELECT * FROM disposition_runs').all() as Array<{ eligible: number; acted: number }>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0].eligible, 0);
    assert.equal(runs[0].acted, 0, 'a run that did nothing is still a run that happened');
  } finally { await app.close(); }
});

test('retention is reachable only by an operator who has re-confirmed', async () => {
  const app = await startApp();
  try {
    await app.setupOperator();
    const member = await app.register('member');
    const forbidden = await app.call('GET', '/api/admin/retention', { token: member.token });
    assert.ok(forbidden.status === 403 || forbidden.status === 404, `a member cannot read retention (got ${forbidden.status})`);

    const run = await app.call('POST', '/api/admin/retention/run?apply=1', { token: member.token });
    assert.ok(run.status === 403 || run.status === 404, 'and certainly cannot run disposition');
  } finally { await app.close(); }
});

// The inventory ----------------------------------------------------------

test('the inventory is built from the live schema and names its own gaps', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    saveSchedule(app.ctx, { record_type: 'counselings', retain_days: 1825, disposition: 'review', enabled: true, authority: 'SSIC 1610' }, op.id);

    const inv = buildInventory(app.ctx);
    const users = inv.tables.find((t) => t.table === 'users')!;
    assert.ok(users.purpose, 'a declared table carries its purpose');
    assert.equal(users.columns.find((c) => c.column === 'edipi')?.category, 'identifier');
    assert.equal(users.columns.find((c) => c.column === 'password_hash')?.category, 'authentication');

    const counselings = inv.tables.find((t) => t.table === 'counselings')!;
    assert.equal(counselings.retention?.retain_days, 1825, 'the schedule shows up against the table it governs');
    assert.equal(counselings.retention?.authority, 'SSIC 1610');

    // The property that makes this worth having: it notices what it has not been told about.
    assert.equal(users.stale.length, 0, 'the users declaration matches the live schema');
    assert.ok(Array.isArray(inv.summary.undeclared));
    assert.equal(typeof inv.summary.unclassifiedColumns, 'number');
  } finally { await app.close(); }
});

test('a column added to the schema and not to the declaration is reported, not ignored', async () => {
  const app = await startApp();
  try {
    await app.setupOperator();
    app.ctx.db.exec('ALTER TABLE users ADD COLUMN home_phone TEXT');
    const inv = buildInventory(app.ctx);
    const users = inv.tables.find((t) => t.table === 'users')!;
    assert.ok(users.unclassified.includes('home_phone'), 'an unclassified column is surfaced as a gap');
    assert.ok(inv.summary.unclassifiedColumns > 0);
    assert.match(inventoryMarkdown(inv), /unclassified/i);
  } finally { await app.close(); }
});

test('no declared column has drifted away from the schema', async () => {
  const app = await startApp();
  try {
    await app.setupOperator();
    const inv = buildInventory(app.ctx);
    const drifted = inv.tables.filter((t) => t.stale.length).map((t) => `${t.table}: ${t.stale.join(', ')}`);
    // The inventory reports drift for the instance operator; it should never be reporting our own.
    // A declaration that names a column the database does not have is a privacy artifact that is
    // simply wrong, which is worse than one that is incomplete.
    assert.deepEqual(drifted, [], `the shipped declaration names columns that do not exist:\n${drifted.join('\n')}`);
  } finally { await app.close(); }
});

test('every table the inventory declares still exists', async () => {
  const app = await startApp();
  try {
    await app.setupOperator();
    const live = new Set((app.ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name));
    for (const table of Object.keys(DECLARATIONS)) {
      assert.ok(live.has(table), `the inventory declares ${table}, which no longer exists`);
    }
  } finally { await app.close(); }
});

/* F07: the recycle-bin purge and the source-byte pruning answer to the same holds as disposition. */

const longAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

test('the recycle-bin purge keeps what a hold covers, and leaves disposition evidence', async () => {
  const { app, op } = await withOldRecords();
  try {
    app.ctx.db.prepare('UPDATE activities SET deleted_at = ?').run(longAgo(40));
    const instance = placeHold(app.ctx, { scope: 'instance', reason: 'IG inquiry 2026-14' }, op.id);
    const blocked = purgeDeleted(app.ctx);
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.records, 0);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 3, 'an instance hold stops the purge');
    app.ctx.db.prepare('UPDATE legal_holds SET released_at = ?, released_by = ? WHERE id = ?').run(new Date().toISOString(), op.id, instance.id);

    placeHold(app.ctx, { scope: 'record_type', record_type: 'activities', reason: 'Awards board review' }, op.id);
    assert.equal(purgeDeleted(app.ctx).records, 0);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 3, 'a record-type hold keeps that type');
    app.ctx.db.prepare("UPDATE legal_holds SET released_at = ?, released_by = ? WHERE scope = 'record_type'").run(new Date().toISOString(), op.id);

    placeHold(app.ctx, { scope: 'user', subject_id: op.id, reason: 'Personnel action' }, op.id);
    const personHeld = purgeDeleted(app.ctx);
    assert.equal(personHeld.records, 0, 'a person hold keeps that person’s rows');
    assert.equal(personHeld.held, 3);
    const evidence = app.ctx.db.prepare("SELECT record_type, held, acted, detail FROM disposition_runs WHERE detail LIKE 'recycle-bin purge%' OR record_type = '(recycle bin)'").all() as any[];
    assert.ok(evidence.length >= 3, 'every held-back purge is recorded as disposition evidence');
    assert.ok(evidence.every((r) => r.acted === 0));
    app.ctx.db.prepare("UPDATE legal_holds SET released_at = ?, released_by = ? WHERE scope = 'user'").run(new Date().toISOString(), op.id);

    const done = purgeDeleted(app.ctx);
    assert.equal(done.records, 3, 'with every hold released, the purge proceeds');
    const last = app.ctx.db.prepare("SELECT eligible, acted FROM disposition_runs WHERE record_type = 'activities' ORDER BY at DESC, rowid DESC LIMIT 1").get() as any;
    assert.deepEqual({ ...last }, { eligible: 3, acted: 3 });
  } finally { await app.close(); }
});

test('source bytes past the intake window are kept under a hold and released without one', async () => {
  const app = await startApp({ VANTAGE_INTAKE_RETAIN_DAYS: '30' });
  const op = await app.setupOperator();
  try {
    if (!app.ctx.config.intake.retainDays) app.ctx.config.intake.retainDays = 30;
    const insert = app.ctx.db.prepare(`INSERT INTO source_files (id, user_id, unit_id, visibility, filename, content_type, kind, byte_size, sha256, scan_status, content, created_at) VALUES (?, ?, NULL, 'private', 'old.csv', 'text/csv', 'delimited', 3, 'x', 'clean', ?, ?)`);
    insert.run('src-old', op.id, Buffer.from('a,b'), longAgo(60));
    placeHold(app.ctx, { scope: 'record_type', record_type: 'work_items', reason: 'Audit of FY26 corrections' }, op.id);
    assert.equal(pruneSources(app.ctx), 0);
    assert.equal((app.ctx.db.prepare("SELECT byte_size FROM source_files WHERE id = 'src-old'").get() as any).byte_size, 3, 'a hold on imported work keeps its sources');
    app.ctx.db.prepare('UPDATE legal_holds SET released_at = ?, released_by = ?').run(new Date().toISOString(), op.id);
    placeHold(app.ctx, { scope: 'user', subject_id: op.id, reason: 'Personnel action' }, op.id);
    assert.equal(pruneSources(app.ctx), 0, 'the uploader is under hold');
    app.ctx.db.prepare('UPDATE legal_holds SET released_at = ?, released_by = ?').run(new Date().toISOString(), op.id);
    assert.equal(pruneSources(app.ctx), 1);
    const kinds = app.ctx.db.prepare("SELECT held, acted FROM disposition_runs WHERE record_type = 'source_files' ORDER BY rowid").all() as any[];
    assert.deepEqual(kinds.map((k) => [k.held, k.acted]), [[1, 0], [1, 0], [0, 1]]);
    assert.throws(() => placeHold(app.ctx, { scope: 'record_type', record_type: 'nonsense', reason: 'x' }, op.id), /cannot name/);
  } finally { await app.close(); }
});
