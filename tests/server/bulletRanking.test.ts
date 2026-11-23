import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as B from '../../shared/bullets.ts';
import { composeBullet, strength, STRENGTH_MAX, STRENGTH_POINTS, STRENGTH_TOOLTIP } from '../../shared/bullets.ts';
import { coachEntry, resumeFor } from '../../shared/writer/coach.ts';
import { writeNarrative } from '../../shared/writer/compose.ts';
import { writePackage } from '../../shared/writer/package.ts';
import { hasOutcome, readEntry, type EntryInput } from '../../shared/writer/facts.ts';
import { byRank, weigh } from '../../shared/writer/score.ts';
import { sameWork } from '../../shared/writer/repeats.ts';
import { basisOf, driftOf } from '../../shared/writer/basis.ts';
import { reviewText } from '../../shared/writer/review.ts';
import { plain, spellOut } from '../../shared/writer/realize.ts';
import { GLOSSARY } from '../../shared/writer/lexicon.ts';
import { GLOSSARY as REFERENCE } from '../../shared/fmra/glossary.ts';
import { areaAmong, narrativeConfig } from '../../shared/evaluation.ts';
import { BULLET_EXAMPLES, EDGE_CASES } from './bulletExamples.ts';
import { DEMO_ENTRIES, WRITER_CORPUS } from './writerCorpus.ts';
import { checkNarrative } from './bulletChecks.ts';
import { BILLETS, MEASURED, NOT_BILLETS, NOT_MEASURED, OCMT_COUNTS, RANK_PAIRS, REPEATS, ocmtEntries, seededRecord } from './rankingExamples.ts';

const M = 'MOS / Mission Accomplishment';
const JEPES = narrativeConfig('jepes');
const FITREP = narrativeConfig('fitrep');
const read = (e: EntryInput) => readEntry(e, { names: JEPES.names, areas: JEPES.areas });
const onTrack = (entries: EntryInput[], cfg: typeof JEPES) => entries.map((e) => ({ ...e, eval_area: areaAmong(e.eval_area, cfg.areas) }));
const narrate = (entries: EntryInput[], track: 'jepes' | 'fitrep' = 'jepes', limit = 1000) => {
  const cfg = track === 'fitrep' ? FITREP : JEPES;
  return writeNarrative(onTrack(entries, cfg), { ...cfg, limit, format: 'bullets', spellOut: false, track });
};

test('ranking: a measured outcome first, then a stated one, then figures', () => {
  for (const p of RANK_PAIRS) {
    const better = weigh(read(p.better));
    const worse = weigh(read(p.worse));
    assert.deepEqual([better.tier, worse.tier], p.tiers, p.why);
    assert.ok(byRank(better, worse) < 0, `${p.why}: ${better.score} against ${worse.score}`);
  }
  // The pinned weights: the $5M voucher run with no outcome once outscored the measured one (6.0 to 3.5).
  assert.deepEqual(weigh(read(RANK_PAIRS[0].better)), { score: 9.6, tier: 2, reasons: ['measured outcome', '40 vouchers'] });
  assert.deepEqual(weigh(read(RANK_PAIRS[0].worse)), { score: 3, tier: 0, reasons: ['no outcome', '$5M impact', '400 vouchers'] });
  assert.deepEqual(weigh(read(RANK_PAIRS[4].worse)), { score: 0, tier: 0, reasons: ['no outcome', 'names the billet'] });
});

test('ranking: with room for one line, the measured outcome gets it', () => {
  const run = { id: 'run', title: 'Processed 400 travel vouchers', quantity: 400, unit_label: 'vouchers', dollar_amount: 5_000_000, dollar_type: 'impact', eval_area: M, date: '2026-09-01' };
  const fix = { id: 'fix', title: 'Rebuilt the DTS routing list', result: 'cut payment time from 21 days to 6 days', eval_area: M, date: '2026-08-01' };
  for (const limit of [80, 100, 120]) {
    const n = writeNarrative([run, fix], { ...JEPES, limit, format: 'bullets', headings: false });
    assert.equal(n.text, '-Rebuilt the DTS routing list, cutting payment time from 21 days to 6 days.', String(limit));
    assert.deepEqual(n.left.map((s) => s.key), ['run']);
  }
  const both = writeNarrative([run, fix], { ...JEPES, limit: 400, format: 'bullets', headings: false });
  assert.deepEqual(both.sentences.map((s) => s.key), ['fix', 'run']);
});

