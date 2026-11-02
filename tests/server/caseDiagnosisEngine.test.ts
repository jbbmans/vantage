import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIAGNOSIS_ENGINE, SECTIONS, STATEMENT_LABELS, diagnoseCase, diagnosisForBrief, issueReading, orderStatements, summarize,
  type CaseDiagnosis, type DiagnosisInput, type GuidanceEntry, type Statement,
} from '../../shared/caseDiagnosis.ts';
import { PROCEDURES } from '../../shared/procedures.ts';
import { PROVENANCE, provenanceOf } from '../../shared/procedureTypes.ts';

/**
 * The automatic financial case diagnoser (Task 16, ADR-0022), read as a pure function: what it says about a case from
 * the case alone, every statement labelled, every recommendation ranked by its source, and never inference as policy.
 */

let n = 0;
const ev = (kind: string, body: Record<string, unknown>, actor: string | null = 'u1') =>
  ({ id: `e${++n}`, kind, actor_id: actor, occurred_at: `2026-11-01T10:${String(n % 60).padStart(2, '0')}:00Z`, body });
const item = (over: Partial<DiagnosisInput['item']> = {}): DiagnosisInput['item'] =>
  ({ title: 'Open balance', reference: 'SYN-1', due_date: null, created_at: '2026-10-20T00:00:00Z', stage: 'not_started', filename: null, source_row: null, ...over });
const all = (d: CaseDiagnosis) => d.sections.flatMap((s) => s.statements);
const section = (d: CaseDiagnosis, key: string) => d.sections.find((s) => s.key === key)!.statements;
const texts = (list: Statement[]) => list.map((s) => s.text).join('\n');

const sop = (over: Partial<GuidanceEntry> = {}): GuidanceEntry => ({ id: 'g-sop', authority: 'approved_local_sop', issue: 'udou', section: 'research', text: 'Ask the supply chief for the back-order report first.', citation: 'G-8 SOP 7300.2 para 4.b', enterprise: false, effective_on: null, ...over });
const policy = (over: Partial<GuidanceEntry> = {}): GuidanceEntry => ({ id: 'g-pol', authority: 'official_policy', issue: 'udou', section: 'research', text: 'Review each unliquidated obligation for validity.', citation: 'DoD 7000.14-R Vol 3 Ch 8 para 080502', enterprise: true, effective_on: '2026-01-01', ...over });
const example = (over: Partial<GuidanceEntry> = {}): GuidanceEntry => ({ id: 'g-case', authority: 'historical_case', issue: 'udou', section: 'research', text: 'The receipt was signed but never keyed.', citation: 'Case N001, resolved 2026-09-01', enterprise: false, effective_on: '2026-09-02', cause: 'receipt_not_recorded', case: { id: 'w-old', title: 'N001' }, ...over });

/** A UDOU case: imported figures that show it, no procedure applied yet. */
const udouSheet: DiagnosisInput = {
  item: item({ title: 'Undelivered order', reference: 'OB-2', filename: 'balances.csv', source_row: 3 }),
  sheet: [
    { field: 'commitment', column: 'Commitment', value: '100.00' }, { field: 'obligation', column: 'Obligation', value: '100.00' },
    { field: 'delivered', column: 'Delivered', value: '50.00' }, { field: 'paid', column: 'Paid', value: '50.00' },
    { field: 'purchase_method', column: 'Method', value: 'GCSS-MC' },
  ],
  events: [], procedure: null, today: '2026-11-02',
};

test('it answers in the specification’s order, every statement carries one of the five labels, and every recommendation its source and rank', () => {
  const d = diagnoseCase({ ...udouSheet, guidance: [sop(), policy()] });
  assert.deepEqual(d.sections.map((s) => s.key), SECTIONS.map((s) => s.key));
  assert.deepEqual(d.sections.map((s) => s.title), ['Issue type', 'Probable cause', 'Missing information', 'Research needed', 'Systems to inspect', 'Calculations', 'Corrective action', 'Approvals', 'Verification', 'Resolution criteria']);
  for (const s of all(d)) {
    assert.ok((STATEMENT_LABELS as readonly string[]).includes(s.label), s.text);
    if (s.label === 'recommendation') {
      assert.ok(s.basis, `a recommendation names its source: ${s.text}`);
      assert.equal(s.basis!.rank, provenanceOf(s.basis!.authority).rank, 'its rank is its source’s, never raised');
    }
  }
  assert.equal(d.ai, false);
  assert.ok(d.limits.includes('No AI wrote this diagnosis.'));
  assert.deepEqual(d.engine, DIAGNOSIS_ENGINE);
  const counted = Object.fromEntries(STATEMENT_LABELS.map((l) => [l, all(d).filter((s) => s.label === l).length]));
  assert.deepEqual(d.counts, counted, 'the counts are the statements’ own');
});

