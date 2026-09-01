import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `vantage-sec-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';

process.env.VANTAGE_OPERATOR = 'boletz';

const { app, db } = await import('../server/index.js');
const { seedTestUnits } = await import('./helpers/seed-test-units.mjs');
seedTestUnits(db);
const { resetCounters, LOGIN_LIMITS } = await import('../server/security.js');
const { PERMISSIONS } = await import('../server/roles.js');
const { deactivateMember } = await import('../server/lifecycle.js');

const P = PERMISSIONS;

const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://localhost:${server.address().port}`;

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name} — ${err.message}`]);
  }
}

const call = async (method, path, { token, body, headers = {} } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {  }
  return { status: res.status, body: json, headers: res.headers };
};

const login = async (username, password) => {
  const res = await call('POST', '/api/login', { body: { username, password } });
  return res.body?.token;
};

const PW = (u) => `${u}-long-enough-passphrase`;

const makeUser = (token, { username, unit_id, role_id = null, rank_id = 'LCpl' }) =>
  call('POST', '/api/team', {
    token,
    body: {
      username, password: PW(username), first_name: username[0].toUpperCase() + username.slice(1),
      last_name: 'Test', rank_id, mos: '3451', unit_id, role_id,
    },
  });

const fixtureFirstName = (username) => username[0].toUpperCase() + username.slice(1);
const fixtureId = (rosterRows, username) =>
  rosterRows.find((row) => row.first_name === fixtureFirstName(username) && row.last_name === 'Test')?.id;

await call('POST', '/api/setup', {
  body: {
    username: 'boletz', password: 'cobalt-orbit-velvet-anchor-927',
    first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', mos: '3451',
    unit_code: 'MFR', billet_title: 'Accounting Chief',
  },
});
const admin = await login('boletz', 'cobalt-orbit-velvet-anchor-927');
const adminId = (await call('GET', '/api/me', { token: admin })).body.user.id;

for (const unitId of ['G8-FMRAC', 'G8-BUDGET', 'CLR-4']) {
  const res = await call('POST', `/api/org/units/${unitId}/claim`, {
    token: admin, body: { owner_user_id: adminId, template_id: 'default' },
  });
  assert.equal(res.status, 200, `fixture: claim ${unitId} — ${res.status} ${JSON.stringify(res.body)}`);
}

const branchBits = P.VIEW_UNIT | P.VIEW_RECORDS | P.VIEW_MEMBER_DETAIL | P.CREATE_SHARED_WORK
  | P.CREATE_SHARED_GOALS | P.MANAGE_RECORDS | P.MANAGE_ROLES | P.MANAGE_MEMBERS | P.VIEW_AUDIT;

const branchManager = (await call('POST', '/api/roles', {
  token: admin,
  body: { name: 'Branch Manager', unit_id: 'MFR', position: 25, permissions: branchBits },
})).body;
assert.ok(branchManager?.id, 'fixture: branch-manager role must exist');

const branchManagerFmrac = (await call('POST', '/api/roles', {
  token: admin,
  body: { name: 'Branch Manager', unit_id: 'G8-FMRAC', position: 25, permissions: branchBits },
})).body;
const branchManagerBudget = (await call('POST', '/api/roles', {
  token: admin,
  body: { name: 'Branch Manager', unit_id: 'G8-BUDGET', position: 25, permissions: branchBits },
})).body;

const clerk = (await call('POST', '/api/roles', {
  token: admin,
  body: { name: 'Clerk', unit_id: 'G8-FMRAC', position: 5, permissions: P.VIEW_UNIT | P.VIEW_RECORDS },
})).body;
const clerkBudget = (await call('POST', '/api/roles', {
  token: admin,
  body: { name: 'Clerk', unit_id: 'G8-BUDGET', position: 5, permissions: P.VIEW_UNIT | P.VIEW_RECORDS },
})).body;

const clrClerk = (await call('POST', '/api/roles', {
  token: admin,
  body: { name: 'CLR Clerk', unit_id: 'CLR-4', position: 5, permissions: P.VIEW_UNIT },
})).body;

const auditor = (await call('POST', '/api/roles', {
  token: admin,
  body: { name: 'Auditor', unit_id: 'G8-FMRAC', position: 5, permissions: P.VIEW_UNIT | P.EXPORT_DATA },
})).body;

await makeUser(admin, { username: 'hayes', unit_id: 'MFR', rank_id: 'SSgt' });
const hayesId = fixtureId((await call('GET', '/api/team', { token: admin })).body.roster, 'hayes');
await call('POST', `/api/team/${hayesId}/roles`, { token: admin, body: { role_id: branchManager.id, unit_id: 'MFR' } });

for (const [unitId, roleId] of [['G8-FMRAC', branchManagerFmrac.id], ['G8-BUDGET', branchManagerBudget.id]]) {
  const res = await call('POST', `/api/org/units/${unitId}/members`, {
    token: admin, body: { user_id: hayesId, role_id: roleId },
  });
  assert.equal(res.status, 200, `fixture: hayes into ${unitId} — ${res.status} ${JSON.stringify(res.body)}`);
}
const hayes = await login('hayes', PW('hayes'));

await makeUser(admin, { username: 'rivera', unit_id: 'G8-FMRAC' });
await makeUser(admin, { username: 'ohara', unit_id: 'G8-FMRAC', rank_id: 'Sgt' });
await makeUser(admin, { username: 'nguyen', unit_id: 'CLR-4', role_id: 'CLR-4:nco', rank_id: 'Sgt' });
const roster = (await call('GET', '/api/team', { token: admin })).body.roster;
const idOf = (u) => fixtureId(roster, u);
const riveraId = idOf('rivera');
const oharaId = idOf('ohara');
const nguyenId = idOf('nguyen');
let rivera = await login('rivera', PW('rivera'));
let ohara = await login('ohara', PW('ohara'));
const nguyen = await login('nguyen', PW('nguyen'));

await test('ESCALATION: role editor cannot add ADMINISTRATOR to a lower role', async () => {
  const res = await call('PUT', `/api/roles/${clerk.id}`, {
    token: hayes, body: { permissions: clerk.permissions | P.ADMINISTRATOR },
  });
  assert.equal(res.status, 403);
  const after = (await call('GET', '/api/roles', { token: admin })).body.roles.find((r) => r.id === clerk.id);
  assert.equal(after.permissions & P.ADMINISTRATOR, 0, 'ADMINISTRATOR bit must not land');
});

await test('ESCALATION: role editor cannot add MANAGE_UNITS they do not hold', async () => {
  const res = await call('PUT', `/api/roles/${clerk.id}`, {
    token: hayes, body: { permissions: clerk.permissions | P.MANAGE_UNITS },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'escalation');
});

await test('ESCALATION: role editor cannot add EXPORT_DATA they do not hold', async () => {
  const res = await call('PUT', `/api/roles/${clerk.id}`, {
    token: hayes, body: { permissions: clerk.permissions | P.EXPORT_DATA },
  });
  assert.equal(res.status, 403);
});

await test('a role editor CAN add a permission they do hold (positive control)', async () => {
  const res = await call('PUT', `/api/roles/${clerk.id}`, {
    token: hayes, body: { permissions: clerk.permissions | P.CREATE_SHARED_WORK },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.permissions & P.CREATE_SHARED_WORK);
});

await test('a role cannot be moved to or above the editor position', async () => {
  const res = await call('PUT', `/api/roles/${clerk.id}`, { token: hayes, body: { position: 40 } });
  assert.equal(res.status, 403);
});

await test('SCOPE: nobody can create a role without a unit, administrator included', async () => {
  for (const [who, token] of [['branch manager', hayes], ['administrator', admin]]) {
    const res = await call('POST', '/api/roles', {
      token, body: { name: 'Everywhere', position: 1, permissions: P.VIEW_UNIT },
    });
    assert.equal(res.status, 400, `${who} should get a validation refusal, got ${res.status}`);
    assert.equal(res.body.code, 'invalid');
  }
  const globals = db.prepare('SELECT COUNT(*) AS n FROM roles WHERE unit_id IS NULL').get().n;
  assert.equal(globals, 0, 'a global role row reached the database');
});

await test('SCOPE: non-admin cannot create a role scoped to a foreign command', async () => {
  const res = await call('POST', '/api/roles', {
    token: hayes, body: { name: 'Reach', unit_id: 'CLR-4', position: 1, permissions: P.VIEW_UNIT },
  });
  assert.equal(res.status, 403);
});

await test('SCOPE: lower position does not permit editing a foreign-command role (finding 7)', async () => {
  const res = await call('PUT', `/api/roles/${clrClerk.id}`, { token: hayes, body: { name: 'Hijacked' } });
  assert.equal(res.status, 403);
});

await test('SCOPE: nor deleting one', async () => {
  const res = await call('DELETE', `/api/roles/${clrClerk.id}`, { token: hayes });
  assert.equal(res.status, 403);
});

await test('a role manager CAN delete a role inside their own scope', async () => {
  const doomed = (await call('POST', '/api/roles', {
    token: hayes, body: { name: 'Doomed', unit_id: 'MFR', position: 1, permissions: P.VIEW_UNIT },
  })).body;
  assert.ok(doomed.id, 'creation inside own scope should work');
  const res = await call('DELETE', `/api/roles/${doomed.id}`, { token: hayes });
  assert.equal(res.status, 200);
});

await test('GRANT: a unit-scoped role definition cannot be granted outside its subtree, even by an administrator', async () => {
  const budgetOnly = (await call('POST', '/api/roles', {
    token: admin, body: { name: 'Budget Only', unit_id: 'G8-BUDGET', position: 3, permissions: P.VIEW_UNIT },
  })).body;
  const res = await call('POST', `/api/team/${riveraId}/roles`, {
    token: admin, body: { role_id: budgetOnly.id, unit_id: 'G8-FMRAC' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'scope');
});

await test('GRANT: an existing broad role is not a ladder — granting re-checks delegation', async () => {


  const res = await call('POST', `/api/team/${riveraId}/roles`, {
    token: hayes, body: { role_id: auditor.id, unit_id: 'G8-FMRAC' },
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'escalation');
});

await test('GRANT: a role at or above your own stays out of reach', async () => {


  const res = await call('POST', `/api/team/${riveraId}/roles`, {
    token: hayes, body: { role_id: 'G8-FMRAC:sncoic', unit_id: 'G8-FMRAC' },
  });
  assert.equal(res.status, 403);
});

await test('an administrator can still do all of it', async () => {
  const edited = await call('PUT', `/api/roles/${clerk.id}`, {
    token: admin, body: { permissions: clerk.permissions | P.CREATE_SHARED_WORK | P.MANAGE_UNITS },
  });
  assert.equal(edited.status, 200);

  const reset = await call('PUT', `/api/roles/${clerk.id}`, {
    token: admin, body: { permissions: P.VIEW_UNIT | P.VIEW_RECORDS },
  });
  assert.equal(reset.status, 200);
  const granted = await call('POST', `/api/team/${riveraId}/roles`, {
    token: admin, body: { role_id: auditor.id, unit_id: 'G8-FMRAC' },
  });
  assert.equal(granted.status, 200);
  await call('DELETE', `/api/team/${riveraId}/roles/${auditor.id}?unit_id=G8-FMRAC`, { token: admin });
});

await test('permission bits outside the catalogue are rejected outright', async () => {
  const res = await call('POST', '/api/roles', {
    token: admin, body: { name: 'Ghost Bits', position: 1, permissions: 1 << 30 },
  });
  assert.equal(res.status, 400);
});

await test('TRANSFER: authority over the destination alone cannot pull a Marine out of a foreign unit', async () => {

  const res = await call('PUT', `/api/team/${riveraId}/assignment`, {
    token: nguyen, body: { unit_id: 'CLR-4' },
  });
  assert.equal(res.status, 403);
});

await test('TRANSFER: a leader cannot reassign a Marine whose role is at or above their own', async () => {
  await makeUser(admin, { username: 'kim', unit_id: 'G8-BUDGET', rank_id: 'GySgt' });
  const kimId = fixtureId((await call('GET', '/api/team', { token: admin })).body.roster, 'kim');

  await call('POST', `/api/team/${kimId}/roles`, { token: admin, body: { role_id: 'G8-BUDGET:sncoic', unit_id: 'G8-BUDGET' } });
  const res = await call('PUT', `/api/team/${kimId}/assignment`, {
    token: hayes, body: { unit_id: 'G8-FMRAC' },
  });
  assert.equal(res.status, 403);
});

await test('TRANSFER: old-unit roles are revoked and live sessions recompute scope (finding 2)', async () => {
  await makeUser(admin, { username: 'diaz', unit_id: 'G8-FMRAC' });
  const diazId = fixtureId((await call('GET', '/api/team', { token: admin })).body.roster, 'diaz');
  await call('POST', `/api/team/${diazId}/roles`, { token: admin, body: { role_id: clerk.id, unit_id: 'G8-FMRAC' } });
  const diazToken = await login('diaz', PW('diaz'));
  assert.ok(diazToken, 'diaz should sign in');

  const moved = await call('PUT', `/api/team/${diazId}/assignment`, {
    token: hayes, body: { unit_id: 'G8-BUDGET' },
  });
  assert.equal(moved.status, 200);
  assert.ok(moved.body.revokedRoles.includes('Clerk'), `revoked: ${JSON.stringify(moved.body.revokedRoles)}`);
  assert.equal(moved.body.sessionsRevoked, 0, 'a unit-local transfer does not need account-wide session authority');

  const refreshed = await call('GET', '/api/me', { token: diazToken });
  assert.equal(refreshed.status, 200, 'the session remains usable');
  assert.ok(refreshed.body.unitIds.includes('G8-BUDGET'), 'the same session sees the new scope immediately');
  assert.ok(!refreshed.body.unitIds.includes('G8-FMRAC'), 'the old scope is gone immediately');

  const record = await call('GET', `/api/team/${diazId}`, { token: admin });
  assert.ok(!record.body.roles.some((r) => r.unit_id === 'G8-FMRAC'), 'no grant may remain in the old unit');


  assert.ok(
    record.body.roles.some((r) => r.id === 'G8-BUDGET:marine' && r.unit_id === 'G8-BUDGET'),
    `baseline role follows to the new unit: ${JSON.stringify(record.body.roles.map((r) => r.id))}`
  );
});

await test('TRANSFER: an explicitly retained collateral role survives', async () => {
  await makeUser(admin, { username: 'park', unit_id: 'G8-FMRAC' });
  const parkId = fixtureId((await call('GET', '/api/team', { token: admin })).body.roster, 'park');
  await call('POST', `/api/team/${parkId}/roles`, { token: admin, body: { role_id: clerk.id, unit_id: 'G8-FMRAC' } });
  const moved = await call('PUT', `/api/team/${parkId}/assignment`, {
    token: hayes, body: { unit_id: 'G8-BUDGET', retain_role_ids: [clerk.id] },
  });
  assert.equal(moved.status, 200);
  assert.ok(moved.body.retainedRoles.includes('Clerk'));
  const record = await call('GET', `/api/team/${parkId}`, { token: admin });
  assert.ok(record.body.roles.some((r) => r.id === clerk.id && r.unit_id === 'G8-FMRAC'));
});

await test('TRANSFER: "retain" cannot keep alive a role the actor could not grant', async () => {
  await makeUser(admin, { username: 'lee', unit_id: 'G8-FMRAC' });
  const leeId = fixtureId((await call('GET', '/api/team', { token: admin })).body.roster, 'lee');
  await call('POST', `/api/team/${leeId}/roles`, { token: admin, body: { role_id: auditor.id, unit_id: 'G8-FMRAC' } });
  const moved = await call('PUT', `/api/team/${leeId}/assignment`, {
    token: hayes, body: { unit_id: 'G8-BUDGET', retain_role_ids: [auditor.id] },
  });
  assert.equal(moved.status, 200);
  assert.ok(moved.body.revokedRoles.includes('Auditor'), 'EXPORT_DATA-bearing role must not survive via retain');
  assert.ok(!moved.body.retainedRoles.includes('Auditor'));
});

await test('access review flags a role granted where the Marine is not a member', async () => {


  db.prepare(
    `INSERT INTO member_roles (id, user_id, role_id, unit_id, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(`orphan-${Date.now()}`, riveraId, clerkBudget.id, 'G8-BUDGET', adminId);

  const res = await call('GET', `/api/team/${riveraId}/access`, { token: admin });
  assert.equal(res.status, 200);
  assert.ok(
    res.body.roles.some((r) => r.unit_id === 'G8-BUDGET' && r.orphaned),
    'a grant with no membership behind it must be flagged'
  );
  assert.ok(res.body.findings.some((f) => f.includes('not a member')));
  db.prepare('DELETE FROM member_roles WHERE user_id = ? AND unit_id = ?').run(riveraId, 'G8-BUDGET');
});

