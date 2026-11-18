import { test, expect, request as playwrightRequest } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { ensureSetup, joinUnit, loginAs, logout, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

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

  await page.goto('/reports');
  await page.getByRole('button', { name: 'New report' }).first().click();
  const start = page.getByRole('dialog', { name: 'New report' });
  await start.getByLabel('Title').fill('Studio walkthrough');
  // A record from three days ago is in the last 90 days whatever the date; this quarter can have begun since.
  await start.getByRole('combobox').click();
  await page.getByRole('option', { name: 'Last 90 days' }).click();
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

  await page.goto('/reports');
  await page.getByText('Drift check').click();
  await page.getByRole('button', { name: 'Choose', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose the records this report cites' });
  await picker.getByText('A record that will move').click();
  await picker.getByRole('button', { name: /Use 1 selected/ }).click();
  await page.getByLabel('Mission accomplishment text').fill('A claim about the record that is about to move.');

  // The record is edited elsewhere while the author is still typing.
  const edited = await page.request.put(`/api/records/activities/${record.id}`, { headers: H, data: { quantity: 400, version: record.version } });
  expect(edited.ok(), await edited.text()).toBeTruthy();

  // Checking a cited entry opens it beside the writing, as it is now, and leaves the text alone.
  await page.getByRole('button', { name: 'A record that will move', exact: true }).click();
  const peek = page.getByRole('dialog', { name: 'A record that will move' });
  await expect(peek.getByText('This changed after you cited it.', { exact: false })).toBeVisible();
  await expect(peek.getByText('400 studio-items')).toBeVisible();
  await peek.getByRole('button', { name: 'Back to writing' }).click();
  await expect(peek).toHaveCount(0);
  await expect(page.getByLabel('Mission accomplishment text')).toHaveValue('A claim about the record that is about to move.');

  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('alert').getByText('This was not saved')).toBeVisible();
  await expect(page.getByText(/facts changed after this wording was written/i)).toBeVisible();

  // It changes once more after the refusal: reading the facts reads them as they are now, not as the refusal saw them.
  const again = await page.request.put(`/api/records/activities/${record.id}`, { headers: H, data: { quantity: 401, version: record.version + 1 } });
  expect(again.ok(), await again.text()).toBeTruthy();

  await page.getByRole('button', { name: 'I have read the updated facts' }).click();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByText('Saved as a new revision.')).toBeVisible();
  void draft;
});

test('a cited record deleted while the author writes stops being cited once they have read it, so the save goes through', async ({ page }) => {
  await seedRecord(page, 'A record that stays cited');
  const gone = await seedRecord(page, 'A record that will be deleted');
  await (await page.request.post('/api/studio/reports', {
    headers: H, data: { title: 'Deleted source check', period_start: daysAgo(30), period_end: today() },
  })).json();

  await page.goto('/reports');
  await page.getByText('Deleted source check').click();
  await page.getByRole('button', { name: 'Choose', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Choose the records this report cites' });
  await picker.getByText('A record that stays cited').click();
  await picker.getByText('A record that will be deleted').click();
  await picker.getByRole('button', { name: /Use 2 selected/ }).click();
  await page.getByLabel('Mission accomplishment text').fill('A claim that rests on two records.');

  // The record is deleted elsewhere while the author is still typing.
  const deleted = await page.request.delete(`/api/records/activities/${gone.id}`, { headers: H });
  expect(deleted.ok(), await deleted.text()).toBeTruthy();

  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByRole('alert').getByText('This was not saved')).toBeVisible();
  await expect(page.getByText('It was deleted after you cited it.')).toBeVisible();

  // Read, the deleted record is no longer cited, and the save is not refused for it again.
  await page.getByRole('button', { name: 'I have read the updated facts' }).click();
  await expect(page.getByText('One record you cited was deleted or moved, so it is no longer cited.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Save revision' }).click();
  await expect(page.getByText('Saved as a new revision.')).toBeVisible();
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
  await expect(card).toContainText('10 of 20 goal-checks');
  await expect(card).toContainText('50%');
  // Half the target on the period's last day is behind an even pace.
  await expect(card).toContainText('Behind pace');

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

test('a report written about somebody is theirs to read, not to rewrite', async ({ page }) => {
  // The leader writes a report about a Marine in their unit.
  const subjectName = unique('subj');
  await registerAs(page, subjectName, { rank_id: 'Cpl' });
  const subject = await (await page.request.get('/api/me')).json();
  const leader = await playwrightRequest.newContext({ baseURL: page.url().replace(/^(https?:\/\/[^/]+).*$/, '$1') });
  const signedIn = await leader.post('/api/auth/login', { headers: H, data: { username: OPERATOR.username, password: PASSWORD } });
  expect(signedIn.ok(), await signedIn.text()).toBeTruthy();
  await joinUnit(leader, page.request);
  await leader.dispose();
  await logout(page);
  await loginAs(page, OPERATOR.username);

  const created = await page.request.post('/api/studio/reports', {
    headers: H,
    data: { title: 'Counseling package', subject_id: subject.user.id, unit_id: 'G8', visibility: 'unit', period_start: '2026-01-01', period_end: '2026-03-31' },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await logout(page);
  await loginAs(page, subjectName);
  await page.goto('/reports');
  await page.getByText('Counseling package').first().click();
  await expect(page.getByRole('heading', { name: 'Counseling package' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save revision' })).toBeDisabled();
});

test('RPT-14: the package list shows 100 at a time, and the rest on Show more', async ({ page }) => {
  test.setTimeout(120_000);
  await logout(page);
  await registerAs(page, unique('pager'));
  for (let start = 0; start < 101; start += 20) {
    await Promise.all(Array.from({ length: Math.min(20, 101 - start) }, async (_, k) => {
      const res = await page.request.post('/api/studio/reports', { headers: H, data: { title: `Package ${start + k + 1}`, period_start: daysAgo(30), period_end: today() } });
      expect(res.ok(), await res.text()).toBeTruthy();
    }));
  }
  await page.goto('/reports');
  const list = page.getByRole('list', { name: 'Packages' });
  await expect(list.getByRole('listitem')).toHaveCount(100);
  await expect(page.getByRole('status').filter({ hasText: 'Showing the 100 most recently changed.' })).toBeVisible();
  const more = page.getByRole('button', { name: 'Show more' });
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(list.getByRole('listitem')).toHaveCount(101);
  await expect(more).toHaveCount(0);
  // The button is gone, so the keyboard is left on the count, which says the list is whole.
  await expect(page.getByRole('status').filter({ hasText: '101 packages.' })).toBeFocused();
  const serious = (await new AxeBuilder({ page }).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id);
  expect(serious, 'the package list').toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  const [scroll, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scroll, 'the package list scrolls sideways at 390px').toBeLessThanOrEqual(width + 1);
});
