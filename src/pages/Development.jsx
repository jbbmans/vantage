import React, { useMemo, useState } from 'react';
import { Plus, Trash2, GraduationCap, Clock } from 'lucide-react';
import { useTrainings, createRecord, updateRecord, deleteRecord } from '@/store/useStore';
import { TRAINING_TYPES, TRAINING_STATUS } from '@/lib/constants';
import { formatNumber, formatDTG } from '@/lib/metrics';
import { useToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/Dialog';
import RecordDialog from '@/components/RecordDialog';
import VisibilityPicker, { DEFAULT_VISIBILITY, UnitTargetPicker } from '@/components/VisibilityPicker';
import { Figure, FigureRow } from '@/components/Figure';
import {
  Panel, EmptyState, Button, Input, NumberInput, Textarea, Select, Field, Badge, Segmented,
} from '@/components/ui/primitives';

const STATUS_TONE = { completed: 'ledger', in_progress: 'signal', scheduled: 'info' };

export default function Development() {
  const trainings = useTrainings();
  const toast = useToast();
  const [dialog, setDialog] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [filter, setFilter] = useState('all');

  const totals = useMemo(() => {
    const done = trainings.filter((t) => t.status === 'completed');
    return {
      hours: trainings.reduce((s, t) => s + (Number(t.hours) || 0), 0),
      completed: done.length,
      inProgress: trainings.filter((t) => t.status === 'in_progress').length,
      certs: trainings.filter((t) => ['certification', 'qualification'].includes(t.type)).length,
    };
  }, [trainings]);

  const visible = useMemo(() => {
    const rows = filter === 'all' ? trainings : trainings.filter((t) => t.status === filter);
    return [...rows].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  }, [trainings, filter]);

  const save = async (draft) => {
    if (!draft.title?.trim()) return toast.error('Give the course a title.');
    const payload = { ...draft, hours: draft.hours ? Number(draft.hours) : null };
    if (draft.id) await updateRecord('trainings', draft.id, payload);
    else await createRecord('trainings', { status: 'completed', type: 'course', ...payload });
    toast.success(draft.id ? 'Record updated.' : 'Record added.');
    setDialog(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h3 className="text-xl font-semibold text-text">Training &amp; PME</h3><p className="mt-1 text-sm text-text-3">Courses, qualifications, credentials, and the hours behind them.</p></div>
        <Button variant="primary" size="sm" onClick={() => setDialog({})}>
          <Plus className="h-3.5 w-3.5" />
          Add record
        </Button>
      </div>

      <FigureRow>
        <Figure label="Total hours" raw={totals.hours} formatFn={(n) => formatNumber(Math.round(n))} sub="instruction logged" />
        <Figure label="Completed" raw={totals.completed} formatFn={(n) => formatNumber(Math.round(n))} sub={`${trainings.length} records`} />
        <Figure label="In progress" raw={totals.inProgress} formatFn={(n) => formatNumber(Math.round(n))} tone="signal" sub="currently enrolled" />
        <Figure label="Quals & certs" raw={totals.certs} formatFn={(n) => formatNumber(Math.round(n))} sub="credentials earned" />
      </FigureRow>

      <div>
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'completed', label: 'Done' },
            { value: 'in_progress', label: 'Active' },
            { value: 'scheduled', label: 'Upcoming' },
          ]}
        />
      </div>

      <Panel bodyClassName="p-0">
        {visible.length === 0 ? (
          <EmptyState
            icon={GraduationCap}
            title={trainings.length ? 'Nothing in this view' : 'No development records'}
            description="Courses, PME, certifications, and quals all belong here. Hours add up faster than you expect."
            action={<Button size="sm" onClick={() => setDialog({})}>Add a record</Button>}
          />
        ) : (
          visible.map((t) => (
            <div key={t.id} className="row flex items-center gap-3 px-3 py-2">
              <span className="fig w-16 shrink-0 text-2xs text-text-3">{formatDTG(t.date)}</span>
              <button type="button" onClick={() => setDialog(t)} className="min-w-0 flex-1 text-left">
                <span className="block truncate text-base text-text">{t.title}</span>
                <span className="block truncate text-2xs text-text-3">
                  {[t.provider, t.type, t.notes].filter(Boolean).join(' · ')}
                </span>
              </button>
              {t.hours ? (
                <span className="fig hidden shrink-0 items-center gap-1 text-xs text-text-2 sm:flex">
                  <Clock className="h-3 w-3 text-text-3" />
                  {formatNumber(t.hours)}h
                </span>
              ) : null}
              <Badge tone={STATUS_TONE[t.status] || 'neutral'}>{String(t.status || '').replace('_', ' ')}</Badge>
              <button type="button" aria-label={`Delete ${t.title}`} onClick={() => setConfirming(t)} className="shrink-0 text-text-3 hover:text-redline">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))
        )}
      </Panel>

      {dialog && (
        <RecordDialog
          title={dialog.id ? 'Edit record' : 'Add development record'}
          initial={dialog}
          onCancel={() => setDialog(null)}
          onSave={save}
          fields={(draft, set) => (
            <>
              <Field label="Title">
                <Input autoFocus value={draft.title || ''} onChange={(e) => set('title', e.target.value)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date">
                  <Input type="date" value={draft.date || ''} onChange={(e) => set('date', e.target.value)} />
                </Field>
                <Field label="Hours">
                  <NumberInput value={draft.hours ?? ''} onChange={(e) => set('hours', e.target.value)} placeholder="58.5" />
                </Field>
                <Field label="Type">
                  <Select value={draft.type || 'course'} onValueChange={(v) => set('type', v)} options={TRAINING_TYPES} />
                </Field>
                <Field label="Status">
                  <Select value={draft.status || 'completed'} onValueChange={(v) => set('status', v)} options={TRAINING_STATUS} />
                </Field>
              </div>
              <Field label="Provider">
                <Input value={draft.provider || ''} onChange={(e) => set('provider', e.target.value)} placeholder="MarineNet" />
              </Field>
              <Field label="Notes">
                <Textarea rows={2} value={draft.notes || ''} onChange={(e) => set('notes', e.target.value)} />
              </Field>
              <VisibilityPicker
                value={draft.visibility || DEFAULT_VISIBILITY}
                onChange={(value) => set('visibility', value)}
                unitId={draft.unit_id}
                label="Who sees this development record"
              />
              {(draft.visibility || DEFAULT_VISIBILITY) !== 'personal' && (
                <UnitTargetPicker
                  value={draft.unit_id}
                  onChange={(value) => set('unit_id', value || null)}
                  visibility={draft.visibility || DEFAULT_VISIBILITY}
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
        body="This removes the record and its hours from your totals."
        onConfirm={async () => {
          await deleteRecord('trainings', confirming.id);
          toast.success('Record deleted.');
        }}
      />
    </div>
  );
}
