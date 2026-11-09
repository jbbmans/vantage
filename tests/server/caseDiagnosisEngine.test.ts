import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIAGNOSIS_ENGINE, SECTIONS, STATEMENT_LABELS, diagnoseCase, diagnosisForBrief, issueReading, orderStatements, summarize,
  type CaseDiagnosis, type DiagnosisInput, type GuidanceEntry, type Statement,
} from '../../shared/caseDiagnosis.ts';
import { FORMULAS, PROCEDURES } from '../../shared/procedures.ts';
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

test('a procedure an import chose from the words alone stays a lead until a person confirms it, unless the case’s evidence names the same issue', () => {
  const words: DiagnosisInput = { item: item({ title: 'Outstanding travel order', reference: 'TO-9', filename: 'travel.csv', source_row: 2 }), events: [], procedure: null, today: '2026-11-02' };
  const lead = diagnoseCase(words);
  assert.equal(lead.issue.key, 'oto');
  assert.equal(lead.issue.how, 'words');

  // The import ran by u1 put it under the OTO procedure from the words alone: still a lead, nothing built on it.
  const picked = ev('procedure_applied', { procedure: 'oto_research', version: PROCEDURES.oto_research.version, authority: PROCEDURES.oto_research.authority, picked: 'words' });
  const d = diagnoseCase({ ...words, procedure: PROCEDURES.oto_research, events: [picked], people: { u1: 'Sgt Importer' } });
  assert.equal(d.issue.how, 'words', 'an import’s word pick is inference, not a procedure a person applied');
  assert.equal(d.issue.applied, true);
  assert.equal(d.issue.confirmed, false);
  assert.match(d.headline, /a lead, not confirmed/);
  assert.match(texts(section(d, 'issue_type')), /The case follows .* v/);
  const follows = section(d, 'issue_type').find((s) => s.text.startsWith('The case follows'))!;
  assert.match(follows.from || '', /Applied by the import Sgt Importer ran on 2026-11-01, from the words on the row alone/);
  assert.ok(section(d, 'issue_type').some((s) => s.label === 'decision_required' && s.text === 'Confirm the issue type.'));
  assert.ok(section(d, 'issue_type').some((s) => s.basis?.authority === 'vantage_inference'), 'the lead is labelled inference');
  assert.ok(section(d, 'probable_cause').every((s) => s.label !== 'recommendation'), 'no causes are offered on a lead');
  assert.equal(section(d, 'corrective_action').filter((s) => s.label === 'recommendation').length, 0, 'no corrective action is built on a lead');
  assert.ok(d.limits.some((l) => l.includes('until a person confirms it or applies the procedure that fits')));
  const issueGuidance = diagnoseCase({ ...words, procedure: PROCEDURES.oto_research, events: [picked], guidance: [sop({ issue: 'oto' })] });
  assert.ok(!all(issueGuidance).some((s) => s.basis?.guidance_id === 'g-sop'), 'guidance for the issue waits for confirmation');

  // A person confirms it: the diagnosis builds on the procedure, and says who confirmed it.
  const confirmed = diagnoseCase({ ...words, procedure: PROCEDURES.oto_research, events: [picked, ev('procedure_applied', { procedure: 'oto_research', version: PROCEDURES.oto_research.version, confirms: true }, 'u2')], people: { u1: 'Sgt Importer', u2: 'SSgt Lead' } });
  assert.equal(confirmed.issue.how, 'procedure');
  assert.equal(confirmed.issue.confirmed, true);
  assert.doesNotMatch(confirmed.headline, /a lead/);
  assert.match(section(confirmed, 'issue_type').find((s) => s.text.startsWith('The case follows'))!.from || '', /Confirmed by SSgt Lead/);
  assert.ok(!section(confirmed, 'issue_type').some((s) => s.text === 'Confirm the issue type.'));
  assert.ok(section(confirmed, 'probable_cause').some((s) => s.label === 'recommendation'), 'causes are offered once it is confirmed');

  // Figures that show the same condition confirm it without a person; figures or a pick by the plan are never a lead.
  const withFigures: DiagnosisInput = { ...udouSheet, procedure: PROCEDURES.udou_research, events: [ev('procedure_applied', { procedure: 'udou_research', version: PROCEDURES.udou_research.version, picked: 'words' })] };
  assert.equal(diagnoseCase(withFigures).issue.confirmed, true, 'the figures agree with the pick');
  assert.equal(diagnoseCase(withFigures).issue.how, 'procedure');
  for (const how of ['figures', 'plan']) {
    const other = diagnoseCase({ ...words, procedure: PROCEDURES.oto_research, events: [ev('procedure_applied', { procedure: 'oto_research', version: PROCEDURES.oto_research.version, picked: how })] });
    assert.equal(other.issue.confirmed, true, `a pick by the ${how} is not a lead`);
  }
});

