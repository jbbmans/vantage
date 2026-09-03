import { createHash } from 'node:crypto';
import type { AppContext, SessionUser } from '../context.ts';
import { RECORD_SCHEMAS, type RecordTable } from '../../shared/schemas.ts';
import { PERMISSIONS, can, scopeFor, type Scope, isMember, detailUnitsFor } from '../authz/scope.ts';
import { readableClause, canEdit, canPlace, canRead, type RecordRow } from '../authz/records.ts';
import { HttpError, badRequest, forbidden, notFound, conflict } from '../lib/errors.ts';
import { parse } from '../lib/http.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { goalProgress, type GoalLike, type ActivityLike, type TrainingLike } from '../../shared/goals.ts';
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
  goals: { fields: ['title', 'description', 'type', 'category', 'metric', 'current_value', 'target_value', 'unit_label', 'status', 'period_start', 'period_end', 'assignee_id'], json: [], shareFlag: PERMISSIONS.CREATE_SHARED_GOALS, memberReadable: true, assignee: true, orderBy: 't.period_end IS NULL, t.period_end, t.created_at DESC' },
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
  return table === 'goals' ? withGoalProgress(ctx, hydrated as never) : hydrated;
}

/** Auto-tracked goals get their current value from the subject's logged work, so every server consumer sees the same number the Goals page shows. */
export function withGoalProgress<T extends GoalLike>(ctx: AppContext, goals: T[]): T[] {
  const cache = new Map<string, { activities: ActivityLike[]; trainings: TrainingLike[] }>();
  return goals.map((g) => {
    if (!g.metric || g.metric === 'manual') return g;
    const subject = String(g.assignee_id || g.user_id || '');
    const shared = g.visibility === 'unit' && g.unit_id ? String(g.unit_id) : null;
    const key = `${subject}|${shared || ''}`;
    if (!cache.has(key)) {
      const scopeSql = shared ? " AND visibility = 'unit' AND unit_id = ?" : '';
      const args = shared ? [subject, shared] : [subject];
      cache.set(key, {
        activities: ctx.db.prepare(`SELECT user_id, date, category, quantity, dollar_amount, dollar_type FROM activities WHERE user_id = ? AND deleted_at IS NULL${scopeSql}`).all(...args) as ActivityLike[],
        trainings: ctx.db.prepare(`SELECT user_id, date, hours FROM trainings WHERE user_id = ? AND deleted_at IS NULL${scopeSql}`).all(...args) as TrainingLike[],
      });
    }
    const src = cache.get(key)!;
    return { ...g, current_value: goalProgress(g, src.activities, src.trainings).current };
  });
}

