import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';
import { scopeFor } from '../../server/authz/scope.ts';
import { canRead, type RecordRow } from '../../server/authz/records.ts';
import { DUTY_COUNTED, dutyListWhere, dutyPageSql, dutyListQuery } from '../../server/services/duties.ts';

/**
 * The Duty page a page at a time. Each tab holds only duty its reader may read, decided in SQL before a page
 * is cut, and goes on from a cursor with nothing left out or shown twice. The totals and the tab counts come from all of
 * the reader's duty, never from the page they have open. A page is audited as the Marines on it, and is read in the order
 * of an index rather than sorted.
 */

let app: TestApp;
let op: { token: string; id: string };
/** Reads the shared records of section A, and reviews duty there; section B, beside it, is not theirs to read. */
let sgt: { token: string; id: string };
/** Marines of section A. */
const a: Array<{ token: string; id: string }> = [];
/** A Marine of section B. */
let b: { token: string; id: string };
/** Leads another Unit Instance. */
let g1: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const at = '2026-01-05T00:00:00.000Z';
let seq = 0;

/** A duty as the database holds it, put there directly so a test can say exactly when it was stood and recorded. */
function stood(userId: string, unitId: string, date: string, over: { start?: string; created?: string; id?: string; status?: 'pending' | 'approved' | 'returned' | 'rejected'; recordedBy?: string; deleted?: boolean; hours?: number; points?: number | null; approved?: number | null } = {}) {
  const id = over.id ?? `pg-${String(seq++).padStart(5, '0')}`;
  const status = over.status ?? 'pending';
  const decided = status !== 'pending';
  app.ctx.db.prepare(`INSERT INTO duties (id, user_id, unit_id, duty_type_id, date, start_time, end_date, end_time, hours, days, recorded_by, submitted_at, approval_status, reviewed_by, reviewed_at, review_reason,
      approved_points, calculated_points, deleted_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '23:30', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, userId, unitId, unitId === 'G1' ? 'pg-g1' : 'pg-g8', date, over.start ?? '08:00', date, over.hours ?? 8, over.recordedBy ?? userId, at, status, decided ? op.id : null, decided ? at : null,
      status === 'returned' || status === 'rejected' ? 'Because.' : null, status === 'approved' ? (over.approved ?? 3) : null, over.points === undefined ? 3 : over.points, over.deleted ? at : null, over.created ?? at, at);
  return id;
}

const dutyRows = () => app.ctx.db.prepare('SELECT * FROM duties WHERE deleted_at IS NULL').all() as Array<RecordRow & Record<string, string>>;
const newestFirst = (x: Record<string, string>, y: Record<string, string>) => [y.date, y.start_time, y.created_at, y.id].join('|') < [x.date, x.start_time, x.created_at, x.id].join('|') ? -1 : 1;
/** What a tab should hold, worked out from every row by canRead, the rule readableClause puts in SQL. */
function truth(userId: string, keep: (r: Record<string, string>) => boolean) {
  const scope = scopeFor(app.ctx, { id: userId });
  return dutyRows().filter((r) => canRead(scope, userId, r) && keep(r)).sort(newestFirst).map((r) => r.id);
}

/** Every page of a tab, following `next` until it is null. */
async function walk(token: string, query: string) {
  const pages: Array<{ duties: Array<Record<string, any>>; next: string | null; total?: number; total_more?: boolean }> = [];
  let cursor: string | null = null;
  do {
    const res = await get(token, `/api/record/duty/list?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    pages.push(res.body);
    cursor = res.body.next;
    assert.ok(pages.length < 200, 'the walk ends');
  } while (cursor);
  return pages;
}

