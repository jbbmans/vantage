import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { PERMISSIONS } from '../../server/authz/scope.ts';
import { fitText } from '../../server/services/analyticsPdf.ts';

/**
 * Which units a unit's figures read. A role that does not reach the units beneath (position 0) reads its own unit only,
 * on the dashboard, the overview and the report center, as /metrics and the analytics already do; a role that reaches
 * down reads them all. A unit's window is read by the index on the last day each record covers.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person;
/** A position-0 reader at G8, a G8 leader whose role reaches down, a G8 Marine, and two Marines of the team beneath. */
let viewer: Person;
let lead: Person;
let g8m: Person;
const kids: Person[] = [];

const D = today();
const dayAfter = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const FROM = dayAfter(D, -89);
const windowQuery = `from=${FROM}&to=${D}`;
const get = (token: string, path: string) => app.call('GET', path, { token });
const login = async (username: string) => (await app.login(username)).body.token as string;
const share = async (who: Person, path: string, body: Record<string, unknown>) => {
  const res = await app.call('POST', path, { token: who.token, body: { visibility: 'unit', ...body } });
  assert.equal(res.status, 201, `${path}: ${JSON.stringify(res.body)}`);
  return res.body.id as string;
};

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  assert.equal((await app.call('POST', '/api/org/units', { token: op.token, body: { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' } })).status, 201);
  app.ctx.db.prepare("INSERT INTO roles (id, unit_id, key, name, permissions, position, created_at) VALUES ('G8:viewer', 'G8', 'viewer', 'Viewer', ?, 0, ?)")
    .run(PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_MEMBER_DETAIL, new Date().toISOString());
  viewer = await app.register('viewer'); await enroll(app, op.token, 'G8', viewer.id, 'viewer'); viewer.token = await login('viewer');
  lead = await app.register('lead'); await enroll(app, op.token, 'G8', lead.id, 'sncoic'); lead.token = await login('lead');
  g8m = await app.register('g8marine', { last_name: 'Topside' }); await enroll(app, op.token, 'G8', g8m.id); g8m.token = await login('g8marine');
  for (const name of ['kidone', 'kidtwo']) {
    const kid = await app.register(name, { last_name: name === 'kidone' ? 'Belowone' : 'Belowtwo' });
    await enroll(app, op.token, 'FISCAL', kid.id);
    kid.token = await login(name);
    kids.push(kid);
  }
  await share(g8m, '/api/records/activities', { title: 'G8 work', date: dayAfter(D, -3), quantity: 4, unit_label: 'checks', unit_id: 'G8' });
  for (const kid of kids) {
    await share(kid, '/api/records/activities', { title: 'Fiscal work', date: dayAfter(D, -2), quantity: 5, unit_label: 'checks', dollar_amount: 1000, dollar_type: 'obligated', unit_id: 'FISCAL' });
    await share(kid, '/api/records/trainings', { title: 'Fiscal course', date: dayAfter(D, -5), status: 'completed', hours: 3, type: 'course', unit_id: 'FISCAL' });
  }
});
after(async () => { await app?.close(); });

const checksOf = (body: { headline: Array<{ metricId: string; value: number }> }) => body.headline.find((t) => t.metricId === 'quantity:check')?.value ?? 0;

test('a position-0 role at a parent reads only its own unit on the dashboard, as /metrics does; a role that reaches down reads them all', async () => {
  const mine = await get(viewer.token, `/api/org/units/G8/dashboard?${windowQuery}`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.totals.entries, 1, 'the team beneath is not counted');
  assert.equal(mine.body.totals.contributors, 1);
  assert.equal(mine.body.rolls_up, 0);
  assert.deepEqual(mine.body.by_team, [], 'no team beneath is broken out');
  const listed = mine.body.members.map((m: { id: string }) => m.id);
  assert.ok(listed.includes(g8m.id));
  for (const kid of kids) assert.ok(!listed.includes(kid.id), 'a Marine of the team beneath is not listed');
  assert.ok(mine.body.totals.members < 3 + kids.length + 1, 'nor counted as a member');
  const metrics = await get(viewer.token, `/api/metrics?unit_id=G8&${windowQuery}`);
  assert.equal(metrics.status, 200);
  assert.equal(checksOf(metrics.body), 4, '/metrics reads the same units');

  // The regression guard: a role with a position reaches the team beneath, on every surface.
  const all = await get(lead.token, `/api/org/units/G8/dashboard?${windowQuery}`);
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.equal(all.body.totals.entries, 3);
  assert.equal(all.body.totals.contributors, 3);
  assert.equal(all.body.rolls_up, 1);
  assert.deepEqual(all.body.by_team.map((t: { unit_id: string; entries: number }) => [t.unit_id, t.entries]), [['G8', 1], ['FISCAL', 2]]);
  for (const kid of kids) assert.ok(all.body.members.some((m: { id: string }) => m.id === kid.id));
  assert.equal(checksOf((await get(lead.token, `/api/metrics?unit_id=G8&${windowQuery}`)).body), 14);
});

test('open tasks are counted to their holder once each, and only in the units read', async () => {
  const at = new Date().toISOString();
  const task = app.ctx.db.prepare("INSERT INTO tasks (id, user_id, assignee_id, unit_id, visibility, title, status, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, 'unit', 'Task', ?, ?, ?, ?)");
  const late = dayAfter(D, -3); const soon = dayAfter(D, 5);
  task.run('t-open', op.id, g8m.id, 'G8', 'planned', soon, at, at);
  task.run('t-late', op.id, g8m.id, 'G8', 'in_progress', late, at, at);
  task.run('t-own', g8m.id, null, 'G8', 'planned', null, at, at);
  task.run('t-done', op.id, g8m.id, 'G8', 'completed', late, at, at);
  task.run('t-kid', op.id, kids[0].id, 'FISCAL', 'planned', late, at, at);
  const row = (body: { members: Array<{ id: string; open_tasks: number; overdue_tasks: number }> }, id: string) => body.members.find((m) => m.id === id)!;

  const mine = (await get(viewer.token, `/api/org/units/G8/dashboard?${windowQuery}`)).body;
  assert.deepEqual([row(mine, g8m.id).open_tasks, row(mine, g8m.id).overdue_tasks], [3, 1], 'a completed task is not open, a task with no assignee is its author’s');
  assert.equal(mine.totals.overdue_tasks, 1, 'the team beneath is not counted');
  const all = (await get(lead.token, `/api/org/units/G8/dashboard?${windowQuery}`)).body;
  assert.equal(all.totals.overdue_tasks, 2);
  assert.deepEqual([row(all, kids[0].id).open_tasks, row(all, kids[0].id).overdue_tasks], [1, 1]);
  assert.deepEqual([row(all, g8m.id).open_tasks, row(all, g8m.id).overdue_tasks], [3, 1]);
  app.ctx.db.prepare("DELETE FROM tasks WHERE id LIKE 't-%'").run();
});

test('the overview gives a position-0 reader its own unit in full and the team beneath only as any member sees it', async () => {
  const mine = await get(viewer.token, `/api/org/units/G8/overview?${windowQuery}`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal(mine.body.level, 'full');
  const fiscal = mine.body.teams.find((t: { unit_id: string }) => t.unit_id === 'FISCAL');
  assert.equal(fiscal.withheld, true, 'two contributors beneath are fewer than the threshold');
  assert.equal(fiscal.entries, null);
  assert.equal(mine.body.totals.withheld, true, 'and the total would give the team away by subtraction');

  const all = await get(lead.token, `/api/org/units/G8/overview?${windowQuery}`);
  assert.equal(all.body.level, 'full');
  assert.equal(all.body.teams.find((t: { unit_id: string }) => t.unit_id === 'FISCAL').entries, 2);
  assert.equal(all.body.totals.entries, 3);
  assert.equal(all.body.totals.withheld, false);
});

test('a unit report reads the units beneath only where the reader reads them in their own right', async () => {
  const run = (token: string, type: string) => get(token, `/api/report-center/run?${new URLSearchParams({ type, subject: 'unit', unit_id: 'G8', from: FROM, to: D })}`);
  const titles = (doc: { sections: Array<{ tables: Array<{ id: string; rows: Array<Record<string, unknown>> }> }> }) =>
    doc.sections.flatMap((s) => s.tables).find((t) => t.id === 'activities')!.rows.map((r) => r.title);
  const mine = await run(viewer.token, 'activity');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(titles(mine.body), ['G8 work']);
  const unit = await run(viewer.token, 'unit');
  assert.equal(unit.status, 200, JSON.stringify(unit.body));
  assert.ok(!JSON.stringify(unit.body).includes('Belowone'), 'no Marine of the team beneath is named');

  const all = await run(lead.token, 'activity');
  assert.deepEqual([...titles(all.body)].sort(), ['Fiscal work', 'Fiscal work', 'G8 work']);
  assert.ok(JSON.stringify((await run(lead.token, 'unit')).body).includes('Belowone'));
});

/** Every statement prepared while `fn` runs, with the arguments it ran with. */
async function statements(fn: () => Promise<unknown>) {
  const db = app.ctx.db;
  const seen: Array<{ sql: string; args: unknown[] }> = [];
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

test('a unit window is read by the index on the last day each record covers, on every surface that reads one', async () => {
  const seen = await statements(async () => {
    for (const path of [
      `/api/org/units/G8/dashboard?${windowQuery}`, `/api/org/units/G8/overview?${windowQuery}`, `/api/metrics?unit_id=G8&${windowQuery}`,
      `/api/org/units/G8/analytics/duty?${windowQuery}`, `/api/org/units/G8/analytics/training?${windowQuery}`,
    ]) assert.equal((await get(lead.token, path)).status, 200, path);
  });
  // A read of a unit's window: the window clause periodClause writes, over a list of units.
  const windowed = seen.filter((s) => /\.date IS NOT NULL AND/.test(s.sql) && /unit_id IN \(SELECT value FROM json_each/.test(s.sql));
  const tables = new Set<string>();
  for (const s of windowed) {
    const table = /FROM (activities|trainings|duties) /.exec(s.sql)?.[1];
    assert.ok(table, s.sql);
    tables.add(table);
    const plan = (app.ctx.db.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.args) as Array<{ detail: string }>).map((r) => r.detail).join(' | ');
    assert.match(plan, new RegExp(`USING (COVERING )?INDEX idx_${table}_unit_last`), `${s.sql}\n${plan}`);
  }
  assert.deepEqual([...tables].sort(), ['activities', 'duties', 'trainings']);
});

test('opening the Marines a drill lists reads their scopes at once, however many there are', async () => {
  const ask = `/api/org/units/G8/analytics/training/drill?${windowQuery}&${new URLSearchParams({ visual: 'training_now', key: 'courses' })}`;
  const reads = async () => {
    let body: { count: number; records: Array<{ to: string | null }> } | null = null;
    const seen = await statements(async () => { const res = await get(lead.token, ask); assert.equal(res.status, 200, JSON.stringify(res.body)); body = res.body; });
    // The audit trail writes one line for each Marine whose records were listed, by design, and each line reads the
    // chain's head and its unit's instance; every other read is counted.
    const trail = new Set(['SELECT org_id FROM units WHERE id = ?', 'SELECT value FROM meta WHERE key = ?']);
    const selects = seen.filter((s) => /^\s*(SELECT|WITH)/i.test(s.sql) && !s.sql.includes('audit_log') && !trail.has(s.sql));
    return { selects: selects.length, scopes: selects.filter((s) => /\bAS who\b/.test(s.sql)).length, body: body! };
  };
  const few = await reads();
  assert.equal(few.body.count, 2);
  assert.ok(few.body.records.every((r) => r.to?.startsWith('/team/')), 'each Marine the lead may open is linked');
  for (const name of ['kidthree', 'kidfour', 'kidfive', 'kidsix']) {
    const kid = await app.register(name);
    await enroll(app, op.token, 'FISCAL', kid.id);
    kid.token = await login(name);
    await share(kid, '/api/records/trainings', { title: 'Fiscal course', date: dayAfter(D, -4), status: 'completed', hours: 3, type: 'course', unit_id: 'FISCAL' });
  }
  const many = await reads();
  assert.equal(many.body.count, 6);
  assert.ok(many.body.records.every((r) => r.to?.startsWith('/team/')));
  assert.equal(many.scopes, few.scopes, 'three times the Marines, the same scope reads');
  assert.equal(many.selects, few.selects, 'and the same reads in all');
});

test('a cell is cut to fit by halving, to exactly what dropping one character at a time gives', () => {
  const doc = new PDFDocument({ autoFirstPage: false });
  doc.font('Helvetica').fontSize(8.5);
  const width = (s: string) => doc.widthOfString(s);
  const oneAtATime = (text: string, w: number) => {
    if (width(text) <= w) return text;
    let t = text;
    while (t.length > 1 && width(`${t}…`) > w) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  };
  let seed = 7;
  const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const alphabet = 'abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:-$%()WMiIl';
  let calls = 0;
  const counted = (s: string) => { calls += 1; return width(s); };
  for (let i = 0; i < 1000; i += 1) {
    const text = Array.from({ length: Math.floor(random() * 160) }, () => alphabet[Math.floor(random() * alphabet.length)]).join('');
    const w = 4 + random() * 220;
    assert.equal(fitText(text, w, counted), oneAtATime(text, w), JSON.stringify({ text, w }));
  }
  assert.ok(calls < 1000 * 10, `measured ${calls} times`);
});
