import { FITREP_METHOD, type FitrepMethod, type Occasion, type ReportType, type Third } from './fitrepMethod.ts';
import type { TableVersion } from './versioned.ts';

/**
 * Where each fitness report the Marine received stands (ADR-0047): its Fitness Report Average, its place in the
 * reporting senior's profile and its Relative Value, worked by the published method (shared/fitrepMethod.ts) from the
 * figures the Marine copies off their Master Brief Sheet. Pure, so the Marine's page and a leader's read work it alike.
 * The Master Brief Sheet is the record; these are the same sums, shown with their working.
 */

export interface FitnessReportInput {
  id?: string;
  period_from?: string | null; period_to?: string | null;
  occasion?: Occasion | string | null; report_type?: ReportType | string | null; grade?: string | null;
  rs_label?: string | null;
  /** The fourteen marks in form order, A to G, or H where not observed. */
  marks?: string | null;
  /** The RPT Avg as the MBS prints it, for a report whose marks were not entered. */
  rpt_avg?: number | null;
  rs_avg?: number | null; rs_high?: number | null;
  /** "Reports x of y" on the MBS: the profile's size when the report was processed, and now. */
  reports_at_processing?: number | null; reports_cumulative?: number | null;
  /** As printed on the MBS. */
  rv_at_processing?: number | null; cum_rv_printed?: number | null;
  shared?: number | boolean | null;
}

/** Two places, as the MBS prints them; a hair of float error never turns 87.565 into 87.56. */
export const round2 = (x: number) => Math.round(x * 100 + 1e-7) / 100;
export const fig = (x: number) => round2(x).toFixed(2);
const MINUS = '−';
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export const methodOn = (on: string): TableVersion<FitrepMethod> => FITREP_METHOD.inForce(on) ?? FITREP_METHOD.versions[0];

export interface Average { value: number; sum: number | null; observed: number | null; source: 'marks' | 'printed' }

/** The unweighted average of the observed marks: A is 1 through G at 7, and H (not observed) counts in neither the sum nor the count. */
export function averageOfMarks(marks: string | null | undefined, method: FitrepMethod = methodOn(today()).data): Average | null {
  if (!marks) return null;
  const letters = marks.toUpperCase().split('');
  let sum = 0; let observed = 0;
  for (const l of letters) {
    if (l === method.notObserved) continue;
    const v = method.marks[l as keyof FitrepMethod['marks']];
    if (v === undefined) return null;
    sum += v; observed += 1;
  }
  return observed ? { value: round2(sum / observed), sum, observed, source: 'marks' } : null;
}

export function reportAverage(r: FitnessReportInput, method: FitrepMethod): Average | null {
  const fromMarks = averageOfMarks(r.marks, method);
  if (fromMarks) return fromMarks;
  const printed = num(r.rpt_avg);
  return printed == null ? null : { value: round2(printed), sum: null, observed: null, source: 'printed' };
}

export interface Valued { value: number; raised: boolean; capped: boolean; allSame: boolean; arithmetic: string }

/**
 * The relative value of an average against an RS Avg and RS High: the line through the high at 100 and the average at
 * 90, raised to the floor. Every report in a profile whose reports share one average is valued at the average's 90.
 * Null when the figures give no line to read: an RS High below the RS Avg, or the two equal and the report below them
 * (the printed figures are rounded, so the profile's spread is too small to show).
 */
export function relativeValue(fra: number, rsAvg: number, rsHigh: number, method: FitrepMethod): Valued | null {
  const { high, average, floor } = method.scale;
  const [f, a, h] = [round2(fra), round2(rsAvg), round2(rsHigh)];
  if (h < a) return null;
  if (h === a) {
    if (f === a) return { value: average, raised: false, capped: false, allSame: true, arithmetic: `RS High equals RS Avg (${fig(a)}): every report in the profile is valued ${average}` };
    if (f > h) return { value: high, raised: false, capped: true, allSame: false, arithmetic: `${fig(f)} is above the RS High (${fig(h)}), so ${high}` };
    return null;
  }
  const line = average + ((high - average) * (f - a)) / (h - a);
  const value = round2(Math.min(high, Math.max(floor, line)));
  const sign = f >= a ? '+' : MINUS;
  const working = `${average} ${sign} ${high - average} × ${fig(Math.abs(f - a))} ÷ ${fig(h - a)} = ${fig(line)}`;
  const arithmetic = line < floor ? `${working}, raised to ${floor}` : line > high ? `${working}, above the RS High, so ${high}` : working;
  return { value, raised: line < floor, capped: line > high, allSame: false, arithmetic };
}

