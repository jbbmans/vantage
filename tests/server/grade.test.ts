import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeNarrative } from '../../shared/narrative.ts';
import { GRADE_BANDS, GRADE_NOTE, GRADE_PARTS, gradeFor, type PartKey, type ReviewPart } from '../../shared/writer/grade.ts';
import { readingOf, readTyped, reviewEdit, splitOutcome, type Review } from '../../shared/writer/review.ts';
import { piecesOf } from '../../shared/writer/edited.ts';
import { readEntry, type EntryInput } from '../../shared/writer/facts.ts';
import { strengthOf } from '../../shared/writer/strength.ts';
import { areaAmong, narrativeConfig, TRACKS } from '../../shared/evaluation.ts';
import { GRADE_EXAMPLES } from './gradeExamples.ts';
import { BULLET_EXAMPLES, EDGE_CASES } from './bulletExamples.ts';
import { DEMO_ENTRIES, WRITER_CORPUS } from './writerCorpus.ts';

type Track = 'jepes' | 'fitrep';
const M_AREA = 'MOS / Mission Accomplishment';
const write = (entries: EntryInput[], track: Track, limit?: number, format: 'bullets' | 'paragraph' = 'bullets') => {
  const cfg = narrativeConfig(track);
  return composeNarrative(entries.map((e) => ({ ...e, eval_area: areaAmong(e.eval_area ?? null, cfg.areas) })) as never, { ...cfg, limit: limit ?? cfg.limit, format, spellOut: false });
};
const earned = (r: Review) => Object.fromEntries(r.parts.map((p) => [p.key, p.earned])) as Record<PartKey, number>;
// What a part says, less what it asks for: an edit asks in the edit's words.
const said = (parts: ReviewPart[]) => parts.map(({ raise: _raise, ...p }) => p);

// The field each part reads, as the activity form labels it. An edit with typed sentences counts them apart.
const FIELD: Record<Exclude<PartKey, 'fit'>, (track: Track) => string> = {
  coverage: (track) => `Each entry's ${TRACKS[track].areaLabel}`,
  outcomes: () => 'Result',
  measured: () => 'Action amount, Transaction value, or a number in Title or Result',
  verbs: () => 'The first word of Title',
};
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function namesItsField(p: ReviewPart, track: Track, limit: number) {
  if (p.key === 'fit') return p.from === `The text against the ${limit.toLocaleString('en-US')}-character limit`;
  const field = FIELD[p.key](track);
  return p.from === field || p.from === 'Your edited text' || new RegExp(`^${escape(field)} \\(\\d+\\) and your edited text \\(\\d+\\)$`).test(p.from);
}
function checkParts(r: Review, track: Track, limit: number, where: string) {
  assert.deepEqual(r.parts.map((p) => [p.key, p.of]), GRADE_PARTS.map((p) => [p.key, p.of]), where);
  assert.equal(r.score, r.parts.reduce((t, p) => t + p.earned, 0), `${where}: the parts add up to the grade`);
  for (const p of r.parts) {
    assert.ok(namesItsField(p, track, limit), `${where}: ${p.label} names the field it read, not “${p.from}”`);
    assert.ok(p.note, `${where}: ${p.label} says why`);
    // Short of full, it says what would raise it and by how much; at full, nothing.
    if (p.earned < p.of && (p.key !== 'fit' || !/^0 of/.test(p.note))) assert.deepEqual(p.raise?.points, p.of - p.earned, `${where}: ${p.label} says what would raise it`);
    if (p.earned === p.of) assert.equal(p.raise, null, `${where}: ${p.label} is full`);
  }
}

