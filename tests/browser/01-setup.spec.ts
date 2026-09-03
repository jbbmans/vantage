import { test, expect } from '@playwright/test';
import { OPERATOR, PASSWORD, logout } from './fixtures';

test.describe.configure({ mode: 'serial' });

test('first visit runs setup, lands on the dashboard, and can sign out and back in', async ({ page, request }) => {
  const status = await (await request.get('/api/auth/setup')).json();
  test.skip(!status.needsSetup, 'instance already set up by an earlier spec');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Set up Vantage' })).toBeVisible();
  await page.getByLabel('First name').fill(OPERATOR.first_name);
  await page.getByLabel('Last name').fill(OPERATOR.last_name);
  await page.getByLabel('MOS').fill('3451');
  await page.getByLabel('Username').fill(OPERATOR.username);
  await page.getByLabel('Email').fill('boletz@example.mil');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('First unit').fill(OPERATOR.unit_name);
  await page.getByLabel('Short name').fill(OPERATOR.unit_short_name);
  await page.getByRole('button', { name: 'Create owner account' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), John/ })).toBeVisible();
  await expect(page.getByText('Start with one sentence')).toBeVisible();

  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  await page.getByLabel('Username').fill(OPERATOR.username);
  await page.getByLabel('Password').fill('not-the-password-at-all');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening), John/ })).toBeVisible();
  await logout(page);
});

test('forgot-password flow never reveals whether an account exists', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Forgot your password?' }).click();
  await page.getByLabel('Username or email').fill('nobody-here');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText(/reset link is on its way/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
