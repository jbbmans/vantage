import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import {
  ORG_ROLES, ORG_ROLE_KEYS, PLATFORM_ROLES, PLATFORM_ROLE_KEYS, PERMISSIONS, PERMISSION_LIST, ORG_STRUCTURE_BITS, ORG_STRUCTURE_GRANTS,
  RECORD_READING_BITS, UNIT_MANAGER_ROLES, VANTAGE_ADMINISTRATOR_ROLES, orgStructureBits, seniorOrgRoleLabel, seniorPlatformRoleLabel,
  type OrgPermission, type OrgRole, type PlatformPermission, type PlatformRole,
} from '../../shared/permissions.ts';
import { addMember, removeMember } from '../../server/services/org.ts';
import { orgCounts } from '../../server/services/organizations.ts';
import { provisionUnitInstance } from '../../server/services/provisioning.ts';

/**
 * Vantage Administrator and Unit Manager (ADR-0010): explicit roles, granular permissions checked by the server, Unit
 * Managers scoped to the Unit Instances they are assigned to and only while they belong to them, and nobody, at either
 * tier, elevating themselves.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person & { unitId: string };
const org: Partial<Record<OrgRole, Person>> = {};
const staff: Partial<Record<PlatformRole, Person>> = {};
let marine: Person;
let g1lead: Person;
const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;

/** A G8 member holding one Unit Instance role, granted by the Lead Unit Manager who set Vantage up. */
async function orgRoleHolder(username: string, role: OrgRole) {
  const person = await app.register(username);
  await enroll(app, op.token, 'G8', person.id);
  const granted = await post(op.token, '/api/orgs/G8/roles', { user_id: person.id, role });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  return { id: person.id, token: await login(username) };
}

/** Vantage staff sign in with a second factor; the test flag is lifted again to sign in. */
async function staffMember(username: string, role: PlatformRole) {
  const person = await app.register(username);
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(person.id);
  const granted = await post(op.token, '/api/platform/staff', { user_id: person.id, role });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  app.ctx.db.prepare('UPDATE users SET totp_enabled = 0 WHERE id = ?').run(person.id);
  return { id: person.id, token: await login(username) };
}

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  org.owner = await orgRoleHolder('leadum', 'owner');
  org.admin = await orgRoleHolder('unitmgr', 'admin');
  org.records = await orgRoleHolder('recoff', 'records');
  org.auditor = await orgRoleHolder('unitaud', 'auditor');
  marine = await app.register('plainmarine');
  await enroll(app, op.token, 'G8', marine.id);
  marine.token = await login('plainmarine');
  staff.owner = op;
  staff.admin = await staffMember('vadmin', 'admin');
  staff.support = await staffMember('vsupport', 'support');
  staff.auditor = await staffMember('vauditor', 'auditor');
  // A second Unit Instance, with its own Lead Unit Manager.
  g1lead = await app.register('gonelead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('gonelead');
});
after(async () => { await app.close(); });

test('the roles are explicit: no role is called just owner or admin, and full unit authority is not a manager role', () => {
  const labels = [...ORG_ROLE_KEYS.map((r) => ORG_ROLES[r].label), ...PLATFORM_ROLE_KEYS.map((r) => PLATFORM_ROLES[r].label)];
  assert.equal(new Set(labels).size, labels.length, 'every role has a name of its own');
  for (const label of labels) assert.doesNotMatch(label, /^(owner|admin|administrator)$/i, label);
  assert.equal(ORG_ROLES.owner.label, 'Lead Unit Manager');
  assert.equal(ORG_ROLES.admin.label, 'Unit Manager');
  assert.equal(PLATFORM_ROLES.owner.label, 'Lead Vantage Administrator');
  assert.equal(PLATFORM_ROLES.admin.label, 'Vantage Administrator');
  assert.deepEqual([...UNIT_MANAGER_ROLES], ['owner', 'admin']);
  assert.deepEqual([...VANTAGE_ADMINISTRATOR_ROLES], ['owner', 'admin']);
  assert.equal(PERMISSION_LIST.find((p) => p.key === 'ADMINISTRATOR')?.label, 'Full unit authority');
  assert.equal(seniorOrgRoleLabel(['auditor', 'admin']), 'Unit Manager');
  assert.equal(seniorPlatformRoleLabel(['support', 'owner']), 'Lead Vantage Administrator');
  assert.equal(seniorOrgRoleLabel([]), null);
});

