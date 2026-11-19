import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { orgOfUnit } from '../../server/authz/scope.ts';
import { CLOSED_CASE_SQL, EXPORTS_WAITING, inExportLine, isClosed, readCases } from '../../server/services/reportCenter.ts';
import { PDF_ROWS_PER_TURN, renderReportDocumentPdf } from '../../server/lib/pdfReport.ts';
import { readWorkbook } from '../../server/lib/workbook.ts';
import { STAGES } from '../../shared/caseModel.ts';
import { REPORT_FORMAT, REPORT_ROW_LIMIT, type ReportDocument } from '../../shared/reportCatalog.ts';

/**
 * The report center past its read cap (ADR-0032). Each report decides what it reads before the cap, totals what
 * the reader may see however much was listed, and says so whenever a list or a file was cut. Each test writes its bulk
 * rows straight to the table in one transaction and removes them after.
 */

let app: TestApp;
let op: { token: string; id: string };
let marine: { token: string; id: string };
let bulky: { token: string; id: string };

const BULK = 50_001;
const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const run = async (token: string, params: Record<string, string>) => {
  const res = await get(token, `/api/report-center/run?${new URLSearchParams(params)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 400));
  return res.body as ReportDocument;
};
const exportUrl = (params: Record<string, string>) => `/api/report-center/export?${new URLSearchParams(params)}`;
const figure = (doc: ReportDocument, label: string) => doc.summary.find((f) => f.label === label)?.value;
const tableOf = (doc: ReportDocument, id: string) => doc.sections.flatMap((s) => s.tables).find((t) => t.id === id);
const db = () => app.ctx.db;
const count = (sql: string, ...params: unknown[]) => (db().prepare(sql).get(...params) as { n: number }).n;
const dayAfter = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The SQL a call prepares, so a test can read the plan of the statement it relied on. */
async function preparedDuring(work: () => unknown): Promise<string[]> {
  const raw = db();
  const prepare = raw.prepare;
  const seen: string[] = [];
  raw.prepare = ((text: string) => { seen.push(text); return prepare.call(raw, text); }) as typeof raw.prepare;
  try { await work(); } finally { raw.prepare = prepare; }
  return seen;
}
const planOf = (sql: string, params: unknown[]) => (db().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((r) => r.detail);

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  marine = await app.register('rifleman'); await enroll(app, op.token, 'FISCAL', marine.id);
  bulky = await app.register('bulky'); await enroll(app, op.token, 'FISCAL', bulky.id);
  bulky.token = (await app.login('bulky')).body.token;
  const org = orgOfUnit(app.ctx, 'G8')!;
  const at = new Date().toISOString();
  db().prepare('INSERT INTO training_requirements (id, org_id, unit_id, title, type, course_code, interval_months, active, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, NULL, 12, 1, ?, ?)')
    .run('req-cyber', org, 'Cyber Awareness Challenge', 'training', at, at);
  db().prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)')
    .run('duty-od', org, 'OD', 'Officer of the Day', 'At the command post', at, at);
});
after(async () => { await app.close(); });

test('RPT-2: the closed test in SQL is isClosed, for every stage with every state', () => {
  const closed = db().prepare(`SELECT ${CLOSED_CASE_SQL} AS closed FROM (SELECT ? AS stage, ? AS state) t`);
  for (const state of ['open', 'in_progress', 'waiting', 'resolved', 'not_applicable']) {
    for (const stage of [null, '', ...STAGES]) {
      const inSql = Boolean((closed.get(stage, state) as { closed: number }).closed);
      assert.equal(inSql, isClosed({ stage, state } as never), `stage ${JSON.stringify(stage)}, state ${state}`);
    }
  }
});

test('RPT-2: open cases are read as open before the cap, so a long closed history hides none of them', async () => {
  const at = new Date().toISOString();
  const add = db().prepare(`INSERT INTO work_items (id, unit_id, owner_id, visibility, natural_key, row_hash, title, reference, due_date, amount, state, stage, resolved_at, created_at, updated_at)
                            VALUES (?, 'FISCAL', ?, 'unit', ?, 'h', ?, ?, ?, 1, ?, ?, ?, '2019-12-01T00:00:00.000Z', ?)`);
  db().transaction(() => {
    for (let i = 0; i < BULK; i++) add.run(`rpt2-closed-${i}`, op.id, `rpt2-closed-${i}`, `Closed ${i}`, `C-${i}`, '2020-01-01', 'resolved', 'resolved', '2020-02-01T00:00:00.000Z', at);
    // Open, and due on no day, so it sorts after every closed case.
    add.run('rpt2-open', op.id, 'rpt2-open', 'The undated open case', 'OPEN-UNDATED', null, 'open', null, null, at);
  })();
  try {
    const tree = `t.unit_id IN ('G8', 'FISCAL') AND t.visibility = 'unit' AND t.deleted_at IS NULL`;
    const open = count(`SELECT COUNT(*) AS n FROM work_items t WHERE ${tree} AND NOT (${CLOSED_CASE_SQL})`);
    const every = count(`SELECT COUNT(*) AS n FROM work_items t WHERE ${tree}`);
    assert.equal(open, 1);

    const errors = await run(op.token, { type: 'errors', subject: 'unit', unit_id: 'G8' });
    assert.equal(figure(errors, 'Cases'), open);
    assert.ok(tableOf(errors, 'cases')!.rows.some((r) => r.reference === 'OPEN-UNDATED'), 'the open case is listed');
    assert.ok(!errors.notes.some((n) => /Only the/.test(n)), 'nothing was cut');
    const financial = await run(op.token, { type: 'financial', subject: 'unit', unit_id: 'G8' });
    assert.equal(figure(financial, 'Open now'), open);
    assert.equal(figure(financial, 'Amount open'), 1);

    // Every case, open or closed, is past the cap: the list says so, and its totals still count every case.
    const all = await run(op.token, { type: 'errors', subject: 'unit', unit_id: 'G8', state: 'all' });
    assert.equal(figure(all, 'Cases'), every);
    assert.equal(figure(all, 'Amount'), every);
    assert.equal(figure(all, 'Unassigned'), every);
    assert.equal(tableOf(all, 'cases')!.total, every);
    assert.equal(tableOf(all, 'cases')!.rows.length, REPORT_ROW_LIMIT);
    assert.ok(all.notes.some((n) => /Only the 50,000 cases due soonest are listed.*the totals count every case/.test(n)), all.notes.join('\n'));

    // Open now is read by the unit's index on its cases, not a scan of every case.
    const sql = (await preparedDuring(() => readCases(app.ctx, { unitIds: ['G8', 'FISCAL'] }, {}, null, { state: 'open' }))).find((s) => s.includes('FROM work_items t'))!;
    const plan = planOf(sql, [JSON.stringify(['G8', 'FISCAL'])]);
    assert.ok(plan.some((d) => /^SEARCH t USING (COVERING )?INDEX idx_work_items_\w+ \(unit_id=\?/.test(d)), plan.join('\n'));
    assert.ok(!plan.some((d) => /^SCAN t\b/.test(d)), plan.join('\n'));
  } finally {
    db().prepare("DELETE FROM work_items WHERE id LIKE 'rpt2-%'").run();
  }
});

test('RPT-3 and RPT-4: a requirement met today stands met, and the courses past the cap are still counted', async () => {
  const at = new Date().toISOString();
  const day = today();
  const add = db().prepare("INSERT INTO trainings (id, user_id, unit_id, visibility, title, date, status, hours, type, created_at, updated_at) VALUES (?, ?, 'FISCAL', 'unit', ?, ?, 'completed', 1, 'training', ?, ?)");
  db().transaction(() => {
    for (let i = 0; i < BULK; i++) add.run(`rpt3-${i}`, bulky.id, 'Other course', day, at, at);
    // Written last, so a read cut in the order rows were written leaves it out.
    add.run('rpt3-cyber', marine.id, 'Cyber Awareness Challenge', day, at, at);
  })();
  try {
    let doc!: ReportDocument;
    const seen = await preparedDuring(async () => { doc = await run(op.token, { type: 'training', subject: 'unit', unit_id: 'G8' }); });
    // Each batch of people is read by their own index, completed courses only and never cut.
    const batch = seen.find((s) => /FROM json_each\(\?\) p CROSS JOIN trainings t ON t\.user_id = p\.value/.test(s))!;
    assert.ok(batch && !/LIMIT/.test(batch), batch);
    const marks = (batch.match(/\?/g) || []).length;
    const plan = planOf(batch, Array.from({ length: marks }, () => '[]'));
    assert.ok(plan.some((d) => /^SEARCH t USING INDEX idx_trainings_user\w* \(user_id=\?/.test(d)), plan.join('\n'));
    assert.ok(!plan.some((d) => /^SCAN t\b/.test(d)), plan.join('\n'));
    const cyber = tableOf(doc, 'standing')!.rows.filter((r) => r.requirement === 'Cyber Awareness Challenge');
    assert.equal(cyber.find((r) => /Rifleman/.test(String(r.marine)))?.status, 'Met', JSON.stringify(cyber));
    const shared = count("SELECT COUNT(*) AS n FROM trainings WHERE unit_id IN ('G8', 'FISCAL') AND visibility = 'unit' AND deleted_at IS NULL AND date = ?", day);
    assert.equal(shared, BULK + 1);
    assert.equal(figure(doc, 'Courses in the period'), shared);
    assert.equal(figure(doc, 'Training hours'), shared);
    assert.equal(tableOf(doc, 'courses')!.total, shared);
    assert.ok(doc.notes.some((n) => /Only the first 50,000 courses in the period are listed; the totals count every one/.test(n)), doc.notes.join('\n'));
  } finally {
    db().prepare("DELETE FROM trainings WHERE id LIKE 'rpt3-%'").run();
  }
});

test('RPT-4: duty totals count every duty stood, however many are listed', async () => {
  const at = new Date().toISOString();
  const day = dayAfter(today(), -1);
  const add = db().prepare(`INSERT INTO duties (id, user_id, unit_id, duty_type_id, date, start_time, end_date, end_time, hours, days, submitted_at, calculated_points, created_at, updated_at)
                            VALUES (?, ?, 'FISCAL', 'duty-od', ?, '08:00', ?, '16:00', 8, 1, ?, 3, ?, ?)`);
  db().transaction(() => { for (let i = 0; i < BULK; i++) add.run(`rpt4-duty-${i}`, bulky.id, day, day, at, at, at); })();
  try {
    const doc = await run(op.token, { type: 'duty', subject: 'unit', unit_id: 'G8', period: 'all' });
    const stood = count("SELECT COUNT(*) AS n FROM duties WHERE unit_id IN ('G8', 'FISCAL') AND deleted_at IS NULL");
    assert.equal(stood, BULK);
    assert.equal(figure(doc, 'Duty stood'), stood);
    assert.equal(figure(doc, 'Hours'), stood * 8);
    assert.equal(figure(doc, 'Calculated points'), stood * 3);
    assert.equal(figure(doc, 'Approved'), 0);
    // The tally by Marine is a total in SQL too, so it holds every duty of theirs.
    assert.equal(tableOf(doc, 'by_marine')!.rows.find((r) => /Bulky/.test(String(r.marine)))?.count, stood);
    assert.ok(doc.notes.some((n) => /Only the first 50,000 duties are listed; the totals count every one/.test(n)), doc.notes.join('\n'));
  } finally {
    db().prepare("DELETE FROM duties WHERE id LIKE 'rpt4-duty-%'").run();
  }
});

test('RPT-4: a custom report past the cap lists the newest records and totals every one', async () => {
  const at = new Date().toISOString();
  const add = db().prepare("INSERT INTO activities (id, user_id, visibility, title, date, category, quantity, dollar_amount, dollar_type, created_at, updated_at) VALUES (?, ?, 'private', ?, ?, 'Fiscal & Financial', 2, ?, ?, ?, ?)");
  db().transaction(() => {
    for (let i = 0; i < BULK; i++) add.run(`rpt4-act-${i}`, bulky.id, `Entry ${i}`, '2020-01-01', 1, null, at, at);
    // The newest, written last, and of a value type that is listed but never added up.
    add.run('rpt4-act-newest', bulky.id, 'The newest entry', today(), 100, 'reviewed', at, at);
  })();
  try {
    const doc = await run(bulky.token, { type: 'custom', dataset: 'activities', period: 'all', columns: 'date,title,quantity,dollar_amount' });
    const rows = tableOf(doc, 'rows')!;
    assert.equal(rows.rows[0].title, 'The newest entry', 'newest first, so the cut drops the oldest');
    assert.equal(rows.total, BULK + 1);
    assert.equal(figure(doc, 'Activities'), BULK + 1);
    assert.equal(figure(doc, 'Count, total'), (BULK + 1) * 2);
    assert.equal(figure(doc, 'Value, total'), BULK, 'a reviewed value is listed, never added');
    assert.ok(doc.notes.some((n) => /Only the 50,000 newest records are listed.*the count and the totals are of every record/.test(n)), doc.notes.join('\n'));
  } finally {
    db().prepare("DELETE FROM activities WHERE id LIKE 'rpt4-act-%'").run();
  }
});

test('RPT-10: a spreadsheet cut at the row limit says so in the file and in its response', async () => {
  const at = new Date().toISOString();
  const add = db().prepare("INSERT INTO activities (id, user_id, unit_id, visibility, title, date, created_at, updated_at) VALUES (?, ?, 'FISCAL', 'unit', ?, ?, ?, ?)");
  const day = dayAfter(today(), -1);
  db().transaction(() => { for (let i = 0; i <= REPORT_ROW_LIMIT; i++) add.run(`rpt10-${i}`, marine.id, `Entry ${i}`, day, at, at); })();
  try {
    const params = { type: 'activity', subject: 'unit', unit_id: 'G8' };
    const doc = await run(op.token, params);
    const main = tableOf(doc, 'activities')!;
    assert.equal(main.rows.length, REPORT_ROW_LIMIT, 'the screen still holds the row limit');
    assert.equal(main.total, REPORT_ROW_LIMIT + 1);

    const csv = await app.call('GET', exportUrl({ ...params, format: 'csv' }), { token: op.token });
    assert.equal(csv.status, 200);
    assert.equal(csv.headers.get('x-vantage-rows'), `${REPORT_ROW_LIMIT}/${REPORT_ROW_LIMIT + 1}`);
    assert.equal(csv.text.replace(/^\uFEFF/, '').trimEnd().split('\r\n').length - 1, REPORT_ROW_LIMIT);

    const xlsx = await app.call('GET', exportUrl({ ...params, format: 'xlsx' }), { token: op.token, binary: true });
    assert.equal(xlsx.status, 200);
    assert.equal(xlsx.headers.get('x-vantage-rows'), null, 'a workbook says it in its About sheet');
    const about = readWorkbook(xlsx.buffer!).sheets.find((s) => s.name === 'About')!;
    assert.ok(about.rows.some((r) => r.some((c) => c === 'Activities: the first 5,000 of 5,001 rows. Narrow the filters for the rest.')), JSON.stringify(about.rows.slice(-4)));

    // Under the limit, a file says nothing of a cut.
    const small = await app.call('GET', exportUrl({ type: 'activity', format: 'csv' }), { token: bulky.token });
    assert.equal(small.status, 200);
    assert.match(small.headers.get('x-vantage-rows') || '', /^(\d+)\/\1$/);
  } finally {
    db().prepare("DELETE FROM activities WHERE id LIKE 'rpt10-%'").run();
  }
});

test('RPT-6: a 5,000-row PDF lets other work run while it draws, and draws the same pages', async () => {
  const rows = Array.from({ length: REPORT_ROW_LIMIT }, (_, i) => ({
    date: '2026-10-01', owner: `Cpl Marine ${i % 97}`, title: `Entry ${i + 1}${i % 7 === 0 ? ' with an outcome that runs long enough to wrap onto a second line' : ''}`,
    category: 'Fiscal & Financial', area: 'Mission', quantity: i % 13, unit_label: 'ULOs', value: i * 10, value_type: 'Saved', result: i % 3 ? 'Closed' : null, end_date: null,
  }));
  const doc: ReportDocument = {
    format: REPORT_FORMAT, type: 'activity', title: 'Activity', about: 'G-8 Comptroller', unit: 'G-8 Comptroller',
    period: { from: '2026-07-01', to: '2026-10-29', label: 'Last 90 days' }, generated: { at: '2026-10-29T00:00:00.000Z', on: '2026-10-29', by: 'Cpl John Boletz' },
    filters: [{ label: 'Period', value: 'Last 90 days' }], marking: 'Working paper', currency: '$', summary: [{ label: 'Entries', value: REPORT_ROW_LIMIT, kind: 'number' }],
    sections: [{ id: 'all', heading: 'Every activity', tables: [{ id: 'all', title: 'Activities', columns: [
      { key: 'date', label: 'Date', kind: 'date', width: 9 }, { key: 'end_date', label: 'End date', kind: 'date', width: 9 }, { key: 'owner', label: 'Marine', width: 16 }, { key: 'title', label: 'Activity', width: 28 },
      { key: 'category', label: 'Category', width: 12 }, { key: 'area', label: 'Area', width: 12 }, { key: 'quantity', label: 'Count', kind: 'number', width: 7 }, { key: 'unit_label', label: 'Of', width: 8 },
      { key: 'value', label: 'Dollars', kind: 'money', width: 10 }, { key: 'value_type', label: 'Value type', width: 10 }, { key: 'result', label: 'Outcome', width: 22 },
    ], rows, total: REPORT_ROW_LIMIT, empty: 'None.' }] }],
    notes: ['Drawn from your own records.'], primary: 'all',
  };
  let ticks = 0; let worst = 0; let last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; ticks += 1; }, 5);
  const started = Date.now();
  const pdf = await renderReportDocumentPdf(doc);
  worst = Math.max(worst, Date.now() - last);
  const took = Date.now() - started;
  clearInterval(timer);
  // The pages drawn a turn at a time are the pages drawn in one go: 279 for this table.
  assert.equal(Number(/\/Type \/Pages[\s\S]*?\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]), 279);
  // Each turn the table lets go is a turn for the timer, about one each PDF_ROWS_PER_TURN rows.
  assert.ok(ticks >= REPORT_ROW_LIMIT / PDF_ROWS_PER_TURN / 2, `the timer ran ${ticks} times in ${took} ms`);
  // Drawn in one go, the event loop stood still for the whole render (about 2 s here); now no stretch is near it.
  assert.ok(worst < Math.max(1_000, took / 2), `the longest stretch was ${worst} ms of ${took} ms`);
});

test('RPT-6: exports are drawn one at a time, and past the line a reader is asked to try again', async () => {
  const until = async (ready: () => boolean) => { while (!ready()) await new Promise((r) => setImmediate(r)); };
  let running = 0; let most = 0;
  const finished: number[] = [];
  const gates: Array<() => void> = [];
  const work = (n: number) => () => new Promise<number>((resolve) => {
    running += 1; most = Math.max(most, running);
    gates.push(() => { running -= 1; finished.push(n); resolve(n); });
  });
  const line = Array.from({ length: EXPORTS_WAITING + 1 }, (_, i) => inExportLine(work(i)));
  assert.throws(() => inExportLine(work(99)), (e: { status?: number; message?: string }) => e.status === 429 && /Try again/.test(e.message || ''));
  for (let i = 0; i <= EXPORTS_WAITING; i++) { await until(() => gates.length > 0); gates.shift()!(); }
  assert.deepEqual(await Promise.all(line), Array.from({ length: EXPORTS_WAITING + 1 }, (_, i) => i));
  assert.equal(most, 1, 'never two at once');
  assert.deepEqual(finished, [...finished].sort((a, b) => a - b), 'in the order they came');
  // A failed export does not hold the line.
  await assert.rejects(inExportLine(async () => { throw new Error('drawing failed'); }), /drawing failed/);
  assert.equal(await inExportLine(async () => 2), 2);

  // Through the route, a file still downloads with the line in front of it.
  const pdf = await app.call('GET', exportUrl({ type: 'activity', format: 'pdf' }), { token: marine.token, binary: true });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buffer!.subarray(0, 4).toString(), '%PDF');
});
