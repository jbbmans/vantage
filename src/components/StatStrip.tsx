import { Link } from 'react-router-dom';
import { Info } from 'lucide-react';
import { Tooltip } from '@/components/ui/primitives';
import { StatusDot } from '@/components/effects';
import { cn } from '@/lib/utils';

export interface StatItem {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** Where the figure opens. The whole cell is the target. */
  to?: string;
  /** Colours the figure and adds a status dot; `live` makes the dot breathe. */
  tone?: 'accent' | 'good' | 'warn' | 'bad';
  live?: boolean;
  /** What counts, in one sentence, behind an info button. */
  definition?: string;
}

const TONE_TEXT = { accent: 'text-accent', good: 'text-good', warn: 'text-warn', bad: 'text-bad' } as const;

/**
 * A row of figures that belong together, in one surface divided by hairlines, instead of a row of
 * separate boxes. `className` sets the column count per breakpoint; `inset` drops the card, for a
 * strip that already sits inside one.
 */
export function StatStrip({ items, className, label, inset = false }: { items: StatItem[]; className?: string; label?: string; inset?: boolean }) {
  return (
    <ul className={cn('cell-grid', inset ? 'cell-grid-inset' : 'card', className)} aria-label={label}>
      {items.map((it) => (
        <li key={it.label} className={cn('cell relative min-w-0', it.to && 'cell-link')}>
          <p className="flex items-center gap-2 text-sm font-medium text-ink-2">
            {it.tone && <StatusDot live={it.live} className={TONE_TEXT[it.tone]} />}
            {it.to
              ? <Link to={it.to} className="truncate after:absolute after:inset-0 after:content-['']">{it.label}</Link>
              : <span className="truncate">{it.label}</span>}
            {it.definition && (
              <Tooltip content={it.definition}>
                <button type="button" className="relative z-10 -m-1 ml-auto rounded p-1 text-ink-3 hover:text-ink" aria-label={`What counts as ${it.label.toLowerCase()}: ${it.definition}`}><Info className="h-3.5 w-3.5" /></button>
              </Tooltip>
            )}
          </p>
          <p className={cn('stat-value mt-2', it.tone && TONE_TEXT[it.tone])}>{it.value}</p>
          {it.hint && <p className="mt-1 truncate text-xs text-ink-3">{it.hint}</p>}
        </li>
      ))}
    </ul>
  );
}
