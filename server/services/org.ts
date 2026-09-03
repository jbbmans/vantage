import type { AppContext, SessionUser } from '../context.ts';
import { ROLE_TEMPLATE, PERMISSIONS, has, ALL_PERMISSIONS } from '../../shared/permissions.ts';
import { can, isUnitOwner, positionIn, scopeFor, type Scope } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { now, slug } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { invalidateUserSessions } from '../auth/sessions.ts';
import { RECORD_TABLE_NAMES } from './records.ts';
import { notify } from './notifications.ts';

export interface UnitRow { id: string; code: string; name: string; short_name: string | null; echelon: string; location: string | null; parent_id: string | null; owner_user_id: string | null; active: number; created_at: string }

export const getUnit = (ctx: AppContext, id: string) => ctx.db.prepare('SELECT * FROM units WHERE id = ? AND active = 1').get(id) as UnitRow | undefined;

export function ancestorIds(ctx: AppContext, unitIds: string[]): string[] {
  const out = new Set<string>();
  const stmt = ctx.db.prepare('SELECT parent_id FROM units WHERE id = ?');
  for (const start of unitIds) {
    let current: string | null = start;
    let guard = 0;
    while (current && !out.has(current) && guard++ < 50) {
      out.add(current);
      current = (stmt.get(current) as { parent_id: string | null } | undefined)?.parent_id ?? null;
    }
  }
  return [...out];
}

export function wouldCycle(ctx: AppContext, unitId: string, parentId: string): boolean {
  let current: string | null = parentId;
  const stmt = ctx.db.prepare('SELECT parent_id FROM units WHERE id = ?');
  let guard = 0;
  while (current && guard++ < 50) {
    if (current === unitId) return true;
    current = (stmt.get(current) as { parent_id: string | null } | undefined)?.parent_id ?? null;
  }
  return false;
}

export function seedRoles(ctx: AppContext, unitId: string) {
  const existing = (ctx.db.prepare('SELECT COUNT(*) AS n FROM roles WHERE unit_id = ?').get(unitId) as { n: number }).n;
  if (existing) return;
  const insert = ctx.db.prepare('INSERT INTO roles (id, unit_id, key, name, description, color, position, permissions, is_default, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)');
  for (const r of ROLE_TEMPLATE) insert.run(`${unitId}:${r.key}`.slice(0, 120), unitId, r.key, r.name, r.description, r.color, r.position, r.permissions, r.is_default ? 1 : 0, now());
}

export const ownerRoleId = (unitId: string) => `${unitId}:${ROLE_TEMPLATE.find((r) => r.owner)!.key}`.slice(0, 120);
export const defaultRoleId = (ctx: AppContext, unitId: string) => (ctx.db.prepare('SELECT id FROM roles WHERE unit_id = ? AND is_default = 1 LIMIT 1').get(unitId) as { id: string } | undefined)?.id ?? null;

export function addMember(ctx: AppContext, userId: string, unitId: string, { invitedBy = null, primary = false, billet = null }: { invitedBy?: string | null; primary?: boolean; billet?: string | null } = {}) {
  const hasPrimary = ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND is_primary = 1').get(userId);
  const isPrimary = primary || !hasPrimary ? 1 : 0;
  ctx.db.transaction(() => {
    if (isPrimary) ctx.db.prepare('UPDATE unit_members SET is_primary = 0 WHERE user_id = ?').run(userId);
    ctx.db.prepare(
      `INSERT INTO unit_members (user_id, unit_id, is_primary, billet, joined_at, invited_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, unit_id) DO UPDATE SET is_primary = MAX(unit_members.is_primary, excluded.is_primary), billet = COALESCE(excluded.billet, unit_members.billet)`
    ).run(userId, unitId, isPrimary, billet, now(), invitedBy);
    const def = defaultRoleId(ctx, unitId);
    if (def) ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, def, unitId, invitedBy, now());
  })();
}

