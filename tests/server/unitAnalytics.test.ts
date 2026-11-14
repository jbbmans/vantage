import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { orgOfUnit, PERMISSIONS } from '../../server/authz/scope.ts';
import { addMonths } from '../../server/services/reportCenter.ts';
import { REDACTED } from '../../shared/constants.ts';
import { PROCEDURE_LIST } from '../../shared/procedures.ts';
import {
  ANALYTICS_SECTIONS, drillOf, monthKeys, monthOf, rateOf, tally,
  type AnalyticsResponse, type DrillResponse, type SourceRecord, type Visual,
} from '../../shared/unitAnalytics.ts';

/**
 * Unit analytics (Task 21, ADR-0028): every figure lists the records it counts, the records it reads are the shared ones
 * of the units the reader may read, it names Marines only to those who open member records, and every read is audited.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person;
/** G8's people: an NCO reads shared records; a Fire Team Leader also opens member records. */
let nco: Person;
let ftl: Person;
/** A Marine of G8's Fiscal team, a reader whose role reaches only G8 (position 0), a Unit Manager, staff, another instance's leader. */
let marine: Person;
let viewer: Person;
let unitmgr: Person;
let vadmin: Person;
let g1lead: Person;

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const dayAfter = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const D = today();
const FROM = dayAfter(D, -89);
const windowQuery = `from=${FROM}&to=${D}`;
const analytics = (token: string, unit: string, section: string, q = windowQuery) => get(token, `/api/org/units/${unit}/analytics/${section}?${q}`);
const drill = (token: string, unit: string, section: string, ask: Record<string, string>, q = windowQuery) => get(token, `/api/org/units/${unit}/analytics/${section}/drill?${q}&${new URLSearchParams(ask)}`);
const visualOf = (r: AnalyticsResponse, id: string) => { const v = r.visuals.find((x) => x.id === id); assert.ok(v, `visual ${id}`); return v!; };
const bucketOf = (v: Visual, key: string) => { const b = v.buckets.find((x) => x.key === key); assert.ok(b, `${v.id} ${key}`); return b!; };
const auditSince = (seq: number) => app.ctx.db.prepare('SELECT action, actor_id, subject_id, unit_id, entity, entity_id, detail FROM audit_log WHERE seq > ? ORDER BY seq').all(seq) as Array<{ action: string; actor_id: string; subject_id: string | null; unit_id: string | null; entity: string | null; entity_id: string | null; detail: string }>;
const lastSeq = () => (app.ctx.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log').get() as { n: number }).n;

const caseIds: string[] = [];
const dutyIds: string[] = [];

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  nco = await app.register('nco'); await enroll(app, op.token, 'G8', nco.id, 'nco'); nco.token = await login('nco');
  ftl = await app.register('ftl'); await enroll(app, op.token, 'G8', ftl.id, 'fire-team-leader'); ftl.token = await login('ftl');
  marine = await app.register('rifleman', { last_name: 'Rivera' }); await enroll(app, op.token, 'FISCAL', marine.id); marine.token = await login('rifleman');
  app.ctx.db.prepare("INSERT INTO roles (id, unit_id, key, name, permissions, position, created_at) VALUES ('G8:viewer', 'G8', 'viewer', 'Viewer', ?, 0, ?)")
    .run(PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_MEMBER_DETAIL, new Date().toISOString());
  viewer = await app.register('viewer'); await enroll(app, op.token, 'G8', viewer.id, 'viewer'); viewer.token = await login('viewer');
  unitmgr = await app.register('unitmgr'); await enroll(app, op.token, 'G8', unitmgr.id);
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: unitmgr.id, role: 'admin' })).status, 201);
  unitmgr.token = await login('unitmgr');
  vadmin = await app.register('vadmin');
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(vadmin.id);
  assert.equal((await post(op.token, '/api/platform/staff', { user_id: vadmin.id, role: 'admin' })).status, 201);
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(vadmin.id);
  vadmin.token = await login('vadmin');
  g1lead = await app.register('g1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('g1lead');

  const made = async (token: string, path: string, body: unknown) => {
    const res = await post(token, path, body);
    assert.equal(res.status, 201, `${path}: ${JSON.stringify(res.body)}`);
    return res.body.id as string;
  };
  // Training: one met recently, one past due, a private one that never counts.
  await made(marine.token, '/api/records/trainings', { title: 'Cyber Awareness Challenge', date: addMonths(D, -13), status: 'completed', hours: 2, type: 'training', visibility: 'unit', unit_id: 'FISCAL' });
  await made(marine.token, '/api/records/trainings', { title: 'DTS Approving Official (DTS-101)', date: dayAfter(D, -20), status: 'completed', hours: 4, type: 'course', visibility: 'unit', unit_id: 'FISCAL' });
  await made(marine.token, '/api/records/trainings', { title: 'Private study hall', date: dayAfter(D, -10), status: 'completed', hours: 9, type: 'course', visibility: 'private' });
  await made(op.token, '/api/records/trainings', { title: 'Comptroller course', date: dayAfter(D, -30), status: 'completed', hours: 8, type: 'course', visibility: 'unit', unit_id: 'G8' });

  const org = orgOfUnit(app.ctx, 'G8')!;
  const at = new Date().toISOString();
  const requirement = app.ctx.db.prepare('INSERT INTO training_requirements (id, org_id, unit_id, title, type, course_code, interval_months, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)');
  requirement.run('req-cyber', org, null, 'Cyber Awareness Challenge', 'training', null, 12, at, at);
  requirement.run('req-dts', org, 'FISCAL', 'DTS Approving Official', 'course', 'DTS-101', 36, at, at);
  const dutyType = app.ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)');
  dutyType.run('duty-od', org, 'OD', 'Officer of the Day', 'Twenty-four hours at the command post', at, at);
  dutyType.run('duty-dnco', org, 'DNCO', 'Duty NCO', 'The night watch', at, at);

  // Duty: the Marine stood three in FISCAL (one approved, one later anonymized); the operator one in G8.
  const duty = (token: string, over: Record<string, unknown>) => made(token, '/api/records/duties', { duty_type_id: 'duty-od', date: dayAfter(D, -14), start_time: '0800', end_date: dayAfter(D, -14), end_time: '1600', unit_id: 'FISCAL', ...over });
  dutyIds.push(await duty(marine.token, {}));
  dutyIds.push(await duty(marine.token, { duty_type_id: 'duty-dnco', date: dayAfter(D, -7), end_date: dayAfter(D, -7), start_time: '1800', end_time: '2200' }));
  dutyIds.push(await duty(marine.token, { date: dayAfter(D, -40), end_date: dayAfter(D, -40), title: 'Weekend OD' }));
  dutyIds.push(await duty(op.token, { unit_id: 'G8', duty_type_id: 'duty-dnco', date: dayAfter(D, -3), end_date: dayAfter(D, -3) }));
  app.ctx.db.prepare("UPDATE duties SET approval_status = 'approved', approved_points = 3, reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(op.id, at, dutyIds[0]);
  app.ctx.db.prepare('UPDATE duties SET title = ?, notes = ? WHERE id = ?').run(REDACTED, REDACTED, dutyIds[2]);

  // Cases: two of one procedure (one overdue and held), one of another, one resolved, one in G8, and a private one.
  const [umt, ocmt] = [PROCEDURE_LIST.find((p) => p.key === 'umt_four_stage')!, PROCEDURE_LIST.find((p) => p.key === 'ocmt_research')!];
  for (const [title, unit] of [['ULO 1001', 'FISCAL'], ['ULO 1002', 'FISCAL'], ['OCMT 2001', 'FISCAL'], ['ULO 1003', 'FISCAL'], ['ULO 9009', 'G8']]) {
    caseIds.push(await made(op.token, '/api/work/items', { title, reference: title.replace(' ', '-'), unit_id: unit, visibility: 'unit' }));
  }
  caseIds.push(await made(op.token, '/api/work/items', { title: 'Private draft case', unit_id: 'G8', visibility: 'private' }));
  const set = app.ctx.db.prepare('UPDATE work_items SET procedure_key = ?, amount = ?, due_date = ?, claimed_by = ?, created_at = ?, stage = ?, state = ?, resolved_at = ? WHERE id = ?');
  const ago = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  set.run(umt.key, 500.5, dayAfter(D, -3), marine.id, ago(40), 'researching', 'in_progress', null, caseIds[0]);
  set.run(umt.key, 250, dayAfter(D, 20), null, ago(5), 'not_started', 'open', null, caseIds[1]);
  set.run(ocmt.key, 1000, null, marine.id, ago(100), 'waiting', 'waiting', null, caseIds[2]);
  set.run(umt.key, 75, null, marine.id, ago(20), 'resolved', 'resolved', ago(2), caseIds[3]);
  set.run(umt.key, 40, null, null, ago(3), 'not_started', 'open', null, caseIds[4]);
  set.run(umt.key, 99999, null, null, ago(3), 'not_started', 'open', null, caseIds[5]);
});
after(async () => { await app.close(); });

