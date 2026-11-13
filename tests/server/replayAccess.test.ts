import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll } from './helpers.ts';

test('old research and action keys cannot expose current case content after membership is removed', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const member = await app.register('replayformer');
    await enroll(app, op.token, 'G8', member.id);
    member.token = (await app.login('replayformer')).body.token;
    const made = await app.call('POST', '/api/work/items', { token: op.token, body: { unit_id: 'G8', title: 'Synthetic original title', reference: 'SYN-REPLAY' } });
    const id = made.body.id;
    await app.call('POST', `/api/work/items/${id}/claim`, { token: member.token, body: { version: made.body.version } });
    const research = { kind: 'finding', text: 'Synthetic original finding.' };
    const action = { kind: 'worked', note: 'Synthetic original action.' };
    const send = (suffix: string, body: unknown, key: string) => app.call('POST', `/api/work/items/${id}/${suffix}`, { token: member.token, body, headers: { 'idempotency-key': key } });
    assert.equal((await send('entries', research, 'synthetic-research-key')).status, 201);
    assert.equal((await send('actions', action, 'synthetic-action-key')).status, 201);
    await app.call('POST', `/api/work/items/${id}/release`, { token: member.token, body: {} });
    app.ctx.db.prepare('DELETE FROM unit_members WHERE user_id = ? AND unit_id = ?').run(member.id, 'G8');
    app.ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND unit_id = ?').run(member.id, 'G8');
    app.ctx.db.prepare('UPDATE work_items SET title = ?, data = ? WHERE id = ?').run('SYNTHETIC NEW PRIVATE TITLE', JSON.stringify({ synthetic: 'NEW UNIT-ONLY DATA' }), id);
    for (const [suffix, body, key] of [['entries', research, 'synthetic-research-key'], ['actions', action, 'synthetic-action-key']] as const) {
      const replay = await send(suffix, body, key);
      assert.equal(replay.status, 403, replay.text);
      assert.ok(!replay.text.includes('SYNTHETIC NEW PRIVATE TITLE'));
      assert.ok(!replay.text.includes('NEW UNIT-ONLY DATA'));
    }
  } finally { await app.close(); }
});

test('a retried action is answered with the saved one even after its value type stops being tracked', async () => {
  const app = await startApp();
  try {
    const op = await app.setupOperator();
    const made = await app.call('POST', '/api/work/items', { token: op.token, body: { unit_id: 'G8', title: 'Synthetic retried action', reference: 'SYN-RETRY' } });
    const id = made.body.id;
    await app.call('POST', `/api/work/items/${id}/claim`, { token: op.token, body: { version: made.body.version } });
    const type = app.ctx.runtime.metrics.value_types[0].key;
    const action = { kind: 'worked', note: 'Synthetic valued action.', dollar_amount: 125, dollar_type: type };
    const send = () => app.call('POST', `/api/work/items/${id}/actions`, { token: op.token, body: action, headers: { 'idempotency-key': 'synthetic-retry-key' } });
    const first = await send();
    assert.equal(first.status, 201, first.text);
    app.ctx.runtime.metrics = { ...app.ctx.runtime.metrics, value_types: app.ctx.runtime.metrics.value_types.filter((t) => t.key !== type) };
    const retry = await send();
    assert.ok(retry.status < 300, retry.text);
    assert.equal(retry.body.replayed, true);
    assert.equal((app.ctx.db.prepare('SELECT COUNT(*) AS n FROM work_actions WHERE work_item_id = ?').get(id) as { n: number }).n, 1);
    // A new request with that type is refused, as before.
    const fresh = await app.call('POST', `/api/work/items/${id}/actions`, { token: op.token, body: action, headers: { 'idempotency-key': 'synthetic-new-key' } });
    assert.equal(fresh.status, 400, fresh.text);
  } finally { await app.close(); }
});
