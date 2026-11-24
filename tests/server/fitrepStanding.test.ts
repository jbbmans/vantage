import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { canonical } from '../../shared/versioned.ts';
import { FITREP_ATTRIBUTES, FITREP_METHOD, OCCASIONS } from '../../shared/fitrepMethod.ts';
import { averageOfMarks, fig, methodOn, profileKey, project, relativeValue, round2, standingOf, summarize, thirdOf } from '../../shared/fitrepStanding.ts';
import { fitrepEvidence, inPeriod, recommendFitrep } from '../../shared/evaluation.ts';
import { fitnessReportSchema } from '../../shared/schemas.ts';
import { buildPersonalExport, buildPersonalExportWorkbook, buildPersonalExportZip } from '../../server/services/personalExport.ts';
import { readWorkbook } from '../../server/lib/workbook.ts';
import { listZip } from '../../server/lib/zip.ts';
import { startApp, enroll, type TestApp } from './helpers.ts';

/**
 * FITREP standing (ADR-0047): the Fitness Report Average, the reporting senior's profile and the Relative Value, by the
 * method in shared/fitrepMethod.ts, each rule from the source the version cites. The worked examples are the sources'
 * own: MMOA-4's average of marks summing to 43 over 13 observed, and the Master Brief Sheet row CNA publishes.
 */

const method = FITREP_METHOD.versions[0].data;

/** Each released version as it was released. Changing one is refused here: a change is a new version, never an edit. */
const RELEASED: Record<string, string> = {
  'pes-mco-1610.7b': '2224e816f7f55bd878c6ce6059506bd133496c37e59719e3117f228e39b98f0a',
};

test('the method keeps the fingerprint it was released with, frozen and cited', () => {
  for (const v of FITREP_METHOD.versions) {
    const fingerprint = createHash('sha256').update(canonical(v)).digest('hex');
    assert.ok(RELEASED[v.id], `${v.id} is new: record its fingerprint here once its rules are checked against ${v.cites.map((c) => c.source).join(' and ')}`);
    assert.equal(fingerprint, RELEASED[v.id], `${v.id} was edited. A released version is never changed: add a new version with its own effective date and source.`);
    assert.ok(Object.isFrozen(v) && Object.isFrozen(v.data) && Object.isFrozen(v.data.thirds), `${v.id} is frozen`);
    assert.ok(v.cites.length >= 3 && v.cites.every((c) => c.url.startsWith('https://')), `${v.id} cites where each rule is published`);
    assert.ok(v.cites.some((c) => c.source.startsWith('MCO 1610.7')), 'the order is cited');
  }
  assert.deepEqual(FITREP_METHOD.versions.map((v) => v.id).sort(), Object.keys(RELEASED).sort(), 'a released version is never removed either');
  assert.throws(() => { (method.scale as { high: number }).high = 99; }, TypeError, 'a released rule cannot be changed at run time');
  assert.equal(methodOn('2026-11-24').id, 'pes-mco-1610.7b');
  assert.equal(FITREP_ATTRIBUTES.length, method.attributes);
  assert.equal(OCCASIONS.length, 12);
});

test('the report average is the mean of the observed marks, A as 1 to G as 7, with H in neither the sum nor the count', () => {
  // MMOA-4, "Calculating the FitRep Average": marks summing to 43 over 13 observed attributes average 3.31.
  assert.deepEqual(averageOfMarks('EDCCCDCCDCBCCH', method), { value: 3.31, sum: 43, observed: 13, source: 'marks' });
  assert.deepEqual(averageOfMarks('BBBBBBBBBBBBBB', method), { value: 2, sum: 28, observed: 14, source: 'marks' });
  assert.equal(averageOfMarks('gggggggggggggg', method)?.value, 7, 'read in any case');
  assert.equal(averageOfMarks('HHHHHHHHHHHHHH', method), null, 'nothing observed has no average');
  assert.equal(averageOfMarks('DDDDDDDDDDDDDZ', method), null, 'a mark that is not A to H is not guessed');
  assert.equal(averageOfMarks('', method), null);
  // The marks entered win over a printed average that disagrees, and the difference is said.
  const s = standingOf({ marks: 'EDCCCDCCDCBCCH', rpt_avg: 3.4, occasion: 'AN', rs_avg: 3.2, rs_high: 3.6, reports_cumulative: 8 }, method);
  assert.equal(s.average?.value, 3.31);
  assert.match(s.notes.join(' '), /marks average 3\.31; the RPT Avg entered is 3\.40/);
});

