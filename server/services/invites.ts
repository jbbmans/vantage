import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, isMember, PERMISSIONS } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { randomBytes } from 'node:crypto';
import { newId, now } from '../lib/ids.ts';
import { sha256 } from '../lib/crypto.ts';
import { audit } from './audit.ts';
import { addMember, assertMayGrantRole, getUnit, type RoleRow } from './org.ts';

const HASH = (code: string) => sha256(`unit_invite:${code.trim().toUpperCase()}`);

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

  let roleId: string | null = null;
  if (input.role_id) {
    const role = ctx.db.prepare('SELECT * FROM roles WHERE id = ? AND unit_id = ?').get(String(input.role_id), unitId) as RoleRow | undefined;
    if (!role) throw badRequest('No such role in that unit.');
    assertMayGrantRole(ctx, actor, scope, role, unitId);
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
    ctx.db.prepare('INSERT INTO unit_invite_uses (id, invite_id, user_id, created_at) VALUES (?, ?, ?, ?)')
      .run(newId(), row.id, user.id, now());
    audit(ctx, { actor_id: user.id, action: 'unit_invite_redeemed', entity: 'unit', entity_id: row.unit_id, subject_id: user.id, unit_id: row.unit_id, ip });
    return { unit_id: unit.id, unit_name: unit.name };
  })();
}

export const _internals = { freshCode, HASH, isMember };
