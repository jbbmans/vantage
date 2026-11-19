import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';
import { readFileSync } from 'node:fs';
import { SUMMARY_FILE, gateProblems, loadRegister, renderGate, verdictOf, type GateRegister } from '../../scripts/readiness-gate.ts';

/**
 * Task 28, the production readiness gate: the six representative roles in one Unit Instance, each tried against what
 * it may and may not do, beside a second Unit Instance whose records nobody in the first may reach. Each area has its
 * own deep tests (named in docs/engineering/readiness-gate.json); this file is the one place the six roles stand side
 * by side.
 *
 * The roles, all in G-8:
 * - the Marine: the default role in the Fiscal section;
 * - the supervisor: a fire team leader named as the Marine's supervisor;
 * - the NCO and the SNCO: the standard templates in the Fiscal section;
 * - the Unit Leader: leads the Fiscal section (full unit authority there and below, nothing above);
 * - the Unit Manager: a Unit Instance role (structure and configuration, never records);
 * - the Vantage Administrator: a platform role (the service, never a Unit Instance's records).
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person & { unitId: string };
let marine: Person, peer: Person, supervisor: Person, nco: Person, snco: Person, leader: Person, manager: Person, vadmin: Person;
/** A Marine of G-8's Budget section, beside Fiscal: the Fiscal Unit Leader has no claim on them. */
let budgetMarine: Person;
/** The second Unit Instance. */
let g1lead: Person, g1marine: Person;

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const made = async (token: string, path: string, body: unknown) => {
  const res = await post(token, path, body);
  assert.equal(res.status, 201, `${path}: ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
};
const auditCount = (action: string, entityId?: string) =>
  (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = ?${entityId ? ' AND entity_id = ?' : ''}`).get(...(entityId ? [action, entityId] : [action])) as { n: number }).n;

/** The six, by the name the gate gives them, for messages. */
const six = () => ({ Marine: marine, Supervisor: supervisor, NCO: nco, SNCO: snco, 'Unit Leader': leader, 'Unit Manager': manager, 'Vantage Administrator': vadmin });

