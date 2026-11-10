import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { PERMISSIONS, PERMISSION_LIST, ROLE_TEMPLATE, ALL_PERMISSIONS, FULL_UNIT_AUTHORITY, NAMED_ONLY_BITS, has } from '../../shared/permissions.ts';
import { DUTY_REVIEW_COLUMNS, NO_REVIEW_OPTIONS, countedPoints, dutyReviewOptions, hasReviewOptions, isOverridden, overridePoints, type DutyReviewAuthority } from '../../shared/dutyReview.ts';
import { dutyReviewAuthority, dutyReviewUnits } from '../../server/authz/records.ts';
import { scopeFor, type Scope } from '../../server/authz/scope.ts';
import { guardSelfNamed, guardSelfReach } from '../../server/services/org.ts';
import { instanceBoundaryViolations } from '../../server/db/index.ts';
import { exportInstance, importInstance } from '../../server/services/exports.ts';
import { saveSchedule, runDisposition } from '../../server/services/retention.ts';
import { REDACTED } from '../../shared/constants.ts';
import type { SessionUser } from '../../server/context.ts';

/**
 * Task 18 (ADR-0024): duty is submitted, waits for review, and is approved, returned or rejected. Only approved duty
 * counts, at its approved points. Who decides it is the server's to say: a reviewer of its unit, never its own Marine
 * unless a role names that authority, which nobody gives themselves. Points apart from the calculated ones take their own
 * permission and a reason. A decision never rescores, and every one is kept.
 */

let app: TestApp;
/** Leads G-8: every permission in it but approving their own duty. */
let op: { token: string; id: string; unitId: string };
/** The Marine who stands duty. */
let reyes: { token: string; id: string };
/** A fire team leader: reads shared records and counsels, but does not review duty. */
let diaz: { token: string; id: string };
/** An SNCO: reviews duty. */
let nguyen: { token: string; id: string };
/** The SNCOIC: reviews duty and may set its points apart from the calculated ones. */
let top: { token: string; id: string };
/** A Marine of the same unit with no authority over others. */
let okafor: { token: string; id: string };
/** Leads another Unit Instance. */
let g1lead: { token: string; id: string };

const T = { dnco: 'rv-dnco', g1: 'rv-g1-dnco' };
const V = { v1: 'rv-v1', v2: 'rv-v2', g1: 'rv-g1-v1' };

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const del = (token: string, path: string) => app.call('DELETE', path, { token });
const login = async (username: string) => (await app.login(username)).body.token as string;
const rowOf = (table: string, id: string) => app.ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, any> | undefined;
const historyOf = (id: string) => app.ctx.db.prepare('SELECT * FROM duty_reviews WHERE duty_id = ? ORDER BY created_at, rowid').all(id) as Array<Record<string, any>>;
const auditOf = (action: string, id: string) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? AND entity_id = ? ORDER BY seq').all(action, id) as Array<Record<string, any>>;
const notesFor = (userId: string, dutyId: string) => app.ctx.db.prepare("SELECT * FROM notifications WHERE user_id = ? AND kind = 'duty' AND action_url = ? ORDER BY created_at, rowid").all(userId, `/record/duty?open=${dutyId}`) as Array<Record<string, any>>;
const dayAfter = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const upload = (token: string, data: string, filename: string) =>
  app.call('POST', '/api/me/imports', { token, raw: Buffer.from(data), headers: { 'content-type': 'text/csv', 'x-filename': filename } });

// Each test's duty on a weekday of its own in March and April 2026 (3 points under version 1), so none reads as another's.
const WEEKDAYS = ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-09', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19',
  '2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-06', '2026-04-07', '2026-04-08', '2026-04-09',
  '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-20', '2026-04-21', '2026-04-22', '2026-04-23', '2026-04-27', '2026-04-28', '2026-04-29', '2026-04-30'];
