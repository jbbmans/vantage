/**
 * FMRA domain catalog.
 *
 * This is the controlled vocabulary that lets Vantage talk about the work a person is
 * authorized or trained to perform in DAI and adjacent systems. It is deliberately separate
 * from Vantage application roles and permissions: being an SNCO in Vantage does not grant
 * Procurement Analyst access in DAI.
 *
 * Sources: FMRAC study guide, G-Invoicing handbook, and the current SME walkthrough. The
 * walkthrough-derived procedure is labelled as such wherever it is used.
 */

export type FMRAResponsibilityStatus = 'assigned' | 'training' | 'not_assigned';

export interface FMRASystem {
  key: string;
  name: string;
  purpose: string;
  category: 'financial' | 'reporting' | 'procurement' | 'supply' | 'interface' | 'invoicing';
}

export interface FMRAResponsibility {
  key: string;
  system: string;
  name: string;
  summary: string;
  can: string[];
  mustNot: string[];
  evidence: string[];
  relatedProcedures?: string[];
}

export interface FMRAAssignment {
  perform?: string[];
  approve?: string[];
  verify?: string[];
}

export interface FMRAProfileEntry {
  key: string;
  status: FMRAResponsibilityStatus;
  verified?: boolean;
  note?: string;
}

export const FMRA_SYSTEMS: FMRASystem[] = [
  { key: 'dai', name: 'DAI', purpose: 'Enterprise financial management, procurement, commitments, obligations, receipts, invoices, and unmatched transaction research.', category: 'financial' },
  { key: 'obiee_oas', name: 'OBIEE / OAS', purpose: 'Enterprise reporting and financial transaction analysis.', category: 'reporting' },
  { key: 'advana', name: 'Advana', purpose: 'Data analytics, dashboards, and cross-system financial analysis.', category: 'reporting' },
  { key: 'gcss_mc', name: 'GCSS-MC', purpose: 'Marine Corps logistics and financial feeder-system transactions.', category: 'supply' },
  { key: 'dts', name: 'DTS', purpose: 'Defense Travel System document and financial transaction work.', category: 'financial' },
  { key: 'servmart', name: 'ServMart / US Bank', purpose: 'Government purchase-card and catalog purchasing support.', category: 'procurement' },
  { key: 'supply', name: 'Supply / FOM', purpose: 'Supply-side ordering, receipt, and fiscal coordination.', category: 'supply' },
  { key: 'interfaces', name: 'Interfaces / BFS', purpose: 'Business Feeder Systems and interface error monitoring.', category: 'interface' },
  { key: 'wawf_vlips', name: 'WAWF / WebVLIPS', purpose: 'Invoice acceptance and payment-support evidence.', category: 'invoicing' },
  { key: 'g_invoicing', name: 'G-Invoicing', purpose: 'GT&C, order, performance, and settlement for reimbursable transactions.', category: 'invoicing' },
  { key: 'dfas', name: 'DFAS', purpose: 'Accounting settlement, 1081 transfers, and payment-side resolution.', category: 'financial' },
];

