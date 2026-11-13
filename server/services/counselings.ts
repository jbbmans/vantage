import { z } from 'zod';
import type { AppContext, SessionUser } from '../context.ts';
import { PERMISSIONS, can, detailUnitsFor, scopeFor, type Scope } from '../authz/scope.ts';
import { canEdit, canRead, unfinalized, type RecordRow } from '../authz/records.ts';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { parse } from '../lib/http.ts';
import { newId, now } from '../lib/ids.ts';
import { zonedDay } from '../lib/clock.ts';
import { zoneOf } from '../lib/zone.ts';
import { REDACTED } from '../../shared/constants.ts';
import { DEFAULT_REPORT_MARKING } from '../../shared/reportCatalog.ts';
import { counselingSchema } from '../../shared/schemas.ts';
import {
  COUNSELING_CONTENT, COUNSELING_FIELD_LABELS, COUNSELING_LIMITS, counselingDocument, counselingOptions, counselingTypeLabel, counselorWritten,
  type CounselingAuthority, type CounselingDocument, type CounselingField, type CounselingOptions, type CounselingParticulars, type CounselingRevision, type CounselingStage,
} from '../../shared/counseling.ts';
import { audit } from './audit.ts';
import { notify } from './notifications.ts';

/**
 * Counseling as structured data (Task 20, ADR-0027): a counseling a leader writes for a Marine is drafted, may be shared
 * with that Marine to review, is finalized, and afterwards changes only by an amendment that keeps what it replaced. The
 * Marine acknowledges the text as it stands, and the acknowledgement is bound to the version they read. Its worksheet
 * (NAVMC 2795 layout) is built here from what is stored, never stored itself.
 *
 * Each action takes the version its asker saw. Who may do what is checked before where the counseling stands, so a
 * refusal tells nobody anything they could not already read; a counseling not yet final answers "no such record" to
 * anyone who may not read it. The change, its history and its audit entry are written together or not at all.
 */

type Row = Record<string, unknown>;
export type CounselingRow = Row & RecordRow & {
  stage: CounselingStage; revision: number; version: number; type: string; date: string | null; summary: string;
  acknowledged_at: string | null; finalized_at: string | null; finalized_by: string | null; particulars: string | null; deleted_at: string | null;
};

const counselingRow = (ctx: AppContext, id: string) => ctx.db.prepare('SELECT * FROM counselings WHERE id = ?').get(id) as CounselingRow | undefined;
const anonymized = (row: Row) => row.summary === REDACTED;
const rankName = (p: { abbr?: string | null; first_name?: string | null; last_name?: string | null }) =>
  `${p.abbr ? `${p.abbr} ` : ''}${p.last_name ?? ''}${p.first_name ? `, ${p.first_name}` : ''}`.trim();

/**
 * Whether its counselor still counsels the Marine it is about: Counsel members in a unit the Marine serves in, where the
 * counselor may open their record and outranks them. Writing a counseling took exactly this (createRecord); finalizing,
 * sharing and amending one take it again, so a counselor who has moved on does not finalize or amend what they left.
 */
export function stillCounsels(ctx: AppContext, scope: Scope, counselorId: string, row: Pick<RecordRow, 'user_id' | 'counselor_id'>): boolean {
  if (!row.counselor_id || row.counselor_id !== counselorId || row.user_id === counselorId) return false;
  return detailUnitsFor(ctx, scope, row.user_id).some((u) => can(scope, PERMISSIONS.COUNSEL, u));
}

/** What the reader holds over one counseling (shared/counseling.ts CounselingAuthority). */
export function counselingAuthority(ctx: AppContext, scope: Scope, userId: string, row: RecordRow): CounselingAuthority {
  return {
    counselor: stillCounsels(ctx, scope, userId, row),
    // A records manager corrected a unit-shared counseling before 035; they amend one now. Never one about themselves.
    manager: row.user_id !== userId && row.visibility === 'unit' && Boolean(row.unit_id) && can(scope, PERMISSIONS.MANAGE_RECORDS, row.unit_id),
    subject: row.user_id === userId,
  };
}

export function optionsFor(ctx: AppContext, scope: Scope, userId: string, row: CounselingRow): CounselingOptions {
  const authority = counselorWritten(row) ? counselingAuthority(ctx, scope, userId, row) : { counselor: false, manager: false, subject: row.user_id === userId };
  return counselingOptions(authority, { ...row, anonymized: anonymized(row) }, canEdit(scope, userId, row));
}

