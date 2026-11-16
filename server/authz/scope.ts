import type { AppContext } from '../context.ts';
import { PERMISSIONS, FULL_UNIT_AUTHORITY, NAMED_ONLY_BITS, VANTAGE_ACCESS_BITS, ORG_ROLE_KEYS, has, orgPermissionsOf, orgStructureBits, type OrgPermission, type OrgRole } from '../../shared/permissions.ts';
import { now } from '../lib/ids.ts';
import { forbidden } from '../lib/errors.ts';

export { PERMISSIONS, has };

/** Where a person's authority in a unit comes from, for "why can they?". */
export interface Source {
  kind: 'role' | 'inherited' | 'owner' | 'org' | 'vantage';
  /** The unit the grant was made in (a role reaches the units beneath it). */
  unitId: string;
  bits: number;
  role?: { id: string; name: string } | null;
  orgRole?: OrgRole;
  expiresAt?: string | null;
  grantId?: string;
}

export interface OrgAuthority { orgId: string; roles: OrgRole[]; permissions: OrgPermission[]; expiresAt: string | null }
export interface VantageAccess { grantId: string; orgId: string; expiresAt: string; reason: string }

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
  /** The organization each unit in scope belongs to. */
  unitOrg: Record<string, string>;
  /** Organizations the person belongs to, by membership in their units. */
  orgIds: string[];
  /** Organization roles held, by organization (ADR-0006). */
  orgs: Record<string, OrgAuthority>;
  /** Live Vantage access: read-only, time-limited, approved by the organization. Staff only. */
  vantageAccess: VantageAccess[];
  /** Where each unit's permissions come from. */
  sources: Record<string, Source[]>;
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

/**
 * Authority a role must name (approving one's own duty; John, "role only", ADR-0024 §2) counts for a person only from a
 * role that someone else granted them. Not from a grant that names nobody or names its own holder, whatever wrote it;
 * and not from the default role or the Unit Leader role, which come with joining a unit and with leading it, never from
 * a decision about one person. The routes refuse each of those too. This is the one place every path ends at: a row
 * that reached the table some other way confers the rest of its role and not this. An SQL expression over a member_roles
 * row aliased `grant` and its role aliased `role`.
 */
export const grantedByAnother = (grant: string, role: string) =>
  `(${grant}.granted_by IS NOT NULL AND ${grant}.granted_by <> ${grant}.user_id AND ${role}.is_default = 0 AND ${role}.key IS NOT 'unit-leader')`;

type Membership = Scope['memberships'][number];
type RoleRow = Scope['roles'][number] & { expires_at: string | null; granted: number };
type OrgRoleRow = { org_id: string; role: string; expires_at: string | null };
type AccessRow = { id: string; org_id: string; expires_at: string; reason: string };
/** What a person's scope is built from: the rows read for them, before anything is worked out. */
interface ScopeRows { memberships: Membership[]; roles: RoleRow[]; owned: string[]; orgRows: OrgRoleRow[]; access: AccessRow[] }
/** Lookups the build shares between people: a Unit Instance's active units, and the Unit Instance of units. */
interface ScopeLookups { orgUnits: (orgId: string) => string[]; unitOrg: (ids: string[]) => Array<{ id: string; org_id: string | null }> }

/**
 * The rows every scope is built from, for one person or many at once, each read with one statement whatever the number
 * of people. Each list keeps the order the build has always relied on (a membership's primary first, the most senior
 * role first), with a last tie-break so that order is the same however many people are read together.
 */