test('within a section, facts come first, then derived values, then recommendations in provenance order, then unknowns and decisions', () => {
  const d = diagnoseCase({ ...udouSheet, procedure: PROCEDURES.udou_research, events: [ev('procedure_applied', { procedure: 'udou_research', version: PROCEDURES.udou_research.version }, null)], guidance: [example(), sop(), policy(), sop({ id: 'g-wf', authority: 'validated_sme_workflow', text: 'Workflow step.', citation: 'SME workflow 3' })] });
  const labelOrder = STATEMENT_LABELS as readonly string[];
  for (const s of d.sections) {
    const labels = s.statements.map((x) => labelOrder.indexOf(x.label));
    assert.deepEqual(labels, [...labels].sort((a, b) => a - b), `${s.title} is in label order`);
    const ranks = s.statements.filter((x) => x.label === 'recommendation').map((x) => x.basis!.rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `${s.title} weighs its recommendations in provenance order`);
  }
  const research = section(d, 'research').filter((s) => s.label === 'recommendation').map((s) => s.basis!.authority);
  assert.deepEqual(research.slice(0, 3), ['official_policy', 'approved_local_sop', 'validated_sme_workflow'], 'official policy, then the command’s SOP, then a validated workflow');
  assert.equal(research.at(-1), 'historical_case', 'a past case ranks below the training reference');
  const fromCase = section(d, 'research').find((s) => s.basis?.authority === 'historical_case')!;
  assert.equal(fromCase.basis!.case_id, 'w-old', 'a validated example links its own case');
  // orderStatements is the rule itself: a shuffled list comes back in the same label and rank order.
  const key = (s: Statement) => `${s.label}:${s.basis?.rank ?? '-'}`;
  const shuffled = [...section(d, 'research')].reverse();
  assert.deepEqual(orderStatements(shuffled).map(key), section(d, 'research').map(key));
});

