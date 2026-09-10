import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, isMember, PERMISSIONS } from '../authz/scope.ts';
import { record } from './telemetry.ts';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { readWorkbook, readDelimited, sniffDelimiter, WorkbookError } from '../lib/workbook.ts';
import { ZipError } from '../lib/zip.ts';
import type { Scanner } from './scanner.ts';

/**
 * Bringing a spreadsheet of work into Vantage.
 *
 * The shape of this is deliberate:
 *  - the uploaded bytes are stored once and never rewritten, so a reimport re-reads the original;
 *  - a file is quarantined until a scanner speaks, and is not parsed while quarantined;
 *  - a row's identity is the value in its key column, taken verbatim. Vantage never repairs an
 *    identifier that a spreadsheet mangled, because the repaired value would be a guess about
 *    someone's contract number;
 *  - importing the same file twice changes nothing, because each row carries a content hash.
 */

export const SUPPORTED = {
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  delimited: ['text/csv', 'text/plain', 'text/tab-separated-values', 'application/csv'],
};

export type SourceKind = 'xlsx' | 'delimited';

export interface SourceFileRow {
  id: string; user_id: string; unit_id: string | null; visibility: string;
  filename: string; content_type: string; kind: SourceKind; byte_size: number; sha256: string;
  scan_status: 'quarantined' | 'clean' | 'rejected' | 'skipped'; scan_detail: string | null; scanner: string | null; scanned_at: string | null;
  notes: string; created_at: string; deleted_at: string | null;
}

const OOXML_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** Legacy .xls is a different format entirely, and we do not read it. Naming it is kinder than "unsupported". */
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

export function classifyUpload(filename: string, contentType: string, buffer: Buffer): SourceKind {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (buffer.subarray(0, 4).equals(OLE_MAGIC) || ext === 'xls') {
    throw badRequest('This is an older .xls workbook. Open it in Excel and save it as .xlsx, then upload that.');
  }
  if (ext === 'xlsx' || ext === 'xlsm' || SUPPORTED.xlsx.includes(contentType)) {
    // The extension is a claim; the magic bytes are the fact.
    if (!buffer.subarray(0, 4).equals(OOXML_MAGIC)) throw badRequest('This file is named like a workbook but is not one. Re-save it from Excel and try again.');
    return 'xlsx';
  }
  if (['csv', 'tsv', 'txt'].includes(ext) || SUPPORTED.delimited.includes(contentType)) {
    if (buffer.subarray(0, 4).equals(OOXML_MAGIC)) throw badRequest('This file is named like a text file but is actually a workbook. Rename it with an .xlsx extension.');
    return 'delimited';
  }
  throw badRequest('Vantage reads .xlsx workbooks and delimited text files (.csv, .tsv). Export your data as one of those.');
}

function assertCanPlace(scope: Scope, unitId: string | null, visibility: string) {
  if (visibility === 'private') return;
  if (!unitId) throw badRequest('Choose the unit this work belongs to before sharing it.');
  if (!isMember(scope, unitId)) throw forbidden('You are not a member of that unit.');
}


/** How much of the file store one person is already holding. Soft-deleted sources still occupy it. */
export function storedBytesFor(ctx: AppContext, userId: string): number {
  const row = ctx.db.prepare('SELECT COALESCE(SUM(byte_size), 0) AS n FROM source_files WHERE user_id = ?').get(userId) as { n: number };
  return Number(row.n) || 0;
}

/**
 * Refuses an upload that would take the instance past its safety threshold, or one person past
 * their share of the file store.
 *
 * The per-file limit alone bounds nothing: the same account can send the same 25 MB workbook all
 * day. The database threshold exists so an operator always has headroom to take a backup, and an
 * upload path that ignores it can spend that headroom on somebody's spreadsheets.
 */
