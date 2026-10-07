import { createHash } from 'node:crypto';
import type { AppContext, SessionUser } from '../context.ts';
import { RECORD_SCHEMAS, type RecordTable } from '../../shared/schemas.ts';
import { withTypedProgress, validateTypedGoal } from './goals.ts';
import { PERMISSIONS, can, scopeFor, type Scope, isMember, detailUnitsFor, assertSameInstance, sameInstance, orgOfUnit } from '../authz/scope.ts';
import { readableClause, canEdit, canPlace, canRead, type RecordRow, isAssignee, ASSIGNEE_FIELDS, assertFileableProject } from '../authz/records.ts';
import { HttpError, badRequest, forbidden, notFound, conflict } from '../lib/errors.ts';
import { valueType } from '../../shared/constants.ts';

/** A goal that measures a whole unit reads its members' shared entries, so setting one takes the right to view them. */
function unitMeasureAllowed(scope: Scope, unitId: string | null | undefined) {
  if (!unitId) throw badRequest('Choose the unit this goal measures.', { fieldErrors: { unit_id: 'Required for a unit-wide goal.' } });
  if (!can(scope, PERMISSIONS.VIEW_RECORDS, unitId)) throw forbidden('Only someone who can view this unit’s shared records can set a goal measured across it.', 'unit_measure_forbidden');
}

function checkValueType(ctx: AppContext, table: string, data: Record<string, unknown>) {
  if (table === 'goals') {
    validateTypedGoal(ctx, data as never, data.target_value as number | null | undefined);
    return;
  }
  if (table !== 'activities' || !data.dollar_type) return;
  if (!valueType(String(data.dollar_type), ctx.runtime.metrics)) throw badRequest(`Unknown value type “${String(data.dollar_type)}”. Pick one of: ${ctx.runtime.metrics.value_types.map((t) => t.key).join(', ')}.`, { fieldErrors: { dollar_type: 'Not one of this instance’s value types.' } });
}
import { parse } from '../lib/http.ts';
import { newId, now } from '../lib/ids.ts';
import { record } from './telemetry.ts';
import { audit } from './audit.ts';
import { heldUsersClause, holdState, recordDispositionRun } from './holds.ts';
import { notify } from './notifications.ts';
import { statSync } from 'node:fs';

interface TableSpec { fields: string[]; json: string[]; shareFlag: number; personal?: boolean; memberReadable?: boolean; counselor?: boolean; assignee?: boolean; orderBy: string }

export const TABLES: Record<RecordTable, TableSpec> = {
  activities: {
    fields: ['date', 'title', 'category', 'eval_area', 'quantity', 'unit_label', 'dollar_amount', 'dollar_type', 'result', 'organization', 'system', 'project_id', 'status', 'notes', 'evidence_links'],
    json: ['evidence_links'], shareFlag: PERMISSIONS.CREATE_SHARED_WORK, personal: true, orderBy: 't.date DESC, t.created_at DESC',
  },
  projects: { fields: ['name', 'description', 'status', 'priority', 'progress', 'start_date', 'target_date', 'organization'], json: [], shareFlag: PERMISSIONS.CREATE_SHARED_WORK, memberReadable: true, orderBy: 't.updated_at DESC' },
  tasks: { fields: ['title', 'notes', 'status', 'priority', 'due_date', 'project_id', 'assignee_id'], json: [], shareFlag: PERMISSIONS.CREATE_SHARED_WORK, memberReadable: true, assignee: true, orderBy: 't.due_date IS NULL, t.due_date, t.created_at DESC' },
  goals: {
    fields: ['title', 'description', 'type', 'category', 'metric', 'current_value', 'target_value', 'unit_label', 'status', 'period_start', 'period_end', 'assignee_id',
      'metric_id', 'direction', 'baseline_value', 'aggregation', 'filters', 'measure_scope', 'completed_at'],
    json: ['filters'], shareFlag: PERMISSIONS.CREATE_SHARED_GOALS, memberReadable: true, assignee: true, orderBy: 't.period_end IS NULL, t.period_end, t.created_at DESC',
  },
  trainings: { fields: ['date', 'title', 'type', 'hours', 'provider', 'status', 'notes'], json: [], shareFlag: PERMISSIONS.CREATE_SHARED_WORK, personal: true, orderBy: 't.date DESC, t.created_at DESC' },
  awards: { fields: ['date', 'name', 'type', 'status', 'recommending_official', 'approving_authority', 'citation', 'notes', 'submitted_at', 'approved_at', 'presented_at'], json: [], shareFlag: PERMISSIONS.COUNSEL, personal: true, orderBy: 't.date DESC, t.created_at DESC' },
  counselings: { fields: ['date', 'type', 'counselor_name', 'summary', 'strengths', 'improvements', 'goals_set', 'follow_up_date'], json: [], shareFlag: PERMISSIONS.COUNSEL, personal: true, counselor: true, orderBy: 't.date DESC, t.created_at DESC' },
};

export const RECORD_TABLE_NAMES = Object.keys(TABLES) as RecordTable[];
export const isRecordTable = (name: string): name is RecordTable => Object.prototype.hasOwnProperty.call(TABLES, name);

