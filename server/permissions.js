/**
 * Vantage — visibility.
 *
 * One question decides almost everything: which people can this user see, and
 * what may they do to them? Everything else — roster, shared tasks, unit goals,
 * rolled-up reports — falls out of the answer, so it is computed in exactly one
 * place.
 *
 * Roles are stackable and scoped to a unit. A role with `inherits_down` applies
 * to that unit's whole subtree; without it, to that unit alone. That single flag
 * is the difference between a fire team leader and a section head, and it means
 * neither of them is a special case in the code.
 *
 * Nothing here reads rank. A Sergeant running a fire team outranks a Corporal in
 * another section but has no business in that section's records.
 */

import { PERMISSIONS, has, ALL_PERMISSIONS } from './roles.js';

export { PERMISSIONS, has };

/* ── unit tree ────────────────────────────────────────────────────── */

function unitIndex(db) {
  const units = db.prepare('SELECT id, parent_id FROM units WHERE active = 1').all();
  const byParent = new Map();
  const parentOf = new Map();
  for (const u of units) {
    parentOf.set(u.id, u.parent_id);
    if (!byParent.has(u.parent_id)) byParent.set(u.parent_id, []);
    byParent.get(u.parent_id).push(u.id);
  }
  return { byParent, parentOf };
}

/** Every unit id at or beneath the given roots. */
export function subtreeIds(db, rootIds = []) {
  if (!rootIds.length) return [];
  const { byParent } = unitIndex(db);
  const out = new Set();
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.shift();
    if (out.has(id)) continue;
    out.add(id);
    for (const child of byParent.get(id) || []) queue.push(child);
  }
  return [...out];
}

/** Ancestor chain for a unit, nearest first. */
export function ancestorChain(db, unitId) {
  const chain = [];
  let current = unitId;
  const seen = new Set();
  while (current && !seen.has(current)) {
    seen.add(current);
    const unit = db.prepare('SELECT id, code, name, short_name, echelon, parent_id FROM units WHERE id = ?').get(current);
    if (!unit) break;
    chain.push(unit);
    current = unit.parent_id;
  }
  return chain;
}

export function ancestorIds(db, unitIds = []) {
  const out = new Set();
  for (const id of unitIds) for (const u of ancestorChain(db, id)) out.add(u.id);
  return [...out];
}

/* ── effective permissions ────────────────────────────────────────── */

/**
 * Fold every role a user holds into a map of unit id → permission bits.
 *
 * A role granted at CE-G8 with inherits_down set contributes its bits to G-8
 * and to Budget, Accounting, Audit Readiness and FMRAC beneath it. The same
 * role without the flag contributes to CE-G8 alone.
 */
export function permissionMap(db, user) {
  const grants = db
    .prepare(
      `SELECT mr.unit_id, r.permissions, r.inherits_down, r.position
         FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
        WHERE mr.user_id = ?`
    )
    .all(user.id);

  const map = new Map();
  const add = (unitId, bits) => map.set(unitId, (map.get(unitId) || 0) | bits);

  let global = 0;
  let topPosition = 0;

  for (const g of grants) {
    topPosition = Math.max(topPosition, g.position);
    if (g.permissions & PERMISSIONS.ADMINISTRATOR) global |= ALL_PERMISSIONS;
    const targets = g.inherits_down ? subtreeIds(db, [g.unit_id]) : [g.unit_id];
    for (const unitId of targets) add(unitId, g.permissions);
  }

  // Legacy `users.is_admin` still grants everything, so an install created
  // before roles existed doesn't lock its own administrator out.
  if (user.is_admin) {
    global |= ALL_PERMISSIONS;
    topPosition = Math.max(topPosition, 100);
  }

  if (global) {
    for (const u of db.prepare('SELECT id FROM units WHERE active = 1').all()) add(u.id, global);
  }

  return { map, global, topPosition };
}

/** Permission bits this user holds inside a specific unit. */
export function permissionsIn(db, user, unitId) {
  const { map, global } = permissionMap(db, user);
  return (map.get(unitId) || 0) | global;
}

export function can(db, user, flag, unitId) {
  return has(permissionsIn(db, user, unitId), flag);
}

/** True if the user holds `flag` anywhere at all. */
export function canAnywhere(db, user, flag) {
  const { map, global } = permissionMap(db, user);
  if (has(global, flag)) return true;
  for (const bits of map.values()) if (has(bits, flag)) return true;
  return false;
}

/** Units where this user holds a given permission. */
export function unitsWith(db, user, flag) {
  const { map, global } = permissionMap(db, user);
  const out = [];
  for (const [unitId, bits] of map) if (has(bits | global, flag)) out.push(unitId);
  return out;
}

/* ── scope ────────────────────────────────────────────────────────── */

/**
 * Everything a user's assignments and roles grant them.
 */
