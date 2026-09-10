import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Target, Sparkles, Info, ArrowRight } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Textarea, EmptyState, Badge, Progress, NumberInput, Segmented, Skeleton } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog from '@/components/RecordDialog';
import VisibilityPicker from '@/components/VisibilityPicker';
import { AiAction } from '@/components/AiPanel';
import { track } from '@/lib/telemetry';
import { DateText, StatusBadge, onText } from '@/components/common';
import { useDeleteRecord, useGoals, useIdentity, usePrefs, useMetrics, useGoalContributors, useMetricsReport } from '@/lib/queries';
import * as api from '@/lib/api';
import { GOAL_TYPES, GOAL_STATUS, categoryNames } from '../../shared/constants';
import { formatNumber, formatDollars, rangeForPeriod, dayKey } from '../../shared/metrics';
import { daysUntil } from '../../shared/evaluation';
import { PERMISSIONS } from '../../shared/permissions';
import { humanize, cn, todayIso } from '@/lib/utils';

/**
 * Goals, stated in the units the work is actually measured in.
 *
 * A goal says which metric it tracks, which way is better, where it started and where it should
 * end up. Every automatic goal opens into the outcomes that counted toward it, so the number is
 * something a Marine can check rather than something they have to believe.
 */

interface GoalDraft {
  id?: string; version?: number; title: string; description: string; type: string; category: string | null;
  metric: string; metric_id: string | null; direction: string; aggregation: string; measure_scope: string;
  baseline_value: number | string; current_value: number | string; target_value: number | string;
  unit_label: string; status: string; period_start: string; period_end: string;
  visibility: 'private' | 'unit'; unit_id: string | null; assignee_id?: string | null;
}

const DIRECTION_OPTIONS = [
  { value: 'increase', label: 'Increase toward the target' },
  { value: 'decrease', label: 'Reduce toward the target' },
  { value: 'threshold', label: 'Reach at least the target' },
  { value: 'completion', label: 'Done or not done' },
];

const AGGREGATION_OPTIONS = [
  { value: 'sum', label: 'Add them up' },
  { value: 'max', label: 'Take the highest' },
  { value: 'min', label: 'Take the lowest' },
  { value: 'average', label: 'Take the average' },
  { value: 'latest', label: 'Take the most recent' },
  { value: 'distinct', label: 'Count how many outcomes' },
];

