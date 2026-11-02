import { Router } from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor } from '../authz/scope.ts';
import { isoDate } from '../../shared/schemas.ts';
import { COLUMN_ROLES, DRILLS, DRILL_GROUPS } from '../../shared/errorReports.ts';
import {
  drillRows, errorReportsOverview, fileSnapshot, lastLayout, previewSnapshot, reportChoices, viewComparison, withdrawSnapshot, type FilingPlan,
} from '../services/errorReports.ts';

/**
 * Financial error reports (Task 15, ADR-0021): a unit's series, filing a report from an upload, a comparison of two of a
 * series' reports, the rows behind each figure, and withdrawing a report filed in error. The file itself is uploaded and
 * scanned through /api/work/sources, as an import's is. Who may read or file is decided in server/services/errorReports.ts.
 */
export const errorReportsRouter = Router();
errorReportsRouter.use(requireAuth);

const id = z.string().trim().min(1).max(64);
const header = z.string().max(200);

errorReportsRouter.get('/', wrap((req, res) => {
  const q = parse(z.object({ unit_id: id }), req.query);
  res.json(errorReportsOverview(req.ctx, req.user, scopeFor(req.ctx, req.user, req), q.unit_id, clientIp(req)));
}));

/** The types and report days a unit's comparison may be run on, for the report library: no figures. */
errorReportsRouter.get('/choices', wrap((req, res) => {
  const q = parse(z.object({ unit_id: id }), req.query);
  res.json(reportChoices(req.ctx, scopeFor(req.ctx, req.user, req), q.unit_id));
}));

errorReportsRouter.get('/layout', wrap((req, res) => {
  const q = parse(z.object({ unit_id: id, type_id: id }), req.query);
  res.json({ layout: lastLayout(req.ctx, scopeFor(req.ctx, req.user, req), q.unit_id, q.type_id) });
}));

const planSchema = z.object({
  unit_id: id,
  type_id: id,
  as_of: isoDate,
  source_file_id: id,
  sheet_name: z.string().max(200),
  header_row: z.coerce.number().int().min(1).max(100).default(1),
  key_columns: z.array(header).min(1, 'Choose the column that identifies each row.').max(2, 'Identify a row by one column, or two together.'),
  columns: z.record(header, z.enum(COLUMN_ROLES)).default({}),
  closed_statuses: z.array(z.string().max(80)).max(100).default([]),
  note: z.string().max(500).nullish(),
});

errorReportsRouter.post('/preview', wrap((req, res) => {
  res.json(previewSnapshot(req.ctx, req.user, scopeFor(req.ctx, req.user, req), parse(planSchema, req.body) as FilingPlan));
}));

errorReportsRouter.post('/snapshots', wrap((req, res) => {
  res.status(201).json(fileSnapshot(req.ctx, req.user, scopeFor(req.ctx, req.user, req), parse(planSchema, req.body) as FilingPlan, clientIp(req)));
}));

errorReportsRouter.post('/snapshots/:id/withdraw', wrap((req, res) => {
  const body = parse(z.object({ reason: z.string().max(500) }), req.body);
  res.json(withdrawSnapshot(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id), body.reason, clientIp(req)));
}));

const comparisonSchema = z.object({ unit_id: id, type_id: id, snapshot: id.optional(), against: id.optional() });

errorReportsRouter.get('/series', wrap((req, res) => {
  res.json(viewComparison(req.ctx, req.user, scopeFor(req.ctx, req.user, req), parse(comparisonSchema, req.query), clientIp(req)));
}));

errorReportsRouter.get('/rows', wrap((req, res) => {
  const q = parse(comparisonSchema.extend({ drill: z.enum(DRILLS), group: z.enum(DRILL_GROUPS).optional(), value: z.string().max(300).optional() }), req.query);
  res.json(drillRows(req.ctx, req.user, scopeFor(req.ctx, req.user, req), q, clientIp(req)));
}));
