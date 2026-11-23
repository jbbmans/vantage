import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeBullet } from '../../shared/bullets.ts';
import { bulletFor } from '../../shared/writer/coach.ts';
import { writeNarrative } from '../../shared/writer/compose.ts';
import { narrativeConfig } from '../../shared/evaluation.ts';
import { readEntry, type EntryInput } from '../../shared/writer/facts.ts';
import { BULLET_EXAMPLES, DOMAINS, EDGE_CASES } from './bulletExamples.ts';
import { checkNarrative, checkSentence } from './bulletChecks.ts';
import { DEMO_ENTRIES, NARRATIVE_SPEC_ENTRIES, WRITER_CORPUS, type CorpusEntry } from './writerCorpus.ts';

test('the fixed examples cover six fields of work, ten each', () => {
  assert.ok(BULLET_EXAMPLES.length >= 40);
  for (const d of DOMAINS) assert.equal(BULLET_EXAMPLES.filter((x) => x.domain === d).length, 10, d);
  const titles = BULLET_EXAMPLES.map((x) => x.entry.title);
  assert.equal(new Set(titles).size, titles.length, 'no example twice');
});

for (const [i, x] of BULLET_EXAMPLES.entries()) {
  test(`example ${i + 1} (${x.domain}): ${x.entry.title}`, () => {
    const jepes = composeBullet(x.entry);
    const fitrep = composeBullet(x.entry, { style: 'fitrep' });
    assert.equal(jepes, x.jepes);
    assert.equal(fitrep, x.fitrep);
    // The record, the coach and the package write the same bullet.
    assert.equal(bulletFor(x.entry, 'jepes'), jepes);
    assert.equal(bulletFor(x.entry, 'fitrep'), fitrep);
    assert.deepEqual(checkSentence(jepes, { sources: [x.entry] }), []);
    assert.deepEqual(checkSentence(fitrep, { sources: [x.entry], track: 'fitrep' }), []);
    // Section C's shorthand is never the longer of the two.
    assert.ok(fitrep.length <= jepes.length, `${fitrep} / ${jepes}`);
    // Another wording changes the words that join, never a figure or the claim.
    const other = bulletFor(x.entry, 'jepes', 1);
    assert.deepEqual(checkSentence(other, { sources: [x.entry] }), []);
    assert.deepEqual(other.match(/\$?[\d,.]+[KMB]?/g), jepes.match(/\$?[\d,.]+[KMB]?/g));
  });
}

for (const [i, x] of EDGE_CASES.entries()) {
  test(`edge case ${i + 1}: ${x.entry.title}`, () => {
    const jepes = composeBullet(x.entry);
    const fitrep = composeBullet(x.entry, { style: 'fitrep' });
    assert.equal(jepes, x.jepes);
    assert.equal(fitrep, x.fitrep ?? x.jepes);
    assert.deepEqual(checkSentence(jepes, { sources: [x.entry] }), []);
    assert.deepEqual(checkSentence(fitrep, { sources: [x.entry], track: 'fitrep' }), []);
  });
}