test('Unit Instance permissions confer structure, mapped one to one, and never a bit that reads records', () => {
  for (const [permission, bit] of Object.entries(ORG_STRUCTURE_GRANTS)) assert.equal((bit as number) & RECORD_READING_BITS, 0, permission);
  assert.equal(ORG_STRUCTURE_BITS & RECORD_READING_BITS, 0);
  assert.equal(orgStructureBits(ORG_ROLES.owner.permissions), ORG_STRUCTURE_BITS);
  assert.equal(orgStructureBits(ORG_ROLES.admin.permissions), ORG_STRUCTURE_BITS, 'a Unit Manager staffs units as a Lead Unit Manager does');
  assert.equal(orgStructureBits(ORG_ROLES.records.permissions), 0, 'a Records Officer has no structural reach');
  assert.equal(orgStructureBits(ORG_ROLES.auditor.permissions), 0);
  assert.equal(orgStructureBits(['org.members']), PERMISSIONS.MANAGE_MEMBERS | PERMISSIONS.VIEW_UNIT);
});

test('every Unit Instance role opens exactly the console routes its permissions name, and only in its own Unit Instance', async () => {
  const routes: Array<[string, OrgPermission[]]> = [
    ['/overview', ['org.view']],
    ['/roles', ['org.view']],
    ['/units', ['org.view']],
    ['/members', ['org.members', 'org.owners', 'org.roles']],
    ['/personnel', ['org.personnel']],
    ['/retention', ['org.retention', 'org.holds']],
    ['/privacy/inventory', ['org.privacy']],
    ['/audit', ['org.audit']],
    ['/export', ['org.export']],
    ['/access', ['org.access', 'org.audit']],
  ];
  for (const role of ORG_ROLE_KEYS) {
    const holder = org[role]!;
    for (const [path, needs] of routes) {
      const allowed = needs.some((p) => ORG_ROLES[role].permissions.includes(p));
      const res = await get(holder.token, `/api/orgs/G8${path}`);
      assert.equal(res.status, allowed ? 200 : 403, `${ORG_ROLES[role].label} ${path}: ${JSON.stringify(res.body).slice(0, 160)}`);
      if (!allowed) assert.equal(res.body.code, 'org_permission');
      assert.equal((await get(holder.token, `/api/orgs/G1${path}`)).status, 404, `${ORG_ROLES[role].label} in another Unit Instance ${path}`);
    }
  }
  for (const [path] of routes) assert.equal((await get(marine.token, `/api/orgs/G8${path}`)).status, 404, `a member with no Unit Instance role ${path}`);
  // Writes follow the same permissions: assigning Unit Instance roles is a Lead Unit Manager's alone.
  const assign = await post(org.admin!.token, '/api/orgs/G8/roles', { user_id: marine.id, role: 'auditor' });
  assert.equal(assign.status, 403);
  assert.equal(assign.body.code, 'org_permission');
  assert.equal((await post(org.records!.token, '/api/orgs/G8/units/G8/leader', { user_id: marine.id })).status, 403, 'a Records Officer names no leader');
  assert.equal((await post(org.owner!.token, '/api/orgs/G8/roles', { user_id: g1lead.id, role: 'admin' })).status, 400, 'a role goes only to a member of the Unit Instance');
});

