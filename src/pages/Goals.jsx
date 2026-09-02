import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Sparkles, Trash2, Target, TrendingUp } from 'lucide-react';
import { useGoals, useActivities, createRecord, updateRecord, deleteRecord, refreshAll } from '@/store/useStore';
import { aiAssist, aiStatus, errorText } from '@/lib/api';
import { CATEGORIES, GOAL_TYPES, GOAL_STATUS } from '@/lib/constants';
import { formatNumber, formatDTG, inPeriod, toDate } from '@/lib/metrics';
import { useToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/Dialog';
import RecordDialog from '@/components/RecordDialog';
import ConflictDialog from '@/components/ConflictDialog';
import VisibilityPicker, { UnitTargetPicker } from '@/components/VisibilityPicker';
import {
  Panel, PageHeader, EmptyState, Button, Input, NumberInput, Textarea, Select, Field, Badge, Segmented,
} from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const STATUS_TONE = { active: 'signal', achieved: 'ledger', paused: 'neutral', missed: 'redline' };

export default function Goals() {
  const goals = useGoals();
  const activities = useActivities();
  const toast = useToast();
  const [dialog, setDialog] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [goalErrors, setGoalErrors] = useState({});
  const [confirming, setConfirming] = useState(null);
  const [filter, setFilter] = useState('active');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiAvailable, setAiAvailable] = useState(false);

  useEffect(() => {
    if (!dialog) return undefined;
    aiStatus().then((status) => setAiAvailable(Boolean(status.available))).catch(() => setAiAvailable(false));
    return undefined;
  }, [dialog]);

  const withProgress = useMemo(
    () =>
      goals.map((g) => {
        let current = g.current_value || 0;
        let auto = false;
        if (g.category) {
          const range = {
            start: toDate(g.period_start) || new Date(1970, 0, 1),
            end: toDate(g.period_end) || new Date(2099, 0, 1),
          };
          const matched = activities.filter((a) => a.category === g.category && inPeriod(a.date, range));
          current = g.unit && matched.some((a) => a.unit && a.unit.toLowerCase() === g.unit.toLowerCase())
            ? matched.reduce((s, a) => s + (a.quantity || 0), 0)
            : matched.length;
          auto = true;
        }
        const pct = g.target_value ? Math.min(100, Math.round((current / g.target_value) * 100)) : 0;
        return { ...g, computed: current, pct, auto };
      }),
    [goals, activities]
  );

  const visible = filter === 'all' ? withProgress : withProgress.filter((g) => g.status === filter);

  const save = async (draft) => {
    if (!draft.title?.trim()) return toast.error('A goal needs a title.');
    if (!draft.target_value) return toast.error('A goal needs a target to measure against.');
    const payload = {
      ...draft,
      target_value: Number(draft.target_value),
      current_value: Number(draft.current_value || 0),
    };
    try {
      if (draft.id) await updateRecord('goals', draft.id, payload);
      else await createRecord('goals', { status: 'active', type: 'performance', ...payload });
      toast.success(draft.id ? 'Goal updated.' : 'Goal set.');
      setDialog(null);
      setGoalErrors({});
    } catch (err) {

      if (err.status === 409 && err.code === 'stale' && err.current) {
        setConflict({ current: err.current, payload: { ...payload, id: draft.id } });
      } else {
        setGoalErrors(err.fieldErrors || {});
        toast.error(errorText(err));
      }
    }
  };

  const draftGoal = async (draft, set) => {
    const objective = [draft.title, draft.description].filter(Boolean).join('\n').trim();
    if (!objective) {
      toast.error('Describe the objective before generating.');
      return;
    }
    setAiBusy(true);
    try {
      const result = await aiAssist('goal_draft', { objective, target_date: draft.period_end });
      const suggestion = result.output || {};
      for (const [key, value] of Object.entries({
        title: suggestion.title,
        description: suggestion.description,
        target_value: suggestion.target_value,
        unit: suggestion.unit,
        period_start: suggestion.period_start,
        period_end: suggestion.period_end,
        category: CATEGORIES.includes(suggestion.category) ? suggestion.category : undefined,
      })) if (value !== undefined && value !== null && value !== '') set(key, value);
      toast.success('Vantage generated editable goal fields. Verify before saving.');
    } catch (error) {
      toast.error(errorText(error));
    } finally { setAiBusy(false); }
  };

  return (
    <div className="mx-auto max-w-[1200px]">
      <PageHeader title="Goals" subtitle="Targets you can point at, with progress drawn from the log">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'achieved', label: 'Done' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Button variant="primary" size="sm" onClick={() => setDialog({})}>
          <Plus className="h-3.5 w-3.5" />
          New goal
        </Button>
      </PageHeader>

      {visible.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Target}
            title={goals.length ? 'Nothing in this view' : 'No goals set'}
            description="Set a measurable target and let matching work update progress automatically."
            action={<Button size="sm" onClick={() => setDialog({})}>Set a goal</Button>}
          />
        </Panel>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {visible.map((g) => (
            <Panel
              key={g.id}
              title={g.title}
              subtitle={[g.type, g.category].filter(Boolean).join(' · ')}
              action={
                <>
                  <Badge tone={STATUS_TONE[g.status]}>{g.status}</Badge>
                  <Button variant="ghost" size="sm" onClick={() => setDialog(g)}>Edit</Button>
                  <button type="button" aria-label={`Delete ${g.title}`} onClick={() => setConfirming(g)} className="text-text-3 hover:text-redline">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              }
            >
              {g.description && <p className="mb-3 text-sm leading-relaxed text-text-2">{g.description}</p>}
              <div className="flex items-baseline justify-between">
                <span className="fig text-2xl font-medium text-text">
                  {formatNumber(g.computed)}
                  <span className="text-lg text-text-3">/{formatNumber(g.target_value)}</span>
                </span>
                <span className={cn('fig text-md', g.pct >= 100 ? 'text-ledger' : 'text-signal')}>{g.pct}%</span>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-sm bg-rule/60">
                <div
                  className={cn('h-full transition-[width] duration-700', g.pct >= 100 ? 'bg-ledger' : 'bg-signal')}
                  style={{ width: `${g.pct}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <span className="fig text-2xs text-text-3">
                  {g.unit || 'units'}
                  {g.period_start && ` · ${formatDTG(g.period_start)} — ${formatDTG(g.period_end)}`}
                </span>
                {g.auto && (
                  <span className="flex items-center gap-1 text-2xs text-text-3">
                    <TrendingUp className="h-2.5 w-2.5 text-signal" />
                    counted from the log
                  </span>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}

      <ConflictDialog
        noun="goal"
        current={conflict?.current}
        onDismiss={() => setConflict(null)}
        onLoadNewest={async () => {
          const winner = conflict.current;
          setConflict(null);
          await refreshAll();
          setDialog((d) => (d ? { ...d, ...winner } : d));
          toast.success('Loaded the newest copy into the form.');
        }}
        onOverwrite={async () => {
          const { current, payload } = conflict;
          setConflict(null);
          try {
            await updateRecord('goals', payload.id, { ...payload, version: current.version });
            toast.success('Goal updated — your copy won.');
            setDialog(null);
          } catch (err) { toast.error(errorText(err)); }
        }}
      />

      {dialog && (
        <RecordDialog
          title={dialog.id ? 'Edit goal' : 'New goal'}
          initial={dialog}
          onCancel={() => setDialog(null)}
          onSave={save}
          fields={(draft, set) => (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-rule bg-panel-2/40 p-3 text-xs text-text-3">
                <p className="flex items-center gap-2">
                  <Sparkles className={cn('h-3.5 w-3.5 text-signal', aiBusy && 'animate-pulse')} />
                  <span>{aiAvailable ? 'Generated fields stay editable in this form.' : 'Vantage generation is unavailable until the server key is configured.'}</span>
                </p>
                <Button type="button" size="sm" onClick={() => draftGoal(draft, set)} disabled={aiBusy}>
                  <Sparkles className={cn('h-3.5 w-3.5', aiBusy && 'animate-pulse')} />
                  {aiBusy ? 'Generating…' : 'Generate using Vantage'}
                </Button>
              </div>
              <Field error={goalErrors.title} label="Title">
                <Input autoFocus value={draft.title || ''} onChange={(e) => set('title', e.target.value)} />
              </Field>
              <Field label="Description">
                <Textarea rows={2} value={draft.description || ''} onChange={(e) => set('description', e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field error={goalErrors.target_value} label="Target">
                  <NumberInput value={draft.target_value ?? ''} onChange={(e) => set('target_value', e.target.value)} />
                </Field>
                <Field label="Unit">
                  <Input value={draft.unit || ''} onChange={(e) => set('unit', e.target.value)} placeholder="ULOs" />
                </Field>
                <Field label="Type">
                  <Select value={draft.type || 'performance'} onValueChange={(v) => set('type', v)} options={GOAL_TYPES} />
                </Field>
                <Field label="Status">
                  <Select value={draft.status || 'active'} onValueChange={(v) => set('status', v)} options={GOAL_STATUS} />
                </Field>
                <Field error={goalErrors.period_start} label="Period start">
                  <Input type="date" value={draft.period_start || ''} onChange={(e) => set('period_start', e.target.value)} />
                </Field>
                <Field error={goalErrors.period_end} label="Period end">
                  <Input type="date" value={draft.period_end || ''} onChange={(e) => set('period_end', e.target.value)} />
                </Field>
              </div>
              <Field label="Auto-count category" hint="progress counts matching activities in the period">
                <Select
                  value={draft.category || ''}
                  onValueChange={(v) => set('category', v || null)}
                  placeholder="Track manually"
                  options={[{ value: '', label: 'Track manually' }, ...CATEGORIES.map((c) => ({ value: c, label: c }))]}
                />
              </Field>
              {!draft.category && (
                <Field error={goalErrors.current_value} label="Current value">
                  <NumberInput value={draft.current_value ?? ''} onChange={(e) => set('current_value', e.target.value)} />
                </Field>
              )}
              <VisibilityPicker
                value={draft.visibility || 'private'}
                onChange={(value) => set('visibility', value)}
                unitId={draft.unit_id}
                label="Who sees this goal"
              />
              {(draft.visibility || 'private') !== 'personal' && (
                <UnitTargetPicker
                  value={draft.unit_id}
                  onChange={(value) => set('unit_id', value || null)}
                  visibility={draft.visibility || 'private'}
                />
              )}
            </>
          )}
        />
      )}

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(v) => !v && setConfirming(null)}
        title={`Delete "${confirming?.title}"?`}
        body="The goal and its target are removed. Logged activities are unaffected."
        onConfirm={async () => {
          await deleteRecord('goals', confirming.id);
          toast.success('Goal deleted.');
        }}
      />
    </div>
  );
}
