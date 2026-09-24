import { parseMoney, sumCents, formatCents } from './money.ts';
import { diagnose } from './fmra/diagnose.ts';
import type { MethodKey } from './fmra/methods.ts';
import type { Procedure, ProcedureStep } from './procedureTypes.ts';
import { FMRA_PROCEDURES, RESOLVES_CLEARED } from './fmraProcedures.ts';

export * from './procedureTypes.ts';

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
 * Every published version stays in the registry. A case is pinned to the version it was started
 * under and keeps running that exact definition; moving it to a newer one is an explicit, attributed
 * migration, never a side effect of a deploy.
 *
 * Authority matters, and each procedure says where it comes from: the 2-Way UMT from one SME
 * walkthrough of a synthetic case, the FMRA procedures from the FMRAC training reference. Questions
 * neither source answers are listed in docs/domain/SME_QUESTIONS.md rather than guessed at in code.
 */

/* ── The 2-Way UMT reference procedure ─────────────────────────────────────────────────────── */

const umt2wayBase = (version: string): Procedure => ({
  key: 'umt_2way_po_qty',
  version,
  short: '2-Way UMT',
  family: 'umt',
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
      key: 'calculate', title: 'Calculate the candidate adjustment', kind: 'calculation', formula: 'umt2way_award_adjustment',
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
      key: 'award_modification', title: 'Prepare the award modification', kind: 'action', prepareOnly: { submittedAt: 'submit_modification' },
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
      key: 'submit_modification', title: 'Submit the modification', kind: 'action', waitsOn: 'approval', gate: 'funds_check',
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
});

/** v0.1.0 as it was first published. Cases started under it keep running exactly this. */
export const UMT_2WAY_V010: Procedure = umt2wayBase('0.1.0');

/**
 * v0.2.0: cross-checked against the FMRAC training reference. A two-way match compares PO and
 * invoice; "PO open qty below DCAS qty" is the book's "billed amount greater than PO line amount",
 * corrected by modifying the award and then matching the payment on the NON-1081 route. The book
 * is explicit that fixing the cause while the payment stays unmatched is not done, so the match is
 * now its own step.
 */
export const UMT_2WAY: Procedure = (() => {
  const base = umt2wayBase('0.2.0');
  const steps = [...base.steps];
  const at = steps.findIndex((s) => s.key === 'verify_invoice');
  steps.splice(at, 0, {
    key: 'non1081_match', title: 'Match the payment to the award (NON-1081)', kind: 'action', waitsOn: 'posting',
    responsibility: ['p2p_unmatched_tbo'],
    help: {
      objective: 'Apply the paid transaction to the corrected award, so the payment is accounted for and not just the cause fixed.',
      system: 'DAI', what: 'Perform the NON-1081 correction: match the paid transaction to the PO/document number. Record the reference.',
      meaning: 'The FMRA performs the NON-1081 route. The work is incomplete if the award is fixed but the payment stays unmatched.',
      done: 'The NON-1081 match is recorded as submitted.', path: null, source: 'FMRAC 11.2-11.3 · orig. pp. 115-117',
    },
  });
  return {
    ...base,
    steps: steps.map((s) => (s.key === 'award_modification' || s.key === 'submit_modification' ? { ...s, responsibility: ['p2p_procurement_analyst'] } : s)),
    references: ['FMRAC 10.1 · orig. pp. 109-113 (two-way match)', 'FMRAC 11.2 · orig. pp. 115-117 (Billed AMT > PO line AMT → modify the award, NON-1081)'],
    limitations: [...base.limitations, 'Cross-checked against the FMRAC training reference; that does not validate it as an approved SOP.'],
    changes: ['Adds the NON-1081 match as its own step before verification (FMRAC 11.2-11.3).', 'Names the DAI responsibility each action needs.'],
  };
})();

/* ── The registry ──────────────────────────────────────────────────────────────────────────── */

const ALL: Procedure[] = [UMT_2WAY_V010, UMT_2WAY, ...FMRA_PROCEDURES];

