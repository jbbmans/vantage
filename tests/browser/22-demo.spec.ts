import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * The flagship journey, in the synthetic demo, on the real application: open without a sign-in
 * form, claim a 2-Way UMT, research it, calculate, decide, hand it off, see both contributors, draft
 * a private accomplishment, capture a personal activity, move a goal, add a career step, and look at
 * the section as its lead.
 */

const PORT = 8798;
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;

test.describe.configure({ mode: 'serial' });
test.use({ baseURL: BASE });

test.beforeAll(async () => {
  server = spawn(process.execPath, ['tests/browser/demo-server.ts'], { env: { ...process.env, VANTAGE_DEMO_PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('demo server did not start');
});
test.afterAll(() => { server?.kill(); });

const todayHeading = (page: Page) => page.getByRole('heading', { name: 'Today', exact: true });
/**
 * Waits for every entrance animation to finish, so axe measures the page a person reads rather than
 * a frame of a fade. Ambient effects that loop forever (beams, live dots, the background light) are
 * not waited for; they never carry text.
 */
const settled = async (page: Page) => {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  await expect(page.locator('[data-motion="running"]')).toHaveCount(0);
};
const serious = (v: Array<{ id: string; impact?: string | null; nodes: unknown[] }>) => v.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id} (${x.nodes.length})`);

test('the demo opens on Today with no sign-in form and one clear synthetic indicator', async ({ page }) => {
  await page.goto('/');
  await expect(todayHeading(page)).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  const banner = page.getByRole('region', { name: 'Synthetic demo' });
  await expect(banner).toContainText('LCpl Jordan Avery');
  await expect(page.getByRole('link', { name: 'Owner console' })).toHaveCount(0);
  // Reload keeps the same synthetic person rather than starting another workspace.
  await page.reload();
  await expect(banner).toContainText('LCpl Jordan Avery');
});

test('a Marine claims, researches, calculates, decides, hands off, and keeps a private draft', async ({ page }) => {
  await page.goto('/work');
  await page.getByRole('button', { name: 'Open to claim', exact: true }).click();
  await page.getByText('SYN-26-P-0047').first().click();
  await expect(page).toHaveURL(/\/work\/items\//);
  // The URL changes before the item page has rendered; wait for the page itself.
  await expect(page.getByText('Who worked this')).toBeVisible();
  const itemUrl = page.url();
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(page.getByText(/It is on your assigned list now/)).toBeVisible();

  // Claimed work is on the Record at once, and is not credit.
  await page.goto('/record');
  await expect(page.getByText('SYN-26-P-0047')).toBeVisible();
  await page.goto(itemUrl);

  await page.getByLabel('Current award amount').fill('91,250.00');
  await page.getByLabel('Invoice amount').fill('45,000.00');
  await page.getByRole('button', { name: '+ Add another' }).click();
  await page.getByLabel('Invoice 2').fill('44,725.00');
  await page.getByRole('button', { name: 'Record what you found' }).click();
  await expect(page.getByText('3 values recorded.')).toBeVisible();
  await page.getByLabel('Requisition funding available').fill('1,500.00');
  await page.getByRole('button', { name: 'Record what you found' }).click();
  await page.getByRole('button', { name: 'Calculate the candidate', exact: true }).click();

  const calc = page.getByRole('region', { name: 'Candidate calculation' }).or(page.locator('section', { hasText: 'Candidate calculation' })).first();
  await expect(calc).toContainText('$89,725.00');
  await expect(calc).toContainText('$94,025.00');
  await expect(calc).toContainText('+$2,775.00');
  await expect(calc).toContainText('From the imported source file');
  await expect(calc).toContainText('Candidate only');

  await page.getByLabel('Amend the requisition first').check();
  await page.getByLabel('Why').fill('Requisition shows $1,500.00 available against a candidate increase of $2,775.00.');
  await page.getByRole('button', { name: 'Record the decision' }).click();
  await expect(page.getByRole('heading', { name: 'Amend the requisition' })).toBeVisible();

  // Hand it to the section lead with a note.
  await page.getByRole('button', { name: 'Hand off' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hand this off' });
  await dialog.getByRole('combobox', { name: 'To', exact: true }).click();
  await page.getByRole('option', { name: /Morgan Diaz/ }).click();
  await dialog.getByLabel('What they need to know').fill('Research and decision recorded. The requisition amendment is next.');
  await dialog.getByRole('button', { name: 'Hand off' }).click();
  await expect(page.getByText('Handed off.')).toBeVisible();
  await expect(page.getByText(/handed this to/)).toBeVisible();

  // The lead records the amendment; both people now show, each with their own work.
  await page.getByRole('button', { name: 'View as the section lead' }).click();
  await expect(todayHeading(page)).toBeVisible();
  await page.goto(itemUrl);
  await page.getByLabel('Reference').first().fill('SYN-REQ-AMD-1');
  await page.getByRole('button', { name: 'Record as submitted' }).click();
  await expect(page.getByText(/Submitted is not approved/)).toBeVisible();
  const who = page.locator('section', { hasText: 'Who worked this' }).first();
  await expect(who).toContainText('LCpl Jordan Avery');
  await expect(who).toContainText('You');

  // Back as the Marine: the draft uses only her own facts, and stays private.
  await page.getByRole('button', { name: 'View as the Marine' }).click();
  await expect(todayHeading(page)).toBeVisible();
  await page.goto(itemUrl);
  await page.getByRole('button', { name: 'Prepare a private draft from my work' }).click();
  await expect(page).toHaveURL(/\/record\?tab=drafts/);
  await expect(page.getByText(/Recorded current award amount: \$91,250\.00/)).toBeVisible();
  await expect(page.getByText(/No leader, reviewer or administrator can open them/)).toBeVisible();
  await page.getByRole('button', { name: 'Keep in my record' }).click();
  await expect(page.getByText('Kept in your record as a private entry.')).toBeVisible();
});

test('personal value: quick capture, a goal update, and a career step', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('What did you do?').first().fill('Volunteered 4 hours at the base food pantry');
  await page.getByRole('button', { name: 'Capture it' }).click();
  const log = page.getByRole('dialog', { name: 'Log activity' });
  await log.getByRole('button', { name: 'Save activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Activity logged.' })).toBeVisible();
  await page.goto('/record?tab=entries');
  await expect(page.getByRole('link', { name: /Volunteered 4 hours/ })).toBeVisible();

  await page.goto('/goals');
  const pft = page.locator('article, .card', { hasText: 'Raise PFT score to 270' }).first();
  await pft.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog');
  await edit.getByLabel('Current').fill('252');
  await edit.getByRole('button', { name: /Save/ }).click();
  await expect(pft).toContainText('252');

  await page.goto('/career');
  await page.getByRole('button', { name: 'Add a step' }).click();
  const step = page.getByRole('dialog', { name: 'Add a next step' });
  await step.getByLabel('Step').fill('Enroll in Sergeants Course DEP');
  await step.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Enroll in Sergeants Course DEP')).toBeVisible();
  await expect(page.getByText('Not verified').first()).toBeVisible();
});

test('the section lead sees workload with its definitions and limits', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'View as the section lead' }).click();
  await expect(page.getByRole('heading', { name: 'G-8 BE' })).toBeVisible();
  await page.goto('/team?tab=workload');
  const table = page.getByRole('table', { name: /Workload and recorded contributions by person/ });
  await expect(table).toContainText('Cpl Riley Chen');
  await expect(table).toContainText('PFC Casey Brooks');
  await page.getByText('How to read these numbers').click();
  await expect(page.getByText('Zero recorded activity is not evidence of zero work.')).toBeVisible();
});

test('demo pages have no serious accessibility violations in either theme', async ({ page }) => {
  await page.goto('/');
  await expect(todayHeading(page)).toBeVisible();
  const item = (await (await page.request.get('/api/work/items?q=SYN-26-P-0047')).json()).items[0].id;
  for (const theme of ['light', 'dark']) {
    for (const path of ['/', '/work', `/work/items/${item}`, '/record', '/record?tab=contributions', '/career', '/goals']) {
      await page.goto(path);
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await page.waitForLoadState('networkidle');
      await settled(page);
      const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
      expect(serious(results.violations), `${path} in ${theme}`).toEqual([]);
    }
  }
});

test('the main screens fit phone, tablet and desktop widths without sideways scrolling', async ({ page }) => {
  await page.goto('/');
  await expect(todayHeading(page)).toBeVisible();
  const item = (await (await page.request.get('/api/work/items?q=SYN-26-P-0047')).json()).items[0].id;
  for (const [w, h] of [[1440, 900], [1280, 800], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const path of ['/', '/work', `/work/items/${item}`, '/record', '/career']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${path} at ${w}px`).toBeLessThanOrEqual(1);
    }
  }
});
