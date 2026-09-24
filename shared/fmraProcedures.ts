import type { Procedure, ProcedureField, ProcedureStep } from './procedureTypes.ts';
import { METHOD_LIST } from './fmra/methods.ts';
import { NORMAL_CONDITIONS, UMT_ERRORS, UMT_INSUFFICIENT_FUNDS, INVOICE_HOLDS, INTERFACE_ERRORS, FEEDER_REJECTS, type NormalKey } from './fmra/conditions.ts';

/**
 * The FMRA research-and-correction procedures, built from the FMRAC reference (ch. 8-11).
 *
 * Each one follows the book's research sequence — identify the condition, validate the
 * requirement and evidence, determine the cause, route the supported correction, verify the
 * posting, document the result — and encodes the book's "never without evidence" rules as controls
 * the server enforces: no receipt without evidence of delivery, no award change without a
 * validated bill, no recoup without confirmed invalidity.
 *
 * Authority is the training reference, labelled that way everywhere. No DAI screen path is
 * published: the book is not a screen-by-screen manual, and a guessed path looks authoritative.
 */

const FMRAC = 'FMRAC Financial Management Reference (rewritten study guide, 24 Sep 2026), derived from the 118-page FMRAC Combined Study Guide.';
const COMMON_LIMITS = [
  'A training reference, not current policy: thresholds, routing and timing are the book’s printed values.',
  'System screen paths are not documented; the book is not a DAI operating manual.',
  'Single document, single line. Multi-line and cross-fiscal-year cases need their own review.',
];

export const RESOLVES_CLEARED = { check: 'condition_cleared', label: 'The original condition no longer shows' };
export const RESOLVES_VALID = { check: 'balance_validated', label: 'The open balance was validated as legitimately open' };

const METHOD_OPTIONS = METHOD_LIST.map((m) => ({ key: m.key, label: m.short }));

const DOCUMENT: ProcedureField = { key: 'document_number', label: 'Document number' };
export const LIFECYCLE_FIELDS: ProcedureField[] = [
  { key: 'purchase_method', label: 'Purchase method', options: METHOD_OPTIONS, optional: true, hint: 'Decides which evidence proves each phase.' },
  { key: 'commitment_amount', label: 'Commitment', money: true, allowNotShown: true },
  { key: 'obligation_amount', label: 'Obligation', money: true, allowNotShown: true },
  { key: 'delivered_amount', label: 'Delivered', money: true, allowNotShown: true },
  { key: 'paid_amount', label: 'Paid', money: true, allowNotShown: true },
];

const KSD_FIELDS: ProcedureField[] = [
  { key: 'ksd_request', label: 'Request / order evidence examined', optional: true, hint: 'e.g. approved UPR, signed DD 448, DD 1610' },
  { key: 'ksd_receipt', label: 'Receipt / acceptance evidence examined', optional: true, hint: 'e.g. DD 250, DD 1348-1A, signed vendor receipt' },
  { key: 'ksd_payment', label: 'Payment evidence examined', optional: true, hint: 'e.g. SF 1034, paid DD 1351-2, certified US Bank statement' },
];

const REFER = { key: 'refer_for_review', label: 'Refer for review', hint: 'The evidence does not settle it. Say what is unknown.' };

const observeBalances = (source: string): ProcedureStep => ({
  key: 'observe_balances', title: 'Record the lifecycle figures', kind: 'research',
  fields: [DOCUMENT, ...LIFECYCLE_FIELDS],
  responsibility: ['p2p_inquiry'],
  help: {
    objective: 'Pin down what the report shows for this one document before interpreting it.',
    system: 'DAI / OAS', what: 'Record commitment, obligation, delivered and paid for the same document, line and scope. If the report shows a dash, record it as not shown — it is not a zero.',
    meaning: 'A report identifies a condition, not its cause.',
    done: 'All four figures are recorded, each as an amount or as not shown.', path: null, source,
  },
});

const residual = (source: string): ProcedureStep => ({
  key: 'calculate', title: 'Calculate the open residual', kind: 'calculation', formula: 'lifecycle_residual',
  help: {
    objective: 'See which phase is open and by how much, with every input cited.',
    what: 'Vantage subtracts phase from phase using the book’s editorial arithmetic and names the condition it shows.',
    meaning: 'The arithmetic narrows the question. It never diagnoses the cause.',
    done: 'A calculation citing its inputs is on the record, and nothing has changed since.', path: null, source,
  },
});

const researchEvidence = (what: string, source: string): ProcedureStep => ({
  key: 'research', title: 'Research the cause and its evidence', kind: 'research', fields: KSD_FIELDS,
  responsibility: ['p2p_inquiry'],
  help: {
    objective: 'Validate the requirement and the evidence before choosing a correction.',
    system: 'DAI', what,
    meaning: 'Evidence belongs to its event: an approved request proves authorization, not delivery or payment.',
    done: 'The evidence you examined, or a finding, is on the record.', path: null, source,
  },
});

const causeDecision = (key: string, condition: NormalKey, extra: Array<{ key: string; label: string; hint?: string }> = []): ProcedureStep => {
  const def = NORMAL_CONDITIONS[condition];
  return {
    key: 'cause', title: 'Decide the cause the evidence supports', kind: 'decision',
    decision: {
      key,
      choices: [
        ...def.causes.map((c) => ({ key: c.key, label: c.label, hint: `${c.pattern === 'full' ? 'Nothing yet in the next phase. ' : c.pattern === 'partial' ? 'Part of it moved on. ' : ''}${c.correction}` })),
        ...extra, REFER,
      ],
    },
    help: {
      objective: 'Choose the explanation the evidence supports, and say why, so a reviewer can follow it.',
      what: def.firstQuestion,
      meaning: 'A likely cause is not a proven fact. Choose the one your evidence shows.',
      done: 'A decision with its reason is recorded.', path: null, source: `FMRAC ${def.cite.chapter} · orig. pp. ${def.cite.pages}`,
    },
  };
};

