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
import { ROLE_TEMPLATES, DEFAULT_TEMPLATE_ID, templateById, PERMISSIONS } from './roles.js';
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

-- A unit is a sovereign boundary (v3.4 Decision 1). parent_id and level are
-- DESCRIPTIVE ONLY: they say how a human should read the org chart and convey
-- no permission, no visibility and no reach. Authorization never reads either.
--
-- owner_user_id is the Unit Owner (finding 4). It lives here rather than in a
-- role so that a role edit cannot revoke it and deactivating the last
-- admin-role holder cannot orphan the unit.
CREATE TABLE IF NOT EXISTS units (
  id            TEXT PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  short_name    TEXT,
  echelon       TEXT NOT NULL,
  location      TEXT,
  parent_id     TEXT REFERENCES units(id),
  level         TEXT,
  data_mode     TEXT NOT NULL DEFAULT 'full',
  owner_user_id TEXT REFERENCES users(id),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_units_parent ON units(parent_id);
-- idx_units_owner is created by migration 006, never here: on a legacy database
-- this block runs before owner_user_id exists. Same reason as
-- idx_act_fingerprint and idx_audit_unit below.

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
--
-- unit_id is NOT NULL (finding 1). There is no such thing as a global role
-- definition: two SNCOICs at two commands must be able to have a "Training NCO"
-- that means different things, and under v3.3's nullable unit_id editing one
-- edited both. Roles arrive by COPYING a template (roles.js ROLE_TEMPLATES)
-- into a unit at creation; the copies diverge immediately and permanently.
--
-- is_system means only "this row came from a template". It confers no edit
-- protection: the owning unit may rename, re-colour, re-permission or delete
-- any of its own roles.
--
-- inherits_down is GONE (finding 2). A role grants inside the unit it was
-- granted in, full stop. position ordering is per-unit: position 30 in Unit A
-- has no relationship to position 30 in Unit B.
CREATE TABLE IF NOT EXISTS roles (
  id            TEXT PRIMARY KEY,
  unit_id       TEXT NOT NULL REFERENCES units(id),
  template_key  TEXT,
  name          TEXT NOT NULL,
  description   TEXT,
  color         TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  permissions   INTEGER NOT NULL DEFAULT 0,
  is_default    INTEGER NOT NULL DEFAULT 0,
  is_system     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_roles_unit ON roles(unit_id);

-- Stated membership (finding 8). v3.3 inferred "is this person in this unit"
-- from a date-range join on assignments, which made membership, billet and
-- history the same row: a member holding no billet, a guest from another unit,
-- and an ended assignment that should still read as history were all
-- inexpressible. assignments keeps billet, dates and history; it stops
-- answering membership questions.
--
-- kind: owner | member | guest. expires_at is for guests (finding 9) and fails
-- closed the moment it passes, with no cleanup job in between.
CREATE TABLE IF NOT EXISTS unit_members (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  unit_id    TEXT NOT NULL REFERENCES units(id),
  kind       TEXT NOT NULL DEFAULT 'member',
  joined_at  TEXT NOT NULL,
  expires_at TEXT,
  invited_by TEXT REFERENCES users(id),
  UNIQUE(user_id, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_unit_members_user ON unit_members(user_id);
CREATE INDEX IF NOT EXISTS idx_unit_members_unit ON unit_members(unit_id);

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
  visibility     TEXT NOT NULL DEFAULT 'unit',
  fingerprint    TEXT,
  frozen_at      TEXT,
  frozen_reason  TEXT,
  derived_from_record_id TEXT,
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
  frozen_at      TEXT,
  frozen_reason  TEXT,
  derived_from_record_id TEXT,
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
  frozen_at      TEXT,
  frozen_reason  TEXT,
  derived_from_record_id TEXT,
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
  frozen_at      TEXT,
  frozen_reason  TEXT,
  derived_from_record_id TEXT,
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
  visibility    TEXT NOT NULL DEFAULT 'unit',
  version        INTEGER NOT NULL DEFAULT 1,
  frozen_at     TEXT,
  frozen_reason TEXT,
  derived_from_record_id TEXT,
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
  visibility  TEXT NOT NULL DEFAULT 'unit',
  version        INTEGER NOT NULL DEFAULT 1,
  frozen_at   TEXT,
  frozen_reason TEXT,
  derived_from_record_id TEXT,
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
  {
    id: 6,
    name: '006_tenancy',
    // Step 4 drops and replaces `roles` while `member_roles.role_id` still
    // references it. SQLite's documented procedure for altering a referenced
    // table is to disable enforcement for the rebuild and then verify with
    // PRAGMA foreign_key_check before committing — which migrate() does. The
    // constraint is verified, not skipped.
    foreignKeysOff: true,
    /**
     * The v3.4 tenancy migration. This is the load-bearing one, and it is the
     * only migration in Vantage's history that deliberately does NOT preserve
     * a permission that existed before it ran. That exception is documented at
     * length below because it is a security change, not a bug.
     *
     * Five things happen, in order:
     *
     *   1. New columns: units.level, units.data_mode, units.owner_user_id, and
     *      freeze/lineage columns on every record table.
     *   2. unit_members is backfilled from live assignments, so every Marine
     *      who was in a unit stays in it.
     *   3. Cascading grants are MATERIALISED. In v3.3 a grant of a role with
     *      inherits_down at unit U silently conferred its bits across
     *      subtree(U). v3.4 has no such expansion, so to preserve the
     *      permission the migration writes the explicit grants v3.3 was
     *      computing at read time. This is the "preserves every effective
     *      permission" requirement, and it is done BEFORE the roles table is
     *      rebuilt so inherits_down is still readable.
     *   4. Global roles are forked. For every unit that holds a grant against
     *      a unit_id IS NULL role, a unit-local copy is created and
     *      member_roles is repointed at it. No role with live grants is ever
     *      deleted; global rows with no grants are dropped because nothing
     *      references them.
     *   5. units.owner_user_id is set, so no unit comes out of the migration
     *      orphaned if v3.3 had anyone who could reach it.
     *
     * THE EXCEPTION. v3.3's `permissionMap` fanned an ADMINISTRATOR grant — and
     * legacy `users.is_admin` — across every unit in the database. Carrying
     * that forward literally would mean writing an administrator grant into all
     * 34 units of a typical install, which is precisely the cross-tenant
     * superuser finding 4 exists to delete: preserving it IS the leak. So the
     * migration converts it instead. An administrator becomes Unit Owner of
     * every unit they were actually a member of, keeps every unit-scoped bit
     * they held, and loses reach into units they were never in. What was
     * dropped is counted and written to meta.migration_006_report and to the
     * instance audit, so the change is a recorded act rather than a silent one.
     * Operators who genuinely need instance-wide reach are named in
     * VANTAGE_OPERATOR after the upgrade — see README, "Upgrading to v3.4".
     */
    run() {
      const report = { materialised_grants: 0, forked_roles: 0, repointed_grants: 0, memberships: 0, owners: 0, dropped_global_admin: [] };

      /* 1. columns */
      addColumn('units', 'level', 'TEXT');
      addColumn('units', 'data_mode', "TEXT NOT NULL DEFAULT 'full'");
      addColumn('units', 'owner_user_id', 'TEXT REFERENCES users(id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_units_owner ON units(owner_user_id)');
      for (const table of ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings']) {
        addColumn(table, 'frozen_at', 'TEXT');
        addColumn(table, 'frozen_reason', 'TEXT');
        addColumn(table, 'derived_from_record_id', 'TEXT');
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS unit_members (
          id         TEXT PRIMARY KEY,
          user_id    TEXT NOT NULL REFERENCES users(id),
          unit_id    TEXT NOT NULL REFERENCES units(id),
          kind       TEXT NOT NULL DEFAULT 'member',
          joined_at  TEXT NOT NULL,
          expires_at TEXT,
          invited_by TEXT REFERENCES users(id),
          UNIQUE(user_id, unit_id)
        );
        CREATE INDEX IF NOT EXISTS idx_unit_members_user ON unit_members(user_id);
        CREATE INDEX IF NOT EXISTS idx_unit_members_unit ON unit_members(unit_id);
      `);

      /* 2. membership from live assignments */
      const insertMember = db.prepare(
        `INSERT INTO unit_members (id, user_id, unit_id, kind, joined_at)
         VALUES (?, ?, ?, 'member', ?) ON CONFLICT(user_id, unit_id) DO NOTHING`
      );
      const live = db
        .prepare(
          `SELECT DISTINCT a.user_id, a.unit_id, MIN(a.start_date) AS since
             FROM assignments a JOIN units u ON u.id = a.unit_id
            WHERE u.active = 1 AND (a.end_date IS NULL OR a.end_date > date('now'))
            GROUP BY a.user_id, a.unit_id`
        )
        .all();
      for (const a of live) {
        const r = insertMember.run(newId(), a.user_id, a.unit_id, a.since || now());
        report.memberships += r.changes;
      }
      // A grant in a unit is itself evidence of belonging: v3.3 let a role be
      // granted where no assignment existed, and dropping those users would be
      // a silent loss of access.
      for (const g of db.prepare('SELECT DISTINCT user_id, unit_id FROM member_roles').all()) {
        if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(g.unit_id)) continue;
        const r = insertMember.run(newId(), g.user_id, g.unit_id, now());
        report.memberships += r.changes;
      }

      /* 3. materialise cascading grants while inherits_down still exists */
      const hasInherits = db.prepare('PRAGMA table_info(roles)').all().some((c) => c.name === 'inherits_down');
      if (hasInherits) {
        const units = db.prepare('SELECT id, parent_id FROM units WHERE active = 1').all();
        const byParent = new Map();
        for (const u of units) {
          if (!byParent.has(u.parent_id)) byParent.set(u.parent_id, []);
          byParent.get(u.parent_id).push(u.id);
        }
        const subtree = (root) => {
          const out = new Set();
          const queue = [root];
          while (queue.length) {
            const id = queue.shift();
            if (out.has(id)) continue;
            out.add(id);
            for (const c of byParent.get(id) || []) queue.push(c);
          }
          return [...out];
        };
        const insertGrant = db.prepare(
          `INSERT INTO member_roles (id, user_id, role_id, unit_id, granted_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, role_id, unit_id) DO NOTHING`
        );
        const cascading = db
          .prepare(
            `SELECT mr.user_id, mr.role_id, mr.unit_id, mr.granted_by
               FROM member_roles mr JOIN roles r ON r.id = mr.role_id
              WHERE r.inherits_down = 1`
          )
          .all();
        for (const g of cascading) {
          for (const unitId of subtree(g.unit_id)) {
            if (unitId === g.unit_id) continue;
            const r = insertGrant.run(newId(), g.user_id, g.role_id, unitId, g.granted_by, now());
            report.materialised_grants += r.changes;
            if (r.changes) insertMember.run(newId(), g.user_id, unitId, now());
          }
        }
      }

      /* 4. fork global role definitions into unit-local copies */
      const globals = db.prepare('SELECT * FROM roles WHERE unit_id IS NULL').all();
      const insertRole = db.prepare(
        `INSERT INTO roles (id, unit_id, name, description, color, position, permissions, is_default, is_system, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      // Rebuild first so the destination table has the v3.4 shape, then move
      // rows into it. SQLite cannot add NOT NULL to an existing column.
      const cols = db.prepare('PRAGMA table_info(roles)').all().map((c) => c.name);
      if (!cols.includes('template_key') || cols.includes('inherits_down')) {
        db.exec(`
          CREATE TABLE roles_v34 (
            id            TEXT PRIMARY KEY,
            unit_id       TEXT NOT NULL REFERENCES units(id),
            template_key  TEXT,
            name          TEXT NOT NULL,
            description   TEXT,
            color         TEXT,
            position      INTEGER NOT NULL DEFAULT 0,
            permissions   INTEGER NOT NULL DEFAULT 0,
            is_default    INTEGER NOT NULL DEFAULT 0,
            is_system     INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL
          );
        `);
        // Unit-scoped definitions carry across unchanged, minus inherits_down.
        db.exec(`
          INSERT INTO roles_v34 (id, unit_id, template_key, name, description, color, position, permissions, is_default, is_system, created_at)
          SELECT id, unit_id, NULL, name, description, color, position, permissions, is_default, is_system, created_at
            FROM roles WHERE unit_id IS NOT NULL
        `);
        // Global definitions fork per unit that actually holds a grant.
        const repoint = db.prepare('UPDATE member_roles SET role_id = ? WHERE role_id = ? AND unit_id = ?');
        const forkInto = db.prepare(
          `INSERT INTO roles_v34 (id, unit_id, template_key, name, description, color, position, permissions, is_default, is_system, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const role of globals) {
          const unitsWithGrant = db
            .prepare('SELECT DISTINCT unit_id FROM member_roles WHERE role_id = ?')
            .all(role.id)
            .map((r) => r.unit_id)
            .filter((id) => db.prepare('SELECT 1 FROM units WHERE id = ?').get(id));
          for (const unitId of unitsWithGrant) {
            const copyId = `${unitId}:${role.id}`.slice(0, 120);
            forkInto.run(
              copyId, unitId, role.id, role.name, role.description, role.color,
              role.position, role.permissions, role.is_default, 1, role.created_at || now()
            );
            const r = repoint.run(copyId, role.id, unitId);
            report.repointed_grants += r.changes;
            report.forked_roles += 1;
          }
        }
        db.exec('DROP TABLE roles');
        db.exec('ALTER TABLE roles_v34 RENAME TO roles');
        db.exec('CREATE INDEX IF NOT EXISTS idx_roles_unit ON roles(unit_id)');
      }

      /* 5. ownership, and the administrator conversion */
      const setOwner = db.prepare('UPDATE units SET owner_user_id = ? WHERE id = ? AND owner_user_id IS NULL');
      const ADMIN_BIT = 1 << 11;
      const adminUsers = db
        .prepare(
          `SELECT DISTINCT u.id, u.username FROM users u
             LEFT JOIN member_roles mr ON mr.user_id = u.id
             LEFT JOIN roles r ON r.id = mr.role_id
            WHERE u.active = 1 AND (u.is_admin = 1 OR (r.permissions & ${ADMIN_BIT}) <> 0)`
        )
        .all();
      const totalUnits = db.prepare('SELECT COUNT(*) AS n FROM units WHERE active = 1').get().n;
      for (const a of adminUsers) {
        const mine = db.prepare('SELECT unit_id FROM unit_members WHERE user_id = ?').all(a.id).map((r) => r.unit_id);
        for (const unitId of mine) report.owners += setOwner.run(a.id, unitId).changes;
        report.dropped_global_admin.push({ username: a.username, kept_units: mine.length, lost_units: totalUnits - mine.length });
      }
      /* Any unit still without an owner. Leaving it ownerless means nobody can
       * ever grant anything in it, so it is unreachable forever — but promoting
       * an arbitrary member would hand someone authority the migration
       * invented. The rule: promote only a person who was ALREADY
       * administering the unit, meaning they held MANAGE_ROLES and
       * MANAGE_MEMBERS there under v3.3. They gain exactly one bit,
       * ADMINISTRATOR, in a unit they already ran.
       *
       * A unit with no such person is deliberately left ownerless for the
       * Instance Operator to claim (finding 11). That is a recorded gap
       * someone acts on, not a silent promotion. */
      const RUNS_UNIT = PERMISSIONS.MANAGE_ROLES | PERMISSIONS.MANAGE_MEMBERS;
      report.promoted_owners = [];
      report.left_ownerless = [];
      for (const u of db.prepare('SELECT id FROM units WHERE active = 1 AND owner_user_id IS NULL').all()) {
        const candidates = db
          .prepare(
            `SELECT mr.user_id, us.username, r.position, r.permissions
               FROM member_roles mr
               JOIN roles r ON r.id = mr.role_id
               JOIN users us ON us.id = mr.user_id
              WHERE mr.unit_id = ? AND us.active = 1
              ORDER BY r.position DESC`
          )
          .all(u.id);

        const byUser = new Map();
        for (const c of candidates) {
          const prev = byUser.get(c.user_id) || { username: c.username, bits: 0, position: 0 };
          byUser.set(c.user_id, {
            username: c.username,
            bits: prev.bits | c.permissions,
            position: Math.max(prev.position, c.position),
          });
        }
        const eligible = [...byUser.entries()]
          .filter(([, v]) => (v.bits & RUNS_UNIT) === RUNS_UNIT)
          .sort((a, b) => b[1].position - a[1].position)[0];

        if (!eligible) {
          if (byUser.size) report.left_ownerless.push(u.id);
          continue;
        }
        const [userId, info] = eligible;
        report.owners += setOwner.run(userId, u.id).changes;
        report.promoted_owners.push({
          username: info.username, unit_id: u.id, before_bits: info.bits, gained: 'ADMINISTRATOR',
        });
      }

      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('migration_006_report', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(JSON.stringify(report));
    },
  },
  {
    id: 7,
    name: '007_retire_chain_visibility',
    /**
     * Finding 3. `chain` meant "the unit and everyone under it", it resolved
     * through both ancestor and subtree ids, and it was the DEFAULT on
     * activities, recognitions and trainings — so a Marine logging an activity
     * with the default setting published it up and down the org chart without
     * an affirmative act.
     *
     * Rewriting chain → unit is a visibility REDUCTION. It cannot leak; it can
     * only hide something that was previously visible to somebody outside the
     * owning unit, which is the entire point. Announced in the upgrade notes.
     */
    run() {
      const report = {};
      for (const table of ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings']) {
        const r = db.prepare(`UPDATE ${table} SET visibility = 'unit' WHERE visibility = 'chain'`).run();
        report[table] = r.changes;
      }
      // A row that says 'unit' but has no unit cannot be read by the unit
      // branch of the visibility clause and would be invisible-but-not-personal.
      // Personal scope (finding 6) is where an owner-only record belongs.
      for (const table of ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings']) {
        const r = db
          .prepare(`UPDATE ${table} SET visibility = 'personal' WHERE unit_id IS NULL AND visibility NOT IN ('private','personal')`)
          .run();
        report[`${table}_orphaned_to_personal`] = r.changes;
      }
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('migration_007_report', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(JSON.stringify(report));
    },
  },
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const current = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0);
  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;

    // A migration that replaces a table other tables reference cannot run with
    // enforcement on: dropping the parent fires an implicit delete that the
    // rename cannot un-fire. SQLite's answer is to disable enforcement for the
    // rebuild and verify afterwards, which is stronger than it sounds — the
    // check below examines EVERY row in the database, not just the ones the
    // migration touched, and refuses to record the migration if any dangle.
    // The pragma is a no-op inside a transaction, so it is set outside one.
    const rebuild = Boolean(m.foreignKeysOff);
    if (rebuild) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        m.run();
        if (rebuild) {
          const violations = db.pragma('foreign_key_check');
          if (violations.length) {
            throw new Error(
              `migration ${m.name} left ${violations.length} foreign key violation(s): `
              + JSON.stringify(violations.slice(0, 5))
            );
          }
        }
        db.prepare(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ).run(String(m.id));
      })();
    } finally {
      if (rebuild) db.pragma('foreign_keys = ON');
    }
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

  // Roles are NOT seeded (finding 1). There is no global role definition to
  // seed: a role belongs to exactly one unit and arrives by copying a template
  // (roles.js ROLE_TEMPLATES) into that unit when it is created or claimed.
  // Seeding here is what made every install share one editable role set.

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
export function bootstrapAdmin({ username, password, first_name, last_name, rank_id, mos, unit_code, billet_title, template_id }) {
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
    claimUnit(unit.id, id, template_id || DEFAULT_TEMPLATE_ID);
  }
  return { id, username };
}

/**
 * Copy a role template into a unit (finding 1).
 *
 * The copies are ordinary rows from the moment they land. `is_system` records
 * that they came from a template and nothing more — it does not protect them
 * from being renamed, re-permissioned or deleted by the unit that owns them.
 * Two units created from the same template diverge immediately and
 * permanently, which is the entire point.
 *
 * Idempotent: a unit that already has roles is left alone, so this can be
 * called on a path that may or may not have run before.
 */
export function copyTemplateInto(unitId, templateId = DEFAULT_TEMPLATE_ID) {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM roles WHERE unit_id = ?').get(unitId).n;
  if (existing) return db.prepare('SELECT * FROM roles WHERE unit_id = ? ORDER BY position DESC').all(unitId);

  const template = templateById(templateId);
  const insert = db.prepare(
    `INSERT INTO roles (id, unit_id, template_key, name, description, color, position, permissions, is_default, is_system, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  );
  db.transaction(() => {
    for (const r of template.roles) {
      insert.run(
        `${unitId}:${r.key}`.slice(0, 120), unitId, r.key, r.name, r.description || null,
        r.color || null, r.position, r.permissions, r.is_default ? 1 : 0, now()
      );
    }
  })();
  return db.prepare('SELECT * FROM roles WHERE unit_id = ? ORDER BY position DESC').all(unitId);
}

/** The role a template marks as the owner's. */
export function ownerRoleId(unitId, templateId = DEFAULT_TEMPLATE_ID) {
  const template = templateById(templateId);
  const owner = template.roles.find((r) => r.owner) || template.roles[template.roles.length - 1];
  return `${unitId}:${owner.key}`.slice(0, 120);
}

/** Stated membership (finding 8). Idempotent; upgrades kind when it rises. */
export function addMember(userId, unitId, { kind = 'member', invitedBy = null, expiresAt = null } = {}) {
  db.prepare(
    `INSERT INTO unit_members (id, user_id, unit_id, kind, joined_at, expires_at, invited_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, unit_id) DO UPDATE SET
       kind = CASE WHEN excluded.kind = 'owner' THEN 'owner' ELSE unit_members.kind END,
       expires_at = excluded.expires_at`
  ).run(newId(), userId, unitId, kind, now(), expiresAt, invitedBy);
}

export function removeMember(userId, unitId) {
  db.prepare('DELETE FROM member_roles WHERE user_id = ? AND unit_id = ?').run(userId, unitId);
  db.prepare('DELETE FROM unit_members WHERE user_id = ? AND unit_id = ?').run(userId, unitId);
}

/**
 * Make a unit sovereign: give it its own role set and an Owner.
 *
 * This is the operation that turns a bare row in `units` into something a
 * SNCOIC actually holds. Phase 2 puts it behind a unit-creation invite; in
 * Phase 1 it is reachable by the bootstrap path and by the Instance Operator,
 * which is also how an imported org-chart template gets claimed one unit at a
 * time.
 */
export function claimUnit(unitId, ownerUserId, templateId = DEFAULT_TEMPLATE_ID) {
  copyTemplateInto(unitId, templateId);
  addMember(ownerUserId, unitId, { kind: 'owner' });
  db.prepare('UPDATE units SET owner_user_id = ? WHERE id = ?').run(ownerUserId, unitId);
  grantRole(ownerUserId, ownerRoleId(unitId, templateId), unitId, ownerUserId);
  return db.prepare('SELECT * FROM units WHERE id = ?').get(unitId);
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
