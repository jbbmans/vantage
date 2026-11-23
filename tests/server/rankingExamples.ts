/**
 * Fixed examples for the writer's ranking, its reading of a measured outcome and a billet, and the same work logged
 * twice or done many times. Each pins what the writer must do with it; bulletRanking.test.ts runs them.
 */
import type { EntryInput } from '../../shared/writer/facts.ts';

const M = 'MOS / Mission Accomplishment';

/** Pairs of entries where the first must outrank the second, with each one's tier (2 measured, 1 stated, 0 none). */
export interface RankPair { why: string; better: EntryInput; worse: EntryInput; tiers: [number, number] }

export const RANK_PAIRS: RankPair[] = [
  {
    why: 'a measured outcome outranks a dollar figure with none, however large',
    better: { title: 'Processed 40 travel vouchers', quantity: 40, unit_label: 'vouchers', result: 'cut payment time from 21 days to 6 days', eval_area: M },
    worse: { title: 'Processed 400 travel vouchers', quantity: 400, unit_label: 'vouchers', dollar_amount: 5_000_000, dollar_type: 'impact', eval_area: M },
    tiers: [2, 0],
  },
  {
    why: 'a measured outcome outranks the same work with a stated one',
    better: { title: 'Reconciled 14 ULOs in DAI', quantity: 14, unit_label: 'ULOs', result: 'all cleared on the next report', eval_area: M },
    worse: { title: 'Reconciled 140 ULOs in DAI', quantity: 140, unit_label: 'ULOs', dollar_amount: 2_400_000, dollar_type: 'reconciled', result: 'approved by the CO on 12 March', eval_area: M },
    tiers: [2, 1],
  },
  {
    why: 'a stated outcome outranks a large count with none',
    better: { title: 'Drafted the check-in SOP', result: 'adopted by the battalion', eval_area: M },
    worse: { title: 'Processed 900 leave requests in MOL', quantity: 900, unit_label: 'leave requests', eval_area: M },
    tiers: [1, 0],
  },
  {
    why: 'a zero is a measure: "none returned" outranks a dated approval',
    better: { title: 'Submitted 30 award recommendations', quantity: 30, unit_label: 'award recommendations', result: 'none returned for correction', eval_area: M },
    worse: { title: 'Submitted 30 award recommendations', quantity: 30, unit_label: 'award recommendations', result: 'signed by the CO on 4 June', eval_area: M },
    tiers: [2, 1],
  },
  {
    why: 'the work done in a billet outranks the billet named',
    better: { title: 'Closed 40 of 42 taskers as acting section chief', quantity: 40, unit_label: 'taskers', eval_area: 'Leadership' },
    worse: { title: 'Served as acting section chief', eval_area: 'Leadership' },
    tiers: [0, 0],
  },
];

/** Outcomes the writer reads as measured, and ones it does not: a date, a fiscal year, a quarter or "S-3" is no measure. */
export const MEASURED = [
  'all cleared', 'none returned', 'every voucher paid', 'cut by half', 'from 9 days to 2 days', 'zero findings', 'on time', 'no discrepancies', 'reduced the backlog by 40%', 'first in the battalion',
  // A count whose noun opens like a month ("Marines", "junior", "septic", "decisions") is still a count, and so is a
  // four-figure one that is not a year in a date.
  'qualified 12 Marines on the range', '10 junior Marines certified', '3 septic tanks pumped', '15 decisions logged', '2000 rounds fired', 'reduced by 2000', 'approved on 12 March with 3 changes',
  // A count after a month, or after "through" or "during", with its noun: no day is 40, and 2000 miles is no year.
  'since June 40 Marines qualified', 'in Oct 20 vehicles passed inspection', 'mishap-free through 2000 miles', 'no failures during 2000 flight hours', 'so 14 may PCS', '12 sep packages processed',
  // A count after a date and a comma is a count, not a short year; "the 12 SEP packages" is no date.
  'on 12 June, 30 Marines qualified', 'by 4 Mar, 15 vehicles passed', '12 March, 14 Marines reenlisted', 'on 12 June 30 Marines qualified', 'submitted the 12 SEP packages',
];
export const NOT_MEASURED = [
  'approved by the CO on 12 March', 'briefed to the S-3', 'completed in FY26', 'submitted in Q4', 'signed on 4 June', 'adopted by the battalion',
  'completed in 2026', 'approved on 2026-03-12', 'signed March 12, 2026', 'finished in March 2026', 'signed 12 Mar. 2026', 'signed on the 4th of June', 'adopted in CY2025', 'signed 03/12/2026',
  // The date form Vantage prints, and the ways a Marine writes one.
  'approved by the CO on 12 MAR 26', 'signed 12MAR26', 'approved 12-Mar-2026', 'approved 12 SEP 26', 'signed on 4 May', 'covered 2025-2026', 'completed FY25-26', 'completed during 2025-2026', 'completed in the 1st Qtr', 'completed Q3FY26', 'approved the 2026 plan',
  // A word that ends in "s" and is no plural ("as", "is", "its", "across") leaves a date a date.
  'completed in 2026 as planned', 'adopted in 2026 across the MEF', 'signed March 12 as directed', 'approved June 4 and is now in use', 'approved March 12 by its CO', 'approved the 2026 plan as written', 'adopted since 2024 across the division',
  // May and September beside a year, or as "the 4th of".
  'signed May 4, 2026', 'signed Sep 12, 2026', 'signed on the 4th of May', 'signed on 4 May as directed',
];

