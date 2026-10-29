import type { AppContext, SessionUser } from '../context.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { zonedDay } from '../lib/clock.ts';
import { zoneOf } from '../lib/zone.ts';
import { audit } from './audit.ts';
import { PERMISSIONS, assertSameInstance, can, orgOfUnit, subtreeIds, type Scope } from '../authz/scope.ts';
import { getUnit } from './org.ts';
import { assertIntakeOn, normalizeRows, parseDate, readableSource, sameReport, sheetRows, type Rejection } from './intake.ts';
import { errorReportTypesOf } from './unitConfig.ts';
import { parseMoney } from '../../shared/money.ts';
import {
  COLUMN_ROLES, DRILL_LABELS, NOT_STATED, NO_OWNER, PERSISTENT_REPORTS, SINGLE_ROLES,
  ageOf, centsOf, compareRows, groupLines, groupRow, groupValue, inDrill, normalOwner, normalStatus, shownRow, summarize,
  type ChangeFlag, type ChangeLine, type ColumnRole, type ComparedRow, type ComparisonResult, type Drill, type DrillGroup, type DrillResult, type DrillRow,
  type ErrorReportChoices, type ErrorReportLayout, type ErrorReportPreview, type ErrorReportType, type ErrorReportsOverview, type SeriesFacts,
  type SeriesHistory, type SnapshotRow, type SnapshotSummary, type Standing,
} from '../../shared/errorReports.ts';

/**
 * Financial error reports (Task 15, ADR-0021). A unit files the error reports it is sent (unliquidated obligations, open
 * commitments, unmatched transactions, invoices on hold, sync errors, and its own kinds): each upload, read through the
 * intake's own upload, scan, reader and identifier rules, becomes a snapshot of what that report said on the day it
 * stands on, kept as filed. A unit and a type make a series; any two of its reports compare, and every figure opens the
 * rows behind it, each with its file, row and every column as uploaded.
 *
 * Who may do what is decided here, on the server, before anything is read or written:
 * - reading a unit's error reports needs viewing its shared records there (as the Financial KPI report does), which a
 *   leader's authority above it confers; figures by Marine need opening member records there;
 * - filing or withdrawing one also needs posting tasks and projects there, as importing into its queue does, and is
 *   refused where Vantage has withheld spreadsheet intake from the Unit Instance;
 * - a report, its type and its file are one Unit Instance's (the database's boundary triggers hold it too);
 * - taking a comparison away as a file is the report center's (Error report comparison), with its export rule.
 * Filing a report never creates or changes a case: the queue is still filled by Import, and a row links to its case.
 */

const ROW_LIMIT = 5000;
const REJECTIONS_KEPT = 500;
const TREND_REPORTS = 26;

export interface SnapshotRecord {
  id: string; org_id: string; unit_id: string; type_id: string; source_file_id: string; filename: string; sha256: string;
  as_of: string; sheet_name: string; header_row: number; key_columns: string; columns: string; closed_statuses: string;
  row_count: number; open_count: number; open_cents: number; rejected_rows: number; rejections: string; note: string | null;
  filed_by: string; filed_at: string; withdrawn_at: string | null; withdrawn_by: string | null; withdrawn_reason: string | null;
}

export interface FilingPlan {
  unit_id: string; type_id: string; as_of: string; source_file_id: string; sheet_name: string; header_row: number;
  key_columns: string[]; columns: Record<string, ColumnRole>; closed_statuses: string[]; note?: string | null;
}

interface Reader { unitId: string; unitName: string; orgId: string; detail: boolean; file: boolean; files: boolean }

/** The unit whose error reports are read, and what the reader may do there, or a refusal before anything is read. */
function readerOf(ctx: AppContext, scope: Scope, unitId: string): Reader {
  const unit = getUnit(ctx, unitId);
  const orgId = orgOfUnit(ctx, unitId);
  if (!unit || !orgId) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.VIEW_RECORDS, unitId)) throw forbidden('You cannot open the error reports of that unit.');
  return {
    unitId, unitName: unit.name, orgId,
    detail: can(scope, PERMISSIONS.VIEW_MEMBER_DETAIL, unitId),
    file: can(scope, PERMISSIONS.CREATE_SHARED_WORK, unitId),
    files: can(scope, PERMISSIONS.EXPORT_DATA, unitId),
  };
}

function filerOf(ctx: AppContext, user: SessionUser, scope: Scope, unitId: string): Reader {
  const reader = readerOf(ctx, scope, unitId);
  if (!reader.file) throw forbidden('Filing an error report for a unit needs posting tasks and projects there.');
  // After the permission check, so whether a feature is withheld is told only to someone who could file there.
  assertIntakeOn(ctx, unitId, user.id);
  return reader;
}

/** One of the Unit Instance's error report types, or a refusal that does not say whether it exists elsewhere. */
function typeOf(ctx: AppContext, orgId: string, typeId: string): ErrorReportType {
  const row = ctx.db.prepare('SELECT * FROM error_report_types WHERE id = ? AND org_id = ?').get(typeId, orgId) as ErrorReportType | undefined;
  if (!row) throw notFound('No such error report type in this Unit Instance.');
  return row;
}

const summaryOf = (s: SnapshotRecord, names: Map<string, string>): SnapshotSummary => ({
  id: s.id, as_of: s.as_of, filename: s.filename, row_count: s.row_count, open_count: s.open_count, open_cents: s.open_cents,
  rejected_rows: s.rejected_rows, note: s.note, filed_at: s.filed_at, filed_by: names.get(s.filed_by) ?? 'Someone',
  withdrawn: s.withdrawn_at ? { at: s.withdrawn_at, by: names.get(s.withdrawn_by!) ?? 'Someone', reason: s.withdrawn_reason ?? '' } : null,
});

