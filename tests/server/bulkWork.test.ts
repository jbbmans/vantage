import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { BULK_WORK_LIMIT } from '../../shared/bulkWork.ts';
import { runBulkWork } from '../../server/services/bulkWork.ts';
import { scopeFor } from '../../server/authz/scope.ts';
import type { SessionUser } from '../../server/context.ts';

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

const holder = (id: string) => (app.ctx.db.prepare('SELECT claimed_by FROM work_items WHERE id = ?').get(id) as { claimed_by: string | null }).claimed_by;
const versionOf = (id: string) => (app.ctx.db.prepare('SELECT version FROM work_items WHERE id = ?').get(id) as { version: number }).version;
/** The summaries one bulk request sent a person, oldest first. */
const summaries = (userId: string, key: string) =>
  app.ctx.db.prepare('SELECT kind, title, org_id FROM notifications WHERE user_id = ? AND dedupe_key LIKE ? ORDER BY created_at, rowid').all(userId, `bulk-%:${key}:%`) as Array<{ kind: string; title: string; org_id: string | null }>;

test('a hand-off stopped by a server error still tells about the cases it applied, and its retry tells about the rest once', async () => {
  const a = await make(); const b = await make();
  for (const item of [a, b]) assert.equal((await post(first.token, `/api/work/items/${item.id}/claim`, { version: item.version })).status, 200);
  const input = { action: 'assign', items: [a, b].map((item) => ({ id: item.id, version: versionOf(item.id) })), to_user_id: next.id, note: 'Synthetic handoff: the award is posted.' };
  // The database fails while the second case is handed on; the first is already committed.
  app.ctx.db.exec(`CREATE TRIGGER bulk_fault BEFORE UPDATE OF claimed_by ON work_items WHEN NEW.id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'Synthetic I/O fault.'); END`);
  let stopped: Awaited<ReturnType<typeof post>>;
  try { stopped = await post(op.token, '/api/work/bulk', input, 'bulk-request-fault'); } finally { app.ctx.db.exec('DROP TRIGGER bulk_fault'); }
  assert.equal(stopped.status, 500, JSON.stringify(stopped.body));
  assert.equal(holder(a.id), next.id); assert.equal(holder(b.id), first.id);
  assert.deepEqual(summaries(next.id, 'bulk-request-fault').map((n) => n.kind), ['work_assigned'], 'its new holder hears of the case already handed');
  assert.match(summaries(next.id, 'bulk-request-fault')[0].title, /handed you a case$/);
  assert.deepEqual(summaries(first.id, 'bulk-request-fault').map((n) => n.kind), ['work_moved'], 'so does the one who held it');

  const retry = await post(op.token, '/api/work/bulk', input, 'bulk-request-fault');
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.deepEqual(retry.body.results.map((r: { replayed?: boolean }) => Boolean(r.replayed)), [true, false]);
  assert.equal(holder(b.id), next.id);
  const told = summaries(next.id, 'bulk-request-fault');
  assert.equal(told.length, 2, 'the retry tells about the case it handed on');
  assert.match(told[1].title, /handed you a case$/, 'and only that one');
  assert.match(summaries(first.id, 'bulk-request-fault')[1].title, /handed a case you held to someone else$/);

  const replay = await post(op.token, '/api/work/bulk', input, 'bulk-request-fault');
  assert.equal(replay.status, 200);
  assert.ok(replay.body.results.every((r: { replayed?: boolean }) => r.replayed));
  assert.equal(summaries(next.id, 'bulk-request-fault').length, 2, 'a run that applies nothing tells nobody');
  assert.equal(summaries(first.id, 'bulk-request-fault').length, 2);
});

test('a notice that fails after a server error does not hide the error that stopped the run', async () => {
  const a = await make(); const b = await make();
  const actor = app.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(op.id) as SessionUser;
  const input = { action: 'assign' as const, items: [a, b], to_user_id: next.id, note: 'Synthetic handoff.' };
  app.ctx.db.exec(`CREATE TRIGGER bulk_fault BEFORE UPDATE OF claimed_by ON work_items WHEN NEW.id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'Synthetic I/O fault.'); END`);
  app.ctx.db.exec("CREATE TRIGGER notice_fault BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'Synthetic notice fault.'); END");
  try {
    assert.throws(() => runBulkWork(app.ctx, actor, scopeFor(app.ctx, actor), input, 'bulk-request-two-faults'), /Synthetic I\/O fault/);
  } finally { app.ctx.db.exec('DROP TRIGGER bulk_fault'); app.ctx.db.exec('DROP TRIGGER notice_fault'); }
  assert.equal(holder(a.id), next.id, 'the case handed before the fault stays handed');
});

test('a hand-off across two Unit Instances sends each person one summary for each, under its own', async () => {
  const lead = await app.register('bulkgonelead');
  assert.equal((await post(op.token, '/api/platform/orgs', { name: 'MARFORRES G-1', code: 'G1', owner_user_id: lead.id })).status, 201);
  const leadToken = (await app.login('bulkgonelead')).body.token as string;
  await enroll(app, leadToken, 'G1', first.id); await enroll(app, leadToken, 'G1', next.id);
  const made = await post(leadToken, '/api/work/items', { unit_id: 'G1', title: 'Synthetic bulk test', reference: `SYN-${crypto.randomUUID()}` });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const items = [await make(), { id: made.body.id as string, version: made.body.version as number }, await make()];
  const claimed = await post(first.token, '/api/work/bulk', { action: 'claim', items }, 'bulk-request-two-claim');
  assert.equal(claimed.body.succeeded, 3, JSON.stringify(claimed.body));
  const input = { action: 'assign', items: items.map((item) => ({ id: item.id, version: versionOf(item.id) })), to_user_id: next.id, note: 'Synthetic handoff across both.' };
  const handed = await post(first.token, '/api/work/bulk', input, 'bulk-request-two-instances');
  assert.equal(handed.body.succeeded, 3, JSON.stringify(handed.body));
  const orgOf = (unitId: string) => (app.ctx.db.prepare('SELECT org_id FROM units WHERE id = ?').get(unitId) as { org_id: string }).org_id;
  const told = summaries(next.id, 'bulk-request-two-instances');
  assert.equal(told.length, 2, JSON.stringify(told));
  const byOrg = new Map(told.map((n) => [n.org_id, n.title]));
  assert.match(byOrg.get(orgOf('G8')) ?? '', /handed you 2 cases$/);
  assert.match(byOrg.get(orgOf('G1')) ?? '', /handed you a case$/);
});