test('a case marked resolved without a resolution in Vantage is not asked to be resolved, and its resolution is never shown as verified', () => {
  const closed: DiagnosisInput = { ...udouSheet, item: { ...udouSheet.item, stage: 'resolved' } };
  const d = diagnoseCase(closed);
  const resolution = section(d, 'resolution_criteria');
  assert.ok(!resolution.some((s) => s.text === 'Resolve the case.'), 'a closed case is not asked to be resolved again');
  const marked = resolution.find((s) => s.text === 'The case is marked resolved.')!;
  assert.equal(marked.label, 'known_fact');
  assert.match(marked.from || '', /Imported from balances\.csv, row 3, which marked it resolved/);
  assert.ok(resolution.some((s) => s.label === 'unknown' && s.text === 'Whether its resolution was verified.'));
  assert.ok(!resolution.some((s) => s.text === 'The case is resolved.'), 'only a recorded resolution reads as resolved');
  assert.ok(!all(d).some((s) => s.label === 'decision_required' && /^Apply a procedure/.test(s.text)), 'a closed case is not asked to take a procedure it cannot');
  // Closed by a stage change rather than the import: who closed it is the source.
  const moved = diagnoseCase({ ...closed, events: [ev('stage_changed', { from: 'researching', to: 'resolved' }, 'u2')], people: { u2: 'SSgt Lead' } });
  assert.match(section(moved, 'resolution_criteria').find((s) => s.text === 'The case is marked resolved.')!.from || '', /Recorded by SSgt Lead/);
  // An open case is still asked.
  assert.ok(section(diagnoseCase(udouSheet), 'resolution_criteria').some((s) => s.text === 'Resolve the case.'));
});

test('a calculation the decided cause rules out is neither worked out nor asked to be reviewed', () => {
  const umt = PROCEDURES.umt_four_stage;
  const base = [
    ev('procedure_applied', { procedure: umt.key, version: umt.version, authority: umt.authority }),
    ev('observation', { field: 'po_line_amount', amount_cents: 10000, step: 'research' }),
    ev('observation', { field: 'billed_amount', amount_cents: 10000, step: 'research' }),
  ];
  const input: DiagnosisInput = { item: item({ title: 'Unmatched transaction', reference: 'UMT-4' }), events: base, procedure: umt, today: '2026-11-02' };
  const undecided = section(diagnoseCase(input), 'calculations');
  assert.ok(undecided.some((s) => /Award shortfall/.test(s.text)), 'before a cause is decided the shortfall is shown');

  const approval = diagnoseCase({ ...input, events: [...base, ev('decision', { decision: 'umt_cause', choice: 'award_not_approved', step: 'cause' })] });
  const calc = section(approval, 'calculations');
  assert.ok(!calc.some((s) => /Award shortfall/.test(s.text)), 'an approval-only correction gets no shortfall');
  assert.ok(!all(approval).some((s) => s.text === 'Review the zero or downward result before anything changes.'), 'and no review of it');

  const billed = diagnoseCase({ ...input, events: [...base, ev('decision', { decision: 'umt_cause', choice: 'billed_exceeds_po_line', step: 'cause' })] });
  assert.ok(section(billed, 'calculations').some((s) => /Award shortfall/.test(s.text)), 'the cause that calls for it still gets it');

  // A shortfall recorded before the cause ruled it out stays on the record as a fact, without a call to calculate again.
  const recorded = ev('calculation', { formula: 'umt_award_shortfall', display: '$0.00', inputs: [], step: 'shortfall' });
  const later = diagnoseCase({ ...input, events: [...base, recorded, ev('observation', { field: 'billed_amount', amount_cents: 12000, step: 'research' }), ev('decision', { decision: 'umt_cause', choice: 'award_not_approved', step: 'cause' })] });
  const kept = section(later, 'calculations').find((s) => s.evidence?.includes(recorded.id))!;
  assert.equal(kept.label, 'known_fact');
  assert.match(kept.detail || '', /cause decided since skips this step/);
  assert.ok(!section(later, 'calculations').some((s) => s.text.startsWith('Calculate again')));
});

