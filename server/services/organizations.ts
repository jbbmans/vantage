import type { AppContext, SessionUser } from '../context.ts';
import { ORG_ROLES, ORG_ROLE_KEYS, PERMISSIONS, listPermissions, type OrgRole, type UnitManagerRole } from '../../shared/permissions.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { now, slug } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { notify, notifyOrg } from './notifications.ts';
import { addMember, claimUnit, guardSelfReach, removeMember } from './org.ts';
import { orgCan, scopeFor, seatedOrgRole } from '../authz/scope.ts';
import { invalidateUserSessions } from '../auth/sessions.ts';
import { assertCanFoundUnitInstance } from './deployment.ts';
import { normalizeUnitSettings, type UnitSettings } from '../../shared/unitConfig.ts';

/**
 * Organizations: the tenants of the central service (ADR-0006). An organization is a tree of units with its own
 * owners, roster feed, retention, holds and audit trail. Vantage staff create and suspend organizations; they never
 * read one's records, which only the organization's own approval can open to them (services/access.ts).
 */

export interface OrgRow {
  id: string; slug: string; name: string; short_name: string | null; status: 'active' | 'suspended' | 'archived';
  root_unit_id: string | null; settings: string; created_by: string | null; suspended_reason: string | null; suspended_at: string | null;
  created_at: string; updated_at: string;
}

export interface OrgSettings extends UnitSettings {
  /** Whether Vantage support needs an owner's approval to look ('approval'), or only tells the owners it did ('notify'). */
  vantageAccess: 'approval' | 'notify';
}

export function getOrg(ctx: AppContext, orgId: string): OrgRow | null {
  return (ctx.db.prepare('SELECT * FROM organizations WHERE id = ?').get(orgId) as OrgRow | undefined) ?? null;
}

/**
 * A Unit Instance's settings, each within the limits Vantage sets (ADR-0012). Anything unreadable or unknown reads as the
 * default: approval before Vantage support looks, and the enterprise defaults for work and reports.
 */
export function orgSettings(org: Pick<OrgRow, 'settings'>): OrgSettings {
  let raw: Partial<OrgSettings> = {};
  try { raw = (JSON.parse(org.settings || '{}') ?? {}) as Partial<OrgSettings>; } catch { /* the defaults */ }
  return { vantageAccess: raw.vantageAccess === 'notify' ? 'notify' : 'approval', ...normalizeUnitSettings(raw) };
}

export const orgUnitIds = (ctx: AppContext, orgId: string, activeOnly = true): string[] =>
  (ctx.db.prepare(`SELECT id FROM units WHERE org_id = ?${activeOnly ? ' AND active = 1' : ''}`).all(orgId) as Array<{ id: string }>).map((u) => u.id);

const memberIdsSql = 'SELECT DISTINCT um.user_id FROM unit_members um JOIN units un ON un.id = um.unit_id WHERE un.org_id = ?';
export const isOrgMember = (ctx: AppContext, orgId: string, userId: string) =>
  Boolean(ctx.db.prepare('SELECT 1 FROM unit_members um JOIN units un ON un.id = um.unit_id WHERE un.org_id = ? AND um.user_id = ? LIMIT 1').get(orgId, userId));

/** Counts an organization is described by, for Vantage staff and its own overview. Never content. */
export function orgCounts(ctx: AppContext, orgId: string) {
  const one = (sql: string, ...params: unknown[]) => (ctx.db.prepare(sql).get(...params) as { n: number }).n;
  return {
    units: one('SELECT COUNT(*) AS n FROM units WHERE org_id = ? AND active = 1', orgId),
    members: one(`SELECT COUNT(*) AS n FROM users WHERE active = 1 AND id IN (${memberIdsSql})`, orgId),
    owners: one(`SELECT COUNT(*) AS n FROM org_roles r JOIN users u ON u.id = r.user_id WHERE r.org_id = ? AND r.role = 'owner' AND u.active = 1 AND (r.expires_at IS NULL OR r.expires_at > ?) AND ${seatedOrgRole('r')}`, orgId, now()),
    lastActive: (ctx.db.prepare(`SELECT MAX(last_login_at) AS at FROM users WHERE id IN (${memberIdsSql})`).get(orgId) as { at: string | null }).at,
    pendingAccess: one("SELECT COUNT(*) AS n FROM access_grants WHERE org_id = ? AND status = 'pending'", orgId),
  };
}

