import { DEFAULT_METRICS, valueType, type MetricsConfig } from '../constants.ts';
import { unitFor } from './units.ts';
import { formatNumber } from '../metrics.ts';
import { readEntry, unitIdentity, type AreaNames, type EntryInput, type Fact } from './facts.ts';
import { BAND, BAND_SPAN, byRank, weigh, type Tier, type Weighed } from './score.ts';
import { markRepeats } from './repeats.ts';
import { VERB_FORMS } from './lexicon.ts';
import { connectorFor, dollars, restSentence, sentenceFor, sentenceForGroup, spellOut, finish, type Density, type Format, type Group, type Track } from './realize.ts';
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
  /** Whether the text carries a heading (bullets) or label (paragraph) per area. Section C is one list with none. */
  headings?: boolean;
  /** Spell out standard acronyms on their first use. */
  spellOut?: boolean;
  track?: 'jepes' | 'fitrep';
}

/** An entry a rule keeps out of the input, and the rule. */
export interface Held { key: string; area: string; text: string; reason: string; basis: 'order' | 'guidance' | 'style' | 'data'; cite?: string; sources: string[]; route?: 'pme' | 'other' }

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
  /** What its outcome says: 2 measured, 1 stated, 0 none (score.ts). */
  tier: Tier;
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

export interface Candidate {
  key: string; area: string; kind: SentenceKind; covers: string[]; sources: string[]; weighed: Weighed;
  full: string; compact: string; attribute: string | null; hasResult: boolean; measured: boolean; verb: string | null; verbStrength: number | null;
  /** The work and unit it counts ("reconciled|ulo"), so the rest of the area can say "31 more ULOs". */
  counted?: string | null;
  /** The entries the short form speaks for, when fewer than the full form's (a summary's counts alone). */
  compactSources?: string[];
  /** The entries a summary's figures include, by key, so an entry with no id is known by it too. */
  speaks?: string[];
}

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
function similar(a: string, b: string): boolean {
  const x = tokens(a); const y = tokens(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both) >= 0.7;
}

/**
 * Work a total can add up: a count of things, people or time that the entry's own sentence makes the verb's object
 * ("Reconciled 14 ULOs …", "Trained 3 Marines …", "Volunteered 6 hours …"). Not "Checked on every Marine (6 Marines)"
 * or "Turned in excess equipment (38 items)": "Checked 6 Marines" and "Turned 38 items" would say what the Marine did
 * not.
 */
const objectCounts = new WeakMap<Fact, boolean>();
const countable = (f: Fact, seed: number, track: Track) => {
  if (!f.verb || !f.opener || !f.quantity || f.quantity.kind === 'measure') return false;
  // Where the count goes does not change with the wording or the track; the sentence is read once.
  if (!objectCounts.has(f)) objectCounts.set(f, sentenceFor(f, 'full', seed, track).startsWith(`${f.opener} ${formatNumber(f.quantity.n)} `));
  return objectCounts.get(f)!;
};
export const countedOf = (f: Fact, seed: number, track: Track) => (countable(f, seed, track) ? `${f.verb!.past}|${unitIdentity(f.quantity!.unit)}` : null);

function entryCandidate(f: Fact, w: Weighed, seed: number, track: Track): Candidate {
  return {
    key: f.key, area: f.area, kind: 'entry', covers: [f.key], sources: f.sources, weighed: w,
    full: sentenceFor(f, 'full', seed, track), compact: sentenceFor(f, 'compact', seed, track), attribute: f.attribute,
    hasResult: Boolean(f.result), measured: !f.issues.some((i) => i.code === 'unmeasured' || i.code === 'vague'),
    // A billet named instead of the work opens as weakly as "Helped" does.
    verb: f.verb?.lemma ?? null, verbStrength: f.issues.some((i) => i.code === 'billet') ? 1 : f.verb?.strength ?? null, counted: countedOf(f, seed, track),
  };
}

/**
 * Entries of the same work and unit, compiled: two or more "Reconciled … ULOs" are one total, always, never a sentence
 * each. A total that would add unlike dollars (obligated beside saved, or a kind that does not sum) is not built, and
 * each entry keeps its own figure.
 */
