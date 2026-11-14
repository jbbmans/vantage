/**
 * Approved course sources and the catalogs loaded for them (Task 22, ADR-0029): the Vantage Administrator's side of the
 * course lookup.
 *
 * Vantage fetches no course list and scrapes none. A Vantage Administrator who holds platform.settings registers a source
 * with the authorization that approves it for Vantage (a document, memo or ticket, who approved it and when), then loads
 * the catalog file that source publishes. A file is read, scanned and counted first (staged), shown as what it would
 * change against the catalog now in use, and answers lookups only once it is applied. Applying replaces the source's
 * catalog in use, which is kept, entries and all, so a training verified against it can always say what the source said.
 * Nothing here is ever edited: a source is withdrawn with a reason, a catalog replaced by a later one.
 */
import { createHash } from 'node:crypto';
import type { AppContext, SessionUser } from '../context.ts';
import { audit } from './audit.ts';
import { notifyStaff } from './notifications.ts';
import { classifyUpload } from './intake.ts';
import { MalwareRejected, scanUpload } from './scanner.ts';
import { namesOf } from './reportCenter.ts';
import { ENTRY_SELECT, entryOf } from './courses.ts';
import { readWorkbook, WorkbookError, ZipError } from '../lib/workbook.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { zonedDay } from '../lib/clock.ts';
import { zoneOf } from '../lib/zone.ts';
import { infrastructureFileProblem } from '../../shared/dataTransfer.ts';
import { MAX_IMPORT_COLUMNS, parseDelimited } from '../../shared/csv.ts';
import type { CourseSourceInput } from '../../shared/courseSchemas.ts';
import {
  CATALOG_FIELDS, CATALOG_HEADERS, CATALOG_LIMITS, CEUS_MAX, COURSE_CODE_MAX, MAX_CATALOG_BYTES, MAX_CATALOG_ROWS, STAGED_CATALOG_HOURS,
  cleanBlock, cleanCourseCode, cleanLine, courseKey, headerKey,
  type CatalogField, type CatalogLoadRecord, type CatalogLoadStatus, type CatalogPreview, type CatalogProblem, type CourseEntry, type CourseSourceRecord,
} from '../../shared/courses.ts';

interface SourceRow {
  id: string; name: string; authority: string; approval_reference: string; approved_by: string; approved_on: string; notes: string | null;
  recorded_by: string; recorded_at: string; withdrawn_at: string | null; withdrawn_by: string | null; withdrawn_reason: string | null;
}
interface LoadRow {
  id: string; source_id: string; status: CatalogLoadStatus; as_of: string; file_name: string; file_sha256: string; byte_size: number; entry_count: number;
  preview: string; staged_by: string; staged_at: string; applied_by: string | null; applied_at: string | null; superseded_at: string | null; discarded_at: string | null;
}
/** One course as a file lists it, once read and cleaned. */
interface ParsedEntry {
  line: number; code: string; code_key: string; name: string; provider: string | null; description: string | null; hours: number | null; ceus: number | null;
  category: string | null; requirements: string | null; ranks: string | null; mos: string | null;
}

/** How many earlier catalogs of a source the console lists. Every one is kept; the list is for reading. */
const HISTORY_SHOWN = 20;
/** How many rows left out a load keeps to show, and how many courses it shows for a last look. */
const PROBLEMS_KEPT = 200;
const SAMPLE_SIZE = 5;
/** How many entries one page of a catalog shows. */
export const CATALOG_PAGE = 100;
/** How far down a sheet its header row may be: a title or a note above it is passed over. */
const HEADER_SEARCH_ROWS = 10;
const HOURS_MAX = 10_000;

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const sourceRow = (ctx: AppContext, id: string) => ctx.db.prepare('SELECT * FROM course_sources WHERE id = ?').get(id) as SourceRow | undefined;
const loadRow = (ctx: AppContext, sourceId: string, id: string) => ctx.db.prepare('SELECT * FROM course_catalog_loads WHERE id = ? AND source_id = ?').get(id, sourceId) as LoadRow | undefined;

