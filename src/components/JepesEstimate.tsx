import { ExternalLink } from 'lucide-react';
import { Progress } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { formatFigure, openReason, totalArithmetic, type JepesEstimate, type Range } from '../../shared/jepesEstimate';

/** The JEPES estimate as the worksheet works it (ADR-0046): the total, each pillar's points and the reason for each line. */

const fmt = formatFigure;
export const showRange = (r: Range) => (r.low === r.high ? fmt(r.low) : `${fmt(r.low)} to ${fmt(r.high)}`);

/** How the estimate reads in a sentence, for a summary line or a live region. */
export function totalText(est: JepesEstimate): string {
  return est.exact ? `${fmt(est.total.low)} of ${fmt(est.max)}` : `${fmt(est.total.low)} to ${fmt(est.total.high)} of ${fmt(est.max)}`;
}

export function EstimateTotal({ est, className }: { est: JepesEstimate; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-2', className)}>
      <span className="fig text-3xl font-semibold text-ink">{showRange(est.total)}</span>
      <span className="text-sm text-ink-3">of {fmt(est.max)}</span>
      {!est.exact && <span className="text-xs text-warn">a range until {openReason(est)}</span>}
    </div>
  );
}

/** Each pillar's points, open to its lines: what was entered, what the table gives it, and where the table is. */
export function EstimateBreakdown({ est, open = false }: { est: JepesEstimate; open?: boolean }) {
  return (
    <div className="space-y-2">
      {est.pillars.map((p) => (
        <details key={p.key} className="group rounded-lg border border-line" open={open}>
          <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">{p.label}</span>
              <Progress value={p.points.low} max={p.max} className="mt-1.5" label={`${p.label}: ${showRange(p.points)} of ${p.max}`} tone={p.points.low === p.points.high ? 'accent' : 'warn'} />
            </span>
            <span className="fig shrink-0 text-right text-sm text-ink">{showRange(p.points)}<span className="text-ink-3"> / {p.max}</span></span>
          </summary>
          <div className="border-t border-line px-3 py-2.5">
            {p.lines.length ? (
              <ul className="space-y-2">{p.lines.map((l) => (
                <li key={l.key} className="text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-ink-2"><span className="fig mr-1.5 text-2xs text-ink-3">{l.line}</span>{l.label}</span>
                    <span className="fig shrink-0 text-xs"><span className={l.entered ? 'text-ink-2' : 'text-ink-3'}>{l.shown ?? 'Not entered'}</span><span className="text-ink-3"> · </span><span className={l.entered ? 'text-ink' : 'text-warn'}>{showRange(l.value)}</span></span>
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{l.reason} <a className="link inline-flex items-center gap-0.5" href={l.cite.url} target="_blank" rel="noopener noreferrer">{l.cite.source}, {l.cite.where}<ExternalLink className="h-3 w-3" aria-hidden /></a></p>
                </li>
              ))}</ul>
            ) : <p className="text-xs text-ink-3">Nothing on this line yet.</p>}
            <p className="fig mt-2 text-xs text-ink-2">{p.arithmetic}</p>
          </div>
        </details>
      ))}
      <p className="fig text-xs text-ink-2">{totalArithmetic(est)}</p>
    </div>
  );
}

/** The table versions the estimate read, each with its effective date, its source and any reading it applies. */
export function EstimateSources({ est }: { est: JepesEstimate }) {
  return (
    <details className="rounded-lg border border-line px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-ink-2">The tables this estimate reads, as in force on {est.on}</summary>
      <ul className="mt-2 space-y-2">{est.versions.map((v) => (
        <li key={v.id} className="text-xs text-ink-2">
          <span className="font-medium text-ink">{v.table}</span> <span className="fig text-ink-3">({v.id}, from {v.effective_from})</span>
          <span className="block">{v.cites.map((c, i) => <span key={`${c.source}-${i}`}>{i > 0 && '; '}<a className="link" href={c.url} target="_blank" rel="noopener noreferrer">{c.source}</a>, {c.where}</span>)}</span>
          {v.notes.map((n) => <span key={n} className="block text-ink-3">{n}</span>)}
        </li>
      ))}</ul>
    </details>
  );
}
