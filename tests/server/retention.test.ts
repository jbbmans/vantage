import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll } from './helpers.ts';
import { saveSchedule, placeHold, runDisposition, REDACTED } from '../../server/services/retention.ts';
import { buildInventory, inventoryMarkdown, DECLARATIONS } from '../../server/services/privacyInventory.ts';
import { purgeDeleted } from '../../server/services/records.ts';
import { pruneSources } from '../../server/services/intake.ts';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
// Retention is an organization's, over the work shared with its units (ADR-0006); these entries are shared with G8.

async function withOldRecords() {
  const app = await startApp();
  const op = await app.setupOperator();
  const insert = (date: string, title: string) =>
    app.call('POST', '/api/records/activities', { token: op.token, body: { title, date, category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', visibility: 'unit', unit_id: 'G8' } });
  await insert(daysAgo(1200), 'Very old entry');
  await insert(daysAgo(900), 'Old entry');
  await insert(daysAgo(10), 'Recent entry');
  return { app, op };
}

test('nothing is disposed of until somebody enables a schedule', async () => {
  const { app, op } = await withOldRecords();
  try {
    // A schedule that exists but is off does nothing at all.
    saveSchedule(app.ctx, 'G8', { record_type: 'activities', retain_days: 365, disposition: 'destroy', enabled: false }, op.id);
    const result = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
    assert.equal(result.lines.length, 0, 'a disabled schedule is not run');
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 3);
  } finally { await app.close(); }
});

test('a dry run reports what would go without touching anything', async () => {
  const { app, op } = await withOldRecords();
  try {
    saveSchedule(app.ctx, 'G8', { record_type: 'activities', retain_days: 365, disposition: 'destroy', enabled: true, authority: 'GRS 2.2 item 010' }, op.id);
    const dry = runDisposition(app.ctx, { orgId: 'G8', dryRun: true, actorId: op.id });
    const line = dry.lines.find((l) => l.record_type === 'activities')!;
    assert.equal(line.eligible, 2, 'the two entries older than a year are eligible');
    assert.equal(line.acted, 0, 'a dry run acts on nothing');
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 3);

    const applied = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
    assert.equal(applied.lines.find((l) => l.record_type === 'activities')!.acted, 2);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 1, 'only the recent entry survives');
  } finally { await app.close(); }
});

test('an instance-wide legal hold stops everything, and is recorded as having done so', async () => {
  const { app, op } = await withOldRecords();
  try {
    saveSchedule(app.ctx, 'G8', { record_type: 'activities', retain_days: 365, disposition: 'destroy', enabled: true }, op.id);
    placeHold(app.ctx, 'G8', { scope: 'instance', reason: 'IG inquiry 2026-14' }, op.id);

    const result = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
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
    await enroll(app, op.token, 'G8', other.id);
    const insert = (token: string, title: string) =>
      app.call('POST', '/api/records/activities', { token, body: { title, date: daysAgo(900), category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', visibility: 'unit', unit_id: 'G8' } });
    await insert(op.token, 'Operator old entry');
    await insert(other.token, 'Rivera old entry');

    saveSchedule(app.ctx, 'G8', { record_type: 'activities', retain_days: 365, disposition: 'destroy', enabled: true }, op.id);
    placeHold(app.ctx, 'G8', { scope: 'user', subject_id: other.id, reason: 'pending board action' }, op.id);

    const result = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
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
      body: { title: 'Reconciled 30 ULOs', date: daysAgo(900), category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', visibility: 'unit', unit_id: 'G8', quantity: 30, unit_label: 'ULOs', result: 'cleared the backlog', notes: 'spoke to the vendor' },
    });
    saveSchedule(app.ctx, 'G8', { record_type: 'activities', retain_days: 365, disposition: 'anonymize', enabled: true }, op.id);
    runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });

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
    saveSchedule(app.ctx, 'G8', { record_type: 'activities', retain_days: 36_000, disposition: 'destroy', enabled: true }, op.id);
    runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
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
    const forbidden = await app.call('GET', '/api/orgs/G8/retention', { token: member.token });
    assert.ok(forbidden.status === 403 || forbidden.status === 404, `a member cannot read retention (got ${forbidden.status})`);

    const run = await app.call('POST', '/api/orgs/G8/retention/run?apply=1', { token: member.token });
    assert.ok(run.status === 403 || run.status === 404, 'and certainly cannot run disposition');
  } finally { await app.close(); }
});

