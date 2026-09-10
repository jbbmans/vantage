import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let peer: { token: string; id: string };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  peer = await app.register('peer');
  await enroll(app, op.token, 'G8', peer.id);
  peer = { ...peer, token: (await app.login('peer')).body.token };
});
after(async () => { await app.close(); });

const activity = async (token: string, body: Record<string, unknown>) => {
  const res = await app.call('POST', '/api/records/activities', { token, body: { visibility: 'unit', date: day(-3), ...body } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

const goal = async (token: string, body: Record<string, unknown>) => {
  const res = await app.call('POST', '/api/records/goals', {
    token, body: { title: 'A goal', status: 'active', period_start: day(-30), period_end: day(30), visibility: 'private', ...body },
  });
  return res;
};

test('a goal names a metric, a direction and a target, and tracks itself from the work', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Cleared twenty', visibility: 'private', date: day(-3), quantity: 20, unit_label: 'ULOs' } });
    await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Cleared thirty', visibility: 'private', date: day(-2), quantity: 30, unit_label: 'ULOs' } });

    const created = await fresh.call('POST', '/api/records/goals', {
      token: owner.token,
      body: { title: 'Clear a hundred obligations', status: 'active', visibility: 'private', period_start: day(-30), period_end: day(30), metric_id: 'quantity:ulo', direction: 'increase', baseline_value: 0, target_value: 100, aggregation: 'sum', unit_label: 'ULOs' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.progress.current, 50);
    assert.equal(created.body.progress.percent, 50);
    assert.equal(created.body.progress.met, false);
    assert.equal(created.body.progress.auto, true);
    assert.equal(created.body.progress.outcomes, 2);
    assert.match(created.body.progress.basis, /by adding/i);
  } finally { await fresh.close(); }
});

test('a goal to reduce something reads the opposite way from a goal to increase it', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Backlog remaining', visibility: 'private', date: day(-1), quantity: 60, unit_label: 'aged items' } });

    const down = await fresh.call('POST', '/api/records/goals', {
      token: owner.token,
      body: { title: 'Get the aged backlog under fifty', status: 'active', visibility: 'private', period_start: day(-30), period_end: day(30), metric_id: 'quantity:aged item', direction: 'decrease', baseline_value: 100, target_value: 50, unit_label: 'aged items' },
    });
    assert.equal(down.status, 201, JSON.stringify(down.body));
    assert.equal(down.body.progress.current, 60);
    assert.equal(down.body.progress.percent, 80, 'from 100 down toward 50, sitting at 60, is 80 percent of the way');
    assert.equal(down.body.progress.met, false);

    const up = await fresh.call('POST', '/api/records/goals', {
      token: owner.token,
      body: { title: 'Move sixty items', status: 'active', visibility: 'private', period_start: day(-30), period_end: day(30), metric_id: 'quantity:aged item', direction: 'increase', baseline_value: 0, target_value: 60, unit_label: 'aged items' },
    });
    assert.equal(up.body.progress.percent, 100);
    assert.equal(up.body.progress.met, true);
  } finally { await fresh.close(); }
});

test('a threshold goal is met or not, with no partial credit past the line', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Obligated funds', visibility: 'private', date: day(-1), dollar_amount: 250_000, dollar_type: 'obligated' } });
    const res = await fresh.call('POST', '/api/records/goals', {
      token: owner.token,
      body: { title: 'Obligate at least two hundred thousand', status: 'active', visibility: 'private', period_start: day(-30), period_end: day(30), metric_id: 'money:obligated', direction: 'threshold', target_value: 200_000 },
    });
    assert.equal(res.body.progress.met, true);
    assert.equal(res.body.progress.percent, 100);
    assert.equal(res.body.progress.current, 250_000);
  } finally { await fresh.close(); }
});

test('a goal opens into the outcomes that counted toward it', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const a = await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'First contribution', visibility: 'private', date: day(-3), quantity: 4, unit_label: 'reviews' } });
    const b = await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Second contribution', visibility: 'private', date: day(-2), quantity: 6, unit_label: 'reviews' } });
    await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Outside the period', visibility: 'private', date: '2020-01-01', quantity: 999, unit_label: 'reviews' } });

    const created = await fresh.call('POST', '/api/records/goals', {
      token: owner.token,
      body: { title: 'Ten reviews', status: 'active', visibility: 'private', period_start: day(-30), period_end: day(30), metric_id: 'quantity:review', direction: 'increase', baseline_value: 0, target_value: 10, unit_label: 'reviews' },
    });
    assert.equal(created.body.progress.current, 10);

    const counted = await fresh.call('GET', `/api/records/goals/${created.body.id}/contributors`, { token: owner.token });
    assert.equal(counted.status, 200, JSON.stringify(counted.body));
    assert.equal(counted.body.length, 2);
    assert.deepEqual(counted.body.map((c: any) => c.id).sort(), [a.body.id, b.body.id].sort());
    assert.equal(counted.body.reduce((n: number, c: any) => n + c.value, 0), 10, 'the rows add to the figure');
  } finally { await fresh.close(); }
});

