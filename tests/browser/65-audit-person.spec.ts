import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * One person's entries in an audit trail (ADR-0011, ADR-0012): a name in an entry narrows the Unit Manager console's
 * trail to what that person did and what was done about them, a chip says whose entries are shown and clears it, and the
 * file carries the filter. A link to /team/access-log with ?unit= and ?person= opens that unit's log already narrowed. The
 * console's People list and the admin Accounts list link each person to their trail, which opens narrowed to them with
 * the trail's whole action list to pick from.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);

/** A Marine in `unit` whose readiness the signed-in leader opened: entries about them in its trail and access log. */
async function lookedAt(browser: Browser, leader: Page, unit = 'G8') {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  const username = unique('person');
  await registerAs(page, username);
  await joinUnit(leader.request, page.request, unit);
  const me = await (await page.request.get('/api/me')).json() as { user: { id: string; first_name: string; last_name: string } };
  const read = await leader.request.get(`/api/me/readiness/${me.user.id}`, { headers: H });
  expect(read.ok(), await read.text()).toBeTruthy();
  return { context, id: me.user.id, username, name: `${me.user.first_name} ${me.user.last_name}` };
}

test('a name in the Unit Instance trail narrows it to that person, the file carries it, and the chip shows everyone again', async ({ page, browser }) => {
  await loginAs(page, OPERATOR.username);
  const marine = await lookedAt(browser, page);
  const other = await lookedAt(browser, page);
  try {
    await page.goto('/console/G8/audit');
    await confirmSudoIfAsked(page);
    await expect(page.getByRole('heading', { name: 'Audit trail', level: 1 })).toBeVisible();
    const rows = page.getByRole('table', { name: 'Audit entries, newest first' }).locator('tbody tr');
    await expect(rows.filter({ hasText: other.name }).first()).toBeVisible();

    await page.getByRole('button', { name: `Show only ${marine.name}` }).first().click();
    const chip = page.getByText(`Only ${marine.name}`);
    await expect(chip).toBeVisible();
    await expect(chip, 'focus moves to whose entries are shown').toBeFocused();
    await expect(page).toHaveURL(new RegExp(`[?&]person=${marine.id}`));
    await expect(page.getByRole('status').filter({ hasText: /shown, filtered/ })).toBeVisible();
    await expect(rows.first()).toContainText(marine.name);
    for (const text of await rows.allInnerTexts()) expect(text, 'every entry is by them or about them').toContain(marine.name);
    await expect(rows.filter({ hasText: other.name })).toHaveCount(0);
    const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
    expect(serious(results.violations), '/console/G8/audit?person=').toEqual([]);

    const exported = page.waitForRequest(/\/api\/orgs\/G8\/audit\/export/);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    expect(new URL((await exported).url()).searchParams.get('person'), 'the file holds what the page shows').toBe(marine.id);
    await download;

    await page.getByRole('button', { name: 'Show everyone' }).click();
    await expect(chip).toHaveCount(0);
    await expect(page.locator('#audit-apply'), 'focus stays in the trail, on a control that opens no keyboard').toBeFocused();
    await expect(page).not.toHaveURL(/person=/);
    await expect(page.getByRole('status').filter({ hasText: /shown, newest first/ })).not.toContainText('filtered');
    await expect(rows.filter({ hasText: other.name }).first()).toBeVisible();
  } finally {
    await marine.context.close();
    await other.context.close();
  }
});

test('a link to a unit’s access log for one person opens it narrowed to them, and a name there narrows it to another', async ({ page, browser }) => {
  await loginAs(page, OPERATOR.username);
  // A team beneath G-8, which is not the view the leader is on: the link picks it.
  const short = unique('AL').toUpperCase();
  const made = await page.request.post('/api/org/units', { headers: H, data: { name: `Access Team ${short}`, short_name: short, parent_id: 'G8' } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const team = (await made.json()) as { id: string };
  const marine = await lookedAt(browser, page, team.id);
  const other = await lookedAt(browser, page, team.id);
  try {
    await page.goto(`/team/access-log?unit=${team.id}&person=${marine.id}`);
    await expect(page.getByRole('main').locator('.eyebrow').first(), 'the team’s log, not the view the leader was on').toContainText(short);
    const table = page.getByRole('table', { name: 'Who has been reading records in this unit' });
    const rows = table.locator('tbody tr');
    await expect(rows.filter({ hasText: 'View readiness' }).first()).toBeVisible();
    await expect(page.getByText(`Only ${marine.name}`)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /shown, filtered, newest first/ })).toBeVisible();
    for (const text of await rows.allInnerTexts()) expect(text).toContain(marine.name);
    await expect(rows.filter({ hasText: other.name })).toHaveCount(0);
    // The cells still read as the names alone.
    const read = rows.filter({ hasText: 'View readiness' }).first();
    await expect(read.locator('td').nth(1)).toHaveText(/^(?:\S+ )?John Boletz$/);
    await expect(read.locator('td').nth(3)).toHaveText(marine.name);
    const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
    expect(serious(results.violations), '/team/access-log?person=').toEqual([]);

    await page.getByRole('button', { name: 'Show everyone' }).click();
    await expect(page.locator('#unit-access-heading'), 'focus goes to the log’s heading, not the page body').toBeFocused();
    await expect(rows.filter({ hasText: other.name }).first()).toBeVisible();
    await page.getByRole('button', { name: `Show only ${other.name}` }).first().click();
    await expect(page.getByText(`Only ${other.name}`)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`[?&]person=${other.id}`));
    // The narrowed page itself, not the one before it or the placeholder while it loads.
    await expect(page.getByRole('status').filter({ hasText: /shown, filtered, newest first/ })).toBeVisible();
    await expect(rows.first()).toContainText(other.name);
    await expect(rows.filter({ hasText: marine.name }).filter({ hasNotText: other.name })).toHaveCount(0);
    for (const text of await rows.allInnerTexts()) expect(text).toContain(other.name);
  } finally {
    await marine.context.close();
    await other.context.close();
  }
});

