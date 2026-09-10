import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

const H = { 'x-vantage-client': '1' };

const CSV = [
  'Document,Description,Due,Amount,Type,Status',
  'WB-100,Clear a long-standing obligation,2026-06-30,1118.38,saved,Open',
  'WB-101,Reconcile a reimbursable order,2026-07-15,25000,reconciled,In progress',
  'WB-102,Chase a missing supporting document,2026-08-01,,,Waiting',
].join('\n');

test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

test('a spreadsheet is imported through the wizard, and the preview is shown before anything is written', async ({ page }) => {
  await page.goto('/queue');
  await page.getByRole('button', { name: 'Import a spreadsheet' }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/original file is kept unchanged/i)).toBeVisible();

  await page.getByLabel('Spreadsheet to import').setInputFiles({ name: 'queue.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });

  // Step two: the file is scanned (or honestly reported as unscanned) and the sheet is previewed.
  await expect(dialog.getByText(/no malware scanner is configured/i)).toBeVisible();
  await expect(dialog.getByLabel('Heading row')).toHaveValue('1');
  await dialog.getByRole('button', { name: 'Next' }).click();

  // Step three: the mapping, guessed from the headings and correctable.
  await expect(dialog.getByLabel('Which column identifies each row')).toBeVisible();
  await dialog.getByRole('button', { name: 'Preview' }).click();

  // Step four: exactly what will happen, before it happens.
  await expect(dialog.getByText('New', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Import 3 rows/ })).toBeVisible();
  await dialog.getByRole('button', { name: /Import 3 rows/ }).click();
  await expect(dialog.getByText(/3 new, 0 updated/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Open the queue' }).click();

  await expect(page.getByText('WB-100')).toBeVisible();
  await expect(page.getByText('Clear a long-standing obligation')).toBeVisible();
});

test('the same file imported again changes nothing', async ({ page }) => {
  const upload = async () => {
    const res = await page.request.post('/api/work/sources', {
      headers: { ...H, 'content-type': 'text/csv', 'x-filename': 'queue.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' },
      data: CSV,
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()).id as string;
  };
  const plan = (id: string) => ({
    source_file_id: id, sheet_name: 'queue.csv', header_row: 1, key_columns: ['Document'], unit_id: 'G8', visibility: 'unit',
    mapping: { Document: 'reference', Description: 'title', Due: 'due_date', Amount: 'amount', Type: 'amount_type', Status: 'state' },
  });

  const first = await page.request.post('/api/work/imports', { headers: H, data: plan(await upload()) });
  const firstJob = await first.json();
  const second = await page.request.post('/api/work/imports', { headers: H, data: plan(await upload()) });
  const secondJob = await second.json();

  expect(secondJob.inserted_rows).toBe(0);
  expect(secondJob.updated_rows).toBe(0);
  expect(secondJob.unchanged_rows).toBe(firstJob.inserted_rows + firstJob.unchanged_rows);
});

test('a row is claimed, worked and recorded, and the outcome reaches the dashboard once', async ({ page }) => {
  await page.goto('/queue');
  const row = page.getByRole('row').filter({ hasText: 'WB-100' }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Claim' }).click();
  await expect(page.getByText(/You picked up WB-100/)).toBeVisible();

  await page.getByText('Clear a long-standing obligation').first().click();
  const detail = page.getByRole('dialog', { name: 'WB-100' });
  await expect(detail).toBeVisible();
  await expect(detail.getByText('Everything the source said')).toBeVisible();

  await detail.getByLabel('How many').fill('12');
  // A unit label unique to this spec, so the figure cannot be confused with another spec's work.
  await detail.getByLabel('Of what').fill('workbench-ULOs');
  await detail.getByLabel(/moved$/).fill('1118.38');
  await detail.getByLabel('Which kind of value').click();
  await page.getByRole('option', { name: 'Saved' }).click();
  await detail.getByLabel('What happened').fill('Confirmed the supporting document and released the balance.');
  await detail.getByLabel('This closes it out').check();
  await detail.getByRole('button', { name: 'Record what you did' }).click();
  await expect(page.getByText(/added to your own record/i)).toBeVisible();

  await page.goto('/');
  const ulos = page.getByRole('button', { name: /workbench-ULOs/ }).first();
  await expect(ulos).toBeVisible();
  await expect(ulos).toContainText('12');
  await expect(ulos).toContainText('1 outcome');

  // The figure opens onto the record the work drafted, rather than being a number with no source.
  await ulos.click();
  const drill = page.getByRole('dialog', { name: /What counted toward workbench-ULOs/ });
  await expect(drill.getByText('Clear a long-standing obligation')).toBeVisible();
});

test('an identifier the spreadsheet mangled is refused with the reason, not repaired', async ({ page }) => {
  const damaged = ['Document,Description', '1.23457E+14,A number Excel turned into a float', 'FINE-1,A row that is fine'].join('\n');
  const res = await page.request.post('/api/work/sources', {
    headers: { ...H, 'content-type': 'text/csv', 'x-filename': 'damaged.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' },
    data: damaged,
  });
  const source = await res.json();
  const preview = await page.request.post('/api/work/imports/preview', {
    headers: H,
    data: { source_file_id: source.id, sheet_name: 'damaged.csv', header_row: 1, key_columns: ['Document'], unit_id: 'G8', visibility: 'unit', mapping: { Document: 'reference', Description: 'title' } },
  });
  const body = await preview.json();
  expect(body.will_insert).toHaveLength(1);
  expect(body.rejections).toHaveLength(1);
  expect(body.rejections[0].reason).toMatch(/scientific notation/i);
  expect(JSON.stringify(body)).not.toMatch(/123457000000000/);
});

test('the queue is keyboard-navigable and a selection copies as pasteable rows', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/queue');
  await expect(page.getByText('WB-101')).toBeVisible();

  await page.getByRole('region', { name: 'Work queue rows' }).or(page.locator('[aria-label="Work queue rows"]')).first().click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press('Escape');
  await page.keyboard.press('j');
  await page.keyboard.press(' ');
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByText(/1 row copied/)).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard.split('\n')[0]).toContain('Identifier\tWhat it is');
  expect(clipboard.split('\n')).toHaveLength(2);
});
