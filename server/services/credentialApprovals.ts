import type { AppContext, SessionUser } from '../context.ts';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { seatedOrgRole } from '../authz/scope.ts';
import { platformRolesOf, staffWith } from '../authz/platform.ts';
import { audit } from './audit.ts';
import { notify } from './notifications.ts';
import { isEdipi } from './personnel.ts';

/**
 * Two people for a takeover (ADR-0013). Vantage support can set a temporary password, reset a second factor or re-key
 * a CAC on any account, and on an account that holds authority each of those is a way to sign in as that person. So
 * there, one staff member asks, saying why, and a second approves before the change can be made: somebody who holds
 * account support too, is neither the one asking nor the account itself, and is a Lead Vantage Administrator when the
 * account is staff. The one who asked then makes the change, once, within a day. Accounts with no authority are helped
 * as before. scripts/recover-operator.ts, run on the server itself, stays the way back in when nobody can sign in.
 */

export const CREDENTIAL_ACTIONS = ['temporary_password', 'reset_mfa', 'edipi'] as const;
export type CredentialAction = (typeof CREDENTIAL_ACTIONS)[number];

/** A request lapses a day after it is made, approved or not, so an old approval cannot be used as a surprise. */
export const APPROVAL_HOURS = 24;

export interface CredentialApproval {
  id: string; target_user_id: string; target_username: string; target_name: string; action: CredentialAction; edipi: string | null;
  reason: string; requested_by: string; requested_by_name: string; requested_at: string;
  status: 'pending' | 'approved' | 'denied' | 'used' | 'expired' | 'cancelled';
  decided_by: string | null; decided_by_name: string | null; decided_at: string | null; decision_note: string | null;
  used_at: string | null; expires_at: string;
}

const SELECT = `SELECT a.*, t.username AS target_username, t.first_name || ' ' || t.last_name AS target_name,
    r.first_name || ' ' || r.last_name AS requested_by_name, d.first_name || ' ' || d.last_name AS decided_by_name
  FROM credential_approvals a JOIN users t ON t.id = a.target_user_id JOIN users r ON r.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by`;

/** What the change does, in the words the audit trail and the notices use. */
export function describeChange(action: CredentialAction, edipi: string | null): string {
  if (action === 'temporary_password') return 'set a temporary password';
  if (action === 'reset_mfa') return 'reset the second factor';
  return edipi ? `link the CAC ending ${edipi.slice(-4)}` : 'remove the linked CAC';
}

/**
 * Authority given up this recently still counts, both ways round: removing an account's authority does not open its
 * sign-in to one staff member, and a staff member who changed an account's sign-in does not give it authority.
 */
export const RECENT_AUTHORITY_DAYS = 30;

const recentSince = () => new Date(Date.now() - RECENT_AUTHORITY_DAYS * 86_400_000).toISOString();

/** Trail entries about an account that end authority it held: a Unit Instance role, a platform role, leading a unit. */
const AUTHORITY_ENDED = ['org_role_revoked', 'org_role_ended', 'org_role_expired', 'platform_manager_removed', 'staff_role_revoked', 'unit_leader_ended'];
/** Entries that pass a unit's leadership on, naming the leader before as `<id> -> <successor>`. */
const LEADERSHIP_PASSED = ['transfer_ownership', 'unit_leader_set'];

/**
 * Whether an account holds authority: any platform role, a Unit Instance role that counts (unexpired, and held while the
 * person belongs to that instance, as scope.ts counts it), or the leadership of an active unit. Authority held within
 * the last RECENT_AUTHORITY_DAYS counts too, as the audit trail shows it ended, so taking it away, changing the sign-in
 * alone and giving it back is no way round the second person.
 */
export function holdsAuthority(ctx: AppContext, userId: string): boolean {
  return Boolean(ctx.db.prepare(`SELECT 1 FROM platform_roles WHERE user_id = ?
    UNION ALL SELECT 1 FROM org_roles r WHERE r.user_id = ? AND (r.expires_at IS NULL OR r.expires_at > ?) AND ${seatedOrgRole('r')}
    UNION ALL SELECT 1 FROM units WHERE owner_user_id = ? AND active = 1 LIMIT 1`).get(userId, userId, now(), userId)) || heldAuthorityRecently(ctx, userId);
}

