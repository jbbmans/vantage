import type { AppContext } from '../context.ts';
import { PERMISSIONS, can, subtreeIds, membersAcross, unitTree, type Scope } from '../authz/scope.ts';
import { isSummable } from '../../shared/constants.ts';
import { strength } from '../../shared/bullets.ts';
import { withTypedProgress } from './goals.ts';
import { zonedDay } from '../lib/clock.ts';
import { periodClause } from './timeframes.ts';
import { BY_LAST_DAY } from './metrics.ts';

const weekKey = (dateStr: string) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() - day + 1);
  return d.toISOString().slice(0, 10);
};

const WEEK_MS = 7 * 86_400_000;
/** Ten years of weeks. A longer window lists only the weeks with entries, as the report always did. */
const MAX_FILLED_WEEKS = 522;

/**
 * Every week of the window, a week with nothing shared at zero, so a series over time shows its quiet weeks rather than
 * closing them up. A window with no start (the report's "All time") starts at the first week with an entry. A week not
 * yet begun is not a quiet week: the weeks stop at this one, or at the window's end if sooner, and never before a week
 * that holds an entry. Nothing shared at all is no weeks.
 */
function everyWeek(byWeek: Map<string, { entries: number; dollars: number }>, from: string, to: string, today: string) {
  if (!byWeek.size) return [];
  const keys = [...byWeek.keys()].sort();
  const last = keys[keys.length - 1];
  const stop = weekKey(to < today ? to : today);
  const at = (week: string) => Date.parse(`${week}T00:00:00Z`);
  const start = at(from > '1970-01-01' ? weekKey(from) : keys[0]);
  const end = at(last > stop ? last : stop);
  const row = (week: string) => { const w = byWeek.get(week); return { week, entries: w?.entries || 0, dollars: Math.round((w?.dollars || 0) * 100) / 100 }; };
  if ((end - start) / WEEK_MS >= MAX_FILLED_WEEKS) return keys.map(row);
  const out: Array<{ week: string; entries: number; dollars: number }> = [];
  for (let t = start; t <= end; t += WEEK_MS) out.push(row(new Date(t).toISOString().slice(0, 10)));
  return out;
}

export interface UnitReach {
  /** The unit and those beneath it whose shared records the reader may read, the unit first. */
  units: string[];
  /** Of those, the units where the reader may see figures by Marine. */
  detailIn: ReadonlySet<string>;
}

/**
 * Which of a unit's records the reader may read: the unit and those beneath it where they view shared records, and of
 * those, where they open member records. A role that does not reach down (position 0) reads its own unit alone. The
 * Output tab, the overview, the report center and the analytics all decide it here, before anything is read, so one
 * never counts what another leaves out.
 */
export function readableSubtree(ctx: AppContext, scope: Scope, unitId: string, tree = unitTree(ctx)): UnitReach {
  const units = subtreeIds(ctx, unitId, tree).filter((u) => can(scope, PERMISSIONS.VIEW_RECORDS, u));
  return { units, detailIn: new Set(units.filter((u) => can(scope, PERMISSIONS.VIEW_MEMBER_DETAIL, u))) };
}

type UnitName = { id: string; name: string; short_name: string | null; parent_id: string | null };

