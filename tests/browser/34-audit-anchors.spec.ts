import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * The audit chain's anchors in the Vantage Administrator console (Task 7, ADR-0013): the head of the chain and the last
 * anchor written into it, and a check of an anchor kept off the host, from the keyboard, with its result announced.
 * The access logs (ADR-0032): a unit's names who opened whose record, a Marine's names who opened theirs, each pages
 * back to its oldest entry, and a log that cannot load says so.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);

async function openTrail(page: Page) {
  await page.goto('/admin/audit');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: 'Platform audit trail', level: 1 })).toBeVisible();
}

test('the audit trail page shows the chain’s head and last anchor, and checks a kept anchor', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  const anchored = await page.request.post('/api/platform/integrity/anchor', { headers: H });
  expect(anchored.ok(), await anchored.text()).toBeTruthy();
  const { audit: kept } = await anchored.json() as { audit: { seq: number; hash: string; count: number } };

  await openTrail(page);
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Audit chain anchors' }) });
  await expect(panel.getByRole('heading', { name: 'Current head' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Last anchor' })).toBeVisible();
  await expect(panel.getByText(kept.hash).first(), 'the last anchor names the head it wrote').toBeVisible();
  await expect(panel.getByText(/by John Boletz/)).toBeVisible();

  const form = page.getByRole('form', { name: 'Check a kept anchor' });
  // Refused before it is sent: a hash is 64 hexadecimal characters.
  await form.getByLabel('Entry number').fill(String(kept.seq));
  await form.getByLabel('Entry hash').fill('not-a-hash');
  await form.getByRole('button', { name: 'Check anchor' }).click();
  await expect(form.getByRole('alert')).toHaveText('Enter the 64-character hash the anchor names.');

  // The anchor as the SIEM kept it holds; submitted from the keyboard.
  await form.getByLabel('Entry hash').fill(kept.hash);
  await form.getByLabel('Entry hash').press('Enter');
  const status = form.getByRole('status');
  await expect(status).toContainText('The anchor holds.');
  await expect(status).toContainText(`Entry ${kept.seq}: The entry at that position still carries the anchored hash.`);
  await expect(status).toContainText(/The chain verifies across \d+ entries\./);

  // One that does not match is reported as such, and recorded.
  await form.getByLabel('Entry hash').fill('0'.repeat(64));
  await form.getByRole('button', { name: 'Check anchor' }).click();
  await expect(status).toContainText('The anchor does not hold.');
  await expect(status).toContainText('carries a different hash');

  const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(serious(results.violations)).toEqual([]);

  // Both checks are in the trail.
  const trail = await page.request.get('/api/platform/audit?action=audit_anchor_verified&limit=5', { headers: H });
  const rows = (await trail.json()).rows as Array<{ detail: string; category: string }>;
  expect(rows.slice(0, 2).map((r) => r.category)).toEqual(['enterprise', 'enterprise']);
  expect(rows[0].detail).toContain('a different hash');
  expect(rows[1].detail).toContain('the entry matches');
});

/**
 * A Marine in G-8 whose readiness the signed-in operator opened `reads` times: each open is an entry about them, in
 * G-8's access log and in their own.
 */
async function lookedAt(browser: Browser, leader: Page, reads: number) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const username = unique('looked');
  await registerAs(page, username);
  await joinUnit(leader.request, page.request);
  const me = await (await page.request.get('/api/me')).json() as { user: { id: string; first_name: string; last_name: string } };
  for (let i = 0; i < reads; i++) {
    const read = await leader.request.get(`/api/me/readiness/${me.user.id}`, { headers: H });
    expect(read.ok(), await read.text()).toBeTruthy();
  }
  return { context, page, name: `${me.user.first_name} ${me.user.last_name}` };
}

/** Pages of `size` entries on every read of `path`, so a test needs only a few entries to page back. */
async function smallPages(page: Page, path: RegExp, size: number) {
  await page.route(path, (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set('limit', String(size));
    return route.continue({ url: url.toString() });
  });
}

test('the unit access log names who opened whose record, and pages back to the oldest entry (AUD-4, AUD-7)', async ({ page, browser }) => {
  await loginAs(page, OPERATOR.username);
  const marine = await lookedAt(browser, page, 3);
  try {
    await page.goto('/team/access-log');
    const table = page.getByRole('table', { name: 'Who has been reading records in this unit' });
    const read = table.locator('tbody tr').filter({ hasText: 'View readiness' }).filter({ hasText: marine.name }).first();
    await expect(read.locator('td').nth(1), 'who opened it').toHaveText('Cpl John Boletz');
    await expect(read.locator('td').nth(3), 'whose it was').toHaveText(marine.name);
    await expect(table.locator('tbody tr td:nth-child(2)').filter({ hasText: /^system$/ }), 'every entry here has someone behind it').toHaveCount(0);

    await smallPages(page, /\/api\/org\/units\/[^/]+\/audit/, 2);
    await page.reload();
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await page.getByRole('button', { name: 'Load older' }).click();
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(2), 'focus is on the first entry the page added').toBeFocused();
    await expect(page.getByRole('status').filter({ hasText: '4 shown, newest first' })).toBeVisible();
  } finally { await marine.context.close(); }
});

test('a Marine pages back through who has looked at their record, on a phone too (AUD-5, AUD-7)', async ({ page, browser }) => {
  await loginAs(page, OPERATOR.username);
  const marine = await lookedAt(browser, page, 3);
  try {
    const own = marine.page;
    await smallPages(own, /\/api\/me\/audit/, 2);
    await own.goto('/settings?tab=security');
    const table = own.getByRole('table', { name: 'Who has looked at your record' });
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Cpl Boletz');
    await expect(rows.first()).toContainText('View readiness');
    const more = own.getByRole('button', { name: 'Load older' });
    await more.click();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(2)).toBeFocused();
    await expect(more, 'no button once the oldest entry is shown').toHaveCount(0);

    await own.setViewportSize({ width: 390, height: 844 });
    const region = own.getByRole('region', { name: 'Who has looked at your record' });
    await region.focus();
    await expect(region).toBeFocused();
    const results = await new AxeBuilder({ page: own }).exclude('[data-radix-popper-content-wrapper]').analyze();
    expect(serious(results.violations), '/settings?tab=security at 390px').toEqual([]);
    const [scroll, width] = await own.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scroll, 'no sideways scroll of the page').toBeLessThanOrEqual(width + 1);
  } finally { await marine.context.close(); }
});

test('an access log that cannot load says so, never that nobody looked (AUD-6)', async ({ page, browser }) => {
  await loginAs(page, OPERATOR.username);
  const marine = await lookedAt(browser, page, 1);
  try {
    const own = marine.page;
    await own.route(/\/api\/me\/audit/, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Database is locked' }) }));
    await own.goto('/settings?tab=security');
    await expect(own.getByRole('alert').filter({ hasText: 'Your access log could not load' })).toBeVisible();
    await expect(own.getByText('Nobody but you')).toHaveCount(0);

    await page.route(/\/api\/org\/units\/[^/]+\/audit/, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Database is locked' }) }));
    await page.goto('/team/access-log');
    await expect(page.getByRole('alert').filter({ hasText: 'The access log could not load' })).toBeVisible();
    await expect(page.getByText('No access events yet')).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.unroute(/\/api\/org\/units\/[^/]+\/audit/);
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('table', { name: 'Who has been reading records in this unit' })).toBeVisible();
    const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
    expect(serious(results.violations), '/team/access-log at 390px').toEqual([]);
  } finally { await marine.context.close(); }
});
