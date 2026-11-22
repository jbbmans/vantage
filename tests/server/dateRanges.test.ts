import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, mockGenAi, type TestApp } from './helpers.ts';
import { zonedDay } from '../../server/lib/clock.ts';
import { CUSTOM_PERIOD, MAX_RANGE_DAYS, RANGE_TEXT, customSeed, isRangeDay, presetDays, rangeLabel, rangeOfDays, rangeProblems, spanDays } from '../../shared/dateRange.ts';
import { DEFAULT_PERIOD } from '../../shared/metrics.ts';
import { lastDays, metricsPeriod, periodDays, periodQuery, readPeriod, readWindow, windowDays, windowLink, writePeriod, writeWindow } from '../../src/lib/periodParams.ts';
import { DASHBOARD_WINDOW, RECORD_WINDOW, WORKLOAD_WINDOW, windowSeed } from '../../src/lib/windows.ts';

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

test('a window page keeps its preset under its own key, and custom dates as a Period page does', () => {
  const read = (q: string, keys = DASHBOARD_WINDOW) => readWindow(new URLSearchParams(q), keys);
  assert.deepEqual(read(''), { period: '90', from: '', to: '', custom: false, ignored: null }, 'the dashboard opens on 90 days');
  assert.equal(read('days=365').period, '365', 'a Last year link still opens on Last year');
  assert.equal(read('window=365', RECORD_WINDOW).period, '365', 'a 12 months link still opens on 12 months');
  assert.equal(read('', WORKLOAD_WINDOW).period, '30', 'Workload opens on 30 days');
  assert.equal(read('days=45').period, '90', 'a window nobody offers is the default');
  assert.equal(read('window=abc', RECORD_WINDOW).period, '90', 'a word for a window is the default, never a failure');
  assert.deepEqual(read('period=custom&from=2026-01-01&to=2026-01-31'), { period: CUSTOM_PERIOD, from: '2026-01-01', to: '2026-01-31', custom: true, ignored: null });
  assert.equal(read('from=2026-01-01&to=2026-01-31').custom, true, 'two days from a link are custom dates');
  assert.equal(read('days=30&from=2026-01-01&to=2026-01-31').custom, false, 'a preset named with days is the preset');
  for (const q of ['period=custom', 'period=custom&from=2026-01-01', 'from=2026-02-30&to=2026-03-01', 'from=2026-03-10&to=2026-03-01', `from=2025-01-01&to=${addDays('2025-01-01', MAX_RANGE_DAYS)}`]) {
    const state = read(q);
    assert.equal(state.custom, false, q);
    assert.equal(state.period, '90', q);
    assert.ok(state.ignored?.message, q);
  }
  assert.equal(read('days=180&period=custom&from=2026-03-10&to=2026-03-01').period, '180', 'refused days leave the preset the link named');

  const write = (q: string, next: Parameters<typeof writeWindow>[1], keys = DASHBOARD_WINDOW) => writeWindow(new URLSearchParams(q), next, keys).toString();
  assert.equal(write('tab=work&days=365', { period: CUSTOM_PERIOD, from: '2026-01-01', to: '2026-01-31' }), 'tab=work&period=custom&from=2026-01-01&to=2026-01-31', 'custom dates drop the preset and keep every other key');
  assert.equal(write('period=custom&from=2026-01-01&to=2026-01-31&tab=work', { period: '365' }), 'tab=work&days=365', 'a preset drops the days');
  assert.equal(write('days=365', { period: '90' }), '', 'the default is left out');
  assert.equal(write('', { period: '365' }, RECORD_WINDOW), 'window=365');
  assert.equal(write('window=90', { period: CUSTOM_PERIOD }), 'window=90', 'custom dates without their days write no range, and leave another key alone');
  // What a page writes, it reads back.
  for (const next of [{ period: '30' }, { period: '365' }, { period: CUSTOM_PERIOD, from: '2025-05-01', to: '2025-06-30' }]) {
    const back = readWindow(writeWindow(new URLSearchParams(), next, DASHBOARD_WINDOW), DASHBOARD_WINDOW);
    assert.equal(back.period, next.period, JSON.stringify(next));
  }

  const ref = new Date(2026, 5, 15, 12);
  assert.deepEqual(lastDays(365, ref), { from: '2025-06-16', to: '2026-06-15' }, 'Last year is 365 days ending today');
  assert.deepEqual(lastDays('30', ref), { from: '2026-05-17', to: '2026-06-15' });
  assert.equal(spanDays(lastDays(365, ref).from, lastDays(365, ref).to), 365, 'never the 12 months period, which runs through tomorrow');
  const preset = { period: '365', from: '', to: '', custom: false };
  const custom = { period: CUSTOM_PERIOD, from: '2025-05-01', to: '2025-06-30', custom: true };
  assert.deepEqual(windowDays(preset, ref), lastDays(365, ref));
  assert.deepEqual(windowDays(custom, ref), { from: '2025-05-01', to: '2025-06-30' });
  assert.deepEqual(windowLink(preset, ref), lastDays(365, ref), 'Print or file carries a preset as its days');
  assert.deepEqual(windowLink(custom, ref), { period: CUSTOM_PERIOD, from: '2025-05-01', to: '2025-06-30' }, 'and custom dates by name');
  assert.deepEqual(windowSeed(DASHBOARD_WINDOW)('180'), lastDays(180), 'custom dates start from the window before');
  assert.deepEqual(windowSeed(DASHBOARD_WINDOW)(CUSTOM_PERIOD), lastDays(90));
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
  ['unit export', '/api/org/units/G8/export?'],
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
  // The window pages send `period=custom` with their days, as the Period pages do.
  for (const path of ['/api/work/workload?unit_id=G8&', '/api/record/summary?', '/api/record/contributions?', '/api/record/timeline?', '/api/org/units/G8/dashboard?', '/api/org/units/G8/export?']) {
    const res = await get(`${path}period=custom`);
    assert.equal(res.status, 400, path);
    assert.ok(res.body.fieldErrors?.from && res.body.fieldErrors?.to, `${path}: ${JSON.stringify(res.body)}`);
    assert.equal((await get(`${path}period=custom&${longest(day(-100))}`)).status, 200, path);
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

test('All time on the metrics counts work dated tomorrow on the instance clock, as the rolling periods do', async () => {
  // A reader east of the instance dates today's work a day ahead of the instance's today.
  const tomorrow = zonedDay(app.ctx.config.timezone, 1);
  const made = await app.call('POST', '/api/records/activities', { token: op.token, body: { title: 'Checks run east of the instance', date: tomorrow, quantity: 7, unit_label: 'checks', visibility: 'private' } });
  assert.equal(made.status, 201, made.text);
  const figure = (body: any) => [...body.headline, ...body.tracked].find((t: any) => t.metricId === 'quantity:check');
  const all = await get('/api/metrics?scope=me&period=all');
  assert.equal(all.status, 200);
  assert.equal(figure(all.body)?.value, 7, 'All time holds it');
  const last30 = await get(`/api/metrics?scope=me&from=${zonedDay(app.ctx.config.timezone, -29)}&to=${tomorrow}`);
  assert.equal(figure(last30.body)?.value, 7, 'as the last 30 days do');
});

test('a unit export with two days holds only the shared records in them; with none, every one', async () => {
  const post = (path: string, body: Record<string, unknown>) => app.call('POST', path, { token: op.token, body: { visibility: 'unit', unit_id: 'G8', ...body } });
  const made = [
    await post('/api/records/activities', { title: 'ZZEXPORT inside', date: '2024-06-10' }),
    await post('/api/records/activities', { title: 'ZZEXPORT runs into the range', date: '2024-05-25', end_date: '2024-06-03' }),
    await post('/api/records/activities', { title: 'ZZEXPORT before', date: '2024-04-10' }),
    await post('/api/records/activities', { title: 'ZZEXPORT after', date: '2024-08-01' }),
    await post('/api/records/activities', { title: 'ZZEXPORT kept private', date: '2024-06-12', visibility: 'private' }),
    await post('/api/records/tasks', { title: 'ZZEXPORT task due inside', due_date: '2024-06-15' }),
    await post('/api/records/tasks', { title: 'ZZEXPORT task due after', due_date: '2024-09-01' }),
    await post('/api/records/tasks', { title: 'ZZEXPORT task with no due day' }),
  ];
  for (const r of made) assert.equal(r.status, 201, r.text);
  const titles = (body: any) => [...body.activities, ...body.tasks].map((r: { title: string }) => r.title).filter((t: string) => t.startsWith('ZZEXPORT')).sort();

  const ranged = await get('/api/org/units/G8/export?from=2024-06-01&to=2024-06-30');
  assert.equal(ranged.status, 200, ranged.text);
  assert.deepEqual(ranged.body.range, { from: '2024-06-01', to: '2024-06-30' }, 'the file says its range');
  assert.deepEqual(titles(ranged.body), ['ZZEXPORT inside', 'ZZEXPORT runs into the range', 'ZZEXPORT task due inside'], 'a record counts by the days it covers, a task by its due day');
  for (const table of ['activities', 'projects', 'tasks', 'goals', 'trainings', 'awards', 'duties']) assert.ok(Array.isArray(ranged.body[table]), table);
  assert.ok(ranged.body.members.length > 0, 'the roster is the unit today, whatever the range');
  const logged = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'export' AND entity = 'unit' AND entity_id = 'G8' ORDER BY seq DESC LIMIT 1").get() as { detail: string };
  assert.match(logged.detail, /^2024-06-01\.\.2024-06-30; \d+ activities/, 'the audit entry names the range');

  const everything = await get('/api/org/units/G8/export');
  assert.equal(everything.status, 200);
  assert.equal(everything.body.range, null);
  assert.deepEqual(titles(everything.body), ['ZZEXPORT after', 'ZZEXPORT before', 'ZZEXPORT inside', 'ZZEXPORT runs into the range', 'ZZEXPORT task due after', 'ZZEXPORT task due inside', 'ZZEXPORT task with no due day'], 'no days, every shared record, undated ones too');
  const all = app.ctx.db.prepare("SELECT detail FROM audit_log WHERE action = 'export' AND entity = 'unit' AND entity_id = 'G8' ORDER BY seq DESC LIMIT 1").get() as { detail: string };
  assert.match(all.detail, /^every date; /);
});

test('a report center file holds only the records in its range', async () => {
  const add = (title: string, date: string) => app.call('POST', '/api/records/activities', { token: op.token, body: { title, date, visibility: 'private' } });
  for (const [title, date] of [['ZZFILE inside', '2023-02-10'], ['ZZFILE before', '2023-01-05'], ['ZZFILE after', '2023-03-20']]) assert.equal((await add(title, date)).status, 201);
  for (const q of ['period=custom&from=2023-02-01&to=2023-02-28', 'from=2023-02-01&to=2023-02-28']) {
    const file = await get(`/api/report-center/export?type=individual&subject=self&format=csv&${q}`);
    assert.equal(file.status, 200, file.text.slice(0, 200));
    assert.match(file.text, /ZZFILE inside/, q);
    assert.doesNotMatch(file.text, /ZZFILE before|ZZFILE after/, q);
  }
  const everything = await get('/api/report-center/export?type=individual&subject=self&format=csv&period=all');
  assert.equal(everything.status, 200);
  for (const t of ['inside', 'before', 'after']) assert.match(everything.text, new RegExp(`ZZFILE ${t}`), `All time holds ${t}`);
});

test('the command brief reads the window by the same rule, and only the records in it', async () => {
  const mock = await mockGenAi(() => ({ json: { model: 'm', choices: [{ message: { content: '{"executive_summary":"x","highlights":[],"watch_items":[],"recommended_questions":[],"caveats":[]}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } }));
  const local = await startApp({ VANTAGE_AI_ENABLED: 'true', VANTAGE_GENAI_API_KEY: 'test-key-123', VANTAGE_GENAI_BASE_URL: mock.url });
  try {
    const lead = await local.setupOperator();
    const add = (category: string, date: string) => local.call('POST', '/api/records/activities', { token: lead.token, body: { title: category, date, category, visibility: 'unit', unit_id: 'G8' } });
    assert.equal((await add('ZZBRIEFIN', '2024-06-10')).status, 201);
    assert.equal((await add('ZZBRIEFOUT', '2024-04-01')).status, 201);
    const brief = (input: Record<string, string>) => local.call('POST', '/api/ai/assist', { token: lead.token, body: { workflow: 'command_brief', input: { unit_id: 'G8', ...input } } });

    for (const [what, input, field] of [
      ['732 days', { from: '2024-01-01', to: addDays('2024-01-01', MAX_RANGE_DAYS) }, 'to'],
      ['the first day alone', { from: '2024-06-01' }, 'to'],
      ['the last day alone', { to: '2024-06-30' }, 'from'],
      ['a backwards range', { from: '2024-06-30', to: '2024-06-01' }, 'to'],
    ] as const) {
      const before = mock.calls.length;
      const res = await brief(input);
      assert.equal(res.status, 400, `${what}: ${res.text.slice(0, 200)}`);
      assert.equal(res.body.code, 'validation', what);
      assert.ok(res.body.fieldErrors?.[field], `${what}: ${JSON.stringify(res.body)}`);
      assert.equal(mock.calls.length, before, `${what}: nothing reaches the provider`);
    }

    const before = mock.calls.length;
    const ok = await brief({ from: '2024-06-01', to: '2024-06-30' });
    assert.equal(ok.status, 200, ok.text.slice(0, 300));
    const sent = mock.calls.slice(before).map((c) => JSON.stringify(c.body.messages)).join(' ');
    assert.match(sent, /ZZBRIEFIN/, 'the window’s records are briefed');
    assert.doesNotMatch(sent, /ZZBRIEFOUT/, 'and none from outside it');
    assert.equal((await brief({ from: '2024-01-01', to: addDays('2024-01-01', MAX_RANGE_DAYS - 1) })).status, 200, '731 days are a window');
    assert.equal((await brief({})).status, 200, 'no days is the last 30');
  } finally { await local.close(); mock.close(); }
});
