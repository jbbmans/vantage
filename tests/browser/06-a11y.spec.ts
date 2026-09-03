import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, loginAs, logout, OPERATOR } from './fixtures';

// Animations fade content in; axe measures contrast on the intermediate frame if it runs mid-transition. Reduced motion disables them.
test.use({ reducedMotion: 'reduce' });

const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);

test('sign-in page has no serious accessibility violations', async ({ page, request }) => {
  await ensureSetup(request);
  await logout(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(serious(results.violations)).toEqual([]);
});

test('core pages have no serious accessibility violations in light and dark themes', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    for (const path of ['/', '/records', '/reports', '/settings?tab=security', '/team']) {
      await page.goto(path);
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
      expect(serious(results.violations), `${path} in ${theme}`).toEqual([]);
    }
  }
});
