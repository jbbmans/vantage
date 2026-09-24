import { cite, type Cite } from './source.ts';

/**
 * The seven purchase methods the FMRAC teaches, each integrated from the book's three teaching
 * blocks (operational routing, supporting documents and interfaces, and the FMRA/DAI view).
 *
 * The steps are the source process. The verification paragraph of each method is editorial
 * guidance the rewrite derived from that method's expected outputs, and is labelled that way.
 * Payment timing of "30-45 days after receipt or acceptance" (the ServMart diagram says business
 * days) is a classroom expectation, never a universal deadline or a reason to ignore an error in
 * the meantime.
 */

export const METHOD_KEYS = ['servmart', 'gcss', 'gpc', 'contract', 'fuel', 'tdy', 'mipr'] as const;
export type MethodKey = (typeof METHOD_KEYS)[number];

export interface MethodStep {
  text: string;
  /** Who acts, in the book's terms. */
  actor?: string;
  /** The record this step produces or relies on, when the book names one. */
  evidence?: string;
}

export interface MethodPhase { title: string; steps: MethodStep[] }

export interface KsdSet {
  /** Evidence of the request and the order. */
  request: string[];
  /** Evidence of receipt and acceptance. */
  receipt: string[];
  /** Evidence of payment. */
  payment: string[];
  note?: string;
}

export interface PurchaseMethod {
  key: MethodKey;
  name: string;
  short: string;
  use: string;
  systems: string[];
  tool: string;
  /** The accounting link that has to exist for the method's transactions to find their funding. */
  keyLink: string;
  identifier: { id: string; generator: string; owner: string };
  /** What this method adds to the shared POET setup. */
  setup: string;
  phases: MethodPhase[];
  /** Editorial: what a complete, reconciled case looks like. */
  verification: string;
  ksd: KsdSet;
  /** The distinction that most often goes wrong with this method. */
  critical?: string;
  /** What the book does not teach for this method. Recorded rather than filled in. */
  limits?: string[];
  discrepancies: Array<{ text: string; cite: Cite }>;
  cite: Cite;
}

const SHARED_SETUP: MethodStep = { text: 'Complete the shared POET setup: the fiscal year’s POET structure is loaded in DAI.', actor: 'Comptroller / L1' };