test('the relative value: the RS High is 100, the RS Avg 90, raised to 80, and it matches the Master Brief Sheet CNA publishes', () => {
  // CNA 2024, Figure 1: RPT Avg 2.50, RS Avg 2.99, RS High 5.00, Cum RV 87.56.
  const cna = relativeValue(2.5, 2.99, 5, method)!;
  assert.equal(cna.value, 87.56);
  assert.equal(cna.arithmetic, '90 − 10 × 0.49 ÷ 2.01 = 87.56');
  const row = standingOf({ occasion: 'AN', grade: 'O-3', rpt_avg: 2.5, rs_avg: 2.99, rs_high: 5, reports_at_processing: 5, reports_cumulative: 10, cum_rv_printed: 87.56 }, method);
  assert.equal(row.rv?.value, 87.56);
  assert.equal(row.third, 'middle');
  assert.equal(row.check, null, 'the working agrees with the MBS');
  assert.equal(row.average?.source, 'printed');

  assert.equal(relativeValue(3.6, 3.2, 3.6, method)!.value, 100, 'the RS High is 100');
  assert.equal(relativeValue(3.2, 3.2, 3.6, method)!.value, 90, 'the RS Avg is 90');
  assert.equal(relativeValue(2.8, 3.2, 3.6, method)!.value, 80, 'as far under the average as the high is over it is 80');
  const raised = relativeValue(3.15, 3.23, 3.3, method)!;
  assert.equal(raised.value, 80);
  assert.ok(raised.raised);
  assert.match(raised.arithmetic, /= 78\.57, raised to 80$/);
  const same = relativeValue(3.4, 3.4, 3.4, method)!;
  assert.deepEqual([same.value, same.allSame], [90, true], 'a profile whose reports share one average values each at 90');
  // With the RS High at the RS Avg, a report above both is above the high; one below them gives no line to read.
  const over = relativeValue(3.9, 3.5, 3.5, method)!;
  assert.deepEqual([over.value, over.capped, over.allSame], [100, true, false]);
  assert.equal(over.arithmetic, '3.90 is above the RS High (3.50), so 100');
  assert.equal(relativeValue(3.49, 3.5, 3.5, method), null, 'the printed figures are rounded, so the spread is too small to show');
  assert.equal(relativeValue(3.4, 3.6, 3.5, method), null, 'an RS High below the RS Avg is no profile');
  const flat = standingOf({ occasion: 'AN', rpt_avg: 3.49, rs_avg: 3.5, rs_high: 3.5, reports_cumulative: 6 }, method);
  assert.equal(flat.rv, null);
  assert.match(flat.reason ?? '', /both 3\.50 and this report’s average is below them\. The MBS rounds both/);
  assert.ok(flat.position, 'its place is still shown');
  const flatOver = standingOf({ occasion: 'AN', rpt_avg: 3.9, rs_avg: 3.5, rs_high: 3.5, reports_cumulative: 6 }, method);
  assert.equal(flatOver.rv?.value, 100);
  assert.match(flatOver.notes.join(' '), /above the RS High entered/);
  const above = standingOf({ occasion: 'AN', rpt_avg: 3.9, rs_avg: 3.2, rs_high: 3.6, reports_cumulative: 6 }, method);
  assert.equal(above.rv?.value, 100);
  assert.match(above.notes.join(' '), /above the RS High entered/, 'a report above its profile’s high is flagged, not hidden');
  // A figure off the MBS that the working does not reach is said, and the MBS stays the record.
  const off = standingOf({ occasion: 'AN', rpt_avg: 2.5, rs_avg: 2.99, rs_high: 5, reports_cumulative: 10, cum_rv_printed: 88.1 }, method);
  assert.match(off.check ?? '', /Your MBS prints 88\.10; these figures work to 87\.56\. The MBS is the record/);
  // One hundredth either side is the last place, the same both ways; two is a different figure.
  const printedAs = (cum: number) => standingOf({ occasion: 'AN', rpt_avg: 2.5, rs_avg: 2.99, rs_high: 5, reports_cumulative: 10, cum_rv_printed: cum }, method).check;
  assert.deepEqual([87.55, 87.56, 87.57].map(printedAs), [null, null, null]);
  assert.ok(printedAs(87.54) && printedAs(87.58), 'two hundredths off is said');
});

