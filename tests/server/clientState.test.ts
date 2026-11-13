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

test('an unknown saved theme falls back to the system instead of becoming an invalid theme attribute', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  let value = 'invalid-theme';
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => value } });
  try {
    assert.equal(storedTheme(), 'system');
    for (const valid of ['light', 'dark', 'system'] as const) { value = valid; assert.equal(storedTheme(), valid); }
  } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else Reflect.deleteProperty(globalThis, 'localStorage'); }
});
