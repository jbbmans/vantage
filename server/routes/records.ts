import { Router } from 'express';
import express from 'express';
import { wrap, clientIp, parse } from '../lib/http.ts';
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.ts';
import { requireAuth } from '../auth/middleware.ts';
import { sessionStands } from '../auth/sessions.ts';
import { PERMISSIONS, can, scopeFor } from '../authz/scope.ts';
import { canEdit, canRead, unfinalized } from '../authz/records.ts';
import { isRecordTable, listRecords, createRecord, updateRecord, deleteRecord, restoreRecord, readableRecord, importActivities, getRecord, withGoalProgress, withRecorderNames } from '../services/records.ts';
import { inspectAttachment, attachmentDisposition, attachmentContentType, filenameFromHeader } from '../services/attachments.ts';
import { EVIDENCE_KINDS, EVIDENCE_KIND_LABELS, isAttachable, takesEvidenceKind, type AttachmentRow, type AttachmentsResponse, type EvidenceKind } from '../../shared/attachments.ts';
import { attachmentDetailsSchema } from '../../shared/schemas.ts';
import { audit, auditListedRecords } from '../services/audit.ts';
import { MalwareRejected, scanUpload } from '../services/scanner.ts';
import { featureOn } from '../services/instanceFlags.ts';
import { infrastructureBodyProblem } from '../../shared/dataTransfer.ts';
import { goalContributors } from '../services/goals.ts';
import { listComments, addComment, editComment, deleteComment } from '../services/comments.ts';
import { moveRecord, undoMove, recordLineage, keepAsActivity } from '../services/recordMoves.ts';
import { newId, now } from '../lib/ids.ts';
import { buildRecordExport } from '../services/personalExport.ts';
import { importedFrom } from '../services/recordImport.ts';
import { withDutyNames, isAnonymizedDuty } from '../services/duties.ts';
import { dutyReviewHistory, reviewDuty } from '../services/dutyReview.ts';
import {
  acknowledgeCounseling, amendCounseling, counselingRevisions, counselingWorksheet, finalizeCounseling, mayManageCounselingFiles,
  shareCounseling, withCounselingDetail, withdrawCounseling, worksheetFileName,
} from '../services/counselings.ts';
import { renderCounselingPdf } from '../lib/pdfCounseling.ts';
import { statSync } from 'node:fs';

export const recordsRouter = Router();
recordsRouter.use(requireAuth);

function tableParam(req: express.Request) {
  const table = String(req.params.table || '');
  if (!isRecordTable(table)) throw notFound('No such record type.');
  return table;
}

recordsRouter.get('/:table', wrap((req, res) => {
  const table = tableParam(req);
  const scope = scopeFor(req.ctx, req.user, req);
  const rows = listRecords(req.ctx, req.user, table, scope, {
    unitId: req.query.unit_id ? String(req.query.unit_id) : null, from: req.query.from ? String(req.query.from) : null, to: req.query.to ? String(req.query.to) : null,
    limit: Number(req.query.limit) || undefined, offset: Number(req.query.offset) || undefined, deleted: req.query.deleted === '1',
  });
  auditListedRecords(req.ctx, req.user.id, table, rows, clientIp(req));
  res.json(rows);
}));

recordsRouter.get('/goals/:id/contributors', wrap((req, res) => {
  const raw = readableRecord(req.ctx, req.user, 'goals', String(req.params.id), req) as Record<string, unknown>;
  // A unit-wide goal's contributors are other people's entries, by title and amount: only for someone who could open
  // them anyway. A member who can see the goal still sees its progress, which is a total.
  if (raw.measure_scope === 'unit' && !can(scopeFor(req.ctx, req.user, req), PERMISSIONS.VIEW_RECORDS, raw.unit_id as string | null)) return res.json([]);
  res.json(goalContributors(req.ctx, raw as never));
}));

recordsRouter.post('/activities/import', wrap((req, res) => {
  // A data import never takes the service archive (ADR-0014).
  const archive = infrastructureBodyProblem(req.body);
  if (archive) throw badRequest(archive, { code: 'infrastructure_file' });
  res.json(importActivities(req.ctx, req.user, req.body?.rows, req, clientIp(req)));
}));