let nextDay = 0;
/** One duty as the form sends it: a DNCO in G8, 0800 to 1600, unless the test says otherwise. */
const duty = (over: Record<string, unknown> = {}) => {
  const date = (over.date as string | undefined) ?? WEEKDAYS[nextDay++ % WEEKDAYS.length];
  return { duty_type_id: T.dnco, date, start_time: '0800', end_date: date, end_time: '1600', unit_id: 'G8', ...over };
};
async function recorded(token: string, over: Record<string, unknown> = {}) {
  const res = await post(token, '/api/records/duties', duty(over));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as Record<string, any>;
}
const review = (token: string, id: string, body: Record<string, unknown>) => post(token, `/api/records/duties/${id}/review`, body);
/** Decides a duty as it stands now. */
async function decide(token: string, id: string, action: string, extra: Record<string, unknown> = {}) {
  const res = await review(token, id, { action, version: rowOf('duties', id)!.version, ...extra });
  assert.equal(res.status, 200, `${action}: ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}
/** A role defined in G-8 by its Unit Leader. */
async function role(name: string, permissions: number, position = 10) {
  const res = await post(op.token, '/api/org/roles', { unit_id: 'G8', name, position, permissions });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { id: string; name: string; permissions: number };
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  reyes = await app.register('rvreyes', { rank_id: 'Cpl', last_name: 'Reyes' });
  diaz = await app.register('rvdiaz', { rank_id: 'Sgt', last_name: 'Diaz' });
  nguyen = await app.register('rvnguyen', { rank_id: 'SSgt', last_name: 'Nguyen' });
  top = await app.register('rvtop', { rank_id: 'GySgt', last_name: 'Alvarez' });
  okafor = await app.register('rvokafor', { rank_id: 'LCpl', last_name: 'Okafor' });
  await enroll(app, op.token, 'G8', reyes.id);
  await enroll(app, op.token, 'G8', diaz.id, 'fire-team-leader');
  await enroll(app, op.token, 'G8', nguyen.id, 'snco');
  await enroll(app, op.token, 'G8', top.id, 'sncoic');
  await enroll(app, op.token, 'G8', okafor.id);
  for (const [name, who] of [['rvreyes', reyes], ['rvdiaz', diaz], ['rvnguyen', nguyen], ['rvtop', top], ['rvokafor', okafor]] as const) who.token = await login(name);
  const lead = await app.register('rvg1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: lead.id })).status, 201);
  g1lead = { id: lead.id, token: await login('rvg1lead') };

  const at = '2025-12-20T00:00:00.000Z';
  const type = app.ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)');
  type.run(T.dnco, 'G8', 'DNCO', 'Duty NCO', at, at);
  type.run(T.g1, 'G1', 'DNCO', 'G-1 Duty NCO', at, at);
  const version = app.ctx.db.prepare('INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  version.run(V.v1, 'G8', 1, '2026-01-01', JSON.stringify({ rules: [{ duty_type_id: T.dnco, method: 'fixed', points: 3, bands: null }], multipliers: [{ condition: 'weekend', factor: 1.5 }], combine: 'highest' }), 'First policy', op.id, at);
  // In force today: an approval made now must not take its points from here for duty stood under version 1.
  version.run(V.v2, 'G8', 2, '2026-06-01', JSON.stringify({ rules: [{ duty_type_id: T.dnco, method: 'per_hour', points: 0.25, bands: null }], multipliers: [], combine: 'highest' }), 'Per hour from June', op.id, at);
  version.run(V.g1, 'G1', 1, '2026-01-01', JSON.stringify({ rules: [{ duty_type_id: T.g1, method: 'fixed', points: 9, bands: null }], multipliers: [], combine: 'highest' }), 'G-1 policy', lead.id, at);
});
after(async () => { await app.close(); });

// ---------------------------------------------------------------------------------------------------------------------
// The rule

test('the rule: a reviewer decides other Marines’ duty, nobody their own without named authority, and a frozen duty is not returned', () => {
  const none: DutyReviewAuthority = { review: false, override: false, ownApproval: false, correct: false };
  const reviewer = { ...none, review: true };
  const overrider = { ...reviewer, override: true };
  const d = (status: string, over: Record<string, unknown> = {}) => ({ user_id: 'marine', approval_status: status, ...over });
  const open = (o: object) => Object.entries(o).filter(([, v]) => v).map(([k]) => k).sort();

  // Somebody else's duty.
  assert.deepEqual(open(dutyReviewOptions(d('pending'), 'rev', reviewer)), ['approve', 'reject', 'return']);
  assert.deepEqual(open(dutyReviewOptions(d('pending'), 'rev', overrider)), ['approve', 'approve_with_points', 'reject', 'return']);
  assert.deepEqual(open(dutyReviewOptions(d('approved'), 'rev', reviewer)), ['reopen']);
  assert.deepEqual(open(dutyReviewOptions(d('approved'), 'rev', overrider)), ['change_points', 'reopen']);
  assert.deepEqual(open(dutyReviewOptions(d('rejected'), 'rev', overrider)), ['reopen']);
  assert.deepEqual(open(dutyReviewOptions(d('returned'), 'rev', reviewer)), ['reopen']);
  assert.deepEqual(open(dutyReviewOptions(d('returned'), 'rev', { ...reviewer, correct: true })), ['reopen', 'resubmit'], 'a records manager may send it back too');
  // Overriding without reviewing changes approved points and nothing else.
  assert.deepEqual(open(dutyReviewOptions(d('approved'), 'rev', { ...none, override: true })), ['change_points']);
  assert.deepEqual(open(dutyReviewOptions(d('pending'), 'rev', { ...none, override: true })), []);
  // Frozen when its Marine left: approved or rejected, never returned to someone who cannot correct it.
  assert.deepEqual(open(dutyReviewOptions(d('pending', { frozen_at: '2026-01-01' }), 'rev', overrider)), ['approve', 'approve_with_points', 'reject']);

  // One's own duty: whatever one holds over others' duty decides nothing about one's own.
  const everything = { review: true, override: true, ownApproval: false, correct: true };
  assert.deepEqual(open(dutyReviewOptions(d('pending'), 'marine', everything)), []);
  assert.deepEqual(open(dutyReviewOptions(d('approved'), 'marine', everything)), []);
  assert.deepEqual(open(dutyReviewOptions(d('rejected'), 'marine', everything)), []);
  assert.deepEqual(open(dutyReviewOptions(d('returned'), 'marine', everything)), ['resubmit']);
  // Named authority approves it, at its calculated points, and nothing more.
  const named = { ...everything, ownApproval: true };
  assert.deepEqual(open(dutyReviewOptions(d('pending'), 'marine', named)), ['approve']);
  assert.deepEqual(open(dutyReviewOptions(d('approved'), 'marine', named)), []);
  assert.deepEqual(open(dutyReviewOptions(d('pending', { frozen_at: '2026-01-01' }), 'marine', named)), [], 'not once they have left its unit');
  // Nobody signed in, and a duty in the recycle bin.
  assert.deepEqual(dutyReviewOptions(d('pending'), null, overrider), NO_REVIEW_OPTIONS);
  assert.deepEqual(dutyReviewOptions(d('pending', { deleted_at: '2026-01-01' }), 'rev', overrider), NO_REVIEW_OPTIONS);
  assert.equal(hasReviewOptions(NO_REVIEW_OPTIONS), false);
  assert.equal(hasReviewOptions(dutyReviewOptions(d('pending'), 'rev', reviewer)), true);

  // What counts, and what an override may be.
  assert.equal(countedPoints({ approval_status: 'approved', approved_points: 4.5 }), 4.5);
  for (const status of ['pending', 'returned', 'rejected']) assert.equal(countedPoints({ approval_status: status, approved_points: 4.5 }), 0, status);
  assert.equal(isOverridden({ approval_status: 'approved', points_overridden_at: '2026-01-01' }), true);
  assert.equal(isOverridden({ approval_status: 'approved', points_overridden_at: null }), false);
  assert.deepEqual([overridePoints(0), overridePoints('2.5'), overridePoints(3.14159), overridePoints(100_000)], [0, 2.5, 3.14, 100_000]);
  for (const bad of [-1, 100_000.01, 'abc', '', null, undefined, NaN, Infinity, {}, '1e9']) assert.equal(overridePoints(bad), null, String(bad));
});

test('the permissions: three for duty, the SNCO reviews, the SNCOIC overrides too, and approving your own duty is in no standard role or authority', () => {
  for (const key of ['REVIEW_DUTY', 'OVERRIDE_DUTY_POINTS', 'APPROVE_OWN_DUTY'] as const) {
    const listed = PERMISSION_LIST.find((p) => p.key === key);
    assert.equal(listed?.group, 'Duty', key);
    assert.ok(ALL_PERMISSIONS & PERMISSIONS[key], key);
  }
  assert.equal((PERMISSION_LIST.find((p) => p.key === 'APPROVE_OWN_DUTY') as { dangerous?: boolean } | undefined)?.dangerous, true);
  assert.equal(new Set(Object.values(PERMISSIONS)).size, Object.values(PERMISSIONS).length, 'no two permissions share a bit');
  const template = (key: string) => ROLE_TEMPLATE.find((r) => r.key === key)!.permissions;
  for (const key of ['marine', 'nco', 'fire-team-leader']) assert.equal(template(key) & (PERMISSIONS.REVIEW_DUTY | PERMISSIONS.OVERRIDE_DUTY_POINTS), 0, key);
  assert.ok(template('snco') & PERMISSIONS.REVIEW_DUTY);
  assert.equal(template('snco') & PERMISSIONS.OVERRIDE_DUTY_POINTS, 0);
  assert.ok(template('sncoic') & PERMISSIONS.REVIEW_DUTY && template('sncoic') & PERMISSIONS.OVERRIDE_DUTY_POINTS);
  // Role only (John, 2026-11-10): no standard role names it, and neither full unit authority nor leading a unit carries it.
  for (const r of ROLE_TEMPLATE) assert.equal(r.permissions & PERMISSIONS.APPROVE_OWN_DUTY, 0, r.key);
  assert.equal(NAMED_ONLY_BITS, PERMISSIONS.APPROVE_OWN_DUTY);
  assert.equal(FULL_UNIT_AUTHORITY & PERMISSIONS.APPROVE_OWN_DUTY, 0);
  assert.equal(FULL_UNIT_AUTHORITY | PERMISSIONS.APPROVE_OWN_DUTY, ALL_PERMISSIONS);
  assert.equal(has(PERMISSIONS.ADMINISTRATOR, PERMISSIONS.APPROVE_OWN_DUTY), false);
  assert.equal(has(FULL_UNIT_AUTHORITY, PERMISSIONS.APPROVE_OWN_DUTY), false);
  assert.equal(has(PERMISSIONS.ADMINISTRATOR, PERMISSIONS.REVIEW_DUTY), true, 'full authority still reviews others’ duty');
  assert.equal(has(PERMISSIONS.ADMINISTRATOR | PERMISSIONS.APPROVE_OWN_DUTY, PERMISSIONS.APPROVE_OWN_DUTY), true, 'a role that names it gives it');

  // In the database as seeded: the same.
  const seeded = app.ctx.db.prepare("SELECT key, permissions FROM roles WHERE unit_id = 'G8' AND is_system = 1").all() as Array<{ key: string; permissions: number }>;
  assert.ok(seeded.length >= 6);
  for (const r of seeded) assert.equal(r.permissions & PERMISSIONS.APPROVE_OWN_DUTY, 0, r.key);
  const leader = scopeFor(app.ctx, { id: op.id });
  assert.ok(leader.ownedUnitIds.includes('G8'));
  assert.equal(leader.permissions.G8 & PERMISSIONS.APPROVE_OWN_DUTY, 0, 'the Unit Leader’s own bits do not hold it');
});

test('review authority is held through the chain of command: Vantage access and Unit Instance authority never complete it', () => {
  const row = { id: 'd', user_id: 'marine', unit_id: 'U', visibility: 'unit' };
  const scope = (sources: Array<{ kind: string; bits: number }>) => ({
    sources: { U: sources.map((s) => ({ ...s, unitId: 'U' })) }, permissions: { U: sources.reduce((b, s) => b | s.bits, 0) }, unitIds: [], positions: {},
  }) as unknown as Scope;
  const R = PERMISSIONS.REVIEW_DUTY, O = PERMISSIONS.OVERRIDE_DUTY_POINTS, READ = PERMISSIONS.VIEW_RECORDS;
  assert.deepEqual(dutyReviewAuthority(scope([{ kind: 'role', bits: R | O | READ }]), 'rev', row), { review: true, override: true, ownApproval: false, correct: false });
  // Reviewing reads nothing by itself.
  assert.equal(dutyReviewAuthority(scope([{ kind: 'role', bits: R | O }]), 'rev', row).review, false);
  assert.equal(dutyReviewAuthority(scope([{ kind: 'role', bits: R | O }]), 'rev', row).override, false);
  // Read-only Vantage access does not turn a role that cannot read into one that decides.
  const mixed = scope([{ kind: 'role', bits: R | O }, { kind: 'vantage', bits: READ }]);
  assert.equal(dutyReviewAuthority(mixed, 'rev', row).review, false);
  assert.deepEqual(dutyReviewUnits(mixed), []);
  assert.equal(dutyReviewAuthority(scope([{ kind: 'org', bits: R | READ }]), 'rev', row).review, false, 'nor does Unit Instance authority');
  assert.equal(dutyReviewAuthority(scope([{ kind: 'vantage', bits: R | O | READ | PERMISSIONS.APPROVE_OWN_DUTY }]), 'marine', row).ownApproval, false);
  // Inherited from a unit above, or held by leading: the chain of command.
  assert.equal(dutyReviewAuthority(scope([{ kind: 'inherited', bits: R | READ }]), 'rev', row).review, true);
  assert.deepEqual(dutyReviewAuthority(scope([{ kind: 'owner', bits: FULL_UNIT_AUTHORITY }]), 'rev', row), { review: true, override: true, ownApproval: false, correct: true });
  assert.equal(dutyReviewAuthority(scope([{ kind: 'owner', bits: FULL_UNIT_AUTHORITY }]), 'marine', row).ownApproval, false, 'leading the unit is not it');
  assert.equal(dutyReviewAuthority(scope([{ kind: 'owner', bits: FULL_UNIT_AUTHORITY }, { kind: 'role', bits: PERMISSIONS.APPROVE_OWN_DUTY }]), 'marine', row).ownApproval, true);
  assert.deepEqual(dutyReviewUnits(scope([{ kind: 'role', bits: R | READ }])), ['U']);
});

// ---------------------------------------------------------------------------------------------------------------------
// Submit, pending review, approve / return / reject

test('duty is submitted and waits: it counts nothing until a reviewer approves it, at the points it was scored under its own version', async () => {
  const d = await recorded(reyes.token, { title: 'Battalion DNCO', notes: 'Quiet night.' });
  assert.deepEqual([d.approval_status, d.calculated_points, d.approved_points, d.scoring_version], ['pending', 3, null, 1]);
  assert.deepEqual(d.review, NO_REVIEW_OPTIONS, 'its own Marine decides nothing about it');
  assert.equal(countedPoints(d as never), 0);
  assert.deepEqual(historyOf(d.id), [], 'recording it is not a review');

  // What each reader may do comes with the duty.
  const forReviewer = await get(nguyen.token, `/api/records/duties/${d.id}`);
  assert.deepEqual(forReviewer.body.review, { ...NO_REVIEW_OPTIONS, approve: true, return: true, reject: true });
  assert.deepEqual((await get(top.token, `/api/records/duties/${d.id}`)).body.review, { ...NO_REVIEW_OPTIONS, approve: true, approve_with_points: true, return: true, reject: true });
  assert.deepEqual((await get(diaz.token, `/api/records/duties/${d.id}`)).body.review, NO_REVIEW_OPTIONS, 'reading it is not reviewing it');
  assert.deepEqual((await get(op.token, `/api/records/duties/${d.id}`)).body.review, { ...NO_REVIEW_OPTIONS, approve: true, approve_with_points: true, return: true, reject: true }, 'the Unit Leader reviews others’ duty');

  // A decision is for the duty as the reviewer saw it.
  const stale = await review(nguyen.token, d.id, { action: 'approve', version: d.version + 5 });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'stale');
  assert.equal(stale.body.current.id, d.id);
  assert.equal((await review(nguyen.token, d.id, { action: 'approve' })).status, 400, 'the version it was decided at is required');
  assert.equal((await review(nguyen.token, d.id, { action: 'bless', version: d.version })).status, 400);
  assert.equal(rowOf('duties', d.id)!.approval_status, 'pending');

  const approved = await review(nguyen.token, d.id, { action: 'approve', version: d.version });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual([approved.body.approval_status, approved.body.approved_points, approved.body.calculated_points, approved.body.scoring_version, approved.body.version], ['approved', 3, 3, 1, d.version + 1]);
  assert.deepEqual(approved.body.review, { ...NO_REVIEW_OPTIONS, reopen: true });
  const row = rowOf('duties', d.id)!;
  assert.deepEqual([row.approval_status, row.approved_points, row.reviewed_by, row.review_reason, row.points_overridden_at, row.points_overridden_by, row.points_override_reason], ['approved', 3, nguyen.id, null, null, null, null]);
  assert.ok(row.reviewed_at);
  // Version 2 is in force today and would give 2 points for these 8 hours: the approval did not rescore it.
  assert.deepEqual([row.calculated_points, row.scoring_version, row.scoring_policy_id], [3, 1, V.v1]);
  assert.equal(countedPoints(row as never), 3);

  // Kept: one line of history, one audit entry, and its Marine is told by its type and day, never its words.
  const history = historyOf(d.id);
  assert.equal(history.length, 1);
  assert.deepEqual([history[0].event, history[0].from_status, history[0].to_status, history[0].actor_id, history[0].unit_id, history[0].calculated_points, history[0].approved_points, history[0].scoring_version, history[0].override, history[0].by_owner, history[0].reason],
    ['approved', 'pending', 'approved', nguyen.id, 'G8', 3, 3, 1, 0, 0, null]);
  const trail = auditOf('duty_approved', d.id);
  assert.equal(trail.length, 1);
  assert.deepEqual([trail[0].actor_id, trail[0].subject_id, trail[0].unit_id, trail[0].entity], [nguyen.id, reyes.id, 'G8', 'duties']);
  assert.match(trail[0].detail, /calculated 3; approved 3; scoring version 1/);
  const told = notesFor(reyes.id, d.id);
  assert.equal(told.length, 1);
  assert.equal(told[0].title, 'Duty approved');
  assert.match(told[0].message, /Nguyen approved Duty NCO on \d{4}-\d\d-\d\d for 3 points\./);
  assert.ok(!/Battalion|Quiet/.test(told[0].message + told[0].title), 'never the duty’s words');
  assert.deepEqual(notesFor(nguyen.id, d.id), [], 'nobody is told of what they did themselves');

  // Decided, it is not decided again, corrected or deleted.
  const twice = await review(top.token, d.id, { action: 'approve', version: row.version });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, 'duty_not_pending');
  assert.equal((await review(top.token, d.id, { action: 'reject', reason: 'No.', version: row.version })).body.code, 'duty_not_pending');
  assert.equal((await put(reyes.token, `/api/records/duties/${d.id}`, { title: 'x' })).body.code, 'duty_decided');
  assert.equal((await del(reyes.token, `/api/records/duties/${d.id}`)).body.code, 'duty_decided');
  assert.equal(historyOf(d.id).length, 1);
});

test('returned with a reason, a duty is corrected and goes back for review by itself; rejected, it stays until a reviewer reopens it', async () => {
  const d = await recorded(reyes.token, { title: 'DNCO, wrong times' });
  // A return and a rejection say why.
  for (const action of ['return', 'reject']) {
    const bare = await review(nguyen.token, d.id, { action, version: d.version });
    assert.equal(bare.status, 400, action);
    assert.equal(bare.body.fieldErrors.reason, 'Required.');
    assert.equal((await review(nguyen.token, d.id, { action, reason: '   ', version: d.version })).status, 400, `${action}: blank is no reason`);
  }
  assert.equal((await review(nguyen.token, d.id, { action: 'return', reason: 'x'.repeat(1001), version: d.version })).status, 400);
  const returned = await decide(nguyen.token, d.id, 'return', { reason: 'Give the time you were relieved.' });
  assert.deepEqual([returned.approval_status, returned.review_reason, returned.approved_points], ['returned', 'Give the time you were relieved.', null]);
  assert.deepEqual(returned.review, { ...NO_REVIEW_OPTIONS, reopen: true, resubmit: true }, 'an SNCO may correct it and send it back too');
  const mine = await get(reyes.token, `/api/records/duties/${d.id}`);
  assert.deepEqual(mine.body.review, { ...NO_REVIEW_OPTIONS, resubmit: true });
  assert.equal(mine.body.review_reason, 'Give the time you were relieved.', 'its Marine reads why');
  assert.match(String(mine.body.reviewer_name), /SSgt Nguyen/);
  const told = notesFor(reyes.id, d.id);
  assert.equal(told.at(-1)!.title, 'Duty returned for correction');
  assert.ok(!told.at(-1)!.message.includes('relieved'), 'the reason is read on the duty, not in a notification');
  // Returned is not decided: it is not approved or rejected from there.
  assert.equal((await review(nguyen.token, d.id, { action: 'approve', version: returned.version })).body.code, 'duty_not_pending');

  // Correcting it sends it back, in the same save.
  const fixed = await put(reyes.token, `/api/records/duties/${d.id}`, { end_time: '1700', version: returned.version });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.deepEqual([fixed.body.approval_status, fixed.body.hours, fixed.body.review_reason, fixed.body.reviewed_by, fixed.body.approved_points], ['pending', 9, null, null, null]);
  assert.ok(fixed.body.submitted_at >= d.submitted_at, 'it waits from when it was sent back');
  let history = historyOf(d.id);
  assert.deepEqual(history.map((h) => [h.event, h.from_status, h.to_status, h.actor_id, h.by_owner]), [['returned', 'pending', 'returned', nguyen.id, 0], ['resubmitted', 'returned', 'pending', reyes.id, 1]]);
  assert.equal(history[0].reason, 'Give the time you were relieved.', 'the reason stays in its history after the duty moves on');
  assert.equal(auditOf('duty_returned', d.id).length, 1);
  assert.equal(auditOf('duty_resubmitted', d.id).length, 1);
  assert.equal(auditOf('duty_resubmitted', d.id)[0].subject_id, null, 'one’s own duty names no other subject');
  const back = notesFor(nguyen.id, d.id);
  assert.equal(back.length, 1);
  assert.equal(back[0].title, 'Duty sent back for review');

  // Returned again, it can go back as it is, with nothing changed.
  const again = await decide(nguyen.token, d.id, 'return', { reason: 'Still no relief time in the notes.' });
  assert.equal((await review(okafor.token, d.id, { action: 'resubmit', version: again.version })).status, 403, 'not by a Marine who cannot open it');
  assert.equal((await review(diaz.token, d.id, { action: 'resubmit', version: again.version })).body.code, 'duty_review_forbidden', 'nor by a reader who may not correct it');
  const sent = await decide(reyes.token, d.id, 'resubmit');
  assert.equal(sent.approval_status, 'pending');
  assert.equal((await review(reyes.token, d.id, { action: 'resubmit', version: sent.version })).body.code, 'duty_not_returned');

  // Rejected: it stays as decided, for everyone, until a reviewer takes the decision back and says why.
  const rejected = await decide(nguyen.token, d.id, 'reject', { reason: 'Not on the duty roster for that day.' });
  assert.deepEqual([rejected.approval_status, rejected.review_reason], ['rejected', 'Not on the duty roster for that day.']);
  assert.equal(notesFor(reyes.id, d.id).at(-1)!.title, 'Duty rejected');
  assert.equal((await put(reyes.token, `/api/records/duties/${d.id}`, { title: 'x' })).body.code, 'duty_decided');
  assert.equal((await review(reyes.token, d.id, { action: 'resubmit', version: rejected.version })).status, 403);
  const noReason = await review(top.token, d.id, { action: 'reopen', version: rejected.version });
  assert.equal(noReason.status, 400);
  const reopened = await decide(top.token, d.id, 'reopen', { reason: 'The roster was amended; look again.' });
  assert.deepEqual([reopened.approval_status, reopened.reviewed_by, reopened.review_reason, reopened.approved_points], ['pending', null, null, null]);
  assert.equal((await review(top.token, d.id, { action: 'reopen', reason: 'Again.', version: reopened.version })).body.code, 'duty_not_decided');
  assert.equal(notesFor(reyes.id, d.id).at(-1)!.title, 'Duty reopened for review');
  assert.equal(notesFor(nguyen.id, d.id).at(-1)!.title, 'A duty you decided was reopened', 'the reviewer whose decision was undone is told');
  history = historyOf(d.id);
  assert.deepEqual(history.map((h) => h.event), ['returned', 'resubmitted', 'returned', 'resubmitted', 'rejected', 'reopened']);
  assert.equal(history.at(-1)!.reason, 'The roster was amended; look again.');
  assert.equal(auditOf('duty_reopened', d.id).length, 1);
  assert.match(auditOf('duty_reopened', d.id)[0].detail, /was rejected; reason given/);
  // No reason is ever written to the trail: it is append-only, and a retention schedule could not clear it there.
  const everything = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE entity = 'duties' AND entity_id = ?").all(d.id) as Array<{ detail: string | null }>;
  assert.ok(everything.every((e) => !/relieved|roster|relief/i.test(e.detail ?? '')), JSON.stringify(everything));

  // Reopening an approval withdraws its points until it is approved again.
  const ok = await decide(nguyen.token, d.id, 'approve');
  assert.equal(ok.approved_points, ok.calculated_points);
  const undone = await decide(top.token, d.id, 'reopen', { reason: 'Approved by mistake.' });
  assert.deepEqual([undone.approval_status, undone.approved_points], ['pending', null]);
  assert.match(notesFor(reyes.id, d.id).at(-1)!.message, /does not count until it is approved/);
  assert.match(auditOf('duty_reopened', d.id).at(-1)!.detail, /was approved; approved points \d+(\.\d+)? withdrawn/);
});

// ---------------------------------------------------------------------------------------------------------------------
// Who may decide

test('a correction that scores a returned duty again sends it back at its new score, and its history says so', async () => {
  const d = await recorded(reyes.token, { title: 'Recorded on the wrong day' });
  assert.equal(d.calculated_points, 3);
  const returned = await decide(nguyen.token, d.id, 'return', { reason: 'It was the Saturday.' });
  // 9 May 2026 is a Saturday: version 1 gives a weekend duty half as much again.
  const fixed = await put(reyes.token, `/api/records/duties/${d.id}`, { date: '2026-05-09', end_date: '2026-05-09', version: returned.version });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.deepEqual([fixed.body.approval_status, fixed.body.calculated_points, fixed.body.scoring_version, fixed.body.approved_points], ['pending', 4.5, 1, null]);
  assert.deepEqual(historyOf(d.id).map((h) => [h.event, h.calculated_points, h.scoring_version]), [['returned', 3, 1], ['resubmitted', 4.5, 1]], 'the line says what it waits at now');
  // The reviewer whose return it answers is told, though the corrected duty no longer names them.
  assert.ok(notesFor(nguyen.id, d.id).some((n) => /sent back for review/i.test(n.title)), JSON.stringify(notesFor(nguyen.id, d.id).map((n) => n.title)));
  const approved = await decide(nguyen.token, d.id, 'approve');
  assert.deepEqual([approved.approved_points, approved.calculated_points], [4.5, 4.5]);
});

test('a duty’s words are never the marker a retention schedule leaves, so nobody closes their own duty to review by typing it', async () => {
  for (const field of ['title', 'location', 'notes']) {
    const res = await post(reyes.token, '/api/records/duties', duty({ [field]: REDACTED }));
    assert.equal(res.status, 400, `${field}: ${JSON.stringify(res.body)}`);
    assert.deepEqual(Object.keys(res.body.fieldErrors), [field]);
  }
  const d = await recorded(reyes.token, { title: 'Words of its own', notes: 'As stood.' });
  const edited = await put(reyes.token, `/api/records/duties/${d.id}`, { notes: ` ${REDACTED} `, version: d.version });
  assert.equal(edited.status, 400, JSON.stringify(edited.body));
  assert.equal(edited.body.fieldErrors.notes, 'Say this another way.');
  assert.equal(rowOf('duties', d.id)!.notes, 'As stood.');
  // So it stays where its reviewers see it and can decide it.
  const queue = await get(nguyen.token, '/api/record/duty/review-queue');
  assert.ok(queue.body.items.some((i: Record<string, any>) => i.id === d.id));
  assert.equal((await decide(nguyen.token, d.id, 'approve')).approval_status, 'approved');
  // An activity moved to Duty brings its own words, and the same holds for them.
  const activity = await post(reyes.token, '/api/records/activities', { title: REDACTED, date: '2026-05-13', category: 'Operations', visibility: 'unit', unit_id: 'G8' });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));
  const moved = await post(reyes.token, `/api/records/activities/${activity.body.id}/move`, { to: 'duties', fields: { duty_type_id: T.dnco, start_time: '0800', end_time: '1600' } });
  assert.equal(moved.status, 400, JSON.stringify(moved.body));
  assert.equal(moved.body.fieldErrors.title, 'Say this another way.');
});

test('only a reviewer of its unit decides a duty: not a reader, not a Marine who cannot open it, not another Unit Instance, and never by a field of the request', async () => {
  const d = await recorded(reyes.token, { title: 'Guarded' });
  const body = { action: 'approve', version: d.version };
  // Reads it (Counsel, View shared records) but does not review.
  const reader = await review(diaz.token, d.id, body);
  assert.equal(reader.status, 403);
  assert.equal(reader.body.code, 'duty_review_forbidden');
  for (const action of ['return', 'reject', 'reopen']) assert.equal((await review(diaz.token, d.id, { action, reason: 'Because.', version: d.version })).body.code, 'duty_review_forbidden', action);
  assert.equal((await review(diaz.token, d.id, { action: 'change_points', points: 9, reason: 'Because.', version: d.version })).body.code, 'duty_override_forbidden');
  // Cannot open it: refused as any read is, with nothing about its review.
  for (const [who, token] of [['a Marine of the unit', okafor.token], ['another Unit Instance’s lead', g1lead.token]] as const) {
    const res = await review(token, d.id, body);
    assert.equal(res.status, 403, who);
    assert.equal(res.body.code, 'forbidden', who);
    assert.equal((await get(token, `/api/records/duties/${d.id}/reviews`)).status, 403, who);
  }
  assert.equal((await review(nguyen.token, 'no-such-duty', body)).status, 404);
  assert.equal((await app.call('POST', `/api/records/duties/${d.id}/review`, { body })).status, 401);
  // The ordinary save never takes a decision, whoever sends it.
  for (const token of [reyes.token, nguyen.token, op.token]) {
    const sneaky = await put(token, `/api/records/duties/${d.id}`, { approval_status: 'approved', approved_points: 50, reviewed_by: nguyen.id, points_override_reason: 'x', points_overridden_by: op.id, points_overridden_at: new Date().toISOString() });
    assert.ok([200, 400].includes(sneaky.status), JSON.stringify(sneaky.body));
  }
  const untouched = rowOf('duties', d.id)!;
  assert.deepEqual([untouched.approval_status, untouched.approved_points, untouched.reviewed_by, untouched.points_overridden_at], ['pending', null, null, null]);
  assert.deepEqual(historyOf(d.id), []);

  // A role that names Review duty without View shared records reviews nothing: nobody decides what they cannot open.
  const blind = await role('Duty reviewer, no records', PERMISSIONS.VIEW_UNIT | PERMISSIONS.REVIEW_DUTY | PERMISSIONS.OVERRIDE_DUTY_POINTS);
  assert.equal((await post(op.token, `/api/org/team/${okafor.id}/roles`, { role_id: blind.id, unit_id: 'G8' })).status, 200);
  okafor.token = await login('rvokafor');
  assert.equal((await review(okafor.token, d.id, { action: 'approve', version: rowOf('duties', d.id)!.version })).status, 403);
  assert.deepEqual((await get(okafor.token, '/api/record/duty/review-queue')).body, { items: [], total: 0, units: [], reviewer: false });
  assert.equal((await del(op.token, `/api/org/team/${okafor.id}/roles/${encodeURIComponent(blind.id)}`)).status, 200);
  okafor.token = await login('rvokafor');
  assert.equal(rowOf('duties', d.id)!.approval_status, 'pending');
});

test('nobody decides their own duty by reviewing: not its Marine, not an SNCO, not the SNCOIC, not the Unit Leader', async () => {
  for (const [who, person] of [['its Marine', reyes], ['an SNCO who reviews', nguyen], ['the SNCOIC who overrides', top], ['the Unit Leader', op]] as const) {
    const d = await recorded(person.token, { title: `Own duty of ${who}` });
    assert.deepEqual(d.review, NO_REVIEW_OPTIONS, who);
    const own = await review(person.token, d.id, { action: 'approve', version: d.version });
    assert.equal(own.status, 403, who);
    assert.equal(own.body.code, 'duty_own_review', who);
    assert.match(own.body.error, /role that names Approve own duty, which someone else grants/, who);
    for (const action of ['return', 'reject', 'reopen']) assert.equal((await review(person.token, d.id, { action, reason: 'Mine.', version: d.version })).body.code, 'duty_own_review', `${who}: ${action}`);
    assert.equal((await review(person.token, d.id, { action: 'change_points', points: 99, reason: 'Mine.', version: d.version })).body.code, 'duty_own_review', who);
    assert.equal((await review(person.token, d.id, { action: 'approve', points: 99, reason: 'Mine.', version: d.version })).body.code, 'duty_own_review', who);
    assert.equal(rowOf('duties', d.id)!.approval_status, 'pending', who);
    assert.deepEqual(historyOf(d.id), [], who);
    // Their own duty is not in their own queue either.
    const queue = await get(person.token, '/api/record/duty/review-queue');
    assert.ok(!queue.body.items.some((i: { id: string }) => i.id === d.id), who);
    // Someone else decides it. Once approved, its own Marine still changes nothing about it.
    const other = person.id === top.id ? op : top;
    const approved = await decide(other.token, d.id, 'approve');
    assert.equal((await review(person.token, d.id, { action: 'change_points', points: 99, reason: 'Mine.', version: approved.version })).body.code, 'duty_own_review', who);
    assert.equal((await review(person.token, d.id, { action: 'reopen', reason: 'Mine.', version: approved.version })).body.code, 'duty_own_review', who);
    assert.equal(rowOf('duties', d.id)!.approved_points, 3, who);
  }
  // A leader who records duty for a Marine is not that duty's Marine: it is reviewed like any other.
  const forReyes = await post(diaz.token, '/api/records/duties', duty({ user_id: reyes.id, title: 'Recorded by the fire team leader' }));
  assert.equal(forReyes.status, 201, JSON.stringify(forReyes.body));
  assert.equal((await review(diaz.token, forReyes.body.id, { action: 'approve', version: forReyes.body.version })).body.code, 'duty_review_forbidden', 'recording it is not reviewing it');
  assert.equal((await review(reyes.token, forReyes.body.id, { action: 'approve', version: forReyes.body.version })).body.code, 'duty_own_review');
  const done = await decide(nguyen.token, forReyes.body.id, 'approve');
  assert.equal(done.approval_status, 'approved');
  assert.equal(notesFor(diaz.id, forReyes.body.id).at(-1)!.title, 'Duty you recorded was approved');
  assert.equal(notesFor(reyes.id, forReyes.body.id).at(-1)!.title, 'Duty approved');
});

test('approving your own duty takes a role that names it, which someone else grants: nobody gives it to themselves, the Unit Leader included', async () => {
  const selfApprover = await role('Duty self-approval', PERMISSIONS.VIEW_UNIT | PERMISSIONS.APPROVE_OWN_DUTY, 0);
  const holders = () => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM member_roles WHERE role_id = ?').get(selfApprover.id) as { n: number }).n;

  // The Unit Leader defines the role, and cannot take it: by a grant to themselves,
  const self = await post(op.token, `/api/org/team/${op.id}/roles`, { role_id: selfApprover.id, unit_id: 'G8' });
  assert.equal(self.status, 403, JSON.stringify(self.body));
  assert.equal(self.body.code, 'self_grant');
  assert.match(self.body.error, /would let you approve your own duty\. Someone else/);
  assert.equal(holders(), 0);
  // by widening a role they hold,
  const held = app.ctx.db.prepare('SELECT r.id, r.name, r.permissions, r.position FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id = ? AND r.unit_id = ? AND r.key IS NOT ?').all(op.id, 'G8', 'unit-leader') as Array<{ id: string; name: string; permissions: number; position: number }>;
  assert.ok(held.length >= 1, 'the Unit Leader holds the unit’s default role');
  for (const r of held) {
    const widen = await put(op.token, `/api/org/roles/${encodeURIComponent(r.id)}`, { permissions: r.permissions | PERMISSIONS.APPROVE_OWN_DUTY });
    assert.equal(widen.status, 403, JSON.stringify(widen.body));
    assert.equal(widen.body.code, 'self_grant');
    assert.equal(rowOf('roles', r.id)!.permissions, r.permissions);
  }
  // or through the guard every join code and invitation of one's own passes (auth.ts, invites.ts).
  const leader = { id: op.id } as SessionUser;
  assert.throws(() => guardSelfReach(app.ctx, leader, scopeFor(app.ctx, leader), 'G8', selfApprover.permissions, op.id, 'Joining with your own code for Duty self-approval'), (e: any) => e.status === 403 && e.code === 'self_grant');
  assert.throws(() => guardSelfNamed(leader, NAMED_ONLY_BITS, op.id, 'x'), (e: any) => e.code === 'self_grant');
  guardSelfNamed(leader, NAMED_ONLY_BITS, reyes.id, 'x');
  guardSelfNamed(leader, FULL_UNIT_AUTHORITY, op.id, 'x');
  // Someone who does not hold it cannot hand it out or put it in a role either, short of full authority over the unit.
  const delegated = await post(top.token, '/api/org/roles', { unit_id: 'G8', name: 'The SNCOIC’s own approver', position: 5, permissions: PERMISSIONS.VIEW_UNIT | PERMISSIONS.APPROVE_OWN_DUTY });
  assert.equal(delegated.status, 403, JSON.stringify(delegated.body));
  assert.equal(delegated.body.code, 'delegation');
  const handed = await post(top.token, `/api/org/team/${okafor.id}/roles`, { role_id: selfApprover.id, unit_id: 'G8' });
  assert.equal(handed.status, 403, JSON.stringify(handed.body));
  assert.equal(handed.body.code, 'delegation');

  // Without it: refused. Granted by the Unit Leader to another Marine: theirs.
  const before_ = await recorded(okafor.token, { title: 'Before the grant' });
  assert.equal((await review(okafor.token, before_.id, { action: 'approve', version: before_.version })).body.code, 'duty_own_review');
  const grant = await post(op.token, `/api/org/team/${okafor.id}/roles`, { role_id: selfApprover.id, unit_id: 'G8' });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  const granted = app.ctx.db.prepare("SELECT actor_id, subject_id FROM audit_log WHERE action = 'grant_role' AND entity_id = ? ORDER BY seq DESC LIMIT 1").get(selfApprover.id) as { actor_id: string; subject_id: string };
  assert.deepEqual([granted.actor_id, granted.subject_id], [op.id, okafor.id], 'the trail names who gave it');
  okafor.token = await login('rvokafor');
  const mine = await get(okafor.token, `/api/records/duties/${before_.id}`);
  assert.deepEqual(mine.body.review, { ...NO_REVIEW_OPTIONS, approve: true });
  // At its calculated points only, and nothing else about it.
  assert.equal((await review(okafor.token, before_.id, { action: 'approve', points: 50, reason: 'More.', version: before_.version })).body.code, 'duty_own_review');
  assert.equal((await review(okafor.token, before_.id, { action: 'reject', reason: 'x', version: before_.version })).body.code, 'duty_own_review');
  const approved = await decide(okafor.token, before_.id, 'approve');
  assert.deepEqual([approved.approval_status, approved.approved_points, approved.reviewed_by], ['approved', 3, okafor.id]);
  const line = historyOf(before_.id);
  assert.deepEqual([line[0].event, line[0].actor_id, line[0].by_owner, line[0].override], ['approved', okafor.id, 1, 0]);
  const entry = auditOf('duty_approved', before_.id)[0];
  assert.match(entry.detail, /own duty, by self-approval authority/);
  assert.equal(entry.subject_id, null);
  assert.equal((await review(okafor.token, before_.id, { action: 'reopen', reason: 'x', version: approved.version })).body.code, 'duty_own_review');
  // It is authority over their own duty and nobody else's.
  const others = await recorded(reyes.token, { title: 'Not theirs to approve' });
  assert.equal((await review(okafor.token, others.id, { action: 'approve', version: others.version })).status, 403);

  // A Unit Leader may hold it too, when someone else gave it: here as another Unit Manager would have. Raising such a
  // role off position 0, so that it reaches the units beneath, is again giving it to oneself.
  const mineToo = await recorded(op.token, { title: 'The Unit Leader’s own duty' });
  assert.equal((await review(op.token, mineToo.id, { action: 'approve', version: mineToo.version })).body.code, 'duty_own_review');
  app.ctx.db.prepare('INSERT INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(op.id, selfApprover.id, 'G8', top.id, new Date().toISOString());
  const raise = await put(op.token, `/api/org/roles/${encodeURIComponent(selfApprover.id)}`, { position: 10 });
  assert.equal(raise.status, 403, JSON.stringify(raise.body));
  assert.equal(raise.body.code, 'self_grant');
  assert.equal(rowOf('roles', selfApprover.id)!.position, 0);
  assert.equal((await put(op.token, `/api/org/roles/${encodeURIComponent(selfApprover.id)}`, { description: 'For standing duty officers.' })).status, 200, 'a change that widens nothing is theirs to make');
  assert.equal((await decide(op.token, mineToo.id, 'approve')).approval_status, 'approved');
  app.ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?').run(op.id, selfApprover.id);

  // Taken away, it is gone.
  assert.equal((await del(op.token, `/api/org/team/${okafor.id}/roles/${encodeURIComponent(selfApprover.id)}`)).status, 200);
  okafor.token = await login('rvokafor');
  const after_ = await recorded(okafor.token, { title: 'After the role was removed' });
  assert.equal((await review(okafor.token, after_.id, { action: 'approve', version: after_.version })).body.code, 'duty_own_review');
});

test('a role names approving your own duty when it is made, never afterwards, and it counts only from a role someone else granted', async () => {
  const BIT = PERMISSIONS.APPROVE_OWN_DUTY;
  const permissionsOf = (id: string) => (rowOf('roles', id)!.permissions as number);
  const mayApproveOwn = async (token: string, id: string) => (await get(token, `/api/records/duties/${id}`)).body.review.approve as boolean;

  // Found in review (2026-11-10): a leader above a unit, who is not in it and so holds none of its roles, put the
  // permission in its default role and then joined with a join code of their own, which hands out that role.
  // The SNCOIC makes the cell and leads it; G-8's leader has full authority over it from above.
  const cell = await post(top.token, '/api/org/units', { name: 'Self-approval Cell', code: 'G8SA', parent_id: 'G8' });
  assert.equal(cell.status, 201, JSON.stringify(cell.body));
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = 'G8SA'").get(op.id), undefined, 'the leader above is not a member of the cell');
  const marine = rowOf('roles', 'G8SA:marine')!;
  assert.equal(marine.is_default, 1);
  const widened = await put(op.token, '/api/org/roles/G8SA:marine', { permissions: marine.permissions | BIT });
  assert.equal(widened.status, 403, JSON.stringify(widened.body));
  assert.equal(widened.body.code, 'named_when_made');
  assert.match(widened.body.error, /named when a role is made/);
  assert.equal(permissionsOf('G8SA:marine'), marine.permissions);

  // No role that exists gains it, whoever asks and whether or not they hold it: not a standard role, not one a unit made.
  for (const id of ['G8SA:snco', 'G8SA:sncoic', 'G8:snco']) {
    const was = permissionsOf(id);
    const res = await put(op.token, `/api/org/roles/${encodeURIComponent(id)}`, { permissions: was | BIT });
    assert.equal(res.status, 403, `${id}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'named_when_made', id);
    assert.equal(permissionsOf(id), was, id);
  }
  // The Unit Leader role is not edited at all.
  const leaders = permissionsOf('G8SA:unit-leader');
  assert.notEqual((await put(op.token, '/api/org/roles/G8SA:unit-leader', { permissions: leaders | BIT })).status, 200);
  assert.equal(permissionsOf('G8SA:unit-leader'), leaders);
  const plain = await role('Duty clerk', PERMISSIONS.VIEW_UNIT, 0);
  const later = await put(op.token, `/api/org/roles/${encodeURIComponent(plain.id)}`, { permissions: plain.permissions | BIT });
  assert.equal(later.status, 403, JSON.stringify(later.body));
  assert.equal(later.body.code, 'named_when_made');
  // Made with it, a role keeps it through other edits, can lose it, and does not get it back.
  const made = await role('Standing duty officer', PERMISSIONS.VIEW_UNIT | BIT, 0);
  assert.equal((await put(op.token, `/api/org/roles/${encodeURIComponent(made.id)}`, { name: 'Standing duty officer (S-3)' })).status, 200);
  assert.equal(permissionsOf(made.id) & BIT, BIT);
  assert.equal((await put(op.token, `/api/org/roles/${encodeURIComponent(made.id)}`, { permissions: PERMISSIONS.VIEW_UNIT })).status, 200);
  assert.equal((await put(op.token, `/api/org/roles/${encodeURIComponent(made.id)}`, { permissions: PERMISSIONS.VIEW_UNIT | BIT })).body.code, 'named_when_made');
  assert.equal(permissionsOf(made.id) & BIT, 0);

  // Were the permission in a default role all the same (a database from elsewhere, a hand edit), it would count for
  // nobody: the default role comes with membership, not from a grant. The leader joins with their own code and stands duty.
  const force = (id: string, on: boolean) => app.ctx.db.prepare(`UPDATE roles SET permissions = permissions ${on ? '|' : '& ~'} ? WHERE id = ?`).run(BIT, id);
  force('G8SA:marine', true);
  const code = await post(op.token, '/api/org/units/G8SA/join-codes', {});
  assert.equal(code.status, 201, JSON.stringify(code.body));
  assert.equal((await post(op.token, `/api/org/join-codes/${encodeURIComponent(code.body.code)}/join`)).status, 200);
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'G8SA:marine'").get(op.id), 'the leader now holds the cell’s default role');
  const own = await recorded(op.token, { unit_id: 'G8SA', title: 'Stood in the cell' });
  assert.equal(await mayApproveOwn(op.token, own.id), false);
  const tried = await review(op.token, own.id, { action: 'approve', version: own.version });
  assert.equal(tried.status, 403, JSON.stringify(tried.body));
  assert.equal(tried.body.code, 'duty_own_review');
  assert.equal(rowOf('duties', own.id)!.approval_status, 'pending');
  // Not when someone else is named as having seated them either: a default role is nobody's decision about one person.
  app.ctx.db.prepare("UPDATE member_roles SET granted_by = ? WHERE user_id = ? AND role_id = 'G8SA:marine'").run(top.id, op.id);
  assert.equal(await mayApproveOwn(op.token, own.id), false);
  force('G8SA:marine', false);
  // Nor in the Unit Leader role, which comes with leading the unit.
  const leaderRole = app.ctx.db.prepare("SELECT granted_by FROM member_roles WHERE user_id = ? AND role_id = 'G8:unit-leader'").get(op.id) as { granted_by: string | null } | undefined;
  assert.ok(leaderRole, 'the Unit Leader holds the Unit Leader role');
  force('G8:unit-leader', true);
  app.ctx.db.prepare("UPDATE member_roles SET granted_by = ? WHERE user_id = ? AND role_id = 'G8:unit-leader'").run(top.id, op.id);
  const inG8 = await recorded(op.token, { title: 'The Unit Leader’s, with the Unit Leader role forced' });
  assert.equal(await mayApproveOwn(op.token, inG8.id), false);
  assert.equal((await review(op.token, inG8.id, { action: 'approve', version: inG8.version })).body.code, 'duty_own_review');
  force('G8:unit-leader', false);
  app.ctx.db.prepare("UPDATE member_roles SET granted_by = ? WHERE user_id = ? AND role_id = 'G8:unit-leader'").run(leaderRole!.granted_by, op.id);

  // A role that names it counts for its holder only when someone else granted it: a row that names nobody, or its own
  // holder, confers nothing, whatever wrote it.
  const named = await role('Duty officer of the day', PERMISSIONS.VIEW_UNIT | BIT, 0);
  const mine = await recorded(reyes.token, { title: 'Stood by a Marine with a role nobody granted' });
  const seat = app.ctx.db.prepare('INSERT INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)');
  const regrant = app.ctx.db.prepare('UPDATE member_roles SET granted_by = ? WHERE user_id = ? AND role_id = ?');
  seat.run(reyes.id, named.id, 'G8', null, new Date().toISOString());
  assert.equal(await mayApproveOwn(reyes.token, mine.id), false, 'granted by nobody');
  assert.equal((await review(reyes.token, mine.id, { action: 'approve', version: mine.version })).body.code, 'duty_own_review');
  regrant.run(reyes.id, reyes.id, named.id);
  assert.equal(await mayApproveOwn(reyes.token, mine.id), false, 'granted by themselves');
  assert.equal((await review(reyes.token, mine.id, { action: 'approve', version: mine.version })).body.code, 'duty_own_review');
  regrant.run(op.id, reyes.id, named.id);
  assert.equal(await mayApproveOwn(reyes.token, mine.id), true, 'granted by someone else');
  // What the role names besides is theirs however they came by it: only the named permission waits on the grant.
  regrant.run(null, reyes.id, named.id);
  assert.ok(has(scopeFor(app.ctx, { id: reyes.id }).permissions.G8, PERMISSIONS.VIEW_UNIT));
  assert.equal(scopeFor(app.ctx, { id: reyes.id }).permissions.G8 & BIT, 0);
  app.ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?').run(reyes.id, named.id);
  assert.equal(rowOf('duties', mine.id)!.approval_status, 'pending');
});

