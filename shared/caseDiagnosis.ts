/**
 * The automatic financial case diagnoser (VANTAGE_CLAUDE_MASTER Task 16, ADR-0022).
 *
 * It reads one case as a whole: what the import brought in, what people recorded, the procedure the case follows, the
 * guidance a command and the service put on file, and the error reports that list it. It answers, in the specification's
 * order, issue type, probable cause, missing information, research, systems, calculations, corrective action, approvals,
 * verification and resolution criteria. Every statement carries one of five labels (Known fact, Derived value,
 * Recommendation, Unknown, Human decision required), and every recommendation carries its source and that source's rank
 * (shared/procedureTypes.ts PROVENANCE). Within a section, recommendations are weighed in provenance order.
 *
 * Pure and deterministic: no AI, no clock, no database. The same events, the same guidance, the same engine version and the
 * same day give the same diagnosis, so it is derived on read and never stored. It reuses the FMRAC balance reader
 * (fmra/diagnose.ts), the procedures (procedures.ts) and the responsibilities (fmra/roles.ts) as they are.
 *
 * Two rules keep inference from passing as policy: a reading taken from words alone (a keyword match) is labelled
 * inference, ranks last, and nothing else in the diagnosis is built on it until a person confirms the issue type; and
 * nothing ever raises a statement's rank above the source it came from.
 */
import { formatCents, parseMoney } from './money.ts';
import { diagnose, type Diagnosis as BalanceReading } from './fmra/diagnose.ts';
import {
  NORMAL_CONDITIONS, UMT, UMT_ERRORS, UMT_INSUFFICIENT_FUNDS, INVOICE_HOLDS, FEEDER_REJECTS, INTERFACE_ERRORS, ROUTES, ERROR_CLASSES,
  UMT_COMPLETION, RESEARCH_SEQUENCE, ABNORMAL, type NormalKey, type Route,
} from './fmra/conditions.ts';
import { METHODS, methodFromText, type MethodKey } from './fmra/methods.ts';
import { WORK_RESPONSIBILITY, responsibilityName, SEPARATION_OF_DUTIES, type WorkResponsibility } from './fmra/roles.ts';
import { cite, citeText } from './fmra/source.ts';
import {
  standing, progress, stepApplies, decisionOf, latestVerification, latestFundsCheck, resolutionChecks, awardShortfall,
  candidateAdjustment, calculationState, FORMULAS, suggestProcedure, PROCEDURES, type CaseEvent, type StepProgress,
} from './procedures.ts';
import { PROVENANCE, provenanceOf, type Authority, type Procedure, type ProcedureStep, type ProvenanceTier } from './procedureTypes.ts';

export const DIAGNOSIS_ENGINE = { key: 'case_diagnosis', version: '1.0.0' } as const;

export const STATEMENT_LABELS = ['known_fact', 'derived_value', 'recommendation', 'unknown', 'decision_required'] as const;
export type StatementLabel = (typeof STATEMENT_LABELS)[number];

export const STATEMENT_LABEL_TEXT: Record<StatementLabel, string> = {
  known_fact: 'Known fact',
  derived_value: 'Derived value',
  recommendation: 'Recommendation',
  unknown: 'Unknown',
  decision_required: 'Human decision required',
};

export const STATEMENT_LABEL_MEANING: Record<StatementLabel, string> = {
  known_fact: 'On the record: imported from the sheet, read from a system, or recorded by a person.',
  derived_value: 'Worked out by Vantage from known facts. The arithmetic or the comparison is shown.',
  recommendation: 'What a source on file says to do. Its source and rank are shown beside it.',
  unknown: 'Not on the record yet. A blank or a dash is never read as zero.',
  decision_required: 'A person decides this. Vantage never does.',
};

export const SECTIONS = [
  { key: 'issue_type', title: 'Issue type' },
  { key: 'probable_cause', title: 'Probable cause' },
  { key: 'missing_information', title: 'Missing information' },
  { key: 'research', title: 'Research needed' },
  { key: 'systems', title: 'Systems to inspect' },
  { key: 'calculations', title: 'Calculations' },
  { key: 'corrective_action', title: 'Corrective action' },
  { key: 'approvals', title: 'Approvals' },
  { key: 'verification', title: 'Verification' },
  { key: 'resolution_criteria', title: 'Resolution criteria' },
] as const;
export type SectionKey = (typeof SECTIONS)[number]['key'];

/** The sections guidance on file may speak to. The issue type is read from the case, never from guidance. */
export const GUIDANCE_SECTIONS = SECTIONS.filter((s) => s.key !== 'issue_type').map((s) => s.key) as Array<Exclude<SectionKey, 'issue_type'>>;
export type GuidanceSection = Exclude<SectionKey, 'issue_type'>;

export const ISSUE_TYPES = [
  { key: 'umt', label: 'Unmatched transaction (UMT)', short: 'UMT', procedure: 'umt_four_stage', family: 'umt' },
  { key: 'umt_2way', label: '2-Way UMT: PO open quantity below DCAS quantity', short: '2-Way UMT', procedure: 'umt_2way_po_qty', family: 'umt' },
  { key: 'invoice_hold', label: 'Invoice on hold', short: 'Hold', procedure: 'invoice_hold', family: 'invoice_hold' },
  { key: 'feeder_reject', label: 'Feeder-system reject (DTS or GCSS-MC)', short: 'Reject', procedure: 'feeder_reject', family: 'feeder_reject' },
  { key: 'interface_error', label: 'Interface error (ServMart or fuel)', short: 'Interface', procedure: 'interface_error', family: 'interface_error' },
  { key: 'ocmt', label: 'Open commitment (OCMT)', short: 'OCMT', procedure: 'ocmt_research', family: 'ocmt' },
  { key: 'udou', label: 'Undelivered order, unpaid (UDOU)', short: 'UDOU', procedure: 'udou_research', family: 'udou' },
  { key: 'dou', label: 'Delivered order, unpaid (DOU)', short: 'DOU', procedure: 'dou_research', family: 'dou' },
  { key: 'oto', label: 'Outstanding travel order (OTO)', short: 'OTO', procedure: 'oto_research', family: 'oto' },
] as const;
export type IssueKey = (typeof ISSUE_TYPES)[number]['key'];
export const ISSUE_KEYS = ISSUE_TYPES.map((i) => i.key) as IssueKey[];
export const issueType = (key: string | null | undefined) => ISSUE_TYPES.find((i) => i.key === key) || null;
const ISSUE_FOR_PROCEDURE: Record<string, IssueKey> = Object.fromEntries(ISSUE_TYPES.map((i) => [i.procedure, i.key]));
export const issueForProcedure = (key: string | null | undefined): IssueKey | null => (key ? ISSUE_FOR_PROCEDURE[key] ?? null : null);
const NORMAL = new Set<string>(['ocmt', 'udou', 'dou', 'oto']);
const isNormal = (k: string | null): k is NormalKey => Boolean(k && NORMAL.has(k));

/** The kinds of source a person can put on file (migration 030). FMRAC, SME walkthroughs and inference are not. */
export const GUIDANCE_AUTHORITIES = ['official_policy', 'official_system_guidance', 'approved_local_sop', 'validated_sme_workflow', 'historical_case'] as const;
export type GuidanceAuthority = (typeof GUIDANCE_AUTHORITIES)[number];
/** What a Unit Manager may put on file for their Unit Instance. */
export const UNIT_GUIDANCE_AUTHORITIES: readonly GuidanceAuthority[] = ['approved_local_sop', 'validated_sme_workflow'];
/** What a Vantage Administrator may put on file for the whole service. */
export const ENTERPRISE_GUIDANCE_AUTHORITIES: readonly GuidanceAuthority[] = ['official_policy', 'official_system_guidance'];

export interface GuidanceEntry {
  id: string;
  authority: GuidanceAuthority;
  issue: IssueKey | 'any';
  section: GuidanceSection;
  text: string;
  citation: string;
  /** On file for the whole service rather than one Unit Instance. */
  enterprise: boolean;
  effective_on: string | null;
  /** A validated past case: the cause decided on it. */
  cause?: string | null;
  /** A validated past case the reader may open. Left out when they may not. */
  case?: { id: string; title: string } | null;
}

/** An error report filed for the case's unit that lists it (Task 15), for a reader of that unit's reports. */
export interface ReportFact {
  report: string;
  latest_as_of: string;
  on_latest: boolean;
  /** The newest report of the series that listed the case. */
  listed_as_of: string | null;
  source_row: number | null;
  status: string | null;
  closed: boolean;
  amount_cents: number | null;
  age_days: number | null;
}

