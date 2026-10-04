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
