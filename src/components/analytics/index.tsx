import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Info } from 'lucide-react';
import { Button, EmptyState, Segmented, Skeleton } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { QueryFailure } from '@/components/QueryFailure';
import { cn } from '@/lib/utils';
import { formatDate, formatDollars, formatDollarsExact, formatNumber } from '../../../shared/metrics';
import { rateOf, type Bucket, type DrillRecord, type FigureFormat, type SeriesTone, type Visual, type VisualSeries } from '../../../shared/unitAnalytics';

/**
 * The analytics kit (Task 21, ADR-0028): KPI tiles, bars, columns over time and a rate, each in a frame that asks its
 * question, says what it shows in a sentence, switches to a table of the same figures, and prints with that table.
 * Every bar that counts something is a button that lists the records behind it. Drawn in HTML on the theme's tokens, so
 * it reads in both themes and every palette, prints in colour, and needs no chart library.
 */

export function formatFigure(value: number, format: FigureFormat, exact = false): string {
  if (format === 'money') return exact ? formatDollarsExact(value) : formatDollars(value);
  if (format === 'hours') return `${formatNumber(value)} h`;
  if (format === 'percent') return `${formatNumber(value)}%`;
  if (format === 'days') return `${formatNumber(value)} ${value === 1 ? 'day' : 'days'}`;
  return formatNumber(value);
}