export function listOrganizations(ctx: AppContext) {
  const orgs = ctx.db.prepare('SELECT * FROM organizations ORDER BY status, name COLLATE NOCASE').all() as OrgRow[];
  return orgs.map((o) => ({
    ...publicOrg(o),
    counts: orgCounts(ctx, o.id),
    owners: ctx.db.prepare(`SELECT u.id, u.username, u.first_name, u.last_name, rk.abbr AS rank_abbr FROM org_roles r JOIN users u ON u.id = r.user_id LEFT JOIN ranks rk ON rk.id = u.rank_id
                            WHERE r.org_id = ? AND r.role = 'owner' AND (r.expires_at IS NULL OR r.expires_at > ?) AND ${seatedOrgRole('r')} ORDER BY u.last_name`).all(o.id, now()),
  }));
}

export const publicOrg = (o: OrgRow) => ({
  id: o.id, slug: o.slug, name: o.name, short_name: o.short_name, status: o.status, root_unit_id: o.root_unit_id,
  settings: orgSettings(o), suspended_reason: o.suspended_reason, suspended_at: o.suspended_at, created_at: o.created_at, created_by: o.created_by,
});

/**
 * A new Unit Instance, from the Vantage Administrator console or a manifest: its root unit (whose insert founds it), and
 * its first Lead Unit Manager when one is named. The Vantage Administrator who creates it is never made its Lead Unit
 * Manager, not even by naming themselves (ADR-0010); the command's own people run it.
 */
export function createOrganization(ctx: AppContext, actor: Pick<SessionUser, 'id'>, input: { name: string; short_name?: string | null; code?: string | null; owner_user_id?: string | null }, ip?: string) {
  const name = input.name.trim();
  if (!name || name.length > 120) throw badRequest('A Unit Instance needs a name under 120 characters.', { fieldErrors: { name: 'Required (limit 120 characters).' } });
  const code = slug(String(input.code || input.short_name || name));
  if (!code) throw badRequest('That name produces an empty code.');
  if (ctx.db.prepare('SELECT 1 FROM units WHERE id = ?').get(code) || ctx.db.prepare('SELECT 1 FROM organizations WHERE id = ? OR slug = ?').get(code, code)) {
    throw conflict('That code is already in use. Choose another.', 'duplicate_code');
  }
  const owner = input.owner_user_id
    ? ctx.db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ? AND active = 1').get(input.owner_user_id) as { id: string; first_name: string; last_name: string } | undefined
    : undefined;
  if (input.owner_user_id && !owner) throw badRequest('The first Lead Unit Manager must be an active account.', { fieldErrors: { owner_user_id: 'No such active account.' } });
  if (owner && owner.id === actor.id) throw forbidden('A Vantage Administrator never names themselves a Unit Instance’s Lead Unit Manager. Name the person the command designated.', 'self_grant');
  assertCanFoundUnitInstance(ctx);
  const at = now();
  ctx.db.transaction(() => {
    ctx.db.prepare("INSERT INTO units (id, code, name, short_name, echelon, created_at) VALUES (?, ?, ?, ?, 'command', ?)").run(code, code, name, input.short_name?.trim() || null, at);
    ctx.db.prepare('UPDATE organizations SET created_by = ?, updated_at = ? WHERE id = ?').run(actor.id, at, code);
    if (owner) {
      claimUnit(ctx, code, owner.id, 'unit_created');
      ctx.db.prepare("INSERT OR IGNORE INTO org_roles (org_id, user_id, role, granted_by, created_at) VALUES (?, ?, 'owner', ?, ?)").run(code, owner.id, actor.id, at);
    }
  })();
  audit(ctx, { actor_id: actor.id, action: 'organization_created', entity: 'organization', entity_id: code, org_id: code, subject_id: owner?.id ?? null, detail: name, ip });
  if (owner) notify(ctx, owner.id, { kind: 'unit', title: `You are Lead Unit Manager of ${name} on Vantage`, message: 'Open the Unit Manager console to set it up: units, members, roles and the personnel feed.', actionUrl: '/console', dedupeKey: `org-owner:${code}:${owner.id}` });
  return publicOrg(getOrg(ctx, code)!);
}

