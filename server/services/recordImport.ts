import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { z } from 'zod';
import type { AppContext, SessionUser } from '../context.ts';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { readZip, ZipError } from '../lib/zip.ts';
import { readWorkbook, WorkbookError } from '../lib/workbook.ts';
import { scopeFor, type Scope } from '../authz/scope.ts';
import { canEdit, canPlace, type RecordRow } from '../authz/records.ts';
import { TABLES, activityFingerprint, capacityProblem, createRecord, getRecord, updateRecord } from './records.ts';
import { saveCareerStep } from './record.ts';
import { inspectAttachment } from './attachments.ts';
import { scanUpload } from './scanner.ts';
import { featureOn } from './instanceFlags.ts';
import { sourcedFieldsFor } from './personnel.ts';
import { withPersonnelNote } from './personnelRecords.ts';
import { audit } from './audit.ts';
import { attachmentPath } from './personalExport.ts';
import { infrastructureBodyProblem, infrastructureFileProblem, DATA_EXPORT_FORMATS } from '../../shared/dataTransfer.ts';
import { parseDelimited, toISODate, MAX_IMPORT_COLUMNS } from '../../shared/csv.ts';
import { prefsSchema, profileSchema, readinessSchema, type RecordTable } from '../../shared/schemas.ts';
import { careerProfileSchema, careerStepSchema } from '../../shared/recordSchemas.ts';
import { screenImport } from '../../shared/duplicates.ts';
import { isDrawnFromWork, isMovableTable, kindText, movedFields, recordKindOf } from '../../shared/recordKinds.ts';
import {
  DUTY_NOT_IMPORTED, IMPORT_TABLES, PERSONAL_FORMAT, PROFILE_COLUMNS, READINESS_COLUMNS, RECORD_COLUMNS, RECORD_FORMAT, DELETED_AT_HEADER,
  TABLE_LABELS, guessColumns, isImportTable, isRecordTypeHeader, readCell, readRow, routeFor, tableFromHeaders,
  type ImportResults, type ImportReview, type ImportReviewRow, type ImportTable, type RowOutcome, type RouteTarget,
} from '../../shared/recordTransfer.ts';

/**
 * A person's import of their own records (ADR-0019): Upload, Detect, Map, Validate, Duplicate check, Preview, Correct,
 * Import, Results, Audit, and Undo.
 *
 * The file is held on the server while its owner reviews it. Every review is the import itself, run inside a transaction
 * that is rolled back, through the same createRecord and updateRecord a form uses, so what the review says is what the
 * import does: the same placement rules, the same timeframe checks, the same duplicate refusals. The import is that run
 * again, kept, in one transaction.
 *
 * It writes only the importer's own account. Ids in a file are never trusted to name a record here: a Vantage export's
 * record that is already here is left as it is, and a spreadsheet's Vantage ID updates a record only when it is the
 * importer's own. Each record goes where its owner may place it now, else private: never into a Unit Instance they do
 * not serve in. Rows that read like an award or a course are offered to their owner, never moved for them (ADR-0015).
 */

type Row = Record<string, unknown>;
type SourceKind = ImportReview['source'];

/** The most rows a spreadsheet import reads, across its sheets. A Vantage export may hold up to the account's record limit. */
export const IMPORT_MAX_ROWS = 5000;
/** A Vantage export's records, at most: as many as an account holds by default (VANTAGE_MAX_RECORDS_PER_USER). */
export const IMPORT_MAX_RECORDS = 20_000;
const ATTACHABLE = new Set<string>(['activities', 'awards', 'counselings', 'trainings', 'tasks', 'projects', 'goals']);
/** Fields that name people or records here. A file never sets them: the import does, or nothing does. */
const NEVER_FROM_FILE = ['id', 'user_id', 'assignee_id', 'counselor_id', 'recorded_by', 'fingerprint', 'kind_confirmed_at', 'frozen_at', 'deleted_at', 'version'];

// ——— The plan: what the person chose ———

const fixValue = z.union([z.string().max(8000), z.number(), z.boolean(), z.null(), z.array(z.string().max(2000)).max(20)]);
export const importPlanSchema = z.object({
  sheets: z.record(z.string().max(120), z.object({
    table: z.enum([...IMPORT_TABLES, 'skip', 'duty', 'profile'] as [string, ...string[]]).optional(),
    mapping: z.record(z.string().max(60), z.string().max(200)).optional(),
  })).optional(),
  rows: z.record(z.string().max(200), z.object({
    include: z.boolean().optional(),
    as: z.enum(IMPORT_TABLES).optional(),
    fix: z.record(z.string().max(60), fixValue).optional(),
  })).optional(),
  placement: z.enum(['keep', 'private']).optional(),
  profile: z.enum(['skip', 'fill', 'replace']).optional(),
  attachments: z.boolean().optional(),
}).strict();
/** The commit carries the plan as last shown, and what the review said it would do, so a change in between stops it. */
export const importCommitSchema = importPlanSchema.extend({
  expected: z.object({ new: z.number().int().min(0), update: z.number().int().min(0) }).optional(),
}).strict();
export type ImportPlan = z.infer<typeof importPlanSchema> & { scanned?: Record<string, string> };

// ——— Reading the file ———

interface Candidate {
  ref: string; source: string;
  from: ImportTable | 'duty';
  /** The record's id in the file. */
  sourceId: string | null;
  record: Row;
  problem: string | null; fieldErrors: Record<string, string>;
  /** From a Vantage export, whose records already here are never overwritten; else a spreadsheet, whose Vantage ID updates. */
  vantage: boolean;
  deleted: boolean;
  author: string | null;
  fingerprint: string | null;
  sourceProject: string | null;
}

interface AttachmentIn { ref: string; path: string; name: string; mime: string; table: string; sourceRecordId: string; data: Buffer | null }

interface SheetInfo { name: string; headers: string[]; rows: Array<Record<string, string>>; table: ImportReview['sheets'][number]['table']; routedBy: ImportReview['sheets'][number]['routedBy']; mapping: Record<string, string>; preset: Row | null }