test('the figure engine: a figure is the sum of its records, and its drill lists exactly them', () => {
  const sources: Array<SourceRecord<string>> = [
    { record: 'a', in: [{ visual: 'v', key: 'x', value: 2 }, { visual: 'f', key: '2026-01', series: 'opened', value: 1 }] },
    { record: 'b', in: [{ visual: 'v', key: 'x', value: 3 }, { visual: 'f', key: '2026-03', series: 'closed', value: 1 }] },
    { record: 'c', in: [{ visual: 'v', key: 'y', label: 'Why', value: 10 }, { visual: 'f', key: '2027-01', series: 'opened', value: 1 }] },
  ];
  const [bars, cols] = tally([
    { id: 'v', question: 'Q', kind: 'bars', format: 'number', noun: 'thing' },
    { id: 'f', question: 'Q', kind: 'columns', format: 'number', noun: 'thing', keys: monthKeys('2026-01-15', '2026-03-02'), series: [{ key: 'opened', label: 'Opened', tone: 'accent' }, { key: 'closed', label: 'Closed', tone: 'neutral' }] },
  ], sources);
  assert.deepEqual(bars.buckets.map((b) => [b.key, b.label, b.value, b.count]), [['y', 'Why', 10, 1], ['x', 'x', 5, 2]], 'bars by size');
  assert.equal(bars.value, 15);
  assert.deepEqual(cols.buckets.map((b) => [b.label, b.values]), [['Jan 2026', [1, 0]], ['Feb 2026', [0, 0]], ['Mar 2026', [0, 1]]], 'every month, its zeros kept, nothing outside it');
  assert.deepEqual(drillOf(sources, 'v', 'x'), { records: [{ record: 'a', value: 2 }, { record: 'b', value: 3 }], value: 5 });
  assert.deepEqual(drillOf(sources, 'f', '2026-03', 'opened').records, []);
  assert.deepEqual(drillOf(sources, 'f', '2026-03', 'closed').records.map((r) => r.record), ['b']);
  assert.deepEqual(rateOf({ buckets: [{ value: 1 }, { value: 3 }] as Visual['buckets'] }), { done: 1, of: 4, percent: 25 });
  assert.equal(rateOf({ buckets: [] }).percent, null, 'nothing to divide by is no rate, not 0 %');
  assert.equal(monthOf('2026-01-03', '2026-02-10'), '2026-02', 'a record begun before the window counts in its first month');
  assert.equal(monthKeys('2026-11-20', '2027-01-02').map((k) => k.label).join(', '), 'Nov 2026, Dec 2026, Jan 2027');
});

