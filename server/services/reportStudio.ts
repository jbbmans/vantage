import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, detailUnitsFor, PERMISSIONS } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { canRead } from '../authz/records.ts';
import { isRecordTable, getRecord } from './records.ts';
import type { RecordTable } from '../../shared/schemas.ts';

/**
 * Report Studio: a draft, its revisions, and the proof that the wording matches its sources.
 *
 * A report makes claims about someone's work, so the connection between a sentence and the record
 * it came from has to be more than a convention. Every save states which records the wording was
 * built from and which version of each one the author was looking at. The server re-reads those
 * records inside the same transaction that writes the revision and refuses if any of them has
 * moved. A client cannot skip that check, because the check is where the write happens.
 *
 * Revisions are immutable. Exporting reads a revision, not the live records, so a package handed
 * to a reporting senior is the package that was reviewed even if a source is edited an hour later.
 */

export interface ReportDraft {
  id: string; user_id: string; subject_id: string; unit_id: string | null; visibility: string;
  title: string; period_start: string; period_end: string; track: string;
  latest_revision: number; version: number; deleted_at: string | null; created_at: string; updated_at: string;
}

export interface Section { heading: string; body: string; source_ids?: string[] }

export interface SourceRef { table: RecordTable; id: string; version: number }

export interface SourceSnapshot extends SourceRef {
  title: string; date: string | null; user_id: string;
  quantity: number | null; unit_label: string | null;
  dollar_amount: number | null; dollar_type: string | null; result: string | null;
}

export interface StaleSource { table: string; id: string; title: string; expected_version: number; actual_version: number | null; reason: string }

const SOURCE_TABLES = new Set(['activities', 'trainings', 'awards', 'counselings']);

function assertSubject(ctx: AppContext, user: SessionUser, scope: Scope, subjectId: string, unitId: string | null) {
  if (subjectId === user.id) return;
  const units = detailUnitsFor(ctx, scope, subjectId);
  if (!units.length) throw forbidden('You cannot build a report for that Marine.');
  if (unitId && !units.includes(unitId)) throw forbidden('You cannot build a report for that Marine in that unit.');
}

