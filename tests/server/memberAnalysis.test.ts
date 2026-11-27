import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import type { ReportDocument } from '../../shared/reportCatalog.ts';

/**
 * A Marine's Analysis, opened from their page, counts what the page counts: what they shared with every unit of one
 * Unit Instance where the reader opens their records (ADR-0008). Dual serves in FISCAL and BUDGET, two teams of G8, and
 * in MANPOWER, a team of G1. Reyes leads in both instances. Opened through FISCAL, every reader about Dual (the
 * analysis, the report, the comparison, the CSV, the PDFs, the figures and the outcomes behind them, and the Report
 * library) reads FISCAL and BUDGET, never MANPOWER and never a private entry.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let g1lead: { token: string; id: string };
/** Leads in G8 and in G1. */
let reyes: { token: string; id: string };
/** In FISCAL, BUDGET and MANPOWER. */
let dual: { token: string; id: string };
/** Opens Dual's records in FISCAL (SNCO, who may export) and in BUDGET (Fire Team Leader, who may not). */
let mixed: { token: string; id: string };
/** A Marine of FISCAL who opens nobody's records. */
let plain: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const file = (token: string, path: string) => app.call('GET', path, { token, binary: true });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

const TITLES = { fiscal: 'Dual balanced the fiscal ledger', budget: 'Dual forecast the budget', manpower: 'Dual audited manpower orders', secret: 'Dual private note' };
const ULOS = { fiscal: 3, budget: 4, manpower: 5, secret: 6 };
const shared = [TITLES.fiscal, TITLES.budget];
const never = [TITLES.manpower, TITLES.secret];
/** Goals and cases have their own reads, apart from the entries': one of each shared with every unit, one kept private. */
const GOALS = { fiscal: 'Dual goal shared with fiscal', budget: 'Dual goal shared with budget', manpower: 'Dual goal shared with manpower', secret: 'Dual goal kept private' };
/** The goals of these four a list names, in order. */
const goalsIn = (titles: Array<unknown>) => titles.filter((t): t is string => (Object.values(GOALS) as unknown[]).includes(t)).sort();

