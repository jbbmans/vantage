import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { startApp, PASSWORD, type TestApp } from './helpers.ts';
import { resetOidcCache } from '../../server/auth/oidc.ts';

/** A stand-in identity provider: discovery, keys, and a token endpoint that checks the PKCE verifier. */
async function provider() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; redirect: string; token: string }>();
  let base = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, base);
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks` });
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c)).on('end', () => {
        const form = new URLSearchParams(body);
        const grant = codes.get(form.get('code') || '');
        if (!grant) return json(400, { error: 'invalid_grant' });
        codes.delete(form.get('code')!);
        const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (challenge !== grant.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verifier does not match' });
        if (form.get('redirect_uri') !== grant.redirect || form.get('client_id') !== 'vantage-test' || form.get('client_secret') !== 'provider-secret') return json(400, { error: 'invalid_client' });
        json(200, { id_token: grant.token, token_type: 'Bearer' });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    issuer: base, privateKey,
    /** What the provider would do once the person signs in there: a code bound to the challenge, carrying this token. */
    authorize(startUrl: string, token: (nonce: string) => string) {
      const p = new URL(startUrl).searchParams;
      const code = randomBytes(12).toString('hex');
      codes.set(code, { challenge: p.get('code_challenge')!, redirect: p.get('redirect_uri')!, token: token(p.get('nonce')!) });
      return { code, state: p.get('state')! };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function jwt(claims: Record<string, unknown>, key: KeyObject, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const data = `${enc(header)}.${enc(claims)}`;
  return `${data}.${header.alg === 'none' ? '' : sign('sha256', Buffer.from(data), key).toString('base64url')}`;
}

async function signIn(app: TestApp, idp: Awaited<ReturnType<typeof provider>>, claims: (nonce: string) => Record<string, unknown>, opts: { key?: KeyObject; header?: Record<string, unknown>; query?: string } = {}) {
  const start = await fetch(`${app.base}/api/auth/oidc/start${opts.query ?? ''}`, { redirect: 'manual' });
  const location = start.headers.get('location') || '';
  if (!location.startsWith(idp.issuer)) return { start: location, callback: null as Response | null };
  const { code, state } = idp.authorize(location, (nonce) => jwt(claims(nonce), opts.key || idp.privateKey, opts.header));
  const callback = await fetch(`${app.base}/api/auth/oidc/callback?code=${code}&state=${encodeURIComponent(state)}`, { redirect: 'manual' });
  return { start: location, callback, state, code };
}

const claimsFor = (issuer: string, extra: Record<string, unknown> = {}) => (nonce: string) => {
  const t = Math.floor(Date.now() / 1000);
  return { iss: issuer, aud: 'vantage-test', sub: 'subject-boletz', nonce, iat: t, nbf: t, exp: t + 600, email: 'boletz@example.mil', name: 'John Boletz', ...extra };
};

const env = (issuer: string, more: Record<string, string> = {}) => ({ VANTAGE_OIDC_ISSUER: issuer, VANTAGE_OIDC_CLIENT_ID: 'vantage-test', VANTAGE_OIDC_CLIENT_SECRET: 'provider-secret', VANTAGE_OIDC_TRUST_EMAIL: 'true', ...more });
const cookieOf = (res: Response) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');

test('an organization sign-in links the existing account by email the first time, then by subject, and opens a session', async () => {
  resetOidcCache();
  const idp = await provider();
  const app = await startApp(env(idp.issuer));
  try {
    await app.setupOperator();
    const setup = await app.call('GET', '/api/auth/setup');
    assert.deepEqual(setup.body.sso, { enabled: true, label: 'Sign in with your organization', exclusive: false });

    const first = await signIn(app, idp, claimsFor(idp.issuer), { query: '?return=/work/queue' });
    const authorize = new URL(first.start);
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:5173/api/auth/oidc/callback');
    assert.equal(first.callback!.status, 302);
    assert.equal(first.callback!.headers.get('location'), '/work/queue', 'back to where the person was going');
    const me = await fetch(`${app.base}/api/me`, { headers: { cookie: cookieOf(first.callback!) } });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { user: { username: string } }).user.username, 'boletz');
    assert.ok(app.ctx.db.prepare("SELECT 1 FROM audit_log WHERE action = 'oidc_linked'").get());

    // The provider changes the person's address; the link holds by subject.
    const second = await signIn(app, idp, claimsFor(idp.issuer, { email: 'john.boletz@example.mil' }));
    assert.equal(second.callback!.headers.get('location'), '/');
    assert.ok(cookieOf(second.callback!).includes('vantage_session='));

    // A callback replayed with the same state is refused.
    const replay = await fetch(`${app.base}/api/auth/oidc/callback?code=${second.code}&state=${encodeURIComponent(second.state!)}`, { redirect: 'manual' });
    assert.equal(replay.headers.get('location'), '/login?sso_error=oidc_state');
    assert.equal(cookieOf(replay).includes('vantage_session='), false);

    const away = await signIn(app, idp, claimsFor(idp.issuer), { query: '?return=//evil.example/steal' });
    assert.equal(away.callback!.headers.get('location'), '/', 'never sent to another host');
  } finally { await app.close(); await idp.close(); }
});

test('a forged, misdirected, expired or replayed ID token is refused, and nothing is signed in', async () => {
  resetOidcCache();
  const idp = await provider();
  const app = await startApp(env(idp.issuer));
  try {
    await app.setupOperator();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const t = Math.floor(Date.now() / 1000);
    const cases: Array<[string, Parameters<typeof signIn>[2], Parameters<typeof signIn>[3], string]> = [
      ['signed with a key the provider does not publish', claimsFor(idp.issuer), { key: other }, 'oidc_bad_token'],
      ['unsigned', claimsFor(idp.issuer), { header: { alg: 'none', kid: 'k1' } }, 'oidc_bad_token'],
      ['HMAC-signed', claimsFor(idp.issuer), { header: { alg: 'HS256', kid: 'k1' } }, 'oidc_bad_token'],
      ['for another application', claimsFor(idp.issuer, { aud: 'someone-else' }), {}, 'oidc_bad_token'],
      ['from another issuer', claimsFor(idp.issuer, { iss: 'https://login.example.com' }), {}, 'oidc_bad_token'],
      ['expired', claimsFor(idp.issuer, { exp: t - 3600, iat: t - 7200, nbf: t - 7200 }), {}, 'oidc_expired'],
      ['for another sign-in attempt', (n) => ({ ...claimsFor(idp.issuer)(n), nonce: 'not-this-one' }), {}, 'oidc_bad_token'],
      ['for nobody with an account', claimsFor(idp.issuer, { sub: 'stranger', email: 'stranger@example.mil' }), {}, 'oidc_unlinked'],
    ];
    for (const [what, claims, opts, code] of cases) {
      const r = await signIn(app, idp, claims, opts);
      assert.equal(r.callback!.headers.get('location'), `/login?sso_error=${code}`, what);
      assert.equal(cookieOf(r.callback!).includes('vantage_session='), false, what);
    }
    assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM users WHERE oidc_subject IS NOT NULL").get() as { n: number }).n, 0, 'nothing was linked');
    assert.ok((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'oidc_rejected'").get() as { n: number }).n >= cases.length);
  } finally { await app.close(); await idp.close(); }
});

test('an account linked to one identity is not taken over by another with the same address', async () => {
  resetOidcCache();
  const idp = await provider();
  const app = await startApp(env(idp.issuer));
  try {
    await app.setupOperator();
    assert.equal((await signIn(app, idp, claimsFor(idp.issuer))).callback!.status, 302);
    const imposter = await signIn(app, idp, claimsFor(idp.issuer, { sub: 'someone-else-same-email' }));
    assert.equal(imposter.callback!.headers.get('location'), '/login?sso_error=oidc_conflict');
  } finally { await app.close(); await idp.close(); }
});

test('exclusive organization sign-in turns passwords and self-registration off; the notice is accepted before leaving', async () => {
  resetOidcCache();
  const idp = await provider();
  const app = await startApp(env(idp.issuer, { VANTAGE_OIDC_EXCLUSIVE: 'true', VANTAGE_CONSENT_BANNER: 'dod' }));
  try {
    const setup = await app.call('POST', '/api/auth/setup', { headers: { 'x-vantage-consent': '1' }, body: { username: 'boletz', password: PASSWORD, first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', email: 'boletz@example.mil', unit_name: 'G-8', unit_short_name: 'G8' } });
    assert.equal(setup.status, 200);
    const status = await app.call('GET', '/api/auth/setup');
    assert.equal(status.body.sso.exclusive, true);
    assert.equal(status.body.selfRegistration, false);
    const password = await app.call('POST', '/api/auth/login', { headers: { 'x-vantage-consent': '1' }, body: { username: 'boletz', password: PASSWORD } });
    assert.equal(password.status, 403);
    assert.equal(password.body.code, 'oidc_required');

    const unaccepted = await fetch(`${app.base}/api/auth/oidc/start`, { redirect: 'manual' });
    assert.equal(unaccepted.headers.get('location'), '/login?sso_error=consent_required');
    const accepted = await signIn(app, idp, claimsFor(idp.issuer), { query: '?consent=1' });
    assert.equal(accepted.callback!.status, 302);
    assert.equal(accepted.callback!.headers.get('location'), '/');
    assert.ok(cookieOf(accepted.callback!).includes('vantage_session='));
  } finally { await app.close(); await idp.close(); }
});

test('with roster provisioning, a Marine on the roster with no account gets one from the EDIPI claim', async () => {
  resetOidcCache();
  const idp = await provider();
  const app = await startApp(env(idp.issuer, { VANTAGE_OIDC_LINK: 'edipi', VANTAGE_OIDC_EDIPI_CLAIM: 'edipi', VANTAGE_OIDC_AUTO_PROVISION: 'true' }));
  try {
    await app.setupOperator();
    const at = new Date().toISOString();
    app.ctx.db.prepare(`INSERT INTO personnel_roster (org_id, edipi, last_name, first_name, rank_id, mos, status, source, row_hash, synced_at, created_at, updated_at) VALUES ('G8', '1234567890', 'Avery', 'Jordan', 'LCpl', '3451', 'active', 'test', 'h', ?, ?, ?)`).run(at, at, at);
    const r = await signIn(app, idp, claimsFor(idp.issuer, { sub: 'avery', email: 'jordan.avery@example.mil', edipi: '1234567890' }));
    assert.equal(r.callback!.status, 302);
    assert.equal(r.callback!.headers.get('location'), '/');
    const user = app.ctx.db.prepare("SELECT username, last_name, oidc_subject FROM users WHERE edipi = '1234567890'").get() as { username: string; last_name: string; oidc_subject: string };
    assert.deepEqual(user, { username: 'edipi-1234567890', last_name: 'Avery', oidc_subject: 'avery' });
    // The provider asserted the EDIPI, which proves it as a card would (ADR-0009): only Vantage support moves it now.
    assert.ok((app.ctx.db.prepare("SELECT edipi_verified_at FROM users WHERE edipi = '1234567890'").get() as { edipi_verified_at: string | null }).edipi_verified_at);
    // Someone whose provider address another account already holds still gets in, without the address.
    app.ctx.db.prepare(`INSERT INTO personnel_roster (org_id, edipi, last_name, first_name, rank_id, mos, status, source, row_hash, synced_at, created_at, updated_at) VALUES ('G8', '1234567891', 'Boletz', 'Jay', 'Pvt', '3451', 'active', 'test', 'h2', ?, ?, ?)`).run(at, at, at);
    const shared = await signIn(app, idp, claimsFor(idp.issuer, { sub: 'jay', email: 'boletz@example.mil', edipi: '1234567891' }));
    assert.equal(shared.callback!.headers.get('location'), '/');
    assert.equal((app.ctx.db.prepare("SELECT email FROM users WHERE edipi = '1234567891'").get() as { email: string | null }).email, null);
    const nobody = await signIn(app, idp, claimsFor(idp.issuer, { sub: 'x', email: 'x@example.mil', edipi: '9999999999' }));
    assert.equal(nobody.callback!.headers.get('location'), '/login?sso_error=oidc_unlinked');
    // During maintenance nobody new is made, as with a card or registration (ADR-0011); people who have accounts still sign in.
    app.ctx.db.prepare(`INSERT INTO personnel_roster (org_id, edipi, last_name, first_name, rank_id, mos, status, source, row_hash, synced_at, created_at, updated_at) VALUES ('G8', '1234567892', 'Rivera', 'Ana', 'Sgt', '3451', 'active', 'test', 'h3', ?, ?, ?)`).run(at, at, at);
    app.ctx.runtime.maintenance = true;
    const waiting = await signIn(app, idp, claimsFor(idp.issuer, { sub: 'ana', email: 'ana.rivera@example.mil', edipi: '1234567892' }));
    assert.equal(waiting.callback!.headers.get('location'), '/login?sso_error=maintenance');
    assert.equal(app.ctx.db.prepare("SELECT 1 FROM users WHERE edipi = '1234567892'").get(), undefined);
    app.ctx.runtime.maintenance = false;
  } finally { await app.close(); await idp.close(); }
});

test('misconfiguration is refused at start', async () => {
  await assert.rejects(startApp({ VANTAGE_OIDC_ISSUER: 'https://login.example.com' }), /VANTAGE_OIDC_CLIENT_ID/);
  await assert.rejects(startApp({ VANTAGE_OIDC_ISSUER: 'http://idp.example.com', VANTAGE_OIDC_CLIENT_ID: 'x' }), /https/);
  await assert.rejects(startApp({ VANTAGE_OIDC_ISSUER: 'https://login.example.com', VANTAGE_OIDC_CLIENT_ID: 'x', VANTAGE_OIDC_LINK: 'edipi' }), /EDIPI_CLAIM/);
});
