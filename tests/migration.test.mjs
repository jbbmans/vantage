/**
 * Migration tests — run against the CAPTURED v3.3.0 database, never a
 * synthetic one (v3.4 Definition of Done).
 *
 * The load-bearing claim under finding 1 is that migration 006 over a real
 * v3.3 database preserves every effective permission every user had before it
 * ran. This suite proves that by replaying an oracle — tests/fixtures/
 * v3_3_0.snapshot.json — captured by calling v3.3.0's own permissionsIn() for
 * every (user, unit) pair, before any v3.4 code existed.
 *
 * There is one deliberate exception, asserted here rather than hidden: the
 * ADMINISTRATOR fan-out is NOT preserved, because preserving it is the leak the
 * same Definition of Done forbids. See tests/fixtures/README.md.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, 'fixtures', 'v3_3_0.db');
const ORACLE = JSON.parse(readFileSync(join(HERE, 'fixtures', 'v3_3_0.snapshot.json'), 'utf8'));

const ADMINISTRATOR = 1 << 11;

let dir;
let dbPath;
let db;
let permissionsIn;
let report006;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vantage-mig-'));
  dbPath = join(dir, 'migrated.db');
  copyFileSync(FIXTURE, dbPath);

  process.env.VANTAGE_DB = dbPath;
  const dbMod = await import('../server/db.js');
  const perms = await import('../server/permissions.js');
  permissionsIn = perms.permissionsIn;
  db = dbMod.getDb(dbPath);
  report006 = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'migration_006_report'").get().value);
});

afterAll(() => {
  try { db?.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

describe('the fixture is a real v3.3.0 database', () => {
  it('was captured at schema version 5, before the tenancy migrations', () => {
    expect(ORACLE.schemaVersion).toBe(5);
  });

  it('contained global roles and chain rows — the conditions the migration exists for', () => {
    expect(ORACLE.globalRoles).toBeGreaterThan(0);
    expect(ORACLE.visibility.activities.chain).toBeGreaterThan(0);
  });
});

describe('migration 006 — tenancy', () => {
  it('reaches schema version 7', () => {
    expect(Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value)).toBe(7);
  });

  it('leaves no global role definitions', () => {
    expect(db.prepare('SELECT COUNT(*) AS n FROM roles WHERE unit_id IS NULL').get().n).toBe(0);
  });

  it('never orphans a live grant', () => {
    const dangling = db
      .prepare('SELECT COUNT(*) AS n FROM member_roles mr LEFT JOIN roles r ON r.id = mr.role_id WHERE r.id IS NULL')
      .get().n;
    expect(dangling).toBe(0);
  });

  it('gives every unit that had a reachable member an owner', () => {
    const ownerless = db
      .prepare(
        `SELECT COUNT(*) AS n FROM units u
          WHERE u.active = 1 AND u.owner_user_id IS NULL
            AND EXISTS (SELECT 1 FROM unit_members m WHERE m.unit_id = u.id)`
      )
      .get().n;
    expect(ownerless).toBe(0);
  });

  it('backfills membership for everyone who held a live assignment', () => {
    const missing = db
      .prepare(
        `SELECT COUNT(*) AS n FROM assignments a
           JOIN units u ON u.id = a.unit_id
          WHERE u.active = 1 AND (a.end_date IS NULL OR a.end_date > date('now'))
            AND NOT EXISTS (
              SELECT 1 FROM unit_members m WHERE m.user_id = a.user_id AND m.unit_id = a.unit_id
            )`
      )
      .get().n;
    expect(missing).toBe(0);
  });

  it('drops inherits_down from the schema', () => {
    const cols = db.prepare('PRAGMA table_info(roles)').all().map((c) => c.name);
    expect(cols).not.toContain('inherits_down');
    expect(cols).toContain('unit_id');
  });

  it('declares roles.unit_id NOT NULL', () => {
    const col = db.prepare('PRAGMA table_info(roles)').all().find((c) => c.name === 'unit_id');
    expect(col.notnull).toBe(1);
  });

  it('leaves the database referentially intact', () => {
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('loses no records', () => {
    for (const table of ['activities', 'recognitions', 'trainings', 'projects', 'goals', 'tasks', 'users', 'units']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(ORACLE.counts[table]);
    }
  });
});

/**
 * THE LOAD-BEARING TEST.
 *
 * For every non-administrator in the fixture, in every unit in the fixture,
 * the bits they hold after migration must be exactly the bits v3.3.0 gave
 * them. Not a superset — a superset would mean the migration handed someone
 * authority they never had. Not a subset — a subset is the silent loss of
 * access that makes people distrust an upgrade.
 */
