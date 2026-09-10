import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { readableClause } from '../authz/records.ts';
import { zonedDay } from '../lib/clock.ts';
import {
  measuresOfAll, totals, headline, series, catalog, selectMeasures,
  type Measure, type MetricTotal, type Bucket, type Aggregation, type AggregateOptions,
} from '../../shared/metricEngine.ts';

/**
 * The server side of the one metric layer.
 *
 * Every figure a client shows comes from here, computed over rows the caller is actually allowed to
 * read. The client never decides scope, and it never re-derives a total from a page of rows: a page
 * is a page, and a total over a page is a lie.
 */

export interface MetricScopeOptions {
  from: string;
  to: string;
  /** Restrict to one unit's shared work. Omitted means everything the caller can read. */
  unitId?: string | null;
  /** Restrict to one person. Omitted means everyone in scope. */
  subjectId?: string | null;
  /** Only the caller's own work, whatever else they can read. */
  mineOnly?: boolean;
  aggregation?: Aggregation;
  filters?: AggregateOptions['filters'];
}

interface SourceRow {
  id: string; user_id: string; unit_id: string | null; date: string; title: string;
  category: string | null; eval_area: string | null; quantity: number | null; unit_label: string | null;
  dollar_amount: number | null; dollar_type: string | null; organization: string | null; system: string | null;
  result: string | null; hours: number | null;
}

const ACTIVITY_COLUMNS = `t.id, t.user_id, t.unit_id, t.date, t.title, t.category, t.eval_area, t.quantity, t.unit_label,
  t.dollar_amount, t.dollar_type, t.organization, t.system, t.result, NULL AS hours`;

/** Training hours are measured work too, so duration comes from the same place as everything else. */
const TRAINING_COLUMNS = `t.id, t.user_id, t.unit_id, t.date, t.title, NULL AS category, NULL AS eval_area,
  NULL AS quantity, NULL AS unit_label, NULL AS dollar_amount, NULL AS dollar_type, NULL AS organization,
  NULL AS system, NULL AS result, t.hours`;

function sourceRows(ctx: AppContext, user: SessionUser, scope: Scope, opts: MetricScopeOptions): SourceRow[] {
  const collect = (table: 'activities' | 'trainings', columns: string): SourceRow[] => {
    const { clause, params } = readableClause(ctx, scope, user.id, 't');
    const where = ['t.deleted_at IS NULL', clause, 't.date >= ?', 't.date <= ?'];
    params.push(opts.from, opts.to);
    if (opts.unitId) { where.push("t.unit_id = ? AND t.visibility = 'unit'"); params.push(opts.unitId); }
    if (opts.subjectId) { where.push('t.user_id = ?'); params.push(opts.subjectId); }
    if (opts.mineOnly) { where.push('t.user_id = ?'); params.push(user.id); }
    return ctx.db.prepare(`SELECT ${columns} FROM ${table} t WHERE ${where.join(' AND ')}`).all(...params) as SourceRow[];
  };
  // Ids are namespaced so an activity and a training that share a rowid can never be treated as one outcome.
  return [
    ...collect('activities', ACTIVITY_COLUMNS).map((r) => ({ ...r, id: `activities:${r.id}` })),
    ...collect('trainings', TRAINING_COLUMNS).map((r) => ({ ...r, id: `trainings:${r.id}` })),
  ];
}

export function measuresFor(ctx: AppContext, user: SessionUser, scope: Scope, opts: MetricScopeOptions): Measure[] {
  return measuresOfAll(sourceRows(ctx, user, scope, opts) as never, ctx.runtime.metrics);
}

