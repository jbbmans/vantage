import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileUp, Plus } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Panel, Skeleton, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { DescriptionList, Table } from '@/components/common';
import { withSudo } from '@/components/SudoDialog';
import { useToast } from '@/components/ui/toast';
import * as api from '@/lib/api';
import { formatStamp, todayIso } from '@/lib/utils';
import { formatNumber } from '../../shared/metrics';
import { CATALOG_FIELD_LABELS, CATALOG_HEADERS, MAX_CATALOG_BYTES, MAX_CATALOG_ROWS, STAGED_CATALOG_HOURS, type CatalogField, type CatalogLoadRecord, type CourseSourceRecord } from '../../shared/courses';
import { useAdmin } from './sections';

/**
 * Approved course sources (Task 22, ADR-0029): the authoritative sources whose published catalogs verify the course values
 * on trainings. Vantage holds no course list of its own and fetches none. A source is registered with the authorization
 * that approves it; its catalog file is loaded, looked at, then applied. Nothing is edited: a source is withdrawn with a
 * reason, a catalog replaced by a later one, and every step is audited and told to the other Vantage Administrators.
 */
export function CourseSources({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useAdmin<{ sources: CourseSourceRecord[] }>('course-sources', () => api.platformCourseSources());
  const [registering, setRegistering] = useState(false);
  const [withdrawing, setWithdrawing] = useState<CourseSourceRecord | null>(null);
  const [loading, setLoading] = useState<CourseSourceRecord | null>(null);
  const [browsing, setBrowsing] = useState<{ source: CourseSourceRecord; load: CatalogLoadRecord } | null>(null);
  // Each dialog opens empty: a new key on every opening, so nothing typed or chosen before is left in it.
  const [round, setRound] = useState(0);
  const opening = () => setRound((r) => r + 1);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'course-sources'] });
  const act = async (label: string, fn: () => Promise<unknown>) => {
    try { await withSudo(fn); toast.success(label); refresh(); return true; } catch (e) { toast.error(api.errorText(e)); return false; }
  };
  if (q.isPending) return <Skeleton className="h-64" />;
  if (q.isError || !q.data) return <Panel title="Approved course sources"><p className="text-sm text-bad">{api.errorText(q.error)}</p></Panel>;
  const live = q.data.sources.filter((s) => !s.withdrawn_at);
  const withdrawn = q.data.sources.filter((s) => s.withdrawn_at);
  return (
    <div className="space-y-5">
      <Panel title="In use" subtitle="A course code on a training is looked up in the catalog applied for each of these. A value is verified only when it is what that catalog lists; anything else is kept as manual."
        action={canEdit ? <Button size="sm" variant="primary" onClick={() => { opening(); setRegistering(true); }}><Plus className="h-4 w-4" />Register a source</Button> : undefined}>
        {!live.length ? (
          <EmptyState title="No approved source" description="Until one is registered and its catalog applied, every course value on a training is manual. Register a source only with the document that approves it for Vantage; never a list found online." />
        ) : (
          <div className="space-y-4">{live.map((s) => (
            <SourceCard key={s.id} source={s} canEdit={canEdit} onLoad={() => { opening(); setLoading(s); }} onWithdraw={() => { opening(); setWithdrawing(s); }} onBrowse={(load) => setBrowsing({ source: s, load })}
              onApply={(load) => act('Applied. Lookups answer from it now; the catalog it replaced is kept.', () => api.platformApplyCatalog(s.id, load.id, load.file_sha256))}
              onDiscard={(load) => act('Discarded. Nothing was answered from it.', () => api.platformDiscardCatalog(s.id, load.id))} />
          ))}</div>
        )}
      </Panel>
      {withdrawn.length > 0 && (
        <Panel title="Withdrawn" subtitle="Their catalogs verify nothing now. What was verified against them before stays verified, and says the source was withdrawn.">
          <div className="space-y-4">{withdrawn.map((s) => <SourceCard key={s.id} source={s} canEdit={false} onBrowse={(load) => setBrowsing({ source: s, load })} />)}</div>
        </Panel>
      )}
      <RegisterDialog key={`register-${round}`} open={registering} onClose={() => setRegistering(false)}
        onSave={async (body) => { if (await act('Registered. Load its catalog to start verifying courses.', () => api.platformRegisterCourseSource(body))) setRegistering(false); }} />
      <WithdrawDialog key={`withdraw-${round}`} source={withdrawing} onClose={() => setWithdrawing(null)}
        onWithdraw={async (reason) => { if (withdrawing && await act('Withdrawn. It is kept with your reason.', () => api.platformWithdrawCourseSource(withdrawing.id, reason))) setWithdrawing(null); }} />
      <LoadDialog key={`load-${round}`} source={loading} onClose={() => setLoading(null)}
        onLoad={async (file, asOf) => { if (loading && await act('Read. Look at what it would change, then apply it.', () => api.platformStageCatalog(loading.id, file, asOf))) setLoading(null); }} />
      <BrowseDialog target={browsing} onClose={() => setBrowsing(null)} />
    </div>
  );
}

