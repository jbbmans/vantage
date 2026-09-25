import type { AppContext } from '../context.ts';
import { newId, now } from '../lib/ids.ts';

export interface HoldState { instance: boolean; types: Set<string>; users: Set<string> }

export function holdState(ctx: AppContext): HoldState {
  const state: HoldState = { instance: false, types: new Set(), users: new Set() };
  const rows = ctx.db.prepare('SELECT scope, subject_id, record_type FROM legal_holds WHERE released_at IS NULL').all() as Array<{ scope: string; subject_id: string | null; record_type: string | null }>;
  for (const hold of rows) {
    if (hold.scope === 'instance') state.instance = true;
    else if (hold.scope === 'record_type' && hold.record_type) state.types.add(hold.record_type);
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
