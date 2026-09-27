import type { AppContext } from '../context.ts';
import { badRequest } from '../lib/errors.ts';
import { subjectMeasures, unitMeasures } from './metrics.ts';
import { progress, totals, selectMeasures, moneyMetricId, quantityMetricId, durationMetricId, canonicalMetricId, type Direction, type Aggregation, type ProgressResult } from '../../shared/metricEngine.ts';

export const DIRECTIONS: Direction[] = ['increase', 'decrease', 'threshold', 'completion'];
export const AGGREGATIONS: Aggregation[] = ['sum', 'max', 'min', 'average', 'latest', 'distinct'];

function parseFilters(value: unknown): Record<string, string | null> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, string | null>;
  try { return JSON.parse(String(value || '{}')) as Record<string, string | null>; } catch { return {}; }
}

export interface GoalRow {
  id: string; user_id: string; assignee_id: string | null; unit_id: string | null; visibility: string;
  title: string; description: string | null; type: string; category: string | null;
  metric: string; metric_id: string | null; direction: string; baseline_value: number | null;
  aggregation: string; filters: string; measure_scope: string;
  current_value: number; target_value: number | null; unit_label: string | null;
  status: string; period_start: string | null; period_end: string | null; completed_at: string | null;
  version: number; created_at: string; updated_at: string;
}

export function legacyMetricId(goal: Pick<GoalRow, 'metric' | 'unit_label'>): string | null {
  switch (goal.metric) {
    case 'activity_dollars': return null; // spanned several value types, so it has no single typed metric
    case 'activity_quantity': return quantityMetricId(goal.unit_label);
    case 'training_hours': return durationMetricId();
    default: return null;
  }
}

export const countsEntries = (goal: Pick<GoalRow, 'metric' | 'metric_id'>) => !goal.metric_id && goal.metric === 'activity_count';

export interface GoalProgress extends ProgressResult {
  basis: string;
  auto: boolean;
  measuresEntries: boolean;
  metricId: string | null;
  unit: string | null;
}

function windowFor(goal: GoalRow): { from: string | null; to: string | null } {
  return { from: goal.period_start || null, to: goal.period_end || null };
}

interface GoalWindow { from: string; to: string }

function goalWindow(goal: GoalRow): GoalWindow {
  const window = windowFor(goal);
  return { from: window.from || '1970-01-01', to: window.to || '9999-12-31' };
}

function measuresForGoal(ctx: AppContext, goal: GoalRow) {
  const window = goalWindow(goal);
  if (goal.measure_scope === 'unit' && goal.unit_id) return unitMeasures(ctx, goal.unit_id, window);
  return subjectMeasures(ctx, goal.assignee_id || goal.user_id, {
    ...window,
    unitId: goal.unit_id,
    sharedOnly: goal.visibility === 'unit' && Boolean(goal.unit_id),
  });
}

