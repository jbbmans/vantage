import type { AppContext, SessionUser } from '../context.ts';
import { PERMISSIONS, can, subjectUnits, type Scope } from '../authz/scope.ts';
import { zonedDay, zonedDayBounds } from '../lib/clock.ts';
import { zoneOf } from '../lib/zone.ts';
import { audit } from './audit.ts';
import { buildAnalysisReport, type AnalysisReport } from './analytics.ts';
import { subjectWhere } from './reports.ts';
import { periodClause } from './timeframes.ts';
import { personnelAccess } from './personnelRecords.ts';
import { words } from './reportCenter.ts';
import { anchorDay } from '../../shared/timeframe.ts';
import { countedPoints } from '../../shared/dutyReview.ts';
import { REPORT_FILE_FORMATS, type ReportFileFormat } from '../../shared/reportCatalog.ts';
import { visualOf, type Visual, type VisualInput } from '../../shared/unitAnalytics.ts';
import type { MarineStatistics, StatisticsFact, StatisticsSection } from '../../shared/marineStatistics.ts';

/**
 * A Marine's statistics (ADR-0051): one read of their record over a range, for the Statistics tab and the Statistics
 * report alike.
 *
 * Whom it is about is decided before anything is read. Oneself, always, with every record one keeps. Another Marine only
 * where the reader opens their record (subjectUnits: opening member records in one of their units, from a position above
 * theirs), with what they shared with every unit of that Unit Instance where the reader does; a reader outside their
 * chain, a Unit Instance role and Vantage staff are refused, and so is a unit of another Unit Instance.
 *
 * The figures are the pages' own. Entries, outcomes, areas, coverage, training, awards and counseling are the Analysis
 * (buildAnalysisReport, read with the same arguments the Analysis page sends); duty is counted as the Duty report counts
 * it. The activity summary counts what the Marine added in the range, never a list of it, and nothing about pages opened
 * or time spent. About another Marine nothing is scored, projected or compared: their own history, as their record holds it.
 */

export interface StatisticsAsk { user_id?: string | null; unit_id?: string | null; period: string; from?: string | null; to?: string | null }

export interface StatisticsTarget {
  userId: string;
  self: boolean;
  /** About another Marine, the unit that picks the Unit Instance, and every unit of it read, that one first. */
  unitId: string | null;
  unitIds: string[];
}

/** Whom the statistics are about, or a refusal. Nothing is read about the Marine before it answers. */
export function statisticsTarget(ctx: AppContext, user: SessionUser, scope: Scope, ask: Pick<StatisticsAsk, 'user_id' | 'unit_id'>): StatisticsTarget {
  const other = ask.user_id && ask.user_id !== user.id ? ask.user_id : null;
  if (!other) return { userId: user.id, self: true, unitId: null, unitIds: [] };
  const { unitId, unitIds } = subjectUnits(ctx, scope, other, ask.unit_id, 'You cannot see that Marine’s statistics.');
  return { userId: other, self: false, unitId, unitIds };
}

