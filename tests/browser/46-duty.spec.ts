import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * Duty records (Task 17, ADR-0023). A Marine records duty they stood on Records → Duty: the form shows what Vantage
 * will record (its length, its conditions and its points) before it is sent, and the duty waits for review. They
 * correct it, and move an activity that was really duty, with undo. A leader records duty for a Marine from the
 * Marine's page; the Marine sees it and cannot change it. Every view reads cleanly to assistive technology and fits a
 * phone.
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
/** A day this many days ago. */
const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

/** The G-8 operator, signed in on a page of their own, with G-8's standard duty types in place. */
async function leader(browser: Browser) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await loginAs(page, OPERATOR.username);
  const types = await page.request.post('/api/orgs/G8/duty-types/standard', { headers: H });
  expect(types.ok(), await types.text()).toBeTruthy();
  return { context, page };
}

async function choose(page: Page, dialog: Locator, label: string, option: string) {
  await dialog.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option }).click();
}

test('a Marine records duty, sees what it ran to before sending it, corrects it, and moves an activity that was duty', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const lead = await leader(browser);
  await registerAs(page, unique('stander'));
  await joinUnit(lead.page.request, page.request);
  const entry = await page.request.post('/api/records/activities', { headers: H, data: { title: 'Stood DNCO for the battalion', date: day(5), visibility: 'unit', unit_id: 'G8', result: 'No incidents.' } });
  expect(entry.ok(), await entry.text()).toBeTruthy();

  await page.goto('/record/duty');
  await expect(page.getByRole('heading', { name: 'Duty', level: 1 })).toBeVisible();
  const suggestions = page.getByRole('region', { name: /reads like duty you stood/ });
  await expect(suggestions.getByRole('link', { name: 'Stood DNCO for the battalion' })).toBeVisible();
  await expect(page.getByText('No duty recorded')).toBeVisible();
  expect(await axe(page), 'the duty page').toEqual([]);

  // The form says what Vantage will record before anything is sent.
  await page.getByRole('button', { name: 'Record duty' }).first().click();
  const form = page.getByRole('dialog', { name: 'Record duty' });
  await expect(form.getByRole('combobox', { name: 'Unit' })).toContainText('G8');
  await choose(page, form, 'Duty type', 'Barracks Duty (BARRACKS)');
  await form.getByLabel('Start date').fill(day(3));
  await form.getByLabel('Start time').fill('1600');
  await form.getByLabel('End date').fill(day(2));
  await form.getByLabel('End time').fill('8:00');
  const preview = form.getByRole('region', { name: 'What Vantage will record' });
  await expect(preview).toContainText('16 h · 1 duty day · overnight');
  await expect(preview).toContainText('Submitted, not yet counted');
  await form.getByRole('checkbox', { name: /^Holiday/ }).check();
  await expect(preview).toContainText('Holiday');
  expect(await axe(page), 'the duty form').toEqual([]);
  // A time it cannot read is said at the field, and nothing is sent.
  await form.getByLabel('End time').fill('25:99');
  await form.getByRole('button', { name: 'Record duty' }).click();
  await expect(form.getByRole('alert').first()).toContainText('Use a 24-hour time');
  await form.getByLabel('End time').fill('0800');
  await form.getByRole('button', { name: 'Record duty' }).click();
  await toast(page, 'Duty recorded and submitted for review.');

  // It opens once saved: what it ran to, how it was scored, and where it stands.
  const view = page.getByRole('dialog', { name: 'Barracks Duty' });
  await expect(view).toBeVisible();
  await expect(view).toContainText('Submitted');
  await expect(view).toContainText('16 h · 1 duty day · overnight');
  await expect(view).toContainText('Holiday');
  await expect(view.getByText('Calculated points')).toBeVisible();
  expect(await axe(page), 'a duty’s detail').toEqual([]);
  await view.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Change duty' });
  await edit.getByLabel('End time').fill('1000');
  await expect(edit.getByRole('region', { name: 'What Vantage will record' })).toContainText('18 h');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await toast(page, 'Duty updated.');
  // It opens again, as saved.
  await expect(page.getByRole('dialog', { name: 'Barracks Duty' })).toContainText('18 h · 1 duty day · overnight');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const barracks = page.getByRole('row').filter({ hasText: 'Barracks Duty' });
  await expect(barracks).toContainText('18 h');
  await expect(barracks).toContainText('Submitted');

  // The activity that was duty: recorded as duty with its type and times; the suggestion goes, and undo puts it back.
  await suggestions.getByRole('button', { name: 'Record as duty' }).click();
  const move = page.getByRole('dialog', { name: 'Record this activity as duty' });
  await expect(move.getByLabel('Title')).toHaveValue('Stood DNCO for the battalion');
  await choose(page, move, 'Duty type', 'DNCO (DNCO)');
  await move.getByLabel('Start time').fill('0800');
  await move.getByLabel('End time').fill('2000');
  await expect(move.getByRole('region', { name: 'What Vantage will record' })).toContainText('12 h');
  await move.getByRole('button', { name: 'Move to Duty' }).click();
  await toast(page, 'Recorded as duty. You can undo the move from the duty.');
  const moved = page.getByRole('dialog', { name: 'Stood DNCO for the battalion' });
  await expect(moved).toContainText('No incidents.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Stood DNCO for the battalion' })).toContainText('12 h');
  await expect(page.getByRole('region', { name: /reads like duty you stood/ })).toHaveCount(0);

  // Deleted, with undo.
  await barracks.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete this duty?' }).or(page.getByRole('dialog', { name: 'Delete this duty?' }));
  await confirm.getByRole('button', { name: /^(Delete|Confirm)/ }).click();
  await toast(page, 'Deleted.');
  await expect(page.getByRole('row').filter({ hasText: 'Barracks Duty' })).toHaveCount(0);
  await page.getByRole('status').filter({ hasText: 'Deleted.' }).getByRole('button', { name: 'Undo' }).click();
  await toast(page, 'Restored.');
  await expect(page.getByRole('row').filter({ hasText: 'Barracks Duty' })).toBeVisible();
  // DH-10: each row's buttons say which duty they act on, so a list of controls is not a column of identical "Delete".
  const restored = page.getByRole('row').filter({ hasText: 'Barracks Duty' });
  for (const name of ['View', 'Edit', 'Delete']) await expect(restored.getByRole('button', { name, exact: true })).toHaveAccessibleDescription(/Barracks Duty/);
  // DH-9: the table is named and every header cell says what its column holds, the buttons' column included.
  await expect(page.getByRole('table', { name: 'Your duty' })).toBeVisible();
  const practice = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').withTags(['wcag2a', 'wcag2aa', 'wcag22aa', 'best-practice']).analyze();
  expect(practice.violations.map((v) => v.id), 'the duty table’s headers').not.toContain('empty-table-header');

  // A phone: the page and the form fit.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/record/duty');
  await expect(page.getByRole('heading', { name: 'Duty', level: 1 })).toBeVisible();
  await noSidewaysScroll(page, 'the duty page');
  // DH-9: the columns that do not fit are reached from the keyboard, in a scroller named for its table.
  await expect(page.getByRole('table', { name: 'Your duty' })).toBeVisible();
  const scroller = page.getByRole('region', { name: 'Your duty' });
  await scroller.focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft), { message: 'the table scrolls from the keyboard' }).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Record duty' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Record duty' })).toBeVisible();
  await noSidewaysScroll(page, 'the duty form');
  await lead.context.close();
});

