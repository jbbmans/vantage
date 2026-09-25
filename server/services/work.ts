import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, isMember, scopeFor, PERMISSIONS } from '../authz/scope.ts';
import { audit } from './audit.ts';
import { notify } from './notifications.ts';
import { record } from './telemetry.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { zonedDay } from '../lib/clock.ts';
import { appendEvent, caseView, assertMayResolveCase } from './cases.ts';
import { STATE_TO_STAGE } from '../../shared/caseModel.ts';

export interface WorkItemRow {
  id: string; unit_id: string | null; owner_id: string; visibility: string;
  source_file_id: string | null; import_job_id: string | null;
  natural_key: string; row_hash: string; source_row: number | null;
  title: string; reference: string | null; due_date: string | null;
  amount: number | null; amount_type: string | null; quantity: number | null; unit_label: string | null;
  state: string; data: string;
  claimed_by: string | null; claimed_at: string | null; resolved_at: string | null; source_changed_at: string | null;
  version: number; deleted_at: string | null; created_at: string; updated_at: string;
  stage?: string | null; waiting_category?: string | null; waiting_since?: string | null; blocked_reason?: string | null;
  procedure_key?: string | null; procedure_version?: string | null; project_id?: string | null;
}

export const WORK_STATES = ['open', 'in_progress', 'waiting', 'resolved', 'not_applicable'] as const;
export type WorkState = (typeof WORK_STATES)[number];

const hydrate = (row: WorkItemRow) => ({ ...row, data: JSON.parse(row.data || '{}') as Record<string, string> });

const shared = (row: WorkItemRow) => row.visibility === 'unit' && Boolean(row.unit_id);
const stillHere = (scope: Scope, row: WorkItemRow) => !shared(row) || isMember(scope, row.unit_id);

export function readable(scope: Scope, user: SessionUser, row: WorkItemRow): boolean {
  if (shared(row)) return isMember(scope, row.unit_id);
  return row.owner_id === user.id || row.claimed_by === user.id;
}

const mine = (scope: Scope, user: SessionUser, row: WorkItemRow) => row.owner_id === user.id && stillHere(scope, row);
const holder = (scope: Scope, user: SessionUser, row: WorkItemRow) => row.claimed_by === user.id && stillHere(scope, row);
const bit = (scope: Scope, row: WorkItemRow, flag: number) => (row.unit_id ? can(scope, flag, row.unit_id) : false);

export const mayClaim = (scope: Scope, user: SessionUser, row: WorkItemRow) =>
  mine(scope, user, row) || bit(scope, row, PERMISSIONS.CLAIM_WORK);

export const mayResolve = (scope: Scope, user: SessionUser, row: WorkItemRow) =>
  mine(scope, user, row) || bit(scope, row, PERMISSIONS.RESOLVE_WORK);

/** Handing a case to somebody, or freeing one somebody is sitting on. */
export const mayReassign = (scope: Scope, user: SessionUser, row: WorkItemRow) =>
  mine(scope, user, row) || bit(scope, row, PERMISSIONS.REASSIGN_WORK) || bit(scope, row, PERMISSIONS.MANAGE_RECORDS);

export const mayEditFields = (scope: Scope, user: SessionUser, row: WorkItemRow) =>
  mine(scope, user, row) || bit(scope, row, PERMISSIONS.EDIT_WORK);
export const isImported = (row: WorkItemRow) => Boolean(row.source_file_id || row.import_job_id);

export const mayProgress = (scope: Scope, user: SessionUser, row: WorkItemRow) =>
  holder(scope, user, row) || mine(scope, user, row) || bit(scope, row, PERMISSIONS.MANAGE_RECORDS);

export const mayAct = (scope: Scope, user: SessionUser, row: WorkItemRow) =>
  holder(scope, user, row) || mine(scope, user, row) || bit(scope, row, PERMISSIONS.MANAGE_RECORDS);

export function getItem(ctx: AppContext, id: string): WorkItemRow | null {
  return (ctx.db.prepare('SELECT * FROM work_items WHERE id = ? AND deleted_at IS NULL').get(id) as WorkItemRow | undefined) || null;
}

