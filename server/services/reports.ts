import type { AppContext } from '../context.ts';
import { composeNarrative } from '../../shared/narrative.ts';
import { buildPackage, type BulletStyle } from '../../shared/bullets.ts';
import { aggregateMetrics, rangeForPeriod, type PeriodKey } from '../../shared/metrics.ts';
import { rangeLabel } from '../../shared/dateRange.ts';
import { narrativeConfig, areasFor, areaAmong, trackForGrade, type Track } from '../../shared/evaluation.ts';
import { periodClause } from './timeframes.ts';
import { isoDay, zonedDay, zonedNow } from '../lib/clock.ts';
import { caseworkFor } from './record.ts';
import type { Density, Format } from '../../shared/writer/realize.ts';
import { worksheetBlocks } from '../../shared/writer/worksheet.ts';

export interface ReportScope { userId: string; unitId?: string | null }

/** A unit a report about another Marine was drawn from. */
export interface ReportUnit { id: string; name: string; short_name: string | null }

/**
 * Whose rows a report reads: every row of one's own, private ones included; of another Marine, only what they shared
 * with the units read (subjectUnits), never a private entry. `unitIds` is empty for one's own.
 */
export function subjectWhere(userId: string, unitIds: readonly string[] | null | undefined): { where: string; params: unknown[] } {
  return unitIds?.length
    ? { where: `user_id = ? AND unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit'`, params: [userId, JSON.stringify(unitIds)] }
    : { where: 'user_id = ?', params: [userId] };
}

