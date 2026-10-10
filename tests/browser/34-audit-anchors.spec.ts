import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, confirmSudoIfAsked, loginAs, OPERATOR } from './fixtures';

/**
 * The audit chain's anchors in the Vantage Administrator console (Task 7, ADR-0013): the head of the chain and the last
 * anchor written into it, and a check of an anchor kept off the host, from the keyboard, with its result announced.
 */

test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ request }) => { await ensureSetup(request); });

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);

async function openTrail(page: Page) {
  await page.goto('/admin/audit');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: 'Platform audit trail', level: 1 })).toBeVisible();
}

test('the audit trail page shows the chain’s head and last anchor, and checks a kept anchor', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  const anchored = await page.request.post('/api/platform/integrity/anchor', { headers: H });
  expect(anchored.ok(), await anchored.text()).toBeTruthy();
  const { audit: kept } = await anchored.json() as { audit: { seq: number; hash: string; count: number } };

  await openTrail(page);
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Audit chain anchors' }) });
  await expect(panel.getByRole('heading', { name: 'Current head' })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Last anchor' })).toBeVisible();
  await expect(panel.getByText(kept.hash).first(), 'the last anchor names the head it wrote').toBeVisible();
  await expect(panel.getByText(/by John Boletz/)).toBeVisible();

  const form = page.getByRole('form', { name: 'Check a kept anchor' });
  // Refused before it is sent: a hash is 64 hexadecimal characters.
  await form.getByLabel('Entry number').fill(String(kept.seq));
  await form.getByLabel('Entry hash').fill('not-a-hash');
  await form.getByRole('button', { name: 'Check anchor' }).click();
  await expect(form.getByRole('alert')).toHaveText('Enter the 64-character hash the anchor names.');

  // The anchor as the SIEM kept it holds; submitted from the keyboard.
  await form.getByLabel('Entry hash').fill(kept.hash);
  await form.getByLabel('Entry hash').press('Enter');
  const status = form.getByRole('status');
  await expect(status).toContainText('The anchor holds.');
  await expect(status).toContainText(`Entry ${kept.seq}: The entry at that position still carries the anchored hash.`);
  await expect(status).toContainText(/The chain verifies across \d+ entries\./);

  // One that does not match is reported as such, and recorded.
  await form.getByLabel('Entry hash').fill('0'.repeat(64));
  await form.getByRole('button', { name: 'Check anchor' }).click();
  await expect(status).toContainText('The anchor does not hold.');
  await expect(status).toContainText('carries a different hash');

  const results = await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze();
  expect(serious(results.violations)).toEqual([]);

  // Both checks are in the trail.
  const trail = await page.request.get('/api/platform/audit?action=audit_anchor_verified&limit=5', { headers: H });
  const rows = (await trail.json()).rows as Array<{ detail: string; category: string }>;
  expect(rows.slice(0, 2).map((r) => r.category)).toEqual(['enterprise', 'enterprise']);
  expect(rows[0].detail).toContain('a different hash');
  expect(rows[1].detail).toContain('the entry matches');
});
