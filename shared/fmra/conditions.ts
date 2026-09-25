import { cite, type Cite } from './source.ts';
import type { WorkResponsibility } from './roles.ts';

export interface Cause {
  key: string;
  label: string;
  pattern: 'full' | 'partial' | 'both';
  /** What distinguishes this cause from the others. */
  research: string;
  /** The supported correction or path. */
  correction: string;
  valid?: boolean;
  /** The responsibilities that can carry the correction out. */
  responsibility: WorkResponsibility[];
}

export interface Example {
  commitment: number | null;
  obligation: number | null;
  delivered: number | null;
  paid: number | null;
  explanation: string;
}

export const NORMAL_KEYS = ['ocmt', 'udou', 'dou', 'oto'] as const;
export type NormalKey = (typeof NORMAL_KEYS)[number];

export interface NormalCondition {
  key: NormalKey;
  abbr: string;
  name: string;
  whatIsOpen: string;
  firstQuestion: string;
  /** Editorial arithmetic for the examples only; it never diagnoses a cause. */
  formula: string;
  examples: { full: Example; partial: Example };
  causes: Cause[];
  verification: string;
  /** A correction this condition tempts people into that the book forbids. */
  guard?: string;
  cite: Cite;
}

export const NORMAL_CONDITIONS: Record<NormalKey, NormalCondition> = {
  ocmt: {
    key: 'ocmt', abbr: 'OCMT', name: 'Open / Outstanding Commitment',
    whatIsOpen: 'A requisition amount not yet covered by an obligation.',
    firstQuestion: 'Is the requirement still valid, and why has the award not posted for the full amount?',
    formula: 'commitment − obligation',
    examples: {
      full: { commitment: 100, obligation: null, delivered: null, paid: null, explanation: '$100 is committed with no associated obligation.' },
      partial: { commitment: 100, obligation: 50, delivered: 50, paid: 50, explanation: '$50 remains committed above the obligation.' },
    },
    causes: [
      { key: 'mipr_not_acknowledged', label: 'MIPR not acknowledged', pattern: 'full', research: 'Check for the signed agency acceptance (DD 448-2) and the acknowledgement status.', correction: 'Process the appropriate acknowledgement and award steps when supported.', responsibility: ['mipr_ack', 'award'] },
      { key: 'requirement_invalid', label: 'Requirement no longer valid', pattern: 'full', research: 'Confirm the requirement is invalid with the responsible personnel and records.', correction: 'Recoup the funds held by the invalid requisition through the authorized correction.', responsibility: ['requisition'] },
      { key: 'interface_error', label: 'DAI interface error', pattern: 'full', research: 'Find the failed transmission or record and its error details.', correction: 'Correct the underlying interface condition and verify posting.', responsibility: ['research'] },
      { key: 'final_price_lower', label: 'Final price is lower', pattern: 'partial', research: 'Validate that the obligated amount is the final supported cost and that no requirement remains.', correction: 'Amend the requisition to the supported final price.', responsibility: ['requisition'] },
      { key: 'award_incomplete', label: 'Award is incomplete', pattern: 'partial', research: 'Validate that the full committed requirement remains valid.', correction: 'Process the supported award amount rather than automatically reducing the commitment.', responsibility: ['award'] },
    ],
    verification: 'Recheck the requisition and the award after approval and posting. A submitted amendment or acknowledgement is an action taken, not proof the residual cleared.',
    cite: cite('8.2, 9.2', '100-104'),
  },
  udou: {
    key: 'udou', abbr: 'UDOU', name: 'Undelivered Order, Unpaid',
    whatIsOpen: 'An obligation not yet followed by the corresponding receipt/delivery and payment.',
    firstQuestion: 'Are the goods or services still due, or is their receipt missing from accounting?',
    formula: 'obligation − delivered',
    examples: {
      full: { commitment: 100, obligation: 100, delivered: null, paid: null, explanation: 'The $100 obligation has no corresponding delivery or payment.' },
      partial: { commitment: 100, obligation: 100, delivered: 50, paid: 50, explanation: '$50 remains undelivered and unpaid.' },
    },
    causes: [
      { key: 'valid_back_order', label: 'Valid back-order', pattern: 'both', research: 'Verify the items (or the remaining portion) are still on back-order.', correction: 'Retain the valid obligation and monitor the expected delivery.', valid: true, responsibility: ['research'] },
      { key: 'missing_receipt', label: 'Receipt not recorded', pattern: 'both', research: 'Establish that the goods or services were actually received — all of them, or which portion.', correction: 'Record or correct the delivered entry for the actually received portion through the proper source process. The cause may be an interface failure or an omitted manual entry.', responsibility: ['receipt'] },
      { key: 'erroneous_award', label: 'Erroneous award', pattern: 'full', research: 'Determine that the requirement is genuinely invalid.', correction: 'Modify or amend the award and requisition through the authorized process to recoup the unsupported funds.', responsibility: ['award', 'requisition'] },
      { key: 'final_price_lower', label: 'Lower final price', pattern: 'partial', research: 'Validate the final cost.', correction: 'Adjust the award and requisition accordingly.', responsibility: ['award', 'requisition'] },
    ],
    verification: 'Show which quantity or amount is still due, which was received, and which is no longer required.',
    guard: 'Do not create a receipt merely to remove an open balance when delivery has not occurred.',
    cite: cite('8.2, 9.3', '100-105'),
  },
  dou: {
    key: 'dou', abbr: 'DOU', name: 'Delivered Order, Unpaid',
    whatIsOpen: 'A delivered amount without the corresponding posted disbursement.',
    firstQuestion: 'Is payment pending, blocked, unmatched, or incorrectly recorded?',
    formula: 'delivered − paid',
    examples: {
      full: { commitment: 100, obligation: 100, delivered: 100, paid: null, explanation: '$100 delivered has no corresponding payment posting.' },
      partial: { commitment: 100, obligation: 100, delivered: 100, paid: 50, explanation: '$50 delivered remains without posted payment.' },
    },
    causes: [
      { key: 'hold_or_umt', label: 'Invoice on hold, or an unmatched payment', pattern: 'both', research: 'Research the Invoices on Hold and Unmatched Transactions reports and the supporting payment data for the unpaid amount.', correction: 'Correct the underlying hold or unmatched condition.', responsibility: ['unmatched', 'research'] },
      { key: 'erroneous_receipt', label: 'Erroneous receipt', pattern: 'full', research: 'Validate the actual delivery.', correction: 'Return or correct the receipt posted in error.', responsibility: ['receipt'] },
      { key: 'excess_receipt', label: 'Excess receipt', pattern: 'partial', research: 'Establish whether only part of the goods or services was actually received.', correction: 'Validate and correct the unsupported part of the receipt.', responsibility: ['receipt'] },
      { key: 'payment_pending', label: 'Payment still pending', pattern: 'both', research: 'Establish the internal status, evidence, matching and interface condition first. The book treats DFAS delay as a last-resort explanation.', correction: 'Monitor; contact DFAS only once internal causes are ruled out.', valid: true, responsibility: ['research'] },
    ],
    verification: 'A DOU amount alone cannot distinguish an unpaid invoice from a payment that happened but did not match. Confirm payment evidence before choosing the correction.',
    cite: cite('8.2, 9.4', '100-106'),
  },
  oto: {
    key: 'oto', abbr: 'OTO', name: 'Outstanding Travel Order',
    whatIsOpen: 'A DTS obligation without full posted disbursement.',
    firstQuestion: 'Did travel occur, was the voucher processed, and did it interface correctly?',
    formula: 'travel obligation − paid',
    examples: {
      full: { commitment: null, obligation: 100, delivered: null, paid: null, explanation: 'The $100 travel obligation has no posted disbursement.' },
      partial: { commitment: null, obligation: 100, delivered: 50, paid: 50, explanation: '$50 remains between the travel obligation and payment.' },
    },
    causes: [
      { key: 'travel_did_not_occur', label: 'Travel did not occur', pattern: 'full', research: 'Ask the traveler whether travel happened.', correction: 'Establish the correct cancellation or adjustment path rather than assuming reimbursement is due.', responsibility: ['dts_award'] },
      { key: 'voucher_not_submitted', label: 'Voucher not submitted', pattern: 'full', research: 'Check the DTS voucher status.', correction: 'Notify the traveler of the required action.', responsibility: ['research'] },
      { key: 'voucher_incorrect', label: 'Voucher needs correction', pattern: 'both', research: 'Check whether the voucher was prepared incorrectly.', correction: 'Notify the traveler of the required correction.', responsibility: ['research'] },
      { key: 'bfs_interface_failure', label: 'BFS / interface failure', pattern: 'both', research: 'Check for a BFS error preventing the transaction from posting.', correction: 'Find and resolve the BFS condition.', responsibility: ['research', 'dts_award'] },
    ],
    verification: 'Follow the corrected voucher through routing, approval, DTS status, the DAI adjustment and posting, and payment. Keep waiting on the traveler separate from waiting on an approver or an interface.',
    cite: cite('8.2, 9.5', '100-107'),
  },
};

