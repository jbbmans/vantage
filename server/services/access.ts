import type { AppContext, SessionUser } from '../context.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { notify, notifyOrg } from './notifications.ts';
import { getOrg, orgSettings } from './organizations.ts';

/**
 * Vantage access (ADR-0006): the only way Vantage staff see inside an organization. A staff member asks, with a reason
 * and a length of time; the organization's owners approve (or, if the organization chose to be told rather than asked,
 * it begins at once). It is read-only, it ends on its own, and an owner can end it sooner. Every step is in both the
 * organization's audit trail and the platform's.
 */

export const ACCESS_DEFAULT_MINUTES = 240;
export const ACCESS_MAX_MINUTES = 1440;
/** A request no owner answers lapses after a day, so an old ask cannot be approved into a surprise. */
const PENDING_TTL_MS = 24 * 3600_000;

export interface AccessGrant {
  id: string; org_id: string; org_name: string; staff_user_id: string; staff_name: string; reason: string; minutes: number;
  status: 'pending' | 'active' | 'denied' | 'revoked' | 'expired' | 'ended' | 'withdrawn';
  requested_at: string; decided_by: string | null; decided_by_name: string | null; decided_at: string | null; decision_note: string | null;
  starts_at: string | null; expires_at: string | null; ended_at: string | null; ended_by: string | null;
}

const SELECT = `SELECT g.*, o.name AS org_name, s.first_name || ' ' || s.last_name AS staff_name, d.first_name || ' ' || d.last_name AS decided_by_name
  FROM access_grants g JOIN organizations o ON o.id = g.org_id JOIN users s ON s.id = g.staff_user_id LEFT JOIN users d ON d.id = g.decided_by`;

function load(ctx: AppContext, id: string): AccessGrant {
  const g = ctx.db.prepare(`${SELECT} WHERE g.id = ?`).get(id) as AccessGrant | undefined;
  if (!g) throw notFound('No such access request.');
  return g;
}

/** Audit an access event twice: once in the organization's trail, once in the platform's. */
function record(ctx: AppContext, actorId: string | null, g: Pick<AccessGrant, 'id' | 'org_id' | 'staff_user_id'>, action: string, detail: string | null, ip?: string) {
  audit(ctx, { actor_id: actorId, action, entity: 'access_grant', entity_id: g.id, org_id: g.org_id, subject_id: g.staff_user_id, detail, ip });
  audit(ctx, { actor_id: actorId, action, entity: 'access_grant', entity_id: g.id, subject_id: g.staff_user_id, detail: `${g.org_id}${detail ? `: ${detail}` : ''}`, ip });
}

const until = (minutes: number, from = Date.now()) => new Date(from + minutes * 60_000).toISOString();

