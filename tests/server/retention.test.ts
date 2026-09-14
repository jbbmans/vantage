import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.ts';
import { saveSchedule, placeHold, runDisposition, REDACTED } from '../../server/services/retention.ts';
import { buildInventory, inventoryMarkdown, DECLARATIONS } from '../../server/services/privacyInventory.ts';

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