function readPreview(raw: string): CatalogPreview {
  try { return JSON.parse(raw) as CatalogPreview; } catch { return { rows: 0, courses: 0, left_out: 0, added: 0, changed: 0, unchanged: 0, removed: 0, sheet: null, columns: {}, ignored_columns: [], problems: [], sample: [] }; }
}

function loadRecord(l: LoadRow, who: Map<string, string>): CatalogLoadRecord {
  return {
    id: l.id, status: l.status, as_of: l.as_of, file_name: l.file_name, file_sha256: l.file_sha256, byte_size: l.byte_size, courses: l.entry_count,
    staged_by_name: who.get(l.staged_by) ?? null, staged_at: l.staged_at, applied_by_name: l.applied_by ? who.get(l.applied_by) ?? null : null,
    applied_at: l.applied_at, superseded_at: l.superseded_at, preview: readPreview(l.preview),
  };
}

/** Every source registered, those in use first, each with its catalog in use, the file waiting to be applied, and earlier ones. */
export function listCourseSources(ctx: AppContext, only?: string): CourseSourceRecord[] {
  const sources = ctx.db.prepare('SELECT * FROM course_sources WHERE (? IS NULL OR id = ?) ORDER BY withdrawn_at IS NOT NULL, lower(name), recorded_at').all(only ?? null, only ?? null) as SourceRow[];
  if (!sources.length) return [];
  // The catalog in use and the one waiting, and the latest catalogs each replaced: only as many as are shown.
  const loads = ctx.db.prepare(`SELECT * FROM (
      SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l.source_id, l.status ORDER BY COALESCE(l.applied_at, l.staged_at) DESC, l.id) AS nth,
        COUNT(*) OVER (PARTITION BY l.source_id, l.status) AS of_status
      FROM course_catalog_loads l WHERE l.status IN ('staged', 'current', 'superseded') AND (? IS NULL OR l.source_id = ?)
    ) WHERE status <> 'superseded' OR nth <= ? ORDER BY COALESCE(applied_at, staged_at) DESC, id`).all(only ?? null, only ?? null, HISTORY_SHOWN) as Array<LoadRow & { of_status: number }>;
  const who = namesOf(ctx, [...sources.flatMap((s) => [s.recorded_by, s.withdrawn_by]), ...loads.flatMap((l) => [l.staged_by, l.applied_by])]);
  return sources.map((s) => {
    const own = loads.filter((l) => l.source_id === s.id);
    const current = own.find((l) => l.status === 'current');
    const staged = own.find((l) => l.status === 'staged');
    return {
      id: s.id, name: s.name, authority: s.authority, approval_reference: s.approval_reference, approved_by: s.approved_by, approved_on: s.approved_on, notes: s.notes,
      recorded_by_name: who.get(s.recorded_by) ?? null, recorded_at: s.recorded_at,
      withdrawn_at: s.withdrawn_at, withdrawn_by_name: s.withdrawn_by ? who.get(s.withdrawn_by) ?? null : null, withdrawn_reason: s.withdrawn_reason,
      current: current ? loadRecord(current, who) : null,
      staged: staged ? loadRecord(staged, who) : null,
      history: own.filter((l) => l.status === 'superseded').map((l) => loadRecord(l, who)),
      history_total: own.find((l) => l.status === 'superseded')?.of_status ?? 0,
    };
  });
}

const sourceRecord = (ctx: AppContext, id: string) => listCourseSources(ctx, id)[0]!;

function notOnLaterDay(ctx: AppContext, actor: SessionUser, day: string, field: string, what: string) {
  if (day > zonedDay(zoneOf(ctx, actor))) throw badRequest(`${what} cannot be a later day than today.`, { fieldErrors: { [field]: 'Not later than today.' } });
}

/** The other Vantage Administrators who may change course sources hear of each change, so a second person sees it. */
function tellOthers(ctx: AppContext, actor: SessionUser, title: string, message: string) {
  notifyStaff(ctx, 'platform.settings', { kind: 'system', title, message, actionUrl: '/admin/courses' }, actor.id);
}
const actorName = (a: SessionUser) => `${a.first_name} ${a.last_name}`.trim() || a.username;

