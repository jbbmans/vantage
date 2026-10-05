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
  {
    id: 13,
    name: '013_lockout_and_timezone',
    run: (db) => {
      // Failed sign-ins are counted in the database, so a lockout outlasts a restart and holds across processes.
      // A person's own timezone decides their "today" and what is overdue for them.
      const existing = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      const columns: Array<[string, string]> = [['failed_sign_ins', 'INTEGER NOT NULL DEFAULT 0'], ['locked_until', 'TEXT'], ['timezone', 'TEXT']];
      for (const [name, type] of columns) if (!existing.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
    },
  },
  {
    id: 14,
    name: '014_organization_sign_in',
    run: (db) => {
      // The identity an account is linked to at the organization's provider: issuer and subject, never reassigned.
      const existing = new Set((db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name));
      for (const name of ['oidc_issuer', 'oidc_subject']) if (!existing.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} TEXT`);
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_oidc ON users(oidc_issuer, oidc_subject) WHERE oidc_subject IS NOT NULL');
    },
  },
  {
    id: 15,
    name: '015_organizations',
    run: migrateToOrganizations,
  },
];
export const SCHEMA_VERSION = MIGRATIONS.at(-1)!.id;

const columnsOf = (db: Db, table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));

/**
 * One central service, organizations as tenants (ADR-0006). Adds before it changes anything:
 * - every top-level unit founds an organization, and every unit beneath it carries that organization;
 * - former Instance Operators become platform owners; each organization's owners are its root unit's leader,
 *   or the former operators where it had none;
 * - the roster feed, retention schedules, holds and their runs become the first organization's.
 * Audit entries are not rewritten: their hashes stay valid, and an organization's view derives older entries' org from
 * their unit.
 */
function migrateToOrganizations(db: Db) {
  const at = new Date().toISOString();
  const add = (table: string, column: string, type: string) => { if (!columnsOf(db, table).has(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); };
  add('units', 'org_id', 'TEXT');
  add('member_roles', 'expires_at', 'TEXT');
  add('audit_log', 'org_id', 'TEXT');
  add('legal_holds', 'org_id', 'TEXT');
  add('disposition_runs', 'org_id', 'TEXT');
  add('personnel_sync_runs', 'org_id', 'TEXT');

  const { roots, operators } = foundOrganizations(db, at);
  db.exec('CREATE INDEX IF NOT EXISTS idx_units_org ON units(org_id)');

  // The instance's governance data becomes the first organization's.
  const first = [...roots.values()].filter((r) => r.active).sort((a, b) => a.created_at.localeCompare(b.created_at))[0]?.id ?? [...roots.keys()][0] ?? null;
  if (!columnsOf(db, 'personnel_roster').has('org_id')) {
    db.exec(`CREATE TABLE personnel_roster_v2 (
      org_id TEXT NOT NULL, edipi TEXT NOT NULL, last_name TEXT NOT NULL, first_name TEXT NOT NULL, middle_initial TEXT, rank_id TEXT, mos TEXT, eas TEXT,
      unit_code TEXT, billet TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'separated')), source TEXT NOT NULL, row_hash TEXT NOT NULL,
      synced_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, removed_units TEXT, PRIMARY KEY (org_id, edipi))`);
    if (first) db.prepare(`INSERT INTO personnel_roster_v2 (org_id, edipi, last_name, first_name, middle_initial, rank_id, mos, eas, unit_code, billet, status, source, row_hash, synced_at, created_at, updated_at)
                           SELECT ?, edipi, last_name, first_name, middle_initial, rank_id, mos, eas, unit_code, billet, status, source, row_hash, synced_at, created_at, updated_at FROM personnel_roster`).run(first);
    db.exec('DROP TABLE personnel_roster');
    db.exec('ALTER TABLE personnel_roster_v2 RENAME TO personnel_roster');
    db.exec('CREATE INDEX IF NOT EXISTS idx_roster_status ON personnel_roster(status, unit_code)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_roster_name ON personnel_roster(last_name, first_name)');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_roster_edipi ON personnel_roster(edipi)');
  if (!columnsOf(db, 'retention_schedules').has('org_id')) {
    db.exec(`CREATE TABLE retention_schedules_v2 (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, record_type TEXT NOT NULL, retain_days INTEGER NOT NULL CHECK (retain_days > 0),
      disposition TEXT NOT NULL CHECK (disposition IN ('destroy', 'anonymize', 'review')), authority TEXT, notes TEXT,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (org_id, record_type))`);
    if (first) db.prepare(`INSERT INTO retention_schedules_v2 (id, org_id, record_type, retain_days, disposition, authority, notes, enabled, created_at, updated_at)
                           SELECT id, ?, record_type, retain_days, disposition, authority, notes, enabled, created_at, updated_at FROM retention_schedules`).run(first);
    db.exec('DROP TABLE retention_schedules');
    db.exec('ALTER TABLE retention_schedules_v2 RENAME TO retention_schedules');
  }
  if (first) {
    for (const table of ['legal_holds', 'disposition_runs', 'personnel_sync_runs']) db.prepare(`UPDATE ${table} SET org_id = ? WHERE org_id IS NULL`).run(first);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_holds_org ON legal_holds(org_id, released_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_log(org_id, seq DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_member_roles_expiry ON member_roles(expires_at) WHERE expires_at IS NOT NULL');
  db.prepare("INSERT INTO meta (key, value) VALUES ('org_migration', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ at, organizations: roots.size, platformOwners: operators.length, governanceTo: first }));
}

/**
 * Every unit without an organization joins the one at the top of its tree, which is founded if it does not exist; the
 * triggers keep it so from then on. Former operators become platform owners, and each new organization's owner is its
 * top unit's leader (the former operators where it had none). Safe to run again: it only fills what is missing. The
 * migration runs it once; importing an archive from before organizations runs it on what the archive brought.
 */
export function foundOrganizations(db: Db, at = new Date().toISOString()) {
  // Organizations from the top of each unit tree. A unit whose parent is gone is the top of its own tree.
  const units = db.prepare('SELECT id, code, name, short_name, parent_id, owner_user_id, active, created_at FROM units').all() as Array<{ id: string; code: string; name: string; short_name: string | null; parent_id: string | null; owner_user_id: string | null; active: number; created_at: string }>;
  const byId = new Map(units.map((u) => [u.id, u]));
  const rootOf = (id: string) => {
    let current = byId.get(id)!;
    const seen = new Set<string>();
    while (current.parent_id && byId.has(current.parent_id) && !seen.has(current.parent_id)) { seen.add(current.id); current = byId.get(current.parent_id)!; }
    return current;
  };
  const insertOrg = db.prepare(`INSERT OR IGNORE INTO organizations (id, slug, name, short_name, status, root_unit_id, settings, created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?)`);
  const setOrg = db.prepare('UPDATE units SET org_id = ? WHERE id = ? AND org_id IS NULL');
  const roots = new Map<string, (typeof units)[number]>();
  for (const u of units) {
    const root = rootOf(u.id);
    roots.set(root.id, root);
    setOrg.run(root.id, u.id);
  }
  for (const root of roots.values()) insertOrg.run(root.id, root.code, root.name, root.short_name, root.active ? 'active' : 'archived', root.id, root.created_at, at);

  // Every unit belongs to an organization from now on: beneath a parent, the parent's; at the top, one it founds.
  db.exec(`CREATE TRIGGER IF NOT EXISTS units_inherit_org AFTER INSERT ON units FOR EACH ROW WHEN NEW.org_id IS NULL AND NEW.parent_id IS NOT NULL
    BEGIN UPDATE units SET org_id = (SELECT org_id FROM units WHERE id = NEW.parent_id) WHERE id = NEW.id; END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS units_found_org AFTER INSERT ON units FOR EACH ROW WHEN NEW.org_id IS NULL AND NEW.parent_id IS NULL
    BEGIN
      INSERT OR IGNORE INTO organizations (id, slug, name, short_name, status, root_unit_id, settings, created_at, updated_at)
        VALUES (NEW.id, NEW.code, NEW.name, NEW.short_name, 'active', NEW.id, '{}', NEW.created_at, NEW.created_at);
      UPDATE units SET org_id = NEW.id WHERE id = NEW.id;
    END`);
  // A unit never changes organization by being moved: a parent in another organization is refused here as well as in code.
  db.exec(`CREATE TRIGGER IF NOT EXISTS units_stay_in_org BEFORE UPDATE OF parent_id ON units FOR EACH ROW
    WHEN NEW.parent_id IS NOT NULL AND NEW.org_id IS NOT NULL AND (SELECT org_id FROM units WHERE id = NEW.parent_id) IS NOT NEW.org_id
    BEGIN SELECT RAISE(ABORT, 'a unit cannot move into another organization'); END`);

  // Former operators run the platform now; organizations get owners of their own.
  const operators = columnsOf(db, 'users').has('is_operator')
    ? (db.prepare('SELECT id FROM users WHERE is_operator = 1').all() as Array<{ id: string }>).map((r) => r.id)
    : [];
  const platform = db.prepare("INSERT OR IGNORE INTO platform_roles (user_id, role, granted_by, created_at) VALUES (?, 'owner', NULL, ?)");
  for (const id of operators) platform.run(id, at);
  const owner = db.prepare("INSERT OR IGNORE INTO org_roles (org_id, user_id, role, granted_by, created_at) VALUES (?, ?, 'owner', NULL, ?)");
  // Only an organization with no owner gets them here: one that has owners keeps the ones it has.
  const hasOwner = db.prepare("SELECT 1 FROM org_roles WHERE org_id = ? AND role = 'owner'");
  for (const root of roots.values()) {
    if (hasOwner.get(root.id)) continue;
    const owners = root.owner_user_id ? [root.owner_user_id] : operators;
    for (const id of owners) owner.run(root.id, id, at);
  }

  return { roots, operators };
}

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
  // Sorts and scratch tables in memory, and a larger page cache: faster, and no change to what is durable.
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -32000');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  // Refresh the planner's statistics where they have gone stale; SQLite's advice for a long-lived connection.
  db.pragma('optimize = 0x10002');
  cacheStatements(db);
  return db;
}

/**
 * Compiling SQL was the largest single cost of a request: the code prepares its statements where it uses
 * them, so the same text was compiled again on every call. The connection now keeps what it compiled and
 * hands the same statement back. Nothing puts a statement into a special mode (pluck, raw, expand) or holds
 * one open while iterating, so a shared statement always behaves like a fresh one. Bounded, because a few
 * statements are built with a variable number of placeholders.
 */
function cacheStatements(db: Db, limit = 1000) {
  const compile = db.prepare.bind(db);
  const cache = new Map<string, Database.Statement>();
  db.prepare = ((sql: string) => {
    let statement = cache.get(sql);
    if (statement) { cache.delete(sql); cache.set(sql, statement); return statement; }
    statement = compile(sql);
    cache.set(sql, statement);
    if (cache.size > limit) cache.delete(cache.keys().next().value!);
    return statement;
  }) as Db['prepare'];
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
