import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, today, type TestApp } from './helpers.ts';
import { parseQuickLog } from '../../shared/quickLog.ts';
import { unitKeyOf, quantityMetricId, canonicalMetricId, totals, totalFor, measuresOfAll } from '../../shared/metricEngine.ts';
import { aggregateMetrics, rangeForPeriod } from '../../shared/metrics.ts';
import { buildPackage, groupByAreas } from '../../shared/bullets.ts';
import { comparePeriods } from '../../shared/delta.ts';
import { areasFor, daysUntil, mapAreaToTrack } from '../../shared/evaluation.ts';

let app: TestApp;
let op: { token: string; id: string; unitId: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
});
after(() => app.close());

const now = new Date(2026, 9, 3, 14, 30); // Saturday 3 October 2026, FY27 day three
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const day = (text: string) => ymd(parseQuickLog(text, now).date);

test('B4: Quick Log reads month-first dates and weekday names instead of dating the work today', () => {
  assert.equal(day('Closed 14 UDOs on September 30'), '2026-09-30', 'year-end work landed in the next fiscal year');
  assert.equal(day('Closed 14 UDOs on Sep 30'), '2026-09-30');
  assert.equal(day('Closed 14 UDOs Sept. 30, 2026'), '2026-09-30');
  assert.equal(day('Closed 14 UDOs Sep 30th'), '2026-09-30');
  assert.equal(day('Closed 14 UDOs on Dec 5'), '2025-12-05', 'a month-first date without a year is the latest one already past, as day-first is');
  assert.equal(day('Closed 14 UDOs on Dec 5, 2026'), '2026-12-05', 'a year written out is kept');
  assert.equal(day('Closed 14 UDOs on Feb 30'), '2026-10-03', 'a day that does not exist is not a date');
  assert.equal(day('Closed 14 UDOs on Friday'), '2026-10-02');
  assert.equal(day('Closed 14 UDOs Monday'), '2026-09-28');
  assert.equal(day('Closed 14 UDOs on Saturday'), '2026-09-26', 'the weekday it is today means last week: the work is done');
  assert.equal(day('Closed 14 UDOs yesterday'), '2026-10-02');
  assert.equal(day('Led a road march 2 hours with the section'), '2026-10-03', 'lowercase "march" is the word, not the month');
  assert.equal(day('Briefed the plan on March 2'), '2026-03-02', 'capitalized, it is the month');

  const last = parseQuickLog('Closed 14 UDOs last Friday', now);
  assert.equal(ymd(last.date), '2026-10-02');
  assert.deepEqual(last.quantities, [{ value: 14, unit: 'UDOs' }], '"last" leaked into the unit as "UDOs last"');
  assert.equal(last.title, 'Closed 14 UDOs');
  assert.equal(parseQuickLog('Briefed 14 Marines on the new travel policy', now).date.getDate(), 3, '"Marines" is not March');
});

test('B5: Quick Log reads the whole dollar figure and its scale', () => {
  const dollars = (text: string) => parseQuickLog(text, now).dollar_amount;
  assert.equal(dollars('Deobligated $1.2 million in excess funds'), 1_200_000);
  assert.equal(dollars('Recovered $2.5 billion'), 2_500_000_000);
  assert.equal(dollars('Reviewed $3M in obligations'), 3_000_000);
  assert.equal(dollars('Deobligated $1.234M'), 1_234_000, 'a third decimal stopped the match before the suffix');
  assert.equal(dollars('Saved $1.2k'), 1_200);
  assert.equal(dollars('Saved $4 thousand'), 4_000);
  assert.equal(dollars('Saved $5 mil and $2bn'), 2_005_000_000);
  assert.equal(dollars('Paid $10.999'), 11, 'rounded to the cent, not truncated');
  assert.equal(dollars('Reconciled 30 ULOs totaling $1,118.38 in DAI'), 1118.38);
  assert.equal(dollars('Obligated $1,000 MIPR funding'), 1000, 'a word that starts with M is not millions');
});

