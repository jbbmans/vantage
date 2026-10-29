import type { AppContext, SessionUser } from '../context.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { zonedDay } from '../lib/clock.ts';
import { zoneOf } from '../lib/zone.ts';
import { audit } from './audit.ts';
import { PERMISSIONS, can, detailUnitsFor, membersAcross, orgOfUnit, sameInstance, subtreeIds, unitTree, type Scope } from '../authz/scope.ts';
import { getUnit, primaryOrgOf } from './org.ts';
import { periodBounds } from './reports.ts';
import { periodClause } from './timeframes.ts';
import { buildAnalysisReport } from './analytics.ts';
import { unitDashboard } from './dashboard.ts';
import { teamWorkload } from './record.ts';
import { personnelRoster } from './personnelRecords.ts';
import { listDutyTypes, listTrainingRequirements } from './unitConfig.ts';
import { listScoringPolicies } from './dutyScoring.ts';
import { stageOf } from './cases.ts';
import { withGoalProgress } from './records.ts';
import { renderReportDocumentPdf } from '../lib/pdfReport.ts';
import { writeWorkbook, type SheetOut } from '../lib/workbook.ts';
import { rowsToCsv } from '../../shared/csv.ts';
import { isSummable, valueType } from '../../shared/constants.ts';
import { formatDTG } from '../../shared/metrics.ts';
import { PROCEDURES } from '../../shared/procedures.ts';
import { STAGE_LABEL, type Stage } from '../../shared/caseModel.ts';
import { SCORING_COMBINE, SCORING_CONDITIONS, SCORING_METHODS, policyOn, policyStatus } from '../../shared/dutyScoring.ts';
import {
  CASE_STATES, CUSTOM_DATASETS, DEFAULT_REPORT_MARKING, DUE_SOON_DAYS, PERSONNEL_STATUSES, REPORT_FILE_FORMATS, REPORT_FORMAT, REPORT_PARAM_KEYS,
  REPORT_ROW_LIMIT, REPORT_SPECS, REPORT_TYPES, TRAINING_STATUSES, allTables, primaryTable, reportFileName, reportQuerySchema, tableMatrix,
  type Cell, type ReportColumn, type ReportDocument, type ReportFigure, type ReportFileFormat, type ReportQuery, type ReportSection,
  type ReportSubject, type ReportTable, type ReportType,
} from '../../shared/reportCatalog.ts';

/**
 * The report center (Task 14, ADR-0020): one place every report is built, whoever it is about and whatever it is drawn
 * into. Each builder reads through the code the page it reports already uses (the analysis, the unit dashboard, the
 * workload, the personnel roster, the duty scoring versions) and answers a ReportDocument; the screen, the print page, the
 * PDF, the CSV, the workbook and the JSON are all drawn from that one document.
 *
 * Who it may be about is decided here, before anything is read or written:
 * - oneself, always, with every record one keeps, private ones included;
 * - another Marine through opening their record in a unit one leads (detailUnitsFor), with what they shared there;
 * - a unit through viewing its shared records (the roster also through managing its members), with what is shared in it
 *   and the units beneath it. Figures by Marine need opening member records there, as the unit dashboard does.
 * A file leaves Vantage: another Marine's records as a spreadsheet or data file, and any unit's report as a file, need the
 * unit's export permission. Printing is reading; whoever may see a report may print it, and the print is audited.
 */

/** The most rows a report reads before it stops and says so. Tables print the first REPORT_ROW_LIMIT of them. */
const SCAN_LIMIT = 50_000;
const DAY_MS = 86_400_000;

export interface ReportTarget {
  type: ReportType;
  subject: ReportSubject;
  /** The Marine it is about: the reader, or one they lead. None for a unit. */
  userId: string | null;
  /** For a Marine one leads, the unit their shared records are read in; for a unit, the unit. */
  unitId: string | null;
  /** The unit and every unit beneath it; empty unless the report is about a unit. */
  unitIds: string[];
  /** May see figures by Marine. */
  detail: boolean;
  /** The files the reader may take it away as. */
  files: ReportFileFormat[];
}

type Purpose = 'view' | 'print';

const r2 = (n: number) => Math.round(n * 100) / 100;
/** Adds an item to its group in place, so grouping stays linear however many records a report reads. */
const addTo = <K, V>(groups: Map<K, V[]>, key: K, item: V) => { const list = groups.get(key); if (list) list.push(item); else groups.set(key, [item]); };
const ACRONYMS: Record<string, string> = { pme: 'PME', loa: 'LOA', mos: 'MOS', umt: 'UMT', nulo: 'NULO', ulo: 'ULO' };
/** A stored key as words: personal_award is "Personal award", pme is "PME". */
const words = (key: string | null | undefined): string | null => {
  if (!key) return null;
  const k = String(key);
  if (ACRONYMS[k.toLowerCase()]) return ACRONYMS[k.toLowerCase()];
  const s = k.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const personName = (p: { rank_abbr?: string | null; first_name?: string | null; last_name?: string | null } | null | undefined) =>
  p ? `${p.rank_abbr || ''} ${p.first_name || ''} ${p.last_name || ''}`.replace(/\s+/g, ' ').trim() : '';
const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : null);
const pct = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : null);

function table(id: string, title: string, columns: ReportColumn[], rows: Array<Record<string, Cell>>, empty: string, extra: { note?: string; total?: number } = {}): ReportTable {
  return { id, title, columns, rows: rows.slice(0, REPORT_ROW_LIMIT), total: extra.total ?? rows.length, empty, ...(extra.note ? { note: extra.note } : {}) };
}

