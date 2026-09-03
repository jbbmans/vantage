import type { AppContext } from '../context.ts';
import { PERMISSIONS, can, isMember, type Scope } from './scope.ts';

export interface RecordRow { id: string; user_id: string; unit_id: string | null; visibility: string; frozen_at?: string | null; counselor_id?: string | null; assignee_id?: string | null }

/** SQL fragment restricting a record table to rows the caller may read. */
export function readableClause(ctx: AppContext, scope: Scope, userId: string, alias = 't', opts: { memberReadable?: boolean; counselor?: boolean; assignee?: boolean } = {}) {
  const parts: string[] = [`${alias}.user_id = ?`];
  const params: unknown[] = [userId];
  const readable = opts.memberReadable ? [...new Set([...scope.readableUnitIds, ...scope.unitIds])] : scope.readableUnitIds;
  if (readable.length) {
    parts.push(`(${alias}.visibility = 'unit' AND ${alias}.unit_id IN (${readable.map(() => '?').join(',')}))`);
    params.push(...readable);
  }
  if (opts.counselor) { parts.push(`${alias}.counselor_id = ?`); params.push(userId); }
  if (opts.assignee) { parts.push(`(${alias}.assignee_id = ? AND ${alias}.visibility = 'unit')`); params.push(userId); }
  return { clause: `(${parts.join(' OR ')})`, params };
}

export function canRead(scope: Scope, userId: string, row: RecordRow): boolean {
  if (row.user_id === userId) return true;
  if (row.counselor_id && row.counselor_id === userId) return true;
  if (row.assignee_id && row.assignee_id === userId && row.visibility === 'unit') return true;
  if (row.visibility !== 'unit' || !row.unit_id) return false;
  return can(scope, PERMISSIONS.VIEW_RECORDS, row.unit_id) || (isMember(scope, row.unit_id) && Boolean(row.assignee_id));
}

export function canEdit(scope: Scope, userId: string, row: RecordRow): boolean {
  if (row.frozen_at) return false;
  // A counseling recorded by a leader belongs to its author; the counseled Marine acknowledges it and nothing more.
  if (row.counselor_id && row.counselor_id !== row.user_id && row.user_id === userId) return false;
  if (row.user_id === userId) return row.visibility === 'private' || !row.unit_id || isMember(scope, row.unit_id);
  if (row.counselor_id && row.counselor_id === userId) return true;
  if (row.visibility !== 'unit' || !row.unit_id) return false;
  return can(scope, PERMISSIONS.MANAGE_RECORDS, row.unit_id);
}

/** May the caller place a record with this visibility inside this unit? */
export function canPlace(scope: Scope, visibility: string, unitId: string | null, shareFlag: number, personal = false): boolean {
  if (visibility === 'private') return !unitId || isMember(scope, unitId) || can(scope, shareFlag, unitId);
  if (!unitId) return false;
  // Personal career records (activities, training, awards, counseling) may be shared by any member.
  // Governed work (tasks, projects, goals) needs the unit's share permission.
  return personal ? isMember(scope, unitId) || can(scope, shareFlag, unitId) : can(scope, shareFlag, unitId);
}
