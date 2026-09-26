import { DEFAULT_METRICS, isSummable, type MetricsConfig } from './constants.ts';

export type MetricKind = 'money' | 'quantity' | 'duration';
export type Aggregation = 'sum' | 'max' | 'min' | 'average' | 'latest' | 'distinct';
export type Direction = 'increase' | 'decrease' | 'threshold' | 'completion';

/** A single typed measurement produced by one outcome. */
export interface Measure {
  outcomeId: string;
  metricId: string;
  metricLabel: string;
  kind: MetricKind;
  /** Display unit, e.g. the money label, "ULOs", "hours". */
  unit: string;
  unitKey: string;
  value: number;
  date: string;
  /** Does this measure belong in a headline total for its unit? */
  headline: boolean;
  /** Free dimensions used for filtering and drill-down. */
  dimensions: Record<string, string | null>;
}

export interface MetricTotal {
  metricId: string;
  metricLabel: string;
  kind: MetricKind;
  unit: string;
  unitKey: string;
  aggregation: Aggregation;
  value: number;
  outcomes: number;
  headline: boolean;
  /** Outcome ids behind the figure, so every total can be opened. */
  contributors: string[];
}

export function unitKeyOf(unit: string | null | undefined): string {
  const text = (String(unit ?? '').trim() || 'items').toLowerCase();
  return text.endsWith('s') && text.length > 3 ? text.slice(0, -1) : text;
}

/** Hours typed as a count ("volunteered 6 hours") are the same measure as hours logged, so they total together. */
const TIME_UNIT_KEYS = new Set(['hour', 'hr', 'hrs', 'h']);
export const isTimeUnit = (unit: string | null | undefined) => TIME_UNIT_KEYS.has(unitKeyOf(unit));

export const durationMetricId = () => 'duration:hours';
export const moneyMetricId = (type: string | null | undefined) => `money:${String(type ?? '').trim().toLowerCase() || 'unclassified'}`;
export const quantityMetricId = (unit: string | null | undefined) => (isTimeUnit(unit) ? durationMetricId() : `quantity:${unitKeyOf(unit)}`);
/** Metric ids saved before hours were merged (a goal, a link) still find their figure. */
export const canonicalMetricId = (id: string) => (/^quantity:/.test(id) && isTimeUnit(id.slice('quantity:'.length)) ? durationMetricId() : id);

