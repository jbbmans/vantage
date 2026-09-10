import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, unique, OPERATOR } from './fixtures';

test.beforeEach(async ({ page, request }) => { await ensureSetup(request); await loginAs(page, OPERATOR.username); });

const EML = [
  'From: "Dana Rowe" <dana.rowe@dfas.mil>',
  'To: boletz@example.mil',
  'Subject: RE: Aged obligation review',
  'Date: Mon, 12 May 2025 09:14:00 -0400',
  // Threading and de-duplication follow this id, never the subject line, which anyone can retype.
  'Message-ID: <8f31c0e4-review@dfas.mil>',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Pulled the file. <img src="https://tracker.example.com/pixel.gif"><script>alert(1)</script></p>',
  '',
].join('\r\n');

test('a thread records a reply, the knowledge, and the close as three separate facts', async ({ page }) => {
  const subject = unique('Aged obligation review ');
  await page.goto('/correspondence');
  await page.getByRole('button', { name: 'New thread' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New thread' });
  await dialog.getByLabel('Subject').fill(subject);
  await dialog.getByRole('button', { name: 'Start thread' }).click();

  const drawer = page.getByRole('dialog', { name: subject });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('Written, not sent.')).toBeVisible();

  await drawer.getByRole('button', { name: 'Sent', exact: true }).click();
  await drawer.getByRole('button', { name: 'Response received' }).click();
  await expect(drawer.getByText('Somebody replied. It may not have answered anything.')).toBeVisible();

  // A reply is not the knowledge, and the knowledge is not a closed matter: each gets its own date.
  await expect(drawer.getByRole('term').filter({ hasText: 'Response received' })).toBeVisible();
  await expect(drawer.getByRole('definition').filter({ hasText: 'Not yet' })).toHaveCount(2);

  await drawer.getByRole('button', { name: 'KSD received' }).click();
  await drawer.getByRole('button', { name: 'Resolved' }).click();
  await expect(drawer.getByRole('definition').filter({ hasText: 'Not yet' })).toHaveCount(0);
});

test('an imported email is stripped of what could run and of images loaded from elsewhere', async ({ page }) => {
  const subject = unique('Import check ');
  await page.goto('/correspondence');
  await page.getByRole('button', { name: 'New thread' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New thread' });
  await dialog.getByLabel('Subject').fill(subject);
  await dialog.getByRole('button', { name: 'Start thread' }).click();

  const drawer = page.getByRole('dialog', { name: subject });
  await drawer.getByRole('button', { name: 'Import .eml' }).click();
  await drawer.locator('input[type=file]').setInputFiles({ name: 'reply.eml', mimeType: 'message/rfc822', buffer: Buffer.from(EML) });

  await expect(drawer.getByText('Pulled the file.')).toBeVisible();
  await expect(drawer.getByText('Images from elsewhere were not loaded.')).toBeVisible();
  await expect(drawer.getByText('Something that could run was removed.')).toBeVisible();
  await expect(drawer.getByText('alert(1)')).toHaveCount(0);

  // The same file again is the same email, not a second one.
  await drawer.locator('input[type=file]').setInputFiles({ name: 'reply.eml', mimeType: 'message/rfc822', buffer: Buffer.from(EML) });
  await expect(page.getByRole('status').filter({ hasText: 'already on this thread' })).toBeVisible();
  await expect(drawer.getByText('Pulled the file.')).toHaveCount(1);
});

test('a mailbox is named with its cloud, and nothing is read until it is authorized', async ({ page }) => {
  await page.goto('/correspondence?tab=mailboxes');
  await page.getByLabel('Mailbox name').fill(unique('G-8 inbox '));
  await page.getByRole('button', { name: 'Add mailbox' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Nothing is read until it is authorized' })).toBeVisible();

  await page.getByRole('button', { name: 'What it would ask for' }).first().click();
  // The US-Gov cloud is its own tenant with its own endpoints, never the commercial ones.
  await expect(page.getByText('https://login.microsoftonline.us/organizations/oauth2/v2.0/authorize')).toBeVisible();
  await expect(page.getByText('https://graph.microsoft.us/v1.0/me/messages/delta')).toBeVisible();
  await expect(page.getByText('https://graph.microsoft.us/Mail.Read', { exact: false })).toBeVisible();
});
