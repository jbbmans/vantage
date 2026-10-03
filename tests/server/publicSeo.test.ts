import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT, loadConfig } from '../../server/config.ts';
import { announcePublicPage, indexNowKey } from '../../server/services/indexNow.ts';
import { startApp } from './helpers.ts';
import { MARK_PATHS } from '../../shared/brand.ts';

test('public HTML exposes the product while private and missing routes cannot be indexed', async () => {
  assert.ok(existsSync(join(PROJECT_ROOT, 'dist/public.html')), 'Run npm run build before the public SEO test.');
  const app = await startApp();
  try {
    const unset = await app.call('GET', '/');
    assert.doesNotMatch(unset.text, /<h1\b/, 'before setup, / is the setup screen, so the public page is not prerendered there');
    assert.match((await app.call('GET', '/about')).text, /<h1\b/, 'the standalone public routes are the public page regardless');
    await app.setupOperator();
    const home = await app.call('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /<h1\b/);
    assert.match(home.text, /VANTAGE USMC/);
    assert.match(home.text, /"@type":\s*"WebSite"/);
    assert.equal(home.headers.get('x-robots-tag'), null);
    assert.match(home.headers.get('vary') || '', /Cookie/);
    assert.doesNotMatch(home.text, /googletagmanager|GTM-|google-analytics|gtag\(/);
    const csp = home.headers.get('content-security-policy') || '';
    assert.doesNotMatch(csp, /googletagmanager/);
    assert.match(csp, /frame-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);

    for (const path of ['/login', '/register', '/setup', '/records', '/work', '/team/demo', '/studio']) {
      const page = await app.call('GET', path);
      assert.equal(page.status, 200, path);
      assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow', path);
      assert.match(page.text, /<meta name="robots" content="noindex, nofollow"/);
      assert.doesNotMatch(page.text, /<link rel="canonical"/);
      assert.doesNotMatch(page.text, /application\/ld\+json/);
      assert.doesNotMatch(page.text, /googletagmanager|GTM-/, 'no tag manager on app routes');
    }
    for (const path of ['/no-such-page', '/videos/no-such-video.mp4']) {
      const missing = await app.call('GET', path);
      assert.equal(missing.status, 404, path);
      assert.equal(missing.headers.get('x-robots-tag'), 'noindex, nofollow');
    }
    for (const path of ['/index.html', '/public.html']) {
      const document = await app.call('GET', path);
      assert.equal(document.headers.get('x-robots-tag'), 'noindex, nofollow');
    }
    const about = await app.call('GET', '/about');
    assert.match(about.text, /<h1\b/);
    assert.match(about.text, /<link rel="canonical" href="https:\/\/www\.vantageusmc\.com\/"/);
    assert.equal((await app.call('GET', '/api/health')).status, 200);
  } finally {
    await app.close();
  }
});

test('responses carry the isolation headers, and only shareable images may be embedded elsewhere', async () => {
  const app = await startApp();
  try {
    const page = await app.call('GET', '/');
    assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(page.headers.get('x-permitted-cross-domain-policies'), 'none');
    assert.equal(page.headers.get('origin-agent-cluster'), '?1');
    const api = await app.call('GET', '/api/health');
    assert.equal(api.headers.get('cross-origin-resource-policy'), 'same-origin');
    const card = await app.call('GET', '/og.png', { binary: true });
    assert.equal(card.headers.get('cross-origin-resource-policy'), 'cross-origin', 'a shared link’s image has to load wherever it is shared');
    assert.doesNotMatch(page.headers.get('content-security-policy') || '', /upgrade-insecure-requests/);
  } finally { await app.close(); }
});

test('the tab icon is the logo: every declared icon exists, is versioned by content, and draws the same mark', async () => {
  const app = await startApp();
  try {
    const html = readFileSync(join(PROJECT_ROOT, 'dist/index.html'), 'utf8');
    const declared = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="([^"]+)"/g)].map((m) => m[1]);
    const manifest = JSON.parse(readFileSync(join(PROJECT_ROOT, 'dist/manifest.webmanifest'), 'utf8')) as { icons: Array<{ src: string }> };
    const icons = [...declared, ...manifest.icons.map((i) => i.src)];
    assert.ok(declared.length >= 4, 'the favicon set is declared');
    for (const href of icons) {
      assert.match(href, /\?v=[0-9a-f]{10}$/, `${href} must carry the icon set's content hash, or browsers keep the old icon`);
      const res = await app.call('GET', href, { binary: true });
      assert.equal(res.status, 200, href);
      if (!href.startsWith('/manifest')) assert.equal(res.headers.get('cross-origin-resource-policy'), 'cross-origin', `${href} is shown by other sites`);
    }
    const favicon = readFileSync(join(PROJECT_ROOT, 'public/favicon.svg'), 'utf8');
    for (const d of Object.values(MARK_PATHS)) assert.ok(favicon.includes(d), 'the favicon draws the logo’s own paths');
    // PNG colour type 2 is RGB without alpha: iOS fills transparent corners with black.
    assert.equal(readFileSync(join(PROJECT_ROOT, 'public/apple-touch-icon.png'))[25], 2, 'the home-screen icon must be opaque');
    for (const gone of ['/vantage-favicon.svg', '/app-icon.svg', '/favicon-16.png']) assert.equal((await app.call('GET', gone)).status, 404, gone);
  } finally { await app.close(); }
});