export default function Goals() {
  const cfg = useMetrics();
  const toast = useToast();
  const { data: identity } = useIdentity();
  const prefs = usePrefs();
  const { data: goals, isPending } = useGoals();
  const remove = useDeleteRecord('goals');
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [confirm, setConfirm] = useState<any>(null);
  const [counted, setCounted] = useState<any>(null);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const me = identity?.user.id;

  // The metrics this instance actually has data for, so a goal can only be set on something real.
  const yearParams = useMemo(() => { const r = rangeForPeriod('fiscalYear'); return { from: dayKey(r.start), to: dayKey(r.end), scope: 'me' }; }, []);
  const catalogQuery = useMetricsReport(yearParams);
  const metricOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const t of cfg.value_types) seen.set(`money:${t.key}`, `${cfg.currency_label}, ${t.label}${t.summable ? '' : ' (tracked separately)'}`);
    seen.set('duration:hours', 'Hours logged');
    for (const entry of catalogQuery.data?.catalog || []) if (!seen.has(entry.metricId)) seen.set(entry.metricId, entry.metricLabel);
    for (const unit of cfg.unit_suggestions) {
      const id = `quantity:${unit.trim().toLowerCase().replace(/s$/, '')}`;
      if (!seen.has(id)) seen.set(id, unit);
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [cfg, catalogQuery.data]);

  const list = useMemo(
    () => (goals || []).filter((g: any) => filter === 'all' || g.status === 'active').sort((a: any, b: any) => (a.period_end || '9999').localeCompare(b.period_end || '9999')),
    [goals, filter],
  );

  const newGoal = () => setDraft({
    title: '', description: '', type: 'quarterly', category: null,
    metric: 'manual', metric_id: null, direction: 'increase', aggregation: 'sum', measure_scope: 'subject',
    baseline_value: 0, current_value: 0, target_value: '', unit_label: '',
    status: 'active', period_start: todayIso(), period_end: '',
    visibility: prefs.defaultVisibility || 'private', unit_id: identity?.primaryUnitId || null,
  });

  const canEditRow = (r: any) => r.user_id === me || Boolean(r.unit_id && identity && ((identity.permissions[r.unit_id] || 0) & ((1 << 12) | (1 << 3))));
  const format = (g: any, n: number) => (String(g.metric_id || '').startsWith('money:') ? formatDollars(n) : `${formatNumber(n)}${g.unit_label ? ` ${g.unit_label}` : ''}`);

  if (isPending) return <div className="page space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-40" /></div>;

  return (
    <div className="page">
      <PageHeader eyebrow="Goals" title="Targets" lede="A goal names what it measures, which way is better, and where it started. Automatic goals read the same work the rest of Vantage does.">
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} label="Filter" />
        <Button variant="primary" onClick={newGoal}><Plus className="h-4 w-4" />New goal</Button>
      </PageHeader>

      {list.length === 0 ? (
        <div className="card"><EmptyState icon={Target} title={filter === 'active' ? 'No active goals' : 'No goals yet'} description="Pick one number you want to move this quarter, in the unit the work is measured in." action={<Button variant="primary" onClick={newGoal}>Set a goal</Button>} /></div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {list.map((g: any) => {
            const p = g.progress || { current: Number(g.current_value) || 0, percent: 0, met: false, auto: false, basis: '', measuresEntries: false, outcomes: 0 };
            const days = daysUntil(g.period_end);
            return (
              <article key={g.id} className="card card-hover p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-base font-semibold text-ink">{g.title}</h3>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {humanize(g.type)}
                      {p.auto ? ` · ${DIRECTION_OPTIONS.find((d) => d.value === g.direction)?.label || 'Tracked automatically'}` : ' · Tracked by hand'}
                      {g.category ? ` · ${g.category}` : ''}
                    </p>
                  </div>
                  <StatusBadge value={g.status} />
                </div>
                {g.description && <p className="mt-2 text-sm text-ink-2">{g.description}</p>}

                {p.measuresEntries && (
                  <p className="mt-2 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/5 px-2.5 py-2 text-xs text-ink">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
                    This goal counts entries, not outcomes. Its recorded value is kept. Set a new one on what the work produced.
                  </p>
                )}

                <div className="mt-3">
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="fig font-semibold text-ink">
                      {format(g, p.current)}
                      {g.target_value != null && g.direction !== 'completion' && <span className="font-normal text-ink-3"> of {format(g, Number(g.target_value))}</span>}
                    </span>
                    <span className={cn('fig text-xs', p.met ? 'text-good' : 'text-ink-3')}>{p.met ? 'Met' : `${Math.round(p.percent)}%`}</span>
                  </div>
                  <Progress value={p.percent} className="mt-1.5" tone={p.met ? 'good' : days != null && days < 14 && p.percent < 70 ? 'warn' : 'accent'} />
                </div>

                {p.basis && <p className="mt-2 text-2xs leading-relaxed text-ink-3">{p.basis}</p>}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
                  <span>
                    {g.period_end ? (
                      <>Ends <DateText value={g.period_end} />{days != null && g.status === 'active' && <span className={cn('ml-1', days < 0 ? 'text-bad' : days < 14 ? 'text-warn' : '')}>({days < 0 ? `${-days}d overdue` : `${days}d left`})</span>}</>
                    ) : 'No end date'}
                    {g.visibility === 'unit' && <Badge tone="info" className="ml-2">Shared</Badge>}
                  </span>
                  <span className="flex gap-1">
                    {p.auto && !p.measuresEntries && <Button size="xs" variant="ghost" onClick={() => setCounted(g)}>What counted?</Button>}
                    {canEditRow(g) && <Button size="xs" variant="ghost" onClick={() => setDraft(toDraft(g))}>Edit</Button>}
                    {canEditRow(g) && <Button size="xs" variant="ghost" onClick={() => setConfirm(g)}>Delete</Button>}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <RecordDialog<GoalDraft>
        store="goals" open={Boolean(draft)} onOpenChange={(o) => { if (!o) setDraft(null); }} initial={draft}
        title={draft?.id ? 'Edit goal' : 'New goal'} noun="Goal"
        validate={(d) => {
          if (!d.title.trim()) return 'A title is required.';
          if (d.metric_id && d.direction !== 'completion' && d.target_value === '') return 'Say what the target is.';
          return null;
        }}
        fields={(d, set, errors) => (
          <>
            <div className="flex items-end gap-2">
              <Field label="Goal" required error={errors.title} className="flex-1">
                <Input autoFocus value={d.title} onChange={onText(set, 'title')} placeholder="Reconcile every aged obligation before FY close" />
              </Field>
              <AiAction
                workflow="goal_draft"
                input={{ objective: d.title || d.description, target_date: d.period_end || null, context: d.description }}
                label="Make it measurable"
                onResult={(out) => {
                  if (out.title) set('title', String(out.title));
                  if (out.description) set('description', String(out.description));
                  if (out.target_value != null) set('target_value', out.target_value);
                  if (out.unit) set('unit_label', String(out.unit));
                  if (out.period_end) set('period_end', String(out.period_end));
                }}
              />
            </div>
            <Field label="Why it matters"><Textarea rows={2} value={d.description} onChange={onText(set, 'description')} /></Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Type"><Select value={d.type} onValueChange={(v) => set('type', v)} options={GOAL_TYPES.map((s) => ({ value: s, label: humanize(s) }))} /></Field>
              <Field label="Status"><Select value={d.status} onValueChange={(v) => set('status', v)} options={GOAL_STATUS.map((s) => ({ value: s, label: humanize(s) }))} /></Field>

              <Field label="What it measures" className="col-span-2" hint="Choose a metric to have Vantage track it from your work, or keep it by hand when the number lives elsewhere.">
                <Select
                  value={d.metric_id || '__manual'}
                  onValueChange={(v) => {
                    const id = v === '__manual' ? null : v;
                    set('metric_id', id);
                    // The legacy `metric` column stays "manual"; a metric id is what makes a goal automatic.
                    set('metric', 'manual');
                    if (id?.startsWith('quantity:') && !d.unit_label) set('unit_label', id.slice('quantity:'.length));
                  }}
                  options={[{ value: '__manual', label: 'A number I keep by hand' }, ...metricOptions]}
                />
              </Field>

              {d.metric_id && (
                <>
                  <Field label="Which way is better"><Select value={d.direction} onValueChange={(v) => set('direction', v)} options={DIRECTION_OPTIONS} /></Field>
                  <Field label="How to combine"><Select value={d.aggregation} onValueChange={(v) => set('aggregation', v)} options={AGGREGATION_OPTIONS} /></Field>
                  <Field label="Measure the work of" className="col-span-2">
                    <Select
                      value={d.measure_scope} onValueChange={(v) => set('measure_scope', v)}
                      options={[{ value: 'subject', label: 'The person this goal is for' }, { value: 'unit', label: 'The whole unit' }]}
                    />
                  </Field>
                  <Field label="Only count category" className="col-span-2">
                    <Select value={d.category || '__any'} onValueChange={(v) => set('category', v === '__any' ? null : v)} options={[{ value: '__any', label: 'Any category' }, ...categoryNames(cfg).map((c) => ({ value: c, label: c }))]} />
                  </Field>
                </>
              )}

              {d.direction !== 'completion' && (
                <>
                  <Field label="Starts from" hint="Where things stand today. Zero for a fresh count."><NumberInput value={d.baseline_value} onChange={onText(set, 'baseline_value')} /></Field>
                  <Field label="Target" required error={errors.target_value}><NumberInput value={d.target_value} onChange={onText(set, 'target_value')} placeholder="100" /></Field>
                </>
              )}

              {!d.metric_id && <Field label="Current" error={errors.current_value}><NumberInput value={d.current_value} onChange={onText(set, 'current_value')} /></Field>}
              <Field label="Unit label" className={d.metric_id ? 'col-span-2' : ''}><Input value={d.unit_label} onChange={onText(set, 'unit_label')} placeholder="ULOs" list="goal-units" /></Field>
              <datalist id="goal-units">{cfg.unit_suggestions.map((u) => <option key={u} value={u} />)}</datalist>

              <Field label="Starts"><Input type="date" value={d.period_start} onChange={onText(set, 'period_start')} /></Field>
              <Field label="Ends"><Input type="date" value={d.period_end} onChange={onText(set, 'period_end')} /></Field>
            </div>

            <VisibilityPicker permission={PERMISSIONS.CREATE_SHARED_GOALS} value={d.visibility} unitId={d.unit_id} onChange={(v) => { set('visibility', v.visibility); set('unit_id', v.unit_id ?? null); }} />
            {identity?.instance.aiEnabled && <p className="flex items-center gap-1.5 text-2xs text-ink-3"><Sparkles className="h-3 w-3" />AI suggestions are drafts. Check the number and the date.</p>}
          </>
        )}
      />

      {counted && <WhatCounted goal={counted} onClose={() => setCounted(null)} />}

      <ConfirmDialog
        open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }}
        title="Delete this goal?" body="It moves to the recycle bin for 30 days."
        onConfirm={async () => { try { await remove.mutateAsync(confirm.id); toast.success('Goal deleted.'); } catch (e) { toast.error(api.errorText(e)); } }}
      />
    </div>
  );
}

function toDraft(g: any): GoalDraft {
  return {
    ...g,
    description: g.description || '',
    unit_label: g.unit_label || '',
    period_start: g.period_start || '',
    period_end: g.period_end || '',
    target_value: g.target_value ?? '',
    baseline_value: g.baseline_value ?? 0,
    current_value: g.current_value ?? 0,
    metric_id: g.metric_id || null,
    direction: g.direction || 'increase',
    aggregation: g.aggregation || 'sum',
    measure_scope: g.measure_scope || 'subject',
  };
}

function WhatCounted({ goal, onClose }: { goal: any; onClose: () => void }) {
  const query = useGoalContributors(goal.id);
  // Whether people open a goal to see what counted toward it. The count, never the outcomes.
  useEffect(() => { if (query.data) track('goal.inspected', { contributors: query.data.length }); }, [query.data]);
  const rows = query.data || [];
  const money = String(goal.metric_id || '').startsWith('money:');
  const sum = rows.reduce((n, r) => n + r.value, 0);
  return (
    <Dialog
      open onOpenChange={(o) => { if (!o) onClose(); }}
      title={`What counted toward "${goal.title}"`}
      description={goal.progress?.basis}
      size="lg"
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {query.isPending ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-11" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing has counted yet" description="No outcome in this goal's period matches what it measures." />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={`${r.table}-${r.id}`}>
                <Link to={r.table === 'activities' ? `/records/${r.id}` : '/career?tab=training'} onClick={onClose} className="flex items-center gap-3 px-1 py-2.5 transition-colors hover:bg-surface-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{r.title}</span>
                    <span className="block text-xs text-ink-3"><DateText value={r.date} /></span>
                  </span>
                  <span className="fig shrink-0 text-sm font-medium text-ink">{money ? formatDollars(r.value) : `${formatNumber(r.value)} ${r.unit}`}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                </Link>
              </li>
            ))}
          </ul>
          <p className="fig mt-3 text-right text-sm text-ink-2">
            {rows.length} {rows.length === 1 ? 'outcome' : 'outcomes'}, {money ? formatDollars(sum) : formatNumber(sum)} in total
          </p>
        </>
      )}
    </Dialog>
  );
}
