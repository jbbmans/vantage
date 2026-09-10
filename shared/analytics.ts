/**
 * The analyst's view of a record: what an evaluator, a board, or the Marine themself would want to know before writing a
 * word. Pure functions over logged data; the server gathers the rows and the client and the PDF both render this shape.
 */
import { aggregateMetrics, formatDollars, formatNumber, toDate, dayKey, type MetricSource } from './metrics.ts';
import { movement, type Movement } from './delta.ts';
import { strength } from './bullets.ts';
import { DEFAULT_METRICS, isSummable, categoryNames, valueType, type MetricsConfig } from './constants.ts';
import { recordHealth, type HealthIssue } from './health.ts';

export interface AnalysisActivity extends MetricSource {
  id?: string; title?: string | null; date?: string | null; system?: string | null; organization?: string | null; status?: string | null;
  evidence_links?: Array<{ url?: string }> | null; notes?: string | null; created_at?: string;
}
export interface AnalysisGoal { title: string; status: string; current_value?: number | null; target_value?: number | null; unit_label?: string | null; period_end?: string | null; metric?: string | null; updated_at?: string; created_at?: string }
export interface AnalysisTraining { title: string; date?: string | null; hours?: number | null; type?: string | null; status?: string | null }
export interface AnalysisAward { name: string; date?: string | null; status: string; type?: string | null }
export interface AnalysisCounseling { date?: string | null; type?: string | null; acknowledged_at?: string | null }

export interface Kpi { key: string; label: string; value: number; prior: number; format: 'number' | 'money' | 'percent' | 'hours'; movement: Movement; note?: string }
export interface Share { name: string; entries: number; value: number; quantity: number; share: number; priorEntries: number; movement: Movement; outcomeRate: number }
export interface LedgerRow { id?: string; date: string | null; title: string; category: string | null; area: string | null; quantity: number | null; unit_label: string | null; value: number | null; value_type: string | null; result: string | null; system: string | null; organization: string | null; strength: number }

export interface Analysis {
  period: { from: string; to: string; label: string }; prior: { from: string; to: string; label: string };
  counts: { current: number; prior: number };
  kpis: Kpi[];
  runRate: { weeks: number; entriesPerWeek: number; priorEntriesPerWeek: number; valuePerWeek: number; priorValuePerWeek: number; elapsedFraction: number | null; projectedEntries: number | null; projectedValue: number | null };
  monthly: Array<{ month: string; label: string; entries: number; value: number; quantity: number; withOutcome: number }>;
  byCategory: Share[]; byArea: Share[];
  byValueType: Array<{ key: string; label: string; summable: boolean; amount: number; entries: number; share: number; prior: number; movement: Movement }>;
  bySystem: Array<{ name: string; entries: number; value: number; quantity: number }>;
  byOrganization: Array<{ name: string; entries: number; value: number; quantity: number }>;
  byUnitLabel: Array<{ unit: string; total: number; entries: number; prior: number; movement: Movement }>;
  concentration: { topByValue: LedgerRow[]; topByQuantity: LedgerRow[]; top3ValueShare: number; largestValueShare: number; hhi: number; entriesWithValue: number };
  consistency: { spanDays: number; activeDays: number; entriesPerActiveDay: number; longestGapDays: number; weeks: number; zeroWeeks: number; busiestWeek: { week: string; entries: number } | null; meanPerWeek: number; stdevPerWeek: number };
  coverage: { fields: Array<{ key: string; label: string; count: number; pct: number }>; emptyAreas: string[]; unusedCategories: string[]; strengthDistribution: Array<{ strength: number; count: number }>; avgStrength: number; planned: number };
  goals: { total: number; active: number; achieved: number; missed: number; paused: number; attainment: number; items: Array<{ title: string; status: string; current: number; target: number; pct: number; unit_label: string | null; period_end: string | null }> };
  career: {
    trainings: AnalysisTraining[]; trainingHours: number; hoursByType: Array<{ type: string; hours: number; count: number }>; priorTrainingHours: number;
    awards: AnalysisAward[]; awardsByStatus: Array<{ status: string; count: number }>; priorAwards: number;
    counselings: { count: number; lastDate: string | null; avgIntervalDays: number | null; unacknowledged: number; byType: Array<{ type: string; count: number }> };
  };
  quality: HealthIssue[];
  summary: string[];
  appendix: LedgerRow[];
}