export const NORMAL_LIST = NORMAL_KEYS.map((k) => NORMAL_CONDITIONS[k]);

export const REPORT_NOTES = [
  { text: 'A dash in the book’s examples means no amount is shown. It is not automatically a database zero.', cite: cite('8.3', '100-102') },
  { text: 'Use a consistent document, line and accounting scope, and tell cumulative totals from remaining balances, before subtracting anything.', cite: cite('8.3', '100-102', 'editorial') },
  { text: '"ULO" is often used at work for unliquidated obligations. The book teaches UDOU and DOU as distinct conditions; do not collapse every open obligation into "undelivered".', cite: cite('8.2', '99-102') },
  { text: 'Page 100 uses "MIPR Acknowledgement" for an OCMT tied to a MIPR not yet acknowledged. Read it as an unacknowledged-MIPR condition, not a separate financial phase.', cite: cite('8.3', '100', 'discrepancy') },
] as const;

export const KPI = {
  definition: 'A Key Performance Indicator measures a condition or performance characteristic. Financial reports support command evaluation, account accuracy and risk identification; the HQMC Dashboard is a commander-facing overview of selected KPIs.',
  kinds: [
    { key: 'measurable', label: 'Measurable indicator' },
    { key: 'quantitative', label: 'Quantitative (numerical data)' },
    { key: 'qualitative', label: 'Qualitative (descriptive information)' },
    { key: 'leading', label: 'Leading indicator (anticipates future outcomes)' },
  ],
  kindsNote: 'These overlap. They are ways to characterize a measure, not mutually exclusive account types.',
  cite: cite('8.1', '99-102'),
} as const;

