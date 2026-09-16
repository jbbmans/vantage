import { test } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../../server/config.ts';
import { startApp } from './helpers.ts';

test('public HTML exposes the product while private and missing routes cannot be indexed', async () => {
  assert.ok(existsSync(join(PROJECT_ROOT, 'dist/public.html')), 'Run npm run build before the public SEO test.');
  const app = await startApp();
  try {
    const home = await app.call('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.text, /<h1\b/);
    assert.match(home.text, /VANTAGE USMC/);
    assert.match(home.text, /"@type":\s*"WebSite"/);
    assert.equal(home.headers.get('x-robots-tag'), null);
    assert.match(home.headers.get('vary') || '', /Cookie/);
    const gtm = home.text.match(/<script>((?:.|\n)*?GTM-T9N83KTQ(?:.|\n)*?)<\/script>/);
    assert.ok(gtm, 'GTM bootstrap must be included in the public HTML');
    assert.match(home.text, /<body>\s*<!-- Google Tag Manager \(noscript\) -->\s*<noscript><iframe src="https:\/\/www.googletagmanager.com\/ns.html\?id=GTM-T9N83KTQ"/);
    const csp = home.headers.get('content-security-policy') || '';
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(gtm[1]).digest('base64')}'`), 'CSP must permit the exact GTM bootstrap');
    assert.match(csp, /script-src[^;]*https:\/\/www.googletagmanager.com/);
    assert.match(csp, /frame-src https:\/\/www.googletagmanager.com/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);

    for (const path of ['/login', '/register', '/setup', '/records', '/work', '/team/demo', '/studio']) {
      const page = await app.call('GET', path);
      assert.equal(page.status, 200, path);
      assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow', path);
      assert.match(page.text, /<meta name="robots" content="noindex, nofollow"/);
      assert.doesNotMatch(page.text, /<link rel="canonical"/);
      assert.doesNotMatch(page.text, /application\/ld\+json/);
      assert.match(page.text, /GTM-T9N83KTQ/, 'GTM must be present on app routes too');
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
