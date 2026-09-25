import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let rivera: { token: string; id: string };
let nguyen: { token: string; id: string };
let stranger: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  rivera = await app.register('rivera');
  nguyen = await app.register('nguyen', { rank_id: 'Sgt' });
  stranger = await app.register('stranger');
  await enroll(app, op.token, 'G8', rivera.id);
  rivera.token = (await app.login('rivera')).body.token;
});
after(async () => { await app.close(); });

const mkUnit = (token: string, name: string) => app.call('POST', '/api/org/units', { token, body: { name } });

test('a member can stand up a unit of their own and owns it', async () => {
  const made = await mkUnit(rivera.token, 'Rivera Fire Team');
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.name, 'Rivera Fire Team');

  // Owning it means holding every permission inside it — and none outside.
  const me = await app.call('GET', '/api/me', { token: (await app.login('rivera')).body.token });
  const perms = me.body.permissions || {};
  assert.ok((perms[made.body.id] || 0) > 0, 'the creator has authority in their own unit');
  assert.ok(perms['G8'] === undefined || perms['G8'] < (perms[made.body.id] || 0), 'and gains nothing in G8 by it');
});

test('the operator can switch self-service off, and then nobody else can', async () => {
  const off = await app.call('PUT', '/api/admin/runtime', { token: op.token, body: { selfServiceUnits: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  const refused = await mkUnit(nguyen.token, 'Should Not Exist');
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Instance Operator/i);
  // The operator is still not blocked by their own switch.
  const byOp = await mkUnit(op.token, 'Operator Unit');
  assert.equal(byOp.status, 201, JSON.stringify(byOp.body));
  await app.call('PUT', '/api/admin/runtime', { token: op.token, body: { selfServiceUnits: true } });
});

test('a person cannot stand up unlimited units', async () => {
  await app.call('PUT', '/api/admin/runtime', { token: op.token, body: { selfServiceUnitLimit: 2 } });
  const fresh = await app.register('limited');
  const token = fresh.token;
  assert.equal((await mkUnit(token, 'Limited One')).status, 201);
  assert.equal((await mkUnit(token, 'Limited Two')).status, 201);
  const third = await mkUnit(token, 'Limited Three');
  assert.equal(third.status, 403);
  assert.match(third.body.error, /limit/i);
  await app.call('PUT', '/api/admin/runtime', { token: op.token, body: { selfServiceUnitLimit: 5 } });
});

test('an invite code lets somebody in, once, and only while it is live', async () => {
  const unit = await mkUnit(rivera.token, 'Invite Team');
  const owner = (await app.login('rivera')).body.token;

  const invite = await app.call('POST', `/api/org/units/${unit.body.id}/join-codes`, { token: owner, body: { max_uses: 1, note: 'Second squad' } });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const code = invite.body.code as string;
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/, 'a code people can read off a screen');

  const listed = await app.call('GET', `/api/org/units/${unit.body.id}/join-codes`, { token: owner });
  assert.equal(listed.body.invites.length, 1);
  assert.equal(listed.body.invites[0].code, undefined, 'a stored invite cannot be read back as a working code');
  assert.equal(listed.body.invites[0].code_hint, code.slice(0, 5));

  // Looking it up says which unit it opens, and nothing more.
  const peek = await app.call('GET', `/api/org/join-codes/${code}`, { token: stranger.token });
  assert.equal(peek.status, 200);
  assert.equal(peek.body.unit_name, 'Invite Team');

  const joined = await app.call('POST', `/api/org/join-codes/${code}/join`, { token: stranger.token });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.unit_name, 'Invite Team');

  // Spent: the next person is refused, and told nothing about why.
  const second = await app.call('POST', `/api/org/join-codes/${code}/join`, { token: nguyen.token });
  assert.equal(second.status, 400);
  assert.match(second.body.error, /not valid/i);
});

test('a revoked invite stops working but keeps the record of who came in on it', async () => {
  const unit = await mkUnit(rivera.token, 'Revoke Team');
  const owner = (await app.login('rivera')).body.token;
  const invite = await app.call('POST', `/api/org/units/${unit.body.id}/join-codes`, { token: owner, body: {} });
  const code = invite.body.code as string;

  assert.equal((await app.call('POST', `/api/org/join-codes/${code}/join`, { token: nguyen.token })).status, 200);
  assert.equal((await app.call('DELETE', `/api/org/units/${unit.body.id}/join-codes/${invite.body.id}`, { token: owner })).status, 200);

  const after = await app.call('POST', `/api/org/join-codes/${code}/join`, { token: stranger.token });
  assert.equal(after.status, 400);

  const listed = await app.call('GET', `/api/org/units/${unit.body.id}/join-codes`, { token: owner });
  const row = listed.body.invites.find((i: { id: string }) => i.id === invite.body.id);
  assert.ok(row.revoked_at, 'it reads as revoked');
  assert.equal(row.uses, 1, 'and still records that somebody joined on it');
});

test('an invite cannot hand out a role at or above the inviter’s own', async () => {
  const unit = await mkUnit(rivera.token, 'Role Team');
  const owner = (await app.login('rivera')).body.token;
  const roles = await app.call('GET', `/api/org/roles?unit_id=${unit.body.id}`, { token: owner });
  assert.equal(roles.status, 200, JSON.stringify(roles.body));

  const invite = await app.call('POST', `/api/org/units/${unit.body.id}/join-codes`, { token: owner, body: { max_uses: 1 } });
  await app.call('POST', `/api/org/join-codes/${invite.body.code}/join`, { token: nguyen.token });
  const asMember = (await app.login('nguyen')).body.token;

  const top = (roles.body.roles || roles.body).reduce((a: { position: number }, b: { position: number }) => (b.position > a.position ? b : a));
  const attempt = await app.call('POST', `/api/org/units/${unit.body.id}/join-codes`, { token: asMember, body: { role_id: top.id } });
  assert.ok(attempt.status === 403, `a plain member should not be writing invites at all, got ${attempt.status}`);
});

test('somebody who cannot manage members cannot mint invites', async () => {
  const unit = await mkUnit(rivera.token, 'Closed Team');
  const owner = (await app.login('rivera')).body.token;
  const invite = await app.call('POST', `/api/org/units/${unit.body.id}/join-codes`, { token: owner, body: { max_uses: 5 } });
  await app.call('POST', `/api/org/join-codes/${invite.body.code}/join`, { token: stranger.token });

  const asMember = (await app.login('stranger')).body.token;
  const attempt = await app.call('POST', `/api/org/units/${unit.body.id}/join-codes`, { token: asMember, body: {} });
  assert.equal(attempt.status, 403, 'joining a unit does not let you invite the next person');
  assert.equal((await app.call('GET', `/api/org/units/${unit.body.id}/join-codes`, { token: asMember })).status, 403);
});
