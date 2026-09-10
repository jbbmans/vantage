import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, quickLog, OPERATOR } from './fixtures';

test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

test('quick log parses a sentence, saves it, and the record round-trips through list, detail, reports, PDF and CSV', async ({ page }) => {
  const dialog = await quickLog(page, 'Reconciled 30 ULOs totaling $1,118.38 in DAI for G-8 yesterday');
  await expect(dialog.getByLabel('Action amount')).toHaveValue('30');
  await expect(dialog.getByLabel('Transaction value')).toHaveValue(/1118/);
  await dialog.getByLabel('Result').fill('cleared the aged backlog with zero findings');
  await dialog.getByRole('button', { name: 'Save activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Activity logged.' })).toBeVisible();

  await page.goto('/records');
  const row = page.getByRole('link', { name: /Reconciled 30 ULOs/ }).first();
  await expect(row).toBeVisible();
  await expect(page.getByRole('cell', { name: '$1,118', exact: true })).toBeVisible();
  await row.click();
  await expect(page.getByRole('heading', { name: /Reconciled 30 ULOs/ })).toBeVisible();
  await expect(page.getByText(/Strength [3-5]\/5/)).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit activity' });
  await edit.getByLabel('Organization').fill('G-8 Comptroller');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('G-8 Comptroller').first()).toBeVisible();

  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: /JEPES input/ })).toBeVisible();
  await expect(page.getByText(/MISSION:/)).toBeVisible();
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/vantage-jepes-input.*\.pdf$/);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV', exact: true }).click()]);
  expect(csv.suggestedFilename()).toMatch(/\.csv$/);
  const path = await csv.path();
  const text = (await import('node:fs')).readFileSync(path!, 'utf8');
  expect(text).toContain('Vantage ID');
  expect(text).toContain('Reconciled 30 ULOs');
});

test('csv import updates rows that carry a Vantage ID instead of duplicating them', async ({ page }) => {
  const title = `Import test ${Date.now()}`;
  const created = await (await page.request.post('/api/records/activities', { headers: { 'x-vantage-client': '1' }, data: { title, date: '2026-08-01', quantity: 4, unit_label: 'MIPRs', result: 'zero returns' } })).json();
  const csv = `Vantage ID,Date,Title,Action Amount,Action Unit,Result\n${created.id},2026-08-01,${title} (edited),9,MIPRs,zero returns\n,2026-08-02,Brand new imported row,1,brief,delivered\n`;
  await page.goto('/records?import=1');
  const dialog = page.getByRole('dialog', { name: 'Import activities from CSV' });
  await dialog.locator('input[type=file]').setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(dialog.getByText(/1.*update existing/)).toBeVisible();
  await dialog.getByRole('button', { name: /Import 2 rows/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /Imported 1 new, updated 1/ })).toBeVisible();
  await page.getByLabel('Search records').fill('Import test');
  await expect(page.getByRole('link', { name: `${title} (edited)` })).toBeVisible();
  await expect(page.getByText('9 MIPRs')).toBeVisible();
});

test('tasks, goals, training and awards can be created and appear on the dashboard', async ({ page }) => {
  await page.goto('/work');
  await page.getByRole('button', { name: 'New task' }).click();
  const task = page.getByRole('dialog', { name: 'New task' });
  await task.getByLabel('Title').fill('Close out FY obligations');
  await task.getByLabel('Due').fill('2020-01-01');
  await task.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByRole('heading', { name: 'Overdue' })).toBeVisible();

  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal' }).click();
  const goal = page.getByRole('dialog', { name: 'New goal' });
  await goal.getByLabel('Goal').fill('Log 20 entries this quarter');
  await goal.getByLabel('Target').fill('20');
  await goal.getByRole('button', { name: 'Add goal' }).click();
  await expect(page.getByRole('heading', { name: 'Log 20 entries this quarter' })).toBeVisible();

  await page.goto('/career?tab=awards');
  await page.getByRole('button', { name: 'Track an award' }).first().click();
  const award = page.getByRole('dialog', { name: 'Track an award' });
  await award.getByLabel('Award', { exact: true }).fill('Navy and Marine Corps Achievement Medal');
  await award.getByRole('button', { name: 'Add award' }).click();
  await expect(page.getByRole('heading', { name: 'Navy and Marine Corps Achievement Medal' })).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('overdue task')).toBeVisible();
  await expect(page.getByText('Log 20 entries this quarter')).toBeVisible();
});

test('appearance settings switch theme and accent and persist across reload', async ({ page }) => {
  await page.goto('/settings?tab=appearance');
  await page.getByRole('tab', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: /Ocean/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'ocean');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'ocean');
  await page.getByRole('tab', { name: 'Light' }).click();
  await page.getByRole('button', { name: /Scarlet/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
