import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * The motion policy (src/lib/motion.ts), checked on the real application in the synthetic demo:
 *
 *  - motion follows a change the person made, and opening a page that already holds that change
 *    plays nothing;
 *  - a figure is exact on every frame, including mid-animation;
 *  - with reduced motion requested, none of the four libraries moves anything, and the same
 *    figures and states are there;
 *  - the settled page passes axe either way.
 */

const PORT = 8799;
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

const serious = (v: Array<{ id: string; impact?: string | null; nodes: unknown[] }>) => v.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id} (${x.nodes.length})`);

/** Records every element that is marked as animating, for the life of the page. */
async function recordMotion(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __motion: string[] };
    w.__motion = [];
    new MutationObserver((list) => {
      for (const m of list) {
        const el = m.target as Element;
        if (el.getAttribute('data-motion') !== 'running') continue;
        w.__motion.push(el.getAttribute('data-step') ? `step:${el.getAttribute('data-step')}` : el.getAttribute('data-calc') ? 'calculation' : el.hasAttribute('data-stage-badge') ? 'stage' : el.tagName.toLowerCase());
      }
    }).observe(document, { attributes: true, subtree: true, attributeFilter: ['data-motion'] });
  });
}
const motionSeen = (page: Page) => page.evaluate(() => (window as unknown as { __motion: string[] }).__motion);
const settled = (page: Page) => expect(page.locator('[data-motion="running"]')).toHaveCount(0);

/** Claims the flagship 2-Way UMT and takes it as far as the candidate calculation. */
async function toCalculation(page: Page) {
  await page.goto('/work');
  await page.getByRole('button', { name: 'Open to claim', exact: true }).click();
  await page.getByText('SYN-26-P-0047').first().click();
  await expect(page).toHaveURL(/\/work\/items\//);
  // The URL changes before the item page has rendered; wait for the page itself.
  await expect(page.getByText('Who worked this')).toBeVisible();
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(page.getByText(/It is on your assigned list now/)).toBeVisible();
  await page.getByLabel('Current award amount').fill('91,250.00');
  await page.getByLabel('Invoice amount').fill('45,000.00');
  await page.getByRole('button', { name: '+ Add another' }).click();
  await page.getByLabel('Invoice 2').fill('44,725.00');
  await page.getByRole('button', { name: 'Record what you found' }).click();
  await expect(page.getByText('3 values recorded.')).toBeVisible();
  await page.getByLabel('Requisition funding available').fill('1,500.00');
  await page.getByRole('button', { name: 'Record what you found' }).click();
  await expect(page.getByRole('button', { name: 'Calculate the candidate', exact: true })).toBeVisible();
  return page.url();
}

const figures = (page: Page) => page.locator('[data-calc="panel"] dd');
const EXACT = ['$89,725.00', '$94,025.00', '+$2,775.00'];

test.describe('with motion allowed', () => {
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('a fresh calculation plays its arithmetic once, and every figure is exact on every frame', async ({ page }) => {
    await recordMotion(page);
    const itemUrl = await toCalculation(page);
    await page.getByRole('button', { name: 'Calculate the candidate', exact: true }).click();

    // The timeline runs, and while it runs the figures already read their final values.
    await expect(page.locator('[data-calc="panel"][data-motion="running"]')).toBeAttached();
    await expect(figures(page)).toHaveText(EXACT);
    await settled(page);
    await expect(figures(page)).toHaveText(EXACT);
    const opacity = await page.locator('[data-calc="adjustment"]').evaluate((el) => getComputedStyle(el).opacity);
    expect(opacity).toBe('1');

    // Completed steps drew their check marks, and the stage change was marked.
    const seen = await motionSeen(page);
    expect(seen).toContain('calculation');
    expect(seen).toContain('step:research_award');
    expect(seen).toContain('stage');

    // The settled page passes axe.
    expect(serious((await new AxeBuilder({ page }).analyze()).violations)).toEqual([]);

    // Opening the same case again shows the record still: nothing plays.
    await page.goto(itemUrl);
    await expect(figures(page)).toHaveText(EXACT);
    await page.waitForTimeout(800);
    expect(await motionSeen(page)).toEqual([]);
  });

  test('tabs move their underline to the chosen tab, and a progress meter settles on the exact reading', async ({ page }) => {
    await page.goto('/record');
    const overview = page.getByRole('tab', { name: /Overview/ });
    const contributions = page.getByRole('tab', { name: /Contributions/ });
    await expect(overview.locator('span.bg-accent[aria-hidden="true"]')).toHaveCount(1);
    await contributions.click();
    await expect(contributions).toHaveAttribute('aria-selected', 'true');
    // One underline, and it now sits under the chosen tab.
    await expect(contributions.locator('span.bg-accent[aria-hidden="true"]')).toHaveCount(1);
    await expect(overview.locator('span.bg-accent[aria-hidden="true"]')).toHaveCount(0);

    await page.goto('/goals');
    const pft = page.locator('article, .card', { hasText: 'Raise PFT score to 270' }).first();
    await pft.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog');
    await edit.getByLabel('Current').fill('252');
    await edit.getByRole('button', { name: /Save/ }).click();
    const bar = pft.getByRole('progressbar');
    await expect(bar).toHaveAttribute('aria-valuenow', /\d+/);
    const now = Number(await bar.getAttribute('aria-valuenow'));
    // The fill springs to the reading and comes to rest on it.
    await expect.poll(async () => bar.locator('div').first().evaluate((el) => Math.round(parseFloat((el as HTMLElement).style.width))), { timeout: 5000 }).toBe(now);
  });
});

test.describe('with reduced motion requested', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('nothing moves, and the same figures and states are there', async ({ page }) => {
    await recordMotion(page);
    await toCalculation(page);
    await page.getByRole('button', { name: 'Calculate the candidate', exact: true }).click();
    await expect(figures(page)).toHaveText(EXACT);
    await page.getByRole('heading', { name: 'Decide on requisition funding' }).waitFor();
    await page.waitForTimeout(600);
    expect(await motionSeen(page)).toEqual([]);

    // The procedure meter is at its reading at once.
    const meter = page.getByRole('progressbar', { name: 'Procedure progress' });
    const pct = Number(await meter.getAttribute('aria-valuenow'));
    const width = await meter.locator('div').first().evaluate((el) => Math.round(parseFloat((el as HTMLElement).style.width)));
    expect(width).toBe(pct);

    expect(serious((await new AxeBuilder({ page }).analyze()).violations)).toEqual([]);
  });
});
