import { test, expect } from '@playwright/test';
import { ensureSetup, logout } from './fixtures';

/**
 * The public page has to be whole before anybody scrolls.
 *
 * It was not. `[data-reveal] { opacity: 0 }` plus an IntersectionObserver left 28 of the page's 30
 * sections invisible until a human scrolled past them. On a desktop that looked like a working site
 * to whoever built it, because building it involves scrolling. Everyone else — a social preview, a
 * screenshot, a print, a person whose JavaScript failed, and most expensively a search engine
 * renderer that does not scroll — got a hero and then eleven thousand pixels of nothing.
 *
 * So this asserts the resting state, not the scrolled state: nothing is transparent, and the text a
 * crawler would read is actually present, before a single scroll event. A reveal animation is fine;
 * it just has to move things rather than hide them.
 */
test.describe('the public site', () => {
  test('is fully visible before anybody scrolls', async ({ page }) => {
    await page.goto('/display', { waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: /See the work/i })).toBeVisible();

    const invisible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-reveal]'))
        .filter((el) => Number(getComputedStyle(el).opacity) < 0.99)
        .map((el) => el.className || el.tagName));

    expect(invisible, `sections still transparent at rest: ${invisible.join(', ')}`).toEqual([]);
  });

  test('carries its substance in the first render, not after a scroll', async ({ page }) => {
    await page.goto('/display', { waitUntil: 'networkidle' });
    // Rendered text, so a section hidden by CSS would not count even though it is in the DOM.
    const words = await page.locator('main, .public-site').first().innerText();
    // The page is a long marketing page; if it ever drops under this it has collapsed to the hero.
    expect(words.length, 'the page has far less readable text than it should').toBeGreaterThan(3000);
    for (const phrase of ['Quick Log', 'Report Studio', 'readiness']) {
      expect(words.toLowerCase(), `"${phrase}" should be readable without scrolling`).toContain(phrase.toLowerCase());
    }
  });

  test('the live parser on the landing page runs the real parser', async ({ page }) => {
    // The demo imports the product's own parseQuickLog rather than faking output. That is only
    // worth doing if it stays wired: a demo that drifts into a hard-coded result is a lie told to
    // somebody deciding whether to trust the product. So this types a sentence the page has never
    // seen and checks the fields actually come out of it.
    await page.goto('/display', { waitUntil: 'networkidle' });
    const input = page.locator('#live-parser-input');
    await input.scrollIntoViewIfNeeded();
    await input.fill('Validated 48 UMTs worth $12,400 in SABRS 3 days ago');

    const chips = page.locator('.parse-chip');
    await expect(chips.first()).toBeVisible();
    const text = (await chips.allInnerTexts()).join(' | ');
    expect(text, 'the quantity was not read out of the sentence').toContain('48 UMTs');
    expect(text, 'the dollar figure was not read out of the sentence').toContain('12,400');
    expect(text, 'the system was not recognised').toContain('SABRS');
  });

  test('every walkthrough offered on the landing page actually plays', async ({ page }) => {
    // The landing grid shows only recorded videos, so a card with no source — or a source that
    // 404s — means the page is advertising something that does not exist.
    await page.goto('/display', { waitUntil: 'networkidle' });
    const sources = await page.locator('.video-card video source').evaluateAll((els) =>
      els.map((e) => (e as HTMLSourceElement).getAttribute('src') || ''));
    expect(sources.length, 'the landing page offers no walkthroughs at all').toBeGreaterThan(0);
    for (const src of sources) {
      expect(src, 'a video card has no source').toBeTruthy();
      const res = await page.request.get(src);
      expect(res.status(), `${src} did not load`).toBe(200);
    }
  });

  test('tells search engines what it is, and keeps the private side out of the index', async ({ page }) => {
    await page.goto('/display', { waitUntil: 'networkidle' });
    const meta = await page.evaluate(() => ({
      title: document.title,
      description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      robots: document.querySelector('meta[name="robots"]')?.getAttribute('content') || '',
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
      ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || '',
      ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '',
      jsonLd: Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => s.textContent || ''),
      h1s: Array.from(document.querySelectorAll('h1')).length,
    }));

    expect(meta.title.length, 'title is missing or too short').toBeGreaterThan(15);
    expect(meta.title.length, 'title will be truncated in results').toBeLessThanOrEqual(65);
    expect(meta.description.length, 'description is missing or too short').toBeGreaterThan(70);
    expect(meta.description.length, 'description will be truncated in results').toBeLessThanOrEqual(165);
    expect(meta.robots, 'the public page must be indexable').toContain('index');
    expect(meta.robots).not.toContain('noindex');
    expect(meta.canonical, 'a canonical URL keeps duplicates from splitting the ranking').toMatch(/^https?:\/\//);
    expect(meta.ogTitle.length, 'shared links need their own title').toBeGreaterThan(10);
    expect(meta.ogImage, 'a shared link with no image gets a fraction of the clicks').toMatch(/^https?:\/\//);
    expect(meta.h1s, 'a page should have exactly one h1').toBe(1);
    expect(meta.jsonLd.length, 'structured data missing').toBeGreaterThan(0);
    for (const block of meta.jsonLd) expect(() => JSON.parse(block), 'structured data must parse').not.toThrow();
  });

  test('the sign-in fields carry their own label and error association', async ({ page, request }) => {
    // Field used to clone its direct child, which stopped working the moment an input was wrapped
    // for an icon — the aria landed on a <div> and the error was never announced. The assertion is
    // on the input itself for that reason: anything else passes while a screen reader gets nothing.
    await ensureSetup(request);
    await logout(page);
    await page.goto('/login', { waitUntil: 'networkidle' });
    const username = page.locator('input[autocomplete*="username"]').first();
    await username.waitFor();
    const labelledBy = await username.getAttribute('aria-labelledby');
    const ariaLabel = await username.getAttribute('aria-label');
    expect(labelledBy || ariaLabel, 'the username input has no accessible name of its own').toBeTruthy();
    if (labelledBy) {
      await expect(page.locator(`#${labelledBy}`), 'aria-labelledby points at nothing').toHaveCount(1);
    }
  });

  test('hands a crawler the whole page without running any JavaScript', async ({ request }) => {
    /*
     * The point of the prerender. These are raw HTTP responses — no browser, no JavaScript — which
     * is what Bing and the crawlers behind AI answers largely are. Before this the public page
     * answered with an empty <div id="root">.
     *
     * The negative half matters as much: a signed-in request, and any route that is not the public
     * page, must still get the plain shell. A prerendered marketing page served at /records, or to
     * somebody on their way to their dashboard, would be a worse bug than the one this fixes.
     */
    const readable = (html: string) => html
      .replace(/<script[\s\S]*?<\/script>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    for (const path of ['/', '/display']) {
      const res = await request.get(path, { headers: { 'user-agent': 'Googlebot/2.1' } });
      expect(res.status(), `${path} did not respond`).toBe(200);
      const html = await res.text();
      const words = readable(html).split(' ').filter(Boolean).length;
      expect(words, `${path} returned ${words} words of readable HTML before JavaScript`).toBeGreaterThan(400);
      expect(html, `${path} should tell caches it varies by cookie`).toBeTruthy();
      expect(res.headers().vary || '', `${path} must send Vary: Cookie`).toContain('Cookie');
      expect(readable(html)).toContain('Prove the impact');
    }

    // An application route is not content and must keep getting the shell.
    const app = await request.get('/records');
    expect(readable(await app.text()).length, '/records should not be prerendered').toBeLessThan(200);
  });

  test('keeps the signed-in application out of the index', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });
    const robots = await page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute('content') || '');
    expect(robots, 'sign-in must never be indexed').toContain('noindex');
  });
});