test('every figure in every section lists exactly the records it counts', async () => {
  for (const section of ANALYTICS_SECTIONS) {
    const res = await analytics(op.token, 'G8', section);
    assert.equal(res.status, 200, `${section}: ${JSON.stringify(res.body)}`);
    const body = res.body as AnalyticsResponse;
    assert.equal(body.section, section);
    assert.equal(body.units, 2, 'G8 and FISCAL');
    assert.equal(body.detail, true);
    for (const v of body.visuals) {
      for (const b of v.buckets) {
        for (const [i, s] of v.series.entries()) {
          if (!b.counts[i]) continue;
          const d = await drill(op.token, 'G8', section, { visual: v.id, key: b.key, ...(v.series.length > 1 ? { series: s.key } : {}) });
          assert.equal(d.status, 200, `${section} ${v.id} ${b.key}: ${JSON.stringify(d.body)}`);
          const listed = d.body as DrillResponse;
          assert.equal(listed.count, b.counts[i], `${v.id} ${b.key} ${s.key}: the drill lists what the figure counts`);
          assert.equal(listed.value, b.values[i], `${v.id} ${b.key} ${s.key}: and its records add up to it`);
          assert.equal(Math.round(listed.records.reduce((n, r) => n + r.value, 0) * 100) / 100, b.values[i]);
        }
      }
    }
  }
});

