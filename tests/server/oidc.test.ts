import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { startApp, PASSWORD, type TestApp } from './helpers.ts';
import { resetOidcCache, PENDING_PER_BROWSER } from '../../server/auth/oidc.ts';
import { resetLimiters } from '../../server/auth/limiter.ts';

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

type Idp = Awaited<ReturnType<typeof provider>>;
interface SignInOpts { key?: KeyObject; header?: Record<string, unknown>; query?: string; jar?: string; headers?: Record<string, string> }

/**
 * A browser beginning an organization sign-in, and the provider signing the person in: the code and state it returns
 * with, and the browser's cookies afterwards (`jar`), which hold the binding the start set (ADR-0035).
 */
async function begin(app: TestApp, idp: Idp, claims: (nonce: string) => Record<string, unknown>, opts: SignInOpts = {}) {
  const start = await fetch(`${app.base}/api/auth/oidc/start${opts.query ?? ''}`, { redirect: 'manual', headers: { ...canonicalHost(app), ...(opts.jar ? { cookie: opts.jar } : {}), ...opts.headers } });
  const location = start.headers.get('location') || '';
  const jar = cookieOf(start) || opts.jar || '';
  if (!location.startsWith(idp.issuer)) return { start: location, startResponse: start, jar, code: null, state: null };
  const { code, state } = idp.authorize(location, (nonce) => jwt(claims(nonce), opts.key || idp.privateKey, opts.header));
  return { start: location, startResponse: start, jar, code, state };
}

