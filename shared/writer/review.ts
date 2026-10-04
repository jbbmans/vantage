import { CLICHE, FIRST_PERSON, GLOSSARY, PASSIVE, RS_JUDGMENT, SUPERLATIVE, VAGUE, WEAK_OPENERS } from './lexicon.ts';
import type { AreaKind, AreaNames, Fact } from './facts.ts';
import type { Held, Sentence } from './compose.ts';

export type FindingTone = 'fix' | 'consider' | 'good';

/**
 * What a finding rests on: an order or its form ("order"), an official publication or the Marine Corps Gazette
 * ("guidance"), a writing preference ("style"), or the Marine's own entries ("data"). Shown with each finding, so a
 * preference is never passed off as a rule.
 */
export type FindingBasis = 'order' | 'guidance' | 'style' | 'data';

export interface Finding {
  id: string;
  tone: FindingTone;
  title: string;
  detail?: string;
  basis?: FindingBasis;
  /** The source, shown beside the finding: "MCO 1616.1, App. E". */
  cite?: string;
  /** The entries that would fix it, to open from the review. */
  sources?: string[];
  area?: string;
  action?: { kind: 'open' | 'log' | 'tag'; prompt?: string };
}

export interface ReviewPart { key: 'coverage' | 'outcomes' | 'measured' | 'verbs' | 'fit'; label: string; earned: number; of: number; note: string }

export interface Review { score: number; grade: 'Strong' | 'Solid' | 'Needs work' | 'Thin' | 'Empty'; parts: ReviewPart[]; findings: Finding[] }

/**
 * What each area looks for when it is empty, as prompts for the Marine. Coaching from what the areas name, not text
 * from an order; the reporting senior's own guidance wins.
 */
export const AREA_PROMPTS: Record<AreaKind, { ask: string; prompt: string }> = {
  mission: { ask: 'Your core work: what you processed, fixed or delivered, with the count and what came of it.', prompt: 'Processed ' },
  leadership: { ask: 'Did you train, mentor, brief or look after anyone, or lead a detail, a working party or PT? Log it with how many Marines.', prompt: 'Trained ' },
  character: { ask: 'Extra work taken on unasked, volunteering, sustained effort, doing the right thing when it cost something. Log one with what it showed.', prompt: 'Volunteered ' },
  intellect: { ask: 'Courses, PME and certifications, and decisions you made or recommended that held up.', prompt: 'Completed ' },
};

const grade = (score: number, any: boolean): Review['grade'] => (!any ? 'Empty' : score >= 85 ? 'Strong' : score >= 70 ? 'Solid' : score >= 50 ? 'Needs work' : 'Thin');
const pct = (n: number, d: number) => (d ? n / d : 0);
const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function kindOf(area: string, names: AreaNames): AreaKind {
  for (const k of Object.keys(names) as AreaKind[]) if (names[k] === area) return k;
  return 'mission';
}

interface Written { text: string; length: number; limit: number; fits: boolean; sentences: Sentence[]; left: Sentence[]; facts: Fact[]; held: Held[]; spellOut: boolean }

const APP_E = 'MCO 1616.1, App. E';
const SECTION_C = 'NAVMC 10835, Section C';
const GAZETTE = 'Marine Corps Gazette';

/**
 * Grades what was written and says what would make it stronger, most useful first. The grade weighs coverage of the
 * areas, outcomes, numbers, verbs and fit; each finding names the entries that would fix it.
 */
