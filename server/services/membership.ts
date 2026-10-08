import type { AppContext } from '../context.ts';
import type { MembershipPeriod } from '../../shared/types.ts';

/**
 * Unit membership over time (ADR-0009). The account is the person and stays one account for a whole career; what changes
 * is which units it belongs to. unit_members holds the memberships held now. unit_membership_periods holds every stretch
 * of them, written by the database's triggers (migration 018), so the history is complete whichever path changed it.
 * This module names why a period began or ended and who did it, and reads the history back.
 */

/** Why a period began. The triggers write billet_changed, primary_changed and recorded themselves. */
export type StartReason =
  | 'enrolled' | 'invitation' | 'join_code' | 'roster' | 'roster_restored' | 'transfer' | 'account_import' | 'unit_created'
  | 'leader_assigned' | 'demo' | 'billet_changed' | 'primary_changed' | 'recorded';

/** Why a period ended. superseded is the triggers' own: an open period found under a membership that was just opened. */
export type EndReason =
  | 'removed' | 'removed_from_instance' | 'roster_separation' | 'transfer' | 'left' | 'billet_changed' | 'primary_changed'
  | 'superseded';

/** Names the reason and the person on the period a membership just opened, unless something already named them. */
export function noteMembershipStart(ctx: AppContext, userId: string, unitId: string, reason: StartReason, by: string | null) {
  ctx.db.prepare(`UPDATE unit_membership_periods SET start_reason = COALESCE(start_reason, ?), started_by = COALESCE(?, started_by)
                   WHERE user_id = ? AND unit_id = ? AND ended_at IS NULL`).run(reason, by, userId, unitId);
}

/** Names the reason and the person on the period a membership just closed: the newest closed period of that membership. */
export function noteMembershipEnd(ctx: AppContext, userId: string, unitId: string, reason: EndReason, by: string | null) {
  ctx.db.prepare(`UPDATE unit_membership_periods SET end_reason = COALESCE(end_reason, ?), ended_by = COALESCE(?, ended_by)
                   WHERE id = (SELECT id FROM unit_membership_periods WHERE user_id = ? AND unit_id = ? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1)`)
    .run(reason, by, userId, unitId);
}

/** Names who changed a person's billet or primary unit on the periods the triggers split for it since `since`. */
export function noteMembershipChangesBy(ctx: AppContext, userId: string, by: string, since: string) {
  ctx.db.prepare(`UPDATE unit_membership_periods SET started_by = ? WHERE user_id = ? AND started_by IS NULL AND start_reason IN ('billet_changed', 'primary_changed') AND started_at >= ?`).run(by, userId, since);
  ctx.db.prepare(`UPDATE unit_membership_periods SET ended_by = ? WHERE user_id = ? AND ended_by IS NULL AND end_reason IN ('billet_changed', 'primary_changed') AND ended_at >= ?`).run(by, userId, since);
}


/**
 * A person's membership history, newest first. orgIds limits it to units of those Unit Instances: a leader reads the
 * history inside their own instance, never which other commands the person served in (ADR-0008). null is the whole
 * history, for the person themselves.
 */
export function membershipHistory(ctx: AppContext, userId: string, orgIds: string[] | null, limit = 200): MembershipPeriod[] {
  if (orgIds && !orgIds.length) return [];
  return ctx.db.prepare(`SELECT p.id, p.unit_id, u.name AS unit_name, u.short_name AS unit_short, p.billet, p.is_primary, p.started_at, p.ended_at, p.start_reason, p.end_reason
      FROM unit_membership_periods p JOIN units u ON u.id = p.unit_id
     WHERE p.user_id = ? ${orgIds ? 'AND u.org_id IN (SELECT value FROM json_each(?))' : ''}
     ORDER BY p.started_at DESC, p.id DESC LIMIT ?`)
    .all(...[userId, ...(orgIds ? [JSON.stringify(orgIds)] : []), limit]) as MembershipPeriod[];
}
