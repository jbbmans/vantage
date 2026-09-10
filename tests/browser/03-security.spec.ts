import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, logout, registerAs, unique, confirmSudoIfAsked, PASSWORD } from './fixtures';
import { totpCode } from '../../server/auth/totp.ts';

const code = (secret: string) => totpCode(secret, Math.floor(Date.now() / 1000 / 30));

test('authenticator enrolment adds a second step to sign-in and recovery codes work once', async ({ page, request }) => {
  await ensureSetup(request);
  const username = unique('mfa');
  await registerAs(page, username);
  await page.goto('/settings?tab=security');
  await page.getByRole('button', { name: 'Set up' }).click();
  await confirmSudoIfAsked(page);
  const dialog = page.getByRole('dialog', { name: 'Set up your authenticator' });
  await expect(dialog).toBeVisible();
  const secret = (await dialog.locator('code').textContent())!.trim();
  await dialog.getByLabel('Code from the app').fill(code(secret));
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  const codesDialog = page.getByRole('dialog', { name: 'Recovery codes' });
  await expect(codesDialog).toBeVisible();
  const recovery = await codesDialog.locator('li').allTextContents();
  expect(recovery.length).toBeGreaterThanOrEqual(8);
  await codesDialog.getByRole('button', { name: 'I saved them' }).click();
  await expect(page.getByText('On', { exact: true })).toBeVisible();

  await logout(page);
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Second step' })).toBeVisible();
  await page.getByLabel('Code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('not valid');
  await page.getByLabel('Code').fill(recovery[0]);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();

  await logout(page);
  await page.goto('/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Code').fill(recovery[0]);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('not valid');
  await page.getByLabel('Code').fill(code(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
});

test('a passkey registered in settings signs the user in without a password', async ({ page, request }) => {
  await ensureSetup(request);
  const username = unique('pk');
  await registerAs(page, username);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

  await page.goto('/settings?tab=security');
  await page.getByLabel('Passkey name').fill('Virtual authenticator');
  await page.getByRole('button', { name: 'Add passkey' }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('status').filter({ hasText: 'Passkey added' })).toBeVisible();
  await expect(page.getByText('Virtual authenticator')).toBeVisible();

  await logout(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ })).toBeVisible();
  await page.goto('/settings?tab=security');
  await expect(page.getByText(/used .* ago|used just now/)).toBeVisible();
});

test('changing the password signs out other devices', async ({ browser, page, request }) => {
  await ensureSetup(request);
  const username = unique('pw');
  await registerAs(page, username);
  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await loginAs(otherPage, username);
  await page.goto('/settings?tab=security');
  await expect(page.getByText(/This device/)).toBeVisible();
  const next = 'harbor-lantern-quiet-meadow-4410';
  await page.getByLabel('Current password').fill(PASSWORD);
  await page.getByLabel('New password').fill(next);
  await page.getByRole('button', { name: 'Change password' }).click();
  await expect(page.getByRole('status').filter({ hasText: /Password changed/ })).toBeVisible();
  await otherPage.reload();
  await expect(otherPage.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await other.close();
});
