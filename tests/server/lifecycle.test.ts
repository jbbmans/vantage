import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, today, PASSWORD, type TestApp } from './helpers.ts';
import { UMT_2WAY } from '../../shared/procedures.ts';
import { parseRoster, planSync, applySync } from '../../server/services/personnel.ts';
import { verifyAuditChain } from '../../server/services/audit.ts';
import { recommendFitrep } from '../../shared/evaluation.ts';

/**
 * One Marine through Vantage, cradle to grave, in the real application: the eight stages of
 * sim/mirofish/seed/vantage-lifecycle.md, in order. It is the ground truth the MiroFish simulation's findings are
 * checked against: a claim about the product that this contradicts is the simulation's error.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let nguyen: { token: string; id: string };
const EDIPI = '4100000001';
const OTHERS = ['4100000002', '4100000003', '4100000004', '4100000005', '4100000006'];
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const get = (token: string, path: string) => app.call('GET', path, { token });
const sync = (rows: string[]) => {
  const parsed = parseRoster(['EDIPI,Last,First,Grade,Status', ...rows].join('\n'));
  const plan = planSync(app.ctx, parsed.rows, 'MCTFS', parsed.rejected);
  applySync(app.ctx, plan, op.id);
  return plan;
};
const others = OTHERS.map((e, i) => `${e},Other${i},Pat,LCpl,Active`);
const sudo = async (token: string) => assert.equal((await post(token, '/api/auth/sudo', { password: PASSWORD })).status, 200);

async function umt(reference: string) {
  const made = await post(op.token, '/api/work/items', { unit_id: 'G8', title: '2-Way UMT', reference });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  app.ctx.db.prepare('UPDATE work_items SET amount = 1527.81 WHERE id = ?').run(made.body.id);
  await post(op.token, `/api/work/items/${made.body.id}/procedure`, { key: UMT_2WAY.key });
  return made.body.id as string;
}

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
});
after(async () => { await app.close(); });

test('1. arrival: a join code brings a Cpl into the section on JEPES, and the personnel feed takes over rank', async () => {
  const code = await post(op.token, '/api/org/units/G8/join-codes', {});
  assert.equal(code.status, 201, JSON.stringify(code.body));
  nguyen = await app.register('nguyen', { rank_id: 'Cpl', mos: '3451' });
  const joined = await post(nguyen.token, `/api/org/join-codes/${encodeURIComponent(code.body.code)}/join`);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.unit_id, 'G8');

  app.ctx.db.prepare('UPDATE users SET edipi = ? WHERE id = ?').run(EDIPI, nguyen.id);
  sync([`${EDIPI},Nguyen,Taylor,Cpl,Active`, ...others]);
  const me = (await get(nguyen.token, '/api/me/readiness')).body;
  assert.equal(me.rank_grade, 'E-4');
  assert.equal((await app.call('PATCH', '/api/me', { token: nguyen.token, body: { rank_id: 'Sgt' } })).status >= 400, true, 'rank is the feed’s, not self-editable');
});

test('2. daily work: claim a case, verify it, keep the draft; Quick Log the rest', async () => {
  const id = await umt('SYN-LC-1');
  assert.equal((await post(nguyen.token, `/api/work/items/${id}/claim`)).status, 200);
  await post(nguyen.token, `/api/work/items/${id}/entries`, { kind: 'verification', check: 'condition_cleared', result: 'verified', reference: 'UMT report 09-23' });
  assert.equal((await post(op.token, `/api/work/items/${id}/stage`, { stage: 'resolved', reason: 'Cleared on the report.' })).status, 200);
  const draft = await post(nguyen.token, '/api/record/drafts/from-work', { work_item_id: id });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const saved = await post(nguyen.token, `/api/record/drafts/${draft.body.id}/save`);
  assert.ok(saved.status === 200 || saved.status === 201, JSON.stringify(saved.body));

  const logged = await post(nguyen.token, '/api/records/activities', {
    title: 'Trained 3 Marines on DAI requisition amendments', quantity: 3, unit_label: 'Marines', eval_area: 'Leadership',
    result: 'All three now amend requisitions unaided.', date: today(), visibility: 'private',
  });
  assert.equal(logged.status, 201, JSON.stringify(logged.body));
});

test('3. leading: the section lead sees the work, counted with its definition, not the Marine’s private log', async () => {
  const workload = await get(op.token, '/api/work/workload?unit_id=G8');
  assert.equal(workload.status, 200, JSON.stringify(workload.body));
  const row = workload.body.members.find((m: { id: string }) => m.id === nguyen.id);
  assert.ok(row && row.verified_outcomes >= 1, JSON.stringify(row));
  assert.ok(workload.body.limitations.length > 0, 'every count comes with what it cannot show');
  assert.ok(!JSON.stringify(workload.body).includes('Trained 3 Marines'), 'a private entry is not on the leader’s page');
});

test('4. the Record and JEPES input: billet accomplishments in the order’s form, crediting the case work', async () => {
  const rep = await get(nguyen.token, '/api/reports?period=last12');
  assert.equal(rep.status, 200, JSON.stringify(rep.body).slice(0, 300));
  assert.equal(rep.body.track, 'jepes');
  assert.match(rep.body.narrative.text, /^Leadership$/m);
  assert.match(rep.body.narrative.text, /-Trained 3 Marines on Defense Agencies Initiative \(DAI\) requisition amendments/);
  // The Marine verified the outcome; the section lead resolved the case. Each is credited with what they did.
  assert.ok(rep.body.casework && rep.body.casework.verified >= 1, JSON.stringify(rep.body.casework));
  assert.equal(rep.body.worksheet, null);
});

test('5. promotion: the feed makes the Marine a Sgt, and the same entries become MRO worksheet input', async () => {
  sync([`${EDIPI},Nguyen,Taylor,Sgt,Active`, ...others]);
  const rep = await get(nguyen.token, '/api/reports?period=last12');
  assert.equal(rep.body.track, 'fitrep');
  assert.match(rep.body.narrative.text, /^-/, 'Section C is dash bullets with no headings');
  assert.doesNotMatch(rep.body.narrative.text, /^Leadership$/m);
  assert.ok(rep.body.narrative.sentences.some((s: { area: string; text: string }) => s.area === 'Leadership' && /Trained 3 Marines/.test(s.text)), 'a JEPES-tagged entry reads as its FITREP section');
  assert.ok(rep.body.worksheet && Array.isArray(rep.body.worksheet.pme));

  await app.call('PUT', '/api/me/readiness', { token: nguyen.token, body: { pme_complete: 'distance' } });
  const profile = (await get(nguyen.token, '/api/me/readiness')).body;
  assert.equal(profile.rank_grade, 'E-5');
  assert.ok(recommendFitrep(profile, { total: 2, withOutcome: 2 }).some((r) => r.id === 'pme-sgt'), 'a Sgt with distance PME hears what MARADMIN 630/24 adds');
});

test('6. transfer: leaving the section releases held work and ends access, and the Marine keeps their record', async () => {
  const id = await umt('SYN-LC-2');
  assert.equal((await post(nguyen.token, `/api/work/items/${id}/claim`)).status, 200);
  const removed = await app.call('DELETE', `/api/org/units/G8/members/${nguyen.id}`, { token: op.token });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.ok(removed.body.claimsReleased >= 1, JSON.stringify(removed.body));
  assert.equal((app.ctx.db.prepare('SELECT claimed_by FROM work_items WHERE id = ?').get(id) as { claimed_by: string | null }).claimed_by, null);
  // Leaving a unit ends the session, so no cached access outlives the membership; the Marine signs in again.
  assert.equal((await get(nguyen.token, '/api/me')).status, 401);
  nguyen.token = (await app.login('nguyen')).body.token;
  assert.equal((await get(nguyen.token, `/api/work/items/${id}`)).status, 403, 'the losing unit’s work is closed to them');
  const mine = (await get(nguyen.token, '/api/records/activities')).body;
  assert.ok((mine.items ?? mine).some((a: { title: string }) => /Trained 3 Marines/.test(a.title)), 'their own entries go with them');
  const history = (await get(nguyen.token, '/api/record/contributions')).body;
  assert.ok(history.length >= 1, 'their part in the cases stays attributed to them');
});

test('7. separation: the Marine takes their record, then the monthly extract turns the account off', async () => {
  await sudo(nguyen.token);
  const exported = await get(nguyen.token, '/api/me/export?format=json');
  assert.equal(exported.status, 200, JSON.stringify(exported.body).slice(0, 200));
  assert.ok(exported.body.records.activities.some((a: { title: string }) => /Trained 3 Marines/.test(a.title)));

  const plan = sync(others);
  assert.deepEqual(plan.separations.map((s) => s.edipi), [EDIPI]);
  assert.equal((app.ctx.db.prepare('SELECT active FROM users WHERE id = ?').get(nguyen.id) as { active: number }).active, 0);
  assert.notEqual((await app.login('nguyen')).status, 200, 'a separated account cannot sign in');
  const kept = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities WHERE user_id = ? AND deleted_at IS NULL').get(nguyen.id) as { n: number };
  assert.ok(kept.n >= 2, 'the record survives separation, for the Marine and for a records request');
});

test('8. the grave: nothing is disposed of by default, and the trail of all of it holds', async () => {
  await sudo(op.token);
  const retention = await get(op.token, '/api/admin/retention');
  assert.equal(retention.status, 200, JSON.stringify(retention.body).slice(0, 200));
  const run = await post(op.token, '/api/admin/retention/run', {});
  assert.equal(run.status, 200, JSON.stringify(run.body).slice(0, 300));
  const kept = app.ctx.db.prepare('SELECT COUNT(*) AS n FROM activities WHERE user_id = ? AND deleted_at IS NULL').get(nguyen.id) as { n: number };
  assert.ok(kept.n >= 2, 'a retention run with no schedule turned on disposes of nothing');

  const actions = (app.ctx.db.prepare('SELECT action FROM audit_log WHERE subject_id = ? OR entity_id IN (?, ?)').all(nguyen.id, nguyen.id, EDIPI) as Array<{ action: string }>).map((a) => a.action);
  for (const expected of ['personnel_separated', 'export_personal']) assert.ok(actions.includes(expected), `${expected} is in the audit trail: ${[...new Set(actions)].join(', ')}`);
  assert.equal(verifyAuditChain(app.ctx).ok, true, 'the audit chain verifies end to end');
});
