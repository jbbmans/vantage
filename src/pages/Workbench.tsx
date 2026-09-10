import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown, ArrowUp, Bookmark, Check, ClipboardCopy, Filter, Hand, Inbox,
  RefreshCw, Search, Upload, X,
} from 'lucide-react';
import { PageHeader, Button, Input, Select, Badge, EmptyState, Skeleton, Field, Textarea, NumberInput } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText } from '@/components/common';
import ImportWizard from '@/components/ImportWizard';
import { useIdentity, useMetrics } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatDollars, formatNumber } from '../../shared/metrics';
import { cn, todayIso, useMediaQuery } from '@/lib/utils';

/**
 * The workbench: the rows of work a team is holding, arranged so a person can move through them
 * without lifting their hands off the keyboard.
 *
 * Rows are windowed rather than all rendered, so a queue of ten thousand stays responsive. Sorting,
 * filtering and paging happen on the server, because a total over one page is not a total.
 * On a phone this is a list of cards: a data grid on a 390px screen is a grid nobody can read.
 */

const STATES = [
  { value: '', label: 'Any state' },
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'not_applicable', label: 'Not applicable' },
];

const STATE_LABEL: Record<string, string> = Object.fromEntries(STATES.filter((s) => s.value).map((s) => [s.value, s.label]));
const STATE_TONE: Record<string, 'neutral' | 'accent' | 'warn' | 'good'> = {
  open: 'neutral', in_progress: 'accent', waiting: 'warn', resolved: 'good', not_applicable: 'neutral',
};

const COLUMNS = [
  { key: 'natural_key', label: 'Identifier', width: 'w-40' },
  { key: 'title', label: 'What it is', width: '' },
  { key: 'state', label: 'State', width: 'w-32' },
  { key: 'due_date', label: 'Due', width: 'w-28' },
  { key: 'amount', label: 'Value', width: 'w-32' },
  { key: 'claimed', label: 'Held by', width: 'w-32' },
];

const ROW_HEIGHT = 44;
const WINDOW_OVERSCAN = 8;

interface Query {
  state: string; claimed: string; q: string; sort: string; direction: 'asc' | 'desc'; unit_id: string; limit: number; offset: number;
}

const DEFAULT_QUERY: Query = { state: '', claimed: '', q: '', sort: 'due_date', direction: 'asc', unit_id: '', limit: 200, offset: 0 };

