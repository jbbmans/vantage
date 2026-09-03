import { useEffect, useState } from 'react';
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
  if (!draft) return null;
  const set = (k: keyof T & string, v: unknown) => { setDraft((d) => (d ? { ...d, [k]: v } : d)); setErrors((e) => { if (!e[k]) return e; const n = { ...e }; delete n[k]; return n; }); };
  const save = async (versionOverride?: number) => {
    const problem = validate?.(draft);
    if (problem) { toast.error(problem); return; }
    setSaving(true);
    try {
      const saved = draft.id
        ? await update.mutateAsync({ id: draft.id, patch: { ...draft, version: versionOverride ?? draft.version } })
        : await create.mutateAsync(draft);
      toast.success(`${noun} ${draft.id ? 'updated' : 'added'}.`);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err: any) {
      if (err?.status === 409 && err?.code === 'stale' && err?.extra?.current) setConflict(err.extra.current);
      else { setErrors(err?.fieldErrors || {}); toast.error(errorText(err)); }
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