export function updateOrganization(ctx: AppContext, actor: SessionUser, orgId: string, patch: { name?: string; short_name?: string | null; settings?: Partial<OrgSettings> }, ip?: string) {
  const org = getOrg(ctx, orgId);
  if (!org) throw notFound('No such Unit Instance.');
  const name = patch.name === undefined ? org.name : patch.name.trim();
  if (!name || name.length > 120) throw badRequest('A Unit Instance needs a name under 120 characters.', { fieldErrors: { name: 'Required.' } });
  const settings = { ...orgSettings(org), ...(patch.settings ?? {}) };
  if (!['approval', 'notify'].includes(settings.vantageAccess)) throw badRequest('Vantage access is approval or notify.');
  const shortName = patch.short_name === undefined ? org.short_name : (patch.short_name?.trim() || null);
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE organizations SET name = ?, short_name = ?, settings = ?, updated_at = ? WHERE id = ?').run(name, shortName, JSON.stringify(settings), now(), orgId);
    // The root unit carries the organization's name; renaming one renames the other.
    if (org.root_unit_id) ctx.db.prepare('UPDATE units SET name = ?, short_name = ? WHERE id = ?').run(name, shortName, org.root_unit_id);
  })();
  const changed = [patch.name !== undefined && 'name', patch.short_name !== undefined && 'short name', patch.settings && `settings (${Object.keys(patch.settings).join(', ')})`].filter(Boolean).join(', ');
  audit(ctx, { actor_id: actor.id, action: 'organization_updated', entity: 'organization', entity_id: orgId, org_id: orgId, detail: changed, ip });
  return publicOrg(getOrg(ctx, orgId)!);
}

/** Suspend, restore or archive: the platform's call. A suspended organization's units confer nothing; members keep their own records. */
export function setOrgStatus(ctx: AppContext, actor: SessionUser, orgId: string, status: OrgRow['status'], reason: string | null, ip?: string) {
  const org = getOrg(ctx, orgId);
  if (!org) throw notFound('No such Unit Instance.');
  if (status !== 'active' && !reason?.trim()) throw badRequest('Say why: everyone who holds a role in the Unit Instance is told.', { fieldErrors: { reason: 'Required.' } });
  ctx.db.prepare('UPDATE organizations SET status = ?, suspended_reason = ?, suspended_at = ?, updated_at = ? WHERE id = ?')
    .run(status, status === 'active' ? null : reason!.trim().slice(0, 500), status === 'active' ? null : now(), now(), orgId);
  // Anything open into the organization ends with it.
  if (status !== 'active') ctx.db.prepare("UPDATE access_grants SET status = 'ended', ended_at = ?, ended_by = ? WHERE org_id = ? AND status IN ('pending', 'active')").run(now(), actor.id, orgId);
  audit(ctx, { actor_id: actor.id, action: `organization_${status === 'active' ? 'restored' : status}`, entity: 'organization', entity_id: orgId, org_id: orgId, detail: reason ?? null, ip });
  notifyOrg(ctx, orgId, 'org.view', { kind: 'system', title: status === 'active' ? `${org.name} is active again` : `${org.name} was ${status} by Vantage`, message: reason ?? undefined, actionUrl: '/console' });
  return publicOrg(getOrg(ctx, orgId)!);
}

