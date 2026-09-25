import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, UserPlus, Download } from 'lucide-react';
import { Button, Badge } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { Table } from '@/components/common';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { keys } from '@/lib/queries';
import { downloadText } from '@/lib/utils';
import * as api from '@/lib/api';

interface Planned { line: number; username: string; name: string; rank_id: string | null; command: string | null; team: string | null; role: string; billet: string | null; status: 'create' | 'exists' | 'error'; problems: string[]; warnings: string[]; generated_password: boolean }
interface Plan { accounts: Planned[]; units: Array<{ name: string; parent: string | null; exists: boolean }>; counts: { create: number; exists: number; error: number; new_units: number }; created?: number; generated?: Array<{ username: string; password: string }> }

const TONE = { create: 'good', exists: 'neutral', error: 'bad' } as const;
const LABEL = { create: 'New', exists: 'Exists', error: 'Skipped' } as const;

export default function AccountImport({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [done, setDone] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const qc = useQueryClient();

  const reset = () => { setFile(null); setPlan(null); setDone(null); if (input.current) input.current.value = ''; };
  const preview = async (f: File) => {
    setFile(f); setPlan(null); setDone(null); setBusy(true);
    try { setPlan(await withSudo(() => api.adminImportAccounts(f, false))); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const result: Plan = await withSudo(() => api.adminImportAccounts(file, true));
      setDone(result);
      toast.success(`${result.created} ${result.created === 1 ? 'account' : 'accounts'} created.`);
      qc.invalidateQueries({ queryKey: keys.team }); qc.invalidateQueries({ queryKey: keys.me }); onDone();
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };

  const shown = done || plan;
  return (
    <>
      <Button size="sm" onClick={() => { reset(); setOpen(true); }}><FileSpreadsheet className="h-3.5 w-3.5" />Import accounts</Button>
      <Dialog
        open={open}
        onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}
        size="xl"
        title={done ? 'Accounts created' : 'Import accounts from a roster'}
        description={done ? 'Each person signs in with their temporary password and is asked to choose their own.' : 'An .xlsx or .csv with a header row. Username, First Name and Last Name are required; Rank, Command, Team, Email, Temporary Password, Role and Billet are used when present. Nothing is written until you confirm.'}
        footer={done
          ? <Button variant="primary" onClick={() => setOpen(false)}>Done</Button>
          : <><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" disabled={!plan || !plan.counts.create} loading={busy && Boolean(plan)} onClick={apply}><UserPlus className="h-4 w-4" />{plan ? `Create ${plan.counts.create} ${plan.counts.create === 1 ? 'account' : 'accounts'}` : 'Create accounts'}</Button></>}
      >
        {!done && (
          <label className="mb-4 flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-line px-4 py-6 text-center text-sm hover:border-accent">
            <FileSpreadsheet className="h-5 w-5 text-ink-3" />
            <span className="font-medium text-ink">{file ? file.name : 'Choose a roster file'}</span>
            <span className="text-xs text-ink-3">{busy && !plan ? 'Reading…' : '.xlsx or .csv, up to 500 people'}</span>
            <input ref={input} type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void preview(f); }} />
          </label>
        )}
        {shown && (
          <>
            <p className="mb-3 text-sm text-ink-2">
              {done ? <><strong className="text-ink">{done.created}</strong> created</> : <><strong className="text-ink">{shown.counts.create}</strong> to create</>}
              {shown.counts.exists ? <> · {shown.counts.exists} already exist</> : null}
              {shown.counts.error ? <> · <span className="text-bad">{shown.counts.error} skipped</span></> : null}
              {shown.counts.new_units ? <> · {shown.counts.new_units} new {shown.counts.new_units === 1 ? 'unit' : 'units'}: {shown.units.filter((u) => !u.exists).map((u) => u.parent ? `${u.parent} › ${u.name}` : u.name).join(', ')}</> : null}
            </p>
            {done?.generated?.length ? (
              <div className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
                <p className="font-medium text-ink">{done.generated.length} {done.generated.length === 1 ? 'row had' : 'rows had'} no temporary password, so one was made. It is shown only now.</p>
                <Button size="xs" className="mt-2" onClick={() => downloadText('vantage-temporary-passwords.csv', ['username,temporary_password', ...done.generated!.map((g) => `${g.username},${g.password}`)].join('\n'), 'text/csv')}><Download className="h-3 w-3" />Download them</Button>
              </div>
            ) : null}
            <div className="card" style={{ overflow: 'hidden' }}>
              <Table minWidth={760} head={<><th className="w-12">Row</th><th>Marine</th><th className="w-48">Unit</th><th className="w-36">Role</th><th className="w-24">Status</th></>}>
                {shown.accounts.map((a) => (
                  <tr key={a.line}>
                    <td className="fig text-ink-3">{a.line}</td>
                    <td><span className="block font-medium text-ink">{a.rank_id || ''} {a.name}</span><span className="block text-xs text-ink-3">@{a.username}</span>
                      {[...a.problems, ...a.warnings].map((p) => <span key={p} className={`block text-xs ${a.problems.includes(p) ? 'text-bad' : 'text-warn'}`}>{p}</span>)}</td>
                    <td className="text-xs text-ink-2">{[a.command, a.team].filter(Boolean).join(' › ') || '—'}{a.billet ? <span className="block text-ink-3">{a.billet}</span> : null}</td>
                    <td className="text-sm">{a.role}</td>
                    <td><Badge tone={TONE[a.status]}>{done && a.status === 'create' ? 'Created' : LABEL[a.status]}</Badge></td>
                  </tr>
                ))}
              </Table>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