/**
 * Whether the reader may add, describe and remove files on a counseling: whoever may edit it, and on a final one its
 * counselor, who still counsels the Marine, so a signed copy of the worksheet can be kept with it. Its words stay as
 * they are; a file is not its text.
 */
export function mayManageCounselingFiles(ctx: AppContext, scope: Scope, userId: string, row: RecordRow): boolean {
  if (canEdit(scope, userId, row)) return true;
  return counselorWritten(row) && row.stage === 'final' && !row.frozen_at && !anonymized(row as unknown as Row) && stillCounsels(ctx, scope, userId, row);
}

/**
 * A counseling as its reader is given it: whom it is about (to its counselor), who counseled (to its Marine), and what
 * the reader may do with it. One lookup for the names, and one authority check per Marine on the page.
 */
export function withCounselingDetail<T extends Row>(ctx: AppContext, viewerId: string, rows: T[], scope: Scope = scopeFor(ctx, { id: viewerId })): Array<T & { subject_name?: string; counselor_display?: string; workflow: CounselingOptions }> {
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap((r) => [String(r.user_id), r.counselor_id ? String(r.counselor_id) : '']).filter((id) => id && id !== viewerId))];
  const names = new Map(ids.length ? (ctx.db.prepare(`SELECT u.id, u.first_name, u.last_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids)) as Array<{ id: string; first_name: string; last_name: string; abbr: string | null }>).map((u) => [u.id, rankName(u)]) : []);
  return rows.map((r) => {
    const row = r as unknown as CounselingRow;
    const out: T & { subject_name?: string; counselor_display?: string; workflow: CounselingOptions } = { ...r, workflow: optionsFor(ctx, scope, viewerId, row) };
    if (r.user_id !== viewerId && names.has(String(r.user_id))) out.subject_name = names.get(String(r.user_id));
    if (counselorWritten(row) && row.counselor_id !== viewerId && !anonymized(r) && names.has(String(row.counselor_id))) out.counselor_display = names.get(String(row.counselor_id));
    return out;
  });
}

/** Who a counseling is about and who counseled, as they are now: what finalizing it keeps, and what a draft prints. */
export function particularsNow(ctx: AppContext, row: Pick<CounselingRow, 'user_id' | 'unit_id' | 'counselor_id'> & { counselor_name?: unknown }): CounselingParticulars {
  const person = ctx.db.prepare(`SELECT u.first_name, u.last_name, u.middle_initial, u.mos, r.abbr, r.grade FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?`).get(row.user_id) as
    { first_name: string; last_name: string; middle_initial: string | null; mos: string | null; abbr: string | null; grade: string | null } | undefined;
  const unit = row.unit_id ? ctx.db.prepare('SELECT name FROM units WHERE id = ?').get(row.unit_id) as { name: string } | undefined : undefined;
  const billet = row.unit_id ? (ctx.db.prepare('SELECT billet FROM unit_members WHERE user_id = ? AND unit_id = ?').get(row.user_id, row.unit_id) as { billet: string | null } | undefined)?.billet ?? null : null;
  const counselor = row.counselor_id && row.counselor_id !== row.user_id
    ? ctx.db.prepare('SELECT u.first_name, u.last_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?').get(row.counselor_id) as { first_name: string; last_name: string; abbr: string | null } | undefined
    : undefined;
  const named = typeof row.counselor_name === 'string' && row.counselor_name.trim() ? row.counselor_name.trim() : null;
  return {
    subject: {
      name: person ? `${person.last_name}, ${person.first_name}${person.middle_initial ? ` ${person.middle_initial}` : ''}` : 'Unknown',
      rank: person?.abbr ?? null, grade: person?.grade ?? null, mos: person?.mos ?? null, billet, unit: unit?.name ?? null,
    },
    counselor: counselor ? { name: `${counselor.last_name}, ${counselor.first_name}`, rank: counselor.abbr } : named ? { name: named, rank: null } : null,
  };
}

const parseParticulars = (raw: unknown): CounselingParticulars | null => {
  if (typeof raw !== 'string' || !raw || raw === REDACTED) return null;
  try {
    const p = JSON.parse(raw) as CounselingParticulars;
    return p && typeof p === 'object' && p.subject ? p : null;
  } catch { return null; }
};

/** The columns a counseling takes as it is finalized: who and when, and its particulars as they stand now. */
export function finalizedColumns(ctx: AppContext, row: Pick<CounselingRow, 'user_id' | 'unit_id' | 'counselor_id'> & { counselor_name?: unknown }, by: string, at: string) {
  return { finalized_at: at, finalized_by: by, particulars: JSON.stringify(particularsNow(ctx, row)) };
}

/** A counseling must say when the session was before it is final. */
export const assertFinalizable = (date: unknown) => {
  if (typeof date !== 'string' || !date) throw badRequest('Give the date of the counseling session before finalizing it.', { fieldErrors: { date: 'Required to finalize.' } });
};

const versionField = z.coerce.number({ error: 'Reload this counseling, then try again.' }).int().min(1);
const actionBody = z.object({ version: versionField });
const CONTENT_SHAPE = Object.fromEntries(COUNSELING_CONTENT.map((f) => [f, true])) as { [K in CounselingField]: true };
const amendBody = counselingSchema.pick(CONTENT_SHAPE).partial().extend({
  version: versionField,
  reason: z.string({ error: 'Say why the counseling is amended.' }).trim().min(1, 'Say why the counseling is amended.').max(COUNSELING_LIMITS.reason, `Keep it under ${COUNSELING_LIMITS.reason} characters.`),
});

const who = (u: SessionUser) => `${u.first_name} ${u.last_name}`;
const about = (row: CounselingRow) => `${counselingTypeLabel(row.type).toLowerCase()} counseling${row.date ? ` of ${row.date}` : ''}`;
const openUrl = (id: string) => `/career/counseling?open=${encodeURIComponent(id)}`;

/** Loads a counseling for a workflow action: one the reader may not read is no such record to them. */
function loadForAction(ctx: AppContext, user: SessionUser, id: string, reqKey: object) {
  const row = counselingRow(ctx, id);
  const scope = scopeFor(ctx, user, reqKey);
  if (!row || row.deleted_at || !canRead(scope, user.id, row)) {
    if (row && !row.deleted_at && !unfinalized(row)) throw forbidden('You cannot open that record.');
    throw notFound('No such counseling.');
  }
  if (!counselorWritten(row)) throw new HttpError(400, 'These are your own counseling notes. They are always final: edit them instead.', 'own_notes');
  return { row, scope };
}

const stale = (ctx: AppContext, id: string) => conflict('This counseling changed since you opened it. Reload it to see where it stands.', 'stale', { current: counselingRow(ctx, id) });

/** The counseling as its reader is given it after an action. */
export function counselingBack(ctx: AppContext, user: SessionUser, id: string, scope?: Scope) {
  return withCounselingDetail(ctx, user.id, [counselingRow(ctx, id) as CounselingRow], scope ?? scopeFor(ctx, user))[0];
}

/** Moves a counseling from one stage to another, against the version and stage its asker saw. */
function move(ctx: AppContext, id: string, version: number, from: CounselingStage[], sets: string[], vals: unknown[]) {
  const result = ctx.db.prepare(`UPDATE counselings SET ${sets.join(', ')}, version = version + 1 WHERE id = ? AND version = ? AND stage IN (${from.map(() => '?').join(',')})`)
    .run(...vals, id, version, ...from);
  if (result.changes === 0) throw stale(ctx, id);
}

/** Shares a draft with the Marine it is about, to read and answer in its comments (POST .../share). */
export function shareCounseling(ctx: AppContext, user: SessionUser, id: string, body: unknown, reqKey: object, ip?: string) {
  const { row, scope } = loadForAction(ctx, user, id, reqKey);
  if (!counselingAuthority(ctx, scope, user.id, row).counselor) throw forbidden('Only its counselor, who still counsels this Marine, shares a counseling draft.', 'counseling_counselor_only');
  const input = parse(actionBody, body);
  if (row.frozen_at || anonymized(row)) throw forbidden('This counseling is frozen and stays as it is.', 'counseling_frozen');
  if (row.stage !== 'draft') throw conflict(row.stage === 'review' ? 'This counseling is already shared with the Marine.' : 'This counseling is final.', 'counseling_stage', { current: row });
  if (row.version !== input.version) throw stale(ctx, id);
  const at = now();
  ctx.db.transaction(() => {
    move(ctx, id, input.version, ['draft'], ["stage = 'review'", 'updated_at = ?'], [at]);
    audit(ctx, { actor_id: user.id, action: 'counseling_shared', entity: 'counselings', entity_id: id, subject_id: row.user_id, unit_id: row.unit_id, detail: 'draft shared with the Marine for review', ip });
  })();
  notify(ctx, row.user_id, { kind: 'counseling', title: 'Counseling draft to review', message: `${who(user)} shared a ${about(row)} draft with you. Read it and answer in its comments before it is final.`, actionUrl: openUrl(id), dedupeKey: `counseling:${id}:review:${input.version}` });
  return counselingBack(ctx, user, id, scope);
}

/** Takes a counseling shared for review back to a draft, its counselor's alone again (POST .../withdraw). */
export function withdrawCounseling(ctx: AppContext, user: SessionUser, id: string, body: unknown, reqKey: object, ip?: string) {
  const { row, scope } = loadForAction(ctx, user, id, reqKey);
  if (!counselingAuthority(ctx, scope, user.id, row).counselor) throw forbidden('Only its counselor, who still counsels this Marine, takes a shared draft back.', 'counseling_counselor_only');
  const input = parse(actionBody, body);
  if (row.stage !== 'review') throw conflict(row.stage === 'draft' ? 'This counseling draft is not shared.' : 'This counseling is final.', 'counseling_stage', { current: row });
  if (row.version !== input.version) throw stale(ctx, id);
  ctx.db.transaction(() => {
    move(ctx, id, input.version, ['review'], ["stage = 'draft'", 'updated_at = ?'], [now()]);
    audit(ctx, { actor_id: user.id, action: 'counseling_withdrawn', entity: 'counselings', entity_id: id, subject_id: row.user_id, unit_id: row.unit_id, detail: 'back to draft', ip });
  })();
  return counselingBack(ctx, user, id, scope);
}

/** Finalizes a draft, or one shared for review: its Marine is told and may acknowledge it (POST .../finalize). */
export function finalizeCounseling(ctx: AppContext, user: SessionUser, id: string, body: unknown, reqKey: object, ip?: string) {
  const { row, scope } = loadForAction(ctx, user, id, reqKey);
  if (!counselingAuthority(ctx, scope, user.id, row).counselor) throw forbidden('Only its counselor, who still counsels this Marine, finalizes a counseling.', 'counseling_counselor_only');
  const input = parse(actionBody, body);
  if (row.frozen_at || anonymized(row)) throw forbidden('This counseling is frozen and stays as it is.', 'counseling_frozen');
  if (row.stage === 'final') throw conflict('This counseling is already final.', 'counseling_stage', { current: row });
  if (row.version !== input.version) throw stale(ctx, id);
  assertFinalizable(row.date);
  const at = now();
  const stamp = finalizedColumns(ctx, row, user.id, at);
  ctx.db.transaction(() => {
    move(ctx, id, input.version, ['draft', 'review'], ["stage = 'final'", 'revision = 1', 'finalized_at = ?', 'finalized_by = ?', 'particulars = ?', 'updated_at = ?'], [stamp.finalized_at, stamp.finalized_by, stamp.particulars, at]);
    audit(ctx, { actor_id: user.id, action: 'counseling_finalized', entity: 'counselings', entity_id: id, subject_id: row.user_id, unit_id: row.unit_id, detail: `from ${row.stage}; revision 1`, ip });
  })();
  tellFinal(ctx, user, row.user_id, id, row.type);
  return counselingBack(ctx, user, id, scope);
}

/** Tells a Marine a counseling about them is final: the notice it was given as it was written before 035. */
export function tellFinal(ctx: AppContext, user: SessionUser, subjectId: string, id: string, type: unknown) {
  notify(ctx, subjectId, { kind: 'counseling', title: 'New counseling recorded', message: `${who(user)} recorded a ${String(type || 'counseling').replace('_', ' ')} counseling.`, actionUrl: openUrl(id), dedupeKey: `counseling:${id}` });
}

const contentOf = (row: Row) => Object.fromEntries(COUNSELING_CONTENT.map((f) => [f, (row[f] as string | null | undefined) ?? null])) as Record<CounselingField, string | null>;

/**
 * Amends a final counseling (POST .../amend): a reason, at least one changed field, against the version the amender saw.
 * What it replaces is kept as it read, with whether its Marine had acknowledged it; the Marine acknowledges the amended
 * text afresh. Its counselor, who still counsels the Marine, amends it; so does a records manager of the unit it is
 * shared with, as they could correct it before. Never its Marine.
 */
export function amendCounseling(ctx: AppContext, user: SessionUser, id: string, body: unknown, reqKey: object, ip?: string) {
  const { row, scope } = loadForAction(ctx, user, id, reqKey);
  const authority = counselingAuthority(ctx, scope, user.id, row);
  if (row.user_id === user.id) throw forbidden('You cannot amend a counseling about you. Answer it in its comments, or ask your counselor.', 'counseling_subject');
  if (!authority.counselor && !authority.manager) throw forbidden('Only its counselor, who still counsels this Marine, or a records manager of the unit it is shared with amends a counseling.', 'counseling_counselor_only');
  const input = parse(amendBody, body) as Partial<Record<CounselingField, string | null>> & { version: number; reason: string };
  if (row.frozen_at || anonymized(row)) throw forbidden('This counseling is frozen and stays as it is.', 'counseling_frozen');
  if (row.stage !== 'final') throw conflict('This counseling is not final yet. Edit the draft instead.', 'counseling_stage', { current: row });
  if (row.version !== input.version) throw stale(ctx, id);
  const before = contentOf(row);
  const changed = COUNSELING_CONTENT.filter((f) => input[f] !== undefined && (input[f] ?? null) !== (before[f] ?? null));
  if (!changed.length) throw badRequest('Nothing in the counseling changed. Change what needs amending, then say why.');
  if (input.date !== undefined) assertFinalizable(input.date);
  const at = now();
  const previous = row.revision > 1
    ? (ctx.db.prepare('SELECT created_at FROM counseling_revisions WHERE counseling_id = ? AND revision = ?').get(id, row.revision - 1) as { created_at: string } | undefined)?.created_at ?? null
    : row.finalized_at;
  const sets = ['revision = revision + 1', 'acknowledged_at = NULL', 'updated_at = ?'];
  const vals: unknown[] = [at];
  for (const f of changed) { sets.push(`${f} = ?`); vals.push(input[f] ?? null); }
  const how = authority.counselor ? 'counselor amendment' : 'manager amendment';
  ctx.db.transaction(() => {
    move(ctx, id, input.version, ['final'], sets, vals);
    ctx.db.prepare(`INSERT INTO counseling_revisions (id, counseling_id, unit_id, revision, content, finalized_at, acknowledged_at, amended_by, reason, changed, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(newId(), id, row.unit_id, row.revision, JSON.stringify({ fields: before, particulars: parseParticulars(row.particulars) }), previous, row.acknowledged_at, user.id, input.reason, changed.join(','), at);
    audit(ctx, { actor_id: user.id, action: 'counseling_amended', entity: 'counselings', entity_id: id, subject_id: row.user_id, unit_id: row.unit_id,
      detail: `${how}; revision ${row.revision + 1}; changed: ${changed.join(', ')}${row.acknowledged_at ? '; acknowledgement cleared' : ''}`, ip });
  })();
  notify(ctx, row.user_id, { kind: 'counseling', title: 'Counseling amended', message: `${who(user)} amended a ${about(row)}. Read the amended text and acknowledge it.`, actionUrl: openUrl(id), dedupeKey: `counseling:${id}:r${row.revision + 1}` });
  if (!authority.counselor && row.counselor_id && row.counselor_id !== user.id && canRead(scopeFor(ctx, { id: row.counselor_id }), row.counselor_id, row)) {
    notify(ctx, row.counselor_id, { kind: 'counseling', title: 'A counseling you wrote was amended', message: `${who(user)} amended a ${about(row)} you wrote.`, actionUrl: openUrl(id), dedupeKey: `counseling:${id}:r${row.revision + 1}:counselor` });
  }
  return counselingBack(ctx, user, id, scope);
}

/**
 * Its Marine says they read a final counseling (POST .../acknowledge): reading, not agreeing. Bound to the version they
 * read, so an amendment that lands meanwhile is not acknowledged unread. Saying it again changes nothing.
 */
export function acknowledgeCounseling(ctx: AppContext, user: SessionUser, id: string, body: unknown, reqKey: object, ip?: string) {
  const { row, scope } = loadForAction(ctx, user, id, reqKey);
  if (row.user_id !== user.id) throw forbidden('Only the counseled Marine can acknowledge.');
  const input = parse(actionBody, body);
  if (row.stage !== 'final') throw conflict('This counseling is not final yet. You acknowledge it once your counselor finalizes it.', 'counseling_stage', { current: row });
  if (row.acknowledged_at) return counselingBack(ctx, user, id, scope);
  if (row.version !== input.version) throw stale(ctx, id);
  const at = now();
  ctx.db.transaction(() => {
    move(ctx, id, input.version, ['final'], ['acknowledged_at = ?', 'updated_at = ?'], [at, at]);
    audit(ctx, { actor_id: user.id, action: 'acknowledge_counseling', entity: 'counselings', entity_id: row.id, unit_id: row.unit_id, detail: `revision ${row.revision}`, ip });
  })();
  if (row.counselor_id && canRead(scopeFor(ctx, { id: row.counselor_id }), row.counselor_id, row)) {
    notify(ctx, row.counselor_id, { kind: 'counseling', title: 'Counseling acknowledged', message: `${who(user)} acknowledged the ${about(row)}${row.revision > 1 ? ` (revision ${row.revision})` : ''}.`, actionUrl: openUrl(id), dedupeKey: `counseling:${id}:ack:${row.revision}` });
  }
  return counselingBack(ctx, user, id, scope);
}

/** Reads one counseling for its history or worksheet: whoever may read it; a draft is no such record to anyone else. */
function readableCounseling(ctx: AppContext, user: SessionUser, id: string, reqKey: object) {
  const row = counselingRow(ctx, id);
  const scope = scopeFor(ctx, user, reqKey);
  if (!row || (row.deleted_at && row.user_id !== user.id && row.counselor_id !== user.id)) throw notFound('No such counseling.');
  if (!canRead(scope, user.id, row)) {
    if (unfinalized(row)) throw notFound('No such counseling.');
    throw forbidden('You cannot open that record.');
  }
  return { row, scope };
}

interface RevisionRow { revision: number; content: string; finalized_at: string | null; acknowledged_at: string | null; amended_by: string; reason: string; changed: string; created_at: string; last_name: string | null; first_name: string | null; abbr: string | null }

function revisionRows(ctx: AppContext, id: string) {
  return ctx.db.prepare(`SELECT v.*, u.last_name, u.first_name, r.abbr FROM counseling_revisions v LEFT JOIN users u ON u.id = v.amended_by LEFT JOIN ranks r ON r.id = u.rank_id
                         WHERE v.counseling_id = ? ORDER BY v.revision DESC`).all(id) as RevisionRow[];
}

const revisionContent = (raw: string): { fields: Partial<Record<CounselingField, string | null>>; particulars: CounselingParticulars | null } => {
  if (raw === REDACTED) return { fields: Object.fromEntries(['summary', 'strengths', 'improvements', 'goals_set', 'counselor_name'].map((f) => [f, REDACTED])), particulars: null };
  try {
    const parsed = JSON.parse(raw) as { fields?: Record<string, string | null>; particulars?: CounselingParticulars | null };
    return { fields: parsed.fields ?? {}, particulars: parsed.particulars ?? null };
  } catch { return { fields: {}, particulars: null }; }
};

const changedOf = (raw: string) => raw.split(',').filter((f): f is CounselingField => (COUNSELING_CONTENT as readonly string[]).includes(f));

/**
 * A counseling's amendment history, newest first (GET .../revisions): what it said before each amendment, who amended it
 * and why. For whoever may read the counseling; read by anyone but its Marine, it is a read of their record.
 */
export function counselingRevisions(ctx: AppContext, user: SessionUser, id: string, reqKey: object, ip?: string): { revision: number; revisions: CounselingRevision[] } {
  const { row } = readableCounseling(ctx, user, id, reqKey);
  const rows = revisionRows(ctx, id);
  if (row.user_id !== user.id && rows.length) audit(ctx, { actor_id: user.id, action: 'view_record', entity: 'counselings', entity_id: id, subject_id: row.user_id, unit_id: row.unit_id, detail: 'amendment history', ip });
  const hidden = anonymized(row);
  return {
    revision: row.revision,
    revisions: rows.map((v) => ({
      revision: v.revision, content: revisionContent(v.content).fields, finalized_at: v.finalized_at, acknowledged_at: v.acknowledged_at,
      amended_by_name: hidden ? null : v.amended_by === user.id ? 'You' : v.last_name ? rankName({ abbr: v.abbr, last_name: v.last_name }) : null,
      amended_at: v.created_at, reason: hidden ? REDACTED : v.reason, changed: changedOf(v.changed),
    })),
  };
}

/**
 * The worksheet a counseling prints as (GET .../worksheet, and the PDF): the current text, or an earlier revision from
 * what its amendment kept. Built from what is stored, for whoever may read the counseling; read by anyone but its Marine
 * it is a read of their record, and printing it is said so in the trail.
 */
export function counselingWorksheet(ctx: AppContext, user: SessionUser, id: string, opts: { revision?: number | null; purpose?: 'view' | 'print' | 'pdf' }, reqKey: object, ip?: string): CounselingDocument {
  const { row } = readableCounseling(ctx, user, id, reqKey);
  const history = revisionRows(ctx, id);
  const wanted = opts.revision == null ? row.revision : Number(opts.revision);
  if (!Number.isInteger(wanted) || wanted < 1 || wanted > row.revision) throw notFound(`This counseling has no revision ${opts.revision}.`);
  const earlier = wanted < row.revision ? history.find((v) => v.revision === wanted) : undefined;
  if (wanted < row.revision && !earlier) throw notFound(`This counseling has no revision ${opts.revision}.`);
  const kept = earlier ? revisionContent(earlier.content) : null;
  const stored = parseParticulars(row.particulars);
  const particulars = kept?.particulars ?? stored ?? particularsNow(ctx, row);
  const hidden = anonymized(row);
  const nameOf = (id: string | null) => {
    if (!id || hidden) return null;
    const p = ctx.db.prepare('SELECT u.last_name, u.first_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?').get(id) as { last_name: string; first_name: string; abbr: string | null } | undefined;
    return p ? rankName(p) : null;
  };
  const reader = ctx.db.prepare('SELECT u.last_name, u.first_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?').get(user.id) as { last_name: string; first_name: string; abbr: string | null } | undefined;
  const doc = counselingDocument({
    id: row.id, version: row.version, stage: row.stage, revision: wanted, current_revision: row.revision, own_notes: !counselorWritten(row),
    content: kept ? kept.fields : contentOf(row),
    // Anonymized under its retention schedule: nobody is named on it, not even as they are now.
    particulars: hidden ? { subject: { name: REDACTED, rank: null, grade: null, mos: null, billet: null, unit: null }, counselor: null } : particulars,
    particulars_as_of: hidden || kept?.particulars || stored ? 'finalized' : 'now',
    finalized: { at: earlier ? earlier.finalized_at : row.finalized_at, by: nameOf(row.finalized_by) },
    acknowledged_at: earlier ? earlier.acknowledged_at : row.acknowledged_at,
    amendments: history.map((v) => ({
      revision: v.revision + 1, at: v.created_at, by: hidden ? null : v.last_name ? rankName({ abbr: v.abbr, last_name: v.last_name }) : null,
      reason: hidden ? REDACTED : v.reason, changed: changedOf(v.changed).map((f) => COUNSELING_FIELD_LABELS[f]), acknowledged_at: v.acknowledged_at,
    })),
    amendments_total: history.length,
    superseded_at: earlier?.created_at ?? null,
    marking: ctx.runtime.reportMarking || DEFAULT_REPORT_MARKING,
    generated: { on: zonedDay(zoneOf(ctx, user)), by: reader ? rankName(reader) : user.username },
  });
  const purpose = opts.purpose ?? 'view';
  if (purpose === 'print') audit(ctx, { actor_id: user.id, action: 'print_counseling', entity: 'counselings', entity_id: id, subject_id: row.user_id !== user.id ? row.user_id : null, unit_id: row.unit_id, detail: `revision ${wanted}${row.stage === 'final' ? '' : `; ${row.stage}`}`, ip });
  else if (purpose === 'view' && row.user_id !== user.id) audit(ctx, { actor_id: user.id, action: 'view_record', entity: 'counselings', entity_id: id, subject_id: row.user_id, unit_id: row.unit_id, detail: `worksheet; revision ${wanted}`, ip });
  return doc;
}

/** The PDF's file name: the record, its revision and its stage, never the Marine's name. */
export const worksheetFileName = (doc: CounselingDocument) => `vantage-counseling-${doc.id.slice(0, 8)}-r${doc.revision}${doc.stage === 'final' ? '' : `-${doc.stage}`}.pdf`;
