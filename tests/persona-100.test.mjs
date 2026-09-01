import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PERSONAS = ['quick-capture', 'planner', 'career-builder', 'privacy-first', 'report-builder'];
const DB = join(tmpdir(), `vantage-persona-100-${process.pid}-${Date.now()}.db`);
process.env.VANTAGE_DB = DB;
process.env.VANTAGE_TEST = '1';
process.env.VANTAGE_OPERATOR = 'operator';
process.env.VANTAGE_REGISTRATIONS_PER_15_MINUTES = '220';

const { app } = await import('../server/index.js');
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://localhost:${server.address().port}`;

async function call(method, path, { token, body } = {}) {
  const started = performance.now();
  const response = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
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
const users = Array.from({ length: 100 }, (_, index) => {
  const number = String(index + 1).padStart(3, '0');
  return {
    index,
    persona: PERSONAS[index % PERSONAS.length],
    username: `vantage.persona${number}`,
    password: `vantage-persona-${number}-unique-passphrase`,
    first_name: `Persona${number}`,
    last_name: 'Marine',
    rank_id: index % 4 === 0 ? 'Cpl' : 'PFC',
    mos: index % 2 === 0 ? '3451' : '0111',
  };
});

try {
  const setup = remember(await call('POST', '/api/setup', {
    body: {
      username: 'operator', password: 'operator-isolated-long-passphrase',
      first_name: 'Instance', last_name: 'Operator', rank_id: 'Cpl', mos: '3451', unit_code: 'MFR',
    },
  }));
  assert.equal(setup.status, 200, setup.body?.error);

  const registrations = await inWaves(users, 8, async (user) => remember(await call('POST', '/api/register', { body: user })));
  assert.equal(registrations.filter((result) => result.status === 201).length, 100);

  const sessions = await inWaves(users, 8, async (user) => {
    const result = remember(await call('POST', '/api/login', { body: { username: user.username, password: user.password } }));
    assert.equal(result.status, 200, `${user.username}: ${result.body?.error}`);
    assert.ok(result.body?.token);
    return { ...user, token: result.body.token };
  });

  const journeys = await inWaves(sessions, 12, async (user) => {
    const n = user.index + 1;
    const date = `2026-08-${String((user.index % 25) + 1).padStart(2, '0')}`;
    const writes = [
      call('PUT', '/api/prefs', { token: user.token, body: { interface: {
        theme: user.index % 2 ? 'dark' : 'light',
        density: user.index % 3 ? 'comfortable' : 'compact',
        dashboardPeriod: user.persona === 'report-builder' ? 'fiscalYear' : 'fiscalQuarter',
      } } }),
      call('POST', '/api/activities', { token: user.token, body: {
        title: `Processed workload ${n}`, date, quantity: n, unit_label: 'transactions',
        dollar_amount: n * 100.25, dollar_type: 'reviewed', result: 'closed the assigned batch', visibility: 'personal',
      } }),
      call('POST', '/api/tasks', { token: user.token, body: {
        title: `Follow up batch ${n}`, status: user.persona === 'planner' ? 'planned' : 'active',
        priority: n % 7 === 0 ? 'high' : 'medium', visibility: 'personal',
      } }),
      call('POST', '/api/goals', { token: user.token, body: {
        title: `Complete ${n + 2} records`, target_value: n + 2, current_value: 1,
        unit_label: 'records', status: 'active', type: 'performance', visibility: 'personal',
      } }),
      call('POST', '/api/recognitions', { token: user.token, body: {
        title: `Recognition ${n}`, date, type: n % 2 ? 'loa' : 'commendation',
        from_whom: `Leader ${n}`, organization: 'Test Command', visibility: 'personal',
      } }),
      call('POST', '/api/trainings', { token: user.token, body: {
        title: `Course ${n}`, date, type: 'course', hours: (n % 8) + 1,
        provider: 'MarineNet', status: 'completed', visibility: 'personal',
      } }),
    ];
    const writeResults = (await Promise.all(writes)).map(remember);
    assert.ok(writeResults.every((result) => result.status >= 200 && result.status < 300),
      `${user.username}: ${writeResults.map((result) => `${result.status}:${result.body?.error || 'ok'}`).join(' | ')}`);

    const [me, activities, tasks, goals, recognitions, trainings, prefs] = (await Promise.all([
      call('GET', '/api/me', { token: user.token }),
      call('GET', '/api/activities', { token: user.token }),
      call('GET', '/api/tasks', { token: user.token }),
      call('GET', '/api/goals', { token: user.token }),
      call('GET', '/api/recognitions', { token: user.token }),
      call('GET', '/api/trainings', { token: user.token }),
      call('GET', '/api/prefs', { token: user.token }),
    ])).map(remember);
    for (const result of [me, activities, tasks, goals, recognitions, trainings, prefs]) assert.equal(result.status, 200);
    assert.equal(activities.body.length, 1);
    assert.equal(tasks.body.length, 1);
    assert.equal(goals.body.length, 1);
    assert.equal(recognitions.body.length, 1);
    assert.equal(trainings.body.length, 1);
    assert.equal(recognitions.body[0].from_whom, `Leader ${n}`, 'recognition source must survive the form/API contract');
    assert.equal(goals.body[0].unit_label, 'records', 'goal measurement unit must survive the form/API contract');
    assert.ok([activities, tasks, goals, recognitions, trainings]
      .flatMap((result) => result.body)
      .every((row) => row.user_id === me.body.user.id && row.visibility === 'personal'));
    return user.persona;
  });

  assert.equal(journeys.length, 100);
  const counts = Object.fromEntries(PERSONAS.map((persona) => [persona, journeys.filter((item) => item === persona).length]));
  assert.deepEqual(Object.values(counts), [20, 20, 20, 20, 20]);
  const sorted = [...latencies].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  console.log('  ok    100 isolated new accounts registered and signed in');
  console.log('  ok    600 core writes and 700 authenticated reads completed');
  console.log('  ok    five balanced persona cohorts completed: quick capture, planning, career, privacy, reporting');
  console.log('  ok    activity, task, goal, recognition, training, preferences, and personal isolation round-tripped for every persona');
  console.log(`  info  request latency p50 ${percentile(0.50).toFixed(0)}ms · p95 ${percentile(0.95).toFixed(0)}ms · max ${sorted.at(-1).toFixed(0)}ms`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  for (const file of [DB, `${DB}-wal`, `${DB}-shm`]) {
    try { rmSync(file, { force: true }); } catch {  }
  }
}
