import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, joinUnit, loginAs, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

// Task 10 (ADR-0016): the specification's UX definition of done, walked as a new Marine and as a unit leader would.

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

// A new account, on Today and ready for the keyboard.
const signUp = async (page: Page, name: string) => {
  await registerAs(page, unique(name));
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
};
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const answer = (page: Page, question: string) => page.locator('#find-your-way dl > div').filter({ has: page.getByText(question, { exact: true }) });
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};

test('a new Marine finds out what Vantage is and where everything lives, from Today to the field guide', async ({ page }) => {
  await signUp(page, 'newbie');
  const first = page.getByRole('region', { name: 'Your first week' });
  await expect(first).toContainText('Vantage keeps your work, your records and your training in one place');
  await first.getByRole('link', { name: 'Where everything is' }).click();
  await expect(page).toHaveURL(/\/help#find-your-way$/);
  await expect(page.getByRole('heading', { name: 'Field guide', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Find your way' })).toBeVisible();

  // The twelve questions of the definition of done, each answered.
  for (const q of ['What is Vantage?', 'What do I need to do today?', 'Where does my work live?', 'Where do my records live?', 'Where does training live?',
    'Where are my Marines?', 'How do I record something?', 'How do I import something?', 'How do I export something?', 'How do I see how I am doing?',
    'Where is duty?', 'Where do I get help?']) {
    await expect(answer(page, q), q).toHaveCount(1);
  }
  // Places are named as the menu names them.
  await expect(answer(page, 'Where does training live?').getByRole('link', { name: 'Training & Development → Training' })).toBeVisible();
  await expect(answer(page, 'Where do my records live?').getByRole('link', { name: 'Records → Timeline' })).toBeVisible();
  // Someone who leads nobody is told when Personnel appears, and offered no link they could not open.
  const people = answer(page, 'Where are my Marines?');
  await expect(people).toContainText('Personnel appears in the menu when you lead a unit');
  await expect(people.getByRole('link')).toHaveCount(0);
  await expect(answer(page, 'How do I see how I am doing?').getByRole('link', { name: /Unit dashboard/ })).toHaveCount(0);

  // Each link opens the page it names.
  await answer(page, 'Where does training live?').getByRole('link', { name: 'Training & Development → Training' }).click();
  await expect(page).toHaveURL(/\/career\/training$/);
  await expect(page.getByRole('heading', { name: 'Training', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New training' }).first()).toBeVisible();

  // Duty, until it has records of its own, is an activity filed under Operations; the link opens them, filtered.
  await page.goto('/help');
  await answer(page, 'Where is duty?').getByRole('link', { name: 'Records → Activities' }).click();
  await expect(page).toHaveURL(/\/record\/activities\?category=Operations$/);
  await expect(page.getByRole('button', { name: /^Filters/ })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('combobox', { name: 'Category' })).toHaveText('Operations');

  // Each import link opens its import, not only its page.
  const imports: Array<[string, string]> = [['Records → Activities', 'Import activities from CSV'], ['Work → Queue', 'Import work from a spreadsheet']];
  for (const [link, dialog] of imports) {
    await page.goto('/help');
    await answer(page, 'How do I import something?').getByRole('link', { name: link }).click();
    await expect(page.getByRole('dialog', { name: dialog }), link).toBeVisible();
    await page.keyboard.press('Escape');
  }

  expect(serious((await new AxeBuilder({ page }).analyze()).violations)).toEqual([]);

  // A link to a page they cannot use says so, under that page's name and group; the server refuses its data regardless.
  await page.goto('/team/roles');
  await expect(page.getByRole('heading', { name: 'Roles', level: 1 })).toBeVisible();
  await expect(page.getByRole('main').locator('.eyebrow').first()).toHaveText('Administration');
  await expect(page.getByText('No unit visibility yet')).toBeVisible();
  expect((await page.request.get('/api/org/units/G8/audit', { headers: { 'x-vantage-client': '1' } })).status()).toBeGreaterThanOrEqual(400);
});

test('a unit leader finds the Marines they lead and the unit’s figures, each where the menu says', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.goto('/help');
  const people = answer(page, 'Where are my Marines?');
  await expect(people.getByRole('link', { name: 'Personnel → Roster' })).toBeVisible();
  await expect(answer(page, 'How do I see how I am doing?').getByRole('link', { name: 'Reports & Analytics → Unit dashboard' })).toBeVisible();
  expect(serious((await new AxeBuilder({ page }).analyze()).violations)).toEqual([]);

  await people.getByRole('link', { name: 'Personnel → Roster' }).click();
  await expect(page).toHaveURL(/\/team\/roster$/);
  await expect(page.getByRole('heading', { name: 'Roster', level: 1 })).toBeVisible();
  await expect(page.getByRole('main').locator('.eyebrow').first()).toHaveText(/^Personnel · /);
});

test('a page the unit view does not include keeps the name it was asked for, and says so', async ({ page }) => {
  // A plain member of G8 sees its overview, not its roster or roles; a link to either still names that page.
  await signUp(page, 'member');
  const leader = await playwrightRequest.newContext({ baseURL: page.url().replace(/^(https?:\/\/[^/]+).*$/, '$1') });
  expect((await leader.post('/api/auth/login', { headers: { 'x-vantage-client': '1' }, data: { username: OPERATOR.username, password: PASSWORD } })).ok()).toBeTruthy();
  await joinUnit(leader, page.request);
  await leader.dispose();

  const asked: Array<[string, string, string]> = [['/team/roster', 'Personnel', 'Roster'], ['/team/roles', 'Administration', 'Roles']];
  for (const [path, group, heading] of asked) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 }), path).toBeVisible();
    await expect(page.getByRole('main').locator('.eyebrow').first(), path).toHaveText(new RegExp(`^${group} · `));
    await expect(page, path).toHaveTitle(`${heading} · ${group} · Vantage`);
    await expect(page.getByText(/^Not part of the .+ view$/), path).toBeVisible();
  }
  await page.getByRole('link', { name: 'Open the overview' }).click();
  await expect(page).toHaveURL(/\/team$/);
  await expect(page.getByRole('main').locator('.eyebrow').first()).toHaveText(/^Personnel/);
  await expect(page.getByText(/^Not part of the .+ view$/)).toHaveCount(0);
});

test('importing and exporting are named for what moves, on their pages and in ⌘K', async ({ page }) => {
  await signUp(page, 'porter');
  const palette = async (text: string) => {
    await page.keyboard.press('Meta+k');
    await page.getByRole('combobox', { name: 'Search' }).fill(text);
  };

  await palette('import');
  await expect(page.getByRole('option', { name: /Import work/ })).toBeVisible();
  await page.getByRole('option', { name: /Import activities/ }).click();
  await expect(page).toHaveURL(/\/record\/activities\?import=1$/);
  const csv = page.getByRole('dialog', { name: 'Import activities from CSV' });
  await expect(csv).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(csv).toBeHidden();
  await expect(page.getByRole('button', { name: 'Import activities' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export activities' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New activity' })).toBeVisible();

  await palette('import');
  await page.getByRole('option', { name: /Import work/ }).click();
  const wizard = page.getByRole('dialog', { name: 'Import work from a spreadsheet' });
  await expect(wizard).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(wizard).toBeHidden();
  await expect(page).toHaveURL(/\/work\/queue$/);
  await expect(page.getByRole('button', { name: 'Import work' }).first()).toBeVisible();
  // From ⌘K while already on the queue, and Back closes it again.
  await palette('import');
  await page.getByRole('option', { name: /Import work/ }).click();
  await expect(wizard).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/work\/queue$/);
  await expect(wizard).toBeHidden();

  await palette('export');
  await expect(page.getByRole('option', { name: /Export my record as a PDF/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Export everything Vantage holds about me/ })).toBeVisible();
  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('option', { name: /Export activities/ }).click()]);
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
});