function loadScopeRows(ctx: AppContext, ids: string[]): Map<string, ScopeRows> {
  const { db } = ctx;
  const at = now();
  const who = JSON.stringify(ids);
  const out = new Map<string, ScopeRows>(ids.map((id) => [id, { memberships: [], roles: [], owned: [], orgRows: [], access: [] }]));
  // A suspended or archived organization's units confer nothing: its members keep their own records, not its shared work.
  const liveUnit = `u.active = 1 AND COALESCE((SELECT o.status FROM organizations o WHERE o.id = u.org_id), 'active') = 'active'`;
  const memberships = db.prepare(
    `SELECT um.user_id AS who, um.unit_id, um.is_primary, um.billet, um.joined_at, u.name AS unit_name, u.short_name AS unit_short, u.code AS unit_code, u.parent_id
       FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id IN (SELECT value FROM json_each(?)) AND ${liveUnit}
      ORDER BY um.user_id, um.is_primary DESC, um.joined_at, um.unit_id`
  ).all(who) as Array<Membership & { who: string }>;
  for (const { who: id, ...m } of memberships) out.get(id)?.memberships.push(m);
  const roles = db.prepare(
    `SELECT mr.user_id AS who, mr.unit_id, r.id, r.name, r.color, r.position, r.permissions, mr.expires_at, ${grantedByAnother('mr', 'r')} AS granted
       FROM member_roles mr JOIN roles r ON r.id = mr.role_id JOIN units u ON u.id = mr.unit_id
       JOIN unit_members um ON um.user_id = mr.user_id AND um.unit_id = mr.unit_id
      WHERE mr.user_id IN (SELECT value FROM json_each(?)) AND ${liveUnit} AND (mr.expires_at IS NULL OR mr.expires_at > ?)
      ORDER BY mr.user_id, r.position DESC, mr.unit_id, r.id`
  ).all(who, at) as Array<RoleRow & { who: string }>;
  for (const { who: id, ...r } of roles) out.get(id)?.roles.push(r);
  const owned = db.prepare(
    `SELECT u.owner_user_id AS who, u.id FROM units u WHERE u.owner_user_id IN (SELECT value FROM json_each(?)) AND ${liveUnit} AND ${seatedLeader('u')}
      ORDER BY u.owner_user_id, u.id`
  ).all(who) as Array<{ who: string; id: string }>;
  for (const r of owned) out.get(r.who)?.owned.push(r.id);
  const orgRows = db.prepare(
    `SELECT r.user_id AS who, r.org_id, r.role, r.expires_at FROM org_roles r JOIN organizations o ON o.id = r.org_id
      WHERE r.user_id IN (SELECT value FROM json_each(?)) AND o.status = 'active' AND (r.expires_at IS NULL OR r.expires_at > ?) AND ${seatedOrgRole('r')}
      ORDER BY r.user_id, r.org_id, r.role`
  ).all(who, at) as Array<OrgRoleRow & { who: string }>;
  for (const { who: id, ...r } of orgRows) out.get(id)?.orgRows.push(r);
  const access = db.prepare(
    `SELECT g.staff_user_id AS who, g.id, g.org_id, g.expires_at, g.reason FROM access_grants g JOIN organizations o ON o.id = g.org_id
      WHERE g.staff_user_id IN (SELECT value FROM json_each(?)) AND g.status = 'active' AND g.expires_at > ? AND o.status = 'active'
        AND EXISTS (SELECT 1 FROM platform_roles p WHERE p.user_id = g.staff_user_id)
      ORDER BY g.staff_user_id, g.id`
  ).all(who, at) as Array<AccessRow & { who: string }>;
  for (const { who: id, ...g } of access) out.get(id)?.access.push(g);
  return out;
}

/** A Unit Instance's active units, read once per Unit Instance however many scopes ask. */
function orgUnitsOnce(ctx: AppContext) {
  const seen = new Map<string, string[]>();
  return (orgId: string) => {
    if (!seen.has(orgId)) seen.set(orgId, (ctx.db.prepare('SELECT id FROM units WHERE org_id = ? AND active = 1').all(orgId) as Array<{ id: string }>).map((r) => r.id));
    return seen.get(orgId)!;
  };
}

