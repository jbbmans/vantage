import type { AppContext, SessionUser } from '../context.ts';
import { RECORD_KINDS } from '../../shared/recordKinds.ts';
import { badRequest } from '../lib/errors.ts';

/**
 * A person's timeline: their activities, training, awards, counselings and achieved goals, newest first (ADR-0015).
 * Read from each kind's own table every time it is asked for and never stored, so it can never disagree with the
 * records it shows, and an Activity never has to stand in for one of them to appear here. Only the person's own
 * records: what a leader may read of someone else's stays on that person's own pages.
 */

const day = (col: string) => `substr(COALESCE(${col}, created_at), 1, 10)`;

// One SELECT per store a timeline kind lives in, each giving the same columns.
const SOURCES = {
  activities: `SELECT 'activity' AS kind, 'activities' AS source, id, ${day('date')} AS day, title, category AS detail, status, created_at,
                      CASE WHEN fingerprint LIKE 'work:%' OR fingerprint LIKE 'case:%' OR fingerprint LIKE 'draft:%' THEN 1 ELSE 0 END AS from_work
                 FROM activities WHERE user_id = @me AND deleted_at IS NULL`,
  trainings: `SELECT CASE WHEN type IN ('pme','education','certification','qualification') THEN type ELSE 'training' END AS kind, 'trainings' AS source,
                     id, ${day('date')} AS day, title, provider AS detail, status, created_at, 0 AS from_work
                FROM trainings WHERE user_id = @me AND deleted_at IS NULL`,
  awards: `SELECT CASE WHEN type IN ('personal_award','unit_award') THEN 'award' ELSE 'recognition' END AS kind, 'awards' AS source,
                  id, ${day('COALESCE(presented_at, approved_at, date)')} AS day, name AS title, type AS detail, status, created_at, 0 AS from_work
             FROM awards WHERE user_id = @me AND deleted_at IS NULL`,
  counselings: `SELECT 'counseling' AS kind, 'counselings' AS source, id, ${day('date')} AS day, type AS title, counselor_name AS detail,
                       CASE WHEN counselor_id IS NULL OR counselor_id = user_id THEN NULL WHEN acknowledged_at IS NULL THEN 'unacknowledged' ELSE 'acknowledged' END AS status,
                       created_at, 0 AS from_work
                  FROM counselings WHERE user_id = @me AND deleted_at IS NULL`,
  goals: `SELECT 'goal' AS kind, 'goals' AS source, id, ${day('COALESCE(completed_at, period_end, updated_at)')} AS day, title, category AS detail, status, created_at, 0 AS from_work
            FROM goals WHERE (user_id = @me OR assignee_id = @me) AND status = 'achieved' AND deleted_at IS NULL`,
} as const;

const HREF: Record<keyof typeof SOURCES, (id: string) => string> = {
  activities: (id) => `/records/${encodeURIComponent(id)}`,
  trainings: (id) => `/career/training?open=${encodeURIComponent(id)}`,
  awards: (id) => `/career/awards?open=${encodeURIComponent(id)}`,
  counselings: (id) => `/career/counseling?open=${encodeURIComponent(id)}`,
  goals: () => '/goals',
};

interface Item { kind: string; source: keyof typeof SOURCES; id: string; day: string; title: string; detail: string | null; status: string | null; created_at: string; from_work: number }

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function recordTimeline(ctx: AppContext, user: SessionUser, query: Record<string, unknown>) {
  const from = typeof query.from === 'string' && query.from ? query.from : null;
  const to = typeof query.to === 'string' && query.to ? query.to : null;
  if ((from && !DAY.test(from)) || (to && !DAY.test(to)) || (from && to && from > to)) throw badRequest('Use a valid from/to window.');
  const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
  const union = Object.values(SOURCES).join(' UNION ALL ');
  const window = `WHERE (@from IS NULL OR day >= @from) AND (@to IS NULL OR day <= @to)`;
  const params = { me: user.id, from, to };
  const rows = ctx.db.prepare(`SELECT * FROM (${union}) ${window} ORDER BY day DESC, created_at DESC LIMIT ${limit}`).all(params) as Item[];
  const counts = Object.fromEntries((ctx.db.prepare(`SELECT kind, COUNT(*) AS n FROM (${union}) ${window} GROUP BY kind`).all(params) as Array<{ kind: string; n: number }>).map((r) => [r.kind, r.n]));
  const total = Object.values(counts).reduce((a: number, n) => a + Number(n), 0);
  return {
    items: rows.map((r) => ({ kind: r.kind, table: r.source, id: r.id, date: r.day, title: r.title, detail: r.detail, status: r.status, from_work: Boolean(r.from_work), href: HREF[r.source](r.id) })),
    counts, total, truncated: total > rows.length,
    // Kinds the timeline will show once the Task that builds them lands, so an empty lane is not read as none.
    pending: RECORD_KINDS.filter((k) => k.timeline && !k.store).map((k) => ({ key: k.key, label: k.label, plannedIn: k.plannedIn ?? null })),
  };
}
