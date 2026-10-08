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
  await expect(page.getByText('019_audit_action_index')).toBeVisible();
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
