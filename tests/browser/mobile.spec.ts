import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

test('phone layout: drawer navigation, card records, and the tab bar log button', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('link', { name: 'Record', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your record' })).toBeVisible();
  // On a phone the group's pages run along the top of the page.
  await page.getByRole('navigation', { name: 'Record pages' }).getByRole('link', { name: 'Activities' }).click();
  await expect(page.getByRole('heading', { name: 'Activities', level: 1 })).toBeVisible();
  // On a phone, logging sits in the tab bar at the bottom, where a thumb reaches. The owner leads a unit, so the bar
  // offers Team beside Today and Work; a Marine's bar offers the Record there instead.
  const bar = page.getByRole('navigation', { name: 'Quick navigation' });
  await expect(bar.getByRole('link', { name: 'Team' })).toBeVisible();
  await expect(bar.getByRole('link', { name: 'Today' })).toBeVisible();
  await bar.getByRole('button', { name: 'Log what you did' }).click();
  const dialog = page.getByRole('dialog', { name: 'Log activity' });
  await dialog.getByLabel('What did you do?').fill('Ran a 3 mile route with 8 Marines this morning');
  await dialog.getByRole('button', { name: 'Save activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Activity logged.' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Ran a 3 mile route/ })).toBeVisible();
  const box = await page.locator('body').boundingBox();
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth).toBeLessThanOrEqual(Math.ceil(box!.width) + 1);
});
