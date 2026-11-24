import { formatNumber } from '../metrics.ts';

/**
 * The one grade for written input (ADR-0045): the same five parts for the narrative the writer wrote and for the text
 * the Marine edited, so the grade moves only when what the text says moves. Vantage's own measure of how the input
 * reads; the reporting chain marks the evaluation.
 */
export type PartKey = 'coverage' | 'outcomes' | 'measured' | 'verbs' | 'fit';

export const GRADE_PARTS: ReadonlyArray<{ key: PartKey; label: string; of: number }> = [
  { key: 'coverage', label: 'Areas covered', of: 25 },
  { key: 'outcomes', label: 'Outcomes stated', of: 25 },
  { key: 'measured', label: 'Numbers', of: 20 },
  { key: 'verbs', label: 'Strong openings', of: 15 },
  { key: 'fit', label: 'Length', of: 15 },
];

export type Grade = 'Strong' | 'Solid' | 'Needs work' | 'Thin' | 'Empty';

/** Where each grade starts, highest first. */
export const GRADE_BANDS: ReadonlyArray<{ from: number; grade: Exclude<Grade, 'Empty'> }> = [
  { from: 85, grade: 'Strong' }, { from: 70, grade: 'Solid' }, { from: 50, grade: 'Needs work' }, { from: 0, grade: 'Thin' },
];

/** What the panel says under the ring: how the number is made. */
export const GRADE_NOTE = `The five parts below add up to the grade: ${GRADE_BANDS.slice(0, 3).map((b) => `${b.grade} from ${b.from}`).join(', ')}, Thin below that.`;

export const gradeFor = (score: number, any: boolean): Grade => (!any ? 'Empty' : GRADE_BANDS.find((b) => score >= b.from)!.grade);

/**
 * One sentence of the text, read for the grade. A sentence the writer wrote keeps the reading of the entries it came
 * from (`entry`); a sentence typed or changed in an edit is read from its words (`typed`).
 */
export interface Reading {
  area: string;
  /** A claim of work done. The rest-of-area summary counts for its area, not as a claim of its own. */
  claim: boolean;
  opens: boolean;
  number: boolean;
  outcome: boolean;
  from: 'entry' | 'typed';
}

export interface ReviewPart {
  key: PartKey;
  label: string;
  earned: number;
  of: number;
  /** Why it scored that way: "3 of 4 sentences". */
  note: string;
  /** The field it read, in the form's own words: "Result", "Your edited text". */
  from: string;
  /** What would bring the part to full, and the points that is worth on it. */
  raise: { text: string; points: number } | null;
}

export interface GradeLayout {
  /** The areas the text is expected to cover. */
  expected: readonly string[];
  length: number;
  limit: number;
  /** What the form calls an entry's area: "JEPES area", "FITREP section". */
  areaField: string;
  /** Whether the text is the Marine's edit, which changes how a raise is said. */
  edited: boolean;
}

/** The field each part reads on an entry, in the labels of the activity form. */
const FIELD: Record<Exclude<PartKey, 'fit'>, (areaField: string) => string> = {
  coverage: (areaField) => areaField,
  outcomes: () => 'Result',
  measured: () => 'Action amount, Transaction value, or a number in Title or Result',
  verbs: () => 'the first word of Title',
};

