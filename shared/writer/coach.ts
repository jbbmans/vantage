import { readEntry, type EntryInput, type Fact, type Issue } from './facts.ts';
import { plain, sentenceFor, spellOut, type Track } from './realize.ts';
import { strengthOf, type Strength } from './strength.ts';
import { JEPES_CORE, type MetricsConfig } from '../constants.ts';
import { areaAmong } from '../evaluation.ts';
import { FITREP_AREAS, FITREP_NAMES } from './attributes.ts';

const ORDER: Issue['code'][] = ['annual_training', 'rs_judgment', 'billet', 'outcome', 'vague', 'unmeasured', 'weak_verb', 'no_verb', 'superlative', 'cliche', 'speculative', 'passive', 'long'];
const SINGLE = { names: { mission: 'MOS / Mission Accomplishment', leadership: 'Leadership', character: 'Individual Character', intellect: 'Individual Character' }, areas: JEPES_CORE };
const SINGLE_FITREP = { names: FITREP_NAMES, areas: FITREP_AREAS, track: 'fitrep' as const };

/**
 * One entry read for one track. The area is read by its name in that track, as a breakdown reads it (areaAmong): a
 * Sgt's "MOS / Mission Accomplishment" is FITREP "Mission Accomplishment", and is tagged either way.
 */
export function readOne(entry: EntryInput, track: Track = 'jepes', metrics?: MetricsConfig): Fact {
  const single = track === 'fitrep' ? SINGLE_FITREP : SINGLE;
  return readEntry({ ...entry, eval_area: areaAmong(entry.eval_area, single.areas) }, { ...single, metrics });
}

export interface Coaching { bullet: string; held: string | null; notes: Issue[]; attribute: string | null; strength: Strength; resume: string }

/**
 * One entry, as the writer will use it, and what would make it stronger: for Quick Log and an entry's page, so the
 * coaching a Marine gets while typing is the coaching the narrative's reviewer gives. Notes the writer already acted
 * on (first person removed, area placed) are left out; a hold comes first. The strength badge and the résumé line are
 * read from the same reading, so the four agree.
 */
export function coachEntry(entry: EntryInput, track: Track = 'jepes', metrics?: MetricsConfig): Coaching {
  const f = readOne(entry, track, metrics);
  const codes = new Set(f.issues.map((i) => i.code));
  // "Says several instead of a number" already says there is no number; a billet note already asks for the outcome.
  const said = (code: Issue['code']) => (code === 'unmeasured' && codes.has('vague')) || ((code === 'outcome' || code === 'no_verb') && codes.has('billet'));
  const notes = f.issues.filter((i) => ORDER.includes(i.code) && !said(i.code)).sort((a, b) => ORDER.indexOf(a.code) - ORDER.indexOf(b.code));
  return {
    bullet: sentenceFor(f, 'full', 0, track), held: f.held?.reason ?? null, notes, attribute: track === 'fitrep' ? f.attribute : null,
    strength: strengthOf(f), resume: resumeFor(entry, metrics),
  };
}

/**
 * One entry as the bullet its track writes, the form a package, a record's page and Quick Log show. The command's value
 * types (`metrics`) decide a configured type's money word, as they do in the narrative.
 */
export function bulletFor(entry: EntryInput, track: Track = 'jepes', seed = 0, metrics?: MetricsConfig): string {
  return sentenceFor(readOne(entry, track, metrics), 'full', seed, track);
}

/**
 * One entry for a résumé: the JEPES sentence with each acronym spelled out ("Reconciled 14 unliquidated obligations
 * (ULOs) ..."), in plain characters. The same sentence, so a résumé never says what the record does not.
 */
export function resumeFor(entry: EntryInput, metrics?: MetricsConfig): string {
  return plain(spellOut([bulletFor(entry, 'jepes', 0, metrics)])[0]);
}

/** An entry's strength, five points, read the way the writer reads it (strength.ts). */
export function entryStrength(entry: EntryInput, track: Track = 'jepes', metrics?: MetricsConfig): Strength {
  return strengthOf(readOne(entry, track, metrics));
}