export interface OrgRoleHolder { user_id: string; username: string; first_name: string; last_name: string; rank_abbr: string | null; role: OrgRole; granted_by: string | null; granted_by_name: string | null; expires_at: string | null; created_at: string; member: boolean }

export function orgRoleHolders(ctx: AppContext, orgId: string): OrgRoleHolder[] {
  const rows = ctx.db.prepare(`SELECT r.user_id, u.username, u.first_name, u.last_name, rk.abbr AS rank_abbr, r.role, r.granted_by, g.first_name || ' ' || g.last_name AS granted_by_name, r.expires_at, r.created_at
      FROM org_roles r JOIN users u ON u.id = r.user_id LEFT JOIN ranks rk ON rk.id = u.rank_id LEFT JOIN users g ON g.id = r.granted_by
     WHERE r.org_id = ? AND u.active = 1 AND (r.expires_at IS NULL OR r.expires_at > ?) ORDER BY CASE r.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'records' THEN 2 ELSE 3 END, u.last_name`)
    .all(orgId, now()) as Array<Omit<OrgRoleHolder, 'member'>>;
  return rows.map((r) => ({ ...r, member: isOrgMember(ctx, orgId, r.user_id) }));
}

/** The Lead Unit Managers whose role confers authority now: active, unexpired, and still members of the Unit Instance. */
export const liveOwners = (ctx: AppContext, orgId: string) =>
  (ctx.db.prepare(`SELECT r.user_id FROM org_roles r JOIN users u ON u.id = r.user_id WHERE r.org_id = ? AND r.role = 'owner' AND u.active = 1 AND (r.expires_at IS NULL OR r.expires_at > ?) AND ${seatedOrgRole('r')}`).all(orgId, now()) as Array<{ user_id: string }>).map((r) => r.user_id);

/**
 * Grant a Unit Instance role to a member of the Unit Instance, until a date if one is given. Granting yourself a role,
 * or changing the end date of one you hold, is refused: another Lead Unit Manager does it, so no single account can widen
 * its own reach (ADR-0010).
 */
export function grantOrgRole(ctx: AppContext, actor: SessionUser, orgId: string, input: { user_id: string; role: string; expires_at?: string | null }, ip?: string) {
  if (!ORG_ROLE_KEYS.includes(input.role as OrgRole)) throw badRequest('That is not a Unit Instance role.');
  if (input.user_id === actor.id) throw forbidden('Another Lead Unit Manager must change your own Unit Instance roles.', 'self_grant');
  const target = ctx.db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ? AND active = 1').get(input.user_id) as { id: string; first_name: string; last_name: string } | undefined;
  if (!target) throw notFound('No such active account.');
  if (!isOrgMember(ctx, orgId, target.id)) throw badRequest('Unit Instance roles go to members of the Unit Instance. Add them to a unit first.', { fieldErrors: { user_id: 'Not a member of this Unit Instance.' } });
  const expires = input.expires_at ? new Date(input.expires_at) : null;
  if (expires && (Number.isNaN(expires.getTime()) || expires.getTime() <= Date.now())) throw badRequest('An end date must be in the future.', { fieldErrors: { expires_at: 'Must be in the future.' } });
  ctx.db.prepare(`INSERT INTO org_roles (org_id, user_id, role, granted_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(org_id, user_id, role) DO UPDATE SET granted_by = excluded.granted_by, expires_at = excluded.expires_at, created_at = excluded.created_at`)
    .run(orgId, target.id, input.role, actor.id, expires ? expires.toISOString() : null, now());
  invalidateUserSessions(ctx, target.id);
  audit(ctx, { actor_id: actor.id, action: 'org_role_granted', entity: 'organization', entity_id: orgId, org_id: orgId, subject_id: target.id, detail: `${input.role}${expires ? ` until ${expires.toISOString().slice(0, 10)}` : ''}`, ip });
  const label = ORG_ROLES[input.role as OrgRole].label;
  const orgName = getOrg(ctx, orgId)?.name ?? 'a Unit Instance';
  notify(ctx, target.id, { kind: 'unit', title: `You are now ${label} of ${orgName}`, message: `${ORG_ROLES[input.role as OrgRole].description} Sign in again to pick it up.`, actionUrl: '/console' });
  notifyOrg(ctx, orgId, 'org.owners', { kind: 'system', title: `${target.first_name} ${target.last_name} was made ${label}`, message: `By ${actor.first_name} ${actor.last_name}${expires ? `, until ${expires.toISOString().slice(0, 10)}` : ''}.`, actionUrl: '/console/people' }, actor.id);
  return orgRoleHolders(ctx, orgId);
}

