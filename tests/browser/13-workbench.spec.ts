import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

const H = { 'x-vantage-client': '1' };
const serious = (violations: Array<{ impact?: string | null; id: string; nodes: unknown[] }>) => violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
const axe = async (page: Page) => serious((await new AxeBuilder({ page }).exclude('[data-radix-popper-content-wrapper]').analyze()).violations);
const noSidewaysScroll = async (page: Page, what: string) => {
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, `${what} scrolls sideways`).toBeLessThanOrEqual(width + 1);
};

const CSV = [
  'Document,Description,Due,Amount,Type,Status',
  'WB-100,Clear a long-standing obligation,2026-06-30,1118.38,saved,Open',
  'WB-101,Reconcile a reimbursable order,2026-07-15,25000,reconciled,In progress',
  'WB-102,Chase a missing supporting document,2026-08-01,,,Waiting',
].join('\n');

// Contrast is measured on the page at rest, not halfway through a fade.
test.use({ contextOptions: { reducedMotion: 'reduce' } });
test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

test('a spreadsheet is imported through the wizard, and the preview is shown before anything is written', async ({ page }) => {
  await page.goto('/work/queue');
  await page.getByRole('button', { name: 'Import work' }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/original file is kept unchanged/i)).toBeVisible();

  await page.getByLabel('Spreadsheet to import').setInputFiles({ name: 'queue.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });

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
  await page.goto('/work/queue');
  const row = page.getByRole('row').filter({ hasText: 'WB-100' }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Claim' }).click();
  await expect(page.getByText(/You picked up WB-100/)).toBeVisible();

  await page.getByText('Clear a long-standing obligation').first().click();
  await expect(page).toHaveURL(/\/work\/items\//);
  await expect(page.getByRole('heading', { name: 'Clear a long-standing obligation', level: 1 })).toBeVisible();
  await expect(page.getByText('Everything the source said')).toBeVisible();
  const detail = page.getByRole('region', { name: 'What did you do?' });

  await detail.getByLabel('How many').fill('12');
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
  await page.goto('/work/queue');
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

test('KB-10/F5: the queue is one table, sorted from its headers without losing focus, each case a link and each checkbox named', async ({ page }) => {
  await page.goto('/work/queue');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: 'WB-101', exact: true })).toBeVisible();
  // One table: the header row stays at the top while the rows scroll, so each cell is read with its column.
  await expect(main.getByRole('table')).toHaveCount(1);
  await expect(main.getByRole('region', { name: 'Work queue rows' }).getByRole('table')).toHaveCount(1);

  const due = main.getByRole('columnheader', { name: 'Sort by Due' });
  const documents = main.getByRole('columnheader', { name: 'Sort by Document' });
  await expect(due).toHaveAttribute('aria-sort', 'ascending');
  await expect(documents).toHaveAttribute('aria-sort', 'none');
  await expect(main.getByRole('columnheader', { name: 'Held by' })).not.toHaveAttribute('aria-sort');

  // Sorting keeps the rows in place while the next order loads, so the header pressed keeps focus.
  const sort = main.getByRole('button', { name: 'Sort by Document' });
  await sort.focus();
  await page.keyboard.press('Enter');
  await expect(documents).toHaveAttribute('aria-sort', 'ascending');
  await expect(due).toHaveAttribute('aria-sort', 'none');
  await expect(sort).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(documents).toHaveAttribute('aria-sort', 'descending');
  await expect(sort).toBeFocused();
  await expect(main.getByRole('region', { name: 'Work queue rows' })).not.toHaveAttribute('aria-busy');
  await expect(main.getByRole('table')).toHaveCSS('opacity', '1');

  // A checkbox says which case it selects.
  await expect(main.getByRole('checkbox', { name: 'Select WB-101, Reconcile a reimbursable order' })).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await noSidewaysScroll(page, 'the queue');

  // The identifier is a link: Tab reaches it, a screen reader lists it, and Enter opens the case.
  await main.getByRole('link', { name: 'WB-101', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/work\/items\//);
  await expect(page.getByRole('heading', { name: 'Reconcile a reimbursable order', level: 1 })).toBeVisible();
});

test('KB-03: the queue’s single keys act only in its rows, and not at all once shortcuts are off', async ({ page }) => {
  const claims: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/api\/work\/items\/[^/]+\/claim$/.test(new URL(r.url()).pathname)) claims.push(r.url()); });
  await page.goto('/work/queue');
  const main = page.getByRole('main');
  const hint = main.getByText('In the rows, j and k move, space selects, Enter opens, c claims.');
  const first = main.getByRole('link', { name: 'WB-101', exact: true });
  await expect(first).toBeVisible();
  await expect(hint).toBeVisible();

  // Outside the rows a letter is only a letter: nothing on the page, and nothing in the buttons above them, claims.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('c');
  await main.getByRole('button', { name: 'Mine' }).focus();
  await page.keyboard.press('c');
  await page.keyboard.press('j');
  await expect(main.getByRole('button', { name: 'Mine' })).toBeFocused();
  await page.waitForTimeout(300);
  expect(claims).toEqual([]);

  // In the rows, j moves focus to the next case, and c claims the case in focus.
  const index = Number(await main.getByRole('row').filter({ has: page.getByRole('link', { name: 'WB-101', exact: true }) }).getAttribute('data-index'));
  await first.focus();
  await page.keyboard.press('j');
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest('tr')?.getAttribute('data-index'))).toBe(String(index + 1));
  const next = await page.evaluate(() => document.activeElement?.textContent ?? '');
  await page.keyboard.press('c');
  await expect(page.getByText(`You picked up ${next}`)).toBeVisible();
  expect(claims).toHaveLength(1);

  try {
    // Turned off, the queue's keys are gone with the rest, and so is the line that offers them.
    expect((await page.request.put('/api/me/prefs', { headers: H, data: { shortcuts: false } })).ok()).toBeTruthy();
    await page.reload();
    await expect(first).toBeVisible();
    await expect(hint).toHaveCount(0);
    await first.focus();
    await page.keyboard.press('c');
    await page.keyboard.press('j');
    await expect(first).toBeFocused();
    await page.waitForTimeout(300);
    expect(claims).toHaveLength(1);
  } finally {
    await page.request.put('/api/me/prefs', { headers: H, data: { shortcuts: true } });
  }
});
