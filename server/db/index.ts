import Database from 'better-sqlite3';
import { readFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RANKS } from './ranks.ts';

export type Db = Database.Database;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(resolve(HERE, 'schema.sql'), 'utf8');

/** Ordered migrations applied after the base schema. Keep each idempotent. */
const MIGRATIONS: Array<{ id: number; name: string; run: (db: Db) => void }> = [
  { id: 1, name: '001_initial', run: () => {} },
  // The tables themselves are created by schema.sql, which runs with IF NOT EXISTS on every boot,
  // so an existing database gains them without touching a single existing row.
  { id: 2, name: '002_work_intake', run: () => {} },
  // The report tables come from schema.sql, which is safe to replay. These columns cannot: SQLite has
  // no ADD COLUMN IF NOT EXISTS, so they are added once here, and skipped if a column already exists.
  {
    id: 3,
    name: '003_typed_goals',
    run: (db) => {
      const existing = new Set((db.prepare('PRAGMA table_info(goals)').all() as Array<{ name: string }>).map((c) => c.name));
      const columns: Array<[string, string]> = [
        ['metric_id', 'TEXT'],
        ['direction', "TEXT NOT NULL DEFAULT 'increase'"],
        ['baseline_value', 'REAL'],
        ['aggregation', "TEXT NOT NULL DEFAULT 'sum'"],
        ['filters', "TEXT NOT NULL DEFAULT '{}'"],
        ['measure_scope', "TEXT NOT NULL DEFAULT 'subject'"],
        ['completed_at', 'TEXT'],
      ];
      for (const [name, type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE goals ADD COLUMN ${name} ${type}`);
    },
  },
  // Correspondence tables come from schema.sql, which is safe to replay.
  { id: 4, name: '004_correspondence', run: () => {} },
  // The product_events table comes from schema.sql, which is safe to replay.
  { id: 5, name: '005_product_events', run: () => {} },
];
export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.id;

/** A database from Vantage 4 or earlier: it has a users table but none of the 5.x columns. */
function isLegacyDatabase(db: Db): boolean {
  const hasUsers = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  if (!hasUsers) return false;
  const columns = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
  return !columns.includes('is_operator');
}

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  let db = new Database(path);
  if (path !== ':memory:' && isLegacyDatabase(db)) {
    // 5.0 ships a fresh schema and does not migrate 4.x data. The old file is set aside, never overwritten.
    db.close();
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${path}.legacy-${stamp}${suffix}`);
    console.warn(`Found a pre-5.0 Vantage database at ${path}. It was moved to ${path}.legacy-${stamp} and a fresh database was created. Restore it on a 4.x build if you need its contents.`);
    db = new Database(path);
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: Db) {
  const current = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string } | undefined)?.valueOf();
  const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value || 0);
  void current;
  for (const m of MIGRATIONS) {
    if (m.id <= version) continue;
    db.transaction(() => {
      m.run(db);
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(m.id));
    })();
  }
}

function seed(db: Db) {
  const insert = db.prepare(
    `INSERT INTO ranks (id, grade, abbr, name, tier, sort) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET grade = excluded.grade, name = excluded.name, tier = excluded.tier, sort = excluded.sort`
  );
  db.transaction(() => { for (const r of RANKS) insert.run(r.abbr, r.grade, r.abbr, r.name, r.tier, r.sort); })();
}

export const metaGet = (db: Db, key: string): string | null =>
  (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
export const metaSet = (db: Db, key: string, value: string) =>
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
export const metaDelete = (db: Db, key: string) => db.prepare('DELETE FROM meta WHERE key = ?').run(key);
