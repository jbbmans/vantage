import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Upload, ShieldCheck, ArrowRightLeft, ChevronDown, ChevronUp, ClipboardCheck } from 'lucide-react';
import { PageHeader, Button, EmptyState, Badge, Stat, Segmented, Skeleton } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { Table, useParam } from '@/components/common';
import { TimeframeText } from '@/components/Timeframe';
import { Attachments } from '@/components/Attachments';
import { Comments } from '@/components/Comments';
import RecordLineage from '@/components/RecordLineage';
import RecordImportDialog from '@/components/RecordImportDialog';
import DownloadMenu, { categoryDownloads, recordDownloads } from '@/components/DownloadMenu';
import DutyDialog, { DUTY_TONE, DutyDetail, type DutyMode } from '@/components/DutyDialog';
import { ApprovedPoints, DutyReviewActions, DutyReviewHistory } from '@/components/DutyReview';
import { entryHref, type MovedEntry } from '@/components/MoveRecordDialog';
import { can, canCorrectDuty, useDeleteRecord, useDuties, useDutyCandidates, useDutyReviewQueue, useIdentity, useKeepAsActivity, useRestoreRecord } from '@/lib/queries';
import * as api from '@/lib/api';
import { PERMISSIONS } from '../../shared/permissions';
import { formatNumber } from '../../shared/metrics';
import { formatTimeframe } from '../../shared/timeframe';
import { DUTY_STATUS_LABELS, formatHours, type DutyCandidate } from '../../shared/duty';
import { countedPoints, hasReviewOptions } from '../../shared/dutyReview';
import { formatStamp, timeAgo } from '@/lib/utils';
import type { Duty as DutyRow } from '../../shared/types';
import { usePlace } from '@/lib/place';

const SHOWN = 5;

type Who = 'mine' | 'recorded' | 'units' | 'review';

/**
 * Records → Duty (Task 17, ADR-0023; Task 18, ADR-0024): the duty a Marine stood, each with its type, times, what it ran
 * to, the points the Unit Instance's scoring gave it and the points it was approved for, where it stands with its
 * reviewers, and the activities that read like duty for their owner to move here. A leader also sees the duty they
 * recorded for their Marines and what their units hold, and a reviewer the duty waiting for their decision.
 */
