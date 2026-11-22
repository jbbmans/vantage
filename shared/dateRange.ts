import { startOfDay, endOfDay, parseISO } from 'date-fns';
import { DEFAULT_PERIOD, PERIOD_OPTIONS, dayKey, formatDTG, isCalendarDay, rangeForPeriod, type PeriodKey } from './metrics.ts';
import type { DateRange } from './types.ts';

/**
 * A range of days a person chooses for a list, a report or an export (ADR-0038): a first and a last day, both included.
 * The server's check and the picker's message come from here, so a refused request and the form say the same words.
 */

/** Two years, counted with both ends: 2025-01-01 to 2026-12-31 is 730 days, and one leap day still fits. */
export const MAX_RANGE_DAYS = 731;

/**
 * The period value for a range chosen day by day. It is not one of PERIOD_OPTIONS, so it is never a saved preference,
 * a unit's default or a saved report's rolling period.
 */
export const CUSTOM_PERIOD = 'custom';
export const CUSTOM_LABEL = 'Custom dates';
export type PeriodChoice = PeriodKey | typeof CUSTOM_PERIOD;

/** Every period a request may name: the offered presets, the quarter the API has always taken, and custom dates. */
export const PERIOD_CHOICES: readonly PeriodChoice[] = [...PERIOD_OPTIONS.map((p) => p.value), 'quarter', CUSTOM_PERIOD];
export const isPeriodChoice = (v: unknown): v is PeriodChoice => typeof v === 'string' && (PERIOD_CHOICES as readonly string[]).includes(v);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The years a day may name, as isoDate has always held them: All time from 1970 fits, a year 9999 that only costs the server does not. */
export const FIRST_YEAR = 1940;
export const LAST_YEAR = 2100;

/** A calendar day inside the years a range may name. */
export function isRangeDay(value: string): boolean {
  if (!isCalendarDay(value)) return false;
  const year = Number(value.slice(0, 4));
  return year >= FIRST_YEAR && year <= LAST_YEAR;
}

/** The days from `from` to `to`, both counted: the same day is 1. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export const RANGE_TEXT = {
  notDate: 'Must be a date (YYYY-MM-DD).',
  notReal: 'Not a real calendar date.',
  outOfYears: `Use a day from ${FIRST_YEAR} to ${LAST_YEAR}.`,
  badDays: 'Use real days, written YYYY-MM-DD.',
  addFrom: 'Add the first day.',
  addTo: 'Add the last day.',
  bothDays: 'A range needs both days: the first and the last.',
  onOrAfter: 'On or after the first day.',
  backwards: 'The range ends before it starts.',
  tooLongField: `At most ${MAX_RANGE_DAYS} days, both ends counted.`,
  tooLong: `Choose a range of ${MAX_RANGE_DAYS} days or fewer.`,
} as const;

/** What is wrong with one side of a range, or null when it is a day a range may name. */
export function dayProblem(value: string): string | null {
  if (!DAY.test(value)) return RANGE_TEXT.notDate;
  if (!isCalendarDay(value)) return RANGE_TEXT.notReal;
  if (!isRangeDay(value)) return RANGE_TEXT.outOfYears;
  return null;
}

export interface RangeProblem { fieldErrors: Partial<Record<'from' | 'to', string>>; message: string }

const given = (v: unknown) => v !== undefined && v !== null && v !== '';

/**
 * What is wrong with a range, by field, or null when nothing is: each side a real day, both or neither, the first not
 * after the last, and no more than MAX_RANGE_DAYS. `required` is for custom dates, which need both days. A value that
 * is not a string (a key sent twice arrives as a list) is refused as not a date.
 */
export function rangeProblems(from: unknown, to: unknown, { required = false }: { required?: boolean } = {}): RangeProblem | null {
  const fieldErrors: RangeProblem['fieldErrors'] = {};
  for (const [field, value] of [['from', from], ['to', to]] as const) {
    if (!given(value)) continue;
    const problem = typeof value === 'string' ? dayProblem(value) : RANGE_TEXT.notDate;
    if (problem) fieldErrors[field] = problem;
  }
  if (fieldErrors.from || fieldErrors.to) return { fieldErrors, message: RANGE_TEXT.badDays };
  if (!given(from) && !given(to)) return required ? { fieldErrors: { from: RANGE_TEXT.addFrom, to: RANGE_TEXT.addTo }, message: RANGE_TEXT.bothDays } : null;
  if (!given(from)) return { fieldErrors: { from: RANGE_TEXT.addFrom }, message: RANGE_TEXT.bothDays };
  if (!given(to)) return { fieldErrors: { to: RANGE_TEXT.addTo }, message: RANGE_TEXT.bothDays };
  const [a, b] = [from as string, to as string];
  if (b < a) return { fieldErrors: { to: RANGE_TEXT.onOrAfter }, message: RANGE_TEXT.backwards };
  if (spanDays(a, b) > MAX_RANGE_DAYS) return { fieldErrors: { to: RANGE_TEXT.tooLongField }, message: RANGE_TEXT.tooLong };
  return null;
}

/** "01 MAR 26 to 31 MAR 26", as a report labels a custom range. */
export const rangeLabel = (from: string, to: string) => `${formatDTG(from)} to ${formatDTG(to)}`;

/** A range of days as the period helpers take it: the first day's start to the last day's end, on the local clock. */
export function rangeOfDays(from: string, to: string): DateRange & { label: string } {
  return { start: startOfDay(parseISO(from)), end: endOfDay(parseISO(to)), label: rangeLabel(from, to) };
}

/** The days a preset covers on a given day, as YYYY-MM-DD. */
export function presetDays(period: string, ref = new Date()): { from: string; to: string } {
  const r = rangeForPeriod(period, ref);
  return { from: dayKey(r.start), to: dayKey(r.end) };
}

/**
 * The days Custom dates starts from: the days the period chosen before covered, so nothing is empty and the person
 * adjusts from there. All time is too long to be one range, so it starts from the default period instead.
 */
export function customSeed(previous: string, ref = new Date()): { from: string; to: string } {
  const days = presetDays(isPeriodChoice(previous) && previous !== CUSTOM_PERIOD ? previous : DEFAULT_PERIOD, ref);
  return spanDays(days.from, days.to) > MAX_RANGE_DAYS ? presetDays(DEFAULT_PERIOD, ref) : days;
}
