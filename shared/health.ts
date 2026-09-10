import { findDuplicates } from './duplicates.ts';
import { daysUntil } from './evaluation.ts';

const DAY = 86_400_000;
const ageDays = (iso: string | null | undefined, now: Date) => {
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY);
};

const READINESS_FIELDS: Record<string, Array<[string, string]>> = {
  jepes: [
    ['rifle_qual', 'rifle qualification'], ['mcmap_belt', 'MCMAP belt'], ['pft_score', 'PFT'], ['cft_score', 'CFT'], ['ceus', 'MarineNet CEUs'],
    ['pme_complete', 'PME status'], ['cmd_character', 'command mark: character'], ['cmd_mos', 'command mark: MOS'], ['cmd_leadership', 'command mark: leadership'],
  ],
  fitrep: [['pft_score', 'PFT'], ['cft_score', 'CFT'], ['rifle_qual', 'rifle qualification'], ['pme_complete', 'PME status']],
};

const missing = (v: unknown) => v === null || v === undefined || v === '';

export interface HealthIssue { key: string; count: number; label: string; detail: string; to: string }

interface HealthInput {
  activities?: Array<{ result?: string | null; eval_area?: string | null; date?: string | null; title?: string | null; dollar_amount?: number | null; quantity?: number | null; created_at?: string }>;
  goals?: Array<{ status?: string; period_end?: string | null; updated_at?: string; created_at?: string }>;
  profile?: Record<string, unknown> | null; track?: string; now?: Date;
}

export function recordHealth({ activities = [], goals = [], profile = null, track = 'jepes', now = new Date() }: HealthInput = {}): HealthIssue[] {
  const issues: HealthIssue[] = [];
  const push = (key: string, count: number, label: string, detail: string, to: string) => { if (count > 0) issues.push({ key, count, label, detail, to }); };
  const noOutcome = activities.filter((a) => !a.result || !String(a.result).trim());
  push('outcomes', noOutcome.length, 'missing an outcome', 'An entry without a result is a task you did, not an accomplishment. These get cut from packages first.', '/records?quality=needs-detail');
  const untagged = activities.filter((a) => !a.eval_area || a.eval_area === 'Unassigned');
  push('untagged', untagged.length, 'untagged', 'Untagged entries fall into the fallback bucket of every narrative instead of the area they earned.', '/records?quality=untagged');
  const undated = activities.filter((a) => missing(a.date));
  push('dates', undated.length, 'missing a date', 'Undated work sorts to the wrong reporting period, or to none.', '/records');
  const dupes = findDuplicates(activities);
  push('duplicates', dupes.length, 'possible duplicate pairs', 'Likely the same event logged twice, usually an import overlapping hand entry.', '/records?quality=duplicates');
  const staleGoals = goals.filter((g) => {
    if (g.status !== 'active') return false;
    const past = g.period_end && (daysUntil(g.period_end, now) ?? 1) < 0;
    const idle = (ageDays(g.updated_at || g.created_at, now) ?? 0) > 45;
    return past || idle;
  });
  push('goals', staleGoals.length, 'stale goals', 'Active goals past their period or untouched for 45+ days. Retire them or move them.', '/goals');
  if (profile) {
    const fields = READINESS_FIELDS[track] || READINESS_FIELDS.jepes;
    const blank = fields.filter(([key]) => missing(profile[key]));
    push('readiness', blank.length, 'readiness fields empty', `Not entered: ${blank.map(([, label]) => label).join(', ')}. Unknown is honest, but it plans nothing.`, '/readiness');
  }
  return issues;
}

export interface TodayAction { key: string; count: number | null; label: string; detail: string; to: string }

export function todayActions({
  tasks = [], goals = [], activities = [], profile = null, track = 'jepes', fitrepPeriodEnd = null, now = new Date(),
}: {
  tasks?: Array<{ status?: string; due_date?: string | null; title?: string }>;
  goals?: Array<{ status?: string; period_end?: string | null; title?: string }>;
  activities?: Array<{ date?: string | null; result?: string | null }>;
  profile?: Record<string, unknown> | null; track?: string; fitrepPeriodEnd?: string | null; now?: Date;
} = {}): TodayAction[] {
  const out: TodayAction[] = [];
  const today = now.toISOString().slice(0, 10);
  const overdue = tasks.filter((t) => t.status !== 'completed' && t.due_date && t.due_date < today);
  if (overdue.length) out.push({ key: 'overdue', count: overdue.length, label: `overdue task${overdue.length === 1 ? '' : 's'}`, detail: overdue.slice(0, 2).map((t) => t.title || '').join(' · '), to: '/work' });
  const goalsDue = goals.filter((g) => { if (g.status !== 'active' || !g.period_end) return false; const d = daysUntil(g.period_end, now); return d !== null && d <= 14; });
  if (goalsDue.length) out.push({ key: 'goals-due', count: goalsDue.length, label: `goal${goalsDue.length === 1 ? '' : 's'} closing within 14 days`, detail: goalsDue.slice(0, 2).map((g) => g.title || '').join(' · '), to: '/goals' });
  const recentNoOutcome = activities.filter((a) => { const age = ageDays(a.date, now); return age !== null && age <= 30 && (!a.result || !String(a.result).trim()); });
  if (recentNoOutcome.length) out.push({ key: 'recent-outcomes', count: recentNoOutcome.length, label: `recent entr${recentNoOutcome.length === 1 ? 'y' : 'ies'} missing an outcome`, detail: 'Fix them the week you log them, not the week the package is due.', to: '/records?quality=needs-detail' });
  if (profile) {
    const fields = READINESS_FIELDS[track] || READINESS_FIELDS.jepes;
    const blank = fields.filter(([key]) => missing(profile[key]));
    if (blank.length) out.push({ key: 'readiness', count: blank.length, label: `readiness field${blank.length === 1 ? '' : 's'} incomplete`, detail: blank.slice(0, 3).map(([, label]) => label).join(' · '), to: '/readiness' });
  }
  if (track === 'fitrep' && fitrepPeriodEnd) {
    const d = daysUntil(fitrepPeriodEnd, now);
    if (d !== null && d >= 0 && d <= 45) out.push({ key: 'fitrep-period', count: null, label: `FITREP period ends in ${d} day${d === 1 ? '' : 's'}`, detail: 'Get your input to your Reporting Senior before they sit down to write.', to: '/readiness' });
  }
  return out;
}