test('B6: a two-digit number after a day-first date is a quantity, not the year', () => {
  const p = parseQuickLog('On 30 Sep 14 UDOs closed in DAI', now);
  assert.equal(ymd(p.date), '2026-09-30', 'was 2014-09-30');
  assert.deepEqual(p.quantities, [{ value: 14, unit: 'UDOs' }]);
  assert.ok(p.title.includes('14 UDOs'));
  assert.equal(day("Closed 4 UDOs on 30 Sep '25"), '2025-09-30', "an apostrophe year is a year");
  assert.equal(day('Closed 4 UDOs on 30 Sep 2025'), '2025-09-30');
});

test('B7: the unit stops at the plural instead of taking the next ordinary word', () => {
  const p = parseQuickLog('Processed 5 MIPRs in the morning and 7 MIPRs after lunch', now);
  assert.deepEqual(p.quantities.map((q) => q.unit), ['MIPRs'], 'was ["MIPRs", "MIPRs after"]');
  assert.deepEqual(parseQuickLog('Processed 1 MIPR after lunch', now).quantities, [{ value: 1, unit: 'MIPR' }]);
  assert.deepEqual(parseQuickLog('Cleared 9 travel claims', now).quantities, [{ value: 9, unit: 'travel claims' }], 'a modifier keeps its noun');
  assert.deepEqual(parseQuickLog('Reviewed 4 DTS vouchers', now).quantities, [{ value: 4, unit: 'DTS vouchers' }]);
  assert.deepEqual(parseQuickLog('Filed 5 status reports', now).quantities, [{ value: 5, unit: 'status reports' }]);
});

test('B8: a fraction is not a date', () => {
  const p = parseQuickLog('Processed 3/4 of the backlog', now);
  assert.equal(ymd(p.date), '2026-10-03', 'was 2026-03-04');
  assert.equal(p.title, 'Processed 3/4 of the backlog');
  assert.equal(day('Closed 4 MIPRs 9/30'), '2026-09-30', 'a month/day still is');
});

test('Quick Log parses thousands of dollar figures in linear time', () => {
  const ledger = Array.from({ length: 5000 }, (_, i) => `$${i + 1}.25`).join(' and ');
  const started = performance.now();
  const p = parseQuickLog(ledger, now);
  const took = performance.now() - started;
  assert.equal(p.dollar_amount, 12_503_750);
  assert.ok(took < 100, `took ${took.toFixed(1)} ms; blanking each figure with its own replace was quadratic`);
});

test('B16: a unit\'s singular and plural are one metric, and goals saved under the old key still find it', () => {
  for (const [one, many] of [['discrepancy', 'discrepancies'], ['inventory', 'inventories'], ['class', 'classes'], ['box', 'boxes'], ['batch', 'batches'], ['ULO', 'ULOs'], ['calorie', 'calories']]) {
    assert.equal(quantityMetricId(one), quantityMetricId(many), `${one} / ${many}`);
  }
  assert.equal(unitKeyOf('discrepancies'), 'discrepancy');
  assert.equal(unitKeyOf('class'), 'class', 'was "clas"');
  assert.equal(unitKeyOf('hrs'), 'hrs');
  const measures = measuresOfAll([
    { id: '1', date: '2026-10-01', quantity: 1, unit_label: 'discrepancy' },
    { id: '2', date: '2026-10-02', quantity: 4, unit_label: 'discrepancies' },
  ]);
  assert.deepEqual(totals(measures).map((t) => [t.metricId, t.value]), [['quantity:discrepancy', 5]], 'was two rows, 1 and 4');
  for (const [old, current] of [['quantity:discrepancie', 'quantity:discrepancy'], ['quantity:classe', 'quantity:class'], ['quantity:clas', 'quantity:class'], ['quantity:boxe', 'quantity:box'], ['quantity:ulo', 'quantity:ulo'], ['quantity:hour', 'duration:hours'], ['money:reviewed', 'money:reviewed']]) {
    assert.equal(canonicalMetricId(old), current, old);
  }
  assert.equal(totalFor(measures, 'quantity:discrepancie')?.value, 5);
});