const unitOrgOf = (ctx: AppContext) => (ids: string[]) =>
  ctx.db.prepare('SELECT id, org_id FROM units WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as Array<{ id: string; org_id: string | null }>;

/** What a person may do where, worked out from their rows alone. scopeFor and scopesFor both build every scope here. */
function buildScope(ctx: AppContext, { memberships, roles, owned, orgRows, access }: ScopeRows, tree: ReturnType<typeof unitTree>, lookups: ScopeLookups): Scope {
  const { orgUnits } = lookups;
  const permissions: Record<string, number> = {};
  const positions: Record<string, number> = {};
  const authority: Record<string, number> = {};
  const sources: Record<string, Source[]> = {};
  const source = (unitId: string, s: Source) => { (sources[unitId] ||= []).push(s); };
  for (const g of roles) {
    // What a role must name (approving one's own duty) counts only from a role someone else granted this person: see
    // grantedByAnother. Everything else the role names is theirs however they came by it.
    const bits = g.granted ? g.permissions : g.permissions & ~NAMED_ONLY_BITS;
    permissions[g.unit_id] = (permissions[g.unit_id] || 0) | bits;
    positions[g.unit_id] = Math.max(positions[g.unit_id] || 0, g.position);
    if (g.position > 0) authority[g.unit_id] = (authority[g.unit_id] || 0) | bits;
    source(g.unit_id, { kind: 'role', unitId: g.unit_id, bits, role: { id: g.id, name: g.name }, expiresAt: g.expires_at });
  }
  // Leading a unit is every permission in it but the ones a role must name (approving one's own duty, ADR-0024 §2; John,
  // "role only"): those stay as the leader's roles give them, here and in the units beneath.
  for (const id of owned) {
    permissions[id] = (permissions[id] || 0) | FULL_UNIT_AUTHORITY;
    positions[id] = Math.max(positions[id] || 0, 100);
    authority[id] = (authority[id] || 0) | FULL_UNIT_AUTHORITY;
    source(id, { kind: 'owner', unitId: id, bits: FULL_UNIT_AUTHORITY });
  }

  // Authority held in a unit reaches every unit beneath it, and outranks anyone whose role sits only in the lower unit.
  // Plain membership does not: a Marine who belongs to the command sees the command and their own team, not every team.
  for (const [unitId, bits] of Object.entries(authority)) {
    const rank = positions[unitId] || 0;
    for (const below of subtreeIds(ctx, unitId, tree).slice(1)) {
      permissions[below] = (permissions[below] || 0) | bits;
      positions[below] = Math.max(positions[below] || 0, rank + 1);
      source(below, { kind: 'inherited', unitId, bits });
    }
  }

  // Unit Managers run the structure of every unit in their Unit Instance: members, roles and units, never records. What
  // each Unit Instance permission confers is mapped one to one (ORG_STRUCTURE_GRANTS), whatever the role is called.
  const orgs: Record<string, OrgAuthority> = {};
  for (const r of orgRows) {
    if (!ORG_ROLE_KEYS.includes(r.role as OrgRole)) continue;
    const o = (orgs[r.org_id] ||= { orgId: r.org_id, roles: [], permissions: [], expiresAt: null });
    o.roles.push(r.role as OrgRole);
    o.expiresAt = r.expires_at && (!o.expiresAt || r.expires_at < o.expiresAt) ? r.expires_at : o.expiresAt;
  }
  for (const o of Object.values(orgs)) {
    o.permissions = orgPermissionsOf(o.roles);
    const bits = orgStructureBits(o.permissions);
    if (!bits) continue;
    // Named for the "why can they?" answer: the most senior role held.
    const role = ORG_ROLE_KEYS.find((r) => o.roles.includes(r))!;
    for (const unitId of orgUnits(o.orgId)) {
      permissions[unitId] = (permissions[unitId] || 0) | bits;
      positions[unitId] = Math.max(positions[unitId] || 0, 100);
      source(unitId, { kind: 'org', unitId, bits, orgRole: role, expiresAt: o.expiresAt });
    }
  }

  // Vantage access: read-only, in every unit of the organization that approved it, until it ends.
  const vantageAccess: VantageAccess[] = access.map((g) => ({ grantId: g.id, orgId: g.org_id, expiresAt: g.expires_at, reason: g.reason }));
  for (const g of vantageAccess) {
    for (const unitId of orgUnits(g.orgId)) {
      permissions[unitId] = (permissions[unitId] || 0) | VANTAGE_ACCESS_BITS;
      positions[unitId] = positions[unitId] || 0;
      source(unitId, { kind: 'vantage', unitId, bits: VANTAGE_ACCESS_BITS, expiresAt: g.expiresAt, grantId: g.grantId });
    }
  }

  const viewable = new Set(Object.keys(permissions).filter((id) => tree.parent.has(id)));
  for (const m of memberships) { viewable.add(m.unit_id); for (const a of ancestorsOf(tree, m.unit_id)) viewable.add(a); }

  const inScope = [...new Set([...viewable, ...memberships.map((m) => m.unit_id)])];
  const unitOrg: Record<string, string> = {};
  if (inScope.length) {
    for (const r of lookups.unitOrg(inScope)) {
      if (r.org_id) unitOrg[r.id] = r.org_id;
    }
  }

  return {
    memberships,
    unitIds: memberships.map((m) => m.unit_id),
    primaryUnitId: memberships.find((m) => m.is_primary)?.unit_id || memberships[0]?.unit_id || null,
    homeUnitId: memberships.reduce<{ id: string | null; depth: number }>((best, m) => { const depth = ancestorsOf(tree, m.unit_id).length; return depth > best.depth ? { id: m.unit_id, depth } : best; }, { id: null, depth: -1 }).id,
    permissions,
    positions,
    ownedUnitIds: owned,
    roles: roles.map(({ expires_at: _e, granted: _g, ...r }) => r),
    readableUnitIds: Object.entries(permissions).filter(([, bits]) => has(bits, PERMISSIONS.VIEW_RECORDS)).map(([id]) => id),
    viewableUnitIds: [...viewable],
    topPosition: Object.values(positions).reduce((a, b) => Math.max(a, b), 0),
    unitOrg,
    orgIds: [...new Set(memberships.map((m) => unitOrg[m.unit_id]).filter(Boolean))],
    orgs,
    vantageAccess,
    sources,
  };
}

function remember(reqKey: object | undefined, id: string, scope: Scope) {
  if (!reqKey) return;
  const m = cache.get(reqKey) || new Map<string, Scope>();
  m.set(id, scope);
  cache.set(reqKey, m);
}

export function scopeFor(ctx: AppContext, user: { id: string }, reqKey?: object): Scope {
  const hit = reqKey ? cache.get(reqKey)?.get(user.id) : undefined;
  if (hit) return hit;
  const scope = buildScope(ctx, loadScopeRows(ctx, [user.id]).get(user.id)!, unitTree(ctx), { orgUnits: orgUnitsOnce(ctx), unitOrg: unitOrgOf(ctx) });
  remember(reqKey, user.id, scope);
  return scope;
}

/**
 * Many people's scopes at once, each exactly what scopeFor gives them (the same build from the same rows), read with a
 * fixed number of statements rather than several for each person: for a roster, a team list or a drill that decides,
 * row by row, what the reader may do about each person on it.
 */
export function scopesFor(ctx: AppContext, ids: string[], reqKey?: object): Map<string, Scope> {
  const out = new Map<string, Scope>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const hit = reqKey ? cache.get(reqKey)?.get(id) : undefined;
    if (hit) out.set(id, hit); else missing.push(id);
  }
  if (!missing.length) return out;
  const rows = loadScopeRows(ctx, missing);
  const tree = unitTree(ctx);
  const orgOf = new Map((ctx.db.prepare('SELECT id, org_id FROM units').all() as Array<{ id: string; org_id: string | null }>).map((r) => [r.id, r]));
  const lookups: ScopeLookups = { orgUnits: orgUnitsOnce(ctx), unitOrg: (unitIds) => unitIds.flatMap((u) => orgOf.get(u) ?? []) };
  for (const id of missing) {
    const scope = buildScope(ctx, rows.get(id)!, tree, lookups);
    remember(reqKey, id, scope);
    out.set(id, scope);
  }
  return out;
}