const auditCount = (actor: string) => (app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? AND action = 'list_records' AND entity = 'duties'").get(actor) as { n: number }).n;

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  const setup = await app.setupOperator();
  op = { token: setup.token, id: setup.id };
  const db = app.ctx.db;
  const unit = db.prepare(`INSERT INTO units (id, code, name, short_name, parent_id, active, created_at) VALUES (?, ?, ?, ?, 'G8', 1, ?)`);
  unit.run('PGA', 'PGA', 'Section Alpha', 'Alpha', at);
  unit.run('PGB', 'PGB', 'Section Bravo', 'Bravo', at);
  unit.run('PGC', 'PGC', 'Section Charlie', 'Charlie', at);
  sgt = await app.register('pgsgt', { rank_id: 'Sgt', last_name: 'Ortiz' });
  await enroll(app, op.token, 'PGA', sgt.id);
  db.prepare(`INSERT INTO roles (id, unit_id, key, name, permissions, position, created_at) VALUES ('PGA:reader', 'PGA', 'reader', 'Section reader', ?, 5, ?)`).run(PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.REVIEW_DUTY | PERMISSIONS.COUNSEL, at);
  db.prepare(`INSERT INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, 'PGA:reader', 'PGA', ?, ?)`).run(sgt.id, op.id, at);
  for (let i = 0; i < 3; i++) { const m = await app.register(`pga${i}`, { last_name: `Alpha${i}` }); await enroll(app, op.token, 'PGA', m.id); a.push(m); }
  b = await app.register('pgb0', { last_name: 'Bravo' });
  await enroll(app, op.token, 'PGB', b.id);
  const lead = await app.register('pgg1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: lead.id })).status, 201);
  g1 = { id: lead.id, token: (await app.login('pgg1lead')).body.token };
  const type = db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)');
  type.run('pg-g8', 'G8', 'DNCO', 'Duty NCO', at, at);
  type.run('pg-g1', 'G1', 'DNCO', 'G-1 Duty NCO', at, at);

  // Interleaved by day, and the newest of all where the sergeant may not read: section B, and another Unit Instance.
  for (let d = 0; d < 6; d++) {
    const day = `2026-03-${String(20 - d * 2).padStart(2, '0')}`;
    stood(b.id, 'PGB', day, { start: '10:00' });
    stood(g1.id, 'G1', day, { start: '10:00' });
    stood(a[d % 3].id, 'PGA', day);
    stood(a[(d + 1) % 3].id, 'PGA', `2026-03-${String(19 - d * 2).padStart(2, '0')}`, { status: d % 2 ? 'approved' : 'pending' });
  }
  // Two alike to the minute and the moment they were recorded: the id breaks the tie, so a page boundary between them
  // neither skips nor repeats one.
  stood(a[0].id, 'PGA', '2026-03-10', { start: '12:00', created: '2026-03-10T13:00:00.000Z', id: 'pg-tie-1' });
  stood(a[1].id, 'PGA', '2026-03-10', { start: '12:00', created: '2026-03-10T13:00:00.000Z', id: 'pg-tie-2' });
  // Deleted: in nobody's list.
  stood(a[2].id, 'PGA', '2026-03-21', { deleted: true });
  // The sergeant's own, and one they recorded for a Marine of section A.
  stood(sgt.id, 'PGA', '2026-03-01', { status: 'approved', approved: 4, hours: 12 });
  stood(sgt.id, 'PGA', '2026-02-01', { status: 'returned', points: 2, hours: 6 });
  stood(sgt.id, 'PGA', '2026-01-15', { points: null, hours: 2.5 });
  stood(a[0].id, 'PGA', '2026-02-11', { recordedBy: sgt.id });
});
after(async () => { await app.close(); });

