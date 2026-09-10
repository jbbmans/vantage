import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Check, Download, FileText, History, Plus, ShieldCheck, X } from 'lucide-react';
import { PageHeader, Button, Field, Input, Textarea, Select, Badge, EmptyState, Skeleton, Panel } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText } from '@/components/common';
import { useIdentity, useReportDrafts, useReportDraft } from '@/lib/queries';
import { AiAction, AiResult } from '@/components/AiPanel';
import * as api from '@/lib/api';
import { formatDollars, formatNumber, rangeForPeriod, dayKey } from '../../shared/metrics';
import { cn } from '@/lib/utils';

/**
 * Report Studio.
 *
 * A report makes claims about someone's work, so each section is written against records the author
 * picked, and the version of each record travels with the save. When a source changes between
 * writing and saving, the server refuses the save and names what moved. That refusal is a feature:
 * it is the only thing standing between a package and a sentence about facts that are no longer true.
 */

interface Section { heading: string; body: string; source_ids: string[] }

const BLANK_SECTIONS: Section[] = [
  { heading: 'Mission accomplishment', body: '', source_ids: [] },
  { heading: 'Leadership', body: '', source_ids: [] },
  { heading: 'Individual character', body: '', source_ids: [] },
];

export default function ReportStudio() {
  const [openId, setOpenId] = useState<string | null>(null);
  return openId ? <Editor id={openId} onBack={() => setOpenId(null)} /> : <DraftList onOpen={setOpenId} />;
}