export function resolveScope(db, user) {
  const assignments = db
    .prepare(
      `SELECT a.*, u.code AS unit_code, u.name AS unit_name, u.short_name AS unit_short, u.echelon,
              b.title AS billet_title
         FROM assignments a
         JOIN units u ON u.id = a.unit_id
         LEFT JOIN billets b ON b.id = a.billet_id
        WHERE a.user_id = ? AND (a.end_date IS NULL OR a.end_date > date('now'))`
    )
    .all(user.id);

  const roles = db
    .prepare(
      `SELECT mr.unit_id, r.id, r.name, r.color, r.position, r.permissions, r.inherits_down,
              u.short_name AS unit_short, u.name AS unit_name
         FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         JOIN units u ON u.id = mr.unit_id
        WHERE mr.user_id = ?
        ORDER BY r.position DESC`
    )
    .all(user.id);

  const { map, global, topPosition } = permissionMap(db, user);
  const unitIds = [...new Set(assignments.map((a) => a.unit_id))];

  // Units whose members this user may see.
  const scopeUnitIds = [];
  for (const [unitId, bits] of map) {
    if (has(bits | global, PERMISSIONS.VIEW_RECORDS)) scopeUnitIds.push(unitId);
  }

  return {
    assignments,
    roles,
    unitIds,
    ancestorUnitIds: ancestorIds(db, unitIds),
    scopeUnitIds,
    topPosition,
    permissions: Object.fromEntries(map),
    globalPermissions: global,
    canLead: scopeUnitIds.length > 0,
  };
}

/** User ids this user may read personnel records for. Always includes themselves. */
export function visibleUserIds(db, user) {
  const { scopeUnitIds } = resolveScope(db, user);
  const ids = new Set([user.id]);
  if (scopeUnitIds.length) {
    const placeholders = scopeUnitIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT a.user_id
           FROM assignments a
           JOIN users u ON u.id = a.user_id
          WHERE a.unit_id IN (${placeholders})
            AND u.active = 1
            AND (a.end_date IS NULL OR a.end_date > date('now'))`
      )
      .all(...scopeUnitIds);
    for (const r of rows) ids.add(r.user_id);
  }
  return [...ids];
}

/**
 * SQL fragment restricting a table to what this user may read.
 *
 *   A  It's mine. Any visibility, including private.
 *   B  It belongs to someone whose unit I can view records in, and they didn't
 *      mark it private. This is how logged work rolls up on its own.
 *   C  It was posted to a unit I'm assigned to.
 *   D  It was posted down a chain running through my unit or one above it.
 *
 * A and B are kept separate deliberately: collapsing them leaked every private
 * record a subordinate had ever written.
 */
export function visibilityClause(db, user, { table = 't' } = {}) {
  const { unitIds, ancestorUnitIds, scopeUnitIds } = resolveScope(db, user);
  const subordinates = visibleUserIds(db, user).filter((id) => id !== user.id);

  const parts = [`${table}.user_id = ?`];
  const params = [user.id];

  if (subordinates.length) {
    parts.push(`(${table}.user_id IN (${subordinates.map(() => '?').join(',')}) AND ${table}.visibility <> 'private')`);
    params.push(...subordinates);
  }
  if (unitIds.length) {
    parts.push(`(${table}.visibility = 'unit' AND ${table}.unit_id IN (${unitIds.map(() => '?').join(',')}))`);
    params.push(...unitIds);
  }
  if (ancestorUnitIds.length) {
    parts.push(`(${table}.visibility = 'chain' AND ${table}.unit_id IN (${ancestorUnitIds.map(() => '?').join(',')}))`);
    params.push(...ancestorUnitIds);
  }
  if (scopeUnitIds.length) {
    parts.push(`(${table}.visibility = 'chain' AND ${table}.unit_id IN (${scopeUnitIds.map(() => '?').join(',')}))`);
    params.push(...scopeUnitIds);
  }

  return { clause: `(${parts.join(' OR ')})`, params };
}

/** Can this user act on this specific row? */
export function canEdit(db, user, row) {
  if (!row) return false;
  if (row.user_id === user.id) return true;
  // A private record is private from everyone, including administrators.
  if (row.visibility === 'private') return false;
  return Boolean(row.unit_id && can(db, user, PERMISSIONS.MANAGE_RECORDS, row.unit_id));
}

/**
 * Where a record may be posted.
 *
 * Your own unit is always fair game: a Lance Corporal logging their work so the
 * section can see it needs no permission. Posting to a unit you are not in means
 * broadcasting to people who don't work for you, and that needs a role.
 */
export function canShareTo(db, user, visibility, unitId, flag = PERMISSIONS.CREATE_SHARED_WORK) {
  if (visibility === 'private') return true;
  if (!unitId) return false;
  const { unitIds } = resolveScope(db, user);
  if (unitIds.includes(unitId)) return true;
  return can(db, user, flag, unitId);
}

/**
 * Role hierarchy. You cannot create, edit, delete or hand out a role at or
 * above your own highest position — otherwise anyone who can manage roles can
 * promote themselves to administrator and the whole model is decorative.
 */
export function canManageRole(db, user, role) {
  if (!role) return false;
  const { topPosition, global } = permissionMap(db, user);
  if (has(global, PERMISSIONS.ADMINISTRATOR) && topPosition >= 100) return true;
  if (!canAnywhere(db, user, PERMISSIONS.MANAGE_ROLES)) return false;
  return role.position < topPosition;
}

export const VISIBILITIES = ['private', 'unit', 'chain'];

export const VISIBILITY_LABELS = {
  private: 'Only me',
  unit: 'Everyone in the unit',
  chain: 'The unit and everyone under it',
};
