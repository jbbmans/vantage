import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEntry, clauseOf, type AreaNames } from '../../shared/writer/facts.ts';
import { sentenceFor, statesAmount, dollars, finish, pick } from '../../shared/writer/realize.ts';
import { writeNarrative, type WriterOptions } from '../../shared/writer/compose.ts';
import { reviewText } from '../../shared/writer/review.ts';

const M = 'MOS / Mission Accomplishment';
const names: AreaNames = { mission: M, leadership: 'Leadership', character: 'Individual Character', intellect: 'Individual Character' };
const areas = ['Individual Character', M, 'Leadership'];
const labels = { 'Individual Character': 'CHARACTER', [M]: 'MISSION', Leadership: 'LEADERSHIP' };
const opts = (over: Partial<WriterOptions> = {}): WriterOptions => ({ areas, labels, names, limit: 1000, ...over });
const read = (title: string, more: Record<string, unknown> = {}) => readEntry({ id: 'x', title, ...more }, { names, areas });

test('the reader puts a title in the past tense, drops the first person and filler, and says what it changed', () => {
  assert.equal(clauseOf(read('Reconciling 30 UMTs in DAI')), 'Reconciled 30 UMTs in DAI');
  assert.equal(clauseOf(read('Trains junior marines on SABRS')), 'Trained junior Marines on SABRS');
  assert.equal(clauseOf(read('Process 40 MIPRs for G-8')), 'Processed 40 MIPRs for G-8');
  assert.equal(clauseOf(read('14 ULOs reconciled in DAI')), 'Reconciled 14 ULOs in DAI');
  const mine = read("I successfully reconciled my section's ULOs");
  assert.equal(clauseOf(mine), "Reconciled the section's ULOs");
  assert.deepEqual(mine.edits, ['first person', 'filler']);
});

test('the reader leaves a noun phrase a noun phrase, and never invents a claim', () => {
  // No verb is added where none was written: "Completed…" would claim something finished that may not be.
  assert.equal(clauseOf(read('Process improvement for DTS')), 'Process improvement for DTS');
  assert.equal(clauseOf(read('Food pantry shift')), 'Food pantry shift');
  // A past tense the lexicon does not list is still the verb.
  assert.equal(clauseOf(read('Licensed 8 Marines on the JLTV')), 'Licensed 8 Marines on the JLTV');
  assert.equal(clauseOf(read('Drove in the convoy to Camp Pendleton')), 'Drove in the convoy to Camp Pendleton');
  assert.equal(clauseOf(read('Earned my associates degree')), 'Earned associates degree');
  assert.equal(clauseOf(read('Brief to the CO on Q4 execution')), 'Delivered brief to the CO on Q4 execution');
  assert.equal(clauseOf(read('Review of FY26 obligations')), 'Conducted review of FY26 obligations');
  assert.equal(clauseOf(read('Training on DTS for the section')), 'Conducted training on DTS for the section');
  // A weak opener is kept as written: changing "helped" to a stronger verb would change the claim.
  assert.equal(clauseOf(read('Was responsible for processing several MIPRs')), 'Was responsible for processing several MIPRs');
  assert.equal(clauseOf(read('Helped the section clear UMTs')), 'Helped the section clear UMTs');
});

test('the reader notes what a reviewer would ask for', () => {
  const codes = (t: string, more = {}) => read(t, more).issues.map((i) => i.code);
  assert.ok(codes('Helped the section with close out').includes('weak_verb'));
  assert.ok(codes('Reviewed several invoices').includes('vague'));
  assert.ok(!codes('Reviewed several invoices', { quantity: 12, unit_label: 'invoices' }).includes('vague'));
  assert.ok(codes('The ledger was reconciled by the section').includes('passive'));
  assert.ok(codes('Food pantry shift').includes('no_verb'));
  assert.ok(codes('Reconciled ULOs').includes('outcome'));
  assert.ok(!codes('Reconciled ULOs', { result: 'all cleared' }).includes('outcome'));
  assert.ok(codes('Reconciled ULOs').includes('unmeasured'));
});

test('an entry with no area is placed by what it says, and says it was', () => {
  const lead = read('Trained 3 junior Marines on DAI', { quantity: 3, unit_label: 'Marines' });
  assert.equal(lead.area, 'Leadership');
  assert.equal(lead.areaInferred, true);
  assert.equal(lead.people, 3);
  assert.equal(read('Volunteered at the food pantry', { category: 'Volunteer Service' }).area, 'Individual Character');
  assert.equal(read('Reconciled 14 ULOs').area, M);
  // A tagged entry stays where it was tagged.
  assert.equal(read('Trained 3 Marines', { eval_area: M }).area, M);
});

