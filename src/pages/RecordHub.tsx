import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, BookOpenCheck, CheckCircle2, FileText, Info, Lock, PenLine, Plus, Trash2, Users } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, PageHeader, Panel, Segmented, Skeleton, Textarea, Tooltip } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText, DescriptionList, useParam } from '@/components/common';
import { DraftMeta, lostFrom } from '@/components/FormDrafts';
import { StageBadge, WorkRow } from '@/components/work';
import { useAssignedWork, useContributions, useDrafts, useFormDraft, useRecordDrafts, useRecordSummary, invalidateDomains } from '@/lib/queries';
import * as api from '@/lib/api';
import { cn, formatRange, humanize, lastDays, timeAgo } from '@/lib/utils';
import { DRAFT_ACTIVE_DAYS, DRAFT_KIND_LABELS, DRAFT_KINDS, type DraftItem } from '../../shared/drafts';
import { QueryFailure } from '@/components/QueryFailure';
import { usePlace } from '@/lib/place';
import { placeName } from '@/config/nav';


const WINDOWS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '12 months' },
] as const;


export type RecordSection = 'overview' | 'contributions' | 'drafts';

const HEADINGS: Record<RecordSection, [string, string]> = {
  overview: ['Your record', 'What you hold, what you did, and what you logged yourself. Built from the work, so you do not type it twice.'],
  contributions: ['Contributions', 'What you did on each case you worked, counted the way a reviewer would count it.'],
  drafts: ['Drafts', 'Everything you started and have not finished, wherever it lives. Each opens where you finish it.'],
};

