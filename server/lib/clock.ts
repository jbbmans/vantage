/** A Date whose local calendar fields match the wall clock in the given IANA timezone, for period math that runs on a UTC server. */
export function zonedNow(timezone: string, at = new Date()): Date {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || 0);
    return new Date(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  } catch { return at; }
}
