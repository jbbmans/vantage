import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';

let app: TestApp;
let op: { token: string; id: string };
const people: Record<string, { id: string; token: string }> = {};
const today = new Date().toISOString().slice(0, 10);
const as = (name: string) => people[name].token;
const relogin = async (name: string) => { people[name].token = (await app.login(name)).body.token; return people[name].token; };
const share = async (name: string, unit_id: string, title: string) => {
  const res = await app.call('POST', '/api/records/activities', { token: as(name), body: { title, date: today, visibility: 'unit', unit_id } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id as string;
};
const viewsOf = async (name: string) => {
  const me = await app.call('GET', '/api/me', { token: as(name) });
  return { list: me.body.views.map((v: { id: string; level: string }) => `${v.id}:${v.level}`), defaultViewId: me.body.defaultViewId };
};

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  for (const [name, short] of [['Alpha Team', 'ALPHA'], ['Bravo Team', 'BRAVO']]) {
    assert.equal((await app.call('POST', '/api/org/units', { token: op.token, body: { name, short_name: short, parent_id: 'G8' } })).status, 201);
  }
  const plan: Array<[string, string, string | undefined]> = [
    ['alphalead', 'ALPHA', 'sncoic'], ['alpha1', 'ALPHA', undefined], ['alpha2', 'ALPHA', undefined], ['alpha3', 'ALPHA', 'nco'],
    ['bravo1', 'BRAVO', undefined], ['g8sn', 'G8', 'sncoic'], ['peer', 'G8', 'sncoic'],
  ];
  for (const [name, unit, role] of plan) {
    const account = await app.register(name);
    await enroll(app, op.token, unit, account.id, role);
    people[name] = { id: account.id, token: '' };
  }
  await enroll(app, op.token, 'ALPHA', people.peer.id);
  for (const name of Object.keys(people)) await relogin(name);
});
after(async () => { await app?.close(); });

test('each person sees the command and their own team, at the level their roles allow', async () => {
  const owner = await app.call('GET', '/api/me', { token: op.token });
  assert.deepEqual(owner.body.views.map((v: { id: string; level: string }) => `${v.id}:${v.level}`), ['G8:full', 'ALPHA:full', 'BRAVO:full']);
  assert.equal(owner.body.defaultViewId, 'G8');
  assert.equal(owner.body.views[0].teams, 2);

  assert.deepEqual(await viewsOf('alpha1'), { list: ['G8:overview', 'ALPHA:overview'], defaultViewId: 'ALPHA' });
  assert.deepEqual(await viewsOf('alphalead'), { list: ['G8:overview', 'ALPHA:full'], defaultViewId: 'ALPHA' });
  assert.deepEqual(await viewsOf('g8sn'), { list: ['G8:full', 'ALPHA:full', 'BRAVO:full'], defaultViewId: 'G8' });
});

test('a command dashboard rolls up every team beneath it; a team leader never sees the command’s records', async () => {
  await share('alpha1', 'ALPHA', 'Alpha one');
  await share('alpha2', 'ALPHA', 'Alpha two');
  await share('bravo1', 'BRAVO', 'Bravo one');
  const g8 = await app.call('GET', '/api/org/units/G8/dashboard', { token: as('g8sn') });
  assert.equal(g8.status, 200);
  assert.equal(g8.body.rolls_up, 2);
  assert.equal(g8.body.totals.entries, 3);
  assert.deepEqual(Object.fromEntries(g8.body.by_team.map((t: { unit_id: string; entries: number }) => [t.unit_id, t.entries])), { ALPHA: 2, BRAVO: 1 });

  const alpha = await app.call('GET', '/api/org/units/ALPHA/dashboard', { token: as('alphalead') });
  assert.equal(alpha.body.totals.entries, 2);
  assert.equal((await app.call('GET', '/api/org/units/G8/dashboard', { token: as('alphalead') })).status, 403);
  assert.equal((await app.call('GET', '/api/org/units/BRAVO/dashboard', { token: as('alphalead') })).status, 403);
  assert.equal((await app.call('GET', '/api/org/units/ALPHA/dashboard', { token: as('alpha1') })).status, 403);
});

test('an overview withholds totals built from fewer than three people, and stops at the viewer’s chain of command', async () => {
  const early = await app.call('GET', '/api/org/units/ALPHA/overview', { token: as('alpha1') });
  assert.equal(early.status, 200);
  assert.equal(early.body.level, 'overview');
  assert.equal(early.body.totals.withheld, true);
  assert.equal(early.body.totals.entries, null);
  assert.ok(early.body.roster.some((p: { id: string }) => p.id === people.alpha2.id), 'the roster is always shown');

  const led = await app.call('GET', '/api/org/units/ALPHA/overview', { token: as('alphalead') });
  assert.equal(led.body.level, 'full');
  assert.equal(led.body.totals.withheld, false);
  assert.equal(led.body.totals.entries, 2);

  await share('alpha3', 'ALPHA', 'Alpha three');
  const later = await app.call('GET', '/api/org/units/ALPHA/overview', { token: as('alpha1') });
  assert.equal(later.body.totals.withheld, false);
  assert.equal(later.body.totals.entries, 3);

  const command = await app.call('GET', '/api/org/units/G8/overview', { token: as('alpha1') });
  assert.equal(command.status, 200);
  const teams = Object.fromEntries(command.body.teams.map((t: { unit_id: string; withheld: boolean; entries: number | null }) => [t.unit_id, t]));
  assert.equal(teams.ALPHA.withheld, false);
  assert.equal(teams.BRAVO.withheld, true, 'one contributor in Bravo is not shown to a Marine in Alpha');
  assert.equal(teams.BRAVO.entries, null);
  assert.equal((await app.call('GET', '/api/org/units/BRAVO/overview', { token: as('alpha1') })).status, 403);
});

