import type { AppContext, SessionUser } from '../context.ts';
import { ROLE_TEMPLATE, PERMISSIONS, has, ALL_PERMISSIONS, RECORD_READING_BITS } from '../../shared/permissions.ts';
import { assertSameInstance, can, isUnitOwner, orgCan, orgOfUnit, positionIn, scopeFor, type Scope } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { now, slug } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { invalidateUserSessions } from '../auth/sessions.ts';
import { RECORD_TABLE_NAMES } from './records.ts';
import { notify, notifyOrg } from './notifications.ts';
import { releaseClaimsOnDeparture } from './work.ts';
import { assertCanFoundUnitInstance } from './deployment.ts';
import { noteMembershipEnd, noteMembershipStart, type EndReason, type StartReason } from './membership.ts';

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

/** The Unit Instance a person's primary unit sits in, when they have one. */
export function primaryOrgOf(ctx: AppContext, userId: string): { unitId: string; orgId: string | null } | null {
  const row = ctx.db.prepare('SELECT um.unit_id, u.org_id FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id = ? AND um.is_primary = 1 LIMIT 1')
    .get(userId) as { unit_id: string; org_id: string | null } | undefined;
  return row ? { unitId: row.unit_id, orgId: row.org_id } : null;
}

/**
 * Seat a person in a unit. The account is not touched: whoever they were before, they are still (ADR-0009). `reason`
 * is written on the membership period this opens, and only when it opens one: re-seating a member changes no history.
 */
export function addMember(ctx: AppContext, userId: string, unitId: string, { invitedBy = null, primary = false, billet = null, reason = null }: { invitedBy?: string | null; primary?: boolean; billet?: string | null; reason?: StartReason | null } = {}) {
  const current = primaryOrgOf(ctx, userId);
  // Enrollment in one Unit Instance never takes the primary unit a person holds in another: that one is theirs to move.
  const isPrimary = !current || (primary && current.orgId === orgOfUnit(ctx, unitId)) ? 1 : 0;
  ctx.db.transaction(() => {
    const joining = !ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId);
    if (isPrimary) ctx.db.prepare('UPDATE unit_members SET is_primary = 0 WHERE user_id = ?').run(userId);
    ctx.db.prepare(
      `INSERT INTO unit_members (user_id, unit_id, is_primary, billet, joined_at, invited_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, unit_id) DO UPDATE SET is_primary = MAX(unit_members.is_primary, excluded.is_primary), billet = COALESCE(excluded.billet, unit_members.billet)`
    ).run(userId, unitId, isPrimary, billet, now(), invitedBy);
    if (joining && reason) noteMembershipStart(ctx, userId, unitId, reason, invitedBy);
    const def = defaultRoleId(ctx, unitId);
    if (def) ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, def, unitId, invitedBy, now());
  })();
}

/**
 * Make one of a person's units their primary unit. Whether the move is the caller's to make is decided where it is asked
 * for: a leader here cannot take a primary unit held in another Unit Instance (ADR-0008).
 */
export function setPrimaryUnit(ctx: AppContext, userId: string, unitId: string) {
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE unit_members SET is_primary = 0 WHERE user_id = ?').run(userId);
    ctx.db.prepare('UPDATE unit_members SET is_primary = 1 WHERE user_id = ? AND unit_id = ?').run(userId, unitId);
  })();
}

