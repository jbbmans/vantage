import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, PASSWORD, type TestApp } from './helpers.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';
import { totpCode } from '../../server/auth/totp.ts';
import { sanitizeEmailHtml } from '../../server/lib/sanitizeHtml.ts';
import { parseMaradminFeed } from '../../server/services/maradmins.ts';
import { resetLimiters } from '../../server/auth/limiter.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let sncoic: { token: string; id: string };
let marine: { token: string; id: string };
let outsider: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  sncoic = await app.register('sncoic', { rank_id: 'GySgt' });
  marine = await app.register('marine');
  outsider = await app.register('outsider');
  await enroll(app, op.token, 'G8', sncoic.id, 'sncoic');
  await enroll(app, op.token, 'G8', marine.id);
  sncoic.token = (await app.login('sncoic')).body.token;
  marine.token = (await app.login('marine')).body.token;
});
after(() => app.close());

test('a unit of your own does not let you enroll, look up or read a Marine you do not lead', async () => {
  const rogue = await app.call('POST', '/api/org/units', { token: outsider.token, body: { name: 'Rogue', short_name: 'ROGUE' } });
  assert.equal(rogue.status, 201, JSON.stringify(rogue.body));
  const token = (await app.login('outsider')).body.token;

  const found = await app.call('GET', '/api/org/directory?unit_id=ROGUE&q=mar', { token });
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.results, [], 'the directory only offers people the caller already leads');

  const enrolled = await app.call('POST', '/api/org/units/ROGUE/members', { token, body: { user_id: marine.id } });
  assert.equal(enrolled.status, 403);
  assert.equal(enrolled.body.code, 'invite_required');
  assert.equal((await app.call('GET', `/api/me/readiness/${marine.id}`, { token })).status, 403);
  assert.equal((await app.call('PUT', `/api/org/team/${marine.id}/profile`, { token, body: { first_name: 'Changed' } })).status, 403);
});

test('a leader may enroll the Marines they lead, but not the commander above them', async () => {
  const side = await app.call('POST', '/api/org/units', { token: sncoic.token, body: { name: 'Side cell', short_name: 'SIDE' } });
  assert.equal(side.status, 201, JSON.stringify(side.body));
  const token = (await app.login('sncoic')).body.token;

  const lookup = await app.call('GET', '/api/org/directory?unit_id=SIDE&q=mar', { token });
  assert.deepEqual(lookup.body.results.map((r: { id: string }) => r.id), [marine.id]);
  assert.equal((await app.call('POST', '/api/org/units/SIDE/members', { token, body: { user_id: marine.id } })).status, 201);

  const commander = await app.call('POST', '/api/org/units/SIDE/members', { token, body: { user_id: op.id } });
  assert.equal(commander.status, 403);
  assert.equal(commander.body.code, 'invite_required');
});

test('a role carrying permissions you do not hold cannot be granted, invited or put on a join code', async () => {
  const deputy = await app.call('POST', '/api/org/roles', { token: op.token, body: { unit_id: 'G8', name: 'Deputy', position: 10, permissions: PERMISSIONS.ADMINISTRATOR } });
  assert.equal(deputy.status, 201, JSON.stringify(deputy.body));
  const token = (await app.login('sncoic')).body.token;

  const self = await app.call('POST', `/api/org/team/${sncoic.id}/roles`, { token, body: { role_id: deputy.body.id, unit_id: 'G8' } });
  assert.equal(self.status, 403, 'granting yourself a lower role must not raise your own permissions');
  assert.equal(self.body.code, 'delegation');
  assert.equal((await app.call('POST', `/api/org/team/${marine.id}/roles`, { token, body: { role_id: deputy.body.id, unit_id: 'G8' } })).body.code, 'delegation');
  assert.equal((await app.call('POST', '/api/org/units/G8/invites', { token, body: { role_id: deputy.body.id } })).body.code, 'delegation');
  assert.equal((await app.call('POST', '/api/org/units/G8/join-codes', { token, body: { role_id: deputy.body.id } })).body.code, 'delegation');

  const nco = await app.call('POST', '/api/org/units/G8/join-codes', { token, body: { role_id: 'G8:nco' } });
  assert.equal(nco.status, 201, 'a role within your own permissions is still fine');
  const leader = await app.call('POST', '/api/org/units/G8/join-codes', { token: op.token, body: { role_id: 'G8:unit-leader' } });
  assert.equal(leader.status, 400, 'Unit Leader moves only by ownership transfer');
});

test('a manager cannot edit the membership of someone at or above them', async () => {
  const token = (await app.login('sncoic')).body.token;
  assert.equal((await app.call('PUT', `/api/org/units/G8/members/${op.id}`, { token, body: { billet: 'Clerk' } })).status, 403);
  assert.equal((await app.call('PUT', `/api/org/units/G8/members/${marine.id}`, { token, body: { billet: 'Clerk' } })).status, 200);
});

