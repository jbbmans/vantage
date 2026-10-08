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
  {
    id: 16,
    name: '016_unit_instance_isolation',
    run: (db) => {
      instanceBoundaryTriggers(db);
      // Rows joined across the boundary before it was kept stay as they are, so nothing is lost, and are counted, so an
      // operator can find them (ADR-0008). Their owners can still edit them; only a new crossing is refused.
      const found = instanceBoundaryViolations(db);
      if (Object.keys(found).length) metaSet(db, 'instance_boundary_violations', JSON.stringify({ at: new Date().toISOString(), found }));
    },
  },
  {
    id: 17,
    name: '017_attachment_unit',
    run: (db) => {
      // A file keeps the unit its record sat in when it was added, as a comment does, so a move across the boundary is
      // judged by where the file was added and not by where its uploader serves now (ADR-0008).
      if (!columnsOf(db, 'attachments').has('unit_id')) db.exec('ALTER TABLE attachments ADD COLUMN unit_id TEXT REFERENCES units(id)');
      stampAttachmentUnits(db);
    },
  },
  {
    id: 18,
    name: '018_identity_and_membership_history',
    run: (db) => {
      // When the account's EDIPI was last proven by its card (ADR-0009). Accounts whose card already signed in under the
      // EDIPI they carry now are proven from the audit log; any other EDIPI was typed in by someone and stays unproven.
      const users = columnsOf(db, 'users');
      if (!users.has('edipi_verified_at')) db.exec('ALTER TABLE users ADD COLUMN edipi_verified_at TEXT');
      if (users.has('edipi')) db.exec(`UPDATE users SET edipi_verified_at = (
          SELECT MAX(a.at) FROM audit_log a WHERE a.actor_id = users.id AND a.action IN ('cac_verified', 'cac_provisioned')
             AND (a.detail = 'edipi=' || users.edipi OR a.detail LIKE 'edipi=' || users.edipi || ' %'))
        WHERE edipi IS NOT NULL AND edipi_verified_at IS NULL`);
      // The table comes from schema.sql. Memberships held before it existed open their first period at the joined date.
      membershipHistoryTriggers(db);
      openMissingMembershipPeriods(db);
    },
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

/** The organization of a unit, as SQL over an expression that names one. */
const orgOf = (unit: string) => `(SELECT org_id FROM units WHERE id = ${unit})`;
/** Two units across the boundary: both organizations known, and different. `<>` is not true when either is NULL. */
const across = (a: string, b: string) => `${orgOf(a)} <> ${orgOf(b)}`;
const projectUnit = (id: string) => `(SELECT unit_id FROM projects WHERE id = ${id})`;
const contactUnit = (id: string) => `(SELECT unit_id FROM contacts WHERE id = ${id})`;
const threadUnit = (id: string) => `(SELECT unit_id FROM threads WHERE id = ${id})`;
const itemUnit = (id: string) => `(SELECT unit_id FROM work_items WHERE id = ${id})`;
const PROJECT_CHILDREN = ['activities', 'tasks', 'work_items'] as const;
/** The tables that file rows under a project in this database. One built by hand at an older version may lack the column. */
const filedUnderProjects = (db: Db) => PROJECT_CHILDREN.filter((t) => columnsOf(db, t).has('project_id'));

/**
 * The Unit Instance boundary, kept by the database as well as by the code that enforces it (ADR-0008). Authorization
 * is decided in the server; these triggers are the second line, so that a defect or a hand-written statement cannot
 * quietly move a unit between organizations or link one instance's rows to another's. PostgreSQL row-level security
 * is the equivalent for a PostgreSQL deployment; on SQLite, which has no RLS, triggers are what the engine offers.
 *
 * They refuse only a pairing that is really across the boundary: two units whose organizations are both known and
 * differ. A row with no unit belongs to no instance, a unit an archive has not yet given its organization is not known
 * to differ, and a reference to a row that is not there yet passes, because an archive is restored table by table and
 * `instanceBoundaryViolations` checks it whole once it is in. Both ends of each reference are kept: the row that points,
 * and the row pointed at, which cannot move out from under it. An update is checked only when it changes the reference
 * or a unit, so a row joined across before this migration can still be edited. Each refusal begins `cross_instance:`,
 * which the API answers as a refusal rather than a server error.
 */
export function instanceBoundaryTriggers(db: Db) {
  const refuse = (why: string) => `BEGIN SELECT RAISE(ABORT, 'cross_instance: ${why}'); END`;
  // A unit's organization is set once, when it is created. Nothing moves it afterwards.
  db.exec(`CREATE TRIGGER IF NOT EXISTS units_org_immutable BEFORE UPDATE OF org_id ON units FOR EACH ROW
    WHEN OLD.org_id IS NOT NULL AND NEW.org_id IS NOT OLD.org_id
    ${refuse('a unit cannot change Unit Instance')}`);

  // An entry, a task or a queue item filed under a project stays inside the project's instance...
  const children = filedUnderProjects(db);
  for (const table of children) {
    const crossing = `NEW.project_id IS NOT NULL AND ${across('NEW.unit_id', projectUnit('NEW.project_id'))}`;
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_project_same_org_insert BEFORE INSERT ON ${table} FOR EACH ROW
      WHEN ${crossing}
      ${refuse('a project in another Unit Instance cannot be linked here')}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_project_same_org_update BEFORE UPDATE OF project_id, unit_id ON ${table} FOR EACH ROW
      WHEN (NEW.project_id IS NOT OLD.project_id OR NEW.unit_id IS NOT OLD.unit_id) AND ${crossing}
      ${refuse('a project in another Unit Instance cannot be linked here')}`);
  }
  // ...and a project moves only where everything filed under it can follow.
  if (children.length) db.exec(`CREATE TRIGGER IF NOT EXISTS projects_children_same_org BEFORE UPDATE OF unit_id ON projects FOR EACH ROW
    WHEN NEW.unit_id IS NOT OLD.unit_id AND (${children.map((t) => `EXISTS (SELECT 1 FROM ${t} c WHERE c.project_id = NEW.id AND ${across('c.unit_id', 'NEW.unit_id')})`).join(' OR ')})
    ${refuse('work in another Unit Instance is filed under this project')}`);

  // Correspondence names a contact from its own instance, and the contact stays where its threads are.
  const contactCrossing = `NEW.contact_id IS NOT NULL AND ${across('NEW.unit_id', contactUnit('NEW.contact_id'))}`;
  db.exec(`CREATE TRIGGER IF NOT EXISTS threads_contact_same_org_insert BEFORE INSERT ON threads FOR EACH ROW
    WHEN ${contactCrossing}
    ${refuse('a contact in another Unit Instance cannot be used here')}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS threads_contact_same_org_update BEFORE UPDATE OF contact_id, unit_id ON threads FOR EACH ROW
    WHEN (NEW.contact_id IS NOT OLD.contact_id OR NEW.unit_id IS NOT OLD.unit_id) AND ${contactCrossing}
    ${refuse('a contact in another Unit Instance cannot be used here')}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS contacts_threads_same_org BEFORE UPDATE OF unit_id ON contacts FOR EACH ROW
    WHEN NEW.unit_id IS NOT OLD.unit_id AND EXISTS (SELECT 1 FROM threads t WHERE t.contact_id = NEW.id AND ${across('t.unit_id', 'NEW.unit_id')})
    ${refuse('correspondence in another Unit Instance names this contact')}`);

  // A thread points at work in its own instance, and neither end of the link moves out from under the other.
  const linkCrossing = across(threadUnit('NEW.thread_id'), itemUnit('NEW.work_item_id'));
  db.exec(`CREATE TRIGGER IF NOT EXISTS thread_links_same_org BEFORE INSERT ON thread_links FOR EACH ROW
    WHEN ${linkCrossing}
    ${refuse('correspondence and work in different Unit Instances cannot be linked')}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS thread_links_same_org_update BEFORE UPDATE OF thread_id, work_item_id ON thread_links FOR EACH ROW
    WHEN ${linkCrossing}
    ${refuse('correspondence and work in different Unit Instances cannot be linked')}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS threads_links_same_org BEFORE UPDATE OF unit_id ON threads FOR EACH ROW
    WHEN NEW.unit_id IS NOT OLD.unit_id AND EXISTS (SELECT 1 FROM thread_links l WHERE l.thread_id = NEW.id AND ${across(itemUnit('l.work_item_id'), 'NEW.unit_id')})
    ${refuse('this correspondence is linked to work in another Unit Instance')}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS work_items_links_same_org BEFORE UPDATE OF unit_id ON work_items FOR EACH ROW
    WHEN NEW.unit_id IS NOT OLD.unit_id AND EXISTS (SELECT 1 FROM thread_links l WHERE l.work_item_id = NEW.id AND ${across(threadUnit('l.thread_id'), 'NEW.unit_id')})
    ${refuse('this work is linked to correspondence in another Unit Instance')}`);
}

/**
 * Rows already joined across the boundary, by kind, leaving out the kinds with none. Migration 016 records what it found
 * on the way in, and an instance archive that brings any is refused, so neither is a silent pass (ADR-0008).
 */
export function instanceBoundaryViolations(db: Db): Record<string, number> {
  const checks: Record<string, string> = {
    ...Object.fromEntries(filedUnderProjects(db).map((t) => [`${t}_project`, `SELECT COUNT(*) AS n FROM ${t} x JOIN projects p ON p.id = x.project_id WHERE ${across('x.unit_id', 'p.unit_id')}`])),
    threads_contact: `SELECT COUNT(*) AS n FROM threads t JOIN contacts c ON c.id = t.contact_id WHERE ${across('t.unit_id', 'c.unit_id')}`,
    thread_links: `SELECT COUNT(*) AS n FROM thread_links l JOIN threads t ON t.id = l.thread_id JOIN work_items w ON w.id = l.work_item_id WHERE ${across('t.unit_id', 'w.unit_id')}`,
  };
  const found: Record<string, number> = {};
  for (const [kind, sql] of Object.entries(checks)) {
    const { n } = db.prepare(sql).get() as { n: number };
    if (n) found[kind] = n;
  }
  return found;
}

/**
 * Lifts the boundary's triggers, for a caller that puts them back with `instanceBoundaryTriggers` in the same
 * transaction: an archive is restored table by table, so its rows are checked whole once they are all in.
 */
export function dropInstanceBoundaryTriggers(db: Db) {
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%cross_instance:%'").all() as Array<{ name: string }>;
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
}

const MEMBERSHIP_TRIGGERS = ['unit_membership_opened', 'unit_membership_changed', 'unit_membership_closed'] as const;
const AT_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/**
 * Membership history is written by the database (ADR-0009), so no way of joining, moving or leaving a unit (a route, the
 * personnel feed, an import, a script) can change unit_members without leaving its period behind. The service fills in
 * why and by whom afterwards, in the same transaction (server/services/membership.ts).
 */
export function membershipHistoryTriggers(db: Db) {
  db.exec(`CREATE TRIGGER IF NOT EXISTS unit_membership_opened AFTER INSERT ON unit_members FOR EACH ROW
    BEGIN
      UPDATE unit_membership_periods SET ended_at = NEW.joined_at, end_reason = 'superseded'
       WHERE user_id = NEW.user_id AND unit_id = NEW.unit_id AND ended_at IS NULL;
      INSERT INTO unit_membership_periods (user_id, unit_id, billet, is_primary, started_at, started_by)
      VALUES (NEW.user_id, NEW.unit_id, NEW.billet, NEW.is_primary, NEW.joined_at, NEW.invited_by);
    END`);
  // A new billet or a primary flag that moved closes one period and opens the next; an update that changes neither is no change.
  const why = "CASE WHEN OLD.billet IS NOT NEW.billet THEN 'billet_changed' ELSE 'primary_changed' END";
  db.exec(`CREATE TRIGGER IF NOT EXISTS unit_membership_changed AFTER UPDATE OF billet, is_primary ON unit_members FOR EACH ROW
    WHEN OLD.billet IS NOT NEW.billet OR OLD.is_primary IS NOT NEW.is_primary
    BEGIN
      UPDATE unit_membership_periods SET ended_at = ${AT_NOW}, end_reason = ${why}
       WHERE user_id = OLD.user_id AND unit_id = OLD.unit_id AND ended_at IS NULL;
      INSERT INTO unit_membership_periods (user_id, unit_id, billet, is_primary, started_at, start_reason)
      VALUES (NEW.user_id, NEW.unit_id, NEW.billet, NEW.is_primary, ${AT_NOW}, ${why});
    END`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS unit_membership_closed AFTER DELETE ON unit_members FOR EACH ROW
    BEGIN
      UPDATE unit_membership_periods SET ended_at = ${AT_NOW}
       WHERE user_id = OLD.user_id AND unit_id = OLD.unit_id AND ended_at IS NULL;
    END`);
}

/** Lifted while an instance archive loads, which brings its own history, and put back before it commits. */
export function dropMembershipHistoryTriggers(db: Db) {
  for (const name of MEMBERSHIP_TRIGGERS) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

/** Every current membership with no open period gets one from its joined date: memberships older than the history. */
export function openMissingMembershipPeriods(db: Db): number {
  return db.prepare(`INSERT INTO unit_membership_periods (user_id, unit_id, billet, is_primary, started_at, start_reason, started_by)
    SELECT um.user_id, um.unit_id, um.billet, um.is_primary, um.joined_at, 'recorded', um.invited_by FROM unit_members um
     WHERE NOT EXISTS (SELECT 1 FROM unit_membership_periods p WHERE p.user_id = um.user_id AND p.unit_id = um.unit_id AND p.ended_at IS NULL)`).run().changes;
}

/** The record types that take attachments, each with the unit its row sits in. */
const ATTACHMENT_HOSTS = ['activities', 'awards', 'counselings', 'trainings', 'tasks', 'projects', 'goals'] as const;

/**
 * Files attached before they kept a unit take the one their record sits in now. For a record moved before the boundary
 * was kept that is where the file is already read, so nothing new crosses; one in no unit keeps none, and a move is then
 * judged by whether its uploader serves where it goes (ADR-0008).
 */
export function stampAttachmentUnits(db: Db) {
  for (const table of ATTACHMENT_HOSTS) {
    db.prepare(`UPDATE attachments SET unit_id = (SELECT r.unit_id FROM ${table} r WHERE r.id = attachments.record_id) WHERE record_table = ? AND unit_id IS NULL`).run(table);
  }
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
