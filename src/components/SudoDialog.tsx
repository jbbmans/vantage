import { useState } from 'react';
import { CreditCard } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Field, Input } from '@/components/ui/primitives';
import * as api from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { keys, useIdentity } from '@/lib/queries';

/**
 * Confirms it is you before a sensitive change, for ten minutes: with your password, or with your CAC where one is linked
 * to your account (ADR-0009). An account with neither, such as one the organization's sign-in created, signs in again.
 */
export default function SudoDialog({ open, onOpenChange, onConfirmed }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirmed: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  // Older servers did not say; a password is what they took.
  const ways = identity?.session.stepUp ?? ['password'];
  const byPassword = ways.includes('password');
  const byCard = ways.includes('cac');
  const confirmed = () => { setPassword(''); qc.invalidateQueries({ queryKey: keys.me }); onConfirmed(); };
  const attempt = async (step: () => Promise<unknown>) => {
    setBusy(true); setError('');
    try { await step(); confirmed(); }
    catch (err) { setError(api.errorText(err)); }
    finally { setBusy(false); }
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); void attempt(() => api.sudo(password)); };
  const description = byPassword && byCard ? 'Sensitive settings ask for your password or your CAC again. This lasts ten minutes.'
    : byCard ? 'Sensitive settings ask for your CAC again. Put your card in the reader; your browser asks for your PIN. This lasts ten minutes.'
      : byPassword ? 'Sensitive settings ask for your password again. This lasts ten minutes.'
        : 'Your account has no password or card to confirm with here. Sign out and sign in again; a fresh sign-in counts for ten minutes.';
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Confirm it is you" description={description} size="sm">
      <form onSubmit={submit} className="space-y-3">
        {byPassword && <Field label="Current password" error={error}><Input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>}
        {!byPassword && error && <p role="alert" className="text-sm text-bad">{error}</p>}
        {byCard && <Button type="button" variant={byPassword ? 'outline' : 'primary'} className="w-full" loading={busy && !byPassword} disabled={busy} onClick={() => void attempt(api.cacStepUp)}><CreditCard className="h-4 w-4" /> Confirm with your CAC</Button>}
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>{byPassword && <Button type="submit" variant="primary" loading={busy} disabled={!password}>Confirm</Button>}</div>
      </form>
    </Dialog>
  );
}

export interface SudoRequest { confirm: () => void; cancel: () => void }
const waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
const settle = (ok: boolean) => { const list = waiters.splice(0, waiters.length); for (const w of list) { if (ok) w.resolve(); else w.reject(new Error('Confirmation cancelled.')); } };

export async function withSudo<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if ((error as { code?: string })?.code !== 'sudo_required') throw error;
    await new Promise<void>((resolve, reject) => {
      waiters.push({ resolve, reject });
      if (waiters.length === 1) window.dispatchEvent(new CustomEvent<SudoRequest>('vantage:sudo-required', { detail: { confirm: () => settle(true), cancel: () => settle(false) } }));
    });
    return action();
  }
}
