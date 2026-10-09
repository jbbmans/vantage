import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { ORG_ROLES, ORG_ROLE_KEYS, type OrgRole } from '../../shared/permissions.ts';
import { DEFAULT_UNIT_SETTINGS, STANDARD_DUTY_TYPES, UNIT_CONFIG_FORMAT, UNIT_SETTING_LIMITS, normalizeUnitSettings } from '../../shared/unitConfig.ts';
import { releaseStaleClaims } from '../../server/services/work.ts';

/**
 * The Unit Manager console (Task 6, ADR-0012): unit-scoped configuration that a Unit Instance's own Unit Managers run
 * (billets, duty types, training requirements, work settings and report defaults), its audit trail, roster and
 * configuration exports, and configuration imports. Each is checked by the server against the caller's Unit Instance
 * permissions, stays inside its Unit Instance, is audited there, and never goes past what Vantage sets for everyone.
 */

type Person = { token: string; id: string };
let app: TestApp;
let op: Person & { unitId: string };
const org: Partial<Record<OrgRole, Person>> = {};
let marine: Person;
let g1lead: Person;
const call = (method: string, token: string, path: string, body?: unknown) => app.call(method, path, { token, body });
const get = (token: string, path: string) => call('GET', token, path);
const post = (token: string, path: string, body: unknown = {}) => call('POST', token, path, body);
const patch = (token: string, path: string, body: unknown = {}) => call('PATCH', token, path, body);
const login = async (username: string) => (await app.login(username)).body.token as string;
const lastAudit = (action: string) => app.ctx.db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY seq DESC LIMIT 1').get(action) as Record<string, any> | undefined;

async function orgRoleHolder(username: string, role: OrgRole) {
  const person = await app.register(username);
  await enroll(app, op.token, 'G8', person.id);
  const granted = await post(op.token, '/api/orgs/G8/roles', { user_id: person.id, role });
  assert.equal(granted.status, 201, JSON.stringify(granted.body));
  return { id: person.id, token: await login(username) };
}