export function revokeOrgRole(ctx: AppContext, actor: SessionUser, orgId: string, userId: string, role: string, ip?: string) {
  if (!ORG_ROLE_KEYS.includes(role as OrgRole)) throw badRequest('That is not a Unit Instance role.');
  if (role === 'owner') {
    const owners = liveOwners(ctx, orgId);
    if (owners.includes(userId) && owners.length === 1) throw badRequest('A Unit Instance always keeps at least one Lead Unit Manager. Name another first.', { code: 'last_owner' });
  }
  const r = ctx.db.prepare('DELETE FROM org_roles WHERE org_id = ? AND user_id = ? AND role = ?').run(orgId, userId, role);
  if (!r.changes) throw notFound('They do not hold that role.');
  invalidateUserSessions(ctx, userId);
  audit(ctx, { actor_id: actor.id, action: 'org_role_revoked', entity: 'organization', entity_id: orgId, org_id: orgId, subject_id: userId, detail: role, ip });
  return orgRoleHolders(ctx, orgId);
}

/**
 * A Vantage Administrator names a Lead Unit Manager only for a Unit Instance that has none (the last one left, say), and
 * never themselves (ADR-0010). A Unit Instance with Lead Unit Managers names its own: the platform never adds itself, or
 * anyone, to a running command.
 */
export function nameFirstOwner(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string, userId: string, ip?: string) {
  const org = getOrg(ctx, orgId);
  if (!org) throw notFound('No such Unit Instance.');
  if (userId === actor.id) throw forbidden('A Vantage Administrator never names themselves a Unit Instance’s Lead Unit Manager. Name the person the command designated.', 'self_grant');
  if (liveOwners(ctx, orgId).length) throw conflict('This Unit Instance has Lead Unit Managers; they name any others.', 'has_owners');
  const target = ctx.db.prepare('SELECT id FROM users WHERE id = ? AND active = 1').get(userId) as { id: string } | undefined;
  if (!target) throw notFound('No such active account.');
  ctx.db.transaction(() => {
    ctx.db.prepare(`INSERT INTO org_roles (org_id, user_id, role, granted_by, created_at) VALUES (?, ?, 'owner', ?, ?)
                    ON CONFLICT(org_id, user_id, role) DO UPDATE SET granted_by = excluded.granted_by, expires_at = NULL, created_at = excluded.created_at`).run(orgId, userId, actor.id, now());
    // A Lead Unit Manager of a Unit Instance nobody leads also leads its top unit, so somebody holds its records.
    const root = org.root_unit_id ? ctx.db.prepare('SELECT owner_user_id FROM units WHERE id = ?').get(org.root_unit_id) as { owner_user_id: string | null } | undefined : undefined;
    if (org.root_unit_id && root && !root.owner_user_id) claimUnit(ctx, org.root_unit_id, userId);
    // A Unit Instance role is held by a member (ADR-0010): someone from outside it is seated in its top unit, with its default role.
    else if (org.root_unit_id && !isOrgMember(ctx, orgId, userId)) addMember(ctx, userId, org.root_unit_id, { invitedBy: actor.id, reason: 'manager_assigned' });
  })();
  invalidateUserSessions(ctx, userId);
  audit(ctx, { actor_id: actor.id, action: 'org_owner_named', entity: 'organization', entity_id: orgId, org_id: orgId, subject_id: userId, ip });
  audit(ctx, { actor_id: actor.id, action: 'platform_owner_named', entity: 'organization', entity_id: orgId, subject_id: userId, detail: org.name, ip });
  notify(ctx, userId, { kind: 'unit', title: `You are Lead Unit Manager of ${org.name} on Vantage`, message: 'A Vantage Administrator named you because it had none. Sign in again and open the Unit Manager console.', actionUrl: '/console' });
  return orgRoleHolders(ctx, orgId);
}