function SourceCard({ source: s, canEdit, onLoad, onWithdraw, onBrowse, onApply, onDiscard }: {
  source: CourseSourceRecord; canEdit: boolean; onLoad?: () => void; onWithdraw?: () => void; onBrowse: (load: CatalogLoadRecord) => void;
  onApply?: (load: CatalogLoadRecord) => void; onDiscard?: (load: CatalogLoadRecord) => void;
}) {
  return (
    <article className="rounded border border-line p-4" aria-label={s.name}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-ink">{s.name}</h3>
          <p className="text-xs text-ink-3">Published by {s.authority}</p>
        </div>
        {canEdit && <div className="flex gap-2"><Button size="sm" onClick={onLoad}><FileUp className="h-4 w-4" />Load its catalog</Button><Button size="sm" variant="ghost" onClick={onWithdraw}>Withdraw</Button></div>}
      </div>
      <div className="mt-3"><DescriptionList items={[
        ['Approved by', `${s.approved_by}, ${s.approved_on}`], ['Approval', s.approval_reference], ['Notes', s.notes],
        ['Registered', `${s.recorded_by_name ?? 'A former member'}, ${formatStamp(s.recorded_at)}`],
        ['Withdrawn', s.withdrawn_at ? `${s.withdrawn_by_name ?? 'A former member'}, ${formatStamp(s.withdrawn_at)}: ${s.withdrawn_reason}` : null],
      ]} /></div>
      {s.staged && <StagedLoad load={s.staged} canEdit={canEdit} onApply={onApply} onDiscard={onDiscard} onBrowse={() => onBrowse(s.staged!)} />}
      <div className="mt-3 text-sm">
        {s.current ? (
          <p className="text-ink-2">{s.withdrawn_at ? <Badge tone="neutral">Verifies nothing now</Badge> : <Badge tone="good">In use</Badge>} <span className="ml-1">{s.withdrawn_at ? 'Its last catalog, as of' : 'Catalog as of'} {s.current.as_of}: {count(s.current.courses, 'course')}, from {s.current.file_name}, applied by {s.current.applied_by_name ?? 'a former member'} {formatStamp(s.current.applied_at)}.</span>{' '}
            <Button size="xs" variant="ghost" onClick={() => onBrowse(s.current!)}>Browse</Button></p>
        ) : <p className="text-ink-3">No catalog applied yet: it answers no lookup.</p>}
        {s.history.length > 0 && (
          <details className="mt-2"><summary className="cursor-pointer text-xs text-ink-3">Earlier catalogs ({formatNumber(s.history_total)}{s.history_total > s.history.length ? `, the latest ${formatNumber(s.history.length)} shown` : ''})</summary>
            <ul className="mt-1 space-y-1 text-xs text-ink-3">{s.history.map((h) => (
              <li key={h.id}>As of {h.as_of}: {count(h.courses, 'course')}, {h.file_name}, applied {formatStamp(h.applied_at)}, replaced {formatStamp(h.superseded_at)}. <Button size="xs" variant="ghost" onClick={() => onBrowse(h)}>Browse</Button></li>
            ))}</ul>
          </details>
        )}
      </div>
    </article>
  );
}

const COLUMN_ORDER = Object.keys(CATALOG_FIELD_LABELS) as CatalogField[];
/** "1 course", "2 courses". */
const count = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;

