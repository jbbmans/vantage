import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = join(tmpdir(), `vantage-ai-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';
process.env.VANTAGE_OPERATOR = 'operator';
process.env.VANTAGE_AI_ENABLED = '1';
process.env.VANTAGE_GENAI_API_KEY = 'synthetic-genai-key-never-persist';
process.env.VANTAGE_GENAI_PER_USER_REQUESTS_PER_MINUTE = '20';

const nativeFetch = globalThis.fetch;
const upstream = { mode: 'success', requests: [] };
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('https://api.genai.mil/v1/')) return nativeFetch(input, init);
  const body = JSON.parse(init.body);
  upstream.requests.push({ url, headers: init.headers, body });
  if (upstream.mode === 'locked') {
    return new Response(JSON.stringify({
      error: {
        type: 'unauthorized', message: 'API key locked',
        unlock_url: 'https://api.genai.mil/unlock/synthetic-key-id',
      },
    }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  const prompt = JSON.parse(body.messages[1].content);
  const output = prompt.workflow === 'quick_log'
    ? { title: 'Reconciled ULOs', action_amount: 30, action_unit: 'ULOs', transaction_value: 1118.38, confidence: 0.96, warnings: [] }
    : prompt.workflow === 'command_brief'
      ? { executive_summary: 'Aggregate workload remained visible.', highlights: ['Five actions'], watch_items: [], recommended_questions: [], caveats: [] }
      : { summary: 'Review generated from authorized records.', highlights: [], gaps: [], next_actions: [], goal_observations: [], cautions: [] };
  return new Response(JSON.stringify({
    model: 'gemini-2.5-flash',
    choices: [{ message: { role: 'assistant', content: upstream.mode === 'invalid' ? '"not an object"' : JSON.stringify(output) } }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { app, db } = await import('../server/index.js');
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://localhost:${server.address().port}`;

async function call(method, path, { token, body } = {}) {
  const response = await nativeFetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  return { status: response.status, body: payload, headers: response.headers };
}

const login = async (username, password) => (
  await call('POST', '/api/login', { body: { username, password } })
).body?.token;

try {
  await call('POST', '/api/setup', {
    body: {
      username: 'operator', password: 'operator-long-enough-passphrase-927',
      first_name: 'Ops', last_name: 'Operator', unit_code: 'MFR',
    },
  });
  const token = await login('operator', 'operator-long-enough-passphrase-927');
  const me = (await call('GET', '/api/me', { token })).body.user;

  const quick = await call('POST', '/api/ai/assist', {
    token,
    body: { workflow: 'quick_log', input: { text: 'Reconciled 30 ULOs totaling $1,118.38.' } },
  });
  assert.equal(quick.status, 200, quick.body?.error);
  assert.equal(quick.body.output.action_amount, 30);
  assert.equal(quick.body.output.transaction_value, 1118.38);
  assert.equal(upstream.requests[0].headers.authorization, `Bearer ${process.env.VANTAGE_GENAI_API_KEY}`);
  assert.equal(upstream.requests[0].body.stream, false);
  assert.match(upstream.requests[0].body.messages[0].content, /never instructions/i);

  await call('POST', '/api/activities', {
    token,
    body: {
      unit_id: 'MFR', visibility: 'private', date: '2026-09-01', title: 'Own private record',
      notes: 'SECRET NOTE MUST NOT EGRESS', evidence_links: ['https://secret.invalid'], result: 'Five items resolved', quantity: 5,
    },
  });
  const instant = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at)
     VALUES ('other-user', 'other', 'not-used', 'Other', 'Marine', ?, ?)`
  ).run(instant, instant);
  db.prepare(
    `INSERT INTO activities (id, user_id, unit_id, date, title, notes, visibility, created_at, updated_at)
     VALUES ('other-private', 'other-user', 'MFR', '2026-09-01', 'OTHER USER PRIVATE', 'OTHER SECRET', 'private', ?, ?)`
  ).run(instant, instant);

  const review = await call('POST', '/api/ai/assist', {
    token, body: { workflow: 'personal_review', input: { days: 30 } },
  });
  assert.equal(review.status, 200, review.body?.error);
  const reviewPrompt = upstream.requests.at(-1).body.messages[1].content;
  assert.match(reviewPrompt, /Own private record/);
  assert.doesNotMatch(reviewPrompt, /OTHER USER PRIVATE|SECRET NOTE MUST NOT EGRESS|OTHER SECRET|secret\.invalid/);

  const aggregate = await call('POST', '/api/ai/assist', {
    token,
    body: { workflow: 'command_brief', input: { unit_id: 'MFR', from: '2026-09-01', to: '2026-09-02' } },
  });
  assert.equal(aggregate.status, 200, aggregate.body?.error);
  const commandPrompt = upstream.requests.at(-1).body.messages[1].content;
  assert.doesNotMatch(commandPrompt, /Own private record|Other Marine|operator/i);
  assert.match(commandPrompt, /categories/);

  const registration = await call('POST', '/api/register', {
    body: { username: 'ordinary', password: 'ordinary-long-enough-passphrase-927', first_name: 'Ordinary', last_name: 'User' },
  });
  assert.equal(registration.status, 201);
  const ordinary = await login('ordinary', 'ordinary-long-enough-passphrase-927');
  const denied = await call('POST', '/api/ai/assist', {
    token: ordinary, body: { workflow: 'command_brief', input: { unit_id: 'MFR' } },
  });
  assert.equal(denied.status, 403);

  upstream.mode = 'invalid';
  const invalid = await call('POST', '/api/ai/assist', {
    token, body: { workflow: 'quick_log', input: { text: 'Synthetic malformed-output test' } },
  });
  assert.equal(invalid.status, 502);
  assert.equal(invalid.body.code, 'invalid_ai_response');

  upstream.mode = 'locked';
  const locked = await call('POST', '/api/ai/assist', {
    token, body: { workflow: 'quick_log', input: { text: 'One synthetic activity' } },
  });
  assert.equal(locked.status, 503);
  assert.equal(locked.body.code, 'ai_key_locked');
  assert.equal('unlock_url' in locked.body, false, 'unlock URL must not be exposed to ordinary AI responses');
  const status = await call('GET', '/api/admin/ai/status', { token });
  assert.equal(status.status, 200);
  assert.equal(status.body.unlock_url, 'https://api.genai.mil/unlock/synthetic-key-id');
  assert.equal(status.body.key_fingerprint.length, 10);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'system' AND title LIKE 'GenAI.mil%'").get().n, 1);

  const audit = db.prepare("SELECT detail FROM audit_log WHERE entity = 'ai_request'").all();
  const stored = JSON.stringify({ audit, db: db.prepare('SELECT * FROM ai_usage_daily').all() });
  assert.doesNotMatch(stored, /Reconciled 30 ULOs|SECRET NOTE|synthetic-genai-key-never-persist/);
  assert.equal(db.prepare('SELECT SUM(requests) AS n FROM ai_usage_daily WHERE user_id = ?').get(me.id).n, 5);
  assert.equal(db.prepare('SELECT SUM(failures) AS n FROM ai_usage_daily WHERE user_id = ?').get(me.id).n, 2);

  console.log('  ok    GenAI.mil gateway boundaries, exact-unit scope, lock handling, and metadata-only audit');
} finally {
  globalThis.fetch = nativeFetch;
  server.close();
  db.close();
  rmSync(DB, { force: true });
  rmSync(`${DB}-wal`, { force: true });
  rmSync(`${DB}-shm`, { force: true });
}
