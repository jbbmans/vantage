import { useState } from 'react';
import { KeyRound, LogOut } from 'lucide-react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { keys, queryClient, signOutEverywhere, useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';
import { passwordProblem, MIN_PASSWORD_LENGTH } from '../../shared/password';

/** Shown instead of the app while a temporary password is in force: the only thing the server allows is choosing a real one. */
export default function ForcePasswordChange() {
  const { data: identity } = useIdentity();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const problem = next ? passwordProblem(next) : null;
  const submit = async () => {
    setError('');
    if (problem) { setError(problem); return; }
    if (next !== confirm) { setError('The two passwords do not match.'); return; }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      toast.success('Password set. Welcome to Vantage.');
      await queryClient.invalidateQueries({ queryKey: keys.me });
    } catch (e) { setError(api.errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-3"><img src="/mark.svg" alt="" width={40} height={40} className="h-10 w-10" /><div><p className="text-[13px] font-bold tracking-[0.18em] text-ink">VANTAGE</p><p className="text-2xs text-ink-3">{identity ? `${identity.user.first_name} ${identity.user.last_name}` : ''}</p></div></div>
        <div className="card p-6 shadow-pop sm:p-8">
          <h1 className="display text-[28px] font-medium leading-tight text-ink">Choose your own password</h1>
          <p className="mt-1.5 text-sm text-ink-3">You signed in with a temporary password issued by a leader. Vantage stays locked until you replace it.</p>
          {error && <p role="alert" className="mt-4 rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-sm text-bad">{error}</p>}
          <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Field label="Temporary password"><Input type="password" autoFocus required autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
            <Field label="New password" hint={`${MIN_PASSWORD_LENGTH}+ characters`} error={next ? problem : null}><Input type="password" required autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
            <Field label="Confirm new password" error={confirm && confirm !== next ? 'Does not match.' : null}><Input type="password" required autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}><KeyRound className="h-4 w-4" />Set password and continue</Button>
          </form>
          <button type="button" onClick={() => signOutEverywhere()} className="mt-4 flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink"><LogOut className="h-3.5 w-3.5" />Sign out instead</button>
        </div>
      </div>
    </div>
  );
}