test('the fixed examples grade as worked out by hand, written and edited', () => {
  for (const ex of GRADE_EXAMPLES) {
    const n = write(ex.entries, ex.track, ex.limit);
    const where = `${ex.name}: ${ex.why}`;
    assert.deepEqual({ score: n.review.score, grade: n.review.grade, parts: earned(n.review) }, { score: ex.score, grade: ex.grade, parts: ex.parts }, `${where}\n${n.text}`);
    checkParts(n.review, ex.track, ex.limit, ex.name);
    for (const e of ex.edits ?? []) {
      const r = reviewEdit(e.edit(n.text), n, narrativeConfig(ex.track));
      assert.deepEqual({ score: r.score, grade: r.grade, parts: earned(r) }, { score: e.score, grade: e.grade, parts: e.parts }, `${ex.name}, ${e.name}: ${e.why}`);
      checkParts(r, ex.track, ex.limit, `${ex.name}, ${e.name}`);
    }
  }
});

test('pressing Edit text changes nothing: every track, form and record grades the same, part by part', () => {
  const sets: Array<[string, EntryInput[]]> = [['demo', DEMO_ENTRIES], ['corpus', WRITER_CORPUS], ...GRADE_EXAMPLES.map((e): [string, EntryInput[]] => [e.name, e.entries])];
  for (const track of ['jepes', 'fitrep'] as const) {
    for (const [name, entries] of sets) {
      for (const format of ['bullets', 'paragraph'] as const) {
        const n = write(entries, track, undefined, format);
        const r = reviewEdit(n.text, n, narrativeConfig(track));
        const where = `${track} ${name} ${format}`;
        assert.equal(r.score, n.review.score, where);
        assert.equal(r.grade, n.review.grade, where);
        assert.deepEqual(said(r.parts), said(n.review.parts), where);
      }
    }
  }
});

test('a sentence read from its words reads as its entry does, on every fixed bullet', () => {
  for (const track of ['jepes', 'fitrep'] as const) {
    const cfg = narrativeConfig(track);
    const cases = [
      ...BULLET_EXAMPLES.map((b) => ({ entry: b.entry, text: b[track] })),
      ...EDGE_CASES.flatMap((e) => (track === 'jepes' ? [{ entry: e.entry, text: e.jepes }] : e.fitrep ? [{ entry: e.entry, text: e.fitrep }] : [])),
    ];
    assert.ok(cases.length >= BULLET_EXAMPLES.length);
    for (const { entry, text } of cases) {
      const fact = readEntry({ ...entry, eval_area: areaAmong(entry.eval_area ?? null, cfg.areas) ?? cfg.fallbackArea }, { names: cfg.names, areas: cfg.areas, track });
      const met = new Set(strengthOf(fact).met);
      const { reading } = readTyped(text, fact.area, cfg);
      assert.deepEqual({ opens: reading.opens, number: reading.number, outcome: reading.outcome }, { opens: met.has('opens'), number: met.has('number'), outcome: met.has('outcome') }, `${track}: ${text}`);
    }
  }
});

test('every sentence the writer writes reads the same from its words as from its entries', () => {
  for (const track of ['jepes', 'fitrep'] as const) {
    for (const entries of [DEMO_ENTRIES, WRITER_CORPUS]) {
      const n = write(entries, track);
      const facts = new Map(n.facts.map((f) => [f.key, f]));
      for (const s of n.sentences.filter((x) => x.kind !== 'summary')) {
        const a = readingOf(s, facts);
        const b = readTyped(s.text, s.area, narrativeConfig(track)).reading;
        assert.deepEqual([b.opens, b.number, b.outcome], [a.opens, a.number, a.outcome], `${track} ${s.kind}: ${s.text}`);
      }
    }
  }
});

