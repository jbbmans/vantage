import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp, AlertTriangle, CheckCircle2, Undo2, Info } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Badge, Field, Input, Select, Segmented, Switch, type Tone } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { invalidateDomains, keys } from '@/lib/queries';
import { placeName } from '@/config/nav';
import * as api from '@/lib/api';
import { cn, humanize } from '@/lib/utils';
import {
  IMPORT_TABLES, RECORD_COLUMNS, TABLE_LABELS, isImportTable, isRecordTypeHeader,
  type ImportPlanBody, type ImportReview, type ImportReviewRow, type ImportTable, type RowOutcome, type TransferColumn,
} from '../../shared/recordTransfer';

const OUTCOME: Record<RowOutcome, { label: string; tone: Tone }> = {
  new: { label: 'New', tone: 'good' },
  update: { label: 'Updates yours', tone: 'accent' },
  unchanged: { label: 'Unchanged', tone: 'neutral' },
  present: { label: 'Already in Vantage', tone: 'neutral' },
  duplicate: { label: 'Looks like one you have', tone: 'warn' },
  problem: { label: 'Needs a fix', tone: 'bad' },
  excluded: { label: 'Left out', tone: 'neutral' },
  not_imported: { label: 'Not imported', tone: 'neutral' },
};
const SOURCE: Record<ImportReview['source'], string> = { vantage_json: 'Vantage export (JSON)', vantage_zip: 'Vantage export (ZIP)', csv: 'Spreadsheet (CSV)', xlsx: 'Workbook (Excel)' };
const ATTENTION: RowOutcome[] = ['problem', 'duplicate', 'update'];
const SHOWN = 100;
const label = (t: ImportTable | 'duty') => (t === 'duty' ? 'Duty' : TABLE_LABELS[t].many);
const one = (t: ImportTable) => TABLE_LABELS[t].one;
const counted = (n: number, t: ImportTable) => `${n} ${n === 1 ? one(t) : TABLE_LABELS[t].many.toLowerCase()}`;

/**
 * Bring records in from a Vantage export or any spreadsheet (ADR-0019): the server reads the file, says what each row is
 * and where it goes, and writes nothing until the person has seen it. Each record keeps its type; a row that only reads
 * like another type is offered as that type, never moved for them (ADR-0015).
 */