test('ranking: in 600 seeded entries, every list puts measured outcomes before stated ones, and those before none', () => {
  const record = seededRecord(600, 38);
  const tiers = (xs: Array<{ tier: number }>) => xs.map((x) => x.tier);
  const sorted = (xs: number[]) => xs.every((t, i) => i === 0 || xs[i - 1] >= t);
  const facts = record.map((e) => weigh(read(e)));
  assert.ok(facts.some((w) => w.tier === 2) && facts.some((w) => w.tier === 1) && facts.some((w) => w.tier === 0), 'the record has every tier');
  for (const track of ['jepes', 'fitrep'] as const) {
    const cfg = track === 'fitrep' ? FITREP : JEPES;
    for (const g of writePackage(record, { form: track, areas: cfg.areas, names: cfg.names, limitPerArea: Infinity })) assert.ok(sorted(tiers(g.bullets)), `${track} ${g.area}: ${tiers(g.bullets)}`);
    const n = narrate(record, track, 1000);
    assert.ok(sorted(tiers(n.left)), `${track} left out: ${tiers(n.left)}`);
    // Whatever the narrative leaves out with a measured outcome, it has no room for: nothing it wrote is of a lower tier in that area.
    for (const s of n.left.filter((x) => x.tier === 2)) {
      const written = n.sentences.filter((w) => w.area === s.area && (w.kind === 'entry' || w.kind === 'group'));
      assert.ok(written.every((w) => w.tier === 2 || w.pinned), `${track}: "${s.text}" left out while a lower tier was written`);
    }
  }
});

test('measured: a number, a zero, every one, a deadline met; never a date, a fiscal year, a quarter or a staff section', () => {
  for (const r of MEASURED) assert.equal(read({ title: 'Reconciled the ledger', result: r }).strongResult, true, r);
  for (const r of NOT_MEASURED) assert.equal(read({ title: 'Reconciled the ledger', result: r }).strongResult, false, r);
  // "S-4" and "FY26" in a title are not the number the entry is missing.
  assert.ok(read({ title: 'Briefed the S-4 on the FY26 spend plan' }).issues.some((i) => i.code === 'unmeasured'));
});

test('billets: named, flagged and ranked lower, never held', () => {
  for (const t of BILLETS) {
    const f = read({ title: t, eval_area: M });
    assert.ok(f.issues.some((i) => i.code === 'billet'), t);
    assert.equal(f.held, null, t);
    assert.equal(weigh(f).tier, 0, t);
  }
  for (const t of NOT_BILLETS) assert.ok(!read({ title: t }).issues.some((i) => i.code === 'billet'), t);
  // With what came of it, the billet is the setting, not the claim.
  assert.ok(!read({ title: 'Served as acting section chief', result: 'closed 40 of 42 taskers on time' }).issues.some((i) => i.code === 'billet'));
  assert.equal(read({ title: 'Served as the S-4 chief' }).issues.find((i) => i.code === 'billet')?.message, 'Names the billet, not what was done in it');
  assert.equal(read({ title: 'Supervised the motor pool' }).issues.find((i) => i.code === 'billet')?.message, 'Says what you were in charge of, not what came of it');
  // The coach says it once: the billet note stands for the missing outcome too.
  assert.deepEqual(coachEntry({ title: 'Served as the S-4 chief', eval_area: M }).notes.map((n) => n.code), ['billet', 'unmeasured']);
  // The reviewer flags it in the narrative and in text edited by hand.
  const n = narrate([{ id: 'b', title: 'Served as the S-4 chief', eval_area: M }, { id: 'r', title: 'Reconciled 14 ULOs in DAI', quantity: 14, unit_label: 'ULOs', eval_area: M }]);
  assert.ok(n.review.findings.some((f) => f.id === 'billet:b' && f.cite === 'MCO 1616.1, App. E'));
  assert.ok(reviewText('-Served as the S-4 chief.\n-Reconciled 14 ULOs.', 1000).findings.some((f) => f.id === 'billet'));
});

test('the same work logged twice is held once; look-alikes still add up', () => {
  for (const r of REPEATS) assert.equal(sameWork(read(r.a), read(r.b)), r.same, r.why);
  const [twice] = REPEATS;
  const n = narrate([{ ...twice.a, id: 'm1' }, { ...twice.b, id: 'm2' }]);
  assert.deepEqual(n.held.map((h) => [h.key, h.reason]), [['m2', 'Looks logged twice: the same work and numbers as “Processed 22 MIPRs for the G-8” (2026-09-02), a day apart. Keep it if it was separate work.']]);
  assert.match(n.text, /^MOS and\/or Mission Accomplishment\n-Processed 22 MIPRs obligating \$240,000 for the G-8\.$/);
  // Kept, the copy counts again: keeping is the Marine's word that it was separate work.
  assert.match(writeNarrative(onTrack([{ ...twice.a, id: 'm1' }, { ...twice.b, id: 'm2' }], JEPES), { ...JEPES, limit: 1000, format: 'bullets', pin: ['m2'] }).text, /Processed 44 MIPRs obligating \$480,000/);
  // The fuller copy leads, whichever came first.
  const fuller = narrate([{ ...REPEATS[1].a, id: 'bare' }, { ...REPEATS[1].b, id: 'full' }]);
  assert.deepEqual(fuller.held.map((h) => h.key), ['bare']);
  // A week apart is two runs of the same work: one total.
  const week = narrate([{ ...REPEATS[2].a, id: 'w1' }, { ...REPEATS[2].b, id: 'w2' }]);
  assert.deepEqual(week.held, []);
  assert.match(week.text, /-Processed 44 MIPRs obligating \$480,000 for the G-8\./);
});

