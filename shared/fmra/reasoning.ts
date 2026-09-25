export const STATEMENT_TYPES = [
  { key: 'definition', label: 'Definition', meaning: 'What a term means.', example: 'DOU is delivered without full posted payment.' },
  { key: 'observation', label: 'Observation', meaning: 'What a particular record currently shows.', example: 'This award has $100 delivered and $50 paid.' },
  { key: 'inference', label: 'Inference', meaning: 'Why the condition might exist.', example: 'The remaining $50 may be on hold.' },
  { key: 'action', label: 'Action', meaning: 'Changes something, or requests a change.', example: 'Submitted the receipt correction.' },
  { key: 'verification', label: 'Verification', meaning: 'Establishes the result.', example: 'The hold report no longer lists the invoice.' },
] as const;

export const INFERENCE_RULE = 'A hold-report check supplies evidence. It is not optional merely because the arithmetic fits.';

export const CASE_RECORD = [
  { field: 'Identity', capture: 'Case ID, source system, report and date, document/requisition/award IDs; line and distribution where available.', vantage: 'The work item: document number, source file and row, imported fields.' },
  { field: 'Requirement', capture: 'What is being supported, purchase method, responsible using unit, and relevant performance or delivery period.', vantage: 'Observations on the case, including the purchase method.' },
  { field: 'Financial observations', capture: 'Commitment, obligation, receipt/delivered, posted payment and unmatched amount; totals versus remaining balances.', vantage: 'Observations in exact cents, each with its source and where it was read.' },
  { field: 'Classification', capture: 'Lifecycle phase, normal or abnormal condition, exact error label, and confidence and unknowns.', vantage: 'The procedure applied, the calculation, and the recorded decision with its reason.' },
  { field: 'Evidence', capture: 'Request, award/acceptance, receipt, invoice, payment, and source-page references.', vantage: 'KSD observations by group, attachments, and references on every entry.' },
  { field: 'Responsibility', capture: 'Research owner, required system role, approver or delegation, and external organization.', vantage: 'The holder, handoffs, and the responsibility each step names.' },
  { field: 'Action and dependency', capture: 'Proposed correction, prerequisites, required approval, next waiting state, and expected output.', vantage: 'Prepared and submitted actions, controls, and waiting stages with their category.' },
  { field: 'Verification', capture: 'What was checked, in which system, when, and whether the target condition actually cleared.', vantage: 'Verification entries, each requiring a reference, and the resolution gate.' },
] as const;

/** The suggested answer format (ch. 12.4). */
export const ANSWER_FORMAT = [
  { key: 'observed', label: 'Observed condition', question: 'What does the report or system actually show?' },
  { key: 'meaning', label: 'Financial meaning', question: 'Which phase or gap is represented?' },
  { key: 'causes', label: 'Possible causes', question: 'Which source-supported explanations remain plausible?' },
  { key: 'research', label: 'Required research', question: 'What evidence distinguishes those causes?' },
  { key: 'roles', label: 'Responsible role', question: 'Who can research, prepare, approve or post the action?' },
  { key: 'next', label: 'Next action', question: 'What supported correction or follow-up is appropriate?' },
  { key: 'verification', label: 'Wait and verification', question: 'What must happen next, and what proves resolution?' },
  { key: 'references', label: 'References and limits', question: 'Which pages support the answer, and which inputs are missing?' },
] as const;

/** What an answer — a person's, Vantage's, or an AI's — must never do. */
export const NEVER = [
  'Present a classroom example as a confirmed live balance.',
  'Present a printed threshold as verified current policy.',
  'Present a requested action as an executed change.',
  'Present a likely cause as a proven fact.',
] as const;

/** Compact guardrail text for AI prompts on financial work. */
export const AI_GUARDRAILS = [
  'Separate definitions, observations, inferences, actions and verifications. Label inferences as possibilities.',
  'Answer in this order: observed condition, financial meaning, possible causes, required research, responsible role, next action, wait and verification, references and limits.',
  ...NEVER.map((n) => `Never ${n.charAt(0).toLowerCase()}${n.slice(1)}`),
  'A submitted, prepared or requested action is not proof of a result; only a verification with a reference is.',
  'Research access never confers authority to create an award, a receipt or a payment correction.',
].join(' ');