export function hydrate<T extends Record<string, unknown>>(row: T | undefined, table: RecordTable): T | undefined {
  if (!row) return row;
  for (const key of TABLES[table].json) {
    if (typeof row[key] === 'string') {
      try { (row as Record<string, unknown>)[key] = JSON.parse(row[key] as string); } catch { (row as Record<string, unknown>)[key] = []; }
    }
  }
  return row;
}

export function activityFingerprint(userId: string, row: { date?: string | null; title?: string | null; quantity?: number | null; dollar_amount?: number | null }): string {
  return createHash('sha256').update([userId, row.date || '', String(row.title || '').trim().toLowerCase().replace(/\s+/g, ' '), row.quantity ?? '', row.dollar_amount ?? ''].join('|')).digest('hex');
}

export function listRecords(ctx: AppContext, user: SessionUser, table: RecordTable, scope: Scope, opts: { unitId?: string | null; from?: string | null; to?: string | null; limit?: number; offset?: number; q?: string | null; deleted?: boolean } = {}) {
  const spec = TABLES[table];
  const { clause, params } = readableClause(ctx, scope, user.id, 't', { memberReadable: spec.memberReadable, counselor: spec.counselor, assignee: spec.assignee });
  // The recycle bin is personal: only the owner sees their own deleted rows.
  const where = opts.deleted ? ['t.deleted_at IS NOT NULL', 't.user_id = ?'] : [`t.deleted_at IS NULL`, clause];
  if (opts.deleted) params.splice(0, params.length, user.id);
  if (opts.unitId) { where.push('t.unit_id = ?'); params.push(opts.unitId); }
  const dateCol = table === 'tasks' ? 'due_date' : table === 'goals' ? 'period_end' : 'date';
  if (opts.from) { where.push(`t.${dateCol} >= ?`); params.push(opts.from); }
  if (opts.to) { where.push(`t.${dateCol} <= ?`); params.push(opts.to); }
  const cap = ctx.config.limits.maxRecordsPerUser;
  const limit = Math.min(Math.max(Number(opts.limit) || cap, 1), cap);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const rows = ctx.db.prepare(`SELECT t.* FROM ${table} t WHERE ${where.join(' AND ')} ORDER BY ${spec.orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset) as Array<Record<string, unknown>>;
  const hydrated = rows.map((r) => hydrate(r, table)!);
  if (table === 'counselings') return withSubjectNames(ctx, user.id, hydrated);
  if (table === 'tasks') return withTaskPeople(ctx, user.id, hydrated);
  return table === 'goals' ? withGoalProgress(ctx, hydrated as never) : hydrated;
}

/** A counselor reading a counseling they recorded for someone else sees whom it was for. */
function withSubjectNames(ctx: AppContext, viewerId: string, rows: Array<Record<string, unknown>>) {
  const ids = [...new Set(rows.map((r) => String(r.user_id)).filter((id) => id !== viewerId))];
  if (!ids.length) return rows;
  const names = new Map((ctx.db.prepare(
    `SELECT u.id, u.first_name, u.last_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids) as Array<{ id: string; first_name: string; last_name: string; abbr: string | null }>)
    .map((u) => [u.id, `${u.abbr ? `${u.abbr} ` : ''}${u.last_name}, ${u.first_name}`]));
  return rows.map((r) => (r.user_id !== viewerId && names.has(String(r.user_id)) ? { ...r, subject_name: names.get(String(r.user_id)) } : r));
}

/**
 * Who set a task and who holds it, for someone who can read the task but not the roster (a Marine sees "from SSgt
 * Diaz", not an id). Only the two people on a row the viewer may already read; the viewer's own name is left off.
 */
