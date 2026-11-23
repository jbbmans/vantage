import { test, expect, type Locator, type Page } from '@playwright/test';
import { ensureSetup, loginAs, quickLog, OPERATOR } from './fixtures';

test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

/** A form refused before it is sent marks the field, moves focus to it and says why once: no toast repeats it. */
async function refusedAt(page: Page, field: Locator, text: string) {
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(new RegExp(text.replace(/[.?]/g, '\\$&')));
  await expect(page.locator('[role="alert"]').filter({ hasText: text })).toHaveCount(1);
}

test('quick log parses a sentence, saves it, and the record round-trips through list, detail, reports, PDF and CSV', async ({ page }) => {
  const dialog = await quickLog(page, 'Reconciled 30 ULOs totaling $1,118.38 in DAI for G-8 yesterday');
  await expect(dialog.getByLabel('Action amount')).toHaveValue('30');
  await expect(dialog.getByLabel('Transaction value')).toHaveValue(/1118/);
  await dialog.getByLabel('Result').fill('cleared the aged backlog with zero findings');
  await dialog.getByRole('button', { name: 'Save activity' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Activity logged.' })).toBeVisible();

  // All time: on the first days of a fiscal year, yesterday is last year's.
  await page.goto('/records?period=all');
  const row = page.getByRole('link', { name: /Reconciled 30 ULOs/ }).first();
  await expect(row).toBeVisible();
  await expect(page.getByRole('cell', { name: '$1,118', exact: true })).toBeVisible();
  await row.click();
  await expect(page.getByRole('heading', { name: /Reconciled 30 ULOs/ })).toBeVisible();
  // Five points of five: it opens with the work, has a number, an outcome, a measured one ("zero findings"), an area.
  await expect(page.getByText('Strength 5/5', { exact: true })).toBeVisible();
  await expect(page.getByText('Complete. This one survives the cut.')).toBeVisible();

  await page.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit activity' });
  await edit.getByLabel('Organization').fill('G-8 Comptroller');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('G-8 Comptroller').first()).toBeVisible();

  await page.goto('/reports/analysis?period=all');
  await expect(page.getByRole('heading', { name: /JEPES input/ })).toBeVisible();
  // Billet accomplishments in MCO 1616.1's form, under the command input lines.
  await expect(page.getByRole('heading', { name: 'Billet accomplishments' })).toBeVisible();
  await expect(page.getByTestId('narrative')).toContainText('MOS and/or Mission Accomplishment');
  const [pdf] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export JEPES input PDF' }).click()]);
  expect(pdf.suggestedFilename()).toMatch(/vantage-jepes-input.*\.pdf$/);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export activities', exact: true }).click()]);
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
  await page.goto('/records?import=1&period=all');
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
  await page.goto('/work/tasks');
  await page.getByRole('button', { name: 'New task' }).first().click();
  const task = page.getByRole('dialog', { name: 'New task' });
  await task.getByLabel('Title').fill('Close out FY obligations');
  await task.getByLabel('Due').fill('2020-01-01');
  await task.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByRole('heading', { name: 'Overdue' })).toBeVisible();

  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal' }).first().click();
  const goal = page.getByRole('dialog', { name: 'New goal' });
  await goal.getByLabel('Goal', { exact: true }).fill('Log 20 entries this quarter');
  await goal.getByLabel('Target').fill('20');
  await goal.getByRole('button', { name: 'Add goal' }).click();
  await expect(page.getByRole('heading', { name: 'Log 20 entries this quarter' })).toBeVisible();

  await page.goto('/career/awards');
  await page.getByRole('button', { name: 'New award' }).first().click();
  const award = page.getByRole('dialog', { name: 'New award' });
  await award.getByLabel('Award', { exact: true }).fill('Navy and Marine Corps Achievement Medal');
  await award.getByRole('button', { name: 'Add award' }).click();
  await expect(page.getByRole('heading', { name: 'Navy and Marine Corps Achievement Medal' })).toBeVisible();

  await page.goto('/');
  await expect(page.getByText('Close out FY obligations').first()).toBeVisible();
  await page.goto('/goals');
  await expect(page.getByRole('heading', { name: 'Log 20 entries this quarter' })).toBeVisible();
});

test('F15, KB-06, KB-08, KB-14: an empty form says what is missing at the field, and closing gives focus back', async ({ page }) => {
  // Log activity, opened with N: an empty save marks the text box, and closing goes back to the Log activity button.
  await page.goto('/record/activities');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.keyboard.press('n');
  const log = page.getByRole('dialog', { name: 'Log activity' });
  await expect(log).toBeVisible();
  await log.getByRole('button', { name: 'Save activity' }).click();
  await refusedAt(page, log.getByLabel('What did you do?'), 'Give the entry a title before saving.');
  await page.keyboard.press('Escape');
  await expect(log).toBeHidden();
  const logButton = page.locator('button[aria-label="Log activity"]').filter({ visible: true }).first();
  await expect(logButton).toBeFocused();
  // Opened from that button, it gives focus back to it.
  await page.keyboard.press('Enter');
  await expect(log).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(logButton).toBeFocused();

  // An activity with no title.
  await page.goto('/records?period=all');
  const newActivity = page.getByRole('button', { name: 'New activity' });
  await newActivity.click();
  const activity = page.getByRole('dialog', { name: 'New activity' });
  await activity.getByRole('button', { name: 'Add activity' }).click();
  await refusedAt(page, activity.getByLabel('Title'), 'A title is required.');
  await page.keyboard.press('Escape');
  await expect(activity).toBeHidden();
  await expect(newActivity).toBeFocused();

  // Training, an award and a goal with nothing in their required fields.
  await page.goto('/career/training');
  await page.getByRole('button', { name: 'New training' }).first().click();
  const training = page.getByRole('dialog', { name: 'New training' });
  await training.getByRole('button', { name: 'Add training' }).click();
  await refusedAt(page, training.getByLabel('Title'), 'A title is required.');
  await page.keyboard.press('Escape');

  await page.goto('/career/awards');
  await page.getByRole('button', { name: 'New award' }).first().click();
  const award = page.getByRole('dialog', { name: 'New award' });
  // The citation is named by its visible label, not by its placeholder.
  await expect(award.getByRole('textbox', { name: 'Citation' })).toBeVisible();
  await award.getByRole('button', { name: 'Add award' }).click();
  await refusedAt(page, award.getByLabel('Award', { exact: true }), 'The award name is required.');
  await page.keyboard.press('Escape');

  await page.goto('/goals');
  await page.getByRole('button', { name: 'New goal' }).first().click();
  const goal = page.getByRole('dialog', { name: 'New goal' });
  await goal.getByRole('button', { name: 'Add goal' }).click();
  await refusedAt(page, goal.getByLabel('Goal', { exact: true }), 'A title is required.');
});

test('F10: a page draws its first frame in the accent Settings shows as the default', async ({ browser }) => {
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto('/login');
  await expect(fresh.locator('html')).toHaveAttribute('data-accent', 'cobalt');
  await context.close();
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
  const paint = () => page.evaluate(() => ({
    page: getComputedStyle(document.body).backgroundColor,
    rail: getComputedStyle(document.querySelector('aside') || document.body).backgroundColor,
  }));
  const before = await paint();
  await page.getByRole('button', { name: /Scarlet/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'scarlet');
  await expect.poll(async () => (await paint()).page).not.toBe(before.page);
  expect((await paint()).rail).not.toBe(before.rail);
});
