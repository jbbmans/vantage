import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { keys, useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';
import { EDIPI_PATTERN, counselorWritten } from '../../shared/counseling';

/**
 * The EDIPI a person's counseling worksheets print in their EDIPI box (ADR-0033): the one on their account, else one
 * they type here, which saves to their own profile. Only they set it (John, 2026-11-17: "Each person types their own"),
 * it is never used to sign in, and the page is only ever told its last four digits.
 */

/** Whether one is a party to a counseling's worksheet, so its EDIPI box is one's own: its Marine, or its counselor. */
export const ownsEdipiBox = (row: { user_id: string; counselor_id?: string | null }, me: string | undefined) =>
  Boolean(me && (row.user_id === me || (counselorWritten({ user_id: row.user_id, counselor_id: row.counselor_id ?? null }) && row.counselor_id === me)));

export function EdipiForm({ onSaved, submitLabel = 'Save EDIPI', autoFocus }: { onSaved?: () => void; submitLabel?: string; autoFocus?: boolean }) {
  const { data: identity } = useIdentity();
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const onFile = identity?.user.edipi_on_file ?? null;
  if (onFile?.source === 'account') {
    return <p className="text-sm text-ink-2">Your worksheets print the EDIPI on your account, ending <span className="mono">{onFile.last4}</span>. If it is wrong, your Unit Manager or Vantage support corrects it.</p>;
  }
  const save = async (edipi: string | null) => {
    if (edipi !== null && !EDIPI_PATTERN.test(edipi)) { setError('An EDIPI is ten digits, the DoD ID number on the back of your CAC.'); return; }
    setBusy(true); setError(null);
    try {
      await api.saveFormEdipi(edipi);
      setValue('');
      await qc.invalidateQueries({ queryKey: keys.me });
      qc.invalidateQueries({ queryKey: ['counseling-worksheet'] });
      toast.success(edipi ? 'EDIPI saved to your profile.' : 'EDIPI removed from your profile.');
      onSaved?.();
    } catch (e) { setError((e instanceof api.ApiError && e.fieldErrors?.edipi) || api.errorText(e)); } finally { setBusy(false); }
  };
  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void save(value.trim()); }}>
      {onFile && <p className="text-sm text-ink-2">On your profile: ending <span className="mono">{onFile.last4}</span>. Type a new one to replace it.</p>}
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Your EDIPI" hint="ten digits, on the back of your CAC" error={error} className="min-w-[12rem] flex-1">
          <Input value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 10))} inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={10} autoFocus={autoFocus} className="mono" />
        </Field>
        <Button type="submit" variant="primary" loading={busy} disabled={value.length !== 10}>{submitLabel}</Button>
        {onFile && <Button type="button" variant="ghost" onClick={() => void save(null)} disabled={busy}>Remove</Button>}
      </div>
      <p className="text-xs text-ink-3">It saves to your Vantage profile and prints in your EDIPI box on counseling worksheets. It is never used to sign in, and nobody else can set it.</p>
    </form>
  );
}

/**
 * Asks for one's EDIPI before a worksheet is downloaded, when it is one's own and not on one's profile ("If not there, make
 * them type"). `ask` resolves true once it is saved, or straight away when nothing is missing. Print is not gated here: it
 * opens the print page on the click itself (a tab opened after waiting can be blocked), and that page asks for it.
 */
export function useEdipiGate() {
  const { data: identity } = useIdentity();
  const [waiting, setWaiting] = useState<((ok: boolean) => void) | null>(null);
  const missing = (row: { user_id: string; counselor_id?: string | null }) => ownsEdipiBox(row, identity?.user.id) && !identity?.user.edipi_on_file;
  const ask = (row: { user_id: string; counselor_id?: string | null }) =>
    (missing(row) ? new Promise<boolean>((resolve) => setWaiting(() => resolve)) : Promise.resolve(true));
  const close = (ok: boolean) => { waiting?.(ok); setWaiting(null); };
  const dialog = (
    <Dialog open={Boolean(waiting)} onOpenChange={(o) => { if (!o) close(false); }} size="sm" title="Add your EDIPI first"
      description="Your EDIPI is not on your Vantage profile. The worksheet prints it in your EDIPI box.">
      <EdipiForm submitLabel="Save and continue" autoFocus onSaved={() => close(true)} />
    </Dialog>
  );
  return { ask, missing, dialog };
}
