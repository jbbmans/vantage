import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, logout, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

test.beforeEach(async ({ request }) => { await ensureSetup(request); });

test('the owner opens the console from the app: its own pages, its own shell, and a way back', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.getByRole('link', { name: 'Owner console' }).first().click();
  await expect(page).toHaveURL(/\/console\/?$/);
  await expect(page.getByRole('heading', { name: 'This deployment' })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await sections.getByRole('link', { name: 'Accounts' }).click();
  await expect(page).toHaveURL(/\/console\/accounts$/);
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Today' }), 'none of the app’s pages are in the console').toHaveCount(0);
  await page.getByRole('link', { name: 'Open the app' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
});

test('a Marine who finds the console is told it is for owners, and sent back to the app', async ({ page }) => {
  await registerAs(page, unique('curious'));
  await page.goto('/console');
  await expect(page.getByText('This is the owner console')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This deployment' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open the app' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
});

test('signed out, the console asks owners to sign in, and opens on what they came for', async ({ page }) => {
  await logout(page);
  await page.goto('/operator?tab=email');
  await expect(page.getByText('For the people who run this Vantage.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create an account' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Username' }).fill(OPERATOR.username);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Email' })).toBeVisible();
  await expect(page).toHaveURL(/\/console\/email$/);
});
