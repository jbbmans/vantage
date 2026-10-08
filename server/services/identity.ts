import type { AppContext } from '../context.ts';
import { now } from '../lib/ids.ts';
import { audit } from './audit.ts';

/**
 * One person, one account (ADR-0009). The account is the identity: its id, its sign-in methods, its EDIPI and its
 * profile. Unit Instances it serves in hold memberships to it, never copies of it. So what changes the identity itself
 * is governed once, here: which Unit Instance may act on a shared account, and when an EDIPI is proven.
 */

/** The Unit Instances, other than this one, holding a unit the person belongs to. */
export function otherInstancesOf(ctx: AppContext, userId: string, orgId: string): string[] {
  return (ctx.db.prepare(`SELECT DISTINCT u.org_id FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id = ? AND u.org_id IS NOT NULL AND u.org_id <> ?`)
    .all(userId, orgId) as Array<{ org_id: string }>).map((r) => r.org_id);
}

/**
 * Whether an account carries authority beyond this Unit Instance: it serves in another one too, or it runs the service.
 * Weakening such an account's protection (its sign-in key, its lock) is not one organization's to do (ADR-0008).
 */
export function authorityBeyond(ctx: AppContext, userId: string, orgId: string): boolean {
  return Boolean(ctx.db.prepare(`SELECT 1 FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id = ? AND u.org_id IS NOT ?
    UNION ALL SELECT 1 FROM platform_roles WHERE user_id = ? LIMIT 1`).get(userId, orgId, userId));
}

/**
 * Tells every other Unit Instance the person serves in that this one acted on the shared account: an entry in each
 * one's own audit log. It says what was done, not which instance did it or who; that stays in the acting instance's
 * log and in the service-wide log Vantage support reads.
 */
export function tellOtherInstances(ctx: AppContext, userId: string, orgId: string, what: string, ip?: string | null) {
  for (const other of otherInstancesOf(ctx, userId, orgId)) {
    audit(ctx, { actor_id: null, action: 'shared_account_notice', entity: 'user', entity_id: userId, subject_id: userId, org_id: other, detail: `Another Unit Instance this person serves in ${what}.`, ip });
  }
}

/**
 * The account's EDIPI was just proven: its card signed in or stepped up, or the organization's identity provider asserted
 * it. A proven EDIPI is the person's sign-in key, and only Vantage support changes it from then on.
 */
export function markEdipiVerified(ctx: AppContext, userId: string, edipi: string) {
  ctx.db.prepare('UPDATE users SET edipi_verified_at = ? WHERE id = ? AND edipi = ?').run(now(), userId, edipi);
}