before(async () => {
  app = await startApp({ VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' });
  op = await app.setupOperator();
  org.owner = op;
  org.admin = await orgRoleHolder('cfgmgr', 'admin');
  org.records = await orgRoleHolder('cfgrec', 'records');
  org.auditor = await orgRoleHolder('cfgaud', 'auditor');
  marine = await app.register('cfgmarine');
  await enroll(app, op.token, 'G8', marine.id);
  marine.token = await login('cfgmarine');
  g1lead = await app.register('cfgg1lead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: g1lead.id })).status, 201);
  g1lead.token = await login('cfgg1lead');
  // A section beneath G8, created the way the console creates one.
  const section = await post(org.admin!.token, '/api/org/units', { name: 'Budget Section', short_name: 'BUD', echelon: 'section', parent_id: 'G8' });
  assert.equal(section.status, 201, JSON.stringify(section.body));
});
after(async () => { await app.close(); });

test('every Unit Instance role reads and changes the configuration its permissions allow, only in its own Unit Instance', async () => {
  const reads: Array<[string, string[]]> = [
    ['/configuration', ['org.view']],
    ['/unit-roles', ['org.roles', 'org.members', 'org.owners']],
    ['/roster.csv', ['org.export']],
    ['/configuration/export', ['org.export']],
    ['/audit?limit=5', ['org.audit']],
    ['/audit/export?format=json', ['org.audit']],
  ];
  for (const role of ORG_ROLE_KEYS) {
    const holder = org[role]!;
    const perms = ORG_ROLES[role].permissions as string[];
    for (const [path, needs] of reads) {
      const allowed = needs.some((p) => perms.includes(p));
      const res = await get(holder.token, `/api/orgs/G8${path}`);
      assert.equal(res.status, allowed ? 200 : 403, `${ORG_ROLES[role].label} ${path}`);
      if (!allowed) assert.equal(res.body.code, 'org_permission');
      assert.equal((await get(holder.token, `/api/orgs/G1${path}`)).status, 404, `${ORG_ROLES[role].label} in another Unit Instance ${path}`);
    }
    // Writing configuration is org.config: Lead Unit Managers and Unit Managers, nobody else.
    const writes = await post(holder.token, '/api/orgs/G8/duty-types', { name: `Watch ${role}` });
    assert.equal(writes.status, perms.includes('org.config') ? 201 : 403, `${ORG_ROLES[role].label} adds a duty type`);
    const settings = await patch(holder.token, '/api/orgs/G8/configuration/settings', { reports: { defaultPeriod: 'month' } });
    assert.equal(settings.status, perms.includes('org.config') ? 200 : 403, `${ORG_ROLES[role].label} changes a setting`);
  }
  assert.deepEqual(ORG_ROLE_KEYS.filter((r) => (ORG_ROLES[r].permissions as string[]).includes('org.config')), ['owner', 'admin']);
  for (const [path] of reads) assert.equal((await get(marine.token, `/api/orgs/G8${path}`)).status, 404, `a Marine with no Unit Instance role ${path}`);
  assert.equal((await post(marine.token, '/api/orgs/G8/billets', { title: 'Self-appointed' })).status, 404);
});

test('a billet list: added, edited, retired and restored by a Unit Manager, each in the Unit Instance’s trail', async () => {
  const um = org.admin!.token;
  const added = await post(um, '/api/orgs/G8/billets', { title: 'Budget Analyst', code: '0105', unit_id: 'BUD' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.org_id, 'G8');
  assert.equal(added.body.unit_id, 'BUD');
  assert.equal(lastAudit('billet_created')?.org_id, 'G8');
  assert.equal(lastAudit('billet_created')?.unit_id, 'BUD');

  // One title per unit while it is in use, whatever its case.
  const twice = await post(um, '/api/orgs/G8/billets', { title: 'budget analyst', unit_id: 'BUD' });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, 'duplicate');
  assert.equal((await post(um, '/api/orgs/G8/billets', { title: 'Budget Analyst' })).status, 201, 'the same title for the whole Unit Instance is another billet');

  const edited = await patch(um, `/api/orgs/G8/billets/${added.body.id}`, { description: 'Prepares the budget' });
  assert.equal(edited.status, 200);
  assert.match(lastAudit('billet_updated')!.detail, /description: — → Prepares the budget/);
  const retired = await patch(um, `/api/orgs/G8/billets/${added.body.id}`, { active: false });
  assert.equal(retired.body.active, 0);
  assert.ok(lastAudit('billet_retired'));
  assert.equal((await patch(um, `/api/orgs/G8/billets/${added.body.id}`, { active: true })).body.active, 1);
  assert.ok(lastAudit('billet_restored'));
  const listed = await get(um, '/api/orgs/G8/configuration');
  assert.ok(listed.body.billets.some((b: { id: string }) => b.id === added.body.id));

  assert.equal((await post(um, '/api/orgs/G8/billets', { title: '   ' })).status, 400, 'a billet needs a title');
  assert.equal((await post(um, '/api/orgs/G8/billets', { title: 'x'.repeat(81) })).status, 400, 'titles are bounded');
});

test('configuration never reaches into another Unit Instance, at the API or in the database', async () => {
  const um = org.admin!.token;
  // A unit of another Unit Instance is refused without saying it exists.
  const foreign = await post(um, '/api/orgs/G8/billets', { title: 'Adjutant', unit_id: 'G1' });
  assert.equal(foreign.status, 400);
  assert.equal(foreign.body.error, 'No such unit in this Unit Instance.');
  assert.equal((await post(um, '/api/orgs/G8/billets', { title: 'Adjutant', unit_id: 'NOPE' })).body.error, 'No such unit in this Unit Instance.', 'the same answer as a unit that does not exist');
  assert.equal((await post(um, '/api/orgs/G8/training-requirements', { title: 'Annual Cyber Awareness', unit_id: 'G1' })).status, 400);

  // Another Unit Instance's Lead Unit Manager cannot read, change or even find G8's rows.
  const mine = await post(um, '/api/orgs/G8/training-requirements', { title: 'Fiscal Law', type: 'course', interval_months: 24 });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal((await patch(g1lead.token, `/api/orgs/G1/training-requirements/${mine.body.id}`, { active: false })).status, 404);
  assert.equal((await patch(g1lead.token, `/api/orgs/G8/training-requirements/${mine.body.id}`, { active: false })).status, 404);
  assert.ok(!(await get(g1lead.token, '/api/orgs/G1/configuration')).body.trainingRequirements.some((t: { id: string }) => t.id === mine.body.id));

  // The database refuses a row that pairs one Unit Instance with another's unit, whoever writes it.
  assert.throws(() => app.ctx.db.prepare("INSERT INTO unit_billets (id, org_id, unit_id, title, active, created_at, updated_at) VALUES ('x1', 'G8', 'G1', 'Smuggled', 1, '2026-01-01', '2026-01-01')").run(), /cross_instance/);
  assert.throws(() => app.ctx.db.prepare("UPDATE training_requirements SET unit_id = 'G1' WHERE id = ?").run(mine.body.id), /cross_instance/);
});

test('duty types: the standard list once, codes kept unique, retired rather than deleted', async () => {
  const um = org.admin!.token;
  const standard = await post(um, '/api/orgs/G8/duty-types/standard');
  assert.equal(standard.status, 200);
  assert.deepEqual(standard.body.added, STANDARD_DUTY_TYPES.map((d) => d.code));
  assert.deepEqual((await post(um, '/api/orgs/G8/duty-types/standard')).body.added, [], 'the second time adds nothing');
  const dnco = (await get(um, '/api/orgs/G8/configuration')).body.dutyTypes.find((d: { code: string }) => d.code === 'DNCO');
  const clash = await post(um, '/api/orgs/G8/duty-types', { name: 'Duty NCO', code: 'dnco' });
  assert.equal(clash.status, 409, 'a code is the Unit Instance’s once, in any case');
  assert.equal((await patch(um, `/api/orgs/G8/duty-types/${dnco.id}`, { active: false })).body.active, 0);
  assert.equal((await post(um, '/api/orgs/G8/duty-types', { name: 'Duty NCO', code: 'DNCO' })).status, 409, 'a retired code is restored, not taken again');
  const own = await post(um, '/api/orgs/G8/duty-types', { name: 'Staff Duty Officer' });
  assert.equal(own.body.code, 'STAFF-DUTY-OFFICER', 'a code comes from the name when none is given');
  // G1 has a list of its own.
  assert.equal((await get(g1lead.token, '/api/orgs/G1/configuration')).body.dutyTypes.length, 0);
});

test('training requirements: kinds and intervals are what Vantage records', async () => {
  const um = org.admin!.token;
  assert.equal((await post(um, '/api/orgs/G8/training-requirements', { title: 'Rifle Qualification', type: 'qualification', interval_months: 12, unit_id: 'BUD' })).status, 201);
  assert.equal((await post(um, '/api/orgs/G8/training-requirements', { title: 'Anything', type: 'hobby' })).status, 400);
  assert.equal((await post(um, '/api/orgs/G8/training-requirements', { title: 'Anything', interval_months: 0 })).status, 400);
  assert.equal((await post(um, '/api/orgs/G8/training-requirements', { title: 'Anything', interval_months: 121 })).status, 400);
  assert.equal((await post(um, '/api/orgs/G8/training-requirements', { title: 'rifle qualification', unit_id: 'BUD' })).status, 409);
});

test('work settings stay within the enterprise limits, and a claim lapses on its Unit Instance’s own clock', async () => {
  const um = org.admin!.token;
  const { min, max } = UNIT_SETTING_LIMITS.claimExpiryHours;
  for (const hours of [min - 1, max + 1, 12.5]) {
    const refused = await patch(um, '/api/orgs/G8/configuration/settings', { work: { claimExpiryHours: hours } });
    assert.equal(refused.status, 400, `${hours} hours`);
  }
  assert.equal((await patch(um, '/api/orgs/G8/configuration/settings', { reports: { defaultPeriod: 'forever' } })).status, 400);
  // Stored settings are read back within the limits too, whatever is in the row.
  assert.equal(normalizeUnitSettings({ work: { claimExpiryHours: 99999 } }).work.claimExpiryHours, max);
  assert.deepEqual(normalizeUnitSettings('nonsense'), DEFAULT_UNIT_SETTINGS);

  const item = await post(op.token, '/api/work/items', { unit_id: 'G8', title: 'Reconcile the line of accounting', visibility: 'unit' });
  assert.equal(item.status, 201, JSON.stringify(item.body));
  assert.equal((await post(op.token, `/api/work/items/${item.body.id}/claim`, { version: item.body.version })).status, 200);
  const tenHoursAgo = new Date(Date.now() - 10 * 3_600_000).toISOString();
  app.ctx.db.prepare('UPDATE work_items SET claimed_at = ?, updated_at = ? WHERE id = ?').run(tenHoursAgo, tenHoursAgo, item.body.id);
  assert.equal(releaseStaleClaims(app.ctx), 0, 'ten hours is inside the default window');

  const changed = await patch(um, '/api/orgs/G8/configuration/settings', { work: { claimExpiryHours: 8 } });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.work.claimExpiryHours, 8);
  assert.match(lastAudit('unit_settings_updated')!.detail, /claim expiry: 72h → 8h/);
  assert.equal(lastAudit('unit_settings_updated')!.org_id, 'G8');
  assert.equal((await get(g1lead.token, '/api/orgs/G1/configuration')).body.settings.work.claimExpiryHours, 72, 'G1 keeps its own');
  // A work setting leaves the Unit Instance's other settings as they were.
  assert.equal((await get(op.token, '/api/orgs/G8/overview')).body.organization.settings.vantageAccess, 'approval');

  assert.equal(releaseStaleClaims(app.ctx), 1, 'G8’s eight hours have passed');
  const row = app.ctx.db.prepare('SELECT claimed_by FROM work_items WHERE id = ?').get(item.body.id) as { claimed_by: string | null };
  assert.equal(row.claimed_by, null);
  assert.equal(lastAudit('work_claim_expired')!.detail, 'untouched for 8h');
});

test('the default report period follows a member’s primary Unit Instance, and is only a default', async () => {
  assert.equal((await patch(org.admin!.token, '/api/orgs/G8/configuration/settings', { reports: { defaultPeriod: 'fiscalYear' } })).status, 200);
  const me = await get(marine.token, '/api/me');
  assert.equal(me.body.unitDefaults.reportPeriod, 'fiscalYear');
  const g1 = await get(g1lead.token, '/api/me');
  assert.equal(g1.body.unitDefaults.reportPeriod, DEFAULT_UNIT_SETTINGS.reports.defaultPeriod);
});

test('the Unit Instance’s configuration says what Vantage sets for everyone, and nothing secret', async () => {
  const res = await get(org.auditor!.token, '/api/orgs/G8/configuration');
  assert.equal(res.status, 200);
  const { enterprise, limits } = res.body;
  assert.deepEqual(limits, UNIT_SETTING_LIMITS);
  assert.equal(enterprise.audit.tamperEvident, true);
  assert.equal(typeof enterprise.sessions.idleMinutes, 'number');
  assert.equal(typeof enterprise.signIn.cacRequired, 'boolean');
  const text = JSON.stringify(res.body);
  assert.doesNotMatch(text, /test-secret/);
  assert.doesNotMatch(text, /apiKey|password_hash|token/i);
});

test('the roster export lists units, billets and roles for a spreadsheet, with no EDIPI or email address', async () => {
  app.ctx.db.prepare("UPDATE users SET edipi = '1234567890', email = 'cfgmarine@example.mil' WHERE id = ?").run(marine.id);
  app.ctx.db.prepare("UPDATE unit_members SET billet = 'Budget Analyst' WHERE user_id = ? AND unit_id = 'G8'").run(marine.id);
  const res = await get(org.admin!.token, '/api/orgs/G8/roster.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename="vantage-g8-roster-/);
  const [header, ...lines] = res.text.trim().split(/\r?\n/);
  assert.equal(header.replaceAll('"', ''), 'last_name,first_name,rank,username,status,unit_id,unit,billet,primary,unit_roles,unit_instance_roles');
  assert.ok(lines.some((l) => l.includes('cfgmarine') && l.includes('Budget Analyst')));
  assert.ok(lines.some((l) => l.includes('cfgmgr') && l.includes('Unit Manager')));
  assert.doesNotMatch(res.text, /1234567890|@example\.mil/);
  assert.ok(!lines.some((l) => l.includes('cfgg1lead')), 'only this Unit Instance’s members');
  assert.equal(lastAudit('organization_roster_exported')!.org_id, 'G8');
});

test('the audit trail filters by action, unit and words on the server, pages back, and exports what it shows', async () => {
  const um = org.admin!.token;
  const aud = org.auditor!.token;
  const first = await get(aud, '/api/orgs/G8/audit?action=billet_created');
  assert.equal(first.status, 200);
  assert.ok(first.body.rows.length >= 2);
  assert.ok(first.body.rows.every((r: { action: string }) => r.action === 'billet_created'));
  assert.equal(first.body.chain.ok, true);
  // The chain is the whole service's: a Unit Instance counts only its own entries in it.
  const total = (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
  const g1 = (await get(g1lead.token, '/api/orgs/G1/audit')).body.chain;
  assert.ok(first.body.chain.count > 0 && first.body.chain.count < total, `${first.body.chain.count} of ${total}`);
  assert.ok(g1.count < first.body.chain.count);
  assert.ok(first.body.actions.includes('unit_settings_updated'));

  const inBud = await get(aud, '/api/orgs/G8/audit?unit=BUD');
  assert.ok(inBud.body.rows.length > 0);
  assert.ok(inBud.body.rows.every((r: { unit_id: string }) => r.unit_id === 'BUD'));
  assert.equal((await get(aud, '/api/orgs/G8/audit?unit=G1')).status, 404, 'another Unit Instance’s unit is not a filter here');

  const byName = await get(aud, '/api/orgs/G8/audit?q=Cfgmgr');
  assert.ok(byName.body.rows.some((r: { actor_id: string }) => r.actor_id === org.admin!.id), 'the search matches people’s names');

  const page1 = await get(aud, '/api/orgs/G8/audit?limit=2');
  assert.equal(page1.body.rows.length, 2);
  assert.ok(page1.body.next);
  const page2 = await get(aud, `/api/orgs/G8/audit?limit=2&before=${page1.body.next}`);
  assert.ok(page2.body.rows.every((r: { seq: number }) => r.seq < page1.body.next));
  assert.equal(page2.body.chain, null, 'the chain is verified on the first page only');

  // G8's configuration is not in G1's trail.
  assert.equal((await get(g1lead.token, '/api/orgs/G1/audit?action=billet_created')).body.rows.length, 0);

  const csv = await get(um, '/api/orgs/G8/audit/export?format=csv&action=billet_created');
  assert.equal(csv.status, 200);
  assert.match(csv.text.split(/\r?\n/)[0].replaceAll('"', ''), /^seq,at,action,actor_username,actor_id,subject_username,subject_id,entity,entity_id,unit_id,detail,ip,prev_hash,entry_hash$/);
  assert.match(lastAudit('organization_audit_exported')!.detail, /as csv; action=billet_created/);
  assert.equal((await get(aud, '/api/orgs/G8/audit?from=2026-02-30')).status, 400, 'a date that does not exist');
});

test('a configuration file moves billets, duty types and requirements to another Unit Instance, never its units', async () => {
  const exported = await get(org.admin!.token, '/api/orgs/G8/configuration/export');
  assert.equal(exported.status, 200);
  assert.equal(exported.body.format, UNIT_CONFIG_FORMAT);
  assert.ok(exported.body.billets.some((b: { unit_id: string | null }) => b.unit_id === 'BUD'));
  assert.ok(exported.body.dutyTypes.every((d: { code: string }) => d.code !== 'DNCO'), 'what was retired stays home');
  assert.ok(lastAudit('unit_configuration_exported'));
  const file = { ...exported.body, settings: { work: { claimExpiryHours: 99999 } } };

  // A Unit Auditor of G8 imports nothing, and G8's managers import nothing into G1.
  assert.equal((await post(org.auditor!.token, '/api/orgs/G8/configuration/import', file)).status, 403);
  assert.equal((await post(org.admin!.token, '/api/orgs/G1/configuration/import', file)).status, 404);

  const plan = await post(g1lead.token, '/api/orgs/G1/configuration/import', file);
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.applied, false);
  assert.ok(plan.body.lines.some((l: { outcome: string; reason?: string }) => l.outcome === 'skip' && /not in this Unit Instance/.test(l.reason || '')), 'BUD is G8’s');
  assert.ok(plan.body.counts.add > 0);
  assert.equal((await get(g1lead.token, '/api/orgs/G1/configuration')).body.dutyTypes.length, 0, 'a plan changes nothing');

  const applied = await post(g1lead.token, '/api/orgs/G1/configuration/import?apply=1', file);
  assert.equal(applied.status, 200);
  assert.equal(applied.body.applied, true);
  const g1 = (await get(g1lead.token, '/api/orgs/G1/configuration')).body;
  assert.ok(g1.dutyTypes.length > 0);
  assert.ok(g1.billets.every((b: { unit_id: string | null; org_id: string }) => b.org_id === 'G1' && b.unit_id !== 'BUD'));
  assert.equal(g1.settings.work.claimExpiryHours, UNIT_SETTING_LIMITS.claimExpiryHours.max, 'a setting from a file is taken within the limits');
  assert.equal(lastAudit('unit_configuration_imported')!.org_id, 'G1');

  const again = await post(g1lead.token, '/api/orgs/G1/configuration/import', file);
  assert.equal(again.body.counts.add, 0, 'importing the same file twice adds nothing');
  assert.equal((await post(g1lead.token, '/api/orgs/G1/configuration/import', { ...file, format: 'something-else' })).status, 400);
  assert.equal((await post(g1lead.token, '/api/orgs/G1/configuration/import', { ...file, billets: [{ title: '' }] })).status, 400);
});

test('unit roles across the Unit Instance: who holds what, and which the caller may change', async () => {
  const res = await get(org.admin!.token, '/api/orgs/G8/unit-roles');
  assert.equal(res.status, 200);
  const units = new Set(res.body.roles.map((r: { unit_id: string }) => r.unit_id));
  assert.ok(units.has('G8') && units.has('BUD'));
  assert.ok(!units.has('G1'), 'none of another Unit Instance’s roles');
  const leader = res.body.roles.find((r: { unit_id: string; key: string }) => r.unit_id === 'G8' && r.key === 'unit-leader');
  assert.ok(leader.holders.some((h: { user_id: string }) => h.user_id === op.id));
  assert.equal(leader.editable, false, 'a Unit Manager does not redefine the Unit Leader role');

  // Through the same calls as the app's Team page: a Unit Manager defines a role in BUD and grants it to a member there.
  await enroll(app, op.token, 'BUD', marine.id);
  const role = await post(org.admin!.token, '/api/org/roles', { unit_id: 'BUD', name: 'Budget Clerk', position: 20, permissions: 1 });
  assert.equal(role.status, 201, JSON.stringify(role.body));
  const granted = await post(org.admin!.token, `/api/org/team/${marine.id}/roles`, { role_id: role.body.id, unit_id: 'BUD' });
  assert.equal(granted.status, 200, JSON.stringify(granted.body));
  const after = (await get(org.admin!.token, '/api/orgs/G8/unit-roles')).body.roles.find((r: { id: string }) => r.id === role.body.id);
  assert.ok(after.holders.some((h: { user_id: string }) => h.user_id === marine.id));
  assert.equal(after.editable, true);
});

test('units and teams: a Unit Manager creates a team that is led from above, edits it and cannot move it out of the Unit Instance', async () => {
  const um = org.admin!.token;
  const team = await post(um, '/api/org/units', { name: '1st Fire Team', echelon: 'fire_team', parent_id: 'BUD' });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  assert.equal(team.body.echelon, 'fire_team');
  assert.equal(team.body.owner_user_id, null, 'led from above until its leader is named');
  assert.equal((await call('PUT', um, `/api/org/units/${team.body.id}`, { name: '1st Team', echelon: 'squad' })).status, 200);
  const moved = await call('PUT', um, `/api/org/units/${team.body.id}`, { parent_id: 'G1' });
  assert.equal(moved.status, 403);
  assert.equal((await post(um, '/api/org/units', { name: 'Smuggled', parent_id: 'G1' })).status, 403);
  const listed = (await get(org.auditor!.token, '/api/orgs/G8/units')).body.units.find((u: { id: string }) => u.id === team.body.id);
  assert.equal(listed.name, '1st Team');
  assert.equal((await call('DELETE', um, `/api/org/units/${team.body.id}`)).status, 200);
});

test('a username Vantage made from a card is the person’s EDIPI, and no roster, audit page, search or export shows it', async () => {
  const person = await app.register('cfgcac');
  await enroll(app, op.token, 'G8', person.id);
  // Something in the trail about them, with them as its subject.
  assert.equal((await post(op.token, '/api/orgs/G8/roles', { user_id: person.id, role: 'auditor' })).status, 201);
  app.ctx.db.prepare("UPDATE users SET username = 'edipi-2345678901' WHERE id = ?").run(person.id);
  const roster = await get(org.admin!.token, '/api/orgs/G8/roster.csv');
  const line = roster.text.split(/\r?\n/).find((l) => l.includes('Cfgcac'));
  assert.ok(line, 'the person is listed');
  assert.match(line!.replaceAll('"', ''), /^Marine,Cfgcac,LCpl,,active,/, 'with no username');
  assert.doesNotMatch(roster.text, /2345678901/);
  const aud = org.auditor!.token;
  const page = await get(aud, '/api/orgs/G8/audit?limit=1000');
  const theirs = page.body.rows.filter((r: { subject_id: string | null; actor_id: string | null }) => r.subject_id === person.id || r.actor_id === person.id);
  assert.ok(theirs.length > 0, 'the grant is in the trail');
  assert.ok(theirs.every((r: { subject_username: string | null }) => r.subject_username === null || r.subject_username === undefined || !/edipi/.test(r.subject_username)));
  assert.doesNotMatch(JSON.stringify(page.body), /2345678901/);
  assert.equal((await get(aud, '/api/orgs/G8/audit?q=2345678901')).body.rows.length, 0, 'the search does not match the number');
  const exported = await get(aud, '/api/orgs/G8/audit/export?format=csv');
  assert.doesNotMatch(exported.text, /2345678901/);
});

test('a billet or requirement whose unit was archived keeps it, can be corrected, and comes back only to an active unit', async () => {
  const um = org.admin!.token;
  const unit = await post(um, '/api/org/units', { name: 'Closing Section', echelon: 'section', parent_id: 'G8' });
  assert.equal(unit.status, 201, JSON.stringify(unit.body));
  const billet = await post(um, '/api/orgs/G8/billets', { title: 'Closing Officer', unit_id: unit.body.id });
  assert.equal(billet.status, 201, JSON.stringify(billet.body));
  const requirement = await post(um, '/api/orgs/G8/training-requirements', { title: 'Closing Brief', type: 'training', unit_id: unit.body.id });
  assert.equal(requirement.status, 201, JSON.stringify(requirement.body));
  assert.equal((await call('DELETE', um, `/api/org/units/${unit.body.id}`)).status, 200);
  // The console's edit sends the unit it already names; that is not a new unit.
  const edited = await patch(um, `/api/orgs/G8/billets/${billet.body.id}`, { title: 'Closing Officer (OIC)', unit_id: unit.body.id });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  assert.equal(edited.body.unit_id, unit.body.id);
  assert.equal((await patch(um, `/api/orgs/G8/training-requirements/${requirement.body.id}`, { title: 'Closing Brief 2', unit_id: unit.body.id })).status, 200);
  // Retired, it cannot come back to the archived unit; moved to the whole instance, it can.
  assert.equal((await patch(um, `/api/orgs/G8/billets/${billet.body.id}`, { active: false })).status, 200);
  const back = await patch(um, `/api/orgs/G8/billets/${billet.body.id}`, { active: true });
  assert.equal(back.status, 400);
  assert.match(back.body.error, /archived/);
  assert.equal((await patch(um, `/api/orgs/G8/billets/${billet.body.id}`, { active: true, unit_id: null })).status, 200);
  // A new row still needs an active unit.
  assert.equal((await post(um, '/api/orgs/G8/billets', { title: 'Late Billet', unit_id: unit.body.id })).status, 400);
});

test('the standard duty list skips a type the Unit Instance already has under its own code', async () => {
  const fresh = await app.register('cfgstdlead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-3', code: 'G3', owner_user_id: fresh.id })).status, 201);
  const lead = await login('cfgstdlead');
  const own = await post(lead, '/api/orgs/G3/duty-types', { name: 'Barracks Duty' });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.code, 'BARRACKS-DUTY');
  const added = await post(lead, '/api/orgs/G3/duty-types/standard');
  assert.ok(!added.body.added.includes('BARRACKS'), JSON.stringify(added.body));
  const names = ((await get(lead, '/api/orgs/G3/configuration')).body.dutyTypes as Array<{ name: string }>).map((d) => d.name);
  assert.equal(names.filter((n) => n === 'Barracks Duty').length, 1);
});
