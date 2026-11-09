import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { dutyFacts, dutyConditions, dutyProblems, readsLikeDuty } from '../../shared/duty.ts';
import { instanceBoundaryViolations } from '../../server/db/index.ts';
import { saveSchedule, runDisposition } from '../../server/services/retention.ts';
import { REDACTED } from '../../shared/constants.ts';
import type { TimelineItem } from '../../shared/recordKinds.ts';

/**
 * Task 17 (ADR-0023): duty is a record of its own. Its length, conditions and points are the server's to work out, under
 * the scoring version in force on its first day, and kept; it is always shared with the unit it was stood for, inside one
 * Unit Instance; a leader who counsels a Marine may record it for them; an activity that was duty moves only when its
 * owner says so; and a reviewer's decision stands.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
/** The Marine who stands duty. */
let reyes: { token: string; id: string };
/** A fire team leader: counsels, so records duty for a Marine, but does not correct others' records. */
let diaz: { token: string; id: string };
/** An SNCO: corrects the unit's shared records. */
let nguyen: { token: string; id: string };
/** A Marine of the same unit with no authority over others. */
let okafor: { token: string; id: string };
/** Leads another Unit Instance. */
let g1lead: { token: string; id: string };

const T = { dnco: 'dr-dnco', saf: 'dr-saf', retired: 'dr-oldwatch', g1: 'dr-g1-dnco' };
const V = { v1: 'dr-v1', v2: 'dr-v2', g1: 'dr-g1-v1' };

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const del = (token: string, path: string) => app.call('DELETE', path, { token });
const login = async (username: string) => (await app.login(username)).body.token as string;
const rowOf = (table: string, id: string) => app.ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, any> | undefined;
const dayAfter = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const upload = (token: string, data: string, filename: string) =>
  app.call('POST', '/api/me/imports', { token, raw: Buffer.from(data), headers: { 'content-type': 'text/csv', 'x-filename': filename } });
const itemsOf = (body: any) => (Array.isArray(body) ? body : body.items) as Array<Record<string, any>>;

/** One duty as the form sends it: a DNCO in G8 unless the test says otherwise. */
const duty = (over: Record<string, unknown> = {}) => ({ duty_type_id: T.dnco, date: '2026-03-10', start_time: '0800', end_date: '2026-03-10', end_time: '1600', unit_id: 'G8', ...over });
async function recorded(token: string, over: Record<string, unknown> = {}) {
  const res = await post(token, '/api/records/duties', duty(over));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as Record<string, any>;
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  app.ctx.runtime.attachmentsEnabled = true;
  reyes = await app.register('reyes', { rank_id: 'Cpl', last_name: 'Reyes' });
  diaz = await app.register('dutydiaz', { rank_id: 'Sgt', last_name: 'Diaz' });
  nguyen = await app.register('dutynguyen', { rank_id: 'SSgt', last_name: 'Nguyen' });
  okafor = await app.register('dutyokafor');
  await app.register('dutyoutsider');
  await enroll(app, op.token, 'G8', reyes.id);
  await enroll(app, op.token, 'G8', diaz.id, 'fire-team-leader');
  await enroll(app, op.token, 'G8', nguyen.id, 'snco');
  await enroll(app, op.token, 'G8', okafor.id);
  for (const [name, who] of [['reyes', reyes], ['dutydiaz', diaz], ['dutynguyen', nguyen], ['dutyokafor', okafor]] as const) who.token = await login(name);
  const lead = await app.register('dutyg1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: lead.id })).status, 201);
  g1lead = { id: lead.id, token: await login('dutyg1lead') };

  // Duty types and scoring versions as a Unit Manager would have set them up, dated in the past so past duty is scored
  // (the console only publishes versions that take effect tomorrow or later; ADR-0012).
  const at = '2025-12-01T00:00:00.000Z';
  const type = app.ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)');
  type.run(T.dnco, 'G8', 'DNCO', 'Duty NCO', 1, at, at);
  type.run(T.saf, 'G8', 'SAF', 'Squad on Alert Force', 1, at, at);
  type.run(T.retired, 'G8', 'OLDW', 'Old watch', 0, at, at);
  type.run(T.g1, 'G1', 'DNCO', 'G-1 Duty NCO', 1, at, at);
  const version = app.ctx.db.prepare('INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  version.run(V.v1, 'G8', 1, '2026-01-01', JSON.stringify({ rules: [{ duty_type_id: T.dnco, method: 'fixed', points: 3, bands: null }], multipliers: [{ condition: 'weekend', factor: 1.5 }], combine: 'highest' }), 'First policy', op.id, at);
  version.run(V.v2, 'G8', 2, '2026-06-01', JSON.stringify({ rules: [{ duty_type_id: T.dnco, method: 'per_hour', points: 0.25, bands: null }], multipliers: [{ condition: 'overnight', factor: 1.2 }], combine: 'highest' }), 'Per hour from June', op.id, at);
  version.run(V.g1, 'G1', 1, '2026-01-01', JSON.stringify({ rules: [{ duty_type_id: T.g1, method: 'fixed', points: 9, bands: null }], multipliers: [], combine: 'highest' }), 'G-1 policy', lead.id, at);
});
after(async () => { await app.close(); });

// ---------------------------------------------------------------------------------------------------------------------
// What a duty ran to

test('a duty’s length, days, overnight, multi-day and weekend come from its start and end alone', () => {
  // Friday 1600 to Monday 0800: 64 hours, three duty days, over a weekend.
  assert.deepEqual(dutyFacts({ date: '2026-03-06', start_time: '16:00', end_date: '2026-03-09', end_time: '08:00' }), { hours: 64, days: 3, overnight: true, multi_day: true, weekend: true });
  // A Tuesday day duty.
  assert.deepEqual(dutyFacts({ date: '2026-03-10', start_time: '08:00', end_date: '2026-03-10', end_time: '16:30' }), { hours: 8.5, days: 1, overnight: false, multi_day: false, weekend: false });
  // Ending at midnight, it did not stand the Saturday that begins then.
  assert.deepEqual(dutyFacts({ date: '2026-03-06', start_time: '20:00', end_date: '2026-03-07', end_time: '00:00' }), { hours: 4, days: 1, overnight: false, multi_day: false, weekend: false });
  // Exactly 24 hours is one duty day, overnight but not multi-day.
  assert.deepEqual(dutyFacts({ date: '2026-07-14', start_time: '08:00', end_date: '2026-07-15', end_time: '08:00' }), { hours: 24, days: 1, overnight: true, multi_day: false, weekend: false });
  assert.equal(dutyFacts({ date: '2026-03-10', start_time: '08:00', end_date: '2026-03-10', end_time: '08:00' }), null, 'no length');
  assert.equal(dutyFacts({ date: '2026-03-10', end_date: '2026-03-10', end_time: '08:00' }), null, 'no start time');

  // Weekend and overnight are what its times say, whatever is claimed; the rest are claimed, once each.
  const weekday = dutyFacts({ date: '2026-03-10', start_time: '08:00', end_date: '2026-03-10', end_time: '16:00' });
  assert.deepEqual(dutyConditions(weekday, ['weekend', 'holiday', 'holiday', 'bogus', 'overnight']), ['holiday']);
  assert.deepEqual(dutyConditions(dutyFacts({ date: '2026-03-06', start_time: '16:00', end_date: '2026-03-09', end_time: '08:00' }), []).sort(), ['overnight', 'weekend']);

  const day = '2026-03-20';
  assert.match(dutyProblems({ date: '2026-03-10', start_time: '08:00', end_date: '2026-03-10', end_time: '07:00' }, day)!.fieldErrors.end_time, /After the start/);
  assert.match(dutyProblems({ date: '2026-01-01', start_time: '08:00', end_date: '2026-02-15', end_time: '08:00' }, day)!.message, /30 days at most/);
  assert.match(dutyProblems({ date: '2026-03-20', start_time: '08:00', end_date: '2026-03-21', end_time: '08:00' }, day)!.fieldErrors.end_date, /Today or earlier/);
  assert.deepEqual(Object.keys(dutyProblems({ date: '2026-03-10' }, day)!.fieldErrors).sort(), ['end_date', 'end_time', 'start_time']);
  assert.equal(dutyProblems({ date: '2026-03-10', start_time: '08:00', end_date: '2026-03-20', end_time: '08:00' }, day), null, 'ending today is stood');

  // What reads like duty its owner stood, and what is work about duty for others.
  for (const t of ['Stood DNCO for 1st Bn', 'SAF', 'Fire watch, barracks 3', 'Working party at the warehouse', 'Officer of the Day']) assert.ok(readsLikeDuty(t), t);
  for (const t of ['Built the duty roster for November', 'Scheduled the watch bill', 'Reconciled 12 ULOs', 'Dutiful review of the ledger']) assert.ok(!readsLikeDuty(t), t);
});

// ---------------------------------------------------------------------------------------------------------------------
// Recording it

