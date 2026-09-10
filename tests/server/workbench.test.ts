import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let alex: { token: string; id: string };
let bree: { token: string; id: string };
let outsider: { token: string; id: string };

const CSV = [
  'Document,Description,Due,Amount,Type',
  'ULO-1,Clear the first obligation,2026-06-30,1000,deobligated',
  'ULO-2,Clear the second obligation,2026-07-30,2000,deobligated',
].join('\n');

const PLAN = {
  sheet_name: 'work.csv', header_row: 1, key_columns: ['Document'], unit_id: 'G8', visibility: 'unit' as const,
  mapping: { Document: 'reference', Description: 'title', Due: 'due_date', Amount: 'amount', Type: 'amount_type' } as Record<string, string>,
};

async function seedWork(token: string) {
  const source = await app.call('POST', '/api/work/sources', {
    token, raw: Buffer.from(CSV),
    headers: { 'content-type': 'text/csv', 'x-filename': 'work.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' },
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const job = await app.call('POST', '/api/work/imports', { token, body: { ...PLAN, source_file_id: source.body.id } });
  assert.equal(job.status, 201, JSON.stringify(job.body));
}

const items = async (token: string) => (await app.call('GET', '/api/work/items?unit_id=G8', { token })).body.items as Array<Record<string, any>>;
const byKey = async (token: string, key: string) => (await items(token)).find((i) => i.natural_key === key)!;

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  alex = await app.register('alex');
  bree = await app.register('bree');
  await enroll(app, op.token, 'G8', alex.id);
  await enroll(app, op.token, 'G8', bree.id);
  alex = { ...alex, token: (await app.login('alex')).body.token };
  bree = { ...bree, token: (await app.login('bree')).body.token };
  outsider = await app.register('outsider');
  await seedWork(op.token);
});
after(async () => { await app.close(); });

let ulo1: Record<string, any>;
beforeEach(async () => { ulo1 = await byKey(op.token, 'ULO-1'); });

test('claiming is decided by the server: the second person to reach a row is told who has it', async () => {
  const first = await app.call('POST', `/api/work/items/${ulo1.id}/claim`, { token: alex.token, body: { version: ulo1.version } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.claimed_by, alex.id);
  assert.equal(first.body.state, 'in_progress', 'picking work up moves it out of the open pile');

  const second = await app.call('POST', `/api/work/items/${ulo1.id}/claim`, { token: bree.token, body: { version: first.body.version } });
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.match(second.body.error, /Alex/i, 'the message names who has it, so the second person knows who to ask');

  await app.call('POST', `/api/work/items/${ulo1.id}/release`, { token: alex.token, body: {} });
});

test('a stale version is refused rather than overwriting what changed', async () => {
  const before = await byKey(op.token, 'ULO-2');
  const claimed = await app.call('POST', `/api/work/items/${before.id}/claim`, { token: alex.token, body: { version: before.version } });
  assert.equal(claimed.status, 200);

  // Someone acting on the old version has not seen the claim.
  const stale = await app.call('PATCH', `/api/work/items/${before.id}`, { token: alex.token, body: { state: 'waiting', version: before.version } });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /changed while you were looking at it/i);

  const fresh = await app.call('PATCH', `/api/work/items/${before.id}`, { token: alex.token, body: { state: 'waiting', version: claimed.body.version } });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.state, 'waiting');
  await app.call('POST', `/api/work/items/${before.id}/release`, { token: alex.token, body: {} });
});

test('picking up work is not an accomplishment: a claim produces no measured outcome', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const source = await fresh.call('POST', '/api/work/sources', { token: owner.token, raw: Buffer.from(CSV), headers: { 'content-type': 'text/csv', 'x-filename': 'work.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' } });
    await fresh.call('POST', '/api/work/imports', { token: owner.token, body: { ...PLAN, source_file_id: source.body.id } });
    const list = await fresh.call('GET', '/api/work/items?unit_id=G8', { token: owner.token });
    const target = list.body.items[0];

    const day = new Date().toISOString().slice(0, 10);
    const before = await fresh.call('GET', `/api/metrics?from=2000-01-01&to=${day}`, { token: owner.token });
    await fresh.call('POST', `/api/work/items/${target.id}/claim`, { token: owner.token, body: { version: target.version } });
    await fresh.call('PATCH', `/api/work/items/${target.id}`, { token: owner.token, body: { state: 'waiting' } });
    const after = await fresh.call('GET', `/api/metrics?from=2000-01-01&to=${day}`, { token: owner.token });

    assert.deepEqual(after.body.headline, before.body.headline, 'claiming and re-stating work changed no figure');
    assert.deepEqual(after.body.headline, [], 'and there is nothing to show yet, because nothing was delivered');
  } finally { await fresh.close(); }
});

