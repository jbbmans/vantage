import { formatCents } from '../money.ts';
import { cite, citeText, type Cite } from './source.ts';
import { METHODS, type MethodKey } from './methods.ts';
import {
  NORMAL_CONDITIONS, UMT_ERRORS, UMT_INSUFFICIENT_FUNDS, INVOICE_HOLDS, FEEDER_REJECTS, INTERFACE_ERRORS, ROUTES,
  type NormalKey, type Cause,
} from './conditions.ts';
import { WORK_RESPONSIBILITY, responsibilityName, type WorkResponsibility } from './roles.ts';

/**
 * The diagnoser: reads the four lifecycle figures for one document and answers the way the FMRAC
 * says an analyst (or an AI) should — condition and evidence first, then the supported next action:
 *
 *   1. Observed condition      what the figures actually show
 *   2. Financial meaning       which phase or gap they represent
 *   3. Possible causes         which source-supported explanations remain plausible
 *   4. Required research       what evidence tells those causes apart
 *   5. Responsible role        who can research, prepare, approve or post
 *   6. Next action             the supported correction or follow-up
 *   7. Wait / verification     what has to happen next, and what proves resolution
 *   8. References and limits   where it comes from, and what is missing
 *
 * It never presents a classroom example as a live balance, a printed threshold as current policy,
 * a requested action as an executed change, or a likely cause as a proven fact. The arithmetic is
 * the book's editorial arithmetic for its examples; it narrows the question, it does not answer it.
 *
 * Amounts are whole cents. `null` means the figure is not shown — which is not the same as zero.
 */

export interface BalanceInput {
  method?: MethodKey | null;
  commitment?: number | null;
  obligation?: number | null;
  delivered?: number | null;
  paid?: number | null;
  /** Days since the document was created or last moved, if known. */
  ageDays?: number | null;
  /** An exact error label from a report, when one is in hand. */
  error?: { kind: ErrorKind; key: string } | null;
}

export type ErrorKind = 'umt' | 'hold' | 'reject_dts' | 'reject_gcss' | 'interface';

export interface Finding {
  condition: NormalKey;
  abbr: string;
  name: string;
  pattern: 'full' | 'partial';
  residualCents: number;
  /** The subtraction that produced the residual, with the figures in it. */
  arithmetic: string;
  whatIsOpen: string;
  firstQuestion: string;
}

export interface Anomaly {
  key: string;
  title: string;
  detail: string;
  /** Where to look first. */
  research: string;
  procedure: string | null;
}

export interface CauseOption extends Cause {
  condition: NormalKey;
  roles: string[];
}

export interface Diagnosis {
  ok: true;
  observed: string;
  meaning: string;
  findings: Finding[];
  anomalies: Anomaly[];
  complete: boolean;
  causes: CauseOption[];
  research: string[];
  roles: string[];
  next: string[];
  verification: string[];
  /** Evidence (KSD) to pull for this method and these conditions. */
  evidence: Array<{ group: string; items: string[] }>;
  error: { label: string; correction: string; route: string | null; validate: string | null } | null;
  references: string[];
  limits: string[];
  /** The Vantage procedure that fits best, if any. The analyst decides whether to use it. */
  procedure: string | null;
}

export type DiagnosisResult = Diagnosis | { ok: false; error: string };

const PROCEDURE_FOR: Record<NormalKey, string> = { ocmt: 'ocmt_research', udou: 'udou_research', dou: 'dou_research', oto: 'oto_research' };

const shown = (v: number | null | undefined): v is number => v !== null && v !== undefined;
const amt = (v: number | null | undefined) => (shown(v) ? formatCents(v) : '—');

