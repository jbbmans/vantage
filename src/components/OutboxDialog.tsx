import { useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/primitives';
import { outbox, onOutboxChange, type OutboxItem } from '@/lib/outbox';
import { timeAgo } from '@/lib/utils';

/** What is waiting on this device to reach the server, why the server refused any of it, and a way to let it go. */
export default function OutboxDialog({ open, onOpenChange, userId, onRetry }: { open: boolean; onOpenChange: (o: boolean) => void; userId: string; onRetry: () => Promise<void> }) {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState('');
  useEffect(() => {
    if (!open) return;
    const load = () => { outbox.list(userId).then(setItems); };
    load();
    return onOutboxChange(load);
  }, [open, userId]);
  const retry = async () => { setBusy(true); try { await onRetry(); } finally { setBusy(false); } };
  const title = (item: OutboxItem) => String(item.payload.title || 'Untitled entry');
  return (
    <Dialog open={open} onOpenChange={(o) => { setDiscarding(''); onOpenChange(o); }} title="Waiting to sync" size="md"
      description="Entries saved on this device while it was offline. They send themselves once the connection is back."
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button><Button variant="primary" onClick={retry} loading={busy} disabled={!items.length}><RefreshCw className="h-4 w-4" />Try again now</Button></>}>
      {!items.length ? <p className="text-sm text-ink-3">Nothing is waiting. Everything reached the server.</p> : (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">{title(item)}</span>
                <span className="block text-xs text-ink-3">{item.payload.date ? `Dated ${String(item.payload.date)} · ` : ''}saved {timeAgo(item.createdAt)}</span>
                {item.lastError && <span className="mt-0.5 block text-xs text-bad">The server refused it: {item.lastError}</span>}
              </span>
              {discarding === item.id
                ? <Button size="xs" variant="danger" onClick={() => { setDiscarding(''); outbox.remove(item.id); }}>Discard for good</Button>
                : <Button size="xs" variant="ghost" aria-label={`Discard ${title(item)}`} onClick={() => setDiscarding(item.id)}><Trash2 className="h-3.5 w-3.5" />Discard</Button>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
