import type { AppContext } from '../context.ts';
import { composeNarrative } from '../../shared/narrative.ts';
import { buildPackage, type BulletStyle } from '../../shared/bullets.ts';
import { aggregateMetrics, rangeForPeriod, formatDTG, type PeriodKey } from '../../shared/metrics.ts';
import { narrativeConfig, areasFor, trackForGrade, type Track } from '../../shared/evaluation.ts';
import { hydrate } from './records.ts';
import { zonedNow } from '../lib/clock.ts';

export interface ReportScope { userId: string; unitId?: string | null }

const iso = (d: Date) => d.toISOString().slice(0, 10);
const localIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function periodBounds(period: string, from?: string | null, to?: string | null, timezone = 'UTC') {
  if (from && to) return { from, to, label: `${formatDTG(from)} to ${formatDTG(to)}` };
  const range = rangeForPeriod(period as PeriodKey, zonedNow(timezone));
  return { from: localIso(range.start), to: localIso(range.end), label: range.label };
}

export function buildReport(ctx: AppContext, opts: { userId: string; unitId?: string | null; period: string; from?: string | null; to?: string | null; style?: BulletStyle; limit?: number; track?: Track | null }) {
  const { from, to, label } = periodBounds(opts.period, opts.from, opts.to, ctx.config.timezone);
  const person = ctx.db.prepare(`SELECT u.first_name, u.last_name, u.mos, r.abbr AS rank_abbr, r.grade AS rank_grade FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?`).get(opts.userId) as { first_name: string; last_name: string; mos: string | null; rank_abbr: string | null; rank_grade: string | null } | undefined;
  const track: Track = opts.track || trackForGrade(person?.rank_grade);
  const where = opts.unitId ? `user_id = ? AND unit_id = ? AND visibility = 'unit'` : 'user_id = ?';
  const params = opts.unitId ? [opts.userId, opts.unitId] : [opts.userId];
  const activities = (ctx.db.prepare(`SELECT * FROM activities WHERE ${where} AND deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date DESC`).all(...params, from, to) as Array<Record<string, unknown>>).map((r) => hydrate(r, 'activities')!);
  const awards = ctx.db.prepare(`SELECT name, date, status FROM awards WHERE ${where} AND deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date DESC`).all(...params, from, to) as Array<{ name: string; date: string | null; status: string }>;
  const trainings = ctx.db.prepare(`SELECT title, date, hours FROM trainings WHERE ${where} AND deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date DESC`).all(...params, from, to) as Array<{ title: string; date: string | null; hours: number | null }>;
  const cfg = narrativeConfig(track);
  const narrative = composeNarrative(activities as never, { ...cfg, periodLabel: label });
  const pkg = buildPackage(activities as never, { periodLabel: label, style: opts.style || (track === 'fitrep' ? 'fitrep' : 'jepes'), limitPerArea: opts.limit ?? 8, areas: areasFor(track) });
  const metrics = aggregateMetrics(activities as never);
  const unit = opts.unitId ? (ctx.db.prepare('SELECT name, short_name FROM units WHERE id = ?').get(opts.unitId) as { name: string; short_name: string | null } | undefined) : undefined;
  return {
    from, to, label, track, person, unit,
    subject: `${person?.rank_abbr || ''} ${person?.first_name || ''} ${person?.last_name || ''}`.replace(/\s+/g, ' ').trim(),
    narrative, pkg, metrics, activities, awards, trainings,
    counts: { activities: activities.length, awards: awards.length, trainingHours: trainings.reduce((n, t) => n + (Number(t.hours) || 0), 0) },
    generatedAt: iso(new Date()),
  };
}