await test('DEACTIVATION: kills live sessions, blocks sign-in, hides from the roster', async () => {
  await makeUser(admin, { username: 'sneak', unit_id: 'G8-FMRAC' });
  const sneakId = fixtureId((await call('GET', '/api/team', { token: admin })).body.roster, 'sneak');
  const sneakToken = await login('sneak', PW('sneak'));
  assert.ok(sneakToken);

  const off = await call('POST', `/api/team/${sneakId}/deactivate`, { token: admin });
  assert.equal(off.status, 200);
  assert.ok(off.body.sessionsRevoked >= 1);

  assert.equal((await call('GET', '/api/me', { token: sneakToken })).status, 401, 'live session must die');
  assert.equal(await login('sneak', PW('sneak')), undefined, 'sign-in must fail while deactivated');
  const rosterNow = (await call('GET', '/api/team', { token: admin })).body.roster;
  assert.ok(!rosterNow.some((r) => r.first_name === fixtureFirstName('sneak')), 'deactivated accounts leave the roster');

  const on = await call('POST', `/api/team/${sneakId}/reactivate`, { token: admin });
  assert.equal(on.status, 200);
  assert.ok(await login('sneak', PW('sneak')), 'reactivation restores sign-in');
});

await test('a Marine cannot deactivate their leader, and nobody deactivates themselves', async () => {
  assert.equal((await call('POST', `/api/team/${hayesId}/deactivate`, { token: rivera })).status, 403);
  assert.equal((await call('POST', `/api/team/${adminId}/deactivate`, { token: admin })).status, 400);
});

