import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { readPeriod, readWindow, writePeriod, writeWindow, type PeriodSelection, type PeriodState, type WindowKeys, type WindowSelection, type WindowState } from './periodParams.ts';

/**
 * A page's period in its address, read and written as one (ADR-0038). Choosing writes `period`, `from` and `to` in a
 * single change, where two useParam setters in a row would each start from the same address and keep only the last.
 * `fallback` is what the page shows with no period in its address: a saved preference, a unit's default or its own.
 * With `presetsInUrl: false` a preset is never written (the page keeps it in preferences); custom dates always are.
 */
export function usePeriodParam(fallback: string, { presetsInUrl = true }: { presetsInUrl?: boolean } = {}): PeriodState & { set: (next: PeriodSelection) => void } {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => readPeriod(params, fallback), [params, fallback]);
  const set = useCallback((next: PeriodSelection) => {
    setParams((p) => writePeriod(p, next, presetsInUrl ? fallback : next.period), { replace: true });
  }, [setParams, fallback, presetsInUrl]);
  return { ...state, set };
}

/**
 * A page's window in its address (ADR-0039): a preset under the page's own key, or custom dates, read and written as one
 * change. `keys` is one of the constants in windows.ts, so the window is read again only when the address changes.
 */
export function useWindowParam(keys: WindowKeys): WindowState & { set: (next: WindowSelection) => void } {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => readWindow(params, keys), [params, keys]);
  const set = useCallback((next: WindowSelection) => {
    setParams((p) => writeWindow(p, next, keys), { replace: true });
  }, [setParams, keys]);
  return { ...state, set };
}