test('an authenticator code works once, and starting setup again leaves the old one in force', async () => {
  const u = await app.register('twofactor');
  const start = await app.call('POST', '/api/me/mfa/totp/start', { token: u.token });
  const step = Math.floor(Date.now() / 30000);
  assert.equal((await app.call('POST', '/api/me/mfa/totp/confirm', { token: u.token, body: { code: totpCode(start.body.secret, step) } })).status, 200);

  const first = await app.login('twofactor');
  const reused = await app.call('POST', '/api/auth/login/mfa', { body: { challenge: first.body.challenge, code: totpCode(start.body.secret, step) } });
  assert.equal(reused.status, 401, 'the code that confirmed setup is spent');
  const next = totpCode(start.body.secret, step + 1);
  assert.equal((await app.call('POST', '/api/auth/login/mfa', { body: { challenge: first.body.challenge, code: next } })).status, 200);
  const second = await app.login('twofactor');
  assert.equal((await app.call('POST', '/api/auth/login/mfa', { body: { challenge: second.body.challenge, code: next } })).status, 401, 'a code cannot be replayed');

  const fresh = (await app.call('POST', '/api/auth/login/mfa', { body: { challenge: second.body.challenge, code: totpCode(start.body.secret, step - 1) } }));
  assert.equal(fresh.status, 401, 'an older step than the last one used is refused too');

  const again = await app.call('POST', '/api/me/mfa/totp/start', { token: u.token });
  assert.equal(again.status, 200);
  assert.equal((await app.login('twofactor')).body.mfa, 'totp', 'abandoning a new setup does not switch two-factor off');
  const me = await app.call('GET', '/api/me', { token: u.token });
  assert.equal(me.body.user.totp_pending, undefined);
  assert.equal(me.body.user.totp_last_step, undefined);
});

test('guessing the current password on the change-password form is throttled', async () => {
  resetLimiters();
  const u = await app.register('guesser');
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await app.call('POST', '/api/me/password', { token: u.token, body: { current_password: `wrong-${i}`, new_password: `${PASSWORD}!x` } })).status, 403);
  }
  const blocked = await app.call('POST', '/api/me/password', { token: u.token, body: { current_password: PASSWORD, new_password: `${PASSWORD}!x` } });
  assert.equal(blocked.status, 429);
  resetLimiters();
});

test('reset emails to one account are capped however many connections ask', async () => {
  resetLimiters();
  const before = app.ctx.mailer.outbox.filter((m) => m.kind === 'reset').length;
  for (let i = 0; i < 6; i += 1) {
    const r = await app.call('POST', '/api/auth/forgot', { body: { identifier: 'boletz' } });
    assert.equal(r.status, 200, 'the response never reveals the cap');
  }
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(app.ctx.mailer.outbox.filter((m) => m.kind === 'reset').length - before, 3);
  resetLimiters();
});

test('evidence links accept web and mail addresses only, however the scheme is disguised', async () => {
  const token = (await app.login('marine')).body.token;
  for (const url of ['\u0001javascript:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd']) {
    const r = await app.call('POST', '/api/records/activities', { token, body: { title: `Link ${url.length}`, date: '2026-09-01', evidence_links: [{ label: 'x', url }] } });
    assert.equal(r.status, 400, `accepted ${JSON.stringify(url)}`);
  }
  const ok = await app.call('POST', '/api/records/activities', { token, body: { title: 'Good link', date: '2026-09-01', evidence_links: [{ label: 'x', url: 'https://www.marines.mil/' }] } });
  assert.equal(ok.status, 201);
});

test('a help request goes only to a unit the requester belongs to', async () => {
  const token = (await app.login('outsider')).body.token;
  const r = await app.call('POST', '/api/support/tickets', { token, body: { subject: 'Hi', body: 'Help', unit_id: 'G8' } });
  assert.equal(r.status, 400);
  assert.equal((await app.call('POST', '/api/support/tickets', { token, body: { subject: 'Hi', body: 'Help' } })).status, 201);
});

test('the browser may talk only to this server and the AI gateway the owner console checks', async () => {
  const r = await app.call('GET', '/api/health');
  const connect = /connect-src ([^;]*);/.exec(r.headers.get('content-security-policy') || '')?.[1].trim().split(/\s+/);
  assert.deepEqual(connect, ["'self'", new URL(app.ctx.config.ai.baseUrl).origin]);
});

test('email HTML cannot break out of an attribute', () => {
  const out = sanitizeEmailHtml(`<a href='https://x" style="position:fixed;inset:0' title='a"b'>go</a><img src='data:image/png;base64,AA" onerror="x' alt='q"r'>`).html;
  assert.doesNotMatch(out, /" style=/);
  assert.doesNotMatch(out, /" onerror=/);
  assert.match(out, /href="https:\/\/x&quot; style=&quot;/);
});

test('a MARADMIN whose link is not an https address is skipped', () => {
  const item = (link: string) => `<item><title>MARADMIN 123/26 TEST</title><link>${link}</link><description>MARADMIN 123/26</description><pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate></item>`;
  assert.equal(parseMaradminFeed(`<rss>${item('javascript:alert(1)')}</rss>`).length, 0);
  assert.equal(parseMaradminFeed(`<rss>${item('https://www.marines.mil/News/Messages/')}</rss>`).length, 1);
});

test('the demo guard cannot be sidestepped with capitals or a trailing slash', async () => {
  const demo = await startApp({ VANTAGE_ACCESS_MODE: 'demo' });
  try {
    const start = await demo.call('POST', '/api/demo/start', { headers: { 'x-vantage-client': '1' } });
    const token = start.body.token as string;
    for (const [method, path] of [['GET', '/api/ADMIN/overview'], ['GET', '/api/org/Directory?unit_id=x&q=ab'], ['POST', '/api/org/units/'], ['POST', '/api/Me/password']] as const) {
      const r = await demo.call(method, path, { token, body: method === 'POST' ? {} : undefined });
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.body.code, 'demo_mode', `${method} ${path}`);
    }
  } finally { await demo.close(); }
});
