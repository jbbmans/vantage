import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DB = join(tmpdir(), `vantage-load-50-${process.pid}-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';
process.env.VANTAGE_OPERATOR = 'operator';
process.env.VANTAGE_REGISTRATIONS_PER_15_MINUTES = '100';

const { app } = await import('../server/index.js');
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://localhost:${server.address().port}`;

async function call(method, path, { token, body } = {}) {
  const started = performance.now();
  const response = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch {  }
  return { status: response.status, body: payload, ms: performance.now() - started };
}

async function inWaves(items, width, work) {
  const results = [];
  for (let index = 0; index < items.length; index += width) {
    results.push(...await Promise.all(items.slice(index, index + width).map(work)));
  }
  return results;
}

const latencies = [];
const remember = (result) => { latencies.push(result.ms); return result; };
const users = Array.from({ length: 50 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  return {
    username: `vantage.bot${number}`,
    password: `vantage-load-bot-${number}-long-passphrase`,
    first_name: `Test${number}`,
    last_name: 'Marine',
    rank_id: index % 3 === 0 ? 'Cpl' : 'PFC',
    mos: index % 2 === 0 ? '3451' : '0111',
  };
});

try {
  const setup = remember(await call('POST', '/api/setup', {
    body: {
      username: 'operator',
      password: 'operator-isolated-long-passphrase',
      first_name: 'Instance',
      last_name: 'Operator',
      rank_id: 'Cpl',
      mos: '3451',
      unit_code: 'MFR',
    },
  }));
  assert.equal(setup.status, 200, setup.body?.error);

  const registrations = await inWaves(users, 5, async (user) => remember(await call('POST', '/api/register', { body: user })));
  assert.equal(registrations.filter((result) => result.status === 201).length, 50, 'all fifty accounts should register');

  const sessions = await inWaves(users, 5, async (user) => {
    const result = remember(await call('POST', '/api/login', { body: { username: user.username, password: user.password } }));
    assert.equal(result.status, 200, `${user.username}: ${result.body?.error}`);
    assert.ok(result.body?.token, `${user.username}: test session token missing`);
    return { ...user, token: result.body.token };
  });

  const journeys = await inWaves(sessions, 10, async (user, index) => {
    const date = `2026-08-${String((index % 25) + 1).padStart(2, '0')}`;
    const requests = [
      call('PUT', '/api/prefs', { token: user.token, body: { interface: { theme: index % 2 ? 'dark' : 'light', density: index % 3 ? 'comfortable' : 'compact', dashboardPeriod: 'fiscalQuarter' } } }),
      call('POST', '/api/activities', { token: user.token, body: { title: `Processed ${index + 1} test transactions`, date, quantity: index + 1, unit_label: 'transactions', result: 'validated isolated workload behavior', visibility: 'personal' } }),
      call('POST', '/api/activities', { token: user.token, body: { title: `Reconciled workload batch ${index + 1}`, date, dollar_amount: (index + 1) * 100.25, dollar_type: 'reviewed', visibility: 'personal' } }),
      call('POST', '/api/tasks', { token: user.token, body: { title: `Follow up workload ${index + 1}`, status: 'active', visibility: 'personal' } }),
      call('POST', '/api/goals', { token: user.token, body: { title: `Complete ${index + 2} workload records`, target_value: index + 2, current_value: 2, status: 'active', type: 'performance', visibility: 'personal' } }),
    ];
    const results = (await Promise.all(requests)).map(remember);
    assert.ok(
      results.every((result) => result.status >= 200 && result.status < 300),
      `${user.username}: a core write failed — ${results.map((result) => `${result.status}:${result.body?.error || 'ok'}`).join(' | ')}`
    );

    const [me, activities, tasks, goals, prefs] = (await Promise.all([
      call('GET', '/api/me', { token: user.token }),
      call('GET', '/api/activities', { token: user.token }),
      call('GET', '/api/tasks', { token: user.token }),
      call('GET', '/api/goals', { token: user.token }),
      call('GET', '/api/prefs', { token: user.token }),
    ])).map(remember);
    assert.equal(me.status, 200);
    assert.equal(activities.body.length, 2, `${user.username}: personal activity boundary failed`);
    assert.equal(tasks.body.length, 1, `${user.username}: personal task boundary failed`);
    assert.equal(goals.body.length, 1, `${user.username}: personal goal boundary failed`);
    assert.equal(prefs.body.interface.dashboardPeriod, 'fiscalQuarter');
    assert.ok(activities.body.every((row) => row.user_id === me.body.user.id), `${user.username}: another account's record was visible`);
    return true;
  });

  assert.equal(journeys.length, 50);
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  console.log(`  ok    50 isolated accounts registered and signed in`);
  console.log(`  ok    250 core writes and 250 authenticated reads completed`);
  console.log(`  ok    personal record isolation held across all 50 accounts`);
  console.log(`  info  request latency p50 ${percentile(0.50).toFixed(0)}ms · p95 ${percentile(0.95).toFixed(0)}ms · max ${sorted.at(-1).toFixed(0)}ms`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  for (const file of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { rmSync(file, { force: true }); } catch {  }
  }
}
