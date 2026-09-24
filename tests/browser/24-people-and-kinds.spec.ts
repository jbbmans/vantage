import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, loginAs, registerAs, settled, unique, OPERATOR } from './fixtures';

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');

test('a record of each kind asks its own questions and saves every answer', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  await page.goto('/records');
  await page.getByRole('button', { name: 'New entry' }).click();
  const dialog = page.getByRole('dialog', { name: 'New activity' });
  // Work is the default, with the fields it always had.
  await expect(dialog.getByRole('radio', { name: 'Work' })).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByLabel('Transaction value')).toBeVisible();

  await dialog.getByRole('radio', { name: 'Education' }).click();
  await expect(dialog.getByLabel('Transaction value')).toHaveCount(0);
  await dialog.getByLabel('Course or degree').fill('ACCT 201: Principles of Accounting');
  await dialog.getByLabel('School or institution').fill('Synthetic State College');
  await dialog.getByLabel('Level', { exact: true }).fill('Single course');
  await dialog.getByLabel('Credits').fill('3');
  await dialog.getByLabel('Grade or outcome').fill('A');
  await settled(page);
  await expect(new AxeBuilder({ page }).include('[role="dialog"]').analyze().then((r) => serious(r.violations))).resolves.toEqual([]);
  await dialog.getByRole('button', { name: 'Add activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Activity added.' })).toBeVisible();

  await page.getByRole('link', { name: /ACCT 201/ }).first().click();
  await expect(page.getByRole('heading', { name: /ACCT 201/ })).toBeVisible();
  const facts = page.locator('section', { has: page.getByRole('heading', { name: 'Details' }) });
  await expect(facts).toContainText('Education');
  await expect(facts).toContainText('Synthetic State College');
  await expect(facts).toContainText('Single course');
  await expect(facts).toContainText('3 credits');
  await expect(facts).not.toContainText('Transaction value');
});

test('every member sees their team; People sets access levels, and the change shows on Team', async ({ page, browser, request }) => {
  await ensureSetup(request);
  const username = unique('member');
  await registerAs(page, username, { first_name: 'Quinn', last_name: 'Member' });
  const me = await (await page.request.get('/api/me')).json();

  const admin = await (await browser.newContext()).newPage();
  await loginAs(admin, OPERATOR.username);
  expect((await admin.request.post('/api/org/units/G8/members', { headers: H, data: { user_id: me.user.id } })).ok()).toBeTruthy();

  // Enrollment signs the member out so the new team applies; they see it the moment they are back.
  await loginAs(page, username);
  const rail = page.getByRole('navigation', { name: 'Primary' });
  await expect(rail.getByRole('link', { name: /^Team/ })).toBeVisible();
  await expect(rail.getByRole('link', { name: /^People/ })).toHaveCount(0);
  await page.goto('/team?tab=roster');
  await expect(page.getByText('Your access here:')).toBeVisible();
  await expect(page.getByRole('main').getByText('Personal').first()).toBeVisible();
  await expect(page.getByRole('table')).toContainText('Boletz');
  // The only record a Personal member can open from the roster is their own.
  const own = page.getByRole('row').filter({ hasText: 'Member, Quinn' });
  await expect(own.getByRole('link', { name: 'Open' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open' })).toHaveCount(1);
  await page.getByRole('tab', { name: 'Workload' }).click();
  await expect(page.getByText(/team’s totals/)).toBeVisible();

  // The owner makes them a Team leader from People.
  await admin.goto('/people');
  await expect(admin.getByRole('heading', { name: 'People', level: 1 })).toBeVisible();
  await expect(admin.getByRole('list', { name: 'Access levels' })).toContainText('Team leader');
  await admin.getByLabel('Search people').fill(username);
  await admin.getByRole('combobox', { name: /Access for Quinn Member in G8/ }).click();
  await admin.getByRole('option', { name: 'Team leader' }).click();
  await admin.getByRole('button', { name: 'Set access' }).click();
  await expect(admin.getByRole('status').filter({ hasText: 'Quinn Member is now Team leader in G8.' })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await admin.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await settled(admin);
    const results = await new AxeBuilder({ page: admin }).exclude('[data-radix-popper-content-wrapper]').analyze();
    expect(serious(results.violations), `People in ${theme}`).toEqual([]);
  }

  await loginAs(page, username);
  await page.goto('/team?tab=roster');
  await expect(page.getByText('Your access here:')).toBeVisible();
  await expect(page.locator('header, .page').getByText('Team leader').first()).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /^People/ })).toBeVisible();
  await admin.close();
});
