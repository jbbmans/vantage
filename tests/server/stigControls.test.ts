import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { scryptSync, randomBytes } from 'node:crypto';
import { startApp, PASSWORD, type TestApp } from './helpers.ts';
import { isPublicAddress } from '../../server/services/directMail.ts';
import { ClamdSocketScanner } from '../../server/services/scanner.ts';
import { DOD_CONSENT_BANNER } from '../../shared/consent.ts';

const png = (fill: number) => Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(40, fill), Buffer.from('0000000049454e44ae426082', 'hex')]);

test('a session ends after 15 idle minutes, 10 for an owner, and a background poll does not keep it alive', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const marine = await app.register('idlemarine');
    const minutes = (userId: string) => {
      const s = app.ctx.db.prepare('SELECT created_at, expires_at FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(userId) as { created_at: string; expires_at: string };
      return Math.round((Date.parse(s.expires_at) - Date.parse(s.created_at)) / 60_000);
    };
    assert.equal(minutes(marine.id), 15);
    assert.equal(minutes(op.id), 10, 'an instance owner gets the shorter limit');

    // Age the session, then poll in the background: the expiry must not move.
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    app.ctx.db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE user_id = ?').run(old, new Date(Date.now() + 10 * 60_000).toISOString(), marine.id);
    const before = (app.ctx.db.prepare('SELECT expires_at FROM sessions WHERE user_id = ?').get(marine.id) as { expires_at: string }).expires_at;
    const poll = await app.call('GET', '/api/me/notifications?limit=5', { token: marine.token, headers: { 'x-vantage-background': '1' } });
    assert.equal(poll.status, 200);
    assert.equal(poll.headers.get('x-session-expires'), before, 'the client is told when the session ends');
    assert.equal((app.ctx.db.prepare('SELECT expires_at FROM sessions WHERE user_id = ?').get(marine.id) as { expires_at: string }).expires_at, before, 'a poll is not activity');
    await app.call('GET', '/api/me', { token: marine.token });
    assert.notEqual((app.ctx.db.prepare('SELECT expires_at FROM sessions WHERE user_id = ?').get(marine.id) as { expires_at: string }).expires_at, before, 'a request the person made is');
  } finally { await app.close(); }
});