/** The units read, by name, in the order given; one's own report reads none. */
export function reportUnits(ctx: AppContext, unitIds: readonly string[] | null | undefined): ReportUnit[] {
  if (!unitIds?.length) return [];
  const rows = ctx.db.prepare('SELECT id, name, short_name FROM units WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(unitIds)) as ReportUnit[];
  const byId = new Map(rows.map((u) => [u.id, u]));
  return unitIds.map((id) => byId.get(id)).filter((u): u is ReportUnit => Boolean(u));
}

/**
 * The days a request covers, once checkRange has passed them (ADR-0038): two days given win over the period, as a link
 * that carries them means; otherwise the preset's days on the given clock.
 */
export function periodBounds(period: string, from?: string | null, to?: string | null, timezone = 'UTC') {
  if (from && to) return { from, to, label: rangeLabel(from, to) };
  const range = rangeForPeriod(period as PeriodKey, zonedNow(timezone));
  return { from: isoDay(range.start), to: isoDay(range.end), label: range.label };
}

/** How the narrative is written: the wording seed, what is pinned or left out, compact or full, and its length. */
export interface NarrativeChoices { seed?: number; density?: Density | 'auto'; exclude?: string[]; pin?: string[]; chars?: number; format?: Format; spell?: boolean }

interface ReportPerson { first_name: string; last_name: string; mos: string | null; rank_abbr: string | null; rank_grade: string | null }
const personOf = (ctx: AppContext, userId: string) =>
  ctx.db.prepare('SELECT u.first_name, u.last_name, u.mos, r.abbr AS rank_abbr, r.grade AS rank_grade FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?').get(userId) as ReportPerson | undefined;

/** The evaluation a Marine is written for by their grade (trackForGrade): one indexed read, nothing else built. */
export const trackOf = (ctx: AppContext, userId: string): Track => trackForGrade(personOf(ctx, userId)?.rank_grade);

/**
 * The columns of an entry the report uses: what the narrative, the package, the worksheet and the measures read, and
 * the screen's narrative writer after them, with its id, its place and its timeframe. Notes, links and bookkeeping stay
 * on the entry's own page, so a busy record's report does not carry them.
 */
export const REPORT_ACTIVITY_COLUMNS = [
  'id', 'unit_id', 'visibility', 'date', 'end_date', 'start_time', 'end_time', 'ongoing', 'title', 'category', 'eval_area',
  'quantity', 'unit_label', 'dollar_amount', 'dollar_type', 'result', 'organization', 'system', 'status',
] as const;

export function buildReport(ctx: AppContext, opts: { userId: string; unitId?: string | null; unitIds?: string[]; period: string; from?: string | null; to?: string | null; style?: BulletStyle; limit?: number; track?: Track | null; narrative?: NarrativeChoices }) {
  const { from, to, label } = periodBounds(opts.period, opts.from, opts.to, ctx.config.timezone);
  const person = personOf(ctx, opts.userId);
  const track: Track = opts.track || trackForGrade(person?.rank_grade);
  // Another Marine's report reads every unit of theirs it was drawn for (the anchor alone when none are named).
  const unitIds = opts.unitId ? (opts.unitIds?.length ? opts.unitIds : [opts.unitId]) : [];
  const { where, params } = subjectWhere(opts.userId, unitIds);
  // What ran in the period: anything with a day in it, so work begun before the period and still going counts (ADR-0018).
  const inPeriod = (table: 'activities' | 'awards' | 'trainings') => periodClause(table, table, from, to);
  const [a, w, t] = [inPeriod('activities'), inPeriod('awards'), inPeriod('trainings')];
  const activities = ctx.db.prepare(`SELECT ${REPORT_ACTIVITY_COLUMNS.join(', ')} FROM activities WHERE ${where} AND deleted_at IS NULL AND ${a.sql} ORDER BY date DESC`).all(...params, ...a.params) as Array<Record<string, unknown>>;
  const awards = ctx.db.prepare(`SELECT name, period_start, date, status FROM awards WHERE ${where} AND deleted_at IS NULL AND ${w.sql} ORDER BY date DESC`).all(...params, ...w.params) as Array<{ name: string; period_start: string | null; date: string | null; status: string }>;
  const trainings = ctx.db.prepare(`SELECT title, date, end_date, start_time, end_time, ongoing, hours, status FROM trainings WHERE ${where} AND deleted_at IS NULL AND ${t.sql} ORDER BY date DESC`).all(...params, ...t.params) as Array<{ title: string; date: string | null; end_date: string | null; start_time: string | null; end_time: string | null; ongoing: number; hours: number | null; status: string | null }>;
  const cfg = narrativeConfig(track);
  const metricsConfig = ctx.runtime.metrics;
  // The narrative reads areas by name as the package does (groupByAreas): a Sgt's JEPES-named entries are FITREP ones.
  const onTrack = activities.map((a) => ({ ...a, eval_area: areaAmong(a.eval_area as string | null, cfg.areas) }));
  // Credit from the case histories in the same days; for a leader's view, only work shared with the units read.
  const casework = caseworkFor(ctx, opts.userId, { from, to, timezone: ctx.config.timezone }, unitIds.length ? unitIds : null);
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
  // FITREP input goes on the MRO worksheet, whose PME and Other blocks sit beside Section C.
  const worksheet = track === 'fitrep' ? worksheetBlocks({ activities: onTrack as never, trainings, awards, metrics: metricsConfig }) : null;
  const pkg = buildPackage(activities as never, { style: opts.style || (track === 'fitrep' ? 'fitrep' : 'jepes'), track: track === 'fitrep' ? 'fitrep' : 'jepes', limitPerArea: opts.limit ?? 8, areas: areasFor(track), names: cfg.names, metrics: metricsConfig, recentFrom });
  const metrics = aggregateMetrics(activities as never, metricsConfig);
  // The unit the report was built for, with its id: the studio keeps a leader's edit under the unit the server chose.
  // `units` names every unit it was drawn from, that one first.
  const units = reportUnits(ctx, unitIds);
  const unit = units[0];
  return {
    from, to, label, track, person, unit, units,
    subject: `${person?.rank_abbr || ''} ${person?.first_name || ''} ${person?.last_name || ''}`.replace(/\s+/g, ' ').trim(),
    narrative, casework, recentFrom, pkg, metrics, metricsConfig, activities, awards, trainings, worksheet,
    counts: { activities: activities.length, awards: awards.length, trainingHours: trainings.reduce((n, t) => n + (Number(t.hours) || 0), 0) },
    generatedAt: zonedDay(ctx.config.timezone),
  };
}
