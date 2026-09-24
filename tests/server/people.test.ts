import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';

/**
 * Teams open to their members, and the three access levels (shared/access.ts) that People manages.
 * op sets the instance up, so op is the organization administrator and owns G8.
 */
let app: TestApp;
let op: { token: string; id: string; unitId: string };
let lead: { token: string; id: string };
let sncoic: { token: string; id: string };
let marine: { token: string; id: string };
let peer: { token: string; id: string };
let outsider: { token: string; id: string };
const token = async (username: string) => (await app.login(username)).body.token as string;

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  lead = await app.register('lead', { rank_id: 'SSgt' });
  sncoic = await app.register('sncoic', { rank_id: 'GySgt' });
  marine = await app.register('marine');
  peer = await app.register('peer');
  outsider = await app.register('outsider');
  await enroll(app, op.token, 'G8', lead.id, 'team-leader');
  await enroll(app, op.token, 'G8', sncoic.id, 'sncoic');
  await enroll(app, op.token, 'G8', marine.id);
  await enroll(app, op.token, 'G8', peer.id);
});
after(async () => { await app.close(); });

test('every member sees their team, its levels and its totals, and still opens no one else’s record', async () => {
  const m = await token('marine');
  const roster = (await app.call('GET', '/api/org/team', { token: m })).body.roster as Array<{ id: string; canOpen: boolean; memberships: Array<{ unit_id: string; level: string }> }>;
  const ids = roster.map((p) => p.id);
  for (const id of [lead.id, sncoic.id, peer.id, op.id]) assert.ok(ids.includes(id), 'a teammate is on the roster');
  assert.ok(!ids.includes(outsider.id), 'someone on no shared team is not');
  assert.ok(roster.filter((p) => p.id !== marine.id).every((p) => !p.canOpen), 'seeing the roster is not opening a record');
  assert.equal(roster.find((p) => p.id === lead.id)!.memberships.find((x) => x.unit_id === 'G8')!.level, 'leader');
  assert.equal(roster.find((p) => p.id === op.id)!.memberships.find((x) => x.unit_id === 'G8')!.level, 'administrator');
  assert.equal((await app.call('GET', `/api/org/team/${peer.id}`, { token: m })).status, 403);

  const workload = await app.call('GET', '/api/work/workload?unit_id=G8', { token: m });
  assert.equal(workload.status, 200, 'the team’s totals are open to the team');
  assert.deepEqual(workload.body.members, [], 'who carries what stays with leaders');
  assert.equal((await app.call('GET', '/api/work/workload?unit_id=G8', { token: await token('outsider') })).status, 403);

  const teams = (await app.call('GET', '/api/org/teams', { token: await token('outsider') })).body.teams as Array<{ id: string; is_member: boolean; members: number }>;
  const g8 = teams.find((t) => t.id === 'G8')!;
  assert.equal(g8.is_member, false, 'every team is listed for everyone, members or not');
  assert.equal(g8.members, 5);
  assert.ok(!('roster' in g8), 'the directory names teams, not the people on them');

  const me = (await app.call('GET', '/api/me', { token: m })).body;
  assert.equal(me.accessLevel, 'personal');
  assert.equal(me.levels.G8, 'personal');
  assert.equal(me.canManagePeople, false);
  assert.equal((await app.call('GET', '/api/people', { token: m })).status, 403);
  assert.equal((await app.call('GET', '/api/me', { token: await token('lead') })).body.accessLevel, 'leader');
  assert.equal((await app.call('GET', '/api/me', { token: await token('boletz') })).body.accessLevel, 'administrator');
});

