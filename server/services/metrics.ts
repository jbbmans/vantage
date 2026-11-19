import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { readableClause } from '../authz/records.ts';
import { subtreeIds } from '../authz/scope.ts';
import { zonedDay } from '../lib/clock.ts';
import { periodClause } from './timeframes.ts';
import {
  measuresOfAll, totals, headline, series, catalog, selectMeasures, canonicalMetricId, aggregateValues,
  type Measure, type MetricTotal, type MetricFigure, type MetricPoint, type Bucket, type Aggregation, type AggregateOptions,
} from '../../shared/metricEngine.ts';
import { DRILL_LIMIT } from '../../shared/unitAnalytics.ts';
import { badRequest } from '../lib/errors.ts';

/**
 * A unit's records in a window, read by the index on the last day each record covers (migration 039), so a window costs
 * its own rows rather than every year of history before it. The index is on the very expression periodClause writes;
 * naming it means a change to that expression stops these reads with an error, which a test catches, rather than
 * quietly reading all of history. Each such read keeps `deleted_at IS NULL`, and `visibility = 'unit'` where the index
 * has it, at the top level of its WHERE, which the index needs.
 */
export const BY_LAST_DAY = {
  activities: 'INDEXED BY idx_activities_unit_last',
  trainings: 'INDEXED BY idx_trainings_unit_last',
  duties: 'INDEXED BY idx_duties_unit_last',
} as const;

export interface MetricScopeOptions {
  from: string;
  to: string;
  unitId?: string | null;
  /** Restrict to one person. Omitted means everyone in scope. */
  subjectId?: string | null;
  /** Only the caller's own work, whatever else they can read. */
  mineOnly?: boolean;
  aggregation?: Aggregation;
  filters?: AggregateOptions['filters'];
}

interface SourceRow {
  id: string; user_id: string; unit_id: string | null; date: string; end_date: string | null; ongoing: number; title: string;
  category: string | null; eval_area: string | null; quantity: number | null; unit_label: string | null;
  dollar_amount: number | null; dollar_type: string | null; organization: string | null; system: string | null;
  result: string | null; hours: number | null;
}

const ACTIVITY_COLUMNS = `t.id, t.user_id, t.unit_id, t.date, t.end_date, t.ongoing, t.title, t.category, t.eval_area, t.quantity, t.unit_label,
  t.dollar_amount, t.dollar_type, t.organization, t.system, t.result, NULL AS hours`;

const TRAINING_COLUMNS = `t.id, t.user_id, t.unit_id, t.date, t.end_date, t.ongoing, t.title, NULL AS category, NULL AS eval_area,
  NULL AS quantity, NULL AS unit_label, NULL AS dollar_amount, NULL AS dollar_type, NULL AS organization,
  NULL AS system, NULL AS result, t.hours`;

type RowLoader = (table: 'activities' | 'trainings', columns: string) => SourceRow[];

/**
 * An entry is in the window when any day of it is (ADR-0018), and counted on its first day there: once in a total, in
 * one bucket of a series, however long it ran. The rows keep their own dates for anyone reading them.
 */
const counted = (rows: SourceRow[], from: string): SourceRow[] => rows.map((r) => (r.date < from ? { ...r, date: from } : r));

function collectRows(load: RowLoader): SourceRow[] {
  return [
    ...load('activities', ACTIVITY_COLUMNS).map((r) => ({ ...r, id: `activities:${r.id}` })),
    ...load('trainings', TRAINING_COLUMNS).map((r) => ({ ...r, id: `trainings:${r.id}` })),
  ];
}