export const METHODS: Record<MethodKey, PurchaseMethod> = {
  servmart: {
    key: 'servmart', name: 'ServMart', short: 'ServMart',
    use: 'Authorized office supplies and common items from the government source.',
    systems: ['ServMart PoS', 'DAI'], tool: 'ServMart card',
    keyLink: 'ServMart JON mapped to a POET through the GSA Alias Table.',
    identifier: { id: 'ServMart JON', generator: 'GSA Alias Table load request', owner: 'HQMC (P&R), L1. The FMRA prepares and validates the request.' },
    setup: 'Card and GSA alias mapping.',
    phases: [
      { title: 'Establish the card and its mapping', steps: [
        SHARED_SETUP,
        { text: 'Supply completes a ServMart card request and sends it to the comptroller section.', actor: 'Supply' },
        { text: 'Comptroller validates the request. The FMRA prepares the GSA Alias Table load request.', actor: 'Comptroller / FMRA' },
        { text: 'L1, HQMC P&R, loads the mapping. The FMRA adds the POET/JON data to the card request and returns it to Supply.', actor: 'L1 / FMRA' },
        { text: 'Supply sends the completed request to ServMart. The store manager creates and issues the card.', actor: 'Supply / ServMart' },
        { text: 'The fiscal clerk secures the physical card in a controlled-access location.', actor: 'Fiscal clerk' },
      ] },
      { title: 'Requirement and approval', steps: [
        { text: 'The end user identifies the need. The CRO validates it and initiates the request with Supply.', actor: 'End user / CRO' },
        { text: 'The fiscal clerk validates the requirement, performs mandatory source screening, and selects ServMart.', actor: 'Fiscal clerk' },
        { text: 'The end user completes the ServMart purchase request or shopping list and gives it to the fiscal clerk.', actor: 'End user', evidence: 'Shopping list' },
        { text: 'The fiscal clerk routes the request to the Supply Officer, who validates, signs approval, and returns it.', actor: 'Supply Officer', evidence: 'Approved request' },
        { text: 'The fiscal clerk updates the pending file and notifies the end user. The end user signs the logbook; the fiscal clerk issues the card and the approved shopping list.', actor: 'Fiscal clerk', evidence: 'Logbook' },
      ] },
      { title: 'Purchase, receipt and posting', steps: [
        { text: 'The end user selects the items; ServMart scans the items and the card; the user receives the supplies and a receipt.', actor: 'End user', evidence: 'ServMart receipt' },
        { text: 'The PoS sends award and delivered transactions through the GSA Alias Table to DAI.', actor: 'ServMart PoS' },
        { text: 'The end user returns the card and the ServMart receipt to the fiscal clerk and completes the logbook.', actor: 'End user' },
        { text: 'The fiscal clerk updates the pending file, reconciles the DTR, and verifies the DAI transactions posted correctly.', actor: 'Fiscal clerk' },
      ] },
      { title: 'Payment', steps: [
        { text: 'The ServMart PoS notifies DFAS. DFAS pays and sends the disbursement to DAI.', actor: 'DFAS', evidence: 'Payment voucher, SF 1034' },
      ] },
    ],
    verification: 'Match the approved list and the actual receipt to the posted amount and accounting identity. Confirm the card came back, the receipt is retained, the expected DAI postings exist, and the disbursement eventually posts. If the receipt exists but accounting does not, investigate the alias/interface and the pending state.',
    ksd: { request: ['Approved request / signed shopping list', 'ServMart receipt'], receipt: ['ServMart receipt'], payment: ['DFAS payment voucher, SF 1034'] },
    discrepancies: [{ text: 'Block II (p. 39) labels the PoS transmission "commitment, obligation, and delivered"; Block III (pp. 70/79) labels it "award and delivered". Do not fabricate an extra manual requisition to reconcile the labels; verify the actual transaction set.', cite: cite('7.1', '39, 70, 79', 'discrepancy') }],
    cite: cite('7.1', '13, 20, 30, 35, 38-39, 70, 78-80'),
  },

  gcss: {
    key: 'gcss', name: 'GCSS-MC', short: 'GCSS-MC',
    use: 'Maintenance-related parts and equipment requisitioned through GCSS-MC.',
    systems: ['GCSS-MC', 'DAI'], tool: 'Approved system request',
    keyLink: 'CostJON mapped to the appropriate POET.',
    identifier: { id: 'Cost JON (CostJON)', generator: 'GCSS-MC JON Builder', owner: '3451 FMRA; the FDM role is used for system loading (p. 96).' },
    setup: 'CostJONs, approval groups and budget journals loaded in GCSS-MC.',
    phases: [
      { title: 'Pre-execution', steps: [
        SHARED_SETUP,
        { text: 'The FMRA uses the GCSS-MC JON Builder to create CostJON structures for maintenance POETs.', actor: 'FMRA' },
        { text: 'Using the FDM role, the FMRA loads CostJONs, approval groups, and budget journals into GCSS-MC.', actor: 'FMRA (FDM)' },
      ] },
      { title: 'Requirement and award', steps: [
        { text: 'The end user identifies a requirement. The CRO validates it and routes it to Supply.', actor: 'End user / CRO' },
        { text: 'The fiscal clerk validates, screens sources, and selects GCSS-MC.', actor: 'Fiscal clerk' },
        { text: 'The end user or Supply Administrator initiates the system request and routes it to the Supply Officer. The fiscal clerk updates the pending file.', actor: 'End user / Supply Administrator' },
        { text: 'The Supply Officer validates and approves the request.', actor: 'Supply Officer', evidence: 'GCSS-MC approved-status print screen' },
        { text: 'The request goes to the SMU. GCSS-MC checks inventory; if the items are not on hand, the request goes to an external Source of Supply (SoS).', actor: 'SMU / GCSS-MC' },
        { text: 'GCSS-MC sends the award transaction to DAI. Block III also shows a certifier approval before posting. The fiscal clerk updates the pending file as the accounting status changes.', actor: 'GCSS-MC / Certifier' },
      ] },
      { title: 'Delivery and payment', steps: [
        { text: 'The external SoS ships the items to the supply warehouse.', actor: 'Source of Supply' },
        { text: 'The warehouse accepts the physical items and records receipt in GCSS-MC, which sends the delivered transaction to DAI.', actor: 'Warehouse' },
        { text: 'The warehouse notifies the end user, obtains the signed DD 1348-1A, and issues the items.', actor: 'Warehouse', evidence: 'DD 1348-1A' },
        { text: 'GCSS-MC notifies DFAS for payment. DFAS pays and sends the disbursement for DAI posting.', actor: 'DFAS', evidence: 'Payment voucher, SF 1034' },
      ] },
    ],
    verification: 'Match the approved requisition, warehouse receipt, DD 1348-1A, and the DAI award, delivered and payment. A shipped item is not automatically a recorded receipt, and an award waiting on a valid back-order is not automatically erroneous.',
    ksd: { request: ['GCSS-MC approved-status print screen'], receipt: ['DD 1348-1A'], payment: ['DFAS payment voucher, SF 1034'] },
    limits: ['If the SMU has the items on hand, the book says a separate process applies and does not teach it. Record that branch as outside the described workflow rather than substituting the external-source steps.'],
    discrepancies: [
      { text: 'Block II (p. 40) shows commitment plus obligation transmission; Block III emphasizes the award transaction. Keep the operational order and inspect the actual postings rather than assuming a separate DAI commitment always exists.', cite: cite('7.2', '40, 71, 96', 'discrepancy') },
      { text: 'The OCR of p. 71 reads "FOM"; the diagram on p. 96 supports FDM.', cite: cite('7.2', '71, 96', 'discrepancy') },
    ],
    cite: cite('7.2', '14, 21, 30, 35, 40-41, 71, 96-98'),
  },

  gpc: {
    key: 'gpc', name: 'Government Purchase Card (GPC)', short: 'GPC',
    use: 'Authorized purchases through the card process, after source screening and threshold review.',
    systems: ['DAI iProcurement GPC Store', 'US Bank'], tool: 'Government Purchase Card',
    keyLink: 'DAI POET, loaded from the FCCCB POET Load Sheet.',
    identifier: { id: 'DAI POET', generator: 'FCCCB POET Load Sheet', owner: 'HQMC (P&R), L1' },
    setup: 'Shared POET setup only.',
    critical: 'The merchant is paid through the card transaction. The later DFAS payment settles the Marine Corps’ obligation to US Bank. Do not close a case merely because the merchant was paid.',
    phases: [
      { title: 'Request and commitment', steps: [
        SHARED_SETUP,
        { text: 'The end user identifies the requirement; the CRO validates it and routes it to Supply.', actor: 'End user / CRO' },
        { text: 'The fiscal clerk validates the requirement, performs source screening, and decides whether GPC is appropriate.', actor: 'Fiscal clerk' },
        { text: 'The end user completes the local Open Purchase Request (OPR) and submits it to the fiscal clerk.', actor: 'End user', evidence: 'Local OPR' },
        { text: 'The fiscal clerk routes the OPR to the Supply Officer, who approves and returns it.', actor: 'Supply Officer' },
        { text: 'The fiscal clerk enters the requisition in the iProcurement GPC Store and routes it for approval.', actor: 'Fiscal clerk' },
        { text: 'The Supply Officer validates and approves the requisition; the commitment is recorded in DAI.', actor: 'Supply Officer', evidence: 'Approved Universal Purchase Request' },
      ] },
      { title: 'Purchase and evidence', steps: [
        { text: 'The fiscal clerk or cardholder receives notice of approval. The cardholder buys from the commercial vendor and obtains the receipt.', actor: 'Cardholder' },
        { text: 'The fiscal clerk and/or cardholder verifies that the DAI requisition amount matches the actual purchase.', actor: 'Fiscal clerk / Cardholder' },
        { text: 'The vendor provides the goods or services. The designated receiver confirms receipt and signs the receiving record.', actor: 'Designated receiver', evidence: 'Signed itemized vendor receipt' },
        { text: 'Supply receives the supporting documentation. The fiscal clerk updates the pending file and monitors US Bank activity.', actor: 'Fiscal clerk' },
      ] },
      { title: 'Bank matching, certification and posting', steps: [
        { text: 'The purchase appears in US Bank. The cardholder matches it to the requisition/document number imported from DAI.', actor: 'Cardholder' },
        { text: 'The cardholder routes the monthly certification statement to the Approving Official / Supply Officer.', actor: 'Cardholder' },
        { text: 'The Approving Official verifies each transaction links to the correct requisition and the dollar amounts match, then certifies the monthly statement.', actor: 'Approving Official', evidence: 'Certified US Bank statement' },
        { text: 'US Bank sends award and delivered transactions to DAI. Verify the interface and posting.', actor: 'US Bank' },
        { text: 'US Bank notifies DFAS. DFAS pays the bank, generates payment support, and sends the disbursement to DAI.', actor: 'DFAS', evidence: 'Paid/certified voucher or accounting print screen' },
      ] },
    ],
    verification: 'Connect the OPR, the approved DAI requisition, the signed itemized vendor receipt, the bank transaction, the certified statement, and the accounting payment. The bank-matching and settlement path remains part of the financial record after the merchant is paid.',
    ksd: { request: ['Local OPR', 'Approved Universal Purchase Request', 'US Bank statement'], receipt: ['Signed itemized vendor receipt', 'Receiving report / DD 250 (shown in diagrams)'], payment: ['Paid/certified voucher or accounting print screen', 'Certified US Bank statement'] },
    discrepancies: [
      { text: 'The narrative names the end user as receiver; the chart names the cardholder (pp. 72, 94). Keep the locally designated receiver in the record.', cite: cite('7.3', '72, 94', 'discrepancy') },
      { text: 'The book sometimes labels requisition entry with an "Approver" responsibility while describing the fiscal clerk’s action. Entry and approval are separate steps; the label is never permission to self-approve.', cite: cite('7.3', '72-73', 'discrepancy') },
    ],
    cite: cite('7.3', '14, 22, 32, 36, 42-43, 72, 93-95'),
  },

  contract: {
    key: 'contract', name: 'Contractual procurement through the RCO', short: 'Contract',
    use: 'Requirements routed to formal contracting, including above-threshold or complex purchases.',
    systems: ['DAI iProcurement PRDS Store', 'Standard Procurement System (SPS)', 'Wide Area Workflow (WAWF)'], tool: 'Awarded contract',
    keyLink: 'DAI POET, loaded from the FCCCB POET Load Sheet.',
    identifier: { id: 'DAI POET', generator: 'FCCCB POET Load Sheet', owner: 'HQMC (P&R), L1' },
    setup: 'Shared POET setup only.',
    critical: 'Recording or modifying a DAI award does not by itself execute a contractual action with a vendor. The Contracting Officer executes the contract.',
    phases: [
      { title: 'Requisition and commitment', steps: [
        SHARED_SETUP,
        { text: 'The end user identifies the requirement; the CRO validates it and routes it to Supply.', actor: 'End user / CRO' },
        { text: 'The fiscal clerk validates the requirement, screens sources, considers the applicable thresholds, and selects contractual procurement.', actor: 'Fiscal clerk' },
        { text: 'The fiscal clerk enters the Purchase Request / Universal Purchase Request in the iProcurement PRDS Store and routes it to the Supply Officer.', actor: 'Fiscal clerk' },
        { text: 'The Supply Officer validates and approves; DAI records the requisition (commitment).', actor: 'Supply Officer', evidence: 'Approved Universal Purchase Request' },
      ] },
      { title: 'Contract award and obligation', steps: [
        { text: 'The Regional Contracting Office (RCO) receives notice of the approved PR, validates the requirement, and accepts it.', actor: 'RCO' },
        { text: 'The RCO assigns a Contracting Officer (KO), who completes the contracting process.', actor: 'KO' },
        { text: 'The KO releases the awarded contract in SPS.', actor: 'KO', evidence: 'SF 1449 or SF 30' },
        { text: 'SPS sends the award to DAI. The Block III chart shows a certifier step and a "24hrs" label — a diagram detail, not a service standard.', actor: 'SPS / Certifier' },
        { text: 'Verify the supported obligation posts to the intended DAI record.', actor: 'FMRA' },
      ] },
      { title: 'Delivery, receipt and payment', steps: [
        { text: 'The vendor provides the goods or services. The end user validates receipt and signs the receiving report.', actor: 'End user', evidence: 'Receiving report, e.g. DD 250' },
        { text: 'The receiving report goes to Supply / the fiscal clerk; the pending file is updated.', actor: 'Fiscal clerk' },
        { text: 'If the PR uses a three-way match that requires a manual receipt, the assigned user records the receipt through P2P Receipts.', actor: 'Receipt user (P2P Receipts)' },
        { text: 'The vendor submits the payment request in WAWF, routed to Supply.', actor: 'Vendor' },
        { text: 'The assigned WAWF acceptor validates, accepts, and signs the request.', actor: 'WAWF acceptor', evidence: 'WAWF acceptance' },
        { text: 'WAWF notifies DFAS. DFAS pre-validates, pays, generates payment voucher support, and delivered and disbursement postings reach DAI.', actor: 'DFAS', evidence: 'Payment voucher, SF 1034' },
      ] },
    ],
    verification: 'Compare the approved PR, contract or modification, physical acceptance, receiving report, the required DAI receipt, WAWF acceptance, and payment. Under a three-way match an award alone cannot establish that the billed quantity was received; the payment-stage delivered posting does not remove the explicit manual-receipt condition.',
    ksd: { request: ['Approved Universal Purchase Request in iProcurement', 'SF 1449 or SF 30'], receipt: ['Vendor receipt or DD 250', 'WAWF acceptance'], payment: ['DFAS payment voucher, SF 1034'] },
    discrepancies: [{ text: 'P. 91 shows a certifier and a "24hrs" transmission label. Keep the chart detail but always verify the actual posting.', cite: cite('7.4', '91', 'discrepancy') }],
    cite: cite('7.4', '15, 23, 31, 36, 44-45, 73, 90-92'),
  },

  fuel: {
    key: 'fuel', name: 'Fuel farm', short: 'Fuel',
    use: 'Fuel obtained through the government fuel-farm process.',
    systems: ['Enterprise Point of Sale (EPoS)', 'DAI'], tool: 'Fuel key (VIL in the diagrams) or QR code',
    keyLink: 'Fuel key combination mapped to a POET through the Fuel Key Alias Table.',
    identifier: { id: 'Fuel key combination', generator: 'Fuel Key Alias Table load request', owner: 'HQMC (P&R), L1. The FMRA prepares and validates the request.' },
    setup: 'Key and fuel-key alias mapping.',
    phases: [
      { title: 'Pre-execution', steps: [
        SHARED_SETUP,
        { text: 'Supply prepares a fuel-key request and sends it to the Comptroller.', actor: 'Supply' },
        { text: 'The Comptroller validates. The FMRA prepares the Fuel Key Alias Table load request.', actor: 'Comptroller / FMRA' },
        { text: 'Once the mapping is loaded, the FMRA adds the POET/fuel-key combination to the request and returns it to Supply.', actor: 'FMRA' },
        { text: 'Supply submits the completed request to the fuel farm; the manager creates and issues the key.', actor: 'Supply / Fuel farm' },
        { text: 'The fiscal clerk secures the physical key against misuse.', actor: 'Fiscal clerk' },
      ] },
      { title: 'Approval and issue', steps: [
        { text: 'The end user identifies the requirement. The CRO validates it and routes it to Supply.', actor: 'End user / CRO' },
        { text: 'The fiscal clerk validates, screens sources, selects the fuel-farm method, and routes for Supply Officer approval.', actor: 'Fiscal clerk' },
        { text: 'The Supply Officer approves using the local unit’s request/approval process. The book names no universal mandatory approval form for this step.', actor: 'Supply Officer' },
        { text: 'The fiscal clerk updates the pending file and notifies the user. The user signs the logbook; the fiscal clerk issues the key or provides the authorized QR process.', actor: 'Fiscal clerk', evidence: 'Logbook' },
      ] },
      { title: 'Fueling, records and payment', steps: [
        { text: 'The end user inserts the key or scans the QR code and pumps fuel.', actor: 'End user' },
        { text: 'EPoS sends award and delivered activity through the Fuel Key Alias Table mapping into DAI.', actor: 'EPoS' },
        { text: 'The end user records the purchase on the DD 1898, returns the key and form, and completes the logbook.', actor: 'End user', evidence: 'DD 1898' },
        { text: 'The fiscal clerk updates the pending file, reconciles the DTR, and checks that accounting transactions posted correctly.', actor: 'Fiscal clerk' },
        { text: 'EPoS notifies DFAS. DFAS pays and sends the disbursement for DAI posting.', actor: 'DFAS', evidence: 'Payment voucher, SF 1034' },
      ] },
    ],
    verification: 'Compare the fuel issue, the DD 1898 and logbook, the key identity and its mapping, and the DAI activity. Confirm the physical key came back. A mapping failure can leave an actual fuel issue outside recorded execution.',
    ksd: {
      request: ['Local logbook and DD 1898 (approval follows local SOP)'], receipt: ['Logbook and DD 1898'], payment: ['DFAS payment voucher, SF 1034'],
      note: '"No mandatory KSD" (pp. 46, 74) is limited to the unspecified approval form. The logbook and DD 1898 remain transaction support (p. 35). It is never permission to omit all fuel documentation.',
    },
    discrepancies: [
      { text: 'Block II (p. 47) describes commitment, obligation and delivered transmission; Block III describes award and delivered. Different labels are not an instruction to duplicate postings.', cite: cite('7.5', '47, 74', 'discrepancy') },
      { text: 'The book does not expand VIL consistently; the identifier label is kept as printed.', cite: cite('7.5', '74, 81-83', 'discrepancy') },
    ],
    cite: cite('7.5', '14, 24, 30, 35, 46-47, 74, 81-83'),
  },

  tdy: {
    key: 'tdy', name: 'Temporary duty (TDY) through DTS', short: 'TDY / DTS',
    use: 'Official temporary-duty travel.',
    systems: ['Defense Travel System (DTS)', 'DAI'], tool: 'Travel authorization (DD 1610) and voucher (DD 1351-2)',
    keyLink: 'DTS LOA built for the POETs that support TDY.',
    identifier: { id: 'DTS LOA', generator: 'DTS Label Report', owner: 'FDTA, 3451. Creates LOAs and DTS budgets.' },
    setup: 'LOAs and budget shells created in DTS.',
    critical: 'An approved authorization is not a submitted voucher, and a completed trip is not a paid voucher. Local DTS routing may vary.',
    phases: [
      { title: 'Pre-execution', steps: [
        SHARED_SETUP,
        { text: 'The FMRA uses the DTS Label Report to create the DTS LOA structure for the POETs supporting TDY.', actor: 'FMRA' },
        { text: 'Using the FDTA role, the FMRA creates and loads DTS LOAs and budget shells.', actor: 'FMRA (FDTA)' },
      ] },
      { title: 'Authorization and obligation', steps: [
        { text: 'The traveler identifies the requirement; the CRO validates it.', actor: 'Traveler / CRO' },
        { text: 'The traveler completes the travel authorization in DTS and routes it for review. A typical path is Supply review, then administrative-office / Approving Official approval.', actor: 'Traveler' },
        { text: 'Supply checks available funds and the selected LOA, then routes the authorization to the Approving Official (AO).', actor: 'Supply' },
        { text: 'The AO approves. DTS generates the approved authorization and sends an award transaction to DAI. Verify the interface and posting.', actor: 'AO', evidence: 'DD 1610 / DTS authorization' },
      ] },
      { title: 'Travel, voucher and settlement', steps: [
        { text: 'The traveler executes the trip — the real-world delivered event, separate from the later accounting entry.', actor: 'Traveler' },
        { text: 'After travel, the traveler completes the voucher in DTS.', actor: 'Traveler', evidence: 'DD 1351-2 / DTS voucher' },
        { text: 'The book’s example route is Supply review, Admin certification, then local Disbursing validation and approval. Follow the established local route.', actor: 'Supply / Admin / Disbursing' },
        { text: 'Approved voucher processing sends the delivered transaction to DAI.', actor: 'DTS' },
        { text: 'Voucher costs may differ from the estimate; the book describes an automatic DAI award adjustment to the receipt amount. Verify the adjusted award and interface status rather than assuming success.', actor: 'FMRA' },
        { text: 'DTS notifies DFAS. DFAS pays and sends the disbursement to DAI; DTS updates the voucher with paid status.', actor: 'DFAS', evidence: 'Paid/certified DD 1351-2' },
      ] },
    ],
    verification: 'Match the authorization, the actual travel, the voucher, any adjustments, the LOA, and the DAI obligation, delivered and payment, plus the paid-voucher status.',
    ksd: { request: ['DD 1610 / DTS authorization'], receipt: ['DD 1351-2 / DTS voucher'], payment: ['Paid/certified DD 1351-2'] },
    discrepancies: [{ text: 'Block II (p. 48) labels authorization transmission as commitment plus obligation; Block III describes an award transmission. The OTO examples deliberately show no commitment amount, so a blank commitment alone is not a missing-commitment error.', cite: cite('7.6', '48, 75, 84-86', 'discrepancy') }],
    cite: cite('7.6', '15, 25, 31, 35, 48-49, 75, 84-86'),
  },

  mipr: {
    key: 'mipr', name: 'Military Interdepartmental Purchase Request (MIPR)', short: 'MIPR',
    use: 'Goods or services supplied by another agency or component.',
    systems: ['DAI iProcurement IGT/MIPR/IA Store', 'DAI'], tool: 'DD 448, DD 448-2 acceptance, and the DAI award',
    keyLink: 'DAI POET, loaded from the FCCCB POET Load Sheet.',
    identifier: { id: 'DAI POET', generator: 'FCCCB POET Load Sheet', owner: 'HQMC (P&R), L1' },
    setup: 'The agreement and the other agency’s financial point of contact.',
    critical: 'The requested commitment alone does not prove the other agency accepted the work. This is the book’s MIPR workflow, not a substitute for a current G-Invoicing procedure.',
    phases: [
      { title: 'Pre-execution', steps: [
        SHARED_SETUP,
        { text: 'G-4 ensures the necessary agreement(s) are in place.', actor: 'G-4' },
        { text: 'Supply and/or Comptroller identifies the other agency’s financial point of contact.', actor: 'Supply / Comptroller' },
      ] },
      { title: 'Request and commitment', steps: [
        { text: 'The end user identifies the requirement; the CRO validates it and routes it to Supply.', actor: 'End user / CRO' },
        { text: 'The fiscal clerk validates the requirement and selects MIPR after source screening.', actor: 'Fiscal clerk' },
        { text: 'The fiscal clerk enters the request in the iProcurement IGT/MIPR/IA Store and routes it to the Supply Officer.', actor: 'Fiscal clerk' },
        { text: 'The Supply Officer validates and approves. The requisition is recorded in DAI.', actor: 'Supply Officer' },
        { text: 'Supply generates the DD 448 from DAI and sends it to the receiving agency’s financial contact.', actor: 'Supply', evidence: 'Signed DD 448' },
      ] },
      { title: 'Acceptance, acknowledgement and award', steps: [
        { text: 'The other agency completes and signs the DD 448-2 and returns it to Supply.', actor: 'Performing agency', evidence: 'Signed DD 448-2' },
        { text: 'Supply records the acknowledgement in DAI using the P2P MIPR Acknowledgement responsibility. It records receipt of the other agency’s acceptance.', actor: 'Supply (P2P MIPR Acknowledgement)' },
        { text: 'The assigned procurement user creates the MIPR award in DAI and routes it to the Supply Officer.', actor: 'Assigned procurement user' },
        { text: 'The Supply Officer validates and approves. Verify the award/obligation posts.', actor: 'Supply Officer' },
      ] },
      { title: 'Receipt and payment', steps: [
        { text: 'The other agency provides the goods or services. The end user confirms receipt and signs a receiving report.', actor: 'End user', evidence: 'Receiving report, e.g. DD 250' },
        { text: 'The receiving report goes to the fiscal clerk / assigned receipt user, who records receipt through P2P Receipts. Verify the delivered transaction.', actor: 'Receipt user (P2P Receipts)' },
        { text: 'The other agency submits its bill and DFAS is notified for payment.', actor: 'Performing agency' },
        { text: 'DFAS pays, produces payment voucher evidence, and the disbursement posts to DAI.', actor: 'DFAS', evidence: 'Paid/certified voucher from DFAS' },
      ] },
    ],
    verification: 'Link the signed DD 448, the signed DD 448-2, the acknowledgement, the approved award, the receipt, and the payment to the same requirement and accounting data.',
    ksd: { request: ['Signed DD 448', 'Signed DD 448-2 acceptance'], receipt: ['Invoice, DD 250, or local receipt record'], payment: ['Paid/certified voucher from DFAS'] },
    discrepancies: [
      { text: 'Block II compresses acceptance entry and approval into obligation posting; Block III separates acknowledgement, award preparation and approval. The more explicit Block III sequence is used.', cite: cite('7.7', '50, 76, 88', 'discrepancy') },
      { text: 'The narrative calls the award creator the fiscal clerk, while the role directory ties P2P Procurement Officer to the fiscal chief. Use the responsibility actually assigned.', cite: cite('7.7', '76, 61', 'discrepancy') },
      { text: 'Handwritten notes (pp. 87-88) stress funding first, commitment as a reservation, and the acknowledgement and award roles. "Too late to back out" is not adopted as a rule about cancelling or modifying an accepted agreement.', cite: cite('7.7', '87-88', 'discrepancy') },
    ],
    cite: cite('7.7', '12, 26, 31, 36, 50-51, 76, 87-89'),
  },
};

