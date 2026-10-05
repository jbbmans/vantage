import { DEFAULT_METRICS, valueType, type MetricsConfig } from '../constants.ts';
import { unitFor } from './units.ts';
import { formatNumber } from '../metrics.ts';
import { clauseOf, readEntry, unitIdentity, type AreaNames, type EntryInput, type Fact } from './facts.ts';
import { weigh, shortMoney, type Weighed } from './score.ts';
import { finish, sentenceFor, sentenceForGroup, spellOut, summaryFor, type Density, type Format, type Group } from './realize.ts';
import { reviewWriting, type Review } from './review.ts';

/** Credit from the case histories: what the Marine researched, verified and resolved in the period. */
export interface CaseWork { researched: number; verified: number; resolved: number; procedures: string[] }

export interface WriterOptions {
  areas: readonly string[];
  labels: Record<string, string>;
  names: AreaNames;
  limit: number;
  periodLabel?: string;
  metrics?: MetricsConfig;
  /** "auto" writes in full and shortens a sentence only when that is what fits it. */
  density?: Density | 'auto';
  seed?: number;
  exclude?: readonly string[];
  pin?: readonly string[];
  casework?: CaseWork | null;
  /** Entries on or after this day count as recent. */
  recentFrom?: string | null;
  /** Paragraph ("MISSION: …") or the dash bullets of MCO 1616.1 Appendix E, under a heading per area. */
  format?: Format;
  /** The heading over each area in bullet form. */
  headers?: Record<string, string>;
  /** Spell out standard acronyms on their first use. */
  spellOut?: boolean;
  track?: 'jepes' | 'fitrep';
}

/** An entry a rule keeps out of the input, and the rule. */
export interface Held { key: string; area: string; text: string; reason: string; basis: 'order' | 'guidance' | 'style' | 'data'; cite?: string; sources: string[] }

export type SentenceKind = 'entry' | 'group' | 'summary' | 'casework';

export interface Sentence {
  key: string;
  area: string;
  kind: SentenceKind;
  text: string;
  sources: string[];
  /** The fact keys this sentence speaks for. */
  covers: string[];
  score: number;
  reasons: string[];
  attribute: string | null;
  compact: boolean;
  pinned: boolean;
  hasResult: boolean;
  measured: boolean;
  verb: string | null;
  verbStrength: number | null;
}

export interface WrittenNarrative {
  text: string; length: number; limit: number; fits: boolean; periodLabel?: string;
  /** Sentences written, and entries with no sentence of their own. */
  used: number; omitted: number;
  areas: Array<{ area: string; label: string; count: number; included: number; available: number; inferred: number }>;
  sentences: Sentence[];
  /** What was considered and left out, best first, so it can be swapped in. */
  left: Sentence[];
  facts: Fact[];
  review: Review;
  held: Held[];
  seed: number;
  density: Density | 'auto';
  format: Format;
  spellOut: boolean;
}

interface Candidate {
  key: string; area: string; kind: SentenceKind; covers: string[]; sources: string[]; weighed: Weighed;
  full: string; compact: string; attribute: string | null; hasResult: boolean; measured: boolean; verb: string | null; verbStrength: number | null;
}

const NUMBER = /\d/;
const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
function similar(a: string, b: string): boolean {
  const x = tokens(a); const y = tokens(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both) >= 0.7;
}

function entryCandidate(f: Fact, w: Weighed, seed: number, format: Format): Candidate {
  return {
    key: f.key, area: f.area, kind: 'entry', covers: [f.key], sources: f.sources, weighed: w,
    full: sentenceFor(f, 'full', seed, format), compact: sentenceFor(f, 'compact', seed, format), attribute: f.attribute,
    hasResult: Boolean(f.result), measured: Boolean(f.quantity || f.money || f.people || NUMBER.test(f.rest)),
    verb: f.verb?.lemma ?? null, verbStrength: f.verb?.strength ?? null,
  };
}

