import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, loginAs, quickLog, unique, OPERATOR } from './fixtures';

/**
 * Unified analytics (Task 21, ADR-0028). The Unit dashboard answers questions about the unit's casework, duty, training
 * and personnel. Every chart is headed by its question, switches to a table of the same figures, prints with that table,
 * and opens the records behind each bar, by pointer or keyboard. It reads cleanly to assistive technology in both
 * themes and fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};
const theme = (page: Page, t: 'light' | 'dark') => page.evaluate((x) => document.documentElement.setAttribute('data-theme', x), t);

test('casework: each figure answers a question, opens the cases it counts, and has a table that prints', async ({ page }) => {
  test.setTimeout(120_000);
  const title = `Analytics check ${unique('')}`;
  const made = await page.request.post('/api/work/items', { headers: H, data: { unit_id: 'G8', title } });
  expect(made.ok(), await made.text()).toBeTruthy();

  await page.goto('/team/dashboard?unit=G8');
  // Output stays the default, with its members.
  await expect(page.getByRole('tab', { name: 'Output', selected: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Casework' }).click();
  await expect(page).toHaveURL(/show=work/);
  await expect(page.getByRole('link', { name: 'Print or file' })).toHaveAttribute('href', /type=financial/);
  const aging = page.getByRole('figure', { name: 'How long have the open cases been open?' });
  await expect(aging).toBeVisible();
  await expect(page.getByRole('figure', { name: 'Are cases being closed as fast as they arrive?' })).toBeVisible();

  // A headline figure opens the cases behind it, and each case opens.
  await page.getByRole('button', { name: /^Open now: \d+\. Show the \d+ cases?$/ }).click();
  const list = page.getByRole('dialog', { name: 'Open now' });
  await expect(list).toBeVisible();
  await expect(list).toContainText('Where does the casework stand?');
  expect(await axe(page), 'the drill dialog').toEqual([]);
  await list.getByRole('link', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  // By keyboard: a bar is a button that opens its cases, and closing returns to it.
  await page.goBack();
  const bar = aging.getByRole('button', { name: /^Under 7 days: \d+\. Show the \d+ cases?$/ });
  await bar.focus();
  await page.keyboard.press('Enter');
  const under7 = page.getByRole('dialog', { name: 'Under 7 days' });
  await expect(under7.getByText(title)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(under7).toBeHidden();
  await expect(bar).toBeFocused();

  // The same figures as a table, which the chart's question names.
  await aging.getByRole('tab', { name: 'Table' }).click();
  const table = aging.getByRole('table', { name: 'How long have the open cases been open?' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('rowheader', { name: 'Over 90 days' })).toBeVisible();
  await aging.getByRole('tab', { name: 'Chart' }).click();
  await expect(table).toBeHidden();

  for (const t of ['light', 'dark'] as const) {
    await theme(page, t);
    expect(await axe(page), `casework, ${t}`).toEqual([]);
  }
  await theme(page, 'light');

  // Printed, a chart carries its table and drops its switch.
  await page.emulateMedia({ media: 'print' });
  await expect(table).toBeVisible();
  await expect(aging.getByRole('tab', { name: 'Table' })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });

  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'casework at phone width');
});

test('duty, training and personnel each answer their questions, in both themes and at phone width', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/team/dashboard?show=duty');
  await expect(page.getByRole('heading', { name: 'How much duty is being stood, and how much counts yet?' })).toBeVisible();
  await expect(page.getByRole('figure', { name: 'How long has duty waited for review?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Print or file' })).toHaveAttribute('href', /type=duty/);

  await page.getByRole('tab', { name: 'Training' }).click();
  await expect(page.getByRole('heading', { name: 'How much training is being done?' })).toBeVisible();
  await expect(page.getByRole('figure', { name: 'How many training hours each month?' })).toBeVisible();

  await page.getByRole('tab', { name: 'Personnel' }).click();
  await expect(page.getByRole('heading', { name: 'Who is on the roster, and where are the gaps?' })).toBeVisible();
  // The roster stands on today, so it has no window.
  await expect(page.getByRole('combobox', { name: 'Window' })).toHaveCount(0);
  await page.getByRole('button', { name: /^On the roster: \d+\. Show the \d+ Marines?$/ }).click();
  const roster = page.getByRole('dialog', { name: 'On the roster' });
  // One's own row is listed and not linked: one's own record is not opened from a roster.
  await expect(roster.getByText(/Boletz/).first()).toBeVisible();
  await expect(roster.getByRole('link', { name: /Boletz/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  for (const [show, tab] of [['duty', 'Duty'], ['training', 'Training'], ['personnel', 'Personnel']] as const) {
    await page.goto(`/team/dashboard?show=${show}`);
    await expect(page.getByRole('tab', { name: tab, selected: true })).toBeVisible();
    await expect(page.getByRole('figure').first()).toBeVisible();
    for (const t of ['light', 'dark'] as const) {
      await theme(page, t);
      expect(await axe(page), `${show}, ${t}`).toEqual([]);
    }
    await theme(page, 'light');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const show of ['output', 'duty', 'training', 'personnel']) {
    await page.goto(`/team/dashboard?show=${show}`);
    await expect(page.getByRole('tab', { name: 'Output' })).toBeVisible();
    await noSidewaysScroll(page, `${show} at phone width`);
  }
});

test('the personal analysis opens the entries behind a month of its trend', async ({ page }) => {
  const title = `Reconciled ${unique('')} travel vouchers`;
  const dialog = await quickLog(page, title);
  await dialog.getByRole('button', { name: 'Save activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Activity logged.' })).toBeVisible();

  await page.goto('/reports/analysis');
  await page.getByRole('tab', { name: 'Full analysis' }).click();
  const trend = page.getByRole('figure', { name: 'How many entries were logged each month?' });
  await expect(trend).toBeVisible();
  await trend.getByRole('button', { name: /Show the \d+ entr(y|ies)$/ }).last().click();
  const entries = page.getByRole('dialog');
  await expect(entries.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  await expect(entries.getByText(/does not match the figure/)).toHaveCount(0);
  await entries.getByRole('link', { name: new RegExp(title) }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
});