test('an outcome is found by the joins the writer uses and a Marine types', () => {
  const cases: Array<[string, string]> = [
    ['Reconciled 14 ULOs totaling $48,250 in DAI; all cleared on the next report.', 'all cleared on the next report'],
    ['Inspected 40 vehicles, resulting in 100% mission readiness.', '100% mission readiness'],
    ['Rebuilt the PCS tracker, cutting late returns from 12 to 2.', 'cutting late returns from 12 to 2'],
    ['Completed the Corporals Course DEP, with a 92 average.', 'a 92 average'],
    ['Deobligated 3 MIPRs, saving $18,250 and returning funds to the G-8.', 'returning funds to the G-8'],
    ['Reconciled 24 ULOs, including 14 in DAI: all cleared on the next report.', 'all cleared on the next report'],
    ['Inspected 40 vehicles resulting in 100% mission readiness.', '100% mission readiness'],
    ['Reconciled 14 ULOs in DAI - all cleared on the next report.', 'all cleared on the next report'],
    ['Ran the S-1 customer service desk (300 hours), serving 450 Marines.', 'serving 450 Marines'],
  ];
  for (const [text, result] of cases) assert.equal(splitOutcome(text).result, result, text);
  // A figure, a purpose or a role is not an outcome.
  for (const text of [
    'Deobligated 3 MIPRs, saving $18,250.', 'Processed 22 MIPRs obligating $240K, supporting the FY26 close.', 'Reconciled 14 ULOs totaling $48,250 in DAI.',
    'Stood duty during the holiday period.', 'Processed 40 DTS vouchers, working with the S-1 to close the backlog.', 'Drafted 12 award recommendations, serving as the section NCOIC.',
    'Audited 52 OMPFs, coordinating with IPAC.', 'Processed 22 MIPRs, averaging 3 days each.', 'Trained 5 Marines, spanning 3 battalions.',
  ]) {
    assert.equal(splitOutcome(text).result, '', text);
  }
});

test('an edit is read sentence by sentence, under the heading or label it sits beneath', () => {
  const cfg = narrativeConfig('jepes');
  const n = write(GRADE_EXAMPLES[0].entries, 'jepes', 400);
  const [first] = n.sentences;
  // A sentence pasted twice is kept once; the copy is read from its words.
  const twice = piecesOf(`${n.text}\n-${first.text}`, n.sentences, cfg);
  assert.equal(twice.filter((p) => p.kind === 'kept').length, n.sentences.length);
  assert.deepEqual(twice.filter((p) => p.kind === 'typed').map((p) => p.kind === 'typed' && p.area), ['Leadership']);
  // A title's abbreviation does not end a sentence; a label opens its area.
  const typed = piecesOf('MISSION: Briefed Lt. Col. Smith on 14 ULOs. LEADERSHIP: Trained 5 Marines.', [], cfg);
  assert.deepEqual(typed.map((p) => p.kind === 'typed' && [p.text, p.area]), [['Briefed Lt. Col. Smith on 14 ULOs.', 'MOS / Mission Accomplishment'], ['Trained 5 Marines.', 'Leadership']]);
  // Under a heading line, as bullets have it.
  const bullets = piecesOf('Leadership\n-Trained 5 Marines.', [], cfg);
  assert.deepEqual(bullets.map((p) => p.kind === 'typed' && p.area), ['Leadership']);
});

test('the bands, the note under the ring, and an empty text', () => {
  assert.equal(GRADE_PARTS.reduce((t, p) => t + p.of, 0), 100);
  assert.deepEqual(GRADE_BANDS.map((b) => [b.grade, b.from]), [['Strong', 85], ['Solid', 70], ['Needs work', 50], ['Thin', 0]]);
  assert.deepEqual([gradeFor(85, true), gradeFor(84, true), gradeFor(70, true), gradeFor(50, true), gradeFor(49, true), gradeFor(0, false)], ['Strong', 'Solid', 'Solid', 'Needs work', 'Thin', 'Empty']);
  assert.match(GRADE_NOTE, /Strong from 85, Solid from 70, Needs work from 50, Thin below that/);
  const empty = write([], 'jepes');
  assert.equal(empty.review.grade, 'Empty');
  assert.equal(reviewEdit('   ', empty, narrativeConfig('jepes')).grade, 'Empty');
  // Over the limit, the length part asks for the cut.
  const n = write(GRADE_EXAMPLES[0].entries, 'jepes', 400);
  const over = reviewEdit(`${n.text}\n-${'Reconciled 14 more ULOs; all cleared. '.repeat(4).trim()}`, n, narrativeConfig('jepes'));
  const fit = over.parts.find((p) => p.key === 'fit')!;
  assert.equal(fit.earned, 0);
  assert.match(fit.raise!.text, /^Cut \d+ characters$/);
  assert.ok(over.findings.some((f) => f.id === 'over'));
});