const ids: Record<string, string> = {};

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Fiscal', short_name: 'FISCAL', code: 'fiscal', parent_id: 'G8' })).status, 201);
  assert.equal((await post(op.token, '/api/org/units', { name: 'G8 Budget', short_name: 'BUDGET', code: 'budget', parent_id: 'G8' })).status, 201);

  marine = await app.register('gatemarine', { last_name: 'Alvarez', rank_id: 'LCpl' });
  peer = await app.register('gatepeer', { last_name: 'Brooks', rank_id: 'LCpl' });
  supervisor = await app.register('gatesuper', { last_name: 'Chen', rank_id: 'Sgt' });
  nco = await app.register('gatenco', { last_name: 'Dawson', rank_id: 'Cpl' });
  snco = await app.register('gatesnco', { last_name: 'Ellis', rank_id: 'SSgt' });
  leader = await app.register('gatelead', { last_name: 'Flores', rank_id: 'GySgt' });
  budgetMarine = await app.register('gatebudget', { last_name: 'Grant', rank_id: 'Cpl' });
  await enroll(app, op.token, 'FISCAL', marine.id);
  await enroll(app, op.token, 'FISCAL', peer.id);
  await enroll(app, op.token, 'FISCAL', supervisor.id, 'fire-team-leader');
  await enroll(app, op.token, 'FISCAL', nco.id, 'nco');
  await enroll(app, op.token, 'FISCAL', snco.id, 'snco');
  await enroll(app, op.token, 'FISCAL', leader.id);
  await enroll(app, op.token, 'BUDGET', budgetMarine.id);
  assert.equal((await post(op.token, '/api/org/units/FISCAL/owner', { user_id: leader.id })).status, 200);

  // The Unit Manager: a member of G-8 holding the Unit Instance role, granted by its Lead Unit Manager.
  manager = await app.register('gatemanager', { last_name: 'Hughes', rank_id: 'MSgt' });
  await enroll(app, op.token, 'G8', manager.id);
  const granted = await post(op.token, '/api/orgs/G8/roles', { user_id: manager.id, role: 'admin' });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));

  // The Vantage Administrator: platform staff, in no Unit Instance. Staff roles need a second factor when granted.
  vadmin = await app.register('gatevadmin', { last_name: 'Ibarra', rank_id: 'GySgt' });
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(vadmin.id);
  const staffed = await post(op.token, '/api/platform/staff', { user_id: vadmin.id, role: 'admin' });
  assert.equal(staffed.status, 201, JSON.stringify(staffed.body));
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(vadmin.id);

  // The second Unit Instance.
  g1lead = await app.register('gateg1lead', { last_name: 'Jones', rank_id: 'Maj' });
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('gateg1lead');
  g1marine = await app.register('gateg1marine', { last_name: 'King', rank_id: 'LCpl' });
  await enroll(app, g1lead.token, 'G1', g1marine.id);

  for (const [name, who] of [['gatemarine', marine], ['gatepeer', peer], ['gatesuper', supervisor], ['gatenco', nco], ['gatesnco', snco], ['gatelead', leader], ['gatebudget', budgetMarine], ['gatemanager', manager], ['gatevadmin', vadmin], ['gateg1marine', g1marine]] as const) who.token = await login(name);

  // The supervisor is named on the Marine's personnel record; the peer, a plain Marine, supervises the Budget Marine.
  assert.equal((await put(op.token, `/api/org/units/FISCAL/members/${marine.id}`, { supervisor_id: supervisor.id })).status, 200);
  assert.equal((await put(op.token, `/api/org/units/BUDGET/members/${budgetMarine.id}`, { supervisor_id: peer.id })).status, 200);

  ids.shared = (await made(marine.token, '/api/records/activities', { title: 'Reconciled 14 ULOs for the quarter', date: '2026-10-01', visibility: 'unit', unit_id: 'FISCAL' })).id;
  ids.private = (await made(marine.token, '/api/records/activities', { title: 'Private study notes', date: '2026-10-02', visibility: 'private' })).id;
  ids.budget = (await made(budgetMarine.token, '/api/records/activities', { title: 'Budget section entry', date: '2026-10-03', visibility: 'unit', unit_id: 'BUDGET' })).id;
  ids.g1 = (await made(g1marine.token, '/api/records/activities', { title: 'G-1 processed orders', date: '2026-10-04', visibility: 'unit', unit_id: 'G1' })).id;
});
after(async () => { await app.close(); });

test('records: each role reads the Marine’s shared entry as its role allows, and only the Marine reads the private one', async () => {
  const shared = `/api/records/activities/${ids.shared}`;
  const priv = `/api/records/activities/${ids.private}`;
  // Shared with the unit: those whose role reads shared records there. Being named supervisor adds nothing to the role.
  const readsShared: Record<string, boolean> = { Marine: true, Supervisor: true, NCO: true, SNCO: true, 'Unit Leader': true, 'Unit Manager': false, 'Vantage Administrator': false };
  for (const [name, who] of Object.entries(six())) {
    const res = await get(who.token, shared);
    assert.equal(res.status === 200, readsShared[name], `${name} reads the shared entry: ${res.status}`);
    if (name !== 'Marine') assert.ok([403, 404].includes((await get(who.token, priv)).status), `${name} never reads the private entry`);
  }
  assert.equal((await get(marine.token, priv)).status, 200);
  assert.notEqual((await get(peer.token, shared)).status, 200, 'a fellow Marine reads no shared records by the default role');
});