test('a recorded action can draft the personal record of the work, once', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const source = await fresh.call('POST', '/api/work/sources', { token: owner.token, raw: Buffer.from(CSV), headers: { 'content-type': 'text/csv', 'x-filename': 'work.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' } });
    await fresh.call('POST', '/api/work/imports', { token: owner.token, body: { ...PLAN, source_file_id: source.body.id } });
    const target = (await fresh.call('GET', '/api/work/items?unit_id=G8', { token: owner.token })).body.items[0];
    await fresh.call('POST', `/api/work/items/${target.id}/claim`, { token: owner.token, body: { version: target.version } });

    const day = new Date().toISOString().slice(0, 10);
    const body = { kind: 'reconciled', note: 'Confirmed the supporting document and released the balance.', occurred_at: day, dollar_amount: 1000, dollar_type: 'saved', quantity: 1, unit_label: 'ULOs', draft_record: true, resolve: true };
    const key = { 'idempotency-key': 'action-once' };
    const first = await fresh.call('POST', `/api/work/items/${target.id}/actions`, { token: owner.token, body, headers: key });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.ok(first.body.activity_id, 'the work produced a record without anyone retyping it');
    assert.equal(first.body.item.state, 'resolved');

    // The same request again is the same action, not a second one.
    const retry = await fresh.call('POST', `/api/work/items/${target.id}/actions`, { token: owner.token, body, headers: key });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.activity_id, first.body.activity_id);

    const metrics = await fresh.call('GET', `/api/metrics?from=2000-01-01&to=${day}`, { token: owner.token });
    const money = metrics.body.headline.find((t: any) => t.metricId === 'money:saved');
    assert.equal(money.value, 1000, 'the outcome is counted once, not twice');
    assert.equal(money.outcomes, 1);

    const records = await fresh.call('GET', '/api/records/activities', { token: owner.token });
    assert.equal(records.body.length, 1);
    assert.equal(records.body[0].result, body.note);
  } finally { await fresh.close(); }
});

