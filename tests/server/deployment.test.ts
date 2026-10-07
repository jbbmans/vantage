import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, loadConfig } from '../../server/config.ts';
import { applyRuntimeLocks, installTopologyGuard, outboundConnections } from '../../server/services/deployment.ts';
import { exportInstance, importInstance } from '../../server/services/exports.ts';
import { metaSet } from '../../server/db/index.ts';
import { loadRuntime } from '../../server/runtime.ts';
import { unpublished } from '../../server/app.ts';
import { PASSWORD, startApp } from './helpers.ts';

/**
 * Deployment profiles and Unit Instance topology (ADR-0007). MCEN is the production target and refuses the public-internet
 * services the legacy site used; the legacy public site keeps running unchanged until it is retired; a dedicated
 * deployment's database holds exactly one Unit Instance, whichever path tries to found a second.
 */

const PROD = {
  NODE_ENV: 'production', VANTAGE_SECRET: 's'.repeat(40), VANTAGE_SETUP_TOKEN: 't'.repeat(30), VANTAGE_TEST: '',
  VANTAGE_APP_URL: 'https://vantage.example.mil', VANTAGE_PUBLIC_URL: '', VANTAGE_SITE_URL: '', VANTAGE_CONSOLE_URL: '', VANTAGE_ADMIN_URL: '',
};
const prod = (extra: Record<string, string> = {}) => loadConfig({ ...PROD, ...extra } as NodeJS.ProcessEnv);
const mcen = (extra: Record<string, string> = {}) => prod({ VANTAGE_DEPLOYMENT_PROFILE: 'mcen', ...extra });

test('the profile is named, or inferred so the running legacy site keeps working', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test', VANTAGE_TEST: '1' } as NodeJS.ProcessEnv).deployment.profile, 'development');
  // The Render blueprint as it stands today, with no profile named: it still starts, as legacy-public, and says it inferred that.
  const legacy = prod({
    VANTAGE_PUBLIC_URL: 'https://legacy.example.com', VANTAGE_APP_URL: '', VANTAGE_CLIENT_IP: 'cloudflare', VANTAGE_INDEXNOW: 'true',
    VANTAGE_EMAIL_PROVIDER: 'resend', VANTAGE_GOOGLE_SITE_VERIFICATION: 'abcdefgh1234', VANTAGE_SELF_REGISTRATION: 'false', VANTAGE_MARADMIN_ENABLED: 'true',
  });
  assert.deepEqual(legacy.deployment, { profile: 'legacy-public', inferred: true, topology: 'shared', publicSite: true });
  assert.equal(legacy.search.indexNow, true);
  assert.equal(legacy.security.consentBanner, 'off', 'the legacy defaults are unchanged');
  assert.equal(legacy.security.browserBackups, true);
  assert.equal(prod({ VANTAGE_DEPLOYMENT_PROFILE: 'legacy-public', VANTAGE_PUBLIC_URL: 'https://legacy.example.com' }).deployment.inferred, false);
  assert.throws(() => prod({ VANTAGE_DEPLOYMENT_PROFILE: 'saas' }), /must be mcen, legacy-public, or development/);
  assert.throws(() => prod({ VANTAGE_DEPLOYMENT_PROFILE: 'development' }), /cannot run with NODE_ENV=production/);
  assert.throws(() => prod({ VANTAGE_TOPOLOGY: 'federated' }), /must be shared or dedicated/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_ACCESS_MODE: 'demo', VANTAGE_TOPOLOGY: 'dedicated' } as NodeJS.ProcessEnv), /cannot run with VANTAGE_TOPOLOGY=dedicated/);
});

