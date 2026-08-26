import React, { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { errorText } from '@/lib/api';

/** Shared create/edit dialog. `fields` renders the form against a local draft. */
export default function RecordDialog({ title, initial, fields, onSave, onCancel, size = 'md' }) {
  const [draft, setDraft] = useState(initial || {});
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try { await onSave(draft); }
    catch (err) { toast.error(errorText(err)); }
    finally { setSaving(false); }
  };
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onCancel()}
      title={title}
      size={size}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </>
      }
    >
      <div className="space-y-3">{fields(draft, set)}</div>
    </Dialog>
  );
}
