import { parseMoney, sumCents, formatCents } from './money.ts';

/**
 * Procedures: how a kind of work is done, kept apart from what actually happened on one case.
 *
 *   Action     a reusable operational mechanism ("amend a requisition").
 *   Procedure  a versioned method: when it applies, its steps, the evidence each needs, and what
 *              counts as resolved.
 *   Case       one work item's events: what was observed, decided, submitted, waited on, verified.
 *
 * A procedure never decides a case. It reads the case's events and says which steps have evidence,
 * which is next, and which were skipped by an explicit decision. The person decides; the procedure
 * keeps the order and the distinctions honest.
 *
 * Authority matters. The only procedure here comes from one SME walkthrough of one synthetic case.
 * It is labelled that way everywhere it appears, and the questions it could not answer are listed
 * in docs/domain/SME_QUESTIONS.md rather than guessed at in code.
 */

export type Authority =
  | 'official_policy' | 'official_system_guidance' | 'approved_local_sop'
  | 'validated_sme_workflow' | 'sme_walkthrough' | 'historical_case' | 'ai_inference';

export const AUTHORITY_LABEL: Record<Authority, string> = {
  official_policy: 'Current official DoD/USMC policy',
  official_system_guidance: 'Official system guidance',
  approved_local_sop: 'Approved local SOP',
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
}

export interface ProcedureStep {
  key: string;
  title: string;
  /** Research, a decision, an action somebody takes, waiting on a system, or a verification. */
  kind: 'research' | 'calculation' | 'decision' | 'action' | 'external' | 'control' | 'verification' | 'resolution';
  /** Observation fields this step asks for. */
  fields?: Array<{ key: string; label: string; money?: boolean; multiple?: boolean }>;
  /** The decision a decision step records, and its allowed choices. */
  decision?: { key: string; choices: Array<{ key: string; label: string }> };
  /** A step that only applies when an earlier decision chose one of these. */
  onlyWhen?: { decision: string; choices: string[] };
  /** The waiting category a step normally sits in while a system catches up. */
  waitsOn?: 'approval' | 'posting' | 'invoice' | 'documentation' | 'internal_action' | 'external_response';
  /** For external steps: the action step whose outcome is being observed, and the event that completes it. */
  observes?: { step: string; completesOn: 'approved' | 'effective' | 'posted' };
  /** For verification steps: the check key recorded. */
  check?: string;
  help: StepHelp;
}

export interface Procedure {
  key: string;
  version: string;
  title: string;
  /** The reported condition that starts this work, as the source system words it. */
  trigger: string;
  objective: string;
  authority: Authority;
  source: string;
  reviewed: string | null;
  /** Conditions this procedure has not been validated for. Shown beside it, not hidden in docs. */
  limitations: string[];
  steps: ProcedureStep[];
}