/** Entries of the same work and unit: two or more "Reconciled … ULOs" read better as one total. */
function groupsOf(facts: Fact[]): Group[] {
  const by = new Map<string, Fact[]>();
  for (const f of facts) {
    if (!f.verb || !f.quantity || (f.quantity.kind !== 'item' && f.quantity.kind !== 'people')) continue;
    const key = `group:${f.area}:${f.verb.lemma}:${unitIdentity(f.quantity.unit)}`;
    by.set(key, [...(by.get(key) || []), f]);
  }
  const out: Group[] = [];
  for (const [key, members] of by) {
    if (members.length < 2) continue;
    const types = new Set(members.filter((m) => m.money?.summable).map((m) => m.money!.type));
    const systems = new Set(members.map((m) => m.system));
    // The plural a person typed most often names the unit: "ULOs", not "ulos".
    const unitNames = members.map((m) => m.quantity!.unit);
    const unit = unitNames.sort((a, b) => unitNames.filter((u) => u === b).length - unitNames.filter((u) => u === a).length)[0];
    out.push({
      key, members, verbPast: members[0].verb!.past, unit, n: members.reduce((n, m) => n + m.quantity!.n, 0),
      money: members.reduce((n, m) => n + (m.money?.summable ? m.money.amount : 0), 0),
      moneyType: types.size === 1 ? [...types][0] : null,
      system: systems.size === 1 ? [...systems][0] : null,
    });
  }
  return out;
}

function groupCandidate(g: Group, weights: Map<string, Weighed>, seed: number): Candidate {
  const members = g.members.map((m) => weights.get(m.key)!);
  const score = Math.round((members.reduce((n, w) => n + w.score, 0) * 0.9 + Math.log2(g.members.length)) * 10) / 10;
  const first = g.members[0];
  return {
    key: g.key, area: first.area, kind: 'group', covers: g.members.map((m) => m.key), sources: g.members.flatMap((m) => m.sources),
    weighed: { score, reasons: [`${g.members.length} entries of the same work`, ...new Set(members.flatMap((w) => w.reasons).filter((r) => /outcome/.test(r)))] },
    full: sentenceForGroup(g, 'full', seed), compact: sentenceForGroup(g, 'compact', seed), attribute: first.attribute,
    hasResult: g.members.some((m) => m.result), measured: true, verb: first.verb?.lemma ?? null, verbStrength: first.verb?.strength ?? null,
  };
}

/** The area's totals by work and by kind of money, for what did not get a sentence of its own. */
function summaryCandidate(area: string, facts: Fact[], metrics: MetricsConfig): Candidate | null {
  const counts = new Map<string, { past: string; unit: string; n: number }>();
  const money = new Map<string, number>();
  for (const f of facts) {
    if (f.verb && f.quantity && (f.quantity.kind === 'item' || f.quantity.kind === 'people')) {
      const key = `${f.verb.past}|${unitIdentity(f.quantity.unit)}`;
      const was = counts.get(key);
      counts.set(key, { past: f.verb.past, unit: was?.unit || f.quantity.unit, n: (was?.n || 0) + f.quantity.n });
    }
    if (f.money?.summable) money.set(f.money.type || '', (money.get(f.money.type || '') || 0) + f.money.amount);
  }
  const parts = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 3).map((c) => `${formatNumber(c.n)} ${unitFor(c.unit, c.n)} ${c.past}`);
  for (const [type, amount] of [...money.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)) {
    const t = valueType(type, metrics);
    parts.push(t && t.key !== 'impact' ? `${shortMoney(amount)} ${t.verb}` : `${shortMoney(amount)} in fiscal impact`);
  }
  const text = summaryFor(parts);
  if (!text) return null;
  return {
    key: `summary:${area}`, area, kind: 'summary', covers: [], sources: facts.flatMap((f) => f.sources), weighed: { score: 0.5, reasons: ['totals for the rest of this area'] },
    full: text, compact: text, attribute: null, hasResult: false, measured: true, verb: null, verbStrength: null,
  };
}

function caseworkCandidate(c: CaseWork, area: string): Candidate | null {
  if (!c.researched && !c.verified && !c.resolved) return null;
  const procs = c.procedures.length ? ` (${c.procedures.slice(0, 3).join(', ')})` : '';
  const after: string[] = [];
  if (c.verified) after.push(`recorded ${formatNumber(c.verified)} verified ${c.verified === 1 ? 'outcome' : 'outcomes'}`);
  if (c.resolved) after.push(`resolved ${formatNumber(c.resolved)} ${c.resolved === 1 ? 'case' : 'cases'}`);
  const lead = c.researched ? `Researched ${formatNumber(c.researched)} ${c.researched === 1 ? 'document' : 'documents'}${procs}` : `Worked cases${procs}`;
  const text = finish(after.length ? `${lead}; ${after.join(' and ')}` : lead);
  const score = Math.round((2 + Math.log10(c.researched + 1) + (c.verified ? 1 : 0) + (c.resolved ? 1 : 0)) * 10) / 10;
  return {
    key: 'casework', area, kind: 'casework', covers: ['casework'], sources: ['casework'],
    weighed: { score, reasons: ['from your case histories', ...(c.verified ? [`${c.verified} verified outcomes`] : [])] },
    full: text, compact: text, attribute: 'Performance', hasResult: Boolean(c.verified || c.resolved), measured: true, verb: 'research', verbStrength: 2,
  };
}

