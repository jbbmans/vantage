import type { AppContext } from '../context.ts';
import { SUMMABLE_DOLLAR_TYPES } from '../../shared/constants.ts';
import { strength } from '../../shared/bullets.ts';

const weekKey = (dateStr: string) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
};

export function unitDashboard(ctx: AppContext, unitId: string, from: string, to: string, { includeMembers = true } = {}) {
  const db = ctx.db;
  const members = db.prepare(`SELECT u.id, u.first_name, u.last_name, u.mos, um.billet, um.is_primary, r.abbr AS rank_abbr, r.sort AS rank_sort FROM unit_members um JOIN users u ON u.id = um.user_id LEFT JOIN ranks r ON r.id = u.rank_id WHERE um.unit_id = ? AND u.active = 1 ORDER BY r.sort DESC, u.last_name`).all(unitId) as Array<{ id: string; first_name: string; last_name: string; mos: string | null; billet: string | null; is_primary: number; rank_abbr: string | null; rank_sort: number | null }>;
  const activities = db.prepare(`SELECT user_id, date, category, eval_area, quantity, unit_label, dollar_amount, dollar_type, result FROM activities WHERE unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL AND date >= ? AND date <= ?`).all(unitId, from, to) as Array<{ user_id: string; date: string; category: string | null; eval_area: string | null; quantity: number | null; unit_label: string | null; dollar_amount: number | null; dollar_type: string | null; result: string | null }>;

  const byMember = new Map<string, { entries: number; dollars: number; quantity: number; complete: number; lastDate: string | null }>();
  const byCategory: Record<string, { entries: number; dollars: number }> = {};
  const byArea: Record<string, number> = {};
  const byWeek = new Map<string, { entries: number; dollars: number }>();
  let dollars = 0; let reviewed = 0; let complete = 0;
  for (const a of activities) {
    const amount = Number(a.dollar_amount) || 0;
    const summable = SUMMABLE_DOLLAR_TYPES.includes(a.dollar_type || 'impact');
    if (summable) dollars += amount; else reviewed += amount;
    const isComplete = strength(a as never) >= 2;
    if (isComplete) complete += 1;
    const m = byMember.get(a.user_id) || { entries: 0, dollars: 0, quantity: 0, complete: 0, lastDate: null };
    m.entries += 1; m.dollars += summable ? amount : 0; m.quantity += Number(a.quantity) || 0; m.complete += isComplete ? 1 : 0;
    if (!m.lastDate || a.date > m.lastDate) m.lastDate = a.date;
    byMember.set(a.user_id, m);
    const cat = a.category || 'Other';
    byCategory[cat] ||= { entries: 0, dollars: 0 };
    byCategory[cat].entries += 1; byCategory[cat].dollars += summable ? amount : 0;
    const area = a.eval_area || 'Unassigned';
    byArea[area] = (byArea[area] || 0) + 1;
    const wk = weekKey(a.date);
    const w = byWeek.get(wk) || { entries: 0, dollars: 0 };
    w.entries += 1; w.dollars += summable ? amount : 0;
    byWeek.set(wk, w);
  }

  const tasks = db.prepare(`SELECT status, due_date, assignee_id, user_id FROM tasks WHERE unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL`).all(unitId) as Array<{ status: string; due_date: string | null; assignee_id: string | null; user_id: string }>;
  const todayIso = new Date().toISOString().slice(0, 10);
  const openTasks = tasks.filter((t) => t.status !== 'completed');
  const overdue = openTasks.filter((t) => t.due_date && t.due_date < todayIso);
  const goals = db.prepare(`SELECT status, current_value, target_value, period_end FROM goals WHERE unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL`).all(unitId) as Array<{ status: string; current_value: number; target_value: number | null; period_end: string | null }>;
  const awards = db.prepare(`SELECT status, COUNT(*) AS n FROM awards WHERE unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL AND status IN ('recommended','submitted','approved') GROUP BY status`).all(unitId) as Array<{ status: string; n: number }>;
  const counselings = db.prepare(`SELECT user_id, MAX(date) AS last FROM counselings WHERE unit_id = ? AND visibility = 'unit' AND deleted_at IS NULL GROUP BY user_id`).all(unitId) as Array<{ user_id: string; last: string | null }>;
  const lastCounseling = new Map(counselings.map((c) => [c.user_id, c.last]));
  const readiness = db.prepare(`SELECT r.user_id, r.pft_score, r.cft_score, r.rifle_qual, r.mcmap_belt, r.pme_complete FROM readiness r JOIN unit_members um ON um.user_id = r.user_id WHERE um.unit_id = ?`).all(unitId) as Array<{ user_id: string; pft_score: number | null; cft_score: number | null; rifle_qual: string | null; mcmap_belt: string | null; pme_complete: string | null }>;
  const readinessMap = new Map(readiness.map((r) => [r.user_id, r]));
  const pfts = readiness.map((r) => r.pft_score).filter((n): n is number => n != null);
  const cfts = readiness.map((r) => r.cft_score).filter((n): n is number => n != null);
  const avg = (list: number[]) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);

  const cutoff = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const memberRows = members.map((m) => {
    const stats = byMember.get(m.id) || { entries: 0, dollars: 0, quantity: 0, complete: 0, lastDate: null };
    const r = readinessMap.get(m.id);
    return {
      id: m.id, name: `${m.last_name}, ${m.first_name}`, rank_abbr: m.rank_abbr, billet: m.billet, mos: m.mos,
      entries: stats.entries, dollars: Math.round(stats.dollars * 100) / 100, quantity: stats.quantity,
      completeness: stats.entries ? Math.round((stats.complete / stats.entries) * 100) : null,
      last_entry: stats.lastDate, open_tasks: openTasks.filter((t) => (t.assignee_id || t.user_id) === m.id).length,
      overdue_tasks: overdue.filter((t) => (t.assignee_id || t.user_id) === m.id).length,
      last_counseling: lastCounseling.get(m.id) || null,
      counseling_due: !lastCounseling.get(m.id) || (lastCounseling.get(m.id) as string) < cutoff,
      readiness_complete: r ? [r.pft_score, r.cft_score, r.rifle_qual, r.mcmap_belt, r.pme_complete].filter((v) => v != null && v !== '').length : 0,
    };
  });

  return {
    unit_id: unitId, from, to,
    totals: {
      members: members.length, entries: activities.length, contributors: byMember.size, dollars: Math.round(dollars * 100) / 100, reviewed: Math.round(reviewed * 100) / 100,
      completeness: activities.length ? Math.round((complete / activities.length) * 100) : 0,
      open_tasks: openTasks.length, overdue_tasks: overdue.length,
      active_goals: goals.filter((g) => g.status === 'active').length,
      goals_achieved: goals.filter((g) => g.status === 'achieved').length,
      awards_in_progress: awards.reduce((n, a) => n + a.n, 0),
      counseling_due: memberRows.filter((m) => m.counseling_due).length,
      avg_pft: avg(pfts), avg_cft: avg(cfts), readiness_reported: readiness.length,
    },
    by_category: Object.entries(byCategory).map(([category, v]) => ({ category, ...v })).sort((a, b) => b.entries - a.entries),
    by_area: Object.entries(byArea).map(([area, entries]) => ({ area, entries })).sort((a, b) => b.entries - a.entries),
    weekly: [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v })),
    members: includeMembers ? memberRows : [],
    awards_pipeline: awards,
  };
}