await test('the last active administrator cannot be deactivated', async () => {






  await makeUser(admin, { username: 'orphanrisk', unit_id: 'G8-BUDGET' });
  const orphanId = fixtureId((await call('GET', '/api/team', { token: admin })).body.roster, 'orphanrisk');
  db.prepare("INSERT INTO units (id, code, name, echelon, level, active, created_at) VALUES ('ORPHAN-CELL','ORPHAN-CELL','Orphan Cell','fire_team','L4',1,datetime('now'))").run();
  db.prepare("UPDATE units SET owner_user_id = ? WHERE id = 'ORPHAN-CELL'").run(orphanId);

  const operatorUser = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
  const result = deactivateMember(db, operatorUser, orphanId);
  assert.equal(result.ok, false, 'deactivating a Unit Owner must be refused');
  assert.equal(result.code, 'last_owner', `unexpected code ${result.code}`);
});

await test('a unit manager cannot reset a global account password', async () => {
  const live = await login('rivera', PW('rivera'));
  const denied = await call('POST', `/api/team/${riveraId}/password`, {
    token: hayes, body: { password: 'manager-must-not-own-this-account' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'not_operator');
  assert.equal((await call('GET', '/api/me', { token: live })).status, 200, 'the refused reset must not revoke sessions');
});

await test('operator password reset invalidates sessions and requires replacement of the temporary password', async () => {
  const s1 = await login('rivera', PW('rivera'));
  const res = await call('POST', `/api/team/${riveraId}/password`, {
    token: admin, body: { password: 'a-brand-new-passphrase' },
  });
  assert.equal(res.status, 200);
  assert.equal((await call('GET', '/api/me', { token: s1 })).status, 401);
  assert.equal(await login('rivera', PW('rivera')), undefined, 'old password must fail');
  const fresh = await login('rivera', 'a-brand-new-passphrase');
  assert.ok(fresh);
  const blocked = await call('GET', '/api/activities', { token: fresh });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, 'password_change_required');
  const changed = await call('POST', '/api/me/password', {
    token: fresh,
    body: { current_password: 'a-brand-new-passphrase', new_password: PW('rivera') },
  });
  assert.equal(changed.status, 200);

  assert.ok(await login('rivera', PW('rivera')));
});

await test('self-service password change keeps this session and cuts the others', async () => {
  const keep = await login('ohara', PW('ohara'));
  const other = await login('ohara', PW('ohara'));
  const res = await call('POST', '/api/me/password', {
    token: keep, body: { current_password: PW('ohara'), new_password: 'oharas-second-passphrase' },
  });
  assert.equal(res.status, 200);
  assert.equal((await call('GET', '/api/me', { token: other })).status, 401, 'other session must die');
  assert.equal((await call('GET', '/api/me', { token: keep })).status, 200, 'this session survives');
  assert.equal((await call('POST', '/api/me/password', {
    token: keep, body: { current_password: 'wrong-wrong-wrong', new_password: 'whatever-whatever' },
  })).status, 403, 'wrong current password is refused');
  await call('POST', '/api/me/password', {
    token: keep, body: { current_password: 'oharas-second-passphrase', new_password: PW('ohara') },
  });
});

await test('force logout ends every session the account holds', async () => {
  const a = await login('rivera', PW('rivera'));
  const b = await login('rivera', PW('rivera'));
  const res = await call('POST', `/api/team/${riveraId}/logout`, { token: admin });
  assert.equal(res.status, 200);
  assert.equal((await call('GET', '/api/me', { token: a })).status, 401);
  assert.equal((await call('GET', '/api/me', { token: b })).status, 401);
});

rivera = await login('rivera', PW('rivera'));
ohara = await login('ohara', PW('ohara'));

await test('the auth cookie is a session cookie: HttpOnly, SameSite=Strict, no Expires/Max-Age', async () => {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boletz', password: 'cobalt-orbit-velvet-anchor-927' }),
  });
  const cookie = res.headers.get('set-cookie') || '';
  assert.ok(/vantage_session=/.test(cookie), 'cookie must be set');
  assert.ok(/httponly/i.test(cookie), 'HttpOnly required');
  assert.ok(/samesite=strict/i.test(cookie), 'SameSite=Strict required');
  assert.ok(!/expires=/i.test(cookie) && !/max-age=/i.test(cookie), 'must be a session cookie — no persistence');
});

