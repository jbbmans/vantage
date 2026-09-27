import { test, expect } from '@playwright/test';
import { ensureSetup, loginAs, OPERATOR } from './fixtures';

test('email checks retain DNS results while test sends refresh the queue and visible errors', async ({ page, request }) => {
  await ensureSetup(request);
  await loginAs(page, OPERATOR.username);
  const records = ['dkim', 'spf', 'dmarc'].map((id) => ({ id, type: 'TXT', host: id, fqdn: `${id}.example.test`, value: 'test-record', why: 'Test record' }));
  const setup = {
    provider: 'direct', from: 'Vantage <no-reply@example.test>', domain: 'example.test', replyTo: null, helo: 'example.test',
    records, path: null, queue: { waiting: 0, oldest: null as string | null },
    recent: [] as Array<{ to_address: string; kind: string; status: string; error: string; created_at: string }>,
  };
  await page.route('**/api/admin/email', (route) => route.fulfill({ json: setup }));
  await page.route('**/api/admin/email/check', (route) => route.fulfill({ json: {
    ...setup, records: records.map((r) => ({ ...r, status: 'ok' })), dnsHost: { name: 'Cloudflare', nameservers: [] },
    path: { checkedAt: new Date().toISOString(), open: false, ip: null, ptr: null, forwardConfirmed: false, server: 'mx.example.test', error: '421 try later' },
  } }));
  let attempts = 0;
  await page.route('**/api/admin/email/test', async (route) => {
    attempts++;
    setup.queue = { waiting: 1, oldest: new Date().toISOString() };
    setup.recent.unshift({ to_address: 'recipient@example.test', kind: 'test', status: attempts === 1 ? 'queued' : 'failed', error: attempts === 1 ? '451 greylisted, try later' : '550 no such user', created_at: new Date().toISOString() });
    await route.fulfill(attempts === 1 ? { json: { ok: true, queued: true } } : { status: 400, json: { error: '550 no such user' } });
  });

  await page.goto('/operator?tab=email');
  await page.getByRole('button', { name: 'Check everything' }).click();
  await expect(page.getByText('SMTP check failed: 421 try later')).toBeVisible();
  await expect(page.getByText('3 of 3 published correctly.')).toBeVisible();
  await page.getByRole('button', { name: 'Send test', exact: true }).click();
  await expect(page.locator('li').filter({ hasText: 'test → recipient@example.test' })).toContainText('queued');
  await expect(page.locator('li').filter({ hasText: 'test → recipient@example.test' })).toContainText('451 greylisted, try later');
  await expect(page.locator('dt').filter({ hasText: 'Waiting to retry' }).locator('+ dd')).toHaveText('1');
  await expect(page.getByText('3 of 3 published correctly.')).toBeVisible();

  await page.getByRole('button', { name: 'Send test', exact: true }).click();
  const recent = page.locator('li').filter({ hasText: 'test → recipient@example.test' });
  await expect(recent).toHaveCount(2);
  await expect(recent.first()).toContainText('failed');
  await expect(recent.first()).toContainText('550 no such user');
});
