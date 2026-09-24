/**
 * The shape of a procedure. Kept apart from the engine (procedures.ts) so procedure definitions in
 * other modules can be typed without importing the registry that collects them.
 */

export type Authority =
  | 'official_policy' | 'official_system_guidance' | 'approved_local_sop' | 'training_reference'
  | 'validated_sme_workflow' | 'sme_walkthrough' | 'historical_case' | 'ai_inference';

/** Strongest first. Local or system guidance never overrides governing policy. */
export const AUTHORITY_ORDER: Authority[] = [
  'official_policy', 'official_system_guidance', 'approved_local_sop', 'training_reference',
  'validated_sme_workflow', 'sme_walkthrough', 'historical_case', 'ai_inference',
];

export const AUTHORITY_LABEL: Record<Authority, string> = {
  official_policy: 'Current official DoD/USMC policy',
  official_system_guidance: 'Official system guidance',
  approved_local_sop: 'Approved local SOP',
  training_reference: 'Formal training reference (FMRAC), not verified against current policy',
  validated_sme_workflow: 'Validated SME workflow',
  sme_walkthrough: 'SME walkthrough, not yet validated',
  historical_case: 'Historical case',
  ai_inference: 'AI inference, not approved',
};

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
  /**
   * The exact screen path in the authoritative system. Left null until an SME confirms it: a
   * guessed menu path is worse than none, because it looks authoritative.
   */
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
  /**
   * A lifecycle figure the source may legitimately leave blank. "Not shown" is recorded as its own
   * fact, because a dash on a report is not a zero in the database.
   */
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
  /**
   * For external steps: the action step(s) whose outcome is being observed, and the event that
   * completes it. With several, the first that applies under the recorded decision is the one.
   */
  observes?: { step?: string; steps?: string[]; completesOn: 'approved' | 'effective' | 'posted' };
  /** For verification steps: the check key recorded. */
  check?: string;
  /** For calculation steps: the formula it runs. */
  formula?: string;
  /** An action step that is complete once prepared; submitting belongs to `submittedAt`. */
  prepareOnly?: { submittedAt: string };
  /** Submitting this step is refused unless this control has passed. */
  gate?: 'funds_check';
  /**
   * Recording this step (a submission, or a decision) is refused until this verification is on
   * the record as verified. How the book's "never without evidence" rules are enforced.
   */
  requires?: { check: string; message: string };
  /** DAI responsibilities that can carry the step out (shared/fmra/roles.ts keys). */
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
  /** The reported condition that starts this work, as the source system words it. */
  trigger: string;
  objective: string;
  authority: Authority;
  source: string;
  reviewed: string | null;
  /** Conditions this procedure has not been validated for. Shown beside it, not hidden in docs. */
  limitations: string[];
  /** Citations for the procedure as a whole. */
  references?: string[];
  /**
   * Verification checks, any one of which lets the case resolve. Default: condition_cleared.
   * Following every step is not the same as the condition clearing.
   */
  resolvesOn?: Array<{ check: string; label: string }>;
  /** What changed from the previous version, when there is one. */
  changes?: string[];
  steps: ProcedureStep[];
}
