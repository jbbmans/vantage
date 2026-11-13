import { test, expect, type Page } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

const H = { 'x-vantage-client': '1' };
test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

async function makeCase(page: Page, reference: string, extra: Record<string, unknown> = {}) {
  const made = await page.request.post('/api/work/items', { headers: H, data: { unit_id: 'G8', title: 'Synthetic bulk browser check', reference, ...extra } });
  expect(made.ok(), await made.text()).toBeTruthy();
  return made.json();
}

/** Searches the queue and selects the listed cases. The search waits 250 ms after typing, so this waits for the list to
 *  narrow first: a row checked before then would be cleared when the search lands. */
async function selectFromSearch(page: Page, search: string, references: string[]) {
  await page.goto('/work/queue');
  await page.getByLabel('Search the queue').fill(search);
  await expect(page.getByRole('checkbox', { name: /^Select / })).toHaveCount(references.length);
  for (const reference of references) await page.getByRole('checkbox', { name: `Select ${reference}` }).check();
  await page.getByRole('button', { name: 'Update selected', exact: true }).click();
  return page.getByRole('dialog', { name: 'Update selected work' });
}

const claimedBy = async (page: Page, id: string) => (await (await page.request.get(`/api/work/items/${id}`)).json()).item.claimed_by;

test('selected work is previewed, then claimed from the keyboard', async ({ page }) => {
  const reference = `BULK-${crypto.randomUUID()}`;
  const item = await makeCase(page, reference);
  const dialog = await selectFromSearch(page, reference, [reference]);
  await dialog.getByLabel('Bulk action').click();
  await page.getByRole('option', { name: 'Claim for myself' }).click();
  await dialog.getByRole('button', { name: 'Preview changes' }).click();
  const summary = dialog.getByText('1 ready · 0 cannot be changed');
  await expect(summary).toBeVisible();
  // The Preview button is gone, so focus lands on what the preview found rather than on the dialog box.
  await expect(summary).toBeFocused();
  expect(await claimedBy(page, item.id)).toBeNull();
  const apply = dialog.getByRole('button', { name: 'Apply to 1 case' });
  await expect(apply).toBeEnabled();
  for (let i = 0; i < 6 && !(await apply.evaluate((el) => el === document.activeElement)); i += 1) await page.keyboard.press('Tab');
  await expect(apply).toBeFocused();
  await page.keyboard.press('Enter');
  const done = dialog.getByText('1 applied · 0 not changed');
  await expect(done).toBeVisible();
  await expect(done).toBeFocused();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  const after = await (await page.request.get(`/api/work/items/${item.id}`)).json();
  expect(after.item.claimed_by).toBeTruthy();
  expect(after.case.events.filter((e: { kind: string }) => e.kind === 'claimed')).toHaveLength(1);
});

test.describe('on a touch phone', () => {
  test.use({ viewport: { width: 412, height: 839 }, hasTouch: true, isMobile: true });

  test('a double tap on Preview does not apply the change', async ({ page }) => {
    const reference = `TAP-${crypto.randomUUID()}`;
    const item = await makeCase(page, reference);
    const dialog = await selectFromSearch(page, reference, [reference]);
    await dialog.getByLabel('Bulk action').click();
    await page.getByRole('option', { name: 'Claim for myself' }).click();
    const box = (await dialog.getByRole('button', { name: 'Preview changes' }).boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.touchscreen.tap(x, y);
    await page.waitForTimeout(150);
    await page.touchscreen.tap(x, y);
    await expect(dialog.getByText('1 ready · 0 cannot be changed')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await claimedBy(page, item.id)).toBeNull();
    await expect(dialog.getByText(/ applied · /)).toHaveCount(0);
    // Once the preview has been on screen for a moment, a tap on Apply goes through.
    const apply = dialog.getByRole('button', { name: 'Apply to 1 case' });
    await expect(apply).toBeEnabled();
    await apply.tap();
    await expect(dialog.getByText('1 applied · 0 not changed')).toBeVisible();
    expect(await claimedBy(page, item.id)).toBeTruthy();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });
});

test('a case changed after preview is refused and remains selected for review', async ({ page }) => {
  const reference = `STALE-${crypto.randomUUID()}`;
  const item = await makeCase(page, reference);
  const dialog = await selectFromSearch(page, reference, [reference]);
  await dialog.getByLabel('Bulk action').click(); await page.getByRole('option', { name: 'Claim for myself' }).click();
  await dialog.getByRole('button', { name: 'Preview changes' }).click();
  await expect(dialog.getByText('1 ready · 0 cannot be changed')).toBeVisible();
  await page.request.post(`/api/work/items/${item.id}/claim`, { headers: H, data: { version: item.version } });
  await dialog.getByRole('button', { name: 'Apply to 1 case' }).click();
  await expect(dialog.getByText('0 applied · 1 not changed')).toBeVisible();
  await expect(dialog.getByText(/changed since selection/i)).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('checkbox', { name: `Select ${reference}` })).toBeChecked();
});

