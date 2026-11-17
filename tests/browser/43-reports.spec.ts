import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, joinUnit, loginAs, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

/**
 * Reports and printable output (Task 14, ADR-0020). A leader chooses a report, whom it is about and its filters, sees
 * it, saves the choices, takes it as a file and prints it on a page laid out for paper: the app's frame is gone, each
 * table's header repeats on every printed page, a row never splits between pages, and the buttons above the report
 * never print. A Marine reports on themselves and is told why a unit's report is not theirs. Every page reads cleanly
 * to assistive technology and fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

test('a leader runs a unit report, saves it, takes it as a file, and prints it without the app around it', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, OPERATOR.username);
  const tag = unique('RPT');
  // Enough shared entries for the printed table to run over several pages.
  for (let i = 0; i < 90; i++) {
    const res = await page.request.post('/api/records/activities', { headers: H, data: { title: `${tag} reconciled ULO batch ${i + 1}`, date: day(i % 40), category: 'Fiscal & Financial', quantity: i + 1, unit_label: 'ULOs', dollar_amount: 100 + i, visibility: 'unit', unit_id: 'G8' } });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  await page.goto('/reports/library');
  await expect(page.getByRole('heading', { level: 1, name: 'Report library' })).toBeVisible();
  const reports = page.getByRole('navigation', { name: 'Reports' });
  for (const group of ['Your record', 'Your unit', 'Financial work', 'Build your own']) await expect(reports.getByRole('heading', { name: group })).toBeVisible();
  expect(await axe(page), 'the library').toEqual([]);

  await reports.getByRole('button', { name: /^Activity/ }).click();
  await page.getByRole('tablist', { name: 'Whom the report is about' }).getByRole('tab', { name: 'A unit' }).click();
  await page.getByRole('button', { name: 'Run report' }).click();
  const doc = page.locator('article.report-doc');
  await expect(doc.getByRole('heading', { level: 2, name: 'Activity' })).toBeVisible();
  await expect(doc.getByText('G-8 Comptroller', { exact: false }).first()).toBeVisible();
  await expect(doc.locator('.report-filters')).toContainText('Period');
  await expect(doc.getByRole('table', { name: 'Activities' })).toContainText(`${tag} reconciled ULO batch 1`);
  await expect(doc.locator('.report-marking').first()).toHaveText('Working paper');
  expect(await axe(page), 'a report on screen').toEqual([]);

  // Saved: the choices, under a name, listed to run again.
  await page.getByRole('button', { name: 'Save these choices' }).click();
  const save = page.getByRole('dialog', { name: 'Save these choices' });
  await save.getByRole('textbox', { name: 'Name' }).fill(`${tag} unit activity`);
  await save.getByRole('button', { name: 'Save' }).click();
  await toast(page, `Saved ${tag} unit activity.`);
  await expect(reports.getByRole('button', { name: new RegExp(`^${tag} unit activity Activity`) })).toBeVisible();
  await expect(reports.getByRole('button', { name: `Delete ${tag} unit activity` })).toBeVisible();

  // A file, named for what it is, whom it is about and the day.
  await page.getByRole('button', { name: 'Download' }).click();
  const downloading = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Spreadsheet \(CSV\)/ }).click();
  await confirmSudoIfAsked(page);
  const file = await downloading;
  expect(file.suggestedFilename()).toMatch(/^vantage-activity-g-8-comptroller.*\.csv$/);

  // Print opens the page laid out for paper, in its own tab.
  const opened = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Print' }).click();
  const sheet = await opened;
  await sheet.waitForLoadState();
  expect(new URL(sheet.url()).pathname).toBe('/reports/print');
  await expect(sheet.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
  await sheet.close();

  await page.goto(`/reports/print?${new URLSearchParams({ type: 'activity', subject: 'unit', unit_id: 'G8', period: 'all' })}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Activity' })).toBeVisible();
  // None of the app's frame: no menu, header, footer or tab bar.
  await expect(page.locator('aside, header.sticky, footer, nav.tabbar')).toHaveCount(0);
  await expect(page.getByRole('toolbar', { name: 'Print' })).toBeVisible();
  expect(await axe(page), 'the print page').toEqual([]);

  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('toolbar', { name: 'Print' })).toBeHidden();
  const layout = await page.evaluate(() => {
    const table = document.querySelector('.report-table table')!;
    const style = (el: Element | null) => (el ? getComputedStyle(el) : null);
    return {
      header: style(table.querySelector('thead'))!.display,
      row: style(table.querySelector('tbody tr'))!.breakInside,
      frame: style(document.querySelector('.report-frame > thead'))!.display,
      running: document.querySelector('.report-frame > thead')!.textContent,
      clipped: [...document.querySelectorAll('.report-table td')].some((td) => td.scrollWidth > td.clientWidth + 1),
      overflow: [...document.querySelectorAll('.report-table table')].some((t) => t.getBoundingClientRect().right > document.querySelector('.report-frame')!.getBoundingClientRect().right + 1),
      page: style(document.querySelector('article.report-doc'))!.getPropertyValue('page'),
    };
  });
  expect(layout.header, 'each table’s header repeats on every printed page').toBe('table-header-group');
  expect(layout.row, 'a row never splits between pages').toBe('avoid');
  expect(layout.frame, 'the handling line heads every page').toBe('table-header-group');
  expect(layout.running).toContain('Working paper');
  expect(layout.clipped, 'no cell is cut off').toBe(false);
  expect(layout.overflow, 'no table runs off the page').toBe(false);
  expect(layout.page, 'a table wider than eight columns prints landscape, as the PDF does').toBe('wide');
  // Printed for real, as Chromium prints it, on the paper the page asks for: a document of its own pages, not a picture.
  const pdf = (await page.pdf({ preferCSSPageSize: true, printBackground: true })).toString('latin1');
  expect((pdf.match(/\/Type\s*\/Page[^s]/g) || []).length, 'a long table runs over pages').toBeGreaterThanOrEqual(2);
  expect(pdf, 'Letter, landscape').toMatch(/\/MediaBox\s*\[\s*0 0 792 612\s*\]/);
  await page.emulateMedia({ media: 'screen' });

  // On a phone, the library and the print page fit the width; a wide table scrolls inside itself.
  await page.setViewportSize({ width: 390, height: 844 });
  await noSidewaysScroll(page, 'the print page at 390px');
  await page.goto(`/reports/library?${new URLSearchParams({ type: 'errors', subject: 'unit', unit_id: 'G8' })}`);
  await expect(page.locator('article.report-doc').getByRole('heading', { level: 2, name: 'Error report' })).toBeVisible();
  await noSidewaysScroll(page, 'the library at 390px');
});

test('a Marine reports on themselves, and is told why a unit’s report is not theirs', async ({ page }) => {
  await registerAs(page, unique('reporter'));
  const res = await page.request.post('/api/records/activities', { headers: H, data: { title: 'Briefed the GTCC program', date: day(3), category: 'Leadership', visibility: 'private' } });
  expect(res.ok(), await res.text()).toBeTruthy();

  await page.goto('/reports/library?type=activity');
  const doc = page.locator('article.report-doc');
  await expect(doc.getByRole('table', { name: 'Activities' })).toContainText('Briefed the GTCC program');
  await page.getByRole('button', { name: 'Download' }).click();
  for (const format of ['PDF', 'Spreadsheet (CSV)', 'Excel workbook', 'Vantage file (JSON)']) await expect(page.getByRole('menuitem').filter({ hasText: format })).toBeVisible();
  await page.keyboard.press('Escape');

  // Run again after another report, it reads the record afresh: what was added since is in it.
  const reports = page.getByRole('navigation', { name: 'Reports' });
  await reports.getByRole('button', { name: /^Training/ }).click();
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(doc.getByRole('heading', { level: 2, name: 'Training' })).toBeVisible();
  const added = await page.request.post('/api/records/activities', { headers: H, data: { title: 'Balanced the travel ledger', date: day(1), category: 'Fiscal & Financial', visibility: 'private' } });
  expect(added.ok(), await added.text()).toBeTruthy();
  await reports.getByRole('button', { name: /^Activity/ }).click();
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(doc.getByRole('table', { name: 'Activities' })).toContainText('Balanced the travel ledger');

  await reports.getByRole('button', { name: /^Unit performance/ }).click();
  await expect(page.getByRole('note')).toContainText('you have none whose shared records you may view');
  await expect(page.getByRole('button', { name: 'Run report' })).toBeDisabled();

  // Asked for directly, the server refuses, and the print page says so.
  await page.goto(`/reports/print?${new URLSearchParams({ type: 'unit', unit_id: 'G8' })}`);
  await expect(page.getByText('Could not prepare the report')).toBeVisible();
});

/** A Marine registered on their own, who joined G8 with a join code from the leader signed in on `page`. */
async function enrolledMarine(page: Page, browser: Browser) {
  const username = unique('rpt');
  const other = await browser.newContext();
  const res = await other.request.post('/api/auth/register', { headers: H, data: { username, password: PASSWORD, first_name: 'Sam', last_name: `Reyes${unique('')}`, rank_id: 'LCpl' } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const me = await (await other.request.get('/api/me')).json();
  await joinUnit(page.request, other.request);
  await other.close();
  return me.user.id as string;
}

test('a Marine’s report from their analysis keeps the unit it was opened for', async ({ page, browser }) => {
  await loginAs(page, OPERATOR.username);
  const id = await enrolledMarine(page, browser);
  await page.goto(`/reports/analysis?${new URLSearchParams({ user: id, unit: 'G8' })}`);
  const running = page.waitForRequest((r) => r.url().includes('/api/report-center/run'));
  await page.getByRole('link', { name: 'Print or file' }).click();
  const asked = new URL((await running).url()).searchParams;
  expect(Object.fromEntries(['type', 'subject', 'user_id', 'unit_id'].map((k) => [k, asked.get(k)]))).toEqual({ type: 'individual', subject: 'member', user_id: id, unit_id: 'G8' });
  await expect(page.locator('article.report-doc').getByRole('heading', { level: 2, name: 'Individual performance' })).toBeVisible();
});

/** Activities for the signed-in Marine, posted a few at a time. */
async function entries(page: Page, n: number, data: (i: number) => Record<string, unknown>) {
  for (let start = 0; start < n; start += 25) {
    await Promise.all(Array.from({ length: Math.min(25, n - start) }, async (_, k) => {
      const res = await page.request.post('/api/records/activities', { headers: H, data: { visibility: 'private', ...data(start + k) } });
      expect(res.ok(), await res.text()).toBeTruthy();
    }));
  }
}

test('RPT-5, RPT-13: a long table shows 200 rows at a time on screen and every row in print, and scrolls only when it must', async ({ page }) => {
  test.setTimeout(180_000);
  await registerAs(page, unique('longrpt'));
  const tag = unique('LONG');
  await entries(page, 300, (i) => ({ title: `${tag} entry ${i + 1}`, date: day(i % 60), category: 'Fiscal & Financial', quantity: i + 1, unit_label: 'ULOs', result: 'Closed out the obligation' }));

  await page.goto('/reports/library?type=activity');
  const doc = page.locator('article.report-doc');
  const table = doc.getByRole('table', { name: 'Activities' });
  await expect(table.locator('tbody tr')).toHaveCount(200);
  await expect(doc.getByRole('status').filter({ hasText: 'Showing 200 of 300 rows.' })).toBeVisible();
  const more = doc.getByRole('button', { name: 'Show 100 more of 100' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(table.locator('tbody tr')).toHaveCount(300);
  await expect(more).toHaveCount(0);
  // The button is gone, so the keyboard is left on the count, which says every row is shown.
  await expect(doc.getByRole('status').filter({ hasText: 'Showing all 300 rows.' })).toBeFocused();
  expect(await axe(page), 'a long report on screen').toEqual([]);

  // A table's scroller is a stop for the keyboard, and a named region, exactly while the table is wider than it.
  const stops = () => doc.locator('.report-table-scroll').evaluateAll((els) => els.map((el) => ({
    overflows: el.scrollWidth > el.clientWidth + 1,
    stop: el.getAttribute('tabindex') === '0' && el.getAttribute('role') === 'region' && Boolean(el.getAttribute('aria-label')),
  })));
  for (const s of await stops()) expect(s.stop, 'a stop only when it scrolls').toBe(s.overflows);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () => (await stops()).some((s) => s.overflows && s.stop), { message: 'a wide table scrolls inside itself on a phone' }).toBe(true);
  for (const s of await stops()) expect(s.stop, 'a stop only when it scrolls, at 390px').toBe(s.overflows);
  await noSidewaysScroll(page, 'a long report at 390px');
  expect(await axe(page), 'a long report at 390px').toEqual([]);
  await page.setViewportSize({ width: 1280, height: 900 });

  // On paper every row prints.
  await page.goto('/reports/print?type=activity');
  await expect(page.getByRole('table', { name: 'Activities' }).locator('tbody tr')).toHaveCount(300);
  await expect(page.getByRole('button', { name: /^Show \d+ more/ })).toHaveCount(0);
});

test('RPT-12: a report the server refuses says which choice, on that choice; a unit’s records reset when the report is about you', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.goto(`/reports/library?${new URLSearchParams({ type: 'custom', subject: 'self', dataset: 'work' })}`);
  await expect(page.getByRole('alert').filter({ hasText: 'Financial cases belong to a unit' })).toBeVisible();
  const records = page.getByRole('combobox', { name: 'Records' });
  await expect(records).toHaveAttribute('aria-invalid', 'true');
  await expect(records).toHaveAccessibleDescription(/For a unit\./);
  expect(await axe(page), 'a refused report').toEqual([]);

  const about = page.getByRole('tablist', { name: 'Whom the report is about' });
  await about.getByRole('tab', { name: 'A unit' }).click();
  await records.click();
  await page.getByRole('option', { name: 'Financial cases' }).click();
  await about.getByRole('tab', { name: 'You' }).click();
  await expect(records).toHaveText(/Activities/);
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.locator('article.report-doc').getByRole('heading', { level: 2, name: 'Custom' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Financial cases belong to a unit' })).toHaveCount(0);
  await expect(records).not.toHaveAttribute('aria-invalid', 'true');
});

test('RPT-9, RPT-11: the record report is not read again on focus, and each bullet’s copy button shows when focused', async ({ page }) => {
  await registerAs(page, unique('bullets'));
  await entries(page, 3, (i) => ({ title: `Reconciled ${10 + i} aged obligations`, date: day(i + 2), category: 'Fiscal & Financial', quantity: 10 + i, unit_label: 'obligations', result: `Closed out ${10 + i} obligations before fiscal year end` }));
  await page.clock.install();
  await page.goto('/reports/analysis');
  await page.getByRole('tablist', { name: 'View' }).getByRole('tab', { name: 'Bullets' }).click();
  const copyAll = page.getByRole('button', { name: 'Copy all' });
  await expect(copyAll).toBeVisible();

  // A minute and more later the tab comes back into view: the report, audited when it is someone else's, is not read again.
  let asked = 0;
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/reports') asked += 1; });
  await page.clock.fastForward(61_000);
  await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(500);
  expect(asked, 'no read on focus').toBe(0);

  await copyAll.focus();
  await page.keyboard.press('Tab');
  const first = page.getByRole('button', { name: /^Copy bullet 1 of / });
  await expect(first).toBeFocused();
  await expect.poll(() => first.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  expect(await axe(page), 'the bullet package').toEqual([]);

  // On a phone there is no hover, so each copy button shows as it is, and is big enough to tap.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.mouse.move(0, 0);
  const second = page.getByRole('button', { name: /^Copy bullet 2 of / });
  await expect.poll(() => second.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
  const box = (await second.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  await noSidewaysScroll(page, 'the bullet package at 390px');
});
