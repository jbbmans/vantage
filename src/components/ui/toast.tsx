import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Toast { id: number; kind: 'success' | 'error' | 'info'; message: string; action?: { label: string; onClick: () => void } }
interface ToastApi { success: (m: string, action?: Toast['action']) => void; error: (m: string, action?: Toast['action']) => void; info: (m: string, action?: Toast['action']) => void }
const Ctx = createContext<ToastApi>({ success: () => {}, error: () => {}, info: () => {} });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const push = useCallback((kind: Toast['kind'], message: string, action?: Toast['action']) => {
    const id = ++counter.current;
    setToasts((t) => [...t.slice(-3), { id, kind, message, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : action ? 6000 : 3800);
  }, []);
  const api = useMemo<ToastApi>(() => ({ success: (m, a) => push('success', m, a), error: (m, a) => push('error', m, a), info: (m, a) => push('info', m, a) }), [push]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6" aria-live="polite">
        {toasts.map((t) => {
          const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? AlertCircle : Info;
          return (
            <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className={cn('pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border bg-surface px-3.5 py-2.5 text-sm shadow-pop animate-fade-up', t.kind === 'error' ? 'border-bad/40' : t.kind === 'success' ? 'border-good/40' : 'border-line')}>
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', t.kind === 'success' && 'text-good', t.kind === 'error' && 'text-bad', t.kind === 'info' && 'text-info')} />
              <span className="min-w-0 flex-1 leading-snug text-ink">{t.message}</span>
              {t.action && <button type="button" onClick={() => { t.action!.onClick(); setToasts((x) => x.filter((y) => y.id !== t.id)); }} className="shrink-0 text-xs font-semibold text-accent hover:underline">{t.action.label}</button>}
              <button type="button" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="shrink-0 rounded p-0.5 text-ink-3 hover:text-ink" aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}
