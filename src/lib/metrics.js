/**
 * Vantage — fiscal math and aggregation.
 * Rebuilt from call sites; the original module was not recoverable from the archive.
 *
 * Two rules govern this file:
 *   1. One activity is one event. Counting rolls up events, never quantities.
 *   2. Reviewed dollars never enter a headline total. See DOLLAR_SUM_RULE.
 */

import {
  startOfDay, endOfDay, startOfWeek, endOfWeek, startOfMonth, endOfMonth,
  startOfYear, endOfYear, subDays, parseISO, isValid, format, differenceInCalendarDays,
} from 'date-fns';
import { SUMMABLE_DOLLAR_TYPES, FISCAL_YEAR_START_MONTH } from './constants.js';

/* ── date helpers ─────────────────────────────────────────────────── */

/** Parse a stored date string safely. Returns null rather than an Invalid Date. */
export function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : parseISO(String(value));
  return isValid(d) ? d : null;
}

export const dayKey = (d) => format(d, 'yyyy-MM-dd');

/* ── fiscal calendar ──────────────────────────────────────────────── */

/** The federal FY containing `ref`. FY26 runs 01 Oct 2025 → 30 Sep 2026. */
export function fiscalYearOf(ref = new Date()) {
  return ref.getMonth() >= FISCAL_YEAR_START_MONTH ? ref.getFullYear() + 1 : ref.getFullYear();
}

export function fiscalYearRange(ref = new Date()) {
  const fy = fiscalYearOf(ref);
  return {
    start: startOfDay(new Date(fy - 1, FISCAL_YEAR_START_MONTH, 1)),
    end: endOfDay(new Date(fy, FISCAL_YEAR_START_MONTH, 0)),
    label: `FY${String(fy).slice(-2)}`,
    fy,
  };
}

/** Fiscal quarter 1–4, where Q1 is Oct–Dec. */
export function fiscalQuarterOf(ref = new Date()) {
  return Math.floor(((ref.getMonth() - FISCAL_YEAR_START_MONTH + 12) % 12) / 3) + 1;
}

export function fiscalQuarterRange(ref = new Date()) {
  const { fy } = fiscalYearRange(ref);
  const q = fiscalQuarterOf(ref);
  const startMonth = (FISCAL_YEAR_START_MONTH + (q - 1) * 3) % 12;
  const startYear = startMonth >= FISCAL_YEAR_START_MONTH ? fy - 1 : fy;
  const start = startOfDay(new Date(startYear, startMonth, 1));
  const end = endOfDay(new Date(startYear, startMonth + 3, 0));
  return { start, end, label: `FY${String(fy).slice(-2)} Q${q}`, fy, quarter: q };
}

/** How far into the fiscal year we are, as a 0–1 fraction. Drives the tape. */
export function fiscalYearProgress(ref = new Date()) {
  const { start, end } = fiscalYearRange(ref);
  const total = differenceInCalendarDays(end, start) + 1;
  const elapsed = differenceInCalendarDays(ref, start) + 1;
  return { elapsed, total, fraction: Math.min(1, Math.max(0, elapsed / total)) };
}

/* ── generic periods ──────────────────────────────────────────────── */

export const PERIODS = [
  { key: 'week', label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'year', label: 'Calendar Year' },
  { key: 'all', label: 'All Time' },
];

export function periodRange(key, ref = new Date()) {
  switch (key) {
    case 'week':
      return { start: startOfWeek(ref, { weekStartsOn: 1 }), end: endOfWeek(ref, { weekStartsOn: 1 }) };
    case 'month':
      return { start: startOfMonth(ref), end: endOfMonth(ref) };
    case 'quarter': {
      const q = Math.floor(ref.getMonth() / 3);
      return {
        start: startOfDay(new Date(ref.getFullYear(), q * 3, 1)),
        end: endOfDay(new Date(ref.getFullYear(), q * 3 + 3, 0)),
      };
    }
    case 'year':
      return { start: startOfYear(ref), end: endOfYear(ref) };
    case 'all':
    default:
      return { start: new Date(1970, 0, 1), end: endOfDay(ref) };
  }
}

/** Resolves both plain and fiscal period keys. */
export function rangeForPeriod(key, ref = new Date()) {
  if (key === 'fiscalYear') return fiscalYearRange(ref);
  if (key === 'fiscalQuarter') return fiscalQuarterRange(ref);
  return periodRange(key, ref);
}

export function inPeriod(value, range) {
  const d = toDate(value);
  if (!d || !range) return false;
  return d >= range.start && d <= range.end;
}

export function activitiesInRange(list = [], range) {
  if (!range) return list;
  return list.filter((a) => inPeriod(a.date, range));
}

/* ── aggregation ──────────────────────────────────────────────────── */

/**
 * Roll a set of activities into the figures the app displays.
 * `totalDollars` deliberately excludes Reviewed — see DOLLAR_SUM_RULE.
 */
