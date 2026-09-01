import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import {
  Bell, CornerDownLeft, GraduationCap, Plus, RefreshCw, Search, ShieldCheck,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV } from '@/config/nav';
import {
  PERMISSIONS, canAnywhereForNav, refreshAll, useActivities, useGoals, useIdentity,
  useProjects, useRecognitions, useTasks, useTrainings,
} from '@/store/useStore';
import { formatDTG, formatDollarsExact } from '@/lib/metrics';
import { CATEGORY_COLORS } from '@/lib/constants';
import { Dot } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

export default function CommandPalette({ open, onOpenChange, onQuickLog }) {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const navigate = useNavigate();
  const toast = useToast();
  const listRef = useRef(null);
  const identity = useIdentity();
  const activities = useActivities();
  const tasks = useTasks();
  const projects = useProjects();
  const recognitions = useRecognitions();
  const trainings = useTrainings();
  const goals = useGoals();

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
  }, [open]);

  const visibleNav = useMemo(() => NAV.filter((item) => {
    if (item.requiresLead && !identity?.canLead) return false;
    if (item.requiresOperator && !identity?.isOperator) return false;
    if (item.requires && !canAnywhereForNav(PERMISSIONS[item.requires])) return false;
    return true;
  }), [identity]);

  const actions = useMemo(() => [
    {
      id: 'action:log', label: 'Log an activity', meta: 'Create a performance record', hint: 'N', icon: Plus,
      keywords: 'new create record achievement', run: () => onQuickLog?.(),
    },
    {
      id: 'action:notifications', label: 'Open notifications', meta: 'Review updates and alerts', icon: Bell,
      keywords: 'alerts inbox unread', run: () => window.dispatchEvent(new CustomEvent('vantage:open-notifications')),
    },
    {
      id: 'action:rank', label: 'Request a rank update', meta: 'Open your rank workflow', icon: GraduationCap,
      keywords: 'promotion grade correction', run: () => navigate('/settings#rank'),
    },
    {
      id: 'action:refresh', label: 'Refresh application data', meta: 'Pull the latest records', icon: RefreshCw,
      keywords: 'sync reload update', run: async () => {
        try {
          await refreshAll();
          toast.success('Application data refreshed.');
        } catch (error) {
          toast.error(error?.message || 'Data could not be refreshed.');
        }
      },
    },
    ...(identity?.isOperator ? [{
      id: 'action:operator', label: 'Open owner console', meta: 'Instance configuration and health', icon: ShieldCheck,
      keywords: 'admin developer configuration hosting', run: () => navigate('/operator'),
    }] : []),
  ], [identity?.isOperator, navigate, onQuickLog, toast]);

  const results = useMemo(() => {
    const raw = query.trim();
    const q = raw.toLowerCase();
    const match = (...values) => values.some((value) => String(value || '').toLowerCase().includes(q));

    if (!q) {
      return [
        { heading: 'Quick actions', items: actions },
        { heading: 'Pages', items: visibleNav.map((item) => ({
          id: `nav:${item.to}`, label: item.label, hint: item.key.toUpperCase(), icon: item.icon, run: () => navigate(item.to),
        })) },
      ];
    }

    const groups = [];
    const matchedActions = actions.filter((item) => match(item.label, item.meta, item.keywords));
    if (matchedActions.length) groups.push({ heading: 'Actions', items: matchedActions });

    const navigation = visibleNav.filter((item) => match(item.label, item.to)).map((item) => ({
      id: `nav:${item.to}`, label: item.label, hint: 'page', icon: item.icon, run: () => navigate(item.to),
    }));
    if (navigation.length) groups.push({ heading: 'Pages', items: navigation });

    const activityResults = activities
      .filter((item) => match(item.title, item.result, item.organization, item.system, item.unit, item.category))
      .slice(0, 8)
      .map((item) => ({
        id: `activity:${item.id}`,
        label: item.title,
        meta: [formatDTG(item.date), item.category, item.dollar_amount ? formatDollarsExact(item.dollar_amount) : null].filter(Boolean).join(' · '),
        color: CATEGORY_COLORS[item.category],
        run: () => navigate(`/activities/${item.id}`),
      }));
    if (activityResults.length) groups.push({ heading: 'Activities', items: activityResults });

    const records = [
      ...tasks.filter((item) => match(item.title, item.status)).slice(0, 4).map((item) => ({ id: `task:${item.id}`, label: item.title, meta: `Task · ${item.status}`, run: () => navigate('/work') })),
      ...projects.filter((item) => match(item.name, item.status)).slice(0, 4).map((item) => ({ id: `project:${item.id}`, label: item.name, meta: `Project · ${item.status}`, run: () => navigate('/work') })),
      ...goals.filter((item) => match(item.title, item.status)).slice(0, 3).map((item) => ({ id: `goal:${item.id}`, label: item.title, meta: `Goal · ${item.status}`, run: () => navigate('/goals') })),
      ...recognitions.filter((item) => match(item.title, item.from_whom)).slice(0, 3).map((item) => ({ id: `recognition:${item.id}`, label: item.title, meta: `Recognition · ${formatDTG(item.date)}`, run: () => navigate('/career?tab=recognition') })),
      ...trainings.filter((item) => match(item.title, item.provider)).slice(0, 3).map((item) => ({ id: `training:${item.id}`, label: item.title, meta: `Training · ${item.hours || 0}h`, run: () => navigate('/career?tab=development') })),
    ];
    if (records.length) groups.push({ heading: 'Records', items: records });

    const logText = raw.replace(/^log\s+/i, '').trim();
    if (logText) groups.push({
      heading: 'Create',
      items: [{ id: `create:${logText}`, label: `Log “${logText}”`, hint: 'Enter', icon: Plus, run: () => onQuickLog?.(logText) }],
    });
    return groups;
  }, [actions, activities, goals, navigate, onQuickLog, projects, query, recognitions, tasks, trainings, visibleNav]);

  const flat = useMemo(() => results.flatMap((group) => group.items), [results]);

  useEffect(() => {
    setCursor((current) => Math.min(current, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const run = (item) => {
    if (!item) return;
    onOpenChange(false);
    setTimeout(() => item.run(), 0);
  };

  const onKeyDown = (event) => {
    if (!flat.length) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setCursor((current) => (current + 1) % flat.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((current) => (current - 1 + flat.length) % flat.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      run(flat[cursor]);
    }
  };

  let itemIndex = -1;
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-nav/75 backdrop-blur-md data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          className="fixed left-1/2 top-[max(4rem,10vh)] z-50 w-[calc(100vw-1.25rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-xl border border-rule-strong bg-panel/95 shadow-[var(--shadow-lg)] backdrop-blur-xl data-[state=open]:animate-command-in"
        >
          <DialogPrimitive.Title className="sr-only">Vantage command menu</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Search records, run an action, or open a page.</DialogPrimitive.Description>

          <div className="flex items-center gap-3 border-b border-rule px-4">
            <Search className="h-4 w-4 shrink-0 text-signal" />
            <input
              autoFocus
              value={query}
              onChange={(event) => { setQuery(event.target.value); setCursor(0); }}
              placeholder="Search or type a command…"
              className="h-14 w-full bg-transparent text-base text-text placeholder:text-text-3 focus:outline-none"
            />
            <kbd className="fig hidden shrink-0 rounded border border-rule bg-panel-2 px-1.5 py-0.5 text-2xs text-text-3 sm:block">ESC</kbd>
          </div>

          <div ref={listRef} className="max-h-[min(62vh,34rem)] overflow-y-auto p-2">
            {results.map((group) => (
              <div key={group.heading} className="mb-2 last:mb-0">
                <p className="eyebrow px-2 py-1.5">{group.heading}</p>
                {group.items.map((item) => {
                  itemIndex += 1;
                  const index = itemIndex;
                  const active = index === cursor;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      data-active={active}
                      onMouseMove={() => setCursor(index)}
                      onClick={() => run(item)}
                      className={cn(
                        'group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-all duration-150',
                        active ? 'translate-x-0.5 bg-signal/[0.09] shadow-sm' : 'hover:bg-panel-2/70'
                      )}
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-rule bg-panel-2">
                        {item.color ? <Dot color={item.color} /> : Icon ? <Icon className="h-4 w-4 text-text-3 group-hover:text-signal" /> : <Search className="h-3.5 w-3.5 text-text-3" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-text">{item.label}</span>
                        {item.meta && <span className="fig block truncate text-2xs text-text-3">{item.meta}</span>}
                      </span>
                      {item.hint && <kbd className="fig shrink-0 text-2xs text-text-3">{item.hint}</kbd>}
                      {active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-signal" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <footer className="hidden items-center gap-4 border-t border-rule bg-panel-2/45 px-4 py-2 text-2xs text-text-3 sm:flex">
            <span><kbd>↑↓</kbd> move</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
            <span className="ml-auto">Try “log completed PME”</span>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