export function diagnose(input: BalanceInput): DiagnosisResult {
  const { commitment: c, obligation: o, delivered: d, paid: p } = input;
  const figures = [c, o, d, p];
  if (figures.every((v) => !shown(v)) && !input.error) return { ok: false, error: 'Enter at least one amount, or an error label from a report.' };
  for (const v of figures) {
    if (shown(v) && (!Number.isSafeInteger(v) || v < 0)) return { ok: false, error: 'Amounts must be whole, non-negative cents. Record a reversal or credit as its own observation.' };
  }
  const method = input.method ? METHODS[input.method] : null;
  const travel = input.method === 'tdy';
  const z = (v: number | null | undefined) => (shown(v) ? v : 0);

  const findings: Finding[] = [];
  const anomalies: Anomaly[] = [];
  const limits: string[] = [
    'Classroom reasoning from a training reference, not current policy. The figures narrow the question; they do not prove a cause.',
    'Use one consistent document, line and accounting scope, and tell cumulative totals from remaining balances before relying on the subtraction.',
  ];
  const references = new Set<string>();

  const add = (key: NormalKey, residual: number, pattern: 'full' | 'partial', arithmetic: string) => {
    const def = NORMAL_CONDITIONS[key];
    findings.push({ condition: key, abbr: def.abbr, name: def.name, pattern, residualCents: residual, arithmetic, whatIsOpen: def.whatIsOpen, firstQuestion: def.firstQuestion });
    references.add(citeText(def.cite));
  };

  if (travel) {
    // A travel obligation is read against payment directly. The book's OTO examples deliberately
    // show no commitment, so a blank commitment is not an error here.
    if (shown(o) && o > z(p)) add('oto', o - z(p), z(p) > 0 || z(d) > 0 ? 'partial' : 'full', `obligation ${amt(o)} − paid ${amt(shown(p) ? p : 0)}`);
    if (shown(c)) limits.push('A commitment is shown on travel. The book’s OTO examples carry none; read it against the actual DTS configuration rather than as an extra phase.');
    if (shown(p) && shown(o) && p > o) anomalies.push({ key: 'paid_exceeds_obligation', title: 'Paid exceeds the travel obligation', detail: `${amt(p)} paid against ${amt(o)} obligated.`, research: 'Check the voucher, any automatic DAI award adjustment to the receipt amount, and the interface status. Voucher costs can differ from the estimate.', procedure: 'oto_research' });
  } else {
    if (shown(c) && c > z(o)) add('ocmt', c - z(o), z(o) > 0 ? 'partial' : 'full', `commitment ${amt(c)} − obligation ${amt(shown(o) ? o : 0)}`);
    if (shown(o) && o > z(d)) add('udou', o - z(d), z(d) > 0 ? 'partial' : 'full', `obligation ${amt(o)} − delivered ${amt(shown(d) ? d : 0)}`);
    if (shown(d) && d > z(p)) add('dou', d - z(p), z(p) > 0 ? 'partial' : 'full', `delivered ${amt(d)} − paid ${amt(shown(p) ? p : 0)}`);

    if (shown(c) && shown(o) && o > c) anomalies.push({
      key: 'obligation_exceeds_commitment', title: 'Obligation exceeds commitment', detail: `${amt(o)} obligated against ${amt(c)} committed.`,
      research: 'Compare the requisition with the award and confirm both figures come from the same document, line and scope. An award above its funded requirement needs the requisition and the award reconciled.', procedure: null,
    });
    if (shown(d) && d > z(o)) anomalies.push({
      key: 'delivered_exceeds_obligation', title: 'Delivered exceeds obligation', detail: `${amt(d)} delivered against ${amt(shown(o) ? o : 0)} obligated.`,
      research: 'More was received or accrued than was awarded. Validate the actual receipt (an erroneous receipt?) and the bill (billed quantity above ordered?). The Invoices on Hold report is the first place to look.', procedure: 'invoice_hold',
    });
    if (shown(p) && p > z(o)) anomalies.push({
      key: 'paid_exceeds_obligation', title: shown(o) ? 'Paid exceeds the obligation' : 'Payment with no obligation shown', detail: shown(o) ? `${amt(p)} paid against ${amt(o)} obligated.` : `${amt(p)} paid; no award amount is shown.`,
      research: shown(o) ? 'A payment larger than the supported award is a UMT cause ("Billed AMT is greater than PO line AMT"). Check the Unmatched Transactions report and validate the billed amount before touching the award.' : 'A payment without a home is the definition of a UMT. Search for the award ("No matching record" may be a mismatched identifier) before posting anything.',
      procedure: 'umt_four_stage',
    });
    if (shown(p) && shown(d) && p > d && p <= z(o)) anomalies.push({
      key: 'paid_exceeds_delivered', title: 'Paid exceeds delivered', detail: `${amt(p)} paid against ${amt(d)} delivered.`,
      research: 'Payment usually follows receipt. Under a three-way match this points at a missing or insufficient receipt ("Not enough Qty received"). Establish actual delivery before any receipt is recorded.', procedure: 'umt_four_stage',
    });
    if (!shown(c) && shown(o) && !input.method) limits.push('No commitment is shown. If this is DTS travel, choose TDY: travel obligations are read against payment (OTO). Otherwise, inspect the actual postings rather than assuming a commitment is missing.');
  }

  const complete = findings.length === 0 && anomalies.length === 0 && figures.some((v) => shown(v) && v > 0);

  // Causes, filtered to the pattern each finding shows and to the method when it rules one out.
  const causes: CauseOption[] = [];
  for (const f of findings) {
    for (const cause of NORMAL_CONDITIONS[f.condition].causes) {
      if (cause.pattern !== 'both' && cause.pattern !== f.pattern) continue;
      if (cause.key === 'mipr_not_acknowledged' && input.method && input.method !== 'mipr') continue;
      causes.push({ ...cause, condition: f.condition, roles: rolesFor(cause.responsibility) });
    }
  }

  const research: string[] = [];
  const next: string[] = [];
  const verification: string[] = [];
  const roles = new Set<string>(rolesFor(['research']));
  for (const f of findings) {
    const def = NORMAL_CONDITIONS[f.condition];
    research.push(`${def.abbr}: ${def.firstQuestion}`);
    verification.push(`${def.abbr}: ${def.verification}`);
    if (def.guard) limits.push(def.guard);
  }
  for (const cause of causes) research.push(`If “${cause.label}”: ${cause.research}`);
  for (const a of anomalies) research.push(`${a.title}: ${a.research}`);
  for (const cause of causes) for (const r of cause.roles) roles.add(r);

  if (findings.length) {
    next.push('Pull the supporting documents for the open phase and the report entry itself before choosing a correction.');
    next.push('Record which cause the evidence supports, with a reason, then route only that correction to someone holding the needed responsibility and authority.');
    if (causes.some((x) => x.valid)) next.push('If the balance is valid (the next event is legitimately pending), keep it and monitor. A valid open balance is not an error.');
  }
  if (anomalies.length) next.push('Treat the out-of-order figures as a research lead: confirm scope first, then check the hold and unmatched-transaction reports.');
  if (complete) {
    next.push('Compare the completed record with its supporting documents: request, receipt and payment.');
    verification.push('A completed lifecycle in these figures still needs its KSD on file to be audit-ready.');
  }
  verification.push('A submitted amendment, acknowledgement or request is an action taken, not proof the residual cleared. Recheck the report after posting.');

  // Method-specific cautions the book spells out.
  const methodNotes = methodCautions(input.method || null, findings.map((f) => f.condition));
  limits.push(...methodNotes);

  // An exact error label, when in hand, narrows everything.
  let error: Diagnosis['error'] = null;
  let procedure: string | null = findings[0] ? PROCEDURE_FOR[findings[0].condition] : anomalies[0]?.procedure || null;
  if (input.error) {
    const e = describeError(input.error.kind, input.error.key);
    if (e) {
      error = { label: e.label, correction: e.correction, route: e.route, validate: e.validate };
      procedure = e.procedure;
      next.unshift(`Report error "${e.label}": ${e.correction}${e.route ? ` Posting route: ${e.route} (${ROUTES[e.route as keyof typeof ROUTES]?.performer}).` : ''}`);
      if (e.validate) research.unshift(e.validate);
      for (const r of e.roles) roles.add(r);
      references.add(e.cite);
    }
  }

  const evidence = method ? evidenceFor(method.key, findings.map((f) => f.condition), complete) : [];
  if (method) references.add(citeText(method.cite));
  references.add(citeText(cite('12.4', undefined, 'editorial')));
  if (input.ageDays != null && Number.isFinite(input.ageDays)) {
    limits.push(`This balance is ${Math.max(0, Math.round(input.ageDays))} days old. An old balance deserves attention, but age alone does not establish that it is invalid.`);
  }

  const missing = (['commitment', 'obligation', 'delivered', 'paid'] as const).filter((k, i) => !shown(figures[i]));
  if (missing.length && missing.length < 4) limits.push(`Not shown: ${missing.join(', ')}. A figure that is not shown is not treated as zero evidence; it is subtracted as zero only for the arithmetic.`);

  return {
    ok: true,
    observed: observedText(input, travel),
    meaning: meaningText(findings, anomalies, complete),
    findings, anomalies, complete, causes,
    research: dedupe(research), roles: [...roles], next: dedupe(next), verification: dedupe(verification),
    evidence, error,
    references: [...references],
    limits: dedupe(limits),
    procedure,
  };
}

