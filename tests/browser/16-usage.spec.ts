import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, quickLog, OPERATOR } from './fixtures';

test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

test('using the app produces the events, and the console reports them in aggregate', async ({ page }) => {
  // Walk a capture through to a saved record, then abandon one, so both ends of the funnel exist.
  const dialog = await quickLog(page, 'Reconciled 14 aged obligations totaling $402.10 in DAI');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Activity logged.')).toBeVisible();

  const second = await quickLog(page, 'Half a thought');
  await second.getByRole('button', { name: 'Cancel' }).click();

  await page.goto('/records');
  await page.goto('/goals');
  // Events are queued and flushed in the background; the console reads what has landed.
  await page.waitForTimeout(5000);

  await page.goto('/operator?tab=usage');
  await expect(page.getByRole('heading', { name: 'Three different times' })).toBeVisible();

  // The three times are named separately and never combined into one figure.
  await expect(page.getByText('Form open', { exact: true })).toBeVisible();
  await expect(page.getByText('Active editing, estimated')).toBeVisible();
  await expect(page.getByText('Work duration, confirmed')).toBeVisible();
  await expect(page.getByText('An estimate, never time worked.')).toBeVisible();

  // The catalog is shown, and says plainly that nothing a person typed can reach it.
  await expect(page.getByText('capture.completed', { exact: false }).first()).toBeVisible();
  await expect(page.getByText(/There is no free-text property/)).toBeVisible();
});

test('a single person\'s activity is withheld rather than shown as a breakdown', async ({ page }) => {
  await page.goto('/operator?tab=usage');
  await expect(page.getByRole('heading', { name: 'Which destinations get used' })).toBeVisible();
  // On a one-person instance every breakdown is a cohort of one, so every one of them is withheld.
  await expect(page.getByText(/too few people contributed|No page views recorded yet/).first()).toBeVisible();
});
