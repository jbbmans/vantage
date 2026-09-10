import { useEffect, useRef, useState } from 'react';
import { captureTimer } from '@/lib/telemetry';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { errorText, type Store } from '@/lib/api';
import { useCreateRecord, useUpdateRecord } from '@/lib/queries';
import { ConflictDialog } from '@/components/ConflictDialog';

/**
 * Generic create/edit dialog. `fields` renders the form given the draft and helpers; the dialog handles
 * saving, stale-version conflicts, field errors, and busy state.
 */
export default function RecordDialog<T extends Record<string, any>>({ store, open, onOpenChange, initial, title, noun, fields, size = 'md', validate, onSaved }: {
  store: Store; open: boolean; onOpenChange: (o: boolean) => void; initial: T | null; title: string; noun: string; size?: 'sm' | 'md' | 'lg';
  fields: (draft: T, set: (k: keyof T & string, v: unknown) => void, errors: Record<string, string>) => React.ReactNode;
  validate?: (draft: T) => string | null; onSaved?: (saved: any) => void;
}) {
  const toast = useToast();
  const create = useCreateRecord(store);
  const update = useUpdateRecord(store);
  const [draft, setDraft] = useState<T | null>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setDraft(initial); setErrors({}); setConflict(null); } }, [open, initial]);
  // The funnel for the full forms, same shape as Quick Log: how it ended, never what was in it.
  const capture = useRef<ReturnType<typeof captureTimer> | null>(null);
  useEffect(() => {
    if (open) capture.current = captureTimer('record_form');
    return () => { capture.current?.abandoned('closed_immediately'); capture.current = null; };
  }, [open]);
  if (!draft) return null;
  const set = (k: keyof T & string, v: unknown) => { setDraft((d) => (d ? { ...d, [k]: v } : d)); setErrors((e) => { if (!e[k]) return e; const n = { ...e }; delete n[k]; return n; }); };
  const save = async (versionOverride?: number) => {
    const problem = validate?.(draft);
    if (problem) {
      capture.current?.abandoned('validation_blocked', { fields_filled: Object.values(draft).filter(Boolean).length });
      capture.current = captureTimer('record_form');
      toast.error(problem);
      return;
    }
    setSaving(true);
    try {
      const saved = draft.id
        ? await update.mutateAsync({ id: draft.id, patch: { ...draft, version: versionOverride ?? draft.version } })
        : await create.mutateAsync(draft);
      capture.current?.completed({
        had_measure: draft.quantity != null || draft.dollar_amount != null,
        had_outcome: Boolean(draft.result),
        ai_assisted: false,
        source: 'manual',
      });
      capture.current = null;
      toast.success(`${noun} ${draft.id ? 'updated' : 'added'}.`);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err: any) {
      if (err?.status === 409 && err?.code === 'stale' && err?.extra?.current) setConflict(err.extra.current);
      else {
        capture.current?.abandoned('save_failed');
        capture.current = captureTimer('record_form');
        setErrors(err?.fieldErrors || {});
        toast.error(errorText(err));
      }
    } finally { setSaving(false); }
  };
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange} title={title} size={size} footer={<><Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button><Button variant="primary" onClick={() => save()} loading={saving}>{draft.id ? 'Save changes' : `Add ${noun.toLowerCase()}`}</Button></>}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>{fields(draft, set, errors)}<button type="submit" className="hidden" aria-hidden /></form>
      </Dialog>
      <ConflictDialog conflict={conflict} onClose={() => setConflict(null)} onOverwrite={() => { const v = conflict.version; setConflict(null); save(v); }} onReload={() => { setDraft({ ...draft, ...conflict }); setConflict(null); }} />
    </>
  );
}
