import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, instanceDay, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * A Marine's statistics (ADR-0051): a Statistics tab on their page, read only once it is opened, drawn from what they
 * shared with the reader's units, with the deployment's Privacy Act statement and the Statistics report to take away;
 * and one's own at Reports & Analytics, Statistics, private entries included.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const scan = async (page: Page) => (await new AxeBuilder({ page }).withTags(TAGS).exclude('[data-radix-popper-content-wrapper]').analyze())
  .violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);

/** A Marine of G8 with one entry shared with G8 and one kept private, signed in on a page of their own. */
async function marineWithEntries(leader: Page, browser: Browser) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const last = `Tally${unique('')}`;
  await registerAs(page, unique('stat'), { first_name: 'Robin', last_name: last });
  const me = await (await page.request.get('/api/me')).json();
  await joinUnit(leader.request, page.request);
  for (const [title, visibility] of [[`Reconciled the ${unique('fund')} ledger`, 'unit'], [`Private ${unique('note')}`, 'private']] as const) {
    const logged = await page.request.post('/api/records/activities', { headers: H, data: { title, date: instanceDay(1), quantity: 4, unit_label: 'ULOs', result: 'Closed out the obligations', visibility, unit_id: 'G8' } });
    expect(logged.ok(), await logged.text()).toBeTruthy();
  }
  return { context, page, id: me.user.id as string, last };
}

test('a leader opens a Marine’s Statistics tab: read once opened, what they shared, the Privacy Act statement and the export', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await loginAs(page, OPERATOR.username);
  const marine = await marineWithEntries(page, browser);
  try {
    const asked: URL[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/statistics')) asked.push(new URL(r.url())); });
    await page.goto(`/team/${marine.id}`);
    await expect(page.getByRole('heading', { level: 1, name: new RegExp(marine.last) })).toBeVisible();
    const tab = page.getByRole('tab', { name: 'Statistics' });
    await expect(tab).toBeVisible();
    expect(asked, 'nothing is read, so nothing is logged, until the tab is opened').toEqual([]);

    await tab.click();
    const view = page.getByTestId('statistics');
    await expect(view.getByRole('heading', { name: 'Entries and outcomes' })).toBeVisible();
    expect(asked.length).toBe(1);
    expect(Object.fromEntries(['user_id', 'unit_id'].map((k) => [k, asked[0].searchParams.get(k)]))).toEqual({ user_id: marine.id, unit_id: 'G8' });
    await expect(view.getByText(/shared with G8\. This view was logged to each unit’s access log\./)).toBeVisible();
    for (const heading of ['Duty', 'Training and awards', 'Counseling', 'Activity in Vantage']) await expect(view.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    const tiles = view.getByRole('region', { name: 'What did the record hold in the range?' });
    await expect(tiles.getByText('Entries in the range')).toBeVisible();
    await expect(view.getByText('Their own history only: nobody else’s figures are read or compared, and nothing is scored or projected.')).toBeVisible();

    const privacy = view.getByRole('region', { name: 'Privacy Act statement' });
    await expect(privacy).toContainText('AUTHORITY: The statement this deployment sets.');
    await expect(privacy).toContainText('PRINCIPAL PURPOSE: A placeholder for the browser tests.');
    expect(await scan(page)).toEqual([]);

    // The export menu offers the Statistics report in each file the leader may take, and the PDF downloads.
    await view.getByRole('button', { name: 'Export statistics' }).click();
    for (const name of [/^PDF/, /^Spreadsheet \(CSV\)/, /^Excel workbook/, /^Vantage file \(JSON\)/]) await expect(page.getByRole('menuitem', { name })).toBeVisible();
    const exported = page.waitForRequest(/\/api\/report-center\/export/);
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: /^PDF/ }).click();
    const sent = new URL((await exported).url()).searchParams;
    expect(Object.fromEntries(['type', 'subject', 'user_id', 'unit_id', 'format'].map((k) => [k, sent.get(k)]))).toEqual({ type: 'statistics', subject: 'member', user_id: marine.id, unit_id: 'G8', format: 'pdf' });
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);

    // A period picked is in the address, and read again for it.
    await view.getByRole('combobox', { name: 'Period' }).click();
    await page.getByRole('option', { name: 'Last 30 days' }).click();
    await expect(page).toHaveURL(/[?&]period=last30/);
    await expect(page).toHaveURL(/[?&]tab=statistics/);
    await expect.poll(() => asked.at(-1)?.searchParams.get('period')).toBe('last30');
  } finally {
    await marine.context.close();
  }
});

test('a Marine’s own Statistics, from Reports & Analytics, count what they keep private too', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await loginAs(page, OPERATOR.username);
  const marine = await marineWithEntries(page, browser);
  try {
    const own = marine.page;
    await own.goto('/reports');
    await own.getByRole('navigation', { name: 'Primary' }).getByRole('list', { name: 'Reports & Analytics pages' }).getByRole('link', { name: 'Statistics', exact: true }).click();
    await expect(own).toHaveURL(/\/reports\/statistics$/);
    await expect(own.getByRole('heading', { level: 1, name: 'Statistics' })).toBeVisible();
    const view = own.getByTestId('statistics');
    await expect(view.getByText('Your own record, private entries included.')).toBeVisible();
    const tiles = view.getByRole('region', { name: 'What did the record hold in the range?' });
    await expect(tiles).toContainText('Entries in the range');
    await expect(tiles).toContainText('2');
    await expect(view.getByRole('region', { name: 'Privacy Act statement' })).toBeVisible();
    await view.getByRole('button', { name: 'Export statistics' }).click();
    await expect(own.getByRole('menuitem')).toHaveCount(4);
    await own.keyboard.press('Escape');
    expect(await scan(own)).toEqual([]);

    // Somebody else's, asked for by a Marine who does not lead them, is refused.
    const leader = await (await page.request.get('/api/me')).json();
    const refused = await own.request.get(`/api/statistics?${new URLSearchParams({ user_id: leader.user.id })}`, { headers: H });
    expect(refused.status()).toBe(403);
  } finally {
    await marine.context.close();
  }
});
