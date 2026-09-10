import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, quickLog, confirmSudoIfAsked, OPERATOR } from './fixtures';

test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

test('quick log extracts fields with AI and the model picker offers the allowlist', async ({ page }) => {
  const dialog = await quickLog(page, 'Reconciled 30 ULOs totaling $1,118.38 in DAI for G-8 on 20 Aug');
  await expect(dialog.getByLabel('AI model')).toBeVisible();
  await dialog.getByRole('button', { name: 'Extract with AI' }).click();
  await expect(page.getByText(/Drafted with gemini-2.5-flash/)).toBeVisible();
  await expect(dialog.getByLabel('Action amount')).toHaveValue('30');
  await expect(dialog.getByLabel('Result')).toHaveValue('cleared the aged backlog');
  await expect(dialog.getByLabel('System')).toHaveValue('DAI');
});

test('AI is offered where the work happens, and there is no standalone destination', async ({ page }) => {
  // The old page is gone; a bookmark to it lands on the dashboard rather than a dead end.
  await page.goto('/assist');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link', { name: 'AI assist' })).toHaveCount(0);

  // The review reads your own record, from the dashboard.
  await page.getByRole('button', { name: 'Review my record' }).click();
  await expect(page.getByText('Steady fiscal work with measurable outcomes.')).toBeVisible();
  // The day's budget is reported next to the result, so the cost is visible where it is spent.
  await expect(page.getByText(/today \d+ requests?, [\d,]+ of [\d,]+ tokens/)).toBeVisible();

  // Coaching on entry quality sits with the entries.
  await page.goto('/records');
  await page.getByRole('button', { name: 'Coach my entries' }).click();
  await expect(page.getByRole('heading', { name: 'Which entries are weak' })).toBeVisible();
});

test('the owner console shows the gateway key, discovers models, and can switch AI off and on', async ({ page }) => {
  await page.goto('/operator?tab=ai');
  await expect(page.getByText(/key [0-9a-f]{10}/)).toBeVisible();
  await page.getByRole('button', { name: 'Discover' }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('button', { name: '+ gpt-4o' })).toBeVisible();
  await page.getByRole('button', { name: '+ gpt-4o' }).click();

  await page.getByRole('switch', { name: 'AI assistance on' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByText('AI settings saved.')).toBeVisible();
  // With AI off, the contextual buttons are simply not there: nothing to press, nothing to explain.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Review my record' })).toHaveCount(0);

  await page.goto('/operator?tab=ai');
  await page.getByRole('switch', { name: 'AI assistance on' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByText('AI settings saved.')).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Review my record' })).toBeVisible();
});

test('the reach check calls the gateway from the browser and reports the outcome', async ({ page }) => {
  await page.goto('/operator?tab=ai');
  await page.getByLabel('GenAI.mil key for the reach check').fill('wrong-key');
  await page.getByRole('button', { name: 'Test from this browser' }).click();
  await expect(page.getByRole('status').filter({ hasText: /rejected that key \(401\)/ })).toBeVisible();
  await page.getByLabel('GenAI.mil key for the reach check').fill('browser-test-genai-key');
  await page.getByRole('button', { name: 'Test from this browser' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Reachable from this browser · 4 models/ })).toBeVisible();
});