function sourceRows(ctx: AppContext, user: SessionUser, scope: Scope, opts: MetricScopeOptions): SourceRow[] {
  return collectRows((table, columns) => {
    const { clause, params } = readableClause(ctx, scope, user.id, 't');
    const period = periodClause(table, 't', opts.from, opts.to);
    const where = ['t.deleted_at IS NULL', clause, period.sql];
    params.push(...period.params);
    if (opts.unitId) { where.push("t.unit_id IN (SELECT value FROM json_each(?)) AND t.visibility = 'unit'"); params.push(JSON.stringify(subtreeIds(ctx, opts.unitId))); }
    if (opts.subjectId) { where.push('t.user_id = ?'); params.push(opts.subjectId); }
    if (opts.mineOnly) { where.push('t.user_id = ?'); params.push(user.id); }
    // A unit's figures read the unit's window by the last day each record covers; one person's read by their own index.
    const by = opts.unitId && !opts.subjectId && !opts.mineOnly ? ` ${BY_LAST_DAY[table]}` : '';
    return ctx.db.prepare(`SELECT ${columns} FROM ${table} t${by} WHERE ${where.join(' AND ')}`).all(...params) as SourceRow[];
  });
}

export function subjectMeasures(ctx: AppContext, subjectId: string, opts: { from: string; to: string; unitId?: string | null; sharedOnly?: boolean }): Measure[] {
  const rows = collectRows((table, columns) => {
    const period = periodClause(table, 't', opts.from, opts.to);
    const where = ['t.deleted_at IS NULL', 't.user_id = ?', period.sql];
    const params: unknown[] = [subjectId, ...period.params];
    if (opts.sharedOnly && opts.unitId) { where.push("t.visibility = 'unit' AND t.unit_id IN (SELECT value FROM json_each(?))"); params.push(JSON.stringify(subtreeIds(ctx, opts.unitId))); }
    return ctx.db.prepare(`SELECT ${columns} FROM ${table} t WHERE ${where.join(' AND ')}`).all(...params) as SourceRow[];
  });
  return measuresOfAll(counted(rows, opts.from) as never, ctx.runtime.metrics);
}

/** The shared records of the units given, as measures. The caller decides which units the reader may read. */
export function unitMeasures(ctx: AppContext, unitIds: readonly string[], opts: { from: string; to: string }): Measure[] {
  const rows = collectRows((table, columns) => {
    const period = periodClause(table, 't', opts.from, opts.to);
    return ctx.db.prepare(
      `SELECT ${columns} FROM ${table} t ${BY_LAST_DAY[table]} WHERE t.deleted_at IS NULL AND t.visibility = 'unit' AND t.unit_id IN (SELECT value FROM json_each(?)) AND ${period.sql}`
    ).all(JSON.stringify(unitIds), ...period.params) as SourceRow[];
  });
  return measuresOfAll(counted(rows, opts.from) as never, ctx.runtime.metrics);
}

export function measuresFor(ctx: AppContext, user: SessionUser, scope: Scope, opts: MetricScopeOptions): Measure[] {
  return measuresOfAll(counted(sourceRows(ctx, user, scope, opts), opts.from) as never, ctx.runtime.metrics);
}

/** The most months a series draws: the last twenty years of a longer window, such as All time. */
export const MAX_MONTHS = 240;