/** Authority this account held within the last RECENT_AUTHORITY_DAYS and no longer does, from the trail. */
export function heldAuthorityRecently(ctx: AppContext, userId: string): boolean {
  const since = recentSince();
  return Boolean(ctx.db.prepare(`SELECT 1 FROM audit_log WHERE subject_id = ? AND at >= ? AND action IN (SELECT value FROM json_each(?))
    UNION ALL SELECT 1 FROM audit_log WHERE action IN (SELECT value FROM json_each(?)) AND at >= ? AND detail LIKE ? ESCAPE '\\'
    UNION ALL SELECT 1 FROM org_roles WHERE user_id = ? AND expires_at > ? AND expires_at <= ? LIMIT 1`)
    .get(userId, since, JSON.stringify(AUTHORITY_ENDED), JSON.stringify(LEADERSHIP_PASSED), since, `${userId.replace(/[\\%_]/g, '\\$&')} -> %`, userId, since, now()));
}

/**
 * A staff member who set a temporary password, reset the second factor or changed the CAC on an account within the last
 * RECENT_AUTHORITY_DAYS does not then give that account authority: a Unit Manager or Lead Unit Manager role, the first
 * Lead Unit Manager of a Unit Instance, or a platform role. Otherwise one person could take an account over while it held
 * nothing and then hand it authority. Another staff member can. Refused as recent_credential_change, written to the
 * trail as any refusal at the administration routes is.
 */
export function guardRecentCredentialChange(ctx: AppContext, actor: Pick<SessionUser, 'id'>, targetId: string): void {
  const changed = ctx.db.prepare(`SELECT 1 FROM audit_log WHERE subject_id = ? AND actor_id = ? AND at >= ?
    AND action IN ('temporary_password', 'reset_mfa', 'edipi_corrected') LIMIT 1`).get(targetId, actor.id, recentSince());
  if (changed) throw forbidden(`You changed this account’s sign-in in the last ${RECENT_AUTHORITY_DAYS} days, so you cannot give it authority. Another member of Vantage staff can.`, 'recent_credential_change');
}

/** Requests not used by the time they lapse are closed, so nothing reads an old approval as live. */
function expireApprovals(ctx: AppContext) {
  ctx.db.prepare("UPDATE credential_approvals SET status = 'expired' WHERE status IN ('pending', 'approved') AND expires_at <= ?").run(now());
}

function load(ctx: AppContext, id: string): CredentialApproval {
  expireApprovals(ctx);
  const row = ctx.db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as CredentialApproval | undefined;
  if (!row) throw notFound('No such request.');
  return row;
}

/** Open requests first, then the last thirty days of answered ones, for staff who support accounts. */
export function listApprovals(ctx: AppContext): CredentialApproval[] {
  expireApprovals(ctx);
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  return ctx.db.prepare(`${SELECT} WHERE a.status IN ('pending', 'approved') OR a.requested_at >= ?
    ORDER BY CASE a.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, a.requested_at DESC LIMIT 100`).all(since) as CredentialApproval[];
}

/** Staff who may answer a request about this account: account support, not the one asking, not the account itself. */
function approversFor(ctx: AppContext, requesterId: string, targetId: string): string[] {
  const leads = platformRolesOf(ctx, targetId).length ? new Set(staffWith(ctx, 'platform.staff')) : null;
  return staffWith(ctx, 'platform.accounts').filter((id) => id !== requesterId && id !== targetId && (!leads || leads.has(id)));
}