test('a Marine records duty: the server works out its length and score under the version of its first day, never the request', async () => {
  const res = await post(reyes.token, '/api/records/duties', duty({
    title: 'Battalion DNCO', location: 'Bldg 1101', notes: 'Quiet night.', conditions: ['holiday'],
    // None of this is the request's to say.
    hours: 99, days: 9, overnight: 1, calculated_points: 50, approved_points: 50, approval_status: 'approved', scoring_version: 7, scoring_policy_id: V.g1, recorded_by: diaz.id, reviewed_by: diaz.id,
  }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const d = res.body;
  assert.deepEqual([d.user_id, d.unit_id, d.visibility, d.recorded_by], [reyes.id, 'G8', 'unit', reyes.id]);
  assert.deepEqual([d.start_time, d.end_time, d.hours, d.days, d.overnight, d.multi_day], ['08:00', '16:00', 8, 1, 0, 0]);
  assert.deepEqual([d.approval_status, d.reviewed_by, d.approved_points], ['pending', null, null]);
  assert.deepEqual([d.scoring_policy_id, d.scoring_version, d.calculated_points], [V.v1, 1, 3]);
  assert.deepEqual(d.conditions, ['holiday'], 'claimed, and kept, though version 1 does not multiply it');
  assert.deepEqual([d.duty_type_name, d.duty_type_code, d.duty_type_active], ['Duty NCO', 'DNCO', true]);
  assert.equal(d.scoring_basis.day, '2026-03-10');
  assert.equal(d.scoring_basis.version, 1);
  assert.equal(d.scoring_basis.reason, null);
  assert.ok(d.submitted_at, 'when it was submitted');

  // Over a weekend under version 1: 3 × 1.5.
  const weekend = await recorded(reyes.token, { date: '2026-03-06', start_time: '1600', end_date: '2026-03-09', end_time: '0800' });
  assert.deepEqual([weekend.hours, weekend.days, weekend.overnight, weekend.multi_day, weekend.calculated_points, weekend.scoring_version], [64, 3, 1, 1, 4.5, 1]);
  assert.deepEqual([...weekend.conditions].sort(), ['overnight', 'weekend']);
  assert.deepEqual(weekend.scoring_basis.applied, ['weekend'], 'version 1 multiplies weekend only');
  // Under version 2, which took effect on 1 June: 24 h × 0.25 × 1.2 overnight.
  const july = await recorded(reyes.token, { date: '2026-07-14', start_time: '08:00', end_date: '2026-07-15', end_time: '08:00' });
  assert.deepEqual([july.calculated_points, july.scoring_version, july.scoring_policy_id], [7.2, 2, V.v2]);
  // A type the version does not score gives none, and says so; before any version, no points at all.
  const saf = await recorded(reyes.token, { duty_type_id: T.saf, date: '2026-07-20', end_date: '2026-07-20' });
  assert.deepEqual([saf.calculated_points, saf.scoring_version, saf.scoring_basis.reason], [0, 2, 'type_not_scored']);
  const early = await recorded(reyes.token, { date: '2025-12-15', end_date: '2025-12-15' });
  assert.deepEqual([early.calculated_points, early.scoring_version, early.scoring_policy_id, early.scoring_basis.reason], [null, null, null, 'no_version']);

  // Read back the same through the list and the record.
  const list = await get(reyes.token, '/api/records/duties');
  assert.equal(list.status, 200);
  assert.ok(itemsOf(list.body).some((r) => r.id === d.id && r.duty_type_name === 'Duty NCO' && r.calculated_points === 3));
  const one = await get(reyes.token, `/api/records/duties/${d.id}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.scoring_basis.version, 1, 'the basis comes back as an object');
});

test('duty is refused when it is private, has no unit, names another unit’s or a retired type, has not ended, or runs past 30 days', async () => {
  const refused = async (token: string, over: Record<string, unknown>, status: number, field?: string) => {
    const res = await post(token, '/api/records/duties', duty(over));
    assert.equal(res.status, status, `${JSON.stringify(over)}: ${JSON.stringify(res.body)}`);
    if (field) assert.ok(res.body.fieldErrors?.[field], `${field}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  await refused(reyes.token, { visibility: 'private' }, 400, 'visibility');
  await refused(reyes.token, { duty_type_id: T.g1 }, 400, 'duty_type_id');
  await refused(reyes.token, { duty_type_id: 'no-such-type' }, 400, 'duty_type_id');
  await refused(reyes.token, { duty_type_id: T.retired }, 400, 'duty_type_id');
  await refused(reyes.token, { duty_type_id: '' }, 400, 'duty_type_id');
  await refused(reyes.token, { start_time: undefined }, 400, 'start_time');
  await refused(reyes.token, { end_time: '2500' }, 400, 'end_time');
  await refused(reyes.token, { end_time: '0700' }, 400, 'end_time');
  await refused(reyes.token, { date: '2026-01-01', end_date: '2026-02-15' }, 400, 'end_date');
  await refused(reyes.token, { date: today(), end_date: dayAfter(today(), 1) }, 400, 'end_date');
  // In no unit: there is nothing to record it for, and a unit one does not serve in is refused.
  const outsiderToken = await login('dutyoutsider');
  await refused(outsiderToken, { unit_id: undefined }, 400, 'unit_id');
  await refused(outsiderToken, {}, 403);
  // A G-1 lead records G-1 duty with G-1 types; a G-8 type is not one there.
  await refused(g1lead.token, { unit_id: 'G1' }, 400, 'duty_type_id');
  const g1 = await recorded(g1lead.token, { unit_id: 'G1', duty_type_id: T.g1 });
  assert.deepEqual([g1.calculated_points, g1.scoring_policy_id], [9, V.g1], 'scored under its own Unit Instance’s version');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM duties WHERE user_id = ? AND duty_type_id = ?').get(reyes.id, T.retired) as { n: number }).n, 0);
});

test('a score stays as it was scored; only a change to its days, times, type, conditions or unit scores it again', async () => {
  const d = await recorded(reyes.token, { title: 'DNCO' });
  assert.equal(d.calculated_points, 3);
  // A score kept from before (as if the version it was scored under said otherwise).
  app.ctx.db.prepare('UPDATE duties SET calculated_points = 99 WHERE id = ?').run(d.id);
  const retitled = await put(reyes.token, `/api/records/duties/${d.id}`, { title: 'DNCO, 1st Bn', location: 'Bldg 2', notes: 'Relieved on time.', calculated_points: 1, hours: 1, approval_status: 'approved' });
  assert.equal(retitled.status, 200, JSON.stringify(retitled.body));
  assert.deepEqual([retitled.body.title, retitled.body.calculated_points, retitled.body.hours, retitled.body.approval_status], ['DNCO, 1st Bn', 99, 8, 'pending'], 'words change; the score and review do not');
  // The same conditions again are not a change.
  assert.equal((await put(reyes.token, `/api/records/duties/${d.id}`, { conditions: [] })).body.calculated_points, 99);
  // A new end: worked out again, under the version of its first day.
  const longer = await put(reyes.token, `/api/records/duties/${d.id}`, { end_date: '2026-03-11', end_time: '0800' });
  assert.equal(longer.status, 200, JSON.stringify(longer.body));
  assert.deepEqual([longer.body.hours, longer.body.overnight, longer.body.calculated_points, longer.body.scoring_version], [24, 1, 3, 1]);
  // A new first day under version 2: scored by it.
  const moved = await put(reyes.token, `/api/records/duties/${d.id}`, { date: '2026-07-21', end_date: '2026-07-21', start_time: '08:00', end_time: '20:00' });
  assert.deepEqual([moved.body.calculated_points, moved.body.scoring_version], [3, 2], '12 h × 0.25');
  // A change to a retired type or another instance's is refused, as is making it private or not yet stood.
  assert.equal((await put(reyes.token, `/api/records/duties/${d.id}`, { duty_type_id: T.retired })).status, 400);
  assert.equal((await put(reyes.token, `/api/records/duties/${d.id}`, { duty_type_id: T.g1 })).status, 400);
  assert.equal((await put(reyes.token, `/api/records/duties/${d.id}`, { visibility: 'private' })).status, 400);
  assert.equal((await put(reyes.token, `/api/records/duties/${d.id}`, { end_date: dayAfter(today(), 2) })).status, 400);
  // Keeping a type since retired is not refused.
  app.ctx.db.prepare('UPDATE duty_types SET active = 0 WHERE id = ?').run(T.saf);
  try {
    const saf = (app.ctx.db.prepare('SELECT id FROM duties WHERE user_id = ? AND duty_type_id = ? LIMIT 1').get(reyes.id, T.saf) as { id: string }).id;
    const kept = await put(reyes.token, `/api/records/duties/${saf}`, { title: 'SAF, alpha', start_time: '0900' });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(kept.body.duty_type_active, false);
  } finally { app.ctx.db.prepare('UPDATE duty_types SET active = 1 WHERE id = ?').run(T.saf); }
});

test('a leader who counsels a Marine records duty for them; the Marine is told and cannot change it; its recorder and the records manager can', async () => {
  const told = () => app.ctx.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND kind = 'duty' ORDER BY created_at DESC").all(reyes.id) as Array<Record<string, any>>;
  const before = told().length;
  const res = await post(diaz.token, '/api/records/duties', duty({ user_id: reyes.id, date: '2026-04-07', end_date: '2026-04-07', title: 'SDNCO relief' }));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const d = res.body;
  assert.deepEqual([d.user_id, d.recorded_by, d.unit_id, d.visibility, d.approval_status, d.calculated_points], [reyes.id, diaz.id, 'G8', 'unit', 'pending', 3]);
  assert.equal(told().length, before + 1);
  assert.equal(told()[0].action_url, `/record/duty?open=${d.id}`);
  assert.match(told()[0].message, /Duty NCO on 2026-04-07/);

  // The Marine sees it, named by who recorded it, and cannot change or delete it.
  const seen = await get(reyes.token, `/api/records/duties/${d.id}`);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.recorder_name, 'Sgt Diaz');
  assert.equal((await put(reyes.token, `/api/records/duties/${d.id}`, { title: 'Mine now' })).status, 403);
  assert.equal((await del(reyes.token, `/api/records/duties/${d.id}`)).status, 403);
  assert.equal((await post(reyes.token, `/api/records/duties/${d.id}/move`, { to: 'activities' })).status, 404, 'duty never moves out except by undo');
  // Its recorder corrects it, and so does a records manager; another Marine cannot.
  assert.equal((await put(diaz.token, `/api/records/duties/${d.id}`, { title: 'SDNCO relief, 2nd Bn' })).status, 200);
  assert.equal((await put(nguyen.token, `/api/records/duties/${d.id}`, { location: 'Bldg 1101' })).status, 200);
  assert.ok([403, 404].includes((await put(okafor.token, `/api/records/duties/${d.id}`, { title: 'Not mine' })).status));
  // A Marine with no counsel authority records nobody else's duty; nor does a leader of another Unit Instance.
  assert.equal((await post(okafor.token, '/api/records/duties', duty({ user_id: reyes.id }))).status, 403);
  assert.equal((await post(g1lead.token, '/api/records/duties', duty({ user_id: reyes.id, unit_id: 'G1', duty_type_id: T.g1 }))).status, 403);

  // What the form offers: one's own units; for another Marine, the units one counsels them in.
  const mine = await get(reyes.token, '/api/record/duty/options');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(mine.body.units.map((u: { id: string }) => u.id), ['G8']);
  assert.deepEqual(mine.body.types.map((t: { id: string }) => t.id).sort(), [T.dnco, T.saf].sort(), 'its own instance’s types in use');
  assert.deepEqual(mine.body.versions.map((v: { version: number }) => v.version).sort(), [1, 2]);
  for (const v of mine.body.versions) assert.ok(!('note' in v) && !('created_by' in v) && !('created_by_name' in v), 'what a version scores, never who published it or why');
  assert.deepEqual(mine.body.claimable, ['holiday', 'short_notice', 'extended', 'consecutive']);
  assert.equal(mine.body.today, today());
  const forReyes = await get(diaz.token, `/api/record/duty/options?for=${reyes.id}`);
  assert.equal(forReyes.status, 200);
  assert.deepEqual(forReyes.body.units.map((u: { id: string }) => u.id), ['G8']);
  const notYours = await get(okafor.token, `/api/record/duty/options?for=${reyes.id}`);
  assert.equal(notYours.status, 403);
  assert.equal(notYours.body.code, 'duty_not_yours');
  const g1 = await get(g1lead.token, '/api/record/duty/options');
  assert.deepEqual(g1.body.types.map((t: { id: string }) => t.id), [T.g1], 'never another Unit Instance’s types');
  assert.deepEqual(g1.body.versions.map((v: { id: string }) => v.id), [V.g1]);

  // The Marine's page, for a leader who may see it, holds the duty.
  const page = await get(diaz.token, `/api/org/team/${reyes.id}`);
  assert.equal(page.status, 200, JSON.stringify(page.body).slice(0, 300));
  assert.ok(page.body.duties.some((x: { id: string; duty_type_name: string }) => x.id === d.id && x.duty_type_name === 'Duty NCO'));
});

test('a duty its reviewer approved or rejected stays as it was decided; a returned one can be corrected', async () => {
  const d = await recorded(reyes.token, { date: '2026-04-14', end_date: '2026-04-14' });
  const at = new Date().toISOString();
  app.ctx.db.prepare("UPDATE duties SET approval_status = 'approved', reviewed_by = ?, reviewed_at = ?, approved_points = 3 WHERE id = ?").run(nguyen.id, at, d.id);
  for (const [token, who] of [[reyes.token, 'its Marine'], [nguyen.token, 'a records manager']] as const) {
    const edit = await put(token, `/api/records/duties/${d.id}`, { title: 'Changed after approval' });
    assert.equal(edit.status, 403, who);
    assert.equal(edit.body.code, 'duty_decided', who);
    const gone = await del(token, `/api/records/duties/${d.id}`);
    assert.equal(gone.status, 403, who);
    assert.equal(gone.body.code, 'duty_decided', who);
  }
  // Someone who cannot read it learns nothing of its decision.
  const g1 = await put(g1lead.token, `/api/records/duties/${d.id}`, { title: 'x' });
  assert.ok([403, 404].includes(g1.status));
  assert.notEqual(g1.body.code, 'duty_decided');
  assert.equal(rowOf('duties', d.id)!.title, null);

  app.ctx.db.prepare("UPDATE duties SET approval_status = 'rejected', approved_points = NULL, review_reason = 'Not on the roster.' WHERE id = ?").run(d.id);
  assert.equal((await put(reyes.token, `/api/records/duties/${d.id}`, { title: 'x' })).body.code, 'duty_decided');
  app.ctx.db.prepare("UPDATE duties SET approval_status = 'returned', review_reason = 'Give the relief time.' WHERE id = ?").run(d.id);
  const fixed = await put(reyes.token, `/api/records/duties/${d.id}`, { end_time: '1700' });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.equal(fixed.body.hours, 9);

  // The table holds a decision together.
  assert.throws(() => app.ctx.db.prepare("UPDATE duties SET approval_status = 'approved', reviewed_by = NULL WHERE id = ?").run(d.id), /CHECK constraint/);
  assert.throws(() => app.ctx.db.prepare('UPDATE duties SET approved_points = 2 WHERE id = ?').run(d.id), /CHECK constraint/, 'points are approved only on approved duty');
  assert.throws(() => app.ctx.db.prepare("UPDATE duties SET approval_status = 'rejected', review_reason = NULL WHERE id = ?").run(d.id), /CHECK constraint/);
  assert.throws(() => app.ctx.db.prepare('UPDATE duties SET scoring_version = NULL WHERE id = ?').run(d.id), /CHECK constraint/);
  assert.throws(() => app.ctx.db.prepare("UPDATE duties SET visibility = 'private' WHERE id = ?").run(d.id), /CHECK constraint/);
});

test('a duty, its type and its scoring version stay in one Unit Instance', async () => {
  const d = await recorded(reyes.token, { date: '2026-04-21', end_date: '2026-04-21' });
  const db = app.ctx.db;
  const at = new Date().toISOString();
  const insert = (id: string, unit: string, type: string, policy: string | null, version: number | null) => db.prepare(`INSERT INTO duties (id, user_id, unit_id, duty_type_id, date, start_time, end_date, end_time, hours, days, submitted_at, scoring_policy_id, scoring_version, created_at, updated_at)
    VALUES (?, ?, ?, ?, '2026-04-22', '08:00', '2026-04-22', '16:00', 8, 1, ?, ?, ?, ?, ?)`).run(id, reyes.id, unit, type, at, policy, version, at, at);
  assert.throws(() => insert('dr-x1', 'G8', T.g1, null, null), /cross_instance/, 'a G-1 type on G-8 duty');
  assert.throws(() => insert('dr-x2', 'G8', T.dnco, V.g1, 1), /cross_instance/, 'scored under a G-1 version');
  assert.throws(() => insert('dr-x3', 'G1', T.dnco, null, null), /cross_instance/, 'G-8 duty in a G-1 unit');
  assert.throws(() => db.prepare('UPDATE duties SET duty_type_id = ? WHERE id = ?').run(T.g1, d.id), /cross_instance/);
  assert.throws(() => db.prepare('UPDATE duties SET scoring_policy_id = ? WHERE id = ?').run(V.g1, d.id), /cross_instance/);
  assert.throws(() => db.prepare("UPDATE duties SET unit_id = 'G1' WHERE id = ?").run(d.id), /cross_instance/);
  assert.throws(() => db.prepare("UPDATE duty_types SET org_id = 'G1' WHERE id = ?").run(T.dnco), /cross_instance/, 'a type duty names stays in its instance');
  assert.deepEqual(instanceBoundaryViolations(db), {});
  // A G-1 lead neither reads nor finds G-8 duty.
  const across = await get(g1lead.token, `/api/records/duties/${d.id}`);
  assert.equal(across.status, 403, 'refused as any record one cannot open is');
  assert.ok(!('duty_type_id' in across.body));
  assert.ok(!itemsOf((await get(g1lead.token, '/api/records/duties')).body).some((r) => r.id === d.id));
});

// ---------------------------------------------------------------------------------------------------------------------
// Activities that were duty

test('activities that read like duty are offered to their owner to move, with lineage and undo, or to keep', async () => {
  const entry = async (title: string, over: Record<string, unknown> = {}) => {
    const res = await post(reyes.token, '/api/records/activities', { title, date: '2026-04-02', visibility: 'unit', unit_id: 'G8', ...over });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as Record<string, any>;
  };
  const dnco = await entry('Stood DNCO for the battalion', { result: 'No incidents.' });
  const watch = await entry('Fire watch, barracks 3', { date: '2026-04-03' });
  const roster = await entry('Built the duty roster for November');
  await entry('Reconciled 12 ULOs');
  const theirs = await post(okafor.token, '/api/records/activities', { title: 'Stood SAF', date: '2026-04-02' });
  assert.equal(theirs.status, 201);

  const offered = await get(reyes.token, '/api/record/duty/candidates');
  assert.equal(offered.status, 200, JSON.stringify(offered.body));
  const ids = offered.body.candidates.map((c: { id: string }) => c.id);
  assert.ok(ids.includes(dnco.id) && ids.includes(watch.id), JSON.stringify(offered.body));
  assert.ok(!ids.includes(roster.id), 'work about duty stays an Activity');
  assert.ok(!ids.includes(theirs.body.id), 'only one’s own');
  assert.equal(offered.body.total, ids.length);
  assert.equal(offered.body.candidates.find((c: { id: string }) => c.id === dnco.id).notes, 'No incidents.', 'what the move would carry, for the form to show');
  assert.ok(rowOf('activities', dnco.id), 'asking moved nothing');

  // Keep: the suggestion stops, the entry stays.
  assert.equal((await post(reyes.token, `/api/records/activities/${watch.id}/keep`)).status, 200);
  assert.ok(!(await get(reyes.token, '/api/record/duty/candidates')).body.candidates.some((c: { id: string }) => c.id === watch.id));
  assert.ok(rowOf('activities', watch.id));

  // Move: only its owner, with a type and times.
  const move = (token: string, body: Record<string, unknown>) => post(token, `/api/records/activities/${dnco.id}/move`, body);
  assert.ok([403, 404].includes((await move(okafor.token, { to: 'duties', fields: { duty_type_id: T.dnco, start_time: '0800', end_time: '1600' } })).status), 'another Marine does not move it');
  assert.equal((await move(reyes.token, { to: 'duties', fields: { start_time: '0800', end_time: '1600' } })).status, 400, 'its type is needed');
  assert.equal((await move(reyes.token, { to: 'duties', fields: { duty_type_id: T.dnco } })).status, 400, 'its times are needed');
  assert.equal((await move(reyes.token, { to: 'duties', fields: { duty_type_id: T.g1, start_time: '0800', end_time: '1600' } })).status, 400);
  assert.ok(rowOf('activities', dnco.id), 'a refused move leaves it as it was');
  const moved = await move(reyes.token, { to: 'duties', fields: { duty_type_id: T.dnco, start_time: '0800', end_time: '1600', hours: 40, calculated_points: 9 }, reason: 'It was duty.', version: dnco.version });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  const d = moved.body.record;
  assert.equal(moved.body.table, 'duties');
  assert.ok(!rowOf('activities', dnco.id), 'it is no longer an Activity');
  assert.deepEqual([d.user_id, d.recorded_by, d.unit_id, d.title, d.date, d.end_date, d.hours, d.calculated_points, d.scoring_version, d.approval_status],
    [reyes.id, reyes.id, 'G8', 'Stood DNCO for the battalion', '2026-04-02', '2026-04-02', 8, 3, 1, 'pending']);
  assert.equal(d.notes, 'No incidents.', 'what it said comes with it');
  const lineage = app.ctx.db.prepare('SELECT * FROM record_lineage WHERE from_id = ? AND to_id = ?').get(dnco.id, d.id) as Record<string, any>;
  assert.deepEqual([lineage.from_table, lineage.to_table, lineage.method, lineage.reason, lineage.moved_by], ['activities', 'duties', 'move', 'It was duty.', reyes.id]);
  const history = await get(reyes.token, `/api/records/duties/${d.id}/lineage`);
  assert.equal(history.status, 200, JSON.stringify(history.body));
  assert.ok(!(await get(reyes.token, '/api/record/duty/candidates')).body.candidates.some((c: { id: string }) => c.id === dnco.id));

  // Undo: the activity comes back exactly as it was, and the duty is gone.
  const undone = await post(reyes.token, `/api/records/duties/${d.id}/undo-move`);
  assert.equal(undone.status, 200, JSON.stringify(undone.body));
  const back = rowOf('activities', dnco.id)!;
  assert.deepEqual([back.title, back.result, back.date, back.unit_id, back.visibility], ['Stood DNCO for the battalion', 'No incidents.', '2026-04-02', 'G8', 'unit']);
  assert.ok(!rowOf('duties', d.id));
  // Moved again, then decided: it stays duty.
  const again = await move(reyes.token, { to: 'duties', fields: { duty_type_id: T.dnco, start_time: '0800', end_time: '1600' } });
  assert.equal(again.status, 201, JSON.stringify(again.body));
  app.ctx.db.prepare("UPDATE duties SET approval_status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?").run(nguyen.id, new Date().toISOString(), again.body.id);
  const stays = await post(reyes.token, `/api/records/duties/${again.body.id}/undo-move`);
  assert.equal(stays.status, 403);
  assert.equal(stays.body.code, 'duty_decided');
  // Only an activity moves to Duty.
  const course = await post(reyes.token, '/api/records/trainings', { title: 'Duty NCO course', date: '2026-04-01' });
  assert.equal(course.status, 201, JSON.stringify(course.body));
  assert.equal((await post(reyes.token, `/api/records/trainings/${course.body.id}/move`, { to: 'duties', fields: { duty_type_id: T.dnco, start_time: '0800', end_time: '1600' } })).status, 400);
});

// ---------------------------------------------------------------------------------------------------------------------
// Import, export, and where it shows

test('a duty sheet imports as duty: its type by code, a file never says its review or score, and nothing goes in twice', async () => {
  const csv = 'Duty Type,Start Date,Start Time,End Date,End Time,Title,Review Status,Calculated Points,Scoring Version,Duty Hours\n'
    + 'DNCO,2026-05-05,0800,2026-05-05,2000,Battalion DNCO,approved,99,7,1\n'
    + 'Bogus Watch,2026-05-06,0800,2026-05-06,2000,Unknown watch,,,,\n'
    + 'dnco,2026-05-12,0800,2026-05-12,1000,Lower case code,,,,\n';
  const staged = await upload(reyes.token, csv, 'duty.csv');
  assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 400));
  assert.equal(staged.body.sheets[0].table, 'duties');
  const outcomes = staged.body.rows.map((r: { title: string; outcome: string }) => [r.title, r.outcome]);
  assert.deepEqual(outcomes, [['Battalion DNCO', 'new'], ['Unknown watch', 'problem'], ['Lower case code', 'new']], JSON.stringify(staged.body.rows));
  assert.match(staged.body.rows[1].reason, /not one of your unit’s duty types/);
  const done = await post(reyes.token, `/api/me/imports/${staged.body.id}/commit`, { expected: { new: 2, update: 0 } });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 400));
  const imported = app.ctx.db.prepare("SELECT * FROM duties WHERE user_id = ? AND date IN ('2026-05-05', '2026-05-12') ORDER BY date").all(reyes.id) as Array<Record<string, any>>;
  assert.deepEqual(imported.map((d) => [d.title, d.duty_type_id, d.approval_status, d.calculated_points, d.scoring_version, d.hours, d.visibility, d.unit_id, d.recorded_by]),
    [['Battalion DNCO', T.dnco, 'pending', 3, 1, 12, 'unit', 'G8', reyes.id], ['Lower case code', T.dnco, 'pending', 3, 1, 2, 'unit', 'G8', reyes.id]]);
  // The same file again: already here.
  const again = await upload(reyes.token, csv, 'duty.csv');
  assert.equal(again.body.counts.new, 0, JSON.stringify(again.body.rows));
  assert.equal(again.body.counts.duplicate, 2);
  await del(reyes.token, `/api/me/imports/${again.body.id}`);

  // The export says what the server worked out, for reading, and names the type by its code.
  const sheet = await get(reyes.token, '/api/me/export?format=csv&sections=duty');
  assert.equal(sheet.status, 200, String(sheet.text).slice(0, 300));
  const [header, ...lines] = String(sheet.text).trim().split(/\r?\n/);
  for (const h of ['Duty Type', 'Start Date', 'Start Time', 'End Time', 'Duty Hours', 'Review Status', 'Calculated Points', 'Scoring Version']) assert.ok(header.includes(h), `${h} in ${header}`);
  assert.ok(lines.some((l) => l.includes('Battalion DNCO') && l.includes('DNCO')));
  // Into another Marine of the unit: it comes in as theirs, scored again, submitted.
  const copied = await upload(okafor.token, String(sheet.text), 'vantage-reyes-duty-2026-11-09.csv');
  assert.equal(copied.status, 201, JSON.stringify(copied.body).slice(0, 300));
  assert.equal(copied.body.counts.problem, 0, JSON.stringify(copied.body.rows.filter((r: { outcome: string }) => r.outcome === 'problem')));
  const committed = await post(okafor.token, `/api/me/imports/${copied.body.id}/commit`, { expected: { new: copied.body.counts.new, update: copied.body.counts.update } });
  assert.equal(committed.status, 200, JSON.stringify(committed.body).slice(0, 300));
  const theirs = app.ctx.db.prepare('SELECT * FROM duties WHERE user_id = ? AND deleted_at IS NULL').all(okafor.id) as Array<Record<string, any>>;
  assert.ok(theirs.length >= 2);
  assert.ok(theirs.every((d) => d.approval_status === 'pending' && d.recorded_by === okafor.id && d.unit_id === 'G8'));
  assert.equal(theirs.find((d) => d.title === 'Battalion DNCO')?.calculated_points, 3);
  // A G-1 lead's import finds none of G-8's types.
  const g1 = await upload(g1lead.token, 'Duty Type,Start Date,Start Time,End Date,End Time\nSAF,2026-05-05,0800,2026-05-05,2000\n', 'duty.csv');
  assert.equal(g1.body.rows[0].outcome, 'problem', JSON.stringify(g1.body.rows[0]));
});

