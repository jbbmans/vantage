import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { orgOfUnit } from '../../server/authz/scope.ts';
import { privacyActStatement, PRIVACY_ACT_STATEMENT_MAX } from '../../server/config.ts';
import { readWorkbook } from '../../server/lib/workbook.ts';
import { zonedDay } from '../../server/lib/clock.ts';
import type { MarineStatistics } from '../../shared/marineStatistics.ts';
import type { ReportDocument } from '../../shared/reportCatalog.ts';
import type { Visual } from '../../shared/unitAnalytics.ts';

/**
 * A Marine's statistics (ADR-0051). Dual serves in FISCAL and BUDGET, two teams of G8, and in MANPOWER, a team of G1.
 * Reyes is SNCOIC of G8 and of G1. Read about Dual through FISCAL, the statistics read FISCAL and BUDGET, never
 * MANPOWER and never a private record, and every figure is the figure the Analysis and the Duty report give for the
 * same range. A reader outside Dual's chain, a Unit Manager, Vantage staff and a unit of another Unit Instance are
 * refused before anything is read.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let g1lead: { token: string; id: string };
let reyes: { token: string; id: string };
let dual: { token: string; id: string };
/** Opens Dual's records in FISCAL (SNCO, who may export) and in BUDGET (Fire Team Leader, who may not). */
let mixed: { token: string; id: string };
/** Fire Team Leader of FISCAL: opens Dual's records there, manages nobody. */
let ftl: { token: string; id: string };
/** A Marine of FISCAL who opens nobody's records. */
let plain: { token: string; id: string };
let unitmgr: { token: string; id: string };
let staff: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const file = (token: string, path: string) => app.call('GET', path, { token, binary: true });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
const lastSeq = () => (app.ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log').get() as { n: number }).n;
const auditedSince = (seq: number, action: string) =>
  app.ctx.db.prepare('SELECT actor_id, unit_id, entity_id, subject_id, detail FROM audit_log WHERE seq > ? AND action = ? ORDER BY seq').all(seq, action) as Array<{ actor_id: string; unit_id: string | null; entity_id: string; subject_id: string | null; detail: string | null }>;

/** A visual of the statistics, by id. */
const visual = (s: MarineStatistics, id: string): Visual => {
  const v = s.sections.flatMap((x) => x.visuals).find((x) => x.id === id);
  assert.ok(v, `the statistics draw ${id}`);
  return v!;
};
const tile = (s: MarineStatistics, id: string, key: string) => visual(s, id).buckets.find((b) => b.key === key)?.value;
const bar = (s: MarineStatistics, id: string, key: string) => visual(s, id).buckets.find((b) => b.key === key)?.value ?? 0;

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

const D = today();
const dayAfter = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const ULOS = { fiscal: 3, budget: 4, manpower: 5, secret: 6 };
/** A placeholder for the statement a deployment sets: not legal text. */
const STATEMENT = 'AUTHORITY: The statement this deployment sets.\nPRINCIPAL PURPOSE: A placeholder for the tests.';

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
  ftl = await app.register('ftl');
  await enroll(app, op.token, 'FISCAL', ftl.id, 'fire-team-leader');
  ftl.token = await login('ftl');
  plain = await app.register('plain');
  await enroll(app, op.token, 'FISCAL', plain.id);
  plain.token = await login('plain');
  unitmgr = await app.register('unitmgr');
  await enroll(app, op.token, 'G8', unitmgr.id);
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: unitmgr.id, role: 'admin' })).status, 201);
  unitmgr.token = await login('unitmgr');
  staff = await app.register('staff');
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(staff.id);
  assert.equal((await post(op.token, '/api/platform/staff', { user_id: staff.id, role: 'admin' })).status, 201);
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(staff.id);
  staff.token = await login('staff');

  // Entries: one shared with each unit, one kept private under FISCAL, and one planned in FISCAL that counts once done.
  const log = async (title: string, quantity: number, unit: string, visibility: 'unit' | 'private', extra: Record<string, unknown> = {}) => {
    const res = await post(dual.token, '/api/records/activities', { title, date: D, quantity, unit_label: 'ULOs', result: 'Closed out the obligations', visibility, unit_id: unit, eval_area: 'Mission accomplishment', ...extra });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  };
  await log('Dual balanced the fiscal ledger', ULOS.fiscal, 'FISCAL', 'unit', { dollar_amount: 1200, dollar_type: 'saved' });
  await log('Dual forecast the budget', ULOS.budget, 'BUDGET', 'unit', { result: '' });
  await log('Dual audited manpower orders', ULOS.manpower, 'MANPOWER', 'unit');
  await log('Dual private note', ULOS.secret, 'FISCAL', 'private', { dollar_amount: 900, dollar_type: 'saved' });
  await log('Dual will reconcile next week', 1, 'FISCAL', 'unit', { status: 'planned' });

  // Training: shared with FISCAL and MANPOWER, and private study.
  for (const [title, hours, unit, visibility] of [['Fiscal law', 4, 'FISCAL', 'unit'], ['Manpower course', 2, 'MANPOWER', 'unit'], ['Private study', 9, null, 'private']] as const) {
    const res = await post(dual.token, '/api/records/trainings', { title, date: dayAfter(D, -2), status: 'completed', hours, type: 'course', visibility, ...(unit ? { unit_id: unit } : {}) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }

  // Duty, put there directly so the test says exactly how each stands and who recorded it.
  const at = new Date().toISOString();
  const type = app.ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)');
  type.run('st-od', orgOfUnit(app.ctx, 'G8'), 'OD', 'Officer of the Day', at, at);
  type.run('st-dnco', orgOfUnit(app.ctx, 'G8'), 'DNCO', 'Duty NCO', at, at);
  type.run('st-g1', orgOfUnit(app.ctx, 'G1'), 'SDO', 'Staff Duty Officer', at, at);
  let n = 0;
  const duty = (unit: string, typeId: string, status: 'pending' | 'approved' | 'returned', hours: number, recordedBy: string, date = dayAfter(D, -3)) => {
    const decided = status !== 'pending';
    app.ctx.db.prepare(`INSERT INTO duties (id, user_id, unit_id, duty_type_id, date, start_time, end_date, end_time, hours, days, recorded_by, submitted_at, approval_status, reviewed_by, reviewed_at, review_reason,
        approved_points, calculated_points, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '08:00', ?, '16:00', ?, 1, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?)`)
      .run(`st-duty-${n++}`, dual.id, unit, typeId, date, date, hours, recordedBy, at, status, decided ? reyes.id : null, decided ? at : null, status === 'returned' ? 'Add the relief.' : null, status === 'approved' ? 2.5 : null, at, at);
  };
  duty('FISCAL', 'st-od', 'approved', 8, dual.id);
  duty('BUDGET', 'st-dnco', 'pending', 4, dual.id);
  // Recorded for Dual by Reyes: Dual's duty, not something Dual added.
  duty('FISCAL', 'st-dnco', 'returned', 6, reyes.id);
  duty('MANPOWER', 'st-g1', 'approved', 12, dual.id);
  // Stood before the range: never counted in it.
  duty('FISCAL', 'st-od', 'approved', 24, dual.id, dayAfter(D, -200));

  // Counselings Reyes wrote and finalized, one acknowledged; one in MANPOWER; Dual's own private notes.
  const counsel = (unit: string | null, visibility: 'unit' | 'private', counselor: string | null, acknowledged: boolean, type = 'monthly') => {
    app.ctx.db.prepare(`INSERT INTO counselings (id, user_id, counselor_id, unit_id, visibility, date, type, summary, acknowledged_at, created_at, updated_at, stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Discussed the backlog.', ?, ?, ?, 'final')`).run(`st-c-${n++}`, dual.id, counselor, unit, visibility, dayAfter(D, -4), type, acknowledged ? at : null, at, at);
  };
  counsel('FISCAL', 'unit', reyes.id, true);
  counsel('BUDGET', 'unit', reyes.id, false, 'quarterly');
  counsel('MANPOWER', 'unit', reyes.id, true);
  counsel(null, 'private', null, false, 'other');

  // A goal Dual keeps private, and one Dual shared with FISCAL (put there directly: sharing a goal takes a role that
  // names it, which a Marine has not).
  const kept = await post(dual.token, '/api/records/goals', { title: 'Dual private goal', metric: 'manual', target_value: 10, visibility: 'private' });
  assert.equal(kept.status, 201, JSON.stringify(kept.body));
  app.ctx.db.prepare(`INSERT INTO goals (id, user_id, unit_id, visibility, title, created_at, updated_at) VALUES ('st-goal', ?, 'FISCAL', 'unit', 'Dual shared a goal', ?, ?)`).run(dual.id, at, at);
});
after(async () => { await app.close(); });

