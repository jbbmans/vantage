import { useEffect, useState } from 'react';

/**
 * Whether a newer build of Vantage is being served than the one this tab loaded.
 *
 * Two signals, because either can miss: the service worker reporting an installed update, and the
 * server's own report of the client build it serves (the hash of its index.html, the same value the
 * build stamps into sw.js). The second is checked when the tab regains focus and every 15 minutes,
 * so a copy left open all day still learns a release happened.
 */
export function useBuildWatch(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let loaded: string | null = null;
    let live = true;
    const check = async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) return;
        const body = await res.json() as { client?: string | null };
        if (!body.client) return;
        if (loaded === null) loaded = body.client;
        else if (body.client !== loaded && live) setReady(true);
        navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => undefined);
      } catch { /* offline: nothing to learn */ }
    };
    void check();
    const onSw = () => setReady(true);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('vantage:update-available', onSw);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(check, 15 * 60_000);
    return () => { live = false; window.removeEventListener('vantage:update-available', onSw); document.removeEventListener('visibilitychange', onVisible); window.clearInterval(timer); };
  }, []);
  return ready;
}