describe('migration 006 preserves every effective permission', () => {
  // Computed inside the tests, not in the describe body: describe callbacks run
  // at collection time, before beforeAll has opened the database.
  const adminUsernames = () => new Set(report006.dropped_global_admin.map((d) => d.username));

  it('identifies at least one non-administrator to check', () => {
    const others = Object.keys(ORACLE.users).filter((u) => !adminUsernames().has(u));
    expect(others.length).toBeGreaterThan(0);
  });

  it('reproduces v3.3.0 bits exactly, unit by unit', () => {
    const admins = adminUsernames();
    // The one sanctioned change: a unit left ownerless by the administrator
    // conversion promotes whoever was ALREADY running it. They gain exactly
    // ADMINISTRATOR, in exactly that unit. Everything else must be identical.
    const promoted = new Set(report006.promoted_owners.map((p) => `${p.username}@${p.unit_id}`));

    const drift = [];
    for (const [username, snap] of Object.entries(ORACLE.users)) {
      if (admins.has(username)) continue;
      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      expect(user, `${username} survived the migration`).toBeTruthy();

      for (const unitId of db.prepare('SELECT id FROM units WHERE active = 1').all().map((u) => u.id)) {
        const before = snap.permissions[unitId] || 0;
        const after = permissionsIn(db, user, unitId);
        if (before === after) continue;

        if (promoted.has(`${username}@${unitId}`) && after === (before | ADMINISTRATOR)) continue;
        drift.push(`${username} @ ${unitId}: v3.3=${before} v3.4=${after}`);
      }
    }
    expect(drift, `permissions changed for non-administrators:\n${drift.join('\n')}`).toEqual([]);
  });

  it('only promotes people who already administered the unit', () => {
    const RUNS_UNIT = (1 << 7) | (1 << 6); // MANAGE_ROLES | MANAGE_MEMBERS
    for (const p of report006.promoted_owners || []) {
      expect(
        (p.before_bits & RUNS_UNIT) === RUNS_UNIT,
        `${p.username} was promoted to owner of ${p.unit_id} without already running it (bits ${p.before_bits})`
      ).toBe(true);
      // And the promotion is exactly one bit, not a blank cheque.
      const snap = ORACLE.users[p.username].permissions[p.unit_id] || 0;
      expect(p.before_bits & ~snap).toBe(0);
    }
  });

  it('leaves a unit ownerless rather than inventing an owner for it', () => {
    // Recorded, not silent: an ownerless unit is a gap the Instance Operator
    // closes with a claim, which is finding 11's recovery path.
    expect(Array.isArray(report006.left_ownerless)).toBe(true);
    for (const unitId of report006.left_ownerless) {
      expect(db.prepare('SELECT owner_user_id FROM units WHERE id = ?').get(unitId).owner_user_id).toBeNull();
    }
  });

  it('materialises cascading grants rather than recomputing them', () => {
    // The fixture contains a role granted with inherits_down. Preserving its
    // effect without a tree means explicit rows must exist in the subtree.
    expect(report006.materialised_grants).toBeGreaterThan(0);
  });

  it('forks global roles into unit-local copies without deleting granted ones', () => {
    expect(report006.forked_roles).toBeGreaterThan(0);
    expect(report006.repointed_grants).toBeGreaterThan(0);
  });
});

/**
 * The exception, asserted explicitly.
 *
 * If someone later "fixes" the migration to preserve the fan-out, this test
 * fails and tells them why — which is the entire reason it is written as an
 * assertion instead of a paragraph in a changelog.
 */
describe('migration 006 deliberately does not preserve the ADMINISTRATOR fan-out', () => {
  it('recorded what it dropped', () => {
    expect(report006.dropped_global_admin.length).toBeGreaterThan(0);
    for (const entry of report006.dropped_global_admin) {
      expect(entry).toHaveProperty('username');
      expect(entry).toHaveProperty('kept_units');
      expect(entry).toHaveProperty('lost_units');
      expect(entry.lost_units).toBeGreaterThan(0);
    }
  });

  it('leaves the former administrator with zero permissions in units they were never in', () => {
    const username = report006.dropped_global_admin[0].username;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const mine = new Set(db.prepare('SELECT unit_id FROM unit_members WHERE user_id = ?').all(user.id).map((r) => r.unit_id));

    const leaks = [];
    for (const unitId of db.prepare('SELECT id FROM units WHERE active = 1').all().map((u) => u.id)) {
      if (mine.has(unitId)) continue;
      const bits = permissionsIn(db, user, unitId);
      if (bits !== 0) leaks.push(`${unitId}=${bits}`);
    }
    expect(leaks, `former administrator still reaches units they were never in: ${leaks.join(', ')}`).toEqual([]);
  });

  it('keeps them owner of the units they actually belonged to', () => {
    const username = report006.dropped_global_admin[0].username;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const owned = db.prepare('SELECT COUNT(*) AS n FROM units WHERE owner_user_id = ?').get(user.id).n;
    expect(owned).toBeGreaterThan(0);
    // And that ownership is real authority, not a label.
    const someUnit = db.prepare('SELECT id FROM units WHERE owner_user_id = ? LIMIT 1').get(user.id).id;
    expect(permissionsIn(db, user, someUnit) & ADMINISTRATOR).toBeTruthy();
  });
});

describe('migration 007 — chain visibility retired', () => {
  it('leaves no chain rows in any table', () => {
    for (const table of ['activities', 'projects', 'tasks', 'goals', 'recognitions', 'trainings']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE visibility = 'chain'`).get().n).toBe(0);
    }
  });

  it('rewrote exactly the rows that were chain, and no others', () => {
    const report = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'migration_007_report'").get().value);
    for (const table of ['activities', 'recognitions', 'trainings']) {
      expect(report[table]).toBe(ORACLE.visibility[table].chain || 0);
    }
  });

  it('does not touch private records', () => {
    for (const table of ['activities', 'recognitions', 'trainings']) {
      const before = ORACLE.visibility[table].private || 0;
      const after = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE visibility = 'private'`).get().n;
      expect(after).toBe(before);
    }
  });

  it('is a reduction — nothing became visible to more people', () => {
    // 'unit' is strictly narrower than 'chain' was, so the only legal
    // transition is chain -> unit. Anything that gained a broader tier would
    // be a leak introduced by the migration itself.
    const broadened = db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE visibility NOT IN ('personal','private','unit')")
      .get().n;
    expect(broadened).toBe(0);
  });
});
