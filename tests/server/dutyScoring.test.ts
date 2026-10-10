import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { calculatePoints, describeRule, policyOn, scoringPolicyProblems, type ScoringPolicyContent } from '../../shared/dutyScoring.ts';
import { scoringToday } from '../../server/services/dutyScoring.ts';

/**
 * Duty scoring policies (VANTAGE_CLAUDE_MASTER §13 and Task 18, brought into Task 6 by John's decision; ADR-0012).
 * The arithmetic gives the spec's examples; a version is published once with the day it takes effect, never changed
 * after, and only withdrawn before that day, so duty is always scored under the version in force on its own day.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person;
let um: Person;
let records: Person;
let auditor: Person;
let g1lead: Person;
const types: Record<string, string> = {};
const call = (method: string, token: string, path: string, body?: unknown) => app.call(method, path, { token, body });
const post = (token: string, path: string, body: unknown = {}) => call('POST', token, path, body);
const login = async (username: string) => (await app.login(username)).body.token as string;
const dayAfter = (day: string, n = 1) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** A request body: rules may leave out what their method does not use, as the console's do. */
const policy = (over: Record<string, unknown> & { effective_from: string }) => ({
  note: 'Command policy letter', rules: [{ duty_type_id: types.DNCO, method: 'fixed', points: 4 }], multipliers: [], combine: 'highest', ...over,
});

async function orgRoleHolder(username: string, role: string) {
  const person = await app.register(username);
  await enroll(app, op.token, 'G8', person.id);
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: person.id, role })).status, 201);
  return { id: person.id, token: await login(username) };
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  um = await orgRoleHolder('scoremgr', 'admin');
  records = await orgRoleHolder('scorerec', 'records');
  auditor = await orgRoleHolder('scoreaud', 'auditor');
  const lead = await app.register('scoreg1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: lead.id })).status, 201);
  g1lead = { id: lead.id, token: await login('scoreg1lead') };
  assert.equal((await post(um.token, '/api/orgs/G8/duty-types/standard')).status, 200);
  const listed = await call('GET', um.token, '/api/orgs/G8/configuration');
  for (const d of listed.body.dutyTypes as Array<{ id: string; code: string }>) types[d.code] = d.id;
  assert.ok(types.DNCO && types.SAF, JSON.stringify(Object.keys(types)));
});
after(async () => { await app.close(); });

test('the calculator gives the spec’s examples', () => {
  const p: ScoringPolicyContent = {
    rules: [
      { duty_type_id: 'cg', method: 'fixed', points: 2, bands: null },
      { duty_type_id: 'saf', method: 'per_day', points: 3, bands: null },
      { duty_type_id: 'event', method: 'per_hour', points: 0.25, bands: null },
      { duty_type_id: 'band', method: 'bands', points: null, bands: [{ from_hours: 0, points: 1 }, { from_hours: 4, points: 2 }, { from_hours: 8, points: 3 }, { from_hours: 12, points: 4 }] },
      { duty_type_id: 'dnco', method: 'fixed', points: 5, bands: null },
    ],
    multipliers: [{ condition: 'holiday', factor: 1.5 }, { condition: 'weekend', factor: 1.25 }],
    combine: 'highest',
  };
  const score = (duty_type_id: string, hours = 0, days = 0, conditions: Array<'holiday' | 'weekend'> = []) => calculatePoints(p, { duty_type_id, hours, days, conditions }).points;
  assert.equal(score('cg', 6), 2, 'Color Guard: 2 points, fixed');
  assert.equal(score('saf', 72, 3), 9, 'SAF: 3 points a day');
  assert.equal(score('event', 6), 1.5, 'Event Support: 0.25 points an hour');
  assert.deepEqual([0, 3.9, 4, 7.5, 8, 12, 30].map((h) => score('band', h)), [1, 1, 2, 2, 3, 4, 4], 'bands 0–4: 1, 4–8: 2, 8–12: 3, 12+: 4');
  assert.equal(score('dnco', 24, 1, ['holiday']), 7.5, 'DNCO 5 on a holiday ×1.5 = 7.5');
  assert.equal(score('dnco', 24, 1, ['holiday', 'weekend']), 7.5, 'the highest multiplier when several apply');
  assert.equal(calculatePoints({ ...p, combine: 'multiply' }, { duty_type_id: 'dnco', hours: 24, days: 1, conditions: ['holiday', 'weekend'] }).points, 9.38, 'or all of them multiplied: 5 × 1.5 × 1.25');
  assert.equal(score('unknown', 24, 1, ['holiday']), 0, 'a duty type the policy does not score earns nothing');
  assert.equal(describeRule(p.rules[3]), '0–4h: 1, 4–8h: 2, 8–12h: 3, 12h+: 4');
  assert.equal(describeRule(p.rules[2]), '0.25 points an hour');
});