/** Three pages of Records: the overview at /record, and /record/contributions and /record/drafts. Activities is Records.tsx. */
export default function RecordHub({ section }: { section: RecordSection }) {
  const place = usePlace();
  const [days, setDays] = useParam('window', '90');
  const params = useMemo(() => lastDays(days), [days]);
  const summary = useRecordSummary(params, section === 'overview');

  return (
    <div className="page">
      <PageHeader eyebrow={place.group} title={HEADINGS[section][0]} lede={HEADINGS[section][1]}>
        <Button variant="primary" className="xl:hidden" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Plus className="h-4 w-4" />Log activity</Button>
      </PageHeader>
      {section !== 'drafts' && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-ink-3">{formatRange(params.from, params.to)}</p>
          <Segmented label="Reporting window" value={days as (typeof WINDOWS)[number]['value']} onChange={setDays} options={WINDOWS.map((w) => ({ value: w.value, label: w.label }))} size="sm" />
        </div>
      )}
      {section === 'overview' && (summary.isError ? <QueryFailure error={summary.error} what="Your Record" onRetry={() => summary.refetch()} /> : <Overview summary={summary.data} loading={summary.isPending} />)}
      {section === 'contributions' && <Contributions params={params} />}
      {section === 'drafts' && <Drafts />}
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

/** Evidence of what the Marine can do, read from the cases they worked. It stays true without Vantage in the room. */
function Practiced() {
  const { data, isPending } = useQuery({ queryKey: ['record', 'practice'], queryFn: api.recordPractice, staleTime: 60_000 });
  const rows: Array<{ key: string; title: string; short: string; worked: number; verified: number; last: string }> = data?.procedures || [];
  return (
    <Panel title="What you can do" subtitle="Procedures you have worked, from the case histories. Yours to cite, and to keep practising." padded={false}
      action={<Link to="/reference?tab=diagnose" className="text-xs text-accent hover:underline">Practise reading balances</Link>}>
      {isPending ? <Skeleton className="m-4 h-20" /> : !rows.length ? (
        <EmptyState title="No procedures worked yet" description="Work a case through its procedure and it is counted here: how many you acted on, and how many reached a verified outcome." />
      ) : (
        <ul className="stagger divide-y divide-line">
          {rows.map((r, i) => (
            <li key={r.key} className="flex items-center gap-3 px-4 py-3" style={{ '--i': i } as React.CSSProperties}>
              <span className="chip shrink-0">{r.short}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{r.title}</span>
                <span className="block text-2xs text-ink-3">last worked {timeAgo(r.last)}</span>
              </span>
              <span className="text-right"><span className="fig block text-sm font-semibold text-ink">{r.worked}</span><span className="block text-2xs text-ink-3">worked</span></span>
              <span className="w-16 text-right"><span className="fig block text-sm font-semibold text-good">{r.verified}</span><span className="block text-2xs text-ink-3">verified</span></span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function Overview({ summary, loading }: { summary: any; loading: boolean }) {
  const navigate = useNavigate();
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
          <Figure label="Documents researched" value={c.documents_researched} definition={d.documents_researched} to="/record/contributions" />
          <Figure label="Research entries" value={c.research_actions} definition={d.research_actions} to="/record/contributions" />
          <Figure label="Submitted" value={c.submitted_actions} definition={d.submitted_actions} to="/record/contributions" />
          <Figure label="Verified outcomes" value={c.verified_outcomes} definition={d.verified_outcomes} to="/record/contributions" />
          <Figure label="Resolved" value={c.resolved_work} definition={d.resolved_work} to="/record/contributions" />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Assigned to you" subtitle="Claimed work lands here at once. Holding work is not credit for it." padded={false}
          action={<Link to="/work/queue" className="text-xs text-accent hover:underline">Find more work</Link>}>
          {assigned.isPending ? <Skeleton className="m-4 h-20" /> : assigned.isError ? (
            <QueryFailure className="" error={assigned.error} what="Your assigned work" onRetry={() => assigned.refetch()} />
          ) : !assigned.data?.length ? (
            <EmptyState title="Nothing assigned" description="Claim an item from the queue and it appears here immediately." />
          ) : <ul className="divide-y divide-line">{assigned.data.map((item) => <WorkRow key={item.id} item={item} />)}</ul>}
        </Panel>

        <Panel title="What you recorded yourself" subtitle={`Work that did not start as a tasker. Courses, PME and qualifications have their own records in ${placeName('/career/training')}, and awards in ${placeName('/career/awards')}.`}
          action={<Link to="/record/timeline" className="text-xs text-accent hover:underline">Your timeline</Link>}>
          <ul className="grid grid-cols-3 gap-3 text-sm">
            <li>
              <button type="button" onClick={() => navigate('/record/activities')} className="block w-full rounded-md border border-line px-3 py-2 text-left hover:border-line-strong">
                <span className="block text-xs text-ink-3">Activities</span><span className="fig mt-0.5 block text-lg font-semibold text-ink">{summary.personal.activities}</span>
              </button>
            </li>
            <li>
              <Link to="/career/training" className="block rounded-md border border-line px-3 py-2 hover:border-line-strong">
                <span className="block text-xs text-ink-3">Training</span><span className="fig mt-0.5 block text-lg font-semibold text-ink">{summary.personal.trainings}</span>
              </Link>
            </li>
            <li>
              <button type="button" onClick={() => navigate('/record/drafts')} className="block w-full rounded-md border border-line px-3 py-2 text-left hover:border-line-strong">
                <span className="block text-xs text-ink-3">Open drafts</span><span className="fig mt-0.5 block text-lg font-semibold text-ink">{summary.personal.open_drafts}</span>
              </button>
            </li>
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}><Plus className="h-4 w-4" />Log activity</Button>
            <Button size="sm" variant="ghost" asChild><Link to="/reports"><FileText className="h-4 w-4" />Build JEPES or FITREP input</Link></Button>
          </div>
        </Panel>
      </div>

      <Practiced />
    </div>
  );
}

function Contributions({ params }: { params: { from: string; to: string } }) {
  const list = useContributions(params);
  if (list.isPending) return <Skeleton className="h-64" />;
  if (list.isError) return <QueryFailure error={list.error} what="Your contributions" onRetry={() => list.refetch()} />;
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
              <li key={e.id} className="text-sm text-ink-2"><span className="mr-2 text-xs text-ink-3"><DateText value={e.occurred_at} /></span>{e.summary}</li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every draft of the person's, wherever its kind keeps it (ADR-0030): each opens where it is finished, says who else can
 * read it, and, for a saved form, how long it is kept. An entry drawn from work is worded here, as before. Nothing is
 * stored here: the list is read from each kind each time.
 */
function Drafts() {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const all = useDrafts();
  // Entries drawn from work, kept ones too: one just kept stays open here, marked as in the record.
  const entries = useRecordDrafts();
  const [openId, setOpenId] = useParam('open');
  const [readId, setReadId] = useParam('read');
  const [kind, setKind] = useParam('kind', 'all');
  const [, setParams] = useSearchParams();
  // One side panel at a time, changed in one step: two setters in a row would each start from the same address.
  const show = (which: 'open' | 'read', id: string) => setParams((p) => {
    const n = new URLSearchParams(p);
    n.delete('open'); n.delete('read');
    if (id) n.set(which, id);
    return n;
  }, { replace: true });
  const [confirm, setConfirm] = useState<DraftItem | null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const open = (entries.data || []).find((d) => d.id === openId) || null;
  // Read here too, so this page knows when the form it reads has arrived (the same query as the panel's).
  const reading = useFormDraft(readId || null);
  const focused = useRef<string | null>(null);
  // On a phone the editor is below the list: a draft chosen there is scrolled to and its heading focused, once, when it
  // has arrived (straight from a link, the list and the form are read first).
  useEffect(() => {
    const target = openId || readId;
    if (!target) { focused.current = null; return; }
    if (focused.current === target) return;
    const heading = editor.current?.querySelector<HTMLElement>('[data-editor-heading]');
    if (!heading) return;
    focused.current = target;
    heading.focus({ preventScroll: true });
    if (!window.matchMedia('(min-width: 1024px)').matches) editor.current!.scrollIntoView({ block: 'start' });
  }, [openId, readId, open?.id, reading.data?.id, all.isPending]);

  if (all.isPending) return <Skeleton className="h-64" />;
  if (all.isError) return <QueryFailure error={all.error} what="Your drafts" onRetry={() => all.refetch()} />;
  const data = all.data!;
  const privacy = (
    <p className="mb-3 flex items-start gap-2 text-xs text-ink-3"><Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span>Saved forms and entries drawn from your work are yours alone. No leader, reviewer or administrator can open them, and nothing is sent anywhere. Counselings, report packages and correspondence say below who else can read them.</span>
    </p>
  );
  if (!data.total && !open) return (
    <div>
      {privacy}
      <div className="card"><EmptyState icon={PenLine} title="No drafts" description="Save draft on a new goal, award, training entry, task or billet change keeps it here until you finish it. Counselings you have not finalized, report packages, correspondence you have not sent, and entries drawn from a case you worked (“Prepare a private draft from my work”) show here too."
        action={<Button variant="primary" onClick={() => navigate('/work/queue?claimed=me')}>Open my work<ArrowRight className="h-4 w-4" /></Button>} /></div>
    </div>
  );
  const kinds = DRAFT_KINDS.filter((k) => data.counts[k]);
  // A kind with none left (the last one discarded) shows every draft, as its filter is no longer offered.
  const active = (kinds as string[]).includes(kind) ? kind : 'all';
  const shown = data.items.filter((d) => active === 'all' || d.kind === active);
  const waiting = shown.filter((d) => d.waiting);
  const resting = shown.filter((d) => !d.waiting);
  const side = Boolean(open || readId);
  const discard = async () => {
    const d = confirm;
    if (!d) return;
    try {
      if (d.source === 'form') await api.discardFormDraft(d.id); else await api.deleteDraft(d.id);
      toast.success('Draft discarded.');
    } catch (e) { if (!(e instanceof api.ApiError && e.status === 404)) { toast.error(api.errorText(e)); return; } }
    if (d.id === openId) setOpenId('');
    if (d.id === readId) setReadId('');
    invalidateDomains(qc, 'draft');
  };
  const row = (d: DraftItem) => (
    <li key={d.key} className={cn('flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 px-4 py-3', (d.id === openId || d.id === readId) && 'bg-accent-soft/50')}>
      <span className="min-w-0 flex-1">
        <span className="block text-2xs font-medium uppercase tracking-wider text-ink-3">{DRAFT_KIND_LABELS[d.kind].one}{d.place && d.place !== DRAFT_KIND_LABELS[d.kind].many ? ` · ${d.place}` : ''}</span>
        <DraftTitle d={d} onOpen={() => show('open', d.id)} onRead={() => show('read', d.id)} />
        {d.about && <span className="block text-xs text-ink-2">For {d.about}</span>}
        <span className="mt-0.5 flex items-center gap-1 text-xs text-ink-3">{d.readers === 'Only you' ? <Lock className="h-3 w-3 shrink-0" aria-hidden /> : <Users className="h-3 w-3 shrink-0" aria-hidden />}{d.readers}</span>
        <DraftMeta d={d} />
      </span>
      {d.discardable && <Button size="xs" variant="ghost" onClick={() => setConfirm(d)} aria-label={`Discard ${d.title}`}><Trash2 className="h-3.5 w-3.5" aria-hidden />Discard</Button>}
    </li>
  );
  return (
    <div className={cn('grid grid-cols-1 gap-4', side && 'lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]')}>
      <div className="min-w-0">
        {privacy}
        {kinds.length > 1 && (
          <div role="group" aria-label="Show drafts of" className="mb-3 flex flex-wrap gap-1.5">
            {[['all', `All (${data.total})`] as const, ...kinds.map((k) => [k, `${DRAFT_KIND_LABELS[k].many} (${data.counts[k]})`] as const)].map(([k, label]) => (
              <button key={k} type="button" aria-pressed={active === k} onClick={() => setKind(k)} className={cn('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors', active === k ? 'border-accent bg-accent-soft text-ink' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink')}>{label}</button>
            ))}
          </div>
        )}
        <section aria-labelledby="drafts-waiting">
          <h2 id="drafts-waiting" className="eyebrow mb-2">Waiting on you <span className="fig">({waiting.length})</span></h2>
          {waiting.length ? <ul className="card divide-y divide-line overflow-hidden p-0">{waiting.map(row)}</ul> : <div className="card"><EmptyState title="Nothing is waiting on you" className="py-6" /></div>}
        </section>
        {resting.length > 0 && (
          <section aria-labelledby="drafts-resting" className="mt-4">
            <h2 id="drafts-resting" className="eyebrow mb-1">Not waiting on you <span className="fig">({resting.length})</span></h2>
            <p className="mb-2 text-xs text-ink-3">Shared with the Marine to review, or not worked on in {DRAFT_ACTIVE_DAYS} days. These are not counted.</p>
            <ul className="card divide-y divide-line overflow-hidden p-0">{resting.map(row)}</ul>
          </section>
        )}
        {data.more && <p className="mt-3 text-xs text-ink-2">Only the newest 200 of each kind are listed here. Finish or discard some to see the rest.</p>}
        <p className="mt-3 text-xs text-ink-3">A saved form is kept {data.kept_days} days after you last save it, then removed. You have {data.saved} of {data.limit}.</p>
      </div>
      {side && (
        <div ref={editor} className="min-w-0">
          {open ? <DraftEditor key={open.id + open.version} draft={open} onChanged={() => invalidateDomains(qc, 'draft')} onDelete={() => setConfirm({ key: `entry:${open.id}`, id: open.id, source: 'entry', kind: 'entry', title: open.title } as DraftItem)} />
            : readId ? <SavedFormView id={readId} onClose={() => setReadId('')} onDiscard={(d) => setConfirm(d)} /> : null}
        </div>
      )}
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title="Discard this draft?" confirmLabel="Discard"
        body={confirm?.source === 'entry' ? 'It is removed and cannot be brought back. The work it was built from is not affected.' : 'It is removed and cannot be brought back. Nothing was sent, so nobody else is affected.'} onConfirm={discard} />
    </div>
  );
}

/** A draft's title, as the way to finish it: an entry is worded here, a form its author can no longer send is read here, and the rest open where they are finished. */
function DraftTitle({ d, onOpen, onRead }: { d: DraftItem; onOpen: () => void; onRead: () => void }) {
  const cls = 'mt-0.5 block text-left text-sm font-medium text-ink hover:underline';
  if (d.source === 'entry') return <button type="button" className={cls} onClick={onOpen}>{d.title}</button>;
  if (d.source === 'form' && !d.can_submit) return <button type="button" className={cls} onClick={onRead}>{d.title}<span className="sr-only"> (read it here)</span></button>;
  return <Link to={d.href} className={cls}>{d.title}<span className="sr-only">, open it in {d.place}</span></Link>;
}

/** A saved form read where it is kept: what was saved in it, for one its author may no longer send, with Discard. */
function SavedFormView({ id, onClose, onDiscard }: { id: string; onClose: () => void; onDiscard: (d: DraftItem) => void }) {
  const q = useFormDraft(id);
  if (q.isPending) return <Skeleton className="h-48" />;
  // Only a draft that is gone is said to be; offline or a server error, it can be tried again.
  if (q.error && lostFrom(q.error)?.why !== 'gone') return <QueryFailure error={q.error} what="This draft" onRetry={() => q.refetch()} />;
  if (q.error || !q.data) return <div className="card"><EmptyState title="That draft is no longer here" description="It was sent or discarded." action={<Button onClick={onClose}>Close</Button>} /></div>;
  const d = q.data;
  const values = d.kind === 'personnel_change' ? ((d.payload as { changes?: Record<string, unknown> }).changes || {}) : d.payload;
  const items = Object.entries(values).filter(([k, v]) => v !== null && v !== '' && typeof v !== 'object' && k !== 'unit_id' && k !== 'user_id')
    .map(([k, v]) => [humanize(k === 'supervisor_id' ? 'supervisor' : k), k === 'supervisor_id' ? String((d.payload as { supervisor_label?: string }).supervisor_label || 'Named') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)] as [string, React.ReactNode]);
  return (
    <section className="card p-4 sm:p-5" aria-labelledby="saved-form-heading">
      <h2 id="saved-form-heading" data-editor-heading tabIndex={-1} className="text-base font-semibold text-ink focus:outline-none">{d.title}</h2>
      <p className="text-xs text-ink-3">{DRAFT_KIND_LABELS[d.kind].one}{d.subject_label ? ` · for ${d.subject_label}` : ''}</p>
      {d.blocked && <p role="note" className="mt-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/[.06] px-3 py-2 text-xs text-ink-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-hidden />{d.blocked} You can read what you saved and discard it.</p>}
      <div className="mt-3">{items.length ? <DescriptionList items={items} /> : <p className="text-sm text-ink-3">Nothing filled in.</p>}</div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="danger" onClick={() => onDiscard({ key: `form:${d.id}`, id: d.id, source: 'form', kind: d.kind, title: d.title } as DraftItem)}><Trash2 className="h-4 w-4" aria-hidden />Discard</Button>
      </div>
    </section>
  );
}

function DraftEditor({ draft, onChanged, onDelete }: { draft: any; onChanged: () => void; onDelete: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [title, setTitle] = useState(draft.title);
  const [wording, setWording] = useState(draft.wording);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTitle(draft.title); setWording(draft.wording); }, [draft.title, draft.wording]);
  // Kept, it is an entry in the record and is changed there (ADR-0030): this is what was kept, to read.
  const kept = Boolean(draft.activity_id);
  const dirty = !kept && (title !== draft.title || wording !== draft.wording);

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
      const kept = await api.saveDraftToRecord(draft.id);
      toast.success('Kept in your record as a private entry.', kept?.activity_id ? { label: 'Open it', onClick: () => navigate(`/records/${kept.activity_id}`) } : undefined);
      invalidateDomains(qc, 'draft', 'activity');
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  return (
    <section className="card p-4 sm:p-5" aria-labelledby="entry-draft-heading">
      <h2 id="entry-draft-heading" data-editor-heading tabIndex={-1} className="mb-3 text-base font-semibold text-ink focus:outline-none">Entry from your work</h2>
      {kept && <p role="note" className="mb-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">This is in your record now. Change the entry there; this draft is what was kept.</p>}
      <Field label="Title"><Input value={title} readOnly={kept} onChange={(e) => setTitle(e.target.value)} /></Field>
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
          <Textarea rows={5} value={wording} readOnly={kept} onChange={(e) => setWording(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={onDelete}><Trash2 className="h-4 w-4" />Delete</Button>
        <span className="flex flex-wrap gap-2">
          {kept
            ? <><Badge tone="good">In your record</Badge><Button asChild><Link to={`/records/${draft.activity_id}`}>Open the entry<ArrowRight className="h-4 w-4" aria-hidden /></Link></Button></>
            : <><Button loading={busy} disabled={!dirty} onClick={save}>Save draft</Button><Button variant="primary" loading={busy} onClick={keep}><BookOpenCheck className="h-4 w-4" />Keep in my record</Button></>}
        </span>
      </div>
      <p className="mt-3 text-xs text-ink-3">Nothing is sent to JEPES, a FITREP system or a supervisor. Keeping it adds a private entry to your own record.</p>
    </section>
  );
}
