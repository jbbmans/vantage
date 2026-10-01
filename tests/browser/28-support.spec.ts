import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, registerAs, unique, OPERATOR } from './fixtures';

test.beforeEach(async ({ request }) => { await ensureSetup(request); });

test('somebody locked out asks for help from the sign-in page, and the owner finds it in the queue', async ({ page, browser }) => {
  const subject = unique('Locked out ');
  await page.goto('/login');
  await page.getByRole('button', { name: 'Need help?' }).click();
  await expect(page.getByRole('heading', { name: 'Ask for help' })).toBeVisible();
  await page.getByLabel('First name').fill('Ana');
  await page.getByLabel('Your email').fill('ana.locked@example.mil');
  await page.getByLabel('What is wrong').fill(subject);
  await page.getByLabel('What happened').fill('The reset link never arrives.');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your request is in' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  const owner = await (await browser.newContext()).newPage();
  await loginAs(owner, OPERATOR.username);
  await owner.goto('/support?tab=queue');
  await owner.getByRole('link', { name: subject }).click();
  await expect(owner.getByText('came from the sign-in page')).toBeVisible();
  await expect(owner.getByRole('link', { name: 'ana.locked@example.mil' })).toBeVisible();
  await owner.getByRole('button', { name: 'Take it' }).click();
  await expect(owner.getByText('You have it.')).toBeVisible();
  await owner.context().close();
});

test('a Marine asks a person, the owner answers, and the Marine reads the answer', async ({ page, browser }) => {
  const subject = unique('Export is empty ');
  await registerAs(page, unique('asker'));
  await page.goto('/support');
  await page.getByLabel('What is wrong').fill(subject);
  await page.getByLabel('What happened').fill('My data export downloads an empty zip.');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();
  const url = page.url();

  const owner = await (await browser.newContext()).newPage();
  await loginAs(owner, OPERATOR.username);
  await owner.goto(url);
  await owner.getByLabel('Your reply').fill('Try again now; the export job was stuck.');
  await owner.getByRole('button', { name: 'Send reply' }).click();
  await expect(owner.getByRole('status').filter({ hasText: 'Reply sent.' })).toBeVisible();
  await owner.context().close();

  await page.reload();
  await expect(page.getByText('Try again now; the export job was stuck.')).toBeVisible();
  await expect(page.getByText('Waiting on you')).toBeVisible();
});