test('a part short of full says what would raise it, in the written text’s words or the edit’s', () => {
  const ex = GRADE_EXAMPLES.find((e) => e.name === 'one area and a weak opening')!;
  const n = write(ex.entries, 'jepes', ex.limit);
  const part = (r: Review, key: PartKey) => r.parts.find((p) => p.key === key)!;
  assert.equal(part(n.review, 'coverage').raise?.text, 'Log work under “Individual Character” and “Leadership”');
  assert.equal(part(n.review, 'verbs').raise?.text, 'Start the Title of the entries behind 1 sentence with a past-tense verb for what you did');
  assert.equal(part(n.review, 'fit').raise?.text, 'Log more work, with outcomes, to fill at least 600 characters');
  const edited = reviewEdit(n.text, n, narrativeConfig('jepes'));
  assert.equal(part(edited, 'coverage').raise?.text, 'Add a sentence under “Individual Character” and “Leadership”');
  assert.equal(part(edited, 'verbs').raise?.text, 'Start 1 sentence with a past-tense verb for what you did');
  assert.equal(part(edited, 'fit').raise?.text, 'Bring it to at least 600 characters');
});

test('what a Marine does to a list, a heading or a line does not move the grade', () => {
  const cfg = narrativeConfig('jepes');
  const n = write(GRADE_EXAMPLES[0].entries, 'jepes', 400);
  const same = (edit: string, why: string) => {
    const r = reviewEdit(edit, n, cfg);
    assert.deepEqual([r.score, ...said(r.parts).map((p) => p.earned)], [n.review.score, ...said(n.review.parts).map((p) => p.earned)], `${why}\n${edit}`);
    assert.ok(!r.findings.some((f) => f.id.startsWith('outcome:typed') || f.id.startsWith('no_verb:typed')), `${why}: no finding about a sentence nobody wrote`);
  };
  const lines = n.text.split('\n');
  const marked = (m: (i: number) => string) => lines.map((l, i) => l.replace(/^-/, m(i))).join('\n');
  for (const [m, why] of [[(i: number) => `${i}. `, '1.'], [(i: number) => `(${i}) `, '(1)'], [(i: number) => `${'abcdef'[i]}) `, 'a)'], [() => '-- ', '--'], [() => '• ', '•'], [() => 'o ', 'o']] as const) {
    same(marked(m), `list marker ${why}`);
  }
  for (const heading of [
    'Mission Accomplishment', 'MOS/Mission Accomplishment', 'MOS / Mission Accomplishment:', 'mos and/or mission accomplishment', 'MOS and/or Mission Accomplishment.',
    'MOS', 'MOS:', 'MOS and Mission Accomplishment', 'MOS & Mission Accomplishment', 'MOS or Mission Accomplishment', 'Mission Accomplishments', 'Mission Accomplishment (MOS)',
  ]) {
    same(n.text.replace('MOS and/or Mission Accomplishment', heading), `heading “${heading}”`);
  }
  same(n.text.replace('Leadership', 'Leadership.'), 'heading with a period');
  same(`Billet accomplishments\n${n.text}`, 'a title line');
  same(n.text.replace(' on DAI requisition', ' on DAI\nrequisition'), 'a sentence wrapped by hand');
  same(n.text.replace(' on DAI requisition', ' on\nDAI requisition'), 'wrapped before an acronym');
  same(n.text.replace('Reconciled 14 ULOs', 'Reconciled\n14 ULOs'), 'wrapped before a figure');
  same(`Period: 1 Jun 2025 - 30 Nov 2026\nJEPES input\n${n.text}`, 'a record line and a title');
  // A sentence wrapped so its last figure opens a line, "to\n3. Reconciled", keeps the next sentence too.
  const two = write([
    { id: 'a', title: 'Routed DTS vouchers for TAD travel', quantity: 48, unit_label: 'vouchers', result: 'average turnaround cut from 9 days to 3', eval_area: M_AREA },
    { id: 'b', title: 'Reconciled ULOs in DAI', quantity: 14, unit_label: 'ULOs', result: 'all cleared on the next report', eval_area: M_AREA },
  ], 'jepes', 400, 'paragraph');
  const figure = two.text.replace(' to 3. ', ' to\n3. ').replace(' in DAI;', ' in\nDAI;');
  assert.notEqual(figure, two.text);
  assert.ok(piecesOf(figure, two.sentences, cfg).every((p) => p.kind === 'kept'), figure);
  assert.equal(reviewEdit(figure, two, cfg).score, two.review.score);
  // A paragraph's label at the end of a line, or named another way, still opens its area.
  const para = write(GRADE_EXAMPLES[0].entries, 'jepes', 400, 'paragraph');
  for (const [from, to] of [['MISSION: ', 'MISSION:\n'], ['MISSION: ', 'MOS: '], ['LEADERSHIP: ', 'Leadership:\n']]) {
    const r = reviewEdit(para.text.replace(from, to), para, cfg);
    assert.deepEqual([r.score, ...said(r.parts).map((p) => p.earned)], [para.review.score, ...said(para.review.parts).map((p) => p.earned)], `${to}\n${para.text.replace(from, to)}`);
  }
  // A label after a dash still opens its area.
  const label = piecesOf('-LEADERSHIP: Trained 5 Marines on the M27; all 5 qualified.', [], cfg);
  assert.deepEqual(label.map((p) => p.kind === 'typed' && [p.text, p.area]), [['Trained 5 Marines on the M27; all 5 qualified.', 'Leadership']]);
});