test('the stricter checks catch the faults the review named', () => {
  const mipr: EntryInput[] = [{ title: 'Processed MIPRs for the G-8', quantity: 22, unit_label: 'MIPRs', dollar_amount: 240000, result: 'zero returned' }];
  const rule = (text: string, sources: EntryInput[] = mipr, track: 'jepes' | 'fitrep' = 'jepes') => checkSentence(text, { sources, track }).map((b) => b.split(':')[0]);
  // An outcome after a semicolon is not an "-ing" phrase, a capital, or a placeholder.
  const tracker: EntryInput[] = [{ title: 'Built a UMT tracker', result: 'cutting the weekly review to 1 hour' }];
  assert.ok(rule('Built a UMT tracker; cutting the weekly review to 1 hour.', tracker).includes('join'));
  assert.deepEqual(rule('Built a UMT tracker, cutting the weekly review to 1 hour.', tracker), []);
  assert.ok(rule('Processed 22 MIPRs obligating $240,000 for the G-8; The CO approved.').includes('join'));
  assert.ok(rule('Processed 22 MIPRs obligating $240,000 for the G-8; N/A.').includes('join'));
  // On FITREP, dollars of $10K or more are in the short form.
  assert.ok(rule('Processed 22 MIPRs obligating $240,000 for the G-8; zero returned.', mipr, 'fitrep').includes('number form'));
  assert.deepEqual(rule('Processed 22 MIPRs obligating $240K for the G-8; zero returned.', mipr, 'fitrep'), []);
  assert.deepEqual(rule('Obligated $4,500 for the range.', [{ title: 'Obligated funds for the range', dollar_amount: 4500, dollar_type: 'obligated' }], 'fitrep'), [], 'under $10K stays in full');
  // The count is where it reads.
  assert.ok(rule('Processed 22 several MIPRs obligating $240,000 for the G-8.').includes('count placement'));
  assert.ok(rule('Processed and 22 approved MIPRs obligating $240,000 for the G-8.').includes('count placement'));
  assert.ok(rule('Processed submitted 22 MIPRs obligating $240,000 for the G-8.').includes('count placement'));
  assert.ok(rule('Processed MIPRs obligating $240,000 for the G-8 by 22 reviewing packages.').includes('count placement'));
  const toys: EntryInput[] = [{ title: 'Organized a Toys for Tots drive', quantity: 400, unit_label: 'toys' }];
  assert.ok(rule('Organized a Toys for 400 Tots drive.', toys).includes('count placement'));
  const audit: EntryInput[] = [{ title: 'Completed the records audit', quantity: 85, unit_label: 'records' }];
  assert.ok(rule('Completed the 85 records audit.', audit).includes('count placement'));
  const inventory: EntryInput[] = [{ title: 'Accounted for items during the inventory', quantity: 300, unit_label: 'items' }];
  assert.ok(rule('Accounted 300 items during the inventory.', inventory).includes('count placement'));
  assert.deepEqual(rule('Accounted for 300 items during the inventory.', inventory), []);
  // What the Marine typed that way stands: the rule is for where the writer puts the count.
  assert.ok(!rule('Trained 20+ Marines on the M27.', [{ title: 'Trained 20+ Marines on the M27' }]).includes('count placement'));
  // Two verbs at the opening, a unit twice in parentheses, a time or a grade as a result.
  assert.ok(rule('Processed routed to the G-8 (22 MIPRs, $240,000).').includes('past-tense opener'));
  const ompf: EntryInput[] = [{ title: 'Audited records for the battalion', quantity: 85, unit_label: 'OMPFs' }];
  assert.ok(rule('Audited records for the battalion (OMPFs; 85 OMPFs).', ompf).includes('figure twice'));
  assert.ok(rule('Completed the audit, resulting in 2 days early.', [{ title: 'Completed the audit', result: '2 days early' }]).includes('resulting in'));
  assert.ok(rule('Completed the PFT, resulting in 285 PFT score.', [{ title: 'Completed the PFT', result: '285 PFT score' }]).includes('resulting in'));
  // A count with no unit near it is not that count, and a word left hanging is not the end of a sentence.
  assert.ok(rule('Processed MIPRs obligating $240,000 for the G-8 in 22 days.').includes('figure missing'));
  assert.ok(rule('Processed 22 MIPRs obligating $240,000 for the G-8 &.').includes('period'));
});

