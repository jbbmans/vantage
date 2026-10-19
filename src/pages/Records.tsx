import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Download, Upload, Search, LayoutList, LayoutGrid, Lock, Users, AlertTriangle, RotateCcw, SlidersHorizontal, Trash2, ChevronDown, ChevronUp } from 'lucide-react';
import { Panel, Button, Input, Select, Segmented, EmptyState, Badge, Skeleton, Tooltip } from '@/components/ui/primitives';
import { AiAction, AiResult } from '@/components/AiPanel';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog from '@/components/RecordDialog';
import CsvImportDialog from '@/components/CsvImportDialog';
import MoveRecordDialog from '@/components/MoveRecordDialog';
import { ActivityFields, emptyActivity, toActivityDraft, activityPayload, type ActivityDraft } from '@/components/ActivityForm';
import { PeriodSelect, DateText, CategoryDot, useParam, Table, PageShell } from '@/components/common';
import { can, useActivities, useRecords, useDeleteRecord, useIdentity, usePrefs, useRestoreRecord, useSavePrefs, useTrack, unitName, useOrg, useMetrics, useMoveCandidates, useKeepAsActivity } from '@/lib/queries';
import { PERMISSIONS } from '../../shared/permissions';
import * as api from '@/lib/api';
import { categoryNames } from '../../shared/constants';
import { areaOptions, mapAreaToTrack, trackMeta } from '../../shared/evaluation';
import { DEFAULT_PERIOD, activitiesInRange, rangeForPeriod, formatDollars, formatNumber, aggregateMetrics } from '../../shared/metrics';
import { findDuplicates } from '../../shared/duplicates';
import { strength } from '../../shared/bullets';
import { MOVABLE_LABELS, type MovableTable, type MoveCandidate } from '../../shared/recordKinds';
import type { Activity } from '../../shared/types';
import { cn } from '@/lib/utils';
import { usePlace } from '@/lib/place';

type Sort = 'date' | 'value' | 'strength' | 'updated';