export const METHOD_LIST: PurchaseMethod[] = METHOD_KEYS.map((k) => METHODS[k]);

export const PAYMENT_TIMING = {
  text: 'Several narratives give payment timing as 30-45 days after receipt or acceptance; the ServMart diagram says 30-45 business days. A classroom expectation, not a universal payment deadline, and never a reason to ignore an error during that interval.',
  cite: cite('7', '70-76, 80, 89', 'discrepancy'),
};

/* ── Choosing the method ──────────────────────────────────────────────────────────────────── */

/** A useful requirement states these four things (ch. 3.1). */
export const REQUIREMENT_ELEMENTS = [
  'What is needed',
  'The purchase type (good or service)',
  'The dollar amount',
  'The mission or end item it supports',
] as const;

/** The book's teaching router. Not a claim that NSN existence alone resolves every procurement decision. */
export const ROUTING = [
  { requirement: 'Item with an NSN — office supplies', methods: ['servmart'] as MethodKey[], condition: 'Authorized item and appropriate government source.' },
  { requirement: 'Item with an NSN — maintenance parts', methods: ['gcss'] as MethodKey[], condition: 'Logistics requisition and stock/source review.' },
  { requirement: 'Item without an NSN — commercial supply', methods: ['gpc', 'contract'] as MethodKey[], condition: 'Threshold and requirement characteristics affect routing.' },
  { requirement: 'Goods or services from another DoD component', methods: ['mipr'] as MethodKey[], condition: 'Interagency support and acceptance process.' },
  { requirement: 'Commercial service', methods: ['gpc', 'contract'] as MethodKey[], condition: 'Service threshold and applicable authority.' },
  { requirement: 'Government fuel', methods: ['fuel'] as MethodKey[], condition: 'Fuel key / QR and the local control process.' },
  { requirement: 'Official temporary-duty travel', methods: ['tdy'] as MethodKey[], condition: 'Authorization, execution, voucher, settlement.' },
] as const;

