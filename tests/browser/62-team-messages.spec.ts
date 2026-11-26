import { test, expect, request as playwrightRequest, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { confirmSudoIfAsked, ensureSetup, joinUnit, loginAs, logout, registerAs, unique, OPERATOR, PASSWORD } from './fixtures';

/**
 * A leader's message to a unit, kept in Vantage (ADR-0049): the dialog takes files, asks the leader to confirm they
 * cannot be withdrawn, and shows a refusal beside what was written; the sent message opens on a page of its own for the
 * Marines it went to.
 */
const H = { 'x-vantage-client': '1' };
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n');
const CSV = Buffer.from('Document,Amount\nM1234,1200.00\n');
const AUDIENCE = { members: 3, withEmail: 2, refused: 0, appOnly: 1, emailEnabled: true, limit: 300, files: { refusal: null as string | null, byEmail: true, maxFiles: 5, maxBytes: 10 * 1024 * 1024, allowedTypes: ['application/pdf', 'image/jpeg', 'image/png', 'text/plain', 'text/csv'] } };
const axe = async (page: Page, include: string) => {
  const scan = await new AxeBuilder({ page }).include(include).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(scan.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
};

test('the dialog takes files, asks for the confirmation before Send, and shows a refusal in place', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  // This server scans nothing and names no allowed domains, so the gate the dialog reads is set here to open; the send
  // is answered with the refusal a relay without TLS gives. tests/server/teamMessages.test.ts runs the real checks.
  await page.route('**/api/org/units/G8/message', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: AUDIENCE });
      return;
    }
    const sent = route.request().postDataJSON() as { files?: Array<{ name: string; content: string }>; confirmFiles?: boolean };
    expect(sent.files?.map((f) => f.name)).toEqual(['Close-out checklist.pdf', 'Funds status.csv']);
    expect(Buffer.from(sent.files![0].content, 'base64').equals(PDF)).toBe(true);
    expect(sent.confirmFiles).toBe(true);
    await route.fulfill({ status: 409, json: { error: 'Vantage could not open a TLS connection to the mail relay, so files cannot go by email right now. Send the message without its files, or try again later.', code: 'relay_not_tls' } });
  });
  await page.goto('/team?unit=G8');
  await page.getByRole('button', { name: 'Email the team' }).click();
  const dialog = page.getByRole('dialog', { name: /^Email / });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Subject').fill('Close-out packet');
  await dialog.getByLabel('Message').fill('The checklist and the funds status are attached.');

  await dialog.getByLabel('Add files').setInputFiles([
    { name: 'Close-out checklist.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'Funds status.csv', mimeType: 'text/csv', buffer: CSV },
  ]);
  const list = dialog.getByRole('list', { name: 'Files to send' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list).toContainText('Close-out checklist.pdf');
  await expect(dialog.getByText(/Up to 5 files, 10\.0 MB together/)).toBeVisible();
  const send = dialog.getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled();
  const confirm = dialog.getByRole('checkbox', { name: /cannot be withdrawn once the message is sent/ });
  await confirm.check();
  await expect(send).toBeEnabled();
  await axe(page, '[role="dialog"]');

  // A third file chosen and removed again leaves the two.
  await dialog.getByLabel('Add files').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('notes\n') });
  await expect(list.getByRole('listitem')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Remove notes.txt' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(2);

  await send.click();
  await confirmSudoIfAsked(page);
  const refusal = dialog.getByRole('alert');
  await expect(refusal).toContainText('could not open a TLS connection to the mail relay');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Subject')).toHaveValue('Close-out packet');
  await axe(page, '[role="dialog"]');
});