test('the inventory is built from the live schema and names its own gaps', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    saveSchedule(app.ctx, 'G8', { record_type: 'counselings', retain_days: 1825, disposition: 'review', enabled: true, authority: 'SSIC 1610' }, op.id);

    // An organization's inventory carries its own schedules.
    const inv = buildInventory(app.ctx, 'G8');
    const users = inv.tables.find((t) => t.table === 'users')!;
    assert.ok(users.purpose, 'a declared table carries its purpose');
    assert.equal(users.columns.find((c) => c.column === 'edipi')?.category, 'identifier');
    assert.equal(users.columns.find((c) => c.column === 'password_hash')?.category, 'authentication');

    const counselings = inv.tables.find((t) => t.table === 'counselings')!;
    assert.equal(counselings.retention?.retain_days, 1825, 'the schedule shows up against the table it governs');
    assert.equal(counselings.retention?.authority, 'SSIC 1610');

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
    assert.deepEqual(drifted, [], `the shipped declaration names columns that do not exist:\n${drifted.join('\n')}`);
  } finally { await app.close(); }
});

test('every table in a fresh schema is declared, and every column in it classified', async () => {
  const app = await startApp();
  try {
    const inv = buildInventory(app.ctx);
    assert.deepEqual(inv.summary.undeclared, [], 'declare each new table in server/services/privacyInventory.ts, with its purpose and authority');
    const unclassified = inv.tables.filter((t) => t.unclassified.length).map((t) => `${t.table}: ${t.unclassified.join(', ')}`);
    assert.deepEqual(unclassified, [], `classify each new column in its table's declaration:\n${unclassified.join('\n')}`);
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

const longAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

test('the recycle-bin purge keeps what a hold covers, and leaves disposition evidence', async () => {
  const { app, op } = await withOldRecords();
  try {
    app.ctx.db.prepare('UPDATE activities SET deleted_at = ?').run(longAgo(40));
    const instance = placeHold(app.ctx, 'G8', { scope: 'instance', reason: 'IG inquiry 2026-14' }, op.id);
    const blocked = purgeDeleted(app.ctx);
    assert.equal(blocked.blocked, true);
    assert.equal(blocked.records, 0);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 3, 'an instance hold stops the purge');
    app.ctx.db.prepare('UPDATE legal_holds SET released_at = ?, released_by = ? WHERE id = ?').run(new Date().toISOString(), op.id, instance.id);

    placeHold(app.ctx, 'G8', { scope: 'record_type', record_type: 'activities', reason: 'Awards board review' }, op.id);
    assert.equal(purgeDeleted(app.ctx).records, 0);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 3, 'a record-type hold keeps that type');
    app.ctx.db.prepare("UPDATE legal_holds SET released_at = ?, released_by = ? WHERE scope = 'record_type'").run(new Date().toISOString(), op.id);

    placeHold(app.ctx, 'G8', { scope: 'user', subject_id: op.id, reason: 'Personnel action' }, op.id);
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
    placeHold(app.ctx, 'G8', { scope: 'record_type', record_type: 'work_items', reason: 'Audit of FY26 corrections' }, op.id);
    assert.equal(pruneSources(app.ctx), 0);
    assert.equal((app.ctx.db.prepare("SELECT byte_size FROM source_files WHERE id = 'src-old'").get() as any).byte_size, 3, 'a hold on imported work keeps its sources');
    app.ctx.db.prepare('UPDATE legal_holds SET released_at = ?, released_by = ?').run(new Date().toISOString(), op.id);
    placeHold(app.ctx, 'G8', { scope: 'user', subject_id: op.id, reason: 'Personnel action' }, op.id);
    assert.equal(pruneSources(app.ctx), 0, 'the uploader is under hold');
    app.ctx.db.prepare('UPDATE legal_holds SET released_at = ?, released_by = ?').run(new Date().toISOString(), op.id);
    assert.equal(pruneSources(app.ctx), 1);
    const kinds = app.ctx.db.prepare("SELECT held, acted FROM disposition_runs WHERE record_type = 'source_files' ORDER BY rowid").all() as any[];
    assert.deepEqual(kinds.map((k) => [k.held, k.acted]), [[1, 0], [1, 0], [0, 1]]);
    assert.throws(() => placeHold(app.ctx, 'G8', { scope: 'record_type', record_type: 'nonsense', reason: 'x' }, op.id), /cannot name/);
  } finally { await app.close(); }
});

test('an entry drafted from work can be purged and destroyed: its links are let go, its files and draft go with it', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const entryFromWork = async (title: string) => {
      const item = await app.call('POST', '/api/work/items', { token: op.token, body: { unit_id: 'G8', title } });
      await app.call('POST', `/api/work/items/${item.body.id}/claim`, { token: op.token, body: {} });
      const action = await app.call('POST', `/api/work/items/${item.body.id}/actions`, { token: op.token, body: { kind: 'worked', note: 'cleared', draft_record: true } });
      assert.equal(action.status, 201, JSON.stringify(action.body));
      return { activityId: action.body.activity_id as string, actionId: action.body.action.id as string };
    };
    const attach = (recordId: string) => app.ctx.db.prepare(`INSERT INTO attachments (id, record_table, record_id, uploaded_by, original_name, mime_type, size_bytes, sha256, content, created_at)
      VALUES (?, 'activities', ?, ?, 'memo.txt', 'text/plain', 4, 'x', ?, ?)`).run(`att-${recordId}`, recordId, op.id, Buffer.from('memo'), new Date().toISOString());

    // The recycle bin: one such entry used to fail the whole purge on a foreign key, every six hours, for good.
    const binned = await entryFromWork('Clear ULO 1');
    app.ctx.db.prepare('INSERT INTO record_drafts (id, user_id, title, activity_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('draft-1', op.id, 'Clear ULO 1', binned.activityId, new Date().toISOString(), new Date().toISOString());
    attach(binned.activityId);
    assert.equal((await app.call('DELETE', `/api/records/activities/${binned.activityId}`, { token: op.token })).status, 200);
    // A second ago, so the purge's cutoff (strictly earlier than now) cannot fall in the same millisecond as the delete.
    app.ctx.db.prepare('UPDATE activities SET deleted_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), binned.activityId);
    const purged = purgeDeleted(app.ctx, 0);
    assert.equal(purged.records, 1);
    assert.equal(purged.attachments, 1);
    const action = app.ctx.db.prepare('SELECT activity_id FROM work_actions WHERE id = ?').get(binned.actionId) as { activity_id: string | null };
    assert.equal(action.activity_id, null, 'the work history keeps its entry, without the link');
    assert.equal(app.ctx.db.prepare('SELECT 1 FROM record_drafts WHERE id = ?').get('draft-1'), undefined, 'the saved draft goes with its entry');

    // A retention schedule that destroys entries takes their attached files too.
    const kept = await entryFromWork('Clear ULO 2');
    attach(kept.activityId);
    app.ctx.db.prepare('UPDATE activities SET date = ? WHERE id = ?').run(daysAgo(900), kept.activityId);
    saveSchedule(app.ctx, 'G8', { record_type: 'activities', retain_days: 365, disposition: 'destroy', enabled: true }, op.id);
    const result = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
    assert.equal(result.lines.find((l) => l.record_type === 'activities')!.acted, 1);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n, 0, 'destroyed entries used to leave their files behind');
  } finally { await app.close(); }
});