export const FMRA_RESPONSIBILITIES: FMRAResponsibility[] = [
  {
    key: 'dai_p2p_inquiry',
    system: 'dai',
    name: 'DAI P2P Inquiry',
    summary: 'Research requisitions, awards, purchase orders, invoices, payment status, and transaction history without changing the source record.',
    can: ['Search awards and invoices', 'Read requisition funding and remaining balance', 'Capture POET, SLOA, document, invoice, and period-of-performance identifiers', 'Provide the evidence needed for an exception decision'],
    mustNot: ['Treat inquiry access as authorization to amend, approve, receive, or certify', 'Declare a transaction paid solely because an invoice exists'],
    evidence: ['Award and invoice identifiers', 'Requisition and POET/SLOA values', 'Screenshots or exported report references when permitted'],
    relatedProcedures: ['umt_2way_po_qty'],
  },
  {
    key: 'dai_p2p_procurement_analyst',
    system: 'dai',
    name: 'DAI P2P Procurement Analyst',
    summary: 'Work the procurement-side transaction: review the award, perform a funds check, and prepare or submit an award modification when authorized.',
    can: ['Review procurement documents', 'Perform a funds check', 'Prepare a modification', 'Submit a modification into the approval/posting path'],
    mustNot: ['Bypass required approval', 'Use a modification to conceal a funding or quantity mismatch', 'Assume submission equals posting or obligation'],
    evidence: ['Modification number', 'Funds-check result', 'Submission and posting status', 'Before/after award values'],
    relatedProcedures: ['umt_2way_po_qty'],
  },
  {
    key: 'dai_umt_tbo_manager',
    system: 'dai',
    name: 'DAI UMT / TBO Manager',
    summary: 'Research, triage, and control unmatched transactions and other procurement-to-payment exceptions.',
    can: ['Identify UMT type and source', 'Coordinate requisition, award, invoice, and posting research', 'Track ULO/UDOU, DOU, OTO, and invoice-hold follow-up', 'Verify that the original exception cleared'],
    mustNot: ['Close an exception without a recorded verification', 'Guess at an exception when the source document is incomplete'],
    evidence: ['Exception reference', 'KSD and research trail', 'Correction decision', 'Clearance verification'],
    relatedProcedures: ['umt_2way_po_qty'],
  },
  {
    key: 'dai_p2p_requisitions',
    system: 'dai',
    name: 'DAI Requisitions',
    summary: 'Create or amend requisitions and confirm that the revised funding is approved and posted.',
    can: ['Review funds remaining', 'Amend an authorized requisition', 'Track approval and posting', 'Confirm the revised requisition supports the intended award'],
    mustNot: ['Amend without preserving the original requirement', 'Treat a submitted amendment as effective before posting'],
    evidence: ['Requisition number', 'Old/new amount or quantity', 'Approval and posting status'],
    relatedProcedures: ['umt_2way_po_qty'],
  },
  {
    key: 'dai_requisitions_approver',
    system: 'dai',
    name: 'DAI Requisitions Approver',
    summary: 'Review requisition changes for requirement, funding, and authorization before approval.',
    can: ['Review the business purpose and funding support', 'Approve or return a requisition change', 'Document the reason for a return'],
    mustNot: ['Approve without sufficient supporting evidence', 'Approve work outside the delegated authority'],
    evidence: ['Approval or return action', 'Approver identity', 'Supporting document references'],
    relatedProcedures: ['umt_2way_po_qty'],
  },
  {
    key: 'dai_p2p_procurement_officer',
    system: 'dai',
    name: 'DAI P2P Procurement Officer',
    summary: 'Perform or oversee procurement actions that require an authorized procurement official.',
    can: ['Review procurement integrity and supporting documentation', 'Approve or execute delegated procurement actions', 'Coordinate with contracting and finance'],
    mustNot: ['Substitute a local title for delegated system authorization', 'Backdate or bypass approvals'],
    evidence: ['Delegation or authority reference', 'Procurement action record', 'Approval trail'],
  },
  {
    key: 'dai_p2p_receipts',
    system: 'dai',
    name: 'DAI P2P Receipts',
    summary: 'Record or validate receipt/performance so the delivered stage is supported.',
    can: ['Record receipt when authorized', 'Review quantity and acceptance evidence', 'Coordinate with WAWF or receiving activity'],
    mustNot: ['Record receipt without evidence of delivery or acceptance', 'Confuse receipt with invoice payment'],
    evidence: ['Receipt or acceptance record', 'Delivery/acceptance date', 'Quantity and receiving reference'],
  },
  {
    key: 'dai_mipr_acknowledgement',
    system: 'dai',
    name: 'DAI MIPR Acknowledgement',
    summary: 'Acknowledge and track Military Interdepartmental Purchase Requests and related funding actions.',
    can: ['Review MIPR identifiers and funding', 'Record acknowledgement when delegated', 'Track acceptance and downstream obligation'],
    mustNot: ['Treat acknowledgement as an obligation', 'Close a MIPR while downstream work remains open'],
    evidence: ['MIPR number', 'Acknowledgement date/status', 'Funding and order references'],
  },
  {
    key: 'dai_dts_axol_procurement_officer',
    system: 'dts',
    name: 'DTS AXOL Procurement Officer',
    summary: 'Perform authorized procurement actions and oversight in DTS AXOL.',
    can: ['Review DTS procurement documents', 'Perform delegated procurement review', 'Coordinate document correction'],
    mustNot: ['Approve outside delegation', 'Assume DTS approval means payment'],
    evidence: ['DTS document number', 'Approval status', 'Correction or acceptance note'],
  },
  {
    key: 'dai_analyst_approver',
    system: 'dai',
    name: 'DAI Analyst / Funds Certifier',
    summary: 'Review the financial sufficiency and approval path for a transaction.',
    can: ['Review fund availability and accounting strings', 'Certify or approve within delegation', 'Return unsupported requests'],
    mustNot: ['Certify based on an invoice alone', 'Treat an available balance as proof of obligation'],
    evidence: ['Accounting string', 'Funds check', 'Certification/approval action'],
    relatedProcedures: ['umt_2way_po_qty'],
  },
  {
    key: 'obiee_oas_reporting',
    system: 'obiee_oas',
    name: 'OBIEE / OAS Reporting Analyst',
    summary: 'Build and interpret authoritative reports for commitments, obligations, delivered, paid, and exception monitoring.',
    can: ['Run and filter reports', 'Reconcile report totals to source systems', 'Identify aging and outlier transactions'],
    mustNot: ['Edit the source transaction from a report', 'Present a report total without its period, filters, and source'],
    evidence: ['Report name/version', 'Run date', 'Filters and period', 'Export reference'],
  },
  {
    key: 'advana_reporting',
    system: 'advana',
    name: 'Advana Financial Reporting Analyst',
    summary: 'Use Advana dashboards and data products for cross-system trend, aging, and exception analysis.',
    can: ['Analyze trends and aging', 'Cross-check DAI and feeder-system data', 'Surface data quality issues'],
    mustNot: ['Assume a dashboard is real-time without checking refresh metadata', 'Replace source-system evidence with an unqualified chart'],
    evidence: ['Dashboard/data product', 'Refresh date', 'Filter scope', 'Source reconciliation note'],
  },
  {
    key: 'gcss_mc_fom',
    system: 'gcss_mc',
    name: 'GCSS-MC FOM / Feeder Analyst',
    summary: 'Research the feeder-side event that should create or support a financial transaction.',
    can: ['Research order, issue, receipt, and feeder status', 'Identify interface source data', 'Coordinate correction with finance and supply'],
    mustNot: ['Assume the feeder event alone proves DAI posting', 'Change source data without the responsible process owner'],
    evidence: ['Feeder document', 'Event/status', 'Interface reference', 'Correction owner'],
  },
  {
    key: 'dts_fdta',
    system: 'dts',
    name: 'DTS FDTA',
    summary: 'Review DTS financial transaction and accounting data within delegated authority.',
    can: ['Review DTS accounting and document status', 'Coordinate corrections', 'Provide audit support'],
    mustNot: ['Confuse authorization with payment', 'Close an issue without settlement evidence'],
    evidence: ['DTS document and accounting lines', 'Approval/payment status', 'Correction record'],
  },
  {
    key: 'servmart_alias_table',
    system: 'servmart',
    name: 'ServMart Alias Table Manager',
    summary: 'Maintain or coordinate alias-table data that supports catalog and purchase-card transactions.',
    can: ['Review alias mappings', 'Coordinate authorized updates', 'Document the business owner and effective date'],
    mustNot: ['Change a mapping without an owner and effective date', 'Use an alias table to override procurement controls'],
    evidence: ['Alias key/value', 'Owner approval', 'Effective date', 'Change record'],
  },
  {
    key: 'fuel_alias_table',
    system: 'gcss_mc',
    name: 'Fuel Alias Table Manager',
    summary: 'Maintain or coordinate fuel alias mappings used by the feeder process.',
    can: ['Review fuel mapping', 'Coordinate authorized corrections', 'Trace a transaction to the source location'],
    mustNot: ['Treat a mapping correction as a financial adjustment', 'Change source data without documenting impact'],
    evidence: ['Alias value', 'Source location', 'Owner approval', 'Impact note'],
  },
  {
    key: 'supply_fiscal_clerk',
    system: 'supply',
    name: 'Supply Fiscal Clerk',
    summary: 'Coordinate supply-side fiscal documents, receipts, and status with finance.',
    can: ['Assemble order and receipt evidence', 'Track supply-side corrections', 'Coordinate with FOM and fiscal'],
    mustNot: ['Certify funds without delegated authority', 'Declare an item paid from a receiving record'],
    evidence: ['Order/receipt record', 'Quantity/date', 'Coordination trail'],
  },
  {
    key: 'supply_officer',
    system: 'supply',
    name: 'Supply Officer',
    summary: 'Oversee supply processes and acceptance/receipt responsibilities within the unit.',
    can: ['Review supply requirement and receipt controls', 'Approve or delegate supply actions', 'Resolve supply-side ownership'],
    mustNot: ['Bypass fiscal or contracting controls', 'Approve outside delegated authority'],
    evidence: ['Delegation', 'Acceptance/receipt decision', 'Supporting supply record'],
  },
  {
    key: 'contracting_officer',
    system: 'dai',
    name: 'Contracting Officer',
    summary: 'Exercise delegated contracting authority over contract, order, and modification actions.',
    can: ['Review and execute delegated contract actions', 'Approve modifications within authority', 'Coordinate with finance and requiring activity'],
    mustNot: ['Exceed delegation', 'Use finance-system status as a substitute for contract authority'],
    evidence: ['Contract/order/modification', 'Delegation', 'Approval and effective status'],
    relatedProcedures: ['umt_2way_po_qty'],
  },
  {
    key: 'wawf_acceptor',
    system: 'wawf_vlips',
    name: 'WAWF / WebVLIPS Acceptor',
    summary: 'Accept or reject invoice/performance evidence in the authorized invoice system.',
    can: ['Review invoice and performance evidence', 'Accept or reject within authority', 'Record reason for rejection'],
    mustNot: ['Accept without performance evidence', 'Treat acceptance as payment'],
    evidence: ['Invoice number', 'Acceptance/rejection status', 'Acceptance date', 'Supporting receipt'],
  },
  {
    key: 'g_invoicing_agreement_manager',
    system: 'g_invoicing',
    name: 'G-Invoicing Agreement Manager',
    summary: 'Manage GT&C and order lifecycle records for reimbursable work.',
    can: ['Create/review GT&C and order records', 'Track performance and settlement', 'Coordinate Buyer/Seller responsibilities'],
    mustNot: ['Treat a GT&C as a commitment or obligation', 'Close a reimbursable project while the order or settlement remains open'],
    evidence: ['GT&C/7600A', 'Order/7600B', 'Performance record', 'Settlement status'],
  },
  {
    key: 'dfas_1081',
    system: 'dfas',
    name: 'DFAS 1081 / Interfund Analyst',
    summary: 'Coordinate 1081 or related accounting transfer documentation and settlement.',
    can: ['Review transfer documents', 'Coordinate correction and settlement', 'Trace the accounting impact'],
    mustNot: ['Use a 1081 to hide an unsupported obligation', 'Close without settlement evidence'],
    evidence: ['1081 number', 'Accounting lines', 'Settlement/correction status'],
  },
];

