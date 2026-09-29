import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../server/config.ts';
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
    assert.match(about.text, /<link rel="canonical" href="https:\/\/vantageusmc.com\/"/);
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