test('duty on the timeline, the personnel record, the Duty report, and in retention', async () => {
  const mine = app.ctx.db.prepare('SELECT id FROM duties WHERE user_id = ? AND deleted_at IS NULL').all(reyes.id) as Array<{ id: string }>;
  const timeline = await get(reyes.token, '/api/record/timeline?limit=500');
  assert.equal(timeline.status, 200, JSON.stringify(timeline.body).slice(0, 300));
  const duties = (timeline.body.items as TimelineItem[]).filter((i) => i.kind === 'duty');
  assert.deepEqual(duties.map((i) => i.id).sort(), mine.map((r) => r.id).sort());
  assert.equal(timeline.body.counts.duty, mine.length);
  assert.ok(duties.every((i) => i.table === 'duties' && i.href === `/record/duty?open=${encodeURIComponent(i.id)}`));

  const personnel = await get(nguyen.token, `/api/org/team/${reyes.id}/personnel`);
  assert.equal(personnel.status, 200, JSON.stringify(personnel.body).slice(0, 300));
  assert.equal(personnel.body.records.duty, mine.length, 'duty counts duty records, not Operations activities');

  const tablesOf = (doc: { sections: Array<{ tables: Array<Record<string, any>> }> }) => doc.sections.flatMap((s) => s.tables);
  const report = await get(reyes.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'self', period: 'all' })}`);
  assert.equal(report.status, 200, JSON.stringify(report.body).slice(0, 400));
  const stood = tablesOf(report.body).find((t) => t.id === 'stood')!;
  assert.equal(stood.rows.length, mine.length);
  assert.ok(!stood.columns.some((c: { key: string }) => c.key === 'marine'), 'one’s own report names nobody');
  assert.equal(report.body.summary.find((f: { label: string }) => f.label === 'Duty stood')?.value, mine.length);
  const unit = await get(nguyen.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'unit', unit_id: 'G8', period: 'all' })}`);
  assert.equal(unit.status, 200, JSON.stringify(unit.body).slice(0, 400));
  assert.ok(tablesOf(unit.body).find((t) => t.id === 'stood')!.rows.length >= mine.length);
  assert.ok(tablesOf(unit.body).some((t) => t.id === 'types'), 'beside the types and scoring');
  // What each version scores is for anyone reading their own duty; why it changed and who published it is the unit's.
  const versionColumns = (doc: { sections: Array<{ tables: Array<Record<string, any>> }> }) => tablesOf(doc).find((t) => t.id === 'versions')!.columns.map((c: { key: string }) => c.key);
  assert.ok(!versionColumns(report.body).some((k: string) => k === 'note' || k === 'by'), JSON.stringify(versionColumns(report.body)));
  assert.ok(!JSON.stringify(report.body).includes('Per hour from June'), 'no version note in one’s own report');
  assert.ok(['note', 'by'].every((k) => versionColumns(unit.body).includes(k)));
  // Another Unit Instance's lead does not run it on G-8.
  assert.ok([403, 404].includes((await get(g1lead.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'unit', unit_id: 'G8', period: 'all' })}`)).status));

  // Anonymized: the words about a person go; its type, times, length and score stay.
  const target = app.ctx.db.prepare("SELECT * FROM duties WHERE user_id = ? AND title = 'Battalion DNCO'").get(reyes.id) as Record<string, any>;
  saveSchedule(app.ctx, 'G8', { record_type: 'duties', retain_days: 30, disposition: 'anonymize', enabled: true }, op.id);
  runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
  const after = rowOf('duties', target.id)!;
  assert.equal(after.title, REDACTED);
  assert.deepEqual([after.duty_type_id, after.date, after.start_time, after.end_time, after.hours, after.calculated_points, after.scoring_version],
    [target.duty_type_id, target.date, target.start_time, target.end_time, target.hours, target.calculated_points, target.scoring_version]);
  const read = await get(nguyen.token, `/api/records/duties/${target.id}`);
  assert.equal(read.status, 200);
  assert.ok(!('subject_name' in read.body), 'no name put back on an anonymized duty');
  // Nor on a list that also holds a later duty of theirs, which does name them.
  const later = await recorded(reyes.token, { date: dayAfter(today(), -5), end_date: dayAfter(today(), -5), title: 'Later DNCO' });
  const page = await get(nguyen.token, `/api/org/team/${reyes.id}`);
  assert.equal(page.status, 200, JSON.stringify(page.body).slice(0, 300));
  const listed = new Map((page.body.duties as Array<Record<string, any>>).map((d) => [d.id, d]));
  assert.match(String(listed.get(later.id)?.subject_name), /^Cpl Reyes/, JSON.stringify(listed.get(later.id)));
  assert.ok(listed.has(target.id) && !('subject_name' in listed.get(target.id)!), JSON.stringify(listed.get(target.id)));
  // Nor in the unit's report: it counts in the totals, and in no Marine's.
  const byUnit = await get(op.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'unit', unit_id: 'G8', period: 'all' })}`);
  assert.equal(byUnit.status, 200, JSON.stringify(byUnit.body).slice(0, 300));
  const unitTables = tablesOf(byUnit.body);
  const rows = unitTables.find((t) => t.id === 'stood')!.rows as Array<Record<string, any>>;
  assert.ok(unitTables.find((t) => t.id === 'stood')!.columns.some((c: { key: string }) => c.key === 'marine'), 'the report names Marines');
  const hidden = rows.filter((r) => r.title === REDACTED);
  assert.ok(hidden.length >= 1 && hidden.every((r) => r.marine === null), JSON.stringify(hidden));
  assert.ok(rows.some((r) => r.title === 'Later DNCO' && /^Cpl Reyes/.test(String(r.marine))));
  assert.equal(byUnit.body.summary.find((f: { label: string }) => f.label === 'Duty stood').value, rows.length, 'counted in the totals');
  const tally = unitTables.find((t) => t.id === 'by_marine')!.rows as Array<{ count: number }>;
  assert.equal(tally.reduce((n, r) => n + r.count, 0), rows.length - hidden.length, 'in no Marine’s tally');
  assert.ok(byUnit.body.notes.some((n: string) => /anonymized/.test(n)));
  // A period of nothing else has no tally to show, rather than one that says no duty was stood beside totals that count it.
  const day = String(target.date);
  const thatDay = app.ctx.db.prepare("SELECT title, notes, location FROM duties WHERE unit_id = 'G8' AND deleted_at IS NULL AND date <= ? AND end_date >= ?").all(day, day) as Array<Record<string, unknown>>;
  assert.ok(thatDay.length >= 1 && thatDay.every((d) => d.title === REDACTED), JSON.stringify(thatDay));
  const onlyHidden = await get(op.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'unit', unit_id: 'G8', period: 'all', from: day, to: day })}`);
  assert.equal(onlyHidden.status, 200, JSON.stringify(onlyHidden.body).slice(0, 300));
  assert.equal(onlyHidden.body.summary.find((f: { label: string }) => f.label === 'Duty stood').value, thatDay.length);
  assert.ok(!tablesOf(onlyHidden.body).some((t) => t.id === 'by_marine'), JSON.stringify(tablesOf(onlyHidden.body).map((t) => t.id)));
  assert.ok(tablesOf(onlyHidden.body).every((t) => t.empty !== 'No duty is recorded in the period.' || t.rows.length), 'no table says no duty was stood');
  assert.ok(onlyHidden.body.notes.some((n: string) => /anonymized/.test(n)));
  // Nor in a file: the duty Diaz recorded for Reyes, anonymized, names no recorder in Reyes's export or its own.
  const relief = app.ctx.db.prepare('SELECT id, title FROM duties WHERE user_id = ? AND recorded_by = ? AND deleted_at IS NULL').get(reyes.id, diaz.id) as { id: string; title: string };
  assert.equal(relief.title, REDACTED);
  const archive = await get(reyes.token, '/api/me/export?format=json&sections=duty');
  assert.equal(archive.status, 200, String(archive.text).slice(0, 300));
  const exported = (JSON.parse(archive.text).records.duties as Array<Record<string, any>>).find((d) => d.id === relief.id)!;
  assert.ok(exported && !('recorder_label' in exported) && !('reviewer_label' in exported), JSON.stringify(exported));
  assert.equal(exported.duty_type, 'DNCO', 'its type stays');
  const single = await get(reyes.token, `/api/records/duties/${relief.id}/export?format=json`);
  assert.equal(single.status, 200);
  assert.ok(!String(single.text).includes('recorder_label'), String(single.text).slice(0, 300));
  assert.ok(!String(single.text).includes('Diaz'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Found in review

test('a form save sends only the conditions claimed: a weekend or overnight duty keeps its score and its conditions', async () => {
  // Saturday 2000 to Sunday 0800: weekend and overnight, from its times.
  const d = await recorded(reyes.token, { date: '2026-03-14', start_time: '2000', end_date: '2026-03-15', end_time: '0800', title: 'Weekend DNCO' });
  assert.deepEqual([...d.conditions].sort(), ['overnight', 'weekend']);
  assert.equal(d.calculated_points, 4.5, '3 × 1.5 for the weekend');
  // A score kept from before.
  app.ctx.db.prepare('UPDATE duties SET calculated_points = 99 WHERE id = ?').run(d.id);
  // Exactly what the duty form sends for a change to its notes: the claimed conditions, which are none.
  const form = { duty_type_id: T.dnco, unit_id: 'G8', title: 'Weekend DNCO', location: null, date: '2026-03-14', start_time: '20:00', end_date: '2026-03-15', end_time: '08:00', conditions: [], notes: 'Relieved on time.' };
  const noted = await put(reyes.token, `/api/records/duties/${d.id}`, { ...form, version: d.version });
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  assert.equal(noted.body.calculated_points, 99, 'not scored again');
  assert.deepEqual([...noted.body.conditions].sort(), ['overnight', 'weekend'], 'the conditions its times give are kept');
  // Claiming a holiday is a change: scored again, with it.
  const claimed = await put(reyes.token, `/api/records/duties/${d.id}`, { ...form, conditions: ['holiday'], version: noted.body.version });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.calculated_points, 4.5);
  assert.deepEqual([...claimed.body.conditions].sort(), ['holiday', 'overnight', 'weekend']);
});

test('one’s own duty goes only in a unit one serves in, never one that a leader’s Counsel reaches beneath theirs', async () => {
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Duty Section', short_name: 'DUTYSEC', code: 'dutysec', parent_id: 'G8' })).status, 201);
  const section = (app.ctx.db.prepare("SELECT id FROM units WHERE name = 'G8 Duty Section'").get() as { id: string }).id;
  // Diaz counsels in G-8, and so in the section beneath it, but serves only in G-8: the form offers only G-8.
  assert.deepEqual((await get(diaz.token, '/api/record/duty/options')).body.units.map((u: { id: string }) => u.id), ['G8']);
  const placed = await post(diaz.token, '/api/records/duties', duty({ unit_id: section }));
  assert.equal(placed.status, 403, JSON.stringify(placed.body));
  const own = await recorded(diaz.token, { title: 'Diaz DNCO' });
  assert.equal((await put(diaz.token, `/api/records/duties/${own.id}`, { unit_id: section })).status, 403, 'nor moved there');
  // Moved from an activity: the same.
  const entry = await post(diaz.token, '/api/records/activities', { title: 'Stood SAF for the section', date: '2026-04-02', visibility: 'unit', unit_id: 'G8' });
  assert.equal(entry.status, 201);
  const moved = await post(diaz.token, `/api/records/activities/${entry.body.id}/move`, { to: 'duties', fields: { unit_id: section, duty_type_id: T.saf, start_time: '0800', end_date: '2026-04-02', end_time: '2000' } });
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.ok(rowOf('activities', entry.body.id), 'the entry stays an activity');
  // Imported naming it: it comes in under their own unit, and the review says so.
  const staged = await upload(diaz.token, `Duty Type,Start Date,Start Time,End Date,End Time,Title,Unit ID\nSAF,2026-04-09,0800,2026-04-09,2000,Section SAF,${section}\n`, 'duty.csv');
  assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 400));
  assert.equal(staged.body.rows[0].outcome, 'new', JSON.stringify(staged.body.rows[0]));
  assert.match(staged.body.rows[0].reason, /not one you serve in here/);
  const done = await post(diaz.token, `/api/me/imports/${staged.body.id}/commit`, { expected: { new: 1, update: 0 } });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  assert.equal((app.ctx.db.prepare("SELECT unit_id FROM duties WHERE user_id = ? AND title = 'Section SAF'").get(diaz.id) as { unit_id: string }).unit_id, 'G8');
});

test('an activity in no unit carries nobody else’s comments from one Unit Instance into duty in another', async () => {
  await enroll(app, g1lead.token, 'G1', okafor.id);
  const shared = await post(okafor.token, '/api/records/activities', { title: 'Stood DNCO, G-8', date: '2026-04-20', visibility: 'unit', unit_id: 'G8' });
  assert.equal(shared.status, 201);
  const remark = await post(nguyen.token, `/api/records/activities/${shared.body.id}/comments`, { body: 'G-8 only: relieved late.' });
  assert.equal(remark.status, 201, JSON.stringify(remark.body));
  // Its owner takes it out of the unit, which they may; sharing it straight into G-1 is refused, as is moving it there.
  const unshared = await put(okafor.token, `/api/records/activities/${shared.body.id}`, { visibility: 'private', unit_id: null });
  assert.equal(unshared.status, 200, JSON.stringify(unshared.body));
  assert.equal((await put(okafor.token, `/api/records/activities/${shared.body.id}`, { visibility: 'unit', unit_id: 'G1' })).body.code, 'cross_instance');
  const fields = { unit_id: 'G1', duty_type_id: T.g1, start_time: '0800', end_date: '2026-04-20', end_time: '2000' };
  const moved = await post(okafor.token, `/api/records/activities/${shared.body.id}/move`, { to: 'duties', fields });
  assert.equal(moved.status, 403, JSON.stringify(moved.body));
  assert.equal(moved.body.code, 'cross_instance');
  assert.equal((app.ctx.db.prepare('SELECT record_table FROM comments WHERE id = ?').get(remark.body.id) as { record_table: string }).record_table, 'activities', 'the remark stays where it was written');
  // Nothing of anyone else's on it: it moves.
  const mine = await post(okafor.token, '/api/records/activities', { title: 'Stood DNCO, G-1', date: '2026-04-21' });
  assert.equal((await put(okafor.token, `/api/records/activities/${mine.body.id}`, { visibility: 'private', unit_id: null })).status, 200);
  const ok = await post(okafor.token, `/api/records/activities/${mine.body.id}/move`, { to: 'duties', fields: { ...fields, end_date: '2026-04-21' } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.record.unit_id, ok.body.record.calculated_points], ['G1', 9]);
});

test('a configuration file’s scoring versions never reach back over duty already stood in an instance that had none', async () => {
  const lead = await app.register('dutyg3lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-3', code: 'G3', owner_user_id: lead.id })).status, 201);
  const token = await login('dutyg3lead');
  const at = '2025-12-01T00:00:00.000Z';
  app.ctx.db.prepare("INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES ('dr-g3-dnco', 'G3', 'DNCO', 'G-3 Duty NCO', NULL, 1, ?, ?)").run(at, at);
  const stood = await recorded(token, { unit_id: 'G3', duty_type_id: 'dr-g3-dnco' });
  assert.equal(stood.calculated_points, null, 'no version in force');
  const file = (await get(op.token, '/api/orgs/G8/configuration/export')).body;
  assert.ok(file.scoringPolicies.some((p: { effective_from: string }) => p.effective_from <= today()), 'G-8’s versions are dated in the past');
  const plan = await post(token, '/api/orgs/G3/configuration/import', file);
  assert.equal(plan.status, 200, JSON.stringify(plan.body).slice(0, 400));
  const lines = plan.body.lines.filter((l: { kind: string }) => l.kind === 'scoring_policy');
  assert.ok(lines.length && lines.every((l: { outcome: string; reason?: string }) => l.outcome === 'skip' && /already holds duty/.test(l.reason ?? '')), JSON.stringify(lines));
  const applied = await post(token, '/api/orgs/G3/configuration/import?apply=1', file);
  assert.equal(applied.status, 200, JSON.stringify(applied.body).slice(0, 400));
  assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM duty_scoring_policies WHERE org_id = 'G3'").get() as { n: number }).n, 0);
  assert.equal(rowOf('duties', stood.id)!.calculated_points, null, 'its duty keeps the score it was recorded with');
});

test('a duty row whose type is retired is corrected on the review, at its Duty Type', async () => {
  const staged = await upload(reyes.token, 'Duty Type,Start Date,Start Time,End Date,End Time,Title\nOLDW,2026-04-17,0615,2026-04-17,1615,Old watch row\n', 'duty.csv');
  assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 400));
  const row = staged.body.rows[0];
  assert.equal(row.outcome, 'problem', JSON.stringify(row));
  assert.match(row.reason, /retired/);
  assert.ok(row.fieldErrors?.duty_type && !row.fieldErrors.duty_type_id, JSON.stringify(row.fieldErrors));
  const fixed = await put(reyes.token, `/api/me/imports/${staged.body.id}`, { rows: { [row.ref]: { fix: { duty_type: 'DNCO' } } } });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body).slice(0, 400));
  assert.equal(fixed.body.rows[0].outcome, 'new', JSON.stringify(fixed.body.rows[0]));
  await del(reyes.token, `/api/me/imports/${staged.body.id}`);
});

test('a sheet that lists a duty’s claims in any order, or without what its times give, does not change it', async () => {
  // Saturday 0800 to 1600, claiming a holiday: stored as weekend (from its times) and holiday (claimed).
  const d = await recorded(reyes.token, { date: '2026-03-21', end_date: '2026-03-21', title: 'Saturday DNCO', conditions: ['holiday'] });
  assert.deepEqual([...d.conditions].sort(), ['holiday', 'weekend']);
  const row = (conditions: string) => `Vantage ID,Duty Type,Start Date,Start Time,End Date,End Time,Title,Conditions\n${d.id},DNCO,2026-03-21,0800,2026-03-21,1600,Saturday DNCO,${conditions}\n`;
  for (const conditions of ['"Holiday; Weekend"', 'Holiday']) {
    const staged = await upload(reyes.token, row(conditions), 'my-duty.csv');
    assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 300));
    assert.equal(staged.body.rows[0].outcome, 'unchanged', `${conditions}: ${JSON.stringify(staged.body.rows[0])}`);
    await del(reyes.token, `/api/me/imports/${staged.body.id}`);
  }
  // Dropping the claim is a change.
  const dropped = await upload(reyes.token, row('Weekend'), 'my-duty.csv');
  assert.equal(dropped.body.rows[0].outcome, 'update', JSON.stringify(dropped.body.rows[0]));
  await del(reyes.token, `/api/me/imports/${dropped.body.id}`);
  assert.equal(rowOf('duties', d.id)!.version, d.version, 'nothing was written');
});

test('a sheet updating one’s own duty: a retired type is corrected at its Duty Type, and a type is found in the instance it moves to', async () => {
  const d = await recorded(reyes.token, { date: '2026-04-23', end_date: '2026-04-23', title: 'Thursday DNCO' });
  const staged = await upload(reyes.token, `Vantage ID,Duty Type,Start Date,Start Time,End Date,End Time,Title\n${d.id},OLDW,2026-04-23,0800,2026-04-23,1600,Thursday DNCO\n`, 'my-duty.csv');
  assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 300));
  const row = staged.body.rows[0];
  assert.equal(row.outcome, 'problem', JSON.stringify(row));
  assert.ok(row.fieldErrors?.duty_type && !row.fieldErrors.duty_type_id, JSON.stringify(row.fieldErrors));
  const fixed = await put(reyes.token, `/api/me/imports/${staged.body.id}`, { rows: { [row.ref]: { fix: { duty_type: 'SAF' } } } });
  assert.equal(fixed.body.rows[0].outcome, 'update', JSON.stringify(fixed.body.rows[0]));
  await del(reyes.token, `/api/me/imports/${staged.body.id}`);

  // Okafor serves in G-8 and G-1, which each have a DNCO: a row moving their duty to G-1 finds G-1's.
  const theirs = await recorded(okafor.token, { date: '2026-04-24', end_date: '2026-04-24', title: 'Friday DNCO' });
  const moving = await upload(okafor.token, `Vantage ID,Duty Type,Start Date,Start Time,End Date,End Time,Title,Unit ID\n${theirs.id},DNCO,2026-04-24,0800,2026-04-24,1600,Friday DNCO,G1\n`, 'my-duty.csv');
  assert.equal(moving.body.rows[0].outcome, 'update', JSON.stringify(moving.body.rows[0]));
  const done = await post(okafor.token, `/api/me/imports/${moving.body.id}/commit`, { expected: { new: 0, update: 1 } });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  assert.deepEqual(['unit_id', 'duty_type_id', 'calculated_points'].map((k) => rowOf('duties', theirs.id)![k]), ['G1', T.g1, 9], 'scored by G-1’s version');

  // Reyes serves only in G-8. A row naming G-1 never searches G-1's types: its type name gets the answer a name nobody
  // has gets, and nothing of G-1's comes back.
  const answer = async (type: string) => {
    const s = await upload(reyes.token, `Vantage ID,Duty Type,Start Date,Start Time,End Date,End Time,Title,Unit ID\n${d.id},${type},2026-04-23,0800,2026-04-23,1600,Thursday DNCO,G1\n`, 'my-duty.csv');
    assert.equal(s.status, 201, JSON.stringify(s.body).slice(0, 300));
    await del(reyes.token, `/api/me/imports/${s.body.id}`);
    return s.body.rows[0] as Record<string, any>;
  };
  const g1Only = await answer('G-1 Duty NCO');
  const nobodys = await answer('Nobody’s watch');
  assert.equal(g1Only.outcome, 'problem');
  assert.equal(g1Only.reason.replace('G-1 Duty NCO', '…'), nobodys.reason.replace('Nobody’s watch', '…'), JSON.stringify([g1Only, nobodys]));
  assert.ok(!JSON.stringify(g1Only).includes(T.g1), 'no G-1 type id');
  const ours = await answer('SAF');
  assert.equal(ours.outcome, 'problem');
  assert.match(ours.reason, /unit you serve in/, 'the problem is the unit, not the type');
  assert.equal(rowOf('duties', d.id)!.unit_id, 'G8');
});

test('one’s own duty reported across two Unit Instances is read against each instance’s own scoring', async () => {
  // Okafor now has duty in G-8 and in G-1 (above).
  const report = await get(okafor.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'self', period: 'all' })}`);
  assert.equal(report.status, 200, JSON.stringify(report.body).slice(0, 300));
  const tables = report.body.sections.flatMap((s: { tables: Array<Record<string, any>> }) => s.tables) as Array<Record<string, any>>;
  const stood = tables.find((t) => t.id === 'stood')!;
  assert.ok(stood.columns.some((c: { key: string }) => c.key === 'instance'), 'each duty says its Unit Instance');
  assert.ok(stood.rows.some((r: Record<string, unknown>) => r.instance === 'MARFORRES G-1' && r.points === 9), JSON.stringify(stood.rows));
  assert.ok(tables.some((t) => t.id === 'types') && tables.some((t) => t.id === 'types_G1'), 'G-8’s scoring, and G-1’s beside it');
  assert.ok(tables.find((t) => t.id === 'versions_G1')!.rows.length >= 1);
  assert.deepEqual(['types_G1', 'versions_G1'].map((id) => tables.find((t) => t.id === id)!.title), ['Duty types (G1)', 'Scoring versions (G1)'], 'a workbook sheet says whose it is');
  assert.ok(report.body.notes.some((n: string) => /another Unit Instance you serve in/.test(n)));
  // A suspended instance is not one Okafor serves in now, as the duty form says.
  app.ctx.db.prepare("UPDATE organizations SET status = 'suspended' WHERE id = 'G1'").run();
  const suspended = await get(okafor.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'self', period: 'all' })}`);
  app.ctx.db.prepare("UPDATE organizations SET status = 'active' WHERE id = 'G1'").run();
  assert.equal(suspended.status, 200, JSON.stringify(suspended.body).slice(0, 300));
  assert.deepEqual(suspended.body.sections.flatMap((x: { tables: Array<{ id: string }> }) => x.tables).filter((x: { id: string }) => /_G1$/.test(x.id)), []);
  // One Unit Instance: no instance column.
  const single = await get(reyes.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'self', period: 'all' })}`);
  assert.ok(!single.body.sections.flatMap((s: { tables: Array<Record<string, any>> }) => s.tables).find((t: Record<string, any>) => t.id === 'stood').columns.some((c: { key: string }) => c.key === 'instance'));

  // Okafor leaves G-1, which then adds a type. Their G-1 duty is still theirs, by its type and version, but G-1's
  // types and scoring are its members' now.
  assert.equal((await del(g1lead.token, `/api/org/units/G1/members/${okafor.id}`)).status, 200);
  const at = '2026-05-01T00:00:00.000Z';
  app.ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run('dr-g1-later', 'G1', 'LATER', 'G-1 Later watch', 'Added after they left', at, at);
  okafor.token = await login('dutyokafor');
  // A sheet row for their G-1 duty, frozen now, is matched to its own type alone: G-1's new type gets the answer a name
  // nobody has gets, with the unit named or not, and on the review too. The row as it stands is still unchanged.
  const frozen = app.ctx.db.prepare("SELECT id FROM duties WHERE user_id = ? AND unit_id = 'G1' AND title = 'Friday DNCO'").get(okafor.id) as { id: string };
  const sheetRow = async (type: string, unit: string | null) => {
    const csv = unit === null
      ? `Vantage ID,Duty Type,Start Date,Start Time,End Date,End Time,Title\n${frozen.id},${type},2026-04-24,0800,2026-04-24,1600,Friday DNCO\n`
      : `Vantage ID,Duty Type,Start Date,Start Time,End Date,End Time,Title,Unit ID\n${frozen.id},${type},2026-04-24,0800,2026-04-24,1600,Friday DNCO,${unit}\n`;
    const staged = await upload(okafor.token, csv, 'my-duty.csv');
    assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 300));
    return staged;
  };
  for (const unit of [null, 'G1', 'G8']) {
    const later = await sheetRow('LATER', unit);
    const nobody = await sheetRow('Nobody’s watch', unit);
    assert.equal(later.body.rows[0].reason, nobody.body.rows[0].reason, `${unit}: ${JSON.stringify([later.body.rows[0], nobody.body.rows[0]])}`);
    assert.match(later.body.rows[0].reason, /frozen/);
    assert.ok(!JSON.stringify(later.body).includes('dr-g1-later'), 'no G-1 type id');
    const fixed = await put(okafor.token, `/api/me/imports/${nobody.body.id}`, { rows: { [nobody.body.rows[0].ref]: { fix: { duty_type: 'G-1 Later watch' } } } });
    assert.equal(fixed.body.rows[0].reason, nobody.body.rows[0].reason, JSON.stringify(fixed.body.rows[0]));
    assert.ok(!JSON.stringify(fixed.body).includes('dr-g1-later'));
    for (const s of [later, nobody]) await del(okafor.token, `/api/me/imports/${s.body.id}`);
  }
  const asItStands = await sheetRow('DNCO', 'G1');
  assert.equal(asItStands.body.rows[0].outcome, 'unchanged', JSON.stringify(asItStands.body.rows[0]));
  await del(okafor.token, `/api/me/imports/${asItStands.body.id}`);
  const left = await get(okafor.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'self', period: 'all' })}`);
  assert.equal(left.status, 200, JSON.stringify(left.body).slice(0, 300));
  const leftTables = left.body.sections.flatMap((s: { tables: Array<Record<string, any>> }) => s.tables) as Array<Record<string, any>>;
  assert.ok(leftTables.find((t) => t.id === 'stood')!.rows.some((r: Record<string, unknown>) => r.instance === 'MARFORRES G-1' && r.version === 1));
  assert.deepEqual(leftTables.filter((t) => /_G1$/.test(t.id)), [], 'none of G-1’s configuration');
  assert.ok(!JSON.stringify(left.body).includes('Later watch'));
  assert.ok(left.body.notes.some((n: string) => /no longer serve in/.test(n)));

  // Someone who serves in no Unit Instance now is shown no instance's types or scoring.
  const leaver = await app.register('dutyleaver');
  await enroll(app, op.token, 'G8', leaver.id);
  leaver.token = await login('dutyleaver');
  await recorded(leaver.token, { date: '2026-04-28', end_date: '2026-04-28' });
  assert.equal((await del(op.token, `/api/org/units/G8/members/${leaver.id}`)).status, 200);
  leaver.token = await login('dutyleaver');
  const none = await get(leaver.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'self', period: 'all' })}`);
  assert.equal(none.status, 200, JSON.stringify(none.body).slice(0, 300));
  assert.deepEqual(none.body.sections.map((s: { id: string }) => s.id), ['stood']);
  assert.equal(none.body.sections[0].tables[0].rows.length, 1);
  assert.equal(none.body.summary.find((s: { label: string }) => s.label === 'Duty types in use').value, null);
  assert.ok(none.body.notes.some((n: string) => /serve in no Unit Instance/.test(n)));
  assert.ok(!none.body.notes.some((n: string) => /your own instance’s\./.test(n)));
});