test('casework: the figures the financial report prints, and nothing private', async () => {
  const work = (await analytics(op.token, 'G8', 'work')).body as AnalyticsResponse;
  const now = visualOf(work, 'work_now');
  assert.equal(bucketOf(now, 'open').value, 4, 'three open in FISCAL and one in G8; the private case is not counted');
  assert.equal(bucketOf(now, 'amount_open').value, 1790.5);
  assert.equal(bucketOf(now, 'overdue').value, 1);
  assert.equal(bucketOf(now, 'resolved').value, 1);
  assert.equal(visualOf(work, 'work_age').buckets.map((b) => b.value).join(','), '2,0,1,1', 'under 7, 7 to 30, 31 to 90, over 90');
  assert.equal(visualOf(work, 'work_dollars').value, 75);
  const report = await get(op.token, `/api/report-center/run?${new URLSearchParams({ type: 'financial', subject: 'unit', unit_id: 'G8', period: 'last90', from: FROM, to: D })}`);
  assert.equal(report.status, 200, JSON.stringify(report.body));
  const figure = (label: string) => report.body.summary.find((f: { label: string }) => f.label === label)?.value;
  assert.equal(bucketOf(now, 'open').value, figure('Open now'));
  assert.equal(bucketOf(now, 'amount_open').value, figure('Amount open'));
  assert.equal(rateOf(visualOf(work, 'work_rate')).percent, figure('Resolution rate'), 'the same resolution rate on screen and on paper');
  const open = (await drill(op.token, 'G8', 'work', { visual: 'work_now', key: 'open' })).body as DrillResponse;
  assert.ok(open.records.every((r) => r.to === `/work/items/${encodeURIComponent(r.id)}`), 'each case opens');
  assert.ok(!open.records.some((r) => r.title === 'Private draft case'));
});

test('duty: approved points only, anonymized duty named by nobody, and names only with member detail', async () => {
  const lead = (await analytics(ftl.token, 'G8', 'duty')).body as AnalyticsResponse;
  assert.equal(lead.detail, true);
  const now = visualOf(lead, 'duty_now');
  assert.equal(bucketOf(now, 'recorded').value, 4);
  assert.equal(bucketOf(now, 'approved_points').value, 3);
  assert.equal(bucketOf(now, 'waiting').value, 3, 'the three still awaiting review');
  const load = visualOf(lead, 'duty_load');
  assert.ok(load.buckets.some((b) => b.key === `marine:${marine.id}` && /Rivera/.test(b.label)), 'by Marine, for one who opens member records');
  const anonymous = (await drill(ftl.token, 'G8', 'duty', { visual: 'duty_load', key: bucketOf(load, '__anonymized').key })).body as DrillResponse;
  assert.equal(anonymous.count, 1);
  assert.equal(anonymous.records[0].who, null, 'an anonymized duty names nobody');
  assert.equal(anonymous.records[0].to, null);
  assert.doesNotMatch(anonymous.records[0].title, /redacted/i, 'nor shows the marker as its title');
  const marines = (await drill(ftl.token, 'G8', 'duty', { visual: 'duty_load', key: `marine:${marine.id}` })).body as DrillResponse;
  assert.equal(marines.count, 2);
  assert.ok(marines.records.every((r) => /Rivera/.test(r.who || '') && r.to === `/team/${marine.id}`), 'named, and opens the Marine');

  const plain = await analytics(nco.token, 'G8', 'duty');
  assert.equal(plain.status, 200);
  assert.equal((plain.body as AnalyticsResponse).detail, false);
  assert.doesNotMatch(JSON.stringify(plain.body), /Rivera/, 'no Marine is named to a reader who does not open member records');
  assert.ok(visualOf(plain.body, 'duty_load').buckets.every((b) => b.key.startsWith('unit:')), 'the load is by unit instead');
  const listed = (await drill(nco.token, 'G8', 'duty', { visual: 'duty_now', key: 'recorded' })).body as DrillResponse;
  assert.equal(listed.count, 4);
  assert.ok(listed.records.every((r) => r.who === null && r.to === null), 'the duty is listed, naming nobody');
  assert.doesNotMatch(JSON.stringify(listed), /Rivera/);
});

