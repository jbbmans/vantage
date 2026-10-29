import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * Financial error reports (Task 15, ADR-0021). A leader files a ULO report from a CSV, says which column identifies an
 * error and which statuses close one, files the next week's, and reads what changed: each figure and each line of a
 * group opens the rows it counts, with the file and row each came from. A report filed in error is withdrawn with a
 * reason and stays listed. The comparison prints from the report library, and the Unit Manager keeps the Unit
 * Instance's kinds of report in the console. A Marine without the unit's shared records is told why there is nothing.
 * Every page reads cleanly to assistive technology and fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A day as the page writes it: 05 Oct 2026. */
const shown = (iso: string) => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

const HEAD = 'Document,Line,Description,Error,Amount,Owner,Status,Opened,Office';
const LAST_WEEK = [HEAD,
  `B-101,1,Obligation not liquidated,Unmatched,"1,000.00",John Boletz,Open,${day(60)},G8`,
  'B-102,1,Duplicate invoice,Duplicate,250.50,,In research,,G8',
  'B-103,1,Overage,Overage,10.00,,Closed,,G8',
].join('\n');
/** B-101 is still open, for less; B-102 is resolved; B-103 is open again; B-104 is new. */
const THIS_WEEK = [HEAD,
  `B-101,1,Obligation not liquidated,Unmatched,900.00,John Boletz,Open,${day(60)},G8`,
  'B-103,1,Overage,Overage,10.00,,Open,,G8',
  'B-104,1,New sync error,Sync,40.00,,Open,,G8',
].join('\n');

