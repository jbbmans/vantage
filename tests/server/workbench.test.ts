import { test, after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';

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

test('a record drafted from work counts against the same per-person limit as one typed in', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const item = await fresh.call('POST', '/api/work/items', { token: owner.token, body: { unit_id: 'G8', title: 'Quota check', visibility: 'unit' } });
    assert.equal(item.status, 201, JSON.stringify(item.body));
    const held = ['activities', 'projects', 'tasks', 'goals', 'trainings', 'awards', 'counselings'].reduce((n, t) => n + (fresh.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(owner.id) as { n: number }).n, 0);
    (fresh.ctx.config.limits as { maxRecordsPerUser: number }).maxRecordsPerUser = held;
    const drafted = await fresh.call('POST', `/api/work/items/${item.body.id}/actions`, { token: owner.token, body: { kind: 'worked', note: 'Synthetic note', draft_record: true } });
    assert.equal(drafted.status, 507);
    assert.equal(drafted.body.code, 'record_quota');
    const plain = await fresh.call('POST', `/api/work/items/${item.body.id}/actions`, { token: owner.token, body: { kind: 'worked', note: 'Synthetic note' } });
    assert.equal(plain.status, 201, 'recording what you did without a record is unaffected');
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

  // Too many settings is refused, never cut into something that is not JSON and then shared.
  const huge = await app.call('POST', '/api/work/views', { token: op.token, body: { name: 'Everything', unit_id: 'G8', shared: true, config: { columns: Array.from({ length: 900 }, (_, i) => `column_${i}`) } } });
  assert.equal(huge.status, 400);
  // And a view stored broken by an older build does not take the list down for the team.
  app.ctx.db.prepare("UPDATE work_views SET config = '{\"state\":\"op' WHERE name = 'Team queue'").run();
  const stillListed = await app.call('GET', '/api/work/views', { token: alex.token });
  assert.equal(stillListed.status, 200);
  assert.deepEqual(stillListed.body.find((v: any) => v.name === 'Team queue').config, {});
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

/**
 * Claiming used to be the only decision the system made, which meant one gate answered four
 * different questions. These prove each one separately.
 */

/**
 * A row of its own, so these do not inherit whatever state an earlier test left ULO-1 in.
 * Each import carries a natural key nothing else uses.
 */
let seq = 0;
async function freshRow(token: string, title = 'Clear a fresh obligation') {
  const key = `FRESH-${Date.now()}-${seq++}`;
  const csv = ['Document,Description,Due,Amount,Type', `${key},${title},2026-08-30,1500,deobligated`].join('\n');
  const source = await app.call('POST', '/api/work/sources', {
    token, raw: Buffer.from(csv),
    headers: { 'content-type': 'text/csv', 'x-filename': `${key}.csv`, 'x-unit-id': 'G8', 'x-visibility': 'unit' },
  });
  assert.equal(source.status, 201, JSON.stringify(source.body));
  const job = await app.call('POST', '/api/work/imports', { token, body: { ...PLAN, sheet_name: `${key}.csv`, source_file_id: source.body.id } });
  assert.equal(job.status, 201, JSON.stringify(job.body));
  return byKey(token, key);
}

test('a unit can let somebody work cases without letting them close one', async () => {
  // The default keeps claiming and resolving together, because that is what claiming already meant.
  // What the split buys is this: a unit can now take RESOLVE_WORK off a role and the holder still
  // works the queue. So the test takes it off rather than relying on a default.
  const stripped = await app.call('PUT', '/api/org/roles/G8:marine', {
    token: op.token, body: { permissions: PERMISSIONS.VIEW_UNIT | PERMISSIONS.CLAIM_WORK },
  });
  assert.equal(stripped.status, 200, JSON.stringify(stripped.body));
  // Editing a role revokes every holder's session so the new authority is re-read — and the
  // operator holds the default role too, so both tokens have to be taken again.
  const worker = (await app.login('alex')).body.token;
  const leader = (await app.login('boletz')).body.token;

  try {
    const row = await freshRow(leader, 'Clear the obligation nobody has touched');
    const claim = await app.call('POST', `/api/work/items/${row.id}/claim`, { token: worker, body: { version: row.version } });
    assert.equal(claim.status, 200, `claiming stays theirs: ${JSON.stringify(claim.body)}`);

    // Moving it along is execution, and stays with whoever holds it.
    const progress = await app.call('PATCH', `/api/work/items/${row.id}`, { token: worker, body: { state: 'waiting', version: claim.body.version } });
    assert.equal(progress.status, 200, JSON.stringify(progress.body));

    // Declaring it finished is not.
    const close = await app.call('PATCH', `/api/work/items/${row.id}`, { token: worker, body: { state: 'resolved', version: progress.body.version } });
    assert.equal(close.status, 403, 'holding a case is not authority to close it');
    assert.match(close.body.error, /closing one out is not yours/i);

    // And the action path is not a way around it, which is where the split was previously open:
    // recordAction wrote state='resolved' after checking only that the caller held the claim.
    const viaAction = await app.call('POST', `/api/work/items/${row.id}/actions`, {
      token: worker, body: { kind: 'resolved', note: 'Closing it out the back way.' },
    });
    assert.equal(viaAction.status, 403, 'recording a resolving action is not a way around RESOLVE_WORK');
    const after = await byKey(leader, row.natural_key);
    assert.notEqual(after.state, 'resolved', 'and the item did not move');

    // Somebody who holds RESOLVE_WORK can.
    const byLeader = await app.call('PATCH', `/api/work/items/${row.id}`, { token: leader, body: { state: 'resolved', version: progress.body.version } });
    assert.equal(byLeader.status, 200, JSON.stringify(byLeader.body));
    assert.equal(byLeader.body.state, 'resolved');
  } finally {
    // Put the role back so later tests see the shipped default, then take fresh tokens again for
    // the same reason: restoring it revokes the sessions a second time.
    await app.call('PUT', '/api/org/roles/G8:marine', {
      token: (await app.login('boletz')).body.token,
      body: { permissions: PERMISSIONS.VIEW_UNIT | PERMISSIONS.CLAIM_WORK | PERMISSIONS.RESOLVE_WORK },
    });
    op.token = (await app.login('boletz')).body.token;
    alex.token = (await app.login('alex')).body.token;
    bree.token = (await app.login('bree')).body.token;
  }
});

test('work can be handed to somebody, and only to somebody who can already see it', async () => {
  const current = await freshRow(op.token, 'Chase the second endorsement');

  const handed = await app.call('POST', `/api/work/items/${current.id}/assign`, { token: op.token, body: { user_id: bree.id, version: current.version } });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(handed.body.claimed_by, bree.id, 'the case is now held by the person it was given to');

  // They are told about it.
  const inbox = await app.call('GET', '/api/me/notifications', { token: bree.token });
  assert.ok((inbox.body.rows as Array<{ kind: string }>).some((n) => n.kind === 'work_assigned'), 'the recipient hears about it');

  // Somebody outside the unit cannot be handed work they could not otherwise see.
  const toStranger = await app.call('POST', `/api/work/items/${current.id}/assign`, { token: op.token, body: { user_id: outsider.id, version: handed.body.version } });
  assert.equal(toStranger.status, 400);
  assert.match(toStranger.body.error, /cannot see this work/i);

  // And a plain member cannot hand work around at all.
  const byMember = await app.call('POST', `/api/work/items/${current.id}/assign`, { token: alex.token, body: { user_id: alex.id, version: handed.body.version } });
  assert.equal(byMember.status, 403);
});

/**
 * The provenance rule, now stated by the server rather than kept by accident because no route
 * happened to offer the write.
 */
test('a value that came off an imported sheet is read-only, at every level', async () => {
  const row = await freshRow(op.token, 'Reconcile the imported figure');
  for (const [field, value] of [['title', 'Rewritten title'], ['reference', 'ULO-999'], ['due_date', '2027-01-01']] as const) {
    const res = await app.call('PATCH', `/api/work/items/${row.id}`, { token: op.token, body: { [field]: value, version: row.version } });
    assert.equal(res.status, 403, `${field} should be refused on an imported row`);
    assert.match(res.body.error, /imported sheet/i);
  }
  // The row is untouched.
  const after = await byKey(op.token, row.natural_key);
  assert.equal(after.reference, row.reference);
  assert.equal(after.title, row.title);
});

test('a row somebody typed in is theirs to correct, unlike one off a sheet', async () => {
  const made = await app.call('POST', '/api/work/items', {
    token: op.token,
    body: { unit_id: 'G8', title: 'Chase the missing signature', visibility: 'unit' },
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.source_file_id, null, 'a typed row has no sheet behind it');

  const fixed = await app.call('PATCH', `/api/work/items/${made.body.id}`, {
    token: op.token, body: { title: 'Chase the missing signature (2nd endorsement)', version: made.body.version },
  });
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.match(fixed.body.title, /2nd endorsement/);

  // Somebody with no EDIT_WORK here cannot rewrite it either — typed does not mean unguarded.
  const byMember = await app.call('PATCH', `/api/work/items/${made.body.id}`, {
    token: alex.token, body: { title: 'Something else entirely', version: fixed.body.version },
  });
  assert.equal(byMember.status, 403);
});

/**
 * The point of the whole exercise: a project holds the work under it, whether somebody typed that
 * work in or it arrived on a spreadsheet. Before this a project and the queue were two unrelated
 * piles with no column joining them.
 */
test('a project holds typed work and imported work in one list', async () => {
  const project = await app.call('POST', '/api/records/projects', {
    token: op.token, body: { name: 'October reconciliation', visibility: 'unit' },
  });
  assert.equal(project.status, 201, JSON.stringify(project.body));

  const typed = await app.call('POST', '/api/work/items', {
    token: op.token,
    body: { unit_id: 'G8', title: 'Ring the comptroller about the mismatch', project_id: project.body.id, visibility: 'unit' },
  });
  assert.equal(typed.status, 201, JSON.stringify(typed.body));
  assert.equal(typed.body.project_id, project.body.id);

  // An imported row filed under the same project.
  const imported = await freshRow(op.token, 'Clear the obligation from the sheet');
  const filed = await app.call('PATCH', `/api/work/items/${imported.id}`, {
    token: op.token, body: { project_id: project.body.id, version: imported.version },
  });
  // Filing an imported row under a project is not rewriting what the sheet said, so it is allowed.
  assert.equal(filed.status, 200, JSON.stringify(filed.body));

  const listed = await app.call('GET', `/api/work/items?unit_id=G8&project_id=${project.body.id}`, { token: op.token });
  assert.equal(listed.status, 200);
  const titles = (listed.body.items as Array<{ title: string }>).map((i) => i.title).sort();
  assert.equal(titles.length, 2, 'both kinds of work are in the project’s list');
  assert.ok(titles.some((t) => /comptroller/.test(t)), 'the typed one');
  assert.ok(titles.some((t) => /from the sheet/.test(t)), 'the imported one');
});

test('work cannot be filed under a project the caller cannot reach', async () => {
  const secret = await app.call('POST', '/api/records/projects', { token: alex.token, body: { name: 'Alex private project', visibility: 'private' } });
  assert.equal(secret.status, 201, JSON.stringify(secret.body));
  const attempt = await app.call('POST', '/api/work/items', {
    token: bree.token, body: { unit_id: 'G8', title: 'Sneak into their project', project_id: secret.body.id, visibility: 'unit' },
  });
  assert.ok(attempt.status === 403 || attempt.status === 400, `expected refusal, got ${attempt.status}`);
});

test('a claim nobody touches goes back on the queue by itself', async () => {
  const { releaseStaleClaims } = await import('../../server/services/work.ts');
  const free = await freshRow(op.token, 'Sit on this one over the weekend');
  const held = await app.call('POST', `/api/work/items/${free.id}/claim`, { token: alex.token, body: { version: free.version } });
  assert.equal(held.status, 200, JSON.stringify(held.body));

  // Nothing is stale yet, so a sweep leaves it alone.
  assert.equal(releaseStaleClaims(app.ctx, 72), 0, 'a fresh claim is not stale');

  // Age the claim rather than shrinking the window to zero. A zero-hour window puts the cutoff at
  // the same millisecond the claim was made, so `claimed_at < cutoff` is a coin flip decided by how
  // fast the machine is — it passed here and failed in CI. Backdating exercises the real condition:
  // a claim nobody has touched for days.
  const old = new Date(Date.now() - 100 * 3_600_000).toISOString();
  app.ctx.db.prepare('UPDATE work_items SET claimed_at = ?, updated_at = ? WHERE id = ?').run(old, old, free.id);

  assert.equal(releaseStaleClaims(app.ctx, 72), 1, 'a claim older than the window is given up');
  const after = await byKey(op.token, free.natural_key);
  assert.equal(after.claimed_by, null, 'the row is back on the queue');
  assert.equal(after.state, 'open');
});

/**
 * work_items.project_id is the only one of the three project links with a real foreign key, so
 * forgetting it in the purge does not leave a dangling row — it makes the purge throw and roll back,
 * every time it runs, until somebody clears the reference by hand.
 */
test('purging a project detaches the work filed under it instead of failing forever', async () => {
  const { purgeDeleted } = await import('../../server/services/records.ts');
  const project = await app.call('POST', '/api/records/projects', { token: op.token, body: { name: 'Doomed project', visibility: 'unit' } });
  assert.equal(project.status, 201, JSON.stringify(project.body));

  const item = await app.call('POST', '/api/work/items', {
    token: op.token, body: { unit_id: 'G8', title: 'Filed under a project about to go', project_id: project.body.id, visibility: 'unit' },
  });
  assert.equal(item.status, 201, JSON.stringify(item.body));

  // Delete it and backdate the deletion past the retention cutoff.
  assert.equal((await app.call('DELETE', `/api/records/projects/${project.body.id}`, { token: op.token })).status, 200);
  const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
  app.ctx.db.prepare('UPDATE projects SET deleted_at = ? WHERE id = ?').run(old, project.body.id);

  // Without the detach this throws a foreign-key error and takes the whole transaction with it.
  const result = purgeDeleted(app.ctx, 30);
  assert.ok(result.records >= 1, 'the project was actually purged');
  assert.equal(app.ctx.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(project.body.id), undefined);

  // The work survives, detached rather than deleted: it is somebody's record of what they did.
  const survivor = app.ctx.db.prepare('SELECT project_id FROM work_items WHERE id = ?').get(item.body.id) as { project_id: string | null } | undefined;
  assert.ok(survivor, 'the work item is still there');
  assert.equal(survivor!.project_id, null, 'and no longer points at a project that is gone');
});
