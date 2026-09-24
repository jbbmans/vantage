import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, isMember, isUnitOwner, PERMISSIONS } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { randomBytes } from 'node:crypto';
import { newId, now } from '../lib/ids.ts';
import { sha256 } from '../lib/crypto.ts';
import { audit } from './audit.ts';
import { addMember, getUnit } from './org.ts';

/**
 * Join codes for a unit.
 *
 * Members used to arrive one way only: somebody with MANAGE_MEMBERS enrolled them by hand, which
 * means every unit needs an administrator awake before anybody can join it. A code is the other
 * half — the owner makes one, sends it, and people let themselves in.
 *
 * The code is stored only as a hash, the same way a password reset token is, so a copy of the
 * database is not a pile of working invitations. A short hint is kept in the clear so the person
 * who made three of them can tell which is which; a hint identifies an invite but does not open it.
 *
 * `tokens` could not be reused for this: those are single-use and short-lived by construction, and
 * an invite is deliberately neither.
 */

const HASH = (code: string) => sha256(`unit_invite:${code.trim().toUpperCase()}`);

/**
 * Unambiguous alphabet: no O or 0, no I, 1 or L. People read these off a screen and type them in.
 *
 * Drawn from raw random bytes rather than from randomToken(), which returns base64url — the first
 * version of this parsed those characters as hex and produced a code reading "undefinedundefined".
 * Bytes are rejected above the largest exact multiple of the alphabet length so the modulo does not
 * quietly favour the first few letters.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function freshCode(): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < 10) {
    for (const byte of randomBytes(16)) {
      if (byte >= limit) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === 10) break;
    }
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

export interface InviteRow {
  id: string; unit_id: string; code_hash: string; code_hint: string; created_by: string;
  role_id: string | null; note: string | null; max_uses: number | null; uses: number;
  expires_at: string | null; revoked_at: string | null; created_at: string;
}

const publicView = (row: InviteRow) => ({
  id: row.id, unit_id: row.unit_id, code_hint: row.code_hint, note: row.note,
  max_uses: row.max_uses, uses: row.uses, expires_at: row.expires_at, revoked_at: row.revoked_at,
  created_at: row.created_at, role_id: row.role_id,
});

/** Inviting people into a unit is the same authority as enrolling them by hand. */
function assertMayInvite(scope: Scope, unitId: string) {
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot invite people into that unit.');
}

export function createInvite(
  ctx: AppContext,
  actor: SessionUser,
  scope: Scope,
  unitId: string,
  input: { role_id?: string | null; note?: string | null; max_uses?: number | null; expires_in_hours?: number | null },
  ip?: string,
) {
  if (!getUnit(ctx, unitId)) throw notFound('No such unit.');
  assertMayInvite(scope, unitId);

  // A code may hand out a role, but only as the same authority that grants one by hand or by an
  // emailed invitation: managing roles, and never at or above the person writing the code.
  // Managing members alone lets somebody bring people in, not decide what they may do once there.
  let roleId: string | null = null;
  if (input.role_id) {
    const role = ctx.db.prepare('SELECT id, key, unit_id, position, permissions FROM roles WHERE id = ? AND unit_id = ?')
      .get(String(input.role_id), unitId) as { id: string; key: string; position: number; permissions: number } | undefined;
    if (!role) throw badRequest('No such role in that unit.');
    if (role.key === 'unit-leader') throw badRequest('Unit Leader is granted by ownership transfer, not by a join code.');
    const myPosition = scope.positions[unitId] || 0;
    if (!actor.is_operator && !isUnitOwner(ctx, actor.id, unitId)) {
      if (!can(scope, PERMISSIONS.MANAGE_ROLES, unitId)) throw forbidden('A join code that grants a role needs authority to manage roles here.', 'hierarchy');
      if (role.position >= myPosition) throw forbidden('An invite cannot grant a role at or above your own.', 'hierarchy');
    }
    roleId = role.id;
  }

  const maxUses = input.max_uses == null ? null : Math.max(1, Math.min(1000, Number(input.max_uses)));
  const hours = input.expires_in_hours == null ? null : Math.max(1, Math.min(24 * 365, Number(input.expires_in_hours)));
  const code = freshCode();
  const id = newId();
  ctx.db.prepare(
    'INSERT INTO unit_invites (id, unit_id, code_hash, code_hint, created_by, role_id, note, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
  ).run(id, unitId, HASH(code), code.slice(0, 5), actor.id, roleId, input.note?.trim()?.slice(0, 200) || null,
        maxUses, hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null, now());
  audit(ctx, { actor_id: actor.id, action: 'unit_invite_created', entity: 'unit', entity_id: unitId, unit_id: unitId, ip });

  // The only time the full code is ever returned. It is not recoverable afterwards.
  return { ...publicView(ctx.db.prepare('SELECT * FROM unit_invites WHERE id = ?').get(id) as InviteRow), code };
}

