/**
 * Vantage — database.
 *
 * SQLite, single file, WAL mode. This holds personnel records, so the schema is
 * built around three ideas:
 *
 *   1. Every record has an owner and a unit. Visibility is derived from those
 *      two columns and nothing else, so there's exactly one place to audit.
 *   2. Nothing is hard-deleted. Performance records that vanish without trace
 *      are the failure mode that gets a system thrown out.
 *   3. Every read of someone else's data writes an audit row. If a Marine asks
 *      who looked at their record, that question has an answer.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { RANKS, BILLETS, flattenUnits } from './usmc.js';
import { SYSTEM_ROLES, PERMISSIONS } from './roles.js';
import { hashPassword } from './auth.js';

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ranks (
  id          TEXT PRIMARY KEY,
  grade       TEXT NOT NULL,
  abbr        TEXT NOT NULL,
  name        TEXT NOT NULL,
  tier        TEXT NOT NULL,
  sort        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS billets (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL UNIQUE,
  category      TEXT NOT NULL,
  echelon       TEXT,
  default_role  TEXT NOT NULL DEFAULT 'member',
  active        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS units (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  short_name  TEXT,
  echelon     TEXT NOT NULL,
  location    TEXT,
  parent_id   TEXT REFERENCES units(id),
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_parent ON units(parent_id);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  last_name      TEXT NOT NULL,
  first_name     TEXT NOT NULL,
  middle_initial TEXT,
  rank_id        TEXT REFERENCES ranks(id),
  mos            TEXT,
  email          TEXT,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  eas            TEXT,
  -- Readiness, for the JEPES advisor. All optional; the advisor reports what
  -- it cannot see rather than guessing.
  pft_score      INTEGER,
  cft_score      INTEGER,
  rifle_score    INTEGER,
  rifle_qual     TEXT,
  mcmap_belt     TEXT,
  ceus           REAL,
  college_credits REAL,
  degree         TEXT,
  pme_complete   TEXT,
  cmd_character  REAL,
  cmd_mos        REAL,
  cmd_leadership REAL,
  prefs          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Roles are rows, permissions are bits, and a Marine can hold several.
-- unit_id scopes the role: NULL means it applies org-wide.
CREATE TABLE IF NOT EXISTS roles (
  id            TEXT PRIMARY KEY,
  unit_id       TEXT REFERENCES units(id),
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  permissions   INTEGER NOT NULL DEFAULT 0,
  inherits_down INTEGER NOT NULL DEFAULT 0,
  is_default    INTEGER NOT NULL DEFAULT 0,
  is_system     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_unit ON roles(unit_id);

CREATE TABLE IF NOT EXISTS member_roles (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  role_id    TEXT NOT NULL REFERENCES roles(id),
  unit_id    TEXT NOT NULL REFERENCES units(id),
  granted_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, role_id, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_member_roles_user ON member_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_member_roles_unit ON member_roles(unit_id);

-- A Marine can hold more than one assignment: primary billet plus collateral
-- duties that carry their own scope (Class Leader, Color Guard NCO, and so on).
CREATE TABLE IF NOT EXISTS assignments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  unit_id     TEXT NOT NULL REFERENCES units(id),
  billet_id   TEXT REFERENCES billets(id),
  role        TEXT NOT NULL DEFAULT '',  -- retired (finding 9): billets recommend, role grants authorize
  is_primary  INTEGER NOT NULL DEFAULT 0,
  start_date  TEXT,
  end_date    TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assign_user ON assignments(user_id);
CREATE INDEX IF NOT EXISTS idx_assign_unit ON assignments(unit_id);

CREATE TABLE IF NOT EXISTS activities (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  unit_id        TEXT REFERENCES units(id),
  date           TEXT,
  title          TEXT NOT NULL,
  category       TEXT,
  jepes_area     TEXT,
  quantity       REAL,
  unit_label     TEXT,
  dollar_amount  REAL,
  dollar_type    TEXT,
  result         TEXT,
  organization   TEXT,
  system         TEXT,
  project_id     TEXT,
  status         TEXT DEFAULT 'completed',
  notes          TEXT,
  evidence_links TEXT,
  visibility     TEXT NOT NULL DEFAULT 'chain',
  fingerprint    TEXT,
  version        INTEGER NOT NULL DEFAULT 1,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_user ON activities(user_id);
-- The duplicate-protection index on activities.fingerprint is created by
-- migration 003, never here: on a legacy database this block runs before the
-- column exists.
CREATE INDEX IF NOT EXISTS idx_act_unit ON activities(unit_id);
CREATE INDEX IF NOT EXISTS idx_act_date ON activities(date);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  unit_id       TEXT REFERENCES units(id),
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT DEFAULT 'active',
  priority      TEXT DEFAULT 'medium',
  progress      REAL DEFAULT 0,
  start_date    TEXT,
  target_date   TEXT,
  organization  TEXT,
  visibility    TEXT NOT NULL DEFAULT 'private',
  version        INTEGER NOT NULL DEFAULT 1,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  assignee_id  TEXT REFERENCES users(id),
  unit_id      TEXT REFERENCES units(id),
  project_id   TEXT REFERENCES projects(id),
  title        TEXT NOT NULL,
  notes        TEXT,
  status       TEXT DEFAULT 'planned',
  priority     TEXT DEFAULT 'medium',
  due_date     TEXT,
  visibility   TEXT NOT NULL DEFAULT 'private',
  version        INTEGER NOT NULL DEFAULT 1,
  deleted_at   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_assignee ON tasks(assignee_id);

CREATE TABLE IF NOT EXISTS goals (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  assignee_id    TEXT REFERENCES users(id),
  unit_id        TEXT REFERENCES units(id),
  title          TEXT NOT NULL,
  description    TEXT,
  type           TEXT DEFAULT 'quarterly',
  category       TEXT,
  current_value  REAL DEFAULT 0,
  target_value   REAL,
  unit_label     TEXT,
  status         TEXT DEFAULT 'active',
  period_start   TEXT,
  period_end     TEXT,
  visibility     TEXT NOT NULL DEFAULT 'private',
  version        INTEGER NOT NULL DEFAULT 1,
  deleted_at     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recognitions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  unit_id       TEXT REFERENCES units(id),
  date          TEXT,
  title         TEXT NOT NULL,
  type          TEXT,
  from_whom     TEXT,
  organization  TEXT,
  notes         TEXT,
  visibility    TEXT NOT NULL DEFAULT 'chain',
  version        INTEGER NOT NULL DEFAULT 1,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trainings (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  unit_id     TEXT REFERENCES units(id),
  date        TEXT,
  title       TEXT NOT NULL,
  type        TEXT,
  hours       REAL,
  provider    TEXT,
  status      TEXT DEFAULT 'completed',
  notes       TEXT,
  visibility  TEXT NOT NULL DEFAULT 'chain',
  version        INTEGER NOT NULL DEFAULT 1,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Who looked at whose record, and when. unit_id scopes the event so a leader
-- with VIEW_AUDIT reads their unit's log and nothing beyond it.
CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  actor_id    TEXT NOT NULL REFERENCES users(id),
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  subject_id  TEXT REFERENCES users(id),
  unit_id     TEXT,
  detail      TEXT,
  at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_subject ON audit_log(subject_id);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
-- idx_audit_unit is created by migration 004 (same legacy-ordering reason).

-- Sessions carry both deadlines: expires_at rolls with activity (inactivity
-- timeout), absolute_expires_at never moves. Either one passing ends it.
CREATE TABLE IF NOT EXISTS sessions (
  token               TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL REFERENCES users(id),
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL DEFAULT '9999-12-31T00:00:00.000Z',
  last_used_at        TEXT,
  ip                  TEXT,
  user_agent          TEXT
);

-- One row per key. Holds schema_version and seed_version so migrations and
-- reference-data seeding are recorded acts, not boot-time guesswork.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db;

export function getDb(file = process.env.VANTAGE_DB || 'vantage.db') {
  if (db) return db;
  db = new Database(file);
  db.exec(SCHEMA);
  migrate();
  seedReference();
  return db;
}

/**
 * Numbered, recorded migrations (finding 29).
 *
 * CREATE TABLE IF NOT EXISTS only helps on a fresh file: a database created by
 * an earlier version keeps its old shape. v3.2's answer was "diff the columns
 * on every boot", which works until two changes need an order, or one needs
 * data movement. Each migration below runs at most once, inside a transaction,
 * and is recorded in `meta.schema_version` — so "what shape is this database
 * in" has a one-word answer.
 *
 * Rules for adding one: additive, deterministic, idempotent (each is written
 * so re-running it is harmless anyway), and never destructive — a migration
 * that drops or rewrites columns on boot is how a bad deploy eats a section's
 * records.
 */