test('anonymized entries are done: the next run neither counts nor touches them again', async () => {
  const { app, op } = await withOldRecords();
  try {
    saveSchedule(app.ctx, 'G8', { record_type: 'activities', retain_days: 365, disposition: 'anonymize', enabled: true }, op.id);
    const first = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id }).lines.find((l) => l.record_type === 'activities')!;
    assert.deepEqual([first.eligible, first.acted], [2, 2]);
    const second = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id }).lines.find((l) => l.record_type === 'activities')!;
    assert.deepEqual([second.eligible, second.acted], [0, 0], 'the same two rows used to be reported and rewritten at every run');
  } finally { await app.close(); }
});

test('an anonymize run keeps what a person under a legal hold said, as it keeps their files, and takes it once the hold is released', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const sato = await app.register('sato');
    await enroll(app, op.token, 'G8', sato.id, 'sncoic');
    sato.token = (await app.login('sato')).body.token;
    const entry = await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Reconciled the ledger', date: daysAgo(900), category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', visibility: 'unit', unit_id: 'G8' } });
    const base = `/api/records/activities/${entry.body.id}`;
    const said = await app.call('POST', `${base}/comments`, { token: sato.token, body: { body: 'Evidence: the ledger was altered on 3 May.' } });
    assert.equal(said.status, 201, JSON.stringify(said.body));
    const noted = await app.call('POST', `${base}/comments`, { token: op.token, body: { body: 'Noted, @sato.' } });
    assert.equal(noted.status, 201, JSON.stringify(noted.body));
    assert.deepEqual(noted.body.mentions, [sato.id]);
    const asked = await app.call('POST', `${base}/requests`, { token: op.token, body: { kind: 'clarification_request', addressee_id: sato.id, body: 'Which ledger?' } });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));

    placeHold(app.ctx, 'G8', { scope: 'user', subject_id: sato.id, reason: 'IG inquiry 2026-14' }, op.id);
    saveSchedule(app.ctx, 'G8', { record_type: 'activities', retain_days: 365, disposition: 'anonymize', enabled: true }, op.id);
    const line = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id }).lines.find((l) => l.record_type === 'activities')!;
    assert.equal(line.acted, 1, 'the entry is anonymized: its owner is not under the hold');
    const comment = (id: string) => ({ ...(app.ctx.db.prepare('SELECT body, mentions, state FROM comments WHERE id = ?').get(id) as { body: string; mentions: string; state: string | null }) });
    assert.deepEqual(comment(said.body.id), { body: 'Evidence: the ledger was altered on 3 May.', mentions: '[]', state: null }, 'the hold keeps what Sato said; it used to be redacted');
    assert.deepEqual(comment(noted.body.id), { body: REDACTED, mentions: '[]', state: null }, 'what the operator said goes with the entry’s words');
    assert.deepEqual(comment(asked.body.id), { body: REDACTED, mentions: '[]', state: 'closed' });

    // Released, the hold keeps it no longer: the next run takes it, though the entry itself is done.
    app.ctx.db.prepare('UPDATE legal_holds SET released_at = ?, released_by = ?').run(new Date().toISOString(), op.id);
    const next = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id }).lines.find((l) => l.record_type === 'activities')!;
    assert.deepEqual([next.eligible, next.acted, next.discussions], [0, 0, 1]);
    assert.equal(comment(said.body.id).body, REDACTED);
  } finally { await app.close(); }
});

