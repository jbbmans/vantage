import { z } from 'zod';
import type { AppContext } from '../context.ts';

/**
 * Reading one audit trail a page at a time: the platform's own (ADR-0011) or a Unit Instance's (ADR-0012). Each is
 * filtered and paged on the server, so nothing older than a page is out of reach, and exported whole or not at all.
 */

/** A calendar day, YYYY-MM-DD, that exists: 2026-02-30 does not. */
export const auditDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date: YYYY-MM-DD.')
  .refine((d) => { const t = Date.parse(`${d}T00:00:00.000Z`); return Number.isFinite(t) && new Date(t).toISOString().startsWith(d); }, 'That date does not exist.');

export const auditQuery = z.object({
  q: z.string().trim().max(80).optional(),
  action: z.string().trim().max(60).optional(),
  from: auditDay.optional(),
  to: auditDay.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
export type AuditQuery = z.infer<typeof auditQuery>;

/** The most entries one exported file holds. More is refused with a request to narrow the dates, never cut short. */
export const AUDIT_EXPORT_MAX = 50_000;
export const AUDIT_CSV_COLUMNS = ['seq', 'at', 'action', 'actor_username', 'actor_id', 'subject_username', 'subject_id', 'entity', 'entity_id', 'detail', 'ip', 'prev_hash', 'entry_hash'];

export interface AuditTrail {
  /** The SQL naming which entries belong to this trail, over `al`, and its parameters. */
  where: string;
  params: unknown[];
  /** More columns to read with each entry, over `al`, `u` (the actor) and `s` (the subject). */
  columns?: string;
  /** Also match the search against the actor's and subject's names, not only their usernames. */
  names?: boolean;
  /**
   * Leave out usernames Vantage made from a card, which are the person's EDIPI (`edipi-` and the number), from what is
   * returned and from what the search matches: a Unit Instance's trail is read by roles that never see an EDIPI.
   */
  hideCacUsernames?: boolean;
}

const CAC_USERNAME_GLOB = "'edipi-[0-9]*'";

/** A trail's entries for a filter: newest first, from before `before` when paging back. Dates are UTC days. */
export function auditRows(ctx: AppContext, trail: AuditTrail, q: Omit<AuditQuery, 'limit'>, limit: number) {
  const where = [`(${trail.where})`];
  const params: unknown[] = [...trail.params];
  if (q.action) { where.push('al.action = ?'); params.push(q.action); }
  if (q.from) { where.push('al.at >= ?'); params.push(`${q.from}T00:00:00.000Z`); }
  if (q.to) { where.push('al.at < ?'); params.push(new Date(Date.parse(`${q.to}T00:00:00.000Z`) + 86_400_000).toISOString()); }
  if (q.before) { where.push('al.seq < ?'); params.push(q.before); }
  const username = (p: 'u' | 's') => (trail.hideCacUsernames ? `CASE WHEN ${p}.username GLOB ${CAC_USERNAME_GLOB} THEN NULL ELSE ${p}.username END` : `${p}.username`);
  if (q.q) {
    const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    const people = trail.names ? ['u', 's'].map((p) => `lower(coalesce(${p}.first_name || ' ' || ${p}.last_name, '')) LIKE ? ESCAPE '\\'`) : [];
    where.push(`(lower(al.action) LIKE ? ESCAPE '\\' OR lower(coalesce(al.detail, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(${username('u')}, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(${username('s')}, '')) LIKE ? ESCAPE '\\'${people.map((p) => ` OR ${p}`).join('')} OR al.entity_id = ? OR al.ip = ?)`);
    params.push(like, like, like, like, ...people.map(() => like), q.q, q.q);
  }
  return ctx.db.prepare(`SELECT al.*, ${username('u')} AS actor_username, ${username('s')} AS subject_username${trail.columns ? `, ${trail.columns}` : ''} FROM audit_log al
      LEFT JOIN users u ON u.id = al.actor_id LEFT JOIN users s ON s.id = al.subject_id
     WHERE ${where.join(' AND ')} ORDER BY al.seq DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown> & { seq: number }>;
}

/** The actions a trail holds, for its filter. */
export const auditActions = (ctx: AppContext, trail: AuditTrail) =>
  (ctx.db.prepare(`SELECT DISTINCT al.action FROM audit_log al WHERE ${trail.where} ORDER BY al.action`).all(...trail.params) as Array<{ action: string }>).map((r) => r.action);

/** A filter as the audit detail of the export that used it. */
export const auditFilterLabel = (q: Record<string, unknown>) =>
  Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`).join(' ');
