/**
 * The discrepancy register (FMRAC ch. 13): where the source conflicts with itself or is incomplete,
 * and how Vantage treats it. Kept visible so a cleaner presentation never makes an uncertain
 * statement look more authoritative than the original.
 */

export const DISCREPANCIES = [
  { pages: '3', issue: 'Marine Logistics Group abbreviated MIG; MARFOR/MEF chain expressed universally.', treatment: 'MLG for logistics, MIG for information. The hierarchy is the book’s model, not a universal routing rule.' },
  { pages: '14, 17-18', issue: 'Threshold values and the over/under diagram.', treatment: '$3,500 services, $10,000 goods and $25,000 training kept as printed values and marked as unverified current guidance. Vantage enforces none of them.' },
  { pages: '53', issue: '"Zero-based budget" equated with "use it or lose it".', treatment: 'The execution concern is kept; the definition is flagged as unreliable.' },
  { pages: '54', issue: 'Budget timing, and an automatic continuing-resolution implication.', treatment: 'Classroom sequence and timing kept; a CR is not treated as automatic funding authority.' },
  { pages: '61', issue: 'Requisitions Approver duplicates the preparer text and typical user.', treatment: 'Label kept with the discrepancy. Assign approval from the observed workflow and actual delegation.' },
  { pages: '72-73, 76', issue: '"Approver" label appears alongside fiscal-clerk entry.', treatment: 'Entry and approval are separate steps. Actual responsibility mapping is required; self-approval is never implied.' },
  { pages: '39, 40, 47, 48 vs. Block III', issue: 'Commitment/obligation labels differ from award-focused descriptions.', treatment: 'Both descriptions recorded. No missing manual transactions are invented.' },
  { pages: '46, 74 vs. 35', issue: 'Fuel: "no mandatory KSD" versus logbook and DD 1898.', treatment: '"No mandatory KSD" is limited to the unspecified approval form; transaction evidence is retained.' },
  { pages: '72, 94', issue: 'GPC: end user versus cardholder as the receiving person.', treatment: 'Both kept; the locally designated receiver is required in the record.' },
  { pages: '50, 76, 88', issue: 'MIPR acceptance and award stages differ in detail.', treatment: 'Block III’s explicit acknowledgement, award preparation and approval sequence is used.' },
  { pages: '70-76, 80, 89', issue: 'Payment timing described as days or business days.', treatment: '30-45 kept as a classroom expectation with the wording difference. No universal deadline asserted.' },
  { pages: '91', issue: 'SPS/award diagram includes a certifier and a "24hrs" label.', treatment: 'Chart detail kept; actual posting verification required.' },
  { pages: '112', issue: 'UMT examples carry invoice-hold captions.', treatment: 'The UMT definition and pp. 115-117 are followed: payment already made, not yet correctly accounted for.' },
  { pages: '115', issue: 'Incorrect expansion of DAI.', treatment: 'Defense Agencies Initiative, consistent with the DAI chapter.' },
  { pages: '71 / 96', issue: 'OCR reads FOM; the diagram shows FDM.', treatment: 'FDM, as shown in the diagram.' },
  { pages: '67', issue: 'SLOA said to have 16 fields without defining every position.', treatment: 'Example and named fields kept; no full field specification fabricated.' },
  { pages: '87-88', issue: 'Handwritten MIPR notes.', treatment: 'Clear learning points incorporated; informal cancellation and authority comments are not elevated to policy.' },
] as const;

/** Procedures the book does not teach fully. Vantage does not fill these gaps with invented steps. */
export const NOT_TAUGHT = [
  'The complete mandatory-source precedence',
  'SMU on-hand fulfillment for GCSS-MC',
  'Current system click paths for every step',
  'Role conflicts and a full authorization matrix',
  'Detailed 1081 submission instructions',
  'Transportation of Things, Transportation of People and miscellaneous procurement',
  'Current G-Invoicing processing',
] as const;