test('the provenance ladder is the specification’s six tiers, with the training reference and an unvalidated walkthrough between them', () => {
  assert.deepEqual(PROVENANCE.map((p) => p.authority), ['official_policy', 'official_system_guidance', 'approved_local_sop', 'validated_sme_workflow', 'training_reference', 'historical_case', 'sme_walkthrough', 'vantage_inference', 'ai_inference']);
  assert.deepEqual(PROVENANCE.map((p) => p.tier), [1, 2, 3, 4, null, 5, null, 6, 6]);
  const d = diagnoseCase({ ...udouSheet, guidance: [sop(), policy()] });
  assert.deepEqual(d.sources.map((s) => s.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const by = Object.fromEntries(d.sources.map((s) => [s.authority, s]));
  assert.equal(by.official_policy.on_file, 1);
  assert.equal(by.official_system_guidance.on_file, 0, 'a tier with nothing on file says so');
  assert.equal(by.training_reference.on_file, null, 'the training reference ships with Vantage; it is not put on file');
  assert.ok(by.training_reference.used > 0);
  assert.equal(by.ai_inference.used, 0, 'the rule diagnosis never draws on AI');
});

test('figures and an error label read as derived values; words alone read as inference, ranked last, and nothing is built on them', () => {
  const figures = diagnoseCase(udouSheet);
  assert.equal(figures.issue.key, 'udou');
  assert.equal(figures.issue.how, 'figures');
  const read = section(figures, 'issue_type').find((s) => s.label === 'derived_value')!;
  assert.match(read.text, /UDOU \$50\.00 open/);
  assert.equal(read.basis!.authority, 'training_reference');
  assert.ok(section(figures, 'probable_cause').some((s) => /^Possible cause:/.test(s.text)), 'a reading from the figures offers the reference’s causes');
  assert.ok(section(figures, 'issue_type').some((s) => s.label === 'decision_required' && /Apply a procedure/.test(s.text)), 'a person confirms the issue type by applying a procedure');

  const label = diagnoseCase({ item: item({ title: 'Row 7' }), sheet: [{ field: 'error_text', column: 'Error', value: 'Invoice on hold: quantity billed exceeds quantity received' }], events: [], procedure: null, today: '2026-11-02' });
  assert.equal(label.issue.key, 'invoice_hold');
  assert.equal(label.issue.how, 'error_label');

  const words = diagnoseCase({ item: item({ title: 'Outstanding travel order for TAD to Quantico' }), events: [], procedure: null, today: '2026-11-02', guidance: [sop({ issue: 'oto', section: 'probable_cause', text: 'OTO SOP step.' }), policy({ issue: 'any', section: 'resolution_criteria', text: 'Any-issue policy.' })] });
  assert.equal(words.issue.key, 'oto');
  assert.equal(words.issue.how, 'words');
  const lead = section(words, 'issue_type').find((s) => s.label === 'recommendation')!;
  assert.equal(lead.basis!.authority, 'vantage_inference');
  assert.equal(lead.basis!.rank, 8);
  assert.ok(!all(words).some((s) => /^Possible cause:|^If /.test(s.text)), 'no cause or correction is built on a reading from words');
  assert.ok(!texts(all(words)).includes('OTO SOP step.'), 'the issue’s own guidance waits until a person confirms the issue');
  assert.ok(texts(all(words)).includes('Any-issue policy.'), 'guidance for any issue still applies');
  assert.ok(section(words, 'issue_type').some((s) => s.label === 'decision_required'));
  for (const s of all(words)) if (s.basis?.authority === 'vantage_inference') assert.notEqual(s.label, 'known_fact', 'inference is never a fact');

  const nothing = diagnoseCase({ item: item({ title: 'Staff a birthday card' }), events: [], procedure: null, today: '2026-11-02' });
  assert.equal(nothing.issue.key, null);
  assert.ok(section(nothing, 'issue_type').some((s) => s.label === 'unknown'));
  assert.ok(section(nothing, 'issue_type').some((s) => s.label === 'decision_required'));
});

test('a blank or a dash is unknown, never zero, and the figures it would need are named', () => {
  const d = diagnoseCase({
    item: item({ title: 'Open commitment', reference: 'OB-1', filename: 'balances.csv', source_row: 2 }),
    sheet: [{ field: 'commitment', column: 'Commitment', value: '100.00' }, { field: 'obligation', column: 'Obligation', value: '-' }, { field: 'delivered', column: 'Delivered', value: '' }, { field: 'paid', column: 'Paid', value: '—' }],
    events: [], procedure: null, today: '2026-11-02',
  });
  assert.equal(d.issue.key, 'ocmt');
  const missing = section(d, 'missing_information');
  for (const f of ['Obligation', 'Delivered', 'Paid']) assert.ok(missing.some((s) => s.label === 'unknown' && s.text.startsWith(`${f}: not shown`)), f);
  assert.ok(!section(d, 'calculations').some((s) => s.label === 'known_fact' && /^Obligation: \$0\.00/.test(s.text)), 'a dash is not recorded as $0.00');
  assert.ok(section(d, 'calculations').some((s) => s.label === 'known_fact' && s.text === 'Commitment: $100.00.' && /balances\.csv, row 2, column “Commitment”/.test(String(s.from))), 'a fact says where it came from');
});

test('a decided cause and a verified resolution become known facts, with who recorded them', () => {
  const events = [
    ev('procedure_applied', { procedure: 'udou_research', version: PROCEDURES.udou_research.version }, null),
    ev('observation', { field: 'commitment_amount', amount_cents: 10000, source: 'source_file' }, null),
    ev('observation', { field: 'obligation_amount', amount_cents: 10000, source: 'source_file' }, null),
    ev('observation', { field: 'delivered_amount', amount_cents: 0, source: 'source_file' }, null),
    ev('observation', { field: 'paid_amount', amount_cents: 0, source: 'source_file' }, null),
  ];
  const causeStep = PROCEDURES.udou_research.steps.find((s) => s.kind === 'decision' && s.key === 'cause')!;
  const choice = causeStep.decision!.choices.find((c) => c.key !== 'refer_for_review')!;
  const decided = diagnoseCase({ item: item({ stage: 'researching' }), events: [...events, ev('decision', { decision: causeStep.decision!.key, choice: choice.key, rationale: 'Signed receipt on file.' })], procedure: PROCEDURES.udou_research, today: '2026-11-02', people: { u1: 'Sgt Avery' } });
  const cause = section(decided, 'probable_cause');
  assert.ok(cause.some((s) => s.label === 'known_fact' && s.text.includes(choice.label) && /Sgt Avery/.test(String(s.from))), texts(cause));
  assert.ok(!cause.some((s) => /^Possible cause:/.test(s.text)), 'once decided, the other possibilities are not offered as open');
  assert.ok(!cause.some((s) => s.label === 'decision_required'));

  const resolution = PROCEDURES.udou_research.resolvesOn![0];
  const resolved = diagnoseCase({ item: item({ stage: 'resolved' }), events: [...events, ev('decision', { decision: causeStep.decision!.key, choice: choice.key }), ev('verification', { check: resolution.check, result: 'verified', reference: 'OAS 11/02' }), ev('resolved', {}, 'u2')], procedure: PROCEDURES.udou_research, today: '2026-11-02', people: { u1: 'Sgt Avery', u2: 'GySgt Chen' } });
  const criteria = section(resolved, 'resolution_criteria');
  assert.ok(criteria.some((s) => s.label === 'known_fact'), texts(criteria));
  assert.ok(!criteria.some((s) => s.label === 'decision_required'), 'nothing is left for a person to decide about resolving it');
});

test('guidance not yet in effect is not given, and what the error reports say is a fact or a lead, never proof', () => {
  const d = diagnoseCase({
    ...udouSheet,
    guidance: [sop({ text: 'Future SOP.', effective_on: '2027-01-01' })],
    reports: [
      { report: 'Unliquidated obligations', latest_as_of: '2026-11-01', on_latest: true, listed_as_of: '2026-11-01', source_row: 7, status: 'Open', closed: false, amount_cents: 5000, age_days: 40 },
      { report: 'Open commitments', latest_as_of: '2026-11-01', on_latest: false, listed_as_of: '2026-10-15', source_row: 3, status: 'Open', closed: false, amount_cents: 5000, age_days: 20 },
    ],
  });
  assert.ok(!texts(all(d)).includes('Future SOP.'));
  assert.ok(section(d, 'issue_type').some((s) => s.label === 'known_fact' && s.text.startsWith('Listed on the Unliquidated obligations report as of 2026-11-01')));
  const verify = section(d, 'verification');
  assert.ok(verify.some((s) => s.label === 'derived_value' && s.text.startsWith('Still open on the latest Unliquidated obligations report')));
  const gone = verify.find((s) => s.text.startsWith('Not on the latest Open commitments report'))!;
  assert.equal(gone.label, 'derived_value');
  assert.match(String(gone.detail), /not proof it cleared/);
});

test('the same case, guidance and day give the same diagnosis; the summary, the preview reading and the AI brief are drawn from it', () => {
  const input: DiagnosisInput = { ...udouSheet, guidance: [sop(), policy()] };
  const a = diagnoseCase(input);
  const b = diagnoseCase(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(a, b, 'deterministic: no clock, no randomness, no AI');
  assert.deepEqual(summarize(a), { issue: 'UDOU', headline: a.headline, unknown: a.counts.unknown, decisions: a.counts.decision_required });
  assert.deepEqual(issueReading(input), { key: 'udou', short: 'UDOU', how: 'figures' });
  const brief = diagnosisForBrief(a);
  assert.equal(brief.engine, `${DIAGNOSIS_ENGINE.key} ${DIAGNOSIS_ENGINE.version}`);
  const statements = brief.sections.flatMap((s) => s.statements);
  assert.equal(statements.length, all(a).length, 'every statement goes to the brief');
  assert.ok(statements.every((s) => typeof s.label === 'string' && s.label.length > 0), 'with its label');
  assert.ok(statements.some((s) => /Official policy/.test(String(s.source))), 'and its source');
});
