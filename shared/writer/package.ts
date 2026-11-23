import { DEFAULT_METRICS, type MetricsConfig } from '../constants.ts';
import { areaAmong } from '../evaluation.ts';
import { areaNamesFor, type AreaNames, type EntryInput, type Fact } from './facts.ts';
import { byRank, type Tier } from './score.ts';
import { candidatesOf, compileGroups, prepareEntries, restCandidate } from './compose.ts';
import { plain, spellOut, type Track } from './realize.ts';
import { strengthOf } from './strength.ts';

export type PackageForm = 'jepes' | 'fitrep' | 'resume';

export interface PackageBullet {
  /** The entry's id; a compiled total has none of its own and lists its entries in `sources`. */
  id?: string;
  key: string;
  kind: 'entry' | 'group';
  text: string;
  date?: string | null;
  /** Points of five (strength.ts); a total takes its strongest entry's. */
  strength: number;
  tier: Tier;
  sources: string[];
}

export interface PackageHeld { id?: string; key: string; text: string; reason: string }

export interface PackageGroup {
  area: string;
  /** Entries in the area, held ones included. */
  count: number;
  /** Entries the cap leaves without a bullet of their own. */
  withheld: number;
  /** What the cap leaves out, said once after the bullets, when it adds up to anything. */
  rollup: string | null;
  /** Entries the cap leaves out that the rollup does not speak for (no figure to add up): counted, so none is lost. */
  unlisted: number;
  bullets: PackageBullet[];
  /** Entries the writer holds back (required annual training, work logged twice), with the reason. */
  held: PackageHeld[];
}

export interface PackageOptions {
  form?: PackageForm;
  /** The report's track, which decides what is held and where it is listed; the form decides only the wording. */
  track?: Track;
  areas: readonly string[];
  names?: AreaNames;
  limitPerArea?: number;
  metrics?: MetricsConfig;
  recentFrom?: string | null;
}

/**
 * The bullet package, written by the narrative's writer: every entry read once (prepareEntries), the same work
 * compiled into one total (compileGroups), each area's bullets ranked as the narrative ranks them (measured outcome
 * first), capped, and what the cap leaves out said once after them. An entry's bullet is the sentence its record page
 * shows; a held entry is listed with its reason, never bulleted. The résumé form is the JEPES text with each acronym
 * spelled out once, in reading order, in plain characters.
 */
export function writePackage(entries: EntryInput[], o: PackageOptions): PackageGroup[] {
  const form = o.form ?? 'jepes';
  // Wording follows the bullet style; what is held follows the report, so a JEPES report in FITREP style never points
  // to a worksheet it does not have, and a FITREP one never cites the JEPES order.
  const track: Track = form === 'fitrep' ? 'fitrep' : 'jepes';
  const reportTrack: Track = o.track ?? track;
  const metrics = o.metrics ?? DEFAULT_METRICS;
  const areas = o.areas;
  const cap = o.limitPerArea == null ? Infinity : Math.max(0, Math.floor(o.limitPerArea));
  // An entry counts under its area by that area's name in this package's track; untagged work is listed apart.
  const placed = entries.map((e) => ({ ...e, eval_area: areaAmong(e.eval_area, areas) }));
  const bucket = placed.map((e) => e.eval_area);
  const prepared = prepareEntries(placed, { names: o.names ?? areaNamesFor(areas), areas, metrics, track: reportTrack, recentFrom: o.recentFrom });
  // prepareEntries reads every entry in order; nothing is excluded here, so read[i] is entries[i].
  prepared.read.forEach((f, i) => { f.area = bucket[i]; });
  const areaOf = new Map(prepared.read.map((f) => [f.key, f.area]));
  const byKey = new Map(prepared.facts.map((f) => [f.key, f]));
  const groups = compileGroups(prepared.facts, 0, track);
  const cands = candidatesOf(prepared.facts, prepared.weights, groups, 0, track);
  const ctx = { facts: prepared.facts, metrics, seed: 0, track, exclude: new Set<string>() };
  const order = [...areas, ...(bucket.some((b) => !areas.includes(b)) ? ['Unassigned'] : [])];

  const out = order.map((area): PackageGroup => {
    // Array sort is stable: candidates that rank alike keep the record's order.
    const mine = cands.filter((c) => c.area === area).sort((a, b) => byRank(a.weighed, b.weighed));
    const shown = cap === Infinity ? mine : mine.slice(0, cap);
    const rest: Fact[] = mine.slice(shown.length).flatMap((c) => c.covers.map((k) => byKey.get(k)!).filter(Boolean));
    const said = new Set(shown.map((c) => c.counted).filter((k): k is string => Boolean(k)));
    const bullets = shown.map((c): PackageBullet => {
      const members = c.covers.map((k) => byKey.get(k)!).filter(Boolean);
      const dates = members.map((m) => m.date).filter((d): d is string => Boolean(d)).sort();
      return {
        id: c.kind === 'entry' ? c.sources[0] : undefined, key: c.key, kind: c.kind === 'group' ? 'group' : 'entry', text: c.full,
        date: dates.at(-1) ?? null, strength: Math.max(0, ...members.map((m) => strengthOf(m).points)), tier: c.weighed.tier, sources: [...new Set(c.sources)],
      };
    });
    const roll = restCandidate(area, rest, said, ctx);
    const spoken = new Set(roll?.speaks ?? []);
    return {
      area,
      count: bucket.filter((b) => b === area).length,
      withheld: rest.length,
      rollup: roll?.full ?? null,
      unlisted: rest.filter((f) => !spoken.has(f.key)).length,
      bullets,
      held: prepared.held.filter((h) => areaOf.get(h.key) === area).map((h) => ({ id: h.sources[0], key: h.key, text: h.text, reason: h.reason })),
    };
  });
  if (form !== 'resume') return out;
  // Spelled out once across the package, in the order it reads: bullets, then the area's rollup.
  const texts = spellOut(out.flatMap((g) => [...g.bullets.map((b) => b.text), ...(g.rollup ? [g.rollup] : [])]));
  let i = 0;
  for (const g of out) {
    for (const b of g.bullets) b.text = plain(texts[i++]);
    if (g.rollup) g.rollup = plain(texts[i++]);
  }
  return out;
}
