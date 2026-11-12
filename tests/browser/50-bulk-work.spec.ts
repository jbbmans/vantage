import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

const H = { 'x-vantage-client': '1' };
test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

for (const width of [1280, 390]) {
  test(`selected work is previewed and claimed at width ${width}, with the dialog usable from the keyboard`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const reference = `BULK-${crypto.randomUUID()}`;
    const made = await page.request.post('/api/work/items', { headers: H, data: { unit_id: 'G8', title: 'Synthetic bulk browser check', reference } });
    expect(made.ok(), await made.text()).toBeTruthy();
    const item = await made.json();
    await page.goto('/work/queue');
    await page.getByLabel('Search the queue').fill(reference);
    await page.getByRole('checkbox', { name: `Select ${reference}` }).check();
    await page.getByRole('button', { name: 'Update selected', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Update selected work' });
    await dialog.getByLabel('Bulk action').click();
    await page.getByRole('option', { name: 'Claim for myself' }).click();
    await dialog.getByRole('button', { name: 'Preview changes' }).click();
    await expect(dialog.getByText('1 ready · 0 cannot be changed')).toBeVisible();
    const before = await (await page.request.get(`/api/work/items/${item.id}`)).json();
    expect(before.item.claimed_by).toBeNull();
    await page.keyboard.press('Tab');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply to 1 case' }).click();
    await expect(dialog.getByText('1 applied · 0 not changed')).toBeVisible();
    await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
    const after = await (await page.request.get(`/api/work/items/${item.id}`)).json();
    expect(after.item.claimed_by).toBeTruthy();
    expect(after.case.events.filter((e: { kind: string }) => e.kind === 'claimed')).toHaveLength(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
  });
}

test('a case changed after preview is refused and remains selected for review', async ({ page }) => {
  const reference = `STALE-${crypto.randomUUID()}`;
  const made = await page.request.post('/api/work/items', { headers: H, data: { unit_id: 'G8', title: 'Synthetic concurrent change', reference } });
  const item = await made.json();
  await page.goto('/work/queue');
  await page.getByLabel('Search the queue').fill(reference);
  await page.getByRole('checkbox', { name: `Select ${reference}` }).check();
  await page.getByRole('button', { name: 'Update selected', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Update selected work' });
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
