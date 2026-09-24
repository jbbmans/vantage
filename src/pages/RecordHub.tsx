import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight, BookOpenCheck, CheckCircle2, FileText, Info, Lock, PenLine, Plus, Trash2 } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, PageHeader, Panel, Segmented, Skeleton, Tabs, Textarea, Tooltip } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText, useParam } from '@/components/common';
import { StageBadge, WorkList } from '@/components/work';
import { useAssignedWork, useContributions, useRecordDrafts, useRecordSummary, caseKeys } from '@/lib/queries';
import * as api from '@/lib/api';
import { cn, timeAgo } from '@/lib/utils';

const Records = lazy(() => import('./Records'));

/**
 * The Record: what a Marine has actually done, and what backs it up.
 *
 * Three things, kept apart because they mean different things. Assigned work is what you hold
 * right now; it is not credit. Contributions are what you did, read from the history of the work
 * itself, so nobody retypes them. Your own entries are what you logged yourself: PME, PT,
 * volunteering, anything that did not start as a tasker.
 */

const WINDOWS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '12 months' },
] as const;

const windowParams = (days: string) => {
  const to = new Date();
  const from = new Date(to.getTime() - (Number(days) - 1) * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
};

export default function RecordHub() {
  const [tab, setTab] = useParam('tab', 'overview');
  const [days, setDays] = useParam('window', '90');
  const params = useMemo(() => windowParams(days), [days]);
  const summary = useRecordSummary(params);
  const drafts = useRecordDrafts();
  const openDrafts = (drafts.data || []).filter((d) => !d.activity_id).length;

  return (
    <div className="page">
      <PageHeader eyebrow="Record" title="Your record" lede="What you hold, what you did, and what you logged yourself. Built from the work, so you do not type it twice.">
        <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Plus className="h-4 w-4" />Log an activity</Button>
      </PageHeader>
      <Tabs value={tab} onChange={setTab} className="mb-5" tabs={[
        { value: 'overview', label: 'Overview' },
        { value: 'contributions', label: 'Contributions' },
        { value: 'entries', label: 'Your entries' },
        { value: 'drafts', label: 'Drafts', count: openDrafts || undefined },
      ]} />
      {(tab === 'overview' || tab === 'contributions') && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-3">{params.from} to {params.to}</p>
          <Segmented label="Reporting window" value={days as (typeof WINDOWS)[number]['value']} onChange={setDays} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} size="sm" />
        </div>
      )}
      {tab === 'overview' && <Overview summary={summary.data} loading={summary.isPending} onTab={setTab} />}
      {tab === 'contributions' && <Contributions params={params} />}
      {tab === 'entries' && <Suspense fallback={<Skeleton className="h-64" />}><Records embedded /></Suspense>}
      {tab === 'drafts' && <Drafts />}
    </div>
  );
}

function Figure({ label, value, definition, to }: { label: string; value: number | undefined; definition: string; to: string }) {
  return (
    <div className="card card-hover relative h-full p-4">
      <p className="flex items-start justify-between gap-2 text-sm font-medium text-ink-2">
        <Link to={to} className="after:absolute after:inset-0 after:content-['']">{label}</Link>
        <Tooltip content={definition}>
          <button type="button" className="relative z-10 -m-1 rounded p-1 text-ink-3 hover:text-ink" aria-label={`What counts as ${label.toLowerCase()}: ${definition}`}><Info className="h-3.5 w-3.5" /></button>
        </Tooltip>
      </p>
      <p className="stat-value mt-3">{value ?? '–'}</p>
    </div>
  );
}

