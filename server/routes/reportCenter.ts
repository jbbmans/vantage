import { Router } from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor } from '../authz/scope.ts';
import { REPORT_FILE_FORMATS, REPORT_TYPES, reportQuerySchema } from '../../shared/reportCatalog.ts';
import { deleteDefinition, exportReport, listDefinitions, runReport, saveDefinition } from '../services/reportCenter.ts';

/**
 * The report center (Task 14, ADR-0020). Every report is one document: /run answers it for the screen and the print page,
 * /export draws it into a file. Whom a report may be about, and what may leave as a file, is decided in
 * server/services/reportCenter.ts before anything is read.
 */
export const reportCenterRouter = Router();
reportCenterRouter.use(requireAuth);

const runSchema = reportQuerySchema.extend({ purpose: z.enum(['view', 'print']).default('view') });
const exportSchema = reportQuerySchema.extend({ format: z.enum(REPORT_FILE_FORMATS).default('pdf') });

reportCenterRouter.get('/run', wrap((req, res) => {
  const { purpose, ...q } = parse(runSchema, req.query);
  res.json(runReport(req.ctx, req.user, scopeFor(req.ctx, req.user, req), q, purpose, clientIp(req)));
}));

reportCenterRouter.get('/export', wrap(async (req, res) => {
  const { format, ...q } = parse(exportSchema, req.query);
  const file = await exportReport(req.ctx, req.user, scopeFor(req.ctx, req.user, req), q, format, clientIp(req));
  res.setHeader('Content-Type', file.contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
  res.send(file.body);
}));

// ——— Saved reports: the choices, never the data ———

const definitionSchema = z.object({
  name: z.string().max(200),
  type: z.enum(REPORT_TYPES),
  params: z.record(z.string(), z.unknown()).default({}),
  visibility: z.enum(['private', 'unit']).optional(),
  unit_id: z.string().max(64).nullable().optional(),
});

reportCenterRouter.get('/definitions', wrap((req, res) => {
  res.json(listDefinitions(req.ctx, req.user, scopeFor(req.ctx, req.user, req)));
}));

reportCenterRouter.post('/definitions', wrap((req, res) => {
  const body = parse(definitionSchema, req.body);
  res.status(201).json(saveDefinition(req.ctx, req.user, scopeFor(req.ctx, req.user, req), body, undefined, clientIp(req)));
}));

reportCenterRouter.put('/definitions/:id', wrap((req, res) => {
  const body = parse(definitionSchema, req.body);
  res.json(saveDefinition(req.ctx, req.user, scopeFor(req.ctx, req.user, req), body, String(req.params.id), clientIp(req)));
}));

reportCenterRouter.delete('/definitions/:id', wrap((req, res) => {
  deleteDefinition(req.ctx, req.user, String(req.params.id), clientIp(req));
  res.status(204).end();
}));
