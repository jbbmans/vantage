/** What a case accepts from a request. Kept apart from caseModel.ts, whose labels the browser imports, so the
    browser bundle does not carry the validation library it never runs. */
import { z } from 'zod';
import { STAGES, WAITING_CATEGORIES, EXTERNAL_EVENTS, FUNDS_CHECK_RESULTS } from './caseModel.ts';

const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters.`);
const required = (max: number, message = 'Required.') => text(max).min(1, message);
const optional = (max: number) => text(max).nullish().transform((v) => (v ? v : null));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');
const key = z.string().trim().regex(/^[a-z][a-z0-9_]{0,59}$/, 'Use a short lowercase key.');

const base = {
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
    not_shown: z.boolean().nullish(),
    system: optional(60),
    reference: optional(160),
    observed_on: isoDate.nullish(),
    ...base,
  }),
  z.object({
    kind: z.literal('decision'),
    decision: key,
    choice: key,
    rationale: required(2000, 'Say why.'),
    ...base,
  }),
  z.object({ kind: z.literal('action_prepared'), step: key, reference: optional(160), text: optional(2000), supersedes: base.supersedes }),
  z.object({
    kind: z.literal('action_submitted'),
    step: key,
    reference: optional(160),
    text: optional(2000),
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
  note: required(1000, 'Say what the next person needs to know.'),
  version: z.number().int().nullish(),
});
