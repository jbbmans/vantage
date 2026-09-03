import { Router } from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor, can, PERMISSIONS, detailUnitsFor } from '../authz/scope.ts';
import { buildReport } from '../services/reports.ts';
import { renderReportPdf } from '../services/pdf.ts';
import { comparePeriods } from '../../shared/delta.ts';
import { rangeForPeriod } from '../../shared/metrics.ts';
import { areasFor } from '../../shared/evaluation.ts';
import { rowsToCsv, ACTIVITY_CSV_COLUMNS, activityToCsvRow } from '../../shared/csv.ts';
import { hydrate } from '../services/records.ts';
import { runAiWorkflow, aiStatus, AiError } from '../services/ai.ts';
import { syncMaradmins, maradminSyncState } from '../services/maradmins.ts';
import { audit } from '../services/audit.ts';
import { notifyOperators } from '../services/notifications.ts';
import { now } from '../lib/ids.ts';

export const miscRouter = Router();
miscRouter.use(requireAuth);

// Reports ---------------------------------------------------------------
const reportQuery = z.object({
  period: z.string().max(20).default('fiscalYear'), from: z.string().max(10).optional(), to: z.string().max(10).optional(),
  user_id: z.string().max(64).optional(), unit_id: z.string().max(64).optional(), style: z.enum(['jepes', 'fitrep', 'resume']).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(), track: z.enum(['jepes', 'fitrep']).optional(),
});

function reportTarget(req: Parameters<Parameters<typeof wrap>[0]>[0]) {
  const q = parse(reportQuery, req.query);
  const scope = scopeFor(req.ctx, req.user, req);
  let userId = req.user.id;
  let unitId: string | null = null;
  if (q.user_id && q.user_id !== req.user.id) {
    const units = detailUnitsFor(req.ctx, scope, q.user_id);
    if (!units.length) throw forbidden('You cannot build a report for that Marine.');
    userId = q.user_id;
    unitId = q.unit_id && units.includes(q.unit_id) ? q.unit_id : units[0];
    audit(req.ctx, { actor_id: req.user.id, action: 'build_report', entity: 'user', entity_id: userId, subject_id: userId, unit_id: unitId, ip: clientIp(req) });
  }
  return { q, userId, unitId };
}

miscRouter.get('/reports', wrap((req, res) => {
  const { q, userId, unitId } = reportTarget(req);
  const report = buildReport(req.ctx, { userId, unitId, period: q.period, from: q.from, to: q.to, style: q.style, limit: q.limit, track: q.track });
  res.json(report);
}));

miscRouter.get('/reports/delta', wrap((req, res) => {
  const { q, userId, unitId } = reportTarget(req);
  const where = unitId ? `user_id = ? AND unit_id = ? AND visibility = 'unit'` : 'user_id = ?';
  const params = unitId ? [userId, unitId] : [userId];
  const activities = (req.ctx.db.prepare(`SELECT * FROM activities WHERE ${where} AND deleted_at IS NULL`).all(...params) as Array<Record<string, unknown>>).map((r) => hydrate(r, 'activities')!);
  const awards = req.ctx.db.prepare(`SELECT date FROM awards WHERE ${where} AND deleted_at IS NULL`).all(...params) as Array<{ date: string | null }>;
  const trainings = req.ctx.db.prepare(`SELECT date, hours FROM trainings WHERE ${where} AND deleted_at IS NULL`).all(...params) as Array<{ date: string | null; hours: number | null }>;
  const goals = req.ctx.db.prepare(`SELECT status FROM goals WHERE ${where} AND deleted_at IS NULL`).all(...params) as Array<{ status: string }>;
  const range = rangeForPeriod(q.period);
  const track = q.track || buildReport(req.ctx, { userId, unitId, period: q.period }).track;
  res.json(comparePeriods(activities as never, range, { areas: areasFor(track), awards, trainings, goals }));
}));

