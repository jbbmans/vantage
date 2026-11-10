import { z } from 'zod';
import type { AppContext, SessionUser } from '../context.ts';
import { RECORD_SCHEMAS, type RecordTable } from '../../shared/schemas.ts';
import {
  LINEAGE_LABELS, MOVABLE_TABLES, isDrawnFromWork, isLineageTable, isMovableTable, kindText, movedFields, recordKindOf,
  type KindReading, type LineageTable, type MovableTable,
} from '../../shared/recordKinds.ts';
import { dutyFromActivity, isDecidedDuty } from '../../shared/duty.ts';
import { orgOfUnit, sameInstance, scopeFor } from '../authz/scope.ts';
import { assertFileableProject, canPlace, canPlaceOwnDuty, recordedByOther, type RecordRow } from '../authz/records.ts';
import { TABLES, activityFingerprint, assertCarriesNothingAcross, checkTimeframe, getRecord, mayLeaveInstance, readableRecord } from './records.ts';
import { holdState, type HoldState } from './holds.ts';
import { dutyColumns, dutyCandidates } from './duties.ts';
import { audit } from './audit.ts';
import { parse } from '../lib/http.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';

/**
 * Moving an entry between record types (ADR-0015). An activity that was really an award received or a course completed
 * moves to its own record, and back. Only its owner moves it; nothing moves on its own, and an upgrade moves nothing
 * (John's decision of 2026-10-17: each Marine confirms). One transaction creates the entry in its new type, carries its
 * files and comments across, removes it from the old type, and keeps the row as it stood in record_lineage, from which
 * an undo puts it back exactly.
 */

type Row = RecordRow & Record<string, unknown>;
interface LineageRow { seq: number; id: string; user_id: string; unit_id: string | null; from_table: LineageTable; from_id: string; to_table: LineageTable; to_id: string; snapshot: string; method: 'move' | 'undo'; reason: string | null; moved_by: string; at: string; kept_for_hold_at: string | null }

export interface MoveProblem { code: string; message: string }

/** Activities a financial case's history or a draft still points at. */
const linkedToWork = (ctx: AppContext, id: string) =>
  Boolean(ctx.db.prepare('SELECT 1 FROM work_actions WHERE activity_id = ? UNION ALL SELECT 1 FROM record_drafts WHERE activity_id = ? LIMIT 1').get(id, id));

const holdsFor = (ctx: AppContext, row: Row) => holdState(ctx, orgOfUnit(ctx, row.unit_id) ?? undefined);

/** Duty somebody has reviewed has a review history hanging on it (ADR-0024), whatever its status is now. */
const hasReviewHistory = (ctx: AppContext, id: string) => Boolean(ctx.db.prepare('SELECT 1 FROM duty_reviews WHERE duty_id = ? LIMIT 1').get(id));

/**
 * Why this entry may not move to another record type, or null. Only its owner moves an entry, and only one that is
 * theirs alone: not one drawn from a financial case, not one frozen when a membership ended, not one a legal hold covers,
 * not an award or duty a leader recorded for them, and not duty anybody has reviewed.
 */
export function moveProblem(ctx: AppContext, userId: string, table: LineageTable, row: Row, holds: HoldState = holdsFor(ctx, row)): MoveProblem | null {
  if (row.user_id !== userId) return { code: 'owner_only', message: 'Only the Marine an entry belongs to can move it to another record type.' };
  if (row.deleted_at) return { code: 'deleted', message: 'Restore this entry from the recycle bin before moving it.' };
  if (row.frozen_at) return { code: 'frozen', message: 'This entry was frozen when its unit membership ended, so it stays as it is.' };
  if (table === 'activities' && (isDrawnFromWork(row.fingerprint) || linkedToWork(ctx, row.id))) {
    return { code: 'drawn_from_work', message: 'This entry was drawn from a financial case and stays tied to that case.' };
  }
  if (table === 'awards' && recordedByOther(row)) return { code: 'recorded_by_other', message: 'A leader recorded this award for you, so it stays an award. Ask them if it needs correcting.' };
  if (table === 'duties' && recordedByOther(row)) return { code: 'recorded_by_other', message: 'A leader recorded this duty for you, so it stays duty. Ask them if it needs correcting.' };
  if (table === 'duties' && isDecidedDuty(row.approval_status)) return { code: 'duty_decided', message: 'This duty has been reviewed, so it stays as it was decided.' };
  // Returned, or reopened for another look, it is still duty a reviewer acted on: undoing the move would take that with it.
  if (table === 'duties' && hasReviewHistory(ctx, row.id)) return { code: 'duty_reviewed', message: 'This duty has been reviewed, so it stays in Duty with its review history.' };
  if (holds.instance || holds.types.has(table) || holds.users.has(row.user_id)) return { code: 'legal_hold', message: 'A legal hold covers this entry, so it stays where it is until the hold is released.' };
  return null;
}