function withTaskPeople(ctx: AppContext, viewerId: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const ids = [...new Set(rows.flatMap((r) => [r.user_id, r.assignee_id]).filter((id): id is string => typeof id === 'string' && id !== viewerId))];
  if (!ids.length) return rows;
  const names = new Map((ctx.db.prepare(
    `SELECT u.id, u.last_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids) as Array<{ id: string; last_name: string; abbr: string | null }>).map((u) => [u.id, `${u.abbr ? `${u.abbr} ` : ''}${u.last_name}`]));
  return rows.map((r) => ({
    ...r,
    ...(r.user_id !== viewerId && names.has(String(r.user_id)) ? { owner_name: names.get(String(r.user_id)) } : {}),
    ...(r.assignee_id && r.assignee_id !== viewerId && names.has(String(r.assignee_id)) ? { assignee_name: names.get(String(r.assignee_id)) } : {}),
  }));
}

export function withGoalProgress<T extends Record<string, unknown>>(ctx: AppContext, goals: T[]): T[] {
  return withTypedProgress(ctx, goals as never) as unknown as T[];
}

function readBack(ctx: AppContext, table: RecordTable, id: string) {
  const row = getRecord(ctx, table, id)!;
  return table === 'goals' ? withGoalProgress(ctx, [row as never])[0] : row;
}

export function getRecord(ctx: AppContext, table: RecordTable, id: string, { includeDeleted = false } = {}) {
  const row = ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`).get(id) as (RecordRow & Record<string, unknown>) | undefined;
  return hydrate(row, table);
}

function capacityProblem(ctx: AppContext, userId: string, additional = 1): string | null {
  const total = RECORD_TABLE_NAMES.reduce((sum, t) => sum + (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(userId) as { n: number }).n, 0);
  if (total + additional > ctx.config.limits.maxRecordsPerUser) return `This account has reached its ${ctx.config.limits.maxRecordsPerUser.toLocaleString()}-record limit. Contact Vantage support if you need more.`;
  try {
    if (ctx.db.name !== ':memory:' && statSync(ctx.db.name).size >= ctx.config.limits.maxDatabaseBytes) return 'The database has reached its configured safety threshold. New records are paused to preserve recovery headroom.';
  } catch {}
  return null;
}

function assigneeProblem(ctx: AppContext, scope: Scope, userId: string, assigneeId: string | null | undefined, unitId: string | null): string | null {
  if (!assigneeId || assigneeId === userId) return null;
  const target = ctx.db.prepare('SELECT id, active FROM users WHERE id = ?').get(assigneeId) as { id: string; active: number } | undefined;
  if (!target) return 'No such Marine.';
  if (!target.active) return 'That account is deactivated.';
  if (!unitId) return 'Assign a unit before assigning another Marine.';
  const targetScope = scopeFor(ctx, { id: assigneeId });
  if (!isMember(targetScope, unitId)) return 'That Marine is not a member of that unit.';
  if (!can(scope, PERMISSIONS.CREATE_SHARED_WORK, unitId) && !can(scope, PERMISSIONS.CREATE_SHARED_GOALS, unitId)) return 'You cannot assign work in that unit.';
  return null;
}

/**
 * An entry's project link, checked whenever it is set or the entry moves: a new link must be to a project the author
 * can file under, and a kept link must not end up pointing into another Unit Instance (ADR-0008).
 */
function checkProjectLink(ctx: AppContext, scope: Scope, userId: string, table: RecordTable, projectId: string | null, previous: string | null, unitId: string | null, moved: boolean) {
  if (!TABLES[table].fields.includes('project_id') || !projectId) return;
  if (projectId !== previous) { assertFileableProject(ctx, scope, userId, projectId, unitId); return; }
  if (!moved) return;
  const project = ctx.db.prepare('SELECT unit_id FROM projects WHERE id = ?').get(projectId) as { unit_id: string | null } | undefined;
  assertSameInstance(ctx, project?.unit_id, unitId, 'This entry is filed under a project in another Unit Instance. Take it off the project before moving it.');
}

/**
 * Where somebody other than its owner may re-place a record (ADR-0008): inside the Unit Instance it sits in, and never
 * out of every unit, which would be a way across in two steps. One already in no unit goes only where its Marine serves.
 */
function assertReplaceableByOther(ctx: AppContext, row: RecordRow, unitId: string | null) {
  if (!unitId) {
    if (row.unit_id) throw forbidden('Only the Marine this record belongs to can take it out of its unit.', 'scope_owner_only');
    return;
  }
  if (row.unit_id) return assertSameInstance(ctx, row.unit_id, unitId, 'Only the Marine this record belongs to can move it into another Unit Instance.');
  if (!scopeFor(ctx, { id: row.user_id }).unitIds.some((u) => sameInstance(ctx, u, unitId))) throw forbidden('This record can be placed only in a Unit Instance its Marine serves in.', 'cross_instance');
}

/**
 * What a record would carry with it out of its Unit Instance (ADR-0008): other people's comments and attachments, and
 * for a project, the work filed under it. None of that leaves the instance it was written in, even with its owner.
 */
function assertCarriesNothingAcross(ctx: AppContext, table: RecordTable, row: RecordRow, unitId: string) {
  const servesThere = (userId: string) => scopeFor(ctx, { id: userId }).unitIds.some((u) => sameInstance(ctx, u, unitId));
  const comments = ctx.db.prepare('SELECT DISTINCT author_id, unit_id FROM comments WHERE record_table = ? AND record_id = ? AND author_id <> ? AND deleted_at IS NULL')
    .all(table, row.id, row.user_id) as Array<{ author_id: string; unit_id: string | null }>;
  const uploaders = ctx.db.prepare('SELECT DISTINCT uploaded_by FROM attachments WHERE record_table = ? AND record_id = ? AND uploaded_by <> ? AND deleted_at IS NULL')
    .all(table, row.id, row.user_id) as Array<{ uploaded_by: string }>;
  if (comments.some((c) => (c.unit_id ? !sameInstance(ctx, c.unit_id, unitId) : !servesThere(c.author_id))) || uploaders.some((u) => !servesThere(u.uploaded_by))) {
    throw forbidden('Other people commented on this record or attached files to it in another Unit Instance, so it stays there. Start a new entry for what is yours instead.', 'cross_instance');
  }
  if (table !== 'projects') return;
  const org = orgOfUnit(ctx, unitId);
  for (const child of ['activities', 'tasks', 'work_items']) {
    if (ctx.db.prepare(`SELECT 1 FROM ${child} c JOIN units cu ON cu.id = c.unit_id WHERE c.project_id = ? AND cu.org_id IS NOT ? LIMIT 1`).get(row.id, org)) {
      throw forbidden('Work from another Unit Instance is filed under this project, so it cannot move there.', 'cross_instance');
    }
  }
}

export function createRecord(ctx: AppContext, user: SessionUser, table: RecordTable, body: unknown, reqKey: object, ip?: string) {
  const spec = TABLES[table];
  const data = parse(RECORD_SCHEMAS[table] as never, body) as Record<string, unknown>;
  checkValueType(ctx, table, data);
  const capacity = capacityProblem(ctx, user.id);
  if (capacity) throw new HttpError(507, capacity, 'record_quota');
  const scope = scopeFor(ctx, user, reqKey);

  let ownerId = user.id;
  let counselorId: string | null = null;
  let onBehalf = false;
  if ((table === 'counselings' || table === 'awards') && data.user_id && data.user_id !== user.id) {
    const subject = String(data.user_id);
    const units = detailUnitsFor(ctx, scope, subject).filter((u) => can(scope, PERMISSIONS.COUNSEL, u));
    if (!units.length) throw forbidden(table === 'awards' ? 'You cannot recommend an award for that Marine.' : 'You cannot record a counseling for that Marine.');
    ownerId = subject;
    onBehalf = true;
    if (table === 'counselings') counselorId = user.id;
    else data.visibility = 'unit';
    if (!data.unit_id || !units.includes(String(data.unit_id))) data.unit_id = units[0];
  }
  delete data.user_id;

  const visibility = (data.visibility as string) || 'private';
  const unitId = (data.unit_id as string | null | undefined) ?? scope.homeUnitId ?? null;
  if (unitId && !ctx.db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(unitId)) throw badRequest('No such unit.', { fieldErrors: { unit_id: 'No such unit.' } });
  if (visibility === 'unit' && !unitId) throw badRequest('Choose a unit before sharing this record.', { fieldErrors: { unit_id: 'Required to share.' } });
  if (!onBehalf && !canPlace(scope, visibility, unitId, spec.shareFlag, Boolean(spec.personal))) throw forbidden('You cannot place a record in that unit.');
  if (table === 'goals' && data.measure_scope === 'unit') unitMeasureAllowed(scope, unitId);
  if (spec.assignee && visibility !== 'unit' && data.assignee_id && data.assignee_id !== user.id) data.assignee_id = null;
  if (spec.assignee) {
    const problem = assigneeProblem(ctx, scope, user.id, data.assignee_id as string | null, unitId);
    if (problem) throw badRequest(problem, { fieldErrors: { assignee_id: problem } });
  }
  checkProjectLink(ctx, scope, user.id, table, (data.project_id as string | null | undefined) ?? null, null, unitId, false);

  const id = newId();
  const cols = ['id', 'user_id', 'unit_id', 'visibility', 'created_at', 'updated_at'];
  const vals: unknown[] = [id, ownerId, unitId, visibility, now(), now()];
  if (table === 'counselings') { cols.push('counselor_id'); vals.push(counselorId); }
  if (table === 'activities') { cols.push('fingerprint'); vals.push(activityFingerprint(ownerId, data as never)); }
  for (const f of spec.fields) {
    if (data[f] === undefined) continue;
    cols.push(f);
    vals.push(spec.json.includes(f) ? JSON.stringify(data[f] ?? []) : data[f]);
  }
  try {
    ctx.db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  } catch (error) {
    if (table === 'activities' && String((error as Error).message).includes('UNIQUE')) throw conflict('An identical activity already exists for that date.', 'duplicate');
    throw error;
  }
  audit(ctx, { actor_id: user.id, action: 'create', entity: table, entity_id: id, subject_id: ownerId !== user.id ? ownerId : null, unit_id: unitId, ip });
  if (table === 'goals') {
    record(ctx, 'goal.created', {
      typed: Boolean(data.metric_id),
      direction: String(data.direction || 'increase'),
      automatic: Boolean(data.metric_id) && data.metric !== 'manual',
    }, { id: user.id });
  }
  if (table === 'activities') {
    if (data.quantity == null && data.dollar_amount == null) record(ctx, 'quality.record_missing_measure', { missing: 'quantity' }, { id: user.id });
    else if (!data.result) record(ctx, 'quality.record_missing_measure', { missing: 'outcome' }, { id: user.id });
    else if (!data.eval_area) record(ctx, 'quality.record_missing_measure', { missing: 'area' }, { id: user.id });
    else if (data.quantity != null && !data.unit_label) record(ctx, 'quality.record_missing_measure', { missing: 'unit' }, { id: user.id });
  }
  if (table === 'awards' && onBehalf) {
    notify(ctx, ownerId, { kind: 'award', title: 'Award recommendation started', message: `${user.first_name} ${user.last_name} recommended you for ${String(data.name || 'an award')}.`, actionUrl: `/career/awards?open=${id}`, dedupeKey: `award:${id}` });
  }
  if (table === 'counselings' && counselorId) {
    notify(ctx, ownerId, { kind: 'counseling', title: 'New counseling recorded', message: `${user.first_name} ${user.last_name} recorded a ${String(data.type || 'counseling').replace('_', ' ')} counseling.`, actionUrl: `/career/counseling?open=${id}`, dedupeKey: `counseling:${id}` });
  }
  if (spec.assignee && data.assignee_id && data.assignee_id !== user.id) {
    notify(ctx, String(data.assignee_id), { kind: 'assignment', title: table === 'tasks' ? 'Task assigned to you' : 'Goal assigned to you', message: String(data.title || ''), actionUrl: `/records/${table}/${id}`, dedupeKey: `${table}:${id}:assigned` });
  }
  return readBack(ctx, table, id);
}

export function updateRecord(ctx: AppContext, user: SessionUser, table: RecordTable, id: string, body: unknown, reqKey: object, ip?: string) {
  const spec = TABLES[table];
  const row = getRecord(ctx, table, id);
  if (!row) throw notFound('No such record.');
  const scope = scopeFor(ctx, user, reqKey);
  const assigneeOnly = !canEdit(scope, user.id, row) && isAssignee(scope, user.id, row);
  if (!canEdit(scope, user.id, row) && !assigneeOnly) throw forbidden(row.frozen_at ? 'That record is frozen because the author left the unit.' : 'That record is not yours to edit.');
  const data = parse((RECORD_SCHEMAS[table] as unknown as { partial: () => never }).partial() as never, body) as Record<string, unknown>;
  if (assigneeOnly) {
    const allowed = new Set([...(ASSIGNEE_FIELDS[table] || []), 'version']);
    const blocked = Object.keys(data).filter((k) => data[k] !== undefined && !allowed.has(k));
    if (blocked.length) throw forbidden(`As the assignee you may update ${(ASSIGNEE_FIELDS[table] || []).join(' and ')}, not ${blocked.join(', ')}.`, 'assignee_fields_only');
  }
  checkValueType(ctx, table, data);

  const finalVisibility = (data.visibility as string | undefined) ?? row.visibility;
  const finalUnit = data.unit_id === undefined ? row.unit_id : ((data.unit_id as string | null) || null);
  const scopeChanged = finalUnit !== row.unit_id || finalVisibility !== row.visibility;
  if (scopeChanged && row.user_id !== user.id && row.counselor_id !== user.id) throw forbidden('A record manager may correct content but may not change another Marine’s disclosure scope.', 'scope_owner_only');
  // A counselor may re-place what they wrote, inside the Unit Instance it was written in. Only its owner takes it across.
  if (scopeChanged && row.user_id !== user.id) assertReplaceableByOther(ctx, row, finalUnit);
  const leavesInstance = Boolean(finalUnit) && finalUnit !== row.unit_id && (!row.unit_id || !sameInstance(ctx, row.unit_id, finalUnit));
  if (leavesInstance) assertCarriesNothingAcross(ctx, table, row, finalUnit!);
  if (finalVisibility === 'unit' && !finalUnit) throw badRequest('Choose a unit before sharing this record.', { fieldErrors: { unit_id: 'Required to share.' } });
  if (finalUnit && finalUnit !== row.unit_id && !ctx.db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(finalUnit)) throw badRequest('No such unit.');
  if (scopeChanged && !canPlace(scope, finalVisibility, finalUnit, spec.shareFlag, Boolean(spec.personal))) throw forbidden('You cannot place a record in that unit.');
  if (table === 'goals' && (data.measure_scope ?? row.measure_scope) === 'unit' && ['measure_scope', 'unit_id', 'filters', 'metric_id'].some((k) => data[k] !== undefined)) unitMeasureAllowed(scope, finalUnit);
  if (spec.assignee && finalVisibility !== 'unit') { const who = (data.assignee_id as string | null | undefined) ?? (row.assignee_id as string | null); if (who && who !== user.id) data.assignee_id = null; }
  if (spec.assignee && (data.assignee_id !== undefined || scopeChanged)) {
    const problem = assigneeProblem(ctx, scope, user.id, (data.assignee_id as string | null | undefined) ?? (row.assignee_id as string | null), finalUnit);
    if (problem) throw badRequest(problem, { fieldErrors: { assignee_id: problem } });
  }
  const keptProject = (row as Record<string, unknown>).project_id as string | null | undefined ?? null;
  checkProjectLink(ctx, scope, user.id, table, data.project_id === undefined ? keptProject : ((data.project_id as string | null) || null), keptProject, finalUnit, scopeChanged);

  const sets = ['updated_at = ?', 'version = version + 1'];
  const vals: unknown[] = [now()];
  if (scopeChanged) { sets.push('visibility = ?', 'unit_id = ?'); vals.push(finalVisibility, finalUnit); }
  for (const f of spec.fields) {
    if (data[f] === undefined) continue;
    sets.push(`${f} = ?`);
    vals.push(spec.json.includes(f) ? JSON.stringify(data[f] ?? []) : data[f]);
  }
  if (table === 'activities') {
    const merged = { ...row, ...data };
    sets.push('fingerprint = ?');
    vals.push(activityFingerprint(row.user_id, merged as never));
  }
  const expected = data.version as number | undefined;
  let result;
  try {
    if (expected !== undefined) {
      result = ctx.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND version = ?`).run(...vals, id, expected);
      if (result.changes === 0) throw conflict('This record changed while you were editing it. Reload to see the latest version.', 'stale', { current: getRecord(ctx, table, id) });
    } else {
      ctx.db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    }
  } catch (error) {
    if (table === 'activities' && String((error as Error).message).includes('UNIQUE')) throw conflict('An identical activity already exists for that date.', 'duplicate');
    throw error;
  }
  // A move is written where the record went and, when that is another Unit Instance, where it left too: each
  // instance's trail says what crossed its edge, without naming the other side (ADR-0008).
  const how = row.user_id === user.id ? 'author edit' : 'manager edit';
  const fromOrg = orgOfUnit(ctx, row.unit_id);
  const crossed = finalUnit !== row.unit_id && Boolean(fromOrg) && Boolean(finalUnit) && !sameInstance(ctx, row.unit_id, finalUnit);
  const moved = finalUnit === row.unit_id ? '' : crossed ? '; moved in from another Unit Instance' : `; moved from ${row.unit_id ?? 'no unit'} to ${finalUnit ?? 'no unit'}`;
  const subjectId = row.user_id !== user.id ? row.user_id : null;
  audit(ctx, { actor_id: user.id, action: 'edit', entity: table, entity_id: id, subject_id: subjectId, unit_id: finalUnit ?? row.unit_id, detail: `${how}${moved}`, ip });
  if (crossed) audit(ctx, { actor_id: user.id, action: 'edit', entity: table, entity_id: id, subject_id: subjectId, unit_id: row.unit_id, detail: `${how}; moved out to another Unit Instance`, ip });
  if (spec.assignee && data.assignee_id && data.assignee_id !== row.assignee_id && data.assignee_id !== user.id) {
    notify(ctx, String(data.assignee_id), { kind: 'assignment', title: table === 'tasks' ? 'Task assigned to you' : 'Goal assigned to you', message: String(data.title || row.title || ''), actionUrl: `/records/${table}/${id}`, dedupeKey: `${table}:${id}:assigned:${data.assignee_id}` });
  }
  return readBack(ctx, table, id);
}

export function deleteRecord(ctx: AppContext, user: SessionUser, table: RecordTable, id: string, reqKey: object, ip?: string) {
  const row = getRecord(ctx, table, id);
  if (!row) throw notFound('No such record.');
  const scope = scopeFor(ctx, user, reqKey);
  if (!canEdit(scope, user.id, row)) throw forbidden('That record is not yours to delete.');
  let detail: string | undefined;
  ctx.db.transaction(() => {
    ctx.db.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(now(), now(), id);
    if (table === 'projects') {
      const tasks = (ctx.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?').get(id) as { n: number }).n;
      const acts = (ctx.db.prepare('SELECT COUNT(*) AS n FROM activities WHERE project_id = ?').get(id) as { n: number }).n;
      detail = `${tasks} tasks, ${acts} activities still linked`;
    }
  })();
  audit(ctx, { actor_id: user.id, action: 'delete', entity: table, entity_id: id, subject_id: row.user_id !== user.id ? row.user_id : null, unit_id: row.unit_id, detail, ip });
  return { ok: true, id };
}

export function restoreRecord(ctx: AppContext, user: SessionUser, table: RecordTable, id: string, reqKey: object, ip?: string) {
  const row = getRecord(ctx, table, id, { includeDeleted: true });
  if (!row || !row.deleted_at) throw notFound('No such deleted record.');
  const scope = scopeFor(ctx, user, reqKey);
  if (!canEdit(scope, user.id, row)) throw forbidden('That record is not yours to restore.');
  if (table === 'activities' && row.fingerprint) {
    const twin = ctx.db.prepare('SELECT id, title FROM activities WHERE user_id = ? AND fingerprint = ? AND deleted_at IS NULL AND id != ?').get(row.user_id, row.fingerprint, id) as { id: string; title: string } | undefined;
    if (twin) throw conflict(`An identical live entry already exists (“${twin.title}”). Delete that one first, or leave this copy to purge.`, 'duplicate', { duplicate_id: twin.id });
  }
  ctx.db.prepare(`UPDATE ${table} SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
  audit(ctx, { actor_id: user.id, action: 'restore', entity: table, entity_id: id, unit_id: row.unit_id, ip });
  return readBack(ctx, table, id);
}

export function readableRecord(ctx: AppContext, user: SessionUser, table: RecordTable, id: string, reqKey: object) {
  const row = getRecord(ctx, table, id, { includeDeleted: true });
  if (!row || (row.deleted_at && row.user_id !== user.id)) throw notFound('No such record.');
  const scope = scopeFor(ctx, user, reqKey);
  if (!canRead(scope, user.id, row)) throw forbidden('You cannot open that record.');
  return row;
}

export function importActivities(ctx: AppContext, user: SessionUser, rows: unknown[], reqKey: object, ip?: string) {
  if (!Array.isArray(rows) || !rows.length) throw badRequest('No rows to import.');
  if (rows.length > 1000) throw badRequest('Imports are limited to 1000 activities per request. Split the file and import in batches.');
  const scope = scopeFor(ctx, user, reqKey);
  const planned: Array<{ id?: string; exists: boolean; data: Record<string, unknown>; visibility: string; unitId: string | null }> = [];
  rows.forEach((raw, i) => {
    const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const { id, ...rest } = source;
    const result = RECORD_SCHEMAS.activities.safeParse(rest);
    if (!result.success) throw badRequest(`Row ${i + 1}: ${result.error.issues[0]?.message || 'invalid'} (${result.error.issues[0]?.path.join('.')})`, { row: i });
    const data = result.data as Record<string, unknown>;
    if (data.dollar_type && !valueType(String(data.dollar_type), ctx.runtime.metrics)) throw badRequest(`Row ${i + 1}: unknown value type “${String(data.dollar_type)}”. This instance uses: ${ctx.runtime.metrics.value_types.map((t) => t.key).join(', ')}.`, { row: i });
    const existing = typeof id === 'string' && id ? (ctx.db.prepare('SELECT unit_id, visibility, project_id FROM activities WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, user.id) as { unit_id: string | null; visibility: string; project_id: string | null } | undefined) : undefined;
    const visibility = (data.visibility as string | undefined) ?? existing?.visibility ?? 'private';
    const unitId = data.unit_id !== undefined ? ((data.unit_id as string | null) || null) : existing ? existing.unit_id : (scope.homeUnitId ?? null);
    if (visibility === 'unit' && !unitId) throw badRequest(`Row ${i + 1}: shared activities need a unit.`, { row: i });
    if (!canPlace(scope, visibility, unitId, PERMISSIONS.CREATE_SHARED_WORK, true)) throw forbidden(`Row ${i + 1}: you cannot import into that unit.`);
    try {
      const kept = (existing as { project_id?: string | null } | undefined)?.project_id ?? null;
      checkProjectLink(ctx, scope, user.id, 'activities', data.project_id === undefined ? kept : ((data.project_id as string | null) || null), kept, unitId, Boolean(existing) && (existing!.unit_id !== unitId || existing!.visibility !== visibility));
    } catch (error) {
      if (error instanceof HttpError) throw new HttpError(error.status, `Row ${i + 1}: ${error.message}`, error.code, { row: i });
      throw error;
    }
    planned.push({ id: typeof id === 'string' && id ? id : undefined, exists: Boolean(existing), data, visibility, unitId });
  });
  const capacity = capacityProblem(ctx, user.id, planned.filter((p) => !p.exists).length);
  if (capacity) throw new HttpError(507, capacity, 'record_quota');
  const spec = TABLES.activities;
  let created = 0; let updated = 0; const duplicates: number[] = [];
  ctx.db.transaction(() => {
    planned.forEach((p, i) => {
      if (p.id) {
        const existing = ctx.db.prepare('SELECT * FROM activities WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(p.id, user.id) as RecordRow | undefined;
        if (existing && !existing.frozen_at) {
          const sets = ['updated_at = ?', 'version = version + 1', 'fingerprint = ?', 'visibility = ?', 'unit_id = ?'];
          const vals: unknown[] = [now(), activityFingerprint(user.id, p.data as never), p.visibility, p.unitId];
          for (const f of spec.fields) { if (p.data[f] === undefined) continue; sets.push(`${f} = ?`); vals.push(spec.json.includes(f) ? JSON.stringify(p.data[f] ?? []) : p.data[f]); }
          try { ctx.db.prepare(`UPDATE activities SET ${sets.join(', ')} WHERE id = ?`).run(...vals, p.id); updated += 1; }
          catch (error) { if (String((error as Error).message).includes('UNIQUE')) duplicates.push(i); else throw error; }
          return;
        }
      }
      const id = newId();
      const cols = ['id', 'user_id', 'unit_id', 'visibility', 'fingerprint', 'created_at', 'updated_at'];
      const vals: unknown[] = [id, user.id, p.unitId, p.visibility, activityFingerprint(user.id, p.data as never), now(), now()];
      for (const f of spec.fields) { if (p.data[f] === undefined) continue; cols.push(f); vals.push(spec.json.includes(f) ? JSON.stringify(p.data[f] ?? []) : p.data[f]); }
      try { ctx.db.prepare(`INSERT INTO activities (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals); created += 1; }
      catch (error) { if (String((error as Error).message).includes('UNIQUE')) duplicates.push(i); else throw error; }
    });
  })();
  audit(ctx, { actor_id: user.id, action: 'import', entity: 'activities', detail: `${created} created, ${updated} updated, ${duplicates.length} duplicates skipped`, ip });
  return { created, updated, duplicates: duplicates.length, duplicateRows: duplicates };
}

/**
 * Destroy records for good, with what hangs off them: their attachments and comments go too, work history keeps its
 * entry without the link, and a draft that became the entry goes with it. Run inside the caller's transaction.
 */
export function destroyRecords(ctx: AppContext, table: RecordTable, ids: string[]): { records: number; attachments: number; comments: number } {
  if (!ids.length) return { records: 0, attachments: 0, comments: 0 };
  const list = JSON.stringify(ids);
  const each = 'IN (SELECT value FROM json_each(?))';
  const attachments = ctx.db.prepare(`DELETE FROM attachments WHERE record_table = ? AND record_id ${each}`).run(table, list).changes;
  const comments = ctx.db.prepare(`DELETE FROM comments WHERE record_table = ? AND record_id ${each}`).run(table, list).changes;
  if (table === 'activities') {
    ctx.db.prepare(`UPDATE work_actions SET activity_id = NULL WHERE activity_id ${each}`).run(list);
    ctx.db.prepare(`DELETE FROM record_drafts WHERE activity_id ${each}`).run(list);
  }
  if (table === 'projects') for (const linked of ['tasks', 'activities', 'work_items']) ctx.db.prepare(`UPDATE ${linked} SET project_id = NULL WHERE project_id ${each}`).run(list);
  const records = ctx.db.prepare(`DELETE FROM ${table} WHERE id ${each}`).run(list).changes;
  return { records, attachments, comments };
}

export function purgeDeleted(ctx: AppContext, days = 30): { records: number; attachments: number; comments: number; held: number; blocked: boolean } {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  let records = 0; let attachments = 0; let comments = 0; let heldTotal = 0;
  const holds = holdState(ctx);
  if (holds.instance) {
    const waiting = RECORD_TABLE_NAMES.reduce((n, t) => n + (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE deleted_at IS NOT NULL AND deleted_at < ?`).get(cutoff) as { n: number }).n, 0);
    if (waiting) recordDispositionRun(ctx, { actorId: null, recordType: '(recycle bin)', disposition: 'destroy', eligible: waiting, acted: 0, held: waiting, detail: 'recycle-bin purge skipped: an instance-wide legal hold is open' });
    return { records: 0, attachments: 0, comments: 0, held: waiting, blocked: true };
  }
  const users = heldUsersClause(holds);
  ctx.db.transaction(() => {
    for (const table of RECORD_TABLE_NAMES) {
      const past = `deleted_at IS NOT NULL AND deleted_at < ?`;
      if (holds.types.has(table)) {
        const held = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${past}`).get(cutoff) as { n: number }).n;
        if (held) recordDispositionRun(ctx, { actorId: null, recordType: table, disposition: 'destroy', eligible: 0, acted: 0, held, detail: `recycle-bin purge (${days} days): a hold covers this record type` });
        heldTotal += held;
        continue;
      }
      const held = users.params.length ? (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${past}${users.onlySql}`).get(cutoff, ...users.params) as { n: number }).n : 0;
      heldTotal += held;
      const gone = ctx.db.prepare(`SELECT id FROM ${table} WHERE ${past}${users.sql}`).all(cutoff, ...users.params) as Array<{ id: string }>;
      if (!gone.length) {
        if (held) recordDispositionRun(ctx, { actorId: null, recordType: table, disposition: 'destroy', eligible: 0, acted: 0, held, detail: `recycle-bin purge (${days} days): rows of people under hold kept` });
        continue;
      }
      const destroyed = destroyRecords(ctx, table, gone.map((r) => r.id));
      const acted = destroyed.records;
      records += acted; attachments += destroyed.attachments; comments += destroyed.comments;
      recordDispositionRun(ctx, { actorId: null, recordType: table, disposition: 'destroy', eligible: gone.length, acted, held, detail: `recycle-bin purge: deleted more than ${days} days ago` });
    }
    const keep: string[] = [];
    const keepParams: string[] = [];
    for (const type of holds.types) { keep.push('record_table = ?'); keepParams.push(type); }
    if (users.params.length) {
      const list = users.params.map(() => '?').join(',');
      keep.push(`uploaded_by IN (${list})`); keepParams.push(...users.params);
      for (const table of RECORD_TABLE_NAMES) { keep.push(`(record_table = '${table}' AND record_id IN (SELECT id FROM ${table} WHERE user_id IN (${list})))`); keepParams.push(...users.params); }
    }
    const guard = keep.length ? ` AND NOT (${keep.join(' OR ')})` : '';
    attachments += ctx.db.prepare(`DELETE FROM attachments WHERE deleted_at IS NOT NULL AND deleted_at < ?${guard}`).run(cutoff, ...keepParams).changes;
  })();
  if (records || attachments || comments) audit(ctx, { actor_id: null, action: 'purge_deleted', entity: 'instance', detail: `${records} records, ${attachments} attachments, ${comments} comments older than ${days} days${heldTotal ? `; ${heldTotal} kept under hold` : ''}` });
  return { records, attachments, comments, held: heldTotal, blocked: false };
}
