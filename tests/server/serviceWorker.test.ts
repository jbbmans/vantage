import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, PASSWORD, type TestApp } from './helpers.ts';
import { PROJECT_ROOT } from '../../server/config.ts';
import { invalidateUserSessions } from '../../server/auth/sessions.ts';

const built = existsSync(join(PROJECT_ROOT, 'dist/index.html')) && existsSync(join(PROJECT_ROOT, 'dist/public.html'));
let app: TestApp;
before(async () => { app = await startApp(); await app.setupOperator(); });
after(() => app.close());

/**
 * Runs public/sw.js's install step against the test server, sending the cookies a browser would attach, and returns
 * what it kept as '/', the copy the app opens from when it is offline.
 */
async function installKeeps(cookie: string): Promise<Response | undefined> {
  const listeners = new Map<string, (event: { waitUntil: (p: Promise<unknown>) => void }) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const browserFetch = (url: string, init: RequestInit = {}) => fetch(new URL(url, app.base), { ...init, headers: cookie ? { cookie } : {} });
  const caches = {
    open: async (name: string) => {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        put: async (url: string, res: Response) => { store.set(url, res); },
        // Cache.add stores whatever an ok answer is, as a browser's does.
        add: async (url: string) => { const res = await browserFetch(url); if (!res.ok) throw new TypeError(`${url}: ${res.status}`); store.set(url, res); },
      };
    },
  };
  const worker = {
    addEventListener: (type: string, fn: (event: { waitUntil: (p: Promise<unknown>) => void }) => void) => listeners.set(type, fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
    location: { origin: new URL(app.base).origin },
  };
  new Function('self', 'caches', 'fetch', readFileSync(join(PROJECT_ROOT, 'public/sw.js'), 'utf8'))(worker, caches, browserFetch);
  let installed: Promise<unknown> = Promise.resolve();
  listeners.get('install')!({ waitUntil: (p) => { installed = p; } });
  await installed;
  return [...stores].find(([name]) => name.startsWith('vantage-shell-'))?.[1].get('/');
}

const cookiesOf = (res: Response) => Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(';')[0].split('=') as [string, string]));

test('the service worker keeps only the application as its offline copy, whoever installs it', { skip: !built && 'needs npm run build' }, async () => {
  // A signed-out browser on a host shared with the public site is answered at '/' with the public page.
  const page = await fetch(`${app.base}/`);
  assert.match(await page.text(), /"@type":\s*"WebSite"/, 'the setting this test is about: / is the public page here');

  const isApp = async (kept: Response | undefined, who: string) => {
    assert.ok(kept, `${who}: something is kept as /`);
    assert.equal(kept.headers.get('x-vantage-document'), 'app', `${who}: the offline copy is the application`);
    assert.doesNotMatch(await kept.text(), /"@type":\s*"WebSite"/, `${who}: never the public page`);
  };

  await isApp(await installKeeps(''), 'a browser with no session');

  const reg = await fetch(`${app.base}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vantage-client': '1' }, body: JSON.stringify({ username: 'offline', password: PASSWORD, first_name: 'Off', last_name: 'Line' }) });
  assert.equal(reg.status, 200, await reg.clone().text());
  const { vantage_session: session, vantage_signed_in: marker } = cookiesOf(reg);
  await isApp(await installKeeps(`vantage_session=${session}; vantage_signed_in=${marker}`), 'a signed-in browser');

  // A role grant ends the person's sessions (ADR-0035) and the open page clears the marker it can reach; the session
  // cookie is httpOnly and stays until the next sign-in. An install then (a new build, say) still keeps the app.
  const me = (await (await fetch(`${app.base}/api/me`, { headers: { cookie: `vantage_session=${session}` } })).json()) as { user: { id: string } };
  invalidateUserSessions(app.ctx, me.user.id);
  await isApp(await installKeeps(`vantage_session=${session}`), 'a browser holding an ended session');
});
