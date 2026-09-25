import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

test('phone layout: drawer navigation, card records, and the header log button', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your record' })).toBeVisible();
  await page.getByRole('tab', { name: 'Your entries' }).click();
  await expect(page.getByRole('heading', { name: 'Activities you recorded' })).toBeVisible();
  await page.getByRole('banner').getByRole('button', { name: 'Log activity' }).click();
  const dialog = page.getByRole('dialog', { name: 'Log activity' });
  await dialog.getByLabel('What did you do?').fill('Ran a 3 mile route with 8 Marines this morning');
  await dialog.getByRole('button', { name: 'Save activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Activity logged.' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Ran a 3 mile route/ })).toBeVisible();
  const box = await page.locator('body').boundingBox();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(Math.ceil(box!.width) + 1);
});
