import { useEffect, useRef, useState } from 'react';
import { captureTimer } from '@/lib/telemetry';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { errorText, type Store } from '@/lib/api';
import { useCreateRecord, useUpdateRecord } from '@/lib/queries';
import { ConflictDialog } from '@/components/ConflictDialog';

type Problem = string | { message: string; fieldErrors: Record<string, string> } | null;

/**
 * One way to save the form, as its own button: a counseling saves as a draft, is shared with its Marine, or is finalized
 * (ADR-0027). `patch` goes with the save; `then` runs on what was saved, as the next step. Enter in a field takes the first.
 */
export interface SaveAction<T> { label: string; done: string; variant?: 'primary' | 'default'; patch?: Partial<T>; check?: (draft: T) => Problem; then?: (saved: any) => Promise<any> }

export default function RecordDialog<T extends Record<string, any>>({ store, open, onOpenChange, initial, title, noun, fields, size = 'md', validate, onSaved, actions, note }: {
  store: Store; open: boolean; onOpenChange: (o: boolean) => void; initial: T | null; title: string; noun: string; size?: 'sm' | 'md' | 'lg';
  fields: (draft: T, set: (k: keyof T & string, v: unknown) => void, errors: Record<string, string>) => React.ReactNode;
  /** What stops the save, in words, or with the fields it is about (a timeframe out of order marks its end date). */
  validate?: (draft: T) => Problem; onSaved?: (saved: any) => void;
  /** The ways to save, in place of the one Save button. */
  actions?: Array<SaveAction<T>>;
  /** A line beside the buttons: what saving does. */
  note?: React.ReactNode;
}) {
  const toast = useToast();
  const create = useCreateRecord(store);
  const update = useUpdateRecord(store);
  const [draft, setDraft] = useState<T | null>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<any>(null);
  const [saving, setSaving] = useState<string | null>(null);
  // The action a conflict interrupted, so overwriting finishes what was asked.
  const pending = useRef<SaveAction<T> | undefined>(undefined);
  useEffect(() => { if (open) { setDraft(initial); setErrors({}); setConflict(null); } }, [open, initial]);
  const capture = useRef<ReturnType<typeof captureTimer> | null>(null);
  useEffect(() => {
    if (open) capture.current = captureTimer('record_form');
    return () => { capture.current?.abandoned('closed_immediately'); capture.current = null; };
  }, [open]);
  if (!draft) return null;
  const set = (k: keyof T & string, v: unknown) => { setDraft((d) => (d ? { ...d, [k]: v } : d)); setErrors((e) => { if (!e[k]) return e; const n = { ...e }; delete n[k]; return n; }); };
  const save = async (versionOverride?: number, action: SaveAction<T> | undefined = actions?.[0]) => {
    const problem = validate?.(draft) || action?.check?.(draft);
    if (problem) {
      capture.current?.abandoned('validation_blocked', { fields_filled: Object.values(draft).filter(Boolean).length });
      capture.current = captureTimer('record_form');
      if (typeof problem === 'string') toast.error(problem);
      else { setErrors(problem.fieldErrors); toast.error(problem.message); }
      return;
    }
    setSaving(action?.label ?? 'save');
    pending.current = action;
    try {
      const body = { ...draft, ...action?.patch };
      let saved = draft.id
        ? await update.mutateAsync({ id: draft.id, patch: { ...body, version: versionOverride ?? draft.version } })
        : await create.mutateAsync(body);
      if (action?.then) {
        // What was saved stays saved if the next step is refused: the form carries on from it, at its new version.
        try { saved = await action.then(saved); }
        catch (err: any) { setDraft((d) => (d ? { ...d, id: saved.id, version: saved.version } : d)); setErrors(err?.fieldErrors || {}); toast.error(errorText(err)); onSaved?.(saved); return; }
      }
      capture.current?.completed({
        had_measure: draft.quantity != null || draft.dollar_amount != null,
        had_outcome: Boolean(draft.result),
        ai_assisted: false,
        source: 'manual',
      });
      capture.current = null;
      toast.success(action?.done ?? `${noun} ${draft.id ? 'updated' : 'added'}.`);
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
    } finally { setSaving(null); }
  };
  const busy = saving !== null;
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange} title={title} size={size} footer={<>{note && <span className="mr-auto basis-full text-xs text-ink-3 sm:basis-auto">{note}</span>}<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
        {actions ? actions.map((a) => <Button key={a.label} variant={a.variant ?? 'default'} onClick={() => save(undefined, a)} loading={saving === a.label} disabled={busy && saving !== a.label}>{a.label}</Button>)
          : <Button variant="primary" onClick={() => save()} loading={busy}>{draft.id ? 'Save changes' : `Add ${noun.toLowerCase()}`}</Button>}</>}>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); save(); }}>{fields(draft, set, errors)}<button type="submit" className="hidden" aria-hidden /></form>
      </Dialog>
      <ConflictDialog conflict={conflict} onClose={() => setConflict(null)} onOverwrite={() => { const v = conflict.version; setConflict(null); save(v, pending.current); }} onReload={() => { setDraft({ ...draft, ...conflict }); setConflict(null); }} />
    </>
  );
}