export function requestApproval(
  ctx: AppContext, actor: SessionUser, targetId: string,
  input: { action: CredentialAction; reason: string; edipi?: string | null }, ip?: string | null,
): CredentialApproval {
  const target = ctx.db.prepare('SELECT id, username, first_name, last_name, edipi FROM users WHERE id = ?').get(targetId) as { id: string; username: string; first_name: string; last_name: string; edipi: string | null } | undefined;
  if (!target) throw notFound('No such account.');
  if (input.action === 'temporary_password' && target.id === actor.id) throw badRequest('Use Change password for your own account.');
  const reason = input.reason.trim();
  if (reason.length < 10) throw badRequest('Say why, naming the ticket: the staff member who approves reads it.', { fieldErrors: { reason: 'At least 10 characters.' } });
  let edipi: string | null = null;
  if (input.action === 'edipi') {
    if (input.edipi === undefined) throw badRequest('Name the EDIPI the card should sign in with, or none to remove it.', { fieldErrors: { edipi: 'Required.' } });
    edipi = input.edipi?.trim() || null;
    if (edipi !== null && !isEdipi(edipi)) throw badRequest('An EDIPI is exactly ten digits.', { fieldErrors: { edipi: 'Ten digits.' } });
    if (edipi === target.edipi) throw badRequest('That is the card the account already signs in with.', { fieldErrors: { edipi: 'No change.' } });
    if (edipi && ctx.db.prepare('SELECT 1 FROM users WHERE edipi = ? AND id <> ?').get(edipi, target.id)) throw badRequest('Another account already carries that EDIPI.', { fieldErrors: { edipi: 'Already linked to another account.' } });
  }
  if (!holdsAuthority(ctx, target.id)) throw new HttpError(400, 'This account holds no authority, so support makes this change without a second person.', 'no_authority');
  expireApprovals(ctx);
  const open = ctx.db.prepare("SELECT id FROM credential_approvals WHERE target_user_id = ? AND requested_by = ? AND action = ? AND status IN ('pending', 'approved')").get(target.id, actor.id, input.action) as { id: string } | undefined;
  if (open) throw conflict('You already have an open request for this change to this account. Cancel it to ask again.', 'approval_open', { id: open.id });

  const id = newId();
  const at = new Date();
  ctx.db.prepare(`INSERT INTO credential_approvals (id, target_user_id, action, edipi, reason, requested_by, requested_at, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, target.id, input.action, edipi, reason.slice(0, 300), actor.id, at.toISOString(), new Date(at.getTime() + APPROVAL_HOURS * 3_600_000).toISOString());
  const row = load(ctx, id);
  const what = describeChange(row.action, row.edipi);
  audit(ctx, { actor_id: actor.id, action: 'credential_change_requested', category: 'enterprise', entity: 'credential_approval', entity_id: id, subject_id: target.id, detail: `${what} for ${target.username}: ${row.reason}`.slice(0, 900), ip });
  for (const staff of approversFor(ctx, actor.id, target.id)) {
    notify(ctx, staff, {
      kind: 'security',
      title: `${actor.first_name} ${actor.last_name} asks to ${what} for ${target.first_name} ${target.last_name}`,
      message: `“${row.reason.slice(0, 200)}” They hold authority, so a second member of Vantage staff approves first. Answer it under Accounts.`,
      actionUrl: '/admin/accounts',
      dedupeKey: `credential_approval:${id}:${staff}`,
    });
  }
  return row;
}

/** A second staff member's answer: approved, or denied with a note. */
export function decideApproval(ctx: AppContext, actor: SessionUser, id: string, approve: boolean, note: string | null, ip?: string | null): CredentialApproval {
  const row = load(ctx, id);
  if (row.status !== 'pending') throw conflict(row.status === 'expired' ? 'That request lapsed before anyone answered it.' : 'That request has already been answered.', 'not_pending');
  if (row.requested_by === actor.id) throw forbidden('A second member of Vantage staff answers this. You cannot approve your own request.', 'self_approval');
  if (row.target_user_id === actor.id) throw forbidden('Nobody answers a request to change their own sign-in.', 'self_approval');
  if (platformRolesOf(ctx, row.target_user_id).length && !actor.platformPermissions.includes('platform.staff')) {
    throw forbidden('Only a Lead Vantage Administrator approves a change to a staff member’s sign-in.', 'staff_account');
  }
  const text = note?.trim() || null;
  if (!approve && !text) throw badRequest('Say why it is denied: the staff member who asked reads it.', { fieldErrors: { note: 'Required.' } });
  const changed = ctx.db.prepare("UPDATE credential_approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending'")
    .run(approve ? 'approved' : 'denied', actor.id, now(), text?.slice(0, 300) ?? null, id).changes;
  if (!changed) throw conflict('That request has already been answered.', 'not_pending');
  const after = load(ctx, id);
  const what = describeChange(after.action, after.edipi);
  audit(ctx, {
    actor_id: actor.id, action: approve ? 'credential_change_approved' : 'credential_change_denied', category: 'enterprise', entity: 'credential_approval', entity_id: id,
    subject_id: after.target_user_id, detail: `${what} for ${after.target_username}, asked by ${after.requested_by_name}${text ? `: ${text}` : ''}`.slice(0, 900), ip,
  });
  notify(ctx, after.requested_by, {
    kind: 'security',
    title: approve ? `${actor.first_name} ${actor.last_name} approved your request to ${what} for ${after.target_name}` : `${actor.first_name} ${actor.last_name} denied your request to ${what} for ${after.target_name}`,
    message: approve ? `Make the change from Accounts before ${new Date(after.expires_at).toUTCString()}.${text ? ` “${text.slice(0, 200)}”` : ''}` : `“${(text ?? '').slice(0, 200)}”`,
    actionUrl: '/admin/accounts',
    dedupeKey: `credential_approval:${id}:decided`,
  });
  return after;
}

/** The staff member who asked withdraws the request, answered or not, while it is unused. */
export function cancelApproval(ctx: AppContext, actor: SessionUser, id: string, ip?: string | null): CredentialApproval {
  const row = load(ctx, id);
  if (row.requested_by !== actor.id) throw forbidden('Only the staff member who asked can cancel a request.', 'not_requester');
  if (row.status !== 'pending' && row.status !== 'approved') throw conflict('That request is already closed.', 'not_open');
  ctx.db.prepare("UPDATE credential_approvals SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'approved')").run(id);
  const after = load(ctx, id);
  const what = describeChange(after.action, after.edipi);
  audit(ctx, { actor_id: actor.id, action: 'credential_change_cancelled', category: 'enterprise', entity: 'credential_approval', entity_id: id, subject_id: after.target_user_id, detail: `${what} for ${after.target_username}, ${row.status === 'approved' ? `approved by ${row.decided_by_name}` : 'not yet answered'}`, ip });
  // Whoever answered it, or would have, is told it no longer needs them.
  const told = row.decided_by ? [row.decided_by] : approversFor(ctx, actor.id, row.target_user_id);
  for (const staff of told) {
    notify(ctx, staff, { kind: 'security', title: `${actor.first_name} ${actor.last_name} cancelled the request to ${what} for ${after.target_name}`, message: null, actionUrl: '/admin/accounts' });
  }
  return after;
}

export interface UsedApproval { id: string; approverId: string; approverName: string }

/**
 * Called inside the transaction that makes the change. An account with no authority needs nothing. One with authority
 * needs an approved request this staff member made for this account, this change and (for a CAC) this EDIPI, unused and
 * in time; it is used up here, so the change and its approval commit or roll back together.
 */
export function useApproval(ctx: AppContext, actor: SessionUser, targetId: string, action: CredentialAction, approvalId: string | null | undefined, edipi: string | null = null): UsedApproval | null {
  if (!holdsAuthority(ctx, targetId)) return null;
  if (!approvalId) {
    throw new HttpError(403, 'This account holds authority, so a second member of Vantage staff approves this change first. Ask for approval, saying why.', 'approval_required', { action });
  }
  const at = now();
  const row = ctx.db.prepare(`SELECT a.*, d.first_name || ' ' || d.last_name AS decided_by_name FROM credential_approvals a LEFT JOIN users d ON d.id = a.decided_by WHERE a.id = ?`).get(approvalId) as (CredentialApproval & { decided_by_name: string | null }) | undefined;
  const fits = row && row.status === 'approved' && row.expires_at > at && !row.used_at && row.requested_by === actor.id && row.target_user_id === targetId
    && row.action === action && (action !== 'edipi' || (row.edipi ?? null) === (edipi ?? null)) && row.decided_by;
  if (!fits) {
    throw new HttpError(403, 'That approval does not cover this change: it must be approved, unused, in time, and asked by you for this account and this change.', 'approval_required', { action });
  }
  const used = ctx.db.prepare("UPDATE credential_approvals SET status = 'used', used_at = ? WHERE id = ? AND status = 'approved' AND used_at IS NULL AND expires_at > ?").run(at, row.id, at).changes;
  if (!used) throw new HttpError(403, 'That approval has already been used.', 'approval_required', { action });
  return { id: row.id, approverId: row.decided_by!, approverName: row.decided_by_name || 'another staff member' };
}