test('the funds check reads as Vantage enforces it: a warning goes ahead only with an acknowledgement, and one given at submission is a fact', () => {
  const p = PROCEDURES.umt_2way_po_qty;
  const applied = ev('procedure_applied', { procedure: p.key, version: p.version, authority: p.authority });
  const input: DiagnosisInput = { item: item({ title: '2-Way UMT', reference: 'UMT-2W' }), events: [applied], procedure: p, today: '2026-11-02' };
  const approvals = (events: ReturnType<typeof ev>[]) => section(diagnoseCase({ ...input, events: [applied, ...events] }), 'approvals');

  const none = approvals([]);
  assert.match(none.find((s) => s.text.startsWith('Record the funds check'))!.detail || '', /until a check is on the record/);
  const failed = approvals([ev('funds_check', { result: 'FAILED', system: 'DAI' })]);
  assert.match(failed.find((s) => s.text.startsWith('Record the funds check'))!.detail || '', /while the latest check is FAILED/);
  const passed = approvals([ev('funds_check', { result: 'PASSED', system: 'DAI' })]);
  assert.ok(!passed.some((s) => s.text.startsWith('Record the funds check')), 'a passed check asks for nothing more');

  const warning = ev('funds_check', { result: 'WARNING', system: 'DAI' });
  const pending = approvals([warning]);
  assert.ok(!pending.some((s) => /until a PASSED|refuses/.test(`${s.text} ${s.detail || ''}`) && s.label === 'recommendation'), 'a warning is not told it needs a PASSED check');
  const ask = pending.find((s) => s.text === 'Whether to submit against the funds check’s warning.')!;
  assert.equal(ask.label, 'decision_required');
  assert.match(ask.detail || '', /only with an acknowledgement/);

  const submitted = ev('action_submitted', { step: 'submit_modification', reference: 'P00001', funds_check_id: warning.id, funds_check_result: 'WARNING', control_acknowledgement: 'Warning concerned a closed line; confirmed with the budget officer.' });
  const done = approvals([warning, submitted]);
  assert.ok(!done.some((s) => s.text === 'Whether to submit against the funds check’s warning.'), 'an acknowledged warning is not asked again');
  const ack = done.find((s) => s.text.startsWith('The warning was acknowledged at submission'))!;
  assert.equal(ack.label, 'known_fact');
  assert.match(ack.text, /closed line/);
  assert.deepEqual(ack.evidence, [submitted.id]);
});

test('a correction to the imported error text replaces the sheet’s words, which are not read again', () => {
  const umt = PROCEDURES.umt_four_stage;
  const input: DiagnosisInput = {
    item: item({ title: 'Unmatched transaction', reference: 'UMT-9', filename: 'umt.csv', source_row: 4 }),
    sheet: [{ field: 'error_text', column: 'Error', value: 'No matching record' }],
    events: [ev('procedure_applied', { procedure: umt.key, version: umt.version, authority: umt.authority })], procedure: umt, today: '2026-11-02',
  };
  const fromSheet = diagnoseCase(input);
  assert.match(texts(section(fromSheet, 'issue_type')), /No matching record/i, 'the sheet’s error text is read while it stands');

  const corrected = diagnoseCase({ ...input, events: [...input.events, ev('observation', { field: 'error_text', value_text: 'PO line is closed; referred to support', step: 'identify' })] });
  assert.doesNotMatch(texts(section(corrected, 'issue_type')), /matches “No matching record/i, 'the corrected words replace the sheet’s');
  assert.ok(!all(corrected).some((s) => s.label === 'derived_value' && /No matching record/i.test(s.text)), 'nothing is derived from the superseded text');
});