const verifyStep = (key: string, check: string, title: string, what: string, source: string, onlyWhen?: ProcedureStep['onlyWhen']): ProcedureStep => ({
  key, title, kind: 'verification', check, onlyWhen, responsibility: ['p2p_inquiry'],
  help: { objective: title, system: 'DAI', what, done: 'A verified result with a reference is recorded.', path: null, source },
});

const action = (key: string, title: string, what: string, opts: Partial<ProcedureStep> & { source: string; meaning?: string }): ProcedureStep => ({
  key, title, kind: 'action', waitsOn: opts.waitsOn ?? 'approval', onlyWhen: opts.onlyWhen, requires: opts.requires, responsibility: opts.responsibility,
  help: { objective: title, system: opts.help?.system ?? 'DAI', what, meaning: opts.meaning ?? 'Submitted is not approved, and approved is not posted.', done: 'The submission and its reference are recorded.', path: null, source: opts.source },
});

const posted = (steps: string[], onlyWhen: ProcedureStep['onlyWhen'], source: string, completesOn: 'posted' | 'effective' = 'posted', title = 'Correction approved and posted'): ProcedureStep => ({
  key: 'correction_posted', title, kind: 'external', waitsOn: 'posting', observes: { steps, completesOn }, onlyWhen,
  help: {
    objective: 'Confirm the correction took effect in the system of record.',
    system: 'DAI', what: `Record approval when you see it, and ${completesOn} separately.`,
    meaning: 'A submitted correction is an action taken, not proof the residual cleared.',
    done: `The correction is observed ${completesOn}.`, path: null, source,
  },
});

const resolveStep = (what: string): ProcedureStep => ({
  key: 'resolve', title: 'Resolve', kind: 'resolution',
  help: { objective: 'Close the case on the evidence.', what, done: 'The case is resolved.', path: null },
});

/* ── Open / outstanding commitment ────────────────────────────────────────────────────────── */

const OCMT_SRC = 'FMRAC 9.2 · orig. pp. 103-104';
const OCMT_CORRECTIVE = ['mipr_not_acknowledged', 'requirement_invalid', 'interface_error', 'final_price_lower', 'award_incomplete'];

export const OCMT_RESEARCH: Procedure = {
  key: 'ocmt_research', version: '1.0.0', short: 'OCMT', family: 'normal_condition',
  title: 'Open commitment (OCMT): research and correct',
  trigger: 'A report shows a requisition amount not yet covered by an obligation.',
  objective: 'Establish whether the committed requirement is still valid, and either support the award or recoup the unsupported commitment — with the evidence on the record.',
  authority: 'training_reference', source: FMRAC, reviewed: null,
  limitations: [...COMMON_LIMITS, '"Valid, award still in process" is editorial: the book says normal conditions are commonly valid but lists no OCMT cause for it.'],
  references: ['FMRAC 8.2 · orig. pp. 100-102', OCMT_SRC],
  resolvesOn: [RESOLVES_CLEARED, RESOLVES_VALID],
  steps: [
    observeBalances('FMRAC 8.3 · orig. pp. 100-102'),
    residual('FMRAC 8.3 · orig. pp. 100-102'),
    researchEvidence('Check the request evidence. For a MIPR, look for the signed DD 448-2 and the acknowledgement status; for an interface, the failed transmission and its error.', OCMT_SRC),
    causeDecision('ocmt_cause', 'ocmt', [{ key: 'valid_pending', label: 'Valid — the award is legitimately still in process', hint: 'Retain the commitment and monitor. Editorial: an open balance may be valid while the next event is pending.' }]),
    action('process_acknowledgement', 'Record the MIPR acknowledgement and route the award', 'Record the acknowledgement of the signed DD 448-2 (P2P MIPR Acknowledgement), then have the award prepared and routed.', { onlyWhen: { decision: 'ocmt_cause', choices: ['mipr_not_acknowledged'] }, responsibility: ['p2p_mipr_ack', 'p2p_procurement_officer'], source: 'FMRAC 7.7, 9.2' }),
    verifyStep('confirm_invalid', 'requirement_invalidity_confirmed', 'Confirm the requirement is no longer valid', 'Confirm invalidity with the responsible personnel and records. Name who confirmed it and where.', OCMT_SRC, { decision: 'ocmt_cause', choices: ['requirement_invalid'] }),
    action('recoup_commitment', 'Recoup the funds held by the invalid requisition', 'Amend or cancel the requisition through the authorized correction.', { onlyWhen: { decision: 'ocmt_cause', choices: ['requirement_invalid'] }, requires: { check: 'requirement_invalidity_confirmed', message: 'Confirm the requirement is no longer valid before recouping its funds.' }, responsibility: ['iproc_requisitions'], source: OCMT_SRC }),
    action('correct_interface', 'Correct the interface condition', 'Find the failed transmission and its error, and correct the underlying condition.', { onlyWhen: { decision: 'ocmt_cause', choices: ['interface_error'] }, responsibility: ['p2p_inquiry'], waitsOn: 'posting', source: OCMT_SRC }),
    verifyStep('confirm_final_cost', 'final_cost_validated', 'Validate the final supported cost', 'Validate that the obligated amount is the final supported cost and that no requirement remains.', OCMT_SRC, { decision: 'ocmt_cause', choices: ['final_price_lower'] }),
    action('amend_requisition', 'Amend the requisition to the final price', 'Amend the requisition to the supported final price.', { onlyWhen: { decision: 'ocmt_cause', choices: ['final_price_lower'] }, requires: { check: 'final_cost_validated', message: 'Validate the final supported cost before amending the requisition.' }, responsibility: ['iproc_requisitions'], source: OCMT_SRC }),
    action('process_award', 'Process the supported award amount', 'Process the award for the full supported requirement rather than reducing the commitment.', { onlyWhen: { decision: 'ocmt_cause', choices: ['award_incomplete'] }, responsibility: ['p2p_procurement_analyst', 'p2p_procurement_officer'], source: OCMT_SRC }),
    posted(['process_acknowledgement', 'recoup_commitment', 'correct_interface', 'amend_requisition', 'process_award'], { decision: 'ocmt_cause', choices: OCMT_CORRECTIVE }, OCMT_SRC),
    verifyStep('verify_valid', 'balance_validated', 'Validate the open commitment', 'Confirm the requirement is still valid and the award is legitimately in process. Say what you saw and when you will look again.', 'FMRAC 8.1 · orig. pp. 99-102', { decision: 'ocmt_cause', choices: ['valid_pending'] }),
    verifyStep('verify_cleared', 'condition_cleared', 'Verify the residual cleared', 'Recheck the requisition and the award after posting. A submitted amendment or acknowledgement is not proof the residual cleared.', OCMT_SRC, { decision: 'ocmt_cause', choices: OCMT_CORRECTIVE }),
    resolveStep('Resolve once the residual is verified cleared, or the open commitment is validated as legitimately open.'),
  ],
};

