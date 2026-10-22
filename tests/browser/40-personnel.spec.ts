import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, joinUnit, loginAs, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

/**
 * Personnel management (Task 11, ADR-0017): a leader sets a Marine's billet, supervisor and check-in from the roster,
 * changes several Marines at once after a preview, and reads the result on the Marine's Personnel tab; a Unit Manager
 * manages the roster without opening a record; a Marine reads their own personnel record. Each page reads cleanly to
 * assistive technology and fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};

/** A Marine registered on their own, who joined G8 with a join code from the leader signed in on `page`. */
async function marineInG8(page: Page, browser: Browser, last: string) {
  const username = unique(last.toLowerCase());
  const other = await browser.newContext();
  const res = await other.request.post('/api/auth/register', { headers: H, data: { username, password: PASSWORD, first_name: 'Sam', last_name: last, rank_id: 'LCpl' } });
  expect(res.ok(), await res.text()).toBeTruthy();
  const me = await (await other.request.get('/api/me')).json();
  await joinUnit(page.request, other.request);
  await other.close();
  return { id: me.user.id as string, username };
}

test('a leader sets a billet, supervisor and check-in, changes two Marines at once after a preview, and reads it on the Personnel tab', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await loginAs(page, OPERATOR.username);
  const lastA = `Okoro${unique('')}`;
  const lastB = `Vance${unique('')}`;
  const a = await marineInG8(page, browser, lastA);
  await marineInG8(page, browser, lastB);
  // A billet on the unit's list, as a Unit Manager keeps it.
  await page.goto('/console/G8/billets');
  await confirmSudoIfAsked(page);
  const title = unique('Fiscal Clerk ');
  const made = await page.request.post('/api/orgs/G8/billets', { headers: H, data: { title, unit_id: 'G8' } });
  expect(made.ok(), await made.text()).toBeTruthy();

  await page.goto('/team/roster?unit=G8');
  const rowA = page.getByRole('row').filter({ hasText: lastA });
  await rowA.getByRole('button', { name: `Change ${lastA}’s billet` }).click();
  const dialog = page.getByRole('dialog', { name: /billet and assignment/ });
  await dialog.getByLabel('Billet').fill(title);
  await dialog.getByLabel('Supervisor').fill('Bolet');
  await dialog.getByRole('list', { name: /Marines matching/ }).getByRole('button', { name: /Boletz/ }).click();
  await expect(dialog.getByLabel('Supervisor')).toHaveValue(/Boletz/);
  await dialog.getByLabel('Checked in').fill('2026-10-01');
  await dialog.getByLabel('Why (optional)').fill('Reported aboard');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await toast(page, 'Billet, supervisor and check-in saved');
  await expect(rowA).toContainText(title);
  await expect(rowA).toContainText('Boletz');
  await page.waitForLoadState('networkidle');
  expect(serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations), 'roster').toEqual([]);

  // Two at once: previewed first, then applied to both.
  await rowA.getByRole('checkbox', { name: `Select LCpl ${lastA}` }).check();
  await page.getByRole('row').filter({ hasText: lastB }).getByRole('checkbox', { name: `Select LCpl ${lastB}` }).check();
  const selection = page.getByRole('region', { name: 'Selected Marines' });
  await expect(selection).toContainText('2 selected');
  await selection.getByRole('button', { name: 'Change all 2' }).click();
  const bulk = page.getByRole('dialog', { name: 'Change 2 Marines' });
  await expect(bulk.getByRole('button', { name: 'Apply to 2' })).toBeDisabled();
  await bulk.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'Set the assignment end' }).click();
  await bulk.getByLabel('Date').fill('2027-09-30');
  await bulk.getByRole('button', { name: 'Preview' }).click();
  await expect(bulk.getByRole('region', { name: 'Preview' })).toContainText('All 2 can be changed.');
  expect(serious((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations), 'bulk dialog').toEqual([]);
  await bulk.getByRole('button', { name: 'Apply to 2' }).click();
  await toast(page, 'Changed 2 Marines.');
  await expect(rowA).toContainText('Ends 30 Sep 27');
  await expect(page.getByRole('row').filter({ hasText: lastB })).toContainText('Ends 30 Sep 27');

  // The filters find who is missing what.
  await page.getByRole('tab', { name: /^No supervisor/ }).click();
  await expect(page.getByRole('row').filter({ hasText: lastB })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: lastA })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Everyone' }).click();

  // The Marine's page opens on their personnel record.
  await rowA.getByRole('link', { name: `Open LCpl ${lastA}` }).click();
  await expect(page.getByRole('heading', { name: new RegExp(lastA), level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Personnel' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('list', { name: 'Assignments' })).toContainText(title);
  await expect(page.getByRole('list', { name: /Leadership chain/ })).toContainText('Boletz');
  const history = page.getByRole('list', { name: 'History' });
  await expect(history).toContainText('Supervisor set to');
  await expect(history).toContainText('“Reported aboard”');
  await expect(history).toContainText('part of a bulk change');
  // A responsibility, added and ended, stays on the record as ended.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const resp = page.getByRole('dialog', { name: `New responsibility for LCpl ${lastA}` });
  await resp.getByLabel('Responsibility').fill('Safety NCO');
  await resp.getByRole('button', { name: 'Add' }).click();
  await toast(page, 'Safety NCO added for');
  await page.getByRole('button', { name: 'End Safety NCO' }).click();
  await page.getByRole('dialog', { name: /End Safety NCO/ }).getByRole('button', { name: 'End it' }).click();
  await toast(page, 'Safety NCO ended for');
  await page.waitForLoadState('networkidle');
  expect(serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations), 'Personnel tab').toEqual([]);
  // Their records are a tab away, for a leader who may open them.
  await page.getByRole('tab', { name: /Activities/ }).click();
  await expect(page).toHaveURL(new RegExp(`/team/${a.id}\\?tab=activities`));
});

