import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createContext } from '../../server/app.ts';
import { ACCOUNTS, stagingOrigin, stagingConfig, seedVideoStaging, createVideoStagingApp, stagingHtml } from '../../scripts/video-staging.ts';

const ENV = { VANTAGE_STAGE_MODE: 'synthetic-only', RENDER_SERVICE_NAME: 'vantage-video-staging', RENDER_EXTERNAL_URL: 'https://vantage-video-staging.onrender.com' };

test('staging refuses production identity, origins and test mode', () => {
  assert.equal(stagingOrigin(ENV), ENV.RENDER_EXTERNAL_URL);
  for (const patch of [{ RENDER_SERVICE_NAME: 'vantage' }, { VANTAGE_STAGE_MODE: '' }, { VANTAGE_TEST: '1' },
    ...['https://vantageusmc.com', 'http://vantage-video-staging.onrender.com', 'https://vantage-video-staging.onrender.com.evil.example',
      'https://vantage-video-staging.onrender.com/path', 'https://user:secret@vantage-video-staging.onrender.com'].map(RENDER_EXTERNAL_URL => ({ RENDER_EXTERNAL_URL }))]) {
    assert.throws(() => stagingOrigin({ ...ENV, ...patch }));
  }
});

test('staging ignores inherited production configuration', () => {
  const config = stagingConfig({ ...ENV, VANTAGE_DB: '/data/production.db', VANTAGE_SECRET: 'inherited-secret', VANTAGE_OPERATOR: 'real.owner',
    VANTAGE_EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'must-not-inherit', VANTAGE_AI_ENABLED: 'true', VANTAGE_GENAI_API_KEY: 'must-not-inherit', CAC_MODE: 'proxy' }, ':memory:');
  assert.equal(config.databasePath, ':memory:');
  assert.equal(config.production, true);
  assert.equal(config.test, false);
  assert.equal(config.secret.length >= 32, true);
  assert.notEqual(config.secret, 'inherited-secret');
  assert.equal(config.email.provider, 'none');
  assert.equal(config.email.resendApiKey, '');
  assert.equal(config.ai.enabled, false);
  assert.equal(config.ai.apiKey, '');
  assert.equal(config.maradmins.enabled, false);
  assert.equal(config.cac.mode, 'off');
  assert.equal(config.selfRegistration, false);
  assert.deepEqual(config.operatorUsernames, []);
});

test('seed defaults to locked fictional accounts and refuses reseeding', () => {
  const ctx = createContext(stagingConfig(ENV, ':memory:'));
  try {
    seedVideoStaging(ctx, {});
    assert.equal((ctx.db.prepare('SELECT COUNT(*) AS n FROM users WHERE active = 0').get() as { n: number }).n, 3);
    assert.equal((ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, 8);
    assert.equal(ctx.runtime.selfRegistration, false);
    assert.match(ctx.runtime.announcement, /SYNTHETIC STAGING/);
    assert.throws(() => seedVideoStaging(ctx, {}), /empty database/);
  } finally { ctx.db.close(); }
});

test('weak or duplicated supplied credentials fail before writes', () => {
  const ctx = createContext(stagingConfig(ENV, ':memory:'));
  try {
    assert.throws(() => seedVideoStaging(ctx, { VANTAGE_STAGE_MEMBER_PASSWORD: 'short' }), /Invalid/);
    const password = randomBytes(32).toString('base64url');
    assert.throws(() => seedVideoStaging(ctx, { VANTAGE_STAGE_MEMBER_PASSWORD: password, VANTAGE_STAGE_LEADER_PASSWORD: password }), /distinct/);
    assert.equal(ctx.db.prepare('SELECT 1 FROM users').get(), undefined);
  } finally { ctx.db.close(); }
});

test('real production-mode login, visibility, setup and noindex guardrails', async () => {
  const ctx = createContext(stagingConfig(ENV, ':memory:'));
  const credentials = Object.fromEntries(ACCOUNTS.map(a => ['VANTAGE_STAGE_' + a.key + '_PASSWORD', randomBytes(32).toString('base64url')]));
  seedVideoStaging(ctx, credentials);
  const server = createVideoStagingApp(ctx).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  async function call(path: string, method = 'GET', body?: unknown, cookie?: string) {
    return fetch(base + path, { method, headers: { 'content-type': 'application/json', 'x-vantage-client': 'web', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  try {
    const setup = await call('/api/auth/setup');
    assert.match(setup.headers.get('x-robots-tag') || '', /noindex/);
    const state = await setup.json() as { needsSetup: boolean; selfRegistration: boolean; emailEnabled: boolean };
    assert.equal(state.needsSetup, false);
    assert.equal(state.selfRegistration, false);
    assert.equal(state.emailEnabled, false);
    assert.equal((await call('/api/auth/setup', 'POST', {})).status, 409);
    assert.equal((await call('/api/auth/register', 'POST', {})).status, 404);
    assert.equal((await call('/api/me')).status, 401);
    const cookies: Record<string, string> = {};
    for (const account of ACCOUNTS) {
      const login = await call('/api/auth/login', 'POST', { username: account.username, password: credentials['VANTAGE_STAGE_' + account.key + '_PASSWORD'] });
      assert.equal(login.status, 200);
      assert.equal((await login.json() as { token?: string }).token, undefined, 'test bearer tokens must not be exposed');
      assert.match(login.headers.get('set-cookie') || '', /HttpOnly/);
      assert.match(login.headers.get('set-cookie') || '', /Secure/);
      cookies[account.key] = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    }
    const privatePath = '/api/records/activities/synthetic-activity-7';
    assert.equal((await call(privatePath, 'GET', undefined, cookies.MEMBER)).status, 200);
    assert.equal((await call(privatePath, 'GET', undefined, cookies.LEADER)).status, 403);
    assert.equal((await call('/api/records/activities/synthetic-activity-0', 'GET', undefined, cookies.LEADER)).status, 200);
    assert.equal((await call('/api/admin/overview', 'GET', undefined, cookies.MEMBER)).status, 403);
    assert.equal((await call('/api/admin/overview', 'GET', undefined, cookies.OWNER)).status, 200);
    const blocked = await call('/api/admin/runtime', 'PUT', { selfRegistration: true }, cookies.OWNER);
    assert.equal(blocked.status, 403);
    assert.match(blocked.headers.get('x-robots-tag') || '', /noindex/);
    assert.equal(ctx.runtime.selfRegistration, false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    ctx.db.close();
  }
});

test('staging build replaces indexing metadata without changing source HTML', () => {
  const html = '<head><meta name="robots" content="index, follow" /></head><body>Real UI</body>';
  const result = stagingHtml(html);
  assert.match(result, /content="noindex, nofollow, noarchive"/);
  assert.equal((result.match(/name="robots"/g) || []).length, 1);
  assert.match(result, /Real UI/);
  assert.match(html, /content="index, follow"/);
});