test('personnel: the record opens by role, never by being someone’s supervisor, and not for the platform', async () => {
  const path = (id: string) => `/api/org/team/${id}/personnel`;
  // The supervisor holds Open member records by their role; the peer supervises the Budget Marine and holds no such role.
  assert.equal((await get(supervisor.token, path(marine.id))).status, 200);
  assert.equal((await get(peer.token, path(budgetMarine.id))).status, 403, 'supervising someone confers nothing (ADR-0017)');
  assert.equal((await get(peer.token, path(marine.id))).status, 403);
  // The Unit Leader leads Fiscal and nothing beside it.
  assert.equal((await get(leader.token, path(marine.id))).status, 200);
  assert.equal((await get(leader.token, path(budgetMarine.id))).status, 403, 'the Fiscal leader has no claim on Budget');
  // The Unit Manager manages the record without reading the Marine’s records; the platform sees neither.
  const um = await get(manager.token, path(marine.id));
  assert.equal(um.status, 200, JSON.stringify(um.body));
  assert.equal(um.body.records, null);
  assert.equal((await get(manager.token, `/api/org/team/${marine.id}`)).status, 403, 'nor the Marine’s page');
  assert.equal((await get(vadmin.token, path(marine.id))).status, 403);
  assert.equal((await get(vadmin.token, `/api/org/team/${marine.id}`)).status, 403);
  // Another Unit Instance's leader sees nothing of G-8's Marines.
  assert.equal((await get(g1lead.token, path(marine.id))).status, 403);
});

test('consoles: the Unit Manager runs G-8’s configuration, the Vantage Administrator runs the service, and neither the other’s', async () => {
  const unitConsole = '/api/orgs/G8/configuration';
  const platform = '/api/platform/operations';
  const opensUnit: Record<string, boolean> = { Marine: false, Supervisor: false, NCO: false, SNCO: false, 'Unit Leader': false, 'Unit Manager': true, 'Vantage Administrator': false };
  const opensPlatform: Record<string, boolean> = { Marine: false, Supervisor: false, NCO: false, SNCO: false, 'Unit Leader': false, 'Unit Manager': false, 'Vantage Administrator': true };
  for (const [name, who] of Object.entries(six())) {
    const u = await get(who.token, unitConsole);
    assert.equal(u.status === 200, opensUnit[name], `${name} opens the Unit Manager console: ${u.status}`);
    const p = await get(who.token, platform);
    assert.equal(p.status === 200, opensPlatform[name], `${name} opens the platform operations page: ${p.status}`);
    assert.notEqual((await get(who.token, '/api/orgs/G1/configuration')).status, 200, `${name} never opens G-1’s console`);
  }
});