test('a tab holds only what its reader may read, decided before the page is cut, and the pages walk it whole', async () => {
  const expected = truth(sgt.id, (r) => r.user_id !== sgt.id);
  assert.ok(expected.length >= 10, 'enough to page');
  assert.ok(!expected.some((id) => dutyRows().find((r) => r.id === id)!.unit_id !== 'PGA'), 'the fixture reads section A alone');
  const pages = await walk(sgt.token, 'who=units&limit=2');
  for (const page of pages.slice(0, -1)) assert.equal(page.duties.length, 2, 'every page but the last is full');
  assert.ok(pages.at(-1)!.duties.length >= 1 && pages.at(-1)!.duties.length <= 2);
  assert.equal(pages.at(-1)!.next, null);
  const ids = pages.flatMap((p) => p.duties.map((d) => d.id));
  assert.deepEqual(ids, expected, 'newest first, nothing left out, nothing twice');
  assert.equal(new Set(ids).size, ids.length);
  const units = new Set(pages.flatMap((p) => p.duties.map((d) => d.unit_id)));
  assert.deepEqual([...units], ['PGA'], 'never section B nor another Unit Instance');
  assert.ok(ids.indexOf('pg-tie-2') === ids.indexOf('pg-tie-1') - 1, 'a tie is broken by id');
  // The first page says how many the tab holds; the later ones do not count again.
  assert.deepEqual([pages[0].total, pages[0].total_more], [expected.length, false]);
  assert.equal(pages[1].total, undefined);
  // Each duty carries what the list shows beside it.
  const first = pages[0].duties[0];
  assert.equal(first.duty_type_name, 'Duty NCO');
  assert.ok(first.subject_name, 'whose it is, to anyone but them');
  assert.ok(first.review && typeof first.review.approve === 'boolean');

  // Their own tab, and what they recorded for a Marine.
  const mine = (await walk(sgt.token, 'who=mine&limit=50')).flatMap((p) => p.duties.map((d) => d.id));
  assert.deepEqual(mine, truth(sgt.id, (r) => r.user_id === sgt.id));
  const recorded = (await walk(sgt.token, 'who=recorded')).flatMap((p) => p.duties.map((d) => d.id));
  assert.deepEqual(recorded, truth(sgt.id, (r) => r.user_id !== sgt.id && r.recorded_by === sgt.id));
  assert.equal(recorded.length, 1);

  // Another Unit Instance's lead reads none of it; a Marine of section B reads only their own.
  const across = await walk(g1.token, 'who=units');
  assert.ok(!across.flatMap((p) => p.duties).some((d) => d.unit_id !== 'G1'), 'only their own instance’s duty');
  assert.deepEqual((await walk(b.token, 'who=units')).flatMap((p) => p.duties), []);
  assert.equal((await walk(b.token, 'who=mine')).flatMap((p) => p.duties).length, 6);
});

test('the filters narrow a tab and never widen it', async () => {
  const pending = (await walk(sgt.token, 'who=units&status=pending')).flatMap((p) => p.duties);
  assert.deepEqual(pending.map((d) => d.id), truth(sgt.id, (r) => r.user_id !== sgt.id && r.approval_status === 'pending'));
  const march = (await walk(sgt.token, 'who=units&from=2026-03-15&to=2026-03-31')).flatMap((p) => p.duties);
  assert.deepEqual(march.map((d) => d.id), truth(sgt.id, (r) => r.user_id !== sgt.id && r.date >= '2026-03-15' && r.date <= '2026-03-31'));
  // Asking for a unit one does not read gives nothing of it.
  assert.deepEqual((await walk(sgt.token, 'who=units&unit_id=PGB')).flatMap((p) => p.duties), []);
  assert.deepEqual((await walk(sgt.token, 'who=units&unit_id=G1')).flatMap((p) => p.duties), []);
  const first = await get(sgt.token, '/api/record/duty/list?who=units&unit_id=PGB');
  assert.deepEqual([first.body.total, first.body.next], [0, null]);
});

test('a page asks within bounds: its size, its tab, its dates and its cursor', async () => {
  for (const q of ['limit=1000', 'limit=0', 'limit=abc', 'who=everyone', 'from=2026-02-30', 'to=yesterday', 'status=lost', `cursor=${'x'.repeat(500)}`]) {
    const res = await get(sgt.token, `/api/record/duty/list?${q}`);
    assert.equal(res.status, 400, `${q}: ${JSON.stringify(res.body)}`);
  }
  const torn = await get(sgt.token, `/api/record/duty/list?who=units&cursor=${Buffer.from('2026-03-01|08:00').toString('base64url')}`);
  assert.equal(torn.status, 400);
  assert.ok(torn.body.fieldErrors.cursor);
  assert.equal((await get(sgt.token, '/api/record/duty/list?limit=100')).status, 200);
  assert.equal((await app.call('GET', '/api/record/duty/list')).status, 401);
  // Fifty at most unless asked for fewer.
  assert.equal(dutyListQuery.parse({}).limit, 50);
});

