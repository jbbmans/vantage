import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { hydrate } from '../../server/services/records.ts';
import { REPORT_ACTIVITY_COLUMNS } from '../../server/services/reports.ts';
import { SOURCE_LIMIT } from '../../server/services/reportStudio.ts';
import { zonedNow } from '../../server/lib/clock.ts';
import { comparePeriods } from '../../shared/delta.ts';
import { areasFor } from '../../shared/evaluation.ts';
import { dayKey, previousRange, rangeForPeriod } from '../../shared/metrics.ts';

/**
 * Report Studio and the record report at scale (ADR-0032): what a package may cite is decided before the list
 * is cut, the package list pages by a cursor, and the record report and its comparison read only what they use.
 */

let app: TestApp;
let op: { token: string; id: string };
let g1lead: { token: string; id: string };
let reyes: { token: string; id: string };
let dual: { token: string; id: string };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const get = (token: string, path: string) => app.call('GET', path, { token });
const login = async (username: string) => (await app.login(username)).body.token as string;
const db = () => app.ctx.db;

async function draft(token: string, overrides: Record<string, unknown> = {}) {
  const res = await post(token, '/api/studio/reports', { title: 'Quarterly input', period_start: day(-30), period_end: day(1), ...overrides });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string };
}

/** Activities written straight to the table, in one transaction, for a subject. */
function activities(rows: Array<{ id: string; user: string; unit: string | null; visibility: 'private' | 'unit'; date: string; title?: string; extra?: Record<string, unknown> }>) {
  const at = new Date().toISOString();
  db().transaction(() => {
    for (const r of rows) {
      const cols = { id: r.id, user_id: r.user, unit_id: r.unit, visibility: r.visibility, date: r.date, title: r.title ?? r.id, created_at: at, updated_at: at, ...(r.extra || {}) };
      const keys = Object.keys(cols);
      db().prepare(`INSERT INTO activities (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...Object.values(cols));
    }
  })();
}

/** Every statement prepared while `work` runs, so a test can count them or read a plan. */
async function preparedDuring<T>(work: () => Promise<T>): Promise<{ result: T; sql: string[] }> {
  const raw = db();
  const prepare = raw.prepare;
  const sql: string[] = [];
  raw.prepare = ((text: string) => { sql.push(text); return prepare.call(raw, text); }) as typeof raw.prepare;
  try { return { result: await work(), sql }; } finally { raw.prepare = prepare; }
}

const planOf = (sql: string) => {
  const marks = (sql.match(/\?/g) || []).length;
  return (db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array.from({ length: marks }, () => 'x')) as Array<{ detail: string }>).map((r) => r.detail);
};

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  g1lead = await app.register('g1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('g1lead');
  // A leader in both Unit Instances, and a Marine who serves in both.
  reyes = await app.register('reyes');
  await enroll(app, op.token, 'G8', reyes.id, 'sncoic');
  await enroll(app, g1lead.token, 'G1', reyes.id, 'sncoic');
  reyes.token = await login('reyes');
  dual = await app.register('dual');
  await enroll(app, op.token, 'G8', dual.id);
  await enroll(app, g1lead.token, 'G1', dual.id);
  dual.token = await login('dual');
});
after(async () => { await app.close(); });

test('RPT-1: a leader still gets the records they may cite when the Marine has more than 400 they may not', async () => {
  const subject = await app.register('crowded');
  await enroll(app, op.token, 'G8', subject.id);
  const privateIds = Array.from({ length: SOURCE_LIMIT + 1 }, (_, i) => `rpt1-private-${i}`);
  activities([
    ...privateIds.map((id) => ({ id, user: subject.id, unit: 'G8', visibility: 'private' as const, date: day(-2) })),
    { id: 'rpt1-shared', user: subject.id, unit: 'G8', visibility: 'unit', date: day(-20) },
  ]);
  try {
    const report = await draft(op.token, { subject_id: subject.id, unit_id: 'G8', visibility: 'unit' });
    const { result: opened, sql } = await preparedDuring(() => get(op.token, `/api/studio/reports/${report.id}`));
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const ids = (opened.body.sources as Array<{ id: string }>).map((s) => s.id);
    assert.ok(ids.includes('rpt1-shared'), 'the shared record behind 401 newer private ones is offered');
    // Who may read each is decided in the read on the subject's dated index, not over a scan of every entry.
    const plan = planOf(sql.find((s) => /^SELECT t\.\* FROM activities t WHERE t\.user_id = \?/.test(s))!);
    assert.ok(plan.some((d) => /^SEARCH t USING INDEX idx_activities_user_date \(user_id=\? AND date>\? AND date<\?\)/.test(d)), plan.join('\n'));
    assert.ok(!plan.some((d) => /^SCAN t\b/.test(d)), plan.join('\n'));
    assert.equal(ids.filter((id) => id.startsWith('rpt1-private-')).length, 0, 'no private record of theirs is offered to the leader');

    // About themselves, every record is theirs to cite: the newest 400, as before.
    const own = await draft(subject.token);
    const mine = (await get(subject.token, `/api/studio/reports/${own.id}`)).body.sources as Array<{ id: string; date: string }>;
    assert.equal(mine.length, SOURCE_LIMIT);
    assert.ok(mine.every((s) => s.id.startsWith('rpt1-private-')), 'the newest of their own records');
  } finally {
    db().prepare("DELETE FROM activities WHERE id LIKE 'rpt1-%'").run();
  }
});

test('RPT-1: a package placed in one Unit Instance offers its records past 401 newer ones from another', async () => {
  activities([
    ...Array.from({ length: SOURCE_LIMIT + 1 }, (_, i) => ({ id: `rpt1-g1-${i}`, user: dual.id, unit: 'G1', visibility: 'unit' as const, date: day(-2) })),
    { id: 'rpt1-g8', user: dual.id, unit: 'G8', visibility: 'unit', date: day(-20) },
  ]);
  try {
    const report = await draft(reyes.token, { subject_id: dual.id, unit_id: 'G8', visibility: 'unit' });
    const opened = await get(reyes.token, `/api/studio/reports/${report.id}`);
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const ids = (opened.body.sources as Array<{ id: string }>).map((s) => s.id);
    assert.deepEqual(ids, ['rpt1-g8'], 'the G8 record, and nothing of G1’s');
    // The same reader, placed in G1, gets G1's newest 400 and nothing of G8's.
    const there = await draft(reyes.token, { subject_id: dual.id, unit_id: 'G1', visibility: 'unit' });
    const theirs = ((await get(reyes.token, `/api/studio/reports/${there.id}`)).body.sources as Array<{ id: string }>).map((s) => s.id);
    assert.equal(theirs.length, SOURCE_LIMIT);
    assert.ok(theirs.every((id) => id.startsWith('rpt1-g1-')));
  } finally {
    db().prepare("DELETE FROM activities WHERE id LIKE 'rpt1-%'").run();
  }
});

test('RPT-14: the package list pages by a cursor, newest first, with only packages one may open', async () => {
  const pager = await app.register('pager');
  await enroll(app, op.token, 'G8', pager.id);
  const mine: string[] = [];
  for (let i = 0; i < 101; i++) mine.push((await draft(pager.token, { title: `Package ${i}` })).id);
  // Every one changed in the same instant, so the page break falls between equal times and is kept by id.
  db().prepare('UPDATE report_drafts SET updated_at = ? WHERE user_id = ?').run('2026-11-01T00:00:00.000Z', pager.id);
  const hidden = (await draft(op.token, { title: 'The operator’s own' })).id;

  const first = await get(pager.token, '/api/studio/reports');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.drafts.length, 100);
  assert.equal(typeof first.body.next_cursor, 'string');
  const { result: second, sql } = await preparedDuring(() => get(pager.token, `/api/studio/reports?before=${encodeURIComponent(first.body.next_cursor)}`));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.drafts.length, 1);
  assert.equal(second.body.next_cursor, null);
  const seen = [...first.body.drafts, ...second.body.drafts].map((d: { id: string }) => d.id);
  assert.equal(new Set(seen).size, 101, 'no package twice');
  assert.deepEqual([...seen].sort(), [...mine].sort(), 'every one of theirs, and nobody else’s');
  assert.ok(!seen.includes(hidden));
  assert.deepEqual(seen, [...seen].sort().reverse(), 'equal times run by id, newest id first');

  assert.equal((await get(pager.token, '/api/studio/reports?before=not-a-page')).status, 400);

  // Whom each is open to is decided by the indexes on its author, its subject and its unit, never a scan of every package.
  const list = sql.find((s) => /FROM report_drafts/.test(s) && /ORDER BY updated_at DESC, id DESC/.test(s));
  assert.ok(list, 'the list read was seen');
  const plan = planOf(list!);
  for (const index of ['idx_report_drafts_user', 'idx_report_drafts_subject', 'idx_report_drafts_unit']) assert.ok(plan.some((d) => d.includes(index)), `${index} in\n${plan.join('\n')}`);
  assert.ok(!plan.some((d) => /^SCAN report_drafts\b/.test(d)), plan.join('\n'));
});

test('RPT-15: opening and saving a package citing 400 records reads them a table at a time', async () => {
  const ids = Array.from({ length: SOURCE_LIMIT }, (_, i) => `rpt15-${i}`);
  activities(ids.map((id) => ({ id, user: op.id, unit: null, visibility: 'private' as const, date: day(-3) })));
  try {
    const report = await draft(op.token);
    const sources = ids.map((id) => ({ table: 'activities', id, version: 1 }));
    const { result: saved, sql: saving } = await preparedDuring(() => post(op.token, `/api/studio/reports/${report.id}/revisions`, { sections: [{ heading: 'Mission', body: 'Four hundred entries.' }], sources }));
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.revision.source_snapshots.length, SOURCE_LIMIT);
    // One read per cited table and a fixed few besides; a read per record was 400 and more.
    assert.ok(saving.length < 60, `saving prepared ${saving.length} statements`);

    // A record that changes after the save is drift, found in the same batched read.
    db().prepare("UPDATE activities SET version = 2, title = 'Changed since' WHERE id = 'rpt15-7'").run();
    const { result: opened, sql: opening } = await preparedDuring(() => get(op.token, `/api/studio/reports/${report.id}`));
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.ok(opening.length < 60, `opening prepared ${opening.length} statements`);
    assert.deepEqual((opened.body.drift as Array<{ id: string }>).map((d) => d.id), ['rpt15-7']);
    assert.ok(!('section_bytes' in opened.body.revisions[0]), 'the revision list carries no unused size');
  } finally {
    db().prepare("DELETE FROM activities WHERE id LIKE 'rpt15-%'").run();
  }
});

test('RPT-7: the comparison reads only the two periods it compares, and says what reading everything said', async () => {
  const who = await app.register('delta', { rank_id: 'Cpl' });
  activities([
    { id: 'rpt7-now-1', user: who.id, unit: null, visibility: 'private', date: day(-5), extra: { category: 'Fiscal & Financial', quantity: 4, dollar_amount: 300, result: 'Closed' } },
    { id: 'rpt7-now-2', user: who.id, unit: null, visibility: 'private', date: day(-40), extra: { category: 'Leadership', eval_area: 'Leadership' } },
    { id: 'rpt7-prior', user: who.id, unit: null, visibility: 'private', date: day(-130), extra: { category: 'Fiscal & Financial', dollar_amount: 50 } },
    { id: 'rpt7-ongoing', user: who.id, unit: null, visibility: 'private', date: day(-400), extra: { ongoing: 1, category: 'Leadership' } },
    { id: 'rpt7-across', user: who.id, unit: null, visibility: 'private', date: day(-200), extra: { end_date: day(-100), quantity: 2 } },
    ...Array.from({ length: 300 }, (_, i) => ({ id: `rpt7-old-${i}`, user: who.id, unit: null, visibility: 'private' as const, date: '2019-03-01', extra: { dollar_amount: 10 } })),
  ]);
  const at = new Date().toISOString();
  const training = db().prepare('INSERT INTO trainings (id, user_id, title, date, end_date, hours, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  training.run('rpt7-t-now', who.id, 'MCI 1', day(-10), null, 3, at, at);
  training.run('rpt7-t-old', who.id, 'MCI 2', '2019-03-01', null, 5, at, at);
  try {
    // What the comparison said when it read every record of theirs, worked out here from all of them.
    const oracle = (track: 'jepes' | 'fitrep') => {
      const range = rangeForPeriod('last90', zonedNow(app.ctx.config.timezone));
      const all = (db().prepare('SELECT * FROM activities WHERE user_id = ? AND deleted_at IS NULL').all(who.id) as Array<Record<string, unknown>>).map((r) => hydrate(r, 'activities')!);
      const awards = db().prepare('SELECT date FROM awards WHERE user_id = ? AND deleted_at IS NULL').all(who.id) as Array<{ date: string | null }>;
      const trainings = db().prepare('SELECT date, end_date, ongoing, hours FROM trainings WHERE user_id = ? AND deleted_at IS NULL').all(who.id) as never;
      const goals = db().prepare('SELECT status FROM goals WHERE user_id = ? AND deleted_at IS NULL').all(who.id) as Array<{ status: string }>;
      return JSON.parse(JSON.stringify(comparePeriods(all as never, range, { areas: areasFor(track), awards, trainings, goals })));
    };
    const { result: byRank, sql } = await preparedDuring(() => get(who.token, '/api/reports/delta?period=last90'));
    assert.equal(byRank.status, 200, JSON.stringify(byRank.body));
    assert.deepEqual(byRank.body, oracle('jepes'));
    const fitrep = await get(who.token, '/api/reports/delta?period=last90&track=fitrep');
    assert.deepEqual(fitrep.body, oracle('fitrep'));

    // The read holds the five records with a day in either period, not the 300 from years before.
    const read = sql.find((s) => /^SELECT \* FROM activities WHERE user_id = \?/.test(s));
    assert.ok(read, 'the activities read was seen');
    const range = rangeForPeriod('last90', zonedNow(app.ctx.config.timezone));
    const held = db().prepare(`SELECT COUNT(*) AS n FROM (${read})`).get(who.id, dayKey(range.end), dayKey(previousRange(range).start)) as { n: number };
    assert.equal(held.n, 5);
    // The track comes from the rank alone: no report is built to find it.
    assert.ok(!sql.some((s) => /FROM awards WHERE .* ORDER BY date DESC/.test(s)), 'no record report was built for its track');
  } finally {
    db().prepare("DELETE FROM activities WHERE id LIKE 'rpt7-%'").run();
    db().prepare("DELETE FROM trainings WHERE id LIKE 'rpt7-%'").run();
  }
});

test('RPT-8: the record report sends the columns of an entry it uses, and not its notes', async () => {
  const who = await app.register('columns');
  activities([{ id: 'rpt8-entry', user: who.id, unit: null, visibility: 'private', date: day(-3), title: 'Reconciled the ledger', extra: { notes: 'N'.repeat(20_000), quantity: 3, unit_label: 'ULOs', result: 'Balanced' } }]);
  try {
    const res = await get(who.token, '/api/reports?period=last90');
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 500));
    assert.equal(res.body.activities.length, 1);
    assert.deepEqual(Object.keys(res.body.activities[0]).sort(), [...REPORT_ACTIVITY_COLUMNS].sort());
    assert.ok(!res.text.includes('N'.repeat(100)), 'the notes stay on the entry’s own page');
    assert.ok(res.text.length < 20_000, `the report was ${res.text.length} bytes`);
    assert.equal(res.body.activities[0].visibility, 'private');
  } finally {
    db().prepare("DELETE FROM activities WHERE id LIKE 'rpt8-%'").run();
  }
});
