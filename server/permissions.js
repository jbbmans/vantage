import { PERMISSIONS, has, ALL_PERMISSIONS } from './roles.js';

export { PERMISSIONS, has };

const LIVE_MEMBERSHIP = `(um.expires_at IS NULL OR um.expires_at > datetime('now'))`;

export function membershipsOf(db, userId) {
  return db
    .prepare(
      `SELECT um.unit_id, um.kind, um.joined_at, um.expires_at,
              u.name AS unit_name, u.short_name AS unit_short, u.code AS unit_code, u.level, u.data_mode
         FROM unit_members um
         JOIN units u ON u.id = um.unit_id
        WHERE um.user_id = ? AND u.active = 1 AND ${LIVE_MEMBERSHIP}
        ORDER BY um.joined_at`
    )
    .all(userId);
}

export function memberUnitIds(db, userId) {
  return membershipsOf(db, userId).map((m) => m.unit_id);
}

export function membershipKind(db, userId, unitId) {
  if (!unitId) return null;
  const row = db
    .prepare(
      `SELECT um.kind FROM unit_members um JOIN units u ON u.id = um.unit_id
        WHERE um.user_id = ? AND um.unit_id = ? AND u.active = 1 AND ${LIVE_MEMBERSHIP} LIMIT 1`
    )
    .get(userId, unitId);
  return row ? row.kind : null;
}

export function isMember(db, userId, unitId) {
  if (!unitId) return false;
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM unit_members um JOIN units u ON u.id = um.unit_id
          WHERE um.user_id = ? AND um.unit_id = ? AND u.active = 1 AND ${LIVE_MEMBERSHIP} LIMIT 1`
      )
      .get(userId, unitId)
  );
}

export function isUnitOwner(db, userId, unitId) {
  if (!unitId) return false;
  const unit = db.prepare('SELECT owner_user_id FROM units WHERE id = ? AND active = 1').get(unitId);
  return Boolean(unit && unit.owner_user_id && unit.owner_user_id === userId);
}

export function permissionMap(db, user) {
  const grants = db
    .prepare(
      `SELECT mr.unit_id, r.permissions, r.position
         FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         JOIN units u ON u.id = mr.unit_id
         JOIN unit_members um ON um.user_id = mr.user_id AND um.unit_id = mr.unit_id
        WHERE mr.user_id = ? AND r.unit_id = mr.unit_id
          AND u.active = 1 AND ${LIVE_MEMBERSHIP}`
    )
    .all(user.id);

  const map = new Map();
  const positions = new Map();
  const add = (unitId, bits) => map.set(unitId, (map.get(unitId) || 0) | bits);

  for (const g of grants) {
    add(g.unit_id, g.permissions);
    positions.set(g.unit_id, Math.max(positions.get(g.unit_id) || 0, g.position));
  }

  for (const row of db.prepare('SELECT id FROM units WHERE owner_user_id = ? AND active = 1').all(user.id)) {
    add(row.id, ALL_PERMISSIONS);
    positions.set(row.id, Math.max(positions.get(row.id) || 0, 100));
  }

  const topPosition = positions.size ? Math.max(...positions.values()) : 0;
  return { map, positions, topPosition };
}

export function permissionsIn(db, user, unitId) {
  if (!unitId) return 0;
  const { map } = permissionMap(db, user);
  return map.get(unitId) || 0;
}

export function positionIn(db, user, unitId) {
  if (!unitId) return 0;
  const { positions } = permissionMap(db, user);
  return positions.get(unitId) || 0;
}

export function can(db, user, flag, unitId) {
  return has(permissionsIn(db, user, unitId), flag);
}

export function unitsWith(db, user, flag) {
  const { map } = permissionMap(db, user);
  const out = [];
  for (const [unitId, bits] of map) if (has(bits, flag)) out.push(unitId);
  return out;
}

export function resolveScope(db, user) {
  const memberships = membershipsOf(db, user.id);
  const unitIds = memberships.map((m) => m.unit_id);

  const assignments = db
    .prepare(
      `SELECT a.*, u.code AS unit_code, u.name AS unit_name, u.short_name AS unit_short, u.echelon, u.level,
              b.title AS billet_title
         FROM assignments a
         JOIN units u ON u.id = a.unit_id
         LEFT JOIN billets b ON b.id = a.billet_id
        WHERE a.user_id = ? AND u.active = 1 AND (a.end_date IS NULL OR a.end_date > date('now'))`
    )
    .all(user.id);

  const roles = db
    .prepare(
      `SELECT mr.unit_id, r.id, r.name, r.color, r.position, r.permissions,
              u.short_name AS unit_short, u.name AS unit_name
         FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         JOIN units u ON u.id = mr.unit_id
         JOIN unit_members um ON um.user_id = mr.user_id AND um.unit_id = mr.unit_id
        WHERE mr.user_id = ? AND r.unit_id = mr.unit_id
          AND u.active = 1 AND ${LIVE_MEMBERSHIP}
        ORDER BY r.position DESC`
    )
    .all(user.id);

  const { map, positions, topPosition } = permissionMap(db, user);

  const scopeUnitIds = [];
  for (const [unitId, bits] of map) {
    if (has(bits, PERMISSIONS.VIEW_RECORDS)) scopeUnitIds.push(unitId);
  }

  const ownedUnitIds = db
    .prepare('SELECT id FROM units WHERE owner_user_id = ? AND active = 1')
    .all(user.id)
    .map((r) => r.id);

  return {
    memberships,
    assignments,
    roles,
    unitIds,
    scopeUnitIds,
    ownedUnitIds,
    topPosition,
    permissions: Object.fromEntries(map),
    positions: Object.fromEntries(positions),
    canLead: scopeUnitIds.length > 0,
  };
}

export function visibleUserIds(db, user) {
  const { scopeUnitIds } = resolveScope(db, user);
  const ids = new Set([user.id]);
  if (scopeUnitIds.length) {
    const placeholders = scopeUnitIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT DISTINCT um.user_id
           FROM unit_members um
           JOIN users u ON u.id = um.user_id
          WHERE um.unit_id IN (${placeholders})
            AND u.active = 1
            AND (um.expires_at IS NULL OR um.expires_at > datetime('now'))`
      )
      .all(...scopeUnitIds);
    for (const r of rows) ids.add(r.user_id);
  }
  return [...ids];
}

