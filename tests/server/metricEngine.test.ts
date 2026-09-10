import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  measuresOf, measuresOfAll, totals, totalFor, headline, series, progress, catalog, dedupe, unitKeyOf,
  moneyMetricId, quantityMetricId,
} from '../../shared/metricEngine.ts';
import { DEFAULT_METRICS, normalizeMetrics } from '../../shared/constants.ts';

const row = (over: Record<string, unknown>) => ({ id: 'a', date: '2026-03-01', ...over }) as never;

test('a measure carries its unit, and unlike units never combine into one total', () => {
  const rows = [
    row({ id: 'a1', quantity: 30, unit_label: 'ULOs' }),
    row({ id: 'a2', quantity: 4, unit_label: 'hours' }),
    row({ id: 'a3', quantity: 12, unit_label: 'ULO' }),
  ];
  const t = totals(measuresOfAll(rows));
  const ulos = t.find((x) => x.metricId === quantityMetricId('ULOs'))!;
  const hours = t.find((x) => x.metricId === quantityMetricId('hours'))!;
  // "ULOs" and "ULO" are the same unit, so they add. "hours" is a different unit and stays apart.
  assert.equal(ulos.value, 42);
  assert.equal(hours.value, 4);
  assert.equal(t.length, 2);
  assert.ok(!t.some((x) => x.value === 46));
});

test('unit normalization folds case and a trailing plural but nothing else', () => {
  assert.equal(unitKeyOf('ULOs'), unitKeyOf('ulo'));
  assert.equal(unitKeyOf('Invoices'), 'invoice');
  assert.notEqual(unitKeyOf('miles'), unitKeyOf('minutes'));
  assert.equal(unitKeyOf(''), 'items');
  // Three letters or fewer keep their s, so "OPS" does not become "OP".
  assert.equal(unitKeyOf('OPS'), 'ops');
});

test('financial types are never summed together and non-headline types stay out of the headline', () => {
  const cfg = normalizeMetrics({
    currency_label: 'Dollars', currency_symbol: '$',
    value_types: [
      { key: 'obligated', label: 'Obligated', summable: true },
      { key: 'deobligated', label: 'De-obligated', summable: true },
      { key: 'reviewed', label: 'Reviewed', summable: false },
    ],
    categories: DEFAULT_METRICS.categories, unit_suggestions: [],
  });
  const rows = [
    row({ id: 'm1', dollar_amount: 1000, dollar_type: 'obligated' }),
    row({ id: 'm2', dollar_amount: 250, dollar_type: 'deobligated' }),
    row({ id: 'm3', dollar_amount: 900_000, dollar_type: 'reviewed' }),
  ];
  const { headline: head, tracked } = headline(measuresOfAll(rows, cfg));
  assert.deepEqual(head.map((t) => t.value).sort((a, b) => a - b), [250, 1000]);
  assert.equal(head.length, 2, 'obligated and de-obligated are different claims and stay separate');
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].value, 900_000);
  assert.ok(!head.some((t) => t.value === 1250), 'unlike financial types never blend');
  assert.ok(!head.some((t) => t.metricId === moneyMetricId('reviewed')));
});

test('one outcome counts once no matter how many times it is presented', () => {
  const one = row({ id: 'dup', quantity: 10, unit_label: 'invoices', dollar_amount: 500, dollar_type: 'obligated' });
  const measures = measuresOfAll([one, one, one]);
  assert.equal(measures.length, 6, 'three copies do produce three measure sets');
  assert.equal(dedupe(measures).length, 2, 'but they collapse to the two measures the outcome actually has');
  const t = totals(measures);
  assert.equal(totalFor(measures, quantityMetricId('invoices'))!.value, 10);
  assert.equal(totalFor(measures, moneyMetricId('obligated'))!.value, 500);
  for (const each of t) assert.equal(each.outcomes, 1);
});

test('an outcome with no measurable result produces no measures, so it cannot inflate anything', () => {
  assert.deepEqual(measuresOf(row({ id: 'empty', title: 'Attended a meeting' })), []);
  assert.deepEqual(measuresOf(row({ id: 'zero', quantity: 0, dollar_amount: 0 })), []);
});

