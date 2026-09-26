import { useEffect } from 'react';

export interface RecentItem { to: string; title: string; kind: 'entry' | 'case' | 'marine' }

const MAX = 8;
const keyFor = (userId: string) => `vantage.recent.${userId}`;

export function recentVisits(userId: string | undefined): RecentItem[] {
  if (!userId) return [];
  try { return (JSON.parse(localStorage.getItem(keyFor(userId)) || '[]') as RecentItem[]).slice(0, MAX); } catch { return []; }
}

/** Remembers what this person opened, on this device only, so search can offer it back. */
export function useRememberVisit(userId: string | undefined, item: RecentItem | null) {
  const to = item?.to; const title = item?.title; const kind = item?.kind;
  useEffect(() => {
    if (!userId || !to || !title || !kind) return;
    try {
      const next = [{ to, title, kind }, ...recentVisits(userId).filter((r) => r.to !== to)].slice(0, MAX);
      localStorage.setItem(keyFor(userId), JSON.stringify(next));
    } catch { /* private mode */ }
  }, [userId, to, title, kind]);
}