/** promote: false leaves the primary unit for the caller to place, as a move does, so it passes straight across. */
export function removeMember(ctx: AppContext, userId: string, unitId: string, actorId: string | null = null, reason: EndReason = 'removed', { promote = true }: { promote?: boolean } = {}) {
  return ctx.db.transaction(() => {
    const frozenAt = now();
    let recordsFrozen = 0;
    for (const table of RECORD_TABLE_NAMES) {
      recordsFrozen += ctx.db.prepare(`UPDATE ${table} SET frozen_at = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL AND frozen_at IS NULL`).run(frozenAt, frozenAt, userId, unitId).changes;
    }
    const roles = ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND unit_id = ?').run(userId, unitId).changes;
    for (const table of ['tasks', 'goals']) ctx.db.prepare(`UPDATE ${table} SET assignee_id = NULL, updated_at = ?, version = version + 1 WHERE assignee_id = ? AND unit_id = ? AND deleted_at IS NULL`).run(frozenAt, userId, unitId);
    const claimsReleased = releaseClaimsOnDeparture(ctx, userId, unitId, actorId);
    const wasPrimary = ctx.db.prepare('SELECT is_primary FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId) as { is_primary: number } | undefined;
    // The membership ends; its period stays, saying when, why and by whom (ADR-0009).
    if (ctx.db.prepare('DELETE FROM unit_members WHERE user_id = ? AND unit_id = ?').run(userId, unitId).changes) noteMembershipEnd(ctx, userId, unitId, reason, actorId);
    if (wasPrimary?.is_primary && promote) {
      // The primary unit stays in the Unit Instance it was in while the person still belongs to one of its units.
      const next = ctx.db.prepare('SELECT um.unit_id FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id = ? ORDER BY (u.org_id IS ?) DESC, um.joined_at LIMIT 1')
        .get(userId, orgOfUnit(ctx, unitId)) as { unit_id: string } | undefined;
      if (next) ctx.db.prepare('UPDATE unit_members SET is_primary = 1 WHERE user_id = ? AND unit_id = ?').run(userId, next.unit_id);
    }
    return { roles, recordsFrozen, claimsReleased };
  })();
}

export function claimUnit(ctx: AppContext, unitId: string, ownerId: string, reason: StartReason = 'leader_assigned') {
  const previous = (ctx.db.prepare('SELECT owner_user_id FROM units WHERE id = ?').get(unitId) as { owner_user_id: string | null } | undefined)?.owner_user_id || null;
  let sessionsRevoked = 0;
  ctx.db.transaction(() => {
    seedRoles(ctx, unitId);
    addMember(ctx, ownerId, unitId, { primary: false, reason });
    ctx.db.prepare('UPDATE units SET owner_user_id = ? WHERE id = ?').run(ownerId, unitId);
    ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(ownerId, ownerRoleId(unitId), unitId, ownerId, now());
    if (previous && previous !== ownerId) {
      ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND unit_id = ? AND role_id IN (SELECT id FROM roles WHERE unit_id = ? AND (permissions & ?) <> 0)').run(previous, unitId, unitId, PERMISSIONS.ADMINISTRATOR);
      sessionsRevoked += invalidateUserSessions(ctx, previous);
    }
  })();
  return { previous, sessionsRevoked };
}

export function createUnit(ctx: AppContext, actor: SessionUser, scope: Scope, body: { name?: string; short_name?: string | null; code?: string | null; echelon?: string | null; location?: string | null; parent_id?: string | null }, ip?: string) {
  const name = String(body.name || '').trim();
  if (!name || name.length > 120) throw badRequest('A unit needs a name under 120 characters.', { fieldErrors: { name: 'Required (limit 120 characters).' } });
  const parentId = body.parent_id || null;
  if (parentId) {
    if (!getUnit(ctx, parentId)) throw badRequest('No such parent unit.');
    if (!can(scope, PERMISSIONS.MANAGE_UNITS, parentId)) throw forbidden('You cannot create units under that parent.');
  } else if (!actor.platformPermissions.includes('platform.orgs')) {
    // A unit with no parent founds an organization. Self-service is the platform's policy; Vantage staff create them freely.
    if (!ctx.runtime.selfServiceUnits) throw forbidden('New Unit Instances are set up by Vantage Administrators. Ask through Support, or ask to join an existing unit.', 'org_creation_closed');
    const limit = ctx.runtime.selfServiceUnitLimit;
    const mine = (ctx.db.prepare(
            'SELECT COUNT(*) AS n FROM units WHERE owner_user_id = ? AND parent_id IS NULL AND active = 1'
    ).get(actor.id) as { n: number }).n;
    if (mine >= limit) throw forbidden(`You have already created ${mine} ${mine === 1 ? 'organization' : 'organizations'}. That is the limit.`, 'unit_limit');
  }
  if (!parentId) assertCanFoundUnitInstance(ctx);
  const code = slug(String(body.code || body.short_name || name));
  if (!code) throw badRequest('That name produces an empty unit code.');
  if (ctx.db.prepare('SELECT 1 FROM units WHERE id = ?').get(code)) throw conflict('That unit code already exists.', 'duplicate_code');
  // Whoever creates a unit through the chain of command leads it. Someone who may only through an organization role
  // (its structure, not its records) does not: the unit is led from above until its leader is named.
  const unitBits = parentId ? (scope.sources[parentId] || []).filter((x) => x.kind !== 'org' && x.kind !== 'vantage').reduce((b, x) => b | x.bits, 0) : 0;
  const ledFromAbove = Boolean(parentId) && !has(unitBits, PERMISSIONS.MANAGE_UNITS);
  ctx.db.transaction(() => {
    ctx.db.prepare('INSERT INTO units (id, code, name, short_name, echelon, location, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(code, code, name, body.short_name?.trim() || null, body.echelon || 'section', body.location?.trim() || null, parentId, now());
    if (ledFromAbove) seedRoles(ctx, code);
    else claimUnit(ctx, code, actor.id, 'unit_created');
    // At the top, the person who founded the organization is its first owner.
    if (!parentId) {
      ctx.db.prepare('UPDATE organizations SET created_by = ? WHERE id = (SELECT org_id FROM units WHERE id = ?)').run(actor.id, code);
      ctx.db.prepare("INSERT OR IGNORE INTO org_roles (org_id, user_id, role, granted_by, created_at) SELECT org_id, ?, 'owner', ?, ? FROM units WHERE id = ?").run(actor.id, actor.id, now(), code);
    }
  })();
  audit(ctx, { actor_id: actor.id, action: parentId ? 'create_unit' : 'create_organization', entity: 'unit', entity_id: code, unit_id: code, detail: name, ip });
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
      if (!next) throw forbidden('A unit stays in its Unit Instance. To split one off into a Unit Instance of its own, ask Vantage support.', 'org_boundary');
      if (next) {
        if (!getUnit(ctx, next)) throw badRequest('No such parent unit.');
        if (orgOfUnit(ctx, next) !== orgOfUnit(ctx, unitId)) throw forbidden('A unit cannot move into another Unit Instance.', 'org_boundary');
        if (!can(scope, PERMISSIONS.MANAGE_UNITS, next)) throw forbidden('You cannot move a unit under a parent you do not manage.');
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
    if (onlyOwner) removeMember(ctx, actor.id, unitId, actor.id, 'left');
    ctx.db.prepare('UPDATE units SET active = 0, owner_user_id = NULL WHERE id = ?').run(unitId);
  })();
  audit(ctx, { actor_id: actor.id, action: 'archive_unit', entity: 'unit', entity_id: unitId, unit_id: unitId, ip });
}

export function transferOwnership(ctx: AppContext, actor: SessionUser, unitId: string, successorId: string, ip?: string) {
  const unit = getUnit(ctx, unitId);
  if (!unit) throw notFound('No such unit.');
  if (!isUnitOwner(ctx, actor.id, unitId) && !orgCan(scopeFor(ctx, actor), 'org.units', orgOfUnit(ctx, unitId))) throw forbidden('Only the current Unit Leader or an owner or administrator of the Unit Instance can transfer leadership.');
  const successor = ctx.db.prepare('SELECT u.id, u.first_name, u.last_name FROM users u JOIN unit_members um ON um.user_id = u.id WHERE u.id = ? AND u.active = 1 AND um.unit_id = ?').get(successorId, unitId) as { id: string; first_name: string; last_name: string } | undefined;
  if (!successor) throw badRequest('Choose an active current member of this unit.', { fieldErrors: { user_id: 'Not a member of this unit.' } });
  if (successor.id === unit.owner_user_id) return { ok: true, already: true };
  const notice = isUnitOwner(ctx, actor.id, unitId) ? null : guardSelfReach(ctx, actor, scopeFor(ctx, actor), unitId, PERMISSIONS.ADMINISTRATOR, successor.id, { you: `Making yourself leader of ${unit.name}`, they: 'made themselves its leader' });
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
  notice?.();
  return { ok: true, sessionsRevoked };
}

export interface RoleRow { id: string; unit_id: string; key: string | null; name: string; description: string | null; color: string | null; position: number; permissions: number; is_default: number; is_system: number }

/**
 * Organization owners and administrators staff every unit of their organization: they define and grant its roles below
 * the Unit Leader, whatever those roles carry, without holding them. That is what running a command's access means
 * (ADR-0006). Giving such a role to yourself is another matter: an administrator cannot, and an owner's other owners
 * are told.
 */
export function orgStaffing(ctx: AppContext, scope: Scope, unitId: string): 'owner' | 'admin' | null {
  const orgId = orgOfUnit(ctx, unitId);
  if (!orgId || !orgCan(scope, 'org.roles', orgId)) return null;
  return scope.orgs[orgId]!.roles.includes('owner') ? 'owner' : 'admin';
}

/**
 * Reach into Marines' records that a person would give themselves through organization authority: by granting
 * themselves a role, leading a unit, redeeming their own join code, or widening a role they hold. What they already
 * hold in the unit through the chain of command is not new reach. An administrator is refused; an owner may, and the
 * returned notice tells the other owners once the change is made.
 */
export function guardSelfReach(ctx: AppContext, actor: SessionUser, scope: Scope, unitId: string, bits: number, targetId: string, act: { you: string; they: string }): (() => void) | null {
  if (targetId !== actor.id || !(bits & RECORD_READING_BITS)) return null;
  const fromUnit = (scope.sources[unitId] || []).filter((s) => s.kind !== 'org' && s.kind !== 'vantage').reduce((b, s) => b | s.bits, 0);
  if (has(fromUnit, PERMISSIONS.ADMINISTRATOR) || (bits & RECORD_READING_BITS & ~fromUnit) === 0) return null;
  const orgId = orgOfUnit(ctx, unitId);
  if (!orgId) return null;
  if (!scope.orgs[orgId]?.roles.includes('owner')) {
    throw forbidden(`${act.you} would give you a role that reads Marines’ records. A Unit Instance owner, or the unit’s chain of command, does that for you.`, 'self_grant');
  }
  const unit = getUnit(ctx, unitId);
  return () => notifyOrg(ctx, orgId, 'org.owners', {
    kind: 'system',
    title: `${actor.first_name} ${actor.last_name} ${act.they} in ${unit?.short_name || unit?.name || unitId}`,
    message: 'That reads Marines’ records. If it was not agreed, undo it and review the audit trail.',
    actionUrl: '/console/people',
  }, actor.id);
}

export function canManageRoleDefinition(ctx: AppContext, actor: SessionUser, scope: Scope, role: RoleRow): boolean {
  if (isUnitOwner(ctx, actor.id, role.unit_id)) return true;
  if (orgStaffing(ctx, scope, role.unit_id)) return role.key !== 'unit-leader';
  if (!can(scope, PERMISSIONS.MANAGE_ROLES, role.unit_id)) return false;
  return role.position < positionIn(scope, role.unit_id);
}

export function validateRoleDefinition(ctx: AppContext, actor: SessionUser, scope: Scope, def: { name: string; position: number; permissions: number; unit_id: string }, existing?: RoleRow) {
  const name = String(def.name || '').trim();
  if (!name || name.length > 60) throw badRequest('A role needs a name under 60 characters.', { fieldErrors: { name: 'Required (limit 60 characters).' } });
  if (!Number.isInteger(def.position) || def.position < 0 || def.position > 99) throw badRequest('Position must be a whole number from 0 to 99.', { fieldErrors: { position: '0 to 99.' } });
  if (!Number.isInteger(def.permissions) || def.permissions < 0 || (def.permissions & ~ALL_PERMISSIONS) !== 0) throw badRequest('Unknown permission bits.');
  if (!getUnit(ctx, def.unit_id)) throw notFound('No such unit.');
  const owner = isUnitOwner(ctx, actor.id, def.unit_id) || Boolean(orgStaffing(ctx, scope, def.unit_id));
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

/**
 * Enrolling an existing account directly skips that person's consent, so it is limited to people the actor
 * already leads: someone below them in a unit where they manage members. Everyone else joins by invitation.
 * Leading someone in one Unit Instance is no claim on them in another (ADR-0008): the unit where the actor leads
 * them must sit in the same organization as the unit they are being enrolled in.
 */
export function mayEnrollDirectly(ctx: AppContext, _actor: SessionUser, scope: Scope, targetId: string, destinationUnitId: string): boolean {
  const destinationOrg = orgOfUnit(ctx, destinationUnitId);
  if (!destinationOrg) return false;
  const target = scopeFor(ctx, { id: targetId });
  return target.unitIds.some((u) => target.unitOrg[u] === destinationOrg && can(scope, PERMISSIONS.MANAGE_MEMBERS, u) && positionIn(scope, u) > positionIn(target, u));
}

/** A role may be handed out only by someone who could have defined it: below their position, within their own permissions. */
export function assertMayGrantRole(ctx: AppContext, actor: SessionUser, scope: Scope, role: RoleRow, unitId: string) {
  if (role.unit_id !== unitId) throw forbidden('That role belongs to another unit.', 'scope');
  if (role.key === 'unit-leader') throw badRequest('Unit Leader is granted by ownership transfer, not by invitation.');
  if (isUnitOwner(ctx, actor.id, unitId) || orgStaffing(ctx, scope, unitId)) return;
  if (!can(scope, PERMISSIONS.MANAGE_ROLES, unitId)) throw forbidden('You cannot grant roles in that unit.');
  if (role.position >= positionIn(scope, unitId)) throw forbidden('You cannot grant a role at or above your own.', 'hierarchy');
  const mine = scope.permissions[unitId] || 0;
  if (!has(mine, PERMISSIONS.ADMINISTRATOR) && (role.permissions & ~mine) !== 0) throw forbidden('That role carries permissions you do not hold yourself.', 'delegation');
}

export function validateRoleGrant(ctx: AppContext, actor: SessionUser, scope: Scope, role: RoleRow | undefined, unitId: string, targetId: string) {
  if (!role) throw notFound('No such role.');
  if (role.unit_id !== unitId) throw forbidden('That role belongs to another unit.', 'scope');
  if (role.key === 'unit-leader' && !isUnitOwner(ctx, targetId, unitId)) throw badRequest('Transfer unit ownership to grant the Unit Leader role.');
  const targetScope = scopeFor(ctx, { id: targetId });
  if (!targetScope.unitIds.includes(unitId)) throw badRequest('That Marine is not a member of this unit.');
  if (isUnitOwner(ctx, actor.id, unitId)) return;
  if (orgStaffing(ctx, scope, unitId)) {
    guardSelfReach(ctx, actor, scope, unitId, role.permissions, targetId, { you: `Granting yourself ${role.name}`, they: `gave themselves ${role.name}` });
    return;
  }
  if (!can(scope, PERMISSIONS.MANAGE_ROLES, unitId)) throw forbidden('You cannot manage roles in that unit.');
  if (role.position >= positionIn(scope, unitId)) throw forbidden('You cannot grant a role at or above your own.', 'hierarchy');
  const mine = scope.permissions[unitId] || 0;
  if (!has(mine, PERMISSIONS.ADMINISTRATOR) && (role.permissions & ~mine) !== 0) throw forbidden('That role carries permissions you do not hold yourself.', 'delegation');
  if (targetId !== actor.id && positionIn(targetScope, unitId) >= positionIn(scope, unitId)) throw forbidden('You cannot change roles for a Marine at or above your position.', 'hierarchy');
}

/** The entries a Marine logs about their own work. Team tasks, projects and goals stay with the team; awards and counselings are written by leaders. */
const OWN_ENTRY_TABLES = ['activities', 'trainings'] as const;

export interface MoveResult { roles: string[]; rolesSkipped: string[]; entriesMoved: number; recordsFrozen: number; claimsReleased: number; sessionsRevoked: number }

/**
 * Moving a Marine between teams is a removal and an enrollment in one step: the actor must manage members of
 * both teams and outrank the Marine in each. Shared entries stay with the team the work was done for (frozen,
 * as on any departure) unless the actor asks for them to move too. Roles carry over where the new team has a
 * role with the same key that the actor may grant.
 */
export function moveMember(ctx: AppContext, actor: SessionUser, scope: Scope, userId: string, fromId: string, toId: string, { entries = 'stay', billet }: { entries?: 'stay' | 'move'; billet?: string | null } = {}): MoveResult {
  if (fromId === toId) throw badRequest('Pick a different team.');
  if (userId === actor.id) throw forbidden('A second authorized person must change your own membership.', 'self_membership_change');
  // Authority first: someone who manages neither team learns nothing here about which units exist or belong together.
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, fromId) || !can(scope, PERMISSIONS.MANAGE_MEMBERS, toId)) throw forbidden('You need to manage members of both teams to move a Marine between them.');
  if (!getUnit(ctx, fromId) || !getUnit(ctx, toId)) throw notFound('No such unit.');
  // A move carries the Marine's roles and, when asked, their entries: never into another Unit Instance (ADR-0008).
  assertSameInstance(ctx, fromId, toId, 'A Marine cannot be moved into another Unit Instance. That organization enrolls them by invitation; their records here stay here.');
  const membership = ctx.db.prepare('SELECT is_primary, billet FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, fromId) as { is_primary: number; billet: string | null } | undefined;
  if (!membership) throw notFound('That Marine is not a member of this unit.');
  if (ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, toId)) throw conflict('That Marine is already on the other team.', 'already_member');
  if (isUnitOwner(ctx, userId, fromId)) throw badRequest('That Marine leads this unit. Transfer ownership first.', { code: 'last_owner' });
  const target = scopeFor(ctx, { id: userId });
  for (const unit of [fromId, toId]) {
    if (!isUnitOwner(ctx, actor.id, unit) && positionIn(target, unit) >= positionIn(scope, unit)) throw forbidden('You cannot move a Marine at or above your own position.', 'hierarchy');
  }
  const held = ctx.db.prepare('SELECT r.key, r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id = ? AND mr.unit_id = ? AND r.is_default = 0').all(userId, fromId) as Array<{ key: string; name: string }>;
  const roles: string[] = [];
  const rolesSkipped: string[] = [];
  const result = ctx.db.transaction(() => {
    let entriesMoved = 0;
    if (entries === 'move') {
      const at = now();
      for (const table of OWN_ENTRY_TABLES) {
        entriesMoved += ctx.db.prepare(`UPDATE ${table} SET unit_id = ?, updated_at = ?, version = version + 1 WHERE user_id = ? AND unit_id = ? AND deleted_at IS NULL AND frozen_at IS NULL`).run(toId, at, userId, fromId).changes;
      }
    }
    // Out of the old team with its primary unit left unplaced, then seated in the new one, which takes it: the primary unit
    // passes straight across, never to another instance, and each team's history shows one move rather than a re-shuffle.
    const removed = removeMember(ctx, userId, fromId, actor.id, 'transfer', { promote: false });
    addMember(ctx, userId, toId, { invitedBy: actor.id, primary: Boolean(membership.is_primary), billet: billet === undefined ? membership.billet : billet, reason: 'transfer' });
    for (const h of held) {
      const role = ctx.db.prepare('SELECT * FROM roles WHERE unit_id = ? AND key = ?').get(toId, h.key) as RoleRow | undefined;
      try {
        if (!role) throw notFound('No such role.');
        assertMayGrantRole(ctx, actor, scope, role, toId);
        ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, role.id, toId, actor.id, now());
        roles.push(role.name);
      } catch { rolesSkipped.push(h.name); }
    }
    return { entriesMoved, recordsFrozen: removed.recordsFrozen, claimsReleased: removed.claimsReleased };
  })();
  return { roles, rolesSkipped, ...result, sessionsRevoked: invalidateUserSessions(ctx, userId) };
}