test('duty keeps the points of the version in force on its day: March under January’s policy stays 4', () => {
  const v = (id: string, effective_from: string, points: number, withdrawn_at: string | null = null) => ({ id, effective_from, withdrawn_at, rules: [{ duty_type_id: 'dnco', method: 'fixed' as const, points, bands: null }], multipliers: [], combine: 'highest' as const });
  const versions = [v('jan', '2026-01-01', 4), v('jul', '2026-07-01', 5), v('aug', '2026-08-01', 9, '2026-07-15T00:00:00Z')];
  const pointsOn = (day: string) => { const p = policyOn(versions, day); return p ? calculatePoints(p, { duty_type_id: 'dnco', hours: 24, days: 1, conditions: [] }).points : null; };
  assert.equal(pointsOn('2026-03-14'), 4);
  assert.equal(pointsOn('2026-06-30'), 4);
  assert.equal(pointsOn('2026-07-01'), 5);
  assert.equal(pointsOn('2026-09-01'), 5, 'a withdrawn version never applies');
  assert.equal(pointsOn('2025-12-31'), null, 'before the first version, nothing is scored');
});

test('a policy that goes past what Vantage allows is refused with what to fix', () => {
  const names = new Map([['a', 'DNCO'], ['b', 'SAF']]);
  const ok: ScoringPolicyContent = { rules: [{ duty_type_id: 'a', method: 'fixed', points: 4, bands: null }], multipliers: [{ condition: 'holiday', factor: 1.5 }], combine: 'highest' };
  assert.deepEqual(scoringPolicyProblems(ok, names), []);
  const problems = (over: Partial<ScoringPolicyContent>) => scoringPolicyProblems({ ...ok, ...over }, names);
  assert.match(problems({ rules: [{ duty_type_id: 'a', method: 'fixed', points: 101, bands: null }] })[0], /DNCO: points are 0 to 100/);
  assert.match(problems({ rules: [{ duty_type_id: 'a', method: 'fixed', points: Number.NaN, bands: null }] })[0], /DNCO: points are 0 to 100/);
  assert.match(problems({ rules: [{ duty_type_id: 'z', method: 'fixed', points: 1, bands: null }] })[0], /does not have in use/);
  assert.match(problems({ rules: [ok.rules[0], ok.rules[0]] })[0], /DNCO has more than one rule/);
  assert.match(problems({ rules: [{ duty_type_id: 'b', method: 'bands', points: null, bands: [{ from_hours: 2, points: 1 }] }] })[0], /first length starts at 0 hours/);
  assert.match(problems({ rules: [{ duty_type_id: 'b', method: 'bands', points: null, bands: [{ from_hours: 0, points: 1 }, { from_hours: 0, points: 2 }] }] })[0], /each length starts after the one before it/);
  assert.match(problems({ multipliers: [{ condition: 'holiday', factor: 6 }] })[0], /Multipliers are 1 to 5/);
  assert.match(problems({ multipliers: [{ condition: 'holiday', factor: 0.5 }] })[0], /Multipliers are 1 to 5/, 'a multiplier never takes points away');
});