export const ROUTING_NOTES = [
  { text: 'Mandatory source screening means considering required sources in the prescribed order before choosing a commercial source. The book teaches the requirement to screen but does not list the complete priority order, so none is invented here.', cite: cite('3.1', '11-15') },
  { text: 'The book also recognizes Transportation of Things (TOT), Transportation of People (ToP), and miscellaneous methods, without complete procedures for them.', cite: cite('3.2', '11-15', 'discrepancy') },
  { text: 'Contractual procurement is also described as suitable for complex requirements. An amount below a threshold does not by itself establish authority for a card purchase.', cite: cite('3.3', '14, 17-18') },
] as const;

/**
 * Thresholds as the book printed them. Kept for fidelity to the source and deliberately labelled:
 * they are not verified current purchasing limits and no routing decision in Vantage enforces them.
 */
export const PRINTED_THRESHOLDS = [
  { category: 'Services', cents: 350_000 },
  { category: 'Goods', cents: 1_000_000 },
  { category: 'Training', cents: 2_500_000 },
] as const;

export const THRESHOLD_NOTE = 'Pages 17-18 split commercial goods at $10,000 and commercial services at $3,500: "over" routes to contracting, "under" to GPC. Page 14 describes GPC purchases as at or below the threshold, so the exact-boundary case is clearer in the prose than in the diagram. These are printed training values, not verified current limits.';