test('a leader records duty for a Marine from their page; the Marine sees it, told who recorded it, and cannot change it', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const lead = await leader(browser);
  await registerAs(page, unique('watch'));
  await joinUnit(lead.page.request, page.request);
  const me = await (await page.request.get('/api/me')).json();
  const marineId = me.user?.id ?? me.id;

  await lead.page.goto(`/team/${marineId}`);
  await lead.page.getByRole('button', { name: 'Record duty' }).first().click();
  const form = lead.page.getByRole('dialog', { name: 'Record duty' });
  await expect(form).toContainText('They are told, and they cannot change it');
  await choose(lead.page, form, 'Duty type', 'SAF (SAF)');
  await form.getByLabel('Start date').fill(day(4));
  await form.getByLabel('Start time').fill('0600');
  await form.getByLabel('End time').fill('1800');
  await form.getByRole('button', { name: 'Record duty' }).click();
  await toast(lead.page, /^Duty recorded for /);
  await expect(lead.page.getByRole('tab', { name: /^Duty/ })).toHaveAttribute('aria-selected', 'true');
  await expect(lead.page.getByRole('row').filter({ hasText: 'SAF' })).toContainText('12 h');
  expect(await axe(lead.page), 'the Marine’s duty tab').toEqual([]);
  // Its recorder corrects it; only its Marine moves it to another unit, so the unit reads as it is.
  await lead.page.getByRole('row').filter({ hasText: 'SAF' }).getByRole('button', { name: 'Edit' }).click();
  const change = lead.page.getByRole('dialog', { name: 'Change duty' });
  await expect(change.getByLabel('Unit')).toBeDisabled();
  await expect(change.getByText('only its Marine moves it')).toBeVisible();
  await lead.page.keyboard.press('Escape');
  await expect(lead.page.getByRole('dialog')).toHaveCount(0);

  await page.goto('/record/duty');
  const row = page.getByRole('row').filter({ hasText: 'SAF' });
  await expect(row).toContainText('recorded by');
  await expect(row.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await row.getByRole('button', { name: 'View' }).click();
  const view = page.getByRole('dialog', { name: 'SAF' });
  await expect(view).toContainText('recorded this duty for you, so only they or a records manager can change it');
  await expect(view.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await lead.context.close();
});

test('a long duty record reads a page at a time and can be narrowed; a link opens duty from long ago, or says why not; a list that fails says so', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const lead = await leader(browser);
  await registerAs(page, unique('longwatch'));
  await joinUnit(lead.page.request, page.request);
  const options = await (await page.request.get('/api/record/duty/options')).json();
  const type = (options.types as Array<{ id: string; code: string }>).find((t) => t.code === 'DNCO');
  expect(type, 'duty type DNCO').toBeTruthy();
  const stood = (p: Page, title: string, offset: number) => p.request.post('/api/records/duties', { headers: H, data: { duty_type_id: type!.id, unit_id: 'G8', title, date: day(offset), start_time: '0800', end_date: day(offset), end_time: '1600', visibility: 'unit' } });
  const ids: string[] = [];
  for (let i = 1; i <= 60; i++) {
    const res = await stood(page, `Watch ${i}`, i);
    expect(res.ok(), await res.text()).toBeTruthy();
    ids.push((await res.json()).id);
  }

  // DH-1, DH-5: the newest 50 first, with what is shown said and the rest a step away. Focus goes on to the first new row.
  await page.goto('/record/duty');
  const table = page.getByRole('table', { name: 'Your duty' });
  const watch = (n: number) => table.getByRole('button', { name: `Watch ${n}`, exact: true });
  await expect(table.getByRole('row')).toHaveCount(51);
  await expect(watch(1)).toBeVisible();
  await expect(watch(51)).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Showing 50 of 60, newest first.' })).toBeVisible();
  // DH-2: the totals are of all of it, never of the page open.
  await expect(page.getByText('60 entries')).toBeVisible();
  expect(await axe(page), 'a long duty record').toEqual([]);
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(table.getByRole('row')).toHaveCount(61);
  await expect(watch(51)).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Showing 60 of 60, newest first.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);

  // Narrowed by status and by period, each a labelled choice; a choice that leaves nothing says so and clears.
  const narrow = page.getByRole('group', { name: 'Narrow the list' });
  await narrow.getByRole('combobox', { name: 'Status' }).click();
  await page.getByRole('option', { name: 'Approved' }).click();
  await expect(page.getByText('No duty matches')).toBeVisible();
  await expect(page.getByText('No duty recorded')).toHaveCount(0);
  expect(await axe(page), 'a narrowed list with nothing in it').toEqual([]);
  // Back to all of it, as far as it was read.
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(table.getByRole('row')).toHaveCount(61);
  await narrow.getByRole('combobox', { name: 'Period' }).click();
  await page.getByRole('option', { name: 'Last 30 days' }).click();
  await expect(watch(2)).toBeVisible();
  await expect(watch(45)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);

  // DH-7: a link to duty older than the first page opens it all the same.
  await page.goto(`/record/duty?open=${ids[59]}`);
  await expect(page.getByRole('dialog', { name: 'Watch 60' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // A link to duty the reader may not read says so, and is set aside.
  const theirs = await stood(lead.page, `Leader ${unique('own')}`, 2);
  expect(theirs.ok(), await theirs.text()).toBeTruthy();
  await page.goto(`/record/duty?open=${(await theirs.json()).id}`);
  const refused = page.getByRole('region', { name: 'The duty this link opens' });
  await expect(refused).toContainText('Not yours to see');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await axe(page), 'a link to duty that is not theirs').toEqual([]);
  await refused.getByRole('button', { name: 'Dismiss' }).click();
  await expect(refused).toHaveCount(0);
  await expect(page).not.toHaveURL(/open=/);

  // DH-8: a list that fails to load says so, with a way to try again, and never reads as an empty record.
  const listed = '**/api/record/duty/list**';
  await page.route(listed, (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Something went wrong.' }) }));
  await page.goto('/record/duty');
  await expect(page.getByRole('alert').filter({ hasText: 'Your duty could not load' })).toBeVisible();
  await expect(page.getByText('No duty recorded')).toHaveCount(0);
  expect(await axe(page), 'a list that failed to load').toEqual([]);
  await page.unroute(listed);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(table.getByRole('row')).toHaveCount(51);
  await lead.context.close();
});