/** Units by id, every one asked read with one statement. */
function unitsById(ctx: AppContext, ids: string[]): Map<string, UnitName> {
  if (!ids.length) return new Map();
  const rows = ctx.db.prepare('SELECT id, name, short_name, parent_id FROM units WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as UnitName[];
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * What a unit produced in the window (the Output tab, and the unit and leadership reports): the shared records of the
 * units the reader may read. A Marine is listed, and their figures added up, only from units where the reader opens
 * member records, so a figure beside a name never counts a record the reader may not see by Marine.
 */
export function unitDashboard(ctx: AppContext, unitId: string, from: string, to: string, reach: UnitReach) {
  const db = ctx.db;
  const unitIds = reach.units;
  const units = JSON.stringify(unitIds);
  const members = membersAcross(ctx, unitIds);
  const named = (unit: string) => reach.detailIn.has(unit);
  const detailUnits = unitIds.filter(named);
  // Each Marine listed once, at their own team among the units the reader sees by Marine.
  const listed = detailUnits.length === unitIds.length ? members : membersAcross(ctx, detailUnits);
  const period = periodClause('activities', 'activities', from, to);
  const activities = db.prepare(`SELECT user_id, unit_id, date, category, eval_area, quantity, unit_label, dollar_amount, dollar_type, result FROM activities ${BY_LAST_DAY.activities} WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND ${period.sql}`).all(units, ...period.params) as Array<{ user_id: string; unit_id: string; date: string; category: string | null; eval_area: string | null; quantity: number | null; unit_label: string | null; dollar_amount: number | null; dollar_type: string | null; result: string | null }>;

  const byMember = new Map<string, { entries: number; dollars: number; quantity: number; complete: number; lastDate: string | null }>();
  const contributors = new Set<string>();
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
    contributors.add(a.user_id);
    if (named(a.unit_id)) {
      const m = byMember.get(a.user_id) || { entries: 0, dollars: 0, quantity: 0, complete: 0, lastDate: null };
      m.entries += 1; m.dollars += summable ? amount : 0; m.quantity += Number(a.quantity) || 0; m.complete += isComplete ? 1 : 0;
      if (!m.lastDate || a.date > m.lastDate) m.lastDate = a.date;
      byMember.set(a.user_id, m);
    }
    const cat = a.category || 'Other';
    byCategory[cat] ||= { entries: 0, dollars: 0 };
    byCategory[cat].entries += 1; byCategory[cat].dollars += summable ? amount : 0;
    const area = a.eval_area || 'Unassigned';
    byArea[area] = (byArea[area] || 0) + 1;
    const team = byTeam.get(a.unit_id) || { entries: 0, dollars: 0, contributors: new Set<string>() };
    team.entries += 1; team.dollars += summable ? amount : 0; team.contributors.add(a.user_id);
    byTeam.set(a.unit_id, team);
    // Counted once, in the window's first week for an entry begun before it (ADR-0018).
    const wk = weekKey(a.date < from ? from : a.date);
    const w = byWeek.get(wk) || { entries: 0, dollars: 0 };
    w.entries += 1; w.dollars += summable ? amount : 0;
    byWeek.set(wk, w);
  }

  // Only open tasks count, so only open tasks are read, and each is added to its holder once.
  const todayIso = zonedDay(ctx.config.timezone);
  const tasks = db.prepare(`SELECT unit_id, due_date, assignee_id, user_id FROM tasks WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND status <> 'completed'`).all(units) as Array<{ unit_id: string; due_date: string | null; assignee_id: string | null; user_id: string }>;
  let overdueTasks = 0;
  const heldBy = new Map<string, { open: number; overdue: number }>();
  for (const t of tasks) {
    const late = Boolean(t.due_date && t.due_date < todayIso);
    if (late) overdueTasks += 1;
    if (!named(t.unit_id)) continue;
    const holder = t.assignee_id || t.user_id;
    const n = heldBy.get(holder) || { open: 0, overdue: 0 };
    n.open += 1; if (late) n.overdue += 1;
    heldBy.set(holder, n);
  }
  const goals = db.prepare(`SELECT status, current_value, target_value, period_end FROM goals WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL`).all(units) as Array<{ status: string; current_value: number; target_value: number | null; period_end: string | null }>;
  const awards = db.prepare(`SELECT status, COUNT(*) AS n FROM awards WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND status IN ('recommended','submitted','approved') GROUP BY status`).all(units) as Array<{ status: string; n: number }>;
  const counselings = db.prepare(`SELECT user_id, unit_id, MAX(date) AS last FROM counselings WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND stage = 'final' GROUP BY user_id, unit_id`).all(units) as Array<{ user_id: string; unit_id: string; last: string | null }>;
  // How many are due is the unit's count; the date beside a Marine's name comes only from units they are seen in by Marine.
  const lastCounseling = new Map<string, string | null>();
  const lastCounselingNamed = new Map<string, string | null>();
  const latest = (map: Map<string, string | null>, id: string, last: string | null) => { const was = map.get(id); if (!was || (last && last > was)) map.set(id, last); };
  for (const c of counselings) { latest(lastCounseling, c.user_id, c.last); if (named(c.unit_id)) latest(lastCounselingNamed, c.user_id, c.last); }
  const readiness = db.prepare(`SELECT r.user_id, r.pft_score, r.cft_score, r.rifle_qual, r.mcmap_belt, r.pme_complete FROM readiness r WHERE r.user_id IN (SELECT um.user_id FROM unit_members um WHERE um.unit_id IN (SELECT value FROM json_each(?)))`).all(units) as Array<{ user_id: string; pft_score: number | null; cft_score: number | null; rifle_qual: string | null; mcmap_belt: string | null; pme_complete: string | null }>;
  const readinessMap = new Map(readiness.map((r) => [r.user_id, r]));
  const pfts = readiness.map((r) => r.pft_score).filter((n): n is number => n != null);
  const cfts = readiness.map((r) => r.cft_score).filter((n): n is number => n != null);
  const avg = (list: number[]) => (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null);

  const cutoff = zonedDay(ctx.config.timezone, -45);
  const due = (last: string | null | undefined) => !last || last < cutoff;
  const memberRows = listed.map((m) => {
    const stats = byMember.get(m.id) || { entries: 0, dollars: 0, quantity: 0, complete: 0, lastDate: null };
    const r = readinessMap.get(m.id);
    const held = heldBy.get(m.id);
    const last = lastCounselingNamed.get(m.id) || null;
    return {
      id: m.id, name: `${m.last_name}, ${m.first_name}`, rank_abbr: m.rank_abbr, billet: m.billet, mos: m.mos, team: unitIds.length > 1 ? m.team : null,
      entries: stats.entries, dollars: Math.round(stats.dollars * 100) / 100, quantity: stats.quantity,
      completeness: stats.entries ? Math.round((stats.complete / stats.entries) * 100) : null,
      last_entry: stats.lastDate, open_tasks: held?.open || 0, overdue_tasks: held?.overdue || 0,
      last_counseling: last, counseling_due: due(last),
      readiness_complete: r ? [r.pft_score, r.cft_score, r.rifle_qual, r.mcmap_belt, r.pme_complete].filter((v) => v != null && v !== '').length : 0,
    };
  });
  const names = unitsById(ctx, unitIds);
  const membersIn = new Map<string, number>();
  for (const m of members) membersIn.set(m.unit_id, (membersIn.get(m.unit_id) || 0) + 1);

  return {
    unit_id: unitId, from, to, rolls_up: Math.max(0, unitIds.length - 1),
    totals: {
      members: members.length, entries: activities.length, contributors: contributors.size, dollars: Math.round(dollars * 100) / 100, reviewed: Math.round(reviewed * 100) / 100,
      completeness: activities.length ? Math.round((complete / activities.length) * 100) : 0,
      open_tasks: tasks.length, overdue_tasks: overdueTasks,
      active_goals: goals.filter((g) => g.status === 'active').length,
      goals_achieved: goals.filter((g) => g.status === 'achieved').length,
      awards_in_progress: awards.reduce((n, a) => n + a.n, 0),
      counseling_due: members.filter((m) => due(lastCounseling.get(m.id))).length,
      avg_pft: avg(pfts), avg_cft: avg(cfts), readiness_reported: readiness.length,
    },
    by_category: Object.entries(byCategory).map(([category, v]) => ({ category, ...v })).sort((a, b) => b.entries - a.entries),
    by_area: Object.entries(byArea).map(([area, entries]) => ({ area, entries })).sort((a, b) => b.entries - a.entries),
    weekly: everyWeek(byWeek, from, to, todayIso),
    by_team: unitIds.length > 1 ? unitIds.filter((id, i) => i > 0 || byTeam.has(id)).map((id) => {
      const unit = names.get(id);
      const t = byTeam.get(id);
      return { unit_id: id, name: unit ? unit.short_name || unit.name : id, members: membersIn.get(id) || 0, entries: t?.entries || 0, dollars: Math.round((t?.dollars || 0) * 100) / 100, contributors: t?.contributors.size || 0 };
    }) : [],
    members: memberRows,
    awards_pipeline: awards,
  };
}

/** Totals built from fewer people than this are withheld from anyone who cannot read the records themselves. */
export const OVERVIEW_MIN_CONTRIBUTORS = 3;

/**
 * What a unit looks like from inside it: who is in it, how its teams are doing, and the goals it is working to.
 * Where the reader views a unit's shared records they see its every figure; everywhere else, figures only where at
 * least three people contributed, so no one's own numbers can be read off a total. That is decided unit by unit, so a
 * role that does not reach the teams beneath (position 0) sees those teams as any member of the command does.
 */
export function unitOverview(ctx: AppContext, unitId: string, opts: { from: string; to: string; readable: ReadonlySet<string>; goalUnits: string[]; roster?: boolean }) {
  const db = ctx.db;
  const unitIds = subtreeIds(ctx, unitId);
  const units = JSON.stringify(unitIds);
  const named = unitsById(ctx, unitIds);
  const unit = named.get(unitId) ?? (db.prepare('SELECT id, name, short_name, parent_id FROM units WHERE id = ?').get(unitId) as UnitName);
  const parent = unit.parent_id ? db.prepare('SELECT id, name, short_name FROM units WHERE id = ?').get(unit.parent_id) as { id: string; name: string; short_name: string | null } | undefined : undefined;
  const members = membersAcross(ctx, unitIds);
  const period = periodClause('activities', 'activities', opts.from, opts.to);
  const rows = db.prepare(`SELECT user_id, unit_id, dollar_amount, dollar_type FROM activities ${BY_LAST_DAY.activities} WHERE unit_id IN (SELECT value FROM json_each(?)) AND visibility = 'unit' AND deleted_at IS NULL AND ${period.sql}`)
    .all(units, ...period.params) as Array<{ user_id: string; unit_id: string; dollar_amount: number | null; dollar_type: string | null }>;
  const fullIn = (id: string) => opts.readable.has(id);

  const people = (list: typeof rows) => new Set(list.map((r) => r.user_id)).size;
  const withheld = { entries: null, contributors: null, dollars: null, withheld: true } as const;
  const tally = (list: typeof rows, full: boolean) => {
    const contributors = people(list);
    const shown = full || contributors >= OVERVIEW_MIN_CONTRIBUTORS;
    const dollars = list.reduce((sum, r) => sum + (isSummable(r.dollar_type, ctx.runtime.metrics) ? Number(r.dollar_amount) || 0 : 0), 0);
    return shown ? { entries: list.length, contributors, dollars: Math.round(dollars * 100) / 100, withheld: false } : withheld;
  };

  const rowsIn = new Map<string, typeof rows>();
  for (const r of rows) { const list = rowsIn.get(r.unit_id); if (list) list.push(r); else rowsIn.set(r.unit_id, [r]); }
  const membersIn = new Map<string, number>();
  for (const m of members) membersIn.set(m.unit_id, (membersIn.get(m.unit_id) || 0) + 1);
  const teams = unitIds.slice(1).map((id) => {
    const t = named.get(id)!;
    return { unit_id: id, name: t.short_name || t.name, full_name: t.name, parent_id: t.parent_id, members: membersIn.get(id) || 0, ...tally(rowsIn.get(id) || [], fullIn(id)) };
  });

  // The total minus the teams shown, and minus what the reader may read in full, is everything else: any withheld team,
  // and the unit's own entries unless the reader reads them. Show the total only when that remainder could be shown in
  // its own right (empty with nothing withheld, or at least three people behind it); otherwise subtracting recovers the
  // figure a team was withheld to protect.
  const shownTeams = new Set(teams.filter((t) => !t.withheld).map((t) => t.unit_id));
  const hidden = rows.filter((r) => !shownTeams.has(r.unit_id) && !fullIn(r.unit_id));
  const exposed = teams.some((t) => t.withheld) || hidden.length > 0;
  const everyFull = unitIds.every(fullIn);
  const totals = everyFull ? tally(rows, true) : exposed && people(hidden) < OVERVIEW_MIN_CONTRIBUTORS ? withheld : tally(rows, false);

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
    level: fullIn(unitId) ? 'full' : 'overview',
    window: { from: opts.from, to: opts.to },
    totals: { members: members.length, teams: teams.length, ...totals },
    teams,
    // Only the Team page lists the roster; Today's pulse shows the totals, teams and goals and asks for no names.
    ...(opts.roster ? { roster: members.map((m) => ({ id: m.id, name: `${m.last_name}, ${m.first_name}`, rank_abbr: m.rank_abbr, billet: m.billet, team: m.team, unit_id: m.unit_id })) } : {}),
    goals,
    minimum_contributors: OVERVIEW_MIN_CONTRIBUTORS,
  };
}
