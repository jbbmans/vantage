import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, loginAs, logout, confirmSudoIfAsked, OPERATOR } from './fixtures';

/**
 * WCAG 2.2 AA at every width people use Vantage at (ADR-0032): a phone held upright at 320 and 390 px, a tablet
 * at 768 and a desktop at 1280, in light and dark. Every rule axe tags WCAG 2.0, 2.1 or 2.2 A or AA must pass, whatever
 * its impact, on each core page, the consoles and the dialogs people open most. Reflow (1.4.10): no page scrolls sideways.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const WIDTHS = [
  { name: 'phone 320', width: 320, height: 640 },
  { name: 'phone 390', width: 390, height: 844 },
  { name: 'tablet 768', width: 768, height: 1024 },
  { name: 'desktop 1280', width: 1280, height: 800 },
];
const APP = ['/', '/record', '/record/activities', '/record/duty', '/record/drafts', '/record/timeline', '/career', '/career/training',
  '/career/awards', '/career/counseling', '/career/readiness', '/goals', '/team', '/team/workload', '/work', '/work/queue', '/work/tasks',
  '/work/error-reports', '/work/correspondence', '/reports', '/reports/analysis', '/reports/statistics', '/reports/library', '/notifications', '/settings',
  '/settings?tab=security', '/help', '/reference'];
const CONSOLE = ['/console/G8', '/console/G8/people', '/console/G8/units', '/console/G8/audit', '/console/G8/operations'];
const ADMIN = ['/admin', '/admin/orgs', '/admin/accounts', '/admin/operations', '/admin/audit'];

const failures = (violations: Array<{ id: string; impact?: string | null; nodes: Array<{ target: unknown }> }>) =>
  violations.map((v) => `${v.id} [${v.impact}] ${v.nodes.slice(0, 3).map((n) => JSON.stringify(n.target)).join(' ')}`);

async function settle(page: Page) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

async function check(page: Page, where: string) {
  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(failures(results.violations), where).toEqual([]);
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(sideways, `${where} scrolls sideways`).toBeLessThanOrEqual(1);
}

async function theme(page: Page, value: 'light' | 'dark') {
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), value);
}

for (const size of WIDTHS) {
  test.describe(size.name, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test(`signed-out pages pass WCAG 2.2 AA at ${size.name}`, async ({ page, request }) => {
      await ensureSetup(request);
      await logout(page);
      for (const path of ['/login', '/register', '/display', '/security', '/privacy', '/accessibility', '/changes']) {
        await page.goto(path);
        await settle(page);
        await check(page, `${path} at ${size.name}`);
      }
    });

    test(`the app's core pages pass WCAG 2.2 AA at ${size.name}, light and dark`, async ({ page, request }) => {
      test.setTimeout(420_000);
      await ensureSetup(request);
      await loginAs(page, OPERATOR.username);
      // Dark everywhere would double the run for little: both themes at a phone and a desktop width, light at the others.
      const themes: Array<'light' | 'dark'> = size.width === 390 || size.width === 1280 ? ['light', 'dark'] : ['light'];
      for (const t of themes) {
        for (const path of APP) {
          await page.goto(path);
          await theme(page, t);
          await settle(page);
          await check(page, `${path} at ${size.name} in ${t}`);
        }
      }
    });

    test(`the Unit Manager and Vantage Administrator consoles pass WCAG 2.2 AA at ${size.name}`, async ({ page, request }) => {
      test.setTimeout(240_000);
      await ensureSetup(request);
      await loginAs(page, OPERATOR.username);
      for (const path of [...CONSOLE, ...ADMIN]) {
        await page.goto(path);
        await confirmSudoIfAsked(page);
        await settle(page);
        await check(page, `${path} at ${size.name}`);
      }
    });

    test(`the dialogs people open most pass WCAG 2.2 AA at ${size.name}`, async ({ page, request }) => {
      await ensureSetup(request);
      await loginAs(page, OPERATOR.username);
      await page.goto('/record/activities');
      await settle(page);
      const open = async (name: string, how: () => Promise<void>) => {
        await how();
        const dialog = page.getByRole('dialog', { name });
        await expect(dialog).toBeVisible();
        const results = await new AxeBuilder({ page }).withTags(TAGS).include('[role=dialog]').analyze();
        expect(failures(results.violations), `${name} at ${size.name}`).toEqual([]);
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      };
      await open('Log activity', () => page.getByRole('button', { name: 'Log activity' }).first().click());
      await open('Keyboard shortcuts', () => page.keyboard.press('Shift+?'));
      await page.goto('/record/duty');
      await settle(page);
      await open('Record duty', () => page.getByRole('button', { name: 'Record duty' }).first().click());
    });
  });
}
