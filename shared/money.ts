/**
 * Money as integer minor units.
 *
 * A financial figure that passes through a binary float can come back a cent off, and a cent off
 * on an award modification is a wrong answer, not a rounding detail. Every amount the case model
 * stores or calculates is an integer count of cents with an explicit currency, parsed from text
 * without ever multiplying a float by 100.
 *
 * The older record tables (activities, work_items.amount) still hold REAL dollars. They are left
 * alone rather than rewritten in place; new financial facts use this module.
 */

export const CURRENCY = 'USD' as const;
export type Currency = typeof CURRENCY;

/** An amount the case model holds: always whole cents, always labelled with its currency. */
export interface Money { cents: number; currency: Currency }

const MAX_CENTS = Number.MAX_SAFE_INTEGER;

/**
 * Reads what a person typed or what a sheet held: "$91,250.00", "91250", "(1,000.00)", "-1000.5".
 * More than two decimal places is refused rather than rounded, because silently rounding an entry
 * changes a value somebody read off an authoritative system.
 */
export function parseMoney(input: unknown): { ok: true; cents: number } | { ok: false; error: string } {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, error: 'Not a number.' };
    // A number arriving from JSON is re-read through its decimal text so 0.1 + 0.2 style drift
    // cannot enter. toFixed would round; the string form is what the sender meant.
    return parseMoney(String(input));
  }
  if (typeof input !== 'string') return { ok: false, error: 'Enter an amount.' };
  let text = input.trim().replace(/[\s,$]/g, '').replace(/^USD/i, '');
  if (!text) return { ok: false, error: 'Enter an amount.' };
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }
  else if (text.startsWith('+')) text = text.slice(1);
  if (/e/i.test(text)) return { ok: false, error: 'Write the amount out in full.' };
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return { ok: false, error: 'That is not an amount.' };
  const [, whole, fraction = ''] = match;
  if (fraction.length > 2) return { ok: false, error: 'Use at most two decimal places.' };
  const big = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
  if (big > BigInt(MAX_CENTS)) return { ok: false, error: 'That amount is too large.' };
  const cents = Number(big);
  // No negative zero: "-0.00" is zero.
  return { ok: true, cents: negative && cents !== 0 ? -cents : cents };
}

export function assertCents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Not a whole number of cents: ${value}`);
  return value;
}

/** Sums whole cents, refusing anything that is not one. Never touches a float. */
export function sumCents(values: number[]): number {
  let total = 0n;
  for (const v of values) total += BigInt(assertCents(v));
  if (total > BigInt(MAX_CENTS) || total < -BigInt(MAX_CENTS)) throw new Error('Sum is out of range.');
  return Number(total);
}

/** "$91,250.00". With `signed`, a positive figure carries its "+" so a direction is never implied by colour alone. */
export function formatCents(cents: number, opts: { signed?: boolean } = {}): string {
  assertCents(cents);
  const negative = cents < 0;
  const abs = BigInt(Math.abs(cents));
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (abs % 100n).toString().padStart(2, '0');
  const sign = negative ? '−' : opts.signed && cents > 0 ? '+' : '';
  return `${sign}$${whole}.${fraction}`;
}

/** Plain decimal text for an input field: 91250.00 → "91250.00". */
export const centsToInput = (cents: number) => {
  assertCents(cents);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  return `${negative ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
