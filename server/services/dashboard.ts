import type { AppContext } from '../context.ts';
import { subtreeIds, membersAcross } from '../authz/scope.ts';
import { isSummable } from '../../shared/constants.ts';
import { strength } from '../../shared/bullets.ts';
import { withTypedProgress } from './goals.ts';

const weekKey = (dateStr: string) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
};

export function unitDashboard(ctx: AppContext, unitId: string, from: string, to: string, { includeMembers = true } = {}) {
  const db = ctx.db;
  const unitIds = subtreeIds(ctx, unitId);
  const units = JSON.stringify(unitIds);
  const members = membersAcross(ctx, unitIds);
  const activities = db.prepare(`SELECT user_id, unit_id, date, category, eval_area, quantity, unit_label, dollar_amount, dollar_type, result FROM activities WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND date >= ? AND date <= ?`).all(units, from, to) as Array<{ user_id: string; unit_id: string; date: string; category: string | null; eval_area: string | null; quantity: number | null; unit_label: string | null; dollar_amount: number | null; dollar_type: string | null; result: string | null }>;

  const byMember = new Map<string, { entries: number; dollars: number; quantity: number; complete: number; lastDate: string | null }>();
  const byCategory: Record<string, { entries: number; dollars: number }> = {};
  const byArea: Record<string, number> = {};
  const byWeek = new Map<string, { entries: number; dollars: number }>();
  const byTeam = new Map<string, { entries: number; dollars: number; contributors: Set<string> }>();
  let dollars = 0; let reviewed = 0; let complete = 0;
  for (const a of activities) {
    const amount = Number(a.dollar_amount) || 0;
    const summable = isSummable(a.dollar_type, ctx.runtime.metrics);
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
    const team = byTeam.get(a.unit_id) || { entries: 0, dollars: 0, contributors: new Set<string>() };
    team.entries += 1; team.dollars += summable ? amount : 0; team.contributors.add(a.user_id);
    byTeam.set(a.unit_id, team);
    const wk = weekKey(a.date);
    const w = byWeek.get(wk) || { entries: 0, dollars: 0 };
    w.entries += 1; w.dollars += summable ? amount : 0;
    byWeek.set(wk, w);
  }

  const tasks = db.prepare(`SELECT status, due_date, assignee_id, user_id FROM tasks WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL`).all(units) as Array<{ status: string; due_date: string | null; assignee_id: string | null; user_id: string }>;
  const todayIso = new Date().toISOString().slice(0, 10);
  const openTasks = tasks.filter((t) => t.status !== 'completed');
  const overdue = openTasks.filter((t) => t.due_date && t.due_date < todayIso);
  const goals = db.prepare(`SELECT status, current_value, target_value, period_end FROM goals WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL`).all(units) as Array<{ status: string; current_value: number; target_value: number | null; period_end: string | null }>;
  const awards = db.prepare(`SELECT status, COUNT(*) AS n FROM awards WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND status IN ('recommended','submitted','approved') GROUP BY status`).all(units) as Array<{ status: string; n: number }>;
  const counselings = db.prepare(`SELECT user_id, MAX(date) AS last FROM counselings WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL GROUP BY user_id`).all(units) as Array<{ user_id: string; last: string | null }>;
  const lastCounseling = new Map(counselings.map((c) => [c.user_id, c.last]));
  const readiness = db.prepare(`SELECT r.user_id, r.pft_score, r.cft_score, r.rifle_qual, r.mcmap_belt, r.pme_complete FROM readiness r WHERE r.user_id IN (SELECT um.user_id FROM unit_members um WHERE um.unit_id IN (SELECT value FROM json_each(?)))`).all(units) as Array<{ user_id: string; pft_score: number | null; cft_score: number | null; rifle_qual: string | null; mcmap_belt: string | null; pme_complete: string | null }>;
  const readinessMap = new Map(readiness.map((r) => [r.user_id, r]));
  const pfts = readiness.map((r) => r.pft_score).filter((n): n is number => n != null);
  const cfts = readiness.map((r) => r.cft_score).filter((n): n is number => n != null);
  const avg = (list: number[]) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);

  const cutoff = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const memberRows = members.map((m) => {
    const stats = byMember.get(m.id) || { entries: 0, dollars: 0, quantity: 0, complete: 0, lastDate: null };
    const r = readinessMap.get(m.id);
    return {
      id: m.id, name: `${m.last_name}, ${m.first_name}`, rank_abbr: m.rank_abbr, billet: m.billet, mos: m.mos, team: unitIds.length > 1 ? m.team : null,
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
    unit_id: unitId, from, to, rolls_up: unitIds.length - 1,
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
    by_team: unitIds.length > 1 ? unitIds.filter((id, i) => i > 0 || byTeam.has(id)).map((id) => {
      const unit = db.prepare('SELECT name, short_name FROM units WHERE id = ?').get(id) as { name: string; short_name: string | null };
      const t = byTeam.get(id);
      return { unit_id: id, name: unit.short_name || unit.name, members: members.filter((m) => m.unit_id === id).length, entries: t?.entries || 0, dollars: Math.round((t?.dollars || 0) * 100) / 100, contributors: t?.contributors.size || 0 };
    }) : [],
    members: includeMembers ? memberRows : [],
    awards_pipeline: awards,
  };
}

/** Totals built from fewer people than this are withheld from anyone who cannot read the records themselves. */
export const OVERVIEW_MIN_CONTRIBUTORS = 3;

/**
 * What a unit looks like from inside it: who is in it, how its teams are doing, and the goals it is working to.
 * People who can read the unit's records see every figure; everyone else sees figures only where at least three
 * people contributed, so no one's own numbers can be read off a total.
 */
export function unitOverview(ctx: AppContext, unitId: string, opts: { from: string; to: string; full: boolean; goalUnits: string[] }) {
  const db = ctx.db;
  const unitIds = subtreeIds(ctx, unitId);
  const units = JSON.stringify(unitIds);
  const unit = db.prepare('SELECT id, name, short_name, parent_id FROM units WHERE id = ?').get(unitId) as { id: string; name: string; short_name: string | null; parent_id: string | null };
  const parent = unit.parent_id ? db.prepare('SELECT id, name, short_name FROM units WHERE id = ?').get(unit.parent_id) as { id: string; name: string; short_name: string | null } | undefined : undefined;
  const members = membersAcross(ctx, unitIds);
  const rows = db.prepare(`SELECT user_id, unit_id, dollar_amount, dollar_type FROM activities WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND date >= ? AND date <= ?`)
    .all(units, opts.from, opts.to) as Array<{ user_id: string; unit_id: string; dollar_amount: number | null; dollar_type: string | null }>;

  const tally = (list: typeof rows) => {
    const contributors = new Set(list.map((r) => r.user_id)).size;
    const shown = opts.full || contributors >= OVERVIEW_MIN_CONTRIBUTORS;
    const dollars = list.reduce((sum, r) => sum + (isSummable(r.dollar_type, ctx.runtime.metrics) ? Number(r.dollar_amount) || 0 : 0), 0);
    return shown ? { entries: list.length, contributors, dollars: Math.round(dollars * 100) / 100, withheld: false } : { entries: null, contributors: null, dollars: null, withheld: true };
  };

  const teams = unitIds.slice(1).map((id) => {
    const t = db.prepare('SELECT id, name, short_name, parent_id FROM units WHERE id = ?').get(id) as { id: string; name: string; short_name: string | null; parent_id: string | null };
    return { unit_id: id, name: t.short_name || t.name, full_name: t.name, parent_id: t.parent_id, members: members.filter((m) => m.unit_id === id).length, ...tally(rows.filter((r) => r.unit_id === id)) };
  });

  const goalIds = unitIds.filter((id) => opts.goalUnits.includes(id));
  const goalRows = goalIds.length
    ? db.prepare(`SELECT * FROM goals WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND status IN ('active', 'achieved') ORDER BY period_end IS NULL, period_end LIMIT 24`).all(JSON.stringify(goalIds))
    : [];
  const goals = (withTypedProgress(ctx, goalRows as never) as Array<Record<string, unknown>>).map((g) => ({
    id: g.id, title: g.title, status: g.status, unit_id: g.unit_id, period_end: g.period_end, unit_label: g.unit_label,
    target_value: g.target_value, current_value: g.current_value, progress: (g as { progress?: unknown }).progress ?? null,
  }));

  return {
    unit: { id: unit.id, name: unit.name, short_name: unit.short_name },
    parent: parent ? { id: parent.id, name: parent.short_name || parent.name } : null,
    level: opts.full ? 'full' : 'overview',
    window: { from: opts.from, to: opts.to },
    totals: { members: members.length, teams: teams.length, ...tally(rows) },
    teams,
    roster: members.map((m) => ({ id: m.id, name: `${m.last_name}, ${m.first_name}`, rank_abbr: m.rank_abbr, billet: m.billet, team: m.team, unit_id: m.unit_id })),
    goals,
    minimum_contributors: OVERVIEW_MIN_CONTRIBUTORS,
  };
}