/* ── Undelivered order, unpaid ────────────────────────────────────────────────────────────── */

const UDOU_SRC = 'FMRAC 9.3 · orig. pp. 104-105';
const UDOU_CORRECTIVE = ['missing_receipt', 'erroneous_award', 'final_price_lower'];

export const UDOU_RESEARCH: Procedure = {
  key: 'udou_research', version: '1.0.0', short: 'UDOU', family: 'normal_condition',
  title: 'Undelivered order, unpaid (UDOU): research and correct',
  trigger: 'A report shows an obligation not yet followed by the corresponding receipt and payment.',
  objective: 'Show which amount is still due, which was received, and which is no longer required — and correct only what the evidence supports.',
  authority: 'training_reference', source: FMRAC, reviewed: null,
  limitations: COMMON_LIMITS,
  references: ['FMRAC 8.2 · orig. pp. 100-102', UDOU_SRC],
  resolvesOn: [RESOLVES_CLEARED, RESOLVES_VALID],
  steps: [
    observeBalances('FMRAC 8.3 · orig. pp. 100-102'),
    residual('FMRAC 8.3 · orig. pp. 100-102'),
    researchEvidence('Check the award and the receipt evidence for this method (DD 250, DD 1348-1A, signed vendor receipt…). Establish what was actually received.', UDOU_SRC),
    causeDecision('udou_cause', 'udou'),
    verifyStep('confirm_delivery', 'delivery_evidenced', 'Establish that delivery actually occurred', 'Look at the receiving evidence and record which quantity or amount was actually received, and where you saw it.', UDOU_SRC, { decision: 'udou_cause', choices: ['missing_receipt'] }),
    action('record_receipt', 'Record the supported receipt', 'Record or correct the delivered entry for the actually received portion through the proper source process (P2P Receipts, or the feeder).', { onlyWhen: { decision: 'udou_cause', choices: ['missing_receipt'] }, requires: { check: 'delivery_evidenced', message: 'Do not create a receipt merely to remove an open balance. Establish that delivery actually occurred first.' }, responsibility: ['p2p_receipts'], waitsOn: 'posting', source: UDOU_SRC }),
    verifyStep('confirm_invalid', 'requirement_invalidity_confirmed', 'Confirm the requirement is genuinely invalid', 'Confirm with the responsible personnel and records that the award is unsupported.', UDOU_SRC, { decision: 'udou_cause', choices: ['erroneous_award'] }),
    action('recoup_award', 'Modify the award and requisition to recoup', 'Modify or amend the award and the requisition through the authorized process to recoup the unsupported funds.', { onlyWhen: { decision: 'udou_cause', choices: ['erroneous_award'] }, requires: { check: 'requirement_invalidity_confirmed', message: 'Confirm the requirement is genuinely invalid before recouping the award.' }, responsibility: ['p2p_procurement_analyst', 'iproc_requisitions'], source: UDOU_SRC }),
    verifyStep('confirm_final_cost', 'final_cost_validated', 'Validate the final cost', 'Validate the final supported cost against the award.', UDOU_SRC, { decision: 'udou_cause', choices: ['final_price_lower'] }),
    action('adjust_award', 'Adjust the award and requisition to the final cost', 'Adjust the award and requisition to the validated final cost.', { onlyWhen: { decision: 'udou_cause', choices: ['final_price_lower'] }, requires: { check: 'final_cost_validated', message: 'Validate the final cost before adjusting the award.' }, responsibility: ['p2p_procurement_analyst', 'iproc_requisitions'], source: UDOU_SRC }),
    posted(['record_receipt', 'recoup_award', 'adjust_award'], { decision: 'udou_cause', choices: UDOU_CORRECTIVE }, UDOU_SRC),
    verifyStep('verify_valid', 'balance_validated', 'Validate the back-order', 'Verify the items (or the remaining portion) are still on back-order. Retain the obligation and record the expected delivery.', UDOU_SRC, { decision: 'udou_cause', choices: ['valid_back_order'] }),
    verifyStep('verify_cleared', 'condition_cleared', 'Verify the residual cleared', 'Recheck the award and the receipt after posting, and show which amount is still due, received, or no longer required.', UDOU_SRC, { decision: 'udou_cause', choices: UDOU_CORRECTIVE }),
    resolveStep('Resolve once the residual is verified cleared, or the back-order is validated.'),
  ],
};

/* ── Delivered order, unpaid ──────────────────────────────────────────────────────────────── */

const DOU_SRC = 'FMRAC 9.4 · orig. pp. 105-106';
const DOU_CORRECTIVE = ['hold_or_umt', 'erroneous_receipt', 'excess_receipt'];

