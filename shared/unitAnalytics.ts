/**
 * Unit analytics (Task 21, ADR-0028): the figures a unit's analytics show, and the records behind each one.
 *
 * A section reads its source records once. Each record says which bar of which visual it counts in, under which series,
 * and with what value: its memberships. A figure is the sum of the memberships in its bar; a drill is the same
 * memberships filtered to that bar. Both come from one list, so a drill always lists exactly the records its figure
 * counts, and their values add up to it.
 *
 * Pure: the server builds the records, the browser draws the figures. Nothing here reads a database or a clock.
 */

import { formatDollars, formatDollarsExact, formatNumber } from './metrics.ts';

export const ANALYTICS_SECTIONS = ['work', 'duty', 'training', 'personnel'] as const;
export type AnalyticsSection = (typeof ANALYTICS_SECTIONS)[number];
export const isAnalyticsSection = (v: unknown): v is AnalyticsSection => (ANALYTICS_SECTIONS as readonly unknown[]).includes(v);

/** How a figure reads: a count, an amount of money, hours, a share, or days. */
export type FigureFormat = 'number' | 'money' | 'hours' | 'percent' | 'days';
/** The colour a series is drawn in. Status tones are kept for series that are a status (met, past due). */
export type SeriesTone = 'accent' | 'neutral' | 'good' | 'warn' | 'bad' | 'muted';

/** A bar of a fixed visual. `noun` is what one of its records is, where that differs from the visual's (a KPI of Marines among courses). */
export interface VisualKey { key: string; label: string; format?: FigureFormat; hint?: string; noun?: string }
export interface VisualSeries { key: string; label: string; tone: SeriesTone }

/**
 * One visual: the question it answers, how it is drawn, and its bars. A KPI row is one visual whose keys are its tiles; a
 * rate is one whose first key is the part done and second the rest.
 */
export interface VisualSpec {
  id: string;
  /** The operational question, shown as its heading. */
  question: string;
  kind: 'kpis' | 'bars' | 'columns' | 'rate';
  format: FigureFormat;
  /** What one record is, for counts and the drill ("case", "duty"). */
  noun: string;
  /** Bars in a fixed order (age bands, months, statuses), each shown even at zero. Otherwise bars sort by size. */
  keys?: VisualKey[];
  /** More than one series stacks a bar or pairs a column. One series when absent. */
  series?: VisualSeries[];
  /** What the figure does and does not count, in a line. */
  note?: string;
  /** False when the records behind it may not be listed to this reader: it shows counts and no drill. */
  drill?: boolean;
  /** What one bar is, as its table's first column is headed ("Open for", "Requirement"). Columns are months unless said. */
  axis?: string;
  /** The series the question is about ("Which requirements are falling behind?": past due and no record). The summary
   * names the bar with the most of them, not the largest bar. */
  lead?: string[];
  /** Each bar is a level on its day (errors open on a report), not an amount in it, so the bars are never added up. */
  level?: boolean;
}

export const ONE_SERIES: VisualSeries = { key: 'all', label: 'All', tone: 'accent' };

export interface Membership {
  visual: string;
  key: string;
  /** The bar's label, for bars that are not fixed (a Marine, a duty type). */
  label?: string;
  series?: string;
  value: number;
}

export interface SourceRecord<R> { record: R; in: Membership[] }

export interface Bucket {
  key: string;
  label: string;
  format?: FigureFormat;
  hint?: string;
  noun?: string;
  /** One value per series, in the order of the visual's series. */
  values: number[];
  /** How many records count in each series. */
  counts: number[];
  value: number;
  count: number;
}

