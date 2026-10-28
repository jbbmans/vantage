import { format, parseISO, isValid } from 'date-fns';

/**
 * When a record happened (ADR-0018): its first day, its last day, a time of day at each end where that matters, and
 * whether it is still going on. One definition for every record type that has one, read by the database's triggers,
 * the server's checks, the period filters, reports, analysis, imports, exports and the forms, so none of them decides
 * on its own what "in this period" or "ends before it starts" means.
 *
 * Days are calendar days (YYYY-MM-DD) and times are the wall clock where it happened (HH:MM, 24-hour), as a date already
 * was: nothing is converted between time zones.
 */
export interface TimeframeSpec {
  /** The column holding the first day. */
  start: string;
  /** The column holding the last day. */
  end: string;
  /** It takes a time of day at each end (start_time, end_time). */
  times: boolean;
  /** It takes "ongoing": begun, with no end yet (the ongoing column). */
  ongoing: boolean;
  /**
   * A missing day leaves that side open: a goal with only a deadline, an assignment with no end yet. Without it, a record
   * with no end is a single day, and one with no start has no date and falls in no period.
   */
  open: boolean;
  /** How a period picks it: any day of it in the period, or only the day in `end` (an award, received on its date). */
  inPeriod: 'overlap' | 'end';
  /** The names the forms give the two days. */
  labels: { start: string; end: string };
  /** What the server's message calls the record: "The assignment cannot end before it starts." */
  subject: string;
}

export const TIMEFRAMES = {
  activities: { start: 'date', end: 'end_date', times: true, ongoing: true, open: false, inPeriod: 'overlap', labels: { start: 'Start date', end: 'End date' }, subject: 'An activity' },
  trainings: { start: 'date', end: 'end_date', times: true, ongoing: true, open: false, inPeriod: 'overlap', labels: { start: 'Start date', end: 'End date' }, subject: 'A course' },
  // The award date has always been the end of the period it recognizes ("Period end / award date"): the period gains its start.
  awards: { start: 'period_start', end: 'date', times: false, ongoing: false, open: true, inPeriod: 'end', labels: { start: 'Period start', end: 'Period end / award date' }, subject: 'The period an award recognizes' },
  goals: { start: 'period_start', end: 'period_end', times: false, ongoing: false, open: true, inPeriod: 'overlap', labels: { start: 'Period start', end: 'Period end' }, subject: 'A goal' },
  projects: { start: 'start_date', end: 'target_date', times: false, ongoing: false, open: true, inPeriod: 'overlap', labels: { start: 'Start date', end: 'Target date' }, subject: 'A project' },
  // A Marine's assignment to a unit and a functional responsibility (ADR-0017).
  unit_members: { start: 'assignment_start', end: 'assignment_end', times: false, ongoing: false, open: true, inPeriod: 'overlap', labels: { start: 'Assignment start', end: 'Assignment end' }, subject: 'The assignment' },
  personnel_responsibilities: { start: 'starts_on', end: 'ends_on', times: false, ongoing: false, open: true, inPeriod: 'overlap', labels: { start: 'From', end: 'Until' }, subject: 'A responsibility' },
} as const satisfies Record<string, TimeframeSpec>;

export type TimeframedTable = keyof typeof TIMEFRAMES;
export const isTimeframed = (table: string): table is TimeframedTable => Object.prototype.hasOwnProperty.call(TIMEFRAMES, table);

/** The columns a record type's timeframe is written in: the days, then its times and ongoing where it takes them. */
export function timeframeColumns(table: TimeframedTable): string[] {
  const spec: TimeframeSpec = TIMEFRAMES[table];
  return [spec.start, spec.end, ...(spec.times ? ['start_time', 'end_time'] : []), ...(spec.ongoing ? ['ongoing'] : [])];
}

/** Past every day a record can name: the last day of one still going on, or of one open at its end. */
export const OPEN_END = '9999-12-31';
/** Before every day a record can name: the first day of one open at its start. */
export const OPEN_START = '0000-01-01';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown): string | null => (typeof v === 'string' && DAY.test(v.slice(0, 10)) ? v.slice(0, 10) : null);
const time = (v: unknown): string | null => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : null);
export const isOngoing = (v: unknown) => v === true || v === 1 || v === '1';

/** One record's timeframe, read from its row by its type's columns. */
export interface Timeframe { start: string | null; end: string | null; startTime: string | null; endTime: string | null; ongoing: boolean }

export function timeframeOf(table: TimeframedTable, row: object): Timeframe {
  const spec: TimeframeSpec = TIMEFRAMES[table];
  const r = row as Record<string, unknown>;
  return {
    start: day(r[spec.start]), end: day(r[spec.end]),
    startTime: spec.times ? time(r.start_time) : null, endTime: spec.times ? time(r.end_time) : null,
    ongoing: spec.ongoing && isOngoing(r.ongoing),
  };
}

export interface TimeframeProblem { fieldErrors: Record<string, string>; message: string }

/**
 * What is wrong with a record's timeframe, by field, or null when nothing is. The server refuses a write with any of
 * these (400), and the forms show the same words before anything is sent. `row` is the record as it would be saved:
 * for an edit, the stored row with the change laid over it.
 */