/** Every published version of every procedure, by key and version. Nothing is ever removed. */
export const PROCEDURE_VERSIONS: Record<string, Record<string, Procedure>> = {};
for (const p of ALL) (PROCEDURE_VERSIONS[p.key] ||= {})[p.version] = p;

const semver = (v: string) => v.split('.').map((n) => Number(n) || 0);
const newer = (a: string, b: string) => { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/** The current (newest) version of each procedure: what a new case is started under. */
export const PROCEDURES: Record<string, Procedure> = Object.fromEntries(
  Object.entries(PROCEDURE_VERSIONS).map(([key, versions]) => [key, Object.values(versions).reduce((a, b) => (newer(b.version, a.version) ? b : a))]),
);

export const PROCEDURE_LIST: Procedure[] = Object.values(PROCEDURES);

/**
 * The definition a case runs. With a version, that exact version or nothing: a case pinned to a
 * version this build does not have is never silently run under a different one.
 */
export function procedureFor(key: string | null | undefined, version?: string | null): Procedure | null {
  if (!key) return null;
  if (version) return PROCEDURE_VERSIONS[key]?.[version] || null;
  return PROCEDURES[key] || null;
}

export interface PinnedProcedure {
  procedure: Procedure | null;
  /** The version the case is pinned to. */
  pinned: string | null;
  /** The key is known but this build lacks the pinned version. */
  unavailable: boolean;
  /** A newer published version exists; migrating is an explicit act. */
  newer: string | null;
}

export function pinnedProcedure(key: string | null | undefined, version: string | null | undefined): PinnedProcedure {
  if (!key) return { procedure: null, pinned: null, unavailable: false, newer: null };
  const pinned = version || PROCEDURES[key]?.version || null;
  const procedure = pinned ? procedureFor(key, pinned) : null;
  const current = PROCEDURES[key];
  return {
    procedure,
    pinned,
    unavailable: Boolean(current) && !procedure,
    newer: current && procedure && newer(current.version, procedure.version) ? current.version : null,
  };
}

/** The checks any one of which permits resolution. */
export const resolutionChecks = (p: Procedure | null) => (p?.resolvesOn?.length ? p.resolvesOn : [RESOLVES_CLEARED]);

/** Every observation field a procedure asks for, across its steps. */
export const fieldsOf = (p: Procedure | null) => (p ? p.steps.flatMap((s) => s.fields || []) : []);

/* ── Reading a case against its procedure ──────────────────────────────────────────────────── */

export interface CaseEvent {
  id: string;
  kind: string;
  actor_id: string | null;
  occurred_at: string;
  body: Record<string, any>;
  supersedes_id?: string | null;
  /** Insertion order on the server. Later events have a larger number. */
  seq?: number;
}

const order = (events: CaseEvent[]) => events.map((e, i) => ({ ...e, seq: e.seq ?? i }));

/** Events still standing: anything a later correction superseded drops out. */
export function standing(events: CaseEvent[]): CaseEvent[] {
  const superseded = new Set(events.map((e) => e.supersedes_id).filter(Boolean) as string[]);
  return events.filter((e) => !superseded.has(e.id));
}

export type StepStatus = 'done' | 'current' | 'upcoming' | 'skipped' | 'attention' | 'conditional';

export interface StepProgress {
  key: string;
  status: StepStatus;
  /** Plain-language reason for the status, when it is not obvious. */
  note: string | null;
  evidence: string[];
}

const latest = (events: CaseEvent[]) => events.reduce<CaseEvent | null>((a, e) => (!a || e.occurred_at >= a.occurred_at ? e : a), null);
const latestBySeq = (events: CaseEvent[]) => events.reduce<CaseEvent | null>((a, e) => (!a || (e.seq ?? 0) >= (a.seq ?? 0) ? e : a), null);

export function decisionOf(events: CaseEvent[], decisionKey: string): CaseEvent | null {
  return latest(standing(events).filter((e) => e.kind === 'decision' && e.body.decision === decisionKey));
}

export function latestFundsCheck(events: CaseEvent[]): CaseEvent | null {
  return latest(standing(events).filter((e) => e.kind === 'funds_check'));
}

export function latestVerification(events: CaseEvent[], check: string): CaseEvent | null {
  return latest(standing(events).filter((e) => e.kind === 'verification' && e.body.check === check));
}

export const isVerified = (events: CaseEvent[], check: string) => latestVerification(events, check)?.body.result === 'verified';

/** Whether a step applies: true, false (a recorded decision excluded it), or null (its decision is not made yet). */
export function stepApplies(step: ProcedureStep, events: CaseEvent[]): boolean | null {
  if (!step.onlyWhen) return true;
  const d = decisionOf(events, step.onlyWhen.decision);
  if (!d) return null;
  return step.onlyWhen.choices.includes(String(d.body.choice));
}

/** For an external step, the action step it observes under the recorded decision. */
export function observedStep(procedure: Procedure, step: ProcedureStep, events: CaseEvent[]): string | null {
  const keys = step.observes?.steps || (step.observes?.step ? [step.observes.step] : []);
  for (const key of keys) {
    const target = procedure.steps.find((s) => s.key === key);
    if (target && stepApplies(target, events) !== false) return key;
  }
  return keys[0] || null;
}

/** Whether the case meets its procedure's resolution rule, and on which check. */
export function resolutionMet(procedure: Procedure | null, events: CaseEvent[]): { ok: boolean; check: string | null } {
  for (const r of resolutionChecks(procedure)) if (isVerified(events, r.check)) return { ok: true, check: r.check };
  return { ok: false, check: null };
}

/** Says, for each step, whether the case has the evidence for it. Never infers a decision. */
export function progress(procedure: Procedure, allEvents: CaseEvent[], item: { reference?: string | null; stage?: string | null }): { steps: StepProgress[]; next: string | null } {
  const events = standing(order(allEvents));
  const obs = (field: string) => events.filter((e) => e.kind === 'observation' && e.body.field === field);
  const out: StepProgress[] = [];
  let next: string | null = null;

  for (const step of procedure.steps) {
    let status: StepStatus = 'upcoming';
    let note: string | null = null;
    let evidence: string[] = [];

    if (step.onlyWhen) {
      const applies = stepApplies(step, events);
      const d = decisionOf(events, step.onlyWhen.decision);
      if (applies === false) {
        out.push({ key: step.key, status: 'skipped', note: 'Not needed under the recorded decision.', evidence: d ? [d.id] : [] });
        continue;
      }
      if (applies === null) {
        out.push({ key: step.key, status: 'conditional', note: 'Depends on a decision not made yet.', evidence: [] });
        continue;
      }
    }

    switch (step.kind) {
      case 'research': {
        const fields = step.fields || [];
        const required = fields.filter((f) => !f.optional);
        const hits = fields.map((f) => obs(f.key));
        evidence = hits.flat().map((e) => e.id);
        const stepNotes = events.filter((e) => (e.kind === 'finding' || e.kind === 'note') && e.body.step === step.key);
        const complete = required.length
          ? required.every((f) => obs(f.key).length > 0 || (f.key === 'document_number' && Boolean(item.reference)))
          : evidence.length > 0 || stepNotes.length > 0;
        evidence.push(...stepNotes.map((e) => e.id));
        if (complete) status = 'done';
        break;
      }
      case 'calculation': {
        const formula = step.formula || UMT_FORMULA.key;
        const calc = latestBySeq(events.filter((e) => e.kind === 'calculation' && e.body.formula === formula));
        if (calc) {
          evidence = [calc.id];
          const state = calculationState(calc, events);
          if (state.stale) { status = 'attention'; note = `Inputs changed since this calculation: ${state.reasons.join('; ')}. Calculate again.`; }
          else status = 'done';
        }
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
        if (step.prepareOnly) {
          // Preparing is this step; submitting is the next one.
          const anySubmit = events.some((e) => e.kind === 'action_submitted' && e.body.step === step.prepareOnly!.submittedAt);
          if (prepared.length || anySubmit) { status = 'done'; evidence = prepared.map((e) => e.id); }
        } else if (submitted.length) { status = 'done'; evidence = submitted.map((e) => e.id); }
        else if (prepared.length) { note = 'Prepared, not submitted.'; evidence = prepared.map((e) => e.id); }
        break;
      }
      case 'external': {
        const target = observedStep(procedure, step, events);
        const observed = events.filter((e) => e.kind === 'external_event' && e.body.step === target);
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

/* ── Calculations ─────────────────────────────────────────────────────────────────────────── */

export interface CalcInput { event_id: string; field: string; label: string; cents: number | null; source: 'manual_observation' | 'source_file' | 'user_entry'; not_shown?: boolean }

export interface Formula {
  key: string;
  version: string;
  title: string;
  text: string;
  applicability: string;
  /** The observation fields the formula reads. A newer standing reading of any makes a result stale. */
  inputs: string[];
  compute: (events: CaseEvent[]) => ({ ok: true; inputs: CalcInput[]; display: string; requires_review: boolean } & Record<string, unknown>) | { ok: false; missing: string[] };
}

export const UMT_FORMULA = {
  key: 'umt2way_award_adjustment',
  version: '0.1.0',
  title: 'Candidate award adjustment',
  text: 'invoice total = sum of observed invoices; target award = invoice total + UMT amount; adjustment = target award − current award',
  applicability: 'Candidate only. Applicability to this case is not validated; the direction of the result does not authorize any action.',
} as const;

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

const sourceOf = (e: CaseEvent): CalcInput['source'] => (e.body.source === 'source_file' ? 'source_file' : e.body.source === 'user_entry' ? 'user_entry' : 'manual_observation');

/**
 * Computes the candidate figures from the observations standing on the case. Every input is named
 * by the event it came from, so the result can be traced back to what somebody read and where.
 */
export function candidateAdjustment(allEvents: CaseEvent[]): CandidateCalculation | { ok: false; missing: string[] } {
  const events = standing(allEvents);
  const obs = (field: string) => events.filter((e) => e.kind === 'observation' && e.body.field === field && Number.isSafeInteger(e.body.amount_cents));
  const latestOf = (field: string) => latest(obs(field));
  // The same invoice observed twice (a second analyst re-reading it, say) is one invoice, not two.
  // Observations that name the same invoice reference collapse to the latest; unreferenced ones each count.
  const byReference = new Map<string, CaseEvent>();
  const unreferenced: CaseEvent[] = [];
  for (const e of obs('invoice_amount')) {
    const ref = String(e.body.reference || '').trim().toUpperCase();
    if (!ref) { unreferenced.push(e); continue; }
    const prior = byReference.get(ref);
    if (!prior || e.occurred_at >= prior.occurred_at) byReference.set(ref, e);
  }
  const invoices = [...byReference.values(), ...unreferenced];
  const award = latestOf('current_award');
  const umt = latestOf('umt_amount');
  const missing = [
    !award && 'current award amount',
    !invoices.length && 'at least one invoice amount',
    !umt && 'UMT source amount',
  ].filter(Boolean) as string[];
  if (missing.length) return { ok: false, missing };

  const input = (e: CaseEvent, label: string): CalcInput => ({ event_id: e.id, field: String(e.body.field), label, cents: e.body.amount_cents, source: sourceOf(e) });
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

const LIFECYCLE = [
  ['commitment_amount', 'Commitment'], ['obligation_amount', 'Obligation'], ['delivered_amount', 'Delivered'], ['paid_amount', 'Paid'],
] as const;

/** The open residual between lifecycle phases, read through the FMRA diagnoser. */
export function lifecycleResidual(allEvents: CaseEvent[]) {
  const events = standing(order(allEvents));
  const latestOf = (field: string) => latestBySeq(events.filter((e) => e.kind === 'observation' && e.body.field === field));
  const missing: string[] = [];
  const inputs: CalcInput[] = [];
  const cents: Record<string, number | null> = {};
  for (const [field, label] of LIFECYCLE) {
    const e = latestOf(field);
    if (!e) { missing.push(label.toLowerCase()); continue; }
    const notShown = Boolean(e.body.not_shown);
    cents[field] = notShown ? null : Number.isSafeInteger(e.body.amount_cents) ? e.body.amount_cents : null;
    inputs.push({ event_id: e.id, field, label, cents: cents[field], source: sourceOf(e), not_shown: notShown || undefined });
  }
  if (missing.length) return { ok: false as const, missing };
  const methodEvent = latestOf('purchase_method');
  const method = (methodEvent?.body.value_text || null) as MethodKey | null;
  const d = diagnose({ method, commitment: cents.commitment_amount, obligation: cents.obligation_amount, delivered: cents.delivered_amount, paid: cents.paid_amount });
  if (!d.ok) return { ok: false as const, missing: [d.error] };
  const headline = d.findings.map((f) => `${f.abbr} ${formatCents(f.residualCents)} open (${f.pattern})`);
  const odd = d.anomalies.map((a) => a.title);
  return {
    ok: true as const,
    inputs: methodEvent ? [...inputs, { event_id: methodEvent.id, field: 'purchase_method', label: 'Purchase method', cents: null, source: sourceOf(methodEvent) }] : inputs,
    method,
    findings: d.findings.map((f) => ({ condition: f.condition, abbr: f.abbr, name: f.name, pattern: f.pattern, residual_cents: f.residualCents, arithmetic: f.arithmetic })),
    anomalies: d.anomalies.map((a) => ({ key: a.key, title: a.title, detail: a.detail })),
    complete: d.complete,
    display: d.complete ? 'Nothing open between phases' : [...headline, ...odd].join('; ') || 'No residual',
    requires_review: d.anomalies.length > 0,
  };
}

/** How far a billed amount exceeds its PO line. A candidate: the bill is validated separately. */
export function awardShortfall(allEvents: CaseEvent[]) {
  const events = standing(order(allEvents));
  const latestOf = (field: string) => latestBySeq(events.filter((e) => e.kind === 'observation' && e.body.field === field && Number.isSafeInteger(e.body.amount_cents)));
  const po = latestOf('po_line_amount');
  const billed = latestOf('billed_amount');
  const missing = [!po && 'PO line amount', !billed && 'billed amount'].filter(Boolean) as string[];
  if (missing.length) return { ok: false as const, missing };
  const shortfall = sumCents([billed!.body.amount_cents, -po!.body.amount_cents]);
  return {
    ok: true as const,
    inputs: [
      { event_id: po!.id, field: 'po_line_amount', label: 'PO line amount', cents: po!.body.amount_cents, source: sourceOf(po!) },
      { event_id: billed!.id, field: 'billed_amount', label: 'Billed amount', cents: billed!.body.amount_cents, source: sourceOf(billed!) },
    ],
    po_line_cents: po!.body.amount_cents,
    billed_cents: billed!.body.amount_cents,
    shortfall_cents: shortfall,
    direction: shortfall > 0 ? 'upward' : shortfall === 0 ? 'zero' : 'downward',
    display: `${formatCents(shortfall, { signed: true })} (billed ${formatCents(billed!.body.amount_cents)})`,
    requires_review: shortfall <= 0,
  };
}

export const FORMULAS: Record<string, Formula> = {
  [UMT_FORMULA.key]: { ...UMT_FORMULA, inputs: ['current_award', 'invoice_amount', 'umt_amount'], compute: (e) => candidateAdjustment(e) as never },
  lifecycle_residual: {
    key: 'lifecycle_residual', version: '1.0.0', title: 'Open residual between lifecycle phases',
    text: 'OCMT = commitment − obligation; UDOU = obligation − delivered; DOU = delivered − paid; OTO = travel obligation − paid',
    applicability: 'The FMRAC’s editorial arithmetic for its examples. It names the gap; it never diagnoses the cause. Figures must share one document, line and scope.',
    inputs: ['commitment_amount', 'obligation_amount', 'delivered_amount', 'paid_amount', 'purchase_method'],
    compute: (e) => lifecycleResidual(e) as never,
  },
  umt_award_shortfall: {
    key: 'umt_award_shortfall', version: '1.0.0', title: 'Award shortfall against the bill',
    text: 'shortfall = billed amount − PO line amount',
    applicability: 'A candidate. Validate the billed amount before modifying the award (FMRAC 11.2). A negative or zero result needs review.',
    inputs: ['po_line_amount', 'billed_amount'],
    compute: (e) => awardShortfall(e) as never,
  },
};

/**
 * Whether a recorded calculation still reflects the case. A calculation is a snapshot: once an
 * input it used is corrected, or a newer reading of one of its inputs is recorded, it no longer
 * describes the case and is marked stale until somebody calculates again.
 */
export function calculationState(calc: CaseEvent, allEvents: CaseEvent[]): { stale: boolean; reasons: string[] } {
  const events = order(allEvents);
  const calcSeq = events.find((e) => e.id === calc.id)?.seq ?? calc.seq ?? Infinity;
  const superseded = new Set(events.map((e) => e.supersedes_id).filter(Boolean) as string[]);
  const inputs: CalcInput[] = Array.isArray(calc.body.inputs) ? calc.body.inputs : [];
  const inputIds = new Set(inputs.map((i) => i.event_id));
  const formula = FORMULAS[String(calc.body.formula)];
  const fields = new Set(formula?.inputs || inputs.map((i) => i.field));
  const reasons: string[] = [];
  const corrected = inputs.filter((i) => superseded.has(i.event_id));
  if (corrected.length) reasons.push(`${corrected.map((i) => i.label).join(', ')} ${corrected.length === 1 ? 'was' : 'were'} corrected`);
  const newer = standing(events).filter((e) => e.kind === 'observation' && fields.has(String(e.body.field)) && (e.seq ?? 0) > calcSeq && !inputIds.has(e.id));
  if (newer.length) reasons.push(`${newer.length} newer ${newer.length === 1 ? 'reading was' : 'readings were'} recorded`);
  return { stale: reasons.length > 0, reasons };
}

/** Parses an observation amount for storage. Exposed so server and tests share one rule. */
export function observationCents(amount: unknown): { ok: true; cents: number } | { ok: false; error: string } | null {
  if (amount === null || amount === undefined || amount === '') return null;
  return parseMoney(amount);
}

/* ── Suggesting a procedure ───────────────────────────────────────────────────────────────── */

const SUGGESTIONS: Array<{ key: string; test: RegExp; why: string }> = [
  { key: 'umt_2way_po_qty', test: /2\s*-?\s*WAY\s+PO\s+MATCH.*open\s+qty.*less\s+than.*DCAS\s+qty/i, why: 'The trigger text is the 2-Way UMT: PO open quantity below DCAS quantity.' },
  { key: 'umt_four_stage', test: /no matching record|billed\s*am(ou)?n?t\s+is\s+greater|not enough qty received|not in approved status|data elements do not match|unmatched|\bUMT\b|1081/i, why: 'The text names an unmatched-transaction error.' },
  { key: 'invoice_hold', test: /invoices?\s+on\s+hold|\bhold\b.*invoice|quantity billed exceeds/i, why: 'The text names an invoice hold.' },
  { key: 'feeder_reject', test: /\breject(ed)?\b|budget journal|costjon|\bLOA\b.*mismatch|BFS error/i, why: 'The text names a feeder-system reject.' },
  { key: 'interface_error', test: /interface error|alias table|alias not loaded|fuel key|servmart/i, why: 'The text names an interface error on an alias-mapped feed.' },
  { key: 'oto_research', test: /\bOTO\b|outstanding travel/i, why: 'The text names an outstanding travel order.' },
  { key: 'dou_research', test: /\bDOU\b|delivered order,?\s+unpaid/i, why: 'The text names a delivered order, unpaid.' },
  { key: 'udou_research', test: /\bUDOU\b|undelivered order/i, why: 'The text names an undelivered order, unpaid.' },
  { key: 'ocmt_research', test: /\bOCMT\b|open commitment|outstanding commitment|mipr acknowledg/i, why: 'The text names an open commitment.' },
];

/** A procedure that fits the text of a work item, with why. A suggestion; a person applies it. */
export function suggestProcedure(...texts: Array<string | null | undefined>): { key: string; why: string } | null {
  const text = texts.filter(Boolean).join(' \n ');
  if (!text.trim()) return null;
  for (const s of SUGGESTIONS) if (s.test.test(text)) return { key: s.key, why: s.why };
  return null;
}
