export const MAX_IMPORT_ROWS = 1000;
export const MAX_IMPORT_COLUMNS = 100;

export function safeCell(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = String(value ?? '');
  return /^\s*[=+\-@]/u.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown): string {
  return `"${safeCell(value).replace(/"/g, '""')}"`;
}

export function rowsToCsv(rows: Array<Record<string, unknown>>, headers?: string[]): string {
  const cols = headers ? [...headers] : [];
  if (!headers) for (const row of rows) for (const key of Object.keys(row)) if (!cols.includes(key)) cols.push(key);
  return [cols.map(csvCell).join(','), ...rows.map((row) => cols.map((key) => csvCell(row[key])).join(','))].join('\r\n');
}

export function parseDelimited(text: string, delimiter: ',' | '\t', { maxRows = MAX_IMPORT_ROWS } = {}): string[][] {
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closedQuote = false;
  const finishRow = () => {
    row.push(cell);
    matrix.push(row);
    if (matrix.length > maxRows + 1) throw new Error(`Imports are limited to ${maxRows} data rows.`);
    row = [];
    cell = '';
    closedQuote = false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
      else if (ch === '"') { quoted = false; closedQuote = true; }
      else cell += ch;
      continue;
    }
    if (closedQuote && ch !== delimiter && ch !== '\n' && ch !== '\r') throw new Error('Unexpected text after a closing quote. Check the CSV formatting.');
    if (ch === '"') {
      if (cell !== '') throw new Error('A quote inside an unquoted cell must be doubled.');
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell); cell = ''; closedQuote = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      finishRow();
    } else cell += ch;
  }
  if (quoted) throw new Error('The file ends inside a quoted cell. Check the CSV formatting.');
  if (cell !== '' || row.length || closedQuote) finishRow();
  return matrix;
}

/** Canonical activity CSV columns. Export writes exactly these; import recognizes them exactly. */
export const ACTIVITY_CSV_COLUMNS: Array<{ key: string; header: string; aliases?: string[] }> = [
  { key: 'id', header: 'Vantage ID' },
  { key: 'date', header: 'Date' },
  { key: 'title', header: 'Title' },
  { key: 'category', header: 'Category' },
  { key: 'eval_area', header: 'Evaluation Area', aliases: ['JEPES Area', 'Area'] },
  { key: 'quantity', header: 'Action Amount', aliases: ['Quantity', 'Action Quantity'] },
  { key: 'unit_label', header: 'Action Unit', aliases: ['Unit', 'Units'] },
  { key: 'dollar_amount', header: 'Transaction Value', aliases: ['Dollar Amount', 'Dollars', 'Transaction Amount'] },
  { key: 'dollar_type', header: 'Dollar Type', aliases: ['Transaction Dollar Type'] },
  { key: 'result', header: 'Result', aliases: ['Outcome'] },
  { key: 'organization', header: 'Organization', aliases: ['Org'] },
  { key: 'system', header: 'System' },
  { key: 'status', header: 'Status' },
  { key: 'visibility', header: 'Visibility' },
  { key: 'notes', header: 'Notes' },
  { key: 'evidence_links', header: 'Evidence Links', aliases: ['Evidence', 'Links'] },
];

const norm = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

export function guessMapping(columns: string[] = []): Record<string, string> {
  const map: Record<string, string> = {};
  for (const field of ACTIVITY_CSV_COLUMNS) {
    const targets = [field.header, ...(field.aliases || []), field.key].map(norm);
    const hit = columns.find((c) => targets.includes(norm(c)))
      || columns.find((c) => targets.some((t) => t.length > 3 && (norm(c).includes(t) || t.includes(norm(c)))));
    if (hit && !Object.values(map).includes(hit)) map[field.key] = hit;
  }
  return map;
}

