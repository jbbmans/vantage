import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from './ui/Dialog';
import { Badge, Button, Field, Select, Textarea } from './ui/primitives';
import * as api from '@/lib/api';
import { BULK_WORK_LIMIT, type BulkWorkAction, type BulkWorkInput, type BulkWorkResponse } from '../../shared/bulkWork';

export interface SelectedWork { id: string; version: number; reference?: string | null; title?: string }

/** How long Apply ignores taps after the preview appears, so a double tap on Preview cannot apply unseen changes. */
const APPLY_ARMS_AFTER_MS = 700;

export default function BulkWorkDialog({ items, onClose, onApplied }: {
  items: SelectedWork[];
  onClose: () => void;
  onApplied: (result: BulkWorkResponse) => void;
}) {
  const [action, setAction] = useState<BulkWorkAction>('assign');
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<BulkWorkResponse | null>(null);
  const [result, setResult] = useState<BulkWorkResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const key = useRef<string | null>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const ids = items.map((item) => item.id);
  const candidates = useQuery({ queryKey: ['bulk-candidates', ids], queryFn: () => api.bulkHandoffCandidates(ids), enabled: action === 'assign' && items.length > 0 && items.length <= BULK_WORK_LIMIT && !result, retry: false });
  const input: BulkWorkInput = { action, items: items.map(({ id, version }) => ({ id, version })), ...(action === 'assign' ? { to_user_id: target, note: note.trim() } : {}) };
  const ready = items.length > 0 && items.length <= BULK_WORK_LIMIT && (action !== 'assign' || Boolean(target && note.trim()));
  const changed = () => { setPreview(null); setError(''); setArmed(false); key.current = null; };

  // Apply waits a moment after the preview is drawn before it takes a tap.
  useEffect(() => {
    if (!preview || result) return;
    const timer = window.setTimeout(() => setArmed(true), APPLY_ARMS_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [preview, result]);
  // The Preview and Apply buttons come and go, so focus moves to the summary of what was found or done.
  useEffect(() => { if (preview || result) summary.current?.focus(); }, [preview, result]);

  const inspect = async () => {
    setBusy(true); setError(''); setArmed(false);
    try { setPreview(await api.previewBulkWork(input)); key.current = crypto.randomUUID(); }
    catch (e) { setError(api.errorText(e)); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!preview || !key.current || !armed) return;
    // Only the cases the preview showed as ready are sent, so the count on the button is what can change.
    const ready = new Set(preview.results.filter((row) => row.ok).map((row) => row.id));
    const skipped = preview.results.filter((row) => !row.ok);
    setBusy(true); setError('');
    try {
      const response = await api.runBulkWork({ ...input, items: input.items.filter((item) => ready.has(item.id)) }, key.current);
      const byId = new Map([...skipped, ...response.results].map((row) => [row.id, row]));
      const merged: BulkWorkResponse = {
        results: items.map((item) => byId.get(item.id)).filter((row): row is BulkWorkResponse['results'][number] => Boolean(row)),
        succeeded: response.succeeded,
        failed: response.failed + skipped.length,
      };
      setResult(merged); onApplied(merged);
    }
    catch (e) { setError(`${api.errorText(e)} You can retry this same request safely; already applied changes are not repeated.`); }
    finally { setBusy(false); }
  };
  const shown = result ?? preview;
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title="Update selected work" size="md"
      description="Preview each case first. Permissions and versions are checked again when you apply; any refusal is listed individually."
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={onClose}>{result ? 'Close' : 'Cancel'}</Button>
        {!result && !preview && <Button key="preview" variant="primary" loading={busy} disabled={!ready} onClick={inspect}>Preview changes</Button>}
        {!result && preview && <Button key="apply" variant="primary" loading={busy} disabled={!preview.succeeded || !armed} onClick={apply}>Apply to {preview.succeeded} {preview.succeeded === 1 ? 'case' : 'cases'}</Button>}
      </>}>
      {!result && <div className="space-y-4">
        <p className="text-sm text-ink-2">{items.length} selected. Up to {BULK_WORK_LIMIT} cases can be changed together.</p>
        <Field label="Action"><Select aria-label="Bulk action" disabled={busy} value={action} onValueChange={(value) => { setAction(value as BulkWorkAction); changed(); }} options={[
          { value: 'assign', label: 'Assign or hand off' }, { value: 'claim', label: 'Claim for myself' }, { value: 'release', label: 'Release to the queue' },
        ]} /></Field>
        {action === 'assign' && <>
          <Field label="Assign to"><Select value={target} disabled={busy || candidates.isPending} placeholder={candidates.isPending ? 'Loading eligible Marines…' : 'Choose a Marine'}
            onValueChange={(value) => { setTarget(value); changed(); }} options={(candidates.data ?? []).map((person) => ({ value: person.id, label: `${person.rank || ''} ${person.name}`.trim() }))} /></Field>
          {candidates.isError && <p role="alert" className="text-sm text-bad">{api.errorText(candidates.error)}</p>}
          {!candidates.isPending && !candidates.isError && !candidates.data?.length && <p className="text-sm text-ink-2">No eligible recipients were found for this selection. Claim or release only the work you are authorized to change.</p>}
          <Field label="Handoff note"><Textarea aria-label="Bulk handoff note" value={note} disabled={busy} maxLength={1000} rows={3} onChange={(event) => { setNote(event.target.value); changed(); }} placeholder="What the next Marine needs to know" /></Field>
        </>}
      </div>}
      {error && <p role="alert" className="mt-3 text-sm text-bad">{error}</p>}
      {shown && <div className="mt-4 space-y-3">
        <p ref={summary} tabIndex={-1} className="text-sm font-medium text-ink outline-none">{shown.succeeded} {result ? 'applied' : 'ready'} · {shown.failed} {result ? 'not changed' : 'cannot be changed'}</p>
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
          {shown.results.map((row, index) => <li key={row.id} className="px-3 py-2 text-sm">
            <div className="flex items-start justify-between gap-2"><span className="min-w-0 break-words font-medium text-ink">{row.reference || `Selected case ${index + 1}`}</span><Badge tone={row.ok ? 'good' : 'warn'}>{row.ok ? result ? 'Applied' : 'Ready' : 'Unchanged'}</Badge></div>
            <p className="mt-1 text-xs text-ink-2">{row.message}</p>
          </li>)}
        </ul>
        {result?.failed ? <p className="text-xs text-ink-2">Cases that were not changed and still match this view remain selected. Close this dialog, review them, and preview a new request.</p> : null}
      </div>}
    </Dialog>
  );
}