test('a date or a rank abbreviated in a typed sentence does not end it', () => {
  const cfg = narrativeConfig('jepes');
  for (const text of [
    'Reconciled 14 ULOs in DAI by 12 Mar. 2026; all cleared on the next report.', 'Briefed 1stSgt. Jones on 12 OCMTs; all cleared.',
    'Ran 3 ranges at Ft. Leonard Wood; all Marines qualified.', 'Closed 40 cases by the 1st Qtr. FY26 deadline; none returned.', 'Filed 9 claims by Sept. 30; all paid.',
  ]) {
    const pieces = piecesOf(`MISSION: ${text}`, [], cfg);
    assert.deepEqual(pieces.map((p) => p.kind === 'typed' && p.text), [text]);
  }
});

test('the summary reworded is still the summary, and a text of it alone says what would raise it', () => {
  const cfg = narrativeConfig('jepes');
  const n = write(WRITER_CORPUS, 'jepes', 300);
  const summary = n.sentences.find((s) => s.kind === 'summary');
  assert.ok(summary, n.text);
  const reworded = n.text.replace(summary.text, summary.text.replace(/\b4\b/, 'four').replace(' and ', ', and '));
  assert.notEqual(reworded, n.text);
  const r = reviewEdit(reworded, n, cfg);
  assert.deepEqual([r.score, r.grade], [n.review.score, n.review.grade], reworded);
  assert.ok(!r.findings.some((f) => f.id.startsWith('outcome:typed')));
  // A text that is only the summary claims no work: each claim part says what would.
  const alone = reviewEdit(`-${summary.text}`, n, cfg);
  checkParts(alone, 'jepes', 300, 'the summary alone');
  assert.equal(alone.parts.find((p) => p.key === 'outcomes')!.raise?.text, 'Add a sentence that says what you did, with a number and what came of it');
});

