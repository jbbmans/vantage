import React, { useMemo, useState } from 'react';
import { Plus, Trash2, Award, Quote } from 'lucide-react';
import { useRecognitions, createRecord, updateRecord, deleteRecord } from '@/store/useStore';
import { RECOGNITION_TYPES } from '@/lib/constants';
import { formatDTG, formatNumber } from '@/lib/metrics';
import { useToast } from '@/components/ui/toast';
import { ConfirmDialog } from '@/components/ui/Dialog';
import RecordDialog from '@/components/RecordDialog';
import { Figure, FigureRow } from '@/components/Figure';
import {
  Panel, EmptyState, Button, Input, Textarea, Select, Field, Badge,
} from '@/components/ui/primitives';

const TYPE_TONE = { award: 'signal', loa: 'ledger', certificate: 'info', commendation: 'signal' };

export default function Recognition() {
  const recognitions = useRecognitions();
  const toast = useToast();
  const [dialog, setDialog] = useState(null);
  const [confirming, setConfirming] = useState(null);

  const sorted = useMemo(
    () => [...recognitions].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    [recognitions]
  );

  const counts = useMemo(() => {
    const by = {};
    for (const r of recognitions) by[r.type] = (by[r.type] || 0) + 1;
    return by;
  }, [recognitions]);

  const save = async (draft) => {
    if (!draft.title?.trim()) return toast.error('Give the recognition a title.');
    if (draft.id) await updateRecord('recognitions', draft.id, draft);
    else await createRecord('recognitions', { type: 'award', ...draft });
    toast.success(draft.id ? 'Record updated.' : 'Recognition added.');
    setDialog(null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h3 className="text-xl font-semibold text-text">Recognition</h3><p className="mt-1 text-sm text-text-3">Awards, letters, certificates, and written feedback.</p></div>
        <Button variant="primary" size="sm" onClick={() => setDialog({})}>
          <Plus className="h-3.5 w-3.5" />
          Add recognition
        </Button>
      </div>

      <FigureRow>
        <Figure label="Total" raw={recognitions.length} formatFn={(n) => formatNumber(Math.round(n))} sub="all records" />
        <Figure label="Awards" raw={counts.award || 0} formatFn={(n) => formatNumber(Math.round(n))} tone="signal" sub="formal awards" />
        <Figure label="Letters" raw={counts.loa || 0} formatFn={(n) => formatNumber(Math.round(n))} sub="LOAs received" />
        <Figure label="Certificates" raw={counts.certificate || 0} formatFn={(n) => formatNumber(Math.round(n))} sub="certificates" />
      </FigureRow>

      {sorted.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Award}
            title="Nothing recorded yet"
            description="Log awards, letters of appreciation, and written feedback while you still have the source. They are hard to reconstruct a year later."
            action={<Button size="sm" onClick={() => setDialog({})}>Add recognition</Button>}
          />
        </Panel>
      ) : (
        <div className="relative">
          {/* a single hairline running the length of the record */}
          <div className="absolute bottom-2 left-[70px] top-2 w-px bg-rule" aria-hidden />
          <div className="space-y-2">
            {sorted.map((r) => (
              <div key={r.id} className="relative flex gap-3">
                <span className="fig w-14 shrink-0 pt-2.5 text-right text-2xs text-text-3">{formatDTG(r.date)}</span>
                <span className="relative z-10 mt-3 h-1.5 w-1.5 shrink-0 rounded-full bg-signal ring-4 ring-ink" />
                <Panel className="min-w-0 flex-1" bodyClassName="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h3 className="text-md font-medium text-text">{r.title}</h3>
                      <p className="mt-0.5 text-xs text-text-3">
                        {[r.from, r.organization].filter(Boolean).join(' · ') || 'Source not recorded'}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Badge tone={TYPE_TONE[r.type] || 'neutral'}>{r.type}</Badge>
                      <Button variant="ghost" size="sm" onClick={() => setDialog(r)}>Edit</Button>
                      <button onClick={() => setConfirming(r)} className="text-text-3 hover:text-redline">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {r.notes && (
                    <p className="mt-2 flex gap-2 border-l-2 border-signal/40 pl-2.5 text-sm italic leading-relaxed text-text-2">
                      <Quote className="mt-0.5 h-3 w-3 shrink-0 text-signal/50" />
                      {r.notes}
                    </p>
                  )}
                </Panel>
              </div>
            ))}
          </div>
        </div>
      )}

      {dialog && (
        <RecordDialog
          title={dialog.id ? 'Edit recognition' : 'Add recognition'}
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
                <Field label="Type">
                  <Select value={draft.type || 'award'} onValueChange={(v) => set('type', v)} options={RECOGNITION_TYPES} />
                </Field>
                <Field label="From">
                  <Input value={draft.from || ''} onChange={(e) => set('from', e.target.value)} placeholder="Name or billet" />
                </Field>
                <Field label="Organization">
                  <Input value={draft.organization || ''} onChange={(e) => set('organization', e.target.value)} />
                </Field>
              </div>
              <Field label="Notes" hint="paste the citation or the exact wording while you have it">
                <Textarea rows={4} value={draft.notes || ''} onChange={(e) => set('notes', e.target.value)} />
              </Field>
            </>
          )}
        />
      )}

      <ConfirmDialog
        open={!!confirming}
        onOpenChange={(v) => !v && setConfirming(null)}
        title={`Delete "${confirming?.title}"?`}
        body="This removes the record permanently."
        onConfirm={async () => {
          await deleteRecord('recognitions', confirming.id);
          toast.success('Deleted.');
        }}
      />
    </div>
  );
}
