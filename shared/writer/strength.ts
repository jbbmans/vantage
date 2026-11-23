import type { Fact } from './facts.ts';

export type StrengthKey = 'opens' | 'number' | 'outcome' | 'measured' | 'area';

/** The five things an entry's strength counts, one point each, in the order the badge lists them. */
export const STRENGTH_POINTS: ReadonlyArray<{ key: StrengthKey; label: string; missing: string }> = [
  { key: 'opens', label: 'Opens with what you did', missing: 'does not open with what you did' },
  { key: 'number', label: 'Has a number', missing: 'no number (how many, how much?)' },
  { key: 'outcome', label: 'States an outcome', missing: 'no stated outcome (so what?)' },
  { key: 'measured', label: 'Measures that outcome', missing: 'the outcome has no measure' },
  { key: 'area', label: 'Tagged to an area', missing: 'not tagged to an evaluation area' },
];

export const STRENGTH_MAX = STRENGTH_POINTS.length;

/** What the badge's tooltip says, everywhere it is shown: exactly what is counted. */
export const STRENGTH_TOOLTIP = 'Strength counts five things, one point each: it opens with what you did, has a number, states an outcome, measures that outcome, and is tagged to an area.';

export interface Strength { points: number; of: number; met: StrengthKey[]; missing: StrengthKey[] }

const OPENING_FAULTS = new Set(['weak_verb', 'no_verb', 'billet', 'passive']);

/**
 * An entry's strength, read from the same Fact the writer writes from, so the badge counts what the bullet says: it
 * opens with a verb that says what was done (not "Helped", not a billet, not passive), it has a number, it states an
 * outcome, the outcome is measured (score.ts reads "measured" the same way), and the Marine tagged its area.
 */
export function strengthOf(f: Fact): Strength {
  const codes = new Set(f.issues.map((i) => i.code));
  const has: Record<StrengthKey, boolean> = {
    opens: Boolean(f.verb) && !f.issues.some((i) => OPENING_FAULTS.has(i.code)),
    number: !codes.has('unmeasured') && !codes.has('vague'),
    outcome: Boolean(f.result),
    measured: f.strongResult,
    area: !f.areaInferred,
  };
  const met = STRENGTH_POINTS.map((p) => p.key).filter((k) => has[k]);
  return { points: met.length, of: STRENGTH_MAX, met, missing: STRENGTH_POINTS.map((p) => p.key).filter((k) => !has[k]) };
}

/** The words for what an entry is missing, for a note under the badge. */
export const missingText = (s: Strength) => s.missing.map((k) => STRENGTH_POINTS.find((p) => p.key === k)!.missing);