test('undoing an import never puts one’s own duty back in a unit one no longer serves in', async () => {
  const section = (app.ctx.db.prepare("SELECT id FROM units WHERE name = 'G8 Duty Section'").get() as { id: string }).id;
  await enroll(app, op.token, section, diaz.id);
  diaz.token = await login('dutydiaz');
  const d = await recorded(diaz.token, { unit_id: section, date: '2026-04-27', end_date: '2026-04-27', title: 'Section DNCO' });
  // A sheet with its Vantage ID moves it to G-8.
  const staged = await upload(diaz.token, `Vantage ID,Duty Type,Start Date,Start Time,End Date,End Time,Title,Unit ID\n${d.id},DNCO,2026-04-27,0800,2026-04-27,1600,Section DNCO,G8\n`, 'my-duty.csv');
  assert.equal(staged.body.rows[0].outcome, 'update', JSON.stringify(staged.body.rows[0]));
  assert.equal((await post(diaz.token, `/api/me/imports/${staged.body.id}/commit`, { expected: { new: 0, update: 1 } })).status, 200);
  assert.equal(rowOf('duties', d.id)!.unit_id, 'G8');
  // Diaz leaves the section, where Counsel from G-8 still reaches.
  assert.equal((await del(op.token, `/api/org/units/${section}/members/${diaz.id}`)).status, 200);
  diaz.token = await login('dutydiaz');
  const undone = await post(diaz.token, `/api/me/imports/${staged.body.id}/undo`);
  assert.equal(undone.status, 200, JSON.stringify(undone.body).slice(0, 300));
  assert.equal(rowOf('duties', d.id)!.unit_id, 'G8', 'it stays where its owner can correct it');
  assert.equal((await put(diaz.token, `/api/records/duties/${d.id}`, { title: 'Section DNCO, corrected' })).status, 200);
});

