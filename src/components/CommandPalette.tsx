import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowRight, BookOpen, Building2, CornerDownLeft, History, Plus, Search } from 'lucide-react';
import type { NavItem } from '@/config/nav';
import * as api from '@/lib/api';
import { useIdentity } from '@/lib/queries';
import { useView, viewLabel } from '@/lib/view';
import { recentVisits } from '@/lib/recent';
import { cn } from '@/lib/utils';

interface Item { id: string; title: string; subtitle?: string | null; kind: string; to?: string; run?: () => void }

export default function CommandPalette({ open, onOpenChange, onQuickLog, nav }: { open: boolean; onOpenChange: (o: boolean) => void; onQuickLog: (seed?: string) => void; nav: NavItem[] }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Item[]>([]);
  const [reference, setReference] = useState<Item[]>([]);
  const [active, setActive] = useState(0);
  const { data: identity } = useIdentity();
  const { view, views, setView } = useView(identity);

  useEffect(() => { if (open) { setQuery(''); setResults([]); setReference([]); setActive(0); } }, [open]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setReference([]); return; }
    let live = true;
    import('@/lib/referenceIndex').then(({ searchReference }) => { if (live) setReference(searchReference(q, 5).map((h) => ({ ...h, kind: 'reference' }))); }).catch(() => undefined);
    return () => { live = false; };
  }, [query]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    let live = true;
    const t = setTimeout(() => api.search(q).then((r) => { if (live) setResults((r.results || []).map((x: any) => ({ id: `${x.type}-${x.id}`, title: x.title, subtitle: x.subtitle, kind: x.type, to: x.to }))); }).catch(() => { if (live) setResults([]); }), 160);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const actions: Item[] = [{ id: 'act-log', title: q && !/^(go|open|nav)/.test(q) && q.length > 6 ? `Log activity: “${query.trim()}”` : 'Log activity', subtitle: 'Press N anywhere', kind: 'action', run: () => onQuickLog(q.length > 6 ? query.trim() : '') }];
    const pages = nav.filter((n) => !q || n.label.toLowerCase().includes(q)).map((n) => ({ id: `nav-${n.to}`, title: n.label, subtitle: `G then ${n.key.toUpperCase()}`, kind: 'page', to: n.to }));
    const switches = views.length > 1 ? views.filter((v) => v.id !== view?.id && (!q || `view ${viewLabel(v)} ${v.name}`.toLowerCase().includes(q))).map((v) => ({ id: `view-${v.id}`, title: `View ${viewLabel(v)}`, subtitle: v.teams ? `Whole command · ${v.teams} ${v.teams === 1 ? 'team' : 'teams'}` : v.level === 'full' ? 'Team' : 'Team overview', kind: 'view', run: () => setView(v.id) })) : [];
    const recent = recentVisits(identity?.user.id).slice(0, 5).map((r) => ({ id: `recent-${r.to}`, title: r.title, subtitle: r.kind === 'case' ? 'Case you opened' : r.kind === 'marine' ? 'Marine you opened' : 'Entry you opened', kind: 'recent', to: r.to }));
    if (!q) return [...recent, ...actions, ...pages, ...switches.slice(0, 3)];
    return /^(view|switch)/.test(q) ? [...switches, ...actions, ...pages, ...results, ...reference] : [...results, ...reference, ...actions, ...switches, ...pages];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, results, reference, nav, onQuickLog, views, view, setView, open, identity?.user.id]);

  useEffect(() => { setActive(0); }, [items.length]);

  const choose = (item: Item) => { onOpenChange(false); if (item.run) item.run(); else if (item.to) navigate(item.to); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && items[active]) { e.preventDefault(); choose(items[active]); }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-deep/45 backdrop-blur-[3px] animate-fade-in" />
        <DialogPrimitive.Content aria-describedby="" className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-1.5rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-2xl bg-surface shadow-modal animate-popover-in focus:outline-none">
          <DialogPrimitive.Title className="sr-only">Search and jump</DialogPrimitive.Title>
          <div className="flex items-center gap-3 border-b border-line px-5">
            <Search className="h-[18px] w-[18px] text-ink-3" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} placeholder="Search work, records, people, the FMRA reference, or jump to a page…" className="h-14 flex-1 bg-transparent text-md text-ink outline-none placeholder:text-ink-3" aria-label="Search" role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={items[active]?.id} />
            <kbd className="kbd">Esc</kbd>
          </div>
          <ul id="palette-list" role="listbox" className="max-h-[52vh] overflow-y-auto p-2">
            {items.map((item, i) => (
              <li key={item.id} id={item.id} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => choose(item)} className={cn('flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors', i === active ? 'bg-surface-2 text-ink' : 'text-ink-2')}>
                <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', item.kind === 'action' ? 'bg-accent/10 text-accent' : item.kind === 'reference' ? 'bg-accent-2/10 text-accent-2' : 'bg-surface-2 text-ink-3')}>
                  {item.kind === 'action' ? <Plus className="h-3.5 w-3.5" /> : item.kind === 'reference' ? <BookOpen className="h-3.5 w-3.5" /> : item.kind === 'view' ? <Building2 className="h-3.5 w-3.5" /> : item.kind === 'recent' ? <History className="h-3.5 w-3.5" /> : <ArrowRight className="h-3.5 w-3.5" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-ink">{item.title}</span>
                  {item.subtitle && <span className="block truncate text-xs text-ink-3">{item.subtitle}</span>}
                </span>
                {i === active ? <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden /> : <span className="chip shrink-0">{item.kind}</span>}
              </li>
            ))}
            {items.length === 0 && <li className="px-3 py-8 text-center text-sm text-ink-3">Nothing matches.</li>}
          </ul>
          <div className="flex items-center gap-4 border-t border-line bg-surface-2/60 px-5 py-2 text-2xs text-ink-3">
            <span className="flex items-center gap-1"><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> move</span>
            <span className="flex items-center gap-1"><kbd className="kbd">↵</kbd> open</span>
            <span className="ml-auto">Press <kbd className="kbd">N</kbd> anywhere to log</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