/** A noun for a count: "1 case", "3 duties", "2 Marines". */
export function counted(n: number, noun: string): string {
  const many = /[^aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : /(s|x|ch|sh)$/.test(noun) ? `${noun}es` : `${noun}s`;
  return `${formatNumber(n)} ${n === 1 ? noun : many}`;
}

/** Series colours come from the theme: the signal colour and a neutral for data, status tones only for a status. */
const TONE: Record<SeriesTone, string> = {
  accent: 'rgb(var(--accent))', neutral: 'rgb(var(--ink-3))', good: 'rgb(var(--good))', warn: 'rgb(var(--warn))', bad: 'rgb(var(--bad))', muted: 'rgb(var(--line-strong))',
};

/** One figure to list the records of: a bar, or one series of it. */
export interface DrillTarget { visual: Visual; bucket: Bucket; series: VisualSeries | null }
export type OnDrill = (t: DrillTarget) => void;

const valueOf = (v: Visual, b: Bucket, i?: number) => formatFigure(i == null ? b.value : b.values[i], b.format || v.format);
const drillable = (v: Visual, onDrill: OnDrill | undefined, count: number): onDrill is OnDrill => Boolean(onDrill) && v.drill !== false && count > 0;
const multi = (v: Visual) => v.series.length > 1;
const parts = (v: Visual, b: Bucket) => v.series.map((s, i) => `${s.label} ${valueOf(v, b, i)}`).join(', ');
const showRecords = (v: Visual, n: number, b?: Bucket) => `Show the ${counted(n, b?.noun || v.noun)}`;
const largest = (v: Visual) => v.buckets.reduce<Bucket | null>((top, b) => (!top || b.value > top.value ? b : top), null);

/** The figure in one sentence, so a reader who does not look at the chart still has its point. */
export function summaryOf(v: Visual): string {
  if (v.kind === 'kpis') return '';
  if (v.kind === 'rate') {
    const r = rateOf(v);
    if (r.percent == null) return 'Nothing to count yet.';
    return `${r.percent}%: ${formatNumber(r.done)} of ${counted(r.of, v.noun)} ${(v.buckets[0]?.label || '').toLowerCase()}.`.replace(/ \.$/, '.');
  }
  if (!v.count) return 'Nothing to show in this window.';
  if (v.kind === 'columns') {
    const first = v.buckets[0]?.label; const last = v.buckets.at(-1)?.label;
    const span = first && last && first !== last ? `from ${first} to ${last}` : first ? `in ${first}` : '';
    if (multi(v)) return `${v.series.map((s, i) => `${s.label} ${formatFigure(v.buckets.reduce((n, b) => n + b.values[i], 0), v.format)}`).join(', ')}, ${span}.`;
    const top = largest(v)!;
    return `${formatFigure(v.value, v.format)} ${span}; the most was ${top.label}, at ${formatFigure(top.value, v.format)}.`;
  }
  const top = largest(v)!;
  return `${top.label} is the largest, at ${valueOf(v, top)} of ${formatFigure(v.value, v.format)}.`;
}

/**
 * A chart in its frame. The question is its heading; the switch shows the same figures as a table, and a print carries
 * both. `empty` stands in for the chart and the table when there is nothing to draw.
 */
export function FigureFrame({ question, summary, note, chart, table, empty, actions, className }: {
  question: string; summary?: ReactNode; note?: ReactNode; chart: ReactNode; table?: ReactNode; empty?: ReactNode; actions?: ReactNode; className?: string;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const id = useId();
  return (
    <figure className={cn('chart-frame card m-0 min-w-0', className)} aria-labelledby={`${id}-q`}>
      <figcaption className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-4 pt-3.5 sm:px-5">
        <span className="min-w-0 flex-1">
          <span id={`${id}-q`} role="heading" aria-level={3} className="block text-md font-semibold tracking-[-0.012em] text-ink">{question}</span>
          {summary ? <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{summary}</span> : null}
        </span>
        {(actions || (table && !empty)) ? (
          <span className="no-print flex shrink-0 items-center gap-2">
            {actions}
            {table && !empty ? <Segmented size="sm" label="Show as" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} /> : null}
          </span>
        ) : null}
      </figcaption>
      <div className="px-4 pb-4 pt-3 sm:px-5">
        {empty ?? (
          <>
            <div className={cn(view === 'table' && 'chart-off')}>{chart}</div>
            {table ? <div className={cn('chart-table', view === 'chart' && 'chart-off')}>{table}</div> : null}
          </>
        )}
        {note ? <p className="mt-3 text-xs leading-relaxed text-ink-3">{note}</p> : null}
      </div>
    </figure>
  );
}

function Legend({ series }: { series: VisualSeries[] }) {
  return (
    <ul className="mb-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-hidden>
      {series.map((s) => <li key={s.key} className="flex items-center gap-1.5"><span className="chart-swatch" style={{ background: TONE[s.tone] }} />{s.label}</li>)}
    </ul>
  );
}

/** Bars across: a distribution, an age band, a standing. Stacked when the visual has more than one series. */
export function BarChart({ visual, onDrill, limit = 10 }: { visual: Visual; onDrill?: OnDrill; limit?: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? visual.buckets : visual.buckets.slice(0, limit);
  const max = Math.max(0, ...visual.buckets.map((b) => Math.abs(b.value))) || 1;
  return (
    <div className="min-w-0">
      {multi(visual) && <Legend series={visual.series} />}
      <ul className="space-y-1">
        {shown.map((b) => {
          const row = (
            <>
              <span className="chart-bar-label" title={b.label}>{b.label}{b.hint ? <span className="block truncate text-xs text-ink-3">{b.hint}</span> : null}</span>
              <span className="chart-bar-track" aria-hidden>
                {visual.series.map((s, i) => b.values[i] ? <span key={s.key} className="chart-ink block h-full" style={{ width: `${(Math.abs(b.values[i]) / max) * 100}%`, background: TONE[s.tone] }} /> : null)}
              </span>
              <span className="fig chart-bar-value">{valueOf(visual, b)}</span>
            </>
          );
          const label = `${b.label}: ${valueOf(visual, b)}${multi(visual) ? ` (${parts(visual, b)})` : ''}${b.hint ? `, ${b.hint}` : ''}`;
          return (
            <li key={b.key}>
              {drillable(visual, onDrill, b.count)
                ? <button type="button" className="chart-bar-row chart-hit" aria-label={`${label}. ${showRecords(visual, b.count, b)}`} onClick={() => onDrill({ visual, bucket: b, series: null })}>{row}</button>
                : <div className="chart-bar-row" role="img" aria-label={label}>{row}</div>}
            </li>
          );
        })}
      </ul>
      {visual.buckets.length > limit && (
        <button type="button" className="link no-print mt-2 text-xs" aria-expanded={all} onClick={() => setAll(!all)}>{all ? 'Show fewer' : `Show all ${visual.buckets.length}`}</button>
      )}
    </div>
  );
}

/** Columns up: a figure over time. Paired when the visual has more than one series (opened and closed). */
export function ColumnChart({ visual, onDrill, height = 148 }: { visual: Visual; onDrill?: OnDrill; height?: number }) {
  const max = Math.max(0, ...visual.buckets.flatMap((b) => b.values.map(Math.abs))) || 1;
  const n = visual.buckets.length;
  const step = n <= 7 ? 1 : Math.ceil(n / 6);
  const labelled = (i: number) => i === n - 1 || (i % step === 0 && n - 1 - i >= step / 2);
  const values = n <= (multi(visual) ? 4 : 8);
  return (
    <div className="min-w-0">
      {multi(visual) && <Legend series={visual.series} />}
      <div className="chart-plot" style={{ height }}>
        {visual.buckets.map((b) => (
          <div key={b.key} className="chart-col-group">
            {visual.series.map((s, i) => {
              const v = b.values[i];
              const label = `${b.label}${multi(visual) ? `, ${s.label}` : ''}: ${valueOf(visual, b, i)}`;
              const bar = (
                <span className="chart-ink chart-col" aria-hidden style={{ height: v ? `${Math.max(2, (Math.abs(v) / max) * 100)}%` : 0, background: TONE[s.tone] }}>
                  {values && v ? <span className="chart-col-value fig">{valueOf(visual, b, i)}</span> : null}
                </span>
              );
              return drillable(visual, onDrill, b.counts[i])
                ? <button key={s.key} type="button" className="chart-col-slot chart-hit" title={label} aria-label={`${label}. ${showRecords(visual, b.counts[i], b)}`} onClick={() => onDrill({ visual, bucket: b, series: multi(visual) ? s : null })}>{bar}</button>
                : <span key={s.key} className="chart-col-slot" role="img" title={label} aria-label={label}>{bar}</span>;
            })}
          </div>
        ))}
      </div>
      <div className="chart-axis" aria-hidden>
        {visual.buckets.map((b, i) => <span key={b.key} className="min-w-0 flex-1 truncate text-center">{labelled(i) ? b.label : ''}</span>)}
      </div>
    </div>
  );
}

/** A share: the first bar of the visual against all of it, with each part opening its records. */
export function RateMeter({ visual, onDrill }: { visual: Visual; onDrill?: OnDrill }) {
  const r = rateOf(visual);
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="stat-value">{r.percent == null ? '—' : `${r.percent}%`}</span>
        <span className="text-sm text-ink-3">{r.of ? `${formatNumber(r.done)} of ${counted(r.of, visual.noun)}` : 'Nothing to count'}</span>
      </p>
      <div className="chart-bar-track mt-3 h-2.5" aria-hidden>{r.percent ? <span className="chart-ink block h-full" style={{ width: `${r.percent}%`, background: TONE.accent }} /> : null}</div>
      <ul className="mt-3 flex flex-wrap gap-2">
        {visual.buckets.map((b, i) => {
          const body = <><span className="chart-swatch" style={{ background: i === 0 ? TONE.accent : TONE.muted }} aria-hidden /><span>{b.label}</span><span className="fig font-semibold text-ink">{valueOf(visual, b)}</span></>;
          return (
            <li key={b.key}>
              {drillable(visual, onDrill, b.count)
                ? <button type="button" className="chart-chip chart-hit" aria-label={`${b.label}: ${valueOf(visual, b)}. ${showRecords(visual, b.count, b)}`} onClick={() => onDrill({ visual, bucket: b, series: null })}>{body}</button>
                : <span className="chart-chip">{body}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A row of headline figures, each opening the records it counts. */
export function KpiTiles({ visual, onDrill }: { visual: Visual; onDrill?: OnDrill }) {
  return (
    <div className="hairline-grid grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5">
      {visual.buckets.map((b) => {
        const body = (
          <>
            <span className="line-clamp-2 text-sm font-medium leading-snug text-ink-2">{b.label}</span>
            <span className="fig text-2xl font-semibold text-ink">{valueOf(visual, b)}</span>
            {b.hint ? <span className="line-clamp-2 text-xs text-ink-3">{b.hint}</span> : null}
          </>
        );
        return drillable(visual, onDrill, b.count)
          ? <button key={b.key} type="button" className="flex min-w-0 flex-col items-start gap-1 px-4 py-3.5 text-left transition-colors hover:bg-surface-2" aria-label={`${b.label}: ${valueOf(visual, b)}. ${showRecords(visual, b.count, b)}`} onClick={() => onDrill({ visual, bucket: b, series: null })}>{body}</button>
          : <div key={b.key} className="flex min-w-0 flex-col items-start gap-1 px-4 py-3.5">{body}</div>;
      })}
    </div>
  );
}

/** The figures of a visual as a table: the chart's alternative, and what a print carries under it. */
export function FigureTable({ visual, onDrill, first = 'Bar' }: { visual: Visual; onDrill?: OnDrill; first?: string }) {
  const cell = (b: Bucket, i: number | null) => {
    const count = i == null ? b.count : b.counts[i];
    const text = i == null ? valueOf(visual, b) : valueOf(visual, b, i);
    if (!drillable(visual, onDrill, count)) return text;
    const s = i == null ? null : visual.series[i];
    return <button type="button" className="link fig" aria-label={`${b.label}${s ? `, ${s.label}` : ''}: ${text}. ${showRecords(visual, count, b)}`} onClick={() => onDrill({ visual, bucket: b, series: s })}>{text}</button>;
  };
  return (
    <div className="scroll-x">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">{visual.question}</caption>
        <thead>
          <tr className="border-b border-line-strong text-left [&>th]:table-head [&>th]:px-2.5 [&>th]:py-1.5">
            <th scope="col">{first}</th>
            {multi(visual) ? visual.series.map((s) => <th key={s.key} scope="col" className="text-right">{s.label}</th>) : null}
            <th scope="col" className="text-right">{multi(visual) ? 'All' : 'Figure'}</th>
            <th scope="col" className="text-right">Records</th>
          </tr>
        </thead>
        <tbody className="[&>tr>td]:px-2.5 [&>tr>td]:py-1.5 [&>tr>th]:px-2.5 [&>tr>th]:py-1.5 [&>tr]:border-b [&>tr]:border-line">
          {visual.buckets.map((b) => (
            <tr key={b.key}>
              <th scope="row" className="text-left font-normal text-ink">{b.label}</th>
              {multi(visual) ? visual.series.map((s, i) => <td key={s.key} className="fig text-right">{cell(b, i)}</td>) : null}
              <td className="fig text-right font-medium">{cell(b, null)}</td>
              <td className="fig text-right text-ink-3">{formatNumber(b.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Any visual, in its frame, drawn the way its kind is. */
export function VisualView({ visual, onDrill, className, first, actions }: { visual: Visual; onDrill?: OnDrill; className?: string; first?: string; actions?: ReactNode }) {
  if (visual.kind === 'kpis') {
    return (
      <section className={cn('min-w-0', className)} aria-label={visual.question}>
        <h3 className="eyebrow mb-2">{visual.question}</h3>
        <KpiTiles visual={visual} onDrill={onDrill} />
        {visual.note ? <p className="mt-2 text-xs text-ink-3">{visual.note}</p> : null}
      </section>
    );
  }
  const chart = visual.kind === 'columns' ? <ColumnChart visual={visual} onDrill={onDrill} /> : visual.kind === 'rate' ? <RateMeter visual={visual} onDrill={onDrill} /> : <BarChart visual={visual} onDrill={onDrill} />;
  const nothing = !visual.buckets.length || (visual.kind !== 'columns' && !visual.count);
  const note = [visual.note, visual.drill === false ? 'The records behind these counts are not listed to you.' : null].filter(Boolean).join(' ');
  return (
    <FigureFrame
      className={className}
      question={visual.question}
      summary={summaryOf(visual)}
      note={note || undefined}
      chart={chart}
      table={visual.kind === 'rate' ? undefined : <FigureTable visual={visual} onDrill={onDrill} first={first} />}
      actions={actions}
      empty={nothing ? <p className="py-6 text-center text-sm text-ink-3">Nothing to show in this window.</p> : undefined}
    />
  );
}

/**
 * Puts focus back on what opened a dialog once it closes. The dialogs here open from a chart's bar, not from a dialog
 * trigger, so nothing else returns a keyboard reader to the bar they chose. A bar that is gone (the page moved on to a
 * record) is left alone.
 */
export function useReturnFocus() {
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null));
  useEffect(() => () => {
    if (!opener || opener === document.body) return;
    setTimeout(() => { if (opener.isConnected) opener.focus(); }, 0);
  }, [opener]);
}

/** The records behind one figure, in the shape every drill answers. */
export interface DrillList { count: number; value: number; format: FigureFormat; noun: string; records: DrillRecord[] }

/**
 * The records one figure counts: what each is, when, whose (where the reader may see that), and what it adds. The total
 * is checked against the figure, so a list that does not add up says so rather than passing quietly.
 */
export function DrillDialog({ title, description, queryKey, load, expected, onClose }: {
  title: string; description?: string; queryKey: readonly unknown[]; load: () => Promise<DrillList>; expected?: number; onClose: () => void;
}) {
  useReturnFocus();
  // A drill is audited, so it is read once for as long as the dialog is open and not again on focus or failure.
  const q = useQuery({ queryKey, queryFn: load, staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, retry: false });
  const d = q.data;
  const named = Boolean(d?.records.some((r) => r.who));
  const valued = Boolean(d && (d.format !== 'number' || d.records.some((r) => r.value !== 1)));
  const sum = d ? Math.round(d.records.reduce((n, r) => n + r.value, 0) * 100) / 100 : 0;
  const total = d ? `${counted(d.count, d.noun)}${valued ? ` · ${formatFigure(d.value, d.format, d.format === 'money')}` : ''}` : '';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title={title}
      description={[total, description].filter(Boolean).join(' · ') || undefined}
      footer={<Button variant="ghost" onClick={onClose}>Close</Button>}>
      {q.isPending ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        : q.isError || !d ? <QueryFailure error={q.error} what="These records" className="py-2" />
          : !d.records.length ? <EmptyState title="Nothing counted here" description="No record is behind this figure." />
            : (
              <div className="space-y-2">
                {d.count > d.records.length ? <p className="text-xs text-warn">Showing the first {formatNumber(d.records.length)} of {formatNumber(d.count)}. The report library’s file holds them all.</p> : null}
                <ul className="divide-y divide-line">
                  {d.records.map((r) => {
                    const body = (
                      <>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">{r.title}</span>
                          <span className="block truncate text-xs text-ink-3">{[r.detail, named ? r.who || 'Not named' : null, r.unit, r.status, r.date ? formatDate(r.date) : null].filter(Boolean).join(' · ')}</span>
                        </span>
                        {valued ? <span className="fig shrink-0 text-sm font-medium text-ink">{formatFigure(r.value, d.format, d.format === 'money')}</span> : null}
                        {r.to ? <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden /> : null}
                      </>
                    );
                    return (
                      <li key={`${r.kind}:${r.id}`}>
                        {r.to ? <Link to={r.to} onClick={onClose} className="flex items-center gap-3 px-1 py-2.5 transition-colors hover:bg-surface-2">{body}</Link> : <div className="flex items-center gap-3 px-1 py-2.5">{body}</div>}
                      </li>
                    );
                  })}
                </ul>
                {d.count === d.records.length && Math.abs(sum - (expected ?? d.value)) > 0.005 ? (
                  <p className="flex items-start gap-2 text-xs text-warn"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />These records add to {formatFigure(sum, d.format, true)}, which does not match the figure. Report this.</p>
                ) : null}
              </div>
            )}
    </Dialog>
  );
}

/** A visual built in the browser from figures it already holds (the personal analysis, the error reports' trend). */
export function clientVisual(v: Omit<Visual, 'value' | 'count' | 'series' | 'buckets'> & {
  series?: VisualSeries[]; buckets: Array<Omit<Bucket, 'value' | 'count' | 'counts'> & { counts?: number[] }>;
}): Visual {
  const series = v.series?.length ? v.series : [{ key: 'all', label: 'All', tone: 'accent' as const }];
  const buckets = v.buckets.map((b) => {
    const counts = b.counts ?? b.values.map((x) => (x ? 1 : 0));
    return { ...b, counts, value: b.values.reduce((n, x) => n + x, 0), count: counts.reduce((n, x) => n + x, 0) };
  });
  return { ...v, series, buckets, value: buckets.reduce((n, b) => n + b.value, 0), count: buckets.reduce((n, b) => n + b.count, 0) };
}
