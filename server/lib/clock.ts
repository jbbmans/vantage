/** YYYY-MM-DD from a date's local fields. Pair it with zonedNow, whose local fields hold the instance's wall clock. */
export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The calendar day in the instance's timezone, not UTC: after 7pm Central the UTC date is already tomorrow. */
export function zonedDay(timezone: string, offsetDays = 0, at = new Date()): string {
  const d = zonedNow(timezone, at);
  d.setDate(d.getDate() + offsetDays);
  return isoDay(d);
}

// Building a formatter costs far more than using one, and the instance has one timezone.
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timezone: string) => {
  let f = formatters.get(timezone);
  if (!f) formatters.set(timezone, f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return f;
};

export function zonedNow(timezone: string, at = new Date()): Date {
  try {
    const parts = formatterFor(timezone).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
    return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  } catch { return at; }
}

/**
 * The UTC instant a calendar day begins in the instance's timezone. Stored timestamps are UTC, so a window of local
 * days has to be turned into UTC instants before comparing: treating "2026-10-01" as midnight UTC would drop
 * everything done after 8pm Eastern from that day.
 */
export function zonedDayStart(timezone: string, day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  let t = target;
  // Two passes settle the offset even on a day the clocks change.
  for (let i = 0; i < 2; i += 1) {
    const local = zonedNow(timezone, new Date(t));
    const wall = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds());
    t = target - (wall - t);
  }
  return new Date(t);
}

/** The local calendar day an instant falls on in the instance's timezone. */
export const zonedDateOf = (timezone: string, instant: string | Date): string => isoDay(zonedNow(timezone, new Date(instant)));

/** The calendar day after a YYYY-MM-DD day. */
const dayAfter = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};

/** [first instant, last instant] of a run of local days, as UTC ISO strings for comparing with stored timestamps. */
export function zonedDayBounds(timezone: string, from: string, to: string): [string, string] {
  return [zonedDayStart(timezone, from).toISOString(), new Date(zonedDayStart(timezone, dayAfter(to)).getTime() - 1).toISOString()];
}
