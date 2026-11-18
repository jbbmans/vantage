import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { ensureSetup, instanceDay, joinUnit, loginAs, registerAs, unique, OPERATOR } from './fixtures';

/**
 * Tutorials (Task 26, ADR-0034): short, one task each, offered in a line under the title of the page the task is done on,
 * and in Help → Field guide and the command palette. A tutorial opens beside the page, not over it; it says where each
 * step happens, takes you there, and shows you the control; it stays open from page to page and across a reload, and a
 * finished one is kept in the person's settings. Who it is offered to follows the menu and the person's permissions.
 */
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const panelOf = (page: Page, title: string) => page.getByRole('complementary', { name: title });
const prompt = (page: Page) => page.locator('[data-tutorial-prompt]');
const current = (page: Page, title: string) => panelOf(page, title).locator('li[aria-current="step"]');

async function settle(page: Page) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** The panel can fold itself down to show a control it would cover; open it again to reach its buttons. */
async function unfold(page: Page, title: string) {
  const show = panelOf(page, title).getByRole('button', { name: 'Show the tutorial’s steps' });
  if (await show.isVisible()) await show.click();
}

test('a page offers its tutorial under the title, and the tutorial leads through the task beside the page', async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, OPERATOR.username);
  await page.goto('/record/activities');
  await settle(page);

  // ——— Offered in one line under the title; nothing opens by itself ———
  await expect(panelOf(page, 'Logging work')).toHaveCount(0);
  const offer = prompt(page).getByRole('button', { name: /^Logging work, \d+ steps/ });
  await expect(offer).toBeVisible();
  await offer.click();

  // ——— Opened: not a dialog, its heading takes focus, and the page stays usable ———
  const panel = panelOf(page, 'Logging work');
  await expect(panel).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: 'Logging work' })).toBeFocused();
  await expect(panel).toContainText('Tutorial · step 1 of');
  await expect(current(page, 'Logging work')).toContainText('Log an activity');

  // ——— Show me: the control is outlined and takes focus ———
  await current(page, 'Logging work').getByRole('button', { name: 'Show me', exact: true }).click();
  const logButton = page.getByRole('button', { name: 'Log activity', exact: true }).first();
  await expect(logButton).toBeFocused();
  await expect(logButton).toHaveClass(/tutorial-spot/);

  // ——— A form open over the page: the tutorial says it waits, and its step stays readable ———
  await logButton.click();
  const quick = page.getByRole('dialog', { name: 'Log activity' });
  await expect(quick).toBeVisible();
  await expect(panel).toContainText('The tutorial waits while a window or menu is open.');
  await expect(panel).toContainText('Choose Log activity, or press N');
  await page.keyboard.press('Escape');
  await expect(quick).toBeHidden();
  await expect(panel).not.toContainText('The tutorial waits');

  // ——— Any step can be opened; one on another page says where it is and goes there ———
  await unfold(page, 'Logging work');
  await panel.getByRole('button', { name: /See credit for casework/ }).click();
  const last = current(page, 'Logging work');
  await expect(last).toContainText('See credit for casework');
  await last.getByRole('button', { name: /^Go to / }).click();
  await expect(page).toHaveURL(/\/record\/contributions$/);
  await expect(last).toContainText('You are on this step’s page.');
  // The button that was pressed is gone; focus waits on the tutorial's heading, not on the page's top.
  await expect(panel.getByRole('heading', { name: 'Logging work' })).toBeFocused();

  // ——— A reload keeps the tutorial at the same step, and leaves focus where the page puts it ———
  await page.reload();
  await settle(page);
  await expect(current(page, 'Logging work')).toContainText('See credit for casework');
  await expect(panelOf(page, 'Logging work').getByRole('heading', { name: 'Logging work' })).not.toBeFocused();

  // ——— Finish keeps it in the person's settings, and the line marks it finished ———
  await panelOf(page, 'Logging work').getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(panelOf(page, 'Logging work')).toContainText('Tutorial finished');
  await expect.poll(async () => ((await (await page.request.get('/api/me/prefs')).json()).tutorials?.done ?? []) as string[]).toContain('logging-work');
  // ——— Other tutorials takes focus to the list in Help ———
  await panelOf(page, 'Logging work').getByRole('link', { name: 'Other tutorials' }).click();
  await expect(panelOf(page, 'Logging work')).toHaveCount(0);
  await expect(page).toHaveURL(/\/help#tutorials$/);
  await expect(page.locator('#tutorials').getByRole('heading', { name: 'Tutorials' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Take again: Logging work' })).toBeVisible();
  // Help writes its search into the address only when the address does not already say it, so #tutorials stays.
  await page.waitForTimeout(400);
  await expect(page).toHaveURL(/\/help#tutorials$/);
  await page.goto('/record/activities');
  await settle(page);
  await expect(prompt(page).getByRole('button', { name: /^Logging work, \d+ steps, finished$/ })).toBeVisible();
});

test('the keyboard opens, moves through and closes a tutorial, and focus goes back to where it was', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.goto('/career/training');
  await settle(page);
  const offer = prompt(page).getByRole('button', { name: /^Training, \d+ steps/ });
  await offer.focus();
  await page.keyboard.press('Enter');
  const panel = panelOf(page, 'Training');
  await expect(panel.getByRole('heading', { name: 'Training' })).toBeFocused();
  // Tab reaches the panel's own controls in order: fold, close, then the steps.
  await page.keyboard.press('Tab');
  await expect(panel.getByRole('button', { name: 'Fold the tutorial down' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Show the tutorial’s steps' })).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: 'Fold the tutorial down' })).toHaveAttribute('aria-expanded', 'true');
  await panel.getByRole('button', { name: 'Next', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(panel).toContainText('Tutorial · step 2 of');
  // Back on the first step is marked, not disabled, so it keeps focus.
  await panel.getByRole('button', { name: 'Back', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(panel).toContainText('Tutorial · step 1 of');
  await expect(panel.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
  await expect(panel.getByRole('button', { name: 'Back', exact: true })).toHaveAttribute('aria-disabled', 'true');
  await panel.getByRole('button', { name: 'Close the tutorial' }).focus();
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(offer).toBeFocused();
});

test('Help, search and the command palette offer every tutorial; the line under titles can be turned off', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.goto('/help');
  await settle(page);
  const list = page.locator('#tutorials');
  await expect(list.getByRole('heading', { name: 'Tutorials' })).toBeVisible();
  for (const title of ['Getting started', 'Logging work', 'Personnel', 'Import and export', 'Error reports', 'Case diagnosis', 'Duty', 'Training', 'Counselings', 'Reports', 'Analytics']) {
    await expect(list.getByRole('button', { name: new RegExp(`^(Start|Take again): ${title}$`) })).toBeVisible();
  }

  // Search finds a tutorial by the words of its steps, above the answers.
  await page.getByLabel('Search the field guide').fill('acknowledge');
  await expect(page.getByRole('button', { name: /^(Start|Take again): Counselings$/ })).toBeVisible();

  // Started from the results and finished there, Other tutorials gives the search way to the whole list.
  await page.getByRole('button', { name: /^(Start|Take again): Counselings$/ }).click();
  const lesson = panelOf(page, 'Counselings');
  await lesson.locator('ol > li').last().getByRole('button').first().click();
  await lesson.getByRole('button', { name: 'Finish', exact: true }).click();
  await lesson.getByRole('link', { name: 'Other tutorials' }).click();
  await expect(page.locator('#tutorials').getByRole('heading', { name: 'Tutorials' })).toBeFocused();
  await expect(page.getByLabel('Search the field guide')).toHaveValue('');

  // The palette names each tutorial, and opening one puts focus in it.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Tutorial: Duty');
  await page.getByRole('option', { name: /^Tutorial: Duty/ }).click();
  const panel = panelOf(page, 'Duty');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Duty' })).toBeFocused();
  await panel.getByRole('button', { name: 'Close the tutorial' }).click();

  // Off in Settings, the line goes from every page; Help still lists them all.
  await page.goto('/settings?tab=appearance');
  await settle(page);
  const offerSwitch = page.getByRole('switch', { name: /Offer a page’s tutorial under its title/ });
  await expect(offerSwitch).toHaveAttribute('aria-checked', 'true');
  await offerSwitch.click();
  await expect(offerSwitch).toHaveAttribute('aria-checked', 'false');
  await page.goto('/record/activities');
  await settle(page);
  await expect(prompt(page)).toHaveCount(0);
  await page.goto('/help');
  await settle(page);
  await expect(page.locator('#tutorials').getByRole('button', { name: /^(Start|Take again): Logging work$/ })).toBeVisible();
  await page.goto('/settings?tab=appearance');
  await page.getByRole('switch', { name: /Offer a page’s tutorial under its title/ }).click();
  await expect(page.getByRole('switch', { name: /Offer a page’s tutorial under its title/ })).toHaveAttribute('aria-checked', 'true');
  await page.goto('/record/activities');
  await expect(prompt(page)).toBeVisible();
});

test('Other tutorials clears a search typed a moment before, even as Help writes that search into the address', async ({ page }) => {
  // Help puts its search in the address 250 ms after typing stops, by replacing the history entry. The router lands a
  // navigation in a transition, so a write falling due just after Other tutorials was pressed used to replace the entry
  // Other tutorials had pushed, and the search stayed. Each round catches that write and makes it fall due at one exact
  // moment: just after the press (from /help, and from /help#tutorials, where the press pushes the same address again),
  // and just before it.
  await loginAs(page, OPERATOR.username);
  await page.goto('/help');
  for (const round of ['in flight, from /help', 'in flight, from /help#tutorials', 'written first'] as const) {
    await settle(page);
    await page.getByRole('button', { name: /^(Start|Take again): Counselings$/ }).click();
    const lesson = panelOf(page, 'Counselings');
    await lesson.locator('ol > li').last().getByRole('button').first().click();
    await lesson.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(lesson.getByRole('link', { name: 'Other tutorials' })).toBeVisible();
    await page.evaluate(async (order) => {
      const input = document.querySelector<HTMLInputElement>('input[aria-label="Search the field guide"]')!;
      const link = [...document.querySelectorAll('a')].find((a) => a.textContent === 'Other tutorials')!;
      const arm = window.setTimeout;
      let write: { id: number; fn: () => void } | undefined;
      window.setTimeout = ((fn: () => void, ms?: number) => { const id = arm(fn, ms); if (ms === 250) write = { id, fn }; return id; }) as typeof window.setTimeout;
      try {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'acknowledge');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => arm(r, 0));
      } finally { window.setTimeout = arm; }
      if (!write) throw new Error('Help armed no write for its search');
      window.clearTimeout(write.id);
      if (order === 'written first') { write.fn(); link.click(); } else { link.click(); write.fn(); }
    }, round);
    await expect(page.locator('#tutorials').getByRole('heading', { name: 'Tutorials' }), round).toBeFocused();
    await expect(page.getByLabel('Search the field guide'), round).toHaveValue('');
    await page.waitForTimeout(400);
    await expect(page, round).toHaveURL(/\/help#tutorials$/);
    await expect(page.getByLabel('Search the field guide'), round).toHaveValue('');
  }
});

test('a Marine with no unit is offered only what they can do, and a leader’s steps are not theirs', async ({ page }) => {
  await registerAs(page, unique('tut'));
  await page.goto('/help');
  await settle(page);
  const list = page.locator('#tutorials');
  await expect(list.getByRole('button', { name: 'Start: Getting started' })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Start: Logging work' })).toBeVisible();
  for (const title of ['Personnel', 'Duty', 'Error reports']) await expect(list.getByRole('button', { name: `Start: ${title}` })).toHaveCount(0);
  await page.getByLabel('Search the field guide').fill('roster');
  await expect(page.getByRole('button', { name: 'Start: Personnel' })).toHaveCount(0);

  // Counselings: a Marine reads, acknowledges and prints; writing one for a Marine is a leader's step.
  await page.goto('/career/counseling');
  await settle(page);
  await prompt(page).getByRole('button', { name: /^Counselings, \d+ steps/ }).click();
  const panel = panelOf(page, 'Counselings');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: /Acknowledge it once it is final/ })).toBeVisible();
  await expect(panel.getByRole('button', { name: /Write a counseling for a Marine/ })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /Take a draft to final/ })).toHaveCount(0);
});

for (const size of [{ name: 'desktop 1280', width: 1280, height: 800 }, { name: 'phone 320', width: 320, height: 640 }]) {
  test(`an open tutorial passes WCAG 2.2 AA at ${size.name}, light and dark, and fits the screen`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await loginAs(page, OPERATOR.username);
    await page.goto('/record/activities');
    await settle(page);
    await prompt(page).getByRole('button', { name: /^Logging work, \d+ steps/ }).click();
    const panel = panelOf(page, 'Logging work');
    await expect(panel).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      const results = await new AxeBuilder({ page }).withTags(TAGS).exclude('[data-radix-popper-content-wrapper]').analyze();
      expect(results.violations.map((v) => `${v.id} [${v.impact}] ${v.nodes.slice(0, 3).map((n) => JSON.stringify(n.target)).join(' ')}`), `${theme} at ${size.name}`).toEqual([]);
    }
    const box = await panel.boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= size.width + 1, 'the panel fits the width').toBeTruthy();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'no sideways scroll').toBeLessThanOrEqual(1);
    // On a phone the panel stays above the tab bar, and the page can still scroll out from under it.
    if (size.width < 640) {
      const bar = await page.locator('nav.tabbar').boundingBox();
      if (bar) expect(box!.y + box!.height, 'the panel sits above the tab bar').toBeLessThanOrEqual(bar.y + 1);
    }
  });
}