export const OAS = {
  summary: 'Oracle Analytics Server (OAS), reached through OBIEE Answers USMC: dashboards and premade analyses, tailored with prompts, filters and selection steps.',
  categories: [
    { key: 'B2R', use: 'Funding authorizations.' },
    { key: 'CA', use: 'Project/task structures and financial-data-element reports.' },
    { key: 'O2C', use: 'Incoming reimbursable and Acquisition and Cross Servicing Agreement (ACSA) reports.' },
    { key: 'P2P', use: 'Purchases and related execution.' },
  ],
  practice: 'Keep the report date, organizational scope, fiscal-year scope, filters, and what each amount means with every export. A filtered report and an all-history award screen may legitimately show different totals; a comparison means something only once the scopes agree.',
  cite: cite('8.4', '99-102', 'editorial'),
} as const;

/** Research before action (ch. 9.1). */
export const RESEARCH_FACTORS = ['Transaction age', 'Dollar amount', 'Purchase method', 'Lifecycle phase', 'Financial data elements'] as const;
export const RESEARCH_SEQUENCE = [
  'Identify the condition.',
  'Validate the requirement and the evidence.',
  'Determine the cause.',
  'Route the supported correction.',
  'Verify the resulting posting.',
  'Document the result.',
] as const;
export const ANALYSIS_TYPES = {
  trend: 'Trend analysis identifies recurring patterns.',
  rootCause: 'Root-cause analysis explains why a pattern occurred and what prevents it recurring.',
};