export function requestAccess(ctx: AppContext, staff: SessionUser, orgId: string, input: { reason: string; minutes?: number | null }, ip?: string): AccessGrant {
  if (!staff.platformPermissions.includes('platform.access')) throw forbidden('Your Vantage role cannot ask for access to a Unit Instance.', 'not_staff');
  const org = getOrg(ctx, orgId);
  if (!org) throw notFound('No such Unit Instance.');
  if (org.status !== 'active') throw badRequest('That Unit Instance is not active.');
  const reason = input.reason.trim();
  if (reason.length < 10) throw badRequest('Say what you need to look at and why: the Unit Instance’s owners read it.', { fieldErrors: { reason: 'At least 10 characters.' } });
  const minutes = Math.round(input.minutes ?? ACCESS_DEFAULT_MINUTES);
  if (minutes < 15 || minutes > ACCESS_MAX_MINUTES) throw badRequest('Access lasts from 15 minutes to 24 hours.', { fieldErrors: { minutes: '15 to 1440.' } });
  const open = ctx.db.prepare("SELECT id FROM access_grants WHERE org_id = ? AND staff_user_id = ? AND status IN ('pending', 'active') AND (expires_at IS NULL OR expires_at > ?)").get(orgId, staff.id, now()) as { id: string } | undefined;
  if (open) throw conflict('You already have an open request or live access there.', 'access_open', { id: open.id });
  const id = newId();
  const at = now();
  const immediate = orgSettings(org).vantageAccess === 'notify';
  ctx.db.prepare(`INSERT INTO access_grants (id, org_id, staff_user_id, reason, minutes, status, requested_at, starts_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, staff.id, reason.slice(0, 1000), minutes, immediate ? 'active' : 'pending', at, immediate ? at : null, immediate ? until(minutes) : null);
  const g = load(ctx, id);
  record(ctx, staff.id, g, immediate ? 'vantage_access_started' : 'vantage_access_requested', `${minutes} min: ${reason.slice(0, 200)}`, ip);
  const hours = minutes >= 60 ? `${Math.round(minutes / 6) / 10} hours` : `${minutes} minutes`;
  notifyOrg(ctx, orgId, 'org.access', {
    kind: 'system',
    title: immediate ? `Vantage support is looking at ${org.name}` : `Vantage support asks to look at ${org.name}`,
    message: `${staff.first_name} ${staff.last_name}, for ${hours}: “${reason.slice(0, 200)}”${immediate ? ' Your Unit Instance is set to be told rather than asked; you can end it now.' : ' Approve or deny it in the owner console.'}`,
    actionUrl: '/console/access',
    dedupeKey: `access:${id}`,
  });
  return g;
}

/** An owner's answer. Access runs for the minutes asked from the moment it is approved. */
export function decideAccess(ctx: AppContext, actor: SessionUser, orgId: string, id: string, approve: boolean, note: string | null, ip?: string): AccessGrant {
  const g = load(ctx, id);
  if (g.org_id !== orgId) throw notFound('No such access request.');
  if (g.status !== 'pending') throw conflict('That request has already been answered.', 'not_pending');
  if (g.staff_user_id === actor.id) throw forbidden('You cannot answer your own request.', 'self_approval');
  if (Date.parse(g.requested_at) + PENDING_TTL_MS < Date.now()) {
    ctx.db.prepare("UPDATE access_grants SET status = 'expired', ended_at = ? WHERE id = ?").run(now(), id);
    throw conflict('That request lapsed unanswered. Vantage support can ask again.', 'lapsed');
  }
  const at = now();
  ctx.db.prepare('UPDATE access_grants SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, starts_at = ?, expires_at = ? WHERE id = ?')
    .run(approve ? 'active' : 'denied', actor.id, at, note?.trim().slice(0, 500) || null, approve ? at : null, approve ? until(g.minutes) : null, id);
  record(ctx, actor.id, g, approve ? 'vantage_access_approved' : 'vantage_access_denied', note?.trim().slice(0, 200) || null, ip);
  notify(ctx, g.staff_user_id, {
    kind: 'system',
    title: approve ? `Access to ${g.org_name} approved` : `Access to ${g.org_name} denied`,
    message: approve ? `Read-only, until ${new Date(Date.now() + g.minutes * 60_000).toISOString().slice(11, 16)}Z.${note ? ` “${note.trim().slice(0, 200)}”` : ''}` : note?.trim().slice(0, 200) || undefined,
    actionUrl: '/admin/access',
  });
  return load(ctx, id);
}

/** End access early: an owner revoking it, or the staff member finishing (or withdrawing the request). */
export function endAccess(ctx: AppContext, actor: SessionUser, id: string, by: 'org' | 'staff', orgId?: string, ip?: string): AccessGrant {
  const g = load(ctx, id);
  if (by === 'org' && g.org_id !== orgId) throw notFound('No such access request.');
  if (by === 'staff' && g.staff_user_id !== actor.id && !actor.platformPermissions.includes('platform.staff')) throw forbidden('That is another staff member’s access.');
  if (g.status !== 'pending' && g.status !== 'active') throw conflict('That access has already ended.', 'not_open');
  const status = by === 'org' ? 'revoked' : g.status === 'pending' ? 'withdrawn' : 'ended';
  ctx.db.prepare('UPDATE access_grants SET status = ?, ended_at = ?, ended_by = ? WHERE id = ?').run(status, now(), actor.id, id);
  record(ctx, actor.id, g, `vantage_access_${status}`, null, ip);
  if (by === 'org') notify(ctx, g.staff_user_id, { kind: 'system', title: `Access to ${g.org_name} was ended by its owners`, actionUrl: '/admin/access' });
  else notifyOrg(ctx, g.org_id, 'org.access', { kind: 'system', title: `Vantage support ${status === 'withdrawn' ? 'withdrew its request' : 'finished looking'}`, message: `${g.staff_name}.`, actionUrl: '/console/access' });
  return load(ctx, id);
}

export function accessForOrg(ctx: AppContext, orgId: string, limit = 100): AccessGrant[] {
  return ctx.db.prepare(`${SELECT} WHERE g.org_id = ? ORDER BY CASE g.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, g.requested_at DESC LIMIT ?`).all(orgId, limit) as AccessGrant[];
}

export function accessForPlatform(ctx: AppContext, opts: { staffId?: string; status?: string } = {}, limit = 200): AccessGrant[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.staffId) { where.push('g.staff_user_id = ?'); params.push(opts.staffId); }
  if (opts.status) { where.push('g.status = ?'); params.push(opts.status); }
  return ctx.db.prepare(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE g.status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, g.requested_at DESC LIMIT ?`).all(...params, limit) as AccessGrant[];
}

