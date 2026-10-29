import { z } from 'zod';
import { PERIOD_OPTIONS, formatDollarsExact, formatNumber, type PeriodKey } from './metrics.ts';

/**
 * The reports Vantage prints and files (Task 14, ADR-0020): what each answers, whom it may be about, the filters it
 * takes and the formats it comes in, and the one document every format is drawn from. The screen, the print page, the
 * PDF, the CSV, the workbook and the JSON all read a ReportDocument, so they never say different things.
 */

export const REPORT_FORMAT = 'vantage-report/1';

export const REPORT_TYPES = ['individual', 'unit', 'personnel', 'duty', 'training', 'financial', 'errors', 'workload', 'activity', 'leadership', 'custom'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const isReportType = (v: unknown): v is ReportType => (REPORT_TYPES as readonly unknown[]).includes(v);

/** Who a report is about: the person running it, one Marine they lead, or a unit and the units beneath it. */
export const REPORT_SUBJECTS = ['self', 'member', 'unit'] as const;
export type ReportSubject = (typeof REPORT_SUBJECTS)[number];

export const REPORT_FILE_FORMATS = ['pdf', 'csv', 'xlsx', 'json'] as const;
export type ReportFileFormat = (typeof REPORT_FILE_FORMATS)[number];

export type ReportFilterKey = 'period' | 'track' | 'status' | 'kind' | 'category' | 'area' | 'procedure' | 'state' | 'overdue' | 'as_of' | 'dataset' | 'columns' | 'group' | 'sort';

export interface ReportSpec {
  key: ReportType;
  title: string;
  /** The question it answers, in a line: the library shows it under the title. */
  question: string;
  group: 'Your record' | 'Your unit' | 'Financial work' | 'Build your own';
  /** Whom it may be about, the first being where it starts. */
  subjects: readonly ReportSubject[];
  filters: readonly ReportFilterKey[];
  /** The period it starts on, where it has one: the page it is drawn from starts on the same. */
  period: PeriodKey | null;
  /** Who may run it, in plain words, for the library and the refusal. */
  needs: string;
}

export const REPORT_SPECS: Record<ReportType, ReportSpec> = {
  individual: {
    key: 'individual', title: 'Individual performance', group: 'Your record', subjects: ['self', 'member'], filters: ['period', 'track'], period: 'last12',
    question: 'What a Marine’s record shows for the period, against the period before.',
    needs: 'Your own record, or a Marine whose record you may open in a unit you lead.',
  },
  activity: {
    key: 'activity', title: 'Activity', group: 'Your record', subjects: ['self', 'member', 'unit'], filters: ['period', 'category', 'area'], period: 'last90',
    question: 'Every activity logged in the period, with what it produced.',
    needs: 'Your own activities, a Marine’s shared with a unit you lead, or a unit’s shared activities.',
  },
  training: {
    key: 'training', title: 'Training', group: 'Your record', subjects: ['self', 'member', 'unit'], filters: ['period', 'kind', 'status', 'as_of'], period: 'last12',
    question: 'Training completed, and where each Marine stands against the unit’s training requirements.',
    needs: 'Your own training, a Marine’s shared with a unit you lead, or a unit whose shared records you may view.',
  },
  unit: {
    key: 'unit', title: 'Unit performance', group: 'Your unit', subjects: ['unit'], filters: ['period'], period: 'last90',
    question: 'What the unit’s shared work produced in the period, week by week and team by team.',
    needs: 'Viewing the unit’s shared records. Figures by Marine need opening member records.',
  },
  leadership: {
    key: 'leadership', title: 'Leadership', group: 'Your unit', subjects: ['unit'], filters: ['period'], period: 'last90',
    question: 'What needs a leader: counseling due, awards in progress, overdue tasks, readiness not reported.',
    needs: 'Viewing the unit’s shared records. The list by Marine needs opening member records.',
  },
  personnel: {
    key: 'personnel', title: 'Personnel', group: 'Your unit', subjects: ['unit'], filters: ['status'], period: null,
    question: 'Who is in the unit: assignment, billet, supervisor, responsibilities and roles.',
    needs: 'Viewing the unit’s shared records, or managing its members.',
  },
  workload: {
    key: 'workload', title: 'Workload', group: 'Your unit', subjects: ['unit'], filters: ['period'], period: 'last30',
    question: 'Who holds what work, how old it is, and what each Marine did on it in the period.',
    needs: 'Viewing the unit’s shared records. Figures by Marine need opening member records.',
  },
  duty: {
    key: 'duty', title: 'Duty', group: 'Your unit', subjects: ['unit'], filters: ['as_of'], period: null,
    question: 'The duty the Unit Instance stands, and how duty is scored on a given day.',
    needs: 'Viewing the unit’s shared records.',
  },
  financial: {
    key: 'financial', title: 'Financial KPI', group: 'Financial work', subjects: ['unit'], filters: ['period', 'procedure'], period: 'last90',
    question: 'How the unit’s financial cases stand: open, value, age, resolved and resolution rate, by procedure.',
    needs: 'Viewing the unit’s shared records.',
  },
  errors: {
    key: 'errors', title: 'Error report', group: 'Financial work', subjects: ['unit'], filters: ['procedure', 'state', 'overdue'], period: null,
    question: 'Each financial case by error type: reference, amount, age, stage, who holds it and when it is due.',
    needs: 'Viewing the unit’s shared records.',
  },
  custom: {
    key: 'custom', title: 'Custom', group: 'Build your own', subjects: ['self', 'member', 'unit'], filters: ['dataset', 'columns', 'period', 'group', 'sort'], period: 'last90',
    question: 'The records you choose, with the columns, grouping and order you choose.',
    needs: 'The records you could open anyway: yours, a Marine’s you lead, or a unit’s shared records.',
  },
};

export const REPORT_GROUPS = ['Your record', 'Your unit', 'Financial work', 'Build your own'] as const;

/** Training against a requirement: met, met but due again soon, past due, or no record of it shared with the unit. */
export const TRAINING_STATUSES = [
  { value: 'all', label: 'Every requirement' },
  { value: 'overdue', label: 'Past due' },
  { value: 'due_soon', label: 'Due within 60 days' },
  { value: 'met', label: 'Met' },
  { value: 'missing', label: 'No record' },
] as const;
export const DUE_SOON_DAYS = 60;

export const PERSONNEL_STATUSES = [
  { value: 'all', label: 'Everyone on the roster' },
  { value: 'unsupervised', label: 'No supervisor named' },
  { value: 'not_checked_in', label: 'No check-in date' },
] as const;

export const CASE_STATES = [
  { value: 'open', label: 'Open cases' },
  { value: 'all', label: 'Every case' },
  { value: 'resolved', label: 'Resolved and not applicable' },
] as const;

// ——— Custom reports: a dataset, its columns, how it groups and sorts ———

export type ColumnKind = 'text' | 'number' | 'money' | 'date' | 'hours' | 'percent' | 'flag';

export interface ReportColumn { key: string; label: string; kind?: ColumnKind; /** Relative width in a printed table. */ width?: number }

export interface CustomDataset {
  key: string; label: string;
  /** Unit scope only: cases live in a unit's queue. */
  unitOnly?: boolean;
  columns: readonly ReportColumn[];
  defaults: readonly string[];
  /** Columns a report may group by; month groups a dated row by its first month. */
  groups: readonly string[];
  /** The numeric columns a group adds up. */
  measures: readonly string[];
  sorts: readonly string[];
}

const owner: ReportColumn = { key: 'owner', label: 'Marine', width: 16 };

export const CUSTOM_DATASETS: Record<string, CustomDataset> = {
  activities: {
    key: 'activities', label: 'Activities',
    columns: [
      { key: 'date', label: 'Date', kind: 'date', width: 9 }, { key: 'end_date', label: 'End date', kind: 'date', width: 9 }, owner,
      { key: 'title', label: 'Activity', width: 28 }, { key: 'category', label: 'Category', width: 12 }, { key: 'eval_area', label: 'Area', width: 12 },
      { key: 'quantity', label: 'Count', kind: 'number', width: 7 }, { key: 'unit_label', label: 'Of', width: 8 },
      { key: 'dollar_amount', label: 'Value', kind: 'money', width: 10 }, { key: 'dollar_type', label: 'Value type', width: 10 },
      { key: 'result', label: 'Outcome', width: 22 }, { key: 'organization', label: 'Organization', width: 12 }, { key: 'system', label: 'System', width: 10 },
      { key: 'status', label: 'Status', width: 9 }, { key: 'visibility', label: 'Shared', width: 7 },
    ],
    defaults: ['date', 'owner', 'title', 'category', 'quantity', 'dollar_amount', 'result'],
    groups: ['category', 'eval_area', 'owner', 'month', 'status'], measures: ['quantity', 'dollar_amount'],
    sorts: ['date', 'title', 'dollar_amount', 'quantity', 'owner'],
  },
  trainings: {
    key: 'trainings', label: 'Training',
    columns: [
      { key: 'date', label: 'Date', kind: 'date', width: 9 }, { key: 'end_date', label: 'End date', kind: 'date', width: 9 }, owner,
      { key: 'title', label: 'Course', width: 30 }, { key: 'type', label: 'Type', width: 12 }, { key: 'hours', label: 'Hours', kind: 'hours', width: 7 },
      { key: 'provider', label: 'Provider', width: 14 }, { key: 'status', label: 'Status', width: 10 },
    ],
    defaults: ['date', 'owner', 'title', 'type', 'hours', 'status'],
    groups: ['type', 'owner', 'month', 'status'], measures: ['hours'], sorts: ['date', 'title', 'hours', 'owner'],
  },
  awards: {
    key: 'awards', label: 'Awards',
    columns: [
      { key: 'date', label: 'Award date', kind: 'date', width: 9 }, { key: 'period_start', label: 'Period start', kind: 'date', width: 9 }, owner,
      { key: 'name', label: 'Award', width: 28 }, { key: 'type', label: 'Type', width: 12 }, { key: 'status', label: 'Status', width: 10 },
      { key: 'recommending_official', label: 'Recommended by', width: 14 }, { key: 'approving_authority', label: 'Approving authority', width: 14 },
    ],
    defaults: ['date', 'owner', 'name', 'type', 'status'],
    groups: ['type', 'status', 'owner', 'month'], measures: [], sorts: ['date', 'name', 'status', 'owner'],
  },
  counselings: {
    key: 'counselings', label: 'Counselings',
    // The dates and who: never the words of a counseling, which stay on its own page.
    columns: [
      { key: 'date', label: 'Date', kind: 'date', width: 9 }, owner, { key: 'type', label: 'Type', width: 12 },
      { key: 'counselor', label: 'Counselor', width: 16 }, { key: 'follow_up_date', label: 'Follow-up', kind: 'date', width: 9 },
      { key: 'acknowledged', label: 'Acknowledged', kind: 'flag', width: 9 },
    ],
    defaults: ['date', 'owner', 'type', 'counselor', 'follow_up_date', 'acknowledged'],
    groups: ['type', 'owner', 'counselor', 'month'], measures: [], sorts: ['date', 'owner'],
  },
  goals: {
    key: 'goals', label: 'Goals',
    columns: [
      { key: 'title', label: 'Goal', width: 28 }, owner, { key: 'category', label: 'Category', width: 12 }, { key: 'status', label: 'Status', width: 10 },
      { key: 'current_value', label: 'Current', kind: 'number', width: 8 }, { key: 'target_value', label: 'Target', kind: 'number', width: 8 },
      { key: 'unit_label', label: 'Of', width: 8 }, { key: 'period_start', label: 'From', kind: 'date', width: 9 }, { key: 'period_end', label: 'Until', kind: 'date', width: 9 },
    ],
    defaults: ['title', 'owner', 'status', 'current_value', 'target_value', 'period_end'],
    groups: ['status', 'category', 'owner'], measures: ['current_value', 'target_value'], sorts: ['period_end', 'title', 'status', 'owner'],
  },
  tasks: {
    key: 'tasks', label: 'Tasks',
    columns: [
      { key: 'title', label: 'Task', width: 30 }, owner, { key: 'assignee', label: 'Assigned to', width: 16 },
      { key: 'status', label: 'Status', width: 10 }, { key: 'priority', label: 'Priority', width: 8 }, { key: 'due_date', label: 'Due', kind: 'date', width: 9 },
    ],
    defaults: ['title', 'assignee', 'status', 'priority', 'due_date'],
    groups: ['status', 'priority', 'assignee'], measures: [], sorts: ['due_date', 'title', 'status'],
  },
  work: {
    key: 'work', label: 'Financial cases', unitOnly: true,
    columns: [
      { key: 'reference', label: 'Reference', width: 12 }, { key: 'title', label: 'Case', width: 26 }, { key: 'procedure', label: 'Type', width: 12 },
      { key: 'stage', label: 'Stage', width: 11 }, { key: 'amount', label: 'Amount', kind: 'money', width: 10 }, { key: 'holder', label: 'Held by', width: 14 },
      { key: 'due_date', label: 'Due', kind: 'date', width: 9 }, { key: 'opened', label: 'Opened', kind: 'date', width: 9 }, { key: 'age_days', label: 'Age (days)', kind: 'number', width: 7 },
      { key: 'resolved_on', label: 'Resolved', kind: 'date', width: 9 },
    ],
    defaults: ['reference', 'title', 'procedure', 'stage', 'amount', 'holder', 'due_date', 'age_days'],
    groups: ['procedure', 'stage', 'holder'], measures: ['amount'], sorts: ['due_date', 'amount', 'age_days', 'reference'],
  },
};
export const isCustomDataset = (v: unknown): v is keyof typeof CUSTOM_DATASETS => typeof v === 'string' && Object.prototype.hasOwnProperty.call(CUSTOM_DATASETS, v);

/** The longest a printed or filed table runs before it says how many more there were. */
export const REPORT_ROW_LIMIT = 5000;
/** A report with a table wider than this prints landscape, on paper as in the PDF. */
export const LANDSCAPE_COLUMNS = 8;

// ——— The filters, as the route reads them and the library writes them ———

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-29.');
const id = z.string().trim().max(64);

export const reportQuerySchema = z.object({
  type: z.enum(REPORT_TYPES).default('individual'),
  subject: z.enum(REPORT_SUBJECTS).optional(),
  period: z.enum(PERIOD_OPTIONS.map((p) => p.value) as [string, ...string[]]).optional(),
  from: day.optional(), to: day.optional(),
  user_id: id.optional(), unit_id: id.optional(),
  track: z.enum(['jepes', 'fitrep']).optional(),
  status: z.string().trim().max(40).optional(),
  kind: z.string().trim().max(40).optional(),
  category: z.string().trim().max(120).optional(),
  area: z.string().trim().max(120).optional(),
  procedure: z.string().trim().max(80).optional(),
  state: z.enum(['open', 'all', 'resolved']).optional(),
  overdue: z.enum(['0', '1']).optional(),
  as_of: day.optional(),
  dataset: z.string().trim().max(40).optional(),
  columns: z.string().trim().max(1000).optional(),
  group: z.string().trim().max(40).optional(),
  sort: z.string().trim().max(40).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
});
export type ReportQuery = z.infer<typeof reportQuerySchema>;

/** The query keys a saved report keeps: its filters, never the format it was last downloaded in. */
export const REPORT_PARAM_KEYS = Object.keys(reportQuerySchema.shape).filter((k) => k !== 'type') as Array<Exclude<keyof ReportQuery, 'type'>>;

// ——— The document ———

export type Cell = string | number | null;

export interface ReportTable {
  id: string;
  title: string;
  note?: string;
  columns: ReportColumn[];
  rows: Array<Record<string, Cell>>;
  /** Rows there were before the limit: more than rows.length when the table was cut. */
  total: number;
  empty: string;
}

/** Bars drawn from a table in the same section: the table is the chart's accessible alternative, and its source. */
export interface ReportChart { title: string; kind: Extract<ColumnKind, 'number' | 'money' | 'hours' | 'percent'>; bars: Array<{ label: string; value: number }>; table: string }

export interface ReportFigure { label: string; value: Cell; kind?: ColumnKind; hint?: string }

export interface ReportSection {
  id: string;
  heading: string;
  lede?: string;
  figures?: ReportFigure[];
  chart?: ReportChart;
  tables: ReportTable[];
  notes?: string[];
}

export interface ReportDocument {
  format: typeof REPORT_FORMAT;
  type: ReportType;
  title: string;
  /** Whom or what it is about: "Cpl John Boletz", "G-8 Comptroller and 2 units beneath it". */
  about: string;
  unit: string | null;
  period: { from: string | null; to: string | null; label: string } | null;
  generated: { at: string; on: string; by: string };
  filters: Array<{ label: string; value: string }>;
  /** The handling line a Vantage Administrator sets for every report, printed at the top and foot of each page. */
  marking: string;
  currency: string;
  summary: ReportFigure[];
  sections: ReportSection[];
  notes: string[];
  /** The table a CSV holds. */
  primary: string | null;
}

export const DEFAULT_REPORT_MARKING = 'Working paper';

const NO_VALUE = '—';

/** A value as a printed table shows it. Files keep the raw value. */
export function formatCell(value: Cell | undefined, kind: ColumnKind = 'text', currency = '$'): string {
  if (kind === 'flag') return value == null || value === '' ? NO_VALUE : value === 1 || value === 'yes' ? 'Yes' : 'No';
  if (value == null || value === '') return NO_VALUE;
  if (typeof value !== 'number') return String(value);
  switch (kind) {
    case 'money': return formatDollarsExact(value, currency);
    case 'hours': return `${formatNumber(value)} h`;
    case 'percent': return `${formatNumber(value)}%`;
    case 'number': return formatNumber(value);
    default: return String(value);
  }
}

export const isRightAligned = (kind?: ColumnKind) => kind === 'money' || kind === 'number' || kind === 'hours' || kind === 'percent';

export const allTables = (doc: ReportDocument) => doc.sections.flatMap((s) => s.tables);
export const primaryTable = (doc: ReportDocument) => allTables(doc).find((t) => t.id === doc.primary) || allTables(doc)[0] || null;
/** Whether the report prints landscape: a table of it is wider than LANDSCAPE_COLUMNS. */
export const printsWide = (doc: ReportDocument) => allTables(doc).some((t) => t.columns.length > LANDSCAPE_COLUMNS);

/** One table as spreadsheet rows: the header, then each row in column order with numbers kept as numbers. */
export function tableMatrix(table: ReportTable): Array<Array<string | number | null>> {
  return [table.columns.map((c) => c.label), ...table.rows.map((r) => table.columns.map((c) => {
    const v = r[c.key];
    if (c.kind === 'flag') return v == null ? null : formatCell(v, 'flag');
    return v ?? null;
  }))];
}

/** The file name a report downloads as: what it is, about whom, and when it was made. */
export function reportFileName(doc: ReportDocument, ext: ReportFileFormat): string {
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `vantage-${slug(doc.title)}-${slug(doc.about) || 'report'}-${doc.generated.on}.${ext}`;
}
