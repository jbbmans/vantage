/** What guidance on file accepts from a request, and how it is shown (ADR-0022). Kept apart from caseDiagnosis.ts, whose
    labels the browser imports, so the browser bundle does not carry the validation library it never runs. */
import { z } from 'zod';
import { GUIDANCE_SECTIONS, ISSUE_KEYS, type GuidanceAuthority, type GuidanceSection, type IssueKey } from './caseDiagnosis.ts';

const text = (max: number) => z.string().trim().max(max, `Keep it under ${max} characters.`);
const required = (max: number, message = 'Required.') => text(max).min(1, message);
const optional = (max: number) => text(max).nullish().transform((v) => (v ? v : null));
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

export const guidanceInputSchema = z.object({
  authority: z.enum(['official_policy', 'official_system_guidance', 'approved_local_sop', 'validated_sme_workflow']),
  issue: z.enum(['any', ...ISSUE_KEYS] as [string, ...string[]]),
  section: z.enum(GUIDANCE_SECTIONS as unknown as [string, ...string[]]),
  text: required(1000, 'Say what the source says to do.'),
  citation: required(300, 'Cite the document and paragraph.'),
  approved_by: optional(200),
  effective_on: isoDate.nullish().transform((v) => v || null),
  supersedes_id: z.string().max(64).nullish().transform((v) => v || null),
});

export type GuidanceInput = {
  authority: GuidanceAuthority; issue: IssueKey | 'any'; section: GuidanceSection; text: string; citation: string;
  approved_by?: string | null; effective_on?: string | null; supersedes_id?: string | null;
};

export const retireSchema = z.object({ reason: required(500, 'Say why.') });

export const exampleSchema = z.object({
  text: required(1000, 'Say what this case shows the next person.'),
  section: z.enum(GUIDANCE_SECTIONS as unknown as [string, ...string[]]).nullish(),
});

/** An entry as the consoles and the case page show it. */
export interface GuidanceRecord {
  id: string;
  authority: GuidanceAuthority;
  issue: IssueKey | 'any';
  section: GuidanceSection;
  text: string;
  citation: string;
  approved_by: string | null;
  effective_on: string | null;
  /** The service's (official policy or system guidance), not one Unit Instance's. */
  enterprise: boolean;
  /** For a validated example: the cause its case was decided on, and its unit. */
  cause: string | null;
  unit: string | null;
  /** For a validated example the reader may open. */
  case: { id: string; title: string; reference: string | null } | null;
  supersedes_id: string | null;
  recorded_by: string;
  recorded_at: string;
  retired_at: string | null;
  retired_by: string | null;
  retired_reason: string | null;
}

/** A case's standing as a validated example, for the case page. */
export interface ExampleState {
  current: GuidanceRecord | null;
  may_validate: boolean;
  /** Why the reader may not mark it, when they may not. */
  reason: string | null;
  may_withdraw: boolean;
}
