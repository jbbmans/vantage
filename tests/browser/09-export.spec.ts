import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, confirmSudoIfAsked, OPERATOR } from './fixtures';

test('the complete export downloads as a zip from Settings → Your data', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/settings?tab=data');
  await expect(page.getByRole('heading', { name: 'Export everything' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Everything (ZIP)' }).click();
  await confirmSudoIfAsked(page);
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^vantage-boletz-\d{4}-\d{2}-\d{2}\.zip$/);
  await expect(page.getByText(/Downloaded vantage-boletz/)).toBeVisible();
});