export function compileGroups(facts: Fact[], seed: number, track: Track): Group[] {
  const by = new Map<string, Fact[]>();
  for (const f of facts) {
    if (!countable(f, seed, track)) continue;
    const key = `group:${f.area}:${f.verb!.lemma}:${unitIdentity(f.quantity!.unit)}`;
    by.set(key, [...(by.get(key) || []), f]);
  }
  const out: Group[] = [];
  for (const [key, members] of by) {
    if (members.length < 2) continue;
    const paid = members.filter((m) => m.money?.summable);
    const types = new Set(paid.map((m) => m.money!.type));
    if (types.size > 1 || members.some((m) => m.money && !m.money.summable)) continue;
    const systems = new Set(members.map((m) => m.system));
    // The plural a person typed most often names the unit: "ULOs", not "ulos".
    const unitNames = members.map((m) => m.quantity!.unit);
    const unit = unitNames.sort((a, b) => unitNames.filter((u) => u === b).length - unitNames.filter((u) => u === a).length)[0];
    out.push({
      key, members, verbPast: members[0].verb!.past, unit, n: members.reduce((n, m) => n + m.quantity!.n, 0),
      money: types.size === 1 ? paid.reduce((n, m) => n + m.money!.amount, 0) : 0,
      paidN: types.size === 1 ? paid.reduce((n, m) => n + m.quantity!.n, 0) : 0,
      moneyType: types.size === 1 ? [...types][0] : null,
      system: systems.size === 1 ? [...systems][0] : null,
    });
  }
  return out;
}

function groupCandidate(g: Group, weights: Map<string, Weighed>, seed: number, track: Track): Candidate {
  const members = g.members.map((m) => weights.get(m.key)!);
  // The best member and a little for each more, never above its band: a total of work with no outcome stays below a
  // measured outcome, however many entries it adds up.
  const best = [...members].sort(byRank)[0];
  const score = Math.round(Math.min(best.score + 0.5 * (members.length - 1), BAND[best.tier] + BAND_SPAN) * 10) / 10;
  const first = g.members[0];
  return {
    key: g.key, area: first.area, kind: 'group', covers: g.members.map((m) => m.key), sources: g.members.flatMap((m) => m.sources),
    weighed: { score, tier: best.tier, reasons: [`${g.members.length} entries of the same work, compiled`, ...new Set(members.flatMap((w) => w.reasons).filter((r) => /outcome/.test(r) && r !== 'no outcome'))] },
    full: sentenceForGroup(g, 'full', seed, track), compact: sentenceForGroup(g, 'compact', seed, track), attribute: first.attribute,
    hasResult: g.members.some((m) => m.result), measured: true, verb: first.verb?.lemma ?? null, verbStrength: first.verb?.strength ?? null,
    counted: countedOf(first, seed, track),
  };
}

export interface RestContext { facts: Fact[]; metrics: MetricsConfig; seed: number; track: Track; exclude: Set<string> }

/**
 * The rest of an area: counted work and money that has no sentence of its own, once two or more entries are left, said
 * in one sentence that opens with a verb. Only what no chosen sentence says, so no figure is claimed twice; "more" when
 * a sentence already counts the same work ("Reconciled 31 more ULOs"). Only work a total can add up (`countable`) and
 * dollars that sum; the sentence names only the entries a figure in it comes from, and none is written for one entry.
 */
