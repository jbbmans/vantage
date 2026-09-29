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
