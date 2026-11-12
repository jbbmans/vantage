import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, migrationHistory, instanceBoundaryViolations, SCHEMA_VERSION } from '../../server/db/index.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';
import { hmac } from '../../server/lib/crypto.ts';
import { loadConfig } from '../../server/config.ts';
import { createContext } from '../../server/app.ts';
import { audit, verifyAuditChain } from '../../server/services/audit.ts';

function atVersion(version: number, seed: (db: Database.Database) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'vantage-migrate-'));
  const path = join(dir, 'vantage.db');
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(new URL('../../server/db/schema.sql', import.meta.url), 'utf8'));
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version));
  seed(db);
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('007 grants the split work verbs to roles that could already do that work', () => {
  const { path, cleanup } = atVersion(6, (db) => {
    db.prepare('INSERT INTO units (id, code, name, created_at) VALUES (?, ?, ?, ?)').run('G8', 'G8', 'G-8', new Date().toISOString());
    const role = (id: string, name: string, permissions: number) =>
      db.prepare('INSERT INTO roles (id, unit_id, key, name, permissions, position, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
        .run(id, 'G8', name.toLowerCase(), name, permissions, new Date().toISOString());
    // A plain member: view only. An SNCO: can correct shared records.
    role('r-marine', 'Marine', PERMISSIONS.VIEW_UNIT);
    role('r-snco', 'SNCO', PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.MANAGE_RECORDS);
    // A role with nothing at all stays with nothing at all.
    role('r-empty', 'Suspended', 0);
  });

  try {
    const db = openDatabase(path);
    const bits = (id: string) => (db.prepare('SELECT permissions FROM roles WHERE id = ?').get(id) as { permissions: number }).permissions;

    for (const verb of ['CLAIM_WORK', 'RESOLVE_WORK'] as const) {
      assert.ok(bits('r-marine') & PERMISSIONS[verb], `a Marine keeps ${verb}`);
      assert.ok(bits('r-snco') & PERMISSIONS[verb], `an SNCO keeps ${verb}`);
    }

    for (const verb of ['EDIT_WORK', 'REASSIGN_WORK'] as const) {
      assert.ok(bits('r-snco') & PERMISSIONS[verb], `SNCO gains ${verb}`);
      assert.equal(bits('r-marine') & PERMISSIONS[verb], 0, `a Marine does not silently gain ${verb}`);
    }

    // A role holding nothing is not handed anything.
    assert.equal(bits('r-empty'), 0, 'a role with no permissions gains none');

    // And the structural half of the migration landed.
    const work = (db.prepare('PRAGMA table_info(work_items)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(work.includes('project_id'), 'a queue row can belong to a project');
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((i) => i.name);
    for (const idx of ['idx_work_items_project', 'idx_tasks_project', 'idx_activities_project']) {
      assert.ok(indexes.includes(idx), `${idx} exists`);
    }
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    db.close();
  } finally { cleanup(); }
});

test('running the migration twice changes nothing the second time', () => {
  const { path, cleanup } = atVersion(6, (db) => {
    db.prepare('INSERT INTO units (id, code, name, created_at) VALUES (?, ?, ?, ?)').run('G8', 'G8', 'G-8', new Date().toISOString());
    db.prepare('INSERT INTO roles (id, unit_id, key, name, permissions, position, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run('r-snco', 'G8', 'snco', 'SNCO', PERMISSIONS.VIEW_UNIT | PERMISSIONS.MANAGE_RECORDS, new Date().toISOString());
  });
  try {
    const first = openDatabase(path);
    const after = (first.prepare('SELECT permissions FROM roles WHERE id = ?').get('r-snco') as { permissions: number }).permissions;
    first.close();
    const second = openDatabase(path);
    const again = (second.prepare('SELECT permissions FROM roles WHERE id = ?').get('r-snco') as { permissions: number }).permissions;
    second.close();
    assert.equal(again, after, 'a second boot does not keep widening permissions');
  } finally { cleanup(); }
});

test('008 gives every work item a stage from its state and carries existing actions and claims into the history', () => {
  const at = '2026-08-01T12:00:00.000Z';
  const { path, cleanup } = atVersion(7, (db) => {
    db.prepare('INSERT INTO units (id, code, name, created_at) VALUES (?, ?, ?, ?)').run('G8', 'G8', 'G-8', at);
    db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES ('u1', 'avery', 'x', 'Jordan', 'Avery', ?, ?)").run(at, at);
    // A v7 work_items row has project_id (from 007) but no stage.
    db.exec('ALTER TABLE work_items ADD COLUMN project_id TEXT REFERENCES projects(id)');
    const item = db.prepare(`INSERT INTO work_items (id, unit_id, owner_id, natural_key, row_hash, title, state, claimed_by, claimed_at, created_at, updated_at)
                             VALUES (?, 'G8', 'u1', ?, '', ?, ?, ?, ?, ?, ?)`);
    item.run('w-open', 'k1', 'Open item', 'open', null, null, at, at);
    item.run('w-held', 'k2', 'Held item', 'in_progress', 'u1', at, at, at);
    item.run('w-done', 'k3', 'Done item', 'resolved', null, null, at, at);
    db.prepare(`INSERT INTO work_actions (id, work_item_id, user_id, unit_id, kind, note, occurred_at, created_at) VALUES ('a1', 'w-done', 'u1', 'G8', 'reconciled', 'Cleared', '2026-07-30', ?)`).run(at);
  });
  try {
    const db = openDatabase(path);
    const stage = (id: string) => (db.prepare('SELECT stage FROM work_items WHERE id = ?').get(id) as { stage: string }).stage;
    assert.equal(stage('w-open'), 'not_started');
    assert.equal(stage('w-held'), 'researching');
    assert.equal(stage('w-done'), 'resolved');
    const events = db.prepare('SELECT work_item_id, actor_id, kind FROM work_events ORDER BY kind').all() as Array<{ work_item_id: string; actor_id: string; kind: string }>;
    assert.deepEqual(events, [
      { work_item_id: 'w-done', actor_id: 'u1', kind: 'action_recorded' },
      { work_item_id: 'w-held', actor_id: 'u1', kind: 'claimed' },
    ], 'a contribution made before the upgrade still counts after it');
    const users = (db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(users.includes('demo_workspace_id'));
    db.close();
    // A second boot adds nothing.
    const again = openDatabase(path);
    assert.equal((again.prepare('SELECT COUNT(*) AS n FROM work_events').get() as { n: number }).n, 2);
    again.close();
  } finally { cleanup(); }
});

test('015 turns a single-instance database into organizations: top units found them, operators run the platform, leaders own them', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const { path, cleanup } = atVersion(14, (db) => {
    // The shape before organizations: no org columns, an instance-wide roster and schedules.
    for (const [table, column] of [['units', 'org_id'], ['member_roles', 'expires_at'], ['audit_log', 'org_id'], ['legal_holds', 'org_id'], ['disposition_runs', 'org_id'], ['personnel_sync_runs', 'org_id']]) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    db.exec('DROP TABLE personnel_roster');
    db.exec(`CREATE TABLE personnel_roster (edipi TEXT PRIMARY KEY, last_name TEXT NOT NULL, first_name TEXT NOT NULL, middle_initial TEXT, rank_id TEXT, mos TEXT, eas TEXT,
      unit_code TEXT, billet TEXT, status TEXT NOT NULL DEFAULT 'active', source TEXT NOT NULL, row_hash TEXT NOT NULL, synced_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, removed_units TEXT)`);
    db.exec('DROP TABLE retention_schedules');
    db.exec(`CREATE TABLE retention_schedules (id TEXT PRIMARY KEY, record_type TEXT NOT NULL UNIQUE, retain_days INTEGER NOT NULL, disposition TEXT NOT NULL,
      authority TEXT, notes TEXT, enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    const user = db.prepare('INSERT INTO users (id, username, password_hash, first_name, last_name, is_operator, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    user.run('u-op', 'operator', 'x', 'Op', 'Erator', 1, at, at);
    user.run('u-lead', 'leader', 'x', 'Lea', 'Der', 0, at, at);
    const unit = db.prepare('INSERT INTO units (id, code, name, parent_id, owner_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    unit.run('G8', 'G8', 'G-8 Comptroller', null, 'u-lead', at);
    unit.run('T1', 'T1', 'Budget', 'G8', null, at);
    unit.run('OTHER', 'OTHER', 'Another command', null, null, '2026-02-01T00:00:00.000Z');
    db.prepare("INSERT INTO personnel_roster (edipi, last_name, first_name, status, source, row_hash, synced_at, created_at, updated_at) VALUES ('1234567890', 'Doe', 'Pat', 'active', 'MCTFS', 'h', ?, ?, ?)").run(at, at, at);
    db.prepare("INSERT INTO retention_schedules (id, record_type, retain_days, disposition, created_at, updated_at) VALUES ('s1', 'activities', 365, 'destroy', ?, ?)").run(at, at);
    db.prepare("INSERT INTO legal_holds (id, scope, reason, placed_by, placed_at) VALUES ('h1', 'instance', 'IG inquiry', 'u-op', ?)").run(at);
  });
  try {
    const db = openDatabase(path);
    const orgs = db.prepare('SELECT id, slug, root_unit_id, status FROM organizations ORDER BY id').all();
    assert.deepEqual(orgs.map((o) => ({ ...(o as object) })), [
      { id: 'G8', slug: 'G8', root_unit_id: 'G8', status: 'active' },
      { id: 'OTHER', slug: 'OTHER', root_unit_id: 'OTHER', status: 'active' },
    ]);
    const orgOf = (id: string) => (db.prepare('SELECT org_id FROM units WHERE id = ?').get(id) as { org_id: string }).org_id;
    assert.equal(orgOf('T1'), 'G8', 'a unit belongs to the organization at the top of its tree');
    assert.deepEqual(db.prepare('SELECT user_id, role FROM platform_roles').all().map((r) => ({ ...(r as object) })), [{ user_id: 'u-op', role: 'owner' }], 'the operator runs the platform');
    const owners = db.prepare("SELECT org_id, user_id FROM org_roles WHERE role = 'owner' ORDER BY org_id").all().map((r) => ({ ...(r as object) }));
    assert.deepEqual(owners, [{ org_id: 'G8', user_id: 'u-lead' }, { org_id: 'OTHER', user_id: 'u-op' }], 'a led command is owned by its leader; an unled one by the former operator, so none is left without');
    assert.equal((db.prepare("SELECT org_id FROM personnel_roster WHERE edipi = '1234567890'").get() as { org_id: string }).org_id, 'G8', 'the instance roster becomes the oldest organization’s');
    assert.equal((db.prepare("SELECT org_id FROM retention_schedules WHERE id = 's1'").get() as { org_id: string }).org_id, 'G8');
    assert.equal((db.prepare("SELECT org_id FROM legal_holds WHERE id = 'h1'").get() as { org_id: string }).org_id, 'G8');

    // From now on the database keeps it so on its own.
    db.prepare("INSERT INTO units (id, code, name, parent_id, created_at) VALUES ('T2', 'T2', 'Disbursing', 'T1', ?)").run(at);
    assert.equal(orgOf('T2'), 'G8', 'a new unit joins its parent’s organization');
    db.prepare("INSERT INTO units (id, code, name, created_at) VALUES ('NEW', 'NEW', 'New command', ?)").run(at);
    assert.equal(orgOf('NEW'), 'NEW', 'a new top unit founds its own');
    assert.ok(db.prepare("SELECT 1 FROM organizations WHERE id = 'NEW'").get());
    assert.throws(() => db.prepare("UPDATE units SET parent_id = 'OTHER' WHERE id = 'T1'").run(), /another organization/, 'and no unit moves between organizations');
    db.close();

    // A second boot changes nothing.
    const again = openDatabase(path);
    assert.equal((again.prepare('SELECT COUNT(*) AS n FROM org_roles').get() as { n: number }).n, 2);
    again.close();
  } finally { cleanup(); }
});

test('017 gives each file the unit its record sits in, keeps every file, and leaves one on an unplaced record without', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const { path, cleanup } = atVersion(16, (db) => {
    // The shape before 017: files that do not say where they were added. An organization and its top unit name each other.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE attachments');
    db.exec(`CREATE TABLE attachments (id TEXT PRIMARY KEY, record_table TEXT NOT NULL, record_id TEXT NOT NULL, uploaded_by TEXT NOT NULL REFERENCES users(id),
      original_name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, content BLOB NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT)`);
    const user = db.prepare('INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    user.run('u-marine', 'marine', 'x', 'Pat', 'Doe', at, at);
    user.run('u-lead', 'leader', 'x', 'Lea', 'Der', at, at);
    db.prepare("INSERT INTO organizations (id, slug, name, status, root_unit_id, settings, created_at, updated_at) VALUES ('G8', 'G8', 'G-8', 'active', 'G8', '{}', ?, ?)").run(at, at);
    const unit = db.prepare('INSERT INTO units (id, code, name, parent_id, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    unit.run('G8', 'G8', 'G-8 Comptroller', null, 'G8', at);
    unit.run('T1', 'T1', 'Budget', 'G8', 'G8', at);
    const entry = db.prepare('INSERT INTO activities (id, user_id, unit_id, visibility, date, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    entry.run('shared', 'u-marine', 'T1', 'unit', '2026-01-01', 'Shared entry', at, at);
    entry.run('unplaced', 'u-marine', null, 'private', '2026-01-01', 'Private entry', at, at);
    const file = db.prepare("INSERT INTO attachments (id, record_table, record_id, uploaded_by, original_name, mime_type, size_bytes, sha256, content, created_at) VALUES (?, 'activities', ?, 'u-lead', ?, 'text/plain', 1, ?, x'00', ?)");
    file.run('f-shared', 'shared', 'evidence.txt', 'h1', at);
    file.run('f-unplaced', 'unplaced', 'note.txt', 'h2', at);
  });
  try {
    const db = openDatabase(path);
    const files = db.prepare('SELECT id, unit_id FROM attachments ORDER BY id').all().map((r) => ({ ...(r as object) }));
    assert.deepEqual(files, [{ id: 'f-shared', unit_id: 'T1' }, { id: 'f-unplaced', unit_id: null }], 'every file is kept; one on a placed record takes its unit');
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    db.close();

    // A second boot changes nothing.
    const again = openDatabase(path);
    assert.deepEqual(again.prepare('SELECT id, unit_id FROM attachments ORDER BY id').all().map((r) => ({ ...(r as object) })), files);
    again.close();
  } finally { cleanup(); }
});

test('020 keeps a Unit Instance’s billets and training requirements inside it, on a database from before them', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const { path, cleanup } = atVersion(19, (db) => {
    // Two Unit Instances, each with its top unit; the configuration tables come from schema.sql, without their triggers.
    // An organization and its top unit name each other.
    db.pragma('foreign_keys = OFF');
    const org = db.prepare("INSERT INTO organizations (id, slug, name, status, root_unit_id, settings, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, '{}', ?, ?)");
    const unit = db.prepare('INSERT INTO units (id, code, name, parent_id, org_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)');
    for (const id of ['G8', 'G1']) { org.run(id, id, id, id, at, at); unit.run(id, id, id, id, at); }
  });
  try {
    const db = openDatabase(path);
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_unit_same_org_%'").all() as Array<{ name: string }>).map((t) => t.name).sort();
    // 024 adds the responsibilities table to the same rule.
    assert.deepEqual(triggers, ['personnel_responsibilities_unit_same_org_insert', 'personnel_responsibilities_unit_same_org_update', 'training_requirements_unit_same_org_insert', 'training_requirements_unit_same_org_update', 'unit_billets_unit_same_org_insert', 'unit_billets_unit_same_org_update']);
    const billet = db.prepare("INSERT INTO unit_billets (id, org_id, unit_id, title, active, created_at, updated_at) VALUES (?, 'G8', ?, ?, 1, ?, ?)");
    billet.run('b-own', 'G8', 'Comptroller', at, at);
    assert.throws(() => billet.run('b-across', 'G1', 'Disbursing Officer', at, at), /cross_instance/, 'a billet never names another Unit Instance’s unit');
    assert.throws(() => db.prepare("UPDATE unit_billets SET unit_id = 'G1' WHERE id = 'b-own'").run(), /cross_instance/);
    assert.throws(() => db.prepare("INSERT INTO training_requirements (id, org_id, unit_id, title, type, active, created_at, updated_at) VALUES ('t-across', 'G8', 'G1', 'Fiscal Law', 'training', 1, ?, ?)").run(at, at), /cross_instance/);
    db.close();
    // A second boot changes nothing.
    const again = openDatabase(path);
    assert.equal((again.prepare('SELECT COUNT(*) AS n FROM unit_billets').get() as { n: number }).n, 1);
    again.close();
  } finally { cleanup(); }
});

test('021 gives each new audit entry a sealed category and makes the log append-only, leaving older entries as they verify', () => {
  const SECRET = 'test-secret-test-secret-test-secret-1234';
  const at = '2026-09-01T00:00:00.000Z';
  const { path, cleanup } = atVersion(20, (db) => {
    // The shape at 20: no category, no append-only triggers, no credential approvals, no Unit Instance on mail.
    db.exec('DROP TABLE credential_approvals');
    db.exec('ALTER TABLE audit_log DROP COLUMN category');
    db.exec('ALTER TABLE email_log DROP COLUMN org_id');
    db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES ('u1', 'avery', 'x', 'Jordan', 'Avery', ?, ?)").run(at, at);
    // A chain written by a build before categories, under the secret (before the chain key, as loadChainKey reads it):
    // an entry without an organization, and one with.
    let previous = '';
    const insert = db.prepare('INSERT INTO audit_log (id, actor_id, action, entity, detail, at, prev_hash, entry_hash, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const rows: Array<[string, string, string | null]> = [['a1', 'login', null], ['a2', 'grant_role', 'G8'], ['a3', 'edit_configuration', null]];
    for (const [id, action, org] of rows) {
      const hash = hmac(SECRET, JSON.stringify([previous, id, 'u1', action, 'probe', null, null, null, 'old', at, null, ...(org ? [org] : [])]));
      insert.run(id, 'u1', action, 'probe', 'old', at, previous || null, hash, org);
      previous = hash;
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('audit_head', ?)").run(JSON.stringify({ hash: previous, count: rows.length, mac: hmac(SECRET, `audit-head:${previous}:${rows.length}`) }));
  });
  const env = {
    ...process.env, NODE_ENV: 'test', VANTAGE_TEST: '1', VANTAGE_DB: path, VANTAGE_EMAIL_PROVIDER: 'memory', VANTAGE_MARADMIN_ENABLED: 'false',
    VANTAGE_SECRET: SECRET, VANTAGE_PUBLIC_URL: 'http://localhost:5173', VANTAGE_OPERATOR: '',
  } as NodeJS.ProcessEnv;
  try {
    const ctx = createContext(loadConfig(env));
    const { db } = ctx;
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    const column = (db.prepare('PRAGMA table_info(audit_log)').all() as Array<{ name: string }>).find((c) => c.name === 'category');
    assert.ok(column, 'audit_log has a category');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_audit_category'").get(), 'and an index to filter by it');
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential_approvals'").get());
    assert.ok((db.prepare('PRAGMA table_info(email_log)').all() as Array<{ name: string }>).some((c) => c.name === 'org_id'), 'mail names the Unit Instance it was sent for');
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'audit_log_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(triggers, ['audit_log_no_delete', 'audit_log_no_update']);
    assert.ok(migrationHistory(db).some((m) => m.id === 21 && m.name === '021_audit_categories_and_append_only'), 'the migration is in the history');

    // Older entries are not backfilled: their hashes never sealed a category, and they still verify.
    assert.deepEqual(db.prepare("SELECT category FROM audit_log WHERE id IN ('a1', 'a2', 'a3')").all().map((r) => (r as { category: null }).category), [null, null, null]);
    assert.equal(verifyAuditChain(ctx).ok, true, JSON.stringify(verifyAuditChain(ctx)));
    // New entries seal theirs and chain on from the old head.
    audit(ctx, { actor_id: 'u1', action: 'grant_role', org_id: 'G8', detail: 'new' });
    audit(ctx, { actor_id: 'u1', action: 'temporary_password', subject_id: 'u1' });
    assert.deepEqual(db.prepare("SELECT category FROM audit_log WHERE id NOT IN ('a1', 'a2', 'a3') ORDER BY seq DESC LIMIT 2").all().map((r) => (r as { category: string }).category), ['enterprise', 'unit']);
    assert.equal(verifyAuditChain(ctx).ok, true);
    assert.throws(() => db.prepare("UPDATE audit_log SET category = 'user' WHERE id = 'a1'").run(), /audit_append_only/, 'nor can an old entry be given one afterwards');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n;
    db.close();

    // Starting again runs nothing twice.
    const again = createContext(loadConfig(env));
    assert.equal(migrationHistory(again.db).filter((m) => m.id === 21).length, 1);
    assert.equal((again.db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n >= count, true);
    assert.equal(verifyAuditChain(again).ok, true);
    assert.deepEqual((again.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'audit_log_%' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name), triggers);
    again.db.close();
  } finally { cleanup(); }
});

test('024 links each membership to the one billet its title names, dates assignments, and writes personnel history from then on', () => {
  const at = '2026-09-01T00:00:00.000Z';
  const { path, cleanup } = atVersion(23, (db) => {
    // The shape at 23: memberships carry a billet title only, and there is no personnel record or history.
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE personnel_events; DROP TABLE personnel_responsibilities; DROP TABLE personnel_records; DROP TABLE unit_members');
    db.exec(`CREATE TABLE unit_members (user_id TEXT NOT NULL REFERENCES users(id), unit_id TEXT NOT NULL REFERENCES units(id), is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
      billet TEXT, joined_at TEXT NOT NULL, invited_by TEXT REFERENCES users(id), PRIMARY KEY (user_id, unit_id))`);
    const org = db.prepare("INSERT INTO organizations (id, slug, name, status, root_unit_id, settings, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, '{}', ?, ?)");
    const unit = db.prepare('INSERT INTO units (id, code, name, parent_id, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const id of ['G8', 'G1']) { org.run(id, id, id, id, at, at); unit.run(id, id, id, null, id, at); }
    unit.run('BUD', 'BUD', 'Budget', 'G8', 'G8', at);
    const user = db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, rank_id, created_at, updated_at) VALUES (?, ?, 'x', 'Sam', ?, 'LCpl', ?, ?)");
    for (const id of ['u1', 'u2', 'u3', 'u4', 'u5']) user.run(id, id, id, at, at);
    const billet = db.prepare("INSERT INTO unit_billets (id, org_id, unit_id, title, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    billet.run('b-bud', 'G8', 'BUD', 'Budget Analyst', 1, at, at);
    billet.run('b-any', 'G8', null, 'Budget Analyst', 1, at, at);
    billet.run('b-clerk', 'G8', null, 'Disbursing Clerk', 1, at, at);
    billet.run('b-old', 'G8', null, 'Fiscal Chief', 0, at, at);
    const member = db.prepare('INSERT INTO unit_members (user_id, unit_id, is_primary, billet, joined_at) VALUES (?, ?, 1, ?, ?)');
    member.run('u1', 'BUD', ' budget analyst ', at); // its own unit's billet first
    member.run('u2', 'G8', 'Disbursing Clerk', at); // one for every unit
    member.run('u3', 'G8', 'Admin Clerk', at); // on no list: kept as typed
    member.run('u4', 'G8', 'Fiscal Chief', at); // retired: not linked
    member.run('u5', 'G1', 'Disbursing Clerk', at); // another Unit Instance's list: not linked
  });
  try {
    const db = openDatabase(path);
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    assert.ok(migrationHistory(db).some((m) => m.id === 24 && m.name === '024_personnel_records'));
    const columns = (db.prepare('PRAGMA table_info(unit_members)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ['billet_id', 'assignment_start', 'assignment_end']) assert.ok(columns.includes(c), c);
    const links = Object.fromEntries((db.prepare('SELECT user_id, billet_id FROM unit_members ORDER BY user_id').all() as Array<{ user_id: string; billet_id: string | null }>).map((r) => [r.user_id, r.billet_id]));
    assert.deepEqual(links, { u1: 'b-bud', u2: 'b-clerk', u3: null, u4: null, u5: null });
    assert.equal((db.prepare("SELECT billet FROM unit_members WHERE user_id = 'u1'").get() as { billet: string }).billet, ' budget analyst ', 'no title is rewritten');
    for (const t of ['personnel_profile_changed', 'personnel_record_opened', 'personnel_record_changed', 'personnel_assignment_dated', 'unit_members_billet_same_org_insert', 'personnel_records_supervisor_same_org_insert']) {
      assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(t), t);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(instanceBoundaryViolations(db)).filter(([, n]) => n)), {});
    // History is written from now on, by whatever writes.
    db.prepare("UPDATE users SET rank_id = 'Cpl' WHERE id = 'u1'").run();
    db.prepare("UPDATE unit_members SET assignment_end = '2027-06-30' WHERE user_id = 'u1'").run();
    db.prepare("INSERT INTO personnel_records (org_id, user_id, supervisor_id, checked_in_on, updated_at) VALUES ('G8', 'u1', 'u2', '2026-09-02', ?)").run(at);
    const written = (db.prepare("SELECT field, from_value, to_value, org_id, unit_id FROM personnel_events WHERE user_id = 'u1' ORDER BY id").all() as Array<Record<string, unknown>>).map((r) => ({ ...r }));
    assert.deepEqual(written, [
      { field: 'rank', from_value: 'LCpl', to_value: 'Cpl', org_id: null, unit_id: null },
      { field: 'assignment_end', from_value: null, to_value: '2027-06-30', org_id: 'G8', unit_id: 'BUD' },
      { field: 'supervisor', from_value: null, to_value: 'u2', org_id: 'G8', unit_id: null },
      { field: 'checked_in', from_value: null, to_value: '2026-09-02', org_id: 'G8', unit_id: null },
    ]);
    assert.throws(() => db.prepare("UPDATE unit_members SET billet_id = 'b-clerk' WHERE user_id = 'u5'").run(), /cross_instance/);
    db.close();
    // A second boot changes nothing.
    const again = openDatabase(path);
    assert.equal(migrationHistory(again).filter((m) => m.id === 24).length, 1);
    assert.equal((again.prepare('SELECT COUNT(*) AS n FROM personnel_events').get() as { n: number }).n, 4);
    again.close();
  } finally { cleanup(); }
});

test('025 records the dates a membership starts with, and keeps a billet from being narrowed under its holders', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const { path, cleanup } = atVersion(24, (db) => {
    db.pragma('foreign_keys = OFF');
    const org = db.prepare("INSERT INTO organizations (id, slug, name, status, root_unit_id, settings, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, '{}', ?, ?)");
    const unit = db.prepare('INSERT INTO units (id, code, name, parent_id, org_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    org.run('G8', 'G8', 'G8', 'G8', at, at); unit.run('G8', 'G8', 'G8', null, 'G8', at);
    unit.run('BUD', 'BUD', 'Budget', 'G8', 'G8', at); unit.run('DSB', 'DSB', 'Disbursing', 'G8', 'G8', at);
    const user = db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES (?, ?, 'x', 'Sam', ?, ?, ?)");
    for (const id of ['u1', 'u2']) user.run(id, id, id, at, at);
    db.prepare("INSERT INTO unit_billets (id, org_id, unit_id, title, active, created_at, updated_at) VALUES ('b-clerk', 'G8', NULL, 'Clerk', 1, ?, ?)").run(at, at);
    db.prepare("INSERT INTO unit_members (user_id, unit_id, is_primary, billet, billet_id, joined_at) VALUES ('u1', 'BUD', 1, 'Clerk', 'b-clerk', ?)").run(at);
  });
  try {
    const db = openDatabase(path);
    assert.ok(migrationHistory(db).some((m) => m.id === 25 && m.name === '025_personnel_guards'));
    for (const t of ['personnel_assignment_opened', 'unit_billets_holders_fit']) assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(t), t);
    // A membership a script creates with its dates leaves them in the history; one without dates leaves nothing.
    db.prepare("INSERT INTO unit_members (user_id, unit_id, is_primary, assignment_start, assignment_end, joined_at) VALUES ('u2', 'DSB', 1, '2026-10-01', '2029-09-30', ?)").run(at);
    db.prepare("INSERT INTO unit_members (user_id, unit_id, is_primary, joined_at) VALUES ('u2', 'BUD', 0, ?)").run(at);
    assert.deepEqual((db.prepare("SELECT field, from_value, to_value, org_id, unit_id FROM personnel_events WHERE user_id = 'u2' ORDER BY id").all() as Array<Record<string, unknown>>).map((r) => ({ ...r })), [
      { field: 'assignment_start', from_value: null, to_value: '2026-10-01', org_id: 'G8', unit_id: 'DSB' },
      { field: 'assignment_end', from_value: null, to_value: '2029-09-30', org_id: 'G8', unit_id: 'DSB' },
    ]);
    // The clerk billet is held in Budget: it can be narrowed to Budget, not to Disbursing, and widened again.
    assert.throws(() => db.prepare("UPDATE unit_billets SET unit_id = 'DSB' WHERE id = 'b-clerk'").run(), /billet_held/);
    db.prepare("UPDATE unit_billets SET unit_id = 'BUD' WHERE id = 'b-clerk'").run();
    assert.throws(() => db.prepare("UPDATE unit_billets SET unit_id = 'DSB' WHERE id = 'b-clerk'").run(), /billet_held/);
    db.prepare("UPDATE unit_billets SET unit_id = NULL WHERE id = 'b-clerk'").run();
    db.close();
  } finally { cleanup(); }
});

test('026 gives activities and training an end, times and ongoing, keeps what was out of order and counts it, and refuses more', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const { path, cleanup } = atVersion(25, (db) => {
    // The tables as they were before 026.
    for (const table of ['activities', 'trainings']) for (const column of ['end_date', 'start_time', 'end_time', 'ongoing']) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    db.exec('ALTER TABLE awards DROP COLUMN period_start');
    db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES ('u1', 'u1', 'x', 'Sam', 'Marine', ?, ?)").run(at, at);
    db.prepare("INSERT INTO activities (id, user_id, title, date, created_at, updated_at) VALUES ('a1', 'u1', 'Reconciled ULOs', '2026-05-01', ?, ?)").run(at, at);
    db.prepare("INSERT INTO trainings (id, user_id, title, date, created_at, updated_at) VALUES ('t1', 'u1', 'Corporals Course', '2026-03-13', ?, ?)").run(at, at);
    db.prepare("INSERT INTO awards (id, user_id, name, date, created_at, updated_at) VALUES ('w1', 'u1', 'NAM', '2026-06-30', ?, ?)").run(at, at);
    // A goal whose deadline was typed before its start, and a project in order.
    db.prepare("INSERT INTO goals (id, user_id, title, period_start, period_end, created_at, updated_at) VALUES ('g1', 'u1', 'PFT 270', '2026-09-01', '2026-06-30', ?, ?)").run(at, at);
    db.prepare("INSERT INTO projects (id, user_id, name, start_date, target_date, created_at, updated_at) VALUES ('p1', 'u1', 'Q4 UMT', '2026-10-01', '2026-12-31', ?, ?)").run(at, at);
  });
  try {
    const db = openDatabase(path);
    assert.ok(migrationHistory(db).some((m) => m.id === 26 && m.name === '026_record_timeframes'));
    const columns = (table: string) => (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const table of ['activities', 'trainings']) for (const column of ['end_date', 'start_time', 'end_time', 'ongoing']) assert.ok(columns(table).includes(column), `${table}.${column}`);
    assert.ok(columns('awards').includes('period_start'));
    // Every entry already written is the single day it was, not going on, an award its date alone.
    assert.deepEqual({ ...(db.prepare("SELECT date, end_date, start_time, end_time, ongoing FROM activities WHERE id = 'a1'").get() as object) }, { date: '2026-05-01', end_date: null, start_time: null, end_time: null, ongoing: 0 });
    assert.deepEqual({ ...(db.prepare("SELECT date, ongoing FROM trainings WHERE id = 't1'").get() as object) }, { date: '2026-03-13', ongoing: 0 });
    assert.deepEqual({ ...(db.prepare("SELECT period_start, date FROM awards WHERE id = 'w1'").get() as object) }, { period_start: null, date: '2026-06-30' });
    // The goal out of order is kept as it was, and counted.
    assert.deepEqual({ ...(db.prepare("SELECT period_start, period_end FROM goals WHERE id = 'g1'").get() as object) }, { period_start: '2026-09-01', period_end: '2026-06-30' });
    const counted = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'timeframe_violations'").get() as { value: string }).value);
    assert.deepEqual(counted.found, { goals: 1 });
    // From here, nothing is written out of order, on any record type; a change that leaves the dates alone still is.
    const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%_timeframe_%'").all() as Array<{ name: string }>).map((t) => t.name);
    // 031 adds duty to the same rule (ADR-0023).
    assert.equal(triggers.length, 16, triggers.join(', '));
    assert.ok(triggers.includes('duties_timeframe_written') && triggers.includes('duties_timeframe_changed'));
    db.prepare("UPDATE goals SET title = 'PFT 275' WHERE id = 'g1'").run();
    assert.throws(() => db.prepare("UPDATE goals SET period_end = '2026-07-31' WHERE id = 'g1'").run(), /timeframe: a record in goals/);
    db.prepare("UPDATE goals SET period_end = '2026-12-31' WHERE id = 'g1'").run();
    assert.throws(() => db.prepare("UPDATE projects SET target_date = '2026-09-30' WHERE id = 'p1'").run(), /timeframe:/);
    assert.throws(() => db.prepare("UPDATE activities SET end_date = '2026-04-30' WHERE id = 'a1'").run(), /timeframe:/);
    assert.throws(() => db.prepare("UPDATE trainings SET start_time = '7:30' WHERE id = 't1'").run(), /CHECK constraint/, 'a time is kept as HH:MM');
    db.prepare("UPDATE trainings SET start_time = '07:30', end_date = '2026-03-14' WHERE id = 't1'").run();
    db.close();
  } finally { cleanup(); }
});

test('029 adds error reports, empty, and keeps a report, its type and its file in one Unit Instance from the start', () => {
  const { path, cleanup } = atVersion(28, (db) => {
    // The database as it was before 029: no error report tables.
    for (const table of ['error_snapshot_rows', 'error_snapshots', 'error_report_types']) db.exec(`DROP TABLE ${table}`);
  });
  try {
    let db = openDatabase(path);
    const trail = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name LIKE 'error_%' OR name LIKE '%snapshots%') ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    assert.ok(migrationHistory(db).some((m) => m.id === 29 && m.name === '029_error_report_snapshots'));
    for (const table of ['error_report_types', 'error_snapshots', 'error_snapshot_rows']) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, `${table} starts empty: the standard types are given when a Unit Instance first opens its error reports`);
    }
    const triggers = trail();
    for (const name of ['error_snapshots_same_org', 'error_report_types_snapshots_same_org', 'source_files_snapshots_same_org', 'error_snapshots_filed', 'error_snapshots_withdrawn', 'error_snapshots_append_only_delete']) {
      assert.ok(triggers.includes(name), name);
    }
    assert.deepEqual(instanceBoundaryViolations(db), {});
    db.close();
    // A second boot changes nothing.
    db = openDatabase(path);
    assert.deepEqual(trail(), triggers);
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    db.close();
  } finally { cleanup(); }
});

test('030 adds guidance on file for the case diagnoser, empty, kept in one Unit Instance and never edited or removed', () => {
  const { path, cleanup } = atVersion(29, (db) => {
    // The database as it was before 030: no guidance on file.
    db.exec('DROP TABLE case_guidance');
  });
  try {
    let db = openDatabase(path);
    const trail = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = 'case_guidance' OR name LIKE '%guidance%') ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    assert.ok(migrationHistory(db).some((m) => m.id === 30 && m.name === '030_case_guidance'));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM case_guidance').get() as { n: number }).n, 0, 'nothing is on file until somebody puts it there: Vantage keeps no policy of its own');
    const triggers = trail();
    for (const name of ['case_guidance_same_org', 'work_items_guidance_same_org', 'case_guidance_recorded', 'case_guidance_retired', 'case_guidance_append_only_delete']) {
      assert.ok(triggers.includes(name), name);
    }
    assert.deepEqual(instanceBoundaryViolations(db), {});
    db.close();
    // A second boot changes nothing.
    db = openDatabase(path);
    assert.deepEqual(trail(), triggers);
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    db.close();
  } finally { cleanup(); }
});

test('031 adds duty records, empty, widens the move history to name duty with every row kept in order, and keeps duty in one Unit Instance', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const { path, cleanup } = atVersion(30, (db) => {
    // The database as it was before 031: no duty records, and a move history that names three record types.
    db.exec('DROP TABLE duties');
    const lineage = /CREATE TABLE IF NOT EXISTS record_lineage \([\s\S]*?\n\);/.exec(readFileSync(new URL('../../server/db/schema.sql', import.meta.url), 'utf8'))![0];
    db.exec('DROP TABLE record_lineage');
    db.exec(lineage.replaceAll(", 'duties')", ')'));
    assert.ok(!(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'record_lineage'").get() as { sql: string }).sql.includes('duties'));
    for (const index of ['CREATE INDEX idx_record_lineage_to ON record_lineage(to_table, to_id, at)', 'CREATE INDEX idx_record_lineage_from ON record_lineage(from_table, from_id)']) db.exec(index);
    // Two Unit Instances, each with its top unit; an organization and its top unit name each other.
    db.pragma('foreign_keys = OFF');
    const org = db.prepare("INSERT INTO organizations (id, slug, name, status, root_unit_id, settings, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, '{}', ?, ?)");
    const unit = db.prepare('INSERT INTO units (id, code, name, parent_id, org_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)');
    for (const id of ['G8', 'G1']) { org.run(id, id, id, id, at, at); unit.run(id, id, id, id, at); }
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES ('u1', 'u1', 'x', 'Sam', 'Marine', ?, ?)").run(at, at);
    const move = db.prepare("INSERT INTO record_lineage (rowid, id, user_id, unit_id, from_table, from_id, to_table, to_id, snapshot, method, moved_by, at) VALUES (?, ?, 'u1', 'G8', ?, ?, ?, ?, '{}', ?, 'u1', ?)");
    move.run(7, 'l1', 'activities', 'a1', 'awards', 'w1', 'move', at);
    move.run(3, 'l2', 'awards', 'w1', 'activities', 'a1', 'undo', at);
    db.prepare("INSERT INTO duty_types (id, org_id, code, name, active, created_at, updated_at) VALUES ('t8', 'G8', 'DNCO', 'Duty NCO', 1, ?, ?), ('t1', 'G1', 'DNCO', 'Duty NCO', 1, ?, ?)").run(at, at, at, at);
  });
  try {
    let db = openDatabase(path);
    assert.ok(migrationHistory(db).some((m) => m.id === 31 && m.name === '031_duty_records'));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM duties').get() as { n: number }).n, 0, 'nothing moves to duty on an upgrade (John, 2026-10-17)');
    const lineageSql = () => (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'record_lineage'").get() as { sql: string }).sql;
    assert.match(lineageSql(), /'duties'/);
    assert.deepEqual(db.prepare('SELECT rowid AS r, id, from_table, to_table, method FROM record_lineage ORDER BY rowid').all().map((r) => ({ ...(r as object) })),
      [{ r: 3, id: 'l2', from_table: 'awards', to_table: 'activities', method: 'undo' }, { r: 7, id: 'l1', from_table: 'activities', to_table: 'awards', method: 'move' }], 'every row, with its order');
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'record_lineage' AND name LIKE 'idx_%' ORDER BY name").all() as Array<{ name: string }>).map((i) => i.name);
    assert.deepEqual(indexes, ['idx_record_lineage_from', 'idx_record_lineage_to', 'idx_record_lineage_user']);
    db.prepare("INSERT INTO record_lineage (id, user_id, unit_id, from_table, from_id, to_table, to_id, snapshot, method, moved_by, at) VALUES ('l3', 'u1', 'G8', 'activities', 'a2', 'duties', 'd1', '{}', 'move', 'u1', ?)").run(at);
    assert.throws(() => db.prepare("INSERT INTO record_lineage (id, user_id, from_table, from_id, to_table, to_id, snapshot, method, moved_by, at) VALUES ('l4', 'u1', 'activities', 'a3', 'tasks', 't9', '{}', 'move', 'u1', ?)").run(at), /CHECK constraint/);

    const triggers = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = 'duties' OR name LIKE 'duty_types_duties%') ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    const found = triggers();
    for (const name of ['duties_same_org_insert', 'duties_same_org_update', 'duty_types_duties_same_org', 'duties_timeframe_written', 'duties_timeframe_changed']) assert.ok(found.includes(name), name);
    const duty = db.prepare("INSERT INTO duties (id, user_id, unit_id, duty_type_id, date, start_time, end_date, end_time, hours, days, submitted_at, created_at, updated_at) VALUES (?, 'u1', 'G8', ?, '2026-09-01', '08:00', ?, '16:00', 8, 1, ?, ?, ?)");
    duty.run('d1', 't8', '2026-09-01', at, at, at);
    assert.throws(() => duty.run('d2', 't1', '2026-09-01', at, at, at), /cross_instance/, 'a G-1 type on G-8 duty');
    assert.throws(() => duty.run('d3', 't8', '2026-08-31', at, at, at), /timeframe:/, 'it ends after it begins');
    assert.deepEqual(instanceBoundaryViolations(db), {});
    db.close();
    // A second boot changes nothing.
    db = openDatabase(path);
    assert.deepEqual(triggers(), found);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM record_lineage').get() as { n: number }).n, 3);
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    db.close();
  } finally { cleanup(); }
});

test('032 gives duty its override columns and review history, hands the standard SNCO and SNCOIC roles the review permissions they could already use, and changes no duty', () => {
  const at = '2026-11-01T00:00:00.000Z';
  const WAS = { snco: 0, sncoic: 0 };
  const { path, cleanup } = atVersion(31, (db) => {
    // The database as it was before 032: duty with no override columns, no review history and no index for the queue.
    db.exec('DROP TABLE duty_reviews');
    db.exec('DROP INDEX idx_duties_review');
    for (const column of ['points_overridden_at', 'points_overridden_by', 'points_override_reason']) db.exec(`ALTER TABLE duties DROP COLUMN ${column}`);
    assert.ok(!(db.prepare('PRAGMA table_info(duties)').all() as Array<{ name: string }>).some((c) => c.name.startsWith('points_over')));
    db.pragma('foreign_keys = OFF');
    const org = db.prepare("INSERT INTO organizations (id, slug, name, status, root_unit_id, settings, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, '{}', ?, ?)");
    const unit = db.prepare('INSERT INTO units (id, code, name, parent_id, org_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)');
    for (const id of ['G8', 'G1']) { org.run(id, id, id, id, at, at); unit.run(id, id, id, id, at); }
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES ('u1', 'u1', 'x', 'Sam', 'Marine', ?, ?), ('u2', 'u2', 'x', 'Lee', 'Reviewer', ?, ?)").run(at, at, at, at);
    // The standard roles as Vantage seeded them before 032, and what units have made of them since.
    const P = PERMISSIONS;
    const fire = P.VIEW_UNIT | P.VIEW_RECORDS | P.VIEW_MEMBER_DETAIL | P.COUNSEL | P.EDIT_WORK;
    WAS.snco = fire | P.MANAGE_RECORDS | P.VIEW_AUDIT | P.EXPORT_DATA | P.REASSIGN_WORK;
    WAS.sncoic = WAS.snco | P.MANAGE_MEMBERS | P.MANAGE_ROLES | P.MANAGE_UNITS;
    const role = db.prepare('INSERT INTO roles (id, unit_id, key, name, permissions, position, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    role.run('g8-marine', 'G8', 'marine', 'Marine', P.VIEW_UNIT, 0, 1, at);
    role.run('g8-ftl', 'G8', 'fire-team-leader', 'Fire Team Leader', fire, 30, 1, at);
    role.run('g8-snco', 'G8', 'snco', 'SNCO', WAS.snco, 40, 1, at);
    role.run('g8-sncoic', 'G8', 'sncoic', 'SNCOIC', WAS.sncoic, 60, 1, at);
    role.run('g8-leader', 'G8', 'unit-leader', 'Unit Leader', P.ADMINISTRATOR, 100, 1, at);
    // G-1 cut its standard roles back: its SNCO no longer counsels, and its SNCOIC no longer corrects others' records.
    role.run('g1-snco', 'G1', 'snco', 'SNCO', WAS.snco & ~P.COUNSEL, 40, 1, at);
    role.run('g1-sncoic', 'G1', 'sncoic', 'SNCOIC', WAS.sncoic & ~P.MANAGE_RECORDS, 60, 1, at);
    // A role a unit made itself, with everything an SNCO has: it is the unit's to change.
    role.run('g8-own', 'G8', null, 'Admin Chief', WAS.sncoic, 50, 0, at);
    role.run('g8-own-keyed', 'G8', 'snco', 'A copy somebody named snco', WAS.snco, 45, 0, at);
    db.prepare("INSERT INTO duty_types (id, org_id, code, name, active, created_at, updated_at) VALUES ('t8', 'G8', 'DNCO', 'Duty NCO', 1, ?, ?)").run(at, at);
    db.prepare("INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES ('p8', 'G8', 1, '2026-01-01', '{}', 'First', 'u2', ?)").run(at);
    const duty = db.prepare(`INSERT INTO duties (id, user_id, unit_id, duty_type_id, date, start_time, end_date, end_time, hours, days, submitted_at, approval_status, reviewed_by, reviewed_at, review_reason, approved_points,
      scoring_policy_id, scoring_version, calculated_points, version, created_at, updated_at) VALUES (?, 'u1', 'G8', 't8', ?, '08:00', ?, '16:00', 8, 1, ?, ?, ?, ?, ?, ?, 'p8', 1, 3, ?, ?, ?)`);
    duty.run('d-wait', '2026-09-01', '2026-09-01', at, 'pending', null, null, null, null, 1, at, at);
    // Decided by hand before there was a review: it stays exactly as it was.
    duty.run('d-ok', '2026-09-02', '2026-09-02', at, 'approved', 'u2', at, null, 7, 4, at, at);
    duty.run('d-no', '2026-09-03', '2026-09-03', at, 'rejected', 'u2', at, 'Not on the roster.', null, 2, at, at);
  });
  try {
    let db = openDatabase(path);
    assert.ok(migrationHistory(db).some((m) => m.id === 32 && m.name === '032_duty_review'));
    const columns = (db.prepare('PRAGMA table_info(duties)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(columns.slice(-3), ['points_override_reason', 'points_overridden_by', 'points_overridden_at'], 'added last, in the order a new database has them');
    const fresh = new Database(':memory:');
    fresh.exec(readFileSync(new URL('../../server/db/schema.sql', import.meta.url), 'utf8'));
    assert.deepEqual(columns, (fresh.prepare('PRAGMA table_info(duties)').all() as Array<{ name: string }>).map((c) => c.name), 'an upgraded database and a new one have the same duty columns in the same order');
    fresh.close();
    assert.ok((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_duties_review'").get()));

    // No duty is changed: not its status, its points, the version it was scored under, or its edit version.
    const duties = db.prepare('SELECT id, approval_status, approved_points, calculated_points, scoring_version, scoring_policy_id, reviewed_by, review_reason, version, points_override_reason, points_overridden_by, points_overridden_at FROM duties ORDER BY id').all().map((r) => ({ ...(r as object) }));
    const untouched = { calculated_points: 3, scoring_version: 1, scoring_policy_id: 'p8', points_override_reason: null, points_overridden_by: null, points_overridden_at: null };
    assert.deepEqual(duties, [
      { id: 'd-no', approval_status: 'rejected', approved_points: null, reviewed_by: 'u2', review_reason: 'Not on the roster.', version: 2, ...untouched },
      { id: 'd-ok', approval_status: 'approved', approved_points: 7, reviewed_by: 'u2', review_reason: null, version: 4, ...untouched },
      { id: 'd-wait', approval_status: 'pending', approved_points: null, reviewed_by: null, review_reason: null, version: 1, ...untouched },
    ].map((d) => Object.fromEntries(Object.keys(duties[0]).map((k) => [k, (d as Record<string, unknown>)[k]]))));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM duty_reviews').get() as { n: number }).n, 0, 'no history is made up for what was decided before');

    // The standard roles: what the template now gives them, and only where the role could already do that work.
    const bits = (id: string) => (db.prepare('SELECT permissions FROM roles WHERE id = ?').get(id) as { permissions: number }).permissions;
    const P = PERMISSIONS;
    assert.equal(bits('g8-snco'), WAS.snco | P.REVIEW_DUTY, 'the SNCO reviews duty');
    assert.equal(bits('g8-sncoic'), WAS.sncoic | P.REVIEW_DUTY | P.OVERRIDE_DUTY_POINTS, 'the SNCOIC reviews it and may set its points');
    assert.equal(bits('g1-snco'), WAS.snco & ~P.COUNSEL, 'an SNCO role cut back from counseling gains nothing');
    assert.equal(bits('g1-sncoic'), (WAS.sncoic & ~P.MANAGE_RECORDS) | P.REVIEW_DUTY, 'an SNCOIC role that no longer corrects records reviews, and does not override');
    assert.equal(bits('g8-own'), WAS.sncoic, 'a role the unit made is the unit’s to change');
    assert.equal(bits('g8-own-keyed'), WAS.snco, 'whatever it is called');
    assert.equal(bits('g8-marine'), P.VIEW_UNIT);
    assert.equal(bits('g8-ftl') & (P.REVIEW_DUTY | P.OVERRIDE_DUTY_POINTS), 0, 'a fire team leader does not review');
    assert.equal(bits('g8-leader'), P.ADMINISTRATOR);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM roles WHERE permissions & ? != 0').get(P.APPROVE_OWN_DUTY) as { n: number }).n, 0, 'no role is given approval of one’s own duty');

    // The check a new database has is on the upgraded one: an override is whole, and only on approved duty.
    const now = '2026-11-02T00:00:00.000Z';
    assert.throws(() => db.prepare("UPDATE duties SET points_overridden_at = ? WHERE id = 'd-ok'").run(now), /CHECK constraint/);
    assert.throws(() => db.prepare("UPDATE duties SET points_overridden_at = ?, points_overridden_by = 'u2', points_override_reason = 'x' WHERE id = 'd-wait'").run(now), /CHECK constraint/);
    db.prepare("UPDATE duties SET approved_points = 5, points_overridden_at = ?, points_overridden_by = 'u2', points_override_reason = 'Short notice.' WHERE id = 'd-ok'").run(now);

    // The review history, kept as written and inside its duty's Unit Instance.
    const triggers = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND (tbl_name = 'duty_reviews' OR name = 'duties_reviews_same_org') ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    const found = triggers();
    assert.deepEqual(found, ['duties_reviews_same_org', 'duty_reviews_reason_kept', 'duty_reviews_recorded', 'duty_reviews_same_org_insert']);
    const line = db.prepare("INSERT INTO duty_reviews (id, duty_id, unit_id, actor_id, event, from_status, to_status, reason, calculated_points, approved_points, scoring_version, override, by_owner, created_at) VALUES (?, 'd-ok', ?, 'u2', 'points_changed', 'approved', 'approved', 'Short notice.', 3, 5, 1, 1, 0, ?)");
    line.run('v1', 'G8', now);
    assert.throws(() => line.run('v2', 'G1', now), /cross_instance/, 'a review in another Unit Instance than its duty');
    assert.throws(() => db.prepare("UPDATE duty_reviews SET approved_points = 9 WHERE id = 'v1'").run(), /kept as it was written/);
    assert.throws(() => db.prepare("UPDATE duties SET unit_id = 'G1' WHERE id = 'd-ok'").run(), /cross_instance/, 'reviewed duty stays in its Unit Instance');
    assert.deepEqual(instanceBoundaryViolations(db), {});
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    // A unit that takes the permission out of its SNCO role afterwards is not handed it again: the migration runs once.
    db.prepare("UPDATE roles SET permissions = permissions & ? WHERE id = 'g8-snco'").run(~P.REVIEW_DUTY);
    db.close();

    db = openDatabase(path);
    assert.equal(bits('g8-snco'), WAS.snco, 'a second boot does not hand it back');
    assert.equal(bits('g8-sncoic'), WAS.sncoic | P.REVIEW_DUTY | P.OVERRIDE_DUTY_POINTS);
    assert.deepEqual(triggers(), found);
    assert.deepEqual((db.prepare('PRAGMA table_info(duties)').all() as Array<{ name: string }>).map((c) => c.name), columns);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM duty_reviews').get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT approved_points FROM duties WHERE id = 'd-ok'").get() as { approved_points: number }).approved_points, 5);
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    db.close();
  } finally { cleanup(); }
});

test('033 gives a file its evidence type and description, empty on every file already attached, and changes no file', () => {
  const at = '2026-11-01T00:00:00.000Z';
  const KEPT = 'id, record_table, record_id, uploaded_by, unit_id, original_name, mime_type, size_bytes, sha256, hex(content) AS content, created_at, deleted_at';
  let before: unknown[] = [];
  const { path, cleanup } = atVersion(32, (db) => {
    // The database as it was before 033: files that do not say what they are evidence of.
    for (const column of ['description', 'kind']) db.exec(`ALTER TABLE attachments DROP COLUMN ${column}`);
    const had = (db.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!had.includes('kind') && !had.includes('description'));
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO organizations (id, slug, name, status, root_unit_id, settings, created_at, updated_at) VALUES ('G8', 'G8', 'G-8', 'active', 'G8', '{}', ?, ?)").run(at, at);
    db.prepare("INSERT INTO units (id, code, name, parent_id, org_id, created_at) VALUES ('G8', 'G8', 'G-8 Comptroller', NULL, 'G8', ?)").run(at);
    db.pragma('foreign_keys = ON');
    db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES ('u1', 'u1', 'x', 'Ana', 'Diaz', ?, ?)").run(at, at);
    db.prepare("INSERT INTO trainings (id, user_id, unit_id, visibility, date, title, created_at, updated_at) VALUES ('t1', 'u1', 'G8', 'unit', '2026-05-01', 'Corporals Course', ?, ?)").run(at, at);
    db.prepare("INSERT INTO activities (id, user_id, unit_id, visibility, date, title, created_at, updated_at) VALUES ('a1', 'u1', NULL, 'private', '2026-05-02', 'Private entry', ?, ?)").run(at, at);
    const file = db.prepare('INSERT INTO attachments (id, record_table, record_id, uploaded_by, unit_id, original_name, mime_type, size_bytes, sha256, content, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    // A certificate whose name says so: its type is still not guessed.
    file.run('f-cert', 'trainings', 't1', 'u1', 'G8', 'certificate.pdf', 'application/pdf', 9, 'h1', Buffer.from('%PDF-1.7\n'), at, null);
    file.run('f-note', 'activities', 'a1', 'u1', null, 'roster.txt', 'text/plain', 4, 'h2', Buffer.from('note'), at, null);
    // One in the recycle bin keeps its place there.
    file.run('f-gone', 'trainings', 't1', 'u1', 'G8', 'transcript.pdf', 'application/pdf', 9, 'h3', Buffer.from('%PDF-1.4\n'), at, at);
    before = db.prepare(`SELECT ${KEPT} FROM attachments ORDER BY id`).all().map((r) => ({ ...(r as object) }));
  });
  try {
    let db = openDatabase(path);
    assert.ok(migrationHistory(db).some((m) => m.id === 33 && m.name === '033_attachment_evidence'));
    const columns = (db.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(columns.slice(-2), ['kind', 'description'], 'added last, in the order a new database has them');
    const fresh = new Database(':memory:');
    fresh.exec(readFileSync(new URL('../../server/db/schema.sql', import.meta.url), 'utf8'));
    assert.deepEqual(columns, (fresh.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>).map((c) => c.name), 'an upgraded database and a new one have the same file columns in the same order');
    fresh.close();

    // Every file is kept exactly as it was, and none is given a type or a description it never had.
    assert.deepEqual(db.prepare(`SELECT ${KEPT} FROM attachments ORDER BY id`).all().map((r) => ({ ...(r as object) })), before);
    assert.equal(before.length, 3);
    assert.deepEqual(db.prepare('SELECT id, kind, description FROM attachments ORDER BY id').all().map((r) => ({ ...(r as object) })),
      ['f-cert', 'f-gone', 'f-note'].map((id) => ({ id, kind: null, description: null })));

    // The checks a new database has are on the upgraded one.
    assert.throws(() => db.prepare("UPDATE attachments SET kind = 'diploma' WHERE id = 'f-cert'").run(), /CHECK constraint/);
    assert.throws(() => db.prepare("UPDATE attachments SET description = ? WHERE id = 'f-cert'").run('x'.repeat(501)), /CHECK constraint/);
    db.prepare("UPDATE attachments SET kind = 'certificate', description = ? WHERE id = 'f-cert'").run('x'.repeat(500));
    // The type is not tied to the record type: a file follows an entry that moves to another one (ADR-0015).
    db.prepare("UPDATE attachments SET kind = 'roster' WHERE id = 'f-note'").run();
    assert.deepEqual(instanceBoundaryViolations(db), {});
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    db.close();

    // A second boot adds nothing and clears nothing.
    db = openDatabase(path);
    assert.equal(migrationHistory(db).filter((m) => m.id === 33).length, 1);
    assert.deepEqual((db.prepare('PRAGMA table_info(attachments)').all() as Array<{ name: string }>).map((c) => c.name), columns);
    assert.deepEqual(db.prepare("SELECT kind, length(description) AS n FROM attachments WHERE id = 'f-cert'").get(), { kind: 'certificate', n: 500 });
    assert.equal((db.prepare("SELECT kind FROM attachments WHERE id = 'f-note'").get() as { kind: string }).kind, 'roster');
    assert.equal(Number((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value), SCHEMA_VERSION);
    assert.equal(SCHEMA_VERSION, 33);
    db.close();
  } finally { cleanup(); }
});