test('a bullet moved under another heading counts for the area it sits under', () => {
  const cfg = narrativeConfig('jepes');
  const n = write(GRADE_EXAMPLES[0].entries, 'jepes', 400);
  // The food pantry line moved from Individual Character to Leadership: the text no longer covers Character.
  const [character, pantry, ...rest] = n.text.split('\n');
  const moved = reviewEdit([character, ...rest, pantry].join('\n'), n, cfg);
  assert.equal(moved.parts.find((p) => p.key === 'coverage')!.note, '2 of 3 areas');
  assert.ok(moved.findings.some((f) => f.id === 'empty:Individual Character'));
  // An entry's area changed in the record after the edit: the text still puts it under MOS, so it still covers MOS.
  const later = write(GRADE_EXAMPLES[0].entries.map((e) => (e.id === 'u' ? { ...e, eval_area: 'Leadership' } : e)), 'jepes', 400);
  const r = reviewEdit(n.text, later, cfg);
  assert.equal(r.parts.find((p) => p.key === 'coverage')!.note, '3 of 3 areas');
  assert.ok(!r.findings.some((f) => f.id.startsWith('empty:')));
});

test('a narrative wrapped by hand at any column grades as written', () => {
  const wrap = (t: string, col: number) => t.split('\n').map((line) => {
    const out: string[] = [];
    let cur = '';
    for (const w of line.split(' ')) {
      if (cur && `${cur} ${w}`.length > col) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
    }
    return [...out, cur].join('\n');
  }).join('\n');
  let checked = 0;
  for (const track of ['jepes', 'fitrep'] as const) {
    for (const format of ['bullets', 'paragraph'] as const) {
      for (const entries of [DEMO_ENTRIES, WRITER_CORPUS, ...GRADE_EXAMPLES.map((e) => e.entries)]) {
        const n = write(entries, track, 1000, format);
        for (const col of [40, 60]) {
          const edit = wrap(n.text, col);
          const r = reviewEdit(edit, n, narrativeConfig(track));
          assert.deepEqual(said(r.parts).map((p) => p.earned), said(n.review.parts).map((p) => p.earned), `${track} ${format} at ${col}\n${edit}`);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked >= 24);
});

test('an area named inside a typed sentence is not a label', () => {
  const cfg = narrativeConfig('fitrep');
  const n = write(DEMO_ENTRIES, 'fitrep', 2000);
  const typed = '-Taught 3 classes on Leadership: counseling and PT; all 30 attendees passed.';
  const pieces = piecesOf(`${typed}\n${n.text}`, n.sentences, cfg);
  assert.deepEqual(pieces.filter((p) => p.kind === 'typed').map((p) => p.kind === 'typed' && [p.text, p.area]), [[typed.slice(1), null]]);
  const r = reviewEdit(`${typed}\n${n.text}`, n, cfg);
  assert.equal(r.parts.find((p) => p.key === 'coverage')!.earned, n.review.parts.find((p) => p.key === 'coverage')!.earned);
  assert.ok(!r.findings.some((f) => f.id.startsWith('empty:')), JSON.stringify(r.findings.map((f) => f.id)));
});

test('only a title or a record line is left unread: every other typed line is a sentence', () => {
  const cfg = narrativeConfig('fitrep');
  const titles = ['Billet accomplishments', 'JEPES input', 'Section C comments', 'Period: 1 Jun 2025 - 30 Nov 2026', 'Billet: Section NCOIC'];
  for (const t of titles) assert.deepEqual(piecesOf(`${t}\n-Trained 5 Marines; all qualified.`, [], cfg).map((p) => p.kind === 'typed' && p.text), ['Trained 5 Marines; all qualified.'], t);
  const n = write(DEMO_ENTRIES, 'fitrep');
  for (const [line, check] of [['Promote ahead of peers', 'rs_judgment'], ['Outstanding team player', 'superlative'], ['Selected as Marine of the Quarter', 'outcome'], ['Promoted to Corporal', 'outcome']]) {
    assert.deepEqual(piecesOf(line, [], cfg).map((p) => p.kind === 'typed' && p.text), [line]);
    const r = reviewEdit(`${n.text}\n${line}`, n, cfg);
    assert.ok(r.findings.some((f) => f.id.startsWith(`${check}:typed`)), `${line}: ${JSON.stringify(r.findings.map((f) => f.id))}`);
  }
  // A heading Vantage does not know is read as a line, not dropped: the bullets under it keep their own reading.
  const jepes = narrativeConfig('jepes');
  const g = write(GRADE_EXAMPLES[0].entries, 'jepes', 400);
  const r = reviewEdit(`${g.text}\nDuties\n-Ran the S-1 desk for 300 hours; 450 Marines served.`, g, jepes);
  assert.ok(r.findings.some((f) => /Duties/.test(f.title)), JSON.stringify(r.findings.map((f) => f.title)));
});

test('a dash reads as a join only before a clause, and a Result the writer joins reads the same typed', () => {
  for (const [text, result] of [
    ['Processed 12 - 15 DTS vouchers a day for the S-1.', ''], ['Stood duty 0800 - 1600 on 12 weekends.', ''],
    ['Inventoried 120 items - weapons, optics and radios.', ''], ['Reconciled 14 ULOs -- 9 in DAI and 5 in GCSS-MC.', ''],
    ['Trained 30 Marines - 100% qualified.', '100% qualified'], ['Reconciled 14 ULOs in DAI - all cleared and 2 recovered.', 'all cleared and 2 recovered'],
    // A name that ends in a figure is not a range, and a range elsewhere in the sentence leaves the join.
    ['Trained 30 Marines on the M27 - 28 qualified expert.', '28 qualified expert'], ['Reconciled 14 ULOs for the S-4 - 14 cleared on the next report.', '14 cleared on the next report'],
    ['Reconciled 31 ULOs in FY26 - 28 cleared.', '28 cleared'], ['Processed 40 DTS vouchers for 3/5 - 0 returned for correction.', '0 returned for correction'],
    ['Processed 22 MIPRs for the G-8 - $240K obligated, zero returned.', '$240K obligated, zero returned'], ['Processed 40 vouchers in Oct - 40 paid on time.', '40 paid on time'],
    ['Stood duty 0800 - 1600 on 12 weekends - zero incidents.', 'zero incidents'], ['Ran 12 ranges from Jun - Aug - 100% of Marines qualified.', '100% of Marines qualified'],
    ['Taught 3 classes - first aid, land nav and comm - all 30 passed.', 'all 30 passed'], ['Served 1 Jun - 30 Nov as duty NCO.', ''],
    // A measure is an outcome; a breakdown or a list of things is not, whatever "-ed" word describes them.
    ['Inspected 40 vehicles - 100% mission capable, zero mishaps.', '100% mission capable, zero mishaps'], ['Processed 40 vouchers - zero errors, zero late.', 'zero errors, zero late'],
    ['Trained 30 Marines - 30 qualified and 2 promoted.', '30 qualified and 2 promoted'], ['Trained 40 Marines - 10 officers and 30 enlisted.', ''],
    ['Conducted PMCS on 40 vehicles - 12 MRAPs, 20 JLTVs and 8 tracked vehicles.', ''], ['Inventoried 300 items - weapons, optics and assigned gear.', ''],
    ['Processed 300 documents - classified and unclassified.', ''], ['Inventoried 120 items - rifles, pistols and crew-served weapons.', ''], ['Trained on DTS - GTCC - DAI.', ''],
  ] as const) assert.equal(splitOutcome(text).result, result, text);
  // An em dash, an en dash or two hyphens between words, as typed, is the same join.
  const cfg = narrativeConfig('jepes');
  for (const dash of ['\u2014', ' \u2014 ', '\u2013', '--']) {
    const r = reviewEdit(`MISSION: Reconciled 14 ULOs in DAI${dash}all cleared on the next report.`, { sentences: [], facts: [], limit: 400 }, cfg);
    assert.equal(r.parts.find((p) => p.key === 'outcomes')!.earned, 25, dash);
  }
  // Each "-ing" Result the writer joins after a comma reads as an outcome from the words too, on both tracks.
  for (const track of ['jepes', 'fitrep'] as const) {
    const c = narrativeConfig(track);
    for (const result of [
      'helping the section pass the IG inspection', 'funding 3 new billets', 'leading the battalion in PFT average', 'preparing both for the Sergeants board',
      'standing up a new donor program', 'working without a single error', 'operating with zero mishaps', 'managing the move of 40 files', 'cutting the backlog to 2',
    ]) {
      const n = write([{ id: 'x', title: 'Rebuilt the inspection tracker', quantity: 12, unit_label: 'programs', result, eval_area: c.areas[0] }], track);
      const facts = new Map(n.facts.map((f) => [f.key, f]));
      for (const s of n.sentences.filter((x) => x.kind !== 'summary')) {
        assert.equal(readTyped(s.text, s.area, c).reading.outcome, readingOf(s, facts).outcome, `${track}: ${s.text}`);
      }
    }
  }
});

test('a typed sentence takes the area of the label above it and opens with the verb only as typed', () => {
  const cfg = narrativeConfig('jepes');
  // A marker alone on its line opens the next item; it is no sentence.
  const pieces = piecesOf('MISSION:\n1.\nReconciled 14 ULOs; all cleared.\n2.\nLEADERSHIP: Trained 5 Marines; all qualified.', [], cfg);
  assert.deepEqual(pieces.map((p) => p.kind === 'typed' && [p.text, p.area]), [['Reconciled 14 ULOs; all cleared.', 'MOS / Mission Accomplishment'], ['Trained 5 Marines; all qualified.', 'Leadership']]);
  assert.equal(readTyped('Reconciled 14 ULOs; all cleared.', null, cfg).reading.opens, true);
  assert.equal(readTyped('I reconciled 14 ULOs; all cleared.', null, cfg).reading.opens, false);
  assert.equal(readTyped('Reconciled 14 ULOs; all cleared.', 'Leadership', cfg).reading.area, 'Leadership');
});

test('an entry typed with "--" and FITREP headings named by their section letter change nothing', () => {
  for (const track of ['jepes', 'fitrep'] as const) {
    const cfg = narrativeConfig(track);
    for (const format of ['bullets', 'paragraph'] as const) {
      const n = write([
        { id: 'a', title: 'Reconciled 14 ULOs--all in DAI', quantity: 14, unit_label: 'ULOs', eval_area: cfg.areas[0] },
        { id: 'b', title: 'Trained section Marines on DAI', quantity: 5, unit_label: 'Marines', result: 'rework fell from 9 to 2', eval_area: 'Leadership' },
      ], track, 400, format);
      assert.match(n.text, /ULOs--all/);
      const r = reviewEdit(n.text, n, cfg);
      assert.deepEqual([r.score, ...said(r.parts).map((p) => p.earned)], [n.review.score, ...said(n.review.parts).map((p) => p.earned)], `${track} ${format}`);
    }
  }
  const cfg = narrativeConfig('fitrep');
  const n = write(GRADE_EXAMPLES[0].entries, 'fitrep', 400);
  const letter: Record<string, string> = { 'Mission Accomplishment': 'D', 'Individual Character': 'E', Leadership: 'F' };
  for (const form of ['L: A', 'Section L: A', 'A (Section L)', 'A (L)', 'Section L - A']) {
    const edit = n.sentences.map((s) => `${form.replace('L', letter[s.area]).replace('A', s.area)}\n-${s.text}`).join('\n');
    const r = reviewEdit(edit, n, cfg);
    assert.deepEqual([r.score, ...said(r.parts).map((p) => p.earned)], [n.review.score, ...said(n.review.parts).map((p) => p.earned)], edit);
  }
});
