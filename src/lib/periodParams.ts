import { CUSTOM_PERIOD, isPeriodChoice, presetDays, rangeProblems, type PeriodChoice, type RangeProblem } from '../../shared/dateRange.ts';
import { DEFAULT_PERIOD, dayKey } from '../../shared/metrics.ts';

/**
 * A page's period in its address (ADR-0038): `period` names a preset, or `custom` with `from` and `to`. Reading and
 * writing are plain functions over URLSearchParams, so one change writes all three keys and a test can run them.
 */

export interface PeriodSelection { period: PeriodChoice; from?: string; to?: string }

export interface PeriodState {
  period: PeriodChoice;
  /** The custom range's days; empty for a preset. */
  from: string;
  to: string;
  custom: boolean;
  /** Days in the address that were not used, and why: the page shows its preset and says so. */
  ignored: RangeProblem | null;
}

/** A preset the page may fall back to: the one given when it is one, or the default. */
export const presetOr = (fallback: string): PeriodChoice => (isPeriodChoice(fallback) && fallback !== CUSTOM_PERIOD ? fallback : DEFAULT_PERIOD);

/**
 * The period an address names. Custom dates are `period=custom` with both days, or both days with no period (as links
 * from other pages carry them). Days that break the range rule are not used: the fallback stands, and `ignored` says why.
 * A period the page does not know, such as an old saved choice, is the fallback.
 */
export function readPeriod(params: URLSearchParams, fallback: string): PeriodState {
  const preset = presetOr(fallback);
  const named = params.get('period');
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  if (named === CUSTOM_PERIOD || (!named && (from || to))) {
    const problem = rangeProblems(from, to, { required: true });
    if (!problem) return { period: CUSTOM_PERIOD, from, to, custom: true, ignored: null };
    return { period: preset, from: '', to: '', custom: false, ignored: problem };
  }
  const period = isPeriodChoice(named) ? named : preset;
  return { period, from: '', to: '', custom: false, ignored: null };
}

/**
 * The address after choosing a period, every other key kept. A preset clears the days, and is left out when it is the
 * fallback; custom dates write all three keys.
 */
export function writePeriod(params: URLSearchParams, next: PeriodSelection, fallback: string): URLSearchParams {
  const out = new URLSearchParams(params);
  if (next.period === CUSTOM_PERIOD && next.from && next.to) {
    out.set('period', CUSTOM_PERIOD);
    out.set('from', next.from);
    out.set('to', next.to);
    return out;
  }
  out.delete('from');
  out.delete('to');
  if (next.period === presetOr(fallback) || next.period === CUSTOM_PERIOD) out.delete('period');
  else out.set('period', next.period);
  return out;
}

/** What a request says about its period: the preset by name, or custom dates with both days. */
export function periodQuery(state: Pick<PeriodState, 'period' | 'from' | 'to' | 'custom'>): { period: string; from?: string; to?: string } {
  return state.custom ? { period: CUSTOM_PERIOD, from: state.from, to: state.to } : { period: state.period };
}

/**
 * The days a period covers on the page's own clock, for a list the page filters itself or a request that takes days:
 * the custom range, a preset's days, or null for All time.
 */
export function periodDays(state: Pick<PeriodState, 'period' | 'from' | 'to' | 'custom'>, ref = new Date()): { from: string; to: string } | null {
  if (state.custom) return { from: state.from, to: state.to };
  if (state.period === 'all') return null;
  return presetDays(state.period, ref);
}

/**
 * What /api/metrics is asked for: the period's days, so a figure's contributors name them, or All time by name, which
 * no span of days covers.
 */
export function metricsPeriod(state: Pick<PeriodState, 'period' | 'from' | 'to' | 'custom'>, ref = new Date()): { period?: string; from?: string; to?: string } {
  return periodDays(state, ref) ?? { period: 'all' };
}

/**
 * A window a page offers by its length in days (the Unit dashboard's `?days=`, Your record's and Workload's `?window=`),
 * with custom dates beside it (ADR-0039). The preset stays under the page's own key, so "Last year" (`days=365`) and
 * `window=365` keep the links they always had; custom dates are `period=custom` with both days, as on a Period page, so a
 * link written for one kind of page reads on the other.
 */
export interface WindowSelection { period: string; from?: string; to?: string }

export interface WindowState {
  /** The preset's value, or `custom`. */
  period: string;
  from: string;
  to: string;
  custom: boolean;
  /** Days in the address that were not used, and why. */
  ignored: RangeProblem | null;
}

export interface WindowKeys {
  /** The address key the preset is kept under. */
  key: string;
  /** The values the page offers. */
  presets: readonly string[];
  /** What the page shows with no window in its address. */
  fallback: string;
}

/**
 * The window an address names. Custom dates are `period=custom` with both days, or both days with no preset (as links
 * from other pages carry them). Days that break the range rule are not used: the preset stands, and `ignored` says why.
 * A preset the page does not offer is its fallback.
 */
export function readWindow(params: URLSearchParams, { key, presets, fallback }: WindowKeys): WindowState {
  const named = params.get(key);
  const preset = named !== null && presets.includes(named) ? named : fallback;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  if (params.get('period') === CUSTOM_PERIOD || (named === null && (from || to))) {
    const problem = rangeProblems(from, to, { required: true });
    if (!problem) return { period: CUSTOM_PERIOD, from, to, custom: true, ignored: null };
    return { period: preset, from: '', to: '', custom: false, ignored: problem };
  }
  return { period: preset, from: '', to: '', custom: false, ignored: null };
}

/**
 * The address after choosing a window, every other key kept, in one change. Custom dates write `period=custom` and both
 * days and drop the preset; a preset drops the days, and is left out when it is the fallback.
 */
export function writeWindow(params: URLSearchParams, next: WindowSelection, { key, fallback }: Pick<WindowKeys, 'key' | 'fallback'>): URLSearchParams {
  const out = new URLSearchParams(params);
  out.delete('period');
  out.delete('from');
  out.delete('to');
  if (next.period === CUSTOM_PERIOD) {
    out.delete(key);
    if (next.from && next.to) {
      out.set('period', CUSTOM_PERIOD);
      out.set('from', next.from);
      out.set('to', next.to);
    }
    return out;
  }
  if (next.period === fallback) out.delete(key);
  else out.set(key, next.period);
  return out;
}

/** The last `days` calendar days on the page's own clock, today included: "Last year" is 365 of them. */
export function lastDays(days: number | string, ref = new Date()): { from: string; to: string } {
  const from = new Date(ref);
  from.setDate(from.getDate() - (Number(days) - 1));
  return { from: dayKey(from), to: dayKey(ref) };
}

/** The days a window covers: the custom range, or the preset's last days. */
export function windowDays(state: Pick<WindowState, 'period' | 'from' | 'to' | 'custom'>, ref = new Date()): { from: string; to: string } {
  return state.custom ? { from: state.from, to: state.to } : lastDays(state.period, ref);
}

/**
 * What a link to the Report library says about a window: custom dates by name, so the library keeps them as dates and
 * saves them as dates; a preset's days alone, so the library labels them as the link's days and saves the rolling period
 * they match (ADR-0028).
 */
export function windowLink(state: Pick<WindowState, 'period' | 'from' | 'to' | 'custom'>, ref = new Date()): { period?: string; from: string; to: string } {
  return state.custom ? { period: CUSTOM_PERIOD, from: state.from, to: state.to } : lastDays(state.period, ref);
}
