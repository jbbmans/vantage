import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { UMT_2WAY } from '../../shared/procedures.ts';

/**
 * The Record keeps assigned work, contribution history and personal documentation apart, counts
 * distinct documents correctly, and keeps drafts and career plans private to their owner.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let avery: { token: string; id: string };
let chen: { token: string; id: string };
let nco: { token: string; id: string };
let ftl: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  avery = await app.register('avery');
  chen = await app.register('chen');
  nco = await app.register('nco');
  ftl = await app.register('ftl');
  await enroll(app, op.token, 'G8', avery.id);
  await enroll(app, op.token, 'G8', chen.id);
  await enroll(app, op.token, 'G8', nco.id, 'nco');
  await enroll(app, op.token, 'G8', ftl.id, 'fire-team-leader');
  for (const p of [avery, chen, nco, ftl]) p.token = (await app.login(p === avery ? 'avery' : p === chen ? 'chen' : p === nco ? 'nco' : 'ftl')).body.token;
});
after(async () => { await app.close(); });

const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const get = (token: string, path: string) => app.call('GET', path, { token });

async function item(reference: string) {
  const made = await post(op.token, '/api/work/items', { unit_id: 'G8', title: '2-Way UMT', reference });
  await post(op.token, `/api/work/items/${made.body.id}/procedure`, { key: UMT_2WAY.key });
  return made.body.id as string;
}

test('claiming shows up in assigned work immediately and earns no contribution credit', async () => {
  const id = await item('SYN-R-1');
  await post(avery.token, `/api/work/items/${id}/claim`);
  const assigned = await get(avery.token, '/api/record/assigned');
  assert.ok(assigned.body.some((a: any) => a.id === id), 'claimed work is on the assigned list');
  const mine = assigned.body.find((a: any) => a.id === id);
  assert.equal(mine.next_step.key, 'identify', 'the next step comes from the procedure');
  const summary = await get(avery.token, '/api/record/summary');
  assert.equal(summary.body.contributions.documents_researched, 0);
  assert.equal(summary.body.contributions.resolved_work, 0);
  assert.ok(summary.body.definitions.documents_researched);
});

test('one document is one document, however many entries and stage changes it has', async () => {
  const id = await item('SYN-R-2');
  await post(avery.token, `/api/work/items/${id}/claim`);
  for (const field of ['umt_amount', 'current_award', 'invoice_amount']) {
    await post(avery.token, `/api/work/items/${id}/entries`, { kind: 'observation', field, amount: '100' });
  }
  await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'ready_for_action' });
  await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'waiting', waiting_category: 'approval' });
  await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'researching' });
  const s = (await get(avery.token, '/api/record/summary')).body.contributions;
  assert.equal(s.documents_researched, 1);
  assert.equal(s.research_actions, 3);
  const history = (await get(avery.token, '/api/record/contributions')).body;
  const row = history.find((h: any) => h.item.id === id);
  assert.equal(row.research, 3);
  assert.equal(row.item.open, true);
});

test('after a handoff each person keeps their own count; the section counts the document once', async () => {
  const id = await item('SYN-R-3');
  await post(avery.token, `/api/work/items/${id}/claim`);
  await post(avery.token, `/api/work/items/${id}/entries`, { kind: 'finding', text: 'Invoice B is on the wrong line.' });
  await post(avery.token, `/api/work/items/${id}/handoff`, { to_user_id: chen.id, note: 'Finding recorded; needs the funding decision.' });
  await post(chen.token, `/api/work/items/${id}/entries`, { kind: 'decision', decision: 'funding_decision', choice: 'refer_for_review', rationale: 'Sufficiency rule unclear.' });

  const averyHistory = (await get(avery.token, '/api/record/contributions')).body.find((h: any) => h.item.id === id);
  assert.ok(averyHistory, 'Avery keeps the work in her history after handing it off');
  assert.equal((await get(avery.token, '/api/record/assigned')).body.some((a: any) => a.id === id), false, 'but no longer holds it');
  assert.equal((await get(chen.token, '/api/record/assigned')).body.some((a: any) => a.id === id), true);

  const workload = await get(ftl.token, '/api/work/workload?unit_id=G8');
  assert.equal(workload.status, 200, JSON.stringify(workload.body));
  const byId = Object.fromEntries(workload.body.members.map((m: any) => [m.id, m]));
  assert.ok(byId[avery.id].documents_researched >= 1);
  assert.ok(byId[chen.id].documents_researched >= 1);
  const sumOfPeople = workload.body.members.reduce((n: number, m: any) => n + m.documents_researched, 0);
  assert.ok(workload.body.section.documents_researched < sumOfPeople, 'a shared document is counted once for the section');
  assert.ok(workload.body.limitations.some((l: string) => /not evidence of zero work/.test(l)));
});

test('workload totals are open to the team, and name people only for those who may open member detail', async () => {
  // Teams are open to their members (PD-019): a Marine sees the section's totals, never who carries what.
  const marineView = await get(avery.token, '/api/work/workload?unit_id=G8');
  assert.equal(marineView.status, 200);
  assert.equal(marineView.body.members_visible, false);
  assert.deepEqual(marineView.body.members, [], 'a Marine does not see the per-person breakdown');
  assert.equal((await get(avery.token, '/api/work/workload?unit_id=NOPE')).status, 403, 'nor anything for a team they are not on');
  const ncoView = await get(nco.token, '/api/work/workload?unit_id=G8');
  assert.equal(ncoView.status, 200);
  assert.equal(ncoView.body.members_visible, false);
  assert.deepEqual(ncoView.body.members, []);
  const ftlView = await get(ftl.token, '/api/work/workload?unit_id=G8');
  assert.equal(ftlView.body.members_visible, true);
  const logged = app.ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'view_team_workload' AND actor_id = ?").get(ftl.id) as { n: number };
  assert.ok(logged.n >= 1, 'opening the per-person breakdown is logged');
  assert.equal((await get(ftl.token, '/api/work/workload?unit_id=NOPE')).status, 403);
});

test('a draft is built only from the person’s own facts, cites them, and is invisible to everyone else', async () => {
  const id = await item('SYN-R-4');
  await post(avery.token, `/api/work/items/${id}/claim`);
  await post(avery.token, `/api/work/items/${id}/entries`, { kind: 'observation', field: 'current_award', amount: '91250', system: 'DAI' });
  await post(avery.token, `/api/work/items/${id}/entries`, { kind: 'funds_check', result: 'PASSED', system: 'DAI' });
  await post(avery.token, `/api/work/items/${id}/entries`, { kind: 'action_submitted', step: 'submit_modification', reference: 'P00002' });
  await post(avery.token, `/api/work/items/${id}/entries`, { kind: 'verification', check: 'condition_cleared', result: 'verified', reference: 'UMT report line cleared' });

  assert.equal((await post(chen.token, '/api/record/drafts/from-work', { work_item_id: id })).status, 403, 'no facts of your own, no draft');
  const draft = await post(avery.token, '/api/record/drafts/from-work', { work_item_id: id });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.wording_source, 'template');
  assert.ok(draft.body.facts.length >= 3);
  const eventIds = new Set(app.ctx.db.prepare('SELECT id FROM work_events WHERE work_item_id = ? AND actor_id = ?').all(id, avery.id).map((r: any) => r.id));
  assert.ok(draft.body.facts.every((f: any) => eventIds.has(f.source.event_id)), 'every fact names one of her own events');
  assert.match(draft.body.wording, /SYN-R-4/);

  for (const who of [op, ftl, chen]) {
    assert.equal((await app.call('PUT', `/api/record/drafts/${draft.body.id}`, { token: who.token, body: { wording: 'mine now' } })).status, 404);
    assert.equal((await post(who.token, `/api/record/drafts/${draft.body.id}/save`)).status, 404);
    const theirs = (await get(who.token, '/api/record/drafts')).body;
    assert.ok(!theirs.some((d: any) => d.id === draft.body.id), 'drafts list only the caller’s own');
  }

  const edited = await app.call('PUT', `/api/record/drafts/${draft.body.id}`, { token: avery.token, body: { wording: 'Researched and cleared a 2-Way UMT.', version: draft.body.version } });
  assert.equal(edited.body.wording_source, 'person', 'edited wording is marked as the person’s own');
  const saved = await post(avery.token, `/api/record/drafts/${draft.body.id}/save`);
  assert.equal(saved.status, 201);
  const activity = app.ctx.db.prepare('SELECT visibility, user_id FROM activities WHERE id = ?').get(saved.body.activity_id) as { visibility: string; user_id: string };
  assert.equal(activity.visibility, 'private');
  assert.equal(activity.user_id, avery.id);
  assert.equal((await post(avery.token, `/api/record/drafts/${draft.body.id}/save`)).status, 409, 'saved once');
});

test('career steps and plans belong to their owner alone', async () => {
  const step = await post(avery.token, '/api/record/career/steps', { title: 'Complete Corporals Course DEP', category: 'pme', status: 'in_progress', source_label: 'MarineNet catalog', source_url: 'https://www.marinenet.usmc.mil' });
  assert.equal(step.status, 201, JSON.stringify(step.body));
  assert.equal(step.body.source_checked_on, null, 'an unchecked source is recorded as unverified');
  assert.equal((await post(avery.token, '/api/record/career/steps', { title: 'x', source_url: 'javascript:alert(1)' })).status, 400);
  await app.call('PUT', '/api/record/career/profile', { token: avery.token, body: { military_goal: 'Sergeant by 2028', civilian_interests: 'Financial analysis' } });

  for (const who of [op, ftl]) {
    assert.equal((await app.call('PUT', `/api/record/career/steps/${step.body.id}`, { token: who.token, body: { title: 'hijack' } })).status, 404);
    assert.equal((await app.call('DELETE', `/api/record/career/steps/${step.body.id}`, { token: who.token })).status, 404);
    const theirs = (await get(who.token, '/api/record/career')).body;
    assert.ok(!theirs.steps.some((s: any) => s.id === step.body.id));
    assert.notEqual(theirs.plan?.military_goal, 'Sergeant by 2028');
  }
  const mine = (await get(avery.token, '/api/record/career')).body;
  assert.equal(mine.plan.military_goal, 'Sergeant by 2028');
  assert.equal(mine.steps[0].title, 'Complete Corporals Course DEP');
});

test('the Record refuses a window that does not parse', async () => {
  assert.equal((await get(avery.token, '/api/record/summary?from=2026-09-30&to=2026-09-01')).status, 400);
  assert.equal((await get(avery.token, '/api/record/summary?from=yesterday')).status, 400);
});
