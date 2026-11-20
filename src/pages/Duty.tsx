import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Upload, ShieldCheck, ArrowRightLeft, ChevronDown, ChevronUp, ClipboardCheck, SearchX } from 'lucide-react';
import { PageHeader, Button, EmptyState, Badge, Field, Select, Stat, Segmented, Skeleton } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { Table, useParam } from '@/components/common';
import DateRangePicker from '@/components/DateRangePicker';
import { usePeriodParam } from '@/lib/usePeriodParam';
import { periodDays } from '@/lib/periodParams';
import { QueryFailure } from '@/components/QueryFailure';
import { TimeframeText } from '@/components/Timeframe';
import { Attachments } from '@/components/Attachments';
import { Discussion } from '@/components/Comments';
import RecordLineage from '@/components/RecordLineage';
import RecordImportDialog from '@/components/RecordImportDialog';
import DownloadMenu, { categoryDownloads, recordDownloads } from '@/components/DownloadMenu';
import DutyDialog, { DUTY_TONE, DutyDetail, type DutyMode } from '@/components/DutyDialog';
import { ApprovedPoints, DutyReviewActions, DutyReviewHistory } from '@/components/DutyReview';
import { entryHref, type MovedEntry } from '@/components/MoveRecordDialog';
import { can, canCorrectDuty, keys, useDeleteRecord, useDutyCandidates, useDutyPages, useDutyReviewQueue, useDutySummary, useIdentity, useKeepAsActivity, useRestoreRecord, type Identity } from '@/lib/queries';
import * as api from '@/lib/api';
import { PERMISSIONS } from '../../shared/permissions';
import { formatNumber } from '../../shared/metrics';
import { formatTimeframe } from '../../shared/timeframe';
import { DUTY_STATUSES, DUTY_STATUS_LABELS, formatHours, type DutyCandidate, type DutyStatus } from '../../shared/duty';
import { hasReviewOptions } from '../../shared/dutyReview';
import { formatStamp, timeAgo } from '@/lib/utils';
import type { Duty as DutyRow } from '../../shared/types';
import { usePlace } from '@/lib/place';

const SHOWN = 5;
/** The server counts a tab up to this many and says "more than" past it (DUTY_COUNTED in server/services/duties.ts). */
const COUNTED = 1000;

type Who = api.DutyTab | 'review';

/** What each tab's table is called: its caption, and the name of its scroller on a narrow screen. */
const TAB_CAPTION: Record<api.DutyTab, string> = { mine: 'Your duty', recorded: 'Duty you recorded for your Marines', units: 'Duty in your units' };
const PANEL = 'duty-panel';
const tabId = (who: Who) => `duty-tab-${who}`;
const rowTitleId = (id: string) => `duty-row-${id}`;
const counted = (n: number, more = false) => (more ? `${formatNumber(COUNTED)}+` : formatNumber(n));
const rounded = (n: number) => formatNumber(Math.round(n * 100) / 100);
const isStatus = (v: string): v is DutyStatus => (DUTY_STATUSES as readonly string[]).includes(v);

/**
 * Records → Duty (ADR-0023, ADR-0024): the duty a Marine stood, each with its type, times, what it ran
 * to, the points the Unit Instance's scoring gave it and the points it was approved for, where it stands with its
 * reviewers, and the activities that read like duty for their owner to move here. A leader also sees the duty they
 * recorded for their Marines and what their units hold, and a reviewer the duty waiting for their decision. Each tab is
 * read a page at a time, newest first, and the totals come from all of the reader's duty, never from the page open.
 */