test('every Vantage staff role opens exactly the console routes its permissions name; Unit Managers open none', async () => {
  const routes: Array<[string, PlatformPermission]> = [
    ['/overview', 'platform.view'],
    ['/orgs', 'platform.view'],
    ['/staff', 'platform.view'],
    ['/access', 'platform.view'],
    ['/accounts', 'platform.accounts'],
    ['/audit', 'platform.audit'],
    ['/usage', 'platform.usage'],
    ['/email', 'platform.email'],
    ['/holds', 'platform.data'],
  ];
  for (const role of PLATFORM_ROLE_KEYS) {
    const holder = staff[role]!;
    for (const [path, needs] of routes) {
      const allowed = PLATFORM_ROLES[role].permissions.includes(needs);
      const res = await get(holder.token, `/api/platform${path}`);
      assert.equal(res.status, allowed ? 200 : 403, `${PLATFORM_ROLES[role].label} ${path}: ${JSON.stringify(res.body).slice(0, 160)}`);
    }
  }
  for (const role of ORG_ROLE_KEYS) {
    const res = await get(org[role]!.token, '/api/platform/overview');
    assert.equal(res.status, 403, ORG_ROLES[role].label);
    assert.equal(res.body.code, 'not_staff');
    assert.equal((await app.call('PUT', '/api/platform/runtime', { token: org[role]!.token, body: { selfServiceUnits: true } })).body.code, 'not_staff', 'enterprise settings are out of reach');
  }
  // A platform role confers nothing inside a Unit Instance: a Vantage Administrator holds no Unit Instance role in G8.
  for (const role of ['admin', 'support', 'auditor'] as PlatformRole[]) {
    assert.equal((await get(staff[role]!.token, '/api/orgs/G8/overview')).status, 404, PLATFORM_ROLES[role].label);
    assert.equal((await get(staff[role]!.token, '/api/org/units/G8/dashboard')).status, 403, PLATFORM_ROLES[role].label);
  }
});

test('a Unit Manager cannot elevate themselves through any door', async () => {
  const um = org.admin!;
  const lum = org.owner!;
  // Unit Instance roles: their own are another Lead Unit Manager's to change.
  assert.equal((await post(um.token, '/api/orgs/G8/roles', { user_id: um.id, role: 'owner' })).body.code, 'org_permission');
  assert.equal((await post(lum.token, '/api/orgs/G8/roles', { user_id: lum.id, role: 'records' })).body.code, 'self_grant');
  assert.equal((await post(lum.token, '/api/orgs/G8/roles', { user_id: lum.id, role: 'owner', expires_at: null })).body.code, 'self_grant', 'nor extend their own');

  // Unit roles that read records, for a Unit Manager and a Lead Unit Manager alike.
  for (const [who, name] of [[um, 'unitmgr'], [lum, 'leadum']] as const) {
    const self = await post(who.token, `/api/org/team/${who.id}/roles`, { role_id: 'G8:snco', unit_id: 'G8' });
    assert.equal(self.status, 403, `${name}: ${JSON.stringify(self.body)}`);
    assert.equal(self.body.code, 'self_grant');
    assert.equal(app.ctx.db.prepare("SELECT 1 FROM member_roles WHERE user_id = ? AND role_id = 'G8:snco'").get(who.id), undefined, 'nothing was written');
  }
  // Leading a unit reads its records: naming yourself, or taking it by transfer, is refused.
  const sub = await post(um.token, '/api/org/units', { name: 'Budget Cell', code: 'G8BC', parent_id: 'G8' });
  assert.equal(sub.status, 201, JSON.stringify(sub.body));
  assert.equal(sub.body.owner_user_id, null, 'a unit made through Unit Instance authority is led from above');
  assert.equal((await post(um.token, '/api/orgs/G8/units/G8BC/leader', { user_id: um.id })).body.code, 'self_grant');
  assert.equal((await post(lum.token, '/api/orgs/G8/units/G8BC/leader', { user_id: lum.id })).body.code, 'self_grant');
  addMember(app.ctx, um.id, 'G8BC', { invitedBy: null });
  assert.equal((await post(um.token, '/api/org/units/G8BC/owner', { user_id: um.id })).body.code, 'self_grant');
  assert.equal((await post(um.token, '/api/orgs/G8/units/G8BC/leader', { user_id: marine.id })).status, 200, 'naming someone else is the job');
  // Their own join code for a role that reads records.
  assert.equal((await post(um.token, '/api/org/units', { name: 'Disbursing Cell', code: 'G8DC', parent_id: 'G8' })).status, 201);
  const code = await post(um.token, '/api/org/units/G8DC/join-codes', { role_id: 'G8DC:snco' });
  assert.equal(code.status, 201, JSON.stringify(code.body));
  assert.equal((await post(um.token, `/api/org/join-codes/${encodeURIComponent(code.body.code)}/join`)).body.code, 'self_grant');
  // Widening a role they hold.
  const marineRole = app.ctx.db.prepare("SELECT permissions FROM roles WHERE id = 'G8:marine'").get() as { permissions: number };
  const widen = await app.call('PUT', '/api/org/roles/G8:marine', { token: lum.token, body: { permissions: marineRole.permissions | PERMISSIONS.VIEW_RECORDS } });
  assert.equal(widen.status, 403, JSON.stringify(widen.body));
  assert.equal(widen.body.code, 'self_grant');
  // The Vantage-access policy is a Lead Unit Manager's, not a Unit Manager's.
  assert.equal((await app.call('PATCH', '/api/orgs/G8', { token: um.token, body: { settings: { vantageAccess: 'notify' } } })).status, 403);
});