/**
 * A Vantage Administrator adds a Lead Unit Manager or Unit Manager to any Unit Instance at any time, never themselves
 * (John, 2026-10-08; ADR-0010 §5). Only a member of the Unit Instance is assigned: the platform names who runs a command,
 * it does not add people to one. The instance's Lead Unit Managers are told, and the step is in both audit trails.
 */
export function assignManager(ctx: AppContext, actor: SessionUser, orgId: string, input: { user_id: string; role: UnitManagerRole }, ip?: string) {
  const org = getOrg(ctx, orgId);
  if (!org) throw notFound('No such Unit Instance.');
  if (input.user_id === actor.id) throw forbidden('A Vantage Administrator never assigns themselves a Unit Instance role. Another one, or its Lead Unit Managers, does.', 'self_grant');
  const roles = grantOrgRole(ctx, actor, orgId, { user_id: input.user_id, role: input.role }, ip);
  audit(ctx, { actor_id: actor.id, action: 'platform_manager_assigned', entity: 'organization', entity_id: orgId, subject_id: input.user_id, detail: `${org.name}: ${ORG_ROLES[input.role].label}`, ip });
  return roles;
}

/**
 * A Vantage Administrator removes a Lead Unit Manager or Unit Manager from any Unit Instance, never themselves, and never
 * its last Lead Unit Manager. The person and the instance's Lead Unit Managers are told; the step is in both audit trails.
 */
export function removeManager(ctx: AppContext, actor: SessionUser, orgId: string, userId: string, role: UnitManagerRole, ip?: string) {
  const org = getOrg(ctx, orgId);
  if (!org) throw notFound('No such Unit Instance.');
  if (userId === actor.id) throw forbidden('A Vantage Administrator never changes their own Unit Instance roles from the Vantage Administrator console.', 'self_grant');
  const person = ctx.db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(userId) as { first_name: string; last_name: string } | undefined;
  if (!person) throw notFound('No such account.');
  const roles = revokeOrgRole(ctx, actor, orgId, userId, role, ip);
  const label = ORG_ROLES[role].label;
  audit(ctx, { actor_id: actor.id, action: 'platform_manager_removed', entity: 'organization', entity_id: orgId, subject_id: userId, detail: `${org.name}: ${label}`, ip });
  notify(ctx, userId, { kind: 'unit', title: `You are no longer ${label} of ${org.name}`, message: 'A Vantage Administrator removed the role. Ask your Lead Unit Manager if you did not expect this.', actionUrl: '/settings' });
  notifyOrg(ctx, orgId, 'org.owners', { kind: 'system', title: `${person.first_name} ${person.last_name} is no longer ${label}`, message: `Removed by Vantage (${actor.first_name} ${actor.last_name}).`, actionUrl: '/console/people' }, userId);
  return roles;
}

