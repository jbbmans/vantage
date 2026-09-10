import type { AppContext, SessionUser } from '../context.ts';
import { PERMISSIONS, ALL_PERMISSIONS, has } from '../../shared/permissions.ts';

export { PERMISSIONS, has };

export interface Scope {
  memberships: Array<{ unit_id: string; is_primary: number; billet: string | null; joined_at: string; unit_name: string; unit_short: string | null; unit_code: string; parent_id: string | null }>;
  unitIds: string[];
  primaryUnitId: string | null;
  permissions: Record<string, number>;
  positions: Record<string, number>;
  ownedUnitIds: string[];
  roles: Array<{ unit_id: string; id: string; name: string; color: string | null; position: number; permissions: number }>;
  readableUnitIds: string[];
  topPosition: number;
}

const cache = new WeakMap<object, Map<string, Scope>>();

/** Resolve the caller's exact-unit authority. Cached per request object so repeated checks cost nothing. */
export function scopeFor(ctx: AppContext, user: { id: string }, reqKey?: object): Scope {
  if (reqKey) {
    const m = cache.get(reqKey);
    const hit = m?.get(user.id);
    if (hit) return hit;
  }
  const { db } = ctx;
  const memberships = db.prepare(
    `SELECT um.unit_id, um.is_primary, um.billet, um.joined_at, u.name AS unit_name, u.short_name AS unit_short, u.code AS unit_code, u.parent_id
       FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id = ? AND u.active = 1 ORDER BY um.is_primary DESC, um.joined_at`
  ).all(user.id) as Scope['memberships'];
  const roles = db.prepare(
    `SELECT mr.unit_id, r.id, r.name, r.color, r.position, r.permissions
       FROM member_roles mr JOIN roles r ON r.id = mr.role_id JOIN units u ON u.id = mr.unit_id
       JOIN unit_members um ON um.user_id = mr.user_id AND um.unit_id = mr.unit_id
      WHERE mr.user_id = ? AND u.active = 1 ORDER BY r.position DESC`
  ).all(user.id) as Scope['roles'];
  const owned = (db.prepare('SELECT id FROM units WHERE owner_user_id = ? AND active = 1').all(user.id) as Array<{ id: string }>).map((r) => r.id);

  const permissions: Record<string, number> = {};
  const positions: Record<string, number> = {};
  for (const g of roles) {
    permissions[g.unit_id] = (permissions[g.unit_id] || 0) | g.permissions;
    positions[g.unit_id] = Math.max(positions[g.unit_id] || 0, g.position);
  }
  for (const id of owned) {
    permissions[id] = ALL_PERMISSIONS;
    positions[id] = Math.max(positions[id] || 0, 100);
  }
  const scope: Scope = {
    memberships,
    unitIds: memberships.map((m) => m.unit_id),
    primaryUnitId: memberships.find((m) => m.is_primary)?.unit_id || memberships[0]?.unit_id || null,
    permissions,
    positions,
    ownedUnitIds: owned,
    roles,
    readableUnitIds: Object.entries(permissions).filter(([, bits]) => has(bits, PERMISSIONS.VIEW_RECORDS)).map(([id]) => id),
    topPosition: Object.values(positions).reduce((a, b) => Math.max(a, b), 0),
  };
  if (reqKey) {
    const m = cache.get(reqKey) || new Map<string, Scope>();
    m.set(user.id, scope);
    cache.set(reqKey, m);
  }
  return scope;
}

export function invalidateScope(reqKey: object) { cache.delete(reqKey); }

export const can = (scope: Scope, flag: number, unitId: string | null | undefined) => Boolean(unitId) && has(scope.permissions[unitId!] || 0, flag);
export const positionIn = (scope: Scope, unitId: string | null | undefined) => (unitId ? scope.positions[unitId] || 0 : 0);
export const isMember = (scope: Scope, unitId: string | null | undefined) => Boolean(unitId) && scope.unitIds.includes(unitId!);
export const unitsWith = (scope: Scope, flag: number) => Object.entries(scope.permissions).filter(([, bits]) => has(bits, flag)).map(([id]) => id);

export const isOperator = (user: Pick<SessionUser, 'is_operator'>) => Boolean(user.is_operator);

export function isUnitOwner(ctx: AppContext, userId: string, unitId: string | null | undefined): boolean {
  if (!unitId) return false;
  const row = ctx.db.prepare('SELECT owner_user_id FROM units WHERE id = ? AND active = 1').get(unitId) as { owner_user_id: string | null } | undefined;
  return Boolean(row?.owner_user_id && row.owner_user_id === userId);
}

/** IDs of every active user visible to the caller: self plus members of units where the caller can read records. */
export function visibleUserIds(ctx: AppContext, scope: Scope, selfId: string): string[] {
  const ids = new Set([selfId]);
  if (scope.readableUnitIds.length) {
    const rows = ctx.db.prepare(
      `SELECT DISTINCT um.user_id FROM unit_members um JOIN users u ON u.id = um.user_id
        WHERE um.unit_id IN (${scope.readableUnitIds.map(() => '?').join(',')}) AND u.active = 1`
    ).all(...scope.readableUnitIds) as Array<{ user_id: string }>;
    for (const r of rows) ids.add(r.user_id);
  }
  return [...ids];
}

/** Units where the actor can open a member's detailed record: shared unit, VIEW_MEMBER_DETAIL, and higher position. */
export function detailUnitsFor(ctx: AppContext, actorScope: Scope, targetId: string): string[] {
  const targetScope = scopeFor(ctx, { id: targetId });
  return targetScope.unitIds
    .filter((unitId) => can(actorScope, PERMISSIONS.VIEW_MEMBER_DETAIL, unitId))
    .filter((unitId) => positionIn(actorScope, unitId) > positionIn(targetScope, unitId));
}
