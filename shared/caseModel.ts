export const STAGES = [
  'not_started', 'researching', 'ready_for_action', 'submitted', 'waiting', 'blocked', 'verification_required', 'resolved', 'not_applicable',
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  not_started: 'Not started',
  researching: 'Researching',
  ready_for_action: 'Ready for action',
  submitted: 'Submitted',
  waiting: 'Waiting',
  blocked: 'Blocked',
  verification_required: 'Verification required',
  resolved: 'Resolved',
  not_applicable: 'Not applicable',
};

export const STAGE_TO_STATE: Record<Stage, 'open' | 'in_progress' | 'waiting' | 'resolved' | 'not_applicable'> = {
  not_started: 'open',
  researching: 'in_progress',
  ready_for_action: 'in_progress',
  submitted: 'in_progress',
  verification_required: 'in_progress',
  waiting: 'waiting',
  blocked: 'waiting',
  resolved: 'resolved',
  not_applicable: 'not_applicable',
};

/** A stage for a row that predates stages, read from its state. */
export const STATE_TO_STAGE: Record<string, Stage> = {
  open: 'not_started', in_progress: 'researching', waiting: 'waiting', resolved: 'resolved', not_applicable: 'not_applicable',
};

export const CLOSED_STAGES = new Set<Stage>(['resolved', 'not_applicable']);

export const WAITING_CATEGORIES = ['approval', 'posting', 'invoice', 'documentation', 'internal_action', 'external_response'] as const;
export type WaitingCategory = (typeof WAITING_CATEGORIES)[number];
export const WAITING_LABEL: Record<WaitingCategory, string> = {
  approval: 'Approval',
  posting: 'Posting',
  invoice: 'Invoice',
  documentation: 'Documentation',
  internal_action: 'Internal action',
  external_response: 'External response',
};

export const FUNDS_CHECK_RESULTS = ['PASSED', 'FAILED', 'WARNING', 'NOT_RUN', 'UNKNOWN'] as const;
export type FundsCheckResult = (typeof FUNDS_CHECK_RESULTS)[number];

export const EXTERNAL_EVENTS = ['approved', 'effective', 'posted', 'rejected', 'returned'] as const;
export type ExternalEvent = (typeof EXTERNAL_EVENTS)[number];

export const VALUE_SOURCES = {
  source_file: 'From the imported source file',
  manual_observation: 'Read from an authoritative system and entered by hand',
  approved_import: 'Approved authoritative import',
  user_entry: 'Entered by a person',
  calculated: 'Calculated by Vantage from recorded values',
  forecast: 'Forecast',
  ai_draft: 'AI draft, not accepted',
} as const;
export type ValueSource = keyof typeof VALUE_SOURCES;

export const ENTRY_KINDS = [
  'question', 'observation', 'finding', 'decision', 'note',
  'action_prepared', 'action_submitted', 'external_event', 'funds_check', 'verification',
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const SYSTEM_KINDS = [
  'created', 'claimed', 'released', 'handed_off', 'assigned', 'claim_expired',
  'stage_changed', 'waiting_started', 'waiting_ended', 'calculation', 'resolved', 'reopened',
  'action_recorded', 'procedure_applied', 'source_revised',
] as const;
export type SystemKind = (typeof SYSTEM_KINDS)[number];
export type EventKind = EntryKind | SystemKind;

/** Research: finding out what is true. Counted as research contribution. */
export const RESEARCH_KINDS: readonly EventKind[] = ['question', 'observation', 'finding', 'decision', 'note', 'calculation', 'action_recorded'];

export const EVENT_LABEL: Record<EventKind, string> = {
  question: 'Question', observation: 'Observation', finding: 'Finding', decision: 'Decision', note: 'Note',
  action_prepared: 'Prepared (not submitted)', action_submitted: 'Submitted', external_event: 'System reported',
  funds_check: 'Funds check', verification: 'Verification',
  created: 'Created', claimed: 'Claimed', released: 'Released', handed_off: 'Handed off', assigned: 'Assigned',
  claim_expired: 'Claim expired', stage_changed: 'Stage changed', waiting_started: 'Waiting started', waiting_ended: 'Waiting ended',
  calculation: 'Calculation', resolved: 'Resolved', reopened: 'Reopened', action_recorded: 'Action recorded', procedure_applied: 'Procedure applied',
  source_revised: 'Source revised',
};

export function describeEvent(kind: string, body: Record<string, unknown>): string {
  const b = body as Record<string, any>;
  switch (kind) {
    case 'observation': return `${b.label || humanKey(b.field)}${b.display ? `: ${b.display}` : ''}${b.system ? ` (${b.system})` : ''}`;
    case 'decision': return `${humanKey(b.decision)}: ${humanKey(b.choice)}`;
    case 'calculation': return `${b.title || 'Calculation'}: ${b.display || ''}`;
    case 'funds_check': return `Funds check ${b.result}${b.system ? ` in ${b.system}` : ''}`;
    case 'verification': return `${humanKey(b.check)} ${b.result === 'verified' ? 'verified' : 'not verified'}`;
    case 'external_event': return `${humanKey(b.step)} ${b.event}${b.system ? ` in ${b.system}` : ''}`;
    case 'action_prepared': return `${humanKey(b.step)} prepared, not submitted`;
    case 'action_submitted': return `${humanKey(b.step)} submitted`;
    case 'waiting_started': return `Waiting on ${String(b.category || '').replace(/_/g, ' ')}`;
    case 'waiting_ended': return `Stopped waiting on ${String(b.category || '').replace(/_/g, ' ')}`;
    case 'stage_changed': return `Moved to ${STAGE_LABEL[b.to as Stage] || b.to}`;
    case 'source_revised': return `The source changed: ${Array.isArray(b.changes) ? b.changes.map((c: { field: string }) => humanKey(c.field).toLowerCase()).join(', ') : 'values'}`;
    case 'procedure_applied': return b.from_version ? `Moved to procedure version ${b.version} from ${b.from_version}` : `Procedure ${b.procedure} v${b.version} applied`;
    default: return b.text ? String(b.text) : EVENT_LABEL[kind as EventKind] || kind;
  }
}

export const humanKey = (k: unknown) => {
  const s = String(k || '').replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};
