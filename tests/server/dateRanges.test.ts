import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type TestApp } from './helpers.ts';
import { CUSTOM_PERIOD, MAX_RANGE_DAYS, RANGE_TEXT, customSeed, isRangeDay, presetDays, rangeLabel, rangeOfDays, rangeProblems, spanDays } from '../../shared/dateRange.ts';
import { DEFAULT_PERIOD } from '../../shared/metrics.ts';
import { metricsPeriod, periodDays, periodQuery, readPeriod, writePeriod } from '../../src/lib/periodParams.ts';

// One range rule for every endpoint that reads records by days (ADR-0038): real calendar days, both or neither, the
// first not after the last, at most 731 days with both ends counted. A preset is named, never capped.

let app: TestApp;
let op: { token: string; id: string; unitId: string };

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const addDays = (from: string, n: number) => new Date(Date.parse(`${from}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const get = (path: string) => app.call('GET', path, { token: op.token });

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
});
after(async () => { await app.close(); });

test('the rule: real days, both or neither, in order, two years at most', () => {
  assert.equal(rangeProblems('', ''), null, 'no range is no problem');
  assert.equal(rangeProblems(undefined, undefined), null);
  assert.equal(rangeProblems('2026-01-01', '2026-01-01'), null, 'one day is a range');
  assert.equal(rangeProblems('2024-02-29', '2024-03-01'), null, 'a leap day is real');

  const required = rangeProblems('', '', { required: true });
  assert.deepEqual(required?.fieldErrors, { from: RANGE_TEXT.addFrom, to: RANGE_TEXT.addTo }, 'custom dates need both days');
  assert.deepEqual(rangeProblems('2026-03-01', '')?.fieldErrors, { to: RANGE_TEXT.addTo });
  assert.deepEqual(rangeProblems('', '2026-03-01')?.fieldErrors, { from: RANGE_TEXT.addFrom });
  assert.equal(rangeProblems('2026-03-01', '')?.message, RANGE_TEXT.bothDays);

  assert.deepEqual(rangeProblems('2026-02-30', '2026-03-10')?.fieldErrors, { from: RANGE_TEXT.notReal }, 'no rolling into March');
  assert.deepEqual(rangeProblems('2025-02-29', '2025-03-10')?.fieldErrors, { from: RANGE_TEXT.notReal });
  assert.deepEqual(rangeProblems('abc', '2026-03-10')?.fieldErrors, { from: RANGE_TEXT.notDate });
  assert.deepEqual(rangeProblems('2026-03-01', '2026-3-9')?.fieldErrors, { to: RANGE_TEXT.notDate });
  assert.deepEqual(rangeProblems('1939-12-31', '1940-01-02')?.fieldErrors, { from: RANGE_TEXT.outOfYears });
  assert.deepEqual(rangeProblems('2026-01-01', '9999-12-31')?.fieldErrors, { to: RANGE_TEXT.outOfYears });
  assert.deepEqual(rangeProblems(['2026-01-01'], '2026-01-02')?.fieldErrors, { from: RANGE_TEXT.notDate }, 'a repeated key is not a day');
  assert.equal(rangeProblems('abc', 'def')?.message, RANGE_TEXT.badDays);

  const backwards = rangeProblems('2026-03-10', '2026-03-01');
  assert.deepEqual(backwards?.fieldErrors, { to: RANGE_TEXT.onOrAfter });
  assert.equal(backwards?.message, RANGE_TEXT.backwards);

  const longest = addDays('2025-01-01', MAX_RANGE_DAYS - 1);
  assert.equal(spanDays('2025-01-01', longest), MAX_RANGE_DAYS);
  assert.equal(rangeProblems('2025-01-01', longest), null, '731 days, both ends counted');
  const tooLong = rangeProblems('2025-01-01', addDays(longest, 1));
  assert.deepEqual(tooLong?.fieldErrors, { to: RANGE_TEXT.tooLongField });
  assert.equal(tooLong?.message, RANGE_TEXT.tooLong);

  assert.ok(isRangeDay('2100-12-31'));
  assert.ok(!isRangeDay('2101-01-01'));
  assert.ok(!isRangeDay('2026-04-31'));
  assert.equal(spanDays('2026-03-07', '2026-03-09'), 3, 'a change of clocks in between does not lose a day');
});

test('custom dates start from the period chosen before, and a range reads as its days', () => {
  const ref = new Date('2026-06-15T12:00:00Z');
  assert.deepEqual(customSeed('last30', ref), presetDays('last30', ref));
  // A rolling window runs through tomorrow, so the last 30 days are 31 of them.
  assert.equal(spanDays(presetDays('last30', ref).from, presetDays('last30', ref).to), 31);
  // All time is no span of days, so it starts from the default period; so does a period nobody knows.
  assert.deepEqual(customSeed('all', ref), presetDays(DEFAULT_PERIOD, ref));
  assert.deepEqual(customSeed('nonsense', ref), presetDays(DEFAULT_PERIOD, ref));
  assert.deepEqual(customSeed(CUSTOM_PERIOD, ref), presetDays(DEFAULT_PERIOD, ref));
  const r = rangeOfDays('2026-01-01', '2026-01-31');
  assert.equal(r.label, rangeLabel('2026-01-01', '2026-01-31'));
  assert.equal(r.label, '01 JAN 26 to 31 JAN 26');
  assert.equal(r.start.getDate(), 1);
  assert.equal(r.end.getDate(), 31);
  assert.equal(r.end.getHours(), 23, 'the last day counts whole');
});

test('a page keeps its period in its address, written as one change', () => {
  const read = (q: string, fallback = 'last90') => readPeriod(new URLSearchParams(q), fallback);
  assert.deepEqual(read(''), { period: 'last90', from: '', to: '', custom: false, ignored: null });
  assert.equal(read('period=fiscalYear').period, 'fiscalYear');
  assert.equal(read('period=lastweekish').period, 'last90', 'an unknown period is the fallback');
  assert.equal(read('', 'custom').period, DEFAULT_PERIOD, 'custom dates are never a fallback');
  assert.deepEqual(read('period=custom&from=2026-01-01&to=2026-01-31'), { period: CUSTOM_PERIOD, from: '2026-01-01', to: '2026-01-31', custom: true, ignored: null });
  assert.equal(read('from=2026-01-01&to=2026-01-31').custom, true, 'two days from a link are custom dates');
  // Days that break the rule are not used: the fallback stands, and the page is told why.
  for (const q of ['period=custom', 'period=custom&from=2026-01-01', 'from=2026-02-30&to=2026-03-01', 'from=2026-03-10&to=2026-03-01', `from=2020-01-01&to=2026-01-01`]) {
    const state = read(q);
    assert.equal(state.custom, false, q);
    assert.equal(state.period, 'last90', q);
    assert.ok(state.ignored?.message, q);
  }

  const write = (q: string, next: Parameters<typeof writePeriod>[1], fallback = 'last90') => writePeriod(new URLSearchParams(q), next, fallback).toString();
  assert.equal(write('category=Fiscal', { period: CUSTOM_PERIOD, from: '2026-01-01', to: '2026-01-31' }), 'category=Fiscal&period=custom&from=2026-01-01&to=2026-01-31', 'every other key is kept');
  assert.equal(write('period=custom&from=2026-01-01&to=2026-01-31&area=x', { period: 'fiscalYear' }), 'period=fiscalYear&area=x', 'a preset clears the days');
  assert.equal(write('period=fiscalYear', { period: 'last90' }), '', 'the fallback is left out');
  assert.equal(write('period=custom&from=2026-01-01&to=2026-01-31', { period: CUSTOM_PERIOD }), '', 'custom without its days writes no range');

  const custom = { period: CUSTOM_PERIOD, from: '2026-01-01', to: '2026-01-31', custom: true } as const;
  const preset = { period: 'last30', from: '', to: '', custom: false } as const;
  const all = { period: 'all', from: '', to: '', custom: false } as const;
  assert.deepEqual(periodQuery(custom), { period: 'custom', from: '2026-01-01', to: '2026-01-31' });
  assert.deepEqual(periodQuery(preset), { period: 'last30' });
  assert.deepEqual(periodDays(custom), { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(periodDays(all), null);
  const ref = new Date('2026-06-15T12:00:00Z');
  assert.deepEqual(periodDays(preset, ref), presetDays('last30', ref));
  assert.deepEqual(metricsPeriod(all), { period: 'all' }, 'All time is asked for by name');
  assert.deepEqual(metricsPeriod(custom), { from: '2026-01-01', to: '2026-01-31' });
});

// Every endpoint that reads records by days, with what else it needs to answer.
const ENDPOINTS: Array<[string, string]> = [
  ['reports', '/api/reports?'],
  ['analysis', '/api/reports/analysis?'],
  ['analysis PDF', '/api/reports/analysis.pdf?'],
  ['delta', '/api/reports/delta?'],
  ['report PDF', '/api/reports/pdf?'],
  ['activities CSV', '/api/reports/csv?'],
  ['metrics', '/api/metrics?scope=me&'],
  ['metric contributors', '/api/metrics/contributors?scope=me&metric_id=quantity:ulo&'],
  ['record summary', '/api/record/summary?'],
  ['contributions', '/api/record/contributions?'],
  ['workload', '/api/work/workload?unit_id=G8&'],
  ['timeline', '/api/record/timeline?'],
  ['duty list', '/api/record/duty/list?'],
  ['records list', '/api/records/activities?'],
  ['report center', '/api/report-center/run?type=individual&subject=self&'],
  ['report center file', '/api/report-center/export?type=individual&subject=self&format=csv&'],
  ['platform audit', '/api/platform/audit?'],
  ['platform audit file', '/api/platform/audit/export?format=csv&'],
  ['instance audit', '/api/orgs/G8/audit?'],
  ['instance audit file', '/api/orgs/G8/audit/export?format=csv&'],
  ['unit dashboard', '/api/org/units/G8/dashboard?'],
  ['unit overview', '/api/org/units/G8/overview?'],
  ['unit analytics', '/api/org/units/G8/analytics/work?'],
  ['unit analytics drill', '/api/org/units/G8/analytics/training/drill?visual=training_now&key=courses&'],
];

const longest = (from: string) => `from=${from}&to=${addDays(from, MAX_RANGE_DAYS - 1)}`;
const REFUSED: Array<[string, string, 'from' | 'to']> = [
  ['a day that does not exist', 'from=2026-02-30&to=2026-03-10', 'from'],
  ['a word for a day', 'from=2026-03-01&to=soon', 'to'],
  ['a year out of reach', 'from=2026-01-01&to=9999-12-31', 'to'],
  ['a backwards range', 'from=2026-03-10&to=2026-03-01', 'to'],
  ['the first day alone', 'from=2026-03-01', 'to'],
  ['the last day alone', 'to=2026-03-01', 'from'],
  ['732 days', `from=2025-01-01&to=${addDays('2025-01-01', MAX_RANGE_DAYS)}`, 'to'],
];

test('every records endpoint refuses a bad range with 400 and names the field', async () => {
  for (const [name, path] of ENDPOINTS) {
    for (const [what, q, field] of REFUSED) {
      const res = await get(`${path}${q}`);
      assert.equal(res.status, 400, `${name}, ${what}: ${res.text.slice(0, 200)}`);
      assert.equal(res.body?.code, 'validation', `${name}, ${what}`);
      assert.ok(res.body?.fieldErrors?.[field], `${name}, ${what}: ${field} is named in ${JSON.stringify(res.body)}`);
    }
  }
});

test('every records endpoint answers a range of 731 days, both ends counted', async () => {
  const q = longest(day(-MAX_RANGE_DAYS + 1));
  for (const [name, path] of ENDPOINTS) {
    const res = await get(`${path}${q}`);
    assert.equal(res.status, 200, `${name}: ${res.text.slice(0, 300)}`);
  }
});

test('custom dates need both days; presets and All time still answer', async () => {
  for (const path of ['/api/reports?', '/api/metrics?scope=me&', '/api/report-center/run?type=individual&subject=self&']) {
    const res = await get(`${path}period=custom`);
    assert.equal(res.status, 400, path);
    assert.ok(res.body.fieldErrors?.from && res.body.fieldErrors?.to, `${path}: ${JSON.stringify(res.body)}`);
    assert.equal((await get(`${path}period=custom&${longest(day(-100))}`)).status, 200, path);
    for (const period of ['all', 'last30', 'last90', 'last12', 'fiscalYear']) assert.equal((await get(`${path}period=${period}`)).status, 200, `${path}${period}`);
  }
  assert.equal((await get('/api/reports?period=sometime')).status, 400, 'a period nobody offers is refused');
  assert.equal((await get('/api/reports/delta?period=all')).status, 200);
});

test('the delta and the CSV read the range they are given', async () => {
  const add = (title: string, date: string) => app.call('POST', '/api/records/activities', { token: op.token, body: { title, date, visibility: 'private' } });
  assert.equal((await add('Range check, inside', '2025-03-05')).status, 201);
  assert.equal((await add('Range check, also inside', '2025-03-20')).status, 201);
  assert.equal((await add('Range check, before', '2025-01-10')).status, 201);
  assert.equal((await add('Range check, after', '2025-05-10')).status, 201);

  const delta = await get('/api/reports/delta?period=last30&from=2025-03-01&to=2025-03-31');
  assert.equal(delta.status, 200, delta.text);
  assert.equal(delta.body.headline.activities.current, 2, 'the two days win over the period, as everywhere in the family');
  assert.ok(delta.body.label.current.includes('01 MAR 25'), JSON.stringify(delta.body.label));

  const csv = await get('/api/reports/csv?period=all&from=2025-03-01&to=2025-03-31');
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes('Range check, inside') && csv.text.includes('Range check, also inside'), csv.text);
  assert.ok(!csv.text.includes('Range check, before') && !csv.text.includes('Range check, after'), 'All time with two days is the two days');
  const everything = await get('/api/reports/csv?period=all');
  assert.equal(everything.status, 200);
  for (const t of ['inside', 'also inside', 'before', 'after']) assert.ok(everything.text.includes(`Range check, ${t}`), `All time without days exports ${t}`);

  const custom = await get('/api/reports?period=custom&from=2025-03-01&to=2025-03-31');
  assert.equal(custom.status, 200);
  assert.equal(custom.body.from, '2025-03-01');
  assert.equal(custom.body.to, '2025-03-31');
});

test('a saved report keeps custom dates only when they make a range', async () => {
  const save = (params: Record<string, string>) => app.call('POST', '/api/report-center/definitions', { token: op.token, body: { name: `Custom ${JSON.stringify(params)}`, type: 'individual', params: { subject: 'self', ...params } } });
  const kept = await save({ period: CUSTOM_PERIOD, from: '2025-03-01', to: '2025-03-31' });
  assert.equal(kept.status, 201, kept.text);
  assert.equal(kept.body.params.period, CUSTOM_PERIOD);
  for (const [params, field] of [
    [{ period: CUSTOM_PERIOD }, 'from'],
    [{ period: CUSTOM_PERIOD, from: '2025-03-01' }, 'to'],
    [{ period: CUSTOM_PERIOD, from: '2025-03-31', to: '2025-03-01' }, 'to'],
    [{ period: CUSTOM_PERIOD, from: '2025-02-30', to: '2025-03-01' }, 'from'],
  ] as const) {
    const res = await save(params);
    assert.equal(res.status, 400, JSON.stringify(params));
    assert.ok(res.body.fieldErrors?.[field], `${JSON.stringify(params)}: ${JSON.stringify(res.body)}`);
  }
});