test('the People list and the Accounts list open a person’s trail narrowed to them, with every action of the trail to pick from', async ({ page, browser }) => {
  await loginAs(page, OPERATOR.username);
  const marine = await lookedAt(browser, page);
  try {
    // The Unit Manager console's People list, for a reader with the Unit Instance's audit trail.
    await page.goto('/console/G8/people');
    await confirmSudoIfAsked(page);
    await expect(page.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
    await page.getByRole('textbox', { name: 'Search people' }).fill(marine.username);
    const toTrail = page.getByRole('link', { name: `Audit trail for ${marine.username}` });
    await expect(toTrail).toHaveAttribute('href', `/console/G8/audit?person=${marine.id}`);
    await toTrail.click();
    await confirmSudoIfAsked(page);
    await expect(page.getByRole('heading', { name: 'Audit trail', level: 1 })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/console/G8/audit\\?person=${marine.id}$`));
    const chip = page.getByText(`Only ${marine.name}`);
    await expect(chip, 'named from their own entries').toBeVisible();
    const rows = page.getByRole('table', { name: 'Audit entries, newest first' }).locator('tbody tr');
    await expect(rows.first()).toContainText(marine.name);

    // Opened on one person, the trail still offers its actions, and narrows by one of them.
    await page.getByRole('combobox', { name: 'Action' }).click();
    await page.getByRole('option', { name: 'View readiness', exact: true }).click();
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByRole('status').filter({ hasText: /shown, filtered, newest first/ })).toBeVisible();
    await expect(rows.first()).toContainText('View readiness');
    for (const text of await rows.allInnerTexts()) { expect(text).toContain('View readiness'); expect(text).toContain(marine.name); }

    // Once a page has named them, a page that holds nothing of theirs still says whose entries were asked for.
    await page.getByLabel('From (UTC)').fill('2020-01-01');
    await page.getByLabel('To (UTC)').fill('2020-01-31');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('Nothing matches')).toBeVisible();
    await expect(chip).toBeVisible();

    // Clear takes the person off too, and focus stays in the trail.
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(chip).toHaveCount(0);
    await expect(page).not.toHaveURL(/person=/);
    await expect(page.locator('#audit-apply')).toBeFocused();

    // The Vantage Administrator console's Accounts list, for staff who read the platform trail.
    await page.goto('/admin/accounts');
    await confirmSudoIfAsked(page);
    await expect(page.getByRole('heading', { name: 'Accounts', level: 1 })).toBeVisible();
    await page.getByLabel('Search accounts').fill(marine.username);
    const toPlatform = page.getByRole('link', { name: `Platform trail for ${marine.username}` });
    await expect(toPlatform).toHaveAttribute('href', `/admin/audit?person=${marine.id}`);
    await toPlatform.click();
    await confirmSudoIfAsked(page);
    await expect(page.getByRole('heading', { name: 'Platform audit trail', level: 1 })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/admin/audit\\?person=${marine.id}$`));
    await expect(page.getByText(`Only ${marine.username}`), 'the platform trail names people by username').toBeVisible();
    const platformRows = page.getByRole('table', { name: 'Audit entries, newest first' }).locator('tbody tr');
    await expect(platformRows.first()).toContainText(marine.username);
    for (const text of await platformRows.allInnerTexts()) expect(text).toContain(marine.username);
    await page.getByRole('combobox', { name: 'Action' }).click();
    await expect(page.getByRole('option', { name: 'Login', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
    expect(serious(results.violations), '/admin/audit?person=').toEqual([]);
  } finally {
    await marine.context.close();
  }
});
