import { zonedDay } from '../lib/clock.ts';
import { withGoalProgress } from './records.ts';
import type { AppContext } from '../context.ts';
import { layout } from './mailLayout.ts';
import { audit } from './audit.ts';
import { formatDollars } from '../../shared/metrics.ts';
import { isSummable } from '../../shared/constants.ts';
import { now } from '../lib/ids.ts';

interface DigestUser { id: string; email: string | null; first_name: string; last_name: string; prefs: string; digest_last_sent_at: string | null }

const clocks = new Map<string, Intl.DateTimeFormat>();

/** Local weekday (0 = Sunday) and hour in the instance timezone. */
export function localClock(timezone: string, at = new Date()) {
  let clock = clocks.get(timezone);
  if (!clock) clocks.set(timezone, clock = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }));
  const parts = clock.formatToParts(at);
  const weekdayName = parts.find((p) => p.type === 'weekday')?.value || 'Mon';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0) % 24;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);
  return { weekday: weekday < 0 ? 1 : weekday, hour };
}

export function composeDigest(ctx: AppContext, user: DigestUser, at = new Date()) {
  const db = ctx.db;
  const since = zonedDay(ctx.config.timezone, -7, at);
  const todayIso = zonedDay(ctx.config.timezone, 0, at);
  const soon = zonedDay(ctx.config.timezone, 14, at);
  const acts = db.prepare(`SELECT title, dollar_amount, dollar_type, result FROM activities WHERE user_id = ? AND deleted_at IS NULL AND date >= ? ORDER BY date DESC`).all(user.id, since) as Array<{ title: string; dollar_amount: number | null; dollar_type: string | null; result: string | null }>;
  const dollars = acts.reduce((n, a) => n + (isSummable(a.dollar_type, ctx.runtime.metrics) ? Number(a.dollar_amount) || 0 : 0), 0);
  const noOutcome = acts.filter((a) => !a.result).length;
  const overdue = db.prepare(`SELECT title, due_date FROM tasks WHERE (user_id = ? OR assignee_id = ?) AND status <> 'completed' AND deleted_at IS NULL AND due_date < ? ORDER BY due_date LIMIT 5`).all(user.id, user.id, todayIso) as Array<{ title: string; due_date: string }>;
  const dueSoon = db.prepare(`SELECT title, due_date FROM tasks WHERE (user_id = ? OR assignee_id = ?) AND status <> 'completed' AND deleted_at IS NULL AND due_date >= ? AND due_date <= ? ORDER BY due_date LIMIT 5`).all(user.id, user.id, todayIso, soon) as Array<{ title: string; due_date: string }>;
  const goals = withGoalProgress(ctx, db.prepare(`SELECT * FROM goals WHERE (user_id = ? OR assignee_id = ?) AND status = 'active' AND deleted_at IS NULL AND period_end >= ? AND period_end <= ? ORDER BY period_end LIMIT 5`).all(user.id, user.id, todayIso, soon) as Array<{ title: string; period_end: string; current_value: number; target_value: number | null; metric: string; user_id: string }>);
  const maradmins = db.prepare(`SELECT number, title FROM maradmins WHERE published_at >= ? ORDER BY published_at DESC LIMIT 6`).all(new Date(at.getTime() - 7 * 86_400_000).toISOString()) as Array<{ number: string; title: string }>;
  const followUps = db.prepare(`SELECT c.follow_up_date, u.first_name, u.last_name FROM counselings c JOIN users u ON u.id = c.user_id WHERE c.counselor_id = ? AND c.deleted_at IS NULL AND c.follow_up_date >= ? AND c.follow_up_date <= ? ORDER BY c.follow_up_date LIMIT 5`).all(user.id, todayIso, soon) as Array<{ follow_up_date: string; first_name: string; last_name: string }>;

  const sections: Array<{ heading: string; lines: string[] }> = [];
  // The totals lead the message as figures; this section is what is behind them.
  sections.push({ heading: 'Last 7 days', lines: [
    ...(noOutcome ? [`${noOutcome} recent ${noOutcome === 1 ? 'entry is' : 'entries are'} missing an outcome`] : []),
    ...acts.slice(0, 3).map((a) => a.title),
  ] });
  if (overdue.length || dueSoon.length) sections.push({ heading: 'Tasks', lines: [...overdue.map((t) => `Overdue: ${t.title} (due ${t.due_date})`), ...dueSoon.map((t) => `Due ${t.due_date}: ${t.title}`)] });
  if (goals.length) sections.push({ heading: 'Goals closing soon', lines: goals.map((g) => `${g.title} closes ${g.period_end}${g.target_value ? ` (${g.current_value} of ${g.target_value})` : ''}`) });
  if (followUps.length) sections.push({ heading: 'Counseling follow-ups', lines: followUps.map((f) => `${f.first_name} ${f.last_name} on ${f.follow_up_date}`) });
  if (maradmins.length) sections.push({ heading: 'New MARADMINs', lines: maradmins.map((m) => `${m.number}: ${m.title}`) });

  const subject = `Vantage weekly: ${acts.length} logged${overdue.length ? `, ${overdue.length} overdue` : ''}`;
  const content = layout({
    eyebrow: 'Weekly digest',
    title: `Your week, ${user.first_name}`,
    intro: acts.length ? 'Here is what your record picked up this week and what needs attention next.' : 'Nothing was logged this week. One entry keeps the record current.',
    stats: [
      { label: acts.length === 1 ? 'entry logged' : 'entries logged', value: String(acts.length) },
      ...(dollars ? [{ label: 'headline impact', value: formatDollars(dollars), tone: 'good' as const }] : []),
      { label: 'overdue tasks', value: String(overdue.length), ...(overdue.length ? { tone: 'bad' as const } : {}) },
      { label: 'due in 14 days', value: String(dueSoon.length), ...(dueSoon.length ? { tone: 'warn' as const } : {}) },
    ],
    sections,
    cta: { label: 'Open Vantage', url: `${ctx.config.urls.app}/` },
    footer: 'You receive this weekly digest because it is enabled in Settings. Turn it off there at any time.',
    origin: ctx.config.urls.app,
  });
  return { subject, ...content, stats: { activities: acts.length, overdue: overdue.length } };
}