export const can = (scope: Scope, flag: number, unitId: string | null | undefined) => Boolean(unitId) && has(scope.permissions[unitId!] || 0, flag);
export const positionIn = (scope: Scope, unitId: string | null | undefined) => (unitId ? scope.positions[unitId] || 0 : 0);
export const isMember = (scope: Scope, unitId: string | null | undefined) => Boolean(unitId) && scope.unitIds.includes(unitId!);
export const unitsWith = (scope: Scope, flag: number) => Object.entries(scope.permissions).filter(([, bits]) => has(bits, flag)).map(([id]) => id);
/** What a person holds in a unit through the chain of command: their roles there and above it, and leadership. */
export const chainBits = (scope: Scope, unitId: string) =>
  (scope.sources[unitId] || []).filter((s) => s.kind !== 'org' && s.kind !== 'vantage').reduce((b, s) => b | s.bits, 0);

/**
 * What a person holds by their own place in units, leaving out Vantage access (ADR-0031): read-only access lets staff read
 * a Unit Instance's records, never speak on them, be asked about them or be told what is said on them.
 */
export function ownScope(scope: Scope): Scope {
  if (!scope.vantageAccess.length) return scope;
  const permissions: Record<string, number> = {};
  for (const [unitId, list] of Object.entries(scope.sources)) {
    const bits = list.filter((s) => s.kind !== 'vantage').reduce((b, s) => b | s.bits, 0);
    if (bits) permissions[unitId] = bits;
  }
  const readableUnitIds = Object.entries(permissions).filter(([, bits]) => has(bits, PERMISSIONS.VIEW_RECORDS)).map(([id]) => id);
  return { ...scope, permissions, readableUnitIds, vantageAccess: [] };
}

