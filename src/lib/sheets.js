import { formatDate } from './metrics.js';
import { downloadText } from './utils.js';
import {
  MAX_IMPORT_COLUMNS, MAX_IMPORT_ROWS, parseDelimited, rowsToCsv,
} from './delimited.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;

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
  ['quantity', 'Action Amount'], ['unit', 'Action Unit'],
  ['dollar_amount', 'Transaction Value'], ['dollar_type', 'Dollar Type'],
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

export async function exportWorkbook({
  activities = [], projects = [], tasks = [], goals = [], recognitions = [], trainings = [], contacts = [],
}, filename) {
  const groups = [
    ['Activity', activityRows(activities, projects)],
    ['Project', simpleRows(projects, [['name', 'Name'], ['status', 'Status'], ['priority', 'Priority'], ['start_date', 'Start'], ['target_date', 'Target'], ['organization', 'Organization'], ['progress', 'Progress %'], ['description', 'Description']])],
    ['Task', simpleRows(tasks, [['title', 'Title'], ['status', 'Status'], ['priority', 'Priority'], ['due_date', 'Due'], ['notes', 'Notes']])],
    ['Goal', simpleRows(goals, [['title', 'Title'], ['type', 'Type'], ['category', 'Category'], ['current_value', 'Current'], ['target_value', 'Target'], ['unit', 'Unit'], ['status', 'Status'], ['period_start', 'Start'], ['period_end', 'End']])],
    ['Recognition', simpleRows(recognitions, [['date', 'Date'], ['title', 'Title'], ['type', 'Type'], ['from_whom', 'From'], ['organization', 'Organization'], ['notes', 'Notes']])],
    ['Development', simpleRows(trainings, [['date', 'Date'], ['title', 'Title'], ['type', 'Type'], ['hours', 'Hours'], ['provider', 'Provider'], ['status', 'Status'], ['notes', 'Notes']])],
    ['Contact', simpleRows(contacts, [['name', 'Name'], ['role', 'Role'], ['organization', 'Organization'], ['email', 'Email'], ['phone', 'Phone'], ['notes', 'Notes']])],
  ];
  const rows = groups.flatMap(([type, entries]) => entries.map((row) => ({ 'Record Type': type, ...row })));
  if (!rows.length) rows.push({ 'Record Type': 'Vantage', Note: 'No records yet.' });
  const safeName = String(filename || `vantage-${formatDate(new Date(), 'yyyy-MM-dd')}.csv`)
    .replace(/\.(xlsx|xls)$/i, '.csv');
  downloadText(safeName, `\uFEFF${rowsToCsv(rows)}`, 'text/csv;charset=utf-8');
  return { filename: safeName, rows: rows.length };
}

export async function parseSpreadsheet(file) {
  const name = String(file?.name || '');
  if (!/\.(csv|tsv)$/i.test(name)) {
    throw new Error('For security, Vantage imports CSV or TSV only. In Excel, use Save As → CSV UTF-8.');
  }
  if (file.size > MAX_FILE_BYTES) throw new Error('That file is larger than the 2 MB import limit.');
  const text = (await file.text()).replace(/^\uFEFF/, '');
  if (text.includes('\0')) throw new Error('That file contains binary data and is not a valid CSV/TSV file.');
  const delimiter = /\.tsv$/i.test(name) ? '\t' : ',';
  const matrix = parseDelimited(text, delimiter)
    .filter((cells) => cells.some((v) => String(v).trim() !== ''));
  if (!matrix.length) return { columns: [], rows: [], sheetName: name };
  const columns = matrix.shift().map((v) => String(v).trim());
  if (columns.length > MAX_IMPORT_COLUMNS) {
    throw new Error(`Imports are limited to ${MAX_IMPORT_COLUMNS} columns.`);
  }
  if (columns.some((c) => !c)) throw new Error('Every imported column needs a header.');
  if (new Set(columns.map((c) => c.toLowerCase())).size !== columns.length) {
    throw new Error('Column headers must be unique.');
  }
  const rows = matrix.map((cells) => Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? ''])));
  return { columns, rows, sheetName: name };
}

export const IMPORT_FIELDS = [
  { key: 'title', label: 'Title', required: true },
  { key: 'date', label: 'Date', required: true },
  { key: 'category', label: 'Category' },
  { key: 'jepes_area', label: 'JEPES Area' },
  { key: 'quantity', label: 'Action Amount', aliases: ['Quantity', 'Action Quantity'] },
  { key: 'unit', label: 'Action Unit', aliases: ['Unit'] },
  { key: 'dollar_amount', label: 'Transaction Value', aliases: ['Dollar Amount', 'Transaction Amount'] },
  { key: 'dollar_type', label: 'Dollar Type', aliases: ['Transaction Dollar Type'] },
  { key: 'result', label: 'Result' },
  { key: 'organization', label: 'Organization' },
  { key: 'system', label: 'System' },
  { key: 'notes', label: 'Notes' },
];

export function guessMapping(columns = []) {
  const map = {};
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  for (const field of IMPORT_FIELDS) {
    const targets = [field.label, ...(field.aliases || [])].map(norm);
    const hit = columns.find((c) => targets.includes(norm(c)))
      || columns.find((c) => targets.some((target) => norm(c).includes(target) || target.includes(norm(c))));
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