/**
 * Time-bound authority ends on its own: an expired grant already confers nothing (scope reads expiry), and this sweep
 * removes it and writes the end into the audit trail, so the trail says when access stopped, not only when it began.
 */
export function sweepExpiries(ctx: AppContext, at = now()) {
  const result = { accessExpired: 0, accessLapsed: 0, unitRoles: 0, orgRoles: 0 };
  const grants = ctx.db.prepare("SELECT id, org_id, staff_user_id FROM access_grants WHERE status = 'active' AND expires_at <= ?").all(at) as Array<Pick<AccessGrant, 'id' | 'org_id' | 'staff_user_id'>>;
  for (const g of grants) {
    ctx.db.prepare("UPDATE access_grants SET status = 'expired', ended_at = ? WHERE id = ? AND status = 'active'").run(at, g.id);
    record(ctx, null, g, 'vantage_access_expired', null);
    result.accessExpired++;
  }
  const lapsed = ctx.db.prepare("SELECT id, org_id, staff_user_id FROM access_grants WHERE status = 'pending' AND requested_at <= ?").all(new Date(Date.parse(at) - PENDING_TTL_MS).toISOString()) as Array<Pick<AccessGrant, 'id' | 'org_id' | 'staff_user_id'>>;
  for (const g of lapsed) {
    ctx.db.prepare("UPDATE access_grants SET status = 'expired', ended_at = ? WHERE id = ? AND status = 'pending'").run(at, g.id);
    record(ctx, null, g, 'vantage_access_lapsed', 'unanswered for a day');
    result.accessLapsed++;
  }
  const unitRoles = ctx.db.prepare('SELECT mr.user_id, mr.role_id, mr.unit_id, r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.expires_at IS NOT NULL AND mr.expires_at <= ?').all(at) as Array<{ user_id: string; role_id: string; unit_id: string; name: string }>;
  for (const r of unitRoles) {
    ctx.db.prepare('DELETE FROM member_roles WHERE user_id = ? AND role_id = ? AND unit_id = ?').run(r.user_id, r.role_id, r.unit_id);
    audit(ctx, { actor_id: null, action: 'role_expired', entity: 'role', entity_id: r.role_id, unit_id: r.unit_id, subject_id: r.user_id, detail: r.name });
    notify(ctx, r.user_id, { kind: 'unit', title: `Your ${r.name} role ended`, message: 'It was granted until today.', actionUrl: '/team', dedupeKey: `role-expired:${r.role_id}:${r.user_id}:${at.slice(0, 10)}` });
    result.unitRoles++;
  }
  const orgRoles = ctx.db.prepare('SELECT org_id, user_id, role FROM org_roles WHERE expires_at IS NOT NULL AND expires_at <= ?').all(at) as Array<{ org_id: string; user_id: string; role: string }>;
  for (const r of orgRoles) {
    ctx.db.prepare('DELETE FROM org_roles WHERE org_id = ? AND user_id = ? AND role = ?').run(r.org_id, r.user_id, r.role);
    audit(ctx, { actor_id: null, action: 'org_role_expired', entity: 'organization', entity_id: r.org_id, org_id: r.org_id, subject_id: r.user_id, detail: r.role });
    result.orgRoles++;
  }
  return result;
}

/** Tell staff whose access ends soon, once, so they are not cut off mid-task without warning. */
export function warnEndingAccess(ctx: AppContext, withinMinutes = 15) {
  const soon = ctx.db.prepare(`${SELECT} WHERE g.status = 'active' AND g.expires_at > ? AND g.expires_at <= ?`).all(now(), until(withinMinutes)) as AccessGrant[];
  for (const g of soon) notify(ctx, g.staff_user_id, { kind: 'system', title: `Access to ${g.org_name} ends soon`, message: `At ${g.expires_at!.slice(11, 16)}Z.`, actionUrl: '/admin/access', dedupeKey: `access-ending:${g.id}` });
  return soon.length;
}
