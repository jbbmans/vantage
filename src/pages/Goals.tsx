import { useMemo, useState } from 'react';
import { Plus, Target, Sparkles } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Textarea, EmptyState, Badge, Progress, NumberInput, Segmented } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog from '@/components/RecordDialog';
import VisibilityPicker from '@/components/VisibilityPicker';
import { AiAction } from '@/components/AiPanel';
import { DateText, StatusBadge, onText } from '@/components/common';
import { useActivities, useDeleteRecord, useGoals, useIdentity, usePrefs, useTrainings, useUpdateRecord } from '@/lib/queries';
import * as api from '@/lib/api';
import { GOAL_TYPES, GOAL_STATUS, GOAL_METRICS, CATEGORIES } from '../../shared/constants';
import { goalProgress } from '../../shared/goals';
import { formatNumber, formatDollars } from '../../shared/metrics';
import { daysUntil } from '../../shared/evaluation';
import { humanize, cn, todayIso } from '@/lib/utils';

interface GoalDraft { id?: string; version?: number; title: string; description: string; type: string; category: string | null; metric: string; current_value: number | string; target_value: number | string; unit_label: string; status: string; period_start: string; period_end: string; visibility: 'private' | 'unit'; unit_id: string | null; assignee_id?: string | null }

const METRIC_LABEL: Record<string, string> = { manual: 'Tracked by hand', activity_count: 'Count of logged activities', activity_dollars: 'Dollars in logged activities', activity_quantity: 'Quantities in logged activities', training_hours: 'Training hours logged' };

