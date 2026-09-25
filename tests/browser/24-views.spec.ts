import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, logout, registerAs, unique, OPERATOR } from './fixtures';

const H = { 'x-vantage-client': '1' };

test('a leader switches between the whole command and a team beneath it, from the switcher, the keyboard and search', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const short = unique('VW').toUpperCase();
  const created = await page.request.post('/api/org/units', { headers: H, data: { name: `Views Team ${short}`, short_name: short, parent_id: 'G8' } });
  expect(created.ok(), await created.text()).toBeTruthy();
  await page.reload();

  const switcher = page.getByTestId('view-switcher');
  await expect(switcher).toContainText('G8');
  await page.keyboard.press('v');
  const list = page.getByRole('listbox', { name: 'Views' });
  await expect(list).toBeVisible();
  await expect(list.getByRole('option', { name: /G8.*Whole command/ })).toHaveAttribute('aria-selected', 'true');
  await list.getByRole('option', { name: new RegExp(short) }).click();
  await expect(list).toBeHidden();
  await expect(switcher).toContainText(short);

  await page.goto('/team');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(short);
  await expect(page.getByRole('tab', { name: 'Roster' })).toBeVisible();

  await page.keyboard.press('Control+k');
  await page.keyboard.type('view G8');
  await page.getByRole('option', { name: /View G8/ }).click();
  await expect(switcher).toContainText('G8');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('G8');
  await expect(page.getByText('Whole command', { exact: true })).toBeVisible();
});

test('a new Marine gets a first-week list that ticks itself off and can be put away', async ({ page }) => {
  await logout(page);
  await registerAs(page, unique('fresh'));
  const list = page.getByRole('region', { name: 'Your first week' });
  await expect(list).toBeVisible();
  await expect(list).toContainText('1 of 5 done');
  await expect(page.getByRole('link', { name: 'Team', exact: true })).toHaveCount(0);
  await list.getByRole('button', { name: 'Hide the first-week list' }).click();
  await expect(list).toBeHidden();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Your first week' })).toHaveCount(0);
});
