import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  addWeeks,
  endOfWeek,
  format,
  isBefore,
  isValid,
  parseISO,
  startOfDay,
  startOfWeek,
  subWeeks,
} from 'date-fns';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Filter,
  Inbox,
  ListChecks,
  Target,
} from 'lucide-react';
import {
  useActivities,
  useEvalTrack,
  useGoals,
  usePrefs,
  useRecognitions,
  useTasks,
  useTrainings,
} from '@/store/useStore';
import {
  activitiesInRange,
  aggregateMetrics,
  fiscalQuarterRange,
  fiscalYearRange,
  formatDollars,
  formatDollarsExact,
  formatDTG,
  formatNumber,
  rangeForPeriod,
} from '@/lib/metrics';
import { DOLLAR_TYPES } from '@/lib/constants';
import { strength, unitFor } from '@/lib/bullets';
import FiscalTape from '@/components/FiscalTape';
import { DashboardSection, DisplayMenu, useDashboardLayout } from '@/components/DashboardSection';
import { Badge, Button, EmptyState, Select } from '@/components/ui/primitives';
import * as apiClient from '@/lib/api';
import { recordHealth, todayActions } from '@/lib/health';

const PERIOD_OPTIONS = [
  { value: 'week', label: 'This week' },
  { value: 'fiscalQuarter', label: 'Last 12 weeks' },
  { value: 'fiscalYear', label: 'Fiscal year' },
  { value: 'all', label: 'All time' },
];

const CHART_MODES = [
  { key: 'impact', label: 'Impact' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'hours', label: 'Hours' },
  { key: 'records', label: 'Records' },
];

const SUPPORT_SECTIONS = [
  { id: 'today', title: 'Today' },
  { id: 'tape', title: 'Fiscal tape' },
  { id: 'health', title: 'Record quality' },
  { id: 'goals', title: 'Goals' },
];

const SUMMABLE_DOLLAR_TYPES = new Set(DOLLAR_TYPES.filter((type) => type.summable).map((type) => type.key));

function activityHours(activity) {
  const unit = String(activity.unit || '').toLowerCase();
  return /(^|\s)(h|hr|hrs|hour|hours)(\s|$)/.test(unit) ? Number(activity.quantity) || 0 : 0;
}

function buildWeeklySeries(activities) {
  const currentWeek = startOfWeek(new Date(), { weekStartsOn: 1 });
  const firstWeek = subWeeks(currentWeek, 11);

  return Array.from({ length: 12 }, (_, index) => {
    const start = addWeeks(firstWeek, index);
    const end = endOfWeek(start, { weekStartsOn: 1 });
    const rows = activities.filter((activity) => {
      const date = parseISO(String(activity.date || ''));
      return isValid(date) && date >= start && date <= end;
    });
    const impact = rows.reduce((sum, activity) => {
      if (!SUMMABLE_DOLLAR_TYPES.has(activity.dollar_type || 'savings')) return sum;
      return sum + (Number(activity.dollar_amount) || 0);
    }, 0);

    return {
      label: format(start, 'MMM dd'),
      impact,
      transactions: rows.length,
      records: rows.filter((activity) => strength(activity) >= 2).length,
      hours: rows.reduce((sum, activity) => sum + activityHours(activity), 0),
    };
  });
}

function Metric({ value, label, primary = false, accent = false, to }) {
  const content = (
    <div className="min-w-0 py-4 sm:py-5">
      <p className={primary ? 'fig text-3xl font-medium text-signal sm:text-4xl' : `fig text-2xl font-medium ${accent ? 'text-signal' : 'text-text'}`}>
        {value}
      </p>
      <p className="mt-1 text-sm text-text-3">{label}</p>
    </div>
  );

  return to ? <Link to={to} className="group block hover:text-signal">{content}</Link> : content;
}

function ImpactTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const values = Object.fromEntries(payload.map((entry) => [entry.dataKey, entry.value]));
  return (
    <div className="rounded-md border border-rule bg-panel px-3 py-2 shadow-[var(--shadow)]">
      <p className="text-xs font-semibold text-text">Week of {label}</p>
      {values.impact != null && <p className="mt-1 text-xs text-text-2">Impact <span className="fig ml-2 text-signal">{formatDollarsExact(values.impact)}</span></p>}
      {values.transactions != null && <p className="text-xs text-text-2">Transactions <span className="fig ml-2 text-text">{values.transactions}</span></p>}
      {values.hours != null && <p className="text-xs text-text-2">Hours <span className="fig ml-2 text-text">{values.hours.toFixed(1)}</span></p>}
      {values.records != null && <p className="text-xs text-text-2">Complete records <span className="fig ml-2 text-text">{values.records}</span></p>}
    </div>
  );
}