test('each check catches the fault it names', () => {
  const sources: EntryInput[] = [{ title: 'Processed MIPRs for the G-8', quantity: 22, unit_label: 'MIPRs', dollar_amount: 240000, result: 'zero returned' }];
  const rule = (text: string) => checkSentence(text, { sources }).map((b) => b.split(':')[0]);
  assert.deepEqual(rule('Processed 22 MIPRs obligating $240,000 for the G-8; zero returned.'), []);
  assert.ok(rule('Processing 22 MIPRs for the G-8.').includes('past-tense opener'));
  assert.ok(rule('Processed MIPRs for the G-8 ((22 MIPRs)).').includes('double parentheses'));
  assert.ok(rule('Processed MIPRs for the G-8 (22 MIPRs (G-8)).').includes('double parentheses'));
  assert.ok(rule('Processed MIPRs for the G-8 (22 MIPRs) ($240,000).').includes('double parentheses'));
  assert.ok(rule('Processed 22 MIPRs for the G-8, resulting in reduced backlog.').includes('resulting in'));
  assert.ok(rule('Processed 23 MIPRs for the G-8.').includes('number provenance'));
  assert.ok(rule('Processed 22 MIPRs obligating $250K for the G-8.').includes('number provenance'));
  assert.deepEqual(rule('Processed 22 MIPRs obligating $240K for the G-8.'), [], 'a figure rounded as shown is the same figure');
  assert.ok(rule('Processed 22 MIPRs for the G-8 (22 MIPRs).').includes('figure twice'));
  assert.ok(rule('Processed 22 MIPRs for the G-8').includes('period'));
  assert.ok(rule('Processed 22 MIPRs for the G-8..').includes('period'));
  assert.ok(rule(`Processed 22 MIPRs for the G-8 ${'and the section '.repeat(20)}.`).includes('limit'));
  assert.ok(rule('Processed 22 MIPRs for my G-8.').includes('plain text'));
  assert.ok(rule('Processed 22 MIPRs for the the G-8.').includes('plain text'));
  assert.ok(rule(`Processed 22 MIPRs for the G-8 ${String.fromCharCode(0x2014)} early.`).includes('plain text'));
  assert.ok(rule('Processed 22 MIPRs obligating $240,000 for the G-8; We had zero returned.').includes('plain text'), 'a capital We is the first person');

  // Dollars are dollars, counts are counts, and a count is said as typed.
  assert.ok(rule('Processed 22 MIPRs obligating $22 for the G-8.').includes('number provenance'));
  assert.ok(rule('Processed 240000 MIPRs for the G-8.').includes('number provenance'));
  const grade = (text: string) => checkSentence(text, { sources: [{ title: 'Completed the SNCO course', result: 'graduated with a 3.8 GPA' }] }).map((b) => b.split(':')[0]);
  assert.ok(grade('Completed the SNCO course, with a 4 GPA.').includes('number provenance'));
  // Nothing of the entry is lost: "Processing MIPRs for Q4" with 4 MIPRs is not "Processed MIPRs for Q4".
  assert.ok(checkSentence('Processed MIPRs for Q4.', { sources: [{ title: 'Processing MIPRs for Q4', quantity: 4, unit_label: 'MIPRs' }] }).some((b) => b.startsWith('figure missing')));
  assert.ok(rule('Processed 22 MIPRs for the G-8; zero returned.').some((b) => b === 'figure missing'));
  // The count typed in the title and the count field are one statement.
  const typed: EntryInput = { title: 'Reconciled 14 ULOs totaling $48,250 in DAI', quantity: 14, unit_label: 'ULOs', dollar_amount: 48250, dollar_type: 'reconciled' };
  assert.ok(checkSentence('Reconciled 14 ULOs totaling $48,250 in DAI (14 ULOs totaling $48,250).', { sources: [typed] }).some((b) => b.startsWith('figure twice')));
  const toys: EntryInput = { title: 'Organized a Toys for Tots drive', quantity: 400, unit_label: 'toys', result: 'collected 400 toys for families in Twentynine Palms' };
  assert.ok(checkSentence('Organized a Toys for Tots drive (400 toys); collected 400 toys for families in Twentynine Palms.', { sources: [toys] }).some((b) => b.startsWith('figure twice')));
  assert.deepEqual(checkSentence('Organized a Toys for Tots drive, collecting 400 toys for families in Twentynine Palms.', { sources: [toys] }), []);

  // The opener is a capitalized past-tense verb, not a word that ends in "ed".
  for (const opener of ['Speed', 'Need', 'Exceed', 'Need-based', 'processed']) assert.ok(rule(`${opener} 22 MIPRs obligating $240,000 for the G-8.`).includes('past-tense opener'), opener);
  // "resulting in" before a clause, wherever its verb is.
  const swim = (text: string) => checkSentence(text, { sources: [{ title: 'Ran swim qualification for the company', quantity: 30, unit_label: 'Marines', result: '28 Marines passed on the first attempt' }] }).map((b) => b.split(':')[0]);
  assert.ok(swim('Ran swim qualification for the company (30 Marines), resulting in 28 Marines passed on the first attempt.').includes('resulting in'));
  assert.ok(!swim('Ran swim qualification for 30 Marines; 28 Marines passed on the first attempt.').includes('resulting in'));
  // The joins: no outcome glued on with a semicolon, no verb twice, no two "-ing" phrases, no verb after "in support of".
  const tracker = (text: string) => checkSentence(text, { sources: [{ title: 'Built a UMT tracker in Excel', result: 'cut the weekly review from 3 hours to 1 hour' }] }).map((b) => b.split(':')[0]);
  assert.ok(tracker('Built a UMT tracker in Excel; cut the weekly review from 3 hours to 1 hour.').includes('join'));
  assert.deepEqual(tracker('Built a UMT tracker in Excel, cutting the weekly review from 3 hours to 1 hour.'), []);
  assert.ok(rule('Obligated 22 MIPRs obligating $240,000 for the G-8.').includes('verb twice'));
  assert.ok(rule('Processed 22 MIPRs, saving $240,000, supporting the close.').includes('join'));
  assert.ok(rule('Processed 22 MIPRs obligating $240,000, in support of closed out the year.').includes('join'));
  // The figure as it is read, one sentence, nothing left dangling.
  const big: EntryInput[] = [{ title: 'Processed MIPRs for the G-8', quantity: 22, unit_label: 'MIPRs', dollar_amount: 999999, dollar_type: 'obligated' }];
  assert.ok(checkSentence('Processed 22 MIPRs obligating $1000K for the G-8.', { sources: big }).some((b) => b.startsWith('number form')));
  assert.deepEqual(checkSentence('Processed 22 MIPRs obligating $1M for the G-8.', { sources: big }), []);
  assert.ok(rule('Processed 22 MIPRs obligating $240,000 for the G-8 -.').includes('period'));
  assert.ok(rule('Processed 22 MIPRs obligating $240,000 for the G-8,.').includes('period'));
  assert.ok(rule('Processed 22 MIPRs obligating $240,000 for the G-8; zero returned for correction. CO was pleased.').includes('period'));
  assert.deepEqual(rule('Processed 22 MIPRs obligating $240,000 for Lt. Col. Smith; zero returned.'), [], 'an abbreviation is not the end of a sentence');

  // What reads right is not flagged: "Phase I", "Class I", "I MEF", "AT at", "mine-resistant", "had had".
  const right: Array<[string, EntryInput]> = [
    ['Completed Phase I of SNCOA DEP, with a 3.6 GPA.', { title: 'Completed Phase I of SNCOA DEP', result: '3.6 GPA' }],
    ['Issued Class I rations to the battalion (40 pallets).', { title: 'Issued Class I rations to the battalion', quantity: 40, unit_label: 'pallets' }],
    ['Processed 22 MIPRs obligating $240,000 for I MEF.', { title: 'Processed MIPRs for I MEF', quantity: 22, unit_label: 'MIPRs', dollar_amount: 240000, dollar_type: 'obligated' }],
    ['Completed AT at Camp Lejeune.', { title: 'Completed AT at Camp Lejeune' }],
    ['Conducted PMCS on 12 mine-resistant vehicles; zero deadlined.', { title: 'Conducted PMCS on mine-resistant vehicles', quantity: 12, unit_label: 'vehicles', result: 'zero deadlined' }],
  ];
  for (const [text, e] of right) assert.deepEqual(checkSentence(text, { sources: [e] }), [], text);
});

