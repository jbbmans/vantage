import Database from 'better-sqlite3';
import { closeSync, existsSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUILD_MIGRATIONS, SCHEMA_VERSION, upgradeSchema, type Db, type Migration } from '../../server/db/index.ts';
import { sha256File } from '../../server/db/copies.ts';
import { describeDifferences, schemaFingerprint, schemaShape, shapeDifferences, type SchemaShape, type ShapeDifference } from '../../server/db/schemaShape.ts';

/**
 * The frozen database fixtures (ADR-0041): databases earlier builds wrote, kept in tests/fixtures/databases and never
 * written again, and the ledger of what schema each recorded version produces. The fixture test and
 * scripts/database-fixtures.ts share what is here.
 */
export const FIXTURE_DIR = resolve(import.meta.dirname, '..', 'fixtures', 'databases');
export const MANIFEST = join(FIXTURE_DIR, 'manifest.json');
export const LEDGER = join(FIXTURE_DIR, 'fingerprints.json');
/** The secret every fixture's trail is sealed under: the test helpers', as each build had it. */
export const FIXTURE_SECRET = 'test-secret-test-secret-test-secret-1234';

export interface FixtureEntry {
  file: string;
  /** The git ref it was frozen from, the commit that ref named, and that build's version and schema. */
  ref: string; commit: string; version: string; schema: number;
  sha256: string; bytes: number; frozenAt: string;
  /** Rows in each table as frozen. */
  rows: Record<string, number>;
  /** The scenario's steps and what that build answered to each. */
  steps: Array<{ step: string; status: number | string }>;
}
export interface Manifest { format: 'vantage-database-fixtures/1'; fixtures: FixtureEntry[] }
export interface LedgerEntry { fingerprint: string; migration: string | null; recordedAt: string; from: 'build' | 'fixture' }
export interface Ledger { format: 'vantage-schema-fingerprints/1'; versions: Record<string, LedgerEntry> }

export function readManifest(): Manifest {
  if (!existsSync(MANIFEST)) return { format: 'vantage-database-fixtures/1', fixtures: [] };
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as Manifest;
}

export function readLedger(): Ledger {
  if (!existsSync(LEDGER)) return { format: 'vantage-schema-fingerprints/1', versions: {} };
  return JSON.parse(readFileSync(LEDGER, 'utf8')) as Ledger;
}

/** Whether the fixture on disk is the file its manifest names. */
export const fixtureIntact = (entry: FixtureEntry) => existsSync(join(FIXTURE_DIR, entry.file)) && sha256File(join(FIXTURE_DIR, entry.file)) === entry.sha256;

/** A fixture loaded into memory, as a start would open it, so nothing on disk is written. */
export function fixtureInMemory(entry: FixtureEntry): Db {
  const disk = new Database(join(FIXTURE_DIR, entry.file), { readonly: true, fileMustExist: true });
  let bytes: Buffer;
  try { bytes = disk.serialize(); } finally { disk.close(); }
  const db = new Database(bytes);
  db.pragma('foreign_keys = ON');
  return db;
}

/** A new database at this build's schema, with these migrations (this build's unless a test changes one). */
export function freshDatabase(migrations: readonly Migration[] = BUILD_MIGRATIONS): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  upgradeSchema(db, { migrations });
  return db;
}

const named = (m: Migration) => `migration ${m.id} (${m.name})`;

/**
 * For each object that differs, the migration that last changed it, found by taking the fixture through the migrations
 * one at a time. Null when none did: then the base schema, not a migration, made it so.
 */
export function blame(entry: FixtureEntry, migrations: readonly Migration[], objects: string[]): Record<string, Migration | null> {
  const db = fixtureInMemory(entry);
  try {
    const done = migrations.filter((m) => m.id <= entry.schema);
    if (done.length) upgradeSchema(db, { migrations: done });
    let previous: SchemaShape = schemaShape(db);
    const last: Record<string, Migration | null> = Object.fromEntries(objects.map((o) => [o, null]));
    for (const m of migrations.filter((x) => x.id > entry.schema)) {
      upgradeSchema(db, { migrations: migrations.filter((x) => x.id <= m.id) });
      const shape = schemaShape(db);
      for (const o of objects) if (JSON.stringify(shape[o]) !== JSON.stringify(previous[o])) last[o] = m;
      previous = shape;
    }
    return last;
  } finally { db.close(); }
}

