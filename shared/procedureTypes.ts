export type Authority =
  | 'official_policy' | 'official_system_guidance' | 'approved_local_sop' | 'training_reference'
  | 'validated_sme_workflow' | 'sme_walkthrough' | 'historical_case' | 'vantage_inference' | 'ai_inference';


export const AUTHORITY_LABEL: Record<Authority, string> = {
  official_policy: 'Current official DoD/USMC policy',
  official_system_guidance: 'Official system guidance',
  approved_local_sop: 'Approved local SOP',
  training_reference: 'Formal training reference (FMRAC), not verified against current policy',
  validated_sme_workflow: 'Validated SME workflow',
  sme_walkthrough: 'SME walkthrough, not yet validated',
  historical_case: 'Historical case',
  vantage_inference: 'Inference by Vantage from the words on the case, not a source',
  ai_inference: 'AI inference, not approved',
};

/**
 * The order sources are weighed in when they speak to the same question (VANTAGE_CLAUDE_MASTER Task 16, ADR-0022):
 * official policy, official system guidance, an approved command SOP, a validated SME workflow, a validated historical
 * case, then inference. Two authorities Vantage already carried sit between those six without a number of their own: the
 * FMRAC training reference ranks below a validated SME workflow, since it is not verified against current policy, and an
 * SME walkthrough nobody has validated ranks below a validated case. Inference, whether Vantage's own reading of the words
 * or an AI draft, is always last and is never shown as policy.
 */
export interface ProvenanceTier {
  authority: Authority;
  /** 1 is weighed first. */
  rank: number;
  /** The specification's tier, 1 to 6, or null for the two that sit between tiers. */
  tier: 1 | 2 | 3 | 4 | 5 | 6 | null;
  label: string;
  /** What a reader should keep in mind about this kind of source. */
  caution: string | null;
}

export const PROVENANCE: readonly ProvenanceTier[] = [
  { authority: 'official_policy', rank: 1, tier: 1, label: 'Official policy', caution: null },
  { authority: 'official_system_guidance', rank: 2, tier: 2, label: 'Official system guidance', caution: null },
  { authority: 'approved_local_sop', rank: 3, tier: 3, label: 'Approved command SOP', caution: 'Binds this command only.' },
  { authority: 'validated_sme_workflow', rank: 4, tier: 4, label: 'Validated SME workflow', caution: null },
  { authority: 'training_reference', rank: 5, tier: null, label: 'Training reference (FMRAC)', caution: 'A training reference, not verified against current policy. Its thresholds and routing are the book’s printed values.' },
  { authority: 'historical_case', rank: 6, tier: 5, label: 'Validated historical case', caution: 'One case. It shows what was true then, not a rule.' },
  { authority: 'sme_walkthrough', rank: 7, tier: null, label: 'SME walkthrough, not yet validated', caution: 'Validated against one synthetic case only.' },
  { authority: 'vantage_inference', rank: 8, tier: 6, label: 'Inference', caution: 'Vantage read the words on the case. It is a lead to check, never policy.' },
  { authority: 'ai_inference', rank: 9, tier: 6, label: 'Inference (AI draft)', caution: 'An AI draft. It is a lead to check, never policy.' },
];

export const provenanceOf = (authority: Authority): ProvenanceTier => PROVENANCE.find((p) => p.authority === authority) ?? PROVENANCE[PROVENANCE.length - 1];

export interface StepHelp {
  /** Why this step exists. */
  objective: string;
  /** Which system the work happens in. */
  system?: string;
  /** What to read or enter, in plain terms. */
  what: string;
  /** What the value means financially. */
  meaning?: string;
  /** How you know the step is done. */
  done: string;
  path: string | null;
  /** Where the guidance comes from, e.g. "FMRAC 11.2 · orig. pp. 115-117". */
  source?: string;
}

export interface ProcedureField {
  key: string;
  label: string;
  /** An amount in exact cents. */
  money?: boolean;
  /** More than one observation is expected (invoices). */
  multiple?: boolean;
  /** The step can be done without it. */
  optional?: boolean;
  allowNotShown?: boolean;
  /** Choose one of these; stored as the option key. */
  options?: Array<{ key: string; label: string }>;
  /** A count rather than money. */
  quantity?: boolean;
  hint?: string;
}

export type StepKind = 'research' | 'calculation' | 'decision' | 'action' | 'external' | 'control' | 'verification' | 'resolution';

export interface ProcedureStep {
  key: string;
  title: string;
  kind: StepKind;
  /** Observation fields this step asks for. */
  fields?: ProcedureField[];
  /** The decision a decision step records, and its allowed choices. */
  decision?: { key: string; choices: Array<{ key: string; label: string; hint?: string }> };
  /** A step that only applies when an earlier decision chose one of these. */
  onlyWhen?: { decision: string; choices: string[] };
  /** The waiting category a step normally sits in while a system catches up. */
  waitsOn?: 'approval' | 'posting' | 'invoice' | 'documentation' | 'internal_action' | 'external_response';
  observes?: { step?: string; steps?: string[]; completesOn: 'approved' | 'effective' | 'posted' };
  /** For verification steps: the check key recorded. */
  check?: string;
  /** For calculation steps: the formula it runs. */
  formula?: string;
  prepareOnly?: { submittedAt: string };
  /** Submitting this step is refused unless this control has passed. */
  gate?: 'funds_check';
  requires?: { check: string; message: string };
  responsibility?: string[];
  help: StepHelp;
}

export interface Procedure {
  key: string;
  version: string;
  title: string;
  /** A few words for a chip in a list: "UMT", "OCMT". */
  short: string;
  family: 'umt' | 'normal_condition' | 'abnormal_condition';
  trigger: string;
  objective: string;
  authority: Authority;
  source: string;
  reviewed: string | null;
  limitations: string[];
  /** Citations for the procedure as a whole. */
  references?: string[];
  resolvesOn?: Array<{ check: string; label: string }>;
  /** What changed from the previous version, when there is one. */
  changes?: string[];
  steps: ProcedureStep[];
}
