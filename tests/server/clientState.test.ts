import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
// Load the browser's plain transport module without pulling its DOM-only types into the server tsconfig.
interface ClientModule {
  api: { post: (path: string, body: unknown) => Promise<unknown>; get: (path: string) => Promise<unknown> };
  listWorkItems: (params: Record<string, string>, options: { signal: AbortSignal }) => Promise<unknown>;
  ApiError: new (...args: never[]) => Error & { status: number; code: string | null };
  sessionExpiresAt: () => number | null;
}
const { api, ApiError, listWorkItems, sessionExpiresAt } = await import(new URL('../../src/lib/api.ts', import.meta.url).href) as ClientModule;
const { storedTheme } = await import(new URL('../../src/lib/theme.ts', import.meta.url).href) as { storedTheme: () => string };

test('an unreadable successful response is refused instead of masquerading as a saved null result', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('<html>proxy page</html>', { status: 200 }));
  try {
    await assert.rejects(api.post('/synthetic', {}), (error) => error instanceof ApiError && error.status === 502 && error.code === 'invalid_response');
  } finally { fetch.mock.restore(); }
});

test('a cancelled read is not reported as an offline failure eligible for retry or queuing', async () => {
  const controller = new AbortController(); controller.abort();
  const reason = new DOMException('Synthetic cancellation', 'AbortError');
  const fetch = mock.method(globalThis, 'fetch', async () => { throw reason; });
  try { await assert.rejects(listWorkItems({}, { signal: controller.signal }), (error) => error === reason); }
  finally { fetch.mock.restore(); }
});

test('the server deadline is retained even before an idle-warning listener exists', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  const deadline = new Date(Date.now() + 600000).toISOString();
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: { 'x-session-expires': deadline } }));
  try { await api.get('/synthetic'); assert.equal(sessionExpiresAt(), Date.parse(deadline)); }
  finally { fetch.mock.restore(); if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); }
});

test('a 401 for a session a newer sign-in replaced keeps that sign-in; a 401 for the current one signs out', async () => {
  // The page's view of its cookies: only the readable signed-in marker, which each sign-in sets anew.
  let marker: string | null = 'first-sign-in';
  const jar = {
    get cookie() { return marker === null ? '' : `vantage_signed_in=${marker}`; },
    set cookie(v: string) { if (/^vantage_signed_in=/.test(v)) marker = /max-age=0/i.test(v) ? null : v.split(';')[0].slice('vantage_signed_in='.length); },
  };
  const events: string[] = [];
  const win = new EventTarget();
  for (const name of ['vantage:signed-in', 'vantage:signed-out']) win.addEventListener(name, () => events.push(name));
  const previous = { document: Object.getOwnPropertyDescriptor(globalThis, 'document'), window: Object.getOwnPropertyDescriptor(globalThis, 'window') };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: jar });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  // Sent under the first sign-in; the person signs in again (a role grant ended their sessions) before its 401 is back.
  let fetch = mock.method(globalThis, 'fetch', async () => { marker = 'second-sign-in'; return new Response('{"error":"Sign in."}', { status: 401 }); });
  try {
    await assert.rejects(api.get('/synthetic'), (error) => error instanceof ApiError && error.status === 401);
    assert.equal(marker, 'second-sign-in', 'the newer sign-in keeps its marker, so its next page load is signed in');
    assert.deepEqual(events, ['vantage:signed-in']);
    fetch.mock.restore();
    // Sent under the sign-in that is still current: that session has ended, and the page signs out.
    fetch = mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 401 }));
    await assert.rejects(api.get('/synthetic'), (error) => error instanceof ApiError && error.status === 401);
    assert.equal(marker, null);
    assert.deepEqual(events, ['vantage:signed-in', 'vantage:signed-out']);
  } finally {
    fetch.mock.restore();
    for (const [key, d] of Object.entries(previous)) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  }
});

test('an unknown saved theme falls back to the system instead of becoming an invalid theme attribute', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let value = 'invalid-theme';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => value } });
  try {
    assert.equal(storedTheme(), 'system');
    for (const valid of ['light', 'dark', 'system'] as const) { value = valid; assert.equal(storedTheme(), valid); }
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});

test('signing out forgets what was opened on this device, in both storages, and keeps everything else', async () => {
  // A shared workstation (security review C14): titles, case references and Marines' names are not left for the next person.
  const storage = (entries: Record<string, string>) => {
    const map = new Map(Object.entries(entries));
    return { get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); }, keys: () => [...map.keys()].sort() };
  };
  const local = storage({ 'vantage.recent.u1': '[{"to":"/entries/1","title":"Obligation N00123","kind":"entry"}]', 'vantage.recent.u2': '[]', 'vantage.theme': 'dark' });
  const session = storage({ 'vantage.recent.u1': '[]', 'vantage.draft.x': '{}' });
  const saved = ['localStorage', 'sessionStorage', 'document', 'window'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: local });
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: session });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { cookie: '' } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('{"ok":true}'));
  try {
    const { logout } = await import(new URL('../../src/lib/api.ts', import.meta.url).href) as { logout: () => Promise<void> };
    await logout();
    assert.deepEqual(local.keys(), ['vantage.theme'], 'the recent lists go; the theme stays');
    assert.deepEqual(session.keys(), [], 'and from the session too, with the drafts');
  } finally {
    fetch.mock.restore();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  }
});