await test('cookie-authenticated writes require the client header (CSRF backstop)', async () => {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boletz', password: 'cobalt-orbit-velvet-anchor-927' }),
  });
  const token = (res.headers.get('set-cookie') || '').match(/vantage_session=([^;]+)/)?.[1];
  assert.ok(token);
  const cookieHeaders = { cookie: `vantage_session=${token}` };
  const noHeader = await call('POST', '/api/activities', {
    headers: cookieHeaders, body: { title: 'CSRF probe', date: '2026-08-01' },
  });
  assert.equal(noHeader.status, 403);
  assert.equal(noHeader.body.code, 'csrf');
  const withHeader = await call('POST', '/api/activities', {
    headers: { ...cookieHeaders, 'x-vantage-client': '1' }, body: { title: 'CSRF probe ok', date: '2026-08-01' },
  });
  assert.equal(withHeader.status, 200);
  const read = await call('GET', '/api/me', { headers: cookieHeaders });
  assert.equal(read.status, 200, 'reads need no header');
});

await test('malformed credentials are 401, not 500', async () => {
  assert.equal((await call('GET', '/api/me', { token: 'not-a-real-token' })).status, 401);
  assert.equal((await call('GET', '/api/me', { headers: { cookie: 'vantage_session=garbage' } })).status, 401);
  assert.equal((await call('GET', '/api/me', { headers: { authorization: 'Bearer' } })).status, 401);
});