function rolesFor(keys: WorkResponsibility[]): string[] {
  return [...new Set(keys.flatMap((k) => WORK_RESPONSIBILITY[k]).map(responsibilityName))];
}

function observedText(i: BalanceInput, travel: boolean) {
  const parts = [
    !travel || shown(i.commitment) ? `commitment ${amt(i.commitment)}` : null,
    `obligation ${amt(i.obligation)}`,
    `delivered ${amt(i.delivered)}`,
    `paid ${amt(i.paid)}`,
  ].filter(Boolean);
  const method = i.method ? ` (${METHODS[i.method].short})` : '';
  return `The record shows ${parts.join(', ')}${method}.`;
}

function meaningText(findings: Finding[], anomalies: Anomaly[], complete: boolean) {
  if (complete) return 'Every phase shown is covered by the next one: nothing is open between commitment and payment in these figures.';
  const bits = findings.map((f) => `${f.abbr} ${f.pattern === 'full' ? '(full)' : '(partial)'} — ${formatCents(f.residualCents)} open: ${f.whatIsOpen.charAt(0).toLowerCase()}${f.whatIsOpen.slice(1).replace(/\.$/, '')}`);
  const odd = anomalies.map((a) => `${a.title.toLowerCase()} — an abnormal pattern that needs research`);
  return [...bits, ...odd].join('; ') + '.';
}