test('escalation: nobody raises themselves, whatever tier they start in', async () => {
  const refused = (res: { status: number; body: any }, what: string) => {
    assert.ok(res.status === 403 || res.status === 404, `${what}: ${res.status} ${JSON.stringify(res.body)}`);
  };
  const grants = () => app.ctx.db.prepare('SELECT COUNT(*) AS n FROM member_roles').get() as { n: number };
  const staffBefore = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM platform_roles').get() as { n: number }).n;
  const before = grants().n;
  // A Unit Manager names no Vantage staff, themselves least.
  for (const role of ['admin', 'owner', 'support', 'auditor']) refused(await post(manager.token, '/api/platform/staff', { user_id: manager.id, role }), `Unit Manager to platform ${role}`);
  // Nor themselves a role that reads records, nor the leadership, in their own Unit Instance (ADR-0010).
  refused(await post(manager.token, `/api/org/team/${manager.id}/roles`, { role_id: 'G8:snco', unit_id: 'G8' }), 'Unit Manager to SNCO of G-8');
  refused(await post(manager.token, '/api/org/units/G8/owner', { user_id: manager.id }), 'Unit Manager to Unit Leader of G-8');
  // A Vantage Administrator never names themselves a Unit Manager.
  refused(await post(vadmin.token, '/api/platform/orgs/G8/managers', { user_id: vadmin.id, role: 'admin' }), 'Vantage Administrator to Unit Manager');
  // An SNCO does not hand themselves a role above their own; the Unit Leader takes nothing above Fiscal.
  refused(await post(snco.token, `/api/org/team/${snco.id}/roles`, { role_id: 'FISCAL:sncoic', unit_id: 'FISCAL' }), 'SNCO to SNCOIC');
  refused(await post(leader.token, `/api/org/team/${budgetMarine.id}/roles`, { role_id: 'BUDGET:snco', unit_id: 'BUDGET' }), 'Fiscal Unit Leader granting in Budget');
  refused(await post(leader.token, '/api/org/units/G8/owner', { user_id: leader.id }), 'Fiscal Unit Leader to G-8 Unit Leader');
  refused(await post(leader.token, '/api/orgs/G8/roles', { user_id: leader.id, role: 'admin' }), 'Fiscal Unit Leader to Unit Manager');
  // Approving your own duty is named by a role, and nobody hands that role to themselves (ADR-0024, "role only").
  const own = await post(leader.token, '/api/org/roles', { unit_id: 'FISCAL', name: 'Duty officer (self-approving)', position: 50, permissions: PERMISSIONS.REVIEW_DUTY | PERMISSIONS.APPROVE_OWN_DUTY });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  refused(await post(leader.token, `/api/org/team/${leader.id}/roles`, { role_id: own.body.id, unit_id: 'FISCAL' }), 'Unit Leader to their own Approve own duty');
  // The Marine raises nobody, themselves least.
  refused(await post(marine.token, `/api/org/team/${marine.id}/roles`, { role_id: 'FISCAL:snco', unit_id: 'FISCAL' }), 'Marine to SNCO');
  assert.equal(grants().n, before, 'no role was granted');
  assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM platform_roles').get() as { n: number }).n, staffBefore, 'no staff role was granted');
});

test('another Unit Instance: no G-8 role reaches G-1’s records by its id', async () => {
  for (const [name, who] of Object.entries(six())) {
    const res = await get(who.token, `/api/records/activities/${ids.g1}`);
    assert.ok([403, 404].includes(res.status), `${name} reads G-1’s entry: ${res.status}`);
    assert.ok(!JSON.stringify(res.body).includes('G-1 processed orders'), `${name} learns nothing of it`);
    const put1 = await put(who.token, `/api/records/activities/${ids.g1}`, { title: 'Changed from G-8', version: 1 });
    assert.ok([403, 404].includes(put1.status), `${name} changes G-1’s entry: ${put1.status} ${JSON.stringify(put1.body)}`);
  }
  assert.equal(auditCount('update', ids.g1), 0);
});

