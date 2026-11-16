import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, loginAs, logout, registerAs, unique, OPERATOR } from './fixtures';

/**
 * The Vantage Administrator console's operations pages (Task 5, ADR-0011): each opens and reads cleanly to assistive
 * technology, maintenance is started with a reason and ended from the console, and the audit trail filters on the server.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);

async function openAdmin(page: Page, path: string, heading: string) {
  await page.goto(`/admin/${path}`);
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
}

test('the operations pages open for Vantage staff and have no serious accessibility violations', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, OPERATOR.username);
  const pages: Array<[string, string, string]> = [
    ['operations', 'Operations', 'Health'],
    ['sign-in', 'Sign-in health', 'Sign-in checks'],
    ['flags', 'Feature flags', 'Switched here'],
    ['maintenance', 'Maintenance', 'Maintenance mode'],
    ['audit', 'Platform audit trail', ''],
    ['', 'The service', 'Health'],
  ];
  for (const [path, heading, panel] of pages) {
    await openAdmin(page, path, heading);
    if (panel) await expect(page.getByRole('heading', { name: new RegExp(`^${panel}`) }).first()).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
    expect(serious(results.violations), `/admin/${path}`).toEqual([]);
  }
  // The operations page shows the build, the schema and the scheduled jobs of this server.
  await openAdmin(page, 'operations', 'Operations');
  await expect(page.getByRole('heading', { name: 'Schema and migrations' })).toBeVisible();
  // The newest migrations are listed by name, whichever they are.
  await expect(page.getByText(/This build needs schema \d+; the database is at \d+/)).toBeVisible();
  await expect(page.getByRole('cell', { name: /^0\d\d_[a-z_]+$/ }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scheduled jobs' })).toBeVisible();
});

test('maintenance is started with a reason, stops everyone else with its message, and is ended from the console', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const marineName = unique('waiting');
  const marine = await browser.newContext();
  const marinePage = await marine.newPage();
  await registerAs(marinePage, marineName);
  await loginAs(page, OPERATOR.username);
  try {
    await openAdmin(page, 'maintenance', 'Maintenance');
    const start = page.getByRole('button', { name: 'Start maintenance' });
    await expect(start, 'a reason comes first').toBeDisabled();
    await page.getByLabel('Why').fill('Restoring the database from the nightly backup');
    await page.getByLabel('What everyone else is told').fill('Vantage is being restored');
    await start.click();
    const confirm = page.getByRole('dialog', { name: 'Close Vantage to everyone but Vantage staff?' });
    await expect(confirm).toContainText('Restoring the database from the nightly backup');
    await confirm.getByRole('button', { name: 'Start maintenance' }).click();
    const banner = page.getByRole('status').filter({ hasText: 'Maintenance is on since' });
    await expect(banner, 'every page of the console says so').toBeVisible();
    await expect(page.getByText('Vantage is being restored. Try again shortly.')).toBeVisible();

    // Everyone else is stopped with the message, and the sign-in page says it.
    const refused = await marinePage.request.get('/api/records/activities');
    expect(refused.status()).toBe(503);
    expect((await refused.json()).error).toBe('Vantage is being restored. Try again shortly.');
    await logout(marinePage);
    await marinePage.goto('/login');
    await expect(marinePage.getByText('Vantage is being restored. Try again shortly. Only Vantage staff can sign in right now.')).toBeVisible();

    // A database task runs and reports.
    await page.getByRole('button', { name: 'Run: Check the database for damage' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'No damage found.' })).toBeVisible();

    await page.getByRole('button', { name: 'End maintenance' }).click();
    const end = page.getByRole('dialog', { name: 'End maintenance and open Vantage again?' });
    await end.getByLabel('Note').fill('Restore verified');
    await end.getByRole('button', { name: 'End maintenance' }).click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'Ended maintenance' }).first()).toBeVisible();
  } finally {
    // Whatever happened above, the service is open again for the specs that follow.
    await page.request.post('/api/platform/maintenance', { headers: H, data: { enabled: false } });
    await marine.close();
  }
});

test('the platform audit trail filters on the server and downloads what it shows', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await openAdmin(page, 'audit', 'Platform audit trail');
  await expect(page.getByText(/Chain intact/)).toBeVisible();
  await page.getByLabel('Search').fill('login');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText(/shown, filtered/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Login' }).first()).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^vantage-platform-audit-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('the platform audit trail filters by category from the keyboard, and each entry names its category', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await openAdmin(page, 'audit', 'Platform audit trail');
  await expect(page.getByRole('columnheader', { name: 'Action and category' })).toBeVisible();
  // The select is labelled and works without a pointer (ADR-0013).
  const category = page.getByRole('combobox', { name: 'Category' });
  await expect(category).toHaveText('All');
  await category.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('option', { name: 'User activity' }).focus();
  await page.keyboard.press('Enter');
  await expect(category).toHaveText('User activity');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText(/shown, filtered/)).toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows.first()).toContainText('User activity');
  for (const text of await rows.allInnerTexts()) expect(text).toContain('User activity');
  const results = await new AxeBuilder({ page }).analyze();
  expect(serious(results.violations)).toEqual([]);
});

test('the operations pages fit tablet and phone widths without sideways scrolling', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, OPERATOR.username);
  for (const [w, h] of [[768, 1024], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const [path, heading] of [['operations', 'Operations'], ['sign-in', 'Sign-in health'], ['flags', 'Feature flags'], ['maintenance', 'Maintenance'], ['audit', 'Platform audit trail']]) {
      await openAdmin(page, path, heading);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `/admin/${path} at ${w}px`).toBeLessThanOrEqual(1);
      // The trail is wider than a phone: its columns scroll inside a named region the keyboard reaches.
      if (path === 'audit' && w === 390) {
        const region = page.getByRole('region', { name: 'Audit entries, newest first' });
        await region.focus();
        await expect(region).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
        const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
        expect(serious(results.violations), `/admin/audit at ${w}px`).toEqual([]);
      }
    }
  }
});

/** Pages of `size` entries instead of 200, so a test needs only a few entries to page back. */
async function smallPages(page: Page, size: number) {
  await page.route(/\/api\/platform\/audit\?/, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', String(size));
    return route.continue({ url: url.toString() });
  });
}

