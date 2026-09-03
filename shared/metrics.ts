import {
  startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth, startOfYear, endOfYear,
  subDays, parseISO, isValid, format, differenceInCalendarDays,
} from 'date-fns';
import { SUMMABLE_DOLLAR_TYPES, FISCAL_YEAR_START_MONTH } from './constants.ts';
import type { DateRange } from './types.ts';

export function toDate(value: unknown): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : parseISO(String(value));
  return isValid(d) ? d : null;
}

export const dayKey = (d: Date) => format(d, 'yyyy-MM-dd');

export function fiscalYearOf(ref = new Date()): number {
  return ref.getMonth() >= FISCAL_YEAR_START_MONTH ? ref.getFullYear() + 1 : ref.getFullYear();
}

export function fiscalYearRange(ref = new Date()): DateRange & { label: string; fy: number } {
  const fy = fiscalYearOf(ref);
  return {
    start: startOfDay(new Date(fy - 1, FISCAL_YEAR_START_MONTH, 1)),
    end: endOfDay(new Date(fy, FISCAL_YEAR_START_MONTH, 0)),
    label: `FY${String(fy).slice(-2)}`,
    fy,
  };
}

export function fiscalQuarterOf(ref = new Date()): number {
  return Math.floor(((ref.getMonth() - FISCAL_YEAR_START_MONTH + 12) % 12) / 3) + 1;
}

export function fiscalQuarterRange(ref = new Date()): DateRange & { label: string; fy: number; quarter: number } {
  const { fy } = fiscalYearRange(ref);
  const q = fiscalQuarterOf(ref);
  const startMonth = (FISCAL_YEAR_START_MONTH + (q - 1) * 3) % 12;
  const startYear = startMonth >= FISCAL_YEAR_START_MONTH ? fy - 1 : fy;
  const start = startOfDay(new Date(startYear, startMonth, 1));
  const end = endOfDay(new Date(startYear, startMonth + 3, 0));
  return { start, end, label: `FY${String(fy).slice(-2)} Q${q}`, fy, quarter: q };
}

export function fiscalYearProgress(ref = new Date()) {
  const { start, end } = fiscalYearRange(ref);
  const total = differenceInCalendarDays(end, start) + 1;
  const elapsed = differenceInCalendarDays(ref, start) + 1;
  return { elapsed, total, fraction: Math.min(1, Math.max(0, elapsed / total)) };
}

export type PeriodKey = 'week' | 'month' | 'quarter' | 'fiscalQuarter' | 'fiscalYear' | 'year' | 'last30' | 'last90' | 'all';

export const PERIOD_OPTIONS: Array<{ value: PeriodKey; label: string; short: string }> = [
  { value: 'week', label: 'This week', short: 'WK' },
  { value: 'month', label: 'This month', short: 'MO' },
  { value: 'last30', label: 'Last 30 days', short: '30D' },
  { value: 'last90', label: 'Last 90 days', short: '90D' },
  { value: 'fiscalQuarter', label: 'Fiscal quarter', short: 'FQ' },
  { value: 'fiscalYear', label: 'Fiscal year', short: 'FY' },
  { value: 'year', label: 'Calendar year', short: 'CY' },
  { value: 'all', label: 'All time', short: 'ALL' },
];

export function rangeForPeriod(key: PeriodKey | string, ref = new Date()): DateRange & { label: string } {
  switch (key) {
    case 'week':
      return { start: startOfWeek(ref, { weekStartsOn: 1 }), end: endOfWeek(ref, { weekStartsOn: 1 }), label: 'This week' };
    case 'month':
      return { start: startOfMonth(ref), end: endOfMonth(ref), label: format(ref, 'MMMM yyyy') };
    case 'last30':
      return { start: startOfDay(subDays(ref, 29)), end: endOfDay(ref), label: 'Last 30 days' };
    case 'last90':
      return { start: startOfDay(subDays(ref, 89)), end: endOfDay(ref), label: 'Last 90 days' };
    case 'quarter': {
      const q = Math.floor(ref.getMonth() / 3);
      return {
        start: startOfDay(new Date(ref.getFullYear(), q * 3, 1)),
        end: endOfDay(new Date(ref.getFullYear(), q * 3 + 3, 0)),
        label: `Q${q + 1} ${ref.getFullYear()}`,
      };
    }
    case 'fiscalQuarter':
      return fiscalQuarterRange(ref);
    case 'fiscalYear':
      return fiscalYearRange(ref);
    case 'year':
      return { start: startOfYear(ref), end: endOfYear(ref), label: `CY${ref.getFullYear()}` };
    case 'all':
    default:
      return { start: new Date(1970, 0, 1), end: endOfDay(ref), label: 'All time' };
  }
}

export function inPeriod(value: unknown, range: DateRange | null | undefined): boolean {
  const d = toDate(value);
  if (!d || !range) return false;
  return d >= range.start && d <= range.end;
}

export function activitiesInRange<T extends { date?: string | null }>(list: T[] = [], range?: DateRange | null): T[] {
  if (!range) return list;
  return list.filter((a) => inPeriod(a.date, range));
}