test('a duty row’s conditions corrected on the review: cleared come in as none, and one that still does not read is said at its field', async () => {
  const staged = await upload(reyes.token, 'Duty Type,Start Date,Start Time,End Date,End Time,Title,Conditions\nDNCO,2026-05-04,0800,2026-05-04,1600,Monday DNCO,Moonlight\n', 'my-duty.csv');
  assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 300));
  const row = staged.body.rows[0];
  assert.equal(row.outcome, 'problem', JSON.stringify(row));
  const fix = (id: string, ref: string, conditions: unknown) => put(reyes.token, `/api/me/imports/${id}`, { rows: { [ref]: { fix: { conditions } } } });
  // A correction that still does not read is said as the cell was, at its field, so the row keeps its Fix.
  for (const wrong of ['Moonlight', 'Holiday; Moonlight', ['bogus']]) {
    const res = await fix(staged.body.id, row.ref, wrong);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    const r = res.body.rows[0];
    assert.equal(r.outcome, 'problem', `${JSON.stringify(wrong)}: ${JSON.stringify(r)}`);
    assert.match(String(r.reason), /^Conditions: “(Moonlight|bogus)” is not one of: /, JSON.stringify(r));
    assert.ok(r.fieldErrors?.conditions, JSON.stringify(r));
  }
  const holiday = await fix(staged.body.id, row.ref, 'holiday');
  assert.equal(holiday.body.rows[0].outcome, 'new', JSON.stringify(holiday.body.rows[0]));
  assert.deepEqual(holiday.body.rows[0].fields.conditions, ['holiday']);
  const cleared = await fix(staged.body.id, row.ref, null);
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body).slice(0, 300));
  assert.equal(cleared.body.rows[0].outcome, 'new', JSON.stringify(cleared.body.rows[0]));
  const done = await post(reyes.token, `/api/me/imports/${staged.body.id}/commit`, { expected: { new: 1, update: 0 } });
  assert.equal(done.status, 200, JSON.stringify(done.body).slice(0, 300));
  const made = app.ctx.db.prepare("SELECT id, conditions FROM duties WHERE user_id = ? AND title = 'Monday DNCO'").get(reyes.id) as { id: string; conditions: string };
  assert.deepEqual(JSON.parse(made.conditions), []);

  // On a row updating it, the same: never taken as saying what the duty already says.
  const again = await upload(reyes.token, `Vantage ID,Duty Type,Start Date,Start Time,End Date,End Time,Title,Conditions\n${made.id},DNCO,2026-05-04,0800,2026-05-04,1600,Monday DNCO,Moonlight\n`, 'my-duty-again.csv');
  assert.equal(again.status, 201, JSON.stringify(again.body).slice(0, 300));
  const update = again.body.rows[0];
  assert.equal(update.outcome, 'problem', JSON.stringify(update));
  const still = await fix(again.body.id, update.ref, 'Moonlight');
  assert.equal(still.body.rows[0].outcome, 'problem', JSON.stringify(still.body.rows[0]));
  assert.match(String(still.body.rows[0].reason), /^Conditions: “Moonlight” is not one of: /);
  const claimed = await fix(again.body.id, update.ref, 'Holiday');
  assert.equal(claimed.body.rows[0].outcome, 'update', JSON.stringify(claimed.body.rows[0]));
  assert.equal((await del(reyes.token, `/api/me/imports/${again.body.id}`)).status, 200);
});
