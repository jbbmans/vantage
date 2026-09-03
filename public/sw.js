/* Vantage service worker: offline app shell + cache-first hashed assets. API requests never touch the cache. */
const VERSION = 'v5-1';
const SHELL = `vantage-shell-${VERSION}`;
const ASSETS = `vantage-assets-${VERSION}`;
const SHELL_URLS = ['/', '/manifest.webmanifest', '/mark.svg', '/icon-192.png', '/icon-512.png', '/fonts/inter-tight-latin.woff2', '/fonts/plex-mono-500.woff2'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_URLS).catch(() => undefined)).then(() => self.skipWaiting()));
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

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then((res) => { if (res.ok) caches.open(SHELL).then((c) => c.put('/', res.clone())); return res; })
      .catch(() => caches.match('/').then((hit) => hit || new Response('<!doctype html><title>Vantage</title><p style="font-family:system-ui;padding:2rem">Vantage is offline and no cached copy is available yet. Reconnect and try again.</p>', { headers: { 'content-type': 'text/html' } }))));
    return;
  }

  event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then((res) => { if (res.ok && (url.pathname.startsWith('/fonts/') || SHELL_URLS.includes(url.pathname))) caches.open(SHELL).then((c) => c.put(request, res.clone())); return res; })));
});