function StagedLoad({ load, canEdit, onApply, onDiscard, onBrowse }: { load: CatalogLoadRecord; canEdit: boolean; onApply?: (l: CatalogLoadRecord) => void; onDiscard?: (l: CatalogLoadRecord) => void; onBrowse: () => void }) {
  const p = load.preview;
  return (
    <section className="mt-3 rounded border border-accent/40 bg-accent-soft/20 p-3" aria-label="Catalog waiting to be applied">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 text-sm">
          <p className="font-medium text-ink">Waiting to be applied: {load.file_name}, as of {load.as_of}</p>
          <p className="text-xs text-ink-3">Read by {load.staged_by_name ?? 'a former member'} {formatStamp(load.staged_at)}. Discarded if it is not applied within {STAGED_CATALOG_HOURS} hours.</p>
        </div>
        {canEdit && <div className="flex gap-2"><Button size="sm" variant="primary" onClick={() => onApply?.(load)}>Apply it</Button><Button size="sm" variant="ghost" onClick={() => onDiscard?.(load)}>Discard</Button></div>}
      </div>
      <p className="mt-2 text-sm text-ink-2">
        {count(p.courses, 'course')} from {count(p.rows, 'row')}{p.sheet ? ` on the sheet “${p.sheet}”` : ''}. Against the catalog in use: {formatNumber(p.added)} added, {formatNumber(p.changed)} changed, {formatNumber(p.unchanged)} unchanged, {formatNumber(p.removed)} no longer listed.
        {p.left_out > 0 && <> <strong className="text-warn">{count(p.left_out, 'row')} left out.</strong></>}
        {' '}<Button size="xs" variant="ghost" onClick={onBrowse}>Browse</Button>
      </p>
      <p className="mt-1 text-xs text-ink-3">Columns read: {COLUMN_ORDER.filter((f) => p.columns[f]).map((f) => `${CATALOG_FIELD_LABELS[f]} from “${p.columns[f]}”`).join(', ')}.{p.ignored_columns.length ? ` Not used: ${p.ignored_columns.join(', ')}.` : ''}</p>
      {p.removed > 0 && <p className="mt-1 text-xs text-ink-3">A course no longer listed stops being verified for new entries. Trainings already verified against the catalog in use keep what was verified.</p>}
      {p.problems.length > 0 && (
        <details className="mt-2"><summary className="cursor-pointer text-xs text-ink-3">Rows left out{p.left_out > p.problems.length ? ` (the first ${p.problems.length})` : ''}</summary>
          <Table head={<><th className="w-16">Line</th><th className="w-32">Code</th><th>Why</th></>}>
            {p.problems.map((x) => <tr key={`${x.line}-${x.reason}`}><td className="fig text-xs">{x.line}</td><td className="text-xs">{x.code ?? ''}</td><td className="text-xs">{x.reason}</td></tr>)}
          </Table>
        </details>
      )}
    </section>
  );
}

const EMPTY_SOURCE = { name: '', authority: '', approval_reference: '', approved_by: '', approved_on: '', notes: '' };

function RegisterDialog({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (body: typeof EMPTY_SOURCE) => void }) {
  const [d, setD] = useState(EMPTY_SOURCE);
  const close = () => { setD(EMPTY_SOURCE); onClose(); };
  const set = (k: keyof typeof EMPTY_SOURCE) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setD({ ...d, [k]: e.target.value });
  const ready = d.name.trim() && d.authority.trim() && d.approval_reference.trim() && d.approved_by.trim() && d.approved_on;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }} title="Register an approved course source"
      description="Only a source an authorization approves for Vantage: name the document, memo or ticket, who approved it and when. It is never edited; withdraw it and register it again to change it."
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" disabled={!ready} onClick={() => { onSave(d); }}>Register it</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Source" required hint="as its publisher names it"><Input maxLength={120} value={d.name} onChange={set('name')} placeholder="MarineNet course catalog" /></Field>
        <Field label="Published by" required><Input maxLength={200} value={d.authority} onChange={set('authority')} placeholder="TECOM, College of Distance Education and Training" /></Field>
        <Field label="Approval" required hint="document, memo or ticket" className="sm:col-span-2"><Input maxLength={300} value={d.approval_reference} onChange={set('approval_reference')} /></Field>
        <Field label="Approved by" required hint="as that document names them"><Input maxLength={200} value={d.approved_by} onChange={set('approved_by')} /></Field>
        <Field label="Approved on" required><Input type="date" max={todayIso()} value={d.approved_on} onChange={set('approved_on')} /></Field>
        <Field label="Notes" hint="optional" className="sm:col-span-2"><Textarea rows={2} maxLength={1000} value={d.notes} onChange={set('notes')} /></Field>
      </div>
    </Dialog>
  );
}

function WithdrawDialog({ source, onClose, onWithdraw }: { source: CourseSourceRecord | null; onClose: () => void; onWithdraw: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const close = () => { setReason(''); onClose(); };
  return (
    <Dialog open={Boolean(source)} onOpenChange={(o) => { if (!o) close(); }} size="sm" title={`Withdraw ${source?.name ?? 'this source'}`}
      description="Its catalog stops answering lookups and verifies nothing new. What was verified against it stays verified, and says the source was withdrawn and why."
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="danger" disabled={!reason.trim()} onClick={() => { onWithdraw(reason.trim()); setReason(''); }}>Withdraw it</Button></>}>
      <Field label="Why" required><Input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </Dialog>
  );
}

