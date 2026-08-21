import React, { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/primitives';

/** Shared create/edit dialog. `fields` renders the form against a local draft. */
export default function RecordDialog({ title, initial, fields, onSave, onCancel, size = 'md' }) {
  const [draft, setDraft] = useState(initial || {});
  const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onCancel()}
      title={title}
      size={size}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => onSave(draft)}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">{fields(draft, set)}</div>
    </Dialog>
  );
}