export function reviewWriting(n: Written, ctx: { areas: readonly string[]; labels: Record<string, string>; names: AreaNames; track: 'jepes' | 'fitrep'; facts: Fact[] }): Review {
  const jepes = ctx.track === 'jepes';
  const findings: Finding[] = [];
  const claims = n.sentences.filter((s) => s.kind === 'entry' || s.kind === 'group' || s.kind === 'casework');
  // The areas a narrative is expected to cover: the track's own, less evaluation duty unless there is some.
  const expected = ctx.areas.filter((a) => !/evaluation/i.test(a) || n.facts.some((f) => f.area === a));
  const covered = expected.filter((a) => n.sentences.some((s) => s.area === a));

  const parts: ReviewPart[] = [
    { key: 'coverage', label: 'Areas covered', earned: Math.round(25 * pct(covered.length, expected.length)), of: 25, note: `${covered.length} of ${expected.length}` },
    { key: 'outcomes', label: 'Outcomes stated', earned: Math.round(25 * pct(claims.filter((s) => s.hasResult).length, claims.length)), of: 25, note: `${claims.filter((s) => s.hasResult).length} of ${claims.length} sentences` },
    { key: 'measured', label: 'Numbers', earned: Math.round(20 * pct(claims.filter((s) => s.measured).length, claims.length)), of: 20, note: `${claims.filter((s) => s.measured).length} of ${claims.length} sentences` },
    { key: 'verbs', label: 'Strong openings', earned: Math.round(15 * pct(claims.filter((s) => (s.verbStrength ?? 2) >= 2).length, claims.length)), of: 15, note: `${claims.filter((s) => (s.verbStrength ?? 2) >= 2).length} of ${claims.length} sentences` },
    { key: 'fit', label: 'Length', earned: !n.fits ? 0 : n.length >= n.limit * 0.6 ? 15 : n.length >= n.limit * 0.35 ? 10 : n.length ? 5 : 0, of: 15, note: `${n.length} of ${n.limit} characters` },
  ];
  const score = parts.reduce((t, p) => t + p.earned, 0);

  if (!n.fits) findings.push({ id: 'over', tone: 'fix', basis: 'data', title: `${n.length - n.limit} characters over the limit`, detail: 'Pinned sentences are kept even when they do not fit. Unpin one, or leave one out.' });
  for (const h of n.held) {
    findings.push({ id: `held:${h.key}`, tone: 'consider', basis: 'order', cite: APP_E, title: `Held back: “${short(h.text, 52)}”`, detail: `${h.reason} Keep it from Left out if your chain wants it anyway.`, sources: h.sources, area: h.area });
  }

  for (const area of expected) {
    if (n.sentences.some((s) => s.area === area)) continue;
    const kind = kindOf(area, ctx.names);
    findings.push({
      id: `empty:${area}`, tone: 'consider', title: `Nothing for ${area} yet`, area, action: { kind: 'log', prompt: AREA_PROMPTS[kind].prompt },
      detail: jepes ? `${AREA_PROMPTS[kind].ask} Command input is marked on all three lines, and accomplishments should relate directly to them.` : AREA_PROMPTS[kind].ask,
      ...(jepes ? { basis: 'order' as const, cite: APP_E } : { basis: 'style' as const }),
    });
  }

  const used = new Set(n.sentences.flatMap((s) => s.covers));
  const inText = n.facts.filter((f) => used.has(f.key));
  const byScore = (a: Fact, b: Fact) => b.issues.length - a.issues.length;
  const noOutcome = inText.filter((f) => !f.result).sort(byScore);
  for (const f of noOutcome.slice(0, 4)) {
    findings.push({ id: `outcome:${f.key}`, tone: 'fix', basis: 'guidance', cite: jepes ? APP_E : SECTION_C, title: `Add what came of “${short(`${f.opener} ${f.rest}`.trim())}”`, detail: 'A sentence with an outcome is the one your reporting chain can use: what changed, how much, by when.', sources: f.sources, area: f.area, action: { kind: 'open' } });
  }
  if (noOutcome.length > 4) findings.push({ id: 'outcome:more', tone: 'fix', basis: 'guidance', title: `${noOutcome.length - 4} more sentences have no outcome`, detail: 'Filter Activities by “Needs detail” to fix them in one sitting.' });

  // Each check, and what it rests on. "Helped" and the passive are preferences: no order forbids them.
  const CHECKS: Array<{ code: 'rs_judgment' | 'superlative' | 'speculative' | 'cliche' | 'vague' | 'no_verb' | 'weak_verb' | 'passive'; basis: FindingBasis; cite?: string; style?: string }> = [
    { code: 'rs_judgment', basis: 'guidance', cite: 'MCO 1610.7B' },
    { code: 'superlative', basis: jepes ? 'guidance' : 'order', cite: SECTION_C },
    { code: 'speculative', basis: 'guidance', cite: 'FITREP Section C' },
    { code: 'cliche', basis: 'guidance', cite: GAZETTE },
    { code: 'vague', basis: 'guidance', cite: jepes ? APP_E : SECTION_C },
    { code: 'no_verb', basis: 'guidance', cite: jepes ? APP_E : undefined },
    { code: 'weak_verb', basis: 'style', style: 'A preference, not a rule: the reader just learns less.' },
    { code: 'passive', basis: 'style' },
  ];
  for (const check of CHECKS) {
    const hit = ctx.facts.filter((f) => f.issues.some((i) => i.code === check.code));
    for (const f of hit.slice(0, 3)) {
      const issue = f.issues.find((i) => i.code === check.code)!;
      findings.push({
        id: `${check.code}:${f.key}`, tone: 'consider', basis: check.basis, cite: check.cite, title: `${issue.message}: “${short(`${f.opener} ${f.rest}`.trim(), 48)}”`,
        detail: check.style ? `${issue.advice} ${check.style}` : issue.advice, sources: f.sources, area: f.area, action: { kind: 'open' },
      });
    }
  }
  const unmeasured = inText.filter((f) => f.issues.some((i) => i.code === 'unmeasured'));
  if (unmeasured.length) findings.push({ id: 'unmeasured', tone: 'consider', basis: 'order', cite: jepes ? APP_E : SECTION_C, title: `${unmeasured.length} ${unmeasured.length === 1 ? 'sentence has' : 'sentences have'} no number`, detail: 'How many, how much, how fast? One number makes a sentence credible.', sources: unmeasured.flatMap((f) => f.sources), action: { kind: 'open' } });

  const inferred = n.facts.filter((f) => f.areaInferred);
  if (inferred.length) findings.push({ id: 'inferred', tone: 'consider', basis: 'data', title: `${inferred.length} ${inferred.length === 1 ? 'entry has' : 'entries have'} no area`, detail: 'The writer placed them by what they say. Tag them so they land where you mean them to.', sources: inferred.flatMap((f) => f.sources), action: { kind: 'tag' } });

  const strongLeft = n.left.filter((s) => s.score >= 4);
  if (strongLeft.length) findings.push({ id: 'left', tone: 'consider', basis: 'data', title: `${strongLeft.length} strong ${strongLeft.length === 1 ? 'entry' : 'entries'} did not fit`, detail: 'Pin the ones that matter most, leave out a weaker one, or switch to Compact.' });
  if (n.fits && n.length && n.length < n.limit * 0.5) findings.push({ id: 'room', tone: 'consider', basis: 'data', title: `Room for ${n.limit - n.length} more characters`, detail: 'Log more of the work, with outcomes, and the writer will use the space.' });

  const openers = new Map<string, number>();
  for (const s of claims) if (s.verb) openers.set(s.verb, (openers.get(s.verb) || 0) + 1);
  for (const [verb, count] of openers) if (count >= 3) findings.push({ id: `repeat:${verb}`, tone: 'consider', basis: 'style', title: `${count} sentences open with the same verb`, detail: 'Several entries of the same work could be one total; leave one out and the writer groups them.' });

  const unexplained = Object.keys(GLOSSARY).filter((a) => new RegExp(`(?<![\\w-])${a.replace(/-/g, '\\-')}s?(?![\\w-])`).test(n.text));
  if (!n.spellOut && unexplained.length) findings.push({ id: 'acronyms', tone: 'consider', basis: 'guidance', cite: APP_E, title: `${unexplained.slice(0, 4).join(', ')} not spelled out`, detail: 'The order’s own examples spell an acronym out the first time: “Position Safety Officer (PSO)”. Turn on Spell out acronyms; readers up the chain may not share your section’s shorthand.' });
  if (claims.length && claims.every((s) => s.hasResult)) findings.push({ id: 'good:outcomes', tone: 'good', title: 'Every sentence states an outcome' });
  if (expected.length && covered.length === expected.length) findings.push({ id: 'good:coverage', tone: 'good', title: `All ${expected.length} areas covered` });
  if (n.fits && n.length >= n.limit * 0.6) findings.push({ id: 'good:fit', tone: 'good', title: 'Uses the space well' });

  const order: Record<FindingTone, number> = { fix: 0, consider: 1, good: 2 };
  findings.sort((a, b) => order[a.tone] - order[b.tone]);
  return { score, grade: grade(score, n.sentences.length > 0), parts, findings };
}