const moveBody = z.object({
  to: z.enum([...MOVABLE_TABLES, 'duties']),
  /** The person's corrections to what the entry becomes, such as an award's type or a course's hours. */
  fields: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().trim().max(500).nullish(),
  version: z.number().int().optional(),
});

const rawRow = (ctx: AppContext, table: LineageTable, id: string) => ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown>;
const columnsOf = (ctx: AppContext, table: string) => (ctx.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const requiredOf = (ctx: AppContext, table: string) =>
  new Set((ctx.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>).filter((c) => c.notnull).map((c) => c.name));

// What a correction on a move may not set: a project is filed under by editing the entry, where it is checked against the
// projects the person may file under, and a value type is checked against the instance's own when the entry is edited.
const NOT_CORRECTED = new Set(['project_id', 'dollar_type']);

function insertRow(ctx: AppContext, table: LineageTable, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  try {
    ctx.db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
  } catch (error) {
    if (table === 'activities' && String((error as Error).message).includes('UNIQUE')) throw conflict('An identical activity already exists for that date. Delete one of the two first.', 'duplicate');
    throw error;
  }
}

/**
 * Files and comments go where the entry goes, whoever added them, kept or in the bin. A file the entry already holds there
 * (the same file added twice, once on each side of a move) is binned rather than doubled.
 */
function carry(ctx: AppContext, from: LineageTable, fromId: string, to: LineageTable, toId: string) {
  ctx.db.prepare(`UPDATE attachments SET deleted_at = ? WHERE record_table = ? AND record_id = ? AND deleted_at IS NULL
                     AND sha256 IN (SELECT sha256 FROM attachments WHERE record_table = ? AND record_id = ? AND deleted_at IS NULL)`).run(now(), from, fromId, to, toId);
  ctx.db.prepare('UPDATE attachments SET record_table = ?, record_id = ? WHERE record_table = ? AND record_id = ?').run(to, toId, from, fromId);
  ctx.db.prepare('UPDATE comments SET record_table = ?, record_id = ? WHERE record_table = ? AND record_id = ?').run(to, toId, from, fromId);
}

function writeLineage(ctx: AppContext, l: Omit<LineageRow, 'id' | 'seq' | 'kept_for_hold_at'>) {
  const id = newId();
  ctx.db.prepare(`INSERT INTO record_lineage (id, user_id, unit_id, from_table, from_id, to_table, to_id, snapshot, method, reason, moved_by, at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, l.user_id, l.unit_id, l.from_table, l.from_id, l.to_table, l.to_id, l.snapshot, l.method, l.reason, l.moved_by, l.at);
  return id;
}

function auditMove(ctx: AppContext, undone: boolean, actorId: string, unitId: string | null, from: LineageTable, fromId: string, to: LineageTable, toId: string, ip?: string) {
  // Each end names the other, so the trail of either id says where the entry went or came from.
  audit(ctx, { actor_id: actorId, action: undone ? 'record_move_undone' : 'record_moved', entity: from, entity_id: fromId, unit_id: unitId, detail: `to ${to} ${toId}`, ip });
  audit(ctx, { actor_id: actorId, action: undone ? 'record_move_undone' : 'record_moved', entity: to, entity_id: toId, unit_id: unitId, detail: `from ${from} ${fromId}`, ip });
}

function movable(table: string): MovableTable {
  if (!isMovableTable(table)) throw notFound(table === 'duties' ? 'Duty moves back to Activities only by undoing the move that brought it.' : 'Only activities, awards and training move between record types.');
  return table;
}

/** A record type whose entries have a move history: the movable ones, and duty. */
function inLineage(table: string): LineageTable {
  if (!isLineageTable(table)) throw notFound('Only activities, awards, training and duty have a move history.');
  return table;
}

/** Moves an entry its owner holds to another record type. */
export function moveRecord(ctx: AppContext, user: SessionUser, table: RecordTable, id: string, body: unknown, reqKey: object, ip?: string) {
  const from = movable(table);
  const input = parse(moveBody, body);
  const to = input.to;
  if (to === from) throw badRequest(`It is already in ${LINEAGE_LABELS[to].place}.`);
  if (to === 'duties') {
    if (from !== 'activities') throw badRequest('Only an activity moves to Duty.');
    return moveToDuty(ctx, user, id, input, reqKey, ip);
  }
  // Found and refused as an open would be: nobody learns more about an entry by trying to move it than by opening it.
  const row = readableRecord(ctx, user, from, id, reqKey) as Row;
  const problem = moveProblem(ctx, user.id, from, row);
  if (problem) throw forbidden(problem.message, problem.code);
  if (input.version !== undefined && input.version !== row.version) throw conflict('This entry changed while you were looking at it. Reload to see the latest version.', 'stale');
  const scope = scopeFor(ctx, user, reqKey);
  if (!canPlace(scope, row.visibility, row.unit_id, TABLES[to].shareFlag, true)) {
    throw forbidden('You no longer serve in this entry’s unit. Move it to a unit you serve in first.', 'placement');
  }

  // What it becomes: the fields that carry across, then the person's corrections, checked as a new record of that type is.
  const spec = TABLES[to];
  // A field it must have is left to what the move gives it when the correction clears it.
  const required = requiredOf(ctx, to);
  const corrections = Object.fromEntries(Object.entries(input.fields || {})
    .filter(([k, v]) => spec.fields.includes(k) && !NOT_CORRECTED.has(k) && !(required.has(k) && (v === null || v === ''))));
  const data = parse(RECORD_SCHEMAS[to] as never, { ...movedFields(from, row, to), ...corrections }) as Record<string, unknown>;
  checkTimeframe(to, data);
  const at = now();
  const toId = newId();
  const created: Record<string, unknown> = { id: toId, user_id: row.user_id, unit_id: row.unit_id, visibility: row.visibility, created_at: row.created_at, updated_at: at };
  for (const f of spec.fields) if (data[f] !== undefined) created[f] = spec.json.includes(f) ? JSON.stringify(data[f] ?? []) : data[f];
  // An award its owner moves in is theirs; an activity moved in is one its owner has said is work they did.
  if (to === 'awards') created.recorded_by = user.id;
  if (to === 'activities') { created.fingerprint = activityFingerprint(row.user_id, data as never); created.kind_confirmed_at = at; }

  const snapshot = JSON.stringify(rawRow(ctx, from, id));
  let lineageId = '';
  ctx.db.transaction(() => {
    insertRow(ctx, to, created);
    carry(ctx, from, id, to, toId);
    ctx.db.prepare(`DELETE FROM ${from} WHERE id = ?`).run(id);
    lineageId = writeLineage(ctx, { user_id: row.user_id, unit_id: row.unit_id, from_table: from, from_id: id, to_table: to, to_id: toId, snapshot, method: 'move', reason: input.reason || null, moved_by: user.id, at });
    auditMove(ctx, false, user.id, row.unit_id, from, id, to, toId, ip);
  })();
  return { table: to, id: toId, lineage_id: lineageId, record: getRecord(ctx, to, toId) };
}

/** Every move in an entry's history, newest first: a chain of moves and undos ends in this one record. */
function lineageOf(ctx: AppContext, table: LineageTable, id: string): LineageRow[] {
  const linked = ctx.db.prepare('SELECT rowid AS seq, * FROM record_lineage WHERE (to_table = ? AND to_id = ?) OR (from_table = ? AND from_id = ?)');
  const found = new Map<string, LineageRow>();
  const seen = new Set<string>();
  let frontier: Array<[string, string]> = [[table, id]];
  while (frontier.length && found.size < 500) {
    const next: Array<[string, string]> = [];
    for (const [t, i] of frontier) {
      if (seen.has(`${t}:${i}`)) continue;
      seen.add(`${t}:${i}`);
      for (const l of linked.all(t, i, t, i) as LineageRow[]) {
        if (found.has(l.id)) continue;
        found.set(l.id, l);
        next.push([l.from_table, l.from_id], [l.to_table, l.to_id]);
      }
    }
    frontier = next;
  }
  // Written in order, so a move and its undo in the same millisecond still read in the order they happened.
  return [...found.values()].sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq);
}

/** Puts back the entry this one was moved from, exactly as it was, with the files and comments it has gathered since. */
export function undoMove(ctx: AppContext, user: SessionUser, table: RecordTable, id: string, reqKey: object, ip?: string) {
  const current = inLineage(table);
  const row = readableRecord(ctx, user, current, id, reqKey) as Row;
  const problem = moveProblem(ctx, user.id, current, row);
  if (problem) throw forbidden(problem.message, problem.code);
  const last = lineageOf(ctx, current, id)[0];
  if (!last || last.method !== 'move' || last.to_table !== current || last.to_id !== id) throw conflict('There is no move to undo for this entry.', 'nothing_to_undo');
  // What a legal hold kept after a retention schedule anonymized the entry is evidence, never put back to use.
  if (last.kept_for_hold_at) throw forbidden('This entry was anonymized under its unit’s retention schedule, so its move cannot be undone.', 'kept_for_hold');
  const back = last.from_table;
  if (ctx.db.prepare(`SELECT 1 FROM ${back} WHERE id = ?`).get(last.from_id)) throw conflict('The entry it was moved from is already back.', 'already_restored');
  const scope = scopeFor(ctx, user, reqKey);
  if (!canPlace(scope, row.visibility, row.unit_id, TABLES[back].shareFlag, true)) throw forbidden('You no longer serve in this entry’s unit. Move it to a unit you serve in first.', 'placement');

  let before: Record<string, unknown>;
  try { before = JSON.parse(last.snapshot); } catch { throw conflict('This move’s record of the entry cannot be read, so it cannot be undone.', 'lineage_unreadable'); }
  const at = now();
  const restored: Record<string, unknown> = {};
  for (const c of columnsOf(ctx, back)) if (c in before) restored[c] = before[c];
  // Its content as it was; where it sits now, so an undo never carries what was added here back across a boundary. An
  // activity that was private before it became duty (always shared with its unit) is private again: an undo never
  // leaves it shared wider than its owner had it.
  const visibility = current === 'duties' && before.visibility === 'private' ? 'private' : row.visibility;
  Object.assign(restored, { id: last.from_id, user_id: row.user_id, unit_id: row.unit_id, visibility, version: Number(before.version || 1) + 1, updated_at: at, deleted_at: null, frozen_at: null });
  // Moved back to Activities, it is work its owner did: it is not offered for a move again. Its project is kept only if
  // it is still one its owner may file under, from the unit the entry sits in now.
  if (back === 'activities') {
    restored.kind_confirmed_at = at;
    if (restored.project_id) {
      try { assertFileableProject(ctx, scope, user.id, String(restored.project_id), row.unit_id); } catch { restored.project_id = null; }
    }
  }
  const snapshot = JSON.stringify(rawRow(ctx, current, id));
  ctx.db.transaction(() => {
    insertRow(ctx, back, restored);
    carry(ctx, current, id, back, last.from_id);
    ctx.db.prepare(`DELETE FROM ${current} WHERE id = ?`).run(id);
    writeLineage(ctx, { user_id: row.user_id, unit_id: row.unit_id, from_table: current, from_id: id, to_table: back, to_id: last.from_id, snapshot, method: 'undo', reason: null, moved_by: user.id, at });
    auditMove(ctx, true, user.id, row.unit_id, current, id, back, last.from_id, ip);
  })();
  return { table: back, id: last.from_id, record: getRecord(ctx, back, last.from_id) };
}

const safeParse = (s: string) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * An entry's moves, for anyone who may read it. The rows as they stood before each move are its owner's only: a reader
 * of the entry now is not thereby a reader of what it said before. What a legal hold kept after the entry was anonymized
 * is nobody's to read back here: that the entry moved still shows.
 */
export function recordLineage(ctx: AppContext, user: SessionUser, table: RecordTable, id: string, reqKey: object) {
  const current = inLineage(table);
  const row = readableRecord(ctx, user, current, id, reqKey) as Row;
  const owner = row.user_id === user.id;
  const moves = lineageOf(ctx, current, id);
  const last = moves[0];
  const undoable = Boolean(owner && last && last.method === 'move' && last.to_table === current && last.to_id === id && !last.kept_for_hold_at && !moveProblem(ctx, user.id, current, row));
  return {
    moves: moves.map((l) => ({
      id: l.id, from_table: l.from_table, from_id: l.from_id, to_table: l.to_table, to_id: l.to_id, method: l.method, at: l.at, by_owner: l.moved_by === row.user_id,
      ...(owner && !l.kept_for_hold_at ? { reason: l.reason, before: safeParse(l.snapshot) } : {}),
    })),
    undo: undoable ? { from_table: last.from_table } : null,
  };
}

/**
 * The person's activities that read like an award received or training completed, worked out when asked and never
 * stored (ADR-0015). Leaves out what may not move, and what its owner has said is work they did.
 */
export function moveCandidates(ctx: AppContext, user: SessionUser) {
  const rows = ctx.db.prepare(`SELECT * FROM activities WHERE user_id = ? AND deleted_at IS NULL AND frozen_at IS NULL AND kind_confirmed_at IS NULL
                               ORDER BY date DESC, created_at DESC LIMIT 5000`).all(user.id) as Row[];
  const holds = new Map<string | null, HoldState>();
  const candidates: Array<{ id: string; title: string; date: string | null; result: string | null; reading: KindReading; to: MovableTable }> = [];
  for (const r of rows) {
    if (isDrawnFromWork(r.fingerprint)) continue;
    const reading = recordKindOf(kindText('activities', r));
    if (!reading) continue;
    const org = orgOfUnit(ctx, r.unit_id);
    if (!holds.has(org)) holds.set(org, holdState(ctx, org ?? undefined));
    if (moveProblem(ctx, user.id, 'activities', r, holds.get(org))) continue;
    candidates.push({ id: r.id, title: String(r.title), date: (r.date as string | null) ?? null, result: (r.result as string | null) ?? null, reading, to: reading.kind === 'award' ? 'awards' : 'trainings' });
  }
  return { candidates: candidates.slice(0, 200), total: candidates.length };
}

/** The owner says this entry is work they did: it is no longer offered for a move. */
export function keepAsActivity(ctx: AppContext, user: SessionUser, id: string, reqKey: object, ip?: string) {
  const row = readableRecord(ctx, user, 'activities', id, reqKey) as Row;
  if (row.user_id !== user.id) throw forbidden('Only the Marine an entry belongs to can say what kind of record it is.', 'owner_only');
  if (row.kind_confirmed_at) return { ok: true, id };
  ctx.db.prepare('UPDATE activities SET kind_confirmed_at = ? WHERE id = ?').run(now(), id);
  audit(ctx, { actor_id: user.id, action: 'record_kind_confirmed', entity: 'activities', entity_id: id, unit_id: row.unit_id, detail: 'kept as an activity', ip });
  return { ok: true, id };
}

/**
 * An activity its owner says was a duty they stood, moved to Duty (ADR-0023): one transaction, as every move, with its
 * files, comments and lineage, and an undo. The owner gives what an activity does not hold: the duty type, the times,
 * and the unit it was stood for (one they serve in, inside the Unit Instance the activity is in). It is worked out and
 * scored as a duty recorded now is, and submitted for review.
 */
function moveToDuty(ctx: AppContext, user: SessionUser, id: string, input: z.infer<typeof moveBody>, reqKey: object, ip?: string) {
  const row = readableRecord(ctx, user, 'activities', id, reqKey) as Row;
  const problem = moveProblem(ctx, user.id, 'activities', row);
  if (problem) throw forbidden(problem.message, problem.code);
  if (input.version !== undefined && input.version !== row.version) throw conflict('This entry changed while you were looking at it. Reload to see the latest version.', 'stale');
  const scope = scopeFor(ctx, user, reqKey);
  const spec = TABLES.duties;
  const given = input.fields || {};
  const corrections = Object.fromEntries(Object.entries(given).filter(([k]) => spec.fields.includes(k)));
  const unitId = (typeof given.unit_id === 'string' && given.unit_id) || row.unit_id || scope.homeUnitId || null;
  if (!unitId || !ctx.db.prepare('SELECT 1 FROM units WHERE id = ? AND active = 1').get(unitId)) throw badRequest('Choose the unit this duty was stood for.', { fieldErrors: { unit_id: 'Required.' } });
  if (!canPlaceOwnDuty(scope, unitId)) throw forbidden('Duty is recorded in a unit you serve in.', 'placement');
  // What others added to the entry stays in the Unit Instance it was added in (ADR-0008): an entry in a unit stays in its
  // instance, and one in no unit takes nobody else's comments or files into an instance they were not added in, as an
  // edit that shares it there would not.
  if (row.unit_id && !sameInstance(ctx, row.unit_id, unitId)) throw forbidden('This entry stays in its Unit Instance. Record the duty in a unit there.', 'cross_instance');
  if (mayLeaveInstance(ctx, (row.unit_id as string | null) ?? null, unitId)) assertCarriesNothingAcross(ctx, 'activities', row as unknown as RecordRow, unitId);
  const data = parse(RECORD_SCHEMAS.duties as never, { ...dutyFromActivity(row), ...corrections }) as Record<string, unknown>;
  checkTimeframe('duties', data);
  const derived = dutyColumns(ctx, { ...data, unit_id: unitId }, { typeChanged: true });
  const at = now();
  const toId = newId();
  const created: Record<string, unknown> = { id: toId, user_id: row.user_id, unit_id: unitId, visibility: 'unit', created_at: row.created_at, updated_at: at, recorded_by: user.id, submitted_at: at, approval_status: 'pending' };
  for (const f of spec.fields) if (data[f] !== undefined) created[f] = spec.json.includes(f) ? JSON.stringify(data[f] ?? []) : data[f];
  for (const [k, v] of Object.entries(derived)) created[k] = k === 'conditions' ? JSON.stringify(v ?? []) : v;
  const snapshot = JSON.stringify(rawRow(ctx, 'activities', id));
  let lineageId = '';
  ctx.db.transaction(() => {
    insertRow(ctx, 'duties', created);
    carry(ctx, 'activities', id, 'duties', toId);
    ctx.db.prepare('DELETE FROM activities WHERE id = ?').run(id);
    lineageId = writeLineage(ctx, { user_id: row.user_id, unit_id: unitId, from_table: 'activities', from_id: id, to_table: 'duties', to_id: toId, snapshot, method: 'move', reason: input.reason || null, moved_by: user.id, at });
    auditMove(ctx, false, user.id, unitId, 'activities', id, 'duties', toId, ip);
  })();
  return { table: 'duties' as const, id: toId, lineage_id: lineageId, record: getRecord(ctx, 'duties', toId) };
}

/** The person's activities that read like duty they stood, for them to move to Duty or keep (ADR-0023). */
export const dutyMoveCandidates = (ctx: AppContext, user: SessionUser) => dutyCandidates(ctx, user, (r, holds) => moveProblem(ctx, user.id, 'activities', r, holds));
