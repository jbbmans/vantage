import { PERMISSIONS, ALL_PERMISSIONS, has } from './roles.js';
import { permissionsIn, positionIn, isUnitOwner, isMember, unitsWith } from './permissions.js';

const ok = () => ({ ok: true });
const deny = (code, message) => ({ ok: false, code, message });

export function roleManagementUnits(db, user) {
  return unitsWith(db, user, PERMISSIONS.MANAGE_ROLES);
}

export function roleReach(db, def) {
  return def.unit_id ? [def.unit_id] : [];
}

function delegatableIn(db, user, unitId) {
  return permissionsIn(db, user, unitId) & ~PERMISSIONS.ADMINISTRATOR;
}

export function validateRoleDefinition(db, actor, def, { existing = null } = {}) {

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

  if (!def.unit_id) return deny('invalid', 'A role belongs to exactly one unit.');
  const unit = db.prepare('SELECT id FROM units WHERE id = ? AND active = 1').get(def.unit_id);
  if (!unit) return deny('invalid', 'The role scope points at a unit that does not exist.');

  if (existing && existing.unit_id !== def.unit_id) {
    return deny('scope', 'A role belongs to the unit it was made in. Create one in the other unit instead.');
  }

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

export function validateRoleGrant(db, actor, role, targetUnitId, targetUser = null) {
  if (!role) return deny('not_found', 'No such role.');
  if (!targetUnitId) return deny('invalid', 'A unit is required.');
  const unit = db.prepare('SELECT id FROM units WHERE id = ? AND active = 1').get(targetUnitId);
  if (!unit) return deny('invalid', 'No such unit.');
  if (targetUser && !targetUser.active) return deny('invalid', 'That account is deactivated. Reactivate it before granting roles.');

  if (role.unit_id !== targetUnitId) {
    return deny('scope', 'That role belongs to another unit and can only be granted there.');
  }

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

export function canManageRoleDefinition(db, actor, role) {
  if (!role || !role.unit_id) return false;
  if (isUnitOwner(db, actor.id, role.unit_id)) return true;
  if (!roleManagementUnits(db, actor).includes(role.unit_id)) return false;
  return role.position < positionIn(db, actor, role.unit_id);
}
