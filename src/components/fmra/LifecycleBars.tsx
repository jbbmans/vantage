import { formatCents } from '../../../shared/money';
import { cn } from '@/lib/utils';

export interface Figures { commitment: number | null; obligation: number | null; delivered: number | null; paid: number | null }

const ROWS: Array<{ key: keyof Figures; label: string }> = [
  { key: 'commitment', label: 'Commitment' },
  { key: 'obligation', label: 'Obligation' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'paid', label: 'Paid' },
];

export default function LifecycleBars({ figures, travel = false, compact = false, decorative = false, className }: { figures: Figures; travel?: boolean; compact?: boolean; decorative?: boolean; className?: string }) {
  const values = ROWS.map((r) => figures[r.key]);
  const max = Math.max(1, ...values.map((v) => v ?? 0));
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
  // What each row still owes the row above it, and what that gap is called.
  const gapOf = (i: number): { cents: number; label: string } | null => {
    const v = values[i] ?? 0;
    if (travel) {
      if (i !== 3 || values[1] == null) return null;
      const gap = (values[1] ?? 0) - v;
      return gap > 0 ? { cents: gap, label: 'OTO' } : null;
    }
    if (i === 0) return null;
    const prev = values[i - 1];
    if (prev == null) return null;
    const gap = prev - v;
    return gap > 0 ? { cents: gap, label: ['', 'OCMT', 'UDOU', 'DOU'][i] } : null;
  };
  const summary = ROWS.map((r, i) => `${r.label} ${values[i] == null ? 'not shown' : formatCents(values[i]!)}`).join(', ');

  if (decorative) {
    return (
      <div className={cn('space-y-2.5', className)} aria-hidden>
        {ROWS.map((row, i) => {
          const v = values[i] ?? 0;
          const gap = gapOf(i);
          return (
            <div key={row.key} className="relative h-3.5 w-full overflow-hidden rounded-[5px] bg-surface-2">
              <div className="absolute inset-y-0 left-0 rounded-[5px] bg-accent/45" style={{ width: pct(v) }} />
              {gap && <div className="absolute inset-y-0 rounded-r-[5px] border border-warn/40 [background-image:repeating-linear-gradient(135deg,rgb(var(--warn)/.25)_0_3px,transparent_3px_7px)]" style={{ left: `calc(${pct(v)} + 2px)`, width: `calc(${pct(gap.cents)} - 2px)` }} />}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <figure className={cn('min-w-0', className)} aria-label={`Lifecycle figures: ${summary}`}>
      <div className={cn('space-y-2.5', compact && 'space-y-1.5')} aria-hidden>
        {ROWS.map((row, i) => {
          const v = values[i];
          const gap = gapOf(i);
          const reach = travel && i === 3 ? values[1] : i > 0 ? values[i - 1] : null;
          return (
            <div key={row.key} className="grid grid-cols-[5.5rem_minmax(0,1fr)_6.5rem] items-center gap-3">
              <span className={cn('text-xs font-medium', travel && row.key === 'commitment' ? 'text-ink-3' : 'text-ink-2')}>{row.label}</span>
              <div className={cn('relative w-full overflow-hidden rounded-[5px] bg-surface-2', compact ? 'h-2.5' : 'h-3.5')} title={`${row.label}: ${v == null ? 'not shown' : formatCents(v)}${gap ? ` · ${gap.label} ${formatCents(gap.cents)} open` : ''}`}>
                {v == null ? (
                  <div className="absolute inset-0 rounded-[5px] border border-dashed border-line-strong" />
                ) : (
                  <div className="absolute inset-y-0 left-0 rounded-[5px] bg-accent transition-[width] duration-700 [transition-timing-function:var(--ease-spring)]" style={{ width: pct(v) }} />
                )}
                {gap && reach != null && (
                  <div
                    className="absolute inset-y-0 rounded-r-[5px] border border-warn/60 [background-image:repeating-linear-gradient(135deg,rgb(var(--warn)/.35)_0_3px,transparent_3px_7px)]"
                    style={{ left: `calc(${pct(v ?? 0)} + 2px)`, width: `calc(${pct(gap.cents)} - 2px)` }}
                  />
                )}
              </div>
              <span className="text-right">
                <span className={cn('fig block text-sm font-medium', v == null ? 'text-ink-3' : 'text-ink')}>{v == null ? 'Not shown' : formatCents(v)}</span>
                {gap && !compact && <span className="fig block text-2xs font-medium text-warn">{gap.label} {formatCents(gap.cents)} open</span>}
              </span>
            </div>
          );
        })}
      </div>
      <table className="sr-only">
        <caption>Lifecycle figures</caption>
        <thead><tr><th>Phase</th><th>Amount</th><th>Open from the phase before</th></tr></thead>
        <tbody>
          {ROWS.map((r, i) => { const g = gapOf(i); return <tr key={r.key}><td>{r.label}</td><td>{values[i] == null ? 'Not shown' : formatCents(values[i]!)}</td><td>{g ? `${g.label} ${formatCents(g.cents)}` : '—'}</td></tr>; })}
        </tbody>
      </table>
    </figure>
  );
}