async function fileReport(page: Page, name: string, csv: string, asOf: string, opener: string | RegExp) {
  await page.getByRole('button', { name: opener }).first().click();
  const dialog = page.getByRole('dialog', { name: 'File an error report' });
  await expect(dialog).toBeVisible();
  const report = dialog.getByRole('combobox', { name: 'Report' });
  if (!/^ULO/.test((await report.textContent()) || '')) {
    await report.click();
    await page.getByRole('option', { name: /^ULO/ }).click();
  }
  await dialog.getByLabel('Stands on').fill(asOf);
  await dialog.getByLabel('Error report to file').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  const sheet = page.getByRole('dialog', { name: 'Which sheet, and where do the headings sit?' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Next' }).click();
  const columns = page.getByRole('dialog', { name: 'What does each column hold?' });
  await expect(columns.getByRole('combobox', { name: 'Which column identifies each error' })).toHaveText('Document');
  await expect(columns.getByRole('combobox', { name: 'What Amount holds' })).toHaveText(/Amount/);
  await expect(columns.getByRole('combobox', { name: 'What Status holds' })).toHaveText(/Status/);
  return columns;
}

test('a leader files two weeks of a ULO report, reads what changed, and opens the rows behind every figure', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, OPERATOR.username);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));

  await page.goto('/work/queue');
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Error reports' }).click();
  await expect(page).toHaveURL(/\/work\/error-reports$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Error reports' })).toBeVisible();
  await expect(page.getByText(`No error report is filed for ${OPERATOR.unit_name} yet`)).toBeVisible();
  expect(await axe(page), 'the page before anything is filed').toEqual([]);

  // Last week's: the statuses that usually mean closed are ticked, and the preview says what will be filed.
  let columns = await fileReport(page, 'ULO last week.csv', LAST_WEEK, day(7), 'File the first report');
  expect(await axe(page), 'what each column holds').toEqual([]);
  await columns.getByRole('button', { name: 'Preview' }).click();
  let preview = page.getByRole('dialog', { name: 'Here is what will be filed' });
  await expect(preview.getByRole('checkbox', { name: /^Closed/ })).toBeChecked();
  await expect(preview.getByRole('checkbox', { name: /^In research/ })).not.toBeChecked();
  await expect(preview).toContainText('No report of this series stands on an earlier day');
  await expect(preview).toContainText('$1,250.50');
  expect(await axe(page), 'the preview').toEqual([]);
  await preview.getByRole('button', { name: 'File 3 rows' }).click();
  let done = page.getByRole('dialog', { name: 'Filed' });
  await expect(done).toContainText(`Filed the ULO report of ${shown(day(7))}: 3 rows, 2 open ($1,250.50).`);
  await done.getByRole('button', { name: 'Open the comparison' }).click();
  await expect(page.getByRole('heading', { level: 2, name: `The report of ${shown(day(7))}` })).toBeVisible();

  // This week's: set up as last week's was, and compared with it before it is filed.
  columns = await fileReport(page, 'ULO this week.csv', THIS_WEEK, day(0), 'File the next report');
  await columns.getByRole('button', { name: 'Preview' }).click();
  preview = page.getByRole('dialog', { name: 'Here is what will be filed' });
  await expect(preview).toContainText(`Against the report of ${shown(day(7))} (2 open errors)`);
  for (const chip of ['New · 1', 'Still open · 1', 'Reopened · 1', 'Resolved · 1', 'Amount changed · 1', 'Status changed · 1']) await expect(preview.getByText(chip, { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: 'File 3 rows' }).click();
  done = page.getByRole('dialog', { name: 'Filed' });
  await done.getByRole('button', { name: 'Open the comparison' }).click();

  await expect(page.getByRole('heading', { level: 2, name: `${shown(day(0))} against ${shown(day(7))}` })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Open: 3, \$950\.00\. Show the rows$/})).toBeVisible();
  await expect(page.getByRole('button', { name: /^Resolution rate: 50%/ })).toBeVisible();
  await expect(page.getByText('The oldest is 60 days old')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Open errors on each ULO report' })).toBeVisible();
  expect(await axe(page), 'a comparison').toEqual([]);

  // A figure opens its rows: the resolved error as last week's file had it, with every column it carried.
  await page.getByRole('button', { name: /^Resolved: 1, \$250\.50\. Show the rows$/ }).click();
  const rows = page.getByRole('dialog', { name: 'Resolved' });
  await expect(rows).toContainText(`1 row · $250.50 · from ULO last week.csv, the report of ${shown(day(7))}`);
  const table = rows.getByRole('table');
  await expect(table).toContainText('B-102');
  await expect(table).toContainText('Duplicate invoice');
  await rows.getByText('Every column').click();
  await expect(rows.getByText('In research').first()).toBeVisible();
  expect(await axe(page), 'the rows behind a figure').toEqual([]);
  await page.keyboard.press('Escape');

  // So does a line of a group.
  const groupBy = page.getByRole('tablist', { name: 'Group by' });
  await expect(groupBy.getByRole('tab', { name: 'Error type' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Reopened for Overage: 1. Show the rows' }).click();
  const reopened = page.getByRole('dialog', { name: 'Reopened: Overage' });
  await expect(reopened.getByRole('table')).toContainText('B-103');
  await expect(reopened.getByRole('table')).toContainText('Status changed');
  await page.keyboard.press('Escape');
  await groupBy.getByRole('tab', { name: 'Marine' }).click();
  await expect(page.getByRole('button', { name: /^Still open for .*Boletz.*: 1\. Show the rows$/ })).toBeVisible();
  await groupBy.getByRole('tab', { name: 'Unit or office' }).click();
  await expect(page.getByRole('button', { name: 'Open on this report for G8: 3. Show the rows'})).toBeVisible();

  // The comparison prints, from the report library, with the same figures.
  await page.getByRole('link', { name: 'Print or take a file' }).click();
  const doc = page.locator('article.report-doc');
  await expect(doc.getByRole('heading', { level: 2, name: 'Error report comparison' })).toBeVisible();
  await expect(doc.getByRole('heading', { level: 3, name: `What changed since ${day(7)}` })).toBeVisible();
  await expect(doc.getByRole('table', { name: 'Changes' })).toContainText('B-104');
  await expect(doc.getByRole('table', { name: 'By Marine' })).toBeVisible();
  await expect(doc.locator('.report-filters')).toContainText('Compared with');
  expect(await axe(page), 'the comparison in the report library').toEqual([]);
  await page.goBack();

  // A report filed in error is withdrawn with a reason: kept, listed, and in no comparison.
  await expect(page.getByRole('heading', { level: 2, name: `${shown(day(0))} against ${shown(day(7))}` })).toBeVisible();
  await page.getByRole('button', { name: `Withdraw the report of ${shown(day(0))}` }).click();
  const withdraw = page.getByRole('dialog', { name: `Withdraw the report of ${shown(day(0))}?` });
  await expect(withdraw.getByRole('button', { name: 'Withdraw it' })).toBeDisabled();
  await withdraw.getByRole('textbox', { name: 'Why' }).fill('Filed against the wrong office');
  await withdraw.getByRole('button', { name: 'Withdraw it' }).click();
  await toast(page, `Withdrew the ULO report of ${shown(day(0))}.`);
  await expect(page.getByRole('heading', { level: 2, name: `The report of ${shown(day(7))}` })).toBeVisible();
  await expect(page.getByText('Filed against the wrong office')).toBeVisible();
  await expect(page.getByText('Withdrawn', { exact: true })).toBeVisible();

  // The list of every series, and the page on a phone.
  await page.getByRole('button', { name: 'All error reports' }).click();
  await expect(page.getByRole('button', { name: `Open the ULO reports of ${OPERATOR.unit_name}` })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'the error reports at 390px');
  await page.getByRole('button', { name: `Open the ULO reports of ${OPERATOR.unit_name}` }).click();
  await expect(page.getByRole('heading', { level: 2, name: `The report of ${shown(day(7))}` })).toBeVisible();
  await noSidewaysScroll(page, 'a comparison at 390px');
  expect(errors).toEqual([]);
});

test('a Unit Manager keeps the Unit Instance’s kinds of error report in the console', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.goto('/console/G8/error-reports');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Error reports' })).toBeVisible();
  for (const code of ['ULO', 'OCMT', 'UMT', 'IOH']) await expect(page.getByRole('cell', { name: code, exact: true })).toBeVisible();
  const name = `Travel card delinquencies ${unique('')}`;
  await page.getByRole('button', { name: 'New error report type' }).click();
  const dialog = page.getByRole('dialog', { name: 'New error report type' });
  await dialog.getByRole('textbox', { name: 'Name' }).fill(name);
  await dialog.getByRole('textbox', { name: 'Code' }).fill(unique('GT').slice(0, 8));
  expect(await axe(page), 'the new type dialog').toEqual([]);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await toast(page, 'Error report type added.');
  await page.getByRole('button', { name: `Retire ${name}` }).click();
  await toast(page, 'Error report type retired.');
  await expect(page.getByRole('button', { name: `Restore ${name}` })).toBeVisible();
  expect(await axe(page), 'the error report types').toEqual([]);
});

test('a Marine without the unit’s shared records has no error reports, and is told why', async ({ page }) => {
  await registerAs(page, unique('errs'));
  await page.goto('/work/queue');
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Error reports' })).toHaveCount(0);
  await page.goto('/work/error-reports');
  await expect(page.getByRole('heading', { level: 1, name: 'Error reports' })).toBeVisible();
  await expect(page.getByText(/No unit to show|not available for this unit/)).toBeVisible();
});
