import { readEntry, type EntryInput, type Issue } from './facts.ts';
import { sentenceFor, type Track } from './realize.ts';
import { JEPES_CORE, type MetricsConfig } from '../constants.ts';
import { FITREP_AREAS, FITREP_NAMES } from './attributes.ts';

const ORDER: Issue['code'][] = ['annual_training', 'rs_judgment', 'outcome', 'vague', 'unmeasured', 'weak_verb', 'no_verb', 'superlative', 'cliche', 'speculative', 'passive', 'long'];
const SINGLE = { names: { mission: 'MOS / Mission Accomplishment', leadership: 'Leadership', character: 'Individual Character', intellect: 'Individual Character' }, areas: JEPES_CORE };
const SINGLE_FITREP = { names: FITREP_NAMES, areas: FITREP_AREAS, track: 'fitrep' as const };

/**
 * One entry, as the writer will use it, and what would make it stronger: for Quick Log and an entry's page, so the
 * coaching a Marine gets while typing is the coaching the narrative's reviewer gives. Notes the writer already acted
 * on (first person removed, area placed) are left out; a hold comes first.
 */
export function coachEntry(entry: EntryInput, track: Track = 'jepes', metrics?: MetricsConfig): { bullet: string; held: string | null; notes: Issue[]; attribute: string | null } {
  const f = readEntry(entry, { ...(track === 'fitrep' ? SINGLE_FITREP : SINGLE), metrics });
  const codes = new Set(f.issues.map((i) => i.code));
  // "Says several instead of a number" already says there is no number.
  const notes = f.issues.filter((i) => ORDER.includes(i.code) && !(i.code === 'unmeasured' && codes.has('vague'))).sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code));
  return { bullet: sentenceFor(f, 'full', 0, track), held: f.held?.reason ?? null, notes, attribute: track === 'fitrep' ? f.attribute : null };
}

/**
 * One entry as the bullet its track writes, the form a package, a record's page and Quick Log show. The command's value
 * types (`metrics`) decide a configured type's money word, as they do in the narrative.
 */
export function bulletFor(entry: EntryInput, track: Track = 'jepes', seed = 0, metrics?: MetricsConfig): string {
  return sentenceFor(readEntry(entry, { ...(track === 'fitrep' ? SINGLE_FITREP : SINGLE), metrics }), 'full', seed, track);
}
