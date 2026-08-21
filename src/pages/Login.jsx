import React, { useEffect, useState } from 'react';
import { ShieldCheck, LogIn, Loader2 } from 'lucide-react';
import { needsSetup, runSetup } from '@/lib/api';
import { signIn } from '@/store/useStore';
import { Button, Input, Field, Select } from '@/components/ui/primitives';

/**
 * Sign-in, and first-run setup when the database is empty.
 *
 * Setup only appears when there are genuinely no users. Once someone exists,
 * this endpoint is closed — an open bootstrap route is how a fresh deployment
 * gets an uninvited administrator.
 */
export default function Login() {
  const [mode, setMode] = useState('checking');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [setupForm, setSetupForm] = useState({
    first_name: '', last_name: '', rank_id: 'Cpl', mos: '',
    unit_code: 'CE-G8', billet_title: 'Financial Management Resource Analyst',
  });

  useEffect(() => {
    needsSetup()
      .then((r) => setMode(r.needsSetup ? 'setup' : 'login'))
      .catch(() => setMode('login'));
  }, []);

  const submit = async (e) => {
    e?.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'setup') {
        await runSetup({ username, password, ...setupForm });
      }
      await signIn(username, password);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k) => (e) => setSetupForm((f) => ({ ...f, [k]: e.target?.value ?? e }));

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink p-4">
      <form onSubmit={submit} className="panel w-full max-w-sm rounded p-5">
        <div className="flex items-center gap-2 border-b border-rule pb-3">
          <ShieldCheck className="h-4 w-4 text-signal" />
          <span className="font-mono text-sm font-semibold tracking-[0.2em] text-text">VANTAGE</span>
        </div>

        <h1 className="mt-4 text-lg font-semibold text-text">
          {mode === 'setup' ? 'Set up this command' : 'Sign in'}
        </h1>
        <p className="mt-1 text-xs leading-relaxed text-text-3">
          {mode === 'setup'
            ? 'No accounts exist yet. This creates the first administrator, who can then add the rest of the section.'
            : 'Performance records are held per-account. Ask your section lead if you need one.'}
        </p>

        <div className="mt-4 space-y-3">
          <Field label="Username">
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          </Field>
          <Field label="Password" hint={mode === 'setup' ? '10 characters minimum — a passphrase beats a password' : undefined}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            />
          </Field>

          {mode === 'setup' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="First name">
                  <Input value={setupForm.first_name} onChange={set('first_name')} />
                </Field>
                <Field label="Last name">
                  <Input value={setupForm.last_name} onChange={set('last_name')} />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Rank">
                  <Input value={setupForm.rank_id} onChange={set('rank_id')} placeholder="Cpl" />
                </Field>
                <Field label="MOS">
                  <Input value={setupForm.mos} onChange={set('mos')} placeholder="3451" />
                </Field>
              </div>
              <Field label="Unit code" hint="MARFORRES units are pre-loaded; CE-G8 is the comptroller section">
                <Input value={setupForm.unit_code} onChange={set('unit_code')} />
              </Field>
            </>
          )}
        </div>

        {error && <p className="mt-3 text-xs leading-relaxed text-redline">{error}</p>}

        <Button
          type="submit"
          variant="primary"
          size="md"
          className="mt-4 w-full justify-center"
          disabled={busy || mode === 'checking' || !username || !password}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
          {mode === 'setup' ? 'Create account and sign in' : 'Sign in'}
        </Button>

        <p className="fig mt-4 border-t border-rule pt-3 text-2xs leading-relaxed text-text-3">
          VANTAGE · BUILT BY JOHN BERNARD BOLETZ
          <br />
          RECORDS ARE HELD ON THE SERVER THIS PAGE WAS SERVED FROM. NOTHING IS SENT ANYWHERE ELSE.
        </p>
      </form>
    </div>
  );
}
