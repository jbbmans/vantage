/**
 * Vantage — spreadsheet bridge.
 *
 * Export exists because a board package, a monitor, and a civilian résumé all
 * eventually want a table. Import exists because a record that can't absorb
 * the tracker you already keep isn't worth switching to.
 *
 * xlsx is loaded on demand so the ~400KB parser never lands in the initial bundle.
 */

import { formatDate } from './metrics.js';

async function xlsx() {
  return import('xlsx');
}

const val = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object') {
      return v.map((o) => [o.label, o.url].filter(Boolean).join(': ')).join(' | ');
    }
    return v.join('; ');
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
};

const ACTIVITY_COLUMNS = [
  ['date', 'Date'], ['title', 'Title'], ['category', 'Category'], ['jepes_area', 'JEPES Area'],
  ['quantity', 'Quantity'], ['unit', 'Unit'],
  ['dollar_amount', 'Dollar Amount'], ['dollar_type', 'Dollar Type'],
  ['result', 'Result'], ['organization', 'Organization'], ['system', 'System'],
  ['project', 'Project'], ['people', 'People'], ['status', 'Status'],
  ['impact_tags', 'Tags'], ['evidence_links', 'Evidence'], ['notes', 'Notes'],
  ['start_date', 'Start Date'], ['end_date', 'End Date'],
  ['start_time', 'Start Time'], ['end_time', 'End Time'], ['description', 'Description'],
];

export function activityRows(list = [], projects = []) {
  const names = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  return list.map((a) => {
    const row = {};
    for (const [key, label] of ACTIVITY_COLUMNS) {
      row[label] = key === 'project' ? names[a.project_id] || '' : val(a[key]);
    }
    return row;
  });
}

const simpleRows = (list, columns) =>
  list.map((r) => Object.fromEntries(columns.map(([k, label]) => [label, val(r[k])])));

/** Auto-size columns to their widest cell so the file opens readable. */
function fit(rows) {
  if (!rows.length) return [];
  return Object.keys(rows[0]).map((key) => ({
    wch: Math.min(52, Math.max(key.length + 2, ...rows.map((r) => String(r[key] ?? '').length + 2))),
  }));
}

export async function exportWorkbook({ activities = [], projects = [], tasks = [], goals = [], recognitions = [], trainings = [], contacts = [] }, filename) {
  const XLSX = await xlsx();
  const wb = XLSX.utils.book_new();

  const sheets = [
    ['Activities', activityRows(activities, projects)],
    ['Projects', simpleRows(projects, [['name', 'Name'], ['status', 'Status'], ['priority', 'Priority'], ['start_date', 'Start'], ['target_date', 'Target'], ['organization', 'Organization'], ['progress', 'Progress %'], ['description', 'Description']])],
    ['Tasks', simpleRows(tasks, [['title', 'Title'], ['status', 'Status'], ['priority', 'Priority'], ['due_date', 'Due'], ['notes', 'Notes']])],
    ['Goals', simpleRows(goals, [['title', 'Title'], ['type', 'Type'], ['category', 'Category'], ['current_value', 'Current'], ['target_value', 'Target'], ['unit', 'Unit'], ['status', 'Status'], ['period_start', 'Start'], ['period_end', 'End']])],
    ['Recognition', simpleRows(recognitions, [['date', 'Date'], ['title', 'Title'], ['type', 'Type'], ['from', 'From'], ['organization', 'Organization'], ['notes', 'Notes']])],
    ['Development', simpleRows(trainings, [['date', 'Date'], ['title', 'Title'], ['type', 'Type'], ['hours', 'Hours'], ['provider', 'Provider'], ['status', 'Status'], ['notes', 'Notes']])],
    ['Contacts', simpleRows(contacts, [['name', 'Name'], ['role', 'Role'], ['organization', 'Organization'], ['email', 'Email'], ['phone', 'Phone'], ['notes', 'Notes']])],
  ];

  for (const [name, rows] of sheets) {
    if (!rows.length) continue;
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = fit(rows);
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    XLSX.utils.book_append_sheet(wb, ws, name);
  }

  if (!wb.SheetNames.length) {
    const ws = XLSX.utils.json_to_sheet([{ Note: 'No records yet.' }]);
    XLSX.utils.book_append_sheet(wb, ws, 'Vantage');
  }

  XLSX.writeFile(wb, filename || `vantage-${formatDate(new Date(), 'yyyy-MM-dd')}.xlsx`);
}

/** Parse the first sheet of a CSV/XLSX into { columns, rows }. */
export async function parseSpreadsheet(file) {
  const XLSX = await xlsx();
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('That workbook has no sheets.');
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rows, sheetName: wb.SheetNames[0] };
}

/** Fields an imported row can be mapped onto. */
export const IMPORT_FIELDS = [
  { key: 'title', label: 'Title', required: true },
  { key: 'date', label: 'Date', required: true },
  { key: 'category', label: 'Category' },
  { key: 'jepes_area', label: 'JEPES Area' },
  { key: 'quantity', label: 'Quantity' },
  { key: 'unit', label: 'Unit' },
  { key: 'dollar_amount', label: 'Dollar Amount' },
  { key: 'dollar_type', label: 'Dollar Type' },
  { key: 'result', label: 'Result' },
  { key: 'organization', label: 'Organization' },
  { key: 'system', label: 'System' },
  { key: 'notes', label: 'Notes' },
];

/** Guess a column→field mapping from header names. Saves most of the clicking. */
export function guessMapping(columns = []) {
  const map = {};
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  for (const field of IMPORT_FIELDS) {
    const target = norm(field.label);
    const hit = columns.find((c) => norm(c) === target)
      || columns.find((c) => norm(c).includes(target) || target.includes(norm(c)));
    if (hit) map[field.key] = hit;
  }
  return map;
}

const toNumber = (v) => {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return Number.isNaN(n) ? null : n;
};

const toISODate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};

/** Apply a mapping to raw rows. Returns records plus per-row problems. */
export function applyMapping(rows = [], mapping = {}) {
  const records = [];
  const problems = [];
  rows.forEach((row, i) => {
    const rec = {};
    for (const [field, column] of Object.entries(mapping)) {
      if (!column) continue;
      rec[field] = row[column];
    }
    rec.quantity = toNumber(rec.quantity);
    rec.dollar_amount = toNumber(rec.dollar_amount);
    rec.date = toISODate(rec.date);
    rec.title = String(rec.title || '').trim();
    rec.status = 'completed';

    if (!rec.title) problems.push({ row: i + 2, issue: 'missing title' });
    else if (!rec.date) problems.push({ row: i + 2, issue: 'unreadable date' });
    else records.push(rec);
  });
  return { records, problems };
}