await test('CREATE_SHARED_WORK alone cannot post goals to a foreign unit', async () => {
  const workOnly = (await call('POST', '/api/roles', {
    token: admin, body: { name: 'Work Only', unit_id: 'G8-BUDGET', position: 2, permissions: P.VIEW_UNIT | P.CREATE_SHARED_WORK },
  })).body;






  await call('POST', '/api/org/units/G8-BUDGET/members', {
    token: admin,
    body: {
      user_id: riveraId, role_id: workOnly.id, kind: 'guest',
      expires_at: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
    },
  });

  const goal = await call('POST', '/api/goals', {
    token: rivera, body: { title: 'Smuggled goal', visibility: 'unit', unit_id: 'G8-BUDGET' },
  });
  assert.equal(goal.status, 403, 'goals need CREATE_SHARED_GOALS');
  const task = await call('POST', '/api/tasks', {
    token: rivera, body: { title: 'Legitimate tasking', visibility: 'unit', unit_id: 'G8-BUDGET' },
  });
  assert.equal(task.status, 200, 'work permission still posts work');
});

await test('CREATE_SHARED_GOALS alone cannot post tasks to a foreign unit', async () => {
  const goalsOnly = (await call('POST', '/api/roles', {
    token: admin, body: { name: 'Goals Only', unit_id: 'G8-BUDGET', position: 2, permissions: P.VIEW_UNIT | P.CREATE_SHARED_GOALS },
  })).body;
  await call('POST', '/api/org/units/G8-BUDGET/members', {
    token: admin,
    body: {
      user_id: oharaId, role_id: goalsOnly.id, kind: 'guest',
      expires_at: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
    },
  });

  const task = await call('POST', '/api/tasks', {
    token: ohara, body: { title: 'Smuggled tasking', visibility: 'unit', unit_id: 'G8-BUDGET' },
  });
  assert.equal(task.status, 403);
  const goal = await call('POST', '/api/goals', {
    token: ohara, body: { title: 'Legitimate goal', visibility: 'unit', unit_id: 'G8-BUDGET' },
  });
  assert.equal(goal.status, 200);
});

