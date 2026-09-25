import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest } from '../lib/errors.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor } from '../authz/scope.ts';
import { audit } from '../services/audit.ts';
import { scannerFor } from '../services/scanner.ts';
import {
  uploadSource, inspectSource, previewImport, runImport, readableSource,
  MAPPABLE_FIELDS, type ImportPlan,
} from '../services/intake.ts';
import {
  listItems, itemDetail, claimItem, releaseItem, assignItem, createItem, updateItem, recordAction,
  listViews, saveView, deleteView, WORK_STATES, ACTION_KINDS,
} from '../services/work.ts';
import { recordEntry, changeStage, handOff, calculate, applyProcedure, handoffCandidates } from '../services/cases.ts';
import { teamWorkload, parseWindow } from '../services/record.ts';
import { forbidden } from '../lib/errors.ts';
import { PROCEDURES, PROCEDURE_LIST, PROCEDURE_VERSIONS, suggestProcedure } from '../../shared/procedures.ts';
import { STAGES } from '../../shared/caseModel.ts';

export const workRouter = Router();
workRouter.use(requireAuth);

const uploadBody: express.RequestHandler = (req, res, next) =>
  express.raw({ type: () => true, limit: req.ctx.config.intake.maxBytes })(req, res, next);

workRouter.post('/sources', uploadBody, wrap(async (req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const filename = String(req.get('x-filename') || 'upload').slice(0, 255);
  const unitId = req.get('x-unit-id') ? String(req.get('x-unit-id')) : null;
  const visibility = req.get('x-visibility') === 'private' ? 'private' : 'unit';
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const row = await uploadSource(req.ctx, req.user, scope, scannerFor({ command: req.ctx.config.intake.scannerCommand }), {
    filename, contentType: String(req.get('content-type') || 'application/octet-stream'), buffer, unitId, visibility,
  });
  audit(req.ctx, { actor_id: req.user.id, action: 'upload_source', entity: 'source_files', entity_id: row.id, unit_id: row.unit_id, detail: `${row.filename} (${row.byte_size} bytes, scan ${row.scan_status})`, ip: clientIp(req) });
  res.status(201).json(row);
}));

workRouter.get('/sources', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const units = scope.readableUnitIds;
  const rows = units.length
    ? req.ctx.db.prepare(`SELECT id, user_id, unit_id, visibility, filename, kind, byte_size, sha256, scan_status, scan_detail, scanner, scanned_at, created_at FROM source_files WHERE deleted_at IS NULL AND (user_id = ? OR (visibility = 'unit' AND unit_id IN (${units.map(() => '?').join(',')}))) ORDER BY created_at DESC LIMIT 100`).all(req.user.id, ...units)
    : req.ctx.db.prepare('SELECT id, user_id, unit_id, visibility, filename, kind, byte_size, sha256, scan_status, scan_detail, scanner, scanned_at, created_at FROM source_files WHERE deleted_at IS NULL AND user_id = ? ORDER BY created_at DESC LIMIT 100').all(req.user.id);
  res.json(rows);
}));

workRouter.get('/sources/:id', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const row = readableSource(req.ctx, req.user, scope, String(req.params.id));
  res.json({ source: row, ...inspectSource(req.ctx, row) });
}));

const planSchema = z.object({
  source_file_id: z.string().max(64),
  sheet_name: z.string().max(200),
  header_row: z.coerce.number().int().min(1).max(100).default(1),
  key_columns: z.array(z.string().max(200)).min(1).max(4),
  mapping: z.record(z.string().max(200), z.enum([...MAPPABLE_FIELDS, 'ignore', 'keep'])).default({}),
  unit_id: z.string().max(64).nullable().default(null),
  visibility: z.enum(['private', 'unit']).default('unit'),
  procedure: z.string().max(60).nullable().optional().refine((v) => !v || v === 'auto' || Boolean(PROCEDURES[v]), 'No such procedure.'),
});

const planFrom = (body: unknown): { plan: ImportPlan; sourceId: string } => {
  const q = parse(planSchema, body);
  return {
    sourceId: q.source_file_id,
    plan: { sheet_name: q.sheet_name, header_row: q.header_row, headers: [], key_columns: q.key_columns, mapping: q.mapping, unit_id: q.unit_id, visibility: q.visibility, procedure: q.procedure ?? null },
  };
};

workRouter.post('/imports/preview', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const { plan, sourceId } = planFrom(req.body);
  res.json(previewImport(req.ctx, req.user, scope, plan, sourceId));
}));

