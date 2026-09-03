import React, { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Select, type Tone } from '@/components/ui/primitives';
import { PERIOD_OPTIONS, formatDate, formatDollars, formatNumber } from '../../shared/metrics';
import { CATEGORY_COLORS, type Category } from '../../shared/constants';
import { humanize } from '@/lib/utils';

const STATUS_TONES: Record<string, Tone> = {
  completed: 'good', achieved: 'good', approved: 'good', presented: 'good', active: 'accent', in_progress: 'accent', submitted: 'info', recommended: 'info',
  planned: 'neutral', scheduled: 'neutral', waiting: 'warn', paused: 'warn', missed: 'bad', declined: 'bad', critical: 'bad', high: 'warn', medium: 'neutral', low: 'neutral',
};
export const StatusBadge = ({ value, className }: { value?: string | null; className?: string }) => value ? <Badge tone={STATUS_TONES[value] || 'neutral'} className={className}>{humanize(value)}</Badge> : null;

export const DateText = ({ value, pattern, fallback = 'No date' }: { value?: string | null; pattern?: string; fallback?: string }) => <span className="fig">{value ? formatDate(value, pattern) : <span className="text-ink-3">{fallback}</span>}</span>;
export const Money = ({ value }: { value?: number | null }) => <span className="fig">{value == null ? '' : formatDollars(value)}</span>;
export const Num = ({ value }: { value?: number | null }) => <span className="fig">{value == null ? '' : formatNumber(value)}</span>;
export const CategoryDot = ({ category }: { category?: string | null }) => <span className="badge-dot" style={{ backgroundColor: CATEGORY_COLORS[(category || 'Other') as Category] || CATEGORY_COLORS.Other }} aria-hidden />;

export function PeriodSelect({ value, onChange, className, includeAll = true }: { value: string; onChange: (v: string) => void; className?: string; includeAll?: boolean }) {
  return <Select aria-label="Period" className={className} value={value} onValueChange={onChange} options={PERIOD_OPTIONS.filter((p) => includeAll || p.value !== 'all').map((p) => ({ value: p.value, label: p.label }))} />;
}

/** URL-synced string state (e.g. active tab), without history spam. */
export function useParam(name: string, fallback = ''): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(name) ?? fallback;
  const set = useCallback((v: string) => {
    setParams((p) => { const n = new URLSearchParams(p); if (!v || v === fallback) n.delete(name); else n.set(name, v); return n; }, { replace: true });
  }, [name, fallback, setParams]);
  return [value, set];
}

export function Table({ head, children, className, minWidth = 640 }: { head: React.ReactNode; children: React.ReactNode; className?: string; minWidth?: number }) {
  return (
    <div className={className ? className : 'overflow-x-auto'}>
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        <thead><tr className="border-b border-line text-left [&>th]:px-3 [&>th]:py-2 [&>th]:table-head">{head}</tr></thead>
        <tbody className="[&>tr]:row [&>tr>td]:px-3 [&>tr>td]:py-2 [&>tr>td]:align-top">{children}</tbody>
      </table>
    </div>
  );
}

export function DescriptionList({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {items.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => <div key={k} className="min-w-0"><dt className="eyebrow">{k}</dt><dd className="mt-0.5 break-words text-sm text-ink">{v}</dd></div>)}
    </dl>
  );
}

export const toNum = (v: unknown): number | null => { if (v == null || v === '') return null; const n = Number(String(v).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : null; };
export const onText = (set: (k: any, v: unknown) => void, k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, e.target.value);