test('compiled: the same work is one total, said once (100 OCMTs over ten entries)', () => {
  const entries = ocmtEntries();
  const dollars = entries.reduce((n, e) => n + Number(e.dollar_amount), 0);
  assert.equal(OCMT_COUNTS.reduce((a, b) => a + b, 0), 100);
  assert.equal(dollars, 111_250);
  for (const limit of [300, 1000, 2000]) {
    const n = narrate(entries, 'jepes', limit);
    assert.equal(n.text, 'MOS and/or Mission Accomplishment\n-Cleared 100 OCMTs totaling $111,250 in DAI.', String(limit));
    assert.equal(n.left.length, 0, 'no entry of the total is offered on its own');
  }
  assert.equal(narrate(onTrack(entries, FITREP), 'fitrep').text, '-Cleared 100 OCMTs totaling $111.3K in DAI.');
  // The package and the résumé say it once too.
  const pkg = writePackage(entries, { areas: JEPES.areas, names: JEPES.names });
  assert.deepEqual(pkg.flatMap((g) => g.bullets.map((b) => b.text)), ['Cleared 100 OCMTs totaling $111,250 in DAI.']);
  assert.deepEqual(pkg.find((g) => g.area === M)!.bullets[0].sources, entries.map((e) => e.id));
  const resume = writePackage(entries, { form: 'resume', areas: JEPES.areas, names: JEPES.names });
  assert.deepEqual(resume.flatMap((g) => g.bullets.map((b) => b.text)), ['Cleared 100 OCMTs totaling $111,250 in the Defense Agencies Initiative (DAI).']);
  // Beside other work, still once: the word appears in one sentence, and no sentence lists actions.
  const mixed = narrate([...entries, ...WRITER_CORPUS], 'jepes', 2000);
  assert.equal(mixed.sentences.filter((s) => /OCMT/.test(s.text)).length, 1);
  assert.doesNotMatch(mixed.text, /across \d+ actions/);
  assert.deepEqual(checkNarrative(mixed, [...entries, ...WRITER_CORPUS], 'jepes'), []);
  // Leaving the total out leaves the work out; keeping one entry keeps the total.
  const key = mixed.sentences.find((s) => /OCMT/.test(s.text))!.key;
  assert.doesNotMatch(writeNarrative(onTrack([...entries, ...WRITER_CORPUS], JEPES), { ...JEPES, limit: 2000, format: 'bullets', exclude: [key] }).text, /OCMT/);
  const kept = writeNarrative(onTrack([...entries, ...WRITER_CORPUS], JEPES), { ...JEPES, limit: 300, format: 'bullets', pin: ['ocmt3'] });
  assert.ok(kept.sentences.some((s) => s.key === key && s.pinned));
});

const PINNED = [...BULLET_EXAMPLES.map((x, i) => ({ ...x.entry, id: `x${i}` })), ...EDGE_CASES.map((x, i) => ({ ...x.entry, id: `e${i}` }))];

test('the four outputs agree: package, record bullet, résumé and badge read each of the 81 entries the same way', () => {
  assert.equal(PINNED.length, 81);
  for (const e of PINNED) {
    for (const track of ['jepes', 'fitrep'] as const) {
      const cfg = track === 'fitrep' ? FITREP : JEPES;
      const record = composeBullet(e, { style: track });
      const coach = coachEntry(e, track);
      assert.equal(coach.bullet, record, `${e.title} (${track}): coach`);
      const pkg = writePackage([e], { form: track, areas: cfg.areas, names: cfg.names });
      const bullet = pkg.flatMap((g) => g.bullets)[0];
      const held = pkg.flatMap((g) => g.held)[0];
      // A held entry is listed with its reason, in the words its record shows.
      if (coach.held) assert.equal(held?.text, record, `${e.title} (${track}): held`);
      else {
        assert.equal(bullet?.text, record, `${e.title} (${track}): package`);
        assert.equal(bullet.strength, coach.strength.points, `${e.title} (${track}): package strength`);
      }
      assert.equal(strength(e, track), coach.strength.points, `${e.title} (${track}): badge`);
      // The narrative's sentence for it, written or left out, is the same sentence.
      const n = narrate([e], track);
      const said = [...n.sentences, ...n.left].find((s) => s.covers.includes(e.id)) ?? n.held.find((h) => h.key === e.id);
      assert.equal(said?.text, record, `${e.title} (${track}): narrative`);
    }
    const resume = composeBullet(e, { style: 'resume' });
    assert.equal(resume, resumeFor(e));
    assert.equal(resume, coachEntry(e).resume);
    const one = writePackage([e], { form: 'resume', areas: JEPES.areas, names: JEPES.names });
    const text = one.flatMap((g) => g.bullets)[0]?.text;
    if (text) assert.equal(text, resume, `${e.title}: résumé package`);
    // The résumé is the JEPES sentence, spelled out: it never says what the record does not.
    assert.equal(resume, plain(spellOut([composeBullet(e)])[0]), e.title ?? '');
  }
});

