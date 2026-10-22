import { useEffect, useMemo, useState } from 'react';
import { Eye } from 'lucide-react';
import { Button, Field, Input, Select, Badge } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { SupervisorPicker } from '@/components/PersonnelRecord';
import * as api from '@/lib/api';
import type { PersonnelBulkResponse, PersonnelPersonRef, PersonnelRosterResponse, PersonnelRosterRow } from '../../shared/types';

type BulkAction = 'supervisor' | 'checked_in' | 'assignment_start' | 'assignment_end' | 'billet' | 'responsibility' | 'move';
const ACTIONS: Array<{ value: BulkAction; label: string }> = [
  { value: 'supervisor', label: 'Set the supervisor' },
  { value: 'checked_in', label: 'Set the check-in date' },
  { value: 'assignment_start', label: 'Set the assignment start' },
  { value: 'assignment_end', label: 'Set the assignment end' },
  { value: 'billet', label: 'Fill a billet from the list' },
  { value: 'responsibility', label: 'Add a responsibility' },
  { value: 'move', label: 'Move to another team' },
];
const DATES = new Set<BulkAction>(['checked_in', 'assignment_start', 'assignment_end']);
const CHANGED: Record<string, string> = { billet: 'billet', billet_id: 'billet', supervisor: 'supervisor', checked_in: 'check-in', assignment_start: 'assignment start', assignment_end: 'assignment end', responsibility: 'responsibility', unit: 'team' };

/**
 * One change to several Marines at once (ADR-0017). A preview says what would happen to each; nothing is applied
 * unless every one of them can be changed, and each is decided as its single change would be.
 */