const share = (of: number, k: number, n: number) => (n ? Math.round((of * k) / n) : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;
// Area names hold "and" of their own ("Intellect and Wisdom"), so a list of more than one quotes each.
const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).map((i) => `“${i}”`).join(', ')} and “${items.at(-1)}”`);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Result", or for an edit with typed sentences, "Result (3) and your edited text (1)". */
function source(field: string, entry: number, typed: number): string {
  if (!typed) return capital(field);
  if (!entry) return 'Your edited text';
  return `${capital(field)} (${formatNumber(entry)}) and your edited text (${formatNumber(typed)})`;
}

/**
 * What a part short of full asks for, and the points that is worth. For the written text, the field to fill in on the
 * entries; for an edit, what to write, since an entry changed later does not change text already edited.
 */
function ask(short: number, points: number, edited: boolean, forEntry: (n: number) => string, forEdit: (n: number) => string) {
  if (!points || !short) return null;
  return { text: capital(edited ? forEdit(short) : forEntry(short)), points };
}

/**
 * Grades read sentences on the one scale. Each part says how many sentences met it, which field it read, and what
 * would bring it to full; on an edit, `from` counts apart what came from entries and what was read from the typed words.
 */
export function gradeOf(readings: readonly Reading[], layout: GradeLayout): { score: number; grade: Grade; parts: ReviewPart[] } {
  const claims = readings.filter((r) => r.claim);
  const covered = layout.expected.filter((a) => readings.some((r) => r.area === a));
  const missingAreas = layout.expected.filter((a) => !covered.includes(a));
  const fits = layout.length <= layout.limit;
  const typedClaims = claims.filter((r) => r.from === 'typed').length;
  const sentences = (n: number) => plural(n, 'sentence');
  const of = (key: PartKey) => GRADE_PARTS.find((p) => p.key === key)!;

  const coverageEarned = share(of('coverage').of, covered.length, layout.expected.length);
  const areaTyped = readings.filter((r) => r.from === 'typed').length;
  const parts: ReviewPart[] = [{
    ...of('coverage'), earned: coverageEarned, note: `${covered.length} of ${plural(layout.expected.length, 'area')}`,
    from: areaTyped ? source(`each entry's ${FIELD.coverage(layout.areaField)}`, readings.length - areaTyped, areaTyped) : capital(`each entry's ${FIELD.coverage(layout.areaField)}`),
    raise: missingAreas.length ? { text: layout.edited ? `Add a sentence under ${list(missingAreas)}` : `Log work under ${list(missingAreas)}`, points: of('coverage').of - coverageEarned } : null,
  }];

  const claimPart = (key: 'outcomes' | 'measured' | 'verbs', pick: (r: Reading) => boolean, forEntry: (n: number) => string, forEdit: (n: number) => string) => {
    const met = claims.filter(pick).length;
    const earned = share(of(key).of, met, claims.length);
    parts.push({
      ...of(key), earned, note: `${met} of ${sentences(claims.length)}`,
      from: source(FIELD[key](layout.areaField), claims.length - typedClaims, typedClaims),
      // With no sentence that claims work (only the rest-of-area summary), what raises it is one that does.
      raise: claims.length ? ask(claims.length - met, of(key).of - earned, layout.edited, forEntry, forEdit)
        : readings.length ? { text: layout.edited ? 'Add a sentence that says what you did, with a number and what came of it' : 'Log work with a Title that says what you did, a number and a Result', points: of(key).of }
        : null,
    });
  };
  claimPart('outcomes', (r) => r.outcome, (n) => `fill in Result on the entries behind ${sentences(n)}`, (n) => `say what came of the work in ${sentences(n)}`);
  claimPart('measured', (r) => r.number, (n) => `add an Action amount or Transaction value to the entries behind ${sentences(n)}`, (n) => `put a number in ${sentences(n)}`);
  claimPart('verbs', (r) => r.opens, (n) => `start the Title of the entries behind ${sentences(n)} with a past-tense verb for what you did`, (n) => `start ${sentences(n)} with a past-tense verb for what you did`);

  // The length: full from 60% of the limit, 10 from 35%, 5 for any text that fits, none over the limit.
  const fit = of('fit');
  const full = Math.ceil(layout.limit * 0.6);
  const fitEarned = !fits ? 0 : layout.length >= layout.limit * 0.6 ? 15 : layout.length >= layout.limit * 0.35 ? 10 : layout.length ? 5 : 0;
  parts.push({
    ...fit, earned: fitEarned, note: `${formatNumber(layout.length)} of ${formatNumber(layout.limit)} characters`,
    from: `The text against the ${formatNumber(layout.limit)}-character limit`,
    raise: fitEarned === fit.of || !layout.length ? null
      : !fits ? { text: `Cut ${plural(layout.length - layout.limit, 'character')}`, points: fit.of - fitEarned }
      : { text: layout.edited ? `Bring it to at least ${formatNumber(full)} characters` : `Log more work, with outcomes, to fill at least ${formatNumber(full)} characters`, points: fit.of - fitEarned },
  });

  const score = parts.reduce((t, p) => t + p.earned, 0);
  return { score, grade: gradeFor(score, readings.length > 0), parts };
}
