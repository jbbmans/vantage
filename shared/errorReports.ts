/**
 * Financial error reports (Task 15, ADR-0021): the kinds of report a Unit Instance files (ULO, OCMT, UMT, IOH, sync
 * errors and its own), what each column of a filed report is, which statuses close a row, and how two filed reports of
 * one series compare. A filed report is a snapshot: what the report said on the day it stands on, never changed after.
 *
 * The comparison and its figures are worked out here, from rows alone, so the page, the report library's document and
 * the tests count the same way. Money is whole cents (ADR-0005); a day is YYYY-MM-DD.
 */

/** The kinds of report the specification names, offered to every Unit Instance. A Unit Instance keeps its own. */
export const STANDARD_ERROR_REPORT_TYPES: ReadonlyArray<{ code: string; name: string; description: string }> = [
  { code: 'ULO', name: 'Unliquidated obligations', description: 'Obligations not yet fully paid, as the term is used at work.' },
  { code: 'OCMT', name: 'Open commitments', description: 'Requisition amounts not yet covered by an obligation.' },
  { code: 'UMT', name: 'Unmatched transactions', description: 'Payments that did not match or post to the intended record.' },
  { code: 'IOH', name: 'Invoices on hold', description: 'Invoices that know where to post but cannot yet satisfy the conditions to be paid.' },
  { code: 'SYNC', name: 'Sync errors', description: 'Transactions that failed to pass from one system to another.' },
];

/** A report type's code: short, upper case, letters, digits and hyphens, as a report is named on a desk. */
export const errorTypeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);

export interface ErrorReportType { id: string; org_id: string; code: string; name: string; description: string | null; active: number; created_at: string; updated_at: string }

// ——— Columns ———

/** What a column of a filed report holds. The identifier is chosen apart from these: one column, or two together. */
export const COLUMN_ROLES = ['reference', 'description', 'category', 'amount', 'owner', 'status', 'unit', 'opened', 'age', 'keep', 'ignore'] as const;
export type ColumnRole = (typeof COLUMN_ROLES)[number];
/** The roles a report has at most one column for. Keep and ignore may be given to any number. */
export const SINGLE_ROLES: readonly ColumnRole[] = ['reference', 'description', 'category', 'amount', 'owner', 'status', 'unit', 'opened', 'age'];

export const COLUMN_ROLE_LABELS: Record<ColumnRole, { label: string; hint: string }> = {
  reference: { label: 'Reference', hint: 'The document number as people read it, when it is not the identifier' },
  description: { label: 'Description', hint: 'What the error is' },
  category: { label: 'Error type', hint: 'The kind of error within the report: its condition, code or reason' },
  amount: { label: 'Amount', hint: 'The dollar value' },
  owner: { label: 'Owner', hint: 'Who holds it: a name, an email or a DoD ID' },
  status: { label: 'Status', hint: 'Open, in research, closed and the like' },
  unit: { label: 'Unit or office', hint: 'The unit, office, UIC or fund center the report names' },
  opened: { label: 'Opened', hint: 'The day it was opened, for its age' },
  age: { label: 'Age (days)', hint: 'Its age in days, as the report states it' },
  keep: { label: 'Keep as a column', hint: 'Kept with the row and shown with it' },
  ignore: { label: 'Leave out', hint: 'Not kept' },
};

/** A first guess at a column's role from its header, for a report filed the first time. The uploader decides. */
export function guessRole(header: string): ColumnRole {
  const h = header.toLowerCase();
  if (/\b(amount|amt|value|balance|dollars?)\b|\$/.test(h)) return 'amount';
  if (/\b(status|state|disposition)\b/.test(h)) return 'status';
  if (/\b(owner|poc|assigned|holder|analyst|responsible|technician)\b/.test(h)) return 'owner';
  if (/\b(age|days open|days old|aging)\b/.test(h)) return 'age';
  if (/\b(opened|open date|created|date posted|posting date|obligation date|invoice date|received)\b/.test(h)) return 'opened';
  if (/\b(error|reason|condition|category|type|code)\b/.test(h)) return 'category';
  if (/\b(unit|office|uic|fund center|activity|org|organization|dodaac)\b/.test(h)) return 'unit';
  if (/\b(desc|description|title|summary|vendor|comments?)\b/.test(h)) return 'description';
  return 'keep';
}

// ——— Status ———

