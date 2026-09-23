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
  // The roster, retention and hold tables come from schema.sql. These user columns cannot: they
  // carry the identity the feed and a CAC both key on, so an existing database gains them here.
  {
    id: 6,
    name: '006_authoritative_identity',
    run: (db) => {
      const existing = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      const columns: Array<[string, string]> = [
        // The DoD EDIPI. Unique where present, which a partial index enforces below, because most
        // instances will have local accounts with no EDIPI at all and NULLs must stay allowed.
        ['edipi', 'TEXT'],
        // 'local' means a person maintains their own profile. 'roster' means an upstream system
        // does, and the sourced fields stop being self-editable.
        ['identity_source', "TEXT NOT NULL DEFAULT 'local'"],
        ['identity_synced_at', 'TEXT'],
      ];
      for (const [name, type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_edipi ON users(edipi) WHERE edipi IS NOT NULL');
    },
  },
  // The comment, invite and support tables come from schema.sql, which is safe to replay. These
  // columns and indexes cannot be.
  {
    id: 7,
    name: '007_work_coherence',
    run: (db) => {
      // A queue row can now belong to a project, which is what lets a project hold an imported
      // spreadsheet instead of a project and a queue being two unrelated piles of work.
      const work = new Set((db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((c) => c.name));
      if (!work.has('project_id')) db.exec('ALTER TABLE work_items ADD COLUMN project_id TEXT REFERENCES projects(id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id, state)');

      // `tasks.project_id` and `activities.project_id` were never indexed, so "show me this
      // project's work" was a scan of every row the person owns. They are also declared without a
      // foreign key. That is left alone deliberately: adding one means rebuilding the table, and
      // `activities` is the target of work_actions.activity_id, so a rebuild there risks live
      // rows to buy a constraint that purgeDeleted() already maintains by nulling both columns
      // when a project is purged. The index is the part that was actually costing anything.
      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_activities_project ON activities(project_id)');

      // Splitting the work verbs out of "you hold the claim" adds permission bits that no role
      // stored before this migration can possibly have. Gating on them without a backfill would
      // quietly take capability away from every existing unit on the next deploy, so the bits are
      // granted to match exactly what each role could already do:
      //
      //   every role            -> CLAIM_WORK, RESOLVE_WORK
      //   MANAGE_RECORDS holder -> EDIT_WORK, REASSIGN_WORK
      //
      // RESOLVE_WORK goes to everybody because holding a claim already lets you close a case, both
      // by PATCH and by recording a resolving action. Granting it only to MANAGE_RECORDS holders
      // would take that away from every plain member on the next deploy — the exact regression this
      // backfill exists to prevent. The split is a control a unit can now apply, not a tightening
      // applied to everyone by surprise. EDIT_WORK and REASSIGN_WORK are genuinely new: nothing
      // could edit a row's own fields or hand a case over before, so nobody loses them.
      //
      // Nobody gains reach they did not have. ADMINISTRATOR is untouched because it already
      // implies everything through has().
      const CLAIM_WORK = 1 << 13, EDIT_WORK = 1 << 14, RESOLVE_WORK = 1 << 15, REASSIGN_WORK = 1 << 16;
      const MANAGE_RECORDS = 1 << 3;
      db.prepare('UPDATE roles SET permissions = permissions | ? WHERE permissions > 0').run(CLAIM_WORK | RESOLVE_WORK);
      db.prepare('UPDATE roles SET permissions = permissions | ? WHERE permissions & ? != 0')
        .run(EDIT_WORK | REASSIGN_WORK, MANAGE_RECORDS);
    },
  },
  // The work_events, record_drafts, career and demo tables come from schema.sql, which is safe to
  // replay. These columns cannot be. Nothing existing is rewritten except that each work item gains a
  // stage read from the state it already has, so every row lands where it already stood.
  {
    id: 8,
    name: '008_case_history',
    run: (db) => {
      const work = new Set((db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((c) => c.name));
      const workColumns: Array<[string, string]> = [
        // Where the work stands in its workflow. `state` stays, derived from this, so every existing
        // filter and report keeps meaning what it meant.
        ['stage', 'TEXT'],
        // Waiting is its own fact with a category and a start, so elapsed waiting is never mistaken
        // for active work.
        ['waiting_category', 'TEXT'],
        ['waiting_since', 'TEXT'],
        ['blocked_reason', 'TEXT'],
        // The procedure this work follows, pinned to the version it was started under.
        ['procedure_key', 'TEXT'],
        ['procedure_version', 'TEXT'],
      ];
      for (const [name, type] of workColumns) if (!work.has(name)) db.exec(`ALTER TABLE work_items ADD COLUMN ${name} ${type}`);
      db.exec(`UPDATE work_items SET stage = CASE state
                 WHEN 'open' THEN 'not_started' WHEN 'in_progress' THEN 'researching' WHEN 'waiting' THEN 'waiting'
                 WHEN 'resolved' THEN 'resolved' WHEN 'not_applicable' THEN 'not_applicable' ELSE 'not_started' END
               WHERE stage IS NULL`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_stage ON work_items(unit_id, stage)');

      // The history starts with what was already known, so a contribution made before this upgrade
      // still counts after it. Each recorded action and each claim held today becomes one event,
      // marked as backfilled. Additive only: no existing row changes.
      db.exec(`INSERT OR IGNORE INTO work_events (id, work_item_id, unit_id, actor_id, kind, body, idempotency_key, occurred_at, created_at)
               SELECT 'backfill-action-' || a.id, a.work_item_id, a.unit_id, a.user_id, 'action_recorded',
                      json_object('action_id', a.id, 'action', a.kind, 'text', a.note, 'quantity', a.quantity, 'unit_label', a.unit_label,
                                  'drafted_record', a.activity_id IS NOT NULL, 'backfilled', 1),
                      'backfill:action:' || a.id, a.occurred_at || 'T12:00:00.000Z', a.created_at
                 FROM work_actions a`);
      db.exec(`INSERT OR IGNORE INTO work_events (id, work_item_id, unit_id, actor_id, kind, body, idempotency_key, occurred_at, created_at)
               SELECT 'backfill-claim-' || w.id, w.id, w.unit_id, w.claimed_by, 'claimed', json_object('backfilled', 1),
                      'backfill:claim:' || w.id, w.claimed_at, w.claimed_at
                 FROM work_items w WHERE w.claimed_by IS NOT NULL AND w.claimed_at IS NOT NULL AND w.deleted_at IS NULL`);

      const users = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      // Set only on the synthetic people of a demo workspace. A real account never carries it.
      if (!users.has('demo_workspace_id')) db.exec('ALTER TABLE users ADD COLUMN demo_workspace_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_users_demo_workspace ON users(demo_workspace_id) WHERE demo_workspace_id IS NOT NULL');
    },
  },
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
  const version = Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value || 0);
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