test('held entries agree: the package lists what the narrative holds, with the same reason', () => {
  const entries = [...WRITER_CORPUS, ...DEMO_ENTRIES, { ...REPEATS[0].a, id: 'twice1' }, { ...REPEATS[0].b, id: 'twice2' }, { id: 'annual', title: 'Completed annual cyber awareness training', eval_area: M }];
  for (const track of ['jepes', 'fitrep'] as const) {
    const cfg = track === 'fitrep' ? FITREP : JEPES;
    const n = narrate(entries, track);
    const pkg = writePackage(entries, { form: track, areas: cfg.areas, names: cfg.names, limitPerArea: Infinity });
    const fromPackage = pkg.flatMap((g) => g.held.map((h) => [h.key, h.reason])).sort();
    assert.deepEqual(fromPackage, n.held.map((h) => [h.key, h.reason]).sort(), track);
    assert.ok(fromPackage.some(([k]) => k === 'twice2') && fromPackage.some(([k]) => k === 'annual'), track);
    // Nothing held is bulleted, and every other entry is in exactly one bullet.
    const bulleted = pkg.flatMap((g) => g.bullets.flatMap((b) => b.sources));
    assert.equal(new Set(bulleted).size, bulleted.length, `${track}: an entry in two bullets`);
    const held = new Set(n.held.map((h) => h.key));
    assert.deepEqual([...bulleted].sort(), entries.map((e) => e.id).filter((id) => !held.has(id)).sort(), track);
  }
});

test('the package caps each area and says what the cap leaves out once, after the bullets', () => {
  const entries = [...ocmtEntries(), ...WRITER_CORPUS];
  const pkg = writePackage(entries, { areas: JEPES.areas, names: JEPES.names, limitPerArea: 2 });
  const mission = pkg.find((g) => g.area === M)!;
  assert.equal(mission.bullets.length, 2);
  assert.ok(mission.withheld >= 2);
  assert.ok(mission.rollup && !/across \d+ logged/.test(mission.rollup), mission.rollup ?? '');
  // The rollup claims no figure a bullet already states.
  for (const b of mission.bullets) for (const fig of b.text.match(/\$[\d,]+/g) || []) assert.ok(!mission.rollup!.includes(fig), `${fig} twice`);
  const text = B.packageToText(pkg, 'Test');
  assert.ok(text.indexOf(mission.bullets[1].text) < text.indexOf(mission.rollup!), 'the rollup follows the bullets');
  // Untagged work is listed apart, as before.
  const untagged = writePackage([{ id: 'u', title: 'Reconciled 4 ULOs' }], { areas: JEPES.areas });
  assert.equal(untagged.find((g) => g.area === 'Unassigned')?.count, 1);
  // A cap of none lists no bullet, and says the area's work in the rollup.
  const none = writePackage(entries, { areas: JEPES.areas, names: JEPES.names, limitPerArea: 0 }).find((g) => g.area === M)!;
  assert.equal(none.bullets.length, 0);
  assert.ok(none.withheld > 0 && none.rollup, 'a rollup for what the cap left out');
});

test('entries with no id and the same title are two entries, in the narrative and the package alike', () => {
  const entries: EntryInput[] = [
    { title: 'Reconciled ULOs', quantity: 5, unit_label: 'ULOs', result: 'all cleared', eval_area: M },
    { title: 'Reconciled ULOs', quantity: 7, unit_label: 'rejects', eval_area: M },
  ];
  const n = narrate(entries);
  assert.match(n.text, /5 ULOs/);
  assert.match(n.text, /7 rejects/);
  const pkg = writePackage(entries, { areas: JEPES.areas, names: JEPES.names, limitPerArea: Infinity }).find((g) => g.area === M)!;
  assert.equal(pkg.bullets.length, 2);
});

test('the badge: five points, and its maximum and tooltip are what it counts', () => {
  assert.equal(STRENGTH_MAX, 5);
  assert.equal(STRENGTH_POINTS.length, STRENGTH_MAX);
  for (const p of STRENGTH_POINTS) assert.ok(STRENGTH_TOOLTIP.toLowerCase().includes(p.label.toLowerCase().replace(/^opens/, 'it opens')), p.label);
  assert.match(STRENGTH_TOOLTIP, /five things, one point each/);
  const full: EntryInput = { title: 'Reconciled 14 ULOs in DAI', quantity: 14, unit_label: 'ULOs', result: 'all cleared on the next report', eval_area: M };
  assert.deepEqual(coachEntry(full).strength, { points: 5, of: 5, met: ['opens', 'number', 'outcome', 'measured', 'area'], missing: [] });
  // Each point on its own.
  const without = (over: Partial<EntryInput>) => coachEntry({ ...full, ...over }).strength.missing;
  assert.deepEqual(without({ title: 'Helped reconcile 14 ULOs in DAI' }), ['opens']);
  assert.deepEqual(without({ title: 'Reconciled ULOs in DAI', quantity: null, result: 'all cleared' }), ['number']);
  assert.deepEqual(without({ result: null }), ['outcome', 'measured']);
  assert.deepEqual(without({ result: 'approved by the CO on 12 March' }), ['measured']);
  assert.deepEqual(without({ eval_area: null }), ['area']);
  assert.deepEqual(without({ eval_area: 'Unassigned' }), ['area']);
  // A Sgt's JEPES-named area is tagged on FITREP too.
  assert.equal(coachEntry(full, 'fitrep').strength.points, 5);
  // Dollars alone are one point at most (they once counted two of a four that was shown as five).
  assert.equal(strength({ title: 'Payroll', dollar_amount: 5_000_000 }), 1);
  // Across the fixed examples, tagged, the badge reaches its maximum and never passes it.
  const points = PINNED.map((e) => strength({ ...e, eval_area: M }));
  assert.ok(points.every((p) => p >= 1 && p <= STRENGTH_MAX));
  assert.ok(points.includes(STRENGTH_MAX), String(Math.max(...points)));
  assert.equal(strength({ title: 'Served as the S-4 chief' }), 0);
});