test('the thirds are read from the value at two places, at 86.66 and 86.67, 93.33 and 93.34', () => {
  assert.deepEqual([80, 86.66, 86.67, 93.33, 93.34, 100].map((v) => thirdOf(v, method)), ['lower', 'lower', 'middle', 'middle', 'upper', 'upper']);
  assert.equal(thirdOf(86.665, method), 'middle', 'worked to two places first');
  assert.equal(round2(1.005), 1.01, 'a hair of float error never rounds down');
  assert.equal(fig(3), '3.00');
});

test('no relative value under the minimum profile, or for an EN, not observed, extended or academic report', () => {
  const base = { occasion: 'AN', grade: 'E-6', marks: 'DDCDCDCCDCCDCH', rs_avg: 3.3, rs_high: 3.85 };
  const two = standingOf({ ...base, reports_cumulative: 2 }, method);
  assert.equal(two.rv, null);
  assert.equal(two.third, null);
  assert.match(two.reason ?? '', /holds 2 reports on the grade\. A report has a relative value once the RS has written 3/);
  assert.ok(two.position, 'its place against the RS Avg and High is still shown');
  assert.equal(standingOf({ ...base, reports_cumulative: 3 }, method).rv?.value, 92.91, 'three is enough');
  for (const [over, why] of [[{ occasion: 'EN' }, /end of service \(EN\)/], [{ report_type: 'not_observed' }, /not-observed/], [{ report_type: 'extended' }, /extended/], [{ report_type: 'academic' }, /academic/]] as const) {
    const s = standingOf({ ...base, reports_cumulative: 20, ...over }, method);
    assert.equal(s.rv, null);
    assert.match(s.reason ?? '', why);
  }
  // The value at processing is the one printed, never worked again; under the minimum then, it has none.
  const printed = standingOf({ ...base, reports_at_processing: 6, reports_cumulative: 11, rv_at_processing: 93.64 }, method);
  assert.deepEqual(printed.atProcessing, { value: 93.64, reason: null });
  const early = standingOf({ ...base, reports_at_processing: 2, reports_cumulative: 4, rv_at_processing: 95 }, method);
  assert.equal(early.atProcessing.value, null);
  assert.match(early.atProcessing.reason ?? '', /holds 2 reports/);
  // With the count at processing left blank, a profile under the minimum now was under it then too.
  const unsaid = standingOf({ ...base, reports_cumulative: 2, rv_at_processing: 95 }, method);
  assert.equal(unsaid.atProcessing.value, null);
  assert.match(unsaid.atProcessing.reason ?? '', /holds 2 reports/);
  // What is missing is said, never guessed.
  assert.match(standingOf({ occasion: 'AN', rs_avg: 3, rs_high: 3.5, reports_cumulative: 9 }, method).reason ?? '', /Enter the marks, or the RPT Avg/);
  assert.match(standingOf({ ...base }, method).reason ?? '', /how many reports the RS profile holds now/);
  assert.match(standingOf({ occasion: 'AN', marks: base.marks }, method).reason ?? '', /RS Avg and RS High/);
  assert.deepEqual(summarize([printed, two, standingOf({ ...base, reports_cumulative: 3 }, method)]).counts, { upper: 0, middle: 2, lower: 0, none: 1 });
});

