import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Search, CornerDownLeft, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV } from '@/config/nav';
import { useActivities, useTasks, useProjects, useRecognitions, useTrainings, useGoals } from '@/store/useStore';
import { formatDTG, formatDollarsExact } from '@/lib/metrics';
import { CATEGORY_COLORS } from '@/lib/constants';
import { Dot } from '@/components/ui/primitives';

/**
 * One search field over every record in the app, plus navigation and actions.
 * Everything is in memory already, so this is a plain filter — no index to
 * maintain and no stale results.
 */
export default function CommandPalette({ open, onOpenChange, onQuickLog }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const listRef = useRef(null);

  const activities = useActivities();
  const tasks = useTasks();
  const projects = useProjects();
  const recognitions = useRecognitions();
  const trainings = useTrainings();
  const goals = useGoals();

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const groups = [];

    if (!q) {
      groups.push({
        heading: 'Actions',
        items: [{ id: 'act:log', label: 'Log an activity', hint: 'N', run: () => onQuickLog?.() }],
      });
      groups.push({
        heading: 'Go to',
        items: NAV.map((n) => ({ id: `nav:${n.to}`, label: n.label, hint: n.key.toUpperCase(), run: () => navigate(n.to) })),
      });
      return groups;
    }

    const match = (text) => String(text || '').toLowerCase().includes(q);

    const nav = NAV.filter((n) => match(n.label)).map((n) => ({
      id: `nav:${n.to}`,
      label: n.label,
      hint: 'page',
      run: () => navigate(n.to),
    }));
    if (nav.length) groups.push({ heading: 'Go to', items: nav });

    const acts = activities
      .filter((a) => match(a.title) || match(a.result) || match(a.organization) || match(a.system) || match(a.unit) || match(a.category))
      .slice(0, 8)
      .map((a) => ({
        id: `a:${a.id}`,
        label: a.title,
        meta: [formatDTG(a.date), a.category, a.dollar_amount ? formatDollarsExact(a.dollar_amount) : null]
          .filter(Boolean)
          .join(' · '),
        color: CATEGORY_COLORS[a.category],
        run: () => navigate(`/activities/${a.id}`),
      }));
    if (acts.length) groups.push({ heading: 'Activities', items: acts });

    const other = [
      ...tasks.filter((t) => match(t.title)).slice(0, 4).map((t) => ({ id: `t:${t.id}`, label: t.title, meta: `Task · ${t.status}`, run: () => navigate('/work') })),
      ...projects.filter((p) => match(p.name)).slice(0, 4).map((p) => ({ id: `p:${p.id}`, label: p.name, meta: `Project · ${p.status}`, run: () => navigate('/work') })),
      ...goals.filter((g) => match(g.title)).slice(0, 3).map((g) => ({ id: `g:${g.id}`, label: g.title, meta: `Goal · ${g.status}`, run: () => navigate('/goals') })),
      ...recognitions.filter((r) => match(r.title) || match(r.from_whom)).slice(0, 3).map((r) => ({ id: `r:${r.id}`, label: r.title, meta: `Recognition · ${formatDTG(r.date)}`, run: () => navigate('/recognition') })),
      ...trainings.filter((t) => match(t.title) || match(t.provider)).slice(0, 3).map((t) => ({ id: `d:${t.id}`, label: t.title, meta: `Development · ${t.hours || 0}h`, run: () => navigate('/development') })),
    ];
    if (other.length) groups.push({ heading: 'Records', items: other });

    groups.push({
      heading: 'Create',
      items: [{ id: 'act:log', label: `Log "${query.trim()}"`, hint: 'Enter', icon: Plus, run: () => onQuickLog?.(query.trim()) }],
    });

    return groups;
  }, [query, activities, tasks, projects, goals, recognitions, trainings, navigate, onQuickLog]);

  const flat = useMemo(() => results.flatMap((g) => g.items), [results]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  const run = (item) => {
    onOpenChange(false);
    setTimeout(() => item.run(), 0);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => (c + 1) % Math.max(1, flat.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => (c - 1 + flat.length) % Math.max(1, flat.length));
    } else if (e.key === 'Enter' && flat[cursor]) {
      e.preventDefault();
      run(flat[cursor]);
    }
  };

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  let index = -1;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[2px]" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded border border-rule-strong bg-panel shadow-[var(--shadow)] animate-scale-in"
        >
          <DialogPrimitive.Title className="sr-only">Search Vantage</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search records, jump between pages, or log an activity.
          </DialogPrimitive.Description>

          <div className="flex items-center gap-2 border-b border-rule px-3">
            <Search className="h-3.5 w-3.5 shrink-0 text-text-3" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setCursor(0);
              }}
              placeholder="Search activities, tasks, goals…"
              className="h-11 w-full bg-transparent text-md text-text placeholder:text-text-3 focus:outline-none"
            />
            <kbd className="fig hidden shrink-0 rounded border border-rule px-1 text-2xs text-text-3 sm:block">ESC</kbd>
          </div>

          <div ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
            {flat.length === 0 && (
              <p className="px-2 py-6 text-center text-sm text-text-3">Nothing matches that.</p>
            )}
            {results.map((group) => (
              <div key={group.heading} className="mb-1 last:mb-0">
                <p className="eyebrow px-2 py-1">{group.heading}</p>
                {group.items.map((item) => {
                  index += 1;
                  const active = index === cursor;
                  const i = index;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      data-active={active}
                      onMouseMove={() => setCursor(i)}
                      onClick={() => run(item)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded px-2 py-1.5 text-left transition-colors',
                        active ? 'bg-panel-2' : 'hover:bg-panel-2/60'
                      )}
                    >
                      {item.color ? <Dot color={item.color} /> : Icon ? <Icon className="h-3 w-3 text-text-3" /> : <span className="w-2" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-base text-text">{item.label}</span>
                        {item.meta && <span className="fig block truncate text-2xs text-text-3">{item.meta}</span>}
                      </span>
                      {item.hint && <kbd className="fig shrink-0 text-2xs text-text-3">{item.hint}</kbd>}
                      {active && <CornerDownLeft className="h-3 w-3 shrink-0 text-signal" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
