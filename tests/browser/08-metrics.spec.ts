import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, confirmSudoIfAsked, quickLog, OPERATOR } from './fixtures';

test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

test('the owner renames the money metric and adds a value type; forms and stat cards follow', async ({ page }) => {
  await page.goto('/operator?tab=metrics');
  await page.getByLabel('Label', { exact: true }).fill('Funds');
  await page.getByRole('button', { name: 'Add type' }).click();
  const n = await page.getByLabel(/^Value type \d+ label$/).count();
  await page.getByLabel(`Value type ${n} label`).fill('Executed');
  await page.getByLabel(`Value type ${n} verb`).fill('executed');
  await page.getByRole('button', { name: 'Save metrics' }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByText('Metrics saved.')).toBeVisible();

  // A figure only appears once there is something to measure, so record one against the new type.
  const created = await page.request.post('/api/records/activities', {
    headers: { 'x-vantage-client': '1' },
    data: { title: 'Executed a contract modification', visibility: 'unit', date: new Date().toISOString().slice(0, 10), dollar_amount: 5000, dollar_type: 'executed' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto('/');
  // Each value type is reported on its own, labelled with the instance's own money word.
  await expect(page.getByRole('button', { name: /Funds, Executed/ })).toBeVisible();

  const dialog = await quickLog(page, 'Executed 3 contract modifications worth $5,000 for G-8');
  await dialog.getByRole('button', { name: /Organization, system, notes/ }).click();
  const select = dialog.getByLabel('Value type');
  await expect(select).toBeVisible();
  await select.click();
  await expect(page.getByRole('option', { name: 'Executed' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Back to the defaults so later specs see the usual G-8 setup.
  await page.goto('/operator?tab=metrics');
  await page.getByRole('button', { name: 'Load defaults' }).click();
  await page.getByRole('button', { name: 'Save metrics' }).click();
  await confirmSudoIfAsked(page);
  await expect(page.getByText('Metrics saved.')).toBeVisible();
});