interface Chosen { c: Candidate; compact: boolean; pinned: boolean }

interface Layout { areas: readonly string[]; labels: Record<string, string>; headers: Record<string, string>; format: Format; spell: boolean }

function assemble(chosen: Chosen[], layout: Layout): { text: string; ordered: Chosen[]; texts: Map<string, string> } {
  const { areas } = layout;
  const ordered: Chosen[] = [];
  for (const area of areas) {
    let mine = chosen.filter((x) => x.c.area === area);
    if (!mine.length) continue;
    const rank = (x: Chosen) => (x.c.kind === 'casework' ? 0 : x.c.kind === 'summary' ? 2 : 1);
    mine = mine.sort((a, b) => rank(a) - rank(b) || b.c.weighed.score - a.c.weighed.score);
    // Two sentences in a row that open with the same verb read as a list; the next one with a different verb goes between.
    for (let i = 1; i < mine.length; i += 1) {
      if (mine[i].c.verb && mine[i].c.verb === mine[i - 1].c.verb) {
        const j = mine.findIndex((x, k) => k > i && x.c.verb !== mine[i - 1].c.verb && x.c.kind !== 'summary');
        if (j > 0) [mine[i], mine[j]] = [mine[j], mine[i]];
      }
    }
    ordered.push(...mine);
  }
  // Acronyms are spelled out once, in reading order, so the text that is measured is the text that is shown.
  const base = ordered.map((x) => (x.compact ? x.c.compact : x.c.full));
  const final = layout.spell ? spellOut(base) : base;
  const texts = new Map(ordered.map((x, i) => [x.c.key, final[i]]));
  const blocks: string[] = [];
  for (const area of areas) {
    const mine = ordered.filter((x) => x.c.area === area).map((x) => texts.get(x.c.key)!);
    if (!mine.length) continue;
    blocks.push(layout.format === 'bullets'
      ? `${layout.headers[area] || area}\n${mine.map((t) => `-${t}`).join('\n')}`
      : `${layout.labels[area] || area.toUpperCase()}: ${mine.join(' ')}`);
  }
  const text = layout.format === 'bullets' ? blocks.join('\n').trim() : blocks.join(' ').replace(/\s{2,}/g, ' ').trim();
  return { text, ordered, texts };
}

type Strategy = 'value' | 'density';

function select(cands: Candidate[], opts: WriterOptions, layout: Layout, strategy: Strategy = 'density'): Chosen[] {
  const density = opts.density ?? 'auto';
  const pin = new Set(opts.pin || []);
  const chosen: Chosen[] = [];
  const covered = new Set<string>();
  const length = () => assemble(chosen, layout).text.length;
  const overlaps = (c: Candidate) => c.covers.some((k) => covered.has(k)) || chosen.some((x) => x.c.key === c.key || (c.kind !== 'summary' && similar(x.c.full, c.full)));
  const tryAdd = (c: Candidate, pinned = false): boolean => {
    if (overlaps(c)) return false;
    const forms: boolean[] = density === 'compact' ? [true] : density === 'full' && !pinned ? [false] : [false, true];
    for (const compact of forms) {
      chosen.push({ c, compact, pinned });
      if (length() <= opts.limit || pinned) { for (const k of c.covers) covered.add(k); return true; }
      chosen.pop();
    }
    return false;
  };

  for (const c of cands) if (pin.has(c.key)) tryAdd(c, true);
  // Every area with work in it gets its best sentence before any area gets a second.
  for (const area of opts.areas) {
    const best = cands.filter((c) => c.area === area && c.kind !== 'summary').sort((a, b) => b.weighed.score - a.weighed.score);
    // Not with a line that says next to nothing: an empty area is a finding the Marine can act on, filler is not.
    for (const c of best) if ((c.weighed.score >= 1 || pin.has(c.key)) && tryAdd(c)) break;
  }
  // Then what says the most: for the space it takes, or outright. writeNarrative tries both and keeps the better.
  const rank = strategy === 'density' ? (c: Candidate) => c.weighed.score / c.full.length : (c: Candidate) => c.weighed.score;
  // A sentence that says next to nothing ("Helped with the close out") is offered back rather than used as filler.
  const rest = cands.filter((c) => c.kind !== 'summary' && (c.weighed.score >= 1 || pin.has(c.key))).sort((a, b) => rank(b) - rank(a));
  for (const c of rest) tryAdd(c);
  // Totals stand in for counted work that did not get a sentence; with none left out, they would only repeat.
  for (const c of cands.filter((x) => x.kind === 'summary')) {
    const areaFacts = cands.filter((x) => x.area === c.area && x.kind === 'entry');
    if (areaFacts.some((x) => !covered.has(x.key) && x.measured && /\d/.test(x.full))) tryAdd(c);
  }
  // Pinned sentences can push the text over; what is not pinned goes first, weakest first.
  while (length() > opts.limit) {
    const drop = chosen.filter((x) => !x.pinned).sort((a, b) => a.c.weighed.score - b.c.weighed.score)[0];
    if (!drop) break;
    chosen.splice(chosen.indexOf(drop), 1);
  }
  return chosen;
}