export interface Visual extends Omit<VisualSpec, 'series' | 'keys'> {
  series: VisualSeries[];
  buckets: Bucket[];
  /** The visual's total: every bar added up. */
  value: number;
  count: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** The figures of every visual from the section's records. Bars of a fixed visual keep their order and their zeros. */
export function tally<R>(specs: readonly VisualSpec[], sources: ReadonlyArray<SourceRecord<R>>): Visual[] {
  // Each membership keeps the record it came from, so a record in two series of one bar (a case opened and closed in the
  // same month) is one record of that bar, as its drill lists it.
  const byVisual = new Map<string, Array<{ m: Membership; src: number }>>();
  sources.forEach((s, src) => {
    for (const m of s.in) {
      const list = byVisual.get(m.visual);
      if (list) list.push({ m, src }); else byVisual.set(m.visual, [{ m, src }]);
    }
  });
  return specs.map((spec) => {
    const series = spec.series?.length ? spec.series : [ONE_SERIES];
    const at = new Map(series.map((s, i) => [s.key, i]));
    const buckets = new Map<string, Bucket>();
    const blank = (key: string, label: string, extra: Partial<VisualKey> = {}): Bucket => ({
      key, label, ...(extra.format ? { format: extra.format } : {}), ...(extra.hint ? { hint: extra.hint } : {}), ...(extra.noun ? { noun: extra.noun } : {}),
      values: series.map(() => 0), counts: series.map(() => 0), value: 0, count: 0,
    });
    for (const k of spec.keys || []) buckets.set(k.key, blank(k.key, k.label, k));
    const seen = new Set<string>();
    const once = (id: string) => (seen.has(id) ? false : (seen.add(id), true));
    for (const { m, src } of byVisual.get(spec.id) || []) {
      const i = at.get(m.series ?? series[0].key);
      // A membership in a series or a fixed bar the visual does not draw is a mistake in its section, not a figure.
      if (i == null) continue;
      if (!buckets.has(m.key)) { if (spec.keys) continue; buckets.set(m.key, blank(m.key, m.label ?? m.key)); }
      const b = buckets.get(m.key)!;
      b.values[i] += m.value; b.value += m.value;
      if (once(`${src}\u0000${m.key}\u0000${i}`)) b.counts[i] += 1;
      if (once(`${src}\u0000${m.key}`)) b.count += 1;
    }
    const list = [...buckets.values()].map((b) => ({ ...b, values: b.values.map(round), value: round(b.value) }));
    if (!spec.keys) list.sort((a, b) => b.value - a.value || b.count - a.count || a.label.localeCompare(b.label));
    const { keys: _keys, series: _series, ...rest } = spec;
    return { ...rest, series, buckets: list, value: round(list.reduce((n, b) => n + b.value, 0)), count: list.reduce((n, b) => n + b.count, 0) };
  });
}

/** The records one figure counts, each with the value it adds, and their sum. */
export function drillOf<R>(sources: ReadonlyArray<SourceRecord<R>>, visual: string, key: string, series?: string | null): { records: Array<{ record: R; value: number }>; value: number } {
  const records: Array<{ record: R; value: number }> = [];
  for (const s of sources) {
    let value = 0; let hit = false;
    for (const m of s.in) {
      if (m.visual !== visual || m.key !== key) continue;
      if (series && (m.series ?? ONE_SERIES.key) !== series) continue;
      value += m.value; hit = true;
    }
    if (hit) records.push({ record: s.record, value });
  }
  // Added up before rounding, as the figure is, so the drill's total is the figure's to the cent.
  const value = round(records.reduce((n, r) => n + r.value, 0));
  return { records: records.map((r) => ({ ...r, value: round(r.value) })), value };
}

/** A visual's rate: the first bar of the total, or null when there is nothing to divide by. */
export function rateOf(v: Pick<Visual, 'buckets'>): { done: number; of: number; percent: number | null } {
  const done = v.buckets[0]?.value ?? 0;
  const of = v.buckets.reduce((n, b) => n + b.value, 0);
  return { done, of, percent: of ? Math.round((done / of) * 1000) / 10 : null };
}

// ——— Words ———

/** A figure in words: a count, dollars, hours, a share or days. */
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

const valueOf = (v: Visual, b: Bucket, i?: number) => formatFigure(i == null ? b.value : b.values[i], b.format || v.format);
const multi = (v: Visual) => v.series.length > 1;
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
  if (v.level && v.buckets.length) {
    // A level on each day is never added up: the latest, and how it moved from the first.
    const a = v.buckets[0]; const z = v.buckets.at(-1)!;
    if (a === z) return `${formatFigure(z.value, v.format)} on ${z.label}.`;
    const move = z.value === a.value ? 'the same as' : z.value < a.value ? 'down from' : 'up from';
    return `${formatFigure(z.value, v.format)} on ${z.label}, ${move} ${formatFigure(a.value, v.format)} on ${a.label}.`;
  }
  if (v.lead?.length && multi(v)) {
    // The question is about some of the series (past due, no record): name the bar with the most of them.
    const at = v.series.map((s, i) => (v.lead!.includes(s.key) ? i : -1)).filter((i) => i >= 0);
    const of = (b: Bucket) => at.reduce((n, i) => n + b.values[i], 0);
    const top = v.buckets.reduce<Bucket | null>((t, b) => (of(b) > (t ? of(t) : 0) ? b : t), null);
    const what = at.map((i) => v.series[i].label.toLowerCase()).join(' or ');
    return top ? `${top.label} has the most at ${what}: ${formatFigure(of(top), v.format)} of ${valueOf(v, top)}.` : `None at ${what}.`;
  }
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

// ——— Months ———

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Every calendar month a window touches, as keys (YYYY-MM) and labels (Mar 2026). */
export function monthKeys(from: string, to: string): VisualKey[] {
  const out: VisualKey[] = [];
  let y = Number(from.slice(0, 4)); let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4)); const endM = Number(to.slice(5, 7));
  while ((y < endY || (y === endY && m <= endM)) && out.length < 120) {
    out.push({ key: `${y}-${String(m).padStart(2, '0')}`, label: `${MONTHS[m - 1]} ${y}` });
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** The month a record counts in: the month of its first day in the window, so it counts once however long it runs. */
export const monthOf = (day: string | null | undefined, from: string) => {
  const d = day && day > from ? day : from;
  return d.slice(0, 7);
};

/** The longest window the analytics read, so a request cannot ask for a decade of months. */
export const ANALYTICS_MAX_DAYS = 731;

// ——— What crosses the wire ———

export interface AnalyticsResponse {
  unit_id: string;
  section: AnalyticsSection;
  from: string;
  to: string;
  /** The day figures that stand on a day (open now, standing) are as of. */
  as_of: string;
  /** How many units' records are read: the unit and those beneath it the reader may read. */
  units: number;
  /** The reader may see figures by Marine here. */
  detail: boolean;
  visuals: Visual[];
  notes: string[];
}

export interface DrillRecord {
  id: string;
  kind: 'case' | 'duty' | 'training' | 'marine' | 'activity';
  title: string;
  /** A second line: the duty's type and hours, the course's type, the Marine's billet. */
  detail: string | null;
  date: string | null;
  /** Whom it is about, only where the reader may see figures by Marine and the record names somebody. */
  who: string | null;
  unit: string | null;
  status: string | null;
  value: number;
  /** Where to open it, only where the reader may. */
  to: string | null;
}

export interface DrillResponse {
  unit_id: string;
  section: AnalyticsSection;
  visual: string;
  key: string;
  series: string | null;
  /** What the figure is, in words: "Open for 31 to 90 days". */
  label: string;
  format: FigureFormat;
  noun: string;
  /** How many records the figure counts, and what they add up to. */
  count: number;
  value: number;
  /** The first DRILL_LIMIT of them. */
  records: DrillRecord[];
}

export const DRILL_LIMIT = 200;