/** The Unit Instance's members with their units; at most `limit` people (500 for a page), or all of them with `null`. */
export function orgMembers(ctx: AppContext, orgId: string, q = '', limit: number | null = 500) {
  const pattern = q.trim() ? `%${q.trim().toLowerCase().replace(/[\\%_]/g, '\\$&')}%` : null;
  const people = ctx.db.prepare(`SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.edipi, u.active, u.last_login_at, u.totp_enabled, u.must_change_password,
        CASE WHEN u.locked_until > ? THEN u.locked_until END AS locked_until, rk.abbr AS rank_abbr,
        (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys,
        (SELECT COUNT(DISTINCT un2.org_id) FROM unit_members um2 JOIN units un2 ON un2.id = um2.unit_id WHERE um2.user_id = u.id AND un2.org_id <> ?) AS other_orgs
      FROM users u LEFT JOIN ranks rk ON rk.id = u.rank_id
     WHERE u.id IN (${memberIdsSql}) ${pattern ? "AND (lower(u.last_name) LIKE ? ESCAPE '\\' OR lower(u.first_name) LIKE ? ESCAPE '\\' OR lower(u.username) LIKE ? ESCAPE '\\')" : ''}
     ORDER BY u.active DESC, u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE LIMIT ?`)
    .all(now(), orgId, orgId, ...(pattern ? [pattern, pattern, pattern] : []), limit ?? -1) as Array<Record<string, unknown> & { id: string; email: string | null }>;
  const units = ctx.db.prepare(`SELECT um.user_id, un.id AS unit_id, COALESCE(un.short_name, un.name) AS unit, um.billet, um.is_primary,
        (SELECT GROUP_CONCAT(r.name, ', ') FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id = um.user_id AND mr.unit_id = um.unit_id AND (mr.expires_at IS NULL OR mr.expires_at > ?)) AS roles
      FROM unit_members um JOIN units un ON un.id = um.unit_id WHERE un.org_id = ? AND un.active = 1`).all(now(), orgId) as Array<{ user_id: string; unit_id: string; unit: string; billet: string | null; is_primary: number; roles: string | null }>;
  const byUser = new Map<string, typeof units>();
  for (const u of units) byUser.set(u.user_id, [...(byUser.get(u.user_id) || []), u]);
  return people.map((p) => ({ ...p, units: (byUser.get(p.id) || []).map(({ user_id: _u, ...rest }) => rest) }));
}

/**
 * Taking someone out of the last unit they hold in a Unit Instance ends any Unit Instance role they hold there, so on a
 * role holder it is a Lead Unit Manager's to do (`org.owners`), and never on the last Lead Unit Manager. Throws otherwise.
 */
export function assertMayEndInstanceRoles(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string | null, userId: string) {
  if (!orgId) return;
  const held = (ctx.db.prepare('SELECT role FROM org_roles WHERE org_id = ? AND user_id = ?').all(orgId, userId) as Array<{ role: string }>).map((r) => r.role);
  if (!held.length) return;
  if (userId !== actor.id && !orgCan(scopeFor(ctx, actor), 'org.owners', orgId)) throw forbidden('They hold a Unit Instance role, which ends when they leave its last unit. A Lead Unit Manager removes them.', 'org_permission');
  const owners = liveOwners(ctx, orgId);
  if (held.includes('owner') && owners.includes(userId) && owners.length === 1) throw badRequest('They are the Unit Instance’s only Lead Unit Manager. Name another first.', { code: 'last_owner' });
}

/** Take someone out of every unit of the Unit Instance: their claims are released, their account is theirs to keep. */
export function removeFromOrg(ctx: AppContext, actor: SessionUser, orgId: string, userId: string, ip?: string) {
  if (userId === actor.id) throw forbidden('A second authorized person must change your own membership.', 'self_membership_change');
  // Taking someone out also ends their Unit Instance roles: a Lead Unit Manager's to do on a role holder, never the last one.
  assertMayEndInstanceRoles(ctx, actor, orgId, userId);
  const leads = ctx.db.prepare('SELECT name FROM units WHERE org_id = ? AND owner_user_id = ? AND active = 1').all(orgId, userId) as Array<{ name: string }>;
  if (leads.length) throw badRequest(`They lead ${leads.map((u) => u.name).join(', ')}. Transfer that leadership first.`);
  const units = ctx.db.prepare('SELECT um.unit_id FROM unit_members um JOIN units un ON un.id = um.unit_id WHERE un.org_id = ? AND um.user_id = ?').all(orgId, userId) as Array<{ unit_id: string }>;
  if (!units.length) throw notFound('They are not a member of this Unit Instance.');
  let claimsReleased = 0;
  ctx.db.transaction(() => {
    // Leaving the last of them ends their Unit Instance roles, recorded as org_role_ended (ADR-0010).
    for (const u of units) claimsReleased += removeMember(ctx, userId, u.unit_id, actor.id, 'removed_from_instance').claimsReleased;
  })();
  const sessionsRevoked = invalidateUserSessions(ctx, userId);
  audit(ctx, { actor_id: actor.id, action: 'removed_from_organization', entity: 'organization', entity_id: orgId, org_id: orgId, subject_id: userId, detail: `${units.length} units; ${claimsReleased} claims released`, ip });
  return { units: units.length, claimsReleased, sessionsRevoked };
}

