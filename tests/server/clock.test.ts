import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zonedDayBounds, zonedDayStart, zonedDateOf } from '../../server/lib/clock.ts';

test('a local day is turned into the UTC instants it really spans, so evening work stays on its day', () => {
  const [lo, hi] = zonedDayBounds('America/New_York', '2026-10-01', '2026-10-01');
  assert.equal(lo, '2026-10-01T04:00:00.000Z');
  assert.equal(hi, '2026-10-02T03:59:59.999Z');
  const nineFortyFivePm = '2026-10-02T01:45:00.000Z';
  assert.ok(nineFortyFivePm >= lo && nineFortyFivePm <= hi, 'work at 2145 Eastern on 1 Oct counts on 1 Oct');
  assert.equal(zonedDateOf('America/New_York', nineFortyFivePm), '2026-10-01');
});

test('a day the clocks change is 23 or 25 hours long, not 24', () => {
  const spring = zonedDayBounds('America/Chicago', '2026-03-08', '2026-03-08');
  assert.equal(Date.parse(spring[1]) + 1 - Date.parse(spring[0]), 23 * 3_600_000);
  const fall = zonedDayBounds('America/Chicago', '2026-11-01', '2026-11-01');
  assert.equal(Date.parse(fall[1]) + 1 - Date.parse(fall[0]), 25 * 3_600_000);
});

test('a timezone ahead of UTC starts its day the evening before in UTC', () => {
  assert.equal(zonedDayStart('Asia/Tokyo', '2026-10-01').toISOString(), '2026-09-30T15:00:00.000Z');
  assert.equal(zonedDayStart('UTC', '2026-10-01').toISOString(), '2026-10-01T00:00:00.000Z');
});