test('money is written once, next to its count, the way an evaluation writes it', () => {
  assert.equal(dollars(48250, 'full'), '$48,250');
  assert.equal(dollars(6206.4, 'full'), '$6,206');
  assert.equal(dollars(118.38, 'full'), '$118.38');
  assert.equal(dollars(1_200_000, 'full'), '$1.2M');
  assert.equal(dollars(48250, 'compact'), '$48.3K');
  assert.ok(statesAmount('Deobligated $1.2 million in expired funds', 1_200_000));
  assert.ok(statesAmount('Reconciled 14 ULOs totaling $48,250', 48250));
  assert.ok(!statesAmount('Reviewed a $500 invoice batch', 12000));

  const ulo = read('Reconciled 14 ULOs in DAI', { quantity: 14, unit_label: 'ULOs', dollar_amount: 48250, dollar_type: 'reconciled', result: 'all cleared on the next report' });
  assert.match(sentenceFor(ulo, 'full', 0), /^Reconciled 14 ULOs (worth|totaling|valued at) \$48,250 in DAI; all cleared on the next report\.$/);
  const umt = read('Cleared 4 2-Way UMTs on the Q4 report', { quantity: 4, unit_label: 'UMTs', dollar_amount: 6206.4, dollar_type: 'reconciled' });
  assert.match(sentenceFor(umt, 'full', 0), /^Cleared 4 2-Way UMTs (worth|totaling|valued at) \$6,206 on the Q4 report\.$/);
  const stated = read('Reconciled 14 ULOs totaling $48,250', { quantity: 14, unit_label: 'ULOs', dollar_amount: 48250 });
  assert.equal(sentenceFor(stated, 'full', 0).match(/48,250/g)?.length, 1);
  const reviewed = read('Reviewed 12 invoices', { quantity: 12, unit_label: 'invoices', dollar_amount: 2875, dollar_type: 'reviewed' });
  assert.match(sentenceFor(reviewed, 'full', 0), /covering \$2,875/);
});

test('a sentence comes out finished: plain characters, one space, punctuation where it belongs', () => {
  assert.equal(finish('reconciled 14 ULOs ;all cleared “on time” — early'), 'Reconciled 14 ULOs; all cleared "on time" - early.');
  assert.equal(finish('Reconciled $1,118.38 at 14:30'), 'Reconciled $1,118.38 at 14:30.');
  assert.equal(pick(['a', 'b', 'c'], 1, 'k'), pick(['a', 'b', 'c'], 1, 'k'));
});

const corpus = [
  { id: 'a1', title: 'Cleared 4 2-Way UMTs on the Q4 report', quantity: 4, unit_label: 'UMTs', dollar_amount: 6206.4, dollar_type: 'reconciled', result: 'Each verified cleared on the next report', eval_area: M, date: '2026-09-28' },
  { id: 'a2', title: 'Reconciled 14 ULOs totaling $48,250 in DAI', quantity: 14, unit_label: 'ULOs', dollar_amount: 48250, dollar_type: 'reconciled', result: 'all cleared on the next report', system: 'DAI', eval_area: M, date: '2026-09-30' },
  { id: 'a3', title: 'Reconciled 9 ULOs in SABRS', quantity: 9, unit_label: 'ULOs', dollar_amount: 12100, dollar_type: 'reconciled', eval_area: M, date: '2026-08-12' },
  { id: 'a4', title: 'I processed 40 MIPRs for the G-8', quantity: 40, unit_label: 'MIPRs', dollar_amount: 1200000, dollar_type: 'obligated', result: 'zero returned for correction', date: '2026-07-20' },
  { id: 'a5', title: 'Volunteered at the base food pantry', quantity: 6, unit_label: 'hours', result: 'Sorted and shelved the weekly delivery', eval_area: 'Individual Character', date: '2026-09-25' },
  { id: 'a6', title: 'Led section PT: 10 km hike', quantity: 10, unit_label: 'km', result: 'Planned the route and the water points for eight Marines', eval_area: 'Leadership', date: '2026-09-11' },
  { id: 'a7', title: 'Training 3 junior marines on DAI requisitions', quantity: 3, unit_label: 'Marines', result: 'all three now process requisitions without review', date: '2026-08-30', category: 'Leadership' },
  { id: 'a8', title: 'Reconciled 22 ULOs in DAI', quantity: 22, unit_label: 'ULOs', dollar_amount: 30400, dollar_type: 'reconciled', eval_area: M, date: '2026-07-02' },
  { id: 'a9', title: 'Helped the section with the end of year close out', date: '2026-09-29' },
  { id: 'a10', title: 'Built a UMT tracker in Excel', result: 'cut the weekly review from 3 hours to 1 hour', date: '2026-08-05' },
];