test('only the cases that passed preview are sent, and the refused one stays selected', async ({ page }) => {
  const tag = `MIX-${crypto.randomUUID()}`;
  const free = await makeCase(page, `${tag}-A`);
  const held = await makeCase(page, `${tag}-B`);
  // Holding the second case already makes "Claim for myself" refuse it in preview.
  const claimed = await page.request.post(`/api/work/items/${held.id}/claim`, { headers: H, data: { version: held.version } });
  expect(claimed.ok(), await claimed.text()).toBeTruthy();
  const dialog = await selectFromSearch(page, tag, [`${tag}-A`, `${tag}-B`]);
  await dialog.getByLabel('Bulk action').click(); await page.getByRole('option', { name: 'Claim for myself' }).click();
  const sent: Array<{ items: Array<{ id: string }> }> = [];
  page.on('request', (req) => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/work/bulk') sent.push(req.postDataJSON()); });
  await dialog.getByRole('button', { name: 'Preview changes' }).click();
  await expect(dialog.getByText('1 ready · 1 cannot be changed')).toBeVisible();
  await dialog.getByRole('button', { name: 'Apply to 1 case' }).click();
  await expect(dialog.getByText('1 applied · 1 not changed')).toBeVisible();
  await expect(dialog.getByText('You already hold this work.')).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0].items.map((i) => i.id)).toEqual([free.id]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(page.getByRole('checkbox', { name: `Select ${tag}-B` })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: `Select ${tag}-A` })).not.toBeChecked();
});

test('a resolved case its holder still holds offers no Release in the queue', async ({ page }) => {
  const reference = `DONE-${crypto.randomUUID()}`;
  const item = await makeCase(page, reference);
  const claimed = await page.request.post(`/api/work/items/${item.id}/claim`, { headers: H, data: { version: item.version } });
  expect(claimed.ok(), await claimed.text()).toBeTruthy();
  const resolved = await page.request.patch(`/api/work/items/${item.id}`, { headers: H, data: { state: 'resolved', version: (await claimed.json()).version } });
  expect(resolved.ok(), await resolved.text()).toBeTruthy();
  expect(await claimedBy(page, item.id)).toBeTruthy();
  await page.goto('/work/queue');
  await page.getByRole('group', { name: 'Whose work' }).getByRole('button', { name: 'Resolved', exact: true }).click();
  await page.getByLabel('Search the queue').fill(reference);
  await expect(page.getByRole('checkbox', { name: /^Select / })).toHaveCount(1);
  const row = page.getByRole('row').filter({ hasText: reference });
  await expect(row).toBeVisible();
  // The server refuses to release a closed case, so the queue does not offer it (the case page already did not).
  await expect(row.getByRole('button', { name: 'Release' })).toHaveCount(0);
});

test('only the timed refresh is marked background, and the keyboard cursor stays on its case when rows shift', async ({ page }) => {
  await page.clock.install();
  const tag = `CUR-${crypto.randomUUID()}`;
  await makeCase(page, `${tag}-A`, { due_date: '2031-03-01' });
  const target = await makeCase(page, `${tag}-C`, { due_date: '2031-03-03' });
  const reads: Array<{ background: boolean }> = [];
  page.on('request', (req) => {
    if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/work/items') reads.push({ background: req.headers()['x-vantage-background'] === '1' });
  });
  await page.goto('/work/queue');
  const search = page.getByLabel('Search the queue');
  await search.fill(tag);
  await expect(page.getByRole('checkbox', { name: /^Select / })).toHaveCount(2);
  // Loading the queue and searching it are a person's own reads: they keep the session alive.
  expect(reads.length).toBeGreaterThan(0);
  expect(reads.every((read) => !read.background)).toBeTruthy();
  await search.press('Escape');
  await page.keyboard.press('j');
  // A case due earlier arrives, so every row shifts down by one.
  await makeCase(page, `${tag}-B`, { due_date: '2031-02-01' });
  const before = reads.length;
  const refreshed = page.waitForResponse((res) => new URL(res.url()).pathname === '/api/work/items' && res.request().headers()['x-vantage-background'] === '1');
  await page.clock.fastForward(31_000);
  await refreshed;
  await expect(page.getByRole('checkbox', { name: /^Select / })).toHaveCount(3);
  expect(reads.slice(before).length).toBeGreaterThan(0);
  expect(reads.slice(before).every((read) => read.background)).toBeTruthy();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/work/items/${target.id}$`));
});
