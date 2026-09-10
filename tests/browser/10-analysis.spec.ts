import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, quickLog, OPERATOR } from './fixtures';

test('the full analysis view reads the record like an analyst and exports its PDF', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const dialog = await quickLog(page, 'Processed 12 MIPRs worth $240,000 in DAI for G-8 today');
  await dialog.getByLabel('Result').fill('zero returns from the receiving activity');
  await dialog.getByRole('button', { name: 'Save activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Activity logged.' })).toBeVisible();

  await page.goto('/reports');
  await page.getByRole('tab', { name: 'Full analysis' }).click();
  await expect(page.getByRole('heading', { name: 'Executive summary' })).toBeVisible();
  await expect(page.getByText(/entries in /).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Logging cadence' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Coverage' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Entry ledger' })).toBeVisible();
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(page.getByRole('cell', { name: /Processed 12 MIPRs/ }).first()).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Analysis PDF' }).first().click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^vantage-analysis-.*\.pdf$/);
});