export const UMT_2WAY: Procedure = {
  key: 'umt_2way_po_qty',
  version: '0.1.0',
  title: '2-Way UMT: PO open quantity below DCAS quantity',
  trigger: '2WAY PO MATCH PO open Qty [value] is less than the DCAS qty [value]',
  objective: 'Get the award to cover what was invoiced so the unmatched transaction clears, with every figure and decision on the record.',
  authority: 'sme_walkthrough',
  source: 'One SME walkthrough of a synthetic 2-Way UMT (Vantage domain notes). Not an approved SOP.',
  reviewed: null,
  limitations: [
    'Validated against one synthetic single-line case only.',
    'Not validated for multi-line awards, partial invoices, zero or downward adjustments, or other UMT types.',
    'The funding-sufficiency comparison is not encoded; the analyst decides and says why.',
    'System screen paths are not documented until an SME confirms them.',
  ],
  steps: [
    {
      key: 'identify', title: 'Identify the item', kind: 'research',
      fields: [{ key: 'document_number', label: 'Document number' }, { key: 'umt_amount', label: 'UMT source amount', money: true }],
      help: {
        objective: 'Pin down exactly which award and transaction the UMT is about before touching anything.',
        system: 'DAI', what: 'Record the document number and the amount the UMT report shows for this line.',
        meaning: 'The UMT amount is the value the system could not match to the award.',
        done: 'Both identifiers are on the record.', path: null,
      },
    },
    {
      key: 'research_award', title: 'Research the award and invoices', kind: 'research',
      fields: [{ key: 'current_award', label: 'Current award amount', money: true }, { key: 'invoice_amount', label: 'Invoice amount', money: true, multiple: true }],
      help: {
        objective: 'Know what the award currently covers and what has actually been invoiced against it.',
        system: 'DAI', what: 'Record the current award amount, and each invoice amount observed against it, one entry per invoice.',
        meaning: 'Invoices are amounts billed; they are not necessarily posted or paid.',
        done: 'The award amount and every observed invoice are recorded.', path: null,
      },
    },
    {
      key: 'record_funding', title: 'Record requisition funding', kind: 'research',
      fields: [{ key: 'requisition_funding', label: 'Requisition funding available', money: true }],
      help: {
        objective: 'Know whether the requisition behind the award can support a larger award.',
        system: 'DAI', what: 'Record the funding the requisition shows as available.',
        meaning: 'Requisition funding is a commitment, not an obligation.',
        done: 'The funding figure is recorded with where it was read.', path: null,
      },
    },
    {
      key: 'calculate', title: 'Calculate the candidate adjustment', kind: 'calculation',
      help: {
        objective: 'See, with every input shown, how far the award is from covering invoices plus the UMT amount.',
        what: 'Vantage adds the recorded invoices and the UMT amount and compares that with the current award.',
        meaning: 'A candidate figure. It does not say the adjustment is allowed or required.',
        done: 'A calculation with its inputs is on the record.', path: null,
      },
    },
    {
      key: 'funding_decision', title: 'Decide on requisition funding', kind: 'decision',
      decision: {
        key: 'funding_decision',
        choices: [
          { key: 'amend_requisition', label: 'Amend the requisition first' },
          { key: 'funding_sufficient', label: 'Funding is sufficient; no amendment' },
          { key: 'refer_for_review', label: 'Refer for review' },
        ],
      },
      help: {
        objective: 'Make the funding call explicitly, with the reason, so a reviewer can follow it.',
        what: 'Compare the requisition funding with the candidate adjustment and choose. Vantage does not make this comparison for you.',
        meaning: 'The exact sufficiency rule is an open SME question.',
        done: 'A decision with a rationale is recorded.', path: null,
      },
    },
    {
      key: 'amend_requisition', title: 'Amend the requisition', kind: 'action',
      onlyWhen: { decision: 'funding_decision', choices: ['amend_requisition'] },
      help: {
        objective: 'Increase the commitment so the award modification can be funded.',
        system: 'DAI', what: 'Prepare and submit the requisition amendment. Record the amendment reference.',
        meaning: 'Increasing a commitment is the business event; the DAI amendment is how it is executed.',
        done: 'The amendment is submitted and its reference recorded.', path: null,
      },
    },
    {
      key: 'amendment_effective', title: 'Amendment approved and effective', kind: 'external', waitsOn: 'approval',
      onlyWhen: { decision: 'funding_decision', choices: ['amend_requisition'] },
      observes: { step: 'amend_requisition', completesOn: 'effective' },
      help: {
        objective: 'Confirm the amendment is in force before building on it.',
        system: 'DAI', what: 'Record when the amendment shows approved, and separately when it shows effective.',
        meaning: 'Approved is not necessarily effective.',
        done: 'The amendment is observed effective.', path: null,
      },
    },
    {
      key: 'award_modification', title: 'Prepare the award modification', kind: 'action',
      help: {
        objective: 'Draft the modification that brings the award to the target amount.',
        system: 'DAI', what: 'Prepare the modification and record its reference. Preparing is not submitting.',
        meaning: 'A drafted modification changes nothing yet.',
        done: 'The modification is prepared and its reference recorded.', path: null,
      },
    },
    {
      key: 'funds_check', title: 'Record the funds check', kind: 'control',
      help: {
        objective: 'Know whether the modification can be funded before it is submitted.',
        system: 'DAI', what: 'Run the funds check and record the exact result.',
        meaning: 'A passed funds check does not obligate funds.',
        done: 'A PASSED result is recorded. Any other result stops submission until resolved.', path: null,
      },
    },
    {
      key: 'submit_modification', title: 'Submit the modification', kind: 'action', waitsOn: 'approval',
      help: {
        objective: 'Send the modification for approval.',
        system: 'DAI', what: 'Submit the prepared modification and record the reference.',
        meaning: 'Submitted is not approved.',
        done: 'The submission is recorded.', path: null,
      },
    },
    {
      key: 'modification_posted', title: 'Modification approved and posted', kind: 'external', waitsOn: 'posting',
      observes: { step: 'submit_modification', completesOn: 'posted' },
      help: {
        objective: 'Confirm the modification took effect in the system of record.',
        system: 'DAI', what: 'Record approval when you see it, and posting separately.',
        meaning: 'Approved is not necessarily posted.',
        done: 'The modification is observed posted.', path: null,
      },
    },
    {
      key: 'verify_invoice', title: 'Verify the invoice posted', kind: 'verification', check: 'invoice_posted', waitsOn: 'invoice',
      help: {
        objective: 'Confirm the invoice that caused the mismatch has now posted against the award.',
        system: 'DAI', what: 'Look up the invoice and record what you saw and where.',
        meaning: 'An expected invoice is not a posted invoice.',
        done: 'A verified result with a reference is recorded.', path: null,
      },
    },
    {
      key: 'verify_cleared', title: 'Verify the UMT cleared', kind: 'verification', check: 'condition_cleared',
      help: {
        objective: 'Confirm the original condition is gone, not just that every step was followed.',
        system: 'DAI', what: 'Check the UMT report for this line and record what it shows.',
        meaning: 'Following the procedure is not the same as the condition clearing.',
        done: 'A verified result with a reference is recorded.', path: null,
      },
    },
    {
      key: 'resolve', title: 'Resolve', kind: 'resolution',
      help: {
        objective: 'Close the case on the evidence.',
        what: 'Resolve once the UMT is verified cleared.',
        done: 'The case is resolved.', path: null,
      },
    },
  ],
};