test('files chosen before a refusal appears stay removable, and the dialog stays open until the send is answered', async ({ page, request }) => {
  await ensureSetup(request);
  await page.clock.install();
  await loginAs(page, OPERATOR.username);
  let refusal: string | null = null;
  let answer: () => void = () => {};
  const answered = new Promise<void>((resolve) => { answer = resolve; });
  await page.route('**/api/org/units/G8/message', async (route) => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: { ...AUDIENCE, files: { ...AUDIENCE.files, refusal } } }); return; }
    const sent = route.request().postDataJSON() as { files?: unknown[] };
    expect(sent.files ?? [], 'the files that could not go were removed first').toEqual([]);
    await answered;
    await route.fulfill({ json: { id: 'held', recipients: 3, emailed: 2, queued: 0, failed: 0, refused: 0, appOnly: 1, files: 0 } });
  });
  await page.goto('/team?unit=G8');
  await page.getByRole('button', { name: 'Email the team' }).click();
  const dialog = page.getByRole('dialog', { name: /^Email / });
  await dialog.getByLabel('Subject').fill('Packet');
  await dialog.getByLabel('Message').fill('The checklist is attached.');
  await dialog.getByLabel('Add files').setInputFiles({ name: 'Close-out checklist.pdf', mimeType: 'application/pdf', buffer: PDF });
  await dialog.getByRole('checkbox', { name: /cannot be withdrawn/ }).check();
  const send = dialog.getByRole('button', { name: 'Send' });
  await expect(send).toBeEnabled();

  // Someone outside the allowed domains joins; the audience is read again when the window comes back after a while.
  refusal = 'One Marine on this message has an address outside the allowed domains (gmail.com), so the files cannot go to them by email. Send the message without its files, or ask that Marine to use an address on the allowed domains.';
  await page.clock.fastForward(31_000);
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await expect(dialog.getByText(/outside the allowed domains \(gmail\.com\)/)).toBeVisible();
  await expect(dialog.getByRole('list', { name: 'Files to send' }).getByRole('listitem')).toHaveCount(1);
  await expect(dialog.getByText('Remove the files to send the message without them.')).toBeVisible();
  await expect(send).toBeDisabled();
  await axe(page, '[role="dialog"]');
  await dialog.getByRole('button', { name: 'Remove Close-out checklist.pdf' }).click();
  await expect(send).toBeEnabled();

  // While the send is out, neither Escape nor Cancel closes the dialog: its answer lands on this message.
  await send.click();
  await confirmSudoIfAsked(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await expect(dialog.getByLabel('Subject')).toHaveValue('Packet');
  await expect(dialog.getByLabel('Subject'), 'nothing changes while the send is out').toBeDisabled();
  await expect(dialog.getByLabel('Message')).toBeDisabled();
  answer();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/^Sent to 3 Marines in Vantage/)).toBeVisible();
});

test('a sent message opens on its own page for the Marines it went to, and for no one else', async ({ page, request }) => {
  await ensureSetup(request);
  const name = unique('teammsg');
  await registerAs(page, name, { email: `${name}@example.mil` });
  const base = page.url().replace(/^(https?:\/\/[^/]+).*$/, '$1');
  const leader = await playwrightRequest.newContext({ baseURL: base });
  try {
    const signedIn = await leader.post('/api/auth/login', { headers: H, data: { username: OPERATOR.username, password: PASSWORD } });
    expect(signedIn.ok(), await signedIn.text()).toBeTruthy();
    await joinUnit(leader, page.request);

    // The leader sends from the dialog and opens what was sent from the toast.
    await logout(page);
    await loginAs(page, OPERATOR.username);
    await page.goto('/team?unit=G8');
    await page.getByRole('button', { name: 'Email the team' }).click();
    const dialog = page.getByRole('dialog', { name: /^Email / });
    const subject = `Formation ${name}`;
    await dialog.getByLabel('Subject').fill(subject);
    await dialog.getByLabel('Message').fill('Formation at 0700 on the parade deck.\nBring the binder.');
    await dialog.getByRole('button', { name: 'Send' }).click();
    await confirmSudoIfAsked(page);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(page).toHaveURL(/\/team\/messages\/[^/]+$/);
    const url = page.url();
    await expect(page.getByRole('heading', { level: 1, name: subject })).toBeVisible();
    await expect(page.getByText('Bring the binder.')).toBeVisible();
    await expect(page.getByText(/^Sent to \d+ Marines?/)).toBeVisible();
    await expect(page.getByText(/Vantage keeps this message until/)).toBeVisible();
    await axe(page, 'main');

    // The Marine it went to opens it from their notice; one who was not on it gets nothing.
    await logout(page);
    await loginAs(page, name);
    await page.goto(url);
    await expect(page.getByRole('heading', { level: 1, name: subject })).toBeVisible();
    await expect(page.getByText(/^Sent to/)).toHaveCount(0);
    const outsider = unique('notsent');
    await logout(page);
    await registerAs(page, outsider);
    await page.goto(url);
    await expect(page.getByText('Not here any more')).toBeVisible();
  } finally { await leader.dispose(); }
});
