import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startApp, PASSWORD } from './helpers.ts';
import { identityFromPem } from '../../server/auth/cac.ts';
import type { CacError } from '../../server/auth/cac.ts';
import type { CacConfig } from '../../server/config.ts';

const fixture = (name: string) => readFileSync(resolve(import.meta.dirname, '../fixtures', name), 'utf8');
const USER = fixture('cac-user.pem');        // CN AVERY.JORDAN.Q.1234567890, SAN 1234567890@mil (synthetic)
const OTHER = fixture('other.pem');          // CN RIVERA.ANA.9998887770
const EXPIRED = fixture('expired.pem');
const MISMATCH = fixture('mismatch.pem');    // CN says …1234567890, SAN says 1111111111

const SECRET = 'proxy-secret-proxy-secret-proxy-secret';
const base: CacConfig = {
  mode: 'proxy', exclusive: false, caBundlePath: '', certHeader: 'x-client-cert',
  verifyHeader: 'x-client-verify', verifySuccessValue: 'SUCCESS',
  proxySecretHeader: 'x-cac-proxy-secret', proxySecret: SECRET, requirePolicyOids: [], autoProvisionFromRoster: false, crlDir: '', revocation: 'crl',
};
const proxyEnv = {
  CAC_MODE: 'proxy', CAC_PROXY_SECRET: SECRET,
};
const asProxy = (pem: string, extra: Record<string, string> = {}) => ({
  'x-client-cert': encodeURIComponent(pem), 'x-client-verify': 'SUCCESS', 'x-cac-proxy-secret': SECRET, ...extra,
});

test('a DoD certificate yields its EDIPI, and the identity never comes from the name', () => {
  const id = identityFromPem(USER, base);
  assert.equal(id.edipi, '1234567890');
  assert.equal(id.commonName, 'AVERY.JORDAN.Q.1234567890');
  assert.ok(id.policies.includes('2.16.840.1.101.3.2.1.3.13'), 'policy OIDs are read from the DER');
});

test('a certificate whose CN and SAN name different people is refused', () => {
  assert.throws(() => identityFromPem(MISMATCH, base), (e: CacError) => e.code === 'cac_ambiguous');
});

test('an expired certificate is refused even when the gateway accepted it', () => {
  assert.throws(() => identityFromPem(EXPIRED, base), (e: CacError) => e.code === 'cac_expired');
});

test('a policy requirement fails closed when the certificate does not assert it', () => {
  assert.doesNotThrow(() => identityFromPem(USER, { ...base, requirePolicyOids: ['2.16.840.1.101.3.2.1.3.13'] }));
  assert.throws(() => identityFromPem(USER, { ...base, requirePolicyOids: ['1.2.3.4.5'] }), (e: CacError) => e.code === 'cac_policy');
  assert.throws(() => identityFromPem(OTHER, { ...base, requirePolicyOids: ['2.16.840.1.101.3.2.1.3.13'] }), (e: CacError) => e.code === 'cac_policy');
});

test('a forged certificate header without the proxy secret does not sign anyone in', async () => {
  const app = await startApp(proxyEnv);
  try {
    const op = await app.setupOperator();
    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(op.id);

    // Everything a real proxy would send, except the shared secret.
    const forged = await app.call('POST', '/api/auth/cac', {
      headers: { 'x-client-cert': encodeURIComponent(USER), 'x-client-verify': 'SUCCESS' },
    });
    assert.equal(forged.status, 401);
    assert.equal(forged.body.code, 'cac_no_certificate', 'a request that fails the secret check looks like no card at all');

    const wrongSecret = await app.call('POST', '/api/auth/cac', {
      headers: asProxy(USER, { 'x-cac-proxy-secret': 'not-the-secret-not-the-secret-xxxx' }),
    });
    assert.equal(wrongSecret.status, 401);
    assert.equal(wrongSecret.body.code, 'cac_no_certificate');
  } finally { await app.close(); }
});

