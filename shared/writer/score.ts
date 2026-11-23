import { formatNumber } from '../metrics.ts';
import type { Fact } from './facts.ts';

/**
 * An entry's weight and why. `tier` is what its outcome says: 2 measured, 1 stated, 0 none. Every entry of a higher tier
 * outweighs every entry of a lower one (BAND), so a measured outcome ranks above a dollar figure however large.
 */
export interface Weighed { score: number; tier: Tier; reasons: string[] }
export type Tier = 0 | 1 | 2;

/** Where each tier starts. The rest of the score (the figures, the verb) adds at most BAND_SPAN, so bands never overlap. */
export const BAND: Record<Tier, number> = { 0: 1, 1: 4.5, 2: 8 };
export const BAND_SPAN = 3;
/** The most an entry's figures add: the largest of its money, count, people or time, plus its standing among its own. */
const FIGURE_CAP = 2.5;

const log10 = (n: number) => Math.log10(Math.max(1, n));
export const shortMoney = (n: number) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const trim = (x: number) => String(Number(x.toFixed(1))).replace(/\.0$/, '');
  // The unit is chosen after rounding, so $999,960 is "$1M", never "$1000K".
  const reaches = (scale: number) => Number((abs / scale).toFixed(1)) >= 1000;
  if (abs >= 1e12 || reaches(1e9)) return `${sign}$${trim(abs / 1e12)}T`;
  if (abs >= 1e9 || reaches(1e6)) return `${sign}$${trim(abs / 1e9)}B`;
  if (abs >= 1e6 || reaches(1e3)) return `${sign}$${trim(abs / 1e6)}M`;
  if (abs >= 1e4 || Math.round(abs) >= 1e4) return `${sign}$${trim(abs / 1e3)}K`;
  return `${sign}$${formatNumber(Math.round(abs))}`;
};

/**
 * How much an entry says about the Marine's work, and why. What came of it decides first: a measured outcome (a
 * number, a zero, every one, a deadline met) above a stated one, a stated one above none (BAND). Then its largest
 * figure, on a log scale (the tenth ULO matters less than the first), and a count that is the Marine's largest of that
 * unit. A weak or billet opening, a rating or a cliché costs the sentence its place before it costs the Marine. Every
 * point carries its reason, so the choice of what makes the cut can be shown, not just made.
 */
export function weigh(f: Fact, ctx: { peakByUnit: Map<string, number>; recentFrom?: string | null } = { peakByUnit: new Map() }): Weighed {
  const tier: Tier = f.result ? (f.strongResult ? 2 : 1) : 0;
  const reasons: string[] = [tier === 2 ? 'measured outcome' : tier === 1 ? 'outcome stated' : 'no outcome'];
  let figure = 0;
  if (f.money) {
    const scale = Math.min(2, log10(Math.abs(f.money.amount)) / 3);
    figure = Math.max(figure, f.money.summable ? scale : scale / 2);
    reasons.push(`${shortMoney(f.money.amount)}${f.money.type ? ` ${f.money.type}` : ''}`);
  }
  if (f.quantity) {
    const { n, unit, kind } = f.quantity;
    if (kind === 'item') {
      figure = Math.max(figure, Math.min(2, log10(n + 1)));
      const peak = ctx.peakByUnit.get(unit.toLowerCase());
      if (peak && peak > 0 && n >= peak && n > 1) { figure += 0.5; reasons.push(`largest count of ${unit}`); }
      reasons.push(`${formatNumber(n)} ${unit}`);
    } else if (kind === 'time') {
      figure = Math.max(figure, Math.min(1, log10(n + 1) / 2));
      reasons.push(`${formatNumber(n)} ${unit}`);
    } else if (kind === 'measure') {
      figure = Math.max(figure, 0.3);
      reasons.push(`${formatNumber(n)} ${unit}`);
    }
  }
  if (f.people) {
    figure = Math.max(figure, Math.min(2, 0.5 + log10(f.people + 1)));
    reasons.push(`${formatNumber(f.people)} ${f.people === 1 ? 'person' : 'people'} led or trained`);
  }
  let score = BAND[tier] + Math.min(FIGURE_CAP, figure);
  if (f.verb?.strength === 3) { score += 0.25; reasons.push(`strong verb (${f.verb.past})`); }
  if (ctx.recentFrom && f.date && f.date >= ctx.recentFrom) { score += 0.25; reasons.push('recent'); }
  // A weak opening ("Helped", "Responsible for") or a billet named instead of the work says little about what the
  // Marine did, whatever the verb's entry says. Once, not twice.
  const billet = f.issues.some((i) => i.code === 'billet');
  if (f.verb?.strength === 1 || f.issues.some((i) => i.code === 'weak_verb') || billet) { score -= 1; reasons.push(billet ? 'names the billet' : 'weak opening'); }
  if (f.issues.some((i) => i.code === 'no_verb')) score -= 0.5;
  for (const code of ['superlative', 'cliche'] as const) if (f.issues.some((i) => i.code === code)) { score -= 1.5; reasons.push(code === 'superlative' ? 'rates instead of states' : 'cliché'); }
  return { score: Math.round(score * 10) / 10, tier, reasons };
}

/** The order entries rank in: tier first, then score. */
export const byRank = (a: Weighed, b: Weighed) => b.tier - a.tier || b.score - a.score;
