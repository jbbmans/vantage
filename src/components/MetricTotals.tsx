import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Info } from 'lucide-react';
import { Badge, Button, EmptyState, Skeleton, Tooltip } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { DateText } from '@/components/common';
import { useMetricContributors, type MetricContributor } from '@/lib/queries';
import { formatDollars, formatNumber, formatDollarsExact } from '../../shared/metrics';
import type { MetricTotal } from '../../shared/metricEngine';
import { cn } from '@/lib/utils';

/** How a typed figure reads. Money gets the money symbol; everything else keeps its own unit word. */
export function formatMetric(total: Pick<MetricTotal, 'kind' | 'value' | 'unit'>, exact = false): string {
  if (total.kind === 'money') return exact ? formatDollarsExact(total.value) : formatDollars(total.value);
  if (total.kind === 'duration') return `${formatNumber(total.value)} hrs`;
  return formatNumber(total.value);
}

/** The unit word shown under a figure, so no number on screen is unitless. */
export function metricUnitLabel(total: Pick<MetricTotal, 'kind' | 'unit' | 'metricLabel'>): string {
  if (total.kind === 'money') return total.metricLabel;
  if (total.kind === 'duration') return 'hours logged';
  return total.unit;
}

function deltaLabel(current: number, prior: number | null): string | null {
  if (prior == null) return null;
  if (prior === 0) return current === 0 ? 'same as the period before' : 'nothing in the period before';
  const pct = Math.round(((current - prior) / Math.abs(prior)) * 100);
  if (pct === 0) return 'level with the period before';
  return `${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)}% on the period before`;
}

export interface MetricCardProps {
  total: MetricTotal;
  prior?: MetricTotal | null;
  /** Query parameters that produced the figure, so the drill-down asks for exactly the same thing. */
  params: Record<string, string | undefined>;
  tone?: 'headline' | 'tracked';
}

export function MetricCard({ total, prior, params, tone = 'headline' }: MetricCardProps) {
  const [open, setOpen] = useState(false);
  const delta = deltaLabel(total.value, prior ? prior.value : null);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          'group flex w-full flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors hover:bg-surface-2',
          tone === 'tracked' && 'border-l-2 border-l-line-strong'
        )}
      >
        <span className="flex w-full items-center justify-between gap-2">
          <span className="eyebrow truncate">{metricUnitLabel(total)}</span>
          <ArrowUpRight className="h-3 w-3 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
        </span>
        <span className={cn('fig text-2xl', tone === 'tracked' ? 'text-ink-2' : 'text-ink')}>{formatMetric(total)}</span>
        <span className="font-mono text-2xs uppercase tracking-wider text-ink-3">
          {total.outcomes} {total.outcomes === 1 ? 'outcome' : 'outcomes'}
          {delta ? ` · ${delta}` : ''}
        </span>
        {tone === 'tracked' && (
          <Badge tone="neutral" className="mt-1">Tracked on its own</Badge>
        )}
      </button>
      {open && <ContributorsDialog total={total} params={params} onClose={() => setOpen(false)} />}
    </>
  );
}

function ContributorsDialog({ total, params, onClose }: { total: MetricTotal; params: Record<string, string | undefined>; onClose: () => void }) {
  const query = useMetricContributors({ ...params, metric_id: total.metricId });
  const rows = query.data || [];
  const sum = rows.reduce((a, r) => a + r.value, 0);
  return (
    <Dialog
      open
      onOpenChange={(o) => { if (!o) onClose(); }}
      title={`What counted toward ${metricUnitLabel(total)}`}
      description={`${formatMetric(total, total.kind === 'money')} across ${total.outcomes} ${total.outcomes === 1 ? 'outcome' : 'outcomes'}, ${params.from || 'the start'} to ${params.to || 'today'}.`}
      size="lg"
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}
    >
      {query.isPending ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing counted here" description="No outcome in this period contributed to this figure." />
      ) : (
        <>
          <ul className="divide-y divide-line">
            {rows.map((r: MetricContributor) => (
              <li key={`${r.table}-${r.id}`}>
                <Link
                  to={r.table === 'activities' ? `/records/${r.id}` : '/career?tab=training'}
                  className="flex items-center gap-3 px-1 py-2.5 transition-colors hover:bg-surface-2"
                  onClick={onClose}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{r.title}</span>
                    <span className="block text-xs text-ink-3"><DateText value={r.date} /></span>
                  </span>
                  <span className="fig shrink-0 text-sm font-medium text-ink">{formatMetric({ kind: total.kind, value: r.value, unit: r.unit }, total.kind === 'money')}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-3" />
                </Link>
              </li>
            ))}
          </ul>
          {Math.abs(sum - total.value) > 0.005 && total.aggregation === 'sum' && (
            <p className="mt-3 flex items-start gap-2 text-xs text-warn">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              These rows add to {formatMetric({ kind: total.kind, value: sum, unit: total.unit }, true)}, which does not match the figure above. Report this.
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}

/** A row of typed figures. Headline metrics come first; anything the instance tracks apart is labelled as such. */
export function MetricTotalsGrid({ headline, tracked, prior, params, emptyTitle, emptyDescription, emptyAction }: {
  headline: MetricTotal[];
  tracked: MetricTotal[];
  prior: MetricTotal[];
  params: Record<string, string | undefined>;
  emptyTitle: string;
  emptyDescription?: React.ReactNode;
  emptyAction?: React.ReactNode;
}) {
  const priorFor = (metricId: string) => prior.find((p) => p.metricId === metricId) || null;
  if (!headline.length && !tracked.length) {
    return <div className="card"><EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} /></div>;
  }
  return (
    <div className="hairline-grid grid grid-cols-1 border border-line sm:grid-cols-2 xl:grid-cols-3">
      {headline.map((t) => <MetricCard key={t.metricId} total={t} prior={priorFor(t.metricId)} params={params} />)}
      {tracked.map((t) => (
        <Tooltip key={t.metricId} content="This value type is set not to count toward a headline total, so it is reported on its own.">
          <span className="block bg-surface"><MetricCard total={t} prior={priorFor(t.metricId)} params={params} tone="tracked" /></span>
        </Tooltip>
      ))}
    </div>
  );
}
