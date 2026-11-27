import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, instanceDay, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * A Marine's Analysis opens from their page (ADR-0008, one Unit Instance's units at a time): the page links to it,
 * the Analysis names the Marine and the units it was drawn from, and the page links to the access log filtered to the
 * Marine only for a reader who may view that log.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** A Marine who joined G8 with a join code from the leader signed in on `leader`, with one entry shared with G8. */
async function sharedMarine(leader: Page, browser: Browser, title: string) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const last = `Ledger${unique('')}`;
  await registerAs(page, unique('mana'), { first_name: 'Dana', last_name: last });
  const me = await (await page.request.get('/api/me')).json();
  await joinUnit(leader.request, page.request);
  const logged = await page.request.post('/api/records/activities', { headers: H, data: { title, date: instanceDay(1), quantity: 4, unit_label: 'ULOs', result: 'Closed out the obligations', visibility: 'unit', unit_id: 'G8' } });
  expect(logged.ok(), await logged.text()).toBeTruthy();
  await context.close();
  return { id: me.user.id as string, last };
}

/** The view the leader last chose, set to a known one: earlier specs pick views of their own. */
async function savedView(page: Page, reportView: string) {
  const saved = await page.request.put('/api/me/prefs', { headers: H, data: { reportView } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
}
const prefsView = async (page: Page) => ((await (await page.request.get('/api/me/prefs')).json()).reportView ?? '') as string;
/** The Analysis link in the sidebar's Reports & Analytics pages: the app's own way to the reader's own report. */
const ownAnalysis = (page: Page) => page.getByRole('navigation', { name: 'Primary' }).getByRole('list', { name: 'Reports & Analytics pages' }).getByRole('link', { name: 'Analysis', exact: true });

test('a leader opens a Marine’s Analysis from their page, and it says what it was drawn from', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await loginAs(page, OPERATOR.username);
  await savedView(page, 'narrative');
  const title = `Balanced the ${unique('fund')} ledger`;
  const marine = await sharedMarine(page, browser, title);

  await page.goto(`/team/${marine.id}`);
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(marine.last) })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Shared outcomes, last 12 months' })).toBeVisible();
  const analysis = page.getByRole('link', { name: 'Analysis', exact: true });
  await expect(analysis).toHaveAttribute('href', `/reports/analysis?${new URLSearchParams({ user: marine.id, unit: 'G8', view: 'analysis' })}`);
  await analysis.click();

  await expect(page).toHaveURL(/\/reports\/analysis\?/);
  await expect(page.getByRole('heading', { level: 1, name: new RegExp(`for LCpl ${marine.last}`) })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Full analysis' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(`Drawn from what LCpl Dana ${marine.last} shared with G8. Private entries are never included.`)).toBeVisible();
  const view = page.getByTestId('analysis');
  await expect(view).toBeVisible();
  await expect(view.getByText('average strength')).toHaveCount(0);
  await view.getByRole('button', { name: 'Show the ledger' }).click();
  await expect(view.getByRole('table', { name: 'Entry ledger' })).toContainText(title);
  const scan = await new AxeBuilder({ page }).withTags(TAGS).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);

  // The view the link opened is not saved as the leader's own: their Reports page opens on the view they last chose.
  const prefs = await (await page.request.get('/api/me')).json();
  expect(prefs.prefs?.reportView).toBe('narrative');
  // Their own Analysis, reached through the sidebar from the Marine's, is on that view, not the link's.
  await ownAnalysis(page).click();
  await expect(page).toHaveURL(/\/reports\/analysis$/);
  await expect(page.getByRole('heading', { level: 1, name: /input$/ })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Narrative', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('analysis')).toHaveCount(0);
  expect(await prefsView(page)).toBe('narrative');
});

test('a Marine’s link opens its own view each time it is opened, and a view the leader picks replaces it in the address', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await loginAs(page, OPERATOR.username);
  await savedView(page, 'narrative');
  const marine = await sharedMarine(page, browser, `Closed ${unique('ulo')} obligations`);
  const heading = page.getByRole('heading', { level: 1, name: new RegExp(`for LCpl ${marine.last}`) });
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });

  await page.goto(`/team/${marine.id}`);
  await page.getByRole('link', { name: 'Analysis', exact: true }).click();
  await expect(heading).toBeVisible();
  await expect(tab('Full analysis')).toHaveAttribute('aria-selected', 'true');
  // Away to the leader's own report and Back: each address opens on its own view.
  await ownAnalysis(page).click();
  await expect(page).toHaveURL(/\/reports\/analysis$/);
  await expect(tab('Narrative')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(heading).toBeVisible();
  await expect(tab('Full analysis')).toHaveAttribute('aria-selected', 'true');

  // The leader picks a view: it is saved as theirs, and the link's view leaves the address, the Marine and unit stay.
  await tab('Bullets').click();
  await expect(tab('Bullets')).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(new RegExp(`/reports/analysis\\?${new URLSearchParams({ user: marine.id, unit: 'G8' })}$`));
  await expect.poll(() => prefsView(page)).toBe('bullets');
  await expect(page.getByRole('heading', { level: 2, name: 'Bullet package' })).toBeVisible();
  await page.reload();
  await expect(heading).toBeVisible();
  await expect(tab('Bullets')).toHaveAttribute('aria-selected', 'true');
  // Back to the Marine's report from the leader's own shows the view picked, not the link's.
  await ownAnalysis(page).click();
  await expect(page).toHaveURL(/\/reports\/analysis$/);
  await expect(tab('Bullets')).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(heading).toBeVisible();
  await expect(tab('Bullets')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('analysis')).toHaveCount(0);
});

test('the access log button is there only for a reader who may view the unit’s access log', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await loginAs(page, OPERATOR.username);
  const marine = await sharedMarine(page, browser, `Reconciled ${unique('mipr')} MIPRs`);

  // The unit's leader views its access log, and is offered it filtered to the Marine.
  await page.goto(`/team/${marine.id}`);
  await expect(page.getByRole('link', { name: 'Analysis', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Access log' })).toHaveAttribute('href', `/team/access-log?${new URLSearchParams({ unit: 'G8', person: marine.id })}`);

  // A Fire Team Leader opens member records but may not view the access log: the Analysis, and no access log.
  const name = unique('ftl');
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const reader = await context.newPage();
  await registerAs(reader, name, { first_name: 'Fran', last_name: 'Teamlead' });
  const readerMe = await (await reader.request.get('/api/me')).json();
  await joinUnit(page.request, reader.request);
  const granted = await page.request.post(`/api/org/team/${readerMe.user.id}/roles`, { headers: H, data: { role_id: 'G8:fire-team-leader', unit_id: 'G8' } });
  expect(granted.ok(), await granted.text()).toBeTruthy();
  await loginAs(reader, name);
  await reader.goto(`/team/${marine.id}`);
  await expect(reader.getByRole('heading', { level: 1, name: new RegExp(marine.last) })).toBeVisible();
  await expect(reader.getByRole('link', { name: 'Analysis', exact: true })).toBeVisible();
  await expect(reader.getByText('You are seeing only what this Marine shared with G8.')).toBeVisible();
  await expect(reader.getByRole('link', { name: 'Access log' })).toHaveCount(0);
  await context.close();
});
