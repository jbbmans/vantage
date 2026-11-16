import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, joinUnit, loginAs, logout, registerAs, unique, OPERATOR } from './fixtures';

/**
 * Workflow messages and notifications (Task 24, ADR-0031). What is said is said on the record it is about: one Marine asks
 * another a question in a task's Discussion, choosing them from the people who can already read it. The person asked is
 * told in the bell, on Today and on the Notifications page under "Asked of you", answers on the record, and the asker
 * sees the answer and is told it came. A notice names the event, who and the record, never anybody's words. Discussion is
 * one of the three groups a person may turn off in Settings, and the choice holds. Every view reads cleanly to assistive
 * technology in both themes, including the open bell and the open person picker, and the Notifications page fits a phone.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
/** The page, or (with `within`) only that part of it, such as the bell's popover, which a page scan leaves out. */
const axe = async (page: Page, within?: string) => {
  const builder = within ? new AxeBuilder({ page }).include(within) : new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]');
  return serious((await builder.analyze()).violations);
};
const bothThemes = async (page: Page, what: string, within?: string) => {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    expect(await axe(page, within), `${what}, ${theme}`).toEqual([]);
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
};
const POPOVER = '[data-radix-popper-content-wrapper]';
const toast = (page: Page, text: string | RegExp) => expect(page.getByRole('status').filter({ hasText: text }).first()).toBeVisible();
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};
/** A panel by its heading: panels are sections headed by an h2. */
const panel = (page: Page, heading: string) => page.getByRole('heading', { level: 2, name: heading, exact: true }).locator('xpath=ancestor::section[1]');
const bellButton = (page: Page) => page.getByRole('button', { name: /^Notifications(, \d+ unread)?$/ });
const entryFor = (discussion: Locator, words: string) => discussion.getByRole('listitem').filter({ hasText: words }).first();

interface Notice { id: string; kind: string; group: string; title: string; message: string | null; label: string | null; read_at: string | null; action_url: string | null }
const notices = async (page: Page): Promise<Notice[]> => {
  const res = await page.request.get('/api/me/notifications?limit=100');
  expect(res.ok(), await res.text()).toBeTruthy();
  return (await res.json()).rows;
};

/** The G-8 operator (its Unit Leader), signed in on a page of their own: here only to seat people and set the task. */
async function leader(browser: Browser) {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await loginAs(page, OPERATOR.username);
  return { context, page };
}

/** A Marine in G-8, signed in on a page of their own. */
async function marine(browser: Browser, lead: Page, prefix: string, viewport?: { width: number; height: number }) {
  const context = await browser.newContext({ reducedMotion: 'reduce', ...(viewport ? { viewport } : {}) });
  const page = await context.newPage();
  const username = unique(prefix);
  await registerAs(page, username);
  await joinUnit(lead.request, page.request);
  const me = (await (await page.request.get('/api/me')).json()).user as { id: string };
  return { context, page, username, id: me.id, name: `${username.charAt(0).toUpperCase()}${username.slice(1)} Marine` };
}

/** A task the leader shares with G-8 and sets for one Marine: everyone in G-8 reads it, so its people can talk about it. */
async function sharedTask(lead: Page, assigneeId: string, title: string) {
  const made = await lead.request.post('/api/records/tasks', { headers: H, data: { title, visibility: 'unit', unit_id: 'G8', assignee_id: assigneeId } });
  expect(made.ok(), await made.text()).toBeTruthy();
  return (await made.json()).id as string;
}

