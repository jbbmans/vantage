import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PASSWORD, type TestApp } from './helpers.ts';
import { totpCode } from '../../server/auth/totp.ts';
import { resetLimiters } from '../../server/auth/limiter.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
before(async () => { app = await startApp(); op = await app.setupOperator(); });
after(async () => { await app.close(); });

test('setup runs once and makes the first account an operator with a unit', async () => {
  assert.equal((await app.call('GET', '/api/auth/setup')).body.needsSetup, false);
  const again = await app.call('POST', '/api/auth/setup', { body: { username: 'x', password: PASSWORD, first_name: 'a', last_name: 'b', unit_name: 'c' } });
  assert.equal(again.status, 409);
  const me = await app.call('GET', '/api/me', { token: op.token });
  assert.equal(me.body.user.is_operator, 1);
  assert.equal(me.body.primaryUnitId, 'G8');
  assert.deepEqual(me.body.ownedUnitIds, ['G8']);
  assert.ok(me.body.canLead);
});

test('login rejects bad credentials uniformly and throttles', async () => {
  const bad = await app.login('boletz', 'wrong-password-value');
  assert.equal(bad.status, 401);
  const nobody = await app.login('nobody', 'wrong-password-value');
  assert.equal(nobody.status, 401);
  assert.equal(bad.body.error, nobody.body.error);
  for (let i = 0; i < 10; i += 1) await app.login('boletz', 'wrong-password-value');
  const locked = await app.login('boletz');
  assert.equal(locked.status, 429);
  resetLimiters();
  assert.equal((await app.login('boletz')).status, 200);
});

test('unauthenticated and CSRF-missing requests are rejected', async () => {
  assert.equal((await app.call('GET', '/api/me')).status, 401);
  const res = await fetch(`${app.base}/api/records/activities`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'vantage_session=fake' }, body: '{}' });
  assert.equal(res.status, 401);
});

test('cookie sessions require the client header for writes', async () => {
  const login = await fetch(`${app.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boletz', password: PASSWORD }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const noHeader = await fetch(`${app.base}/api/records/activities`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ title: 'x' }) });
  assert.equal(noHeader.status, 403);
  const withHeader = await fetch(`${app.base}/api/records/activities`, { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-vantage-client': '1' }, body: JSON.stringify({ title: 'x' }) });
  assert.equal(withHeader.status, 201);
  const logout = await fetch(`${app.base}/api/auth/logout`, { method: 'POST', headers: { cookie, 'x-vantage-client': '1' } });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${app.base}/api/me`, { headers: { cookie } })).status, 401);
});

test('self-registration creates an unattached account and can be disabled', async () => {
  const u = await app.register('rivera');
  const me = await app.call('GET', '/api/me', { token: u.token });
  assert.equal(me.body.unitIds.length, 0);
  assert.equal(me.body.canLead, false);
  app.ctx.runtime.selfRegistration = false;
  assert.equal((await app.call('POST', '/api/auth/register', { body: { username: 'zed', password: PASSWORD, first_name: 'Z', last_name: 'Z' } })).status, 404);
  app.ctx.runtime.selfRegistration = true;
});

test('password change, sudo, and session revocation', async () => {
  const u = await app.register('kim');
  const second = await app.login('kim');
  const bad = await app.call('POST', '/api/me/password', { token: u.token, body: { current_password: 'nope', new_password: 'different-strong-passphrase-42' } });
  assert.equal(bad.status, 403);
  const ok = await app.call('POST', '/api/me/password', { token: u.token, body: { current_password: PASSWORD, new_password: 'different-strong-passphrase-42' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.otherSessionsRevoked, 1);
  assert.equal((await app.call('GET', '/api/me', { token: second.body.token })).status, 401);
  assert.equal((await app.login('kim')).status, 401);
  assert.equal((await app.login('kim', 'different-strong-passphrase-42')).status, 200);
  const sessions = await app.call('GET', '/api/me/sessions', { token: u.token });
  assert.ok(sessions.body.sessions.find((s: any) => s.current));
});

test('TOTP enrollment gates login and recovery codes work once', async () => {
  const u = await app.register('totp');
  const sudo = await app.call('POST', '/api/auth/sudo', { token: u.token, body: { password: PASSWORD } });
  assert.equal(sudo.status, 200);
  const start = await app.call('POST', '/api/me/mfa/totp/start', { token: u.token });
  assert.equal(start.status, 200);
  assert.ok(start.body.qr.startsWith('data:image/png'));
  const wrong = await app.call('POST', '/api/me/mfa/totp/confirm', { token: u.token, body: { code: '000000' } });
  assert.ok(wrong.status === 400);
  const code = totpCode(start.body.secret, Math.floor(Date.now() / 30000));
  const confirm = await app.call('POST', '/api/me/mfa/totp/confirm', { token: u.token, body: { code } });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.recoveryCodes.length, 8);
  const login = await app.login('totp');
  assert.equal(login.status, 200);
  assert.equal(login.body.mfa, 'totp');
  assert.ok(!login.body.token);
  const badCode = await app.call('POST', '/api/auth/login/mfa', { body: { challenge: login.body.challenge, code: '123456' } });
  assert.equal(badCode.status, 401);
  const good = await app.call('POST', '/api/auth/login/mfa', { body: { challenge: login.body.challenge, code: totpCode(start.body.secret, Math.floor(Date.now() / 30000)) } });
  assert.equal(good.status, 200);
  assert.ok(good.body.token);
  const login2 = await app.login('totp');
  const rc = confirm.body.recoveryCodes[0];
  assert.equal((await app.call('POST', '/api/auth/login/mfa', { body: { challenge: login2.body.challenge, code: rc } })).status, 200);
  const login3 = await app.login('totp');
  assert.equal((await app.call('POST', '/api/auth/login/mfa', { body: { challenge: login3.body.challenge, code: rc } })).status, 401);
  const sessions = await app.call('GET', '/api/me/sessions', { token: good.body.token });
  assert.ok(sessions.body.sessions.some((s: any) => s.method === 'password+totp'));
  const disable = await app.call('POST', '/api/me/mfa/totp/disable', { token: good.body.token });
  assert.equal(disable.status, 200);
  assert.ok((await app.login('totp')).body.token);
});

test('sudo-gated actions refuse stale sessions', async () => {
  const u = await app.register('stale');
  app.ctx.db.prepare('UPDATE sessions SET sudo_until = NULL').run();
  const res = await app.call('POST', '/api/me/mfa/totp/start', { token: u.token });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'sudo_required');
});