await test('the server rejects garbage a hand-built request can send', async () => {
  const bad = [
    [{ date: '2026-08-01' }, 'title'],
    [{ title: 'x', date: 'banana' }, 'date'],
    [{ title: 'x', date: '2026-02-31' }, 'date'],
    [{ title: 'x', dollar_amount: 'Infinity' }, 'dollar_amount'],
    [{ title: 'x', quantity: -5 }, 'quantity'],
    [{ title: 'x'.repeat(400) }, 'title'],
    [{ title: 'null\u0000byte' }, 'title'],
    [{ title: 'x', visibility: 'public' }, 'visibility'],
    [{ title: 'x', category: 'Skulduggery' }, 'category'],
    [{ title: 'x', evidence_links: [{ url: 'javascript:alert(1)' }] }, 'evidence_links'],
  ];
  for (const [body, field] of bad) {
    const res = await call('POST', '/api/activities', { token: rivera, body });
    assert.equal(res.status, 400, `${field}: expected 400, got ${res.status}`);
    assert.ok(res.body.fieldErrors?.[field], `${field}: must be named in fieldErrors`);
  }
});

await test('readiness inputs are rejected out of range, never clamped (finding 21)', async () => {
  for (const [body, field] of [
    [{ pft_score: 999999 }, 'pft_score'],
    [{ cft_score: -500 }, 'cft_score'],
    [{ cmd_leadership: 99 }, 'cmd_leadership'],
    [{ ceus: 'Infinity' }, 'ceus'],
    [{ rifle_qual: 'Legendary' }, 'rifle_qual'],
  ]) {
    const res = await call('PUT', '/api/readiness', { token: rivera, body });
    assert.equal(res.status, 400, `${field}: expected 400, got ${res.status}`);
    assert.ok(res.body.fieldErrors?.[field]);
  }
  const before = (await call('GET', '/api/readiness', { token: rivera })).body;
  assert.notEqual(before.pft_score, 999999, 'nothing may have been stored');
});

