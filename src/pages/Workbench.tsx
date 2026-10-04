import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Bookmark, ClipboardCopy, Filter, Hand, Inbox, Mail,
  RefreshCw, Search, Trash2, Upload, X,
} from 'lucide-react';
import { Button, Input, Select, Badge, EmptyState, Skeleton, Field } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText, DueText, PageShell, dueIn } from '@/components/common';
import { StageBadge } from '@/components/work';
import ImportWizard from '@/components/ImportWizard';
import { useIdentity, useItemThreads, useThreads, invalidateCorrespondence, invalidateWork } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatDollarsExact, formatNumber } from '../../shared/metrics';
import { cn, isoDay, todayIso, useMediaQuery } from '@/lib/utils';
import { track } from '@/lib/telemetry';
import { PROCEDURES, PROCEDURE_LIST } from '../../shared/procedures';

const STATES = [
  { value: '', label: 'Any state' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'not_applicable', label: 'Not applicable' },
];

const STATE_LABEL: Record<string, string> = Object.fromEntries(STATES.filter((s) => s.value).map((s) => [s.value, s.label]));

const COLUMNS = [
  { key: 'reference', label: 'Document', width: 'w-36' },
  { key: 'title', label: 'What it is', width: '' },
  { key: 'state', label: 'Stage', width: 'w-40' },
  { key: 'due_date', label: 'Due', width: 'w-28' },
  { key: 'amount', label: 'Amount', width: 'w-28' },
  { key: 'claimed', label: 'Held by', width: 'w-32' },
];

const ROW_HEIGHT = 52;
const WINDOW_OVERSCAN = 8;

interface Query {
  state: string; active: boolean; claimed: string; q: string; sort: string; direction: 'asc' | 'desc'; unit_id: string; procedure: string; limit: number; offset: number;
  /** Past due and still open. */
  overdue: boolean;
}

const DEFAULT_QUERY: Query = { state: '', active: true, claimed: '', q: '', sort: 'due_date', direction: 'asc', unit_id: '', procedure: '', limit: 200, offset: 0, overdue: false };

/** The day before today on the viewer's calendar: due on or before it, and still open, is overdue. */
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return isoDay(d); };
const isClosedRow = (row: { state?: string }) => ['resolved', 'not_applicable'].includes(String(row.state));
const isOverdue = (row: { due_date?: string | null; state?: string }) => Boolean(row.due_date && row.due_date < todayIso() && !isClosedRow(row));
const PROCEDURE_FILTER = [
  { value: '', label: 'Any procedure' },
  ...PROCEDURE_LIST.map((p) => ({ value: p.key, label: p.short })),
  { value: 'none', label: 'No procedure' },
];

