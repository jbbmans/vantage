import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { ArrowRight, Plus, Search } from 'lucide-react';
import type { NavItem } from '@/config/nav';
import * as api from '@/lib/api';
import { cn } from '@/lib/utils';

interface Item { id: string; title: string; subtitle?: string | null; kind: string; to?: string; run?: () => void }

export default function CommandPalette({ open, onOpenChange, onQuickLog, nav }: { open: boolean; onOpenChange: (o: boolean) => void; onQuickLog: (seed?: string) => void; nav: NavItem[] }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Item[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => { if (open) { setQuery(''); setResults([]); setActive(0); } }, [open]);
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
    return [...(q ? results : []), ...actions, ...pages];
  }, [query, results, nav, onQuickLog]);

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
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-[2px] animate-fade-in" />
        <DialogPrimitive.Content aria-describedby="" className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-1.5rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-surface shadow-modal animate-scale-in focus:outline-none">
          <DialogPrimitive.Title className="sr-only">Search and jump</DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-b border-line px-4">
            <Search className="h-4 w-4 text-ink-3" />
            <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} placeholder="Search records, people, MARADMINs, or jump to a page…" className="h-12 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3" aria-label="Search" role="combobox" aria-expanded aria-controls="palette-list" aria-activedescendant={items[active]?.id} />
          </div>
          <ul id="palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
            {items.map((item, i) => (
              <li key={item.id} id={item.id} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => choose(item)} className={cn('flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm', i === active ? 'bg-surface-2 text-ink' : 'text-ink-2')}>
                {item.kind === 'action' ? <Plus className="h-4 w-4 text-accent" /> : <ArrowRight className="h-4 w-4 text-ink-3" />}
                <span className="min-w-0 flex-1 truncate">{item.title}{item.subtitle && <span className="ml-2 text-xs text-ink-3">{item.subtitle}</span>}</span>
                <span className="chip">{item.kind}</span>
              </li>
            ))}
            {items.length === 0 && <li className="px-3 py-6 text-center text-sm text-ink-3">Nothing matches.</li>}
          </ul>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