export default function Duty() {
  const place = usePlace();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: identity } = useIdentity();
  const me = identity?.user.id;
  const [openId, setOpenId] = useParam('open');
  const [who, setWho] = useParam('who', 'mine');
  const range = usePeriodParam('all');
  const { period, from, to, custom } = range;
  const [unit, setUnit] = useParam('unit');
  const [statusParam, setStatus] = useParam('status');
  const [queueUnit, setQueueUnit] = useParam('queue_unit');
  const [, setSearchParams] = useSearchParams();
  const status = isStatus(statusParam) ? statusParam : undefined;

  const summary = useDutySummary();
  const tabs = summary.data?.tabs;
  const queue = useDutyReviewQueue(who === 'review' ? queueUnit || null : null);
  const reviewer = Boolean(queue.data?.reviewer);
  const waiting = useMemo(() => queue.data?.items ?? [], [queue.data]);
  // A view with nothing left in it (the last duty recorded for a Marine deleted, an old link) falls back to one's own.
  // Until the counts and the queue are read, the link is taken at its word, so the page does not read one tab and then another.
  const whoShown: Who = who === 'review' ? (reviewer || queue.isPending || queue.isError ? 'review' : 'mine')
    : who === 'recorded' ? (!tabs || tabs.recorded > 0 ? 'recorded' : 'mine')
      : who === 'units' ? (!tabs || tabs.units > 0 ? 'units' : 'mine') : 'mine';
  const listWho: api.DutyTab = whoShown === 'review' ? 'mine' : whoShown;

  const filters = useMemo<api.DutyListFilters>(() => {
    const days = periodDays({ period, from, to, custom });
    return { ...(unit ? { unit_id: unit } : {}), ...(days ?? {}), ...(status ? { status } : {}) };
  }, [period, from, to, custom, unit, status]);
  const filtered = Boolean(unit || status || custom || period !== 'all');
  // The review queue is a list of its own: while it shows, the tab's list is not read, so a decision there reads no list again.
  const list = useDutyPages(listWho, filters, whoShown !== 'review');
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return (list.data?.pages ?? []).flatMap((p) => p.duties).filter((r) => !seen.has(r.id) && (seen.add(r.id), true));
  }, [list.data]);
  const first = list.data?.pages[0];

  const del = useDeleteRecord('duties');
  const restore = useRestoreRecord('duties');
  const [form, setForm] = useState<DutyMode | null>(null);
  const [view, setView] = useState<DutyRow | null>(null);
  const [confirm, setConfirm] = useState<DutyRow | null>(null);
  const [importing, setImporting] = useState(false);

  // A decision takes its duty out of the queue, and with it the button that made it. Focus goes to the next duty waiting
  // (the one before when it was the last, the queue itself when none is left), so a reviewer working down the list by
  // keyboard or screen reader keeps their place.
  const queueRows = useRef(new Map<string, HTMLButtonElement>());
  const queueRegion = useRef<HTMLDivElement>(null);
  const [decided, setDecided] = useState<{ id: string; next: string | null } | null>(null);
  useEffect(() => {
    if (!decided || waiting.some((w) => w.id === decided.id)) return;
    ((decided.next && queueRows.current.get(decided.next)) || queueRegion.current)?.focus();
    setDecided(null);
  }, [decided, waiting]);

  // "Show more" adds the next page under the last row; focus goes to the first of the new rows, so the reader carries on
  // from where they were rather than starting again at the top. It is marked once the page is in, so the move waits for
  // the rows it goes to.
  const [moreFrom, setMoreFrom] = useState<number | null>(null);
  useEffect(() => {
    if (moreFrom == null || list.isFetchingNextPage) return;
    if (rows.length > moreFrom) document.getElementById(rowTitleId(rows[moreFrom].id))?.focus();
    setMoreFrom(null);
  }, [moreFrom, rows, list.isFetchingNextPage]);
  const showMore = () => {
    const from = rows.length;
    list.fetchNextPage().then((r) => { if (!r.isFetchNextPageError) setMoreFrom(from); });
  };

  // A notification, a timeline entry or a move opens the duty it is about: from the lists when they hold it, otherwise
  // read on its own, since the lists hold only their first pages and a notice may be about duty from long ago.
  // A duty just saved opens the same way, so the lists are let finish reading it again before it is read on its own. Each
  // link opens its duty once: closing it is not undone by a list or a read that comes in after.
  const loaded = openId ? rows.find((x) => x.id === openId) ?? waiting.find((x) => x.id === openId) : undefined;
  const listsRead = (whoShown === 'review' || (list.isFetched && !list.isFetching)) && !queue.isPending;
  const opened = useQuery({
    queryKey: keys.record('duties', openId), queryFn: () => api.getRecord('duties', openId) as Promise<DutyRow>,
    enabled: Boolean(openId) && !loaded && listsRead, staleTime: 60_000, refetchOnWindowFocus: false, retry: false,
  });
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!openId) { openedFor.current = null; return; }
    if (openedFor.current === openId) return;
    const r = loaded ?? (opened.data?.id === openId ? opened.data : undefined);
    if (r) { openedFor.current = openId; setView(r); }
  }, [openId, loaded, opened.data]);
  const openFailed = Boolean(openId) && !loaded && !view && opened.isError;

  // The open duty as the lists hold it now, so a decision made on it (here or by someone else) shows without reopening.
  // Whichever is newer wins: a decision just made is ahead of a list still being read again.
  const listed = view ? rows.find((r) => r.id === view.id) ?? waiting.find((r) => r.id === view.id) : undefined;
  const viewed = view ? (listed && listed.version >= view.version ? listed : view) : null;

  const goTo = (entry: MovedEntry) => { setView(null); setOpenId(''); navigate(entryHref(entry.table, entry.id)); };
  const openSaved = (saved: { id: string }) => { if (saved.id) setOpenId(saved.id); };
  const editViewed = (r: DutyRow) => { setView(null); setOpenId(''); setForm({ kind: 'edit', row: r }); };
  const onView = useCallback((r: DutyRow) => setView(r), []);
  const onEdit = useCallback((r: DutyRow) => setForm({ kind: 'edit', row: r }), []);
  const onDelete = useCallback((r: DutyRow) => setConfirm(r), []);
  // The filters are cleared in one change to the address. Each of their setters starts from the address this render read,
  // so calling them one after another would keep only the last change and leave the list narrowed.
  const clearFilters = () => setSearchParams((p) => {
    const n = new URLSearchParams(p);
    for (const name of ['period', 'from', 'to', 'unit', 'status']) n.delete(name);
    return n;
  }, { replace: true });

  const own = summary.data?.mine;
  const pendingValue = <><span aria-hidden>–</span><span className="sr-only">Loading</span></>;
  const queueTotal = queue.data ? (queue.data.units.length ? queue.data.units.reduce((n, u) => n + u.count, 0) : queue.data.total) : 0;
  const showTabs = Boolean(tabs && (tabs.recorded > 0 || tabs.units > 0)) || reviewer || whoShown === 'review';
  // While there are tabs, whichever view shows is their one panel, named by the tab that shows it.
  const panel = showTabs ? { id: PANEL, role: 'tabpanel', 'aria-labelledby': tabId(whoShown) } : {};
  const tabCount = whoShown === 'review' ? 0 : listWho === 'mine' ? tabs?.mine ?? 0 : listWho === 'recorded' ? tabs?.recorded ?? 0 : tabs?.units ?? 0;
  const unitChoices = summary.data?.units ?? [];
  // Days a link carried that were not used are said beside the period, so the filters show to say it.
  const showFilters = whoShown !== 'review' && (filtered || Boolean(range.ignored) || tabCount > 10);

  // The queue names only the units where something waits. A unit narrowed to that has nothing left waiting stays in the
  // choice, under the name the reader's units give it, so the choice still says what it shows.
  const queueChoices = queue.data?.units ?? [];
  const queueUnitGone = Boolean(queueUnit) && !queueChoices.some((u) => u.id === queueUnit);
  const queueUnitName = unitChoices.find((u) => u.id === queueUnit)?.name ?? 'That unit';

  return (
    <div className="page">
      <PageHeader eyebrow={place.group} title="Duty" lede="The duty you stood: its type, its times and the points your Unit Instance's scoring gives it. Duty is submitted for review and counts, at its approved points, once a reviewer approves it.">
        <Button variant="primary" onClick={() => setForm({ kind: 'new' })} data-tutorial="duty-record"><Plus className="h-4 w-4" />Record duty</Button>
        <Button onClick={() => setImporting(true)}><Upload className="h-4 w-4" />Import</Button>
        <DownloadMenu label="Export" choices={categoryDownloads('duty')} data-tutorial="export-category" />
      </PageHeader>

      {summary.isError && !summary.data ? <QueryFailure className="card mb-4" error={summary.error} what="Your duty totals" onRetry={() => summary.refetch()} /> : (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4" data-tutorial="duty-totals">
          <Stat label="Duty stood" value={own ? formatNumber(own.duties) : pendingValue} hint={own ? (own.duties === 1 ? 'one entry' : `${formatNumber(own.duties)} entries`) : undefined} />
          <Stat label="Hours" value={own ? rounded(own.hours) : pendingValue} />
          <Stat label="Approved points" value={own ? rounded(own.approved_points) : pendingValue} hint={own ? `${rounded(own.calculated_points)} calculated` : undefined} />
          <Stat label="Awaiting review" value={own ? formatNumber(own.pending) : pendingValue} hint={own?.returned ? `${formatNumber(own.returned)} returned to you` : undefined} tone={own?.returned ? 'warn' : undefined} />
        </div>
      )}

      <DutySuggestions onRecord={(activity) => setForm({ kind: 'move', activity })} />

      {openFailed && (
        <section aria-label="The duty this link opens" className="card mb-3">
          <QueryFailure className="" error={opened.error} what="This duty" onRetry={() => opened.refetch()} />
          <p className="flex justify-center border-t border-line px-5 py-2"><Button size="sm" variant="ghost" onClick={() => setOpenId('')}>Dismiss</Button></p>
        </section>
      )}

      {whoShown !== 'review' && queue.isError && !queue.data && (
        <QueryFailure className="card mb-3" error={queue.error} what="Duty waiting for your review" onRetry={() => queue.refetch()} />
      )}
      {reviewer && whoShown !== 'review' && queueTotal > 0 && (
        <section aria-label="Duty waiting for your review" className="card mb-3 flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <p className="min-w-0 text-sm text-ink"><ClipboardCheck className="mr-1.5 inline h-4 w-4 text-accent" aria-hidden /><span className="font-medium">{queueTotal === 1 ? 'One duty is waiting for your review' : `${formatNumber(queueTotal)} duties are waiting for your review`}</span>{waiting[0]?.submitted_at ? <span className="text-ink-3"> · the longest since {timeAgo(waiting[0].submitted_at)}</span> : null}</p>
          <Button size="sm" variant="soft" onClick={() => setWho('review')}>Review {queueTotal === 1 ? 'it' : 'them'}</Button>
        </section>
      )}

      {showTabs && (
        <div className="mb-3">
          <Segmented<Who> label="Whose duty" value={whoShown} onChange={(v) => setWho(v === 'mine' ? '' : v)}
            options={[
              { value: 'mine' as Who, label: `Yours (${counted(tabs?.mine ?? 0)})`, id: tabId('mine'), controls: PANEL },
              ...(tabs && tabs.recorded > 0 ? [{ value: 'recorded' as Who, label: `Recorded by you (${counted(tabs.recorded)})`, id: tabId('recorded'), controls: PANEL }] : []),
              ...(tabs && tabs.units > 0 ? [{ value: 'units' as Who, label: `Your units (${counted(tabs.units, tabs.units_more)})`, id: tabId('units'), controls: PANEL }] : []),
              ...(reviewer || whoShown === 'review' ? [{ value: 'review' as Who, label: `To review (${formatNumber(queueTotal)})`, id: tabId('review'), controls: PANEL, 'data-tutorial': 'duty-review-tab' }] : []),
            ]} />
        </div>
      )}

      {showFilters && (
        <div role="group" aria-label="Narrow the list" className="card mb-3 grid grid-cols-1 gap-3 p-3 sm:grid-cols-3">
          <Field label="Period" className={custom ? 'sm:col-span-3' : undefined}>
            <DateRangePicker stacked value={range} ignored={range.ignored} onChange={range.set} className={custom ? 'w-full sm:w-56' : 'w-full'} />
          </Field>
          {unitChoices.length > 1 && (
            <Field label="Unit"><Select className="w-full" value={unit || 'all'} onValueChange={(v) => setUnit(v === 'all' ? '' : v)}
              options={[{ value: 'all', label: 'All units' }, ...unitChoices.map((u) => ({ value: u.id, label: u.name }))]} /></Field>
          )}
          <Field label="Status"><Select className="w-full" value={status ?? 'all'} onValueChange={(v) => setStatus(v === 'all' ? '' : v)}
            options={[{ value: 'all', label: 'Any status' }, ...DUTY_STATUSES.map((s) => ({ value: s, label: DUTY_STATUS_LABELS[s] }))]} /></Field>
        </div>
      )}

      {/* Each view's card is what focus falls back to after a decision. It stays a direct child of the page, as every
          section is: a wrapper here would let the table's screen-reader-only header widen the page on a phone. */}
      {whoShown === 'review' ? (queue.isPending ? <div {...panel}><Skeleton className="h-48" /></div> : queue.isError && !queue.data ? (
        <div {...panel}><QueryFailure error={queue.error} what="Duty waiting for your review" onRetry={() => queue.refetch()} /></div>
      ) : (
        <div ref={queueRegion} tabIndex={-1} {...panel} className="card outline-none" style={{ overflow: 'hidden' }}>
          {(queueChoices.length > 1 || queueUnit) && (
            <div className="border-b border-line px-5 py-3">
              <Field label="Unit" className="sm:max-w-xs">
                <Select className="w-full" value={queueUnit || 'all'} onValueChange={(v) => setQueueUnit(v === 'all' ? '' : v)}
                  options={[{ value: 'all', label: 'All units' }, ...queueChoices.map((u) => ({ value: u.id, label: `${u.name} (${formatNumber(u.count)})` })),
                    ...(queueUnitGone ? [{ value: queueUnit, label: `${queueUnitName} (0)` }] : [])]} />
              </Field>
            </div>
          )}
          {waiting.length === 0 ? (
            <EmptyState icon={ClipboardCheck} title="Nothing is waiting for your review"
              description="Duty submitted in the units where you review it shows here, the longest-waiting first. Your own duty is another reviewer’s to decide." />
          ) : (
            <>
              {/* The duty leads, so a phone shows what it is and whose before the table scrolls; it opens with every decision. */}
              <Table label="Duty waiting for your review" minWidth={900} head={<><th scope="col">Duty</th><th scope="col" className="w-32">Waiting since</th><th scope="col" className="w-44">When</th><th scope="col" className="w-20 text-right">Hours</th><th scope="col" className="w-24 text-right">Calculated</th><th scope="col" className="w-[17rem]"><span className="sr-only">Decide</span></th></>}>
                {waiting.map((r, i) => (
                  <tr key={r.id}>
                    <td className="min-w-[11rem]">
                      <button type="button" ref={(el) => { if (el) queueRows.current.set(r.id, el); else queueRows.current.delete(r.id); }} className="text-left font-medium text-ink hover:underline" onClick={() => setView(r)}>{r.title || r.duty_type_name || 'Duty'}</button>
                      <span className="block text-xs text-ink-3">{[r.subject_name, r.title ? r.duty_type_name : null, r.recorder_name && r.recorded_by !== r.user_id ? `recorded by ${r.recorded_by === me ? 'you' : r.recorder_name}` : null, r.frozen_at ? 'its Marine has left the unit' : null].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td className="text-xs"><span className="block text-ink">{timeAgo(r.submitted_at)}</span><time dateTime={r.submitted_at} className="fig block text-2xs text-ink-3">{formatStamp(r.submitted_at)}</time></td>
                    <td className="text-xs"><TimeframeText table="duties" row={r} /></td>
                    <td className="fig text-right text-xs">{formatHours(r.hours)}</td>
                    <td className="fig text-right text-xs">{r.calculated_points == null ? <span className="text-ink-3">None</span> : formatNumber(r.calculated_points)}{r.scoring_version != null && <span className="block text-2xs text-ink-3">version {r.scoring_version}</span>}</td>
                    <td><DutyReviewActions row={r} me={me} brief className="flex items-center justify-end gap-1 whitespace-nowrap"
                      onDone={(saved) => { if (saved.approval_status !== 'pending') setDecided({ id: r.id, next: (waiting[i + 1] ?? waiting[i - 1])?.id ?? null }); }} /></td>
                  </tr>
                ))}
              </Table>
              {(queue.data?.total ?? 0) > waiting.length && <p className="border-t border-line px-5 py-2 text-2xs text-ink-3">Showing the {formatNumber(waiting.length)} longest-waiting of {formatNumber(queue.data!.total)}. The rest show as these are decided, or narrow the queue to a unit.</p>}
              {!queueUnit && queueChoices.length > 1 && <p className="border-t border-line px-5 py-2 text-2xs text-ink-3">Waiting in {queueChoices.map((u) => `${u.name} (${formatNumber(u.count)})`).join(', ')}.</p>}
            </>
          )}
        </div>
      )) : list.isPending ? <div {...panel}><Skeleton className="h-48" /></div> : list.isError && !list.data ? (
        <div {...panel}><QueryFailure error={list.error} what={TAB_CAPTION[listWho]} onRetry={() => list.refetch()} /></div>
      ) : rows.length === 0 && !list.hasNextPage ? (
        <div {...panel} className="card">{filtered ? (
          <EmptyState icon={SearchX} title="No duty matches" description="Nothing in this list is in that period, unit or status. Widen what it shows."
            action={<Button onClick={clearFilters}>Show all</Button>} />
        ) : (
          <EmptyState icon={ShieldCheck} title="No duty recorded"
            description="Record each duty once you have stood it: the duty type, when it began and when it ended. The points come from your Unit Instance’s scoring, and a reviewer approves them."
            action={<Button variant="primary" onClick={() => setForm({ kind: 'new' })}>Record duty</Button>} />
        )}</div>
      ) : (
        <div {...panel} className="card" style={{ overflow: 'hidden' }}>
          {list.isRefetchError && <p className="border-b border-line px-5 py-2 text-xs text-warn" role="alert">The last refresh failed, so this list may be out of date. {api.errorText(list.error)}</p>}
          <Table label={TAB_CAPTION[listWho]} minWidth={760} head={<><th scope="col" className="w-44">When</th><th scope="col">Duty</th><th scope="col" className="w-20 text-right">Hours</th><th scope="col" className="w-24 text-right">Calculated</th><th scope="col" className="w-24 text-right">Approved</th><th scope="col" className="w-28">Status</th><th scope="col" className="w-44"><span className="sr-only">Actions</span></th></>}>
            {rows.map((r) => <DutyTableRow key={r.id} row={r} me={me} identity={identity} onView={onView} onEdit={onEdit} onDelete={onDelete} />)}
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-2">
            <p role="status" className="text-xs text-ink-3">{first?.total != null ? `Showing ${formatNumber(rows.length)} of ${first.total_more ? `more than ${formatNumber(COUNTED)}` : formatNumber(Math.max(first.total, rows.length))}, newest first.` : `Showing ${formatNumber(rows.length)}, newest first.`}</p>
            {list.hasNextPage && <Button size="sm" onClick={showMore} loading={list.isFetchingNextPage}>{list.isFetchNextPageError ? 'Try again' : 'Show more'}</Button>}
          </div>
          {list.isFetchNextPageError && <p className="border-t border-line px-5 py-2 text-xs text-bad" role="alert">More duty could not load. {api.errorText(list.error)}</p>}
        </div>
      )}

      <Dialog open={Boolean(viewed)} onOpenChange={(o) => { if (!o) { setView(null); setOpenId(''); } }} title={viewed ? viewed.title || viewed.duty_type_name || 'Duty' : ''} description={viewed ? formatTimeframe('duties', viewed, { pattern: 'd MMMM yyyy' }) || undefined : undefined} size="lg"
        footer={viewed ? <><DownloadMenu size="sm" choices={recordDownloads('duties', viewed.id, true)} />{canCorrectDuty(identity, viewed) && viewed.approval_status !== 'returned' && <Button onClick={() => editViewed(viewed)}>Edit</Button>}</> : undefined}>
        {viewed && hasReviewOptions(viewed.review) && (
          <section aria-label={viewed.user_id === me ? 'Its review' : 'Your decision'} className="mb-3 rounded-md border border-line bg-surface-2 px-3 py-2.5">
            <h3 className="eyebrow mb-1.5">{viewed.user_id === me ? 'Its review' : 'Your decision'}</h3>
            <DutyReviewActions row={viewed} me={me} onDone={setView} onCorrect={canCorrectDuty(identity, viewed) ? () => editViewed(viewed) : undefined} />
          </section>
        )}
        {viewed && <DutyDetail row={viewed} me={me} />}
        {viewed && <DutyReviewHistory id={viewed.id} className="mt-4" />}
        {viewed && <div className="mt-4"><Attachments table="duties" id={viewed.id} canEdit={canCorrectDuty(identity, viewed)} /></div>}
        {viewed && <RecordLineage store="duties" id={viewed.id} onUndone={goTo} className="mt-4" />}
        {viewed && <div className="mt-4"><Discussion host={{ kind: 'record', table: 'duties', id: viewed.id }} canModerate={Boolean(viewed.unit_id) && can(identity, PERMISSIONS.MANAGE_RECORDS, viewed.unit_id)} /></div>}
      </Dialog>

      <DutyDialog mode={form} open={Boolean(form)} onOpenChange={(o) => { if (!o) setForm(null); }} onSaved={openSaved} />
      <RecordImportDialog open={importing} onOpenChange={setImporting} />
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title="Delete this duty?" body="It moves to the recycle bin for 30 days."
        onConfirm={async () => { const r = confirm!; try { await del.mutateAsync(r.id); setView(null); toast.success('Deleted.', { label: 'Undo', onClick: () => restore.mutateAsync(r.id).then(() => toast.success('Restored.')).catch((e) => toast.error(api.errorText(e))) }); } catch (e) { toast.error(api.errorText(e)); } }} />
    </div>
  );
}

