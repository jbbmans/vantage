import type { AppContext } from '../context.ts';
import { newId, now } from '../lib/ids.ts';

export interface HoldState { instance: boolean; types: Set<string>; users: Set<string> }

/**
 * The holds that bind a disposition. For one organization: its own holds and the platform's. With none named (the
 * service's own sweeps), every open hold, whichever organization placed it. A hold on a person always counts.
 */
export function holdState(ctx: AppContext, orgId?: string): HoldState {
  const state: HoldState = { instance: false, types: new Set(), users: new Set() };
  const rows = ctx.db.prepare('SELECT scope, subject_id, record_type, org_id FROM legal_holds WHERE released_at IS NULL').all() as Array<{ scope: string; subject_id: string | null; record_type: string | null; org_id: string | null }>;
  for (const hold of rows) {
    const binds = orgId === undefined || hold.org_id === null || hold.org_id === orgId;
    if (hold.scope === 'instance') { if (binds) state.instance = true; }
    else if (hold.scope === 'record_type' && hold.record_type) { if (binds) state.types.add(hold.record_type); }
    else if (hold.scope === 'user' && hold.subject_id) state.users.add(hold.subject_id);
  }
  return state;
}

export function heldUsersClause(holds: HoldState, column = 'user_id'): { sql: string; params: string[]; onlySql: string } {
  const users = [...holds.users];
  if (!users.length) return { sql: '', params: [], onlySql: ' AND 0' };
  const list = users.map(() => '?').join(',');
  return { sql: ` AND (${column} IS NULL OR ${column} NOT IN (${list}))`, params: users, onlySql: ` AND ${column} IN (${list})` };
}

export function recordDispositionRun(ctx: AppContext, run: { actorId: string | null; recordType: string; disposition: string; eligible: number; acted: number; held: number; detail: string; dryRun?: boolean }) {
  ctx.db.prepare(
    `INSERT INTO disposition_runs (id, actor_id, dry_run, record_type, disposition, eligible, acted, held, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(newId(), run.actorId, run.dryRun ? 1 : 0, run.recordType, run.disposition, run.eligible, run.acted, run.held, run.detail.slice(0, 500), now());
}