export function parseCsvText(text: string, delimiter: ',' | '\t' = ','): { columns: string[]; rows: Array<Record<string, string>> } {
  const clean = text.replace(/^\uFEFF/, '');
  if (clean.includes('\0')) throw new Error('That file contains binary data and is not a valid CSV file.');
  const matrix = parseDelimited(clean, delimiter).filter((cells) => cells.some((v) => String(v).trim() !== ''));
  if (!matrix.length) return { columns: [], rows: [] };
  const columns = matrix.shift()!.map((v) => String(v).trim());
  if (columns.length > MAX_IMPORT_COLUMNS) throw new Error(`Imports are limited to ${MAX_IMPORT_COLUMNS} columns.`);
  if (columns.some((c) => !c)) throw new Error('Every imported column needs a header.');
  if (new Set(columns.map((c) => c.toLowerCase())).size !== columns.length) throw new Error('Column headers must be unique.');
  const rows = matrix.map((cells) => Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? ''])));
  return { columns, rows };
}

const toNumber = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isNaN(n) ? null : n;
};

const toISODate = (v: unknown): string | null => {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const month = Number(m[1]); const day = Number(m[2]);
    const d = new Date(Date.UTC(y, month - 1, day));
    if (Number.isNaN(d.getTime()) || d.getUTCFullYear() !== y || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

export interface ImportedActivity {
  id?: string; title: string; date: string; category?: string | null; eval_area?: string | null; quantity: number | null;
  unit_label?: string | null; dollar_amount: number | null; dollar_type?: string | null; result?: string | null;
  organization?: string | null; system?: string | null; status: string; visibility?: string | null; notes?: string | null;
  evidence_links?: Array<{ label?: string; url?: string }>;
}

export function applyMapping(rows: Array<Record<string, string>>, mapping: Record<string, string>) {
  const records: ImportedActivity[] = [];
  const problems: Array<{ row: number; issue: string }> = [];
  rows.forEach((row, i) => {
    const rec: Record<string, unknown> = {};
    for (const [field, column] of Object.entries(mapping)) {
      if (!column) continue;
      const raw = row[column];
      rec[field] = raw == null ? '' : String(raw).trim();
    }
    const out: ImportedActivity = {
      id: rec.id ? String(rec.id) : undefined,
      title: String(rec.title || '').trim(),
      date: toISODate(rec.date) || '',
      category: rec.category ? String(rec.category) : null,
      eval_area: rec.eval_area ? String(rec.eval_area) : null,
      quantity: toNumber(rec.quantity),
      unit_label: rec.unit_label ? String(rec.unit_label) : null,
      dollar_amount: toNumber(rec.dollar_amount),
      dollar_type: rec.dollar_type ? String(rec.dollar_type).toLowerCase() : null,
      result: rec.result ? String(rec.result) : null,
      organization: rec.organization ? String(rec.organization) : null,
      system: rec.system ? String(rec.system) : null,
      status: rec.status === 'planned' ? 'planned' : 'completed',
      visibility: rec.visibility === 'unit' || rec.visibility === 'private' ? String(rec.visibility) : null,
      notes: rec.notes ? String(rec.notes) : null,
      evidence_links: rec.evidence_links
        ? String(rec.evidence_links).split('|').map((s) => s.trim()).filter(Boolean).map((s) => {
          const [label, ...rest] = s.includes(': ') ? s.split(': ') : ['', s];
          return { label: label || undefined, url: rest.join(': ') || undefined };
        })
        : [],
    };
    if (!out.title) problems.push({ row: i + 2, issue: 'missing title' });
    else if (!out.date) problems.push({ row: i + 2, issue: 'unreadable date' });
    else records.push(out);
  });
  return { records, problems };
}

export function activityToCsvRow(a: Record<string, unknown>): Record<string, unknown> {
  const links = Array.isArray(a.evidence_links)
    ? (a.evidence_links as Array<{ label?: string | null; url?: string | null }>).map((l) => [l.label, l.url].filter(Boolean).join(': ')).join(' | ')
    : '';
  const row: Record<string, unknown> = {};
  for (const col of ACTIVITY_CSV_COLUMNS) row[col.header] = col.key === 'evidence_links' ? links : a[col.key] ?? '';
  return row;
}
