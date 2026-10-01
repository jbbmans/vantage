import { test, expect, type Page } from '@playwright/test';
import { ensureSetup } from './fixtures';

test.beforeEach(async ({ request }) => { await ensureSetup(request); });

/** The test server has no card reader, so the instance's answers are stood in for; the page's behaviour is what is under test. */
async function asInstance(page: Page, cac: { enabled: boolean; exclusive: boolean }) {
  await page.route('**/api/auth/setup', async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, cac, selfRegistration: real.selfRegistration && !cac.exclusive } });
  });
  await page.route('**/api/auth/cac', (route) => route.fulfill({ status: 401, json: { error: 'No card was presented. Check the card is in the reader, then try again.', code: 'cac_no_certificate' } }));
}

test('a CAC-only instance offers the card, not a password form that would always be refused', async ({ page }) => {
  await asInstance(page, { enabled: true, exclusive: true });
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign in with your CAC' })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Forgot your password?' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Sign in with your CAC' }).click();
  await expect(page.getByRole('alert')).toContainText('No card was presented');
});

test('where a card is one way in, it sits beside the password and the passkey', async ({ page }) => {
  await asInstance(page, { enabled: true, exclusive: false });
  await page.goto('/login');
  await expect(page.getByRole('textbox', { name: 'Username' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with your CAC' })).toBeVisible();
});
