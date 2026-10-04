import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PERIOD, PERIOD_OPTIONS, rangeForPeriod, dayKey } from '../../shared/metrics.ts';

test('lists and reports open on a rolling year, so a new fiscal year does not look like no work at all', () => {
  assert.equal(DEFAULT_PERIOD, 'last12');
  assert.ok(PERIOD_OPTIONS.some((p) => p.value === 'last12' && p.label === 'Last 12 months'));
  // Four days into FY27, "Fiscal year" holds four days; the rolling year still holds September's close-out.
  const at = new Date(2026, 9, 4, 9, 30);
  const fy = rangeForPeriod('fiscalYear', at);
  const rolling = rangeForPeriod('last12', at);
  assert.equal(dayKey(fy.start), '2026-10-01');
  assert.equal(dayKey(rolling.start), '2025-10-05');
  assert.equal(dayKey(rolling.end), '2026-10-05', 'through tomorrow, for whoever is east of the server');
  assert.equal(rolling.label, 'Last 12 months');
});

test('a Quick Log title loses the date and the word that introduced it', async () => {
  const { parseQuickLog } = await import('../../shared/quickLog.ts');
  const now = new Date(2026, 9, 4);
  assert.equal(parseQuickLog('Reconciled 30 ULOs totaling $1,118.38 in DAI on Sep 30', now).title, 'Reconciled 30 ULOs totaling $1,118.38 in DAI');
  assert.equal(parseQuickLog('Closed 14 UDOs on Friday in DAI', now).title, 'Closed 14 UDOs in DAI');
  assert.equal(parseQuickLog('Ran the report as of 30 Sep for G-8', now).title, 'Ran the report for G-8');
  assert.equal(parseQuickLog('Briefed the section yesterday', now).title, 'Briefed the section');
});

test('a goal says whether it is on pace for the share of its period gone, and only when that means something', async () => {
  const { goalPace } = await import('../../shared/metricEngine.ts');
  const goal = { direction: 'increase', status: 'active', period_start: '2026-10-01', period_end: '2026-12-30' }; // 91 days
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 21, 0); // evening, where a UTC reading slips a day
  // 45 of 91 days gone: 49 expected, and within ten points either way is on pace.
  assert.deepEqual(goalPace(goal, { percent: 45, met: false }, at(2026, 11, 15)), { pace: 'on', expected: 49 });
  assert.equal(goalPace(goal, { percent: 30, met: false }, at(2026, 11, 15))?.pace, 'behind');
  assert.equal(goalPace(goal, { percent: 70, met: false }, at(2026, 11, 15))?.pace, 'ahead');
  assert.equal(goalPace({ ...goal, direction: 'decrease' }, { percent: 30, met: false }, at(2026, 11, 15))?.pace, 'behind');
  // Too early to say, over, met, or not the kind of goal that builds a little at a time: nothing.
  assert.equal(goalPace(goal, { percent: 0, met: false }, at(2026, 10, 5)), null);
  assert.equal(goalPace(goal, { percent: 40, met: false }, at(2026, 12, 31)), null);
  assert.equal(goalPace(goal, { percent: 100, met: true }, at(2026, 11, 15)), null);
  assert.equal(goalPace({ ...goal, direction: 'threshold' }, { percent: 90, met: false }, at(2026, 11, 15)), null);
  assert.equal(goalPace({ ...goal, direction: 'completion' }, { percent: 0, met: false }, at(2026, 11, 15)), null);
  assert.equal(goalPace({ ...goal, status: 'paused' }, { percent: 0, met: false }, at(2026, 11, 15)), null);
  assert.equal(goalPace({ ...goal, period_end: null }, { percent: 0, met: false }, at(2026, 11, 15)), null);
});

test('a bullet does not repeat a dollar figure its title already states', async () => {
  const { composeBullet } = await import('../../shared/bullets.ts');
  const plain = composeBullet({ title: 'Reconciled 14 ULOs totaling $48,250 in DAI', quantity: 14, unit_label: 'ULOs', dollar_amount: 48250 });
  assert.equal(plain.match(/48,250/g)?.length, 1, plain);
  const scaled = composeBullet({ title: 'Deobligated $1.2 million in expired funds', dollar_amount: 1_200_000 });
  assert.ok(!scaled.includes('1,200,000'), scaled);
  // A different figure in the title is not the amount, so the amount is still said.
  const other = composeBullet({ title: 'Reviewed a $500 invoice batch', dollar_amount: 12000 });
  assert.ok(other.includes('$12,000.00'), other);
});

test('Quick Log takes a closing clause that says what came of the work as the outcome', async () => {
  const { parseQuickLog } = await import('../../shared/quickLog.ts');
  const now = new Date(2026, 9, 4, 10);
  const ulos = parseQuickLog('Reconciled 14 ULOs totaling $48,250 in DAI on Sep 30, all cleared on the next report', now);
  assert.equal(ulos.title, 'Reconciled 14 ULOs totaling $48,250 in DAI');
  assert.equal(ulos.result, 'all cleared on the next report');
  assert.equal(parseQuickLog('Processed 12 MIPRs, resulting in zero returns', now).result, 'zero returns');
  assert.equal(parseQuickLog('Rebuilt the UMT tracker - which cut the weekly review to an hour', now).result, 'cut the weekly review to an hour');
  // A list after a comma is not an outcome, and neither is a word that only looks like a lead-in.
  const list = parseQuickLog('Built the tracker for G-8, S-4 and S-1', now);
  assert.equal(list.result, null);
  assert.equal(list.title, 'Built the tracker for G-8, S-4 and S-1');
  assert.equal(parseQuickLog('Briefed the CO, nobody else', now).result, null);
});

test('a narrative headline counts work done, not kilometres or hours', async () => {
  const { composeNarrative } = await import('../../shared/narrative.ts');
  const area = 'MOS / Mission Accomplishment';
  const mixed = composeNarrative([
    { title: 'Cleared 4 2-Way UMTs on the Q4 report', quantity: 4, unit_label: 'UMTs', dollar_amount: 6206, dollar_type: 'reconciled', eval_area: area },
    { title: 'Volunteered at the base food pantry', quantity: 6, unit_label: 'hours', eval_area: area },
    { title: 'Led section PT: 10 km hike', quantity: 10, unit_label: 'km', eval_area: area },
  ]).text;
  assert.match(mixed, /^MISSION: Processed 4 UMTs valued at \$6K\./, mixed);
  assert.ok(!/processed[^.]*\bkm\b/i.test(mixed) && !/processed[^.]*hours/i.test(mixed), mixed);
  // With nothing countable, the headline says how much was done and for how long.
  const hours = composeNarrative([{ title: 'Volunteered at the base food pantry', quantity: 6, unit_label: 'hours', eval_area: area }]).text;
  assert.match(hours, /^MISSION: Completed 1 documented action over 6 hours\./, hours);
});