test('moving a Marine between teams needs authority over both, respects rank, and carries roles and entries on request', async () => {
  const denied = await app.call('POST', `/api/org/units/ALPHA/members/${people.alpha1.id}/move`, { token: as('alphalead'), body: { to: 'BRAVO' } });
  assert.equal(denied.status, 403, 'an Alpha leader has no say in Bravo');
  const self = await app.call('POST', `/api/org/units/ALPHA/members/${people.g8sn.id}/move`, { token: as('g8sn'), body: { to: 'BRAVO' } });
  assert.equal(self.status, 403);
  assert.equal(self.body.code, 'self_membership_change', 'nobody moves themselves');
  const peer = await app.call('POST', `/api/org/units/ALPHA/members/${people.peer.id}/move`, { token: as('g8sn'), body: { to: 'BRAVO' } });
  assert.equal(peer.status, 403);
  assert.equal(peer.body.code, 'hierarchy', 'a peer at the same position cannot be moved');

  const oldToken = as('alpha1');
  const moved = await app.call('POST', `/api/org/units/ALPHA/members/${people.alpha1.id}/move`, { token: as('g8sn'), body: { to: 'BRAVO', entries: 'move' } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.entriesMoved, 1);
  assert.equal((await app.call('GET', '/api/me', { token: oldToken })).status, 401, 'the move signs them out so their access is re-read');
  await relogin('alpha1');
  assert.deepEqual((await viewsOf('alpha1')).list, ['G8:overview', 'BRAVO:overview']);
  const units = app.ctx.db.prepare('SELECT unit_id, frozen_at FROM activities WHERE user_id = ?').all(people.alpha1.id) as Array<{ unit_id: string; frozen_at: string | null }>;
  assert.deepEqual(units, [{ unit_id: 'BRAVO', frozen_at: null }]);

  const stay = await app.call('POST', `/api/org/units/ALPHA/members/${people.alpha2.id}/move`, { token: as('g8sn'), body: { to: 'BRAVO' } });
  assert.equal(stay.status, 200);
  assert.equal(stay.body.recordsFrozen, 1);
  const kept = app.ctx.db.prepare('SELECT unit_id, frozen_at FROM activities WHERE user_id = ?').get(people.alpha2.id) as { unit_id: string; frozen_at: string | null };
  assert.equal(kept.unit_id, 'ALPHA', 'by default the entry stays with the team the work was done for');
  assert.ok(kept.frozen_at);

  const withRole = await app.call('POST', `/api/org/units/ALPHA/members/${people.alpha3.id}/move`, { token: as('g8sn'), body: { to: 'BRAVO' } });
  assert.equal(withRole.status, 200);
  assert.deepEqual(withRole.body.roles, ['NCO']);
  const roles = app.ctx.db.prepare('SELECT role_id FROM member_roles WHERE user_id = ? ORDER BY role_id').all(people.alpha3.id) as Array<{ role_id: string }>;
  assert.deepEqual(roles.map((r) => r.role_id), ['BRAVO:marine', 'BRAVO:nco']);

  const again = await app.call('POST', `/api/org/units/ALPHA/members/${people.alpha3.id}/move`, { token: as('g8sn'), body: { to: 'BRAVO' } });
  assert.equal(again.status, 404);
  const audit = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'move_member'").get() as { n: number };
  assert.equal(audit.n, 3);
});

test('a Marine whose primary unit is the command, as an imported roster makes it, still sees only the command and their own team', async () => {
  const account = await app.register('cmdmarine');
  people.cmdmarine = { id: account.id, token: '' };
  await enroll(app, op.token, 'G8', account.id);
  await enroll(app, op.token, 'ALPHA', account.id);
  await relogin('cmdmarine');
  const primary = app.ctx.db.prepare('SELECT unit_id FROM unit_members WHERE user_id = ? AND is_primary = 1').get(account.id) as { unit_id: string };
  assert.equal(primary.unit_id, 'G8');

  assert.deepEqual(await viewsOf('cmdmarine'), { list: ['G8:overview', 'ALPHA:overview'], defaultViewId: 'ALPHA' });
  assert.equal((await app.call('GET', '/api/org/units/BRAVO/overview', { token: as('cmdmarine') })).status, 403, 'belonging to the command does not open every team');
  assert.equal((await app.call('GET', '/api/org/units/ALPHA/overview', { token: as('cmdmarine') })).status, 200);
  const shared = await app.call('POST', '/api/records/activities', { token: as('cmdmarine'), body: { title: 'Shared by default', date: today, visibility: 'unit' } });
  assert.equal(shared.status, 201, JSON.stringify(shared.body));
  assert.equal(shared.body.unit_id, 'ALPHA', 'sharing without naming a unit reaches their own team, so their team leader sees it');
  assert.equal((await app.call('GET', '/api/me', { token: as('cmdmarine') })).body.homeUnitId, 'ALPHA');

  const moved = await app.call('POST', `/api/org/units/ALPHA/members/${account.id}/move`, { token: as('g8sn'), body: { to: 'BRAVO' } });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const after = app.ctx.db.prepare('SELECT unit_id, is_primary FROM unit_members WHERE user_id = ? ORDER BY unit_id').all(account.id) as Array<{ unit_id: string; is_primary: number }>;
  assert.deepEqual(after, [{ unit_id: 'BRAVO', is_primary: 0 }, { unit_id: 'G8', is_primary: 1 }], 'a move between teams leaves the command as their primary unit');
});
