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
