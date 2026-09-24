import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bell, CalendarClock, CheckCircle2, GraduationCap, Hand, Inbox, Plus, Sparkles, Target, TrendingUp, Users } from 'lucide-react';
import { Badge, Button, EmptyState, Input, PageHeader, Panel, Progress, Skeleton } from '@/components/ui/primitives';
import { BarList } from '@/components/charts';
import { AiAction, AiResult } from '@/components/AiPanel';
import { DateText, PeriodSelect } from '@/components/common';
import { MetricTotalsGrid } from '@/components/MetricTotals';
import { WorkList, WorkRow } from '@/components/work';
import { AnimatePresence } from 'motion/react';
import {
  useAssignedWork, useCareer, useGoals, useIdentity, useMetricsReport, useNotifications, usePrefs, useReadiness, useRecordSummary,
  useSavePrefs, useTasks, useTrack, useWorkload,
} from '@/lib/queries';
import * as api from '@/lib/api';
import { WAITING_LABEL, type WaitingCategory } from '../../shared/caseModel';
import { rangeForPeriod, dayKey, formatNumber } from '../../shared/metrics';
import { todayActions } from '../../shared/health';
import { cn, timeAgo } from '@/lib/utils';

/**
 * Today answers, in order: what do I need to do, what am I waiting on, what changed, and what can I
 * quickly record. A leader sees their section first, because unassigned and blocked work is the
 * decision waiting on them. Every figure opens onto the records behind it, and nothing here counts
 * how often somebody opened a form.
 */