test('proxy mode refuses to start without a long shared secret', async () => {
  await assert.rejects(() => startApp({ CAC_MODE: 'proxy' }), /CAC_PROXY_SECRET/);
  await assert.rejects(() => startApp({ CAC_MODE: 'proxy', CAC_PROXY_SECRET: 'short' }), /at least 32/);
});

test('a certificate the gateway did not verify is refused', async () => {
  const app = await startApp(proxyEnv);
  try {
    const op = await app.setupOperator();
    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(op.id);
    const res = await app.call('POST', '/api/auth/cac', { headers: asProxy(USER, { 'x-client-verify': 'FAILED' }) });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'cac_untrusted');

    const missing = await app.call('POST', '/api/auth/cac', {
      headers: { 'x-client-cert': encodeURIComponent(USER), 'x-cac-proxy-secret': SECRET },
    });
    assert.equal(missing.status, 401, 'no verdict header at all is also refused');
    assert.equal(missing.body.code, 'cac_untrusted');
  } finally { await app.close(); }
});

test('a linked card signs in, and an unlinked one does not', async () => {
  const app = await startApp(proxyEnv);
  try {
    const op = await app.setupOperator();
    const unlinked = await app.call('POST', '/api/auth/cac', { headers: asProxy(USER) });
    assert.equal(unlinked.status, 401);
    assert.equal(unlinked.body.code, 'cac_unlinked');

    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(op.id);
    const ok = await app.call('POST', '/api/auth/cac', { headers: asProxy(USER) });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);

    const me = await app.call('GET', '/api/me', { token: ok.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.id, op.id, 'the session belongs to the account holding that EDIPI');
  } finally { await app.close(); }
});

test('a card belonging to nobody on this instance cannot borrow another account', async () => {
  const app = await startApp(proxyEnv);
  try {
    const op = await app.setupOperator();
    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(op.id);
    // A valid certificate, correctly proxied, for an EDIPI no account carries.
    const res = await app.call('POST', '/api/auth/cac', { headers: asProxy(OTHER) });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'cac_unlinked');
  } finally { await app.close(); }
});

test('a deactivated account cannot sign in with its card', async () => {
  const app = await startApp(proxyEnv);
  try {
    const op = await app.setupOperator();
    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890', active = 0 WHERE id = ?").run(op.id);
    const res = await app.call('POST', '/api/auth/cac', { headers: asProxy(USER) });
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'cac_inactive');
  } finally { await app.close(); }
});

test('a card counts as both factors, so an account with TOTP is not challenged again', async () => {
  const app = await startApp(proxyEnv);
  try {
    const op = await app.setupOperator();
    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890', totp_enabled = 1, totp_secret = 'x' WHERE id = ?").run(op.id);
    const res = await app.call('POST', '/api/auth/cac', { headers: asProxy(USER) });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true, 'no second-factor challenge is issued');
  } finally { await app.close(); }
});

test('auto-provisioning creates an account only for someone the roster lists', async () => {
  const app = await startApp({ ...proxyEnv, CAC_AUTO_PROVISION: 'true' });
  try {
    await app.setupOperator();
    const at = new Date().toISOString();
    app.ctx.db.prepare(`INSERT INTO personnel_roster (org_id, edipi, last_name, first_name, rank_id, status, source, row_hash, synced_at, created_at, updated_at)
                        VALUES ('G8','1234567890','Boletz','John','Cpl','active','MCTFS','h',?,?,?)`).run(at, at, at);

    const ok = await app.call('POST', '/api/auth/cac', { headers: asProxy(USER) });
    assert.equal(ok.status, 200, 'on the roster: provisioned and signed in');
    const seated = app.ctx.db.prepare("SELECT um.unit_id FROM unit_members um JOIN users u ON u.id = um.user_id WHERE u.edipi = '1234567890'").all() as Array<{ unit_id: string }>;
    assert.deepEqual(seated.map((m) => m.unit_id), ['G8'], 'the organization whose roster lists them is the one they join');

    const off = await app.call('POST', '/api/auth/cac', { headers: asProxy(OTHER) });
    assert.equal(off.status, 401);
    assert.equal(off.body.code, 'cac_not_on_roster');
  } finally { await app.close(); }
});

