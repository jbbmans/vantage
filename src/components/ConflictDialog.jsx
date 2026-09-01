import React from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/primitives';

export default function ConflictDialog({ noun, current, saving = false, onLoadNewest, onOverwrite, onDismiss }) {
  if (!current) return null;
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onDismiss()}
      title={`This ${noun} changed while you were editing`}
      description="Someone saved a newer copy after you opened it. Nothing was overwritten."
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onLoadNewest}>Load the newest copy</Button>
          <Button size="sm" disabled={saving} onClick={onOverwrite}>Overwrite with mine</Button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-text-2">
        Newest copy: <span className="text-text">&ldquo;{current.title || current.name}&rdquo;</span>
        <span className="fig ml-1.5 text-2xs text-text-3">version {current.version}</span>
      </p>
    </Dialog>
  );
}