export const VISIBILITIES = ['personal', 'private', 'unit'];

export const VISIBILITY_LABELS = {
  personal: 'Only me — kept outside any unit',
  private: 'Only me',
  unit: 'Authorized readers in the unit',
};

export const DEFAULT_VISIBILITY = 'unit';

export function visibilityClause(db, user, { table = 't', unitMemberReadable = false } = {}) {
  const { scopeUnitIds } = resolveScope(db, user);
  const subordinates = visibleUserIds(db, user).filter((id) => id !== user.id);

  const parts = [`${table}.user_id = ?`];
  const params = [user.id];

  if (subordinates.length && scopeUnitIds.length) {
    parts.push(
      `(${table}.user_id IN (${subordinates.map(() => '?').join(',')})`
      + ` AND ${table}.unit_id IN (${scopeUnitIds.map(() => '?').join(',')})`
      + ` AND ${table}.visibility NOT IN ('private','personal'))`
    );
    params.push(...subordinates, ...scopeUnitIds);
  }
  if (scopeUnitIds.length) {
    parts.push(`(${table}.visibility = 'unit' AND ${table}.unit_id IN (${scopeUnitIds.map(() => '?').join(',')}))`);
    params.push(...scopeUnitIds);
  }

  if (unitMemberReadable) {
    const membershipUnits = memberUnitIds(db, user.id);
    if (membershipUnits.length) {
      parts.push(
        `(${table}.visibility = 'unit' AND ${table}.unit_id IN (${membershipUnits.map(() => '?').join(',')}))`
      );
      params.push(...membershipUnits);
    }
  }

  return { clause: `(${parts.join(' OR ')})`, params };
}

export function canEdit(db, user, row) {
  if (!row) return false;

  if (row.frozen_at) return false;
  if (row.user_id === user.id) {
    if (row.visibility === 'personal' || row.visibility === 'private') return true;
    return Boolean(row.unit_id && isMember(db, user.id, row.unit_id));
  }

  if (row.visibility === 'private' || row.visibility === 'personal') return false;
  return Boolean(row.unit_id && can(db, user, PERMISSIONS.MANAGE_RECORDS, row.unit_id));
}

export function canShareTo(db, user, visibility, unitId, flag = PERMISSIONS.CREATE_SHARED_WORK) {
  if (visibility === 'personal') return !unitId;
  if (visibility === 'private') return true;
  if (!unitId) return false;

  const kind = membershipKind(db, user.id, unitId);
  if (kind === 'owner' || kind === 'member') return true;
  return can(db, user, flag, unitId);
}

export function canManageRole(db, user, role) {
  if (!role || !role.unit_id) return false;
  if (isUnitOwner(db, user.id, role.unit_id)) return true;
  if (!can(db, user, PERMISSIONS.MANAGE_ROLES, role.unit_id)) return false;
  return role.position < positionIn(db, user, role.unit_id);
}