test('an instance that requires cards refuses passwords and self-registration', async () => {
  const app = await startApp({ ...proxyEnv, CAC_EXCLUSIVE: 'true' });
  try {
    const op = await app.setupOperator();
    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(op.id);

    const pw = await app.call('POST', '/api/auth/login', { body: { username: 'operator', password: PASSWORD } });
    assert.equal(pw.status, 403);
    assert.equal(pw.body.code, 'cac_required');

    const reg = await app.call('POST', '/api/auth/register', { body: { username: 'newbie', password: PASSWORD, first_name: 'New', last_name: 'Marine', rank_id: 'LCpl' } });
    assert.equal(reg.status, 403);

    const card = await app.call('POST', '/api/auth/cac', { headers: asProxy(USER) });
    assert.equal(card.status, 200, 'the card still works');
  } finally { await app.close(); }
});

test('certificate sign-in is absent unless the instance turns it on', async () => {
  const app = await startApp();
  try {
    await app.setupOperator();
    const res = await app.call('POST', '/api/auth/cac', { headers: asProxy(USER) });
    assert.equal(res.status, 404, 'the route reports it is not enabled rather than half-working');
    const setup = await app.call('GET', '/api/auth/setup');
    assert.equal(setup.body.cac.enabled, false);
  } finally { await app.close(); }
});

test('every certificate decision is on the audit trail', async () => {
  const app = await startApp(proxyEnv);
  try {
    const op = await app.setupOperator();
    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(op.id);
    await app.call('POST', '/api/auth/cac', { headers: asProxy(OTHER) });   // rejected
    await app.call('POST', '/api/auth/cac', { headers: asProxy(USER) });    // accepted

    const actions = (app.ctx.db.prepare('SELECT action, detail FROM audit_log ORDER BY seq DESC LIMIT 10').all() as Array<{ action: string; detail: string | null }>);
    assert.ok(actions.some((a) => a.action === 'cac_rejected'), 'a refusal is recorded');
    const verified = actions.find((a) => a.action === 'cac_verified');
    assert.ok(verified, 'an acceptance is recorded');
    assert.match(verified!.detail || '', /edipi=1234567890/);
    assert.match(verified!.detail || '', /serial=/, 'the certificate serial is kept so a card can be traced');
  } finally { await app.close(); }
});

test('during maintenance a card still signs staff in and confirms it is them, but makes no new account', async () => {
  const app = await startApp({ ...proxyEnv, CAC_EXCLUSIVE: 'true', CAC_AUTO_PROVISION: 'true' });
  try {
    const op = await app.setupOperator();
    app.ctx.db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(op.id);
    const at = new Date().toISOString();
    app.ctx.db.prepare(`INSERT INTO personnel_roster (org_id, edipi, last_name, first_name, rank_id, status, source, row_hash, synced_at, created_at, updated_at)
                        VALUES ('G8','9998887770','Rivera','Ana','Sgt','active','MCTFS','h',?,?,?)`).run(at, at, at);
    app.ctx.runtime.maintenance = true;

    // Where only a card signs in, the card is the only way back in to end maintenance.
    const card = await app.call('POST', '/api/auth/cac', { headers: asProxy(USER) });
    assert.equal(card.status, 200, 'staff sign in with their card');
    const stepUp = await app.call('POST', '/api/auth/cac/step-up', { token: op.token, headers: asProxy(USER) });
    assert.equal(stepUp.status, 200, 'and confirm it is them with it');

    // A roster Marine with no account yet waits until maintenance ends, as registration does.
    const fresh = await app.call('POST', '/api/auth/cac', { headers: asProxy(OTHER) });
    assert.equal(fresh.status, 503);
    assert.equal(fresh.body.code, 'maintenance');
    assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE edipi = '9998887770'").get() as { n: number }).n, 0, 'no account was made');

    app.ctx.runtime.maintenance = false;
    assert.equal((await app.call('POST', '/api/auth/cac', { headers: asProxy(OTHER) })).status, 200, 'afterwards the roster provisions them as before');
  } finally { await app.close(); }
});
