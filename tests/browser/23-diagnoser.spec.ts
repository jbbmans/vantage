import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

test('a balance read in the diagnoser opens as a case in the reader’s hands, figures recorded as read', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/reference?tab=diagnose');
  const figures = page.locator('section[aria-label="The figures"]');
  await figures.getByLabel('Commitment', { exact: true }).fill('50,000.00');
  await figures.getByLabel('Obligation', { exact: true }).fill('50,000.00');
  await figures.getByLabel('Delivered', { exact: true }).fill('30,000.00');
  await figures.getByLabel('Paid', { exact: true }).fill('30,000.00');
  const reading = page.locator('section[aria-label="The reading"]');
  await expect(reading).toContainText('UDOU');
  await expect(reading).toContainText('$20,000.00');

  const reference = `M67854-26-RC-${Date.now().toString().slice(-5)}`;
  await page.getByLabel('Document number').fill(reference);
  await page.getByRole('button', { name: /Open the case/ }).click();
  await expect(page).toHaveURL(/\/work\/items\//);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(reference);
  // The person who opened it holds it; there is nothing left to claim.
  await expect(page.locator('dt', { hasText: 'Held by' }).first().locator('xpath=..')).toContainText('You');
  await expect(page.getByRole('button', { name: 'Claim', exact: true })).toHaveCount(0);
  await expect(page.getByText('What the figures show')).toBeVisible();
});