miscRouter.get('/reports/pdf', wrap(async (req, res) => {
  const { q, userId, unitId } = reportTarget(req);
  const report = buildReport(req.ctx, { userId, unitId, period: q.period, from: q.from, to: q.to, style: q.style, limit: q.limit ?? 12, track: q.track });
  const title = `${report.track === 'fitrep' ? 'FITREP' : 'JEPES'} input`;
  const pdf = await renderReportPdf({
    title, subject: report.subject, unitLine: report.unit ? report.unit.short_name || report.unit.name : '', period: report.label, track: report.track,
    generatedAt: report.generatedAt, narrative: report.narrative, pkg: report.pkg, metrics: report.metrics, counts: report.counts, awards: report.awards, trainings: report.trainings,
  });
  audit(req.ctx, { actor_id: req.user.id, action: 'export_pdf', entity: 'user', entity_id: userId, subject_id: userId !== req.user.id ? userId : null, unit_id: unitId, detail: report.label, ip: clientIp(req) });
  const file = `vantage-${report.track}-input-${report.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  res.send(pdf);
}));

miscRouter.get('/reports/csv', wrap((req, res) => {
  const { q, userId, unitId } = reportTarget(req);
  const where = unitId ? `user_id = ? AND unit_id = ? AND visibility = 'unit'` : 'user_id = ?';
  const params = unitId ? [userId, unitId] : [userId];
  const dateClause = q.period === 'all' ? '' : ' AND date >= ? AND date <= ?';
  const bounds = q.period === 'all' ? [] : (() => { const r = rangeForPeriod(q.period); const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; return [q.from || iso(r.start), q.to || iso(r.end)]; })();
  const rows = (req.ctx.db.prepare(`SELECT * FROM activities WHERE ${where} AND deleted_at IS NULL${dateClause} ORDER BY date DESC`).all(...params, ...bounds) as Array<Record<string, unknown>>).map((r) => hydrate(r, 'activities')!);
  audit(req.ctx, { actor_id: req.user.id, action: 'export_csv', entity: 'activities', subject_id: userId !== req.user.id ? userId : null, unit_id: unitId, detail: `${rows.length} rows`, ip: clientIp(req) });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="vantage-activities-${now().slice(0, 10)}.csv"`);
  res.send(`\uFEFF${rowsToCsv(rows.map(activityToCsvRow), ACTIVITY_CSV_COLUMNS.map((c) => c.header))}`);
}));

// AI --------------------------------------------------------------------
miscRouter.get('/ai/status', wrap((req, res) => res.json(aiStatus(req.ctx, { userId: req.user.id }))));

miscRouter.post('/ai/assist', wrap(async (req, res) => {
  const ctx = req.ctx;
  const workflow = String(req.body?.workflow || '');
  try {
    const result = await runAiWorkflow(ctx, req.user, workflow, req.body?.input, req.body?.model, req);
    audit(ctx, { actor_id: req.user.id, action: 'ai_assist', entity: 'ai_request', entity_id: result.request_id, detail: `${workflow}; ${result.model}; ${result.usage.total_tokens} tokens; suggestion only`, ip: clientIp(req) });
    res.json(result);
  } catch (error) {
    if (error instanceof AiError) {
      if (error.code === 'ai_key_locked') notifyOperators(ctx, { kind: 'system', title: 'GenAI.mil key needs unlock', message: 'AI assistance is paused until the GenAI.mil key lock is cleared in the Owner Console.', actionUrl: '/operator#ai', dedupeKey: `genai-lock:${now().slice(0, 13)}` });
      audit(ctx, { actor_id: req.user.id, action: 'ai_assist_failed', entity: 'ai_request', detail: `${workflow || 'unknown'}; ${error.code}`, ip: clientIp(req) });
    }
    throw error;
  }
}));

// MARADMINs -------------------------------------------------------------
miscRouter.get('/maradmins', wrap(async (req, res) => {
  const ctx = req.ctx;
  let syncError: string | null = null;
  const cached = (ctx.db.prepare('SELECT COUNT(*) AS n FROM maradmins').get() as { n: number }).n > 0;
  if (ctx.runtime.maradminsEnabled) {
    if (!cached || req.query.wait === '1') { try { await syncMaradmins(ctx); } catch (e) { syncError = (e as Error).message; } }
    else syncMaradmins(ctx).catch(() => {});
  }
  const rows = (ctx.db.prepare(`SELECT m.*, s.read_at, s.saved_at FROM maradmins m LEFT JOIN maradmin_user_state s ON s.maradmin_id = m.id AND s.user_id = ? ORDER BY m.published_at DESC LIMIT 250`).all(req.user.id) as Array<Record<string, unknown>>)
    .map((r) => ({ ...r, tags: JSON.parse(String(r.tags || '[]')), audience: JSON.parse(String(r.audience || '[]')) }));
  res.json({ rows, sync: { ...maradminSyncState(ctx), error: syncError } });
}));

