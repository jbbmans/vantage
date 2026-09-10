import { useEffect, useMemo, useRef, useState } from 'react';
import { track } from '@/lib/telemetry';
import { AlertTriangle, ArrowRight, Check, FileSpreadsheet, ShieldAlert, ShieldCheck, Upload } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Field, Select, Badge, Skeleton, EmptyState, NumberInput } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatNumber } from '../../shared/metrics';
import { cn } from '@/lib/utils';

/**
 * Bringing a spreadsheet in, in four steps: choose the file, say which sheet and header row,
 * say what each column means, then look at exactly what will happen before it happens.
 *
 * The preview is the point. Nothing is written until someone has seen the counts, and the rows
 * Vantage refused are shown with the reason, so a mangled document number is a decision the
 * person makes rather than a guess the software makes.
 */

const FIELD_OPTIONS = [
  { value: 'keep', label: 'Keep as a column' },
  { value: 'title', label: 'What the work is' },
  { value: 'reference', label: 'Reference' },
  { value: 'due_date', label: 'Due date' },
  { value: 'amount', label: 'Value' },
  { value: 'amount_type', label: 'Kind of value' },
  { value: 'quantity', label: 'How many' },
  { value: 'unit_label', label: 'Of what' },
  { value: 'state', label: 'State' },
  { value: 'ignore', label: 'Ignore this column' },
];

type Step = 'file' | 'sheet' | 'mapping' | 'preview' | 'done';