test('Activities keeps search and period in view, and folds the other filters behind one button that counts them', async ({ page }) => {
  await signUp(page, 'filter');
  await page.goto('/record/activities');
  await expect(page.getByRole('textbox', { name: 'Search records' })).toBeVisible();
  const filters = page.getByRole('button', { name: /^Filters/ });
  await expect(filters).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('combobox', { name: 'Quality filter' })).toBeHidden();
  await filters.click();
  await expect(filters).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('combobox', { name: 'Quality filter' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sort' })).toBeVisible();

  // A link that sets a folded filter opens them, and the button counts it.
  await page.goto('/record/activities?quality=needs-detail');
  await expect(filters).toHaveAttribute('aria-expanded', 'true');
  await expect(filters).toHaveAccessibleName(/^Filters\s*1$/);
  await page.locator('#record-filters').getByRole('button', { name: 'Clear filters' }).click();
  await expect(filters).toHaveAccessibleName(/^Filters$/);
  await expect(page.getByRole('combobox', { name: 'Quality filter' })).toHaveText('All entries');
});

test('the keyboard reaches every group, and the shortcut list names only what a Marine can open', async ({ page }) => {
  await signUp(page, 'keys');
  await page.keyboard.press('?');
  const list = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(list).toBeVisible();
  for (const where of ['Go to Today', 'Go to Work', 'Go to Records', 'Go to Training & Development', 'Go to Reports & Analytics', 'Go to Help', 'Go to Settings']) {
    await expect(list.getByText(where, { exact: true }), where).toBeVisible();
  }
  for (const not of ['Go to Personnel', 'Go to Administration', 'Go to Unit Manager console', 'Switch view']) await expect(list.getByText(not, { exact: true }), not).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  for (const [key, path, heading] of [['c', /\/career\/training$/, 'Training'], ['r', /\/record$/, 'Your record'], ['h', /\/help$/, 'Field guide'], ['p', /\/reports$/, 'Packages']] as const) {
    await page.keyboard.press('g');
    await page.keyboard.press(key);
    await expect(page, `G ${key.toUpperCase()}`).toHaveURL(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
});

test('a unit leader’s shortcut list has Personnel and Administration, and G A opens the unit’s administration', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.keyboard.press('?');
  const list = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  for (const where of ['Go to Personnel', 'Go to Administration', 'Go to Unit Manager console']) await expect(list.getByText(where, { exact: true }), where).toBeVisible();
  // Each letter is listed once.
  const letters = await list.locator('li').filter({ hasText: /^Go to / }).locator('kbd, .kbd').allInnerTexts();
  const second = letters.filter((_, i) => i % 2 === 1);
  expect(new Set(second).size).toBe(second.length);
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();

  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/\/team\/invitations$/);
  await expect(page.getByRole('heading', { name: 'Invitations', level: 1 })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/\/team$/);
});

test('on a phone, Help and Activities fit the screen and pass axe, and the drawer is the same menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, 'phone');
  await page.goto('/help');
  await expect(page.getByRole('heading', { name: 'Find your way' })).toBeVisible();
  await noSidewaysScroll(page, 'Help');
  expect(serious((await new AxeBuilder({ page }).analyze()).violations)).toEqual([]);

  await page.goto('/record/activities');
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByRole('combobox', { name: 'Quality filter' })).toBeVisible();
  await noSidewaysScroll(page, 'Activities with its filters open');
  expect(serious((await new AxeBuilder({ page }).analyze()).violations)).toEqual([]);

  await page.getByRole('button', { name: 'Open menu' }).click();
  const drawer = page.locator('nav[aria-label="Primary"]:visible');
  const top = (await drawer.getByRole('link').allInnerTexts()).map((l) => l.trim());
  expect(top.filter((l) => !['Overview', 'Timeline', 'Activities', 'Awards', 'Counseling', 'Drafts', 'Contributions'].includes(l)))
    .toEqual(['Today', 'Work', 'Records', 'Training & Development', 'Reports & Analytics', 'Help', 'Settings']);
});