miscRouter.put('/maradmins/:id/state', wrap((req, res) => {
  const ctx = req.ctx;
  const id = String(req.params.id);
  if (!ctx.db.prepare('SELECT 1 FROM maradmins WHERE id = ?').get(id)) throw notFound('No such MARADMIN.');
  const existing = ctx.db.prepare('SELECT read_at, saved_at FROM maradmin_user_state WHERE user_id = ? AND maradmin_id = ?').get(req.user.id, id) as { read_at: string | null; saved_at: string | null } | undefined;
  const readAt = req.body?.read === undefined ? existing?.read_at || null : (req.body.read ? now() : null);
  const savedAt = req.body?.saved === undefined ? existing?.saved_at || null : (req.body.saved ? now() : null);
  ctx.db.prepare('INSERT INTO maradmin_user_state (user_id, maradmin_id, read_at, saved_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, maradmin_id) DO UPDATE SET read_at = excluded.read_at, saved_at = excluded.saved_at').run(req.user.id, id, readAt, savedAt);
  res.json({ ok: true, read_at: readAt, saved_at: savedAt });
}));

// Global search ----------------------------------------------------------
miscRouter.get('/search', wrap((req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q.length < 2) return res.json({ results: [] });
  const scope = scopeFor(req.ctx, req.user, req);
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const results: Array<{ type: string; id: string; title: string; subtitle: string | null; to: string }> = [];
  const own = (table: string, titleCol: string, subCol: string, to: (id: string) => string, type: string) => {
    const rows = req.ctx.db.prepare(`SELECT id, ${titleCol} AS title, ${subCol} AS subtitle FROM ${table} WHERE user_id = ? AND deleted_at IS NULL AND (${titleCol} LIKE ? ESCAPE '\\' COLLATE NOCASE) ORDER BY updated_at DESC LIMIT 6`).all(req.user.id, like) as Array<{ id: string; title: string; subtitle: string | null }>;
    for (const r of rows) results.push({ type, id: r.id, title: r.title, subtitle: r.subtitle, to: to(r.id) });
  };
  own('activities', 'title', 'date', (id) => `/records/${id}`, 'activity');
  own('tasks', 'title', 'status', () => '/work', 'task');
  own('projects', 'name', 'status', () => '/work?tab=projects', 'project');
  own('goals', 'title', 'status', () => '/goals', 'goal');
  own('awards', 'name', 'status', () => '/career?tab=awards', 'award');
  own('trainings', 'title', 'date', () => '/career?tab=training', 'training');
  if (scope.readableUnitIds.length) {
    const ph = scope.readableUnitIds.map(() => '?').join(',');
    const people = req.ctx.db.prepare(`SELECT DISTINCT u.id, u.first_name, u.last_name, r.abbr AS rank_abbr FROM users u JOIN unit_members um ON um.user_id = u.id LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.active = 1 AND um.unit_id IN (${ph}) AND (u.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE) LIMIT 6`).all(...scope.readableUnitIds, like, like) as Array<{ id: string; first_name: string; last_name: string; rank_abbr: string | null }>;
    for (const p of people) results.push({ type: 'person', id: p.id, title: `${p.rank_abbr || ''} ${p.last_name}, ${p.first_name}`.trim(), subtitle: null, to: `/team/${p.id}` });
  }
  const maradmins = req.ctx.db.prepare(`SELECT id, number, title FROM maradmins WHERE title LIKE ? ESCAPE '\\' COLLATE NOCASE OR number LIKE ? ESCAPE '\\' LIMIT 5`).all(like, like) as Array<{ id: string; number: string; title: string }>;
  for (const m of maradmins) results.push({ type: 'maradmin', id: m.id, title: `MARADMIN ${m.number}`, subtitle: m.title, to: `/maradmins?open=${encodeURIComponent(m.number)}` });
  res.json({ results: results.slice(0, 30) });
}));

export { badRequest, can, PERMISSIONS };
