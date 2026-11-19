/* Vantage service worker: offline app shell + cache-first hashed assets. API requests never touch the cache. */
/*
 * The build's identity, stamped in by the build (vite.config.ts, buildIdentity): the hash of the
 * built index.html. Every client release changes these bytes, which is what makes the browser fire
 * `updatefound` and an open copy offer the new version. Nobody has to remember to bump it.
 */
const VERSION = '__VANTAGE_BUILD__';
const SHELL = `vantage-shell-${VERSION}`;
const ASSETS = `vantage-assets-${VERSION}`;
// Icons are listed as the page asks for them, version and all, or the cache would never match the request.
const ICONS = '__ICONS__';
const SHELL_URLS = [
  '/', `/manifest.webmanifest?v=${ICONS}`, `/favicon.svg?v=${ICONS}`, `/favicon.ico?v=${ICONS}`, `/icon-192.png?v=${ICONS}`, `/icon-512.png?v=${ICONS}`,
  '/mark.svg', '/brand/mark-reversed.svg',
  '/fonts/geist-normal.woff2', '/fonts/inter-normal.woff2', '/fonts/jetbrains-normal.woff2',
];

/**
 * The application's own document, to keep as '/', or null. On a host shared with the public site, '/' answers a
 * browser that is not signed in (or holds only an ended session's cookie) with the public page, which must never
 * become the offline copy; /login is the application wherever the application is served. The navigate handler below
 * keeps the same rule.
 */
const appDocument = async () => {
  for (const path of ['/', '/login']) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (res.ok && res.headers.get('x-vantage-document') === 'app') return res;
  }
  return null;
};

self.addEventListener('install', (event) => {
  // Cached one at a time on purpose. addAll is all-or-nothing, so a single renamed font used to
  // take the whole shell down with it and leave the app with nothing to serve offline.
  event.waitUntil(
    caches.open(SHELL)
      .then((cache) => Promise.all(SHELL_URLS.map((url) => (url === '/' ? appDocument().then((res) => res && cache.put('/', res)) : cache.add(url)).catch(() => undefined))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== ASSETS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => { if (event.data === 'skip-waiting') self.skipWaiting(); });

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(caches.open(ASSETS).then(async (cache) => {
      const hit = await cache.match(request);
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) cache.put(request, res.clone());
      return res;
    }));
    return;
  }

  // A response body can be read once, so each copy for the cache is cloned before the original is handed back.
  if (request.mode === 'navigate') {
    // Only the application's own document is kept as the offline copy. The public page, the security and privacy
    // pages and the like are documents too; caching one of them as '/' left the app unable to open offline.
    event.respondWith(fetch(request).then((res) => { if (res.ok && res.headers.get('x-vantage-document') === 'app') { const copy = res.clone(); caches.open(SHELL).then((c) => c.put('/', copy)); } return res; })
      .catch(() => caches.match('/').then((hit) => hit || new Response('<!doctype html><title>Vantage</title><p style="font-family:system-ui;padding:2rem">Vantage is offline and no cached copy is available yet. Reconnect and try again.</p>', { headers: { 'content-type': 'text/html' } }))));
    return;
  }

  // '/' is a document: only the rules above keep it.
  const shellFile = url.pathname.startsWith('/fonts/') || (url.pathname !== '/' && SHELL_URLS.includes(url.pathname + url.search));
  event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => { if (res.ok && shellFile) { const copy = res.clone(); caches.open(SHELL).then((c) => c.put(request, copy)); } return res; })));
});
