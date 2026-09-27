import { useEffect, useRef, useState } from 'react';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';

export const prefersReducedMotion = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** A number that counts up to its value when it first appears, and glides when it changes. */
export function CountUp({ value, format = (n: number) => Math.round(n).toLocaleString(), duration = 700 }: { value: number; format?: (n: number) => string; duration?: number }) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));
  const from = useRef(prefersReducedMotion() ? value : 0);
  useEffect(() => {
    if (prefersReducedMotion() || !Number.isFinite(value)) { setShown(value); from.current = value; return; }
    const start = performance.now();
    const origin = from.current;
    let frame = 0;
    const tick = (at: number) => {
      const p = Math.min(1, (at - start) / duration);
      setShown(origin + (value - origin) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); from.current = value; };
  }, [value, duration]);
  return <span className="fig tabular-nums">{format(shown)}</span>;
}

/** A hairline across the top of the window while a page loads for the first time or a change is being saved. */
export function ActivityBar() {
  const fetching = useIsFetching({ predicate: (q) => q.state.data === undefined });
  const mutating = useIsMutating();
  const busy = fetching + mutating > 0;
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  useEffect(() => {
    if (busy) {
      const t = window.setTimeout(() => setState('busy'), 180);
      return () => window.clearTimeout(t);
    }
    setState((s) => (s === 'busy' ? 'done' : s));
    const t = window.setTimeout(() => setState('idle'), 560);
    return () => window.clearTimeout(t);
  }, [busy]);
  return <div className="activity-bar no-print" data-state={state} aria-hidden />;
}