export const DOU_RESEARCH: Procedure = {
  key: 'dou_research', version: '1.0.0', short: 'DOU', family: 'normal_condition',
  title: 'Delivered order, unpaid (DOU): research and correct',
  trigger: 'A report shows a delivered amount without the corresponding posted disbursement.',
  objective: 'Tell an unpaid invoice from a payment that happened but did not match, then correct the underlying condition.',
  authority: 'training_reference', source: FMRAC, reviewed: null,
  limitations: [...COMMON_LIMITS, 'DFAS delay is treated as a last-resort explanation, after internal status, evidence, matching and interfaces.'],
  references: ['FMRAC 8.2 · orig. pp. 100-102', DOU_SRC],
  resolvesOn: [RESOLVES_CLEARED, RESOLVES_VALID],
  steps: [
    observeBalances('FMRAC 8.3 · orig. pp. 100-102'),
    residual('FMRAC 8.3 · orig. pp. 100-102'),
    verifyStep('check_payment', 'payment_evidence_reviewed', 'Review the payment evidence first', 'Review the disbursement evidence, the Invoices on Hold report and the Unmatched Transactions report for this document. Record what each showed.', DOU_SRC),
    { ...causeDecision('dou_cause', 'dou'), requires: { check: 'payment_evidence_reviewed', message: 'A DOU amount alone cannot tell an unpaid invoice from an unmatched payment. Review the payment evidence before choosing the cause.' } },
    action('correct_hold', 'Correct the hold or unmatched condition', 'Correct the underlying hold or unmatched condition. An unmatched payment is worked under the UMT procedure; a hold under the invoice-hold procedure.', { onlyWhen: { decision: 'dou_cause', choices: ['hold_or_umt'] }, responsibility: ['p2p_unmatched_tbo'], waitsOn: 'posting', source: DOU_SRC }),
    verifyStep('confirm_delivery', 'delivery_validated', 'Validate what was actually delivered', 'Validate the actual delivery — all of it, or which part — against the receiving evidence.', DOU_SRC, { decision: 'dou_cause', choices: ['erroneous_receipt', 'excess_receipt'] }),
    action('correct_receipt', 'Return or correct the unsupported receipt', 'Return the receipt posted in error, or correct the unsupported part of it.', { onlyWhen: { decision: 'dou_cause', choices: ['erroneous_receipt', 'excess_receipt'] }, requires: { check: 'delivery_validated', message: 'Validate the actual delivery before correcting the receipt.' }, responsibility: ['p2p_receipts'], waitsOn: 'posting', source: DOU_SRC }),
    posted(['correct_hold', 'correct_receipt'], { decision: 'dou_cause', choices: DOU_CORRECTIVE }, DOU_SRC),
    verifyStep('verify_valid', 'balance_validated', 'Validate that payment is legitimately pending', 'Confirm internal status, evidence, matching and interfaces are all in order and payment is simply pending. Record when you will look again.', DOU_SRC, { decision: 'dou_cause', choices: ['payment_pending'] }),
    verifyStep('verify_cleared', 'condition_cleared', 'Verify the residual cleared', 'Confirm the payment posted and matched the intended record.', DOU_SRC, { decision: 'dou_cause', choices: DOU_CORRECTIVE }),
    resolveStep('Resolve once the payment is verified posted and matched, or the pending payment is validated.'),
  ],
};

/* ── Outstanding travel order ─────────────────────────────────────────────────────────────── */

const OTO_SRC = 'FMRAC 9.5 · orig. pp. 106-107';

export const OTO_RESEARCH: Procedure = {
  key: 'oto_research', version: '1.0.0', short: 'OTO', family: 'normal_condition',
  title: 'Outstanding travel order (OTO): research and correct',
  trigger: 'A report shows a DTS obligation without full posted disbursement.',
  objective: 'Establish whether travel occurred and where the voucher stands, then drive the right correction through to payment.',
  authority: 'training_reference', source: FMRAC, reviewed: null,
  limitations: [...COMMON_LIMITS, 'Local DTS routing may vary; follow the established local route.', 'The book’s OTO examples show no commitment amount; a blank commitment is not an error.'],
  references: ['FMRAC 8.2 · orig. pp. 100-102', OTO_SRC, 'FMRAC 7.6 · orig. pp. 84-86'],
  steps: [
    observeBalances('FMRAC 8.3 · orig. pp. 100-102'),
    residual('FMRAC 8.3 · orig. pp. 100-102'),
    {
      key: 'confirm_travel', title: 'Confirm the travel and the voucher', kind: 'research',
      fields: [
        { key: 'travel_occurred', label: 'Did travel occur?', options: [{ key: 'yes', label: 'Yes' }, { key: 'no', label: 'No' }, { key: 'unknown', label: 'Not yet known' }] },
        { key: 'voucher_status', label: 'Voucher status in DTS', optional: true, hint: 'Not submitted, returned, approved, paid…' },
      ],
      responsibility: ['p2p_inquiry'],
      help: { objective: 'Ask whether travel happened and where the voucher is.', system: 'DTS', what: 'Ask the traveler whether travel occurred, and record the DTS voucher status.', meaning: 'An approved authorization is not a submitted voucher; a completed trip is not a paid voucher.', done: 'Travel status is recorded.', path: null, source: OTO_SRC },
    },
    causeDecision('oto_cause', 'oto'),
    action('cancel_or_adjust', 'Establish the cancellation or adjustment', 'Establish the correct cancellation or adjustment path rather than assuming reimbursement is due.', { onlyWhen: { decision: 'oto_cause', choices: ['travel_did_not_occur'] }, responsibility: ['p2p_dts_axol'], source: OTO_SRC }),
    action('notify_traveler', 'Notify the traveler of the required action', 'Tell the traveler exactly what the voucher needs. Waiting on the traveler is its own waiting state.', { onlyWhen: { decision: 'oto_cause', choices: ['voucher_not_submitted', 'voucher_incorrect'] }, responsibility: ['p2p_inquiry'], waitsOn: 'external_response', source: OTO_SRC, meaning: 'Waiting on the traveler is not waiting on an approver or an interface.' }),
    action('resolve_bfs', 'Resolve the BFS condition', 'Find the BFS error preventing the transaction from posting and resolve it through the responsible process.', { onlyWhen: { decision: 'oto_cause', choices: ['bfs_interface_failure'] }, responsibility: ['p2p_inquiry', 'p2p_dts_axol'], waitsOn: 'posting', source: OTO_SRC }),
    posted(['cancel_or_adjust', 'notify_traveler', 'resolve_bfs'], { decision: 'oto_cause', choices: ['travel_did_not_occur', 'voucher_not_submitted', 'voucher_incorrect', 'bfs_interface_failure'] }, OTO_SRC, 'posted', 'Voucher or adjustment processed and posted'),
    verifyStep('verify_cleared', 'condition_cleared', 'Verify the travel order cleared', 'Follow the voucher through routing, approval, DTS status, the DAI adjustment and posting, and payment. Record the paid status.', OTO_SRC),
    resolveStep('Resolve once payment is verified posted against the travel order.'),
  ],
};