export function thirdOf(rv: number, method: FitrepMethod): Third {
  const v = round2(rv);
  return (method.thirds.find((t) => v >= t.from && v <= t.to) ?? method.thirds[method.thirds.length - 1]).key;
}
export const thirdLabel = (t: Third, method: FitrepMethod) => method.thirds.find((x) => x.key === t)!.label;

/** Why a report has no relative value, or null when it can have one. */
export function noValueReason(r: FitnessReportInput, method: FitrepMethod, profileSize: number | null): string | null {
  if (r.occasion && (method.noValue.occasions as readonly string[]).includes(String(r.occasion))) return 'An end of service (EN) report is not added to the RS profile and has no relative value.';
  if (r.report_type && (method.noValue.types as readonly string[]).includes(String(r.report_type))) {
    const kind = r.report_type === 'not_observed' ? 'A not-observed' : r.report_type === 'extended' ? 'An extended' : 'An academic';
    return `${kind} report is not marked against the RS profile and has no relative value.`;
  }
  if (profileSize != null && profileSize < method.minimumProfile) {
    return `The RS profile holds ${profileSize} ${profileSize === 1 ? 'report' : 'reports'} on the grade. A report has a relative value once the RS has written ${method.minimumProfile}.`;
  }
  return null;
}

export interface ReportStanding {
  id?: string;
  average: Average | null;
  /** The cumulative relative value, worked from the RS Avg and RS High now on the MBS. */
  rv: Valued | null;
  third: Third | null;
  /** Why there is no relative value, or what is missing to work one. */
  reason: string | null;
  position: { fromAvg: number; fromHigh: number; text: string } | null;
  /** As printed on the MBS. The value at processing is fixed when the report is processed and never worked again. */
  atProcessing: { value: number | null; reason: string | null };
  /** Where the MBS's printed cumulative value and the working differ by more than the last place. */
  check: string | null;
  notes: string[];
}

const away = (d: number, what: string, value: number) => (Math.abs(d) < 0.005 ? `at the ${what} (${fig(value)})` : `${fig(Math.abs(d))} ${d > 0 ? 'above' : 'below'} the ${what} (${fig(value)})`);