/** The provider's return reaching a browser holding `jar`. */
const finish = (app: TestApp, code: string, state: string, jar: string, headers: Record<string, string> = {}) =>
  fetch(`${app.base}/api/auth/oidc/callback?code=${code}&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: { ...(jar ? { cookie: jar } : {}), ...headers } });

async function signIn(app: TestApp, idp: Idp, claims: (nonce: string) => Record<string, unknown>, opts: SignInOpts = {}) {
  const b = await begin(app, idp, claims, opts);
  if (!b.code || !b.state) return { start: b.start, callback: null as Response | null, jar: b.jar };
  const callback = await finish(app, b.code, b.state, b.jar, opts.headers);
  return { start: b.start, callback, state: b.state, code: b.code, jar: b.jar };
}

const claimsFor = (issuer: string, extra: Record<string, unknown> = {}) => (nonce: string) => {
  const t = Math.floor(Date.now() / 1000);
  return { iss: issuer, aud: 'vantage-test', sub: 'subject-boletz', nonce, iat: t, nbf: t, exp: t + 600, email: 'boletz@example.mil', name: 'John Boletz', ...extra };
};

const env = (issuer: string, more: Record<string, string> = {}) => ({ VANTAGE_OIDC_ISSUER: issuer, VANTAGE_OIDC_CLIENT_ID: 'vantage-test', VANTAGE_OIDC_CLIENT_SECRET: 'provider-secret', VANTAGE_OIDC_TRUST_EMAIL: 'true', TRUST_PROXY: 'true', ...more });
/**
 * A browser on the configured application address. A sign-in begun under any other name moves there first (the provider
 * returns there, and the binding cookie is that host's), and fetch cannot set Host, so the tests present it as a proxy would.
 */
const canonicalHost = (app: TestApp): Record<string, string> => ({ 'x-forwarded-host': new URL(app.ctx.config.urls.app).host });
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

test('a first sign-in found by its address takes the account alone: a password, passkey, second factor, link or session someone else set up there ends', async () => {
  resetOidcCache();
  const idp = await provider();
  const app = await startApp(env(idp.issuer, { VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' }));
  const db = app.ctx.db;
  const of = (username: string) => db.prepare('SELECT id, password_hash, totp_enabled, oidc_subject FROM users WHERE username = ?').get(username) as { id: string; password_hash: string; totp_enabled: number; oidc_subject: string | null };
  try {
    const op = await app.setupOperator();
    // Someone registers with an address that is not theirs, and sets the account up to keep: a passkey, a second
    // factor, a session and an unused reset link.
    const planted = await app.register('mallory', { email: 'jordan.avery@example.mil', first_name: 'Jordan', last_name: 'Avery' });
    const at = new Date().toISOString();
    db.prepare("INSERT INTO passkeys (id, user_id, public_key, name, created_at) VALUES ('pk-mallory', ?, x'00', 'Mallory key', ?)").run(planted.id, at);
    db.prepare("UPDATE users SET totp_enabled = 1, totp_secret = 'sealed' WHERE id = ?").run(planted.id);
    assert.equal((await app.call('POST', '/api/auth/forgot', { body: { identifier: 'mallory' } })).status, 200);
    assert.equal((await app.call('GET', '/api/me', { token: planted.token })).status, 200);

    // The person who holds the address signs in through the organization for the first time.
    const sso = await signIn(app, idp, claimsFor(idp.issuer, { sub: 'subject-avery', email: 'jordan.avery@example.mil', email_verified: true, name: 'Jordan Avery' }));
    assert.equal(sso.callback!.status, 302);
    const cookie = cookieOf(sso.callback!);
    const me = await fetch(`${app.base}/api/me`, { headers: { cookie } });
    assert.equal(((await me.json()) as { user: { id: string } }).user.id, planted.id, 'they land in the account their address is on');

    const now = of('mallory');
    assert.equal(now.oidc_subject, 'subject-avery');
    assert.equal(now.password_hash, '', 'its password is gone');
    assert.equal(now.totp_enabled, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?').get(planted.id) as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND used_at IS NULL').get(planted.id) as { n: number }).n, 0, 'no reset link left to use');
    resetLimiters();
    assert.equal((await app.login('mallory')).status, 401, 'whoever registered it no longer signs in with its password');
    assert.equal((await app.call('GET', '/api/me', { token: planted.token })).status, 401, 'and their session is over');
    const write = await fetch(`${app.base}/api/records/activities`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-vantage-client': '1' }, body: JSON.stringify({ title: 'PRIVATE notes', date: '2026-11-01', visibility: 'private' }) });
    assert.equal(write.status, 201, 'the person carries on in their own session');
    const linked = db.prepare("SELECT detail FROM audit_log WHERE action = 'oidc_linked' AND subject_id = ?").get(planted.id) as { detail: string };
    assert.match(linked.detail, /found by its address, so every other way in ended: its password, 1 passkey, its second factor, 1 unused link, 1 session/);

    // An account a Unit Manager opened with a member's address, and gave a password of their own, is the member's alone
    // once the member signs in: it is proven, and its opener no longer signs in to it.
    const roster = ['Rank,First Name,Last Name,Username,Email,Temporary Password,Role', 'Cpl,Riley,Quinn,rquinn,riley.quinn@example.mil,QuartzHarborLane4!,Marine'].join('\n');
    assert.equal((await app.call('POST', '/api/orgs/G8/accounts/import?apply=1', { token: op.token, raw: Buffer.from(roster), headers: { 'content-type': 'text/csv', 'x-vantage-filename': 'roster.csv' } })).status, 200);
    resetLimiters();
    const opened = await app.login('rquinn', 'QuartzHarborLane4!');
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal((await app.call('POST', '/api/me/password', { token: opened.body.token, body: { current_password: 'QuartzHarborLane4!', new_password: 'harbor-lantern-quartz-meadow-614' } })).status, 200);
    const member = await signIn(app, idp, claimsFor(idp.issuer, { sub: 'subject-quinn', email: 'riley.quinn@example.mil', email_verified: true, name: 'Riley Quinn' }));
    assert.equal(member.callback!.status, 302);
    resetLimiters();
    assert.equal((await app.login('rquinn', 'harbor-lantern-quartz-meadow-614')).status, 401, 'the password its opener chose opens nothing');
    assert.equal(of('rquinn').password_hash, '');
  } finally { await app.close(); await idp.close(); }
});

test('where cards sign in too, an account found by its address that carries an EDIPI is taken only by a sign-in asserting that EDIPI', async () => {
  resetOidcCache();
  const idp = await provider();
  const app = await startApp(env(idp.issuer, { CAC_MODE: 'proxy', CAC_PROXY_SECRET: 'x'.repeat(40), VANTAGE_OIDC_EDIPI_CLAIM: 'edipi', VANTAGE_REGISTRATIONS_PER_15_MINUTES: '100' }));
  const db = app.ctx.db;
  try {
    await app.setupOperator();
    // An account with someone else's address on it, and a card on it, as a card sign-in or a Unit Manager's link puts one.
    const planted = await app.register('mallory', { email: 'jordan.avery@example.mil', first_name: 'Jordan', last_name: 'Avery' });
    db.prepare("UPDATE users SET edipi = '1234567890' WHERE id = ?").run(planted.id);
    const subjectOf = () => (db.prepare('SELECT oidc_subject FROM users WHERE id = ?').get(planted.id) as { oidc_subject: string | null }).oidc_subject;

    // The person who holds the address signs in without the provider asserting that EDIPI: nothing is linked or opened.
    const refused = await signIn(app, idp, claimsFor(idp.issuer, { sub: 'subject-avery', email: 'jordan.avery@example.mil', email_verified: true }));
    assert.equal(refused.callback!.headers.get('location'), '/login?sso_error=oidc_card_bound');
    assert.equal(sessionCookie(refused.callback!), false);
    assert.equal(subjectOf(), null);
    resetLimiters();
    assert.equal((await app.login('mallory')).status, 200, 'the account is as it was');
    const rejected = db.prepare("SELECT detail FROM audit_log WHERE action = 'oidc_rejected' ORDER BY seq DESC LIMIT 1").get() as { detail: string };
    assert.match(rejected.detail, /^oidc_card_bound/);
    // Another DoD ID asserted is refused the same way.
    const other = await signIn(app, idp, claimsFor(idp.issuer, { sub: 'subject-avery', email: 'jordan.avery@example.mil', email_verified: true, edipi: '1098765432' }));
    assert.equal(other.callback!.headers.get('location'), '/login?sso_error=oidc_card_bound');
    assert.equal(subjectOf(), null);

    // The card's own holder, asserted by the provider, takes it, and the card stays theirs.
    const owner = await signIn(app, idp, claimsFor(idp.issuer, { sub: 'subject-avery', email: 'jordan.avery@example.mil', email_verified: true, edipi: '1234567890' }));
    assert.equal(sessionCookie(owner.callback!), true);
    assert.equal(subjectOf(), 'subject-avery');
    assert.equal((db.prepare('SELECT edipi FROM users WHERE id = ?').get(planted.id) as { edipi: string }).edipi, '1234567890');
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

    const unaccepted = await fetch(`${app.base}/api/auth/oidc/start`, { redirect: 'manual', headers: canonicalHost(app) });
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

// C03: an organization sign-in finishes only in the browser, and on the face, that began it (ADR-0035)

const sessionCookie = (res: Response) => cookieOf(res).includes('vantage_session=');
const linked = (app: TestApp) => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE oidc_subject IS NOT NULL').get() as { n: number }).n;

test('a return carried to another browser is refused before anything is spent, linked or opened, and still finishes where it began', async () => {
  resetOidcCache();
  const idp = await provider();
  const app = await startApp(env(idp.issuer));
  try {
    await app.setupOperator();
    // The attacker begins a sign-in in browser A; the victim's browser B has begun one of its own, so holds a binding too.
    const a = await begin(app, idp, claimsFor(idp.issuer));
    const b = await begin(app, idp, claimsFor(idp.issuer, { sub: 'someone-else' }));
    assert.match(a.jar, /^vantage_oidc=[A-Za-z0-9_-]{43}$/, 'the start sets the binding');
    assert.notEqual(a.jar, b.jar, 'each browser has its own');
    const set = a.startResponse.headers.getSetCookie().find((c) => c.startsWith('vantage_oidc='))!;
    assert.match(set, /HttpOnly/i);
    assert.match(set, /SameSite=Lax/i);
    assert.match(set, /Max-Age=600/i);
    assert.match(set, /Path=\//i);
    assert.doesNotMatch(set, /Domain=/i, 'host-only');
    assert.equal(app.ctx.db.prepare('SELECT 1 FROM oidc_states WHERE browser_hash = ?').get(a.jar.split('=')[1]), undefined, 'only its digest is kept');

    const carried = await finish(app, a.code!, a.state!, b.jar);
    assert.equal(carried.headers.get('location'), '/login?sso_error=oidc_browser');
    assert.equal(sessionCookie(carried), false, 'no session in the browser it was carried to');
    assert.equal(linked(app), 0, 'and no account linked');
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 1, 'only the operator’s own session');
    // Missing and altered bindings are refused the same way.
    assert.equal((await finish(app, a.code!, a.state!, '')).headers.get('location'), '/login?sso_error=oidc_browser');
    const altered = a.jar.slice(0, -1) + (a.jar.endsWith('A') ? 'B' : 'A');
    assert.equal((await finish(app, a.code!, a.state!, altered)).headers.get('location'), '/login?sso_error=oidc_browser');
    assert.equal(linked(app), 0);

    // In the browser that began it, it still finishes, once.
    const own = await finish(app, a.code!, a.state!, a.jar);
    assert.equal(own.status, 302);
    assert.equal(own.headers.get('location'), '/');
    assert.ok(sessionCookie(own));
    assert.equal(linked(app), 1);
    const again = await finish(app, a.code!, a.state!, a.jar);
    assert.equal(again.headers.get('location'), '/login?sso_error=oidc_state', 'a replay in the same browser finds it spent');
    assert.equal(sessionCookie(again), false);
  } finally { await app.close(); await idp.close(); }
});

test('an expired sign-in or one begun before browsers were bound is refused; tabs of one browser each finish, and the binding goes after the last', async () => {
  resetOidcCache();
  const idp = await provider();
  const app = await startApp(env(idp.issuer));
  try {
    await app.setupOperator();
    const late = await begin(app, idp, claimsFor(idp.issuer));
    app.ctx.db.prepare('UPDATE oidc_states SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    const expired = await finish(app, late.code!, late.state!, late.jar);
    assert.equal(expired.headers.get('location'), '/login?sso_error=oidc_state');
    assert.equal(sessionCookie(expired), false);
    assert.match(expired.headers.getSetCookie().join('\n'), /vantage_oidc=;/, 'nothing is pending, so the binding is cleared');
    // The binding cookie lasts as long as the sign-in, so a late return usually carries none: it is still told it was late.
    const later = await begin(app, idp, claimsFor(idp.issuer));
    app.ctx.db.prepare('UPDATE oidc_states SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
    assert.equal((await finish(app, later.code!, later.state!, '')).headers.get('location'), '/login?sso_error=oidc_state', 'late, with the cookie gone');

    const old = await begin(app, idp, claimsFor(idp.issuer));
    app.ctx.db.prepare('UPDATE oidc_states SET browser_hash = NULL').run();
    assert.equal((await finish(app, old.code!, old.state!, old.jar)).headers.get('location'), '/login?sso_error=oidc_browser', 'an attempt from before the upgrade');
    assert.equal(linked(app), 0);

    // Two tabs: the second start presents the first's binding and keeps it.
    const first = await begin(app, idp, claimsFor(idp.issuer));
    const second = await begin(app, idp, claimsFor(idp.issuer), { jar: first.jar });
    assert.equal(second.jar, first.jar, 'one binding for the browser');
    const one = await finish(app, first.code!, first.state!, first.jar);
    assert.ok(sessionCookie(one));
    assert.doesNotMatch(one.headers.getSetCookie().join('\n'), /vantage_oidc=;/, 'the other tab still needs it');
    const two = await finish(app, second.code!, second.state!, first.jar);
    assert.ok(sessionCookie(two));
    assert.match(two.headers.getSetCookie().join('\n'), /vantage_oidc=;/, 'cleared once nothing is pending');

    // A browser keeps a bounded number of sign-ins in progress.
    let jar = '';
    resetLimiters();
    for (let i = 0; i < PENDING_PER_BROWSER + 3; i++) {
      const started = await begin(app, idp, claimsFor(idp.issuer), { jar });
      assert.ok(started.code, `start ${i + 1} reaches the provider`);
      jar = started.jar;
    }
    const pending = app.ctx.db.prepare('SELECT browser_hash, COUNT(*) AS n FROM oidc_states WHERE used_at IS NULL AND browser_hash IS NOT NULL GROUP BY browser_hash').all() as Array<{ n: number }>;
    assert.deepEqual(pending.map((p) => p.n), [PENDING_PER_BROWSER]);
  } finally { await app.close(); await idp.close(); }
});

test('a sign-in begun under another name for the server moves to the configured address before anything is set or spent', async () => {
  resetOidcCache();
  const idp = await provider();
  const app = await startApp(env(idp.issuer, { VANTAGE_OIDC_EXCLUSIVE: 'true' }));
  try {
    await app.setupOperator();
    const configured = new URL(app.ctx.config.urls.app);
    const pending = () => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM oidc_states').get() as { n: number }).n;
    const before = pending();
    // Reached by its IP address (or an alias, or the platform's own hostname): sent on to the address the provider returns to.
    const aliased = await fetch(`${app.base}/api/auth/oidc/start?consent=1&return=%2Fsettings`, { redirect: 'manual' });
    assert.equal(aliased.status, 302);
    assert.equal(aliased.headers.get('location'), `${configured.origin}/api/auth/oidc/start?consent=1&return=%2Fsettings&moved=1`);
    assert.deepEqual(aliased.headers.getSetCookie(), [], 'no binding is set on a host the provider will not return to');
    assert.equal(pending(), before, 'and no sign-in is begun there');
    // Moving is not a sign-in attempt: however often it happens, the sign-in limit is untouched.
    for (let i = 0; i < 20; i++) assert.equal((await fetch(`${app.base}/api/auth/oidc/start`, { redirect: 'manual' })).status, 302);
    // A browser moves once. Behind a proxy that hands on a Host of its own, the configured address it moved to still
    // reaches the server under another name: it begins there rather than being sent round again.
    const moved = await begin(app, idp, claimsFor(idp.issuer), { query: '?consent=1&moved=1', headers: { 'x-forwarded-host': 'vantage-upstream' } });
    assert.ok(moved.start.startsWith(idp.issuer), moved.start);
    // Cookies ignore ports, so a port a proxy adds or strips moves nothing.
    const ported = await begin(app, idp, claimsFor(idp.issuer), { query: '?consent=1', headers: { 'x-forwarded-host': `${configured.hostname}:8443` } });
    assert.ok(ported.start.startsWith(idp.issuer), ported.start);
    // The target is the configuration's, whatever the request claims to be.
    const spoofed = await fetch(`${app.base}/api/auth/oidc/start`, { redirect: 'manual', headers: { 'x-forwarded-host': 'evil.example' } });
    assert.equal(new URL(String(spoofed.headers.get('location'))).origin, configured.origin);
    // On the configured address it begins, binds this browser, and the provider is told to return there.
    const there = await begin(app, idp, claimsFor(idp.issuer), { query: '?consent=1' });
    assert.ok(there.start.startsWith(idp.issuer));
    assert.equal(new URL(there.start).searchParams.get('redirect_uri'), `${configured.origin}/api/auth/oidc/callback`);
    assert.match(there.jar, /vantage_oidc=/);
    assert.equal(pending(), before + 3);
  } finally { await app.close(); await idp.close(); }
});

test('over HTTPS the binding is a __Host- cookie; a return on another face is refused; app and console each still sign in', async () => {
  resetOidcCache();
  const idp = await provider();
  const APP = 'secure.vantage.test';
  const CONSOLE = 'dev.vantage.test';
  const app = await startApp(env(idp.issuer, { VANTAGE_APP_URL: `https://${APP}`, VANTAGE_CONSOLE_URL: `https://${CONSOLE}`, VANTAGE_SITE_URL: '', TRUST_PROXY: 'true' }));
  const on = (host: string) => ({ 'x-forwarded-host': host, 'x-forwarded-proto': 'https' });
  try {
    const setup = await app.call('POST', '/api/auth/setup', { headers: on(APP), body: { username: 'boletz', password: PASSWORD, first_name: 'John', last_name: 'Boletz', email: 'boletz@example.mil', unit_name: 'G-8 Comptroller', unit_short_name: 'G8' } });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    const started = await begin(app, idp, claimsFor(idp.issuer), { headers: on(APP) });
    assert.match(started.jar, /^__Host-vantage_oidc=/);
    const set = started.startResponse.headers.getSetCookie().find((c) => c.startsWith('__Host-vantage_oidc='))!;
    assert.match(set, /Secure/i);
    assert.match(set, /Path=\//i);
    assert.doesNotMatch(set, /Domain=/i);
    // A plain cookie of the same purpose does not stand in for it over HTTPS.
    const plain = started.jar.replace('__Host-vantage_oidc=', 'vantage_oidc=');
    assert.equal((await finish(app, started.code!, started.state!, plain, on(APP))).headers.get('location'), '/login?sso_error=oidc_browser');
    // Begun on the app, returned on the console, even carrying the cookie: refused, and still good on the app.
    const crossed = await finish(app, started.code!, started.state!, started.jar, on(CONSOLE));
    assert.match(String(crossed.headers.get('location')), /sso_error=oidc_browser/);
    assert.equal(sessionCookie(crossed), false);
    const back = await finish(app, started.code!, started.state!, started.jar, on(APP));
    assert.equal(back.headers.get('location'), '/');
    assert.ok(sessionCookie(back));

    // The console's own sign-in, for its owner, begins and ends on the console.
    const consoleSignIn = await signIn(app, idp, claimsFor(idp.issuer), { headers: on(CONSOLE) });
    assert.equal(new URL(consoleSignIn.start).searchParams.get('redirect_uri'), `https://${CONSOLE}/api/auth/oidc/callback`);
    assert.equal(consoleSignIn.callback!.status, 302);
    assert.ok(sessionCookie(consoleSignIn.callback!));
  } finally { await app.close(); await idp.close(); }
});