test('every total can be opened: contributors name the outcomes behind the figure', () => {
  const rows = [
    row({ id: 'x1', date: '2026-01-05', dollar_amount: 100, dollar_type: 'obligated' }),
    row({ id: 'x2', date: '2026-01-06', dollar_amount: 200, dollar_type: 'obligated' }),
  ];
  const t = totalFor(measuresOfAll(rows), moneyMetricId('obligated'))!;
  assert.equal(t.value, 300);
  assert.deepEqual(t.contributors.sort(), ['x1', 'x2']);
  assert.equal(t.outcomes, 2);
});

test('periods and dimension filters narrow the same way for every caller', () => {
  const rows = [
    row({ id: 'p1', date: '2026-01-10', quantity: 5, unit_label: 'ULOs', category: 'Fiscal', user_id: 'u1' }),
    row({ id: 'p2', date: '2026-02-10', quantity: 7, unit_label: 'ULOs', category: 'Fiscal', user_id: 'u2' }),
    row({ id: 'p3', date: '2026-02-11', quantity: 9, unit_label: 'ULOs', category: 'Training', user_id: 'u1' }),
  ];
  const m = measuresOfAll(rows);
  assert.equal(totalFor(m, quantityMetricId('ULOs'), { from: '2026-02-01', to: '2026-02-28' })!.value, 16);
  assert.equal(totalFor(m, quantityMetricId('ULOs'), { filters: { category: 'Fiscal' } })!.value, 12);
  assert.equal(totalFor(m, quantityMetricId('ULOs'), { filters: { user_id: 'u1' }, from: '2026-02-01', to: '2026-02-28' })!.value, 9);
  assert.equal(totalFor(m, quantityMetricId('ULOs'), { from: '2027-01-01', to: '2027-12-31' }), null, 'an empty period reads as no data, not as zero');
});

test('aggregations other than sum apply to the same selection', () => {
  const rows = [
    row({ id: 'g1', date: '2026-01-01', quantity: 10, unit_label: 'days' }),
    row({ id: 'g2', date: '2026-01-02', quantity: 30, unit_label: 'days' }),
    row({ id: 'g3', date: '2026-01-03', quantity: 20, unit_label: 'days' }),
  ];
  const m = measuresOfAll(rows);
  const id = quantityMetricId('days');
  assert.equal(totalFor(m, id, { aggregation: 'max' })!.value, 30);
  assert.equal(totalFor(m, id, { aggregation: 'min' })!.value, 10);
  assert.equal(totalFor(m, id, { aggregation: 'average' })!.value, 20);
  assert.equal(totalFor(m, id, { aggregation: 'latest' })!.value, 20, 'latest follows date order, not input order');
  assert.equal(totalFor(m, id, { aggregation: 'distinct' })!.value, 3);
});

test('a series buckets one metric without leaking another metric into it', () => {
  const rows = [
    row({ id: 's1', date: '2026-01-15', dollar_amount: 100, dollar_type: 'obligated', quantity: 50, unit_label: 'ULOs' }),
    row({ id: 's2', date: '2026-02-15', dollar_amount: 300, dollar_type: 'obligated' }),
  ];
  const buckets = [
    { key: 'jan', from: '2026-01-01', to: '2026-01-31', label: 'Jan' },
    { key: 'feb', from: '2026-02-01', to: '2026-02-28', label: 'Feb' },
    { key: 'mar', from: '2026-03-01', to: '2026-03-31', label: 'Mar' },
  ];
  const s = series(measuresOfAll(rows), moneyMetricId('obligated'), buckets);
  assert.deepEqual(s.map((b) => b.value), [100, 300, 0]);
  assert.deepEqual(s[0].contributors, ['s1']);
  assert.equal(s[2].outcomes, 0);
});

