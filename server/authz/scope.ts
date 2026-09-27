import type { AppContext, SessionUser } from '../context.ts';
import { PERMISSIONS, ALL_PERMISSIONS, has } from '../../shared/permissions.ts';

export { PERMISSIONS, has };

export interface Scope {
  memberships: Array<{ unit_id: string; is_primary: number; billet: string | null; joined_at: string; unit_name: string; unit_short: string | null; unit_code: string; parent_id: string | null }>;
  unitIds: string[];
  primaryUnitId: string | null;
  /** The deepest unit they belong to: their own team, where what they share is seen by everyone in their chain of command. */
  homeUnitId: string | null;
  permissions: Record<string, number>;
  positions: Record<string, number>;
  ownedUnitIds: string[];
  roles: Array<{ unit_id: string; id: string; name: string; color: string | null; position: number; permissions: number }>;
  readableUnitIds: string[];
  /** Units this person may open as a view: every unit they hold a permission in, plus the commands above their own units. */
  viewableUnitIds: string[];
  topPosition: number;
}

interface UnitNode { id: string; parent_id: string | null }

/** Parent to children, for active units. */
export function unitTree(ctx: AppContext): { children: Map<string, string[]>; parent: Map<string, string | null> } {
  const rows = ctx.db.prepare('SELECT id, parent_id FROM units WHERE active = 1').all() as UnitNode[];
  const children = new Map<string, string[]>();
  const parent = new Map<string, string | null>();
  for (const r of rows) parent.set(r.id, r.parent_id);
  for (const r of rows) if (r.parent_id && parent.has(r.parent_id)) children.set(r.parent_id, [...(children.get(r.parent_id) || []), r.id]);
  return { children, parent };
}

/** A unit and every active unit beneath it. */
export function subtreeIds(ctx: AppContext, unitId: string, tree = unitTree(ctx)): string[] {
  if (!tree.parent.has(unitId)) return [];
  const out: string[] = [];
  const queue = [unitId];
  while (queue.length && out.length < 5000) {
    const id = queue.shift()!;
    if (out.includes(id)) continue;
    out.push(id);
    queue.push(...(tree.children.get(id) || []));
  }
  return out;
}

function ancestorsOf(tree: ReturnType<typeof unitTree>, unitId: string): string[] {
  const out: string[] = [];
  let current = tree.parent.get(unitId) ?? null;
  while (current && !out.includes(current) && out.length < 50) { out.push(current); current = tree.parent.get(current) ?? null; }
  return out;
}

const cache = new WeakMap<object, Map<string, Scope>>();

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
  const authority: Record<string, number> = {};
  for (const g of roles) {
    permissions[g.unit_id] = (permissions[g.unit_id] || 0) | g.permissions;
    positions[g.unit_id] = Math.max(positions[g.unit_id] || 0, g.position);
    if (g.position > 0) authority[g.unit_id] = (authority[g.unit_id] || 0) | g.permissions;
  }
  for (const id of owned) {
    permissions[id] = ALL_PERMISSIONS;
    positions[id] = Math.max(positions[id] || 0, 100);
    authority[id] = ALL_PERMISSIONS;
  }

  // Authority held in a unit reaches every unit beneath it, and outranks anyone whose role sits only in the lower unit.
  // Plain membership does not: a Marine who belongs to the command sees the command and their own team, not every team.
  const tree = unitTree(ctx);
  for (const [unitId, bits] of Object.entries(authority)) {
    const rank = positions[unitId] || 0;
    for (const below of subtreeIds(ctx, unitId, tree).slice(1)) {
      permissions[below] = (permissions[below] || 0) | bits;
      positions[below] = Math.max(positions[below] || 0, rank + 1);
    }
  }
  const viewable = new Set(Object.keys(permissions).filter((id) => tree.parent.has(id)));
  for (const m of memberships) { viewable.add(m.unit_id); for (const a of ancestorsOf(tree, m.unit_id)) viewable.add(a); }

  const scope: Scope = {
    memberships,
    unitIds: memberships.map((m) => m.unit_id),
    primaryUnitId: memberships.find((m) => m.is_primary)?.unit_id || memberships[0]?.unit_id || null,
    homeUnitId: memberships.reduce<{ id: string | null; depth: number }>((best, m) => { const depth = ancestorsOf(tree, m.unit_id).length; return depth > best.depth ? { id: m.unit_id, depth } : best; }, { id: null, depth: -1 }).id,
    permissions,
    positions,
    ownedUnitIds: owned,
    roles,
    readableUnitIds: Object.entries(permissions).filter(([, bits]) => has(bits, PERMISSIONS.VIEW_RECORDS)).map(([id]) => id),
    viewableUnitIds: [...viewable],
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

export function detailUnitsFor(ctx: AppContext, actorScope: Scope, targetId: string): string[] {
  const targetScope = scopeFor(ctx, { id: targetId });
  return targetScope.unitIds
    .filter((unitId) => can(actorScope, PERMISSIONS.VIEW_MEMBER_DETAIL, unitId))
    .filter((unitId) => positionIn(actorScope, unitId) > positionIn(targetScope, unitId));
}

export interface UnitMember {
  id: string; first_name: string; last_name: string; mos: string | null; billet: string | null; is_primary: number;
  unit_id: string; team: string; rank_abbr: string | null; rank_sort: number | null;
}

/** Everyone active in any of these units, once each, labelled with their own team rather than the command above it. */
export function membersAcross(ctx: AppContext, unitIds: string[]): UnitMember[] {
  if (!unitIds.length) return [];
  const rows = ctx.db.prepare(
    `SELECT u.id, u.first_name, u.last_name, u.mos, um.billet, um.is_primary, um.unit_id, COALESCE(un.short_name, un.name) AS team, r.abbr AS rank_abbr, r.sort AS rank_sort
       FROM unit_members um JOIN users u ON u.id = um.user_id JOIN units un ON un.id = um.unit_id LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE um.unit_id IN (SELECT value FROM json_each(?)) AND u.active = 1 ORDER BY r.sort DESC, u.last_name, u.first_name`
  ).all(JSON.stringify(unitIds)) as UnitMember[];
  const root = unitIds[0];
  const byUser = new Map<string, UnitMember>();
  for (const r of rows) {
    const current = byUser.get(r.id);
    if (!current || (current.unit_id === root && r.unit_id !== root)) byUser.set(r.id, r);
  }
  return [...byUser.values()];
}
