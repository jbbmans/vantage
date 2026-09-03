import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Download, Upload, Search, LayoutList, LayoutGrid, Lock, Users, AlertTriangle, RotateCcw } from 'lucide-react';
import { PageHeader, Button, Input, Select, Segmented, EmptyState, Badge, Skeleton, Tooltip } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import RecordDialog from '@/components/RecordDialog';
import CsvImportDialog from '@/components/CsvImportDialog';
import { ActivityFields, emptyActivity, toActivityDraft, activityPayload, type ActivityDraft } from '@/components/ActivityForm';
import { PeriodSelect, DateText, CategoryDot, useParam, Table } from '@/components/common';
import { useActivities, useRecords, useDeleteRecord, useIdentity, usePrefs, useRestoreRecord, useSavePrefs, useTrack, unitName, useOrg } from '@/lib/queries';
import * as api from '@/lib/api';
import { CATEGORIES } from '../../shared/constants';
import { areaOptions, mapAreaToTrack, trackMeta } from '../../shared/evaluation';
import { activitiesInRange, rangeForPeriod, formatDollars, formatNumber, aggregateMetrics } from '../../shared/metrics';
import { findDuplicates } from '../../shared/duplicates';
import { strength } from '../../shared/bullets';
import { cn } from '@/lib/utils';

type Sort = 'date' | 'value' | 'strength' | 'updated';

