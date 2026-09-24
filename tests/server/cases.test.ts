import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { parseMoney, formatCents, sumCents } from '../../shared/money.ts';
import { UMT_2WAY, progress } from '../../shared/procedures.ts';

/**
 * The case model: an append-only history per work item, the 2-Way UMT reference procedure, and the
 * financial distinctions that must not collapse (drafted/submitted/approved/posted, funds checked
 * vs. obligated, procedure followed vs. condition verified).
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let avery: { token: string; id: string };
let chen: { token: string; id: string };
let outsider: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  avery = await app.register('avery');
  chen = await app.register('chen');
  await enroll(app, op.token, 'G8', avery.id);
  await enroll(app, op.token, 'G8', chen.id);
  avery = { ...avery, token: (await app.login('avery')).body.token };
  chen = { ...chen, token: (await app.login('chen')).body.token };
  outsider = await app.register('outsider');
});
after(async () => { await app.close(); });

const post = (token: string, path: string, body: unknown = {}, headers: Record<string, string> = {}) => app.call('POST', path, { token, body, headers });
const detail = async (token: string, id: string) => (await app.call('GET', `/api/work/items/${id}`, { token })).body;

async function umtCase(reference = `SYN-26-P-${Math.floor(Math.random() * 9000 + 1000)}`) {
  const made = await post(op.token, '/api/work/items', { unit_id: 'G8', title: '2-Way UMT: PO open qty below DCAS qty', reference });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const applied = await post(op.token, `/api/work/items/${made.body.id}/procedure`, { key: UMT_2WAY.key });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  return made.body.id as string;
}

const entry = (token: string, id: string, body: Record<string, unknown>, key?: string) =>
  post(token, `/api/work/items/${id}/entries`, body, key ? { 'idempotency-key': key } : {});

async function researchReferenceValues(token: string, id: string) {
  for (const body of [
    { kind: 'observation', field: 'umt_amount', amount: '$4,300.00', system: 'DAI', step: 'identify' },
    { kind: 'observation', field: 'current_award', amount: '91,250', system: 'DAI', step: 'research_award' },
    { kind: 'observation', field: 'invoice_amount', amount: '45000.00', system: 'DAI', reference: 'INV-A', step: 'research_award' },
    { kind: 'observation', field: 'invoice_amount', amount: 44725, system: 'DAI', reference: 'INV-B', step: 'research_award' },
  ]) {
    const r = await entry(token, id, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
}

// Money --------------------------------------------------------------------------------------

test('money is parsed to exact cents from text, never through a float', () => {
  assert.deepEqual(parseMoney('$91,250.00'), { ok: true, cents: 9_125_000 });
  assert.deepEqual(parseMoney('0.1'), { ok: true, cents: 10 });
  assert.deepEqual(parseMoney(1118.38), { ok: true, cents: 111_838 });
  assert.deepEqual(parseMoney('(1,000.00)'), { ok: true, cents: -100_000 });
  assert.deepEqual(parseMoney('-0.00'), { ok: true, cents: 0 });
  assert.equal(parseMoney('12.345').ok, false, 'a third decimal place is refused, not rounded');
  assert.equal(parseMoney('1e5').ok, false);
  assert.equal(parseMoney('abc').ok, false);
  assert.equal(sumCents([10, 20]), 30);
  assert.throws(() => sumCents([0.5]));
  assert.equal(formatCents(277_500, { signed: true }), '+$2,775.00');
  assert.equal(formatCents(-100), '−$1.00');
});

// History and claiming -----------------------------------------------------------------------

test('claiming puts the work on the Marine’s list at once and records who claimed it, but credits nothing', async () => {
  const id = await umtCase();
  const claimed = await post(avery.token, `/api/work/items/${id}/claim`, {});
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.equal(claimed.body.stage, 'researching');
  const d = await detail(avery.token, id);
  const kinds = d.case.events.map((e: any) => e.kind);
  assert.ok(kinds.includes('claimed'));
  assert.equal(d.case.events.find((e: any) => e.kind === 'claimed').actor_id, avery.id);
  assert.equal(d.case.contributors.length, 0, 'a claim alone is not a contribution');
});

test('the candidate calculation reproduces the reference arithmetic in exact cents, citing every input', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  await researchReferenceValues(avery.token, id);
  const calc = await post(avery.token, `/api/work/items/${id}/calculate`);
  assert.equal(calc.status, 201, JSON.stringify(calc.body));
  const body = JSON.parse(calc.body.body);
  assert.equal(body.invoice_total_cents, 8_972_500, 'invoices $45,000.00 + $44,725.00');
  assert.equal(body.target_award_cents, 9_402_500, 'target = invoices + UMT');
  assert.equal(body.adjustment_cents, 277_500, 'adjustment = target − current award');
  assert.equal(body.direction, 'upward');
  assert.equal(body.requires_review, false);
  assert.match(body.applicability, /Candidate only/);
  assert.equal(body.inputs.length, 4);
  const d = await detail(avery.token, id);
  const observationIds = new Set(d.case.events.filter((e: any) => e.kind === 'observation').map((e: any) => e.id));
  for (const input of body.inputs) assert.ok(observationIds.has(input.event_id), 'every input names the observation it came from');
  assert.ok(body.inputs.every((i: any) => i.source === 'manual_observation'), 'values read off DAI are labelled manual observations');
});

test('a calculation with missing inputs is refused and names what is missing', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  const calc = await post(avery.token, `/api/work/items/${id}/calculate`);
  assert.equal(calc.status, 400);
  assert.ok(calc.body.missing.includes('current award amount'));
});

test('a downward or zero result is only a candidate direction and always needs review', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  await entry(avery.token, id, { kind: 'observation', field: 'umt_amount', amount: '100' });
  await entry(avery.token, id, { kind: 'observation', field: 'current_award', amount: '1000' });
  await entry(avery.token, id, { kind: 'observation', field: 'invoice_amount', amount: '800' });
  const calc = await post(avery.token, `/api/work/items/${id}/calculate`);
  const body = JSON.parse(calc.body.body);
  assert.equal(body.adjustment_cents, -10_000);
  assert.equal(body.direction, 'downward');
  assert.equal(body.requires_review, true);
});

test('a correction supersedes an entry without erasing it, and calculations use the corrected value', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  await researchReferenceValues(avery.token, id);
  let d = await detail(avery.token, id);
  const wrong = d.case.events.find((e: any) => e.kind === 'observation' && e.body.field === 'current_award');
  const fix = await entry(avery.token, id, { kind: 'observation', field: 'current_award', amount: '91,000.00', supersedes: wrong.id });
  assert.equal(fix.status, 201, JSON.stringify(fix.body));
  const again = await entry(avery.token, id, { kind: 'observation', field: 'current_award', amount: '1', supersedes: wrong.id });
  assert.equal(again.status, 409, 'an entry is corrected once; later corrections chain from the newer entry');
  const calc = JSON.parse((await post(avery.token, `/api/work/items/${id}/calculate`)).body.body);
  assert.equal(calc.current_award_cents, 9_100_000);
  d = await detail(avery.token, id);
  const original = d.case.events.find((e: any) => e.id === wrong.id);
  assert.ok(original, 'the original entry is still in the history');
  assert.equal(original.superseded, true);
});

test('the history is append-only at the database', async () => {
  const id = await umtCase();
  const { db } = app.ctx;
  const one = db.prepare('SELECT id FROM work_events WHERE work_item_id = ? LIMIT 1').get(id) as { id: string };
  assert.throws(() => db.prepare("UPDATE work_events SET kind = 'note' WHERE id = ?").run(one.id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM work_events WHERE id = ?').run(one.id), /append-only/);
});

// Controls and distinctions ------------------------------------------------------------------

test('a failed, missing, or inconclusive funds check stops submission; a warning needs a stated reason', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  const submit = (extra: Record<string, unknown> = {}) => entry(avery.token, id, { kind: 'action_submitted', step: 'submit_modification', reference: 'P00001', ...extra });

  let r = await submit();
  assert.equal(r.status, 409); assert.equal(r.body.code, 'control_not_passed', 'no funds check at all');
  for (const result of ['FAILED', 'NOT_RUN', 'UNKNOWN']) {
    await entry(avery.token, id, { kind: 'funds_check', result, system: 'DAI' });
    r = await submit();
    assert.equal(r.status, 409, `${result} blocks submission`);
    assert.equal(r.body.code, 'control_not_passed');
  }
  await entry(avery.token, id, { kind: 'funds_check', result: 'WARNING', system: 'DAI' });
  r = await submit();
  assert.equal(r.status, 409); assert.equal(r.body.code, 'control_warning');
  r = await submit({ control_acknowledgement: 'Warning concerned a closed line; confirmed with the budget officer.' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const body = JSON.parse(r.body.event.body);
  assert.equal(body.funds_check_result, 'WARNING', 'the submission records which check it relied on');
});

test('approved is not posted, and following the steps is not verifying the condition cleared', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  await entry(avery.token, id, { kind: 'funds_check', result: 'PASSED', system: 'DAI' });
  await entry(avery.token, id, { kind: 'action_submitted', step: 'submit_modification', reference: 'P00001', then_wait: 'approval' });
  let d = await detail(avery.token, id);
  assert.equal(d.case.stage, 'waiting');
  assert.equal(d.case.waiting.category, 'approval');
  await entry(avery.token, id, { kind: 'external_event', step: 'submit_modification', event: 'approved', system: 'DAI' });
  d = await detail(avery.token, id);
  const posted = d.case.progress.steps.find((s: any) => s.key === 'modification_posted');
  assert.notEqual(posted.status, 'done', 'approval alone does not complete the posting step');
  assert.match(posted.note, /Approved, not yet posted/);

  const verifyNoRef = await entry(avery.token, id, { kind: 'verification', check: 'condition_cleared', result: 'verified' });
  assert.equal(verifyNoRef.status, 400, 'a verified result needs a reference');

  const early = await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'resolved' });
  assert.equal(early.status, 409); assert.equal(early.body.code, 'verification_required');

  const viaAction = await post(avery.token, `/api/work/items/${id}/actions`, { kind: 'resolved', note: 'done' });
  assert.equal(viaAction.status, 409, 'the older action path cannot skip the verification either');
  const viaPatch = await app.call('PATCH', `/api/work/items/${id}`, { token: avery.token, body: { state: 'resolved' } });
  assert.equal(viaPatch.status, 409, 'nor can setting the state directly');
  assert.equal(viaPatch.body.code, 'verification_required');

  await entry(avery.token, id, { kind: 'verification', check: 'condition_cleared', result: 'verified', reference: 'UMT report 2026-09-20, line cleared' });
  const resolved = await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'resolved', reason: 'Verified cleared.' });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.state, 'resolved');
  d = await detail(avery.token, id);
  const kinds = d.case.events.map((e: any) => e.kind);
  assert.ok(kinds.includes('waiting_ended'), 'leaving the wait closes the interval');
  assert.ok(kinds.includes('resolved'));
});

test('a decision needs a reason and one of the procedure’s choices; amendment steps drop out when not needed', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  assert.equal((await entry(avery.token, id, { kind: 'decision', decision: 'funding_decision', choice: 'amend_requisition' })).status, 400, 'rationale required');
  assert.equal((await entry(avery.token, id, { kind: 'decision', decision: 'funding_decision', choice: 'guess', rationale: 'x' })).status, 400);
  assert.equal((await entry(avery.token, id, { kind: 'decision', decision: 'funding_decision', choice: 'funding_sufficient', rationale: 'Requisition shows $5,000 available.' })).status, 201);
  const d = await detail(avery.token, id);
  const amend = d.case.progress.steps.find((s: any) => s.key === 'amend_requisition');
  assert.equal(amend.status, 'skipped');
});

test('waiting needs a category, blocked needs a reason, and each maps to the queue state people already filter on', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  assert.equal((await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'waiting' })).status, 400);
  assert.equal((await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'blocked' })).status, 400);
  const waiting = await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'waiting', waiting_category: 'documentation' });
  assert.equal(waiting.body.state, 'waiting');
  assert.equal(waiting.body.waiting_category, 'documentation');
  const blocked = await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'blocked', reason: 'Vendor has not sent the invoice copy.' });
  assert.equal(blocked.body.stage, 'blocked');
  assert.equal(blocked.body.waiting_category, null);
  const d = await detail(avery.token, id);
  const ended = d.case.events.find((e: any) => e.kind === 'waiting_ended');
  assert.equal(ended.body.category, 'documentation');
  assert.equal(typeof ended.body.elapsed_hours, 'number');
});

// Handoff and attribution --------------------------------------------------------------------

test('a handoff keeps each person’s own contribution, and says who passed it, to whom, and why', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  await researchReferenceValues(avery.token, id);
  const handed = await post(avery.token, `/api/work/items/${id}/handoff`, { to_user_id: chen.id, note: 'Award and invoices recorded; funding decision next.' });
  assert.equal(handed.status, 200, JSON.stringify(handed.body));
  assert.equal(handed.body.claimed_by, chen.id);
  const blocked = await entry(avery.token, id, { kind: 'note', text: 'one more thing' });
  assert.equal(blocked.status, 403, 'after handing off, Avery is no longer working it');
  await entry(chen.token, id, { kind: 'decision', decision: 'funding_decision', choice: 'amend_requisition', rationale: 'Requisition short by $1,200.' });

  const d = await detail(chen.token, id);
  const by = Object.fromEntries(d.case.contributors.map((c: any) => [c.user_id, c]));
  assert.equal(by[avery.id].research, 4, 'Avery keeps the four observations');
  assert.equal(by[avery.id].handoffs, 1);
  assert.equal(by[chen.id].research, 1, 'Chen is credited only with the decision');
  const handoff = d.case.events.find((e: any) => e.kind === 'handed_off');
  assert.equal(handoff.actor_id, avery.id);
  assert.equal(handoff.subject_id, chen.id);
  assert.match(handoff.body.note, /funding decision next/);
});

test('work cannot be handed to someone who could not pick it up, nor by someone not holding it', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  const toOutsider = await post(avery.token, `/api/work/items/${id}/handoff`, { to_user_id: outsider.id, note: 'take it' });
  assert.equal(toOutsider.status, 400);
  const byChen = await post(chen.token, `/api/work/items/${id}/handoff`, { to_user_id: chen.id, note: 'mine now' });
  assert.equal(byChen.status, 403);
  const noNote = await post(avery.token, `/api/work/items/${id}/handoff`, { to_user_id: chen.id, note: '' });
  assert.equal(noNote.status, 400, 'a handoff says what the next person needs to know');
});

test('an outsider can neither open the case nor write to it, whatever id they send', async () => {
  const id = await umtCase();
  assert.equal((await app.call('GET', `/api/work/items/${id}`, { token: outsider.token })).status, 403);
  assert.equal((await entry(outsider.token, id, { kind: 'note', text: 'hi' })).status, 403);
  assert.equal((await post(outsider.token, `/api/work/items/${id}/stage`, { stage: 'waiting', waiting_category: 'approval' })).status, 403);
  assert.equal((await post(outsider.token, `/api/work/items/${id}/calculate`)).status, 403);
  const member = await entry(chen.token, id, { kind: 'note', text: 'not holding it' });
  assert.equal(member.status, 403, 'a unit member who has not picked the work up cannot write to it');
});

test('a retried entry with the same idempotency key is recorded once', async () => {
  const id = await umtCase();
  await post(avery.token, `/api/work/items/${id}/claim`, {});
  const a = await entry(avery.token, id, { kind: 'finding', text: 'Invoice B posted to the wrong line.' }, 'k-1');
  const b = await entry(avery.token, id, { kind: 'finding', text: 'Invoice B posted to the wrong line.' }, 'k-1');
  assert.equal(a.status, 201); assert.equal(b.status, 200);
  assert.equal(b.body.replayed, true);
  const d = await detail(avery.token, id);
  assert.equal(d.case.events.filter((e: any) => e.kind === 'finding').length, 1);
});

test('a stale version is refused with a conflict rather than overwriting somebody else’s change', async () => {
  const id = await umtCase();
  const claimed = await post(avery.token, `/api/work/items/${id}/claim`, {});
  await entry(avery.token, id, { kind: 'note', text: 'bumps the version' });
  const stale = await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'ready_for_action', version: claimed.body.version });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'version_conflict');
});

test('procedure progress is read from events and never infers a decision', () => {
  const p = progress(UMT_2WAY, [], { reference: 'SYN-1', stage: 'researching' });
  assert.equal(p.next, 'identify');
  assert.equal(p.steps.find((s) => s.key === 'identify')!.status, 'current', 'a reference alone does not supply the UMT amount');
  assert.equal(p.steps.find((s) => s.key === 'funding_decision')!.status, 'upcoming');
  assert.ok(UMT_2WAY.steps.every((s) => s.help.path === null), 'no system path is published until an SME confirms it');
  assert.equal(UMT_2WAY.authority, 'sme_walkthrough');
});

test('the same invoice recorded twice counts once; unreferenced invoices each count', async () => {
  const { candidateAdjustment } = await import('../../shared/procedures.ts');
  const e = (id: string, field: string, cents: number, at: string, reference?: string) => ({ id, kind: 'observation', actor_id: 'u', occurred_at: at, body: { field, amount_cents: cents, reference } });
  const result = candidateAdjustment([
    e('a', 'current_award', 9_125_000, '2026-09-01'),
    e('u', 'umt_amount', 430_000, '2026-09-01'),
    e('i1', 'invoice_amount', 4_500_000, '2026-09-02', 'INV-1'),
    e('i1b', 'invoice_amount', 4_500_000, '2026-09-05', 'inv-1'),
    e('i2', 'invoice_amount', 4_472_500, '2026-09-02', 'INV-2'),
  ]);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.invoice_total_cents, 8_972_500, 'INV-1 read twice is still one invoice');
    assert.ok(result.inputs.some((i) => i.event_id === 'i1b') && !result.inputs.some((i) => i.event_id === 'i1'), 'the later reading is the one used');
  }
  const unreferenced = candidateAdjustment([
    e('a', 'current_award', 100, '2026-09-01'), e('u', 'umt_amount', 10, '2026-09-01'),
    e('x', 'invoice_amount', 50, '2026-09-02'), e('y', 'invoice_amount', 50, '2026-09-02'),
  ]);
  assert.ok(unreferenced.ok && unreferenced.invoice_total_cents === 100, 'without a reference there is nothing to say they are the same invoice');
});
