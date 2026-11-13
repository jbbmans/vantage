import { useEffect, useState } from 'react';

export function useBuildWatch(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let loaded: string | null = document.querySelector<HTMLMetaElement>('meta[name="vantage-client-build"]')?.content || null;
    let live = true;
    let pending: AbortController | null = null;
    const check = async () => {
      if (!live || pending || document.visibilityState === 'hidden') return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const res = await fetch('/api/health', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (!res.ok) return;
        const body = await res.json() as { client?: string | null };
        if (!body.client) return;
        if (loaded === null) loaded = body.client;
        else if (body.client !== loaded && live) setReady(true);
        if (live) navigator.serviceWorker?.getRegistration().then((r) => r?.update()).catch(() => undefined);
      } catch { /* offline: nothing to learn */ }
      finally { window.clearTimeout(timeout); if (pending === controller) pending = null; }
    };
    void check();
    const onSw = () => setReady(true);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    window.addEventListener('vantage:update-available', onSw);
    document.addEventListener('visibilitychange', onVisible);
    const timer = window.setInterval(check, 15 * 60_000);
    return () => { live = false; pending?.abort(); window.removeEventListener('vantage:update-available', onSw); document.removeEventListener('visibilitychange', onVisible); window.clearInterval(timer); };
  }, []);
  return ready;
}