export default function Workbench({ embedded }: { embedded?: boolean } = {}) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [query, setQuery] = useState<Query>(() => ({
    ...DEFAULT_QUERY,
    claimed: ['me', 'nobody', 'anyone'].includes(searchParams.get('claimed') || '') ? String(searchParams.get('claimed')) : '',
    procedure: PROCEDURE_FILTER.some((o) => o.value && o.value === searchParams.get('procedure')) ? String(searchParams.get('procedure')) : '',
    overdue: searchParams.get('overdue') === '1',
  }));
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const openItem = useCallback((id: string) => navigate(`/work/items/${id}`), [navigate]);
  const [importing, setImporting] = useState(false);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [deletingView, setDeletingView] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  // One layout or the other, never both in the DOM at once.
  const wide = useMediaQuery('(min-width: 1024px)');

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery((q) => (q.q === search ? q : { ...q, q: search, offset: 0 })), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = useMemo(() => ({
    state: query.state || undefined, active: query.active && !query.state ? '1' : undefined, claimed: query.claimed || undefined, q: query.q || undefined,
    unit_id: query.unit_id || undefined, procedure: query.procedure || undefined, sort: query.sort, direction: query.direction,
    limit: query.limit, offset: query.offset, due_before: query.overdue ? yesterday() : undefined,
  }), [query]);

  const list = useQuery({ queryKey: ['work-items', params], queryFn: () => api.listWorkItems(params), staleTime: 10_000 });
  const views = useQuery({ queryKey: ['work-views'], queryFn: api.listWorkViews, staleTime: 60_000 });
  const rows: any[] = useMemo(() => list.data?.items || [], [list.data]);
  const total: number = list.data?.total ?? 0;

  const refresh = useCallback(() => invalidateWork(qc), [qc]);

  useEffect(() => { setCursor(0); setSelected(new Set()); }, [query]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight || 600);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const sortBy = (key: string) => setQuery((q) => ({ ...q, sort: key, direction: q.sort === key && q.direction === 'asc' ? 'desc' : 'asc', offset: 0 }));

  const toggleSelected = useCallback((id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  }), []);

  const copySelection = useCallback(async () => {
    const chosen = selected.size ? rows.filter((r) => selected.has(r.id)) : rows.slice(cursor, cursor + 1);
    if (!chosen.length) return;
    const header = ['Identifier', 'What it is', 'State', 'Due', 'Value', 'Type'].join('\t');
    const body = chosen.map((r) => [r.reference || r.natural_key, r.title, STATE_LABEL[r.state] || r.state, r.due_date || '', r.amount ?? '', r.amount_type || ''].join('\t')).join('\n');
    try {
      await navigator.clipboard.writeText(`${header}\n${body}`);
      toast.success(`${chosen.length} ${chosen.length === 1 ? 'row' : 'rows'} copied.`);
    } catch { toast.error('The browser would not let Vantage write to the clipboard.'); }
  }, [selected, rows, cursor, toast]);

  const claim = useCallback(async (row: any) => {
    try { await api.claimWorkItem(row.id, row.version); toast.success(`You picked up ${row.reference || row.natural_key}. It is on your assigned list now.`); refresh(); }
    catch (e) { toast.error(api.errorText(e)); refresh(); }
  }, [toast, refresh]);

  const release = useCallback(async (row: any) => {
    try { await api.releaseWorkItem(row.id, row.version); toast.success(`${row.reference || row.natural_key} is back in the queue.`); refresh(); }
    catch (e) { toast.error(api.errorText(e)); refresh(); }
  }, [toast, refresh]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable;
      if (importing || saveViewOpen) return;
      if (typing) {
        if (event.key === 'Escape') (target as HTMLInputElement).blur();
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'c' && selected.size) { event.preventDefault(); void copySelection(); }
        return;
      }
      const move = (delta: number) => {
        event.preventDefault();
        setCursor((c) => {
          const next = Math.max(0, Math.min(rows.length - 1, c + delta));
          const el = scroller.current;
          if (el) {
            const top = next * ROW_HEIGHT;
            if (top < el.scrollTop) el.scrollTop = top;
            else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
          }
          return next;
        });
      };
      if (event.key === 'j' || event.key === 'ArrowDown') move(1);
      else if (event.key === 'k' || event.key === 'ArrowUp') move(-1);
      else if (event.key === ' ') { event.preventDefault(); if (rows[cursor]) toggleSelected(rows[cursor].id); }
      else if (event.key === 'Enter') { event.preventDefault(); if (rows[cursor]) openItem(rows[cursor].id); }
      else if (event.key === 'c') { event.preventDefault(); if (rows[cursor]) void claim(rows[cursor]); }
      else if (event.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cursor, selected, importing, saveViewOpen, toggleSelected, copySelection, claim, openItem]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - WINDOW_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + WINDOW_OVERSCAN * 2;
  const windowed = rows.slice(first, first + visibleCount);

  const applyView = (config: Record<string, unknown>) => {
    const next = { ...DEFAULT_QUERY, ...config } as Query;
    setQuery(next);
    setSearch(next.q);
  };
  // A view stays selected only while the queue still shows it; once anything changes, picking it again reapplies it.
  const showing = (config: Record<string, unknown>) => {
    const v = { ...DEFAULT_QUERY, ...config } as Query;
    return v.q === search.trim() && (['state', 'active', 'claimed', 'sort', 'direction', 'unit_id', 'procedure', 'overdue'] as const).every((k) => v[k] === query[k]);
  };
  const activeView = views.data?.find((v: any) => v.id === activeViewId && showing(v.config)) ?? null;
  const deleteActiveView = async () => {
    if (!activeView) return;
    try {
      await api.deleteWorkView(activeView.id);
      toast.success(`Deleted the view “${activeView.name}”.`);
      setActiveViewId(null);
      qc.invalidateQueries({ queryKey: ['work-views'] });
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setDeletingView(false); }
  };

  const saveCurrentView = async () => {
    try {
      // The search box reaches the query a beat after typing stops; the view keeps what the box says now.
      const q = search.trim();
      const saved = await api.saveWorkView({ name: viewName, config: { state: query.state, active: query.active, claimed: query.claimed, q, sort: query.sort, direction: query.direction, unit_id: query.unit_id, procedure: query.procedure, overdue: query.overdue } });
      track('work.view_saved', { filters: [query.state, query.claimed, q, query.unit_id, query.procedure].filter(Boolean).length });
      toast.success('View saved.');
      setSaveViewOpen(false); setViewName('');
      setActiveViewId(saved?.id ?? null);
      qc.invalidateQueries({ queryKey: ['work-views'] });
    } catch (e) { toast.error(api.errorText(e)); }
  };

  const heldByMe = rows.filter((r) => r.claimed_by === identity?.user.id).length;

  return (
    <PageShell
      embedded={embedded}
      eyebrow="Work"
      title="Queue"
      lede={list.isPending ? 'Loading the queue.' : total ? `${formatNumber(total)} ${total === 1 ? 'item' : 'items'} in this view. ${heldByMe ? `You hold ${formatNumber(heldByMe)}.` : 'You hold none of them.'}` : 'Nothing in this view.'}
      actions={<>
        <Button onClick={() => setImporting(true)}><Upload className="h-4 w-4" />Import a spreadsheet</Button>
        <Button onClick={refresh} aria-label="Refresh the queue"><RefreshCw className={cn('h-4 w-4', list.isFetching && 'animate-spin')} />Refresh</Button>
      </>}
    >

      <div className="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Whose work">
        {([
          ['open', 'All open work', { active: true, claimed: '', state: '', overdue: false }],
          ['nobody', 'Open to claim', { active: true, claimed: 'nobody', state: '', overdue: false }],
          ['me', 'Mine', { active: true, claimed: 'me', state: '', overdue: false }],
          ['overdue', 'Overdue', { active: true, claimed: '', state: '', overdue: true }],
          ['resolved', 'Resolved', { active: false, claimed: '', state: 'resolved', overdue: false }],
        ] as const).map(([key, label, patch]) => {
          const on = query.active === patch.active && query.claimed === patch.claimed && query.state === patch.state && query.overdue === patch.overdue;
          return <Button key={key} size="sm" variant={on ? 'primary' : 'default'} aria-pressed={on} onClick={() => setQuery((q) => ({ ...q, ...patch, offset: 0 }))}>{label}</Button>;
        })}
      </div>

      <div className="card mb-3 flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input aria-label="Search the queue" className="pl-8" placeholder="Identifier, title or reference" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button variant={showFilters ? 'primary' : 'default'} onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}><Filter className="h-4 w-4" />Filter</Button>
        {views.data && views.data.length > 0 && (
          <Select
            aria-label="Saved views" className="w-44" value={activeView?.id ?? ''} placeholder="Saved views"
            onValueChange={(id) => { const v = views.data.find((x: any) => x.id === id); if (v) { applyView(v.config); setActiveViewId(v.id); } }}
            options={views.data.map((v: any) => ({ value: v.id, label: v.shared ? `${v.name} (shared)` : v.name }))}
          />
        )}
        {activeView && activeView.user_id === identity?.user.id && (
          <Button variant="ghost" size="sm" aria-label={`Delete the saved view “${activeView.name}”`} onClick={() => setDeletingView(true)}><Trash2 className="h-4 w-4" /></Button>
        )}
        <Button onClick={() => setSaveViewOpen(true)}><Bookmark className="h-4 w-4" />Save this view</Button>
      </div>

      {showFilters && (
        <div className="card mb-3 flex flex-wrap items-center gap-2 p-3">
          <Select aria-label="State" className="w-40" value={query.state} onValueChange={(v) => setQuery((q) => ({ ...q, state: v, offset: 0 }))} options={STATES} />
          <Select
            aria-label="Who is holding it" className="w-44" value={query.claimed}
            onValueChange={(v) => setQuery((q) => ({ ...q, claimed: v, offset: 0 }))}
            options={[{ value: '', label: 'Anyone or nobody' }, { value: 'me', label: 'Held by me' }, { value: 'nobody', label: 'Nobody has it' }, { value: 'anyone', label: 'Someone has it' }]}
          />
          <Select aria-label="Procedure" className="w-40" value={query.procedure} onValueChange={(v) => setQuery((q) => ({ ...q, procedure: v, offset: 0 }))} options={PROCEDURE_FILTER} />
          {identity && identity.memberships.length > 0 && (
            <Select
              aria-label="Unit" className="w-44" value={query.unit_id}
              onValueChange={(v) => setQuery((q) => ({ ...q, unit_id: v, offset: 0 }))}
              options={[{ value: '', label: 'Every unit I am in' }, ...identity.memberships.map((m) => ({ value: m.unit_id, label: m.unit_short || m.unit_name }))]}
            />
          )}
          <Button variant="ghost" onClick={() => { setQuery(DEFAULT_QUERY); setSearch(''); setActiveViewId(null); }}>Clear</Button>
        </div>
      )}

      {selected.size > 0 && (
        <div className="card mb-3 flex flex-wrap items-center gap-2 p-3" role="region" aria-label="Selected rows">
          <span className="text-sm font-medium text-ink">{selected.size} selected</span>
          <Button onClick={copySelection}><ClipboardCopy className="h-4 w-4" />Copy</Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}><X className="h-4 w-4" />Clear</Button>
        </div>
      )}

      {list.isPending ? (
        <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-11" />)}</div>
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Inbox}
            title={query.q || query.state || query.claimed || query.procedure ? 'Nothing matches this view' : 'No work has been brought in yet'}
            description={query.q || query.state || query.claimed || query.procedure ? 'Clear the filters, or widen them.' : 'Import the spreadsheet your team works from. Vantage keeps the original and reads it again on every reimport.'}
            action={query.q || query.state || query.claimed || query.procedure
              ? <Button onClick={() => { setQuery(DEFAULT_QUERY); setSearch(''); }}>Clear the filters</Button>
              : <Button variant="primary" onClick={() => setImporting(true)}><Upload className="h-4 w-4" />Import a spreadsheet</Button>}
          />
        </div>
      ) : (
        <>
          {/* Phone: cards. A data grid at this width is a grid nobody can read. */}
          {!wide && (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.id}>
                <button type="button" onClick={() => openItem(row.id)} className="w-full rounded-lg border border-line bg-surface p-3 text-left transition-colors hover:border-line-strong">
                  <span className="flex items-center justify-between gap-2">
                    <span className="fig text-xs font-semibold text-ink-2">{row.reference || row.natural_key}</span>
                    <StageBadge stage={row.stage || row.state} waiting={row.waiting_category} />
                  </span>
                  <span className="mt-1 block text-sm text-ink">{row.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                    {row.due_date && <span className={cn(isOverdue(row) && 'font-medium text-bad')}><DueText value={row.due_date} done={isClosedRow(row)} /></span>}
                    {row.amount != null && <span className="fig">{formatDollarsExact(row.amount)}{row.amount_type ? ` ${row.amount_type}` : ''}</span>}
                    {row.claimed_by && <span>{row.claimed_by === identity?.user.id ? 'You have this' : `${[row.holder_rank, row.holder_name].filter(Boolean).join(' ')} has this`}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          )}

          {/* Desktop: a windowed grid. */}
          {wide && (
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <table className="w-full table-fixed border-collapse text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2">
                <tr>
                  <th scope="col" className="w-10 px-3 py-2" />
                  {COLUMNS.map((c) => (
                    <th key={c.key} scope="col" className={cn('px-3 py-2 text-left text-xs font-semibold text-ink-2', c.width)}>
                      {c.key === 'claimed' ? c.label : (
                        <button type="button" onClick={() => sortBy(c.key)} className="inline-flex items-center gap-1 hover:text-ink" aria-label={`Sort by ${c.label}`}>
                          {c.label}
                          {query.sort === c.key && (query.direction === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                        </button>
                      )}
                    </th>
                  ))}
                  <th scope="col" className="w-20 px-3 py-2"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
            </table>
            <div ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="max-h-[60vh] overflow-y-auto" tabIndex={0} aria-label="Work queue rows">
              <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
                <table className="w-full table-fixed border-collapse text-sm" style={{ position: 'absolute', top: first * ROW_HEIGHT, left: 0 }}>
                  <tbody>
                    {windowed.map((row, i) => {
                      const index = first + i;
                      const isCursor = index === cursor;
                      const isSelected = selected.has(row.id);
                      const mine = row.claimed_by === identity?.user.id;
                      return (
                        <tr
                          key={row.id}
                          style={{ height: ROW_HEIGHT }}
                          onClick={() => { setCursor(index); openItem(row.id); }}
                          className={cn('cursor-pointer border-b border-line transition-colors', isSelected && 'bg-accent/5', isCursor && 'outline outline-2 -outline-offset-2 outline-accent', !isSelected && 'hover:bg-surface-2')}
                        >
                          <td className="w-10 px-3" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={isSelected} onChange={() => toggleSelected(row.id)} aria-label={`Select ${row.reference || row.natural_key}`} />
                          </td>
                          <td className="fig w-36 truncate px-3 text-xs font-semibold text-ink-2">{row.reference || row.natural_key}</td>
                          <td className="px-3 text-ink" title={row.title}>
                            {/* Two lines, not one: rows of the same report differ at the end of the title, which a single line cut off. */}
                            <span className="line-clamp-2 text-[13px] leading-snug">
                              {row.procedure_key && PROCEDURES[row.procedure_key] && <Badge tone="accent" className="mr-2">{PROCEDURES[row.procedure_key].short}</Badge>}
                              {row.title}
                              {row.source_changed_at && <Badge tone="warn" className="ml-2">Source changed</Badge>}
                            </span>
                          </td>
                          <td className="w-40 truncate px-3"><StageBadge stage={row.stage || row.state} waiting={row.waiting_category} /></td>
                          <td className={cn('w-28 px-3 text-xs', isOverdue(row) ? 'font-medium text-bad' : 'text-ink-3')}>
                            <DateText value={row.due_date} fallback="—" />{(() => { const near = dueIn(row.due_date, isClosedRow(row)); return near ? <span className={cn('block whitespace-nowrap text-2xs', near.days >= 0 && near.days <= 1 && 'font-medium text-warn')}>{near.words}</span> : null; })()}
                          </td>
                          <td className="fig w-28 px-3 text-right text-xs">{row.amount == null ? '' : formatDollarsExact(row.amount)}</td>
                          <td className="w-32 truncate px-3 text-xs text-ink-3">{row.claimed_by ? (mine ? 'You' : [row.holder_rank, row.holder_name].filter(Boolean).join(' ') || 'Someone else') : '—'}</td>
                          <td className="w-20 px-3 text-right" onClick={(e) => e.stopPropagation()}>
                            {row.claimed_by
                              ? (mine ? <Button size="sm" variant="ghost" onClick={() => release(row)}>Release</Button> : null)
                              : ['resolved', 'not_applicable'].includes(row.state) ? null
                              : <Button size="sm" variant="ghost" onClick={() => claim(row)}><Hand className="h-3.5 w-3.5" />Claim</Button>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-ink-3">
              <span>
                Showing {rows.length ? query.offset + 1 : 0} to {query.offset + rows.length} of {formatNumber(total)}.
                <span className="ml-2 hidden xl:inline">j and k move, space selects, Enter opens, c claims.</span>
              </span>
              <span className="flex items-center gap-2">
                <Button size="sm" variant="ghost" disabled={query.offset === 0} onClick={() => setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - q.limit) }))}>Previous</Button>
                <Button size="sm" variant="ghost" disabled={query.offset + rows.length >= total} onClick={() => setQuery((q) => ({ ...q, offset: q.offset + q.limit }))}>Next</Button>
              </span>
            </div>
          </div>
          )}
        </>
      )}

      {importing && <ImportWizard onClose={() => setImporting(false)} onImported={() => { setImporting(false); refresh(); }} />}

      <ConfirmDialog
        open={deletingView} onOpenChange={setDeletingView}
        title="Delete this saved view?" body={activeView ? `“${activeView.name}” goes from your saved views${activeView.shared ? ' and from everyone it was shared with' : ''}. The work in it is not touched.` : ''}
        onConfirm={deleteActiveView}
      />

      <Dialog
        open={saveViewOpen} onOpenChange={setSaveViewOpen} title="Save this view" size="sm"
        description="Filters, sort and search are stored under a name you can come back to."
        footer={<><Button variant="ghost" onClick={() => setSaveViewOpen(false)}>Cancel</Button><Button variant="primary" disabled={!viewName.trim()} onClick={saveCurrentView}>Save view</Button></>}
      >
        <Field label="Name"><Input autoFocus value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Overdue and unclaimed" /></Field>
      </Dialog>
    </PageShell>
  );
}

export function ThreadsForItem({ itemId }: { itemId: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const linked = useItemThreads(itemId);
  const all = useThreads({});
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const linkedIds = new Set((linked.data || []).map((t) => t.id));
  const candidates = (all.data || []).filter((t) => !linkedIds.has(t.id));

  const link = async (threadId: string) => {
    setBusy(true);
    try {
      await api.linkThreadWork(threadId, [itemId]);
      invalidateCorrespondence(qc, threadId);
      setPicking(false);
      toast.success('Linked.');
    } catch (err) { toast.error(api.errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-md font-semibold text-ink">Correspondence</h3>
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => setPicking((v) => !v)}><Mail className="h-3.5 w-3.5" />{picking ? 'Cancel' : 'Link a thread'}</Button>
      </div>
      {picking && (
        candidates.length ? (
          <ul className="mb-2 space-y-1">
            {candidates.slice(0, 12).map((t) => (
              <li key={t.id}>
                <button type="button" disabled={busy} onClick={() => link(t.id)} className="w-full truncate rounded-md border border-line px-3 py-1.5 text-left text-sm text-ink-2 hover:border-line-strong hover:bg-surface-2">{t.subject}</button>
              </li>
            ))}
          </ul>
        ) : <p className="mb-2 text-sm text-ink-3">No other threads to link. Start one under Correspondence.</p>
      )}
      {linked.data?.length ? (
        <ul className="space-y-1 text-sm">
          {linked.data.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
              <span className="min-w-0 truncate text-ink">{t.subject}</span>
              <span className="shrink-0 text-xs text-ink-3">{t.state.replace(/_/g, ' ')}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-ink-3">No email is linked to this row yet.</p>}
    </div>
  );
}