/** Calendar-month buckets across the period, so a chart and its total always agree. */
export function monthlyBuckets(from: string, to: string): Bucket[] {
  const out: Bucket[] = [];
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (!fy || !ty) return out;
  let y = fy; let m = fm;
  for (let guard = 0; guard < 240 && (y < ty || (y === ty && m <= tm)); guard += 1) {
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const end = `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
    out.push({
      key: start.slice(0, 7),
      from: start < from ? from : start,
      to: end > to ? to : end,
      label: new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
    });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function shiftBack(from: string, to: string): { from: string; to: string } {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const span = Math.max(end - start, 0) + 86_400_000;
  return {
    from: new Date(start - span).toISOString().slice(0, 10),
    to: new Date(end - span).toISOString().slice(0, 10),
  };
}

export interface MetricBreakdown { dimension: string; value: string; totals: MetricTotal[] }

export interface MetricsReport {
  period: { from: string; to: string };
  prior: { from: string; to: string };
  headline: MetricTotal[];
  tracked: MetricTotal[];
  priorHeadline: MetricTotal[];
  monthly: Array<{ metricId: string; metricLabel: string; unit: string; points: ReturnType<typeof series> }>;
  byCategory: MetricBreakdown[];
  byArea: MetricBreakdown[];
  catalog: ReturnType<typeof catalog>;
  /** Outcomes that produced at least one measure. Provenance, never a productivity score. */
  outcomesWithMeasures: number;
}

export function metricsReport(ctx: AppContext, user: SessionUser, scope: Scope, opts: MetricScopeOptions): MetricsReport {
  const measures = measuresFor(ctx, user, scope, opts);
  const prior = shiftBack(opts.from, opts.to);
  const priorMeasures = measuresFor(ctx, user, scope, { ...opts, ...prior });
  const base: AggregateOptions = { aggregation: opts.aggregation, filters: opts.filters };
  const { headline: head, tracked } = headline(measures, base);
  const buckets = monthlyBuckets(opts.from, opts.to);

  const dimensionTotals = (dimension: string): MetricBreakdown[] => {
    const values = new Set<string>();
    for (const m of selectMeasures(measures, base)) values.add(m.dimensions[dimension] ?? 'Unassigned');
    return [...values].sort().map((value) => ({
      dimension, value,
      totals: totals(measures, { ...base, filters: { ...base.filters, [dimension]: value === 'Unassigned' ? null : value } }),
    })).filter((b) => b.totals.length);
  };

  return {
    period: { from: opts.from, to: opts.to },
    prior,
    headline: head,
    tracked,
    priorHeadline: headline(priorMeasures, base).headline,
    monthly: head.slice(0, 4).map((t) => ({
      metricId: t.metricId, metricLabel: t.metricLabel, unit: t.unit,
      points: series(measures, t.metricId, buckets, base),
    })),
    byCategory: dimensionTotals('category'),
    byArea: dimensionTotals('area'),
    catalog: catalog(measures),
    outcomesWithMeasures: new Set(selectMeasures(measures, base).map((m) => m.outcomeId)).size,
  };
}

export interface Contributor {
  id: string; table: 'activities' | 'trainings'; date: string; title: string;
  user_id: string; unit_id: string | null; value: number; unit: string;
}

/**
 * The rows behind one figure. Every total in the product opens into this, so a number a member
 * cannot explain is a bug rather than a fact of life.
 */
export function metricContributors(ctx: AppContext, user: SessionUser, scope: Scope, opts: MetricScopeOptions & { metricId: string }): Contributor[] {
  const rows = sourceRows(ctx, user, scope, opts);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const measures = measuresOfAll(rows as never, ctx.runtime.metrics);
  const selected = selectMeasures(measures, { aggregation: opts.aggregation, filters: opts.filters }).filter((m) => m.metricId === opts.metricId);
  return selected.map((m) => {
    const row = byId.get(m.outcomeId)!;
    const [table, id] = m.outcomeId.split(':') as ['activities' | 'trainings', string];
    return { id, table, date: row.date, title: row.title, user_id: row.user_id, unit_id: row.unit_id, value: m.value, unit: m.unit };
  }).sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.value) - Math.abs(a.value));
}

/** The default reporting period: the current fiscal year to date, on the instance calendar. */
export function defaultPeriod(ctx: AppContext): { from: string; to: string } {
  const today = zonedDay(ctx.config.timezone);
  const [year, month] = today.split('-').map(Number);
  const fyStart = month >= 10 ? year : year - 1;
  return { from: `${fyStart}-10-01`, to: today };
}
