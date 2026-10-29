import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, today, PASSWORD, type TestApp } from './helpers.ts';
import { orgOfUnit } from '../../server/authz/scope.ts';
import { addMonths, standing } from '../../server/services/reportCenter.ts';
import { renderReportDocumentPdf } from '../../server/lib/pdfReport.ts';
import { REPORT_FORMAT, REPORT_TYPES, REPORT_SPECS, primaryTable, type ReportDocument } from '../../shared/reportCatalog.ts';
import { PROCEDURE_LIST } from '../../shared/procedures.ts';

/**
 * The report center (Task 14, ADR-0020): every report, whom it may be about, what may leave as a file, and what each
 * read, print and file leaves in the audit trail. One document is drawn into every format, so a PDF, a CSV, a workbook
 * and the JSON say what the screen says.
 */

let app: TestApp;
let op: { token: string; id: string };
/** G8's people: an NCO reads shared records; a Fire Team Leader also opens member records; an SNCO also exports. */
let nco: { token: string; id: string };
let ftl: { token: string; id: string };
let snco: { token: string; id: string };
/** A Marine of G8's Fiscal team, and a leader of another Unit Instance. */
let marine: { token: string; id: string };
let g1lead: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const file = (token: string, path: string) => app.call('GET', path, { token, binary: true });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const run = (token: string, params: Record<string, string>) => get(token, `/api/report-center/run?${new URLSearchParams(params)}`);
const exportUrl = (params: Record<string, string>) => `/api/report-center/export?${new URLSearchParams(params)}`;
const dayAfter = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const tableOf = (doc: ReportDocument, id: string) => doc.sections.flatMap((s) => s.tables).find((t) => t.id === id);
const auditSince = (seq: number) => app.ctx.db.prepare('SELECT action, actor_id, subject_id, unit_id, entity_id, detail FROM audit_log WHERE seq > ? ORDER BY seq').all(seq) as Array<{ action: string; actor_id: string; subject_id: string | null; unit_id: string | null; entity_id: string | null; detail: string }>;
const lastSeq = () => (app.ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log').get() as { n: number }).n;

const caseIds: string[] = [];

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  nco = await app.register('nco'); await enroll(app, op.token, 'G8', nco.id, 'nco'); nco.token = await login('nco');
  ftl = await app.register('ftl'); await enroll(app, op.token, 'G8', ftl.id, 'fire-team-leader'); ftl.token = await login('ftl');
  snco = await app.register('snco'); await enroll(app, op.token, 'G8', snco.id, 'snco'); snco.token = await login('snco');
  marine = await app.register('rifleman'); await enroll(app, op.token, 'FISCAL', marine.id); marine.token = await login('rifleman');
  g1lead = await app.register('g1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('g1lead');

  const day = today();
  const made = async (token: string, path: string, body: unknown) => {
    const res = await post(token, path, body);
    assert.equal(res.status, 201, `${path}: ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  await made(marine.token, '/api/records/activities', { title: 'Reconciled 12 ULOs', date: dayAfter(day, -10), category: 'Fiscal & Financial', quantity: 12, unit_label: 'ULOs', dollar_amount: 1200, result: 'Closed out FY25 obligations', visibility: 'unit', unit_id: 'FISCAL' });
  await made(marine.token, '/api/records/activities', { title: 'Taught the GTCC brief', date: dayAfter(day, -5), category: 'Leadership', visibility: 'unit', unit_id: 'FISCAL' });
  await made(marine.token, '/api/records/activities', { title: 'Private note to self', date: dayAfter(day, -3), category: 'Leadership', visibility: 'private' });
  // Training: one requirement met a year and a month ago (past due on a 12-month cycle), one met recently, one never.
  await made(marine.token, '/api/records/trainings', { title: 'Cyber Awareness Challenge', date: addMonths(day, -13), status: 'completed', hours: 2, type: 'training', visibility: 'unit', unit_id: 'FISCAL' });
  await made(marine.token, '/api/records/trainings', { title: 'DTS Approving Official (DTS-101)', date: dayAfter(day, -20), status: 'completed', hours: 4, type: 'course', visibility: 'unit', unit_id: 'FISCAL' });
  await made(op.token, '/api/records/tasks', { title: 'Submit the travel voucher', due_date: dayAfter(day, -2), status: 'active', visibility: 'unit', unit_id: 'FISCAL', assignee_id: marine.id });
  await made(op.token, '/api/records/awards', { name: 'Navy and Marine Corps Achievement Medal', type: 'personal_award', status: 'recommended', date: day, user_id: marine.id, visibility: 'unit', unit_id: 'FISCAL' });
  await made(op.token, '/api/records/counselings', { user_id: marine.id, date: dayAfter(day, -100), type: 'quarterly', summary: 'Words that stay on the counseling’s own page', visibility: 'unit', unit_id: 'FISCAL' });

  const org = orgOfUnit(app.ctx, 'G8')!;
  const at = new Date().toISOString();
  const requirement = app.ctx.db.prepare('INSERT INTO training_requirements (id, org_id, unit_id, title, type, course_code, interval_months, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)');
  requirement.run('req-cyber', org, null, 'Cyber Awareness Challenge', 'training', null, 12, at, at);
  requirement.run('req-dts', org, 'FISCAL', 'DTS Approving Official', 'course', 'DTS-101', 36, at, at);
  requirement.run('req-ethics', org, null, 'Annual Ethics Training', 'training', null, 12, at, at);
  app.ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run('duty-od', org, 'OD', 'Officer of the Day', 'Twenty-four hours at the command post', at, at);
  app.ctx.db.prepare('INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
    .run('policy-1', org, dayAfter(day, -30), JSON.stringify({ rules: [{ duty_type_id: 'duty-od', method: 'fixed', points: 3, bands: null }], multipliers: [{ condition: 'weekend', factor: 1.5 }], combine: 'highest' }), 'First version', op.id, at);

  // Cases: two of one procedure (one overdue and held, one unassigned), one of another, one resolved.
  const [umt, ocmt] = [PROCEDURE_LIST.find((p) => p.key === 'umt_four_stage')!, PROCEDURE_LIST.find((p) => p.key === 'ocmt_research')!];
  for (const title of ['ULO 1001', 'ULO 1002', 'OCMT 2001', 'ULO 1003']) caseIds.push(await made(op.token, '/api/work/items', { title, reference: title.replace(' ', '-'), unit_id: 'FISCAL', visibility: 'unit' }));
  const set = app.ctx.db.prepare('UPDATE work_items SET procedure_key = ?, amount = ?, due_date = ?, claimed_by = ?, created_at = ?, stage = ?, state = ?, resolved_at = ? WHERE id = ?');
  const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  set.run(umt.key, 500.5, dayAfter(day, -3), marine.id, ago(40), 'researching', 'in_progress', null, caseIds[0]);
  set.run(umt.key, 250, dayAfter(day, 20), null, ago(5), 'not_started', 'open', null, caseIds[1]);
  set.run(ocmt.key, 1000, null, marine.id, ago(100), 'waiting', 'waiting', null, caseIds[2]);
  set.run(umt.key, 75, null, marine.id, ago(20), 'resolved', 'resolved', ago(2), caseIds[3]);
});
after(async () => { await app.close(); });

test('the training standing: met, due again soon, past due, or no record shared', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addMonths('2026-10-29', -13), '2025-09-29');
  const req = { id: 'r', title: 'Cyber Awareness Challenge', type: 'training', course_code: null, interval_months: 12, unit_id: null };
  const done = (date: string, title = 'Cyber Awareness Challenge', status = 'completed') => ({ user_id: 'u', title, status, date, end_date: null });
  assert.deepEqual(standing(req, [done('2025-09-01')], '2026-10-29'), { last: '2025-09-01', due: '2026-09-01', status: 'overdue' });
  assert.equal(standing(req, [done('2025-11-15')], '2026-10-29').status, 'due_soon', 'due again within 60 days');
  assert.equal(standing(req, [done('2026-06-01')], '2026-10-29').status, 'met');
  assert.equal(standing(req, [done('2026-06-01', 'Cyber Awareness Challenge', 'scheduled')], '2026-10-29').status, 'missing', 'a course not yet taken meets nothing');
  assert.equal(standing(req, [done('2026-11-15')], '2026-10-29').status, 'missing', 'a course after the day it stands on does not count');
  assert.equal(standing({ ...req, interval_months: null }, [done('2019-01-01')], '2026-10-29').status, 'met', 'a requirement taken once stays met');
  assert.equal(standing({ ...req, title: 'DTS Approving Official', course_code: 'DTS-101' }, [done('2026-10-01', 'dts approving official (dts-101) refresher')], '2026-10-29').status, 'met', 'its course code in the title meets it');
});

test('every report runs, and is one document with its title, subject, period, filters and handling line', async () => {
  for (const type of REPORT_TYPES) {
    const spec = REPORT_SPECS[type];
    const params: Record<string, string> = spec.subjects.includes('unit') && !spec.subjects.includes('self') ? { type, unit_id: 'G8' } : { type };
    const res = await run(op.token, params);
    assert.equal(res.status, 200, `${type}: ${JSON.stringify(res.body)}`);
    const doc = res.body as ReportDocument & { files: string[] };
    assert.equal(doc.format, REPORT_FORMAT);
    assert.equal(doc.type, type);
    assert.equal(doc.title, spec.title);
    assert.ok(doc.about, `${type} says whom it is about`);
    assert.equal(doc.marking, 'Working paper', 'the default handling line until a Vantage Administrator sets one');
    assert.ok(doc.generated.on && doc.generated.by.includes('Boletz'), `${type} says when and by whom`);
    assert.ok(doc.sections.length, `${type} has sections`);
    assert.ok(primaryTable(doc), `${type} has a table a CSV can hold`);
    assert.equal(Boolean(doc.period), Boolean(spec.period), `${type} is dated exactly when it has a period`);
    if (doc.period) assert.equal(doc.filters[0].label, 'Period');
    assert.deepEqual(doc.files, ['pdf', 'csv', 'xlsx', 'json']);
  }
});

test('each report says what its records say', async () => {
  const unit = (type: string, extra: Record<string, string> = {}) => run(op.token, { type, unit_id: 'G8', ...extra }).then((r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body as ReportDocument; });

  // Activity: the unit's shared entries, never a private one; one's own report has one's private ones too.
  const activity = await unit('activity', { subject: 'unit' });
  const titles = tableOf(activity, 'activities')!.rows.map((r) => r.title);
  assert.ok(titles.includes('Reconciled 12 ULOs') && titles.includes('Taught the GTCC brief'));
  assert.ok(!titles.includes('Private note to self'), 'a unit report never holds a private entry');
  assert.equal(activity.summary.find((f) => f.label === 'Dollars')?.value, 1200);
  const own = (await run(marine.token, { type: 'activity' })).body as ReportDocument;
  assert.ok(tableOf(own, 'activities')!.rows.some((r) => r.title === 'Private note to self'), 'one’s own report holds one’s private entries');
  const filtered = await unit('activity', { subject: 'unit', category: 'Leadership' });
  assert.deepEqual(tableOf(filtered, 'activities')!.rows.map((r) => r.title), ['Taught the GTCC brief']);
  assert.ok(filtered.filters.some((f) => f.label === 'Category' && f.value === 'Leadership'), 'the filter is printed');

  // Training: each Marine against each requirement that applies to them.
  const training = await unit('training', { subject: 'unit' });
  const byReq = Object.fromEntries(tableOf(training, 'requirements')!.rows.map((r) => [r.title, r]));
  assert.equal(byReq['Cyber Awareness Challenge'].overdue, 1);
  assert.equal(byReq['DTS Approving Official'].met, 1, 'met by its course code in the title');
  const seated = (unit: string) => (app.ctx.db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM unit_members WHERE unit_id IN (SELECT value FROM json_each(?))').get(JSON.stringify(unit === 'G8' ? ['G8', 'FISCAL'] : [unit])) as { n: number }).n;
  assert.equal(byReq['DTS Approving Official'].marines, seated('FISCAL'), 'it applies to the Fiscal team alone');
  assert.equal(byReq['Cyber Awareness Challenge'].marines, seated('G8'), 'one with no unit applies to every Marine');
  const mine = tableOf(training, 'standing')!.rows.filter((r) => String(r.marine).includes('Rifleman'));
  assert.deepEqual(Object.fromEntries(mine.map((r) => [r.requirement, r.status])), { 'Cyber Awareness Challenge': 'Past due', 'DTS Approving Official': 'Met', 'Annual Ethics Training': 'No record' });
  const pastDue = await unit('training', { subject: 'unit', status: 'overdue' });
  assert.ok(tableOf(pastDue, 'standing')!.rows.every((r) => r.status === 'Past due'));

  // Leadership: counseling due, awards in progress, overdue tasks; never what a counseling said.
  const leadership = await unit('leadership');
  assert.ok(tableOf(leadership, 'counseling')!.rows.some((r) => String(r.name).includes('Rifleman')), 'counseled 100 days ago is due');
  assert.equal(tableOf(leadership, 'awards')!.rows[0].name, 'Navy and Marine Corps Achievement Medal');
  assert.equal(tableOf(leadership, 'tasks')!.rows[0].title, 'Submit the travel voucher');
  assert.ok(!JSON.stringify(leadership).includes('Words that stay'), 'a counseling is dated, never quoted');

  // Financial KPI and errors: cases by procedure, amounts, age, who holds them.
  const financial = await unit('financial');
  const fig = (label: string) => financial.summary.find((f) => f.label === label)?.value;
  assert.equal(fig('Open now'), 3);
  assert.equal(fig('Amount open'), 1750.5);
  assert.equal(fig('Overdue'), 1);
  assert.equal(fig('Unassigned'), 1);
  assert.equal(fig('Resolved in the period'), 1);
  const umt = tableOf(financial, 'procedures')!.rows.find((r) => r.procedure === 'UMT')!;
  assert.equal(umt.open, 2);
  assert.equal(umt.resolved, 1);
  const errors = await unit('errors');
  const cases = tableOf(errors, 'cases')!;
  assert.equal(cases.rows.length, 3, 'open cases by default');
  assert.deepEqual(cases.rows.filter((r) => r.overdue === 1).map((r) => r.reference), ['ULO-1001']);
  assert.ok(cases.rows.some((r) => r.holder === 'Unassigned'));
  const overdueOnly = await unit('errors', { overdue: '1' });
  assert.deepEqual(tableOf(overdueOnly, 'cases')!.rows.map((r) => r.reference), ['ULO-1001']);
  const everyCase = await unit('errors', { state: 'all', procedure: 'umt_four_stage' });
  assert.equal(tableOf(everyCase, 'cases')!.rows.length, 3);

  // Duty: the duty stood and the version in force.
  const duty = await unit('duty');
  assert.equal(tableOf(duty, 'types')!.rows[0].name, 'Officer of the Day');
  assert.equal(tableOf(duty, 'types')!.rows[0].points, '3');
  assert.equal(duty.summary.find((f) => f.label === 'Version in force')?.value, 1);
  const before = await unit('duty', { as_of: dayAfter(today(), -60) });
  assert.equal(before.summary.find((f) => f.label === 'Version in force')?.value, null, 'no version was in force before the first');

  // Personnel: the roster, and those with no supervisor named.
  const personnel = await unit('personnel');
  assert.ok(tableOf(personnel, 'roster')!.rows.length >= 5);
  const unsupervised = await unit('personnel', { status: 'unsupervised' });
  assert.equal(tableOf(unsupervised, 'roster')!.rows.length, personnel.summary.find((f) => f.label === 'No supervisor')?.value);

  // Workload: open work by stage and by Marine.
  const workload = await unit('workload');
  assert.equal(workload.summary.find((f) => f.label === 'Open')?.value, 3);
  assert.ok(tableOf(workload, 'members')!.rows.some((r) => String(r.name).includes('Rifleman') && r.assigned === 2));

  // Custom: the records, columns, grouping and order chosen.
  const custom = await unit('custom', { subject: 'unit', dataset: 'activities', columns: 'date,owner,title,dollar_amount', group: 'category', sort: 'dollar_amount', direction: 'desc' });
  assert.deepEqual(tableOf(custom, 'rows')!.columns.map((c) => c.key), ['date', 'owner', 'title', 'dollar_amount']);
  assert.equal(tableOf(custom, 'rows')!.rows[0].title, 'Reconciled 12 ULOs');
  assert.ok(tableOf(custom, 'groups')!.rows.some((g) => g.group === 'Fiscal & Financial' && g.count === 1 && g.dollar_amount === 1200));
  const work = await unit('custom', { subject: 'unit', dataset: 'work', group: 'procedure' });
  assert.equal(tableOf(work, 'rows')!.rows.length, 4);
  assert.equal((await run(marine.token, { type: 'custom', dataset: 'work' })).status, 400, 'cases belong to a unit');
});

test('who may see what: one’s own always, a Marine one leads, a unit whose records one reads', async () => {
  const status = async (token: string, params: Record<string, string>) => (await run(token, params)).status;
  // An ordinary Marine: their own record, nobody else's, no unit's.
  assert.equal(await status(marine.token, { type: 'individual' }), 200);
  assert.equal(await status(marine.token, { type: 'individual', user_id: op.id }), 403);
  assert.equal(await status(marine.token, { type: 'unit', unit_id: 'G8' }), 403);
  assert.equal(await status(marine.token, { type: 'personnel', unit_id: 'FISCAL' }), 403);
  // An NCO reads the unit's shared records but opens no member's: unit reports without figures by Marine.
  assert.equal(await status(nco.token, { type: 'individual', user_id: marine.id }), 403);
  const unit = (await run(nco.token, { type: 'unit', unit_id: 'G8' })).body as ReportDocument;
  assert.ok(!tableOf(unit, 'members'), 'no figures by Marine without opening member records');
  assert.ok(unit.notes.some((n) => n.includes('Figures by Marine are left out')));
  const leadership = (await run(nco.token, { type: 'leadership', unit_id: 'G8' })).body as ReportDocument;
  assert.ok(!tableOf(leadership, 'counseling') && !tableOf(leadership, 'readiness'));
  const training = (await run(nco.token, { type: 'training', subject: 'unit', unit_id: 'G8' })).body as ReportDocument;
  assert.ok(tableOf(training, 'requirements') && !tableOf(training, 'standing'), 'requirement totals, not each Marine');
  const workload = (await run(nco.token, { type: 'workload', unit_id: 'G8' })).body as ReportDocument;
  assert.ok(!tableOf(workload, 'members'));
  assert.equal(await status(nco.token, { type: 'custom', subject: 'unit', unit_id: 'G8', dataset: 'counselings' }), 403, 'counselings across a unit need opening member records');
  // A Fire Team Leader opens member records: the Marine's own report, with what they shared there.
  const member = await run(ftl.token, { type: 'individual', user_id: marine.id });
  assert.equal(member.status, 200, JSON.stringify(member.body));
  assert.ok(!tableOf(member.body, 'ledger')!.rows.some((r) => r.title === 'Private note to self'), 'another Marine’s report holds only what they shared');
  assert.deepEqual(member.body.files, ['pdf'], 'a PDF, but no spreadsheet or data file without the export permission');
  // Another Unit Instance's leader reaches nothing in G8, whatever they name.
  assert.equal(await status(g1lead.token, { type: 'unit', unit_id: 'G8' }), 403);
  assert.equal(await status(g1lead.token, { type: 'individual', user_id: marine.id }), 403);
  assert.equal(await status(g1lead.token, { type: 'activity', user_id: marine.id, unit_id: 'FISCAL' }), 403);
  // A Marine one leads, named in another Unit Instance's unit, is refused rather than answered from another.
  const cross = await run(op.token, { type: 'individual', user_id: marine.id, unit_id: 'G1' });
  assert.equal(cross.status, 403);
  assert.equal(cross.body.code, 'cross_instance');
  // Asked wrongly: a unit report about a Marine, a unit report without a unit.
  assert.equal(await status(op.token, { type: 'unit' }), 400);
  assert.equal(await status(op.token, { type: 'personnel', unit_id: 'G8', user_id: marine.id }), 400);
  assert.equal(await status(op.token, { type: 'unit', unit_id: 'NO-SUCH-UNIT' }), 404);
});

test('a file leaves Vantage only with the authority to take it', async () => {
  const mine = await file(marine.token, exportUrl({ type: 'activity', format: 'csv' }));
  assert.equal(mine.status, 200, 'one’s own in every format');
  // A Marine's records as a spreadsheet need the unit's export permission; their PDF needs only opening their record.
  assert.equal((await file(ftl.token, exportUrl({ type: 'individual', user_id: marine.id, format: 'pdf' }))).status, 200);
  for (const format of ['csv', 'xlsx', 'json']) assert.equal((await file(ftl.token, exportUrl({ type: 'individual', user_id: marine.id, format }))).status, 403, format);
  assert.equal((await file(snco.token, exportUrl({ type: 'individual', user_id: marine.id, format: 'csv' }))).status, 200, 'with the export permission');
  // A unit's report as any file needs the export permission there; viewing and printing do not.
  for (const format of ['pdf', 'csv']) assert.equal((await file(nco.token, exportUrl({ type: 'unit', unit_id: 'G8', format }))).status, 403, format);
  assert.equal((await run(nco.token, { type: 'unit', unit_id: 'G8', purpose: 'print' })).status, 200);
  assert.equal((await file(snco.token, exportUrl({ type: 'unit', unit_id: 'G8', format: 'xlsx' }))).status, 200);
});

test('each format is drawn from the same document', async () => {
  const params = { type: 'errors', unit_id: 'G8' };
  const doc = (await run(op.token, params)).body as ReportDocument;
  const pdf = await file(op.token, exportUrl({ ...params, format: 'pdf' }));
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition') || '', /^attachment; filename="vantage-error-report-g-8-comptroller-and-1-unit-beneath-it-\d{4}-\d{2}-\d{2}\.pdf"$/);
  assert.equal(pdf.buffer!.subarray(0, 5).toString(), '%PDF-');
  const csv = await app.call('GET', exportUrl({ ...params, format: 'csv' }), { token: op.token });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type') || '', /^text\/csv/);
  const lines = csv.text.replace(/^\uFEFF/, '').split('\r\n');
  assert.equal(lines[0], tableOf(doc, 'cases')!.columns.map((c) => `"${c.label}"`).join(','), 'the CSV holds the main table, its header first');
  assert.equal(lines.length - 1, tableOf(doc, 'cases')!.rows.length);
  assert.ok(lines.some((l) => l.includes('"ULO-1001"') && l.includes('"500.5"') && l.endsWith('"Yes"')), 'raw amounts, and a flag as Yes or No');
  const xlsx = await file(op.token, exportUrl({ ...params, format: 'xlsx' }));
  assert.equal(xlsx.status, 200);
  assert.equal(xlsx.buffer!.subarray(0, 2).toString(), 'PK');
  const json = await app.call('GET', exportUrl({ ...params, format: 'json' }), { token: op.token });
  assert.equal(json.body.format, REPORT_FORMAT);
  assert.deepEqual(json.body.sections, doc.sections, 'the JSON is the document the screen shows');
});

test('reads of others, every print and every file are audited; one’s own view and a refusal are not', async () => {
  let seq = lastSeq();
  await run(marine.token, { type: 'individual' });
  assert.deepEqual(auditSince(seq).map((e) => e.action), [], 'one’s own report on screen');
  seq = lastSeq();
  await run(marine.token, { type: 'individual', purpose: 'print' });
  assert.deepEqual(auditSince(seq).map((e) => e.action), ['print_report']);
  seq = lastSeq();
  await run(ftl.token, { type: 'individual', user_id: marine.id });
  const viewed = auditSince(seq);
  assert.deepEqual(viewed.map((e) => e.action), ['view_report']);
  assert.equal(viewed[0].subject_id, marine.id);
  assert.equal(viewed[0].unit_id, 'FISCAL');
  seq = lastSeq();
  await file(snco.token, exportUrl({ type: 'unit', unit_id: 'G8', format: 'csv' }));
  const filed = auditSince(seq);
  assert.deepEqual(filed.map((e) => e.action), ['export_report']);
  assert.equal(filed[0].entity_id, 'unit');
  assert.match(filed[0].detail, /^unit; CSV; .+; \d+ rows?$/);
  seq = lastSeq();
  await file(nco.token, exportUrl({ type: 'unit', unit_id: 'G8', format: 'csv' }));
  await run(marine.token, { type: 'unit', unit_id: 'G8' });
  assert.ok(auditSince(seq).every((e) => e.action === 'access_denied'), 'a refusal leaves only the refusal');
});

test('the handling line is the enterprise’s, on every page and file', async () => {
  assert.equal((await app.call('POST', '/api/auth/sudo', { token: op.token, body: { password: PASSWORD } })).status, 200);
  assert.equal((await app.call('PUT', '/api/platform/runtime', { token: op.token, body: { reportMarking: '' } })).status, 400, 'never blank');
  assert.equal((await app.call('PUT', '/api/platform/runtime', { token: op.token, body: { reportMarking: 'Two\nlines' } })).status, 400, 'one line');
  assert.equal((await app.call('PUT', '/api/platform/runtime', { token: op.token, body: { reportMarking: 'CUI//PRVCY' } })).status, 200);
  const doc = (await run(marine.token, { type: 'activity' })).body as ReportDocument;
  assert.equal(doc.marking, 'CUI//PRVCY');
  const json = await app.call('GET', exportUrl({ type: 'activity', format: 'json' }), { token: marine.token });
  assert.equal(json.body.marking, 'CUI//PRVCY');
  assert.equal((await app.call('GET', '/api/me', { token: marine.token })).body.instance.reportMarking, 'CUI//PRVCY');
  app.ctx.runtime.reportMarking = 'Working paper';
});

test('a long table prints over pages with its header again on each, and nothing cut off', async () => {
  const rows = Array.from({ length: 160 }, (_, i) => ({ date: '2026-10-01', title: `Entry ${i + 1} ${'with a long outcome that wraps '.repeat(i % 3 + 1)}`, value: i * 10 }));
  const doc: ReportDocument = {
    format: REPORT_FORMAT, type: 'activity', title: 'Activity', about: 'Cpl John Boletz', unit: 'G-8 Comptroller',
    period: { from: '2026-07-01', to: '2026-10-29', label: 'Last 90 days' }, generated: { at: new Date().toISOString(), on: '2026-10-29', by: 'Cpl John Boletz' },
    filters: [{ label: 'Period', value: 'Last 90 days' }], marking: 'Working paper', currency: '$', summary: [{ label: 'Entries', value: 160, kind: 'number' }],
    sections: [{ id: 'all', heading: 'Every activity', tables: [{ id: 'all', title: 'Activities', columns: [{ key: 'date', label: 'Date', kind: 'date', width: 9 }, { key: 'title', label: 'Activity', width: 40 }, { key: 'value', label: 'Dollars', kind: 'money', width: 10 }], rows, total: 160, empty: 'None.' }] }],
    notes: ['Drawn from your own records.'], primary: 'all',
  };
  const pdf = await renderReportDocumentPdf(doc);
  const pages = Number(/\/Type \/Pages[\s\S]*?\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1]);
  assert.ok(pages >= 4, `a 160-row table runs over pages (${pages})`);
  // A cell longer than a page could hold is shortened in print, and the print says so.
  const long = await renderReportDocumentPdf({ ...doc, sections: [{ ...doc.sections[0], tables: [{ ...doc.sections[0].tables[0], rows: [{ date: '2026-10-01', title: 'x'.repeat(5000), value: 1 }], total: 1 }] }] });
  assert.ok(long.length > 1000);
});

test('saved reports keep the choices, never the data; shared, they name no Marine', async () => {
  const mine = await post(ftl.token, '/api/report-center/definitions', { name: 'Rifleman, last 90 days', type: 'individual', params: { user_id: marine.id, period: 'last90', format: 'pdf', nonsense: 'x' } });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.deepEqual(mine.body.params, { user_id: marine.id, period: 'last90' }, 'only a report’s own choices are kept');
  assert.equal((await post(ftl.token, '/api/report-center/definitions', { name: 'Bad', type: 'individual', params: { period: 'forever' } })).status, 400);
  // A private one is shared with no unit and keeps none, even one that is not there.
  const unshared = await post(ftl.token, '/api/report-center/definitions', { name: 'Kept to myself', type: 'activity', visibility: 'private', unit_id: 'NO-SUCH-UNIT', params: {} });
  assert.equal(unshared.status, 201, JSON.stringify(unshared.body));
  assert.equal(unshared.body.unit_id, null);
  assert.equal((await app.call('DELETE', `/api/report-center/definitions/${unshared.body.id}`, { token: ftl.token })).status, 204);
  const shared = await post(nco.token, '/api/report-center/definitions', { name: 'Unit errors', type: 'errors', visibility: 'unit', unit_id: 'G8', params: { unit_id: 'G8', user_id: marine.id, overdue: '1' } });
  assert.equal(shared.status, 201, JSON.stringify(shared.body));
  assert.equal(shared.body.params.user_id, undefined, 'a report shared with a unit names no Marine');
  assert.equal((await post(marine.token, '/api/report-center/definitions', { name: 'Mine to share', type: 'activity', visibility: 'unit', unit_id: 'FISCAL', params: {} })).status, 403, 'shared only where one reads the unit’s records');
  const listed = (await get(snco.token, '/api/report-center/definitions')).body as Array<{ name: string; mine: boolean }>;
  assert.deepEqual(listed.map((d) => d.name), ['Unit errors'], 'a unit’s shared reports, not a colleague’s own');
  assert.equal((await app.call('DELETE', `/api/report-center/definitions/${shared.body.id}`, { token: snco.token })).status, 403);
  assert.equal((await app.call('PUT', `/api/report-center/definitions/${mine.body.id}`, { token: snco.token, body: { name: 'Mine now', type: 'individual', params: {} } })).status, 403);
  const seq = lastSeq();
  assert.equal((await app.call('DELETE', `/api/report-center/definitions/${shared.body.id}`, { token: nco.token })).status, 204);
  assert.deepEqual(auditSince(seq).map((e) => e.action), ['report_definition_deleted']);
  // Running a saved report decides again who may see it: the marine named in it is still refused to an NCO.
  assert.equal((await run(nco.token, { type: 'individual', ...mine.body.params })).status, 403);
});
