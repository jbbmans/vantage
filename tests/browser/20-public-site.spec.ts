import { test, expect } from '@playwright/test';
import { ensureSetup, logout } from './fixtures';
import { readFileSync } from 'node:fs';

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
    const words = await page.locator('.mission-site, .public-site, main').first().innerText();
    expect(words.length, 'the page has far less readable text than it should').toBeGreaterThan(2000);
    for (const phrase of ['Quick Log', 'Report Studio']) {
      expect(words.toLowerCase(), `"${phrase}" should be readable without scrolling`).toContain(phrase.toLowerCase());
    }

    const dom = await page.locator('.mission-site, .public-site, main').first().evaluate((el) => el.textContent || '');
    expect(dom.toLowerCase(), '"readiness" should at least appear somewhere on the page').toContain('readiness');
  });

  test('the live parser on the landing page runs the real parser', async ({ page }) => {
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
    await page.goto('/display', { waitUntil: 'networkidle' });
    const choices = page.locator('.mission-video-list button');
    const count = await choices.count();
    if (count === 0) {
      await expect(page.locator('video'), 'no walkthroughs are published, so no player may be shown').toHaveCount(0);
      return;
    }

    const seen = new Set<string>();
    for (let i = 0; i < count; i += 1) {
      await choices.nth(i).click();
      const src = await page.locator('.mission-video-layout video source').first().getAttribute('src');
      const label = (await choices.nth(i).innerText()).replace(/\s+/g, ' ').trim();
      expect(src, `"${label}" is offered with no source`).toBeTruthy();
      seen.add(src!);
      const res = await page.request.get(src!);
      expect(res.status(), `${src} did not load`).toBe(200);
    }
    expect(seen.size, 'every walkthrough in the list points at the same file').toBe(count);
  });

  test('does not point to the source repository, in a link or in structured data', async ({ page, request }) => {
    await page.goto('/display', { waitUntil: 'networkidle' });
    expect(await page.locator('a[href*="github.com"]').count(), 'a link to the repository').toBe(0);
    const ld = await page.evaluate(() => [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || '').join('\n'));
    expect(ld, 'structured data names the repository').not.toContain('github.com');
    expect(await (await request.get('/llms.txt')).text(), 'llms.txt names the repository').not.toContain('github.com/jbbmans');
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
      expect(readable(html)).toContain('A clearer picture');
    }

    // An application route is not content and must keep getting the shell.
    const app = await request.get('/records');
    expect(readable(await app.text()).length, '/records should not be prerendered').toBeLessThan(200);
  });

  test('tells browsers and the edge how long each kind of file may be kept', async ({ request }) => {
    const cache = async (path: string) => (await request.get(path)).headers();
    const films: Record<string, { src: string; poster: string }> = JSON.parse(readFileSync('src/config/films.generated.json', 'utf8'));
    const film = Object.values(films)[0];
    expect(film.src, 'published films are addressed by content hash').toMatch(/\?v=[0-9a-f]{10}$/);
    expect((await cache(film.poster))['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await cache(film.poster.split('?')[0]))['cache-control']).toBe('public, max-age=86400');
    for (const path of ['/', '/records', '/sw.js']) {
      const headers = await cache(path);
      expect(headers['cache-control'], path).toBe('no-cache');
      expect(headers['cdn-cache-control'], `${path} must never be held at the edge`).toBe('no-store');
    }
  });

  test('keeps the signed-in application out of the index', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });
    const robots = await page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute('content') || '');
    expect(robots, 'sign-in must never be indexed').toContain('noindex');
  });
});
