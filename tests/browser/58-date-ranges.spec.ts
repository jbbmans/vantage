import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

/**
 * Custom dates on every Period choice (ADR-0038): Records, Analysis, the Report library, Duty and Today's outcomes each
 * offer "Custom dates", keep the range in the address across a reload, send it with every request and file, refuse a
 * range that ends before it starts with the same words the server uses, and work by keyboard alone. The pages that
 * choose a window of days (the Unit dashboard, Workload, Your record), the Timeline and Report Studio offer them too
 * (ADR-0039), and keep the windows and links they always had.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });

const FROM = '2026-01-05';
const TO = '2026-02-20';
const IN_URL = new RegExp(`period=custom&from=${FROM}&to=${TO}`);
const asks = (path: string) => (url: string) => url.includes(path) && url.includes(`from=${FROM}`) && url.includes(`to=${TO}`);

test.beforeEach(async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
});

/** Choose Custom dates on a Period select (or a window's, by its name) and set both days. */
async function chooseCustom(page: Page, scope: Page | Locator = page, name = 'Period') {
  await scope.getByRole('combobox', { name }).click();
  await page.getByRole('option', { name: 'Custom dates' }).click();
  await scope.getByLabel('From', { exact: true }).fill(FROM);
  await scope.getByLabel('To', { exact: true }).fill(TO);
}

async function keptAfterReload(page: Page, scope: (p: Page) => Page | Locator = (p) => p, name = 'Period') {
  await page.reload();
  await expect(scope(page).getByRole('combobox', { name })).toContainText('Custom dates');
  await expect(scope(page).getByLabel('From', { exact: true })).toHaveValue(FROM);
  await expect(scope(page).getByLabel('To', { exact: true })).toHaveValue(TO);
}

