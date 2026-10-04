import { formatNumber } from '../metrics.ts';
import { unitFor } from './units.ts';
import { clauseOf, type Fact } from './facts.ts';
import { shortMoney } from './score.ts';
import { GLOSSARY } from './lexicon.ts';

export type Density = 'full' | 'compact';
/** "bullets" is the form MCO 1616.1 Appendix E shows: a dash, a past-tense verb, the count and context, then the result. */
export type Format = 'paragraph' | 'bullets';

// An outcome that is a measure ("100% mission readiness", "no incidents") reads as "…, resulting in" it, as the
// order's examples do; anything else ("all cleared on the next report") follows a semicolon.
const MEASURE_RESULT = /^(?:\d[\d,.]*\s*%?|100%|no|zero)\s+([a-z][a-z-]*)\b/i;
function joinResult(clause: string, result: string, format: Format, seed: number, key: string): string {
  // A grade or score the work earned: "…, with a 3.8 GPA".
  if (/^\d[\d.,]*\s+(?:GPA|average|grade point average|score|composite)$/i.test(result)) return `${clause}, with a ${result}`;
  const m = MEASURE_RESULT.exec(result);
  const measure = Boolean(m && !/ed$/i.test(m[1]));
  if (measure && (format === 'bullets' || pick([false, true] as const, seed, `${key}:r`))) return `${clause}, resulting in ${result}`;
  return `${clause}; ${result}`;
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Spells out each listed acronym the first time it appears across the sentences, in order: "Reconciled 14
 * unliquidated obligations (ULOs)". Later uses stay short. An acronym already written out is left alone.
 */
export function spellOut(texts: string[]): string[] {
  const done = new Set<string>();
  return texts.map((text) => {
    let out = text;
    for (const [acr, words] of Object.entries(GLOSSARY)) {
      if (done.has(acr)) continue;
      // Not inside parentheses: "(2-Way UMT, OCMT)" would nest a second pair. The next use outside them is spelled out.
      const re = new RegExp(`(?<![\\w-])${escapeRe(acr)}(s?)(?![\\w-])`, 'g');
      const inParens = (at: number) => (out.slice(0, at).match(/\(/g) || []).length > (out.slice(0, at).match(/\)/g) || []).length;
      const m = [...out.matchAll(re)].find((x) => !inParens(x.index!));
      if (!m || m.index === undefined) continue;
      done.add(acr);
      if (out.toLowerCase().includes(words.one.toLowerCase())) continue;
      const plural = Boolean(m[1]);
      let full = plural ? words.many || `${words.one}s` : words.one;
      if (m.index === 0) full = full.charAt(0).toUpperCase() + full.slice(1);
      out = `${out.slice(0, m.index)}${full} (${m[0]})${out.slice(m.index + m[0].length)}`;
    }
    return out;
  });
}

/** A stable pick among equivalent phrasings: the same seed gives the same wording, another seed another. */
export function pick<T>(options: readonly T[], seed: number, key: string): T {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < key.length; i += 1) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
  return options[Math.abs(h) % options.length];
}

/**
 * Dollars as an evaluation writes them: cents only under a thousand ("$118.38"), whole dollars to a million
 * ("$48,250"), then "$1.2M". Compact shortens from ten thousand ("$48.3K").
 */
export function dollars(amount: number, density: Density): string {
  const abs = Math.abs(amount);
  if (density === 'compact' || abs >= 1e6) return shortMoney(amount);
  const sign = amount < 0 ? '-' : '';
  const whole = Math.abs(abs - Math.round(abs)) < 0.005;
  if (abs >= 1000 || whole) return `${sign}$${formatNumber(Math.round(abs))}`;
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

/** Whether the text already states this amount, however it was written ("$48,250", "$48.3K", "$1.2 million"). */
export function statesAmount(text: string, amount: number): boolean {
  // A figure with cents typed bare ("corrected 150.25 in misposted charges") is the amount too.
  for (const m of text.matchAll(/-?(\d[\d,]*\.\d{2})\b/g)) if (Math.abs(Number(m[1].replace(/,/g, '')) - Math.abs(amount)) < 0.005) return true;
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|mm|m|million|b|billion)?\b/gi)) {
    const value = Number(m[1].replace(/,/g, '')) * (m[2] ? SCALE[m[2].toLowerCase()] : 1);
    // A written-down figure ("$48.3K") is within rounding of the amount it stands for.
    if (Math.abs(value - Math.abs(amount)) <= Math.max(0.005, Math.abs(amount) * (m[2] ? 0.05 : 0))) return true;
  }
  return false;
}

const has = (text: string, part: string) => text.toLowerCase().includes(part.toLowerCase());

/** Plain characters, so the text pastes into any form: straight quotes, hyphens, no ellipsis glyph. */
export function plain(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...').replace(/\u00a0/g, ' ')
    // Accents to plain letters ("résumé" → "resume"); symbols and emoji, which a form may refuse, go.
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e\n]/g, '').replace(/ {2,}/g, ' ');
}