export function removeMember(ctx: AppContext, userId: string, unitId: string) {
  return ctx.db.transaction(() => {
    const frozenAt = now();
    let recordsFrozen = 0;
    for (const table of RECORD_TABLE_NAMES) {
      recordsFrozen += ctx.db.prepare(`UPDATE ${table} SET frozen_at = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL AND frozen_at IS NULL`).run(frozenAt, frozenAt, userId, unitId).changes;
    }
    const roles = ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND unit_id = ?').run(userId, unitId).changes;
    const wasPrimary = ctx.db.prepare('SELECT is_primary FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId) as { is_primary: number } | undefined;
    ctx.db.prepare('DELETE FROM unit_members WHERE user_id = ? AND unit_id = ?').run(userId, unitId);
    if (wasPrimary?.is_primary) {
      const next = ctx.db.prepare('SELECT unit_id FROM unit_members WHERE user_id = ? ORDER BY joined_at LIMIT 1').get(userId) as { unit_id: string } | undefined;
      if (next) ctx.db.prepare('UPDATE unit_members SET is_primary = 1 WHERE user_id = ? AND unit_id = ?').run(userId, next.unit_id);
    }
    return { roles, recordsFrozen };
  })();
}

export function claimUnit(ctx: AppContext, unitId: string, ownerId: string) {
  ctx.db.transaction(() => {
    seedRoles(ctx, unitId);
    addMember(ctx, ownerId, unitId, { primary: false });
    ctx.db.prepare('UPDATE units SET owner_user_id = ? WHERE id = ?').run(ownerId, unitId);
    ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(ownerId, ownerRoleId(unitId), unitId, ownerId, now());
  })();
}

export function createUnit(ctx: AppContext, actor: SessionUser, scope: Scope, body: { name?: string; short_name?: string | null; code?: string | null; echelon?: string | null; location?: string | null; parent_id?: string | null }, ip?: string) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 120) throw badRequest('A unit needs a name under 120 characters.', { fieldErrors: { name: 'Required (limit 120 characters).' } });
  const parentId = body.parent_id || null;
  if (parentId) {
    if (!getUnit(ctx, parentId)) throw badRequest('No such parent unit.');
    if (!can(scope, PERMISSIONS.MANAGE_UNITS, parentId)) throw forbidden('You cannot create units under that parent.');
  } else if (!actor.is_operator) throw forbidden('Only the Instance Operator can create a new top-level organization.', 'not_operator');
  const code = slug(String(body.code || body.short_name || name));
  if (!code) throw badRequest('That name produces an empty unit code.');
  if (ctx.db.prepare('SELECT 1 FROM units WHERE id = ?').get(code)) throw conflict('That unit code already exists.', 'duplicate_code');
  ctx.db.transaction(() => {
    ctx.db.prepare('INSERT INTO units (id, code, name, short_name, echelon, location, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(code, code, name, body.short_name?.trim() || null, body.echelon || 'section', body.location?.trim() || null, parentId, now());
    claimUnit(ctx, code, actor.id);
  })();
  audit(ctx, { actor_id: actor.id, action: 'create_unit', entity: 'unit', entity_id: code, unit_id: code, detail: name, ip });
  return getUnit(ctx, code)!;
}