function methodCautions(method: MethodKey | null, conditions: NormalKey[]): string[] {
  const out: string[] = [];
  const has = (k: NormalKey) => conditions.includes(k);
  if (method === 'gcss' && has('udou')) out.push('GCSS-MC: an award waiting on a valid back-order is not automatically erroneous, and a shipped item is not automatically a recorded receipt.');
  if (method === 'gpc' && has('dou')) out.push('GPC: the merchant is paid by the card transaction; DFAS later pays US Bank. Follow the bank-matching and settlement path before calling the balance unpaid.');
  if (method === 'contract' && (has('udou') || has('dou'))) out.push('Contract: under a three-way match a manual receipt through P2P Receipts may be required. An award alone does not establish the billed quantity was received.');
  if ((method === 'servmart' || method === 'fuel') && conditions.length) out.push(`${method === 'fuel' ? 'Fuel' : 'ServMart'}: postings arrive through an alias table. If the receipt exists but accounting does not, investigate the alias/interface and the pending state before anything else.`);
  if (method === 'mipr' && has('ocmt')) out.push('MIPR: the requested commitment alone does not prove the other agency accepted the work. Look for the signed DD 448-2 and the acknowledgement.');
  if (method === 'tdy' && has('oto')) out.push('TDY: keep waiting on the traveler separate from waiting on an approver or an interface.');
  return out;
}

function evidenceFor(method: MethodKey, conditions: NormalKey[], complete: boolean) {
  const ksd = METHODS[method].ksd;
  const groups: Array<{ group: string; items: string[] }> = [];
  const want = new Set<string>();
  if (complete) { want.add('request'); want.add('receipt'); want.add('payment'); }
  for (const c of conditions) {
    if (c === 'ocmt') want.add('request');
    if (c === 'udou') { want.add('request'); want.add('receipt'); }
    if (c === 'dou') { want.add('receipt'); want.add('payment'); }
    if (c === 'oto') { want.add('request'); want.add('receipt'); want.add('payment'); }
  }
  if (want.has('request')) groups.push({ group: 'Request and order', items: ksd.request });
  if (want.has('receipt')) groups.push({ group: 'Receipt and acceptance', items: ksd.receipt });
  if (want.has('payment')) groups.push({ group: 'Payment', items: ksd.payment });
  return groups;
}

interface ErrorDescription { label: string; correction: string; route: string | null; validate: string | null; roles: string[]; procedure: string; cite: string }

