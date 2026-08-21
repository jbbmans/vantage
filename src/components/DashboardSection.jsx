import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, EyeOff, SlidersHorizontal, RotateCcw } from 'lucide-react';
import { usePrefs, setPref } from '@/store/useStore';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * Dashboard layout.
 *
 * Every section on the Command Center can be collapsed to its title bar or
 * hidden entirely, and the choice follows the Marine between machines because
 * it's a server-side preference, not a browser one. A comptroller clerk who
 * never uses goals shouldn't scroll past a goals panel every morning.
 *
 * Hidden and collapsed are different states on purpose: collapsed keeps the
 * title bar as a reminder the data exists; hidden removes it from the page and
 * only the Display menu brings it back.
 */

const PREF_KEY = 'dashboard';

export function useDashboardLayout() {
  const prefs = usePrefs();
  const layout = prefs[PREF_KEY] || {};
  const hidden = new Set(layout.hidden || []);
  const collapsed = new Set(layout.collapsed || []);

  const save = (next) => setPref(PREF_KEY, { hidden: [...next.hidden], collapsed: [...next.collapsed] });

  return {
    isHidden: (id) => hidden.has(id),
    isCollapsed: (id) => collapsed.has(id),
    toggleHidden: (id) => {
      hidden.has(id) ? hidden.delete(id) : hidden.add(id);
      save({ hidden, collapsed });
    },
    toggleCollapsed: (id) => {
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      save({ hidden, collapsed });
    },
    reset: () => save({ hidden: new Set(), collapsed: new Set() }),
    hiddenCount: hidden.size,
  };
}

/**
 * The chrome around one dashboard section. Children render only when expanded,
 * so a collapsed chart isn't quietly re-rendering on every keystroke.
 */
export function DashboardSection({ id, title, subtitle, layout, className, action, children }) {
  if (layout.isHidden(id)) return null;
  const collapsed = layout.isCollapsed(id);

  return (
    <section className={cn('panel rounded', className)}>
      <header className="flex h-9 items-center gap-2 border-b border-rule px-3">
        <button
          onClick={() => layout.toggleCollapsed(id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          aria-expanded={!collapsed}
          aria-controls={`dash-${id}`}
        >
          {collapsed
            ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-3" />
            : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-3" />}
          <span className="truncate font-mono text-xs uppercase tracking-[0.12em] text-text-2">{title}</span>
          {subtitle && !collapsed && (
            <span className="hidden truncate text-2xs text-text-3 sm:inline">· {subtitle}</span>
          )}
        </button>
        {!collapsed && action}
        <button
          onClick={() => layout.toggleHidden(id)}
          className="no-print shrink-0 text-text-3 opacity-0 transition-opacity hover:text-text focus-visible:opacity-100 [section:hover_&]:opacity-100"
          aria-label={`Hide ${title}`}
          title="Hide — bring back from Display"
        >
          <EyeOff className="h-3 w-3" />
        </button>
      </header>
      {!collapsed && (
        <div id={`dash-${id}`} className="p-3">
          {children}
        </div>
      )}
    </section>
  );
}

/** The Display menu: one checkbox per section, plus a reset. */
export function DisplayMenu({ sections, layout }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <Button variant="default" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <SlidersHorizontal className="h-3.5 w-3.5" />
        Display
        {layout.hiddenCount > 0 && (
          <span className="fig rounded bg-signal/15 px-1 text-2xs text-signal">{layout.hiddenCount} off</span>
        )}
      </Button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 w-64 rounded border border-rule-strong bg-panel p-2 shadow-[var(--shadow)]"
        >
          <p className="eyebrow px-1 pb-1.5">Sections</p>
          <div className="space-y-0.5">
            {sections.map((s) => {
              const shown = !layout.isHidden(s.id);
              return (
                <label
                  key={s.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-panel-2"
                >
                  <input
                    type="checkbox"
                    checked={shown}
                    onChange={() => layout.toggleHidden(s.id)}
                    className="h-3 w-3 accent-[rgb(var(--signal))]"
                  />
                  <span className="flex-1 text-sm text-text-2">{s.title}</span>
                  {layout.isCollapsed(s.id) && shown && (
                    <span className="fig text-2xs text-text-3">collapsed</span>
                  )}
                </label>
              );
            })}
          </div>
          <button
            onClick={() => { layout.reset(); setOpen(false); }}
            className="mt-2 flex w-full items-center gap-1.5 border-t border-rule pt-2 text-xs text-text-3 hover:text-text"
          >
            <RotateCcw className="h-3 w-3" />
            Show everything, expand everything
          </button>
        </div>
      )}
    </div>
  );
}
