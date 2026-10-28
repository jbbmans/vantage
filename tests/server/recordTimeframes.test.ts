import { test, before, after } from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { startApp, enroll, today, type TestApp } from './helpers.ts';
import { TIMEFRAMES, anchorDay, formatTimeframe, inPeriod, parseTime, timeframeColumns, timeframeProblems } from '../../shared/timeframe.ts';
import { ACTIVITY_CSV_COLUMNS, activityToCsvRow, applyMapping, guessMapping, parseCsvText, rowsToCsv } from '../../shared/csv.ts';
import { periodClause } from '../../server/services/timeframes.ts';
import { dropTimeframeTriggers, timeframeTriggers, timeframeViolations, metaGet } from '../../server/db/index.ts';
import { migrationStatus } from '../../server/services/operations.ts';
import { exportInstance, importInstance } from '../../server/services/exports.ts';
import { runDisposition, saveSchedule } from '../../server/services/retention.ts';
import { REDACTED } from '../../shared/constants.ts';

/**
 * Task 12: records take a timeframe (ADR-0018). A start, an end, optional times and "ongoing"; nothing ends before it
 * starts, whoever writes it; and every reader picks records by one rule, counting each once.
 */

let app: TestApp;
let op: { token: string; id: string; unitId: string };
/** Enters records through the API and is refused when they are out of order. */
let rivera: { token: string; id: string };
/** Holds only the records the period tests count, so nothing else lands in their windows. */
let kim: { token: string; id: string };

const get = (token: string, path: string) => app.call('GET', path, { token });
const post = (token: string, path: string, body: unknown = {}) => app.call('POST', path, { token, body });
const put = (token: string, path: string, body: unknown = {}) => app.call('PUT', path, { token, body });
const login = async (username: string) => (await app.login(username)).body.token as string;
const rowOf = (table: string, id: string) => app.ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, any>;

async function made(token: string, table: string, body: Record<string, unknown>) {
  const res = await post(token, `/api/records/${table}`, body);
  assert.equal(res.status, 201, `${table}: ${JSON.stringify(res.body)}`);
  return res.body as Record<string, any>;
}
/** An edit at the version the record is at now. */
const edit = (token: string, table: string, id: string, patch: Record<string, unknown>) => put(token, `/api/records/${table}/${id}`, { ...patch, version: rowOf(table, id).version });

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  rivera = await app.register('rivera');
  kim = await app.register('kim');
  await enroll(app, op.token, 'G8', rivera.id);
  await enroll(app, op.token, 'G8', kim.id);
  rivera.token = await login('rivera');
  kim.token = await login('kim');
});
after(async () => { await app.close(); });

// ---------------------------------------------------------------------------------------------------------------------
// The rules

test('the registry describes every record type with a timeframe, by columns its table has', () => {
  for (const table of Object.keys(TIMEFRAMES) as Array<keyof typeof TIMEFRAMES>) {
    const have = new Set((app.ctx.db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name));
    for (const column of timeframeColumns(table)) assert.ok(have.has(column), `${table}.${column}`);
  }
  // Counselings and tasks happen on a day.
  assert.ok(!('counselings' in TIMEFRAMES) && !('tasks' in TIMEFRAMES));
});

test('a record never ends before it starts, an ongoing one has a start and no end, and a time needs its day', () => {
  assert.equal(timeframeProblems('activities', { date: '2026-05-01', end_date: '2026-05-03' }), null);
  assert.equal(timeframeProblems('activities', { date: '2026-05-01', end_date: '2026-05-01', start_time: '08:00', end_time: '16:30' }), null);
  const backwards = timeframeProblems('activities', { date: '2026-05-03', end_date: '2026-05-01' });
  assert.equal(backwards?.message, 'An activity cannot end before it starts.');
  assert.ok(backwards?.fieldErrors.end_date);
  assert.ok(timeframeProblems('activities', { date: '2026-05-01', start_time: '16:00', end_time: '08:00' })?.fieldErrors.end_time, 'the same day, the end time before the start');
  // A night watch that runs past midnight ends the next day.
  assert.equal(timeframeProblems('activities', { date: '2026-05-01', end_date: '2026-05-02', start_time: '22:00', end_time: '06:00' }), null);
  assert.ok(timeframeProblems('activities', { date: '2026-05-01', end_date: '2026-05-04', ongoing: 1 })?.fieldErrors.end_date, 'ongoing has no end date yet');
  assert.ok(timeframeProblems('activities', { date: '2026-05-01', end_time: '16:00', ongoing: true })?.fieldErrors.end_time, 'nor an end time');
  assert.ok(timeframeProblems('activities', { ongoing: 1 })?.fieldErrors.date, 'ongoing needs the day it began');
  assert.ok(timeframeProblems('trainings', { end_date: '2026-05-04' })?.fieldErrors.date, 'an end date needs a start date');
  assert.ok(timeframeProblems('trainings', { start_time: '08:00' })?.fieldErrors.start_time, 'a time needs its date');
  assert.ok(timeframeProblems('trainings', { date: '2026-05-01', ongoing: true, status: 'completed' })?.fieldErrors.ongoing, 'a completed course has ended');
  assert.equal(timeframeProblems('trainings', { date: '2026-05-01', ongoing: true, status: 'in_progress' }), null);
  assert.equal(timeframeProblems('awards', { period_start: '2026-07-01', date: '2026-06-30' })?.message, 'The period an award recognizes cannot end before it starts.');
  assert.equal(timeframeProblems('awards', { date: '2026-06-30' }), null, 'an award needs no period start');
  assert.equal(timeframeProblems('goals', { period_end: '2026-06-30' }), null, 'a goal with only a deadline is open at its start');
  assert.equal(timeframeProblems('unit_members', { assignment_start: '2026-10-01', assignment_end: '2026-09-30' })?.message, 'The assignment cannot end before it starts.');
  assert.equal(timeframeProblems('personnel_responsibilities', { starts_on: '2026-10-01', ends_on: '2026-09-30' })?.message, 'A responsibility cannot end before it starts.');
});

