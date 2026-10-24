import type { AppContext, SessionUser } from '../context.ts';
import { RECORD_KINDS } from '../../shared/recordKinds.ts';
import { badRequest } from '../lib/errors.ts';
import { OPEN_END } from '../../shared/timeframe.ts';

/**
 * A person's timeline: their activities, training, awards, counselings and achieved goals, newest first (ADR-0015).
 * Read from each kind's own table every time it is asked for and never stored, so it can never disagree with the
 * records it shows, and an Activity never has to stand in for one of them to appear here. Only the person's own
 * records: what a leader may read of someone else's stays on that person's own pages.
 *
 * Each entry is placed on its first day and kept in a window that any day of it falls in (ADR-0018), so work begun
 * before the window and still going shows there.
 */

const day = (col: string) => `substr(COALESCE(${col}, created_at), 1, 10)`;
/** An activity or course: its first day, its last (an ongoing one runs on), and its end as entered. */
const ranged = `${day('date')} AS day, CASE WHEN ongoing = 1 THEN '${OPEN_END}' ELSE ${day('COALESCE(end_date, date)')} END AS last_day, end_date, ongoing`;
/** Anything else is one day. */
const single = (col: string) => `${day(col)} AS day, ${day(col)} AS last_day, NULL AS end_date, 0 AS ongoing`;

// One SELECT per store a timeline kind lives in, each giving the same columns.
const SOURCES = {
  activities: `SELECT 'activity' AS kind, 'activities' AS source, id, ${ranged}, title, category AS detail, status, created_at,
                      CASE WHEN fingerprint LIKE 'work:%' OR fingerprint LIKE 'case:%' OR fingerprint LIKE 'draft:%' THEN 1 ELSE 0 END AS from_work
                 FROM activities WHERE user_id = @me AND deleted_at IS NULL`,
  trainings: `SELECT CASE WHEN type IN ('pme','education','certification','qualification') THEN type ELSE 'training' END AS kind, 'trainings' AS source,
                     id, ${ranged}, title, provider AS detail, status, created_at, 0 AS from_work
                FROM trainings WHERE user_id = @me AND deleted_at IS NULL`,
  awards: `SELECT CASE WHEN type IN ('personal_award','unit_award') THEN 'award' ELSE 'recognition' END AS kind, 'awards' AS source,
                  id, ${single('COALESCE(presented_at, approved_at, date)')}, name AS title, type AS detail, status, created_at, 0 AS from_work
             FROM awards WHERE user_id = @me AND deleted_at IS NULL`,
  counselings: `SELECT 'counseling' AS kind, 'counselings' AS source, id, ${single('date')}, type AS title, counselor_name AS detail,
                       CASE WHEN counselor_id IS NULL OR counselor_id = user_id THEN NULL WHEN acknowledged_at IS NULL THEN 'unacknowledged' ELSE 'acknowledged' END AS status,
                       created_at, 0 AS from_work
                  FROM counselings WHERE user_id = @me AND deleted_at IS NULL`,
  goals: `SELECT 'goal' AS kind, 'goals' AS source, id, ${single('COALESCE(completed_at, period_end, updated_at)')}, title, category AS detail, status, created_at, 0 AS from_work
            FROM goals WHERE (user_id = @me OR assignee_id = @me) AND status = 'achieved' AND deleted_at IS NULL`,
} as const;

const HREF: Record<keyof typeof SOURCES, (id: string) => string> = {
  activities: (id) => `/records/${encodeURIComponent(id)}`,
  trainings: (id) => `/career/training?open=${encodeURIComponent(id)}`,
  awards: (id) => `/career/awards?open=${encodeURIComponent(id)}`,
  counselings: (id) => `/career/counseling?open=${encodeURIComponent(id)}`,
  goals: () => '/goals',
};

interface Item { kind: string; source: keyof typeof SOURCES; id: string; day: string; last_day: string; end_date: string | null; ongoing: number; title: string; detail: string | null; status: string | null; created_at: string; from_work: number }

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function recordTimeline(ctx: AppContext, user: SessionUser, query: Record<string, unknown>) {
  const from = typeof query.from === 'string' && query.from ? query.from : null;
  const to = typeof query.to === 'string' && query.to ? query.to : null;
  if ((from && !DAY.test(from)) || (to && !DAY.test(to)) || (from && to && from > to)) throw badRequest('Use a valid from/to window.');
  const limit = Math.trunc(Math.min(Math.max(Number(query.limit) || 200, 1), 500));
  // One kind's newest entries, not the newest of everything filtered afterwards; the counts stay every kind's, for the filters.
  const kind = typeof query.kind === 'string' && query.kind && query.kind !== 'all' ? query.kind : null;
  const union = Object.values(SOURCES).join(' UNION ALL ');
  const window = `WHERE (@from IS NULL OR last_day >= @from) AND (@to IS NULL OR day <= @to)`;
  const params = { me: user.id, from, to };
  const rows = ctx.db.prepare(`SELECT * FROM (${union}) ${window} AND (@kind IS NULL OR kind = @kind) ORDER BY day DESC, created_at DESC LIMIT ${limit}`).all({ ...params, kind }) as Item[];
  const counts = Object.fromEntries((ctx.db.prepare(`SELECT kind, COUNT(*) AS n FROM (${union}) ${window} GROUP BY kind`).all(params) as Array<{ kind: string; n: number }>).map((r) => [r.kind, r.n]));
  const total = Object.values(counts).reduce((a: number, n) => a + Number(n), 0);
  return {
    items: rows.map((r) => ({ kind: r.kind, table: r.source, id: r.id, date: r.day, end_date: r.end_date, ongoing: r.ongoing === 1, title: r.title, detail: r.detail, status: r.status, from_work: Boolean(r.from_work), href: HREF[r.source](r.id) })),
    // Which kind this answer holds, so a page still showing it while it asks for another never reads one as the other.
    kind, counts, total, truncated: (kind ? Number(counts[kind] ?? 0) : total) > rows.length,
    // Kinds the timeline will show once the Task that builds them lands, so an empty lane is not read as none.
    pending: RECORD_KINDS.filter((k) => k.timeline && !k.store).map((k) => ({ key: k.key, label: k.label, plannedIn: k.plannedIn ?? null })),
  };
}
