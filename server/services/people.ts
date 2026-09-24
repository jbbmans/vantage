import type { AppContext, SessionUser } from '../context.ts';
import { scopeFor, can, unitsWith, PERMISSIONS, isUnitOwner, positionIn, type Scope } from '../authz/scope.ts';
import { ROLE_TEMPLATE } from '../../shared/permissions.ts';
import { ACCESS_LABEL, LEVEL_ROLE_KEY, higherLevel, levelFromBits, levelRank, type AccessLevel } from '../../shared/access.ts';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.ts';
import { addMember, getUnit, removeMember } from './org.ts';
import { audit } from './audit.ts';
import { notify } from './notifications.ts';
import { invalidateUserSessions } from '../auth/sessions.ts';
import { now } from '../lib/ids.ts';

/**
 * People: who is in the organization, what each person can do in each of their teams, and the
 * controls to change it.
 *
 * Access is described in three levels (shared/access.ts) and stored the way it always was, as
 * roles inside each team. Setting a level grants or removes the system role behind it, so a team
 * that built its own roles keeps them and a level read back is always what the permissions say.
 *
 * Who may change what follows the rules the rest of the product already uses:
 *   - a team leader brings people onto the team and removes them, and sets nobody's level;
 *   - someone who manages roles in a team sets levels whose role sits below their own;
 *   - the team's owner sets any level in their team, including Administrator;
 *   - an organization administrator (the instance owner) can do all of this in every team, after
 *     confirming their password, and is the only one who suspends accounts or resets sign-ins.
 * Nobody changes their own access, and a team's owner is changed by transferring ownership.
 */

export interface PersonTeam {
  unit_id: string; unit_name: string; unit_short: string | null; billet: string | null; is_primary: number; joined_at: string;
  level: AccessLevel; owner: boolean; roles: Array<{ id: string; name: string; color: string | null }>;
  /** The levels the caller may set here; empty when they may not change it. */
  settable: AccessLevel[];
  removable: boolean;
}

/** Where a level's role sits in this team. A team's owner can move a role, so the team's own row wins over the template. */
function levelPosition(ctx: AppContext, unitId: string, level: AccessLevel): number {
  const key = LEVEL_ROLE_KEY[level];
  if (!key) return 0;
  const row = ctx.db.prepare('SELECT position FROM roles WHERE unit_id = ? AND key = ?').get(unitId, key) as { position: number } | undefined;
  return row?.position ?? ROLE_TEMPLATE.find((r) => r.key === key)?.position ?? 0;
}
const LEVELS: AccessLevel[] = ['personal', 'leader', 'administrator'];

/** Teams whose people the caller manages. An organization administrator manages every team. */
export function managedUnitIds(ctx: AppContext, user: SessionUser, scope: Scope): string[] {
  const active = (ctx.db.prepare('SELECT id FROM units WHERE active = 1').all() as Array<{ id: string }>).map((r) => r.id);
  if (user.is_operator) return active;
  const managed = new Set(unitsWith(scope, PERMISSIONS.MANAGE_MEMBERS));
  return active.filter((id) => managed.has(id));
}

/** Where the caller's authority in a team comes from; an organization administrator acting outside their own teams must have confirmed their password. */
function authorityIn(ctx: AppContext, actor: SessionUser, scope: Scope, unitId: string, sudo: boolean) {
  const owner = isUnitOwner(ctx, actor.id, unitId);
  const manages = can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId);
  const orgAdmin = Boolean(actor.is_operator);
  const viaOrg = orgAdmin && !owner && !manages;
  if (viaOrg && !sudo) throw new HttpError(403, 'Confirm your password to continue.', 'sudo_required');
  return { manages: manages || orgAdmin || owner };
}