test('search engines can verify ownership and are told once when the public page changes', async () => {
  const app = await startApp({
    VANTAGE_PUBLIC_URL: 'https://vantage.example.test', VANTAGE_INDEXNOW: 'true', VANTAGE_INDEXNOW_URL: 'https://indexnow.example.test/indexnow',
    VANTAGE_GOOGLE_SITE_VERIFICATION: 'google-token_123', VANTAGE_BING_SITE_VERIFICATION: 'BING0123456789ABCDEF',
  });
  try {
    const page = await app.call('GET', '/display');
    assert.match(page.text, /<meta name="google-site-verification" content="google-token_123" \/>/);
    assert.match(page.text, /<meta name="msvalidate.01" content="BING0123456789ABCDEF" \/>/);

    const key = indexNowKey(app.ctx);
    const served = await app.call('GET', `/${key}.txt`);
    assert.equal(served.status, 200);
    assert.equal(served.text, key, 'the engines confirm a submission by fetching the key from the site');

    const sent: Array<{ url: string; body: any }> = [];
    const fetcher = (async (url: string, init: RequestInit) => { sent.push({ url, body: JSON.parse(String(init.body)) }); return new Response(null, { status: 202 }); }) as unknown as typeof fetch;
    const html = readFileSync(join(PROJECT_ROOT, 'dist/public.html'), 'utf8');
    assert.equal(await announcePublicPage(app.ctx, html, fetcher), 'sent');
    assert.deepEqual(sent[0].body, { host: 'vantage.example.test', key, keyLocation: `https://vantage.example.test/${key}.txt`, urlList: ['https://vantage.example.test/'] });
    assert.equal(await announcePublicPage(app.ctx, html.replace(/\/assets\/public-[^"]+/, '/assets/public-renamed.js'), fetcher), 'unchanged', 'a rebuild that only renames scripts is not news');
    assert.equal(await announcePublicPage(app.ctx, html.replace('A clearer picture', 'A sharper picture'), fetcher), 'sent');
    assert.equal(sent.length, 2);
  } finally { await app.close(); }

  const plain = await startApp();
  try {
    assert.equal(await announcePublicPage(plain.ctx, '<html></html>'), 'off', 'off unless the deployment turns it on');
    assert.doesNotMatch((await plain.call('GET', '/display')).text, /site-verification|msvalidate/);
  } finally { await plain.close(); }
  assert.throws(() => loadConfig({ VANTAGE_GOOGLE_SITE_VERIFICATION: '"><script>' } as NodeJS.ProcessEnv), /VANTAGE_GOOGLE_SITE_VERIFICATION/);
});

test('the public page tells every engine one consistent story, in its head, its structured data and its sitemap', async () => {
  const { SITE, FAQS } = await import('../../src/config/site.ts');
  const html = readFileSync(join(PROJECT_ROOT, 'dist/public.html'), 'utf8');
  const unescape = (s: string) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  const head = (pattern: RegExp) => unescape(html.match(pattern)?.[1] ?? '');
  assert.equal(head(/<title>([^<]+)<\/title>/), SITE.title, 'public.html and src/config/site.ts disagree on the title');
  assert.ok(SITE.title.length <= 60, 'results truncate titles past about 60 characters');
  assert.ok(SITE.description.length >= 70 && SITE.description.length <= 160, `description is ${SITE.description.length} characters`);
  for (const pattern of [/<meta name="description" content="([^"]+)"/, /<meta property="og:description" content="([^"]+)"/, /<meta name="twitter:description" content="([^"]+)"/]) {
    assert.equal(head(pattern), SITE.description, `${pattern} disagrees with src/config/site.ts`);
  }
  for (const pattern of [/<meta property="og:title" content="([^"]+)"/, /<meta name="twitter:title" content="([^"]+)"/]) assert.equal(head(pattern), SITE.title);

  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  assert.equal(blocks.length, 1, 'one linked graph, not several blocks describing the same things differently');
  const graph = blocks[0]['@graph'] as Array<Record<string, any>>;
  const of = (type: string) => graph.filter((n) => n['@type'] === type);
  assert.equal(of('Organization')[0].logo.width, 512);
  assert.equal(of('WebSite')[0].publisher['@id'], of('Organization')[0]['@id']);
  assert.equal(of('FAQPage')[0].mainEntity.length, FAQS.length);
  const videos = of('VideoObject');
  assert.ok(videos.length > 0, 'the films are described for video search');
  for (const v of videos) {
    assert.ok(v.name && v.description && v.thumbnailUrl && v.contentUrl && v.uploadDate, `${v.name} is missing a field video results require`);
    assert.match(v.duration, /^PT\d+M\d+S$/);
  }

  const sitemap = readFileSync(join(PROJECT_ROOT, 'dist/sitemap.xml'), 'utf8');
  // The public page once, and each plain-language page (security, privacy, accessibility) at its own address.
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  assert.deepEqual(locs.sort(), ['/', '/accessibility', '/privacy', '/security'], 'only canonical pages belong in the sitemap');
  assert.match(sitemap, new RegExp(`<lastmod>${SITE.updated}</lastmod>`));
  assert.equal([...sitemap.matchAll(/<video:video>/g)].length, videos.length);
  assert.doesNotMatch(sitemap.replace(/&(amp|lt|gt|quot|apos);/g, ''), /&/, 'every & in the sitemap is escaped');
});

test('every screen the app declares is served by the server, not answered with its 404 page', async () => {
  const app = await startApp();
  try {
    const source = readFileSync(join(PROJECT_ROOT, 'src', 'App.tsx'), 'utf8') + readFileSync(join(PROJECT_ROOT, 'src', 'config', 'nav.ts'), 'utf8');
    const declared = new Set<string>();
    for (const [, path] of source.matchAll(/<Route path="([^"*]+)"/g)) declared.add(path.startsWith('/') ? path : `/${path}`);
    for (const [, path] of source.matchAll(/^\s+'(\/[a-z]+)': '\//gm)) declared.add(path);
    assert.ok(declared.size > 20, `the scan found the routes (${declared.size})`);
    for (const path of declared) {
      const concrete = path.replace(/:[a-z]+/g, 'x');
      // /operator opens the owner console, which is its own document; following the move is still being served.
      const res = await fetch(app.base + concrete, { redirect: 'manual' });
      assert.ok(res.status === 200 || (path === '/operator' && res.status === 301), `${concrete} is a screen in the app, but the server answered it with ${res.status}`);
    }
  } finally { await app.close(); }
});