export default function Records({ embedded }: { embedded?: boolean } = {}) {
  const place = usePlace();
  const cfg = useMetrics();
  const navigate = useNavigate();
  const toast = useToast();
  const { data: identity } = useIdentity();
  const { data: org } = useOrg();
  const prefs = usePrefs();
  const savePrefs = useSavePrefs();
  const track = useTrack();
  const { data: liveRows, isPending } = useActivities();
  const remove = useDeleteRecord('activities');
  const restore = useRestoreRecord('activities');
  const [q, setQ] = useState('');
  const [period, setPeriod] = useParam('period', prefs.reportPeriod || identity?.unitDefaults?.reportPeriod || DEFAULT_PERIOD);
  const [from] = useParam('from'); const [to] = useParam('to');
  const [category, setCategory] = useParam('category', 'all');
  const [area, setArea] = useParam('area', 'all');
  const [quality, setQuality] = useParam('quality', 'all');
  const { data: deletedRows } = useRecords('activities', { deleted: '1' }, quality === 'deleted');
  const rows = quality === 'deleted' ? deletedRows : liveRows;
  const [owner, setOwner] = useParam('owner', 'all');
  const [sort, setSort] = useState<Sort>('date');
  const activeFilters = [category, area, quality, owner].filter((v) => v !== 'all').length;
  // In one update: each useParam setter starts from this render's query, so four in a row would keep only the last.
  const [, setSearchParams] = useSearchParams();
  const clearFilters = (widenPeriod = false) => setSearchParams((p) => {
    const n = new URLSearchParams(p);
    for (const k of ['category', 'area', 'quality', 'owner']) n.delete(k);
    if (widenPeriod) n.set('period', 'all');
    return n;
  }, { replace: true });
  // The filters past search and period fold behind one button, on a desk as on a phone; a link that sets one opens them.
  const [showFilters, setShowFilters] = useState(activeFilters > 0);
  useEffect(() => { if (activeFilters) setShowFilters(true); }, [activeFilters]);
  const [view, setView] = useState<'list' | 'cards'>(() => (window.innerWidth < 640 ? 'cards' : 'list'));
  const [editing, setEditing] = useState<ActivityDraft | null>(null);
  const [coaching, setCoaching] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  const [confirm, setConfirm] = useState<any>(null);
  const [importOpen, setImportOpen] = useParam('import');
  const [moving, setMoving] = useState<{ row: Activity; to: MovableTable } | null>(null);
  // The dialog shows what the entry becomes and checks it has not changed since, so it needs the whole entry, not the
  // suggestion's summary of it: one outside the loaded period is fetched.
  const openMove = async (c: MoveCandidate) => {
    const live = liveRows?.find((a) => a.id === c.id);
    if (live) { setMoving({ row: live, to: c.to }); return; }
    try { setMoving({ row: await api.getRecord('activities', c.id) as Activity, to: c.to }); }
    catch (err) { toast.error(api.errorText(err)); }
  };

  const dupIds = useMemo(() => new Set(findDuplicates(rows || []).flatMap((g) => g.records.map((r) => r.id!))), [rows]);
  const filtered = useMemo(() => {
    let list: any[] = rows || [];
    if (from && to) list = list.filter((a) => a.date >= from && a.date <= to);
    else if (period !== 'all') list = activitiesInRange(list, rangeForPeriod(period));
    if (owner === 'mine') list = list.filter((a) => a.user_id === identity?.user.id);
    if (owner === 'unit') list = list.filter((a) => a.user_id !== identity?.user.id);
    if (category !== 'all') list = list.filter((a) => a.category === category);
    if (area !== 'all') list = list.filter((a) => mapAreaToTrack(a.eval_area, track) === area);
    if (quality === 'needs-detail') list = list.filter((a) => !a.result || !String(a.result).trim());
    if (quality === 'untagged') list = list.filter((a) => !a.eval_area || a.eval_area === 'Unassigned');
    if (quality === 'duplicates') list = list.filter((a) => dupIds.has(a.id));
    if (quality === 'no-numbers') list = list.filter((a) => a.quantity == null && a.dollar_amount == null);
    if (q.trim()) { const needle = q.trim().toLowerCase(); list = list.filter((a) => [a.title, a.result, a.organization, a.system, a.notes, a.category, a.eval_area].some((v) => String(v || '').toLowerCase().includes(needle))); }
    const cmp: Record<Sort, (a: any, b: any) => number> = {
      date: (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.created_at.localeCompare(a.created_at),
      value: (a, b) => (Number(b.dollar_amount) || 0) - (Number(a.dollar_amount) || 0),
      strength: (a, b) => strength(b) - strength(a),
      updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
    };
    return [...list].sort(cmp[sort]);
  }, [rows, from, to, period, owner, category, area, quality, q, sort, dupIds, identity?.user.id, track]);
  const metrics = useMemo(() => aggregateMetrics(filtered, cfg), [filtered, cfg]);
  const hasShared = (rows || []).some((a) => a.user_id !== identity?.user.id);

  const del = async (a: any) => {
    try {
      await remove.mutateAsync(a.id);
      toast.success('Entry deleted.', { label: 'Undo', onClick: () => restore.mutateAsync(a.id).then(() => toast.success('Entry restored.')).catch((e) => toast.error(api.errorText(e))) });
    } catch (e) { toast.error(api.errorText(e)); }
  };
  const exportCsv = async () => {
    try { const name = await api.downloadFile(api.reportCsvUrl({ period: from && to ? 'custom' : period, from, to }), 'vantage-activities.csv'); toast.success(`Downloaded ${name}.`); }
    catch (e) { toast.error(api.errorText(e)); }
  };
  const canEditRow = (a: any) => !a.deleted_at && (a.user_id === identity?.user.id ? !a.frozen_at : can(identity, PERMISSIONS.MANAGE_RECORDS, a.unit_id));
  const restoreRow = async (a: any) => { try { await restore.mutateAsync(a.id); toast.success('Entry restored.'); } catch (e) { toast.error(api.errorText(e)); } };

  const qualityOptions = [
    { value: 'all', label: 'All entries' }, { value: 'needs-detail', label: 'Missing an outcome' }, { value: 'untagged', label: `No ${trackMeta(track).areaLabel}` },
    { value: 'no-numbers', label: 'No quantity or value' }, { value: 'duplicates', label: `Possible duplicates${dupIds.size ? ` (${dupIds.size})` : ''}` },
    { value: 'deleted', label: 'Recycle bin (30 days)' },
  ];

  return (
    <PageShell
      embedded={embedded}
      eyebrow={place.group}
      title={embedded ? 'Activities you recorded' : 'Activities'}
      lede="Everything you logged yourself, in one place. Filter, fix, and export."
      actions={<>
        <Button onClick={() => setImportOpen('1')}><Upload className="h-4 w-4" />Import activities</Button>
        <Button onClick={exportCsv}><Download className="h-4 w-4" />Export activities</Button>
        <Button variant="primary" onClick={() => setEditing(emptyActivity({ visibility: prefs.defaultVisibility || 'private', unit_id: identity?.homeUnitId || null }))}><Plus className="h-4 w-4" />New activity</Button>
      </>}
    >
      {identity && <MoveSuggestions userId={identity.user.id} onMove={openMove} />}

      <div className="card mb-3 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-3" /><Input aria-label="Search records" className="pl-8" placeholder="Title, result, or system…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {from && to ? <Badge tone="accent">{from === to ? from : `${from} → ${to}`}<button type="button" className="ml-1 hover:text-ink" onClick={() => navigate('/record/activities')} aria-label="Clear date filter">×</button></Badge> : <PeriodSelect value={period} onChange={(v) => { setPeriod(v); savePrefs.mutate({ reportPeriod: v }); }} className="w-40" />}
          <Button onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters} aria-controls="record-filters">
            <SlidersHorizontal className="h-4 w-4" />Filters{activeFilters ? <span className="fig ml-0.5 rounded-full bg-accent px-1.5 text-2xs text-accent-ink">{activeFilters}</span> : null}
          </Button>
          <Segmented size="sm" label="Layout" value={view} onChange={setView} options={[{ value: 'list', label: <LayoutList className="h-4 w-4" />, ariaLabel: 'List' }, { value: 'cards', label: <LayoutGrid className="h-4 w-4" />, ariaLabel: 'Cards' }]} />
        </div>
        <div id="record-filters" className={cn('mt-2 grid-cols-2 gap-2 sm:flex-wrap sm:items-center', showFilters ? 'grid sm:flex' : 'hidden')}>
          <Select aria-label="Category" className="max-sm:w-full sm:w-44" value={category} onValueChange={setCategory} options={[{ value: 'all', label: 'All categories' }, ...categoryNames(cfg).map((c) => ({ value: c, label: c }))]} />
          <Select aria-label={trackMeta(track).areaLabel} className="max-sm:w-full sm:w-48" value={area} onValueChange={setArea} options={[{ value: 'all', label: `All ${trackMeta(track).areaLabel}s` }, ...areaOptions(track)]} />
          <Select aria-label="Quality filter" className="max-sm:w-full sm:w-52" value={quality} onValueChange={setQuality} options={qualityOptions} />
          {hasShared && <Select aria-label="Owner" className="max-sm:w-full sm:w-36" value={owner} onValueChange={setOwner} options={[{ value: 'all', label: 'Everyone' }, { value: 'mine', label: 'Mine' }, { value: 'unit', label: 'Shared with me' }]} />}
          <Select aria-label="Sort" className="max-sm:w-full sm:w-36" value={sort} onValueChange={(v) => setSort(v as Sort)} options={[{ value: 'date', label: 'Newest first' }, { value: 'value', label: 'Highest value' }, { value: 'strength', label: 'Strongest' }, { value: 'updated', label: 'Recently edited' }]} />
          {activeFilters > 0 && <Button size="sm" variant="ghost" onClick={() => clearFilters()}>Clear filters</Button>}
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-3"><span className="fig text-ink">{filtered.length}</span> entries · <span className="fig text-ink">{formatDollars(metrics.totalDollars)}</span> summable · <span className="fig text-ink">{metrics.withOutcome}</span> with an outcome</p>
          {identity?.instance.aiEnabled && (
            <AiAction workflow="record_quality" surface="records" input={{ days: 180 }} label="Coach my entries" onResult={(output, meta) => setCoaching({ output, meta })} />
          )}
        </div>
      </div>

      {coaching && (
        <Panel
          className="mb-4"
          title="Which entries are weak"
          subtitle="The last six months, with suggested rewrites; a coach, not a grader"
          action={<Button size="xs" variant="ghost" onClick={() => setCoaching(null)}>Dismiss</Button>}
        >
          <AiResult output={coaching.output} meta={coaching.meta} />
        </Panel>
      )}

      {isPending ? <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12" />)}</div> : filtered.length === 0 ? (
        <div className="card"><EmptyState icon={Search} title={quality === 'deleted' ? 'The recycle bin is empty' : rows?.length ? 'Nothing matches those filters' : 'No activities yet'} description={rows?.length ? 'Loosen a filter, or widen the period.' : 'Press N to log your first one, or import a spreadsheet.'} action={rows?.length ? <Button onClick={() => { setQ(''); clearFilters(true); }}>Clear filters</Button> : <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}>Log activity</Button>} /></div>
      ) : view === 'list' ? (
        <div className="card">
          <Table minWidth={880} head={<><th className="w-24">Date</th><th className="min-w-[18rem]">Entry</th><th className="w-40">{trackMeta(track).areaLabel}</th><th className="w-28 text-right">Qty</th><th className="w-28 text-right">Value</th><th className="w-20">Share</th><th className="w-24"></th></>}>
            {filtered.map((a) => {
              const s = strength(a);
              return (
                <tr key={a.id} className={cn(dupIds.has(a.id) && quality === 'duplicates' && 'bg-bad/5')}>
                  <td className="whitespace-nowrap text-xs text-ink-2"><DateText value={a.date} /></td>
                  <td className="min-w-0">
                    <Link to={`/records/${a.id}`} className="flex items-start gap-2"><CategoryDot category={a.category} /><span className="min-w-0"><span className="block font-medium text-ink hover:underline">{a.title}</span>{a.result ? <span className="block truncate text-xs text-ink-3">{a.result}</span> : <span className="block text-xs text-warn">No outcome recorded</span>}</span></Link>
                    {a.user_id !== identity?.user.id && a.owner_name && <span className="mt-0.5 block text-2xs text-ink-3">{a.owner_name}</span>}
                  </td>
                  <td className="text-xs text-ink-2">{mapAreaToTrack(a.eval_area, track) === 'Unassigned' ? <span className="text-warn">Untagged</span> : mapAreaToTrack(a.eval_area, track)}</td>
                  <td className="fig text-right text-xs">{a.quantity != null ? `${formatNumber(a.quantity)} ${a.unit_label || ''}` : ''}</td>
                  <td className="fig text-right text-xs">{a.dollar_amount != null ? formatDollars(a.dollar_amount) : ''}</td>
                  <td><Tooltip content={a.visibility === 'unit' ? `Shared with ${unitName(identity, a.unit_id, org)}` : 'Only you'}><span className="inline-flex text-ink-3">{a.visibility === 'unit' ? <Users className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}</span></Tooltip></td>
                  <td className="text-right"><span className="inline-flex items-center gap-1"><Tooltip content={`Bullet strength ${s}/5`}><span className={cn('fig text-2xs', s >= 4 ? 'text-good' : s >= 2 ? 'text-ink-3' : 'text-warn')}>{s}/5</span></Tooltip>{a.deleted_at ? <Button size="xs" variant="soft" onClick={() => restoreRow(a)}><RotateCcw className="h-3 w-3" />Restore</Button> : canEditRow(a) && <><Button size="xs" variant="ghost" onClick={() => setEditing(toActivityDraft(a))}>Edit</Button><Button size="xs" variant="ghost" className="text-ink-3 hover:text-bad" onClick={() => setConfirm(a)} aria-label={`Delete ${a.title}`}><Trash2 className="h-3.5 w-3.5" /></Button></>}</span></td>
                </tr>
              );
            })}
          </Table>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((a) => (
            <article key={a.id} className="card card-hover flex flex-col p-4">
              <div className="flex items-start justify-between gap-2"><span className="flex items-center gap-1.5 text-xs text-ink-3"><CategoryDot category={a.category} />{a.category || 'Uncategorized'}</span><span className="text-xs text-ink-3"><DateText value={a.date} /></span></div>
              <Link to={`/records/${a.id}`} className="mt-2 block text-base font-medium leading-snug text-ink hover:underline">{a.title}</Link>
              <p className={cn('mt-1 line-clamp-2 text-sm', a.result ? 'text-ink-2' : 'text-warn')}>{a.result || 'No outcome recorded'}</p>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                {a.quantity != null && <Badge>{formatNumber(a.quantity)} {a.unit_label || ''}</Badge>}
                {a.dollar_amount != null && <Badge tone="accent">{formatDollars(a.dollar_amount)}</Badge>}
                {mapAreaToTrack(a.eval_area, track) !== 'Unassigned' && <Badge tone="info">{mapAreaToTrack(a.eval_area, track)}</Badge>}
                {dupIds.has(a.id) && <Badge tone="bad"><AlertTriangle className="h-3 w-3" />Dup?</Badge>}
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-line pt-2 text-xs text-ink-3"><span className="flex items-center gap-1">{a.visibility === 'unit' ? <Users className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}{a.visibility === 'unit' ? unitName(identity, a.unit_id, org) : 'Only you'}</span>{a.deleted_at ? <Button size="xs" variant="soft" onClick={() => restoreRow(a)}>Restore</Button> : canEditRow(a) && <span><Button size="xs" variant="ghost" onClick={() => setEditing(toActivityDraft(a))}>Edit</Button><Button size="xs" variant="ghost" onClick={() => setConfirm(a)}>Delete</Button></span>}</div>
            </article>
          ))}
        </div>
      )}

      <RecordDialog<ActivityDraft> store="activities" open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} initial={editing ? { ...editing } : null} title={editing?.id ? 'Edit activity' : 'New activity'} noun="Activity" size="lg"
        fields={(draft, set, errors) => <ActivityFields draft={draft} set={set} errors={errors} onSavedAs={() => setEditing(null)} />} validate={(d) => (!d.title.trim() ? 'A title is required.' : null)} onSaved={() => undefined} />
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title="Delete this entry?" body={<>“{confirm?.title}” moves to the recycle bin for 30 days. You can undo right away.</>} onConfirm={() => del(confirm)} />
      <CsvImportDialog open={importOpen === '1'} onOpenChange={(o) => setImportOpen(o ? '1' : '')} />
      <MoveRecordDialog store="activities" row={moving?.row ?? null} suggested={moving?.to} open={Boolean(moving)} onOpenChange={(o) => { if (!o) setMoving(null); }} />
      <RestoreHint />
    </PageShell>
  );
}

