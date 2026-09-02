import React, { useEffect, useMemo, useState } from 'react';
import { Bookmark, CalendarDays, ExternalLink, RefreshCw, Search, ShieldCheck, Sparkles } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import * as api from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { Dialog } from '@/components/ui/Dialog';
import { Badge, Button, EmptyState, Input, Panel, Segmented } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

function displayDate(value, long = false) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-US', long
    ? { month: 'long', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' }).format(new Date(value));
}

export default function Maradmins() {
  const toast = useToast();
  const [params] = useSearchParams();
  const [state, setState] = useState({ rows: [], sync: null });
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('all');
  const [tag, setTag] = useState('All');
  const [selected, setSelected] = useState(null);
  const [aiSummary, setAiSummary] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);

  const load = async ({ wait = false } = {}) => {
    setLoading(true);
    try {
      const result = await api.maradmins(wait);
      setState(result);
    } catch (error) {
      toast.error(api.errorText(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const requested = params.get('open');
  useEffect(() => {
    if (requested) setSelected((state.rows || []).find((row) => row.number === requested) || null);
  }, [requested, state.rows]);

  const tags = useMemo(() => {
    const counts = new Map();
    for (const row of state.rows || []) for (const item of row.tags || []) counts.set(item, (counts.get(item) || 0) + 1);
    return ['All', ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)];
  }, [state.rows]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (state.rows || []).filter((row) => {
      if (scope === 'saved' && !row.saved_at) return false;
      if (scope === 'unread' && row.read_at) return false;
      if (tag !== 'All' && !(row.tags || []).includes(tag)) return false;
      if (!needle) return true;
      return [row.number, row.title, row.summary, ...(row.tags || []), ...(row.audience || [])]
        .some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }, [state.rows, query, scope, tag]);

  const summarizeWithAi = async () => {
    if (!selected) return;
    setAiBusy(true);
    setAiSummary(null);
    try {
      const result = await api.aiAssist('maradmin_summary', { id: selected.id });
      setAiSummary(result.output);
      toast.success('GenAI.mil summary generated. Verify it against the official message.');
    } catch (error) { toast.error(api.errorText(error)); }
    finally { setAiBusy(false); }
  };

  const open = async (row) => {
    setAiSummary(null);
    setSelected(row);
    if (!row.read_at) {
      const readAt = new Date().toISOString();
      setState((current) => ({
        ...current,
        rows: current.rows.map((item) => item.id === row.id ? { ...item, read_at: readAt } : item),
      }));
      api.updateMaradminState(row.id, { read: true }).catch(() => {});
    }
  };

  const toggleSaved = async (row) => {
    const saved = !row.saved_at;
    const savedAt = saved ? new Date().toISOString() : null;
    setState((current) => ({
      ...current,
      rows: current.rows.map((item) => item.id === row.id ? { ...item, saved_at: savedAt } : item),
    }));
    if (selected?.id === row.id) setSelected((current) => ({ ...current, saved_at: savedAt }));
    try { await api.updateMaradminState(row.id, { saved, read: true }); }
    catch (error) { toast.error(api.errorText(error)); load(); }
  };

  const recent = (state.rows || []).filter((row) => Date.now() - Date.parse(row.published_at) < 7 * 86400000).length;
  const saved = (state.rows || []).filter((row) => row.saved_at).length;
  const unread = (state.rows || []).filter((row) => !row.read_at).length;

  return (
    <div className="page-canvas maradmins-page">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b border-rule pb-5">
        <div>
          <p className="eyebrow">Official message watch</p>
          <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">MARADMIN tracker</h2>
          <p className="mt-1.5 max-w-2xl text-base text-text-3">Current messages from the official Marines.mil feed, organized into quick identifiers without changing the source.</p>
        </div>
        <Button size="sm" onClick={() => load({ wait: true })} disabled={loading}>
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Refresh
        </Button>
      </div>

      <section className="grid grid-cols-3 divide-x divide-rule border-b border-rule" aria-label="MARADMIN totals">
        {[
          ['Last 7 days', recent],
          ['Unread', unread],
          ['Saved', saved],
        ].map(([label, value]) => (
          <div key={label} className="px-3 py-5 first:pl-0 sm:px-5">
            <p className="fig text-2xl font-medium text-text">{value}</p>
            <p className="mt-1 text-xs text-text-3 sm:text-sm">{label}</p>
          </div>
        ))}
      </section>

      <div className="sticky top-[68px] z-20 -mx-4 border-b border-rule bg-ink/95 px-4 py-3 backdrop-blur-lg sm:-mx-6 sm:px-6 lg:-mx-10 lg:px-10">
        <div className="page-canvas flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1 sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-3" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Number, title, topic, or audience" className="pl-9" />
          </div>
          <Segmented
            label="Message scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: 'All' },
              { value: 'unread', label: 'Unread' },
              { value: 'saved', label: 'Saved' },
            ]}
          />
        </div>
      </div>

      <div className="flex gap-2 overflow-x-auto py-4 [scrollbar-width:none]" aria-label="Topic filters">
        {tags.map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setTag(item)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1.5 text-xs transition',
              tag === item ? 'border-signal bg-signal text-signal-ink' : 'border-rule bg-panel text-text-3 hover:border-rule-strong hover:text-text'
            )}
          >
            {item}
          </button>
        ))}
      </div>

      {loading && !state.rows.length ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" role="status" aria-label="Loading MARADMINs">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className="skeleton h-56 rounded-xl" />)}
        </div>
      ) : filtered.length === 0 ? (
        <Panel><EmptyState title="No MARADMINs match this view" description="Clear a filter or search for a different number or topic." /></Panel>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((row, index) => (
            <article
              key={row.id}
              className={cn('group relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-panel p-4 transition duration-200 hover:-translate-y-0.5 hover:border-rule-strong hover:shadow-[var(--shadow)] animate-fade-up', !row.read_at ? 'border-signal/40' : 'border-rule')}
              style={{ animationDelay: `${Math.min(index * 24, 180)}ms` }}
            >
              <div className="flex items-center gap-2">
                <span className="fig text-sm font-semibold text-signal">{row.number}</span>
                {!row.read_at && <Badge tone="signal">New</Badge>}
                <span className="fig ml-auto text-2xs text-text-3">{displayDate(row.published_at)}</span>
              </div>
              <button type="button" onClick={() => open(row)} className="mt-3 min-w-0 flex-1 text-left">
                <h3 className="line-clamp-3 text-md font-semibold leading-snug text-text">{row.title}</h3>
                <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-text-3">{row.summary}</p>
              </button>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {(row.tags || []).slice(0, 3).map((item) => <Badge key={item}>{item}</Badge>)}
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-rule pt-3">
                <button type="button" onClick={() => open(row)} className="text-xs font-medium text-text-2 hover:text-signal">View details</button>
                <button
                  type="button"
                  onClick={() => toggleSaved(row)}
                  className={cn('ml-auto rounded-md p-1.5 hover:bg-panel-2', row.saved_at ? 'text-signal' : 'text-text-3')}
                  aria-label={row.saved_at ? `Unsave MARADMIN ${row.number}` : `Save MARADMIN ${row.number}`}
                >
                  <Bookmark className={cn('h-4 w-4', row.saved_at && 'fill-current')} />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-rule pt-3 text-xs text-text-3">
        <ShieldCheck className="h-3.5 w-3.5 text-ledger" />
        <span>{state.sync?.source || 'Official Marines.mil RSS feed'}</span>
        {state.sync?.lastSuccess && <span className="fig">· refreshed {displayDate(state.sync.lastSuccess, true)}</span>}
        {state.sync?.error && <span className="text-redline">· cached results shown; refresh unavailable</span>}
      </div>

      {selected && (
        <Dialog
          open
          onOpenChange={(next) => !next && setSelected(null)}
          title={`MARADMIN ${selected.number}`}
          description={displayDate(selected.published_at, true)}
          size="md"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => toggleSaved(selected)}>
                <Bookmark className={cn('h-3.5 w-3.5', selected.saved_at && 'fill-current text-signal')} />
                {selected.saved_at ? 'Saved' : 'Save'}
              </Button>
              <Button size="sm" onClick={summarizeWithAi} disabled={aiBusy}>
                <Sparkles className={cn('h-3.5 w-3.5', aiBusy && 'animate-pulse')} /> {aiBusy ? 'Summarizing…' : 'AI summary'}
              </Button>
              <Button variant="primary" size="sm" asChild>
                <a href={selected.url} target="_blank" rel="noreferrer">Read official message <ExternalLink className="h-3.5 w-3.5" /></a>
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="rounded-xl border border-rule bg-panel-2/45 p-4">
              <div className="flex items-start gap-3">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-signal" />
                <div>
                  <p className="eyebrow">Quick read</p>
                  <p className="mt-1 text-base leading-relaxed text-text-2">{selected.summary}</p>
                </div>
              </div>
            </div>
            <div>
              <p className="eyebrow">Official title</p>
              <p className="mt-1 text-lg font-semibold leading-snug text-text">{selected.title}</p>
            </div>
            {aiSummary && (
              <div className="space-y-3 rounded-xl border border-signal/30 bg-signal/5 p-4">
                <div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-signal" /><p className="eyebrow">GenAI.mil suggestion</p></div>
                <p className="text-base leading-relaxed text-text-2">{aiSummary.plain_language}</p>
                {[
                  ['Who is affected', aiSummary.who_is_affected],
                  ['Required actions', aiSummary.required_actions],
                  ['Deadlines', aiSummary.deadlines],
                  ['Cautions', aiSummary.cautions],
                ].filter(([, items]) => items?.length).map(([label, items]) => (
                  <div key={label}>
                    <p className="eyebrow">{label}</p>
                    <ul className="mt-1 space-y-1 text-sm leading-relaxed text-text-2">
                      {items.map((item, index) => <li key={index}>• {typeof item === 'object' ? JSON.stringify(item) : item}</li>)}
                    </ul>
                  </div>
                ))}
                <p className="border-t border-rule pt-2 text-xs text-text-3">AI output is not authoritative. Read the linked Marines.mil message before acting.</p>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="eyebrow">Identifiers</p>
                <div className="mt-2 flex flex-wrap gap-1.5">{selected.tags.map((item) => <Badge key={item}>{item}</Badge>)}</div>
              </div>
              <div>
                <p className="eyebrow">Likely audience</p>
                <div className="mt-2 flex flex-wrap gap-1.5">{selected.audience.map((item) => <Badge key={item} tone="info">{item}</Badge>)}</div>
              </div>
            </div>
            <p className="flex items-start gap-2 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">
              <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Vantage identifiers are keyword-based navigation aids. The linked Marines.mil message remains the authoritative text.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
