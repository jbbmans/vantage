/**
 * Vantage — role authority.
 *
 * v3.2 had three slightly different permission checks for creating, editing and
 * granting roles, and the differences were the vulnerability: role *creation*
 * refused to mint permissions the creator didn't hold, but role *editing*
 * didn't, so anyone with MANAGE_ROLES could edit a low custom role into an
 * administrator role and hand it to themselves. This file is the one place the
 * question is answered, and all three routes ask it.
 *
 * The model it enforces:
 *
 *   roles.unit_id = NULL  →  organization-wide role definition. Only a true
 *                            administrator may create, edit or delete one.
 *   roles.unit_id = X     →  the definition belongs to X. It may only be
 *                            granted inside X's subtree, and only managed by
 *                            someone whose MANAGE_ROLES authority covers X.
 *
 * And for every path — create, edit, grant — a non-administrator can only put
 * a permission into someone's hands if they hold that permission themselves in
 * the units the role will reach. Delegation is a subset operation, always.
 */

import { PERMISSIONS, ALL_PERMISSIONS, has } from './roles.js';
import { permissionMap, permissionsIn, unitsWith, subtreeIds, canAnywhere } from './permissions.js';

const ok = () => ({ ok: true });
const deny = (code, message) => ({ ok: false, code, message });

/** True administrator: holds the ADMINISTRATOR bit somewhere (or legacy is_admin). */
export function isTrueAdmin(db, user) {
  if (user.is_admin) return true;
  return canAnywhere(db, user, PERMISSIONS.ADMINISTRATOR);
}

/**
 * Units in which this actor may exercise role management. The grant that
 * carries MANAGE_ROLES cascades with inherits_down the same way every other
 * permission does, so this is simply "where do you hold the bit".
 */
export function roleManagementUnits(db, user) {
  return unitsWith(db, user, PERMISSIONS.MANAGE_ROLES);
}

/** Every unit a role definition reaches: its scope unit plus, if it cascades, the subtree. */
export function roleReach(db, def) {
  if (!def.unit_id) return null; // org-wide
  return def.inherits_down ? subtreeIds(db, [def.unit_id]) : [def.unit_id];
}

/**
 * Permission bits the actor may delegate across a set of units: the
 * intersection of what they hold in each. Holding EXPORT_DATA in G-8 does not
 * let you put EXPORT_DATA into a role that reaches a unit where you don't.
 */
function delegatableAcross(db, user, unitIds) {
  let bits = ALL_PERMISSIONS;
  for (const unitId of unitIds) bits &= permissionsIn(db, user, unitId);
  // ADMINISTRATOR is never delegatable by a non-admin, even if a stray grant
  // gave them the bit in one unit — creating admins is an admin act.
  return bits & ~PERMISSIONS.ADMINISTRATOR;
}

/**
 * validateRoleDefinition(db, actor, def, { existing })
 *
 * `def` is the role as it would exist AFTER the operation — for edits, the
 * merged result, so a request that changes only `permissions` is still judged
 * on the whole definition it produces. Returns { ok } or { ok, code, message }.
 */