test('a record anonymized before its discussion went with its words has the discussion taken at the next run, and a run with nothing left changes nothing', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const rivera = await app.register('rivera');
    await enroll(app, op.token, 'G8', rivera.id);
    const db = app.ctx.db;
    const at = longAgo(800);
    // As a run before migration 038 left them: the entries anonymized, what was said on them as it was said.
    const anonymized = db.prepare("INSERT INTO activities (id, user_id, unit_id, visibility, date, title, result, notes, created_at, updated_at) VALUES (?, ?, 'G8', 'unit', ?, ?, ?, ?, ?, ?)");
    anonymized.run('a-op', op.id, daysAgo(900), REDACTED, REDACTED, REDACTED, at, at);
    anonymized.run('a-rivera', rivera.id, daysAgo(900), REDACTED, REDACTED, REDACTED, at, at);
    const say = db.prepare("INSERT INTO comments (id, record_table, record_id, author_id, unit_id, body, mentions, kind, addressee_id, state, created_at) VALUES (?, 'activities', ?, ?, 'G8', ?, ?, ?, ?, ?, ?)");
    say.run('k-op', 'a-op', op.id, 'Words said before the upgrade, @rivera.', JSON.stringify([rivera.id]), 'comment', null, null, at);
    say.run('k-ask', 'a-op', op.id, 'Which vendor was it?', '[]', 'clarification_request', rivera.id, 'open', at);
    say.run('k-on-rivera', 'a-rivera', op.id, 'Words on an entry whose Marine is under a hold.', '[]', 'comment', null, null, at);
    db.prepare("INSERT INTO notifications (id, user_id, kind, title, org_id, entity, entity_id, created_at) VALUES ('n-ask', ?, 'clarification_request', 'A question for you', 'G8', 'activities', 'a-op', ?)").run(rivera.id, at);
    placeHold(app.ctx, 'G8', { scope: 'user', subject_id: rivera.id, reason: 'Personnel action' }, op.id);
    // What the held person said on an entry that is not theirs is kept by the hold, and is no work left for a run.
    say.run('k-rivera', 'a-op', rivera.id, 'What the held Marine said.', '[]', 'comment', null, null, at);
    saveSchedule(app.ctx, 'G8', { record_type: 'activities', retain_days: 365, disposition: 'anonymize', enabled: true }, op.id);
    const comments = () => db.prepare('SELECT id, body, mentions, state FROM comments ORDER BY id').all().map((r) => ({ ...(r as object) }));
    const runs = () => (db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'disposition_run'").get() as { n: number }).n;
    const before = comments();

    const preview = runDisposition(app.ctx, { orgId: 'G8', dryRun: true, actorId: op.id }).lines.find((l) => l.record_type === 'activities')!;
    assert.deepEqual([preview.eligible, preview.acted, preview.discussions], [0, 0, 1], 'a preview names the discussion it would take');
    assert.deepEqual(comments(), before, 'and takes nothing');
    // The console asks for its preview over the route, and offers a run only when the preview names work for one.
    const shown = await app.call('POST', '/api/orgs/G8/retention/run', { token: op.token });
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.equal(shown.body.lines.find((l: { record_type: string }) => l.record_type === 'activities').discussions, 1);
    assert.deepEqual(comments(), before);

    const applied = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id }).lines.find((l) => l.record_type === 'activities')!;
    assert.deepEqual([applied.eligible, applied.acted, applied.held, applied.discussions], [0, 0, 1, 1]);
    assert.deepEqual(comments(), [
      { id: 'k-ask', body: REDACTED, mentions: '[]', state: 'closed' },
      { id: 'k-on-rivera', body: 'Words on an entry whose Marine is under a hold.', mentions: '[]', state: null },
      { id: 'k-op', body: REDACTED, mentions: '[]', state: null },
      { id: 'k-rivera', body: 'What the held Marine said.', mentions: '[]', state: null },
    ], 'words said before the upgrade used to stay for good');
    assert.equal(db.prepare("SELECT 1 FROM notifications WHERE id = 'n-ask'").get(), undefined, 'its notices go');
    assert.equal(runs(), 1, 'the run is audited');
    assert.match((db.prepare("SELECT detail FROM disposition_runs WHERE record_type = 'activities' AND dry_run = 0").get() as { detail: string }).detail, /discussion on 1 record anonymized earlier redacted/);

    // Nothing is left to take: the next run changes nothing and audits nothing.
    const after = comments();
    const again = runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id }).lines.find((l) => l.record_type === 'activities')!;
    assert.deepEqual([again.eligible, again.acted, again.discussions], [0, 0, undefined]);
    assert.deepEqual(comments(), after);
    assert.equal(runs(), 1);
  } finally { await app.close(); }
});