export type SheetField = 'commitment' | 'obligation' | 'delivered' | 'paid' | 'purchase_method' | 'error_text';

export interface DiagnosisInput {
  item: {
    title: string;
    reference: string | null;
    due_date: string | null;
    created_at: string;
    stage: string;
    /** The file the case was imported from, and its row. */
    filename: string | null;
    source_row: number | null;
    /** Every cell of the case's sheet row, for the keyword lead only. */
    cells?: string[];
  };
  /** The cells the import's column mapping gave a financial meaning, as the sheet wrote them. */
  sheet?: Array<{ field: SheetField; column: string; value: string }>;
  events: CaseEvent[];
  procedure: Procedure | null;
  guidance?: GuidanceEntry[];
  reports?: ReportFact[];
  /** Person id to name, for saying who recorded a fact. */
  people?: Record<string, string>;
  /** YYYY-MM-DD in the service's timezone. */
  today: string;
}

export interface Basis {
  authority: Authority;
  rank: number;
  tier: ProvenanceTier['tier'];
  /** Where a reader looks it up. */
  citation: string | null;
  guidance_id?: string;
  /** A validated past case the reader may open. */
  case_id?: string | null;
}

export interface Statement {
  label: StatementLabel;
  text: string;
  detail?: string | null;
  /** Required on a recommendation. On a derived value, the rule it applied, when one did. */
  basis?: Basis | null;
  /** A known fact: where it came from. */
  from?: string | null;
  /** A derived value: the arithmetic or comparison. */
  how?: string | null;
  evidence?: string[];
}

export interface DiagnosisSection { key: SectionKey; title: string; statements: Statement[] }

export type IssueHow = 'procedure' | 'error_label' | 'figures' | 'words';

export interface CaseDiagnosis {
  engine: typeof DIAGNOSIS_ENGINE;
  as_of: string;
  /**
   * What the case reads as, and how. `applied`: the case follows a procedure. `confirmed`: the diagnosis builds on that
   * procedure, because a person chose or confirmed it or the case's own evidence agrees. Applied but not confirmed is an
   * import's pick from the words on the row alone, which a person confirms by applying it again or replaces.
   */
  issue: { key: IssueKey | null; label: string; short: string | null; how: IssueHow | null; procedure: string | null; applied: boolean; confirmed: boolean };
  headline: string;
  sections: DiagnosisSection[];
  counts: Record<StatementLabel, number>;
  /** Every rank, in order, with how many statements drew on it and how many entries are on file for this issue. */
  sources: Array<ProvenanceTier & { used: number; on_file: number | null }>;
  limits: string[];
  ai: false;
}

export interface DiagnosisSummary { issue: string | null; headline: string; unknown: number; decisions: number }

// ── Statement helpers ────────────────────────────────────────────────────────────────────────────────────────────────

export function basisOf(authority: Authority, citation: string | null, extra: Partial<Basis> = {}): Basis {
  const p = provenanceOf(authority);
  return { authority, rank: p.rank, tier: p.tier, citation, ...extra };
}
const fmrac = (citation: string) => basisOf('training_reference', citation);
const fact = (text: string, from: string | null, more: Partial<Statement> = {}): Statement => ({ label: 'known_fact', text, from, ...more });
const derived = (text: string, how: string, basis: Basis | null = null, more: Partial<Statement> = {}): Statement => ({ label: 'derived_value', text, how, basis, ...more });
const rec = (text: string, basis: Basis, more: Partial<Statement> = {}): Statement => ({ label: 'recommendation', text, basis, ...more });
const unknown = (text: string, detail: string | null = null, more: Partial<Statement> = {}): Statement => ({ label: 'unknown', text, detail, ...more });
const decide = (text: string, detail: string | null = null, more: Partial<Statement> = {}): Statement => ({ label: 'decision_required', text, detail, ...more });

const LABEL_ORDER: Record<StatementLabel, number> = { known_fact: 0, derived_value: 1, recommendation: 2, unknown: 3, decision_required: 4 };

/** Facts, then what was worked out, then what sources recommend in provenance order, then what is unknown, then what a person decides. */
export function orderStatements(statements: Statement[]): Statement[] {
  return statements
    .map((s, i) => ({ s, i }))
    .sort((a, b) => LABEL_ORDER[a.s.label] - LABEL_ORDER[b.s.label]
      || (a.s.label === 'recommendation' ? (a.s.basis?.rank ?? 0) - (b.s.basis?.rank ?? 0) : 0)
      || a.i - b.i)
    .map(({ s }) => s);
}