test('each narrative check catches the fault it names', () => {
  const M = 'MOS / Mission Accomplishment';
  const entries: CorpusEntry[] = [
    { id: 'a', title: 'Reconciled ULOs in DAI', quantity: 14, unit_label: 'ULOs', dollar_amount: 48250, dollar_type: 'reconciled', eval_area: M },
    { id: 'b', title: 'Reconciled ULOs in SABRS', quantity: 22, unit_label: 'ULOs', dollar_amount: 30400, dollar_type: 'reconciled', eval_area: M },
    { id: 'c', title: 'Reconciled ULOs for the S-4', quantity: 9, unit_label: 'ULOs', dollar_amount: 12100, dollar_type: 'reconciled', eval_area: M },
    { id: 'e', title: 'Corrected feeder rejects', quantity: 6, unit_label: 'rejects', dollar_amount: 4120, dollar_type: 'reconciled', eval_area: M },
    { id: 'g', title: 'Cleared UMTs', quantity: 4, unit_label: 'UMTs', eval_area: M },
    { id: 'l5', title: 'Checked on every section Marine during the barracks move', quantity: 6, unit_label: 'Marines', eval_area: 'Leadership' },
    { id: 'l3', title: 'Mentored 2 Cpls through Corporals Course DEP', quantity: 2, unit_label: 'Marines', eval_area: 'Leadership' },
  ];
  const narrative = (sentences: Array<{ kind: string; key: string; sources: string[]; text: string }>) => ({ text: sentences.map((s) => s.text).join(' '), limit: 2000, sentences }) as never;
  const rules = (sentences: Parameters<typeof narrative>[0]) => checkNarrative(narrative(sentences), entries);
  // A total that sums entries that have a sentence of their own says them twice.
  assert.ok(rules([
    { kind: 'entry', key: 'a', sources: ['a'], text: 'Reconciled 14 ULOs totaling $48,250 in DAI.' },
    { kind: 'entry', key: 'b', sources: ['b'], text: 'Reconciled 22 ULOs totaling $30,400 in SABRS.' },
    { kind: 'summary', key: 'summary:M', sources: ['a', 'b', 'c'], text: 'Reconciled 45 ULOs totaling $90,750.' },
  ]).some((b) => /a is counted in a and summary:M/.test(b)));
  assert.ok(rules([
    { kind: 'entry', key: 'g', sources: ['g'], text: 'Cleared 4 UMTs.' },
    { kind: 'entry', key: 'e', sources: ['e'], text: 'Corrected 6 feeder rejects totaling $4,120.' },
    { kind: 'summary', key: 'summary:M', sources: ['g', 'e'], text: 'Cleared 4 UMTs and corrected 6 rejects.' },
  ]).some((b) => b.startsWith('figure twice')));
  // A total of one kind: ULOs and rejects are not 20 ULOs, and a count is not dollars.
  const total = (text: string, sources: string[]) => rules([{ kind: 'summary', key: 'summary:M', sources, text }]);
  assert.ok(total('Reconciled 20 ULOs.', ['a', 'e']).some((b) => /number provenance/.test(b)));
  assert.ok(total('Reconciled 14 ULOs totaling $20.', ['a', 'e']).some((b) => /number provenance/.test(b)));
  assert.ok(total('Reconciled 5 more ULOs.', ['a', 'b', 'c', 'e', 'g']).some((b) => /number provenance/.test(b)));
  assert.deepEqual(total('Reconciled 45 ULOs totaling $90,750 and corrected 6 rejects.', ['a', 'b', 'c', 'e']), []);
  // A summary counts work only the way its entries' own bullets count it.
  assert.ok(total('Checked 6 Marines and mentored 2 Marines.', ['l5', 'l3']).some((b) => /"Checked N" is not work/.test(b)));
  assert.deepEqual(total('Mentored 2 Marines and reconciled 14 ULOs.', ['l3', 'a']).filter((b) => !/number provenance|figure missing/.test(b)), []);
});