export default function Records() {
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
  const [period, setPeriod] = useParam('period', prefs.reportPeriod || 'fiscalYear');
  const [from] = useParam('from'); const [to] = useParam('to');
  const [category, setCategory] = useParam('category', 'all');
  const [area, setArea] = useParam('area', 'all');
  const [quality, setQuality] = useParam('quality', 'all');
  const { data: deletedRows } = useRecords('activities', { deleted: '1' }, quality === 'deleted');
  const rows = quality === 'deleted' ? deletedRows : liveRows;
  const [owner, setOwner] = useParam('owner', 'all');
  const [sort, setSort] = useState<Sort>('date');
  const [view, setView] = useState<'list' | 'cards'>(() => (window.innerWidth < 640 ? 'cards' : 'list'));
  const [editing, setEditing] = useState<ActivityDraft | null>(null);
  const [confirm, setConfirm] = useState<any>(null);
  const [importOpen, setImportOpen] = useParam('import');

  useEffect(() => { document.title = 'Records · Vantage'; }, []);

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
  const metrics = useMemo(() => aggregateMetrics(filtered), [filtered]);
  const hasShared = (rows || []).some((a: any) => a.user_id !== identity?.user.id);

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
  const canEditRow = (a: any) => !a.deleted_at && (a.user_id === identity?.user.id ? !a.frozen_at : Boolean(a.unit_id && identity && ((identity.permissions[a.unit_id] || 0) & ((1 << 12) | (1 << 3)))));
  const restoreRow = async (a: any) => { try { await restore.mutateAsync(a.id); toast.success('Entry restored.'); } catch (e) { toast.error(api.errorText(e)); } };

  const qualityOptions = [
    { value: 'all', label: 'All entries' }, { value: 'needs-detail', label: 'Missing an outcome' }, { value: 'untagged', label: `Untagged ${trackMeta(track).areaLabel.toLowerCase()}` },
    { value: 'no-numbers', label: 'No quantity or value' }, { value: 'duplicates', label: `Possible duplicates${dupIds.size ? ` (${dupIds.size})` : ''}` },
    { value: 'deleted', label: 'Recycle bin (30 days)' },
  ];

  return (
    <div className="page">
      <PageHeader eyebrow="Records" title="Activities" lede="Every quantified accomplishment, in one place. Filter, fix, and export.">
        <Button onClick={() => setImportOpen('1')}><Upload className="h-4 w-4" />Import CSV</Button>
        <Button onClick={exportCsv}><Download className="h-4 w-4" />Export CSV</Button>
        <Button variant="primary" onClick={() => setEditing(emptyActivity({ visibility: prefs.defaultVisibility || 'private', unit_id: identity?.primaryUnitId || null }))}><Plus className="h-4 w-4" />New entry</Button>
      </PageHeader>

      <div className="card mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-3" /><Input aria-label="Search records" className="pl-8" placeholder="Search title, result, org, system…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
          {from && to ? <Badge tone="accent" className="normal-case tracking-normal">{from === to ? from : `${from} → ${to}`}<button type="button" className="ml-1 hover:text-ink" onClick={() => navigate('/records')} aria-label="Clear date filter">×</button></Badge> : <PeriodSelect value={period} onChange={(v) => { setPeriod(v); savePrefs.mutate({ reportPeriod: v }); }} className="w-40" />}
          <Select aria-label="Category" className="w-44" value={category} onValueChange={setCategory} options={[{ value: 'all', label: 'All categories' }, ...CATEGORIES.map((c) => ({ value: c, label: c }))]} />
          <Select aria-label={trackMeta(track).areaLabel} className="w-48" value={area} onValueChange={setArea} options={[{ value: 'all', label: `All ${trackMeta(track).areaLabel.toLowerCase()}s` }, ...areaOptions(track)]} />
          <Select aria-label="Quality filter" className="w-52" value={quality} onValueChange={setQuality} options={qualityOptions} />
          {hasShared && <Select aria-label="Owner" className="w-36" value={owner} onValueChange={setOwner} options={[{ value: 'all', label: 'Everyone' }, { value: 'mine', label: 'Mine' }, { value: 'unit', label: 'Shared with me' }]} />}
          <Select aria-label="Sort" className="w-36" value={sort} onValueChange={(v) => setSort(v as Sort)} options={[{ value: 'date', label: 'Newest first' }, { value: 'value', label: 'Highest value' }, { value: 'strength', label: 'Strongest' }, { value: 'updated', label: 'Recently edited' }]} />
          <Segmented size="sm" label="Layout" value={view} onChange={setView} options={[{ value: 'list', label: <LayoutList className="h-4 w-4" />, ariaLabel: 'List' }, { value: 'cards', label: <LayoutGrid className="h-4 w-4" />, ariaLabel: 'Cards' }]} />
        </div>
        <p className="mt-2 text-xs text-ink-3"><span className="fig font-medium text-ink">{filtered.length}</span> entries · <span className="fig">{formatDollars(metrics.totalDollars)}</span> summable · <span className="fig">{metrics.withOutcome}</span> with an outcome</p>
      </div>

      {isPending ? <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12" />)}</div> : filtered.length === 0 ? (
        <div className="card"><EmptyState icon={Search} title={quality === 'deleted' ? 'The recycle bin is empty' : rows?.length ? 'Nothing matches those filters' : 'No activities yet'} description={rows?.length ? 'Loosen a filter, or widen the period.' : 'Press N to log your first one, or import a spreadsheet.'} action={rows?.length ? <Button onClick={() => { setQ(''); setCategory('all'); setArea('all'); setQuality('all'); setOwner('all'); setPeriod('all'); }}>Clear filters</Button> : <Button variant="primary" onClick={() => window.dispatchEvent(new CustomEvent('vantage:open-quick-log', { detail: '' }))}>Log activity</Button>} /></div>
      ) : view === 'list' ? (
        <div className="card" style={{ overflow: 'hidden' }}>
          <Table minWidth={760} head={<><th className="w-24">Date</th><th>Entry</th><th className="w-40">{trackMeta(track).areaLabel}</th><th className="w-28 text-right">Qty</th><th className="w-28 text-right">Value</th><th className="w-20">Share</th><th className="w-24"></th></>}>
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
                  <td className="text-right"><span className="inline-flex items-center gap-1"><Tooltip content={`Bullet strength ${s}/5`}><span className={cn('fig text-2xs', s >= 4 ? 'text-good' : s >= 2 ? 'text-ink-3' : 'text-warn')}>{s}/5</span></Tooltip>{a.deleted_at ? <Button size="xs" variant="soft" onClick={() => restoreRow(a)}><RotateCcw className="h-3 w-3" />Restore</Button> : canEditRow(a) && <><Button size="xs" variant="ghost" onClick={() => setEditing(toActivityDraft(a))}>Edit</Button><Button size="xs" variant="ghost" className="text-ink-3 hover:text-bad" onClick={() => setConfirm(a)} aria-label="Delete">×</Button></>}</span></td>
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
        fields={(draft, set, errors) => <ActivityFields draft={draft} set={set} errors={errors} />} validate={(d) => (!d.title.trim() ? 'A title is required.' : null)} onSaved={() => undefined} />
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title="Delete this entry?" body={<>“{confirm?.title}” moves to the recycle bin for 30 days. You can undo right away.</>} onConfirm={() => del(confirm)} />
      <CsvImportDialog open={importOpen === '1'} onOpenChange={(o) => setImportOpen(o ? '1' : '')} />
      <RestoreHint />
    </div>
  );
}

function RestoreHint() {
  return <p className="mt-4 flex items-center gap-1.5 text-2xs text-ink-3"><RotateCcw className="h-3 w-3" />Deleted entries can be restored from their page for 30 days.</p>;
}

export { activityPayload };
