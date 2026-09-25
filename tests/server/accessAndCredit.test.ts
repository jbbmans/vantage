import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { UMT_2WAY } from '../../shared/procedures.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let avery: { token: string; id: string };
let chen: { token: string; id: string };
let ftl: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  avery = await app.register('avery');
  chen = await app.register('chen');
  ftl = await app.register('ftl');
  await enroll(app, op.token, 'G8', avery.id);
  await enroll(app, op.token, 'G8', chen.id);
  await enroll(app, op.token, 'G8', ftl.id, 'fire-team-leader');
  avery.token = (await app.login('avery')).body.token;
  chen.token = (await app.login('chen')).body.token;
  ftl.token = (await app.login('ftl')).body.token;
});
after(async () => { await app.close(); });

const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const get = (token: string, path: string) => app.call('GET', path, { token });

async function umt(reference: string, extra: Record<string, unknown> = {}, token = op.token) {
  const made = await post(token, '/api/work/items', { unit_id: 'G8', title: '2-Way UMT', reference, ...extra });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  app.ctx.db.prepare('UPDATE work_items SET amount = 1527.81 WHERE id = ?').run(made.body.id);
  await post(token, `/api/work/items/${made.body.id}/procedure`, { key: UMT_2WAY.key });
  return made.body.id as string;
}

test('F05: a claim, or a stage moved, is not enough to draft a record entry', async () => {
  const id = await umt('SYN-AC-1');
  await post(avery.token, `/api/work/items/${id}/claim`);
  const onlyClaim = await post(avery.token, '/api/record/drafts/from-work', { work_item_id: id });
  assert.equal(onlyClaim.status, 409, JSON.stringify(onlyClaim.body));
  assert.equal(onlyClaim.body.code, 'nothing_to_draft');

  await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'waiting', waiting_category: 'approval' });
  await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'researching' });
  assert.equal((await post(avery.token, '/api/record/drafts/from-work', { work_item_id: id })).status, 409, 'moving stages is bookkeeping');

  const detail = await get(avery.token, `/api/work/items/${id}`);
  assert.ok(!detail.body.case.contributors.some((c: any) => c.user_id === avery.id), 'she is not listed as having worked it');

  await post(avery.token, `/api/work/items/${id}/entries`, { kind: 'finding', text: 'The PO line is short by one unit.' });
  const draft = await post(avery.token, '/api/record/drafts/from-work', { work_item_id: id });
  assert.equal(draft.status, 201, 'a finding is substantive');
  assert.deepEqual(draft.body.facts.map((f: any) => f.source.kind), ['finding']);
});

test('F05: a legacy draft with no facts cannot be saved as a completed entry', async () => {
  const at = new Date().toISOString();
  app.ctx.db.prepare(`INSERT INTO record_drafts (id, user_id, work_item_id, title, facts, wording, wording_source, version, created_at, updated_at) VALUES ('legacy-empty', ?, NULL, 'Old', '[]', 'contributed to the work', 'template', 1, ?, ?)`).run(avery.id, at, at);
  const saved = await post(avery.token, '/api/record/drafts/legacy-empty/save');
  assert.equal(saved.status, 409);
  assert.equal(saved.body.code, 'nothing_to_draft');
});

