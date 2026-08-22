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
 * v3.4 keeps `validateRoleDefinition`'s shape and narrows it (Regression Debt,
 * v3.3 finding 1). Everything cross-unit is gone, because under tenancy there
 * is no cross-unit case left to judge:
 *
 *   roles.unit_id is NOT NULL, so there is no org-wide definition branch.
 *   inherits_down is gone, so there is no cascade to bound.
 *   A role may only ever be granted inside the unit it belongs to, so
 *   "reach" is always exactly one unit.
 *
 * What survives is the part that was actually load-bearing: delegation is a
 * subset operation. A non-owner can only put a permission into someone's hands
 * if they hold that permission themselves, in that unit, and can only act on
 * roles below their own position on that unit's own scale.
 */

import { PERMISSIONS, ALL_PERMISSIONS, has } from './roles.js';
import { permissionsIn, positionIn, isUnitOwner, isMember, unitsWith } from './permissions.js';

const ok = () => ({ ok: true });
const deny = (code, message) => ({ ok: false, code, message });

/**
 * Units in which this actor may exercise role management.
 *
 * v3.3 had `isTrueAdmin` here — "holds the ADMINISTRATOR bit somewhere, or
 * legacy is_admin" — and it short-circuited every check below it. That is the
 * cross-tenant superuser of finding 4 and it is deleted. Full authority inside
 * a unit is now `isUnitOwner`, which names the unit, and instance-level
 * authority is the Instance Operator, which holds no permission bits at all.
 */
export function roleManagementUnits(db, user) {
  return unitsWith(db, user, PERMISSIONS.MANAGE_ROLES);
}

/**
 * Every unit a role definition reaches. Always exactly one: itself.
 *
 * Kept as a named function rather than inlined so that the day someone
 * reintroduces a cascade, they have to change a function whose entire body is
 * a comment explaining why it does not cascade.
 */
export function roleReach(db, def) {
  return def.unit_id ? [def.unit_id] : [];
}

/**
 * Permission bits the actor may delegate in a unit: exactly what they hold
 * there. ADMINISTRATOR is never delegatable by a non-owner, even if a stray
 * grant gave them the bit — minting full authority is an owner's act.
 */
function delegatableIn(db, user, unitId) {
  return permissionsIn(db, user, unitId) & ~PERMISSIONS.ADMINISTRATOR;
}

/**
 * validateRoleDefinition(db, actor, def, { existing })
 *
 * `def` is the role as it would exist AFTER the operation — for edits, the
 * merged result, so a request that changes only `permissions` is still judged
 * on the whole definition it produces. Returns { ok } or { ok, code, message }.
 */
export function validateRoleDefinition(db, actor, def, { existing = null } = {}) {
  /* Shape first — these apply to unit owners too. */
  if (!def.name || typeof def.name !== 'string' || !def.name.trim()) return deny('invalid', 'A role needs a name.');
  if (def.name.length > 80) return deny('invalid', 'Role names are limited to 80 characters.');
  if (def.description && String(def.description).length > 500) return deny('invalid', 'Description is limited to 500 characters.');

  const bits = Number(def.permissions) || 0;
  if (!Number.isInteger(bits) || bits < 0 || (bits & ~ALL_PERMISSIONS)) {
    return deny('invalid', 'The permission set contains bits Vantage does not define.');
  }
  const pos = Number(def.position);
  if (!Number.isInteger(pos) || pos < 0 || pos > 100) {
    return deny('invalid', 'Position must be a whole number from 0 to 100.');
  }

  // A role with no unit is the thing v3.4 does not have (finding 1).
  if (!def.unit_id) return deny('invalid', 'A role belongs to exactly one unit.');
  const unit = db.prepare('SELECT id FROM units WHERE id = ? AND active = 1').get(def.unit_id);
  if (!unit) return deny('invalid', 'The role scope points at a unit that does not exist.');

  // A role cannot be moved between units. Two units' role sets are unrelated,
  // so "move" is meaningless — it would silently re-scope every live grant.
  if (existing && existing.unit_id !== def.unit_id) {
    return deny('scope', 'A role belongs to the unit it was made in. Create one in the other unit instead.');
  }

  /* The Unit Owner has full authority over their own unit's role set —
   * including roles marked is_system, which under v3.4 means only "this row
   * came from a template" and confers no edit protection (finding 1). */
  if (isUnitOwner(db, actor.id, def.unit_id)) return ok();

  const manageUnits = roleManagementUnits(db, actor);
  if (!manageUnits.includes(def.unit_id)) {
    return deny('scope', 'You cannot manage roles in that unit.');
  }

  const top = positionIn(db, actor, def.unit_id);
  if (pos >= top) return deny('position', 'You cannot place a role at or above your own position in this unit.');
  if (existing && existing.position >= top) {
    return deny('position', 'That role is at or above your own.');
  }

  if (bits & PERMISSIONS.ADMINISTRATOR) {
    return deny('escalation', 'Only the unit owner can put the Administrator permission into a role.');
  }

  const delegatable = delegatableIn(db, actor, def.unit_id);
  if (bits & ~delegatable) {
    return deny('escalation', 'The role contains a permission you do not hold in this unit, so you cannot delegate it.');
  }

  return ok();
}