test('one glossary: the writer is the only expansion table, and the Reference glossary agrees with it', () => {
  assert.ok(!('expandAcronyms' in B) && !('ACRONYM_GLOSS' in B), 'the old résumé glossary is gone');
  const dash = (s: string) => s.replace(/[\u2013\u2014]/g, '-').toLowerCase();
  let compared = 0;
  for (const t of REFERENCE) {
    const terms = t.term.split(' / ');
    const meanings = t.meaning.split(/[:.]/)[0].split(' / ');
    terms.forEach((term, i) => {
      const ours = GLOSSARY[term];
      if (!ours || terms.length !== meanings.length) return;
      compared += 1;
      assert.ok(dash(meanings[i]).startsWith(dash(ours.one)), `${term}: "${meanings[i]}" against "${ours.one}"`);
    });
  }
  assert.ok(compared >= 6, `${compared} terms compared`);
  // LOA is a Line of Accounting in finance and a Letter of Appreciation in awards: never spelled out as either.
  assert.equal(GLOSSARY.LOA, undefined);
  assert.equal(composeBullet({ title: 'Corrected 12 LOAs in DTS', quantity: 12, unit_label: 'LOAs' }, { style: 'resume' }), 'Corrected 12 LOAs in the Defense Travel System (DTS).');
});

test('an edited narrative knows when the record changed under it', () => {
  const entries = [{ id: 'a', title: 'Reconciled 14 ULOs', quantity: 14 }, { id: 'b', title: 'Cleared 8 OCMTs' }];
  const casework = { researched: 3, verified: 1, resolved: 0, procedures: ['OCMT'] };
  const was = basisOf(entries, casework);
  assert.deepEqual(driftOf(was, entries, casework), { changed: [], added: [], removed: 0, casework: false, any: false });
  // Spacing typed differently is no change.
  assert.equal(driftOf(was, [{ ...entries[0], title: 'Reconciled  14 ULOs ' }, entries[1]], casework).any, false);
  const now = [{ ...entries[0], result: 'all cleared' }, { id: 'c', title: 'Processed 4 MIPRs' }];
  assert.deepEqual(driftOf(was, now, { ...casework, verified: 2 }), { changed: ['a'], added: ['c'], removed: 1, casework: true, any: true });
  // Hashes only: the browser keeps no second copy of the record.
  assert.ok(Object.values(was.entries).every((h) => /^[0-9a-f]{8}$/.test(h)));
  assert.ok(!JSON.stringify(was).includes('ULOs'));
  // The procedures in another order read differently in the narrative (it names the first three), so that is a change.
  const two = { ...casework, procedures: ['OCMT', 'ULO'] };
  assert.equal(driftOf(basisOf(entries, two), entries, { ...two, procedures: ['ULO', 'OCMT'] }).casework, true);
  // An id is only an id: one named like an object's own property is added like any other.
  assert.deepEqual(driftOf(was, [...entries, { id: 'constructor', title: 'Processed 4 MIPRs' }], casework).added, ['constructor']);
});

const two = (a: EntryInput, b: EntryInput): EntryInput[] => [{ id: 'g1', eval_area: M, date: '2026-03-01', ...a }, { id: 'g2', eval_area: M, date: '2026-05-01', ...b }];
const totalOf = (entries: EntryInput[]) => {
  const text = narrate(entries).text.split('\n').filter((l) => l.startsWith('-')).map((l) => l.slice(1));
  const pkg = writePackage(entries, { areas: JEPES.areas, names: JEPES.names, limitPerArea: Infinity }).flatMap((g) => g.bullets.map((b) => b.text));
  assert.deepEqual(pkg, text, 'the package says what the narrative says');
  return text;
};