export function getRecord(ctx: AppContext, table: RecordTable, id: string, { includeDeleted = false } = {}) {
  const row = ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`).get(id) as (RecordRow & Record<string, unknown>) | undefined;
  return hydrate(row, table);
}

function capacityProblem(ctx: AppContext, userId: string, additional = 1): string | null {
  const total = RECORD_TABLE_NAMES.reduce((sum, t) => sum + (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(userId) as { n: number }).n, 0);
  if (total + additional > ctx.config.limits.maxRecordsPerUser) return `This account has reached its ${ctx.config.limits.maxRecordsPerUser.toLocaleString()}-record limit. Contact the Instance Operator.`;
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

export function createRecord(ctx: AppContext, user: SessionUser, table: RecordTable, body: unknown, reqKey: object, ip?: string) {
  const spec = TABLES[table];
  const data = parse(RECORD_SCHEMAS[table] as never, body) as Record<string, unknown>;
  const capacity = capacityProblem(ctx, user.id);
  if (capacity) throw new HttpError(507, capacity, 'record_quota');
  const scope = scopeFor(ctx, user, reqKey);

  // Counselings are written *about* a member by a counselor. The subject is user_id; the author is counselor_id.
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
  const unitId = (data.unit_id as string | null | undefined) ?? scope.primaryUnitId ?? null;
  if (unitId && !ctx.db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(unitId)) throw badRequest('No such unit.', { fieldErrors: { unit_id: 'No such unit.' } });
  if (visibility === 'unit' && !unitId) throw badRequest('Choose a unit before sharing this record.', { fieldErrors: { unit_id: 'Required to share.' } });
  if (!onBehalf && !canPlace(scope, visibility, unitId, spec.shareFlag, Boolean(spec.personal))) throw forbidden('You cannot place a record in that unit.');
  if (spec.assignee && visibility !== 'unit' && data.assignee_id && data.assignee_id !== user.id) data.assignee_id = null;
  if (spec.assignee) {
    const problem = assigneeProblem(ctx, scope, user.id, data.assignee_id as string | null, unitId);
    if (problem) throw badRequest(problem, { fieldErrors: { assignee_id: problem } });
  }

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
  if (table === 'awards' && onBehalf) {
    notify(ctx, ownerId, { kind: 'award', title: 'Award recommendation started', message: `${user.first_name} ${user.last_name} recommended you for ${String(data.name || 'an award')}.`, actionUrl: '/career?tab=awards', dedupeKey: `award:${id}` });
  }
  if (table === 'counselings' && counselorId) {
    notify(ctx, ownerId, { kind: 'counseling', title: 'New counseling recorded', message: `${user.first_name} ${user.last_name} recorded a ${String(data.type || 'counseling').replace('_', ' ')} counseling.`, actionUrl: `/career?tab=counseling&open=${id}`, dedupeKey: `counseling:${id}` });
  }
  if (spec.assignee && data.assignee_id && data.assignee_id !== user.id) {
    notify(ctx, String(data.assignee_id), { kind: 'assignment', title: table === 'tasks' ? 'Task assigned to you' : 'Goal assigned to you', message: String(data.title || ''), actionUrl: table === 'tasks' ? '/work' : '/goals', dedupeKey: `${table}:${id}:assigned` });
  }
  return getRecord(ctx, table, id)!;
}

export function updateRecord(ctx: AppContext, user: SessionUser, table: RecordTable, id: string, body: unknown, reqKey: object, ip?: string) {
  const spec = TABLES[table];
  const row = getRecord(ctx, table, id);
  if (!row) throw notFound('No such record.');
  const scope = scopeFor(ctx, user, reqKey);
  if (!canEdit(scope, user.id, row)) throw forbidden(row.frozen_at ? 'That record is frozen because the author left the unit.' : 'That record is not yours to edit.');
  const data = parse((RECORD_SCHEMAS[table] as unknown as { partial: () => never }).partial() as never, body) as Record<string, unknown>;

  const finalVisibility = (data.visibility as string | undefined) ?? row.visibility;
  const finalUnit = data.unit_id === undefined ? row.unit_id : ((data.unit_id as string | null) || null);
  const scopeChanged = finalUnit !== row.unit_id || finalVisibility !== row.visibility;
  if (scopeChanged && row.user_id !== user.id && row.counselor_id !== user.id) throw forbidden('A record manager may correct content but may not change another Marine’s disclosure scope.', 'scope_owner_only');
  if (finalVisibility === 'unit' && !finalUnit) throw badRequest('Choose a unit before sharing this record.', { fieldErrors: { unit_id: 'Required to share.' } });
  if (finalUnit && finalUnit !== row.unit_id && !ctx.db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(finalUnit)) throw badRequest('No such unit.');
  if (scopeChanged && !canPlace(scope, finalVisibility, finalUnit, spec.shareFlag, Boolean(spec.personal))) throw forbidden('You cannot place a record in that unit.');
  if (spec.assignee && finalVisibility !== 'unit') { const who = (data.assignee_id as string | null | undefined) ?? (row.assignee_id as string | null); if (who && who !== user.id) data.assignee_id = null; }
  if (spec.assignee && (data.assignee_id !== undefined || scopeChanged)) {
    const problem = assigneeProblem(ctx, scope, user.id, (data.assignee_id as string | null | undefined) ?? (row.assignee_id as string | null), finalUnit);
    if (problem) throw badRequest(problem, { fieldErrors: { assignee_id: problem } });
  }

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
  audit(ctx, { actor_id: user.id, action: 'edit', entity: table, entity_id: id, subject_id: row.user_id !== user.id ? row.user_id : null, unit_id: finalUnit, detail: row.user_id === user.id ? 'author edit' : 'manager edit', ip });
  if (spec.assignee && data.assignee_id && data.assignee_id !== row.assignee_id && data.assignee_id !== user.id) {
    notify(ctx, String(data.assignee_id), { kind: 'assignment', title: table === 'tasks' ? 'Task assigned to you' : 'Goal assigned to you', message: String(data.title || row.title || ''), actionUrl: table === 'tasks' ? '/work' : '/goals', dedupeKey: `${table}:${id}:assigned:${data.assignee_id}` });
  }
  return getRecord(ctx, table, id)!;
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
      // Links stay in place while the project sits in the recycle bin, so a restore brings the project back whole. Purge unlinks.
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
  ctx.db.prepare(`UPDATE ${table} SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(now(), id);
  audit(ctx, { actor_id: user.id, action: 'restore', entity: table, entity_id: id, unit_id: row.unit_id, ip });
  return getRecord(ctx, table, id)!;
}

