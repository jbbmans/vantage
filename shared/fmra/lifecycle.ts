import { cite, type Cite } from './source.ts';

/**
 * The financial transaction lifecycle, as the FMRAC teaches it.
 *
 * Procurement acquires a good or service; the requisitioning process moves a requirement through
 * validation, approval, ordering and delivery. The financial lifecycle records what those events
 * mean in money, in four phases. An invoice or an approval can be a necessary step inside a method
 * without being a fifth phase.
 *
 * The phases are separate facts. A real-world event, the feeder-system entry, the approved
 * transaction and the DAI posting can all happen at different times: a physical receipt does not
 * prove the DAI receipt posted, and a vendor payment does not prove it matched the intended award.
 */

export const PHASES = ['commitment', 'obligation', 'delivered', 'paid'] as const;
export type Phase = (typeof PHASES)[number];

export interface PhaseInfo {
  key: Phase;
  label: string;
  meaning: string;
  /** How the book says DAI represents the phase. */
  dai: string;
  /** The book's illustrative general-ledger account. Not a posting specification. */
  gl: { account: string; title: string };
  cite: Cite;
}

export const PHASE_INFO: Record<Phase, PhaseInfo> = {
  commitment: {
    key: 'commitment', label: 'Commitment', meaning: 'A firm administrative reservation of funds.',
    dai: 'Requisition', gl: { account: '4700', title: 'Commitment' }, cite: cite('2.1', '7-10, 59-63'),
  },
  obligation: {
    key: 'obligation', label: 'Obligation', meaning: 'A legally binding agreement between parties.',
    dai: 'Award', gl: { account: '4801', title: 'Undelivered Order, Unpaid' }, cite: cite('2.1', '7-10, 59-63'),
  },
  delivered: {
    key: 'delivered', label: 'Delivered', meaning: 'Goods or services received. How acceptance is recorded depends on the method.',
    dai: 'Delivered transaction, or a receipt/accrual', gl: { account: '4901', title: 'Delivered Order, Unpaid' }, cite: cite('2.1', '7-10, 59-63'),
  },
  paid: {
    key: 'paid', label: 'Paid', meaning: 'Payment, or disbursement.',
    dai: 'Disbursement', gl: { account: '4902', title: 'Delivered Order, Paid' }, cite: cite('2.1', '7-10, 59-63'),
  },
};

export const GL_NOTE = 'These general-ledger accounts are the book’s illustrative phase mapping (orig. p. 63), not a complete posting or journal-entry specification.';

/** Where a transaction stands in accounting. */
export const ACCOUNTING_STATUSES = [
  {
    key: 'pending', label: 'Pending',
    meaning: 'The commitment and/or obligation is not yet reflected in accounting.',
    practice: 'The fiscal clerk tracks it in a pending file until it posts.',
  },
  {
    key: 'posted', label: 'Posted',
    meaning: 'The commitment and/or obligation is reflected in accounting.',
    practice: 'Check the actual document and amount. Later phases may still be incomplete.',
  },
  {
    key: 'completed', label: 'Completed',
    meaning: 'Accounting reflects the applicable lifecycle through paid.',
    practice: 'Compare the completed record with its supporting documents.',
  },
] as const;

export const PENDING_FILE = {
  meaning: 'A manual, internal record of activity not yet reflected in accounting. It bridges the gap until the system shows the transaction.',
  rule: 'Update the pending file when the transaction posts, so the same requirement is never counted twice.',
  cite: cite('2.3', '27-32'),
};

/**
 * True available balance: what is left after valid execution, including pending transactions the
 * displayed balance does not yet show.
 *
 * The book describes subtracting pending and posted activity from budget authority. The rewrite
 * adds the rule that makes that safe: use non-overlapping balances. A purchase that has reached
 * obligation is not subtracted again for its commitment, delivery and payment, and a pending item
 * is subtracted only until it posts.
 */
export function trueAvailableBalance(input: {
  /** The balance the accounting system currently displays, in cents. */
  displayedAvailableCents: number;
  /** Valid transactions still pending and NOT already reflected in the displayed balance. */
  pendingNotReflected: Array<{ label: string; cents: number; posted?: boolean }>;
}): { adjustedCents: number; subtracted: Array<{ label: string; cents: number }>; ignored: Array<{ label: string; reason: string }> } {
  const subtracted: Array<{ label: string; cents: number }> = [];
  const ignored: Array<{ label: string; reason: string }> = [];
  let adjusted = BigInt(input.displayedAvailableCents);
  for (const p of input.pendingNotReflected) {
    if (p.posted) { ignored.push({ label: p.label, reason: 'Already posted, so the displayed balance includes it. Deducting it again would count it twice.' }); continue; }
    if (!Number.isSafeInteger(p.cents) || p.cents < 0) { ignored.push({ label: p.label, reason: 'Not a whole, positive amount of cents.' }); continue; }
    adjusted -= BigInt(p.cents);
    subtracted.push({ label: p.label, cents: p.cents });
  }
  return { adjustedCents: Number(adjusted), subtracted, ignored };
}