/** Register an approved source, with the authorization that approves it. Two sources in use never share a name. */
export function registerCourseSource(ctx: AppContext, actor: SessionUser, input: CourseSourceInput, ip?: string): CourseSourceRecord {
  notOnLaterDay(ctx, actor, input.approved_on, 'approved_on', 'The day it was approved');
  const taken = ctx.db.prepare('SELECT 1 FROM course_sources WHERE lower(name) = lower(?) AND withdrawn_at IS NULL').get(input.name);
  if (taken) throw conflict('A source in use already has that name. Withdraw it first, or name this one as its publisher tells them apart.', 'source_name_taken', { fieldErrors: { name: 'In use.' } });
  const id = newId();
  ctx.db.transaction(() => {
    ctx.db.prepare(`INSERT INTO course_sources (id, name, authority, approval_reference, approved_by, approved_on, notes, recorded_by, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.authority, input.approval_reference, input.approved_by, input.approved_on, input.notes ?? null, actor.id, now());
    audit(ctx, { actor_id: actor.id, action: 'course_source_registered', entity: 'course_sources', entity_id: id, detail: `${input.name} (${input.authority}), approved by ${input.approved_by} on ${input.approved_on}: ${input.approval_reference}`.slice(0, 1000), ip });
  })();
  tellOthers(ctx, actor, `${actorName(actor)} registered a course source`, `${input.name} (${input.authority}), approved by ${input.approved_by} on ${input.approved_on}: ${input.approval_reference}.`);
  return sourceRecord(ctx, id);
}

/**
 * Withdraw a source: from now on its catalog answers no lookup and verifies no value. What was verified against it before
 * stays verified and says the source has been withdrawn, and why. A file waiting to be applied is discarded.
 */
export function withdrawCourseSource(ctx: AppContext, actor: SessionUser, id: string, reason: string, ip?: string): CourseSourceRecord {
  const s = sourceRow(ctx, id);
  if (!s) throw notFound('No such course source.');
  if (s.withdrawn_at) throw conflict('That source is already withdrawn.', 'source_withdrawn');
  const at = now();
  ctx.db.transaction(() => {
    const staged = ctx.db.prepare("SELECT id FROM course_catalog_loads WHERE source_id = ? AND status = 'staged'").get(id) as { id: string } | undefined;
    if (staged) discardLoad(ctx, staged.id, at);
    const done = ctx.db.prepare('UPDATE course_sources SET withdrawn_at = ?, withdrawn_by = ?, withdrawn_reason = ? WHERE id = ? AND withdrawn_at IS NULL').run(at, actor.id, reason, id).changes;
    if (!done) throw conflict('That source is already withdrawn.', 'source_withdrawn');
    audit(ctx, { actor_id: actor.id, action: 'course_source_withdrawn', entity: 'course_sources', entity_id: id, detail: `${s.name}: ${reason}`.slice(0, 1000), ip });
  })();
  tellOthers(ctx, actor, `${actorName(actor)} withdrew a course source`, `${s.name}: ${reason}. Its catalog no longer verifies any course value.`);
  return sourceRecord(ctx, id);
}

/** A staged load goes: its entries (nothing was ever verified against them) and then its standing as the file in waiting. */
function discardLoad(ctx: AppContext, loadId: string, at: string) {
  ctx.db.prepare('DELETE FROM course_catalog_entries WHERE load_id = ?').run(loadId);
  ctx.db.prepare("UPDATE course_catalog_loads SET status = 'discarded', discarded_at = ? WHERE id = ? AND status = 'staged'").run(at, loadId);
}

// ——— Reading a catalog file ———

const ROW_LIMIT_MESSAGE = `A catalog file lists at most ${MAX_CATALOG_ROWS.toLocaleString('en-US')} courses. Applying a catalog replaces the one in use, so a file is never read in part: ask the source for a smaller extract, or split it into sources the approval names.`;

/** The cells of the file, sheet by sheet: a workbook's visible sheets, or a CSV's one. readCatalog reads the first with a course code and a name column. */
function sheetsOf(buffer: Buffer, filename: string, contentType: string): Array<{ name: string | null; matrix: string[][]; truncated: boolean }> {
  const kind = classifyUpload(filename, contentType, buffer);
  if (kind === 'xlsx') {
    let book;
    try { book = readWorkbook(buffer, { maxRows: MAX_CATALOG_ROWS + HEADER_SEARCH_ROWS + 1, maxColumns: MAX_IMPORT_COLUMNS }); }
    catch (e) { if (e instanceof WorkbookError || e instanceof ZipError) throw badRequest(e.message); throw e; }
    // A hidden sheet is not offered (readWorkbook). One too long to read whole is refused only if it is the catalog's.
    return book.sheets.map((s) => ({ name: s.name, matrix: s.rows, truncated: s.truncated }));
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, ''); }
  catch { throw badRequest('That file is not UTF-8 text. Save it from Excel as "CSV UTF-8", or load the workbook (.xlsx) itself.'); }
  if (text.includes('\u0000')) throw badRequest('That file is not a text file. Load the catalog as a workbook (.xlsx) or a CSV.');
  const delimiter = delimiterOf(text, filename, contentType);
  try { return [{ name: null, matrix: parseDelimited(text, delimiter, { maxRows: MAX_CATALOG_ROWS + HEADER_SEARCH_ROWS }), truncated: false }]; }
  catch (e) {
    if (/limited to/.test((e as Error).message)) throw badRequest(ROW_LIMIT_MESSAGE, { code: 'too_many_rows' });
    throw badRequest((e as Error).message);
  }
}

/**
 * Tabs or commas: tabs for a file named or sent as tab-separated; otherwise the one that splits a line the header is
 * searched in into a course code and a name column (prose in the rows below may hold more commas than a TSV has tabs),
 * and failing that the one the lines hold more of.
 */
const CLASH_LINES_NAMED = 10;

function delimiterOf(text: string, filename: string, contentType: string): ',' | '\t' {
  if (/\.tsv$/i.test(filename) || /tab-separated/i.test(contentType)) return '\t';
  const head = text.split(/\r?\n/, HEADER_SEARCH_ROWS).join('\n');
  for (const delimiter of [',', '\t'] as const) {
    let rows: string[][];
    // A quoted cell running past the lines read is closed, so the header above it is still found.
    try { rows = parseDelimited(head, delimiter, { maxRows: HEADER_SEARCH_ROWS }); }
    catch { try { rows = parseDelimited(`${head}"`, delimiter, { maxRows: HEADER_SEARCH_ROWS }); } catch { continue; } }
    if (rows.some((r) => { const { index } = columnsOf(r.slice(0, MAX_IMPORT_COLUMNS).map((h) => String(h ?? ''))); return index.code !== undefined && index.name !== undefined; })) return delimiter;
  }
  return head.split('\t').length > head.split(',').length ? '\t' : ',';
}

/** Which column fills which value: the first column whose header Vantage reads for it. */
function columnsOf(headers: string[]): { index: Partial<Record<CatalogField, number>>; named: Partial<Record<CatalogField, string>>; ignored: string[] } {
  const index: Partial<Record<CatalogField, number>> = {};
  const named: Partial<Record<CatalogField, string>> = {};
  const ignored: string[] = [];
  headers.forEach((h, i) => {
    const key = headerKey(h);
    const field = key ? CATALOG_FIELDS.find((f) => index[f] === undefined && CATALOG_HEADERS[f].includes(key)) : undefined;
    if (field) { index[field] = i; named[field] = cleanLine(h).slice(0, 100); }
    else if (cleanLine(h)) ignored.push(cleanLine(h).slice(0, 100));
  });
  return { index, named, ignored: ignored.slice(0, 50) };
}

/** A number as a workbook or a person writes it ("40", "1,200", "2.3333333333", ".5"), kept to four decimal places. */
function readNumber(raw: string, max: number): number | null | 'bad' {
  const v = raw.trim();
  if (!v) return null;
  const plain = /^\d{1,3}(,\d{3})+(\.\d{1,20})?$/.test(v) ? v.replace(/,/g, '') : v;
  if (!/^(\d{1,6}(\.\d{1,20})?|\.\d{1,20})$/.test(plain)) return 'bad';
  const n = Math.round(Number(plain) * 10_000) / 10_000;
  return Number.isFinite(n) && n >= 0 && n <= max ? n : 'bad';
}

/** One row read into a course, or why it is left out. */
function readEntry(cells: string[], index: Partial<Record<CatalogField, number>>, line: number): ParsedEntry | CatalogProblem {
  const cell = (f: CatalogField) => (index[f] === undefined ? '' : String(cells[index[f]!] ?? ''));
  const code = cleanCourseCode(cell('code'));
  const out = (reason: string): CatalogProblem => ({ line, code: code ? code.slice(0, COURSE_CODE_MAX) : null, reason });
  if (!code) return out('No course code.');
  if (code.length > COURSE_CODE_MAX) return out(`The course code is longer than ${COURSE_CODE_MAX} characters.`);
  const key = courseKey(code);
  if (!key) return out('The course code has no letters or digits.');
  const name = cleanLine(cell('name'));
  if (!name) return out('No course name.');
  const lines: Array<['name' | 'provider' | 'category' | 'ranks' | 'mos', string]> = [['name', name], ['provider', cleanLine(cell('provider'))], ['category', cleanLine(cell('category'))], ['ranks', cleanLine(cell('ranks'))], ['mos', cleanLine(cell('mos'))]];
  const blocks: Array<['description' | 'requirements', string]> = [['description', cleanBlock(cell('description'))], ['requirements', cleanBlock(cell('requirements'))]];
  for (const [f, v] of [...lines, ...blocks]) if (v.length > CATALOG_LIMITS[f]) return out(`The ${f} is longer than ${CATALOG_LIMITS[f]} characters.`);
  const hours = readNumber(cell('hours'), HOURS_MAX);
  if (hours === 'bad') return out(`The hours are not a number from 0 to ${HOURS_MAX}.`);
  const ceus = readNumber(cell('ceus'), CEUS_MAX);
  if (ceus === 'bad') return out(`The CEUs are not a number from 0 to ${CEUS_MAX}.`);
  const value = (v: string) => v || null;
  return {
    line, code, code_key: key, name, provider: value(lines[1][1]), category: value(lines[2][1]), ranks: value(lines[3][1]), mos: value(lines[4][1]),
    description: value(blocks[0][1]), requirements: value(blocks[1][1]), hours, ceus,
  };
}

const SAME_FIELDS = ['code', 'name', 'provider', 'description', 'hours', 'ceus', 'category', 'requirements', 'ranks', 'mos'] as const;
const sameEntry = (a: Pick<ParsedEntry, (typeof SAME_FIELDS)[number]>, b: Pick<ParsedEntry, (typeof SAME_FIELDS)[number]>) => SAME_FIELDS.every((f) => (a[f] ?? null) === (b[f] ?? null));

/** The file read into courses: the sheet and its columns, each course once, and every row left out with its reason. */
export function readCatalog(buffer: Buffer, filename: string, contentType: string) {
  const sheets = sheetsOf(buffer, filename, contentType);
  let chosen: { name: string | null; matrix: string[][]; truncated: boolean; header: number; headers: string[] } | null = null;
  for (const s of sheets) {
    for (let r = 0; r < Math.min(HEADER_SEARCH_ROWS, s.matrix.length); r += 1) {
      const headers = (s.matrix[r] ?? []).slice(0, MAX_IMPORT_COLUMNS).map((h) => String(h ?? ''));
      const { index } = columnsOf(headers);
      if (index.code !== undefined && index.name !== undefined) { chosen = { ...s, header: r, headers }; break; }
    }
    if (chosen) break;
  }
  if (!chosen) {
    throw badRequest(`Vantage found no course code and course name columns in that file. It reads a code column named one of: ${CATALOG_HEADERS.code.join(', ')}; and a name column named one of: ${CATALOG_HEADERS.name.join(', ')} (letters and digits only, any case).`, { code: 'no_catalog_columns' });
  }
  if (chosen.truncated) throw badRequest(ROW_LIMIT_MESSAGE, { code: 'too_many_rows' });
  const { index, named, ignored } = columnsOf(chosen.headers);
  const problems: CatalogProblem[] = [];
  const byKey = new Map<string, ParsedEntry>();
  const linesOf = new Map<string, number[]>();
  const clashing = new Set<string>();
  let rows = 0;
  chosen.matrix.slice(chosen.header + 1).forEach((cells, i) => {
    if (!cells.some((c) => String(c ?? '').trim() !== '')) return;
    rows += 1;
    const line = chosen!.header + i + 2;
    const read = readEntry(cells, index, line);
    if (!('code_key' in read)) { problems.push(read); return; }
    const seen = linesOf.get(read.code_key);
    if (seen) seen.push(line); else linesOf.set(read.code_key, [line]);
    const before = byKey.get(read.code_key);
    if (!before) { byKey.set(read.code_key, read); return; }
    // The same course listed again with the same values is the same listing. Listed again otherwise, the file does not
    // say which is right, so none of its rows is read, and each is said to be left out.
    if (!sameEntry(before, read)) clashing.add(read.code_key);
  });
  if (rows > MAX_CATALOG_ROWS) throw badRequest(ROW_LIMIT_MESSAGE, { code: 'too_many_rows' });
  for (const key of clashing) {
    const lines = linesOf.get(key)!;
    const first = byKey.get(key)!;
    byKey.delete(key);
    // One reason for every line of the code, naming the first few lines it is on.
    const listed = lines.length > CLASH_LINES_NAMED ? `${lines.slice(0, CLASH_LINES_NAMED).join(', ')} and ${(lines.length - CLASH_LINES_NAMED).toLocaleString('en-US')} more` : lines.join(', ');
    const reason = `This course code is listed on lines ${listed} with different values; none of them was read.`;
    for (const line of lines) problems.push({ line, code: first.code, reason });
  }
  problems.sort((a, b) => a.line - b.line);
  const entries = [...byKey.values()].sort((a, b) => a.line - b.line);
  return { sheet: chosen.name, columns: named, ignored_columns: ignored, rows, entries, problems };
}

/**
 * Read a catalog file for a source, scan it, and hold what it lists until a Vantage Administrator applies it. A file waiting
 * before for the same source is discarded. Nothing is answered from it yet.
 */
export async function stageCatalog(ctx: AppContext, actor: SessionUser, sourceId: string, input: { buffer: Buffer; filename: string; contentType: string; as_of: string }, ip?: string): Promise<CourseSourceRecord> {
  const s = sourceRow(ctx, sourceId);
  if (!s) throw notFound('No such course source.');
  if (s.withdrawn_at) throw conflict('That source is withdrawn. Register it again to load its catalog.', 'source_withdrawn');
  notOnLaterDay(ctx, actor, input.as_of, 'as_of', 'The day the catalog is as of');
  const { buffer } = input;
  if (!buffer.length) throw badRequest('That file is empty.');
  if (buffer.length > MAX_CATALOG_BYTES) throw badRequest(`That file is ${Math.ceil(buffer.length / 1_048_576)} MB. A catalog file is at most ${MAX_CATALOG_BYTES / 1_048_576} MB.`, { code: 'too_large' });
  // eslint-disable-next-line no-control-regex
  const filename = input.filename.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'catalog';
  const backup = infrastructureFileProblem(buffer);
  if (backup) throw badRequest(backup, { code: 'infrastructure_file' });
  // Scanned as any upload is, before it is read; a rejected file is never kept, and the entry holds what the scanner found.
  try { await scanUpload(ctx.config.intake, buffer, filename); }
  catch (e) { if (e instanceof MalwareRejected) audit(ctx, { actor_id: actor.id, action: 'upload_rejected', category: 'enterprise', entity: 'course_catalog_loads', detail: `course catalog rejected by the malware scanner: ${e.finding}`.slice(0, 300), ip }); throw e; }
  const read = readCatalog(buffer, filename, input.contentType);
  if (!read.entries.length) {
    throw badRequest(`No course in that file could be read${read.problems.length ? `: line ${read.problems[0].line}, ${read.problems[0].reason}` : '.'}`, { code: 'empty_catalog', problems: read.problems.slice(0, 20) });
  }
  const id = newId();
  const at = now();
  ctx.db.transaction(() => {
    // Read again now the scan is done: a source withdrawn while its file was scanned takes no file.
    if (sourceRow(ctx, sourceId)?.withdrawn_at) throw conflict('That source was withdrawn while its file was read. Register it again to load its catalog.', 'source_withdrawn');
    // What it would change, against the catalog in use.
    const current = ctx.db.prepare(`SELECT e.code, e.code_key, e.name, e.provider, e.description, e.hours, e.ceus, e.category, e.requirements, e.ranks, e.mos
      FROM course_catalog_entries e JOIN course_catalog_loads l ON l.id = e.load_id WHERE l.source_id = ? AND l.status = 'current'`).all(sourceId) as ParsedEntry[];
    const before = new Map(current.map((e) => [e.code_key, e]));
    let added = 0, changed = 0, unchanged = 0;
    for (const e of read.entries) {
      const was = before.get(e.code_key);
      if (!was) added += 1; else if (sameEntry(was, e)) unchanged += 1; else changed += 1;
    }
    const keys = new Set(read.entries.map((e) => e.code_key));
    const preview: CatalogPreview = {
      rows: read.rows, courses: read.entries.length, left_out: read.problems.length, added, changed, unchanged, removed: current.filter((e) => !keys.has(e.code_key)).length,
      sheet: read.sheet, columns: read.columns, ignored_columns: read.ignored_columns, problems: read.problems.slice(0, PROBLEMS_KEPT),
      sample: read.entries.slice(0, SAMPLE_SIZE).map((e) => ({ code: e.code, name: e.name, provider: e.provider, hours: e.hours, ceus: e.ceus, category: e.category })),
    };
    const waiting = ctx.db.prepare("SELECT id FROM course_catalog_loads WHERE source_id = ? AND status = 'staged'").get(sourceId) as { id: string } | undefined;
    if (waiting) discardLoad(ctx, waiting.id, at);
    ctx.db.prepare(`INSERT INTO course_catalog_loads (id, source_id, status, as_of, file_name, file_sha256, byte_size, entry_count, preview, staged_by, staged_at)
      VALUES (?, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, sourceId, input.as_of, filename, sha(buffer), buffer.length, read.entries.length, JSON.stringify(preview), actor.id, at);
    const insert = ctx.db.prepare(`INSERT INTO course_catalog_entries (id, load_id, line, code, code_key, name, provider, description, hours, ceus, category, requirements, ranks, mos)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of read.entries) insert.run(newId(), id, e.line, e.code, e.code_key, e.name, e.provider, e.description, e.hours, e.ceus, e.category, e.requirements, e.ranks, e.mos);
    audit(ctx, { actor_id: actor.id, action: 'course_catalog_staged', entity: 'course_catalog_loads', entity_id: id, detail: `${s.name}: ${filename}, as of ${input.as_of}, ${read.entries.length} courses, ${read.problems.length} rows left out`.slice(0, 1000), ip });
  })();
  return sourceRecord(ctx, sourceId);
}

function stagedLoad(ctx: AppContext, sourceId: string, loadId: string): { s: SourceRow; l: LoadRow } {
  const s = sourceRow(ctx, sourceId);
  if (!s) throw notFound('No such course source.');
  const l = loadRow(ctx, sourceId, loadId);
  if (!l) throw notFound('No such catalog file.');
  if (l.status !== 'staged') throw conflict('That catalog file is no longer waiting to be applied.', 'catalog_closed');
  if (Date.parse(l.staged_at) < Date.now() - STAGED_CATALOG_HOURS * 3_600_000) throw conflict(`That catalog file waited more than ${STAGED_CATALOG_HOURS} hours. Load it again.`, 'catalog_expired');
  return { s, l };
}

/**
 * Apply a staged catalog: it answers lookups from now on, and the catalog it replaces is kept as superseded. A training's
 * values are checked against it the next time they are written; what was verified before stays as it was verified.
 */
export function applyCatalog(ctx: AppContext, actor: SessionUser, sourceId: string, loadId: string, fileSha: string, ip?: string): CourseSourceRecord {
  const { s, l } = stagedLoad(ctx, sourceId, loadId);
  if (s.withdrawn_at) throw conflict('That source is withdrawn.', 'source_withdrawn');
  if (l.file_sha256 !== fileSha) throw conflict('That is not the file this page showed. Look at it again before applying it.', 'catalog_changed');
  const at = now();
  const p = readPreview(l.preview);
  ctx.db.transaction(() => {
    ctx.db.prepare("UPDATE course_catalog_loads SET status = 'superseded', superseded_at = ? WHERE source_id = ? AND status = 'current'").run(at, sourceId);
    const done = ctx.db.prepare("UPDATE course_catalog_loads SET status = 'current', applied_by = ?, applied_at = ? WHERE id = ? AND status = 'staged'").run(actor.id, at, loadId).changes;
    if (!done) throw conflict('That catalog file is no longer waiting to be applied.', 'catalog_closed');
    audit(ctx, { actor_id: actor.id, action: 'course_catalog_applied', entity: 'course_catalog_loads', entity_id: loadId, detail: `${s.name}: ${l.file_name}, as of ${l.as_of}, ${l.entry_count} courses (${p.added} added, ${p.changed} changed, ${p.removed} no longer listed)`.slice(0, 1000), ip });
  })();
  tellOthers(ctx, actor, `${actorName(actor)} applied a course catalog`, `${s.name}, as of ${l.as_of}: ${l.entry_count} courses (${p.added} added, ${p.changed} changed, ${p.removed} no longer listed).`);
  return sourceRecord(ctx, sourceId);
}

/** Discard a staged catalog: nothing was answered from it, so what it listed goes with it. */
export function discardCatalog(ctx: AppContext, actor: SessionUser, sourceId: string, loadId: string, ip?: string): CourseSourceRecord {
  const s = sourceRow(ctx, sourceId);
  if (!s) throw notFound('No such course source.');
  const l = loadRow(ctx, sourceId, loadId);
  if (!l) throw notFound('No such catalog file.');
  if (l.status !== 'staged') throw conflict('That catalog file is no longer waiting to be applied.', 'catalog_closed');
  ctx.db.transaction(() => {
    discardLoad(ctx, loadId, now());
    audit(ctx, { actor_id: actor.id, action: 'course_catalog_discarded', entity: 'course_catalog_loads', entity_id: loadId, detail: `${s.name}: ${l.file_name}`.slice(0, 1000), ip });
  })();
  return sourceRecord(ctx, sourceId);
}

/** One page of what a catalog lists, by code or name. A discarded file lists nothing. */
export function browseCatalog(ctx: AppContext, sourceId: string, loadId: string, query: { q: string; offset: number }): { entries: CourseEntry[]; total: number; offset: number; limit: number } {
  const l = loadRow(ctx, sourceId, loadId);
  if (!l || l.status === 'discarded') throw notFound('No such catalog file.');
  const q = query.q.toLowerCase();
  const key = courseKey(query.q);
  const where = q ? ` AND (e.code_key LIKE ? ESCAPE '\\' OR lower(e.name) LIKE ? ESCAPE '\\')` : '';
  const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const args: unknown[] = q ? [like(key || '\u0000'), like(q)] : [];
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM course_catalog_entries e WHERE e.load_id = ?${where}`).get(loadId, ...args) as { n: number }).n;
  const rows = ctx.db.prepare(`${ENTRY_SELECT} WHERE e.load_id = ?${where} ORDER BY e.code_key, e.id LIMIT ? OFFSET ?`).all(loadId, ...args, CATALOG_PAGE, query.offset) as Parameters<typeof entryOf>[0][];
  return { entries: rows.map(entryOf), total, offset: query.offset, limit: CATALOG_PAGE };
}

/** Catalog files left waiting past their time are discarded. Run hourly by the maintenance loop. */
export function pruneStagedCatalogs(ctx: AppContext): number {
  const cutoff = new Date(Date.now() - STAGED_CATALOG_HOURS * 3_600_000).toISOString();
  const stale = ctx.db.prepare("SELECT id FROM course_catalog_loads WHERE status = 'staged' AND staged_at < ?").all(cutoff) as Array<{ id: string }>;
  if (!stale.length) return 0;
  const at = now();
  ctx.db.transaction(() => { for (const { id } of stale) discardLoad(ctx, id, at); })();
  return stale.length;
}