const CORPORA: Array<[string, CorpusEntry[]]> = [
  ['the writer corpus', WRITER_CORPUS],
  ['the narrative spec', NARRATIVE_SPEC_ENTRIES],
  ['the demo seed', DEMO_ENTRIES],
  ['the fixed examples', BULLET_EXAMPLES.map((x, i) => ({ ...x.entry, id: `x${i}`, eval_area: 'MOS / Mission Accomplishment' }))],
  ['the edge cases', EDGE_CASES.map((x, i) => ({ ...x.entry, id: `e${i}`, eval_area: 'MOS / Mission Accomplishment' }))],
];

test('every bullet of every corpus passes the checks, on both tracks', () => {
  for (const [name, entries] of CORPORA) {
    for (const e of entries) {
      for (const style of ['jepes', 'fitrep'] as const) {
        assert.deepEqual(checkSentence(composeBullet(e, { style }), { sources: [e], track: style }), [], `${name}, ${style}`);
      }
    }
  }
});

test('every narrative of every corpus passes the checks: both tracks, both formats, several limits and wordings', () => {
  for (const [name, entries] of CORPORA) {
    for (const track of ['jepes', 'fitrep'] as const) {
      const cfg = narrativeConfig(track);
      // On FITREP the mission area has its Section name.
      const mine = track === 'fitrep' ? entries.map((e) => ({ ...e, eval_area: e.eval_area === 'MOS / Mission Accomplishment' ? 'Mission Accomplishment' : e.eval_area })) : entries;
      for (const format of ['bullets', 'paragraph'] as const) {
        for (const limit of [250, 400, 700, cfg.limit]) {
          for (const seed of [0, 1]) {
            for (const spellOut of [false, true]) {
              const n = writeNarrative(mine, { ...cfg, limit, format, seed, spellOut });
              assert.deepEqual(checkNarrative(n, mine, track), [], `${name}, ${track} ${format} at ${limit}, seed ${seed}${spellOut ? ', spelled out' : ''}:\n${n.text}`);
            }
          }
        }
      }
    }
  }
});