test('MCEN starts on the enterprise defaults: the consent banner, no self-registration, no browser backups, no public site', () => {
  const config = mcen();
  assert.deepEqual(config.deployment, { profile: 'mcen', inferred: false, topology: 'shared', publicSite: false });
  assert.equal(config.urls.site, 'https://vantage.example.mil', 'the site address is the application’s');
  assert.equal(config.security.consentBanner, 'dod');
  assert.equal(config.selfRegistration, false);
  assert.equal(config.security.browserBackups, false);
  assert.equal(config.search.indexNow, false);
  // An enterprise relay, an SSO issuer and a SIEM are the deployment's own services, and allowed.
  const enterprise = mcen({ VANTAGE_EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://relay.example.mil:25', VANTAGE_AUDIT_SYSLOG: 'tls://siem.example.mil:6514', VANTAGE_CONSENT_BANNER: 'custom', VANTAGE_CONSENT_TEXT: 'Notice.', VANTAGE_BROWSER_BACKUPS: 'true', VANTAGE_TOPOLOGY: 'dedicated' });
  assert.equal(enterprise.email.provider, 'smtp');
  assert.equal(enterprise.security.consentBanner, 'custom');
  assert.equal(enterprise.security.browserBackups, true, 'browser backups stay an explicit choice');
  assert.equal(enterprise.deployment.topology, 'dedicated');
});

test('MCEN refuses every public-internet service of the legacy site, and names them all at once', () => {
  const refusals: Array<[Record<string, string>, RegExp]> = [
    [{ VANTAGE_INDEXNOW: 'true' }, /VANTAGE_INDEXNOW/],
    [{ VANTAGE_GOOGLE_SITE_VERIFICATION: 'abcdefgh1234' }, /SITE_VERIFICATION/],
    [{ VANTAGE_BING_SITE_VERIFICATION: 'abcdefgh1234' }, /SITE_VERIFICATION/],
    [{ VANTAGE_CLIENT_IP: 'cloudflare' }, /VANTAGE_CLIENT_IP=cloudflare/],
    [{ VANTAGE_EMAIL_PROVIDER: 'resend' }, /VANTAGE_EMAIL_PROVIDER=resend/],
    [{ VANTAGE_EMAIL_PROVIDER: 'direct', VANTAGE_EMAIL_FROM: 'Vantage <no-reply@example.mil>' }, /VANTAGE_EMAIL_PROVIDER=direct/],
    [{ VANTAGE_SELF_REGISTRATION: 'true' }, /VANTAGE_SELF_REGISTRATION=true/],
    [{ VANTAGE_CONSENT_BANNER: 'off' }, /VANTAGE_CONSENT_BANNER=off/],
    [{ VANTAGE_SITE_URL: 'https://www.example.mil' }, /VANTAGE_SITE_URL/],
    [{ VANTAGE_PUBLIC_URL: 'https://www.example.mil' }, /VANTAGE_PUBLIC_URL/],
  ];
  for (const [env, pattern] of refusals) assert.throws(() => mcen(env), pattern, JSON.stringify(env));
  assert.throws(() => loadConfig({ NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DEPLOYMENT_PROFILE: 'mcen', VANTAGE_ACCESS_MODE: 'demo' } as NodeJS.ProcessEnv), /VANTAGE_ACCESS_MODE=demo/);
  try {
    mcen({ VANTAGE_INDEXNOW: 'true', VANTAGE_CLIENT_IP: 'cloudflare', VANTAGE_EMAIL_PROVIDER: 'resend' });
    assert.fail('expected a refusal');
  } catch (e) {
    const message = (e as Error).message;
    for (const name of ['VANTAGE_INDEXNOW', 'VANTAGE_CLIENT_IP', 'VANTAGE_EMAIL_PROVIDER']) assert.match(message, new RegExp(name));
  }
});

test('a document without a public site keeps nothing of the public build', () => {
  const html = `<head><meta name="robots" content="index, follow" /><link rel="canonical" href="https://www.vantageusmc.com/security" /><!--site-verification-->
    <meta property="og:url" content="https://www.vantageusmc.com/security" /><meta name="twitter:image" content="https://www.vantageusmc.com/og.png" />
    <script type="application/ld+json">{"@type":"WebSite"}</script><title>Security</title></head>`;
  const out = unpublished(html);
  assert.doesNotMatch(out, /vantageusmc|canonical|og:|twitter:|ld\+json|site-verification/);
  assert.match(out, /<meta name="robots" content="noindex, nofollow"/);
  assert.match(out, /<title>Security<\/title>/);
});

const MCEN_TEST = { VANTAGE_DEPLOYMENT_PROFILE: 'mcen', VANTAGE_SELF_REGISTRATION: '' };
const consent = { 'x-vantage-consent': '1' };
const setup = (app: Awaited<ReturnType<typeof startApp>>) => app.call('POST', '/api/auth/setup', {
  headers: consent,
  body: { username: 'boletz', password: PASSWORD, first_name: 'John', last_name: 'Boletz', rank_id: 'Cpl', mos: '3451', email: 'boletz@example.mil', unit_name: 'G-8 Comptroller', unit_short_name: 'G8' },
});

test('on MCEN there is no public site: / is the application, and nothing is published or indexable', async () => {
  assert.ok(existsSync(join(PROJECT_ROOT, 'dist/index.html')), 'Run npm run build before this test.');
  const app = await startApp(MCEN_TEST);
  try {
    assert.equal((await setup(app)).status, 200);
    const home = await app.call('GET', '/');
    assert.equal(home.status, 200);
    assert.equal(home.headers.get('x-vantage-document'), 'app', 'a signed-out visitor to / gets the application, not the marketing page');
    assert.equal(home.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.doesNotMatch(home.text, /og:image|vantageusmc/);
    assert.match(home.text, /&quot;publicSite&quot;:false/);
    for (const path of ['/about', '/display', '/sitemap.xml', '/llms.txt', '/public.html']) assert.equal((await app.call('GET', path)).status, 404, path);
    assert.equal((await app.call('GET', '/robots.txt')).text, 'User-agent: *\nDisallow: /\n');
    const security = await app.call('GET', '/security');
    assert.equal(security.status, 200, 'the plain-language pages stay for users and their ISSM');
    assert.equal(security.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.doesNotMatch(security.text, /<link rel="canonical"|og:url|vantageusmc/);
    assert.equal((await app.call('GET', '/api/health')).body.profile, 'mcen');
  } finally { await app.close(); }
});

test('on MCEN nobody signs themselves up or founds a Unit Instance, and the admin dashboard cannot reopen either', async () => {
  const app = await startApp(MCEN_TEST);
  try {
    const op = (await setup(app)).body as { token: string };
    assert.equal(app.ctx.runtime.selfRegistration, false);
    assert.equal(app.ctx.runtime.selfServiceUnits, false);
    const register = await app.call('POST', '/api/auth/register', { headers: consent, body: { username: 'rivera', password: PASSWORD, first_name: 'Ana', last_name: 'Rivera', rank_id: 'LCpl' } });
    assert.equal(register.status, 404, 'self-registration is not there to use');
    for (const key of ['selfServiceUnits', 'selfRegistration']) {
      const res = await app.call('PUT', '/api/platform/runtime', { token: op.token, body: { [key]: true } });
      assert.equal(res.status, 403, key);
      assert.equal(res.body.code, 'locked_by_profile');
    }
    assert.equal((await app.call('PUT', '/api/platform/runtime', { token: op.token, body: { selfServiceUnits: false, announcement: 'Drill weekend' } })).status, 200, 'other settings and turning a lock off still work');
    // A runtime an earlier deployment saved with both open is held shut on the next start.
    metaSet(app.ctx.db, 'runtime', JSON.stringify({ ...app.ctx.runtime, selfRegistration: true, selfServiceUnits: true }));
    const stored = loadRuntime(app.ctx.db, app.ctx.config);
    assert.equal(stored.selfServiceUnits, true, 'the stored value is open');
    applyRuntimeLocks(app.ctx.config, stored);
    assert.equal(stored.selfServiceUnits, false);
    assert.equal(stored.selfRegistration, false);

    const overview = await app.call('GET', '/api/platform/overview', { token: op.token });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.deployment.profile, 'mcen');
    assert.deepEqual([...overview.body.deployment.locked].sort(), ['selfRegistration', 'selfServiceUnits']);
    assert.equal(overview.body.deployment.unitInstances, 1);
    assert.ok(overview.body.deployment.outbound.some((c: { id: string; mcen: string }) => c.id === 'genai' && c.mcen === 'approval'));
  } finally { await app.close(); }
});

test('the outbound inventory names each destination without its credentials', async () => {
  const app = await startApp({ VANTAGE_EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://mailer:hunter2-secret@relay.example.mil:587', VANTAGE_AUDIT_SYSLOG: 'tls://siem.example.mil:6514', VANTAGE_CLAMD: 'scanner.example.mil:3310' });
  try {
    const list = outboundConnections(app.ctx);
    const byId = Object.fromEntries(list.map((c) => [c.id, c]));
    assert.equal(byId.email.destination, 'relay.example.mil:587');
    assert.equal(byId.email.enabled, true);
    assert.equal(byId.email.mcen, 'enterprise');
    assert.equal(byId.audit_syslog.destination, 'siem.example.mil:6514');
    assert.equal(byId.indexnow.enabled, false);
    assert.equal(byId.indexnow.mcen, 'refused');
    assert.doesNotMatch(JSON.stringify(list), /hunter2|mailer:/);
  } finally { await app.close(); }
});

test('a dedicated deployment holds one Unit Instance, whichever path tries to found a second', async () => {
  const app = await startApp({ VANTAGE_TOPOLOGY: 'dedicated' });
  try {
    const op = await app.setupOperator();
    const viaAdmin = await app.call('POST', '/api/platform/orgs', { token: op.token, body: { name: 'MARFORRES G-1', code: 'G1' } });
    assert.equal(viaAdmin.status, 409);
    assert.equal(viaAdmin.body.code, 'dedicated_topology');
    const viaTopUnit = await app.call('POST', '/api/org/units', { token: op.token, body: { name: 'Second Command', code: 'SECOND' } });
    assert.equal(viaTopUnit.status, 409);
    assert.equal(viaTopUnit.body.code, 'dedicated_topology');
    // Beneath the instance, units are made as before.
    assert.equal((await app.call('POST', '/api/org/units', { token: op.token, body: { name: 'Budget Section', code: 'G8BUD', parent_id: 'G8' } })).status, 201);
    // The database connection refuses a second one even where the code is bypassed, OR IGNORE included.
    const at = new Date().toISOString();
    assert.throws(() => app.ctx.db.prepare("INSERT INTO units (id, code, name, echelon, created_at) VALUES ('X1', 'X1', 'X', 'command', ?)").run(at), /dedicated_topology/);
    assert.throws(() => app.ctx.db.prepare("INSERT OR IGNORE INTO units (id, code, name, echelon, created_at) VALUES ('X2', 'X2', 'X', 'command', ?)").run(at), /dedicated_topology/);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number }).n, 1);
    assert.equal((app.ctx.db.prepare("SELECT COUNT(*) AS n FROM units WHERE id IN ('X1', 'X2')").get() as { n: number }).n, 0);
  } finally { await app.close(); }
});

test('a database that already holds several Unit Instances will not start as dedicated', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    assert.equal((await app.call('POST', '/api/platform/orgs', { token: op.token, body: { name: 'MARFORRES G-1', code: 'G1' } })).status, 201);
    assert.throws(() => installTopologyGuard(app.ctx.db, { ...app.ctx.config.deployment, topology: 'dedicated' }), /holds 2 Unit Instances/);
    // Shared again: the guard is gone, and a third is founded as before.
    installTopologyGuard(app.ctx.db, app.ctx.config.deployment);
    assert.equal((await app.call('POST', '/api/platform/orgs', { token: op.token, body: { name: 'MARFORRES G-3', code: 'G3' } })).status, 201);

    // Nor can an archive of a shared deployment be restored into a dedicated one: the import is refused whole.
    const archive = exportInstance(app.ctx) as Parameters<typeof importInstance>[1];
    const dedicated = await startApp({ VANTAGE_TOPOLOGY: 'dedicated' });
    try {
      const admin = await dedicated.setupOperator();
      assert.throws(() => importInstance(dedicated.ctx, archive, admin.id), /dedicated_topology/);
      assert.equal((dedicated.ctx.db.prepare('SELECT COUNT(*) AS n FROM organizations').get() as { n: number }).n, 1, 'nothing of the archive stayed');
      assert.equal((await dedicated.call('GET', '/api/me', { token: admin.token })).status, 200, 'and the deployment is as it was');
    } finally { await dedicated.close(); }
  } finally { await app.close(); }
});
