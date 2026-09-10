import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, isMember, PERMISSIONS } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { zonedDay } from '../lib/clock.ts';

/**
 * The workbench: rows of work, who has picked them up, and what they did about them.
 *
 * Two rules matter more than the rest here.
 *
 * Claiming is decided by the server. A claim is how a team of people avoids two of them working
 * the same case, so a client that hides a button has decided nothing. Every claim, release and
 * state change re-reads the row inside a transaction and refuses if someone got there first.
 *
 * Picking up work is not an accomplishment. Claiming a row, opening it, or editing a cell records
 * activity, never credit. Credit comes from a work action: something a person did that changed the
 * state of the world, with the outcome they can name.
 */

export interface WorkItemRow {
  id: string; unit_id: string | null; owner_id: string; visibility: string;
  source_file_id: string | null; import_job_id: string | null;
  natural_key: string; row_hash: string; source_row: number | null;
  title: string; reference: string | null; due_date: string | null;
  amount: number | null; amount_type: string | null; quantity: number | null; unit_label: string | null;
  state: string; data: string;
  claimed_by: string | null; claimed_at: string | null; resolved_at: string | null; source_changed_at: string | null;
  version: number; deleted_at: string | null; created_at: string; updated_at: string;
}

export const WORK_STATES = ['open', 'in_progress', 'waiting', 'resolved', 'not_applicable'] as const;
export type WorkState = (typeof WORK_STATES)[number];

const hydrate = (row: WorkItemRow) => ({ ...row, data: JSON.parse(row.data || '{}') as Record<string, string> });