test('a summary says only what no sentence says, and opens with a verb', () => {
  const M = 'MOS / Mission Accomplishment';
  const entries: CorpusEntry[] = [
    { id: 'a', title: 'Reconciled ULOs in DAI for the quarterly review of unliquidated obligations across the regiment', quantity: 14, unit_label: 'ULOs', dollar_amount: 48250, dollar_type: 'reconciled', eval_area: M },
    { id: 'd', title: 'Processed MIPRs for the G-8 ahead of the fourth quarter spending plan deadline', quantity: 12, unit_label: 'MIPRs', dollar_amount: 120000, dollar_type: 'obligated', result: 'zero returned for correction', eval_area: M },
    { id: 'f', title: 'Corrected feeder rejects from GCSS-MC that had been holding the monthly close for the division', quantity: 6, unit_label: 'rejects', dollar_amount: 4120, dollar_type: 'reconciled', eval_area: M },
    { id: 'i', title: 'Trained 3 Marines on DAI', quantity: 3, unit_label: 'Marines', eval_area: M },
  ];
  const n = writeNarrative(entries, { ...narrativeConfig('jepes'), limit: 260, format: 'bullets', spellOut: false });
  const summary = n.sentences.find((s) => s.kind === 'summary');
  assert.equal(summary?.text, 'Reconciled 14 ULOs and corrected 6 rejects.', n.text);
  assert.deepEqual([...summary!.sources].sort(), ['a', 'f']);
  assert.deepEqual(checkNarrative(n, entries), []);
  // With room, the dollars ride on their counts, in the same word every sentence of the text uses.
  const roomy = writeNarrative(entries.filter((e) => e.id !== 'd'), { ...narrativeConfig('jepes'), limit: 200, format: 'bullets', spellOut: false });
  assert.ok(roomy.text.includes('totaling'), roomy.text);
  assert.ok(!/worth|valued at/.test(roomy.text), roomy.text);
});