test('a time is taken as Marines write it and shown as they write it', () => {
  for (const [typed, kept] of [['0800', '08:00'], ['800', '08:00'], ['08:00', '08:00'], ['8:00', '08:00'], ['2359', '23:59'], [' 1630 ', '16:30']]) assert.equal(parseTime(typed), kept, typed);
  for (const typed of ['2400', '0860', '8', 'noon', '', '12:5']) assert.equal(parseTime(typed), null, typed);
  assert.equal(formatTimeframe('activities', { date: '2026-05-12' }), '12 May 26');
  assert.equal(formatTimeframe('activities', { date: '2026-05-12', start_time: '08:00', end_time: '16:00' }), '12 May 26 0800–1600');
  assert.equal(formatTimeframe('activities', { date: '2026-05-12', end_date: '2026-05-16' }), '12 May 26 – 16 May 26');
  assert.equal(formatTimeframe('activities', { date: '2026-05-01', end_date: '2026-05-02', start_time: '22:00', end_time: '06:00' }), '01 May 26 2200 – 02 May 26 0600');
  assert.equal(formatTimeframe('activities', { date: '2026-03-03', ongoing: 1 }), '03 Mar 26 – present');
  assert.equal(formatTimeframe('awards', { date: '2026-06-30' }), '30 Jun 26', 'an award with no period is its date');
  assert.equal(formatTimeframe('awards', { period_start: '2026-01-01', date: '2026-06-30' }), '01 Jan 26 – 30 Jun 26');
  assert.equal(formatTimeframe('goals', { period_end: '2026-06-30' }), 'until 30 Jun 26');
  assert.equal(formatTimeframe('activities', { date: '2026-05-12' }, { upper: true }), '12 MAY 26');
});

test('a record is in a period when any day of it is, an award by its date, and is counted on one day there', () => {
  const course = { date: '2026-01-06', end_date: '2026-02-14' };
  assert.ok(inPeriod('trainings', course, '2026-01-01', '2026-01-31'));
  assert.ok(inPeriod('trainings', course, '2026-02-01', '2026-02-28'), 'the month it ended in');
  assert.ok(inPeriod('trainings', course, '2026-02-14', '2026-02-14'), 'both ends of the period count');
  assert.ok(!inPeriod('trainings', course, '2026-03-01', '2026-03-31'));
  const going = { date: '2025-11-01', ongoing: 1 };
  assert.ok(inPeriod('activities', going, '2027-01-01', '2027-03-31'), 'ongoing counts until it ends');
  assert.ok(!inPeriod('activities', going, '2025-10-01', '2025-10-31'));
  const award = { period_start: '2026-01-01', date: '2026-06-30' };
  assert.ok(!inPeriod('awards', award, '2026-03-01', '2026-03-31'), 'an award is not in the periods it recognizes, only its own');
  assert.ok(inPeriod('awards', award, '2026-06-01', '2026-06-30'));
  assert.ok(inPeriod('goals', { period_end: '2026-06-30' }, '2020-01-01', '2020-01-31'), 'open at its start');
  assert.ok(inPeriod('activities', {}, null, null) && !inPeriod('activities', {}, '2026-01-01', null), 'an undated record is only in an unbounded view');
  assert.equal(anchorDay('activities', going, '2026-01-01'), '2026-01-01', 'begun before the window: its first day there');
  assert.equal(anchorDay('activities', { date: '2026-02-03', end_date: '2026-04-01' }, '2026-01-01'), '2026-02-03');
});