test('the coming report counts in its own profile, and each target average gives back the value it names', () => {
  // Two reports on the grade: the coming one makes three, so it has a value; with one, it does not.
  const p = project({ rsAvg: 3.41, rsHigh: 3.79, reports: 2, fra: 3.6 }, method);
  assert.deepEqual(p.profile.after, { avg: 3.47, high: 3.79, reports: 3 });
  assert.equal(p.rv?.value, 94.06);
  assert.equal(p.third, 'upper');
  assert.match(project({ rsAvg: 3.41, rsHigh: 3.79, reports: 1, fra: 3.6 }, method).reason ?? '', /will have written 2 on the grade/);
  // A report above the high becomes the high, so it is valued 100.
  assert.equal(project({ rsAvg: 3.41, rsHigh: 3.79, reports: 9, fra: 3.9 }, method).rv?.value, 100);
  for (const reports of [2, 5, 30]) {
    const q = project({ rsAvg: 3.3, rsHigh: 3.85, reports, observed: 13 }, method);
    for (const t of q.targets) {
      assert.ok(t.fra != null && t.total != null, `${t.key} is in reach`);
      const at = project({ rsAvg: 3.3, rsHigh: 3.85, reports, fra: t.total! / 13 }, method).rv!.value;
      const under = project({ rsAvg: 3.3, rsHigh: 3.85, reports, fra: (t.total! - 1) / 13 }, method).rv!.value;
      assert.ok(at >= t.rv, `${t.key} with ${reports}: ${t.total} over 13 reaches ${t.rv} (${at})`);
      assert.ok(under < t.rv, `${t.key} with ${reports}: one mark less does not (${under})`);
    }
  }
  // Marks set the average and the count of observed marks the targets use.
  const m = project({ rsAvg: 3.3, rsHigh: 3.85, reports: 6, marks: 'DDDDCDDCDDCDCH' }, method);
  assert.equal(m.fra, 3.69);
  assert.equal(m.observed, 13);
  assert.ok(m.targets.filter((t) => t.reach === 'reached').every((t) => m.rv!.value >= t.rv), 'reached means the coming report is valued there');
  assert.ok(project({ rsAvg: 3.3, rsHigh: 3.85, reports: 0 }, method).targets.every((t) => t.reach === 'no_value' && t.fra == null), 'a first report has no value yet, which no average changes');
  assert.ok(project({ rsAvg: 3.3, rsHigh: 3.85, reports: 2 }, method).targets.every((t) => t.reach === 'needs'), 'the third report has one');
  // Over the attributes observed: an average typed over 13 needs 46 for the upper third, not 49 over 14.
  const upper = (o?: number | null) => project({ rsAvg: 3.3, rsHigh: 3.85, reports: 10, fra: 3.4, observed: o }, method).targets.find((t) => t.key === 'upper')!;
  assert.deepEqual([upper(13).total, upper(13).fra], [46, 3.54]);
  assert.deepEqual([upper(null).total, upper(null).fra], [49, 3.5], 'fourteen unless one is not observed');
  for (const o of [0, 15, 2.5]) assert.equal(project({ rsAvg: 3.3, rsHigh: 3.85, reports: 10, observed: o }, method).observed, 14, `${o} is no count of attributes`);
  // The Marine's earlier report in the profile moves as the coming one is added.
  const earlier = project({ rsAvg: 3.41, rsHigh: 3.79, reports: 2, fra: 3.6, earlier: [{ id: 'a', occasion: 'AN', marks: 'DDCDCCDCDCCCCH' }] }, method).earlier;
  assert.deepEqual(earlier, [{ id: 'a', before: null, after: 87.19, beforeUnworked: false }]);
  // A profile that would print one figure for its RS Avg and RS High, with the coming report below it: said, not valued.
  const flat = project({ rsAvg: 3.5, rsHigh: 3.5, reports: 4, fra: 3.48 }, method);
  assert.deepEqual([flat.rv, flat.third, flat.profile.after], [null, null, { avg: 3.5, high: 3.5, reports: 5 }]);
  assert.match(flat.reason ?? '', /would read RS Avg 3\.50 and RS High 3\.50, and this report is below them/);
  // An earlier report a flat profile gives no line for now is told apart from one with no value.
  const unworked = project({ rsAvg: 3.5, rsHigh: 3.5, reports: 10, fra: 3.6, earlier: [{ id: 'b', occasion: 'AN', rpt_avg: 3.49 }] }, method).earlier;
  assert.deepEqual(unworked, [{ id: 'b', before: null, after: 87.78, beforeUnworked: true }]);
  assert.equal(profileKey({ rs_label: '  Maj   Okafor ', grade: 'E-6' }), profileKey({ rs_label: 'maj okafor', grade: 'E-6' }), 'one RS and one grade is one profile');
  assert.notEqual(profileKey({ rs_label: 'Maj Okafor', grade: 'E-6' }), profileKey({ rs_label: 'Maj Okafor', grade: 'E-7' }));
});