export function standingOf(r: FitnessReportInput, method: FitrepMethod = methodOn(today()).data): ReportStanding {
  const average = reportAverage(r, method);
  const notes: string[] = [];
  const printedAvg = num(r.rpt_avg);
  if (average?.source === 'marks' && printedAvg != null && round2(printedAvg) !== average.value) notes.push(`The marks average ${fig(average.value)}; the RPT Avg entered is ${fig(printedAvg)}. The marks are used.`);
  const rsAvg = num(r.rs_avg); const rsHigh = num(r.rs_high);
  const size = num(r.reports_cumulative);
  const procSize = num(r.reports_at_processing);
  const printedProc = num(r.rv_at_processing);
  // The profile at processing held no more reports than it does now, so a profile under the minimum now was under it then.
  const atProcessing = { value: printedProc, reason: noValueReason(r, method, procSize ?? size) };
  if (atProcessing.reason) atProcessing.value = null;
  const base: ReportStanding = { id: r.id, average, rv: null, third: null, reason: null, position: null, atProcessing, check: null, notes };

  const excluded = noValueReason({ ...r }, method, null);
  if (excluded) return { ...base, reason: excluded };
  if (!average) return { ...base, reason: 'Enter the marks, or the RPT Avg from your MBS, to work this report.' };
  if (rsAvg == null || rsHigh == null) return { ...base, reason: 'Enter the RS Avg and RS High from your MBS to place this report in the profile.' };
  if (size == null) return { ...base, reason: 'Enter how many reports the RS profile holds now (the second number under Reports on your MBS).' };
  const small = noValueReason(r, method, size);
  const position = { fromAvg: round2(average.value - rsAvg), fromHigh: round2(average.value - rsHigh), text: `${away(average.value - rsAvg, 'RS Avg', rsAvg)} and ${away(average.value - rsHigh, 'RS High', rsHigh)}` };
  if (small) return { ...base, position, reason: small };
  if (round2(rsHigh) < round2(rsAvg)) return { ...base, position, reason: 'The RS High entered is below the RS Avg. Check both against your MBS.' };
  const rv = relativeValue(average.value, rsAvg, rsHigh, method);
  if (!rv) return { ...base, position, reason: `The RS Avg and RS High entered are both ${fig(rsAvg)} and this report’s average is below them. The MBS rounds both to two places, so the spread of the profile is too small to work a value from. Your MBS prints the value.` };
  if (rv.capped) notes.push('This report’s average is above the RS High entered, which the profile’s high cannot be. Check the figures against your MBS.');
  const printedCum = num(r.cum_rv_printed);
  // In whole hundredths, as both are printed: one hundredth apart is the last place, more is a different figure.
  const check = printedCum != null && Math.abs(Math.round(printedCum * 100 + 1e-7) - Math.round(rv.value * 100 + 1e-7)) > 1
    ? `Your MBS prints ${fig(printedCum)}; these figures work to ${fig(rv.value)}. The MBS is the record: check the RS Avg and RS High you copied.`
    : null;
  return { ...base, position, rv, third: thirdOf(rv.value, method), check };
}

export interface StandingSummary { counts: Record<Third | 'none', number>; reports: number }

/** The MBS's own summary: how many reports sit in each third, and how many have no relative value. */
export function summarize(standings: ReportStanding[]): StandingSummary {
  const counts: StandingSummary['counts'] = { upper: 0, middle: 0, lower: 0, none: 0 };
  for (const s of standings) counts[s.third ?? 'none'] += 1;
  return { counts, reports: standings.length };
}

/** Reports that share a reporting senior and a grade, as the Marine names the RS: one RS profile. */
export const profileKey = (r: FitnessReportInput) => (r.rs_label && r.grade ? `${r.rs_label.trim().toLowerCase().replace(/\s+/g, ' ')}|${r.grade}` : null);

export interface ProjectionInput {
  rsAvg: number; rsHigh: number; reports: number;
  /** The coming report's average, or its marks. */
  fra?: number | null; marks?: string | null;
  /** Marks the RS is expected to observe, for the totals the targets need: 14 unless one is not observed. */
  observed?: number | null;
  /** The Marine's earlier reports in this profile, to show where each moves. */
  earlier?: FitnessReportInput[];
}

/**
 * What the coming report needs for one value: `needs` the lowest average that reaches it, `reached` when the report as
 * entered already does, `out_of_reach` when no average does, and `no_value` when the profile with the report in it is
 * still under the minimum, so no average gives it a value yet.
 */
export interface Target { key: 'middle' | 'average' | 'upper' | 'high'; label: string; rv: number; fra: number | null; total: number | null; reach: 'reached' | 'out_of_reach' | 'needs' | 'no_value' }

export interface Projection {
  fra: number | null;
  profile: { before: { avg: number; high: number; reports: number }; after: { avg: number; high: number; reports: number } | null };
  /** The coming report's value when it is processed, the report counted in its own profile. */
  rv: Valued | null;
  third: Third | null;
  reason: string | null;
  /** Each earlier report's cumulative value now and after; `beforeUnworked` when the figures now give no line to read it from. */
  earlier: Array<{ id?: string; before: number | null; after: number | null; beforeUnworked: boolean }>;
  targets: Target[];
  observed: number;
}

/** The profile with one more report in it, at the average given, as the MBS would print it. */
function grown(avg: number, high: number, reports: number, fra: number) {
  return { avg: round2((avg * reports + fra) / (reports + 1)), high: round2(Math.max(high, fra)), reports: reports + 1 };
}

