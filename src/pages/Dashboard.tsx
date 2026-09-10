import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, ArrowRight, AlertTriangle, CheckCircle2, TrendingUp, Sparkles, Users, CalendarClock } from 'lucide-react';
import { PageHeader, Panel, Button, EmptyState, Skeleton, Progress, Badge } from '@/components/ui/primitives';
import { AreaChart, BarList } from '@/components/charts';
import { AiAction, AiResult } from '@/components/AiPanel';
import { PeriodSelect, StatusBadge, DateText } from '@/components/common';
import { MetricTotalsGrid, formatMetric, metricUnitLabel } from '@/components/MetricTotals';
import { useGoals, useIdentity, usePrefs, useReadiness, useSavePrefs, useTasks, useTrack, useMetricsReport } from '@/lib/queries';
import { rangeForPeriod, dayKey, formatNumber } from '../../shared/metrics';
import { recordHealth, todayActions } from '../../shared/health';
import { cn } from '@/lib/utils';

/**
 * The dashboard answers three questions in order: what needs me, what did the work produce,
 * and what is moving. It deliberately reports no count of entries and no run of consecutive days:
 * how often someone opened a form is not a measure of their work.
 */
export default function Dashboard() {
  const navigate = useNavigate();
  const { data: identity } = useIdentity();
  const [review, setReview] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  const prefs = usePrefs();
  const savePrefs = useSavePrefs();
  const track = useTrack();
  const { data: tasks } = useTasks();
  const { data: goals } = useGoals();
  const { data: readiness } = useReadiness();

  const period = prefs.dashboardPeriod || 'fiscalYear';
  const range = useMemo(() => rangeForPeriod(period), [period]);
  const params = useMemo(() => ({ from: dayKey(range.start), to: dayKey(range.end), scope: 'me' }), [range]);
  const report = useMetricsReport(params);

  const mineTasks = useMemo(
    () => (tasks || []).filter((t: any) => (t.assignee_id || t.user_id) === identity?.user.id),
    [tasks, identity?.user.id],
  );
  const openTasks = mineTasks.filter((t: any) => t.status !== 'completed');
  const activeGoals = (goals || []).filter((g: any) => g.status === 'active');

  const attention = useMemo(
    () => todayActions({ tasks: mineTasks, goals: goals || [], activities: [], profile: readiness || null, track, fitrepPeriodEnd: readiness?.fitrep_period_end }),
    [mineTasks, goals, readiness, track],
  );
  const health = useMemo(
    () => recordHealth({ activities: [], goals: goals || [], profile: readiness || null, track }),
    [goals, readiness, track],
  );

  const first = identity?.user.first_name;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const nothingYet = !report.isPending && !report.data?.headline.length && !report.data?.tracked.length;

  if (report.isPending) {
    return (
      <div className="page space-y-4">
        <Skeleton className="h-10 w-72" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>
        <Skeleton className="h-72" />
      </div>
    );
  }

  const data = report.data!;
  const topSeries = data.monthly[0];

  return (
    <div className="page">
      <PageHeader
        eyebrow={range.label}
        title={`${greeting}, ${first}.`}
        lede={nothingYet
          ? 'Nothing is recorded for this period yet. Log one outcome and the picture starts forming.'
          : `${data.outcomesWithMeasures} ${data.outcomesWithMeasures === 1 ? 'outcome' : 'outcomes'} carried a measurable result this period.`}
      >
        <PeriodSelect value={period} onChange={(v) => savePrefs.mutate({ dashboardPeriod: v })} className="w-44" />
        <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Plus className="h-4 w-4" />Log activity</Button>
      </PageHeader>

      {/* Attention ---------------------------------------------------- */}
      <section aria-labelledby="attention-heading" className="mb-6">
        <h2 id="attention-heading" className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
          <AlertTriangle className={cn('h-4 w-4', attention.length ? 'text-warn' : 'text-ink-3')} />
          Needs your attention
        </h2>
        {attention.length === 0 && health.length === 0 ? (
          <div className="card"><p className="flex items-center gap-2 text-sm text-good"><CheckCircle2 className="h-4 w-4" />Nothing is overdue, closing, or incomplete. Log what you did today.</p></div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Panel title="Act on these now" subtitle="deadlines and gaps that move if you do not">
              {attention.length === 0 ? <p className="text-sm text-ink-3">Nothing time-sensitive right now.</p> : (
                <ul className="space-y-2">{attention.map((a) => (
                  <li key={a.key}>
                    <Link to={a.to} className="flex items-start gap-3 rounded-md border border-line px-3 py-2 transition-colors hover:border-line-strong hover:bg-surface-2">
                      <span className="fig mt-0.5 min-w-6 text-center text-sm font-semibold text-accent">{a.count ?? <CalendarClock className="h-4 w-4" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-ink">{a.label}</span>
                        <span className="block truncate text-xs text-ink-3">{a.detail}</span>
                      </span>
                      <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-ink-3" />
                    </Link>
                  </li>
                ))}</ul>
              )}
            </Panel>
            <Panel title="Fix before the package is due" subtitle="record gaps that weaken a claim" action={<Link to="/reports" className="text-xs text-accent hover:underline">Build report</Link>}>
              {health.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-good"><CheckCircle2 className="h-4 w-4" />Nothing to fix.</p>
              ) : (
                <ul className="space-y-1.5">{health.map((h) => (
                  <li key={h.key}>
                    <Link to={h.to} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-surface-2">
                      <span className="flex items-center gap-2"><Badge tone={h.key === 'duplicates' ? 'bad' : 'warn'}>{h.count}</Badge><span className="text-ink">{h.label}</span></span>
                      <ArrowRight className="h-3.5 w-3.5 text-ink-3" />
                    </Link>
                  </li>
                ))}</ul>
              )}
            </Panel>
          </div>
        )}
      </section>

      {/* Accomplished ------------------------------------------------- */}
      <section aria-labelledby="accomplished-heading" className="mb-6">
        <h2 id="accomplished-heading" className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
          <CheckCircle2 className="h-4 w-4 text-good" />
          Accomplished this period
          <span className="text-xs font-normal text-ink-3">every figure opens into the outcomes behind it</span>
        </h2>
        <MetricTotalsGrid
          headline={data.headline}
          tracked={data.tracked}
          prior={data.priorHeadline}
          params={params}
          emptyTitle="No measured outcome in this period"
          emptyDescription="Write what you did the way you would say it. Vantage pulls out the date, the quantity, the value, and the evaluation area."
          emptyAction={<><Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Sparkles className="h-4 w-4" />Log an outcome</Button><Button onClick={() => navigate('/records?import=1')}>Import a spreadsheet</Button></>}
        />
      </section>

      {/* Progressing -------------------------------------------------- */}
      <section aria-labelledby="progressing-heading">
        <h2 id="progressing-heading" className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink">
          <TrendingUp className="h-4 w-4 text-accent" />
          Progressing
        </h2>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <Panel
            title={topSeries ? metricUnitLabel({ kind: data.headline[0].kind, unit: topSeries.unit, metricLabel: topSeries.metricLabel }) : 'Over time'}
            subtitle="by month, on the same basis as the figure above"
            className="xl:col-span-2"
            padded={false}
            bodyClassName="p-3"
          >
            {topSeries && topSeries.points.length > 1 ? (
              <AreaChart
                data={topSeries.points.map((p) => ({ label: p.label, value: p.value }))}
                ariaLabel={`${topSeries.metricLabel} by month`}
                format={(v) => formatMetric({ kind: data.headline[0].kind, value: v, unit: topSeries.unit })}
              />
            ) : (
              <EmptyState title="Not enough history for a chart yet" description="A couple of months of outcomes will show the shape here." />
            )}
          </Panel>

          <Panel title="Goals in motion" action={<Link to="/goals" className="text-xs text-accent hover:underline">Goals</Link>}>
            {activeGoals.length === 0 ? (
              <p className="text-sm text-ink-3">No active goals. Set one so the year has a shape.</p>
            ) : (
              <ul className="space-y-2.5">{activeGoals.slice(0, 5).map((g: any) => {
                const pct = g.target_value ? Math.min(100, (Number(g.current_value) / Number(g.target_value)) * 100) : 0;
                return (
                  <li key={g.id}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <Link to="/goals" className="truncate text-ink hover:underline">{g.title}</Link>
                      <span className="fig shrink-0 text-xs text-ink-3">{formatNumber(Number(g.current_value))}{g.target_value ? ` / ${formatNumber(Number(g.target_value))}` : ''}{g.unit_label ? ` ${g.unit_label}` : ''}</span>
                    </div>
                    <Progress value={pct} className="mt-1" tone={pct >= 100 ? 'good' : 'accent'} />
                  </li>
                );
              })}</ul>
            )}
          </Panel>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Panel title="Where the work landed" subtitle="outcomes by category" className="lg:col-span-2">
            {data.byCategory.length === 0 ? (
              <p className="text-sm text-ink-3">Nothing categorised in this period.</p>
            ) : (
              <BarList
                items={data.byCategory
                  .map((b) => ({ label: b.value, value: b.totals.reduce((n, t) => n + t.outcomes, 0), hint: b.totals.filter((t) => t.headline).map((t) => formatMetric(t)).join(', ') || undefined }))
                  .sort((a, b) => b.value - a.value)
                  .slice(0, 8)}
                format={(v) => `${v} ${v === 1 ? 'outcome' : 'outcomes'}`}
              />
            )}
          </Panel>

          <div className="space-y-4">
            <Panel title="Open work" action={<Link to="/work" className="text-xs text-accent hover:underline">Work</Link>}>
              {openTasks.length === 0 ? <p className="text-sm text-ink-3">No open tasks.</p> : (
                <ul className="space-y-1.5">{openTasks.slice(0, 5).map((t: any) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate text-ink">{t.title}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {t.due_date && <span className={cn('fig text-xs', t.due_date < new Date().toISOString().slice(0, 10) ? 'text-bad' : 'text-ink-3')}><DateText value={t.due_date} /></span>}
                      <StatusBadge value={t.priority !== 'medium' ? t.priority : null} />
                    </span>
                  </li>
                ))}</ul>
              )}
            </Panel>
            {identity?.canLead ? (
              <Panel title="Leading" subtitle="units you can see">
                <ul className="space-y-1.5">{identity.memberships.filter((m) => identity.readableUnitIds.includes(m.unit_id)).map((m) => (
                  <li key={m.unit_id}>
                    <Link to={`/team?tab=dashboard&unit=${m.unit_id}`} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm hover:border-line-strong hover:bg-surface-2">
                      <span className="flex items-center gap-2 text-ink"><Users className="h-4 w-4 text-ink-3" />{m.unit_short || m.unit_name}</span>
                      <ArrowRight className="h-4 w-4 text-ink-3" />
                    </Link>
                  </li>
                ))}</ul>
              </Panel>
            ) : (
              <Panel title="Readiness" action={<Link to="/readiness" className="text-xs text-accent hover:underline">Update</Link>}>
                <dl className="grid grid-cols-2 gap-2 text-sm">{[['PFT', readiness?.pft_score], ['CFT', readiness?.cft_score], ['Rifle', readiness?.rifle_qual], ['MCMAP', readiness?.mcmap_belt]].map(([k, v]) => (
                  <div key={String(k)} className="rounded-md border border-line px-3 py-2">
                    <dt className="eyebrow">{k}</dt>
                    <dd className={cn('fig mt-0.5 font-semibold', v == null || v === '' ? 'text-ink-3' : 'text-ink')}>{v == null || v === '' ? 'Not entered' : String(v)}</dd>
                  </div>
                ))}</dl>
              </Panel>
            )}
          </div>
        </div>

        {identity?.instance.aiEnabled && (
          <Panel
            className="mt-4"
            title="Where do I stand?"
            subtitle="reads your own entries, goals and open tasks for this period; nobody else's"
            action={<AiAction workflow="personal_review" surface="dashboard" input={{ days: 90 }} label="Review my record" onResult={(output, meta) => setReview({ output, meta })} />}
          >
            {review
              ? <AiResult output={review.output} meta={review.meta} />
              : <p className="flex items-center gap-2 text-sm text-ink-3"><Sparkles className="h-4 w-4" />A read of the last 90 days against what you said you were going for. A draft, never a rating.</p>}
          </Panel>
        )}
      </section>
    </div>
  );
}