// ——— Every step, as the person it is offered to sees it ———

interface Step { title: string; at: string; anchor?: string; control?: string }
/** The registry's steps by tutorial title, read from its source as the file is written: each step an object of its own. */
function registry(): Map<string, Step[]> {
  const source = readFileSync(new URL('../../src/config/tutorials.ts', import.meta.url), 'utf8');
  const out = new Map<string, Step[]>();
  let tutorial: string | null = null;
  let block: string[] | null = null;
  for (const line of source.split('\n')) {
    const head = line.match(/^ {4}title: '([^']+)',$/);
    if (head) { tutorial = head[1]; out.set(tutorial, []); continue; }
    if (/^ {6}\{$/.test(line)) { block = []; continue; }
    if (block && /^ {6}\},?$/.test(line)) {
      const text = block.join(' ');
      const field = (name: string) => text.match(new RegExp(`\\b${name}: '([^']+)'`))?.[1];
      if (tutorial && field('title') && field('at')) out.get(tutorial)!.push({ title: field('title')!, at: field('at')!, anchor: field('anchor'), control: field('control') });
      block = null;
      continue;
    }
    block?.push(line);
  }
  return out;
}

/** Whether a locator shows within a moment: a page draws after its data arrives. */
async function shows(locator: Locator, ms = 3000) {
  try { await expect(locator).toBeVisible({ timeout: ms }); return true; } catch { return false; }
}

