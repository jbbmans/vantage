import type { AppContext } from '../context.ts';
import { composeNarrative } from '../../shared/narrative.ts';
import { buildPackage, type BulletStyle } from '../../shared/bullets.ts';
import { aggregateMetrics, rangeForPeriod, formatDTG, type PeriodKey } from '../../shared/metrics.ts';
import { narrativeConfig, areasFor, areaAmong, trackForGrade, type Track } from '../../shared/evaluation.ts';
import { hydrate } from './records.ts';
import { isoDay, zonedDay, zonedNow } from '../lib/clock.ts';
import { caseworkFor } from './record.ts';
import type { Density, Format } from '../../shared/writer/realize.ts';

export interface ReportScope { userId: string; unitId?: string | null }

export function periodBounds(period: string, from?: string | null, to?: string | null, timezone = 'UTC') {
  if (from && to) return { from, to, label: `${formatDTG(from)} to ${formatDTG(to)}` };
  const range = rangeForPeriod(period as PeriodKey, zonedNow(timezone));
  return { from: isoDay(range.start), to: isoDay(range.end), label: range.label };
}

/** How the narrative is written: the wording seed, what is pinned or left out, compact or full, and its length. */
export interface NarrativeChoices { seed?: number; density?: Density | 'auto'; exclude?: string[]; pin?: string[]; chars?: number; format?: Format; spell?: boolean }

export function buildReport(ctx: AppContext, opts: { userId: string; unitId?: string | null; period: string; from?: string | null; to?: string | null; style?: BulletStyle; limit?: number; track?: Track | null; narrative?: NarrativeChoices }) {
  const { from, to, label } = periodBounds(opts.period, opts.from, opts.to, ctx.config.timezone);
  const person = ctx.db.prepare(`SELECT u.first_name, u.last_name, u.mos, r.abbr AS rank_abbr, r.grade AS rank_grade FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?`).get(opts.userId) as { first_name: string; last_name: string; mos: string | null; rank_abbr: string | null; rank_grade: string | null } | undefined;
  const track: Track = opts.track || trackForGrade(person?.rank_grade);
  const where = opts.unitId ? `user_id = ? AND unit_id = ? AND visibility = 'unit'` : 'user_id = ?';
  const params = opts.unitId ? [opts.userId, opts.unitId] : [opts.userId];
  const activities = (ctx.db.prepare(`SELECT * FROM activities WHERE ${where} AND deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date DESC`).all(...params, from, to) as Array<Record<string, unknown>>).map((r) => hydrate(r, 'activities')!);
  const awards = ctx.db.prepare(`SELECT name, date, status FROM awards WHERE ${where} AND deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date DESC`).all(...params, from, to) as Array<{ name: string; date: string | null; status: string }>;
  const trainings = ctx.db.prepare(`SELECT title, date, hours FROM trainings WHERE ${where} AND deleted_at IS NULL AND date >= ? AND date <= ? ORDER BY date DESC`).all(...params, from, to) as Array<{ title: string; date: string | null; hours: number | null }>;
  const cfg = narrativeConfig(track);
  const metricsConfig = ctx.runtime.metrics;
  // The narrative reads areas by name as the package does (groupByAreas): a Sgt's JEPES-named entries are FITREP ones.
  const onTrack = activities.map((a) => ({ ...a, eval_area: areaAmong(a.eval_area as string | null, cfg.areas) }));
  // Credit from the case histories in the same days; for a leader's view, only work shared with that unit.
  const casework = caseworkFor(ctx, opts.userId, { from, to, timezone: ctx.config.timezone }, opts.unitId ?? null);
  // The last quarter of the period counts as recent.
  const span = Date.parse(to) - Date.parse(from);
  const recentFrom = Number.isFinite(span) && span > 0 ? new Date(Date.parse(from) + span * 0.75).toISOString().slice(0, 10) : null;
  const n = opts.narrative || {};
  const narrative = composeNarrative(onTrack as never, {
    ...cfg, limit: n.chars ?? cfg.limit, periodLabel: label, metrics: metricsConfig, casework, recentFrom,
    seed: n.seed, density: n.density, exclude: n.exclude, pin: n.pin,
    // Appendix E's bullets, acronyms spelled out once: the form the order shows, unless the Marine chose otherwise.
    format: n.format ?? 'bullets', spellOut: n.spell ?? true,
  });
  const pkg = buildPackage(activities as never, { periodLabel: label, style: opts.style || (track === 'fitrep' ? 'fitrep' : 'jepes'), limitPerArea: opts.limit ?? 8, areas: areasFor(track), metrics: metricsConfig });
  const metrics = aggregateMetrics(activities as never, metricsConfig);
  const unit = opts.unitId ? (ctx.db.prepare('SELECT name, short_name FROM units WHERE id = ?').get(opts.unitId) as { name: string; short_name: string | null } | undefined) : undefined;
  return {
    from, to, label, track, person, unit,
    subject: `${person?.rank_abbr || ''} ${person?.first_name || ''} ${person?.last_name || ''}`.replace(/\s+/g, ' ').trim(),
    narrative, casework, recentFrom, pkg, metrics, metricsConfig, activities, awards, trainings,
    counts: { activities: activities.length, awards: awards.length, trainingHours: trainings.reduce((n, t) => n + (Number(t.hours) || 0), 0) },
    generatedAt: zonedDay(ctx.config.timezone),
  };
}
