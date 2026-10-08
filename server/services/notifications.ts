import type { AppContext } from '../context.ts';
import { newId, now } from '../lib/ids.ts';
import { staffWith } from '../authz/platform.ts';
import { seatedOrgRole } from '../authz/scope.ts';
import { orgPermissionsOf, type OrgPermission, type PlatformPermission } from '../../shared/permissions.ts';

export function notify(ctx: AppContext, userId: string, { kind, title, message = null, actionUrl = null, dedupeKey = null }: { kind: string; title: string; message?: string | null; actionUrl?: string | null; dedupeKey?: string | null }) {
  const result = ctx.db.prepare(
    `INSERT INTO notifications (id, user_id, kind, title, message, action_url, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
  ).run(newId(), userId, kind, title, message, actionUrl, dedupeKey, now());
  return result.changes > 0;
}

/** Vantage staff who hold a platform permission: the platform's own notices, never an organization's. */
export function notifyStaff(ctx: AppContext, permission: PlatformPermission, payload: Parameters<typeof notify>[2], exceptId?: string) {
  for (const id of staffWith(ctx, permission)) if (id !== exceptId) notify(ctx, id, payload);
}

/** A Unit Instance's people who hold a Unit Instance permission there, counting only those still members of it (ADR-0010). */
export function notifyOrg(ctx: AppContext, orgId: string, permission: OrgPermission, payload: Parameters<typeof notify>[2], exceptId?: string) {
  const rows = ctx.db.prepare(`SELECT DISTINCT r.user_id, r.role FROM org_roles r JOIN users u ON u.id = r.user_id
                               WHERE r.org_id = ? AND u.active = 1 AND (r.expires_at IS NULL OR r.expires_at > ?) AND ${seatedOrgRole('r')}`).all(orgId, now()) as Array<{ user_id: string; role: string }>;
  const ids = new Set(rows.filter((r) => orgPermissionsOf([r.role]).includes(permission)).map((r) => r.user_id));
  for (const id of ids) if (id !== exceptId) notify(ctx, id, payload);
}
