import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, instanceDay, joinUnit, loginAs, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

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

  // The roster does not wait on the whole team list: held back here, the roster still paints.
  let releaseTeam = () => {};
  const teamHeld = new Promise<void>((resolve) => { releaseTeam = resolve; });
  await page.route('**/api/org/team', async (route) => { await teamHeld; await route.continue(); });
  await page.goto('/team/roster?unit=G8');
  const rowA = page.getByRole('row').filter({ hasText: lastA });
  await expect(rowA).toBeVisible();
  // One layout at a time: at this width the table, and no phone list beside it.
  await expect(page.getByRole('list', { name: 'Roster' })).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /^Showing \d+ of \d+ Marines\.$/ })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Roster' }).getByRole('columnheader', { name: 'Actions' })).toHaveCount(1);
  releaseTeam();
  await rowA.getByRole('button', { name: `Change ${lastA}’s billet` }).click();
  const dialog = page.getByRole('dialog', { name: /billet and assignment/ });
  await dialog.getByLabel('Billet').fill(title);
  // The supervisor is chosen from a combobox that says how many match.
  const supervisor = dialog.getByRole('combobox', { name: 'Supervisor' });
  await supervisor.fill('Bolet');
  await expect(supervisor).toHaveAttribute('aria-expanded', 'true');
  await expect(dialog.getByRole('status').filter({ hasText: /^1 person to choose from\.$/ })).toBeAttached();
  await dialog.getByRole('option', { name: /Boletz/ }).click();
  await expect(dialog.getByLabel('Supervisor')).toHaveValue(/Boletz/);
  await dialog.getByLabel('Checked in').fill('2026-10-01');
  await dialog.getByLabel('Why (optional)').fill('Reported aboard');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
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

  // The Marine's page opens on their personnel record, without waiting for their records, which fill their tabs after.
  let releaseRecords = () => {};
  const recordsHeld = new Promise<void>((resolve) => { releaseRecords = resolve; });
  await page.route(`**/api/org/team/${a.id}`, async (route) => { await recordsHeld; await route.continue(); });
  await rowA.getByRole('link', { name: `Open LCpl ${lastA}` }).click();
  await expect(page.getByRole('heading', { name: new RegExp(lastA), level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Personnel' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('list', { name: 'Assignments' })).toContainText(title);
  // Released, the route stays in place: what is held goes on, and later requests pass straight through.
  releaseRecords();
  // Each count is of what the reader may see, as the server counts it.
  await expect(page.getByRole('tab', { name: /^Activities/ })).toContainText('0');
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

  // Their duty on a phone is a list, not a table to scroll sideways.
  expect((await page.request.post('/api/orgs/G8/duty-types/standard', { headers: H })).ok()).toBeTruthy();
  const options = await (await page.request.get('/api/record/duty/options')).json();
  const saf = (options.types as Array<{ id: string; code: string }>).find((t) => t.code === 'SAF');
  // The instance's day, not UTC's: from midnight UTC until midnight in New York, UTC's date is still to come there.
  const today = instanceDay();
  const watch = `Phone watch ${unique('')}`;
  const stood = await page.request.post('/api/records/duties', { headers: H, data: { duty_type_id: saf!.id, unit_id: 'G8', title: watch, date: today, start_time: '0800', end_date: today, end_time: '1600', visibility: 'unit', user_id: a.id } });
  expect(stood.ok(), await stood.text()).toBeTruthy();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/team/${a.id}?tab=duty`);
  await expect(page.getByRole('list', { name: 'Shared duty' })).toContainText(watch);
  await expect(page.getByRole('table', { name: 'Shared duty' })).toHaveCount(0);
  await noSidewaysScroll(page, 'their duty');
  await page.waitForLoadState('networkidle');
  expect(serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations), 'duty on a phone').toEqual([]);
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
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
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

  // The leader's roster on a phone is a list, and only a list.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/team/roster?unit=G8');
  await expect(page.getByRole('list', { name: 'Roster' })).toContainText(last);
  await expect(page.getByRole('table', { name: 'Roster' })).toHaveCount(0);
  await noSidewaysScroll(page, 'the roster');
  const box = await page.getByRole('list', { name: 'Roster' }).getByRole('checkbox').first().locator('xpath=..').boundingBox();
  expect(box && box.width >= 44 && box.height >= 44, 'a roster checkbox is a 44 px target').toBeTruthy();
});

test('a long roster shows a hundred at a time, says how many it shows, and keeps the keyboard where it was', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  // The roster as the server gives it, made long: a hundred and fifty Marines, each with their own name. The first read
  // fails, and the page offers to try again rather than leave a dead end.
  let reads = 0;
  await page.route('**/api/org/units/G8/personnel', async (route) => {
    if (reads++ === 0) { await route.fulfill({ status: 500, json: { error: 'The server is busy.' } }); return; }
    const res = await route.fetch();
    const body = await res.json();
    const first = body.rows.find((r: { self: boolean }) => !r.self) ?? body.rows[0];
    body.rows = Array.from({ length: 150 }, (_, i) => ({ ...first, id: `${first.id}-${i}`, first_name: 'Long', last_name: `Roster${String(i).padStart(3, '0')}`, self: false }));
    await route.fulfill({ response: res, json: body });
  });
  await page.goto('/team/roster?unit=G8');
  await page.getByRole('button', { name: 'Try again' }).click();
  const status = page.getByRole('status').filter({ hasText: /^Showing / });
  await expect(status).toHaveText('Showing 100 of 150 Marines.');
  await expect(page.getByRole('row').filter({ hasText: 'Roster099' })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: 'Roster100' })).toHaveCount(0);
  const more = page.getByRole('button', { name: 'Show 50 more' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(status).toHaveText('Showing 150 of 150 Marines.');
  await expect(page.getByRole('button', { name: /^Show \d+ more$/ })).toHaveCount(0);
  // The button is gone, so the keyboard is on the first Marine it brought in.
  await expect(page.getByRole('row').filter({ hasText: 'Roster100' }).getByRole('link', { name: /Roster100/ })).toBeFocused();
  // A search starts again from the top of what it finds.
  await page.getByLabel('Search roster').fill('Roster14');
  await expect(status).toHaveText('Showing 10 of 10 matching, 150 on the roster.');
  await page.waitForLoadState('networkidle');
  expect(serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations), 'long roster').toEqual([]);
});

test('a bulk move offers only teams in the roster’s view, and of two billets with one title the one held is kept', async ({ page, browser }) => {
  test.setTimeout(120_000);
  await loginAs(page, OPERATOR.username);
  // Two sections side by side under G8, and a team beneath the first.
  const tag = unique('');
  const unit = async (name: string, short: string, parent: string) => {
    const made = await page.request.post('/api/org/units', { headers: H, data: { name, short_name: short, echelon: 'section', parent_id: parent } });
    expect(made.ok(), await made.text()).toBeTruthy();
    return (await made.json()).id as string;
  };
  const left = await unit(`Left Section ${tag}`, `LS${tag}`, 'G8');
  await unit(`Left Team ${tag}`, `LT${tag}`, left);
  await unit(`Right Section ${tag}`, `RS${tag}`, 'G8');
  const last = `Ruiz${tag}`;
  const marine = await marineInG8(page, browser, last);
  const moved = await page.request.post(`/api/org/units/G8/members/${marine.id}/move`, { headers: H, data: { to: left } });
  expect(moved.ok(), await moved.text()).toBeTruthy();
  // Out of G8 now, but in a team its leader leads: the enroll search offers them, and says how many it found.
  await page.goto('/team/roster?unit=G8');
  await page.getByRole('button', { name: 'Enroll an existing account' }).click();
  const enroll = page.getByRole('dialog', { name: 'Enroll in G8' });
  const find = enroll.getByRole('combobox', { name: 'Find by username or last name' });
  await find.fill('z');
  await expect(enroll.getByRole('status').filter({ hasText: 'Type at least 2 letters of a name.' })).toBeAttached();
  await find.fill(last);
  await expect(find).toHaveAttribute('aria-expanded', 'true');
  await expect(enroll.getByRole('status').filter({ hasText: /^1 person to choose from\.$/ })).toBeAttached();
  await expect(enroll.getByRole('option', { name: new RegExp(last) })).toBeVisible();
  expect(serious((await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations), 'enroll dialog').toEqual([]);
  await find.fill('zzzz');
  await expect(enroll.getByRole('status').filter({ hasText: /Nobody you lead matches/ })).toBeVisible();
  await expect(find).toHaveAttribute('aria-expanded', 'false');
  await enroll.getByRole('button', { name: 'Cancel' }).click();
  // The same title on the command's list and on the Left Section's own; they hold the command's.
  const title = unique('Supply Clerk ');
  const billet = async (unitId: string | null) => {
    const made = await page.request.post('/api/orgs/G8/billets', { headers: H, data: { title, unit_id: unitId } });
    expect(made.ok(), await made.text()).toBeTruthy();
    return (await made.json()).id as string;
  };
  const everyUnit = await billet(null);
  const onlyLeft = await billet(left);
  const held = await page.request.put(`/api/org/units/${left}/members/${marine.id}`, { headers: H, data: { billet_id: everyUnit } });
  expect(held.ok(), await held.text()).toBeTruthy();
  const billetNow = async () => ((await (await page.request.get(`/api/org/team/${marine.id}/personnel`)).json()).instances[0].assignments.find((a: { unit_id: string }) => a.unit_id === left).billet_id);

  await page.goto(`/team/roster?unit=${left}`);
  const row = page.getByRole('row').filter({ hasText: last });
  await row.getByRole('checkbox', { name: `Select LCpl ${last}` }).check();
  await page.getByRole('region', { name: 'Selected Marines' }).getByRole('button', { name: 'Change one' }).click();
  const bulk = page.getByRole('dialog', { name: 'Change 1 Marine' });
  await bulk.getByRole('combobox').first().click();
  await page.getByRole('option', { name: 'Move to another team' }).click();
  await bulk.getByRole('combobox').nth(1).click();
  // Only the team beneath this view: the bulk change works inside the view it was opened on.
  await expect(page.getByRole('option')).toHaveText([`LT${tag}`]);
  await page.keyboard.press('Escape');
  await bulk.getByRole('button', { name: 'Cancel' }).click();

  // Saving a date alone keeps the billet they hold; the other one is chosen by name.
  await row.getByRole('button', { name: `Change ${last}’s billet` }).click();
  const dialog = page.getByRole('dialog', { name: /billet and assignment/ });
  await expect(dialog.getByLabel('Billet', { exact: true })).toHaveValue(title);
  await expect(dialog.getByRole('combobox', { name: 'Which billet' })).toContainText('every unit');
  await dialog.getByLabel('Checked in').fill('2026-10-20');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await toast(page, 'Check-in saved');
  expect(await billetNow()).toBe(everyUnit);
  await row.getByRole('button', { name: `Change ${last}’s billet` }).click();
  await dialog.getByRole('combobox', { name: 'Which billet' }).click();
  await page.getByRole('option', { name: `${title} · only LS${tag}` }).click();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await toast(page, 'Billet saved');
  expect(await billetNow()).toBe(onlyLeft);
});

test('a supervisor offered again from the search already made, once the dialog is closed and opened, is the one chosen and saved', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await loginAs(page, OPERATOR.username);
  const last = `Pryor${unique('')}`;
  const lastSup = `Hallow${unique('')}`;
  const marine = await marineInG8(page, browser, last);
  await marineInG8(page, browser, lastSup);
  // The first search reaches the server and any after it waits, so the second time the dialog opens, the names it offers
  // can only come from what the first search left in the query cache.
  let searches = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/api\/org\/units\/G8\/supervisor-candidates\?/, async (route) => { if (searches++ > 0) await held; await route.continue(); });
  await page.goto(`/team/${marine.id}`);
  await expect(page.getByRole('tab', { name: 'Personnel' })).toHaveAttribute('aria-selected', 'true');
  const change = page.getByRole('button', { name: `Change ${last}’s assignment in G8` });
  const dialog = page.getByRole('dialog', { name: /billet and assignment/ });
  const supervisor = dialog.getByRole('combobox', { name: 'Supervisor' });
  const option = dialog.getByRole('option', { name: new RegExp(lastSup) });
  await change.click();
  await supervisor.fill(lastSup);
  await expect(option).toBeVisible();
  // Escape closes the list first, then Cancel the dialog.
  await supervisor.press('Escape');
  await expect(supervisor).toHaveAttribute('aria-expanded', 'false');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);

  // Opened again, the same search is answered from the cache, and choosing the name it offers names them.
  await change.click();
  await supervisor.fill(lastSup);
  await option.click();
  await expect(dialog.getByLabel('Supervisor')).toHaveValue(new RegExp(lastSup));
  await expect(dialog.getByRole('button', { name: 'Clear the supervisor' })).toBeVisible();
  release();
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await toast(page, 'Supervisor saved');
  await expect(page.getByRole('list', { name: /Leadership chain/ })).toContainText(lastSup);
});

test('a name the enroll search offers again from what it already found, after the roster was left and opened, is the one enrolled', async ({ page, browser }) => {
  test.setTimeout(90_000);
  await loginAs(page, OPERATOR.username);
  const tag = unique('');
  const made = await page.request.post('/api/org/units', { headers: H, data: { name: `Far Section ${tag}`, short_name: `FS${tag}`, echelon: 'section', parent_id: 'G8' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const far = (await made.json()).id as string;
  const last = `Quill${tag}`;
  const marine = await marineInG8(page, browser, last);
  const moved = await page.request.post(`/api/org/units/G8/members/${marine.id}/move`, { headers: H, data: { to: far } });
  expect(moved.ok(), await moved.text()).toBeTruthy();

  await page.goto('/team/roster?unit=G8');
  const open = page.getByRole('button', { name: 'Enroll an existing account' });
  const enroll = page.getByRole('dialog', { name: 'Enroll in G8' });
  const find = enroll.getByRole('combobox', { name: 'Find by username or last name' });
  const option = enroll.getByRole('option', { name: new RegExp(last) });
  await open.click();
  await find.fill(last);
  await expect(option).toBeVisible();
  await enroll.getByRole('button', { name: 'Cancel' }).click();
  // Away from the roster to a Marine's page and back, inside the app: the same search is answered from what the first
  // one found.
  await page.getByRole('table', { name: 'Roster' }).getByRole('link').first().click();
  await expect(page).not.toHaveURL(/\/team\/roster/);
  await page.goBack();
  await expect(page.getByRole('table', { name: 'Roster' })).toBeVisible();
  await open.click();
  await find.fill(last);
  await option.click();
  await expect(enroll.getByRole('button', { name: `Change from ${last} to someone else` })).toBeVisible();
  await expect(enroll.getByText(`@${marine.username}`)).toBeVisible();
  await enroll.getByRole('button', { name: 'Cancel' }).click();
});