await test('a record cannot be pinned to an arbitrary unit (finding 38)', async () => {
  const res = await call('POST', '/api/activities', {
    token: nguyen, body: { title: 'Planted in G-8', date: '2026-08-01', visibility: 'private', unit_id: 'G8-FMRAC' },
  });
  assert.equal(res.status, 403);
});

await test('user creation validates username, password and unit server-side', async () => {
  const bad = await call('POST', '/api/team', {
    token: admin,
    body: { username: 'bad name!', password: 'short', first_name: 'A', last_name: 'B', unit_id: 'NOWHERE' },
  });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fieldErrors.username && bad.body.fieldErrors.password && bad.body.fieldErrors.unit_id);
});

await test('tasking a Marine outside your scope is refused', async () => {
  const res = await call('POST', '/api/tasks', {
    token: hayes, body: { title: 'Cross-command tasking', assignee_id: nguyenId, visibility: 'private' },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.fieldErrors.assignee_id);
});

await test('tasking into a unit the assignee does not serve in is refused', async () => {



  const res = await call('POST', '/api/tasks', {
    token: admin, body: { title: 'Wrong shop', visibility: 'unit', unit_id: 'CLR-4', assignee_id: riveraId },
  });
  assert.equal(res.status, 400, `expected a validation refusal, got ${res.status}`);
  assert.ok(res.body.fieldErrors.assignee_id, `expected an assignee_id field error: ${JSON.stringify(res.body)}`);
  const ok = await call('POST', '/api/tasks', {
    token: hayes, body: { title: 'Right shop', visibility: 'unit', unit_id: 'G8-FMRAC', assignee_id: riveraId },
  });
  assert.equal(ok.status, 200);
});

await test('a ghost assignee is refused', async () => {
  const res = await call('POST', '/api/tasks', {
    token: hayes, body: { title: 'To nobody', assignee_id: 'no-such-user', visibility: 'private' },
  });
  assert.equal(res.status, 400);
});

await test('imports beyond the row limit are refused before any insert', async () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ title: `Row ${i}`, date: '2026-08-01' }));
  const res = await call('POST', '/api/activities/bulk', { token: rivera, body: { rows } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'too_many_rows');
});

await test('one invalid row fails the import with its row number', async () => {
  const res = await call('POST', '/api/activities/bulk', {
    token: rivera, body: { rows: [{ title: 'Fine', date: '2026-08-01' }, { title: 'Bad date', date: 'yesterday' }] },
  });
  assert.equal(res.status, 400);
  assert.ok(res.body.error.startsWith('Row 2:'), res.body.error);
});

await test('DUPLICATES: the same import run twice lands each row exactly once (finding 13)', async () => {
  const rows = [{ title: 'Reconciled 30 ULOs', date: '2026-08-05', quantity: 30, dollar_amount: 1118.38 }];
  const first = await call('POST', '/api/activities/bulk', { token: rivera, body: { rows } });
  assert.equal(first.body.created, 1);
  const second = await call('POST', '/api/activities/bulk', {
    token: rivera, body: { rows: [...rows, { title: 'A different entry', date: '2026-08-06' }] },
  });
  assert.equal(second.body.created, 1, 'only the new row lands');
  assert.equal(second.body.duplicates, 1);
  const list = await call('GET', '/api/activities', { token: rivera });
  assert.equal(list.body.filter((a) => a.title === 'Reconciled 30 ULOs').length, 1);
});

await test('duplicate protection is per-Marine — the same row from another user still lands', async () => {
  const rows = [{ title: 'Reconciled 30 ULOs', date: '2026-08-05', quantity: 30, dollar_amount: 1118.38 }];
  const res = await call('POST', '/api/activities/bulk', { token: ohara, body: { rows } });
  assert.equal(res.body.created, 1);
});