test('the narrative covers every area before any gets a second sentence, and stays inside the limit', () => {
  for (const limit of [300, 500, 1000, 2000]) {
    const n = writeNarrative(corpus, opts({ limit }));
    assert.ok(n.fits && n.length <= limit, `${limit}: ${n.length}`);
    assert.equal(n.text.length, n.length);
    for (const label of ['CHARACTER:', 'MISSION:', 'LEADERSHIP:']) if (limit >= 500) assert.ok(n.text.includes(label), `${limit} lacks ${label}`);
    assert.ok(!/\bI\b|\bmy\b/i.test(n.text), 'no first person');
    assert.ok(!/\s{2}|\.\.|;\s*\./.test(n.text), n.text);
    // Every sentence names the entries it came from, and every entry is either written, totalled or offered back.
    for (const s of n.sentences) assert.ok(s.kind === 'summary' || s.sources.length, s.text);
    const accounted = new Set([...n.sentences.flatMap((s) => s.covers), ...n.left.flatMap((s) => s.covers)]);
    for (const e of corpus) assert.ok(accounted.has(e.id), `${e.id} lost at ${limit}`);
  }
});

test('the same work is totalled when it would not all fit, and the outcome it keeps is one that was stated', () => {
  const n = writeNarrative(corpus, opts({ limit: 1000 }));
  const total = n.sentences.find((s) => s.kind === 'group');
  assert.ok(total, n.text);
  assert.match(total!.text, /^Reconciled 45 ULOs (worth|totaling|valued at) \$90,750 across 3 actions, including 14 in DAI: all cleared on the next report\.$/);
  assert.deepEqual([...total!.sources].sort(), ['a2', 'a3', 'a8']);
});

test('case work from the histories is credited in the mission area', () => {
  const n = writeNarrative(corpus, opts({ casework: { researched: 39, verified: 66, resolved: 33, procedures: ['2-Way UMT', 'OCMT'] } }));
  const credit = n.sentences.find((s) => s.kind === 'casework');
  assert.equal(credit?.text, 'Researched 39 documents (2-Way UMT, OCMT); recorded 66 verified outcomes and resolved 33 cases.');
  assert.equal(credit?.area, M);
});

test('a pinned sentence is kept and an excluded one is not, and another seed rewords without changing a fact', () => {
  const base = writeNarrative(corpus, opts({ limit: 400 }));
  const left = base.left[0];
  assert.ok(left);
  const pinned = writeNarrative(corpus, opts({ limit: 400, pin: [left.key] }));
  assert.ok(pinned.sentences.some((s) => s.key === left.key && s.pinned));
  const first = base.sentences.find((s) => s.kind === 'entry')!;
  const without = writeNarrative(corpus, opts({ limit: 400, exclude: [first.key] }));
  assert.ok(!without.sentences.some((s) => s.covers.includes(first.key)));
  const figures = (t: string) => (t.match(/\$?[\d,.]+[KMB]?/g) || []).sort();
  const a = writeNarrative(corpus, opts({ seed: 1 }));
  const b = writeNarrative(corpus, opts({ seed: 2 }));
  assert.deepEqual(figures(a.text), figures(b.text));
  assert.deepEqual(writeNarrative(corpus, opts({ seed: 1 })).text, a.text, 'the same seed writes the same text');
});

test('the review grades the writing and names the entries that would fix it', () => {
  const n = writeNarrative(corpus, opts());
  assert.ok(n.review.score > 0 && n.review.score <= 100);
  assert.equal(n.review.parts.reduce((t, p) => t + p.of, 0), 100);
  const outcome = n.review.findings.find((f) => f.id.startsWith('outcome:'));
  assert.ok(outcome?.sources?.length, 'a missing outcome points at its entry');
  assert.ok(n.review.findings.some((f) => f.id.startsWith('weak_verb:') && f.sources?.includes('a9')));
  const thin = writeNarrative([{ id: 'z', title: 'Reconciled 4 ULOs', quantity: 4, unit_label: 'ULOs', eval_area: M }], opts());
  assert.ok(thin.review.findings.some((f) => f.id === 'empty:Leadership' && f.action?.kind === 'log'));
  assert.ok(thin.review.score < n.review.score);
  assert.equal(writeNarrative([], opts()).review.grade, 'Empty');
});

