import { Router } from 'express';
import express from 'express';
import { wrap, clientIp } from '../lib/http.ts';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor } from '../authz/scope.ts';
import { canEdit, canRead } from '../authz/records.ts';
import { isRecordTable, listRecords, createRecord, updateRecord, deleteRecord, restoreRecord, readableRecord, importActivities, getRecord, withGoalProgress } from '../services/records.ts';
import { inspectAttachment, attachmentDisposition } from '../services/attachments.ts';
import { audit } from '../services/audit.ts';
import { newId, now } from '../lib/ids.ts';
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
  // Cross-person reads are audited once per subject per 5 minutes so leaders see they are accountable without flooding the log.
  const foreign = new Map<string, number>();
  for (const r of rows) if (r.user_id !== req.user.id) foreign.set(String(r.user_id), (foreign.get(String(r.user_id)) || 0) + 1);
  if (foreign.size) {
    const recent = req.ctx.db.prepare(`SELECT 1 FROM audit_log WHERE actor_id = ? AND action = 'list_records' AND entity = ? AND subject_id = ? AND at > ? LIMIT 1`);
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    for (const [subject, count] of foreign) if (!recent.get(req.user.id, table, subject, cutoff)) audit(req.ctx, { actor_id: req.user.id, action: 'list_records', entity: table, subject_id: subject, detail: `${count} rows`, ip: clientIp(req) });
  }
  res.json(rows);
}));

recordsRouter.post('/activities/import', wrap((req, res) => {
  res.json(importActivities(req.ctx, req.user, req.body?.rows, req, clientIp(req)));
}));

