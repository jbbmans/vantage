/**
 * Reads the cell values out of an .xlsx workbook, and nothing else.
 *
 * The design rule here is that a workbook is data, never a program. This reader:
 *  - never opens vbaProject.bin, so a macro is bytes we ignore rather than code we run;
 *  - never evaluates a formula, and reports the cached result Excel already stored;
 *  - never follows an external link or a DDE reference;
 *  - never resolves an XML entity, so an entity-expansion document cannot be used against us.
 *
 * It is intentionally small. A workbook feature we do not understand is reported as unread,
 * not guessed at.
 */
import { readZip, ZipError } from './zip.ts';

export { ZipError };

export class WorkbookError extends Error {
  constructor(message: string) { super(message); this.name = 'WorkbookError'; }
}

export interface Sheet { name: string; rows: string[][]; truncated: boolean }
export interface Workbook {
  sheets: Sheet[];
  /** Features present in the file that we deliberately did not read. Shown to the person importing. */
  notes: string[];
}

export interface WorkbookLimits { maxRows?: number; maxColumns?: number; maxCells?: number }

const XML_DECL_ENTITY = /<!(DOCTYPE|ENTITY)\b/i;

function assertNoEntities(xml: string, part: string) {
  // A DOCTYPE is not used by the spreadsheet format, and is the vehicle for entity expansion.
  if (XML_DECL_ENTITY.test(xml)) throw new WorkbookError(`The part "${part}" declares an XML entity. Vantage does not open workbooks that do.`);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    // Only the five predefined entities exist here; anything else is not something we expand.
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : whole;
  });
}

/** Column letters to a zero-based index: A is 0, Z is 25, AA is 26. */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function sharedStrings(xml: string): string[] {
  assertNoEntities(xml, 'sharedStrings.xml');
  const out: string[] = [];
  // Each <si> may hold one <t> or several inside <r> runs; the string is the runs joined.
  for (const si of xml.split('<si>').slice(1)) {
    const body = si.split('</si>')[0];
    let text = '';
    for (const m of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += decode(m[1]);
    out.push(text);
  }
  return out;
}

/** Excel stores a date as a serial number. 1900-based, with the famous non-existent 29 Feb 1900. */
function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0 || serial > 2_958_465) return null;
  const days = Math.floor(serial) - (serial >= 61 ? 1 : 0);
  const ms = Date.UTC(1900, 0, 1) + (days - 1) * 86_400_000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Number-format ids and codes Excel uses for dates, so a date does not arrive as 45678. */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

function dateStyles(stylesXml: string | undefined): Set<number> {
  const out = new Set<number>();
  if (!stylesXml) return out;
  assertNoEntities(stylesXml, 'styles.xml');
  const customDateFormats = new Set<number>();
  for (const m of stylesXml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g)) {
    const code = decode(m[2]);
    // A format containing a date or time token, outside quoted literal text, means a date cell.
    if (/[dmyhs]/i.test(code.replace(/"[^"]*"/g, '')) && !/^[#0.,%\s]+$/.test(code)) customDateFormats.add(Number(m[1]));
  }
  const cellXfs = stylesXml.split('<cellXfs')[1]?.split('</cellXfs>')[0] || '';
  let index = 0;
  for (const m of cellXfs.matchAll(/<xf\b[^>]*>/g)) {
    const id = Number(/numFmtId="(\d+)"/.exec(m[0])?.[1] ?? 0);
    if (BUILTIN_DATE_FORMATS.has(id) || customDateFormats.has(id)) out.add(index);
    index += 1;
  }
  return out;
}

function parseSheet(xml: string, strings: string[], dateStyleIndexes: Set<number>, limits: Required<WorkbookLimits>, name: string): Sheet {
  assertNoEntities(xml, name);
  const rows: string[][] = [];
  let cells = 0;
  let truncated = false;

  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= limits.maxRows) { truncated = true; break; }
    const declared = Number(/\br="(\d+)"/.exec(rowMatch[1])?.[1] ?? 0);
    // A sparse sheet skips empty rows; keep the alignment so row 40 stays row 40.
    while (declared > 0 && rows.length < declared - 1 && rows.length < limits.maxRows) rows.push([]);
    const row: string[] = [];
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1];
      const body = cellMatch[2] || '';
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const col = ref ? columnIndex(ref) : row.length;
      if (col < 0 || col >= limits.maxColumns) continue;
      cells += 1;
      if (cells > limits.maxCells) { truncated = true; break; }

      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || 'n';
      const style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] ?? -1);
      let value = '';
      if (type === 'inlineStr') {
        for (const t of body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) value += decode(t[1]);
      } else {
        // <v> is the cached value. When the cell is a formula we read this and never the <f>.
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v == null) value = '';
        else if (type === 's') value = strings[Number(v)] ?? '';
        else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (type === 'e') value = decode(v);
        else if (type === 'str') value = decode(v);
        else {
          const num = Number(v);
          const asDate = dateStyleIndexes.has(style) ? serialToIso(num) : null;
          value = asDate ?? decode(v);
        }
      }
      while (row.length < col) row.push('');
      row[col] = value;
    }
    rows.push(row);
    if (truncated) break;
  }

  // Trailing entirely-empty rows are formatting, not data.
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
  return { name, rows, truncated };
}