test('text edited by hand is reviewed from its words', () => {
  const r = reviewText('MISSION: I helped reconcile several ULOs. The ledger was reconciled on time.', 1000);
  const ids = r.findings.map((f) => f.id);
  assert.ok(ids.includes('first') && ids.includes('vague') && ids.includes('passive'));
  assert.ok(reviewText('x'.repeat(1100), 1000).findings.some((f) => f.id === 'over'));
});

test('whatever is logged, the narrative is well-formed text inside its limit', () => {
  let state = 7;
  const rand = () => { state = (state * 1103515245 + 12345) % 2 ** 31; return state / 2 ** 31; };
  const words = ['reconciled', 'Processing', 'I', 'my', 'several', 'ULOs', 'Marines', '$4,000', '14', 'in', 'DAI', 'the', 'was', 'helped', 'brief', 'of', '—', '“quoted”', 'km', '', '  ', ';', 'résumé'];
  const units = ['ULOs', 'Marines', 'hours', 'km', '%', '', 'points', 'MIPRs'];
  for (let run = 0; run < 150; run += 1) {
    const entries = Array.from({ length: Math.floor(rand() * 25) }, (_, i) => ({
      id: `e${i}`,
      title: Array.from({ length: Math.floor(rand() * 12) }, () => words[Math.floor(rand() * words.length)]).join(' '),
      quantity: rand() < 0.6 ? Math.floor(rand() * 500) : null,
      unit_label: units[Math.floor(rand() * units.length)],
      dollar_amount: rand() < 0.4 ? Math.round(rand() * 2e6 * 100) / 100 : null,
      dollar_type: rand() < 0.5 ? 'reconciled' : 'reviewed',
      result: rand() < 0.5 ? 'which resulted in zero errors' : null,
      eval_area: [M, 'Leadership', 'Individual Character', null, 'Unassigned'][Math.floor(rand() * 5)],
    }));
    const limit = [200, 500, 1000][run % 3];
    const n = writeNarrative(entries, opts({ limit, seed: run }));
    assert.ok(n.length <= limit, `run ${run}: ${n.length} > ${limit}`);
    assert.ok(!/undefined|null|NaN|\[object/.test(n.text), n.text);
    assert.ok(!/\s{2}/.test(n.text), n.text);
    assert.ok(/^[\x20-\x7e]*$/.test(n.text.replace(/é/g, 'e')), `plain characters: ${n.text}`);
    for (const s of n.sentences) assert.match(s.text, /[.!?]$/);
  }
});

test('bullets follow MCO 1616.1 Appendix E: a heading per command input line, a dash, a verb, the result', async () => {
  const { narrativeConfig } = await import('../../shared/evaluation.ts');
  const cfg = narrativeConfig('jepes');
  const n = writeNarrative(corpus, { ...cfg, format: 'bullets', spellOut: false });
  const lines = n.text.split('\n');
  assert.deepEqual(lines.filter((l) => !l.startsWith('-')), ['Individual Character', 'MOS and/or Mission Accomplishment', 'Leadership']);
  for (const l of lines.filter((x) => x.startsWith('-'))) assert.match(l, /^-[A-Z][a-z]+ .*\.$/, l);
  assert.ok(n.length <= cfg.limit);
  // A measured outcome reads as the order's examples do: "…, resulting in 100% mission readiness."
  const m = writeNarrative([{ id: 'r', title: 'Performed corrective maintenance on 75 aircraft', quantity: 75, unit_label: 'aircraft', result: '100% mission readiness', eval_area: M }], { ...cfg, format: 'bullets' });
  assert.match(m.text, /-Performed corrective maintenance on 75 aircraft, resulting in 100% mission readiness\./);
});

test('acronyms are spelled out once, where they first appear outside parentheses', async () => {
  const { spellOut } = await import('../../shared/writer/realize.ts');
  assert.deepEqual(spellOut(['Researched 3 documents (2-Way UMT).', 'Reconciled 14 ULOs in DAI.', 'Cleared 4 UMTs and 2 ULOs.']), [
    'Researched 3 documents (2-Way UMT).',
    'Reconciled 14 unliquidated obligations (ULOs) in Defense Agencies Initiative (DAI).',
    'Cleared 4 unmatched transactions (UMTs) and 2 ULOs.',
  ]);
  // Spelling out costs characters, and the plan pays for them inside the limit.
  const n = writeNarrative(corpus, opts({ limit: 600, spellOut: true }));
  assert.ok(n.length <= 600 && /unliquidated obligations \(ULOs\)/.test(n.text), n.text);
  const off = writeNarrative(corpus, opts({ spellOut: false }));
  assert.ok(off.review.findings.some((f) => f.id === 'acronyms' && f.cite === 'MCO 1616.1, App. E'));
});

test('required annual training is held back with the rule, and can still be kept', () => {
  const entries = [...corpus, { id: 'cyber', title: 'Completed annual Cyber Awareness training', eval_area: 'Individual Character' }];
  const n = writeNarrative(entries, opts());
  assert.ok(!/Cyber Awareness/.test(n.text));
  assert.equal(n.held[0]?.key, 'cyber');
  assert.match(n.held[0].reason, /MCO 1616\.1, Appendix E/);
  assert.ok(n.review.findings.some((f) => f.id === 'held:cyber' && f.basis === 'order'));
  const kept = writeNarrative(entries, opts({ pin: ['cyber'] }));
  assert.match(kept.text, /Cyber Awareness/);
  assert.equal(kept.held.length, 0);
});

test('ratings, clichés, predictions and the reporting senior’s judgments are flagged, with what each rests on', () => {
  const entries = [
    { id: 's', title: 'Outstanding work reconciling 12 ULOs', quantity: 12, unit_label: 'ULOs', result: 'which will save hours next year', eval_area: M },
    { id: 'c', title: 'Served as a team player on the FY close', eval_area: M },
    { id: 'j', title: 'Ranked #1 of 12 LCpls in the section', eval_area: M },
    { id: 'h', title: 'Helped the section clear UMTs', eval_area: M },
  ];
  const fitrep = writeNarrative(entries, opts({ track: 'fitrep' }));
  const f = (id: string) => fitrep.review.findings.find((x) => x.id === id);
  assert.equal(f('superlative:s')?.basis, 'order');
  assert.equal(f('speculative:s')?.cite, 'FITREP Section C');
  assert.equal(f('cliche:c')?.cite, 'Marine Corps Gazette');
  assert.ok(f('rs_judgment:j'));
  // "Helped" is a preference, and says so.
  assert.equal(f('weak_verb:h')?.basis, 'style');
  assert.match(f('weak_verb:h')!.detail!, /not a rule/);
  // Praise adverbs go like other filler; the claim stays.
  assert.equal(clauseOf(read('Meticulously reconciled 14 ULOs')), 'Reconciled 14 ULOs');
  const typed = reviewText('Promote ahead of peers. Outstanding Marine and a valued asset.', 1000);
  assert.ok(['judgment', 'superlative', 'cliche'].every((id) => typed.findings.some((x) => x.id === id)));
});

test('FITREP input is drafted for Section C: by section, at 1,232 characters', async () => {
  const { narrativeConfig } = await import('../../shared/evaluation.ts');
  const cfg = narrativeConfig('fitrep');
  assert.equal(cfg.limit, 1232);
  const n = writeNarrative(corpus.map((e) => ({ ...e, eval_area: e.eval_area === M ? 'Mission Accomplishment' : e.eval_area })), { ...cfg, format: 'bullets' });
  assert.ok(n.length <= 1232);
  assert.ok(n.text.startsWith('Mission Accomplishment\n-'), n.text.slice(0, 60));
});

test('what real entries throw at it: work in progress, a first person it cannot remove, an outcome that repeats the title', () => {
  const entries = [
    { id: 'wip', title: 'working on getting my license for the 7 ton', eval_area: M },
    { id: 'me', title: 'Outstanding performance during the field op', result: 'my squad leader said I was a valued asset', eval_area: M },
    { id: 'cert', title: 'Hazmat certification', result: 'certified', eval_area: M },
    { id: 'gpa', title: 'Earned my associates degree in business', result: '3.8 GPA', eval_area: 'Individual Character' },
    { id: 'pfc', title: 'Trained the new PFC on unit diary entries', quantity: 1, unit_label: 'Marines', eval_area: 'Leadership' },
    { id: 'keys', title: 'Responsible for the armory keys', eval_area: 'Individual Character' },
    { id: 'phase', title: 'Completed Corporals Course Phase I', result: 'graduated in the top third', eval_area: 'Individual Character' },
  ];
  const n = writeNarrative(entries, opts({ format: 'bullets' }));
  const held = Object.fromEntries(n.held.map((h) => [h.key, h]));
  assert.match(held.wip.reason, /in progress/);
  assert.equal(held.wip.basis, 'style');
  assert.match(held.me.reason, /“I”/);
  assert.ok(!held.phase, '"Phase I" is not a first person');
  assert.ok(!/Completed (?:working|outstanding|hazmat)/i.test(n.text), 'no verb is invented');
  assert.match(n.text, /-Earned associates degree in business, with a 3\.8 GPA\./);
  assert.match(n.text, /-Trained the new PFC on unit diary entries\./);
  assert.ok(!/certified\./.test(n.text), 'an outcome that only repeats the title is dropped');
  assert.ok(!/armory keys/.test(n.text), 'a billet statement does not fill a line on its own');
  assert.match(n.text, /-Completed Corporals Course Phase I; graduated in the top third\./);
});

test('typing as it comes: capitals, a second sentence, symbols, number words, the same entry twice, an old award', async () => {
  const { tidy } = await import('../../shared/writer/facts.ts');
  assert.equal(tidy('RECONCILED 40 ULOS IN DAI').text, 'Reconciled 40 ULOs in DAI');
  assert.equal(tidy('Built the tracker. Also trained the section on it.').text, 'Built the tracker; also trained the section on it.');
  assert.equal(tidy('Deobligated $2.5M in expired funds!!! 🚚').text, 'Deobligated $2.5M in expired funds');
  assert.equal(tidy('processed twelve MIPRs for the G-8', { numerals: true }).text, 'processed 12 MIPRs for the G-8');
  assert.equal(tidy('zero rejects', { numerals: true }).text, 'zero rejects');
  const entries = [
    { id: 'caps', title: 'RECONCILED 40 ULOS IN DAI', quantity: 40, unit_label: 'ULOS', result: 'ALL CLEARED', eval_area: M, date: '2026-09-01' },
    { id: 'same', title: 'Reconciled 40 ULOs in DAI', quantity: 40, unit_label: 'ULOs', result: 'all cleared', eval_area: M, date: '2026-09-01' },
    { id: 'award', title: "Received a Certificate of Commendation for actions during last year's deployment", eval_area: 'Individual Character' },
    { id: 'bare', title: 'Mentored', quantity: 2, unit_label: 'Marines', eval_area: 'Leadership' },
    { id: 'cents', title: 'Corrected 150.25 in misposted charges', dollar_amount: 150.25, dollar_type: 'reconciled', eval_area: M },
  ];
  const n = writeNarrative(entries, opts({ format: 'bullets' }));
  assert.match(n.text, /-Reconciled 40 ULOs in DAI; all cleared\./);
  assert.ok(!/80 ULOs|across 2 actions/.test(n.text), 'a duplicate is not counted twice');
  assert.match(n.held.find((h) => h.key === 'same')!.reason, /logged twice/);
  assert.match(n.held.find((h) => h.key === 'award')!.reason, /previous reporting period/);
  assert.match(n.text, /-Mentored 2 Marines\./);
  assert.equal(n.text.match(/150\.25/g)?.length, 1, 'an amount typed bare is not written again');
  assert.ok(/^[\x20-\x7e\n]*$/.test(n.text));
});

test('an entry is coached while it is typed with the reviewer’s own notes, most useful first', async () => {
  const { coachEntry } = await import('../../shared/writer/coach.ts');
  const weak = coachEntry({ title: 'I helped the section with several ULOs' });
  assert.equal(weak.bullet, 'Helped the section with several ULOs.');
  assert.deepEqual(weak.notes.map((n) => n.code), ['outcome', 'vague', 'weak_verb']);
  const annual = coachEntry({ title: 'Completed annual SAPR training' });
  assert.match(annual.held!, /Appendix E/);
  const strong = coachEntry({ title: 'Reconciled 14 ULOs in DAI', quantity: 14, unit_label: 'ULOs', result: 'all cleared on the next report', eval_area: M });
  assert.deepEqual(strong.notes, []);
});