/**
 * A Unit Instance role confers authority only while its holder belongs to a unit of that Unit Instance (ADR-0010): it is
 * scoped to the instance it was assigned in, and whatever path takes the person out of the instance takes the authority
 * with it. An SQL condition on an org_roles row aliased `alias`.
 */
export const seatedOrgRole = (alias: string) =>
  `EXISTS (SELECT 1 FROM unit_members sm JOIN units su ON su.id = sm.unit_id WHERE sm.user_id = ${alias}.user_id AND su.org_id = ${alias}.org_id)`;

/**
 * Leading a unit confers authority only while the leader is a member of it (ADR-0013): every path that ends the membership
 * ends the leadership, and a leader left over from before that, who no longer belongs, leads nothing. An SQL condition on
 * a units row aliased `alias`.
 */
export const seatedLeader = (alias: string) =>
  `EXISTS (SELECT 1 FROM unit_members lm WHERE lm.user_id = ${alias}.owner_user_id AND lm.unit_id = ${alias}.id)`;

/** Does the person hold a Unit Instance permission there? Unit Instance roles only; platform staff hold none. */
export const orgCan = (scope: Scope, permission: OrgPermission, orgId: string | null | undefined) => Boolean(orgId) && Boolean(scope.orgs[orgId!]?.permissions.includes(permission));

/** The organization a unit belongs to. */
export function orgOfUnit(ctx: AppContext, unitId: string | null | undefined): string | null {
  if (!unitId) return null;
  return (ctx.db.prepare('SELECT org_id FROM units WHERE id = ?').get(unitId) as { org_id: string | null } | undefined)?.org_id ?? null;
}

/**
 * Do two units belong to the same Unit Instance (ADR-0008)? A unit with no organization matches nothing, so a
 * missing or unknown unit never counts as "the same".
 */
export function sameInstance(ctx: AppContext, a: string | null | undefined, b: string | null | undefined): boolean {
  const org = orgOfUnit(ctx, a);
  return Boolean(org) && org === orgOfUnit(ctx, b);
}

/**
 * Data never moves or links across a Unit Instance boundary, whatever the person's authority on each side: someone
 * who serves in two organizations may act in each, never carry one's records, people or work into the other.
 * Passes when either side has no unit (a person's own unplaced data belongs to no instance).
 */
export function assertSameInstance(ctx: AppContext, a: string | null | undefined, b: string | null | undefined, message: string) {
  if (!a || !b || a === b) return;
  if (!sameInstance(ctx, a, b)) throw forbidden(message, 'cross_instance');
}

export function isUnitOwner(ctx: AppContext, userId: string, unitId: string | null | undefined): boolean {
  if (!unitId) return false;
  const row = ctx.db.prepare(`SELECT u.owner_user_id FROM units u WHERE u.id = ? AND u.active = 1 AND ${seatedLeader('u')}`).get(unitId) as { owner_user_id: string | null } | undefined;
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

/**
 * The units where the reader may open this Marine's records: the Marine belongs there, the reader may see member detail
 * there and sits above them. A caller deciding this for many people passes each one's scope from scopesFor.
 */
export function detailUnitsFor(ctx: AppContext, actorScope: Scope, targetId: string, targetScope: Scope = scopeFor(ctx, { id: targetId })): string[] {
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
