import { test, expect } from '@playwright/test';

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

  test('keeps the signed-in application out of the index', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'networkidle' });
    const robots = await page.evaluate(() => document.querySelector('meta[name="robots"]')?.getAttribute('content') || '');
    expect(robots, 'sign-in must never be indexed').toContain('noindex');
  });
});
