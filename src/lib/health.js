/**
 * Vantage — record health and the daily action list (v3.3 findings 45, 46).
 *
 * Two questions, answered from the Marine's own records with no server round
 * trip: "what should I do today?" and "how usable is this activity record?"
 * Everything here is Vantage coaching over the person's data — counts and
 * pointers, never a judgement of the Marine — and every item carries a route
 * so the dashboard can send you straight to the fix.
 */

import { findDuplicates } from './duplicates.js';
import { daysUntil } from './evaluation.js';

const DAY = 86_400_000;
const ageDays = (iso, now) => {
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY);
};

/** Readiness inputs per track — the fields the Readiness page actually asks for. */
const READINESS_FIELDS = {
  jepes: [
    ['rifle_qual', 'rifle qualification'], ['mcmap_belt', 'MCMAP belt'],
    ['pft_score', 'PFT'], ['cft_score', 'CFT'], ['ceus', 'MarineNet CEUs'],
    ['pme_complete', 'PME status'],
    ['cmd_character', 'command mark: character'], ['cmd_mos', 'command mark: MOS'],
    ['cmd_leadership', 'command mark: leadership'],
  ],
  fitrep: [
    ['pft_score', 'PFT'], ['cft_score', 'CFT'],
    ['rifle_qual', 'rifle qualification'], ['pme_complete', 'PME status'],
  ],
};

const missing = (v) => v === null || v === undefined || v === '';

/**
 * Record health for one Marine's own log (finding 46). Returns issue rows
 * `{ key, label, count, detail, to }` — an empty array is a clean bill.
 */
export function recordHealth({ activities = [], goals = [], profile = null, track = 'jepes', now = new Date() } = {}) {
  const issues = [];
  const push = (key, count, label, detail, to) => {
    if (count > 0) issues.push({ key, count, label, detail, to });
  };

  const noOutcome = activities.filter((a) => !a.result || !String(a.result).trim());
  push('outcomes', noOutcome.length, 'missing an outcome',
    'An entry without a result is a task you did, not an accomplishment — these get cut from packages first.',
    '/activities');

  const untagged = activities.filter((a) => !a.jepes_area || a.jepes_area === 'Unassigned');
  push('untagged', untagged.length, 'untagged',
    'Untagged entries fall into the fallback bucket of every narrative instead of the area they earned.',
    '/activities');

  const undated = activities.filter((a) => missing(a.date));
  push('dates', undated.length, 'missing a date',
    'Undated work sorts to the wrong reporting period, or to none.',
    '/activities');

  const dupes = findDuplicates(activities);
  push('duplicates', dupes.length, 'possible duplicate pairs',
    'Likely the same event logged twice — usually an import overlapping hand entry.',
    '/activities');

  const staleGoals = goals.filter((g) => {
    if (g.status !== 'active') return false;
    const past = g.period_end && (daysUntil(g.period_end, now) ?? 1) < 0;
    const idle = (ageDays(g.updated_at || g.created_at, now) ?? 0) > 45;
    return past || idle;
  });
  push('goals', staleGoals.length, 'stale goals',
    'Active goals past their period or untouched for 45+ days — retire them or move them.',
    '/goals');

  if (profile) {
    const fields = READINESS_FIELDS[track] || READINESS_FIELDS.jepes;
    const blank = fields.filter(([key]) => missing(profile[key]));
    push('readiness', blank.length, 'readiness fields empty',
      `Not entered: ${blank.map(([, label]) => label).join(', ')}. Unknown is honest, but it plans nothing.`,
      '/readiness');
  }

  return issues;
}

/**
 * The "Today" block (finding 45): the short, ordered list of what actually
 * needs the Marine's attention right now. Same row shape as recordHealth.
 */
export function todayActions({
  tasks = [], goals = [], activities = [], profile = null, track = 'jepes',
  fitrepPeriodEnd = null, now = new Date(),
} = {}) {
  const out = [];
  const today = now.toISOString().slice(0, 10);

  const overdue = tasks.filter((t) => t.status !== 'completed' && t.due_date && t.due_date < today);
  if (overdue.length) {
    out.push({
      key: 'overdue', count: overdue.length,
      label: `overdue task${overdue.length === 1 ? '' : 's'}`,
      detail: overdue.slice(0, 2).map((t) => t.title).join(' · '),
      to: '/work',
    });
  }

  const goalsDue = goals.filter((g) => {
    if (g.status !== 'active' || !g.period_end) return false;
    const d = daysUntil(g.period_end, now);
    return d !== null && d <= 14;
  });
  if (goalsDue.length) {
    out.push({
      key: 'goals-due', count: goalsDue.length,
      label: `goal${goalsDue.length === 1 ? '' : 's'} inside two weeks of period end`,
      detail: goalsDue.slice(0, 2).map((g) => g.title).join(' · '),
      to: '/goals',
    });
  }

  const recentNoOutcome = activities.filter((a) => {
    const age = ageDays(a.date, now);
    return age !== null && age <= 30 && (!a.result || !String(a.result).trim());
  });
  if (recentNoOutcome.length) {
    out.push({
      key: 'recent-outcomes', count: recentNoOutcome.length,
      label: `recent entr${recentNoOutcome.length === 1 ? 'y' : 'ies'} missing an outcome`,
      detail: 'Fix them the week you log them, not the week the package is due.',
      to: '/activities',
    });
  }

  if (profile) {
    const fields = READINESS_FIELDS[track] || READINESS_FIELDS.jepes;
    const blank = fields.filter(([key]) => missing(profile[key]));
    if (blank.length) {
      out.push({
        key: 'readiness', count: blank.length,
        label: `readiness field${blank.length === 1 ? '' : 's'} incomplete`,
        detail: blank.slice(0, 3).map(([, label]) => label).join(' · '),
        to: '/readiness',
      });
    }
  }

  if (track === 'fitrep' && fitrepPeriodEnd) {
    const d = daysUntil(fitrepPeriodEnd, now);
    if (d !== null && d >= 0 && d <= 45) {
      out.push({
        key: 'fitrep-period', count: null,
        label: `FITREP period ends in ${d} day${d === 1 ? '' : 's'}`,
        detail: 'Get your input to your Reporting Senior before they sit down to write.',
        to: '/readiness',
      });
    }
  }

  return out;
}