const STRONG_1 = { date: '2026-08-01', title: 'Mentored 3 Marines through Corporals Course DEP', eval_area: 'Leadership', quantity: 3, unit_label: 'Marines', result: 'All 3 graduated with averages above 90.' };
const STRONG_2 = { date: '2026-09-01', title: 'Trained 5 section Marines on DAI amendments', eval_area: 'Leadership', quantity: 5, unit_label: 'Marines', result: 'Rework fell from 9 to 2 amendments a month.' };
const WEAK = { date: '2026-09-10', title: 'Helped with the barracks move', eval_area: 'Leadership' };
const attr = (ev: ReturnType<typeof fitrepEvidence>, name: string) => ev.flatMap((s) => s.attributes).find((a) => a.attribute === name)!;

test('evidence strength grades each attribute by the writer’s strength points, for the coming report’s period only', () => {
  const window = { from: '2026-06-01', to: '2027-05-31' };
  const ev = fitrepEvidence([STRONG_1, STRONG_2, WEAK, { ...STRONG_1, date: '2025-01-01', title: 'Mentored 4 Marines through Sergeants Course' }] as never, window);
  const dev = attr(ev, 'Developing Subordinates');
  assert.deepEqual([dev.level, dev.entries, dev.strong], ['strong', 2, 2], 'two entries at 4 or 5 of 5; the one before the period counts for nothing');
  assert.equal(dev.best?.points, 5);
  const ens = attr(ev, 'Ensuring Well-Being of Subordinates');
  assert.equal(ens.level, 'thin');
  assert.equal(ens.reason, '1 entry, none yet at 4 of 5.');
  assert.deepEqual(ens.best?.missing.slice(0, 1), ['does not open with what you did'], 'what the strongest lacks, for the page to say');
  assert.equal(attr(ev, 'Courage').level, 'none');
  assert.equal(attr(fitrepEvidence([STRONG_1] as never, window), 'Developing Subordinates').level, 'some');
  const leadership = ev.find((s) => s.section === 'F')!;
  assert.equal(leadership.tagged, 3);
  assert.equal(leadership.counts.strong + leadership.counts.some + leadership.counts.thin + leadership.counts.none, leadership.attributes.length);
  // An award for an earlier period is not this period's evidence.
  const award = fitrepEvidence([{ date: '2026-08-02', title: "Awarded a NAM for last year's deployment", eval_area: 'Leadership' }] as never, window);
  assert.ok(award.every((s) => s.entries === 0));
  // The window: on or after its start, on or before its end, and an undated entry counts.
  assert.deepEqual(inPeriod([{ date: '2026-05-31' }, { date: '2026-06-01' }, { date: '2027-05-31' }, { date: '2027-06-01' }, { date: null }], window).map((a) => a.date), ['2026-06-01', '2027-05-31', null]);
  // Work begun before the period and still going, or running across its start, is in it (ADR-0018); work over before it is not.
  const spans = [{ date: '2026-03-01', ongoing: 1 }, { date: '2026-04-15', end_date: '2026-09-30' }, { date: '2026-03-01', end_date: '2026-05-31' }];
  assert.deepEqual(inPeriod(spans, window).map((a) => a.date), ['2026-03-01', '2026-04-15']);
  const going = fitrepEvidence([{ ...STRONG_1, date: '2026-03-01', ongoing: 1 }] as never, window);
  assert.equal(attr(going, 'Developing Subordinates').level, 'some', 'an ongoing mentorship begun before the period is its evidence');
  // A period end before the period's start says nothing about the end: entries from the start on count.
  assert.deepEqual(inPeriod([{ date: '2026-05-30' }, { date: '2026-07-01' }, { date: '2028-01-01' }], { from: '2026-06-01', to: '2026-05-31' }).map((a) => a.date), ['2026-07-01', '2028-01-01']);
  // The coaching reads the same evidence.
  const recs = recommendFitrep({}, { total: 3, withOutcome: 2 }, { evidence: ev, daysToEnd: 90 });
  assert.ok(recs.some((r) => r.id === 'thin-evidence' && /Ensuring Well-Being of Subordinates/.test(r.detail)));
});