/** People by id, named as the record shows them: rank, first and last name. */
function namesOf(ctx: AppContext, ids: Array<string | null | undefined>): Map<string, string> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!unique.length) return new Map();
  const rows = ctx.db.prepare(`SELECT u.id, u.first_name, u.last_name, r.abbr AS rank_abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(unique)) as Array<{ id: string; first_name: string; last_name: string; rank_abbr: string | null }>;
  return new Map(rows.map((r) => [r.id, personName(r)]));
}

const unitLabel = (ctx: AppContext, unitId: string | null) => {
  if (!unitId) return null;
  const u = ctx.db.prepare('SELECT name FROM units WHERE id = ?').get(unitId) as { name: string } | undefined;
  return u ? u.name : null;
};

// ——— Who a report is about ———

/**
 * Decides whom the report is about and what the reader may see and take away, or refuses. Nothing is read or written
 * before it answers, so a refusal leaves only the access_denied entry the app writes.
 */
export function resolveTarget(ctx: AppContext, user: SessionUser, scope: Scope, q: ReportQuery): ReportTarget {
  const spec = REPORT_SPECS[q.type];
  const other = q.user_id && q.user_id !== user.id ? q.user_id : null;
  let subject: ReportSubject = q.subject ?? (other ? 'member' : spec.subjects[0]);
  if (subject === 'member' && !other) {
    if (q.user_id === user.id) subject = 'self';
    else throw badRequest('Choose the Marine the report is about.', { fieldErrors: { user_id: 'Required.' } });
  }
  if (subject !== 'member' && other) throw badRequest('A report about a unit or yourself does not name a Marine.', { fieldErrors: { user_id: 'Leave it out.' } });
  if (!spec.subjects.includes(subject)) {
    const about = spec.subjects.map((s) => (s === 'self' ? 'yourself' : s === 'member' ? 'a Marine you lead' : 'a unit')).join(' or ');
    throw badRequest(`The ${spec.title} report is about ${about}.`, { fieldErrors: { subject: 'Not for this report.' } });
  }
  const all = [...REPORT_FILE_FORMATS];
  if (subject === 'self') return { type: q.type, subject, userId: user.id, unitId: null, unitIds: [], detail: true, files: all };

  if (subject === 'member') {
    const units = detailUnitsFor(ctx, scope, other!);
    if (!units.length) throw forbidden('You cannot build a report for that Marine.');
    // As the analysis does: a unit the reader cannot open this Marine in falls back to one they can, inside the same Unit
    // Instance. A unit in another instance is refused rather than answered with another's figures.
    const near = !q.unit_id || units.includes(q.unit_id) ? q.unit_id : units.find((u) => sameInstance(ctx, u, q.unit_id));
    if (q.unit_id && !near) throw forbidden('That Marine is not yours to report on in that Unit Instance.', 'cross_instance');
    const unitId = near || units[0];
    return { type: q.type, subject, userId: other, unitId, unitIds: [], detail: true, files: can(scope, PERMISSIONS.EXPORT_DATA, unitId) ? all : ['pdf'] };
  }

  if (!q.unit_id) throw badRequest('Choose the unit the report is about.', { fieldErrors: { unit_id: 'Required.' } });
  if (!getUnit(ctx, q.unit_id)) throw notFound('No such unit.');
  const reads = can(scope, PERMISSIONS.VIEW_RECORDS, q.unit_id) || (q.type === 'personnel' && can(scope, PERMISSIONS.MANAGE_MEMBERS, q.unit_id));
  if (!reads) throw forbidden(`You cannot run the ${spec.title} report for that unit.`);
  return {
    type: q.type, subject, userId: null, unitId: q.unit_id, unitIds: subtreeIds(ctx, q.unit_id),
    detail: can(scope, PERMISSIONS.VIEW_MEMBER_DETAIL, q.unit_id), files: can(scope, PERMISSIONS.EXPORT_DATA, q.unit_id) ? all : [],
  };
}

/** The records a report on this target reads, as a WHERE fragment on alias t. Goals and tasks also reach their assignee. */
function ownership(t: ReportTarget, table: string): { sql: string; params: unknown[] } {
  const assigned = table === 'goals' || table === 'tasks';
  if (t.subject === 'self') {
    return assigned ? { sql: `(t.user_id = ? OR (t.assignee_id = ? AND t.visibility = 'unit'))`, params: [t.userId, t.userId] } : { sql: 't.user_id = ?', params: [t.userId] };
  }
  if (t.subject === 'member') {
    return assigned
      ? { sql: `(t.user_id = ? OR t.assignee_id = ?) AND t.unit_id = ? AND t.visibility = 'unit'`, params: [t.userId, t.userId, t.unitId] }
      : { sql: `t.user_id = ? AND t.unit_id = ? AND t.visibility = 'unit'`, params: [t.userId, t.unitId] };
  }
  return { sql: `t.unit_id IN (SELECT value FROM json_each(?)) AND t.visibility = 'unit'`, params: [JSON.stringify(t.unitIds)] };
}

interface Period { from: string | null; to: string | null; label: string }

function periodOf(ctx: AppContext, q: ReportQuery): Period | null {
  const fallback = REPORT_SPECS[q.type].period;
  if (!fallback) return null;
  const key = q.period || fallback;
  if (key === 'all' && !(q.from && q.to)) return { from: null, to: null, label: 'All time' };
  const b = periodBounds(key, q.from, q.to, ctx.config.timezone);
  return { from: b.from, to: b.to, label: b.label };
}

/** The day a point-in-time report stands on: the one asked for, or today where the reader is. */
const asOfDay = (ctx: AppContext, user: SessionUser, q: ReportQuery) => q.as_of || zonedDay(zoneOf(ctx, user));

/** What the reader does not see, in a line, when the report leaves out figures by Marine. */
const NO_DETAIL = 'Figures by Marine are left out: they need opening member records in this unit.';

interface Built {
  summary: ReportFigure[];
  sections: ReportSection[];
  notes: string[];
  primary: string | null;
  filters?: Array<{ label: string; value: string }>;
  period?: Period | null;
}

const sourceNote = (ctx: AppContext, t: ReportTarget) => {
  if (t.subject === 'self') return 'Drawn from your own records, private ones included.';
  if (t.subject === 'member') return `Drawn from what the Marine shared with ${unitLabel(ctx, t.unitId) || 'the unit'}. Private entries are never included.`;
  const beneath = t.unitIds.length - 1;
  return `Drawn from what is shared with ${unitLabel(ctx, t.unitId) || 'the unit'}${beneath ? ` and the ${beneath} unit${beneath === 1 ? '' : 's'} beneath it` : ''}. Private entries are never included.`;
};

const SPAN_NOTE = 'An entry that spans more than one period counts in each period it touches (ADR-0018).';

// ——— Individual performance: the analysis, as tables ———

function buildIndividual(ctx: AppContext, t: ReportTarget, q: ReportQuery): Built {
  const report = buildAnalysisReport(ctx, { userId: t.userId!, unitId: t.subject === 'member' ? t.unitId : null, period: q.period || 'last12', from: q.from, to: q.to, track: q.track });
  const cfg = report.metricsConfig;
  const kindOf = (f: string) => (f === 'money' ? 'money' : f === 'percent' ? 'percent' : f === 'hours' ? 'hours' : 'number') as ReportFigure['kind'];
  const suffix = (f: string) => (f === 'money' ? ` (${cfg.currency_symbol})` : f === 'percent' ? ' (%)' : f === 'hours' ? ' (hours)' : '');
  const share = (s: { name: string; entries: number; share: number; value: number; outcomeRate: number }) => ({ name: s.name, entries: s.entries, share: s.share, value: s.value, outcome: s.outcomeRate });
  const shareColumns = (first: string): ReportColumn[] => [
    { key: 'name', label: first, width: 26 }, { key: 'entries', label: 'Entries', kind: 'number', width: 8 }, { key: 'share', label: 'Share', kind: 'percent', width: 8 },
    { key: 'value', label: cfg.currency_label, kind: 'money', width: 12 }, { key: 'outcome', label: 'With an outcome', kind: 'percent', width: 10 },
  ];
  const sections: ReportSection[] = [];
  if (report.summary.length) sections.push({ id: 'brief', heading: 'In brief', tables: [], notes: report.summary });
  sections.push({
    id: 'measures', heading: 'Against the period before', lede: `${report.period.label} against ${report.prior.label}.`,
    tables: [table('measures', 'Measures', [
      { key: 'measure', label: 'Measure', width: 26 }, { key: 'current', label: 'This period', kind: 'number', width: 12 },
      { key: 'prior', label: 'Period before', kind: 'number', width: 12 }, { key: 'change', label: 'Change', kind: 'percent', width: 10 },
    ], report.kpis.map((k) => ({ measure: `${k.label}${suffix(k.format)}`, current: k.value, prior: k.prior, change: k.movement.pct })), 'No measures for this period.')],
  });
  const months = report.monthly.map((m) => ({ month: m.label, entries: m.entries, value: m.value, quantity: m.quantity, outcome: m.withOutcome }));
  sections.push({
    id: 'months', heading: 'Month by month',
    chart: { title: 'Entries by month', kind: 'number', bars: months.map((m) => ({ label: m.month, value: m.entries })), table: 'months' },
    tables: [table('months', 'Month by month', [
      { key: 'month', label: 'Month', width: 12 }, { key: 'entries', label: 'Entries', kind: 'number', width: 8 }, { key: 'value', label: cfg.currency_label, kind: 'money', width: 12 },
      { key: 'quantity', label: 'Count', kind: 'number', width: 8 }, { key: 'outcome', label: 'With an outcome', kind: 'number', width: 10 },
    ], months, 'Nothing was logged in the period.')],
  });
  sections.push({
    id: 'categories', heading: 'By category',
    chart: { title: 'Entries by category', kind: 'number', bars: report.byCategory.filter((c) => c.entries).map((c) => ({ label: c.name, value: c.entries })), table: 'categories' },
    tables: [table('categories', 'By category', shareColumns('Category'), report.byCategory.map(share), 'No entries in the period.')],
  });
  sections.push({ id: 'areas', heading: `By ${report.track === 'fitrep' ? 'FITREP' : 'JEPES'} area`, tables: [table('areas', 'By area', shareColumns('Area'), report.byArea.map(share), 'No entries in the period.')] });
  sections.push({
    id: 'goals', heading: 'Goals',
    tables: [table('goals', 'Goals', [
      { key: 'title', label: 'Goal', width: 28 }, { key: 'status', label: 'Status', width: 10 }, { key: 'current', label: 'Current', kind: 'number', width: 8 },
      { key: 'target', label: 'Target', kind: 'number', width: 8 }, { key: 'pct', label: 'Progress', kind: 'percent', width: 8 }, { key: 'unit_label', label: 'Of', width: 8 },
      { key: 'period_end', label: 'Until', kind: 'date', width: 9 },
    ], report.goals.items.map((g) => ({ title: g.title, status: words(g.status), current: g.current, target: g.target, pct: g.pct, unit_label: g.unit_label, period_end: g.period_end })), 'No goals ran in the period.')],
  });
  const c = report.career;
  sections.push({
    id: 'career', heading: 'Training, awards and counseling',
    figures: [
      { label: 'Training hours', value: c.trainingHours, kind: 'hours' }, { label: 'Courses', value: c.trainings.length, kind: 'number' },
      { label: 'Awards', value: c.awards.length, kind: 'number' }, { label: 'Counselings', value: c.counselings.count, kind: 'number' },
      { label: 'Last counseling', value: c.counselings.lastDate, kind: 'date' }, { label: 'Not yet acknowledged', value: c.counselings.unacknowledged, kind: 'number' },
    ],
    tables: [
      table('trainings', 'Training', [
        { key: 'date', label: 'Date', kind: 'date', width: 9 }, { key: 'title', label: 'Course', width: 30 }, { key: 'type', label: 'Type', width: 12 },
        { key: 'hours', label: 'Hours', kind: 'hours', width: 8 }, { key: 'status', label: 'Status', width: 10 },
      ], c.trainings.map((x) => ({ date: x.date ?? null, title: x.title, type: words(x.type), hours: x.hours ?? null, status: words(x.status) })), 'No training in the period.'),
      table('awards', 'Awards', [
        { key: 'date', label: 'Date', kind: 'date', width: 9 }, { key: 'name', label: 'Award', width: 30 }, { key: 'type', label: 'Type', width: 12 }, { key: 'status', label: 'Status', width: 10 },
      ], c.awards.map((x) => ({ date: x.date ?? null, name: x.name, type: words(x.type), status: words(x.status) })), 'No awards in the period.'),
    ],
    notes: ['Counselings are counted, never quoted: what was said stays on the counseling’s own page.'],
  });
  sections.push({
    id: 'ledger', heading: 'Every entry',
    tables: [table('ledger', 'Every entry in the period', [
      { key: 'date', label: 'Date', kind: 'date', width: 9 }, { key: 'title', label: 'Activity', width: 28 }, { key: 'category', label: 'Category', width: 12 },
      { key: 'area', label: 'Area', width: 12 }, { key: 'quantity', label: 'Count', kind: 'number', width: 7 }, { key: 'unit_label', label: 'Of', width: 8 },
      { key: 'value', label: cfg.currency_label, kind: 'money', width: 10 }, { key: 'value_type', label: 'Value type', width: 10 }, { key: 'result', label: 'Outcome', width: 22 },
    ], report.appendix.map((l) => ({ date: l.date, title: l.title, category: l.category, area: l.area, quantity: l.quantity, unit_label: l.unit_label, value: l.value, value_type: l.value_type, result: l.result })), 'Nothing was logged in the period.')],
  });
  return {
    summary: report.kpis.slice(0, 8).map((k) => ({ label: k.label, value: k.value, kind: kindOf(k.format), hint: k.movement.pct == null ? undefined : `${k.movement.pct > 0 ? '+' : ''}${k.movement.pct}% on the period before` })),
    sections, primary: 'ledger',
    notes: [sourceNote(ctx, t), SPAN_NOTE, `Measured for ${report.track === 'fitrep' ? 'FITREP' : 'JEPES'}${q.track ? '' : ', by the Marine’s grade'}.`],
    period: { from: report.period.from, to: report.period.to, label: report.label },
  };
}

// ——— Activity: the ledger ———

function buildActivity(ctx: AppContext, t: ReportTarget, q: ReportQuery, period: Period | null): Built {
  const cfg = ctx.runtime.metrics;
  const own = ownership(t, 'activities');
  const span = periodClause('activities', 't', period?.from, period?.to);
  const where = [own.sql, 't.deleted_at IS NULL', span.sql];
  const params: unknown[] = [...own.params, ...span.params];
  if (q.category) { where.push('t.category = ?'); params.push(q.category); }
  if (q.area) { where.push('t.eval_area = ?'); params.push(q.area); }
  const rows = ctx.db.prepare(`SELECT t.* FROM activities t WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.created_at DESC LIMIT ${SCAN_LIMIT}`).all(...params) as Array<Record<string, unknown>>;
  const names = t.subject === 'unit' ? namesOf(ctx, rows.map((r) => r.user_id as string)) : new Map<string, string>();
  const byCategory = new Map<string, { entries: number; value: number; quantity: number }>();
  let value = 0; let outcomes = 0;
  for (const r of rows) {
    const amount = Number(r.dollar_amount) || 0;
    const counts = isSummable(r.dollar_type as string | null, cfg);
    if (counts) value += amount;
    if (r.result && String(r.result).trim()) outcomes += 1;
    const key = (r.category as string) || 'Other';
    const b = byCategory.get(key) || { entries: 0, value: 0, quantity: 0 };
    b.entries += 1; b.value += counts ? amount : 0; b.quantity += Number(r.quantity) || 0;
    byCategory.set(key, b);
  }
  const categories = [...byCategory.entries()].map(([name, b]) => ({ name, entries: b.entries, value: r2(b.value), quantity: b.quantity })).sort((a, b) => b.entries - a.entries);
  const columns: ReportColumn[] = [
    { key: 'date', label: 'Date', kind: 'date', width: 9 }, { key: 'end_date', label: 'End date', kind: 'date', width: 9 },
    ...(t.subject === 'unit' ? [{ key: 'owner', label: 'Marine', width: 16 }] : []),
    { key: 'title', label: 'Activity', width: 28 }, { key: 'category', label: 'Category', width: 12 }, { key: 'area', label: 'Area', width: 12 },
    { key: 'quantity', label: 'Count', kind: 'number', width: 7 }, { key: 'unit_label', label: 'Of', width: 8 },
    { key: 'value', label: cfg.currency_label, kind: 'money', width: 10 }, { key: 'value_type', label: 'Value type', width: 10 }, { key: 'result', label: 'Outcome', width: 22 },
  ];
  const ledger = rows.map((r) => ({
    date: day(r.date as string), end_date: day(r.end_date as string), owner: names.get(r.user_id as string) || null, title: r.title as string,
    category: (r.category as string) || null, area: (r.eval_area as string) || null, quantity: r.quantity == null ? null : Number(r.quantity), unit_label: (r.unit_label as string) || null,
    value: r.dollar_amount == null ? null : Number(r.dollar_amount), value_type: r.dollar_type ? valueType(r.dollar_type as string, cfg)?.label || String(r.dollar_type) : null, result: (r.result as string) || null,
  }));
  const contributors = new Set(rows.map((r) => r.user_id)).size;
  return {
    summary: [
      { label: 'Entries', value: rows.length, kind: 'number' }, { label: cfg.currency_label, value: r2(value), kind: 'money', hint: 'Value types that count toward the total' },
      { label: 'With an outcome', value: pct(outcomes, rows.length), kind: 'percent' },
      ...(t.subject === 'unit' ? [{ label: 'Marines contributing', value: contributors, kind: 'number' as const }] : []),
    ],
    sections: [
      {
        id: 'categories', heading: 'By category',
        chart: { title: 'Entries by category', kind: 'number', bars: categories.map((c) => ({ label: c.name, value: c.entries })), table: 'categories' },
        tables: [table('categories', 'By category', [
          { key: 'name', label: 'Category', width: 24 }, { key: 'entries', label: 'Entries', kind: 'number', width: 8 },
          { key: 'value', label: cfg.currency_label, kind: 'money', width: 12 }, { key: 'quantity', label: 'Count', kind: 'number', width: 8 },
        ], categories, 'No activities in the period.')],
      },
      { id: 'activities', heading: 'Every activity', tables: [table('activities', 'Activities', columns, ledger, 'No activities match these filters.', { total: rows.length })] },
    ],
    primary: 'activities',
    notes: [sourceNote(ctx, t), SPAN_NOTE, ...(rows.length >= SCAN_LIMIT ? [`Only the first ${SCAN_LIMIT.toLocaleString('en-US')} activities were read. Narrow the period to see the rest.`] : [])],
    filters: [...(q.category ? [{ label: 'Category', value: q.category }] : []), ...(q.area ? [{ label: 'Area', value: q.area }] : [])],
  };
}

// ——— Training: what was completed, and where each Marine stands against the requirements ———

export interface Requirement { id: string; title: string; type: string; course_code: string | null; interval_months: number | null; unit_id: string | null }
export interface TrainingRow { user_id: string; title: string; status: string | null; date: string | null; end_date: string | null }

const norm = (s: string | null | undefined) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The day `months` after an ISO day, clamped to the month's end: 31 Jan and a month is 28 or 29 Feb. */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
const addDays = (iso: string, days: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/**
 * Where one Marine stands on one requirement on a day: the latest completed course that is it (by title, or by its course
 * code in the course's title) on or before the day, and when it is due again. Only training the report may read counts,
 * so "No record" means none was shared, never that the Marine did not train.
 */
export function standing(req: Requirement, trainings: readonly TrainingRow[], asOf: string): { last: string | null; due: string | null; status: 'met' | 'due_soon' | 'overdue' | 'missing' } {
  const title = norm(req.title);
  const code = norm(req.course_code);
  const done = trainings
    .filter((x) => (x.status || 'completed') === 'completed' && (norm(x.title) === title || (code && norm(x.title).includes(code))))
    .map((x) => x.end_date || x.date).filter((d): d is string => Boolean(d) && d! <= asOf).sort();
  const last = done.at(-1) ?? null;
  if (!last) return { last: null, due: null, status: 'missing' };
  if (!req.interval_months) return { last, due: null, status: 'met' };
  const due = addMonths(last, req.interval_months);
  if (due < asOf) return { last, due, status: 'overdue' };
  if (due <= addDays(asOf, DUE_SOON_DAYS)) return { last, due, status: 'due_soon' };
  return { last, due, status: 'met' };
}

const STANDING_LABEL: Record<string, string> = { met: 'Met', due_soon: 'Due soon', overdue: 'Past due', missing: 'No record' };

function buildTraining(ctx: AppContext, user: SessionUser, t: ReportTarget, q: ReportQuery, period: Period | null): Built {
  const asOf = asOfDay(ctx, user, q);
  const own = ownership(t, 'trainings');
  const span = periodClause('trainings', 't', period?.from, period?.to);
  const where = [own.sql, 't.deleted_at IS NULL', span.sql];
  const params: unknown[] = [...own.params, ...span.params];
  if (q.kind) { where.push('t.type = ?'); params.push(q.kind); }
  const rows = ctx.db.prepare(`SELECT t.* FROM trainings t WHERE ${where.join(' AND ')} ORDER BY t.date DESC LIMIT ${SCAN_LIMIT}`).all(...params) as Array<Record<string, unknown>>;
  const names = t.subject === 'unit' ? namesOf(ctx, rows.map((r) => r.user_id as string)) : new Map<string, string>();
  const hours = rows.reduce((n, r) => n + (Number(r.hours) || 0), 0);
  const courses = rows.map((r) => ({
    date: day(r.date as string), end_date: day(r.end_date as string), owner: names.get(r.user_id as string) || null, title: r.title as string,
    type: words(r.type as string), hours: r.hours == null ? null : Number(r.hours), provider: (r.provider as string) || null, status: words(r.status as string),
  }));
  const courseColumns: ReportColumn[] = [
    { key: 'date', label: 'Date', kind: 'date', width: 9 }, { key: 'end_date', label: 'End date', kind: 'date', width: 9 },
    ...(t.subject === 'unit' ? [{ key: 'owner', label: 'Marine', width: 16 }] : []),
    { key: 'title', label: 'Course', width: 30 }, { key: 'type', label: 'Type', width: 12 }, { key: 'hours', label: 'Hours', kind: 'hours', width: 7 },
    { key: 'provider', label: 'Provider', width: 14 }, { key: 'status', label: 'Status', width: 10 },
  ];

  // The requirements of the Unit Instance the report is in, each where it applies to the Marines it is about.
  const orgId = t.subject === 'self' ? primaryOrgOf(ctx, t.userId!)?.orgId ?? null : orgOfUnit(ctx, t.unitId);
  const tree = unitTree(ctx);
  const requirements = (orgId ? listTrainingRequirements(ctx, orgId) : []).filter((r) => r.active && (!q.kind || r.type === q.kind)) as Requirement[];
  const reach = new Map(requirements.map((r) => [r.id, r.unit_id ? new Set(subtreeIds(ctx, r.unit_id, tree)) : null]));
  type Person = { id: string; name: string; team: string | null; units: string[] };
  const people: Person[] = [];
  if (t.subject === 'unit') {
    const members = membersAcross(ctx, t.unitIds);
    const memberships = ctx.db.prepare('SELECT user_id, unit_id FROM unit_members WHERE user_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(members.map((m) => m.id))) as Array<{ user_id: string; unit_id: string }>;
    for (const m of members) people.push({ id: m.id, name: personName(m), team: t.unitIds.length > 1 ? m.team : null, units: memberships.filter((x) => x.user_id === m.id).map((x) => x.unit_id) });
  } else {
    const units = (ctx.db.prepare('SELECT unit_id FROM unit_members WHERE user_id = ?').all(t.userId) as Array<{ unit_id: string }>).map((x) => x.unit_id);
    people.push({ id: t.userId!, name: namesOf(ctx, [t.userId]).get(t.userId!) || '', team: null, units });
  }
  // Every completed course the report may read, whenever it was: a requirement met two years ago is met.
  const history = ctx.db.prepare(`SELECT t.user_id, t.title, t.status, t.date, t.end_date FROM trainings t WHERE ${own.sql} AND t.deleted_at IS NULL LIMIT ${SCAN_LIMIT}`).all(...own.params) as TrainingRow[];
  const byPerson = new Map<string, TrainingRow[]>();
  for (const h of history) addTo(byPerson, h.user_id, h);
  const applies = (r: Requirement, p: Person) => { const set = reach.get(r.id); return !set || p.units.some((u) => set.has(u)); };
  const status = q.status && TRAINING_STATUSES.some((s) => s.value === q.status) ? q.status : 'all';

  const standings = requirements.flatMap((r) => people.filter((p) => applies(r, p)).map((p) => ({ r, p, s: standing(r, byPerson.get(p.id) || [], asOf) })));
  const shown = standings.filter((x) => status === 'all' || x.s.status === status);
  const unitNames = new Map<string, string>();
  const appliesTo = (r: Requirement) => {
    if (!r.unit_id) return 'Every unit';
    if (!unitNames.has(r.unit_id)) unitNames.set(r.unit_id, unitLabel(ctx, r.unit_id) || 'A unit');
    return unitNames.get(r.unit_id)!;
  };
  const recurs = (r: Requirement) => (r.interval_months ? `Every ${r.interval_months} month${r.interval_months === 1 ? '' : 's'}` : 'Once');
  const counts = (key: string) => standings.filter((x) => x.s.status === key).length;

  const sections: ReportSection[] = [{ id: 'courses', heading: 'Training in the period', tables: [table('courses', 'Training', courseColumns, courses, 'No training in the period.', { total: rows.length })] }];
  const lede = `Where each stands on ${formatDTG(asOf)}. Due soon is due again within ${DUE_SOON_DAYS} days.`;
  if (!orgId) {
    sections.push({ id: 'requirements', heading: 'Against the training requirements', tables: [], notes: ['Not in a Unit Instance, so no training requirements apply.'] });
  } else if (t.subject === 'unit') {
    const summary = requirements.map((r) => {
      const of = standings.filter((x) => x.r.id === r.id);
      const n = (key: string) => of.filter((x) => x.s.status === key).length;
      return { title: r.title, type: words(r.type), applies: appliesTo(r), recurs: recurs(r), marines: of.length, met: n('met'), due_soon: n('due_soon'), overdue: n('overdue'), missing: n('missing') };
    });
    sections.push({
      id: 'requirements', heading: 'Against the training requirements', lede,
      tables: [table('requirements', 'By requirement', [
        { key: 'title', label: 'Requirement', width: 24 }, { key: 'type', label: 'Type', width: 10 }, { key: 'applies', label: 'Applies to', width: 14 }, { key: 'recurs', label: 'Recurs', width: 10 },
        { key: 'marines', label: 'Marines', kind: 'number', width: 7 }, { key: 'met', label: 'Met', kind: 'number', width: 6 }, { key: 'due_soon', label: 'Due soon', kind: 'number', width: 7 },
        { key: 'overdue', label: 'Past due', kind: 'number', width: 7 }, { key: 'missing', label: 'No record', kind: 'number', width: 7 },
      ], summary, 'The Unit Instance has no training requirements in use.')],
    });
    if (t.detail) {
      sections.push({
        id: 'standing', heading: 'By Marine',
        tables: [table('standing', 'Each Marine against each requirement', [
          { key: 'marine', label: 'Marine', width: 18 }, ...(t.unitIds.length > 1 ? [{ key: 'team', label: 'Team', width: 12 }] : []),
          { key: 'requirement', label: 'Requirement', width: 24 }, { key: 'last', label: 'Last completed', kind: 'date', width: 10 }, { key: 'due', label: 'Due again', kind: 'date', width: 10 },
          { key: 'status', label: 'Standing', width: 9 },
        ], shown.map((x) => ({ marine: x.p.name, team: x.p.team, requirement: x.r.title, last: x.s.last, due: x.s.due, status: STANDING_LABEL[x.s.status] })), 'No Marine matches this standing.')],
      });
    }
  } else {
    sections.push({
      id: 'standing', heading: 'Against the training requirements', lede,
      tables: [table('standing', 'Each requirement', [
        { key: 'requirement', label: 'Requirement', width: 26 }, { key: 'applies', label: 'Applies to', width: 14 }, { key: 'recurs', label: 'Recurs', width: 10 },
        { key: 'last', label: 'Last completed', kind: 'date', width: 10 }, { key: 'due', label: 'Due again', kind: 'date', width: 10 }, { key: 'status', label: 'Standing', width: 9 },
      ], shown.map((x) => ({ requirement: x.r.title, applies: appliesTo(x.r), recurs: recurs(x.r), last: x.s.last, due: x.s.due, status: STANDING_LABEL[x.s.status] })), 'No requirement matches this standing.')],
    });
  }
  return {
    summary: [
      { label: 'Courses in the period', value: rows.length, kind: 'number' }, { label: 'Training hours', value: r2(hours), kind: 'hours' },
      ...(orgId ? [
        { label: 'Met', value: counts('met'), kind: 'number' as const }, { label: 'Due soon', value: counts('due_soon'), kind: 'number' as const },
        { label: 'Past due', value: counts('overdue'), kind: 'number' as const }, { label: 'No record', value: counts('missing'), kind: 'number' as const },
      ] : []),
    ],
    sections,
    primary: !orgId ? 'courses' : t.subject === 'unit' && !t.detail ? 'requirements' : 'standing',
    notes: [
      sourceNote(ctx, t),
      'A requirement is met by a completed course with its title, or with its course code in the title. No record means no such course was shared, not that none was taken.',
      ...(t.subject === 'unit' && !t.detail ? [NO_DETAIL] : []),
    ],
    filters: [
      { label: 'Standing on', value: formatDTG(asOf) },
      ...(q.kind ? [{ label: 'Type', value: words(q.kind)! }] : []),
      ...(status !== 'all' ? [{ label: 'Standing', value: TRAINING_STATUSES.find((s) => s.value === status)!.label }] : []),
    ],
  };
}

// ——— Unit performance and leadership: the unit dashboard ———

const dashboardOf = (ctx: AppContext, t: ReportTarget, period: Period) =>
  unitDashboard(ctx, t.unitId!, period.from || '1970-01-01', period.to || zonedDay(ctx.config.timezone), { includeMembers: t.detail });
const memberLabel = (m: { rank_abbr: string | null; name: string }) => `${m.rank_abbr ? `${m.rank_abbr} ` : ''}${m.name}`;

function buildUnit(ctx: AppContext, t: ReportTarget, period: Period): Built {
  const cfg = ctx.runtime.metrics;
  const d = dashboardOf(ctx, t, period);
  const sections: ReportSection[] = [
    {
      id: 'weeks', heading: 'Week by week',
      chart: { title: 'Entries by week', kind: 'number', bars: d.weekly.map((w) => ({ label: formatDTG(w.week), value: w.entries })), table: 'weeks' },
      tables: [table('weeks', 'Week by week', [
        { key: 'week', label: 'Week of', kind: 'date', width: 10 }, { key: 'entries', label: 'Entries', kind: 'number', width: 8 }, { key: 'dollars', label: cfg.currency_label, kind: 'money', width: 12 },
      ], d.weekly.map((w) => ({ week: w.week, entries: w.entries, dollars: w.dollars })), 'Nothing was shared in the period.')],
    },
    {
      id: 'categories', heading: 'By category',
      tables: [
        table('categories', 'By category', [{ key: 'category', label: 'Category', width: 24 }, { key: 'entries', label: 'Entries', kind: 'number', width: 8 }, { key: 'dollars', label: cfg.currency_label, kind: 'money', width: 12 }],
          d.by_category.map((c) => ({ category: c.category, entries: c.entries, dollars: c.dollars })), 'Nothing was shared in the period.'),
        table('areas', 'By evaluation area', [{ key: 'area', label: 'Area', width: 24 }, { key: 'entries', label: 'Entries', kind: 'number', width: 8 }],
          d.by_area.map((a) => ({ area: a.area, entries: a.entries })), 'Nothing was shared in the period.'),
      ],
    },
  ];
  if (d.by_team.length) {
    sections.push({
      id: 'teams', heading: 'Team by team',
      tables: [table('teams', 'Team by team', [
        { key: 'name', label: 'Team', width: 20 }, { key: 'members', label: 'Marines', kind: 'number', width: 8 }, { key: 'contributors', label: 'Contributing', kind: 'number', width: 9 },
        { key: 'entries', label: 'Entries', kind: 'number', width: 8 }, { key: 'dollars', label: cfg.currency_label, kind: 'money', width: 12 },
      ], d.by_team.map((x) => ({ name: x.name, members: x.members, contributors: x.contributors, entries: x.entries, dollars: x.dollars })), 'No teams beneath the unit.')],
    });
  }
  if (t.detail) {
    sections.push({
      id: 'members', heading: 'Marine by Marine',
      tables: [table('members', 'Marine by Marine', [
        { key: 'name', label: 'Marine', width: 18 }, { key: 'billet', label: 'Billet', width: 14 }, ...(d.by_team.length ? [{ key: 'team', label: 'Team', width: 12 }] : []),
        { key: 'entries', label: 'Entries', kind: 'number', width: 7 }, { key: 'dollars', label: cfg.currency_label, kind: 'money', width: 11 }, { key: 'completeness', label: 'Complete', kind: 'percent', width: 8 },
        { key: 'last_entry', label: 'Last entry', kind: 'date', width: 9 }, { key: 'open_tasks', label: 'Open tasks', kind: 'number', width: 7 },
      ], d.members.map((m) => ({ name: memberLabel(m), billet: m.billet, team: m.team, entries: m.entries, dollars: m.dollars, completeness: m.completeness, last_entry: m.last_entry, open_tasks: m.open_tasks })), 'No Marines in the unit.')],
    });
  }
  return {
    summary: [
      { label: 'Marines', value: d.totals.members, kind: 'number' }, { label: 'Contributing', value: d.totals.contributors, kind: 'number' },
      { label: 'Entries shared', value: d.totals.entries, kind: 'number' }, { label: cfg.currency_label, value: d.totals.dollars, kind: 'money' },
      { label: 'Complete entries', value: d.totals.completeness, kind: 'percent', hint: 'With an outcome and a measure' },
      { label: 'Open tasks', value: d.totals.open_tasks, kind: 'number' }, { label: 'Active goals', value: d.totals.active_goals, kind: 'number' },
      { label: 'Awards in progress', value: d.totals.awards_in_progress, kind: 'number' },
    ],
    sections, primary: t.detail ? 'members' : 'weeks',
    notes: [sourceNote(ctx, t), SPAN_NOTE, 'An entry begun before the period counts in its first week.', ...(t.detail ? [] : [NO_DETAIL])],
  };
}

function buildLeadership(ctx: AppContext, user: SessionUser, t: ReportTarget, period: Period): Built {
  const d = dashboardOf(ctx, t, period);
  const units = JSON.stringify(t.unitIds);
  const today = zonedDay(zoneOf(ctx, user));
  const awards = ctx.db.prepare(`SELECT name, type, status, date, user_id FROM awards WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND status IN ('recommended', 'submitted', 'approved') ORDER BY CASE status WHEN 'recommended' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END, date LIMIT ${SCAN_LIMIT}`).all(units) as Array<{ name: string; type: string | null; status: string; date: string | null; user_id: string }>;
  const tasks = ctx.db.prepare(`SELECT title, due_date, priority, assignee_id, user_id FROM tasks WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND status <> 'completed' AND due_date IS NOT NULL AND due_date < ? ORDER BY due_date LIMIT ${SCAN_LIMIT}`).all(units, today) as Array<{ title: string; due_date: string; priority: string | null; assignee_id: string | null; user_id: string }>;
  const names = namesOf(ctx, [...awards.map((a) => a.user_id), ...tasks.map((x) => x.assignee_id || x.user_id)]);
  const due = d.members.filter((m) => m.counseling_due);
  const unready = d.members.filter((m) => m.readiness_complete < 5);
  const sections: ReportSection[] = [];
  if (t.detail) {
    sections.push({
      id: 'counseling', heading: 'Counseling due', lede: 'No counseling shared with the unit in the last 45 days.',
      tables: [table('counseling', 'Counseling due', [
        { key: 'name', label: 'Marine', width: 20 }, { key: 'billet', label: 'Billet', width: 16 }, ...(d.by_team.length ? [{ key: 'team', label: 'Team', width: 12 }] : []),
        { key: 'last', label: 'Last counseling', kind: 'date', width: 10 },
      ], due.map((m) => ({ name: memberLabel(m), billet: m.billet, team: m.team, last: m.last_counseling })), 'Every Marine has been counseled in the last 45 days.')],
    });
  }
  sections.push({
    id: 'awards', heading: 'Awards in progress',
    tables: [table('awards', 'Awards in progress', [
      { key: 'name', label: 'Award', width: 26 }, { key: 'marine', label: 'Marine', width: 18 }, { key: 'type', label: 'Type', width: 12 },
      { key: 'status', label: 'Status', width: 10 }, { key: 'date', label: 'Date', kind: 'date', width: 9 },
    ], awards.map((a) => ({ name: a.name, marine: names.get(a.user_id) || null, type: words(a.type), status: words(a.status), date: a.date })), 'No awards are in progress.')],
  });
  sections.push({
    id: 'tasks', heading: 'Overdue tasks',
    tables: [table('tasks', 'Overdue tasks', [
      { key: 'title', label: 'Task', width: 30 }, { key: 'assignee', label: 'Assigned to', width: 18 }, { key: 'priority', label: 'Priority', width: 9 },
      { key: 'due', label: 'Due', kind: 'date', width: 9 }, { key: 'days', label: 'Days late', kind: 'number', width: 8 },
    ], tasks.map((x) => ({ title: x.title, assignee: names.get(x.assignee_id || x.user_id) || null, priority: words(x.priority), due: x.due_date, days: Math.round((Date.parse(today) - Date.parse(x.due_date)) / DAY_MS) })), 'No shared task is overdue.')],
  });
  if (t.detail) {
    sections.push({
      id: 'readiness', heading: 'Readiness not fully reported', lede: 'PFT, CFT, rifle qualification, MCMAP belt and PME: how many of the five each Marine has on record.',
      tables: [table('readiness', 'Readiness not fully reported', [
        { key: 'name', label: 'Marine', width: 20 }, { key: 'billet', label: 'Billet', width: 16 }, { key: 'reported', label: 'Reported of 5', kind: 'number', width: 9 },
      ], unready.map((m) => ({ name: memberLabel(m), billet: m.billet, reported: m.readiness_complete })), 'Every Marine has all five on record.')],
    });
  }
  return {
    summary: [
      ...(t.detail ? [{ label: 'Counseling due', value: d.totals.counseling_due, kind: 'number' as const }] : []),
      { label: 'Awards in progress', value: awards.length, kind: 'number' }, { label: 'Overdue tasks', value: tasks.length, kind: 'number' },
      ...(t.detail ? [{ label: 'Readiness incomplete', value: unready.length, kind: 'number' as const }] : []),
      { label: 'Average PFT', value: d.totals.avg_pft, kind: 'number' }, { label: 'Average CFT', value: d.totals.avg_cft, kind: 'number' },
    ],
    sections, primary: t.detail ? 'counseling' : 'awards',
    notes: [sourceNote(ctx, t), 'Counselings are dated, never quoted.', ...(t.detail ? [] : [NO_DETAIL])],
  };
}

// ——— Personnel: the roster ———

const ACCOUNT_STATUS: Record<string, string> = { active: 'Active', locked: 'Locked', never_signed_in: 'Never signed in', must_change_password: 'Must change password', deactivated: 'Deactivated' };

function buildPersonnel(ctx: AppContext, user: SessionUser, scope: Scope, t: ReportTarget, q: ReportQuery): Built {
  const roster = personnelRoster(ctx, scope, user.id, t.unitId!);
  const status = q.status && PERSONNEL_STATUSES.some((s) => s.value === q.status) ? q.status : 'all';
  const rows = roster.rows.filter((r) => status === 'all' || (status === 'unsupervised' ? !r.supervisor : !r.checked_in_on));
  const withStatus = rows.some((r) => r.status);
  const columns: ReportColumn[] = [
    { key: 'name', label: 'Marine', width: 18 }, { key: 'mos', label: 'MOS', width: 6 }, { key: 'unit', label: 'Unit', width: 14 }, { key: 'billet', label: 'Billet', width: 14 },
    { key: 'supervisor', label: 'Supervisor', width: 16 }, { key: 'start', label: 'Assigned', kind: 'date', width: 9 }, { key: 'checked_in', label: 'Checked in', kind: 'date', width: 9 },
    { key: 'eas', label: 'EAS', kind: 'date', width: 9 }, { key: 'responsibilities', label: 'Responsibilities', width: 18 }, { key: 'roles', label: 'Roles', width: 14 },
    ...(withStatus ? [{ key: 'status', label: 'Account', width: 10 }] : []),
  ];
  const out = rows.map((r) => ({
    name: personName(r), mos: r.mos, unit: r.assignment.unit_short || r.assignment.unit_name, billet: r.assignment.billet, supervisor: r.supervisor ? personName(r.supervisor) : null,
    start: r.assignment.assignment_start, checked_in: r.checked_in_on, eas: r.eas, responsibilities: r.responsibilities.join('; ') || null, roles: r.roles.map((x) => x.name).join('; ') || null,
    status: r.status ? ACCOUNT_STATUS[r.status] || words(r.status) : null,
  }));
  const all = roster.rows;
  return {
    summary: [
      { label: 'On the roster', value: all.length, kind: 'number' }, { label: 'Supervisor named', value: all.filter((r) => r.supervisor).length, kind: 'number' },
      { label: 'No supervisor', value: all.filter((r) => !r.supervisor).length, kind: 'number' }, { label: 'No check-in date', value: all.filter((r) => !r.checked_in_on).length, kind: 'number' },
      { label: 'Holding a responsibility', value: all.filter((r) => r.responsibilities.length).length, kind: 'number' },
    ],
    sections: [{ id: 'roster', heading: 'Roster', tables: [table('roster', 'Personnel', columns, out, 'Nobody matches these filters.')] }],
    primary: 'roster',
    notes: ['Each Marine once, at their own team beneath the unit. Account status shows only for the Marines you manage.'],
    filters: status !== 'all' ? [{ label: 'Showing', value: PERSONNEL_STATUSES.find((s) => s.value === status)!.label }] : [],
  };
}

// ——— Workload: the team workload ———

function buildWorkload(ctx: AppContext, user: SessionUser, scope: Scope, t: ReportTarget, period: Period): Built {
  const tz = zoneOf(ctx, user);
  const w = teamWorkload(ctx, user, scope, t.unitId!, { from: period.from || '1970-01-01', to: period.to || zonedDay(tz), timezone: tz });
  const s = w.section;
  const stages = Object.entries(s.by_stage).map(([stage, n]) => ({ stage: STAGE_LABEL[stage as Stage] || words(stage), open: n })).sort((a, b) => b.open - a.open);
  const sections: ReportSection[] = [
    {
      id: 'stages', heading: 'Where the open work stands',
      chart: { title: 'Open work by stage', kind: 'number', bars: stages.map((x) => ({ label: x.stage || '', value: x.open })), table: 'stages' },
      tables: [
        table('stages', 'By stage', [{ key: 'stage', label: 'Stage', width: 20 }, { key: 'open', label: 'Open', kind: 'number', width: 8 }], stages, 'No open work.'),
        table('aging', 'By age', [{ key: 'age', label: 'Open for', width: 20 }, { key: 'open', label: 'Open', kind: 'number', width: 8 }], [
          { age: 'Under 7 days', open: s.aging.under_7_days }, { age: '7 to 30 days', open: s.aging.from_7_to_30_days }, { age: 'Over 30 days', open: s.aging.over_30_days },
        ], 'No open work.'),
        table('waiting', 'Waiting on', [{ key: 'on', label: 'Waiting on', width: 20 }, { key: 'count', label: 'Cases', kind: 'number', width: 8 }, { key: 'oldest', label: 'Longest (hours)', kind: 'number', width: 10 }],
          Object.entries(s.by_waiting).map(([on, v]) => ({ on: words(on), count: v.count, oldest: v.oldest_hours })), 'Nothing is waiting.'),
      ],
    },
    {
      id: 'procedures', heading: 'By procedure',
      tables: [table('procedures', 'By procedure', [
        { key: 'short', label: 'Procedure', width: 14 }, { key: 'title', label: 'What it is', width: 30 }, { key: 'open', label: 'Open', kind: 'number', width: 7 },
        { key: 'unassigned', label: 'Unassigned', kind: 'number', width: 8 }, { key: 'blocked', label: 'Blocked', kind: 'number', width: 7 }, { key: 'overdue', label: 'Overdue', kind: 'number', width: 7 },
      ], s.by_procedure.map((p) => ({ short: p.short, title: p.title, open: p.open, unassigned: p.unassigned, blocked: p.blocked, overdue: p.overdue })), 'No open work.')],
    },
  ];
  if (w.members_visible) {
    sections.push({
      id: 'members', heading: 'Marine by Marine', lede: `Held now, and what each recorded on shared work from ${formatDTG(w.window.from)} to ${formatDTG(w.window.to)}.`,
      tables: [table('members', 'Marine by Marine', [
        { key: 'name', label: 'Marine', width: 18 }, ...(w.rolls_up ? [{ key: 'team', label: 'Team', width: 12 }] : []),
        { key: 'assigned', label: 'Holding', kind: 'number', width: 7 }, { key: 'overdue', label: 'Overdue', kind: 'number', width: 7 }, { key: 'blocked', label: 'Blocked', kind: 'number', width: 7 },
        { key: 'researched', label: 'Researched', kind: 'number', width: 8 }, { key: 'submitted', label: 'Submitted', kind: 'number', width: 8 },
        { key: 'verified', label: 'Verified', kind: 'number', width: 7 }, { key: 'resolved', label: 'Resolved', kind: 'number', width: 7 }, { key: 'last', label: 'Last recorded', kind: 'date', width: 9 },
      ], w.members.map((m) => ({
        name: memberLabel(m), team: m.team, assigned: m.assigned, overdue: m.overdue, blocked: m.blocked,
        researched: m.documents_researched, submitted: m.submitted_actions, verified: m.verified_outcomes, resolved: m.resolved_work, last: day(m.last_recorded_at),
      })), 'No Marines in the unit.')],
    });
  }
  return {
    summary: [
      { label: 'Open', value: s.open, kind: 'number' }, { label: 'Unassigned', value: s.unassigned, kind: 'number' }, { label: 'Overdue', value: s.overdue, kind: 'number' },
      { label: 'Blocked', value: s.blocked, kind: 'number' }, { label: 'Waiting', value: s.waiting, kind: 'number' },
      { label: 'Resolved in the period', value: s.resolved, kind: 'number' }, { label: 'Documents researched', value: s.documents_researched, kind: 'number' },
    ],
    sections, primary: w.members_visible ? 'members' : 'procedures',
    notes: [sourceNote(ctx, t), ...w.limitations, ...(w.members_visible ? [] : [NO_DETAIL])],
  };
}

// ——— Duty: what is stood and how it is scored ———

const POLICY_STANDING = { in_force: 'In force', scheduled: 'Scheduled', superseded: 'Superseded', withdrawn: 'Withdrawn' } as const;

function buildDuty(ctx: AppContext, user: SessionUser, t: ReportTarget, q: ReportQuery): Built {
  const orgId = orgOfUnit(ctx, t.unitId);
  const asOf = asOfDay(ctx, user, q);
  const types = orgId ? listDutyTypes(ctx, orgId) : [];
  const policies = orgId ? listScoringPolicies(ctx, orgId) : [];
  const current = policyOn(policies, asOf);
  const typeIds = new Set(types.map((x) => x.id));
  const method = (key: string) => SCORING_METHODS.find((m) => m.key === key)?.label || words(key);
  const ruleFor = (id: string) => current?.rules.find((r) => r.duty_type_id === id) || null;
  const points = (r: NonNullable<ReturnType<typeof ruleFor>>) => (r.method === 'bands'
    ? (r.bands || []).map((b) => `${b.from_hours} h+: ${b.points}`).join('; ')
    : r.points == null ? null : String(r.points));
  const sections: ReportSection[] = [
    {
      id: 'types', heading: 'Duty the Unit Instance stands', lede: current ? `Scored under version ${current.version}, in force on ${formatDTG(asOf)}.` : `No scoring version is in force on ${formatDTG(asOf)}.`,
      tables: [table('types', 'Duty types', [
        { key: 'code', label: 'Code', width: 8 }, { key: 'name', label: 'Duty', width: 22 }, { key: 'description', label: 'Description', width: 28 },
        { key: 'in_use', label: 'In use', kind: 'flag', width: 6 }, { key: 'method', label: 'Scored', width: 10 }, { key: 'points', label: 'Points', width: 14 },
      ], types.map((x) => { const r = ruleFor(x.id); return { code: x.code, name: x.name, description: x.description, in_use: x.active ? 1 : 0, method: r ? method(r.method) : 'Not scored', points: r ? points(r) : null }; }), 'The Unit Instance has no duty types.')],
    },
  ];
  if (current) {
    const combine = SCORING_COMBINE.find((c) => c.key === current.combine)?.label || current.combine;
    sections.push({
      id: 'multipliers', heading: 'Conditions that raise the points', lede: `Where more than one applies: ${combine.toLowerCase()}.`,
      tables: [table('multipliers', 'Multipliers', [{ key: 'condition', label: 'Condition', width: 20 }, { key: 'factor', label: 'Multiplier', kind: 'number', width: 10 }],
        current.multipliers.map((m) => ({ condition: SCORING_CONDITIONS.find((c) => c.key === m.condition)?.label || words(m.condition), factor: m.factor })), 'No condition raises the points.')],
    });
  }
  sections.push({
    id: 'versions', heading: 'Every scoring version',
    tables: [table('versions', 'Scoring versions', [
      { key: 'version', label: 'Version', kind: 'number', width: 7 }, { key: 'from', label: 'Takes effect', kind: 'date', width: 10 }, { key: 'status', label: 'Standing', width: 11 },
      { key: 'scored', label: 'Duty types scored', kind: 'number', width: 9 }, { key: 'note', label: 'Why it changed', width: 30 }, { key: 'by', label: 'Published by', width: 14 },
    ], policies.map((p) => ({ version: p.version, from: p.effective_from, status: POLICY_STANDING[policyStatus(policies, p, asOf)], scored: p.rules.filter((r) => typeIds.has(r.duty_type_id)).length, note: p.note, by: p.created_by_name || null })), 'No scoring version has been published.')],
  });
  return {
    summary: [
      { label: 'Duty types in use', value: types.filter((x) => x.active).length, kind: 'number' }, { label: 'Scored', value: current ? current.rules.length : 0, kind: 'number' },
      { label: 'Version in force', value: current ? current.version : null, kind: 'number' }, { label: 'Since', value: current?.effective_from ?? null, kind: 'date' },
    ],
    sections, primary: 'types',
    notes: ['The Unit Instance sets its duty types and scoring; the unit and the units beneath it share them.', 'Duty records come with the duty roster. Until then this report shows what is stood and how it is scored, not who stood it.'],
    filters: [{ label: 'Standing on', value: formatDTG(asOf) }],
  };
}

// ——— Financial work: cases, by procedure ———

interface CaseRow {
  id: string; unit_id: string; title: string; reference: string | null; due_date: string | null; amount: number | null; state: string; stage: string | null;
  procedure_key: string | null; claimed_by: string | null; waiting_category: string | null; created_at: string; resolved_at: string | null;
  /** When it closed, resolved or not applicable; null while it is open. */
  closed_at: string | null;
}

const CASE_COLUMNS = 't.id, t.unit_id, t.title, t.reference, t.due_date, t.amount, t.state, t.stage, t.procedure_key, t.claimed_by, t.waiting_category, t.created_at, t.resolved_at';
/**
 * When a closed case closed. Only a resolution sets resolved_at; a case found not to apply is closed by its last stage
 * change into a closed stage, and failing that by its last change.
 */
const CLOSED_AT = `CASE WHEN t.resolved_at IS NOT NULL THEN t.resolved_at
  WHEN t.state IN ('resolved', 'not_applicable') OR t.stage IN ('resolved', 'not_applicable') THEN COALESCE((
    SELECT MAX(e.occurred_at) FROM work_events e WHERE e.work_item_id = t.id AND e.kind = 'stage_changed'
      AND CASE WHEN json_valid(e.body) THEN json_extract(e.body, '$.to') END IN ('resolved', 'not_applicable')), t.updated_at)
  END`;

function casesOf(ctx: AppContext, t: ReportTarget, q: ReportQuery, period?: Period | null): CaseRow[] {
  const where = [`t.unit_id IN (SELECT value FROM json_each(?))`, `t.visibility = 'unit'`, 't.deleted_at IS NULL'];
  const params: unknown[] = [JSON.stringify(t.unitIds)];
  if (q.procedure) { if (q.procedure === 'none') where.push('t.procedure_key IS NULL'); else { where.push('t.procedure_key = ?'); params.push(q.procedure); } }
  // Open on any day of the period: opened by its end and not closed, resolved or found not to apply, before its start.
  if (period?.to) { where.push('substr(t.created_at, 1, 10) <= ?'); params.push(period.to); }
  const closedBefore = period?.from ? ' WHERE c.closed_at IS NULL OR substr(c.closed_at, 1, 10) >= ?' : '';
  if (period?.from) params.push(period.from);
  return ctx.db.prepare(`SELECT * FROM (SELECT ${CASE_COLUMNS}, ${CLOSED_AT} AS closed_at FROM work_items t WHERE ${where.join(' AND ')}) c${closedBefore}
    ORDER BY c.due_date IS NULL, c.due_date, c.created_at LIMIT ${SCAN_LIMIT}`).all(...params) as CaseRow[];
}
const isClosed = (c: CaseRow) => ['resolved', 'not_applicable'].includes(stageOf(c as never));
const procedureOfCase = (c: CaseRow) => (c.procedure_key ? PROCEDURES[c.procedure_key] : null);
const procedureLabel = (c: CaseRow) => procedureOfCase(c)?.short || (c.procedure_key ? c.procedure_key : 'No procedure');
const ageOf = (c: CaseRow, at: number) => Math.max(0, Math.floor(((c.closed_at ? Date.parse(c.closed_at) : at) - Date.parse(c.created_at)) / DAY_MS));
const procedureFilter = (q: ReportQuery) => (q.procedure ? [{ label: 'Procedure', value: q.procedure === 'none' ? 'No procedure' : PROCEDURES[q.procedure]?.short || q.procedure }] : []);
const amountOf = (list: Array<{ amount: number | null }>) => r2(list.reduce((n, c) => n + (Number(c.amount) || 0), 0));

function buildFinancial(ctx: AppContext, user: SessionUser, t: ReportTarget, q: ReportQuery, period: Period): Built {
  const at = Date.now();
  const today = zonedDay(zoneOf(ctx, user));
  const from = period.from || '0000-01-01';
  const to = period.to || '9999-12-31';
  const live = casesOf(ctx, t, q, period);
  const open = casesOf(ctx, t, q).filter((c) => !isClosed(c));
  const opened = live.filter((c) => day(c.created_at)! >= from);
  const resolvedIn = live.filter((c) => stageOf(c as never) === 'resolved' && c.resolved_at && day(c.resolved_at)! <= to);
  const avg = (list: number[]) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);
  const median = (list: number[]) => { if (!list.length) return null; const s = [...list].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const overdue = (c: CaseRow) => Boolean(c.due_date && c.due_date < today);

  // The two reads return their own rows, so a case is known by its id: open now, in the period, or both, it counts once.
  const ids = (list: CaseRow[]) => new Set(list.map((c) => c.id));
  const [openIds, liveIds, openedIds, resolvedIds] = [ids(open), ids(live), ids(opened), ids(resolvedIn)];
  const every = new Map<string, CaseRow>();
  for (const c of [...live, ...open]) if (!every.has(c.id)) every.set(c.id, c);
  const groups = new Map<string, CaseRow[]>();
  for (const c of every.values()) addTo(groups, procedureLabel(c), c);
  const byProcedure = [...groups.entries()].map(([name, list]) => {
    const o = list.filter((c) => openIds.has(c.id));
    const r = list.filter((c) => resolvedIds.has(c.id));
    const inPeriod = list.filter((c) => liveIds.has(c.id));
    return {
      procedure: name, family: words(procedureOfCase(list[0])?.family ?? null), open: o.length, value: amountOf(o), overdue: o.filter(overdue).length,
      opened: list.filter((c) => openedIds.has(c.id)).length, resolved: r.length, rate: pct(r.length, inPeriod.length), days: avg(r.map((c) => ageOf(c, at))),
    };
  }).sort((a, b) => b.open - a.open || b.value - a.value);
  const bands: Array<[string, (d: number) => boolean]> = [['Under 7 days', (d) => d < 7], ['7 to 30 days', (d) => d >= 7 && d <= 30], ['31 to 90 days', (d) => d > 30 && d <= 90], ['Over 90 days', (d) => d > 90]];
  const aging = bands.map(([band, test]) => { const list = open.filter((c) => test(ageOf(c, at))); return { band, open: list.length, value: amountOf(list) }; });
  return {
    summary: [
      { label: 'Open now', value: open.length, kind: 'number' }, { label: 'Amount open', value: amountOf(open), kind: 'money' },
      { label: 'Overdue', value: open.filter(overdue).length, kind: 'number' }, { label: 'Unassigned', value: open.filter((c) => !c.claimed_by).length, kind: 'number' },
      { label: 'Opened in the period', value: opened.length, kind: 'number' }, { label: 'Resolved in the period', value: resolvedIn.length, kind: 'number' },
      { label: 'Resolution rate', value: pct(resolvedIn.length, live.length), kind: 'percent', hint: 'Resolved in the period, of the cases open in it' },
      { label: 'Median age open', value: median(open.map((c) => ageOf(c, at))), kind: 'number', hint: 'Days' },
      { label: 'Days to resolve', value: avg(resolvedIn.map((c) => ageOf(c, at))), kind: 'number', hint: 'Average, for those resolved in the period' },
      { label: 'Amount resolved', value: amountOf(resolvedIn), kind: 'money' },
    ],
    sections: [
      {
        id: 'procedures', heading: 'By procedure',
        chart: { title: 'Open cases by procedure', kind: 'number', bars: byProcedure.filter((p) => p.open).map((p) => ({ label: p.procedure, value: p.open })), table: 'procedures' },
        tables: [table('procedures', 'By procedure', [
          { key: 'procedure', label: 'Procedure', width: 14 }, { key: 'family', label: 'Kind', width: 12 }, { key: 'open', label: 'Open now', kind: 'number', width: 7 },
          { key: 'value', label: 'Amount open', kind: 'money', width: 11 }, { key: 'overdue', label: 'Overdue', kind: 'number', width: 7 }, { key: 'opened', label: 'Opened', kind: 'number', width: 7 },
          { key: 'resolved', label: 'Resolved', kind: 'number', width: 7 }, { key: 'rate', label: 'Resolution rate', kind: 'percent', width: 9 }, { key: 'days', label: 'Days to resolve', kind: 'number', width: 9 },
        ], byProcedure, 'No case was open in the period.')],
      },
      { id: 'aging', heading: 'How old the open cases are', tables: [table('aging', 'By age', [{ key: 'band', label: 'Open for', width: 16 }, { key: 'open', label: 'Open', kind: 'number', width: 8 }, { key: 'value', label: 'Amount', kind: 'money', width: 12 }], aging, 'No open cases.')] },
    ],
    primary: 'procedures',
    notes: [
      sourceNote(ctx, t),
      'Amounts are added as each case records them. A case does not say what kind of amount it holds, so read totals with the cases behind them.',
      'A case is in the period when it was open on any day of it. Open now, the amount open, overdue and age are as of today.',
    ],
    filters: procedureFilter(q),
  };
}

function buildErrors(ctx: AppContext, user: SessionUser, t: ReportTarget, q: ReportQuery): Built {
  const state = q.state && CASE_STATES.some((s) => s.value === q.state) ? q.state : 'open';
  const today = zonedDay(zoneOf(ctx, user));
  const at = Date.now();
  let cases = casesOf(ctx, t, q).filter((c) => state === 'all' || (state === 'open' ? !isClosed(c) : isClosed(c)));
  if (q.overdue === '1') cases = cases.filter((c) => !isClosed(c) && c.due_date && c.due_date < today);
  const names = namesOf(ctx, cases.map((c) => c.claimed_by));
  const units = new Map<string, string>();
  const teamOf = (id: string) => { if (!units.has(id)) units.set(id, unitLabel(ctx, id) || ''); return units.get(id)!; };
  const rows = cases.sort((a, b) => procedureLabel(a).localeCompare(procedureLabel(b)) || (a.due_date || '9999').localeCompare(b.due_date || '9999')).map((c) => ({
    procedure: procedureLabel(c), reference: c.reference, title: c.title, stage: STAGE_LABEL[stageOf(c as never)] || null, amount: c.amount == null ? null : Number(c.amount),
    holder: c.claimed_by ? names.get(c.claimed_by) || null : 'Unassigned', team: t.unitIds.length > 1 ? teamOf(c.unit_id) : null, due: c.due_date, age: ageOf(c, at),
    waiting: words(c.waiting_category), overdue: !isClosed(c) && c.due_date && c.due_date < today ? 1 : 0,
  }));
  const groups = new Map<string, typeof rows>();
  for (const r of rows) addTo(groups, r.procedure, r);
  const byType = [...groups.entries()].map(([procedure, list]) => ({
    procedure, cases: list.length, amount: amountOf(list), overdue: list.filter((r) => r.overdue).length,
    unassigned: list.filter((r) => r.holder === 'Unassigned').length, oldest: Math.max(...list.map((r) => r.age)),
  })).sort((a, b) => b.cases - a.cases);
  return {
    summary: [
      { label: 'Cases', value: rows.length, kind: 'number' }, { label: 'Amount', value: amountOf(rows), kind: 'money' },
      { label: 'Overdue', value: rows.filter((r) => r.overdue).length, kind: 'number' }, { label: 'Unassigned', value: rows.filter((r) => r.holder === 'Unassigned').length, kind: 'number' },
      { label: 'Error types', value: byType.length, kind: 'number' },
    ],
    sections: [
      {
        id: 'types', heading: 'By error type',
        tables: [table('types', 'By error type', [
          { key: 'procedure', label: 'Error type', width: 16 }, { key: 'cases', label: 'Cases', kind: 'number', width: 7 }, { key: 'amount', label: 'Amount', kind: 'money', width: 12 },
          { key: 'overdue', label: 'Overdue', kind: 'number', width: 7 }, { key: 'unassigned', label: 'Unassigned', kind: 'number', width: 8 }, { key: 'oldest', label: 'Oldest (days)', kind: 'number', width: 8 },
        ], byType, 'No cases match these filters.')],
      },
      {
        id: 'cases', heading: 'Every case',
        tables: [table('cases', 'Cases', [
          { key: 'procedure', label: 'Error type', width: 11 }, { key: 'reference', label: 'Reference', width: 12 }, { key: 'title', label: 'Case', width: 24 },
          { key: 'stage', label: 'Stage', width: 11 }, { key: 'amount', label: 'Amount', kind: 'money', width: 10 }, { key: 'holder', label: 'Held by', width: 14 },
          ...(t.unitIds.length > 1 ? [{ key: 'team', label: 'Team', width: 10 }] : []),
          { key: 'due', label: 'Due', kind: 'date', width: 9 }, { key: 'age', label: 'Age (days)', kind: 'number', width: 7 }, { key: 'waiting', label: 'Waiting on', width: 10 },
          { key: 'overdue', label: 'Overdue', kind: 'flag', width: 7 },
        ], rows, 'No cases match these filters.', { total: rows.length })],
      },
    ],
    primary: 'cases',
    notes: [sourceNote(ctx, t), 'A case’s error type is the procedure it follows. Age runs from when the case was opened to when it was closed, or to now.'],
    filters: [
      { label: 'Cases', value: CASE_STATES.find((s) => s.value === state)!.label }, ...procedureFilter(q),
      ...(q.overdue === '1' ? [{ label: 'Overdue', value: 'Only overdue cases' }] : []),
    ],
  };
}

// ——— Custom: a dataset, its columns, its grouping and its order ———

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthOf = (d: Cell) => (typeof d === 'string' && /^\d{4}-\d{2}/.test(d) ? `${MONTH_NAMES[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` : 'Undated');
const monthOrder = (g: string) => { if (g === 'Undated') return '0'; const [m, y] = g.split(' '); return `${y}-${String(MONTH_NAMES.indexOf(m) + 1).padStart(2, '0')}`; };

/** The key a row's own flag sits under when its value is of a type that is listed but never added up. */
const COUNTS = '__counts';
/** A row's measure as a total adds it: a value of a type that is not added up adds nothing. */
const measureOf = (r: Record<string, Cell>, m: string) => (m === 'dollar_amount' && r[COUNTS] === 0 ? 0 : Number(r[m]) || 0);

function customRows(ctx: AppContext, t: ReportTarget, dataset: string, q: ReportQuery, period: Period | null): { rows: Array<Record<string, Cell>>; read: number } {
  const cfg = ctx.runtime.metrics;
  if (dataset === 'work') {
    const cases = casesOf(ctx, t, { ...q, procedure: undefined }, period);
    const names = namesOf(ctx, cases.map((c) => c.claimed_by));
    const at = Date.now();
    return {
      read: cases.length,
      rows: cases.map((c) => ({
        reference: c.reference, title: c.title, procedure: procedureLabel(c), stage: STAGE_LABEL[stageOf(c as never)] || null, amount: c.amount == null ? null : Number(c.amount),
        holder: c.claimed_by ? names.get(c.claimed_by) || null : 'Unassigned', due_date: c.due_date, opened: day(c.created_at), age_days: ageOf(c, at), resolved_on: day(c.resolved_at),
      })),
    };
  }
  const own = ownership(t, dataset);
  const where = [own.sql, 't.deleted_at IS NULL'];
  const params: unknown[] = [...own.params];
  if (dataset === 'activities' || dataset === 'trainings' || dataset === 'awards' || dataset === 'goals') {
    const span = periodClause(dataset, 't', period?.from, period?.to);
    where.push(span.sql); params.push(...span.params);
  } else {
    // A task is in a period by its due date, a counseling by its date, as the record lists have them.
    const col = dataset === 'tasks' ? 'due_date' : 'date';
    if (period?.from) { where.push(`t.${col} >= ?`); params.push(period.from); }
    if (period?.to) { where.push(`t.${col} <= ?`); params.push(period.to); }
  }
  const table = { activities: 'activities', trainings: 'trainings', awards: 'awards', counselings: 'counselings', goals: 'goals', tasks: 'tasks' }[dataset]!;
  let rows = ctx.db.prepare(`SELECT t.* FROM ${table} t WHERE ${where.join(' AND ')} LIMIT ${SCAN_LIMIT}`).all(...params) as Array<Record<string, unknown>>;
  if (table === 'goals') rows = withGoalProgress(ctx, rows);
  const names = namesOf(ctx, rows.flatMap((r) => [r.user_id as string, r.assignee_id as string, r.counselor_id as string]));
  const owner = (r: Record<string, unknown>) => names.get(r.user_id as string) || null;
  const s = (v: unknown) => (v == null || v === '' ? null : String(v));
  const n = (v: unknown) => (v == null || v === '' ? null : Number(v));
  const map: Record<string, (r: Record<string, unknown>) => Record<string, Cell>> = {
    activities: (r) => ({
      date: day(r.date as string), end_date: day(r.end_date as string), owner: owner(r), title: s(r.title), category: s(r.category), eval_area: s(r.eval_area),
      quantity: n(r.quantity), unit_label: s(r.unit_label), dollar_amount: n(r.dollar_amount), dollar_type: r.dollar_type ? valueType(r.dollar_type as string, cfg)?.label || s(r.dollar_type) : null,
      result: s(r.result), organization: s(r.organization), system: s(r.system), status: words(s(r.status)), visibility: r.visibility === 'unit' ? 'Unit' : 'Private',
      // Whether its value counts toward a total, as the activity report counts it; never a column of its own.
      [COUNTS]: isSummable(r.dollar_type as string | null, cfg) ? 1 : 0,
    }),
    trainings: (r) => ({ date: day(r.date as string), end_date: day(r.end_date as string), owner: owner(r), title: s(r.title), type: words(s(r.type)), hours: n(r.hours), provider: s(r.provider), status: words(s(r.status)) }),
    awards: (r) => ({ date: day(r.date as string), period_start: day(r.period_start as string), owner: owner(r), name: s(r.name), type: words(s(r.type)), status: words(s(r.status)), recommending_official: s(r.recommending_official), approving_authority: s(r.approving_authority) }),
    // The dates and the people, never what was said.
    counselings: (r) => ({ date: day(r.date as string), owner: owner(r), type: words(s(r.type)), counselor: s(r.counselor_name) || names.get(r.counselor_id as string) || null, follow_up_date: day(r.follow_up_date as string), acknowledged: r.acknowledged_at ? 1 : 0 }),
    goals: (r) => ({ title: s(r.title), owner: owner(r), category: s(r.category), status: words(s(r.status)), current_value: n(r.current_value), target_value: n(r.target_value), unit_label: s(r.unit_label), period_start: day(r.period_start as string), period_end: day(r.period_end as string) }),
    tasks: (r) => ({ title: s(r.title), owner: owner(r), assignee: names.get((r.assignee_id || r.user_id) as string) || null, status: words(s(r.status)), priority: words(s(r.priority)), due_date: day(r.due_date as string) }),
  };
  return { read: rows.length, rows: rows.map(map[table]) };
}

function buildCustom(ctx: AppContext, t: ReportTarget, q: ReportQuery, period: Period | null): Built {
  const key = q.dataset && Object.prototype.hasOwnProperty.call(CUSTOM_DATASETS, q.dataset) ? q.dataset : 'activities';
  const ds = CUSTOM_DATASETS[key];
  if (ds.unitOnly && t.subject !== 'unit') throw badRequest(`${ds.label} belong to a unit. Run this report for a unit.`, { fieldErrors: { dataset: 'For a unit.' } });
  // Counselings by Marine across a unit read like their member pages: opening member records.
  if (key === 'counselings' && t.subject === 'unit' && !t.detail) throw forbidden('Counselings across a unit need opening member records in it.');
  const asked = (q.columns || '').split(',').map((c) => c.trim()).filter((c) => ds.columns.some((x) => x.key === c));
  // The Marine column says nothing on a report about one Marine, unless it is asked for.
  const picked = [...new Set(asked.length ? asked : ds.defaults.filter((c) => c !== 'owner' || t.subject === 'unit'))];
  const columns = picked.map((c) => ds.columns.find((x) => x.key === c)!);
  const { rows, read } = customRows(ctx, t, key, q, period);
  const sortKey = q.sort && ds.sorts.includes(q.sort) ? q.sort : ds.sorts[0];
  const dir = q.direction === 'asc' ? 1 : q.direction === 'desc' ? -1 : ds.columns.find((c) => c.key === sortKey)?.kind === 'date' ? -1 : 1;
  rows.sort((a, b) => {
    const x = a[sortKey]; const y = b[sortKey];
    if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
  });
  const group = q.group && ds.groups.includes(q.group) ? q.group : null;
  const label = (k: string) => (k === 'month' ? 'Month' : ds.columns.find((c) => c.key === k)?.label || k);
  const sections: ReportSection[] = [];
  if (group) {
    const by = new Map<string, Array<Record<string, Cell>>>();
    const dateCol = ds.columns.find((c) => c.kind === 'date')?.key;
    for (const r of rows) {
      const g = group === 'month' ? monthOf(dateCol ? r[dateCol] : null) : r[group] == null || r[group] === '' ? 'None' : String(r[group]);
      addTo(by, g, r);
    }
    const groups: Array<Record<string, Cell>> = [...by.entries()].map(([g, list]) => ({
      group: g, count: list.length, ...Object.fromEntries(ds.measures.map((m) => [m, r2(list.reduce((sum, r) => sum + measureOf(r, m), 0))])),
    }));
    if (group === 'month') groups.sort((a, b) => monthOrder(String(b.group)).localeCompare(monthOrder(String(a.group))));
    else groups.sort((a, b) => Number(b.count) - Number(a.count));
    const measures: ReportColumn[] = ds.measures.map((m) => ds.columns.find((c) => c.key === m)!).map((c) => ({ key: c.key, label: `${c.label}, total`, kind: c.kind, width: 10 }));
    const by_label = label(group).toLowerCase();
    sections.push({
      id: 'groups', heading: `By ${by_label}`,
      chart: { title: `${ds.label} by ${by_label}`, kind: 'number', bars: groups.slice(0, 30).map((g) => ({ label: String(g.group), value: Number(g.count) })), table: 'groups' },
      tables: [table('groups', `By ${by_label}`, [{ key: 'group', label: label(group), width: 22 }, { key: 'count', label: 'Records', kind: 'number', width: 8 }, ...measures], groups, 'Nothing matches.')],
    });
  }
  sections.push({ id: 'rows', heading: ds.label, tables: [table('rows', ds.label, columns, rows.map((r) => Object.fromEntries(picked.map((c) => [c, r[c] ?? null]))), 'Nothing matches these choices.', { total: rows.length })] });
  const totals: ReportFigure[] = ds.measures.filter((m) => picked.includes(m)).map((m) => {
    const c = ds.columns.find((x) => x.key === m)!;
    return { label: `${c.label}, total`, value: r2(rows.reduce((sum, r) => sum + measureOf(r, m), 0)), kind: c.kind, ...(key === 'activities' && m === 'dollar_amount' ? { hint: 'Value types that count toward the total' } : {}) };
  });
  return {
    summary: [{ label: ds.label, value: rows.length, kind: 'number' }, ...totals],
    sections, primary: 'rows',
    notes: [
      sourceNote(ctx, t),
      ...(key === 'tasks' ? ['A task is in the period by its due date; one with no due date is left out of a dated period.'] : []),
      ...(key === 'counselings' ? ['Counselings are dated, never quoted.'] : []),
      ...(key === 'work' ? ['A case is in the period when it was open on any day of it.'] : []),
      ...(read >= SCAN_LIMIT ? [`Only the first ${SCAN_LIMIT.toLocaleString('en-US')} records were read. Narrow the period to see the rest.`] : []),
    ],
    filters: [
      { label: 'Records', value: ds.label }, { label: 'Columns', value: columns.map((c) => c.label).join(', ') },
      ...(group ? [{ label: 'Grouped by', value: label(group) }] : []),
      { label: 'Sorted by', value: `${label(sortKey)}, ${dir > 0 ? 'ascending' : 'descending'}` },
    ],
  };
}

// ——— The document ———

function aboutLine(ctx: AppContext, t: ReportTarget): string {
  if (t.subject === 'unit') {
    const beneath = t.unitIds.length - 1;
    return `${unitLabel(ctx, t.unitId) || 'Unit'}${beneath ? ` and ${beneath} unit${beneath === 1 ? '' : 's'} beneath it` : ''}`;
  }
  return namesOf(ctx, [t.userId]).get(t.userId!) || 'Marine';
}

const ROLLING_PERIODS = ['last30', 'last90', 'last12'];

export function buildReportDocument(ctx: AppContext, user: SessionUser, scope: Scope, q: ReportQuery, t: ReportTarget): ReportDocument {
  const spec = REPORT_SPECS[q.type];
  const period = periodOf(ctx, q);
  const dated = () => period ?? { from: null, to: null, label: 'All time' };
  const built: Built = (() => {
    switch (q.type) {
      case 'individual': return buildIndividual(ctx, t, q);
      case 'activity': return buildActivity(ctx, t, q, period);
      case 'training': return buildTraining(ctx, user, t, q, period);
      case 'unit': return buildUnit(ctx, t, dated());
      case 'leadership': return buildLeadership(ctx, user, t, dated());
      case 'personnel': return buildPersonnel(ctx, user, scope, t, q);
      case 'workload': return buildWorkload(ctx, user, scope, t, dated());
      case 'duty': return buildDuty(ctx, user, t, q);
      case 'financial': return buildFinancial(ctx, user, t, q, dated());
      case 'errors': return buildErrors(ctx, user, t, q);
      case 'custom': return buildCustom(ctx, t, q, period);
    }
  })();
  const docPeriod = built.period !== undefined ? built.period : period;
  const today = zonedDay(zoneOf(ctx, user));
  // A rolling window is read through tomorrow (shared/metrics.ts), so work dated a day ahead east of the server counts;
  // on paper it ends today, as its name says.
  const rolling = !(q.from && q.to) && ROLLING_PERIODS.includes(q.period || spec.period || '');
  const shownTo = docPeriod?.to && rolling && docPeriod.to > today ? today : docPeriod?.to ?? null;
  return {
    format: REPORT_FORMAT, type: q.type, title: spec.title, about: aboutLine(ctx, t),
    unit: unitLabel(ctx, t.subject === 'self' ? scope.primaryUnitId : t.unitId),
    period: docPeriod ? { from: docPeriod.from, to: shownTo, label: docPeriod.label } : null,
    generated: { at: now(), on: today, by: namesOf(ctx, [user.id]).get(user.id) || user.username },
    filters: [...(docPeriod ? [{ label: 'Period', value: docPeriod.label }] : []), ...(built.filters || [])],
    marking: ctx.runtime.reportMarking || DEFAULT_REPORT_MARKING,
    currency: ctx.runtime.metrics.currency_symbol,
    summary: built.summary, sections: built.sections, notes: built.notes, primary: built.primary,
  };
}

const auditDetail = (doc: ReportDocument, format?: string) => {
  const rows = primaryTable(doc)?.total ?? 0;
  return [doc.type, format, doc.period?.label, `${rows} row${rows === 1 ? '' : 's'}`].filter(Boolean).join('; ');
};

/** A report on screen or on the print page. Reading someone else's, or a unit's, and every print, is audited. */
export function runReport(ctx: AppContext, user: SessionUser, scope: Scope, q: ReportQuery, purpose: Purpose, ip?: string): ReportDocument & { files: ReportFileFormat[] } {
  const t = resolveTarget(ctx, user, scope, q);
  const doc = buildReportDocument(ctx, user, scope, q, t);
  const printing = purpose === 'print';
  if (printing || t.subject !== 'self') {
    audit(ctx, {
      actor_id: user.id, action: printing ? 'print_report' : 'view_report', entity: 'report', entity_id: q.type,
      subject_id: t.subject === 'member' ? t.userId : null, unit_id: t.unitId, detail: auditDetail(doc), ip,
    });
  }
  return { ...doc, files: t.files };
}

export interface ReportFile { body: Buffer | string; contentType: string; filename: string }

/** A report as a file. Whether the reader may take it away is decided before anything is read. */
export async function exportReport(ctx: AppContext, user: SessionUser, scope: Scope, q: ReportQuery, format: ReportFileFormat, ip?: string): Promise<ReportFile> {
  const t = resolveTarget(ctx, user, scope, q);
  if (!t.files.includes(format)) {
    throw forbidden(t.subject === 'member'
      ? 'Taking another Marine’s records away as a spreadsheet or data file needs the unit’s export permission. The PDF is yours to download.'
      : 'Downloading a unit’s report needs the unit’s export permission. You may view and print it.');
  }
  const doc = buildReportDocument(ctx, user, scope, q, t);
  const file = await renderFile(doc, format);
  audit(ctx, {
    actor_id: user.id, action: 'export_report', entity: 'report', entity_id: q.type,
    subject_id: t.subject === 'member' ? t.userId : null, unit_id: t.unitId, detail: auditDetail(doc, format.toUpperCase()), ip,
  });
  return file;
}

/** One document drawn into a file: the PDF layout, the main table as CSV, every table in a workbook, or the document itself. */
export async function renderFile(doc: ReportDocument, format: ReportFileFormat): Promise<ReportFile> {
  if (format === 'pdf') return { body: await renderReportDocumentPdf(doc), contentType: 'application/pdf', filename: reportFileName(doc, 'pdf') };
  if (format === 'json') return { body: JSON.stringify(doc, null, 2), contentType: 'application/json; charset=utf-8', filename: reportFileName(doc, 'json') };
  if (format === 'csv') {
    const main = primaryTable(doc);
    const [header, ...rest] = main ? tableMatrix(main) : [['No data']];
    const heads = header.map(String);
    const csv = rowsToCsv(rest.map((r) => Object.fromEntries(heads.map((h, i) => [h, r[i]]))), heads);
    return { body: `\uFEFF${csv}`, contentType: 'text/csv; charset=utf-8', filename: reportFileName(doc, 'csv') };
  }
  // The workbook: an About sheet saying what it is and under what handling, then every table on a sheet of its own.
  const about: SheetOut = {
    name: 'About',
    rows: [
      [doc.title], [doc.marking], [],
      ['About', doc.about], ['Unit', doc.unit ?? ''], ['Period', doc.period?.label ?? 'Not dated'],
      ['Generated', `${doc.generated.on} by ${doc.generated.by}`], ...doc.filters.map((f) => [f.label, f.value]), [],
      ...doc.summary.map((f) => [f.label, f.value]), [],
      ...doc.notes.map((n) => [n]),
    ],
  };
  const sheets = allTables(doc).map((tbl) => ({ name: tbl.title, rows: tableMatrix(tbl) }));
  return { body: writeWorkbook([about, ...sheets]), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: reportFileName(doc, 'xlsx') };
}

// ——— Saved reports: a report's choices kept to run again, never its data ———

export const DEFINITION_LIMIT = 100;

export interface ReportDefinition {
  id: string; user_id: string; unit_id: string | null; visibility: 'private' | 'unit'; name: string; type: ReportType;
  params: Partial<ReportQuery>; created_at: string; updated_at: string; mine: boolean; owner_name: string | null;
}

interface DefinitionRow { id: string; user_id: string; unit_id: string | null; visibility: 'private' | 'unit'; name: string; type: string; params: string; created_at: string; updated_at: string }

function toDefinitions(ctx: AppContext, userId: string, rows: DefinitionRow[]): ReportDefinition[] {
  const names = namesOf(ctx, rows.map((r) => r.user_id));
  return rows.filter((r) => (REPORT_TYPES as readonly string[]).includes(r.type)).map((r) => {
    let params: Partial<ReportQuery> = {};
    try { params = JSON.parse(r.params || '{}'); } catch { /* choices that cannot be read run with none */ }
    return { ...r, type: r.type as ReportType, params, mine: r.user_id === userId, owner_name: names.get(r.user_id) || null };
  });
}

/** One's own saved reports, and those shared with a unit one belongs to. */
export function listDefinitions(ctx: AppContext, user: SessionUser, scope: Scope): ReportDefinition[] {
  const rows = ctx.db.prepare(`SELECT * FROM report_definitions WHERE user_id = ? OR (visibility = 'unit' AND unit_id IN (SELECT value FROM json_each(?))) ORDER BY name COLLATE NOCASE`)
    .all(user.id, JSON.stringify(scope.unitIds)) as DefinitionRow[];
  return toDefinitions(ctx, user.id, rows);
}

export interface DefinitionInput { name: string; type: ReportType; params: Record<string, unknown>; visibility?: 'private' | 'unit'; unit_id?: string | null }

/**
 * Keep a report's choices under a name. Its filters are checked as a run checks them; nobody's records are kept. Shared
 * with a unit it names no Marine: whoever runs it runs it about themselves, a Marine they choose, or the unit, and only
 * with the authority they hold.
 */
export function saveDefinition(ctx: AppContext, user: SessionUser, scope: Scope, input: DefinitionInput, id?: string, ip?: string): ReportDefinition {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw badRequest('Give the report a name.', { fieldErrors: { name: 'Required.' } });
  const visibility = input.visibility === 'unit' ? 'unit' : 'private';
  // A private one is shared with no unit, so it keeps none: only a unit it is shared with is checked and kept.
  const unitId = visibility === 'unit' ? input.unit_id || null : null;
  if (visibility === 'unit') {
    if (!unitId) throw badRequest('Choose the unit to share it with.', { fieldErrors: { unit_id: 'Required.' } });
    if (!scope.unitIds.includes(unitId) || !can(scope, PERMISSIONS.VIEW_RECORDS, unitId)) throw forbidden('You can share a report only with a unit you belong to and whose shared records you view.');
  }
  const kept = Object.fromEntries(Object.entries(input.params || {})
    .filter(([k, v]) => (REPORT_PARAM_KEYS as readonly string[]).includes(k) && v != null && v !== '' && !(visibility === 'unit' && k === 'user_id')));
  const checked = reportQuerySchema.safeParse({ ...kept, type: input.type });
  if (!checked.success) throw badRequest('Those report choices are not ones Vantage runs.', { fieldErrors: { params: checked.error.issues[0]?.message || 'Invalid.' } });
  const params = JSON.stringify(Object.fromEntries(Object.entries(checked.data).filter(([k, v]) => k !== 'type' && v !== undefined)));
  if (params.length > 4000) throw badRequest('Those report choices are too long to keep.');
  const at = now();
  const key = ctx.db.transaction(() => {
    if (id) {
      const existing = ctx.db.prepare('SELECT * FROM report_definitions WHERE id = ?').get(id) as DefinitionRow | undefined;
      if (!existing) throw notFound('No such saved report.');
      if (existing.user_id !== user.id) throw forbidden('That saved report is someone else’s.');
      ctx.db.prepare('UPDATE report_definitions SET name = ?, type = ?, params = ?, visibility = ?, unit_id = ?, updated_at = ? WHERE id = ?').run(name, input.type, params, visibility, unitId, at, id);
      return id;
    }
    const count = (ctx.db.prepare('SELECT COUNT(*) AS n FROM report_definitions WHERE user_id = ?').get(user.id) as { n: number }).n;
    if (count >= DEFINITION_LIMIT) throw badRequest(`Keep up to ${DEFINITION_LIMIT} saved reports. Remove one you no longer run.`);
    const created = newId();
    ctx.db.prepare('INSERT INTO report_definitions (id, user_id, unit_id, visibility, name, type, params, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(created, user.id, unitId, visibility, name, input.type, params, at, at);
    return created;
  })();
  audit(ctx, { actor_id: user.id, action: 'report_definition_saved', entity: 'report_definitions', entity_id: key, unit_id: visibility === 'unit' ? unitId : null, detail: `${input.type}; ${visibility}${id ? '; changed' : ''}`, ip });
  return toDefinitions(ctx, user.id, [ctx.db.prepare('SELECT * FROM report_definitions WHERE id = ?').get(key) as DefinitionRow])[0];
}

export function deleteDefinition(ctx: AppContext, user: SessionUser, id: string, ip?: string) {
  const existing = ctx.db.prepare('SELECT * FROM report_definitions WHERE id = ?').get(id) as DefinitionRow | undefined;
  if (!existing) throw notFound('No such saved report.');
  if (existing.user_id !== user.id) throw forbidden('That saved report is someone else’s.');
  ctx.db.prepare('DELETE FROM report_definitions WHERE id = ?').run(id);
  audit(ctx, { actor_id: user.id, action: 'report_definition_deleted', entity: 'report_definitions', entity_id: id, unit_id: existing.visibility === 'unit' ? existing.unit_id : null, detail: existing.type, ip });
}