export async function sendDigest(ctx: AppContext, user: DigestUser) {
  if (!user.email) return { ok: false, error: 'No email on file.' };
  const digest = composeDigest(ctx, user);
  const result = await ctx.mailer.send({ to: user.email, subject: digest.subject, text: digest.text, html: digest.html, kind: 'digest', userId: user.id });
  if (result.ok) {
    ctx.db.prepare('UPDATE users SET digest_last_sent_at = ? WHERE id = ?').run(now(), user.id);
    audit(ctx, { actor_id: null, action: 'digest_sent', entity: 'user', entity_id: user.id, subject_id: user.id });
  }
  return result;
}

export async function runDigestTick(ctx: AppContext, at = new Date()) {
  if (!ctx.mailer.enabled) return { sent: 0, skipped: 'email disabled' };
  const clock = localClock(ctx.config.timezone, at);
  const users = ctx.db.prepare(`SELECT id, email, first_name, last_name, prefs, digest_last_sent_at FROM users WHERE active = 1 AND email IS NOT NULL`).all() as DigestUser[];
  let sent = 0;
  for (const user of users) {
    let prefs: { digest?: { enabled: boolean; weekday: number; hour: number } } = {};
    try { prefs = JSON.parse(user.prefs || '{}'); } catch {}
    const d = prefs.digest;
    if (!d?.enabled || d.weekday !== clock.weekday || d.hour !== clock.hour) continue;
    if (user.digest_last_sent_at && at.getTime() - new Date(user.digest_last_sent_at).getTime() < 6 * 86_400_000) continue;
    const result = await sendDigest(ctx, user);
    if (result.ok) sent += 1;
  }
  return { sent };
}
