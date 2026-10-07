import type { AppContext } from '../context.ts';
import { PERMISSIONS, can, isMember, assertSameInstance, type Scope } from './scope.ts';
import { badRequest, forbidden } from '../lib/errors.ts';

export interface RecordRow { id: string; user_id: string; unit_id: string | null; visibility: string; frozen_at?: string | null; counselor_id?: string | null; assignee_id?: string | null; acknowledged_at?: string | null }

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
  if (row.counselor_id && row.counselor_id !== row.user_id && row.acknowledged_at) return false;
  if (row.counselor_id && row.counselor_id !== row.user_id && row.user_id === userId) return false;
  if (row.user_id === userId) return row.visibility === 'private' || !row.unit_id || isMember(scope, row.unit_id);
  if (row.counselor_id && row.counselor_id === userId) return true;
  if (row.visibility !== 'unit' || !row.unit_id) return false;
  return can(scope, PERMISSIONS.MANAGE_RECORDS, row.unit_id);
}

export const ASSIGNEE_FIELDS: Record<string, readonly string[]> = { tasks: ['status', 'notes'], goals: ['status', 'current_value'] };
export function isAssignee(scope: Scope, userId: string, row: RecordRow): boolean {
  return Boolean(row.assignee_id && row.assignee_id === userId && row.user_id !== userId && row.visibility === 'unit' && row.unit_id && isMember(scope, row.unit_id) && !row.frozen_at);
}

/** May the caller place a record with this visibility inside this unit? */
export function canPlace(scope: Scope, visibility: string, unitId: string | null, shareFlag: number, personal = false): boolean {
  if (visibility === 'private') return !unitId || isMember(scope, unitId) || can(scope, shareFlag, unitId);
  if (!unitId) return false;
  return personal ? isMember(scope, unitId) || can(scope, shareFlag, unitId) : can(scope, shareFlag, unitId);
}

/**
 * The project an entry, a task or a piece of work may be filed under: one the caller owns, or a shared one in a unit
 * they belong to or read, and never one in another Unit Instance than the unit the entry sits in (ADR-0008).
 */
export function assertFileableProject(ctx: AppContext, scope: Scope, userId: string, projectId: string, unitId: string | null) {
  const project = ctx.db.prepare('SELECT id, user_id, unit_id, visibility FROM projects WHERE id = ? AND deleted_at IS NULL')
    .get(projectId) as { id: string; user_id: string; unit_id: string | null; visibility: string } | undefined;
  if (!project) throw badRequest('No such project.', { fieldErrors: { project_id: 'No such project.' } });
  const reachable = project.user_id === userId
    || (project.visibility === 'unit' && project.unit_id && (isMember(scope, project.unit_id) || can(scope, PERMISSIONS.VIEW_RECORDS, project.unit_id)));
  if (!reachable) throw forbidden('That is not a project you can file work under.');
  assertSameInstance(ctx, project.unit_id, unitId, 'That project belongs to another Unit Instance.');
  return project;
}
