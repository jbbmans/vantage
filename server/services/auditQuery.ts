import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { AUDIT_CATEGORIES, auditActionsIn, auditCategoryOf } from '../../shared/auditCatalog.ts';
import { maskEdipi } from '../../shared/counseling.ts';

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
  /** User activity, unit administration or enterprise administration (ADR-0013). */
  category: z.enum(AUDIT_CATEGORIES).optional(),
  from: auditDay.optional(),
  to: auditDay.optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});
export type AuditQuery = z.infer<typeof auditQuery>;

/** The most entries one exported file holds. More is refused with a request to narrow the dates, never cut short. */
export const AUDIT_EXPORT_MAX = 50_000;
export const AUDIT_CSV_COLUMNS = ['seq', 'at', 'action', 'category', 'actor_username', 'actor_id', 'subject_username', 'subject_id', 'entity', 'entity_id', 'detail', 'ip', 'prev_hash', 'entry_hash'];

export interface AuditTrail {
  /** The SQL naming which entries belong to this trail, over `al`, and its parameters. */
  where: string;
  params: unknown[];
  /** More columns to read with each entry, over `al`, `u` (the actor) and `s` (the subject). */
  columns?: string;
  /** Also match the search against the actor's and subject's names, not only their usernames. */
  names?: boolean;
  /**
   * Leave out every EDIPI, from what is returned and from what the search matches: a Unit Instance's trail is read by
   * roles that never see one. That is the usernames Vantage made from a card (`edipi-` and the number), a roster entry's
   * EDIPI, and the number a card link's words carry (withoutEdipis).
   */
  hideCacUsernames?: boolean;
}

const CAC_USERNAME_GLOB = "'edipi-[0-9]*'";

/** Ten digits standing alone: how an EDIPI appears in an entry's words. */
const EDIPI_IN_WORDS = /(?<!\d)\d{10}(?!\d)/g;
/**
 * Ten digits in a row in an entry's words, as SQLite's GLOB says it. On a trail that hides EDIPIs, the search does not
 * look in the words of an entry that carries one, whatever its action, so no guess at an EDIPI (or part of one) is
 * confirmed by which entries come back. Such an entry is still found by its action, people, entity and address.
 */
const TEN_DIGITS_GLOB = `'*${'[0-9]'.repeat(10)}*'`;

/**
 * An entry as a reader who never sees an EDIPI reads it: a roster entry, which the MCTFS feed keys by EDIPI, and any
 * EDIPI its words carry, masked to the last four digits as the screen masks one (shared/counseling.ts). The entry in the
 * log is untouched; only what is shown or handed over is masked.
 */
export function withoutEdipis<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = row;
  if (out.entity === 'personnel_roster' && typeof out.entity_id === 'string') out.entity_id = maskEdipi(out.entity_id);
  if (typeof out.detail === 'string') out.detail = out.detail.replace(EDIPI_IN_WORDS, (d) => maskEdipi(d));
  return row;
}

/** What a list page shows of each entry: everything but the seals, which only an exported file carries. */
const LIST_COLUMNS = 'al.seq, al.id, al.at, al.action, al.category, al.actor_id, al.subject_id, al.entity, al.entity_id, al.unit_id, al.org_id, al.detail, al.ip';
const SEAL_COLUMNS = 'al.prev_hash, al.entry_hash';
const JOINS = 'LEFT JOIN users u ON u.id = al.actor_id LEFT JOIN users s ON s.id = al.subject_id';

/** The SQL that picks a trail's entries for a filter, over `al`, `u` (the actor) and `s` (the subject). */
function filterSql(trail: AuditTrail, q: Omit<AuditQuery, 'limit'>) {
  const where = [`(${trail.where})`];
  const params: unknown[] = [...trail.params];
  if (q.action) { where.push('al.action = ?'); params.push(q.action); }
  if (q.category) {
    // An entry from before categories sealed none (ADR-0013): it is in the category the catalogue gives its action.
    const actions = auditActionsIn(q.category);
    where.push(`(al.category = ? OR (al.category IS NULL AND al.action IN (${actions.map(() => '?').join(', ')})))`);
    params.push(q.category, ...actions);
  }
  if (q.from) { where.push('al.at >= ?'); params.push(`${q.from}T00:00:00.000Z`); }
  if (q.to) { where.push('al.at < ?'); params.push(new Date(Date.parse(`${q.to}T00:00:00.000Z`) + 86_400_000).toISOString()); }
  if (q.before) { where.push('al.seq < ?'); params.push(q.before); }
  const username = (p: 'u' | 's') => (trail.hideCacUsernames ? `CASE WHEN ${p}.username GLOB ${CAC_USERNAME_GLOB} THEN NULL ELSE ${p}.username END` : `${p}.username`);
  if (q.q) {
    const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    const people = trail.names ? ['u', 's'].map((p) => `lower(coalesce(${p}.first_name || ' ' || ${p}.last_name, '')) LIKE ? ESCAPE '\\'`) : [];
    // A trail that hides EDIPIs never matches one either: not a roster entry's, nor one an entry's words carry.
    const words = trail.hideCacUsernames ? `(lower(coalesce(al.detail, '')) LIKE ? ESCAPE '\\' AND coalesce(al.detail, '') NOT GLOB ${TEN_DIGITS_GLOB})` : `lower(coalesce(al.detail, '')) LIKE ? ESCAPE '\\'`;
    const entity = trail.hideCacUsernames ? "(al.entity_id = ? AND al.entity IS NOT 'personnel_roster')" : 'al.entity_id = ?';
    where.push(`(lower(al.action) LIKE ? ESCAPE '\\' OR ${words} OR lower(coalesce(${username('u')}, '')) LIKE ? ESCAPE '\\' OR lower(coalesce(${username('s')}, '')) LIKE ? ESCAPE '\\'${people.map((p) => ` OR ${p}`).join('')} OR ${entity} OR al.ip = ?)`);
    params.push(like, like, like, like, ...people.map(() => like), q.q, q.q);
  }
  return { where: where.join(' AND '), params, username };
}