export default function Goals() {
  const toast = useToast();
  const { data: identity } = useIdentity();
  const prefs = usePrefs();
  const { data: goals } = useGoals();
  const { data: activities } = useActivities();
  const { data: trainings } = useTrainings();
  const update = useUpdateRecord('goals');
  const remove = useDeleteRecord('goals');
  const [draft, setDraft] = useState<GoalDraft | null>(null);
  const [confirm, setConfirm] = useState<any>(null);
  const [filter, setFilter] = useState<'active' | 'all'>('active');
  const me = identity?.user.id;
  const list = useMemo(() => (goals || []).filter((g: any) => filter === 'all' || g.status === 'active').sort((a: any, b: any) => (a.period_end || '9999').localeCompare(b.period_end || '9999')), [goals, filter]);
  const newGoal = () => setDraft({ title: '', description: '', type: 'quarterly', category: null, metric: 'manual', current_value: 0, target_value: '', unit_label: '', status: 'active', period_start: todayIso(), period_end: '', visibility: prefs.defaultVisibility || 'private', unit_id: identity?.primaryUnitId || null });
  const canEditRow = (r: any) => r.user_id === me || Boolean(r.unit_id && identity && ((identity.permissions[r.unit_id] || 0) & ((1 << 12) | (1 << 3))));
  const bump = async (g: any, value: number) => { try { await update.mutateAsync({ id: g.id, patch: { current_value: value, version: g.version } }); } catch (e) { toast.error(api.errorText(e)); } };
  const fmt = (g: any, n: number) => (g.metric === 'activity_dollars' ? formatDollars(n) : `${formatNumber(n)}${g.unit_label ? ` ${g.unit_label}` : ''}`);

  return (
    <div className="page">
      <PageHeader eyebrow="Goals" title="Targets" lede="Measurable goals that update themselves from what you log. Manual goals when the number lives elsewhere.">
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'active', label: 'Active' }, { value: 'all', label: 'All' }]} label="Filter" />
        <Button variant="primary" onClick={newGoal}><Plus className="h-4 w-4" />New goal</Button>
      </PageHeader>
      {list.length === 0 ? <div className="card"><EmptyState icon={Target} title={filter === 'active' ? 'No active goals' : 'No goals yet'} description="Pick one number you want to move this quarter. Vantage tracks it against your log." action={<Button variant="primary" onClick={newGoal}>Set a goal</Button>} /></div> : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {list.map((g: any) => {
            const p = goalProgress(g, activities || [], trainings || []);
            const days = daysUntil(g.period_end);
            return (
              <article key={g.id} className="card card-hover p-4">
                <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="text-base font-semibold text-ink">{g.title}</h3><p className="mt-0.5 text-xs text-ink-3">{humanize(g.type)} · {METRIC_LABEL[g.metric] || g.metric}{g.category ? ` · ${g.category}` : ''}</p></div><StatusBadge value={g.status} /></div>
                {g.description && <p className="mt-2 text-sm text-ink-2">{g.description}</p>}
                <div className="mt-3"><div className="flex items-baseline justify-between text-sm"><span className="fig font-semibold text-ink">{fmt(g, p.current)}<span className="font-normal text-ink-3"> of {fmt(g, p.target)}</span></span><span className="fig text-xs text-ink-3">{Math.round(p.pct)}%</span></div><Progress value={p.pct} className="mt-1.5" tone={p.pct >= 100 ? 'good' : days != null && days < 14 && p.pct < 70 ? 'warn' : 'accent'} /></div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
                  <span>{g.period_end ? <>Ends <DateText value={g.period_end} />{days != null && g.status === 'active' && <span className={cn('ml-1', days < 0 ? 'text-bad' : days < 14 ? 'text-warn' : '')}>({days < 0 ? `${-days}d overdue` : `${days}d left`})</span>}</> : 'No end date'}{g.visibility === 'unit' && <Badge tone="info" className="ml-2">Shared</Badge>}</span>
                  <span className="flex gap-1">
                    {!p.auto && canEditRow(g) && g.status === 'active' && <><Button size="xs" variant="ghost" onClick={() => bump(g, Math.max(0, p.current - 1))} aria-label="Decrease">−1</Button><Button size="xs" variant="ghost" onClick={() => bump(g, p.current + 1)} aria-label="Increase">+1</Button></>}
                    {canEditRow(g) && <Button size="xs" variant="ghost" onClick={() => setDraft({ ...g, description: g.description || '', unit_label: g.unit_label || '', period_start: g.period_start || '', period_end: g.period_end || '', target_value: g.target_value ?? '', current_value: g.current_value ?? 0 })}>Edit</Button>}
                    {canEditRow(g) && <Button size="xs" variant="ghost" onClick={() => setConfirm(g)}>Delete</Button>}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <RecordDialog<GoalDraft> store="goals" open={Boolean(draft)} onOpenChange={(o) => { if (!o) setDraft(null); }} initial={draft} title={draft?.id ? 'Edit goal' : 'New goal'} noun="Goal" validate={(d) => (!d.title.trim() ? 'A title is required.' : null)}
        fields={(d, set, errors) => (
          <>
            <div className="flex items-end gap-2"><Field label="Goal" required error={errors.title} className="flex-1"><Input autoFocus value={d.title} onChange={onText(set, 'title')} placeholder="Reconcile every aged ULO before FY close" /></Field>
              <AiAction workflow="goal_draft" input={{ objective: d.title || d.description, target_date: d.period_end || null, context: d.description }} label="Make it measurable" onResult={(out) => { if (out.title) set('title', String(out.title)); if (out.description) set('description', String(out.description)); if (out.target_value != null) set('target_value', out.target_value); if (out.unit) set('unit_label', String(out.unit)); if (out.period_end) set('period_end', String(out.period_end)); }} /></div>
            <Field label="Why it matters"><Textarea rows={2} value={d.description} onChange={onText(set, 'description')} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type"><Select value={d.type} onValueChange={(v) => set('type', v)} options={GOAL_TYPES.map((s) => ({ value: s, label: humanize(s) }))} /></Field>
              <Field label="Status"><Select value={d.status} onValueChange={(v) => set('status', v)} options={GOAL_STATUS.map((s) => ({ value: s, label: humanize(s) }))} /></Field>
              <Field label="Measured by" className="col-span-2"><Select value={d.metric} onValueChange={(v) => set('metric', v)} options={GOAL_METRICS.map((m) => ({ value: m, label: METRIC_LABEL[m] }))} /></Field>
              {d.metric !== 'manual' && d.metric !== 'training_hours' && <Field label="Only count category" className="col-span-2"><Select value={d.category || '__any'} onValueChange={(v) => set('category', v === '__any' ? null : v)} options={[{ value: '__any', label: 'Any category' }, ...CATEGORIES.map((c) => ({ value: c, label: c }))]} /></Field>}
              <Field label="Target" required error={errors.target_value}><NumberInput value={d.target_value} onChange={onText(set, 'target_value')} placeholder="100" /></Field>
              {d.metric === 'manual' ? <Field label="Current" error={errors.current_value}><NumberInput value={d.current_value} onChange={onText(set, 'current_value')} /></Field> : <Field label="Unit label"><Input value={d.unit_label} onChange={onText(set, 'unit_label')} placeholder="ULOs" /></Field>}
              {d.metric === 'manual' && <Field label="Unit label" className="col-span-2"><Input value={d.unit_label} onChange={onText(set, 'unit_label')} placeholder="ULOs" /></Field>}
              <Field label="Starts"><Input type="date" value={d.period_start} onChange={onText(set, 'period_start')} /></Field>
              <Field label="Ends"><Input type="date" value={d.period_end} onChange={onText(set, 'period_end')} /></Field>
            </div>
            <VisibilityPicker value={d.visibility} unitId={d.unit_id} onChange={(v) => { set('visibility', v.visibility); set('unit_id', v.unit_id ?? null); }} />
            {identity?.instance.aiEnabled && <p className="flex items-center gap-1.5 text-2xs text-ink-3"><Sparkles className="h-3 w-3" />AI suggestions are drafts. Check the number and the date.</p>}
          </>
        )} />
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title="Delete this goal?" body="It moves to the recycle bin for 30 days." onConfirm={async () => { try { await remove.mutateAsync(confirm.id); toast.success('Goal deleted.'); } catch (e) { toast.error(api.errorText(e)); } }} />
    </div>
  );
}