export default function PersonnelBulkDialog({ open, onOpenChange, unitId, unitLabel, rows, billets, moveTargets, onDone }: {
  open: boolean; onOpenChange: (o: boolean) => void; unitId: string; unitLabel: string; rows: PersonnelRosterRow[];
  billets: PersonnelRosterResponse['billets']; moveTargets: Array<{ id: string; depth: number; label: string }>; onDone: () => void;
}) {
  const toast = useToast();
  const [action, setAction] = useState<BulkAction>('supervisor');
  const [value, setValue] = useState('');
  const [supervisor, setSupervisor] = useState<PersonnelPersonRef | null>(null);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<PersonnelBulkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  useEffect(() => { if (open) { setAction('supervisor'); setValue(''); setSupervisor(null); setReason(''); setPreview(null); setError(null); } }, [open]);
  // Any change to what would be done asks for a new preview.
  useEffect(() => { setPreview(null); setError(null); }, [action, value, supervisor, reason, rows]);
  const names = useMemo(() => new Map(rows.map((r) => [r.id, `${r.rank_abbr || ''} ${r.last_name}, ${r.first_name}`.trim()])), [rows]);
  const targets = moveTargets.filter((t) => rows.some((r) => r.assignment.unit_id !== t.id));
  const sent = (): string | null => {
    if (action === 'supervisor') return supervisor?.id ?? null;
    if (action === 'billet') return value && value !== '__none' ? value : null;
    return value.trim() || null;
  };
  const run = async (dryRun: boolean) => {
    setBusy(dryRun ? 'preview' : 'apply'); setError(null);
    try {
      const r = await api.personnelBulk(unitId, { items: rows.map((row) => ({ user_id: row.id, unit_id: row.assignment.unit_id })), action, value: sent(), reason: reason.trim() || null, dry_run: dryRun });
      if (dryRun) { setPreview(r); return; }
      toast.success(`Changed ${r.results.length} ${r.results.length === 1 ? 'Marine' : 'Marines'}.`);
      onDone(); onOpenChange(false);
    } catch (e) {
      // A refused apply says why for each Marine, and nothing was changed.
      if (e instanceof api.ApiError && Array.isArray(e.extra.results)) setPreview(e.extra as unknown as PersonnelBulkResponse);
      setError(e instanceof api.ApiError && e.fieldErrors?.value ? e.fieldErrors.value : api.errorText(e));
    } finally { setBusy(null); }
  };
  const ready = Boolean(preview && preview.dry_run && !preview.refused);
  const n = rows.length;
  const describe = (r: PersonnelBulkResponse['results'][number]) => (!r.ok ? r.error || 'Refused.' : r.changed.length ? `Would change the ${[...new Set(r.changed.map((c) => CHANGED[c] || c))].join(' and ')}.` : 'Already so; nothing to change.');
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="md" title={`Change ${n} ${n === 1 ? 'Marine' : 'Marines'}`}
      description={`In ${unitLabel} and the teams beneath it. Preview first: nothing is changed unless every one of them can be, and each change is in their history and the audit trail.`}
      footer={<>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button onClick={() => run(true)} loading={busy === 'preview'}><Eye className="h-4 w-4" />Preview</Button>
        <Button variant="primary" onClick={() => run(false)} loading={busy === 'apply'} disabled={!ready}>Apply to {n}</Button>
      </>}>
      <div className="space-y-3">
        <Field label="Change"><Select value={action} onValueChange={(v) => { setAction(v as BulkAction); setValue(''); setSupervisor(null); }} options={ACTIONS} /></Field>
        {action === 'supervisor' && <SupervisorPicker unitId={unitId} value={supervisor} onChange={setSupervisor} label="New supervisor" />}
        {action === 'supervisor' && !supervisor && <p className="text-2xs text-ink-3">Leave it empty to clear their supervisor.</p>}
        {DATES.has(action) && <Field label="Date" hint="Leave it empty to clear it."><Input type="date" value={value} onChange={(e) => setValue(e.target.value)} /></Field>}
        {action === 'billet' && <Field label="Billet" hint={billets.length ? 'A billet listed for each Marine’s unit, or for every unit.' : 'This command lists no billets yet. The Unit Manager console keeps the list.'}><Select value={value || '__none'} onValueChange={setValue} options={[{ value: '__none', label: 'No billet (clear it)' }, ...billets.map((b) => ({ value: b.id, label: b.code ? `${b.title} (${b.code})` : b.title }))]} /></Field>}
        {action === 'responsibility' && <Field label="Responsibility" required><Input maxLength={80} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Safety NCO" /></Field>}
        {action === 'move' && <Field label="Move to"><Select value={value} onValueChange={setValue} placeholder="Choose a team" options={targets.sort((x, y) => y.depth - x.depth).map((t) => ({ value: t.id, label: t.label }))} /></Field>}
        {action === 'move' && <p className="text-2xs text-ink-3">Their roles in the team they leave go with them where the new team has the same role; their entries stay where they were, and they are signed out everywhere.</p>}
        <Field label="Why (optional)" hint="Kept with each change in their history"><Input maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reorganization, 1 Nov" /></Field>
        {error && <p role="alert" className="text-sm text-bad">{error}</p>}
        {preview && (
          <section aria-label="Preview" className="rounded-md border border-line">
            <p className="border-b border-line px-3 py-2 text-xs text-ink-2">{preview.refused ? `${preview.refused} of ${preview.results.length} cannot be changed, so nothing will be. Deselect them or fix what is in the way, then preview again.` : `All ${preview.results.length} can be changed.`}</p>
            <ul className="max-h-64 overflow-auto">{preview.results.map((r) => (
              <li key={r.user_id} className="row flex items-start justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0"><span className="block text-ink">{names.get(r.user_id) || r.user_id}</span><span className={r.ok ? 'block text-xs text-ink-3' : 'block text-xs text-bad'}>{describe(r)}</span></span>
                <Badge tone={r.ok ? 'good' : 'bad'}>{r.ok ? 'Ready' : 'Refused'}</Badge>
              </li>
            ))}</ul>
          </section>
        )}
      </div>
    </Dialog>
  );
}