/* ── Unmatched transaction: the four-stage method ─────────────────────────────────────────── */

const UMT_SRC = 'FMRAC 11.2 · orig. pp. 115-117';
const NON1081 = ['no_matching_record', 'billed_exceeds_po_line', 'qty_not_received', 'award_not_approved', 'insufficient_project_funds'];

export const UMT_FOUR_STAGE: Procedure = {
  key: 'umt_four_stage', version: '1.0.0', short: 'UMT', family: 'umt',
  title: 'Unmatched transaction (UMT): four-stage research and correction',
  trigger: 'A disbursement appears on the Unmatched Transactions report: payment occurred but did not match or post to the intended record.',
  objective: 'Validate the unmatched disbursement, correct the underlying condition, and use the proper posting route so the payment is accounted for. Fixing the cause while the payment stays unmatched is not done.',
  authority: 'training_reference', source: FMRAC, reviewed: null,
  limitations: [...COMMON_LIMITS, 'The book gives no 1081 form fields, supporting-package requirements or submission channel. Follow the current local procedure.', 'The p. 117 table is a teaching decision tree; it never replaces validation.'],
  references: ['FMRAC 10.7 · orig. pp. 109-113', UMT_SRC],
  steps: [
    {
      key: 'identify', title: 'Stage 1 — Identify the error', kind: 'research',
      fields: [DOCUMENT, { key: 'error_text', label: 'Exact error description from the report' }, { key: 'umt_amount', label: 'Unmatched amount', money: true }, { key: 'disbursement_reference', label: 'Disbursement reference', optional: true }],
      responsibility: ['p2p_inquiry'],
      help: { objective: 'Capture the exact error and the affected transaction.', system: 'DAI', what: 'Copy the error description exactly as the report words it, and record the unmatched amount and the disbursement.', meaning: 'An exact error label narrows the research. Do not replace it with a generic "funding problem".', done: 'The error text, amount and document are on the record.', path: null, source: UMT_SRC },
    },
    {
      key: 'research', title: 'Stage 2 — Research and validate', kind: 'research',
      fields: [
        { key: 'po_line_amount', label: 'PO line amount', money: true, optional: true },
        { key: 'billed_amount', label: 'Billed amount', money: true, optional: true },
        { key: 'award_status', label: 'Award status', optional: true, hint: 'e.g. APPROVED, INCOMPLETE, not found' },
        { key: 'poet_loa', label: 'POET / LOA on the payment', optional: true },
        { key: 'receipt_status', label: 'Receipt status', optional: true },
      ],
      responsibility: ['p2p_inquiry'],
      help: { objective: 'Find the PO/award and decide whether the record is missing, inaccurate, unapproved or blocked.', system: 'DAI (P2P Inquiry / PO Search)', what: 'Identify the PO/award number. Determine impact (who and what is affected) and scale. Record the amounts, statuses and accounting data that tell the causes apart, and what remains unknown.', meaning: 'A report showing no posted payment on an award does not prove no payment was made.', done: 'The research that distinguishes the cause is on the record.', path: null, source: UMT_SRC },
    },
    {
      key: 'cause', title: 'Stage 3 — Choose the correction', kind: 'decision',
      decision: {
        key: 'umt_cause',
        choices: [
          ...UMT_ERRORS.map((e) => ({ key: e.key, label: e.label, hint: `${e.correction} (${e.route})` })),
          { key: UMT_INSUFFICIENT_FUNDS.key, label: UMT_INSUFFICIENT_FUNDS.label, hint: UMT_INSUFFICIENT_FUNDS.correction },
          REFER,
        ],
      },
      help: { objective: 'Choose the correction the evidence supports.', what: 'Pick the cause your research established — not just the label the report printed.', meaning: '"No matching record" may be a mismatched identifier; a billed amount must be validated before any award change.', done: 'A decision with its reason is recorded.', path: null, source: UMT_SRC },
    },
    verifyStep('confirm_no_award', 'award_absence_confirmed', 'Confirm the award is genuinely absent', 'Search by every identifier you have. "No matching record" may be a mismatched identifier rather than a missing award.', UMT_SRC, { decision: 'umt_cause', choices: ['no_matching_record'] }),
    action('post_award', 'Post the supported award', 'Post the award the evidence supports.', { onlyWhen: { decision: 'umt_cause', choices: ['no_matching_record'] }, requires: { check: 'award_absence_confirmed', message: 'Confirm the award is genuinely absent before posting one. "No matching record" may be a mismatched identifier.' }, responsibility: ['p2p_procurement_analyst'], source: UMT_SRC }),
    { key: 'shortfall', title: 'Calculate the award shortfall', kind: 'calculation', formula: 'umt_award_shortfall', onlyWhen: { decision: 'umt_cause', choices: ['billed_exceeds_po_line'] }, help: { objective: 'See how far the billed amount exceeds the PO line, citing both.', what: 'Vantage subtracts the PO line amount from the billed amount.', meaning: 'A candidate. The billed amount must be validated before the award changes.', done: 'A calculation citing both inputs is on the record.', path: null, source: UMT_SRC } },
    verifyStep('validate_bill', 'billed_amount_validated', 'Validate the billed amount', 'Validate the bill against the supported order and receipt. A billed amount failing a check is a research lead, not proof it is correct.', UMT_SRC, { decision: 'umt_cause', choices: ['billed_exceeds_po_line'] }),
    action('modify_award', 'Modify the award to the validated billed amount', 'Modify the award to the validated billed amount.', { onlyWhen: { decision: 'umt_cause', choices: ['billed_exceeds_po_line'] }, requires: { check: 'billed_amount_validated', message: 'Validate the billed amount before modifying the award.' }, responsibility: ['p2p_procurement_analyst'], source: UMT_SRC }),
    verifyStep('confirm_delivery', 'delivery_evidenced', 'Establish that delivery actually occurred', 'A receipt correction needs evidence of actual delivery. Record what you saw and where.', UMT_SRC, { decision: 'umt_cause', choices: ['qty_not_received'] }),
    action('record_receipt', 'Record or correct the supported receipt', 'Record or correct the receipt in DAI (P2P Receipts) for the quantity actually received.', { onlyWhen: { decision: 'umt_cause', choices: ['qty_not_received'] }, requires: { check: 'delivery_evidenced', message: 'A receipt correction needs evidence of actual delivery first.' }, responsibility: ['p2p_receipts'], waitsOn: 'posting', source: UMT_SRC }),
    action('route_approval', 'Obtain the Supply Officer’s approval', 'Route the award for the required Supply Officer approval.', { onlyWhen: { decision: 'umt_cause', choices: ['award_not_approved'] }, responsibility: ['iproc_requisitions_approver'], source: UMT_SRC }),
    action('request_funding', 'Request the supported funding action', 'Validate the funding requirement and request the supported funding action through the responsible authority.', { onlyWhen: { decision: 'umt_cause', choices: ['insufficient_project_funds'] }, responsibility: ['p2p_inquiry'], source: UMT_SRC }),
    posted(['post_award', 'modify_award', 'record_receipt', 'route_approval', 'request_funding'], { decision: 'umt_cause', choices: NON1081 }, UMT_SRC, 'posted', 'Underlying correction approved and posted'),
    action('non1081', 'Match the payment to the PO (NON-1081)', 'Perform the NON-1081 correction: match the paid transaction to the PO/document number now that the underlying condition is corrected.', { onlyWhen: { decision: 'umt_cause', choices: NON1081 }, responsibility: ['p2p_unmatched_tbo'], waitsOn: 'posting', source: 'FMRAC 11.3 · orig. p. 117', meaning: 'The FMRA performs the NON-1081 route.' }),
    action('submit_1081', 'Submit the 1081 request to DFAS', 'Submit the 1081 request so DFAS-Cleveland matches the payment to the PO and a different LOA. This is not done in DAI.', { onlyWhen: { decision: 'umt_cause', choices: ['data_elements_mismatch'] }, responsibility: ['p2p_unmatched_tbo'], waitsOn: 'external_response', source: 'FMRAC 11.3 · orig. p. 117', meaning: 'No submission channel is invented here; use the current local procedure.' }),
    { key: 'dfas_processed', title: 'DFAS 1081 processed', kind: 'external', waitsOn: 'external_response', observes: { step: 'submit_1081', completesOn: 'posted' }, onlyWhen: { decision: 'umt_cause', choices: ['data_elements_mismatch'] }, help: { objective: 'Confirm DFAS processed the 1081.', system: 'DAI', what: 'Record when DFAS reports the 1081 processed, and when it shows posted.', done: 'The 1081 is observed posted.', path: null, source: 'FMRAC 11.3 · orig. p. 117' } },
    verifyStep('verify_matched', 'disbursement_matched', 'Verify the payment matched the intended record', 'Confirm the disbursement is matched to the intended PO and accounting scope, and amounts, quantities and data agree.', 'FMRAC 11.2 · orig. p. 117'),
    verifyStep('verify_cleared', 'condition_cleared', 'Verify the UMT cleared', 'Confirm the current UMT view no longer shows the item. Keep the before-and-after evidence.', 'FMRAC 11.2 · orig. p. 117'),
    resolveStep('Resolve once the payment is matched and the UMT no longer shows.'),
  ],
};