/** Titles that name a billet or a charge instead of the work, and ones that only look like it. */
export const BILLETS = ['Served as the S-4 chief', 'Assigned as platoon sergeant', 'Appointed to the safety board', 'Designated as the unit PSO', 'Acting section chief', 'Billet: S-4 chief', 'Primary duty: armorer', 'Performed the duties of platoon sergeant', 'Was assigned to the S-3 shop', 'Held the billet of company gunny', 'Managed the armory', 'Supervised the motor pool'];
export const NOT_BILLETS = ['Served 120 meals at the base shelter', 'Managed 3 armory audits', 'Supervised 12 Marines on a working party', 'Acting on CO guidance, rewrote the SOP', 'Reconciled 14 ULOs in DAI'];

const MIPR: EntryInput = { title: 'Processed 22 MIPRs for the G-8', quantity: 22, unit_label: 'MIPRs', dollar_amount: 240_000, dollar_type: 'obligated', eval_area: M, date: '2026-09-02' };

/** Pairs of entries that are, or are not, the same work logged twice. */
export const REPEATS: Array<{ why: string; a: EntryInput; b: EntryInput; same: boolean }> = [
  { why: 'the same MIPRs a day later, with "the" left out', a: MIPR, b: { ...MIPR, title: 'Processed 22 MIPRs for G-8', date: '2026-09-03' }, same: true },
  { why: 'the copy that adds an outcome', a: MIPR, b: { ...MIPR, result: 'zero returned for correction' }, same: true },
  { why: 'the same count a week later', a: MIPR, b: { ...MIPR, date: '2026-09-09' }, same: false },
  { why: 'a different count', a: MIPR, b: { ...MIPR, title: 'Processed 14 MIPRs for the G-8', quantity: 14 }, same: false },
  { why: 'different dollars', a: MIPR, b: { ...MIPR, dollar_amount: 120_000 }, same: false },
  { why: 'another kind of dollars', a: MIPR, b: { ...MIPR, dollar_type: 'saved' }, same: false },
  { why: 'another system', a: { ...MIPR, system: 'DAI' }, b: { ...MIPR, system: 'SABRS' }, same: false },
  { why: 'two different outcomes', a: { ...MIPR, result: 'zero returned' }, b: { ...MIPR, result: 'two returned for correction' }, same: false },
  { why: 'another organization in the words', a: MIPR, b: { ...MIPR, title: 'Processed 22 MIPRs for the G-4' }, same: false },
  { why: 'no figure, the same words, the same day', a: { title: 'Briefed the CO on the spend plan', date: '2026-09-02' }, b: { title: 'Briefed the CO on the spend plan', date: '2026-09-02' }, same: true },
  { why: 'no figure, the same words, the next day', a: { title: 'Briefed the CO on the spend plan', date: '2026-09-02' }, b: { title: 'Briefed the CO on the spend plan', date: '2026-09-03' }, same: false },
  { why: 'undated copies with the same words', a: { ...MIPR, date: null }, b: { ...MIPR, date: null }, same: true },
  { why: 'undated look-alikes: nothing says they were a day apart', a: { ...MIPR, date: null }, b: { ...MIPR, title: 'Processed 22 MIPRs for the G-8 comptroller', date: null }, same: false },
  { why: 'one dated, one not', a: MIPR, b: { ...MIPR, date: null }, same: false },
];

/** John's case: 100 OCMTs over ten entries, said once, as one total. */
export const OCMT_COUNTS = [12, 8, 15, 5, 10, 9, 11, 7, 13, 10];
export const ocmtEntries = (area = M): Array<EntryInput & { id: string }> => OCMT_COUNTS.map((n, i) => ({
  id: `ocmt${i}`, title: `Cleared ${n} OCMTs in DAI`, quantity: n, unit_label: 'OCMTs', dollar_amount: 1000 * n + 250 * i, dollar_type: 'reconciled',
  system: 'DAI', eval_area: area, date: `2026-0${(i % 9) + 1}-1${i % 9}`,
}));

/** A small deterministic generator (mulberry32), so a "random" record is the same on every run. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORK = [
  ['Reconciled', 'ULOs'], ['Processed', 'MIPRs'], ['Cleared', 'OCMTs'], ['Audited', 'OMPFs'], ['Inspected', 'vehicles'], ['Issued', 'rifles'],
  ['Trained', 'Marines'], ['Drafted', 'award recommendations'], ['Routed', 'DTS vouchers'], ['Corrected', 'unit diary entries'], ['Helped with', 'inventories'],
] as const;
const AREAS = [M, 'Leadership', 'Individual Character'];
const OUTCOMES = [...MEASURED, ...NOT_MEASURED, '', '', ''];

/** A record of `n` entries of mixed work, figures and outcomes, the same for one seed. */
export function seededRecord(n: number, seed: number): Array<EntryInput & { id: string }> {
  const r = seeded(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  return Array.from({ length: n }, (_, i) => {
    const [verb, unit] = pick(WORK);
    const count = r() < 0.8 ? 1 + Math.floor(r() * 200) : null;
    const money = r() < 0.4 ? Math.round(r() * 2_000_000) : null;
    const result = pick(OUTCOMES);
    return {
      id: `s${i}`, title: count ? `${verb} ${count} ${unit}` : `${verb} the ${unit}`, quantity: count, unit_label: count ? unit : null,
      dollar_amount: money, dollar_type: money ? pick(['reconciled', 'obligated', 'saved', 'reviewed']) : null, result: result || null,
      eval_area: r() < 0.9 ? pick(AREAS) : null, date: `2026-${String(1 + Math.floor(r() * 12)).padStart(2, '0')}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`,
    };
  });
}
