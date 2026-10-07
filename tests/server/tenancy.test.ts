import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { sweepExpiries } from '../../server/services/access.ts';
import { parseRoster, planSync, applySync } from '../../server/services/personnel.ts';

/**
 * One central service, organizations as tenants, three tiers of authority (ADR-0006): an organization sees only
 * itself; Vantage staff see inside one only with its approval, read-only, for a while; organization roles run the
 * structure without reading records; and every grant can be explained and can end on a date.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let g1lead: { token: string; id: string };
let helper: { token: string; id: string };
let rivera: { token: string; id: string };
let nguyen: { token: string; id: string };
const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  rivera = await app.register('rivera');
  nguyen = await app.register('nguyen');
  await enroll(app, op.token, 'G8', rivera.id);
  await enroll(app, op.token, 'G8', nguyen.id);
  rivera.token = await login('rivera');
  nguyen.token = await login('nguyen');
  const shared = await post(rivera.token, '/api/records/activities', { title: 'Reconciled 12 ULOs', visibility: 'unit', unit_id: 'G8', date: '2026-09-01' });
  assert.equal(shared.status, 201, JSON.stringify(shared.body));

  // A second organization, set up by Vantage with its own first owner.
  g1lead = await app.register('gonelead');
  const made = await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  g1lead.token = await login('gonelead');

  // A Vantage support account (staff sign in with a second factor; the test flag is lifted again to sign in).
  helper = await app.register('helper');
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(helper.id);
  assert.equal((await post(op.token, '/api/platform/staff', { user_id: helper.id, role: 'support' })).status, 201);
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(helper.id);
  helper.token = await login('helper');
});
after(async () => { await app.close(); });

test('an organization sees only itself, and a platform role confers nothing inside one', async () => {
  assert.equal((await get(g1lead.token, '/api/orgs/G1/overview')).status, 200);
  assert.equal((await get(g1lead.token, '/api/orgs/G8/overview')).status, 404, 'another organization is not found, not forbidden');
  assert.equal((await get(g1lead.token, '/api/org/units/G8/dashboard')).status, 403);
  assert.equal((await get(op.token, '/api/orgs/G1/overview')).status, 404, 'a platform owner holds no role in an organization it does not belong to');
  assert.equal((await get(op.token, '/api/org/units/G1/dashboard')).status, 403);
  const list = await get(g1lead.token, '/api/orgs');
  assert.deepEqual(list.body.organizations.map((o: { id: string }) => o.id), ['G1']);
  // The platform sees organizations as containers: names, counts, owners. Never their content.
  const seen = await get(op.token, '/api/platform/orgs/G8');
  assert.equal(seen.status, 200);
  assert.ok(seen.body.counts.members >= 3);
  assert.doesNotMatch(JSON.stringify(seen.body), /Reconciled 12 ULOs/);
  assert.equal((await get(rivera.token, '/api/platform/overview')).body.code, 'not_staff');
});

test('Vantage support reads nothing in an organization until its owners approve, read-only, until they end it', async () => {
  assert.equal((await get(helper.token, '/api/org/units/G8/dashboard')).status, 403);
  assert.equal((await post(helper.token, '/api/platform/access', { org_id: 'G8', reason: 'short' })).status, 400, 'a reason the owners can judge');
  const asked = await post(helper.token, '/api/platform/access', { org_id: 'G8', reason: 'Ticket 42: the G8 totals look wrong', minutes: 60 });
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  assert.equal(asked.body.status, 'pending');
  assert.equal((await post(helper.token, '/api/platform/access', { org_id: 'G8', reason: 'Ticket 42: asking twice' })).status, 409);
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE 'Vantage support asks to look%'").get(op.id), 'the owners are asked');
  assert.equal((await get(helper.token, '/api/org/units/G8/dashboard')).status, 403, 'asking is not access');
  assert.equal((await post(g1lead.token, `/api/orgs/G8/access/${asked.body.id}/approve`)).status, 404, 'another organization cannot approve it');

  const approved = await post(op.token, `/api/orgs/G8/access/${asked.body.id}/approve`, { note: 'Look at September only.' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, 'active');
  const dash = await get(helper.token, '/api/org/units/G8/dashboard');
  assert.equal(dash.status, 200, 'approved: the unit and its shared work');
  assert.equal((await get(helper.token, `/api/org/team/${rivera.id}`)).status, 403, 'never member detail');
  const write = await post(helper.token, '/api/records/activities', { title: 'Staff edit', visibility: 'unit', unit_id: 'G8' });
  assert.ok(write.status >= 400, `never changes (got ${write.status})`);
  const me = (await get(helper.token, '/api/me')).body;
  assert.equal(me.vantageAccess.length, 1, 'the staff member is shown what they hold and until when');

  assert.equal((await post(op.token, `/api/orgs/G8/access/${asked.body.id}/revoke`)).status, 200);
  assert.equal((await get(helper.token, '/api/org/units/G8/dashboard')).status, 403, 'revoked: gone at once');

  const orgTrail = (await get(op.token, '/api/orgs/G8/audit?limit=200')).body.rows.map((r: { action: string }) => r.action);
  for (const action of ['vantage_access_requested', 'vantage_access_approved', 'vantage_access_revoked']) assert.ok(orgTrail.includes(action), `${action} is in the organization’s trail`);
  const platformTrail = (await get(op.token, '/api/platform/audit?limit=500')).body.rows.map((r: { action: string }) => r.action);
  assert.ok(platformTrail.includes('vantage_access_approved'), 'and in the platform’s');
  assert.ok(!platformTrail.includes('create_record') && !platformTrail.includes('grant_role'), 'the platform’s trail holds none of an organization’s internal actions');
});

test('an organization that chose to be told rather than asked gives access at once, and it ends on its own', async () => {
  assert.equal((await app.call('PATCH', '/api/orgs/G1', { token: g1lead.token, body: { settings: { vantageAccess: 'notify' } } })).status, 200);
  const asked = await post(helper.token, '/api/platform/access', { org_id: 'G1', reason: 'Ticket 43: sign-in trouble for the S-1', minutes: 30 });
  assert.equal(asked.body.status, 'active');
  assert.equal((await get(helper.token, '/api/org/units/G1/dashboard')).status, 200);
  app.ctx.db.prepare("UPDATE access_grants SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(asked.body.id);
  assert.equal((await get(helper.token, '/api/org/units/G1/dashboard')).status, 403, 'expired access confers nothing, even before the sweep');
  assert.equal(sweepExpiries(app.ctx).accessExpired, 1);
  assert.equal((app.ctx.db.prepare('SELECT status FROM access_grants WHERE id = ?').get(asked.body.id) as { status: string }).status, 'expired');
});

test('organization administrators staff the units without reading records, and cannot hand themselves a role that does', async () => {
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: g1lead.id, role: 'admin' })).status, 400, 'organization roles go to its members');
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: op.id, role: 'admin' })).body.code, 'self_grant');
  const made = await post(op.token, '/api/orgs/G8/roles', { user_id: rivera.id, role: 'admin' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  rivera.token = await login('rivera');

  assert.equal((await get(rivera.token, '/api/orgs/G8/members')).status, 200);
  assert.equal((await post(rivera.token, '/api/orgs/G8/roles', { user_id: nguyen.id, role: 'admin' })).status, 403, 'naming organization roles is the owners’');
  const self = await post(rivera.token, `/api/org/team/${rivera.id}/roles`, { role_id: 'G8:snco', unit_id: 'G8' });
  assert.equal(self.status, 403);
  assert.equal(self.body.code, 'self_grant');
  const other = await post(rivera.token, `/api/org/team/${nguyen.id}/roles`, { role_id: 'G8:snco', unit_id: 'G8' });
  assert.equal(other.status, 200, 'staffing someone else is the job, whatever the role carries');
  const exported = await get(rivera.token, '/api/orgs/G8/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.body.activities, undefined, 'the organization export is its structure, not its records');
  assert.doesNotMatch(JSON.stringify(exported.body), /Reconciled 12 ULOs/);
  assert.equal((await app.call('DELETE', `/api/orgs/G8/roles/${op.id}/owner`, { token: op.token })).body.code, 'last_owner');
});

test('an administrator finds no side door into records: leading a unit, their own join code, widening a role they hold, removing an owner', async () => {
  rivera.token = await login('rivera');
  const lead = await post(rivera.token, '/api/orgs/G8/units/G8/leader', { user_id: rivera.id });
  assert.equal(lead.status, 403, JSON.stringify(lead.body));
  assert.equal(lead.body.code, 'self_grant');
  const team = await post(rivera.token, '/api/org/units', { name: 'Side Door Cell', parent_id: 'G8' });
  assert.equal(team.status, 201, 'structure is theirs to run');
  assert.equal((await post(rivera.token, `/api/org/units/${team.body.id}/owner`, { user_id: rivera.id })).status >= 400, true, 'nor through a leadership transfer');

  const code = await post(rivera.token, `/api/org/units/${team.body.id}/join-codes`, { role_id: `${team.body.id}:snco` });
  assert.equal(code.status, 201, 'a join code for someone else is staffing');
  const self = await post(rivera.token, `/api/org/join-codes/${encodeURIComponent(code.body.code)}/join`);
  assert.equal(self.status, 403, 'redeeming it themselves is not');
  assert.equal(self.body.code, 'self_grant');
  assert.equal(app.ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(rivera.id, team.body.id), undefined, 'and nothing was half-done');

  const marineRole = app.ctx.db.prepare("SELECT permissions FROM roles WHERE id = 'G8:marine'").get() as { permissions: number };
  const widen = await app.call('PUT', '/api/org/roles/G8:marine', { token: rivera.token, body: { permissions: marineRole.permissions | (1 << 2) } });
  assert.equal(widen.status, 403, 'widening a role they hold to read member detail is giving it to themselves');
  assert.equal((app.ctx.db.prepare("SELECT permissions FROM roles WHERE id = 'G8:marine'").get() as { permissions: number }).permissions, marineRole.permissions);

  const kick = await app.call('DELETE', `/api/orgs/G8/members/${op.id}`, { token: rivera.token });
  assert.equal(kick.status, 403, 'an administrator does not remove an owner from the organization');
});

test('an owner giving themselves a role that reads records is allowed, and the other owners are told', async () => {
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: nguyen.id, role: 'owner' })).status, 201);
  nguyen.token = await login('nguyen');
  app.ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?').run(nguyen.id, 'G8:snco');
  const self = await post(nguyen.token, `/api/org/team/${nguyen.id}/roles`, { role_id: 'G8:snco', unit_id: 'G8' });
  assert.equal(self.status, 200, JSON.stringify(self.body));
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%gave themselves SNCO%'").get(op.id));
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%gave themselves SNCO%'").get(nguyen.id), undefined);
  assert.equal((await app.call('DELETE', `/api/orgs/G8/roles/${nguyen.id}/owner`, { token: op.token })).status, 200);
});

test('a role granted until a date ends on that date, and the trail says so', async () => {
  const until = new Date(Date.now() + 86_400_000).toISOString();
  const granted = await post(op.token, `/api/org/team/${rivera.id}/roles`, { role_id: 'G8:nco', unit_id: 'G8', expires_at: until });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  assert.equal(granted.body.expires_at, until);
  assert.equal((await post(op.token, `/api/org/team/${rivera.id}/roles`, { role_id: 'G8:nco', unit_id: 'G8', expires_at: '2001-01-01' })).status, 400);
  rivera.token = await login('rivera');
  const has = () => app.ctx.db.prepare('SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = ?').get(rivera.id, 'G8:nco');
  const holds = async () => (await get(rivera.token, '/api/me')).body.roles.some((r: { id: string }) => r.id === 'G8:nco');
  assert.ok(await holds());
  app.ctx.db.prepare("UPDATE member_roles SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ? AND role_id = ?").run(rivera.id, 'G8:nco');
  assert.equal(await holds(), false, 'past its date it confers nothing');
  assert.ok(has());
  assert.equal(sweepExpiries(app.ctx).unitRoles, 1);
  assert.equal(has(), undefined);
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'role_expired' AND subject_id = ?").get(rivera.id));
});

test('“why can they?” names every grant behind a person’s authority', async () => {
  const why = await get(op.token, `/api/orgs/G8/members/${nguyen.id}/why`);
  assert.equal(why.status, 200, JSON.stringify(why.body));
  const g8 = why.body.units.find((u: { unitId: string }) => u.unitId === 'G8');
  const kinds = g8.sources.map((s: { kind: string }) => s.kind);
  assert.ok(kinds.includes('role'));
  assert.ok(g8.sources.some((s: { role: string | null }) => s.role === 'SNCO'));
  assert.equal(g8.readsRecords, true);
  const admin = await get(op.token, `/api/orgs/G8/members/${rivera.id}/why`);
  const org = admin.body.units.find((u: { unitId: string }) => u.unitId === 'G8').sources.find((s: { kind: string }) => s.kind === 'org');
  assert.ok(org, 'organization administration is named as a source');
  assert.match(org.label, /never its records/);
  assert.equal((await get(g1lead.token, `/api/orgs/G8/members/${nguyen.id}/why`)).status, 404);
  nguyen.token = await login('nguyen');
  assert.equal((await get(nguyen.token, `/api/org/team/${nguyen.id}/why`)).status, 200, 'anyone can ask about themselves');
});

test('one organization’s roster speaks only for its own people', async () => {
  app.ctx.db.prepare("UPDATE users SET edipi = '5100000001', rank_id = 'LCpl' WHERE id = ?").run(rivera.id);
  const rows = ['EDIPI,Last,First,Grade,Status', '5100000001,Marine,Rivera,GySgt,Active', '5100000002,Other,Pat,Cpl,Active'].join('\n');
  const parsed = parseRoster(rows);
  applySync(app.ctx, planSync(app.ctx, 'G1', parsed.rows, 'MCTFS', parsed.rejected), g1lead.id);
  assert.equal((app.ctx.db.prepare('SELECT rank_id FROM users WHERE id = ?').get(rivera.id) as { rank_id: string }).rank_id, 'LCpl', 'G-1’s extract does not change a G-8 Marine');
  const gone = parseRoster('EDIPI,Last,First,Grade,Status\n5100000002,Other,Pat,Cpl,Active');
  applySync(app.ctx, planSync(app.ctx, 'G1', gone.rows, 'MCTFS', gone.rejected), g1lead.id);
  assert.equal((app.ctx.db.prepare('SELECT active FROM users WHERE id = ?').get(rivera.id) as { active: number }).active, 1, 'nor separate one');
});

test('Vantage support cannot take over a platform owner’s sign-in', async () => {
  const res = await post(helper.token, `/api/platform/accounts/${op.id}/temporary-password`);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'staff_account');
  assert.equal((await post(helper.token, `/api/platform/accounts/${rivera.id}/unlock`)).status, 200, 'an ordinary account they can help');
  assert.equal((await get(helper.token, '/api/platform/backup')).status, 403, 'and the service’s data is not support’s');
});
