import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let peer: { token: string; id: string };
let outsider: { token: string; id: string };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  peer = await app.register('peer');
  await enroll(app, op.token, 'G8', peer.id);
  // Enrolment changes the account's authority, so its earlier session no longer stands.
  peer = { ...peer, token: (await app.login('peer')).body.token };
  outsider = await app.register('outsider');
});
after(async () => { await app.close(); });

const activity = (token: string, body: Record<string, unknown>) =>
  app.call('POST', '/api/records/activities', { token, body: { visibility: 'unit', date: day(-2), ...body } });

test('the metrics endpoint reports typed totals that never blend unlike units', async () => {
  await activity(op.token, { title: 'Obligated funds', dollar_amount: 1000, dollar_type: 'obligated' });
  await activity(op.token, { title: 'Cleared ULOs', quantity: 30, unit_label: 'ULOs' });
  await activity(op.token, { title: 'Cleared more ULOs', quantity: 12, unit_label: 'ULO' });

  const res = await app.call('GET', `/api/metrics?from=${day(-30)}&to=${day(1)}`, { token: op.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const money = res.body.headline.find((t: any) => t.metricId === 'money:obligated');
  const ulos = res.body.headline.find((t: any) => t.metricId === 'quantity:ulo');
  assert.equal(money.value, 1000);
  assert.equal(ulos.value, 42);
  assert.equal(money.unitKey === ulos.unitKey, false);
  assert.ok(!res.body.headline.some((t: any) => t.value === 1042));
});

test('a total opens into the outcomes behind it, and only readable ones', async () => {
  const created = await activity(op.token, { title: 'Reconciled a MIPR', quantity: 5, unit_label: 'MIPRs' });
  assert.equal(created.status, 201);
  const contributors = await app.call('GET', `/api/metrics/contributors?metric_id=quantity:mipr&from=${day(-30)}&to=${day(1)}`, { token: op.token });
  assert.equal(contributors.status, 200);
  assert.equal(contributors.body.length, 1);
  assert.equal(contributors.body[0].id, created.body.id);
  assert.equal(contributors.body[0].value, 5);
  assert.equal(contributors.body[0].table, 'activities');
});

test('a private entry never reaches another member figures, even a leader', async () => {
  const priv = await activity(peer.token, { title: 'Peer private work', visibility: 'private', quantity: 999, unit_label: 'secrets' });
  assert.equal(priv.status, 201, JSON.stringify(priv.body));
  const leaderView = await app.call('GET', `/api/metrics?scope=all&from=${day(-30)}&to=${day(1)}`, { token: op.token });
  assert.equal(leaderView.status, 200, JSON.stringify(leaderView.body));
  assert.ok(!leaderView.body.headline.some((t: any) => t.metricId === 'quantity:secret'), 'a private measure is not in a leader total');
  const drill = await app.call('GET', `/api/metrics/contributors?metric_id=quantity:secret&scope=all&from=${day(-30)}&to=${day(1)}`, { token: op.token });
  assert.deepEqual(drill.body, []);
  // The owner still sees their own.
  const own = await app.call('GET', `/api/metrics?from=${day(-30)}&to=${day(1)}`, { token: peer.token });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.ok(own.body.headline.some((t: any) => t.metricId === 'quantity:secret'), JSON.stringify(own.body));
});

test('an outsider sees none of the unit figures and cannot ask for them', async () => {
  const mine = await app.call('GET', `/api/metrics?from=${day(-30)}&to=${day(1)}`, { token: outsider.token });
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.headline, []);
  const unitAsk = await app.call('GET', `/api/metrics?unit_id=G8&from=${day(-30)}&to=${day(1)}`, { token: outsider.token });
  assert.equal(unitAsk.status, 403);
  const personAsk = await app.call('GET', `/api/metrics?user_id=${op.id}&from=${day(-30)}&to=${day(1)}`, { token: outsider.token });
  assert.equal(personAsk.status, 403);
});

test('re-saving a record does not change any figure', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const created = await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'One outcome', visibility: 'unit', date: day(-1), quantity: 8, unit_label: 'reviews' } });
    const before = await fresh.call('GET', `/api/metrics?from=${day(-30)}&to=${day(1)}`, { token: owner.token });
    const total = before.body.headline.find((t: any) => t.metricId === 'quantity:review');
    assert.equal(total.value, 8);
    assert.equal(total.outcomes, 1);
    for (let i = 0; i < 3; i += 1) {
      const current = await fresh.call('GET', `/api/records/activities/${created.body.id}`, { token: owner.token });
      const saved = await fresh.call('PUT', `/api/records/activities/${created.body.id}`, { token: owner.token, body: { result: `pass ${i}`, version: current.body.version } });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
    }
    const after = await fresh.call('GET', `/api/metrics?from=${day(-30)}&to=${day(1)}`, { token: owner.token });
    const again = after.body.headline.find((t: any) => t.metricId === 'quantity:review');
    assert.equal(again.value, 8, 'repeated saves create no extra credit');
    assert.equal(again.outcomes, 1);
  } finally { await fresh.close(); }
});