test('F04: a verification corrected away, or overtaken by a later check, stops counting as verified', async () => {
  const before = (await get(avery.token, '/api/record/summary')).body.contributions;
  const id = await umt('SYN-AC-2');
  await post(avery.token, `/api/work/items/${id}/claim`);
  const v = await post(avery.token, `/api/work/items/${id}/entries`, { kind: 'verification', check: 'condition_cleared', result: 'verified', reference: 'UMT report 09-20' });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  let now = (await get(avery.token, '/api/record/summary')).body.contributions;
  assert.equal(now.verified_outcomes, before.verified_outcomes + 1);

  await post(avery.token, `/api/work/items/${id}/entries`, { kind: 'verification', check: 'condition_cleared', result: 'not_verified', reference: 'Read the wrong line', supersedes: v.body.event.id });
  now = (await get(avery.token, '/api/record/summary')).body.contributions;
  assert.equal(now.verified_outcomes, before.verified_outcomes, 'the corrected verification is no longer a verified outcome');
  assert.equal(now.verification_actions, before.verification_actions + 2, 'both entries remain in what she did');
  const row = (await get(avery.token, '/api/record/contributions')).body.find((h: any) => h.item.id === id);
  assert.equal(row.verified, 0);

  const id2 = await umt('SYN-AC-3');
  await post(avery.token, `/api/work/items/${id2}/claim`);
  await post(avery.token, `/api/work/items/${id2}/entries`, { kind: 'verification', check: 'condition_cleared', result: 'verified', reference: 'UMT report 09-21' });
  const mid = (await get(avery.token, '/api/record/summary')).body.contributions.verified_outcomes;
  await post(avery.token, `/api/work/items/${id2}/handoff`, { to_user_id: chen.id, note: 'Please re-check tomorrow’s report.' });
  await post(chen.token, `/api/work/items/${id2}/entries`, { kind: 'verification', check: 'condition_cleared', result: 'not_verified', reference: 'UMT report 09-22 shows it again' });
  const after = (await get(avery.token, '/api/record/summary')).body.contributions.verified_outcomes;
  assert.equal(after, mid - 1, 'a later check that failed overtakes the earlier pass');

  const workload = (await get(ftl.token, '/api/work/workload?unit_id=G8')).body;
  const averyRow = workload.members.find((m: any) => m.id === avery.id);
  assert.equal(averyRow.verified_outcomes, after, 'the team view uses the same definition');
});

test('F03: private work carrying a unit id stays out of the unit’s totals', async () => {
  const base = (await get(ftl.token, '/api/work/workload?unit_id=G8')).body;
  const privateId = await umt('SYN-AC-4', { visibility: 'private' }, avery.token);
  const row = app.ctx.db.prepare('SELECT visibility, unit_id FROM work_items WHERE id = ?').get(privateId) as { visibility: string; unit_id: string };
  assert.equal(row.visibility, 'private');
  assert.equal(row.unit_id, 'G8');
  await post(avery.token, `/api/work/items/${privateId}/entries`, { kind: 'finding', text: 'Private research.' });
  await post(avery.token, `/api/work/items/${privateId}/entries`, { kind: 'action_submitted', step: 'submit_modification', reference: 'P0001' });

  const afterPrivate = (await get(ftl.token, '/api/work/workload?unit_id=G8')).body;
  assert.equal(afterPrivate.section.documents_researched, base.section.documents_researched, 'section research unchanged');
  assert.equal(afterPrivate.section.submitted, base.section.submitted, 'section submissions unchanged');
  const was = base.members.find((m: any) => m.id === avery.id);
  const is = afterPrivate.members.find((m: any) => m.id === avery.id);
  assert.equal(is.documents_researched, was.documents_researched, 'her unit breakdown excludes private work');
  assert.equal(is.submitted_actions, was.submitted_actions);

  const own = (await get(avery.token, '/api/record/summary')).body.contributions;
  assert.ok(own.documents_researched >= 1, 'her own Record still counts it');
  assert.equal((await get(ftl.token, `/api/work/items/${privateId}`)).status, 403, 'and the leader cannot open it');
});