export const TRUE_AVAILABLE_EXAMPLE = {
  text: 'The displayed available balance is $1,000. A separate, valid $150 purchase is still pending and not included in that balance, so the adjusted view is $850. Once the $150 posts, it is not deducted again from the updated system balance.',
  cite: cite('2.3', '27-32', 'editorial'),
};

/** The book's simplified budget sequence. Classroom timing labels, not guaranteed enactment dates. */
export const BUDGET_SEQUENCE = [
  { step: 'Federal agencies submit budget requests to the Office of Management and Budget (OMB).', timing: 'Before January' },
  { step: 'OMB consolidates the requests for presidential review.', timing: 'January' },
  { step: 'The President submits a budget proposal to Congress.', timing: 'February' },
  { step: 'The House and Senate consider budget resolutions and legislation.', timing: 'February–September' },
  { step: 'Authorization legislation addresses policy and programs; separate appropriations legislation supplies funding authority.', timing: 'September' },
  { step: 'Enacted funding is distributed through DoD, the Department of the Navy, and the Marine Corps.', timing: null },
  { step: 'Marine Corps funding flows through the HQMC / MARFOR / MEF / MSC model.', timing: null },
] as const;

export const BUDGET_NOTES = [
  { text: 'Budget authority is the legal authority to incur obligations and make payments. Resources have defined purposes and limits ("pots of money"): a requirement must be tied to the appropriate funding category before execution.', cite: cite('2.2', '53-54') },
  { text: 'The diagram presents a continuing resolution as the alternative when funding is not enacted before 1 October. That statement is incomplete: it does not itself establish interim funding authority.', cite: cite('2.2', '54', 'discrepancy') },
  { text: 'Page 53 labels "use it or lose it" as zero-based budgeting. Keep the concern about execution and future planning, but not that sentence as a definition of zero-based budgeting, and never as authority to spend merely to exhaust a balance.', cite: cite('2.2', '53', 'discrepancy') },
] as const;

export const FUNDING_LEVELS = [
  { level: 'L1', organization: 'HQMC' },
  { level: 'L2', organization: 'MARFOR' },
  { level: 'L3', organization: 'MEF' },
  { level: 'L4', organization: 'MSC' },
] as const;

/** DAI, the enterprise financial system the book describes. */
export const DAI = {
  name: 'Defense Agencies Initiative (DAI)',
  summary: 'The enterprise financial system that integrates budget reporting, procurement, accounting and source-document information. The Marine Corps moved to it from its legacy accounting system on 1 October 2021; that date does not mean every feeder transaction posts instantly.',
  modules: [
    { key: 'P2P', name: 'Procure to Pay', does: 'Requisitions, purchasing, receiving and payments.' },
    { key: 'O2C', name: 'Order to Cash', does: 'Incoming orders, billing, collections and reimbursements.' },
    { key: 'CA', name: 'Cost Accounting', does: 'Project budgeting and cost tracking.' },
    { key: 'B2R', name: 'Budget to Report', does: 'Appropriations, apportionments, allotments, sub-allotments, and budget execution and funds passes.' },
  ],
  reporting: [
    { level: 'Transaction level', does: 'Follows individual records.' },
    { level: 'Program level', does: 'Consolidates activity against projects and programs.' },
    { level: 'GL level', does: 'The accounting view; the General Ledger consolidates accounting transactions.' },
  ],
  cite: cite('4.1', '59-64'),
} as const;

/** Business feeder systems: where each method's data originates and how it posts. */
export const FEEDERS = [
  { method: 'servmart', source: 'ServMart point of sale (PoS)', tool: 'ServMart card', posting: 'Usually a daily transmission. Block III shows award and delivered arriving through the GSA Alias Table mapping.' },
  { method: 'fuel', source: 'Enterprise Point of Sale (EPoS)', tool: 'Fuel key (VIL) or QR code', posting: 'Usually a daily transmission. The Fuel Key Alias Table connects the fuel identifier to DAI.' },
  { method: 'gcss', source: 'Global Combat Support System–Marine Corps (GCSS-MC)', tool: 'Approved system request', posting: 'Batch transactions from logistics activity.' },
  { method: 'tdy', source: 'Defense Travel System (DTS)', tool: 'Travel authorization and voucher', posting: 'Batch interfaces after approvals.' },
  { method: 'mipr', source: 'DAI iProcurement IGT/MIPR/IA Store', tool: 'DD 448, acceptance, and the DAI award', posting: 'Manual DAI entry and approval, described as real time.' },
  { method: 'contract', source: 'DAI iProcurement PRDS Store, SPS, WAWF', tool: 'Awarded contract', posting: 'Commitment in real time; later interfaces and batches.' },
  { method: 'gpc', source: 'DAI iProcurement GPC Store, US Bank', tool: 'Government Purchase Card', posting: 'Commitment in real time; award, delivered and payment through later interfaces.' },
] as const;

export const FEEDER_NOTES = [
  { text: 'A Business Feeder System (BFS) captures operational activity and sends financial data into accounting. Some of the book’s "BFS" lists include DAI’s own iProcurement stores; those are internal DAI entry points, not external systems.', cite: cite('2.4', '27-32') },
  { text: 'Global Exchange (GEX) is the middleware that routes and translates financial data between feeder systems and DAI.', cite: cite('5.2', '65-68') },
] as const;
