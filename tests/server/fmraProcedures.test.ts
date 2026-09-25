import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { PROCEDURES, PROCEDURE_VERSIONS, UMT_2WAY, UMT_2WAY_V010, progress, suggestProcedure, procedureFor } from '../../shared/procedures.ts';
import { caseIntegrity } from '../../server/services/caseSeal.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };
let avery: { token: string; id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  avery = await app.register('avery');
  await enroll(app, op.token, 'G8', avery.id);
  avery = { ...avery, token: (await app.login('avery')).body.token };
});
after(async () => { await app.close(); });

const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const detail = async (token: string, id: string) => (await app.call('GET', `/api/work/items/${id}`, { token })).body;
const entry = (token: string, id: string, body: Record<string, unknown>) => post(token, `/api/work/items/${id}/entries`, body);

async function caseUnder(key: string, title = 'Open balance', reference = `SYN-${Math.floor(Math.random() * 90000 + 10000)}`) {
  const made = await post(op.token, '/api/work/items', { unit_id: 'G8', title, reference });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const applied = await post(op.token, `/api/work/items/${made.body.id}/procedure`, { key });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.equal((await post(avery.token, `/api/work/items/${made.body.id}/claim`)).status, 200);
  return made.body.id as string;
}

const balances = async (id: string, figures: Record<string, string | null>, method?: string) => {
  if (method) assert.equal((await entry(avery.token, id, { kind: 'observation', field: 'purchase_method', value_text: method, step: 'observe_balances' })).status, 201);
  for (const [field, amount] of Object.entries(figures)) {
    const r = await entry(avery.token, id, amount == null ? { kind: 'observation', field, not_shown: true, step: 'observe_balances' } : { kind: 'observation', field, amount, step: 'observe_balances' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
};

test('every version stays published, and a pinned version is run exactly or not at all', () => {
  assert.equal(PROCEDURES.umt_2way_po_qty.version, '0.2.0');
  assert.ok(PROCEDURE_VERSIONS.umt_2way_po_qty['0.1.0'], 'the first version is still there');
  assert.equal(procedureFor('umt_2way_po_qty', '0.1.0'), UMT_2WAY_V010);
  assert.equal(procedureFor('umt_2way_po_qty', '9.9.9'), null, 'an unknown version is never silently swapped for another');
  assert.ok(!UMT_2WAY_V010.steps.some((s) => s.key === 'non1081_match'));
  assert.ok(UMT_2WAY.steps.some((s) => s.key === 'non1081_match'));
  for (const key of ['umt_four_stage', 'ocmt_research', 'udou_research', 'dou_research', 'oto_research', 'invoice_hold', 'feeder_reject', 'interface_error']) {
    const p = PROCEDURES[key];
    assert.ok(p, key);
    assert.equal(p.authority, 'training_reference', `${key} says where it comes from`);
    assert.ok(p.steps.every((s) => s.help.path === null), `${key} publishes no guessed screen path`);
    assert.ok(p.steps.some((s) => s.kind === 'verification' && s.check === 'condition_cleared') || p.resolvesOn?.length, `${key} resolves on a verification`);
  }
});

test('a case pinned to an older version runs it, and moving to the current one is an attributed migration', async () => {
  const made = await post(op.token, '/api/work/items', { unit_id: 'G8', title: '2-Way UMT', reference: 'SYN-PIN-1' });
  const id = made.body.id;
  // A case started before 0.2.0 existed.
  app.ctx.db.prepare("UPDATE work_items SET procedure_key = 'umt_2way_po_qty', procedure_version = '0.1.0' WHERE id = ?").run(id);
  let d = await detail(op.token, id);
  assert.equal(d.case.procedure.pinned_version, '0.1.0');
  assert.equal(d.case.procedure.newer_version, '0.2.0');
  assert.ok(!d.case.procedure.steps.some((s: any) => s.key === 'non1081_match'), 'it runs exactly the version it began under');

  const moved = await post(op.token, `/api/work/items/${id}/procedure`, { key: 'umt_2way_po_qty' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  d = await detail(op.token, id);
  assert.equal(d.case.procedure.pinned_version, '0.2.0');
  const applied = d.case.events.filter((e: any) => e.kind === 'procedure_applied').at(-1);
  assert.equal(applied.body.from_version, '0.1.0');
  assert.equal(applied.actor_id, op.id);
  assert.equal((await post(op.token, `/api/work/items/${id}/procedure`, { key: 'umt_2way_po_qty' })).status, 400, 'already current');
});

test('a case pinned to a version this build lacks refuses procedure writes but still refuses unverified resolution', async () => {
  const made = await post(op.token, '/api/work/items', { unit_id: 'G8', title: 'From the future', reference: 'SYN-FUT-1' });
  const id = made.body.id;
  app.ctx.db.prepare("UPDATE work_items SET procedure_key = 'umt_2way_po_qty', procedure_version = '7.0.0' WHERE id = ?").run(id);
  const d = await detail(op.token, id);
  assert.ok(d.case.procedure_unavailable);
  assert.equal((await entry(op.token, id, { kind: 'observation', field: 'umt_amount', amount: '5' })).status, 409);
  assert.equal((await entry(op.token, id, { kind: 'note', text: 'Reading only.' })).status, 201, 'a note needs no procedure rule');
  const r = await post(op.token, `/api/work/items/${id}/stage`, { stage: 'resolved' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'verification_required');
});

test('the older PATCH path cannot resolve procedure work without its verification', async () => {
  const id = await caseUnder('umt_2way_po_qty', '2-Way UMT', 'SYN-PATCH-1');
  const patched = await app.call('PATCH', `/api/work/items/${id}`, { token: op.token, body: { state: 'resolved' } });
  assert.equal(patched.status, 409, JSON.stringify(patched.body));
  assert.equal(patched.body.code, 'verification_required');
  const na = await app.call('PATCH', `/api/work/items/${id}`, { token: op.token, body: { state: 'not_applicable' } });
  assert.equal(na.status, 409, 'not applicable needs a reason, which PATCH cannot carry');
  assert.equal((await post(op.token, `/api/work/items/${id}/stage`, { stage: 'not_applicable' })).status, 400, 'the stage path asks for the reason');
  assert.equal((await post(op.token, `/api/work/items/${id}/stage`, { stage: 'not_applicable', reason: 'Duplicate of SYN-PATCH-2.' })).status, 200);
});

test('an open commitment: not-shown is its own fact, the residual is calculated, and conditional steps wait on the decision', async () => {
  const id = await caseUnder('ocmt_research');
  await balances(id, { commitment_amount: '100.00', obligation_amount: null, delivered_amount: null, paid_amount: null }, 'gpc');
  assert.equal((await entry(avery.token, id, { kind: 'observation', field: 'commitment_amount', not_shown: true, amount: '5' })).status, 400, 'an amount or not shown, not both');
  assert.equal((await entry(avery.token, id, { kind: 'observation', field: 'purchase_method', value_text: 'barter' })).status, 400, 'a method must be one the reference teaches');

  const calc = await post(avery.token, `/api/work/items/${id}/calculate`);
  assert.equal(calc.status, 201, JSON.stringify(calc.body));
  const body = JSON.parse(calc.body.body);
  assert.equal(body.formula, 'lifecycle_residual');
  assert.equal(body.findings[0].condition, 'ocmt');
  assert.equal(body.findings[0].residual_cents, 10_000);
  assert.equal(body.findings[0].pattern, 'full');
  assert.ok(body.inputs.some((i: any) => i.not_shown), 'a not-shown figure is cited as not shown');

  let d = await detail(avery.token, id);
  const statusOf = (key: string) => d.case.progress.steps.find((s: any) => s.key === key).status;
  assert.equal(statusOf('recoup_commitment'), 'conditional', 'a branch waits on its decision rather than posing as the next step');
  assert.equal(d.case.progress.next, 'research');

  await entry(avery.token, id, { kind: 'observation', field: 'ksd_request', value_text: 'Approved UPR in iProcurement', step: 'research' });
  assert.equal((await entry(avery.token, id, { kind: 'decision', decision: 'ocmt_cause', choice: 'requirement_invalid', rationale: 'CRO confirms the requirement was cancelled.' })).status, 201);
  d = await detail(avery.token, id);
  assert.equal(statusOf('amend_requisition'), 'skipped');
  assert.equal(d.case.progress.next, 'confirm_invalid');

  const early = await entry(avery.token, id, { kind: 'action_submitted', step: 'recoup_commitment', reference: 'REQ-AMD-1' });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'evidence_required', 'no recoup until invalidity is confirmed');
  const wrongBranch = await entry(avery.token, id, { kind: 'action_submitted', step: 'amend_requisition', reference: 'X' });
  assert.equal(wrongBranch.body.code, 'step_not_applicable');

  await entry(avery.token, id, { kind: 'verification', check: 'requirement_invalidity_confirmed', result: 'verified', reference: 'CRO email 2026-09-20' });
  const recoup = await entry(avery.token, id, { kind: 'action_submitted', step: 'recoup_commitment', reference: 'REQ-AMD-1' });
  assert.equal(recoup.status, 201, JSON.stringify(recoup.body));
  assert.ok(JSON.parse(recoup.body.event.body).relied_on.event_id, 'the submission names the verification it relied on');

  assert.equal((await post(avery.token, `/api/work/items/${id}/stage`, { stage: 'resolved' })).body.code, 'verification_required');
  await entry(avery.token, id, { kind: 'external_event', step: 'recoup_commitment', event: 'posted', system: 'DAI' });
  await entry(avery.token, id, { kind: 'verification', check: 'condition_cleared', result: 'verified', reference: 'OAS OCMT report 2026-09-24' });
  const done = await post(op.token, `/api/work/items/${id}/stage`, { stage: 'resolved', reason: 'Recouped and verified.' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
});

test('a valid open balance resolves on its validation, not on a clearing that will never come', async () => {
  const id = await caseUnder('udou_research');
  await balances(id, { commitment_amount: '100', obligation_amount: '100', delivered_amount: '50', paid_amount: '50' }, 'gcss');
  await entry(avery.token, id, { kind: 'decision', decision: 'udou_cause', choice: 'valid_back_order', rationale: 'GCSS-MC shows the remaining items on back-order, ETA 15 Oct.' });
  await entry(avery.token, id, { kind: 'verification', check: 'balance_validated', result: 'verified', reference: 'GCSS-MC back-order status 2026-09-24' });
  const d = await detail(avery.token, id);
  assert.equal(d.case.resolution.met.check, 'balance_validated');
  assert.equal((await post(op.token, `/api/work/items/${id}/stage`, { stage: 'resolved', reason: 'Valid back-order.' })).status, 200);
});

test('no receipt is recorded to clear a UDOU until delivery is evidenced', async () => {
  const id = await caseUnder('udou_research');
  await entry(avery.token, id, { kind: 'decision', decision: 'udou_cause', choice: 'missing_receipt', rationale: 'Warehouse says it arrived.' });
  const r = await entry(avery.token, id, { kind: 'action_submitted', step: 'record_receipt', reference: 'RCPT-1' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /merely to remove an open balance/);
});

test('a DOU cause cannot be chosen before the payment evidence is reviewed', async () => {
  const id = await caseUnder('dou_research');
  const early = await entry(avery.token, id, { kind: 'decision', decision: 'dou_cause', choice: 'payment_pending', rationale: 'Probably DFAS.' });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'evidence_required');
  await entry(avery.token, id, { kind: 'verification', check: 'payment_evidence_reviewed', result: 'verified', reference: 'Hold and UMT reports 2026-09-24: not listed' });
  assert.equal((await entry(avery.token, id, { kind: 'decision', decision: 'dou_cause', choice: 'payment_pending', rationale: 'Internal checks clean; payment scheduled.' })).status, 201);
});

test('a UMT billed above its PO line: shortfall calculated, award change gated on a validated bill, NON-1081 before clearing', async () => {
  const id = await caseUnder('umt_four_stage', 'UMT: Billed AMT is greater than PO line AMT');
  await entry(avery.token, id, { kind: 'observation', field: 'error_text', value_text: 'Billed AMT is greater than PO line AMT', step: 'identify' });
  await entry(avery.token, id, { kind: 'observation', field: 'umt_amount', amount: '1,120.00', step: 'identify' });
  await entry(avery.token, id, { kind: 'observation', field: 'po_line_amount', amount: '10,000.00', step: 'research' });
  await entry(avery.token, id, { kind: 'observation', field: 'billed_amount', amount: '11,120.00', step: 'research' });
  await entry(avery.token, id, { kind: 'decision', decision: 'umt_cause', choice: 'billed_exceeds_po_line', rationale: 'Invoice matches a valid price change.' });

  let d = await detail(avery.token, id);
  assert.equal(d.case.progress.steps.find((s: any) => s.key === 'submit_1081').status, 'skipped', 'the 1081 route is not this cause’s route');
  const calc = await post(avery.token, `/api/work/items/${id}/calculate`);
  assert.equal(calc.status, 201, JSON.stringify(calc.body));
  assert.equal(JSON.parse(calc.body.body).shortfall_cents, 112_000);

  assert.equal((await entry(avery.token, id, { kind: 'action_submitted', step: 'modify_award', reference: 'MOD-1' })).body.code, 'evidence_required');
  await entry(avery.token, id, { kind: 'verification', check: 'billed_amount_validated', result: 'verified', reference: 'Contract mod P00003 price' });
  assert.equal((await entry(avery.token, id, { kind: 'action_submitted', step: 'modify_award', reference: 'MOD-1' })).status, 201);
  await entry(avery.token, id, { kind: 'external_event', step: 'modify_award', event: 'posted', system: 'DAI' });
  d = await detail(avery.token, id);
  assert.equal(d.case.progress.next, 'non1081', 'fixing the cause is not done while the payment is unmatched');
});

test('a calculation goes stale when an input is corrected or a newer reading arrives, until it is run again', async () => {
  const id = await caseUnder('umt_2way_po_qty', '2-Way UMT', 'SYN-STALE-1');
  for (const body of [
    { kind: 'observation', field: 'umt_amount', amount: '4300', step: 'identify' },
    { kind: 'observation', field: 'current_award', amount: '91250', step: 'research_award' },
    { kind: 'observation', field: 'invoice_amount', amount: '45000', reference: 'INV-A', step: 'research_award' },
  ]) assert.equal((await entry(avery.token, id, body)).status, 201);
  await post(avery.token, `/api/work/items/${id}/calculate`);
  let d = await detail(avery.token, id);
  assert.equal(d.case.latest_calculation.stale, false);
  assert.equal(d.case.progress.steps.find((s: any) => s.key === 'calculate').status, 'done');

  const award = d.case.events.find((e: any) => e.kind === 'observation' && e.body.field === 'current_award');
  await entry(avery.token, id, { kind: 'observation', field: 'current_award', amount: '91000', supersedes: award.id });
  d = await detail(avery.token, id);
  assert.equal(d.case.latest_calculation.stale, true);
  assert.match(d.case.latest_calculation.reasons[0], /Current award was corrected/);
  assert.equal(d.case.progress.steps.find((s: any) => s.key === 'calculate').status, 'attention');

  await post(avery.token, `/api/work/items/${id}/calculate`);
  d = await detail(avery.token, id);
  assert.equal(d.case.latest_calculation.stale, false);
  assert.equal(d.case.calculations.length, 2, 'the earlier result stays in the history, marked stale');
  assert.equal(d.case.calculations[0].stale, true);
});

test('a case history is sealed, and a changed, removed or inserted entry breaks the seal', async () => {
  const id = await caseUnder('ocmt_research');
  await balances(id, { commitment_amount: '10', obligation_amount: null, delivered_amount: null, paid_amount: null });
  const d = await detail(avery.token, id);
  assert.equal(d.case.integrity.status, 'verified');
  const { db } = app.ctx;
  const target = db.prepare("SELECT id FROM work_events WHERE work_item_id = ? AND kind = 'observation' LIMIT 1").get(id) as { id: string };
  db.exec('DROP TRIGGER work_events_append_only_update');
  try {
    db.prepare(`UPDATE work_events SET body = json_set(body, '$.amount_cents', 999999) WHERE id = ?`).run(target.id);
    const broken = caseIntegrity(app.ctx, id);
    assert.equal(broken.status, 'broken');
    assert.match(broken.reason!, /changed after it was recorded/);
  } finally {
    db.exec(`CREATE TRIGGER work_events_append_only_update BEFORE UPDATE ON work_events BEGIN SELECT RAISE(ABORT, 'work_events is append-only; record a correction instead'); END;`);
  }
  const other = await caseUnder('ocmt_research');
  db.prepare(`INSERT INTO work_events (id, work_item_id, unit_id, actor_id, kind, body, occurred_at, created_at) VALUES ('forged-1', ?, 'G8', ?, 'note', '{"text":"forged"}', ?, ?)`)
    .run(other, avery.id, new Date().toISOString(), new Date().toISOString());
  assert.equal(caseIntegrity(app.ctx, other).status, 'broken', 'an entry written around Vantage is not in the chain');
  const audit = await app.call('GET', '/api/admin/integrity', { token: op.token });
  assert.equal(audit.status, 200, JSON.stringify(audit.body));
  assert.equal(audit.body.cases.ok, false);
  assert.ok(audit.body.cases.broken.length >= 2);
});

test('an import can apply procedures by condition, seed the figures, and a revised sheet supersedes only the source’s own values', async () => {
  const csv = [
    'Document,Condition,Method,Commitment,Obligation,Delivered,Paid,Due',
    'OB-1,Open commitment,GPC,100.00,-,-,-,2026-10-01',
    'OB-2,Undelivered order,GCSS-MC,100.00,100.00,50.00,50.00,2026-10-02',
    'OB-3,Travel order,TDY,-,100.00,-,-,2026-10-03',
    'OB-4,Payment with no home,,-,-,-,25.00,2026-10-04',
  ].join('\n');
  const upload = (text: string) => app.call('POST', '/api/work/sources', { token: op.token, raw: Buffer.from(text), headers: { 'content-type': 'text/csv', 'x-filename': 'balances.csv', 'x-unit-id': 'G8', 'x-visibility': 'unit' } });
  const plan = (sourceId: string) => ({
    source_file_id: sourceId, sheet_name: 'balances.csv', header_row: 1, key_columns: ['Document'], unit_id: 'G8', visibility: 'unit', procedure: 'auto',
    mapping: { Document: 'reference', Condition: 'title', Method: 'purchase_method', Commitment: 'commitment', Obligation: 'obligation', Delivered: 'delivered', Paid: 'paid', Due: 'due_date' },
  });
  const src = await upload(csv);
  assert.equal(src.status, 201, JSON.stringify(src.body));
  const preview = await post(op.token, '/api/work/imports/preview', plan(src.body.id));
  assert.deepEqual(preview.body.procedures, { ocmt_research: 1, udou_research: 1, oto_research: 1, umt_four_stage: 1 });
  const job = await post(op.token, '/api/work/imports', plan(src.body.id));
  assert.equal(job.status, 201, JSON.stringify(job.body));
  assert.equal(job.body.procedures_applied, 4);

  const list = (await app.call('GET', '/api/work/items?q=OB-', { token: op.token })).body.items;
  const byRef = Object.fromEntries(list.map((i: any) => [i.reference, i]));
  assert.equal(byRef['OB-3'].procedure_key, 'oto_research');
  let d = await detail(op.token, byRef['OB-2'].id);
  const seeded = d.case.events.filter((e: any) => e.kind === 'observation');
  assert.ok(seeded.every((e: any) => e.body.source === 'source_file' && e.actor_id === null), 'seeded values are the source’s, labelled so');
  assert.equal(seeded.find((e: any) => e.body.field === 'purchase_method').body.value_text, 'gcss');
  d = await detail(op.token, byRef['OB-1'].id);
  assert.equal(d.case.events.find((e: any) => e.body.field === 'obligation_amount').body.not_shown, true, 'a dash is recorded as not shown');

  const ob2 = byRef['OB-2'].id;
  await post(avery.token, `/api/work/items/${ob2}/claim`);
  await entry(avery.token, ob2, { kind: 'observation', field: 'ksd_receipt', value_text: 'DD 1348-1A for half the items', step: 'research' });
  await post(avery.token, `/api/work/items/${ob2}/calculate`);
  const src2 = await upload(csv.replace('100.00,100.00,50.00,50.00', '100.00,100.00,80.00,50.00'));
  const again = await post(op.token, '/api/work/imports', plan(src2.body.id));
  assert.equal(again.status, 201, JSON.stringify(again.body));
  d = await detail(avery.token, ob2);
  const revised = d.case.events.find((e: any) => e.kind === 'source_revised');
  assert.ok(revised, 'the source change is its own event in the history');
  assert.ok(revised.body.changes.some((c: any) => c.field === 'Delivered' && c.from === '50.00' && c.to === '80.00'));
  const delivered = d.case.events.filter((e: any) => e.kind === 'observation' && e.body.field === 'delivered_amount');
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0].superseded, true, 'the old sheet value is superseded, not erased');
  assert.equal(delivered[1].body.amount_cents, 8_000);
  assert.ok(d.case.events.some((e: any) => e.body.field === 'ksd_receipt' && !e.superseded), 'research a person recorded is untouched');
  assert.equal(d.case.latest_calculation.stale, true, 'the calculation built on the old figure is stale');
  assert.ok(d.item.source_changed_at, 'the holder is told the source changed');
});

test('a procedure is suggested from the work’s own words', async () => {
  assert.equal(suggestProcedure('2WAY PO MATCH PO open Qty 8 is less than the DCAS qty 9')?.key, 'umt_2way_po_qty');
  assert.equal(suggestProcedure('Data elements do not match')?.key, 'umt_four_stage');
  assert.equal(suggestProcedure('Invoices on Hold: quantity billed exceeds quantity received')?.key, 'invoice_hold');
  assert.equal(suggestProcedure('Outstanding travel order for TAD to Quantico')?.key, 'oto_research');
  assert.equal(suggestProcedure('Staff a birthday card'), null);
  const made = await post(op.token, '/api/work/items', { unit_id: 'G8', title: 'OCMT on a MIPR', reference: 'SYN-SUG-1' });
  const s = await app.call('GET', `/api/work/items/${made.body.id}/suggestion`, { token: op.token });
  assert.equal(s.body.key, 'ocmt_research');
});

test('procedure progress never infers a decision', () => {
  const p = progress(PROCEDURES.ocmt_research, [], { reference: 'X', stage: 'researching' });
  assert.equal(p.next, 'observe_balances');
  assert.ok(p.steps.filter((s) => s.status === 'conditional').length >= 6);
});

test('a procedure key is looked up as a name, never as a property of Object', async () => {
  for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(procedureFor(key), null, key);
    assert.equal(PROCEDURES[key], undefined, key);
    assert.equal(PROCEDURE_VERSIONS[key], undefined, key);
  }
  const made = await app.call('POST', '/api/work/items', { token: op.token, body: { unit_id: 'G8', title: 'Prototype probe' } });
  const applied = await app.call('POST', `/api/work/items/${made.body.id}/procedure`, { token: op.token, body: { key: 'constructor' } });
  assert.ok([400, 404].includes(applied.status), `applying "constructor" is refused (${applied.status})`);
  const detail = await app.call('GET', '/api/work/procedures/constructor', { token: op.token });
  assert.ok([400, 404].includes(detail.status), `and it is not described (${detail.status})`);
});

test('history sentences read naturally from imperative step titles', async () => {
  const { stepObject, actedOn } = await import('../../shared/procedures.ts');
  assert.equal(actedOn('submitted', 'Submit the modification'), 'submitted the modification');
  assert.equal(actedOn('prepared', 'Prepare the award modification'), 'prepared the award modification');
  assert.equal(actedOn('submitted', 'Match the payment to the award (NON-1081)'), 'submitted: match the payment to the award (NON-1081)');
  assert.equal(stepObject('Submit the modification'), 'the modification');
  assert.equal(stepObject('Amendment approved and effective'), 'Amendment approved and effective');
});