export default function Duty() {
  const place = usePlace();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: identity } = useIdentity();
  const me = identity?.user.id;
  const [openId, setOpenId] = useParam('open');
  const [who, setWho] = useParam('who', 'mine');
  const { data: rows, isPending } = useDuties();
  const { data: queue, isPending: queuePending } = useDutyReviewQueue();
  const del = useDeleteRecord('duties');
  const restore = useRestoreRecord('duties');
  const [form, setForm] = useState<DutyMode | null>(null);
  const [view, setView] = useState<DutyRow | null>(null);
  const [confirm, setConfirm] = useState<DutyRow | null>(null);
  const [importing, setImporting] = useState(false);

  const all = rows ?? [];
  const mine = all.filter((r) => r.user_id === me);
  const recorded = all.filter((r) => r.user_id !== me && r.recorded_by === me);
  const units = all.filter((r) => r.user_id !== me);
  // A view with nothing left in it (the last duty recorded for a Marine deleted, an old link) falls back to one's own.
  // The review view is for someone who reviews duty somewhere, whether or not anything waits (the server says which).
  const reviewer = Boolean(queue?.reviewer);
  const waiting = queue?.items ?? [];
  const whoShown: Who = who === 'review' && reviewer ? 'review' : who === 'recorded' && recorded.length ? 'recorded' : who === 'units' && units.length ? 'units' : 'mine';
  const shown = whoShown === 'review' ? waiting : whoShown === 'recorded' ? recorded : whoShown === 'units' ? units : mine;

  // A notification, a timeline entry or a move opens the duty it is about.
  useEffect(() => {
    if (!openId || !rows) return;
    const r = rows.find((x) => x.id === openId);
    if (r) setView(r);
  }, [openId, rows]);

  // The open duty as the lists hold it now, so a decision made on it (here or by someone else) shows without reopening.
  // Whichever is newer wins: a decision just made is ahead of a list still being read again.
  const listed = view ? all.find((r) => r.id === view.id) ?? waiting.find((r) => r.id === view.id) : undefined;
  const viewed = view ? (listed && listed.version >= view.version ? listed : view) : null;

  const totals = useMemo(() => ({
    hours: mine.reduce((n, r) => n + (Number(r.hours) || 0), 0),
    points: mine.reduce((n, r) => n + (Number(r.calculated_points) || 0), 0),
    approved: mine.reduce((n, r) => n + countedPoints(r), 0),
    pending: mine.filter((r) => r.approval_status === 'pending').length,
    returned: mine.filter((r) => r.approval_status === 'returned').length,
  }), [mine]);

  // As the server decides (canEdit in server/authz/records.ts): decided duty stays as decided; duty a leader recorded is
  // theirs to correct, never its Marine's; a records manager corrects what is in their unit.
  const canEditRow = (r: DutyRow) => canCorrectDuty(identity, r);
  const goTo = (entry: MovedEntry) => { setView(null); setOpenId(''); navigate(entryHref(entry.table, entry.id)); };
  const openSaved = (saved: { id: string }) => { if (saved.id) setOpenId(saved.id); };
  const editViewed = (r: DutyRow) => { setView(null); setOpenId(''); setForm({ kind: 'edit', row: r }); };

  return (
    <div className="page">
      <PageHeader eyebrow={place.group} title="Duty" lede="The duty you stood: its type, its times and the points your Unit Instance's scoring gives it. Duty is submitted for review and counts, at its approved points, once a reviewer approves it.">
        <Button variant="primary" onClick={() => setForm({ kind: 'new' })}><Plus className="h-4 w-4" />Record duty</Button>
        <Button onClick={() => setImporting(true)}><Upload className="h-4 w-4" />Import</Button>
        <DownloadMenu label="Export" choices={categoryDownloads('duty')} />
      </PageHeader>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Duty stood" value={mine.length} hint={mine.length === 1 ? 'one entry' : `${mine.length} entries`} />
        <Stat label="Hours" value={formatNumber(Math.round(totals.hours * 100) / 100)} />
        <Stat label="Approved points" value={formatNumber(Math.round(totals.approved * 100) / 100)} hint={`${formatNumber(Math.round(totals.points * 100) / 100)} calculated`} />
        <Stat label="Awaiting review" value={totals.pending} hint={totals.returned ? `${totals.returned} returned to you` : undefined} tone={totals.returned ? 'warn' : undefined} />
      </div>

      <DutySuggestions onRecord={(activity) => setForm({ kind: 'move', activity })} />

      {reviewer && whoShown !== 'review' && (queue?.total ?? 0) > 0 && (
        <section aria-label="Duty waiting for your review" className="card mb-3 flex flex-wrap items-center justify-between gap-3 px-5 py-3">
          <p className="min-w-0 text-sm text-ink"><ClipboardCheck className="mr-1.5 inline h-4 w-4 text-accent" aria-hidden /><span className="font-medium">{queue!.total === 1 ? 'One duty is waiting for your review' : `${queue!.total} duties are waiting for your review`}</span>{waiting[0]?.submitted_at ? <span className="text-ink-3"> · the longest since {timeAgo(waiting[0].submitted_at)}</span> : null}</p>
          <Button size="sm" variant="soft" onClick={() => setWho('review')}>Review {queue!.total === 1 ? 'it' : 'them'}</Button>
        </section>
      )}

      {(recorded.length > 0 || units.length > 0 || reviewer) && (
        <div className="mb-3">
          <Segmented<Who> label="Whose duty" value={whoShown} onChange={(v) => setWho(v === 'mine' ? '' : v)}
            options={[{ value: 'mine' as Who, label: `Yours (${mine.length})` }, ...(recorded.length ? [{ value: 'recorded' as Who, label: `Recorded by you (${recorded.length})` }] : []), ...(units.length ? [{ value: 'units' as Who, label: `Your units (${units.length})` }] : []), ...(reviewer ? [{ value: 'review' as Who, label: `To review (${queue?.total ?? 0})` }] : [])]} />
        </div>
      )}

      {whoShown === 'review' ? (queuePending ? <Skeleton className="h-48" /> : waiting.length === 0 ? (
        <div className="card"><EmptyState icon={ClipboardCheck} title="Nothing is waiting for your review"
          description="Duty submitted in the units where you review it shows here, the longest-waiting first. Your own duty is another reviewer’s to decide." /></div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {/* The duty leads, so a phone shows what it is and whose before the table scrolls; it opens with every decision. */}
          <Table minWidth={900} head={<><th>Duty</th><th className="w-32">Waiting since</th><th className="w-44">When</th><th className="w-20 text-right">Hours</th><th className="w-24 text-right">Calculated</th><th className="w-[17rem]"><span className="sr-only">Decide</span></th></>}>
            {waiting.map((r) => (
              <tr key={r.id}>
                <td className="min-w-[11rem]">
                  <button type="button" className="text-left font-medium text-ink hover:underline" onClick={() => setView(r)}>{r.title || r.duty_type_name || 'Duty'}</button>
                  <span className="block text-xs text-ink-3">{[r.subject_name, r.title ? r.duty_type_name : null, r.recorder_name && r.recorded_by !== r.user_id ? `recorded by ${r.recorded_by === me ? 'you' : r.recorder_name}` : null, r.frozen_at ? 'its Marine has left the unit' : null].filter(Boolean).join(' · ')}</span>
                </td>
                <td className="text-xs"><span className="block text-ink">{timeAgo(r.submitted_at)}</span><time dateTime={r.submitted_at} className="fig block text-2xs text-ink-3">{formatStamp(r.submitted_at)}</time></td>
                <td className="text-xs"><TimeframeText table="duties" row={r} /></td>
                <td className="fig text-right text-xs">{formatHours(r.hours)}</td>
                <td className="fig text-right text-xs">{r.calculated_points == null ? <span className="text-ink-3">None</span> : formatNumber(r.calculated_points)}{r.scoring_version != null && <span className="block text-2xs text-ink-3">version {r.scoring_version}</span>}</td>
                <td><DutyReviewActions row={r} me={me} brief className="flex items-center justify-end gap-1 whitespace-nowrap" /></td>
              </tr>
            ))}
          </Table>
          {(queue?.total ?? 0) > waiting.length && <p className="border-t border-line px-5 py-2 text-2xs text-ink-3">Showing the {waiting.length} longest-waiting of {queue!.total}.</p>}
          {(queue?.units.length ?? 0) > 1 && <p className="border-t border-line px-5 py-2 text-2xs text-ink-3">Waiting in {queue!.units.map((u) => `${u.name} (${u.count})`).join(', ')}.</p>}
        </div>
      )) : isPending ? <Skeleton className="h-48" /> : shown.length === 0 ? (
        <div className="card"><EmptyState icon={ShieldCheck} title="No duty recorded"
          description="Record each duty once you have stood it: the duty type, when it began and when it ended. The points come from your Unit Instance’s scoring, and a reviewer approves them."
          action={<Button variant="primary" onClick={() => setForm({ kind: 'new' })}>Record duty</Button>} /></div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <Table minWidth={760} head={<><th className="w-44">When</th><th>Duty</th><th className="w-20 text-right">Hours</th><th className="w-24 text-right">Calculated</th><th className="w-24 text-right">Approved</th><th className="w-28">Status</th><th className="w-44"></th></>}>
            {shown.map((r) => (
              <tr key={r.id}>
                <td className="text-xs"><TimeframeText table="duties" row={r} /></td>
                <td>
                  <button type="button" className="text-left font-medium text-ink hover:underline" onClick={() => setView(r)}>{r.title || r.duty_type_name || 'Duty'}</button>
                  <span className="block text-xs text-ink-3">{[r.title ? r.duty_type_name : null, r.user_id !== me ? r.subject_name : null, r.recorder_name && r.recorded_by !== r.user_id ? `recorded by ${r.recorded_by === me ? 'you' : r.recorder_name}` : null].filter(Boolean).join(' · ')}</span>
                </td>
                <td className="fig text-right text-xs">{formatHours(r.hours)}</td>
                <td className="fig text-right text-xs">{r.calculated_points == null ? <span className="text-ink-3">None</span> : formatNumber(r.calculated_points)}{r.scoring_version != null && <span className="block text-2xs text-ink-3">version {r.scoring_version}</span>}</td>
                <td className="fig text-right text-xs"><ApprovedPoints row={r} /></td>
                <td><Badge tone={DUTY_TONE[r.approval_status]}>{DUTY_STATUS_LABELS[r.approval_status]}</Badge></td>
                <td className="whitespace-nowrap text-right">
                  <Button size="xs" variant="ghost" onClick={() => setView(r)}>View</Button>
                  {canEditRow(r) && <><Button size="xs" variant="ghost" onClick={() => setForm({ kind: 'edit', row: r })}>{r.approval_status === 'returned' ? 'Correct' : 'Edit'}</Button><Button size="xs" variant="ghost" onClick={() => setConfirm(r)}>Delete</Button></>}
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      <Dialog open={Boolean(viewed)} onOpenChange={(o) => { if (!o) { setView(null); setOpenId(''); } }} title={viewed ? viewed.title || viewed.duty_type_name || 'Duty' : ''} description={viewed ? formatTimeframe('duties', viewed, { pattern: 'd MMMM yyyy' }) || undefined : undefined} size="lg"
        footer={viewed ? <><DownloadMenu size="sm" choices={recordDownloads('duties', viewed.id, true)} />{canEditRow(viewed) && viewed.approval_status !== 'returned' && <Button onClick={() => editViewed(viewed)}>Edit</Button>}</> : undefined}>
        {viewed && hasReviewOptions(viewed.review) && (
          <section aria-label={viewed.user_id === me ? 'Its review' : 'Your decision'} className="mb-3 rounded-md border border-line bg-surface-2 px-3 py-2.5">
            <h3 className="eyebrow mb-1.5">{viewed.user_id === me ? 'Its review' : 'Your decision'}</h3>
            <DutyReviewActions row={viewed} me={me} onDone={setView} onCorrect={canEditRow(viewed) ? () => editViewed(viewed) : undefined} />
          </section>
        )}
        {viewed && <DutyDetail row={viewed} me={me} />}
        {viewed && <DutyReviewHistory id={viewed.id} className="mt-4" />}
        {viewed && <div className="mt-4"><Attachments table="duties" id={viewed.id} canEdit={canEditRow(viewed)} /></div>}
        {viewed && <RecordLineage store="duties" id={viewed.id} onUndone={goTo} className="mt-4" />}
        {viewed && <div className="mt-4"><Comments table="duties" id={viewed.id} canModerate={Boolean(viewed.unit_id) && can(identity, PERMISSIONS.MANAGE_RECORDS, viewed.unit_id)} /></div>}
      </Dialog>

      <DutyDialog mode={form} open={Boolean(form)} onOpenChange={(o) => { if (!o) setForm(null); }} onSaved={openSaved} />
      <RecordImportDialog open={importing} onOpenChange={setImporting} />
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title="Delete this duty?" body="It moves to the recycle bin for 30 days."
        onConfirm={async () => { const r = confirm!; try { await del.mutateAsync(r.id); setView(null); toast.success('Deleted.', { label: 'Undo', onClick: () => restore.mutateAsync(r.id).then(() => toast.success('Restored.')).catch((e) => toast.error(api.errorText(e))) }); } catch (e) { toast.error(api.errorText(e)); } }} />
    </div>
  );
}

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
                <Button size="xs" variant="soft" onClick={() => onRecord(c)} aria-describedby={`duty-suggestion-${c.id}`}><ArrowRightLeft className="h-3.5 w-3.5" />Record as duty</Button>
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
