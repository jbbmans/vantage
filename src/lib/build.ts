import { useEffect, useState } from 'react';

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