export default function ImportWizard({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const toast = useToast();
  const { data: identity } = useIdentity();
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('file');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<any>(null);
  const [inspection, setInspection] = useState<any>(null);
  const [sheetName, setSheetName] = useState('');
  const [headerRow, setHeaderRow] = useState(1);
  const [keyColumn, setKeyColumn] = useState('');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<any>(null);
  const [job, setJob] = useState<any>(null);
  const [unitId, setUnitId] = useState(identity?.primaryUnitId || '');
  const [runKey] = useState(() => `import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const openedAt = useRef(0);
  const stepRef = useRef<Step>('file');
  const finished = useRef(false);
  useEffect(() => { openedAt.current = Date.now(); }, []);
  useEffect(() => { stepRef.current = step; }, [step]);
  // Where people give up on an import is the whole point of measuring it. The step, never the file.
  useEffect(() => () => {
    if (finished.current || stepRef.current === 'done') return;
    const where = stepRef.current === 'file' ? 'at_upload' : stepRef.current === 'sheet' || stepRef.current === 'mapping' ? 'at_mapping' : 'at_preview';
    track('import.abandoned', { state: where }, { form_ms: Date.now() - openedAt.current });
  }, []);

  const sheet = useMemo(() => (inspection?.sheets || []).find((s: any) => s.name === sheetName) || inspection?.sheets?.[0], [inspection, sheetName]);
  const headers: string[] = useMemo(() => {
    const row = sheet?.sample?.[headerRow - 1] || [];
    return row.map((h: string, i: number) => (h || '').trim() || `Column ${i + 1}`);
  }, [sheet, headerRow]);

  const pick = async (file: File) => {
    setBusy(true);
    try {
      const uploaded = await api.uploadSource(file, { unitId: unitId || null, visibility: unitId ? 'unit' : 'private' });
      setSource(uploaded);
      const detail = await api.inspectSource(uploaded.id);
      setInspection(detail);
      setSheetName(detail.sheets[0]?.name || '');
      setStep('sheet');
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  const toMapping = () => {
    // A sensible first guess from the header names, which the person then corrects.
    const guessed: Record<string, string> = {};
    for (const h of headers) {
      const l = h.toLowerCase();
      if (/^(document|doc|id|number|no\.?|key|reference|ref)\b/.test(l)) guessed[h] = 'reference';
      else if (/desc|title|subject|summary|what/.test(l)) guessed[h] = 'title';
      else if (/due|deadline|suspense/.test(l)) guessed[h] = 'due_date';
      else if (/amount|value|dollar|cost|balance/.test(l)) guessed[h] = 'amount';
      else if (/type|category|fund/.test(l)) guessed[h] = 'amount_type';
      else if (/status|state/.test(l)) guessed[h] = 'state';
      else if (/count|qty|quantity/.test(l)) guessed[h] = 'quantity';
      else guessed[h] = 'keep';
    }
    setMapping(guessed);
    setKeyColumn(headers.find((h) => guessed[h] === 'reference') || headers[0] || '');
    setStep('mapping');
  };

  const plan = () => ({
    source_file_id: source.id,
    sheet_name: sheet?.name || '',
    header_row: headerRow,
    key_columns: [keyColumn],
    mapping,
    unit_id: unitId || null,
    visibility: unitId ? 'unit' : 'private',
  });

  const runPreview = async () => {
    setBusy(true);
    try {
      const result = await api.previewImport(plan());
      setPreview(result);
      setStep('preview');
      track('import.previewed', {
        rows: result.total_rows || 0,
        mapped_columns: Object.keys(mapping).length,
        unmapped_columns: Math.max(0, (inspection?.sheets?.find((x: any) => x.name === sheetName)?.columns?.length || 0) - Object.keys(mapping).length),
        damaged_identifiers: (result.rejections || []).filter((r: any) => /digits|scientific|rounded/i.test(String(r.reason || ''))).length,
      });
    }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  const run = async () => {
    setBusy(true);
    try {
      const result = await api.runImport(plan(), runKey);
      finished.current = true;
      setJob(result);
      setStep('done');
    } catch (e) {
      track('import.abandoned', { state: 'save_failed' }, { form_ms: Date.now() - openedAt.current });
      toast.error(api.errorText(e));
    }
    finally { setBusy(false); }
  };

  const titles: Record<Step, string> = {
    file: 'Import a spreadsheet',
    sheet: 'Which sheet, and where do the headings sit?',
    mapping: 'What does each column mean?',
    preview: 'Here is exactly what will happen',
    done: 'Imported',
  };

  return (
    <Dialog
      open onOpenChange={(o) => { if (!o) onClose(); }}
      title={titles[step]}
      size="lg"
      description={step === 'file' ? 'Vantage reads .xlsx workbooks and delimited text. The original file is kept unchanged and read again on every reimport.' : undefined}
      footer={
        step === 'file' ? <Button variant="ghost" onClick={onClose}>Cancel</Button>
        : step === 'sheet' ? <><Button variant="ghost" onClick={() => setStep('file')}>Back</Button><Button variant="primary" disabled={!sheet} onClick={toMapping}>Next<ArrowRight className="h-4 w-4" /></Button></>
        : step === 'mapping' ? <><Button variant="ghost" onClick={() => setStep('sheet')}>Back</Button><Button variant="primary" loading={busy} disabled={!keyColumn} onClick={runPreview}>Preview<ArrowRight className="h-4 w-4" /></Button></>
        : step === 'preview' ? <><Button variant="ghost" onClick={() => setStep('mapping')}>Back</Button><Button variant="primary" loading={busy} onClick={run}><Check className="h-4 w-4" />Import {formatNumber((preview?.will_insert.length || 0) + (preview?.will_update.length || 0))} rows</Button></>
        : <Button variant="primary" onClick={onImported}>Open the queue</Button>
      }
    >
      {step === 'file' && (
        <div className="space-y-4">
          {identity && identity.memberships.length > 0 && (
            <Field label="Who is this work for" hint="Shared work needs the authority to post work to that unit. Choose nobody to keep it to yourself.">
              <Select
                value={unitId} onValueChange={setUnitId}
                options={[{ value: '', label: 'Just me' }, ...identity.memberships.map((m) => ({ value: m.unit_id, label: m.unit_short || m.unit_name }))]}
              />
            </Field>
          )}
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong bg-surface-2 px-6 py-10 text-center transition-colors hover:border-accent"
          >
            {busy ? <Skeleton className="h-8 w-8 rounded-full" /> : <Upload className="h-8 w-8 text-ink-3" />}
            <span className="text-sm font-medium text-ink">{busy ? 'Reading the file' : 'Choose a file'}</span>
            <span className="text-xs text-ink-3">.xlsx, .xlsm, .csv or .tsv</span>
          </button>
          <input
            ref={fileInput} type="file" className="sr-only" aria-label="Spreadsheet to import"
            accept=".xlsx,.xlsm,.csv,.tsv,.txt"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }}
          />
          <p className="text-xs text-ink-3">
            Macros are never run. Formulas are read as the value the spreadsheet saved, never recalculated. Links to other files are not followed.
          </p>
        </div>
      )}

      {step === 'sheet' && inspection && (
        <div className="space-y-4">
          <ScanNotice source={source} />
          {inspection.notes.length > 0 && (
            <ul className="space-y-1 rounded-md border border-line bg-surface-2 p-3 text-xs text-ink-2">
              {inspection.notes.map((n: string) => <li key={n} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />{n}</li>)}
            </ul>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Sheet">
              <Select value={sheet?.name || ''} onValueChange={setSheetName} options={inspection.sheets.map((s: any) => ({ value: s.name, label: `${s.name} (${formatNumber(s.rows)} rows)` }))} />
            </Field>
            <Field label="Heading row" hint="The row that names the columns.">
              <NumberInput value={String(headerRow)} min={1} max={20} onChange={(e) => setHeaderRow(Math.max(1, Number(e.target.value) || 1))} />
            </Field>
          </div>
          {sheet?.truncated && <p className="text-xs text-warn">This sheet is larger than Vantage reads in one pass. Only the first rows are shown and imported.</p>}
          <SamplePreview sheet={sheet} headerRow={headerRow} />
        </div>
      )}

      {step === 'mapping' && (
        <div className="space-y-4">
          <Field label="Which column identifies each row" hint="This is how a reimport recognises the same piece of work. It is taken exactly as written.">
            <Select value={keyColumn} onValueChange={setKeyColumn} options={headers.map((h) => ({ value: h, label: h }))} />
          </Field>
          <div className="overflow-hidden rounded-md border border-line">
            <table className="w-full text-sm">
              <thead className="bg-surface-2">
                <tr><th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-2">Column</th><th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-2">Means</th><th scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-2">First value</th></tr>
              </thead>
              <tbody>
                {headers.map((h, i) => (
                  <tr key={h} className="border-t border-line">
                    <td className="px-3 py-1.5 text-ink">{h}{h === keyColumn && <Badge tone="accent" className="ml-2">Identifier</Badge>}</td>
                    <td className="px-3 py-1.5">
                      <Select
                        aria-label={`What ${h} means`} className="w-52"
                        value={mapping[h] || 'keep'}
                        onValueChange={(v) => setMapping((m) => ({ ...m, [h]: v }))}
                        options={FIELD_OPTIONS}
                      />
                    </td>
                    <td className="px-3 py-1.5 text-xs text-ink-3">{sheet?.sample?.[headerRow]?.[i] || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-3">Anything you do not map is still kept with the row, so nothing in your spreadsheet is lost.</p>
        </div>
      )}

      {step === 'preview' && preview && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['New', preview.will_insert.length, 'accent'],
              ['Updated', preview.will_update.length, 'accent'],
              ['Unchanged', preview.unchanged, 'neutral'],
              ['Refused', preview.rejections.length, preview.rejections.length ? 'warn' : 'neutral'],
            ].map(([label, value, tone]) => (
              <div key={String(label)} className={cn('rounded-md border px-3 py-2', tone === 'warn' ? 'border-warn/40 bg-warn/5' : 'border-line')}>
                <p className="eyebrow">{label}</p>
                <p className="fig mt-0.5 text-xl font-semibold text-ink">{formatNumber(Number(value))}</p>
              </div>
            ))}
          </div>

          {preview.unchanged > 0 && preview.will_insert.length === 0 && preview.will_update.length === 0 && (
            <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
              Everything in this file is already here, unchanged. Importing it will do nothing, which is the right answer.
            </p>
          )}

          {preview.will_update.some((r: any) => r.claimed_by) && (
            <p className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-sm text-ink">
              Some of these rows are being worked right now. Their claims are kept, and the person holding each one is told the source changed.
            </p>
          )}

          {preview.rejections.length > 0 && (
            <div>
              <h3 className="mb-2 flex items-center gap-2 font-mono text-2xs font-medium uppercase tracking-[0.14em] text-ink"><ShieldAlert className="h-4 w-4 text-warn" />Rows Vantage will not import</h3>
              <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                {preview.rejections.slice(0, 50).map((r: any, i: number) => (
                  <li key={`${r.source_row}-${i}`} className="rounded-md border border-line px-3 py-1.5">
                    <span className="font-medium text-ink">Row {r.source_row}{r.value ? `: ${r.value}` : ''}</span>
                    <span className="block text-ink-3">{r.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {preview.will_update.length > 0 && (
            <details className="rounded-md border border-line">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">What changed on the {preview.will_update.length} updated rows</summary>
              <ul className="space-y-1 px-3 pb-3 text-xs">
                {preview.will_update.slice(0, 50).map((r: any) => (
                  <li key={r.existing_id} className="border-b border-line py-1">
                    <span className="fig font-medium text-ink">{r.natural_key}</span>
                    <span className="ml-2 text-ink-3">{r.changes.join(', ') || 'a kept column'}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {step === 'done' && job && (
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm text-good"><Check className="h-4 w-4" />{formatNumber(job.inserted_rows)} new, {formatNumber(job.updated_rows)} updated, {formatNumber(job.unchanged_rows)} already matched.</p>
          {job.rejected_rows > 0 && <p className="text-sm text-warn">{formatNumber(job.rejected_rows)} rows were refused. They are listed on this import in your history.</p>}
          <p className="text-xs text-ink-3">The original file is kept exactly as uploaded, so this import can be repeated or checked later.</p>
        </div>
      )}

      {step !== 'file' && !inspection && <EmptyState icon={FileSpreadsheet} title="Choose a file first" />}
    </Dialog>
  );
}

function ScanNotice({ source }: { source: any }) {
  if (!source) return null;
  if (source.scan_status === 'clean') {
    return <p className="flex items-center gap-2 rounded-md border border-good/40 bg-good/5 px-3 py-2 text-xs text-ink"><ShieldCheck className="h-4 w-4 text-good" />Scanned clean by {source.scanner}.</p>;
  }
  if (source.scan_status === 'skipped') {
    return <p className="flex items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2"><ShieldAlert className="h-4 w-4 text-ink-3" />{source.scan_detail}</p>;
  }
  return <p className="flex items-center gap-2 rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-xs text-ink"><ShieldAlert className="h-4 w-4 text-bad" />{source.scan_detail}</p>;
}

function SamplePreview({ sheet, headerRow }: { sheet: any; headerRow: number }) {
  if (!sheet?.sample?.length) return null;
  const width = sheet.sample.reduce((n: number, r: string[]) => Math.max(n, r.length), 0);
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="w-full text-xs">
        <tbody>
          {sheet.sample.slice(0, 8).map((row: string[], r: number) => (
            <tr key={r} className={cn('border-b border-line', r === headerRow - 1 && 'bg-accent/5 font-semibold text-ink')}>
              <td className="w-10 px-2 py-1 text-right text-ink-3">{r + 1}</td>
              {Array.from({ length: width }, (_, c) => (
                <td key={c} className="max-w-[12rem] truncate px-2 py-1 text-ink-2">{row[c] || ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