const toSentence = (c: Candidate, compact: boolean, pinned: boolean, text?: string): Sentence => ({
  key: c.key, area: c.area, kind: c.kind, text: text ?? (compact ? c.compact : c.full), sources: [...new Set(c.sources)], covers: c.covers,
  score: c.weighed.score, reasons: c.weighed.reasons, attribute: c.attribute, compact, pinned, hasResult: c.hasResult, measured: c.measured,
  verb: c.verb, verbStrength: c.verbStrength,
});

/**
 * Writes the narrative: reads every entry, weighs it, and fills the character limit with what says the most about the
 * work, area by area. Entries of the same work become one total when they would not all fit; totals account for what
 * still did not. Each sentence keeps the entries it came from, its score and the reasons for it.
 */
export function writeNarrative(entries: EntryInput[], opts: WriterOptions): WrittenNarrative {
  const metrics = opts.metrics ?? DEFAULT_METRICS;
  const seed = opts.seed ?? 0;
  const exclude = new Set(opts.exclude || []);
  const format: Format = opts.format ?? 'paragraph';
  const read = entries.map((e) => readEntry(e, { names: opts.names, areas: opts.areas, metrics })).filter((f) => !exclude.has(f.key));
  // The same work logged twice (same words, numbers and day) counts once; a total built on both would claim double.
  const seen = new Map<string, Fact>();
  for (const f of read) {
    const key = [clauseOf(f).toLowerCase().replace(/[^a-z0-9]/g, ''), f.quantity?.n ?? '', f.money?.amount ?? '', f.date ?? ''].join('|');
    const first = seen.get(key);
    if (first && !f.held) f.held = { reason: `Looks logged twice: the same words, numbers and day as another entry${first.date ? ` (${first.date})` : ''}.`, basis: 'data' };
    else if (!first) seen.set(key, f);
  }
  // What a rule keeps out (required annual training) is set aside with the rule, never written and never lost.
  const held: Held[] = read.filter((f) => f.held && !(opts.pin || []).includes(f.key)).map((f) => ({ key: f.key, area: f.area, text: sentenceFor(f, 'full', seed, format), reason: f.held!.reason, basis: f.held!.basis, cite: f.held!.cite, sources: f.sources }));
  const facts = read.filter((f) => !f.held || (opts.pin || []).includes(f.key));
  const areas = [...opts.areas];
  for (const f of facts) if (!areas.includes(f.area)) areas.push(f.area);
  const o: WriterOptions = { ...opts, areas };
  const layout: Layout = { areas, labels: opts.labels, headers: opts.headers || {}, format, spell: Boolean(opts.spellOut) };

  const peakByUnit = new Map<string, number>();
  for (const f of facts) if (f.quantity?.kind === 'item') peakByUnit.set(f.quantity.unit.toLowerCase(), Math.max(peakByUnit.get(f.quantity.unit.toLowerCase()) || 0, f.quantity.n));
  const weights = new Map(facts.map((f) => [f.key, weigh(f, { peakByUnit, recentFrom: opts.recentFrom })]));

  const base: Candidate[] = facts.map((f) => entryCandidate(f, weights.get(f.key)!, seed, format));
  const casework = opts.casework ? caseworkCandidate(opts.casework, opts.names.mission) : null;
  if (casework && !exclude.has(casework.key)) base.push(casework);
  const summaries = areas.map((a) => summaryCandidate(a, facts.filter((f) => f.area === a), metrics)).filter((c): c is Candidate => Boolean(c && !exclude.has(c.key)));
  const groups = groupsOf(facts).filter((g) => !exclude.has(g.key));

  // Several plans, kept by what they say: each entry's weight counts once if a sentence speaks for it. Entry by entry or
  // with the same work totalled; picked by what says the most for its space, or by what says the most outright.
  const groupCands = groups.map((g) => groupCandidate(g, weights, seed));
  const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.key)));
  const plans: Array<{ cands: Candidate[]; chosen: Chosen[] }> = [];
  const pinned = new Set(opts.pin || []);
  for (const cands of [
    [...base, ...summaries],
    [...base.filter((c) => !(c.kind === 'entry' && grouped.has(c.key) && !pinned.has(c.key))), ...groupCands, ...summaries],
  ]) for (const strategy of ['density', 'value'] as const) plans.push({ cands, chosen: select(cands, o, layout, strategy) });
  const value = (chosen: Chosen[]) => {
    const covered = new Set(chosen.flatMap((x) => x.c.covers));
    let v = 0;
    for (const f of facts) if (covered.has(f.key)) v += weights.get(f.key)!.score;
    if (casework && covered.has('casework')) v += casework.weighed.score;
    // Three sentences in one area opening with the same verb read as a list, which a total says better.
    const openers = new Map<string, number>();
    for (const x of chosen) if (x.c.verb && x.c.kind !== 'summary') openers.set(`${x.c.area}|${x.c.verb}`, (openers.get(`${x.c.area}|${x.c.verb}`) || 0) + 1);
    const repeats = [...openers.values()].reduce((t, k) => t + Math.max(0, k - 2), 0);
    // A full sentence says a little more than its compact form; a fuller page a little more than a sparse one.
    return v - repeats * 0.6 - chosen.filter((x) => x.compact).length * 0.15 + assemble(chosen, layout).text.length / 10000;
  };
  const best = plans.reduce((a, b) => (value(b.chosen) > value(a.chosen) + 1e-9 ? b : a));
  const cands = best.cands;
  const chosen = best.chosen;

  const { text, ordered, texts } = assemble(chosen, layout);
  const sentences = ordered.map((x) => toSentence(x.c, x.compact, x.pinned, texts.get(x.c.key)));
  const coveredKeys = new Set(sentences.flatMap((s) => s.covers));
  const left = cands
    .filter((c) => c.kind !== 'summary' && !chosen.some((x) => x.c.key === c.key) && c.covers.some((k) => !coveredKeys.has(k)))
    .sort((a, b) => b.weighed.score - a.weighed.score)
    .map((c) => toSentence(c, false, false));
  // Entries a group was built from are offered on their own too, so one can be pinned in place of the total.
  for (const f of facts) {
    if (coveredKeys.has(f.key) || left.some((s) => s.covers.includes(f.key))) continue;
    left.push(toSentence(entryCandidate(f, weights.get(f.key)!, seed, format), false, false));
  }

  const omitted = facts.filter((f) => !coveredKeys.has(f.key)).length;
  const areaRows = areas
    .map((area) => {
      const mine = facts.filter((f) => f.area === area);
      return {
        area, label: opts.labels[area] || area.toUpperCase(), count: mine.length,
        included: sentences.filter((s) => s.area === area && s.kind !== 'summary').length,
        available: cands.filter((c) => c.area === area && c.kind !== 'summary').length,
        inferred: mine.filter((f) => f.areaInferred).length,
      };
    })
    .filter((a) => a.count || sentences.some((s) => s.area === a.area));

  const written = {
    text, length: text.length, limit: opts.limit, fits: text.length <= opts.limit, periodLabel: opts.periodLabel, used: sentences.length, omitted,
    areas: areaRows, sentences, left, facts, held, seed, density: opts.density ?? 'auto', format, spellOut: Boolean(opts.spellOut),
  };
  return { ...written, review: reviewWriting(written, { areas: opts.areas, labels: opts.labels, names: opts.names, track: opts.track ?? 'jepes', facts: read }) };
}
