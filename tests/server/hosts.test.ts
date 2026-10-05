import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, PASSWORD, type TestApp } from './helpers.ts';
import { sharedDomain } from '../../server/config.ts';

const SITE = 'www.vantage.test';
const APP = 'secure.vantage.test';
const CONSOLE = 'dev.vantage.test';

let app: TestApp;
let operator: string;
let marine: string;

/** A request as it reaches the server through the proxy: the host the visitor used rides in X-Forwarded-Host. */
async function at(host: string, method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(app.base + path, {
    method, redirect: 'manual',
    headers: { 'x-forwarded-host': host, 'x-vantage-client': '1', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* a page */ }
  return { status: res.status, location: res.headers.get('location'), robots: res.headers.get('x-robots-tag'), text, body };
}

before(async () => {
  app = await startApp({ VANTAGE_SITE_URL: `http://${SITE}`, VANTAGE_APP_URL: `http://${APP}`, VANTAGE_CONSOLE_URL: `http://${CONSOLE}`, TRUST_PROXY: 'true' });
  const setup = await at(APP, 'POST', '/api/auth/setup', { body: { username: 'boletz', password: PASSWORD, first_name: 'John', last_name: 'Boletz', unit_name: 'G-8 Comptroller', unit_short_name: 'G8', email: 'boletz@example.mil' } });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  operator = setup.body.token;
  const reg = await at(APP, 'POST', '/api/auth/register', { body: { username: 'rivera', password: PASSWORD, first_name: 'Ana', last_name: 'Rivera' } });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  marine = reg.body.token;
});
after(() => app.close());

test('passkeys belong to the domain the application and the console share', () => {
  assert.equal(sharedDomain('secure.vantageusmc.com', 'dev.vantageusmc.com'), 'vantageusmc.com');
  assert.equal(sharedDomain('vantage.example.mil', 'vantage.example.mil'), 'vantage.example.mil');
  assert.equal(sharedDomain('app.one.com', 'console.two.com'), 'app.one.com', 'two unrelated domains share nothing a passkey can belong to');
  assert.equal(app.ctx.config.rpId, 'vantage.test');
});

test('the public site serves the public page and sends everything of the application on to it', async () => {
  const home = await at(SITE, 'GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<link rel="canonical"/, 'www is the public page, signed in or not');
  assert.equal((await at(SITE, 'GET', '/about')).status, 200);

  const login = await at(SITE, 'GET', '/login');
  assert.equal(login.status, 301);
  assert.equal(login.location, `http://${APP}/login`);
  const reset = await at(SITE, 'GET', '/reset?token=abc');
  assert.equal(reset.location, `http://${APP}/reset?token=abc`, 'the link in an email keeps its token');
  assert.equal((await at(SITE, 'GET', '/operator?tab=users')).location, `http://${CONSOLE}/admin/accounts`, 'an old console tab that runs the service opens in the admin dashboard');

  assert.equal((await at(SITE, 'GET', '/api/me', { token: operator })).status, 404, 'the public site answers no API calls');
  assert.equal((await at(SITE, 'GET', '/api/health')).status, 200, 'the health check answers on every host');
});

test('the application serves sign-in at its root, and nothing of the site or the console', async () => {
  const root = await at(APP, 'GET', '/');
  assert.equal(root.status, 200);
  assert.doesNotMatch(root.text, /<link rel="canonical"/, 'a signed-out visitor to the app gets sign-in, not the marketing page');
  assert.equal(root.robots, 'noindex, nofollow');
  assert.match(root.text, /<meta name="vantage-links" content="[^"]*https?:\/\/dev\.vantage\.test/, 'the app knows where the console is');

  assert.equal((await at(APP, 'GET', '/about')).location, `http://${SITE}/about`);
  assert.equal((await at(APP, 'GET', '/operator?tab=users')).location, `http://${CONSOLE}/admin/accounts`);
  assert.equal((await at(APP, 'GET', '/operator?tab=retention')).location, `http://${CONSOLE}/retention`, 'one that runs an organization, in the owner console');
  assert.equal((await at(APP, 'GET', '/admin/orgs')).location, `http://${CONSOLE}/admin/orgs`);
  assert.equal((await at(APP, 'GET', '/console/accounts')).location, `http://${CONSOLE}/accounts`);
  assert.equal((await at(APP, 'GET', '/sitemap.xml')).location, `http://${SITE}/sitemap.xml`);
  const robots = await at(APP, 'GET', '/robots.txt');
  assert.match(robots.text, /Allow: \/login/);
  assert.match(robots.text, /Disallow: \/\n/);

  assert.equal((await at(APP, 'GET', '/api/me', { token: marine })).status, 200);
  assert.equal((await at(APP, 'GET', '/api/platform/overview', { token: operator })).status, 404, 'the platform’s API answers only on the admin dashboard’s host, even for staff signed in on the app');
  assert.equal((await at(APP, 'GET', '/api/orgs/G8/overview', { token: operator })).status, 404, 'and an organization’s, only on the owner console’s');
});

test('the console is for owners only, on its own host, and answers only the calls it makes', async () => {
  const refused = await at(CONSOLE, 'POST', '/api/auth/login', { body: { username: 'rivera', password: PASSWORD } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, 'console_owners_only');
  assert.match(refused.body.error, /secure\.vantage\.test/, 'and is told where to go instead');

  const signedIn = await at(CONSOLE, 'POST', '/api/auth/login', { body: { username: 'boletz', password: PASSWORD } });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  const token = signedIn.body.token;
  assert.equal((await at(CONSOLE, 'GET', '/api/me', { token })).status, 200);
  assert.notEqual((await at(CONSOLE, 'GET', '/api/platform/overview', { token })).status, 404, 'the admin dashboard shares this host, so the platform’s API answers');
  assert.equal((await at(CONSOLE, 'GET', '/api/orgs/G8/overview', { token })).status, 200, 'and the owner console’s');
  assert.equal((await at(CONSOLE, 'GET', '/api/records/activities', { token })).status, 404, 'the console does not serve the application’s records');
  assert.equal((await at(CONSOLE, 'POST', '/api/auth/register', { body: { username: 'sneaky', password: PASSWORD, first_name: 'S', last_name: 'N' } })).status, 404, 'nobody registers on the console');

  const robots = await at(CONSOLE, 'GET', '/robots.txt');
  assert.equal(robots.text, 'User-agent: *\nDisallow: /\n');
  assert.equal((await at(CONSOLE, 'GET', '/operator?tab=email')).location, `http://${CONSOLE}/admin/email`);
  const admin = await at(CONSOLE, 'GET', '/admin/orgs');
  assert.equal(admin.status, 200);
  assert.match(admin.text, /Vantage admin/, 'the admin dashboard is its own document');
  assert.equal((await at(CONSOLE, 'GET', '/login')).robots, 'noindex, nofollow', 'any page on the console host is the console');
});

test('the bare domain is the public site, and sends what was the app on to it, keeping the path', async () => {
  const home = await at('vantage.test', 'GET', '/');
  assert.equal(home.status, 200, 'served, not redirected: a host that redirects www to the bare domain cannot loop');
  assert.match(home.text, /<link rel="canonical"/);
  assert.equal((await at('vantage.test', 'GET', '/reset?token=xyz')).location, `http://${APP}/reset?token=xyz`, 'a reset link emailed before the move still works');
  assert.equal((await at('vantage.test', 'GET', '/records/abc')).location, `http://${APP}/records/abc`);
  assert.equal((await at('vantage.test', 'GET', '/operator')).location, `http://${CONSOLE}/`);
});

test('a name the deployment does not use sends visitors to the right host', async () => {
  const other = 'vantage.onrender.test';
  assert.equal((await at(other, 'GET', '/')).location, `http://${SITE}/`);
  assert.equal((await at(other, 'GET', '/login')).location, `http://${APP}/login`);
  const api = await at(other, 'GET', '/api/me', { token: marine });
  assert.equal(api.status, 421, 'an old open tab is told the app moved, not served on the wrong host');
});

test('links in email point at the application', async () => {
  await at(APP, 'POST', '/api/auth/forgot', { body: { identifier: 'boletz' } });
  const mail = app.ctx.mailer.outbox.at(-1);
  assert.ok(mail, 'a reset was sent');
  assert.match(mail.text, /http:\/\/secure\.vantage\.test\/reset\?token=/);
});

test('with a host of its own, the admin dashboard is the only face that answers the platform, and only staff sign in there', async () => {
  const ADMIN = 'admin.vantage.test';
  const own = await startApp({ VANTAGE_SITE_URL: `http://${SITE}`, VANTAGE_APP_URL: `http://${APP}`, VANTAGE_CONSOLE_URL: `http://${CONSOLE}`, VANTAGE_ADMIN_URL: `http://${ADMIN}`, TRUST_PROXY: 'true' });
  const call = async (host: string, method: string, path: string, opts: { token?: string; body?: unknown } = {}) => {
    const res = await fetch(own.base + path, { method, redirect: 'manual', headers: { 'x-forwarded-host': host, 'x-vantage-client': '1', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) }, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* a page */ }
    return { status: res.status, location: res.headers.get('location'), text, body };
  };
  try {
    const setup = await call(APP, 'POST', '/api/auth/setup', { body: { username: 'boletz', password: PASSWORD, first_name: 'John', last_name: 'Boletz', unit_name: 'G-8 Comptroller', unit_short_name: 'G8' } });
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    // An organization owner who is not Vantage staff.
    await call(APP, 'POST', '/api/auth/register', { body: { username: 'owner2', password: PASSWORD, first_name: 'Org', last_name: 'Owner' } });
    const ownerId = (own.ctx.db.prepare("SELECT id FROM users WHERE username = 'owner2'").get() as { id: string }).id;
    own.ctx.db.prepare("INSERT INTO unit_members (user_id, unit_id, is_primary, joined_at) VALUES (?, 'G8', 1, ?)").run(ownerId, new Date().toISOString());
    own.ctx.db.prepare("INSERT INTO org_roles (org_id, user_id, role, created_at) VALUES ('G8', ?, 'owner', ?)").run(ownerId, new Date().toISOString());

    const page = await call(ADMIN, 'GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Vantage admin/);
    assert.equal((await call(ADMIN, 'GET', '/admin/orgs')).location, `http://${ADMIN}/orgs`, 'its own host serves it at the root');
    const refused = await call(ADMIN, 'POST', '/api/auth/login', { body: { username: 'owner2', password: PASSWORD } });
    assert.equal(refused.status, 403, 'an organization owner is not Vantage staff');
    const staff = await call(ADMIN, 'POST', '/api/auth/login', { body: { username: 'boletz', password: PASSWORD } });
    assert.equal(staff.status, 200, JSON.stringify(staff.body));
    assert.equal((await call(ADMIN, 'GET', '/api/platform/overview', { token: staff.body.token })).status, 200);
    assert.equal((await call(ADMIN, 'GET', '/api/orgs/G8/overview', { token: staff.body.token })).status, 404, 'the admin dashboard does not answer for an organization');

    const console = await call(CONSOLE, 'POST', '/api/auth/login', { body: { username: 'owner2', password: PASSWORD } });
    assert.equal(console.status, 200, 'the owner signs in to the owner console');
    assert.equal((await call(CONSOLE, 'GET', '/api/platform/overview', { token: console.body.token })).status, 404, 'where the platform’s API does not answer');
    assert.equal((await call(CONSOLE, 'GET', '/api/orgs/G8/overview', { token: console.body.token })).status, 200);
  } finally { await own.close(); }
});