test('pages read back stay when the window regains focus; focus moves to the first older entry (AUD-9)', async ({ page }) => {
  await page.clock.install();
  await smallPages(page, 4);
  await loginAs(page, OPERATOR.username);
  await openAdmin(page, 'audit', 'Platform audit trail');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(4);
  await page.getByRole('button', { name: 'Load older' }).click();
  await expect(rows).toHaveCount(8);
  await expect(rows.nth(4), 'focus is on the first entry the page added').toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: '8 shown, newest first' })).toBeVisible();

  let reads = 0;
  page.on('request', (r) => { if (/\/api\/platform\/audit\?/.test(r.url())) reads += 1; });
  // Past the point where a read would have gone stale, the reader comes back to the window.
  await page.clock.fastForward('01:05');
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(500);
  expect(reads, 'coming back to the window reads nothing').toBe(0);
  await expect(rows).toHaveCount(8);

  // Refresh reads every page shown again, and keeps them.
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
  await expect(rows).toHaveCount(8);
});

test('a backwards date range is said at its field, the count is announced, and a long detail is shown whole (AUD-12)', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  // An entry with a long detail: an anchor check names the hash it was given.
  const checked = await page.request.post('/api/platform/integrity/verify', { headers: H, data: { seq: 1, entry_hash: 'e'.repeat(64) } });
  expect(checked.ok(), await checked.text()).toBeTruthy();
  await openAdmin(page, 'audit', 'Platform audit trail');
  const from = page.getByLabel('From (UTC)');
  await from.fill('2026-03-10');
  await page.getByLabel('To (UTC)').fill('2026-03-01');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(from).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert').filter({ hasText: 'From is after To' })).toBeVisible();
  await expect(page.getByText(/shown, filtered/), 'nothing was sent').toHaveCount(0);

  await page.getByLabel('To (UTC)').fill('2099-12-31');
  await expect(from).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Search').fill('anchor');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('status').filter({ hasText: /shown, filtered/ })).toBeVisible();
  const detail = page.getByRole('cell', { name: new RegExp(`hash ${'e'.repeat(64)}`) }).first();
  await expect(detail).toBeVisible();
  expect(await detail.evaluate((el) => [getComputedStyle(el).textOverflow, getComputedStyle(el).whiteSpace])).toEqual(['clip', 'normal']);
  const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(serious(results.violations)).toEqual([]);
});

test('the platform trail says it could not load rather than showing an empty trail', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.route(/\/api\/platform\/audit\?/, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Database is locked' }) }));
  await openAdmin(page, 'audit', 'Platform audit trail');
  await expect(page.getByRole('alert').filter({ hasText: 'The audit trail could not load' })).toBeVisible();
  await expect(page.getByText('Nothing matches')).toHaveCount(0);
});
