import type { AppContext, SessionUser } from '../context.ts';
import { PERMISSIONS, can, detailUnitsFor, orgOfUnit, type Scope } from '../authz/scope.ts';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { parse } from '../lib/http.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { heldUsersClause, holdState, recordDispositionRun, type HoldState } from './holds.ts';
import { personnelAccess } from './personnelRecords.ts';
import { TABLES } from './records.ts';
import { counselingTypeLabel } from '../../shared/counseling.ts';
import {
  ASSIGNMENT_DRAFT_FIELDS, DRAFT_ACTIVE_DAYS, DRAFT_KEPT_DAYS, DRAFT_LIMIT, DRAFT_PAYLOAD_BYTES, DRAFT_TEXT_CHARS, FORM_DRAFT_TABLE,
  formDraftCreateSchema, formDraftUpdateSchema, keptUntil,
  type DraftItem, type DraftKind, type DraftsResponse, type FormDraft, type FormDraftKind,
} from '../../shared/drafts.ts';

/**
 * Drafts (Task 23, ADR-0030). A draft lives with its own kind, never in a second copy. The forms a person saves to finish
 * later, which before had nowhere to be kept, are kept here (`form_drafts`), each its author's alone: anyone else is
 * answered as if it did not exist. A form is not a record. Nothing counts it, lists it to anyone else or tells anyone of it,
 * and it is checked loosely, because the form it came from checks it when it is sent through its own route
 * (`consumeDraft`), which removes it in the same transaction. A draft about a Marine, an award recommendation or a change to
 * their assignment, names the Marine and the unit, and is saved only by someone who may act for them there.
 *
 * `listAllDrafts` reads every kind of draft for the person asking, from where each is kept, and stores nothing.
 */

interface Row {
  id: string; user_id: string; kind: FormDraftKind; subject_id: string | null; subject_label: string | null; unit_id: string | null;
  title: string; payload: string; version: number; deleted_at: string | null; created_at: string; updated_at: string;
}

type Value = string | number | boolean | null;

const ASSIGNMENT_WORDS: Record<string, string> = {
  billet: 'billet', billet_id: 'billet', primary: 'primary unit', assignment_start: 'assignment dates', assignment_end: 'assignment dates',
  supervisor_id: 'supervisor', checked_in_on: 'check-in',
};

const KIND_PLACE: Record<FormDraftKind, string> = { goal: 'Goals', award: 'Awards', training: 'Training', task: 'Tasks', personnel_change: 'Personnel' };
const UNTITLED: Record<FormDraftKind, string> = { goal: 'Goal (no title yet)', award: 'Award (no name yet)', training: 'Training (no title yet)', task: 'Task (no title yet)', personnel_change: 'Assignment change' };

