import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

type Db = Database.Database;

/**
 * A database's schema as what it does, not how its SQL was written (ADR-0041): comments, spacing and letter case outside
 * quotes are dropped, and a table's column and constraint definitions are kept as a sorted list, so a column an upgrade
 * appended matches one a new database declares in the middle. Every table, index, trigger and view SQLite keeps is in
 * it; SQLite's own objects (`sqlite_sequence`, `sqlite_stat1`, the indexes it makes for a key) are not, since they follow
 * from the rest. Two databases with the same shape accept and refuse the same rows the same way.
 */
export type SchemaShape = Record<string, string[]>;

/** The SQL with comments removed and everything outside quotes in one case and one spacing. */
export function normalizeSql(sql: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) { out += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '[') { const end = sql.indexOf(']', i); out += sql.slice(i, end < 0 ? undefined : end + 1); i = end < 0 ? sql.length : end; continue; }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i += 1; out += ' '; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const end = sql.indexOf('*/', i + 2); i = end < 0 ? sql.length : end + 1; out += ' '; continue; }
    out += /\s/.test(ch) ? ' ' : ch.toLowerCase();
  }
  // One space at most, and none beside punctuation, outside quotes. Quoted text is kept exactly.
  return out.split(/('(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\])/).map((part, i) => (i % 2 ? part : part.replace(/ +/g, ' ').replace(/ ?([(),;=<>!|+*/%-]) ?/g, '$1'))).join('').trim();
}

/** A CREATE TABLE's column and constraint definitions, each normalized, sorted; what follows its closing bracket (WITHOUT ROWID, STRICT) too. */
export function tableDefinitions(sql: string): string[] {
  const text = normalizeSql(sql);
  const open = text.indexOf('(');
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  let end = text.length;
  for (let i = open + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; current += ch; continue; }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      if (depth === 0) { end = i; break; }
      depth -= 1;
    }
    if (ch === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  const options = text.slice(end + 1).trim();
  if (options) parts.push(`options ${options}`);
  return parts.sort();
}

/** The shape of every table, index, trigger and view in the database. */
export function schemaShape(db: Db): SchemaShape {
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name").all() as Array<{ type: string; name: string; sql: string }>;
  const shape: SchemaShape = {};
  for (const row of rows) shape[`${row.type} ${row.name}`] = row.type === 'table' ? tableDefinitions(row.sql) : [normalizeSql(row.sql)];
  return shape;
}

/** The SHA-256 of a schema's shape: the same for two databases whose schemas do the same thing. */
export function schemaFingerprint(source: Db | SchemaShape): string {
  const shape = 'prepare' in source && typeof source.prepare === 'function' ? schemaShape(source as Db) : source as SchemaShape;
  const canonical = JSON.stringify(Object.keys(shape).sort().map((key) => [key, shape[key]]));
  return createHash('sha256').update(canonical).digest('hex');
}

/** One object two shapes disagree on: what only the first has, what only the second has. */
export interface ShapeDifference { object: string; only: 'first' | 'second' | null; first: string[]; second: string[] }

/** Where two shapes disagree, object by object, in name order. */
export function shapeDifferences(first: SchemaShape, second: SchemaShape): ShapeDifference[] {
  const keys = [...new Set([...Object.keys(first), ...Object.keys(second)])].sort();
  const out: ShapeDifference[] = [];
  for (const object of keys) {
    const a = first[object];
    const b = second[object];
    if (a && b && JSON.stringify(a) === JSON.stringify(b)) continue;
    out.push({
      object, only: !b ? 'first' : !a ? 'second' : null,
      first: (a ?? []).filter((part) => !(b ?? []).includes(part)),
      second: (b ?? []).filter((part) => !(a ?? []).includes(part)),
    });
  }
  return out;
}

/** The differences as lines a person can read, at most `limit` of them. */
export function describeDifferences(differences: ShapeDifference[], limit = 20): string {
  const lines = differences.slice(0, limit).map((d) => {
    if (d.only === 'first') return `${d.object}: only in the first`;
    if (d.only === 'second') return `${d.object}: only in the second`;
    return `${d.object}: ${[...d.first.map((p) => `first has "${p}"`), ...d.second.map((p) => `second has "${p}"`)].join('; ')}`;
  });
  if (differences.length > limit) lines.push(`and ${differences.length - limit} more`);
  return lines.join('\n');
}