/**
 * One duty in a tab's table. Kept apart, with its handlers fixed for the page's life, so opening a duty or loading the
 * next page draws only the rows that changed. Its title names the duty for the buttons beside it, which would otherwise
 * be a column of identical "View" and "Delete" to a screen reader.
 */
const DutyTableRow = memo(function DutyTableRow({ row: r, me, identity, onView, onEdit, onDelete }: {
  row: DutyRow; me?: string; identity?: Identity; onView: (r: DutyRow) => void; onEdit: (r: DutyRow) => void; onDelete: (r: DutyRow) => void;
}) {
  // As the server decides (canEdit in server/authz/records.ts): decided duty stays as decided; duty a leader recorded is
  // theirs to correct, never its Marine's; a records manager corrects what is in their unit.
  const editable = canCorrectDuty(identity, r);
  const titled = rowTitleId(r.id);
  return (
    <tr>
      <td className="text-xs"><TimeframeText table="duties" row={r} /></td>
      <td>
        <button type="button" id={titled} className="text-left font-medium text-ink hover:underline" onClick={() => onView(r)}>{r.title || r.duty_type_name || 'Duty'}</button>
        <span className="block text-xs text-ink-3">{[r.title ? r.duty_type_name : null, r.user_id !== me ? r.subject_name : null, r.recorder_name && r.recorded_by !== r.user_id ? `recorded by ${r.recorded_by === me ? 'you' : r.recorder_name}` : null].filter(Boolean).join(' · ')}</span>
      </td>
      <td className="fig text-right text-xs">{formatHours(r.hours)}</td>
      <td className="fig text-right text-xs">{r.calculated_points == null ? <span className="text-ink-3">None</span> : formatNumber(r.calculated_points)}{r.scoring_version != null && <span className="block text-2xs text-ink-3">version {r.scoring_version}</span>}</td>
      <td className="fig text-right text-xs"><ApprovedPoints row={r} /></td>
      <td><Badge tone={DUTY_TONE[r.approval_status]}>{DUTY_STATUS_LABELS[r.approval_status]}</Badge></td>
      <td className="whitespace-nowrap text-right">
        <Button size="xs" variant="ghost" onClick={() => onView(r)} aria-describedby={titled} data-tutorial="duty-view">View</Button>
        {editable && <><Button size="xs" variant="ghost" onClick={() => onEdit(r)} aria-describedby={titled}>{r.approval_status === 'returned' ? 'Correct' : 'Edit'}</Button><Button size="xs" variant="ghost" onClick={() => onDelete(r)} aria-describedby={titled}>Delete</Button></>}
      </td>
    </tr>
  );
});