function readable(scope: Scope, user: SessionUser, row: WorkItemRow): boolean {
  if (row.owner_id === user.id || row.claimed_by === user.id) return true;
  if (row.visibility !== 'unit' || !row.unit_id) return false;
  return isMember(scope, row.unit_id);
}

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
  claimed?: 'me' | 'anyone' | 'nobody' | null;
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

  // Scope is decided here, from the session, never from anything the client sends.
  const visibility = readableUnits.length
    ? `(w.owner_id = ? OR w.claimed_by = ? OR (w.visibility = 'unit' AND w.unit_id IN (${readableUnits.map(() => '?').join(',')})))`
    : '(w.owner_id = ? OR w.claimed_by = ?)';
  where.push(visibility);
  params.push(user.id, user.id, ...readableUnits);

  if (opts.unitId) { where.push('w.unit_id = ?'); params.push(opts.unitId); }
  if (opts.state) { where.push('w.state = ?'); params.push(opts.state); }
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
    // Nulls last, so rows with no due date do not crowd the top of a due-date sort.
    `SELECT * FROM work_items w WHERE ${clause} ORDER BY (w.${column} IS NULL), w.${column} ${direction}, w.natural_key ASC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as WorkItemRow[];

  return { total, limit, offset, items: rows.map(hydrate) };
}

/** Everything a person needs to decide whether to pick a row up, in one read. */
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
  return { item: hydrate(row), actions, source, contributors: contributors(ctx, id) };
}

/**
 * Who moved this work, and what each of them produced.
 *
 * A contribution is measured by what a person's actions delivered, so a row that four people
 * touched credits each of them with their own outcome and never with each other's.
 */
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

/** Claims a row for the caller. Refuses if someone else holds it, or if the row moved under them. */
export function claimItem(ctx: AppContext, user: SessionUser, scope: Scope, id: string, expectedVersion: number | null) {
  return ctx.db.transaction(() => {
    const row = reload(ctx, id);
    if (!readable(scope, user, row)) throw forbidden('That work is not yours to claim.');
    if (expectedVersion != null && row.version !== expectedVersion) throw conflict('This row changed while you were looking at it. Reload and try again.');
    if (row.claimed_by && row.claimed_by !== user.id) {
      const holder = ctx.db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(row.claimed_by) as { first_name: string; last_name: string } | undefined;
      throw conflict(holder ? `${holder.first_name} ${holder.last_name} already picked this up.` : 'Someone else already picked this up.');
    }
    if (row.state === 'resolved') throw conflict('This work is already resolved.');
    const at = now();
    ctx.db.prepare(
      `UPDATE work_items SET claimed_by = ?, claimed_at = ?, state = CASE WHEN state = 'open' THEN 'in_progress' ELSE state END, version = version + 1, updated_at = ? WHERE id = ?`
    ).run(user.id, at, at, id);
    return hydrate(reload(ctx, id));
  })();
}

export function releaseItem(ctx: AppContext, user: SessionUser, scope: Scope, id: string, expectedVersion: number | null) {
  return ctx.db.transaction(() => {
    const row = reload(ctx, id);
    if (!readable(scope, user, row)) throw forbidden('That work is not yours.');
    if (expectedVersion != null && row.version !== expectedVersion) throw conflict('This row changed while you were looking at it. Reload and try again.');
    const mayTakeBack = row.claimed_by === user.id || (row.unit_id ? can(scope, PERMISSIONS.MANAGE_RECORDS, row.unit_id) : false);
    if (!mayTakeBack) throw forbidden('Only the person holding this work, or a leader who can edit shared records, can release it.');
    const at = now();
    ctx.db.prepare(
      `UPDATE work_items SET claimed_by = NULL, claimed_at = NULL, state = CASE WHEN state = 'in_progress' THEN 'open' ELSE state END, version = version + 1, updated_at = ? WHERE id = ?`
    ).run(at, id);
    return hydrate(reload(ctx, id));
  })();
}

export interface ItemPatch { state?: WorkState; acknowledge_source_change?: boolean }

export function updateItem(ctx: AppContext, user: SessionUser, scope: Scope, id: string, patch: ItemPatch, expectedVersion: number | null) {
  return ctx.db.transaction(() => {
    const row = reload(ctx, id);
    if (!readable(scope, user, row)) throw forbidden('That work is not yours.');
    if (expectedVersion != null && row.version !== expectedVersion) throw conflict('This row changed while you were looking at it. Reload and try again.');
    const mayEdit = row.claimed_by === user.id || row.owner_id === user.id || (row.unit_id ? can(scope, PERMISSIONS.MANAGE_RECORDS, row.unit_id) : false);
    if (!mayEdit) throw forbidden('Pick this work up before changing it.');

    const at = now();
    const sets: string[] = ['version = version + 1', 'updated_at = ?'];
    const params: unknown[] = [at];
    if (patch.state) {
      if (!WORK_STATES.includes(patch.state)) throw badRequest('That is not a state a work item can be in.');
      sets.push('state = ?'); params.push(patch.state);
      sets.push('resolved_at = ?'); params.push(patch.state === 'resolved' ? at : null);
    }
    if (patch.acknowledge_source_change) { sets.push('source_changed_at = NULL'); }
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
  /** Also write this action into the person's own record, so doing the work builds the record of it. */
  draft_record?: boolean;
  /** Resolve the item in the same breath. */
  resolve?: boolean;
  category?: string | null;
  eval_area?: string | null;
}

export const ACTION_KINDS = ['worked', 'contacted', 'escalated', 'corrected', 'reconciled', 'validated', 'resolved', 'noted'] as const;

/**
 * Records something a person did about a work item, and optionally the personal record that
 * follows from it. This is the join the whole product exists for: using Vantage to do the work
 * produces the record of the work, without anyone retyping it.
 */
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
    // A retried request returns what the first one did rather than counting the work twice.
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
    // Recording work you did needs you to be doing it. A leader who can edit shared records may also act.
    const mayAct = row.claimed_by === user.id || row.owner_id === user.id || (row.unit_id ? can(scope, PERMISSIONS.MANAGE_RECORDS, row.unit_id) : false);
    if (!mayAct) throw forbidden('Pick this work up before recording what you did.');

    const at = now();
    let activityId: string | null = null;

    if (input.draft_record) {
      // The drafted record is the person's own, and starts private unless the work itself is shared.
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
        // The fingerprint ties the record to the work item, so the same action cannot draft two records.
        `work:${itemId}:${scopedKey || newId()}`,
        at, at,
      );
    }

    const actionId = newId();
    ctx.db.prepare(
      `INSERT INTO work_actions (id, work_item_id, user_id, unit_id, kind, note, occurred_at, quantity, unit_label, dollar_amount, dollar_type, activity_id, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(actionId, itemId, user.id, row.unit_id, kind, note, occurredAt, quantity, input.unit_label || null, dollarAmount, input.dollar_type || null, activityId, scopedKey, at);

    if (input.resolve || kind === 'resolved') {
      ctx.db.prepare(`UPDATE work_items SET state = 'resolved', resolved_at = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(at, at, itemId);
    } else {
      ctx.db.prepare(`UPDATE work_items SET state = CASE WHEN state = 'open' THEN 'in_progress' ELSE state END, version = version + 1, updated_at = ? WHERE id = ?`).run(at, itemId);
    }

    const action = ctx.db.prepare('SELECT * FROM work_actions WHERE id = ?').get(actionId) as Record<string, unknown>;
    return { action, item: hydrate(reload(ctx, itemId)), activity_id: activityId, replayed: false };
  })();
}

/** Saved arrangements of the workbench. A shared view needs the authority to post work to that unit. */
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