recordsRouter.get('/:table/:id', wrap((req, res) => {
  const table = tableParam(req);
  const raw = readableRecord(req.ctx, req.user, table, String(req.params.id), req);
  const row = table === 'goals' ? withGoalProgress(req.ctx, [raw])[0] : table === 'awards' ? withRecorderNames(req.ctx, req.user.id, [raw])[0] as typeof raw
    : table === 'duties' ? withDutyNames(req.ctx, req.user.id, [raw], scopeFor(req.ctx, req.user, req))[0] as typeof raw
    : table === 'counselings' ? withCounselingDetail(req.ctx, req.user.id, [raw], scopeFor(req.ctx, req.user, req))[0] as typeof raw : raw;
  if (row.user_id !== req.user.id) audit(req.ctx, { actor_id: req.user.id, action: 'view_record', entity: table, entity_id: row.id, subject_id: row.user_id, unit_id: row.unit_id, ip: clientIp(req) });
  // A record an import brought in says so, and by whose word (ADR-0019); a duty a retention schedule anonymized says it
  // was imported, and names nobody (ADR-0023 §8).
  const origin = importedFrom(req.ctx, table, row.id, req.user.id);
  const imported = origin && table === 'duties' && isAnonymizedDuty(row as Record<string, unknown>) ? { ...origin, author: null } : origin;
  res.json(imported ? { ...row, imported } : row);
}));

/**
 * One record to keep: as JSON, a one-row CSV, or a ZIP with its files; a counseling also as its worksheet in the NAVMC
 * 2795 layout (ADR-0027), drawn from the stored record and never stored itself. Whoever may read the record may download it.
 */