/** Whether a PDF's pages draw this text: PDFKit writes a line as hex in its compressed content streams. */
const pdfDraws = (pdf: Buffer, text: string) => {
  const hex = Buffer.from(text, 'latin1').toString('hex');
  const raw = pdf.toString('latin1');
  for (let at = raw.indexOf('stream\n'); at !== -1; at = raw.indexOf('stream\n', at)) {
    const end = raw.indexOf('endstream', at);
    try { if (inflateSync(pdf.subarray(at + 7, end)).toString('latin1').replace(/>\s*-?[\d.]+\s*</g, '').toLowerCase().includes(hex)) return true; } catch { /* not a compressed stream */ }
    at = end + 9;
  }
  return false;
};
const tableOf = (doc: ReportDocument, id: string) => doc.sections.flatMap((s) => s.tables).find((t) => t.id === id);
const lastSeq = () => (app.ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log').get() as { n: number }).n;
const auditedSince = (seq: number, action: string, actor: string) =>
  app.ctx.db.prepare('SELECT unit_id, entity, entity_id, subject_id, detail FROM audit_log WHERE seq > ? AND action = ? AND actor_id = ? ORDER BY seq').all(seq, action, actor) as Array<{ unit_id: string | null; entity: string | null; entity_id: string | null; subject_id: string | null; detail: string | null }>;
/** The titles a body holds, of the four Dual wrote. */
const titlesIn = (text: string) => Object.values(TITLES).filter((t) => text.includes(t)).sort();

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();

  g1lead = await app.register('g1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('g1lead');

  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Budget', short_name: 'BUDGET', code: 'budget', parent_id: 'G8' })).status, 201);
  assert.equal((await post(g1lead.token, '/api/org/units', { name: 'G1 Manpower', short_name: 'MANPOWER', code: 'manpower', parent_id: 'G1' })).status, 201);

  reyes = await app.register('reyes');
  await enroll(app, op.token, 'G8', reyes.id, 'sncoic');
  await enroll(app, g1lead.token, 'G1', reyes.id, 'sncoic');
  reyes.token = await login('reyes');

  dual = await app.register('dual');
  await enroll(app, op.token, 'FISCAL', dual.id);
  await enroll(app, op.token, 'BUDGET', dual.id);
  await enroll(app, g1lead.token, 'MANPOWER', dual.id);
  dual.token = await login('dual');

  mixed = await app.register('mixed');
  await enroll(app, op.token, 'FISCAL', mixed.id, 'snco');
  await enroll(app, op.token, 'BUDGET', mixed.id, 'fire-team-leader');
  mixed.token = await login('mixed');

  plain = await app.register('plain');
  await enroll(app, op.token, 'FISCAL', plain.id);
  plain.token = await login('plain');

  const day = today();
  const log = async (title: string, quantity: number, unit: string, visibility: 'unit' | 'private') => {
    const res = await post(dual.token, '/api/records/activities', { title, date: day, quantity, unit_label: 'ULOs', result: 'Closed out the obligations', visibility, unit_id: unit });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  };
  await log(TITLES.fiscal, ULOS.fiscal, 'FISCAL', 'unit');
  await log(TITLES.budget, ULOS.budget, 'BUDGET', 'unit');
  await log(TITLES.manpower, ULOS.manpower, 'MANPOWER', 'unit');
  // Kept private, though it names a unit: never read about Dual by anyone but Dual.
  await log(TITLES.secret, ULOS.secret, 'FISCAL', 'private');

  // Goals set for Dual in each unit by its leader, and one Dual keeps private that still names FISCAL.
  const goal = async (token: string, title: string, unit: string, visibility: 'unit' | 'private') => {
    const res = await post(token, '/api/records/goals', { title, metric: 'manual', target_value: 10, visibility, unit_id: unit, ...(visibility === 'unit' ? { assignee_id: dual.id } : {}) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  };
  await goal(op.token, GOALS.fiscal, 'FISCAL', 'unit');
  await goal(op.token, GOALS.budget, 'BUDGET', 'unit');
  await goal(g1lead.token, GOALS.manpower, 'MANPOWER', 'unit');
  await goal(dual.token, GOALS.secret, 'FISCAL', 'private');
  assert.deepEqual(app.ctx.db.prepare('SELECT unit_id, visibility FROM goals WHERE title = ?').get(GOALS.secret), { unit_id: 'FISCAL', visibility: 'private' }, 'the private goal is filed under a unit read, so only its visibility keeps it out');

  // A case Dual researched in each unit, and one in a case of Dual's own kept private under FISCAL.
  const researched = async (token: string, unit: string, visibility: 'unit' | 'private') => {
    const item = await post(token, '/api/work/items', { title: `Dual case for ${unit.toLowerCase()}`, unit_id: unit, visibility });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    assert.deepEqual(app.ctx.db.prepare('SELECT unit_id, visibility FROM work_items WHERE id = ?').get(item.body.id), { unit_id: unit, visibility });
    const at = new Date().toISOString();
    app.ctx.db.prepare("INSERT INTO work_events (id, work_item_id, unit_id, actor_id, kind, body, occurred_at, created_at) VALUES (?, ?, ?, ?, 'note', ?, ?, ?)")
      .run(`dual-research-${unit}-${visibility}`, item.body.id, unit, dual.id, JSON.stringify({ text: 'Traced the obligation to its source document' }), at, at);
  };
  await researched(op.token, 'FISCAL', 'unit');
  await researched(op.token, 'BUDGET', 'unit');
  await researched(g1lead.token, 'MANPOWER', 'unit');
  await researched(dual.token, 'FISCAL', 'private');
});
after(async () => { await app.close(); });

test('a Marine’s analysis opened through one unit reads every unit of its Unit Instance where the reader opens them, and nothing of another', async () => {
  const about = { user_id: dual.id, unit_id: 'FISCAL' };

  const analysis = await get(reyes.token, `/api/reports/analysis?${q({ ...about, period: 'last30' })}`);
  assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
  assert.deepEqual(analysis.body.appendix.map((r: { title: string }) => r.title).sort(), [...shared].sort());
  assert.deepEqual(analysis.body.units.map((u: { id: string }) => u.id), ['FISCAL', 'BUDGET'], 'the unit asked for first, then the rest of its instance');
  assert.equal(analysis.body.unit.id, 'FISCAL', 'the analysis names the unit it was opened through, by its id');
  assert.deepEqual(titlesIn(JSON.stringify(analysis.body)), [...shared].sort());

  const report = await get(reyes.token, `/api/reports?${q({ ...about, period: 'last30' })}`);
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.deepEqual(report.body.activities.map((r: { title: string }) => r.title).sort(), [...shared].sort());
  assert.deepEqual(report.body.units, [{ id: 'FISCAL', name: 'G8 Fiscal', short_name: 'FISCAL' }, { id: 'BUDGET', name: 'G8 Budget', short_name: 'BUDGET' }]);
  assert.equal(report.body.unit.id, 'FISCAL');
  assert.deepEqual(titlesIn(JSON.stringify(report.body)), [...shared].sort());

  const delta = await get(reyes.token, `/api/reports/delta?${q({ ...about, period: 'last30' })}`);
  assert.equal(delta.status, 200, JSON.stringify(delta.body));
  assert.equal(delta.body.headline.activities.current, 2, 'the comparison counts the two shared entries');

  const csv = await get(reyes.token, `/api/reports/csv?${q({ ...about, period: 'last30' })}`);
  assert.equal(csv.status, 200, csv.text.slice(0, 200));
  assert.deepEqual(titlesIn(csv.text), [...shared].sort());

  const pdf = await file(reyes.token, `/api/reports/analysis.pdf?${q({ ...about, period: 'last30' })}`);
  assert.equal(pdf.status, 200);
  for (const t of shared) assert.ok(pdfDraws(pdf.buffer!, t), `the analysis PDF lists ${t}`);
  for (const t of never) assert.ok(!pdfDraws(pdf.buffer!, t), `the analysis PDF never lists ${t}`);
  const input = await file(reyes.token, `/api/reports/pdf?${q({ ...about, period: 'last30' })}`);
  assert.equal(input.status, 200);
  assert.ok(pdfDraws(input.buffer!, 'FISCAL, BUDGET'), 'the input PDF names both units it was drawn from');
  assert.ok(!pdfDraws(input.buffer!, 'MANPOWER'), 'the input PDF names no unit of another instance');
  for (const t of shared) assert.ok(pdfDraws(input.buffer!, t), `the input PDF lists ${t}`);
  for (const t of never) assert.ok(!pdfDraws(input.buffer!, t), `the input PDF never lists ${t}`);

  // The figures and the outcomes behind them count the same two entries.
  const metrics = await get(reyes.token, `/api/metrics?${q({ ...about, period: 'last30' })}`);
  assert.equal(metrics.status, 200, JSON.stringify(metrics.body));
  const ulos = metrics.body.headline.find((t: { metricId: string }) => t.metricId === 'quantity:ulo');
  assert.equal(ulos.value, ULOS.fiscal + ULOS.budget);
  assert.equal(ulos.outcomes, 2);
  const behind = await get(reyes.token, `/api/metrics/contributors?${q({ ...about, period: 'last30', metric_id: 'quantity:ulo' })}`);
  assert.equal(behind.status, 200, JSON.stringify(behind.body));
  assert.equal(behind.body.count, 2);
  assert.deepEqual(behind.body.records.map((r: { title: string }) => r.title).sort(), [...shared].sort());
  assert.deepEqual([...new Set(behind.body.records.map((r: { unit_id: string }) => r.unit_id))].sort(), ['BUDGET', 'FISCAL']);

  // The Report library reads the same set, for the individual report and for one that lists records.
  const individual = await get(reyes.token, `/api/report-center/run?${q({ type: 'individual', ...about, period: 'last30' })}`);
  assert.equal(individual.status, 200, JSON.stringify(individual.body));
  assert.deepEqual(tableOf(individual.body, 'ledger')!.rows.map((r) => r.title).sort(), [...shared].sort());
  assert.ok(individual.body.notes.includes('Drawn from what the Marine shared with G8 Fiscal, G8 Budget. Private entries are never included.'), JSON.stringify(individual.body.notes));
  const activity = await get(reyes.token, `/api/report-center/run?${q({ type: 'activity', subject: 'member', ...about, period: 'last30' })}`);
  assert.equal(activity.status, 200, JSON.stringify(activity.body));
  assert.deepEqual(titlesIn(JSON.stringify(activity.body)), [...shared].sort());
  const sheet = await get(reyes.token, `/api/report-center/export?${q({ type: 'activity', subject: 'member', ...about, period: 'last30', format: 'csv' })}`);
  assert.equal(sheet.status, 200, sheet.text.slice(0, 200));
  assert.deepEqual(titlesIn(sheet.text), [...shared].sort());

  // Opened through the other instance, the same reader reads that instance's unit alone; through G1 itself, which Dual
  // does not belong to, it falls back to the unit there.
  for (const unit of ['MANPOWER', 'G1']) {
    const there = await get(reyes.token, `/api/reports/analysis?${q({ user_id: dual.id, unit_id: unit, period: 'last30' })}`);
    assert.equal(there.status, 200, JSON.stringify(there.body));
    assert.deepEqual(titlesIn(JSON.stringify(there.body)), [TITLES.manpower]);
    assert.deepEqual(there.body.units.map((u: { id: string }) => u.id), ['MANPOWER']);
    const figures = await get(reyes.token, `/api/metrics?${q({ user_id: dual.id, unit_id: unit, period: 'last30' })}`);
    assert.equal(figures.body.headline.find((t: { metricId: string }) => t.metricId === 'quantity:ulo').value, ULOS.manpower);
  }
  // With no unit named, the Marine's first unit picks the instance, and the set never spans two.
  const unnamed = await get(reyes.token, `/api/reports/analysis?${q({ user_id: dual.id, period: 'last30' })}`);
  assert.equal(unnamed.status, 200);
  assert.deepEqual(unnamed.body.units.map((u: { id: string }) => u.id), ['FISCAL', 'BUDGET']);
});

test('a reader who opens the Marine in one unit of the Unit Instance reads that unit alone, not the rest of it', async () => {
  // A SNCO of FISCAL alone: Dual is also in BUDGET, where this reader opens nobody's records.
  const fiscalOnly = await app.register('fiscalonly');
  await enroll(app, op.token, 'FISCAL', fiscalOnly.id, 'snco');
  const token = await login('fiscalonly');
  const page = await get(token, `/api/org/team/${dual.id}`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.deepEqual(page.body.detailUnits, ['FISCAL']);
  assert.equal(page.body.counts.activities, 1);

  // Asked through BUDGET, a unit of the same instance the reader does not open Dual in, it falls back to FISCAL.
  for (const unit of ['FISCAL', 'BUDGET']) {
    const about = { user_id: dual.id, unit_id: unit, period: 'last30' };
    const from = lastSeq();
    const analysis = await get(token, `/api/reports/analysis?${q(about)}`);
    assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
    assert.deepEqual(analysis.body.units.map((u: { id: string }) => u.id), ['FISCAL'], unit);
    assert.deepEqual(titlesIn(JSON.stringify(analysis.body)), [TITLES.fiscal], unit);
    assert.deepEqual(auditedSince(from, 'build_report', fiscalOnly.id).map((r) => r.unit_id), ['FISCAL'], `${unit}: the read is logged in FISCAL alone`);
    const report = await get(token, `/api/reports?${q(about)}`);
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.deepEqual(report.body.units.map((u: { id: string }) => u.id), ['FISCAL'], unit);
    assert.deepEqual(titlesIn(JSON.stringify(report.body)), [TITLES.fiscal], unit);
    const delta = await get(token, `/api/reports/delta?${q(about)}`);
    assert.equal(delta.body.headline.activities.current, 1, unit);
    const csv = await get(token, `/api/reports/csv?${q(about)}`);
    assert.equal(csv.status, 200, csv.text.slice(0, 200));
    assert.deepEqual(titlesIn(csv.text), [TITLES.fiscal], unit);
    const figures = await get(token, `/api/metrics?${q(about)}`);
    assert.equal(figures.body.headline.find((t: { metricId: string }) => t.metricId === 'quantity:ulo').value, ULOS.fiscal, unit);
    const behind = await get(token, `/api/metrics/contributors?${q({ ...about, metric_id: 'quantity:ulo' })}`);
    assert.equal(behind.body.count, 1, unit);
    const individual = await get(token, `/api/report-center/run?${q({ type: 'individual', ...about })}`);
    assert.equal(individual.status, 200, JSON.stringify(individual.body));
    assert.deepEqual(tableOf(individual.body, 'ledger')!.rows.map((r) => r.title), [TITLES.fiscal], unit);
    assert.equal(individual.body.unit, 'G8 Fiscal', unit);
  }
  const pdf = await file(token, `/api/reports/analysis.pdf?${q({ user_id: dual.id, unit_id: 'FISCAL', period: 'last30' })}`);
  assert.equal(pdf.status, 200);
  assert.ok(pdfDraws(pdf.buffer!, TITLES.fiscal));
  assert.ok(!pdfDraws(pdf.buffer!, TITLES.budget), 'the PDF never lists what was shared with BUDGET alone');
});

test('another Unit Instance’s unit is refused rather than answered, on every reader about the Marine', async () => {
  const paths = (user: string, unit: string) => [
    `/api/reports?${q({ user_id: user, unit_id: unit, period: 'last30' })}`,
    `/api/reports/delta?${q({ user_id: user, unit_id: unit, period: 'last30' })}`,
    `/api/reports/analysis?${q({ user_id: user, unit_id: unit, period: 'last30' })}`,
    `/api/reports/analysis.pdf?${q({ user_id: user, unit_id: unit, period: 'last30' })}`,
    `/api/reports/pdf?${q({ user_id: user, unit_id: unit, period: 'last30' })}`,
    `/api/reports/csv?${q({ user_id: user, unit_id: unit, period: 'last30' })}`,
    `/api/metrics?${q({ user_id: user, unit_id: unit, period: 'last30' })}`,
    `/api/metrics/contributors?${q({ user_id: user, unit_id: unit, period: 'last30', metric_id: 'quantity:ulo' })}`,
    `/api/report-center/run?${q({ type: 'individual', user_id: user, unit_id: unit, period: 'last30' })}`,
  ];
  // G8's owner leads Dual only in G8; G1's owner only in G1. Each is refused the other's unit, and told why.
  for (const [who, unit] of [[op, 'MANPOWER'], [g1lead, 'FISCAL']] as const) {
    for (const path of paths(dual.id, unit)) {
      const res = await get(who.token, path);
      assert.equal(res.status, 403, `${path}: ${res.text.slice(0, 200)}`);
      assert.equal(res.body?.code, 'cross_instance', path);
      assert.deepEqual(titlesIn(res.text), [], path);
    }
  }
  // A Marine who opens nobody's records is refused whatever unit they name.
  for (const path of paths(dual.id, 'FISCAL')) {
    const res = await get(plain.token, path);
    assert.equal(res.status, 403, path);
    assert.deepEqual(titlesIn(res.text), [], path);
  }
  // G1's owner reads Dual through G1 alone.
  const g1 = await get(g1lead.token, `/api/reports/analysis?${q({ user_id: dual.id, period: 'last30' })}`);
  assert.equal(g1.status, 200, JSON.stringify(g1.body));
  assert.deepEqual(titlesIn(JSON.stringify(g1.body)), [TITLES.manpower]);
});

test('the Marine’s page counts what their Analysis counts, for a leader in one Unit Instance', async () => {
  const page = await get(op.token, `/api/org/team/${dual.id}`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.deepEqual(page.body.detailUnits, ['FISCAL', 'BUDGET']);
  assert.deepEqual(page.body.detailInstances, [{ org_id: 'G8', org_name: 'G8', units: [{ id: 'FISCAL', name: 'G8 Fiscal', short_name: 'FISCAL' }, { id: 'BUDGET', name: 'G8 Budget', short_name: 'BUDGET' }] }]);
  assert.doesNotMatch(JSON.stringify(page.body), /MANPOWER|G1 Manpower|MARFORRES/, 'a leader in G8 is not told where else Dual serves');

  // The page's link opens the Analysis through its first unit, which reads the page's units: the counts agree.
  const analysis = await get(op.token, `/api/reports/analysis?${q({ user_id: dual.id, unit_id: page.body.detailUnits[0], period: 'all' })}`);
  assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
  assert.equal(analysis.body.counts.current, page.body.counts.activities);
  assert.equal(page.body.counts.activities, 2);
  assert.deepEqual(analysis.body.units.map((u: { id: string }) => u.id), page.body.detailUnits);

  // The page's figures, read through the same unit, count the same entries.
  const figures = await get(op.token, `/api/metrics?${q({ user_id: dual.id, unit_id: page.body.detailUnits[0], period: 'last12' })}`);
  assert.equal(figures.status, 200, JSON.stringify(figures.body));
  assert.equal(figures.body.headline.find((t: { metricId: string }) => t.metricId === 'quantity:ulo').outcomes, analysis.body.counts.current);

  // A leader in both instances is offered each instance on its own, the unit of the first first.
  const both = await get(reyes.token, `/api/org/team/${dual.id}`);
  assert.equal(both.status, 200, JSON.stringify(both.body));
  // Each is named as its button names it: by its short name, or by its name when it has none (G1 was given none).
  assert.deepEqual(both.body.detailInstances.map((i: { org_id: string; org_name: string | null; units: Array<{ id: string }> }) => [i.org_id, i.org_name, i.units.map((u) => u.id)]), [['G8', 'G8', ['FISCAL', 'BUDGET']], ['G1', 'MARFORRES G-1', ['MANPOWER']]]);
});

test('a read about another Marine is in the access log of every unit it read, and of no other', async () => {
  const from = lastSeq();
  const res = await get(reyes.token, `/api/reports/analysis?${q({ user_id: dual.id, unit_id: 'FISCAL', period: 'last30' })}`);
  assert.equal(res.status, 200);
  const rows = auditedSince(from, 'build_report', reyes.id);
  assert.deepEqual(rows.map((r) => r.unit_id).sort(), ['BUDGET', 'FISCAL'], 'one entry for each unit read');
  for (const r of rows) {
    assert.equal(r.entity, 'user');
    assert.equal(r.entity_id, dual.id);
    assert.equal(r.subject_id, dual.id);
  }
  // Each unit's own access log lists the read.
  for (const unit of ['FISCAL', 'BUDGET']) {
    const log = await get(op.token, `/api/org/units/${unit}/audit`);
    assert.equal(log.status, 200, JSON.stringify(log.body));
    assert.ok(log.body.rows.some((r: { action: string; actor_id: string; seq: number }) => r.action === 'build_report' && r.actor_id === reyes.id && r.seq > from), `${unit}'s log lists the read`);
  }
  // Read through MANPOWER, only MANPOWER's log has it.
  const next = lastSeq();
  assert.equal((await get(reyes.token, `/api/reports?${q({ user_id: dual.id, unit_id: 'MANPOWER', period: 'last30' })}`)).status, 200);
  assert.deepEqual(auditedSince(next, 'build_report', reyes.id).map((r) => r.unit_id), ['MANPOWER']);
  // One's own report is no read of another, and writes none.
  const own = lastSeq();
  assert.equal((await get(dual.token, `/api/reports/analysis?${q({ period: 'last30' })}`)).status, 200);
  assert.deepEqual(auditedSince(own, 'build_report', dual.id), []);
});

test('a Report library read, print or file about another Marine is in the access log of every unit it read', async () => {
  const about = { user_id: dual.id, unit_id: 'FISCAL', period: 'last30' };
  const from = lastSeq();
  const viewed = await get(reyes.token, `/api/report-center/run?${q({ type: 'individual', ...about })}`);
  assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
  assert.equal(viewed.body.unit, 'G8 Fiscal, G8 Budget', 'its Unit line names every unit it read, the one opened through first');
  assert.equal((await get(reyes.token, `/api/report-center/run?${q({ type: 'activity', subject: 'member', ...about, purpose: 'print' })}`)).status, 200);
  const sheet = await get(reyes.token, `/api/report-center/export?${q({ type: 'activity', subject: 'member', ...about, format: 'csv' })}`);
  assert.equal(sheet.status, 200, sheet.text.slice(0, 200));
  for (const action of ['view_report', 'print_report', 'export_report']) {
    const rows = auditedSince(from, action, reyes.id);
    assert.deepEqual(rows.map((r) => r.unit_id).sort(), ['BUDGET', 'FISCAL'], `${action}: one entry for each unit read`);
    for (const r of rows) {
      assert.equal(r.entity, 'report', action);
      assert.equal(r.subject_id, dual.id, action);
    }
  }
  // BUDGET's own access log lists all three, though the reader opened Dual through FISCAL.
  const budget = await get(op.token, `/api/org/units/BUDGET/audit?${q({ person: reyes.id })}`);
  assert.equal(budget.status, 200, JSON.stringify(budget.body));
  for (const action of ['view_report', 'print_report', 'export_report']) {
    assert.ok(budget.body.rows.some((r: { action: string; actor_id: string; subject_id: string; seq: number }) => r.action === action && r.actor_id === reyes.id && r.subject_id === dual.id && r.seq > from), `BUDGET's log lists the ${action}`);
  }
  // Read through MANPOWER, only MANPOWER's log has it.
  const there = lastSeq();
  assert.equal((await get(reyes.token, `/api/report-center/run?${q({ type: 'individual', user_id: dual.id, unit_id: 'MANPOWER', period: 'last30' })}`)).status, 200);
  assert.deepEqual(auditedSince(there, 'view_report', reyes.id).map((r) => r.unit_id), ['MANPOWER']);
  // One's own report and a unit's report stay one entry each: none for one's own on screen, one for its print, and one
  // under the unit for a unit's report.
  const own = lastSeq();
  assert.equal((await get(dual.token, `/api/report-center/run?${q({ type: 'individual', period: 'last30' })}`)).status, 200);
  assert.deepEqual(auditedSince(own, 'view_report', dual.id), []);
  assert.equal((await get(dual.token, `/api/report-center/run?${q({ type: 'individual', period: 'last30', purpose: 'print' })}`)).status, 200);
  assert.deepEqual(auditedSince(own, 'print_report', dual.id).map((r) => r.unit_id), [null]);
  const unit = lastSeq();
  assert.equal((await get(op.token, `/api/report-center/run?${q({ type: 'unit', unit_id: 'FISCAL', period: 'last30' })}`)).status, 200);
  assert.deepEqual(auditedSince(unit, 'view_report', op.id).map((r) => r.unit_id), ['FISCAL']);
});

test('opening a Marine’s page is in the access log of every unit it lists, in each Unit Instance', async () => {
  const from = lastSeq();
  const page = await get(reyes.token, `/api/org/team/${dual.id}`);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  assert.deepEqual(page.body.detailUnits, ['FISCAL', 'BUDGET', 'MANPOWER']);
  const rows = app.ctx.db.prepare("SELECT unit_id, org_id, entity, entity_id, subject_id FROM audit_log WHERE seq > ? AND action = 'view_member' AND actor_id = ? ORDER BY seq").all(from, reyes.id) as Array<{ unit_id: string; org_id: string; entity: string; entity_id: string; subject_id: string }>;
  assert.deepEqual(rows.map((r) => [r.unit_id, r.org_id]), [['FISCAL', 'G8'], ['BUDGET', 'G8'], ['MANPOWER', 'G1']], 'one entry for each unit the page lists, each in its own Unit Instance');
  for (const r of rows) assert.deepEqual([r.entity, r.entity_id, r.subject_id], ['user', dual.id, dual.id]);
  // Each unit's own access log lists the read, and so does each instance's trail.
  for (const [unit, reader] of [['FISCAL', op], ['BUDGET', op], ['MANPOWER', g1lead]] as const) {
    const log = await get(reader.token, `/api/org/units/${unit}/audit?${q({ person: reyes.id })}`);
    assert.equal(log.status, 200, JSON.stringify(log.body));
    assert.ok(log.body.rows.some((r: { action: string; actor_id: string; subject_id: string; seq: number }) => r.action === 'view_member' && r.actor_id === reyes.id && r.subject_id === dual.id && r.seq > from), `${unit}'s log lists the read`);
  }
  const g1 = await get(g1lead.token, `/api/orgs/G1/audit?${q({ person: dual.id })}`);
  assert.equal(g1.status, 200, JSON.stringify(g1.body));
  assert.ok(g1.body.rows.some((r: { action: string; actor_id: string; seq: number }) => r.action === 'view_member' && r.actor_id === reyes.id && r.seq > from), 'G1’s trail lists the read');
  // A leader in one instance writes entries in that instance alone; one's own page writes none.
  const op1 = lastSeq();
  assert.equal((await get(op.token, `/api/org/team/${dual.id}`)).status, 200);
  assert.deepEqual(auditedSince(op1, 'view_member', op.id).map((r) => r.unit_id), ['FISCAL', 'BUDGET']);
  const own = lastSeq();
  assert.equal((await get(dual.token, `/api/org/team/${dual.id}`)).status, 200);
  assert.deepEqual(auditedSince(own, 'view_member', dual.id), []);
});

test('the records behind another Marine’s figure are a read of theirs, kept in the log of each unit they came from', async () => {
  const about = { user_id: dual.id, unit_id: 'FISCAL', period: 'last30' };
  const from = lastSeq();
  const behind = await get(op.token, `/api/metrics/contributors?${q({ ...about, metric_id: 'quantity:ulo' })}`);
  assert.equal(behind.status, 200, JSON.stringify(behind.body));
  assert.deepEqual(behind.body.records.map((r: { title: string }) => r.title).sort(), [...shared].sort());
  const listed = auditedSince(from, 'list_records', op.id);
  assert.deepEqual(listed.map((r) => r.unit_id).sort(), ['BUDGET', 'FISCAL'], 'one entry for each unit the records came from');
  for (const r of listed) assert.deepEqual([r.entity, r.subject_id], ['activities', dual.id]);
  const budget = await get(op.token, `/api/org/units/BUDGET/audit?${q({ person: dual.id })}`);
  assert.ok(budget.body.rows.some((r: { action: string; actor_id: string; seq: number }) => r.action === 'list_records' && r.actor_id === op.id && r.seq > from), 'BUDGET’s log lists the read');
  // Opened again within five minutes, the same list writes nothing more, as any list of records.
  const again = lastSeq();
  assert.equal((await get(op.token, `/api/metrics/contributors?${q({ ...about, metric_id: 'quantity:ulo' })}`)).status, 200);
  assert.deepEqual(auditedSince(again, 'list_records', op.id), []);
  // The figures alone name no record and are not audited.
  const figures = lastSeq();
  assert.equal((await get(op.token, `/api/metrics?${q(about)}`)).status, 200);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE seq > ? AND actor_id = ?').get(figures, op.id) as { n: number }).n, 0);
  // Through MANPOWER, only MANPOWER's; one's own records are no read of another's, and write none.
  const there = lastSeq();
  assert.equal((await get(reyes.token, `/api/metrics/contributors?${q({ user_id: dual.id, unit_id: 'MANPOWER', period: 'last30', metric_id: 'quantity:ulo' })}`)).status, 200);
  assert.deepEqual(auditedSince(there, 'list_records', reyes.id).map((r) => r.unit_id), ['MANPOWER']);
  const own = lastSeq();
  for (const path of [`/api/metrics/contributors?${q({ period: 'last30', metric_id: 'quantity:ulo' })}`, `/api/metrics/contributors?${q({ user_id: dual.id, period: 'last30', metric_id: 'quantity:ulo' })}`]) {
    const mine = await get(dual.token, path);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.count, 4, `${path}: one’s own list holds every unit, the private entry included`);
    assert.deepEqual(mine.body.records.map((r: { title: string }) => r.title).sort(), Object.values(TITLES).sort(), path);
  }
  assert.deepEqual(auditedSince(own, 'list_records', dual.id), []);
});

test('goals and case work about another Marine come from the same units, and a private goal never does', async () => {
  const through = async (token: string, unit: string | null) => {
    const about: Record<string, string> = unit ? { user_id: dual.id, unit_id: unit, period: 'last30' } : { period: 'last30' };
    const analysis = await get(token, `/api/reports/analysis?${q(about)}`);
    assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
    const report = await get(token, `/api/reports?${q(about)}`);
    assert.equal(report.status, 200, JSON.stringify(report.body));
    const individual = await get(token, `/api/report-center/run?${q({ type: 'individual', ...about })}`);
    assert.equal(individual.status, 200, JSON.stringify(individual.body));
    const dataset = await get(token, `/api/report-center/run?${q({ type: 'custom', dataset: 'goals', ...about, ...(unit ? { subject: 'member' } : {}), period: 'all' })}`);
    assert.equal(dataset.status, 200, JSON.stringify(dataset.body));
    return {
      analysis: goalsIn(analysis.body.goals.items.map((g: { title: string }) => g.title)),
      individual: goalsIn(tableOf(individual.body, 'goals')!.rows.map((r) => r.title)),
      dataset: goalsIn(tableOf(dataset.body, 'rows')!.rows.map((r) => r.title)),
      researched: report.body.casework.researched as number,
    };
  };
  const both = [GOALS.budget, GOALS.fiscal].sort();
  // Opened through FISCAL: what was shared with FISCAL and BUDGET, never MANPOWER's, never the private goal or case.
  assert.deepEqual(await through(reyes.token, 'FISCAL'), { analysis: both, individual: both, dataset: both, researched: 2 });
  // Through MANPOWER: that instance's unit alone.
  assert.deepEqual(await through(reyes.token, 'MANPOWER'), { analysis: [GOALS.manpower], individual: [GOALS.manpower], dataset: [GOALS.manpower], researched: 1 });
  // G8's owner, a leader in one instance, reads the same set through FISCAL.
  assert.deepEqual(await through(op.token, 'FISCAL'), { analysis: both, individual: both, dataset: both, researched: 2 });
  // Dual's own read every goal and every case, the private ones included.
  const all = Object.values(GOALS).sort();
  assert.deepEqual(await through(dual.token, null), { analysis: all, individual: all, dataset: all, researched: 4 });
});

test('a file about another Marine needs the export permission in every unit read, and leaves only while the reader still opens each', async () => {
  const about = { user_id: dual.id, unit_id: 'FISCAL', period: 'last30' };
  // Mixed opens Dual in both teams, so their Analysis reads both, but may export only from FISCAL.
  const analysis = await get(mixed.token, `/api/reports/analysis?${q(about)}`);
  assert.equal(analysis.status, 200, JSON.stringify(analysis.body));
  assert.deepEqual(analysis.body.units.map((u: { id: string }) => u.id), ['FISCAL', 'BUDGET']);
  const csv = await get(mixed.token, `/api/reports/csv?${q(about)}`);
  assert.equal(csv.status, 403, csv.text.slice(0, 200));
  assert.deepEqual(titlesIn(csv.text), []);
  assert.equal((await get(reyes.token, `/api/reports/csv?${q(about)}`)).status, 200, 'with the export permission in both');
  const library = await get(mixed.token, `/api/report-center/run?${q({ type: 'individual', ...about })}`);
  assert.equal(library.status, 200, JSON.stringify(library.body));
  assert.deepEqual(library.body.files, ['pdf'], 'a PDF, but no spreadsheet or data file without the export permission in BUDGET');
  assert.equal((await get(mixed.token, `/api/report-center/export?${q({ type: 'individual', ...about, format: 'csv' })}`)).status, 403);

  // Their Fire Team Leader role in BUDGET ends while a PDF is drawn, the analysis PDF or the FITREP/JEPES input PDF: it is
  // refused, and not audited as sent. Each is checked on its own, so neither relies on the other's recheck.
  const role = 'BUDGET:fire-team-leader';
  const grants = app.ctx.db.prepare('SELECT * FROM member_roles WHERE user_id = ? AND role_id = ?').all(mixed.id, role) as Array<Record<string, unknown>>;
  assert.equal(grants.length, 1);
  for (const path of ['/api/reports/analysis.pdf', '/api/reports/pdf']) {
    const sent = (app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export_pdf' AND actor_id = ?").get(mixed.id) as { n: number }).n;
    const realEnd = PDFDocument.prototype.end;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let arrived!: () => void;
    const seen = new Promise<void>((r) => { arrived = r; });
    try {
      PDFDocument.prototype.end = function (this: PDFKit.PDFDocument) {
        PDFDocument.prototype.end = realEnd;
        arrived();
        void gate.then(() => realEnd.call(this));
      };
      const drawing = file(mixed.token, `${path}?${q(about)}`);
      await seen;
      app.ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?').run(mixed.id, role);
      release();
      const refused = await drawing;
      assert.equal(refused.status, 403, path);
      assert.equal(JSON.parse(refused.buffer!.toString('utf8')).code, 'access_changed', path);
      assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export_pdf' AND actor_id = ?").get(mixed.id) as { n: number }).n, sent, `${path}: nothing audited as exported`);
    } finally {
      release();
      PDFDocument.prototype.end = realEnd;
      for (const g of grants) app.ctx.db.prepare(`INSERT OR IGNORE INTO member_roles (${Object.keys(g).join(', ')}) VALUES (${Object.keys(g).map(() => '?').join(', ')})`).run(...Object.values(g) as never[]);
    }
    // With the role back, the same PDF leaves, and is audited as sent.
    assert.equal((await file(mixed.token, `${path}?${q(about)}`)).status, 200, path);
    assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export_pdf' AND actor_id = ?").get(mixed.id) as { n: number }).n, sent + 1, path);
  }
});

test('an analysis gives no average strength of another Marine, and the Marine still sees their own', async () => {
  const theirs = await get(reyes.token, `/api/reports/analysis?${q({ user_id: dual.id, unit_id: 'FISCAL', period: 'last30' })}`);
  assert.equal(theirs.status, 200);
  assert.equal(theirs.body.coverage.avgStrength, null);
  assert.ok(!theirs.body.summary.some((s: string) => /strength/.test(s)), JSON.stringify(theirs.body.summary));
  assert.ok(theirs.body.appendix.every((r: { strength: number }) => typeof r.strength === 'number'), 'each entry keeps its own score');
  const pdf = await file(reyes.token, `/api/reports/analysis.pdf?${q({ user_id: dual.id, unit_id: 'FISCAL', period: 'last30' })}`);
  assert.equal(pdf.status, 200);
  assert.ok(!pdfDraws(pdf.buffer!, 'Average strength'), 'the PDF about another Marine gives no average');
  const library = await get(reyes.token, `/api/report-center/run?${q({ type: 'individual', user_id: dual.id, unit_id: 'FISCAL', period: 'last30' })}`);
  assert.ok(!JSON.stringify(library.body).includes('for strength'), 'nor does the Report library');

  const own = await get(dual.token, `/api/reports/analysis?${q({ period: 'last30' })}`);
  assert.equal(own.status, 200);
  assert.equal(typeof own.body.coverage.avgStrength, 'number');
  assert.ok(own.body.summary.some((s: string) => / of 5 for strength/.test(s)), JSON.stringify(own.body.summary));
  assert.deepEqual(own.body.units, [], 'one’s own analysis reads every record, in no unit');
  assert.deepEqual(titlesIn(JSON.stringify(own.body)), Object.values(TITLES).sort(), 'one’s own includes the private entry');
  const ownPdf = await file(dual.token, `/api/reports/analysis.pdf?${q({ period: 'last30' })}`);
  assert.ok(pdfDraws(ownPdf.buffer!, 'Average strength'), 'the Marine’s own PDF keeps it');
});
