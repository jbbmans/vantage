import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

const H = { 'x-vantage-client': '1' };

test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

test('a figure on the dashboard opens into the outcomes behind it', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  const titles = ['Cleared eleven unliquidated obligations', 'Cleared seven more unliquidated obligations'];
  for (const [i, title] of titles.entries()) {
    const res = await page.request.post('/api/records/activities', {
      headers: H,
      data: { title, visibility: 'unit', date: today, quantity: i === 0 ? 11 : 7, unit_label: 'drilldown-ULOs' },
    });
    expect(res.ok(), await res.text()).toBeTruthy();
  }

  await page.goto('/');
  const card = page.getByRole('button', { name: /drilldown-ULOs/ }).first();
  await expect(card).toBeVisible();
  // Eleven and seven are eighteen, counted once each.
  await expect(card).toContainText('18');
  await expect(card).toContainText('2 outcomes');

  await card.click();
  const dialog = page.getByRole('dialog', { name: /What counted toward drilldown-ULOs/ });
  await expect(dialog).toBeVisible();
  for (const title of titles) await expect(dialog.getByText(title)).toBeVisible();

  // The drill-down is a way back to the record itself.
  await dialog.getByText(titles[0]).click();
  await expect(page.getByRole('heading', { name: titles[0] })).toBeVisible();
});

test('a value type the instance excludes from the headline is reported on its own', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  const res = await page.request.post('/api/records/activities', {
    headers: H,
    data: { title: 'Reviewed a funding document', visibility: 'unit', date: today, dollar_amount: 250_000, dollar_type: 'reviewed' },
  });
  expect(res.ok(), await res.text()).toBeTruthy();

  await page.goto('/');
  const card = page.getByRole('button', { name: /Reviewed/ }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Tracked on its own');
});
