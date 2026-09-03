import { SUMMABLE_DOLLAR_TYPES } from './constants.ts';

export interface GoalLike { user_id?: string; assignee_id?: string | null; visibility?: string; unit_id?: string | null; metric?: string | null; category?: string | null; period_start?: string | null; period_end?: string | null; current_value?: number | string | null; target_value?: number | string | null }
export interface ActivityLike { user_id?: string; date?: string | null; category?: string | null; quantity?: number | null; dollar_amount?: number | null; dollar_type?: string | null }
export interface TrainingLike { user_id?: string; date?: string | null; hours?: number | null }

/** Progress for a goal. Auto-tracked metrics derive from the subject's activities/trainings inside the goal window; manual goals use the stored value. */
export function goalProgress(g: GoalLike, activities: ActivityLike[] = [], trainings: TrainingLike[] = []) {
  const subject = g.assignee_id || g.user_id;
  const inWindow = (d: string | null | undefined) => Boolean(d) && (!g.period_start || d! >= g.period_start) && (!g.period_end || d! <= g.period_end);
  const acts = activities.filter((a) => (!subject || a.user_id === subject) && inWindow(a.date) && (!g.category || a.category === g.category));
  let current = Number(g.current_value) || 0;
  if (g.metric === 'activity_count') current = acts.length;
  else if (g.metric === 'activity_dollars') current = acts.reduce((n, a) => n + ((a.dollar_amount && (!a.dollar_type || SUMMABLE_DOLLAR_TYPES.includes(a.dollar_type))) ? Number(a.dollar_amount) : 0), 0);
  else if (g.metric === 'activity_quantity') current = acts.reduce((n, a) => n + (Number(a.quantity) || 0), 0);
  else if (g.metric === 'training_hours') current = trainings.filter((t) => (!subject || t.user_id === subject) && inWindow(t.date)).reduce((n, t) => n + (Number(t.hours) || 0), 0);
  current = Math.round(current * 100) / 100;
  const target = Number(g.target_value) || 0;
  return { current, target, pct: target ? Math.min(100, Math.max(0, (current / target) * 100)) : 0, auto: Boolean(g.metric) && g.metric !== 'manual' };
}