test('progress is typed: increase, decrease, threshold and completion each mean something different', () => {
  const m = measuresOfAll([
    row({ id: 'r1', date: '2026-01-10', quantity: 40, unit_label: 'ULOs' }),
    row({ id: 'r2', date: '2026-01-20', quantity: 20, unit_label: 'ULOs' }),
  ]);
  const id = quantityMetricId('ULOs');
  const up = progress({ measures: m, metricId: id, direction: 'increase', baseline: 0, target: 120 });
  assert.equal(up.current, 60);
  assert.equal(up.percent, 50);
  assert.equal(up.met, false);
  assert.deepEqual(up.contributors.sort(), ['r1', 'r2']);

  const down = progress({ measures: m, metricId: id, direction: 'decrease', baseline: 100, target: 50 });
  assert.equal(down.percent, 80, 'from 100 toward 50, sitting at 60, is 80 percent of the way');
  assert.equal(down.met, false);

  assert.equal(progress({ measures: m, metricId: id, direction: 'threshold', target: 60 }).met, true);
  assert.equal(progress({ measures: m, metricId: id, direction: 'threshold', target: 61 }).met, false);

  const done = progress({ measures: m, metricId: id, direction: 'completion', completed: true });
  assert.equal(done.percent, 100);
  assert.equal(done.met, true);
  assert.equal(progress({ measures: m, metricId: id, direction: 'completion', completed: false }).percent, 0);
});

test('progress never counts an outcome outside its own period or filter', () => {
  const m = measuresOfAll([
    row({ id: 'in', date: '2026-05-02', quantity: 10, unit_label: 'cases', user_id: 'u1' }),
    row({ id: 'out-of-period', date: '2026-01-02', quantity: 999, unit_label: 'cases', user_id: 'u1' }),
    row({ id: 'someone-else', date: '2026-05-03', quantity: 999, unit_label: 'cases', user_id: 'u2' }),
  ]);
  const p = progress({
    measures: m, metricId: quantityMetricId('cases'), direction: 'increase', baseline: 0, target: 20,
    from: '2026-05-01', to: '2026-05-31', filters: { user_id: 'u1' },
  });
  assert.equal(p.current, 10);
  assert.deepEqual(p.contributors, ['in']);
});

test('a target that is already at the baseline does not report a false percentage', () => {
  const m = measuresOfAll([row({ id: 'n1', quantity: 5, unit_label: 'units' })]);
  const p = progress({ measures: m, metricId: quantityMetricId('units'), direction: 'increase', baseline: 10, target: 10 });
  assert.equal(p.percent, 0);
  assert.equal(p.met, false);
  const q = progress({ measures: m, metricId: quantityMetricId('units'), direction: 'increase', baseline: 5, target: 5 });
  assert.equal(q.met, true);
  assert.equal(q.percent, 100);
});

test('the catalog lists what is actually present, with its kind and unit', () => {
  const c = catalog(measuresOfAll([
    row({ id: 'c1', dollar_amount: 10, dollar_type: 'obligated' }),
    row({ id: 'c2', quantity: 3, unit_label: 'ULOs' }),
    row({ id: 'c3', hours: 2 }),
  ]));
  assert.deepEqual(c.map((e) => e.kind).sort(), ['duration', 'money', 'quantity']);
  assert.ok(c.every((e) => e.metricId && e.unit));
});

test('an unrecognized financial type is tracked separately rather than silently counted', () => {
  const cfg = normalizeMetrics({
    currency_label: 'Dollars', currency_symbol: '$',
    value_types: [{ key: 'obligated', label: 'Obligated', summable: true }],
    categories: DEFAULT_METRICS.categories, unit_suggestions: [],
  });
  const m = measuresOfAll([
    row({ id: 'k1', dollar_amount: 500, dollar_type: 'obligated' }),
    row({ id: 'k2', dollar_amount: 500, dollar_type: 'something-an-old-import-used' }),
  ], cfg);
  const { headline: head, tracked } = headline(m, {});
  assert.deepEqual(head.map((t) => t.value), [500]);
  assert.equal(tracked.length, 1);
  assert.equal(tracked[0].value, 500);
});
