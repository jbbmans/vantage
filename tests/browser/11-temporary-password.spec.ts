import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, logout, confirmSudoIfAsked, OPERATOR, PASSWORD, unique } from './fixtures';

test('a Marine signing in with a temporary password is held at the password screen until they choose their own', async ({ page, request }) => {
  await ensureSetup(request);
  const H = { 'x-vantage-client': '1' };
  const username = unique('temp');
  const reg = await request.post('/api/auth/register', { headers: H, data: { username, password: PASSWORD, first_name: 'Tem', last_name: 'Porary', rank_id: 'LCpl' } });
  expect(reg.ok()).toBeTruthy();
  const id = (await (await request.get('/api/me')).json()).user.id as string;
  await request.post('/api/auth/logout', { headers: H });

  await loginAs(page, OPERATOR.username);
  await page.request.post('/api/auth/sudo', { headers: H, data: { password: PASSWORD } });
  const issued = await page.request.post(`/api/org/team/${id}/temporary-password`, { headers: H });
  expect(issued.ok(), await issued.text()).toBeTruthy();
  const temp = (await issued.json()).password as string;
  await logout(page);

  const login = await page.request.post('/api/auth/login', { headers: H, data: { username, password: temp } });
  expect(login.ok()).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();
  await page.getByLabel('Temporary password').fill(temp);
  await page.getByLabel('New password', { exact: true }).fill('a-brand-new-passphrase-of-my-own-42');
  await page.getByLabel('Confirm new password').fill('a-brand-new-passphrase-of-my-own-42');
  await page.getByRole('button', { name: 'Set password and continue' }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Choose your own password' })).toHaveCount(0);
});