/* ── Invoice on hold ──────────────────────────────────────────────────────────────────────── */

const HOLD_SRC = 'FMRAC 10.6 · orig. pp. 109-113';

export const INVOICE_HOLD: Procedure = {
  key: 'invoice_hold', version: '1.0.0', short: 'Hold', family: 'abnormal_condition',
  title: 'Invoice on hold: research and correct',
  trigger: 'An invoice appears on the Invoices on Hold report: it knows where to post but cannot satisfy the required conditions. Payment has not occurred.',
  objective: 'Find which matching condition failed and correct the supported record — or get an incorrect bill corrected — so payment can proceed.',
  authority: 'training_reference', source: FMRAC, reviewed: null,
  limitations: [...COMMON_LIMITS, INVOICE_HOLDS.guard],
  references: [HOLD_SRC, 'FMRAC 10.1 · orig. pp. 109-113'],
  steps: [
    {
      key: 'identify', title: 'Identify the hold', kind: 'research',
      fields: [DOCUMENT, { key: 'hold_amount', label: 'Amount on hold', money: true }, { key: 'match_type', label: 'Match type', options: [{ key: 'two_way', label: 'Two-way (PO + invoice)' }, { key: 'three_way', label: 'Three-way (PO + receipt + invoice)' }] }, { key: 'hold_reason_text', label: 'Hold reason as the report words it', optional: true }],
      responsibility: ['p2p_inquiry'],
      help: { objective: 'Pin down the invoice, the amount held and the match that failed.', system: 'DAI', what: 'Record the amount on hold (all of it or part), the match type, and the hold reason.', meaning: 'A hold means payment has not happened yet — unlike a UMT.', done: 'The hold is identified.', path: null, source: HOLD_SRC },
    },
    {
      key: 'quantities', title: 'Compare ordered, billed and received', kind: 'research',
      fields: [
        { key: 'quantity_ordered', label: 'Quantity ordered', quantity: true, optional: true },
        { key: 'quantity_billed', label: 'Quantity billed', quantity: true, optional: true },
        { key: 'quantity_received', label: 'Quantity received', quantity: true, optional: true },
        { key: 'billed_amount', label: 'Billed amount', money: true, optional: true },
        { key: 'po_line_amount', label: 'PO line amount', money: true, optional: true },
      ],
      responsibility: ['p2p_inquiry'],
      help: { objective: 'See which comparison failed.', system: 'DAI', what: 'Record what was ordered, billed and received (three-way) or ordered and billed (two-way).', meaning: 'A quantity failing a check is a research lead, not proof the bill is right.', done: 'The comparison is on the record.', path: null, source: HOLD_SRC },
    },
    {
      key: 'cause', title: 'Decide the cause the evidence supports', kind: 'decision',
      decision: { key: 'hold_cause', choices: [...INVOICE_HOLDS.causes.map((c) => ({ key: c.key, label: c.label, hint: `${c.match}. ${c.correction}` })), REFER] },
      help: { objective: 'Choose the cause, with the reason.', what: 'A valid bill may need a supported record correction; an incorrect bill needs its own correction.', meaning: INVOICE_HOLDS.guard, done: 'A decision with its reason is recorded.', path: null, source: HOLD_SRC },
    },
    verifyStep('validate_bill', 'billed_amount_validated', 'Validate the bill', 'Validate the billed quantity or price against the supported order.', HOLD_SRC, { decision: 'hold_cause', choices: ['billed_exceeds_ordered', 'price_change'] }),
    action('reconcile_award', 'Reconcile the supported award or order', 'Reconcile the award or order to what the validated bill supports — never simply to the invoice value.', { onlyWhen: { decision: 'hold_cause', choices: ['billed_exceeds_ordered', 'price_change'] }, requires: { check: 'billed_amount_validated', message: 'Validate the bill before reconciling the award. "Reconcile the award" never means raising it to the invoice value.' }, responsibility: ['p2p_procurement_analyst'], source: HOLD_SRC }),
    verifyStep('confirm_delivery', 'delivery_evidenced', 'Validate the actual receipt', 'Validate what was actually received against the receiving evidence.', HOLD_SRC, { decision: 'hold_cause', choices: ['billed_exceeds_received', 'insufficient_receipt'] }),
    action('correct_receipt', 'Reconcile the receipt record', 'Correct the receipt for the quantity actually received.', { onlyWhen: { decision: 'hold_cause', choices: ['billed_exceeds_received', 'insufficient_receipt'] }, requires: { check: 'delivery_evidenced', message: 'Validate the actual receipt before correcting the receipt record.' }, responsibility: ['p2p_receipts'], waitsOn: 'posting', source: HOLD_SRC }),
    action('bill_correction', 'Request the bill’s correction', 'Request the incorrect bill’s own correction. The record is not changed to match a wrong bill.', { onlyWhen: { decision: 'hold_cause', choices: ['bill_incorrect'] }, responsibility: ['p2p_inquiry'], waitsOn: 'external_response', source: HOLD_SRC }),
    posted(['reconcile_award', 'correct_receipt', 'bill_correction'], { decision: 'hold_cause', choices: INVOICE_HOLDS.causes.map((c) => c.key) }, HOLD_SRC),
    verifyStep('verify_cleared', 'condition_cleared', 'Verify the hold released', 'Confirm the Invoices on Hold report no longer lists the invoice and payment proceeds.', HOLD_SRC),
    resolveStep('Resolve once the hold is verified released.'),
  ],
};

