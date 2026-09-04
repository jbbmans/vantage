import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/primitives';

export function ConflictDialog({ conflict, onClose, onOverwrite, onReload }: { conflict: any; onClose: () => void; onOverwrite: () => void; onReload: () => void }) {
  return (
    <Dialog open={Boolean(conflict)} onOpenChange={(o) => { if (!o) onClose(); }} title="This record changed while you were editing" size="sm" footer={<><Button variant="ghost" onClick={onReload}>Load the newest copy</Button><Button variant="primary" onClick={onOverwrite}>Overwrite with mine</Button></>}>
      <p className="text-sm leading-relaxed text-ink-2">Someone saved a newer version{conflict?.updated_at ? ` at ${new Date(conflict.updated_at).toLocaleString()}` : ''}. Load it to review their change, or overwrite it with what you have on screen.</p>
    </Dialog>
  );
}
