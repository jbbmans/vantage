/**
 * Which records a legal hold covers, for every path that removes data for good.
 *
 * Retention disposition and the recycle-bin purge both erase records, and a hold has to stop both:
 * a hold that only the owner console honours would still lose the held records to the scheduled
 * purge thirty days after somebody deleted them. It lives on its own so both can import it.
 */
import type { AppContext } from '../context.ts';

export interface HoldState { instance: boolean; types: Set<string>; users: Set<string> }

export function holdState(ctx: AppContext): HoldState {
  const state: HoldState = { instance: false, types: new Set(), users: new Set() };
  const holds = ctx.db.prepare('SELECT scope, subject_id, record_type FROM legal_holds WHERE released_at IS NULL').all() as Array<{ scope: string; subject_id: string | null; record_type: string | null }>;
  for (const hold of holds) {
    if (hold.scope === 'instance') state.instance = true;
    else if (hold.scope === 'record_type' && hold.record_type) state.types.add(hold.record_type);
    else if (hold.scope === 'user' && hold.subject_id) state.users.add(hold.subject_id);
  }
  return state;
}

/** Whether an open hold covers a record of `table` belonging to `userId`. */
export function isHeld(state: HoldState, table: string, userId: string | null | undefined): boolean {
  return state.instance || state.types.has(table) || (!!userId && state.users.has(userId));
}