workRouter.post('/imports', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const { plan, sourceId } = planFrom(req.body);
  const key = req.get('idempotency-key') ? String(req.get('idempotency-key')).slice(0, 120) : null;
  const job = runImport(req.ctx, req.user, scope, plan, sourceId, key);
  audit(req.ctx, { actor_id: req.user.id, action: 'run_import', entity: 'import_jobs', entity_id: job.id, unit_id: job.unit_id, detail: `${job.inserted_rows} new, ${job.updated_rows} updated, ${job.unchanged_rows} unchanged, ${job.rejected_rows} rejected`, ip: clientIp(req) });
  res.status(201).json(job);
}));

workRouter.get('/imports', wrap((req, res) => {
  const rows = req.ctx.db.prepare('SELECT * FROM import_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  res.json(rows);
}));

workRouter.get('/imports/:id', wrap((req, res) => {
  const row = req.ctx.db.prepare('SELECT * FROM import_jobs WHERE id = ? AND user_id = ?').get(String(req.params.id), req.user.id);
  if (!row) throw badRequest('No such import.');
  res.json(row);
}));

const listSchema = z.object({
  unit_id: z.string().max(64).optional(),
  state: z.enum(WORK_STATES).optional(),
  stage: z.enum(STAGES).optional(),
  active: z.enum(['1', 'true']).optional(),
  claimed: z.enum(['me', 'anyone', 'nobody']).optional(),
  q: z.string().max(200).optional(),
  project_id: z.string().max(64).optional(),
  // A procedure key, or 'none' for work that follows no procedure.
  procedure: z.string().max(60).optional(),
  due_before: z.string().max(10).optional(),
  sort: z.string().max(40).optional(),
  direction: z.enum(['asc', 'desc']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

workRouter.get('/items', wrap((req, res) => {
  const q = parse(listSchema, req.query);
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(listItems(req.ctx, req.user, scope, {
    unitId: q.unit_id ?? null, state: q.state ?? null, stage: q.stage ?? null, active: Boolean(q.active), claimed: q.claimed ?? null, q: q.q ?? null, projectId: q.project_id ?? null,
    procedure: q.procedure ?? null,
    dueBefore: q.due_before ?? null, sort: q.sort ?? null, direction: q.direction, limit: q.limit, offset: q.offset,
  }));
}));

const createSchema = z.object({
  unit_id: z.string().max(64).nullable().optional(),
  title: z.string().max(300),
  reference: z.string().max(200).nullable().optional(),
  due_date: z.string().max(40).nullable().optional(),
  project_id: z.string().max(64).nullable().optional(),
  visibility: z.enum(['private', 'unit']).optional(),
});

workRouter.post('/items', wrap((req, res) => {
  const q = parse(createSchema, req.body);
  const scope = scopeFor(req.ctx, req.user, req);
  res.status(201).json(createItem(req.ctx, req.user, scope, {
    unit_id: q.unit_id ?? null, title: q.title, reference: q.reference ?? null,
    due_date: q.due_date ?? null, project_id: q.project_id ?? null, visibility: q.visibility,
  }));
}));

workRouter.get('/items/:id', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(itemDetail(req.ctx, req.user, scope, String(req.params.id)));
}));

const versionOf = (body: unknown) => {
  const v = (body as { version?: unknown })?.version;
  return v == null ? null : Number(v);
};

workRouter.post('/items/:id/claim', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const item = claimItem(req.ctx, req.user, scope, String(req.params.id), versionOf(req.body));
  res.json(item);
}));

workRouter.post('/items/:id/release', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(releaseItem(req.ctx, req.user, scope, String(req.params.id), versionOf(req.body)));
}));

workRouter.post('/items/:id/assign', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const to = String(req.body?.user_id || '');
  res.json(assignItem(req.ctx, req.user, scope, String(req.params.id), to, versionOf(req.body)));
}));

const patchSchema = z.object({
  state: z.enum(WORK_STATES).optional(),
  acknowledge_source_change: z.boolean().optional(),
  title: z.string().max(300).optional(),
  reference: z.string().max(200).nullable().optional(),
  due_date: z.string().max(40).nullable().optional(),
  project_id: z.string().max(64).nullable().optional(),
  version: z.coerce.number().int().optional(),
});

workRouter.patch('/items/:id', wrap((req, res) => {
  const q = parse(patchSchema, req.body);
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(updateItem(req.ctx, req.user, scope, String(req.params.id), {
    state: q.state, acknowledge_source_change: q.acknowledge_source_change,
    title: q.title, reference: q.reference, due_date: q.due_date, project_id: q.project_id,
  }, q.version ?? null));
}));

