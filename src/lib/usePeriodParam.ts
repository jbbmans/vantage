import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { readPeriod, writePeriod, type PeriodSelection, type PeriodState } from './periodParams.ts';

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