const addColumn = (table, name, type) => {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
};

const MIGRATIONS = [
  {
    id: 1,
    name: '001_readiness_and_prefs',
    run() {
      for (const [name, type] of Object.entries({
        pft_score: 'INTEGER', cft_score: 'INTEGER', rifle_score: 'INTEGER',
        rifle_qual: 'TEXT', mcmap_belt: 'TEXT', ceus: 'REAL',
        college_credits: 'REAL', degree: 'TEXT', pme_complete: 'TEXT',
        cmd_character: 'REAL', cmd_mos: 'REAL', cmd_leadership: 'REAL',
        prefs: 'TEXT',
      })) addColumn('users', name, type);
    },
  },
  {
    id: 2,
    name: '002_session_lifecycle',
    run() {
      addColumn('sessions', 'absolute_expires_at', "TEXT NOT NULL DEFAULT '9999-12-31T00:00:00.000Z'");
      addColumn('sessions', 'last_used_at', 'TEXT');
      addColumn('sessions', 'ip', 'TEXT');
      addColumn('sessions', 'user_agent', 'TEXT');
      // Sessions issued under the 12-day model predate the inactivity/absolute
      // policy; ending them is the point of the change.
      db.prepare("DELETE FROM sessions WHERE absolute_expires_at = '9999-12-31T00:00:00.000Z'").run();
    },
  },
  {
    id: 3,
    name: '003_record_versions_and_fingerprints',
    run() {
      for (const table of ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings']) {
        addColumn(table, 'version', 'INTEGER NOT NULL DEFAULT 1');
      }
      addColumn('activities', 'fingerprint', 'TEXT');
      // Existing rows keep a NULL fingerprint — the partial index ignores them,
      // so history is untouched and only new writes are deduplicated.
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_act_fingerprint
                 ON activities(fingerprint) WHERE fingerprint IS NOT NULL AND deleted_at IS NULL`);
    },
  },
  {
    id: 4,
    name: '004_audit_unit_scope',
    run() {
      addColumn('audit_log', 'unit_id', 'TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_audit_unit ON audit_log(unit_id)');
    },
  },
  {
    id: 5,
    name: '005_retire_assignment_role',
    run() {
      // Finding 9, Option A. assignments.role never fed authorization — the
      // permission calculation reads member_roles only — but a value sitting
      // here *looked* authoritative, which is exactly the class of lie v3.3
      // exists to kill. This blanks the retired label. It rewrites decorative
      // metadata, not records: units, billets, grants and history all stand.
      db.prepare("UPDATE assignments SET role = ''").run();
    },
  },
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const current = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0);
  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;
    db.transaction(() => {
      m.run();
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(String(m.id));
    })();
  }
}

export const schemaVersion = () =>
  Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0);

const now = () => new Date().toISOString();
export const newId = () => randomUUID();

/**
 * Reference data seeding (finding 30).
 *
 * Two kinds of data were being conflated:
 *
 *   System reference — ranks, system roles. Code-authoritative. The Marine
 *   Corps decides what a Corporal is, not an administrator; these upsert.
 *
 *   Command-configured — units and billets. Vantage ships a starting tree,
 *   but the moment an administrator renames a unit or retitles a billet,
 *   that edit is the truth. v3.2 re-upserted names and echelons on every
 *   boot, silently fighting the administrator; now units and billets are
 *   INSERT-only after the first seed. New reference rows added in later
 *   versions still arrive (the insert is per-row), existing rows are never
 *   touched.
 *
 * `meta.seed_version` records which seed set has been applied, so a future
 * change to the shipped tree is an explicit, versioned event rather than a
 * side effect of booting.
 */
const SEED_VERSION = 1;

function seedReference() {
  const insertRank = db.prepare(
    `INSERT INTO ranks (id, grade, abbr, name, tier, sort) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET grade=excluded.grade, name=excluded.name, tier=excluded.tier, sort=excluded.sort`
  );
  db.transaction(() => {
    for (const r of RANKS) insertRank.run(r.abbr, r.grade, r.abbr, r.name, r.tier, r.sort);
  })();

  const insertRole = db.prepare(
    `INSERT INTO roles (id, unit_id, name, description, color, position, permissions, inherits_down, is_default, is_system, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, description=excluded.description, color=excluded.color,
       position=excluded.position, permissions=excluded.permissions, inherits_down=excluded.inherits_down`
  );
  db.transaction(() => {
    for (const r of SYSTEM_ROLES) {
      insertRole.run(r.id, r.name, r.description, r.color, r.position, r.permissions, r.inherits_down, r.is_default, now());
    }
  })();

  // Command-configured structure: never overwrite, only add what's missing.
  const insertBillet = db.prepare(
    `INSERT INTO billets (id, title, category, echelon, default_role) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(title) DO NOTHING`
  );
  db.transaction(() => {
    for (const b of BILLETS) {
      insertBillet.run(slug(b.title), b.title, b.category, b.echelon, b.default_role);
    }
  })();

  const rows = flattenUnits();
  const insertUnit = db.prepare(
    `INSERT INTO units (id, code, name, short_name, echelon, location, parent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(code) DO NOTHING`
  );
  db.transaction(() => {
    for (const u of rows) {
      insertUnit.run(u.code, u.code, u.name, u.short_name || null, u.echelon, u.location || null, u.parent_code, now());
    }
  })();

  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('seed_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(SEED_VERSION));
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * First-run bootstrap. Creates the initial administrator so there's a way in.
 * Returns null when users already exist — this never resets an existing install.
 */
export function bootstrapAdmin({ username, password, first_name, last_name, rank_id, mos, unit_code, billet_title }) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return null;

  const id = newId();
  db.prepare(
    `INSERT INTO users (id, username, password_hash, last_name, first_name, rank_id, mos, is_admin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(id, username, hashPassword(password), last_name, first_name, rank_id || null, mos || null, now(), now());

  const unit = db.prepare('SELECT id FROM units WHERE code = ?').get(unit_code || 'CE-G8');
  const billet = billet_title ? db.prepare('SELECT id FROM billets WHERE title = ?').get(billet_title) : null;
  if (unit) {
    db.prepare(
      `INSERT INTO assignments (id, user_id, unit_id, billet_id, role, is_primary, start_date, created_at)
       VALUES (?, ?, ?, ?, '', 1, ?, ?)`
    ).run(newId(), id, unit.id, billet?.id || null, now().slice(0, 10), now());
    grantRole(id, 'administrator', unit.id, id);
  }
  return { id, username };
}

/** Give a Marine a role inside a unit. Idempotent. */
export function grantRole(userId, roleId, unitId, grantedBy = null) {
  db.prepare(
    `INSERT INTO member_roles (id, user_id, role_id, unit_id, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, role_id, unit_id) DO NOTHING`
  ).run(newId(), userId, roleId, unitId, grantedBy, now());
}

export function revokeRole(userId, roleId, unitId) {
  db.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ? AND unit_id = ?').run(userId, roleId, unitId);
}

export function audit({ actor_id, action, entity, entity_id, subject_id, unit_id, detail }) {
  db.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, subject_id, unit_id, detail, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), actor_id, action, entity || null, entity_id || null, subject_id || null, unit_id || null, detail || null, now());
}

export { now };