export function restCandidate(area: string, rest: Fact[], said: Set<string>, ctx: RestContext): Candidate | null {
  if (rest.length < 2) return null;
  const counts = new Map<string, { past: string; unit: string; n: number; facts: Fact[] }>();
  const money = new Map<string, { amount: number; facts: Fact[] }>();
  const addMoney = (f: Fact) => {
    const type = f.money!.type || '';
    const was = money.get(type) ?? { amount: 0, facts: [] };
    money.set(type, { amount: was.amount + f.money!.amount, facts: [...was.facts, f] });
  };
  for (const f of rest) {
    const key = countedOf(f, ctx.seed, ctx.track);
    if (key) {
      const was = counts.get(key) ?? { past: f.verb!.past, unit: f.quantity!.unit, n: 0, facts: [] };
      was.n += f.quantity!.n;
      was.facts.push(f);
      counts.set(key, was);
    } else if (f.money?.summable) addMoney(f);
  }
  const parts: string[] = [];
  const counted: string[] = [];
  // The entries a figure comes from, for each form; the studio's card lists them.
  const from = new Set<Fact>();
  const fromCounted = new Set<Fact>();
  for (const [key, c] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3)) {
    const part = `${c.past} ${formatNumber(c.n)} ${said.has(key) ? 'more ' : ''}${unitFor(c.unit, c.n)}`;
    counted.push(part);
    for (const f of c.facts) { from.add(f); fromCounted.add(f); }
    // Dollars of one kind ride on their count, in the word every sentence of that kind uses; the rest by kind below.
    const paid = c.facts.filter((f) => f.money?.summable);
    const types = new Set(paid.map((f) => f.money!.type));
    const joint = paid.length && types.size === 1 ? connectorFor([...types][0], true, ctx.seed, c.facts[0].verb) : null;
    if (joint && !joint.tail) { parts.push(`${part} ${joint.word} ${dollars(paid.reduce((n, f) => n + f.money!.amount, 0), 'full', ctx.track)}`); continue; }
    for (const f of paid) addMoney(f);
    parts.push(part);
  }
  // Money by its kind's own verb ("obligated $40K"); a kind with no verb of its own is not said.
  for (const [type, m] of [...money.entries()].sort((a, b) => b[1].amount - a[1].amount).slice(0, 2)) {
    const verb = String(valueType(type, ctx.metrics)?.verb || '').toLowerCase();
    if (VERB_FORMS.get(verb)?.form !== 'past') continue;
    parts.push(`${verb} ${dollars(m.amount, 'full', ctx.track)}`);
    for (const f of m.facts) from.add(f);
  }
  if (from.size < 2) return null;
  const full = restSentence(parts);
  if (!full) return null;
  // Short of room, the counts alone ("Reconciled 14 ULOs and corrected 6 rejects."), when they still speak for two.
  const short = fromCounted.size >= 2 ? restSentence(counted) : null;
  return {
    key: `summary:${area}`, area, kind: 'summary', covers: [], sources: [...from].flatMap((f) => f.sources), weighed: { score: 0.5, tier: 0, reasons: ['the rest of this area, said once'] },
    full, compact: short ?? full, attribute: null, hasResult: false, measured: true, verb: null, verbStrength: null,
    compactSources: short ? [...fromCounted].flatMap((f) => f.sources) : undefined,
    speaks: [...from].map((f) => f.key),
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
  // Verified and resolved cases are measured outcomes; research alone is work with no outcome yet.
  const tier: Tier = c.verified || c.resolved ? 2 : 0;
  const score = Math.round((BAND[tier] + Math.min(2, Math.log10(c.researched + 1))) * 10) / 10;
  return {
    key: 'casework', area, kind: 'casework', covers: ['casework'], sources: ['casework'],
    weighed: { score, tier, reasons: ['from your case histories', ...(c.verified ? [`${c.verified} verified outcomes`] : [])] },
    full: text, compact: text, attribute: 'Performance', hasResult: Boolean(c.verified || c.resolved), measured: true, verb: 'research', verbStrength: 2,
  };
}

interface Chosen { c: Candidate; compact: boolean; pinned: boolean }

interface Layout { areas: readonly string[]; labels: Record<string, string>; headers: Record<string, string>; headings: boolean; format: Format; spell: boolean }

function assemble(chosen: Chosen[], layout: Layout): { text: string; ordered: Chosen[]; texts: Map<string, string> } {
  const { areas } = layout;
  const ordered: Chosen[] = [];
  for (const area of areas) {
    let mine = chosen.filter((x) => x.c.area === area);
    if (!mine.length) continue;
    const rank = (x: Chosen) => (x.c.kind === 'casework' ? 0 : x.c.kind === 'summary' ? 2 : 1);
    mine = mine.sort((a, b) => rank(a) - rank(b) || byRank(a.c.weighed, b.c.weighed));
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
    const lines = mine.map((t) => `-${t}`).join('\n');
    blocks.push(layout.format === 'bullets'
      ? (layout.headings ? `${layout.headers[area] || area}\n${lines}` : lines)
      : (layout.headings ? `${layout.labels[area] || area.toUpperCase()}: ${mine.join(' ')}` : mine.join(' ')));
  }
  const text = layout.format === 'bullets' ? blocks.join('\n').trim() : blocks.join(' ').replace(/\s{2,}/g, ' ').trim();
  return { text, ordered, texts };
}

type Strategy = 'value' | 'density';

