import React, { useState } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import * as apiClient from '@/lib/api';
import { hydrate } from '@/store/useStore';
import { Button, Field, Input } from '@/components/ui/primitives';

/** The server blocks every other authenticated route until this succeeds. */
export default function PasswordChangeRequired() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (next !== confirm) return setError('The new passwords do not match.');
    setBusy(true);
    try {
      await apiClient.changePassword(current, next);
      await hydrate();
    } catch (err) {
      setError(apiClient.errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-ink p-4">
      <form onSubmit={submit} className="panel w-full max-w-sm rounded p-5">
        <div className="flex items-center gap-2 border-b border-rule pb-3">
          <KeyRound className="h-4 w-4 text-signal" />
          <span className="font-mono text-sm font-semibold tracking-[0.16em] text-text">PASSWORD CHANGE REQUIRED</span>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-text-2">
          An Instance Operator issued a temporary password. Replace it before opening any records.
        </p>
        <div className="mt-4 space-y-3">
          <Field label="Temporary password">
            <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
          </Field>
          <Field label="New password" hint="At least 15 characters; use a unique passphrase">
            <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="Confirm new password">
            <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        </div>
        {error && <p className="mt-3 text-xs leading-relaxed text-redline">{error}</p>}
        <Button type="submit" variant="primary" className="mt-4 w-full justify-center"
          disabled={busy || !current || next.length < 15 || !confirm}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
          Set new password
        </Button>
      </form>
    </div>
  );
}
