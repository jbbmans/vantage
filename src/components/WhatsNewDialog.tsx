import { useCallback, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { CHANGES, LATEST_CHANGE } from '@/config/changes';
import { formatDate } from '../../shared/metrics';
import { VERSION } from '@/lib/version';

const SEEN = 'vantage.seen-changes';

/**
 * Whether there is something newer than this person last read. Somebody who joined after the newest change has nothing
 * to catch up on, so the mark is for people who were here before it.
 */
export function useWhatsNew(joined?: string | null) {
  const [seen, setSeen] = useState<string | null>(() => { try { return localStorage.getItem(SEEN); } catch { return null; } });
  const unseen = seen ? seen < LATEST_CHANGE : Boolean(joined && joined.slice(0, 10) < LATEST_CHANGE);
  const markSeen = useCallback(() => {
    try { localStorage.setItem(SEEN, LATEST_CHANGE); } catch { /* a private window keeps the mark; it is only a mark */ }
    setSeen(LATEST_CHANGE);
  }, []);
  return { unseen, markSeen };
}

export default function WhatsNewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="What’s new" description={`Vantage v${VERSION}. The latest changes, newest first.`}>
      <ol className="space-y-6 pb-2">
        {CHANGES.map((change) => (
          <li key={change.date}>
            <h3 className="flex items-baseline gap-2 text-sm font-semibold text-ink">
              {change.title}
              <time dateTime={change.date} className="fig text-xs font-normal text-ink-3">{formatDate(change.date, 'd MMMM yyyy')}</time>
            </h3>
            <ul className="mt-2 space-y-2 text-sm leading-relaxed text-ink-2">
              {change.items.map((item) => (
                <li key={item} className="flex gap-2.5"><span className="mt-[.6rem] h-1 w-1 shrink-0 rounded-full bg-accent" aria-hidden />{item}</li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Dialog>
  );
}
