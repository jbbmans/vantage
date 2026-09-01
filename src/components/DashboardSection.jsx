import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, EyeOff, SlidersHorizontal, RotateCcw, GripVertical, ArrowUp, ArrowDown } from 'lucide-react';
import { usePrefs, setPref } from '@/store/useStore';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const PREF_KEY = 'dashboard';

export function useDashboardLayout(sectionIds = []) {
  const prefs = usePrefs();
  const layout = prefs[PREF_KEY] || {};
  const hidden = new Set(layout.hidden || []);
  const collapsed = new Set(layout.collapsed || []);
  const order = [
    ...(layout.order || []).filter((id) => sectionIds.includes(id)),
    ...sectionIds.filter((id) => !(layout.order || []).includes(id)),
  ];

  const save = (next) => setPref(PREF_KEY, {
    hidden: [...next.hidden],
    collapsed: [...next.collapsed],
    order: next.order || order,
  });

  return {
    isHidden: (id) => hidden.has(id),
    isCollapsed: (id) => collapsed.has(id),
    toggleHidden: (id) => {
      hidden.has(id) ? hidden.delete(id) : hidden.add(id);
      save({ hidden, collapsed, order });
    },
    toggleCollapsed: (id) => {
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      save({ hidden, collapsed, order });
    },
    move: (sourceId, targetId) => {
      const source = order.indexOf(sourceId);
      const target = order.indexOf(targetId);
      if (source < 0 || target < 0 || source === target) return;
      const nextOrder = [...order];
      const [moved] = nextOrder.splice(source, 1);
      nextOrder.splice(target, 0, moved);
      save({ hidden, collapsed, order: nextOrder });
    },
    orderIndex: (id) => {
      const index = order.indexOf(id);
      return index < 0 ? sectionIds.length : index;
    },
    reset: () => save({ hidden: new Set(), collapsed: new Set(), order: sectionIds }),
    hiddenCount: hidden.size,
  };
}

export function DashboardSection({ id, title, subtitle, layout, className, action, children }) {
  const [dragging, setDragging] = useState(false);
  if (layout.isHidden(id)) return null;
  const collapsed = layout.isCollapsed(id);

  return (
    <section
      className={cn('panel rounded transition-[opacity,transform,border-color] duration-200', dragging && 'scale-[0.99] border-signal/60 opacity-60', className)}
      style={{ order: layout.orderIndex(id) }}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('application/x-vantage-dashboard')) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        layout.move(event.dataTransfer.getData('application/x-vantage-dashboard'), id);
      }}
    >
      <header className="flex h-9 items-center gap-2 border-b border-rule px-3">
        <button
          type="button"
          draggable
          onDragStart={(event) => {
            setDragging(true);
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('application/x-vantage-dashboard', id);
          }}
          onDragEnd={() => setDragging(false)}
          className="no-print cursor-grab rounded p-0.5 text-text-3 transition hover:bg-panel-2 hover:text-text active:cursor-grabbing active:scale-95"
          aria-label={`Drag ${title} to reorder`}
          title="Drag to reorder"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </button>
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
        <div id={`dash-${id}`} className="p-3 animate-fade-up">
          {children}
        </div>
      )}
    </section>
  );
}

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

  const orderedSections = [...sections].sort((a, b) => layout.orderIndex(a.id) - layout.orderIndex(b.id));

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
            {orderedSections.map((s, index) => {
              const shown = !layout.isHidden(s.id);
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-1 rounded px-1.5 py-1 hover:bg-panel-2"
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                    <input
                      type="checkbox"
                      checked={shown}
                      onChange={() => layout.toggleHidden(s.id)}
                      className="h-3 w-3 accent-[rgb(var(--signal))]"
                    />
                    <span className="flex-1 text-sm text-text-2">{s.title}</span>
                  </label>
                  {layout.isCollapsed(s.id) && shown && (
                    <span className="fig text-2xs text-text-3">collapsed</span>
                  )}
                  <button type="button" disabled={index === 0} onClick={() => layout.move(s.id, orderedSections[index - 1]?.id)} className="rounded p-0.5 text-text-3 hover:bg-panel hover:text-text disabled:opacity-25" aria-label={`Move ${s.title} up`}>
                    <ArrowUp className="h-3 w-3" />
                  </button>
                  <button type="button" disabled={index === orderedSections.length - 1} onClick={() => layout.move(s.id, orderedSections[index + 1]?.id)} className="rounded p-0.5 text-text-3 hover:bg-panel hover:text-text disabled:opacity-25" aria-label={`Move ${s.title} down`}>
                    <ArrowDown className="h-3 w-3" />
                  </button>
                </div>
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