export function listInvites(ctx: AppContext, scope: Scope, unitId: string) {
  assertMayInvite(scope, unitId);
  const rows = ctx.db.prepare('SELECT * FROM unit_invites WHERE unit_id = ? ORDER BY created_at DESC').all(unitId) as InviteRow[];
  return rows.map(publicView);
}

export function revokeInvite(ctx: AppContext, actor: SessionUser, scope: Scope, unitId: string, inviteId: string, ip?: string) {
  assertMayInvite(scope, unitId);
  const r = ctx.db.prepare('UPDATE unit_invites SET revoked_at = ? WHERE id = ? AND unit_id = ? AND revoked_at IS NULL').run(now(), inviteId, unitId);
  if (!r.changes) throw notFound('No such live invite.');
  audit(ctx, { actor_id: actor.id, action: 'unit_invite_revoked', entity: 'unit', entity_id: unitId, unit_id: unitId, ip });
  return { ok: true };
}

/** What a code points at, without joining. Shows the unit's name and nothing else about it. */
export function peekInvite(ctx: AppContext, code: string) {
  const row = ctx.db.prepare('SELECT * FROM unit_invites WHERE code_hash = ?').get(HASH(String(code || ''))) as InviteRow | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
  if (row.max_uses != null && row.uses >= row.max_uses) return null;
  const unit = getUnit(ctx, row.unit_id);
  return unit ? { unit_id: unit.id, unit_name: unit.name, note: row.note } : null;
}

export function redeemInvite(ctx: AppContext, user: SessionUser, code: string, ip?: string) {
  return ctx.db.transaction(() => {
    const row = ctx.db.prepare('SELECT * FROM unit_invites WHERE code_hash = ?').get(HASH(String(code || ''))) as InviteRow | undefined;
    // One message for every way a code can fail, so a wrong guess learns nothing about which codes
    // exist, which are spent, and which have merely expired.
    const dead = !row
      || Boolean(row.revoked_at)
      || Boolean(row.expires_at && Date.parse(row.expires_at) < Date.now())
      || (row.max_uses != null && row.uses >= row.max_uses);
    if (dead || !row) throw badRequest('That invite code is not valid. Ask for a new one.');

    const unit = getUnit(ctx, row.unit_id);
    if (!unit) throw badRequest('That invite code is not valid. Ask for a new one.');
    const already = ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(user.id, row.unit_id);
    if (already) throw conflict(`You are already in ${unit.name}.`);

    addMember(ctx, user.id, row.unit_id, { invitedBy: row.created_by });
    if (row.role_id) {
      ctx.db.prepare('INSERT OR IGNORE INTO member_roles (user_id, role_id, unit_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, row.role_id, row.unit_id, row.created_by, now());
    }
    ctx.db.prepare('UPDATE unit_invites SET uses = uses + 1 WHERE id = ?').run(row.id);
    // Kept separately from `uses` so revoking an invite never erases that somebody came in on it.
    ctx.db.prepare('INSERT INTO unit_invite_uses (id, invite_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(newId(), row.id, user.id, now());
    audit(ctx, { actor_id: user.id, action: 'unit_invite_redeemed', entity: 'unit', entity_id: row.unit_id, subject_id: user.id, unit_id: row.unit_id, ip });
    return { unit_id: unit.id, unit_name: unit.name };
  })();
}

export const _internals = { freshCode, HASH, isMember };