export const PROCEDURES: Record<string, Procedure> = { [UMT_2WAY.key]: UMT_2WAY };
export const procedureFor = (key: string | null | undefined) => (key ? PROCEDURES[key] || null : null);

/* ── Reading a case against its procedure ──────────────────────────────────────────────────── */

export interface CaseEvent {
  id: string;
  kind: string;
  actor_id: string | null;
  occurred_at: string;
  body: Record<string, any>;
  supersedes_id?: string | null;
}

/** Events still standing: anything a later correction superseded drops out. */
export function standing(events: CaseEvent[]): CaseEvent[] {
  const superseded = new Set(events.map((e) => e.supersedes_id).filter(Boolean) as string[]);
  return events.filter((e) => !superseded.has(e.id));
}

export type StepStatus = 'done' | 'current' | 'upcoming' | 'skipped' | 'attention';

export interface StepProgress {
  key: string;
  status: StepStatus;
  /** Plain-language reason for the status, when it is not obvious. */
  note: string | null;
  evidence: string[];
}

const latest = (events: CaseEvent[]) => events.reduce<CaseEvent | null>((a, e) => (!a || e.occurred_at >= a.occurred_at ? e : a), null);

export function decisionOf(events: CaseEvent[], decisionKey: string): CaseEvent | null {
  return latest(standing(events).filter((e) => e.kind === 'decision' && e.body.decision === decisionKey));
}

export function latestFundsCheck(events: CaseEvent[]): CaseEvent | null {
  return latest(standing(events).filter((e) => e.kind === 'funds_check'));
}