export function readWorkbook(buf: Buffer, limits: WorkbookLimits = {}): Workbook {
  const bounds: Required<WorkbookLimits> = {
    maxRows: limits.maxRows ?? 50_000,
    maxColumns: limits.maxColumns ?? 256,
    maxCells: limits.maxCells ?? 1_000_000,
  };
  const parts = readZip(buf);
  const text = (name: string) => { const b = parts.get(name); return b ? b.toString('utf8') : undefined; };

  const notes: string[] = [];
  if ([...parts.keys()].some((n) => /vbaProject\.bin$/i.test(n))) notes.push('This workbook contains macros. Vantage read its cell values and did not open the macro code.');
  if (parts.has('xl/externalLinks/externalLink1.xml') || [...parts.keys()].some((n) => n.startsWith('xl/externalLinks/'))) notes.push('This workbook links to other files. Vantage read only the values saved inside it and followed no link.');
  if ([...parts.keys()].some((n) => /queryTable|connections\.xml$/i.test(n))) notes.push('This workbook holds a saved data connection. Vantage did not run it.');

  const workbookXml = text('xl/workbook.xml');
  if (!workbookXml) throw new WorkbookError('This file is not an Excel workbook.');
  assertNoEntities(workbookXml, 'workbook.xml');

  const relsXml = text('xl/_rels/workbook.xml.rels') || '';
  assertNoEntities(relsXml, 'workbook.xml.rels');
  const targets = new Map<string, string>();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) targets.set(m[1], decode(m[2]));

  const strings = sharedStrings(text('xl/sharedStrings.xml') || '');
  const styleIndexes = dateStyles(text('xl/styles.xml'));

  const sheets: Sheet[] = [];
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const name = decode(/\bname="([^"]*)"/.exec(attrs)?.[1] || `Sheet ${sheets.length + 1}`);
    const state = /\bstate="([^"]*)"/.exec(attrs)?.[1];
    const rid = /\br:id="([^"]+)"/.exec(attrs)?.[1];
    if (state === 'hidden' || state === 'veryHidden') { notes.push(`The sheet "${name}" is hidden in this workbook, so it was not offered for import.`); continue; }
    const target = rid ? targets.get(rid) : undefined;
    const path = target ? (target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`) : `xl/worksheets/sheet${sheets.length + 1}.xml`;
    const sheetXml = text(path);
    if (!sheetXml) { notes.push(`The sheet "${name}" could not be read from this workbook.`); continue; }
    sheets.push(parseSheet(sheetXml, strings, styleIndexes, bounds, name));
  }
  if (!sheets.length) throw new WorkbookError('This workbook has no readable sheet.');
  return { sheets, notes };
}

/** Splits delimited text into rows. Handles quoted fields, embedded newlines, and a BOM. */
export function readDelimited(text: string, delimiter = ','): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].every((c) => !c)) rows.pop();
  return rows;
}

/** Guesses the delimiter from the first line, so a tab- or semicolon-separated export still works. */
export function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [',', '\t', ';', '|'].map((d) => [d, firstLine.split(d).length - 1] as const);
  const best = counts.reduce((a, b) => (b[1] > a[1] ? b : a));
  return best[1] > 0 ? best[0] : ',';
}
