import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { confirmSudoIfAsked, ensureSetup, loginAs, logout, OPERATOR } from './fixtures';
import { ACCENTS } from '../../shared/constants.ts';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
/** WCAG 2.2 AA. axe leaves target size (2.5.8) off unless its tag is asked for. */
const WCAG22 = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};

/** Why axe may still leave a contrast check open: what is behind the text cannot be known from the page alone. */
const CONTRAST_UNKNOWABLE = new Set(['pseudoContent', 'bgOverlap', 'elmPartiallyObscured', 'elmPartiallyObscuring', 'outsideViewport', 'shortTextContent', 'nonBmp', 'equalRatio', 'imgNode', 'bgImage', 'fgAlpha']);
/**
 * Text contrast where axe does not look by itself. A table's and a tab strip's scroll shadows (.scroll-x) are background
 * gradients, and axe leaves the contrast of any text over a gradient unchecked. With the shadows off, it measures that
 * text too, and a check it still leaves open in the page's content fails unless the reason is one no page could settle.
 * The navy rail is left out of that last check: its glow is a gradient by design, under light text far above 4.5:1.
 */
async function contrastPass(page: Page, what: string) {
  const style = await page.addStyleTag({ content: '.scroll-x,.scroll-x-canvas{background-image:none!important}' });
  try {
    const results = await new AxeBuilder({ page }).withRules(['color-contrast']).exclude('[data-radix-popper-content-wrapper]').analyze();
    const failed = results.violations.flatMap((v) => v.nodes.map((n) => `${n.target.join(' ')}: ${n.any[0]?.message ?? n.failureSummary ?? ''}`));
    expect(failed, `${what}: text below 4.5:1`).toEqual([]);
    const unsettled = results.incomplete.flatMap((v) => v.nodes)
      .map((n) => ({ target: String(n.target[0]), reason: String((n.any[0]?.data as { messageKey?: string } | null)?.messageKey ?? 'unknown') }))
      .filter((n) => !CONTRAST_UNKNOWABLE.has(n.reason));
    const inContent = await page.evaluate((targets) => targets.map((t) => Boolean(document.querySelector(t)?.closest('main'))), unsettled.map((n) => n.target));
    const open = unsettled.filter((_, i) => inContent[i]);
    expect(open.map((n) => `${n.target} (${n.reason})`), `${what}: contrast axe could not check`).toEqual([]);
  } finally {
    await style.evaluate((el) => (el as Element).remove());
  }
}

test('sign-in page has no serious accessibility violations', async ({ page, request }) => {
  await ensureSetup(request);
  await logout(page);
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(serious(results.violations)).toEqual([]);
});

test('public display page has no serious accessibility violations', async ({ page, request }) => {
  await ensureSetup(request);
  await logout(page);
  await page.goto('/display');
  await expect(page.getByRole('heading', { name: /See the work/i })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(serious(results.violations)).toEqual([]);
});

test('the plain-language pages have no serious accessibility violations', async ({ page, request }) => {
  await ensureSetup(request);
  await logout(page);
  for (const path of ['/security', '/privacy', '/accessibility', '/changes']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(serious(results.violations), path).toEqual([]);
  }
});

test('core pages have no serious accessibility violations in light and dark themes', async ({ page, request }) => {
  test.setTimeout(240_000);
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const path of ['/', '/record', '/record/activities', '/record/drafts', '/career/readiness', '/team/workload', '/reports', '/reports/analysis', '/settings?tab=security', '/team', '/career', '/work/correspondence', '/work/queue', '/work/tasks', '/operator?tab=usage', '/reference', '/reference?tab=conditions']) {
      await page.goto(path);
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
      expect(serious(results.violations), `${path} in ${theme}`).toEqual([]);
    }
  }
});

test('F8, F9: pages reflow at 320 and 390, and every target is at least 24px, at three widths', async ({ page, request }) => {
  test.setTimeout(420_000);
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const app = ['/team/workload', '/help', '/reports/analysis', '/career/awards', '/reference', '/reference?tab=conditions', '/record/timeline', '/settings'];
  const admin = ['/admin/ai', '/admin/separation', '/admin/instances', '/admin/access'];
  await page.goto('/admin/audit');
  await confirmSudoIfAsked(page);
  for (const [width, height] of [[1280, 800], [390, 844], [320, 640]]) {
    await page.setViewportSize({ width, height });
    for (const path of [...app, ...admin]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await noSidewaysScroll(page, `${path} at ${width}`);
      const results = await new AxeBuilder({ page }).withTags(WCAG22).exclude('[data-radix-popper-content-wrapper]').analyze();
      expect(serious(results.violations), `${path} at ${width}`).toEqual([]);
    }
  }
});