export function updateUnit(ctx: AppContext, actor: SessionUser, scope: Scope, unitId: string, body: Record<string, unknown>, ip?: string) {
  const unit = getUnit(ctx, unitId);
  if (!unit) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.MANAGE_UNITS, unitId)) throw forbidden('You cannot edit that unit.');
  const name = body.name === undefined ? unit.name : String(body.name || '').trim();
  if (!name || name.length > 120) throw badRequest('A unit needs a name under 120 characters.', { fieldErrors: { name: 'Required.' } });
  let parentId = unit.parent_id;
  if (body.parent_id !== undefined) {
    const next = (body.parent_id as string | null) || null;
    if (next !== unit.parent_id) {
      if (!next && !actor.is_operator) throw forbidden('Only the Instance Operator can detach a unit into a new top-level organization.');
      if (next) {
        if (!getUnit(ctx, next)) throw badRequest('No such parent unit.');
        if (!actor.is_operator && !can(scope, PERMISSIONS.MANAGE_UNITS, next)) throw forbidden('You cannot move a unit under a parent you do not manage.');
        if (next === unitId || wouldCycle(ctx, unitId, next)) throw badRequest('A unit cannot be placed beneath itself or one of its descendants.');
      }
      parentId = next;
    }
  }
  ctx.db.prepare('UPDATE units SET name = ?, short_name = ?, echelon = ?, location = ?, parent_id = ? WHERE id = ?').run(
    name,
    body.short_name === undefined ? unit.short_name : (String(body.short_name || '').trim() || null),
    body.echelon === undefined ? unit.echelon : String(body.echelon || 'section'),
    body.location === undefined ? unit.location : (String(body.location || '').trim() || null),
    parentId, unitId
  );
  audit(ctx, { actor_id: actor.id, action: 'edit_unit', entity: 'unit', entity_id: unitId, unit_id: unitId, ip });
  return getUnit(ctx, unitId)!;
}

export function archiveUnit(ctx: AppContext, actor: SessionUser, scope: Scope, unitId: string, ip?: string) {
  const unit = getUnit(ctx, unitId);
  if (!unit) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.MANAGE_UNITS, unitId)) throw forbidden('You cannot archive that unit.');
  const children = (ctx.db.prepare('SELECT COUNT(*) AS n FROM units WHERE parent_id = ? AND active = 1').get(unitId) as { n: number }).n;
  if (children) throw badRequest('That unit still has sub-units. Move or archive those first.');
  const members = ctx.db.prepare('SELECT user_id FROM unit_members WHERE unit_id = ?').all(unitId) as Array<{ user_id: string }>;
  const onlyOwner = members.length === 1 && members[0].user_id === actor.id && unit.owner_user_id === actor.id;
  if (members.length && !onlyOwner) throw badRequest('Marines still belong to that unit. Remove or transfer them first.');
  ctx.db.transaction(() => {
    if (onlyOwner) removeMember(ctx, actor.id, unitId);
    ctx.db.prepare('UPDATE units SET active = 0, owner_user_id = NULL WHERE id = ?').run(unitId);
  })();
  audit(ctx, { actor_id: actor.id, action: 'archive_unit', entity: 'unit', entity_id: unitId, unit_id: unitId, ip });
}

export function transferOwnership(ctx: AppContext, actor: SessionUser, unitId: string, successorId: string, ip?: string) {
  const unit = getUnit(ctx, unitId);
  if (!unit) throw notFound('No such unit.');
  if (!actor.is_operator && !isUnitOwner(ctx, actor.id, unitId)) throw forbidden('Only the current Unit Leader or Instance Operator can transfer ownership.');
  const successor = ctx.db.prepare('SELECT u.id, u.first_name, u.last_name FROM users u JOIN unit_members um ON um.user_id = u.id WHERE u.id = ? AND u.active = 1 AND um.unit_id = ?').get(successorId, unitId) as { id: string; first_name: string; last_name: string } | undefined;
  if (!successor) throw badRequest('Choose an active current member of this unit.', { fieldErrors: { user_id: 'Not a member of this unit.' } });
  if (successor.id === unit.owner_user_id) return { ok: true, already: true };
  let sessionsRevoked = 0;
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE units SET owner_user_id = ? WHERE id = ?').run(successor.id, unitId);
    ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(successor.id, ownerRoleId(unitId), unitId, actor.id, now());
    if (unit.owner_user_id) {
      ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND unit_id = ? AND role_id IN (SELECT id FROM roles WHERE unit_id = ? AND (permissions & ?) <> 0)').run(unit.owner_user_id, unitId, unitId, PERMISSIONS.ADMINISTRATOR);
      if (unit.owner_user_id !== actor.id) sessionsRevoked += invalidateUserSessions(ctx, unit.owner_user_id);
    }
    sessionsRevoked += invalidateUserSessions(ctx, successor.id);
  })();
  audit(ctx, { actor_id: actor.id, action: 'transfer_ownership', entity: 'unit', entity_id: unitId, subject_id: successor.id, unit_id: unitId, detail: `${unit.owner_user_id || 'unowned'} -> ${successor.id}`, ip });
  notify(ctx, successor.id, { kind: 'unit', title: `You now lead ${unit.short_name || unit.name}`, message: 'Sign in again to pick up the new authority.', actionUrl: '/team', dedupeKey: `owner:${unitId}:${successor.id}` });
  return { ok: true, sessionsRevoked };
}

