import { useState } from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Field, Input } from '@/components/ui/primitives';
import * as api from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import { keys } from '@/lib/queries';

export default function SudoDialog({ open, onOpenChange, onConfirmed }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirmed: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await api.sudo(password); setPassword(''); qc.invalidateQueries({ queryKey: keys.me }); onConfirmed(); }
    catch (err) { setError(api.errorText(err)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Confirm it is you" description="Sensitive settings ask for your password again. This lasts ten minutes." size="sm">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Current password" error={error}><Input type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" variant="primary" loading={busy} disabled={!password}>Confirm</Button></div>
      </form>
    </Dialog>
  );
}

export interface SudoRequest { confirm: () => void; cancel: () => void }
const waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
const settle = (ok: boolean) => { const list = waiters.splice(0, waiters.length); for (const w of list) { if (ok) w.resolve(); else w.reject(new Error('Confirmation cancelled.')); } };

/** Run an action; if the server demands step-up auth, open the sudo dialog (once, for every concurrent caller) and retry. */
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
