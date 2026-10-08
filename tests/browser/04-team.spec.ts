import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, logout, quickLog, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

test('a leader invites a Marine by link, sees their shared work on the unit dashboard, and counsels them', async ({ browser, page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/team/invitations');
  await page.getByLabel('First name').fill('Ana');
  await page.getByLabel('Last name').fill('Rivera');
  await page.getByLabel('Billet').fill('Budget Analyst');
  await page.getByRole('button', { name: 'Create link' }).click();
  const url = (await page.locator('[data-invite-url]').first().textContent())!.trim();
  expect(url).toContain('/invite?token=');

  const username = unique('rivera');
  const invitee = await browser.newContext();
  const ip = await invitee.newPage();
  await ip.goto(url);
  await expect(ip.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible();
  await expect(ip.getByText(/invited you to G8/)).toBeVisible();
  await expect(ip.getByLabel('First name')).toHaveValue('Ana');
  await ip.getByLabel('Username').fill(username);
  await ip.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await ip.getByRole('button', { name: 'Join and sign in' }).click();
  await expect(ip.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();

  const dialog = await quickLog(ip, 'Processed 12 MIPRs with zero returns today');
  await dialog.getByLabel('Result').fill('zero returns');
  await dialog.getByRole('button', { name: /Organization, system, notes, visibility/ }).click();
  await dialog.getByRole('radio', { name: /Share with unit/ }).click();
  await expect(dialog.getByRole('radio', { name: /Share with unit/ })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('button', { name: 'Save activity' }).click();
  await expect(ip.getByRole('status').filter({ hasText: 'Activity logged.' })).toBeVisible();
  const privateDialog = await quickLog(ip, 'Private note about a personal errand');
  await privateDialog.getByRole('button', { name: /Organization, system, notes, visibility/ }).click();
  await privateDialog.getByRole('radio', { name: 'Only me' }).click();
  await privateDialog.getByRole('button', { name: 'Save activity' }).click();
  await expect(ip.getByRole('status').filter({ hasText: 'Activity logged.' })).toBeVisible();

  await page.goto('/team/dashboard?unit=G8');
  const memberRow = page.getByRole('row').filter({ hasText: 'Rivera' });
  await expect(memberRow).toBeVisible();
  await expect(memberRow).toContainText('Budget Analyst');
  await memberRow.getByRole('link', { name: /Rivera/ }).click();
  await expect(page.getByRole('heading', { name: /Rivera/ })).toBeVisible();
  await page.getByRole('tab', { name: /Activities/ }).click();
  await expect(page.getByRole('link', { name: /Processed 12 MIPRs/ })).toBeVisible();
  await expect(page.getByText('Private note about a personal errand')).toHaveCount(0);

  await page.getByRole('button', { name: 'Record counseling' }).click();
  const counsel = page.getByRole('dialog', { name: /Counsel Rivera/ });
  await counsel.getByLabel('Summary').fill('Strong first month. Keep logging outcomes with every entry.');
  await counsel.getByRole('button', { name: 'Add counseling' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Counseling added.' })).toBeVisible();

  await ip.goto('/career/counseling');
  await expect(ip.getByText('Strong first month')).toBeVisible();
  await ip.getByRole('button', { name: 'Acknowledge' }).first().click();
  await expect(ip.getByText('Acknowledged', { exact: true })).toBeVisible();

  await ip.goto('/settings?tab=security');
  await expect(ip.getByText(/View member/).first()).toBeVisible();
  await invitee.close();
  await logout(page);
});

test('a plain member cannot open the team page or another Marine’s record', async ({ page, request }) => {
  await ensureSetup(request);
  const username = unique('lone');
  await page.request.post('/api/auth/register', { headers: { 'x-vantage-client': '1' }, data: { username, password: PASSWORD, first_name: 'Lone', last_name: 'Marine' } });
  await page.goto('/team');
  await expect(page.getByText('No unit visibility yet')).toBeVisible();
  const forbidden = await page.request.get('/api/org/team');
  expect(forbidden.ok()).toBeTruthy();
  const roster = await forbidden.json();
  expect(roster.roster.length).toBe(1);
});

test('a Marine who already uses Vantage accepts an invitation with the account they have, signing in from the link', async ({ browser, page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const username = unique('hale');
  const email = `${username}@example.mil`;
  const marine = await browser.newContext();
  const mp = await marine.newPage();
  await registerAs(mp, username, { email });
  const before = await (await mp.request.get('/api/me')).json();
  await logout(mp);

  // The leader invites the address the Marine already uses: allowed, because the Marine joins with that account.
  const made = await page.request.post('/api/org/units/G8/invites', { headers: { 'x-vantage-client': '1' }, data: { email } });
  expect(made.ok(), await made.text()).toBeTruthy();
  const { url } = await made.json();

  await mp.goto(url);
  await expect(mp.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible();
  await mp.getByRole('button', { name: 'Sign in to accept it' }).click();
  await mp.getByLabel('Username', { exact: true }).fill(username);
  await mp.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await mp.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(mp.getByRole('heading', { name: 'Join G8' })).toBeVisible();
  await mp.getByRole('button', { name: /Join G8/ }).click();
  await expect(mp.getByRole('status').filter({ hasText: 'You joined G8' })).toBeVisible();
  const after = await (await mp.request.get('/api/me')).json();
  expect(after.user.id).toBe(before.user.id);
  expect(after.unitIds).toContain('G8');
  await marine.close();
  await logout(page);
});
