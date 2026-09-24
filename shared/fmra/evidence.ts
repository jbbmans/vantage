import { cite } from './source.ts';

/**
 * Evidence, reconciliation and audit readiness (FMRAC ch. 6).
 *
 * Key Supporting Documentation (KSD) supports and validates a financial transaction. Evidence
 * belongs to its event: an approved request proves authorization, not delivery or payment. A local
 * form may differ between commands and still support the same event.
 */

export const KSD_GROUPS = [
  { key: 'request', label: 'Request and order', proves: 'Authorization and the order.' },
  { key: 'receipt', label: 'Receipt and acceptance', proves: 'That the goods or services were actually received and accepted.' },
  { key: 'payment', label: 'Payment', proves: 'That payment was made, and against what.' },
] as const;
export type KsdGroup = (typeof KSD_GROUPS)[number]['key'];

export const AUDIT_READINESS = {
  definition: 'Records are accurate, supported, reconciled, and available for examination.',
  reconciliation: 'Compare the accounting entry with the supporting event or document, and resolve the differences.',
  purpose: 'Research establishes what happened and why, then makes the record match the supported event.',
  cite: cite('6.1', '33-51'),
};

/** Editorial checklist derived from the source (ch. 6.3). */
export const RECONCILIATION_CHECKPOINTS = [
  'Identify the requirement and its document number.',
  'Link the approved request to the award or order.',
  'Compare the actual receipt with the receipt entry.',
  'Compare the invoice and payment evidence with the posted accounting amount.',
  'Investigate any residual balance.',
  'Retain the correction and the verification record.',
] as const;

/**
 * The states a complete work note keeps apart. Collapsing them into one "done" removes exactly the
 * evidence needed to explain an open balance.
 */
export const RECEIPT_STATES = [
  { key: 'physical_receipt', label: 'Physical receipt', meaning: 'The goods or services actually arrived.' },
  { key: 'receipt_document', label: 'Supporting receipt document', meaning: 'The signed receiving record exists (e.g. DD 250, DD 1348-1A, vendor receipt).' },
  { key: 'feeder_recorded', label: 'Feeder-system recording', meaning: 'The feeder system (GCSS-MC, DTS, PoS…) recorded it.' },
  { key: 'dai_posted', label: 'DAI posting', meaning: 'The transaction posted in DAI.' },
  { key: 'payment', label: 'Payment', meaning: 'The disbursement was made and posted.' },
] as const;

export const SERVMART_FUEL_RULE = {
  text: 'For ServMart and fuel, the fiscal clerk updates the pending file, reconciles the DTR, and verifies DAI posting. The book does not expand "DTR", so the label is kept rather than inventing a report title.',
  cite: cite('6.3', '33-51'),
};

export const EVIDENCE_RULES = [
  { text: 'Evidence belongs to its event. An approved request proves authorization, not necessarily delivery or payment.', cite: cite('6.1', '33-51') },
  { text: 'The presence of an attachment does not by itself mark a financial event complete.', cite: cite('12.3', undefined, 'editorial') },
  { text: 'Map documents to steps: approved request to requisition; award or acceptance to obligation; receiving evidence to receipt; payment evidence to matching and reconciliation.', cite: cite('12.3', undefined, 'editorial') },
  { text: 'A physical receipt does not prove the DAI receipt posted; a vendor payment does not prove it matched the intended award.', cite: cite('2.1', '63') },
] as const;