test('the Privacy Act statement is plain text the deployment sets, or none', () => {
  assert.equal(privacyActStatement(undefined), null);
  assert.equal(privacyActStatement('   '), null);
  assert.equal(privacyActStatement('AUTHORITY: First.\\nROUTINE USES: Second.'), 'AUTHORITY: First.\nROUTINE USES: Second.', 'a \\n in the setting is a paragraph break');
  assert.equal(privacyActStatement('  One   line,\tspaced  '), 'One line, spaced');
  assert.throws(() => privacyActStatement('<b>AUTHORITY</b>'), /plain text/);
  assert.throws(() => privacyActStatement('AUTHORITY\u0007'), /plain text/);
  assert.throws(() => privacyActStatement('x'.repeat(PRIVACY_ACT_STATEMENT_MAX + 1)), /the most is/);
  assert.equal(privacyActStatement('Less than 5 < 6 is fine'), 'Less than 5 < 6 is fine', 'a less-than sign is text, not markup');
});

test('a Marine’s own statistics read every record they keep, and are not audited', async () => {
  const seq = lastSeq();
  const res = await get(dual.token, `/api/statistics?${q({ period: 'last30' })}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body as MarineStatistics;
  assert.equal(s.self, true);
  assert.equal(s.unit_id, null);
  assert.deepEqual(s.units, []);
  assert.deepEqual(s.files, ['pdf', 'csv', 'xlsx', 'json']);
  assert.deepEqual(s.sections.map((x) => x.id), ['entries', 'duty', 'training', 'counseling', 'activity']);
  // Every entry, private and the other Unit Instance's included; the planned one waits.
  assert.equal(tile(s, 'entries_now', 'entries'), 4);
  assert.equal(tile(s, 'entries_now', 'quantity'), ULOS.fiscal + ULOS.budget + ULOS.manpower + ULOS.secret);
  assert.equal(tile(s, 'entries_now', 'planned'), 1);
  assert.equal(tile(s, 'duty_now', 'count'), 4, 'four stood in the range, the one 200 days ago left out');
  assert.equal(tile(s, 'training_now', 'hours'), 15);
  assert.equal(tile(s, 'counseling_now', 'count'), 4);
  // What Dual added in these days: five entries, four duties they recorded (the one stood 200 days ago among them, not
  // the one Reyes recorded), three courses, two goals,
  // two counselings acknowledged.
  assert.deepEqual(visual(s, 'activity_now').buckets.map((b) => [b.key, b.value]), [['entries', 5], ['duty', 4], ['training', 3], ['goals', 2], ['acknowledged', 2]]);
  assert.ok(!s.sections.find((x) => x.id === 'activity')!.facts.some((f) => f.key === 'last_sign_in'), 'one’s own last sign-in is this session: not shown');
  assert.deepEqual(auditedSince(seq, 'view_statistics'), [], 'reading one’s own statistics is not a read of somebody else’s');

  // The figures are the Analysis page's for the same range.
  const a = (await get(dual.token, `/api/reports/analysis?${q({ period: 'last30' })}`)).body;
  assert.equal(tile(s, 'entries_now', 'entries'), a.counts.current);
  assert.equal(tile(s, 'entries_now', 'value'), a.kpis.find((k: { key: string }) => k.key === 'value').value);
  assert.equal(tile(s, 'training_now', 'hours'), a.career.trainingHours);
  assert.deepEqual(s.period, { from: a.period.from, to: a.period.to, label: a.label });
});

test('about another Marine: what they shared with the units of one Unit Instance, the pages’ own figures, audited once for each unit', async () => {
  const seq = lastSeq();
  const about = { user_id: dual.id, unit_id: 'FISCAL', period: 'last30' };
  const res = await get(reyes.token, `/api/statistics?${q(about)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const s = res.body as MarineStatistics;
  assert.equal(s.self, false);
  assert.equal(s.unit_id, 'FISCAL');
  assert.deepEqual(s.units.map((u) => u.id), ['FISCAL', 'BUDGET'], 'the unit asked for first, then the rest of its Unit Instance');
  assert.equal(tile(s, 'entries_now', 'entries'), 2, 'FISCAL and BUDGET: never MANPOWER, never the private one');
  assert.equal(tile(s, 'entries_now', 'quantity'), ULOS.fiscal + ULOS.budget);
  assert.equal(tile(s, 'entries_now', 'value'), 1200, 'the private entry’s value is never read');
  assert.equal(bar(s, 'entries_outcome', 'with'), 1);
  assert.equal(bar(s, 'entries_outcome', 'without'), 1);
  assert.equal(tile(s, 'training_now', 'hours'), 4, 'shared with FISCAL only; the other instance and private study never read');
  assert.equal(tile(s, 'counseling_now', 'count'), 2);
  assert.equal(tile(s, 'counseling_now', 'unacknowledged'), 1);
  assert.deepEqual(visual(s, 'activity_now').buckets.map((b) => [b.key, b.value]), [['entries', 3], ['duty', 3], ['training', 1], ['goals', 1], ['acknowledged', 1]],
    'what they shared with FISCAL and BUDGET: the planned entry is an entry added; the private goal and MANPOWER are not read');
  // No composite score of another Marine, and no comparison with anyone.
  const keys = s.sections.flatMap((x) => [x.id, ...x.visuals.flatMap((v) => [v.id, ...v.buckets.map((b) => b.key)]), ...x.facts.map((f) => f.key)]);
  for (const word of ['strength', 'rank', 'percentile', 'projection', 'score', 'average', 'peer']) assert.ok(!keys.some((k) => k.toLowerCase().includes(word)), `no figure about another Marine is a ${word}: ${keys.join(', ')}`);
  assert.ok(s.notes.some((n) => /own history only/i.test(n)));
  const body = JSON.stringify(s);
  assert.ok(!body.includes('Dual private note') && !body.includes('Dual audited manpower orders'), 'no title, and no record of another instance, is in it');

  // One entry in each unit read's access log, about Dual.
  assert.deepEqual(auditedSince(seq, 'view_statistics').map((r) => [r.actor_id, r.unit_id, r.subject_id]), [[reyes.id, 'FISCAL', dual.id], [reyes.id, 'BUDGET', dual.id]]);

  // The Analysis page for the same range, Marine and units.
  const a = (await get(reyes.token, `/api/reports/analysis?${q(about)}`)).body;
  assert.equal(tile(s, 'entries_now', 'entries'), a.counts.current);
  assert.equal(tile(s, 'entries_now', 'value'), a.kpis.find((k: { key: string }) => k.key === 'value').value);
  assert.equal(tile(s, 'entries_now', 'quantity'), a.kpis.find((k: { key: string }) => k.key === 'quantity').value);
  assert.equal(tile(s, 'training_now', 'hours'), a.career.trainingHours);
  assert.equal(tile(s, 'counseling_now', 'count'), a.career.counselings.count);
  assert.deepEqual(visual(s, 'entries_area').buckets.filter((b) => b.value).map((b) => [b.label, b.value]), a.byArea.filter((x: { entries: number }) => x.entries).map((x: { name: string; entries: number }) => [x.name, x.entries]));
  const months = new Map(a.monthly.map((m: { month: string; entries: number }) => [m.month, m.entries]));
  for (const b of visual(s, 'entries_months').buckets) assert.equal(b.value, months.get(b.key) ?? 0, `${b.label} as the Analysis counts it`);

  // The Duty report for the same range, Marine and units.
  const dutyDoc = (await get(reyes.token, `/api/report-center/run?${q({ type: 'duty', subject: 'member', ...about })}`)).body as ReportDocument;
  const figure = (label: string) => dutyDoc.summary.find((f) => f.label === label)?.value;
  assert.equal(tile(s, 'duty_now', 'count'), figure('Duty stood'));
  assert.equal(tile(s, 'duty_now', 'count'), 3, 'FISCAL and BUDGET: two Dual recorded and one Reyes did');
  assert.equal(tile(s, 'duty_now', 'hours'), figure('Hours'));
  assert.equal(tile(s, 'duty_now', 'approved_points'), figure('Approved points'));
  assert.equal(tile(s, 'duty_now', 'approved_points'), 2.5, 'only approved duty counts, at its approved points');
  assert.equal(tile(s, 'duty_now', 'pending'), figure('Awaiting review'));
  assert.equal(tile(s, 'duty_now', 'returned'), 1);
  assert.deepEqual(visual(s, 'duty_type').buckets.map((b) => [b.label, b.value]), [['Duty NCO', 2], ['Officer of the Day', 1]]);

  // Through MANPOWER, the other Unit Instance alone.
  const g1 = (await get(reyes.token, `/api/statistics?${q({ ...about, unit_id: 'MANPOWER' })}`)).body as MarineStatistics;
  assert.deepEqual(g1.units.map((u) => u.id), ['MANPOWER']);
  assert.equal(tile(g1, 'entries_now', 'entries'), 1);
  assert.equal(tile(g1, 'duty_now', 'count'), 1);
  assert.equal(tile(g1, 'duty_now', 'hours'), 12);
});

test('a reader outside the Marine’s chain, a console role and Vantage staff are refused before anything is read', async () => {
  const seq = lastSeq();
  const about = (unit = 'FISCAL') => `/api/statistics?${q({ user_id: dual.id, unit_id: unit, period: 'last30' })}`;
  for (const [who, token] of [['a Marine of the unit', plain.token], ['a Unit Manager', unitmgr.token], ['Vantage staff', staff.token]] as const) {
    const res = await get(token, about());
    assert.equal(res.status, 403, `${who}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'forbidden', who);
  }
  const up = await get(dual.token, `/api/statistics?${q({ user_id: reyes.id, period: 'last30' })}`);
  assert.equal(up.status, 403, 'a Marine reading their leader');
  const nobody = await get(reyes.token, `/api/statistics?${q({ user_id: 'no-such-marine', period: 'last30' })}`);
  assert.equal(nobody.status, 403, 'an id nobody has is refused as anyone outside the chain is, not answered 404');
  // G1's leader opens Dual in MANPOWER; asked through FISCAL, a unit of another Unit Instance, the read is refused.
  const across = await get(g1lead.token, about('FISCAL'));
  assert.equal(across.status, 403);
  assert.equal(across.body.code, 'cross_instance');
  assert.deepEqual(auditedSince(seq, 'view_statistics'), [], 'nothing was read, so nothing is logged as read');
  // The Statistics report is refused to them alike.
  assert.equal((await get(plain.token, `/api/report-center/run?${q({ type: 'statistics', subject: 'member', user_id: dual.id, unit_id: 'FISCAL' })}`)).status, 403);
  assert.equal((await file(unitmgr.token, `/api/report-center/export?${q({ type: 'statistics', subject: 'member', user_id: dual.id, unit_id: 'FISCAL', format: 'pdf' })}`)).status, 403);
});

test('the last sign-in only to a leader who manages the Marine, and nothing about pages or time', async () => {
  const signedIn = new Date(Date.now() - 3_600_000).toISOString();
  app.ctx.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(signedIn, dual.id);
  const facts = async (token: string) => ((await get(token, `/api/statistics?${q({ user_id: dual.id, unit_id: 'FISCAL', period: 'last30' })}`)).body as MarineStatistics)
    .sections.find((x) => x.id === 'activity')!.facts;
  const managed = await facts(reyes.token);
  assert.equal(managed.find((f) => f.key === 'last_sign_in')?.value, signedIn, 'the SNCOIC manages Dual');
  assert.ok(managed.find((f) => f.key === 'last_entry')?.value, 'when the last entry was added');
  const led = await facts(ftl.token);
  assert.ok(!led.some((f) => f.key === 'last_sign_in'), 'a Fire Team Leader opens Dual’s record but manages nobody');
  assert.ok(led.some((f) => f.key === 'last_entry'));
});

test('the range is the one range rule’s, and its days are every read’s', async () => {
  const bad = await get(reyes.token, `/api/statistics?${q({ user_id: dual.id, period: 'custom', from: D })}`);
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fieldErrors?.to);
  const long = await get(reyes.token, `/api/statistics?${q({ user_id: dual.id, from: dayAfter(D, -800), to: D })}`);
  assert.equal(long.status, 400, 'two years at most');
  // A custom range that leaves out the duty stood three days ago and the training two days ago.
  const early = (await get(reyes.token, `/api/statistics?${q({ user_id: dual.id, unit_id: 'FISCAL', from: dayAfter(D, -60), to: dayAfter(D, -10) })}`)).body as MarineStatistics;
  assert.deepEqual([early.period.from, early.period.to], [dayAfter(D, -60), dayAfter(D, -10)]);
  assert.equal(tile(early, 'duty_now', 'count'), 0);
  assert.equal(tile(early, 'training_now', 'courses'), 0);
  assert.equal(tile(early, 'entries_now', 'entries'), 0);
  assert.equal(tile(early, 'activity_now', 'entries'), 0, 'nothing was added in those days either');
  assert.deepEqual(visual(early, 'duty_months').buckets.map((b) => b.key)[0], dayAfter(D, -60).slice(0, 7), 'the months start at the range’s first');
  // The 200-day-old duty is in a range that covers it.
  const year = (await get(dual.token, `/api/statistics?${q({ period: 'last12' })}`)).body as MarineStatistics;
  assert.equal(tile(year, 'duty_now', 'count'), 5);
  assert.equal(tile(year, 'duty_now', 'hours'), 8 + 4 + 6 + 12 + 24);
});

test('the Statistics report says what the tab says, carries the Privacy Act statement when one is set, and leaves only as allowed', async () => {
  const about = { user_id: dual.id, unit_id: 'FISCAL', period: 'last30' };
  const tab = (await get(reyes.token, `/api/statistics?${q(about)}`)).body as MarineStatistics;
  assert.equal(tab.privacy_act, null, 'no statement until the deployment sets one');
  const seq = lastSeq();
  const doc = (await get(reyes.token, `/api/report-center/run?${q({ type: 'statistics', subject: 'member', ...about })}`)).body as ReportDocument & { files: string[] };
  assert.equal(doc.type, 'statistics');
  assert.equal(doc.privacy, undefined);
  assert.deepEqual(doc.files, ['pdf', 'csv', 'xlsx', 'json'], 'Reyes may export in FISCAL and BUDGET');
  assert.deepEqual(auditedSince(seq, 'view_report').map((r) => [r.unit_id, r.subject_id, r.entity_id]), [['FISCAL', dual.id, 'statistics'], ['BUDGET', dual.id, 'statistics']]);
  const summary = (label: string) => doc.summary.find((f) => f.label === label)?.value;
  assert.equal(summary('Entries in the range'), tile(tab, 'entries_now', 'entries'));
  assert.equal(summary('Duty hours'), tile(tab, 'duty_now', 'hours'));
  assert.equal(summary('Approved duty points'), tile(tab, 'duty_now', 'approved_points'));
  assert.equal(summary('Training hours'), tile(tab, 'training_now', 'hours'));
  assert.equal(summary('Counselings'), tile(tab, 'counseling_now', 'count'));
  const months = doc.sections.flatMap((x) => x.tables).find((t) => t.id === 'months')!;
  assert.equal(doc.primary, 'months');
  assert.deepEqual(months.rows.map((r) => r.entries), visual(tab, 'entries_months').buckets.map((b) => b.value));
  assert.deepEqual(months.rows.map((r) => r.duty_hours), visual(tab, 'duty_months').buckets.map((b) => b.value));
  for (const section of tab.sections) {
    const printed = doc.sections.find((x) => x.id === section.id)!;
    for (const v of section.visuals.filter((x) => x.kind !== 'kpis')) {
      const t = printed.tables.find((x) => x.id === v.id)!;
      assert.ok(t, `${v.id} is a table of the report`);
      assert.deepEqual(t.rows.map((r) => r.value), v.buckets.map((b) => b.value), `${v.id}: the report’s figures are the tab’s`);
    }
  }

  // With a statement set, the tab shows it and every file but the CSV carries it.
  app.ctx.config.privacyActStatement = STATEMENT;
  try {
    assert.equal(((await get(reyes.token, `/api/statistics?${q(about)}`)).body as MarineStatistics).privacy_act, STATEMENT);
    assert.equal(((await get(dual.token, `/api/statistics?${q({ period: 'last30' })}`)).body as MarineStatistics).privacy_act, STATEMENT, 'and on the Marine’s own');
    const shown = (await get(reyes.token, `/api/report-center/run?${q({ type: 'statistics', subject: 'member', ...about })}`)).body as ReportDocument;
    assert.equal(shown.privacy, STATEMENT);
    const exported = lastSeq();
    const url = (format: string) => `/api/report-center/export?${q({ type: 'statistics', subject: 'member', ...about, format })}`;
    const pdf = await file(reyes.token, url('pdf'));
    assert.equal(pdf.status, 200);
    assert.ok(pdfDraws(pdf.buffer!, 'PRIVACY ACT STATEMENT'), 'the PDF heads its figures with the statement');
    assert.ok(pdfDraws(pdf.buffer!, 'AUTHORITY: The statement this deployment sets.'), 'and prints it');
    const book = await file(reyes.token, url('xlsx'));
    assert.equal(book.status, 200);
    assert.ok(JSON.stringify(readWorkbook(book.buffer!)).includes('PRINCIPAL PURPOSE: A placeholder for the tests.'), 'the workbook’s About sheet carries it');
    const json = await file(reyes.token, url('json'));
    assert.equal(JSON.parse(json.buffer!.toString('utf8')).privacy, STATEMENT);
    const csv = await file(reyes.token, url('csv'));
    assert.equal(csv.status, 200);
    const text = csv.buffer!.toString('utf8').replace(/^\uFEFF/, '');
    assert.ok(text.startsWith('"Month","Entries"'), `the CSV is the month by month table alone: ${JSON.stringify(text.slice(0, 120))}`);
    assert.deepEqual(auditedSince(exported, 'export_report').map((r) => r.unit_id), ['FISCAL', 'BUDGET', 'FISCAL', 'BUDGET', 'FISCAL', 'BUDGET', 'FISCAL', 'BUDGET']);
  } finally {
    app.ctx.config.privacyActStatement = null;
  }

  // Mixed opens Dual in both units but exports only in FISCAL: the PDF, never a spreadsheet or data file.
  const mixedTab = (await get(mixed.token, `/api/statistics?${q(about)}`)).body as MarineStatistics;
  assert.deepEqual(mixedTab.files, ['pdf']);
  assert.equal((await file(mixed.token, `/api/report-center/export?${q({ type: 'statistics', subject: 'member', ...about, format: 'pdf' })}`)).status, 200);
  for (const format of ['csv', 'xlsx', 'json']) {
    assert.equal((await file(mixed.token, `/api/report-center/export?${q({ type: 'statistics', subject: 'member', ...about, format })}`)).status, 403, format);
  }
});

test('every record added counts in one month of the activity series, on the instance clock, up to the range’s last', async () => {
  const tz = app.ctx.config.timezone;
  const s = (await get(dual.token, `/api/statistics?${q({ period: 'last30' })}`)).body as MarineStatistics;
  const months = visual(s, 'activity_months').buckets;
  assert.equal(months.reduce((n, b) => n + b.value, 0), visual(s, 'activity_now').value);
  assert.ok(months.at(-1)!.key >= zonedDay(tz).slice(0, 7), 'today’s month is drawn');
  assert.ok(months.every((b, i) => i === 0 || b.key > months[i - 1].key), 'one bar a month, in order');
});