test('the SQL period clause picks exactly the records the shared rule does', () => {
  const db = app.ctx.db;
  const at = new Date().toISOString();
  const spans: Array<{ date?: string; end_date?: string; ongoing?: number }> = [
    {}, { date: '2026-01-10' }, { date: '2026-01-10', end_date: '2026-03-05' }, { date: '2025-12-01', ongoing: 1 }, { date: '2026-04-01', end_date: '2026-04-30' },
  ];
  const goalSpans: Array<{ period_start?: string; period_end?: string }> = [{ period_start: '2026-01-15' }, { period_end: '2026-02-15' }, { period_start: '2026-01-15', period_end: '2026-02-15' }, {}];
  const windows: Array<[string | null, string | null]> = [[null, null], ['2026-01-01', '2026-01-31'], ['2026-02-01', '2026-02-28'], ['2026-03-05', null], [null, '2026-01-09'], ['2026-05-01', '2026-05-31'], ['2025-11-01', '2025-11-30']];
  db.transaction(() => {
    spans.forEach((s, i) => db.prepare('INSERT INTO activities (id, user_id, title, date, end_date, ongoing, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`tf-a-${i}`, kim.id, `span ${i}`, s.date ?? null, s.end_date ?? null, s.ongoing ?? 0, at, at));
    goalSpans.forEach((s, i) => db.prepare('INSERT INTO goals (id, user_id, title, period_start, period_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`tf-g-${i}`, kim.id, `goal ${i}`, s.period_start ?? null, s.period_end ?? null, at, at));
    db.prepare("INSERT INTO awards (id, user_id, name, period_start, date, status, created_at, updated_at) VALUES ('tf-w-0', ?, 'NAM', '2025-06-01', '2026-02-10', 'presented', ?, ?)").run(kim.id, at, at);
  })();
  try {
    for (const table of ['activities', 'goals', 'awards'] as const) {
      const rows = db.prepare(`SELECT * FROM ${table} WHERE id LIKE 'tf-%' AND user_id = ?`).all(kim.id) as Array<{ id: string }>;
      for (const [from, to] of windows) {
        const clause = periodClause(table, 't', from, to);
        const picked = (db.prepare(`SELECT id FROM ${table} t WHERE t.id LIKE 'tf-%' AND t.user_id = ? AND ${clause.sql} ORDER BY id`).all(kim.id, ...clause.params) as Array<{ id: string }>).map((r) => r.id);
        const expected = rows.filter((r) => inPeriod(table, r, from, to)).map((r) => r.id).sort();
        assert.deepEqual(picked, expected, `${table} ${from}..${to}`);
      }
    }
  } finally {
    for (const table of ['activities', 'goals', 'awards']) db.prepare(`DELETE FROM ${table} WHERE id LIKE 'tf-%'`).run();
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Writes

test('the server refuses a record that ends before it starts, marking the field to fix, on every record type', async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['activities', { title: 'Audit support', date: '2026-05-03', end_date: '2026-05-01' }, 'end_date'],
    ['activities', { title: 'Range day', date: '2026-05-01', start_time: '1600', end_time: '0800' }, 'end_time'],
    ['activities', { title: 'Watch', date: '2026-05-01', end_date: '2026-05-04', ongoing: true }, 'end_date'],
    ['activities', { title: 'Watch', start_time: '0800' }, 'start_time'],
    ['trainings', { title: 'Corporals Course', date: '2026-03-13', end_date: '2026-03-02' }, 'end_date'],
    ['trainings', { title: 'DEP', end_date: '2026-03-02' }, 'date'],
    ['trainings', { title: 'MarineNet', date: '2026-03-02', ongoing: true, status: 'completed' }, 'ongoing'],
    ['awards', { name: 'Navy and Marine Corps Achievement Medal', period_start: '2026-07-01', date: '2026-06-30' }, 'date'],
    ['goals', { title: 'PFT 270', period_start: '2026-09-01', period_end: '2026-06-30' }, 'period_end'],
    ['projects', { name: 'Q4 UMT review', start_date: '2026-10-01', target_date: '2026-09-01' }, 'target_date'],
  ];
  const count = (table: string) => (app.ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(rivera.id) as { n: number }).n;
  const counts = Object.fromEntries(['activities', 'trainings', 'awards', 'goals', 'projects'].map((t) => [t, count(t)]));
  for (const [table, body, field] of cases) {
    const res = await post(rivera.token, `/api/records/${table}`, body);
    assert.equal(res.status, 400, `${table} ${JSON.stringify(body)}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(res.body.fieldErrors?.[field], `${table} marks ${field}: ${JSON.stringify(res.body)}`);
  }
  for (const table of Object.keys(counts)) assert.equal(count(table), counts[table], `nothing was saved in ${table}`);
  const time = await post(rivera.token, '/api/records/activities', { title: 'Late shift', date: '2026-05-01', start_time: '2500' });
  assert.equal(time.status, 400, 'a time that is not one');
});

test('a range, times and ongoing are saved as given, and an edit is judged as it would be saved', async () => {
  const course = await made(rivera.token, 'trainings', { title: 'Sergeants Course', date: '2026-04-06', end_date: '2026-05-15', start_time: '0730', end_time: '1630', status: 'completed', hours: 240 });
  assert.deepEqual([course.date, course.end_date, course.start_time, course.end_time, course.ongoing], ['2026-04-06', '2026-05-15', '07:30', '16:30', 0]);
  assert.equal(formatTimeframe('trainings', course), '06 Apr 26 0730 – 15 May 26 1630');

  const going = await made(rivera.token, 'activities', { title: 'Audit support to G-8', date: '2026-01-05', ongoing: true });
  assert.equal(going.ongoing, 1);
  assert.equal(formatTimeframe('activities', going), '05 Jan 26 – present');
  // Ending it means giving the end and unticking ongoing together.
  const half = await edit(rivera.token, 'activities', going.id, { end_date: '2026-03-31' });
  assert.equal(half.status, 400, JSON.stringify(half.body));
  const ended = await edit(rivera.token, 'activities', going.id, { end_date: '2026-03-31', ongoing: false });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.deepEqual([rowOf('activities', going.id).end_date, rowOf('activities', going.id).ongoing], ['2026-03-31', 0]);
  // Only the start sent, past the stored end: the record as saved would end before it starts.
  const late = await edit(rivera.token, 'activities', going.id, { date: '2026-04-15' });
  assert.equal(late.status, 400);
  assert.ok(late.body.fieldErrors.end_date);
  assert.equal(rowOf('activities', going.id).date, '2026-01-05');
  // A course set back in progress may be ongoing again; marking it completed then asks for its end.
  const reopened = await edit(rivera.token, 'trainings', course.id, { end_date: null, end_time: null, ongoing: true, status: 'in_progress' });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  const completed = await edit(rivera.token, 'trainings', course.id, { status: 'completed' });
  assert.equal(completed.status, 400, 'a completed course cannot still be going on');
  assert.ok(completed.body.fieldErrors.ongoing);
});

test('the database refuses any other writer, and the API answers its refusal as a bad request', async () => {
  const db = app.ctx.db;
  const triggers = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string }>).map((t) => t.name));
  for (const table of Object.keys(TIMEFRAMES)) for (const when of ['written', 'changed']) assert.ok(triggers.has(`${table}_timeframe_${when}`), `${table}_timeframe_${when}`);

  const at = new Date().toISOString();
  assert.throws(() => db.prepare("INSERT INTO goals (id, user_id, title, period_start, period_end, created_at, updated_at) VALUES ('g-raw', ?, 'raw', '2026-09-01', '2026-06-30', ?, ?)").run(rivera.id, at, at), /timeframe: a record in goals cannot end before it starts/);
  const entry = await made(rivera.token, 'activities', { title: 'Inventory', date: '2026-02-01', end_date: '2026-02-03' });
  assert.throws(() => db.prepare('UPDATE activities SET end_date = ? WHERE id = ?').run('2026-01-31', entry.id), /timeframe:/);
  assert.throws(() => db.prepare('UPDATE activities SET ongoing = 1 WHERE id = ?').run(entry.id), /timeframe:/, 'ongoing with an end date');
  assert.throws(() => db.prepare("UPDATE activities SET start_time = '24:00' WHERE id = ?").run(entry.id), /CHECK constraint/);
  assert.throws(() => db.prepare("UPDATE unit_members SET assignment_start = '2027-01-01', assignment_end = '2026-01-01' WHERE user_id = ?").run(rivera.id), /timeframe:/);
  // A change that leaves the dates alone is not checked.
  db.prepare('UPDATE activities SET title = ? WHERE id = ?').run('Inventory of the cage', entry.id);

  // Two rows of one import that each pass alone and together would put an entry out of order: the database refuses
  // the second, the API says so as a request to correct, and nothing of the import is kept.
  const lone = await made(rivera.token, 'activities', { title: 'Stocktake', date: '2026-02-01' });
  const res = await post(rivera.token, '/api/records/activities/import', { rows: [
    { id: lone.id, title: 'Stocktake', date: '2026-02-01', end_date: '2026-02-10' },
    { id: lone.id, title: 'Stocktake', date: '2026-02-20' },
    { title: 'A row that would have been new', date: '2026-02-02' },
  ] });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.equal(res.body.code, 'timeframe');
  assert.deepEqual([rowOf('activities', lone.id).date, rowOf('activities', lone.id).end_date], ['2026-02-01', null]);
  assert.equal(db.prepare("SELECT 1 FROM activities WHERE title = 'A row that would have been new'").get(), undefined);
});

test('the import refuses a row out of order by its number, and judges a row that updates an entry with its other dates', async () => {
  const entry = await made(rivera.token, 'activities', { title: 'Reconciled ULOs', date: '2026-06-01', end_date: '2026-06-05' });
  const backwards = await post(rivera.token, '/api/records/activities/import', { rows: [{ title: 'Fine', date: '2026-06-01' }, { title: 'Backwards', date: '2026-06-09', end_date: '2026-06-01' }] });
  assert.equal(backwards.status, 400);
  assert.match(backwards.body.error, /^Row 2: An activity cannot end before it starts\./);
  const update = await post(rivera.token, '/api/records/activities/import', { rows: [{ id: entry.id, title: 'Reconciled ULOs', date: '2026-06-09' }] });
  assert.equal(update.status, 400, 'the start moved past the end the entry keeps');
  assert.match(update.body.error, /^Row 1: /);
  const fine = await post(rivera.token, '/api/records/activities/import', { rows: [{ id: entry.id, title: 'Reconciled ULOs', date: '2026-06-02', start_time: '0800' }] });
  assert.equal(fine.status, 200, JSON.stringify(fine.body));
  assert.deepEqual([rowOf('activities', entry.id).date, rowOf('activities', entry.id).end_date, rowOf('activities', entry.id).start_time], ['2026-06-02', '2026-06-05', '08:00']);
});

test('a record saved out of order before 026 is kept, counted, editable in its other fields, and put in order when its dates change', async () => {
  const goal = await made(rivera.token, 'goals', { title: 'Close the Q3 backlog', period_start: '2026-07-01', period_end: '2026-09-30' });
  dropTimeframeTriggers(app.ctx.db);
  app.ctx.db.prepare('UPDATE goals SET period_end = ? WHERE id = ?').run('2026-06-15', goal.id);
  timeframeTriggers(app.ctx.db);
  assert.deepEqual(timeframeViolations(app.ctx.db), { goals: 1 });
  assert.ok(migrationStatus(app.ctx).notes.some((n) => n.startsWith('1 record ends before it starts (goals 1)')), JSON.stringify(migrationStatus(app.ctx).notes));

  const renamed = await edit(rivera.token, 'goals', goal.id, { title: 'Close the Q3 UMT backlog' });
  assert.equal(renamed.status, 200, `an edit that leaves the dates alone: ${JSON.stringify(renamed.body)}`);
  const still = await edit(rivera.token, 'goals', goal.id, { period_end: '2026-06-20' });
  assert.equal(still.status, 400);
  assert.ok(still.body.fieldErrors.period_end);
  const fixed = await edit(rivera.token, 'goals', goal.id, { period_end: '2026-09-30' });
  assert.equal(fixed.status, 200);
  assert.deepEqual(timeframeViolations(app.ctx.db), {});
  assert.ok(!migrationStatus(app.ctx).notes.some((n) => /before (it|they) starts?/.test(n)), 'the note goes once each is in order');
});

test('an assignment and a responsibility keep the same rule, in the same words', async () => {
  const assignment = await put(op.token, `/api/org/units/G8/members/${rivera.id}`, { assignment_start: '2026-10-01', assignment_end: '2026-09-01' });
  assert.equal(assignment.status, 400);
  assert.equal(assignment.body.error, 'The assignment cannot end before it starts.');
  assert.ok(assignment.body.fieldErrors.assignment_end);
  const duty = await post(op.token, `/api/org/units/G8/members/${rivera.id}/responsibilities`, { title: 'Safety NCO', starts_on: '2026-10-01', ends_on: '2026-09-30' });
  assert.equal(duty.status, 400);
  assert.equal(duty.body.error, 'A responsibility cannot end before it starts.');
  assert.ok(duty.body.fieldErrors.ends_on);
});

// ---------------------------------------------------------------------------------------------------------------------
// Readers

test('lists, evaluation inputs, analysis, metrics, the timeline and the export all read a range, and count it once', async () => {
  // February 2025 for Kim: one entry runs into it from January and on into March, one is a single day in it, one has
  // been going on since December, one comes after it; a course runs across its start; an award recognizes a period
  // that includes February but was given in April.
  const across = await made(kim.token, 'activities', { title: 'Audit support', date: '2025-01-20', end_date: '2025-03-10', quantity: 30, unit_label: 'ULOs' });
  const single = await made(kim.token, 'activities', { title: 'Inventory', date: '2025-02-05' });
  const going = await made(kim.token, 'activities', { title: 'Watch bill', date: '2024-12-01', ongoing: true });
  const later = await made(kim.token, 'activities', { title: 'Range day', date: '2025-04-02' });
  const course = await made(kim.token, 'trainings', { title: 'Corporals Course', date: '2025-01-27', end_date: '2025-02-07', hours: 80, status: 'completed' });
  await made(kim.token, 'awards', { name: 'Certificate of Commendation', period_start: '2025-01-01', date: '2025-04-15', status: 'presented' });
  const feb = 'from=2025-02-01&to=2025-02-28';
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort();

  assert.deepEqual(ids((await get(kim.token, `/api/records/activities?${feb}`)).body), [across.id, single.id, going.id].sort());
  assert.deepEqual(ids((await get(kim.token, `/api/records/trainings?${feb}`)).body), [course.id]);
  assert.deepEqual((await get(kim.token, `/api/records/awards?${feb}`)).body, [], 'the award was given in April');
  assert.deepEqual(ids((await get(kim.token, '/api/records/activities?from=2025-04-01&to=2025-04-30')).body), [later.id, going.id].sort(), 'what is still going on is in April too');

  const report = await get(kim.token, `/api/reports?period=custom&${feb}`);
  assert.equal(report.status, 200, JSON.stringify(report.body).slice(0, 300));
  assert.deepEqual(report.body.counts, { activities: 3, awards: 0, trainingHours: 80 });
  const march = await get(kim.token, '/api/reports?period=custom&from=2025-03-01&to=2025-03-31');
  assert.equal(march.body.counts.activities, 2, 'every period it touches: the January to March entry is in March too');

  const analysis = await get(kim.token, `/api/reports/analysis?period=custom&${feb}`);
  assert.equal(analysis.status, 200, JSON.stringify(analysis.body).slice(0, 300));
  assert.equal(analysis.body.counts.current, 3);
  assert.deepEqual(analysis.body.monthly.map((m: { month: string; entries: number }) => [m.month, m.entries]), [['2025-02', 3]], 'each counted once, in the month');
  assert.equal(analysis.body.consistency.activeDays, 2, 'the two begun before February on its first day, the inventory on its own');
  assert.equal(analysis.body.career.trainingHours, 80);

  const metrics = await get(kim.token, `/api/metrics?scope=me&${feb}`);
  assert.equal(metrics.status, 200, JSON.stringify(metrics.body).slice(0, 300));
  const ulos = (metrics.body.headline as Array<{ metricId: string; unit: string; value: number }>).find((t) => /ulo/i.test(t.unit));
  assert.ok(ulos, JSON.stringify(metrics.body.headline));
  assert.equal(ulos!.value, 30, 'the whole amount, once');
  const contributors = await get(kim.token, `/api/metrics/contributors?scope=me&${feb}&metric_id=${encodeURIComponent(ulos!.metricId)}`);
  assert.equal(contributors.status, 200, JSON.stringify(contributors.body));
  assert.deepEqual(contributors.body.map((c: { date: string; end_date: string | null; ongoing: boolean }) => [c.date, c.end_date, c.ongoing]), [['2025-01-20', '2025-03-10', false]], 'shown with its own dates');

  const timeline = await get(kim.token, `/api/record/timeline?${feb}`);
  assert.equal(timeline.status, 200);
  const items = timeline.body.items as Array<{ id: string; date: string; end_date: string | null; ongoing: boolean }>;
  assert.deepEqual(ids(items), [across.id, single.id, going.id, course.id].sort());
  assert.deepEqual(items.filter((i) => i.id === across.id).map((i) => [i.date, i.end_date, i.ongoing]), [['2025-01-20', '2025-03-10', false]]);
  assert.equal(items.find((i) => i.id === going.id)?.ongoing, true);

  const csv = await get(kim.token, `/api/reports/csv?period=custom&${feb}`);
  assert.equal(csv.status, 200);
  const exported = parseCsvText(csv.text);
  assert.deepEqual(exported.rows.map((r) => r.Title).sort(), ['Audit support', 'Inventory', 'Watch bill']);
  assert.equal(exported.rows.find((r) => r.Title === 'Watch bill')?.['End Date'], 'Present');
  assert.equal(exported.rows.find((r) => r.Title === 'Audit support')?.['End Date'], '2025-03-10');
});

test('a spreadsheet carries the range: End Date, times and Ongoing go out and come back as they were', () => {
  const rows = [
    { id: 'a1', date: '2026-01-06', end_date: '2026-02-14', start_time: '07:30', end_time: '16:30', ongoing: 0, title: 'Course', status: 'completed', evidence_links: [] },
    { id: 'a2', date: '2026-03-01', end_date: null, ongoing: 1, title: 'Audit support', status: 'completed', evidence_links: [] },
  ];
  const parsed = parseCsvText(rowsToCsv(rows.map(activityToCsvRow), ACTIVITY_CSV_COLUMNS.map((c) => c.header)));
  const { records, problems } = applyMapping(parsed.rows, guessMapping(parsed.columns));
  assert.deepEqual(problems, []);
  assert.deepEqual(records.map((r) => [r.id, r.date, r.end_date, r.start_time, r.end_time, r.ongoing]), [
    ['a1', '2026-01-06', '2026-02-14', '07:30', '16:30', false],
    ['a2', '2026-03-01', null, null, null, true],
  ]);

  // A sheet of one's own, in one's own words.
  const own = parseCsvText([
    'Title,Start Date,Through,Start Time,End Time',
    'Night watch,2026-05-01,2026-05-02,2200,0600',
    'Backwards,2026-05-03,2026-05-01,,',
    'Same day,2026-05-01,,4:00 PM,8:00 AM',
    'Late,2026-05-01,,25:00,',
    'Still going,2026-04-01,Present,,',
  ].join('\n'));
  const mapping = guessMapping(own.columns);
  assert.deepEqual([mapping.date, mapping.end_date, mapping.start_time, mapping.end_time, mapping.ongoing], ['Start Date', 'Through', 'Start Time', 'End Time', undefined]);
  const mine = applyMapping(own.rows, mapping);
  assert.deepEqual(mine.problems, [
    { row: 3, issue: 'An activity cannot end before it starts.' },
    { row: 4, issue: 'The end time is before the start time on the same day. A record cannot end before it starts.' },
    { row: 5, issue: 'unreadable start time' },
  ]);
  assert.deepEqual(mine.records.map((r) => [r.title, r.end_date, r.start_time, r.end_time, r.ongoing]), [
    ['Night watch', '2026-05-02', '22:00', '06:00', false],
    ['Still going', null, null, null, true],
  ]);
  // An older export, with Date and no End Date, maps nothing onto the end.
  assert.equal(guessMapping(['Date', 'Title', 'Status']).end_date, undefined);
});

test('a move carries the range: a course keeps its days and times, an activity’s days become an award’s period, and back', async () => {
  const move = (table: string, id: string, to: string) => post(rivera.token, `/api/records/${table}/${id}/move`, { to, reason: 'It is one' });
  const course = await made(rivera.token, 'activities', { title: 'Completed Corporals Course', date: '2026-03-02', end_date: '2026-03-13', start_time: '0730', end_time: '1630' });
  const training = await move('activities', course.id, 'trainings');
  assert.equal(training.status, 201, JSON.stringify(training.body));
  const t = rowOf('trainings', training.body.id);
  assert.deepEqual([t.date, t.end_date, t.start_time, t.end_time, t.ongoing, t.status], ['2026-03-02', '2026-03-13', '07:30', '16:30', 0, 'completed']);

  const loa = await made(rivera.token, 'activities', { title: 'Received a Letter of Appreciation from the CO', date: '2026-04-01', end_date: '2026-06-30' });
  const award = await move('activities', loa.id, 'awards');
  assert.equal(award.status, 201, JSON.stringify(award.body));
  const w = rowOf('awards', award.body.id);
  assert.deepEqual([w.period_start, w.date, w.presented_at], ['2026-04-01', '2026-06-30', '2026-06-30'], 'the period it recognizes, given on its last day');
  const back = await post(rivera.token, `/api/records/awards/${award.body.id}/undo-move`);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual([rowOf('activities', loa.id).date, rowOf('activities', loa.id).end_date], ['2026-04-01', '2026-06-30']);

  const running = await made(rivera.token, 'activities', { title: 'Started MarineNet course on fiscal law', date: '2026-09-01', ongoing: true, kind_confirmed: true });
  const enrolled = await move('activities', running.id, 'trainings');
  assert.equal(enrolled.status, 201, JSON.stringify(enrolled.body));
  assert.deepEqual([rowOf('trainings', enrolled.body.id).ongoing, rowOf('trainings', enrolled.body.id).status], [1, 'in_progress'], 'still going on, so in progress');
});

test('retention runs from a record’s end, and never for one still going on', async () => {
  const fresh = await startApp();
  try {
    const owner = await fresh.setupOperator();
    const add = async (body: Record<string, unknown>) => {
      const res = await fresh.call('POST', '/api/records/activities', { token: owner.token, body: { visibility: 'unit', unit_id: 'G8', ...body } });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.id as string;
    };
    const recent = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    const ended = await add({ title: 'Exercise long past', date: '2020-01-01', end_date: '2020-01-05' });
    const long = await add({ title: 'Effort that ended last month', date: '2020-01-01', end_date: recent });
    const going = await add({ title: 'Effort still going on', date: '2020-01-01', ongoing: true });
    saveSchedule(fresh.ctx, 'G8', { record_type: 'activities', retain_days: 365, disposition: 'anonymize', enabled: true }, owner.id);
    const run = runDisposition(fresh.ctx, { orgId: 'G8', dryRun: false, actorId: owner.id });
    assert.equal(run.lines.find((l) => l.record_type === 'activities')?.acted, 1);
    const title = (id: string) => (fresh.ctx.db.prepare('SELECT title FROM activities WHERE id = ?').get(id) as { title: string }).title;
    assert.equal(title(ended), REDACTED);
    assert.equal(title(long), 'Effort that ended last month', 'its clock runs from its end, not its start');
    assert.equal(title(going), 'Effort still going on', 'it has not ended');
  } finally { await fresh.close(); }
});

test('an archive from before 026 loads with its entries single days, not ongoing, and what it holds out of order counted', async () => {
  type Archive = Parameters<typeof importInstance>[1] & { tables: Record<string, Array<Record<string, unknown>>> };
  const archive = JSON.parse(JSON.stringify(exportInstance(app.ctx))) as Archive;
  assert.ok(archive.tables.activities.some((a) => a.ongoing === 1 || a.end_date), 'the archive carries the new columns');
  const legacy = structuredClone(archive);
  for (const table of ['activities', 'trainings']) legacy.tables[table] = legacy.tables[table].map(({ end_date: _e, start_time: _s, end_time: _t, ongoing: _o, ...rest }) => rest);
  legacy.tables.awards = legacy.tables.awards.map(({ period_start: _p, ...rest }) => rest);
  // A goal its owner entered with the deadline before the start, as nothing refused before 026.
  const goal = legacy.tables.goals.find((g) => g.period_start && g.period_end)!;
  goal.period_end = '2020-01-01';

  const older = await startApp();
  try {
    const olderOp = await older.setupOperator();
    importInstance(older.ctx, legacy, olderOp.id);
    const db = older.ctx.db;
    assert.deepEqual({ ...(db.prepare('SELECT COUNT(*) AS n FROM activities WHERE ongoing <> 0 OR end_date IS NOT NULL OR start_time IS NOT NULL').get() as object) }, { n: 0 });
    assert.deepEqual({ ...(db.prepare('SELECT COUNT(*) AS n FROM awards WHERE period_start IS NOT NULL').get() as object) }, { n: 0 });
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n, archive.tables.activities.length, 'every entry came in');
    assert.deepEqual(timeframeViolations(db), { goals: 1 });
    assert.deepEqual(JSON.parse(metaGet(db, 'timeframe_violations')!).found, { goals: 1 });
    const detail = (db.prepare("SELECT detail FROM audit_log WHERE action = 'instance_import' ORDER BY rowid DESC").get() as { detail: string }).detail;
    assert.match(detail, /ending before they start: \{"goals":1\}/);
    // The triggers are back once it is in.
    const at = new Date().toISOString();
    assert.throws(() => db.prepare("INSERT INTO goals (id, user_id, title, period_start, period_end, created_at, updated_at) VALUES ('g-after', ?, 'after', '2026-09-01', '2026-06-30', ?, ?)").run(olderOp.id, at, at), /timeframe:/);
  } finally { await older.close(); }

  // The current archive comes back whole, ranges and all.
  const fresh = await startApp();
  try {
    const freshOp = await fresh.setupOperator();
    importInstance(fresh.ctx, archive, freshOp.id);
    for (const a of archive.tables.activities) {
      const row = { ...(fresh.ctx.db.prepare('SELECT date, end_date, start_time, end_time, ongoing FROM activities WHERE id = ?').get(a.id) as object) };
      assert.deepEqual(row, { date: a.date, end_date: a.end_date, start_time: a.start_time, end_time: a.end_time, ongoing: a.ongoing });
    }
    assert.equal(metaGet(fresh.ctx.db, 'timeframe_violations'), null, 'nothing out of order, nothing counted');
  } finally { await fresh.close(); }
});

test('two entries of one title on one day are told apart by their start time, and one with no time keeps its fingerprint', async () => {
  const watch = { title: 'Staff duty', date: '2026-06-10' };
  const day = await made(rivera.token, 'activities', { ...watch, start_time: '0800', end_time: '1600' });
  const night = await made(rivera.token, 'activities', { ...watch, start_time: '1600', end_date: '2026-06-11', end_time: '0800' });
  assert.notEqual(rowOf('activities', day.id).fingerprint, rowOf('activities', night.id).fingerprint);
  // The same watch again, however its time is written, is still a duplicate.
  const again = await post(rivera.token, '/api/records/activities', { ...watch, start_time: '08:00' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'duplicate');
  // Untimed, it is fingerprinted as every entry was before 026, so none written then changes.
  const untimed = await made(rivera.token, 'activities', watch);
  assert.equal(rowOf('activities', untimed.id).fingerprint, createHash('sha256').update([rivera.id, '2026-06-10', 'staff duty', '', ''].join('|')).digest('hex'));
});

test('an entry typed with one day is that day, as every entry before 026 was', async () => {
  const entry = await made(rivera.token, 'activities', { title: 'Cleared the suspense', date: today() });
  assert.deepEqual([entry.end_date, entry.start_time, entry.end_time, entry.ongoing], [null, null, null, 0]);
  const listed = (await get(rivera.token, `/api/records/activities?from=${today()}&to=${today()}`)).body as Array<{ id: string }>;
  assert.ok(listed.some((r) => r.id === entry.id));
});