test('a question asked through the picker reaches its person in the bell and Asked of you, and the answer comes back to the asker', async ({ browser }) => {
  test.setTimeout(180_000);
  const lead = await leader(browser);
  const asker = await marine(browser, lead.page, 'wma');
  const asked = await marine(browser, lead.page, 'wmb');
  const errors: string[] = [];
  for (const p of [asker.page, asked.page]) p.on('pageerror', (e) => errors.push(String(e.message)));
  const title = `Reconcile the October GTCC statement ${unique('t')}`;
  const taskId = await sharedTask(lead.page, asker.id, title);
  const question = `Which statement are you reconciling against, September or October? ${unique('q')}`;
  const answer = `October. The September statement closed on the 30th. ${unique('r')}`;

  // The asker opens the task they both read, and asks a question of one person, chosen from those who can read it.
  const a = asker.page;
  await a.goto(`/records/tasks/${taskId}`);
  await expect(a.getByRole('heading', { level: 1, name: title })).toBeVisible();
  const discussion = a.getByRole('heading', { level: 2, name: 'Discussion', exact: true }).locator('xpath=ancestor::section[1]');
  await discussion.locator('label').filter({ hasText: 'Ask a question' }).click();
  await expect(discussion.getByRole('radio', { name: 'Ask a question' })).toBeChecked();
  await expect(discussion).toContainText('Only people who can already see this record can be asked.');
  const whom = discussion.getByRole('combobox', { name: 'Ask whom' });
  await whom.fill(asked.username);
  const option = discussion.getByRole('option', { name: new RegExp(`${asked.name}.*@${asked.username}`) });
  await expect(option).toBeVisible();
  await expect(discussion.getByRole('listbox', { name: 'Ask whom' }).getByRole('option')).toHaveCount(1);
  await expect(whom).toHaveAttribute('aria-expanded', 'true');
  await bothThemes(a, 'the discussion with the person picker open');
  await expect(option, 'still open after the scans').toBeVisible();
  // By keyboard: Down onto the one person, Enter to choose them.
  await whom.press('ArrowDown');
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await expect(whom).toHaveAttribute('aria-activedescendant', /.+/);
  await whom.press('Enter');
  await expect(discussion.getByRole('button', { name: `Change who to ask, now LCpl ${asked.name}` })).toBeVisible();
  const box = discussion.getByLabel('Your question', { exact: true });
  await expect(box, 'back to the words once someone is chosen').toBeFocused();
  await box.fill(question);
  await discussion.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(discussion.getByRole('status').filter({ hasText: `Asked LCpl ${asked.name}. They are told, and their answer will show here.` })).toBeVisible();
  const mine = entryFor(discussion, question);
  await expect(mine).toContainText(`Question to LCpl ${asked.name}`);
  await expect(mine).toContainText('Open');
  await expect(mine.getByRole('button', { name: `Withdraw your question to LCpl ${asked.name}` }), 'only the asker withdraws').toBeVisible();
  await expect(box).toHaveValue('');

  // Today puts it under what the asker is waiting on.
  await a.goto('/');
  await expect(a.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  const waiting = a.getByRole('region', { name: 'You asked' });
  await expect(waiting).toContainText(title);
  await expect(waiting).toContainText(`You asked LCpl ${asked.name}`);

  // The person asked signs in: the bell has it, and so does Today.
  const b = asked.page;
  await logout(b);
  await loginAs(b, asked.username);
  await expect(b.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
  const yours = b.getByRole('region', { name: 'Asked of you' });
  await expect(yours).toContainText(title);
  await expect(yours).toContainText(`Asked by LCpl ${asker.name}`);
  const since = panel(b, 'Since you last looked');
  await expect(since.getByRole('link', { name: new RegExp(`${asker.name} asked you a question`) })).toContainText(title);

  await bellButton(b).click();
  const bell = b.getByRole('dialog', { name: 'Notifications' });
  await expect(bell).toBeVisible();
  const notice = bell.getByRole('link', { name: new RegExp(`${asker.name} asked you a question`) });
  await expect(notice).toContainText(title);
  await expect(notice).toContainText('New');
  await expect(notice, 'a notice never carries what was asked').not.toContainText(question);
  await bothThemes(b, 'the open bell', POPOVER);
  await bell.getByRole('link', { name: 'See all' }).click();
  await expect(b).toHaveURL(/\/notifications$/);
  await expect(bell).toHaveCount(0);
  await expect(b.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();

  // The Notifications page: the notice under Notices, the question itself under Asked of you.
  await expect(b.getByRole('tab', { name: /^Notices/ })).toHaveAttribute('aria-selected', 'true');
  const listed = b.getByRole('list', { name: 'Notices' }).getByRole('listitem').filter({ hasText: 'asked you a question' }).filter({ hasText: title });
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText('Asked of you');
  await expect(listed).not.toContainText(question);
  await bothThemes(b, 'Notifications, Notices');
  await b.getByRole('tab', { name: /^Asked of you \/ You asked/ }).click();
  await expect(b).toHaveURL(/tab=asked/);
  const askedOfYou = panel(b, 'Asked of you');
  const request = askedOfYou.getByRole('listitem').filter({ hasText: title });
  await expect(request).toContainText('Question');
  await expect(request).toContainText(question);
  await expect(request).toContainText(`Asked by LCpl ${asker.name}`);
  await expect(panel(b, 'You asked')).toContainText('You have not asked anyone');
  await bothThemes(b, 'Notifications, Asked of you / You asked');

  // They answer it on the record, where it was asked.
  await request.getByRole('link', { name: title }).click();
  await expect(b).toHaveURL(new RegExp(`/records/tasks/${taskId}$`));
  const theirs = b.getByRole('heading', { level: 2, name: 'Discussion', exact: true }).locator('xpath=ancestor::section[1]');
  const toThem = entryFor(theirs, question);
  await expect(toThem).toContainText('Question to you');
  await expect(toThem.getByRole('button', { name: /^Withdraw/ }), 'the person asked does not withdraw it').toHaveCount(0);
  await toThem.getByLabel(/^Your answer/).fill(answer);
  await toThem.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(theirs.getByRole('status').filter({ hasText: `Answered. LCpl ${asker.name} is told.` })).toBeVisible();
  await expect(toThem).toContainText('Answered');
  await expect(toThem.getByRole('list', { name: 'Answers to this question' })).toContainText(answer);
  await expect(toThem.getByLabel(/^Your answer/)).toHaveCount(0);

  // Answered, it waits on them no more, and its notice is taken back.
  await b.goto('/notifications?tab=asked');
  await expect(panel(b, 'Asked of you')).toContainText('Nothing is waiting on you');
  expect((await notices(b)).filter((n) => n.kind === 'clarification_request' && n.label === title)).toEqual([]);

  // The asker sees the answer on the record, and the bell says it came.
  await a.goto(`/records/tasks/${taskId}`);
  const back = entryFor(discussion, question);
  await expect(back).toContainText('Answered');
  await expect(back.getByRole('list', { name: 'Answers to this question' })).toContainText(answer);
  await expect(back.getByRole('button', { name: /^Withdraw/ }), 'an answered question is not withdrawn').toHaveCount(0);
  await bellButton(a).click();
  const theBell = a.getByRole('dialog', { name: 'Notifications' });
  const answered = theBell.getByRole('link', { name: new RegExp(`${asked.name} answered your question`) });
  await expect(answered).toContainText(title);
  await expect(answered).not.toContainText(answer);
  const told = (await notices(a)).find((n) => n.kind === 'request_answered' && n.label === title);
  expect(told, 'a request_answered notice').toBeTruthy();
  expect(told!.group).toBe('asked');
  expect(told!.message, 'no words in a notice about a record').toBeNull();
  expect(JSON.stringify((await notices(a)).filter((n) => n.label === title))).not.toContain(answer.slice(0, 20));
  // Following it opens the record and marks it read.
  await answered.click();
  await expect(theBell).toHaveCount(0);
  await expect(a).toHaveURL(new RegExp(`/records/tasks/${taskId}$`));
  await expect.poll(async () => (await notices(a)).find((n) => n.id === told!.id)?.read_at ?? null).not.toBeNull();

  // What they asked, and how it ended, under You asked.
  await a.goto('/notifications?tab=asked');
  const sent = panel(a, 'You asked').getByRole('listitem').filter({ hasText: title });
  await expect(sent).toContainText('Question');
  await expect(sent).toContainText('Answered');
  await expect(sent).toContainText(`You asked LCpl ${asked.name}`);
  await expect(panel(a, 'Asked of you')).toContainText('Nothing is waiting on you');

  expect(errors).toEqual([]);
  for (const c of [lead.context, asker.context, asked.context]) await c.close();
});

test('Discussion can be turned off and on in Settings, the choice holds after a reload, and it decides whether comments are told', async ({ browser }) => {
  test.setTimeout(150_000);
  const lead = await leader(browser);
  const me = await marine(browser, lead.page, 'wmc');
  const page = me.page;
  const title = `Draft the travel claim checklist ${unique('t')}`;
  const taskId = await sharedTask(lead.page, me.id, title);
  const comment = (body: string) => lead.page.request.post(`/api/records/tasks/${taskId}/comments`, { headers: H, data: { body } });
  const commented = async () => (await notices(page)).filter((n) => n.kind === 'comment_added' && n.label === title);
  const muted = async () => ((await (await page.request.get('/api/me/prefs')).json()).notifications?.muted ?? []) as string[];

  await page.goto('/settings?tab=notifications');
  await expect(page.getByRole('tab', { name: 'Notifications' })).toHaveAttribute('aria-selected', 'true');
  const told = panel(page, 'What you are told');
  const discussion = told.getByRole('switch', { name: /^Discussion/ });
  await expect(discussion).toHaveAttribute('aria-checked', 'true');
  await expect(told.getByRole('switch', { name: /^Work updates/ })).toHaveAttribute('aria-checked', 'true');
  await expect(told.getByRole('switch', { name: /^Announcements/ })).toHaveAttribute('aria-checked', 'true');
  // What they are asked to do, or must know, always arrives: no switch for it.
  await expect(told.getByRole('switch')).toHaveCount(3);
  await expect(told.getByRole('switch', { name: /^Asked of you/ })).toHaveCount(0);
  await expect(told.getByText('Always arrives', { exact: true })).toHaveCount(6);

  // Off, and still off after a reload; comments on their task tell them nothing.
  await discussion.click();
  await toast(page, 'Discussion turned off.');
  await expect(discussion).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(discussion, 'still off after a reload').toHaveAttribute('aria-checked', 'false');
  await expect(told.getByRole('switch', { name: /^Work updates/ }), 'the others are untouched').toHaveAttribute('aria-checked', 'true');
  expect(await muted()).toContain('discussion');
  expect((await comment('Use the JTR checklist from last quarter.')).ok()).toBeTruthy();
  expect(await commented(), 'Discussion is off').toEqual([]);

  // On again, by keyboard, and still on after a reload; the next comment tells them.
  await discussion.focus();
  await page.keyboard.press('Space');
  await toast(page, 'Discussion turned on.');
  await expect(discussion).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(discussion, 'still on after a reload').toHaveAttribute('aria-checked', 'true');
  expect(await muted()).not.toContain('discussion');
  expect((await comment('And attach the receipts as one PDF.')).ok()).toBeTruthy();
  await expect.poll(async () => (await commented()).length).toBe(1);
  // The whole tab as a Marine new to Vantage has it: no email yet, so the weekly digest cannot be turned on.
  await expect(page.getByText('Add an email in Profile first.')).toBeVisible();
  await bothThemes(page, 'Settings, Notifications');

  await page.goto('/notifications');
  const listed = page.getByRole('list', { name: 'Notices' }).getByRole('listitem').filter({ hasText: `${OPERATOR.first_name} ${OPERATOR.last_name} commented` }).filter({ hasText: title });
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText('Discussion');
  await expect(listed, 'a notice never carries what was said').not.toContainText('receipts');
  for (const c of [lead.context, me.context]) await c.close();
});

test('Notifications fits a phone: both tabs, the bell and the record the question is on', async ({ browser }) => {
  test.setTimeout(120_000);
  const lead = await leader(browser);
  const asker = await marine(browser, lead.page, 'wmd');
  const phone = await marine(browser, lead.page, 'wme', { width: 390, height: 844 });
  const title = `Count the CTA cards in the safe ${unique('t')}`;
  const taskId = await sharedTask(lead.page, asker.id, title);
  const question = `Do the cards in the second drawer count toward the total? ${unique('q')}`;
  const sent = await asker.page.request.post(`/api/records/tasks/${taskId}/requests`, { headers: H, data: { kind: 'clarification_request', addressee_id: phone.id, body: question } });
  expect(sent.ok(), await sent.text()).toBeTruthy();
  const page = phone.page;

  await page.goto('/notifications');
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Notices' }).getByRole('listitem').filter({ hasText: title })).toContainText('asked you a question');
  await noSidewaysScroll(page, 'Notifications, Notices, at 390px');
  expect(await axe(page), 'Notifications, Notices, on a phone').toEqual([]);

  await page.getByRole('tab', { name: /^Asked of you \/ You asked/ }).click();
  const request = panel(page, 'Asked of you').getByRole('listitem').filter({ hasText: title });
  await expect(request).toContainText(question);
  await noSidewaysScroll(page, 'Notifications, Asked of you, at 390px');
  expect(await axe(page), 'Notifications, Asked of you, on a phone').toEqual([]);

  // The bell opens inside the screen.
  await bellButton(page).click();
  const bell = page.getByRole('dialog', { name: 'Notifications' });
  await expect(bell.getByRole('link', { name: /asked you a question/ }).first()).toBeVisible();
  const box = await bell.boundingBox();
  expect(box, 'the bell has a box').toBeTruthy();
  expect(box!.x, 'the bell starts on the screen').toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, 'the bell ends on the screen').toBeLessThanOrEqual(390 + 1);
  await noSidewaysScroll(page, 'the open bell at 390px');
  expect(await axe(page, POPOVER), 'the open bell, on a phone').toEqual([]);
  await page.keyboard.press('Escape');
  await expect(bell).toHaveCount(0);

  // The record it is asked on, with the answer waiting to be written.
  await request.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/records/tasks/${taskId}$`));
  const discussion = page.getByRole('heading', { level: 2, name: 'Discussion', exact: true }).locator('xpath=ancestor::section[1]');
  await expect(entryFor(discussion, question).getByLabel(/^Your answer/)).toBeVisible();
  await noSidewaysScroll(page, 'a question to answer at 390px');
  for (const c of [lead.context, asker.context, phone.context]) await c.close();
});
