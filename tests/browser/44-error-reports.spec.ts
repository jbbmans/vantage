import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, instanceDay, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * Financial error reports (ADR-0021). A leader files a ULO report from a CSV, says which column identifies an
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
/** A day as the server reckons it (its timezone's calendar): a report may not stand on a day that has not come there. */
const day = instanceDay;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A day as the page writes it: 05 Oct 2026. */
const shown = (iso: string) => `${iso.slice(8, 10)} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

const HEAD = 'Document,Line,Description,Error,Amount,Owner,Status,Opened,Office';
/** What each column of HEAD holds, for a report filed through the API. */
const COLUMNS = { Document: 'reference', Line: 'keep', Description: 'description', Error: 'category', Amount: 'amount', Owner: 'owner', Status: 'status', Opened: 'opened', Office: 'unit' };
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

  // The file is chosen with the one control that shows. It says why it cannot be used yet, rather than only
  // greying out, and closing the dialog puts focus back on what opened it.
  const fileFirst = page.getByRole('button', { name: 'File the first report' });
  await fileFirst.click();
  let dialog = page.getByRole('dialog', { name: 'File an error report' });
  const choose = dialog.getByRole('button', { name: /^Choose the report/ });
  await choose.focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByLabel('Error report to file')).not.toBeFocused();
  await expect(choose).not.toBeFocused();
  await dialog.getByLabel('Stands on').fill('');
  await expect(choose).toBeDisabled();
  await expect(choose).toHaveAccessibleDescription('Choose the day it stands on first.');
  await expect(dialog.getByText('Choose the day it stands on first.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(fileFirst).toBeFocused();

  // Last week's: the statuses that usually mean closed are ticked, and the preview says what will be filed, in one request.
  let columns = await fileReport(page, 'ULO last week.csv', LAST_WEEK, day(7), 'File the first report');
  expect(await axe(page), 'what each column holds').toEqual([]);
  const previews: string[] = [];
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/error-reports/preview') previews.push(r.method()); });
  await columns.getByRole('button', { name: 'Preview' }).click();
  let preview = page.getByRole('dialog', { name: 'Here is what will be filed' });
  await expect(preview.getByRole('checkbox', { name: /^Closed/ })).toBeChecked();
  await expect(preview.getByRole('checkbox', { name: /^In research/ })).not.toBeChecked();
  await expect(preview).toContainText('No report of this series stands on an earlier day');
  await expect(preview).toContainText('$1,250.50');
  expect(previews, 'the first preview').toEqual(['POST']);
  expect(await axe(page), 'the preview').toEqual([]);
  // Ticking a status keeps it where it is, with focus on it, and the counts follow.
  const research = preview.getByRole('checkbox', { name: /^In research/ });
  await research.focus();
  let answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/error-reports/preview');
  await page.keyboard.press('Space');
  await answered;
  await expect(research).toBeFocused();
  await expect(research).toBeChecked();
  await expect(preview).toContainText('$1,000.00');
  answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/error-reports/preview');
  await page.keyboard.press('Space');
  await answered;
  await expect(research).toBeFocused();
  await expect(research).not.toBeChecked();
  await expect(preview).toContainText('$1,250.50');
  await preview.getByRole('button', { name: 'File 3 rows' }).click();
  let done = page.getByRole('dialog', { name: 'Filed' });
  await expect(done).toContainText(`Filed the ULO report of ${shown(day(7))}: 3 rows, 2 open ($1,250.50).`);
  await done.getByRole('button', { name: 'Open the comparison' }).click();
  await expect(page.getByRole('heading', { level: 2, name: `The report of ${shown(day(7))}` })).toBeVisible();
  // What opened the dialog is gone with the list of series, so focus goes to the series' heading.
  await expect(page.locator('#series-heading')).toBeFocused();

  // This week's: set up as last week's was, and compared with it before it is filed. A day that has not come is
  // refused at the field that holds it, on the step that asks for it, and the file read goes on from there.
  columns = await fileReport(page, 'ULO this week.csv', THIS_WEEK, day(-3), 'File the next report');
  await columns.getByRole('button', { name: 'Preview' }).click();
  dialog = page.getByRole('dialog', { name: 'File an error report' });
  const standsOn = dialog.getByLabel('Stands on');
  await expect(standsOn).toHaveAttribute('aria-invalid', 'true');
  await expect(standsOn).toHaveAccessibleDescription(/Not in the future/);
  expect(await axe(page), 'a day refused at its field').toEqual([]);
  await standsOn.fill(day(0));
  await expect(standsOn).not.toHaveAttribute('aria-invalid', 'true');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('dialog', { name: 'Which sheet, and where do the headings sit?' }).getByRole('button', { name: 'Next' }).click();
  columns = page.getByRole('dialog', { name: 'What does each column hold?' });
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
  // The series' trend, headed by its question (the analytics kit): a column for each report, with how many were open.
  const trend = page.getByRole('figure', { name: 'How many errors were open on each ULO report?' });
  await expect(trend.getByRole('img', { name: `${shown(day(7)).slice(0, 6)}: 2` })).toBeVisible();
  await expect(trend.getByRole('img', { name: `${shown(day(0)).slice(0, 6)}: 3` })).toBeVisible();
  expect(await axe(page), 'a comparison').toEqual([]);

  // A figure opens its rows: the resolved error as last week's file had it, with every column it carried.
  const resolved = page.getByRole('button', { name: /^Resolved: 1, \$250\.50\. Show the rows$/ });
  await resolved.focus();
  await page.keyboard.press('Enter');
  const rows = page.getByRole('dialog', { name: 'Resolved' });
  await expect(rows).toContainText(`1 row · $250.50 · from ULO last week.csv, the report of ${shown(day(7))}`);
  const table = rows.getByRole('table');
  await expect(table).toContainText('B-102');
  await expect(table).toContainText('Duplicate invoice');
  await rows.getByText('Every column').click();
  await expect(rows.getByText('In research').first()).toBeVisible();
  expect(await axe(page), 'the rows behind a figure').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(rows).toBeHidden();
  await expect(resolved).toBeFocused();

  // How each age was found is written beside it.
  await page.getByRole('button', { name: /^Open: 3, \$950\.00\. Show the rows$/ }).click();
  const open = page.getByRole('dialog', { name: 'Open' });
  await expect(open.getByRole('row').filter({ hasText: 'B-101' })).toContainText('From its opened date');
  await page.keyboard.press('Escape');
  await expect(open).toBeHidden();

  // So does a line of a group.
  const groupBy = page.getByRole('tablist', { name: 'Group by' });
  await expect(groupBy.getByRole('tab', { name: 'Error type' })).toHaveAttribute('aria-selected', 'true');
  const overage = page.getByRole('button', { name: 'Reopened for Overage: 1. Show the rows' });
  await overage.focus();
  await page.keyboard.press('Enter');
  const reopened = page.getByRole('dialog', { name: 'Reopened: Overage' });
  await expect(reopened.getByRole('table')).toContainText('B-103');
  await expect(reopened.getByRole('table')).toContainText('Status changed');
  await page.keyboard.press('Escape');
  await expect(reopened).toBeHidden();
  await expect(overage).toBeFocused();
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
  const withdrawThis = page.getByRole('button', { name: `Withdraw the report of ${shown(day(0))}` });
  await withdrawThis.click();
  const withdraw = page.getByRole('dialog', { name: `Withdraw the report of ${shown(day(0))}?` });
  await withdraw.getByRole('button', { name: 'Cancel' }).click();
  await expect(withdraw).toBeHidden();
  await expect(withdrawThis).toBeFocused();
  await withdrawThis.click();
  await expect(withdraw.getByRole('button', { name: 'Withdraw it' })).toBeDisabled();
  await withdraw.getByRole('textbox', { name: 'Why' }).fill('Filed against the wrong office');
  await withdraw.getByRole('button', { name: 'Withdraw it' }).click();
  await toast(page, `Withdrew the ULO report of ${shown(day(0))}.`);
  await expect(page.getByRole('heading', { level: 2, name: `The report of ${shown(day(7))}` })).toBeVisible();
  await expect(page.getByText('Filed against the wrong office')).toBeVisible();
  await expect(page.getByText('Withdrawn', { exact: true })).toBeVisible();
  // Its Withdraw button is gone with it, so focus goes to the series' heading.
  await expect(page.locator('#series-heading')).toBeFocused();

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

test('an NCO of G8 files for a team beneath it, which they do not belong to, and a series withdrawn in full still reads', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const H = { 'x-vantage-client': '1' };
  await loginAs(page, OPERATOR.username);
  const short = unique('ER').toUpperCase();
  const made = await page.request.post('/api/org/units', { headers: H, data: { name: `Error Team ${short}`, short_name: short, parent_id: 'G8' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const team = (await made.json()) as { id: string };
  // An NCO of G8: their authority there reaches the team, and they are not one of its members.
  const name = unique('ernco');
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const nco = await context.newPage();
  await registerAs(nco, name, { first_name: 'Erin', last_name: 'Noncom' });
  const ncoMe = await (await nco.request.get('/api/me')).json();
  await joinUnit(page.request, nco.request);
  const granted = await page.request.post(`/api/org/team/${ncoMe.user.id}/roles`, { headers: H, data: { role_id: 'G8:nco', unit_id: 'G8' } });
  expect(granted.ok(), await granted.text()).toBeTruthy();
  await loginAs(nco, name);
  await nco.goto(`/work/error-reports?unit=${encodeURIComponent(team.id)}`);
  await expect(nco.getByText(`No error report is filed for Error Team ${short} yet`)).toBeVisible();

  await nco.getByRole('button', { name: 'File the first report' }).click();
  const dialog = nco.getByRole('dialog', { name: 'File an error report' });
  await expect(dialog.getByRole('combobox', { name: 'Unit' })).toHaveText(new RegExp(short));
  const report = dialog.getByRole('combobox', { name: 'Report' });
  if (!/^ULO/.test((await report.textContent()) || '')) {
    await report.click();
    await nco.getByRole('option', { name: /^ULO/ }).click();
  }
  await dialog.getByLabel('Stands on').fill(day(1));
  await dialog.getByLabel('Error report to file').setInputFiles({ name: `ULO ${short}.csv`, mimeType: 'text/csv', buffer: Buffer.from(LAST_WEEK) });

  // The headings are chosen from the rows shown, so a heading row past them is not offered.
  const sheet = nco.getByRole('dialog', { name: 'Which sheet, and where do the headings sit?' });
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Heading row').fill('25');
  await expect(sheet.getByLabel('Heading row')).toHaveValue('20');
  await sheet.getByLabel('Heading row').fill('1');
  await sheet.getByRole('button', { name: 'Next' }).click();
  await nco.getByRole('dialog', { name: 'What does each column hold?' }).getByRole('button', { name: 'Preview' }).click();
  await nco.getByRole('dialog', { name: 'Here is what will be filed' }).getByRole('button', { name: 'File 3 rows' }).click();
  const done = nco.getByRole('dialog', { name: 'Filed' });
  await expect(done).toContainText(`Filed the ULO report of ${shown(day(1))}`);
  await done.getByRole('button', { name: 'Open the comparison' }).click();
  await expect(nco.getByRole('heading', { level: 2, name: `The report of ${shown(day(1))}` })).toBeVisible();

  // Its only report withdrawn, the series still lists it, with why.
  await nco.getByRole('button', { name: `Withdraw the report of ${shown(day(1))}` }).click();
  const withdraw = nco.getByRole('dialog', { name: `Withdraw the report of ${shown(day(1))}?` });
  await withdraw.getByRole('textbox', { name: 'Why' }).fill('Filed for the wrong team');
  await withdraw.getByRole('button', { name: 'Withdraw it' }).click();
  await toast(nco, `Withdrew the ULO report of ${shown(day(1))}.`);
  await expect(nco.getByText('Every ULO report filed for this unit was withdrawn, so nothing is compared. Each is kept, with why.')).toBeVisible();
  await expect(nco.getByText('Filed for the wrong team')).toBeVisible();
  await expect(nco.getByRole('button', { name: 'File a report' })).toBeVisible();
  expect(await axe(nco), 'a series withdrawn in full').toEqual([]);
  // On a phone its table scrolls in a region that is named and reached by keyboard.
  await nco.setViewportSize({ width: 390, height: 844 });
  const region = nco.getByRole('region', { name: 'Every report filed' });
  await expect(region).toBeVisible();
  await expect(nco.getByRole('table', { name: 'Every report filed' })).toBeVisible();
  expect(await axe(nco), 'a series withdrawn in full at 390px').toEqual([]);
  await region.focus();
  await nco.keyboard.press('ArrowRight');
  await expect.poll(() => region.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  await noSidewaysScroll(nco, 'a series withdrawn in full at 390px');
  await context.close();
});

test('a long series lists its latest reports, and the rows behind a figure come a page at a time', async ({ page }) => {
  test.setTimeout(180_000);
  const H = { 'x-vantage-client': '1' };
  await loginAs(page, OPERATOR.username);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  const short = unique('EL').toUpperCase();
  const made = await page.request.post('/api/org/units', { headers: H, data: { name: `Ledger Team ${short}`, short_name: short, parent_id: 'G8' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const team = (await made.json()) as { id: string };
  const overview = await page.request.get(`/api/error-reports?unit_id=${encodeURIComponent(team.id)}`);
  expect(overview.ok(), await overview.text()).toBeTruthy();
  const ulo = ((await overview.json()) as { types: Array<{ id: string; code: string }> }).types.find((t) => t.code === 'ULO')!.id;

  // 27 weekly reports, filed as the page files them. The one before the latest holds 190 errors of $12,345.67 each, and
  // the latest 230: 100 still open, 130 new and 90 resolved, so its figures run to millions of dollars.
  const row = (doc: string) => `${doc},1,Obligation not liquidated,Unmatched,12345.67,,Open,,G8`;
  const keys = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i + 1).padStart(4, '0')}`);
  const fileThrough = async (n: number, docs: string[]) => {
    const name = `ULO ${short} ${n}.csv`;
    const source = await page.request.post('/api/work/sources', {
      headers: { ...H, 'content-type': 'text/csv', 'x-filename': name, 'x-unit-id': '', 'x-visibility': 'private' },
      data: Buffer.from([HEAD, ...docs.map(row)].join('\n')),
    });
    expect(source.ok(), await source.text()).toBeTruthy();
    const filed = await page.request.post('/api/error-reports/snapshots', { headers: H, data: {
      unit_id: team.id, type_id: ulo, as_of: day(7 * (27 - n)), source_file_id: ((await source.json()) as { id: string }).id, sheet_name: name,
      header_row: 1, key_columns: ['Document'], columns: COLUMNS, closed_statuses: ['closed'], note: null,
    } });
    expect(filed.ok(), await filed.text()).toBeTruthy();
  };
  for (let n = 1; n <= 25; n += 1) await fileThrough(n, [`OLD-${n}`]);
  await fileThrough(26, [...keys('K', 100), ...keys('R', 90)]);
  await fileThrough(27, keys('K', 230));

  await page.goto(`/work/error-reports?unit=${encodeURIComponent(team.id)}&type=${encodeURIComponent(ulo)}`);
  await expect(page.getByRole('heading', { level: 2, name: `${shown(day(0))} against ${shown(day(7))}` })).toBeVisible();

  // The reports filed: the latest 26, as many as the trend shows, saying so, until every one is asked for.
  const filed = page.getByRole('table', { name: 'Every report filed' });
  await expect(filed.locator('tbody > tr')).toHaveCount(26);
  await expect(page.getByText('The latest 26 of 27 reports.')).toBeVisible();
  await page.getByRole('button', { name: 'Show every report (27)' }).click();
  await expect(filed.locator('tbody > tr')).toHaveCount(27);
  await expect(page.getByRole('button', { name: 'Show the latest 26' })).toBeFocused();
  await expect(page.getByText('The latest 26 of 27 reports.')).toHaveCount(0);

  // The rows behind a figure come a hundred at a time, and every column of a row is drawn once it is opened.
  const openFigure = page.getByRole('button', { name: /^Open: 230, \$2,839,504\.10\. Show the rows$/ });
  await openFigure.click();
  const rows = page.getByRole('dialog', { name: 'Open' });
  await expect(rows).toContainText(`230 rows · $2,839,504.10 · from ULO ${short} 27.csv`);
  const lines = rows.getByRole('table').locator('tbody > tr');
  await expect(lines).toHaveCount(100);
  await expect(rows.getByRole('status')).toHaveText('Showing 100 of 230 rows.');
  await expect(rows.locator('dt')).toHaveCount(0);
  await rows.getByRole('button', { name: 'Show more' }).click();
  await expect(lines).toHaveCount(200);
  await expect(rows.getByRole('status')).toHaveText('Showing 200 of 230 rows.');
  await expect(lines.nth(100).locator('summary')).toBeFocused();
  await rows.getByRole('button', { name: 'Show more' }).click();
  await expect(lines).toHaveCount(230);
  await expect(rows.getByRole('status')).toHaveText('Showing all 230 rows.');
  await expect(rows.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  await expect(lines.nth(200).locator('summary')).toBeFocused();
  await lines.first().locator('summary').click();
  await expect(lines.first().locator('dt').first()).toBeVisible();
  await expect(rows.locator('dt')).toHaveCount(await lines.first().locator('dt').count());
  expect(await axe(page), 'a page of the rows behind a figure').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(rows).toBeHidden();
  await expect(openFigure).toBeFocused();

  // On a phone a figure of millions keeps inside its card, and the page does not scroll sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: /^Value resolved: \$1,111,110\.30/ })).toBeVisible();
  const figures = page.locator('section[aria-labelledby="figures-heading"] button');
  expect(await figures.count()).toBeGreaterThan(4);
  for (const figure of await figures.all()) {
    const value = await figure.locator('.stat-value').boundingBox();
    const card = await figure.boundingBox();
    expect(value!.x + value!.width, `${await figure.getAttribute('aria-label')} keeps inside its card`).toBeLessThanOrEqual(card!.x + card!.width - 16 + 0.5);
  }
  await noSidewaysScroll(page, 'a long series at 390px');
  expect(await axe(page), 'a long series at 390px').toEqual([]);
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