function select(cands: Candidate[], opts: WriterOptions, layout: Layout, strategy: Strategy, ctx: RestContext): Chosen[] {
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
    const best = cands.filter((c) => c.area === area && c.kind !== 'summary').sort((a, b) => byRank(a.weighed, b.weighed));
    // Not with a line that says next to nothing: an empty area is a finding the Marine can act on, filler is not.
    for (const c of best) if ((c.weighed.score >= 1 || pin.has(c.key)) && tryAdd(c)) break;
  }
  // Then what says the most: for the space it takes, or outright. writeNarrative tries both and keeps the better.
  const rank = strategy === 'density' ? (c: Candidate) => c.weighed.score / c.full.length : (c: Candidate) => c.weighed.score;
  // A sentence that says next to nothing ("Helped with the close out") is offered back rather than used as filler.
  // An outcome first, whatever the strategy: a short line with no outcome never takes the place of one with one.
  const rest = cands.filter((c) => c.kind !== 'summary' && (c.weighed.score >= 1 || pin.has(c.key))).sort((a, b) => b.weighed.tier - a.weighed.tier || rank(b) - rank(a));
  for (const c of rest) tryAdd(c);
  // What is counted or paid and still has no sentence is said once, per area; what a sentence says is never said again.
  for (const area of opts.areas) {
    if (ctx.exclude.has(`summary:${area}`)) continue;
    const rest = ctx.facts.filter((f) => f.area === area && !covered.has(f.key) && (countable(f, ctx.seed, ctx.track) || f.money?.summable));
    const said = new Set(chosen.filter((x) => x.c.area === area && x.c.counted).map((x) => x.c.counted!));
    const c = restCandidate(area, rest, said, ctx);
    // "Always keep" holds for the summary as for any sentence.
    if (c) tryAdd(c, pin.has(c.key));
  }
  // Pinned sentences can push the text over; what is not pinned goes first, weakest first.
  while (length() > opts.limit) {
    const drop = chosen.filter((x) => !x.pinned).sort((a, b) => byRank(b.c.weighed, a.c.weighed))[0];
    if (!drop) break;
    chosen.splice(chosen.indexOf(drop), 1);
  }
  return chosen;
}

const toSentence = (c: Candidate, compact: boolean, pinned: boolean, text?: string): Sentence => ({
  key: c.key, area: c.area, kind: c.kind, text: text ?? (compact ? c.compact : c.full), sources: [...new Set(compact && c.compactSources ? c.compactSources : c.sources)], covers: c.covers,
  score: c.weighed.score, tier: c.weighed.tier, reasons: c.weighed.reasons, attribute: c.attribute, compact, pinned, hasResult: c.hasResult, measured: c.measured,
  verb: c.verb, verbStrength: c.verbStrength,
});

/** What every output starts from: the entries read, the same work logged twice held once, the rules' holds, and each weight. */
export interface Prepared { read: Fact[]; facts: Fact[]; held: Held[]; weights: Map<string, Weighed> }

/**
 * Reads the entries the one way every output uses (the narrative, the package, the record's bullet and badge): each is
 * read and cleaned, work logged twice is held once (repeats.ts), what a rule keeps out is held with the rule, and the
 * rest are weighed against each other. A kept (pinned) entry is never held.
 */
export function prepareEntries(entries: EntryInput[], o: { names: AreaNames; areas: readonly string[]; metrics?: MetricsConfig; track?: Track; pin?: readonly string[]; exclude?: readonly string[]; recentFrom?: string | null; seed?: number }): Prepared {
  const metrics = o.metrics ?? DEFAULT_METRICS;
  const track: Track = o.track ?? 'jepes';
  const exclude = new Set(o.exclude || []);
  const pins = new Set(o.pin || []);
  // An entry with no id is known by its title; two such entries with the same title are told apart by their order,
  // so neither takes the other's place (weights, areas and what is covered are all kept by key).
  const used = new Set<string>();
  const read = entries.map((e) => {
    const f = readEntry(e, { names: o.names, areas: o.areas, metrics, track });
    let key = f.key;
    if (!e.id) for (let n = 2; used.has(key); n += 1) key = `${f.key}#${n}`;
    used.add(key);
    return key === f.key ? f : { ...f, key };
  }).filter((f) => !exclude.has(f.key));
  markRepeats(read, pins);
  // What a rule keeps out (required annual training) is set aside with the rule, never written and never lost.
  const held: Held[] = read.filter((f) => f.held && !pins.has(f.key)).map((f) => ({ key: f.key, area: f.area, text: sentenceFor(f, 'full', o.seed ?? 0, track), reason: f.held!.reason, basis: f.held!.basis, cite: f.held!.cite, sources: f.sources, route: f.held!.route }));
  const facts = read.filter((f) => !f.held || pins.has(f.key));
  const peakByUnit = new Map<string, number>();
  for (const f of facts) if (f.quantity?.kind === 'item') peakByUnit.set(f.quantity.unit.toLowerCase(), Math.max(peakByUnit.get(f.quantity.unit.toLowerCase()) || 0, f.quantity.n));
  const weights = new Map(facts.map((f) => [f.key, weigh(f, { peakByUnit, recentFrom: o.recentFrom })]));
  return { read, facts, held, weights };
}