test('the totals and tab counts are of all the reader’s duty, whatever the page holds, and only of what they read', async () => {
  const summary = await get(sgt.token, '/api/record/duty/summary');
  assert.equal(summary.status, 200, JSON.stringify(summary.body));
  const own = app.ctx.db.prepare(`SELECT COUNT(*) AS duties, SUM(hours) AS hours, SUM(COALESCE(calculated_points, 0)) AS calculated_points,
      SUM(CASE WHEN approval_status = 'approved' THEN approved_points ELSE 0 END) AS approved_points,
      SUM(approval_status = 'pending') AS pending, SUM(approval_status = 'returned') AS returned FROM duties WHERE user_id = ? AND deleted_at IS NULL`).get(sgt.id);
  assert.deepEqual(summary.body.mine, own);
  assert.deepEqual(summary.body.mine, { duties: 3, hours: 20.5, calculated_points: 5, approved_points: 4, pending: 1, returned: 1 });
  const units = truth(sgt.id, (r) => r.user_id !== sgt.id).length;
  assert.deepEqual(summary.body.tabs, { mine: 3, recorded: 1, units, units_more: false });
  assert.deepEqual(summary.body.units.map((u: { id: string }) => u.id), ['PGA'], 'the units its lists narrow to');
  // Another instance's lead: nothing of G-8 is counted.
  const across = await get(g1.token, '/api/record/duty/summary');
  assert.equal(across.body.tabs.units, truth(g1.id, (r) => r.user_id !== g1.id).length);
  assert.ok(!across.body.units.some((u: { id: string }) => u.id.startsWith('PG') || u.id === 'G8'));
});

