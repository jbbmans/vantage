import { cite } from './source.ts';

/**
 * People, billets, system responsibilities and authority (FMRAC ch. 1.3-1.4, 4, 12.3).
 *
 * Four facts that look alike and must be kept apart, by a person and by any tool:
 *
 *   billet        organizational work a person is assigned to do;
 *   MOS           an occupational field;
 *   DAI responsibility  a system capability;
 *   appointment / delegation  an individual's actual authority.
 *
 * A job title does not establish every permission a transaction needs, possessing a system role
 * does not prove an appointment, and research access never confers permission to create an award,
 * a receipt or a payment correction.
 */

export const AUTHORITY_FACTS = [
  { key: 'billet', label: 'Billet', meaning: 'Organizational work a person is assigned.' },
  { key: 'mos', label: 'MOS', meaning: 'Occupational field. Associated with billets, not a grant of authority.' },
  { key: 'responsibility', label: 'DAI responsibility', meaning: 'A system capability: what the system will let the account do.' },
  { key: 'appointment', label: 'Appointment or delegation', meaning: 'The individual’s authority, established by the commander or a delegation.' },
] as const;

export const PROCUREMENT_PEOPLE = [
  { who: 'End user', does: 'Identifies a mission requirement, communicates it to the CRO or supply section, and confirms the goods or services were received.' },
  { who: 'Commodity Responsible Officer (CRO)', does: 'Validates requirements for a commodity area; coordinates supply, inventory, budgets, vendors and supporting units. No single MOS is tied to this billet.' },
  { who: 'Supply Officer, 3002', does: 'Oversees supply and property operations, inventory, procurement, storage and disposal, and accountability; advises the commander on supply and fiscal status.' },
  { who: 'Supply Chief, 3043', does: 'Supervises daily supply operations, distribution, and accountability for property and funds. Specific authority still depends on appointment.' },
  { who: 'Fiscal Clerk, 3043', does: 'Processes purchase requests, safeguards purchasing tools, maintains financial tracking, and connects CROs with the supply section.' },
  { who: 'Administrative Supply Marine, 3043', does: 'Maintains supply documentation, tracks movement of supplies and equipment, and supports accountability and reporting.' },
  { who: 'Supply Warehouse Marine, 3051', does: 'Receives, inspects, stores, issues and ships materiel; maintains inventory; handles hazardous materiel and material-handling equipment.' },
  { who: 'FMRA, 3451', does: 'Analyzes execution, reconciles financial records, researches causes, and resolves accounting errors within assigned responsibilities.' },
] as const;

export const COMPTROLLER_GROUPS = [
  { title: 'Financial Management Officer', mos: '3404 (2ndLt–LtCol); 8041 (3404D) at Colonel', focus: 'Budget formulation and execution.' },
  { title: 'Financial Management Resource Officer (FMRO)', mos: '3408 (WO–CWO5)', focus: 'Technical financial-system and reporting expertise; leads the accounting branch.' },
  { title: 'Financial Management Resource Analyst (FMRA)', mos: '3451 (Pvt–MGySgt)', focus: 'Execution analysis and error resolution. Billet progression: FMRA, Accounting Chief, Comptroller Chief.' },
] as const;

export const COMPTROLLER_OFFICE = {
  mission: 'Secure and manage resources for combat-ready forces while maintaining effective controls and accurate accounting.',
  executive: ['AC/S Comptroller', 'Deputy Comptroller', 'Comptroller Chief'],
  branches: [
    { name: 'Risk Management and Audit', members: [] as string[] },
    { name: 'Budget', members: ['Budget officers', 'Exercise officers'] },
    { name: 'Accounting', members: ['FMRO', 'Accounting Chief', 'FMRAs'] },
  ],
  accountingWork: [
    'Maintaining, monitoring, reconciling and preparing financial records',
    'Causative research',
    'Root-cause and trend analysis',
    'Supporting budget formulation',
    'Identifying potential fraud, waste or abuse',
  ],
  staffingNote: 'The book shows an FMRO and Accounting Chief above either three NCO-led teams of two FMRAs, or two NCO-led teams of three. These show flexible workload organization, not required manning.',
  cite: cite('1.4', '55-58'),
};

export interface Responsibility {
  key: string;
  name: string;
  capability: string;
  typical: string;
  /** Changes a financial record, as opposed to reading one. */
  writes: boolean;
  note?: string;
}

