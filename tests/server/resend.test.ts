import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createMailer } from '../../server/services/email.ts';
import { startApp, type TestApp } from './helpers.ts';

let app: TestApp;
let server: Server;
let url: string;
let answers: Array<{ status: number; headers?: Record<string, string>; body?: string }> = [];
const calls: Array<{ key: string | undefined; to: string[] }> = [];

before(async () => {
  app = await startApp();
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      calls.push({ key: req.headers['idempotency-key'] as string | undefined, to: JSON.parse(raw).to });
      const answer = answers.shift() || { status: 200 };
      res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers || {}) });
      res.end(answer.body || '{"id":"email_1"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/emails`;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await app.close(); });

const mailer = () => createMailer({ ...app.ctx.config, email: { ...app.ctx.config.email, provider: 'resend', resendApiKey: 're_test', resendUrl: url } }, app.ctx.db);
const mail = (to: string) => ({ to, subject: 'Your Vantage sign-in details', text: 'text', html: '<p>html</p>', kind: 'sign_in' });
const lastLog = (to: string) => app.ctx.db.prepare('SELECT status, error FROM email_log WHERE to_address = ? ORDER BY rowid DESC LIMIT 1').get(to) as { status: string; error: string | null };

test('a rate-limited send waits as told and succeeds, under one idempotency key', async () => {
  calls.length = 0;
  answers = [{ status: 429, headers: { 'retry-after': '0.01' }, body: '{"message":"Too many requests"}' }, { status: 200 }];
  const result = await mailer().send(mail('limited@example.mil'));
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].key);
  assert.equal(calls[0].key, calls[1].key, 'the retry cannot deliver twice');
  assert.equal(lastLog('limited@example.mil').status, 'sent');
});

test('a refusal is not retried, and its reason is logged', async () => {
  calls.length = 0;
  answers = [{ status: 422, body: '{"message":"The from domain is not verified"}' }];
  const result = await mailer().send(mail('refused@example.mil'));
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.match(lastLog('refused@example.mil').error || '', /422.*not verified/);
});

test('a provider that stays unavailable is given up on after a few attempts', async () => {
  calls.length = 0;
  answers = Array.from({ length: 6 }, () => ({ status: 503, headers: { 'retry-after': '0.01' } }));
  const result = await mailer().send(mail('down@example.mil'));
  assert.equal(result.ok, false);
  assert.equal(calls.length, 4);
  assert.equal(lastLog('down@example.mil').status, 'failed');
  answers = [];
});