function settableFor(ctx: AppContext, actor: SessionUser, scope: Scope, unitId: string, target: { id: string; owner: boolean; position: number }): AccessLevel[] {
  if (target.owner || target.id === actor.id) return [];
  if (actor.is_operator || isUnitOwner(ctx, actor.id, unitId)) return LEVELS;
  if (!can(scope, PERMISSIONS.MANAGE_ROLES, unitId)) return [];
  const mine = positionIn(scope, unitId);
  if (target.position >= mine) return [];
  return LEVELS.filter((l) => levelPosition(ctx, unitId, l) < mine);
}

function removableFor(ctx: AppContext, actor: SessionUser, scope: Scope, unitId: string, target: { id: string; owner: boolean; position: number }): boolean {
  if (target.owner || target.id === actor.id) return false;
  if (actor.is_operator || isUnitOwner(ctx, actor.id, unitId)) return true;
  return can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId) && target.position < positionIn(scope, unitId);
}

export function listPeople(ctx: AppContext, actor: SessionUser, scope: Scope, opts: { sudo: boolean }) {
  const orgAdmin = Boolean(actor.is_operator);
  // The organization-wide list carries sign-in facts, so it asks for the password the way the owner
  // console does.
  if (orgAdmin && !opts.sudo) throw new HttpError(403, 'Confirm your password to continue.', 'sudo_required');
  const unitIds = managedUnitIds(ctx, actor, scope);
  if (!unitIds.length && !orgAdmin) throw forbidden('People is for team leaders and administrators.');
  const ph = (n: number) => Array.from({ length: n }, () => '?').join(',');

  const units = unitIds.length
    ? (ctx.db.prepare(`SELECT u.id, u.name, u.short_name, u.owner_user_id, (SELECT COUNT(*) FROM unit_members um JOIN users x ON x.id = um.user_id WHERE um.unit_id = u.id AND x.active = 1) AS members
         FROM units u WHERE u.id IN (${ph(unitIds.length)}) ORDER BY u.name`).all(...unitIds) as Array<{ id: string; name: string; short_name: string | null; owner_user_id: string | null; members: number }>)
    : [];
  const owners = new Map(units.map((u) => [u.id, u.owner_user_id]));

  const ids = orgAdmin
    ? (ctx.db.prepare('SELECT id FROM users').all() as Array<{ id: string }>).map((r) => r.id)
    : unitIds.length
      ? (ctx.db.prepare(`SELECT DISTINCT um.user_id AS id FROM unit_members um JOIN users u ON u.id = um.user_id WHERE um.unit_id IN (${ph(unitIds.length)}) AND u.active = 1`).all(...unitIds) as Array<{ id: string }>).map((r) => r.id)
      : [];
  if (!ids.length) return { people: [], units: [], stats: emptyStats(), orgAdmin, pendingInvites: 0 };

  const users = ctx.db.prepare(
    `SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.active, u.is_operator, u.totp_enabled, u.must_change_password, u.last_login_at, u.created_at, r.abbr AS rank_abbr,
            (SELECT COUNT(*) FROM passkeys p WHERE p.user_id = u.id) AS passkeys
       FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (${ph(ids.length)}) ORDER BY u.active DESC, u.last_name, u.first_name`
  ).all(...ids) as Array<Record<string, unknown> & { id: string; active: number; is_operator: number; totp_enabled: number; passkeys: number }>;
  const memberships = unitIds.length
    ? (ctx.db.prepare(`SELECT um.user_id, um.unit_id, um.billet, um.is_primary, um.joined_at, u.name AS unit_name, u.short_name AS unit_short
         FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id IN (${ph(ids.length)}) AND um.unit_id IN (${ph(unitIds.length)}) ORDER BY um.is_primary DESC, u.name`).all(...ids, ...unitIds) as Array<{ user_id: string; unit_id: string; billet: string | null; is_primary: number; joined_at: string; unit_name: string; unit_short: string | null }>)
    : [];
  const roles = unitIds.length
    ? (ctx.db.prepare(`SELECT mr.user_id, mr.unit_id, r.id, r.name, r.color, r.position, r.permissions, r.is_default FROM member_roles mr JOIN roles r ON r.id = mr.role_id
         WHERE mr.user_id IN (${ph(ids.length)}) AND mr.unit_id IN (${ph(unitIds.length)}) ORDER BY r.position DESC`).all(...ids, ...unitIds) as Array<{ user_id: string; unit_id: string; id: string; name: string; color: string | null; position: number; permissions: number; is_default: number }>)
    : [];

  const people = users.map((u) => {
    const teams: PersonTeam[] = memberships.filter((m) => m.user_id === u.id).map((m) => {
      const held = roles.filter((r) => r.user_id === u.id && r.unit_id === m.unit_id);
      const owner = owners.get(m.unit_id) === u.id;
      const level: AccessLevel = owner ? 'administrator' : levelFromBits(held.reduce((bits, r) => bits | r.permissions, 0));
      const target = { id: u.id, owner, position: owner ? 100 : held.reduce((p, r) => Math.max(p, r.position), 0) };
      return {
        ...m, level, owner,
        roles: held.filter((r) => !r.is_default).map(({ id, name, color }) => ({ id, name, color })),
        settable: settableFor(ctx, actor, scope, m.unit_id, target),
        removable: removableFor(ctx, actor, scope, m.unit_id, target),
      };
    });
    const level = teams.reduce<AccessLevel>((l, t) => higherLevel(l, t.level), u.is_operator ? 'administrator' : 'personal');
    const base = { id: u.id, first_name: u.first_name, last_name: u.last_name, rank_abbr: u.rank_abbr, active: u.active, level, org_admin: Boolean(u.is_operator), teams };
    // Sign-in facts are for the organization administrator, who is the one who can act on them.
    return orgAdmin
      ? { ...base, username: u.username, email: u.email, mfa: Boolean(u.totp_enabled) || u.passkeys > 0, must_change_password: Boolean(u.must_change_password), last_login_at: u.last_login_at, created_at: u.created_at }
      : base;
  });

  const pendingInvites = unitIds.length
    ? (ctx.db.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE kind = 'invite' AND used_at IS NULL AND expires_at > ? AND json_extract(payload, '$.unit_id') IN (${ph(unitIds.length)})`).get(now(), ...unitIds) as { n: number }).n
    : 0;
  const active = people.filter((p) => p.active);
  const stats = {
    people: active.length,
    personal: active.filter((p) => p.level === 'personal').length,
    leader: active.filter((p) => p.level === 'leader').length,
    administrator: active.filter((p) => p.level === 'administrator').length,
    suspended: people.length - active.length,
    without_mfa: orgAdmin ? active.filter((p) => !('mfa' in p && p.mfa)).length : null,
  };
  audit(ctx, { actor_id: actor.id, action: 'view_people', detail: `${people.length} people across ${units.length} teams` });
  return {
    people, stats, orgAdmin, pendingInvites,
    units: units.map((u) => ({
      id: u.id, name: u.name, short_name: u.short_name, members: u.members,
      canInvite: can(scope, PERMISSIONS.MANAGE_MEMBERS, u.id) || isUnitOwner(ctx, actor.id, u.id),
      // The levels a newcomer can be brought in at: Personal always, and higher where the caller could set it.
      grantable: ['personal' as AccessLevel, ...settableFor(ctx, actor, scope, u.id, { id: '', owner: false, position: 0 }).filter((l) => l !== 'personal')],
    })),
  };
}

const emptyStats = () => ({ people: 0, personal: 0, leader: 0, administrator: 0, suspended: 0, without_mfa: null as number | null });

/** The system role behind a level, created from the template if this team predates it or deleted it. */
function levelRoleId(ctx: AppContext, unitId: string, level: AccessLevel): string | null {
  const key = LEVEL_ROLE_KEY[level];
  if (!key) return null;
  const existing = ctx.db.prepare('SELECT id FROM roles WHERE unit_id = ? AND key = ?').get(unitId, key) as { id: string } | undefined;
  if (existing) return existing.id;
  const t = ROLE_TEMPLATE.find((r) => r.key === key)!;
  const id = `${unitId}:${key}`.slice(0, 120);
  ctx.db.prepare('INSERT OR IGNORE INTO roles (id, unit_id, key, name, description, color, position, permissions, is_default, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)')
    .run(id, unitId, key, t.name, t.description, t.color, t.position, t.permissions, now());
  return id;
}

/**
 * Sets a person's level in one team. Roles that give more than the new level are removed; the
 * level's own role is granted if what remains gives less. A custom role that fits inside the new
 * level is left alone, so lowering someone to Team leader does not also strip their counseling role.
 */
export function setTeamLevel(ctx: AppContext, actor: SessionUser, userId: string, unitId: string, level: AccessLevel, opts: { sudo: boolean; ip?: string }) {
  if (!LEVELS.includes(level)) throw badRequest('Choose Personal, Team leader or Administrator.');
  const unit = getUnit(ctx, unitId);
  if (!unit) throw notFound('No such team.');
  const scope = scopeFor(ctx, actor);
  authorityIn(ctx, actor, scope, unitId, opts.sudo);
  if (userId === actor.id) throw forbidden('Someone else has to change your own access.', 'self_access_change');
  if (!ctx.db.prepare('SELECT 1 FROM unit_members um JOIN users u ON u.id = um.user_id WHERE um.user_id = ? AND um.unit_id = ? AND u.active = 1').get(userId, unitId)) throw notFound('That person is not an active member of this team.');
  if (isUnitOwner(ctx, userId, unitId)) throw badRequest('That person owns this team. Transfer ownership to change their access.', { code: 'owner' });

  const held = ctx.db.prepare('SELECT r.id, r.name, r.key, r.position, r.permissions, r.is_default FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id = ? AND mr.unit_id = ?').all(userId, unitId) as Array<{ id: string; name: string; key: string | null; position: number; permissions: number; is_default: number }>;
  const target = { id: userId, owner: false, position: held.reduce((p, r) => Math.max(p, r.position), 0) };
  const allowed = settableFor(ctx, actor, scope, unitId, target);
  if (!allowed.includes(level)) {
    throw forbidden(allowed.length ? `You can set ${allowed.map((l) => ACCESS_LABEL[l]).join(' or ')} here, not ${ACCESS_LABEL[level]}.` : 'You cannot change this person’s access in that team.', 'hierarchy');
  }

  const before = levelFromBits(held.reduce((bits, r) => bits | r.permissions, 0));
  const remove = held.filter((r) => !r.is_default && levelRank(levelFromBits(r.permissions)) > levelRank(level));
  const kept = held.filter((r) => !remove.includes(r));
  const keptLevel = levelFromBits(kept.reduce((bits, r) => bits | r.permissions, 0));
  let granted: string | null = null;
  ctx.db.transaction(() => {
    for (const r of remove) ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ?').run(userId, r.id);
    if (levelRank(keptLevel) < levelRank(level)) {
      const roleId = levelRoleId(ctx, unitId, level)!;
      ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, roleId, unitId, actor.id, now());
      granted = (ctx.db.prepare('SELECT name FROM roles WHERE id = ?').get(roleId) as { name: string }).name;
    }
  })();
  const revoked = invalidateUserSessions(ctx, userId);
  const detail = `${ACCESS_LABEL[before]} → ${ACCESS_LABEL[level]}${remove.length ? `; removed: ${remove.map((r) => r.name).join(', ')}` : ''}${granted ? `; granted: ${granted}` : ''}; sessions revoked: ${revoked}`;
  audit(ctx, { actor_id: actor.id, action: 'set_access_level', entity: 'unit', entity_id: unitId, subject_id: userId, unit_id: unitId, detail, ip: opts.ip });
  if (before !== level) {
    notify(ctx, userId, { kind: 'unit', title: 'Your access changed', message: `${actor.first_name} ${actor.last_name} set your access in ${unit.short_name || unit.name} to ${ACCESS_LABEL[level]}. Sign in again to see it.`, actionUrl: '/', dedupeKey: `level:${unitId}:${userId}:${level}` });
  }
  return { ok: true, before, level, removed: remove.map((r) => r.name), granted, sessionsRevoked: revoked };
}

/** Brings someone who already has an account onto a team, at a level the caller may set. */
export function addToTeam(ctx: AppContext, actor: SessionUser, userId: string, unitId: string, level: AccessLevel, opts: { sudo: boolean; billet?: string | null; ip?: string }) {
  const unit = getUnit(ctx, unitId);
  if (!unit) throw notFound('No such team.');
  const scope = scopeFor(ctx, actor);
  const { manages } = authorityIn(ctx, actor, scope, unitId, opts.sudo);
  if (!manages) throw forbidden('You cannot add people to that team.');
  if (userId === actor.id) throw forbidden('Someone else has to change your own membership.', 'self_membership_change');
  if (!ctx.db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(userId)) throw badRequest('No such active account.');
  if (ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId)) throw badRequest('That person is already on this team.');
  if (level !== 'personal' && !settableFor(ctx, actor, scope, unitId, { id: userId, owner: false, position: 0 }).includes(level)) throw forbidden(`You cannot bring someone on as ${ACCESS_LABEL[level]}.`, 'hierarchy');
  addMember(ctx, userId, unitId, { invitedBy: actor.id, billet: opts.billet || null });
  audit(ctx, { actor_id: actor.id, action: 'add_member', entity: 'unit', entity_id: unitId, subject_id: userId, unit_id: unitId, detail: 'from People', ip: opts.ip });
  notify(ctx, userId, { kind: 'unit', title: 'Added to a team', message: `${actor.first_name} ${actor.last_name} added you to ${unit.name}. Sign in again to see it.`, actionUrl: '/', dedupeKey: `member:${unitId}:${userId}` });
  const result = level === 'personal' ? null : setTeamLevel(ctx, actor, userId, unitId, level, opts);
  if (!result) invalidateUserSessions(ctx, userId);
  return { ok: true, level };
}

/** Takes someone off a team. Their shared records there are frozen, as they are for any departure. */
export function removeFromTeam(ctx: AppContext, actor: SessionUser, userId: string, unitId: string, opts: { sudo: boolean; ip?: string }) {
  if (!getUnit(ctx, unitId)) throw notFound('No such team.');
  const scope = scopeFor(ctx, actor);
  authorityIn(ctx, actor, scope, unitId, opts.sudo);
  if (!ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId)) throw notFound('That person is not on this team.');
  const owner = isUnitOwner(ctx, userId, unitId);
  const position = owner ? 100 : positionIn(scopeFor(ctx, { id: userId }), unitId);
  if (owner) throw badRequest('That person owns this team. Transfer ownership first.', { code: 'last_owner' });
  if (!removableFor(ctx, actor, scope, unitId, { id: userId, owner, position })) throw forbidden('You cannot remove that person from this team.', 'hierarchy');
  const removed = removeMember(ctx, userId, unitId);
  const revoked = invalidateUserSessions(ctx, userId);
  audit(ctx, { actor_id: actor.id, action: 'remove_member', entity: 'unit', entity_id: unitId, subject_id: userId, unit_id: unitId, detail: `from People; roles: ${removed.roles}; records frozen: ${removed.recordsFrozen}; claims released: ${removed.claimsReleased}; sessions revoked: ${revoked}`, ip: opts.ip });
  return { ok: true, ...removed, sessionsRevoked: revoked };
}
