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
  { id: 2, name: '002_work_intake', run: () => {} },
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
  {
    id: 6,
    name: '006_authoritative_identity',
    run: (db) => {
      const existing = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      const columns: Array<[string, string]> = [
        ['edipi', 'TEXT'],
        ['identity_source', "TEXT NOT NULL DEFAULT 'local'"],
        ['identity_synced_at', 'TEXT'],
      ];
      for (const [name, type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_edipi ON users(edipi) WHERE edipi IS NOT NULL');
    },
  },
  {
    id: 7,
    name: '007_work_coherence',
    run: (db) => {
      const work = new Set((db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((c) => c.name));
      if (!work.has('project_id')) db.exec('ALTER TABLE work_items ADD COLUMN project_id TEXT REFERENCES projects(id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id, state)');

      db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_activities_project ON activities(project_id)');

      const CLAIM_WORK = 1 << 13, EDIT_WORK = 1 << 14, RESOLVE_WORK = 1 << 15, REASSIGN_WORK = 1 << 16;
      const MANAGE_RECORDS = 1 << 3;
      db.prepare('UPDATE roles SET permissions = permissions | ? WHERE permissions > 0').run(CLAIM_WORK | RESOLVE_WORK);
      db.prepare('UPDATE roles SET permissions = permissions | ? WHERE permissions & ? != 0')
        .run(EDIT_WORK | REASSIGN_WORK, MANAGE_RECORDS);
    },
  },
  {
    id: 8,
    name: '008_case_history',
    run: (db) => {
      const work = new Set((db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((c) => c.name));
      const workColumns: Array<[string, string]> = [
        ['stage', 'TEXT'],
        ['waiting_category', 'TEXT'],
        ['waiting_since', 'TEXT'],
        ['blocked_reason', 'TEXT'],
        ['procedure_key', 'TEXT'],
        ['procedure_version', 'TEXT'],
      ];
      for (const [name, type] of workColumns) if (!work.has(name)) db.exec(`ALTER TABLE work_items ADD COLUMN ${name} ${type}`);
      db.exec(`UPDATE work_items SET stage = CASE state
                 WHEN 'open' THEN 'not_started' WHEN 'in_progress' THEN 'researching' WHEN 'waiting' THEN 'waiting'
                 WHEN 'resolved' THEN 'resolved' WHEN 'not_applicable' THEN 'not_applicable' ELSE 'not_started' END
               WHERE stage IS NULL`);
      db.exec('CREATE INDEX IF NOT EXISTS idx_work_items_stage ON work_items(unit_id, stage)');

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
      if (!users.has('demo_workspace_id')) db.exec('ALTER TABLE users ADD COLUMN demo_workspace_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_users_demo_workspace ON users(demo_workspace_id) WHERE demo_workspace_id IS NOT NULL');
    },
  },
  {
    id: 9,
    name: '009_mailbox_authorization',
    run: (db) => {
      const existing = new Set((db.prepare('PRAGMA table_info(connectors)').all() as Array<{ name: string }>).map((c) => c.name));
      const columns: Array<[string, string]> = [
        ['access_token_enc', 'TEXT'], ['refresh_token_enc', 'TEXT'], ['token_expires_at', 'TEXT'],
        ['account_id', 'TEXT'], ['account_address', 'TEXT'], ['tenant_id', 'TEXT'], ['authorized_at', 'TEXT'],
      ];
      for (const [name, type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE connectors ADD COLUMN ${name} ${type}`);
    },
  },
  {
    id: 10,
    name: '010_totp_replay',
    run: (db) => {
      const existing = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      if (!existing.has('totp_pending')) db.exec('ALTER TABLE users ADD COLUMN totp_pending TEXT');
      if (!existing.has('totp_last_step')) db.exec('ALTER TABLE users ADD COLUMN totp_last_step INTEGER');
    },
  },
  {
    id: 11,
    name: '011_marforres_primary_membership',
    run: (db) => {
      const command = db.prepare(`
        SELECT id, owner_user_id
          FROM units
         WHERE active = 1
           AND parent_id IS NULL
           AND (
             lower(COALESCE(short_name, '')) = 'marforres'
             OR lower(COALESCE(code, '')) = 'marforres'
             OR lower(name) = 'marine forces reserve'
           )
         ORDER BY CASE WHEN lower(COALESCE(short_name, '')) = 'marforres' THEN 0 ELSE 1 END, created_at
         LIMIT 1
      `).get() as { id: string; owner_user_id: string | null } | undefined;
      if (!command) return;

      const at = new Date().toISOString();
      const defaultRole = db.prepare('SELECT id FROM roles WHERE unit_id = ? AND is_default = 1 LIMIT 1').get(command.id) as { id: string } | undefined;
      const people = db.prepare('SELECT id FROM users WHERE active = 1').all() as Array<{ id: string }>;

      for (const person of people) {
        const hasMembership = db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? LIMIT 1').get(person.id);
        if (!hasMembership) continue;

        db.prepare(`
          INSERT INTO unit_members (user_id, unit_id, is_primary, billet, joined_at, invited_by)
          VALUES (?, ?, 0, NULL, ?, ?)
          ON CONFLICT(user_id, unit_id) DO NOTHING
        `).run(person.id, command.id, at, command.owner_user_id);

        db.prepare('UPDATE unit_members SET is_primary = CASE WHEN unit_id = ? THEN 1 ELSE 0 END WHERE user_id = ?')
          .run(command.id, person.id);

        if (defaultRole) {
          db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)')
            .run(person.id, defaultRole.id, command.id, command.owner_user_id, at);
        }
      }
    },
  },
  // The email_queue table comes from schema.sql, which is safe to replay.
  { id: 12, name: '012_email_queue', run: () => {} },
];
export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.id;

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