export function assertCapacity(ctx: AppContext, userId: string, incoming: number) {
  if (ctx.db.name !== ':memory:') {
    try {
      if (statSync(ctx.db.name).size + incoming >= ctx.config.limits.maxDatabaseBytes) {
        throw new HttpError(507, 'The database is too close to its safety threshold to take another upload. Ask the owner to clear old sources or raise the limit.', 'database_capacity');
      }
    } catch (e) { if (e instanceof HttpError) throw e; }
  }
  const held = storedBytesFor(ctx, userId);
  const quota = ctx.config.intake.maxBytesPerUser;
  if (held + incoming > quota) {
    throw new HttpError(507, `You are holding ${Math.round(held / 1_048_576)} MB of uploaded workbooks, and the limit here is ${Math.round(quota / 1_048_576)} MB. Remove a source you no longer need.`, 'storage_quota');
  }
}

/**
 * Drops the bytes of sources past the retention window, keeping the row so the work they produced
 * still says where it came from. A workbook is evidence for as long as the policy says, not forever.
 */
export function pruneSources(ctx: AppContext): number {
  const days = ctx.config.intake.retainDays;
  if (!days) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const result = ctx.db.prepare(
    "UPDATE source_files SET content = zeroblob(0), byte_size = 0, deleted_at = COALESCE(deleted_at, ?), notes = COALESCE(notes, '') || ' Bytes released after the retention window.' WHERE created_at < ? AND byte_size > 0"
  ).run(now(), cutoff);
  return Number(result.changes || 0);
}

export async function uploadSource(
  ctx: AppContext,
  user: SessionUser,
  scope: Scope,
  scanner: Scanner,
  input: { filename: string; contentType: string; buffer: Buffer; unitId: string | null; visibility: 'private' | 'unit' },
): Promise<SourceFileRow> {
  if (!ctx.config.intake.enabled) throw badRequest('Importing work is switched off on this instance.');
  if (!input.buffer.length) throw badRequest('That file is empty.');
  if (input.buffer.length > ctx.config.intake.maxBytes) {
    throw badRequest(`That file is ${Math.round(input.buffer.length / 1_048_576)} MB. The limit here is ${Math.round(ctx.config.intake.maxBytes / 1_048_576)} MB.`);
  }
  assertCanPlace(scope, input.unitId, input.visibility);
  assertCapacity(ctx, user.id, input.buffer.length);

  const kind = classifyUpload(input.filename, input.contentType, input.buffer);
  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const id = newId();
  const at = now();

  // Stored quarantined first, so the bytes exist even if the scan or the process dies mid-way.
  ctx.db.prepare(
    `INSERT INTO source_files (id, user_id, unit_id, visibility, filename, content_type, kind, byte_size, sha256, scan_status, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantined', ?, ?)`
  ).run(id, user.id, input.unitId, input.visibility, input.filename.slice(0, 255), input.contentType.slice(0, 120), kind, input.buffer.length, sha256, input.buffer, at);

  const verdict = await scanner.scan(input.buffer, input.filename);
  ctx.db.prepare('UPDATE source_files SET scan_status = ?, scan_detail = ?, scanner = ?, scanned_at = ? WHERE id = ?')
    .run(verdict.verdict, verdict.detail, verdict.scanner, now(), id);

  // The shape of the file and what the scanner said. Never the filename, which can carry a case number.
  record(ctx, 'import.uploaded', {
    format: kind === 'xlsx' ? 'xlsx' : kind === 'delimited' ? 'csv' : 'other',
    bytes: input.buffer.length,
    scan: verdict.verdict === 'clean' ? 'clean' : verdict.verdict === 'rejected' ? 'infected' : verdict.verdict === 'skipped' ? 'skipped' : 'error',
  }, { id: user.id });
  return getSource(ctx, id)!;
}