test('a goal cannot name a metric this instance does not measure', async () => {
  const res = await goal(op.token, { metric_id: 'money:not-a-type', direction: 'increase', target_value: 10 });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not a metric this instance measures/i);

  const badDirection = await goal(op.token, { metric_id: 'quantity:ulo', direction: 'sideways', target_value: 10 });
  assert.equal(badDirection.status, 400);

  const noTarget = await goal(op.token, { metric_id: 'quantity:ulo', direction: 'increase' });
  assert.equal(noTarget.status, 400);
  assert.match(noTarget.body.error, /what the target is/i);
});

test('a goal cannot be filtered by something that is not a dimension', async () => {
  const res = await goal(op.token, { metric_id: 'quantity:ulo', direction: 'increase', target_value: 10, filters: { password: 'x' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /cannot be filtered by/i);
});

test('a filter narrows what counts, and the drill-down agrees with the figure', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Fiscal work', visibility: 'private', date: day(-2), quantity: 7, unit_label: 'items', category: 'Fiscal & Financial' } });
    await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Training work', visibility: 'private', date: day(-2), quantity: 5, unit_label: 'items', category: 'Training & Readiness' } });

    const created = await fresh.call('POST', '/api/records/goals', {
      token: owner.token,
      body: { title: 'Fiscal items only', status: 'active', visibility: 'private', period_start: day(-30), period_end: day(30), metric_id: 'quantity:item', direction: 'increase', baseline_value: 0, target_value: 20, filters: { category: 'Fiscal & Financial' }, unit_label: 'items' },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.progress.current, 7, 'the other category did not count');
    assert.match(created.body.progress.basis, /category is Fiscal/);

    const counted = await fresh.call('GET', `/api/records/goals/${created.body.id}/contributors`, { token: owner.token });
    assert.equal(counted.body.length, 1);
    assert.equal(counted.body[0].title, 'Fiscal work');
  } finally { await fresh.close(); }
});

test('a goal figure reads the same for the subject and for their leader', async () => {
  await activity(peer.token, { title: 'Shared work of theirs', quantity: 15, unit_label: 'checks' });
  // A leader sets the goal for the Marine; it measures the Marine's shared work either way.
  const created = await app.call('POST', '/api/records/goals', {
    token: op.token,
    body: { title: 'Twenty checks', status: 'active', visibility: 'unit', unit_id: 'G8', assignee_id: peer.id, period_start: day(-30), period_end: day(30), metric_id: 'quantity:check', direction: 'increase', baseline_value: 0, target_value: 20, unit_label: 'checks' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.progress.current, 15);

  const asSubject = await app.call('GET', `/api/records/goals/${created.body.id}`, { token: peer.token });
  assert.equal(asSubject.status, 200, JSON.stringify(asSubject.body));
  assert.equal(asSubject.body.progress.current, 15, 'progress is a fact about the work, not about who is looking');
});

test('a goal recorded before typed goals still reads, and says plainly that it counts entries', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    // Written straight to the table, the way a pre-existing row would be.
    const at = new Date().toISOString();
    fresh.ctx.db.prepare(
      `INSERT INTO goals (id, user_id, visibility, title, type, metric, current_value, target_value, status, period_start, period_end, version, created_at, updated_at)
       VALUES ('legacy-1', ?, 'private', 'Log fifty things', 'quarterly', 'activity_count', 12, 50, 'active', ?, ?, 1, ?, ?)`
    ).run(owner.id, day(-30), day(30), at, at);

    const read = await fresh.call('GET', '/api/records/goals/legacy-1', { token: owner.token });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.current_value, 12, 'the recorded value is preserved exactly');
    assert.equal(read.body.progress.measuresEntries, true);
    assert.match(read.body.progress.basis, /not a measure of the work/i);
    assert.deepEqual(read.body.progress.contributors, [], 'there is nothing to open, because entries are not outcomes');
  } finally { await fresh.close(); }
});

test('a manual goal is still a manual goal, and says so', async () => {
  const res = await goal(op.token, { title: 'A number that lives elsewhere', metric: 'manual', current_value: 7, target_value: 10, unit_label: 'briefs' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.progress.auto, false);
  assert.equal(res.body.progress.current, 7);
  assert.equal(res.body.progress.percent, 70);
  assert.match(res.body.progress.basis, /by hand/i);
});