const SPECIAL = /[^\x20-\x7e\n]/;

/**
 * Reviews text as typed, for a narrative edited by hand: the same checks the writer applies to what it writes, read
 * from the words alone. It cannot know outcomes or sources, so it does not grade them.
 */
export function reviewText(text: string, limit: number): Review {
  const findings: Finding[] = [];
  const body = text.replace(/\b[A-Z][A-Z /&]{2,}:\s*/g, '');
  const sentences = body.split(/(?<=[.;!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (text.length > limit) findings.push({ id: 'over', tone: 'fix', title: `${text.length - limit} characters over the limit` });
  const first = FIRST_PERSON.exec(body);
  if (first) findings.push({ id: 'first', tone: 'fix', title: `“${first[0]}”: evaluation writing leaves out the first person`, detail: 'Start with the verb: “Reconciled…”, not “I reconciled…”.' });
  for (const s of sentences) {
    const weak = WEAK_OPENERS.find((w) => w.pattern.test(s));
    if (weak) findings.push({ id: `weak:${s.slice(0, 20)}`, tone: 'consider', title: `${weak.label}: “${short(s, 48)}”`, detail: weak.advice });
  }
  const superlative = SUPERLATIVE.exec(body);
  if (superlative) findings.push({ id: 'superlative', tone: 'consider', basis: 'guidance', cite: SECTION_C, title: `“${superlative[1]}” rates the work instead of stating it`, detail: 'State the result; the number carries it.' });
  const cliche = CLICHE.exec(body);
  if (cliche) findings.push({ id: 'cliche', tone: 'consider', basis: 'guidance', cite: GAZETTE, title: `“${cliche[1]}” is a phrase readers skip` });
  const judgment = RS_JUDGMENT.exec(body);
  if (judgment) findings.push({ id: 'judgment', tone: 'fix', basis: 'guidance', cite: 'MCO 1610.7B', title: `“${judgment[0]}” is your reporting senior’s call`, detail: 'Input states what you did; rankings and recommendations come from your reporting chain.' });
  const vague = VAGUE.exec(body);
  if (vague) findings.push({ id: 'vague', tone: 'consider', title: `“${vague[1]}” stands in for a number`, detail: 'Count it, or cut it.' });
  const passive = sentences.find((s) => PASSIVE.test(s));
  if (passive) findings.push({ id: 'passive', tone: 'consider', title: `Passive voice: “${short(passive, 48)}”`, detail: 'Put the doer first.' });
  const long = sentences.find((s) => s.split(/\s+/).length > 40);
  if (long) findings.push({ id: 'long', tone: 'consider', title: `A ${long.split(/\s+/).length}-word sentence`, detail: 'Split it; a reader skims.' });
  if (SPECIAL.test(text)) findings.push({ id: 'special', tone: 'consider', title: 'Curly quotes, dashes or symbols', detail: 'Some forms accept plain characters only. Copy uses plain ones.' });
  const measured = sentences.filter((s) => /\d/.test(s)).length;
  const parts: ReviewPart[] = [
    { key: 'measured', label: 'Numbers', earned: Math.round(40 * pct(measured, sentences.length)), of: 40, note: `${measured} of ${sentences.length} sentences` },
    { key: 'verbs', label: 'Strong openings', earned: Math.round(30 * pct(sentences.filter((s) => !WEAK_OPENERS.some((w) => w.pattern.test(s))).length, sentences.length)), of: 30, note: '' },
    { key: 'fit', label: 'Length', earned: text.length > limit ? 0 : text.length >= limit * 0.6 ? 30 : 15, of: 30, note: `${text.length} of ${limit} characters` },
  ];
  const score = parts.reduce((t, p) => t + p.earned, 0) - (first ? 10 : 0);
  return { score: Math.max(0, score), grade: grade(score, sentences.length > 0), parts, findings };
}
