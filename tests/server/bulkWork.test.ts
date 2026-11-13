import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { BULK_WORK_LIMIT } from '../../shared/bulkWork.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let first: { token: string; id: string };
let next: { token: string; id: string };
let outsider: { token: string; id: string };
before(async () => {
  app = await startApp(); op = await app.setupOperator();
  first = await app.register('bulkfirst'); next = await app.register('bulknext'); outsider = await app.register('bulkoutside');
  await enroll(app, op.token, 'G8', first.id); await enroll(app, op.token, 'G8', next.id);
  first.token = (await app.login('bulkfirst')).body.token;
  next.token = (await app.login('bulknext')).body.token;
});
after(async () => { await app.close(); });
const post = (token: string, path: string, body: unknown, key?: string) => app.call('POST', path, { token, body, headers: key ? { 'idempotency-key': key } : {} });
async function make() {
  const r = await post(op.token, '/api/work/items', { unit_id: 'G8', title: 'Synthetic bulk test', reference: `SYN-${crypto.randomUUID()}` });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.id as string, version: r.body.version as number };
}
const detail = async (id: string) => (await app.call('GET', `/api/work/items/${id}`, { token: op.token })).body;
const count = (id: string, kind: string) => (app.ctx.db.prepare('SELECT COUNT(*) AS n FROM work_events WHERE work_item_id = ? AND kind = ?').get(id, kind) as { n: number }).n;

test('preview is read-only; apply records each claim once and a retry with stale versions succeeds without repeating it', async () => {
  const a = await make(); const b = await make(); const input = { action: 'claim', items: [a, b] };
  const preview = await post(first.token, '/api/work/bulk/preview', input);
  assert.equal(preview.status, 200); assert.equal(preview.body.succeeded, 2);
  assert.equal((await detail(a.id)).item.claimed_by, null); assert.equal(count(a.id, 'claimed'), 0);
  const apply = await post(first.token, '/api/work/bulk', input, 'bulk-request-claim');
  assert.equal(apply.status, 200, JSON.stringify(apply.body)); assert.equal(apply.body.succeeded, 2);
  const retry = await post(first.token, '/api/work/bulk', input, 'bulk-request-claim');
  assert.equal(retry.status, 200); assert.equal(retry.body.succeeded, 2);
  assert.ok(retry.body.results.every((r: { replayed: boolean }) => r.replayed));
  for (const item of [a, b]) { const d = await detail(item.id); assert.equal(count(item.id, 'claimed'), 1); assert.equal(d.item.claimed_by, first.id); assert.equal(d.case.integrity.status, 'verified'); }
});

test('partial results keep a changed row intact and do not expose a case to an outsider', async () => {
  const a = await make(); const b = await make();
  await post(next.token, `/api/work/items/${b.id}/claim`, { version: b.version });
  const r = await post(first.token, '/api/work/bulk', { action: 'claim', items: [a, b] }, 'bulk-request-partial');
  assert.equal(r.status, 200); assert.equal(r.body.succeeded, 1); assert.equal(r.body.failed, 1);
  assert.equal(r.body.results[1].code, 'version_conflict');
  assert.equal((await detail(b.id)).item.claimed_by, next.id);
  const denied = await post(outsider.token, '/api/work/bulk/preview', { action: 'claim', items: [a, b] });
  assert.equal(denied.status, 200); assert.equal(denied.body.succeeded, 0);
  assert.ok(denied.body.results.every((row: { reference: string | null; code: string }) => row.reference === null && row.code === 'unavailable'));
  const candidates = await post(outsider.token, '/api/work/bulk/candidates', { ids: [a.id, b.id] });
  assert.deepEqual(candidates.body, []);
});

test('an assigned case cannot be taken or released by a peer; its holder can hand it off with a required note', async () => {
  const item = await make();
  const claimed = await post(first.token, `/api/work/items/${item.id}/claim`, { version: item.version });
  const current = { id: item.id, version: claimed.body.version };
  const release = await post(next.token, '/api/work/bulk', { action: 'release', items: [current] }, 'bulk-request-denied');
  assert.equal(release.body.succeeded, 0); assert.equal(release.body.results[0].code, 'forbidden');
  const candidates = await post(first.token, '/api/work/bulk/candidates', { ids: [item.id] });
  assert.ok(candidates.body.some((p: { id: string }) => p.id === next.id));
  assert.ok(!candidates.body.some((p: { id: string }) => p.id === outsider.id));
  const input = { action: 'assign', items: [current], to_user_id: next.id, note: 'Synthetic handoff: check the posted award.' };
  assert.equal((await post(first.token, '/api/work/bulk/preview', { ...input, note: ' ' })).status, 400);
  const applied = await post(first.token, '/api/work/bulk', input, 'bulk-request-handoff');
  assert.equal(applied.body.succeeded, 1, JSON.stringify(applied.body));
  const retry = await post(first.token, '/api/work/bulk', input, 'bulk-request-handoff');
  assert.equal(retry.body.succeeded, 1); assert.equal(count(item.id, 'handed_off'), 1);
  const conflicting = await post(first.token, '/api/work/bulk', { ...input, note: 'Changed payload.' }, 'bulk-request-handoff');
  assert.equal(conflicting.body.results[0].code, 'idempotency_conflict');
  assert.equal((await detail(item.id)).item.claimed_by, next.id);
});

test('a recipient must be active and able to claim the specific case; selection, key and versions are bounded', async () => {
  const item = await make();
  const input = { action: 'assign', items: [item], to_user_id: outsider.id, note: 'Not authorized.' };
  assert.equal((await post(op.token, '/api/work/bulk/preview', input)).body.results[0].code, 'ineligible_target');
  assert.equal((await post(op.token, '/api/work/bulk', { action: 'claim', items: [item] })).status, 400);
  for (const items of [[], [item, item], [{ ...item, version: -1 }], Array.from({ length: BULK_WORK_LIMIT + 1 }, (_, i) => ({ id: `case-${i}`, version: 1 }))]) {
    assert.equal((await post(first.token, '/api/work/bulk/preview', { action: 'claim', items })).status, 400);
  }
  assert.equal((await post(first.token, '/api/work/bulk/candidates', { ids: Array.from({ length: BULK_WORK_LIMIT + 1 }, (_, i) => String(i)) })).status, 400);
});

test('release retries do not add history or overwrite a subsequent claim', async () => {
  const item = await make();
  const held = await post(first.token, `/api/work/items/${item.id}/claim`, { version: item.version });
  const input = { action: 'release', items: [{ id: item.id, version: held.body.version }] };
  assert.equal((await post(first.token, '/api/work/bulk', input, 'bulk-request-release')).body.succeeded, 1);
  const free = (await detail(item.id)).item;
  await post(next.token, `/api/work/items/${item.id}/claim`, { version: free.version });
  assert.equal((await post(first.token, '/api/work/bulk', input, 'bulk-request-release')).body.succeeded, 1);
  assert.equal(count(item.id, 'released'), 1); assert.equal((await detail(item.id)).item.claimed_by, next.id);
});