test('the report body: marks read in any case, a blank is null, and the ranges and order of the figures hold', () => {
  const ok = fitnessReportSchema.parse({ period_from: '2025-06-01', period_to: '2026-05-31', occasion: 'AN', grade: 'E-6', marks: 'ddcdcdccdccdch', rs_avg: '3.30', rs_high: '3.85', rpt_avg: '', shared: true });
  assert.equal(ok.marks, 'DDCDCDCCDCCDCH');
  assert.equal(ok.rpt_avg, null);
  assert.equal(ok.report_type, 'observed');
  assert.equal(ok.shared, 1);
  const body = { period_from: '2025-06-01', period_to: '2026-05-31', occasion: 'AN', grade: 'E-6' };
  for (const bad of [{ marks: 'DDCD' }, { marks: 'DDCDCDCCDCCDCX' }, { period_to: '2025-05-31' }, { period_from: '2025-02-30' }, { grade: 'E-4' }, { occasion: 'ZZ' },
    { rs_avg: 3.9, rs_high: 3.8 }, { rv_at_processing: 79 }, { reports_at_processing: 9, reports_cumulative: 4 }, { reports_cumulative: 2.5 }]) {
    assert.throws(() => fitnessReportSchema.parse({ ...body, ...bad }), JSON.stringify(bad));
  }
});