export function monthlyBuckets(from: string, to: string): Bucket[] {
  const out: Bucket[] = [];
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  if (!fy || !ty) return out;
  // A window longer than the series draws keeps its latest months, the ones that end where the window does.
  const months = (ty - fy) * 12 + (tm - fm) + 1;
  const skip = Math.max(0, months - MAX_MONTHS);
  let y = fy + Math.floor((fm - 1 + skip) / 12); let m = ((fm - 1 + skip) % 12) + 1;
  for (let guard = 0; guard < MAX_MONTHS && (y < ty || (y === ty && m <= tm)); guard += 1) {
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
    // No value and the literal "Unassigned" (what an unknown area is saved as) are one bucket, so the rows sum to the headline.
    const valueOf = (m: Measure) => m.dimensions[dimension] ?? 'Unassigned';
    const values = new Set(selectMeasures(measures, base).map(valueOf));
    return [...values].sort().map((value) => ({
      dimension, value,
      totals: totals(measures.filter((m) => valueOf(m) === value), base),
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

/**
 * The report as /metrics answers it: every figure without the outcome ids behind it. Those ids are kept on the server,
 * where goal progress uses them; the page opens a figure's outcomes through /metrics/contributors, a page at a time,
 * so the report stays the size of its figures however many records they count.
 */
export interface MetricsResponse extends Omit<MetricsReport, 'headline' | 'tracked' | 'priorHeadline' | 'monthly' | 'byCategory' | 'byArea'> {
  headline: MetricFigure[];
  tracked: MetricFigure[];
  priorHeadline: MetricFigure[];
  monthly: Array<{ metricId: string; metricLabel: string; unit: string; points: MetricPoint[] }>;
  byCategory: Array<{ dimension: string; value: string; totals: MetricFigure[] }>;
  byArea: Array<{ dimension: string; value: string; totals: MetricFigure[] }>;
}

const figure = ({ contributors: _ids, ...rest }: MetricTotal): MetricFigure => rest;
const point = ({ contributors: _ids, ...rest }: ReturnType<typeof series>[number]): MetricPoint => rest;
const breakdown = (b: MetricBreakdown) => ({ dimension: b.dimension, value: b.value, totals: b.totals.map(figure) });

export function metricsResponse(r: MetricsReport): MetricsResponse {
  return {
    ...r,
    headline: r.headline.map(figure), tracked: r.tracked.map(figure), priorHeadline: r.priorHeadline.map(figure),
    monthly: r.monthly.map((m) => ({ ...m, points: m.points.map(point) })),
    byCategory: r.byCategory.map(breakdown), byArea: r.byArea.map(breakdown),
  };
}

export interface Contributor {
  id: string; table: 'activities' | 'trainings'; date: string; end_date: string | null; ongoing: boolean; title: string;
  user_id: string; unit_id: string | null; value: number; unit: string;
}

/** The outcomes behind one figure: how many, what they add to, and the first DRILL_LIMIT of them, newest first. */
export interface ContributorList { count: number; value: number; records: Contributor[] }

/**
 * The outcomes one figure counts, or one month of it. Read through the same authorization as the figure (readableClause),
 * so the count and the sum are of what the reader may see, and cut to DRILL_LIMIT only after that, with the count saying
 * how many there are in all.
 */
export function metricContributors(ctx: AppContext, user: SessionUser, scope: Scope, opts: MetricScopeOptions & { metricId: string; month?: string | null }): ContributorList {
  const rows = sourceRows(ctx, user, scope, opts);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const measures = measuresOfAll(counted(rows, opts.from) as never, ctx.runtime.metrics);
  let selected = selectMeasures(measures, { aggregation: opts.aggregation, filters: opts.filters }).filter((m) => m.metricId === canonicalMetricId(opts.metricId));
  if (opts.month) {
    // The month as the series draws it, so its list is exactly what its column counts.
    const bucket = monthlyBuckets(opts.from, opts.to).find((b) => b.key === opts.month);
    if (!bucket) throw badRequest('That month is not in the window.', { fieldErrors: { month: 'Not in the window.' } });
    selected = selected.filter((m) => m.date >= bucket.from && m.date <= bucket.to);
  }
  const all = selected.map((m) => {
    const row = byId.get(m.outcomeId)!;
    const [table, id] = m.outcomeId.split(':') as ['activities' | 'trainings', string];
    return { id, table, date: row.date, end_date: row.end_date, ongoing: row.ongoing === 1, title: row.title, user_id: row.user_id, unit_id: row.unit_id, value: m.value, unit: m.unit };
  }).sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.value) - Math.abs(a.value));
  // What the figure is, by its own aggregation over the same values in date order (a sum, a maximum, the latest...).
  const value = Math.round(aggregateValues(opts.aggregation || 'sum', [...all].sort((a, b) => a.date.localeCompare(b.date)).map((c) => c.value)) * 100) / 100;
  // Measures are one per outcome and metric (dedupe), so this counts outcomes, as the figure's `outcomes` does.
  return { count: all.length, value, records: all.slice(0, DRILL_LIMIT) };
}

export function defaultPeriod(ctx: AppContext): { from: string; to: string } {
  const today = zonedDay(ctx.config.timezone);
  const [year, month] = today.split('-').map(Number);
  const fyStart = month >= 10 ? year : year - 1;
  return { from: `${fyStart}-10-01`, to: today };
}