test('a total keeps the words every entry shares only as a whole phrase, and never one entry\'s own figures', () => {
  assert.deepEqual(totalOf(two({ title: 'Processed 22 vouchers within 3 days', quantity: 22, unit_label: 'vouchers' }, { title: 'Processed 14 vouchers within 5 days', quantity: 14, unit_label: 'vouchers' })), ['Processed 36 vouchers.']);
  assert.deepEqual(totalOf(two({ title: 'Inspected 12 vehicles before the deployment', quantity: 12, unit_label: 'vehicles' }, { title: 'Inspected 8 vehicles before the inspection', quantity: 8, unit_label: 'vehicles' })), ['Inspected 20 vehicles.']);
  assert.deepEqual(totalOf(two({ title: 'Processed 22 MIPRs for the G-8', quantity: 22, unit_label: 'MIPRs' }, { title: 'Processed 14 MIPRs for the G-8', quantity: 14, unit_label: 'MIPRs' })), ['Processed 36 MIPRs for the G-8.']);
  // A title's own dollars are its own: the total states the sum once.
  assert.deepEqual(totalOf(two(
    { title: 'Reconciled 14 ULOs totaling $5,000 in DAI', quantity: 14, unit_label: 'ULOs', dollar_amount: 5000, dollar_type: 'reconciled' },
    { title: 'Reconciled 22 ULOs totaling $5,000 in DAI', quantity: 22, unit_label: 'ULOs', dollar_amount: 5000, dollar_type: 'reconciled' },
  )), ['Reconciled 36 ULOs totaling $10,000.']);
});

test('dollars only some entries carry are said of those entries', () => {
  const paid = { title: 'Reconciled 14 ULOs', quantity: 14, unit_label: 'ULOs', dollar_amount: 48_250, dollar_type: 'reconciled' };
  const unpaid = { title: 'Reconciled 10 ULOs', quantity: 10, unit_label: 'ULOs' };
  assert.deepEqual(totalOf(two(paid, unpaid)), ['Reconciled 24 ULOs, 14 of them totaling $48,250.']);
  // The entry with the outcome is the one with the dollars: one "including" says both.
  assert.deepEqual(totalOf(two({ ...paid, result: 'all cleared' }, unpaid)), ['Reconciled 24 ULOs, including 14 totaling $48,250: all cleared.']);
  // An outcome every entry states is true of all of them, so the paid part is set apart before it.
  assert.deepEqual(totalOf(two({ ...paid, result: 'cutting the backlog to zero' }, { ...unpaid, result: 'cutting the backlog to zero' })), ['Reconciled 24 ULOs (14 of them totaling $48,250), cutting the backlog to zero.']);
  // An outcome only an unpaid entry states is said of the rest, never of the 14 with the dollars.
  assert.deepEqual(totalOf(two(paid, { ...unpaid, quantity: 14, title: 'Reconciled 14 ULOs in GFEBS', result: 'all cleared on the next report' })), ['Reconciled 28 ULOs (14 of them totaling $48,250), including 14 of the rest: all cleared on the next report.']);
});

test('a figure the outcome already states is said once', () => {
  const paid = { title: 'Reconciled 14 ULOs', quantity: 14, unit_label: 'ULOs', dollar_amount: 48_250, dollar_type: 'reconciled', result: 'cleared $48,250 in aged obligations' };
  const unpaid = { title: 'Reconciled 10 ULOs', quantity: 10, unit_label: 'ULOs', result: 'none returned' };
  assert.deepEqual(totalOf(two(paid, unpaid)), ['Reconciled 24 ULOs, including 14: cleared $48,250 in aged obligations.']);
  const fitrep = narrate(two(paid, unpaid), 'fitrep').text;
  assert.equal(fitrep.match(/\$48\.3K/g)?.length, 1, fitrep);
  const both = { title: 'Reconciled 12 ULOs', quantity: 12, unit_label: 'ULOs', dollar_amount: 48_250, dollar_type: 'reconciled', result: 'recovering $96,500' };
  assert.deepEqual(totalOf(two(both, { ...both, title: 'Reconciled 12 ULOs in DAI' })), ['Reconciled 24 ULOs, recovering $96,500.']);
});

test('a total stops where every entry ends a phrase, never mid-name or mid-list', () => {
  const pair = (a: string, b: string, n: [number, number] = [22, 14], unit = 'MIPRs') => totalOf(two({ title: a, quantity: n[0], unit_label: unit }, { title: b, quantity: n[1], unit_label: unit }));
  // A comma ends the shared words when the entry's own words follow it.
  assert.deepEqual(pair('Inspected 30 vehicles for the S-4, all passed', 'Inspected 12 vehicles for the S-4, 2 failed', [30, 12], 'vehicles'), ['Inspected 42 vehicles for the S-4.']);
  assert.deepEqual(pair('Processed 22 MIPRs for the G-8, ahead of schedule', 'Processed 14 MIPRs for the G-8, on time'), ['Processed 36 MIPRs for the G-8.']);
  // Not when a name goes on after it, and not before "of", "and" or "or".
  assert.deepEqual(pair('Processed 22 MIPRs for 1st Battalion, 6th Marines', 'Processed 14 MIPRs for 1st Battalion, 8th Marines'), ['Processed 36 MIPRs.']);
  assert.deepEqual(pair('Processed 22 MIPRs for the Department of the Navy', 'Processed 14 MIPRs for the Department of Defense'), ['Processed 36 MIPRs.']);
  assert.deepEqual(pair('Processed 22 MIPRs for the G-8 and G-4', 'Processed 14 MIPRs for the G-8'), ['Processed 36 MIPRs.']);
  assert.deepEqual(pair('Processed 22 MIPRs for the G-8 or G-4', 'Processed 14 MIPRs for the G-8'), ['Processed 36 MIPRs.']);
  // An "-ing" word or a bracket opens the entry's own words.
  assert.deepEqual(pair('Processed 22 MIPRs for the G-8 using GFEBS', 'Processed 14 MIPRs for the G-8 using DAI'), ['Processed 36 MIPRs for the G-8.']);
  assert.deepEqual(pair('Processed 22 MIPRs for the G-8 ($240K)', 'Processed 14 MIPRs for the G-8 ($120K)'), ['Processed 36 MIPRs for the G-8.']);
});