/** A status as compared: trimmed, lower case, one space between words. */
export const normalStatus = (s: string | null | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Statuses that close a row unless the uploader says otherwise. A report that lists only open errors needs none: a row
 * that is no longer on the report is resolved.
 */
export const CLOSED_WORDS: readonly string[] = [
  'closed', 'resolved', 'cleared', 'complete', 'completed', 'corrected', 'done', 'fixed', 'cancelled', 'canceled',
  'liquidated', 'matched', 'released', 'paid', 'n/a', 'not applicable', 'no action required',
];
export const closedByDefault = (status: string) => CLOSED_WORDS.includes(normalStatus(status));

/** An owner as compared: case, spacing and punctuation do not make a change of owner. */
export const normalOwner = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();

// ——— Rows and their comparison ———

/** One line of a filed report, as kept. */
export interface SnapshotRow {
  key: string;
  source_row: number;
  reference: string | null;
  description: string | null;
  category: string | null;
  unit: string | null;
  owner: string | null;
  /** The Marine the owner names, when it names exactly one in the unit on the day it was filed. */
  owner_user_id: string | null;
  status: string | null;
  closed: boolean;
  amount_cents: number | null;
  opened_on: string | null;
  age_days: number | null;
}

/** Where a row stands in the later report against the earlier. A row closed in both, or gone from both, has none. */
export const STANDINGS = ['new', 'still_open', 'reopened', 'resolved'] as const;
export type Standing = (typeof STANDINGS)[number];
export const CHANGE_FLAGS = ['amount_changed', 'owner_changed', 'status_changed'] as const;
export type ChangeFlag = (typeof CHANGE_FLAGS)[number];

export const STANDING_LABELS: Record<Standing, { label: string; hint: string }> = {
  new: { label: 'New', hint: 'Open now, and on no earlier report of this series' },
  still_open: { label: 'Still open', hint: 'Open on both reports' },
  reopened: { label: 'Reopened', hint: 'Open now, not open on the earlier report, but on a report before it' },
  resolved: { label: 'Resolved', hint: 'Open on the earlier report; gone, or closed, now' },
};
export const FLAG_LABELS: Record<ChangeFlag, { label: string; hint: string }> = {
  amount_changed: { label: 'Amount changed', hint: 'On both reports, with a different amount' },
  owner_changed: { label: 'Owner changed', hint: 'On both reports, held by someone else' },
  status_changed: { label: 'Status changed', hint: 'On both reports, with a different status' },
};

export interface ComparedRow { key: string; standing: Standing | null; flags: ChangeFlag[]; before: SnapshotRow | null; after: SnapshotRow | null }

/**
 * Every identifier on either report, where it stands and what changed. `seen` holds every identifier on any report of the
 * series up to and including the earlier one, open or closed: one open now that is in it, and not open on the earlier
 * report, came back.
 */
export function compareRows(before: readonly SnapshotRow[], after: readonly SnapshotRow[], seen: ReadonlySet<string>): ComparedRow[] {
  const earlier = new Map(before.map((r) => [r.key, r]));
  const later = new Map(after.map((r) => [r.key, r]));
  const out: ComparedRow[] = [];
  for (const key of new Set([...earlier.keys(), ...later.keys()])) {
    const b = earlier.get(key) ?? null;
    const a = later.get(key) ?? null;
    const openBefore = Boolean(b && !b.closed);
    const openNow = Boolean(a && !a.closed);
    const standing: Standing | null = openNow
      ? openBefore ? 'still_open' : seen.has(key) ? 'reopened' : 'new'
      : openBefore ? 'resolved' : null;
    const flags: ChangeFlag[] = [];
    if (a && b) {
      if (a.amount_cents !== b.amount_cents) flags.push('amount_changed');
      if (normalOwner(a.owner) !== normalOwner(b.owner)) flags.push('owner_changed');
      if (normalStatus(a.status) !== normalStatus(b.status)) flags.push('status_changed');
    }
    out.push({ key, standing, flags, before: b, after: a });
  }
  return out;
}

// ——— Ages ———

const DAY_MS = 86_400_000;
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** How a row's age is known: its opened day, the age the report states, or the first report it was open on. */
export type AgeBasis = 'opened' | 'stated' | 'first_seen';
export const AGE_BASIS_LABELS: Record<AgeBasis, string> = { opened: 'From its opened date', stated: 'As the report states it', first_seen: 'Since the first report it was open on' };

/** A row's age in days on the day its report stands on. */
export function ageOf(row: Pick<SnapshotRow, 'opened_on' | 'age_days'>, asOf: string, firstSeen: string | null): { days: number | null; basis: AgeBasis | null } {
  if (row.opened_on) return { days: Math.max(0, daysBetween(row.opened_on, asOf)), basis: 'opened' };
  if (row.age_days != null) return { days: Math.max(0, row.age_days), basis: 'stated' };
  if (firstSeen) return { days: Math.max(0, daysBetween(firstSeen, asOf)), basis: 'first_seen' };
  return { days: null, basis: null };
}

/**
 * How long a resolved row took, to the day of the report it was gone from: from its opened day, from the age the earlier
 * report stated plus the days between the two, or from the first report it was open on.
 */
export function daysToResolve(before: Pick<SnapshotRow, 'opened_on' | 'age_days'>, beforeAsOf: string, afterAsOf: string, firstSeen: string | null): number | null {
  if (before.opened_on) return Math.max(0, daysBetween(before.opened_on, afterAsOf));
  if (before.age_days != null) return Math.max(0, before.age_days + daysBetween(beforeAsOf, afterAsOf));
  if (firstSeen) return Math.max(0, daysBetween(firstSeen, afterAsOf));
  return null;
}

// ——— What a figure drills to ———

/**
 * The rows behind a figure. Each figure on the page and in the document names one, and the rows route answers it: the
 * open rows of the later report, the open rows of the earlier, a standing, a change, the persistent, the recurring.
 */
export const DRILLS = ['open', 'before', ...STANDINGS, ...CHANGE_FLAGS, 'persistent', 'recurring'] as const;
export type Drill = (typeof DRILLS)[number];
export const isDrill = (v: unknown): v is Drill => (DRILLS as readonly unknown[]).includes(v);
/** A group a drill may be narrowed to: the error type, the unit or office, or the Marine who holds it. */
export const DRILL_GROUPS = ['category', 'unit', 'owner'] as const;
export type DrillGroup = (typeof DRILL_GROUPS)[number];

export const DRILL_LABELS: Record<Drill, string> = {
  open: 'Open on this report', before: 'Open on the earlier report',
  new: STANDING_LABELS.new.label, still_open: STANDING_LABELS.still_open.label, reopened: STANDING_LABELS.reopened.label, resolved: STANDING_LABELS.resolved.label,
  amount_changed: FLAG_LABELS.amount_changed.label, owner_changed: FLAG_LABELS.owner_changed.label, status_changed: FLAG_LABELS.status_changed.label,
  persistent: 'Persistent', recurring: 'Recurring',
};

/** Open on this many reports in a row, the latest among them, makes an error persistent. */
export const PERSISTENT_REPORTS = 3;

/** A group's label for a row that says nothing for it. */
export const NOT_STATED = 'Not stated';
export const NO_OWNER = 'No Marine named';

/** Whether a compared row is behind a drill. Persistent and recurring are decided over the series, so they are passed in. */
export function inDrill(row: ComparedRow, drill: Drill, series: { persistent: ReadonlySet<string>; recurring: ReadonlySet<string> }): boolean {
  switch (drill) {
    case 'open': return Boolean(row.after && !row.after.closed);
    case 'before': return Boolean(row.before && !row.before.closed);
    case 'persistent': return Boolean(row.after && !row.after.closed) && series.persistent.has(row.key);
    case 'recurring': return Boolean(row.after && !row.after.closed) && series.recurring.has(row.key);
    case 'amount_changed': case 'owner_changed': case 'status_changed': return row.flags.includes(drill);
    default: return row.standing === drill;
  }
}

/** The row a drill shows a compared row by: the earlier report's for what was open on it, the later's otherwise. */
export const shownRow = (row: ComparedRow, drill: Drill): SnapshotRow => ((drill === 'resolved' || drill === 'before') ? row.before ?? row.after! : row.after ?? row.before!);

// ——— Money ———

/** Whole cents summed exactly. */
export function centsOf(rows: ReadonlyArray<{ amount_cents: number | null }>): number {
  let total = 0n;
  for (const r of rows) if (r.amount_cents != null) total += BigInt(r.amount_cents);
  return Number(total);
}

// ——— The figures of a comparison ———

/**
 * What the series says about each identifier up to the later report: the day of the first report it was open on (for
 * an age where the report gives none), whether it is persistent (open on each of the last PERSISTENT_REPORTS reports),
 * and whether it is recurring (open now, after it was once gone or closed). `persistentKnown` is false while the series
 * has fewer reports than that, so no error can be persistent yet.
 */
export interface SeriesFacts {
  firstOpenOn: ReadonlyMap<string, string>;
  persistent: ReadonlySet<string>;
  recurring: ReadonlySet<string>;
  persistentKnown: boolean;
}

/** One figure: what it counts, its value, and the rows behind it. A count also carries the dollar value of those rows. */
export interface ErrorFigure {
  id: string;
  label: string;
  kind: 'count' | 'money' | 'percent' | 'days' | 'rate';
  value: number | null;
  cents?: number;
  drill: Drill | null;
  hint?: string;
}

export interface GroupLine {
  /** What the drill names the group by; '' is a row that says nothing for it. */
  value: string;
  label: string;
  open: number; open_cents: number;
  new: number; still_open: number; reopened: number;
  resolved: number; resolved_cents: number;
}

export interface AgedRow { key: string; row: SnapshotRow; days: number; basis: AgeBasis }

export interface ComparisonSummary {
  figures: ErrorFigure[];
  counts: Record<Standing | ChangeFlag | 'open' | 'before' | 'persistent' | 'recurring', number>;
  ages: { average: number | null; oldest: number | null; basis: Partial<Record<AgeBasis, number>> };
  oldest: AgedRow[];
}

const isOpen = (r: SnapshotRow | null): r is SnapshotRow => Boolean(r && !r.closed);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The row a compared identifier is grouped and drilled by: where it is open, the later report first. */
export const groupRow = (r: ComparedRow): SnapshotRow => (isOpen(r.after) ? r.after : isOpen(r.before) ? r.before : (r.after ?? r.before)!);

/** The group a row falls in, by its error type, its unit or office, or the Marine (or name) it is held by. */
export function groupValue(row: SnapshotRow, group: DrillGroup): string {
  if (group === 'category') return row.category?.trim() ?? '';
  if (group === 'unit') return row.unit?.trim() ?? '';
  if (row.owner_user_id) return `user:${row.owner_user_id}`;
  return row.owner ? `text:${normalOwner(row.owner)}` : '';
}

/** Every figure of one report against an earlier one of its series, or of the first report alone. */
export function summarize(compared: readonly ComparedRow[], at: { before: string | null; after: string }, facts: SeriesFacts): ComparisonSummary {
  const ctx = { persistent: facts.persistent, recurring: facts.recurring };
  const of = (drill: Drill) => compared.filter((r) => inDrill(r, drill, ctx));
  const sets = Object.fromEntries(DRILLS.map((d) => [d, of(d)])) as Record<Drill, ComparedRow[]>;
  const counts = Object.fromEntries(DRILLS.map((d) => [d, sets[d].length])) as ComparisonSummary['counts'];
  const after = (list: readonly ComparedRow[]) => centsOf(list.map((r) => r.after ?? { amount_cents: null }));
  const before = (list: readonly ComparedRow[]) => centsOf(list.map((r) => r.before ?? { amount_cents: null }));

  const aged: AgedRow[] = [];
  for (const r of sets.open) {
    const a = ageOf(r.after!, at.after, facts.firstOpenOn.get(r.key) ?? null);
    if (a.days != null) aged.push({ key: r.key, row: r.after!, days: a.days, basis: a.basis! });
  }
  aged.sort((x, y) => y.days - x.days || Math.abs(y.row.amount_cents ?? 0) - Math.abs(x.row.amount_cents ?? 0) || x.row.source_row - y.row.source_row);
  const basis: Partial<Record<AgeBasis, number>> = {};
  for (const a of aged) basis[a.basis] = (basis[a.basis] ?? 0) + 1;
  const average = aged.length ? round1(aged.reduce((n, a) => n + a.days, 0) / aged.length) : null;

  const open = (id: Drill, label: string, hint?: string): ErrorFigure => ({ id, label, kind: 'count', value: counts[id], cents: id === 'resolved' || id === 'before' ? before(sets[id]) : after(sets[id]), drill: id, ...(hint ? { hint } : {}) });
  const figures: ErrorFigure[] = [open('open', 'Open', 'Open on this report: its count and dollar value')];
  if (at.before) {
    const compared2 = at.before;
    const days = daysBetween(compared2, at.after);
    const toResolve = sets.resolved.map((r) => daysToResolve(r.before!, compared2, at.after, facts.firstOpenOn.get(r.key) ?? null)).filter((d): d is number => d != null);
    const changedBy = centsOf(sets.amount_changed.map((r) => r.after!)) - centsOf(sets.amount_changed.map((r) => r.before!));
    figures.push(
      open('before', 'Open on the earlier report'),
      open('new', STANDING_LABELS.new.label, STANDING_LABELS.new.hint),
      open('still_open', STANDING_LABELS.still_open.label, STANDING_LABELS.still_open.hint),
      open('reopened', STANDING_LABELS.reopened.label, STANDING_LABELS.reopened.hint),
      open('resolved', STANDING_LABELS.resolved.label, `${STANDING_LABELS.resolved.hint}. Valued as the earlier report had it`),
      { id: 'amount_changed', label: FLAG_LABELS.amount_changed.label, kind: 'count', value: counts.amount_changed, cents: changedBy, drill: 'amount_changed', hint: 'The dollar figure is the net change' },
      { id: 'owner_changed', label: FLAG_LABELS.owner_changed.label, kind: 'count', value: counts.owner_changed, cents: after(sets.owner_changed), drill: 'owner_changed', hint: FLAG_LABELS.owner_changed.hint },
      { id: 'status_changed', label: FLAG_LABELS.status_changed.label, kind: 'count', value: counts.status_changed, cents: after(sets.status_changed), drill: 'status_changed', hint: FLAG_LABELS.status_changed.hint },
      { id: 'resolution_rate', label: 'Resolution rate', kind: 'percent', value: counts.before ? round1((counts.resolved / counts.before) * 100) : null, drill: 'resolved', hint: 'Resolved, of those open on the earlier report' },
      { id: 'value_resolved', label: 'Value resolved', kind: 'money', value: before(sets.resolved), drill: 'resolved', hint: 'The dollar value of the resolved, as the earlier report had it' },
      { id: 'velocity', label: 'Resolved a week', kind: 'rate', value: days > 0 ? round1((counts.resolved * 7) / days) : null, drill: 'resolved', hint: `Resolved between the two reports, ${days} day${days === 1 ? '' : 's'} apart` },
      { id: 'days_to_resolve', label: 'Days to resolve', kind: 'days', value: toResolve.length ? round1(toResolve.reduce((n, d) => n + d, 0) / toResolve.length) : null, drill: 'resolved', hint: 'Average, for those resolved, from when each was opened' },
    );
  }
  figures.push(
    { id: 'average_age', label: 'Average age', kind: 'days', value: average, drill: 'open', hint: 'Days, of those open on this report' },
    { id: 'oldest', label: 'Oldest', kind: 'days', value: aged[0]?.days ?? null, drill: 'open', hint: 'Days, the oldest open on this report' },
    { id: 'recurring', label: 'Recurring', kind: 'count', value: counts.recurring, cents: after(sets.recurring), drill: 'recurring', hint: 'Open now, after it was once gone or closed' },
    {
      id: 'persistent', label: 'Persistent', kind: 'count', value: facts.persistentKnown ? counts.persistent : null, cents: facts.persistentKnown ? after(sets.persistent) : undefined, drill: 'persistent',
      hint: facts.persistentKnown ? `Open on each of the last ${PERSISTENT_REPORTS} reports` : `Known once the series has ${PERSISTENT_REPORTS} reports`,
    },
  );
  return { figures, counts, ages: { average, oldest: aged[0]?.days ?? null, basis }, oldest: aged.slice(0, 10) };
}

/** The figures by error type, unit or office, or Marine: what each group holds open now, and what came and went. */
export function groupLines(compared: readonly ComparedRow[], group: DrillGroup, labelOf: (row: SnapshotRow, value: string) => string): GroupLine[] {
  const lines = new Map<string, GroupLine>();
  for (const r of compared) {
    if (!isOpen(r.after) && !isOpen(r.before)) continue;
    const row = groupRow(r);
    const value = groupValue(row, group);
    let line = lines.get(value);
    if (!line) {
      line = { value, label: labelOf(row, value), open: 0, open_cents: 0, new: 0, still_open: 0, reopened: 0, resolved: 0, resolved_cents: 0 };
      lines.set(value, line);
    }
    if (isOpen(r.after)) { line.open += 1; line.open_cents += r.after.amount_cents ?? 0; }
    if (r.standing === 'resolved') { line.resolved += 1; line.resolved_cents += r.before?.amount_cents ?? 0; }
    else if (r.standing) line[r.standing] += 1;
  }
  return [...lines.values()].sort((a, b) => b.open - a.open || b.open_cents - a.open_cents || b.resolved - a.resolved || a.label.localeCompare(b.label));
}

// ——— What the API answers (server/routes/errorReports.ts) ———

/** A filed report as the page lists it: its day, file, counts and who filed it, and whether it was withdrawn. */
export interface SnapshotSummary {
  id: string; as_of: string; filename: string; row_count: number; open_count: number; open_cents: number; rejected_rows: number;
  note: string | null; filed_at: string; filed_by: string; withdrawn: { at: string; by: string; reason: string } | null;
}

/** One series of the overview: a unit and a type, with its latest report and the one before. */
export interface ErrorSeriesLine {
  unit_id: string; unit_name: string; type_id: string; code: string; name: string; reports: number; withdrawn: number;
  latest: SnapshotSummary | null; previous: SnapshotSummary | null;
}

/** What the reader may do with the unit's error reports: file and withdraw, see figures by Marine, take files away. */
export interface ErrorReportRights { file: boolean; detail: boolean; files: boolean }

export interface ErrorReportsOverview {
  unit: { id: string; name: string }; org_id: string; types: ErrorReportType[]; series: ErrorSeriesLine[]; can: ErrorReportRights;
}

/** How the next report of a series starts: the layout of the last one filed. */
export interface ErrorReportLayout {
  from: { id: string; as_of: string; filename: string };
  sheet_name: string; header_row: number; key_columns: string[]; columns: Record<string, ColumnRole>; closed_statuses: string[];
}

/** A row the file could not be read into, with why. */
export interface ErrorReportRejection { source_row: number; reason: string; value?: string }

/** A filing's preview: what the file holds, how it compares with the report before it, and what would stop it. */
export interface ErrorReportPreview {
  type: { id: string; code: string; name: string };
  headers: string[]; rows: number; open: number; open_cents: number;
  rejected: number; rejections: ErrorReportRejection[]; rejection_count: number;
  statuses: Array<{ status: string; rows: number; closed: boolean }>; owners: { named: number; matched: number };
  sample: SnapshotRow[];
  previous: { id: string; as_of: string; open_count: number; open_cents: number } | null;
  changes: Record<Standing | ChangeFlag, number> | null;
  same_day: { id: string; filename: string } | null;
  same_file: { id: string; as_of: string } | null;
}

/** One of the oldest open errors on a report. */
export interface OldestLine {
  key: string; identifier: string; reference: string | null; description: string | null; category: string | null; owner: string | null;
  amount_cents: number | null; days: number; basis: AgeBasis;
}

export interface ComparisonResult {
  unit: { id: string; name: string };
  type: { id: string; code: string; name: string; description: string | null; active: number };
  reports: SnapshotSummary[];
  after: SnapshotSummary;
  before: SnapshotSummary | null;
  summary: ComparisonSummary;
  oldest: OldestLine[];
  groups: { category: GroupLine[]; unit: GroupLine[]; owner: GroupLine[] | null };
  trend: Array<{ id: string; as_of: string; open_count: number; open_cents: number }>;
  can: ErrorReportRights;
  notes: string[];
}

/** Every identifier open on either report, where it stands and what changed: the comparison's table, for the report center. */
export interface ChangeLine {
  identifier: string; reference: string | null; description: string | null; category: string | null; unit: string | null;
  owner: string | null; marine: string | null; status: string | null; standing: Standing | null; flags: ChangeFlag[];
  before_cents: number | null; after_cents: number | null; age_days: number | null;
}

/** A row behind a figure, as the file had it: its file and row, every column, and the case it is in the queue. */
export interface DrillRow {
  key: string; identifier: string; filename: string; as_of: string; source_row: number;
  reference: string | null; description: string | null; category: string | null; unit: string | null; owner: string | null; marine: string | null;
  status: string | null; closed: boolean; amount_cents: number | null; before_amount_cents: number | null; opened_on: string | null;
  age_days: number | null; age_basis: AgeBasis | null; standing: Standing | null; flags: ChangeFlag[]; data: Record<string, string>; case_id: string | null;
}

export interface DrillResult {
  drill: Drill; label: string; group: DrillGroup | null; group_label: string | null;
  type: { id: string; code: string; name: string };
  after: { id: string; as_of: string; filename: string };
  before: { id: string; as_of: string; filename: string } | null;
  headers: string[]; rows: DrillRow[]; total: number; cents: number;
}

/** The types and report days a unit's comparison may be run on, for the report library. */
export interface ErrorReportChoices { types: Array<{ id: string; code: string; name: string; reports: Array<{ id: string; as_of: string }> }> }