function LoadDialog({ source, onClose, onLoad }: { source: CourseSourceRecord | null; onClose: () => void; onLoad: (file: File, asOf: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [asOf, setAsOf] = useState(todayIso());
  const close = () => { setFile(null); setAsOf(todayIso()); onClose(); };
  const tooLarge = Boolean(file && file.size > MAX_CATALOG_BYTES);
  return (
    <Dialog open={Boolean(source)} onOpenChange={(o) => { if (!o) close(); }} title={`Load the catalog of ${source?.name ?? 'this source'}`}
      description="The file the source publishes, as it publishes it. Vantage reads it, scans it and shows what it would change; it answers lookups only once you apply it."
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="primary" disabled={!file || !asOf || tooLarge} onClick={() => { if (file) onLoad(file, asOf); }}>Read it</Button></>}>
      <div className="space-y-3">
        <Field label="Catalog file" required hint={`.xlsx, .csv or .tsv, up to ${MAX_CATALOG_BYTES / 1_048_576} MB and ${formatNumber(MAX_CATALOG_ROWS)} courses`} error={tooLarge ? 'That file is too large.' : null}>
          <Input type="file" accept=".xlsx,.csv,.tsv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Catalog as of" required hint="the day the source's data is as of"><Input type="date" max={todayIso()} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <p className="text-xs text-ink-3">Vantage reads a course code column ({CATALOG_HEADERS.code.slice(0, 3).join(', ')}…) and a name column ({CATALOG_HEADERS.name.slice(0, 3).join(', ')}…), and provider, description, hours, CEUs, category, requirements, ranks and MOS where the file has them. A row it cannot read is left out and said to be; a course listed twice with different values is left out.</p>
      </div>
    </Dialog>
  );
}

function BrowseDialog({ target, onClose }: { target: { source: CourseSourceRecord; load: CatalogLoadRecord } | null; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const query = useQuery({
    queryKey: ['admin', 'course-entries', target?.load.id, q, offset],
    queryFn: () => withSudo(() => api.platformCatalogEntries(target!.source.id, target!.load.id, q, offset)),
    enabled: Boolean(target), retry: false,
  });
  const close = () => { setQ(''); setOffset(0); onClose(); };
  const data = query.data;
  return (
    <Dialog open={Boolean(target)} onOpenChange={(o) => { if (!o) close(); }} size="xl" title={target ? `${target.source.name}, catalog as of ${target.load.as_of}` : ''}
      description={target ? `${count(target.load.courses, 'course')} from ${target.load.file_name}${target.load.status === 'staged' ? ', not applied yet' : target.load.status === 'superseded' ? ', since replaced' : ''}.` : undefined}>
      <div className="space-y-3">
        <Field label="Find a course" hint="by code or name"><Input value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} maxLength={200} /></Field>
        {query.isPending ? <Skeleton className="h-40" /> : query.isError ? <p className="text-sm text-bad">{api.errorText(query.error)}</p> : !data?.entries.length ? <EmptyState title="No course matches" /> : (
          <>
            <Table head={<><th className="w-32">Code</th><th>Name</th><th className="w-40">Provider</th><th className="w-20 text-right">Hours</th><th className="w-20 text-right">CEUs</th><th className="w-32">Category</th></>}>
              {data.entries.map((e) => <tr key={e.entry_id}><td className="text-xs">{e.code}</td><td className="text-sm">{e.name}</td><td className="text-xs">{e.provider ?? ''}</td><td className="fig text-right text-xs">{e.hours ?? ''}</td><td className="fig text-right text-xs">{e.ceus ?? ''}</td><td className="text-xs">{e.category ?? ''}</td></tr>)}
            </Table>
            <div className="flex items-center justify-between text-xs text-ink-3">
              <span>{formatNumber(data.offset + 1)}–{formatNumber(data.offset + data.entries.length)} of {formatNumber(data.total)}</span>
              <span className="flex gap-2"><Button size="xs" disabled={data.offset === 0} onClick={() => setOffset(Math.max(0, data.offset - data.limit))}>Previous</Button><Button size="xs" disabled={data.offset + data.entries.length >= data.total} onClick={() => setOffset(data.offset + data.limit)}>Next</Button></span>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