export interface UnitView { id: string; name: string; short_name: string | null; parent_id: string | null; depth: number; level: 'full' | 'overview'; member: boolean; teams: number }

/**
 * The views a person can switch between, in tree order: a command, then the teams beneath it. "full" means they
 * can read the unit's shared records; "overview" is the roster, goals and aggregate totals a member sees.
 */
export function viewsFor(ctx: AppContext, scope: Scope): { views: UnitView[]; defaultViewId: string | null } {
  const all = ctx.db.prepare('SELECT id, name, short_name, parent_id FROM units WHERE active = 1 ORDER BY name').all() as Array<{ id: string; name: string; short_name: string | null; parent_id: string | null }>;
  const allowed = new Set(scope.viewableUnitIds);
  const byParent = new Map<string | null, typeof all>();
  const known = new Set(all.map((u) => u.id));
  for (const u of all) {
    const key = u.parent_id && known.has(u.parent_id) ? u.parent_id : null;
    byParent.set(key, [...(byParent.get(key) || []), u]);
  }
  const views: UnitView[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const u of byParent.get(parentId) || []) {
      if (allowed.has(u.id)) views.push({ id: u.id, name: u.name, short_name: u.short_name, parent_id: u.parent_id, depth, level: can(scope, PERMISSIONS.VIEW_RECORDS, u.id) ? 'full' : 'overview', member: scope.unitIds.includes(u.id), teams: (byParent.get(u.id) || []).length });
      walk(u.id, allowed.has(u.id) ? depth + 1 : depth);
    }
  };
  walk(null, 0);
  const led = views.filter((v) => v.level === 'full').sort((a, b) => a.depth - b.depth)[0];
  // Someone who leads nothing starts on their own team, the deepest unit they belong to, even when the command is their primary unit.
  const own = views.filter((v) => v.member).sort((a, b) => b.depth - a.depth)[0];
  return { views, defaultViewId: led?.id ?? own?.id ?? (scope.primaryUnitId && allowed.has(scope.primaryUnitId) ? scope.primaryUnitId : views[0]?.id ?? null) };
}

export interface OrgSummary {
  id: string; name: string; short_name: string | null; status: string; root_unit_id: string | null;
  roles: string[]; permissions: string[]; expiresAt: string | null; member: boolean;
}

/** The organizations a person belongs to or holds a role in, with what they may do in each (ADR-0006). */
export function orgSummaries(ctx: AppContext, scope: Scope): OrgSummary[] {
  const ids = [...new Set([...scope.orgIds, ...Object.keys(scope.orgs)])];
  if (!ids.length) return [];
  const rows = ctx.db.prepare('SELECT id, name, short_name, status, root_unit_id FROM organizations WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name')
    .all(JSON.stringify(ids)) as Array<{ id: string; name: string; short_name: string | null; status: string; root_unit_id: string | null }>;
  return rows.map((o) => ({
    ...o,
    roles: scope.orgs[o.id]?.roles ?? [],
    permissions: scope.orgs[o.id]?.permissions ?? [],
    expiresAt: scope.orgs[o.id]?.expiresAt ?? null,
    member: scope.orgIds.includes(o.id),
  }));
}