export const ABNORMAL = {
  definition: 'A departure from the lifecycle, or a failed DAI system check, that leaves a transaction stuck and needing intervention.',
  triggers: ['Incorrect financial data', 'No matching record', 'Insufficient funds', 'A missing required transaction'],
  consequence: 'Such conditions can leave actual execution uncaptured.',
  cite: cite('10.1', '109-114'),
} as const;

export const MATCHING = [
  { key: 'two_way', label: 'Two-way match', compares: 'Purchase order and invoice.' },
  { key: 'three_way', label: 'Three-way match', compares: 'Purchase order, receipt and invoice.' },
] as const;
export const MATCHING_NOTE = 'A quantity or amount failing a check is a research lead, not proof the billed value is correct.';

export const ERROR_CLASSES = [
  { key: 'bfs_reject', label: 'BFS error / reject', where: 'Returned to the feeder system after a failed check.', why: 'DTS and GCSS-MC hold the configured financial data and local budget controls.' },
  { key: 'interface_error', label: 'Interface error', where: 'The Interface Error Report, after a transmission through feeder or alias paths fails to post in DAI.', why: 'ServMart/fuel alias mappings, financial data, or project funds may block posting.' },
  { key: 'invoice_hold', label: 'Invoice on hold', where: 'The Invoices on Hold Report.', why: 'A payment-related transaction is prevented from progressing. Payment has not yet occurred.' },
  { key: 'umt', label: 'Unmatched transaction', where: 'The Unmatched Transactions Report.', why: 'Payment occurred but has not been properly applied or accounted for.' },
] as const;

export interface AbnormalCause {
  key: string;
  label: string;
  research: string;
  correction: string;
  /** Check this first, then that — when the book names an order. */
  order?: string[];
  responsibility: WorkResponsibility[];
}

export const FEEDER_REJECTS: Record<'dts' | 'gcss', { system: string; causes: AbnormalCause[]; verification: string; cite: Cite }> = {
  dts: {
    system: 'DTS',
    causes: [
      { key: 'data_mismatch', label: 'LOA / POET mismatch', research: 'Compare the DTS LOA with the intended DAI funding data and validate the FDEs.', correction: 'Correct the discrepancy through the responsible process.', responsibility: ['research', 'dts_award'] },
      { key: 'insufficient_funds', label: 'Insufficient funds', research: 'Validate the DTS budget first, then the DAI project. Funds in one place do not prove sufficient funds in the other.', correction: 'Route any required funding action to its responsible owner.', order: ['DTS budget', 'DAI project'], responsibility: ['research'] },
    ],
    verification: 'Confirm the corrected authorization or voucher can pass the relevant checks and that the intended transaction then posts to DAI.',
    cite: cite('10.3', '109-113'),
  },
  gcss: {
    system: 'GCSS-MC',
    causes: [
      { key: 'data_mismatch', label: 'CostJON / POET mismatch', research: 'Validate the GCSS-MC CostJON and the mapped POET.', correction: 'Correct the inaccurate financial data.', responsibility: ['research'] },
      { key: 'insufficient_funds', label: 'Insufficient funds', research: 'Check the GCSS-MC budget journal first, then the DAI project.', correction: 'Route any required funding action to its responsible owner.', order: ['GCSS-MC budget journal', 'DAI project'], responsibility: ['research'] },
    ],
    verification: 'Recheck the failed transaction and the intended award or delivered posting. Changing the mapping or journal is not the same as verifying the rejected transaction processed.',
    cite: cite('10.4', '109-113'),
  },
};