test('F09: a saved draft links its case, counts once, and credits money only for a verified, resolved outcome', async () => {
  const id = await umt('SYN-AC-5');
  await post(avery.token, `/api/work/items/${id}/claim`);
  await post(avery.token, `/api/work/items/${id}/entries`, { kind: 'observation', field: 'current_award', amount: '99156.50', system: 'DAI' });
  const first = await post(avery.token, '/api/record/drafts/from-work', { work_item_id: id });
  const saved = await post(avery.token, `/api/record/drafts/${first.body.id}/save`);
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  const act = app.ctx.db.prepare('SELECT quantity, unit_label, dollar_amount, dollar_type, evidence_links, notes, fingerprint FROM activities WHERE id = ?').get(saved.body.activity_id) as any;
  assert.equal(act.quantity, 1);
  assert.equal(act.unit_label, 'UMTs');
  assert.equal(act.dollar_amount, null, 'no money credited for an unresolved case');
  assert.match(act.notes, /not resolved/);
  assert.deepEqual(JSON.parse(act.evidence_links), [{ label: 'Vantage case SYN-AC-5', url: `/work/items/${id}` }]);
  assert.equal(act.fingerprint, `case:${id}`);
  assert.match(act.notes, /\[observation [0-9a-f-]+\]/, 'each fact cites its event');

  const second = await post(avery.token, '/api/record/drafts/from-work', { work_item_id: id });
  const again = await post(avery.token, `/api/record/drafts/${second.body.id}/save`);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'already_recorded');
  assert.equal(again.body.activity_id, saved.body.activity_id);

  // A resolved case whose outcome she verified is credited as reconciled.
  const id2 = await umt('SYN-AC-6');
  await post(avery.token, `/api/work/items/${id2}/claim`);
  await post(avery.token, `/api/work/items/${id2}/entries`, { kind: 'verification', check: 'condition_cleared', result: 'verified', reference: 'UMT report 09-23' });
  const resolved = await post(op.token, `/api/work/items/${id2}/stage`, { stage: 'resolved', reason: 'Cleared on the report.' });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  const d2 = await post(avery.token, '/api/record/drafts/from-work', { work_item_id: id2 });
  const s2 = await post(avery.token, `/api/record/drafts/${d2.body.id}/save`);
  const act2 = app.ctx.db.prepare('SELECT dollar_amount, dollar_type FROM activities WHERE id = ?').get(s2.body.activity_id) as any;
  assert.equal(act2.dollar_amount, 1527.81);
  assert.equal(act2.dollar_type, 'reconciled');
});

test('F02: leaving the unit releases held work and ends access, but keeps the person’s own history', async () => {
  const leaver = await app.register('leaver');
  await enroll(app, op.token, 'G8', leaver.id);
  leaver.token = (await app.login('leaver')).body.token;
  const id = await umt('SYN-AC-7');
  const claimed = await post(leaver.token, `/api/work/items/${id}/claim`);
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  await post(leaver.token, `/api/work/items/${id}/entries`, { kind: 'finding', text: 'Award needs one more unit.' });
  const own = await post(op.token, '/api/work/items', { unit_id: 'G8', title: 'Typed-in case', reference: 'SYN-AC-8' });
  app.ctx.db.prepare('UPDATE work_items SET owner_id = ? WHERE id = ?').run(leaver.id, own.body.id);

  const removed = await app.call('DELETE', `/api/org/units/G8/members/${leaver.id}`, { token: op.token });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.claimsReleased, 1);

  const row = app.ctx.db.prepare('SELECT claimed_by FROM work_items WHERE id = ?').get(id) as { claimed_by: string | null };
  assert.equal(row.claimed_by, null, 'the work is back in the queue');
  const ev = app.ctx.db.prepare("SELECT body, subject_id, actor_id FROM work_events WHERE work_item_id = ? AND kind = 'claim_expired'").get(id) as any;
  assert.equal(JSON.parse(ev.body).reason, 'left_unit');
  assert.equal(ev.subject_id, leaver.id);
  assert.equal(ev.actor_id, op.id);

  // A stale claim written behind the service's back still grants nothing.
  app.ctx.db.prepare('UPDATE work_items SET claimed_by = ? WHERE id = ?').run(leaver.id, id);
  const token = (await app.login('leaver')).body.token;
  assert.equal((await get(token, `/api/work/items/${id}`)).status, 403, 'a leftover claim is not a way back in');
  assert.equal((await get(token, `/api/work/items/${own.body.id}`)).status, 403, 'nor is having typed the case in');
  assert.equal((await post(token, `/api/work/items/${id}/entries`, { kind: 'note', text: 'still here?' })).status, 403);
  const list = (await get(token, '/api/work/items')).body;
  assert.ok(!list.items.some((i: any) => i.id === id || i.id === own.body.id), 'the queue does not list them');
  const assigned = (await get(token, '/api/record/assigned')).body;
  assert.ok(!assigned.some((a: any) => a.id === id), 'nor does the assigned list');
  const history = (await get(token, '/api/record/contributions')).body.find((h: any) => h.item.id === id);
  assert.ok(history, 'the contribution stays in their own history');
  assert.equal(history.item.open, false);
  app.ctx.db.prepare('UPDATE work_items SET claimed_by = NULL WHERE id = ?').run(id);
});
