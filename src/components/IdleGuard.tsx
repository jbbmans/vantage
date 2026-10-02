import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/primitives';
import * as api from '@/lib/api';

/** How long before an idle sign-out the person is asked whether they are still there. */
const WARN_MS = 2 * 60_000;

/**
 * A session ends after a short idle period. Rather than let the next click fail and lose what was being typed, this
 * asks first, two minutes before, and signs out cleanly when the time is up.
 */
export default function IdleGuard({ onSignOut }: { onSignOut: () => void }) {
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onExpiry = (e: Event) => { const at = (e as CustomEvent<number>).detail; if (Number.isFinite(at)) setExpiresAt(at); };
    window.addEventListener('vantage:session-expires', onExpiry);
    return () => window.removeEventListener('vantage:session-expires', onExpiry);
  }, []);

  useEffect(() => {
    if (!expiresAt) return;
    const tick = () => setNow(Date.now());
    const until = expiresAt - WARN_MS - Date.now();
    // Sleep until the warning is due, then count down each second while it shows.
    const t = until > 0 ? window.setTimeout(tick, until) : window.setInterval(tick, 1000);
    return () => { window.clearTimeout(t); window.clearInterval(t); };
  }, [expiresAt, now]);

  useEffect(() => { if (expiresAt && now >= expiresAt) onSignOut(); }, [expiresAt, now, onSignOut]);

  const left = expiresAt ? expiresAt - now : Infinity;
  const open = left <= WARN_MS && left > 0;
  const seconds = Math.max(0, Math.ceil(left / 1000));
  const stay = () => { api.me().catch(() => {}); };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) stay(); }} title="Still there?" size="sm"
      description="Vantage signs you out after a period with no activity, as systems holding personnel records must."
      footer={<><Button variant="ghost" onClick={onSignOut}>Sign out</Button><Button onClick={stay}>Stay signed in</Button></>}>
      <p className="text-sm text-ink-2">You will be signed out in <span className="fig font-semibold text-ink">{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>. Anything you are typing in Quick Log is kept for this tab.</p>
    </Dialog>
  );
}