test('Yours adds up every duty of the reader’s, even where the old list was cut short by others’ newer duty', async () => {
  const capped = await startApp({ VANTAGE_MAX_RECORDS_PER_USER: '10' });
  try {
    const lead = await capped.setupOperator();
    const db = capped.ctx.db;
    db.prepare("INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES ('cap-dnco', 'G8', 'DNCO', 'Duty NCO', NULL, 1, ?, ?)").run(at, at);
    const put = (userId: string, date: string, status: 'approved' | 'pending', points: number) => db.prepare(`INSERT INTO duties (id, user_id, unit_id, duty_type_id, date, start_time, end_date, end_time, hours, days, recorded_by, submitted_at, approval_status, reviewed_by, reviewed_at, approved_points, calculated_points, created_at, updated_at)
      VALUES (?, ?, 'G8', 'cap-dnco', ?, '08:00', ?, '20:00', 12, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`cap-${seq++}`, userId, date, date, userId, at, status, status === 'approved' ? lead.id : null, status === 'approved' ? at : null, status === 'approved' ? points : null, points, at, at);
    const marines: string[] = [];
    for (let i = 0; i < 5; i++) { const m = await capped.register(`capm${i}`); await enroll(capped, lead.token, 'G8', m.id); marines.push(m.id); }
    // Three of the leader's own, old; twelve of their Marines', newer.
    put(lead.id, '2025-06-01', 'approved', 3); put(lead.id, '2025-06-08', 'approved', 3); put(lead.id, '2025-06-15', 'pending', 3);
    for (let i = 0; i < 12; i++) put(marines[i % 5], `2026-02-${String(i + 10).padStart(2, '0')}`, 'pending', 1);
    // The whole list used to fill its cap with the newest duty, so the leader's own were not on it: what the page used to
    // add up. It now keeps the reader's own first and says it was cut (ADR-0037); Yours never read it either way.
    const old = await capped.call('GET', '/api/records/duties', { token: lead.token });
    assert.equal(old.body.length, 10);
    assert.equal(old.body.filter((r: { user_id: string }) => r.user_id === lead.id).length, 3, 'the reader’s own are kept');
    assert.equal(old.headers.get('x-vantage-rows'), '10/15');
    const summary = await capped.call('GET', '/api/record/duty/summary', { token: lead.token });
    assert.deepEqual(summary.body.mine, { duties: 3, hours: 36, calculated_points: 9, approved_points: 6, pending: 1, returned: 0 });
    assert.deepEqual(summary.body.tabs, { mine: 3, recorded: 0, units: 12, units_more: false });
    const mine = await capped.call('GET', '/api/record/duty/list?who=mine', { token: lead.token });
    assert.equal(mine.body.duties.length, 3);
    assert.equal(mine.body.total, 3);
  } finally { await capped.close(); }
});

test('a page is audited as the Marines on it, once each in five minutes, whatever lies past it', async () => {
  const marines: string[] = [];
  for (let i = 0; i < 5; i++) { const m = await app.register(`pgc${i}`); await enroll(app, op.token, 'PGC', m.id); marines.push(m.id); stood(m.id, 'PGC', `2026-04-0${i + 1}`); }
  const before = auditCount(op.id);
  const first = await get(op.token, '/api/record/duty/list?who=units&unit_id=PGC&limit=2');
  assert.equal(first.body.duties.length, 2);
  assert.equal(auditCount(op.id) - before, 2, 'the two Marines on the page');
  const second = await get(op.token, `/api/record/duty/list?who=units&unit_id=PGC&limit=2&cursor=${encodeURIComponent(first.body.next)}`);
  assert.equal(second.body.duties.length, 2);
  assert.equal(auditCount(op.id) - before, 4);
  await get(op.token, '/api/record/duty/list?who=units&unit_id=PGC&limit=2');
  assert.equal(auditCount(op.id) - before, 4, 'the same page again within five minutes is not audited again');
  const entry = app.ctx.db.prepare("SELECT detail, subject_id, unit_id FROM audit_log WHERE actor_id = ? AND action = 'list_records' ORDER BY seq DESC LIMIT 1").get(op.id) as Record<string, string>;
  assert.deepEqual([entry.detail, entry.unit_id], ['1 rows', 'PGC']);
  // The summary names nobody, so it audits nothing.
  await get(op.token, '/api/record/duty/summary');
  assert.equal(auditCount(op.id) - before, 4);
});

test('a page reads a fixed number of statements however many Marines are on it', async () => {
  const db = app.ctx.db;
  for (let i = 0; i < 40; i++) {
    const id = `pg-user-${i}`;
    db.prepare(`INSERT INTO users (id, username, password_hash, first_name, last_name, rank_id, created_at, updated_at) VALUES (?, ?, 'x', 'Delta', ?, 'LCpl', ?, ?)`).run(id, `pgd${i}`, `Delta${i}`, at, at);
    db.prepare('INSERT INTO unit_members (user_id, unit_id, is_primary, joined_at) VALUES (?, ?, 1, ?)').run(id, 'PGC', at);
    stood(id, 'PGC', `2026-05-${String((i % 28) + 1).padStart(2, '0')}`);
  }
  const prepare = db.prepare;
  const count = async (limit: number) => {
    await get(op.token, `/api/record/duty/list?who=units&unit_id=PGC&limit=${limit}`);
    let n = 0;
    db.prepare = ((sql: string) => { n += 1; return prepare.call(db, sql); }) as typeof db.prepare;
    try { await get(op.token, `/api/record/duty/list?who=units&unit_id=PGC&limit=${limit}`); } finally { db.prepare = prepare; }
    return n;
  };
  const few = await count(5);
  const many = await count(40);
  assert.ok(few >= 4, `counted ${few}`);
  assert.equal(many, few, `a page of 40 read ${many} statements, a page of 5 read ${few}`);
  assert.ok(many <= 25, `a page read ${many} statements`);
});

test('the review queue narrows to a unit its reader reviews, and to nothing else', async () => {
  const all = await get(sgt.token, '/api/record/duty/review-queue');
  assert.equal(all.status, 200);
  assert.ok(all.body.items.length > 0);
  assert.ok(all.body.items.every((i: { unit_id: string }) => i.unit_id === 'PGA'));
  const one = await get(sgt.token, '/api/record/duty/review-queue?unit_id=PGA');
  assert.deepEqual(one.body.items.map((i: { id: string }) => i.id), all.body.items.map((i: { id: string }) => i.id));
  assert.equal(one.body.total, all.body.total);
  for (const unit of ['PGB', 'G1', 'nowhere']) {
    const none = await get(sgt.token, `/api/record/duty/review-queue?unit_id=${unit}`);
    assert.deepEqual([none.body.items, none.body.total, none.body.reviewer], [[], 0, true], unit);
  }
  // A reviewer of more than one unit narrows to one of them, and the counts of each stay with it.
  const lead = await get(op.token, '/api/record/duty/review-queue?unit_id=PGB');
  assert.ok(lead.body.items.length > 0 && lead.body.items.every((i: { unit_id: string }) => i.unit_id === 'PGB'));
  assert.ok(lead.body.units.length > 1, 'every unit it waits in, for the filter');
  assert.equal(lead.body.total, lead.body.units.find((u: { id: string }) => u.id === 'PGB').count);
});

test('a page of several units is read in the order of idx_duties_live_order, never sorted, at any depth', async () => {
  // Enough duty for the planner to weigh, and its statistics, as the server's PRAGMA optimize leaves a live database.
  const db = app.ctx.db;
  db.transaction(() => {
    for (let i = 0; i < 1500; i++) stood(a[i % 3].id, ['PGA', 'PGB', 'PGC'][i % 3], `2025-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, { start: `${String(i % 24).padStart(2, '0')}:00` });
    for (let i = 0; i < 100; i++) stood(g1.id, 'G1', `2025-${String((i % 12) + 1).padStart(2, '0')}-01`);
  })();
  db.exec('ANALYZE');
  const plan = (sql: string, params: unknown[]) => (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail);
  const scope = scopeFor(app.ctx, { id: op.id });
  assert.ok(scope.readableUnitIds.length >= 4, 'the Unit Leader reads every section');
  const first = dutyPageSql(app.ctx, op.id, scope, dutyListQuery.parse({ who: 'units' }));
  const firstPlan = plan(first.sql, first.params);
  assert.ok(firstPlan.some((d) => d.includes('idx_duties_live_order')), firstPlan.join('\n'));
  assert.ok(!firstPlan.some((d) => d.includes('TEMP B-TREE')), firstPlan.join('\n'));
  // A page far down, by its cursor: a search into the same index, not a sort and not an offset.
  const rows = db.prepare(first.sql).all(...first.params) as Array<Record<string, string>>;
  const cursor = Buffer.from([rows[49].date, rows[49].start_time, rows[49].created_at, rows[49].id].join('|')).toString('base64url');
  const deep = dutyPageSql(app.ctx, op.id, scope, dutyListQuery.parse({ who: 'units', cursor }));
  const deepPlan = plan(deep.sql, deep.params);
  assert.ok(deepPlan.some((d) => d.includes('idx_duties_live_order') && d.includes('(date,start_time,created_at,id)<')), deepPlan.join('\n'));
  assert.ok(!deepPlan.some((d) => d.includes('TEMP B-TREE')), deepPlan.join('\n'));
  // Whatever the planner picks for one section, it searches an index and never reads the whole table.
  const one = dutyPageSql(app.ctx, sgt.id, scopeFor(app.ctx, { id: sgt.id }), dutyListQuery.parse({ who: 'units' }));
  const onePlan = plan(one.sql, one.params);
  assert.ok(!onePlan.some((d) => /^SCAN t$/.test(d)), onePlan.join('\n'));
  // The counts: one's own by idx_duties_user, a page's size bounded at DUTY_COUNTED.
  const own = dutyListWhere(app.ctx, sgt.id, scopeFor(app.ctx, { id: sgt.id }), { who: 'mine' });
  assert.ok(plan(`SELECT COUNT(*) FROM duties t WHERE ${own.where.join(' AND ')}`, own.params).some((d) => d.includes('idx_duties_user')));
  const summary = await get(op.token, '/api/record/duty/summary');
  assert.deepEqual([summary.body.tabs.units, summary.body.tabs.units_more], [DUTY_COUNTED, true], 'counted up to the cap, and said to be more');
  const page = await get(op.token, '/api/record/duty/list?who=units');
  assert.deepEqual([page.body.total, page.body.total_more, page.body.duties.length], [DUTY_COUNTED, true, 50]);
});