function Overview({ summary, loading, onTab }: { summary: any; loading: boolean; onTab: (t: string) => void }) {
  const assigned = useAssignedWork();
  if (loading || !summary) return <div className="grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div>;
  const c = summary.contributions;
  const d = summary.definitions;
  return (
    <div className="space-y-6">
      <section aria-labelledby="contributed">
        <h2 id="contributed" className="mb-1 text-md font-semibold text-ink">What you contributed</h2>
        <p className="mb-3 text-xs text-ink-3">Read from the history of the work you did. One document counts once however many entries it has.</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <Figure label="Documents researched" value={c.documents_researched} definition={d.documents_researched} to="/record?tab=contributions" />
          <Figure label="Research entries" value={c.research_actions} definition={d.research_actions} to="/record?tab=contributions" />
          <Figure label="Submitted" value={c.submitted_actions} definition={d.submitted_actions} to="/record?tab=contributions" />
          <Figure label="Verified outcomes" value={c.verified_outcomes} definition={d.verified_outcomes} to="/record?tab=contributions" />
          <Figure label="Resolved" value={c.resolved_work} definition={d.resolved_work} to="/record?tab=contributions" />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Assigned to you" subtitle="Claimed work lands here at once. Holding work is not credit for it." padded={false}
          action={<Link to="/work" className="text-xs text-accent hover:underline">Find more work</Link>}>
          {assigned.isPending ? <Skeleton className="m-4 h-20" /> : !assigned.data?.length ? (
            <EmptyState title="Nothing assigned" description="Claim an item from the queue and it appears here immediately." />
          ) : <WorkList items={assigned.data} />}
        </Panel>

        <Panel title="What you recorded yourself" subtitle="PME, PT, volunteering, qualifications: anything that did not start as a tasker.">
          <ul className="grid grid-cols-3 gap-3 text-sm">
            <li>
              <button type="button" onClick={() => onTab('entries')} className="block w-full rounded-md border border-line px-3 py-2 text-left hover:border-line-strong">
                <span className="block text-xs text-ink-3">Activities</span><span className="fig mt-0.5 block text-lg font-semibold text-ink">{summary.personal.activities}</span>
              </button>
            </li>
            <li>
              <Link to="/career?tab=training" className="block rounded-md border border-line px-3 py-2 hover:border-line-strong">
                <span className="block text-xs text-ink-3">Training</span><span className="fig mt-0.5 block text-lg font-semibold text-ink">{summary.personal.trainings}</span>
              </Link>
            </li>
            <li>
              <button type="button" onClick={() => onTab('drafts')} className="block w-full rounded-md border border-line px-3 py-2 text-left hover:border-line-strong">
                <span className="block text-xs text-ink-3">Open drafts</span><span className="fig mt-0.5 block text-lg font-semibold text-ink">{summary.personal.open_drafts}</span>
              </button>
            </li>
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Plus className="h-4 w-4" />Log an activity</Button>
            <Button size="sm" variant="ghost" asChild><Link to="/reports"><FileText className="h-4 w-4" />Build JEPES or FITREP input</Link></Button>
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Contributions({ params }: { params: { from: string; to: string } }) {
  const list = useContributions(params);
  if (list.isPending) return <Skeleton className="h-64" />;
  if (!list.data?.length) {
    return <div className="card"><EmptyState icon={BookOpenCheck} title="No recorded contributions in this window" description="Research, submissions and verifications you record on work show up here, attributed to you, even after the work moves on." action={<Button asChild><Link to="/work">Go to Work</Link></Button>} /></div>;
  }
  return (
    <ul className="space-y-3">
      {list.data.map((row) => (
        <li key={row.item.id} className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2">
                {row.item.open ? <Link to={`/work/items/${row.item.id}`} className="fig font-semibold text-ink hover:underline">{row.item.reference || 'Work item'}</Link> : <span className="fig font-semibold text-ink">{row.item.reference || 'Work item'}</span>}
                <StageBadge stage={row.item.stage} />
                {row.resolved && <Badge tone="good">You resolved it</Badge>}
              </p>
              <p className="mt-0.5 truncate text-sm text-ink-2">{row.item.title}</p>
            </div>
            <p className="text-xs text-ink-3">last {timeAgo(row.last_at)}</p>
          </div>
          <p className="mt-2 text-xs text-ink-3">{[row.research && `${row.research} research`, row.submitted && `${row.submitted} submitted`, row.verified && `${row.verified} verified`].filter(Boolean).join(' · ')}</p>
          <ol className="mt-2 space-y-1 border-l border-line pl-3">
            {row.events.slice(0, 5).map((e: any) => (
              <li key={e.id} className="text-sm text-ink-2"><span className="mr-2 text-xs text-ink-3"><DateText value={e.occurred_at.slice(0, 10)} /></span>{e.summary}</li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}

function Drafts() {
  const toast = useToast();
  const qc = useQueryClient();
  const drafts = useRecordDrafts();
  const [openId, setOpenId] = useParam('open');
  const [confirm, setConfirm] = useState<string | null>(null);
  const open = (drafts.data || []).find((d) => d.id === openId) || null;

  if (drafts.isPending) return <Skeleton className="h-64" />;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <div>
        <p className="mb-3 flex items-start gap-2 text-xs text-ink-3"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />Drafts are yours alone. No leader, reviewer or administrator can open them, and nothing is sent anywhere.</p>
        {!drafts.data?.length ? (
          <div className="card"><EmptyState icon={PenLine} title="No drafts yet" description="Open work you contributed to and choose “Prepare a private draft from my work”." /></div>
        ) : (
          <ul className="card divide-y divide-line overflow-hidden p-0">
            {drafts.data.map((d) => (
              <li key={d.id}>
                <button type="button" onClick={() => setOpenId(d.id)} className={cn('w-full px-4 py-3 text-left transition-colors hover:bg-surface-2', d.id === openId && 'bg-accent-soft/50')}>
                  <span className="block truncate text-sm font-medium text-ink">{d.title}</span>
                  <span className="mt-0.5 block text-xs text-ink-3">{d.activity_id ? 'In your record' : 'Draft'} · updated {timeAgo(d.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0">
        {open ? <DraftEditor key={open.id + open.version} draft={open} onChanged={() => qc.invalidateQueries({ queryKey: caseKeys.drafts })} onDelete={() => setConfirm(open.id)} />
          : drafts.data?.length ? <div className="card"><EmptyState title="Choose a draft" /></div> : null}
      </div>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title="Delete this draft?" body="The work it was built from is not affected." onConfirm={async () => {
        try { await api.deleteDraft(confirm!); setOpenId(''); qc.invalidateQueries({ queryKey: caseKeys.drafts }); toast.success('Deleted.'); } catch (e) { toast.error(api.errorText(e)); }
      }} />
    </div>
  );
}

function DraftEditor({ draft, onChanged, onDelete }: { draft: any; onChanged: () => void; onDelete: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [title, setTitle] = useState(draft.title);
  const [wording, setWording] = useState(draft.wording);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTitle(draft.title); setWording(draft.wording); }, [draft.title, draft.wording]);
  const dirty = title !== draft.title || wording !== draft.wording;

  const save = async () => {
    setBusy(true);
    try { await api.updateDraft(draft.id, { title, wording, version: draft.version }); toast.success('Saved.'); onChanged(); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };
  const keep = async () => {
    setBusy(true);
    try {
      if (dirty) await api.updateDraft(draft.id, { title, wording, version: draft.version });
      await api.saveDraftToRecord(draft.id);
      toast.success('Kept in your record as a private entry.');
      onChanged();
      qc.invalidateQueries({ queryKey: ['records', 'activities'] });
      qc.invalidateQueries({ queryKey: ['record-summary'] });
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <section className="card p-4 sm:p-5" aria-label="Draft">
      <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <div className="mt-4">
        <h3 className="text-sm font-semibold text-ink">Facts from your recorded work</h3>
        <p className="text-xs text-ink-3">Taken from your own entries. These are not edited here; each points to the entry it came from.</p>
        <ul className="mt-2 space-y-1.5">
          {draft.facts.map((f: any) => (
            <li key={f.source.event_id} className="flex items-start gap-2 text-sm text-ink-2"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" aria-hidden /><span><span className="mr-2 text-xs text-ink-3"><DateText value={f.date} /></span>{f.text}</span></li>
          ))}
        </ul>
        {draft.work_item_id && <Link to={`/work/items/${draft.work_item_id}`} className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline">Open the work <ArrowRight className="h-3 w-3" /></Link>}
      </div>
      <div className="mt-4">
        <Field label="Wording" hint={draft.wording_source === 'template' && !dirty ? 'Suggested wording assembled from the facts above. Edit it before you use it.' : draft.wording_source === 'ai' ? 'An AI draft. Check every word against the facts.' : 'Your wording.'}>
          <Textarea rows={5} value={wording} onChange={(e) => setWording(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={onDelete}><Trash2 className="h-4 w-4" />Delete</Button>
        <span className="flex flex-wrap gap-2">
          <Button loading={busy} disabled={!dirty} onClick={save}>Save draft</Button>
          {draft.activity_id ? <Badge tone="good">In your record</Badge> : <Button variant="primary" loading={busy} onClick={keep}><BookOpenCheck className="h-4 w-4" />Keep in my record</Button>}
        </span>
      </div>
      <p className="mt-3 text-xs text-ink-3">Nothing is sent to JEPES, a FITREP system or a supervisor. Keeping it adds a private entry to your own record.</p>
    </section>
  );
}