export const INTERFACE_ERRORS: { causes: AbnormalCause[]; verification: string; guard: string; cite: Cite } = {
  causes: [
    { key: 'alias_not_loaded', label: 'Alias table not loaded', research: 'Confirm whether the required POET/identifier mapping exists.', correction: 'Prepare and route the appropriate load request (GSA or Fuel Key Alias Table) when it does not.', responsibility: ['research'] },
    { key: 'data_element_mismatch', label: 'Data-element mismatch', research: 'Compare the submitted identifiers with the intended mapping. Manual-entry error is a common cause.', correction: 'Correct the supported data rather than forcing an unrelated mapping.', responsibility: ['research'] },
    { key: 'insufficient_project_funds', label: 'Insufficient project funds', research: 'Validate the funding requirement.', correction: 'Request additional project funds through the responsible authority when appropriate.', responsibility: ['research'] },
  ],
  verification: 'Confirm the interface transaction posts against the intended accounting data and the original purchase is accounted for.',
  guard: 'Do not record a second purchase merely because the first failed to interface.',
  cite: cite('10.5', '109-113'),
};

export const INVOICE_HOLDS = {
  meaning: 'An invoice on hold knows where it should post but cannot satisfy the required conditions, and payment has not yet occurred. A hold may affect the full or a partial amount — e.g. $100 delivered with $0 paid, or $100 delivered with $50 paid and $50 still on hold.',
  causes: [
    { key: 'billed_exceeds_ordered', label: 'Quantity billed exceeds quantity ordered', match: 'Two-way or three-way', research: 'Validate the bill.', correction: 'Reconcile the supported award or order.', responsibility: ['award'] as WorkResponsibility[] },
    { key: 'billed_exceeds_received', label: 'Quantity billed exceeds quantity received', match: 'Three-way', research: 'Validate the actual receipt.', correction: 'Reconcile the receipt record.', responsibility: ['receipt'] as WorkResponsibility[] },
    { key: 'price_change', label: 'Price change', match: 'Either', research: 'Validate the billed price against the supported award.', correction: 'A valid bill may need a supported record correction.', responsibility: ['award'] as WorkResponsibility[] },
    { key: 'insufficient_receipt', label: 'Insufficient receipt', match: 'Three-way', research: 'Validate what was actually received.', correction: 'Correct the receipt for the actually received quantity.', responsibility: ['receipt'] as WorkResponsibility[] },
    { key: 'bill_incorrect', label: 'The bill itself is wrong', match: 'Either', research: 'Establish the bill does not match the supported order or receipt.', correction: 'An incorrect bill needs its own correction; the record is not changed to match it.', responsibility: ['research'] as WorkResponsibility[] },
  ],
  guard: '"Reconcile the award" never authorizes blindly increasing every award to an invoice value.',
  cite: cite('10.6', '109-113'),
} as const;

export const UMT = {
  definition: 'Payment occurred but did not successfully match or post to the intended accounting record — a payment without a home.',
  objective: 'Validate the unmatched disbursement, correct the underlying condition, and use the proper posting route so the payment is accounted for correctly. The work is incomplete if the cause is fixed but the paid transaction remains unmatched.',
  causes: [
    'No matching award',
    'A data mismatch preventing an existing award from being found',
    'Insufficient project funds',
    'A payment greater than the supported award',
    'A missing or insufficient receipt',
    'An award not in APPROVED status',
  ],
  warning: 'A report showing no posted payment on an award does not prove no payment was made. It may be unmatched elsewhere: review the disbursement evidence and the UMT record before recommending another payment.',
  cite: cite('10.7, 11.1', '109-117'),
} as const;

export type Route = 'NON-1081' | '1081';

export interface UmtError {
  key: string;
  /** The error text as the report words it. */
  label: string;
  correction: string;
  route: Route;
  /** What must be established before the correction is chosen. */
  validate: string;
  responsibility: WorkResponsibility[];
}

