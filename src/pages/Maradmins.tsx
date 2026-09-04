import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Bookmark, BookmarkCheck, Search, RefreshCw, ScrollText } from 'lucide-react';
import { PageHeader, Button, Input, Select, Badge, EmptyState, Skeleton, Segmented } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { AiAction, AiResult } from '@/components/AiPanel';
import { DateText, useParam } from '@/components/common';
import { keys, useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';
import { cn } from '@/lib/utils';

export default function Maradmins() {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const { data, isPending, refetch, isFetching } = useQuery({ queryKey: keys.maradmins, queryFn: () => api.maradmins(false), staleTime: 10 * 60_000 });
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('all');
  const [filter, setFilter] = useState<'all' | 'unread' | 'saved'>('all');
  const [open, setOpen] = useParam('open');
  const [aiOut, setAiOut] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  const rows: any[] = useMemo(() => data?.rows || [], [data]);
  const tags = useMemo(() => [...new Set(rows.flatMap((r) => r.tags || []))].sort() as string[], [rows]);
  const list = useMemo(() => rows.filter((r) => (tag === 'all' || (r.tags || []).includes(tag)) && (filter === 'all' || (filter === 'unread' ? !r.read_at : Boolean(r.saved_at))) && (!q.trim() || `${r.number} ${r.title} ${r.summary}`.toLowerCase().includes(q.trim().toLowerCase()))), [rows, tag, filter, q]);
  const current = rows.find((r) => r.number === open);
  const mark = async (r: any, patch: { read?: boolean; saved?: boolean }) => {
    try { const res = await api.maradminState(r.id, patch); qc.setQueryData(keys.maradmins, (d: any) => d ? { ...d, rows: d.rows.map((x: any) => (x.id === r.id ? { ...x, read_at: res.read_at, saved_at: res.saved_at } : x)) } : d); }
    catch (e) { toast.error(api.errorText(e)); }
  };
  useEffect(() => { setAiOut(null); if (current && !current.read_at) mark(current, { read: true }); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const unread = rows.filter((r) => !r.read_at).length;

  if (!identity?.instance.maradminsEnabled) return <div className="page"><PageHeader eyebrow="MARADMINs" title="Message feed" /><div className="card"><EmptyState icon={ScrollText} title="The MARADMIN feed is off on this deployment" description="The owner can enable it in the Owner console. Vantage only ever caches public message titles." /></div></div>;

  return (
    <div className="page">
      <PageHeader eyebrow="MARADMINs" title="Message feed" lede="Public Marine administrative messages, cached here so you see what changed. Read the full text on marines.mil; nothing here is authoritative.">
        <Button onClick={() => refetch()} loading={isFetching}><RefreshCw className="h-4 w-4" />Refresh</Button>
      </PageHeader>
      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[200px] flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-3" /><Input aria-label="Search messages" className="pl-8" placeholder="Number or title…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Select aria-label="Topic" className="w-44" value={tag} onValueChange={setTag} options={[{ value: 'all', label: 'All topics' }, ...tags.map((t) => ({ value: t, label: t }))]} />
        <Segmented label="Filter" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: `Unread${unread ? ` (${unread})` : ''}` }, { value: 'saved', label: 'Saved' }]} />
      </div>
      {data?.sync?.error && <p className="mb-3 text-xs text-warn">Last sync failed: {data.sync.error}. Showing the cached list.</p>}
      {isPending ? <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}</div> : list.length === 0 ? <div className="card"><EmptyState icon={ScrollText} title={rows.length ? 'No messages match' : 'No messages cached yet'} description={rows.length ? 'Try a different topic or clear the search.' : 'The first sync runs shortly after the feed is enabled.'} /></div> : (
        <ul className="card divide-y divide-line" style={{ overflow: 'hidden' }}>
          {list.map((r) => (
            <li key={r.id} className={cn('row flex items-start gap-3 px-4 py-3', !r.read_at && 'bg-accent-soft/30')}>
              <span className={cn('mt-2 badge-dot', r.read_at ? 'bg-line-strong' : 'bg-accent')} />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(r.number)}>
                <span className="flex flex-wrap items-center gap-2"><span className="fig text-xs font-semibold text-accent">MARADMIN {r.number}</span><span className="text-xs text-ink-3"><DateText value={r.published_at?.slice(0, 10)} /></span>{(r.tags || []).slice(0, 3).map((t: string) => <Badge key={t}>{t}</Badge>)}</span>
                <span className={cn('mt-0.5 block text-sm', r.read_at ? 'text-ink-2' : 'font-medium text-ink')}>{r.title}</span>
              </button>
              <button type="button" onClick={() => mark(r, { saved: !r.saved_at })} className="text-ink-3 hover:text-accent" aria-label={r.saved_at ? 'Unsave' : 'Save'}>{r.saved_at ? <BookmarkCheck className="h-4 w-4 text-accent" /> : <Bookmark className="h-4 w-4" />}</button>
            </li>
          ))}
        </ul>
      )}
      <Dialog open={Boolean(current)} onOpenChange={(o) => { if (!o) setOpen(''); }} title={current ? `MARADMIN ${current.number}` : ''} description={current?.title} size="md"
        footer={current ? <><Button variant="ghost" onClick={() => mark(current, { saved: !current.saved_at })}>{current.saved_at ? 'Unsave' : 'Save for later'}</Button><Button variant="primary" asChild><a href={current.url} target="_blank" rel="noopener noreferrer">Read on marines.mil<ExternalLink className="h-4 w-4" /></a></Button></> : undefined}>
        {current && (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-ink-2">{current.summary || 'No summary available. Read the full message on marines.mil.'}</p>
            {(current.audience || []).length > 0 && <p className="text-xs text-ink-3">Likely applies to: {current.audience.join(', ')}</p>}
            {identity?.instance.aiEnabled && (
              <div><AiAction workflow="maradmin_summary" input={{ id: current.id }} label="Plain-language summary" onResult={(output, meta) => setAiOut({ output, meta })} />{aiOut && <div className="mt-3"><AiResult output={aiOut.output} meta={aiOut.meta} primaryKey="plain_language" /></div>}</div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
}
