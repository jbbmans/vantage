import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Bookmark, ClipboardCopy, Filter, Hand, Inbox, Mail,
  RefreshCw, Search, Trash2, Upload, X,
} from 'lucide-react';
import { Button, Input, Select, Badge, EmptyState, Skeleton, Field } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText, DueText, PageShell, dueIn } from '@/components/common';
import { QueryFailure } from '@/components/QueryFailure';
import { StageBadge } from '@/components/work';
import ImportWizard from '@/components/ImportWizard';
import BulkWorkDialog, { type SelectedWork } from '@/components/BulkWorkDialog';
import { BULK_WORK_LIMIT } from '../../shared/bulkWork';
import { can, useBackgroundRefresh, useIdentity, useItemThreads, usePrefs, useThreads, invalidateCorrespondence, invalidateWork } from '@/lib/queries';
import { PERMISSIONS } from '../../shared/permissions';
import * as api from '@/lib/api';
import { formatDollarsExact, formatNumber } from '../../shared/metrics';
import { cn, isoDay, todayIso, useMediaQuery } from '@/lib/utils';
import { track } from '@/lib/telemetry';
import { isTextEntry, shortcutsOn } from '@/lib/keyboard';
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
  { key: 'stage', label: 'Stage', width: 'w-40' },
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

function savedQuery(config: Record<string, unknown>): Query {
  const query = { ...DEFAULT_QUERY, ...config } as Query;
  if (query.sort === 'state') query.sort = 'stage';
  return query;
}