recordsRouter.get('/:table/:id/export', wrap(async (req, res) => {
  const table = tableParam(req);
  if (table === 'counselings' && req.query.format === 'pdf') {
    const revision = req.query.revision === undefined ? null : Number(req.query.revision);
    const doc = counselingWorksheet(req.ctx, req.user, String(req.params.id), { revision, purpose: 'pdf' }, req, clientIp(req));
    const pdf = await renderCounselingPdf(doc);
    const subject = getRecord(req.ctx, 'counselings', doc.id, { includeDeleted: true });
    audit(req.ctx, { actor_id: req.user.id, action: 'export_record', entity: table, entity_id: doc.id, subject_id: subject && subject.user_id !== req.user.id ? subject.user_id : null, unit_id: subject?.unit_id ?? null, detail: `pdf; revision ${doc.revision}${doc.stage === 'final' ? '' : `; ${doc.stage}`}`, ip: clientIp(req) });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${worksheetFileName(doc)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(pdf);
    return;
  }
  const row = readableRecord(req.ctx, req.user, table, String(req.params.id), req);
  const format = req.query.format === 'csv' ? 'csv' : req.query.format === 'zip' ? 'zip' : 'json';
  const out = buildRecordExport(req.ctx, table, row as Record<string, unknown>, format, { files: isAttachable(table) });
  audit(req.ctx, { actor_id: req.user.id, action: 'export_record', entity: table, entity_id: row.id, subject_id: row.user_id !== req.user.id ? row.user_id : null, unit_id: row.unit_id, detail: `${format}${out.attachments ? `; ${out.attachments} files` : ''}`, ip: clientIp(req) });
  res.setHeader('Content-Type', out.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(out.body);
}));

recordsRouter.post('/:table', wrap((req, res) => {
  const table = tableParam(req);
  res.status(201).json(createRecord(req.ctx, req.user, table, req.body, req, clientIp(req)));
}));

recordsRouter.put('/:table/:id', wrap((req, res) => {
  const table = tableParam(req);
  res.json(updateRecord(req.ctx, req.user, table, String(req.params.id), req.body, req, clientIp(req)));
}));

recordsRouter.delete('/:table/:id', wrap((req, res) => {
  const table = tableParam(req);
  res.json(deleteRecord(req.ctx, req.user, table, String(req.params.id), req, clientIp(req)));
}));

recordsRouter.post('/:table/:id/restore', wrap((req, res) => {
  const table = tableParam(req);
  res.json(restoreRecord(req.ctx, req.user, table, String(req.params.id), req, clientIp(req)));
}));

// Moving an entry to the record type it belongs in, and back (ADR-0015). Its owner's alone.
recordsRouter.post('/:table/:id/move', wrap((req, res) => {
  const table = tableParam(req);
  res.status(201).json(moveRecord(req.ctx, req.user, table, String(req.params.id), req.body, req, clientIp(req)));
}));

recordsRouter.post('/:table/:id/undo-move', wrap((req, res) => {
  const table = tableParam(req);
  res.json(undoMove(req.ctx, req.user, table, String(req.params.id), req, clientIp(req)));
}));

recordsRouter.get('/:table/:id/lineage', wrap((req, res) => {
  const table = tableParam(req);
  res.json(recordLineage(req.ctx, req.user, table, String(req.params.id), req));
}));

recordsRouter.post('/activities/:id/keep', wrap((req, res) => res.json(keepAsActivity(req.ctx, req.user, String(req.params.id), req, clientIp(req)))));

// A duty's review (ADR-0024): a decision on it, or sending it back for one, and the history of both.
recordsRouter.post('/duties/:id/review', wrap((req, res) => res.json(reviewDuty(req.ctx, req.user, String(req.params.id), req.body, req, clientIp(req)))));
recordsRouter.get('/duties/:id/reviews', wrap((req, res) => res.json(dutyReviewHistory(req.ctx, req.user, String(req.params.id), req, clientIp(req)))));

// A counseling's workflow (ADR-0027): sharing a draft with its Marine and taking it back, finalizing it, amending a final
// one, and its Marine acknowledging it; each against the version its asker saw. Then its amendment history and worksheet.
recordsRouter.post('/counselings/:id/share', wrap((req, res) => res.json(shareCounseling(req.ctx, req.user, String(req.params.id), req.body, req, clientIp(req)))));
recordsRouter.post('/counselings/:id/withdraw', wrap((req, res) => res.json(withdrawCounseling(req.ctx, req.user, String(req.params.id), req.body, req, clientIp(req)))));
recordsRouter.post('/counselings/:id/finalize', wrap((req, res) => res.json(finalizeCounseling(req.ctx, req.user, String(req.params.id), req.body, req, clientIp(req)))));
recordsRouter.post('/counselings/:id/amend', wrap((req, res) => res.json(amendCounseling(req.ctx, req.user, String(req.params.id), req.body, req, clientIp(req)))));
recordsRouter.post('/counselings/:id/acknowledge', wrap((req, res) => res.json(acknowledgeCounseling(req.ctx, req.user, String(req.params.id), req.body, req, clientIp(req)))));
recordsRouter.get('/counselings/:id/revisions', wrap((req, res) => res.json(counselingRevisions(req.ctx, req.user, String(req.params.id), req, clientIp(req)))));
recordsRouter.get('/counselings/:id/worksheet', wrap((req, res) => {
  const revision = req.query.revision === undefined ? null : Number(req.query.revision);
  res.json(counselingWorksheet(req.ctx, req.user, String(req.params.id), { revision, purpose: req.query.purpose === 'print' ? 'print' : 'view' }, req, clientIp(req)));
}));

// Files on records, and a training's evidence (ADR-0025). Whoever may open the record may list and open its files;
// whoever may edit it may add one, correct what is said about one, and remove one. Nothing here asks for a permission
// of its own: a file is exactly as reachable as the record it hangs on.
const attachmentBody = (req: express.Request, res: express.Response, next: express.NextFunction) =>
  express.raw({ type: () => true, limit: req.ctx.config.attachments.maxBytes })(req, res, next);

function attachableRecord(req: express.Request, needEdit = false, again = false) {
  const table = tableParam(req);
  if (!isAttachable(table)) throw notFound('That record type does not take attachments.');
  const row = getRecord(req.ctx, table, String(req.params.id));
  if (!row) throw notFound('No such record.');
  // `again`: the caller's roles and memberships as they are now, not as this request first read them.
  const scope = again ? scopeFor(req.ctx, req.user) : scopeFor(req.ctx, req.user, req);
  // A counseling draft, or one shared for review, is not there for anyone else: the same 404 as an id that is not (ADR-0027).
  if (!canRead(scope, req.user.id, row)) throw unfinalized(row) ? notFound('No such record.') : forbidden('You cannot read attachments for that record.');
  // A final counseling's counselor keeps its files, a signed worksheet among them, though its words no longer change (ADR-0027).
  if (needEdit && !(table === 'counselings' ? mayManageCounselingFiles(req.ctx, scope, req.user.id, row) : canEdit(scope, req.user.id, row))) throw forbidden('That record is not yours to update.');
  return { table, row };
}

/** A record that may take a new file now: attachments on for the service, the record editable, its Unit Instance not withheld (ADR-0014). */
function uploadTarget(req: express.Request, again = false) {
  if (!req.ctx.runtime.attachmentsEnabled) throw notFound('Attachments are not enabled.');
  const { table, row } = attachableRecord(req, true, again);
  if (!featureOn(req.ctx, 'attachments', row.unit_id, row.user_id)) throw forbidden('Vantage has turned file attachments off for this Unit Instance. Files already attached stay readable.', 'feature_withheld');
  return { table, row };
}

const KIND_WORDS = EVIDENCE_KINDS.map((k) => EVIDENCE_KIND_LABELS[k].toLowerCase()).join(', ');

/**
 * What an upload says about its file, sent beside its name because the body is the file: its evidence type, and its
 * description percent-encoded as the name is. A training's file says what it is; a file on any other record type has no
 * evidence type to give.
 */
function uploadDetails(req: express.Request, table: string): { kind: EvidenceKind | null; description: string | null } {
  let description: string | undefined = req.get('x-vantage-description');
  if (description !== undefined) {
    try { description = decodeURIComponent(description); }
    catch { throw badRequest('The description could not be read.', { fieldErrors: { description: 'The description could not be read. Type it as plain text.' } }); }
  }
  const details = parse(attachmentDetailsSchema, { kind: String(req.get('x-vantage-evidence-kind') ?? '').trim().toLowerCase(), description });
  if (takesEvidenceKind(table) && !details.kind) throw badRequest(`Choose what this file is: ${KIND_WORDS}.`, { fieldErrors: { kind: 'Choose what this file is.' } });
  if (!takesEvidenceKind(table) && details.kind) throw badRequest('Only a training’s files take an evidence type.', { fieldErrors: { kind: 'Only a training’s files take an evidence type.' } });
  return { kind: details.kind ?? null, description: details.description ?? null };
}

const ATTACHMENT_SELECT = `SELECT a.id, a.record_table, a.record_id, a.original_name, a.mime_type, a.size_bytes, a.sha256, a.created_at, a.kind, a.description, a.uploaded_by,
                                  u.last_name AS uploader_last, r.abbr AS uploader_rank
                             FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by LEFT JOIN ranks r ON r.id = u.rank_id`;
type AttachmentRecord = Omit<AttachmentRow, 'uploader_name'> & { uploader_last: string | null; uploader_rank: string | null };
/** A file as the API returns it: what is tracked about it, and who added it by rank and name. Never its content. */
const attachmentMeta = ({ uploader_last, uploader_rank, ...a }: AttachmentRecord): AttachmentRow => ({ ...a, uploader_name: uploader_last ? `${uploader_rank ? `${uploader_rank} ` : ''}${uploader_last}` : null });
const liveAttachment = (req: express.Request, table: string, recordId: string) =>
  req.ctx.db.prepare(`${ATTACHMENT_SELECT} WHERE a.id = ? AND a.record_table = ? AND a.record_id = ? AND a.deleted_at IS NULL`).get(String(req.params.attachmentId), table, recordId) as AttachmentRecord | undefined;
const liveCount = (req: express.Request, table: string, recordId: string) =>
  (req.ctx.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE record_table = ? AND record_id = ? AND deleted_at IS NULL').get(table, recordId) as { n: number }).n;

recordsRouter.get('/:table/:id/attachments', wrap((req, res) => {
  const { table, row } = attachableRecord(req);
  const rows = req.ctx.db.prepare(`${ATTACHMENT_SELECT} WHERE a.record_table = ? AND a.record_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at DESC, a.id`).all(table, row.id) as AttachmentRecord[];
  // On for this record only where the service has attachments on and Vantage has not turned them off for its Unit Instance (ADR-0014).
  const body: AttachmentsResponse = { attachments: rows.map(attachmentMeta), enabled: featureOn(req.ctx, 'attachments', row.unit_id, row.user_id), maxBytes: req.ctx.config.attachments.maxBytes, maxPerRecord: req.ctx.config.attachments.maxPerRecord, allowedTypes: req.ctx.config.attachments.allowedTypes };
  res.json(body);
}));

// Who may add the file, and what is said about it, are settled before the file is read: a caller who may not is refused
// without the server taking in a body up to the size limit. The handler decides again once it has the file.
recordsRouter.post('/:table/:id/attachments', wrap((req, _res, next) => { uploadDetails(req, uploadTarget(req).table); next(); }), attachmentBody, wrap(async (req, res) => {
  const ctx = req.ctx;
  const { table, row } = uploadTarget(req);
  const details = uploadDetails(req, table);
  const limit = ctx.config.attachments.maxPerRecord;
  const full = () => conflict(`A record can hold at most ${limit} attachments.`, 'attachment_limit');
  if (liveCount(req, table, row.id) >= limit) throw full();
  const inspected = inspectAttachment({ body: req.body, filename: filenameFromHeader(req.get('x-vantage-filename')), contentType: req.get('content-type'), allowedTypes: ctx.config.attachments.allowedTypes, maxBytes: ctx.config.attachments.maxBytes });
  if (!inspected.ok) throw badRequest(inspected.error);
  try { if (ctx.db.name !== ':memory:' && statSync(ctx.db.name).size + inspected.size >= ctx.config.limits.maxDatabaseBytes) throw new HttpError(507, 'The database is too close to its safety threshold for that file.', 'database_capacity'); } catch (e) { if (e instanceof HttpError) throw e; }
  // Evidence is scanned like any other upload: a rejected file is never stored.
  try { await scanUpload(ctx.config.intake, req.body as Buffer, inspected.filename); }
  catch (e) {
    // The trail holds what the scanner found, never the file's name.
    if (e instanceof MalwareRejected) audit(ctx, { actor_id: req.user.id, action: 'upload_rejected', entity: table, entity_id: row.id, subject_id: row.user_id !== req.user.id ? row.user_id : null, unit_id: row.unit_id, detail: `rejected by the malware scanner: ${e.finding}`.slice(0, 300), ip: clientIp(req) });
    throw e;
  }
  // The scan awaits; the entry may have moved to another record type meanwhile (ADR-0015), been deleted, been decided or
  // frozen, or taken its last file, and the caller may have signed out, been reset or deactivated, or lost the role or
  // the membership that let them add to it. Everything is decided again here, with nothing awaited between it and
  // the insert, so the file never lands on an entry that is gone or that the caller may no longer add to.
  // First, the session that sent the file must still stand, as it must for any request.
  if (!sessionStands(ctx, req.sessionId)) throw unauthorized();
  if (!ctx.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(row.id)) {
    throw conflict('This entry moved while the file was being scanned. Add the file to it where it is now.', 'record_moved');
  }
  // Then the caller's authority, read afresh.
  const current = uploadTarget(req, true).row;
  if (liveCount(req, table, current.id) >= limit) throw full();
  const id = newId();
  try {
    // The file keeps the unit its record sits in now, so a later move is judged by where it was added (ADR-0008).
    ctx.db.prepare('INSERT INTO attachments (id, record_table, record_id, uploaded_by, unit_id, original_name, mime_type, size_bytes, sha256, content, created_at, kind, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, table, current.id, req.user.id, current.unit_id ?? null, inspected.filename, inspected.mime, inspected.size, inspected.sha256, req.body, now(), details.kind, details.description);
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE')) throw conflict('That exact file is already attached.', 'duplicate_attachment');
    throw error;
  }
  // The trail names the file and what it is, never its name or what was written about it.
  audit(ctx, { actor_id: req.user.id, action: 'upload_attachment', entity: table, entity_id: current.id, subject_id: current.user_id !== req.user.id ? current.user_id : null, unit_id: current.unit_id, detail: `attachment ${id}; ${inspected.size} bytes; ${inspected.mime}${details.kind ? `; ${details.kind}` : ''}`, ip: clientIp(req) });
  const saved = ctx.db.prepare(`${ATTACHMENT_SELECT} WHERE a.id = ?`).get(id) as AttachmentRecord;
  res.status(201).json(attachmentMeta(saved));
}));

recordsRouter.get('/:table/:id/attachments/:attachmentId', wrap((req, res) => {
  const { table, row } = attachableRecord(req);
  const file = req.ctx.db.prepare('SELECT id, original_name, mime_type, size_bytes, content FROM attachments WHERE id = ? AND record_table = ? AND record_id = ? AND deleted_at IS NULL').get(String(req.params.attachmentId), table, row.id) as { id: string; original_name: string; mime_type: string; size_bytes: number; content: Buffer } | undefined;
  if (!file) throw notFound('No such attachment.');
  if (row.user_id !== req.user.id) audit(req.ctx, { actor_id: req.user.id, action: 'download_attachment', entity: table, entity_id: row.id, subject_id: row.user_id, unit_id: row.unit_id, detail: `attachment ${file.id}`, ip: clientIp(req) });
  res.setHeader('Content-Type', attachmentContentType(file.mime_type));
  res.setHeader('Content-Length', String(file.size_bytes));
  // Always a download, never a page: saved under its own name, never sniffed into another type, and, should a browser
  // show it all the same, shown with no script, no form and no origin of Vantage's.
  res.setHeader('Content-Disposition', attachmentDisposition(file.original_name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  res.send(file.content);
}));

// What is said about a file is corrected in place (ADR-0025): what it is evidence of, and its description. The file
// itself never changes; its name, content and hash stay as they were added.
recordsRouter.put('/:table/:id/attachments/:attachmentId', wrap((req, res) => {
  const { table, row } = attachableRecord(req, true);
  const patch = parse(attachmentDetailsSchema, req.body);
  const file = liveAttachment(req, table, row.id);
  if (!file) throw notFound('No such attachment.');
  // A training's file may be given a type or another type, never have it taken away; a file that came to another record
  // type with a moved entry may only lose the type it carried.
  if (takesEvidenceKind(table) && patch.kind === null) throw badRequest(`Choose what this file is: ${KIND_WORDS}.`, { fieldErrors: { kind: 'Choose what this file is.' } });
  if (!takesEvidenceKind(table) && patch.kind) throw badRequest('Only a training’s files take an evidence type.', { fieldErrors: { kind: 'Only a training’s files take an evidence type.' } });
  const next = { kind: patch.kind === undefined ? file.kind : patch.kind, description: patch.description === undefined ? file.description : patch.description };
  const changed = (['kind', 'description'] as const).filter((k) => next[k] !== file[k]);
  if (!changed.length) return res.json(attachmentMeta(file));
  req.ctx.db.prepare('UPDATE attachments SET kind = ?, description = ? WHERE id = ? AND record_table = ? AND record_id = ? AND deleted_at IS NULL').run(next.kind, next.description, file.id, table, row.id);
  // Which details changed, never what they say.
  audit(req.ctx, { actor_id: req.user.id, action: 'update_attachment', entity: table, entity_id: row.id, subject_id: row.user_id !== req.user.id ? row.user_id : null, unit_id: row.unit_id, detail: `attachment ${file.id}; changed ${changed.join(', ')}${changed.includes('kind') ? `; ${file.kind ?? 'none'} to ${next.kind ?? 'none'}` : ''}`, ip: clientIp(req) });
  res.json(attachmentMeta({ ...file, ...next }));
}));

recordsRouter.delete('/:table/:id/attachments/:attachmentId', wrap((req, res) => {
  const { table, row } = attachableRecord(req, true);
  const attachmentId = String(req.params.attachmentId);
  const r = req.ctx.db.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ? AND record_table = ? AND record_id = ? AND deleted_at IS NULL').run(now(), attachmentId, table, row.id);
  if (!r.changes) throw notFound('No such attachment.');
  audit(req.ctx, { actor_id: req.user.id, action: 'delete_attachment', entity: table, entity_id: row.id, subject_id: row.user_id !== req.user.id ? row.user_id : null, unit_id: row.unit_id, detail: `attachment ${attachmentId}`, ip: clientIp(req) });
  res.json({ ok: true });
}));

const commentArgs = (req: express.Request) => [
  req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.table), String(req.params.id),
] as const;

recordsRouter.get('/:table/:id/comments', wrap((req, res) => {
  res.json({ comments: listComments(...commentArgs(req)) });
}));

recordsRouter.post('/:table/:id/comments', wrap((req, res) => {
  res.status(201).json(addComment(...commentArgs(req), String(req.body?.body ?? ''), clientIp(req)));
}));

recordsRouter.put('/:table/:id/comments/:commentId', wrap((req, res) => {
  res.json(editComment(...commentArgs(req), String(req.params.commentId), String(req.body?.body ?? ''), clientIp(req)));
}));

recordsRouter.delete('/:table/:id/comments/:commentId', wrap((req, res) => {
  res.json(deleteComment(...commentArgs(req), String(req.params.commentId), clientIp(req)));
}));