export function getSource(ctx: AppContext, id: string): SourceFileRow | null {
  return (ctx.db.prepare(
    `SELECT id, user_id, unit_id, visibility, filename, content_type, kind, byte_size, sha256, scan_status, scan_detail, scanner, scanned_at, notes, created_at, deleted_at
       FROM source_files WHERE id = ? AND deleted_at IS NULL`
  ).get(id) as SourceFileRow | undefined) || null;
}

export function readableSource(ctx: AppContext, user: SessionUser, scope: Scope, id: string): SourceFileRow {
  const row = getSource(ctx, id);
  if (!row) throw notFound('No such upload.');
  if (row.user_id === user.id) return row;
  if (row.visibility === 'unit' && row.unit_id && can(scope, PERMISSIONS.VIEW_RECORDS, row.unit_id)) return row;
  throw forbidden('That upload is not yours to open.');
}

function sourceBytes(ctx: AppContext, id: string): Buffer {
  const row = ctx.db.prepare('SELECT content FROM source_files WHERE id = ? AND deleted_at IS NULL').get(id) as { content: Buffer } | undefined;
  if (!row) throw notFound('No such upload.');
  return row.content;
}

export interface SheetSummary { name: string; rows: number; columns: number; sample: string[][]; truncated: boolean }

export function inspectSource(ctx: AppContext, row: SourceFileRow): { sheets: SheetSummary[]; notes: string[] } {
  if (row.scan_status === 'quarantined') throw conflict('This upload is still being scanned. Try again in a moment.');
  if (row.scan_status === 'rejected') throw forbidden('The malware scanner rejected this upload, so Vantage will not open it.');

  const buffer = sourceBytes(ctx, row.id);
  const limits = { maxRows: ctx.config.intake.maxRows, maxColumns: ctx.config.intake.maxColumns };
  try {
    if (row.kind === 'xlsx') {
      const wb = readWorkbook(buffer, limits);
      return {
        notes: wb.notes,
        sheets: wb.sheets.map((s) => ({
          name: s.name, rows: s.rows.length, truncated: s.truncated,
          columns: s.rows.reduce((n, r) => Math.max(n, r.length), 0),
          sample: s.rows.slice(0, 20),
        })),
      };
    }
    const text = buffer.toString('utf8');
    const rows = readDelimited(text, sniffDelimiter(text)).slice(0, limits.maxRows);
    return {
      notes: [],
      sheets: [{ name: row.filename, rows: rows.length, truncated: false, columns: rows.reduce((n, r) => Math.max(n, r.length), 0), sample: rows.slice(0, 20) }],
    };
  } catch (e) {
    if (e instanceof WorkbookError || e instanceof ZipError) throw badRequest(e.message);
    throw e;
  }
}

function sheetRows(ctx: AppContext, row: SourceFileRow, sheetName: string): string[][] {
  const buffer = sourceBytes(ctx, row.id);
  const limits = { maxRows: ctx.config.intake.maxRows, maxColumns: ctx.config.intake.maxColumns };
  if (row.kind === 'xlsx') {
    const wb = readWorkbook(buffer, limits);
    const sheet = wb.sheets.find((s) => s.name === sheetName) || wb.sheets[0];
    if (!sheet) throw badRequest('That sheet is not in this workbook.');
    return sheet.rows;
  }
  const text = buffer.toString('utf8');
  return readDelimited(text, sniffDelimiter(text)).slice(0, limits.maxRows);
}

/** The fields an imported row can fill. Everything else is kept verbatim under `data`. */
export const MAPPABLE_FIELDS = ['title', 'reference', 'due_date', 'amount', 'amount_type', 'quantity', 'unit_label', 'state'] as const;
export type MappableField = (typeof MAPPABLE_FIELDS)[number];

export interface Mapping { [column: string]: MappableField | 'ignore' | 'keep' }

export interface ImportPlan {
  sheet_name: string;
  header_row: number;
  headers: string[];
  key_columns: string[];
  mapping: Mapping;
  visibility: 'private' | 'unit';
  unit_id: string | null;
}