export default function RecordImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [review, setReview] = useState<ImportReview | null>(null);
  const [plan, setPlan] = useState<ImportPlanBody>({});
  const [busy, setBusy] = useState<'stage' | 'plan' | 'commit' | 'undo' | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [mappingOpen, setMappingOpen] = useState<string | null>(null);
  const resultHeading = useRef<HTMLHeadingElement | null>(null);
  const reset = () => { setReview(null); setPlan({}); setError(''); setFilter('all'); setOpenRow(null); setMappingOpen(null); };
  useEffect(() => { if (!open) { setReview(null); setPlan({}); setError(''); setOpenRow(null); setMappingOpen(null); } }, [open]);
  // The import button that held focus is gone once it ran: focus goes to what it did.
  const done = review && review.status !== 'staged';
  useEffect(() => { if (done) { const t = window.setTimeout(() => resultHeading.current?.focus(), 0); return () => window.clearTimeout(t); } }, [done]);

  const refresh = () => { invalidateDomains(qc, 'activity', 'training', 'award', 'counseling', 'goal', 'task', 'project', 'career'); qc.invalidateQueries({ queryKey: keys.me }); qc.invalidateQueries({ queryKey: ['record-imports'] }); };

  // Only the review of the latest choice is shown, and Import waits for it: an earlier answer arriving late is dropped.
  const latest = useRef(0);
  const stage = async (file: File) => {
    latest.current += 1;
    setError(''); setBusy('stage');
    try { const r = await api.stageRecordImport(file); setReview(r); setPlan({}); setFilter(r.rows.length > 30 && r.rows.some((x) => ATTENTION.includes(x.outcome)) ? 'attention' : 'all'); }
    catch (e) { setError(api.errorText(e)); }
    finally { setBusy(null); }
  };
  const replan = async (next: ImportPlanBody) => {
    if (!review) return;
    const asked = ++latest.current;
    setPlan(next); setBusy('plan');
    try { const r = await api.planRecordImport(review.id, next); if (asked === latest.current) setReview(r); }
    catch (e) { if (asked === latest.current) toast.error(api.errorText(e)); }
    finally { if (asked === latest.current) setBusy(null); }
  };
  const choose = (ref: string, choice: NonNullable<ImportPlanBody['rows']>[string]) => replan({ ...plan, rows: { ...plan.rows, [ref]: { ...plan.rows?.[ref], ...choice } } });
  const commit = async () => {
    if (!review) return;
    setBusy('commit');
    try { const r = await api.commitRecordImport(review.id, { ...plan, expected: { new: review.counts.new, update: review.counts.update } }); setReview(r); refresh(); toast.success('Imported.'); }
    catch (e) {
      toast.error(api.errorText(e));
      // The account changed since the review: show the review as it is now.
      if (e instanceof api.ApiError && e.code === 'import_changed') { try { setReview(await api.planRecordImport(review.id, plan)); } catch { /* the toast said it */ } }
    }
    finally { setBusy(null); }
  };
  const undo = async () => {
    if (!review) return;
    setBusy('undo');
    try { setReview(await api.undoRecordImport(review.id)); refresh(); toast.success('Import undone.'); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(null); }
  };
  // A file read and not imported is let go: it would lapse on its own, and only one waits at a time.
  const release = async () => { if (review?.status === 'staged') { try { await api.cancelRecordImport(review.id); } catch { /* it lapses on its own */ } } };
  const close = async () => { await release(); onOpenChange(false); };

  const groups = useMemo(() => {
    const rows = (review?.rows ?? []).filter((r) => filter === 'all' || ATTENTION.includes(r.outcome) || r.suggestion);
    const by = new Map<ImportTable | 'duty', ImportReviewRow[]>();
    for (const r of rows) by.set(r.as, [...(by.get(r.as) ?? []), r]);
    return [...by.entries()].sort(([a], [b]) => (a === 'duty' ? 99 : IMPORT_TABLES.indexOf(a)) - (b === 'duty' ? 99 : IMPORT_TABLES.indexOf(b)));
  }, [review, filter]);
  const writes = review ? review.counts.new + review.counts.update : 0;
  const profileWrites = review?.profile?.changes.filter((c) => c.action === 'fill' || c.action === 'replace').length ?? 0;
  const fileWrites = review?.attachments.included ?? 0;
  const suggested = review?.rows.filter((r) => r.suggestion && r.as === 'activities' && (r.outcome === 'new' || r.outcome === 'update')).length ?? 0;

  const footer = !review ? <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
    : review.status === 'staged' ? <><Button variant="ghost" onClick={close}>Cancel import</Button><Button variant="primary" onClick={commit} loading={busy === 'commit'} disabled={Boolean(busy) || writes + profileWrites + fileWrites === 0}>{writes ? `Import ${writes} ${writes === 1 ? 'record' : 'records'}` : 'Import'}</Button></>
      : <>{review.status === 'imported' && <Button onClick={undo} loading={busy === 'undo'}><Undo2 className="h-4 w-4" />Undo this import</Button>}<Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button></>;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); else onOpenChange(o); }} title="Import records" size="xl"
      description="From a Vantage export or any spreadsheet. Awards come in as awards, training as training, counselings as counselings; nothing is written until you import." footer={footer}>
      {!review ? (
        <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-line px-4 py-10 text-center transition-colors hover:border-accent hover:bg-accent-soft/30" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) stage(f); }}>
          <FileUp className="h-6 w-6 text-ink-3" aria-hidden />
          <span className="text-sm font-medium text-ink">{busy === 'stage' ? 'Reading the file…' : 'Drop a file here, or click to choose'}</span>
          <span className="max-w-md text-xs text-ink-3">A Vantage export (.json or .zip), a CSV, or an Excel workbook with a sheet per record type. Vantage reads it, shows what each row is and where it goes, and you decide.</span>
          <input type="file" aria-label="Choose a file to import" accept=".json,.zip,.csv,.tsv,.xlsx,application/json,application/zip,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="sr-only" disabled={busy === 'stage'} onChange={(e) => { const f = e.target.files?.[0]; if (f) stage(f); e.target.value = ''; }} />
          {error && <span role="alert" className="mt-2 text-xs text-bad">{error}</span>}
        </label>
      ) : review.status !== 'staged' ? (
        <Results review={review} suggested={suggested} headingRef={resultHeading} onLeave={() => onOpenChange(false)} />
      ) : (
        <div className={cn('space-y-4', busy === 'plan' && 'opacity-70')} aria-busy={busy === 'plan'}>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="accent">{review.filename || 'File'}</Badge><span className="text-ink-3">{SOURCE[review.source]}{review.exported?.exported_at ? ` · exported ${review.exported.exported_at.slice(0, 10)}` : ''}{review.exported?.username ? ` by @${review.exported.username}` : ''}</span>
            <Button size="xs" variant="ghost" className="ml-auto" onClick={async () => { await release(); reset(); }}>Choose another file</Button>
          </div>
          {review.notes.length > 0 && <ul className="space-y-1 rounded-md border border-info/30 bg-info/5 p-3 text-xs text-ink-2">{review.notes.map((n) => <li key={n} className="flex gap-2"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" aria-hidden />{n}</li>)}</ul>}

          <p className="text-sm text-ink-2" aria-live="polite">
            {(['new', 'update', 'present', 'duplicate', 'problem', 'not_imported', 'excluded', 'unchanged'] as RowOutcome[]).filter((o) => review.counts[o]).map((o, i) => <span key={o}>{i > 0 && ' · '}<strong className="text-ink">{review.counts[o]}</strong> {OUTCOME[o].label.toLowerCase()}</span>)}
            {!review.rows.length && 'No records in this file.'}
          </p>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div><p className="mb-1 text-xs font-semibold text-ink-2">Who sees them</p>
              <Segmented label="Who sees them" value={plan.placement ?? 'keep'} onChange={(v) => replan({ ...plan, placement: v })} options={[{ value: 'keep', label: 'As the file says' }, { value: 'private', label: 'Only me' }]} />
              <p className="mt-1 text-2xs text-ink-3">A record shared with a unit you cannot share in here comes in private.</p></div>
            {review.profile && <Field label="Your profile" hint="Name, rank, MOS, EAS, PFT, CFT and the rest of readiness"><Select value={plan.profile ?? review.profile.mode} onValueChange={(v) => replan({ ...plan, profile: v as 'skip' | 'fill' | 'replace' })} options={[{ value: 'fill', label: 'Fill in what is empty' }, { value: 'replace', label: 'Replace with the file’s' }, { value: 'skip', label: 'Leave it as it is' }]} /></Field>}
            {review.attachments.total > 0 && <div className="pt-1"><Switch checked={plan.attachments !== false} onChange={(v) => replan({ ...plan, attachments: v })} disabled={!review.attachments.enabled} label={`Bring in the files (${review.attachments.included} of ${review.attachments.total})`} description={review.attachments.enabled ? 'Each one is scanned, and goes on the record it came with.' : 'Attachments are turned off on Vantage.'} /></div>}
          </div>

          {(review.source === 'csv' || review.source === 'xlsx') && review.sheets.length > 0 && (
            <section aria-labelledby="ri-sheets">
              <h3 id="ri-sheets" className="mb-2 text-xs font-semibold text-ink-2">{review.sheets.length === 1 ? 'What the file holds' : 'What each sheet holds'}</h3>
              <ul className="divide-y divide-line rounded-md border border-line">
                {review.sheets.map((s) => {
                  const typed = s.headers.some(isRecordTypeHeader);
                  const table = s.table;
                  return (
                    <li key={s.name} className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="min-w-0 flex-1 truncate font-medium text-ink">{s.name}</span><span className="fig text-xs text-ink-3">{s.rows} {s.rows === 1 ? 'row' : 'rows'}</span>
                        <Select aria-label={`Read ${s.name} as`} className="h-8 w-56 text-xs" value={table} onValueChange={(v) => replan({ ...plan, sheets: { ...plan.sheets, [s.name]: v === 'record_type' ? {} : { ...plan.sheets?.[s.name], table: v as ImportTable | 'skip' | 'duty' | 'profile', mapping: undefined } } })}
                          options={[...(typed ? [{ value: 'record_type', label: 'Each row by its Record Type' }] : []), ...IMPORT_TABLES.map((t) => ({ value: t, label: label(t) })), { value: 'profile', label: 'Profile and readiness' }, { value: 'duty', label: 'Duty (listed, not imported)' }, { value: 'skip', label: 'Leave this sheet out' }]} />
                        {isImportTable(table) && <Button size="xs" variant="ghost" aria-expanded={mappingOpen === s.name} onClick={() => setMappingOpen(mappingOpen === s.name ? null : s.name)}>Columns</Button>}
                      </div>
                      {mappingOpen === s.name && isImportTable(table) && <ColumnMapping sheet={s} table={table} onChange={(mapping) => replan({ ...plan, sheets: { ...plan.sheets, [s.name]: { ...plan.sheets?.[s.name], table, mapping } } })} />}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {review.rows.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-ink-2">Records</h3>
              <Segmented size="sm" label="Show" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'attention', label: 'Needs a look' }]} />
            </div>
          )}
          {groups.map(([table, rows]) => <RowGroup key={table} table={table} rows={rows} openRow={openRow} setOpenRow={setOpenRow} choose={choose} disabled={Boolean(busy)} />)}
          {filter === 'attention' && review.rows.length > 0 && !groups.length && <p className="text-sm text-ink-3">Nothing needs a look. Everything reads as it should.</p>}

          {review.profile && review.profile.changes.length > 0 && (
            <section aria-labelledby="ri-profile">
              <h3 id="ri-profile" className="mb-2 text-xs font-semibold text-ink-2">Profile and readiness</h3>
              <ul className="divide-y divide-line rounded-md border border-line text-sm">
                {review.profile.changes.map((c) => (
                  <li key={c.field} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5">
                    <span className="w-40 shrink-0 text-ink-2">{c.label}</span>
                    <span className="min-w-0 flex-1 text-ink">{c.incoming}{c.current && c.action !== 'same' ? <span className="text-ink-3"> (now {c.current})</span> : null}</span>
                    <Badge tone={c.action === 'fill' || c.action === 'replace' ? 'good' : c.action === 'refused' ? 'warn' : 'neutral'}>{c.action === 'fill' ? 'Fills it in' : c.action === 'replace' ? 'Replaces it' : c.action === 'same' ? 'Same' : c.action === 'kept' ? 'Kept as is' : 'Not changed'}</Badge>
                    {c.reason && <span className="basis-full text-2xs text-ink-3">{c.reason}</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {review.attachments.problems.length > 0 && (
            <section aria-labelledby="ri-files" className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm">
              <h3 id="ri-files" className="flex items-center gap-2 font-medium text-ink"><AlertTriangle className="h-4 w-4 text-warn" aria-hidden />{review.attachments.problems.length === 1 ? 'One file stays out' : `${review.attachments.problems.length} files stay out`}</h3>
              <ul className="mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-ink-2">{review.attachments.problems.slice(0, 50).map((p, i) => <li key={`${p.name}-${i}`}>{p.name}: {p.reason}</li>)}</ul>
            </section>
          )}
          {review.notImported.length > 0 && (
            <section aria-labelledby="ri-not" className="rounded-md border border-line bg-surface-2/60 p-3 text-sm">
              <h3 id="ri-not" className="font-medium text-ink">Kept in the file, not imported</h3>
              <ul className="mt-1 space-y-1 text-xs text-ink-2">{review.notImported.map((n) => <li key={n.key}><strong className="text-ink">{n.label}</strong>{n.count ? ` (${n.count})` : ''}: {n.reason}</li>)}</ul>
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}

function RowGroup({ table, rows, openRow, setOpenRow, choose, disabled }: { table: ImportTable | 'duty'; rows: ImportReviewRow[]; openRow: string | null; setOpenRow: (r: string | null) => void; choose: (ref: string, c: { include?: boolean; as?: ImportTable; fix?: Record<string, unknown> }) => void; disabled: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, SHOWN);
  const id = `ri-group-${table}`;
  return (
    <section aria-labelledby={id}>
      <h4 id={id} className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-ink">{label(table)}<span className="fig text-xs font-normal text-ink-3">{rows.length}</span></h4>
      <ul className="divide-y divide-line rounded-md border border-line">
        {shown.map((r) => {
          const expanded = openRow === r.ref;
          const canChoose = r.as !== 'duty' && (r.outcome !== 'present' && r.outcome !== 'unchanged');
          return (
            <li key={r.ref} className="px-3 py-2 text-sm">
              <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                <input type="checkbox" className="mt-1" checked={r.include} disabled={!r.toggle || disabled} onChange={(e) => choose(r.ref, { include: e.target.checked })} aria-label={`Import ${r.title || 'this row'}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-ink">{r.title || <span className="text-ink-3">Untitled</span>}</p>
                  <p className="text-xs text-ink-3">{[r.date, r.source, r.as !== r.from ? `read as ${r.from === 'duty' ? 'duty' : one(r.from)}` : '', r.placement === 'private' ? 'comes in private' : '', r.author ? `by ${r.author}` : ''].filter(Boolean).join(' · ')}</p>
                  {r.reason && <p className={cn('mt-0.5 text-xs', r.outcome === 'problem' ? 'text-bad' : 'text-ink-2')}>{r.reason}</p>}
                  {r.duplicateOf && <p className="mt-0.5 text-xs text-ink-3">Yours: {r.duplicateOf.title}</p>}
                  {r.suggestion && r.as === 'activities' && (
                    <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-2">{r.suggestion.why} It stays an activity unless you say otherwise.
                      <Button size="xs" variant="soft" disabled={disabled} onClick={() => choose(r.ref, { as: r.suggestion!.to })}>Import as {one(r.suggestion.to)}</Button></p>
                  )}
                </div>
                <span className="flex shrink-0 items-center gap-2"><Badge tone={OUTCOME[r.outcome].tone}>{OUTCOME[r.outcome].label}</Badge>{canChoose && <Button size="xs" variant="ghost" aria-expanded={expanded} onClick={() => setOpenRow(expanded ? null : r.ref)}>{r.outcome === 'problem' ? 'Fix' : 'Change'}</Button>}</span>
              </div>
              {expanded && canChoose && <RowEditor row={r} disabled={disabled} onApply={(c) => { choose(r.ref, c); setOpenRow(null); }} />}
            </li>
          );
        })}
      </ul>
      {rows.length > shown.length && <Button size="xs" variant="ghost" className="mt-1" onClick={() => setAll(true)}>Show all {rows.length}</Button>}
    </section>
  );
}

/** What a row is and what it says: the type it goes in as, and the fields the review could not read. */
function RowEditor({ row, disabled, onApply }: { row: ImportReviewRow; disabled: boolean; onApply: (c: { as?: ImportTable; fix?: Record<string, unknown> }) => void }) {
  const as = row.as === 'duty' ? 'activities' : row.as;
  const [target, setTarget] = useState<ImportTable>(as);
  const wrong = Object.keys(row.fieldErrors ?? {}).filter((k) => k !== 'record_type');
  const columns = RECORD_COLUMNS[target].filter((c) => wrong.includes(c.key));
  const [fix, setFix] = useState<Record<string, string>>(() => Object.fromEntries(columns.map((c) => [c.key, row.fields[c.key] == null ? '' : String(row.fields[c.key])])));
  const apply = () => {
    const values = Object.fromEntries(columns.map((c) => [c.key, valueOf(c, fix[c.key] ?? '')]));
    // A row whose Record Type Vantage did not know is read as what the person says, even what it was first taken for.
    onApply({ ...(target !== row.as || row.fieldErrors?.record_type ? { as: target } : {}), ...(columns.length ? { fix: values } : {}) });
  };
  return (
    <div className="mt-2 space-y-2 rounded-md bg-surface-2/60 p-3">
      <Field label="Import it as"><Select value={target} onValueChange={(v) => setTarget(v as ImportTable)} options={IMPORT_TABLES.map((t) => ({ value: t, label: humanize(one(t)) }))} /></Field>
      {columns.map((c) => (
        <Field key={c.key} label={c.header} error={row.fieldErrors?.[c.key]}>
          {c.kind === 'enum' ? <Select value={fix[c.key] || ''} onValueChange={(v) => setFix((f) => ({ ...f, [c.key]: v }))} options={(c.values ?? []).map((v) => ({ value: v, label: humanize(v) }))} />
            : <Input type={c.kind === 'date' ? 'date' : c.kind === 'number' ? 'number' : 'text'} value={fix[c.key] ?? ''} onChange={(e) => setFix((f) => ({ ...f, [c.key]: e.target.value }))} />}
        </Field>
      ))}
      <div className="flex justify-end"><Button size="sm" variant="primary" disabled={disabled} onClick={apply}>Apply</Button></div>
    </div>
  );
}

const valueOf = (c: TransferColumn, v: string): unknown => (!v.trim() ? null : c.kind === 'number' ? Number(v) : c.kind === 'flag' ? (v ? 1 : 0) : v.trim());

function ColumnMapping({ sheet, table, onChange }: { sheet: ImportReview['sheets'][number]; table: ImportTable; onChange: (m: Record<string, string>) => void }) {
  return (
    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {RECORD_COLUMNS[table].map((c) => (
        <div key={c.key} className="flex items-center gap-2 text-sm"><span className="w-32 shrink-0 truncate text-ink-2">{c.header}</span>
          <Select aria-label={`Column for ${c.header}`} className="h-8 text-xs" value={sheet.mapping[c.key] || '__skip'} onValueChange={(v) => onChange({ ...sheet.mapping, [c.key]: v === '__skip' ? '' : v })} options={[{ value: '__skip', label: 'Not in this sheet' }, ...sheet.headers.filter((h) => !isRecordTypeHeader(h)).map((h) => ({ value: h, label: h }))]} />
        </div>
      ))}
    </div>
  );
}

function Results({ review, suggested, headingRef, onLeave }: { review: ImportReview; suggested: number; headingRef: React.RefObject<HTMLHeadingElement | null>; onLeave: () => void }) {
  const r = review.results;
  const made = Object.entries(r?.created ?? {}).filter(([t]) => isImportTable(t)) as Array<[ImportTable, number]>;
  const changed = Object.entries(r?.updated ?? {}).filter(([t]) => isImportTable(t)) as Array<[ImportTable, number]>;
  return (
    <div className="space-y-3 text-sm">
      <h3 ref={headingRef} tabIndex={-1} className="flex items-start gap-2 font-medium text-ink outline-none"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-good" aria-hidden />{review.status === 'undone' ? 'This import was undone.' : 'Imported.'}</h3>
      {review.status === 'undone' && r?.undone && <p className="text-ink-2">{r.undone.removed} {r.undone.removed === 1 ? 'record went' : 'records went'} to the recycle bin, {r.undone.restored} {r.undone.restored === 1 ? 'was' : 'were'} put back as they were{r.undone.kept ? `, and ${r.undone.kept} changed since the import ${r.undone.kept === 1 ? 'was' : 'were'} kept as ${r.undone.kept === 1 ? 'it is' : 'they are'}` : ''}.</p>}
      <ul className="space-y-1 text-ink-2">
        {made.length > 0 && <li>Added {made.map(([t, n]) => counted(n, t)).join(', ')}.</li>}
        {changed.length > 0 && <li>Updated {changed.map(([t, n]) => counted(n, t)).join(', ')}.</li>}
        {(r?.attachments ?? 0) > 0 && <li>Attached {r!.attachments} {r!.attachments === 1 ? 'file' : 'files'}.</li>}
        {(r?.profile.length ?? 0) > 0 && <li>Set {r!.profile.length} {r!.profile.length === 1 ? 'profile field' : 'profile fields'}.</li>}
        {(r?.skipped ?? 0) > 0 && <li>{r!.skipped} {r!.skipped === 1 ? 'row was' : 'rows were'} not imported.</li>}
        {!made.length && !changed.length && !r?.attachments && !r?.profile.length && <li>Nothing new was written.</li>}
      </ul>
      {review.status === 'imported' && suggested > 0 && <p className="text-ink-2">{suggested === 1 ? 'One activity reads' : `${suggested} activities read`} like an award or training. {suggested === 1 ? 'It stays' : 'They stay'} in Activities until you move {suggested === 1 ? 'it' : 'each one'}: Vantage offers the move on {suggested === 1 ? 'its' : 'each'} page. <Link to="/record/activities" onClick={onLeave} className="link">{placeName('/record/activities')}</Link></p>}
      {review.status === 'imported' && <p className="text-xs text-ink-3">Undo sends what this import added to the recycle bin and puts back what it changed, unless you change it again first.</p>}
    </div>
  );
}