/** The book's role labels and typical users. Not a determination of any individual's access. */
export const DAI_RESPONSIBILITIES: Responsibility[] = [
  { key: 'p2p_inquiry', name: 'P2P Inquiry', capability: 'View and research P2P records without updating them.', typical: 'Personnel involved in procurement', writes: false },
  { key: 'p2p_procurement_analyst', name: 'P2P Procurement Analyst', capability: 'Create and modify award (obligation) documents.', typical: 'FMRA, 3451', writes: true },
  { key: 'iproc_requisitions', name: 'iProcurement Requisitions', capability: 'Enter, maintain and amend requisitions, including PRs, MIPRs and IAAs.', typical: 'Supply Fiscal Clerk, 3043', writes: true },
  { key: 'iproc_requisitions_approver', name: 'iProcurement Requisitions Approver', capability: 'Approve requisitions. P. 61 duplicates the preparer description; the workflow pages show approval as a separate step.', typical: 'Listed as Supply Fiscal Clerk; workflows route approval to the Supply Officer', writes: true, note: 'Verify the actual responsibility and delegation before assigning approval.' },
  { key: 'p2p_procurement_officer', name: 'P2P Procurement Officer', capability: 'Enter, maintain and modify awards; process MIPR acknowledgements.', typical: 'Supply Fiscal Chief, 3043', writes: true },
  { key: 'p2p_receipts', name: 'P2P Receipts', capability: 'Create manual receipts and accruals, find receipts, and process returns.', typical: 'Supply Warehouse / Fiscal Clerk, 3051 or 3043', writes: true },
  { key: 'p2p_mipr_ack', name: 'P2P MIPR Acknowledgement', capability: 'Record, track and alter MIPR/IAA acceptance or acknowledgement.', typical: 'Supply Fiscal Chief, 3043', writes: true },
  { key: 'p2p_unmatched_tbo', name: 'P2P Unmatched TBO Manager', capability: 'Enter manual invoices, clear unmatched disbursements and credit memos, and void erroneous postings.', typical: 'FMRA, 3451', writes: true },
  { key: 'p2p_dts_axol', name: 'P2P DTS AXOL Procurement Officer', capability: 'Work with award headers, lines, schedules and pay items; modify PCS and DTS awards.', typical: 'FMRO, 3408', writes: true },
  { key: 'p2p_maintenance', name: 'P2P Maintenance', capability: 'Maintain the procurement buyers associated with award processing.', typical: 'Accounting Chief, 3451', writes: true },
  { key: 'p2p_supplier_maintenance', name: 'P2P Supplier Maintenance', capability: 'Maintain supplier and vendor information needed by awards, invoices and payments.', typical: 'L1, HQMC', writes: true },
  { key: 'umx', name: 'UMX (User Management)', capability: 'Assign and maintain account approvers and process-area responsibility approvers.', typical: 'FMRO, 3408', writes: true },
];

export const SPECIAL_ROLES = [
  {
    key: 'certifier', name: 'Certifier',
    meaning: 'Performs funds certification on PR approval and approves a CLM award so the transaction can post. A funds manager — Supply Officer, Supply Chief or department head — appointed by the commanding officer.',
    rule: 'Do not infer an appointment from possession of a system role.',
  },
  {
    key: 'proxy', name: 'Proxy',
    meaning: 'A temporary, delegated assignment covering an unavailable member for a set period. Typical users: Supply Fiscal Chiefs and Fiscal Clerks.',
    rule: 'Record the assignment and its effective dates. A proxy is not a permanent transfer of all authority.',
  },
] as const;

export const SEPARATION_OF_DUTIES = {
  definition: 'Separation (or segregation) of duties prevents one person from controlling the authorization, processing and review of an entire transaction.',
  access: 'Access is requested through the Access Request Management Service (ARMS) and a System Authorization Access Request (SAAR).',
  rules: [
    'Attach each task to the action and responsibility it needs, then check the individual has both the system access and the applicable authority.',
    'If not, assign the research separately and route the authoritative transaction to a qualified person.',
    'Research access does not confer permission to create an award, a receipt, or a payment correction.',
    'Assign a transaction step to someone with the needed responsibility and authority, and approval separately where required.',
    'A system role can permit an action technically while the person’s delegation or scope still limits its use.',
  ],
  cite: cite('4.2', '59-64'),
};

/** The fields a useful role record keeps (ch. 12.3, editorial). */
export const ROLE_RECORD_FIELDS = [
  'System', 'Exact responsibility', 'Individual', 'Organizational scope', 'Effective dates', 'Whether access is confirmed', 'Appointment or proxy limitations',
] as const;

/** Who typically performs each kind of correction work, by the responsibility it needs. */
export const WORK_RESPONSIBILITY = {
  research: ['p2p_inquiry'],
  award: ['p2p_procurement_analyst', 'p2p_procurement_officer'],
  requisition: ['iproc_requisitions'],
  approval: ['iproc_requisitions_approver'],
  receipt: ['p2p_receipts'],
  mipr_ack: ['p2p_mipr_ack'],
  unmatched: ['p2p_unmatched_tbo'],
  dts_award: ['p2p_dts_axol'],
} as const;
export type WorkResponsibility = keyof typeof WORK_RESPONSIBILITY;

export const responsibilityName = (key: string) => DAI_RESPONSIBILITIES.find((r) => r.key === key)?.name || key;