recordsRouter.get('/:table/:id', wrap((req, res) => {
  const table = tableParam(req);
  const raw = readableRecord(req.ctx, req.user, table, String(req.params.id), req);
  const row = table === 'goals' ? withGoalProgress(req.ctx, [raw])[0] : raw;
  if (row.user_id !== req.user.id) audit(req.ctx, { actor_id: req.user.id, action: 'view_record', entity: table, entity_id: row.id, subject_id: row.user_id, unit_id: row.unit_id, ip: clientIp(req) });
  res.json(row);
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

recordsRouter.post('/counselings/:id/acknowledge', wrap((req, res) => {
  const row = getRecord(req.ctx, 'counselings', String(req.params.id));
  if (!row) throw notFound('No such counseling.');
  if (row.user_id !== req.user.id) throw forbidden('Only the counseled Marine can acknowledge.');
  req.ctx.db.prepare('UPDATE counselings SET acknowledged_at = COALESCE(acknowledged_at, ?), updated_at = ?, version = version + 1 WHERE id = ?').run(now(), now(), row.id);
  audit(req.ctx, { actor_id: req.user.id, action: 'acknowledge_counseling', entity: 'counselings', entity_id: row.id, unit_id: row.unit_id, ip: clientIp(req) });
  res.json(getRecord(req.ctx, 'counselings', row.id));
}));

// Attachments ----------------------------------------------------------
const ATTACHABLE = new Set(['activities', 'awards', 'counselings', 'trainings']);
const attachmentBody = (req: express.Request, res: express.Response, next: express.NextFunction) =>
  express.raw({ type: () => true, limit: req.ctx.config.attachments.maxBytes })(req, res, next);

function attachableRecord(req: express.Request, needEdit = false) {
  const table = tableParam(req);
  if (!ATTACHABLE.has(table)) throw notFound('That record type does not take attachments.');
  const row = getRecord(req.ctx, table, String(req.params.id));
  if (!row) throw notFound('No such record.');
  const scope = scopeFor(req.ctx, req.user, req);
  if (!canRead(scope, req.user.id, row)) throw forbidden('You cannot read attachments for that record.');
  if (needEdit && !canEdit(scope, req.user.id, row)) throw forbidden('That record is not yours to update.');
  return { table, row };
}

const attachmentMeta = (r: Record<string, unknown>) => ({ id: r.id, record_table: r.record_table, record_id: r.record_id, original_name: r.original_name, mime_type: r.mime_type, size_bytes: r.size_bytes, sha256: r.sha256, created_at: r.created_at });

recordsRouter.get('/:table/:id/attachments', wrap((req, res) => {
  const { table, row } = attachableRecord(req);
  const rows = req.ctx.db.prepare('SELECT id, record_table, record_id, original_name, mime_type, size_bytes, sha256, created_at FROM attachments WHERE record_table = ? AND record_id = ? AND deleted_at IS NULL ORDER BY created_at DESC').all(table, row.id) as Array<Record<string, unknown>>;
  res.json({ attachments: rows.map(attachmentMeta), enabled: req.ctx.runtime.attachmentsEnabled, maxBytes: req.ctx.config.attachments.maxBytes, allowedTypes: req.ctx.config.attachments.allowedTypes });
}));

recordsRouter.post('/:table/:id/attachments', attachmentBody, wrap((req, res) => {
  const ctx = req.ctx;
  if (!ctx.runtime.attachmentsEnabled) throw notFound('Attachments are not enabled.');
  const { table, row } = attachableRecord(req, true);
  const count = (ctx.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE record_table = ? AND record_id = ? AND deleted_at IS NULL').get(table, row.id) as { n: number }).n;
  if (count >= ctx.config.attachments.maxPerRecord) throw conflict(`A record can hold at most ${ctx.config.attachments.maxPerRecord} attachments.`, 'attachment_limit');
  const inspected = inspectAttachment({ body: req.body, filename: req.get('x-vantage-filename'), contentType: req.get('content-type'), allowedTypes: ctx.config.attachments.allowedTypes, maxBytes: ctx.config.attachments.maxBytes });
  if (!inspected.ok) throw badRequest(inspected.error);
  try { if (ctx.db.name !== ':memory:' && statSync(ctx.db.name).size + inspected.size >= ctx.config.limits.maxDatabaseBytes) throw new HttpError(507, 'The database is too close to its safety threshold for that file.', 'database_capacity'); } catch (e) { if (e instanceof HttpError) throw e; }
  const id = newId();
  try {
    ctx.db.prepare('INSERT INTO attachments (id, record_table, record_id, uploaded_by, original_name, mime_type, size_bytes, sha256, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, table, row.id, req.user.id, inspected.filename, inspected.mime, inspected.size, inspected.sha256, req.body, now());
  } catch (error) {
    if (String((error as Error).message).includes('UNIQUE')) throw conflict('That exact file is already attached.', 'duplicate_attachment');
    throw error;
  }
  audit(ctx, { actor_id: req.user.id, action: 'upload_attachment', entity: table, entity_id: row.id, subject_id: row.user_id !== req.user.id ? row.user_id : null, unit_id: row.unit_id, detail: `${inspected.size} bytes; ${inspected.mime}`, ip: clientIp(req) });
  const saved = ctx.db.prepare('SELECT id, record_table, record_id, original_name, mime_type, size_bytes, sha256, created_at FROM attachments WHERE id = ?').get(id) as Record<string, unknown>;
  res.status(201).json(attachmentMeta(saved));
}));

recordsRouter.get('/:table/:id/attachments/:attachmentId', wrap((req, res) => {
  const { table, row } = attachableRecord(req);
  const file = req.ctx.db.prepare('SELECT * FROM attachments WHERE id = ? AND record_table = ? AND record_id = ? AND deleted_at IS NULL').get(String(req.params.attachmentId), table, row.id) as { id: string; original_name: string; mime_type: string; size_bytes: number; content: Buffer } | undefined;
  if (!file) throw notFound('No such attachment.');
  if (row.user_id !== req.user.id) audit(req.ctx, { actor_id: req.user.id, action: 'download_attachment', entity: table, entity_id: row.id, subject_id: row.user_id, unit_id: row.unit_id, ip: clientIp(req) });
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('Content-Length', String(file.size_bytes));
  res.setHeader('Content-Disposition', attachmentDisposition(file.original_name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(file.content);
}));

recordsRouter.delete('/:table/:id/attachments/:attachmentId', wrap((req, res) => {
  const { table, row } = attachableRecord(req, true);
  const r = req.ctx.db.prepare('UPDATE attachments SET deleted_at = ? WHERE id = ? AND record_table = ? AND record_id = ? AND deleted_at IS NULL').run(now(), String(req.params.attachmentId), table, row.id);
  if (!r.changes) throw notFound('No such attachment.');
  audit(req.ctx, { actor_id: req.user.id, action: 'delete_attachment', entity: table, entity_id: row.id, unit_id: row.unit_id, ip: clientIp(req) });
  res.json({ ok: true });
}));