/** The files the Statistics report may leave as: about another Marine, a spreadsheet or data file needs exporting in every unit read. */
export function statisticsFiles(scope: Scope, t: StatisticsTarget): ReportFileFormat[] {
  if (t.self || t.unitIds.every((u) => can(scope, PERMISSIONS.EXPORT_DATA, u))) return [...REPORT_FILE_FORMATS];
  return ['pdf'];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const ALL_TIME_FROM = '1970-01-01';
/** The most months a series draws, the latest of them, as the Analysis draws its own. */
const MONTH_LIMIT = 121;

/** The range's months, the latest MONTH_LIMIT of them. All time starts at the first month anything was counted in. */
function monthsOf(from: string, to: string, firstDays: Array<string | null | undefined>): Array<{ key: string; label: string }> {
  const first = from > ALL_TIME_FROM ? from : firstDays.filter((d): d is string => Boolean(d)).sort()[0] ?? to;
  const index = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1;
  const end = index(to);
  const out: Array<{ key: string; label: string }> = [];
  for (let i = Math.max(index(first), end - (MONTH_LIMIT - 1)); i <= end; i += 1) {
    const key = `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
    out.push({ key, label: monthLabel(key) });
  }
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const add = (m: Map<string, number>, key: string, by: number) => m.set(key, (m.get(key) || 0) + by);

// Duty, as the Duty report counts it

interface DutyRow { duty_type_id: string; date: string; end_date: string; hours: number | null; approval_status: string; approved_points: number | null }

interface DutyFigures {
  count: number; hours: number; approvedPoints: number; approved: number; pending: number; returned: number; rejected: number;
  byType: Array<{ id: string; name: string; count: number; hours: number }>;
  byMonth: Map<string, { count: number; hours: number }>;
  firstDay: string | null;
}

function dutyFigures(ctx: AppContext, t: StatisticsTarget, from: string, to: string): DutyFigures {
  // Duty is always a unit record: one's own reads all of it, another Marine's what is in the units read.
  const { where, params } = subjectWhere(t.userId, t.self ? [] : t.unitIds);
  const span = periodClause('duties', 't', from, to);
  const rows = ctx.db.prepare(`SELECT t.duty_type_id, t.date, t.end_date, t.hours, t.approval_status, t.approved_points FROM duties t
    WHERE ${where} AND t.deleted_at IS NULL AND ${span.sql}`).all(...params, ...span.params) as DutyRow[];
  const names = new Map((ctx.db.prepare('SELECT id, name FROM duty_types WHERE id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify([...new Set(rows.map((r) => r.duty_type_id))])) as Array<{ id: string; name: string }>).map((x) => [x.id, x.name]));
  const types = new Map<string, { id: string; name: string; count: number; hours: number }>();
  const byMonth = new Map<string, { count: number; hours: number }>();
  const f: DutyFigures = { count: 0, hours: 0, approvedPoints: 0, approved: 0, pending: 0, returned: 0, rejected: 0, byType: [], byMonth, firstDay: null };
  for (const r of rows) {
    const hours = Number(r.hours) || 0;
    f.count += 1; f.hours += hours; f.approvedPoints += countedPoints(r);
    if (r.approval_status === 'approved') f.approved += 1;
    else if (r.approval_status === 'pending') f.pending += 1;
    else if (r.approval_status === 'returned') f.returned += 1;
    else if (r.approval_status === 'rejected') f.rejected += 1;
    const type = types.get(r.duty_type_id) || { id: r.duty_type_id, name: names.get(r.duty_type_id) || 'A duty type', count: 0, hours: 0 };
    type.count += 1; type.hours += hours; types.set(r.duty_type_id, type);
    // A duty across a month's end counts in the month of its first day in the range, once.
    const day = anchorDay('duties', r, from);
    if (day) {
      const m = byMonth.get(day.slice(0, 7)) || { count: 0, hours: 0 };
      m.count += 1; m.hours += hours; byMonth.set(day.slice(0, 7), m);
      if (!f.firstDay || day < f.firstDay) f.firstDay = day;
    }
  }
  f.hours = r2(f.hours); f.approvedPoints = r2(f.approvedPoints);
  f.byType = [...types.values()].map((x) => ({ ...x, hours: r2(x.hours) })).sort((a, b) => b.count - a.count || b.hours - a.hours || a.name.localeCompare(b.name));
  return f;
}

// What the Marine added in Vantage: counts, never the records

const ACTIVITY_KINDS = [
  { key: 'entries', label: 'Entries added', noun: 'entry' },
  { key: 'duty', label: 'Duty recorded', noun: 'duty' },
  { key: 'training', label: 'Training added', noun: 'course' },
  { key: 'goals', label: 'Goals set', noun: 'goal' },
  { key: 'acknowledged', label: 'Counselings acknowledged', noun: 'counseling' },
] as const;
type ActivityKind = (typeof ACTIVITY_KINDS)[number]['key'];

interface ActivityFigures {
  totals: Record<ActivityKind, number>;
  byMonth: Map<string, number>;
  firstDay: string | null;
  lastEntry: string | null;
  lastSignIn: string | null;
  /** The reader may see when the Marine last signed in: themselves, or a leader who manages them. */
  signInShown: boolean;
}

function activityFigures(ctx: AppContext, user: SessionUser, scope: Scope, t: StatisticsTarget, from: string, to: string): ActivityFigures {
  const tz = ctx.config.timezone;
  // When each record was added, on the instance's clock: the range's days, from the first moment of the first to the
  // last moment of the last.
  const [start, end] = zonedDayBounds(tz, from, to);
  const { where, params } = subjectWhere(t.userId, t.self ? [] : t.unitIds);
  const added = (table: string, extra = '', column = 'created_at') =>
    (ctx.db.prepare(`SELECT ${column} AS at FROM ${table} WHERE ${where} AND deleted_at IS NULL ${extra} AND ${column} >= ? AND ${column} <= ?`)
      .all(...params, start, end) as Array<{ at: string }>).map((r) => r.at);
  const reads: Record<ActivityKind, string[]> = {
    entries: added('activities'),
    // Duty the Marine recorded for themselves; duty a leader recorded for them is the leader's doing.
    duty: added('duties', 'AND (recorded_by IS NULL OR recorded_by = user_id)'),
    training: added('trainings'),
    goals: added('goals'),
    // A counseling a leader wrote and finalized, acknowledged by the Marine in the range.
    acknowledged: added('counselings', `AND stage = 'final' AND counselor_id IS NOT NULL AND counselor_id <> user_id`, 'acknowledged_at'),
  };
  const totals = Object.fromEntries(ACTIVITY_KINDS.map((k) => [k.key, reads[k.key].length])) as Record<ActivityKind, number>;
  const byMonth = new Map<string, number>();
  let firstDay: string | null = null;
  for (const list of Object.values(reads)) {
    for (const at of list) {
      const day = zonedDay(tz, 0, new Date(at));
      add(byMonth, day.slice(0, 7), 1);
      if (!firstDay || day < firstDay) firstDay = day;
    }
  }
  const last = ctx.db.prepare(`SELECT MAX(created_at) AS at FROM activities WHERE ${where} AND deleted_at IS NULL`).get(...params) as { at: string | null };
  // The last sign-in only to a leader who manages the Marine, as the member page decides (ADR-0040); one's own is this
  // session, and Settings, Your activity lists one's sign-ins.
  // Nothing about pages opened or time spent is read, for anybody.
  const signInShown = !t.self && personnelAccess(ctx, scope, user.id, t.userId).manageIn.length > 0;
  const signIn = signInShown ? (ctx.db.prepare('SELECT last_login_at FROM users WHERE id = ?').get(t.userId) as { last_login_at: string | null } | undefined)?.last_login_at ?? null : null;
  return { totals, byMonth, firstDay, lastEntry: last?.at ?? null, lastSignIn: signIn, signInShown };
}

// The sections

const kpis = (id: string, question: string, noun: string, tiles: Array<{ key: string; label: string; value: number; count?: number; format?: VisualInput['format']; hint?: string }>, note?: string): Visual =>
  visualOf({
    id, question, kind: 'kpis', format: 'number', noun, ...(note ? { note } : {}),
    buckets: tiles.map((x) => ({ key: x.key, label: x.label, ...(x.format ? { format: x.format } : {}), ...(x.hint ? { hint: x.hint } : {}), values: [x.value], counts: [x.count ?? x.value] })),
  });

function sectionsOf(a: AnalysisReport, duty: DutyFigures, act: ActivityFigures, t: StatisticsTarget): StatisticsSection[] {
  const cfg = a.metricsConfig;
  const money = cfg.currency_label;
  const kpi = (key: string) => a.kpis.find((k) => k.key === key);
  const field = (key: string) => a.coverage.fields.find((f) => f.key === key);
  const firstOf = (list: Array<string | null | undefined>) => list.filter((d): d is string => Boolean(d)).sort()[0] ?? null;
  const trainingDay = (x: (typeof a.career.trainings)[number]) => anchorDay('trainings', x, a.period.from);
  const months = monthsOf(a.period.from, a.period.to, [
    firstOf(a.appendix.map((r) => (r.month ? `${r.month}-01` : null))), duty.firstDay, firstOf(a.career.trainings.map(trainingDay)), act.firstDay,
  ]);
  const monthly = new Map(a.monthly.map((m) => [m.month, m]));
  const valued = new Map<string, number>();
  for (const r of a.appendix) if (r.month && r.summable && r.value) add(valued, r.month, 1);
  const area = a.track === 'fitrep' ? 'FITREP area' : 'JEPES area';
  const entries = a.counts.current;
  const withOutcome = field('outcome')?.count ?? 0;

  const entrySection: StatisticsSection = {
    id: 'entries', title: 'Entries and outcomes',
    lede: 'Each entry dated in the range, once, counted as the Analysis counts it. Planned entries count once they are done.',
    visuals: [
      kpis('entries_now', 'What did the record hold in the range?', 'entry', [
        { key: 'entries', label: 'Entries in the range', value: entries },
        { key: 'value', label: `Headline ${money.toLowerCase()}`, value: kpi('value')?.value ?? 0, count: a.appendix.filter((r) => r.summable && r.value).length, format: 'money', hint: kpi('value')?.note ? `Sums ${kpi('value')!.note!.replace(/^sums /, '')}` : undefined },
        { key: 'quantity', label: 'Actions counted', value: kpi('quantity')?.value ?? 0, count: a.appendix.filter((r) => Number(r.quantity) > 0).length },
        { key: 'planned', label: 'Planned, not yet counted', value: a.coverage.planned, hint: 'Dated in the range and not yet done' },
      ]),
      visualOf({
        id: 'entries_outcome', question: 'How many entries state an outcome?', kind: 'rate', format: 'number', noun: 'entry', axis: 'Entries',
        buckets: [{ key: 'with', label: 'State an outcome', values: [withOutcome] }, { key: 'without', label: 'State none', values: [entries - withOutcome] }].map((b) => ({ ...b, counts: b.values })),
      }),
      visualOf({
        id: 'entries_months', question: 'How many entries each month?', kind: 'columns', format: 'number', noun: 'entry',
        note: 'An entry across a month’s end counts in the month of its first day in the range.',
        buckets: months.map((m) => { const n = monthly.get(m.key)?.entries ?? 0; return { key: m.key, label: m.label, values: [n], counts: [n] }; }),
      }),
      visualOf({
        id: 'entries_value_months', question: `How much was logged in ${money.toLowerCase()} each month?`, kind: 'columns', format: 'money', noun: 'entry',
        note: `The headline ${money.toLowerCase()}: the value types it sums, in the month each entry counts in.`,
        buckets: months.map((m) => ({ key: m.key, label: m.label, values: [monthly.get(m.key)?.value ?? 0], counts: [valued.get(m.key) ?? 0] })),
      }),
      visualOf({
        id: 'entries_area', question: `Which ${area}s does the work cover?`, kind: 'bars', format: 'number', noun: 'entry', axis: area,
        note: `Every ${area} is listed, so one with nothing in it shows at zero.`,
        buckets: a.byArea.map((x) => ({ key: x.name, label: x.name, hint: x.entries ? `${x.share}% of entries · ${x.outcomeRate}% with an outcome` : undefined, values: [x.entries], counts: [x.entries] })),
      }),
      visualOf({
        id: 'entries_category', question: 'What kind of work was it?', kind: 'bars', format: 'number', noun: 'entry', axis: 'Category',
        buckets: a.byCategory.filter((x) => x.entries).map((x) => ({ key: x.name, label: x.name, hint: `${x.share}% of entries`, values: [x.entries], counts: [x.entries] })),
      }),
      visualOf({
        id: 'entries_coverage', question: 'What do the entries carry?', kind: 'bars', format: 'number', noun: 'entry', axis: 'Each entry',
        note: `Of the ${entries} ${entries === 1 ? 'entry' : 'entries'} in the range, how many carry each part.`,
        buckets: a.coverage.fields.map((x) => ({ key: x.key, label: x.label, hint: entries ? `${x.pct}% of entries` : undefined, values: [x.count], counts: [x.count] })),
      }),
    ],
    facts: [],
    notes: [],
  };

  const dutySection: StatisticsSection = {
    id: 'duty', title: 'Duty',
    lede: `Duty stood on any day of the range, counted as the Duty report counts it${t.self ? '' : ', in the units read'}. Only approved duty counts toward points, at its approved points.`,
    visuals: [
      kpis('duty_now', 'How much duty, and how much of it counts?', 'duty', [
        { key: 'count', label: 'Duty in the range', value: duty.count },
        { key: 'hours', label: 'Hours stood', value: duty.hours, count: duty.count, format: 'hours' },
        { key: 'approved_points', label: 'Approved points', value: duty.approvedPoints, count: duty.approved, hint: 'Approved duty, at its approved points' },
        { key: 'pending', label: 'Awaiting review', value: duty.pending },
        { key: 'returned', label: 'Returned or rejected', value: duty.returned + duty.rejected },
      ]),
      visualOf({
        id: 'duty_rate', question: 'How much of the duty is approved?', kind: 'rate', format: 'number', noun: 'duty', axis: 'Duty',
        buckets: [{ key: 'approved', label: 'Approved', values: [duty.approved] }, { key: 'not_approved', label: 'Awaiting review, returned or rejected', values: [duty.count - duty.approved] }].map((b) => ({ ...b, counts: b.values })),
      }),
      visualOf({
        id: 'duty_months', question: 'How many hours of duty each month?', kind: 'columns', format: 'hours', noun: 'duty',
        note: 'A duty across a month’s end counts in the month of its first day in the range.',
        buckets: months.map((m) => { const x = duty.byMonth.get(m.key); return { key: m.key, label: m.label, values: [x?.hours ?? 0], counts: [x?.count ?? 0] }; }),
      }),
      visualOf({
        id: 'duty_type', question: 'What duty was stood?', kind: 'bars', format: 'number', noun: 'duty', axis: 'Duty type',
        buckets: duty.byType.map((x) => ({ key: x.id, label: x.name, hint: `${x.hours} h`, values: [x.count], counts: [x.count] })),
      }),
    ],
    facts: [],
    notes: [],
  };

  const c = a.career;
  const byTrainingMonth = new Map<string, { hours: number; count: number }>();
  for (const x of c.trainings) {
    const day = trainingDay(x);
    if (!day) continue;
    const m = byTrainingMonth.get(day.slice(0, 7)) || { hours: 0, count: 0 };
    m.hours += Number(x.hours) || 0; m.count += 1; byTrainingMonth.set(day.slice(0, 7), m);
  }
  const trainingSection: StatisticsSection = {
    id: 'training', title: 'Training and awards',
    lede: 'Courses on any day of the range and awards dated in it, as the Analysis counts them.',
    visuals: [
      kpis('training_now', 'How much training, and what recognition?', 'course', [
        { key: 'courses', label: 'Courses', value: c.trainings.length },
        { key: 'hours', label: 'Training hours', value: c.trainingHours, count: c.trainings.length, format: 'hours' },
        { key: 'awards', label: 'Awards and recognitions', value: c.awards.length, hint: 'Dated in the range, whatever their status' },
      ]),
      visualOf({
        id: 'training_months', question: 'How many training hours each month?', kind: 'columns', format: 'hours', noun: 'course',
        note: 'A course across a month’s end counts in the month of its first day in the range.',
        buckets: months.map((m) => { const x = byTrainingMonth.get(m.key); return { key: m.key, label: m.label, values: [r2(x?.hours ?? 0)], counts: [x?.count ?? 0] }; }),
      }),
      visualOf({
        id: 'training_type', question: 'What kinds of training?', kind: 'bars', format: 'hours', noun: 'course', axis: 'Type',
        buckets: c.hoursByType.map((x) => ({ key: x.type, label: words(x.type) || 'Training', hint: `${x.count} ${x.count === 1 ? 'course' : 'courses'}`, values: [x.hours], counts: [x.count] })),
      }),
    ],
    facts: [],
    notes: [],
  };

  const k = c.counselings;
  const counselingSection: StatisticsSection = {
    id: 'counseling', title: 'Counseling',
    lede: 'Final counselings dated in the range, as the Analysis counts them. What was said stays on each counseling.',
    visuals: [
      kpis('counseling_now', 'How often was the Marine counseled?', 'counseling', [
        { key: 'count', label: 'Counselings', value: k.count },
        { key: 'unacknowledged', label: 'Not yet acknowledged', value: k.unacknowledged },
        ...(k.avgIntervalDays == null ? [] : [{ key: 'interval', label: 'Days between, on average', value: k.avgIntervalDays, count: Math.max(0, k.count - 1), format: 'days' as const }]),
      ]),
      visualOf({
        id: 'counseling_type', question: 'What kinds of counseling?', kind: 'bars', format: 'number', noun: 'counseling', axis: 'Type',
        buckets: k.byType.map((x) => ({ key: x.type, label: words(x.type) || 'Other', values: [x.count], counts: [x.count] })).sort((x, y) => y.values[0] - x.values[0]),
      }),
    ],
    facts: [{ key: 'last_counseling', label: 'Last counseling', kind: 'day', value: k.lastDate }],
    notes: [],
  };

  const facts: StatisticsFact[] = [{ key: 'last_entry', label: 'Last entry added', kind: 'instant', value: act.lastEntry }];
  if (act.signInShown) facts.push({ key: 'last_sign_in', label: 'Last signed in', kind: 'instant', value: act.lastSignIn });
  const activitySection: StatisticsSection = {
    id: 'activity', title: 'Activity in Vantage',
    lede: `What ${t.self ? 'you' : 'the Marine'} added in the range, whatever day each is dated: counts, not a list.${t.self ? '' : ' From what they shared with the units read.'}`,
    visuals: [
      kpis('activity_now', `What did ${t.self ? 'you' : 'they'} add in the range?`, 'record', ACTIVITY_KINDS.map((x) => ({ key: x.key, label: x.label, value: act.totals[x.key] }))),
      visualOf({
        id: 'activity_months', question: 'How much was added each month?', kind: 'columns', format: 'number', noun: 'record',
        note: 'Entries, duty, training and goals added, and counselings acknowledged, in the month each happened.',
        buckets: months.map((m) => { const n = act.byMonth.get(m.key) ?? 0; return { key: m.key, label: m.label, values: [n], counts: [n] }; }),
      }),
    ],
    facts,
    notes: [t.self
      ? 'Every sign-in, every record you opened and everything else you did is under Settings, Your activity.'
      : 'Nothing here says which pages they opened or how long they spent in Vantage.'],
  };

  return [entrySection, dutySection, trainingSection, counselingSection, activitySection];
}

/**
 * The statistics of the Marine a target names, over the range asked for, with nothing audited: the tab audits its read
 * (marineStatistics) and the Statistics report its own (runReport, exportReport).
 */
export function statisticsProfile(ctx: AppContext, user: SessionUser, scope: Scope, t: StatisticsTarget, range: Pick<StatisticsAsk, 'period' | 'from' | 'to'>): MarineStatistics {
  // The Analysis as its page reads it: the same Marine, the same units, the same period, so its figures are the page's.
  const a = buildAnalysisReport(ctx, { userId: t.userId, unitId: t.self ? null : t.unitId, unitIds: t.self ? undefined : t.unitIds, period: range.period, from: range.from, to: range.to });
  // Every other read takes the same days the Analysis resolved (ADR-0038).
  const { from, to } = a.period;
  const duty = dutyFigures(ctx, t, from, to);
  const act = activityFigures(ctx, user, scope, t, from, to);
  const units = a.units.map((u) => ({ id: u.id, name: u.name, short_name: u.short_name }));
  const notes = t.self
    ? ['Drawn from your own records, private ones included. Nobody else’s figures are read or compared.']
    : [
      `Drawn from what the Marine shared with ${units.map((u) => u.short_name || u.name).join(', ') || 'the unit'}. Private entries are never included.`,
      'Their own history only: nobody else’s figures are read or compared, and nothing is scored or projected.',
    ];
  return {
    user_id: t.userId, subject: a.subject, self: t.self, track: a.track,
    period: { from, to, label: a.label }, as_of: zonedDay(zoneOf(ctx, user)),
    unit_id: t.self ? null : t.unitId, units,
    sections: sectionsOf(a, duty, act, t),
    notes: [...notes, 'An entry, a course or a duty that runs across the range’s edge counts in it, once.'],
    privacy_act: ctx.config.privacyActStatement,
    files: statisticsFiles(scope, t),
  };
}

/** The Statistics tab's read: decided, read, and, about another Marine, audited once for each unit read. */
export function marineStatistics(ctx: AppContext, user: SessionUser, scope: Scope, ask: StatisticsAsk, ip?: string | null): MarineStatistics {
  const t = statisticsTarget(ctx, user, scope, ask);
  const stats = statisticsProfile(ctx, user, scope, t, ask);
  if (!t.self) {
    // Each unit read keeps the read in its own access log, as a report about the Marine does.
    for (const unit of t.unitIds) {
      audit(ctx, { actor_id: user.id, action: 'view_statistics', entity: 'user', entity_id: t.userId, subject_id: t.userId, unit_id: unit, detail: `${stats.period.from}..${stats.period.to}`, ip });
    }
  }
  return stats;
}