export const FMRA_PHASES = [
  { key: 'authority', name: 'Authority', description: 'The requirement is authorized and supported by the responsible official.' },
  { key: 'commitment', name: 'Commitment', description: 'Funds are reserved for the requirement.' },
  { key: 'obligation', name: 'Obligation', description: 'A binding order, contract, or agreement has been recorded.' },
  { key: 'delivered', name: 'Delivered', description: 'Goods or services were received and accepted.' },
  { key: 'paid', name: 'Paid', description: 'The settlement/payment event is complete and supported.' },
  { key: 'reconciliation', name: 'Reconciliation / exception', description: 'The record is being compared to source evidence or corrected.' },
] as const;

export const FMRA_KSD_CATALOG = [
  { method: 'purchase_card', name: 'Purchase card', request: 'Purchase request / authorization', order: 'Card transaction / order record', receipt: 'Receipt and acceptance', payment: 'Bank/statement settlement' },
  { method: 'servmart', name: 'ServMart', request: 'Requisition or catalog request', order: 'Purchase order', receipt: 'Receipt/acceptance', payment: 'Invoice/payment status' },
  { method: 'contract', name: 'Contract / order', request: 'Requirement and funding support', order: 'Award, PO, or modification', receipt: 'Acceptance/performance', payment: 'Invoice and settlement' },
  { method: 'g_invoicing', name: 'G-Invoicing', request: 'GT&C / 7600A', order: 'Order / 7600B', receipt: 'Performance record', payment: 'Settlement status' },
  { method: 'mipr_igt', name: 'MIPR / IGT', request: 'MIPR and funding document', order: 'Acknowledgement / order', receipt: 'Performance or acceptance', payment: 'Settlement/transfer evidence' },
  { method: 'fuel', name: 'Fuel / feeder transaction', request: 'Authorized requirement', order: 'Feeder order/issue', receipt: 'Issue/receipt record', payment: 'Interface and accounting status' },
] as const;

