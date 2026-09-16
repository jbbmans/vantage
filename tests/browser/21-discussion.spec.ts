import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR, PASSWORD } from './fixtures';

// Mutations require the client header; a bare fetch is refused, which is the point of it.
const H = { 'content-type': 'application/json', 'x-vantage-client': '1' };

/**
 * A task and a project had no page of their own, which is why there was nowhere to hang a file or
 * ask a question. These drive the real thing: make a task, open it, talk on it, and confirm the
 * conversation is still there after a reload rather than living in component state.
 */
test('a task opens onto its own page and carries a conversation', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);

  await page.goto('/work?tab=tasks');
  await page.getByRole('button', { name: 'New task' }).click();
  const dialog = page.getByRole('dialog', { name: 'New task' });
  await dialog.waitFor();
  const title = `Reconcile the October sheet ${Date.now()}`;
  await dialog.getByLabel(/title/i).first().fill(title);
  await dialog.getByRole('button', { name: /save|create|add/i }).first().click();
  await dialog.waitFor({ state: 'hidden' });

  // The title is a link to the task's own page now, not a shortcut into an edit dialog.
  await page.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(/\/records\/tasks\/[^/]+$/);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();

  // Both panels the task was missing.
  await expect(page.getByRole('heading', { name: 'Discussion' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Files' })).toBeVisible();

  const remark = 'Starting on the first hundred rows.';
  await page.getByLabel('Write a remark').fill(remark);
  await page.getByRole('button', { name: 'Post' }).click();
  await expect(page.getByText(remark)).toBeVisible();

  // It is on the server, not in the page: a reload still shows it.
  await page.reload();
  await expect(page.getByText(remark)).toBeVisible();
});

/**
 * The rule the whole comment design rests on. A remark is exactly as visible as its host record, so
 * a second person who cannot open the record cannot read its conversation either — the API refuses
 * rather than the page merely hiding it.
 */
test('a conversation is refused to somebody who cannot read the record itself', async ({ page, browser, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);

  // A private task belonging to the operator.
  const made = await page.request.post('/api/records/tasks', {
    headers: H,
    data: { title: 'Private tasking', visibility: 'private' },
  });
  expect(made.status()).toBe(201);
  const task = await made.json();
  expect((await page.request.post(`/api/records/tasks/${task.id}/comments`, {
    headers: H, data: { body: 'A private note.' },
  })).status()).toBe(201);

  // A separate account, in its own cookie jar, gets 403 from the API itself — not a filtered list,
  // and not merely a page that declines to render the panel.
  const stranger = await browser.newContext();
  const username = `peer${Date.now()}`;
  await stranger.request.post('/api/auth/register', {
    headers: H,
    data: { username, password: PASSWORD, first_name: 'Peer', last_name: 'Tester', rank_id: 'Sgt' },
  });
  const denied = await stranger.request.get(`/api/records/tasks/${task.id}/comments`);
  expect(denied.status()).toBe(403);
  const refusedPost = await stranger.request.post(`/api/records/tasks/${task.id}/comments`, { headers: H, data: { body: 'let me in' } });
  expect(refusedPost.status()).toBe(403);
  await stranger.close();
});

/**
 * Item one, made visible: a project holds its work whether somebody typed it in or it arrived on a
 * spreadsheet. Before this the two were unrelated piles with no column joining them, so a project
 * page could not have shown a queue even if somebody had built one.
 */
test('a project page holds typed work and says where each row came from', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);

  const name = `October reconciliation ${Date.now()}`;
  const made = await page.request.post('/api/records/projects', { headers: H, data: { name, visibility: 'unit', unit_id: 'G8' } });
  expect(made.status()).toBe(201);
  const project = await made.json();

  await page.goto(`/records/projects/${project.id}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Work under this project' })).toBeVisible();

  // Scoped to the work panel: the files panel has an Add button of its own.
  const work = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Work under this project' }) });

  await work.getByRole('button', { name: 'Add' }).click();
  await work.getByLabel('What needs doing?').fill('Ring the comptroller about the mismatch');
  await work.getByRole('button', { name: 'Add', exact: true }).click();

  await expect(work.getByText('Ring the comptroller about the mismatch')).toBeVisible();
  // And it is marked as hand-entered, because that is what decides whether its fields can be edited.
  await expect(work.getByText('Typed in').first()).toBeVisible();

  // It is on the server, not in the page.
  await page.reload();
  await expect(page.getByText('Ring the comptroller about the mismatch')).toBeVisible();
});