export default function Workbench() {
  const toast = useToast();
  const qc = useQueryClient();
  const cfg = useMetrics();
  const { data: identity } = useIdentity();
  const [query, setQuery] = useState<Query>(DEFAULT_QUERY);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  // One layout or the other, never both in the DOM at once.
  const wide = useMediaQuery('(min-width: 1024px)');

  // The search box is debounced so a queue this size is not re-queried on every keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery((q) => (q.q === search ? q : { ...q, q: search, offset: 0 })), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  const params = useMemo(() => ({
    state: query.state || undefined, claimed: query.claimed || undefined, q: query.q || undefined,
    unit_id: query.unit_id || undefined, sort: query.sort, direction: query.direction,
    limit: query.limit, offset: query.offset,
  }), [query]);

  const list = useQuery({ queryKey: ['work-items', params], queryFn: () => api.listWorkItems(params), staleTime: 10_000 });
  const views = useQuery({ queryKey: ['work-views'], queryFn: api.listWorkViews, staleTime: 60_000 });
  const rows: any[] = useMemo(() => list.data?.items || [], [list.data]);
  const total: number = list.data?.total ?? 0;

  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['work-items'] });
    qc.invalidateQueries({ queryKey: ['metrics'] });
  }, [qc]);

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
    // Tab separated, so it pastes straight back into the spreadsheet it came from.
    const header = ['Identifier', 'What it is', 'State', 'Due', 'Value', 'Type'].join('\t');
    const body = chosen.map((r) => [r.natural_key, r.title, STATE_LABEL[r.state] || r.state, r.due_date || '', r.amount ?? '', r.amount_type || ''].join('\t')).join('\n');
    try {
      await navigator.clipboard.writeText(`${header}\n${body}`);
      toast.success(`${chosen.length} ${chosen.length === 1 ? 'row' : 'rows'} copied.`);
    } catch { toast.error('The browser would not let Vantage write to the clipboard.'); }
  }, [selected, rows, cursor, toast]);

  const claim = useCallback(async (row: any) => {
    try { await api.claimWorkItem(row.id, row.version); toast.success(`You picked up ${row.natural_key}.`); refresh(); }
    catch (e) { toast.error(api.errorText(e)); refresh(); }
  }, [toast, refresh]);

  const release = useCallback(async (row: any) => {
    try { await api.releaseWorkItem(row.id, row.version); toast.success(`${row.natural_key} is back in the queue.`); refresh(); }
    catch (e) { toast.error(api.errorText(e)); refresh(); }
  }, [toast, refresh]);

  // Keyboard: j/k or arrows move, space selects, Enter opens, c claims, / focuses search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || target?.isContentEditable;
      if (detailId || importing || saveViewOpen) return;
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
      else if (event.key === 'Enter') { event.preventDefault(); if (rows[cursor]) setDetailId(rows[cursor].id); }
      else if (event.key === 'c') { event.preventDefault(); if (rows[cursor]) void claim(rows[cursor]); }
      else if (event.key === 'Escape') setSelected(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, cursor, selected, detailId, importing, saveViewOpen, toggleSelected, copySelection, claim]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - WINDOW_OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + WINDOW_OVERSCAN * 2;
  const windowed = rows.slice(first, first + visibleCount);

  const applyView = (config: Record<string, unknown>) => setQuery({ ...DEFAULT_QUERY, ...config } as Query);

  const saveCurrentView = async () => {
    try {
      await api.saveWorkView({ name: viewName, config: { state: query.state, claimed: query.claimed, q: query.q, sort: query.sort, direction: query.direction, unit_id: query.unit_id } });
      toast.success('View saved.');
      setSaveViewOpen(false); setViewName('');
      qc.invalidateQueries({ queryKey: ['work-views'] });
    } catch (e) { toast.error(api.errorText(e)); }
  };

  const heldByMe = rows.filter((r) => r.claimed_by === identity?.user.id).length;

  return (
    <div className="page">
      <PageHeader
        eyebrow="Workbench"
        title="The queue."
        lede={list.isPending ? 'Loading the queue.' : `${formatNumber(total)} ${total === 1 ? 'row' : 'rows'} match this view. You are holding ${heldByMe}.`}
      >
        <Button onClick={() => setImporting(true)}><Upload className="h-4 w-4" />Import a spreadsheet</Button>
        <Button onClick={refresh} aria-label="Refresh the queue"><RefreshCw className={cn('h-4 w-4', list.isFetching && 'animate-spin')} />Refresh</Button>
      </PageHeader>

      <div className="card mb-3 flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[12rem] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
          <Input aria-label="Search the queue" className="pl-8" placeholder="Identifier, title or reference" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <Button variant={showFilters ? 'primary' : 'default'} onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}><Filter className="h-4 w-4" />Filter</Button>
        {views.data && views.data.length > 0 && (
          <Select
            aria-label="Saved views" className="w-44" value=""
            onValueChange={(id) => { const v = views.data.find((x: any) => x.id === id); if (v) applyView(v.config); }}
            options={[{ value: '', label: 'Saved views' }, ...views.data.map((v: any) => ({ value: v.id, label: v.shared ? `${v.name} (shared)` : v.name }))]}
          />
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
          {identity && identity.memberships.length > 0 && (
            <Select
              aria-label="Unit" className="w-44" value={query.unit_id}
              onValueChange={(v) => setQuery((q) => ({ ...q, unit_id: v, offset: 0 }))}
              options={[{ value: '', label: 'Every unit I am in' }, ...identity.memberships.map((m) => ({ value: m.unit_id, label: m.unit_short || m.unit_name }))]}
            />
          )}
          <Button variant="ghost" onClick={() => { setQuery(DEFAULT_QUERY); setSearch(''); }}>Clear</Button>
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
            title={query.q || query.state || query.claimed ? 'Nothing matches this view' : 'No work has been brought in yet'}
            description={query.q || query.state || query.claimed ? 'Clear the filters, or widen them.' : 'Import the spreadsheet your team works from. Vantage keeps the original and reads it again on every reimport.'}
            action={query.q || query.state || query.claimed
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
                <button type="button" onClick={() => setDetailId(row.id)} className="w-full rounded-lg border border-line bg-surface p-3 text-left transition-colors hover:border-line-strong">
                  <span className="flex items-center justify-between gap-2">
                    <span className="fig text-xs font-semibold text-ink-2">{row.natural_key}</span>
                    <Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state] || row.state}</Badge>
                  </span>
                  <span className="mt-1 block text-sm text-ink">{row.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
                    {row.due_date && <span>Due <DateText value={row.due_date} /></span>}
                    {row.amount != null && <span className="fig">{formatDollars(row.amount)}{row.amount_type ? ` ${row.amount_type}` : ''}</span>}
                    {row.claimed_by && <span>{row.claimed_by === identity?.user.id ? 'You have this' : 'Someone has this'}</span>}
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
                  <th scope="col" className="w-24 px-3 py-2" />
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
                          onClick={() => { setCursor(index); setDetailId(row.id); }}
                          className={cn('cursor-pointer border-b border-line transition-colors', isSelected && 'bg-accent/5', isCursor && 'outline outline-2 -outline-offset-2 outline-accent', !isSelected && 'hover:bg-surface-2')}
                        >
                          <td className="w-10 px-3" onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={isSelected} onChange={() => toggleSelected(row.id)} aria-label={`Select ${row.natural_key}`} />
                          </td>
                          <td className="fig w-40 truncate px-3 text-xs font-semibold text-ink-2">{row.natural_key}</td>
                          <td className="truncate px-3 text-ink">
                            {row.title}
                            {row.source_changed_at && <Badge tone="warn" className="ml-2">Source changed</Badge>}
                          </td>
                          <td className="w-32 px-3"><Badge tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state] || row.state}</Badge></td>
                          <td className="w-28 px-3 text-xs text-ink-3"><DateText value={row.due_date} fallback="—" /></td>
                          <td className="fig w-32 px-3 text-right text-xs">{row.amount == null ? '' : formatDollars(row.amount)}</td>
                          <td className="w-32 truncate px-3 text-xs text-ink-3">{row.claimed_by ? (mine ? 'You' : 'Someone else') : '—'}</td>
                          <td className="w-24 px-3 text-right" onClick={(e) => e.stopPropagation()}>
                            {row.claimed_by
                              ? (mine ? <Button size="sm" variant="ghost" onClick={() => release(row)}>Release</Button> : null)
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
      {detailId && <WorkItemDetail id={detailId} onClose={() => setDetailId(null)} onChanged={refresh} currencyLabel={cfg.currency_label} />}

      <Dialog
        open={saveViewOpen} onOpenChange={setSaveViewOpen} title="Save this view" size="sm"
        description="Filters, sort and search are stored under a name you can come back to."
        footer={<><Button variant="ghost" onClick={() => setSaveViewOpen(false)}>Cancel</Button><Button variant="primary" disabled={!viewName.trim()} onClick={saveCurrentView}>Save view</Button></>}
      >
        <Field label="Name"><Input autoFocus value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="Overdue and unclaimed" /></Field>
      </Dialog>
    </div>
  );
}