/**
 * Upgrades a fixture with these migrations, as a start would, and compares its schema with a new database's. Empty when
 * they match; otherwise each difference, with the migration that last changed that object.
 */
export function upgradeParity(entry: FixtureEntry, migrations: readonly Migration[] = BUILD_MIGRATIONS): { differences: ShapeDifference[]; message: string } {
  const db = fixtureInMemory(entry);
  let upgraded: SchemaShape;
  try { upgradeSchema(db, { migrations }); upgraded = schemaShape(db); } finally { db.close(); }
  const fresh = freshDatabase(migrations);
  let wanted: SchemaShape;
  try { wanted = schemaShape(fresh); } finally { fresh.close(); }
  const differences = shapeDifferences(upgraded, wanted);
  if (!differences.length) return { differences, message: '' };
  const culprits = blame(entry, migrations, differences.map((d) => d.object));
  const lines = differences.slice(0, 20).map((d) => {
    const by = culprits[d.object];
    return `${d.object}: last changed by ${by ? named(by) : 'the base schema, not a migration'}`;
  });
  return {
    differences,
    message: `${entry.file} (schema ${entry.schema}, ${entry.ref}) upgraded to schema ${migrations.at(-1)!.id} does not match a new database ("first" is the upgraded one, "second" the new one):\n${describeDifferences(differences)}\n${lines.join('\n')}`,
  };
}

/**
 * The recorded versions below `newest` that no frozen database reaches. A migration edited in place is caught only by a
 * database frozen at or after its version, which already ran it as it shipped: every recorded version but the newest
 * needs one (ADR-0041).
 */
export function unfrozenVersions(manifest: Manifest, ledger: Ledger, newest: number): number[] {
  const frozen = Math.max(0, ...manifest.fixtures.map((f) => f.schema));
  return Object.keys(ledger.versions).map(Number).filter((v) => v < newest && v > frozen).sort((a, b) => a - b);
}

/** The fingerprint of a new database's schema at this build's schema version. */
export function buildFingerprint(): { schema: number; fingerprint: string; migration: string } {
  const db = freshDatabase();
  try { return { schema: SCHEMA_VERSION, fingerprint: schemaFingerprint(db), migration: BUILD_MIGRATIONS.at(-1)!.name }; } finally { db.close(); }
}

/** Rows in every table, by name. */
export function rowCounts(db: Db): Record<string, number> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
  return Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n]));
}

/**
 * Writes over the entries of one of the audit trail's indexes, in place: SQLite still opens the file and reads its
 * tables, and its integrity check fails. The damage a bad disk or a bad transfer does to a page.
 */
export function damagePages(file: string) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let pageSize: number;
  let roots: number[];
  try {
    pageSize = Number(db.pragma('page_size', { simple: true }));
    roots = (db.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log' AND sql IS NOT NULL ORDER BY name").all() as Array<{ rootpage: number }>).map((r) => r.rootpage);
  } finally { db.close(); }
  const fd = openSync(file, 'r+');
  try {
    for (const root of roots) {
      const page = Buffer.alloc(pageSize);
      readSync(fd, page, 0, pageSize, (root - 1) * pageSize);
      // A b-tree page says where its cells begin (bytes 5 and 6 of its header); an index with no entries has none.
      const cells = page.readUInt16BE(5) || 65536;
      if (page[0] !== 0x0a || cells >= pageSize) continue;
      writeSync(fd, Buffer.alloc(pageSize - cells, 0x41), 0, pageSize - cells, (root - 1) * pageSize + cells);
      return;
    }
  } finally { closeSync(fd); }
  throw new Error(`${file} has no audit index with entries to damage.`);
}