test('a Vantage Administrator never names themselves a Lead Unit Manager, and founds nothing they then run', async () => {
  const va = staff.admin!;
  const self = await post(va.token, '/api/platform/orgs', { name: 'MARFORRES G-2', code: 'G2', owner_user_id: va.id });
  assert.equal(self.status, 403);
  assert.equal(self.body.code, 'self_grant');
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM organizations WHERE id = 'G2'").get(), undefined, 'nothing was made');
  assert.equal((await post(va.token, '/api/platform/orgs', { name: 'MARFORRES G-2', code: 'G2' })).status, 201);
  assert.equal((await post(va.token, '/api/platform/orgs/G2/owner', { user_id: va.id })).body.code, 'self_grant');
  assert.equal((await get(va.token, '/api/orgs/G2/overview')).status, 404, 'creating one gives its creator no role in it');

  // The person the command designated, from outside the Unit Instance, is seated in its top unit to hold the role.
  const designated = await app.register('g2lead');
  const named = await post(va.token, '/api/platform/orgs/G2/owner', { user_id: designated.id });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = 'G2'").get(designated.id));
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM org_roles WHERE org_id = 'G2' AND user_id = ? AND role = 'owner'").get(designated.id));
  assert.equal((await get(await login('g2lead'), '/api/orgs/G2/overview')).status, 200);
  const another = await post(va.token, '/api/platform/orgs/G2/owner', { user_id: marine.id });
  assert.equal(another.status, 409, 'one that has a Lead Unit Manager names its own');

  // From a manifest too, dry run included, and nothing is made.
  for (const dryRun of [true, false]) {
    assert.throws(() => provisionUnitInstance(app.ctx, { id: va.id }, { name: 'MARFORRES G-3', code: 'G3', manager: 'vadmin' }, { dryRun }), /never names themselves/);
  }
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM organizations WHERE id = 'G3'").get(), undefined);

  // The app's top-level unit is no way around it once self-service is off.
  assert.equal((await app.call('PUT', '/api/platform/runtime', { token: op.token, body: { selfServiceUnits: false } })).status, 200);
  try {
    const founded = await post(va.token, '/api/org/units', { name: 'Admin Command', code: 'ADMCMD' });
    assert.equal(founded.status, 403);
    assert.equal(founded.body.code, 'org_creation_closed');
  } finally {
    await app.call('PUT', '/api/platform/runtime', { token: op.token, body: { selfServiceUnits: true } });
  }
});