/** The person's activities that read like duty they stood, each theirs to record as duty or keep as an activity. */
function DutySuggestions({ onRecord }: { onRecord: (a: DutyCandidate) => void }) {
  const toast = useToast();
  const { data } = useDutyCandidates();
  const keep = useKeepAsActivity();
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const candidates = data?.candidates ?? [];
  if (!candidates.length) return null;
  const total = data?.total ?? candidates.length;
  const list = all ? candidates : candidates.slice(0, SHOWN);
  const keepIt = async (c: DutyCandidate) => {
    try { await keep.mutateAsync(c.id); toast.success('Kept as an activity. It will not be suggested again.'); }
    catch (e) { toast.error(api.errorText(e)); }
  };
  return (
    <section aria-labelledby="duty-suggestions" className="card mb-3">
      <div className="flex items-start justify-between gap-3 px-5 py-3.5">
        <div className="min-w-0">
          <h2 id="duty-suggestions" className="text-md font-semibold text-ink">{total === 1 ? 'One of your activities reads like duty you stood' : `${total} of your activities read like duty you stood`}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-3">Duty has a record of its own now. Record the ones that really were duty, with their type and times, and keep the rest as activities. Nothing moves unless you choose it, and a move can be undone.</p>
        </div>
        <Button size="xs" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="duty-suggestions-list">{open ? <><ChevronUp className="h-3.5 w-3.5" />Hide</> : <><ChevronDown className="h-3.5 w-3.5" />Show</>}</Button>
      </div>
      <div id="duty-suggestions-list" hidden={!open}>
        <ul className="divide-y divide-line border-t border-line">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2.5">
              <span className="min-w-0 flex-1 basis-60">
                <Link id={`duty-suggestion-${c.id}`} to={`/records/${c.id}`} className="block truncate text-sm font-medium text-ink hover:underline">{c.title}</Link>
                <span className="block text-xs text-ink-3"><TimeframeText table="activities" row={c} /></span>
              </span>
              <span className="flex shrink-0 gap-1">
                <Button size="xs" variant="soft" onClick={() => onRecord(c)} aria-describedby={`duty-suggestion-${c.id}`} data-tutorial="duty-suggestion-record"><ArrowRightLeft className="h-3.5 w-3.5" />Record as duty</Button>
                <Button size="xs" variant="ghost" onClick={() => keepIt(c)} loading={keep.isPending && keep.variables === c.id} aria-describedby={`duty-suggestion-${c.id}`}>Keep as activity</Button>
              </span>
            </li>
          ))}
        </ul>
        {candidates.length > SHOWN && !all && <p className="border-t border-line px-5 py-2"><Button size="xs" variant="ghost" onClick={() => setAll(true)}>Show all {candidates.length}</Button></p>}
        {total > candidates.length && <p className="border-t border-line px-5 py-2 text-2xs text-ink-3">Showing the newest {candidates.length} of {total}.</p>}
      </div>
    </section>
  );
}