test('F10, F11: text keeps 4.5:1 in every accent, light and dark, including over table and tab-strip shadows', async ({ page, request }) => {
  test.setTimeout(300_000);
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const paint = (theme: string, accent: string) => page.evaluate(([t, a]) => { document.documentElement.setAttribute('data-theme', t); document.documentElement.setAttribute('data-accent', a); }, [theme, accent]);
  // The record timeline's filter chips carry a count, and the pressed one sits on the accent. Ten records make it two
  // digits: axe does not judge the contrast of a single character.
  for (let i = 0; i < 10; i++) {
    const made = await page.request.post('/api/records/activities', { headers: { 'x-vantage-client': '1' }, data: { title: `Reconciled aged ULO list ${i + 1}`, date: '2026-08-03' } });
    expect(made.ok(), await made.text()).toBeTruthy();
  }
  await page.goto('/record/timeline');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByRole('button', { pressed: true }).locator('.fig').first()).toBeVisible();
  await page.waitForLoadState('networkidle');
  for (const theme of ['light', 'dark']) {
    for (const { id } of ACCENTS) {
      await paint(theme, id);
      await contrastPass(page, `/record/timeline in ${id} ${theme}`);
    }
  }
  // Tables, audit lists and tab strips, in the default accent.
  for (const theme of ['light', 'dark']) {
    for (const path of ['/record/activities', '/record/duty', '/work/queue', '/work/tasks', '/team/workload', '/team', '/settings?tab=security']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await paint(theme, ACCENTS[0].id);
      await contrastPass(page, `${path} in ${theme}`);
    }
  }
});

test('KB-11: a file is chosen from a control that shows focus, and the input behind it takes no Tab stop', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const tabUntil = async (found: () => Promise<boolean>, stops = 20) => {
    for (let i = 0; i < stops; i++) { await page.keyboard.press('Tab'); if (await found()) return true; }
    return false;
  };

  // A drop zone: its hidden input is the one stop, so the zone draws the focus ring.
  await page.goto('/records?import=1&period=all');
  const csv = page.getByRole('dialog', { name: 'Import activities from CSV' });
  await expect(csv).toBeVisible();
  expect(await tabUntil(() => page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.type === 'file')), 'the drop zone takes Tab').toBe(true);
  const ring = await csv.locator('label:has(input[type=file])').evaluate((el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: s.outlineWidth }; });
  expect(ring, 'the drop zone shows where the keyboard is').toEqual({ style: 'solid', width: '2px' });

  // A button that opens the picker: the input behind it is never focused.
  await page.goto('/work/queue');
  await page.getByRole('button', { name: 'Import work' }).first().click();
  const wizard = page.getByRole('dialog', { name: 'Import work from a spreadsheet' });
  await expect(wizard).toBeVisible();
  const stops: string[] = [];
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => { const el = document.activeElement as HTMLInputElement | null; return el?.type === 'file' ? 'file input' : (el?.textContent || el?.getAttribute('aria-label') || el?.tagName || '').trim(); }));
  }
  expect(stops.some((s) => s.includes('Choose a file')), stops.join(' | ')).toBe(true);
  expect(stops, 'no Tab stop is the hidden file input').not.toContain('file input');
});

test('KB-09: a refused profile save moves focus to the field to fix, and says it once', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/settings?tab=profile');
  const first = page.getByLabel('First name');
  await first.fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).focus();
  await page.keyboard.press('Enter');
  await confirmSudoIfAsked(page);
  await expect(first).toBeFocused();
  await expect(first).toHaveAttribute('aria-invalid', 'true');
  await expect(first).toHaveAccessibleDescription('Required.');
  // The field's own message is the alert; no toast repeats the refusal.
  await expect(page.locator('[aria-live="polite"] [role="alert"]')).toHaveCount(0);
  expect(serious((await new AxeBuilder({ page }).withTags(WCAG22).exclude('[data-radix-popper-content-wrapper]').analyze()).violations), 'the refused profile').toEqual([]);
});
