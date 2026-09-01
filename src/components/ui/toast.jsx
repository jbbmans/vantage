import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertTriangle, Info, X, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const ToastContext = createContext(null);

const ICONS = { success: CheckCircle2, error: AlertTriangle, info: Info };
const TONES = {
  success: 'border-ledger/40 text-ledger',
  error: 'border-redline/40 text-redline',
  info: 'border-rule-strong text-text-2',
};

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
    setItems((list) => list.filter((x) => x.id !== id));
  }, []);

  const arm = useCallback((id, ttl) => {
    if (!ttl) return;
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    timers.current.set(id, setTimeout(() => dismiss(id), ttl));
  }, [dismiss]);

  const push = useCallback((message, tone = 'info', ttl = 4000, action = null) => {
    const id = Math.random().toString(36).slice(2);
    setItems((list) => [...list, { id, message, tone, action, ttl }]);
    arm(id, ttl);
    return id;
  }, [arm]);

  const api = useMemo(() => ({
    show: push,
    success: (m, action) => push(m, 'success', action ? 9000 : 4000, action),
    error: (m, action) => push(m, 'error', 7000, action),
    info: (m, action) => push(m, 'info', action ? 9000 : 4000, action),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}

      <div
        role="region"
        aria-live="polite"
        aria-label="Notifications"
        className="no-print pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {items.map((t) => {
          const Icon = ICONS[t.tone];
          return (
            <div
              key={t.id}
              className={cn(
                'pointer-events-auto flex items-start gap-2 rounded border bg-panel px-3 py-2 shadow-[var(--shadow)] animate-fade-up',
                TONES[t.tone]
              )}

              onMouseEnter={() => {
                const timer = timers.current.get(t.id);
                if (timer) clearTimeout(timer);
              }}
              onMouseLeave={() => arm(t.id, t.ttl)}
            >
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-relaxed text-text">{t.message}</p>
                {t.action && (
                  <button
                    onClick={() => {
                      t.action.run();
                      dismiss(t.id);
                    }}
                    className="mt-1.5 flex items-center gap-1 text-xs font-medium text-signal underline-offset-2 hover:underline"
                  >
                    <Undo2 className="h-3 w-3" />
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                className="text-text-3 hover:text-text"
                aria-label="Dismiss notification"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
