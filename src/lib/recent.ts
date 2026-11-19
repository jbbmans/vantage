import { useEffect } from 'react';

export interface RecentItem { to: string; title: string; kind: 'entry' | 'case' | 'marine' }

const MAX = 8;
const PREFIX = 'vantage.recent.';
const keyFor = (userId: string) => `${PREFIX}${userId}`;

/**
 * Forgets every list of what was opened on this device. Titles, case references and Marines' names are not left for the
 * next person at a shared workstation once the session ends: on sign-out, or when the server ends the session.
 */
export function clearRecentVisits() {
  for (const storage of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      const keys: string[] = [];
      for (let i = 0; i < storage.length; i += 1) { const k = storage.key(i); if (k && k.startsWith(PREFIX)) keys.push(k); }
      for (const k of keys) storage.removeItem(k);
    } catch { /* private mode */ }
  }
}

export function recentVisits(userId: string | undefined): RecentItem[] {
  if (!userId) return [];
  try { return (JSON.parse(localStorage.getItem(keyFor(userId)) || '[]') as RecentItem[]).slice(0, MAX); } catch { return []; }
}

/** Remembers what this person opened, on this device only and until the session ends, so search can offer it back. */
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

/** Drops something this person can no longer open (deleted, or their access changed). */
export function useForgetVisit(userId: string | undefined, to: string, gone: boolean) {
  useEffect(() => {
    if (!userId || !gone) return;
    try { localStorage.setItem(keyFor(userId), JSON.stringify(recentVisits(userId).filter((r) => r.to !== to))); } catch { /* private mode */ }
  }, [userId, to, gone]);
}