const DAY = 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : 0);
const inRange = (d: string | null | undefined, from: string, to: string) => Boolean(d) && d! >= from && d! <= to;
const monthKey = (d: string) => d.slice(0, 7);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (key: string) => { const [y, m] = key.split('-').map(Number); return `${MONTHS[m - 1]} ${String(y).slice(-2)}`; };
const weekKey = (iso: string) => { const d = toDate(iso)!; const day = (d.getDay() + 6) % 7; const monday = new Date(d.getTime() - day * DAY); return dayKey(monday); };

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ey, em] = to.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m += 1; if (m > 12) { m = 1; y += 1; } if (out.length > 120) break; }
  return out;
}

const ledgerRow = (a: AnalysisActivity, cfg: MetricsConfig): LedgerRow => ({
  id: a.id, date: a.date || null, title: String(a.title || ''), category: a.category || null, area: a.eval_area || null, quantity: a.quantity == null ? null : Number(a.quantity), unit_label: a.unit_label || null,
  value: a.dollar_amount == null ? null : Number(a.dollar_amount), value_type: a.dollar_type ? (valueType(a.dollar_type, cfg)?.label || a.dollar_type) : null, result: a.result || null, system: a.system || null, organization: a.organization || null, strength: strength(a as never),
});

function shares(current: AnalysisActivity[], prior: AnalysisActivity[], keyOf: (a: AnalysisActivity) => string, names: readonly string[], cfg: MetricsConfig): Share[] {
  const cur = new Map<string, { entries: number; value: number; quantity: number; outcomes: number }>();
  const pre = new Map<string, number>();
  for (const a of current) { const k = keyOf(a); const b = cur.get(k) || { entries: 0, value: 0, quantity: 0, outcomes: 0 }; b.entries += 1; b.value += isSummable(a.dollar_type, cfg) ? Number(a.dollar_amount) || 0 : 0; b.quantity += Number(a.quantity) || 0; b.outcomes += a.result && String(a.result).trim() ? 1 : 0; cur.set(k, b); }
  for (const a of prior) { const k = keyOf(a); pre.set(k, (pre.get(k) || 0) + 1); }
  const keys = [...new Set([...names, ...cur.keys(), ...pre.keys()])];
  return keys.map((name) => { const b = cur.get(name) || { entries: 0, value: 0, quantity: 0, outcomes: 0 }; const p = pre.get(name) || 0; return { name, entries: b.entries, value: r2(b.value), quantity: b.quantity, share: pct(b.entries, current.length), priorEntries: p, movement: movement(b.entries, p), outcomeRate: pct(b.outcomes, b.entries) }; })
    .filter((s) => s.entries || s.priorEntries || names.includes(s.name)).sort((x, y) => y.entries - x.entries || y.value - x.value);
}

function groupBy(list: AnalysisActivity[], keyOf: (a: AnalysisActivity) => string | null | undefined, cfg: MetricsConfig) {
  const map = new Map<string, { name: string; entries: number; value: number; quantity: number }>();
  for (const a of list) { const k = (keyOf(a) || '').trim(); if (!k) continue; const b = map.get(k) || { name: k, entries: 0, value: 0, quantity: 0 }; b.entries += 1; b.value += isSummable(a.dollar_type, cfg) ? Number(a.dollar_amount) || 0 : 0; b.quantity += Number(a.quantity) || 0; map.set(k, b); }
  return [...map.values()].map((b) => ({ ...b, value: r2(b.value) })).sort((x, y) => y.entries - x.entries || y.value - x.value).slice(0, 12);
}

export interface AnalysisInput {
  activities: AnalysisActivity[];
  period: { from: string; to: string; label: string }; prior: { from: string; to: string; label: string };
  today: string; areas: readonly string[]; track: string; metrics?: MetricsConfig;
  goals?: AnalysisGoal[]; trainings?: AnalysisTraining[]; awards?: AnalysisAward[]; counselings?: AnalysisCounseling[];
  profile?: Record<string, unknown> | null;
}