test('duty: the Marine submits, a reviewer decides, nobody their own, and a later scoring version leaves past duty as it was', async () => {
  // Section 13's example: DNCO 4 points from January, 5 from July. Stood in March, it stays 4 whenever it is approved;
  // stood in August, it is 5. Written as the Unit Instance's invented past, as the demo's seed is (ADR-0036 §6).
  const at = '2025-12-20T00:00:00.000Z';
  app.ctx.db.prepare('INSERT INTO duty_types (id, org_id, code, name, description, active, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, 1, ?, ?)').run('gate-dnco', 'G8', 'DNCO', 'Duty NCO', at, at);
  const version = app.ctx.db.prepare('INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const rule = (points: number) => JSON.stringify({ rules: [{ duty_type_id: 'gate-dnco', method: 'fixed', points, bands: null }], multipliers: [], combine: 'highest' });
  version.run('gate-v1', 'G8', 1, '2026-01-01', rule(4), 'DNCO 4', op.id, at);
  version.run('gate-v2', 'G8', 2, '2026-07-01', rule(5), 'DNCO 5 from July', op.id, at);

  const stood = async (date: string) => {
    const res = await post(marine.token, '/api/records/duties', { duty_type_id: 'gate-dnco', date, start_time: '0800', end_date: date, end_time: '1600', unit_id: 'FISCAL' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as Record<string, any>;
  };
  const march = await stood('2026-03-11');
  const august = await stood('2026-08-12');
  assert.equal(march.calculated_points, 4);
  assert.equal(august.calculated_points, 5);

  const decide = (who: Person, d: Record<string, any>, action = 'approve') => post(who.token, `/api/records/duties/${d.id}/review`, { action, version: (app.ctx.db.prepare('SELECT version FROM duties WHERE id = ?').get(d.id) as { version: number }).version });
  // Nobody decides their own, and those without Review duty decide nobody's: the supervisor, the NCO, the Unit
  // Manager and the Vantage Administrator.
  for (const [name, who] of [['the Marine', marine], ['the supervisor', supervisor], ['the NCO', nco], ['the Unit Manager', manager], ['the Vantage Administrator', vadmin], ['G-1’s leader', g1lead]] as const) {
    const res = await decide(who, march);
    assert.ok([403, 404].includes(res.status), `${name} approves the Marine’s duty: ${res.status} ${JSON.stringify(res.body)}`);
  }
  assert.equal((app.ctx.db.prepare('SELECT approval_status FROM duties WHERE id = ?').get(march.id) as { approval_status: string }).approval_status, 'pending');
  // The SNCO reviews duty: March is approved at 4 though version 2 is in force today; August at 5.
  const a1 = await decide(snco, march);
  assert.equal(a1.status, 200, JSON.stringify(a1.body));
  const a2 = await decide(leader, august);
  assert.equal(a2.status, 200, JSON.stringify(a2.body));
  const pts = (id: string) => app.ctx.db.prepare('SELECT approval_status, approved_points FROM duties WHERE id = ?').get(id) as { approval_status: string; approved_points: number };
  assert.deepEqual(pts(march.id), { approval_status: 'approved', approved_points: 4 });
  assert.deepEqual(pts(august.id), { approval_status: 'approved', approved_points: 5 });
  // The SNCO's own duty is theirs to submit and someone else's to decide.
  const own = await post(snco.token, '/api/records/duties', { duty_type_id: 'gate-dnco', date: '2026-08-13', start_time: '0800', end_date: '2026-08-13', end_time: '1600', unit_id: 'FISCAL' });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.ok([403, 404].includes((await decide(snco, own.body)).status), 'nobody approves their own duty without a role naming it');
});

test('counseling: its counselor, its Marine and the unit’s leader draw the NAVMC 2795 worksheet; nobody outside the unit’s chain reaches it', async () => {
  const c = await made(supervisor.token, '/api/records/counselings', {
    user_id: marine.id, type: 'quarterly', date: '2026-10-05', summary: 'Discussed the reconciliation backlog.', strengths: 'Owned the clean-up.',
    improvements: 'Brief the section chief earlier.', goals_set: 'Clear the backlog by month end.', follow_up_date: '2026-11-05', visibility: 'unit', unit_id: 'FISCAL', stage: 'draft',
  });
  const fin = await post(supervisor.token, `/api/records/counselings/${c.id}/finalize`, { version: c.version });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const pdf = (who: Person) => app.call('GET', `/api/records/counselings/${c.id}/export?format=pdf`, { token: who.token, binary: true });
  for (const [name, who] of [['the counselor', supervisor], ['the Marine', marine], ['the unit’s leader', leader]] as const) {
    const res = await pdf(who);
    assert.equal(res.status, 200, `${name} draws the worksheet`);
    assert.equal(res.buffer!.subarray(0, 5).toString('latin1'), '%PDF-', `${name}’s worksheet is a PDF`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  }
  for (const [name, who] of [['a fellow Marine', peer], ['the Unit Manager', manager], ['the Vantage Administrator', vadmin], ['G-1’s leader', g1lead], ['the Budget Marine', budgetMarine]] as const) {
    const res = await pdf(who);
    assert.ok([403, 404].includes(res.status), `${name} draws the worksheet: ${res.status}`);
  }
  assert.equal(auditCount('export_record', c.id), 3, 'each worksheet drawn is on the record, refusals drew none');
});

test('exports: the Marine takes everything of theirs, an SNCO the unit’s shared work, and nobody else’s private entries or another unit', async () => {
  const mine = await get(marine.token, '/api/me/export?format=json');
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const myIds = JSON.stringify(mine.body);
  assert.ok(myIds.includes(ids.shared) && myIds.includes(ids.private), 'their own shared and private entries');
  assert.ok(!myIds.includes(ids.budget) && !myIds.includes(ids.g1), 'nobody else’s');

  const unit = (who: Person) => get(who.token, '/api/org/units/FISCAL/export');
  const exportsUnit: Record<string, boolean> = { Marine: false, Supervisor: false, NCO: false, SNCO: true, 'Unit Leader': true, 'Unit Manager': false, 'Vantage Administrator': false };
  for (const [name, who] of Object.entries(six())) {
    const res = await unit(who);
    assert.equal(res.status === 200, exportsUnit[name], `${name} exports Fiscal: ${res.status}`);
    if (res.status !== 200) continue;
    const text = JSON.stringify(res.body);
    assert.ok(text.includes(ids.shared), `${name}’s export has the shared entry`);
    assert.ok(!text.includes(ids.private) && !text.includes('Private study notes'), `${name}’s export has no private entry`);
    assert.ok(!text.includes(ids.budget) && !text.includes(ids.g1), `${name}’s export has nothing of Budget or G-1`);
  }
  assert.ok([403, 404].includes((await get(snco.token, '/api/org/units/G1/export')).status), 'nor another Unit Instance’s');
  assert.ok([403, 404].includes((await get(leader.token, '/api/org/units/BUDGET/export')).status), 'nor the unit beside theirs');
});

test('attachments: a file is exactly as reachable as the record it hangs on', async () => {
  const up = await app.call('POST', `/api/records/activities/${ids.shared}/attachments`, { token: marine.token, raw: Buffer.from('%PDF-1.4\n% gate evidence\n%%EOF\n'), headers: { 'content-type': 'application/pdf', 'x-vantage-filename': 'evidence.pdf' } });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const path = `/api/records/activities/${ids.shared}/attachments/${up.body.id}`;
  const reads: Record<string, boolean> = { Marine: true, Supervisor: true, NCO: true, SNCO: true, 'Unit Leader': true, 'Unit Manager': false, 'Vantage Administrator': false };
  for (const [name, who] of Object.entries(six())) {
    const res = await app.call('GET', path, { token: who.token, binary: true });
    assert.equal(res.status === 200, reads[name], `${name} opens the file: ${res.status}`);
    if (res.status === 200) {
      assert.match(res.headers.get('content-disposition') || '', /attachment/);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
  }
  for (const [name, who] of [['a fellow Marine', peer], ['G-1’s leader', g1lead], ['the Budget Marine', budgetMarine]] as const) {
    assert.ok([403, 404].includes((await app.call('GET', path, { token: who.token, binary: true })).status), `${name} opens the file`);
  }
  // Another record's id with this file's id opens nothing.
  assert.ok([403, 404].includes((await app.call('GET', `/api/records/activities/${ids.budget}/attachments/${up.body.id}`, { token: op.token, binary: true })).status));
});

test('report PDF: the Marine draws their own; another Marine’s needs their records opened in the unit', async () => {
  const pdf = (who: Person, userId?: string) => app.call('GET', `/api/reports/pdf?period=all${userId ? `&user_id=${userId}` : ''}`, { token: who.token, binary: true });
  const own = await pdf(marine);
  assert.equal(own.status, 200);
  assert.equal(own.buffer!.subarray(0, 5).toString('latin1'), '%PDF-');
  const opens: Record<string, boolean> = { Supervisor: true, NCO: false, SNCO: true, 'Unit Leader': true, 'Unit Manager': false, 'Vantage Administrator': false };
  for (const [name, who] of Object.entries(six())) {
    if (name === 'Marine') continue;
    const res = await pdf(who, marine.id);
    assert.equal(res.status === 200, opens[name], `${name} draws the Marine’s report: ${res.status}`);
  }
  assert.ok([403, 404].includes((await pdf(g1lead, marine.id)).status), 'nor another Unit Instance');
  assert.ok([403, 404].includes((await pdf(leader, budgetMarine.id)).status), 'nor the unit beside theirs');
});

// ——— The register: what the gate claims is what its tests and checks show, and the verdict is computed, never written ———

test('the gate register names only tests that exist, backs every claim, and READINESS_GATE.md is drawn from it', () => {
  const register = loadRegister();
  assert.deepEqual(gateProblems(register), []);
  assert.equal(readFileSync(SUMMARY_FILE, 'utf8'), renderGate(register), 'run node scripts/readiness-gate.ts --write after editing the register');
});

test('the verdict: an open critical or high defect, an item not shown, or a required check short of a pass fails the engineering gate; operational release is never decided here', () => {
  const base: GateRegister = {
    format: 1, task: 'probe', candidate: { base: 'x', branch: 'y', runtime: 'z', note: 'n' },
    items: [{ id: 'one', title: 'One', source: 's', roles: ['Marine'], status: 'proven', evidence: [{ file: 'tests/server/readinessGate.test.ts', test: 'escalation: nobody raises themselves' }] }],
    defects: [{ id: 'd', title: 'D', severity: 'medium', area: 'a', status: 'open', evidence: [] }],
    external: [{ id: 'x', title: 'X', owner: 'o', source: 's' }],
    checks: [{ id: 'c', title: 'C', command: 'c', required: true, result: 'pass', on: 'abc', detail: '' }],
  };
  const clean = verdictOf(base);
  assert.equal(clean.engineering, 'pass', 'an open medium does not fail it');
  assert.equal(clean.operational, 'not ready');
  assert.deepEqual(clean.waitingOn, ['X (o)']);
  for (const severity of ['critical', 'high'] as const) {
    assert.equal(verdictOf({ ...base, defects: [{ ...base.defects[0], severity }] }).engineering, 'fail', `an open ${severity} defect fails it`);
    assert.equal(verdictOf({ ...base, defects: [{ ...base.defects[0], severity, status: 'fixed', evidence: base.items[0].evidence }] }).engineering, 'pass');
    assert.ok(gateProblems({ ...base, defects: [{ ...base.defects[0], severity, status: 'accepted', owner: 'someone' }] }).some((p) => p.includes('cannot be accepted')), `a ${severity} defect cannot be accepted away`);
  }
  assert.equal(verdictOf({ ...base, items: [{ ...base.items[0], status: 'open', note: 'n' }] }).engineering, 'fail', 'an item not shown fails it');
  for (const result of ['fail', 'cancelled', 'not-run'] as const) {
    assert.equal(verdictOf({ ...base, checks: [{ ...base.checks[0], result }] }).engineering, 'fail', `a required check ${result} fails it`);
    assert.equal(verdictOf({ ...base, checks: [{ ...base.checks[0], result, required: false }] }).engineering, 'pass');
  }
  assert.ok(gateProblems({ ...base, items: [{ ...base.items[0], evidence: [{ file: 'tests/server/readinessGate.test.ts', test: `no test is called this ${Date.now()}` }] }] }).some((p) => p.includes('no test called')), 'a cited test must exist');
  assert.ok(gateProblems({ ...base, defects: [{ ...base.defects[0], status: 'fixed' }] }).some((p) => p.includes('regression test')), 'a fix names its test');
});
