import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

const H = { 'x-vantage-client': '1' };
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

async function seedRecord(page: any, title: string, extra: Record<string, unknown> = {}) {
  const res = await page.request.post('/api/records/activities', {
    headers: H,
    data: { title, visibility: 'private', date: daysAgo(3), quantity: 8, unit_label: 'studio-items', ...extra },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

test('a report is written against chosen records and saved as a revision', async ({ page }) => {
  await seedRecord(page, 'Reconciled the aged obligations');

  await page.goto('/studio');
  await page.getByRole('button', { name: 'New report' }).click();
  const start = page.getByRole('dialog', { name: 'Start a report' });
  await start.getByLabel('Title').fill('Studio walkthrough');
  await start.getByRole('button', { name: 'Start' }).click();

  await expect(page.getByText('Not saved yet. Pick the records this report is built from, then save a revision.')).toBeVisible();
  await page.getByRole('button', { name: 'Choose', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose the records this report cites' });
  await picker.getByText('Reconciled the aged obligations').click();
  await picker.getByRole('button', { name: /Use 1 selected/ }).click();

  await page.getByLabel('Mission accomplishment text').fill('Reconciled every aged obligation before the fiscal year closed.');
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByText('Saved as a new revision.')).toBeVisible();
  await expect(page.getByText('Saved through revision 1.')).toBeVisible();
});

test('a save is refused when a cited record changed, and goes through once the author has read it', async ({ page }) => {
  const record = await seedRecord(page, 'A record that will move');
  const draft = await (await page.request.post('/api/studio/reports', {
    headers: H, data: { title: 'Drift check', period_start: daysAgo(30), period_end: today() },
  })).json();

  await page.goto('/studio');
  await page.getByText('Drift check').click();
  await page.getByRole('button', { name: 'Choose', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose the records this report cites' });
  await picker.getByText('A record that will move').click();
  await picker.getByRole('button', { name: /Use 1 selected/ }).click();
  await page.getByLabel('Mission accomplishment text').fill('A claim about the record that is about to move.');

  // The record is edited elsewhere while the author is still typing.
  const edited = await page.request.put(`/api/records/activities/${record.id}`, { headers: H, data: { quantity: 400, version: record.version } });
  expect(edited.ok(), await edited.text()).toBeTruthy();

  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('alert').getByText('This was not saved')).toBeVisible();
  await expect(page.getByText(/facts changed after this wording was written/i)).toBeVisible();

  await page.getByRole('button', { name: 'I have read the updated facts' }).click();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByText('Saved as a new revision.')).toBeVisible();
  void draft;
});

test('an exported revision carries the facts as they were, not as they are now', async ({ page }) => {
  const record = await seedRecord(page, 'Original wording of the source', { quantity: 11 });
  const draft = await (await page.request.post('/api/studio/reports', {
    headers: H, data: { title: 'Export check', period_start: daysAgo(30), period_end: today() },
  })).json();
  const saved = await page.request.post(`/api/studio/reports/${draft.id}/revisions`, {
    headers: H,
    data: { sections: [{ heading: 'Mission', body: 'Eleven items handled.', source_ids: [] }], sources: [{ table: 'activities', id: record.id, version: record.version }] },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();

  await page.request.put(`/api/records/activities/${record.id}`, { headers: H, data: { title: 'Rewritten later', quantity: 900, version: record.version } });

  const exported = await page.request.get(`/api/studio/reports/${draft.id}/revisions/1/export.txt`, { headers: H });
  const text = await exported.text();
  expect(text).toContain('Eleven items handled.');
  expect(text).toContain('Original wording of the source');
  expect(text).not.toContain('Rewritten later');
  expect(text).not.toContain('900');
});

test('a typed goal tracks itself and opens into what counted', async ({ page }) => {
  await seedRecord(page, 'First goal contribution', { quantity: 6, unit_label: 'goal-checks' });
  await seedRecord(page, 'Second goal contribution', { quantity: 4, unit_label: 'goal-checks' });

  const created = await page.request.post('/api/records/goals', {
    headers: H,
    data: {
      title: 'Twenty goal-checks this quarter', status: 'active', visibility: 'private',
      period_start: daysAgo(60), period_end: today(),
      metric_id: 'quantity:goal-check', direction: 'increase', baseline_value: 0, target_value: 20, unit_label: 'goal-checks',
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto('/goals');
  const card = page.getByRole('article').filter({ hasText: 'Twenty goal-checks this quarter' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('10 goal-checks');
  await expect(card).toContainText('50%');

  await card.getByRole('button', { name: 'What counted?' }).click();
  const dialog = page.getByRole('dialog', { name: /What counted toward/ });
  await expect(dialog.getByText('First goal contribution')).toBeVisible();
  await expect(dialog.getByText('Second goal contribution')).toBeVisible();
  await expect(dialog.getByText(/2 outcomes, 10 in total/)).toBeVisible();
});

test('a goal recorded before typed goals says plainly that it counts entries', async ({ page, request }) => {
  await ensureSetup(request);
  const created = await page.request.post('/api/records/goals', {
    headers: H,
    data: { title: 'An older goal', status: 'active', visibility: 'private', metric: 'activity_count', current_value: 12, target_value: 50, period_start: daysAgo(60), period_end: today() },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto('/goals');
  const card = page.getByRole('article').filter({ hasText: 'An older goal' });
  await expect(card).toContainText('counts entries, not outcomes');
  await expect(card.getByRole('button', { name: 'What counted?' })).toHaveCount(0);
});
