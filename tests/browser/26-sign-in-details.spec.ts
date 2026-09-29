import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, confirmSudoIfAsked, OPERATOR, PASSWORD, unique } from './fixtures';

const H = { 'x-vantage-client': '1' };

test('an owner emails everyone their sign-in details and sees each result', async ({ page, request }) => {
  await ensureSetup(request);
  const withMail = unique('mailable');
  const noMail = unique('nomail');
  for (const [username, email] of [[withMail, `${withMail}@example.mil`], [noMail, undefined]] as const) {
    const reg = await request.post('/api/auth/register', { headers: H, data: { username, password: PASSWORD, first_name: 'Sign', last_name: 'In', rank_id: 'LCpl', ...(email ? { email } : {}) } });
    expect(reg.ok(), await reg.text()).toBeTruthy();
    await request.post('/api/auth/logout', { headers: H });
  }

  await loginAs(page, OPERATOR.username);
  await page.goto('/operator?tab=users');
  await confirmSudoIfAsked(page);
  await page.getByRole('button', { name: 'Email sign-in details' }).click();
  await confirmSudoIfAsked(page);
  const dialog = page.getByRole('dialog', { name: 'Email sign-in details' });
  await expect(dialog.getByText(`@${withMail}`)).toBeVisible();
  await expect(dialog.getByText(/no email address and cannot be reached/)).toContainText(noMail);
  await expect(dialog.getByRole('tab', { name: /^Never signed in/ })).toBeVisible();

  await dialog.getByRole('tab', { name: /^Not sent yet/ }).click();
  const send = dialog.getByRole('button', { name: /^Send to \d+ (person|people)$/ });
  await send.click();
  await confirmSudoIfAsked(page);
  await expect(dialog.getByRole('status')).toContainText(/sent/);
  await expect(dialog.getByRole('row').filter({ hasText: `@${withMail}` })).toContainText('Sent');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  await page.getByRole('button', { name: 'Email sign-in details' }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('dialog', { name: 'Email sign-in details' }).getByRole('row').filter({ hasText: `@${withMail}` })).toContainText(/last sent/);
});

test('a sign-in link opens a welcome that names the username to keep', async ({ page }) => {
  await page.route('**/api/auth/reset?token=*', (route) => route.fulfill({ json: { valid: true, email: 'a***@example.mil', purpose: 'sign_in', username: 'avery.stone', expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }));
  await page.goto('/reset?token=sample-token');
  await expect(page.getByRole('heading', { name: 'Choose your password' })).toBeVisible();
  await expect(page.getByText('You sign in as avery.stone.')).toBeVisible();
  await expect(page.getByLabel('Username')).toHaveValue('avery.stone');
  await expect(page.getByRole('button', { name: 'Set password and sign in' })).toBeVisible();
});