export type RoutingAnswer = {
  methods: MethodKey[];
  reasons: string[];
  cautions: string[];
};

/**
 * Walks the book's teaching router. It narrows the candidates and says why; it never decides.
 * Printed thresholds only ever produce a caution, because they are not verified current limits.
 */
export function routeRequirement(input: {
  kind: 'good' | 'service' | 'fuel' | 'travel';
  hasNsn?: boolean;
  nsnUse?: 'office' | 'maintenance';
  fromDodComponent?: boolean;
  amountCents?: number | null;
  complex?: boolean;
}): RoutingAnswer {
  const reasons: string[] = [];
  const cautions: string[] = ['Complete mandatory source screening first. The book does not list the full priority order.'];
  if (input.kind === 'travel') return { methods: ['tdy'], reasons: ['Official temporary-duty travel goes through DTS.'], cautions: ['Local DTS routing may vary.'] };
  if (input.kind === 'fuel') return { methods: ['fuel'], reasons: ['Government fuel is issued through the fuel farm with a key or QR code.'], cautions: ['Approval follows the local SOP; the book names no universal approval form.'] };
  if (input.fromDodComponent) return { methods: ['mipr'], reasons: ['Support from another DoD component or agency goes by MIPR.'], cautions: ['An agreement must be in place (G-4) and the other agency’s financial contact identified.'] };
  if (input.kind === 'good' && input.hasNsn) {
    if (input.nsnUse === 'maintenance') return { methods: ['gcss'], reasons: ['NSN maintenance parts are requisitioned through GCSS-MC.'], cautions };
    return { methods: ['servmart'], reasons: ['NSN office supplies come from the government source, ServMart.'], cautions };
  }
  const threshold = input.kind === 'service' ? 350_000 : 1_000_000;
  reasons.push(input.kind === 'service' ? 'A commercial service goes by GPC or contract.' : 'A commercial item without an NSN goes by GPC or contract.');
  if (input.complex) {
    reasons.push('Complex requirements are described as suited to contracting.');
    return { methods: ['contract'], reasons, cautions };
  }
  if (input.amountCents != null) {
    const printed = `$${(threshold / 100).toLocaleString('en-US')}`;
    if (input.amountCents > threshold) {
      reasons.push(`Above the book’s printed ${input.kind} threshold of ${printed}, the diagram routes to contracting.`);
      cautions.push('Printed training threshold, not a verified current limit. Confirm the applicable authority.');
      return { methods: ['contract'], reasons, cautions };
    }
    reasons.push(`At or below the book’s printed ${input.kind} threshold of ${printed}, the diagram routes to GPC.`);
    cautions.push('Printed training threshold, not a verified current limit. Being under it does not by itself authorize a card purchase.');
    return { methods: ['gpc', 'contract'], reasons, cautions };
  }
  cautions.push('Without an amount the threshold split cannot be read.');
  return { methods: ['gpc', 'contract'], reasons, cautions };
}

/** Most methods share one approval chain (ch. 3.4). Travel uses its own DTS routing and AO. */
export const APPROVAL_CHAIN = [
  { who: 'End user', does: 'Identifies the requirement.' },
  { who: 'CRO', does: 'Validates it.' },
  { who: 'Fiscal clerk', does: 'Validates it and selects the method.' },
  { who: 'Supply Officer / funds official', does: 'Approves, when authorized.' },
  { who: 'Assigned user', does: 'Executes the purchase.' },
] as const;
