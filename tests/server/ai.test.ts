import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, mockGenAi, type TestApp } from './helpers.ts';
import { resetAiState } from '../../server/services/ai.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let mock: Awaited<ReturnType<typeof mockGenAi>>;
let mode: 'ok' | 'locked' | 'garbage' | 'rate' = 'ok';
before(async () => {
  mock = await mockGenAi((body) => {
    if (mode === 'locked') return { status: 401, json: { error: { message: 'locked', unlock_url: 'https://genai.mil/unlock/abc' } } };
    if (mode === 'rate') return { status: 429, json: { error: { retry_after_seconds: 7 } } };
    if (mode === 'garbage') return { json: { choices: [{ message: { content: 'not json at all' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } } };
    return { json: { model: body.model, choices: [{ message: { content: '```json\n{"title":"Reconciled 30 ULOs","action_amount":30,"action_unit":"ULOs","transaction_value":1118.38,"dollar_type":"reconciled","category":"Fiscal & Financial","evaluation_area":"MOS / Mission Accomplishment","confidence":0.9,"warnings":[]}\n```' } }], usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 } } };
  });
  app = await startApp({ VANTAGE_AI_ENABLED: 'true', VANTAGE_GENAI_API_KEY: 'test-key-123', VANTAGE_GENAI_BASE_URL: mock.url, VANTAGE_GENAI_MODELS: 'gemini-2.5-flash,gpt-4o,grok-3' });
  op = await app.setupOperator();
});
after(async () => { await app.close(); mock.close(); });

test('status exposes models and availability without the key', async () => {
  const s = await app.call('GET', '/api/ai/status', { token: op.token });
  assert.equal(s.body.available, true);
  assert.deepEqual(s.body.models, ['gemini-2.5-flash', 'gpt-4o', 'grok-3']);
  assert.ok(!JSON.stringify(s.body).includes('test-key-123'));
});

test('quick log extraction sends only the text, honors model choice, and returns parsed JSON', async () => {
  const res = await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'quick_log', input: { text: 'Reconciled 30 ULOs totaling $1,118.38 in DAI' }, model: 'grok-3' } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.model, 'grok-3');
  assert.equal(res.body.output.action_amount, 30);
  assert.equal(res.body.usage.total_tokens, 180);
  const call = mock.calls.at(-1)!;
  assert.equal(call.auth, 'Bearer test-key-123');
  assert.equal(call.body.model, 'grok-3');
  assert.ok(JSON.stringify(call.body.messages[1]).includes('Reconciled 30 ULOs'));
  assert.ok(!JSON.stringify(call.body).includes('boletz'));
  const unknownModel = await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'quick_log', input: { text: 'x' }, model: 'not-allowed' } });
  assert.equal(unknownModel.body.model, 'gemini-2.5-flash');
});

test('record-driven workflows exclude names and private fields; command brief needs EXPORT_DATA', async () => {
  await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Secret notes test', notes: 'DO NOT SEND', visibility: 'unit', date: new Date().toISOString().slice(0, 10), evidence_links: [{ url: 'https://secret.example' }] } });
  const review = await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'personal_review', input: { days: 30 } } });
  assert.equal(review.status, 200);
  const sent = JSON.stringify(mock.calls.at(-1)!.body);
  assert.ok(sent.includes('Secret notes test'));
  assert.ok(!sent.includes('DO NOT SEND') && !sent.includes('secret.example') && !sent.includes('Boletz'));
  const brief = await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'command_brief', input: { unit_id: 'G8' } } });
  assert.equal(brief.status, 200);
  const marine = await app.register('lowly');
  await enroll(app, op.token, 'G8', marine.id);
  const denied = await app.call('POST', '/api/ai/assist', { token: (await app.login('lowly')).body.token, body: { workflow: 'command_brief', input: { unit_id: 'G8' } } });
  assert.equal(denied.status, 403);
  const counsel = await app.call('POST', '/api/ai/assist', { token: (await app.login('lowly')).body.token, body: { workflow: 'counseling_prep', input: { unit_id: 'G8', user_id: op.id } } });
  assert.equal(counsel.status, 403);
});

test('upstream failures are translated and the key lock is operator-visible', async () => {
  mode = 'garbage';
  assert.equal((await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'writing', input: { source: 'facts' } } })).body.code, 'invalid_ai_response');
  mode = 'rate';
  const rate = await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'writing', input: { source: 'facts' } } });
  assert.equal(rate.status, 429);
  assert.equal(rate.headers.get('retry-after'), '7');
  mode = 'locked';
  const locked = await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'writing', input: { source: 'facts' } } });
  assert.equal(locked.status, 503);
  assert.equal(locked.body.code, 'ai_key_locked');
  const status = await app.call('GET', '/api/ai/status', { token: op.token });
  assert.equal(status.body.locked, true);
  assert.ok(!('unlock_url' in status.body));
  const adminStatus = await app.call('GET', '/api/admin/ai', { token: op.token });
  assert.equal(adminStatus.body.unlock_url, 'https://genai.mil/unlock/abc');
  const notified = app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND kind = 'system'`).get(op.id) as { n: number };
  assert.equal(notified.n, 1);
  mode = 'ok';
  assert.equal((await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'writing', input: { source: 'facts' } } })).body.code, 'ai_key_locked');
  assert.equal((await app.call('POST', '/api/admin/ai/unlock', { token: op.token })).body.locked, false);
  assert.equal((await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'writing', input: { source: 'facts' } } })).status, 200);
  resetAiState();
});

test('disabling AI at runtime blocks requests and usage is recorded per model', async () => {
  const usage = app.ctx.db.prepare('SELECT model, SUM(requests) AS n FROM ai_usage_daily GROUP BY model').all() as Array<{ model: string; n: number }>;
  assert.ok(usage.find((u) => u.model === 'grok-3')?.n === 1);
  await app.call('PUT', '/api/admin/runtime', { token: op.token, body: { aiEnabled: false } });
  const res = await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'writing', input: { source: 'facts' } } });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'ai_disabled');
  await app.call('PUT', '/api/admin/runtime', { token: op.token, body: { aiEnabled: true } });
});