/* ── Feeder-system reject (DTS or GCSS-MC) ────────────────────────────────────────────────── */

const REJECT_SRC = 'FMRAC 10.3-10.4 · orig. pp. 109-113';

export const FEEDER_REJECT: Procedure = {
  key: 'feeder_reject', version: '1.0.0', short: 'Reject', family: 'abnormal_condition',
  title: 'Feeder-system reject (DTS or GCSS-MC): research and correct',
  trigger: 'A transaction was returned to DTS or GCSS-MC after failing a financial check.',
  objective: 'Correct the financial data or the funding that failed the check, and verify the rejected transaction itself then processed and posted.',
  authority: 'training_reference', source: FMRAC, reviewed: null,
  limitations: COMMON_LIMITS,
  references: [REJECT_SRC],
  steps: [
    {
      key: 'identify', title: 'Identify the reject', kind: 'research',
      fields: [DOCUMENT, { key: 'feeder_system', label: 'Feeder system', options: [{ key: 'dts', label: 'DTS' }, { key: 'gcss', label: 'GCSS-MC' }] }, { key: 'reject_text', label: 'Reject message as the system words it' }],
      responsibility: ['p2p_inquiry'],
      help: { objective: 'Record which system rejected what, and why.', system: 'DTS / GCSS-MC', what: 'Record the feeder system and the exact reject message.', meaning: 'A BFS reject is returned to the feeder after a failed check — different from an interface error in DAI.', done: 'The reject is identified.', path: null, source: 'FMRAC 10.2 · orig. pp. 109-113' },
    },
    {
      key: 'cause', title: 'Decide the cause', kind: 'decision',
      decision: { key: 'reject_cause', choices: [{ key: 'data_mismatch', label: `Data mismatch (${FEEDER_REJECTS.dts.causes[0].label} / ${FEEDER_REJECTS.gcss.causes[0].label})`, hint: 'Validate the FDEs against the intended DAI funding data.' }, { key: 'insufficient_funds', label: 'Insufficient funds', hint: 'Check the feeder budget first, then the DAI project.' }, REFER] },
      help: { objective: 'Choose the cause the evidence supports.', what: 'Compare the feeder’s LOA or CostJON with the intended POET, and check funds where the reject points.', done: 'A decision with its reason is recorded.', path: null, source: REJECT_SRC },
    },
    {
      key: 'funds_research', title: 'Check funds in both places', kind: 'research', onlyWhen: { decision: 'reject_cause', choices: ['insufficient_funds'] },
      fields: [{ key: 'feeder_budget_available', label: 'Feeder budget available (DTS budget / GCSS-MC budget journal)', money: true }, { key: 'dai_project_available', label: 'DAI project funds available', money: true }],
      responsibility: ['p2p_inquiry'],
      help: { objective: 'Find where the funding is short.', system: 'DTS / GCSS-MC, then DAI', what: 'Check the feeder budget first, then the DAI project.', meaning: 'Funds in one place do not prove sufficient funds in the other.', done: 'Both figures are recorded.', path: null, source: REJECT_SRC },
    },
    action('correct_data', 'Correct the financial data', 'Correct the LOA/POET or CostJON/POET discrepancy through the responsible process.', { onlyWhen: { decision: 'reject_cause', choices: ['data_mismatch'] }, responsibility: ['p2p_inquiry'], waitsOn: 'internal_action', source: REJECT_SRC }),
    action('request_funding', 'Route the funding action', 'Route any required funding action to its responsible owner.', { onlyWhen: { decision: 'reject_cause', choices: ['insufficient_funds'] }, responsibility: ['p2p_inquiry'], waitsOn: 'approval', source: REJECT_SRC }),
    posted(['correct_data', 'request_funding'], { decision: 'reject_cause', choices: ['data_mismatch', 'insufficient_funds'] }, REJECT_SRC, 'effective', 'Correction effective'),
    verifyStep('verify_transaction', 'transaction_posted', 'Verify the rejected transaction processed', 'Confirm the corrected authorization, voucher or requisition passed its checks and the intended transaction posted to DAI. Changing the mapping or journal is not the same thing.', REJECT_SRC),
    verifyStep('verify_cleared', 'condition_cleared', 'Verify the reject cleared', 'Confirm the reject no longer appears.', REJECT_SRC),
    resolveStep('Resolve once the rejected transaction is verified posted.'),
  ],
};