const lower = (t: string) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);
const words = (t: string) => ` ${t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
const day = (iso: string) => iso.slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10)) - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000);
const isDay = (s: string | null | undefined): s is string => Boolean(s && /^\d{4}-\d{2}-\d{2}/.test(s));
const unique = <T,>(xs: T[]) => [...new Set(xs)];
const rolesFor = (keys: readonly WorkResponsibility[]) => unique(keys.flatMap((k) => WORK_RESPONSIBILITY[k]).map(responsibilityName));
const stepRoles = (step: ProcedureStep) => unique((step.responsibility || []).map(responsibilityName));
const listText = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// ── Reading the case ─────────────────────────────────────────────────────────────────────────────────────────────────

const LIFECYCLE = [
  { key: 'commitment', field: 'commitment_amount', label: 'Commitment' },
  { key: 'obligation', field: 'obligation_amount', label: 'Obligation' },
  { key: 'delivered', field: 'delivered_amount', label: 'Delivered' },
  { key: 'paid', field: 'paid_amount', label: 'Paid' },
] as const;
type FigureKey = (typeof LIFECYCLE)[number]['key'];
interface Figure { label: string; cents: number | null; shown: boolean; from: string; evidence: string[] }

interface LabelMatch { issue: IssueKey; key: string; label: string; from: string; feeder: 'dts' | 'gcss' | null; basis: Basis }

const UMT_CITE = citeText(cite('11.2', '115-117'));
const ROUTE_CITE = 'FMRAC 11.3 · orig. p. 117';
const RESIDUAL_CITE = 'FMRAC 8.3 · orig. pp. 100-102';
const ABNORMAL_CITE = citeText(ABNORMAL.cite);
const TWO_WAY = /2\s*-?\s*WAY\s+PO\s+MATCH.*open\s+qty.*less\s+than.*DCAS\s+qty/i;

interface Phrase { issue: IssueKey; key: string; label: string; phrase: string; distinctive: boolean; feeder: 'dts' | 'gcss' | null; citation: string }
const PHRASES: Phrase[] = [
  ...UMT_ERRORS.map((e) => ({ issue: 'umt' as const, key: e.key, label: e.label, phrase: e.label.replace(/\s*\([^)]*\)\s*$/, ''), distinctive: true, feeder: null, citation: UMT_CITE })),
  { issue: 'umt', key: UMT_INSUFFICIENT_FUNDS.key, label: UMT_INSUFFICIENT_FUNDS.label, phrase: UMT_INSUFFICIENT_FUNDS.label, distinctive: false, feeder: null, citation: UMT_CITE },
  ...INVOICE_HOLDS.causes.map((h) => ({ issue: 'invoice_hold' as const, key: h.key, label: h.label, phrase: h.label, distinctive: h.key.startsWith('billed_exceeds'), feeder: null, citation: citeText(INVOICE_HOLDS.cite) })),
  ...INTERFACE_ERRORS.causes.map((c) => ({ issue: 'interface_error' as const, key: c.key, label: c.label, phrase: c.label, distinctive: c.key === 'alias_not_loaded', feeder: null, citation: citeText(INTERFACE_ERRORS.cite) })),
  ...(['dts', 'gcss'] as const).flatMap((f) => FEEDER_REJECTS[f].causes.map((c) => ({ issue: 'feeder_reject' as const, key: c.key, label: `${FEEDER_REJECTS[f].system}: ${c.label}`, phrase: c.label, distinctive: false, feeder: f, citation: citeText(FEEDER_REJECTS[f].cite) }))),
];

const family = (k: IssueKey | null) => (k ? issueType(k)!.family : null);

interface CauseOption { key: string; label: string; research: string | null; correction: string; valid: boolean; route: Route | null; roles: string[]; citation: string | null; authority: Authority }

interface Reading {
  input: DiagnosisInput;
  events: CaseEvent[];
  applied: Procedure | null;
  /** The latest entry that put the case under its procedure, or confirmed it. */
  appliedEvent: CaseEvent | null;
  /** An import chose the case's procedure from the words on the row alone, and no person has confirmed it since. */
  wordPick: boolean;
  /** The case's own procedure, when the diagnosis may build on it: a person chose or confirmed it, or the case's evidence agrees. */
  trusted: Procedure | null;
  /** The procedure the diagnosis follows: the case's own, or the one its issue type calls for when that was read from the report or the figures. */
  plan: Procedure | null;
  steps: Map<string, StepProgress> | null;
  figures: Partial<Record<FigureKey, Figure>>;
  method: { key: MethodKey; from: string } | null;
  balance: BalanceReading | null;
  label: LabelMatch | null;
  lead: { issue: IssueKey; why: string } | null;
  issue: IssueKey | null;
  how: IssueHow | null;
  feeder: 'dts' | 'gcss' | null;
  causeStep: ProcedureStep | null;
  cause: CaseEvent | null;
  options: CauseOption[];
  guidance: GuidanceEntry[];
}

function latestObservation(events: CaseEvent[], field: string): CaseEvent | null {
  let best: CaseEvent | null = null;
  for (const e of events) if (e.kind === 'observation' && e.body.field === field && (!best || (e.seq ?? 0) >= (best.seq ?? 0))) best = e;
  return best;
}

function fromOf(input: DiagnosisInput, e: CaseEvent): string {
  if (e.body.source === 'source_file') return importedFrom(input);
  const who = e.actor_id ? input.people?.[e.actor_id] || 'A former member' : 'Vantage';
  const where = e.body.system ? `, read in ${e.body.system}` : '';
  const ref = e.body.reference ? `, reference ${e.body.reference}` : '';
  return `Recorded by ${who} on ${day(e.occurred_at)}${where}${ref}`;
}

const isClosed = (input: DiagnosisInput) => input.item.stage === 'resolved' || input.item.stage === 'not_applicable';

const importedFrom = (input: DiagnosisInput) => (input.item.filename ? `Imported from ${input.item.filename}${input.item.source_row ? `, row ${input.item.source_row}` : ''}` : 'Entered with the case');

function read(input: DiagnosisInput): Reading {
  const events = standing(input.events.map((e, i) => ({ ...e, seq: e.seq ?? i })));
  const applied = input.procedure;
  const sheet = new Map((input.sheet || []).map((s) => [s.field, s]));

  const figures: Reading['figures'] = {};
  for (const f of LIFECYCLE) {
    const e = latestObservation(events, f.field);
    if (e) {
      const shown = !e.body.not_shown && Number.isSafeInteger(e.body.amount_cents);
      figures[f.key] = { label: f.label, cents: shown ? e.body.amount_cents : null, shown, from: fromOf(input, e), evidence: [e.id] };
      continue;
    }
    const cell = sheet.get(f.key);
    if (!cell) continue;
    const raw = cell.value.trim();
    const parsed = raw && !/^[-–—]$/.test(raw) ? parseMoney(raw) : null;
    figures[f.key] = { label: f.label, cents: parsed?.ok ? parsed.cents : null, shown: Boolean(parsed?.ok), from: `${importedFrom(input)}, column “${cell.column}”`, evidence: [] };
  }

  const methodEvent = latestObservation(events, 'purchase_method');
  const methodCell = sheet.get('purchase_method');
  const method = methodEvent?.body.value_text && METHODS[methodEvent.body.value_text as MethodKey]
    ? { key: methodEvent.body.value_text as MethodKey, from: fromOf(input, methodEvent) }
    : methodFromText(methodCell?.value) ? { key: methodFromText(methodCell!.value)!, from: `${importedFrom(input)}, column “${methodCell!.column}”` } : null;

  const anyFigure = LIFECYCLE.some((f) => figures[f.key]?.shown);
  const reading = anyFigure ? diagnose({
    method: method?.key ?? null,
    commitment: figures.commitment?.cents ?? null, obligation: figures.obligation?.cents ?? null,
    delivered: figures.delivered?.cents ?? null, paid: figures.paid?.cents ?? null,
  }) : null;
  const balance = reading && reading.ok ? reading : null;

  const feederEvent = latestObservation(events, 'feeder_system');
  const feeder = feederEvent?.body.value_text === 'dts' || feederEvent?.body.value_text === 'gcss' ? feederEvent.body.value_text as 'dts' | 'gcss' : null;

  const appliedIssue = issueForProcedure(applied?.key);
  const label = matchLabel(input, events, appliedIssue, feeder);
  const figureIssue = balance?.procedure ? issueForProcedure(balance.procedure) : null;
  const leadHit = suggestProcedure(input.item.title, ...['error_text', 'hold_reason_text', 'reject_text'].map((f) => latestObservation(events, f)?.body.value_text as string | undefined), sheet.get('error_text')?.value, ...(input.item.cells || []));
  const lead = leadHit && issueForProcedure(leadHit.key) ? { issue: issueForProcedure(leadHit.key)!, why: leadHit.why } : null;

  // An import that chose the procedure from the words on the row alone made an inference, not a reading. It stands as a
  // lead until a person confirms it (or applies another), unless the error text or the figures name the same issue.
  const appliedEvent = applied ? [...events].reverse().find((e) => e.kind === 'procedure_applied') || null : null;
  const wordPick = Boolean(applied && appliedEvent?.body.picked === 'words');
  const agrees = Boolean(appliedIssue && ((label && family(label.issue) === family(appliedIssue)) || (isNormal(appliedIssue) && balance?.findings.some((f) => f.condition === appliedIssue))));
  const trusted = applied && (!wordPick || agrees) ? applied : null;

  let issue: IssueKey | null = null;
  let how: IssueHow | null = null;
  if (trusted) { issue = appliedIssue; how = 'procedure'; }
  else if (label) { issue = label.issue; how = 'error_label'; }
  else if (figureIssue) { issue = figureIssue; how = 'figures'; }
  else if (wordPick && appliedIssue) { issue = appliedIssue; how = 'words'; }
  else if (lead) { issue = lead.issue; how = 'words'; }

  const plan = trusted || (how === 'error_label' || how === 'figures' ? PROCEDURES[issueType(issue)!.procedure] || null : null);
  const steps = trusted ? new Map(progress(trusted, input.events, { reference: input.item.reference, stage: input.item.stage }).steps.map((s) => [s.key, s])) : null;
  const causeStep = plan?.steps.find((s) => s.kind === 'decision' && s.key === 'cause' && s.decision) || null;
  const cause = causeStep ? decisionOf(events, causeStep.decision!.key) : null;
  const options = plan && causeStep && issue ? causeOptions(issue, causeStep, balance, method?.key ?? null, feeder, plan.authority) : [];

  const guidance = (input.guidance || []).filter((g) => (g.issue === 'any' || (how !== 'words' && g.issue === issue)) && (!g.effective_on || g.effective_on.slice(0, 10) <= input.today));

  return { input, events, applied, appliedEvent, wordPick, trusted, plan, steps, figures, method, balance, label, lead, issue, how, feeder, causeStep, cause, options, guidance };
}

function matchLabel(input: DiagnosisInput, events: CaseEvent[], appliedIssue: IssueKey | null, feeder: 'dts' | 'gcss' | null): LabelMatch | null {
  const texts: Array<{ text: string; from: string }> = [];
  for (const field of ['error_text', 'hold_reason_text', 'reject_text']) {
    const e = latestObservation(events, field);
    if (e?.body.value_text) texts.push({ text: String(e.body.value_text), from: fromOf(input, e) });
  }
  const cell = input.sheet?.find((s) => s.field === 'error_text');
  if (cell?.value.trim()) texts.push({ text: cell.value, from: `${importedFrom(input)}, column “${cell.column}”` });
  texts.push({ text: input.item.title, from: importedFrom(input) });

  for (const t of texts) {
    if (TWO_WAY.test(t.text) && (!appliedIssue || family(appliedIssue) === 'umt')) {
      const p = PROCEDURES.umt_2way_po_qty;
      return { issue: 'umt_2way', key: 'po_open_qty_below_dcas', label: p.trigger, from: t.from, feeder: null, basis: basisOf(p.authority, p.source) };
    }
    const text = words(t.text);
    const candidates = PHRASES.filter((p) => (appliedIssue ? family(p.issue) === family(appliedIssue) || p.distinctive : p.distinctive) && (!feeder || !p.feeder || p.feeder === feeder));
    const hit = candidates.find((p) => text.includes(words(p.phrase)));
    if (hit) return { issue: hit.issue, key: hit.key, label: hit.label, from: t.from, feeder: hit.feeder, basis: fmrac(hit.citation) };
  }
  return null;
}

function causeOptions(issue: IssueKey, step: ProcedureStep, balance: BalanceReading | null, method: MethodKey | null, feeder: 'dts' | 'gcss' | null, authority: Authority): CauseOption[] {
  const out: CauseOption[] = [];
  const finding = isNormal(issue) ? balance?.findings.find((f) => f.condition === issue) : undefined;
  for (const choice of step.decision!.choices) {
    if (choice.key === 'refer_for_review') continue;
    const base: CauseOption = { key: choice.key, label: choice.label, research: null, correction: choice.hint || '', valid: choice.key.startsWith('valid') || choice.key === 'payment_pending', route: null, roles: [], citation: step.help.source || null, authority };
    if (isNormal(issue)) {
      const def = NORMAL_CONDITIONS[issue];
      const c = def.causes.find((x) => x.key === choice.key);
      if (c) {
        if (finding && c.pattern !== 'both' && c.pattern !== finding.pattern) continue;
        if (c.key === 'mipr_not_acknowledged' && method && method !== 'mipr') continue;
        out.push({ ...base, research: c.research, correction: c.correction, valid: Boolean(c.valid), roles: rolesFor(c.responsibility), citation: citeText(def.cite) });
        continue;
      }
    } else if (issue === 'umt') {
      const e = UMT_ERRORS.find((x) => x.key === choice.key);
      if (e) { out.push({ ...base, research: e.validate, correction: e.correction, route: e.route, roles: rolesFor(e.responsibility), citation: UMT_CITE }); continue; }
      if (choice.key === UMT_INSUFFICIENT_FUNDS.key) { out.push({ ...base, correction: UMT_INSUFFICIENT_FUNDS.correction, route: UMT_INSUFFICIENT_FUNDS.route, roles: rolesFor(['research']), citation: UMT_CITE }); continue; }
    } else if (issue === 'invoice_hold') {
      const h = INVOICE_HOLDS.causes.find((x) => x.key === choice.key);
      if (h) { out.push({ ...base, research: h.research, correction: `${h.correction} (${h.match} match.)`, roles: rolesFor(h.responsibility), citation: citeText(INVOICE_HOLDS.cite) }); continue; }
    } else if (issue === 'interface_error') {
      const c = INTERFACE_ERRORS.causes.find((x) => x.key === choice.key);
      if (c) { out.push({ ...base, research: c.research, correction: c.correction, roles: rolesFor(c.responsibility), citation: citeText(INTERFACE_ERRORS.cite) }); continue; }
    } else if (issue === 'feeder_reject') {
      const sets = feeder ? [FEEDER_REJECTS[feeder]] : [FEEDER_REJECTS.dts, FEEDER_REJECTS.gcss];
      const hits = sets.map((s) => ({ s, c: s.causes.find((x) => x.key === choice.key) })).filter((x) => x.c);
      if (hits.length) {
        const c = hits[0].c!;
        out.push({
          ...base,
          research: hits.length === 1 ? c.research : hits.map((h) => `${h.s.system}: ${h.c!.research}`).join(' '),
          correction: c.correction, roles: rolesFor(c.responsibility), citation: hits.map((h) => citeText(h.s.cite)).join('; '),
        });
        continue;
      }
    }
    out.push(base);
  }
  return out;
}

const optionBasis = (o: CauseOption) => basisOf(o.authority === 'sme_walkthrough' ? 'sme_walkthrough' : 'training_reference', o.citation);

// ── The diagnosis ────────────────────────────────────────────────────────────────────────────────────────────────────

export function diagnoseCase(input: DiagnosisInput): CaseDiagnosis {
  const r = read(input);
  const s = Object.fromEntries(SECTIONS.map((x) => [x.key, [] as Statement[]])) as Record<SectionKey, Statement[]>;
  const usable = r.how !== 'words';
  const plan = usable ? r.plan : null;
  const stepState = (key: string) => r.steps?.get(key) || null;
  const applies = (step: ProcedureStep) => stepApplies(step, r.events);
  const procBasis = (step?: ProcedureStep) => basisOf(plan!.authority, step?.help.source || plan!.references?.[0] || plan!.source);
  const evidenceFrom = (ids: string[]) => {
    const e = [...r.events].reverse().find((x) => ids.includes(x.id));
    return e ? fromOf(input, e) : null;
  };
  const causeDecided = Boolean(r.cause && r.cause.body.choice !== 'refer_for_review');
  const decidedOption = causeDecided ? r.options.find((o) => o.key === r.cause!.body.choice) || null : null;
  const labelOption = r.label ? r.options.find((o) => o.key === r.label!.key) || null : null;

  issueSection(r, s.issue_type);
  causeSection(r, s.probable_cause, plan, decidedOption, labelOption);

  // Missing information: the fields the procedure's research asks for that nobody has recorded yet.
  const missing = s.missing_information;
  if (plan) {
    for (const step of plan.steps) {
      if (step.kind !== 'research' || !step.fields?.length || applies(step) !== true) continue;
      const optional: string[] = [];
      for (const field of step.fields) {
        if (field.key === 'document_number' && input.item.reference) continue;
        const e = latestObservation(r.events, field.key);
        const figure = LIFECYCLE.find((f) => f.field === field.key);
        const fromSheet = figure ? r.figures[figure.key] : null;
        if (e?.body.not_shown || (!e && fromSheet && !fromSheet.shown)) {
          missing.push(unknown(`${field.label}: not shown on the report.`, `A dash or a blank is not a zero. Read it in ${step.help.system || 'the system of record'} and record it.`, { evidence: e ? [e.id] : [] }));
          continue;
        }
        if (e || fromSheet) continue;
        if (field.optional) { optional.push(field.label); continue; }
        missing.push(unknown(`${field.label}: not recorded.`, `${step.title}${step.help.system ? ` · ${step.help.system}` : ''}.`));
      }
      if (optional.length && !causeDecided && step.key !== 'observe_balances') {
        missing.push(unknown(`Not recorded yet: ${listText(optional.map(lower))}.`, `Optional in “${step.title}”, but these tell the causes apart.`));
      }
    }
    if (isNormal(r.issue) && !r.method && r.issue !== 'oto') {
      missing.push(unknown('Purchase method: not recorded.', 'It decides which evidence proves each phase.'));
    }
  } else {
    for (const f of LIFECYCLE) {
      const fig = r.figures[f.key];
      if (fig && !fig.shown) missing.push(unknown(`${f.label}: not shown on the sheet.`, 'A dash or a blank is not a zero.'));
    }
    if (!r.label) missing.push(unknown('The exact error text from the report.', 'An exact error label narrows the research. Copy it as the report words it.'));
    if (!r.balance) missing.push(unknown('The lifecycle figures: commitment, obligation, delivered and paid.', 'For one document, line and scope.'));
  }
  addGuidance(r, 'missing_information', missing);

  // Research: what the procedure's research steps still ask, and what tells the causes apart.
  const research = s.research;
  if (plan) {
    const done: string[] = [];
    const doneEvidence: string[] = [];
    for (const step of plan.steps) {
      if (step.kind !== 'research' || applies(step) !== true) continue;
      const st = stepState(step.key);
      if (st?.status === 'done') { done.push(step.title); doneEvidence.push(...st.evidence); continue; }
      research.push(rec(`${step.title}: ${step.help.what}`, procBasis(step), { detail: step.help.meaning || null }));
    }
    if (done.length) research.unshift(fact(`Done: ${listText(done)}.`, evidenceFrom(doneEvidence), { evidence: doneEvidence }));
    if (!causeDecided) {
      if (labelOption?.research) research.push(rec(`The report names “${r.label!.label}”: ${labelOption.research}`, optionBasis(labelOption)));
      for (const o of r.options) {
        if (!o.research || o === labelOption) continue;
        research.push(rec(`To tell whether it is “${lower(o.label)}”: ${o.research}`, optionBasis(o)));
      }
    }
    if (r.issue === 'umt' || r.issue === 'umt_2way') research.push(rec(UMT.warning, fmrac(citeText(UMT.cite))));
  } else {
    RESEARCH_SEQUENCE.forEach((step, i) => research.push(rec(`${i + 1}. ${step}`, fmrac(citeText(cite('9.1', '103-108'))))));
  }
  if (usable && r.balance) {
    for (const a of r.balance.anomalies) research.push(rec(`${a.title}: ${a.research}`, fmrac(ABNORMAL_CITE)));
    if (r.method) for (const g of r.balance.evidence) research.push(rec(`Pull the ${lower(g.group)} evidence: ${listText(g.items)}.`, fmrac(citeText(METHODS[r.method.key].cite)), { detail: 'Evidence belongs to its event: an approved request proves authorization, not delivery or payment.' }));
  }
  addGuidance(r, 'research', research);

  // Systems to inspect.
  const systems = s.systems;
  if (plan) {
    const bySystem = new Map<string, string[]>();
    for (const step of plan.steps) {
      if (!step.help.system || applies(step) !== true || stepState(step.key)?.status === 'done' || step.kind === 'resolution') continue;
      bySystem.set(step.help.system, [...(bySystem.get(step.help.system) || []), step.title]);
    }
    for (const [system, titles] of bySystem) systems.push(rec(`${system}: ${listText(titles.map(lower))}.`, procBasis()));
  }
  if (usable && r.method) {
    const m = METHODS[r.method.key];
    systems.push(rec(`${m.short} runs through ${listText(m.systems)}.`, fmrac(citeText(m.cite)), { detail: `Purchase method from: ${lower(r.method.from)}.` }));
  }
  const errorClass = ({ umt: 'umt', umt_2way: 'umt', invoice_hold: 'invoice_hold', interface_error: 'interface_error', feeder_reject: 'bfs_reject' } as Record<string, string>)[r.issue || ''];
  const ec = usable && errorClass ? ERROR_CLASSES.find((c) => c.key === errorClass) : null;
  if (ec) systems.push(rec(`${ec.label}: ${ec.where}`, fmrac(ABNORMAL_CITE), { detail: ec.why }));
  addGuidance(r, 'systems', systems);

  calculationsSection(r, s.calculations, plan, procBasis);

  // Corrective action.
  const action = s.corrective_action;
  if (plan) {
    if (causeDecided) {
      if (decidedOption) action.push(rec(`${decidedOption.label}: ${decidedOption.correction}`, optionBasis(decidedOption), { detail: decidedOption.roles.length ? `Carried out by someone holding ${listText(decidedOption.roles)}.` : null }));
    } else {
      if (labelOption) action.push(rec(`The report names “${r.label!.label}”. Once research confirms it: ${labelOption.correction}`, optionBasis(labelOption)));
      for (const o of r.options) {
        if (o === labelOption) continue;
        action.push(rec(`If ${lower(o.label)}: ${o.correction}`, optionBasis(o), { detail: o.roles.length ? `Carried out by someone holding ${listText(o.roles)}.` : null }));
      }
    }
    for (const step of plan.steps) {
      if (applies(step) !== true) continue;
      if (step.kind === 'action') {
        const st = stepState(step.key);
        if (st?.status === 'done') { action.push(fact(`${step.title}: ${step.prepareOnly ? 'prepared' : 'submitted'}.`, evidenceFrom(st.evidence), { evidence: st.evidence })); continue; }
        if (st?.note === 'Prepared, not submitted.') { action.push(fact(`${step.title}: prepared, not submitted.`, evidenceFrom(st.evidence), { evidence: st.evidence })); continue; }
        const gate = step.requires && !verified(r.events, step.requires.check) ? ` First: ${step.requires.message}` : '';
        action.push(rec(`${step.title}: ${step.help.what}${gate}`, procBasis(step), { detail: stepRoles(step).length ? `Needs ${listText(stepRoles(step))}.` : null }));
      } else if (step.kind === 'decision' && step !== r.causeStep && step.decision) {
        const d = decisionOf(r.events, step.decision.key);
        const choice = d ? step.decision.choices.find((c) => c.key === d.body.choice) : null;
        if (d && d.body.choice !== 'refer_for_review') action.push(fact(`${step.title}: ${choice?.label || d.body.choice}.`, fromOf(input, d), { detail: d.body.rationale || null, evidence: [d.id] }));
        else action.push(decide(`${step.title}.`, d ? `Referred for review${d.body.rationale ? `: ${d.body.rationale}` : '.'}` : step.help.what, { evidence: d ? [d.id] : [] }));
      }
    }
    const guards: Array<[string, string]> = [];
    if (isNormal(r.issue) && NORMAL_CONDITIONS[r.issue].guard) guards.push([NORMAL_CONDITIONS[r.issue].guard!, citeText(NORMAL_CONDITIONS[r.issue].cite)]);
    if (r.issue === 'invoice_hold') guards.push([INVOICE_HOLDS.guard, citeText(INVOICE_HOLDS.cite)]);
    if (r.issue === 'interface_error') guards.push([INTERFACE_ERRORS.guard, citeText(INTERFACE_ERRORS.cite)]);
    for (const [g, c] of guards) action.push(rec(g, fmrac(c)));
  }
  addGuidance(r, 'corrective_action', action);

  // Approvals.
  const approvals = s.approvals;
  if (plan) {
    for (const step of plan.steps) {
      if (applies(step) !== true) continue;
      if (step.kind === 'action' && step.waitsOn === 'approval' && !step.prepareOnly) {
        const approved = [...r.events].reverse().find((e) => e.kind === 'external_event' && (e.body.step === step.key || observesStep(plan, e.body.step, step.key)) && ['approved', 'effective', 'posted'].includes(String(e.body.event)));
        if (approved) approvals.push(fact(`${step.title}: ${approved.body.event}.`, fromOf(input, approved), { evidence: [approved.id] }));
        else approvals.push(decide(`Approval of “${lower(step.title)}”.`, `An approver decides once it is submitted: submitting it does not approve it, and approval does not post it.${stepRoles(step).length ? ` Prepared by someone holding ${listText(stepRoles(step))}.` : ''}`));
      }
      if (step.kind === 'control') {
        const check = latestFundsCheck(r.events);
        if (check) approvals.push(fact(`Funds check: ${check.body.result}.`, fromOf(input, check), { evidence: [check.id] }));
        if (!check || check.body.result !== 'PASSED') approvals.push(rec(`${step.title}: ${step.help.what}`, procBasis(step), { detail: 'Vantage refuses the submission until a PASSED check is on the record.' }));
      }
    }
    const offered = new Set(r.options.map((o) => o.key));
    const pending = plan.steps.filter((step) => step.kind === 'action' && step.waitsOn === 'approval' && !step.prepareOnly && applies(step) === null
      && (!offered.size || step.onlyWhen!.choices.some((c) => offered.has(c))));
    if (pending.length) {
      const which = pending.map((step) => {
        const choices = step.onlyWhen!.choices.filter((c) => !offered.size || offered.has(c)).map((c) => r.options.find((o) => o.key === c)?.label || r.causeStep?.decision?.choices.find((x) => x.key === c)?.label || c);
        return `${lower(step.title)} (if ${listText(choices.map(lower))})`;
      });
      approvals.push(unknown('Which approvals apply: it depends on the cause.', `Corrections that route for approval: ${listText(which)}.`));
    }
    const route = decidedOption?.route || (!causeDecided ? labelOption?.route : null) || null;
    if (route) approvals.push(rec(`The ${route} route is performed by ${ROUTES[route].performer}: ${lower(ROUTES[route].purpose)}`, fmrac(ROUTE_CITE)));
    approvals.push(rec(SEPARATION_OF_DUTIES.rules[2], fmrac(citeText(SEPARATION_OF_DUTIES.cite))));
    approvals.push(rec(SEPARATION_OF_DUTIES.rules[3], fmrac(citeText(SEPARATION_OF_DUTIES.cite))));
  }
  addGuidance(r, 'approvals', approvals);

  // Verification.
  const verification = s.verification;
  const met = plan ? resolutionChecks(plan).find((c) => verified(r.events, c.check)) || null : null;
  if (plan) {
    for (const step of plan.steps) {
      if (applies(step) !== true) continue;
      if (step.kind === 'verification') {
        const v = step.check ? latestVerification(r.events, step.check) : null;
        if (v?.body.result === 'verified') verification.push(fact(`Verified: ${lower(step.title)}.`, fromOf(input, v), { detail: v.body.text || null, evidence: [v.id] }));
        else if (v) verification.push(fact(`Checked and not verified: ${lower(step.title)}.`, fromOf(input, v), { detail: v.body.text || null, evidence: [v.id] }));
        if (v?.body.result !== 'verified') verification.push(rec(`${step.title}: ${step.help.what}`, procBasis(step)));
      } else if (step.kind === 'external') {
        const st = stepState(step.key);
        if (st?.status === 'done') verification.push(fact(`${step.title}.`, evidenceFrom(st.evidence), { evidence: st.evidence }));
        else if (st?.status === 'attention') verification.push(fact(`${step.title}: ${lower(st.note || 'needs attention')}`, evidenceFrom(st.evidence), { evidence: st.evidence }));
        else {
          if (st?.note && st.evidence.length) verification.push(fact(`${step.title}: ${lower(st.note)}`, evidenceFrom(st.evidence), { evidence: st.evidence }));
          verification.push(rec(`${step.title}: ${step.help.what}`, procBasis(step), { detail: step.help.meaning || null }));
        }
      }
    }
    const conditionCheck: [string, string] | null = isNormal(r.issue) ? [NORMAL_CONDITIONS[r.issue].verification, citeText(NORMAL_CONDITIONS[r.issue].cite)]
      : r.issue === 'interface_error' ? [INTERFACE_ERRORS.verification, citeText(INTERFACE_ERRORS.cite)]
        : r.issue === 'feeder_reject' && r.feeder ? [FEEDER_REJECTS[r.feeder].verification, citeText(FEEDER_REJECTS[r.feeder].cite)]
          : null;
    if (conditionCheck && !met) verification.push(rec(conditionCheck[0], fmrac(conditionCheck[1])));
  }
  for (const rep of input.reports || []) {
    if (!rep.on_latest && rep.listed_as_of) {
      verification.push(derived(`Not on the latest ${reportName(rep.report)} (as of ${rep.latest_as_of}). The one as of ${rep.listed_as_of} listed it.`, 'Compared the filed reports by the case’s identifier.', null, { detail: 'A lead, not proof it cleared: a report can leave a row out for other reasons. Verify in the system of record.' }));
    } else if (rep.on_latest && !rep.closed) {
      verification.push(derived(`Still open on the latest ${reportName(rep.report)} (as of ${rep.latest_as_of}).`, 'Read the filed report’s status for the case’s identifier.'));
    }
  }
  addGuidance(r, 'verification', verification);

  // Resolution criteria.
  const resolution = s.resolution_criteria;
  if (plan) {
    for (const check of resolutionChecks(plan)) {
      const checkStep = plan.steps.find((x) => x.kind === 'verification' && x.check === check.check);
      if (checkStep && applies(checkStep) === false) continue;
      const v = latestVerification(r.events, check.check);
      if (v?.body.result === 'verified') resolution.push(fact(`Met: ${lower(check.label)}.`, fromOf(input, v), { evidence: [v.id] }));
      else if (!met) resolution.push(rec(`Resolve when: ${lower(check.label)}.`, procBasis(), { detail: r.trusted ? 'Vantage refuses to resolve the case before one of these is verified.' : null }));
    }
    if (r.issue === 'umt' || r.issue === 'umt_2way') resolution.push(rec(`Done means: ${UMT_COMPLETION.join(' ')}`, fmrac(citeText(UMT.cite)), { detail: 'Editorial completion criteria drawn from the reference.' }));
  }
  const resolved = input.item.stage === 'resolved' ? [...r.events].reverse().find((e) => e.kind === 'resolved') : null;
  if (resolved) resolution.push(fact('The case is resolved.', fromOf(input, resolved), { evidence: [resolved.id] }));
  else if (input.item.stage === 'resolved') {
    // Closed without Vantage's resolution step: it came in closed, or was closed some other way. It is not asked to be
    // resolved again, and it is never shown as a verified resolution.
    const closedBy = [...r.events].reverse().find((e) => e.kind === 'stage_changed' && e.body.to === 'resolved');
    resolution.push(fact('The case is marked resolved.', closedBy ? fromOf(input, closedBy) : `${importedFrom(input)}, which marked it resolved`, { evidence: closedBy ? [closedBy.id] : [] }));
    resolution.push(unknown('Whether its resolution was verified.', 'No resolution is recorded in Vantage, so nothing here shows what closed it or how it was checked. Confirm it in the system of record before relying on it.'));
  } else if (input.item.stage !== 'not_applicable') resolution.push(decide('Resolve the case.', 'A person resolves it, on the evidence. Vantage does not resolve a case on its own.'));
  addGuidance(r, 'resolution_criteria', resolution);

  const sections = SECTIONS.map((x) => ({ key: x.key, title: x.title, statements: orderStatements(s[x.key]) }));
  const all = sections.flatMap((x) => x.statements);
  const counts = Object.fromEntries(STATEMENT_LABELS.map((l) => [l, all.filter((x) => x.label === l).length])) as Record<StatementLabel, number>;
  const sources = PROVENANCE.map((p) => ({
    ...p,
    used: all.filter((x) => x.basis?.authority === p.authority).length,
    on_file: (GUIDANCE_AUTHORITIES as readonly string[]).includes(p.authority) ? r.guidance.filter((g) => g.authority === p.authority).length : null,
  }));
  const info = issueType(r.issue);
  const limits = [
    'Vantage’s rules read this case; they do not decide it. A recommendation is only as strong as the source shown beside it.',
    ...(r.guidance.some((g) => g.authority === 'official_policy' || g.authority === 'official_system_guidance') ? [] : ['No official policy or system guidance is on file for this issue. The FMRAC is a training reference, not current policy.']),
    ...(r.how === 'words' ? ['The issue type is a lead from the words on the case. Nothing else here is built on it until a person confirms it or applies the procedure that fits.'] : []),
    ...(plan ? plan.limitations : []),
    'No AI wrote this diagnosis.',
  ];
  const causeText = !plan || !r.causeStep ? '' : causeDecided ? `Cause recorded: ${lower(decidedOption?.label || String(r.cause!.body.choice))}.` : r.cause ? 'The cause is referred for review.' : 'The cause is not decided yet.';
  const countText = `${counts.unknown} ${counts.unknown === 1 ? 'thing is' : 'things are'} unknown; ${counts.decision_required} ${counts.decision_required === 1 ? 'decision needs' : 'decisions need'} a person.`;
  const headline = [`${info ? info.label : 'Issue type not known yet'}${r.how === 'words' ? ' (a lead, not confirmed)' : ''}.`, causeText, countText].filter(Boolean).join(' ');

  return {
    engine: DIAGNOSIS_ENGINE,
    as_of: input.today,
    issue: { key: r.issue, label: info?.label || 'Not known yet', short: info?.short || null, how: r.how, procedure: info?.procedure || null, applied: Boolean(r.applied), confirmed: Boolean(r.trusted) },
    headline, sections, counts, sources, limits: unique(limits), ai: false,
  };
}

/** What an import preview shows for one row: the issue type it reads as, and from what. */
export interface IssueReading { key: IssueKey | null; short: string | null; how: IssueHow | null }

/** Only the issue type a case reads as, and how: cheap enough for every row of an import preview. */
export function issueReading(input: DiagnosisInput): IssueReading {
  const r = read(input);
  return { key: r.issue, short: issueType(r.issue)?.short ?? null, how: r.how };
}

/** A report type's name as a reader says it: “the ULO report”, never “the ULO report report”. */
const reportName = (name: string) => (/\breport$/i.test(name.trim()) ? name.trim() : `${name.trim()} report`);

export function summarize(d: CaseDiagnosis): DiagnosisSummary {
  return { issue: d.issue.short, headline: d.headline, unknown: d.counts.unknown, decisions: d.counts.decision_required };
}

const verified = (events: CaseEvent[], check: string) => latestVerification(events, check)?.body.result === 'verified';

/** The figures a report left blank, which the arithmetic subtracts as zero and nothing else does. */
function notShownNote(r: Reading): string | null {
  const blank = LIFECYCLE.filter((f) => r.figures[f.key] && !r.figures[f.key]!.shown).map((f) => f.label.toLowerCase());
  return blank.length ? `Not shown: ${listText(blank)}. Subtracted as zero for the arithmetic only; that is not evidence of zero.` : null;
}

/** Whether an external step that watches several actions (correction_posted) was reported for this one. */
function observesStep(plan: Procedure, externalStep: unknown, actionStep: string) {
  const ext = plan.steps.find((x) => x.key === externalStep);
  return Boolean(ext?.observes && (ext.observes.step === actionStep || ext.observes.steps?.includes(actionStep)));
}

function addGuidance(r: Reading, section: GuidanceSection, out: Statement[]) {
  for (const g of r.guidance) {
    if (g.section !== section) continue;
    if (g.authority === 'historical_case') {
      const causeLabel = g.cause ? r.causeStep?.decision?.choices.find((c) => c.key === g.cause)?.label || g.cause.replace(/_/g, ' ') : null;
      const which = g.case ? ` (“${g.case.title}”)` : '';
      out.push(rec(`A validated past case${which}${causeLabel ? ` had cause “${lower(causeLabel)}”` : ''}: ${g.text}`, basisOf('historical_case', g.citation, { guidance_id: g.id, case_id: g.case?.id ?? null })));
      continue;
    }
    out.push(rec(g.text, basisOf(g.authority, g.citation, { guidance_id: g.id }), { detail: g.enterprise ? 'On file for the whole service.' : null }));
  }
}

function issueSection(r: Reading, out: Statement[]) {
  const { input } = r;
  // A closed case takes no procedure until it is reopened, so it is not asked for one.
  const closed = isClosed(input);
  out.push(fact(`The case reads “${input.item.title}”${input.item.reference ? `, reference ${input.item.reference}` : ''}.`, importedFrom(input)));
  for (const rep of input.reports || []) {
    if (!rep.listed_as_of) continue;
    const bits = [rep.status ? `status ${rep.status}` : null, rep.amount_cents != null ? formatCents(rep.amount_cents) : null, rep.age_days != null ? `${rep.age_days} days old` : null].filter(Boolean);
    out.push(fact(`Listed on the ${reportName(rep.report)} as of ${rep.listed_as_of}${bits.length ? `: ${bits.join(', ')}` : ''}.`, `The ${reportName(rep.report)} filed for this unit${rep.source_row ? `, row ${rep.source_row}` : ''}`));
  }

  const appliedEvent = r.appliedEvent;
  if (r.applied) {
    const who = appliedEvent?.actor_id ? input.people?.[appliedEvent.actor_id] || 'A former member' : null;
    const when = appliedEvent ? day(appliedEvent.occurred_at) : '';
    const picked = appliedEvent?.body.picked as string | undefined;
    const from = !appliedEvent ? null
      : appliedEvent.body.confirms ? `Confirmed by ${who || 'Vantage'} on ${when}`
        : picked ? `Applied by the import${who ? ` ${who} ran` : ''} on ${when}, ${picked === 'words' ? 'from the words on the row alone' : picked === 'figures' ? 'from the row’s figures' : 'as the import was told to'}`
          : who ? `Applied by ${who} on ${when}` : `Applied by the import on ${when}`;
    out.push(fact(`The case follows “${r.applied.title}” v${r.applied.version}.`, from, { evidence: appliedEvent ? [appliedEvent.id] : [] }));
  }
  if (r.label) {
    const text = r.label.issue === 'umt_2way'
      ? 'The error text matches the 2-Way UMT trigger in the SME walkthrough: PO open quantity below the DCAS quantity.'
      : `The report’s error text matches “${r.label.label}”, a ${issueType(r.label.issue)!.short} error the FMRAC names.`;
    out.push(derived(text, `Matched the words of ${lower(r.label.from)} against the known error labels.`, r.label.basis));
  }
  if (r.balance) {
    const shown = r.balance.findings.map((f) => `${f.abbr} ${formatCents(f.residualCents)} open (${f.pattern})`);
    const odd = r.balance.anomalies.map((a) => lower(a.title));
    const text = r.balance.complete ? 'The figures show nothing open between commitment and payment.' : `The figures show ${listText([...shown, ...odd])}.`;
    out.push(derived(text, r.balance.findings.map((f) => f.arithmetic).join('; ') || 'Compared phase with phase.', fmrac(RESIDUAL_CITE), { detail: notShownNote(r) }));
  }

  const appliedIssue = issueForProcedure(r.applied?.key);
  if (appliedIssue) {
    const conflicts: string[] = [];
    if (r.label && family(r.label.issue) !== family(appliedIssue)) conflicts.push(`the report’s error text names a ${issueType(r.label.issue)!.short} error`);
    if (isNormal(appliedIssue) && r.balance && !r.balance.findings.some((f) => f.condition === appliedIssue)) conflicts.push(r.balance.complete ? 'the figures show nothing open' : `the figures show ${listText(r.balance.findings.map((f) => f.abbr).concat(r.balance.anomalies.map((a) => lower(a.title))))}`);
    if (conflicts.length) out.push(decide('Confirm the issue type.', `The case follows the ${issueType(appliedIssue)!.short} procedure, but ${listText(conflicts)}.`));
    else if (r.wordPick && !r.trusted) {
      if (r.lead?.issue === appliedIssue) out.push(rec(`It may be this: ${lower(issueType(appliedIssue)!.label)}. ${r.lead.why}`, basisOf('vantage_inference', null), { detail: 'Read from the words on the case only. Confirm it against the report before relying on it.' }));
      if (!closed) out.push(decide('Confirm the issue type.', 'The import chose this procedure from the words on the row alone. Nothing else on the case confirms it yet: confirm it, or apply the procedure that fits.'));
    }
  } else if (r.issue) {
    if (r.how === 'words' && r.lead) {
      out.push(rec(`It may be this: ${lower(issueType(r.lead.issue)!.label)}. ${r.lead.why}`, basisOf('vantage_inference', null), { detail: 'Read from the words on the case only. Confirm it against the report before relying on it.' }));
    }
    const info = issueType(r.issue)!;
    if (!closed) out.push(decide(`Apply a procedure: “${PROCEDURES[info.procedure]?.title || info.label}”, or the one that fits.`, 'Applying it confirms the issue type and lets Vantage track each step.'));
  } else {
    out.push(unknown('The issue type.', 'Nothing on the case names an error the reference knows, and no lifecycle figures are recorded.'));
    if (!closed) out.push(decide('Decide what kind of issue this is, and apply the procedure that fits.'));
  }
}

function causeSection(r: Reading, out: Statement[], plan: Procedure | null, decided: CauseOption | null, labelOption: CauseOption | null) {
  const { input } = r;
  if (!plan) {
    out.push(unknown('The cause.', r.how === 'words' ? 'The issue type is only a lead, so no causes are offered yet.' : 'No issue type is established yet.'));
    addGuidance(r, 'probable_cause', out);
    return;
  }
  if (!r.causeStep) {
    out.push(rec(`The trigger names the condition: ${plan.trigger}`, basisOf(plan.authority, plan.source)));
    addGuidance(r, 'probable_cause', out);
    return;
  }
  if (r.cause && r.cause.body.choice !== 'refer_for_review') {
    out.push(fact(`Cause decided: ${decided?.label || r.cause.body.choice}.`, fromOf(input, r.cause), { detail: r.cause.body.rationale || null, evidence: [r.cause.id] }));
    if (decided?.valid) out.push(derived('That cause is a valid open balance, not an error.', 'Read from the reference’s description of the cause.', optionBasis(decided)));
    addGuidance(r, 'probable_cause', out);
    return;
  }
  if (r.cause) out.push(decide('Decide the cause: it was referred for review.', r.cause.body.rationale ? `Referred because: ${r.cause.body.rationale}` : null, { evidence: [r.cause.id] }));
  else out.push(unknown('The cause is not established yet.', 'A likely cause is not a proven fact.'));

  for (const p of pointers(r)) out.push(p);
  if (labelOption) out.push(rec(`The report’s label points to “${lower(labelOption.label)}”. Validate it before acting on it.`, optionBasis(labelOption)));
  for (const o of r.options) {
    if (o === labelOption) continue;
    out.push(rec(`Possible cause: ${lower(o.label)}${o.valid ? ' (a valid open balance, not an error)' : ''}.`, optionBasis(o)));
  }
  addGuidance(r, 'probable_cause', out);
  if (!r.cause) out.push(decide('Decide the cause the evidence supports, and record why.', `Under “${r.causeStep.title}”.`));
}

/** Comparisons of recorded facts that point at one cause. Each is arithmetic or an exact comparison, never a reading of words. */
function pointers(r: Reading): Statement[] {
  const out: Statement[] = [];
  const obs = (f: string) => latestObservation(r.events, f);
  const cents = (f: string) => { const e = obs(f); return e && Number.isSafeInteger(e.body.amount_cents) ? { v: e.body.amount_cents as number, e } : null; };
  const count = (f: string) => { const e = obs(f); const n = e ? Number(String(e.body.value_text ?? '').replace(/,/g, '')) : NaN; return e && Number.isFinite(n) ? { v: n, e } : null; };
  const option = (key: string) => r.options.find((o) => o.key === key);
  const basis = (key: string) => { const o = option(key); return o ? optionBasis(o) : null; };
  const fits = (key: string) => (option(key) ? `, which fits “${lower(option(key)!.label)}”` : '');

  if (r.issue === 'umt') {
    const po = cents('po_line_amount'), billed = cents('billed_amount');
    if (po && billed && billed.v > po.v) out.push(derived(`Billed ${formatCents(billed.v)} is ${formatCents(billed.v - po.v)} more than the PO line ${formatCents(po.v)}${fits('billed_exceeds_po_line')}.`, 'billed amount − PO line amount', basis('billed_exceeds_po_line'), { evidence: [po.e.id, billed.e.id] }));
    const status = obs('award_status');
    const text = String(status?.body.value_text || '').trim();
    if (status && text && text.toUpperCase() !== 'APPROVED' && /^[A-Z_ ]+$/.test(text)) out.push(derived(`Award status is ${text}, not APPROVED${fits('award_not_approved')}.`, 'Compared the recorded award status with APPROVED.', basis('award_not_approved'), { evidence: [status.id] }));
  }
  if (r.issue === 'invoice_hold') {
    const ordered = count('quantity_ordered'), billedQ = count('quantity_billed'), received = count('quantity_received');
    const matchType = obs('match_type')?.body.value_text;
    if (ordered && billedQ && billedQ.v > ordered.v) out.push(derived(`Quantity billed ${billedQ.v} exceeds quantity ordered ${ordered.v}${fits('billed_exceeds_ordered')}.`, 'quantity billed − quantity ordered', basis('billed_exceeds_ordered'), { evidence: [ordered.e.id, billedQ.e.id] }));
    if (received && billedQ && billedQ.v > received.v && matchType !== 'two_way') out.push(derived(`Quantity billed ${billedQ.v} exceeds quantity received ${received.v}${fits('billed_exceeds_received')}.`, 'quantity billed − quantity received (three-way match)', basis('billed_exceeds_received'), { evidence: [received.e.id, billedQ.e.id] }));
    const po = cents('po_line_amount'), billed = cents('billed_amount');
    if (po && billed && billed.v !== po.v && ordered && billedQ && billedQ.v === ordered.v) out.push(derived(`The quantities agree but billed ${formatCents(billed.v)} differs from the PO line ${formatCents(po.v)}${fits('price_change')}.`, 'billed amount against PO line amount, at equal quantities', basis('price_change'), { evidence: [po.e.id, billed.e.id] }));
  }
  if (r.issue === 'oto') {
    const travel = obs('travel_occurred');
    if (travel?.body.value_text === 'no') out.push(derived(`Travel did not occur, as recorded${fits('travel_did_not_occur')}.`, 'Read the recorded answer to “Did travel occur?”.', basis('travel_did_not_occur'), { evidence: [travel.id] }));
    if (travel?.body.value_text === 'yes' && option('travel_did_not_occur')) out.push(derived('Travel occurred, as recorded, so “travel did not occur” does not fit.', 'Read the recorded answer to “Did travel occur?”.', basis('travel_did_not_occur'), { evidence: [travel.id] }));
  }
  return out;
}

function calculationsSection(r: Reading, out: Statement[], plan: Procedure | null, procBasis: (step?: ProcedureStep) => Basis) {
  const { input } = r;
  for (const f of LIFECYCLE) {
    const fig = r.figures[f.key];
    if (fig?.shown) out.push(fact(`${fig.label}: ${formatCents(fig.cents!)}.`, fig.from, { evidence: fig.evidence }));
  }
  const usable = r.how !== 'words';
  if (usable && r.balance) {
    for (const f of r.balance.findings) out.push(derived(`${f.abbr} open: ${formatCents(f.residualCents)} (${f.pattern}).`, f.arithmetic, fmrac(RESIDUAL_CITE), { detail: [f.whatIsOpen, 'The arithmetic names the gap; it never proves the cause.', notShownNote(r)].filter(Boolean).join(' ') }));
    if (r.balance.complete) out.push(derived('Nothing is open between the phases shown.', 'Each phase is covered by the next.', fmrac(RESIDUAL_CITE)));
    for (const a of r.balance.anomalies) out.push(derived(`${a.title}: ${a.detail}`, 'Compared phase with phase.', fmrac(ABNORMAL_CITE)));
    if (r.balance.anomalies.length) out.push(decide('Review the out-of-order figures before relying on the arithmetic.', 'Confirm all four come from one document, line and scope.'));
  }
  if (plan) {
    for (const step of plan.steps) {
      if (step.kind !== 'calculation' || !step.formula) continue;
      const formula = FORMULAS[step.formula];
      // A step the decided cause rules out is skipped by the procedure, so its arithmetic is not offered or asked for.
      const excluded = stepApplies(step, r.events) === false;
      const recorded = [...r.events].reverse().find((e) => e.kind === 'calculation' && e.body.formula === step.formula);
      if (recorded) {
        out.push(fact(`${formula?.title || step.title}: ${recorded.body.display}.`, fromOf(input, recorded), { evidence: [recorded.id], detail: excluded ? 'Recorded before the cause was decided. The cause decided since skips this step.' : null }));
        const state = calculationState(recorded, input.events);
        if (state.stale && !excluded) out.push(rec(`Calculate again: ${state.reasons.join('; ')}.`, procBasis(step)));
        continue;
      }
      if (excluded) continue;
      if (step.formula === 'lifecycle_residual') {
        if (!r.balance) out.push(unknown(`${step.title}: needs the four lifecycle figures.`));
        continue;
      }
      const live = step.formula === 'umt_award_shortfall' ? awardShortfall(input.events) : step.formula === 'umt2way_award_adjustment' ? candidateAdjustment(input.events) : null;
      if (!live) continue;
      if (live.ok) {
        out.push(derived(`${formula?.title || step.title}: ${live.display}.`, formula?.text || step.help.what, procBasis(step), { detail: formula?.applicability || null, evidence: live.inputs.map((i) => i.event_id) }));
        if (live.requires_review) out.push(decide('Review the zero or downward result before anything changes.', 'The arithmetic is a candidate, never a permission.'));
      } else {
        out.push(unknown(`${formula?.title || step.title}: needs ${listText(live.missing)}.`));
      }
    }
  }
  const open = input.item.stage !== 'resolved' && input.item.stage !== 'not_applicable';
  if (isDay(input.item.created_at) && open) {
    const age = daysBetween(day(input.item.created_at), input.today);
    if (age >= 0) out.push(derived(`Open ${age} ${age === 1 ? 'day' : 'days'} in Vantage.`, `${input.today} − ${day(input.item.created_at)}`, null, { detail: 'Age alone does not make a balance invalid.' }));
  }
  if (isDay(input.item.due_date) && open) {
    const left = daysBetween(input.today, day(input.item.due_date));
    out.push(derived(left >= 0 ? `Due ${day(input.item.due_date)}: ${left} ${left === 1 ? 'day' : 'days'} left.` : `Due ${day(input.item.due_date)}: ${-left} ${left === -1 ? 'day' : 'days'} past due.`, `${day(input.item.due_date)} − ${input.today}`));
  }
  addGuidance(r, 'calculations', out);
}

/**
 * The rule diagnosis as an AI case brief is given it: compact, ordered, every statement with its label and source. The
 * brief is told to keep each label and source and never to raise a statement's rank (server/services/ai.ts).
 */
export function diagnosisForBrief(d: CaseDiagnosis) {
  return {
    engine: `${d.engine.key} ${d.engine.version}`,
    issue: d.issue.label,
    headline: d.headline,
    sections: d.sections.map((x) => ({
      section: x.title,
      statements: x.statements.map((st) => ({ label: STATEMENT_LABEL_TEXT[st.label], text: st.text, source: st.basis ? `${provenanceOf(st.basis.authority).label} (rank ${st.basis.rank})${st.basis.citation ? `: ${st.basis.citation}` : ''}` : null })),
    })),
  };
}