test('a recorded zero or downward result still asks for review until a person makes the next call, unless the cause skips the step', () => {
  const p = PROCEDURES.umt_2way_po_qty;
  const base = [
    ev('procedure_applied', { procedure: p.key, version: p.version, authority: p.authority }),
    ev('observation', { field: 'current_award', amount_cents: 20000, step: 'record_award' }),
    ev('observation', { field: 'invoice_amount', amount_cents: 10000, reference: 'INV-1', step: 'record_invoices' }),
    ev('observation', { field: 'umt_amount', amount_cents: 10000, step: 'identify' }),
  ];
  const input: DiagnosisInput = { item: item({ title: '2-Way UMT', reference: 'UMT-2W' }), events: base, procedure: p, today: '2026-11-02' };
  const review = 'Review the zero or downward result before anything changes.';
  const live = diagnoseCase(input);
  assert.ok(all(live).some((s) => s.text === review), 'the live $0 adjustment asks for review');

  const result = FORMULAS.umt2way_award_adjustment.compute(base);
  assert.ok(result.ok && result.requires_review);
  const recorded = ev('calculation', { ...result, formula: 'umt2way_award_adjustment', step: 'calculate' });
  const after = diagnoseCase({ ...input, events: [...base, recorded] });
  const ask = all(after).find((s) => s.text === review)!;
  assert.ok(ask, 'recording the result does not clear the review');
  assert.equal(ask.label, 'decision_required');
  assert.deepEqual(ask.evidence, [recorded.id]);
  assert.equal(after.counts.decision_required, live.counts.decision_required, 'and the pending-decision count does not drop');

  const decided = diagnoseCase({ ...input, events: [...base, recorded, ev('decision', { decision: 'funding_decision', choice: 'funding_sufficient', step: 'funding_decision' })] });
  assert.ok(!all(decided).some((s) => s.text === review), 'the next call, made after it, is the review');
  const referred = diagnoseCase({ ...input, events: [...base, recorded, ev('decision', { decision: 'funding_decision', choice: 'refer_for_review', step: 'funding_decision' })] });
  assert.ok(all(referred).some((s) => s.text === review), 'referring it on is not reviewing it');
  const closed = diagnoseCase({ ...input, item: { ...input.item, stage: 'resolved' }, events: [...base, recorded] });
  assert.ok(!all(closed).some((s) => s.text === review), 'a closed case is not asked');
});

test('error text the import brought in is on the case, not missing, until someone records the field', () => {
  const input: DiagnosisInput = {
    item: item({ title: 'Unmatched transaction', reference: 'UMT-11', filename: 'umt.csv', source_row: 6 }),
    sheet: [{ field: 'error_text', column: 'Error', value: 'No matching record' }],
    events: [], procedure: null, today: '2026-11-02',
  };
  const d = diagnoseCase(input);
  assert.equal(d.issue.how, 'error_label', 'the diagnosis reads the issue from the mapped error text');
  assert.ok(!section(d, 'missing_information').some((s) => /^Exact error description from the report/.test(s.text)), 'so it does not ask for that text again');

  const dash = diagnoseCase({ ...input, sheet: [{ field: 'error_text', column: 'Error', value: '—' }], item: { ...input.item, title: 'Unmatched transaction: no matching record' } });
  assert.ok(section(dash, 'missing_information').some((s) => /^Exact error description from the report: not recorded/.test(s.text)), 'a dash is not the error text');
});