function WorkItemDetail({ id, onClose, onChanged, currencyLabel }: { id: string; onClose: () => void; onChanged: () => void; currencyLabel: string }) {
  const toast = useToast();
  const cfg = useMetrics();
  const { data: identity } = useIdentity();
  const detail = useQuery({ queryKey: ['work-item', id], queryFn: () => api.workItem(id) });
  const [note, setNote] = useState('');
  const [kind, setKind] = useState('worked');
  const [quantity, setQuantity] = useState('');
  const [unitLabel, setUnitLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [amountType, setAmountType] = useState('');
  const [draftRecord, setDraftRecord] = useState(true);
  const [resolve, setResolve] = useState(false);
  const [busy, setBusy] = useState(false);
  // One key per open dialog, so a double submit or a retry records the action once.
  const [actionKey] = useState(() => `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

  const item = detail.data?.item;
  const mine = item?.claimed_by === identity?.user.id;

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.recordWorkAction(id, {
        kind, note: note || null,
        occurred_at: todayIso(),
        quantity: quantity === '' ? null : Number(quantity),
        unit_label: unitLabel || null,
        dollar_amount: amount === '' ? null : Number(amount),
        dollar_type: amount === '' ? null : amountType || null,
        draft_record: draftRecord, resolve,
      }, actionKey);
      toast.success(res.activity_id ? 'Recorded, and added to your own record.' : 'Recorded.');
      onChanged();
      onClose();
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  const acknowledge = async () => {
    try { await api.patchWorkItem(id, { acknowledge_source_change: true, version: item.version }); toast.success('Noted.'); detail.refetch(); onChanged(); }
    catch (e) { toast.error(api.errorText(e)); }
  };

  return (
    <Dialog
      open onOpenChange={(o) => { if (!o) onClose(); }}
      title={item ? item.natural_key : 'Work item'}
      description={item ? item.title : undefined}
      size="lg"
      footer={item && mine ? (
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" loading={busy} onClick={submit}><Check className="h-4 w-4" />Record what you did</Button>
        </>
      ) : <Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {detail.isPending ? <Skeleton className="h-40" /> : !item ? <EmptyState title="This work item is gone" /> : (
        <div className="space-y-4">
          {item.source_changed_at && (
            <div className="rounded-md border border-warn/40 bg-warn/5 p-3 text-sm">
              <p className="text-ink">The source spreadsheet changed after you picked this up. Check the values before you record anything.</p>
              <Button size="sm" className="mt-2" onClick={acknowledge}>I have checked it</Button>
            </div>
          )}

          <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[
              ['State', STATE_LABEL[item.state] || item.state],
              ['Due', item.due_date || 'No date'],
              [currencyLabel, item.amount == null ? '—' : `${formatDollars(item.amount)}${item.amount_type ? ` ${item.amount_type}` : ''}`],
              ['Held by', item.claimed_by ? (mine ? 'You' : 'Someone else') : 'Nobody'],
            ].map(([k, v]) => (
              <div key={String(k)} className="rounded-md border border-line px-3 py-2">
                <dt className="eyebrow">{k}</dt>
                <dd className="mt-0.5 font-medium text-ink">{String(v)}</dd>
              </div>
            ))}
          </dl>

          {detail.data.source && (
            <p className="text-xs text-ink-3">
              From <span className="font-medium text-ink-2">{detail.data.source.filename}</span>, row {item.source_row}. The original file is kept unchanged.
            </p>
          )}

          {Object.keys(item.data || {}).length > 0 && (
            <details className="rounded-md border border-line">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">Everything the source said</summary>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 px-3 pb-3 sm:grid-cols-2">
                {Object.entries(item.data as Record<string, string>).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-line py-1 text-xs">
                    <dt className="text-ink-3">{k}</dt>
                    <dd className="truncate text-right text-ink">{v || '—'}</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}

          {!mine && (
            <p className="rounded-md border border-line bg-surface-2 px-3 py-2 text-sm text-ink-2">
              {item.claimed_by ? 'Someone else is holding this. Ask them before you work it.' : 'Pick this up before recording what you did, so nobody duplicates your work.'}
            </p>
          )}

          {mine && (
            <div className="space-y-3 rounded-md border border-line p-3">
              <h3 className="text-sm font-semibold text-ink">What did you do?</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Kind">
                  <Select
                    value={kind} onValueChange={setKind}
                    options={['worked', 'contacted', 'escalated', 'corrected', 'reconciled', 'validated', 'resolved', 'noted'].map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))}
                  />
                </Field>
                <Field label="How many" hint="Leave blank if this action did not move a countable amount.">
                  <NumberInput value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="30" />
                </Field>
                <Field label="Of what"><Input value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} placeholder={item.unit_label || 'ULOs'} list="workbench-units" /></Field>
                <datalist id="workbench-units">{cfg.unit_suggestions.map((u) => <option key={u} value={u} />)}</datalist>
                <Field label={`${currencyLabel} moved`}><NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1118.38" /></Field>
                <Field label="Which kind of value" hint="An amount with no type cannot be counted toward anything.">
                  <Select
                    value={amountType} onValueChange={setAmountType} disabled={amount === ''}
                    options={[{ value: '', label: 'Choose a type' }, ...cfg.value_types.map((t) => ({ value: t.key, label: t.summable ? t.label : `${t.label} (tracked separately)` }))]}
                  />
                </Field>
              </div>
              <Field label="What happened">
                <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Confirmed the supporting document with the vendor and released the balance." />
              </Field>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={draftRecord} onChange={(e) => setDraftRecord(e.target.checked)} />
                  Also add this to my own record
                </label>
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} />
                  This closes it out
                </label>
              </div>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink">Who moved this</h3>
            {detail.data.contributors.length === 0 ? (
              <p className="text-sm text-ink-3">Nobody has recorded anything against this yet.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {detail.data.contributors.map((c: any) => (
                  <li key={c.user_id} className="flex items-center justify-between gap-3 border-b border-line py-1">
                    <span className="text-ink">{[c.rank_abbr, c.first_name, c.last_name].filter(Boolean).join(' ')}</span>
                    <span className="text-xs text-ink-3">{c.actions} {c.actions === 1 ? 'action' : 'actions'}, last <DateText value={c.last_at} /></span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {detail.data.actions.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-ink">History</h3>
              <ul className="space-y-2">
                {detail.data.actions.map((a: any) => (
                  <li key={a.id} className="rounded-md border border-line px-3 py-2 text-sm">
                    <span className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">{a.kind[0].toUpperCase() + a.kind.slice(1)} by {[a.rank_abbr, a.first_name, a.last_name].filter(Boolean).join(' ')}</span>
                      <span className="text-xs text-ink-3"><DateText value={a.occurred_at} /></span>
                    </span>
                    {a.note && <span className="mt-1 block text-ink-2">{a.note}</span>}
                    {(a.quantity != null || a.dollar_amount != null) && (
                      <span className="fig mt-1 block text-xs text-ink-3">
                        {a.quantity != null ? `${formatNumber(a.quantity)} ${a.unit_label || ''}` : ''}
                        {a.dollar_amount != null ? ` ${formatDollars(a.dollar_amount)} ${a.dollar_type || ''}` : ''}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
