import { test, expect } from '@playwright/test';
import { ensureSetup, confirmSudoIfAsked, loginAs, logout, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

test.beforeEach(async ({ request }) => { await ensureSetup(request); });

test('the Lead Unit Manager opens the Unit Manager console from the app: its own pages, its own shell, and a way back', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.getByRole('link', { name: 'Unit Manager console' }).first().click();
  await expect(page).toHaveURL(/\/console\/G8\/?$/);
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: 'G-8 Comptroller', level: 1 })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await expect(sections.getByRole('link', { name: 'Metrics' }), 'what runs the service is not in the Unit Manager console').toHaveCount(0);
  await sections.getByRole('link', { name: 'People' }).click();
  await expect(page).toHaveURL(/\/console\/G8\/people$/);
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Unit Instance roles' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Today' }), 'none of the app’s pages are in the console').toHaveCount(0);
  await page.getByRole('link', { name: 'Open the app' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
});

test('a Marine who finds the console is told it is for Unit Managers, and sent back to the app', async ({ page }) => {
  await registerAs(page, unique('curious'));
  await page.goto('/console');
  await expect(page.getByText('This is the Unit Manager console')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Open the app' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
});

test('signed out, an old console link opens the Vantage Administrator console’s sign-in, and then what they came for', async ({ page }) => {
  await logout(page);
  await page.goto('/operator?tab=email');
  await expect(page.getByText('For Vantage staff.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create an account' })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Username' }).fill(OPERATOR.username);
  await page.locator('input[type=password]').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: 'Email' })).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/email$/);
});

test('Vantage staff open the Vantage Administrator console from the app; it is a different console from the Unit Manager console', async ({ page }) => {
  await loginAs(page, OPERATOR.username);
  await page.goto('/admin');
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { name: 'The service', level: 1 })).toBeVisible();
  const sections = page.getByRole('navigation', { name: 'Sections' });
  await sections.getByRole('link', { name: 'Unit Instances' }).click();
  await expect(page).toHaveURL(/\/admin\/orgs$/);
  await expect(page.getByRole('cell', { name: /G-8 Comptroller/ })).toBeVisible();
  await expect(sections.getByRole('link', { name: 'People' }), 'a Unit Instance’s people are its Unit Managers’, not the platform’s').toHaveCount(0);
});

test('a Marine who finds the Vantage Administrator console is told it is for Vantage staff', async ({ page }) => {
  await registerAs(page, unique('nosy'));
  await page.goto('/admin');
  await expect(page.getByText('This is the Vantage Administrator console')).toBeVisible();
});