function DraftList({ onOpen }: { onOpen: (id: string) => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const drafts = useReportDrafts();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [period, setPeriod] = useState('fiscalQuarter');
  const [busy, setBusy] = useState(false);

  const range = useMemo(() => rangeForPeriod(period), [period]);

  const create = async () => {
    setBusy(true);
    try {
      const draft = await api.createReportDraft({
        title: title.trim() || `${range.label} input`,
        period_start: dayKey(range.start), period_end: dayKey(range.end),
      });
      qc.invalidateQueries({ queryKey: ['report-drafts'] });
      setCreating(false); setTitle('');
      onOpen(draft.id);
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="page">
      <PageHeader eyebrow="Report Studio" title="Packages" lede="Each saved version records which facts it was built from. Exporting hands over exactly what was reviewed.">
        <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New report</Button>
      </PageHeader>

      {drafts.isPending ? <Skeleton className="h-40" /> : (drafts.data || []).length === 0 ? (
        <div className="card"><EmptyState icon={FileText} title="No reports yet" description="Start one for the period you are reporting on, then pull in the records it should cite." action={<Button variant="primary" onClick={() => setCreating(true)}>Start a report</Button>} /></div>
      ) : (
        <ul className="space-y-2">
          {(drafts.data || []).map((d: any) => (
            <li key={d.id}>
              <button type="button" onClick={() => onOpen(d.id)} className="flex w-full items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3 text-left transition-colors hover:border-line-strong hover:bg-surface-2">
                <FileText className="h-4 w-4 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{d.title}</span>
                  <span className="block text-xs text-ink-3">
                    <DateText value={d.period_start} /> to <DateText value={d.period_end} />
                    {d.subject_id !== identity?.user.id ? ' · for another Marine' : ''}
                  </span>
                </span>
                <Badge tone={d.latest_revision ? 'accent' : 'neutral'}>{d.latest_revision ? `Revision ${d.latest_revision}` : 'Not saved yet'}</Badge>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Dialog
        open={creating} onOpenChange={setCreating} title="Start a report" size="sm"
        description="Name it and pick the period it covers. Both can change before you save a revision."
        footer={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={create}>Start</Button></>}
      >
        <Field label="Title"><Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${range.label} input`} /></Field>
        <Field label="Period" hint={`${dayKey(range.start)} to ${dayKey(range.end)}`}>
          <Select value={period} onValueChange={setPeriod} options={[
            { value: 'fiscalQuarter', label: 'This fiscal quarter' },
            { value: 'fiscalYear', label: 'This fiscal year' },
            { value: 'last90', label: 'Last 90 days' },
            { value: 'year', label: 'This calendar year' },
          ]} />
        </Field>
      </Dialog>
    </div>
  );
}

function Editor({ id, onBack }: { id: string; onBack: () => void }) {
  const { data: identity } = useIdentity();
  const toast = useToast();
  const qc = useQueryClient();
  const query = useReportDraft(id);
  const [sections, setSections] = useState<Section[]>(BLANK_SECTIONS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [picker, setPicker] = useState(false);
  const [history, setHistory] = useState(false);
  const [stale, setStale] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const draft = query.data?.draft;
  const sources: any[] = useMemo(() => query.data?.sources || [], [query.data]);
  const drift: any[] = query.data?.drift || [];

  // The versions the author is writing against. Refreshed only when they choose to look again.
  const [versions, setVersions] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!query.data || loaded) return;
    const latest = query.data.latest;
    setTitle(query.data.draft.title);
    if (latest) {
      setSections(latest.sections.length ? latest.sections : BLANK_SECTIONS);
      setSelected(new Set(latest.source_snapshots.map((s: any) => s.id)));
      setVersions(Object.fromEntries(latest.source_snapshots.map((s: any) => [s.id, s.version])));
    }
    setLoaded(true);
  }, [query.data, loaded]);

  const sourceById = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const chosen = [...selected].map((sid) => sourceById.get(sid)).filter(Boolean);
  const [sectionAi, setSectionAi] = useState<Record<number, { output: Record<string, unknown>; meta: { model: string; tokens: number } }>>({});
  /** Only the records this report cites are sent. Nothing the report is not built from leaves the server. */
  const citedFacts = useMemo(() => chosen.map((s: any) => [
    s.title,
    s.date,
    s.quantity != null ? `${formatNumber(s.quantity)} ${s.unit_label || ''}`.trim() : '',
    s.dollar_amount != null ? `${formatDollars(s.dollar_amount)} ${s.dollar_type || ''}`.trim() : '',
    s.result || '',
  ].filter(Boolean).join(' · ')).join('\n'), [chosen]);

  const toggle = (sourceId: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(sourceId)) next.delete(sourceId);
    else {
      next.add(sourceId);
      const row = sourceById.get(sourceId);
      if (row) setVersions((v) => ({ ...v, [sourceId]: row.version }));
    }
    return next;
  });

  const acceptNewFacts = async () => {
    // The author says they have read the changed record, so their view becomes the current one.
    // The versions are taken from a fresh read: using the cached ones would resubmit the same
    // stale numbers and be refused again, which looks like the button not working.
    const fresh = await query.refetch();
    const current: any[] = fresh.data?.sources || sources;
    setVersions((v) => {
      const next = { ...v };
      for (const s of current) if (next[s.id] != null) next[s.id] = s.version;
      return next;
    });
    setStale(null);
    toast.success('Reading against the current facts.');
  };

  const save = async () => {
    setBusy(true);
    setStale(null);
    try {
      const payload = {
        title,
        note: note || null,
        base_revision: draft.latest_revision,
        sections: sections.map((s) => ({ heading: s.heading, body: s.body, source_ids: s.source_ids })),
        sources: [...selected].map((sid) => ({ table: sourceById.get(sid)?.table || 'activities', id: sid, version: versions[sid] ?? sourceById.get(sid)?.version ?? 1 })),
      };
      await api.saveReportRevision(id, payload);
      setNote('');
      qc.invalidateQueries({ queryKey: ['report-draft', id] });
      qc.invalidateQueries({ queryKey: ['report-drafts'] });
      toast.success('Saved as a new revision.');
    } catch (e) {
      const err = e as api.ApiError;
      if (err?.code === 'stale_sources') {
        setStale((err.extra?.stale as any[]) || []);
        toast.error('A record this report cites has changed. Review it before saving.');
      } else toast.error(api.errorText(e));
    } finally { setBusy(false); }
  };

  const exportRevision = async (revision: number) => {
    try {
      const name = await api.downloadFile(api.reportRevisionExportUrl(id, revision), `vantage-report-r${revision}.txt`);
      toast.success(`Downloaded ${name}.`);
    } catch (e) { toast.error(api.errorText(e)); }
  };

  if (query.isPending) return <div className="page space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-64" /></div>;
  if (!draft) return <div className="page"><div className="card"><EmptyState title="Cannot open this report" action={<Button onClick={onBack}>Back</Button>} /></div></div>;

  const mine = draft.user_id === query.data.draft.user_id;

  return (
    <div className="page">
      <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />All reports</button>
      <PageHeader
        eyebrow={`${draft.period_start} to ${draft.period_end}`}
        title={<input aria-label="Report title" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full bg-transparent text-inherit outline-none focus-visible:ring-2 focus-visible:ring-accent" />}
        lede={draft.latest_revision ? `Saved through revision ${draft.latest_revision}.` : 'Not saved yet. Pick the records this report is built from, then save a revision.'}
      >
        <Button onClick={() => setHistory(true)}><History className="h-4 w-4" />History</Button>
        {draft.latest_revision > 0 && <Button onClick={() => exportRevision(draft.latest_revision)}><Download className="h-4 w-4" />Export revision {draft.latest_revision}</Button>}
        <Button variant="primary" loading={busy} disabled={!mine || selected.size === 0} onClick={save}><Check className="h-4 w-4" />Save revision</Button>
      </PageHeader>

      {stale && stale.length > 0 && (
        <div className="card mb-4 border-warn/50 bg-warn/5 p-4" role="alert">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-ink"><AlertTriangle className="h-4 w-4 text-warn" />This was not saved</h2>
          <p className="mt-1 text-sm text-ink-2">The wording was written against facts that have since changed. Read the new facts, then save again.</p>
          <ul className="mt-2 space-y-1 text-xs">
            {stale.map((s) => (
              <li key={`${s.table}-${s.id}`} className="text-ink-2">
                <span className="font-medium text-ink">{s.title || s.id}</span>: {s.reason}
              </li>
            ))}
          </ul>
          <Button className="mt-3" onClick={acceptNewFacts}>I have read the updated facts</Button>
        </div>
      )}

      {drift.length > 0 && !stale && (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-3" />
          {drift.length} {drift.length === 1 ? 'record has' : 'records have'} changed since revision {draft.latest_revision} was saved. That revision still reads as it did; a new one would pick up the new facts.
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {sections.map((section, index) => (
            <Panel
              key={index}
              title={
                <input
                  aria-label={`Section ${index + 1} heading`}
                  value={section.heading}
                  onChange={(e) => setSections((prev) => prev.map((s, i) => (i === index ? { ...s, heading: e.target.value } : s)))}
                  className="w-full bg-transparent font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
                />
              }
              action={
                <>
                  {identity?.instance.aiEnabled && (
                    <AiAction
                      workflow="writing"
                      input={{ kind: 'executive_summary', source: `Section: ${section.heading}\n${citedFacts}`, limit: 1600 }}
                      label="Draft from the cited records"
                      disabled={chosen.length === 0}
                      onResult={(output, meta) => setSectionAi((prev) => ({ ...prev, [index]: { output, meta } }))}
                    />
                  )}
                  {sections.length > 1 && <Button size="xs" variant="ghost" onClick={() => setSections((prev) => prev.filter((_, i) => i !== index))} aria-label={`Remove ${section.heading}`}><X className="h-3.5 w-3.5" /></Button>}
                </>
              }
            >
              <Textarea
                aria-label={`${section.heading} text`}
                rows={Math.max(4, Math.ceil(section.body.length / 90))}
                value={section.body}
                onChange={(e) => setSections((prev) => prev.map((s, i) => (i === index ? { ...s, body: e.target.value } : s)))}
                placeholder="Write what changed because of the work, in the units it was measured in."
              />
              <p className="mt-1 text-2xs text-ink-3">{section.body.length.toLocaleString()} characters</p>
              {sectionAi[index] && (
                <div className="mt-3 space-y-2">
                  <AiResult output={sectionAi[index].output} meta={sectionAi[index].meta} primaryKey="draft" />
                  <div className="flex flex-wrap gap-2">
                    {typeof sectionAi[index].output.draft === 'string' && (
                      <Button size="xs" variant="soft" onClick={() => { const text = String(sectionAi[index].output.draft); setSections((prev) => prev.map((sec, i) => (i === index ? { ...sec, body: text } : sec))); }}>Use this text</Button>
                    )}
                    <Button size="xs" variant="ghost" onClick={() => setSectionAi((prev) => { const next = { ...prev }; delete next[index]; return next; })}>Dismiss</Button>
                  </div>
                </div>
              )}
            </Panel>
          ))}
          <Button onClick={() => setSections((prev) => [...prev, { heading: 'New section', body: '', source_ids: [] }])}><Plus className="h-4 w-4" />Add a section</Button>
        </div>

        <Panel title={`${chosen.length} cited ${chosen.length === 1 ? 'record' : 'records'}`} subtitle="every claim traces to one of these" action={<Button size="xs" variant="ghost" onClick={() => setPicker(true)}>Choose</Button>}>
          {chosen.length === 0 ? (
            <EmptyState title="Nothing cited yet" description="Pick the records this report is built from. A report cannot be saved without them." action={<Button onClick={() => setPicker(true)}>Choose records</Button>} />
          ) : (
            <ul className="space-y-2">
              {chosen.map((s: any) => {
                const moved = versions[s.id] != null && versions[s.id] !== s.version;
                return (
                  <li key={s.id} className={cn('rounded-md border px-3 py-2 text-sm', moved ? 'border-warn/50 bg-warn/5' : 'border-line')}>
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block truncate font-medium text-ink">{s.title}</span>
                        <span className="block text-xs text-ink-3">
                          <DateText value={s.date} />
                          {s.quantity != null ? ` · ${formatNumber(s.quantity)} ${s.unit_label || ''}` : ''}
                          {s.dollar_amount != null ? ` · ${formatDollars(s.dollar_amount)} ${s.dollar_type || ''}` : ''}
                        </span>
                      </span>
                      <Button size="xs" variant="ghost" onClick={() => toggle(s.id)} aria-label={`Remove ${s.title}`}><X className="h-3.5 w-3.5" /></Button>
                    </span>
                    {moved && <span className="mt-1 block text-2xs text-warn">This changed after you cited it.</span>}
                  </li>
                );
              })}
            </ul>
          )}
          <Field label="What changed in this revision" className="mt-4">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Tightened the mission section" />
          </Field>
        </Panel>
      </div>

      <Dialog
        open={picker} onOpenChange={setPicker} title="Choose the records this report cites" size="lg"
        description="Only records belonging to the person this report is about, inside its period."
        footer={<Button variant="primary" onClick={() => setPicker(false)}>Use {selected.size} selected</Button>}
      >
        {sources.length === 0 ? (
          <EmptyState title="Nothing in this period" description="Widen the report's period, or log the work first." />
        ) : (
          <ul className="divide-y divide-line">
            {sources.map((s: any) => (
              <li key={s.id}>
                <label className="flex cursor-pointer items-start gap-3 px-1 py-2.5 hover:bg-surface-2">
                  <input type="checkbox" className="mt-1" checked={selected.has(s.id)} onChange={() => toggle(s.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{s.title}</span>
                    <span className="block text-xs text-ink-3">
                      {s.table} · <DateText value={s.date} />
                      {s.quantity != null ? ` · ${formatNumber(s.quantity)} ${s.unit_label || ''}` : ''}
                      {s.dollar_amount != null ? ` · ${formatDollars(s.dollar_amount)} ${s.dollar_type || ''}` : ''}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Dialog>

      <Dialog
        open={history} onOpenChange={setHistory} title="Revision history" size="md"
        description="Each revision is kept as it was saved, with the facts it was built from."
        footer={<Button variant="ghost" onClick={() => setHistory(false)}>Close</Button>}
      >
        {(query.data.revisions || []).length === 0 ? (
          <EmptyState title="No revisions yet" description="Save one to start the history." />
        ) : (
          <ul className="space-y-2">
            {query.data.revisions.map((r: any) => (
              <li key={r.revision} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-ink">Revision {r.revision}</span>
                  <span className="block text-xs text-ink-3">
                    {r.first_name} {r.last_name} · <DateText value={r.created_at} />
                    {r.note ? ` · ${r.note}` : ''}
                  </span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => exportRevision(r.revision)}><Download className="h-3.5 w-3.5" />Export</Button>
              </li>
            ))}
          </ul>
        )}
      </Dialog>
    </div>
  );
}