/** A fixed-seed run over entries made from parts Marines type, so a rule that breaks on an odd mix shows up. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const SINGLE = { names: narrativeConfig('jepes').names, areas: narrativeConfig('jepes').areas };

test('random entries keep the structural rules: opener, parentheses, joins, figures, period, plain text', () => {
  const rand = rng(37);
  const one = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const titles = [
    'Processed MIPRs for the G-8', 'Processing 18 MIPRs for G-8', 'I reconciled ULOs in DAI', 'Reconciles UMTs on the Q4 report',
    'Cleared 2-Way UMTs', 'Inspected the vehicles for corrosion', 'Turned in excess equipment', 'Trained junior Marines on DAI',
    'Volunteered at the food pantry', 'Led section PT: 10 km hike', 'Built a tracker in Excel', 'FY26 year-end close',
    'Conducted PMCS on the battalion\'s MTVRs', 'Organized a Toys for Tots drive', 'Served as acting section chief', 'Helped with the close out',
    'Reviewed GPC statements for the S-4', 'Deobligated dormant MIPR balances', 'Audited 40 records (OMPFs)', 'Studied for the SNCO course',
  ];
  const units = ['MIPRs', 'ULOs', 'UMTs', 'vehicles', 'items', 'Marines', 'hours', 'months', 'km', 'toys'];
  const results = [
    'zero returned for correction', 'all cleared on the next report', 'cut the review from 3 hours to 1 hour', '100% mission readiness',
    'found and fixed 4 cracked frames', '3.8 GPA', 'reduced overdue taskers by 40%', 'board approved it the same day', 'collected 400 toys', '',
  ];
  const types = ['reconciled', 'obligated', 'saved', 'reviewed', 'impact', null];
  // Small sums, large ones and the amounts at the edge of a unit, where "$1000K" would come from.
  const AMOUNTS: Array<() => number> = [
    () => Math.round(rand() * 2_000_000) / 100, () => Math.round(rand() * 1e12) / 100,
    () => 999_950, () => 999_999, () => 9_999.99, () => 999_950_000, () => 999_999_999, () => 999_999_999_999,
  ];
  for (let i = 0; i < 600; i += 1) {
    const entry: EntryInput = {
      title: one(titles), quantity: rand() < 0.8 ? 1 + Math.floor(rand() * 400) : null, unit_label: one(units),
      dollar_amount: rand() < 0.5 ? one(AMOUNTS)() : null, dollar_type: one(types),
      result: one(results) || null, system: rand() < 0.3 ? one(['DAI', 'SABRS', 'GCSS-MC']) : null, organization: rand() < 0.2 ? 'G-8' : null,
    };
    // A title that names no work, with nothing the Marine classified to supply the verb, is the review's to flag
    // ("Does not start with what you did"); the writer adds no verb of its own.
    const named = !readEntry(entry, SINGLE).issues.some((x) => x.code === 'no_verb');
    for (const style of ['jepes', 'fitrep'] as const) {
      const text = composeBullet(entry, { style });
      assert.deepEqual(checkSentence(text, { sources: [entry], limit: 400, track: style, skip: named ? [] : ['past-tense opener'] }), [], JSON.stringify(entry));
    }
  }
});
