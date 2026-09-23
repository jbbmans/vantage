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
