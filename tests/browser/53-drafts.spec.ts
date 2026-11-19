import { test, expect, type Browser, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * Drafts (ADR-0030). A draft lives with its own kind. A new goal, award, training entry, task or billet change
 * can be saved as a draft to finish later; closing a form with unsaved text asks first. Each page lists its own drafts,
 * and the Drafts page lists every kind, each opening where it is finished. A leader's drafted award recommendation is
 * theirs alone: its Marine sees nothing and is told nothing until it is added. Every view reads cleanly to assistive
 * technology in both themes and fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const bothThemes = async (page: Page, what: string) => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    expect(await axe(page), `${what}, ${theme}`).toEqual([]);
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
};
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};

/** The G-8 operator (its Unit Leader, who counsels its members), signed in on a page of their own. */
async function leader(browser: Browser) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await loginAs(page, OPERATOR.username);
  return { context, page };
}

test('a goal saved as a draft waits on its page and in Drafts, only its author sees it, and adding it removes the draft', async ({ page }) => {
  test.setTimeout(120_000);
  await registerAs(page, unique('drft'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));
  const title = `Close every aged ULO before FY close ${unique('g')}`;

  // Closing a form with text in it asks first, and Save draft keeps it.
  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal' }).first().click();
  const form = page.getByRole('dialog', { name: 'New goal' });
  await expect(form).toContainText('Save draft keeps it to you. Adding it puts it in the record now.');
  await form.getByLabel('Goal').fill(title);
  await page.keyboard.press('Escape');
  const leave = page.getByRole('dialog', { name: 'Keep what you wrote?' });
  await expect(leave).toContainText('This goal is not saved anywhere yet.');
  expect(await axe(page), 'the leave check').toEqual([]);
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await expect(leave).toHaveCount(0);
  await expect(form.getByLabel('Goal')).toHaveValue(title);
  await expect(form.getByLabel('Goal'), 'back where they were typing').toBeFocused();
  await form.getByRole('button', { name: 'Save draft' }).click();
  await toast(page, 'Saved to Drafts. Only you can see it.');
  await expect(form).toHaveCount(0);

  // The page lists it above its goals; it is not a goal.
  const strip = page.getByRole('region', { name: /Your drafts/ });
  await expect(strip).toContainText(title);
  await expect(strip).toContainText(/Kept until/);
  await expect(page.getByRole('heading', { level: 3, name: title })).toHaveCount(0);
  await bothThemes(page, 'goals with a draft');

  // Drafts lists it with who can read it, and opens it where it is finished.
  await page.goto('/record/drafts');
  await expect(page.getByText(/No leader, reviewer or administrator can open them/)).toBeVisible();
  const waiting = page.getByRole('region', { name: /Waiting on you/ });
  const item = waiting.getByRole('listitem').filter({ hasText: title });
  await expect(item).toContainText('Only you');
  await expect(item).toContainText('Goal');
  await bothThemes(page, 'the Drafts page');
  await item.getByRole('link', { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(/\/goals\?draft=/);
  const link = page.url();
  const resumed = page.getByRole('dialog', { name: 'New goal' });
  await expect(resumed).toContainText('Draft · only you. Opened from your drafts.');
  await expect(resumed.getByLabel('Goal')).toHaveValue(title);
  // Asked whether to discard it, and kept: focus is back on the button that asked.
  await resumed.getByRole('button', { name: 'Discard draft' }).click();
  const discard = page.getByRole('dialog', { name: 'Discard this draft?' });
  await expect(discard).toContainText('cannot be brought back');
  await discard.getByRole('button', { name: 'Cancel' }).click();
  await expect(discard).toHaveCount(0);
  await expect(resumed.getByRole('button', { name: 'Discard draft' })).toBeFocused();
  await resumed.getByRole('button', { name: 'Add goal' }).click();
  await toast(page, 'Goal added.');
  await expect(page).not.toHaveURL(/draft=/);
  await expect(page.getByRole('heading', { level: 3, name: title })).toBeVisible();
  await expect(page.getByRole('region', { name: /Your drafts/ })).toHaveCount(0);

  // Gone from Drafts once it is a goal: the record is the only copy.
  await page.goto('/record/drafts');
  await expect(page.getByText(/No leader, reviewer or administrator can open them/)).toBeVisible();
  await expect(page.getByText(title)).toHaveCount(0);
  const sent = await page.request.get('/api/drafts');
  expect((await sent.json()).items.some((d: { title: string }) => d.title === title)).toBe(false);
  // A link to a draft that was sent says so, and opens nothing.
  await page.goto(link);
  await toast(page, 'That draft is no longer here. It was sent or discarded.');
  await expect(page).not.toHaveURL(/draft=/);
  await expect(page.getByRole('dialog', { name: 'New goal' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a leader’s drafted award recommendation stays theirs; its Marine sees and hears nothing until it is added', async ({ page, browser }) => {
  test.setTimeout(150_000);
  const lead = await leader(browser);
  await registerAs(page, unique('awrd'));
  await joinUnit(lead.page.request, page.request);
  const me = (await (await page.request.get('/api/me')).json()).user;
  const award = `Navy and Marine Corps Achievement Medal ${unique('a')}`;

  await lead.page.goto(`/team/${me.id}`);
  await lead.page.getByRole('button', { name: 'Recommend award' }).click();
  const form = lead.page.getByRole('dialog', { name: /Recommend .* for an award/ });
  await expect(form).toContainText(/Adding it puts it in the record now, and .+ is told\./);
  await form.getByRole('combobox', { name: /^Award/ }).or(form.getByRole('textbox', { name: /^Award/ })).first().fill(award);
  await form.getByRole('button', { name: 'Save draft' }).click();
  await toast(lead.page, 'Saved to Drafts. Only you can see it.');
  const strip = lead.page.getByRole('region', { name: /Your drafts/ });
  await expect(strip).toContainText(award);
  expect(await axe(lead.page), 'their page with a drafted recommendation').toEqual([]);

  // The Marine it is about: no award, no draft, no notice.
  const awards = await (await page.request.get('/api/records/awards')).json();
  expect(Array.isArray(awards), JSON.stringify(awards)).toBe(true);
  expect(JSON.stringify(awards)).not.toContain(award);
  await page.goto('/career/awards');
  await expect(page.getByRole('heading', { level: 1, name: 'Awards' })).toBeVisible();
  await expect(page.getByText(award)).toHaveCount(0);
  const theirs = await (await page.request.get('/api/drafts')).json();
  expect(theirs.items.some((d: { title: string }) => d.title.includes(award))).toBe(false);
  const notices = await (await page.request.get('/api/me/notifications?limit=40')).json();
  expect(JSON.stringify(notices)).not.toContain(award);

  // The leader finishes it from their own awards page, where recommendations they drafted are listed too.
  await lead.page.goto('/career/awards');
  const mine = lead.page.getByRole('region', { name: /Your drafts/ });
  await expect(mine).toContainText(award);
  await mine.getByRole('link', { name: new RegExp(`Continue ${award}`) }).click();
  await expect(lead.page).toHaveURL(new RegExp(`/team/${me.id}\\?draft=`));
  const resumed = lead.page.getByRole('dialog', { name: /Recommend .* for an award/ });
  await expect(resumed.getByRole('combobox', { name: /^Award/ }).or(resumed.getByRole('textbox', { name: /^Award/ })).first()).toHaveValue(award);
  await resumed.getByRole('button', { name: 'Add award' }).click();
  await toast(lead.page, 'Award added.');
  await expect(lead.page.getByRole('region', { name: /Your drafts/ })).toHaveCount(0);

  // Now it is a record, and the Marine has it.
  await page.goto('/career/awards');
  await expect(page.getByText(award).first()).toBeVisible();
  await lead.context.close();
});

test('a drafted billet change changes nothing until it is saved, and says what moved since it was drafted', async ({ page, browser }) => {
  test.setTimeout(120_000);
  const lead = await leader(browser);
  await registerAs(page, unique('blt'));
  await joinUnit(lead.page.request, page.request);
  const me = (await (await page.request.get('/api/me')).json()).user;
  const H = { 'x-vantage-client': '1' };

  await lead.page.goto(`/team/${me.id}`);
  await lead.page.getByRole('button', { name: /’s assignment in G8$/ }).click();
  const dialog = lead.page.getByRole('dialog', { name: /billet and assignment/ });
  await expect(dialog).toContainText('Save draft keeps it to you and changes nothing. Save changes their assignment now, and their history records it.');
  await dialog.getByLabel('Billet', { exact: true }).fill('Budget Analyst');
  await dialog.getByLabel('Why (optional)').fill('PCS orders');
  await dialog.getByRole('button', { name: 'Save draft' }).click();
  await toast(lead.page, 'Saved to Drafts. Only you can see it, and nothing changes until you save it.');
  const strip = lead.page.getByRole('region', { name: /Your drafts/ });
  await expect(strip).toContainText('Assignment change: billet');
  const record = async () => (await (await page.request.get(`/api/org/team/${me.id}/personnel`)).json()) as { instances: Array<{ assignments: Array<{ billet: string | null }> }> };
  expect((await record()).instances[0].assignments[0].billet, 'a draft changes nothing').not.toBe('Budget Analyst');

  // Someone else changes the billet meanwhile; the draft says so when it is opened.
  const moved = await lead.page.request.put(`/api/org/units/G8/members/${me.id}`, { headers: H, data: { billet: 'Fiscal Clerk' } });
  expect(moved.ok(), await moved.text()).toBeTruthy();
  await lead.page.reload();
  await lead.page.getByRole('region', { name: /Your drafts/ }).getByRole('button', { name: /^Continue Assignment change/ }).click();
  const resumed = lead.page.getByRole('dialog', { name: /billet and assignment/ });
  await expect(resumed).toContainText('Since you saved this draft, someone changed their billet.');
  await expect(resumed.getByLabel('Billet', { exact: true })).toHaveValue('Budget Analyst');
  await expect(resumed.getByLabel('Why (optional)')).toHaveValue('PCS orders');
  expect(await axe(lead.page), 'a drafted change opened again').toEqual([]);
  await resumed.getByRole('button', { name: 'Save', exact: true }).click();
  await toast(lead.page, /Billet saved/);
  await expect(lead.page.getByRole('region', { name: /Your drafts/ })).toHaveCount(0);
  expect((await record()).instances[0].assignments[0].billet).toBe('Budget Analyst');
  await lead.context.close();
});

test('Drafts and a page with drafts fit a phone', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await registerAs(page, unique('drph'));
  const H = { 'x-vantage-client': '1' };
  const saved = await page.request.post('/api/drafts/forms', { headers: H, data: { kind: 'task', payload: { title: `Reconcile the GTCC report ${unique('t')}`, priority: 'high' } } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.goto('/work/tasks');
  await expect(page.getByRole('region', { name: /Your drafts/ })).toBeVisible();
  await noSidewaysScroll(page, 'tasks with a draft');
  expect(await axe(page), 'tasks with a draft, on a phone').toEqual([]);
  await page.goto('/record/drafts');
  await expect(page.getByRole('region', { name: /Waiting on you/ })).toBeVisible();
  await noSidewaysScroll(page, 'the Drafts page');
  expect(await axe(page), 'the Drafts page, on a phone').toEqual([]);
  await context.close();
});
