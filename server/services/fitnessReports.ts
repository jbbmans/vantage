import type { AppContext } from '../context.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { parse } from '../lib/http.ts';
import { newId, now } from '../lib/ids.ts';
import { fitnessReportSchema, type FitnessReportBody } from '../../shared/schemas.ts';

/**
 * The fitness reports a Marine received (ADR-0047). Each is the Marine's own: only they write, change or remove one,
 * and only they read all of theirs. A leader who sees the Marine's readiness reads the ones the Marine shares, through
 * the audited readiness route. Nothing here lists, sorts or compares reports across Marines, and the structural test in
 * tests/server/fitrepStanding.test.ts holds every read of the table to this file.
 */

export const FITNESS_REPORT_COLUMNS = [
  'period_from', 'period_to', 'occasion', 'report_type', 'grade', 'rs_label', 'marks', 'rpt_avg', 'rs_avg', 'rs_high',
  'reports_at_processing', 'reports_cumulative', 'rv_at_processing', 'cum_rv_printed', 'shared',
] as const;
type Column = (typeof FITNESS_REPORT_COLUMNS)[number];
export type FitnessReportRow = Record<Column, unknown> & { id: string; user_id: string; version: number; created_at: string; updated_at: string };

const SELECT = `SELECT id, user_id, ${FITNESS_REPORT_COLUMNS.join(', ')}, version, created_at, updated_at FROM fitness_reports`;

/** A Marine's own reports, newest period first. */
export function listOwnReports(ctx: AppContext, userId: string): FitnessReportRow[] {
  return ctx.db.prepare(`${SELECT} WHERE user_id = ? AND deleted_at IS NULL ORDER BY period_to DESC, period_from DESC, created_at DESC`).all(userId) as FitnessReportRow[];
}

/** The reports a Marine shares with the leaders who see their readiness. */
export function listSharedReports(ctx: AppContext, userId: string): FitnessReportRow[] {
  return ctx.db.prepare(`${SELECT} WHERE user_id = ? AND shared = 1 AND deleted_at IS NULL ORDER BY period_to DESC, period_from DESC, created_at DESC`).all(userId) as FitnessReportRow[];
}

function ownRow(ctx: AppContext, userId: string, id: string): FitnessReportRow {
  const row = ctx.db.prepare(`${SELECT} WHERE id = ? AND deleted_at IS NULL`).get(id) as FitnessReportRow | undefined;
  // Another Marine's report reads as no report at all, so an id says nothing about whose it is.
  if (!row || row.user_id !== userId) throw notFound('No such fitness report.');
  return row;
}

const values = (body: FitnessReportBody) => FITNESS_REPORT_COLUMNS.map((c) => {
  const v = (body as Record<string, unknown>)[c];
  if (c === 'shared') return v ? 1 : 0;
  return v === undefined ? null : v;
});

export function saveReport(ctx: AppContext, userId: string, id: string | null, body: FitnessReportBody): FitnessReportRow {
  const at = now();
  if (id) {
    const row = ownRow(ctx, userId, id);
    if (body.version != null && body.version !== row.version) throw conflict('This report changed in another window. Reload it.', 'version_conflict');
    ctx.db.prepare(`UPDATE fitness_reports SET ${FITNESS_REPORT_COLUMNS.map((c) => `${c} = ?`).join(', ')}, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ?`)
      .run(...values(body), at, id, userId);
    return ownRow(ctx, userId, id);
  }
  const created = newId();
  ctx.db.prepare(`INSERT INTO fitness_reports (id, user_id, ${FITNESS_REPORT_COLUMNS.join(', ')}, version, created_at, updated_at) VALUES (?, ?, ${FITNESS_REPORT_COLUMNS.map(() => '?').join(', ')}, 1, ?, ?)`)
    .run(created, userId, ...values(body), at, at);
  return ownRow(ctx, userId, created);
}

/**
 * A change to one of the Marine's reports. It names the version it changes, so a change made in another window is
 * refused rather than overwritten, and a field it leaves out keeps what is stored (a null clears one). The checks
 * across fields run on the report as it will be saved.
 */
export function updateReport(ctx: AppContext, userId: string, id: string, raw: unknown): FitnessReportRow {
  const row = ownRow(ctx, userId, id);
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (given.version == null) throw badRequest('Send the version of the report you are changing, so a change made in another window is not overwritten.', { fieldErrors: { version: 'Required.' } });
  const stored = Object.fromEntries(FITNESS_REPORT_COLUMNS.map((c) => [c, row[c]]));
  return saveReport(ctx, userId, id, parse(fitnessReportSchema, { ...stored, ...given }));
}

export function removeReport(ctx: AppContext, userId: string, id: string): void {
  ownRow(ctx, userId, id);
  ctx.db.prepare('UPDATE fitness_reports SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(now(), now(), id, userId);
}

/** Every report a Marine kept, removed ones included, for their own export of what Vantage holds about them. */
export function reportsForExport(ctx: AppContext, userId: string): FitnessReportRow[] {
  return ctx.db.prepare('SELECT * FROM fitness_reports WHERE user_id = ? ORDER BY period_to, created_at').all(userId) as FitnessReportRow[];
}
