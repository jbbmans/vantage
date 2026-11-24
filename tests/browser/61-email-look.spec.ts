import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { MAIL_PALETTE } from '../../server/services/mailLayout.ts';
import { MAIL_SAMPLES } from '../server/mailSamples.ts';
import { confirmSudoIfAsked, ensureSetup, loginAs, OPERATOR } from './fixtures';

/**
 * The seven emails as a reader's client shows them (ADR-0048): each opened in Chromium, light and dark, with every
 * request refused and counted. None is expected: the wordmark is text and nothing else is loaded. axe reads each,
 * and in dark mode the card, the ink and a toned figure take the dark palette.
 */
const hex = (rgb: string) => `#${(rgb.match(/\d+/g) || []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

async function open(page: Page, html: string) {
  const requests: string[] = [];
  await page.route('**/*', (route) => { requests.push(route.request().url()); return route.abort(); });
  await page.setContent(html, { waitUntil: 'load' });
  return requests;
}

const colorOf = (page: Page, selector: string, prop: 'color' | 'background-color') =>
  page.locator(selector).first().evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop).then(hex);

for (const kind of Object.keys(MAIL_SAMPLES)) {
  for (const scheme of ['light', 'dark'] as const) {
    test(`${kind} in ${scheme}: nothing is fetched, axe finds nothing, and the ${scheme} palette is applied`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const requests = await open(page, MAIL_SAMPLES[kind].html);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('Vantage', { exact: true }).first()).toBeVisible();
      expect(requests, `${kind} fetched something`).toEqual([]);

      const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

      const palette = MAIL_PALETTE[scheme];
      expect(await colorOf(page, 'body', 'background-color')).toBe(palette.paper.toUpperCase());
      expect(await colorOf(page, 'td.v-card', 'background-color')).toBe(palette.card.toUpperCase());
      expect(await colorOf(page, 'td.v-card p.v-ink2', 'color')).toBe(palette.ink2.toUpperCase());
      // The masthead keeps the coat's navy in both schemes.
      expect(await colorOf(page, 'h1', 'color')).toBe(MAIL_PALETTE.frame.ink.toUpperCase());
      if (await page.locator('a.v-btn').count()) {
        expect(await colorOf(page, 'td.v-btn-cell', 'background-color')).toBe(palette.accent.toUpperCase());
        expect(await colorOf(page, 'a.v-btn', 'color')).toBe(palette.accentInk.toUpperCase());
      }
      if (kind === 'digest') {
        // The overdue figure stays red and the due-soon figure amber, in the scheme's own red and amber.
        expect(await colorOf(page, 'p.v-bad', 'color')).toBe(palette.bad.toUpperCase());
        expect(await colorOf(page, 'p.v-warn', 'color')).toBe(palette.warn.toUpperCase());
        expect(await colorOf(page, 'p.v-good', 'color')).toBe(palette.good.toUpperCase());
      }
    });
  }
}

test('on a phone the card fills the width and the button spans it', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, MAIL_SAMPLES.sign_in.html);
  const shell = await page.locator('table.v-shell').boundingBox();
  expect(shell!.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);
  const button = await page.locator('a.v-btn').boundingBox();
  expect(button!.width, 'the button spans the card, less its padding').toBeGreaterThan(shell!.width - 2 * 24 - 4);
});

test('the counter would catch a fetch: an image in a message is one request, refused', async ({ page }) => {
  const requests = await open(page, MAIL_SAMPLES.reset.html.replace('<h1', '<img src="https://images.example.test/mark.png" alt=""><h1'));
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toBe('https://images.example.test/mark.png');
});

test('the Email tab says who mail may go to', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/admin/email');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: 'Email' })).toBeVisible();
  // The browser server sets no list, so every domain is allowed and the tab says how to limit it.
  await expect(page.locator('[data-allowed-domains]').first()).toHaveText('Mail may go to any domain. Set VANTAGE_EMAIL_ALLOWED_DOMAINS on the host to limit it.');
});