test('B16: a goal saved on "quantity:discrepancie" counts singular and plural entries', async () => {
  const d = today();
  for (const [quantity, unit_label] of [[1, 'discrepancy'], [4, 'discrepancies']] as const) {
    const r = await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Cleared discrepancies', date: d, visibility: 'private', quantity, unit_label } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const made = await app.call('POST', '/api/records/goals', { token: op.token, body: { title: 'Clear ten', status: 'active', visibility: 'private', period_start: '2026-01-01', period_end: '2099-12-31', metric_id: 'quantity:discrepancy', direction: 'increase', baseline_value: 0, target_value: 10, aggregation: 'sum', unit_label: 'discrepancies' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  app.ctx.db.prepare('UPDATE goals SET metric_id = ? WHERE id = ?').run('quantity:discrepancie', made.body.id);
  const goals = await app.call('GET', '/api/records/goals', { token: op.token });
  const saved = (goals.body.items || goals.body).find((g: { id: string }) => g.id === made.body.id);
  assert.equal(saved.progress.current, 5, 'the old key matched only the plural entries');
  assert.equal(saved.progress.outcomes, 2);
});

test('B17: the by-area breakdown keeps entries saved as the literal "Unassigned"', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const d = today();
    for (const [title, eval_area, amount] of [['Reconciled ULOs', 'Unassigned', 1000], ['Processed ULOs', 'Unassigned', 500], ['Led PT', 'Leadership', 0]] as const) {
      const r = await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { title, date: d, eval_area, dollar_amount: amount || null, dollar_type: amount ? 'reconciled' : null, quantity: 3, unit_label: 'ULOs' } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    }
    const m = await fresh.call('GET', '/api/metrics', { token: owner.token });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    const byArea = Object.fromEntries(m.body.byArea.map((b: any) => [b.value, Object.fromEntries(b.totals.map((t: any) => [t.metricId, t.value]))]));
    assert.deepEqual(byArea.Unassigned, { 'money:reconciled': 1500, 'quantity:ulo': 6 }, 'the $1,500 and 6 ULOs were missing');
    assert.deepEqual(byArea.Leadership, { 'quantity:ulo': 3 });
  } finally { await fresh.close(); }
});