test('forgot password emails a single-use link and resets', async () => {
  const u = await app.register('forgetful', { email: 'forgetful@example.mil' });
  const before = app.ctx.mailer.outbox.length;
  const res = await app.call('POST', '/api/auth/forgot', { body: { identifier: 'Forgetful@Example.mil' } });
  assert.equal(res.status, 200);
  assert.equal(app.ctx.mailer.outbox.length, before + 1);
  const mail = app.ctx.mailer.outbox.at(-1)!;
  const token = decodeURIComponent(mail.text.match(/reset\?token=([^\s]+)/)![1]);
  assert.equal((await app.call('GET', `/api/auth/reset?token=${encodeURIComponent(token)}`)).body.valid, true);
  const unknown = await app.call('POST', '/api/auth/forgot', { body: { identifier: 'nobody@example.mil' } });
  assert.equal(unknown.status, 200);
  const reset = await app.call('POST', '/api/auth/reset', { body: { token, password: 'brand-new-passphrase-for-testing' } });
  assert.equal(reset.status, 200);
  assert.equal((await app.call('GET', '/api/me', { token: u.token })).status, 401);
  assert.equal((await app.call('POST', '/api/auth/reset', { body: { token, password: 'another-brand-new-passphrase-99' } })).status, 400);
  assert.equal((await app.login('forgetful', 'brand-new-passphrase-for-testing')).status, 200);
});

test('invitations create attached accounts with the intended role', async () => {
  const invite = await app.call('POST', '/api/org/units/G8/invites', { token: op.token, body: { email: 'newguy@example.mil', first_name: 'New', last_name: 'Guy', rank_id: 'LCpl', role_id: 'G8:nco', billet: 'Budget Analyst' } });
  assert.equal(invite.status, 201);
  assert.equal(invite.body.emailed, true);
  const token = decodeURIComponent(invite.body.url.split('token=')[1]);
  const peek = await app.call('GET', `/api/auth/invite?token=${encodeURIComponent(token)}`);
  assert.equal(peek.body.valid, true);
  assert.equal(peek.body.unit, 'G8');
  const list = await app.call('GET', '/api/org/units/G8/invites', { token: op.token });
  assert.equal(list.body.invites.length, 1);
  const accept = await app.call('POST', '/api/auth/invite/accept', { body: { token, username: 'newguy', password: PASSWORD, first_name: 'New', last_name: 'Guy', rank_id: 'LCpl' } });
  assert.equal(accept.status, 200);
  const me = await app.call('GET', '/api/me', { token: accept.body.token });
  assert.equal(me.body.primaryUnitId, 'G8');
  assert.equal(me.body.memberships[0].billet, 'Budget Analyst');
  assert.ok(me.body.roles.some((r: any) => r.id === 'G8:nco'));
  assert.equal(me.body.user.email, 'newguy@example.mil');
  assert.equal((await app.call('POST', '/api/auth/invite/accept', { body: { token, username: 'again', password: PASSWORD, first_name: 'A', last_name: 'B' } })).status, 400);
  const linkOnly = await app.call('POST', '/api/org/units/G8/invites', { token: op.token, body: {} });
  assert.equal(linkOnly.status, 201);
  assert.equal(linkOnly.body.emailed, false);
  assert.equal((await app.call('DELETE', `/api/org/invites/${linkOnly.body.id}`, { token: op.token })).status, 200);
});

test('non-leaders cannot invite; hierarchy caps the role', async () => {
  const u = await app.register('plain');
  assert.equal((await app.call('POST', '/api/org/units/G8/invites', { token: u.token, body: {} })).status, 403);
  assert.equal((await app.call('POST', '/api/org/units/G8/invites', { token: op.token, body: { role_id: 'G8:unit-leader' } })).status, 400);
});
