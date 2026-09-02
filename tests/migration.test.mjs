import { describe, it, before as beforeAll, after as afterAll } from 'node:test';
import { copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from './support/expect.mjs';

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
  try { db?.close(); } catch {  }
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
  it('reaches the current schema version 16', () => {
    expect(Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value)).toBe(16);
  });

  it('adds exact-unit integration clients without storing raw credentials', () => {
    const columns = db.prepare('PRAGMA table_info(integration_clients)').all().map((column) => column.name);
    expect(columns.includes('unit_id')).toBe(true);
    expect(columns.includes('token_hash')).toBe(true);
    expect(columns.includes('token')).toBe(false);
  });

  it('adds confidential incident cases with append-only event history', () => {
    const cases = db.prepare('PRAGMA table_info(security_incidents)').all().map((column) => column.name);
    const events = db.prepare('PRAGMA table_info(security_incident_events)').all().map((column) => column.name);
    expect(cases.includes('reporter_id')).toBe(true);
    expect(cases.includes('description')).toBe(true);
    expect(cases.includes('unit_id')).toBe(false);
    expect(events.includes('visible_to_reporter')).toBe(true);
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

describe('migration 009 — canonical identity and role/unit integrity', () => {
  it('repairs every cross-unit role reference', () => {
    const mismatches = db.prepare(
      `SELECT COUNT(*) AS n FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.unit_id <> r.unit_id`
    ).get().n;
    expect(mismatches).toBe(0);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'migration_009_report'").get()).toBeTruthy();
  });

  it('rejects case-variant usernames at the database boundary', () => {
    const source = db.prepare('SELECT * FROM users LIMIT 1').get();
    expect(() => db.prepare(
      `INSERT INTO users (id, username, password_hash, last_name, first_name, created_at, updated_at)
       VALUES ('case-collision-test', ?, ?, 'Test', 'Case', ?, ?)`
    ).run(source.username.toUpperCase(), source.password_hash, new Date().toISOString(), new Date().toISOString())).toThrow();
  });

  it('rejects a grant whose role belongs to another unit', () => {
    const role = db.prepare('SELECT * FROM roles LIMIT 1').get();
    const other = db.prepare('SELECT id FROM units WHERE id <> ? LIMIT 1').get(role.unit_id);
    const user = db.prepare('SELECT id FROM users LIMIT 1').get();
    if (!other) return;
    expect(() => db.prepare(
      `INSERT INTO member_roles (id, user_id, role_id, unit_id, created_at)
       VALUES ('mismatch-test', ?, ?, ?, ?)`
    ).run(user.id, role.id, other.id, new Date().toISOString())).toThrow(/role and grant unit mismatch/);
  });
});

describe('migration 006 preserves every effective permission', () => {


  const adminUsernames = () => new Set(report006.dropped_global_admin.map((d) => d.username));

  it('identifies at least one non-administrator to check', () => {
    const others = Object.keys(ORACLE.users).filter((u) => !adminUsernames().has(u));
    expect(others.length).toBeGreaterThan(0);
  });

  it('reproduces v3.3.0 bits exactly, unit by unit', () => {
    const admins = adminUsernames();



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
    const RUNS_UNIT = (1 << 7) | (1 << 6);
    for (const p of report006.promoted_owners || []) {
      expect(
        (p.before_bits & RUNS_UNIT) === RUNS_UNIT,
        `${p.username} was promoted to owner of ${p.unit_id} without already running it (bits ${p.before_bits})`
      ).toBe(true);

      const snap = ORACLE.users[p.username].permissions[p.unit_id] || 0;
      expect(p.before_bits & ~snap).toBe(0);
    }
  });

  it('leaves a unit ownerless rather than inventing an owner for it', () => {


    expect(Array.isArray(report006.left_ownerless)).toBe(true);
    for (const unitId of report006.left_ownerless) {
      expect(db.prepare('SELECT owner_user_id FROM units WHERE id = ?').get(unitId).owner_user_id).toBeNull();
    }
  });

  it('materialises cascading grants rather than recomputing them', () => {


    expect(report006.materialised_grants).toBeGreaterThan(0);
  });

  it('forks global roles into unit-local copies without deleting granted ones', () => {
    expect(report006.forked_roles).toBeGreaterThan(0);
    expect(report006.repointed_grants).toBeGreaterThan(0);
  });
});

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



    const broadened = db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE visibility NOT IN ('personal','private','unit')")
      .get().n;
    expect(broadened).toBe(0);
  });
});

describe('migration 008 — session and recovery hardening', () => {
  it('adds the forced temporary-password-change flag', () => {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    expect(cols).toContain('must_change_password');
  });

  it('stores any surviving session identifiers only as SHA-256 digests', () => {
    const tokens = db.prepare('SELECT token FROM sessions').all().map((r) => r.token);
    expect(tokens.every((token) => /^[a-f0-9]{64}$/.test(token))).toBe(true);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'migration_008_report'").get()).toBeTruthy();
  });
});
