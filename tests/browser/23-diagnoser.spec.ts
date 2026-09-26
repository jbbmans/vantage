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

test('reading it yourself first hides the reading until you commit to one, then says whether you matched', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/reference?tab=diagnose');
  const figures = page.locator('section[aria-label="The figures"]');
  await figures.getByRole('switch', { name: /Read it yourself first/ }).click();
  await figures.getByLabel('Commitment', { exact: true }).fill('50,000.00');
  await figures.getByLabel('Obligation', { exact: true }).fill('50,000.00');
  await figures.getByLabel('Delivered', { exact: true }).fill('30,000.00');
  await figures.getByLabel('Paid', { exact: true }).fill('30,000.00');
  const reading = page.locator('section[aria-label="The reading"]');
  await expect(reading.getByText('Your read first')).toBeVisible();
  await expect(reading).not.toContainText('$20,000.00');
  await expect(reading.getByRole('button', { name: /Show the reference/ })).toBeDisabled();
  await reading.getByRole('button', { name: 'OCMT' }).click();
  await reading.getByRole('button', { name: /Show the reference/ }).click();
  await expect(reading.getByRole('status')).toContainText('the reference reads UDOU');
  await expect(reading).toContainText('$20,000.00');

  await figures.getByLabel('Paid', { exact: true }).fill('30,000.01');
  await figures.getByLabel('Paid', { exact: true }).fill('30,000.00');
  await reading.getByRole('button', { name: 'UDOU' }).click();
  await reading.getByRole('button', { name: /Show the reference/ }).click();
  await expect(reading.getByRole('status')).toContainText('Your read matches the reference: UDOU');
  await expect(figures).toContainText('You have read 2 balances on this device and matched the reference on 1.');
});
