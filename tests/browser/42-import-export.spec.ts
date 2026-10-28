import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, registerAs, unique } from './fixtures';
import { writeWorkbook } from '../../server/lib/workbook.ts';

/**
 * Import, export and download (Task 13, ADR-0019). A workbook comes in through a review that says what each row is and
 * where it goes: awards as awards, courses as training, duty listed and never made an Activity. A row that only reads
 * like an award is offered as one and goes in as one only when its owner says so. A row that cannot be read is fixed on
 * the review. The import can be undone. A person exports the categories they choose, and downloads one record from its
 * page. Each Marine here is new, so what they see is only what the test gave them.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).include('[role="dialog"]').exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};
const list = async (page: Page, table: string) => {
  const res = await page.request.get(`/api/records/${table}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()) as Array<Record<string, unknown>>;
};

const workbook = () => writeWorkbook([
  { name: 'Awards', rows: [['Name', 'Type', 'Status', 'Date'], ['Navy and Marine Corps Achievement Medal', 'Personal', 'presented', '2026-05-01']] },
  { name: 'Training', rows: [['Title', 'Date', 'Hours'], ['MarineNet Fiscal Law', '03/32/2026', 8]] },
  { name: 'Duty', rows: [['Date', 'Duty', 'Hours'], ['2026-03-01', 'Officer of the Day', 24]] },
  { name: 'Log', rows: [['Title', 'Date'], ['Received the Navy Achievement Medal at formation', '2026-06-02'], ['Reconciled 40 ULOs', '2026-06-01']] },
]);

test('a workbook comes in through its review: each record keeps its type, a fix and a suggestion are the Marine’s, and undo puts it back', async ({ page }) => {
  await registerAs(page, unique('importer'));
  await page.goto('/settings?tab=data&import=1');
  const dialog = page.getByRole('dialog', { name: 'Import records' });
  await dialog.getByLabel('Choose a file to import').setInputFiles({ name: 'my records.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook() });

  // What each sheet is, and each row under the record type it goes in as.
  await expect(dialog.getByRole('heading', { name: 'What each sheet holds' })).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Read Awards as' })).toHaveText('Awards');
  await expect(dialog.getByRole('combobox', { name: 'Read Duty as' })).toHaveText('Duty (listed, not imported)');
  for (const group of ['Awards', 'Training', 'Activities', 'Duty']) await expect(dialog.getByRole('heading', { name: new RegExp(`^${group}`), level: 4 })).toBeVisible();
  await expect(dialog.getByText(/never turned into Activities/).first()).toBeVisible();
  expect(await axe(page), 'the review').toEqual([]);

  // The course's date cannot be read: fixed on the review, and it goes in.
  const course = dialog.getByRole('listitem').filter({ hasText: 'MarineNet Fiscal Law' });
  await expect(course.getByText('Needs a fix')).toBeVisible();
  await course.getByRole('button', { name: 'Fix' }).click();
  await course.getByLabel('Date', { exact: true }).fill('2026-03-31');
  await course.getByRole('button', { name: 'Apply' }).click();
  await expect(course.getByText('New', { exact: true })).toBeVisible();

  // The log entry that reads like an award is offered as one, and goes in as one because the Marine said so.
  const medal = dialog.getByRole('listitem').filter({ hasText: 'Received the Navy Achievement Medal' });
  await medal.getByRole('button', { name: 'Import as award' }).click();
  await expect(dialog.getByRole('heading', { name: /^Awards/, level: 4 }).locator('..').getByText('Received the Navy Achievement Medal at formation')).toBeVisible();

  await dialog.getByRole('button', { name: 'Import 4 records' }).click();
  await expect(dialog.getByRole('heading', { name: 'Imported.' })).toBeFocused();
  await expect(dialog.getByText(/^Added .*2 awards/)).toBeVisible();
  expect((await list(page, 'awards')).map((a) => a.name).sort()).toEqual(['Navy and Marine Corps Achievement Medal', 'Received the Navy Achievement Medal at formation']);
  expect((await list(page, 'trainings')).map((t) => [t.title, t.date])).toEqual([['MarineNet Fiscal Law', '2026-03-31']]);
  const activities = await list(page, 'activities');
  expect(activities.map((a) => a.title)).toEqual(['Reconciled 40 ULOs']);

  // Undo: what it added goes to the recycle bin.
  await dialog.getByRole('button', { name: 'Undo this import' }).click();
  await expect(dialog.getByRole('heading', { name: 'This import was undone.' })).toBeVisible();
  expect(await list(page, 'awards')).toEqual([]);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('heading', { name: 'Recent imports' })).toBeVisible();
  await expect(page.getByRole('listitem').filter({ hasText: 'my records.xlsx' }).getByText('Undone')).toBeVisible();
});

test('a Marine exports the categories they choose, and downloads one record from its page', async ({ page }) => {
  await registerAs(page, unique('exporter'));
  const award = await (await page.request.post('/api/records/awards', { headers: H, data: { name: 'Certificate of Commendation', type: 'certificate', status: 'presented', date: '2026-02-02', visibility: 'private' } })).json();
  const entry = await (await page.request.post('/api/records/activities', { headers: H, data: { title: 'Closed out 12 ULOs', date: '2026-02-03', visibility: 'private' } })).json();

  await page.goto('/settings?tab=data');
  await expect(page.getByRole('heading', { name: 'Export everything' })).toBeVisible();
  await page.getByRole('checkbox', { name: /^Awards and recognition/ }).check();
  await page.getByRole('combobox', { name: 'Format' }).click();
  await page.getByRole('option', { name: 'CSV, one category' }).click();
  let download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export 1 category' }).click();
  await confirmSudoIfAsked(page);
  expect((await download).suggestedFilename()).toMatch(/-awards-\d{4}-\d{2}-\d{2}\.csv$/);
  // A second category: a CSV holds one, so the workbook is offered instead.
  await page.getByRole('checkbox', { name: /^Counselings/ }).check();
  await expect(page.getByRole('combobox', { name: 'Format' })).toHaveText('Excel workbook, a sheet each');

  // Awards exports its own and opens the import; the award downloads from its view.
  await page.goto('/career/awards');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('dialog', { name: 'Import records' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Export' }).click();
  await expect(page.getByRole('menuitem', { name: /As an Excel workbook/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto(`/career/awards?open=${award.id}`);
  const view = page.getByRole('dialog', { name: 'Certificate of Commendation' });
  await view.getByRole('button', { name: 'Download' }).click();
  download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /As a Vantage file/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^vantage-award-[0-9a-f-]{8}\.json$/);
  await toast(page, /Downloaded vantage-award-/);
  await page.keyboard.press('Escape');

  // An activity downloads from its page as the spreadsheet row that imports back.
  await page.goto(`/records/${entry.id}`);
  await page.getByRole('button', { name: 'Download' }).click();
  download = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /As a spreadsheet row/ }).click();
  expect((await download).suggestedFilename()).toMatch(/^vantage-activity-[0-9a-f-]{8}\.csv$/);
});

test('on a phone the import review fits and reads cleanly', async ({ page }) => {
  await registerAs(page, unique('phoneimport'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings?tab=data&import=1');
  const dialog = page.getByRole('dialog', { name: 'Import records' });
  await dialog.getByLabel('Choose a file to import').setInputFiles({ name: 'my records.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: workbook() });
  await expect(dialog.getByRole('heading', { name: 'What each sheet holds' })).toBeVisible();
  await noSidewaysScroll(page, 'the import review');
  // Phone width, tall enough that the whole review is in view: axe takes a label scrolled out of the dialog for a hidden one.
  await page.setViewportSize({ width: 390, height: 2400 });
  expect(await axe(page), 'the review on a phone').toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel import' }).click();
  await expect(dialog).toBeHidden();
});