/**
 * The coming report against an RS profile: what it would be valued when processed, where the Marine's earlier reports
 * in that profile would move, and the lowest average that reaches each third, the RS Avg and the RS High. Never saved.
 */
export function project(input: ProjectionInput, method: FitrepMethod = methodOn(today()).data): Projection {
  const avg = round2(input.rsAvg); const high = round2(input.rsHigh); const reports = Math.max(0, Math.floor(input.reports));
  const fromMarks = averageOfMarks(input.marks, method);
  const fra = fromMarks ? fromMarks.value : input.fra == null ? null : round2(input.fra);
  const given = input.observed != null && Number.isInteger(input.observed) && input.observed >= 1 && input.observed <= method.attributes ? input.observed : null;
  const observed = fromMarks?.observed ?? given ?? method.attributes;
  const before = { avg, high, reports };
  const valueIn = (f: number) => {
    const g = grown(avg, high, reports, f);
    return g.reports < method.minimumProfile ? null : relativeValue(f, g.avg, g.high, method);
  };
  const after = fra == null ? null : grown(avg, high, reports, fra);
  const tooFew = (n: number) => `With this report the RS will have written ${n} on the grade. A report has a relative value once the RS has written ${method.minimumProfile}.`;
  const rv = fra == null ? null : valueIn(fra);
  const reason = fra == null ? 'Enter the average you expect, or the marks, to see where the coming report would sit.'
    : after && after.reports < method.minimumProfile ? tooFew(after.reports)
      // A profile whose RS Avg and RS High would print the same, with this report below them: no line to read.
      : !rv && after ? `With this report the profile would read RS Avg ${fig(after.avg)} and RS High ${fig(after.high)}, and this report is below them. The MBS rounds both to two places, so the profile’s spread is too small to work a value from.`
        : null;

  const earlier = (input.earlier || []).map((r) => {
    const a = reportAverage(r, method)?.value;
    const valued = (p: { avg: number; high: number; reports: number } | null) => (a == null || !p || p.reports < method.minimumProfile || noValueReason(r, method, null) ? undefined : relativeValue(a, p.avg, p.high, method));
    const now = valued(before);
    return { id: r.id, before: now?.value ?? null, after: valued(after)?.value ?? null, beforeUnworked: now === null };
  });

  // The lowest average the RS could give, in steps of one mark over the attributes observed, that reaches each value.
  const steps: number[] = [];
  for (let total = observed; total <= observed * 7; total += 1) steps.push(total);
  const wanted: Array<Omit<Target, 'fra' | 'total' | 'reach'>> = [
    { key: 'middle', label: `the middle third (${fig(method.thirds.find((t) => t.key === 'middle')!.from)})`, rv: method.thirds.find((t) => t.key === 'middle')!.from },
    { key: 'average', label: `${method.scale.average}, the RS Avg`, rv: method.scale.average },
    { key: 'upper', label: `the upper third (${fig(method.thirds.find((t) => t.key === 'upper')!.from)})`, rv: method.thirds.find((t) => t.key === 'upper')!.from },
    { key: 'high', label: `${method.scale.high}, the RS High`, rv: method.scale.high },
  ];
  const tooFewForAny = reports + 1 < method.minimumProfile;
  const targets: Target[] = wanted.map((w) => {
    if (tooFewForAny) return { ...w, fra: null, total: null, reach: 'no_value' };
    const total = steps.find((t) => (valueIn(round2(t / observed))?.value ?? -1) >= w.rv);
    if (total === undefined) return { ...w, fra: null, total: null, reach: 'out_of_reach' };
    const f = round2(total / observed);
    // Reached when the coming report as entered is valued at the target, even at an average no whole mark total gives.
    return { ...w, fra: f, total, reach: rv && rv.value >= w.rv ? 'reached' : 'needs' };
  });
  return { fra, profile: { before, after }, rv, third: rv ? thirdOf(rv.value, method) : null, reason, earlier, targets, observed };
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export { today as standingDay };