/** The candidates an area offers, compiled: a total for each kind of work done more than once, a sentence for the rest. */
export function candidatesOf(facts: Fact[], weights: Map<string, Weighed>, groups: Group[], seed: number, track: Track): Candidate[] {
  const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.key)));
  return [
    ...facts.filter((f) => !grouped.has(f.key)).map((f) => entryCandidate(f, weights.get(f.key)!, seed, track)),
    ...groups.map((g) => groupCandidate(g, weights, seed, track)),
  ];
}

/**
 * Writes the narrative: reads every entry, weighs it, and fills the character limit with what says the most about the
 * work, area by area. The same work is one total, said once (compileGroups); the rest of an area is summed in one
 * sentence when it does not fit. Each sentence keeps the entries it came from, its score and the reasons for it.
 */
export function writeNarrative(entries: EntryInput[], opts: WriterOptions): WrittenNarrative {
  const metrics = opts.metrics ?? DEFAULT_METRICS;
  const seed = opts.seed ?? 0;
  const exclude = new Set(opts.exclude || []);
  const format: Format = opts.format ?? 'paragraph';
  const track: Track = opts.track ?? 'jepes';
  const prepared = prepareEntries(entries, { names: opts.names, areas: opts.areas, metrics, track, pin: opts.pin, exclude: opts.exclude, recentFrom: opts.recentFrom, seed });
  const { read, held, weights } = prepared;
  let facts = prepared.facts;
  // Leaving a total out leaves its work out; keeping one of its entries keeps the total.
  let groups = compileGroups(facts, seed, track);
  const dropped = new Set(groups.filter((g) => exclude.has(g.key)).flatMap((g) => g.members.map((m) => m.key)));
  if (dropped.size) { facts = facts.filter((f) => !dropped.has(f.key)); groups = groups.filter((g) => !exclude.has(g.key)); }
  const pin = new Set(opts.pin || []);
  for (const g of groups) if (g.members.some((m) => pin.has(m.key))) pin.add(g.key);
  const areas = [...opts.areas];
  for (const f of facts) if (!areas.includes(f.area)) areas.push(f.area);
  const o: WriterOptions = { ...opts, areas, pin: [...pin] };
  const layout: Layout = { areas, labels: opts.labels, headers: opts.headers || {}, headings: opts.headings ?? true, format, spell: Boolean(opts.spellOut) };

  const cands = candidatesOf(facts, weights, groups, seed, track);
  const casework = opts.casework ? caseworkCandidate(opts.casework, opts.names.mission) : null;
  if (casework && !exclude.has(casework.key)) cands.push(casework);

  // Two plans, kept by what they say: each entry's weight counts once if a sentence speaks for it. Picked by what says
  // the most for its space, or by what says the most outright.
  const rest: RestContext = { facts, metrics, seed, track, exclude };
  const plans = (['density', 'value'] as const).map((strategy) => select(cands, o, layout, strategy, rest));
  const value = (chosen: Chosen[]) => {
    const covered = new Set(chosen.flatMap((x) => x.c.covers));
    let v = 0;
    for (const f of facts) if (covered.has(f.key)) v += weights.get(f.key)!.score;
    if (casework && covered.has('casework')) v += casework.weighed.score;
    // Three sentences in one area opening with the same verb read as a list.
    const openers = new Map<string, number>();
    for (const x of chosen) if (x.c.verb && x.c.kind !== 'summary') openers.set(`${x.c.area}|${x.c.verb}`, (openers.get(`${x.c.area}|${x.c.verb}`) || 0) + 1);
    const repeats = [...openers.values()].reduce((t, k) => t + Math.max(0, k - 2), 0);
    // A full sentence says a little more than its compact form; a fuller page a little more than a sparse one.
    return v - repeats * 0.6 - chosen.filter((x) => x.compact).length * 0.15 + assemble(chosen, layout).text.length / 10000;
  };
  const chosen = plans.reduce((a, b) => (value(b) > value(a) + 1e-9 ? b : a));

  const { text, ordered, texts } = assemble(chosen, layout);
  const sentences = ordered.map((x) => toSentence(x.c, x.compact, x.pinned, texts.get(x.c.key)));
  const coveredKeys = new Set(sentences.flatMap((s) => s.covers));
  // What was considered and did not fit, best first. A total's entries are never offered on their own: the work is said once.
  const left = cands
    .filter((c) => c.kind !== 'summary' && !chosen.some((x) => x.c.key === c.key) && c.covers.some((k) => !coveredKeys.has(k)))
    .sort((a, b) => byRank(a.weighed, b.weighed))
    .map((c) => toSentence(c, false, false));

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
