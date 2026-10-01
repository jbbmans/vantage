import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, quickLog, OPERATOR } from './fixtures';

test('an entry saved offline is queued on the device and synced when the network returns', async ({ page, context, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await context.setOffline(true);
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  const dialog = await quickLog(page, 'Briefed 14 Marines on the new travel policy while offline');
  await dialog.getByRole('button', { name: 'Queue offline' }).click();
  await expect(page.getByRole('status').filter({ hasText: /queued/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /1 queued/ })).toBeVisible({ timeout: 10_000 }).catch(() => undefined);
  await context.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: /1 queued entry synced/ })).toBeVisible({ timeout: 15_000 });
  await page.goto('/records');
  await expect(page.getByRole('link', { name: /Briefed 14 Marines/ })).toBeVisible();
});

test('an entry the server refuses shows why, and can be let go instead of waiting forever', async ({ page, context, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await context.setOffline(true);
  const dialog = await quickLog(page, 'Refused entry for the queue test');
  await dialog.getByRole('button', { name: 'Queue offline' }).click();
  await expect(page.getByRole('status').filter({ hasText: /queued/ })).toBeVisible();
  await page.route('**/api/records/activities', (route) => (route.request().method() === 'POST'
    ? route.fulfill({ status: 400, json: { error: 'That unit no longer exists.', code: 'validation' } })
    : route.continue()));
  await context.setOffline(false);
  await page.getByRole('button', { name: /1 queued/ }).click();
  const queue = page.getByRole('dialog', { name: 'Waiting to sync' });
  await queue.getByRole('button', { name: 'Try again now' }).click();
  await expect(queue).toContainText('The server refused it: That unit no longer exists.');
  await queue.getByRole('button', { name: 'Discard Refused entry for the queue test' }).click();
  await queue.getByRole('button', { name: 'Discard for good' }).click();
  await expect(queue).toContainText('Nothing is waiting');
});