/**
 * Step-level responsibility routing. Perform means the person may do the step when locally
 * authorized; approve means the step requires that approval role; verify means the evidence
 * should be checked by that role. Local delegation and SOP still control.
 */
export const FMRA_STEP_ASSIGNMENTS: Record<string, Record<string, FMRAAssignment>> = {
  umt_2way_po_qty: {
    identify: { perform: ['dai_p2p_inquiry', 'dai_umt_tbo_manager'] },
    research_award: { perform: ['dai_p2p_inquiry', 'dai_p2p_procurement_analyst', 'dai_umt_tbo_manager'] },
    record_funding: { perform: ['dai_p2p_inquiry', 'dai_analyst_approver'] },
    calculate: { perform: ['dai_umt_tbo_manager', 'dai_p2p_procurement_analyst'] },
    funding_decision: { approve: ['dai_umt_tbo_manager', 'dai_analyst_approver'], verify: ['dai_p2p_inquiry'] },
    amend_requisition: { perform: ['dai_p2p_requisitions'], approve: ['dai_requisitions_approver', 'dai_analyst_approver'] },
    amendment_effective: { verify: ['dai_p2p_inquiry', 'dai_umt_tbo_manager'] },
    award_modification: { perform: ['dai_p2p_procurement_analyst', 'contracting_officer'], approve: ['dai_p2p_procurement_officer', 'contracting_officer'] },
    funds_check: { perform: ['dai_p2p_procurement_analyst', 'dai_analyst_approver'] },
    submit_modification: { perform: ['dai_p2p_procurement_analyst'], approve: ['dai_p2p_procurement_officer', 'contracting_officer'] },
    modification_posted: { verify: ['dai_p2p_inquiry', 'dai_umt_tbo_manager'] },
    verify_invoice: { perform: ['dai_p2p_inquiry', 'dai_umt_tbo_manager', 'wawf_acceptor'] },
    verify_cleared: { verify: ['dai_umt_tbo_manager', 'dai_p2p_inquiry'] },
    resolve: { approve: ['dai_umt_tbo_manager'] },
  },
};

export const responsibilityByKey = new Map(FMRA_RESPONSIBILITIES.map((r) => [r.key, r]));

export function fmraResponsibilitiesForStep(procedureKey: string | null | undefined, stepKey: string | null | undefined): FMRAAssignment {
  if (!procedureKey || !stepKey) return {};
  return FMRA_STEP_ASSIGNMENTS[procedureKey]?.[stepKey] || {};
}

export function fmraResponsibilityLabel(key: string): string {
  return responsibilityByKey.get(key)?.name || key;
}

export function profileStatus(entries: FMRAProfileEntry[] | undefined, key: string): FMRAResponsibilityStatus {
  return entries?.find((entry) => entry.key === key)?.status || 'not_assigned';
}

export function profileHasResponsibility(entries: FMRAProfileEntry[] | undefined, key: string, includeTraining = false): boolean {
  const status = profileStatus(entries, key);
  return status === 'assigned' || (includeTraining && status === 'training');
}