export function readableRecord(ctx: AppContext, user: SessionUser, table: RecordTable, id: string, reqKey: object) {
  const row = getRecord(ctx, table, id, { includeDeleted: true });
  if (!row || (row.deleted_at && row.user_id !== user.id)) throw notFound('No such record.');
  const scope = scopeFor(ctx, user, reqKey);
  if (!canRead(scope, user.id, row)) throw forbidden('You cannot open that record.');
  return row;
}

/** Bulk import of activities: upsert by Vantage ID when the caller owns it, skip fingerprint duplicates. */
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
    const existing = typeof id === 'string' && id ? (ctx.db.prepare('SELECT unit_id, visibility FROM activities WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(id, user.id) as { unit_id: string | null; visibility: string } | undefined) : undefined;
    const visibility = (data.visibility as string | undefined) ?? existing?.visibility ?? 'private';
    const unitId = data.unit_id !== undefined ? ((data.unit_id as string | null) || null) : existing ? existing.unit_id : (scope.primaryUnitId ?? null);
    if (visibility === 'unit' && !unitId) throw badRequest(`Row ${i + 1}: shared activities need a unit.`, { row: i });
    if (!canPlace(scope, visibility, unitId, PERMISSIONS.CREATE_SHARED_WORK, true)) throw forbidden(`Row ${i + 1}: you cannot import into that unit.`);
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

/** Permanently remove records (and their attachments) that have sat in the recycle bin longer than `days`. */
export function purgeDeleted(ctx: AppContext, days = 30): { records: number; attachments: number } {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  let records = 0; let attachments = 0;
  ctx.db.transaction(() => {
    for (const table of RECORD_TABLE_NAMES) {
      const gone = ctx.db.prepare(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`).all(cutoff) as Array<{ id: string }>;
      if (!gone.length) continue;
      for (const { id } of gone) attachments += ctx.db.prepare('DELETE FROM attachments WHERE record_table = ? AND record_id = ?').run(table, id).changes;
      if (table === 'projects') for (const { id } of gone) { ctx.db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(id); ctx.db.prepare('UPDATE activities SET project_id = NULL WHERE project_id = ?').run(id); }
      records += ctx.db.prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`).run(cutoff).changes;
    }
    attachments += ctx.db.prepare('DELETE FROM attachments WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(cutoff).changes;
  })();
  if (records || attachments) audit(ctx, { actor_id: null, action: 'purge_deleted', entity: 'instance', detail: `${records} records, ${attachments} attachments older than ${days} days` });
  return { records, attachments };
}