interface Source {
  kind: SourceKind;
  exported: ImportReview['exported'];
  notes: string[];
  candidates: Candidate[];
  sheets: SheetInfo[];
  profile: { user?: Row; readiness?: Row; career?: Row; prefs?: Row } | null;
  attachments: AttachmentIn[];
  notImported: ImportReview['notImported'];
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const str = (v: unknown) => (v == null ? '' : String(v));

/** What kind of file this is, refusing an infrastructure backup and the other data exports before anything is read. */
function detect(content: Buffer): { kind: SourceKind; json?: Row; files?: Map<string, Buffer> } {
  const backup = infrastructureFileProblem(content);
  if (backup) throw badRequest(backup, { code: 'infrastructure_file' });
  if (content[0] === 0x50 && content[1] === 0x4b) {
    let files: Map<string, Buffer>;
    try { files = readZip(content, { maxEntries: 10_000, maxEntryBytes: 64 * 1024 * 1024, maxTotalBytes: 192 * 1024 * 1024 }); }
    catch (e) { if (e instanceof ZipError) throw badRequest(e.message); throw e; }
    if (files.has('xl/workbook.xml')) return { kind: 'xlsx' };
    const doc = files.get('vantage-export.json') ?? files.get('record.json');
    if (!doc) throw badRequest('That ZIP is not a Vantage export: it has no vantage-export.json. Choose the ZIP Vantage gave you, a workbook, a CSV or a JSON export.');
    return { kind: 'vantage_zip', json: parseJson(doc), files };
  }
  const text = content.toString('utf8').replace(/^\uFEFF/, '');
  if (text.trimStart().startsWith('{')) return { kind: 'vantage_json', json: parseJson(content) };
  if (text.includes('\u0000')) throw badRequest('That file is not one Vantage reads. Choose a Vantage export (ZIP or JSON), a workbook (.xlsx) or a CSV.');
  return { kind: 'csv' };
}

function parseJson(buf: Buffer): Row {
  let doc: unknown;
  try { doc = JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); } catch { throw badRequest('That JSON file could not be read.'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw badRequest('That JSON file is not a Vantage export.');
  const archive = infrastructureBodyProblem(doc);
  if (archive) throw badRequest(archive, { code: 'infrastructure_file' });
  const format = (doc as Row).format;
  if (format === PERSONAL_FORMAT || format === RECORD_FORMAT) return doc as Row;
  if (typeof format === 'string' && (DATA_EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw badRequest(format === 'vantage-unit-configuration/1'
      ? 'That is a unit configuration file. Unit Managers load it in the Unit Manager console (Imports and exports).'
      : 'That is a Unit Instance structure file, a copy for the command’s own files. It holds no records to import.', { code: 'wrong_export' });
  }
  throw badRequest('That JSON file is not a Vantage personal export.');
}

const titleOf = (table: ImportTable | 'duty', r: Row) => str(table === 'awards' || table === 'projects' ? r.name : table === 'counselings' ? r.summary : r.title).slice(0, 140);
const dateOf = (table: ImportTable | 'duty', r: Row) => str(table === 'tasks' || table === 'career_steps' ? r.due_date : table === 'goals' ? r.period_end ?? r.period_start : table === 'projects' ? r.start_date ?? r.target_date : r.date) || null;
const CAREER_FIELDS = ['title', 'category', 'status', 'due_date', 'notes', 'source_label', 'source_url', 'source_checked_on'];

/** A record's own fields from a Vantage export row: never its id, owner, counselor or assignee, which name people here. */
function ownFields(table: ImportTable, row: Row): Row {
  const out: Row = {};
  const fields = table === 'career_steps' ? CAREER_FIELDS : TABLES[table as RecordTable].fields;
  for (const f of fields) if (row[f] !== undefined) out[f] = row[f];
  if (table !== 'career_steps') { out.visibility = row.visibility; out.unit_id = row.unit_id ?? null; }
  if (table === 'activities' && row.kind_confirmed_at) out.kind_confirmed = true;
  return out;
}

function fromVantage(doc: Row, files: Map<string, Buffer> | null, kind: SourceKind): Source {
  const notes: string[] = [];
  const single = doc.format === RECORD_FORMAT;
  const records: Record<string, Row[]> = single
    ? (isImportTable(doc.table) ? { [doc.table as string]: [doc.record as Row] } : {})
    : ((doc.records && typeof doc.records === 'object' ? doc.records : {}) as Record<string, Row[]>);
  const profileDoc = (doc.profile && typeof doc.profile === 'object' ? doc.profile : null) as Row | null;
  const ownerDoc = (doc.owner && typeof doc.owner === 'object' ? doc.owner : null) as Row | null;
  const owner = str(profileDoc?.id ?? ownerDoc?.id ?? (single ? (doc.record as Row | undefined)?.user_id : ''));
  const candidates: Candidate[] = [];
  const notImported: ImportReview['notImported'] = [];
  const skipped = { about: 0, assigned: 0 };
  let truncated = false;
  for (const table of IMPORT_TABLES) {
    const rows = table === 'career_steps' ? ((doc.career as Row | null | undefined)?.steps as Row[] | undefined) ?? [] : Array.isArray(records[table]) ? records[table] : [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      if (candidates.length >= IMPORT_MAX_RECORDS) { truncated = true; break; }
      const ownerOf = str(raw.user_id);
      // What the Marine wrote about someone else, and what someone else set them, stay in that person's records.
      if (owner && ownerOf && ownerOf !== owner && table !== 'career_steps') {
        if (table === 'counselings' || table === 'awards') skipped.about += 1; else skipped.assigned += 1;
        continue;
      }
      const record = ownFields(table, raw);
      let author: string | null = null;
      if (table === 'counselings' && raw.counselor_id && str(raw.counselor_id) !== owner) {
        author = str(raw.counselor_label || raw.counselor_name) || 'Another Marine';
        if (!record.counselor_name) record.counselor_name = author;
      }
      if (table === 'awards' && raw.recorded_by && str(raw.recorded_by) !== owner) {
        author = str(raw.recorder_label) || 'Another Marine';
        if (!record.recommending_official) record.recommending_official = author;
      }
      const sourceId = str(raw.id) || null;
      candidates.push({
        ref: `${table}:${sourceId ?? candidates.length}`, source: `${TABLE_LABELS[table].many} in the export`, from: table, sourceId, record,
        problem: null, fieldErrors: {}, vantage: true, deleted: Boolean(raw.deleted_at), author,
        fingerprint: table === 'activities' && isDrawnFromWork(raw.fingerprint) ? str(raw.fingerprint) : null,
        sourceProject: raw.project_id ? str(raw.project_id) : null,
      });
    }
  }
  if (skipped.about) notImported.push({ key: 'about_others', label: 'Counselings and award recommendations you recorded about another Marine', count: skipped.about, reason: 'They are that Marine’s records, and stay in theirs.' });
  if (skipped.assigned) notImported.push({ key: 'assigned_by_others', label: 'Tasks and goals someone else set you', count: skipped.assigned, reason: 'They are the records of whoever set them, and stay in theirs.' });
  const counted = (key: string, label: string, value: unknown, reason: string) => { const n = Array.isArray(value) ? value.length : 0; if (n) notImported.push({ key, label, count: n, reason }); };
  const personnel = (doc.personnel ?? {}) as Row;
  counted('personnel', 'Personnel history', personnel.history, 'Those who manage your membership in each Unit Instance keep it; an import cannot write it.');
  counted('responsibilities', 'Responsibilities', personnel.responsibilities, 'Assigned by those who manage your membership; an import cannot assign them.');
  counted('memberships', 'Unit memberships and roles', [...(Array.isArray(doc.memberships) ? doc.memberships : []), ...(Array.isArray(doc.roles) ? doc.roles : [])], 'Units and roles are given by unit leaders and Unit Managers, never by a file.');
  counted('contributions', 'Financial case actions', doc.contributions, 'They are part of each case’s history and stay with the case in its Unit Instance. The activities drawn from them are imported.');
  counted('comments', 'Comments', doc.comments, 'Comments are conversations with other people on a record; they stay in the export.');
  counted('notifications', 'Notifications', doc.notifications, 'They stay in the export as a record of what Vantage told you.');
  counted('audit_trail', 'Audit trail', doc.audit_trail, 'The trail is the service’s record of what happened; it is never written from a file.');
  counted('drafts', 'Drafts from financial cases', doc.drafts, 'Drafts belong to the cases they were worded from.');
  counted('record_moves', 'Record moves', doc.record_moves, 'Imported records start their own history here.');

  const attachments: AttachmentIn[] = [];
  for (const a of (Array.isArray(doc.attachments) ? doc.attachments : []) as Row[]) {
    if (!a || typeof a !== 'object' || a.deleted_at) continue;
    const path = str(a.file) || attachmentPath(a);
    attachments.push({ ref: `file:${str(a.id) || path}`, path, name: str(a.original_name), mime: str(a.mime_type), table: str(a.record_table), sourceRecordId: str(a.record_id), data: files?.get(path) ?? null });
  }
  if (truncated) notes.push(`Imports read at most ${IMPORT_MAX_RECORDS.toLocaleString()} records from one file; only the first were read.`);
  if (kind === 'vantage_json' && attachments.length) notes.push(`The JSON names ${attachments.length} attached file${attachments.length === 1 ? '' : 's'} it does not carry. Import the ZIP to bring files back.`);

  let profile: Source['profile'] = null;
  const careerProfile = (doc.career as Row | null | undefined)?.profile as Row | null | undefined;
  if (profileDoc || doc.readiness || careerProfile) {
    profile = {};
    if (profileDoc) {
      const user: Row = {};
      for (const c of PROFILE_COLUMNS) if (profileDoc[c.key] != null && profileDoc[c.key] !== '') user[c.key] = profileDoc[c.key];
      const rank = profileDoc.rank as Row | null | undefined;
      if (rank?.abbr) user.rank_id = rank.abbr;
      profile.user = user;
      if (profileDoc.prefs && typeof profileDoc.prefs === 'object') profile.prefs = profileDoc.prefs as Row;
    }
    if (doc.readiness && typeof doc.readiness === 'object') profile.readiness = doc.readiness as Row;
    if (careerProfile) profile.career = { military_goal: careerProfile.military_goal ?? null, civilian_interests: careerProfile.civilian_interests ?? null };
  }
  return {
    kind, notes, candidates, sheets: [], profile, attachments, notImported,
    exported: { username: str(profileDoc?.username ?? ownerDoc?.username) || null, exported_at: str(doc.exported_at) || null, display_name: str((doc.instance as Row | undefined)?.display_name) || null },
  };
}

/** A sheet's cells as rows keyed by header. Blank headers are named by their column; repeated ones are numbered. */
function keyed(matrix: string[][]): { headers: string[]; rows: Array<Record<string, string>> } {
  const body = matrix.filter((cells) => cells.some((v) => String(v ?? '').trim() !== ''));
  if (!body.length) return { headers: [], rows: [] };
  const seen = new Map<string, number>();
  const headers = body.shift()!.slice(0, MAX_IMPORT_COLUMNS).map((h, i) => {
    let header = String(h ?? '').trim() || `Column ${i + 1}`;
    const n = (seen.get(header.toLowerCase()) ?? 0) + 1;
    seen.set(header.toLowerCase(), n);
    if (n > 1) header = `${header} (${n})`;
    return header;
  });
  return { headers, rows: body.map((cells) => Object.fromEntries(headers.map((h, i) => [h, String(cells[i] ?? '')]))) };
}

function routeSheet(name: string, headers: string[], plan: ImportPlan, byFile: boolean): Pick<SheetInfo, 'table' | 'routedBy' | 'preset'> {
  const chosen = plan.sheets?.[name]?.table;
  const named = routeFor(name) ?? (byFile ? fileRoute(name) : null);
  const preset = named && 'preset' in named ? named.preset ?? null : null;
  // A sheet named for a kind (Certifications, Volunteer) keeps it while it is read as the record type its name says.
  if (chosen) return { table: chosen as SheetInfo['table'], routedBy: 'chosen', preset: named && chosen === named.table ? preset : null };
  if (headers.some(isRecordTypeHeader)) return { table: 'record_type', routedBy: 'record_type', preset: null };
  if (named) return { table: named.table, routedBy: byFile ? 'file' : 'sheet', preset };
  const fit = tableFromHeaders(headers);
  if (fit) return { table: fit, routedBy: 'headers', preset: null };
  // A sheet that names nothing but has a title and a date is read as activities, as the activity CSV import always read one.
  const activity = guessColumns(RECORD_COLUMNS.activities, headers);
  if (activity.title && activity.date) return { table: 'activities', routedBy: 'headers', preset: null };
  return { table: 'skip', routedBy: 'none', preset: null };
}

/** A file name's words, for a file named like an export ("vantage-boletz-awards-2026-10-28.csv"). */
function fileRoute(filename: string): RouteTarget | null {
  const words = filename.replace(/\.[a-z]+$/i, '').split(/[-_. ]+/).filter((w) => w && !/^\d+$/.test(w) && w.toLowerCase() !== 'vantage');
  for (let i = 0; i < words.length; i += 1) {
    const two = i + 1 < words.length ? routeFor(`${words[i]} ${words[i + 1]}`) : null;
    if (two) return two;
    const one = routeFor(words[i]);
    if (one) return one;
  }
  return null;
}

function fromSpreadsheet(content: Buffer, kind: 'csv' | 'xlsx', filename: string, plan: ImportPlan): Source {
  const notes: string[] = [];
  let raw: Array<{ name: string; matrix: string[][] }>;
  if (kind === 'xlsx') {
    let book;
    try { book = readWorkbook(content, { maxRows: IMPORT_MAX_ROWS + 1, maxColumns: MAX_IMPORT_COLUMNS }); }
    catch (e) { if (e instanceof WorkbookError || e instanceof ZipError) throw badRequest(e.message); throw e; }
    notes.push(...book.notes);
    for (const s of book.sheets) if (s.truncated) notes.push(`The sheet "${s.name}" has more than ${IMPORT_MAX_ROWS} rows; only the first ${IMPORT_MAX_ROWS} were read.`);
    raw = book.sheets.map((s) => ({ name: s.name, matrix: s.rows }));
  } else {
    const text = content.toString('utf8').replace(/^\uFEFF/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
    const delimiter = (firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',') as ',' | '\t';
    try { raw = [{ name: filename || 'CSV', matrix: parseDelimited(text, delimiter, { maxRows: IMPORT_MAX_ROWS }) }]; }
    catch (e) { throw badRequest((e as Error).message); }
  }
  const candidates: Candidate[] = [];
  const sheets: SheetInfo[] = [];
  let profile: Source['profile'] = null;
  let total = 0;
  const blank = (ref: string, source: string, from: Candidate['from'], record: Row, problem: string | null, fieldErrors: Record<string, string> = {}): Candidate =>
    ({ ref, source, from, sourceId: null, record, problem, fieldErrors, vantage: false, deleted: false, author: null, fingerprint: null, sourceProject: null });
  raw.forEach((sheet, s) => {
    const { headers, rows } = keyed(sheet.matrix);
    if (!headers.length) return;
    const route = routeSheet(sheet.name, headers, plan, kind === 'csv');
    const table = route.table;
    const mapping: Record<string, string> = isImportTable(table) ? { ...guessColumns(RECORD_COLUMNS[table], headers.filter((h) => h.toLowerCase() !== DELETED_AT_HEADER.toLowerCase())), ...(plan.sheets?.[sheet.name]?.mapping ?? {}) } : {};
    // A mapping names only this sheet's own headers.
    for (const [field, header] of Object.entries(mapping)) if (!header || !headers.includes(header)) delete mapping[field];
    sheets.push({ name: sheet.name, headers, rows, table, routedBy: route.routedBy, mapping, preset: route.preset });
    if (table === 'skip') return;
    if (table === 'profile') {
      const row = rows[0] ?? {};
      const userMap = guessColumns(PROFILE_COLUMNS, headers);
      const readinessMap = guessColumns(READINESS_COLUMNS, headers);
      const user: Row = {}; const readiness: Row = {};
      for (const c of PROFILE_COLUMNS) { const v = userMap[c.key] ? row[userMap[c.key]]?.trim() : ''; if (v) user[c.key] = c.key === 'rank_id' ? v : readCell(c, v).value; }
      for (const c of READINESS_COLUMNS) { const v = readinessMap[c.key] ? row[readinessMap[c.key]]?.trim() : ''; if (v) readiness[c.key] = readCell(c, v).value; }
      profile = { user, readiness };
      return;
    }
    const typeHeader = headers.find(isRecordTypeHeader);
    const deletedHeader = headers.find((h) => h.toLowerCase() === DELETED_AT_HEADER.toLowerCase());
    // On a sheet of several record types, each row's columns are read as its own type's, never the Record Type column.
    const fields = headers.filter((h) => h !== typeHeader && h !== deletedHeader);
    const mappings = new Map<ImportTable, Record<string, string>>();
    const mappingFor = (t: ImportTable) => { if (!mappings.has(t)) mappings.set(t, t === table ? mapping : guessColumns(RECORD_COLUMNS[t], fields)); return mappings.get(t)!; };
    rows.forEach((row, i) => {
      if (total >= IMPORT_MAX_ROWS) return;
      total += 1;
      const ref = `s${s}r${i + 2}`;
      const where = `${sheet.name}, row ${i + 2}`;
      let target: { table: ImportTable | 'duty' | 'profile'; preset?: Row } | null = isImportTable(table) || table === 'duty' ? { table, preset: route.preset ?? undefined } : null;
      if (table === 'record_type') {
        const said = String(row[typeHeader!] ?? '').trim();
        target = routeFor(said);
        // A row whose Record Type Vantage does not know is read as what the person says it is, once they say.
        const chosen = plan.rows?.[ref]?.as;
        if ((!target || target.table === 'profile') && chosen) target = { table: chosen };
        if (!target || target.table === 'profile') {
          candidates.push(blank(ref, where, 'activities', {}, said ? `Record Type “${said.slice(0, 40)}” is not one Vantage knows. Choose what it is.` : 'Record Type is empty. Choose what it is.', { record_type: 'Unknown.' }));
          return;
        }
      }
      if (!target || target.table === 'profile') return;
      if (target.table === 'duty') {
        // Listed, never imported: what the duty was and the day it was stood, as the person would know it.
        const cells = Object.entries(row).filter(([, v]) => v.trim());
        const date = cells.map(([, v]) => toISODate(v.trim())).find(Boolean) ?? null;
        const title = cells.find(([h]) => /duty|title|name|post|watch|billet/i.test(h))?.[1] ?? cells.find(([, v]) => !toISODate(v.trim()))?.[1] ?? '';
        candidates.push(blank(ref, where, 'duty', { title: title.trim(), date }, null));
        return;
      }
      const t = target.table;
      const read = readRow(t, row, mappingFor(t));
      // A sheet's preset fills what the row does not say: the type on an Education sheet, the category on a Volunteer one.
      if (target.preset) for (const [k, v] of Object.entries(target.preset)) if (!mappingFor(t)[k] || read.record[k] == null || read.record[k] === '') read.record[k] = v;
      const sourceId = read.record.id ? String(read.record.id) : null;
      candidates.push({ ...blank(ref, where, t, read.record, read.problem, read.fieldErrors), sourceId, deleted: Boolean(deletedHeader && String(row[deletedHeader] ?? '').trim()) });
    });
  });
  if (total >= IMPORT_MAX_ROWS) notes.push(`Imports read at most ${IMPORT_MAX_ROWS} rows; split a larger file.`);
  const duty = candidates.filter((c) => c.from === 'duty').length;
  return {
    kind, exported: null, notes, candidates, sheets, profile, attachments: [],
    notImported: duty ? [{ key: 'duty', label: 'Duty rows', count: duty, reason: DUTY_NOT_IMPORTED }] : [],
  };
}

function readSource(content: Buffer, filename: string, plan: ImportPlan): Source {
  const found = detect(content);
  if (found.kind === 'vantage_json' || found.kind === 'vantage_zip') return fromVantage(found.json!, found.files ?? null, found.kind);
  return fromSpreadsheet(content, found.kind, filename, plan);
}

// ——— Running it: the review is this, rolled back ———

/** A record's key for "already here": the same thing on the same day, by its record type's own words. */
function contentKey(table: ImportTable, r: Row): string {
  const t = (v: unknown) => str(v).trim().toLowerCase().replace(/\s+/g, ' ');
  switch (table) {
    // Only what every source says: a spreadsheet without a Type column must still find the award it imported before.
    case 'trainings': return [t(r.title), str(r.date)].join('|');
    case 'awards': return [t(r.name), str(r.date)].join('|');
    case 'counselings': return [str(r.date), createHash('sha256').update(t(r.summary)).digest('hex').slice(0, 16)].join('|');
    case 'goals': return [t(r.title), str(r.period_end)].join('|');
    case 'projects': return [t(r.name), str(r.start_date)].join('|');
    case 'tasks': return [t(r.title), str(r.due_date)].join('|');
    case 'career_steps': return [t(r.title), str(r.category)].join('|');
    default: return '';
  }
}

interface Origin { table: string; id: string; action: 'created' | 'updated' | 'attached' | 'profile'; sourceId: string | null; ref: string | null; author: string | null; before: Row | null; versionAfter: number | null }

interface RunState {
  rows: ImportReviewRow[];
  created: Map<string, { table: ImportTable; id: string }>;
  origins: Origin[];
  attachments: ImportReview['attachments'];
  profile: ImportReview['profile'];
  results: ImportResults;
  notes: string[];
}

const EMPTY_COUNTS = (): Record<RowOutcome, number> => ({ new: 0, update: 0, unchanged: 0, present: 0, duplicate: 0, problem: 0, excluded: 0, not_imported: 0 });
const ROLLBACK = Symbol('rollback');

/** A refusal the person can act on: shown on the row, the rest of the import carries on. Anything else stops it all. */
const isRefusal = (e: unknown) => e instanceof HttpError || /^SQLITE_CONSTRAINT/.test(String((e as { code?: string })?.code ?? ''));

/**
 * Run the import as planned. In review it runs inside a transaction that is rolled back and reports what each row would
 * do; in commit it runs the same inside the transaction that keeps it.
 */
function runImport(ctx: AppContext, user: SessionUser, importId: string, source: Source, plan: ImportPlan, review: boolean, reqKey: object, ip?: string): RunState {
  const scope = scopeFor(ctx, user, reqKey);
  const state: RunState = {
    rows: [], created: new Map(), origins: [], profile: null, notes: [],
    attachments: { total: source.attachments.length, included: 0, problems: [], enabled: ctx.runtime.attachmentsEnabled },
    results: { created: {}, updated: {}, attachments: 0, profile: [], skipped: 0 },
  };
  const placementMode = plan.placement ?? 'keep';
  const choices = plan.rows ?? {};
  const seenKeys = new Map<string, string>();
  const projectIds = new Map<string, string>();
  const twins = twinIndex(ctx, user.id);

  const ordered = [...source.candidates].sort((a, b) => order(targetOf(a, choices)) - order(targetOf(b, choices)));
  const near = nearDuplicates(ctx, user.id, ordered.filter((c) => targetOf(c, choices) === 'activities'));

  for (const c of ordered) {
    const choice = choices[c.ref] ?? {};
    const as = targetOf(c, choices);
    let record = convert(c, as);
    if (as !== 'duty' && choice.fix) record = { ...record, ...sanitizeFix(as, choice.fix) };
    for (const k of NEVER_FROM_FILE) delete record[k];
    // A link to a project is kept only to the project this import brings in (or finds here) for it.
    delete record.project_id;
    if (c.vantage && c.sourceProject && (as === 'activities' || as === 'tasks')) record.project_id = projectIds.get(c.sourceProject) ?? null;
    const base: ImportReviewRow = {
      ref: c.ref, source: c.source, from: c.from, as, title: titleOf(as, record) || titleOf(c.from, c.record), date: dateOf(as, record),
      outcome: 'new', reason: null, include: true, toggle: true, suggestion: suggestionFor(c, as), placement: null, author: c.author, fields: record,
    };
    const push = (outcome: RowOutcome, extra: Partial<ImportReviewRow> = {}) => { state.rows.push({ ...base, outcome, ...extra }); };
    if (as === 'duty') { push('not_imported', { reason: DUTY_NOT_IMPORTED, include: false, toggle: false }); continue; }
    const fixed = Boolean(choice.fix && Object.keys(choice.fix).length) || Boolean(choice.as && choice.as !== c.from);
    if (c.problem && !fixed) { push('problem', { reason: c.problem, fieldErrors: c.fieldErrors, include: false, toggle: false }); continue; }

    // Already here: a Vantage export's record is never overwritten; a spreadsheet's Vantage ID updates the person's own.
    const mine = c.sourceId ? ownRecord(ctx, as, c.sourceId, user.id) : null;
    if (mine) {
      const ref = { table: as, id: String(mine.id), title: titleOf(as, mine) };
      if (as === 'projects') projectIds.set(c.sourceId!, String(mine.id));
      if (mine.deleted_at) { push('present', { reason: 'It is in your recycle bin here. Restore it from there.', include: false, toggle: false, duplicateOf: ref }); continue; }
      if (c.vantage) { push('present', { reason: 'Already in Vantage. An import never overwrites a record that is here.', include: false, toggle: false, duplicateOf: ref }); continue; }
      if (choice.include === false) { push('excluded', { reason: 'You left it out.', duplicateOf: ref }); continue; }
      const outcome = updateOne(ctx, user, scope, as, mine, record, placementMode, reqKey, ip, state, c);
      push(outcome.outcome, outcome.extra);
      continue;
    }
    if (c.deleted && choice.include !== true) { push('excluded', { reason: 'It was in the recycle bin when it was exported.', include: false }); continue; }
    if (choice.include === false) { push('excluded', { reason: 'You left it out.', include: false }); continue; }

    // Imported before, the same thing already here, or twice in this file.
    const before = c.sourceId ? importedBefore(ctx, user.id, as, c.sourceId) : null;
    const fingerprint = as === 'activities' ? (c.fingerprint && as === c.from ? importedWorkFingerprint(user.id, c.fingerprint) : activityFingerprint(user.id, record as never)) : null;
    const key = as === 'activities' ? fingerprint! : contentKey(as, record);
    const twin = seenKeys.get(`${as}:${key}`);
    const same = before ?? twins(as, key);
    if (twin || same) {
      if (as === 'projects' && same && c.sourceId) projectIds.set(c.sourceId, same.id);
      const reason = twin ? `The same as ${twin} in this file.` : before ? `Imported before, on ${before.at.slice(0, 10)}.` : 'The same is already in Vantage.';
      // An activity the account already holds can never go in twice; another record type may, when its owner says so.
      if (as === 'activities' || twin || choice.include !== true) {
        push('duplicate', { reason, include: false, toggle: as !== 'activities' && !twin, duplicateOf: same ? { table: as, id: same.id, title: same.title } : null });
        continue;
      }
    }
    seenKeys.set(`${as}:${key}`, c.source);

    // Where it goes: where the file put it, if its owner may place it there now; else private.
    const placed = place(ctx, scope, as, record, placementMode);
    const body: Row = { ...record, visibility: placed.visibility, unit_id: placed.unitId };
    if (as === 'goals' && placed.visibility === 'private' && body.measure_scope === 'unit') body.measure_scope = 'subject';
    try {
      const id = savepoint(ctx, () => insertOne(ctx, user, as, body, reqKey, ip, importId, fingerprint, review));
      state.created.set(c.ref, { table: as, id });
      if (as === 'projects' && c.sourceId) projectIds.set(c.sourceId, id);
      const notes: string[] = [];
      if (!placed.kept && placed.why) notes.push(placed.why);
      const nearOne = near.get(c.ref);
      if (nearOne) notes.push(`Looks like “${nearOne}” on the same day; leave it out if it is the same.`);
      if (c.author) notes.push(`Written by ${c.author}; it comes in as your own copy, marked as imported.`);
      push('new', { placement: placed.kept ? 'kept' : 'private', reason: notes.join(' ') || null });
      state.results.created[as] = (state.results.created[as] ?? 0) + 1;
      state.origins.push({ table: as, id, action: 'created', sourceId: c.sourceId, ref: c.source, author: c.author, before: null, versionAfter: 1 });
    } catch (e) {
      if (!isRefusal(e)) throw e;
      push('problem', { reason: (e as Error).message, fieldErrors: (e as HttpError).extra?.fieldErrors as Record<string, string> | undefined, include: false, toggle: false });
    }
  }

  // The account's record limit, once for all the import adds: counted here, where everything it adds is in.
  const capacity = capacityProblem(ctx, user.id, 0);
  if (capacity && Object.keys(state.results.created).length) {
    if (!review) throw new HttpError(507, capacity, 'record_quota');
    state.notes.push(`${capacity} Leave rows out until the import fits.`);
  }
  attachFiles(ctx, user, scope, source, plan, state);
  state.profile = profileChanges(ctx, user, source, plan, state, review);
  state.results.skipped = state.rows.filter((r) => r.outcome !== 'new' && r.outcome !== 'update').length;
  return state;
}

const order = (t: ImportTable | 'duty') => (t === 'duty' ? IMPORT_TABLES.length : IMPORT_TABLES.indexOf(t));
const targetOf = (c: Candidate, choices: NonNullable<ImportPlan['rows']>): ImportTable | 'duty' => (c.from === 'duty' ? 'duty' : choices[c.ref]?.as ?? c.from);

/** The row as the record type it goes into: as read, or carried across as a move carries it (shared/recordKinds.ts). */
function convert(c: Candidate, as: ImportTable | 'duty'): Row {
  if (as === 'duty' || as === c.from || c.from === 'duty') return { ...c.record };
  if (isMovableTable(c.from) && isMovableTable(as)) return { ...movedFields(c.from, c.record, as), visibility: c.record.visibility, unit_id: c.record.unit_id };
  // Between other types only the title carries; the rest is for its owner to fill in.
  const title = titleOf(c.from, c.record);
  const named = as === 'awards' || as === 'projects' ? { name: title } : as === 'counselings' ? { summary: title } : { title };
  return { ...named, visibility: c.record.visibility, unit_id: c.record.unit_id };
}

/** A correction, kept to the fields of the record type it goes into. */
function sanitizeFix(as: ImportTable, fix: Record<string, unknown>): Row {
  const columns = new Map(RECORD_COLUMNS[as].map((c) => [c.key, c]));
  for (const k of NEVER_FROM_FILE) columns.delete(k);
  // A set of pairs (a goal's filters) is typed as the spreadsheet holds it, and read the way the spreadsheet is.
  return Object.fromEntries(Object.entries(fix).filter(([k]) => columns.has(k))
    .map(([k, v]) => [k, columns.get(k)!.kind === 'json' && typeof v === 'string' ? readCell(columns.get(k)!, v).value : v]));
}

function suggestionFor(c: Candidate, as: ImportTable | 'duty'): ImportReviewRow['suggestion'] {
  if (as !== 'activities' || c.from !== 'activities' || c.record.kind_confirmed || c.fingerprint) return null;
  const reading = recordKindOf(kindText('activities', c.record));
  return reading ? { to: reading.kind === 'award' ? 'awards' : 'trainings', why: reading.why } : null;
}

function ownRecord(ctx: AppContext, table: ImportTable, id: string, userId: string): Row | null {
  if (table === 'career_steps') return (ctx.db.prepare('SELECT * FROM career_steps WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined) ?? null;
  const row = getRecord(ctx, table as RecordTable, id, { includeDeleted: true }) as Row | undefined;
  return row && row.user_id === userId ? row : null;
}

function importedBefore(ctx: AppContext, userId: string, table: ImportTable, sourceId: string): { id: string; title: string; at: string } | null {
  const hits = ctx.db.prepare(`SELECT record_id, created_at AS at FROM record_import_origins WHERE user_id = ? AND record_table = ? AND source_id = ? AND action = 'created' ORDER BY created_at DESC`).all(userId, table, sourceId) as Array<{ record_id: string; at: string }>;
  for (const h of hits) {
    const live = ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(h.record_id) as Row | undefined;
    if (live) return { id: h.record_id, title: titleOf(table, live), at: h.at };
  }
  return null;
}

/** The person's live records by their "same thing" key, read once per record type per run. */
function twinIndex(ctx: AppContext, userId: string) {
  const byTable = new Map<ImportTable, Map<string, { id: string; title: string }>>();
  return (table: ImportTable, key: string): { id: string; title: string } | null => {
    if (table === 'activities') return (ctx.db.prepare('SELECT id, title FROM activities WHERE user_id = ? AND fingerprint = ? AND deleted_at IS NULL').get(userId, key) as { id: string; title: string } | undefined) ?? null;
    if (!byTable.has(table)) {
      const index = new Map<string, { id: string; title: string }>();
      for (const r of ctx.db.prepare(`SELECT * FROM ${table} WHERE user_id = ? AND deleted_at IS NULL`).all(userId) as Row[]) index.set(contentKey(table, r), { id: String(r.id), title: titleOf(table, r) });
      byTable.set(table, index);
    }
    return byTable.get(table)!.get(key) ?? null;
  };
}

/**
 * An activity drawn from a financial case keeps saying so when it comes back (the timeline marks it, the FM work export
 * finds it), under a fingerprint of its own: the case it came from is in another Unit Instance, or none, never one here.
 */
const importedWorkFingerprint = (userId: string, fingerprint: string) => `work:import:${createHash('sha256').update(`${userId}|${fingerprint}`).digest('hex')}`;

function nearDuplicates(ctx: AppContext, userId: string, candidates: Candidate[]): Map<string, string> {
  const out = new Map<string, string>();
  if (!candidates.length) return out;
  const existing = ctx.db.prepare('SELECT id, title, date, dollar_amount, quantity FROM activities WHERE user_id = ? AND deleted_at IS NULL').all(userId) as Array<{ id: string; title: string; date: string | null; dollar_amount: number | null; quantity: number | null }>;
  const incoming = candidates.map((c) => ({ ...(c.record as { title?: string; date?: string; quantity?: number; dollar_amount?: number }), ref: c.ref }));
  for (const n of screenImport(incoming, existing).near) out.set(n.row.ref, str(n.match.title));
  return out;
}

function place(ctx: AppContext, scope: Scope, table: ImportTable, record: Row, mode: 'keep' | 'private'): { visibility: string; unitId: string | null; kept: boolean; why: string | null } {
  if (table === 'career_steps') return { visibility: 'private', unitId: null, kept: true, why: null };
  const spec = TABLES[table as RecordTable];
  const home = scope.homeUnitId ?? null;
  const wantedVisibility = record.visibility === 'unit' ? 'unit' : 'private';
  const wantedUnit = typeof record.unit_id === 'string' && record.unit_id ? record.unit_id : null;
  if (mode === 'private') return { visibility: 'private', unitId: home, kept: wantedVisibility === 'private' && (!wantedUnit || wantedUnit === home), why: 'Brought in private, as you chose.' };
  const unitId = wantedUnit ?? home;
  const exists = !unitId || Boolean(ctx.db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(unitId));
  if (exists && (wantedVisibility !== 'unit' || unitId) && canPlace(scope, wantedVisibility, unitId, spec.shareFlag, Boolean(spec.personal))) return { visibility: wantedVisibility, unitId, kept: true, why: null };
  return { visibility: 'private', unitId: home, kept: false, why: wantedUnit ? 'The unit it was in is not one you can place records in here, so it comes in private.' : 'You cannot share it there, so it comes in private.' };
}

/** A career step as its form takes it, or the reason it cannot be one. */
function careerInput(body: Row) {
  const parsed = careerStepSchema.safeParse(Object.fromEntries(CAREER_FIELDS.filter((f) => body[f] != null && body[f] !== '').map((f) => [f, body[f]])));
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'That is not a career step.', { fieldErrors: Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? '_'), i.message])) });
  return parsed.data as Row;
}

function insertOne(ctx: AppContext, user: SessionUser, table: ImportTable, body: Row, reqKey: object, ip: string | undefined, importId: string, fingerprint: string | null, review: boolean): string {
  if (table === 'career_steps') return String(saveCareerStep(ctx, user, null, careerInput(body)).id);
  const created = createRecord(ctx, user, table as RecordTable, body, reqKey, ip, { importId, fingerprint: fingerprint ?? undefined, review }) as Row;
  return String(created.id);
}

/** Run fn in its own savepoint: a refusal undoes only what fn wrote, and the import carries on to the next row. */
const savepoint = <T>(ctx: AppContext, fn: () => T): T => ctx.db.transaction(fn)();

/** A spreadsheet row with the Vantage ID of the person's own record: an update, of the columns the file has. */
function updateOne(ctx: AppContext, user: SessionUser, scope: Scope, table: ImportTable, current: Row, record: Row, mode: 'keep' | 'private', reqKey: object, ip: string | undefined, state: RunState, c: Candidate): { outcome: RowOutcome; extra: Partial<ImportReviewRow> } {
  const changes: Row = {};
  for (const [k, v] of Object.entries(record)) {
    if (k === 'visibility' || k === 'unit_id' || k === 'kind_confirmed') continue;
    const was = current[k];
    const same = k === 'evidence_links' || k === 'filters' ? JSON.stringify(v ?? []) === JSON.stringify(was ?? []) : (v ?? null) === (was ?? null) || (k === 'ongoing' && Boolean(v) === Boolean(was));
    if (!same) changes[k] = v;
  }
  if (mode === 'keep' && table !== 'career_steps') {
    if (record.visibility && record.visibility !== current.visibility) changes.visibility = record.visibility;
    if (record.unit_id !== undefined && (record.unit_id || null) !== (current.unit_id ?? null)) changes.unit_id = record.unit_id || null;
  }
  // "Only me" holds for a record the file updates too: what it changes is not shared on.
  if (mode === 'private' && table !== 'career_steps' && current.visibility !== 'private') {
    changes.visibility = 'private';
    if (table === 'goals' && current.measure_scope === 'unit') changes.measure_scope = 'subject';
  }
  const ref = { table, id: String(current.id), title: titleOf(table, current) };
  if (!Object.keys(changes).length) return { outcome: 'unchanged', extra: { reason: 'Its Vantage ID is your record, and the row says what it already says.', include: false, toggle: false, duplicateOf: ref } };
  if (table !== 'career_steps' && !canEdit(scope, user.id, current as unknown as RecordRow)) return { outcome: 'problem', extra: { reason: current.frozen_at ? 'That record is frozen because you left its unit.' : 'That record is not yours to edit.', include: false, toggle: false, duplicateOf: ref } };
  const stored = () => (ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(current.id) ?? {}) as Row;
  const was = stored();
  try {
    const saved = savepoint(ctx, () => (table === 'career_steps'
      ? saveCareerStep(ctx, user, String(current.id), careerInput({ ...current, ...changes }))
      : updateRecord(ctx, user, table as RecordTable, String(current.id), changes, reqKey, ip))) as Row;
    // What it said before, as stored, in every column the update changed: the row's own changes and what came with them
    // (its fingerprint; an assignment a record made private lets go). The undo writes these back as they are.
    const after = stored();
    const before: Row = {};
    for (const [k, v] of Object.entries(was)) if (k !== 'version' && k !== 'updated_at' && after[k] !== v) before[k] = v;
    state.results.updated[table] = (state.results.updated[table] ?? 0) + 1;
    state.origins.push({ table, id: String(current.id), action: 'updated', sourceId: c.sourceId, ref: c.source, author: null, before, versionAfter: Number(saved.version) });
    return { outcome: 'update', extra: { reason: `Updates your ${TABLE_LABELS[table].one}: ${Object.keys(changes).join(', ')}.`, duplicateOf: ref } };
  } catch (e) {
    if (!isRefusal(e)) throw e;
    return { outcome: 'problem', extra: { reason: (e as Error).message, fieldErrors: (e as HttpError).extra?.fieldErrors as Record<string, string> | undefined, include: false, toggle: false, duplicateOf: ref } };
  }
}

/** The files on records the import brings in, through the checks an upload takes: on, allowed, within limits, scanned. */
function attachFiles(ctx: AppContext, user: SessionUser, scope: Scope, source: Source, plan: ImportPlan, state: RunState) {
  const { attachments } = state;
  if (!source.attachments.length) return;
  const targets = new Map<string, { table: ImportTable; id: string }>();
  const byRef = new Map(state.rows.map((r) => [r.ref, r]));
  for (const c of source.candidates) {
    if (!c.sourceId) continue;
    const made = state.created.get(c.ref);
    if (made) { targets.set(`${c.from}:${c.sourceId}`, made); continue; }
    // A record already here takes the files it does not have yet: the same record, or the one an earlier import of it
    // made (a JSON restore first, its ZIP after), or the same thing the person already has.
    const row = byRef.get(c.ref);
    if ((row?.outcome === 'present' || row?.outcome === 'duplicate') && row.duplicateOf && !/recycle bin/.test(row.reason ?? '')) targets.set(`${c.from}:${c.sourceId}`, { table: row.duplicateOf.table, id: row.duplicateOf.id });
  }
  const problem = (name: string, reason: string) => attachments.problems.push({ name, reason });
  // The database keeps its recovery headroom, as an upload does (server/routes/records.ts): files stop at the threshold.
  let room = Infinity;
  try { if (ctx.db.name !== ':memory:') room = ctx.config.limits.maxDatabaseBytes - statSync(ctx.db.name).size; } catch { /* no file to measure */ }
  for (const a of source.attachments) {
    const target = targets.get(`${a.table}:${a.sourceRecordId}`);
    if (!target) continue;
    if (plan.attachments === false) { problem(a.name, 'You chose to leave files out.'); continue; }
    if (!ctx.runtime.attachmentsEnabled) { problem(a.name, 'Attachments are off on this service.'); continue; }
    if (!ATTACHABLE.has(target.table)) { problem(a.name, `A ${TABLE_LABELS[target.table].one} does not take files.`); continue; }
    if (!a.data) { problem(a.name, 'The file is not in the ZIP.'); continue; }
    // Every file is scanned at upload (stageImport); one the scan refused or never saw stays out.
    const scanned = plan.scanned?.[a.path];
    if (scanned !== 'clean' && scanned !== 'skipped') { problem(a.name, scanned ?? 'It is not where a Vantage export keeps files, so it was not scanned.'); continue; }
    const record = ctx.db.prepare(`SELECT * FROM ${target.table} WHERE id = ? AND deleted_at IS NULL`).get(target.id) as (RecordRow & Row) | undefined;
    if (!record || record.user_id !== user.id || !canEdit(scope, user.id, record)) { problem(a.name, 'Its record is not one you can add files to.'); continue; }
    if (!featureOn(ctx, 'attachments', record.unit_id, record.user_id)) { problem(a.name, 'Vantage has turned file attachments off for that Unit Instance.'); continue; }
    const count = (ctx.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE record_table = ? AND record_id = ? AND deleted_at IS NULL').get(target.table, target.id) as { n: number }).n;
    if (count >= ctx.config.attachments.maxPerRecord) { problem(a.name, `A record holds at most ${ctx.config.attachments.maxPerRecord} files.`); continue; }
    const inspected = inspectAttachment({ body: a.data, filename: a.name, contentType: a.mime, allowedTypes: ctx.config.attachments.allowedTypes, maxBytes: ctx.config.attachments.maxBytes });
    if (!inspected.ok) { problem(a.name, inspected.error); continue; }
    if (ctx.db.prepare('SELECT 1 FROM attachments WHERE record_table = ? AND record_id = ? AND sha256 = ? AND deleted_at IS NULL').get(target.table, target.id, inspected.sha256)) { problem(a.name, 'That file is already on the record.'); continue; }
    if (inspected.size >= room) { problem(a.name, 'The database is too close to its safety threshold for that file.'); continue; }
    room -= inspected.size;
    const id = newId();
    ctx.db.prepare('INSERT INTO attachments (id, record_table, record_id, uploaded_by, unit_id, original_name, mime_type, size_bytes, sha256, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, target.table, target.id, user.id, record.unit_id ?? null, inspected.filename, inspected.mime, inspected.size, inspected.sha256, a.data, now());
    attachments.included += 1;
    state.results.attachments += 1;
    state.origins.push({ table: 'attachments', id, action: 'attached', sourceId: a.ref.replace(/^file:/, ''), ref: a.path, author: null, before: null, versionAfter: null });
  }
}

const PROFILE_LABELS: Record<string, string> = { ...Object.fromEntries([...PROFILE_COLUMNS, ...READINESS_COLUMNS].map((c) => [c.key, c.header])), military_goal: 'Military goal', civilian_interests: 'Civilian interests' };
const USER_FIELDS = ['first_name', 'last_name', 'middle_initial', 'rank_id', 'mos', 'eas'] as const;

/** What the import would do to the profile, readiness and career plan, by field; in commit, it does it. */
function profileChanges(ctx: AppContext, user: SessionUser, source: Source, plan: ImportPlan, state: RunState, review: boolean): ImportReview['profile'] {
  if (!source.profile) return null;
  const mode = plan.profile ?? 'fill';
  const changes: NonNullable<ImportReview['profile']>['changes'] = [];
  const sourced = new Set<string>(sourcedFieldsFor(ctx, user.id));
  const current = ctx.db.prepare(`SELECT ${USER_FIELDS.join(', ')}, prefs FROM users WHERE id = ?`).get(user.id) as Row;
  const readiness = (ctx.db.prepare('SELECT * FROM readiness WHERE user_id = ?').get(user.id) ?? {}) as Row;
  const career = (ctx.db.prepare('SELECT military_goal, civilian_interests FROM career_profiles WHERE user_id = ?').get(user.id) ?? {}) as Row;
  /** One field: checked as its form checks it, then filled, replaced or kept as the person chose. */
  const decide = (field: string, schema: z.ZodType | undefined, was: unknown, incoming: unknown, refused?: string): unknown => {
    if (incoming == null || incoming === '' || !schema) return undefined;
    const parsed = schema.safeParse(incoming);
    const value = parsed.success ? parsed.data : incoming;
    const why = refused ?? (parsed.success ? undefined : parsed.error.issues[0]?.message ?? 'Not a valid value.');
    const empty = was == null || was === '';
    const action = why ? 'refused' : str(was) === str(value) ? 'same' : empty ? 'fill' : mode === 'replace' ? 'replace' : 'kept';
    const effective = mode === 'skip' && (action === 'fill' || action === 'replace') ? 'kept' : action;
    changes.push({ field, label: PROFILE_LABELS[field] ?? field, current: empty ? null : str(was), incoming: str(incoming), action: effective, ...(why ? { reason: why } : {}) });
    return effective === 'fill' || effective === 'replace' ? value : undefined;
  };

  const userSet: Row = {};
  for (const k of USER_FIELDS) {
    let incoming = source.profile.user?.[k];
    if (k === 'rank_id' && incoming) {
      const rank = ctx.db.prepare('SELECT id FROM ranks WHERE id = ? OR abbr = ? COLLATE NOCASE').get(str(incoming), str(incoming)) as { id: string } | undefined;
      if (!rank) { decide(k, profileSchema.shape.rank_id, current[k], incoming, 'Not a rank Vantage knows.'); continue; }
      incoming = rank.id;
    }
    const value = decide(k, profileSchema.shape[k], current[k], incoming, sourced.has(k) ? 'Set by the personnel feed, not by a file.' : undefined);
    if (value !== undefined) userSet[k] = value;
  }
  const readinessSet: Row = {};
  for (const [k, v] of Object.entries(source.profile.readiness ?? {})) {
    // Only the fields readiness has: a file names its own keys, and "constructor" is not one of them.
    const value = decide(k, Object.hasOwn(readinessSchema.shape, k) ? (readinessSchema.shape as Record<string, z.ZodType>)[k] : undefined, readiness[k], v);
    if (value !== undefined) readinessSet[k] = value;
  }
  const careerSet: Row = {};
  for (const [k, v] of Object.entries(source.profile.career ?? {})) {
    const value = decide(k, Object.hasOwn(careerProfileSchema.shape, k) ? (careerProfileSchema.shape as Record<string, z.ZodType>)[k] : undefined, career[k], v);
    if (value !== undefined) careerSet[k] = value;
  }
  let prefsSet: Row | null = null;
  const parsedPrefs = prefsSchema.safeParse(source.profile.prefs ?? {});
  if (source.profile.prefs && parsedPrefs.success && mode !== 'skip') {
    let have: Row = {};
    try { have = JSON.parse(str(current.prefs) || '{}') as Row; } catch { /* none */ }
    const incoming = Object.fromEntries(Object.entries(parsedPrefs.data).filter(([k, v]) => v !== undefined && (mode === 'replace' || have[k] === undefined)));
    if (Object.keys(incoming).length) { prefsSet = { ...have, ...incoming }; changes.push({ field: 'prefs', label: 'Preferences', current: null, incoming: Object.keys(incoming).join(', '), action: 'fill' }); }
  }

  if (!review) {
    const at = now();
    const set = (table: 'users' | 'readiness' | 'career_profiles', values: Row, was: Row) => {
      if (!Object.keys(values).length) return;
      const before = Object.fromEntries(Object.keys(values).map((k) => [k, was[k] ?? null]));
      const key = table === 'users' ? 'id' : 'user_id';
      if (table !== 'users') ctx.db.prepare(`INSERT OR IGNORE INTO ${table} (user_id, updated_at) VALUES (?, ?)`).run(user.id, at);
      const run = () => ctx.db.prepare(`UPDATE ${table} SET ${Object.keys(values).map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE ${key} = ?`).run(...Object.values(values), at, user.id);
      if (table === 'users') withPersonnelNote(ctx, { actorId: user.id, source: 'self' }, run); else run();
      state.origins.push({ table, id: user.id, action: 'profile', sourceId: null, ref: table, author: null, before: { before, after: values }, versionAfter: null });
    };
    set('users', userSet, current);
    set('readiness', readinessSet, readiness);
    set('career_profiles', careerSet, career);
    if (prefsSet) {
      // Preferences are one stored value: the undo puts back the whole of it, if nothing changed it since.
      const value = JSON.stringify(prefsSet);
      ctx.db.prepare('UPDATE users SET prefs = ?, updated_at = ? WHERE id = ?').run(value, at, user.id);
      state.origins.push({ table: 'users', id: user.id, action: 'profile', sourceId: null, ref: 'prefs', author: null, before: { before: { prefs: current.prefs ?? null }, after: { prefs: value } }, versionAfter: null });
    }
    state.results.profile = [...Object.keys(userSet), ...Object.keys(readinessSet), ...Object.keys(careerSet), ...(prefsSet ? ['prefs'] : [])];
    if (state.results.profile.length) audit(ctx, { actor_id: user.id, action: 'edit_profile', entity: 'user', entity_id: user.id, subject_id: user.id, detail: `import: ${state.results.profile.join(', ')}` });
  }
  return { mode, changes };
}

// ——— The import's life: upload, review, change, commit, undo, cancel ———

interface ImportRow { id: string; user_id: string; status: ImportReview['status']; source_kind: SourceKind; filename: string | null; size_bytes: number; sha256: string; content: Buffer | null; plan: string; review: string | null; results: string | null; created_at: string; updated_at: string; committed_at: string | null; undone_at: string | null }

function importRow(ctx: AppContext, userId: string, id: string): ImportRow {
  const row = ctx.db.prepare('SELECT * FROM record_imports WHERE id = ? AND user_id = ?').get(id, userId) as ImportRow | undefined;
  if (!row) throw notFound('No such import.');
  return row;
}

const planOf = (row: ImportRow): ImportPlan => { try { return JSON.parse(row.plan || '{}') as ImportPlan; } catch { return {}; } };
const resultsOf = (row: ImportRow): ImportResults | null => { try { return row.results ? JSON.parse(row.results) as ImportResults : null; } catch { return null; } };

/** The review as the page reads it: the file's rows and what each would do, and the rest. */
function reviewOf(row: ImportRow, source: Source | null, state: RunState | null, plan: ImportPlan): ImportReview {
  const counts = EMPTY_COUNTS();
  for (const r of state?.rows ?? []) counts[r.outcome] += 1;
  return {
    id: row.id, status: row.status, filename: row.filename, source: row.source_kind, size_bytes: row.size_bytes, created_at: row.created_at,
    committed_at: row.committed_at, undone_at: row.undone_at,
    exported: source?.exported ?? null, notes: [...(source?.notes ?? []), ...(state?.notes ?? [])],
    sheets: (source?.sheets ?? []).map((s) => ({ name: s.name, table: s.table, routedBy: s.routedBy, headers: s.headers, mapping: s.mapping, rows: s.rows.length })),
    rows: state?.rows ?? [], counts,
    profile: state?.profile ?? null,
    attachments: state?.attachments ?? { total: 0, included: 0, problems: [], enabled: true },
    notImported: source?.notImported ?? [],
    placement: plan.placement ?? 'keep',
    results: resultsOf(row),
  };
}

function withOwnerNote(ctx: AppContext, user: SessionUser, source: Source): Source {
  const from = source.exported?.username;
  if (from && from.toLowerCase() !== String((ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(user.id) as { username: string } | undefined)?.username ?? '').toLowerCase()) {
    source.notes.push(`This export is of the account “${from}”, not yours. What it holds comes in as your own records.`);
  }
  return source;
}

/** Review the staged file as planned: the import run and rolled back. */
function reviewStaged(ctx: AppContext, user: SessionUser, row: ImportRow, reqKey: object): ImportReview {
  const plan = planOf(row);
  const source = withOwnerNote(ctx, user, readSource(row.content!, row.filename ?? '', plan));
  let state: RunState | null = null;
  try {
    ctx.db.transaction(() => { state = runImport(ctx, user, row.id, source, plan, true, reqKey); throw ROLLBACK; })();
  } catch (e) { if (e !== ROLLBACK) throw e; }
  const review = reviewOf(row, source, state, plan);
  ctx.db.prepare('UPDATE record_imports SET review = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(review), now(), row.id);
  return review;
}

/**
 * Upload: the file is checked (not a backup, within the size limit, scanned, and each file a ZIP carries scanned too),
 * held, and reviewed. One import waits at a time: an earlier one not yet imported is cancelled.
 */
export async function stageImport(ctx: AppContext, user: SessionUser, input: { buffer: Buffer; filename: string }, reqKey: object, ip?: string): Promise<ImportReview> {
  const { buffer } = input;
  if (!buffer.length) throw badRequest('That file is empty.');
  if (buffer.length > ctx.config.recordImports.maxBytes) throw badRequest(`That file is ${Math.ceil(buffer.length / 1_048_576)} MB. Imports here take up to ${Math.floor(ctx.config.recordImports.maxBytes / 1_048_576)} MB.`, { code: 'too_large' });
  // eslint-disable-next-line no-control-regex
  const filename = input.filename.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'import';
  const found = detect(buffer);
  const rejected = (detail: string) => audit(ctx, { actor_id: user.id, action: 'upload_rejected', entity: 'record_imports', detail: detail.slice(0, 300), ip });
  // The file as a whole is scanned as any upload is; a rejected file is never kept.
  try { await scanUpload(ctx.config.intake, buffer, filename); }
  catch (e) { if ((e as HttpError).code === 'malware_rejected') rejected(`${filename}: ${(e as Error).message}`); throw e; }
  // Each file a ZIP carries is scanned on its own, as an attachment upload is; one that fails stays out, the rest come in.
  const scanned: Record<string, string> = {};
  if (found.kind === 'vantage_zip' && found.files) {
    for (const [path, data] of found.files) {
      if (!path.startsWith('attachments/') || !data.length) continue;
      try { scanned[path] = (await scanUpload(ctx.config.intake, data, path.slice(12))).verdict === 'clean' ? 'clean' : 'skipped'; }
      catch (e) {
        if ((e as HttpError).code !== 'malware_rejected') throw e;
        scanned[path] = 'Refused by the malware scan.';
        rejected(`${filename} › ${path}: ${(e as Error).message}`);
      }
    }
  }
  const id = newId();
  const at = now();
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE record_imports SET status = 'cancelled', content = NULL, review = NULL, updated_at = ? WHERE user_id = ? AND status = 'staged'").run(at, user.id);
    ctx.db.prepare('INSERT INTO record_imports (id, user_id, status, source_kind, filename, size_bytes, sha256, content, plan, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, user.id, 'staged', found.kind, filename, buffer.length, sha(buffer), buffer, JSON.stringify({ scanned }), at, at);
  })();
  audit(ctx, { actor_id: user.id, action: 'record_import_staged', entity: 'record_imports', entity_id: id, detail: `${filename} (${found.kind}, ${buffer.length} bytes)`, ip });
  return reviewStaged(ctx, user, importRow(ctx, user.id, id), reqKey);
}

export function getImport(ctx: AppContext, user: SessionUser, id: string, reqKey: object): ImportReview {
  const row = importRow(ctx, user.id, id);
  if (row.status === 'staged' && row.content) return reviewStaged(ctx, user, row, reqKey);
  if (row.review) {
    try { return { ...(JSON.parse(row.review) as ImportReview), status: row.status, committed_at: row.committed_at, undone_at: row.undone_at, results: resultsOf(row) }; } catch { /* below */ }
  }
  return reviewOf(row, null, null, planOf(row));
}

/** Change what the import does: a sheet's record type or columns, a row in or out, a correction, placement, profile. */
export function planImport(ctx: AppContext, user: SessionUser, id: string, body: unknown, reqKey: object): ImportReview {
  const row = importRow(ctx, user.id, id);
  if (row.status !== 'staged' || !row.content) throw conflict('That import is no longer waiting to be reviewed.', 'import_closed');
  const parsed = importPlanSchema.safeParse(body ?? {});
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'That plan could not be read.');
  const plan: ImportPlan = { ...parsed.data, scanned: planOf(row).scanned };
  ctx.db.prepare('UPDATE record_imports SET plan = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(plan), now(), row.id);
  return reviewStaged(ctx, user, { ...row, plan: JSON.stringify(plan) }, reqKey);
}

/** Import: the run kept, in one transaction, with what it wrote noted for the record pages and the undo. */
export function commitImport(ctx: AppContext, user: SessionUser, id: string, body: unknown, reqKey: object, ip?: string): ImportReview {
  const row = importRow(ctx, user.id, id);
  if (row.status !== 'staged' || !row.content) throw conflict('That import is no longer waiting to be imported.', 'import_closed');
  const parsed = importCommitSchema.safeParse(body ?? {});
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? 'That plan could not be read.');
  const { expected, ...chosen } = parsed.data;
  const plan: ImportPlan = { ...(Object.keys(chosen).length ? chosen : planOf(row)), scanned: planOf(row).scanned };
  const source = withOwnerNote(ctx, user, readSource(row.content, row.filename ?? '', plan));
  return ctx.db.transaction(() => {
    const claimed = ctx.db.prepare("UPDATE record_imports SET status = 'imported', updated_at = ? WHERE id = ? AND status = 'staged'").run(now(), row.id);
    if (!claimed.changes) throw conflict('That import is no longer waiting to be imported.', 'import_closed');
    const state = runImport(ctx, user, row.id, source, plan, false, reqKey, ip);
    const made = { new: state.rows.filter((r) => r.outcome === 'new').length, update: state.rows.filter((r) => r.outcome === 'update').length };
    // What the person confirmed is what goes in: if the account changed since the review, nothing does.
    if (expected && (expected.new !== made.new || expected.update !== made.update)) {
      throw conflict(`Nothing was imported: the import would now add ${made.new} and update ${made.update}, not the ${expected.new} and ${expected.update} you reviewed. Review it again.`, 'import_changed');
    }
    const at = now();
    const origin = ctx.db.prepare('INSERT INTO record_import_origins (id, import_id, user_id, record_table, record_id, action, source_id, source_ref, author, before, version_after, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const o of state.origins) origin.run(newId(), row.id, user.id, o.table, o.id, o.action, o.sourceId?.slice(0, 200) ?? null, o.ref?.slice(0, 200) ?? null, o.author?.slice(0, 160) ?? null, o.before ? JSON.stringify(o.before) : null, o.versionAfter, at);
    const results = JSON.stringify(state.results);
    const out = reviewOf({ ...row, status: 'imported', committed_at: at, results }, source, state, plan);
    // The file's bytes go now; what it did stays, for the results page and the undo.
    const kept = { ...out, rows: out.rows.map((r) => ({ ...r, fields: {} })) };
    ctx.db.prepare('UPDATE record_imports SET content = NULL, plan = ?, review = ?, results = ?, committed_at = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(plan), JSON.stringify(kept), results, at, at, row.id);
    const created = Object.entries(state.results.created).map(([t, n]) => `${n} ${t}`).join(', ') || 'nothing';
    const updated = Object.entries(state.results.updated).map(([t, n]) => `${n} ${t}`).join(', ');
    audit(ctx, { actor_id: user.id, action: 'record_import_committed', entity: 'record_imports', entity_id: row.id, detail: `${row.filename ?? 'file'} (${row.source_kind}): created ${created}${updated ? `; updated ${updated}` : ''}; ${state.results.attachments} files; profile ${state.results.profile.join(', ') || 'unchanged'}; ${state.results.skipped} rows not imported`.slice(0, 1000), ip });
    return kept;
  })();
}

/**
 * Undo an import: what it created goes to the recycle bin, what it updated is put back, the files it added come off, the
 * profile fields it set go back. Only where nothing has changed since: a record edited after the import is kept as it is.
 */
export function undoImport(ctx: AppContext, user: SessionUser, id: string, ip?: string): ImportReview {
  const row = importRow(ctx, user.id, id);
  if (row.status !== 'imported') throw conflict('Only an import that went in can be undone, and only once.', 'import_not_undoable');
  const origins = ctx.db.prepare('SELECT * FROM record_import_origins WHERE import_id = ? AND user_id = ? ORDER BY rowid DESC').all(row.id, user.id) as Array<{ record_table: string; record_id: string; action: string; before: string | null; version_after: number | null }>;
  let removed = 0; let restored = 0; let kept = 0;
  const scope = scopeFor(ctx, user, {});
  ctx.db.transaction(() => {
    const at = now();
    for (const o of origins) {
      const before = o.before ? JSON.parse(o.before) as Row : null;
      if (o.action === 'attached') {
        removed += ctx.db.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ? AND uploaded_by = ? AND deleted_at IS NULL').run(at, o.record_id, user.id).changes;
        continue;
      }
      if (o.action === 'profile') {
        const was = (before?.before ?? {}) as Row; const set = (before?.after ?? {}) as Row;
        const table = o.record_table === 'users' ? 'users' : o.record_table === 'readiness' ? 'readiness' : 'career_profiles';
        const key = table === 'users' ? 'id' : 'user_id';
        const present = ctx.db.prepare(`SELECT * FROM ${table} WHERE ${key} = ?`).get(user.id) as Row | undefined;
        const back = Object.keys(set).filter((k) => present && str(present[k]) === str(set[k]));
        kept += Object.keys(set).length - back.length;
        if (back.length) {
          const run = () => ctx.db.prepare(`UPDATE ${table} SET ${back.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE ${key} = ?`).run(...back.map((k) => was[k] ?? null), at, user.id);
          if (table === 'users') withPersonnelNote(ctx, { actorId: user.id, source: 'self' }, run); else run();
          restored += back.length;
        }
        continue;
      }
      if (!isImportTable(o.record_table)) continue;
      const current = ctx.db.prepare(`SELECT * FROM ${o.record_table} WHERE id = ?`).get(o.record_id) as Row | undefined;
      // Only what nobody changed since, and what its owner may still change: a record frozen when they left its unit stays.
      if (!current || current.user_id !== user.id || Number(current.version) !== Number(o.version_after)) { kept += 1; continue; }
      if (o.record_table !== 'career_steps' && !canEdit(scope, user.id, current as unknown as RecordRow)) { kept += 1; continue; }
      if (o.action === 'created') {
        if (current.deleted_at) continue;
        ctx.db.prepare(`UPDATE ${o.record_table} SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(at, at, o.record_id);
        removed += 1;
      } else if (o.action === 'updated') {
        // A record destroyed or anonymized since has no snapshot left (forgetImportSnapshots): it stays as it is.
        if (!before) { kept += 1; continue; }
        const fields = Object.keys(before);
        if (!fields.length) continue;
        try {
          savepoint(ctx, () => ctx.db.prepare(`UPDATE ${o.record_table} SET ${fields.map((k) => `${k} = ?`).join(', ')}, version = version + 1, updated_at = ? WHERE id = ?`).run(...fields.map((k) => before[k] ?? null), at, o.record_id));
          restored += 1;
        } catch (e) { if (!isRefusal(e)) throw e; kept += 1; }
      }
    }
    const results: ImportResults = { ...(resultsOf(row) ?? { created: {}, updated: {}, attachments: 0, profile: [], skipped: 0 }), undone: { removed, restored, kept } };
    ctx.db.prepare("UPDATE record_imports SET status = 'undone', undone_at = ?, results = ?, updated_at = ? WHERE id = ?").run(at, JSON.stringify(results), at, row.id);
    audit(ctx, { actor_id: user.id, action: 'record_import_undone', entity: 'record_imports', entity_id: row.id, detail: `${row.filename ?? 'file'}: ${removed} removed to the recycle bin, ${restored} put back, ${kept} kept because they changed since`, ip });
  })();
  return getImport(ctx, user, row.id, {});
}

/** Cancel an import not yet made: its file goes. */
export function cancelImport(ctx: AppContext, user: SessionUser, id: string, ip?: string) {
  const row = importRow(ctx, user.id, id);
  if (row.status !== 'staged') throw conflict('That import is no longer waiting.', 'import_closed');
  ctx.db.prepare("UPDATE record_imports SET status = 'cancelled', content = NULL, review = NULL, updated_at = ? WHERE id = ? AND status = 'staged'").run(now(), row.id);
  audit(ctx, { actor_id: user.id, action: 'record_import_cancelled', entity: 'record_imports', entity_id: row.id, detail: row.filename ?? undefined, ip });
  return { ok: true };
}

/** The person's recent imports. */
export function listImports(ctx: AppContext, user: SessionUser) {
  return (ctx.db.prepare('SELECT id, status, source_kind, filename, size_bytes, created_at, committed_at, undone_at, results FROM record_imports WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(user.id) as ImportRow[])
    .map((r) => ({ id: r.id, status: r.status, source: r.source_kind, filename: r.filename, size_bytes: r.size_bytes, created_at: r.created_at, committed_at: r.committed_at, undone_at: r.undone_at, results: resultsOf(r) }));
}

/** The files of imports left waiting past their time go; the rows stay. Run by the maintenance loop. */
export function pruneStagedImports(ctx: AppContext): number {
  const cutoff = new Date(Date.now() - ctx.config.recordImports.stagedHours * 3_600_000).toISOString();
  return ctx.db.prepare("UPDATE record_imports SET status = 'expired', content = NULL, review = NULL, updated_at = ? WHERE status = 'staged' AND updated_at < ?").run(now(), cutoff).changes;
}

/** Where a record came from, for its page: when it was imported, and who the file says wrote it. */
export function importedFrom(ctx: AppContext, table: string, id: string, viewerId: string): { at: string; filename: string | null; author: string | null } | null {
  const hit = ctx.db.prepare(`SELECT o.created_at AS at, o.author, o.user_id, i.filename FROM record_import_origins o JOIN record_imports i ON i.id = o.import_id
    WHERE o.record_table = ? AND o.record_id = ? AND o.action = 'created' ORDER BY o.created_at DESC LIMIT 1`).get(table, id) as { at: string; author: string | null; user_id: string; filename: string | null } | undefined;
  if (!hit) return null;
  // The file's name is its importer's; anyone else who may read the record sees only that it was imported, and by whose word.
  return { at: hit.at, author: hit.author, filename: hit.user_id === viewerId ? hit.filename : null };
}