// ---------------------------------------------------------------------------------------------------------------------
// Calculated points and approved points

test('approved points apart from the calculated ones take the override permission and a reason, are kept with who and why, and never rescore the duty', async () => {
  const d = await recorded(reyes.token, { title: 'Short-notice DNCO' });
  // A reviewer without the permission approves at the calculated points or not at all.
  const denied = await review(nguyen.token, d.id, { action: 'approve', points: 5, reason: 'Short notice.', version: d.version });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'duty_override_forbidden');
  // With it: a reason, and points that are points.
  const bare = await review(top.token, d.id, { action: 'approve', points: 5, version: d.version });
  assert.equal(bare.status, 400);
  assert.equal(bare.body.fieldErrors.reason, 'Required.');
  for (const points of [-1, 100_001, 'lots', '1e9']) {
    const bad = await review(top.token, d.id, { action: 'approve', points, reason: 'Short notice.', version: d.version });
    assert.equal(bad.status, 400, String(points));
    assert.ok(bad.body.fieldErrors.points, String(points));
  }
  assert.equal(rowOf('duties', d.id)!.approval_status, 'pending');
  const approved = await decide(top.token, d.id, 'approve', { points: '5', reason: 'Stood on two hours’ notice.' });
  assert.deepEqual([approved.approval_status, approved.calculated_points, approved.approved_points, approved.points_override_reason, approved.scoring_version], ['approved', 3, 5, 'Stood on two hours’ notice.', 1]);
  const row = rowOf('duties', d.id)!;
  assert.deepEqual([row.points_overridden_by, row.reviewed_by, row.review_reason], [top.id, top.id, null]);
  assert.ok(row.points_overridden_at);
  assert.equal(countedPoints(row as never), 5);
  assert.equal(isOverridden(row as never), true);
  let history = historyOf(d.id);
  assert.deepEqual([history[0].event, history[0].calculated_points, history[0].approved_points, history[0].override, history[0].reason], ['approved', 3, 5, 1, 'Stood on two hours’ notice.']);
  assert.match(auditOf('duty_approved', d.id)[0].detail, /calculated 3; approved 5 \(override, reason given\); scoring version 1/);
  assert.ok(!auditOf('duty_approved', d.id)[0].detail.includes('notice'), 'the reason is on the duty, not in the trail');
  // Its Marine reads who set them apart and why.
  const mine = await get(reyes.token, `/api/records/duties/${d.id}`);
  assert.match(String(mine.body.overrider_name), /GySgt Alvarez/);
  assert.equal(mine.body.points_override_reason, 'Stood on two hours’ notice.');
  // Asking for the calculated points is no override, and needs no reason.
  const plain = await recorded(reyes.token, { title: 'Plain DNCO' });
  const same = await decide(top.token, plain.id, 'approve', { points: 3 });
  assert.deepEqual([same.approved_points, same.points_override_reason, rowOf('duties', plain.id)!.points_overridden_at], [3, null, null]);
  assert.equal(historyOf(plain.id)[0].override, 0);

  // After approval: changing the points is the same authority, the same reason, and never a reviewer's without it.
  assert.equal((await review(nguyen.token, d.id, { action: 'change_points', points: 4, reason: 'x', version: row.version })).body.code, 'duty_override_forbidden');
  assert.equal((await review(top.token, d.id, { action: 'change_points', points: 4, version: row.version })).body.fieldErrors.reason, 'Required.');
  assert.equal((await review(top.token, d.id, { action: 'change_points', reason: 'x', version: row.version })).body.fieldErrors.points, 'Required.');
  assert.match((await review(top.token, d.id, { action: 'change_points', points: 5, reason: 'x', version: row.version })).body.fieldErrors.points, /Already/);
  const changed = await decide(top.token, d.id, 'change_points', { points: 4, reason: 'One hour of it was on the roster.' });
  assert.deepEqual([changed.approval_status, changed.approved_points, changed.points_override_reason, changed.calculated_points], ['approved', 4, 'One hour of it was on the roster.', 3]);
  assert.equal(rowOf('duties', d.id)!.reviewed_by, top.id, 'who approved it stays who approved it');
  assert.equal(notesFor(reyes.id, d.id).at(-1)!.title, 'Approved duty points changed');
  // Back to the calculated points: the override is withdrawn, with its reason in the history.
  const withdrawn = await decide(op.token, d.id, 'change_points', { points: 3, reason: 'The roster had it after all.' });
  const end = rowOf('duties', d.id)!;
  assert.deepEqual([withdrawn.approved_points, end.points_overridden_at, end.points_overridden_by, end.points_override_reason], [3, null, null, null]);
  history = historyOf(d.id);
  assert.deepEqual(history.map((h) => [h.event, h.approved_points, h.override, h.actor_id]), [['approved', 5, 1, top.id], ['points_changed', 4, 1, top.id], ['points_changed', 3, 0, op.id]]);
  assert.equal(history[2].reason, 'The roster had it after all.');
  assert.equal(auditOf('duty_points_changed', d.id).length, 2);
  assert.match(auditOf('duty_points_changed', d.id)[1].detail, /override withdrawn/);
  // Through all of it the duty kept the points and the version it was scored under.
  assert.deepEqual([end.calculated_points, end.scoring_version, end.scoring_policy_id], [3, 1, V.v1]);
  assert.ok(history.every((h) => h.calculated_points === 3 && h.scoring_version === 1));

  // Points belong to an approved duty only, in the review and in the table.
  const waiting = await recorded(reyes.token, { title: 'Waiting' });
  assert.equal((await review(top.token, waiting.id, { action: 'change_points', points: 4, reason: 'x', version: waiting.version })).body.code, 'duty_not_approved');
  const at = new Date().toISOString();
  assert.throws(() => app.ctx.db.prepare('UPDATE duties SET points_overridden_at = ?, points_overridden_by = ?, points_override_reason = ? WHERE id = ?').run(at, top.id, 'x', waiting.id), /CHECK constraint/, 'no override on duty not approved');
  assert.throws(() => app.ctx.db.prepare('UPDATE duties SET points_overridden_at = ? WHERE id = ?').run(at, plain.id), /CHECK constraint/, 'an override names who and why');
  assert.throws(() => app.ctx.db.prepare('UPDATE duties SET points_override_reason = ? WHERE id = ?').run('x', plain.id), /CHECK constraint/);
});