test('a Unit Manager publishes versions in order, from tomorrow on, and withdraws only one that has not taken effect', async () => {
  const today = scoringToday(app.ctx);
  // A version from January, as one published then would stand now: in force.
  app.ctx.db.prepare('INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
    .run('v1-january', 'G8', '2026-01-01', JSON.stringify({ rules: [{ duty_type_id: types.DNCO, method: 'fixed', points: 4, bands: null }], multipliers: [], combine: 'highest' }), 'January policy', um.id, '2026-01-01T00:00:00.000Z');

  assert.equal((await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: dayAfter(today, -1) }))).status, 400, 'a version never reaches back over duty already stood');
  const sameDay = await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: today }));
  assert.equal(sameDay.status, 400, 'nor over duty stood earlier today');
  assert.match(sameDay.body.error, /tomorrow or later/);
  assert.equal((await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: dayAfter(today), note: '   ' }))).status, 400, 'a version says why');
  const empty = await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: dayAfter(today), rules: [] }));
  assert.equal(empty.status, 400, 'and scores something');
  assert.match(empty.body.error, /at least one duty type/);

  const v2 = await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: dayAfter(today), multipliers: [{ condition: 'holiday', factor: 1.5 }] }));
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.equal(v2.body.version, 2);
  const published = app.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'duty_scoring_policy_published' ORDER BY seq DESC LIMIT 1").get() as Record<string, any>;
  assert.equal(published.org_id, 'G8');
  assert.equal(published.entity_id, v2.body.id);
  assert.match(published.detail, /version 2 from .*: 1 duty types scored, 1 multipliers \(highest\); Command policy letter/);

  const again = await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: dayAfter(today) }));
  assert.equal(again.status, 409, 'a second version on the same day would rewrite the first');
  assert.equal(again.body.code, 'scoring_order');

  const v3 = await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: dayAfter(today, 30), rules: [{ duty_type_id: types.DNCO, method: 'fixed', points: 5 }, { duty_type_id: types.SAF, method: 'per_day', points: 3 }] }));
  assert.equal(v3.status, 201, JSON.stringify(v3.body));
  assert.equal(v3.body.version, 3);
  const overview = (await call('GET', records.token, '/api/orgs/G8/configuration')).body.scoring;
  assert.equal(overview.today, today);
  assert.equal(overview.current, 'v1-january', 'everyone who may view the Unit Instance sees the version in force');
  assert.deepEqual(overview.policies.map((p: { version: number; status: string }) => [p.version, p.status]), [[3, 'scheduled'], [2, 'scheduled'], [1, 'in_force']]);

  const inForce = await post(um.token, '/api/orgs/G8/duty-scoring/v1-january/withdraw');
  assert.equal(inForce.status, 409, 'a version in force is history');
  assert.equal(inForce.body.code, 'in_force');
  const withdrawn = await post(um.token, `/api/orgs/G8/duty-scoring/${v3.body.id}/withdraw`);
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
  assert.ok(withdrawn.body.withdrawn_at);
  assert.equal(withdrawn.body.withdrawn_by, um.id);
  assert.equal((await post(um.token, `/api/orgs/G8/duty-scoring/${v3.body.id}/withdraw`)).body.code, 'withdrawn');
  const audited = app.ctx.db.prepare("SELECT * FROM audit_log WHERE action = 'duty_scoring_policy_withdrawn' ORDER BY seq DESC LIMIT 1").get() as Record<string, any>;
  assert.equal(audited.org_id, 'G8');
  assert.equal(audited.entity_id, v3.body.id);

  // Once withdrawn it no longer holds its place, and it stays on the record.
  const v4 = await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: dayAfter(today, 7) }));
  assert.equal(v4.status, 201, JSON.stringify(v4.body));
  assert.equal(v4.body.version, 4);
  const after = (await call('GET', um.token, '/api/orgs/G8/configuration')).body.scoring;
  assert.deepEqual(after.policies.map((p: { version: number; status: string }) => [p.version, p.status]), [[4, 'scheduled'], [3, 'withdrawn'], [2, 'scheduled'], [1, 'in_force']]);
});

