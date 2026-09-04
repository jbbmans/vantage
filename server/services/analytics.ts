import type { AppContext } from '../context.ts';
import { buildAnalysis, type Analysis } from '../../shared/analytics.ts';
import { areasFor, trackForGrade, type Track } from '../../shared/evaluation.ts';
import { previousRange, formatDTG } from '../../shared/metrics.ts';
import { hydrate, withGoalProgress } from './records.ts';
import { periodBounds } from './reports.ts';
import { zonedNow } from '../lib/clock.ts';

const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface AnalysisReport extends Analysis {
  subject: string; person: { first_name: string; last_name: string; mos: string | null; rank_abbr: string | null } | undefined; unit: { name: string; short_name: string | null } | undefined;
  track: Track; generatedAt: string; label: string; metricsConfig: AppContext['runtime']['metrics'];
}

/** The full analytical package for one Marine over one period, scoped to shared records when a leader asks. */
export function buildAnalysisReport(ctx: AppContext, opts: { userId: string; unitId?: string | null; period: string; from?: string | null; to?: string | null; track?: Track | null }): AnalysisReport {
  const bounds = periodBounds(opts.period, opts.from, opts.to, ctx.config.timezone);
  const cur = { start: new Date(`${bounds.from}T00:00:00`), end: new Date(`${bounds.to}T23:59:59`) };
  const prev = previousRange(cur);
  const prior = { from: localIso(prev.start), to: localIso(prev.end), label: `${formatDTG(prev.start)} to ${formatDTG(prev.end)}` };
  const person = ctx.db.prepare(`SELECT u.first_name, u.last_name, u.mos, r.abbr AS rank_abbr, r.grade AS rank_grade FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?`).get(opts.userId) as { first_name: string; last_name: string; mos: string | null; rank_abbr: string | null; rank_grade: string | null } | undefined;
  const track: Track = opts.track || trackForGrade(person?.rank_grade);
  const where = opts.unitId ? `user_id = ? AND unit_id = ? AND visibility = 'unit'` : 'user_id = ?';
  const params = opts.unitId ? [opts.userId, opts.unitId] : [opts.userId];
  const activities = (ctx.db.prepare(`SELECT * FROM activities WHERE ${where} AND deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date DESC`).all(...params, prior.from, bounds.to) as Array<Record<string, unknown>>).map((r) => hydrate(r, 'activities')!);
  const awards = ctx.db.prepare(`SELECT name, date, status, type FROM awards WHERE ${where} AND deleted_at IS NULL AND date >= ? AND date <= ?`).all(...params, prior.from, bounds.to) as Array<{ name: string; date: string | null; status: string; type: string | null }>;
  const trainings = ctx.db.prepare(`SELECT title, date, hours, type, status FROM trainings WHERE ${where} AND deleted_at IS NULL AND date >= ? AND date <= ?`).all(...params, prior.from, bounds.to) as Array<{ title: string; date: string | null; hours: number | null; type: string | null; status: string | null }>;
  const counselings = ctx.db.prepare(`SELECT date, type, acknowledged_at FROM counselings WHERE ${where} AND deleted_at IS NULL AND date >= ? AND date <= ?`).all(...params, prior.from, bounds.to) as Array<{ date: string | null; type: string | null; acknowledged_at: string | null }>;
  const goalWhere = opts.unitId ? `(user_id = ? OR assignee_id = ?) AND unit_id = ? AND visibility = 'unit'` : '(user_id = ? OR assignee_id = ?)';
  const goalParams = opts.unitId ? [opts.userId, opts.userId, opts.unitId] : [opts.userId, opts.userId];
  const goals = withGoalProgress(ctx, ctx.db.prepare(`SELECT * FROM goals WHERE ${goalWhere} AND deleted_at IS NULL AND (period_end IS NULL OR period_end >= ?) AND (period_start IS NULL OR period_start <= ?) ORDER BY updated_at DESC LIMIT 50`).all(...goalParams, bounds.from, bounds.to) as never[]) as Array<Record<string, unknown>>;
  const profile = opts.unitId ? null : (ctx.db.prepare('SELECT * FROM readiness WHERE user_id = ?').get(opts.userId) as Record<string, unknown> | undefined) || {};
  const unit = opts.unitId ? (ctx.db.prepare('SELECT name, short_name FROM units WHERE id = ?').get(opts.unitId) as { name: string; short_name: string | null } | undefined) : undefined;
  const today = localIso(zonedNow(ctx.config.timezone));
  const analysis = buildAnalysis({
    activities: activities as never, period: { from: bounds.from, to: bounds.to, label: bounds.label }, prior, today, areas: areasFor(track), track, metrics: ctx.runtime.metrics,
    goals: goals as never, trainings, awards, counselings, profile,
  });
  return {
    ...analysis, track, label: bounds.label, person, unit, metricsConfig: ctx.runtime.metrics,
    subject: `${person?.rank_abbr || ''} ${person?.first_name || ''} ${person?.last_name || ''}`.replace(/\s+/g, ' ').trim(),
    generatedAt: new Date().toISOString().slice(0, 10),
  };
}