export function validateRoleDefinition(db, actor, def, { existing = null } = {}) {
  /* Shape first — these apply to administrators too. */
  if (!def.name || typeof def.name !== 'string' || !def.name.trim()) return deny('invalid', 'A role needs a name.');
  if (def.name.length > 80) return deny('invalid', 'Role names are limited to 80 characters.');
  if (def.description && String(def.description).length > 500) return deny('invalid', 'Description is limited to 500 characters.');

  const bits = Number(def.permissions) || 0;
  if (!Number.isInteger(bits) || bits < 0 || (bits & ~ALL_PERMISSIONS)) {
    return deny('invalid', 'The permission set contains bits Vantage does not define.');
  }
  const pos = Number(def.position);
  if (!Number.isInteger(pos) || pos < 0 || pos > 99) {
    return deny('invalid', 'Position must be a whole number from 0 to 99.');
  }
  if (def.unit_id) {
    const unit = db.prepare('SELECT id FROM units WHERE id = ? AND active = 1').get(def.unit_id);
    if (!unit) return deny('invalid', 'The role scope points at a unit that does not exist.');
  }
  if (existing?.is_system) return deny('system_role', 'Built-in roles cannot be edited. Copy one into a new role instead.');

  const admin = isTrueAdmin(db, actor);
  if (admin) return ok();

  /* Everything below is the non-administrator path. */
  const manageUnits = roleManagementUnits(db, actor);
  if (!manageUnits.length) return deny('forbidden', 'You cannot manage roles.');

  const { topPosition } = permissionMap(db, actor);
  if (pos >= topPosition) return deny('position', 'You cannot place a role at or above your own position.');
  if (existing && existing.position >= topPosition) {
    return deny('position', 'That role is at or above your own.');
  }

  if (has(bits, PERMISSIONS.ADMINISTRATOR) || (bits & PERMISSIONS.ADMINISTRATOR)) {
    return deny('escalation', 'Only an administrator can put the Administrator permission into a role.');
  }

  /* Scope. Org-wide definitions are an administrator's to make: a definition
   * with no unit can be granted anywhere, which is exactly the reach a
   * section-level leader does not have. */
  if (!def.unit_id) return deny('scope', 'Choose a unit scope for this role. Organization-wide roles are created by administrators.');
  if (!manageUnits.includes(def.unit_id)) {
    return deny('scope', 'That unit is outside your role-management authority.');
  }
  if (existing?.unit_id && !manageUnits.includes(existing.unit_id)) {
    return deny('scope', 'That role belongs to a unit outside your authority.');
  }
  if (existing && !existing.unit_id) {
    return deny('scope', 'That is an organization-wide role; only an administrator can change it.');
  }

  /* Cascade cannot expand past the actor's own authorized subtree. */
  const reach = roleReach(db, def);
  for (const unitId of reach) {
    if (!manageUnits.includes(unitId)) {
      return deny('scope', 'This role would cascade into units outside your authority. Narrow the scope or remove inheritance.');
    }
  }

  /* Delegation is a subset operation across every unit the role reaches. */
  const delegatable = delegatableAcross(db, actor, reach);
  if (bits & ~delegatable) {
    return deny('escalation', 'The role contains a permission you do not hold in its full scope, so you cannot delegate it.');
  }

  return ok();
}

/**
 * validateRoleGrant(db, actor, role, targetUnitId, targetUser)
 *
 * The grant path re-checks delegation on purpose: a pre-existing role that is
 * broader than the granter (made by an administrator, say) must not become a
 * privilege ladder just because it already exists.
 */
export function validateRoleGrant(db, actor, role, targetUnitId, targetUser = null) {
  if (!role) return deny('not_found', 'No such role.');
  if (!targetUnitId) return deny('invalid', 'A unit is required.');
  const unit = db.prepare('SELECT id FROM units WHERE id = ? AND active = 1').get(targetUnitId);
  if (!unit) return deny('invalid', 'No such unit.');
  if (targetUser && !targetUser.active) return deny('invalid', 'That account is deactivated. Reactivate it before granting roles.');

  /* Definition scope binds everyone, administrators included — a role built
   * for one section granted into another is a bookkeeping error even with
   * full authority. Org-wide roles (unit_id NULL) may go anywhere. */
  if (role.unit_id) {
    const within = subtreeIds(db, [role.unit_id]);
    if (!within.includes(targetUnitId)) {
      return deny('scope', `That role is scoped to ${role.unit_id} and can only be granted inside it.`);
    }
  }

  if (isTrueAdmin(db, actor)) return ok();

  if (!has(permissionsIn(db, actor, targetUnitId), PERMISSIONS.MANAGE_ROLES)) {
    return deny('forbidden', 'You cannot manage roles in that unit.');
  }
  const { topPosition } = permissionMap(db, actor);
  if (role.position >= topPosition) return deny('position', 'That role is at or above your own.');
  if (role.permissions & PERMISSIONS.ADMINISTRATOR) {
    return deny('escalation', 'Only an administrator can grant an administrator role.');
  }

  const reach = role.inherits_down ? subtreeIds(db, [targetUnitId]) : [targetUnitId];
  const delegatable = delegatableAcross(db, actor, reach);
  if (role.permissions & ~delegatable) {
    return deny('escalation', 'That role carries a permission you do not hold across its reach, so you cannot grant it.');
  }
  return ok();
}

/** Edit/delete authorization for an existing role — findings 6 and 7. */
export function canManageRoleDefinition(db, actor, role) {
  if (!role || role.is_system) return false;
  if (isTrueAdmin(db, actor)) return true;
  if (!role.unit_id) return false; // org-wide: admin only
  const manageUnits = roleManagementUnits(db, actor);
  if (!manageUnits.includes(role.unit_id)) return false;
  const { topPosition } = permissionMap(db, actor);
  return role.position < topPosition;
}