/** "Sgt Jane Doe". */
function namesOf(ctx: AppContext, ids: string[]): Map<string, string> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = ctx.db.prepare(`SELECT u.id, u.first_name, u.last_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(unique)) as Array<{ id: string; first_name: string | null; last_name: string | null; abbr: string | null }>;
  return new Map(rows.map((r) => [r.id, [r.abbr, r.first_name, r.last_name].filter(Boolean).join(' ').trim()]));
}

function rowOf(ctx: AppContext, userId: string, id: string): Row {
  const row = ctx.db.prepare('SELECT * FROM form_drafts WHERE id = ? AND deleted_at IS NULL').get(id) as Row | undefined;
  // Another person's draft is no such draft, so a guessed id learns nothing: both are answered the same, as one gone.
  if (!row || row.user_id !== userId) throw new HttpError(404, 'No such draft.', 'draft_gone');
  return row;
}

/** Whether a legal hold keeps a draft: one on the whole service or instance, on drafts, or on its author or its Marine. */
function heldDraft(holds: HoldState, row: Pick<Row, 'user_id' | 'subject_id'>) {
  return holds.instance || holds.types.has('form_drafts') || holds.users.has(row.user_id) || Boolean(row.subject_id && holds.users.has(row.subject_id));
}

/**
 * A draft discarded or sent leaves its author's drafts. Removed, unless a legal hold keeps it: then it is hidden, kept as
 * it was, and removed by the sweep once the hold is released.
 */
function removeDraft(ctx: AppContext, row: Row) {
  const gone = heldDraft(holdState(ctx), row)
    ? ctx.db.prepare('UPDATE form_drafts SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL').run(now(), row.id, row.user_id).changes
    : ctx.db.prepare('DELETE FROM form_drafts WHERE id = ? AND user_id = ? AND deleted_at IS NULL').run(row.id, row.user_id).changes;
  if (gone !== 1) throw conflict('That draft was already sent or discarded.', 'draft_gone');
}

/** Where its author may act for a draft's Marine: the units, or why nowhere. Asked when it is saved, read and sent. */
function authorityFor(ctx: AppContext, scope: Scope, actorId: string, kind: FormDraftKind, subjectId: string): string[] {
  if (kind === 'award') return detailUnitsFor(ctx, scope, subjectId).filter((u) => can(scope, PERMISSIONS.COUNSEL, u));
  if (kind === 'personnel_change') return personnelAccess(ctx, scope, actorId, subjectId).manageIn;
  return [];
}

const LOST: Partial<Record<FormDraftKind, string>> = {
  award: 'You can no longer recommend an award for this Marine in that unit. You can still read or discard this draft.',
  personnel_change: 'You can no longer change this Marine’s assignment in that unit. You can still read or discard this draft.',
};

/** Whether its author may still send a draft, and why not. A draft of their own kind of record always may. */
function standing(ctx: AppContext, scope: Scope, row: Pick<Row, 'kind' | 'subject_id' | 'unit_id' | 'user_id'>): { can_submit: boolean; blocked: string | null } {
  if (!row.subject_id || !row.unit_id) return { can_submit: true, blocked: null };
  const ok = authorityFor(ctx, scope, row.user_id, row.kind, row.subject_id).includes(row.unit_id);
  return ok ? { can_submit: true, blocked: null } : { can_submit: false, blocked: LOST[row.kind] ?? 'You can no longer send this draft.' };
}

/**
 * The unit a draft about a Marine is saved in, once its author is found to be able to act for them there. The refusals
 * are the ones the kind's own route gives, so a draft learns nothing about a Marine that sending the form would not.
 */
function placeAbout(ctx: AppContext, scope: Scope, actorId: string, kind: FormDraftKind, subjectId: string, asked: string | null): string {
  if (kind === 'award') {
    const units = authorityFor(ctx, scope, actorId, kind, subjectId);
    if (!units.length) throw forbidden('You cannot recommend an award for that Marine.');
    return asked && units.includes(asked) ? asked : units[0];
  }
  if (!asked) throw badRequest('Name the unit this change is made in.', { fieldErrors: { unit_id: 'Required.' } });
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, asked)) throw forbidden('You cannot manage members in that unit.');
  if (!ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(subjectId, asked)) throw notFound('That Marine is not a member of this unit.');
  if (!authorityFor(ctx, scope, actorId, kind, subjectId).includes(asked)) throw forbidden('You cannot change the membership of a Marine at or above your own position.', 'hierarchy');
  return asked;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function value(field: string, v: unknown): Value {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw badRequest('Enter a number.', { fieldErrors: { [field]: 'Enter a number.' } });
    return v;
  }
  if (typeof v === 'string') {
    if (v.length > DRAFT_TEXT_CHARS) throw badRequest(`Keep this under ${DRAFT_TEXT_CHARS.toLocaleString('en-US')} characters.`, { fieldErrors: { [field]: 'Too long to keep.' } });
    return v;
  }
  throw badRequest('This form holds a value a draft cannot keep.', { fieldErrors: { [field]: 'Not a value this form takes.' } });
}

/** A goal's filters, the one field a form keeps as an object: names to plain values, as the goal's own form takes them. */
function filters(field: string, v: unknown): Record<string, string | null> | null {
  if (v === null || v === undefined) return null;
  const refused = () => badRequest('This form holds a value a draft cannot keep.', { fieldErrors: { [field]: 'Not a value this form takes.' } });
  if (!isObject(v) || Object.keys(v).length > 40) throw refused();
  for (const [k, x] of Object.entries(v)) if (k.length > 40 || !(x === null || (typeof x === 'string' && x.length <= 200))) throw refused();
  return v as Record<string, string | null>;
}

const filledIn = (v: unknown) => v !== null && v !== undefined && v !== '' && v !== false && !(isObject(v) && !Object.keys(v).length) && !(Array.isArray(v) && !v.length);

/**
 * What of a form a draft keeps: the kind's own fields and nothing else, each a plain value (a goal's filters as they are),
 * within bounds. Values are checked properly when the form is sent; here only that they are a form's values.
 */
function cleanPayload(kind: FormDraftKind, raw: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'personnel_change') {
    const asked = isObject(raw.changes) ? raw.changes : {};
    const changes: Record<string, Value> = {};
    for (const f of ASSIGNMENT_DRAFT_FIELDS) if (f in asked) changes[f] = value(f, asked[f]);
    if (!Object.keys(changes).some((f) => f !== 'reason')) throw badRequest('Change something before saving it as a draft.');
    const label = typeof raw.supervisor_label === 'string' ? raw.supervisor_label.trim().slice(0, 200) : null;
    return { changes, ...(label ? { supervisor_label: label } : {}) };
  }
  const spec = TABLES[FORM_DRAFT_TABLE[kind]];
  // A task's or a goal's assignment note is kept with it, and written when the form is sent (ADR-0031).
  const allowed = new Set<string>([...spec.fields, 'visibility', 'unit_id', ...(kind === 'task' || kind === 'goal' ? ['assignment_note'] : [])]);
  const json = new Set<string>(spec.json);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!allowed.has(k)) continue;
    out[k] = json.has(k) ? filters(k, v) : value(k, v);
  }
  if (!Object.entries(out).some(([k, v]) => k !== 'visibility' && k !== 'unit_id' && filledIn(v))) throw badRequest('Fill in something before saving it as a draft.');
  return out;
}

/** What an assignment held, in the fields a draft changes, when the draft was saved: so its author sees what moved since. */
function assignmentNow(ctx: AppContext, subjectId: string, unitId: string, fields: string[]): Record<string, Value> {
  const m = ctx.db.prepare('SELECT billet, billet_id, is_primary, assignment_start, assignment_end FROM unit_members WHERE user_id = ? AND unit_id = ?').get(subjectId, unitId) as
    { billet: string | null; billet_id: string | null; is_primary: number; assignment_start: string | null; assignment_end: string | null } | undefined;
  const orgId = orgOfUnit(ctx, unitId);
  const p = orgId ? ctx.db.prepare('SELECT supervisor_id, checked_in_on FROM personnel_records WHERE org_id = ? AND user_id = ?').get(orgId, subjectId) as { supervisor_id: string | null; checked_in_on: string | null } | undefined : undefined;
  const all: Record<string, Value> = {
    billet: m?.billet ?? null, billet_id: m?.billet_id ?? null, primary: Boolean(m?.is_primary), assignment_start: m?.assignment_start ?? null,
    assignment_end: m?.assignment_end ?? null, supervisor_id: p?.supervisor_id ?? null, checked_in_on: p?.checked_in_on ?? null,
  };
  return Object.fromEntries(fields.filter((f) => f in all).map((f) => [f, all[f]]));
}

function titleOf(kind: FormDraftKind, payload: Record<string, unknown>): string {
  if (kind === 'personnel_change') {
    const changed = [...new Set(Object.keys((payload.changes as Record<string, unknown>) || {}).map((f) => ASSIGNMENT_WORDS[f]).filter(Boolean))];
    return changed.length ? `Assignment change: ${changed.join(', ')}` : UNTITLED[kind];
  }
  const named = kind === 'award' ? payload.name : payload.title;
  const text = typeof named === 'string' ? named.replace(/\s+/g, ' ').trim() : '';
  return (text || UNTITLED[kind]).slice(0, 300);
}

function sized(payload: Record<string, unknown>): string {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text, 'utf8') > DRAFT_PAYLOAD_BYTES) throw new HttpError(400, 'This draft is too long to keep. Shorten it, or finish the form and save it.', 'draft_too_large');
  return text;
}

function shaped(ctx: AppContext, scope: Scope, row: Row): FormDraft {
  let payload: Record<string, unknown> = {};
  try { const parsed = JSON.parse(row.payload); if (isObject(parsed)) payload = parsed; } catch { /* kept as an empty form */ }
  const status = standing(ctx, scope, row);
  // What a Marine's assignment held is read from their record, so it is shown only while its author may still read it:
  // what they wrote stays theirs to read, what the record said does not.
  if (!status.can_submit) delete payload.was;
  return {
    id: row.id, kind: row.kind, subject_id: row.subject_id, subject_label: row.subject_label, unit_id: row.unit_id, title: row.title, payload,
    version: row.version, created_at: row.created_at, updated_at: row.updated_at, kept_until: keptUntil(row.updated_at), ...status,
  };
}

/** A form saved to finish later: kept for its author alone, about a Marine only where they may act for them. */
export function createFormDraft(ctx: AppContext, user: SessionUser, scope: Scope, body: unknown, ip?: string): FormDraft {
  const input = parse(formDraftCreateSchema, body);
  const kind = input.kind;
  const subjectId = input.subject_id && input.subject_id !== user.id ? input.subject_id : null;
  if (kind === 'personnel_change' && !subjectId) {
    if (input.subject_id === user.id) throw forbidden('A second authorized person must change your own assignment.', 'self_membership_change');
    throw badRequest('Name the Marine this change is for.', { fieldErrors: { subject_id: 'Required.' } });
  }
  if (subjectId && kind !== 'award' && kind !== 'personnel_change') throw badRequest('Only an award recommendation or a personnel change is drafted for someone else.');
  const unitId = subjectId ? placeAbout(ctx, scope, user.id, kind, subjectId, input.unit_id ?? null) : null;
  const payload = cleanPayload(kind, input.payload);
  if (kind === 'personnel_change') payload.was = assignmentNow(ctx, subjectId!, unitId!, Object.keys(payload.changes as object));
  // A recommendation's unit is the one it was placed in, where its author may counsel the Marine; its form says the same,
  // so opened again and sent, it names the unit the draft is for.
  if (kind === 'award' && unitId) payload.unit_id = unitId;
  const text = sized(payload);
  const label = subjectId ? (namesOf(ctx, [subjectId]).get(subjectId) || 'A Marine').slice(0, 200) : null;
  const id = newId();
  const at = now();
  ctx.db.transaction(() => {
    const held = (ctx.db.prepare('SELECT COUNT(*) AS n FROM form_drafts WHERE user_id = ? AND deleted_at IS NULL').get(user.id) as { n: number }).n;
    if (held >= DRAFT_LIMIT) throw conflict(`You have ${DRAFT_LIMIT} saved drafts. Finish or discard some before saving another.`, 'draft_quota');
    ctx.db.prepare('INSERT INTO form_drafts (id, user_id, kind, subject_id, subject_label, unit_id, title, payload, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, user.id, kind, subjectId, label, unitId, titleOf(kind, payload), text, at, at);
  })();
  // Never with the Marine as its subject: a draft about them is its author's, and their own trail does not carry it.
  audit(ctx, { actor_id: user.id, action: 'save_draft', entity: 'form_drafts', entity_id: id, detail: `${kind}, new`, ip });
  return shaped(ctx, scope, rowOf(ctx, user.id, id));
}

export function readFormDraft(ctx: AppContext, user: SessionUser, scope: Scope, id: string): FormDraft {
  return shaped(ctx, scope, rowOf(ctx, user.id, id));
}

/** Saved again, over the version its author last read; another window's save is not overwritten. */
export function updateFormDraft(ctx: AppContext, user: SessionUser, scope: Scope, id: string, body: unknown, ip?: string): FormDraft {
  const input = parse(formDraftUpdateSchema, body);
  const row = rowOf(ctx, user.id, id);
  const status = standing(ctx, scope, row);
  if (!status.can_submit) throw forbidden(status.blocked!, 'draft_authority');
  const payload = cleanPayload(row.kind, input.payload);
  if (row.kind === 'personnel_change') payload.was = assignmentNow(ctx, row.subject_id!, row.unit_id!, Object.keys(payload.changes as object));
  // Its unit was fixed when it was created.
  if (row.kind === 'award' && row.unit_id) payload.unit_id = row.unit_id;
  const text = sized(payload);
  const label = row.subject_id ? (namesOf(ctx, [row.subject_id]).get(row.subject_id) || row.subject_label) : null;
  const done = ctx.db.prepare('UPDATE form_drafts SET title = ?, payload = ?, subject_label = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ? AND deleted_at IS NULL')
    .run(titleOf(row.kind, payload), text, label, now(), id, user.id, input.version).changes;
  if (!done) throw conflict('This draft was saved in another window since you opened it. Reload it to see that version.', 'stale', { current: readFormDraft(ctx, user, scope, id) });
  audit(ctx, { actor_id: user.id, action: 'save_draft', entity: 'form_drafts', entity_id: id, detail: row.kind, ip });
  return readFormDraft(ctx, user, scope, id);
}

/** Discarded, it is gone from its author's drafts: there is no recycle bin for a form nobody sent. */
export function discardFormDraft(ctx: AppContext, user: SessionUser, id: string, ip?: string) {
  const row = rowOf(ctx, user.id, id);
  removeDraft(ctx, row);
  audit(ctx, { actor_id: user.id, action: 'discard_draft', entity: 'form_drafts', entity_id: id, detail: row.kind, ip });
}

/** The draft a submit names (`?draft=<id>&draft_version=<n>`), if any. */
export interface DraftRef { id: string; version: number }

/**
 * A form sent from its draft: the kind's own route does everything it always does (`run`), and the draft is removed in
 * the same transaction, so the record is then the only copy, and any refusal leaves the draft as it was and creates
 * nothing. The draft must be the sender's (any other is no such draft), as they last read it, for this form, about this
 * Marine and in this unit, and its author must still be able to act for that Marine there: a draft never sends a record
 * somewhere its author was told it could not go.
 */
export function consumeDraft<T>(ctx: AppContext, user: SessionUser, scope: Scope, ref: DraftRef, expect: { kind: FormDraftKind; subjectId: string | null; unitId?: string | null }, run: () => T): T {
  return ctx.db.transaction(() => {
    const row = rowOf(ctx, user.id, ref.id);
    if (row.kind !== expect.kind) throw conflict('That draft is for a different form. Open it from Drafts.', 'draft_mismatch');
    if ((row.subject_id ?? null) !== (expect.subjectId ?? null)) throw conflict('That draft is about a different Marine. Open it from Drafts.', 'draft_mismatch');
    if (row.subject_id && expect.unitId !== undefined && (expect.unitId ?? null) !== row.unit_id) throw conflict('That draft is for a different unit. Open it from Drafts.', 'draft_mismatch');
    if (row.version !== ref.version) throw conflict('This draft was saved in another window since you opened it. Reload it before sending it.', 'draft_changed', { current: shaped(ctx, scope, row) });
    const status = standing(ctx, scope, row);
    if (!status.can_submit) throw forbidden(status.blocked!, 'draft_authority');
    const out = run();
    removeDraft(ctx, row);
    return out;
  })();
}

/** The draft a submit names, if any. One named without the version its sender read is refused: it might be overwritten. */
export function draftParam(query: unknown): DraftRef | null {
  const v = isObject(query) ? query.draft : undefined;
  if (v === undefined || v === '') return null;
  if (typeof v !== 'string' || v.length > 64) throw badRequest('Name one draft.');
  const version = Number(isObject(query) ? query.draft_version : NaN);
  if (!Number.isInteger(version) || version < 1) throw badRequest('Say which version of the draft this is.', { code: 'draft_version' });
  return { id: v, version };
}

/** The newest this many of each kind are listed. */
export const SOURCE_LIMIT = 200;
const UNSENT = " AND NOT EXISTS (SELECT 1 FROM thread_messages m WHERE m.thread_id = t.id AND m.direction = 'inbound')";

/**
 * Every draft of the person asking, wherever its kind keeps it, newest first: saved forms, entries from work not yet
 * kept, counselings they are writing that are not final, report packages they are writing with no revision saved, and
 * correspondence they wrote and have not sent. Read from those places each time, so it is never out of step with them.
 * What it says of each: what it is, whom it is about, where it opens, who else can read it now, and whether it can be
 * finished. It never lists a draft about the person that someone else is writing: that is its author's.
 */
export function listAllDrafts(ctx: AppContext, user: SessionUser, scope: Scope): DraftsResponse {
  const db = ctx.db;
  const items: DraftItem[] = [];
  const active = activeSince();
  // Each kind lists its newest SOURCE_LIMIT; one more is read to know whether there are more than that.
  let more = false;
  const capped = <T,>(rows: T[]): T[] => { if (rows.length <= SOURCE_LIMIT) return rows; more = true; return rows.slice(0, SOURCE_LIMIT); };

  const forms = capped(db.prepare('SELECT * FROM form_drafts WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?').all(user.id, SOURCE_LIMIT + 1) as Row[]);
  for (const r of forms) {
    const own = !r.subject_id;
    const href = r.kind === 'goal' ? `/goals?draft=${r.id}`
      : r.kind === 'training' ? `/career/training?draft=${r.id}`
      : r.kind === 'task' ? `/work/tasks?draft=${r.id}`
      : own ? `/career/awards?draft=${r.id}`
      : `/team/${r.subject_id}?draft=${r.id}`;
    items.push({
      key: `form:${r.id}`, id: r.id, source: 'form', kind: r.kind, title: r.title, about: r.subject_label, subject_id: r.subject_id, place: own ? KIND_PLACE[r.kind] : 'Their page on Team',
      href, readers: 'Only you', updated_at: r.updated_at, kept_until: keptUntil(r.updated_at), ...standing(ctx, scope, r), discardable: true, waiting: true,
    });
  }

  const entries = capped(db.prepare('SELECT id, title, updated_at FROM record_drafts WHERE user_id = ? AND deleted_at IS NULL AND activity_id IS NULL ORDER BY updated_at DESC LIMIT ?').all(user.id, SOURCE_LIMIT + 1) as Array<{ id: string; title: string; updated_at: string }>);
  for (const r of entries) {
    items.push({
      key: `entry:${r.id}`, id: r.id, source: 'entry', kind: 'entry', title: r.title, about: null, subject_id: null, place: 'Drafts', href: `/record/drafts?open=${r.id}`,
      readers: 'Only you', updated_at: r.updated_at, kept_until: null, can_submit: true, blocked: null, discardable: true, waiting: true,
    });
  }

  const counselings = capped(db.prepare(`SELECT id, user_id, type, date, stage, updated_at FROM counselings WHERE counselor_id = ? AND user_id <> ? AND stage IN ('draft', 'review') AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?`)
    .all(user.id, user.id, SOURCE_LIMIT + 1) as Array<{ id: string; user_id: string; type: string | null; date: string | null; stage: 'draft' | 'review'; updated_at: string }>);
  // A report package is a working draft until its author stops working on it: a revision is a checkpoint, never final.
  const reports = capped(db.prepare('SELECT id, subject_id, unit_id, visibility, title, latest_revision, updated_at FROM report_drafts WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?')
    .all(user.id, SOURCE_LIMIT + 1) as Array<{ id: string; subject_id: string; unit_id: string | null; visibility: string; title: string; latest_revision: number; updated_at: string }>);
  const names = namesOf(ctx, [...counselings.map((c) => c.user_id), ...reports.map((r) => r.subject_id).filter((s) => s !== user.id)]);
  for (const c of counselings) {
    const who = names.get(c.user_id) || 'the Marine';
    items.push({
      key: `counseling:${c.id}`, id: c.id, source: 'counseling', kind: 'counseling', title: `${counselingTypeLabel(c.type)} counseling${c.date ? `, ${c.date}` : ''}`,
      about: names.get(c.user_id) || null, subject_id: c.user_id, place: 'Counseling', href: `/career/counseling?open=${c.id}`,
      readers: c.stage === 'review' ? `Shared with ${who} to review` : 'Only you', updated_at: c.updated_at, kept_until: null, can_submit: true, blocked: null, discardable: false,
      waiting: c.stage === 'draft',
    });
  }
  for (const r of reports) {
    const about = r.subject_id !== user.id ? names.get(r.subject_id) || 'the Marine' : null;
    const readers = [about ? `${about} can open it` : null, r.visibility === 'unit' && r.unit_id ? 'your unit can open it' : null].filter(Boolean).join(', and ');
    items.push({
      key: `report:${r.id}`, id: r.id, source: 'report', kind: 'report', title: `${r.title} (${r.latest_revision ? `revision ${r.latest_revision}` : 'not saved yet'})`, about, subject_id: about ? r.subject_id : null, place: 'Report packages', href: `/reports?open=${r.id}`,
      readers: readers ? readers.charAt(0).toUpperCase() + readers.slice(1) : 'Only you', updated_at: r.updated_at, kept_until: null, can_submit: true, blocked: null, discardable: false,
      waiting: r.updated_at >= active,
    });
  }

  // Written and not sent: a thread made by bringing in a message someone sent them is in state draft too, and is not one.
  const threads = capped(db.prepare(`SELECT t.id, t.subject, t.unit_id, t.visibility, t.updated_at FROM threads t WHERE t.owner_id = ? AND t.state = 'draft' AND t.deleted_at IS NULL${UNSENT} ORDER BY t.updated_at DESC LIMIT ?`)
    .all(user.id, SOURCE_LIMIT + 1) as Array<{ id: string; subject: string; unit_id: string | null; visibility: string; updated_at: string }>);
  for (const t of threads) {
    items.push({
      key: `correspondence:${t.id}`, id: t.id, source: 'correspondence', kind: 'correspondence', title: t.subject || 'Correspondence (no subject yet)', about: null, subject_id: null,
      place: 'Correspondence', href: `/work/correspondence?thread=${t.id}`, readers: t.visibility === 'unit' && t.unit_id ? 'Your unit can open it' : 'Only you',
      updated_at: t.updated_at, kept_until: null, can_submit: true, blocked: null, discardable: false, waiting: true,
    });
  }

  items.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const counts: Partial<Record<DraftKind, number>> = {};
  for (const i of items) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  // The count waiting is every one, listed or not, so it is the same as the record overview's.
  return { items, counts, total: items.length, waiting: draftCount(ctx, user.id), more, kept_days: DRAFT_KEPT_DAYS, limit: DRAFT_LIMIT, saved: forms.length };
}

/** Report packages worked on since then count as waiting on their author. */
const activeSince = () => new Date(Date.now() - DRAFT_ACTIVE_DAYS * 86_400_000).toISOString();

/** How many drafts are waiting on a person, of every kind: the record overview's count, the same as the Drafts page's. */
export function draftCount(ctx: AppContext, userId: string): number {
  const n = (sql: string, ...params: unknown[]) => (ctx.db.prepare(sql).get(...params) as { n: number }).n;
  return n('SELECT COUNT(*) AS n FROM form_drafts WHERE user_id = ? AND deleted_at IS NULL', userId)
    + n('SELECT COUNT(*) AS n FROM record_drafts WHERE user_id = ? AND deleted_at IS NULL AND activity_id IS NULL', userId)
    + n(`SELECT COUNT(*) AS n FROM counselings WHERE counselor_id = ? AND user_id <> ? AND stage = 'draft' AND deleted_at IS NULL`, userId, userId)
    + n('SELECT COUNT(*) AS n FROM report_drafts WHERE user_id = ? AND deleted_at IS NULL AND updated_at >= ?', userId, activeSince())
    + n(`SELECT COUNT(*) AS n FROM threads t WHERE t.owner_id = ? AND t.state = 'draft' AND t.deleted_at IS NULL${UNSENT}`, userId);
}

/**
 * Saved forms nobody has saved again in DRAFT_KEPT_DAYS are removed, and so are those discarded or sent while a hold kept
 * them, once it no longer does. A legal hold keeps them: an instance-wide hold keeps every one, and a hold on a person
 * keeps those they wrote and those about them. What was removed and what was kept is recorded as a disposition run, and
 * the removal in the audit trail.
 */
export function expireFormDrafts(ctx: AppContext): number {
  const cutoff = new Date(Date.now() - DRAFT_KEPT_DAYS * 86_400_000).toISOString();
  const past = '(deleted_at IS NOT NULL OR updated_at < ?)';
  const due = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM form_drafts WHERE ${past}`).get(cutoff) as { n: number }).n;
  if (!due) return 0;
  const holds = holdState(ctx);
  const why = `saved drafts not saved again in ${DRAFT_KEPT_DAYS} days, or discarded or sent while held`;
  if (holds.instance || holds.types.has('form_drafts')) {
    recordDispositionRun(ctx, { actorId: null, recordType: 'form_drafts', disposition: 'destroy', eligible: due, acted: 0, held: due, detail: `${why}: kept, a legal hold is open` });
    return 0;
  }
  const authors = heldUsersClause(holds, 'user_id');
  const subjects = heldUsersClause(holds, 'subject_id');
  const removed = ctx.db.prepare(`DELETE FROM form_drafts WHERE ${past}${authors.sql}${subjects.sql}`).run(cutoff, ...authors.params, ...subjects.params).changes;
  const held = due - removed;
  recordDispositionRun(ctx, { actorId: null, recordType: 'form_drafts', disposition: 'destroy', eligible: due, acted: removed, held, detail: why });
  if (removed) audit(ctx, { actor_id: null, action: 'drafts_expired', entity: 'form_drafts', detail: `${removed} ${why}${held ? `; ${held} kept under hold` : ''}` });
  return removed;
}