test('training: the standing as the training report has it, and listed only to who opens member records', async () => {
  const lead = (await analytics(ftl.token, 'G8', 'training')).body as AnalyticsResponse;
  const now = visualOf(lead, 'training_now');
  assert.equal(bucketOf(now, 'courses').value, 2, 'the DTS course and the comptroller course in the window; the private one never');
  assert.equal(bucketOf(now, 'hours').value, 12);
  const standing = visualOf(lead, 'training_standing');
  const overdue = standing.series.findIndex((s) => s.key === 'overdue');
  assert.equal(bucketOf(standing, 'req-cyber').values[overdue], 1, 'the Marine’s Cyber Awareness is past due');
  const report = await get(ftl.token, `/api/report-center/run?${new URLSearchParams({ type: 'training', subject: 'unit', unit_id: 'G8' })}`);
  assert.equal(report.status, 200, JSON.stringify(report.body));
  const figure = (label: string) => report.body.summary.find((f: { label: string }) => f.label === label)?.value;
  for (const [series, label] of [['met', 'Met'], ['due_soon', 'Due soon'], ['overdue', 'Past due'], ['missing', 'No record']] as const) {
    const i = standing.series.findIndex((s) => s.key === series);
    assert.equal(standing.buckets.reduce((n, b) => n + b.values[i], 0), figure(label), `${label}: the same on screen and on paper`);
  }
  const who = (await drill(ftl.token, 'G8', 'training', { visual: 'training_standing', key: 'req-cyber', series: 'overdue' })).body as DrillResponse;
  assert.ok(who.records.some((r) => /Rivera/.test(r.title)));

  // Marines who trained are Marines, each once, and a standing that names one is a list of their training.
  const trainers = (await drill(ftl.token, 'G8', 'training', { visual: 'training_now', key: 'marines' })).body as DrillResponse;
  assert.equal(trainers.noun, 'Marine');
  assert.equal(trainers.count, bucketOf(now, 'marines').value);
  assert.ok(trainers.records.every((r) => r.kind === 'marine'));
  assert.equal(new Set(trainers.records.map((r) => r.id)).size, trainers.count, 'each Marine once');
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'list_records' AND actor_id = ? AND entity = 'trainings' AND subject_id = ?").get(ftl.id, marine.id), 'a named standing is audited as a list of the Marine’s training');

  const plain = (await analytics(nco.token, 'G8', 'training')).body as AnalyticsResponse;
  assert.equal(visualOf(plain, 'training_standing').drill, false, 'counts only');
  assert.doesNotMatch(JSON.stringify(plain), /Rivera/);
  assert.equal((await drill(nco.token, 'G8', 'training', { visual: 'training_standing', key: 'req-cyber', series: 'overdue' })).status, 403);
  // Unnamed, a Marine who trained is not listed under their account id either, which the roster would put a name to.
  const unnamed = await drill(nco.token, 'G8', 'training', { visual: 'training_now', key: 'marines' });
  assert.equal(unnamed.status, 200, JSON.stringify(unnamed.body));
  const quiet = unnamed.body as DrillResponse;
  assert.equal(quiet.count, trainers.count);
  assert.ok(quiet.records.every((r) => r.title === 'A Marine' && r.to === null));
  assert.doesNotMatch(JSON.stringify(quiet), new RegExp(`${marine.id}|Rivera`));
  assert.equal(new Set(quiet.records.map((r) => r.id)).size, quiet.count, 'still each Marine once');
});

test('personnel: the roster by grade, team and MOS, each Marine once', async () => {
  const people = (await analytics(op.token, 'G8', 'personnel')).body as AnalyticsResponse;
  const now = visualOf(people, 'people_now');
  const roster = (await get(op.token, '/api/org/units/G8/personnel')).body.rows as Array<{ id: string }>;
  assert.equal(bucketOf(now, 'marines').value, roster.length, 'the personnel roster’s count');
  assert.equal(visualOf(people, 'people_team').value, roster.length, 'each Marine on one team');
  const fiscal = (await drill(op.token, 'G8', 'personnel', { visual: 'people_team', key: 'FISCAL' })).body as DrillResponse;
  assert.ok(fiscal.records.some((r) => r.id === marine.id && r.to === `/team/${marine.id}`));

  // An assignment ends in 90 days only while it has not ended.
  const ending = async () => bucketOf(visualOf((await analytics(op.token, 'G8', 'personnel')).body as AnalyticsResponse, 'people_now'), 'ending').value;
  const before = await ending();
  const setEnd = (d: string | null) => app.ctx.db.prepare("UPDATE unit_members SET assignment_end = ? WHERE user_id = ? AND unit_id = 'FISCAL'").run(d, marine.id);
  setEnd(dayAfter(D, -400));
  assert.equal(await ending(), before, 'an assignment that ended a year ago is not ending');
  setEnd(dayAfter(D, 30));
  assert.equal(await ending(), before + 1, 'one that ends next month is');
  setEnd(null);
});