await test('deleting a project unlinks its tasks and activities, as the client has always claimed', async () => {
  const project = (await call('POST', '/api/projects', { token: rivera, body: { name: 'FY Closeout' } })).body;
  const task = (await call('POST', '/api/tasks', {
    token: rivera, body: { title: 'Linked task', project_id: project.id },
  })).body;
  const act = (await call('POST', '/api/activities', {
    token: rivera, body: { title: 'Linked activity', date: '2026-08-07', project_id: project.id },
  })).body;

  const del = await call('DELETE', `/api/projects/${project.id}`, { token: rivera });
  assert.equal(del.status, 200);

  const tasks = await call('GET', '/api/tasks', { token: rivera });
  assert.equal(tasks.body.find((t) => t.id === task.id).project_id, null, 'task must be unlinked');
  const acts = await call('GET', '/api/activities', { token: rivera });
  assert.equal(acts.body.find((a) => a.id === act.id).project_id, null, 'activity must be unlinked');
});

await test('a stale edit is refused with the current copy, not silently overwritten', async () => {
  const created = (await call('POST', '/api/activities', {
    token: rivera, body: { title: 'Contested entry', date: '2026-08-08' },
  })).body;
  assert.equal(created.version, 1);

  const first = await call('PUT', `/api/activities/${created.id}`, {
    token: rivera, body: { title: 'First editor wins', version: 1 },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 2);

  const stale = await call('PUT', `/api/activities/${created.id}`, {
    token: rivera, body: { title: 'Second editor, old copy', version: 1 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'stale');
  assert.equal(stale.body.current.title, 'First editor wins');

  const retry = await call('PUT', `/api/activities/${created.id}`, {
    token: rivera, body: { title: 'Second editor, reloaded', version: stale.body.current.version },
  });
  assert.equal(retry.status, 200);
});

await test('VIEW_AUDIT reads the unit log inside the holder scope and nowhere else', async () => {
  const ok = await call('GET', '/api/audit/unit?unit_id=G8-FMRAC', { token: hayes });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.rows.length > 0, 'FMRAC has activity to show');
  assert.ok(ok.body.rows.every((r) => r.unit_id === 'G8-FMRAC'));

  assert.equal((await call('GET', '/api/audit/unit?unit_id=G8-FMRAC', { token: nguyen })).status, 403, 'a foreign leader is refused');
  assert.equal((await call('GET', '/api/audit/unit?unit_id=G8-FMRAC', { token: rivera })).status, 403, 'a member without VIEW_AUDIT is refused');
});

await test('EXPORT_DATA is enforced server-side and private records never leave (finding 25)', async () => {
  await call('POST', '/api/activities', {
    token: rivera, body: { title: 'Private counseling note', date: '2026-08-09', visibility: 'private' },
  });
  assert.equal((await call('GET', '/api/export?unit_id=G8-FMRAC', { token: rivera })).status, 403);
  assert.equal((await call('GET', '/api/export?unit_id=G8-FMRAC', { token: hayes })).status, 403, 'hayes holds no EXPORT_DATA');




  const res = await call('GET', '/api/export?unit_id=G8-FMRAC', { token: admin });
  assert.equal(res.status, 200);
  assert.ok(res.body.activities.length > 0, 'shared records export');
  assert.ok(
    res.body.activities.every((a) => a.unit_id === 'G8-FMRAC' || !a.unit_id),
    'an export must not contain another unit\'s records'
  );
  assert.ok(!res.body.activities.some((a) => a.title === 'Private counseling note'), 'private records must not export');
});

await test('repeated failures against one account lock the account, and success clears it', async () => {
  resetCounters();
  let last;
  for (let i = 0; i < LOGIN_LIMITS.USER_MAX + 1; i += 1) {
    last = await call('POST', '/api/login', { body: { username: 'rivera', password: 'wrong-password-here' } });
    if (last.status === 429) break;

    await call('POST', '/api/login', { body: { username: 'boletz', password: 'cobalt-orbit-velvet-anchor-927' } });
  }
  assert.equal(last.status, 429, 'the account threshold must trip');
  assert.ok(last.headers.get('retry-after'), 'Retry-After must be set');
  resetCounters();
  assert.ok(await login('rivera', PW('rivera')), 'a real sign-in works once the window clears');
});

await test('failures from one connection trip the per-IP limit even across usernames', async () => {
  resetCounters();
  let last;
  for (let i = 0; i < LOGIN_LIMITS.IP_MAX + 1; i += 1) {
    last = await call('POST', '/api/login', { body: { username: `ghost-${i}`, password: 'whatever-whatever' } });
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  resetCounters();
});

server.close();
try { rmSync(DB, { force: true }); rmSync(`${DB}-wal`, { force: true }); rmSync(`${DB}-shm`, { force: true }); } catch {  }

const failed = results.filter(([s]) => s === 'FAIL');
for (const [status, name] of results) {
  console.log(`  ${status === 'PASS' ? 'ok  ' : 'FAIL'}  ${name}`);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