/** People by id, as the record names them: rank, first and last name. */
function namesOf(ctx: AppContext, ids: Array<string | null | undefined>): Map<string, string> {
  const unique = [...new Set(ids.filter((v): v is string => Boolean(v)))];
  if (!unique.length) return new Map();
  const rows = ctx.db.prepare(`SELECT u.id, u.first_name, u.last_name, r.abbr AS rank_abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(unique)) as Array<{ id: string; first_name: string; last_name: string; rank_abbr: string | null }>;
  return new Map(rows.map((r) => [r.id, `${r.rank_abbr || ''} ${r.first_name || ''} ${r.last_name || ''}`.replace(/\s+/g, ' ').trim()]));
}

/** Every report of a series, withdrawn ones too, in the order of the days they stand on. */
function seriesOf(ctx: AppContext, unitId: string, typeId: string): SnapshotRecord[] {
  return ctx.db.prepare('SELECT * FROM error_snapshots WHERE unit_id = ? AND type_id = ? ORDER BY as_of, filed_at').all(unitId, typeId) as SnapshotRecord[];
}
const live = (list: readonly SnapshotRecord[]) => list.filter((s) => !s.withdrawn_at);

// ——— Reading a report from its file ———

export interface ReadRow extends SnapshotRow { data: Record<string, string> }

interface ReadReport {
  headers: string[];
  rows: ReadRow[];
  rejections: Rejection[];
  dropped: number;
  statuses: Array<{ status: string; rows: number; closed: boolean }>;
  owners: { named: number; matched: number };
}

/** An amount as whole cents. A spreadsheet's float (1234.5600000001) is rounded to the cent, as it was typed. */
function centsFrom(text: string): number | null {
  const parsed = parseMoney(text);
  if (parsed.ok) return parsed.cents;
  const plain = text.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (/^-?\d*\.\d{3,}$/.test(plain)) {
    const n = Math.round(Number(plain) * 100);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function daysFrom(text: string): number | null {
  const plain = text.replace(/[,\s]/g, '').replace(/days?$/i, '');
  if (!/^\d+(\.\d+)?$/.test(plain)) return null;
  const n = Math.round(Number(plain));
  return n <= 100_000 ? n : null;
}

/**
 * The Marines an owner column may name: those in the unit and the units beneath it, by username, email, DoD ID and the
 * forms of their name a report writes ("Last, First", "First Last", with rank or middle initial). A name two people share
 * names neither.
 */
function ownerIndex(ctx: AppContext, unitIds: string[]): (owner: string | null) => string | null {
  const rows = ctx.db.prepare(
    `SELECT DISTINCT u.id, u.username, u.email, u.edipi, u.first_name, u.last_name, u.middle_initial, r.abbr AS rank_abbr
       FROM unit_members um JOIN users u ON u.id = um.user_id LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE um.unit_id IN (SELECT value FROM json_each(?)) AND u.active = 1`
  ).all(JSON.stringify(unitIds)) as Array<{ id: string; username: string; email: string | null; edipi: string | null; first_name: string; last_name: string; middle_initial: string | null; rank_abbr: string | null }>;
  const index = new Map<string, Set<string>>();
  const add = (form: string | null | undefined, id: string) => {
    const k = normalOwner(form);
    if (!k) return;
    const ids = index.get(k) ?? new Set<string>();
    ids.add(id);
    index.set(k, ids);
  };
  for (const u of rows) {
    const [f, l, m, rank] = [u.first_name, u.last_name, u.middle_initial, u.rank_abbr];
    for (const form of [u.username, u.email, u.edipi, `${f} ${l}`, `${l} ${f}`, m && `${f} ${m} ${l}`, m && `${l} ${f} ${m}`, rank && `${rank} ${f} ${l}`, rank && `${rank} ${l} ${f}`]) add(form, u.id);
  }
  return (owner) => {
    const ids = owner ? index.get(normalOwner(owner)) : undefined;
    return ids?.size === 1 ? [...ids][0] : null;
  };
}

/** Which header has each single role, after checking the plan names columns the sheet has and gives each role once. */
function rolesOf(headers: string[], plan: FilingPlan): Map<ColumnRole, string> {
  const roles = new Map<ColumnRole, string>();
  for (const [header, role] of Object.entries(plan.columns)) {
    if (!headers.includes(header)) throw badRequest(`The column “${header}” is not in this sheet. Check the header row.`, { fieldErrors: { columns: 'Not in the sheet.' } });
    if (!(COLUMN_ROLES as readonly string[]).includes(role)) throw badRequest(`“${role}” is not something a column can hold.`);
    if (!SINGLE_ROLES.includes(role)) continue;
    if (roles.has(role)) throw badRequest(`Two columns are given as the ${role}: “${roles.get(role)}” and “${header}”. Choose one.`, { fieldErrors: { columns: 'One column per role.' } });
    roles.set(role, header);
  }
  for (const key of plan.key_columns) {
    if (!headers.includes(key)) throw badRequest('One of the identifier columns is not in this sheet. Check the header row.', { fieldErrors: { key_columns: 'Not in the sheet.' } });
    if (plan.columns[key] === 'ignore') throw badRequest(`“${key}” identifies each row, so it is kept.`, { fieldErrors: { columns: 'An identifier is kept.' } });
  }
  return roles;
}

/** A filed report's rows, read from its file as the plan says, without writing anything. */
function readReport(ctx: AppContext, user: SessionUser, scope: Scope, plan: FilingPlan): ReadReport & { source: { id: string; filename: string; sha256: string } } {
  const source = readableSource(ctx, user, scope, plan.source_file_id);
  // A file shared with a unit is that unit's Unit Instance's: its rows are filed there, never in another (ADR-0008).
  if (source.unit_id) assertSameInstance(ctx, source.unit_id, plan.unit_id, 'That upload belongs to another Unit Instance. File it there, or upload your own copy here.');
  if (source.scan_status === 'quarantined') throw conflict('This upload is still being scanned.');
  if (source.scan_status === 'rejected') throw forbidden('The malware scanner rejected this upload.');

  const raw = sheetRows(ctx, source, plan.sheet_name);
  const ignored = Object.entries(plan.columns).filter(([, role]) => role === 'ignore').map(([h]) => [h, 'ignore'] as const);
  const read = normalizeRows(raw, {
    sheet_name: plan.sheet_name, header_row: plan.header_row, headers: [], key_columns: plan.key_columns,
    mapping: Object.fromEntries(ignored), visibility: 'unit', unit_id: plan.unit_id,
  });
  const roles = rolesOf(read.headers, plan);
  const closed = new Set(plan.closed_statuses.map(normalStatus).filter(Boolean));
  const ownerOf = ownerIndex(ctx, subtreeIds(ctx, plan.unit_id));
  const notes: Rejection[] = [];
  const statuses = new Map<string, { status: string; rows: number; closed: boolean }>();
  let named = 0;
  let matched = 0;

  const rows: ReadRow[] = read.rows.map((r) => {
    const cell = (role: ColumnRole, max: number) => {
      const header = roles.get(role);
      const value = header ? (r.data[header] ?? '').trim() : '';
      return value ? value.slice(0, max) : null;
    };
    const status = cell('status', 80);
    const amountText = cell('amount', 60);
    const amount = amountText ? centsFrom(amountText) : null;
    if (amountText && amount == null) notes.push({ source_row: r.source_row, value: amountText, reason: 'The amount on this row is not a dollar figure Vantage can read. It was filed without one.' });
    const openedText = cell('opened', 40);
    const opened = openedText ? parseDate(openedText) : null;
    if (openedText && !opened) notes.push({ source_row: r.source_row, value: openedText, reason: 'The opened date on this row is not a date Vantage can read. It was filed without one.' });
    const ageText = cell('age', 20);
    const age = ageText ? daysFrom(ageText) : null;
    if (ageText && age == null) notes.push({ source_row: r.source_row, value: ageText, reason: 'The age on this row is not a number of days. It was filed without one.' });
    const owner = cell('owner', 120);
    const ownerId = ownerOf(owner);
    if (owner) { named += 1; if (ownerId) matched += 1; }
    const isClosed = Boolean(status && closed.has(normalStatus(status)));
    if (status) {
      const k = normalStatus(status);
      const s = statuses.get(k) ?? { status, rows: 0, closed: isClosed };
      s.rows += 1;
      statuses.set(k, s);
    }
    return {
      key: r.natural_key, source_row: r.source_row,
      reference: cell('reference', 200), description: cell('description', 500), category: cell('category', 120), unit: cell('unit', 120),
      owner, owner_user_id: ownerId, status, closed: isClosed, amount_cents: amount, opened_on: opened, age_days: age, data: r.data,
    };
  });
  return {
    source: { id: source.id, filename: source.filename, sha256: source.sha256 },
    headers: read.headers, rows, rejections: [...read.rejections, ...notes], dropped: read.rejections.length,
    statuses: [...statuses.values()].sort((a, b) => b.rows - a.rows).slice(0, 100),
    owners: { named, matched },
  };
}

/** Why a plan cannot be filed for this series as it stands: its day, its type, or a report it repeats. */
function seriesProblems(ctx: AppContext, user: SessionUser, plan: FilingPlan, reader: Reader, sha256: string): { type: ErrorReportType; previous: SnapshotRecord | null; sameDay: SnapshotRecord | null; sameFile: SnapshotRecord | null } {
  const type = typeOf(ctx, reader.orgId, plan.type_id);
  if (!type.active) throw badRequest(`${type.name} is retired in this Unit Instance. A Unit Manager can restore it.`, { fieldErrors: { type_id: 'Retired.' } });
  const today = zonedDay(zoneOf(ctx, user));
  if (plan.as_of > today) throw badRequest('A report stands on a day that has come. Give the day the report was run.', { fieldErrors: { as_of: 'Not in the future.' } });
  const series = live(seriesOf(ctx, plan.unit_id, plan.type_id));
  return {
    type,
    previous: [...series].reverse().find((s) => s.as_of < plan.as_of) ?? null,
    sameDay: series.find((s) => s.as_of === plan.as_of) ?? null,
    sameFile: series.find((s) => s.sha256 === sha256) ?? null,
  };
}

const keyOf = (r: { natural_key: string }) => r.natural_key;
interface StoredRow {
  natural_key: string; source_row: number; reference: string | null; description: string | null; category: string | null; unit_text: string | null;
  owner: string | null; owner_user_id: string | null; status: string | null; closed: number; amount_cents: number | null; opened_on: string | null; age_days: number | null; data?: string;
}
const toRow = (r: StoredRow): ReadRow => ({
  key: keyOf(r), source_row: r.source_row, reference: r.reference, description: r.description, category: r.category, unit: r.unit_text,
  owner: r.owner, owner_user_id: r.owner_user_id, status: r.status, closed: Boolean(r.closed), amount_cents: r.amount_cents,
  opened_on: r.opened_on, age_days: r.age_days, data: r.data ? JSON.parse(r.data) as Record<string, string> : {},
});

function rowsOf(ctx: AppContext, snapshotId: string, withData = false): ReadRow[] {
  const cols = 'natural_key, source_row, reference, description, category, unit_text, owner, owner_user_id, status, closed, amount_cents, opened_on, age_days';
  return (ctx.db.prepare(`SELECT ${cols}${withData ? ', data' : ''} FROM error_snapshot_rows WHERE snapshot_id = ? ORDER BY source_row`).all(snapshotId) as StoredRow[]).map(toRow);
}

/** Every identifier on any report of the series up to and including this one, open or closed. */
function seenUpTo(ctx: AppContext, unitId: string, typeId: string, upTo: SnapshotRecord): Set<string> {
  const ids = live(seriesOf(ctx, unitId, typeId)).filter((s) => s.as_of <= upTo.as_of).map((s) => s.id);
  const rows = ctx.db.prepare('SELECT DISTINCT natural_key FROM error_snapshot_rows WHERE snapshot_id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as Array<{ natural_key: string }>;
  return new Set(rows.map(keyOf));
}

/** The preview of a filing: what the file holds and how it compares with the report before it, nothing written. */
export function previewSnapshot(ctx: AppContext, user: SessionUser, scope: Scope, plan: FilingPlan): ErrorReportPreview {
  const reader = filerOf(ctx, user, scope, plan.unit_id);
  const read = readReport(ctx, user, scope, plan);
  const { type, previous, sameDay, sameFile } = seriesProblems(ctx, user, plan, reader, read.source.sha256);
  const before = previous ? rowsOf(ctx, previous.id) : [];
  const seen = previous ? seenUpTo(ctx, plan.unit_id, plan.type_id, previous) : new Set<string>();
  const compared = compareRows(before, read.rows, seen);
  const count = (what: Standing | ChangeFlag) => compared.filter((r) => r.standing === what || r.flags.includes(what as ChangeFlag)).length;
  const open = read.rows.filter((r) => !r.closed);
  return {
    type: { id: type.id, code: type.code, name: type.name },
    headers: read.headers, rows: read.rows.length, open: open.length, open_cents: centsOf(open),
    rejected: read.dropped, rejections: read.rejections.slice(0, 50), rejection_count: read.rejections.length,
    statuses: read.statuses, owners: read.owners,
    // Which Marine an owner names is for those who may open member records, as the figures by Marine are.
    sample: read.rows.slice(0, 20).map(({ data: _data, ...r }) => ({ ...r, owner_user_id: reader.detail ? r.owner_user_id : null })),
    previous: previous ? { id: previous.id, as_of: previous.as_of, open_count: previous.open_count, open_cents: previous.open_cents } : null,
    changes: previous ? {
      new: count('new'), still_open: count('still_open'), reopened: count('reopened'), resolved: count('resolved'),
      amount_changed: count('amount_changed'), owner_changed: count('owner_changed'), status_changed: count('status_changed'),
    } : null,
    same_day: sameDay ? { id: sameDay.id, filename: sameDay.filename } : null,
    same_file: sameFile ? { id: sameFile.id, as_of: sameFile.as_of } : null,
  };
}

/** File a report: its rows kept as they were read, its figures, and an entry in the audit trail. Never changed after. */
export function fileSnapshot(ctx: AppContext, user: SessionUser, scope: Scope, plan: FilingPlan, ip?: string): SnapshotSummary & { unit_id: string; type_id: string } {
  const reader = filerOf(ctx, user, scope, plan.unit_id);
  const read = readReport(ctx, user, scope, plan);
  const { type, sameDay, sameFile } = seriesProblems(ctx, user, plan, reader, read.source.sha256);
  if (!read.rows.length) throw badRequest('No row of this sheet has an identifier Vantage can read, so there is nothing to file.', { rejections: read.rejections.slice(0, 50) });
  if (sameFile) throw conflict(`This file is already filed in this series, as the report of ${sameFile.as_of}.`, 'snapshot_duplicate');
  if (sameDay) throw conflict(`A ${type.code} report for this unit is already filed for ${plan.as_of}. Withdraw it first, then file this one.`, 'snapshot_exists');
  const open = read.rows.filter((r) => !r.closed);
  const id = newId();
  const at = now();
  const columns = Object.fromEntries(read.headers.map((h) => [h, plan.columns[h] ?? 'keep']));
  try {
    ctx.db.transaction(() => {
      ctx.db.prepare(
        `INSERT INTO error_snapshots (id, org_id, unit_id, type_id, source_file_id, filename, sha256, as_of, sheet_name, header_row, key_columns, columns, closed_statuses,
           row_count, open_count, open_cents, rejected_rows, rejections, note, filed_by, filed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id, reader.orgId, plan.unit_id, type.id, read.source.id, read.source.filename, read.source.sha256, plan.as_of, plan.sheet_name, plan.header_row,
        JSON.stringify(plan.key_columns), JSON.stringify(columns), JSON.stringify([...new Set(plan.closed_statuses.map(normalStatus).filter(Boolean))]),
        read.rows.length, open.length, centsOf(open), read.dropped, JSON.stringify(read.rejections.slice(0, REJECTIONS_KEPT)), plan.note?.trim() || null, user.id, at,
      );
      const insert = ctx.db.prepare(
        `INSERT INTO error_snapshot_rows (snapshot_id, natural_key, source_row, reference, description, category, unit_text, owner, owner_user_id, status, closed, amount_cents, opened_on, age_days, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of read.rows) {
        insert.run(id, r.key, r.source_row, r.reference, r.description, r.category, r.unit, r.owner, r.owner_user_id, r.status, r.closed ? 1 : 0, r.amount_cents, r.opened_on, r.age_days, JSON.stringify(r.data));
      }
      audit(ctx, {
        actor_id: user.id, action: 'error_snapshot_filed', entity: 'error_snapshots', entity_id: id, unit_id: plan.unit_id,
        detail: `${type.code} as of ${plan.as_of}: ${read.rows.length} rows, ${open.length} open (${(centsOf(open) / 100).toFixed(2)}), ${read.dropped} refused; from ${read.source.filename}`, ip,
      });
    })();
  } catch (e) {
    if ((e as { code?: string } | null)?.code === 'SQLITE_CONSTRAINT_UNIQUE') throw conflict('Another report for this day, or this file, was filed for this series a moment ago. Open the series to see it.', 'snapshot_exists');
    throw e;
  }
  const row = ctx.db.prepare('SELECT * FROM error_snapshots WHERE id = ?').get(id) as SnapshotRecord;
  return { ...summaryOf(row, namesOf(ctx, [user.id])), unit_id: row.unit_id, type_id: row.type_id };
}

/** Withdraw a report filed in error, with the reason. It is kept and shown as withdrawn, and left out of comparisons. */
export function withdrawSnapshot(ctx: AppContext, user: SessionUser, scope: Scope, id: string, reason: string, ip?: string): SnapshotSummary {
  const row = ctx.db.prepare('SELECT * FROM error_snapshots WHERE id = ?').get(id) as SnapshotRecord | undefined;
  if (!row || !can(scope, PERMISSIONS.VIEW_RECORDS, row.unit_id)) throw notFound('No such error report.');
  filerOf(ctx, user, scope, row.unit_id);
  if (row.withdrawn_at) throw conflict('This report is already withdrawn.', 'already_withdrawn');
  const why = reason.trim();
  if (why.length < 5) throw badRequest('Say why the report is withdrawn, so the series explains itself.', { fieldErrors: { reason: 'At least a few words.' } });
  const type = typeOf(ctx, row.org_id, row.type_id);
  ctx.db.transaction(() => {
    const done = ctx.db.prepare('UPDATE error_snapshots SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id = ? AND withdrawn_at IS NULL').run(now(), user.id, why.slice(0, 500), id);
    // Withdrawn by someone else a moment ago: theirs stands, and nothing is written for this one.
    if (!done.changes) throw conflict('This report is already withdrawn.', 'already_withdrawn');
    audit(ctx, { actor_id: user.id, action: 'error_snapshot_withdrawn', entity: 'error_snapshots', entity_id: id, unit_id: row.unit_id, detail: `${type.code} as of ${row.as_of}: ${why.slice(0, 300)}`, ip });
  })();
  const after = ctx.db.prepare('SELECT * FROM error_snapshots WHERE id = ?').get(id) as SnapshotRecord;
  return summaryOf(after, namesOf(ctx, [after.filed_by, after.withdrawn_by]));
}

/** How the next report of a series starts: the sheet, header row, identifier, columns and closed statuses of the last. */
export function lastLayout(ctx: AppContext, scope: Scope, unitId: string, typeId: string): ErrorReportLayout | null {
  const reader = readerOf(ctx, scope, unitId);
  typeOf(ctx, reader.orgId, typeId);
  const last = live(seriesOf(ctx, unitId, typeId)).at(-1);
  if (!last) return null;
  return {
    from: { id: last.id, as_of: last.as_of, filename: last.filename },
    sheet_name: last.sheet_name, header_row: last.header_row,
    key_columns: JSON.parse(last.key_columns) as string[], columns: JSON.parse(last.columns) as Record<string, ColumnRole>,
    closed_statuses: JSON.parse(last.closed_statuses) as string[],
  };
}

// ——— The unit's error reports ———

/** The unit's series and those of the units beneath it, each with its latest figures and the report before it. */
export function errorReportsOverview(ctx: AppContext, user: SessionUser, scope: Scope, unitId: string, ip?: string): ErrorReportsOverview {
  const overview = overviewOf(ctx, scope, unitId);
  audit(ctx, { actor_id: user.id, action: 'view_error_report', entity: 'error_snapshots', unit_id: unitId, detail: `overview: ${overview.series.length} series`, ip });
  return overview;
}

/** The overview, read without an audit entry: its callers write one, or the report center's run or print does. */
export function overviewOf(ctx: AppContext, scope: Scope, unitId: string): ErrorReportsOverview {
  const reader = readerOf(ctx, scope, unitId);
  const types = errorReportTypesOf(ctx, reader.orgId);
  // Only the units beneath whose shared records the reader may view: a role held only in this unit reaches no lower.
  const units = subtreeIds(ctx, unitId).filter((id) => can(scope, PERMISSIONS.VIEW_RECORDS, id));
  const rows = ctx.db.prepare('SELECT * FROM error_snapshots WHERE unit_id IN (SELECT value FROM json_each(?)) ORDER BY as_of, filed_at').all(JSON.stringify(units)) as SnapshotRecord[];
  const unitNames = new Map((ctx.db.prepare('SELECT id, name FROM units WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(units)) as Array<{ id: string; name: string }>).map((u) => [u.id, u.name]));
  const byType = new Map(types.map((t) => [t.id, t]));
  const groups = new Map<string, SnapshotRecord[]>();
  for (const r of rows) {
    const k = `${r.unit_id}\u0000${r.type_id}`;
    const list = groups.get(k);
    if (list) list.push(r); else groups.set(k, [r]);
  }
  const names = namesOf(ctx, rows.flatMap((r) => [r.filed_by, r.withdrawn_by]));
  const series = [...groups.values()].map((list) => {
    const kept = live(list);
    const type = byType.get(list[0].type_id)!;
    return {
      unit_id: list[0].unit_id, unit_name: unitNames.get(list[0].unit_id) ?? list[0].unit_id,
      type_id: type.id, code: type.code, name: type.name, reports: kept.length, withdrawn: list.length - kept.length,
      latest: kept.at(-1) ? summaryOf(kept.at(-1)!, names) : null,
      previous: kept.at(-2) ? summaryOf(kept.at(-2)!, names) : null,
    };
  }).sort((a, b) => Number(b.unit_id === unitId) - Number(a.unit_id === unitId) || a.unit_name.localeCompare(b.unit_name) || a.code.localeCompare(b.code));
  return {
    unit: { id: unitId, name: reader.unitName }, org_id: reader.orgId, types, series,
    can: { file: reader.file, detail: reader.detail, files: reader.files },
  };
}

/**
 * What a report of the unit's error reports may be run on: its types, and the days each series has a report for. Names
 * and days only, no figures, so the report library can offer them before anything is run.
 */
export function reportChoices(ctx: AppContext, scope: Scope, unitId: string): ErrorReportChoices {
  const reader = readerOf(ctx, scope, unitId);
  const types = errorReportTypesOf(ctx, reader.orgId);
  const rows = live(ctx.db.prepare('SELECT * FROM error_snapshots WHERE unit_id = ? ORDER BY as_of DESC, filed_at DESC').all(unitId) as SnapshotRecord[]);
  return {
    types: types.filter((t) => t.active || rows.some((r) => r.type_id === t.id)).map((t) => ({
      id: t.id, code: t.code, name: t.name, reports: rows.filter((r) => r.type_id === t.id).map((r) => ({ id: r.id, as_of: r.as_of })),
    })),
  };
}

// ——— A comparison, and the rows behind each figure ———

export interface ComparisonQuery { unit_id: string; type_id: string; snapshot?: string | null; against?: string | null }

interface Compared {
  reader: Reader; type: ErrorReportType; all: SnapshotRecord[]; after: SnapshotRecord; before: SnapshotRecord | null;
  compared: ComparedRow[]; facts: SeriesFacts;
}

/**
 * The two reports a comparison reads, and what the series says about each identifier up to the later one. The later
 * report is the one asked for or the latest; the earlier, the one asked for or the one before it. Withdrawn reports are
 * in no comparison.
 */
function compareSeries(ctx: AppContext, scope: Scope, q: ComparisonQuery, withData = false): Compared {
  const reader = readerOf(ctx, scope, q.unit_id);
  const type = typeOf(ctx, reader.orgId, q.type_id);
  const all = seriesOf(ctx, q.unit_id, q.type_id);
  const kept = live(all);
  if (!kept.length) throw notFound(all.length ? `Every ${type.code} report of this unit was withdrawn, so there is nothing to compare.` : `No ${type.code} report is filed for this unit yet.`);
  const pick = (id: string, which: 'snapshot' | 'against') => {
    const s = all.find((x) => x.id === id);
    if (!s) throw notFound('No such report in this series.');
    if (s.withdrawn_at) throw badRequest(`The ${which === 'snapshot' ? 'later' : 'earlier'} report was withdrawn, so it is in no comparison.`, { fieldErrors: { [which]: 'Withdrawn.' } });
    return s;
  };
  const after = q.snapshot ? pick(q.snapshot, 'snapshot') : kept.at(-1)!;
  const at = kept.findIndex((s) => s.id === after.id);
  const before = q.against ? pick(q.against, 'against') : at > 0 ? kept[at - 1] : null;
  const beforeAt = before ? kept.findIndex((s) => s.id === before.id) : -1;
  if (before && beforeAt >= at) throw badRequest('Compare a report with one that stands on an earlier day.', { fieldErrors: { against: 'Earlier than the report it is compared with.' } });

  // One pass over the series up to the later report: for each identifier, the first report it was on, the first and last
  // it was open on, how many it was open on, and how many of the last PERSISTENT_REPORTS.
  const positions = Object.fromEntries(kept.slice(0, at + 1).map((s, i) => [s.id, i]));
  const history = ctx.db.prepare(
    `SELECT r.natural_key, MIN(p.value) AS first_any,
       MIN(CASE WHEN r.closed = 0 THEN p.value END) AS first_open, MAX(CASE WHEN r.closed = 0 THEN p.value END) AS last_open,
       SUM(CASE WHEN r.closed = 0 THEN 1 ELSE 0 END) AS n_open, SUM(CASE WHEN r.closed = 0 AND p.value > ? THEN 1 ELSE 0 END) AS recent_open
     FROM error_snapshot_rows r JOIN json_each(?) p ON p.key = r.snapshot_id GROUP BY r.natural_key`
  ).all(at - PERSISTENT_REPORTS, JSON.stringify(positions)) as Array<{ natural_key: string; first_any: number; first_open: number | null; last_open: number | null; n_open: number; recent_open: number }>;
  const seen = new Set<string>();
  const firstOpenOn = new Map<string, string>();
  const persistent = new Set<string>();
  const recurring = new Set<string>();
  for (const h of history) {
    if (h.first_any <= beforeAt) seen.add(h.natural_key);
    if (h.first_open != null) firstOpenOn.set(h.natural_key, kept[h.first_open].as_of);
    if (h.recent_open >= PERSISTENT_REPORTS) persistent.add(h.natural_key);
    if (h.last_open === at && h.first_open != null && h.n_open < at - h.first_open + 1) recurring.add(h.natural_key);
  }
  const compared = compareRows(before ? rowsOf(ctx, before.id, withData) : [], rowsOf(ctx, after.id, withData), seen);
  return { reader, type, all, after, before, compared, facts: { firstOpenOn, persistent, recurring, persistentKnown: at + 1 >= PERSISTENT_REPORTS } };
}

/** The name a group line is shown by: the Marine an owner names, or the owner as the report wrote it. */
function labeller(ctx: AppContext, compared: readonly ComparedRow[]) {
  const names = namesOf(ctx, compared.map((r) => groupRow(r).owner_user_id));
  return (group: DrillGroup) => (row: SnapshotRow, value: string) => {
    if (!value) return group === 'owner' ? NO_OWNER : NOT_STATED;
    if (group === 'owner') return (row.owner_user_id ? names.get(row.owner_user_id) : null) ?? row.owner ?? NO_OWNER;
    return value;
  };
}

/** An identifier as people read it: the parts of a two-column identifier with a slash between. */
export const identifierOf = (key: string) => key.split('\u001f').join(' / ');

/** A comparison with every figure, group, the oldest open and the series' trend. Its callers write the audit entry. */
export function buildComparison(ctx: AppContext, scope: Scope, q: ComparisonQuery): ComparisonResult {
  return comparisonOf(ctx, compareSeries(ctx, scope, q));
}

/** A comparison and its table of changes, for the report center's Error report comparison. */
export function comparisonWithChanges(ctx: AppContext, scope: Scope, q: ComparisonQuery): ComparisonResult & { changes: ChangeLine[] } {
  const c = compareSeries(ctx, scope, q);
  const result = comparisonOf(ctx, c);
  const names = c.reader.detail ? namesOf(ctx, c.compared.map((r) => groupRow(r).owner_user_id)) : new Map<string, string>();
  const changes = c.compared.filter((r) => r.standing || r.flags.length).map((r) => {
    const row = groupRow(r);
    const age = isOpenRow(r.after) ? ageOf(r.after, c.after.as_of, c.facts.firstOpenOn.get(r.key) ?? null).days : null;
    return {
      identifier: identifierOf(r.key), reference: row.reference, description: row.description, category: row.category, unit: row.unit,
      owner: row.owner, marine: row.owner_user_id ? names.get(row.owner_user_id) ?? null : null, status: r.after?.status ?? r.before?.status ?? null,
      standing: r.standing, flags: r.flags, before_cents: r.before?.amount_cents ?? null, after_cents: r.after?.amount_cents ?? null, age_days: age,
    };
  }).sort((a, b) => ORDER.indexOf(a.standing) - ORDER.indexOf(b.standing) || (b.age_days ?? -1) - (a.age_days ?? -1) || a.identifier.localeCompare(b.identifier));
  return { ...result, changes };
}
const ORDER: Array<Standing | null> = ['new', 'reopened', 'still_open', 'resolved', null];
const isOpenRow = (r: SnapshotRow | null): r is SnapshotRow => Boolean(r && !r.closed);

function comparisonOf(ctx: AppContext, c: Compared): ComparisonResult {
  // The oldest go out as `oldest` below, never as the rows they were read from (which name the Marine an owner matched).
  const { oldest: aged, ...summary } = summarize(c.compared, { before: c.before?.as_of ?? null, after: c.after.as_of }, c.facts);
  const label = labeller(ctx, c.compared);
  const names = namesOf(ctx, c.all.flatMap((s) => [s.filed_by, s.withdrawn_by]));
  const kept = live(c.all);
  const notes = [
    'A row is open unless its status is one the report was filed with as closed. A row on the earlier report and not on this one is resolved.',
    'Ages run from the opened date where the report gives one, else from the age it states, else from the first report the row was open on.',
    ...(c.reader.detail ? [] : ['Figures by Marine are left out: they need opening member records in this unit.']),
  ];
  if (!c.before) notes.unshift(kept.length > 1 ? 'This is the first report of the series, so nothing is compared.' : 'This is the only report filed in the series, so nothing is compared yet.');
  return {
    unit: { id: c.reader.unitId, name: c.reader.unitName },
    type: { id: c.type.id, code: c.type.code, name: c.type.name, description: c.type.description, active: c.type.active },
    reports: [...c.all].reverse().map((s) => summaryOf(s, names)),
    after: summaryOf(c.after, names), before: c.before ? summaryOf(c.before, names) : null,
    summary,
    oldest: aged.map((a) => ({ key: a.key, identifier: identifierOf(a.key), reference: a.row.reference, description: a.row.description, category: a.row.category, owner: a.row.owner, amount_cents: a.row.amount_cents, days: a.days, basis: a.basis })),
    groups: {
      category: groupLines(c.compared, 'category', label('category')),
      unit: groupLines(c.compared, 'unit', label('unit')),
      owner: c.reader.detail ? groupLines(c.compared, 'owner', label('owner')) : null,
    },
    trend: kept.slice(-TREND_REPORTS).map((s) => ({ id: s.id, as_of: s.as_of, open_count: s.open_count, open_cents: s.open_cents })),
    can: { file: c.reader.file, detail: c.reader.detail, files: c.reader.files },
    notes,
  };
}

/** A series every report of which was withdrawn: its history, which is kept, and nothing to compare. Null otherwise. */
function withdrawnSeries(ctx: AppContext, scope: Scope, q: ComparisonQuery): SeriesHistory | null {
  const reader = readerOf(ctx, scope, q.unit_id);
  const type = typeOf(ctx, reader.orgId, q.type_id);
  const all = seriesOf(ctx, q.unit_id, q.type_id);
  if (!all.length || live(all).length) return null;
  const names = namesOf(ctx, all.flatMap((s) => [s.filed_by, s.withdrawn_by]));
  return {
    unit: { id: reader.unitId, name: reader.unitName },
    type: { id: type.id, code: type.code, name: type.name, description: type.description, active: type.active },
    reports: [...all].reverse().map((s) => summaryOf(s, names)), after: null,
    can: { file: reader.file, detail: reader.detail, files: reader.files },
    notes: [`Every ${type.code} report filed for this unit was withdrawn, so nothing is compared. Each is kept, with why.`],
  };
}

/** A comparison on the page, or the history of a series whose reports were all withdrawn, audited as a read of the unit's error reports. */
export function viewComparison(ctx: AppContext, user: SessionUser, scope: Scope, q: ComparisonQuery, ip?: string): ComparisonResult | SeriesHistory {
  const history = withdrawnSeries(ctx, scope, q);
  if (history) {
    audit(ctx, { actor_id: user.id, action: 'view_error_report', entity: 'error_snapshots', unit_id: q.unit_id, detail: `${history.type.code}: every report withdrawn (${history.reports.length})`, ip });
    return history;
  }
  const result = buildComparison(ctx, scope, q);
  audit(ctx, {
    actor_id: user.id, action: 'view_error_report', entity: 'error_snapshots', entity_id: result.after.id, unit_id: q.unit_id,
    detail: `${result.type.code} as of ${result.after.as_of}${result.before ? ` against ${result.before.as_of}` : ''}`, ip,
  });
  return result;
}

export interface DrillQuery extends ComparisonQuery { drill: Drill; group?: DrillGroup | null; value?: string | null }

/**
 * The rows behind one figure: the identifiers it counts, each with its file, row number and every column as uploaded,
 * the earlier amount beside the later, and the case in the unit's queue with the same identifier, if there is one.
 * Narrowed to a group, it holds the rows of that line; by Marine needs opening member records, as the figures do.
 * Its rows are the figure's rows whatever the page shows: the same compareRows and inDrill decide both.
 */
export function drillRows(ctx: AppContext, user: SessionUser, scope: Scope, q: DrillQuery, ip?: string): DrillResult {
  const c = compareSeries(ctx, scope, q, true);
  if (q.group === 'owner' && !c.reader.detail) throw forbidden('Figures by Marine need opening member records in this unit.');
  const series = { persistent: c.facts.persistent, recurring: c.facts.recurring };
  let rows = c.compared.filter((r) => inDrill(r, q.drill, series));
  if (q.group) rows = rows.filter((r) => groupValue(groupRow(r), q.group!) === (q.value ?? ''));
  const label = labeller(ctx, rows)('owner');
  const shown: DrillRow[] = rows.map((r) => {
    const row = shownRow(r, q.drill) as ReadRow;
    const snapshot = row === r.before ? c.before! : c.after;
    const age = ageOf(row, snapshot.as_of, c.facts.firstOpenOn.get(r.key) ?? null);
    return {
      key: r.key, identifier: identifierOf(r.key), filename: snapshot.filename, as_of: snapshot.as_of, source_row: row.source_row,
      reference: row.reference, description: row.description, category: row.category, unit: row.unit, owner: row.owner,
      marine: c.reader.detail && row.owner_user_id ? label(row, `user:${row.owner_user_id}`) : null,
      status: row.status, closed: row.closed, amount_cents: r.after?.amount_cents ?? null, before_amount_cents: r.before?.amount_cents ?? null,
      opened_on: row.opened_on, age_days: age.days, age_basis: age.basis, standing: r.standing, flags: r.flags, data: row.data, case_id: null,
    };
  }).sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1)
    || Math.abs(b.amount_cents ?? b.before_amount_cents ?? 0) - Math.abs(a.amount_cents ?? a.before_amount_cents ?? 0) || a.source_row - b.source_row);
  const page = shown.slice(0, ROW_LIMIT);
  // The case each row is in the unit's queue, by the same identifier, when the unit imported it there. A case another
  // report keyed the same way is not this row's: the columns decide, as they do when the import itself matches a row.
  const cases = new Map((ctx.db.prepare(`SELECT id, natural_key, data FROM work_items WHERE unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL AND natural_key IN (SELECT value FROM json_each(?))`)
    .all(q.unit_id, JSON.stringify(page.map((r) => r.key))) as Array<{ id: string; natural_key: string; data: string | null }>).map((w) => [w.natural_key, w]));
  for (const r of page) {
    const w = cases.get(r.key);
    r.case_id = w && sameReport(Object.keys(JSON.parse(w.data || '{}') as Record<string, string>), Object.keys(r.data)) ? w.id : null;
  }
  const headers = [...new Set(page.flatMap((r) => Object.keys(r.data)))];
  const groupLabel = !q.group ? null : !q.value ? (q.group === 'owner' ? NO_OWNER : NOT_STATED) : q.group === 'owner' ? (page[0]?.marine ?? page[0]?.owner ?? q.value) : q.value;
  audit(ctx, {
    actor_id: user.id, action: 'view_error_report', entity: 'error_snapshots', entity_id: c.after.id, unit_id: q.unit_id,
    detail: `${c.type.code} as of ${c.after.as_of}${c.before ? ` against ${c.before.as_of}` : ''}: ${q.drill} rows${q.group ? ` by ${q.group}` : ''} (${shown.length})`, ip,
  });
  return {
    drill: q.drill, label: DRILL_LABELS[q.drill], group: q.group ?? null, group_label: groupLabel,
    type: { id: c.type.id, code: c.type.code, name: c.type.name },
    after: { id: c.after.id, as_of: c.after.as_of, filename: c.after.filename },
    before: c.before ? { id: c.before.id, as_of: c.before.as_of, filename: c.before.filename } : null,
    headers, rows: page, total: shown.length,
    cents: centsOf(rows.map((r) => (q.drill === 'resolved' || q.drill === 'before' ? r.before : r.after) ?? { amount_cents: null })),
  };
}
