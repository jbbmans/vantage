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

test('the AI assist page drafts prose, reviews the record, and shows the daily budget', async ({ page }) => {
  await page.goto('/assist');
  await expect(page.getByRole('heading', { name: 'Drafting help' })).toBeVisible();
  await page.getByLabel('Source facts').fill('Reconciled 30 ULOs totaling $1,118.38 in DAI.');
  await page.getByRole('button', { name: 'Draft', exact: true }).click();
  await expect(page.getByText(/Reconciled 30 unliquidated obligations/)).toBeVisible();
  await expect(page.getByText(/Verify the dollar figure/)).toBeVisible();
  await expect(page.getByText(/1 requests? · 200 of/)).toBeVisible();

  await page.getByRole('tab', { name: 'Personal review' }).click();
  await page.getByRole('button', { name: 'Review my record' }).click();
  await expect(page.getByText('Steady fiscal work with measurable outcomes.')).toBeVisible();
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
  await page.goto('/assist');
  await expect(page.getByText('AI assistance is off on this deployment')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the AI settings' })).toBeVisible();

  await page.goto('/operator?tab=ai');
  await page.getByRole('switch', { name: 'AI assistance on' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByText('AI settings saved.')).toBeVisible();
  await page.goto('/assist');
  await expect(page.getByRole('heading', { name: 'Drafting help' })).toBeVisible();
  await expect(page.getByLabel('AI model')).toBeVisible();
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
