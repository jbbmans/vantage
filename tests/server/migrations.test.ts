import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, SCHEMA_VERSION } from '../../server/db/index.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';

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