test('a Unit Manager manages the roster without opening a record, and a Marine reads their own from Settings, on a phone too', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await loginAs(page, OPERATOR.username);
  const last = `Quill${unique('')}`;
  const marine = await marineInG8(page, browser, last);
  const managerName = unique('umgr');
  const manager = await browser.newContext();
  const reg = await manager.request.post('/api/auth/register', { headers: H, data: { username: managerName, password: PASSWORD, first_name: 'Uma', last_name: 'Manager', rank_id: 'SSgt' } });
  expect(reg.ok(), await reg.text()).toBeTruthy();
  const managerMe = await (await manager.request.get('/api/me')).json();
  // The manager joins on a section chief's code: a Unit Manager gives no Unit Instance role to an account they brought
  // in themselves until it has signed in with its own CAC or the organization's sign-in (ADR-0013).
  const chiefName = unique('chief');
  const chiefContext = await browser.newContext();
  const chief = await chiefContext.newPage();
  await registerAs(chief, chiefName, { first_name: 'Section', last_name: 'Chief' });
  const chiefMe = await (await chief.request.get('/api/me')).json();
  await joinUnit(page.request, chief.request);
  const made = await page.request.post(`/api/org/team/${chiefMe.user.id}/roles`, { headers: H, data: { role_id: 'G8:sncoic', unit_id: 'G8' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  await loginAs(chief, chiefName);
  await joinUnit(chief.request, manager.request);
  await chiefContext.close();
  await page.goto('/console/G8');
  await confirmSudoIfAsked(page);
  const granted = await page.request.post('/api/orgs/G8/roles', { headers: H, data: { user_id: managerMe.user.id, role: 'admin' } });
  expect(granted.ok(), await granted.text()).toBeTruthy();
  await manager.close();

  // The Unit Manager: the roster and the personnel record, no records.
  const umContext = await browser.newContext();
  const um = await umContext.newPage();
  await loginAs(um, managerName);
  await um.goto('/team/roster?unit=G8');
  await expect(um.getByRole('heading', { name: 'Roster', level: 1 })).toBeVisible();
  const row = um.getByRole('row').filter({ hasText: last });
  await expect(row.getByRole('button', { name: `Change ${last}’s billet` })).toBeVisible();
  await row.getByRole('link', { name: `Open LCpl ${last}` }).click();
  await expect(um.getByRole('tab', { name: 'Personnel' })).toHaveAttribute('aria-selected', 'true');
  await expect(um.getByRole('tab', { name: /Activities/ })).toHaveCount(0);
  await expect(um.getByText(/Their entries stay with those who may read them/)).toBeVisible();
  await expect(um.getByRole('button', { name: 'Edit profile' })).toBeVisible();
  await um.getByRole('button', { name: `Change ${last}’s assignment in G8` }).click();
  const dialog = um.getByRole('dialog', { name: /billet and assignment/ });
  await dialog.getByLabel('Assignment start').fill('2026-10-01');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await toast(um, 'Assignment start saved');
  expect((await um.request.get(`/api/org/team/${marine.id}`)).status(), 'their records stay closed').toBe(403);
  await umContext.close();

  // The Marine, on a phone: Settings links to their own record, which they read and cannot change.
  // Axe reads only pages of a context the test made.
  const ownContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const own = await ownContext.newPage();
  await loginAs(own, marine.username);
  await own.goto('/settings');
  await own.getByRole('link', { name: 'Your personnel record' }).click();
  await expect(own).toHaveURL(new RegExp(`/team/${marine.id}`));
  await expect(own.getByRole('tab', { name: 'Personnel' })).toHaveAttribute('aria-selected', 'true');
  await expect(own.getByRole('list', { name: 'Assignments' })).toContainText('G8');
  await expect(own.getByRole('list', { name: 'History' })).toContainText('Assignment start set to');
  await expect(own.getByRole('button', { name: /assignment in/ })).toHaveCount(0);
  await own.waitForLoadState('networkidle');
  await noSidewaysScroll(own, 'their own personnel record');
  expect(serious((await new AxeBuilder({ page: own }).analyze()).violations), 'own record on a phone').toEqual([]);
  await ownContext.close();

  // The leader's roster on a phone is a list.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/team/roster?unit=G8');
  await expect(page.getByRole('list', { name: 'Roster' })).toContainText(last);
  await noSidewaysScroll(page, 'the roster');
});