test('a score is an outcome; the title typed again is not', () => {
  for (const [title, result, unit] of [['Qualified 3 Marines for the range', '3 for 3', 'Marines'], ['Inspected 12 vehicles', '12 of 12', 'vehicles'], ['Inspected 12 vehicles', '12 / 12', 'vehicles']] as const) {
    const f = read({ title, result, quantity: Number(/\d+/.exec(title)![0]), unit_label: unit, eval_area: M });
    assert.equal(f.result, result, title);
    assert.equal(weigh(f).tier, 2, title);
  }
  assert.equal(read({ title: 'Processed 22 MIPRs for the G-8', result: '22 for the G-8', quantity: 22, unit_label: 'MIPRs', eval_area: M }).result, null);
});

test('a date and a count are read apart: no "No number" for a dated title with a counted outcome', () => {
  const issues = (e: EntryInput) => read({ eval_area: M, ...e }).issues.map((i) => i.code);
  assert.ok(!issues({ title: 'Ran rifle qualification on 12 June', result: '30 Marines qualified' }).includes('unmeasured'));
  assert.ok(!issues({ title: 'Processed the 12 SEP packages for the S-1', result: 'zero returned' }).includes('unmeasured'));
  assert.ok(issues({ title: 'Published the battalion SOP', result: 'completed in 2026 as planned' }).includes('unmeasured'));
});

test('the dashboard and the writer agree on what is an outcome', () => {
  for (const r of ['N/A!', 'TBD!', 'None!!', 'n/a \u{1F44D}', 'pending!', '\u2014', 'N/A']) {
    assert.equal(hasOutcome(r), false, r);
    assert.equal(read({ title: 'Reconciled 14 ULOs', result: r }).result, null, r);
  }
  for (const r of ['all cleared', '0', '100%', '3/3']) {
    assert.equal(hasOutcome(r), true, r);
    assert.ok(read({ title: 'Reconciled 14 ULOs', result: r }).result, r);
  }
});

test('a held entry\'s reason quotes the entry it repeats in plain characters, as the PDFs print', () => {
  const A = { id: 'h1', title: 'Trained 12 Marines → 1½ mile PFT prep for the G-8', quantity: 12, unit_label: 'Marines', eval_area: 'Leadership', date: '2026-09-02' };
  const n = narrate([A, { ...A, id: 'h2', date: '2026-09-03' }]);
  assert.equal(n.held.length, 1);
  assert.match(n.held[0].reason, /“Trained 12 Marines 1 1\/2 mile PFT prep for the G-8”/);
  assert.ok(/^[\x20-\x7e“”]*$/.test(n.held[0].reason), n.held[0].reason);
});

test('what the package holds follows the report\'s track, whatever the bullet style', () => {
  const entries: EntryInput[] = [
    { id: 'v', title: 'Volunteered 6 hours at the base shelter', category: 'Volunteer Service', eval_area: 'Leadership' },
    { id: 'a', title: 'Completed annual cyber awareness training', eval_area: 'Leadership' },
    { id: 'l', title: 'Led 12 Marines through range qualification', quantity: 12, unit_label: 'Marines', result: 'all qualified', eval_area: 'Leadership' },
  ];
  for (const track of ['jepes', 'fitrep'] as const) {
    const cfg = track === 'fitrep' ? FITREP : JEPES;
    const want = writePackage(entries, { form: track, track, areas: cfg.areas, names: cfg.names, limitPerArea: Infinity }).flatMap((g) => g.held.map((h) => [h.key, h.reason]));
    for (const form of ['jepes', 'fitrep', 'resume'] as const) {
      const got = B.buildPackage(entries as never, { style: form, track, areas: cfg.areas, names: cfg.names, limitPerArea: Infinity }).flatMap((g) => g.held.map((h) => [h.key, h.reason]));
      assert.deepEqual(got, want, `${track} report, ${form} style`);
    }
    // JEPES has no worksheet to send community work to, and FITREP does not cite the JEPES order.
    if (track === 'jepes') assert.ok(!want.some(([k]) => k === 'v'), 'a JEPES report bullets community work');
    else assert.ok(want.some(([k]) => k === 'v') && !want.some(([, r]) => /MCO 1616\.1/.test(r)), 'a FITREP report lists it on the worksheet');
  }
});