export interface OutcomeRow {
  id: string;
  date?: string | null;
  category?: string | null;
  eval_area?: string | null;
  quantity?: number | null;
  unit_label?: string | null;
  dollar_amount?: number | null;
  dollar_type?: string | null;
  hours?: number | null;
  organization?: string | null;
  system?: string | null;
  user_id?: string | null;
  unit_id?: string | null;
  result?: string | null;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function measuresOf(row: OutcomeRow, cfg: MetricsConfig = DEFAULT_METRICS): Measure[] {
  const out: Measure[] = [];
  const date = String(row.date || '').slice(0, 10);
  const dimensions: Record<string, string | null> = {
    category: row.category ?? null,
    area: row.eval_area ?? null,
    organization: row.organization ?? null,
    system: row.system ?? null,
    user_id: row.user_id ?? null,
    unit_id: row.unit_id ?? null,
  };

  const amount = num(row.dollar_amount);
  if (amount != null && amount !== 0) {
    const typeKey = String(row.dollar_type ?? '').trim().toLowerCase();
    const defined = cfg.value_types.find((t) => t.key.toLowerCase() === typeKey);
    const label = defined?.label || (typeKey ? String(row.dollar_type) : cfg.currency_label);
    out.push({
      outcomeId: row.id, metricId: moneyMetricId(row.dollar_type), metricLabel: `${cfg.currency_label}, ${label}`,
      kind: 'money', unit: cfg.currency_label, unitKey: `money:${typeKey || 'unclassified'}`,
      value: amount, date, headline: isSummable(row.dollar_type, cfg), dimensions,
    });
  }

  const quantity = num(row.quantity);
  const unit = (row.unit_label || 'items').trim();
  const hoursField = num(row.hours);
  const hours = hoursField != null && hoursField !== 0 ? hoursField : quantity != null && quantity !== 0 && isTimeUnit(unit) ? quantity : null;
  if (quantity != null && quantity !== 0 && !isTimeUnit(unit)) {
    out.push({
      outcomeId: row.id, metricId: quantityMetricId(unit), metricLabel: unit,
      kind: 'quantity', unit, unitKey: unitKeyOf(unit),
      value: quantity, date, headline: true, dimensions,
    });
  }

  if (hours != null) {
    out.push({
      outcomeId: row.id, metricId: durationMetricId(), metricLabel: 'Hours',
      kind: 'duration', unit: 'hours', unitKey: 'hour',
      value: hours, date, headline: true, dimensions,
    });
  }

  return out;
}

export function measuresOfAll(rows: OutcomeRow[], cfg: MetricsConfig = DEFAULT_METRICS): Measure[] {
  return rows.flatMap((r) => measuresOf(r, cfg));
}

export function dedupe(measures: Measure[]): Measure[] {
  const seen = new Set<string>();
  const out: Measure[] = [];
  for (const m of measures) {
    const key = `${m.outcomeId} ${m.metricId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

function apply(aggregation: Aggregation, values: number[]): number {
  if (!values.length) return 0;
  switch (aggregation) {
    case 'max': return Math.max(...values);
    case 'min': return Math.min(...values);
    case 'average': return round(values.reduce((a, b) => a + b, 0) / values.length);
    case 'latest': return values[values.length - 1];
    case 'distinct': return values.length;
    case 'sum':
    default: return round(values.reduce((a, b) => a + b, 0));
  }
}

export interface AggregateOptions {
  aggregation?: Aggregation;
  filters?: Record<string, string | null | undefined>;
  from?: string | null;
  to?: string | null;
}

export function matchesFilters(m: Measure, filters: AggregateOptions['filters']): boolean {
  if (!filters) return true;
  for (const [key, want] of Object.entries(filters)) {
    if (want === undefined) continue;
    const have = m.dimensions[key] ?? null;
    if ((want ?? null) !== have) return false;
  }
  return true;
}

export function selectMeasures(measures: Measure[], opts: AggregateOptions = {}): Measure[] {
  return dedupe(measures).filter((m) => {
    if ((opts.from || opts.to) && !m.date) return false;
    if (opts.from && m.date < opts.from) return false;
    if (opts.to && m.date > opts.to) return false;
    return matchesFilters(m, opts.filters);
  });
}

export function totals(measures: Measure[], opts: AggregateOptions = {}): MetricTotal[] {
  const aggregation = opts.aggregation || 'sum';
  const groups = new Map<string, Measure[]>();
  for (const m of selectMeasures(measures, opts)) {
    const list = groups.get(m.metricId);
    if (list) list.push(m); else groups.set(m.metricId, [m]);
  }
  const out: MetricTotal[] = [];
  for (const [metricId, list] of groups) {
    const ordered = [...list].sort((a, b) => a.date.localeCompare(b.date));
    const head = ordered[0];
    out.push({
      metricId, metricLabel: head.metricLabel, kind: head.kind, unit: head.unit, unitKey: head.unitKey,
      aggregation, value: apply(aggregation, ordered.map((m) => m.value)),
      outcomes: new Set(ordered.map((m) => m.outcomeId)).size,
      headline: head.headline,
      contributors: [...new Set(ordered.map((m) => m.outcomeId))],
    });
  }
  return out.sort((a, b) => Number(b.headline) - Number(a.headline) || Math.abs(b.value) - Math.abs(a.value));
}

export function totalFor(measures: Measure[], metricId: string, opts: AggregateOptions = {}): MetricTotal | null {
  const id = canonicalMetricId(metricId);
  return totals(measures, opts).find((t) => t.metricId === id) || null;
}

export function headline(measures: Measure[], opts: AggregateOptions = {}): { headline: MetricTotal[]; tracked: MetricTotal[] } {
  const all = totals(measures, opts);
  return { headline: all.filter((t) => t.headline), tracked: all.filter((t) => !t.headline) };
}

export interface Bucket { key: string; from: string; to: string; label: string }

export function series(measures: Measure[], metricId: string, buckets: Bucket[], opts: AggregateOptions = {}) {
  const id = canonicalMetricId(metricId);
  const selected = selectMeasures(measures, opts).filter((m) => m.metricId === id);
  return buckets.map((b) => {
    const inBucket = selected.filter((m) => m.date >= b.from && m.date <= b.to);
    return {
      key: b.key, label: b.label,
      value: apply(opts.aggregation || 'sum', inBucket.map((m) => m.value)),
      outcomes: new Set(inBucket.map((m) => m.outcomeId)).size,
      contributors: [...new Set(inBucket.map((m) => m.outcomeId))],
    };
  });
}

export interface ProgressInput {
  measures: Measure[];
  metricId: string;
  direction: Direction;
  baseline?: number | null;
  target?: number | null;
  aggregation?: Aggregation;
  from?: string | null;
  to?: string | null;
  filters?: AggregateOptions['filters'];
  completed?: boolean;
}

export interface ProgressResult { current: number; percent: number; met: boolean; outcomes: number; contributors: string[] }

/** Progress toward a typed target. Never compares across units. */
export function progress(input: ProgressInput): ProgressResult {
  const opts: AggregateOptions = { aggregation: input.aggregation, filters: input.filters, from: input.from, to: input.to };
  const total = totalFor(input.measures, input.metricId, opts);
  const current = total?.value ?? 0;
  const outcomes = total?.outcomes ?? 0;
  const contributors = total?.contributors ?? [];
  const baseline = Number(input.baseline ?? 0);
  const target = input.target == null ? null : Number(input.target);

  if (input.direction === 'completion') {
    const met = Boolean(input.completed);
    return { current, percent: met ? 100 : 0, met, outcomes, contributors };
  }
  if (target == null) return { current, percent: 0, met: false, outcomes, contributors };
  if (input.direction === 'threshold') {
    const met = current >= target;
    return { current, percent: met ? 100 : clampPercent((current / target) * 100), met, outcomes, contributors };
  }
  if (input.direction === 'decrease') {
    const span = baseline - target;
    const met = current <= target;
    return { current, percent: span <= 0 ? (met ? 100 : 0) : clampPercent(((baseline - current) / span) * 100), met, outcomes, contributors };
  }
  const span = target - baseline;
  const met = current >= target;
  return { current, percent: span <= 0 ? (met ? 100 : 0) : clampPercent(((current - baseline) / span) * 100), met, outcomes, contributors };
}

const clampPercent = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n * 10) / 10)) : 0);

export interface CatalogEntry { metricId: string; metricLabel: string; kind: MetricKind; unit: string; headline: boolean }

export function catalog(measures: Measure[]): CatalogEntry[] {
  const seen = new Map<string, CatalogEntry>();
  for (const m of measures) if (!seen.has(m.metricId)) seen.set(m.metricId, { metricId: m.metricId, metricLabel: m.metricLabel, kind: m.kind, unit: m.unit, headline: m.headline });
  return [...seen.values()].sort((a, b) => a.metricLabel.localeCompare(b.metricLabel));
}