/** Every file that holds code. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx|sql|mjs)$/.test(name) ? [path] : [];
  });
}

test('only the fitness report service reads or writes the table: nothing else lists, sorts or compares reports', () => {
  const root = join(import.meta.dirname, '..', '..');
  const reads = /\b(?:FROM|INTO|UPDATE|JOIN)\s+fitness_reports\b/i;
  const found = ['server', 'shared', 'src', 'scripts'].flatMap((d) => sources(join(root, d))).filter((f) => reads.test(readFileSync(f, 'utf8'))).map((f) => relative(root, f));
  assert.deepEqual(found, ['server/services/fitnessReports.ts']);
});

let app: TestApp;
let marine: { token: string; id: string };
let leader: { token: string; id: string };
let peer: { token: string; id: string };
let outsider: { token: string; id: string };

before(async () => {
  app = await startApp();
  const op = await app.setupOperator();
  marine = await app.register('ssgtfitrep', { rank_id: 'SSgt' });
  leader = await app.register('gysgtfitrep', { rank_id: 'GySgt' });
  peer = await app.register('sgtfitrep', { rank_id: 'Sgt' });
  outsider = await app.register('elsewherefitrep', { rank_id: 'SSgt' });
  await enroll(app, op.token, 'G8', marine.id);
  await enroll(app, op.token, 'G8', leader.id, 'snco');
  await enroll(app, op.token, 'G8', peer.id);
});
after(() => app?.close());

const REPORT = { period_from: '2025-06-01', period_to: '2026-05-31', occasion: 'AN', grade: 'E-6', rs_label: 'Capt Alvarez', marks: 'DDCDCDCCDCCDCH', rs_avg: 3.3, rs_high: 3.85, reports_at_processing: 6, reports_cumulative: 11, rv_at_processing: 93.64, cum_rv_printed: 92.91 };
const views = () => (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'view_fitness_reports' AND actor_id = ? AND subject_id = ?`).get(leader.id, marine.id) as { n: number }).n;

test('a Marine’s reports are theirs: only they add, correct and remove one, and only they read the ones they keep private', async () => {
  const made = await app.call('POST', '/api/me/fitness-reports', { token: marine.token, body: REPORT });
  assert.equal(made.status, 201);
  assert.equal(made.body.shared, 0, 'private until shared');
  assert.equal(made.body.version, 1);
  assert.equal(standingOf(made.body, method).rv?.value, 92.91, 'the page works what the server keeps');
  const second = await app.call('POST', '/api/me/fitness-reports', { token: marine.token, body: { ...REPORT, period_from: '2026-06-01', period_to: '2026-11-01', occasion: 'CH', rs_label: 'Maj Okafor', reports_at_processing: 2, reports_cumulative: 2, rv_at_processing: null, cum_rv_printed: null } });
  assert.equal(second.status, 201);

  const bad = await app.call('POST', '/api/me/fitness-reports', { token: marine.token, body: { ...REPORT, marks: 'DDCD', rs_high: 3.1 } });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.fieldErrors?.marks, 'the field is named');

  const mine = await app.call('GET', '/api/me/fitness-reports', { token: marine.token });
  assert.deepEqual(mine.body.reports.map((r: { period_to: string }) => r.period_to), ['2026-11-01', '2026-05-31'], 'newest period first');
  assert.deepEqual((await app.call('GET', '/api/me/fitness-reports', { token: peer.token })).body.reports, []);

  // Another Marine's report reads as no report at all.
  for (const [verb, path, body] of [['PUT', `/api/me/fitness-reports/${made.body.id}`, REPORT], ['DELETE', `/api/me/fitness-reports/${made.body.id}`, undefined]] as const) {
    assert.equal((await app.call(verb, path, { token: leader.token, body })).status, 404);
  }
  const stale = await app.call('PUT', `/api/me/fitness-reports/${made.body.id}`, { token: marine.token, body: { ...REPORT, version: 9 } });
  assert.equal(stale.status, 409);
  const unversioned = await app.call('PUT', `/api/me/fitness-reports/${made.body.id}`, { token: marine.token, body: { ...REPORT, cum_rv_printed: 80 } });
  assert.equal(unversioned.status, 400, 'a change names the version it changes');
  assert.ok(unversioned.body.fieldErrors?.version);
  const fixed = await app.call('PUT', `/api/me/fitness-reports/${made.body.id}`, { token: marine.token, body: { ...REPORT, cum_rv_printed: 92.9, version: 1 } });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.version, 2);
  assert.equal(fixed.body.cum_rv_printed, 92.9);
  // A field left out keeps what is stored; a null clears it; the checks across fields read the report as saved.
  const partial = await app.call('PUT', `/api/me/fitness-reports/${made.body.id}`, { token: marine.token, body: { cum_rv_printed: 92.91, version: 2 } });
  assert.equal(partial.status, 200);
  assert.deepEqual([partial.body.marks, partial.body.rs_avg, partial.body.rs_label, partial.body.shared, partial.body.cum_rv_printed, partial.body.version], [REPORT.marks, 3.3, 'Capt Alvarez', 0, 92.91, 3]);
  const cleared = await app.call('PUT', `/api/me/fitness-reports/${made.body.id}`, { token: marine.token, body: { rv_at_processing: null, version: 3 } });
  assert.deepEqual([cleared.body.rv_at_processing, cleared.body.rs_high], [null, 3.85]);
  const crossed = await app.call('PUT', `/api/me/fitness-reports/${made.body.id}`, { token: marine.token, body: { rs_high: 3.1, version: 4 } });
  assert.equal(crossed.status, 400, 'an RS High below the stored RS Avg is refused');
  assert.ok(crossed.body.fieldErrors?.rs_high);
  assert.equal((await app.call('PUT', `/api/me/fitness-reports/${made.body.id}`, { token: marine.token, body: { rv_at_processing: 93.64, version: 4 } })).body.version, 5);

  // Through the readiness route, the Marine reads all of theirs and nothing is logged as a view of someone else.
  const self = await app.call('GET', `/api/me/readiness/${marine.id}/fitness-reports`, { token: marine.token });
  assert.equal(self.status, 200);
  assert.equal(self.body.shared_only, false);
  assert.equal(self.body.reports.length, 2);
});

test('a leader who sees the Marine’s readiness reads only the reports shared, and each read is logged; no one else reads any', async () => {
  const before0 = views();
  const none = await app.call('GET', `/api/me/readiness/${marine.id}/fitness-reports`, { token: leader.token });
  assert.equal(none.status, 200);
  assert.deepEqual([none.body.reports, none.body.shared_only], [[], true], 'nothing shared, nothing shown');
  assert.equal(views(), before0 + 1);

  const [first] = (await app.call('GET', '/api/me/fitness-reports', { token: marine.token })).body.reports.filter((r: { rs_label: string }) => r.rs_label === 'Capt Alvarez');
  const shared = await app.call('PUT', `/api/me/fitness-reports/${first.id}`, { token: marine.token, body: { ...REPORT, ...Object.fromEntries(Object.entries(first).filter(([k]) => k in REPORT)), shared: true, version: first.version } });
  assert.equal(shared.status, 200);
  const read = await app.call('GET', `/api/me/readiness/${marine.id}/fitness-reports`, { token: leader.token });
  assert.deepEqual(read.body.reports.map((r: { id: string }) => r.id), [first.id], 'the shared one, and only it');
  const row = app.ctx.db.prepare(`SELECT detail, unit_id FROM audit_log WHERE action = 'view_fitness_reports' AND actor_id = ? AND subject_id = ? ORDER BY seq DESC LIMIT 1`).get(leader.id, marine.id) as { detail: string; unit_id: string };
  assert.deepEqual({ ...row }, { detail: '1 shared', unit_id: 'G8' });
  assert.equal(views(), before0 + 2);

  assert.equal((await app.call('GET', `/api/me/readiness/${marine.id}/fitness-reports`, { token: peer.token })).status, 403, 'a Marine beside them does not lead them');
  assert.equal((await app.call('GET', `/api/me/readiness/${marine.id}/fitness-reports`, { token: outsider.token })).status, 403, 'nor does anyone outside the unit');
  assert.equal((await app.call('GET', `/api/me/readiness/${leader.id}/fitness-reports`, { token: marine.token })).status, 403, 'a Marine does not read their leader’s');

  // Removed, it leaves the leader's view; the Marine's own export of what Vantage holds still lists it.
  assert.equal((await app.call('DELETE', `/api/me/fitness-reports/${first.id}`, { token: marine.token })).status, 200);
  assert.deepEqual((await app.call('GET', `/api/me/readiness/${marine.id}/fitness-reports`, { token: leader.token })).body.reports, []);
  assert.equal((await app.call('GET', '/api/me/fitness-reports', { token: marine.token })).body.reports.length, 1);
  const exported = buildPersonalExport(app.ctx, marine.id, { attachments: false }) as unknown as { fitness_reports: Array<{ id: string; deleted_at: string | null }> };
  assert.equal(exported.fitness_reports.length, 2);
  assert.ok(exported.fitness_reports.find((r) => r.id === first.id)?.deleted_at, 'kept as removed');
  assert.equal((buildPersonalExport(app.ctx, leader.id, { attachments: false }) as unknown as { fitness_reports: unknown[] }).fitness_reports.length, 0, 'a leader’s own export holds none of the Marine’s');
  // The workbook and the ZIP carry them too, and a narrowed export counts them with the profile.
  const book = readWorkbook(buildPersonalExportWorkbook(app.ctx, marine.id).buffer);
  const sheet = book.sheets.find((x) => x.name === 'Fitness reports');
  assert.ok(sheet, 'a Fitness reports sheet');
  assert.equal(sheet!.rows.length, 3, 'a header and both reports');
  assert.ok(sheet!.rows[0].includes('deleted_at') && !sheet!.rows[0].includes('user_id'));
  assert.ok(listZip(buildPersonalExportZip(app.ctx, marine.id).buffer).includes('fitness-reports.csv'));
  assert.equal(buildPersonalExportWorkbook(app.ctx, marine.id, { sections: ['profile'] }).counts.fitness_reports, 2);
});