/**
 * A trail's entries for a filter: newest first, from before `before` when paging back. Dates are UTC days. Each carries
 * its category: the one it sealed, or for an entry from before categories, the one the catalogue gives its action. A
 * list page leaves out each entry's seals; an export asks for them (`seals`).
 */
export function auditRows(ctx: AppContext, trail: AuditTrail, q: Omit<AuditQuery, 'limit'>, limit: number, { seals = false } = {}) {
  const { where, params, username } = filterSql(trail, q);
  const rows = ctx.db.prepare(`SELECT ${LIST_COLUMNS}${seals ? `, ${SEAL_COLUMNS}` : ''}, ${username('u')} AS actor_username, ${username('s')} AS subject_username${trail.columns ? `, ${trail.columns}` : ''} FROM audit_log al
      ${JOINS}
     WHERE ${where} ORDER BY al.seq DESC LIMIT ?`).all(...params, limit) as Array<Record<string, unknown> & { seq: number; action: string; category: string | null }>;
  for (const row of rows) {
    row.category ??= auditCategoryOf(row.action);
    if (trail.hideCacUsernames) withoutEdipis(row);
  }
  return rows;
}

/**
 * How many entries a filter matches, counting no further than `cap`: enough for an export to refuse a file too large
 * before it reads a single entry of it.
 */
export function auditCount(ctx: AppContext, trail: AuditTrail, q: Omit<AuditQuery, 'limit' | 'before'>, cap: number): number {
  const { where, params } = filterSql(trail, q);
  // Only a text search reads the actor's and the subject's names; without one the count walks the entries alone.
  return (ctx.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM audit_log al ${q.q ? JOINS : ''} WHERE ${where} LIMIT ?)`).get(...params, cap) as { n: number }).n;
}

/** Whether a request is a trail's first page with no filter: the only page that carries the trail's action list. */
export const unfilteredFirstPage = (q: Partial<AuditQuery> & { unit?: string }) => !q.before && !q.q && !q.action && !q.category && !q.from && !q.to && !q.unit;

/** Each trail's action list, when it was read and the newest entry it covers, keyed by the trail's SQL and parameters. */
const actionLists = new WeakMap<AppContext, Map<string, { at: number; through: number; actions: string[] }>>();

/**
 * The actions a trail holds, for its filter. idx_audit_trail_action (org_id, unit_id, action) answers it from the index
 * alone, and it is read whole at most once a minute for each trail. In between, the list is brought up to date from the
 * entries written since, which are few: the log only grows, so an action done a moment ago is already in the filter.
 * The key is the trail's SQL with its parameters, so one Unit Instance's list is never another's.
 */
export function auditActions(ctx: AppContext, trail: AuditTrail, maxAgeMs = 60_000): string[] {
  const key = `${trail.where}\u0000${JSON.stringify(trail.params)}`;
  let lists = actionLists.get(ctx);
  if (!lists) actionLists.set(ctx, (lists = new Map()));
  const head = (ctx.db.prepare('SELECT MAX(seq) AS seq FROM audit_log').get() as { seq: number | null }).seq ?? 0;
  const seen = lists.get(key);
  if (seen && Date.now() - seen.at < maxAgeMs) {
    if (head > seen.through) {
      // Only the entries after the list, read by position, then held to the trail: the trail's own index would read
      // all of its entries to find the new ones.
      const fresh = (ctx.db.prepare(`WITH al AS MATERIALIZED (SELECT * FROM audit_log WHERE seq > ?) SELECT DISTINCT al.action FROM al WHERE ${trail.where}`)
        .all(seen.through, ...trail.params) as Array<{ action: string }>).map((r) => r.action);
      if (fresh.some((a) => !seen.actions.includes(a))) seen.actions = [...new Set([...seen.actions, ...fresh])].sort();
      seen.through = head;
    }
    return seen.actions;
  }
  const actions = (ctx.db.prepare(`SELECT DISTINCT al.action FROM audit_log al WHERE ${trail.where} ORDER BY al.action`).all(...trail.params) as Array<{ action: string }>).map((r) => r.action);
  // A list for every Unit Instance there is, at most; one that stopped being asked for goes when the map is rebuilt.
  if (lists.size >= 1000) lists.clear();
  lists.set(key, { at: Date.now(), through: head, actions });
  return actions;
}

/** A filter as the audit detail of the export that used it. */
export const auditFilterLabel = (q: Record<string, unknown>) =>
  Object.entries(q).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${v}`).join(' ');