export function latestVerification(events: CaseEvent[], check: string): CaseEvent | null {
  return latest(standing(events).filter((e) => e.kind === 'verification' && e.body.check === check));
}

/** Says, for each step, whether the case has the evidence for it. Never infers a decision. */
export function progress(procedure: Procedure, allEvents: CaseEvent[], item: { reference?: string | null; stage?: string | null }): { steps: StepProgress[]; next: string | null } {
  const events = standing(allEvents);
  const obs = (field: string) => events.filter((e) => e.kind === 'observation' && e.body.field === field);
  const out: StepProgress[] = [];
  let next: string | null = null;

  for (const step of procedure.steps) {
    let status: StepStatus = 'upcoming';
    let note: string | null = null;
    let evidence: string[] = [];

    if (step.onlyWhen) {
      const d = decisionOf(events, step.onlyWhen.decision);
      if (d && !step.onlyWhen.choices.includes(String(d.body.choice))) {
        out.push({ key: step.key, status: 'skipped', note: 'Not needed under the recorded decision.', evidence: [d.id] });
        continue;
      }
    }

    switch (step.kind) {
      case 'research': {
        const fields = step.fields || [];
        const hits = fields.map((f) => obs(f.key));
        const complete = fields.every((f, i) => hits[i].length > 0 || (f.key === 'document_number' && Boolean(item.reference)));
        evidence = hits.flat().map((e) => e.id);
        if (complete) status = 'done';
        break;
      }
      case 'calculation': {
        const calc = latest(events.filter((e) => e.kind === 'calculation' && e.body.formula === UMT_FORMULA.key));
        if (calc) { status = 'done'; evidence = [calc.id]; }
        break;
      }
      case 'decision': {
        const d = step.decision ? decisionOf(events, step.decision.key) : null;
        if (d) {
          evidence = [d.id];
          if (d.body.choice === 'refer_for_review') { status = 'attention'; note = 'Referred for review.'; }
          else status = 'done';
        }
        break;
      }
      case 'action': {
        const submitted = events.filter((e) => e.kind === 'action_submitted' && e.body.step === step.key);
        const prepared = events.filter((e) => e.kind === 'action_prepared' && e.body.step === step.key);
        // Preparing the modification is its own step; submitting it is the next.
        if (step.key === 'award_modification') {
          const anySubmit = events.some((e) => e.kind === 'action_submitted' && e.body.step === 'submit_modification');
          if (prepared.length || anySubmit) { status = 'done'; evidence = prepared.map((e) => e.id); }
        } else if (submitted.length) { status = 'done'; evidence = submitted.map((e) => e.id); }
        else if (prepared.length) { note = 'Prepared, not submitted.'; evidence = prepared.map((e) => e.id); }
        break;
      }
      case 'external': {
        const observed = events.filter((e) => e.kind === 'external_event' && e.body.step === step.observes?.step);
        evidence = observed.map((e) => e.id);
        const bad = observed.find((e) => e.body.event === 'rejected' || e.body.event === 'returned');
        if (observed.some((e) => e.body.event === step.observes?.completesOn)) status = 'done';
        else if (bad) { status = 'attention'; note = `Reported ${bad.body.event}.`; }
        else if (observed.some((e) => e.body.event === 'approved')) note = `Approved, not yet ${step.observes?.completesOn}.`;
        break;
      }
      case 'control': {
        const check = latestFundsCheck(events);
        if (check) {
          evidence = [check.id];
          if (check.body.result === 'PASSED') status = 'done';
          else { status = 'attention'; note = `Latest result ${check.body.result}. Submission waits on a PASSED check.`; }
        }
        break;
      }
      case 'verification': {
        const v = step.check ? latestVerification(events, step.check) : null;
        if (v) {
          evidence = [v.id];
          if (v.body.result === 'verified') status = 'done';
          else { status = 'attention'; note = 'Checked and not verified.'; }
        }
        break;
      }
      case 'resolution': {
        const r = latest(events.filter((e) => e.kind === 'resolved'));
        if (r && item.stage === 'resolved') { status = 'done'; evidence = [r.id]; }
        break;
      }
    }
    if ((status === 'upcoming' || status === 'attention') && !next) { next = step.key; if (status === 'upcoming') status = 'current'; }
    out.push({ key: step.key, status, note, evidence });
  }
  return { steps: out, next };
}