const actionSchema = z.object({
  kind: z.enum(ACTION_KINDS).default('worked'),
  note: z.string().max(5000).nullable().optional(),
  occurred_at: z.string().max(10).nullable().optional(),
  quantity: z.coerce.number().nullable().optional(),
  unit_label: z.string().max(60).nullable().optional(),
  dollar_amount: z.coerce.number().nullable().optional(),
  dollar_type: z.string().max(60).nullable().optional(),
  draft_record: z.boolean().default(false),
  resolve: z.boolean().default(false),
  category: z.string().max(120).nullable().optional(),
  eval_area: z.string().max(120).nullable().optional(),
});

workRouter.post('/items/:id/actions', wrap((req, res) => {
  const q = parse(actionSchema, req.body);
  const scope = scopeFor(req.ctx, req.user, req);
  const key = req.get('idempotency-key') ? String(req.get('idempotency-key')).slice(0, 120) : null;
  const result = recordAction(req.ctx, req.user, scope, String(req.params.id), q, key);
  if (!result.replayed) {
    audit(req.ctx, { actor_id: req.user.id, action: 'work_action', entity: 'work_items', entity_id: String(req.params.id), unit_id: result.item.unit_id, detail: q.kind, ip: clientIp(req) });
  }
  res.status(result.replayed ? 200 : 201).json(result);
}));

workRouter.get('/workload', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const unitId = String(req.query.unit_id || '');
  if (!unitId) throw forbidden('Choose a unit.');
  res.json(teamWorkload(req.ctx, req.user, scope, unitId, parseWindow(req.query as Record<string, unknown>, 30)));
}));

workRouter.get('/procedures', wrap((_req, res) => {
  res.json(PROCEDURE_LIST.map((p) => ({
    key: p.key, version: p.version, title: p.title, short: p.short, family: p.family, trigger: p.trigger, objective: p.objective,
    authority: p.authority, references: p.references || [], steps: p.steps.length,
    versions: Object.keys(PROCEDURE_VERSIONS[p.key] || {}),
  })));
}));

workRouter.get('/procedures/:key', wrap((req, res) => {
  const versions = PROCEDURE_VERSIONS[String(req.params.key)];
  if (!versions) throw badRequest('No such procedure.');
  res.json({ current: PROCEDURES[String(req.params.key)], versions: Object.values(versions) });
}));

workRouter.get('/items/:id/suggestion', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const detail = itemDetail(req.ctx, req.user, scope, String(req.params.id));
  const data = detail.item.data as Record<string, string>;
  res.json(suggestProcedure(detail.item.title, detail.item.reference, ...Object.values(data || {})));
}));

workRouter.post('/items/:id/entries', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const key = req.get('idempotency-key') ? String(req.get('idempotency-key')).slice(0, 120) : null;
  const result = recordEntry(req.ctx, req.user, scope, String(req.params.id), req.body, key);
  res.status(result.replayed ? 200 : 201).json(result);
}));

workRouter.post('/items/:id/stage', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(changeStage(req.ctx, req.user, scope, String(req.params.id), req.body));
}));

workRouter.get('/items/:id/handoff-candidates', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(handoffCandidates(req.ctx, req.user, scope, String(req.params.id)));
}));

workRouter.post('/items/:id/handoff', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(handOff(req.ctx, req.user, scope, String(req.params.id), req.body));
}));

workRouter.post('/items/:id/calculate', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const step = typeof req.body?.step === 'string' ? req.body.step.slice(0, 60) : null;
  res.status(201).json(calculate(req.ctx, req.user, scope, String(req.params.id), step));
}));

workRouter.post('/items/:id/procedure', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const key = String((req.body as { key?: unknown })?.key || '');
  res.json(applyProcedure(req.ctx, req.user, scope, String(req.params.id), key));
}));

workRouter.get('/views', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(listViews(req.ctx, req.user, scope));
}));

const viewSchema = z.object({
  id: z.string().max(64).nullable().optional(),
  name: z.string().max(80),
  unit_id: z.string().max(64).nullable().optional(),
  shared: z.boolean().optional(),
  config: z.unknown().optional(),
});

workRouter.post('/views', wrap((req, res) => {
  const q = parse(viewSchema, req.body);
  const scope = scopeFor(req.ctx, req.user, req);
  res.status(201).json(saveView(req.ctx, req.user, scope, { id: q.id ?? null, name: q.name, unit_id: q.unit_id ?? null, shared: q.shared, config: q.config }));
}));

workRouter.delete('/views/:id', wrap((req, res) => {
  deleteView(req.ctx, req.user, String(req.params.id));
  res.status(204).end();
}));
