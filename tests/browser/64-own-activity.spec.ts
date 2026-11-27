import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, loginAs, logout, registerAs, unique, PASSWORD } from './fixtures';

/**
 * A Marine's own activity (Settings, Your activity): what they did in Vantage, and what happened on their account with
 * nobody signed in, marked as such. Filtered on the server by category, action and UTC days, a page at a time.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** Every read of the activity asks for `size` entries a page, so a short history still has an older page. */
async function smallPages(page: Page, size: number) {
  await page.route(/\/api\/me\/activity/, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', String(size));
    return route.continue({ url: url.toString() });
  });
}

test('a Marine finds their sign-in and an entry they made under Your activity, and narrows it by category', async ({ page }) => {
  const username = unique('mine');
  await registerAs(page, username);
  const title = unique('Reconciled the travel card ledger ');
  const made = await page.request.post('/api/records/activities', { headers: H, data: { title, date: '2026-09-01', visibility: 'private' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  await logout(page);
  // A wrong password on the account, then the Marine signing in.
  const wrong = await page.request.post('/api/auth/login', { headers: H, data: { username, password: `${PASSWORD}-not` } });
  expect(wrong.status()).toBe(401);
  await loginAs(page, username);

  await page.goto('/settings?tab=activity');
  await expect(page.getByRole('tab', { name: 'Your activity', selected: true })).toBeVisible();
  const table = page.getByRole('table', { name: 'Your activity, newest first' });
  const rows = table.locator('tbody tr');
  await expect(rows.first()).toContainText('Signed in');
  await expect(rows.filter({ hasText: 'Added an activity' })).toHaveCount(1);
  // The failed sign-in was nobody signed in: it is on the account, and says so.
  const failed = rows.filter({ hasText: 'A sign-in failed' });
  await expect(failed).toHaveCount(1);
  await expect(failed).toContainText('On your account');
  await expect(rows.filter({ hasText: 'Signed in' }).first()).not.toContainText('On your account');
  // No address is on the screen, the Marine's own or anyone's.
  await expect(table).not.toContainText(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1/);

  // Narrowed by category and action, on the server.
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: 'User activity' }).click();
  await page.getByRole('combobox', { name: 'Action' }).click();
  await page.getByRole('option', { name: 'Signed in', exact: true }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByRole('status').filter({ hasText: '1 shown, filtered, newest first' })).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Signed in');
  await expect(rows.first()).toContainText('User activity');
  await page.getByRole('combobox', { name: 'Category' }).click();
  await page.getByRole('option', { name: 'Unit administration' }).click();
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Nothing matches')).toBeVisible();
  await page.getByRole('button', { name: 'Clear' }).click();
  await expect(rows.filter({ hasText: 'Added an activity' })).toHaveCount(1);

  // A day range the server would refuse is said at the field, before anything is sent.
  await page.getByLabel('From (UTC)').fill('2026-11-20');
  await page.getByLabel('To (UTC)').fill('2026-11-01');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('On or after the first day.')).toBeVisible();

  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`), '/settings?tab=activity').toEqual([]);
});

test('Your activity pages back to the oldest entry on a phone, with focus on the first entry a page added', async ({ page }) => {
  const username = unique('older');
  await registerAs(page, username);
  // Five entries made, and the account's own: more than three pages of two.
  for (let i = 0; i < 5; i++) {
    const made = await page.request.post('/api/records/activities', { headers: H, data: { title: unique(`Closed out travel voucher ${i} `), date: '2026-09-02', visibility: 'private' } });
    expect(made.ok(), await made.text()).toBeTruthy();
  }
  const whole = await page.request.get('/api/me/activity?limit=1000', { headers: H });
  expect(whole.ok(), await whole.text()).toBeTruthy();
  const all = (await whole.json()).rows as Array<{ id: string }>;
  expect(all.length, 'more than three pages of two').toBeGreaterThan(6);
  await smallPages(page, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings?tab=activity');
  const rows = page.getByRole('table', { name: 'Your activity, newest first' }).locator('tbody tr');
  await expect(rows).toHaveCount(2);
  const more = page.getByRole('button', { name: 'Load older' });
  await more.click();
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(2), 'focus is on the first entry the page added').toBeFocused();
  // Back to the oldest, a page at a time, for as long as entries remain unshown. Each page lands before the button is
  // looked for again, and a button gone too soon fails here rather than waits.
  for (let shown = 4; shown < all.length; shown = Math.min(shown + 2, all.length)) {
    await expect(more, `Load older, with ${all.length - shown} entries older than the ${shown} shown`).toBeEnabled();
    await more.click();
    await expect(rows).toHaveCount(Math.min(shown + 2, all.length));
    await expect(rows.nth(shown), 'focus is on the first entry the page added').toBeFocused();
  }
  await expect(more, 'nothing older is left to load').toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: new RegExp(`^${all.length} shown, newest first$`) })).toBeVisible();
  await expect(rows.last()).toHaveAttribute('id', `my-activity-${all.at(-1)!.id}`);
  await expect(rows.last()).toContainText(/Signed in for the first time|Created your account/);

  const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`), '/settings?tab=activity at 390px').toEqual([]);
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, 'no sideways scroll of the page').toBeLessThanOrEqual(width + 1);
});
