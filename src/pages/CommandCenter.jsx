import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { format, parseISO, isBefore, startOfDay } from 'date-fns';
import { ArrowRight, CircleAlert, CheckCheck, Clock3, Inbox, Target, FileWarning, ListChecks, Stethoscope } from 'lucide-react';
import {
  useActivities, useTasks, useGoals, useRecognitions, useTrainings, usePrefs, useEvalTrack,
} from '@/store/useStore';
import {
  aggregateMetrics, activitiesInRange, rangeForPeriod, fiscalYearRange, fiscalQuarterRange,
  previousRange, delta, trendSeries, formatDollars, formatDollarsExact,
  formatNumber, formatDTG, currentStreak, daysSinceLastActivity,
} from '@/lib/metrics';
import { CATEGORY_COLORS, DOLLAR_TYPES, DOLLAR_SUM_RULE } from '@/lib/constants';
import { strength, weaknesses, byWeakestFirst } from '@/lib/bullets';
import FiscalTape from '@/components/FiscalTape';
import { DashboardSection, DisplayMenu, useDashboardLayout } from '@/components/DashboardSection';
import { Figure, FigureRow, Sparkline, Bar } from '@/components/Figure';
import { Panel, EmptyState, Segmented, Badge, Dot, Button, Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import * as apiClient from '@/lib/api';
import { recordHealth, todayActions } from '@/lib/health';
import { unitFor } from '@/lib/bullets';

const PERIOD_OPTIONS = [
  { value: 'week', label: 'WK' },
  { value: 'fiscalQuarter', label: 'FQ' },
  { value: 'fiscalYear', label: 'FY' },
  { value: 'all', label: 'ALL' },
];

export default function CommandCenter() {
  const activities = useActivities();
  const tasks = useTasks();
  const goals = useGoals();
  const recognitions = useRecognitions();
  const trainings = useTrainings();
  const navigate = useNavigate();
  const [period, setPeriod] = useState('fiscalYear');
  const layout = useDashboardLayout();
  const prefs = usePrefs();
  const track = useEvalTrack();
  const [profile, setProfile] = useState(null);
  useEffect(() => {
    apiClient.readiness().then(setProfile).catch(() => setProfile(null));
  }, []);

  const actionsToday = useMemo(
    () => todayActions({
      tasks, goals, activities, profile, track,
      fitrepPeriodEnd: prefs.fitrep?.periodEnd || null,
    }),
    [tasks, goals, activities, profile, track, prefs]
  );
  const health = useMemo(
    () => recordHealth({ activities, goals, profile, track }),
    [activities, goals, profile, track]
  );

  /**
   * Every section the dashboard can show. The Display menu is generated from
   * this list, so adding a section here is the whole job of adding a section.
   */
  const SECTIONS = [
    { id: 'today', title: 'Today' },
    { id: 'tape', title: 'Fiscal tape' },
    { id: 'headline', title: 'Headline figures' },
    { id: 'cadence', title: 'Cadence' },
    { id: 'categories', title: 'Category mix' },
    { id: 'recent', title: 'Recent entries' },
    { id: 'dollars', title: 'Dollars by type' },
    { id: 'queue', title: 'Queue' },
    { id: 'strengthen', title: 'Needs strengthening' },
    { id: 'health', title: 'Record health' },
    { id: 'goals', title: 'Goals' },
    { id: 'career', title: 'Career totals' },
  ];

  const range = useMemo(() => rangeForPeriod(period), [period]);
  const scoped = useMemo(() => activitiesInRange(activities, range), [activities, range]);
  const metrics = useMemo(() => aggregateMetrics(scoped), [scoped]);

  const prior = useMemo(() => previousRange(range), [range]);
  const priorMetrics = useMemo(
    () => aggregateMetrics(activitiesInRange(activities, prior)),
    [activities, prior]
  );

  const trend = useMemo(() => trendSeries(activities, 30), [activities]);
  const fq = fiscalQuarterRange();
  const fy = fiscalYearRange();

  const openTasks = tasks.filter((t) => t.status !== 'completed');
  const today = startOfDay(new Date());
  const overdue = openTasks.filter((t) => t.due_date && isBefore(parseISO(t.due_date), today));
  const activeGoals = goals.filter((g) => g.status === 'active');
  const goalPct = (g) => (g.target_value ? Math.min(100, Math.round(((g.current_value || 0) / g.target_value) * 100)) : 0);
  const avgGoal = activeGoals.length
    ? Math.round(activeGoals.reduce((s, g) => s + goalPct(g), 0) / activeGoals.length)
    : 0;

  const lifetime = useMemo(() => aggregateMetrics(activities), [activities]);
  const streak = currentStreak(activities);
  const idle = daysSinceLastActivity(activities);

  const topCategories = Object.entries(metrics.byCategory)
    .map(([cat, v]) => ({ cat, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const recent = useMemo(
    () => [...activities].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 7),
    [activities]
  );

  // Records that won't survive a follow-up question yet.
  const needsWork = useMemo(
    () => activities.filter((a) => strength(a) <= 1).sort(byWeakestFirst).slice(0, 5),
    [activities]
  );

  const periodLabel = { week: 'this week', fiscalQuarter: fq.label, fiscalYear: fy.label, all: 'all time' }[period];
  const empty = activities.length === 0;

  if (empty) {
    return (
      <div className="mx-auto max-w-3xl">
        <Panel title="Command Center">
          <EmptyState
            icon={Inbox}
            title="Nothing logged yet"
            description="Press N, or use the Log activity button. Write it in plain language — Vantage pulls the numbers out and shows you the bullet it produces."
            action={
              <Button variant="primary" size="sm" onClick={() => navigate('/settings#data')}>
                Import an existing tracker
              </Button>
            }
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-3">
      {/* period switch + display control — always visible, never hideable */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="eyebrow">Window</span>
          <Segmented value={period} onChange={setPeriod} options={PERIOD_OPTIONS} />
          <span className="fig hidden text-2xs text-text-3 sm:inline">
            {period === 'all'
              ? 'all records'
              : `${formatDTG(range.start)} — ${formatDTG(range.end)}`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="fig flex items-center gap-3 text-2xs text-text-3">
            <span>
              streak <span className="text-text">{streak}d</span>
            </span>
            {idle !== null && idle >= 3 && (
              <span className="flex items-center gap-1 text-signal">
                <CircleAlert className="h-3 w-3" />
                {idle} days since last entry
              </span>
            )}
          </div>
          <DisplayMenu sections={SECTIONS} layout={layout} />
        </div>
      </div>

      {/* Finding 45: the page answers "what should I do today?" before it
          shows a single chart. Empty means empty — nothing needs you. */}
      <DashboardSection id="today" title="Today" subtitle="What actually needs your attention" layout={layout}>
        {actionsToday.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-text-2">
            <ListChecks className="h-3.5 w-3.5 text-ledger" />
            Nothing overdue, nothing stale, nothing incomplete. Log the day's work and carry on.
          </p>
        ) : (
          <div className="space-y-1">
            {actionsToday.map((a) => (
              <button
                key={a.key}
                type="button"
                onClick={() => navigate(a.to)}
                className="row flex w-full items-baseline gap-2.5 rounded px-2 py-1.5 text-left hover:bg-panel-2/60"
              >
                {a.count !== null && <span className="fig shrink-0 text-md text-signal">{a.count}</span>}
                <span className="min-w-0 text-sm text-text">{a.label}</span>
                {a.detail && <span className="hidden min-w-0 flex-1 truncate text-2xs text-text-3 sm:inline">{a.detail}</span>}
              </button>
            ))}
          </div>
        )}
      </DashboardSection>

      {/* The tape leads. It is the thesis of the page. */}
      <DashboardSection id="tape" title="Fiscal tape" layout={layout}>
        <FiscalTape
          activities={activities}
          onSelectDay={(d) => navigate(`/activities?date=${format(d, 'yyyy-MM-dd')}`)}
        />
      </DashboardSection>

      {/* headline figures */}
      <DashboardSection id="headline" title="Headline figures" subtitle={periodLabel} layout={layout}>
      <FigureRow>
        <Figure
          label="Activities"
          raw={metrics.totalActivities}
          formatFn={(n) => formatNumber(Math.round(n))}
          delta={delta(metrics.totalActivities, priorMetrics.totalActivities)}
          sub={`${formatNumber(metrics.totalQuantity)} units`}
          to="/activities"
        />
        <Figure
          label="Dollar impact"
          raw={metrics.totalDollars}
          formatFn={formatDollars}
          tone="ledger"
          delta={delta(metrics.totalDollars, priorMetrics.totalDollars)}
          sub={metrics.reviewedDollars ? `+${formatDollars(metrics.reviewedDollars)} reviewed` : 'excludes reviewed'}
          to="/reports"
        />
        <Figure
          label="Open work"
          raw={openTasks.length}
          formatFn={(n) => formatNumber(Math.round(n))}
          tone={overdue.length ? 'redline' : 'default'}
          sub={overdue.length ? `${overdue.length} overdue` : 'nothing overdue'}
          to="/work"
        />
        <Figure
          label="Goal progress"
          value={`${avgGoal}%`}
          sub={`${activeGoals.length} active · ${goals.filter((g) => g.status === 'achieved').length} achieved`}
          to="/goals"
        />
      </FigureRow>
      </DashboardSection>

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-3">
        {/* trend */}
        <DashboardSection
          id="cadence"
          className="xl:col-span-2"
          title="Cadence"
          subtitle="last 30 days"
          layout={layout}
          action={
            <Link to="/reports" className="flex items-center gap-1 text-xs text-text-3 hover:text-signal">
              Reports <ArrowRight className="h-3 w-3" />
            </Link>
          }
        >
          <div className="flex items-end gap-0.5" style={{ height: 108 }}>
            {trend.map((d) => {
              const max = Math.max(1, ...trend.map((x) => x.count));
              const h = d.count ? Math.max(3, (d.count / max) * 100) : 2;
              return (
                <Tooltip key={d.key} content={`${d.date} · ${d.count} logged`}>
                  <div className="group flex h-full flex-1 cursor-default items-end">
                    <div
                      className={cn(
                        'w-full rounded-t-[1px] transition-colors',
                        d.count ? 'bg-signal/60 group-hover:bg-signal' : 'bg-rule'
                      )}
                      style={{ height: `${h}%` }}
                    />
                  </div>
                </Tooltip>
              );
            })}
          </div>
          <div className="fig mt-2 flex justify-between border-t border-rule pt-1.5 text-2xs text-text-3">
            <span>{trend[0]?.date}</span>
            <span>
              {trend.reduce((s, d) => s + d.count, 0)} in 30d · {trend.filter((d) => d.count).length} active days
            </span>
            <span>{trend.at(-1)?.date}</span>
          </div>
        </DashboardSection>

        {/* category mix */}
        <DashboardSection id="categories" title="Category mix" subtitle={periodLabel} layout={layout}>
          {topCategories.length === 0 ? (
            <EmptyState icon={Inbox} title="Nothing in this window" description="Widen the window or log something new." />
          ) : (
            <div className="space-y-2.5">
              {topCategories.map((c) => (
                <Bar
                  key={c.cat}
                  label={
                    <span className="flex items-center gap-1.5">
                      <Dot color={CATEGORY_COLORS[c.cat]} />
                      {c.cat}
                    </span>
                  }
                  value={c.count}
                  max={topCategories[0].count}
                  color={CATEGORY_COLORS[c.cat]}
                  figure={`${c.count}${c.dollars ? ` · ${formatDollars(c.dollars)}` : ''}`}
                />
              ))}
            </div>
          )}
        </DashboardSection>
      </div>

      <div className="grid grid-cols-1 items-start gap-3 xl:grid-cols-3">
        {/* recent log */}
        <DashboardSection
          id="recent"
          className="xl:col-span-2"
          title="Recent entries"
          layout={layout}
          action={
            <Link to="/activities" className="flex items-center gap-1 text-xs text-text-3 hover:text-signal">
              All <ArrowRight className="h-3 w-3" />
            </Link>
          }
        >
          <div className="-m-3">
            {recent.map((a) => (
              <Link key={a.id} to={`/activities/${a.id}`} className="row flex items-center gap-2.5 px-3 py-2">
                <Dot color={CATEGORY_COLORS[a.category]} />
                <span className="fig w-16 shrink-0 text-2xs text-text-3">{formatDTG(a.date)}</span>
                <span className="min-w-0 flex-1 truncate text-base text-text">{a.title}</span>
                {a.quantity ? (
                  <span className="fig hidden shrink-0 text-xs text-text-2 sm:block">
                    {formatNumber(a.quantity)} {unitFor(a.unit, a.quantity)}
                  </span>
                ) : null}
                {a.dollar_amount ? (
                  <span className="fig shrink-0 text-xs text-ledger">{formatDollarsExact(a.dollar_amount)}</span>
                ) : null}
                <div className="hidden shrink-0 items-center gap-0.5 md:flex">
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className={cn('h-1 w-2 rounded-sm', i < strength(a) ? 'bg-signal/70' : 'bg-rule')}
                    />
                  ))}
                </div>
              </Link>
            ))}
          </div>
        </DashboardSection>

        <div className="space-y-3">
          {/* dollars by type — the auditable breakdown */}
          <DashboardSection
            id="dollars"
            title="Dollars by type"
            subtitle={periodLabel}
            layout={layout}
            action={
              <Tooltip content={DOLLAR_SUM_RULE}>
                <span className="cursor-help text-text-3">
                  <CircleAlert className="h-3 w-3" />
                </span>
              </Tooltip>
            }
          >
            {Object.keys(metrics.dollarsByType).length === 0 ? (
              <p className="py-3 text-xs text-text-3">No dollar figures in this window.</p>
            ) : (
              <div className="space-y-1">
                {DOLLAR_TYPES.filter((d) => metrics.dollarsByType[d.key]).map((d) => (
                  <div key={d.key} className="flex items-baseline justify-between gap-2 py-0.5">
                    <span className="flex items-center gap-1.5 text-xs text-text-2">
                      {d.label}
                      {!d.summable && (
                        <Badge tone="neutral" className="border-dashed">
                          excluded
                        </Badge>
                      )}
                    </span>
                    <span className={cn('fig text-xs', d.summable ? 'text-text' : 'text-text-3')}>
                      {formatDollarsExact(metrics.dollarsByType[d.key])}
                    </span>
                  </div>
                ))}
                <div className="mt-1 flex items-baseline justify-between border-t border-rule pt-1.5">
                  <span className="eyebrow">Total</span>
                  <span className="fig text-md font-medium text-ledger">
                    {formatDollarsExact(metrics.totalDollars)}
                  </span>
                </div>
              </div>
            )}
          </DashboardSection>

          {/* work queue */}
          <DashboardSection
            id="queue"
            title="Queue"
            subtitle={`${openTasks.length} open`}
            layout={layout}
            action={
              <Link to="/work" className="flex items-center gap-1 text-xs text-text-3 hover:text-signal">
                Work <ArrowRight className="h-3 w-3" />
              </Link>
            }
          >
          <div className="-m-3">
            {openTasks.length === 0 ? (
              <EmptyState icon={CheckCheck} title="Queue is clear" description="Nothing open right now." />
            ) : (
              <div>
                {openTasks.slice(0, 5).map((t) => {
                  const late = t.due_date && isBefore(parseISO(t.due_date), today);
                  return (
                    <div key={t.id} className="row flex items-center gap-2 px-3 py-1.5">
                      <span
                        className={cn(
                          'h-1.5 w-1.5 shrink-0 rounded-full',
                          t.priority === 'critical' ? 'bg-redline' : t.priority === 'high' ? 'bg-signal' : 'bg-text-3'
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-text-2">{t.title}</span>
                      {t.due_date && (
                        <span className={cn('fig shrink-0 text-2xs', late ? 'text-redline' : 'text-text-3')}>
                          <Clock3 className="mr-0.5 inline h-2.5 w-2.5" />
                          {formatDTG(t.due_date)}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </DashboardSection>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        {/* records that need strengthening — this is the nag that actually helps */}
        <DashboardSection
          id="strengthen"
          title="Needs strengthening"
          subtitle="won't survive a follow-up question"
          layout={layout}
        >
        <div className="-m-3">
          {needsWork.length === 0 ? (
            <EmptyState icon={CheckCheck} title="Every entry is defensible" description="All records carry a quantity, a figure, or a stated outcome." />
          ) : (
            <div>
              {needsWork.map((a) => (
                <Link key={a.id} to={`/activities/${a.id}`} className="row flex items-start gap-2.5 px-3 py-2">
                  <FileWarning className="mt-0.5 h-3 w-3 shrink-0 text-signal/70" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-text">{a.title}</span>
                    <span className="block truncate text-2xs text-text-3">{weaknesses(a).join(' · ')}</span>
                  </span>
                  <span className="fig shrink-0 text-2xs text-text-3">{formatDTG(a.date)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
        </DashboardSection>

      {/* Finding 46: how usable this record is as evidence, not how big it is.
          Counts and pointers over your own data — Vantage coaching, never a
          judgement of the Marine. */}
      <DashboardSection id="health" title="Record health" subtitle="Where the log would not hold up yet" layout={layout}>
        {health.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-text-2">
            <Stethoscope className="h-3.5 w-3.5 text-ledger" />
            Clean: outcomes stated, entries tagged and dated, no duplicate candidates, readiness filled in.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {health.map((h) => (
              <button
                key={h.key}
                type="button"
                onClick={() => navigate(h.to)}
                className="row flex items-start gap-2.5 rounded px-2 py-1.5 text-left hover:bg-panel-2/60"
              >
                <span className="fig mt-0.5 shrink-0 text-md text-signal">{h.count}</span>
                <span className="min-w-0">
                  <span className="block text-sm text-text">{h.label}</span>
                  <span className="mt-0.5 block text-2xs leading-relaxed text-text-3">{h.detail}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </DashboardSection>

        {/* goals */}
        <DashboardSection
          id="goals"
          title="Goals"
          subtitle={`${activeGoals.length} active`}
          layout={layout}
          action={
            <Link to="/goals" className="flex items-center gap-1 text-xs text-text-3 hover:text-signal">
              Goals <ArrowRight className="h-3 w-3" />
            </Link>
          }
        >
          {activeGoals.length === 0 ? (
            <EmptyState icon={Target} title="No active goals" description="Targets make progress legible. Set one." />
          ) : (
            <div className="space-y-2.5">
              {activeGoals.slice(0, 4).map((g) => (
                <Bar
                  key={g.id}
                  label={g.title}
                  value={g.current_value || 0}
                  max={g.target_value || 1}
                  figure={`${formatNumber(g.current_value || 0)}/${formatNumber(g.target_value)} ${g.unit || ''} · ${goalPct(g)}%`}
                />
              ))}
            </div>
          )}
        </DashboardSection>
      </div>

      {/* career totals */}
      <DashboardSection id="career" title="Career totals" subtitle="all time" layout={layout}>
      <FigureRow>
        <Figure label="Recognitions" raw={recognitions.length} formatFn={(n) => formatNumber(Math.round(n))} sub="awards · LOAs · certs" to="/career?tab=recognition" />
        <Figure
          label="Training hours"
          raw={trainings.reduce((s, t) => s + (t.hours || 0), 0)}
          formatFn={(n) => formatNumber(Math.round(n))}
          sub={`${trainings.length} courses`}
          to="/career?tab=development"
        />
        <Figure
          label="Lifetime units"
          raw={lifetime.totalQuantity}
          formatFn={(n) => formatNumber(Math.round(n))}
          sub="all quantities logged"
          to="/activities"
        />
        <Figure
          label="Lifetime impact"
          raw={lifetime.totalDollars}
          formatFn={formatDollars}
          tone="ledger"
          sub={`${activities.length} entries all time`}
          to="/reports"
        />
      </FigureRow>
      </DashboardSection>
    </div>
  );
}