export interface Bucket { count: number; dollars: number; quantity: number }
export interface Metrics {
  totalActivities: number; totalQuantity: number; totalDollars: number; reviewedDollars: number;
  byCategory: Record<string, Bucket>; byArea: Record<string, Bucket>; dollarsByType: Record<string, number>;
  byUnit: Array<{ unit: string; total: number; count: number }>; withOutcome: number;
}

export interface MetricSource {
  category?: string | null; eval_area?: string | null; quantity?: number | null; unit_label?: string | null;
  dollar_amount?: number | null; dollar_type?: string | null; result?: string | null;
}

export function aggregateMetrics(list: MetricSource[] = []): Metrics {
  const byCategory: Record<string, Bucket> = {};
  const byArea: Record<string, Bucket> = {};
  const dollarsByType: Record<string, number> = {};
  const unitTotals: Record<string, { unit: string; total: number; count: number }> = {};
  let totalQuantity = 0;
  let totalDollars = 0;
  let reviewedDollars = 0;
  let withOutcome = 0;

  for (const a of list) {
    const cat = a.category || 'Other';
    byCategory[cat] ||= { count: 0, dollars: 0, quantity: 0 };
    byCategory[cat].count += 1;
    byCategory[cat].dollars += Number(a.dollar_amount) || 0;
    byCategory[cat].quantity += Number(a.quantity) || 0;

    const area = a.eval_area || 'Unassigned';
    byArea[area] ||= { count: 0, dollars: 0, quantity: 0 };
    byArea[area].count += 1;
    byArea[area].dollars += Number(a.dollar_amount) || 0;
    byArea[area].quantity += Number(a.quantity) || 0;

    if (a.result && String(a.result).trim()) withOutcome += 1;

    if (a.dollar_amount) {
      const type = a.dollar_type || 'impact';
      dollarsByType[type] = (dollarsByType[type] || 0) + Number(a.dollar_amount);
      if (SUMMABLE_DOLLAR_TYPES.includes(type)) totalDollars += Number(a.dollar_amount);
      else reviewedDollars += Number(a.dollar_amount);
    }

    if (a.quantity) {
      totalQuantity += Number(a.quantity);
      const unit = (a.unit_label || 'items').trim().toLowerCase();
      unitTotals[unit] ||= { unit, total: 0, count: 0 };
      unitTotals[unit].total += Number(a.quantity);
      unitTotals[unit].count += 1;
    }
  }

  return {
    totalActivities: list.length,
    totalQuantity,
    totalDollars: round2(totalDollars),
    reviewedDollars: round2(reviewedDollars),
    byCategory,
    byArea,
    dollarsByType,
    byUnit: Object.values(unitTotals).sort((a, b) => b.total - a.total),
    withOutcome,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function dailyCounts<T extends { date?: string | null }>(list: T[] = [], range?: DateRange | null): Record<string, number> {
  const map: Record<string, number> = {};
  for (const a of list) {
    const d = toDate(a.date);
    if (!d || (range && (d < range.start || d > range.end))) continue;
    const k = dayKey(d);
    map[k] = (map[k] || 0) + 1;
  }
  return map;
}

export function daysSinceLastActivity<T extends { date?: string | null }>(list: T[] = [], ref = new Date()): number | null {
  let latest: Date | null = null;
  for (const a of list) {
    const d = toDate(a.date);
    if (d && d <= endOfDay(ref) && (!latest || d > latest)) latest = d;
  }
  return latest ? Math.max(0, differenceInCalendarDays(startOfDay(ref), startOfDay(latest))) : null;
}

export function currentStreak<T extends { date?: string | null }>(list: T[] = [], ref = new Date()): number {
  const days = new Set(list.map((a) => toDate(a.date)).filter((d): d is Date => Boolean(d)).map(dayKey));
  if (!days.size) return 0;
  let streak = 0;
  let cursor = startOfDay(ref);
  if (!days.has(dayKey(cursor))) {
    cursor = subDays(cursor, 1);
    if (!days.has(dayKey(cursor))) return 0;
  }
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor = subDays(cursor, 1);
  }
  return streak;
}

export function delta(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

export function previousRange(range: DateRange): DateRange {
  const span = range.end.getTime() - range.start.getTime();
  const end = new Date(range.start.getTime() - 1);
  return { start: new Date(end.getTime() - span), end };
}

const nf = new Intl.NumberFormat('en-US');
const usdExact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function formatNumber(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '0';
  return nf.format(Math.round(n * 100) / 100);
}

export function formatDollars(n: number | null | undefined): string {
  if (!n) return '$0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${nf.format(Math.round(abs))}`;
}

export function formatDollarsExact(n: number | null | undefined): string {
  if (n == null) return '$0.00';
  return usdExact.format(n);
}

export function formatCompact(n: number | null | undefined): string {
  if (n == null) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return nf.format(n);
}

export function formatDate(value: unknown, pattern = 'dd MMM yy'): string {
  const d = toDate(value);
  return d ? format(d, pattern) : '—';
}

export function formatDTG(value: unknown): string {
  const d = toDate(value);
  return d ? format(d, 'dd MMM yy').toUpperCase() : '—';
}

export function isoToday(ref = new Date()): string {
  return dayKey(ref);
}