/* ── The candidate calculation ─────────────────────────────────────────────────────────────── */

export const UMT_FORMULA = {
  key: 'umt2way_award_adjustment',
  version: '0.1.0',
  title: 'Candidate award adjustment',
  text: 'invoice total = sum of observed invoices; target award = invoice total + UMT amount; adjustment = target award − current award',
  applicability: 'Candidate only. Applicability to this case is not validated; the direction of the result does not authorize any action.',
} as const;

export interface CalcInput { event_id: string; field: string; label: string; cents: number; source: 'manual_observation' | 'source_file' }

export interface CandidateCalculation {
  ok: true;
  formula: typeof UMT_FORMULA.key;
  version: string;
  inputs: CalcInput[];
  invoice_total_cents: number;
  umt_amount_cents: number;
  current_award_cents: number;
  target_award_cents: number;
  adjustment_cents: number;
  /** Which way the arithmetic points. A description, never a permission. */
  direction: 'upward' | 'zero' | 'downward';
  /** Zero and downward results are not validated and always need review. */
  requires_review: boolean;
  display: string;
}

/**
 * Computes the candidate figures from the observations standing on the case. Every input is named
 * by the event it came from, so the result can be traced back to what somebody read and where.
 */
export function candidateAdjustment(allEvents: CaseEvent[]): CandidateCalculation | { ok: false; missing: string[] } {
  const events = standing(allEvents);
  const obs = (field: string) => events.filter((e) => e.kind === 'observation' && e.body.field === field && Number.isSafeInteger(e.body.amount_cents));
  const latestOf = (field: string) => latest(obs(field));
  const invoices = obs('invoice_amount');
  const award = latestOf('current_award');
  const umt = latestOf('umt_amount');
  const missing = [
    !award && 'current award amount',
    !invoices.length && 'at least one invoice amount',
    !umt && 'UMT source amount',
  ].filter(Boolean) as string[];
  if (missing.length) return { ok: false, missing };

  const input = (e: CaseEvent, label: string): CalcInput => ({ event_id: e.id, field: String(e.body.field), label, cents: e.body.amount_cents, source: e.body.source === 'source_file' ? 'source_file' : 'manual_observation' });
  const inputs = [
    input(award!, 'Current award'),
    ...invoices.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)).map((e, i) => input(e, `Invoice ${i + 1}${e.body.reference ? ` (${e.body.reference})` : ''}`)),
    input(umt!, 'UMT source amount'),
  ];
  const invoiceTotal = sumCents(invoices.map((e) => e.body.amount_cents));
  const target = sumCents([invoiceTotal, umt!.body.amount_cents]);
  const adjustment = sumCents([target, -award!.body.amount_cents]);
  const direction = adjustment > 0 ? 'upward' : adjustment === 0 ? 'zero' : 'downward';
  return {
    ok: true,
    formula: UMT_FORMULA.key,
    version: UMT_FORMULA.version,
    inputs,
    invoice_total_cents: invoiceTotal,
    umt_amount_cents: umt!.body.amount_cents,
    current_award_cents: award!.body.amount_cents,
    target_award_cents: target,
    adjustment_cents: adjustment,
    direction,
    requires_review: direction !== 'upward',
    display: `${formatCents(adjustment, { signed: true })} (target ${formatCents(target)})`,
  };
}

/** Parses an observation amount for storage. Exposed so server and tests share one rule. */
export function observationCents(amount: unknown): { ok: true; cents: number } | { ok: false; error: string } | null {
  if (amount === null || amount === undefined || amount === '') return null;
  return parseMoney(amount);
}