test('Records keeps custom dates in its address, and its CSV carries them', async ({ page }) => {
  await page.goto('/record/activities?period=all');
  await chooseCustom(page);
  await expect(page).toHaveURL(IN_URL);
  await keptAfterReload(page);
  const csv = page.waitForRequest((r) => asks('/api/reports/csv')(r.url()));
  await page.getByRole('button', { name: 'Export activities' }).click();
  await csv;

  // A range that ends before it starts is said at the field once it is left; the page keeps the last good range.
  await page.getByLabel('To', { exact: true }).fill('2026-01-01');
  await page.getByLabel('To', { exact: true }).blur();
  await expect(page.getByRole('alert').filter({ hasText: 'On or after the first day.' })).toBeVisible();
  await expect(page.getByLabel('To', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page).toHaveURL(IN_URL);

  // A preset clears the days from the address.
  await page.getByRole('combobox', { name: 'Period' }).click();
  await page.getByRole('option', { name: 'All time' }).click();
  await expect(page).not.toHaveURL(/from=|to=/);
  await expect(page.getByLabel('From', { exact: true })).toHaveCount(0);
});

test('a link whose dates are no range is shown on the period it falls back to, and says so', async ({ page }) => {
  await page.goto('/record/activities?from=2026-03-10&to=2026-03-01');
  await expect(page.getByText('The dates in the link were not used. The range ends before it starts.')).toBeVisible();
  const period = page.getByRole('combobox', { name: 'Period' });
  await expect(period).not.toContainText('Custom dates');
  const described = await period.getAttribute('aria-describedby');
  expect(described).toBeTruthy();
  await expect(page.locator(`[id="${described!.split(' ').at(-1)}"]`)).toContainText('The dates in the link were not used.');

  // Duty folds its filters away for a short list, but shows them to say why the link's days were not used.
  await page.goto('/record/duty?from=2026-03-10&to=2026-03-01');
  await expect(page.getByRole('group', { name: 'Narrow the list' }).getByText('The dates in the link were not used. The range ends before it starts.')).toBeVisible();
});

test('Analysis asks for custom dates and carries them to its files and to Print or file', async ({ page }) => {
  await page.goto('/reports/analysis?period=all');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  // The view is a saved choice that earlier specs change, so the test starts from a known one.
  await page.getByRole('tab', { name: 'Narrative' }).click();
  const report = page.waitForRequest((r) => asks('/api/reports?')(r.url()));
  const metrics = page.waitForRequest((r) => asks('/api/metrics?')(r.url()));
  await chooseCustom(page);
  await Promise.all([report, metrics]);
  await expect(page).toHaveURL(IN_URL);
  await keptAfterReload(page);
  await expect(page.getByText('What the work produced').first()).toContainText('05 JAN 26 to 20 FEB 26');

  const pdf = page.waitForRequest((r) => asks('/api/reports/analysis.pdf')(r.url()));
  await page.getByRole('button', { name: 'Export analysis PDF' }).click();
  await pdf;
  const csv = page.waitForRequest((r) => asks('/api/reports/csv')(r.url()));
  await page.getByRole('button', { name: 'Export activities' }).click();
  await csv;
  await expect(page.getByRole('link', { name: 'Print or file' })).toHaveAttribute('href', IN_URL);

  // Period over period reads the same days.
  const delta = page.waitForRequest((r) => asks('/api/reports/delta')(r.url()));
  await page.getByRole('tab', { name: 'Period over period' }).click();
  await delta;
});

test('the Report library runs, prints and saves custom dates, and will not run a backwards range', async ({ page }) => {
  await page.goto('/reports/library?type=individual');
  await chooseCustom(page);
  const run = page.waitForRequest((r) => asks('/api/report-center/run')(r.url()) && r.url().includes('period=custom'));
  await page.getByRole('button', { name: 'Run report' }).click();
  await run;
  await expect(page).toHaveURL(IN_URL);
  await keptAfterReload(page);

  let saved: { params?: Record<string, string> } = {};
  await page.route('**/api/report-center/definitions', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    saved = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'saved-in-test' }) });
  });
  await page.getByRole('button', { name: 'Save these choices' }).click();
  const save = page.getByRole('dialog', { name: 'Save these choices' });
  await save.getByRole('textbox', { name: 'Name' }).fill('January and February');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(save).toBeHidden();
  // Custom dates were chosen as dates, so they are saved as dates.
  expect(saved.params).toMatchObject({ period: 'custom', from: FROM, to: TO });
  await page.unroute('**/api/report-center/definitions');

  await page.getByLabel('To', { exact: true }).fill('2026-01-01');
  await page.getByLabel('To', { exact: true }).blur();
  await expect(page.getByRole('alert').filter({ hasText: 'On or after the first day.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run report' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save these choices' })).toBeDisabled();
});

test('a file from the Report library holds the custom dates it was run on', async ({ page }) => {
  await page.goto(`/reports/library?type=individual&period=custom&from=${FROM}&to=${TO}`);
  await page.getByRole('button', { name: 'Run report' }).click();
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();
  const file = page.waitForRequest((r) => asks('/api/report-center/export')(r.url()) && r.url().includes('period=custom') && r.url().includes('format=csv'));
  await page.getByRole('button', { name: 'Download' }).click();
  await page.getByRole('menuitem', { name: /Spreadsheet \(CSV\)/ }).click();
  await file;
});

test('Duty narrows its list to custom dates', async ({ page }) => {
  await page.goto('/record/duty?period=last30');
  const narrow = page.getByRole('group', { name: 'Narrow the list' });
  const list = page.waitForRequest((r) => asks('/api/record/duty/list')(r.url()));
  await chooseCustom(page, narrow);
  await list;
  await expect(page).toHaveURL(IN_URL);
  await keptAfterReload(page, (p) => p.getByRole('group', { name: 'Narrow the list' }));
});

test("Today's outcomes take custom dates in the address and keep a preset as the saved choice", async ({ page }) => {
  await page.goto('/');
  const outcomes = page.getByRole('region', { name: /Outcomes you logged/ });
  await expect(outcomes).toBeVisible();
  const metrics = page.waitForRequest((r) => asks('/api/metrics?')(r.url()));
  await chooseCustom(page, outcomes);
  await metrics;
  await expect(page).toHaveURL(IN_URL);
  await expect(outcomes.getByRole('heading', { name: /Outcomes you logged/ })).toContainText('05 JAN 26 to 20 FEB 26');
  await keptAfterReload(page, (p) => p.getByRole('region', { name: /Outcomes you logged/ }));

  // All time is asked for by name, not as a span of days.
  const all = page.waitForRequest((r) => r.url().includes('/api/metrics?') && r.url().includes('period=all'));
  await outcomes.getByRole('combobox', { name: 'Period' }).click();
  await page.getByRole('option', { name: 'All time' }).click();
  await all;
  await expect(page).not.toHaveURL(/period=|from=/);
  await page.reload();
  await expect(page.getByRole('region', { name: /Outcomes you logged/ }).getByRole('combobox', { name: 'Period' })).toContainText('All time');
});

test('the Unit dashboard keeps custom dates in its address, and its requests, Print or file and export carry them', async ({ page }) => {
  test.setTimeout(90_000);
  // A Last year link still opens on Last year.
  await page.goto('/team/dashboard?unit=G8&days=365');
  const window = page.getByRole('combobox', { name: 'Window' });
  await expect(window).toContainText('Last year');
  const asked = page.waitForRequest((r) => asks('/api/org/units/G8/dashboard')(r.url()));
  await chooseCustom(page, page, 'Window');
  await asked;
  await expect(page).toHaveURL(IN_URL);
  await expect(page).not.toHaveURL(/days=/);
  await keptAfterReload(page, (p) => p, 'Window');
  await expect(page.getByText(/Shared entries only · 05 Jan 26 – 20 Feb 26/)).toBeVisible();
  // Custom dates go to the Report library by name, so it runs and saves them as dates.
  await expect(page.getByRole('link', { name: 'Print or file' })).toHaveAttribute('href', IN_URL);

  // The export holds the dates on screen, or every date.
  const ranged = page.waitForRequest((r) => asks('/api/org/units/G8/export')(r.url()));
  await page.getByRole('button', { name: 'Export unit data' }).click();
  await page.getByRole('menuitem', { name: /These dates/ }).click();
  await ranged;
  await expect(page.getByText('Unit export for 05 Jan 26 – 20 Feb 26 downloaded.')).toBeVisible();
  const everything = page.waitForRequest((r) => r.url().includes('/api/org/units/G8/export') && !r.url().includes('from='));
  await page.getByRole('button', { name: 'Export unit data' }).click();
  await page.getByRole('menuitem', { name: /Every date/ }).click();
  await everything;

  // 732 days are refused at the field, in the server's words, and the dashboard keeps the last good range.
  await page.getByLabel('From', { exact: true }).fill('2024-01-01');
  await page.getByLabel('To', { exact: true }).fill('2026-01-01');
  await page.getByLabel('To', { exact: true }).blur();
  await expect(page.getByRole('alert').filter({ hasText: 'At most 731 days, both ends counted.' })).toBeVisible();
  await expect(page).toHaveURL(IN_URL);

  // A preset goes back under its own key.
  await window.click();
  await page.getByRole('option', { name: 'Last year' }).click();
  await expect(page).toHaveURL(/days=365/);
  await expect(page).not.toHaveURL(/period=|from=/);
  await window.click();
  await page.getByRole('option', { name: 'Last 90 days' }).click();
  await expect(page).not.toHaveURL(/days=/);
});

test('Workload keeps its window in the address, and custom dates in its requests and Print or file', async ({ page }) => {
  await page.goto('/team/workload');
  const window = page.getByRole('combobox', { name: 'Window' });
  await expect(window).toContainText('30 days');
  await window.click();
  await page.getByRole('option', { name: '90 days', exact: true }).click();
  await expect(page).toHaveURL(/window=90/);
  await page.reload();
  await expect(window).toContainText('90 days');

  const asked = page.waitForRequest((r) => asks('/api/work/workload')(r.url()) && r.url().includes('period=custom'));
  await chooseCustom(page, page, 'Window');
  await asked;
  await expect(page).toHaveURL(IN_URL);
  await expect(page).not.toHaveURL(/window=/);
  await keptAfterReload(page, (p) => p, 'Window');
  await expect(page.getByText(/recorded 05 Jan 26 – 20 Feb 26/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Print or file' })).toHaveAttribute('href', IN_URL);
});

test('Your record keeps its reporting window, and the links from it keep the window', async ({ page }) => {
  // A 12 months link still opens on 12 months, and the Timeline link carries those 365 days ending today.
  await page.goto('/record?window=365');
  const window = page.getByRole('combobox', { name: 'Reporting window' });
  await expect(window).toContainText('12 months');
  const year = await page.evaluate(() => {
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const from = new Date(); from.setDate(from.getDate() - 364);
    return { from: key(from), to: key(new Date()) };
  });
  await expect(page.getByRole('link', { name: 'Your timeline' })).toHaveAttribute('href', `/record/timeline?period=custom&from=${year.from}&to=${year.to}`);
  await expect(page.getByRole('link', { name: 'Research entries', exact: true })).toHaveAttribute('href', '/record/contributions?window=365');
  const summary = page.waitForRequest((r) => asks('/api/record/summary')(r.url()));
  await chooseCustom(page, page, 'Reporting window');
  await summary;
  await expect(page).toHaveURL(IN_URL);
  await keptAfterReload(page, (p) => p, 'Reporting window');
  await expect(page.getByText('05 Jan 26 – 20 Feb 26').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Your timeline' })).toHaveAttribute('href', new RegExp(`/record/timeline\\?${IN_URL.source}`));

  // A figure opens Contributions on the same days.
  const contributions = page.waitForRequest((r) => asks('/api/record/contributions')(r.url()));
  await page.getByRole('link', { name: 'Research entries', exact: true }).click();
  await contributions;
  await expect(page).toHaveURL(new RegExp(`/record/contributions\\?${IN_URL.source}`));
  await expect(page.getByRole('combobox', { name: 'Reporting window' })).toContainText('Custom dates');

  // The default window leaves the address bare.
  await page.getByRole('combobox', { name: 'Reporting window' }).click();
  await page.getByRole('option', { name: '90 days', exact: true }).click();
  await expect(page).toHaveURL(/\/record\/contributions$/);
});

test("the Timeline offers the standard Period choice, and an old link's two days open as custom dates", async ({ page }) => {
  const asked = page.waitForRequest((r) => r.url().includes('/api/record/timeline') && r.url().includes('from=2025-11-01') && r.url().includes('to=2025-12-15'));
  await page.goto('/record/timeline?from=2025-11-01&to=2025-12-15');
  await asked;
  const period = page.getByRole('combobox', { name: 'Period' });
  await expect(period).toContainText('Custom dates');
  await expect(page.getByLabel('From', { exact: true })).toHaveValue('2025-11-01');

  // All time asks for no days, and leaves the address bare.
  const all = page.waitForRequest((r) => r.url().includes('/api/record/timeline') && !r.url().includes('from='));
  await period.click();
  await page.getByRole('option', { name: 'All time' }).click();
  await all;
  await expect(page).toHaveURL(/\/record\/timeline$/);

  const custom = page.waitForRequest((r) => asks('/api/record/timeline')(r.url()));
  await chooseCustom(page);
  await custom;
  await expect(page).toHaveURL(IN_URL);
  await keptAfterReload(page);
});

test('Report Studio starts a package on custom dates exactly as shown, and not on more than two years', async ({ page }) => {
  await page.goto('/reports');
  await page.getByRole('button', { name: 'New report' }).first().click();
  const start = page.getByRole('dialog', { name: 'New report' });
  await start.getByLabel('Title').fill('Custom dates package');
  await chooseCustom(page, start);

  await start.getByLabel('From', { exact: true }).fill('2024-01-01');
  await start.getByLabel('To', { exact: true }).fill('2026-01-01');
  await start.getByLabel('To', { exact: true }).blur();
  await expect(start.getByRole('alert').filter({ hasText: 'At most 731 days, both ends counted.' })).toBeVisible();
  await expect(start.getByRole('button', { name: 'Start' })).toBeDisabled();

  await start.getByLabel('From', { exact: true }).fill(FROM);
  await start.getByLabel('To', { exact: true }).fill(TO);
  await expect(start.getByRole('button', { name: 'Start' })).toBeEnabled();
  const created = page.waitForRequest((r) => r.url().endsWith('/api/studio/reports') && r.method() === 'POST');
  await start.getByRole('button', { name: 'Start' }).click();
  expect((await created).postDataJSON()).toMatchObject({ title: 'Custom dates package', period_start: FROM, period_end: TO });
  await expect(page.getByText('Not saved yet. Pick the records this report is built from, then save a revision.')).toBeVisible();
});

test('custom dates are chosen and set by keyboard alone', async ({ page }) => {
  await page.goto('/record/activities?period=all');
  const period = page.getByRole('combobox', { name: 'Period' });
  await period.focus();
  await page.keyboard.press('Enter');
  // The list opens on the period chosen, All time; Custom dates is the one after it.
  await expect(page.getByRole('option', { name: 'All time' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('option', { name: 'Custom dates' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(period).toContainText('Custom dates');
  await expect(period).toBeFocused();
  await page.keyboard.press('Tab');
  const from = page.getByLabel('From', { exact: true });
  await expect(from).toBeFocused();
  await page.keyboard.type('01052026');
  await expect(from).toHaveValue(FROM);
  const to = page.getByLabel('To', { exact: true });
  const days = page.getByRole('group', { name: 'Custom dates' });
  await to.focus();
  // Halfway through the year the field holds 0020, a day out of range. Nothing is said while the day is being typed.
  await page.keyboard.type('022020');
  await expect(to).toHaveValue('0020-02-20');
  await expect(days.getByRole('alert')).toHaveCount(0);
  await to.blur();
  await to.focus();
  await page.keyboard.type('02202026');
  await expect(to).toHaveValue(TO);
  await expect(days.getByRole('alert')).toHaveCount(0);
  await expect(page).toHaveURL(IN_URL);
});

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const PAGES = ['/record/activities', '/reports/analysis', '/reports/library?type=individual', '/record/duty', '/', '/team/dashboard?unit=G8', '/team/workload', '/record', '/record/timeline'];
const custom = `period=custom&from=${FROM}&to=${TO}`;

for (const width of [320, 768, 1280]) {
  test(`custom dates pass WCAG 2.2 AA at ${width} px, light and dark, without sideways scroll`, async ({ page }) => {
    test.setTimeout(420_000);
    await page.setViewportSize({ width, height: width < 768 ? 720 : 900 });
    for (const path of PAGES) {
      await page.goto(`${path}${path.includes('?') ? '&' : '?'}${custom}`);
      await expect(page.getByLabel('From', { exact: true }).first()).toHaveValue(FROM);
      // A backwards range shows its message too, so the error state is checked as well.
      await page.getByLabel('To', { exact: true }).first().fill('2026-01-01');
      await page.getByLabel('To', { exact: true }).first().blur();
      await expect(page.getByRole('alert').filter({ hasText: 'On or after the first day.' }).first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('[data-radix-popper-content-wrapper]').analyze();
        expect(results.violations.map((v) => `${v.id} [${v.impact}] ${v.nodes.slice(0, 3).map((n) => JSON.stringify(n.target)).join(' ')}`), `${path} at ${width} px, ${theme}`).toEqual([]);
      }
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways, `${path} at ${width} px scrolls sideways`).toBeLessThanOrEqual(1);
    }
  });
}
