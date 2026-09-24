import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase, SCHEMA_VERSION } from '../../server/db/index.ts';
import { PERMISSIONS } from '../../shared/permissions.ts';

/**
 * Migrations are the one piece of this codebase that only ever runs against data somebody already
 * has. A `:memory:` test opens an empty database and every migration is a no-op on no rows, which
 * is exactly the case that cannot go wrong. So these build a database that looks like a real
 * instance stopped at the previous version, then open it for real.
 */
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

    // Holding a claim already let you both work a case and close it, so both verbs go to everyone.
    // Granting RESOLVE_WORK only to record-correctors would take closing away from every plain
    // member on deploy, which is the regression this backfill exists to prevent.
    for (const verb of ['CLAIM_WORK', 'RESOLVE_WORK'] as const) {
      assert.ok(bits('r-marine') & PERMISSIONS[verb], `a Marine keeps ${verb}`);
      assert.ok(bits('r-snco') & PERMISSIONS[verb], `an SNCO keeps ${verb}`);
    }

    // The genuinely new verbs — nothing could edit a row's own fields or hand a case over before —
    // go only to whoever could already correct records.
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

test('009 adds record details, gives every team the Team Leader and Team Administrator roles, and adds the new kinds to a saved category list', () => {
  const at = '2026-08-01T12:00:00.000Z';
  const { path, cleanup } = atVersion(8, (db) => {
    // A v8 activities table has no details column.
    db.exec('ALTER TABLE activities DROP COLUMN details');
    db.prepare('INSERT INTO units (id, code, name, created_at) VALUES (?, ?, ?, ?)').run('G8', 'G8', 'G-8', at);
    db.prepare('INSERT INTO units (id, code, name, created_at) VALUES (?, ?, ?, ?)').run('BARE', 'BARE', 'No roles yet', at);
    db.prepare('INSERT INTO roles (id, unit_id, key, name, permissions, position, is_system, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)')
      .run('G8:marine', 'G8', 'marine', 'Marine', PERMISSIONS.VIEW_UNIT, at);
    db.prepare("INSERT INTO users (id, username, password_hash, first_name, last_name, created_at, updated_at) VALUES ('u1', 'avery', 'x', 'Jordan', 'Avery', ?, ?)").run(at, at);
    db.prepare("INSERT INTO activities (id, user_id, title, date, created_at, updated_at) VALUES ('a1', 'u1', 'Reconciled 30 ULOs', '2026-07-30', ?, ?)").run(at, at);
    // An instance that saved its own, shorter category list.
    const runtime = { metrics: { categories: [{ name: 'Fiscal & Financial', color: '#1f9d6a' }, { name: 'Other', color: '#54627a' }] } };
    db.prepare("INSERT INTO meta (key, value) VALUES ('runtime', ?)").run(JSON.stringify(runtime));
  });
  try {
    const db = openDatabase(path);
    assert.equal((db.prepare('SELECT details FROM activities WHERE id = ?').get('a1') as { details: string }).details, '{}', 'a record saved before this reads as having no details');
    const leader = db.prepare("SELECT id, permissions, is_default, is_system FROM roles WHERE unit_id = 'G8' AND key = 'team-leader'").get() as { id: string; permissions: number; is_default: number; is_system: number };
    assert.equal(leader.id, 'G8:team-leader');
    assert.ok(leader.permissions & PERMISSIONS.VIEW_MEMBER_DETAIL);
    assert.ok(leader.permissions & PERMISSIONS.MANAGE_MEMBERS);
    assert.equal(leader.permissions & PERMISSIONS.ADMINISTRATOR, 0, 'a team leader is not an administrator');
    assert.equal(leader.is_default, 0);
    assert.equal(leader.is_system, 1);
    const count = (d: Database.Database, sql: string) => (d.prepare(sql).get() as { n: number }).n;
    const admin = db.prepare("SELECT id, permissions, position FROM roles WHERE unit_id = 'G8' AND key = 'team-administrator'").get() as { id: string; permissions: number; position: number };
    assert.equal(admin.id, 'G8:team-administrator');
    assert.equal(admin.permissions, PERMISSIONS.ADMINISTRATOR);
    assert.ok(admin.position < 100, 'a team administrator sits below the team’s owner');
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM roles WHERE unit_id = 'BARE'"), 0, 'a team without system roles gets them when it is set up, not here');
    assert.equal(count(db, 'SELECT COUNT(*) AS n FROM member_roles'), 0, 'nobody is granted the new role by an upgrade');
    const names = JSON.parse((db.prepare("SELECT value FROM meta WHERE key = 'runtime'").get() as { value: string }).value).metrics.categories.map((c: { name: string }) => c.name);
    assert.deepEqual(names, ['Fiscal & Financial', 'Education', 'Certifications & Licenses', 'Extracurricular', 'Physical Fitness', 'Other']);
    db.close();
    // A second boot adds nothing.
    const again = openDatabase(path);
    assert.equal(count(again, "SELECT COUNT(*) AS n FROM roles WHERE key IN ('team-leader', 'team-administrator')"), 2);
    assert.equal(JSON.parse((again.prepare("SELECT value FROM meta WHERE key = 'runtime'").get() as { value: string }).value).metrics.categories.length, 6);
    again.close();
  } finally { cleanup(); }
});