export function timeframeProblems(table: TimeframedTable, row: object): TimeframeProblem | null {
  const spec: TimeframeSpec = TIMEFRAMES[table];
  const tf = timeframeOf(table, row);
  const errors: Record<string, string> = {};
  let message = '';
  const add = (field: string, text: string, summary: string) => { if (!errors[field]) errors[field] = text; if (!message) message = summary; };
  if (tf.end && tf.start && tf.end < tf.start) add(spec.end, 'On or after the start.', `${spec.subject} cannot end before it starts.`);
  if (!spec.open && tf.end && !tf.start) add(spec.start, 'Add the start date as well.', 'An end date needs a start date.');
  if (tf.ongoing) {
    if (!tf.start) add(spec.start, 'Add the day it began.', 'An ongoing record needs the day it began.');
    if (tf.end) add(spec.end, 'An ongoing record has no end date yet.', 'An ongoing record has no end date yet: clear the end date, or untick Ongoing.');
    if (tf.endTime) add('end_time', 'An ongoing record has no end time yet.', 'An ongoing record has no end time yet.');
    // A completed course has ended; one still running is in progress or scheduled.
    if (table === 'trainings' && (row as { status?: unknown }).status === 'completed') add('ongoing', 'A completed course has ended: give its end date, or set it in progress.', 'Training marked completed cannot be ongoing.');
  }
  if (spec.times) {
    if ((tf.startTime || tf.endTime) && !tf.start) add(tf.startTime ? 'start_time' : 'end_time', 'Add the date first.', 'A time needs the date it goes with.');
    const sameDay = tf.start && (!tf.end || tf.end === tf.start);
    if (sameDay && !tf.ongoing && tf.startTime && tf.endTime && tf.endTime < tf.startTime) {
      add('end_time', 'After the start time. If it ran past midnight, set the end date to the next day.', 'The end time is before the start time on the same day. A record cannot end before it starts.');
    }
  }
  return message ? { fieldErrors: errors, message } : null;
}

/** The first and last day a record covers, for a period to test against; null when it has no date. */
export function coveredDays(table: TimeframedTable, row: object): { first: string; last: string } | null {
  const spec: TimeframeSpec = TIMEFRAMES[table];
  const tf = timeframeOf(table, row);
  if (spec.inPeriod === 'end') return tf.end ? { first: tf.end, last: tf.end } : null;
  if (spec.open) return tf.start || tf.end ? { first: tf.start ?? OPEN_START, last: tf.end ?? OPEN_END } : null;
  if (!tf.start) return null;
  return { first: tf.start, last: tf.ongoing ? OPEN_END : tf.end ?? tf.start };
}

/**
 * Whether a record falls in a period (days, both ends included): for most, any day of it in the period; for an award,
 * the day it was given. Either end of the period may be left open.
 */
export function inPeriod(table: TimeframedTable, row: object, from: string | null | undefined, to: string | null | undefined): boolean {
  const days = coveredDays(table, row);
  if (!days) return !from && !to;
  return (!to || days.first <= to) && (!from || days.last >= from);
}

/**
 * The one day a record is counted on inside a window, so a total over the window counts it once and a series puts it in
 * one bucket: its first day, or the window's first day when it began before the window.
 */
export function anchorDay(table: TimeframedTable, row: object, from: string | null | undefined): string | null {
  const days = coveredDays(table, row);
  if (!days) return null;
  return from && days.first < from ? from : days.first;
}

/** What to type for a time of day. */
export const TIME_HINT = 'Use a 24-hour time: 0800 or 08:00.';

/** A time of day as a person types it ("0800", "800", "08:00", "8:00") as HH:MM on a 24-hour clock; null when it is not one. */
export function parseTime(v: unknown): string | null {
  const m = /^(\d{1,2}):?(\d{2})$/.exec(String(v ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** "08:00" as Marines write it: "0800". */
export const militaryTime = (t: string | null | undefined) => (t ? t.replace(':', '') : '');

/**
 * A record's timeframe in words: "12 May 25", "12 May 25 – 16 May 25", "12 May 25 0800–1600",
 * "12 May 25 2200 – 13 May 25 0600", "3 Mar 25 – present". `upper` writes the days as a DTG does ("12 MAY 25").
 */
export function formatTimeframe(table: TimeframedTable, row: object, opts: { pattern?: string; upper?: boolean; empty?: string } = {}): string {
  const tf = timeframeOf(table, row);
  const pattern = opts.pattern ?? 'dd MMM yy';
  const fmt = (d: string) => { const parsed = parseISO(d); const text = isValid(parsed) ? format(parsed, pattern) : d; return opts.upper ? text.toUpperCase() : text; };
  if (!tf.start && !tf.end) return opts.empty ?? '';
  // An award with no period given is just its date.
  const spec: TimeframeSpec = TIMEFRAMES[table];
  if (spec.inPeriod === 'end' && !tf.start) return fmt(tf.end!);
  const st = militaryTime(tf.startTime); const et = militaryTime(tf.endTime);
  const singleDay = tf.start && !tf.ongoing && (!tf.end || tf.end === tf.start);
  if (singleDay) return `${fmt(tf.start!)}${st && et ? ` ${st}–${et}` : st ? ` ${st}` : et ? ` until ${et}` : ''}`;
  const from = tf.start ? `${fmt(tf.start)}${st ? ` ${st}` : ''}` : '';
  const to = tf.ongoing ? 'present' : tf.end ? `${fmt(tf.end)}${et ? ` ${et}` : ''}` : '';
  if (from && to) return `${from} – ${to}`;
  return from ? `from ${from}` : `until ${to}`;
}
