import { aggregateMetrics, activitiesInRange, previousRange, delta, formatDTG, type MetricSource } from './metrics.ts';
import { JEPES_CORE, DEFAULT_METRICS, categoryNames, type MetricsConfig } from './constants.ts';
import type { DateRange } from './types.ts';

export interface Movement { current: number; prior: number; diff: number; pct: number | null; direction: 'up' | 'down' | 'flat'; isNew: boolean; lapsed: boolean }

export function movement(current: number, prior: number): Movement {
  const diff = current - prior;
  return { current, prior, diff, pct: delta(current, prior), direction: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat', isNew: prior === 0 && current > 0, lapsed: current === 0 && prior > 0 };
}

type Dated = MetricSource & { date?: string | null };

export interface Comparison {
  range: DateRange; prior: DateRange; label: { current: string; prior: string };
  counts: { current: number; prior: number };
  headline: { activities: Movement; dollars: Movement; reviewed: Movement; quantity: Movement; withOutcome: Movement };
  byDollarType: Array<Movement & { key: string; label: string; summable: boolean }>;
  byArea: Array<Movement & { area: string; dollars: Movement }>;
  byCategory: Array<Movement & { category: string }>;
  byUnit: Array<Movement & { unit: string }>;
  notes: string[];
  extras: { awards: Movement; trainingHours: Movement; goalsAchieved: Movement };
}

export function comparePeriods(
  activities: Dated[] = [],
  range: DateRange & { label?: string },
  extras: { areas?: readonly string[]; awards?: Array<{ date?: string | null }>; trainings?: Array<{ date?: string | null; hours?: number | null }>; goals?: Array<{ status?: string }>; metrics?: MetricsConfig } = {}
): Comparison {
  const areas = extras.areas || JEPES_CORE;
  const cfg = extras.metrics || DEFAULT_METRICS;
  const prior = previousRange(range);
  const now = activitiesInRange(activities, range);
  const before = activitiesInRange(activities, prior);
  const a = aggregateMetrics(now, cfg);
  const b = aggregateMetrics(before, cfg);
  const headline = {
    activities: movement(a.totalActivities, b.totalActivities),
    dollars: movement(a.totalDollars, b.totalDollars),
    reviewed: movement(a.reviewedDollars, b.reviewedDollars),
    quantity: movement(a.totalQuantity, b.totalQuantity),
    withOutcome: movement(a.withOutcome, b.withOutcome),
  };
  const byDollarType = cfg.value_types.map((d) => ({ key: d.key, label: d.label, summable: d.summable, ...movement(a.dollarsByType[d.key] || 0, b.dollarsByType[d.key] || 0) }))
    .filter((row) => row.current || row.prior);
  const byArea = areas.map((area) => ({ area, ...movement(a.byArea[area]?.count || 0, b.byArea[area]?.count || 0), dollars: movement(a.byArea[area]?.dollars || 0, b.byArea[area]?.dollars || 0) }));
  const byCategory = [...new Set([...categoryNames(cfg), ...Object.keys(a.byCategory), ...Object.keys(b.byCategory)])].map((cat) => ({ category: cat as string, ...movement(a.byCategory[cat]?.count || 0, b.byCategory[cat]?.count || 0) }))
    .filter((row) => row.current || row.prior).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  const unitKeys = new Set([...a.byUnit.map((u) => u.unit), ...b.byUnit.map((u) => u.unit)]);
  const byUnit = [...unitKeys].map((unit) => {
    const cur = a.byUnit.find((u) => u.unit === unit)?.total || 0;
    const pre = b.byUnit.find((u) => u.unit === unit)?.total || 0;
    return { unit, ...movement(cur, pre) };
  }).sort((x, y) => y.current - x.current);

  const notes: string[] = [];
  const emptyAreas = byArea.filter((j) => j.current === 0);
  if (emptyAreas.length) notes.push(`No entries this period under ${emptyAreas.map((j) => j.area.replace(' / Mission Accomplishment', '')).join(' or ')}. A board reads every area.`);
  const revived = byUnit.filter((u) => u.isNew);
  if (revived.length) notes.push(`New this period: ${revived.slice(0, 4).map((u) => u.unit).join(', ')}.`);
  const dropped = byUnit.filter((u) => u.lapsed);
  if (dropped.length) notes.push(`Nothing logged this period for ${dropped.slice(0, 4).map((u) => u.unit).join(', ')}.`);
  const outcomeRate = now.length ? Math.round((headline.withOutcome.current / now.length) * 100) : 0;
  const priorRate = before.length ? Math.round((headline.withOutcome.prior / before.length) * 100) : 0;
  if (now.length >= 3) notes.push(`${outcomeRate}% of entries carry a stated outcome, against ${priorRate}% last period. Entries without one do not survive a follow-up question.`);

  const inRange = (value: unknown, r: DateRange) => { if (!value) return false; const d = new Date(String(value)); return !Number.isNaN(d.getTime()) && d >= r.start && d <= r.end; };
  const countIn = (list: Array<{ date?: string | null }> = [], r: DateRange) => list.filter((x) => inRange(x.date, r)).length;
  const sumIn = (list: Array<{ date?: string | null; hours?: number | null }> = [], r: DateRange) => list.filter((x) => inRange(x.date, r)).reduce((n, x) => n + (Number(x.hours) || 0), 0);

  return {
    range, prior,
    label: { current: range.label || `${formatDTG(range.start)} to ${formatDTG(range.end)}`, prior: `${formatDTG(prior.start)} to ${formatDTG(prior.end)}` },
    counts: { current: now.length, prior: before.length },
    headline, byDollarType, byArea, byCategory, byUnit, notes,
    extras: {
      awards: movement(countIn(extras.awards, range), countIn(extras.awards, prior)),
      trainingHours: movement(sumIn(extras.trainings, range), sumIn(extras.trainings, prior)),
      goalsAchieved: movement((extras.goals || []).filter((g) => g.status === 'achieved').length, 0),
    },
  };
}

export function comparisonToText(cmp: Comparison, header = ''): string {
  const lines: string[] = [];
  if (header) lines.push(header.toUpperCase(), '='.repeat(header.length), '');
  lines.push(`CURRENT   ${cmp.label.current}`, `PRIOR     ${cmp.label.prior}`, '');
  const usd = (v: number) => `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  const row = (label: string, m: Movement, fmt: (v: number) => string = (v) => String(v)) => {
    const sign = m.diff > 0 ? '+' : '';
    const pct = m.pct == null ? 'n/a' : `${m.pct > 0 ? '+' : ''}${m.pct}%`;
    lines.push(`  ${label.padEnd(30)} ${fmt(m.current).padStart(14)}   was ${fmt(m.prior).padStart(14)}   ${sign}${fmt(m.diff)} (${pct})`);
  };
  lines.push('HEADLINE', '-'.repeat(8));
  row('Entries logged', cmp.headline.activities);
  row('Dollar impact', cmp.headline.dollars, usd);
  row('Units processed', cmp.headline.quantity);
  row('Entries with outcome', cmp.headline.withOutcome);
  lines.push('');
  if (cmp.byDollarType.length) {
    lines.push('DOLLARS BY TYPE', '-'.repeat(15));
    for (const d of cmp.byDollarType) row(d.label + (d.summable ? '' : ' (excluded)'), d, usd);
    lines.push('');
  }
  lines.push('AREA BALANCE', '-'.repeat(12));
  for (const j of cmp.byArea) row(j.area, j);
  lines.push('');
  if (cmp.notes.length) {
    lines.push('NOTES', '-'.repeat(5));
    for (const n of cmp.notes) lines.push(`  - ${n}`);
  }
  return lines.join('\n');
}