export function describeError(kind: ErrorKind, key: string): ErrorDescription | null {
  if (kind === 'umt') {
    const e = UMT_ERRORS.find((x) => x.key === key);
    if (e) return { label: e.label, correction: e.correction, route: e.route, validate: e.validate, roles: rolesFor(e.responsibility), procedure: 'umt_four_stage', cite: citeText(cite('11.2', '115-117')) };
    if (key === UMT_INSUFFICIENT_FUNDS.key) return { label: UMT_INSUFFICIENT_FUNDS.label, correction: UMT_INSUFFICIENT_FUNDS.correction, route: UMT_INSUFFICIENT_FUNDS.route, validate: null, roles: rolesFor(['research']), procedure: 'umt_four_stage', cite: citeText(cite('11.2', '115-117')) };
    return null;
  }
  if (kind === 'hold') {
    const h = INVOICE_HOLDS.causes.find((x) => x.key === key);
    return h ? { label: h.label, correction: `${h.correction} ${INVOICE_HOLDS.guard}`, route: null, validate: h.research, roles: rolesFor(h.responsibility), procedure: 'invoice_hold', cite: citeText(INVOICE_HOLDS.cite) } : null;
  }
  if (kind === 'reject_dts' || kind === 'reject_gcss') {
    const set = FEEDER_REJECTS[kind === 'reject_dts' ? 'dts' : 'gcss'];
    const r = set.causes.find((x) => x.key === key);
    return r ? { label: `${set.system}: ${r.label}`, correction: r.correction, route: null, validate: r.research, roles: rolesFor(r.responsibility), procedure: 'feeder_reject', cite: citeText(set.cite) } : null;
  }
  const i = INTERFACE_ERRORS.causes.find((x) => x.key === key);
  return i ? { label: i.label, correction: `${i.correction} ${INTERFACE_ERRORS.guard}`, route: null, validate: i.research, roles: rolesFor(i.responsibility), procedure: 'interface_error', cite: citeText(INTERFACE_ERRORS.cite) } : null;
}

/** The error labels a person can pick, grouped by report. */
export const ERROR_OPTIONS: Array<{ kind: ErrorKind; report: string; options: Array<{ key: string; label: string }> }> = [
  { kind: 'umt', report: 'Unmatched Transactions', options: [...UMT_ERRORS.map((e) => ({ key: e.key, label: e.label })), { key: UMT_INSUFFICIENT_FUNDS.key, label: UMT_INSUFFICIENT_FUNDS.label }] },
  { kind: 'hold', report: 'Invoices on Hold', options: INVOICE_HOLDS.causes.map((h) => ({ key: h.key, label: h.label })) },
  { kind: 'reject_dts', report: 'DTS reject', options: FEEDER_REJECTS.dts.causes.map((r) => ({ key: r.key, label: r.label })) },
  { kind: 'reject_gcss', report: 'GCSS-MC reject', options: FEEDER_REJECTS.gcss.causes.map((r) => ({ key: r.key, label: r.label })) },
  { kind: 'interface', report: 'Interface Error (ServMart / fuel)', options: INTERFACE_ERRORS.causes.map((r) => ({ key: r.key, label: r.label })) },
];

const dedupe = (xs: string[]) => [...new Set(xs)];

/** The FMRAC's eight numerical examples, for teaching and for tests. Amounts in whole dollars. */
export function sourceExamples(): Array<{ id: string; condition: NormalKey; pattern: 'full' | 'partial'; input: BalanceInput; residualCents: number; explanation: string; cite: Cite }> {
  const toCents = (v: number | null) => (v == null ? null : v * 100);
  const out = [];
  for (const key of ['ocmt', 'udou', 'dou', 'oto'] as NormalKey[]) {
    const def = NORMAL_CONDITIONS[key];
    for (const pattern of ['full', 'partial'] as const) {
      const ex = def.examples[pattern];
      const input: BalanceInput = { method: key === 'oto' ? 'tdy' : null, commitment: toCents(ex.commitment), obligation: toCents(ex.obligation), delivered: toCents(ex.delivered), paid: toCents(ex.paid) };
      const residual = pattern === 'full' ? 10_000 : 5_000;
      out.push({ id: `${key}-${pattern}`, condition: key, pattern, input, residualCents: residual, explanation: ex.explanation, cite: cite('8.3', '100-102') });
    }
  }
  return out;
}