export default function CommandCenter() {
  const activities = useActivities();
  const tasks = useTasks();
  const goals = useGoals();
  const recognitions = useRecognitions();
  const trainings = useTrainings();
  const prefs = usePrefs();
  const track = useEvalTrack();
  const navigate = useNavigate();
  const layout = useDashboardLayout(SUPPORT_SECTIONS.map((section) => section.id));
  const [period, setPeriod] = useState(() => prefs.interface?.dashboardPeriod || 'fiscalQuarter');
  const [chartMode, setChartMode] = useState('impact');
  const [profile, setProfile] = useState(null);

  useEffect(() => {
    apiClient.readiness().then(setProfile).catch(() => setProfile(null));
  }, []);

  const range = useMemo(() => rangeForPeriod(period), [period]);
  const scoped = useMemo(() => activitiesInRange(activities, range), [activities, range]);
  const metrics = useMemo(() => aggregateMetrics(scoped), [scoped]);
  const series = useMemo(() => buildWeeklySeries(activities), [activities]);
  const openTasks = useMemo(() => tasks.filter((task) => task.status !== 'completed'), [tasks]);
  const today = startOfDay(new Date());
  const overdue = useMemo(
    () => openTasks.filter((task) => task.due_date && isBefore(parseISO(task.due_date), today)),
    [openTasks, today]
  );
  const completeRecords = scoped.filter((activity) => strength(activity) >= 2).length;
  const completenessRate = scoped.length ? Math.round((completeRecords / scoped.length) * 100) : 0;
  const workHours = scoped.reduce((sum, activity) => sum + activityHours(activity), 0);
  const needsDetail = activities.filter((activity) => strength(activity) < 2);
  const recent = useMemo(
    () => [...activities].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 4),
    [activities]
  );

  const actionsToday = useMemo(
    () => todayActions({
      tasks,
      goals,
      activities,
      profile,
      track,
      fitrepPeriodEnd: prefs.fitrep?.periodEnd || null,
    }),
    [tasks, goals, activities, profile, track, prefs]
  );
  const health = useMemo(() => recordHealth({ activities, goals, profile, track }), [activities, goals, profile, track]);
  const activeGoals = goals.filter((goal) => goal.status === 'active');
  const openActionCount = actionsToday.reduce((sum, action) => sum + (Number(action.count) || 1), 0);
  const rangeLabel = period === 'all'
    ? 'All records'
    : `${formatDTG(range.start)} — ${formatDTG(range.end)}`;

  const chartKey = chartMode === 'impact' ? 'impact' : chartMode;
  const chartLabel = CHART_MODES.find((mode) => mode.key === chartMode)?.label || 'Impact';

  return (
    <div className="page-canvas">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-3xl font-medium tracking-tight text-text sm:text-4xl">Operational picture</h2>
          <p className="mt-1.5 text-base text-text-3">What changed, what needs attention, and what comes next.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={period} onValueChange={setPeriod} options={PERIOD_OPTIONS} className="w-40" aria-label="Dashboard period" />
          <Button variant="default" size="md" onClick={() => navigate('/activities')}>
            <Filter className="h-4 w-4" /> Filters
          </Button>
          <DisplayMenu sections={SUPPORT_SECTIONS} layout={layout} />
        </div>
      </div>

      <p className="mt-2 text-xs text-text-3">{rangeLabel}</p>

      <section className="mt-4 grid grid-cols-2 divide-x divide-rule border-y border-rule sm:grid-cols-5" aria-label="Headline metrics">
        <div className="col-span-2 sm:col-span-1"><Metric primary value={formatDollars(metrics.totalDollars)} label="recorded impact" to="/reports" /></div>
        <div className="pl-4 sm:pl-7"><Metric value={formatNumber(scoped.length)} label="transactions" to="/activities" /></div>
        <div className="pl-4 sm:pl-7"><Metric accent value={`${completenessRate}%`} label="records complete" to="/activities?quality=complete" /></div>
        <div className="pl-4 sm:pl-7"><Metric value={`${workHours.toFixed(1)}h`} label="work logged" to="/work" /></div>
        <div className="pl-4 sm:pl-7"><Metric value={formatNumber(openActionCount)} label="next actions" to={actionsToday[0]?.to || '/readiness'} /></div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_245px]">
        <section className="min-w-0 border-b border-rule py-6 xl:border-r xl:pr-8" aria-labelledby="impact-heading">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 id="impact-heading" className="text-lg font-semibold text-text">Impact &amp; throughput</h3>
              <div className="mt-3 flex flex-wrap gap-1">
                {CHART_MODES.map((mode) => (
                  <button
                    key={mode.key}
                    type="button"
                    onClick={() => setChartMode(mode.key)}
                    className={`rounded-sm px-2.5 py-1 text-xs transition-colors ${chartMode === mode.key ? 'bg-signal/10 font-semibold text-signal' : 'text-text-3 hover:bg-panel-2 hover:text-text'}`}
                  >
                    {mode.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-5 text-xs text-text-3">
              <span className="flex items-center gap-2"><span className="h-0.5 w-5 bg-signal" />{chartLabel}</span>
              {chartMode === 'impact' && <span className="flex items-center gap-2"><span className="h-0.5 w-5 bg-text" />Transactions</span>}
            </div>
          </div>

          {activities.length === 0 ? (
            <EmptyState
              icon={Inbox}
              className="mt-5 min-h-[310px]"
              title="Your operational picture starts with one record"
              description="Log a completed action and Vantage will build the trend, quality, and impact views from the source data."
              action={<Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log'))}>Log first activity</Button>}
            />
          ) : (
          <div className="mt-5 h-[310px] w-full" aria-label={`${chartLabel} over the last twelve weeks`}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series} margin={{ top: 16, right: 8, left: 4, bottom: 0 }}>
                <CartesianGrid stroke="rgb(var(--rule))" strokeDasharray="2 3" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: 'rgb(var(--text-3))', fontSize: 11 }} axisLine={{ stroke: 'rgb(var(--rule))' }} tickLine={false} minTickGap={22} />
                <YAxis
                  yAxisId="left"
                  tick={{ fill: 'rgb(var(--text-3))', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                  tickFormatter={(value) => chartMode === 'impact' ? formatDollars(value) : formatNumber(value)}
                />
                {chartMode === 'impact' && (
                  <YAxis yAxisId="right" orientation="right" tick={{ fill: 'rgb(var(--text-3))', fontSize: 11 }} axisLine={false} tickLine={false} width={32} allowDecimals={false} />
                )}
                <ChartTooltip content={<ImpactTooltip />} cursor={{ stroke: 'rgb(var(--rule-strong))', strokeDasharray: '3 3' }} />
                <Area yAxisId="left" type="linear" dataKey={chartKey} stroke="rgb(var(--signal))" strokeWidth={2} fill="rgb(var(--signal))" fillOpacity={0.1} dot={false} activeDot={{ r: 5, fill: 'rgb(var(--signal))', stroke: 'rgb(var(--panel))', strokeWidth: 2 }} />
                {chartMode === 'impact' && <Line yAxisId="right" type="linear" dataKey="transactions" stroke="rgb(var(--text))" strokeWidth={1.5} dot={false} activeDot={{ r: 4 }} />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          )}
        </section>

        <aside className="border-b border-rule py-6 xl:pl-8" aria-labelledby="attention-heading">
          <h3 id="attention-heading" className="text-lg font-semibold text-text">Attention</h3>
          <div className="mt-5 divide-y divide-rule">
            <Link to="/activities?quality=needs-detail" className="flex gap-3 py-5 first:pt-0">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-attention" />
              <span><strong className="fig block text-2xl font-medium text-attention">{needsDetail.length}</strong><span className="mt-1 block text-sm leading-snug text-text-3">records need more detail</span></span>
            </Link>
            <Link to="/work" className="flex gap-3 py-5">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-attention" />
              <span><strong className="fig block text-2xl font-medium text-attention">{overdue.length}</strong><span className="mt-1 block text-sm leading-snug text-text-3">tasks overdue</span></span>
            </Link>
            <Link to="/reports" className="flex gap-3 py-5">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-attention" />
              <span><strong className="fig block text-2xl font-medium text-attention">{formatDollars(metrics.reviewedDollars)}</strong><span className="mt-1 block text-sm leading-snug text-text-3">reviewed value excluded</span></span>
            </Link>
          </div>
        </aside>
      </div>

      <section className="py-5" aria-labelledby="latest-heading">
        <div className="mb-3 flex items-center justify-between">
          <h3 id="latest-heading" className="text-lg font-semibold text-text">Latest activity</h3>
          <Link to="/activities" className="flex items-center gap-1 text-sm text-text-3 hover:text-signal">All records <ArrowRight className="h-4 w-4" /></Link>
        </div>
        {recent.length === 0 ? (
          <EmptyState icon={Inbox} title="No activity yet" description="Use Log activity to create the first record." />
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div className="grid grid-cols-[minmax(260px,1.8fr)_1fr_0.65fr_0.8fr_0.8fr] gap-4 border-b border-rule px-2 pb-2 text-xs font-semibold text-text-3">
                <span>Activity</span><span>Type</span><span>Quantity</span><span>Impact</span><span>Status</span>
              </div>
              {recent.map((activity) => {
                const complete = strength(activity) >= 2;
                return (
                  <Link key={activity.id} to={`/activities/${activity.id}`} className="grid grid-cols-[minmax(260px,1.8fr)_1fr_0.65fr_0.8fr_0.8fr] items-center gap-4 border-b border-rule px-2 py-3 text-sm transition-colors hover:bg-panel-2/60">
                    <span className="min-w-0"><strong className="block truncate font-medium text-text">{activity.title}</strong><span className="mt-0.5 block text-xs text-text-3">{formatDTG(activity.date)}</span></span>
                    <span className="truncate text-text-2">{activity.category || 'Activity'}</span>
                    <span className="fig text-text-2">{activity.quantity ? `${formatNumber(activity.quantity)} ${unitFor(activity.unit || 'items', activity.quantity)}` : '—'}</span>
                    <span className="fig text-text-2">{activity.dollar_amount ? formatDollars(activity.dollar_amount) : '—'}</span>
                    <span className={`inline-flex items-center gap-1.5 ${complete ? 'text-ledger' : 'text-attention'}`}>
                      {complete ? <CheckCircle2 className="h-4 w-4" /> : <CircleAlert className="h-4 w-4" />}
                      {complete ? 'Complete' : 'Needs detail'}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section className="mt-6 border-t border-rule pt-6" aria-labelledby="support-heading">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 id="support-heading" className="text-lg font-semibold text-text">Supporting views</h3>
            <p className="mt-1 text-sm text-text-3">Secondary detail stays below the operational picture. Drag any section handle to reorder it.</p>
          </div>
          <Badge tone="neutral">customizable</Badge>
        </div>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <DashboardSection id="today" title="Today" subtitle="Actions that need a response" layout={layout}>
            {actionsToday.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-text-2"><ListChecks className="h-4 w-4 text-ledger" />Nothing overdue, stale, or incomplete.</p>
            ) : (
              <div className="space-y-1">
                {actionsToday.slice(0, 5).map((action) => (
                  <button key={action.key} type="button" onClick={() => navigate(action.to)} className="row flex w-full items-center gap-2 px-2 py-2 text-left">
                    <span className="fig w-8 shrink-0 text-signal">{action.count ?? '•'}</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-text">{action.label}</span>
                  </button>
                ))}
              </div>
            )}
          </DashboardSection>

          <DashboardSection id="tape" title="Fiscal tape" subtitle={`${fiscalQuarterRange().label} · ${fiscalYearRange().label}`} layout={layout}>
            <FiscalTape activities={activities} onSelectDay={(date) => navigate(`/activities?date=${format(date, 'yyyy-MM-dd')}`)} />
          </DashboardSection>

          <DashboardSection id="health" title="Record quality" subtitle="Missing context and duplicate candidates" layout={layout}>
            {health.length === 0 ? (
              <p className="flex items-center gap-2 text-sm text-text-2"><CheckCircle2 className="h-4 w-4 text-ledger" />Your records have the context needed for follow-up.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {health.slice(0, 6).map((item) => (
                  <button key={item.key} type="button" onClick={() => navigate(item.to)} className="rounded-sm border border-rule px-3 py-2 text-left hover:bg-panel-2">
                    <span className="fig text-lg text-attention">{item.count}</span>
                    <span className="ml-2 text-sm text-text-2">{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </DashboardSection>

          <DashboardSection id="goals" title="Goals" subtitle={`${activeGoals.length} active · ${recognitions.length} recognitions · ${trainings.length} training records`} layout={layout}>
            {activeGoals.length === 0 ? (
              <EmptyState icon={Target} title="No active goals" description="Set a target in Work to make progress visible here." />
            ) : (
              <div className="space-y-3">
                {activeGoals.slice(0, 4).map((goal) => {
                  const percentage = goal.target_value ? Math.min(100, Math.round(((goal.current_value || 0) / goal.target_value) * 100)) : 0;
                  return (
                    <Link key={goal.id} to="/goals" className="block">
                      <div className="flex items-center justify-between gap-3 text-sm"><span className="truncate text-text">{goal.title}</span><span className="fig text-text-3">{percentage}%</span></div>
                      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-panel-2"><div className="h-full rounded-full bg-signal" style={{ width: `${percentage}%` }} /></div>
                    </Link>
                  );
                })}
              </div>
            )}
          </DashboardSection>
        </div>
      </section>
    </div>
  );
}