export function readableItem(ctx: AppContext, user: SessionUser, scope: Scope, id: string): WorkItemRow {
  const row = getItem(ctx, id);
  if (!row) throw notFound('No such work item.');
  if (!readable(scope, user, row)) throw forbidden('That work is not yours to open.');
  return row;
}

export interface ListOptions {
  unitId?: string | null;
  state?: string | null;
  stage?: string | null;
  active?: boolean;
  claimed?: 'me' | 'anyone' | 'nobody' | null;
  projectId?: string | null;
  /** Narrow to one procedure, or 'none' for work that follows none. */
  procedure?: string | null;
  q?: string | null;
  dueBefore?: string | null;
  sort?: string | null;
  direction?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const SORTABLE: Record<string, string> = {
  due_date: 'due_date', title: 'title', reference: 'reference', amount: 'amount',
  quantity: 'quantity', state: 'state', updated_at: 'updated_at', natural_key: 'natural_key',
};

export function listItems(ctx: AppContext, user: SessionUser, scope: Scope, opts: ListOptions = {}) {
  const readableUnits = scope.unitIds;
  const where: string[] = ['w.deleted_at IS NULL'];
  const params: unknown[] = [];

  const personal = "((w.visibility <> 'unit' OR w.unit_id IS NULL) AND (w.owner_id = ? OR w.claimed_by = ?))";
  const visibility = readableUnits.length
    ? `(${personal} OR (w.visibility = 'unit' AND w.unit_id IN (${readableUnits.map(() => '?').join(',')})))`
    : personal;
  where.push(visibility);
  params.push(user.id, user.id, ...readableUnits);

  if (opts.unitId) { where.push('w.unit_id = ?'); params.push(opts.unitId); }
  if (opts.state) { where.push('w.state = ?'); params.push(opts.state); }
  if (opts.stage) { where.push('w.stage = ?'); params.push(opts.stage); }
  if (opts.active) where.push("w.state NOT IN ('resolved', 'not_applicable')");
  if (opts.projectId) { where.push('w.project_id = ?'); params.push(opts.projectId); }
  if (opts.procedure === 'none') where.push('w.procedure_key IS NULL');
  else if (opts.procedure) { where.push('w.procedure_key = ?'); params.push(opts.procedure); }
  if (opts.claimed === 'me') { where.push('w.claimed_by = ?'); params.push(user.id); }
  else if (opts.claimed === 'nobody') where.push('w.claimed_by IS NULL');
  else if (opts.claimed === 'anyone') where.push('w.claimed_by IS NOT NULL');
  if (opts.dueBefore) { where.push('w.due_date IS NOT NULL AND w.due_date <= ?'); params.push(opts.dueBefore); }
  if (opts.q && opts.q.trim()) {
    const needle = `%${opts.q.trim().toLowerCase()}%`;
    where.push('(lower(w.title) LIKE ? OR lower(w.natural_key) LIKE ? OR lower(COALESCE(w.reference, \'\')) LIKE ?)');
    params.push(needle, needle, needle);
  }

  const column = SORTABLE[String(opts.sort || 'due_date')] || 'due_date';
  const direction = opts.direction === 'desc' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const clause = where.join(' AND ');
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM work_items w WHERE ${clause}`).get(...params) as { n: number }).n;
  const rows = ctx.db.prepare(
    `SELECT w.*, h.first_name || ' ' || h.last_name AS holder_name, hr.abbr AS holder_rank, p.name AS project_name
       FROM work_items w LEFT JOIN users h ON h.id = w.claimed_by LEFT JOIN ranks hr ON hr.id = h.rank_id
       LEFT JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
      WHERE ${clause} ORDER BY (w.${column} IS NULL), w.${column} ${direction}, w.natural_key ASC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as WorkItemRow[];

  return { total, limit, offset, items: rows.map(hydrate) };
}

export function itemDetail(ctx: AppContext, user: SessionUser, scope: Scope, id: string) {
  const row = readableItem(ctx, user, scope, id);
  const actions = ctx.db.prepare(
    `SELECT a.*, u.first_name, u.last_name, r.abbr AS rank_abbr
       FROM work_actions a JOIN users u ON u.id = a.user_id LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE a.work_item_id = ? ORDER BY a.occurred_at DESC, a.created_at DESC LIMIT 200`
  ).all(id) as Array<Record<string, unknown>>;
  const source = row.source_file_id
    ? ctx.db.prepare('SELECT id, filename, created_at, sha256 FROM source_files WHERE id = ?').get(row.source_file_id)
    : null;
  const project = row.project_id
    ? ctx.db.prepare('SELECT id, name, target_date FROM projects WHERE id = ? AND deleted_at IS NULL').get(row.project_id) ?? null
    : null;
  return { item: hydrate(row), actions, source, project, contributors: contributors(ctx, id), case: caseView(ctx, user, scope, row) };
}

export function contributors(ctx: AppContext, itemId: string) {
  const rows = ctx.db.prepare(
    `SELECT a.user_id, u.first_name, u.last_name, r.abbr AS rank_abbr,
            COUNT(*) AS actions, MIN(a.occurred_at) AS first_at, MAX(a.occurred_at) AS last_at
       FROM work_actions a JOIN users u ON u.id = a.user_id LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE a.work_item_id = ? GROUP BY a.user_id ORDER BY actions DESC`
  ).all(itemId) as Array<Record<string, unknown>>;
  return rows;
}

function reload(ctx: AppContext, id: string): WorkItemRow {
  const row = getItem(ctx, id);
  if (!row) throw notFound('That work item is gone.');
  return row;
}

export function claimItem(ctx: AppContext, user: SessionUser, scope: Scope, id: string, expectedVersion: number | null) {
  return ctx.db.transaction(() => {
    const row = reload(ctx, id);
    if (!readable(scope, user, row)) throw forbidden('That work is not yours to claim.');
    if (!mayClaim(scope, user, row)) throw forbidden('You can see this work but you are not cleared to pick it up.');
    if (expectedVersion != null && row.version !== expectedVersion) throw conflict('This row changed while you were looking at it. Reload and try again.');
    if (row.claimed_by && row.claimed_by !== user.id) {
      const holder = ctx.db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(row.claimed_by) as { first_name: string; last_name: string } | undefined;
      throw conflict(holder ? `${holder.first_name} ${holder.last_name} already picked this up.` : 'Someone else already picked this up.');
    }
    if (row.state === 'resolved') throw conflict('This work is already resolved.');
    const at = now();
    ctx.db.prepare(
      `UPDATE work_items SET claimed_by = ?, claimed_at = ?, state = CASE WHEN state = 'open' THEN 'in_progress' ELSE state END,
              stage = CASE WHEN state = 'open' THEN 'researching' ELSE COALESCE(stage, 'researching') END, version = version + 1, updated_at = ? WHERE id = ?`
    ).run(user.id, at, at, id);
    appendEvent(ctx, { item: row, actorId: user.id, kind: 'claimed' });
    record(ctx, 'work.claimed', { bulk: false, count: 1 }, { id: user.id });
    return hydrate(reload(ctx, id));
  })();
}

export function releaseItem(ctx: AppContext, user: SessionUser, scope: Scope, id: string, expectedVersion: number | null) {
  return ctx.db.transaction(() => {
    const row = reload(ctx, id);
    if (!readable(scope, user, row)) throw forbidden('That work is not yours.');
    if (expectedVersion != null && row.version !== expectedVersion) throw conflict('This row changed while you were looking at it. Reload and try again.');
    if (!(holder(scope, user, row) || mayReassign(scope, user, row))) {
      throw forbidden('Only the person holding this work, or somebody who can reassign work here, can release it.');
    }
    const at = now();
    ctx.db.prepare(
      `UPDATE work_items SET claimed_by = NULL, claimed_at = NULL,
              stage = CASE WHEN state = 'in_progress' AND COALESCE(stage, 'researching') = 'researching' THEN 'not_started' ELSE stage END,
              state = CASE WHEN state = 'in_progress' AND COALESCE(stage, 'researching') = 'researching' THEN 'open' ELSE state END,
              version = version + 1, updated_at = ? WHERE id = ?`
    ).run(at, id);
    appendEvent(ctx, { item: row, actorId: user.id, kind: 'released', subjectId: row.claimed_by !== user.id ? row.claimed_by : null });
    record(ctx, 'work.released', { held_hours: row.claimed_at ? Math.max(0, (Date.parse(at) - Date.parse(row.claimed_at)) / 3_600_000) : 0 }, { id: user.id });
    return hydrate(reload(ctx, id));
  })();
}

export function createItem(
  ctx: AppContext,
  user: SessionUser,
  scope: Scope,
  input: { unit_id?: string | null; title: string; reference?: string | null; due_date?: string | null; project_id?: string | null; visibility?: string },
) {
  const title = String(input.title || '').trim();
  if (!title) throw badRequest('A piece of work needs a title.', { fieldErrors: { title: 'Required.' } });
  if (title.length > 300) throw badRequest('Keep the title under 300 characters.', { fieldErrors: { title: 'Limit 300 characters.' } });

  const unitId = input.unit_id || null;
  const visibility = input.visibility === 'private' ? 'private' : 'unit';
  if (visibility === 'unit') {
    if (!unitId) throw badRequest('Choose the unit this work belongs to.');
    if (!can(scope, PERMISSIONS.CREATE_SHARED_WORK, unitId)) throw forbidden('You cannot put work on that unit’s queue.');
  } else if (unitId && !isMember(scope, unitId)) {
    throw forbidden('You are not a member of that unit.');
  }

  let projectId: string | null = null;
  if (input.project_id) {
    const project = ctx.db.prepare('SELECT id, user_id, unit_id, visibility FROM projects WHERE id = ? AND deleted_at IS NULL')
      .get(String(input.project_id)) as { id: string; user_id: string; unit_id: string | null; visibility: string } | undefined;
    if (!project) throw badRequest('No such project.');
    const reachable = project.user_id === user.id
      || (project.visibility === 'unit' && project.unit_id && (isMember(scope, project.unit_id) || can(scope, PERMISSIONS.VIEW_RECORDS, project.unit_id)));
    if (!reachable) throw forbidden('That is not a project you can file work under.');
    projectId = project.id;
  }

  const id = newId();
  const at = now();
  ctx.db.prepare(
    `INSERT INTO work_items (id, unit_id, owner_id, visibility, source_file_id, import_job_id, natural_key, row_hash, source_row,
                             title, reference, due_date, amount, amount_type, quantity, unit_label, state, data, project_id, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, '', NULL, ?, ?, ?, NULL, NULL, NULL, NULL, 'open', '{}', ?, 1, ?, ?)`
  ).run(id, unitId, user.id, visibility, `manual:${id}`, title, input.reference?.trim() || null, input.due_date || null, projectId, at, at);
  ctx.db.prepare("UPDATE work_items SET stage = 'not_started' WHERE id = ?").run(id);
  appendEvent(ctx, { item: { id, unit_id: unitId }, actorId: user.id, kind: 'created', body: { origin: 'typed' } });
  audit(ctx, { actor_id: user.id, action: 'work_created', entity: 'work_items', entity_id: id, unit_id: unitId });
  record(ctx, 'work.created', { manual: true, count: 1 }, { id: user.id });
  return hydrate(reload(ctx, id));
}

export function assignItem(ctx: AppContext, user: SessionUser, scope: Scope, id: string, toUserId: string, expectedVersion: number | null) {
  return ctx.db.transaction(() => {
    const row = reload(ctx, id);
    if (!readable(scope, user, row)) throw forbidden('That work is not yours.');
    if (!mayReassign(scope, user, row)) throw forbidden('Handing work to somebody else is not yours to do.');
    if (expectedVersion != null && row.version !== expectedVersion) throw conflict('This row changed while you were looking at it. Reload and try again.');
    if (row.state === 'resolved') throw conflict('This work is already resolved.');

    const target = ctx.db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ? AND active = 1').get(toUserId) as { id: string; first_name: string; last_name: string } | undefined;
    if (!target) throw badRequest('No such person to assign this to.');
    // Checked with their authority, not the assigner's.
    if (!readable(scopeFor(ctx, { id: target.id }), { id: target.id } as SessionUser, row)) {
      throw badRequest(`${target.first_name} ${target.last_name} cannot see this work, so it cannot be assigned to them.`);
    }

    const at = now();
    ctx.db.prepare(
      `UPDATE work_items SET claimed_by = ?, claimed_at = ?, state = CASE WHEN state = 'open' THEN 'in_progress' ELSE state END,
              stage = CASE WHEN state = 'open' THEN 'researching' ELSE COALESCE(stage, 'researching') END, version = version + 1, updated_at = ? WHERE id = ?`
    ).run(target.id, at, at, id);
    appendEvent(ctx, { item: row, actorId: user.id, kind: 'assigned', subjectId: target.id, body: { from: row.claimed_by } });
    audit(ctx, { actor_id: user.id, action: 'work_assigned', entity: 'work_items', entity_id: id, subject_id: target.id, unit_id: row.unit_id });
    notify(ctx, target.id, {
      kind: 'work_assigned',
      title: 'A case was handed to you',
      message: row.title.slice(0, 160),
      actionUrl: `/work/items/${id}`,
      dedupeKey: `work-assign:${id}:${at}`,
    });
    record(ctx, 'work.assigned', { bulk: false, count: 1 }, { id: user.id });
    return hydrate(reload(ctx, id));
  })();
}

export function releaseStaleClaims(ctx: AppContext, afterHours = 72): number {
  const cutoff = new Date(Date.now() - afterHours * 3_600_000).toISOString();
  const stale = ctx.db.prepare(
    `SELECT id, unit_id, claimed_by FROM work_items
      WHERE claimed_by IS NOT NULL AND deleted_at IS NULL
        AND state IN ('open', 'in_progress') AND claimed_at < ? AND updated_at < ?`
  ).all(cutoff, cutoff) as Array<{ id: string; unit_id: string | null; claimed_by: string }>;
  if (!stale.length) return 0;
  const at = now();
  ctx.db.transaction(() => {
    for (const row of stale) {
      ctx.db.prepare(
        `UPDATE work_items SET claimed_by = NULL, claimed_at = NULL,
                stage = CASE WHEN state = 'in_progress' AND COALESCE(stage, 'researching') = 'researching' THEN 'not_started' ELSE stage END,
                state = CASE WHEN state = 'in_progress' AND COALESCE(stage, 'researching') = 'researching' THEN 'open' ELSE state END,
                version = version + 1, updated_at = ? WHERE id = ?`
      ).run(at, row.id);
      appendEvent(ctx, { item: row, actorId: null, kind: 'claim_expired', subjectId: row.claimed_by, body: { after_hours: afterHours } });
      audit(ctx, { actor_id: null, action: 'work_claim_expired', entity: 'work_items', entity_id: row.id, subject_id: row.claimed_by, unit_id: row.unit_id, detail: `untouched for ${afterHours}h` });
    }
  })();
  return stale.length;
}

export function releaseClaimsOnDeparture(ctx: AppContext, userId: string, unitId: string, actorId: string | null): number {
  const held = ctx.db.prepare(
    `SELECT * FROM work_items WHERE claimed_by = ? AND unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL`
  ).all(userId, unitId) as WorkItemRow[];
  const at = now();
  for (const row of held) {
    ctx.db.prepare(
      `UPDATE work_items SET claimed_by = NULL, claimed_at = NULL,
              stage = CASE WHEN state = 'in_progress' AND COALESCE(stage, 'researching') = 'researching' THEN 'not_started' ELSE stage END,
              state = CASE WHEN state = 'in_progress' AND COALESCE(stage, 'researching') = 'researching' THEN 'open' ELSE state END,
              version = version + 1, updated_at = ? WHERE id = ?`
    ).run(at, row.id);
    appendEvent(ctx, { item: row, actorId, kind: 'claim_expired', subjectId: userId, body: { reason: 'left_unit' } });
    audit(ctx, { actor_id: actorId, action: 'work_claim_released_on_departure', entity: 'work_items', entity_id: row.id, subject_id: userId, unit_id: unitId });
  }
  return held.length;
}

export interface ItemPatch {
  state?: WorkState;
  acknowledge_source_change?: boolean;
  title?: string;
  reference?: string | null;
  due_date?: string | null;
  project_id?: string | null;
}

const CLOSED_STATES = new Set<string>(['resolved', 'not_applicable']);
const EDITABLE_FIELDS = ['title', 'reference', 'due_date'] as const;

export function updateItem(ctx: AppContext, user: SessionUser, scope: Scope, id: string, patch: ItemPatch, expectedVersion: number | null) {
  return ctx.db.transaction(() => {
    const row = reload(ctx, id);
    if (!readable(scope, user, row)) throw forbidden('That work is not yours.');
    if (expectedVersion != null && row.version !== expectedVersion) throw conflict('This row changed while you were looking at it. Reload and try again.');
    const at = now();
    const sets: string[] = ['version = version + 1', 'updated_at = ?'];
    const params: unknown[] = [at];

    if (patch.state) {
      if (!WORK_STATES.includes(patch.state)) throw badRequest('That is not a state a work item can be in.');
      const closing = CLOSED_STATES.has(patch.state);
      const reopening = CLOSED_STATES.has(row.state) && !closing;
      if (closing || reopening) {
        if (!mayResolve(scope, user, row)) {
          throw forbidden(closing
            ? 'You can work this case but closing one out is not yours to do.'
            : 'Reopening a closed case is not yours to do.');
        }
      } else if (!mayProgress(scope, user, row)) {
        throw forbidden('Pick this work up before changing it.');
      }
      if (row.procedure_key && patch.state === 'resolved') assertMayResolveCase(ctx, row);
      if (row.procedure_key && patch.state === 'not_applicable') {
        throw conflict('This work follows a procedure. Mark it not applicable from the case, with the reason.', 'reason_required');
      }
      sets.push('state = ?'); params.push(patch.state);
      sets.push('resolved_at = ?'); params.push(patch.state === 'resolved' ? at : null);
      const toStage = STATE_TO_STAGE[patch.state];
      sets.push('stage = ?'); params.push(toStage);
      if (patch.state !== 'waiting') { sets.push('waiting_category = NULL', 'waiting_since = NULL'); }
      const fromStage = (row as WorkItemRow & { stage?: string | null }).stage || STATE_TO_STAGE[row.state];
      if (fromStage !== toStage) {
        appendEvent(ctx, { item: row, actorId: user.id, kind: 'stage_changed', body: { from: fromStage, to: toStage, reason: null } });
        if (toStage === 'resolved') appendEvent(ctx, { item: row, actorId: user.id, kind: 'resolved', body: {} });
        if (CLOSED_STATES.has(row.state) && !closing) appendEvent(ctx, { item: row, actorId: user.id, kind: 'reopened', body: {} });
      }
    }

    const edits = EDITABLE_FIELDS.filter((f) => patch[f] !== undefined);
    if (edits.length) {
      if (isImported(row)) {
        throw forbidden('This row came from an imported sheet. Its values are what the sheet said — record an action instead of rewriting them.');
      }
      if (!mayEditFields(scope, user, row)) throw forbidden('Changing this row is not yours to do.');
      for (const field of edits) {
        const value = patch[field];
        if (field === 'title') {
          const title = String(value ?? '').trim();
          if (!title) throw badRequest('A work item needs a title.', { fieldErrors: { title: 'Required.' } });
          if (title.length > 300) throw badRequest('Keep the title under 300 characters.');
          sets.push('title = ?'); params.push(title);
        } else {
          sets.push(`${field} = ?`); params.push(value === '' || value == null ? null : String(value));
        }
      }
    }

    if (patch.project_id !== undefined) {
      if (!mayEditFields(scope, user, row)) throw forbidden('Filing this work under a project is not yours to do.');
      if (patch.project_id) {
        const project = ctx.db.prepare('SELECT id, user_id, unit_id, visibility FROM projects WHERE id = ? AND deleted_at IS NULL')
          .get(String(patch.project_id)) as { id: string; user_id: string; unit_id: string | null; visibility: string } | undefined;
        if (!project) throw badRequest('No such project.');
        const reachable = project.user_id === user.id
          || (project.visibility === 'unit' && project.unit_id && (isMember(scope, project.unit_id) || can(scope, PERMISSIONS.VIEW_RECORDS, project.unit_id)));
        if (!reachable) throw forbidden('That is not a project you can file work under.');
        sets.push('project_id = ?'); params.push(project.id);
      } else {
        sets.push('project_id = NULL');
      }
    }

    if (patch.acknowledge_source_change) {
      if (!mayProgress(scope, user, row) && !mayEditFields(scope, user, row)) throw forbidden('That is not yours to acknowledge.');
      sets.push('source_changed_at = NULL');
    }
    if (sets.length === 2) throw badRequest('Nothing to change.');
    ctx.db.prepare(`UPDATE work_items SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return hydrate(reload(ctx, id));
  })();
}

export interface ActionInput {
  kind: string;
  note?: string | null;
  occurred_at?: string | null;
  quantity?: number | null;
  unit_label?: string | null;
  dollar_amount?: number | null;
  dollar_type?: string | null;
  draft_record?: boolean;
  /** Resolve the item in the same breath. */
  resolve?: boolean;
  category?: string | null;
  eval_area?: string | null;
}

export const ACTION_KINDS = ['worked', 'contacted', 'escalated', 'corrected', 'reconciled', 'validated', 'resolved', 'noted'] as const;

export function recordAction(
  ctx: AppContext,
  user: SessionUser,
  scope: Scope,
  itemId: string,
  input: ActionInput,
  idempotencyKey: string | null,
) {
  const scopedKey = idempotencyKey ? `${user.id}:${itemId}:${idempotencyKey}` : null;
  if (scopedKey) {
    const prior = ctx.db.prepare('SELECT * FROM work_actions WHERE idempotency_key = ?').get(scopedKey) as Record<string, unknown> | undefined;
    if (prior) return { action: prior, item: hydrate(reload(ctx, itemId)), activity_id: prior.activity_id as string | null, replayed: true };
  }

  const kind = ACTION_KINDS.includes(input.kind as never) ? input.kind : 'worked';
  const occurredAt = input.occurred_at && /^\d{4}-\d{2}-\d{2}$/.test(input.occurred_at) ? input.occurred_at : zonedDay(ctx.config.timezone);
  const note = (input.note || '').slice(0, 5000) || null;
  const quantity = input.quantity == null ? null : Number(input.quantity);
  const dollarAmount = input.dollar_amount == null ? null : Number(input.dollar_amount);
  if (quantity != null && !Number.isFinite(quantity)) throw badRequest('The amount of work done is not a number.');
  if (dollarAmount != null && !Number.isFinite(dollarAmount)) throw badRequest('The value is not a number.');
  if (dollarAmount != null && !input.dollar_type) throw badRequest('Say what kind of value this is. An unlabelled amount cannot be counted.');
  if (input.dollar_type && !ctx.runtime.metrics.value_types.some((t) => t.key === input.dollar_type)) {
    throw badRequest('That is not a value type this instance tracks.');
  }

  return ctx.db.transaction(() => {
    const row = reload(ctx, itemId);
    if (!readable(scope, user, row)) throw forbidden('That work is not yours.');
    if (!mayAct(scope, user, row)) throw forbidden('Pick this work up before recording what you did.');

    const at = now();
    let activityId: string | null = null;

    if (input.draft_record) {
      activityId = newId();
      const title = `${row.title}`.slice(0, 300);
      const result = note ? note.slice(0, 2000) : null;
      ctx.db.prepare(
        `INSERT INTO activities (id, user_id, unit_id, visibility, date, title, category, eval_area, quantity, unit_label,
                                 dollar_amount, dollar_type, result, organization, system, project_id, status, notes, evidence_links,
                                 fingerprint, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'completed', NULL, '[]', ?, 1, ?, ?)`
      ).run(
        activityId, user.id, row.unit_id, row.visibility, occurredAt, title,
        input.category || null, input.eval_area || null,
        quantity, input.unit_label || row.unit_label || null,
        dollarAmount, input.dollar_type || null, result,
        `work:${itemId}:${scopedKey || newId()}`,
        at, at,
      );
    }

    const actionId = newId();
    ctx.db.prepare(
      `INSERT INTO work_actions (id, work_item_id, user_id, unit_id, kind, note, occurred_at, quantity, unit_label, dollar_amount, dollar_type, activity_id, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(actionId, itemId, user.id, row.unit_id, kind, note, occurredAt, quantity, input.unit_label || null, dollarAmount, input.dollar_type || null, activityId, scopedKey, at);
    appendEvent(ctx, {
      item: row, actorId: user.id, kind: 'action_recorded', occurredAt: `${occurredAt}T12:00:00.000Z`,
      body: { action_id: actionId, action: kind, text: note, quantity, unit_label: input.unit_label || null, drafted_record: Boolean(activityId) },
    });

    if (input.resolve || kind === 'resolved') {
      if (!mayResolve(scope, user, row)) {
        throw forbidden('You can record what you did, but closing this case out is not yours to do.');
      }
      if (row.procedure_key) {
        throw conflict('This work follows a procedure. Verify the original condition cleared, then resolve it from the case.', 'verification_required');
      }
      const fromStage = (row as WorkItemRow & { stage?: string | null }).stage || STATE_TO_STAGE[row.state];
      ctx.db.prepare(`UPDATE work_items SET state = 'resolved', stage = 'resolved', waiting_category = NULL, waiting_since = NULL, resolved_at = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(at, at, itemId);
      if (fromStage !== 'resolved') {
        appendEvent(ctx, { item: row, actorId: user.id, kind: 'stage_changed', body: { from: fromStage, to: 'resolved', reason: null } });
        appendEvent(ctx, { item: row, actorId: user.id, kind: 'resolved', body: {} });
      }
    } else {
      ctx.db.prepare(`UPDATE work_items SET state = CASE WHEN state = 'open' THEN 'in_progress' ELSE state END,
                             stage = CASE WHEN state = 'open' THEN 'researching' ELSE COALESCE(stage, 'researching') END,
                             version = version + 1, updated_at = ? WHERE id = ?`).run(at, itemId);
    }

    const action = ctx.db.prepare('SELECT * FROM work_actions WHERE id = ?').get(actionId) as Record<string, unknown>;
    record(ctx, 'work.action_recorded', { kind, drafted_record: Boolean(activityId), resolved: Boolean(input.resolve || kind === 'resolved') }, { id: user.id });
    return { action, item: hydrate(reload(ctx, itemId)), activity_id: activityId, replayed: false };
  })();
}

export function listViews(ctx: AppContext, user: SessionUser, scope: Scope) {
  const units = scope.unitIds;
  const rows = units.length
    ? ctx.db.prepare(`SELECT * FROM work_views WHERE user_id = ? OR (shared = 1 AND unit_id IN (${units.map(() => '?').join(',')})) ORDER BY name`).all(user.id, ...units)
    : ctx.db.prepare('SELECT * FROM work_views WHERE user_id = ? ORDER BY name').all(user.id);
  return (rows as Array<Record<string, unknown>>).map((r) => ({ ...r, config: JSON.parse(String(r.config || '{}')) }));
}

export function saveView(ctx: AppContext, user: SessionUser, scope: Scope, input: { id?: string | null; name: string; unit_id?: string | null; shared?: boolean; config: unknown }) {
  const name = String(input.name || '').trim().slice(0, 80);
  if (!name) throw badRequest('Give the view a name.');
  if (input.shared) {
    if (!input.unit_id) throw badRequest('Choose the unit to share this view with.');
    if (!can(scope, PERMISSIONS.CREATE_SHARED_WORK, input.unit_id)) throw forbidden('You cannot share a view with that unit.');
  }
  const config = JSON.stringify(input.config ?? {}).slice(0, 8000);
  const at = now();
  if (input.id) {
    const existing = ctx.db.prepare('SELECT * FROM work_views WHERE id = ?').get(input.id) as { user_id: string } | undefined;
    if (!existing) throw notFound('No such view.');
    if (existing.user_id !== user.id) throw forbidden('That view belongs to someone else.');
    ctx.db.prepare('UPDATE work_views SET name = ?, unit_id = ?, shared = ?, config = ?, updated_at = ? WHERE id = ?')
      .run(name, input.unit_id || null, input.shared ? 1 : 0, config, at, input.id);
    return ctx.db.prepare('SELECT * FROM work_views WHERE id = ?').get(input.id);
  }
  const id = newId();
  ctx.db.prepare('INSERT INTO work_views (id, user_id, unit_id, name, shared, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, input.unit_id || null, name, input.shared ? 1 : 0, config, at, at);
  return ctx.db.prepare('SELECT * FROM work_views WHERE id = ?').get(id);
}

export function deleteView(ctx: AppContext, user: SessionUser, id: string) {
  const existing = ctx.db.prepare('SELECT user_id FROM work_views WHERE id = ?').get(id) as { user_id: string } | undefined;
  if (!existing) throw notFound('No such view.');
  if (existing.user_id !== user.id) throw forbidden('That view belongs to someone else.');
  ctx.db.prepare('DELETE FROM work_views WHERE id = ?').run(id);
}