test('a team leader manages who is on the team but no one’s level; levels follow the role hierarchy', async () => {
  const l = await token('lead');
  const people = await app.call('GET', '/api/people', { token: l });
  assert.equal(people.status, 200);
  const row = people.body.people.find((p: any) => p.id === marine.id);
  assert.ok(!('email' in row) && !('last_login_at' in row), 'sign-in facts are for the organization administrator');
  const g8 = row.teams.find((t: any) => t.unit_id === 'G8');
  assert.deepEqual(g8.settable, [], 'a team leader sets nobody’s level');
  assert.equal(g8.removable, true);
  assert.equal(people.body.stats.leader, 2, 'the Team Leader, and the SNCOIC, whose role reads as one');
  assert.equal(people.body.stats.administrator, 1, 'the owner');
  assert.equal((await app.call('PUT', `/api/people/${marine.id}/teams/G8`, { token: l, body: { level: 'leader' } })).status, 403);

  // SNCOIC manages roles below their own position (60): Team leader (50) yes, Administrator (90) no.
  const sn = await token('sncoic');
  const up = await app.call('PUT', `/api/people/${marine.id}/teams/G8`, { token: sn, body: { level: 'leader' } });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(up.body.granted, 'Team Leader');
  assert.equal((await app.call('GET', '/api/me', { token: await token('marine') })).body.levels.G8, 'leader');
  assert.equal((await app.call('PUT', `/api/people/${marine.id}/teams/G8`, { token: sn, body: { level: 'administrator' } })).status, 403);
  // The team's own role positions decide, not the template's: moved above SNCOIC, Team Leader is out of their reach.
  app.ctx.db.prepare("UPDATE roles SET position = 70 WHERE id = 'G8:team-leader'").run();
  assert.equal((await app.call('PUT', `/api/people/${peer.id}/teams/G8`, { token: sn, body: { level: 'leader' } })).status, 403);
  app.ctx.db.prepare("UPDATE roles SET position = 50 WHERE id = 'G8:team-leader'").run();
  const down = await app.call('PUT', `/api/people/${lead.id}/teams/G8`, { token: sn, body: { level: 'personal' } });
  assert.equal(down.status, 200);
  assert.deepEqual(down.body.removed, ['Team Leader']);
  assert.equal((await app.call('GET', '/api/me', { token: await token('lead') })).body.accessLevel, 'personal');

  // The owner sets any level in their team, and nobody sets their own.
  const owner = await token('boletz');
  const admin = await app.call('PUT', `/api/people/${marine.id}/teams/G8`, { token: owner, body: { level: 'administrator' } });
  assert.equal(admin.status, 200);
  assert.equal((await app.call('GET', '/api/me', { token: await token('marine') })).body.levels.G8, 'administrator');
  assert.equal((await app.call('PUT', `/api/people/${marine.id}/teams/G8`, { token: sn, body: { level: 'personal' } })).status, 403, 'not someone above you');
  assert.equal((await app.call('PUT', `/api/people/${op.id}/teams/G8`, { token: owner, body: { level: 'personal' } })).status, 403, 'not yourself');
  const reset = await app.call('PUT', `/api/people/${marine.id}/teams/G8`, { token: owner, body: { level: 'personal' } });
  assert.deepEqual(reset.body.removed.sort(), ['Team Administrator', 'Team Leader']);
  assert.equal((await app.call('GET', '/api/me', { token: await token('marine') })).body.accessLevel, 'personal');
  const logged = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'set_access_level' AND subject_id = ?").get(marine.id) as { n: number };
  assert.equal(logged.n, 3, 'every change is in the access log');
});

test('an organization administrator reaches every team, after confirming their password', async () => {
  const sn = await token('sncoic');
  const unit = await app.call('POST', '/api/org/units', { token: sn, body: { name: 'Recruiting Team', short_name: 'RCT' } });
  assert.equal(unit.status, 201);
  assert.equal((await app.call('POST', `/api/people/${peer.id}/teams`, { token: await token('sncoic'), body: { unit_id: 'RCT', level: 'personal' } })).status, 201);

  const owner = await token('boletz');
  app.ctx.db.prepare('UPDATE sessions SET sudo_until = NULL WHERE user_id = ?').run(op.id);
  const stale = await app.call('GET', '/api/people', { token: owner });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.code, 'sudo_required');
  assert.equal((await app.call('POST', '/api/auth/sudo', { token: owner, body: { password: PASSWORD } })).status, 200);
  const all = await app.call('GET', '/api/people', { token: owner });
  assert.equal(all.status, 200);
  const outsiderRow = all.body.people.find((p: any) => p.id === outsider.id);
  assert.ok(outsiderRow, 'people on no team are in the organization list');
  assert.ok('email' in outsiderRow && 'mfa' in outsiderRow);
  assert.ok(all.body.units.some((u: any) => u.id === 'RCT'));

  assert.equal((await app.call('PUT', `/api/people/${peer.id}/teams/RCT`, { token: owner, body: { level: 'leader' } })).status, 200, 'a team op is not on');
  assert.equal((await app.call('POST', `/api/people/${outsider.id}/teams`, { token: owner, body: { unit_id: 'RCT' } })).status, 201);
  assert.ok((await app.call('GET', '/api/me', { token: await token('outsider') })).body.unitIds.includes('RCT'));
  assert.equal((await app.call('DELETE', `/api/people/${outsider.id}/teams/RCT`, { token: owner })).status, 200);
  // A leader of G8 has no reach into RCT.
  assert.equal((await app.call('PUT', `/api/people/${peer.id}/teams/RCT`, { token: await token('lead'), body: { level: 'personal' } })).status, 403);
});