export function finish(sentence: string): string {
  // Punctuation sits against the word before it and has a space after it, except inside a figure ("$1,118", "14:30").
  let s = plain(sentence).replace(/\s+/g, ' ').replace(/\s+([,;:.])(?!\d)/g, '$1').replace(/([,;:])(?=[A-Za-z(])/g, '$1 ').replace(/;\s*;/g, ';').trim();
  s = s.replace(/[;,:\s]+$/, '');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

function withMoney(clause: string, f: Fact, density: Density, seed: number): string {
  if (!f.money || statesAmount(clause, f.money.amount)) return clause;
  const figure = dollars(f.money.amount, density);
  const phrase = f.money.summable ? `${pick(['worth', 'totaling', 'valued at'] as const, seed, f.key)} ${figure}` : `covering ${figure}`;
  // Right after the count it belongs to, when the clause has one: "Reconciled 14 ULOs worth $48,250 in DAI",
  // "Cleared 4 2-Way UMTs worth $6,206 on the Q4 report".
  if (f.quantity) {
    const escape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const counts = [...new Set([formatNumber(f.quantity.n), String(f.quantity.n)])].map(escape).join('|');
    const unit = escape(f.quantity.unit.replace(/s$/i, ''));
    const at = new RegExp(`\\b(?:${counts})\\s+(?:[\\w/-]+\\s+){0,2}?${unit}(?:e?s)?\\b`, 'i').exec(clause);
    if (at) {
      const end = at.index + at[0].length;
      return `${clause.slice(0, end)} ${phrase}${clause.slice(end)}`;
    }
  }
  return `${clause}, ${phrase}`;
}

function withCount(clause: string, f: Fact): string {
  if (!f.quantity || f.quantity.kind === 'measure') return clause;
  const { n, unit } = f.quantity;
  // "(1 Marine)" after "the new PFC" adds nothing; a count of one is in the words already.
  if (n === 1 || clause.includes(String(n)) || clause.includes(formatNumber(n))) return clause;
  // A bare verb takes its count as its object: "Mentored 2 Marines", not "Mentored (2 Marines)".
  if (!f.rest.trim() && f.opener) return `${clause} ${formatNumber(n)} ${unitFor(unit, n)}`;
  return `${clause} (${formatNumber(n)} ${unitFor(unit, n)})`;
}

/** Shortens a long outcome at its first natural break, when the break leaves the main claim whole. */
function shortResult(result: string): string {
  if (result.length <= 70) return result;
  const cut = result.slice(25).search(/[,;]\s|\s-\s/);
  return cut >= 0 ? result.slice(0, 25 + cut) : result;
}

/** One entry as a sentence. Full keeps the system and who it was for; compact keeps the claim, the count and the outcome. */
export function sentenceFor(f: Fact, density: Density, seed: number, format: Format = 'paragraph'): string {
  let clause = clauseOf(f);
  clause = withCount(clause, f);
  clause = withMoney(clause, f, density, seed);
  if (density === 'full') {
    if (f.system && !has(clause, f.system)) clause += ` in ${f.system}`;
    if (f.organization && !has(clause, f.organization)) clause += ` for ${f.organization}`;
  }
  if (f.purpose) clause += `, in support of ${f.purpose}`;
  const result = f.result ? (density === 'compact' ? shortResult(f.result) : f.result) : null;
  return finish(result ? joinResult(clause, result, format, seed, f.key) : clause);
}

export interface Group { key: string; members: Fact[]; verbPast: string; unit: string; n: number; money: number; moneyType: string | null; system: string | null }

/** Several entries of the same work as one sentence: "Reconciled 23 ULOs worth $60K, including 14 in DAI: all cleared on the next report." */
export function sentenceForGroup(g: Group, density: Density, seed: number): string {
  const unit = unitFor(g.unit, g.n);
  let clause = `${g.verbPast.charAt(0).toUpperCase()}${g.verbPast.slice(1)} ${formatNumber(g.n)} ${unit}`;
  if (g.money) clause += ` ${pick(['worth', 'totaling', 'valued at'] as const, seed, g.key)} ${dollars(g.money, density)}`;
  if (g.system && density === 'full') clause += ` in ${g.system}`;
  clause += ` across ${g.members.length} actions`;
  const best = [...g.members].filter((m) => m.result && m.quantity).sort((a, b) => Number(b.strongResult) - Number(a.strongResult) || (b.quantity!.n - a.quantity!.n))[0];
  if (best) clause += `, including ${formatNumber(best.quantity!.n)}${best.system && best.system !== g.system ? ` in ${best.system}` : ''}: ${density === 'compact' ? shortResult(best.result!) : best.result}`;
  return finish(clause);
}

/** The area's totals, for work that did not get a sentence of its own: "In all, 142 ULOs reconciled and $1.2M obligated." */
export function summaryFor(parts: string[]): string | null {
  if (parts.length < 2) return null;
  const list = parts.length === 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return finish(`In all, ${list}`);
}
