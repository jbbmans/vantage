import Database from 'better-sqlite3';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { RANKS, BILLETS, flattenUnits } from './usmc.js';
import { ROLE_TEMPLATES, DEFAULT_TEMPLATE_ID, templateById, PERMISSIONS } from './roles.js';
import { hashPassword, sessionDigest } from './auth.js';
import { normalizeUsername } from './identity.js';
import { config, resolveStoragePath } from './config.js';

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

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  username       TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash  TEXT NOT NULL,
  cac_subject    TEXT,
  last_name      TEXT NOT NULL,
  first_name     TEXT NOT NULL,
  middle_initial TEXT,
  rank_id        TEXT REFERENCES ranks(id),
  mos            TEXT,
  email          TEXT,
  is_admin       INTEGER NOT NULL DEFAULT 0,
  active         INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  eas            TEXT,
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

CREATE TABLE IF NOT EXISTS assignments (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  unit_id     TEXT NOT NULL REFERENCES units(id),
  billet_id   TEXT REFERENCES billets(id),
  role        TEXT NOT NULL DEFAULT '',
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

CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  activity_id   TEXT NOT NULL REFERENCES activities(id),
  uploaded_by   TEXT NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  content       BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_attachments_activity ON attachments(activity_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_live_digest
  ON attachments(activity_id, sha256) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ux_daily_metrics (
  day   TEXT NOT NULL,
  event TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  message     TEXT,
  action_url  TEXT,
  dedupe_key  TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_dedupe
  ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS rank_change_requests (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  current_rank_id   TEXT REFERENCES ranks(id),
  requested_rank_id TEXT NOT NULL REFERENCES ranks(id),
  reason            TEXT,
  unit_id           TEXT REFERENCES units(id),
  status            TEXT NOT NULL DEFAULT 'pending',
  reviewed_by       TEXT REFERENCES users(id),
  reviewed_at       TEXT,
  review_note       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rank_requests_user ON rank_change_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rank_requests_status ON rank_change_requests(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rank_requests_one_pending
  ON rank_change_requests(user_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS maradmins (
  id           TEXT PRIMARY KEY,
  number       TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL,
  url          TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'Active',
  tags         TEXT NOT NULL DEFAULT '[]',
  audience     TEXT NOT NULL DEFAULT '[]',
  published_at TEXT NOT NULL,
  source_hash  TEXT,
  fetched_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maradmins_published ON maradmins(published_at DESC);

CREATE TABLE IF NOT EXISTS maradmin_user_state (
  user_id     TEXT NOT NULL REFERENCES users(id),
  maradmin_id TEXT NOT NULL REFERENCES maradmins(id),
  read_at     TEXT,
  saved_at    TEXT,
  PRIMARY KEY (user_id, maradmin_id)
);

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

CREATE TABLE IF NOT EXISTS integration_clients (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  unit_id      TEXT NOT NULL REFERENCES units(id),
  scope        TEXT NOT NULL DEFAULT 'unit.shared.read' CHECK (scope = 'unit.shared.read'),
  token_prefix TEXT NOT NULL UNIQUE,
  token_hash   TEXT NOT NULL UNIQUE,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT,
  revoked_by   TEXT REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_integration_clients_unit ON integration_clients(unit_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db;

export function getDb(file = resolveStoragePath(config.storage.database_path)) {
  if (db) return db;
  db = new Database(file);
  db.exec(SCHEMA);
  migrate();
  seedReference();
  return db;
}

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

      db.prepare("UPDATE assignments SET role = ''").run();
    },
  },
  {
    id: 6,
    name: '006_tenancy',

    foreignKeysOff: true,

    run() {
      const report = { materialised_grants: 0, forked_roles: 0, repointed_grants: 0, memberships: 0, owners: 0, dropped_global_admin: [] };

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

      for (const g of db.prepare('SELECT DISTINCT user_id, unit_id FROM member_roles').all()) {
        if (!db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(g.unit_id)) continue;
        const r = insertMember.run(newId(), g.user_id, g.unit_id, now());
        report.memberships += r.changes;
      }

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

      const globals = db.prepare('SELECT * FROM roles WHERE unit_id IS NULL').all();
      const insertRole = db.prepare(
        `INSERT INTO roles (id, unit_id, name, description, color, position, permissions, is_default, is_system, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

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

        db.exec(`
          INSERT INTO roles_v34 (id, unit_id, template_key, name, description, color, position, permissions, is_default, is_system, created_at)
          SELECT id, unit_id, NULL, name, description, color, position, permissions, is_default, is_system, created_at
            FROM roles WHERE unit_id IS NOT NULL
        `);

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

    run() {
      const report = {};
      for (const table of ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings']) {
        const r = db.prepare(`UPDATE ${table} SET visibility = 'unit' WHERE visibility = 'chain'`).run();
        report[table] = r.changes;
      }

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
  {
    id: 8,
    name: '008_session_digests_and_temporary_passwords',
    run() {
      addColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');

      const rows = db.prepare('SELECT token FROM sessions').all();
      let digested = 0;
      for (const row of rows) {
        if (/^[a-f0-9]{64}$/.test(row.token)) continue;
        db.prepare('UPDATE sessions SET token = ? WHERE token = ?')
          .run(sessionDigest(row.token), row.token);
        digested += 1;
      }
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('migration_008_report', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(JSON.stringify({ sessions_digested: digested }));
    },
  },
  {
    id: 9,
    name: '009_canonical_usernames_and_role_unit_integrity',
    run() {

      const collisions = db.prepare(
        `SELECT lower(username) AS canonical, COUNT(*) AS n,
                group_concat(username, ', ') AS spellings
           FROM users GROUP BY lower(username) HAVING COUNT(*) > 1`
      ).all();
      if (collisions.length) {
        throw new Error(
          'Case-colliding usernames must be resolved before this upgrade: '
          + collisions.map((r) => r.spellings).join('; ')
        );
      }
      db.prepare('UPDATE users SET username = lower(trim(username))').run();
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)');

      const mismatches = db.prepare(
        `SELECT DISTINCT mr.role_id, mr.unit_id
           FROM member_roles mr JOIN roles r ON r.id = mr.role_id
          WHERE r.unit_id <> mr.unit_id`
      ).all();
      let rolesForked = 0;
      let grantsRepointed = 0;
      for (const mismatch of mismatches) {
        const source = db.prepare('SELECT * FROM roles WHERE id = ?').get(mismatch.role_id);
        if (!source || !db.prepare('SELECT 1 FROM units WHERE id = ?').get(mismatch.unit_id)) continue;
        const suffix = createHash('sha256')
          .update(`${mismatch.unit_id}\0${source.id}`, 'utf8')
          .digest('hex')
          .slice(0, 20);
        const copyId = `m9-${suffix}`;
        const inserted = db.prepare(
          `INSERT INTO roles
             (id, unit_id, template_key, name, description, color, position, permissions,
              is_default, is_system, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`
        ).run(
          copyId, mismatch.unit_id, source.template_key || source.id,
          source.name, source.description, source.color, source.position, source.permissions,
          source.is_default, source.is_system, source.created_at || now()
        );
        rolesForked += inserted.changes;
        grantsRepointed += db.prepare(
          'UPDATE member_roles SET role_id = ? WHERE role_id = ? AND unit_id = ?'
        ).run(copyId, mismatch.role_id, mismatch.unit_id).changes;
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_member_roles_role_unit ON member_roles(role_id, unit_id);
        CREATE TRIGGER IF NOT EXISTS member_roles_unit_match_insert
        BEFORE INSERT ON member_roles
        FOR EACH ROW WHEN NOT EXISTS (
          SELECT 1 FROM roles r WHERE r.id = NEW.role_id AND r.unit_id = NEW.unit_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'role and grant unit mismatch');
        END;
        CREATE TRIGGER IF NOT EXISTS member_roles_unit_match_update
        BEFORE UPDATE OF role_id, unit_id ON member_roles
        FOR EACH ROW WHEN NOT EXISTS (
          SELECT 1 FROM roles r WHERE r.id = NEW.role_id AND r.unit_id = NEW.unit_id
        )
        BEGIN
          SELECT RAISE(ABORT, 'role and grant unit mismatch');
        END;
      `);

      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('migration_009_report', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run(JSON.stringify({ roles_forked: rolesForked, grants_repointed: grantsRepointed }));
    },
  },
  {
    id: 10,
    name: '010_cac_piv_identity_binding',
    run() {
      addColumn('users', 'cac_subject', 'TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_cac_subject ON users(cac_subject) WHERE cac_subject IS NOT NULL');
    },
  },
  {
    id: 11,
    name: '011_optional_activity_attachments',
    run() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS attachments (
          id            TEXT PRIMARY KEY,
          activity_id   TEXT NOT NULL REFERENCES activities(id),
          uploaded_by   TEXT NOT NULL REFERENCES users(id),
          original_name TEXT NOT NULL,
          mime_type     TEXT NOT NULL,
          size_bytes    INTEGER NOT NULL,
          sha256        TEXT NOT NULL,
          content       BLOB NOT NULL,
          created_at    TEXT NOT NULL,
          deleted_at    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_activity ON attachments(activity_id);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_live_digest
          ON attachments(activity_id, sha256) WHERE deleted_at IS NULL;
      `);
    },
  },
  {
    id: 12,
    name: '012_first_party_experience_aggregates',
    run() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ux_daily_metrics (
          day   TEXT NOT NULL,
          event TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (day, event)
        );
      `);
    },
  },
  {
    id: 13,
    name: '013_notifications_rank_requests_and_maradmins',
    run() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          kind TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT,
          action_url TEXT,
          dedupe_key TEXT,
          read_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_user_created
          ON notifications(user_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_user_dedupe
          ON notifications(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

        CREATE TABLE IF NOT EXISTS rank_change_requests (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          current_rank_id TEXT REFERENCES ranks(id),
          requested_rank_id TEXT NOT NULL REFERENCES ranks(id),
          reason TEXT,
          unit_id TEXT REFERENCES units(id),
          status TEXT NOT NULL DEFAULT 'pending',
          reviewed_by TEXT REFERENCES users(id),
          reviewed_at TEXT,
          review_note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rank_requests_user
          ON rank_change_requests(user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_rank_requests_status
          ON rank_change_requests(status, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_rank_requests_one_pending
          ON rank_change_requests(user_id) WHERE status = 'pending';

        CREATE TABLE IF NOT EXISTS maradmins (
          id TEXT PRIMARY KEY,
          number TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          url TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Active',
          tags TEXT NOT NULL DEFAULT '[]',
          audience TEXT NOT NULL DEFAULT '[]',
          published_at TEXT NOT NULL,
          source_hash TEXT,
          fetched_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_maradmins_published ON maradmins(published_at DESC);

        CREATE TABLE IF NOT EXISTS maradmin_user_state (
          user_id TEXT NOT NULL REFERENCES users(id),
          maradmin_id TEXT NOT NULL REFERENCES maradmins(id),
          read_at TEXT,
          saved_at TEXT,
          PRIMARY KEY (user_id, maradmin_id)
        );
      `);
    },
  },
  {
    id: 14,
    name: '014_tamper_evident_audit_chain',
    run() {
      addColumn('audit_log', 'prev_hash', 'TEXT');
      addColumn('audit_log', 'entry_hash', 'TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_entry_hash ON audit_log(entry_hash) WHERE entry_hash IS NOT NULL');
      let previous = '';
      const rows = db.prepare(
        'SELECT rowid, id, actor_id, action, entity, entity_id, subject_id, unit_id, detail, at FROM audit_log ORDER BY rowid'
      ).all();
      const update = db.prepare('UPDATE audit_log SET prev_hash = ?, entry_hash = ? WHERE rowid = ?');
      for (const row of rows) {
        const hash = auditEntryHash(row, previous);
        update.run(previous || null, hash, row.rowid);
        previous = hash;
      }
      setAuditAnchor(previous, rows.length);
    },
  },
  {
    id: 15,
    name: '015_exact_unit_integration_clients',
    run() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS integration_clients (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          unit_id TEXT NOT NULL REFERENCES units(id),
          scope TEXT NOT NULL DEFAULT 'unit.shared.read' CHECK (scope = 'unit.shared.read'),
          token_prefix TEXT NOT NULL UNIQUE,
          token_hash TEXT NOT NULL UNIQUE,
          active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_used_at TEXT,
          revoked_at TEXT,
          revoked_by TEXT REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_integration_clients_unit ON integration_clients(unit_id);
      `);
    },
  },
];

function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const current = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0);
  for (const m of MIGRATIONS) {
    if (m.id <= current) continue;

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

function auditIntegrityKey() {
  const key = String(process.env.VANTAGE_AUDIT_HMAC_KEY || '');
  if (Buffer.byteLength(key, 'utf8') >= 32) return key;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('VANTAGE_AUDIT_HMAC_KEY must be at least 32 bytes in production.');
  }
  // Development/test only: production must supply an environment-held key.
  return 'vantage-development-audit-key-not-for-production';
}

function auditEntryHash(row, previous) {
  const canonical = JSON.stringify([
    previous || '', row.id, row.actor_id, row.action, row.entity || null,
    row.entity_id || null, row.subject_id || null, row.unit_id || null,
    row.detail || null, row.at,
  ]);
  return createHmac('sha256', auditIntegrityKey()).update(canonical, 'utf8').digest('hex');
}

function setAuditAnchor(hash, count) {
  const payload = JSON.stringify([hash || '', count]);
  const mac = createHmac('sha256', auditIntegrityKey()).update(`audit-anchor:${payload}`, 'utf8').digest('hex');
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('audit_log_anchor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(JSON.stringify({ hash: hash || '', count, mac }));
}

export function verifyAuditChain(database = db) {
  const rows = database.prepare(
    'SELECT rowid, id, actor_id, action, entity, entity_id, subject_id, unit_id, detail, at, prev_hash, entry_hash FROM audit_log ORDER BY rowid'
  ).all();
  let previous = '';
  for (const row of rows) {
    const expected = auditEntryHash(row, previous);
    const supplied = Buffer.from(String(row.entry_hash || ''), 'utf8');
    const calculated = Buffer.from(expected, 'utf8');
    if (row.prev_hash !== (previous || null) || !row.entry_hash
      || supplied.length !== calculated.length || !timingSafeEqual(supplied, calculated)) {
      return { ok: false, count: rows.length, reason: `audit entry ${row.id} does not match the chain` };
    }
    previous = row.entry_hash;
  }
  const anchor = database.prepare("SELECT value FROM meta WHERE key = 'audit_log_anchor'").get()?.value;
  try {
    const parsed = JSON.parse(anchor || '{}');
    const payload = JSON.stringify([parsed.hash || '', parsed.count]);
    const expectedMac = createHmac('sha256', auditIntegrityKey()).update(`audit-anchor:${payload}`, 'utf8').digest('hex');
    const suppliedMac = Buffer.from(String(parsed.mac || ''), 'utf8');
    const calculatedMac = Buffer.from(expectedMac, 'utf8');
    if (parsed.hash !== previous || parsed.count !== rows.length
      || suppliedMac.length !== calculatedMac.length || !timingSafeEqual(suppliedMac, calculatedMac)) {
      return { ok: false, count: rows.length, reason: 'audit anchor does not match the chain' };
    }
  } catch {
    return { ok: false, count: rows.length, reason: 'audit anchor is invalid' };
  }
  return { ok: true, count: rows.length };
}

const SEED_VERSION = 2;

function seedReference() {
  const insertRank = db.prepare(
    `INSERT INTO ranks (id, grade, abbr, name, tier, sort) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET grade=excluded.grade, name=excluded.name, tier=excluded.tier, sort=excluded.sort`
  );
  db.transaction(() => {
    for (const r of RANKS) insertRank.run(r.abbr, r.grade, r.abbr, r.name, r.tier, r.sort);
  })();

  const insertBillet = db.prepare(
    `INSERT INTO billets (id, title, category, echelon, default_role) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(title) DO NOTHING`
  );
  db.transaction(() => {
    for (const b of BILLETS) {
      insertBillet.run(slug(b.title), b.title, b.category, b.echelon, b.default_role);
    }
  })();

  const unitCount = db.prepare('SELECT COUNT(*) AS count FROM units').get().count;
  if (unitCount === 0) {
    const rows = flattenUnits();
    const insertUnit = db.prepare(
      `INSERT INTO units (id, code, name, short_name, echelon, location, parent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    db.transaction(() => {
      for (const u of rows) {
        insertUnit.run(u.code, u.code, u.name, u.short_name || null, u.echelon, u.location || null, u.parent_code, now());
      }
    })();
  }

  if (db.prepare("SELECT 1 FROM units WHERE id = 'MFR'").get()) {
    copyTemplateInto('MFR', DEFAULT_TEMPLATE_ID);
  }

  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('seed_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(SEED_VERSION));
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function bootstrapAdmin({ username, password, first_name, last_name, rank_id, mos, unit_code, billet_title, template_id }) {
  return db.transaction(() => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (count > 0) return null;

    const id = newId();
    db.prepare(
      `INSERT INTO users (id, username, password_hash, last_name, first_name, rank_id, mos, is_admin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(id, normalizeUsername(username), hashPassword(password), last_name, first_name, rank_id || null, mos || null, now(), now());

    const unit = db.prepare('SELECT id FROM units WHERE code = ? AND active = 1').get(unit_code || 'MFR');
    if (!unit) throw new Error('No such active setup unit.');
    const billet = billet_title ? db.prepare('SELECT id FROM billets WHERE title = ? AND active = 1').get(billet_title) : null;
    db.prepare(
      `INSERT INTO assignments (id, user_id, unit_id, billet_id, role, is_primary, start_date, created_at)
       VALUES (?, ?, ?, ?, '', 1, ?, ?)`
    ).run(newId(), id, unit.id, billet?.id || null, now().slice(0, 10), now());
    claimUnit(unit.id, id, template_id || DEFAULT_TEMPLATE_ID);
    return { id, username };
  })();
}

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

export function ownerRoleId(unitId, templateId = DEFAULT_TEMPLATE_ID) {
  const template = templateById(templateId);
  const owner = template.roles.find((r) => r.owner) || template.roles[template.roles.length - 1];
  return `${unitId}:${owner.key}`.slice(0, 120);
}

export function addMember(userId, unitId, { kind = 'member', invitedBy = null, expiresAt = null } = {}) {
  db.prepare(
    `INSERT INTO unit_members (id, user_id, unit_id, kind, joined_at, expires_at, invited_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, unit_id) DO UPDATE SET
       kind = CASE
         WHEN unit_members.kind = 'owner' OR excluded.kind = 'owner' THEN 'owner'
         WHEN excluded.kind = 'member' THEN 'member'
         ELSE unit_members.kind
       END,
       expires_at = CASE
         WHEN unit_members.kind = 'owner' OR excluded.kind IN ('owner', 'member') THEN NULL
         ELSE excluded.expires_at
       END,
       invited_by = COALESCE(excluded.invited_by, unit_members.invited_by)`
  ).run(newId(), userId, unitId, kind, now(), kind === 'guest' ? expiresAt : null, invitedBy);
}

export function removeMember(userId, unitId) {
  return db.transaction(() => {
    const frozenAt = now();
    let recordsFrozen = 0;
    for (const table of ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings']) {
      recordsFrozen += db.prepare(
        `UPDATE ${table}
            SET frozen_at = ?, frozen_reason = 'membership removed from originating unit',
                updated_at = ?, version = version + 1
          WHERE user_id = ? AND unit_id = ? AND visibility = 'unit'
            AND deleted_at IS NULL AND frozen_at IS NULL`
      ).run(frozenAt, frozenAt, userId, unitId).changes;
    }
    const roles = db.prepare('DELETE FROM member_roles WHERE user_id = ? AND unit_id = ?').run(userId, unitId).changes;
    const membership = db.prepare('DELETE FROM unit_members WHERE user_id = ? AND unit_id = ?').run(userId, unitId).changes;
    const assignments = db.prepare(
      `UPDATE assignments
          SET end_date = COALESCE(end_date, date('now')), is_primary = 0
        WHERE user_id = ? AND unit_id = ? AND (end_date IS NULL OR end_date > date('now'))`
    ).run(userId, unitId).changes;

    const hasPrimary = db.prepare('SELECT 1 FROM assignments WHERE user_id = ? AND is_primary = 1').get(userId);
    if (!hasPrimary) {
      const next = db.prepare(
        `SELECT a.id FROM assignments a
           JOIN unit_members um ON um.user_id = a.user_id AND um.unit_id = a.unit_id
          WHERE a.user_id = ? AND (a.end_date IS NULL OR a.end_date > date('now'))
            AND (um.expires_at IS NULL OR um.expires_at > datetime('now'))
          ORDER BY a.start_date DESC, a.created_at DESC LIMIT 1`
      ).get(userId);
      if (next) db.prepare('UPDATE assignments SET is_primary = 1 WHERE id = ?').run(next.id);
    }
    return { roles, membership, assignments, recordsFrozen };
  })();
}

export function freezeMemberUnitRecords(userId, unitId, reason = 'membership transferred from originating unit') {
  const frozenAt = now();
  let recordsFrozen = 0;
  for (const table of ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings']) {
    recordsFrozen += db.prepare(
      `UPDATE ${table}
          SET frozen_at = ?, frozen_reason = ?, updated_at = ?, version = version + 1
        WHERE user_id = ? AND unit_id = ? AND visibility = 'unit'
          AND deleted_at IS NULL AND frozen_at IS NULL`
    ).run(frozenAt, reason, frozenAt, userId, unitId).changes;
  }
  return recordsFrozen;
}

export function claimUnit(unitId, ownerUserId, templateId = DEFAULT_TEMPLATE_ID) {
  return db.transaction(() => {
    copyTemplateInto(unitId, templateId);
    addMember(ownerUserId, unitId, { kind: 'owner' });
    db.prepare('UPDATE units SET owner_user_id = ? WHERE id = ?').run(ownerUserId, unitId);
    grantRole(ownerUserId, ownerRoleId(unitId, templateId), unitId, ownerUserId);
    return db.prepare('SELECT * FROM units WHERE id = ?').get(unitId);
  })();
}

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
  const entry = {
    id: newId(), actor_id, action, entity: entity || null, entity_id: entity_id || null,
    subject_id: subject_id || null, unit_id: unit_id || null, detail: detail || null, at: now(),
  };
  const previous = db.prepare('SELECT entry_hash FROM audit_log ORDER BY rowid DESC LIMIT 1').get()?.entry_hash || '';
  const entryHash = auditEntryHash(entry, previous);
  db.prepare(
    `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, subject_id, unit_id, detail, at, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.id, entry.actor_id, entry.action, entry.entity, entry.entity_id, entry.subject_id,
    entry.unit_id, entry.detail, entry.at, previous || null, entryHash
  );
  setAuditAnchor(entryHash, db.prepare('SELECT COUNT(*) AS n FROM audit_log').get().n);
}

export function notifyUser(userId, { kind, title, message = null, actionUrl = null, dedupeKey = null }) {
  const id = newId();
  const result = db.prepare(
    `INSERT INTO notifications (id, user_id, kind, title, message, action_url, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
  ).run(id, userId, kind, title, message, actionUrl, dedupeKey, now());
  return result.changes ? id : null;
}

export { now };