test('the same record holds the same copies whatever order it comes in, and says why truly', () => {
  const A = { id: 'A', title: 'Processed 22 MIPRs for the G-8', quantity: 22, unit_label: 'MIPRs', eval_area: M, date: '2026-09-02' };
  const Bx = { id: 'B', title: 'Processed 22 MIPRs', quantity: 22, unit_label: 'MIPRs', result: 'zero returned for correction', eval_area: M, date: '2026-09-02' };
  const C = { id: 'C', title: 'Processed 22 MIPRs for the G-4', quantity: 22, unit_label: 'MIPRs', eval_area: M, date: '2026-09-02' };
  const orders = [[A, Bx, C], [A, C, Bx], [Bx, A, C], [Bx, C, A], [C, A, Bx], [C, Bx, A]];
  const texts = new Set(orders.map((o) => narrate(o).text));
  assert.equal(texts.size, 1, [...texts].join('\n---\n'));
  // The G-8 and the G-4 are two pieces of work: a bare copy that looks like both does not tie them together.
  assert.match([...texts][0], /Processed 44 MIPRs/);
  // Undated copies: nothing says when they were logged, so the reason does not either.
  const undated = narrate([{ ...A, id: 'u1', date: null }, { ...A, id: 'u2', date: null }]);
  assert.equal(undated.held.length, 1);
  assert.doesNotMatch(undated.held[0].reason, /day/);
  assert.match(undated.held[0].reason, /the same words and numbers/);
  // Copies with no figure are the same words, not "the same numbers".
  const words = narrate([{ id: 'w1', title: 'Briefed the CO on the spend plan', eval_area: M, date: '2026-09-02' }, { id: 'w2', title: 'Briefed the CO on the spend plan', eval_area: M, date: '2026-09-02' }]);
  assert.match(words.held[0].reason, /the same words as .*, the same day\./);
});

test('an outcome that says nothing, or only types the title again, is no outcome', () => {
  const base = { title: 'Reconciled 14 ULOs', quantity: 14, unit_label: 'ULOs', eval_area: M };
  for (const result of ['\u2014', '\u2026', '- -', 'n.a.', 'N/A', '\u2192', 'Reconciled 14 ULOs']) {
    const f = read({ ...base, result });
    assert.equal(f.result, null, result);
    assert.equal(weigh(f).tier, 0, result);
    assert.equal(composeBullet({ ...base, result }), 'Reconciled 14 ULOs.', result);
  }
  // Something new about the same Marines is an outcome.
  assert.equal(read({ title: 'Trained 12 Marines on rifle qualification', quantity: 12, unit_label: 'Marines', result: '12 Marines qualified', eval_area: 'Leadership' }).result, '12 Marines qualified');
});

test('plain characters keep a fraction\'s value, and a title they cannot carry is no title', () => {
  assert.equal(composeBullet({ title: 'Ran the 1\u00bd mile course', eval_area: M }), 'Ran the 1 1/2 mile course.');
  assert.equal(composeBullet({ title: 'Cut DTS voucher wait time by \u00bd', eval_area: M }), 'Cut DTS voucher wait time by 1/2.');
  for (const title of ['\u6574\u7406\u4e86\u6587\u4ef6', '\u00a7\u00a7']) assert.equal(composeBullet({ title, eval_area: M }), 'Completed logged work.', title);
});

test('the package says how many entries the cap leaves unsaid, so none is lost', () => {
  const entries: EntryInput[] = [
    { id: 'p1', title: 'Cut MIPR processing time from 9 days to 2', result: 'every MIPR on time', eval_area: M },
    { id: 'p2', title: 'Reconciled 14 ULOs', quantity: 14, unit_label: 'ULOs', eval_area: M },
    { id: 'p3', title: 'Cleared 9 UMTs', quantity: 9, unit_label: 'UMTs', eval_area: M },
    { id: 'p4', title: 'Rewrote the turnover binder', result: 'new clerks trained from it', eval_area: M },
    { id: 'p5', title: 'Drafted the unit SOP', eval_area: M },
  ];
  const g = writePackage(entries, { areas: JEPES.areas, names: JEPES.names, limitPerArea: 1 }).find((x) => x.area === M)!;
  assert.equal(g.bullets.length, 1);
  assert.ok(g.rollup, 'the counted work is said in the rollup');
  // The two with no figure to add up are counted after it.
  assert.equal(g.unlisted, 2);
  const text = B.packageToText([g]);
  assert.match(text, /\.\.\.and 2 more entries not shown at the current limit\./);
  assert.equal(B.notShown({ rollup: null, withheld: 3, unlisted: 3 }), '...and 3 further entries not shown at the current limit.');
  // Entries with no id are counted by the rollup the same way.
  const noIds = writePackage(entries.map(({ id: _id, ...e }) => e), { areas: JEPES.areas, names: JEPES.names, limitPerArea: 1 }).find((x) => x.area === M)!;
  assert.equal(noIds.unlisted, 2);
});