test('B18: a Sgt\'s Quick Log entries appear under Mission Accomplishment in the FITREP package and comparison', async () => {
  const sgt = await app.register('sgtsmith', { rank_id: 'Sgt' });
  const d = today();
  const texts = ['Reconciled 30 ULOs totaling $1,118.38 in DAI', 'Processed 12 MIPRs for G-8, zero returns', 'Obligated $45,000 in GCSS-MC'];
  for (const [i, text] of texts.entries()) {
    const p = parseQuickLog(text);
    assert.equal(p.eval_area, 'MOS / Mission Accomplishment');
    // What QuickLog.tsx now saves for a FITREP-track Marine; the last entry keeps the JEPES name, as entries saved before the fix did.
    const eval_area = i < 2 ? mapAreaToTrack(p.eval_area, 'fitrep') : p.eval_area;
    const r = await app.call('POST', '/api/records/activities', { token: sgt.token, body: { title: p.title, date: d, category: p.category, eval_area, quantity: p.quantities[0]?.value ?? null, unit_label: p.quantities[0]?.unit ?? null, dollar_amount: p.dollar_amount, dollar_type: p.dollar_type, visibility: 'private' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.eval_area, i < 2 ? 'Mission Accomplishment' : 'MOS / Mission Accomplishment');
  }
  const rep = await app.call('GET', '/api/reports?period=all', { token: sgt.token });
  assert.equal(rep.status, 200, JSON.stringify(rep.body));
  assert.equal(rep.body.track, 'fitrep');
  const pkg = Object.fromEntries(rep.body.pkg.map((g: { area: string; count: number }) => [g.area, g.count]));
  assert.equal(pkg['Mission Accomplishment'], 3, `Section D read 0: ${JSON.stringify(pkg)}`);
  assert.equal(pkg.Unassigned, undefined);
  assert.match(rep.body.narrative.text, /^MISSION:/);

  const delta = await app.call('GET', '/api/reports/delta?period=fiscalYear', { token: sgt.token });
  assert.equal(delta.status, 200, JSON.stringify(delta.body));
  const mission = delta.body.byArea.find((a: { area: string }) => a.area === 'Mission Accomplishment');
  assert.equal(mission.current, 3);
  assert.ok(!delta.body.notes.some((n: string) => n.includes('Mission Accomplishment')), 'the comparison said nothing was recorded under it');
});

test('B18: grouping by area reads either track\'s names', () => {
  const entries = [
    { title: 'Reconciled ULOs', eval_area: 'MOS / Mission Accomplishment' },
    { title: 'Read for PME', eval_area: 'Intellect and Wisdom' },
    { title: 'Marked JEPES', eval_area: 'Evaluation Responsibilities' },
    { title: 'Loose', eval_area: 'Unassigned' },
    { title: 'Blank', eval_area: null },
  ];
  const fitrep = Object.fromEntries(buildPackage(entries, { areas: areasFor('fitrep') }).map((g) => [g.area, g.count]));
  assert.deepEqual(fitrep, { 'Mission Accomplishment': 1, 'Individual Character': 0, Leadership: 0, 'Intellect and Wisdom': 1, 'Evaluation Responsibilities': 1, Unassigned: 2 });
  const jepes = Object.fromEntries(groupByAreas(entries, areasFor('jepes')).map((g) => [g.area, g.activities.length]));
  assert.deepEqual(jepes, { 'Individual Character': 0, 'MOS / Mission Accomplishment': 2, Leadership: 1, Unassigned: 2 });
});

test('B21: per-area and per-category dollars leave out reviewed dollars, as the headline does', () => {
  const acts = [
    { date: '2026-10-02', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', dollar_amount: 1118.38, dollar_type: 'reconciled', quantity: 30, unit_label: 'ULOs' },
    { date: '2026-10-02', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', dollar_amount: 3_000_000, dollar_type: 'reviewed', quantity: 4, unit_label: 'ULOs' },
  ];
  const m = aggregateMetrics(acts);
  assert.equal(m.totalDollars, 1118.38);
  assert.equal(m.reviewedDollars, 3_000_000);
  assert.equal(m.byArea['MOS / Mission Accomplishment'].dollars, 1118.38, 'was 3,001,118.38');
  assert.equal(m.byCategory['Fiscal & Financial'].dollars, 1118.38);
  assert.equal(m.byArea['MOS / Mission Accomplishment'].count, 2, 'the reviewed entry still counts as an entry');
  const cmp = comparePeriods(acts, rangeForPeriod('fiscalYear', new Date(2026, 9, 3)), { areas: areasFor('jepes') });
  assert.equal(cmp.byArea.find((a) => a.area === 'MOS / Mission Accomplishment')!.dollars.current, 1118.38);
});

test('B10: daysUntil counts calendar days where the reader is, whatever the hour', () => {
  const zone = process.env.TZ;
  try {
    for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      process.env.TZ = tz;
      for (const hour of [0, 9, 19, 23]) {
        const at = new Date(2026, 9, 3, hour, 30);
        assert.equal(daysUntil('2026-10-03', at), 0, `${tz} ${hour}:30, a goal ending today is not overdue`);
        assert.equal(daysUntil('2026-10-04', at), 1, `${tz} ${hour}:30`);
        assert.equal(daysUntil('2026-10-31', at), 28, `${tz} ${hour}:30`);
        assert.equal(daysUntil('2026-10-02', at), -1, `${tz} ${hour}:30`);
      }
    }
    process.env.TZ = 'America/New_York';
    assert.equal(daysUntil('2026-11-02', new Date(2026, 10, 1, 12)), 1, 'across the end of daylight saving time');
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
  assert.equal(daysUntil(null), null);
  assert.equal(daysUntil('not a date'), null);
});