export function aggregateMetrics(list = []) {
  const byCategory = {};
  const byJepes = {};
  const dollarsByType = {};
  const unitTotals = {};
  let totalQuantity = 0;
  let totalDollars = 0;
  let reviewedDollars = 0;

  for (const a of list) {
    const cat = a.category || 'Other';
    byCategory[cat] ||= { count: 0, dollars: 0, quantity: 0 };
    byCategory[cat].count += 1;
    byCategory[cat].dollars += a.dollar_amount || 0;
    byCategory[cat].quantity += a.quantity || 0;

    const area = a.jepes_area || 'Unassigned';
    byJepes[area] ||= { count: 0, dollars: 0, quantity: 0 };
    byJepes[area].count += 1;
    byJepes[area].dollars += a.dollar_amount || 0;
    byJepes[area].quantity += a.quantity || 0;

    if (a.dollar_amount) {
      const type = a.dollar_type || 'impact';
      dollarsByType[type] = (dollarsByType[type] || 0) + a.dollar_amount;
      if (SUMMABLE_DOLLAR_TYPES.includes(type)) totalDollars += a.dollar_amount;
      else reviewedDollars += a.dollar_amount;
    }

    if (a.quantity) {
      totalQuantity += a.quantity;
      const unit = (a.unit || 'items').trim().toLowerCase();
      unitTotals[unit] ||= { unit, total: 0, count: 0 };
      unitTotals[unit].total += a.quantity;
      unitTotals[unit].count += 1;
    }
  }

  return {
    totalActivities: list.length,
    totalQuantity,
    totalDollars,
    reviewedDollars,
    byCategory,
    byJepes,
    dollarsByType,
    byUnit: Object.values(unitTotals).sort((a, b) => b.total - a.total),
  };
}

/** { 'yyyy-MM-dd': count } across the trailing `days` window. */
export function activityHeatmap(list = [], days = 126, ref = new Date()) {
  const cutoff = startOfDay(subDays(ref, days - 1));
  const map = {};
  for (const a of list) {
    const d = toDate(a.date);
    if (!d || d < cutoff) continue;
    const k = dayKey(d);
    map[k] = (map[k] || 0) + 1;
  }
  return map;
}

/** { 'yyyy-MM-dd': count } across an explicit range. Used by the fiscal tape. */
export function dailyCounts(list = [], range) {
  const map = {};
  for (const a of list) {
    const d = toDate(a.date);
    if (!d || (range && (d < range.start || d > range.end))) continue;
    const k = dayKey(d);
    map[k] = (map[k] || 0) + 1;
  }
  return map;
}

export function rollingCounts(list = [], days = 7, ref = new Date()) {
  const cutoff = startOfDay(subDays(ref, days - 1));
  return list.filter((a) => {
    const d = toDate(a.date);
    return d && d >= cutoff && d <= endOfDay(ref);
  }).length;
}

export function daysSinceLastActivity(list = [], ref = new Date()) {
  let latest = null;
  for (const a of list) {
    const d = toDate(a.date);
    if (d && d <= endOfDay(ref) && (!latest || d > latest)) latest = d;
  }
  return latest ? Math.max(0, differenceInCalendarDays(startOfDay(ref), startOfDay(latest))) : null;
}

/** Consecutive days ending today (or yesterday) with at least one activity. */
export function currentStreak(list = [], ref = new Date()) {
  const days = new Set(list.map((a) => toDate(a.date)).filter(Boolean).map(dayKey));
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

/** Daily counts over the trailing window, oldest first. Feeds sparklines. */
export function trendSeries(list = [], days = 30, ref = new Date()) {
  const counts = {};
  for (const a of list) {
    const d = toDate(a.date);
    if (d) counts[dayKey(d)] = (counts[dayKey(d)] || 0) + 1;
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = subDays(ref, i);
    const k = dayKey(d);
    out.push({ key: k, date: format(d, 'MMM d'), short: format(d, 'd'), count: counts[k] || 0 });
  }
  return out;
}

/** Percent change, guarding the divide-by-zero case honestly. */
export function delta(current, previous) {
  if (previous === 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / Math.abs(previous)) * 100);
}

/** The equivalent-length window immediately before `range`. */
export function previousRange(range) {
  const span = range.end.getTime() - range.start.getTime();
  const end = new Date(range.start.getTime() - 1);
  return { start: new Date(end.getTime() - span), end };
}

/* ── formatting ───────────────────────────────────────────────────── */

const nf = new Intl.NumberFormat('en-US');
const usdExact = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

export function formatNumber(n) {
  if (n == null || Number.isNaN(n)) return '0';
  return nf.format(Math.round(n * 100) / 100);
}

/** Abbreviated money for headline figures: $1.24M, $18.6K, $940. */
export function formatDollars(n) {
  if (!n) return '$0';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${nf.format(Math.round(abs))}`;
}

/** Full precision, for anywhere a figure has to be defensible to the cent. */
export function formatDollarsExact(n) {
  if (n == null) return '$0.00';
  return usdExact.format(n);
}

export function formatCompact(n) {
  if (n == null) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return nf.format(n);
}

export function formatDate(value, pattern = 'dd MMM yy') {
  const d = toDate(value);
  return d ? format(d, pattern) : '—';
}

/** Military-style date group: 18 AUG 26. */
export function formatDTG(value) {
  const d = toDate(value);
  return d ? format(d, 'dd MMM yy').toUpperCase() : '—';
}