test('an unlabelled value is refused, because an amount with no type cannot be counted', async () => {
  const target = await byKey(op.token, 'ULO-1');
  await app.call('POST', `/api/work/items/${target.id}/claim`, { token: alex.token, body: {} });
  const res = await app.call('POST', `/api/work/items/${target.id}/actions`, { token: alex.token, body: { kind: 'worked', dollar_amount: 500 } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /what kind of value/i);

  const unknownType = await app.call('POST', `/api/work/items/${target.id}/actions`, { token: alex.token, body: { kind: 'worked', dollar_amount: 500, dollar_type: 'invented' } });
  assert.equal(unknownType.status, 400);
  assert.match(unknownType.body.error, /not a value type this instance tracks/i);
  await app.call('POST', `/api/work/items/${target.id}/release`, { token: alex.token, body: {} });
});

test('a person cannot record work on a row they have not picked up', async () => {
  const target = await byKey(op.token, 'ULO-2');
  const claimed = await app.call('POST', `/api/work/items/${target.id}/claim`, { token: alex.token, body: {} });
  assert.equal(claimed.status, 200);
  const res = await app.call('POST', `/api/work/items/${target.id}/actions`, { token: bree.token, body: { kind: 'worked', note: 'not mine' } });
  assert.equal(res.status, 403);
  assert.match(res.body.error, /pick this work up/i);
  await app.call('POST', `/api/work/items/${target.id}/release`, { token: alex.token, body: {} });
});

test('every contributor is credited with their own work and never with each other’s', async () => {
  const target = await byKey(op.token, 'ULO-1');
  await app.call('POST', `/api/work/items/${target.id}/claim`, { token: alex.token, body: {} });
  await app.call('POST', `/api/work/items/${target.id}/actions`, { token: alex.token, body: { kind: 'contacted', note: 'Asked the vendor for the document.' } });
  await app.call('POST', `/api/work/items/${target.id}/release`, { token: alex.token, body: {} });
  await app.call('POST', `/api/work/items/${target.id}/claim`, { token: bree.token, body: {} });
  await app.call('POST', `/api/work/items/${target.id}/actions`, { token: bree.token, body: { kind: 'validated', note: 'Checked it against the contract.' } });
  await app.call('POST', `/api/work/items/${target.id}/actions`, { token: bree.token, body: { kind: 'resolved', note: 'Closed it out.' } });

  const detail = await app.call('GET', `/api/work/items/${target.id}`, { token: op.token });
  const contributors = detail.body.contributors as Array<Record<string, any>>;
  assert.equal(contributors.length, 2);
  const alexRow = contributors.find((c) => c.user_id === alex.id)!;
  const breeRow = contributors.find((c) => c.user_id === bree.id)!;
  assert.equal(alexRow.actions, 1);
  assert.equal(breeRow.actions, 2);
  assert.equal(detail.body.item.state, 'resolved');
});

test('a work item never reaches someone outside its unit', async () => {
  const list = await app.call('GET', '/api/work/items', { token: outsider.token });
  assert.equal(list.status, 200);
  assert.equal(list.body.total, 0);
  const target = await byKey(op.token, 'ULO-1');
  const peek = await app.call('GET', `/api/work/items/${target.id}`, { token: outsider.token });
  assert.equal(peek.status, 403);
  const grab = await app.call('POST', `/api/work/items/${target.id}/claim`, { token: outsider.token, body: {} });
  assert.equal(grab.status, 403);
});

test('the workbench sorts and filters on the server, with rows without a date last', async () => {
  const byDue = await app.call('GET', '/api/work/items?unit_id=G8&sort=due_date&direction=asc', { token: op.token });
  const dates = byDue.body.items.map((i: any) => i.due_date);
  assert.deepEqual(dates, [...dates].sort((a, b) => (a === null ? 1 : b === null ? -1 : String(a).localeCompare(String(b)))));

  const search = await app.call('GET', '/api/work/items?unit_id=G8&q=second', { token: op.token });
  assert.equal(search.body.total, 1);
  assert.equal(search.body.items[0].natural_key, 'ULO-2');

  const resolved = await app.call('GET', '/api/work/items?unit_id=G8&state=resolved', { token: op.token });
  assert.ok(resolved.body.items.every((i: any) => i.state === 'resolved'));

  const paged = await app.call('GET', '/api/work/items?unit_id=G8&limit=1&offset=1', { token: op.token });
  assert.equal(paged.body.items.length, 1);
  assert.equal(paged.body.total, 2, 'the total describes the whole result, not the page');
});

test('a saved view is personal unless the author has the authority to share it', async () => {
  const mine = await app.call('POST', '/api/work/views', { token: alex.token, body: { name: 'My open cases', config: { state: 'open' } } });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));

  const shareAttempt = await app.call('POST', '/api/work/views', { token: alex.token, body: { name: 'Team queue', unit_id: 'G8', shared: true, config: {} } });
  assert.equal(shareAttempt.status, 403);

  const asOwner = await app.call('POST', '/api/work/views', { token: op.token, body: { name: 'Team queue', unit_id: 'G8', shared: true, config: {} } });
  assert.equal(asOwner.status, 201);

  const seenByAlex = await app.call('GET', '/api/work/views', { token: alex.token });
  const names = seenByAlex.body.map((v: any) => v.name);
  assert.ok(names.includes('My open cases'));
  assert.ok(names.includes('Team queue'), 'a shared view reaches the unit');

  const seenByOutsider = await app.call('GET', '/api/work/views', { token: outsider.token });
  assert.deepEqual(seenByOutsider.body, []);
});

test('a leader can take back work someone else is holding, and a peer cannot', async () => {
  const target = await byKey(op.token, 'ULO-2');
  await app.call('POST', `/api/work/items/${target.id}/claim`, { token: alex.token, body: {} });
  const peer = await app.call('POST', `/api/work/items/${target.id}/release`, { token: bree.token, body: {} });
  assert.equal(peer.status, 403);
  const leader = await app.call('POST', `/api/work/items/${target.id}/release`, { token: op.token, body: {} });
  assert.equal(leader.status, 200, JSON.stringify(leader.body));
  assert.equal(leader.body.claimed_by, null);
});
