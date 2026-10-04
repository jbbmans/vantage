import React, { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, PageHeader, Select, type Tone } from '@/components/ui/primitives';
import { PERIOD_OPTIONS, formatDate, formatDollars } from '../../shared/metrics';
import { categoryColor } from '../../shared/constants';
import { useMetrics } from '@/lib/queries';
import { humanize, cn } from '@/lib/utils';
import { daysUntil } from '../../shared/evaluation';

const STATUS_TONES: Record<string, Tone> = {
  completed: 'good', achieved: 'good', approved: 'good', presented: 'good', active: 'accent', in_progress: 'accent', submitted: 'info', recommended: 'info',
  planned: 'neutral', scheduled: 'neutral', waiting: 'warn', paused: 'warn', missed: 'bad', declined: 'bad', critical: 'bad', high: 'warn', medium: 'neutral', low: 'neutral',
};
export const StatusBadge = ({ value, className }: { value?: string | null; className?: string }) => value ? <Badge tone={STATUS_TONES[value] || 'neutral'} className={className}>{humanize(value)}</Badge> : null;

export const DateText = ({ value, pattern, fallback = 'No date' }: { value?: string | null; pattern?: string; fallback?: string }) => <span className="fig">{value ? formatDate(value, pattern) : <span className="text-ink-3">{fallback}</span>}</span>;
/** How near a due date is, in words, when it is near enough for words to help: "tomorrow", "3 days overdue". */
export function dueIn(value?: string | null, done = false): { days: number; words: string } | null {
  const days = value ? daysUntil(value) : null;
  if (done || days == null) return null;
  const words = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days > 1 && days < 7 ? `in ${days} days`
    : days === -1 ? '1 day overdue' : days < -1 && days > -100 ? `${-days} days overdue` : null;
  return words ? { days, words } : null;
}

/** "Due 07 Oct 26 · tomorrow": the date as the record states it, and how close it is. */
export function DueText({ value, done, prefix = 'Due ' }: { value?: string | null; done?: boolean; prefix?: string }) {
  if (!value) return null;
  const near = dueIn(value, done);
  return (
    <span title={formatDate(value, 'EEEE d MMMM yyyy')}>
      {prefix}<DateText value={value} />{near && <span className={cn('ml-1', near.days < 0 ? 'font-medium' : near.days <= 1 ? 'font-medium text-warn' : 'text-ink-3')}>· {near.words}</span>}
    </span>
  );
}

export const Money = ({ value }: { value?: number | null }) => <span className="fig">{value == null ? '' : formatDollars(value)}</span>;
export const CategoryDot = ({ category }: { category?: string | null }) => { const cfg = useMetrics(); return <span className="badge-dot" style={{ backgroundColor: categoryColor(category, cfg) }} aria-hidden />; };

export function PeriodSelect({ value, onChange, className, includeAll = true }: { value: string; onChange: (v: string) => void; className?: string; includeAll?: boolean }) {
  return <Select aria-label="Period" className={className} value={value} onValueChange={onChange} options={PERIOD_OPTIONS.filter((p) => includeAll || p.value !== 'all').map((p) => ({ value: p.value, label: p.label }))} />;
}

export function PageShell({ embedded, eyebrow, title, lede, actions, children }: { embedded?: boolean; eyebrow?: string; title: React.ReactNode; lede?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode }) {
  if (embedded) {
    return (
      <>
        {/* Inside a tab the tab already names the section, so the heading is for screen readers and the line says what is in it. */}
        <div className="-mt-1 mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="sr-only">{title}</h2>
          <p className="min-w-0 text-sm text-ink-2">{lede}</p>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {children}
      </>
    );
  }
  return <div className="page"><PageHeader eyebrow={eyebrow} title={title} lede={lede}>{actions}</PageHeader>{children}</div>;
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
    <div className={className ? className : 'scroll-x'}>
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        <thead><tr className="border-b border-line-strong bg-surface-2/60 text-left [&>th]:px-2.5 [&>th]:py-1.5 [&>th]:table-head">{head}</tr></thead>
        <tbody className="[&>tr]:row [&>tr>td]:px-2.5 [&>tr>td]:py-1.5 [&>tr>td]:align-top">{children}</tbody>
      </table>
    </div>
  );
}

export function DescriptionList({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="hairline-grid grid grid-cols-1 border border-line sm:grid-cols-2">
      {items.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => <div key={k} className="min-w-0 px-2.5 py-2"><dt className="eyebrow">{k}</dt><dd className="mt-1 break-words text-sm text-ink">{v}</dd></div>)}
    </dl>
  );
}

export const onText = (set: (k: any, v: unknown) => void, k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k, e.target.value);
