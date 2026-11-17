import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from '@/components/ui/Dialog';
import { Skeleton } from '@/components/ui/primitives';
import { QueryFailure } from '@/components/QueryFailure';
import { formatDate } from '../../shared/metrics';
import { VERSION } from '@/lib/version';

const SEEN = 'vantage.seen-changes';

/**
 * The list of changes, read after the page has drawn rather than with it: it is long, and every page would otherwise
 * carry it in its first load for a dialog most visits never open. One read serves the mark and the dialog.
 */
function useChanges() {
  return useQuery({
    queryKey: ['whats-new'],
    queryFn: () => import('@/config/changes').then((m) => ({ changes: m.CHANGES, latest: m.LATEST_CHANGE })),
    staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false, retry: false,
  });
}

/**
 * Whether there is something newer than this person last read. Somebody who joined after the newest change has nothing
 * to catch up on, so the mark is for people who were here before it. Until the list has been read, nothing is marked.
 */
export function useWhatsNew(joined?: string | null) {
  const latest = useChanges().data?.latest ?? null;
  const [seen, setSeen] = useState<string | null>(() => { try { return localStorage.getItem(SEEN); } catch { return null; } });
  const unseen = latest ? (seen ? seen < latest : Boolean(joined && joined.slice(0, 10) < latest)) : false;
  // Opened before the list arrived, it is marked read once it has: the dialog shows it as soon as it does.
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (!opened || !latest) return;
    try { localStorage.setItem(SEEN, latest); } catch { /* a private window keeps the mark; it is only a mark */ }
    setSeen(latest);
    setOpened(false);
  }, [opened, latest]);
  const markSeen = useCallback(() => setOpened(true), []);
  return { unseen, markSeen };
}

export default function WhatsNewDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const list = useChanges();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="What’s new" description={`Vantage v${VERSION}. The latest changes, newest first.`}>
      {list.isPending ? <div className="space-y-3 pb-2" aria-busy="true"><Skeleton className="h-5 w-2/3" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>
        : list.isError ? <QueryFailure error={list.error} onRetry={() => list.refetch()} what="The list of changes" />
          : (
            <ol className="space-y-6 pb-2">
              {list.data.changes.map((change) => (
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
          )}
    </Dialog>
  );
}