/**
 * Controls that are on their page only once there are records of a kind this test does not make: a filed error report,
 * a case, a duty, a counseling, a package, a run report, a chart with figures, a Marine's training. Their tags are checked
 * in the source (tests/server/tutorials.test.ts) and their pages here; "Show me" says plainly when one is not there yet.
 */
const NEEDS_RECORDS = new Set([
  'error-reports-series', 'error-reports-compare', 'error-reports-figure', 'diagnoser-open-case',
  'duty-view', 'duty-suggestion-record', 'duty-approve', 'member-training-open', 'counseling-acknowledge', 'counseling-share',
  'package-cite', 'package-section', 'package-save', 'report-print', 'figure-records', 'figure-table', 'personnel-change',
]);

test('every step offered to a unit leader is on the page it names, with the control it names', async ({ page, browser }) => {
  test.setTimeout(600_000);
  await loginAs(page, OPERATOR.username);
  // What the steps point at: a Marine on the roster, an activity and a training of the leader's own.
  const context = await browser.newContext();
  const marinePage = await context.newPage();
  await registerAs(marinePage, unique('tutm'));
  await joinUnit(page.request, marinePage.request);
  const marineId = (await (await marinePage.request.get('/api/me')).json()).user.id as string;
  await context.close();
  expect((await page.request.post('/api/records/activities', { headers: H, data: { title: `Reconciled the ULO list ${unique('t')}`, date: instanceDay(2) } })).ok()).toBeTruthy();
  expect((await page.request.post('/api/records/trainings', { headers: H, data: { title: `Fiscal law refresher ${unique('t')}`, type: 'pme', status: 'completed', date: instanceDay(3), hours: 4, provider: 'SNCO Academy', visibility: 'private' } })).ok()).toBeTruthy();

  const steps = registry();
  await page.goto('/help');
  await settle(page);
  const offered = (await page.locator('#tutorials li').getByRole('button', { name: /^(Start|Take again): / }).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')!.replace(/^(Start|Take again): /, ''))));
  expect(offered.length, 'tutorials offered to the unit leader').toBeGreaterThanOrEqual(11);

  const problems: string[] = [];
  const skipped: string[] = [];
  const notYet: string[] = [];
  for (const title of offered) {
    const known = steps.get(title);
    if (!known) { problems.push(`${title}: not in the registry`); continue; }
    await page.goto('/help');
    await settle(page);
    await page.locator('#tutorials').getByRole('button', { name: new RegExp(`^(Start|Take again): ${title}$`) }).click();
    const panel = panelOf(page, title);
    await expect(panel).toBeVisible();
    const count = Number((await panel.locator('.eyebrow').textContent())!.match(/of (\d+)/)![1]);
    const spot = page.locator('.tutorial-spot');
    const drawn = () => expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
    // "Show me", or arriving by "Go to": the control is outlined, or the step says it is not there yet. Then, a moment
    // later, the panel folds if it covers the control; the walk waits that moment out so it never races the fold.
    const outcome = async (): Promise<'spot' | 'missing' | null> => {
      try { await expect(spot.or(current(page, title).getByText('is not on the page as it is now')).first()).toBeVisible({ timeout: 5000 }); } catch { return null; }
      await page.waitForTimeout(600);
      return (await spot.count()) ? 'spot' : 'missing';
    };
    for (let i = 0; i < count; i += 1) {
      await unfold(page, title);
      const li = current(page, title);
      const name = (await li.locator('button').first().innerText()).replace(/^\d+\s*/, '').trim();
      const step = known.find((s) => s.title === name);
      if (!step) { problems.push(`${title} → ${name}: not in the registry`); break; }
      const where = `${title} → ${step.title}`;
      const param = step.at.includes(':id');
      const go = li.getByRole('button', { name: /^Go to / });
      if (await go.isVisible()) {
        await go.click();
        await drawn();
        if (step.anchor && !param) await outcome();
      }
      // A Marine's page is reached from the roster; a case from the queue, and this test files no case.
      if (param && !step.at.startsWith('/team/:id')) { skipped.push(where); }
      else {
        if (param) { await page.goto(step.at.replace(':id', marineId)); await drawn(); }
        await unfold(page, title);
        if (step.anchor) {
          const show = current(page, title).getByRole('button', { name: 'Show me', exact: true });
          if (!(await shows(show))) problems.push(`${where}: no Show me at ${page.url()} (the step's page did not match)`);
          else {
            await show.click();
            const got = await outcome();
            if (got === 'spot') {
              const said = await spot.first().evaluate((el) => [el.getAttribute('aria-label'), el.getAttribute('title'), el.textContent,
                ...Array.from(el.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label'))].filter(Boolean).join(' '));
              if (step.control && !said.toLowerCase().includes(step.control.toLowerCase())) problems.push(`${where}: "${step.anchor}" reads "${said.slice(0, 80)}", not "${step.control}"`);
            } else if (got === null) problems.push(`${where}: Show me did nothing`);
            else if (NEEDS_RECORDS.has(step.anchor)) notYet.push(where);
            else problems.push(`${where}: "${step.anchor}" is not on ${page.url()}`);
          }
        } else if (!(await shows(current(page, title).getByText('You are on this step’s page.')))) {
          problems.push(`${where}: not on its page at ${page.url()}`);
        }
      }
      await unfold(page, title);
      if (i < count - 1) await panel.getByRole('button', { name: 'Next', exact: true }).click();
      else await panel.getByRole('button', { name: 'Finish', exact: true }).click();
    }
    await expect(panel).toContainText('Tutorial finished');
    await panel.getByRole('button', { name: 'Close', exact: true }).click();
  }
  test.info().annotations.push({ type: 'skipped steps', description: skipped.join('; ') || 'none' }, { type: 'controls not there yet', description: notYet.join('; ') || 'none' });
  expect(problems).toEqual([]);
});