test('who may read them: a unit one views the records of, in its own Unit Instance, and nothing to managers or staff', async () => {
  assert.equal((await analytics(marine.token, 'G8', 'work')).status, 403, 'a Marine');
  assert.equal((await analytics(marine.token, 'FISCAL', 'duty')).status, 403, 'a Marine, in their own team');
  assert.equal((await analytics(unitmgr.token, 'G8', 'work')).status, 403, 'a Unit Manager reads no records');
  assert.equal((await analytics(vadmin.token, 'G8', 'work')).status, 403, 'a Vantage Administrator reads no records');
  assert.equal((await analytics(g1lead.token, 'G8', 'work')).status, 403, 'another Unit Instance');
  assert.equal((await drill(g1lead.token, 'G8', 'work', { visual: 'work_now', key: 'open' })).status, 403);
  assert.equal((await analytics(op.token, 'NOPE', 'work')).status, 404);
  assert.equal((await analytics(op.token, 'G8', 'payroll')).status, 404, 'no such section');
  assert.equal((await analytics(op.token, 'G8', 'work', 'from=2026-13-01&to=2026-01-01')).status, 400);
  assert.equal((await analytics(op.token, 'G8', 'work', 'from=2026-02-30&to=2026-03-10')).status, 400, 'a day not on the calendar');
  assert.equal((await analytics(op.token, 'G8', 'work', `from=${D}&to=${FROM}`)).status, 400, 'from after to');
  assert.equal((await analytics(op.token, 'G8', 'work', `from=${dayAfter(D, -800)}&to=${D}`)).status, 400, 'no more than two years');
  assert.equal((await drill(op.token, 'G8', 'work', { visual: 'nope', key: 'open' })).status, 404);
  assert.equal((await drill(op.token, 'G8', 'work', { visual: 'work_flow', key: '1999-01' })).status, 404);
  assert.equal((await drill(op.token, 'G8', 'work', { visual: 'work_flow', key: D.slice(0, 7), series: 'stolen' })).status, 404);
  assert.equal((await get(op.token, `/api/org/units/G8/analytics/work/drill?${windowQuery}&visual=work_now`)).status, 400, 'a figure needs its bar');

  // A role that does not reach down (position 0) reads its own unit's records and none beneath it.
  const own = (await analytics(viewer.token, 'G8', 'work')).body as AnalyticsResponse;
  assert.equal(own.units, 1);
  assert.equal(bucketOf(visualOf(own, 'work_now'), 'open').value, 1, 'G8’s own case, none of FISCAL’s');
  assert.equal((await analytics(viewer.token, 'FISCAL', 'work')).status, 403);
  const duty = (await analytics(viewer.token, 'G8', 'duty')).body as AnalyticsResponse;
  assert.equal(bucketOf(visualOf(duty, 'duty_now'), 'recorded').value, 1);
  const people = (await analytics(viewer.token, 'G8', 'personnel')).body as AnalyticsResponse;
  assert.ok(!visualOf(people, 'people_team').buckets.some((b) => b.key === 'FISCAL'));
});

test('every read and every drill is in the audit trail, and so is a list of other Marines’ records', async () => {
  const seq = lastSeq();
  await analytics(ftl.token, 'G8', 'duty');
  await drill(ftl.token, 'G8', 'duty', { visual: 'duty_load', key: `marine:${marine.id}` });
  await drill(ftl.token, 'G8', 'work', { visual: 'work_now', key: 'open' });
  const entries = auditSince(seq);
  const read = entries.find((e) => e.action === 'view_unit_analytics');
  assert.ok(read && read.actor_id === ftl.id && read.unit_id === 'G8' && read.entity === 'unit' && read.detail === `duty;${FROM}..${D}`, JSON.stringify(read));
  const drills = entries.filter((e) => e.action === 'drill_unit_analytics');
  assert.equal(drills.length, 2);
  assert.equal(drills[0].detail, `duty:duty_load:marine:${marine.id};${FROM}..${D};2 records`);
  // A list of the same Marine's records to the same reader is recorded once in five minutes (auditListedRecords).
  assert.ok(auditSince(0).some((e) => e.action === 'list_records' && e.actor_id === ftl.id && e.entity === 'duties' && e.subject_id === marine.id && e.unit_id === 'FISCAL'), 'the Marine’s duty was listed to a leader');
  const refused = lastSeq();
  await analytics(g1lead.token, 'G8', 'work');
  assert.ok(!auditSince(refused).some((e) => e.action === 'view_unit_analytics'), 'a refusal is not recorded as a read');
});