export function orgUnits(ctx: AppContext, orgId: string) {
  return ctx.db.prepare(`SELECT u.id, u.code, u.name, u.short_name, u.echelon, u.parent_id, u.active, u.owner_user_id, o.first_name AS owner_first, o.last_name AS owner_last,
      (SELECT COUNT(*) FROM unit_members um WHERE um.unit_id = u.id) AS members FROM units u LEFT JOIN users o ON o.id = u.owner_user_id
     WHERE u.org_id = ? ORDER BY u.active DESC, u.name COLLATE NOCASE`).all(orgId);
}

/** Lead a unit of the Unit Instance: for a Unit Manager to name, so no unit is left without a leader. */
export function setUnitLeader(ctx: AppContext, actor: SessionUser, orgId: string, unitId: string, userId: string, ip?: string) {
  const unit = ctx.db.prepare('SELECT id, name FROM units WHERE id = ? AND org_id = ? AND active = 1').get(unitId, orgId) as { id: string; name: string } | undefined;
  if (!unit) throw notFound('No such unit in this Unit Instance.');
  if (!isOrgMember(ctx, orgId, userId)) throw badRequest('A unit’s leader must be a member of the Unit Instance.', { fieldErrors: { user_id: 'Not a member.' } });
  // Leading a unit reads its records: naming yourself is the self-grant no Unit Manager makes (ADR-0010).
  guardSelfReach(ctx, actor, scopeFor(ctx, actor), unitId, PERMISSIONS.ADMINISTRATOR, userId, `Making yourself leader of ${unit.name}`);
  const { previous, sessionsRevoked } = claimUnit(ctx, unitId, userId);
  audit(ctx, { actor_id: actor.id, action: 'unit_leader_set', entity: 'unit', entity_id: unitId, unit_id: unitId, org_id: orgId, subject_id: userId, detail: `${previous || 'unled'} -> ${userId}`, ip });
  notify(ctx, userId, { kind: 'unit', title: `You now lead ${unit.name}`, message: 'Sign in again to pick up the new authority.', actionUrl: '/team' });
  return { ok: true, sessionsRevoked };
}

/**
 * The organization's structure, for its own records: units, unit roles, members and who holds which role. Shared work
 * is not in it: that is exported unit by unit, by people whose unit role allows it, so the export cannot be a way
 * around the rule that organization roles do not read records.
 */
export function exportOrganization(ctx: AppContext, orgId: string) {
  const org = getOrg(ctx, orgId);
  if (!org) throw notFound('No such Unit Instance.');
  const unitIds = JSON.stringify(orgUnitIds(ctx, orgId, false));
  return {
    format: 'vantage-organization/1',
    generated_at: now(),
    organization: publicOrg(org),
    units: orgUnits(ctx, orgId),
    roles: (ctx.db.prepare('SELECT id, unit_id, key, name, description, position, permissions, is_default FROM roles WHERE unit_id IN (SELECT value FROM json_each(?)) ORDER BY unit_id, position DESC').all(unitIds) as Array<{ permissions: number } & Record<string, unknown>>)
      .map((r) => ({ ...r, permission_names: listPermissions(r.permissions) })),
    members: orgMembers(ctx, orgId).map(({ email: _e, ...m }) => m),
    organization_roles: orgRoleHolders(ctx, orgId),
  };
}
