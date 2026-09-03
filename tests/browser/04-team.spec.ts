import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, logout, quickLog, unique, OPERATOR, PASSWORD } from './fixtures';

test('a leader invites a Marine by link, sees their shared work on the unit dashboard, and counsels them', async ({ browser, page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/team?tab=invites');
  await page.getByLabel('First name').fill('Ana');
  await page.getByLabel('Last name').fill('Rivera');
  await page.getByLabel('Billet').fill('Budget Analyst');
  await page.getByRole('button', { name: 'Create link' }).click();
  const url = (await page.locator('p.font-mono').first().textContent())!.trim();
  expect(url).toContain('/invite?token=');

  const username = unique('rivera');
  const invitee = await browser.newContext();
  const ip = await invitee.newPage();
  await ip.goto(url);
  await expect(ip.getByRole('heading', { name: 'Accept your invitation' })).toBeVisible();
  await expect(ip.getByText(/invited you to G8/)).toBeVisible();
  await expect(ip.getByLabel('First name')).toHaveValue('Ana');
  await ip.getByLabel('Username').fill(username);
  await ip.getByLabel('Password').fill(PASSWORD);
  await ip.getByRole('button', { name: 'Join and sign in' }).click();
  await expect(ip.getByRole('heading', { name: /Good (morning|afternoon|evening), Ana/ })).toBeVisible();

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

  await page.goto('/team?tab=dashboard&unit=G8');
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

  await ip.goto('/career?tab=counseling');
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