const collapsedKey = (userId: string) => `vantage.move-suggestions-collapsed.${userId}`;

/**
 * The person's activities that read like an award they received or training they completed (ADR-0015). Each one is
 * theirs to move or keep: nothing moves on its own, and an entry kept as an activity is not suggested again.
 */
function MoveSuggestions({ userId, onMove }: { userId: string; onMove: (c: MoveCandidate) => void }) {
  const toast = useToast();
  const { data } = useMoveCandidates();
  const keep = useKeepAsActivity();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(collapsedKey(userId)) === '1'; } catch { return false; } });
  const candidates = data?.candidates || [];
  if (!candidates.length) return null;

  const total = data?.total ?? candidates.length;
  const awards = candidates.some((c) => c.to === 'awards'); const training = candidates.some((c) => c.to === 'trainings');
  const kinds = awards && training ? 'awards or training' : awards ? (total === 1 ? 'an award' : 'awards') : 'training';
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(collapsedKey(userId), next ? '1' : ''); } catch { /* ignore */ }
  };
  const keepIt = async (c: MoveCandidate) => {
    try { await keep.mutateAsync(c.id); toast.success('Kept as an activity. It will not be suggested again.'); }
    catch (e) { toast.error(api.errorText(e)); }
  };

  return (
    <section aria-labelledby="move-suggestions" className="card mb-3">
      <div className="flex items-start justify-between gap-3 px-5 py-3.5">
        <div className="min-w-0">
          <h2 id="move-suggestions" className="text-md font-semibold text-ink">{total === 1 ? `One of your activities reads like ${kinds}` : `${total} of your activities read like ${kinds}`}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-3">Awards and training have records of their own. Move the ones that really are, and keep the rest here. Nothing moves unless you choose it, and a move can be undone.</p>
        </div>
        <Button size="xs" variant="ghost" onClick={toggle} aria-expanded={!collapsed} aria-controls="move-suggestions-list">{collapsed ? <><ChevronDown className="h-3.5 w-3.5" />Show suggestions</> : <><ChevronUp className="h-3.5 w-3.5" />Hide suggestions</>}</Button>
      </div>
      <div id="move-suggestions-list" hidden={collapsed}>
        <ul className="divide-y divide-line border-t border-line">
          {candidates.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-2.5">
              <span className="min-w-0 flex-1 basis-60">
                <Link id={`move-suggestion-${c.id}`} to={`/records/${c.id}`} className="block truncate text-sm font-medium text-ink hover:underline">{c.title}</Link>
                <span className="block text-xs text-ink-3"><DateText value={c.date} /> · {c.reading.why}</span>
              </span>
              <span className="flex shrink-0 gap-1">
                <Button size="xs" variant="soft" onClick={() => onMove(c)} aria-describedby={`move-suggestion-${c.id}`}>Move to {MOVABLE_LABELS[c.to].place}</Button>
                <Button size="xs" variant="ghost" onClick={() => keepIt(c)} loading={keep.isPending && keep.variables === c.id} aria-describedby={`move-suggestion-${c.id}`}>Keep as activity</Button>
              </span>
            </li>
          ))}
        </ul>
        {total > candidates.length && <p className="border-t border-line px-5 py-2 text-2xs text-ink-3">Showing the newest {candidates.length} of {total}. More appear as you move or keep these.</p>}
      </div>
    </section>
  );
}

function RestoreHint() {
  return <p className="mt-4 flex items-center gap-1.5 text-2xs text-ink-3"><RotateCcw className="h-3 w-3" />Deleted entries can be restored from their page for 30 days.</p>;
}

export { activityPayload };