export default function Dashboard() {
  const navigate = useNavigate();
  const { data: identity } = useIdentity();
  const leadUnit = identity?.canLead ? identity.readableUnitIds[0] : null;
  const first = identity?.user.first_name;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const assigned = useAssignedWork();
  const { data: tasks } = useTasks();
  const summary = useRecordSummary({});

  const me = identity?.user.id;
  const myTasks = useMemo(() => (tasks || []).filter((t: any) => (t.assignee_id || t.user_id) === me && t.status !== 'completed'), [tasks, me]);
  const working = (assigned.data || []).filter((a) => !['waiting', 'blocked'].includes(a.stage));
  const waiting = (assigned.data || []).filter((a) => ['waiting', 'blocked'].includes(a.stage));

  const lede = assigned.isPending ? '' : [
    `${working.length} ${working.length === 1 ? 'item' : 'items'} in your hands`,
    waiting.length ? `${waiting.length} waiting on someone else` : null,
    myTasks.length ? `${myTasks.length} ${myTasks.length === 1 ? 'task' : 'tasks'} open` : null,
  ].filter(Boolean).join(', ') + '.';

  return (
    <div className="page">
      <PageHeader eyebrow={`${greeting}, ${first ?? ''}`} title="Today" lede={lede}>
        <Button onClick={() => navigate('/work')}><Inbox className="h-4 w-4" />Find work</Button>
        <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Plus className="h-4 w-4" />Log an activity</Button>
      </PageHeader>

      {leadUnit && <SectionOverview unitId={leadUnit} />}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Panel title="Your work" subtitle="What you hold, and the next useful step on each" padded={false}
            action={<Link to="/record" className="text-xs text-accent hover:underline">Your record</Link>}>
            {assigned.isPending ? <Skeleton className="m-4 h-24" /> : working.length || myTasks.length ? (
              <ul className="divide-y divide-line">
                <AnimatePresence initial={false}>{working.map((item) => <WorkRow key={item.id} item={item} />)}</AnimatePresence>
                {myTasks.slice(0, 4).map((t: any) => (
                  <li key={t.id}>
                    <Link to={`/records/tasks/${t.id}`} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2"><Badge tone={t.priority === 'high' || t.priority === 'critical' ? 'warn' : 'neutral'}>Task</Badge><span className="truncate text-sm font-medium text-ink">{t.title}</span></span>
                        {t.notes && <span className="mt-0.5 block truncate text-xs text-ink-3">{t.notes}</span>}
                      </span>
                      {t.due_date && <span className={cn('shrink-0 text-xs', t.due_date < new Date().toISOString().slice(0, 10) ? 'text-bad' : 'text-ink-3')}>Due <DateText value={t.due_date} /></span>}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : <AvailableWork />}
          </Panel>

          {waiting.length > 0 && (
            <Panel title="Waiting on someone else" subtitle="Elapsed time, shown separately from work. Nothing here needs you until it moves." padded={false}>
              <WorkList items={waiting} />
            </Panel>
          )}

          {working.length > 0 && <AvailableWork compact />}
        </div>

        <div className="space-y-4">
          <QuickCapture />
          <Changes />
          <PersonalPanel summary={summary.data} />
        </div>
      </div>

      <Outcomes />
    </div>
  );
}

/** Work nobody holds yet, so a new Marine knows where to start. */
function AvailableWork({ compact = false }: { compact?: boolean }) {
  const list = useQuery({ queryKey: ['work-items', { claimed: 'nobody', state: 'open', limit: 5 }], queryFn: () => api.listWorkItems({ claimed: 'nobody', state: 'open', sort: 'due_date', limit: 5 }), staleTime: 15_000 });
  const rows: any[] = list.data?.items || [];
  const body = list.isPending ? <Skeleton className="m-4 h-16" /> : rows.length ? (
    <WorkList items={rows} trailing={() => <span className="flex items-center gap-1 text-accent"><Hand className="h-3 w-3" aria-hidden />Open to claim</span>} />
  ) : <EmptyState title="Nothing waiting to be claimed" description="When a leader brings in a tasker, its items appear here." />;
  if (compact) return <Panel title="Open to claim" subtitle="Unassigned work in your units, soonest due first" padded={false} action={<Link to="/work?claimed=nobody" className="text-xs text-accent hover:underline">All open work</Link>}>{body}</Panel>;
  return (
    <div>
      <p className="border-b border-line px-4 py-3 text-sm text-ink-2">You are not holding anything. These are open to claim; claiming puts one on your list at once.</p>
      {body}
    </div>
  );
}

function QuickCapture() {
  const [text, setText] = useState('');
  const open = (seed: string) => { window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: seed })); setText(''); };
  return (
    <Panel title="Quick capture" subtitle="PME, PT, volunteering, anything that did not start as a tasker">
      <form onSubmit={(e) => { e.preventDefault(); open(text); }} className="flex gap-2">
        <Input aria-label="What did you do?" placeholder="Volunteered 6 hours at the food pantry" value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit" variant="primary" aria-label="Capture it"><Plus className="h-4 w-4" /></Button>
      </form>
      <p className="mt-2 text-xs text-ink-3">Work you do in Vantage is recorded for you. Use this for everything else. Press <kbd className="kbd">N</kbd> anywhere.</p>
    </Panel>
  );
}

function Changes() {
  const { data } = useNotifications();
  const rows: any[] = (data?.rows || []).filter((n: any) => !n.read_at).slice(0, 4);
  return (
    <Panel title="Since you last looked" action={<Bell className="h-4 w-4 text-ink-3" aria-hidden />} padded={false}>
      {rows.length === 0 ? <p className="px-4 py-3 text-sm text-ink-3">Nothing new.</p> : (
        <ul className="divide-y divide-line">
          {rows.map((n) => (
            <li key={n.id}>
              {n.action_url ? (
                <Link to={n.action_url} className="block px-4 py-2.5 hover:bg-surface-2">
                  <span className="block text-sm text-ink">{n.title}</span>
                  <span className="block text-xs text-ink-3">{n.message ? `${n.message} · ` : ''}{timeAgo(n.created_at)}</span>
                </Link>
              ) : (
                <div className="px-4 py-2.5"><span className="block text-sm text-ink">{n.title}</span><span className="block text-xs text-ink-3">{timeAgo(n.created_at)}</span></div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** A short, personal reminder: the record, a goal, and a concrete career step. */
function PersonalPanel({ summary }: { summary: any }) {
  const { data: goals } = useGoals();
  const career = useCareer();
  const { data: readiness } = useReadiness();
  const track = useTrack();
  const { data: identity } = useIdentity();
  const active = (goals || []).filter((g: any) => g.status === 'active' && (g.assignee_id || g.user_id) === identity?.user.id).slice(0, 2);
  const nextStep = (career.data?.steps || []).find((s: any) => s.status === 'in_progress' || s.status === 'planned');
  const reminders = useMemo(() => todayActions({ tasks: [], goals: goals || [], activities: [], profile: readiness || null, track, fitrepPeriodEnd: readiness?.fitrep_period_end }).slice(0, 2), [goals, readiness, track]);
  return (
    <Panel title="Your record and development">
      {summary && (
        <Link to="/record" className="mb-3 grid grid-cols-3 gap-2 rounded-md border border-line p-2 text-center hover:border-line-strong">
          <span><span className="fig block text-lg font-semibold text-ink">{summary.contributions.documents_researched}</span><span className="text-2xs text-ink-3">documents researched</span></span>
          <span><span className="fig block text-lg font-semibold text-ink">{summary.contributions.verified_outcomes}</span><span className="text-2xs text-ink-3">verified</span></span>
          <span><span className="fig block text-lg font-semibold text-ink">{summary.personal.activities}</span><span className="text-2xs text-ink-3">own entries</span></span>
        </Link>
      )}
      <ul className="space-y-3 text-sm">
        {active.map((g: any) => {
          const pct = g.progress?.percent ?? (g.target_value ? Math.min(100, (Number(g.current_value) / Number(g.target_value)) * 100) : 0);
          return (
            <li key={g.id}>
              <Link to="/goals" className="flex items-baseline justify-between gap-2 hover:underline"><span className="flex items-center gap-1.5 truncate text-ink"><Target className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />{g.title}</span><span className="fig shrink-0 text-xs text-ink-3">{formatNumber(Number(g.current_value))}{g.target_value ? ` / ${formatNumber(Number(g.target_value))}` : ''}</span></Link>
              <Progress value={pct} className="mt-1" tone={pct >= 100 ? 'good' : 'accent'} label={`${g.title} progress`} />
            </li>
          );
        })}
        {nextStep && (
          <li>
            <Link to="/career" className="flex items-start gap-1.5 text-ink hover:underline"><GraduationCap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden /><span>Next career step: {nextStep.title}{nextStep.due_date ? <span className="text-ink-3"> · by <DateText value={nextStep.due_date} /></span> : null}</span></Link>
          </li>
        )}
        {reminders.map((a) => (
          <li key={a.key}><Link to={a.to === '/readiness' ? '/career?tab=readiness' : a.to} className="flex items-start gap-1.5 text-ink-2 hover:underline"><CalendarClock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden />{a.label}</Link></li>
        ))}
        {!active.length && !nextStep && !reminders.length && <li className="text-ink-3">Set a goal or a career step and it shows here.</li>}
      </ul>
    </Panel>
  );
}

/** The leader's view: unassigned and blocked work, what the section is waiting on, and who holds what. */
function SectionOverview({ unitId }: { unitId: string }) {
  const w = useWorkload(unitId);
  if (w.isPending) return <Skeleton className="mb-6 h-40" />;
  if (w.isError || !w.data) return null;
  const s = w.data.section;
  const unitLabel: string = w.data.unit_name || 'Your section';
  const waitingBits = Object.entries(s.by_waiting as Record<string, { count: number; oldest_hours: number }>);
  return (
    <section aria-labelledby="section-heading" className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="section-heading" className="flex items-center gap-2 text-md font-semibold text-ink"><Users className="h-4 w-4 text-accent" aria-hidden />{unitLabel}</h2>
        <Link to="/team?tab=workload" className="text-xs text-accent hover:underline">Full workload</Link>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Unassigned" value={s.unassigned} hint="open to claim or assign" to="/work?claimed=nobody" tone={s.unassigned ? 'accent' : undefined} />
        <Tile label="Overdue" value={s.overdue} hint="past due and still open" to="/team?tab=workload" tone={s.overdue ? 'bad' : undefined} />
        <Tile label="Blocked" value={s.blocked} hint="something is in the way" to="/team?tab=workload" tone={s.blocked ? 'warn' : undefined} />
        <Tile label="Waiting" value={s.waiting} hint={waitingBits.map(([k, v]) => `${v.count} ${WAITING_LABEL[k as WaitingCategory]?.toLowerCase() || k}`).join(', ') || 'on approvals or posting'} to="/team?tab=workload" />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Needs a decision" subtitle="Blocked, overdue, or waiting on verification" padded={false}>
          {w.data.attention.length === 0 ? <p className="px-4 py-3 text-sm text-ink-3">Nothing is stuck.</p> : (
            <WorkList items={w.data.attention.slice(0, 5)} />
          )}
        </Panel>
        <Panel title="Who holds what" subtitle={`Open work held now, with documents researched since ${w.data.window.from}`}>
          {w.data.members_visible ? (
            <BarList
              items={w.data.members.filter((m: any) => m.assigned || m.documents_researched).map((m: any) => ({ label: `${m.rank_abbr ? `${m.rank_abbr} ` : ''}${m.name}`, value: m.assigned, hint: `${m.documents_researched} documents researched${m.waiting ? `, ${m.waiting} waiting` : ''}${m.blocked ? `, ${m.blocked} blocked` : ''}` }))}
              format={(v) => `${v} held`}
            />
          ) : <p className="text-sm text-ink-3">Your role shows section totals only.</p>}
          <p className="mt-3 text-xs text-ink-3">Counts show what was recorded. They do not measure effort or quality, and zero recorded is not zero work.</p>
        </Panel>
      </div>
    </section>
  );
}

function Tile({ label, value, hint, to, tone }: { label: string; value: number; hint: string; to: string; tone?: 'accent' | 'bad' | 'warn' }) {
  return (
    <Link to={to} className="card card-hover block p-4">
      <p className="text-sm font-medium text-ink-2">{label}</p>
      <p className={cn('stat-value mt-2', tone === 'accent' && 'text-accent', tone === 'bad' && 'text-bad', tone === 'warn' && 'text-warn')}>{value}</p>
      <p className="mt-1 truncate text-xs text-ink-3">{hint}</p>
    </Link>
  );
}

/**
 * The measured outcomes a person logged themselves, kept from the earlier Today: the same figures,
 * read from the metrics endpoint, lower on the page because they answer "how is the year going"
 * rather than "what do I do now".
 */
function Outcomes() {
  const prefs = usePrefs();
  const savePrefs = useSavePrefs();
  const [review, setReview] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  const { data: identity } = useIdentity();
  const period = prefs.dashboardPeriod || 'fiscalYear';
  const range = useMemo(() => rangeForPeriod(period), [period]);
  const params = useMemo(() => ({ from: dayKey(range.start), to: dayKey(range.end), scope: 'me' }), [range]);
  const report = useMetricsReport(params);
  return (
    <section aria-labelledby="outcomes-heading" className="mt-8">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 id="outcomes-heading" className="flex items-center gap-2 text-md font-semibold text-ink"><TrendingUp className="h-4 w-4 text-accent" aria-hidden />Outcomes you logged, {range.label.toLowerCase()}</h2>
        <PeriodSelect value={period} onChange={(v) => savePrefs.mutate({ dashboardPeriod: v })} className="w-44" />
      </div>
      {report.isPending ? <Skeleton className="h-28" /> : (
        <MetricTotalsGrid
          headline={report.data!.headline}
          tracked={report.data!.tracked}
          prior={report.data!.priorHeadline}
          params={params}
          emptyTitle="No measured outcome in this period"
          emptyDescription="Write what you did the way you would say it. Vantage pulls out the date, the quantity, the value, and the evaluation area."
          emptyAction={<Button onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Sparkles className="h-4 w-4" />Log an outcome</Button>}
        />
      )}
      {identity?.instance.aiEnabled && (
        <Panel className="mt-4" title="Where do I stand?" subtitle="Reads your own entries, goals and open tasks; nobody else’s"
          action={<AiAction workflow="personal_review" surface="dashboard" input={{ days: 90 }} label="Review my record" onResult={(output, meta) => setReview({ output, meta })} />}>
          {review ? <AiResult output={review.output} meta={review.meta} /> : <p className="flex items-center gap-2 text-sm text-ink-3"><CheckCircle2 className="h-4 w-4" />A read of the last 90 days. A draft, never a rating.</p>}
        </Panel>
      )}
    </section>
  );
}