test('a later scoring version never changes a decided or waiting duty, and a duty with no score is approved for none', async () => {
  // Stood in July, under version 2 (a quarter point an hour): 8 hours, 2 points.
  const july = await recorded(reyes.token, { date: '2026-07-14', title: 'July DNCO' });
  assert.deepEqual([july.calculated_points, july.scoring_version], [2, 2]);
  const march = await recorded(reyes.token, { title: 'March DNCO' });
  await decide(nguyen.token, july.id, 'approve');
  // A third version takes effect and scores the same duty type far higher.
  app.ctx.db.prepare('INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('rv-v3', 'G8', 3, '2026-08-01', JSON.stringify({ rules: [{ duty_type_id: T.dnco, method: 'fixed', points: 40, bands: null }], multipliers: [], combine: 'highest' }), 'Much more', op.id, new Date().toISOString());
  const approved = await decide(nguyen.token, march.id, 'approve');
  assert.deepEqual([approved.calculated_points, approved.approved_points, approved.scoring_version], [3, 3, 1], 'approved now, at what version 1 gave it then');
  assert.deepEqual([rowOf('duties', july.id)!.approved_points, rowOf('duties', july.id)!.scoring_version], [2, 2]);
  // Reopened and approved again: still its own version's points.
  await decide(top.token, july.id, 'reopen', { reason: 'Checking.' });
  assert.deepEqual([(await decide(top.token, july.id, 'approve')).approved_points, rowOf('duties', july.id)!.scoring_version], [2, 2]);

  // Stood before any version took effect: it has no score, and approval gives it none.
  const early = await recorded(reyes.token, { date: '2025-12-15', title: 'Before scoring' });
  assert.deepEqual([early.calculated_points, early.scoring_version], [null, null]);
  const ok = await decide(nguyen.token, early.id, 'approve');
  assert.deepEqual([ok.approval_status, ok.approved_points], ['approved', null]);
  assert.equal(countedPoints(ok as never), 0);
  assert.match(auditOf('duty_approved', early.id)[0].detail, /calculated none; approved none; scoring version none/);
  // Someone with the authority may give it points, and says why.
  const given = await decide(top.token, early.id, 'change_points', { points: 2, reason: 'Stood before the policy; the commander’s standing figure.' });
  assert.deepEqual([given.approved_points, given.calculated_points], [2, null]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The queue and the history

test('the review queue is duty waiting for the caller’s decision: their units, longest-waiting first, never their own, and read on the record', async () => {
  app.ctx.db.prepare("UPDATE duties SET approval_status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_reason = 'Cleared for the queue test.' WHERE approval_status = 'pending'").run(op.id, new Date().toISOString());
  const first = await recorded(reyes.token, { title: 'First in' });
  const second = await recorded(okafor.token, { title: 'Second in' });
  const own = await recorded(nguyen.token, { title: 'The reviewer’s own' });
  app.ctx.db.prepare('UPDATE duties SET submitted_at = ? WHERE id = ?').run('2026-11-01T08:00:00.000Z', first.id);
  app.ctx.db.prepare('UPDATE duties SET submitted_at = ? WHERE id = ?').run('2026-11-02T08:00:00.000Z', second.id);

  const queue = await get(nguyen.token, '/api/record/duty/review-queue');
  assert.equal(queue.status, 200, JSON.stringify(queue.body));
  assert.deepEqual(queue.body.items.map((i: { id: string }) => i.id), [first.id, second.id]);
  assert.equal(queue.body.total, 2);
  assert.deepEqual(queue.body.units, [{ id: 'G8', name: 'G8', count: 2 }]);
  assert.ok(!queue.body.items.some((i: { id: string }) => i.id === own.id));
  assert.match(String(queue.body.items[0].subject_name), /Cpl Reyes/);
  assert.deepEqual(queue.body.items[0].review, { ...NO_REVIEW_OPTIONS, approve: true, return: true, reject: true });
  // One entry for each Marine on it (and no more than one every five minutes for the same reader, Marine and unit).
  const listed = new Set((app.ctx.db.prepare("SELECT subject_id FROM audit_log WHERE action = 'list_records' AND actor_id = ? AND entity = 'duties' AND unit_id = 'G8'").all(nguyen.id) as Array<{ subject_id: string }>).map((l) => l.subject_id));
  assert.ok(listed.has(okafor.id) && listed.has(reyes.id), 'reading the queue is reading those Marines’ records');
  assert.ok(!listed.has(nguyen.id), 'never the reader’s own');
  // The SNCOIC's holds the reviewer's own duty too; narrowed to a unit they do not review in, nothing.
  const tops = await get(top.token, '/api/record/duty/review-queue');
  assert.deepEqual(tops.body.items.map((i: { id: string }) => i.id), [first.id, second.id, own.id]);
  assert.deepEqual((await get(top.token, '/api/record/duty/review-queue?unit_id=G1')).body.items, []);
  assert.equal(queue.body.reviewer, true);
  assert.equal((await get(top.token, '/api/record/duty/review-queue?unit_id=G8')).body.total, 3);
  // Nobody who does not review has one: a reader, the duty's Marine, another Unit Instance's lead (who leads only G-1).
  for (const token of [diaz.token, reyes.token]) assert.deepEqual((await get(token, '/api/record/duty/review-queue')).body, { items: [], total: 0, units: [], reviewer: false });
  assert.ok(!(await get(g1lead.token, '/api/record/duty/review-queue')).body.items.some((i: { unit_id: string }) => i.unit_id === 'G8'));
  assert.equal((await app.call('GET', '/api/record/duty/review-queue')).status, 401);
  // Decided, or in the recycle bin, it leaves the queue.
  await decide(nguyen.token, first.id, 'approve');
  assert.equal((await del(okafor.token, `/api/records/duties/${second.id}`)).status, 200);
  assert.deepEqual((await get(nguyen.token, '/api/record/duty/review-queue')).body, { items: [], total: 0, units: [], reviewer: true }, 'a reviewer with nothing waiting is still a reviewer');
  // A duty in the recycle bin is not decided there.
  assert.equal((await review(nguyen.token, second.id, { action: 'approve', version: rowOf('duties', second.id)!.version })).status, 404);

  // Authority in a unit reaches the units beneath it: an SNCO of G-8 reviews duty stood in its section.
  const section = await post(op.token, '/api/org/units', { name: 'Accounting Section', short_name: 'ACCT', parent_id: 'G8' });
  assert.equal(section.status, 201, JSON.stringify(section.body));
  await enroll(app, op.token, section.body.id, okafor.id);
  okafor.token = await login('rvokafor');
  const below = await recorded(okafor.token, { unit_id: section.body.id, title: 'Section duty' });
  const reaching = await get(nguyen.token, '/api/record/duty/review-queue');
  assert.deepEqual(reaching.body.items.map((i: { id: string }) => i.id), [below.id]);
  assert.equal(reaching.body.units[0].id, section.body.id);
  assert.equal((await decide(nguyen.token, below.id, 'approve')).approval_status, 'approved');
  assert.equal(historyOf(below.id)[0].unit_id, section.body.id);
});

test('a duty’s review history is for whoever may read the duty, names who decided, and marks what its own Marine did', async () => {
  const d = await recorded(reyes.token, { title: 'With a history' });
  await decide(nguyen.token, d.id, 'return', { reason: 'Add the location.' });
  await put(reyes.token, `/api/records/duties/${d.id}`, { location: 'Bldg 1101' });
  await decide(top.token, d.id, 'approve', { points: 4, reason: 'Covered the armory as well.' });

  const mine = await get(reyes.token, `/api/records/duties/${d.id}/reviews`);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual(mine.body.reviews.map((r: Record<string, any>) => [r.event, r.actor_name ?? null, r.by_me, r.by_owner, r.reason, r.calculated_points, r.approved_points, r.override]), [
    ['returned', 'SSgt Nguyen', false, false, 'Add the location.', 3, null, false],
    ['resubmitted', null, true, true, null, 3, null, false],
    ['approved', 'GySgt Alvarez', false, false, 'Covered the armory as well.', 3, 4, true],
  ]);
  assert.ok(mine.body.reviews.every((r: Record<string, any>) => !('actor_id' in r) && !('duty_id' in r) && r.scoring_version === 1), 'by name, never by id');
  assert.equal(auditOf('view_record', d.id).length, 0, 'reading one’s own is not audited');
  const theirs = await get(nguyen.token, `/api/records/duties/${d.id}/reviews`);
  assert.deepEqual(theirs.body.reviews.map((r: Record<string, any>) => [r.event, r.actor_name ?? null, r.by_me, r.by_owner]), [['returned', null, true, false], ['resubmitted', 'Cpl Reyes', false, true], ['approved', 'GySgt Alvarez', false, false]]);
  const viewed = auditOf('view_record', d.id);
  assert.equal(viewed.length, 1);
  assert.deepEqual([viewed[0].actor_id, viewed[0].subject_id, viewed[0].detail], [nguyen.id, reyes.id, 'review history']);
  assert.equal((await get(diaz.token, `/api/records/duties/${d.id}/reviews`)).status, 200, 'a reader of the duty reads its history');
  assert.equal((await get(okafor.token, `/api/records/duties/${d.id}/reviews`)).status, 403);
  assert.equal((await get(nguyen.token, '/api/records/duties/no-such-duty/reviews')).status, 404);

  // The history is kept as written: nothing but its reason changes, and that only to the retention notice.
  const line = historyOf(d.id)[0];
  for (const sql of ["UPDATE duty_reviews SET event = 'approved' WHERE id = ?", 'UPDATE duty_reviews SET actor_id = NULL WHERE id = ?', "UPDATE duty_reviews SET to_status = 'approved', approved_points = 9 WHERE id = ?", "UPDATE duty_reviews SET reason = 'Something else.' WHERE id = ?", 'UPDATE duty_reviews SET reason = NULL WHERE id = ?', "UPDATE duty_reviews SET created_at = '2020-01-01' WHERE id = ?"]) {
    assert.throws(() => app.ctx.db.prepare(sql).run(line.id), /kept as it was written|CHECK constraint|NOT NULL/, sql);
  }
  let n = 0;
  const insert = (over: Record<string, unknown>) => {
    const v = { id: `rv-x-${n++}`, duty_id: d.id, unit_id: 'G8', actor_id: nguyen.id, event: 'returned', from_status: 'pending', to_status: 'returned', reason: 'x', calculated_points: 3, approved_points: null, scoring_version: 1, override: 0, by_owner: 0, created_at: new Date().toISOString(), ...over };
    return app.ctx.db.prepare(`INSERT INTO duty_reviews (${Object.keys(v).join(', ')}) VALUES (${Object.keys(v).map(() => '?').join(', ')})`).run(...Object.values(v));
  };
  assert.throws(() => insert({ reason: null }), /CHECK constraint/, 'a return says why');
  assert.throws(() => insert({ event: 'approved', to_status: 'approved', approved_points: 5, override: 1, reason: null }), /CHECK constraint/, 'an override says why');
  assert.throws(() => insert({ approved_points: 5 }), /CHECK constraint/, 'points only on an approval');
  assert.throws(() => insert({ event: 'blessed' }), /CHECK constraint/);
  assert.throws(() => insert({ unit_id: 'G1' }), /cross_instance/, 'a review is in its duty’s Unit Instance');
  assert.throws(() => insert({ duty_id: 'no-such-duty' }), /FOREIGN KEY|cross_instance/);
  assert.deepEqual(instanceBoundaryViolations(app.ctx.db), {});
});

// ---------------------------------------------------------------------------------------------------------------------
// Where a reviewed duty may and may not go

test('frozen when its Marine left the unit, a duty is approved or rejected by its reviewers, never returned, and never by the Marine', async () => {
  const leaver = await app.register('rvleaver', { rank_id: 'LCpl', last_name: 'Park' });
  await enroll(app, op.token, 'G8', leaver.id);
  const selfApprover = app.ctx.db.prepare("SELECT id FROM roles WHERE unit_id = 'G8' AND name = 'Duty self-approval'").get() as { id: string };
  app.ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(leaver.id, selfApprover.id, 'G8', op.id, new Date().toISOString());
  leaver.token = await login('rvleaver');
  const a = await recorded(leaver.token, { title: 'Stood before leaving' });
  const b = await recorded(leaver.token, { title: 'Also stood before leaving' });
  assert.equal((await get(leaver.token, `/api/records/duties/${a.id}`)).body.review.approve, true, 'while a member, a role that names it lets them');
  const gone = await del(op.token, `/api/org/units/G8/members/${leaver.id}`);
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  leaver.token = await login('rvleaver');
  const frozen = rowOf('duties', a.id)!;
  assert.ok(frozen.frozen_at, 'shared duty is frozen when its Marine leaves');
  const own = await review(leaver.token, a.id, { action: 'approve', version: frozen.version });
  assert.equal(own.status, 403);
  assert.equal(own.body.code, 'duty_own_review', 'the role went with the membership');
  assert.deepEqual((await get(nguyen.token, `/api/records/duties/${a.id}`)).body.review, { ...NO_REVIEW_OPTIONS, approve: true, reject: true });
  const back = await review(nguyen.token, a.id, { action: 'return', reason: 'Fix it.', version: frozen.version });
  assert.equal(back.status, 403);
  assert.equal(back.body.code, 'duty_frozen');
  assert.equal((await decide(nguyen.token, a.id, 'approve')).approval_status, 'approved');
  assert.equal((await decide(nguyen.token, b.id, 'reject', { reason: 'Not on the roster.' })).approval_status, 'rejected');
  // Reopened, it is still not one to return: its reviewers decide it.
  const reopened = await decide(top.token, b.id, 'reopen', { reason: 'Decide it again.' });
  assert.deepEqual([reopened.review.return, reopened.review.approve, reopened.review.reject], [false, true, true]);

  // A Marine who keeps the authority above the unit they left still does not approve the duty frozen there. The role is
  // made to reach the units beneath G-8, someone else grants it, and the Marine stands duty in a cell and then leaves it.
  const reaching = await role('Duty officer, every section', PERMISSIONS.VIEW_UNIT | PERMISSIONS.APPROVE_OWN_DUTY, 5);
  const mover = await app.register('rvmover', { rank_id: 'Cpl', last_name: 'Ito' });
  await enroll(app, op.token, 'G8', mover.id);
  assert.equal((await post(op.token, `/api/org/team/${mover.id}/roles`, { role_id: reaching.id, unit_id: 'G8' })).status, 200);
  assert.equal((await post(op.token, '/api/org/units', { name: 'Frozen Duty Cell', code: 'G8FZ', parent_id: 'G8' })).status, 201);
  await enroll(app, op.token, 'G8FZ', mover.id);
  mover.token = await login('rvmover');
  const inCell = await recorded(mover.token, { unit_id: 'G8FZ', title: 'Stood in a cell since left' });
  assert.equal((await get(mover.token, `/api/records/duties/${inCell.id}`)).body.review.approve, true, 'theirs to approve while they serve there');
  assert.equal((await del(op.token, `/api/org/units/G8FZ/members/${mover.id}`)).status, 200);
  mover.token = await login('rvmover');
  const left = rowOf('duties', inCell.id)!;
  assert.ok(left.frozen_at, 'frozen when they left the cell');
  assert.ok(scopeFor(app.ctx, { id: mover.id }).sources.G8FZ?.some((x) => x.bits & PERMISSIONS.APPROVE_OWN_DUTY), 'the role still reaches the cell from G-8');
  assert.equal((await get(mover.token, `/api/records/duties/${inCell.id}`)).body.review.approve, false);
  const stillTheirs = await review(mover.token, inCell.id, { action: 'approve', version: left.version });
  assert.equal(stillTheirs.status, 403, JSON.stringify(stillTheirs.body));
  assert.equal(stillTheirs.body.code, 'duty_frozen');
  assert.equal(rowOf('duties', inCell.id)!.approval_status, 'pending');
  assert.equal((await decide(nguyen.token, inCell.id, 'approve')).approval_status, 'approved', 'a reviewer above the cell decides it');
});

test('a reviewed duty keeps its history where it is: no undo of the move that made it, no other Unit Instance, and an import’s undo never puts a review back', async () => {
  // An activity that was duty, moved to Duty by its owner, then returned by a reviewer.
  const activity = await post(reyes.token, '/api/records/activities', { title: 'Stood DNCO for the battalion', date: '2026-05-06', category: 'Operations', visibility: 'unit', unit_id: 'G8' });
  assert.equal(activity.status, 201, JSON.stringify(activity.body));
  const moved = await post(reyes.token, `/api/records/activities/${activity.body.id}/move`, { to: 'duties', fields: { duty_type_id: T.dnco, start_time: '0800', end_time: '1600' } });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  const id = moved.body.id as string;
  assert.equal((await get(reyes.token, `/api/records/duties/${id}/lineage`)).body.undo?.from_table, 'activities', 'before any review, the move can be undone');
  const returned = await decide(nguyen.token, id, 'return', { reason: 'Which battalion?' });
  const lineage = await get(reyes.token, `/api/records/duties/${id}/lineage`);
  assert.equal(lineage.body.undo, null, 'not offered');
  const undo = await post(reyes.token, `/api/records/duties/${id}/undo-move`);
  assert.equal(undo.status, 403, JSON.stringify(undo.body));
  assert.equal(undo.body.code, 'duty_reviewed');
  assert.ok(rowOf('duties', id) && historyOf(id).length === 1);
  // Corrected and waiting again, it still has a history, so it still stays.
  assert.equal((await put(reyes.token, `/api/records/duties/${id}`, { title: 'Stood DNCO for 4th Bn', version: returned.version })).status, 200);
  assert.equal(rowOf('duties', id)!.approval_status, 'pending');
  assert.equal((await post(reyes.token, `/api/records/duties/${id}/undo-move`)).body.code, 'duty_reviewed');

  // Its Unit Instance: the database refuses to take a reviewed duty across, whatever asks.
  assert.throws(() => app.ctx.db.prepare("UPDATE duties SET unit_id = 'G1', duty_type_id = ?, scoring_policy_id = ?, scoring_version = 1 WHERE id = ?").run(T.g1, V.g1, id), /cross_instance/);
  assert.equal(rowOf('duties', id)!.unit_id, 'G8');
  // And the save refuses first, for a Marine who serves in both: a duty nobody has reviewed may be recorded again in the
  // other instance by moving it, a reviewed one stays where its history is.
  const both = await app.register('rvboth', { rank_id: 'Cpl', last_name: 'Vance' });
  await enroll(app, op.token, 'G8', both.id);
  await enroll(app, g1lead.token, 'G1', both.id);
  both.token = await login('rvboth');
  const here = await recorded(both.token, { title: 'Stood for G-8, then asked to move' });
  const sentBack = await decide(nguyen.token, here.id, 'return', { reason: 'Which instance was this for?' });
  const across = await put(both.token, `/api/records/duties/${here.id}`, { unit_id: 'G1', duty_type_id: T.g1, version: sentBack.version });
  assert.equal(across.status, 403, JSON.stringify(across.body));
  assert.equal(across.body.code, 'cross_instance');
  assert.match(across.body.error, /has been reviewed in its Unit Instance/);
  const stays = rowOf('duties', here.id)!;
  assert.deepEqual([stays.unit_id, stays.duty_type_id, stays.approval_status, stays.version], ['G8', T.dnco, 'returned', sentBack.version]);
  assert.deepEqual(historyOf(here.id).map((h) => [h.event, h.unit_id]), [['returned', 'G8']]);

  // A file that corrects a returned duty sends it back for review; undoing the import puts back what the duty said, and
  // leaves its review where it stands.
  const d = await recorded(reyes.token, { title: 'From a sheet', notes: 'As first recorded.' });
  await decide(nguyen.token, d.id, 'return', { reason: 'Say who relieved you.' });
  const sheet = await get(reyes.token, '/api/me/export?format=csv&sections=duty');
  assert.equal(sheet.status, 200);
  const [header, ...lines] = String(sheet.text).trim().split(/\r?\n/);
  for (const h of ['Approved Points', 'Calculated Points', 'Review Status']) assert.ok(header.includes(h), `${h} in ${header}`);
  const line = lines.find((l) => l.includes('From a sheet'))!;
  assert.ok(line, 'the returned duty is in the sheet');
  // The file corrects the duty, and claims a decision. The decision is not the file's to say.
  const edited = `${header}\n${line.replace('As first recorded.', 'Relieved by Cpl Okafor.').replace(/Returned for correction|Returned/, 'Approved')}\n`;
  const staged = await upload(reyes.token, edited, 'vantage-duty.csv');
  assert.equal(staged.status, 201, JSON.stringify(staged.body).slice(0, 400));
  assert.equal(staged.body.counts.update, 1, JSON.stringify(staged.body.rows));
  const committed = await post(reyes.token, `/api/me/imports/${staged.body.id}/commit`, { expected: { new: staged.body.counts.new, update: staged.body.counts.update } });
  assert.equal(committed.status, 200, JSON.stringify(committed.body).slice(0, 400));
  let now_ = rowOf('duties', d.id)!;
  assert.deepEqual([now_.notes, now_.approval_status, now_.approved_points, now_.reviewed_by], ['Relieved by Cpl Okafor.', 'pending', null, null], 'corrected, and sent back: never approved by a file');
  assert.deepEqual(historyOf(d.id).map((h) => h.event), ['returned', 'resubmitted']);
  const held = now_;
  const undone = await post(reyes.token, `/api/me/imports/${staged.body.id}/undo`);
  assert.equal(undone.status, 200, JSON.stringify(undone.body).slice(0, 400));
  now_ = rowOf('duties', d.id)!;
  assert.equal(now_.notes, 'As first recorded.', 'what it said is put back');
  assert.deepEqual([now_.approval_status, now_.reviewed_by, now_.review_reason], ['pending', null, null], 'its review is not: it waits, as its history says');
  assert.deepEqual(historyOf(d.id).map((h) => h.event), ['returned', 'resubmitted']);
  // Every column of its review is as the undo found it, not as the file's import first saw it (returned, by its reviewer).
  for (const column of DUTY_REVIEW_COLUMNS) assert.deepEqual(now_[column], held[column], column);
});

// ---------------------------------------------------------------------------------------------------------------------
// Where it shows, and what leaves with it

test('the Duty report and every export tell approved points from calculated points, and only approved duty counts', async () => {
  const mine = app.ctx.db.prepare('SELECT * FROM duties WHERE user_id = ? AND deleted_at IS NULL').all(reyes.id) as Array<Record<string, any>>;
  const approved = mine.filter((d) => d.approval_status === 'approved');
  assert.ok(approved.length >= 3 && mine.length > approved.length, 'some approved, some not');
  const sum = (rows: Array<Record<string, any>>, key: string) => Math.round(rows.reduce((n, r) => n + (Number(r[key]) || 0), 0) * 100) / 100;
  const tablesOf = (doc: { sections: Array<{ tables: Array<Record<string, any>> }> }) => doc.sections.flatMap((s) => s.tables);
  const figure = (doc: { summary: Array<{ label: string; value: unknown }> }, label: string) => doc.summary.find((f) => f.label === label)?.value;

  const report = await get(reyes.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'self', period: 'all' })}`);
  assert.equal(report.status, 200, JSON.stringify(report.body).slice(0, 400));
  assert.equal(figure(report.body, 'Duty stood'), mine.length);
  assert.equal(figure(report.body, 'Approved'), approved.length);
  assert.equal(figure(report.body, 'Approved points'), sum(approved, 'approved_points'));
  assert.equal(figure(report.body, 'Calculated points'), sum(mine, 'calculated_points'));
  assert.equal(figure(report.body, 'Awaiting review'), mine.filter((d) => d.approval_status === 'pending').length);
  const stood = tablesOf(report.body).find((t) => t.id === 'stood')!;
  const keys = stood.columns.map((c: { key: string }) => c.key);
  assert.ok(keys.indexOf('approved') === keys.indexOf('points') + 1 && keys.includes('override'), keys.join(','));
  for (const row of stood.rows as Array<Record<string, any>>) if (row.status !== 'Approved') assert.equal(row.approved, null, 'no approved points on duty not approved');
  assert.ok(report.body.notes.some((n: string) => /Only approved duty counts, at its approved points/.test(n)));
  assert.ok(report.body.notes.some((n: string) => /later version never changes its points, calculated or approved/.test(n)));

  const unit = await get(nguyen.token, `/api/report-center/run?${new URLSearchParams({ type: 'duty', subject: 'unit', unit_id: 'G8', period: 'all' })}`);
  assert.equal(unit.status, 200, JSON.stringify(unit.body).slice(0, 400));
  const tally = tablesOf(unit.body).find((t) => t.id === 'by_marine')!;
  const reyesLine = (tally.rows as Array<Record<string, any>>).find((r) => /Reyes/.test(String(r.marine)))!;
  const inG8 = mine.filter((d) => d.unit_id === 'G8');
  assert.deepEqual([reyesLine.count, reyesLine.approved, reyesLine.counted, reyesLine.points],
    [inG8.length, inG8.filter((d) => d.approval_status === 'approved').length, sum(inG8.filter((d) => d.approval_status === 'approved'), 'approved_points'), sum(inG8, 'calculated_points')]);
  const counted = (tally.rows as Array<Record<string, any>>).map((r) => Number(r.counted));
  assert.deepEqual(counted, [...counted].sort((a, b) => b - a), 'ranked by what counts');

  // The Marine's page carries each duty's review for the reader.
  const page = await get(nguyen.token, `/api/org/team/${reyes.id}`);
  assert.equal(page.status, 200, JSON.stringify(page.body).slice(0, 300));
  const waiting = (page.body.duties as Array<Record<string, any>>).find((x) => x.approval_status === 'pending');
  assert.ok(waiting && waiting.review.approve === true && waiting.review.return === true, JSON.stringify(waiting?.review));

  // One's own copy: each duty with its approved points and who decided, and the history of every review.
  const archive = await get(reyes.token, '/api/me/export?format=json&sections=duty');
  assert.equal(archive.status, 200, String(archive.text).slice(0, 300));
  const exported = JSON.parse(archive.text);
  const overridden = mine.find((d) => d.points_overridden_at);
  assert.ok(overridden, 'a duty with an override stands');
  const copy = (exported.records.duties as Array<Record<string, any>>).find((d) => d.id === overridden!.id)!;
  assert.deepEqual([copy.approved_points, copy.points_override_reason], [overridden!.approved_points, overridden!.points_override_reason]);
  assert.match(String(copy.overrider_label), /Alvarez/);
  const reviews = exported.duty_reviews as Array<Record<string, any>>;
  assert.equal(reviews.length, (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM duty_reviews v JOIN duties d ON d.id = v.duty_id WHERE d.user_id = ?').get(reyes.id) as { n: number }).n);
  assert.ok(reviews.length >= 6 && reviews.every((r) => r.duty_id && r.event && !('actor_id' in r)), JSON.stringify(reviews[0]));
  assert.ok(reviews.some((r) => r.actor === 'me') && reviews.some((r) => /Nguyen/.test(String(r.actor))) && reviews.some((r) => /Alvarez/.test(String(r.actor))), 'who decided, by name, never by id');
  // A file never brings a review in: one's own copy imported by another Marine comes in submitted, with nothing approved.
  const csv = await get(reyes.token, '/api/me/export?format=csv&sections=duty');
  const copied = await upload(okafor.token, String(csv.text), 'vantage-reyes-duty.csv');
  assert.equal(copied.status, 201, JSON.stringify(copied.body).slice(0, 300));
  const landed = await post(okafor.token, `/api/me/imports/${copied.body.id}/commit`, { expected: { new: copied.body.counts.new, update: copied.body.counts.update } });
  assert.equal(landed.status, 200, JSON.stringify(landed.body).slice(0, 300));
  const origins = app.ctx.db.prepare("SELECT record_id FROM record_import_origins WHERE import_id = ? AND record_table = 'duties' AND action = 'created'").all(copied.body.id) as Array<{ record_id: string }>;
  assert.ok(origins.length >= 1);
  for (const o of origins) {
    const row = rowOf('duties', o.record_id)!;
    assert.deepEqual([row.approval_status, row.approved_points, row.reviewed_by, row.points_overridden_at, row.user_id], ['pending', null, null, null, okafor.id]);
    assert.deepEqual(historyOf(o.record_id), []);
  }
  assert.equal((await post(okafor.token, `/api/me/imports/${copied.body.id}/undo`)).status, 200);

  // The service archive carries the history, after the duties it hangs on.
  const instance = exportInstance(app.ctx);
  assert.equal(instance.tables.duty_reviews.length, (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM duty_reviews').get() as { n: number }).n);
  assert.ok(Object.keys(instance.tables).indexOf('duty_reviews') > Object.keys(instance.tables).indexOf('duties'));
});

test('an instance archive carries the review history whole, and one from before 032 gives its standard roles the review permissions', async () => {
  type Archive = Parameters<typeof importInstance>[1] & { tables: Record<string, Array<Record<string, any>>> };
  const archive = JSON.parse(JSON.stringify(exportInstance(app.ctx))) as Archive;
  const history = app.ctx.db.prepare('SELECT * FROM duty_reviews ORDER BY id').all() as Array<Record<string, any>>;
  assert.ok(history.length >= 10, 'earlier tests left decisions behind');
  const decided = app.ctx.db.prepare("SELECT id, approval_status, approved_points, calculated_points, reviewed_by, points_override_reason FROM duties WHERE approval_status <> 'pending' ORDER BY id").all();
  const R = PERMISSIONS.REVIEW_DUTY, O = PERMISSIONS.OVERRIDE_DUTY_POINTS;
  // A unit that took Review duty out of its SNCO role keeps it out: an archive of this build is loaded as it was kept.
  for (const r of archive.tables.roles) if (r.id === 'G8:snco') r.permissions &= ~R;
  const rolesOf = (t: TestApp) => Object.fromEntries((t.ctx.db.prepare("SELECT id, permissions FROM roles WHERE id IN ('G8:snco', 'G8:sncoic', 'G8:fire-team-leader', 'G8:marine', 'G8:unit-leader')").all() as Array<{ id: string; permissions: number }>).map((r) => [r.id, r.permissions]));

  const fresh = await startApp();
  try {
    const freshOp = await fresh.setupOperator();
    importInstance(fresh.ctx, archive, freshOp.id);
    assert.deepEqual(fresh.ctx.db.prepare('SELECT * FROM duty_reviews ORDER BY id').all(), history, 'every line, as it was');
    assert.deepEqual(fresh.ctx.db.prepare("SELECT id, approval_status, approved_points, calculated_points, reviewed_by, points_override_reason FROM duties WHERE approval_status <> 'pending' ORDER BY id").all(), decided);
    const roles = rolesOf(fresh);
    assert.equal(roles['G8:snco'] & R, 0, 'not handed back');
    assert.equal(roles['G8:sncoic'] & (R | O), R | O);
    assert.deepEqual(instanceBoundaryViolations(fresh.ctx.db), {});
    // The history is kept as written on the new host too.
    assert.throws(() => fresh.ctx.db.prepare("UPDATE duty_reviews SET to_status = 'approved' WHERE id = ?").run(history[0].id), /a duty review is kept as it was written/);
  } finally { await fresh.close(); }

  // An archive written before 032: no review history, no override columns, roles from before duty was reviewed.
  const legacy = structuredClone(archive);
  delete legacy.tables.duty_reviews;
  legacy.tables.duties = legacy.tables.duties.map(({ points_override_reason: _a, points_overridden_by: _b, points_overridden_at: _c, ...rest }) => rest);
  for (const r of legacy.tables.roles) r.permissions &= ~(R | O | PERMISSIONS.APPROVE_OWN_DUTY);
  const cutBack = legacy.tables.roles.find((r) => r.id === 'G1:snco');
  if (cutBack) cutBack.permissions = Number(cutBack.permissions) & ~PERMISSIONS.VIEW_RECORDS;
  const older = await startApp();
  try {
    const olderOp = await older.setupOperator();
    importInstance(older.ctx, legacy, olderOp.id);
    const roles = rolesOf(older);
    assert.equal(roles['G8:snco'] & (R | O), R, 'the SNCO reviews');
    assert.equal(roles['G8:sncoic'] & (R | O), R | O, 'the SNCOIC reviews and overrides');
    for (const id of ['G8:fire-team-leader', 'G8:marine', 'G8:unit-leader']) assert.equal(roles[id] & (R | O), 0, id);
    if (cutBack) assert.equal((older.ctx.db.prepare("SELECT permissions FROM roles WHERE id = 'G1:snco'").get() as { permissions: number }).permissions & R, 0, 'a role cut back from reading shared records gains nothing');
    assert.equal((older.ctx.db.prepare('SELECT COUNT(*) AS n FROM roles WHERE permissions & ?').get(PERMISSIONS.APPROVE_OWN_DUTY) as { n: number }).n, 0, 'and no role approves its own duty');
    assert.equal((older.ctx.db.prepare('SELECT COUNT(*) AS n FROM duty_reviews').get() as { n: number }).n, 0);
    assert.equal((older.ctx.db.prepare('SELECT COUNT(*) AS n FROM duties').get() as { n: number }).n, legacy.tables.duties.length);
  } finally { await older.close(); }
});

test('retention: an anonymized duty keeps its decision and its points, loses its reasons, names nobody, and is closed to review; destroyed, its history goes with it', async () => {
  const old = dayAfter(today(), -400);
  const d = await recorded(reyes.token, { date: old, title: 'Old DNCO', notes: 'Old words.' });
  await decide(nguyen.token, d.id, 'return', { reason: 'Old reason to return it.' });
  await decide(reyes.token, d.id, 'resubmit');
  const approved = await decide(top.token, d.id, 'approve', { points: 6, reason: 'Old reason for the points.' });
  const plain = await recorded(reyes.token, { date: dayAfter(today(), -401), title: 'Old plain DNCO' });
  await decide(nguyen.token, plain.id, 'approve');

  saveSchedule(app.ctx, 'G8', { record_type: 'duties', retain_days: 365, disposition: 'anonymize', enabled: true }, op.id);
  runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
  const after_ = rowOf('duties', d.id)!;
  assert.equal(after_.title, REDACTED);
  assert.deepEqual([after_.approval_status, after_.approved_points, after_.calculated_points, after_.scoring_version, after_.reviewed_by, after_.points_overridden_by], ['approved', 6, approved.calculated_points, approved.scoring_version, top.id, top.id], 'the decision and the points stay');
  assert.equal(after_.points_override_reason, REDACTED, 'the override’s reason is words about a person');
  assert.deepEqual(historyOf(d.id).map((h) => [h.event, h.reason]), [['returned', REDACTED], ['resubmitted', null], ['approved', REDACTED]]);
  // A duty never overridden has no override reason to redact, and its table rule still holds.
  const plainAfter = rowOf('duties', plain.id)!;
  assert.deepEqual([plainAfter.title, plainAfter.points_override_reason, plainAfter.points_overridden_at, plainAfter.approved_points], [REDACTED, null, null, plainAfter.calculated_points]);
  // A second run finds nothing more to do, and breaks nothing.
  runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
  assert.equal(rowOf('duties', d.id)!.points_override_reason, REDACTED);

  // Read back: nobody is named, on the duty or in its history; the reasons read as redacted.
  const read = await get(nguyen.token, `/api/records/duties/${d.id}`);
  assert.equal(read.status, 200);
  for (const key of ['subject_name', 'reviewer_name', 'overrider_name', 'recorder_name']) assert.ok(!(key in read.body), key);
  assert.deepEqual(read.body.review, NO_REVIEW_OPTIONS);
  const history = await get(op.token, `/api/records/duties/${d.id}/reviews`);
  assert.equal(history.status, 200);
  assert.ok(history.body.reviews.every((r: Record<string, any>) => !('actor_name' in r)), JSON.stringify(history.body.reviews));
  assert.deepEqual(history.body.reviews.map((r: Record<string, any>) => r.reason), [REDACTED, null, REDACTED]);
  assert.ok(!JSON.stringify(history.body).includes('Old reason'));
  // Closed: it stays as it was decided.
  for (const [action, extra] of [['reopen', { reason: 'x' }], ['change_points', { points: 1, reason: 'x' }]] as const) {
    const res = await review(top.token, d.id, { action, version: after_.version, ...extra });
    assert.equal(res.status, 403, action);
    assert.equal(res.body.code, 'duty_anonymized', action);
  }
  // Its owner's own copy names nobody either.
  const archive = JSON.parse((await get(reyes.token, '/api/me/export?format=json&sections=duty')).text);
  const copy = (archive.records.duties as Array<Record<string, any>>).find((x) => x.id === d.id)!;
  for (const key of ['reviewer_label', 'overrider_label', 'recorder_label']) assert.ok(!(key in copy), key);
  const lines = (archive.duty_reviews as Array<Record<string, any>>).filter((r) => r.duty_id === d.id);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((r) => !('actor_id' in r) && (r.actor === null || r.actor === 'me') && (r.reason === null || r.reason === REDACTED)), JSON.stringify(lines));
  assert.deepEqual(lines.map((r) => r.actor), [null, 'me', null], 'nobody else is named on an anonymized duty');

  // Destroyed: the duty and its history go together, with foreign keys on.
  saveSchedule(app.ctx, 'G8', { record_type: 'duties', retain_days: 365, disposition: 'destroy', enabled: true }, op.id);
  runDisposition(app.ctx, { orgId: 'G8', dryRun: false, actorId: op.id });
  assert.equal(rowOf('duties', d.id), undefined);
  assert.deepEqual(historyOf(d.id), []);
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM duty_reviews WHERE duty_id NOT IN (SELECT id FROM duties)').get() as { n: number }).n, 0, 'no history without its duty');
  assert.deepEqual(app.ctx.db.pragma('foreign_key_check'), []);
  saveSchedule(app.ctx, 'G8', { record_type: 'duties', retain_days: 365, disposition: 'anonymize', enabled: false }, op.id);
});