export interface NormalizedRow {
  source_row: number;
  natural_key: string;
  row_hash: string;
  title: string;
  reference: string | null;
  due_date: string | null;
  amount: number | null;
  amount_type: string | null;
  quantity: number | null;
  unit_label: string | null;
  state: string;
  data: Record<string, string>;
}

export interface Rejection { source_row: number; reason: string; value?: string }

/**
 * A value that a spreadsheet has already destroyed. Excel silently converts a long document number
 * to a float and shows it as 1.23457E+14; the digits are gone. Reconstructing them would invent a
 * contract number, so an identifier in this shape is refused with instructions instead.
 */
function damagedIdentifier(value: string): string | null {
  const text = value.trim();
  if (/^-?\d+(\.\d+)?[eE][+-]?\d+$/.test(text)) return 'the spreadsheet stored it in scientific notation, so its digits are no longer in the file';
  if (/^\d{16,}$/.test(text) && !Number.isSafeInteger(Number(text))) return 'it is longer than a spreadsheet can hold exactly, so its last digits may have been rounded';
  if (/^#(REF|VALUE|NAME|DIV\/0|N\/A|NULL|NUM)[!?]?$/i.test(text)) return 'the cell holds a spreadsheet error rather than a value';
  return null;
}

const VALID_STATES = new Set(['open', 'in_progress', 'waiting', 'resolved', 'not_applicable']);

const STATE_WORDS: Record<string, string> = {
  open: 'open', new: 'open', 'not started': 'open', pending: 'open',
  'in progress': 'in_progress', 'in-progress': 'in_progress', working: 'in_progress', active: 'in_progress',
  waiting: 'waiting', 'on hold': 'waiting', blocked: 'waiting', 'awaiting response': 'waiting',
  resolved: 'resolved', closed: 'resolved', complete: 'resolved', completed: 'resolved', done: 'resolved',
  'n/a': 'not_applicable', 'not applicable': 'not_applicable',
};

function parseNumber(value: string): number | null {
  const text = value.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!text || !/^-?\d*\.?\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** True only for a day that exists. "2026-99-99" is shaped like a date and is not one. */
function realCalendarDay(iso: string): boolean {
  const [y, m, d] = iso.split('-').map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() + 1 === m && at.getUTCDate() === d && y >= 1940 && y <= 2100;
}

function parseDate(value: string): string | null {
  const text = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return realCalendarDay(text) ? text : null;
  const slash = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(text);
  if (slash) {
    const [, a, b, c] = slash;
    const year = c.length === 2 ? 2000 + Number(c) : Number(c);
    // Month-first, matching how these workbooks are produced in this environment.
    const iso = `${year}-${String(Number(a)).padStart(2, '0')}-${String(Number(b)).padStart(2, '0')}`;
    // Date.parse rolls 31 February forward to March rather than refusing it, so it cannot be the test.
    return realCalendarDay(iso) ? iso : null;
  }
  return null;
}

export function normalizeRows(rows: string[][], plan: ImportPlan): { rows: NormalizedRow[]; rejections: Rejection[]; headers: string[] } {
  const headerIndex = Math.max(0, plan.header_row - 1);
  const headers = (rows[headerIndex] || []).map((h, i) => (h || '').trim() || `Column ${i + 1}`);
  const columnOf = (name: string) => headers.indexOf(name);
  const keyIndexes = plan.key_columns.map(columnOf);
  if (!plan.key_columns.length) throw badRequest('Choose at least one column that identifies each row, so a reimport can recognise it.');
  if (keyIndexes.some((i) => i < 0)) throw badRequest('One of the key columns is not in this sheet. Check the header row.');

  const out: NormalizedRow[] = [];
  const rejections: Rejection[] = [];
  const seen = new Map<string, number>();

  for (let r = headerIndex + 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const sourceRow = r + 1;
    if (row.every((c) => !String(c || '').trim())) continue;

    const keyParts = keyIndexes.map((i) => String(row[i] ?? '').trim());
    if (keyParts.some((p) => !p)) { rejections.push({ source_row: sourceRow, reason: 'This row has no value in its key column, so nothing identifies it.' }); continue; }
    const damaged = keyParts.map(damagedIdentifier).find(Boolean);
    if (damaged) {
      rejections.push({
        source_row: sourceRow,
        value: keyParts.join(' / '),
        reason: `Vantage will not guess this identifier: ${damaged}. Format the column as Text in the source system and export it again.`,
      });
      continue;
    }
    // Verbatim, with a separator that cannot appear inside a cell value we trimmed.
    const naturalKey = keyParts.join('');
    const firstSeen = seen.get(naturalKey);
    if (firstSeen != null) { rejections.push({ source_row: sourceRow, value: keyParts.join(' / '), reason: `The same identifier is on row ${firstSeen} of this sheet. Vantage imports it once.` }); continue; }
    seen.set(naturalKey, sourceRow);

    const fields: Partial<Record<MappableField, string>> = {};
    const data: Record<string, string> = {};
    headers.forEach((header, i) => {
      const target = plan.mapping[header];
      if (target === 'ignore') return;
      const raw = String(row[i] ?? '').trim();
      if (target && target !== 'keep') fields[target] = raw;
      // Every retained column is kept verbatim, so nothing in the source is lost by mapping.
      data[header] = raw;
    });

    const title = (fields.title || keyParts.join(' / ')).slice(0, 300);
    const state = fields.state ? (STATE_WORDS[fields.state.toLowerCase()] || (VALID_STATES.has(fields.state) ? fields.state : 'open')) : 'open';
    const amount = fields.amount ? parseNumber(fields.amount) : null;
    if (fields.amount && amount == null) rejections.push({ source_row: sourceRow, value: fields.amount, reason: 'The amount on this row is not a number Vantage can read. It was imported without a value.' });
    const quantity = fields.quantity ? parseNumber(fields.quantity) : null;
    const dueDate = fields.due_date ? parseDate(fields.due_date) : null;
    if (fields.due_date && !dueDate) rejections.push({ source_row: sourceRow, value: fields.due_date, reason: 'The due date on this row is not a date Vantage can read. It was imported without one.' });

    const normalized: Omit<NormalizedRow, 'row_hash'> = {
      source_row: sourceRow,
      natural_key: naturalKey,
      title,
      reference: fields.reference?.slice(0, 200) || null,
      due_date: dueDate,
      amount,
      amount_type: fields.amount_type?.slice(0, 60).toLowerCase() || null,
      quantity,
      unit_label: fields.unit_label?.slice(0, 60) || null,
      state,
      data,
    };
    // The hash covers what the source said, so an identical reimport is recognised as identical.
    const row_hash = createHash('sha256').update(JSON.stringify([normalized.title, normalized.reference, normalized.due_date, normalized.amount, normalized.amount_type, normalized.quantity, normalized.unit_label, normalized.state, normalized.data])).digest('hex');
    out.push({ ...normalized, row_hash });
  }

  return { rows: out, rejections, headers };
}

export interface PreviewResult {
  headers: string[];
  sheet_name: string;
  total_rows: number;
  will_insert: NormalizedRow[];
  will_update: Array<NormalizedRow & { existing_id: string; claimed_by: string | null; changes: string[] }>;
  unchanged: number;
  rejections: Rejection[];
  notes: string[];
}

const CHANGE_FIELDS: Array<keyof NormalizedRow> = ['title', 'reference', 'due_date', 'amount', 'amount_type', 'quantity', 'unit_label', 'state'];

export function previewImport(ctx: AppContext, user: SessionUser, scope: Scope, plan: ImportPlan, sourceId: string): PreviewResult {
  const source = readableSource(ctx, user, scope, sourceId);
  assertCanPlace(scope, plan.unit_id, plan.visibility);
  // Bringing work in for a whole unit is posting tasking, so it needs that authority, not merely membership.
  if (plan.visibility === 'unit' && plan.unit_id && !can(scope, PERMISSIONS.CREATE_SHARED_WORK, plan.unit_id)) {
    throw forbidden('You cannot bring shared work into that unit.');
  }
  if (source.scan_status === 'quarantined') throw conflict('This upload is still being scanned.');
  if (source.scan_status === 'rejected') throw forbidden('The malware scanner rejected this upload.');

  const raw = sheetRows(ctx, source, plan.sheet_name);
  const { rows, rejections, headers } = normalizeRows(raw, plan);

  // A row is "the same row" only within the place it was imported into. A private import matches the
  // importer's own private rows; a unit import matches that unit's shared rows. Without both halves
  // of that, two people importing the same identifier overwrite each other's work.
  const existing = plan.visibility === 'private'
    ? ctx.db.prepare(
      `SELECT id, natural_key, row_hash, title, reference, due_date, amount, amount_type, quantity, unit_label, state, claimed_by
         FROM work_items WHERE owner_id = ? AND visibility = 'private' AND unit_id IS ? AND deleted_at IS NULL`
    ).all(user.id, plan.unit_id) as Array<Record<string, unknown>>
    : ctx.db.prepare(
      `SELECT id, natural_key, row_hash, title, reference, due_date, amount, amount_type, quantity, unit_label, state, claimed_by
         FROM work_items WHERE unit_id IS ? AND visibility = 'unit' AND deleted_at IS NULL`
    ).all(plan.unit_id) as Array<Record<string, unknown>>;
  const byKey = new Map(existing.map((e) => [String(e.natural_key), e]));

  const willInsert: NormalizedRow[] = [];
  const willUpdate: PreviewResult['will_update'] = [];
  let unchanged = 0;

  for (const row of rows) {
    const match = byKey.get(row.natural_key);
    if (!match) { willInsert.push(row); continue; }
    if (match.row_hash === row.row_hash) { unchanged += 1; continue; }
    const changes = CHANGE_FIELDS.filter((f) => String(match[f] ?? '') !== String(row[f] ?? ''));
    willUpdate.push({ ...row, existing_id: String(match.id), claimed_by: (match.claimed_by as string | null) ?? null, changes });
  }

  return {
    headers, sheet_name: plan.sheet_name, total_rows: rows.length,
    will_insert: willInsert, will_update: willUpdate, unchanged, rejections,
    notes: JSON.parse(source.notes || '[]'),
  };
}

export interface ImportJobRow {
  id: string; source_file_id: string; user_id: string; unit_id: string | null; visibility: string;
  sheet_name: string; header_row: number; mapping: string; key_columns: string;
  status: string; total_rows: number; processed_rows: number; inserted_rows: number; updated_rows: number;
  unchanged_rows: number; rejected_rows: number; rejections: string; error: string | null;
  started_at: string | null; finished_at: string | null; created_at: string; updated_at: string;
}

/**
 * Runs an import as a recorded job. The whole apply happens in one transaction, so the job's
 * counters and the rows it created either both exist or neither does.
 *
 * An idempotency key makes a retried request return the original job rather than importing twice.
 */
export function runImport(
  ctx: AppContext,
  user: SessionUser,
  scope: Scope,
  plan: ImportPlan,
  sourceId: string,
  idempotencyKey: string | null,
): ImportJobRow {
  if (idempotencyKey) {
    const prior = ctx.db.prepare('SELECT * FROM import_jobs WHERE idempotency_key = ?').get(`${user.id}:${idempotencyKey}`) as ImportJobRow | undefined;
    if (prior) return prior;
  }
  const preview = previewImport(ctx, user, scope, plan, sourceId);
  const jobId = newId();
  const at = now();

  ctx.db.prepare(
    `INSERT INTO import_jobs (id, source_file_id, user_id, unit_id, visibility, sheet_name, header_row, mapping, key_columns, status, total_rows, rejections, idempotency_key, started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`
  ).run(
    jobId, sourceId, user.id, plan.unit_id, plan.visibility, plan.sheet_name, plan.header_row,
    JSON.stringify(plan.mapping), JSON.stringify(plan.key_columns),
    preview.total_rows, JSON.stringify(preview.rejections.slice(0, 500)),
    idempotencyKey ? `${user.id}:${idempotencyKey}` : null, at, at, at,
  );

  const insert = ctx.db.prepare(
    `INSERT INTO work_items (id, unit_id, owner_id, visibility, source_file_id, import_job_id, natural_key, row_hash, source_row,
                             title, reference, due_date, amount, amount_type, quantity, unit_label, state, data, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  );
  const update = ctx.db.prepare(
    `UPDATE work_items
        SET row_hash = ?, source_row = ?, title = ?, reference = ?, due_date = ?, amount = ?, amount_type = ?,
            quantity = ?, unit_label = ?, data = ?, import_job_id = ?, source_file_id = ?,
            source_changed_at = CASE WHEN claimed_by IS NOT NULL THEN ? ELSE source_changed_at END,
            version = version + 1, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL AND unit_id IS ? AND visibility = ? AND (visibility = 'unit' OR owner_id = ?)`
  );

  try {
    ctx.db.transaction(() => {
      for (const row of preview.will_insert) {
        insert.run(newId(), plan.unit_id, user.id, plan.visibility, sourceId, jobId, row.natural_key, row.row_hash, row.source_row,
          row.title, row.reference, row.due_date, row.amount, row.amount_type, row.quantity, row.unit_label, row.state, JSON.stringify(row.data), at, at);
      }
      for (const row of preview.will_update) {
        // A person's own state and claim survive a reimport. The source describes the work, not who is doing it.
        // The same predicate the match was made under, restated at the write. A row that moved between
        // the preview and the commit is simply not updated rather than updated by the wrong person.
        update.run(row.row_hash, row.source_row, row.title, row.reference, row.due_date, row.amount, row.amount_type,
          row.quantity, row.unit_label, JSON.stringify(row.data), jobId, sourceId, at, at, row.existing_id,
          plan.unit_id, plan.visibility, user.id);
      }
      ctx.db.prepare(
        `UPDATE import_jobs SET status = 'completed', processed_rows = ?, inserted_rows = ?, updated_rows = ?, unchanged_rows = ?, rejected_rows = ?, finished_at = ?, updated_at = ? WHERE id = ?`
      ).run(preview.total_rows, preview.will_insert.length, preview.will_update.length, preview.unchanged, preview.rejections.length, now(), now(), jobId);
    })();
  } catch (e) {
    ctx.db.prepare(`UPDATE import_jobs SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
      .run(String((e as Error).message).slice(0, 500), now(), now(), jobId);
    throw e;
  }

  record(ctx, 'import.committed', {
    inserted: preview.will_insert.length,
    updated: preview.will_update.length,
    unchanged: preview.unchanged,
    rejected: preview.rejections.length,
    // An import that changed nothing is the same spreadsheet again, which is worth telling apart.
    reimport: preview.will_insert.length === 0 && preview.total_rows > 0,
  }, { id: user.id });
  return ctx.db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(jobId) as ImportJobRow;
}

/** Jobs left running by a restart are marked failed on boot, so no job sits pending forever. */
export function reconcileInterruptedJobs(ctx: AppContext): number {
  const result = ctx.db.prepare(
    `UPDATE import_jobs SET status = 'failed', error = 'This import was interrupted when the server restarted. Nothing was left half-applied; run it again.', finished_at = ?, updated_at = ? WHERE status IN ('pending', 'running')`
  ).run(now(), now());
  return result.changes;
}