test('a deleted record leaves the figures immediately', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const created = await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Counted once', visibility: 'unit', date: day(-1), dollar_amount: 400, dollar_type: 'obligated' } });
    const before = await fresh.call('GET', `/api/metrics?from=${day(-30)}&to=${day(1)}`, { token: owner.token });
    assert.equal(before.body.headline.find((t: any) => t.metricId === 'money:obligated').value, 400);
    await fresh.call('DELETE', `/api/records/activities/${created.body.id}`, { token: owner.token });
    const after = await fresh.call('GET', `/api/metrics?from=${day(-30)}&to=${day(1)}`, { token: owner.token });
    assert.ok(!after.body.headline.some((t: any) => t.metricId === 'money:obligated'));
  } finally { await fresh.close(); }
});

test('the period bounds the figures, and the prior period is reported alongside', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'This period', visibility: 'unit', date: '2026-05-15', quantity: 10, unit_label: 'files' } });
    await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Prior period', visibility: 'unit', date: '2026-04-15', quantity: 4, unit_label: 'files' } });
    const res = await fresh.call('GET', '/api/metrics?from=2026-05-01&to=2026-05-31', { token: owner.token });
    assert.equal(res.body.headline.find((t: any) => t.metricId === 'quantity:file').value, 10);
    // The comparison window is the equal-length stretch immediately before the period, not "last month".
    assert.equal(res.body.prior.to, '2026-04-30');
    assert.equal(res.body.prior.from, '2026-03-31');
    assert.equal(res.body.priorHeadline.find((t: any) => t.metricId === 'quantity:file').value, 4);
  } finally { await fresh.close(); }
});

test('training hours are measured as duration, apart from every quantity', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    await fresh.call('POST', '/api/records/trainings', { token: owner.token, body: { title: 'Financial management course', visibility: 'unit', date: day(-3), hours: 6 } });
    await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title: 'Processed invoices', visibility: 'unit', date: day(-3), quantity: 6, unit_label: 'invoices' } });
    const res = await fresh.call('GET', `/api/metrics?from=${day(-30)}&to=${day(1)}`, { token: owner.token });
    const hours = res.body.headline.find((t: any) => t.metricId === 'duration:hours');
    const invoices = res.body.headline.find((t: any) => t.metricId === 'quantity:invoice');
    assert.equal(hours.value, 6);
    assert.equal(invoices.value, 6);
    assert.ok(!res.body.headline.some((t: any) => t.value === 12), 'six hours and six invoices are not twelve of anything');
  } finally { await fresh.close(); }
});

test('the report carries no entry count as a headline figure', async () => {
  const res = await app.call('GET', `/api/metrics?from=${day(-30)}&to=${day(1)}`, { token: op.token });
  for (const total of [...res.body.headline, ...res.body.tracked]) {
    assert.ok(!/entries|records|count/i.test(total.metricLabel), `"${total.metricLabel}" reads as a count of entries rather than an outcome`);
  }
  assert.equal(typeof res.body.outcomesWithMeasures, 'number');
});
