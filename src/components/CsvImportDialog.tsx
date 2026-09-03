import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp, AlertTriangle } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Badge, Select } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { parseCsvText, guessMapping, applyMapping, ACTIVITY_CSV_COLUMNS, MAX_IMPORT_ROWS } from '../../shared/csv';
import { screenImport } from '../../shared/duplicates';
import * as api from '@/lib/api';
import { invalidateRecords, useIdentity, useRecords } from '@/lib/queries';
import { Table } from '@/components/common';

export default function CsvImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const { data: existing } = useRecords('activities', undefined, open);
  const [parsed, setParsed] = useState<{ columns: string[]; rows: Array<Record<string, string>>; name: string } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [visibility, setVisibility] = useState<'private' | 'unit' | 'keep'>('keep');
  const [skipDupes, setSkipDupes] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async (file: File) => {
    setError('');
    try {
      const text = await file.text();
      const delimiter = file.name.toLowerCase().endsWith('.tsv') || (text.split('\n')[0] || '').includes('\t') ? '\t' : ',';
      const p = parseCsvText(text, delimiter);
      if (!p.rows.length) { setError('That file has a header but no rows.'); return; }
      if (p.rows.length > MAX_IMPORT_ROWS) { setError(`Imports are limited to ${MAX_IMPORT_ROWS} rows per file. Split it and import in batches.`); return; }
      setParsed({ ...p, name: file.name });
      setMapping(guessMapping(p.columns));
    } catch (e) { setError((e as Error).message); }
  };

  const preview = useMemo(() => {
    if (!parsed) return null;
    const { records, problems } = applyMapping(parsed.rows, mapping);
    const byId = new Map<string, any>((existing || []).map((e: any) => [e.id, e]));
    const withVisibility = records.map((r) => {
      const prior = r.id ? byId.get(r.id) : null;
      const vis = visibility !== 'keep' ? visibility : r.visibility === 'unit' || r.visibility === 'private' ? r.visibility : prior?.visibility || 'private';
      return { ...r, visibility: vis, unit_id: prior ? prior.unit_id : identity?.primaryUnitId || null };
    });
    const updates = withVisibility.filter((r) => r.id && (existing || []).some((e: any) => e.id === r.id));
    const fresh = withVisibility.filter((r) => !updates.includes(r));
    const screened = screenImport(fresh, existing || []);
    const near = screened.near.map((n) => n.row);
    return { records: withVisibility, problems, updates, fresh, duplicates: [...screened.exact, ...near], clean: screened.fresh };
  }, [parsed, mapping, visibility, existing, identity?.primaryUnitId]);

  const run = async () => {
    if (!preview) return;
    const rows = [...preview.updates, ...(skipDupes ? preview.clean : preview.fresh)];
    if (!rows.length) { toast.error('Nothing to import after screening.'); return; }
    setBusy(true);
    try {
      const result = await api.importActivities(rows);
      invalidateRecords(qc, 'activities');
      toast.success(`Imported ${result.created} new, updated ${result.updated}${result.duplicates ? `, skipped ${result.duplicates} exact duplicates` : ''}.`);
      onOpenChange(false); setParsed(null);
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setParsed(null); setError(''); } }} title="Import activities from CSV" description="Files exported from Vantage round-trip exactly: rows with a Vantage ID update the original entry instead of duplicating it." size="lg"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={run} loading={busy} disabled={!preview || preview.problems.length > 0 || !parsed}>Import {preview ? preview.updates.length + (skipDupes ? preview.clean.length : preview.fresh.length) : 0} rows</Button></>}>
      {!parsed ? (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line px-4 py-10 text-center transition-colors hover:border-accent hover:bg-accent-soft/30" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) load(f); }}>
          <FileUp className="h-6 w-6 text-ink-3" />
          <span className="text-sm font-medium text-ink">Drop a .csv or .tsv here, or click to choose</span>
          <span className="text-xs text-ink-3">Any spreadsheet works; you map the columns next. Up to {MAX_IMPORT_ROWS} rows.</span>
          <input type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); }} />
          {error && <span className="mt-2 text-xs text-bad">{error}</span>}
        </label>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm"><Badge tone="accent">{parsed.name}</Badge><span className="text-ink-3">{parsed.rows.length} rows · {parsed.columns.length} columns</span><Button size="xs" variant="ghost" className="ml-auto" onClick={() => setParsed(null)}>Choose another file</Button></div>
          <div>
            <p className="mb-2 text-xs font-semibold text-ink-2">Column mapping</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {ACTIVITY_CSV_COLUMNS.map((c) => (
                <div key={c.key} className="flex items-center gap-2 text-sm"><span className="w-32 shrink-0 truncate text-ink-2">{c.header}{c.key === 'title' && <span className="text-bad">*</span>}</span>
                  <Select aria-label={`Column for ${c.header}`} className="h-8 text-xs" value={mapping[c.key] || '__skip'} onValueChange={(v) => setMapping((m) => ({ ...m, [c.key]: v === '__skip' ? '' : v }))} options={[{ value: '__skip', label: 'Skip' }, ...parsed.columns.map((col) => ({ value: col, label: col }))]} />
                </div>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-sm"><span className="mb-1 block text-xs font-semibold text-ink-2">Visibility for imported rows</span>
              <Select value={visibility} onValueChange={(v) => setVisibility(v as typeof visibility)} options={[{ value: 'keep', label: 'Use the file’s Visibility column (default private)' }, { value: 'private', label: 'Only me' }, { value: 'unit', label: 'Share with my unit', disabled: !identity?.primaryUnitId }]} /></label>
            <label className="flex items-start gap-2 pt-5 text-sm text-ink-2"><input type="checkbox" checked={skipDupes} onChange={(e) => setSkipDupes(e.target.checked)} className="mt-1" />Skip rows that look like entries already logged</label>
          </div>
          {preview && preview.problems.length > 0 && (
            <div className="rounded-md border border-bad/40 bg-bad/5 p-3 text-sm"><p className="flex items-center gap-2 font-medium text-bad"><AlertTriangle className="h-4 w-4" />{preview.problems.length} row{preview.problems.length === 1 ? '' : 's'} cannot be imported</p>
              <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-ink-2">{preview.problems.slice(0, 30).map((p) => <li key={p.row}>Row {p.row}: {p.issue}</li>)}</ul></div>
          )}
          {preview && (
            <div className="text-sm text-ink-2">
              <p><strong className="text-ink">{preview.updates.length}</strong> update existing entries · <strong className="text-ink">{preview.clean.length}</strong> new · <strong className="text-ink">{preview.duplicates.length}</strong> likely duplicates{skipDupes ? ' (skipped)' : ' (will import)'}</p>
              <div className="mt-2 max-h-56 overflow-auto rounded-md border border-line">
                <Table head={<><th>Date</th><th>Title</th><th>Qty</th><th>Value</th><th>Area</th></>} className="" minWidth={520}>
                  {preview.records.slice(0, 25).map((r, i) => <tr key={i}><td className="fig whitespace-nowrap">{r.date}</td><td className="max-w-xs truncate">{r.title}</td><td className="fig">{r.quantity ?? ''} {r.unit_label || ''}</td><td className="fig">{r.dollar_amount ?? ''}</td><td>{r.eval_area || ''}</td></tr>)}
                </Table>
                {preview.records.length > 25 && <p className="px-3 py-1.5 text-2xs text-ink-3">…and {preview.records.length - 25} more</p>}
              </div>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