/* ── Interface error (ServMart / fuel) ────────────────────────────────────────────────────── */

const IFACE_SRC = 'FMRAC 10.5 · orig. pp. 109-113';

export const INTERFACE_ERROR: Procedure = {
  key: 'interface_error', version: '1.0.0', short: 'Interface', family: 'abnormal_condition',
  title: 'Interface error (ServMart / fuel): research and correct',
  trigger: 'A ServMart or fuel transaction appears on the Interface Error report: it failed to post in DAI.',
  objective: 'Get the original purchase accounted for against the intended accounting data — without recording it twice.',
  authority: 'training_reference', source: FMRAC, reviewed: null,
  limitations: [...COMMON_LIMITS, INTERFACE_ERRORS.guard],
  references: [IFACE_SRC],
  steps: [
    {
      key: 'identify', title: 'Identify the failed transaction', kind: 'research',
      fields: [DOCUMENT, { key: 'feeder', label: 'Source', options: [{ key: 'servmart', label: 'ServMart' }, { key: 'fuel', label: 'Fuel' }] }, { key: 'identifier', label: 'JON or fuel-key combination submitted' }, { key: 'error_text', label: 'Error as the report words it', optional: true }],
      responsibility: ['p2p_inquiry'],
      help: { objective: 'Record what was submitted and what failed.', system: 'DAI (Interface Error report)', what: 'Record the source, the identifier exactly as submitted, and the error.', meaning: 'Preserve the issued identifier; never regenerate one from its appearance.', done: 'The failed transaction is identified.', path: null, source: IFACE_SRC },
    },
    {
      key: 'cause', title: 'Decide the cause', kind: 'decision',
      decision: { key: 'interface_cause', choices: [...INTERFACE_ERRORS.causes.map((c) => ({ key: c.key, label: c.label, hint: c.correction })), REFER] },
      help: { objective: 'Choose the cause the evidence supports.', what: 'Check whether the alias mapping exists, then compare the submitted identifiers with it. Manual-entry error is common.', done: 'A decision with its reason is recorded.', path: null, source: IFACE_SRC },
    },
    action('alias_request', 'Prepare and route the alias load request', 'Prepare the GSA or Fuel Key Alias Table load request and route it to L1, HQMC P&R.', { onlyWhen: { decision: 'interface_cause', choices: ['alias_not_loaded'] }, responsibility: ['p2p_inquiry'], waitsOn: 'external_response', source: 'FMRAC 5.2, 10.5' }),
    action('correct_data', 'Correct the supported data', 'Correct the data the evidence supports rather than forcing an unrelated mapping.', { onlyWhen: { decision: 'interface_cause', choices: ['data_element_mismatch'] }, responsibility: ['p2p_inquiry'], waitsOn: 'internal_action', source: IFACE_SRC }),
    action('request_funding', 'Request additional project funds', 'Request additional project funds through the responsible authority.', { onlyWhen: { decision: 'interface_cause', choices: ['insufficient_project_funds'] }, responsibility: ['p2p_inquiry'], waitsOn: 'approval', source: IFACE_SRC }),
    posted(['alias_request', 'correct_data', 'request_funding'], { decision: 'interface_cause', choices: INTERFACE_ERRORS.causes.map((c) => c.key) }, IFACE_SRC, 'effective', 'Correction effective'),
    verifyStep('verify_accounted', 'original_purchase_accounted', 'Verify the original purchase is accounted for', 'Confirm the interface transaction posted against the intended accounting data. No second purchase was recorded.', IFACE_SRC),
    verifyStep('verify_cleared', 'condition_cleared', 'Verify the interface error cleared', 'Confirm the Interface Error report no longer lists it.', IFACE_SRC),
    resolveStep('Resolve once the original purchase is verified accounted for.'),
  ],
};

export const FMRA_PROCEDURES: Procedure[] = [UMT_FOUR_STAGE, OCMT_RESEARCH, UDOU_RESEARCH, DOU_RESEARCH, OTO_RESEARCH, INVOICE_HOLD, FEEDER_REJECT, INTERFACE_ERROR];
