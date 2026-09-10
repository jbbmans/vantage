import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { EVENTS, validateProperties } from '../../server/services/telemetry.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let peer: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  peer = await app.register('peer');
  await enroll(app, op.token, 'G8', peer.id);
  peer = { ...peer, token: (await app.login('peer')).body.token };
});
after(async () => { await app.close(); });

const send = (token: string, events: unknown[]) => app.call('POST', '/api/events', { token, body: { events } });
const usage = async (token: string, days = 30) => app.call('GET', `/api/admin/usage?days=${days}`, { token });

const rows = (name: string) =>
  app.ctx.db.prepare('SELECT * FROM product_events WHERE name = ? ORDER BY received_at').all(name) as Array<Record<string, unknown>>;

test('the catalog is closed: an event nobody declared is refused with a reason', async () => {
  const res = await send(op.token, [
    { name: 'surface.viewed', properties: { surface: 'records' } },
    { name: 'keystrokes.captured', properties: { text: 'whatever they typed' } },
  ]);
  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, 1);
  assert.equal(res.body.rejected.length, 1);
  assert.match(res.body.rejected[0].reason, /catalog/);
  assert.equal(rows('keystrokes.captured').length, 0);
});

test('no property can carry content: free text is dropped, not stored', () => {
  const spec = EVENTS['capture.abandoned'];
  const kept = validateProperties(spec, {
    surface: 'quick_log',
    state: 'typed_then_left',
    fields_filled: 3,
    // Everything below is what a leak would look like.
    draft_text: 'Reconciled 30 ULOs for SSgt Alvarez',
    note: 'private',
    body: '<p>hello</p>',
  });
  assert.deepEqual(kept, { surface: 'quick_log', state: 'typed_then_left', fields_filled: 3 });
  // And there is no property anywhere in the catalog that could hold free text in the first place.
  for (const [name, s] of Object.entries(EVENTS)) {
    for (const [key, p] of Object.entries(s.properties)) {
      assert.ok(['number', 'boolean', 'enum'].includes(p.kind), `${name}.${key} is not a scalar`);
      if (p.kind === 'enum') assert.ok(p.values?.length, `${name}.${key} declares no allowed words`);
    }
  }
});

test('a word outside the declared set is dropped rather than stored', async () => {
  await send(op.token, [{ name: 'surface.viewed', properties: { surface: 'the-secret-page' } }]);
  const stored = rows('surface.viewed').at(-1)!;
  assert.deepEqual(JSON.parse(String(stored.properties)), {});
});

test('a client cannot raise an event the server is responsible for', async () => {
  const res = await send(op.token, [{ name: 'ai.answered', properties: { workflow: 'writing', tokens: 999_999, failed: false, reason: 'ok' } }]);
  assert.equal(res.body.accepted, 0);
  assert.match(res.body.rejected[0].reason, /server/);
});

test('the three times stay three: an event only carries the durations it declares', async () => {
  await send(op.token, [{
    name: 'capture.completed',
    properties: { surface: 'quick_log', had_measure: true },
    form_ms: 42_000,
    // editor.session declares this one; capture.completed does not, so it must not be stored here.
    active_editor_ms: 30_000,
    confirmed_work_minutes: 25,
  }]);
  const stored = rows('capture.completed').at(-1)!;
  assert.equal(stored.form_ms, 42_000);
  assert.equal(stored.confirmed_work_minutes, 25);
  assert.equal(stored.active_editor_ms, null, 'a duration the event does not declare must not be stored');
});

test('the actor is the session, not whatever the body claims', async () => {
  await send(peer.token, [{ name: 'surface.viewed', properties: { surface: 'goals' }, user_id: op.id }]);
  const stored = rows('surface.viewed').at(-1)!;
  assert.equal(stored.user_id, peer.id);
});