// Roles -----------------------------------------------------------------

export interface RoleRow { id: string; unit_id: string; key: string | null; name: string; description: string | null; color: string | null; position: number; permissions: number; is_default: number; is_system: number }

export function canManageRoleDefinition(ctx: AppContext, actor: SessionUser, scope: Scope, role: RoleRow): boolean {
  if (isUnitOwner(ctx, actor.id, role.unit_id)) return true;
  if (!can(scope, PERMISSIONS.MANAGE_ROLES, role.unit_id)) return false;
  return role.position < positionIn(scope, role.unit_id);
}

export function validateRoleDefinition(ctx: AppContext, actor: SessionUser, scope: Scope, def: { name: string; position: number; permissions: number; unit_id: string }, existing?: RoleRow) {
  const name = String(def.name || '').trim();
  if (!name || name.length > 60) throw badRequest('A role needs a name under 60 characters.', { fieldErrors: { name: 'Required (limit 60 characters).' } });
  if (!Number.isInteger(def.position) || def.position < 0 || def.position > 99) throw badRequest('Position must be a whole number from 0 to 99.', { fieldErrors: { position: '0 to 99.' } });
  if (!Number.isInteger(def.permissions) || def.permissions < 0 || (def.permissions & ~ALL_PERMISSIONS) !== 0) throw badRequest('Unknown permission bits.');
  if (!getUnit(ctx, def.unit_id)) throw notFound('No such unit.');
  const owner = isUnitOwner(ctx, actor.id, def.unit_id);
  if (!owner) {
    if (!can(scope, PERMISSIONS.MANAGE_ROLES, def.unit_id)) throw forbidden('You cannot manage roles in that unit.');
    const myPosition = positionIn(scope, def.unit_id);
    const myBits = scope.permissions[def.unit_id] || 0;
    if (def.position >= myPosition) throw forbidden('You cannot create or edit a role at or above your own position.', 'hierarchy');
    if (!has(myBits, PERMISSIONS.ADMINISTRATOR) && (def.permissions & ~myBits) !== 0) throw forbidden('You cannot grant a permission you do not hold.', 'delegation');
    if (existing && existing.position >= myPosition) throw forbidden('That role is at or above your own.', 'hierarchy');
  }
  if (existing?.is_system && existing.key === 'unit-leader') throw badRequest('The Unit Leader role is fixed.');
  return { name };
}

export function validateRoleGrant(ctx: AppContext, actor: SessionUser, scope: Scope, role: RoleRow | undefined, unitId: string, targetId: string) {
  if (!role) throw notFound('No such role.');
  if (role.unit_id !== unitId) throw forbidden('That role belongs to another unit.', 'scope');
  if (role.key === 'unit-leader' && !isUnitOwner(ctx, targetId, unitId)) throw badRequest('Transfer unit ownership to grant the Unit Leader role.');
  const targetScope = scopeFor(ctx, { id: targetId });
  if (!targetScope.unitIds.includes(unitId)) throw badRequest('That Marine is not a member of this unit.');
  if (isUnitOwner(ctx, actor.id, unitId)) return;
  if (!can(scope, PERMISSIONS.MANAGE_ROLES, unitId)) throw forbidden('You cannot manage roles in that unit.');
  if (role.position >= positionIn(scope, unitId)) throw forbidden('You cannot grant a role at or above your own.', 'hierarchy');
  if (targetId !== actor.id && positionIn(targetScope, unitId) >= positionIn(scope, unitId)) throw forbidden('You cannot change roles for a Marine at or above your position.', 'hierarchy');
}