test('a password hashed with scrypt by an earlier version still signs in, and is replaced with PBKDF2', async () => {
  const app = await startApp();
  try {
    await app.setupOperator();
    const salt = randomBytes(16);
    const legacy = `scrypt$16384$8$1$${salt.toString('base64')}$${scryptSync(PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
    app.ctx.db.prepare("UPDATE users SET password_hash = ? WHERE username = 'boletz'").run(legacy);
    assert.equal((await app.login('boletz')).status, 200);
    const hash = (app.ctx.db.prepare("SELECT password_hash FROM users WHERE username = 'boletz'").get() as { password_hash: string }).password_hash;
    assert.match(hash, /^pbkdf2-sha256\$/);
    assert.equal((await app.login('boletz')).status, 200, 'and the new hash signs in');
  } finally { await app.close(); }
});

test('with the DoD banner on, the notice is served and no session is granted until it is accepted', async () => {
  const app = await startApp({ VANTAGE_CONSENT_BANNER: 'dod' });
  try {
    const setup = await app.call('GET', '/api/auth/setup');
    assert.equal(setup.body.consent, DOD_CONSENT_BANNER);
    const first = await app.call('POST', '/api/auth/setup', { body: { username: 'boletz', password: PASSWORD, first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', unit_name: 'G-8', unit_short_name: 'G8' } });
    assert.equal(first.status, 403);
    assert.equal(first.body.code, 'consent_required');
    const accepted = await app.call('POST', '/api/auth/setup', { headers: { 'x-vantage-consent': '1' }, body: { username: 'boletz', password: PASSWORD, first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', unit_name: 'G-8', unit_short_name: 'G8' } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal((await app.login('boletz')).status, 403, 'sign-in without accepting is refused');
    assert.equal((await app.call('POST', '/api/auth/login', { headers: { 'x-vantage-consent': '1' }, body: { username: 'boletz', password: PASSWORD } })).status, 200);
  } finally { await app.close(); }
  await assert.rejects(startApp({ VANTAGE_CONSENT_BANNER: 'custom' }), /VANTAGE_CONSENT_TEXT/);
  const off = await startApp();
  try { assert.equal((await off.call('GET', '/api/auth/setup')).body.consent, null, 'off by default: the public site is not a USG system'); } finally { await off.close(); }
});

test('browser backups can be turned off, and when on every other owner hears about each download', async () => {
  const closed = await startApp({ VANTAGE_BROWSER_BACKUPS: 'false' });
  try {
    const op = await closed.setupOperator();
    const res = await closed.call('GET', '/api/platform/export', { token: op.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'browser_backups_off');
  } finally { await closed.close(); }

  const open = await startApp();
  try {
    const op = await open.setupOperator();
    const second = await open.register('secondowner');
    open.ctx.db.prepare("INSERT INTO platform_roles (user_id, role, created_at) VALUES (?, 'owner', ?)").run(second.id, new Date().toISOString());
    assert.equal((await open.call('GET', '/api/platform/export', { token: op.token })).status, 200);
    const told = open.ctx.db.prepare("SELECT title FROM notifications WHERE user_id = ? AND title LIKE '%downloaded the service archive%'").get(second.id);
    assert.ok(told, 'the other owner is notified');
    assert.equal(open.ctx.db.prepare("SELECT 1 FROM notifications WHERE user_id = ? AND title LIKE '%downloaded%'").get(op.id), undefined, 'not the one who did it');
  } finally { await open.close(); }
});

/** A stand-in for clamd: answers INSTREAM, finding the EICAR test string. */
async function fakeClamd() {
  const server = createServer((socket) => {
    let data = Buffer.alloc(0);
    socket.on('data', (c) => {
      data = Buffer.concat([data, c]);
      if (data.length >= 4 && data.subarray(-4).equals(Buffer.alloc(4))) {
        const body = data.toString('latin1');
        socket.end(body.includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE') ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { address: `tcp://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => server.close() };
}

test('evidence attachments are scanned through clamd, and a rejected file is never stored', async () => {
  const clamd = await fakeClamd();
  const app = await startApp({ VANTAGE_CLAMD: clamd.address });
  try {
    const op = await app.setupOperator();
    const rec = await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'With evidence', visibility: 'private' } });
    const clean = await app.call('POST', `/api/records/activities/${rec.body.id}/attachments`, { token: op.token, raw: png(3), headers: { 'content-type': 'image/png', 'x-vantage-filename': 'proof.png' } });
    assert.equal(clean.status, 201, JSON.stringify(clean.body));
    const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
    const bad = await app.call('POST', `/api/records/activities/${rec.body.id}/attachments`, { token: op.token, raw: eicar, headers: { 'content-type': 'text/plain', 'x-vantage-filename': 'notes.txt' } });
    assert.equal(bad.status, 422);
    assert.equal(bad.body.code, 'malware_rejected');
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n, 1, 'only the clean file was kept');
    assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'upload_rejected'").get());
  } finally { await app.close(); clamd.close(); }
});

test('with scanning required, a file that could not be scanned is refused rather than kept unscanned', async () => {
  const app = await startApp({ VANTAGE_SCAN_REQUIRED: 'true', VANTAGE_CLAMD: 'tcp://127.0.0.1:1' });
  try {
    const op = await app.setupOperator();
    const rec = await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Scanner down', visibility: 'private' } });
    const res = await app.call('POST', `/api/records/activities/${rec.body.id}/attachments`, { token: op.token, raw: png(4), headers: { 'content-type': 'image/png', 'x-vantage-filename': 'proof.png' } });
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'scan_unavailable');
  } finally { await app.close(); }
  assert.equal((await new ClamdSocketScanner('tcp://127.0.0.1:1', 2000).scan(Buffer.from('x'), 'x')).verdict, 'skipped');
});

test('direct delivery never connects to a private, loopback or link-local address', () => {
  for (const a of ['10.0.0.5', '127.0.0.1', '169.254.169.254', '172.31.255.1', '192.168.0.10', '100.100.0.1', '::1', 'fe80::1', 'fd12::1', '::ffff:192.168.1.1']) assert.equal(isPublicAddress(a), false, a);
  for (const a of ['8.8.8.8', '2607:f8b0:4004::1a', '::ffff:1.1.1.1']) assert.equal(isPublicAddress(a), true, a);
});

test('Vantage support can unlock a locked account', async () => {
  const app: TestApp = await startApp();
  try {
    const op = await app.setupOperator();
    const m = await app.register('lockedout');
    for (let i = 0; i < 3; i += 1) await app.login('lockedout', 'not-the-password');
    assert.equal((await app.login('lockedout')).status, 429);
    const users = await app.call('GET', '/api/platform/accounts', { token: op.token });
    assert.ok(users.body.accounts.find((u: { id: string; locked_until: string | null }) => u.id === m.id).locked_until, 'the admin dashboard shows the lock');
    assert.equal((await app.call('POST', `/api/platform/accounts/${m.id}/unlock`, { token: op.token })).body.unlocked, true);
    assert.equal((await app.login('lockedout')).status, 200);
    assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'account_unlock'").get());
  } finally { await app.close(); }
});