test('a device clock that is far out is not trusted', async () => {
  const wayOff = new Date(Date.now() + 400 * 86_400_000).toISOString();
  await send(op.token, [{ name: 'surface.viewed', properties: { surface: 'team' }, occurred_at: wayOff }]);
  const stored = rows('surface.viewed').at(-1)!;
  assert.notEqual(stored.occurred_at, wayOff);
  assert.ok(Math.abs(Date.parse(String(stored.occurred_at)) - Date.now()) < 60_000);
});

test('telemetry never blocks the work: a batch of nothing but rubbish still succeeds', async () => {
  const res = await send(op.token, [{ name: '' }, { name: 'nope' }, {}]);
  assert.equal(res.status, 202);
  assert.equal(res.body.accepted, 0);
  assert.equal(res.body.rejected.length, 3);
});

test('the usage console is for owners only', async () => {
  const res = await usage(peer.token);
  assert.equal(res.status, 403);
});

test('a breakdown too few people produced is withheld rather than shown', async () => {
  // One person viewing one destination is a name, however it is labelled.
  await send(op.token, [{ name: 'surface.viewed', properties: { surface: 'readiness' } }]);
  const res = await usage(op.token);
  assert.equal(res.status, 200);
  const surfaces = res.body.report.adoption.surfaces as Array<{ key: string; people: number }>;
  assert.ok(!surfaces.some((s) => s.key === 'readiness'), 'a one-person breakdown must not be listed');
  assert.ok(res.body.report.adoption.surfacesWithheld > 0);
  assert.ok(surfaces.every((s) => s.people >= res.body.minimumCohort));
});

test('the report reports the three times separately and never adds them', async () => {
  const res = await usage(op.token);
  const times = res.body.report.capture.times;
  assert.ok('formOpen' in times && 'activeEditorEstimate' in times && 'confirmedWorkMinutes' in times);
  // There is no combined figure anywhere in the payload for someone to mistake for time worked.
  const text = JSON.stringify(res.body.report);
  assert.ok(!/totalTime|timeSpent|combinedTime/.test(text));
});

test('the server counts an AI call itself, with the cost and not the prompt', async () => {
  const before = rows('ai.answered').length;
  await app.call('POST', '/api/ai/assist', { token: op.token, body: { workflow: 'writing', input: { kind: 'email', source: 'Reconciled 30 ULOs' } } });
  const after = rows('ai.answered');
  assert.equal(after.length, before + 1, 'an AI request must be counted whether it succeeded or failed');
  const props = JSON.parse(String(after.at(-1)!.properties));
  assert.equal(props.workflow, 'writing');
  assert.ok(!JSON.stringify(props).includes('ULO'), 'the prompt must never reach analytics');
});

test('a refusal is counted as a refusal, without saying what was asked for', async () => {
  const before = rows('security.authorization_denied').length;
  await app.call('GET', '/api/admin/overview', { token: peer.token });
  const after = rows('security.authorization_denied');
  assert.equal(after.length, before + 1);
  const props = JSON.parse(String(after.at(-1)!.properties));
  assert.deepEqual(Object.keys(props), ['route']);
  assert.equal(after.at(-1)!.user_id, null, 'a refusal is counted, not attributed');
});

test('every event stored holds nothing but declared scalars', () => {
  const all = app.ctx.db.prepare('SELECT name, properties FROM product_events').all() as Array<{ name: string; properties: string }>;
  assert.ok(all.length > 0);
  for (const row of all) {
    const spec = EVENTS[row.name];
    assert.ok(spec, `${row.name} is stored but not declared`);
    for (const [key, value] of Object.entries(JSON.parse(row.properties))) {
      const declared = spec.properties[key];
      assert.ok(declared, `${row.name}.${key} is stored but not declared`);
      if (declared.kind === 'number') assert.equal(typeof value, 'number');
      if (declared.kind === 'boolean') assert.equal(typeof value, 'boolean');
      if (declared.kind === 'enum') assert.ok(declared.values?.includes(String(value)));
    }
  }
});
