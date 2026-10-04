import { formatNumber } from '../metrics.ts';
import type { Fact } from './facts.ts';

export interface Weighed { score: number; reasons: string[] }

const log10 = (n: number) => Math.log10(Math.max(1, n));
export const shortMoney = (n: number) => {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const trim = (x: number) => String(Number(x.toFixed(1))).replace(/\.0$/, '');
  if (abs >= 1e9) return `${sign}$${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `${sign}$${trim(abs / 1e6)}M`;
  if (abs >= 1e4) return `${sign}$${trim(abs / 1e3)}K`;
  return `${sign}$${formatNumber(Math.round(abs))}`;
};

/**
 * How much an entry says about the Marine's work, and why. Money and counts are read on a log scale (the tenth ULO
 * matters less than the first), a stated outcome counts for more than either, and a count measured against the
 * Marine's own largest of that unit lifts the entry that stands out. Every point carries its reason, so the choice
 * of what makes the cut can be shown, not just made.
 */
export function weigh(f: Fact, ctx: { peakByUnit: Map<string, number>; recentFrom?: string | null } = { peakByUnit: new Map() }): Weighed {
  let score = 1;
  const reasons: string[] = [];
  if (f.money) {
    const scale = Math.min(3, log10(Math.abs(f.money.amount)) / 2);
    score += f.money.summable ? scale : scale / 2;
    reasons.push(`${shortMoney(f.money.amount)}${f.money.type ? ` ${f.money.type}` : ''}`);
  }
  if (f.quantity) {
    const { n, unit, kind } = f.quantity;
    if (kind === 'item') {
      score += Math.min(2, log10(n + 1));
      const peak = ctx.peakByUnit.get(unit.toLowerCase());
      if (peak && peak > 0 && n >= peak && n > 1) { score += 0.5; reasons.push(`largest count of ${unit}`); }
      reasons.push(`${formatNumber(n)} ${unit}`);
    } else if (kind === 'time') {
      score += Math.min(1, log10(n + 1) / 2);
      reasons.push(`${formatNumber(n)} ${unit}`);
    } else if (kind === 'measure') {
      score += 0.3;
      reasons.push(`${formatNumber(n)} ${unit}`);
    }
  }
  if (f.people) {
    score += Math.min(2.5, 1 + log10(f.people + 1));
    reasons.push(`${formatNumber(f.people)} ${f.people === 1 ? 'person' : 'people'} led or trained`);
  }
  if (f.result) {
    score += 1.5;
    if (f.strongResult) { score += 1; reasons.push('measured outcome'); } else reasons.push('outcome stated');
  }
  if (f.verb?.strength === 3) { score += 0.5; reasons.push(`strong verb (${f.verb.past})`); }
  if (f.verb?.strength === 1) { score -= 1; reasons.push('weak opening'); }
  if (f.issues.some((i) => i.code === 'no_verb')) score -= 0.5;
  if (ctx.recentFrom && f.date && f.date >= ctx.recentFrom) { score += 0.25; reasons.push('recent'); }
  return { score: Math.round(score * 10) / 10, reasons };
}