/** The day before today on the viewer's calendar: due on or before it, and still open, is overdue. */
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return isoDay(d); };
const isClosedRow = (row: { state?: string }) => ['resolved', 'not_applicable'].includes(String(row.state));
/** Where the cursor is now: on its case if that case is still listed, otherwise at the same place in the list. */
const cursorIndex = (at: { id: string | null; index: number }, rows: Array<{ id: string }>) => {
  const found = at.id ? rows.findIndex((row) => row.id === at.id) : -1;
  return found >= 0 ? found : Math.max(0, Math.min(at.index, rows.length - 1));
};
const isOverdue = (row: { due_date?: string | null; state?: string }) => Boolean(row.due_date && row.due_date < todayIso() && !isClosedRow(row));
/** What a row's checkbox selects, by the case's reference and title: a case with no reference is not named by its key. */
const selectLabel = (row: { reference?: string | null; title?: string | null }) => `Select ${[row.reference, row.title].filter(Boolean).join(', ')}`;
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState<Query>(() => ({
    ...DEFAULT_QUERY,
    claimed: ['me', 'nobody', 'anyone'].includes(searchParams.get('claimed') || '') ? String(searchParams.get('claimed')) : '',
    procedure: PROCEDURE_FILTER.some((o) => o.value && o.value === searchParams.get('procedure')) ? String(searchParams.get('procedure')) : '',
    overdue: searchParams.get('overdue') === '1',
  }));
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The keyboard cursor follows a case, not a row number, so a refresh that reorders or drops rows never leaves it on
  // somebody else's case. When its case leaves the list, it stays at the same place in the list.
  const [cursorAt, setCursorAt] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  const openItem = useCallback((id: string) => navigate(`/work/items/${id}`), [navigate]);
  // ?import=1 (⌘K's "Import work") opens the import, on arrival or while already here, and Back, which takes the mark
  // away, closes it. Closing it takes only that mark off the address, so the queue's own filters stay; when ⌘K added the
  // mark here, closing goes back instead, so the queue is not left twice in the history and Back leaves it.
  const location = useLocation();
  const [importing, setImportingState] = useState(() => searchParams.get('import') === '1');
  const askedToImport = searchParams.get('import') === '1';
  useEffect(() => { setImportingState(askedToImport); }, [askedToImport]);
  const bare = (path: string) => path.replace(/(.)\/+$/, '$1');
  const importFrom = (location.state as { importFrom?: string } | null)?.importFrom;
  const markedHere = askedToImport && importFrom !== undefined && bare(importFrom) === bare(location.pathname);
  const setImporting = useCallback((open: boolean) => {
    setImportingState(open);
    if (open) return;
    if (markedHere) navigate(-1);
    else setSearchParams((p) => { if (!p.has('import')) return p; const n = new URLSearchParams(p); n.delete('import'); return n; }, { replace: true });
  }, [markedHere, navigate, setSearchParams]);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkItems, setBulkItems] = useState<SelectedWork[]>([]);
  const [savingView, setSavingView] = useState(false);
  const [shareViewUnit, setShareViewUnit] = useState('');
  const [viewName, setViewName] = useState('');
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [deletingView, setDeletingView] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLTableSectionElement>(null);
  const prevPage = useRef<HTMLButtonElement>(null);
  const nextPage = useRef<HTMLButtonElement>(null);
  const [paging, setPaging] = useState<'prev' | 'next' | null>(null);
  const keysOn = shortcutsOn(usePrefs());
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

  // The rows on screen stay while a new sort or page loads, so the header or pager button pressed keeps focus.
  const list = useQuery({ queryKey: ['work-items', params], queryFn: ({ signal }) => api.listWorkItems(params, { signal }), staleTime: 10_000, placeholderData: keepPreviousData });
  useBackgroundRefresh(['work-items', params], (signal) => api.listWorkItems(params, { signal, background: true }));
  const views = useQuery({ queryKey: ['work-views'], queryFn: api.listWorkViews, staleTime: 60_000 });
  const rows: any[] = useMemo(() => list.isError ? [] : list.data?.items || [], [list.data, list.isError]);
  const total: number = list.data?.total ?? 0;
  const cursor = useMemo(() => cursorIndex(cursorAt, rows), [cursorAt, rows]);

  const refresh = useCallback(() => invalidateWork(qc), [qc]);

  useEffect(() => {
    setCursorAt({ id: null, index: 0 }); setSelected(new Set());
    // A new sort or page starts at its top.
    if (scroller.current) scroller.current.scrollTop = 0;
    setScrollTop(0);
  }, [query]);

  useEffect(() => {
    if (!rows.length) return;
    setCursorAt((at) => {
      const index = cursorIndex(at, rows);
      return at.id === rows[index].id && at.index === index ? at : { id: rows[index].id, index };
    });
  }, [rows]);

  useEffect(() => {
    if (bulkOpen || list.isPending) return;
    const visible = new Set(rows.map((row) => row.id));
    setSelected((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [rows, bulkOpen, list.isPending]);

  // Measured once the grid is drawn: on arrival the page shows skeletons, and the grid is not there yet.
  const gridShown = wide && rows.length > 0;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewportHeight(el.clientHeight || 600);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [gridShown]);

  // A page arrived. The pager button pressed keeps focus; if it can go no further (the first or last page), focus moves
  // to the other one rather than falling to the page.
  useEffect(() => {
    if (!paging || list.isPlaceholderData) return;
    setPaging(null);
    const [from, to] = paging === 'next' ? [nextPage.current, prevPage.current] : [prevPage.current, nextPage.current];
    if (from?.disabled && (document.activeElement === from || document.activeElement === document.body)) to?.focus();
  }, [paging, list.isPlaceholderData, rows]);

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

  // Anywhere on the page: ⌘C or Ctrl+C copies the selection and Escape clears it (neither is a single character key), and
  // Escape leaves a field. The single keys are the rows' own (onRowsKey).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      // A key a dialog already handled (Escape closing it, say) is not a queue shortcut too, and nothing in a dialog is.
      if (event.defaultPrevented || importing || saveViewOpen || bulkOpen || deletingView || target?.closest?.('[role="dialog"], [role="alertdialog"]')) return;
      if (isTextEntry(target)) {
        if (event.key === 'Escape') target.blur();
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        if (event.key.toLowerCase() === 'c' && selected.size) { event.preventDefault(); void copySelection(); }
        return;
      }
      if (event.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, importing, saveViewOpen, bulkOpen, deletingView, copySelection]);

  /** Moves focus to a row's link, once the row is drawn (only the rows in view are). */
  const focusRow = (index: number) => {
    const find = () => scroller.current?.querySelector<HTMLElement>(`tr[data-index="${index}"] a[href]`);
    const now = find();
    if (now) now.focus({ preventScroll: true });
    else window.setTimeout(() => find()?.focus({ preventScroll: true }), 60);
  };

  // The queue's single keys act only here, with focus in its rows, and only while the person has single-key shortcuts on
  // (WCAG 2.1.4): a stray key elsewhere on the page, or a word said to speech input, claims nothing.
  const onRowsKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!keysOn || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTextEntry(target)) return;
    // Enter and Space on a focused link, button or checkbox do what that control does, not what the cursor row does.
    const control = target !== event.currentTarget && Boolean(target.closest('button, a[href], input, [role="button"], [role="link"], [role="checkbox"]'));
    const inRow = Boolean(target.closest('tr[data-index]'));
    const move = (delta: number) => {
      event.preventDefault();
      if (!rows.length) return;
      const next = Math.max(0, Math.min(rows.length - 1, cursor + delta));
      const el = scroller.current;
      if (el) {
        // The header stays at the top of the scroller, over the first rows' place.
        const header = head.current?.offsetHeight ?? 0;
        const top = next * ROW_HEIGHT;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (header + top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = header + top + ROW_HEIGHT - el.clientHeight;
      }
      setCursorAt({ id: rows[next]?.id ?? null, index: next });
      // With focus on a row, focus goes with the cursor, so Enter on it opens the row the cursor is on.
      if (inRow) focusRow(next);
    };
    if (event.key === 'j' || event.key === 'ArrowDown') move(1);
    else if (event.key === 'k' || event.key === 'ArrowUp') move(-1);
    else if (event.key === ' ' && !control) { event.preventDefault(); if (rows[cursor]) toggleSelected(rows[cursor].id); }
    else if (event.key === 'Enter' && !control) { event.preventDefault(); if (rows[cursor]) openItem(rows[cursor].id); }
    else if (event.key === 'c') { event.preventDefault(); if (rows[cursor]) void claim(rows[cursor]); }
  };

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - WINDOW_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + WINDOW_OVERSCAN * 2;
  const windowed = rows.slice(first, first + visibleCount);
  const below = Math.max(0, rows.length - first - windowed.length);

  const applyView = (config: Record<string, unknown>) => {
    const next = savedQuery(config);
    setQuery(next);
    setSearch(next.q);
  };
  // A view stays selected only while the queue still shows it; once anything changes, picking it again reapplies it.
  const showing = (config: Record<string, unknown>) => {
    const v = savedQuery(config);
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
    if (savingView) return;
    setSavingView(true);
    try {
      // The search box reaches the query a beat after typing stops; the view keeps what the box says now.
      const q = search.trim();
      const saved = await api.saveWorkView({ name: viewName, shared: Boolean(shareViewUnit), unit_id: shareViewUnit || null, config: { state: query.state, active: query.active, claimed: query.claimed, q, sort: query.sort, direction: query.direction, unit_id: query.unit_id, procedure: query.procedure, overdue: query.overdue } });
      track('work.view_saved', { filters: [query.state, query.claimed, q, query.unit_id, query.procedure].filter(Boolean).length });
      toast.success('View saved.');
      setSaveViewOpen(false); setViewName(''); setShareViewUnit('');
      setActiveViewId(saved?.id ?? null);
      qc.invalidateQueries({ queryKey: ['work-views'] });
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setSavingView(false); }
  };

  const heldByMe: number | undefined = list.data?.held_by_me;
  const filtered = Boolean(query.q || query.state || query.claimed || query.procedure || query.unit_id || query.overdue);
  const ownership = heldByMe == null ? '' : heldByMe ? ` You hold ${formatNumber(heldByMe)}.` : ' You hold none of them.';

  return (
    <PageShell
      embedded={embedded}
      eyebrow="Work"
      title="Queue"
      lede={list.isPending ? 'Loading the queue.' : list.isError ? 'The latest queue is unavailable.' : total ? `${formatNumber(total)} ${total === 1 ? 'item' : 'items'} in this view.${ownership}` : 'Nothing in this view.'}
      actions={<>
        <Button onClick={() => setImporting(true)} data-tutorial="import-work"><Upload className="h-4 w-4" />Import work</Button>
        <Button onClick={refresh} aria-label="Refresh the queue"><RefreshCw className={cn('h-4 w-4', list.isFetching && 'animate-spin')} />Refresh</Button>
      </>}
    >

      {!list.isPending && <p className="mb-3 text-xs text-ink-3">The queue refreshes every 30 seconds while this page is visible. Each change checks the case version again.</p>}

      {/* One row that scrolls sideways on a phone, rather than two rows of pills before the first case. */}
      <div className="scroll-x-quiet -mx-4 mb-3 flex items-center gap-2 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0" role="group" aria-label="Whose work">
        {([
          ['open', 'All open work', { active: true, claimed: '', state: '', overdue: false }],
          ['nobody', 'Open to claim', { active: true, claimed: 'nobody', state: '', overdue: false }],
          ['me', 'Mine', { active: true, claimed: 'me', state: '', overdue: false }],
          ['overdue', 'Overdue', { active: true, claimed: '', state: '', overdue: true }],
          ['resolved', 'Resolved', { active: false, claimed: '', state: 'resolved', overdue: false }],
        ] as const).map(([key, label, patch]) => {
          const on = query.active === patch.active && query.claimed === patch.claimed && query.state === patch.state && query.overdue === patch.overdue;
          return <Button key={key} size="sm" variant={on ? 'primary' : 'default'} className="shrink-0" aria-pressed={on} onClick={() => setQuery((q) => ({ ...q, ...patch, offset: 0 }))}>{label}</Button>;
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
        <Button onClick={() => { setShareViewUnit(''); setSaveViewOpen(true); }}><Bookmark className="h-4 w-4" />Save this view</Button>
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
          <Button variant="primary" onClick={() => { setBulkItems(rows.filter((row) => selected.has(row.id)).map(({ id, version, reference, title }) => ({ id, version, reference, title }))); setBulkOpen(true); }} disabled={selected.size > BULK_WORK_LIMIT}>Update selected</Button>
          <Button onClick={copySelection}><ClipboardCopy className="h-4 w-4" />Copy</Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}><X className="h-4 w-4" />Clear</Button>
          {selected.size > BULK_WORK_LIMIT && <p className="text-xs text-ink-2">Select up to {BULK_WORK_LIMIT} cases to update together.</p>}
        </div>
      )}

      {list.isError ? (
        <QueryFailure error={list.error} what="The queue" onRetry={() => { void list.refetch(); }} />
      ) : list.isPending ? (
        <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-11" />)}</div>
      ) : rows.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={Inbox}
            title={filtered ? 'Nothing matches this view' : 'No work has been brought in yet'}
            description={filtered ? 'Clear the filters, or widen them.' : 'Import the spreadsheet your team works from. Vantage keeps the original and reads it again on every reimport.'}
            action={filtered
              ? <Button onClick={() => { setQuery(DEFAULT_QUERY); setSearch(''); }}>Clear the filters</Button>
              : <Button variant="primary" onClick={() => setImporting(true)} data-tutorial="import-work"><Upload className="h-4 w-4" />Import work</Button>}
          />
        </div>
      ) : (
        <>
          {/* Phone: cards. A data grid at this width is a grid nobody can read. */}
          {!wide && (
          <ul className="space-y-2">
            {rows.map((row) => (
              <li key={row.id} className={cn('flex rounded-lg border border-line bg-surface transition-colors hover:border-line-strong', selected.has(row.id) && 'border-accent bg-accent/5')}>
                <label className="flex min-h-11 min-w-11 cursor-pointer items-start justify-center pt-4">
                  <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleSelected(row.id)} aria-label={selectLabel(row)} />
                </label>
                <button type="button" onClick={() => openItem(row.id)} className="min-w-0 flex-1 rounded-r-lg p-3 pl-0 text-left">
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

          {/* Desktop: one table, its header held at the top while the rows scroll beneath it, so every cell is read with its
              column. Only the rows in view are drawn; a spacer row above and below stands for the rest. */}
          {wide && (
          <div className="overflow-hidden rounded-lg border border-line bg-surface">
            <div ref={scroller} role="region" aria-label="Work queue rows" tabIndex={0} aria-busy={list.isPlaceholderData || undefined}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onKeyDown={onRowsKey}
              className="max-h-[60vh] overflow-y-auto [scroll-padding-top:2.5rem]">
              <table className={cn('w-full table-fixed border-collapse text-sm transition-opacity', list.isPlaceholderData && 'opacity-60')} aria-rowcount={total + 1}>
                <caption className="sr-only">Work queue</caption>
                <thead ref={head} className="sticky top-0 z-10 bg-surface-2">
                  <tr aria-rowindex={1}>
                    <th scope="col" className="w-10 px-3 py-2"><span className="sr-only">Select work</span></th>
                    {COLUMNS.map((c) => {
                      const sorted = query.sort === c.key;
                      return (
                        <th key={c.key} scope="col" className={cn('px-3 py-2 text-left text-xs font-semibold text-ink-2', c.width)}
                          aria-sort={c.key === 'claimed' ? undefined : sorted ? (query.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                          {c.key === 'claimed' ? c.label : (
                            <button type="button" onClick={() => sortBy(c.key)} className="inline-flex items-center gap-1 hover:text-ink" aria-label={`Sort by ${c.label}`}>
                              {c.label}
                              {sorted && (query.direction === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
                            </button>
                          )}
                        </th>
                      );
                    })}
                    <th scope="col" className="w-20 px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {first > 0 && <tr aria-hidden="true" style={{ height: first * ROW_HEIGHT }}><td colSpan={COLUMNS.length + 2} className="p-0" /></tr>}
                  {windowed.map((row, i) => {
                    const index = first + i;
                    const isCursor = index === cursor;
                    const isSelected = selected.has(row.id);
                    const mine = row.claimed_by === identity?.user.id;
                    return (
                      <tr
                        key={row.id}
                        data-index={index}
                        aria-rowindex={query.offset + index + 2}
                        style={{ height: ROW_HEIGHT }}
                        // Focus on any of the row's controls puts the cursor on it, so the keys act on the row in focus.
                        onFocus={() => { if (!isCursor) setCursorAt({ id: row.id, index }); }}
                        onClick={(e) => { if ((e.target as HTMLElement).closest('a[href], button, input, label')) return; setCursorAt({ id: row.id, index }); openItem(row.id); }}
                        className={cn('cursor-pointer border-b border-line transition-colors', isSelected && 'bg-accent/5', isCursor && 'outline outline-2 -outline-offset-2 outline-accent', !isSelected && 'hover:bg-surface-2')}
                      >
                        <td className="w-10 px-3" onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" checked={isSelected} onChange={() => toggleSelected(row.id)} aria-label={selectLabel(row)} />
                        </td>
                        <td className="fig w-36 px-3 text-xs font-semibold text-ink-2">
                          {/* A link a keyboard reaches with Tab, and a screen reader lists, opens the case; the row's click is for a mouse. */}
                          <Link to={`/work/items/${row.id}`} className="block truncate rounded-sm hover:text-ink hover:underline">{row.reference || row.natural_key}</Link>
                        </td>
                        <td className="px-3 text-ink" title={row.diagnosis ? `${row.title}\n${row.diagnosis.headline}` : row.title}>
                          {/* Two lines, not one: rows of the same report differ at the end of the title, which a single line cut off. */}
                          <span className="line-clamp-2 text-[13px] leading-snug">
                            {row.procedure_key && PROCEDURES[row.procedure_key] && <Badge tone="accent" className="mr-2">{PROCEDURES[row.procedure_key].short}</Badge>}
                            {/* The case diagnoser's reading of a case no procedure is applied to yet (ADR-0022): a lead, not a label. */}
                            {!row.procedure_key && row.diagnosis?.issue && <Badge className="mr-2" title={row.diagnosis.headline}>Reads as {row.diagnosis.issue}</Badge>}
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
                            ? (mine && !isClosedRow(row) ? <Button size="sm" variant="ghost" onClick={() => release(row)}>Release</Button> : null)
                            : ['resolved', 'not_applicable'].includes(row.state) ? null
                            : <Button size="sm" variant="ghost" onClick={() => claim(row)}><Hand className="h-3.5 w-3.5" />Claim</Button>}
                        </td>
                      </tr>
                    );
                  })}
                  {below > 0 && <tr aria-hidden="true" style={{ height: below * ROW_HEIGHT }}><td colSpan={COLUMNS.length + 2} className="p-0" /></tr>}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-ink-3">
              <span>
                Showing {rows.length ? query.offset + 1 : 0} to {query.offset + rows.length} of {formatNumber(total)}.
                {keysOn && <span className="ml-2 hidden lg:inline">In the rows, j and k move, space selects, Enter opens, c claims.</span>}
              </span>
              <span className="flex items-center gap-2">
                <Button ref={prevPage} size="sm" variant="ghost" disabled={!list.isPlaceholderData && query.offset === 0} loading={list.isPlaceholderData && paging === 'prev'}
                  onClick={() => { setPaging('prev'); setQuery((q) => ({ ...q, offset: Math.max(0, q.offset - q.limit) })); }}>Previous</Button>
                <Button ref={nextPage} size="sm" variant="ghost" disabled={!list.isPlaceholderData && query.offset + rows.length >= total} loading={list.isPlaceholderData && paging === 'next'}
                  onClick={() => { setPaging('next'); setQuery((q) => ({ ...q, offset: q.offset + q.limit })); }}>Next</Button>
              </span>
            </div>
          </div>
          )}
        </>
      )}

      {importing && <ImportWizard onClose={() => setImporting(false)} onImported={() => { setImporting(false); refresh(); }} />}
      {bulkOpen && <BulkWorkDialog items={bulkItems} onClose={() => setBulkOpen(false)} onApplied={(result) => {
        setSelected(new Set(result.results.filter((row) => !row.ok).map((row) => row.id)));
        refresh();
      }} />}

      <ConfirmDialog
        open={deletingView} onOpenChange={setDeletingView}
        title="Delete this saved view?" body={activeView ? `“${activeView.name}” goes from your saved views${activeView.shared ? ' and from everyone it was shared with' : ''}. The work in it is not touched.` : ''}
        onConfirm={deleteActiveView}
      />

      <Dialog
        open={saveViewOpen} onOpenChange={(open) => { if (!savingView) setSaveViewOpen(open); }} title="Save this view" size="sm"
        description="Filters, sort and search are stored under a name you can come back to."
        footer={<><Button variant="ghost" disabled={savingView} onClick={() => setSaveViewOpen(false)}>Cancel</Button><Button variant="primary" loading={savingView} disabled={!viewName.trim()} onClick={saveCurrentView}>Save view</Button></>}
      >
        <Field label="Name"><Input autoFocus value={viewName} disabled={savingView} maxLength={80} onChange={(e) => setViewName(e.target.value)} placeholder="Overdue and unclaimed" /></Field>
        {identity && identity.memberships.length > 0 && <Field label="Share this view"><Select value={shareViewUnit} disabled={savingView} onValueChange={setShareViewUnit}
          options={[{ value: '', label: 'Only me' }, ...identity.memberships.filter((membership) => can(identity, PERMISSIONS.CREATE_SHARED_WORK, membership.unit_id)).map((membership) => ({ value: membership.unit_id, label: membership.unit_short || membership.unit_name }))]} /></Field>}
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