test('a Unit Instance role lasts only while its holder belongs to the Unit Instance', async () => {
  const leaver = await orgRoleHolder('leaver', 'admin');
  assert.equal((await get(leaver.token, '/api/orgs/G8/overview')).status, 200);
  // A move within the Unit Instance keeps it.
  const moved = await post(op.token, `/api/org/units/G8/members/${leaver.id}/move`, { to: 'G8BC' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal((await get(await login('leaver'), '/api/orgs/G8/overview')).status, 200, 'still a member, still a Unit Manager');
  // Taking a role holder out of their last unit ends the role, so it is a Lead Unit Manager's to do.
  const byUm = await app.call('DELETE', `/api/orgs/G8/members/${leaver.id}`, { token: org.admin!.token });
  assert.equal(byUm.status, 403);
  assert.equal(byUm.body.code, 'org_permission');
  const byLum = await app.call('DELETE', `/api/orgs/G8/members/${leaver.id}`, { token: org.owner!.token });
  assert.equal(byLum.status, 200, JSON.stringify(byLum.body));
  assert.equal(app.ctx.db.prepare("SELECT 1 FROM org_roles WHERE org_id = 'G8' AND user_id = ?").get(leaver.id), undefined);
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'org_role_ended' AND subject_id = ?").get(leaver.id), 'and the ending is audited');
  assert.equal((await get(await login('leaver'), '/api/orgs/G8/overview')).status, 404);

  // A roster separation leaves it dormant: it confers nothing and counts for nothing, and returns if the feed restores them.
  const separated = await orgRoleHolder('separated', 'owner');
  const owners = orgCounts(app.ctx, 'G8').owners;
  removeMember(app.ctx, separated.id, 'G8', op.id, 'roster_separation', { endInstanceRoles: false });
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM org_roles WHERE org_id = 'G8' AND user_id = ? AND role = 'owner'").get(separated.id), 'the row stays');
  assert.equal((await get(await login('separated'), '/api/orgs/G8/overview')).status, 404, 'but confers nothing');
  assert.equal(orgCounts(app.ctx, 'G8').owners, owners - 1, 'and is not counted as a Lead Unit Manager');
  const listed = await get(op.token, '/api/platform/orgs');
  const g8 = listed.body.organizations.find((o: { id: string }) => o.id === 'G8');
  assert.ok(!g8.owners.some((p: { id: string }) => p.id === separated.id), 'nor shown as one to Vantage');
  addMember(app.ctx, separated.id, 'G8', { invitedBy: null });
  assert.equal((await get(await login('separated'), '/api/orgs/G8/overview')).status, 200, 'restored with them');
  assert.equal((await app.call('DELETE', `/api/orgs/G8/roles/${separated.id}/owner`, { token: op.token })).status, 200);
});

test('the last Lead Unit Manager is never removed out from under the Unit Instance', async () => {
  // G1 has one Lead Unit Manager, who leads its top unit. A second member is made Lead Unit Manager, and the first steps down.
  const second = await app.register('gonesecond');
  addMember(app.ctx, second.id, 'G1', { invitedBy: g1lead.id });
  assert.equal((await post(g1lead.token, '/api/orgs/G1/roles', { user_id: second.id, role: 'owner' })).status, 201);
  assert.equal((await app.call('DELETE', `/api/orgs/G1/roles/${g1lead.id}/owner`, { token: g1lead.token })).status, 200, 'giving one up reduces authority, so it needs nobody else');
  const secondToken = await login('gonesecond');
  g1lead.token = await login('gonelead');
  // The only Lead Unit Manager left cannot give up the role, nor leave the Unit Instance and take it with them.
  const drop = await app.call('DELETE', `/api/orgs/G1/roles/${second.id}/owner`, { token: secondToken });
  assert.equal(drop.body.code, 'last_owner');
  const leave = await app.call('DELETE', `/api/org/units/G1/members/${second.id}`, { token: secondToken });
  assert.equal(leave.status, 400, JSON.stringify(leave.body));
  assert.equal(leave.body.code, 'last_owner');
  // The unit's leader, who holds no Unit Instance role now, cannot take a Lead Unit Manager out of it either.
  const remove = await app.call('DELETE', `/api/org/units/G1/members/${second.id}`, { token: g1lead.token });
  assert.equal(remove.status, 403, JSON.stringify(remove.body));
  assert.equal(remove.body.code, 'org_permission');
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM org_roles WHERE org_id = 'G1' AND user_id = ? AND role = 'owner'").get(second.id));
  assert.ok(app.ctx.db.prepare("SELECT 1 FROM unit_members WHERE unit_id = 'G1' AND user_id = ?").get(second.id));

  // Nor archive the one sub-unit they lead and belong to, which would take them out of it the same way.
  assert.equal((await post(g1lead.token, '/api/org/units', { name: 'G-1 Shop', code: 'G1S', parent_id: 'G1' })).status, 201);
  removeMember(app.ctx, g1lead.id, 'G1S', g1lead.id, 'left', { endInstanceRoles: false });
  addMember(app.ctx, second.id, 'G1S', { invitedBy: g1lead.id });
  removeMember(app.ctx, second.id, 'G1', g1lead.id, 'transfer', { endInstanceRoles: false });
  app.ctx.db.prepare("UPDATE units SET owner_user_id = ? WHERE id = 'G1S'").run(second.id);
  const archive = await app.call('DELETE', '/api/org/units/G1S', { token: await login('gonesecond') });
  assert.equal(archive.status, 400, JSON.stringify(archive.body));
  assert.equal(archive.body.code, 'last_owner');
  assert.equal((app.ctx.db.prepare("SELECT active FROM units WHERE id = 'G1S'").get() as { active: number }).active, 1);
});