/**
 * validateRoleGrant(db, actor, role, targetUnitId, targetUser)
 *
 * The grant path re-checks delegation on purpose: a pre-existing role that is
 * broader than the granter (made by the owner, say) must not become a
 * privilege ladder just because it already exists.
 */
export function validateRoleGrant(db, actor, role, targetUnitId, targetUser = null) {
  if (!role) return deny('not_found', 'No such role.');
  if (!targetUnitId) return deny('invalid', 'A unit is required.');
  const unit = db.prepare('SELECT id FROM units WHERE id = ? AND active = 1').get(targetUnitId);
  if (!unit) return deny('invalid', 'No such unit.');
  if (targetUser && !targetUser.active) return deny('invalid', 'That account is deactivated. Reactivate it before granting roles.');

  /* A role belongs to one unit and may only be granted there. In v3.3 this was
   * a subtree test with an org-wide escape hatch; both are gone. */
  if (role.unit_id !== targetUnitId) {
    return deny('scope', 'That role belongs to another unit and can only be granted there.');
  }

  /* Membership is stated, not inferred (finding 8). Granting a role to
   * somebody who is not in the unit would create authority with no
   * corresponding membership row, and permissionMap — which joins through
   * unit_members — would silently ignore it. Failing loudly here is better
   * than a grant that appears to work and does nothing. */
  if (targetUser && !isMember(db, targetUser.id, targetUnitId)) {
    return deny('not_member', 'That Marine is not a member of this unit. Add them to the unit first.');
  }

  if (isUnitOwner(db, actor.id, targetUnitId)) return ok();

  if (!has(permissionsIn(db, actor, targetUnitId), PERMISSIONS.MANAGE_ROLES)) {
    return deny('forbidden', 'You cannot manage roles in that unit.');
  }
  const top = positionIn(db, actor, targetUnitId);
  if (role.position >= top) return deny('position', 'That role is at or above your own.');
  if (role.permissions & PERMISSIONS.ADMINISTRATOR) {
    return deny('escalation', 'Only the unit owner can grant an administrator role.');
  }

  const delegatable = delegatableIn(db, actor, targetUnitId);
  if (role.permissions & ~delegatable) {
    return deny('escalation', 'That role carries a permission you do not hold in this unit, so you cannot grant it.');
  }
  return ok();
}

/**
 * Edit/delete authorization for an existing role.
 *
 * v3.3 refused outright on `role.is_system`, because a system role was a
 * shared global object and editing it changed it for everyone. Under v3.4
 * every role is unit-local, so `is_system` is only provenance and the owning
 * unit may do as it likes with its own copy (finding 1).
 */
export function canManageRoleDefinition(db, actor, role) {
  if (!role || !role.unit_id) return false;
  if (isUnitOwner(db, actor.id, role.unit_id)) return true;
  if (!roleManagementUnits(db, actor).includes(role.unit_id)) return false;
  return role.position < positionIn(db, actor, role.unit_id);
}