export function createDraft(
  ctx: AppContext,
  user: SessionUser,
  scope: Scope,
  input: { title: string; period_start: string; period_end: string; subject_id?: string | null; unit_id?: string | null; track?: string; visibility?: 'private' | 'unit' },
): ReportDraft {
  const subjectId = input.subject_id || user.id;
  const unitId = input.unit_id || null;
  assertSubject(ctx, user, scope, subjectId, unitId);
  if (input.visibility === 'unit') {
    if (!unitId) throw badRequest('Choose the unit to share this report with.');
    if (!can(scope, PERMISSIONS.VIEW_RECORDS, unitId)) throw forbidden('You cannot share a report with that unit.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.period_start) || !/^\d{4}-\d{2}-\d{2}$/.test(input.period_end)) throw badRequest('Give the report a start and an end date.');
  if (input.period_start > input.period_end) throw badRequest('The report cannot end before it starts.');
  const title = String(input.title || '').trim().slice(0, 200);
  if (!title) throw badRequest('Give the report a title.');

  const id = newId();
  const at = now();
  ctx.db.prepare(
    `INSERT INTO report_drafts (id, user_id, subject_id, unit_id, visibility, title, period_start, period_end, track, latest_revision, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`
  ).run(id, user.id, subjectId, unitId, input.visibility || 'private', title, input.period_start, input.period_end, input.track === 'fitrep' ? 'fitrep' : 'jepes', at, at);
  return getDraft(ctx, id)!;
}

export function getDraft(ctx: AppContext, id: string): ReportDraft | null {
  return (ctx.db.prepare('SELECT * FROM report_drafts WHERE id = ? AND deleted_at IS NULL').get(id) as ReportDraft | undefined) || null;
}

export function readableDraft(ctx: AppContext, user: SessionUser, scope: Scope, id: string): ReportDraft {
  const draft = getDraft(ctx, id);
  if (!draft) throw notFound('No such report.');
  if (draft.user_id === user.id || draft.subject_id === user.id) return draft;
  if (draft.visibility === 'unit' && draft.unit_id && can(scope, PERMISSIONS.VIEW_RECORDS, draft.unit_id)) return draft;
  throw forbidden('That report is not yours to open.');
}

function assertAuthor(draft: ReportDraft, user: SessionUser) {
  if (draft.user_id !== user.id) throw forbidden('Only the person writing this report can save a revision of it.');
}

export function listDrafts(ctx: AppContext, user: SessionUser, scope: Scope) {
  const units = scope.readableUnitIds;
  const rows = units.length
    ? ctx.db.prepare(`SELECT * FROM report_drafts WHERE deleted_at IS NULL AND (user_id = ? OR subject_id = ? OR (visibility = 'unit' AND unit_id IN (${units.map(() => '?').join(',')}))) ORDER BY updated_at DESC LIMIT 100`).all(user.id, user.id, ...units)
    : ctx.db.prepare('SELECT * FROM report_drafts WHERE deleted_at IS NULL AND (user_id = ? OR subject_id = ?) ORDER BY updated_at DESC LIMIT 100').all(user.id, user.id);
  return rows as ReportDraft[];
}

/**
 * The records a report may cite: those the caller can read, inside the report's period, belonging
 * to its subject. A report cannot cite something its author cannot see.
 */
export function availableSources(ctx: AppContext, user: SessionUser, scope: Scope, draft: ReportDraft): SourceSnapshot[] {
  const out: SourceSnapshot[] = [];
  for (const table of ['activities', 'trainings', 'awards', 'counselings'] as RecordTable[]) {
    const dateCol = 'date';
    const rows = ctx.db.prepare(
      `SELECT * FROM ${table} WHERE user_id = ? AND deleted_at IS NULL AND ${dateCol} >= ? AND ${dateCol} <= ? ORDER BY ${dateCol} DESC LIMIT 400`
    ).all(draft.subject_id, draft.period_start, draft.period_end) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (!canRead(scope, user.id, row as never)) continue;
      out.push(snapshotOf(table, row));
    }
  }
  return out.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

function snapshotOf(table: RecordTable, row: Record<string, unknown>): SourceSnapshot {
  return {
    table, id: String(row.id), version: Number(row.version) || 1,
    title: String(row.title || row.name || ''), date: (row.date as string | null) ?? null,
    user_id: String(row.user_id),
    quantity: row.quantity == null ? null : Number(row.quantity),
    unit_label: (row.unit_label as string | null) ?? null,
    dollar_amount: row.dollar_amount == null ? null : Number(row.dollar_amount),
    dollar_type: (row.dollar_type as string | null) ?? null,
    result: (row.result as string | null) ?? null,
  };
}

export interface SaveRevisionInput {
  title?: string;
  period_start?: string;
  period_end?: string;
  sections: Section[];
  /** Which record, at which version, the author was looking at when they wrote this. */
  sources: SourceRef[];
  note?: string | null;
  /** The revision the author started from, so two people cannot silently overwrite each other. */
  base_revision?: number | null;
}

export class StaleSourceError extends Error {
  stale: StaleSource[];
  constructor(stale: StaleSource[]) {
    super('A record this report cites has changed since you wrote it. Review the new facts, then save again.');
    this.name = 'StaleSourceError';
    this.stale = stale;
  }
}

/**
 * Saves a new revision, or refuses.
 *
 * The re-read of every cited record and the write of the revision happen in one transaction, so
 * there is no window in which a source could change between the check and the save.
 */
export function saveRevision(ctx: AppContext, user: SessionUser, scope: Scope, draftId: string, input: SaveRevisionInput) {
  const draft = readableDraft(ctx, user, scope, draftId);
  assertAuthor(draft, user);

  if (!Array.isArray(input.sections) || input.sections.length === 0) throw badRequest('A report needs at least one section.');
  if (input.sections.length > 40) throw badRequest('A report can hold up to 40 sections.');
  if (!Array.isArray(input.sources)) throw badRequest('Say which records this wording was built from.');
  if (input.sources.length > 400) throw badRequest('A report can cite up to 400 records.');
  for (const s of input.sources) {
    if (!isRecordTable(s.table) || !SOURCE_TABLES.has(s.table)) throw badRequest('A report can only cite activities, training, awards and counselings.');
    if (!Number.isFinite(Number(s.version))) throw badRequest('Every cited record must say which version it was.');
  }

  const sections = input.sections.map((s) => ({
    heading: String(s.heading || '').slice(0, 200),
    body: String(s.body || '').slice(0, 20_000),
    source_ids: Array.isArray(s.source_ids) ? s.source_ids.slice(0, 200).map(String) : [],
  }));

  const title = (input.title ?? draft.title).trim().slice(0, 200) || draft.title;
  const periodStart = input.period_start ?? draft.period_start;
  const periodEnd = input.period_end ?? draft.period_end;
  if (periodStart > periodEnd) throw badRequest('The report cannot end before it starts.');

  return ctx.db.transaction(() => {
    const current = getDraft(ctx, draftId);
    if (!current) throw notFound('That report is gone.');
    if (input.base_revision != null && current.latest_revision !== input.base_revision) {
      throw conflict(`This report is now at revision ${current.latest_revision}. Reload it before saving again.`);
    }

    // Every cited record is re-read here, inside the transaction that writes the revision.
    const stale: StaleSource[] = [];
    const snapshots: SourceSnapshot[] = [];
    for (const ref of input.sources) {
      const row = getRecord(ctx, ref.table, ref.id) as Record<string, unknown> | null;
      if (!row) {
        stale.push({ table: ref.table, id: ref.id, title: '', expected_version: Number(ref.version), actual_version: null, reason: 'It was deleted after you cited it.' });
        continue;
      }
      if (!canRead(scope, user.id, row as never)) throw forbidden('This report cites a record you cannot read.');
      if (String(row.user_id) !== draft.subject_id) throw badRequest('A report can only cite records belonging to the person it is about.');
      const actual = Number(row.version) || 1;
      if (actual !== Number(ref.version)) {
        stale.push({ table: ref.table, id: ref.id, title: String(row.title || ''), expected_version: Number(ref.version), actual_version: actual, reason: 'Its facts changed after this wording was written.' });
        continue;
      }
      snapshots.push(snapshotOf(ref.table, row));
    }
    if (stale.length) throw new StaleSourceError(stale);

    const revision = current.latest_revision + 1;
    const at = now();
    ctx.db.prepare(
      `INSERT INTO report_revisions (id, report_id, revision, title, period_start, period_end, sections, source_snapshots, note, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(newId(), draftId, revision, title, periodStart, periodEnd, JSON.stringify(sections), JSON.stringify(snapshots), (input.note || '').slice(0, 500) || null, user.id, at);
    ctx.db.prepare('UPDATE report_drafts SET title = ?, period_start = ?, period_end = ?, latest_revision = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(title, periodStart, periodEnd, revision, at, draftId);

    return { draft: getDraft(ctx, draftId)!, revision: getRevision(ctx, draftId, revision)! };
  })();
}

export interface RevisionRow {
  id: string; report_id: string; revision: number; title: string; period_start: string; period_end: string;
  sections: string; source_snapshots: string; note: string | null; created_by: string; created_at: string;
}

export function getRevision(ctx: AppContext, reportId: string, revision: number) {
  const row = ctx.db.prepare('SELECT * FROM report_revisions WHERE report_id = ? AND revision = ?').get(reportId, revision) as RevisionRow | undefined;
  if (!row) return null;
  return {
    ...row,
    sections: JSON.parse(row.sections || '[]') as Section[],
    source_snapshots: JSON.parse(row.source_snapshots || '[]') as SourceSnapshot[],
  };
}

export function listRevisions(ctx: AppContext, reportId: string) {
  const rows = ctx.db.prepare(
    `SELECT r.revision, r.title, r.period_start, r.period_end, r.note, r.created_at, r.created_by,
            u.first_name, u.last_name, length(r.sections) AS section_bytes
       FROM report_revisions r JOIN users u ON u.id = r.created_by
      WHERE r.report_id = ? ORDER BY r.revision DESC`
  ).all(reportId) as Array<Record<string, unknown>>;
  return rows;
}

/**
 * Whether a saved revision still matches the records it cites. This is what lets a screen say
 * "two sources have changed since revision 3" without pretending the revision itself changed.
 */
export function revisionDrift(ctx: AppContext, reportId: string, revision: number): StaleSource[] {
  const saved = getRevision(ctx, reportId, revision);
  if (!saved) return [];
  const drift: StaleSource[] = [];
  for (const snap of saved.source_snapshots) {
    const row = getRecord(ctx, snap.table, snap.id) as Record<string, unknown> | null;
    if (!row) { drift.push({ table: snap.table, id: snap.id, title: snap.title, expected_version: snap.version, actual_version: null, reason: 'It has been deleted since this revision was saved.' }); continue; }
    const actual = Number(row.version) || 1;
    if (actual !== snap.version) drift.push({ table: snap.table, id: snap.id, title: snap.title, expected_version: snap.version, actual_version: actual, reason: 'It has been edited since this revision was saved.' });
  }
  return drift;
}

/** The exported text of one revision, rendered from what was saved rather than from live records. */
export function renderRevisionText(ctx: AppContext, reportId: string, revision: number): string {
  const saved = getRevision(ctx, reportId, revision);
  if (!saved) throw notFound('No such revision.');
  const lines: string[] = [
    saved.title,
    `${saved.period_start} to ${saved.period_end}`,
    `Revision ${saved.revision}, saved ${saved.created_at}`,
    '',
  ];
  for (const section of saved.sections) {
    lines.push(section.heading.toUpperCase(), section.body, '');
  }
  lines.push('SOURCE RECORDS');
  saved.source_snapshots.forEach((s, i) => {
    const measure = [
      s.quantity != null ? `${s.quantity} ${s.unit_label || ''}`.trim() : null,
      s.dollar_amount != null ? `${s.dollar_amount} ${s.dollar_type || ''}`.trim() : null,
    ].filter(Boolean).join(', ');
    lines.push(`[${String(i + 1).padStart(2, '0')}] ${s.title} (${s.table}, ${s.date || 'no date'}, version ${s.version})${measure ? ` - ${measure}` : ''}`);
  });
  return lines.join('\n');
}