export const UMT_ERRORS: UmtError[] = [
  { key: 'no_matching_record', label: 'No matching record (award)', correction: 'Post the supported award.', route: 'NON-1081', validate: '"No matching record" may be a mismatched identifier rather than a genuinely absent award. Search before posting anything.', responsibility: ['award'] },
  { key: 'billed_exceeds_po_line', label: 'Billed AMT is greater than PO line AMT', correction: 'Modify the award to the validated billed amount.', route: 'NON-1081', validate: 'Validate the billed amount before adjusting the award.', responsibility: ['award'] },
  { key: 'qty_not_received', label: 'Not enough Qty received', correction: 'Record or correct the supported receipt in DAI.', route: 'NON-1081', validate: 'A receipt correction needs evidence of actual delivery.', responsibility: ['receipt'] },
  { key: 'award_not_approved', label: 'Award not in APPROVED status', correction: 'Obtain the required Supply Officer approval.', route: 'NON-1081', validate: 'Confirm the award is otherwise correct and only lacks approval.', responsibility: ['approval'] },
  { key: 'data_elements_mismatch', label: 'Data elements do not match', correction: 'Submit the 1081 request to DFAS. The book says this is not done in DAI.', route: '1081', validate: 'Establish which data elements differ and what the correct line of accounting is.', responsibility: ['unmatched'] },
];

/** A source-listed cause that is not a row of the five-row p. 117 matrix. */
export const UMT_INSUFFICIENT_FUNDS = {
  key: 'insufficient_project_funds', label: 'Insufficient project funds',
  correction: 'Validate the funding requirement and request the supported funding action before expecting the transaction to pass its check.',
  route: 'NON-1081' as Route,
};

export const UMT_STAGES = [
  { stage: 1, title: 'Identify the error', detail: 'Capture the exact report error description and the affected transaction. An exact error label narrows the research; do not replace it with a generic "funding problem" before the cause is established.' },
  { stage: 2, title: 'Research and validate', detail: 'Find the PO/award number with P2P Inquiry or PO Search. Determine the impact (who and what is affected) and the scale. Compare the transaction data and evidence to decide whether the record is missing, inaccurate, unapproved or blocked.' },
  { stage: 3, title: 'Analyze and choose the correction', detail: 'Pick the correction the evidence supports. The p. 117 table is a teaching decision tree; it never replaces validation.' },
  { stage: 4, title: 'Correct and verify', detail: 'Resolve the underlying condition through the authorized role; complete approval and posting; then perform the unmatched-transaction correction and verify the paid activity is applied to the intended record.' },
] as const;

export const UMT_RESEARCH_FIELDS = [
  'Document / PO number', 'Line and accounting distribution, if relevant', 'Error text', 'Disbursement reference', 'Amount', 'Supplier',
  'POET / LOA', 'Award and receipt status', 'Supporting documents', 'What remains unknown',
] as const;

/** Editorial completion criteria for a UMT. */
export const UMT_COMPLETION = [
  'The correct record exists.',
  'Required approvals have completed.',
  'Supported amounts, quantities and accounting data agree.',
  'The disbursement is matched to the intended PO and accounting scope.',
  'The current UMT view no longer shows the unresolved item.',
  'Before-and-after evidence and any remaining exception are retained.',
] as const;

export const ROUTES: Record<Route, { performer: string; purpose: string }> = {
  'NON-1081': { performer: 'FMRA', purpose: 'Match the paid transaction to the PO/document number after the underlying condition is corrected.' },
  '1081': { performer: 'DFAS-Cleveland', purpose: 'Match the payment to the PO and a different LOA, using the submitted correction request.' },
};

export const ROUTE_LIMIT = 'The book gives no form fields, supporting-package requirements, submission addresses, approvals or screen-by-screen steps for either route. Those stay local, current procedure inputs; no DFAS submission channel is invented and the study guide is not a delegation to post.';

export const CORRECTION_STATES = [
  { key: 'research_needed', label: 'Research needed' },
  { key: 'awaiting_ksd', label: 'Awaiting KSD' },
  { key: 'correction_prepared', label: 'Correction prepared' },
  { key: 'awaiting_approval', label: 'Awaiting approval' },
  { key: 'awaiting_posting', label: 'Awaiting feeder/DAI posting' },
  { key: 'awaiting_non1081', label: 'Awaiting NON-1081 action' },
  { key: 'awaiting_1081', label: 'Awaiting DFAS 1081 processing' },
  { key: 'verification_required', label: 'Verification required' },
  { key: 'resolved_with_evidence', label: 'Resolved with evidence' },
] as const;
