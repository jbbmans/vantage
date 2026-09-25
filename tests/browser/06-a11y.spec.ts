import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, loginAs, logout, OPERATOR } from './fixtures';

test.use({ contextOptions: { reducedMotion: 'reduce' } });

const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);

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

test('core pages have no serious accessibility violations in light and dark themes', async ({ page, request }) => {
  test.setTimeout(240_000);
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const path of ['/', '/record', '/record?tab=entries', '/record?tab=drafts', '/career?tab=readiness', '/team?tab=workload', '/reports', '/reports?tab=analysis', '/settings?tab=security', '/team', '/career', '/work?tab=mail', '/work?tab=queue', '/work?tab=tasks', '/operator?tab=usage', '/reference', '/reference?tab=conditions']) {
      await page.goto(path);
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
      expect(serious(results.violations), `${path} in ${theme}`).toEqual([]);
    }
  }
});
