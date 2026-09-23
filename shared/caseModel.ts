import { z } from 'zod';

/**
 * The case model: what happened to one piece of work, in order, and who did it.
 *
 * A work item's row says where it stands now. Its events say how it got there, and they are
 * append-only: a correction is a new event that names the one it supersedes, never an edit. That
 * is what lets the history answer "who did what, when, why, and on what reference" after the work
 * has changed hands and stages several times.
 *
 * Several distinctions here are deliberate and must not be collapsed:
 *   drafted ≠ submitted ≠ approved ≠ effective/posted;
 *   a funds check ≠ funds obligated; an expected invoice ≠ a posted invoice;
 *   following a procedure ≠ verifying the financial condition it was meant to fix.
 */

/** Where the work stands. Only the stages a real workflow needs; not every internal state. */
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

/**
 * The coarse state the queue has always filtered on. Kept in step with the stage so every existing
 * filter, saved view and report keeps meaning what it meant.
 */
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

/** What the work is waiting on. Waiting is elapsed time, never active labour. */
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

/** Every result a funds check can return. Only PASSED lets a submission through without a word. */
export const FUNDS_CHECK_RESULTS = ['PASSED', 'FAILED', 'WARNING', 'NOT_RUN', 'UNKNOWN'] as const;
export type FundsCheckResult = (typeof FUNDS_CHECK_RESULTS)[number];

/** Something an authoritative system reported after a submission. Each is its own fact. */
export const EXTERNAL_EVENTS = ['approved', 'effective', 'posted', 'rejected', 'returned'] as const;
export type ExternalEvent = (typeof EXTERNAL_EVENTS)[number];

/**
 * Where a value came from. A figure a Marine read off DAI and typed in is a manual observation of
 * an authoritative system, which is not the same thing as an authoritative integration.
 */
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

/** Events a person records directly. The server adds the rest (claims, handoffs, stages, calculations). */
export const ENTRY_KINDS = [
  'question', 'observation', 'finding', 'decision', 'note',
  'action_prepared', 'action_submitted', 'external_event', 'funds_check', 'verification',
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const SYSTEM_KINDS = [
  'created', 'claimed', 'released', 'handed_off', 'assigned', 'claim_expired',
  'stage_changed', 'waiting_started', 'waiting_ended', 'calculation', 'resolved', 'reopened',
  'action_recorded', 'procedure_applied',
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
};

const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters.`);
const required = (max: number, message = 'Required.') => text(max).min(1, message);
const optional = (max: number) => text(max).nullish().transform((v) => (v ? v : null));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const key = z.string().trim().regex(/^[a-z][a-z0-9_]{0,59}$/, 'Use a short lowercase key.');

const base = {
  /** A correction names the entry it replaces. The original stays in the history. */
  supersedes: z.string().max(64).nullish(),
  /** Which procedure step this entry belongs to, when the work follows one. */
  step: key.nullish(),
};

export const entrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('question'), text: required(2000), ...base }),
  z.object({ kind: z.literal('finding'), text: required(4000), ...base }),
  z.object({ kind: z.literal('note'), text: required(4000), ...base }),
  z.object({
    kind: z.literal('observation'),
    /** A procedure field key ("current_award", "invoice_amount") or "other". */
    field: key,
    label: optional(120),
    /** Money as typed. Parsed to cents on the server; never stored as a float. */
    amount: z.union([z.string().max(40), z.number()]).nullish(),
    value_text: optional(500),
    system: optional(60),
    reference: optional(160),
    observed_on: isoDate.nullish(),
    ...base,
  }),
  z.object({
    kind: z.literal('decision'),
    decision: key,
    choice: key,
    /** A decision without a reason cannot be reviewed later, so one is required. */
    rationale: required(2000, 'Say why.'),
    ...base,
  }),
  z.object({ kind: z.literal('action_prepared'), step: key, reference: optional(160), text: optional(2000), supersedes: base.supersedes }),
  z.object({
    kind: z.literal('action_submitted'),
    step: key,
    reference: optional(160),
    text: optional(2000),
    /**
     * Required, and recorded, when the latest funds check was a WARNING. A FAILED, NOT_RUN or
     * UNKNOWN check, or none at all, cannot be acknowledged past: the submission is refused.
     */
    control_acknowledgement: optional(1000),
    /** Mark the work as waiting on this category in the same step. */
    then_wait: z.enum(WAITING_CATEGORIES).nullish(),
    supersedes: base.supersedes,
  }),
  z.object({
    kind: z.literal('external_event'),
    step: key,
    event: z.enum(EXTERNAL_EVENTS),
    system: optional(60),
    reference: optional(160),
    observed_on: isoDate.nullish(),
    text: optional(2000),
    supersedes: base.supersedes,
  }),
  z.object({
    kind: z.literal('funds_check'),
    result: z.enum(FUNDS_CHECK_RESULTS),
    system: optional(60),
    reference: optional(160),
    text: optional(2000),
    ...base,
  }),
  z.object({
    kind: z.literal('verification'),
    check: key,
    result: z.enum(['verified', 'not_verified']),
    /** What was looked at. Required for a verified result: a verification with no reference is a claim. */
    reference: optional(160),
    text: optional(2000),
    ...base,
  }),
]);
export type EntryInput = z.infer<typeof entrySchema>;

export const stageChangeSchema = z.object({
  stage: z.enum(STAGES),
  reason: optional(1000),
  waiting_category: z.enum(WAITING_CATEGORIES).nullish(),
  expected_by: isoDate.nullish(),
  version: z.number().int().nullish(),
});

export const handoffSchema = z.object({
  to_user_id: z.string().min(1).max(64),
  /** Why the work is moving. Handoffs without a reason make the history harder to trust. */
  note: required(1000, 'Say what the next person needs to know.'),
  version: z.number().int().nullish(),
});

/** A human-readable one-line summary of an event, for history lists and drafts. */
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
    default: return b.text ? String(b.text) : EVENT_LABEL[kind as EventKind] || kind;
  }
}

export const humanKey = (k: unknown) => {
  const s = String(k || '').replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
};
