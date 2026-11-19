import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, type TestApp } from './helpers.ts';
import { scopeFor, scopesFor, detailUnitsFor } from '../../server/authz/scope.ts';
import { PERMISSIONS, NAMED_ONLY_BITS } from '../../shared/permissions.ts';

/**
 * scopesFor reads many people's scopes with a fixed number of statements (ADR-0032). Each must be exactly what
 * scopeFor gives that person, whatever mix of memberships, roles, leadership, Unit Instance roles and Vantage access
 * they hold: a roster or a drill decides from these what the reader may do about each person on it.
 */
let app: TestApp;
let ids: string[] = [];
let op: { id: string };

before(async () => {
  app = await startApp();
  op = await app.setupOperator();
  const db = app.ctx.db;
  const at = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  const earlier = new Date(Date.now() - 86_400_000).toISOString();
  const user = (name: string) => {
    const id = `u-${name}`;
    db.prepare(`INSERT INTO users (id, username, password_hash, first_name, last_name, rank_id, created_at, updated_at) VALUES (?, ?, 'x', ?, 'Marine', 'Cpl', ?, ?)`).run(id, name, name, at, at);
    ids.push(id);
    return id;
  };
  const org = (id: string, status: string) => db.prepare(`INSERT INTO organizations (id, slug, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, id.toLowerCase(), id, status, at, at);
  const unit = (id: string, orgId: string, parent: string | null, opts: { owner?: string; active?: number } = {}) =>
    db.prepare(`INSERT INTO units (id, code, name, parent_id, owner_user_id, active, created_at, org_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, id, id, parent, opts.owner ?? null, opts.active ?? 1, at, orgId);
  const member = (userId: string, unitId: string, primary = 0, joined = at) => db.prepare(`INSERT INTO unit_members (user_id, unit_id, is_primary, joined_at) VALUES (?, ?, ?, ?)`).run(userId, unitId, primary, joined);
  const role = (id: string, unitId: string, position: number, permissions: number) => db.prepare(`INSERT INTO roles (id, unit_id, key, name, permissions, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, unitId, id, id, permissions, position, at);
  const grant = (userId: string, roleId: string, unitId: string, by: string | null, expires: string | null = null) =>
    db.prepare(`INSERT INTO member_roles (user_id, role_id, unit_id, granted_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`).run(userId, roleId, unitId, by, at, expires);

  const ldr = user('ldr'), absent = user('absent'), twin = user('twin'), viewer = user('viewer'), nco = user('nco'), mgr = user('mgr'),
    unseated = user('unseated'), staff = user('staff'), gone = user('gone'), archived = user('archived'), both = user('both');
  user('nobody');
  org('ORGA', 'active'); org('ORGB', 'suspended');
  unit('A', 'ORGA', null, { owner: ldr }); unit('A1', 'ORGA', 'A', { owner: absent }); unit('A2', 'ORGA', 'A1'); unit('A3', 'ORGA', 'A', { active: 0 });
  unit('B', 'ORGB', null, { owner: gone }); unit('B1', 'ORGB', 'B');
  member(ldr, 'A', 1);
  // Two memberships alike in all but the unit: the order must not depend on how many people are read at once.
  member(twin, 'A1', 0, '2026-01-01T00:00:00.000Z'); member(twin, 'A2', 0, '2026-01-01T00:00:00.000Z');
  member(viewer, 'A', 1); role('A:viewer', 'A', 0, PERMISSIONS.VIEW_UNIT | PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_MEMBER_DETAIL); grant(viewer, 'A:viewer', 'A', ldr);
  member(nco, 'A1', 1); member(nco, 'A', 0);
  role('A1:nco', 'A1', 5, PERMISSIONS.VIEW_RECORDS | PERMISSIONS.VIEW_MEMBER_DETAIL | PERMISSIONS.COUNSEL | NAMED_ONLY_BITS); grant(nco, 'A1:nco', 'A1', ldr);
  role('A:old', 'A', 9, PERMISSIONS.MANAGE_MEMBERS); grant(nco, 'A:old', 'A', ldr, earlier);
  role('A:self', 'A', 3, PERMISSIONS.VIEW_RECORDS | NAMED_ONLY_BITS); grant(nco, 'A:self', 'A', nco);
  member(mgr, 'A2', 1); member(mgr, 'B1', 0);
  db.prepare(`INSERT INTO org_roles (org_id, user_id, role, granted_by, expires_at, created_at) VALUES ('ORGA', ?, 'admin', ?, ?, ?), ('ORGA', ?, 'records', ?, NULL, ?), ('ORGB', ?, 'admin', ?, NULL, ?)`)
    .run(mgr, ldr, later, at, mgr, ldr, at, mgr, ldr, at);
  db.prepare(`INSERT INTO org_roles (org_id, user_id, role, granted_by, created_at) VALUES ('ORGA', ?, 'owner', ?, ?)`).run(unseated, ldr, at);
  db.prepare(`INSERT INTO platform_roles (user_id, role, created_at) VALUES (?, 'support', ?)`).run(staff, at);
  db.prepare(`INSERT INTO access_grants (id, org_id, staff_user_id, reason, minutes, status, requested_at, starts_at, expires_at) VALUES ('g1', 'ORGA', ?, 'help', 60, 'active', ?, ?, ?), ('g2', 'ORGA', ?, 'old', 60, 'active', ?, ?, ?)`)
    .run(staff, at, at, later, staff, at, earlier, earlier);
  member(gone, 'B', 1); role('B:lead', 'B', 4, PERMISSIONS.VIEW_RECORDS); grant(gone, 'B:lead', 'B', ldr);
  member(archived, 'A3', 1);
  member(both, 'A', 0); member(both, 'A2', 1); grant(both, 'A:viewer', 'A', ldr);
  ids = [...ids, op.id, 'u-missing'];
});

after(async () => { await app?.close(); });

test('scopesFor gives each person exactly what scopeFor gives them', () => {
  const batch = scopesFor(app.ctx, ids);
  assert.equal(batch.size, ids.length);
  for (const id of ids) assert.deepEqual(batch.get(id), scopeFor(app.ctx, { id }), id);
  // Read in any order and any grouping, the same answer.
  const reversed = scopesFor(app.ctx, [...ids].reverse());
  for (const id of ids) assert.deepEqual(reversed.get(id), batch.get(id), id);
  for (const id of ids) assert.deepEqual(scopesFor(app.ctx, [id]).get(id), batch.get(id), id);
});

test('the fixture holds the cases that matter', () => {
  const s = scopesFor(app.ctx, ids);
  assert.equal(s.get('u-viewer')!.permissions.A2, undefined, 'a position-0 role reaches no lower unit');
  assert.ok(s.get('u-nco')!.permissions.A2! & PERMISSIONS.COUNSEL, 'a position>0 role reaches the units beneath');
  assert.equal(s.get('u-nco')!.permissions.A! & PERMISSIONS.MANAGE_MEMBERS, 0, 'an expired role confers nothing');
  assert.equal(s.get('u-nco')!.permissions.A! & NAMED_ONLY_BITS, 0, 'a role one granted oneself confers no named-only bit');
  assert.ok(s.get('u-nco')!.permissions.A1! & NAMED_ONLY_BITS, 'a role another granted confers it');
  assert.deepEqual(s.get('u-absent')!.ownedUnitIds, [], 'a leader who is not a member leads nothing');
  assert.deepEqual(s.get('u-ldr')!.ownedUnitIds, ['A']);
  assert.deepEqual(Object.keys(s.get('u-mgr')!.orgs), ['ORGA'], 'a suspended Unit Instance confers nothing');
  assert.deepEqual(s.get('u-unseated')!.orgs, {}, 'a Unit Instance role with no seat confers nothing');
  assert.deepEqual(s.get('u-staff')!.vantageAccess.map((g) => g.grantId), ['g1'], 'only live Vantage access');
  assert.deepEqual(s.get('u-gone')!.unitIds, [], 'a suspended Unit Instance’s units confer nothing');
  assert.deepEqual(s.get('u-archived')!.unitIds, [], 'an archived unit confers nothing');
  assert.deepEqual(s.get('u-twin')!.unitIds, ['A1', 'A2']);
  assert.deepEqual(s.get('u-missing')!.unitIds, []);
});

test('detailUnitsFor answers the same with a scope from scopesFor', () => {
  const batch = scopesFor(app.ctx, ids);
  for (const reader of ids) for (const target of ids) {
    assert.deepEqual(detailUnitsFor(app.ctx, batch.get(reader)!, target, batch.get(target)), detailUnitsFor(app.ctx, scopeFor(app.ctx, { id: reader }), target), `${reader} → ${target}`);
  }
});

test('scopesFor reads a fixed number of statements, and shares the request cache with scopeFor', () => {
  const db = app.ctx.db;
  const prepare = db.prepare;
  let n = 0;
  db.prepare = ((sql: string) => { n += 1; return prepare.call(db, sql); }) as typeof db.prepare;
  try {
    scopesFor(app.ctx, ids);
    const few = n;
    n = 0;
    for (const id of ids) scopeFor(app.ctx, { id });
    assert.ok(few <= 10, `scopesFor read ${few} statements`);
    assert.ok(n > few * 3, `scopeFor one by one read ${n}`);
  } finally { db.prepare = prepare; }
  const req = {};
  const batch = scopesFor(app.ctx, ids, req);
  assert.equal(scopeFor(app.ctx, { id: 'u-nco' }, req), batch.get('u-nco'), 'scopeFor reuses what scopesFor read for the request');
  assert.deepEqual(scopeFor(app.ctx, { id: op.id }, {}), batch.get(op.id));
});