test('the database refuses to change a published version, withdraw one in force, bring back a withdrawn one or publish out of order', () => {
  const db = app.ctx.db;
  const [v3] = db.prepare("SELECT * FROM duty_scoring_policies WHERE org_id = 'G8' AND version = 3").all() as Array<Record<string, any>>;
  assert.throws(() => db.prepare("UPDATE duty_scoring_policies SET policy = '{}' WHERE id = 'v1-january'").run(), /a published duty scoring policy is never changed/);
  assert.throws(() => db.prepare("UPDATE duty_scoring_policies SET effective_from = '2000-01-01' WHERE id = 'v1-january'").run(), /never changed/);
  assert.throws(() => db.prepare("UPDATE duty_scoring_policies SET id = 'renamed' WHERE id = 'v1-january'").run(), /never changed/, 'its id is what the audit trail names');
  assert.throws(() => db.prepare("UPDATE duty_scoring_policies SET org_id = 'G1' WHERE id = 'v1-january'").run(), /never changed|cross_instance/);
  assert.throws(() => db.prepare("UPDATE duty_scoring_policies SET withdrawn_at = ? WHERE id = 'v1-january'").run(new Date().toISOString()), /has taken effect is never withdrawn/);
  assert.throws(() => db.prepare('UPDATE duty_scoring_policies SET withdrawn_at = NULL WHERE id = ?').run(v3.id), /stays withdrawn/);
  const insert = db.prepare("INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_at) VALUES (?, 'G8', ?, ?, '{}', 'x', '2026-01-01T00:00:00.000Z')");
  assert.throws(() => insert.run('late-but-early', 99, '2026-02-01'), /take effect in order/, 'a later version taking effect before one standing');
  assert.throws(() => insert.run('early-but-late', 0, '2099-01-01'), /take effect in order|CHECK constraint/, 'an earlier version taking effect after one standing');
});

test('only a Unit Manager of the Unit Instance publishes or withdraws, and only for its own duty types', async () => {
  const today = scoringToday(app.ctx);
  const later = dayAfter(today, 60);
  for (const [who, person] of [['Records Officer', records], ['Unit Auditor', auditor]] as const) {
    const res = await post(person.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: later }));
    assert.equal(res.status, 403, `${who} publishes`);
    assert.equal(res.body.code, 'org_permission');
  }
  const scheduled = app.ctx.db.prepare("SELECT id FROM duty_scoring_policies WHERE org_id = 'G8' AND withdrawn_at IS NULL ORDER BY version DESC LIMIT 1").get() as { id: string };
  assert.equal((await post(auditor.token, `/api/orgs/G8/duty-scoring/${scheduled.id}/withdraw`)).status, 403);
  // Another Unit Instance's Lead Unit Manager cannot reach G8, and cannot score G8's duty types or withdraw its versions from G1.
  assert.equal((await post(g1lead.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: later }))).status, 404);
  const borrowed = await post(g1lead.token, '/api/orgs/G1/duty-scoring', policy({ effective_from: later }));
  assert.equal(borrowed.status, 400);
  assert.match(borrowed.body.error, /does not have in use/);
  assert.equal((await post(g1lead.token, `/api/orgs/G1/duty-scoring/${scheduled.id}/withdraw`)).status, 404);
  // A retired duty type is no longer scored by a new version.
  assert.equal((await call('PATCH', um.token, `/api/orgs/G8/duty-types/${types.SAF}`, { active: false })).status, 200);
  const retired = await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: later, rules: [{ duty_type_id: types.SAF, method: 'per_day', points: 3 }] }));
  assert.equal(retired.status, 400);
  assert.equal((await call('PATCH', um.token, `/api/orgs/G8/duty-types/${types.SAF}`, { active: true })).status, 200);
  // The body is checked before the policy is.
  assert.equal((await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: later, rules: [{ duty_type_id: types.DNCO, method: 'per_week' as never, points: 1 }] }))).status, 400);
  assert.equal((await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: 'tomorrow' }))).status, 400);
  const tooMuch = await post(um.token, '/api/orgs/G8/duty-scoring', policy({ effective_from: later, rules: [{ duty_type_id: types.DNCO, method: 'fixed', points: 500 }] }));
  assert.equal(tooMuch.status, 400);
  assert.ok(tooMuch.body.problems?.length, JSON.stringify(tooMuch.body));
  const versions = (app.ctx.db.prepare("SELECT COUNT(*) AS n FROM duty_scoring_policies WHERE org_id = 'G1'").get() as { n: number }).n;
  assert.equal(versions, 0, 'nothing reached G1');
});
