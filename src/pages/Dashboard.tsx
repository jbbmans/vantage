import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, ArrowRight, Flame, CalendarClock, ClipboardCheck, Sparkles, Users } from 'lucide-react';
import { PageHeader, Stat, Panel, Button, EmptyState, Skeleton, Progress, Badge } from '@/components/ui/primitives';
import { AreaChart, Donut, Heatmap, BarList } from '@/components/charts';
import { PeriodSelect, StatusBadge, DateText, CategoryDot } from '@/components/common';
import { useActivities, useGoals, useIdentity, usePrefs, useReadiness, useSavePrefs, useTasks, useTrack, useMetrics } from '@/lib/queries';
import { aggregateMetrics, activitiesInRange, rangeForPeriod, dailyCounts, currentStreak, daysSinceLastActivity, formatDollars, formatNumber, previousRange, delta as pctDelta, fiscalYearProgress } from '../../shared/metrics';
import { recordHealth, todayActions } from '../../shared/health';
import { areaBalance } from '../../shared/narrative';
import { areasFor, trackMeta } from '../../shared/evaluation';
import { categoryColor } from '../../shared/constants';
import { format, eachWeekOfInterval, startOfWeek } from 'date-fns';
import { cn } from '@/lib/utils';

export default function Dashboard() {
  const cfg = useMetrics();
  const navigate = useNavigate();
  const { data: identity } = useIdentity();
  const prefs = usePrefs();
  const savePrefs = useSavePrefs();
  const track = useTrack();
  const { data: activities, isPending } = useActivities();
  const { data: tasks } = useTasks();
  const { data: goals } = useGoals();
  const { data: readiness } = useReadiness();
  const period = prefs.dashboardPeriod || 'fiscalYear';
  const range = useMemo(() => rangeForPeriod(period), [period]);
  const mine = useMemo(() => (activities || []).filter((a: any) => a.user_id === identity?.user.id), [activities, identity?.user.id]);
  const inRange = useMemo(() => activitiesInRange(mine, range), [mine, range]);
  const prior = useMemo(() => activitiesInRange(mine, previousRange(range)), [mine, range]);
  const metrics = useMemo(() => aggregateMetrics(inRange, cfg), [inRange, cfg]);
  const priorMetrics = useMemo(() => aggregateMetrics(prior, cfg), [prior, cfg]);
  const counts = useMemo(() => dailyCounts(mine), [mine]);
  const streak = useMemo(() => currentStreak(mine), [mine]);
  const since = useMemo(() => daysSinceLastActivity(mine), [mine]);
  const health = useMemo(() => recordHealth({ activities: mine, goals: goals || [], profile: readiness || null, track }), [mine, goals, readiness, track]);
  const actions = useMemo(() => todayActions({ tasks: (tasks || []).filter((t: any) => (t.assignee_id || t.user_id) === identity?.user.id), goals: goals || [], activities: mine, profile: readiness || null, track, fitrepPeriodEnd: readiness?.fitrep_period_end }), [tasks, goals, mine, readiness, track, identity?.user.id]);
  const balance = useMemo(() => areaBalance(inRange as never, areasFor(track)), [inRange, track]);
  const weekly = useMemo(() => {
    if (!inRange.length && range.end < range.start) return [];
    const weeks = eachWeekOfInterval({ start: range.start, end: range.end > new Date() ? new Date() : range.end });
    return weeks.map((w) => { const key = format(startOfWeek(w), 'yyyy-MM-dd'); const items = inRange.filter((a: any) => a.date && format(startOfWeek(new Date(`${a.date}T00:00:00`)), 'yyyy-MM-dd') === key); return { label: format(w, 'd MMM'), value: items.length, secondary: Math.round(aggregateMetrics(items, cfg).totalDollars) }; });
  }, [inRange, range, cfg]);
  const openTasks = (tasks || []).filter((t: any) => t.status !== 'completed' && (t.assignee_id || t.user_id) === identity?.user.id);
  const activeGoals = (goals || []).filter((g: any) => g.status === 'active');
  const fy = fiscalYearProgress();
  const dollarsDelta = pctDelta(metrics.totalDollars, priorMetrics.totalDollars);
  const countDelta = pctDelta(metrics.totalActivities, priorMetrics.totalActivities);
  const hint = (d: number | null) => (d == null ? 'no prior period' : `${d >= 0 ? '+' : ''}${Math.round(d)}% vs prior`);
  const first = identity?.user.first_name;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  if (isPending) return <div className="page space-y-4"><Skeleton className="h-10 w-72" /><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}</div><Skeleton className="h-72" /></div>;

  return (
    <div className="page">
      <PageHeader eyebrow={`${range.label} · FY ${Math.round(fy.fraction * 100)}% elapsed`} title={`${greeting}, ${first}.`} lede={mine.length ? `${formatNumber(metrics.totalActivities)} entries this period. ${since === 0 ? 'You logged something today.' : since == null ? 'Nothing logged yet.' : `Last entry ${since} day${since === 1 ? '' : 's'} ago.`}` : 'Log your first accomplishment and the picture starts forming.'}>
        <PeriodSelect value={period} onChange={(v) => savePrefs.mutate({ dashboardPeriod: v })} className="w-44" />
        <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Plus className="h-4 w-4" />Log activity</Button>
      </PageHeader>

      {mine.length === 0 ? (
        <div className="card mb-5"><EmptyState icon={Sparkles} title="Start with one sentence" description="Write what you did the way you'd say it. Vantage pulls out the date, quantity, dollars, and evaluation area. Press N anywhere to log." action={<><Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}>Log an activity</Button><Button onClick={() => navigate('/records?import=1')}>Import a spreadsheet</Button></>} /></div>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Entries" value={formatNumber(metrics.totalActivities)} hint={hint(countDelta)} to="/records" />
        <Stat label={`${cfg.currency_label} moved`} value={formatDollars(metrics.totalDollars)} hint={metrics.reviewedDollars ? `${formatDollars(metrics.reviewedDollars)} reviewed separately` : hint(dollarsDelta)} tone="accent" to="/reports" />
        <Stat label="With an outcome" value={`${metrics.totalActivities ? Math.round((metrics.withOutcome / metrics.totalActivities) * 100) : 0}%`} hint={`${metrics.totalActivities - metrics.withOutcome} entries need a result`} tone={metrics.totalActivities && metrics.withOutcome / metrics.totalActivities < 0.6 ? 'warn' : 'good'} to="/records?quality=needs-detail" />
        <Stat label="Streak" value={<span className="flex items-center gap-1.5">{streak}<Flame className={cn('h-5 w-5', streak > 0 ? 'text-warn' : 'text-ink-3')} /></span>} hint={streak ? 'consecutive days logged' : 'log today to start one'} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Panel title="Activity over time" subtitle="entries per week, dashed line is dollars" className="xl:col-span-2" padded={false} bodyClassName="p-3">
          {weekly.length > 1 ? <AreaChart data={weekly} ariaLabel="Entries per week" secondaryLabel="Dollars" format={(v) => String(Math.round(v))} /> : <EmptyState title="Not enough history for a chart yet" description="A few weeks of entries will show a trend here." />}
        </Panel>
        <Panel title="Today" subtitle="what deserves attention">
          {actions.length === 0 ? <p className="text-sm text-ink-3">Nothing overdue, nothing closing, nothing stale. Log what you did today.</p> : (
            <ul className="space-y-2">{actions.map((a) => (
              <li key={a.key}><Link to={a.to} className="flex items-start gap-3 rounded-md border border-line px-3 py-2 transition-colors hover:border-line-strong hover:bg-surface-2">
                <span className="fig mt-0.5 min-w-6 text-center text-sm font-semibold text-accent">{a.count ?? <CalendarClock className="h-4 w-4" />}</span>
                <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-ink">{a.label}</span><span className="block truncate text-xs text-ink-3">{a.detail}</span></span>
                <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-ink-3" /></Link></li>
            ))}</ul>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <Panel title={trackMeta(track).balanceLabel} subtitle="every area needs evidence">
          <BarList items={balance.map((b) => ({ label: b.area, value: b.count, hint: b.count === 0 ? 'nothing logged' : undefined }))} max={Math.max(1, ...balance.map((b) => b.count))} />
          {balance.some((b) => b.count === 0) && <p className="mt-3 text-xs text-ink-3">An empty area is marked from impression. Log something honest under it.</p>}
        </Panel>
        <Panel title="By category">
          {metrics.totalActivities ? <Donut size={128} segments={Object.entries(metrics.byCategory).sort((a, b) => b[1].count - a[1].count).slice(0, 6).map(([k, v]) => ({ label: k, value: v.count, color: categoryColor(k, cfg) }))} centerValue={String(metrics.totalActivities)} centerLabel="entries" /> : <p className="text-sm text-ink-3">No entries in this period.</p>}
        </Panel>
        <Panel title="Record health" subtitle="fix these before the package is due" action={<Link to="/reports" className="text-xs text-accent hover:underline">Build report</Link>}>
          {health.length === 0 ? <p className="flex items-center gap-2 text-sm text-good"><ClipboardCheck className="h-4 w-4" />Clean. Every entry has a date, an outcome, and an area.</p> : (
            <ul className="space-y-1.5">{health.map((h) => <li key={h.key}><Link to={h.to} className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-surface-2"><span className="flex items-center gap-2"><Badge tone={h.key === 'duplicates' ? 'bad' : 'warn'}>{h.count}</Badge><span className="text-ink">{h.label}</span></span><ArrowRight className="h-3.5 w-3.5 text-ink-3" /></Link></li>)}</ul>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Recent entries" action={<Link to="/records" className="text-xs text-accent hover:underline">All records</Link>} className="lg:col-span-2" padded={false}>
          {inRange.length === 0 ? <EmptyState title="No entries in this period" /> : (
            <ul>{[...inRange].sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))).slice(0, 8).map((a: any) => (
              <li key={a.id} className="row"><Link to={`/records/${a.id}`} className="flex items-center gap-3 px-4 py-2.5">
                <CategoryDot category={a.category} />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm text-ink">{a.title}</span><span className="block truncate text-xs text-ink-3">{[a.eval_area !== 'Unassigned' ? a.eval_area : null, a.quantity != null ? `${formatNumber(a.quantity)} ${a.unit_label || ''}`.trim() : null, a.dollar_amount != null ? formatDollars(a.dollar_amount) : null].filter(Boolean).join(' · ') || 'add a quantity or value'}</span></span>
                <span className="text-xs text-ink-3"><DateText value={a.date} /></span>
              </Link></li>
            ))}</ul>
          )}
        </Panel>
        <div className="space-y-4">
          <Panel title="Open work" action={<Link to="/work" className="text-xs text-accent hover:underline">Work</Link>}>
            {openTasks.length === 0 ? <p className="text-sm text-ink-3">No open tasks.</p> : <ul className="space-y-1.5">{openTasks.slice(0, 5).map((t: any) => <li key={t.id} className="flex items-center justify-between gap-2 text-sm"><span className="truncate text-ink">{t.title}</span><span className="flex shrink-0 items-center gap-1.5">{t.due_date && <span className={cn('fig text-xs', t.due_date < new Date().toISOString().slice(0, 10) ? 'text-bad' : 'text-ink-3')}><DateText value={t.due_date} /></span>}<StatusBadge value={t.priority !== 'medium' ? t.priority : null} /></span></li>)}</ul>}
          </Panel>
          <Panel title="Goals" action={<Link to="/goals" className="text-xs text-accent hover:underline">Goals</Link>}>
            {activeGoals.length === 0 ? <p className="text-sm text-ink-3">No active goals. Set one so the year has a shape.</p> : <ul className="space-y-2.5">{activeGoals.slice(0, 4).map((g: any) => { const pct = g.target_value ? Math.min(100, (Number(g.current_value) / Number(g.target_value)) * 100) : 0; return <li key={g.id}><div className="flex items-baseline justify-between gap-2 text-sm"><span className="truncate text-ink">{g.title}</span><span className="fig shrink-0 text-xs text-ink-3">{Math.round(pct)}%</span></div><Progress value={pct} className="mt-1" tone={pct >= 100 ? 'good' : 'accent'} /></li>; })}</ul>}
          </Panel>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Consistency" subtitle="last 18 weeks" className="lg:col-span-2" bodyClassName="p-4 overflow-x-auto"><Heatmap counts={counts} onSelect={(day) => navigate(`/records?from=${day}&to=${day}`)} /></Panel>
        {identity?.canLead ? (
          <Panel title="Leading" subtitle="units you can see">
            <ul className="space-y-1.5">{identity.memberships.filter((m) => identity.readableUnitIds.includes(m.unit_id)).map((m) => <li key={m.unit_id}><Link to={`/team?tab=dashboard&unit=${m.unit_id}`} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm hover:border-line-strong hover:bg-surface-2"><span className="flex items-center gap-2 text-ink"><Users className="h-4 w-4 text-ink-3" />{m.unit_short || m.unit_name}</span><ArrowRight className="h-4 w-4 text-ink-3" /></Link></li>)}</ul>
          </Panel>
        ) : (
          <Panel title="Readiness" action={<Link to="/readiness" className="text-xs text-accent hover:underline">Update</Link>}>
            <dl className="grid grid-cols-2 gap-2 text-sm">{[['PFT', readiness?.pft_score], ['CFT', readiness?.cft_score], ['Rifle', readiness?.rifle_qual], ['MCMAP', readiness?.mcmap_belt]].map(([k, v]) => <div key={String(k)} className="rounded-md border border-line px-3 py-2"><dt className="eyebrow">{k}</dt><dd className={cn('fig mt-0.5 font-semibold', v == null || v === '' ? 'text-ink-3' : 'text-ink')}>{v == null || v === '' ? 'Not entered' : String(v)}</dd></div>)}</dl>
          </Panel>
        )}
      </div>
    </div>
  );
}