export function buildAnalysis(input: AnalysisInput): Analysis {
  const cfg = input.metrics || DEFAULT_METRICS;
  const { period, prior, areas } = input;
  const all = input.activities.filter((a) => a.status !== 'planned');
  const current = all.filter((a) => inRange(a.date, period.from, period.to)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const previous = all.filter((a) => inRange(a.date, prior.from, prior.to));
  const planned = input.activities.filter((a) => a.status === 'planned' && inRange(a.date, period.from, period.to)).length;
  const m = aggregateMetrics(current, cfg);
  const pm = aggregateMetrics(previous, cfg);
  const trainings = (input.trainings || []).filter((t) => inRange(t.date, period.from, period.to));
  const priorTrainingHours = (input.trainings || []).filter((t) => inRange(t.date, prior.from, prior.to)).reduce((n, t) => n + (Number(t.hours) || 0), 0);
  const trainingHours = trainings.reduce((n, t) => n + (Number(t.hours) || 0), 0);
  const awards = (input.awards || []).filter((a) => inRange(a.date, period.from, period.to));
  const priorAwards = (input.awards || []).filter((a) => inRange(a.date, prior.from, prior.to)).length;
  const counselings = (input.counselings || []).filter((c) => inRange(c.date, period.from, period.to)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const goals = input.goals || [];

  const outcomeRate = pct(m.withOutcome, current.length);
  const priorOutcomeRate = pct(pm.withOutcome, previous.length);
  const label = cfg.currency_label;
  const kpis: Kpi[] = [
    { key: 'entries', label: 'Entries logged', value: current.length, prior: previous.length, format: 'number', movement: movement(current.length, previous.length) },
    { key: 'value', label: `Headline ${label.toLowerCase()}`, value: m.totalDollars, prior: pm.totalDollars, format: 'money', movement: movement(m.totalDollars, pm.totalDollars), note: `sums ${cfg.value_types.filter((t) => t.summable).map((t) => t.label).join(', ')}` },
    { key: 'reviewed', label: `${label} tracked separately`, value: m.reviewedDollars, prior: pm.reviewedDollars, format: 'money', movement: movement(m.reviewedDollars, pm.reviewedDollars), note: 'not in the headline' },
    { key: 'quantity', label: 'Actions counted', value: m.totalQuantity, prior: pm.totalQuantity, format: 'number', movement: movement(m.totalQuantity, pm.totalQuantity) },
    { key: 'outcome', label: 'Entries with an outcome', value: outcomeRate, prior: priorOutcomeRate, format: 'percent', movement: movement(outcomeRate, priorOutcomeRate) },
    { key: 'training', label: 'Training hours', value: trainingHours, prior: priorTrainingHours, format: 'hours', movement: movement(trainingHours, priorTrainingHours) },
    { key: 'awards', label: 'Awards and recognitions', value: awards.length, prior: priorAwards, format: 'number', movement: movement(awards.length, priorAwards) },
    { key: 'counselings', label: 'Counselings', value: counselings.length, prior: (input.counselings || []).filter((c) => inRange(c.date, prior.from, prior.to)).length, format: 'number', movement: movement(counselings.length, (input.counselings || []).filter((c) => inRange(c.date, prior.from, prior.to)).length) },
  ];

  // Run rate and pace
  const spanDays = Math.max(1, Math.round((toDate(period.to)!.getTime() - toDate(period.from)!.getTime()) / DAY) + 1);
  const weeks = Math.max(1, spanDays / 7);
  const priorWeeks = Math.max(1, (Math.round((toDate(prior.to)!.getTime() - toDate(prior.from)!.getTime()) / DAY) + 1) / 7);
  const todayT = toDate(input.today)!.getTime();
  const elapsed = todayT >= toDate(period.to)!.getTime() ? 1 : todayT <= toDate(period.from)!.getTime() ? 0 : (todayT - toDate(period.from)!.getTime()) / (toDate(period.to)!.getTime() - toDate(period.from)!.getTime());
  const elapsedFraction = spanDays > 45 && spanDays < 400 ? r2(elapsed) : null;
  const project = (v: number) => (elapsedFraction != null && elapsedFraction >= 0.1 && elapsedFraction < 1 ? Math.round(v / elapsedFraction) : null);
  const runRate = { weeks: r2(weeks), entriesPerWeek: r2(current.length / weeks), priorEntriesPerWeek: r2(previous.length / priorWeeks), valuePerWeek: r2(m.totalDollars / weeks), priorValuePerWeek: r2(pm.totalDollars / priorWeeks), elapsedFraction, projectedEntries: project(current.length), projectedValue: project(m.totalDollars) };

  // Monthly series
  const monthly = monthsBetween(period.from, period.to).map((month) => {
    const rows = current.filter((a) => a.date && monthKey(a.date) === month);
    return { month, label: monthLabel(month), entries: rows.length, value: r2(rows.reduce((n, a) => n + (isSummable(a.dollar_type, cfg) ? Number(a.dollar_amount) || 0 : 0), 0)), quantity: rows.reduce((n, a) => n + (Number(a.quantity) || 0), 0), withOutcome: rows.filter((a) => a.result && String(a.result).trim()).length };
  });

  // Composition
  const byCategory = shares(current, previous, (a) => a.category || 'Other', categoryNames(cfg), cfg);
  const byArea = shares(current, previous, (a) => a.eval_area || 'Unassigned', areas, cfg);
  const totalValueAll = Object.values(m.dollarsByType).reduce((n, v) => n + v, 0);
  const byValueType = cfg.value_types.map((t) => { const amount = r2(m.dollarsByType[t.key] || 0); const prior = r2(pm.dollarsByType[t.key] || 0); return { key: t.key, label: t.label, summable: t.summable, amount, entries: current.filter((a) => a.dollar_amount && (a.dollar_type || '') === t.key).length, share: pct(amount, totalValueAll), prior, movement: movement(amount, prior) }; })
    .concat(Object.keys(m.dollarsByType).filter((k) => !valueType(k, cfg)).map((k) => ({ key: k, label: `${k} (retired)`, summable: false, amount: r2(m.dollarsByType[k]), entries: current.filter((a) => a.dollar_type === k).length, share: pct(m.dollarsByType[k], totalValueAll), prior: r2(pm.dollarsByType[k] || 0), movement: movement(m.dollarsByType[k], pm.dollarsByType[k] || 0) })))
    .filter((t) => t.amount || t.prior || t.summable);
  const bySystem = groupBy(current, (a) => a.system, cfg);
  const byOrganization = groupBy(current, (a) => a.organization, cfg);
  const byUnitLabel = m.byUnit.map((u) => { const p = pm.byUnit.find((x) => x.unit === u.unit)?.total || 0; return { unit: u.unit, total: u.total, entries: u.count, prior: p, movement: movement(u.total, p) }; }).slice(0, 12);

  // Concentration
  const valued = current.filter((a) => isSummable(a.dollar_type, cfg) && Number(a.dollar_amount) > 0).sort((a, b) => Number(b.dollar_amount) - Number(a.dollar_amount));
  const top3 = valued.slice(0, 3).reduce((n, a) => n + Number(a.dollar_amount), 0);
  const hhi = m.totalDollars ? Math.round(valued.reduce((n, a) => n + Math.pow(Number(a.dollar_amount) / m.totalDollars, 2), 0) * 10000) : 0;
  const concentration = {
    topByValue: valued.slice(0, 5).map((a) => ledgerRow(a, cfg)),
    topByQuantity: [...current].filter((a) => Number(a.quantity) > 0).sort((a, b) => Number(b.quantity) - Number(a.quantity)).slice(0, 5).map((a) => ledgerRow(a, cfg)),
    top3ValueShare: pct(top3, m.totalDollars), largestValueShare: pct(valued[0] ? Number(valued[0].dollar_amount) : 0, m.totalDollars), hhi, entriesWithValue: valued.length,
  };

  // Consistency
  const days = [...new Set(current.map((a) => a.date).filter((d): d is string => Boolean(d)))].sort();
  let longestGap = 0;
  const gapStart = toDate(period.from)!.getTime(); const gapEnd = Math.min(toDate(period.to)!.getTime(), todayT);
  const points = [gapStart, ...days.map((d) => toDate(d)!.getTime()), gapEnd];
  for (let i = 1; i < points.length; i++) longestGap = Math.max(longestGap, Math.round((points[i] - points[i - 1]) / DAY));
  const perWeek = new Map<string, number>();
  for (const a of current) if (a.date) { const k = weekKey(a.date); perWeek.set(k, (perWeek.get(k) || 0) + 1); }
  const weekCount = Math.max(1, Math.ceil(Math.min(spanDays, Math.max(1, Math.round((gapEnd - gapStart) / DAY) + 1)) / 7));
  const counts = [...perWeek.values()];
  const meanPerWeek = current.length / weekCount;
  const variance = (counts.reduce((n, c) => n + Math.pow(c - meanPerWeek, 2), 0) + (weekCount - counts.length) * Math.pow(meanPerWeek, 2)) / weekCount;
  const busiest = [...perWeek.entries()].sort((a, b) => b[1] - a[1])[0];
  const consistency = { spanDays, activeDays: days.length, entriesPerActiveDay: days.length ? r2(current.length / days.length) : 0, longestGapDays: longestGap, weeks: weekCount, zeroWeeks: Math.max(0, weekCount - perWeek.size), busiestWeek: busiest ? { week: busiest[0], entries: busiest[1] } : null, meanPerWeek: r2(meanPerWeek), stdevPerWeek: r2(Math.sqrt(Math.max(0, variance))) };

  // Coverage and quality
  const field = (key: string, label: string, test: (a: AnalysisActivity) => boolean) => { const count = current.filter(test).length; return { key, label, count, pct: pct(count, current.length) }; };
  const strengths = current.map((a) => strength(a as never));
  const coverage = {
    fields: [
      field('outcome', 'States an outcome', (a) => Boolean(a.result && String(a.result).trim())),
      field('quantity', 'Carries a quantity', (a) => Number(a.quantity) > 0),
      field('value', `Carries ${label.toLowerCase()}`, (a) => Number(a.dollar_amount) > 0),
      field('area', 'Tagged to an area', (a) => Boolean(a.eval_area && a.eval_area !== 'Unassigned')),
      field('system', 'Names the system', (a) => Boolean(a.system && String(a.system).trim())),
      field('organization', 'Names the organization', (a) => Boolean(a.organization && String(a.organization).trim())),
      field('evidence', 'Links evidence', (a) => Array.isArray(a.evidence_links) && a.evidence_links.some((l) => l?.url)),
    ],
    emptyAreas: areas.filter((ar) => !current.some((a) => a.eval_area === ar)),
    unusedCategories: categoryNames(cfg).filter((c) => !current.some((a) => (a.category || 'Other') === c)),
    strengthDistribution: [1, 2, 3, 4, 5].map((s) => ({ strength: s, count: strengths.filter((x) => x === s).length })),
    avgStrength: strengths.length ? r2(strengths.reduce((n, s) => n + s, 0) / strengths.length) : 0,
    planned,
  };
  const quality = recordHealth({ activities: current as never, goals: goals as never, profile: input.profile || null, track: input.track, now: toDate(input.today) || new Date() });

  // Goals
  const goalItems = goals.map((g) => { const target = Number(g.target_value) || 0; const cur = Number(g.current_value) || 0; return { title: g.title, status: g.status, current: r2(cur), target, pct: target ? Math.min(100, Math.round((cur / target) * 100)) : 0, unit_label: g.unit_label || null, period_end: g.period_end || null }; });
  const by = (s: string) => goals.filter((g) => g.status === s).length;
  const closed = by('achieved') + by('missed');
  const goalSummary = { total: goals.length, active: by('active'), achieved: by('achieved'), missed: by('missed'), paused: by('paused'), attainment: closed ? Math.round((by('achieved') / closed) * 100) : 0, items: goalItems };

  // Career
  const hoursByTypeMap = new Map<string, { hours: number; count: number }>();
  for (const t of trainings) { const k = t.type || 'training'; const b = hoursByTypeMap.get(k) || { hours: 0, count: 0 }; b.hours += Number(t.hours) || 0; b.count += 1; hoursByTypeMap.set(k, b); }
  const awardsByStatusMap = new Map<string, number>();
  for (const a of awards) awardsByStatusMap.set(a.status, (awardsByStatusMap.get(a.status) || 0) + 1);
  const cDates = counselings.map((c) => toDate(c.date)?.getTime()).filter((t): t is number => Boolean(t));
  const intervals = cDates.slice(1).map((t, i) => (t - cDates[i]) / DAY);
  const cTypes = new Map<string, number>();
  for (const c of counselings) cTypes.set(c.type || 'other', (cTypes.get(c.type || 'other') || 0) + 1);
  const career = {
    trainings, trainingHours: r2(trainingHours), hoursByType: [...hoursByTypeMap.entries()].map(([type, b]) => ({ type, hours: r2(b.hours), count: b.count })).sort((a, b) => b.hours - a.hours), priorTrainingHours: r2(priorTrainingHours),
    awards, awardsByStatus: [...awardsByStatusMap.entries()].map(([status, count]) => ({ status, count })), priorAwards,
    counselings: { count: counselings.length, lastDate: counselings.at(-1)?.date || null, avgIntervalDays: intervals.length ? Math.round(intervals.reduce((n, x) => n + x, 0) / intervals.length) : null, unacknowledged: counselings.filter((c) => !c.acknowledged_at).length, byType: [...cTypes.entries()].map(([type, count]) => ({ type, count })) },
  };

  // Executive summary
  const summary: string[] = [];
  const dir = (mv: Movement, noun: string) => (mv.isNew ? `${noun} started from zero` : mv.pct == null ? `${noun} unchanged` : `${noun} ${mv.direction === 'up' ? 'up' : mv.direction === 'down' ? 'down' : 'flat'} ${mv.pct === 0 ? '' : `${Math.abs(mv.pct)}% `}on the prior period`);
  summary.push(`${formatNumber(current.length)} entries in ${period.label}${previous.length ? ` against ${formatNumber(previous.length)} in the prior period (${dir(movement(current.length, previous.length), 'volume')})` : ''}, averaging ${runRate.entriesPerWeek} per week.`);
  if (m.totalDollars) summary.push(`Headline ${label.toLowerCase()} of ${formatDollars(m.totalDollars)}${m.reviewedDollars ? ` with a further ${formatDollars(m.reviewedDollars)} tracked separately` : ''}; ${dir(kpis[1].movement, 'value')}.${concentration.top3ValueShare >= 60 ? ` The top three entries carry ${concentration.top3ValueShare}% of that value, so the headline rests on a few actions.` : ''}`);
  const lead = byArea[0];
  if (lead && lead.entries) summary.push(`${lead.name} leads with ${lead.share}% of entries${coverage.emptyAreas.length ? `; nothing yet under ${coverage.emptyAreas.join(' or ')}` : '; every area has evidence'}.`);
  summary.push(`${outcomeRate}% of entries state an outcome and the average entry scores ${coverage.avgStrength} of 5 on completeness${quality.length ? `; ${quality.slice(0, 2).map((q) => `${q.count} ${q.label}`).join(', ')}` : ''}.`);
  if (consistency.longestGapDays >= 21 && current.length) summary.push(`Longest gap without an entry: ${consistency.longestGapDays} days, with ${consistency.zeroWeeks} of ${consistency.weeks} weeks empty.`);
  if (runRate.projectedEntries != null) summary.push(`At the current pace (${Math.round((runRate.elapsedFraction || 0) * 100)}% of the period elapsed) the period closes near ${formatNumber(runRate.projectedEntries)} entries${runRate.projectedValue ? ` and ${formatDollars(runRate.projectedValue)}` : ''}.`);
  if (trainingHours || awards.length) summary.push(`${formatNumber(trainingHours)} training hours and ${awards.length} award${awards.length === 1 ? '' : 's'} in the period${goals.length ? `; ${goalSummary.achieved} of ${goals.length} goals achieved` : ''}.`);

  return {
    period, prior, counts: { current: current.length, prior: previous.length }, kpis, runRate, monthly, byCategory, byArea, byValueType, bySystem, byOrganization, byUnitLabel,
    concentration, consistency, coverage, goals: goalSummary, career, quality, summary,
    appendix: current.map((a) => ledgerRow(a, cfg)),
  };
}