export function goalProgressFor(ctx: AppContext, goal: GoalRow): GoalProgress {
  const manual = goal.metric === 'manual' && !goal.metric_id;
  const filters = { ...parseFilters(goal.filters), ...(goal.category && !goal.metric_id ? { category: goal.category } : {}) };
  const saved = goal.metric_id || legacyMetricId(goal);
  const metricId = saved ? canonicalMetricId(saved) : saved;
  const direction = (DIRECTIONS.includes(goal.direction as Direction) ? goal.direction : 'increase') as Direction;
  const aggregation = (AGGREGATIONS.includes(goal.aggregation as Aggregation) ? goal.aggregation : 'sum') as Aggregation;
  const target = goal.target_value == null ? null : Number(goal.target_value);
  const baseline = goal.baseline_value == null ? 0 : Number(goal.baseline_value);
  const window = windowFor(goal);
  const period = window.from || window.to ? `between ${window.from || 'the beginning'} and ${window.to || 'today'}` : 'over the whole record';
  const who = goal.measure_scope === 'unit' && goal.unit_id ? 'across the unit' : 'from the work of the person it is set for';

  if (countsEntries(goal)) {
    // Read, never rewritten, and never presented as a measure of the work.
    const current = Number(goal.current_value) || 0;
    return {
      current, percent: target ? Math.min(100, Math.max(0, (current / target) * 100)) : 0,
      met: target != null && current >= target, outcomes: 0, contributors: [],
      basis: 'This goal counts how many entries were made, which is not a measure of the work. It is kept as recorded. Set a goal on what the work produced instead.',
      auto: true, measuresEntries: true, metricId: null, unit: 'entries',
    };
  }

  if (manual || !metricId) {
    const current = Number(goal.current_value) || 0;
    const met = direction === 'completion' ? Boolean(goal.completed_at)
      : direction === 'decrease' ? (target != null && current <= target)
      : (target != null && current >= target);
    const span = direction === 'decrease' ? baseline - (target ?? 0) : (target ?? 0) - baseline;
    const moved = direction === 'decrease' ? baseline - current : current - baseline;
    return {
      current,
      percent: direction === 'completion' ? (met ? 100 : 0) : span <= 0 ? (met ? 100 : 0) : Math.max(0, Math.min(100, Math.round((moved / span) * 1000) / 10)),
      met, outcomes: 0, contributors: [],
      basis: goal.metric === 'activity_dollars'
        ? 'This goal was set before Vantage separated value types, so its figure is entered by hand. Point it at one value type to track it automatically.'
        : 'Entered by hand.',
      auto: false, measuresEntries: false, metricId: null, unit: goal.unit_label,
    };
  }

  const opts = goalWindow(goal);
  const measures = measuresForGoal(ctx, goal);
  const result = progress({
    measures, metricId, direction, baseline, target, aggregation,
    from: opts.from, to: opts.to, filters,
    completed: Boolean(goal.completed_at),
  });
  const filterText = Object.entries(filters).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} is ${v ?? 'unset'}`).join(', ');
  let mismatch = '';
  if (result.outcomes === 0 && metricId.startsWith('quantity:')) {
    const present = [...new Set(totals(measures, { filters, from: opts.from, to: opts.to }).filter((t) => t.kind === 'quantity').map((t) => t.unit))];
    if (present.length) mismatch = ` Nothing was counted, because the work in this period is measured in ${present.join(', ')} rather than ${goal.unit_label || 'items'}.`;
  }
  return {
    ...result,
    basis: `Counted ${aggregation === 'sum' ? 'by adding' : `by taking the ${aggregation}`} ${who} ${period}${filterText ? `, where ${filterText}` : ''}.${mismatch}`,
    auto: true, measuresEntries: false, metricId,
    unit: totals(measures, { filters, from: opts.from, to: opts.to }).find((t) => t.metricId === metricId)?.unit ?? goal.unit_label,
  };
}

export function withTypedProgress(ctx: AppContext, goals: GoalRow[]) {
  return goals.map((g) => {
    const p = goalProgressFor(ctx, g);
    return { ...g, filters: parseFilters(g.filters), current_value: p.current, progress: p };
  });
}

export interface GoalContributor { table: string; id: string; date: string; title: string; value: number; unit: string }

export function goalContributors(ctx: AppContext, goal: GoalRow): GoalContributor[] {
  const saved = goal.metric_id || legacyMetricId(goal);
  const metricId = saved ? canonicalMetricId(saved) : saved;
  if (!metricId) return [];
  const filters = { ...parseFilters(goal.filters), ...(goal.category && !goal.metric_id ? { category: goal.category } : {}) };
  const window = goalWindow(goal);
  const measures = measuresForGoal(ctx, goal);
  const chosen = selectMeasures(measures, { filters, from: window.from, to: window.to }).filter((m) => m.metricId === metricId);
  const rows = new Map<string, GoalContributor>();
  for (const m of chosen) {
    const [table, id] = m.outcomeId.split(':');
    const source = ctx.db.prepare(`SELECT title, date FROM ${table === 'trainings' ? 'trainings' : 'activities'} WHERE id = ?`).get(id) as { title: string; date: string } | undefined;
    rows.set(m.outcomeId, { table, id, date: source?.date || m.date, title: source?.title || '', value: m.value, unit: m.unit });
  }
  return [...rows.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export interface TypedGoalInput {
  metric_id?: string | null;
  direction?: string;
  baseline_value?: number | null;
  aggregation?: string;
  filters?: Record<string, string | null> | null;
  measure_scope?: string;
}

export function validateTypedGoal(ctx: AppContext, input: TypedGoalInput, target: number | null | undefined) {
  const direction = input.direction || 'increase';
  if (!DIRECTIONS.includes(direction as Direction)) throw badRequest('That is not a direction a goal can have.');
  if (input.aggregation && !AGGREGATIONS.includes(input.aggregation as Aggregation)) throw badRequest('That is not a way Vantage can aggregate a measure.');
  if (input.measure_scope && !['subject', 'unit'].includes(input.measure_scope)) throw badRequest('A goal measures either one person or one unit.');
  if (direction !== 'completion' && input.metric_id && (target == null || !Number.isFinite(Number(target)))) {
    throw badRequest('Say what the target is, in the unit the metric is measured in.');
  }
  if (input.metric_id) {
    const id = String(input.metric_id);
    const known = id === durationMetricId()
      || id.startsWith('quantity:')
      || ctx.runtime.metrics.value_types.some((t) => moneyMetricId(t.key) === id);
    if (!known) throw badRequest('That is not a metric this instance measures.');
  }
  if (input.filters) {
    const allowed = new Set(['category', 'area', 'organization', 'system', 'user_id', 'unit_id']);
    for (const key of Object.keys(input.filters)) if (!allowed.has(key)) throw badRequest(`A goal cannot be filtered by "${key}".`);
  }
}
