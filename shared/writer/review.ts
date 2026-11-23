import { GLOSSARY, IN_PROGRESS, PRIOR_AWARD, VERB_FORMS } from './lexicon.ts';
import { nameOf, readEntry, type AreaKind, type AreaNames, type Fact } from './facts.ts';
import type { Held, Sentence } from './compose.ts';
import { strengthOf } from './strength.ts';
import { gradeOf, type Grade, type Reading, type ReviewPart } from './grade.ts';
import { piecesOf } from './edited.ts';
import { TRACKS } from '../evaluation.ts';
import { DEFAULT_METRICS, type MetricsConfig } from '../constants.ts';

export type { ReviewPart } from './grade.ts';

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

export interface Review { score: number; grade: Grade; parts: ReviewPart[]; findings: Finding[] }

/**
 * What each area looks for when it is empty, as prompts for the Marine. Coaching from what the areas name, not text
 * from an order; the reporting senior's own guidance wins.
 */
export const AREA_PROMPTS: Record<AreaKind, { ask: string; prompt: string }> = {
  mission: { ask: 'Your core work: what you processed, fixed or delivered, with the count and what came of it.', prompt: 'Processed ' },
  leadership: { ask: 'Did you train, mentor, brief or look after anyone, or lead a detail, a working party or PT? Log it with how many Marines.', prompt: 'Trained ' },
  character: { ask: 'Extra work taken on unasked, volunteering, sustained effort, doing the right thing when it cost something. Log one with what it showed.', prompt: 'Volunteered ' },
  intellect: { ask: 'Courses, PME and certifications, and decisions you made or recommended that held up.', prompt: 'Completed ' },
  evaluations: { ask: 'Evaluations you were responsible for (FITREPs as reporting senior or reviewing officer, JEPES command input, proficiency and conduct marks): how many, and whether they were on time.', prompt: 'Submitted ' },
};

const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function kindOf(area: string, names: AreaNames): AreaKind {
  for (const k of Object.keys(names) as AreaKind[]) if (nameOf(names, k) === area) return k;
  return 'mission';
}

interface Written { text: string; length: number; limit: number; fits: boolean; sentences: Sentence[]; left: Sentence[]; facts: Fact[]; held: Held[]; spellOut: boolean }

export interface ReviewContext { areas: readonly string[]; labels: Record<string, string>; names: AreaNames; track: 'jepes' | 'fitrep'; facts: Fact[] }

const APP_E = 'MCO 1616.1, App. E';
const SECTION_C = 'NAVMC 10835, Section C';
const GAZETTE = 'Marine Corps Gazette';

type CheckCode = 'rs_judgment' | 'superlative' | 'speculative' | 'cliche' | 'vague' | 'billet' | 'no_verb' | 'weak_verb' | 'passive';

/** Each check, and what it rests on. "Helped" and the passive are preferences: no order forbids them. */
function checksFor(jepes: boolean): Array<{ code: CheckCode; basis: FindingBasis; cite?: string; style?: string }> {
  return [
    { code: 'rs_judgment', basis: 'guidance', cite: 'MCO 1610.7B' },
    { code: 'superlative', basis: jepes ? 'guidance' : 'order', cite: SECTION_C },
    { code: 'speculative', basis: 'guidance', cite: 'FITREP Section C' },
    { code: 'cliche', basis: 'guidance', cite: GAZETTE },
    { code: 'vague', basis: 'guidance', cite: jepes ? APP_E : SECTION_C },
    // A billet is a duty, not an accomplishment: the order asks for what was done in it.
    { code: 'billet', basis: 'guidance', cite: jepes ? APP_E : SECTION_C },
    { code: 'no_verb', basis: 'guidance', cite: jepes ? APP_E : undefined },
    { code: 'weak_verb', basis: 'style', style: 'A preference, not a rule: the reader just learns less.' },
    { code: 'passive', basis: 'style' },
  ];
}

/** The areas a narrative is expected to cover: the track's own, less evaluation duty unless there is some. */
const expectedAreas = (areas: readonly string[], facts: readonly Fact[]) => areas.filter((a) => !/evaluation/i.test(a) || facts.some((f) => f.area === a));

const areaField = (track: 'jepes' | 'fitrep') => TRACKS[track].areaLabel;

function emptyArea(area: string, names: AreaNames, jepes: boolean): Finding {
  const kind = kindOf(area, names);
  return {
    id: `empty:${area}`, tone: 'consider', title: `Nothing for ${area} yet`, area, action: { kind: 'log', prompt: AREA_PROMPTS[kind].prompt },
    detail: jepes ? `${AREA_PROMPTS[kind].ask} Command input is marked on all three lines, and accomplishments should relate directly to them.` : AREA_PROMPTS[kind].ask,
    ...(jepes ? { basis: 'order' as const, cite: APP_E } : { basis: 'style' as const }),
  };
}

const OUTCOME_DETAIL = 'A sentence with an outcome is the one your reporting chain can use: what changed, how much, by when.';
const NUMBER_DETAIL = 'How many, how much, how fast? One number makes a sentence credible.';
const REPEAT_DETAIL = 'The same work is already one total; these are different kinds of work that open alike. Reword one with the verb that says what it was, or leave one out.';
const ORDER: Record<FindingTone, number> = { fix: 0, consider: 1, good: 2 };
const byTone = (a: Finding, b: Finding) => ORDER[a.tone] - ORDER[b.tone];

/** Opening verbs three or more sentences share. */
function repeats(verbs: Array<string | null>): Finding[] {
  const openers = new Map<string, number>();
  for (const v of verbs) if (v) openers.set(v, (openers.get(v) || 0) + 1);
  return [...openers].filter(([, count]) => count >= 3).map(([verb, count]) => ({ id: `repeat:${verb}`, tone: 'consider', basis: 'style', title: `${count} sentences open with the same verb`, detail: REPEAT_DETAIL }));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const acronymsIn = (text: string) => Object.keys(GLOSSARY).filter((a) => new RegExp(`(?<![\\w-])${escapeRe(a)}s?(?![\\w-])`).test(text));

/**
 * One sentence the writer wrote, read for the grade from the entries behind it, the reading the strength badge uses
 * (strength.ts): it opens with what was done, it has a number, it states an outcome. A total opens with the verb its
 * entries share and states the outcome they give; the rest-of-area summary counts for its area only.
 */
export function readingOf(s: Sentence, facts: ReadonlyMap<string, Fact>): Reading {
  const base = { area: s.area, from: 'entry' as const };
  if (s.kind === 'summary') return { ...base, claim: false, opens: false, number: false, outcome: false };
  if (s.kind === 'casework') return { ...base, claim: true, opens: true, number: true, outcome: s.hasResult };
  const one = s.kind === 'entry' && s.covers.length === 1 ? facts.get(s.covers[0]) : undefined;
  if (!one) return { ...base, claim: true, opens: (s.verbStrength ?? 0) >= 2, number: s.measured, outcome: s.hasResult };
  const met = new Set(strengthOf(one).met);
  return { ...base, claim: true, opens: met.has('opens'), number: met.has('number'), outcome: met.has('outcome') };
}

/**
 * Grades what was written and says what would make it stronger, most useful first. The grade is the one scale
 * (grade.ts), read from the entries each sentence was written from; each finding names the entries that would fix it.
 */
export function reviewWriting(n: Written, ctx: ReviewContext): Review {
  const jepes = ctx.track === 'jepes';
  const findings: Finding[] = [];
  const claims = n.sentences.filter((s) => s.kind === 'entry' || s.kind === 'group' || s.kind === 'casework');
  const expected = expectedAreas(ctx.areas, n.facts);
  const covered = expected.filter((a) => n.sentences.some((s) => s.area === a));
  const byKey = new Map(n.facts.map((f) => [f.key, f]));
  const { score, grade, parts } = gradeOf(n.sentences.map((s) => readingOf(s, byKey)), { expected, length: n.length, limit: n.limit, areaField: areaField(ctx.track), edited: false });

  if (!n.fits) findings.push({ id: 'over', tone: 'fix', basis: 'data', title: `${n.length - n.limit} characters over the limit`, detail: 'Pinned sentences are kept even when they do not fit. Unpin one, or leave one out.' });
  for (const h of n.held) {
    // Routed to another block of the worksheet: nothing to fix.
    if (h.route) continue;
    findings.push({ id: `held:${h.key}`, tone: 'consider', basis: h.basis, cite: h.cite, title: `Held back: “${short(h.text, 52)}”`, detail: `${h.reason} Keep it from Left out if your chain wants it anyway.`, sources: h.sources, area: h.area });
  }
  for (const area of expected) if (!covered.includes(area)) findings.push(emptyArea(area, ctx.names, jepes));

  const used = new Set(n.sentences.flatMap((s) => s.covers));
  const inText = n.facts.filter((f) => used.has(f.key));
  const byScore = (a: Fact, b: Fact) => b.issues.length - a.issues.length;
  const noOutcome = inText.filter((f) => !f.result).sort(byScore);
  for (const f of noOutcome.slice(0, 4)) {
    findings.push({ id: `outcome:${f.key}`, tone: 'fix', basis: 'guidance', cite: jepes ? APP_E : SECTION_C, title: `Add what came of “${short(`${f.opener} ${f.rest}`.trim())}”`, detail: OUTCOME_DETAIL, sources: f.sources, area: f.area, action: { kind: 'open' } });
  }
  if (noOutcome.length > 4) findings.push({ id: 'outcome:more', tone: 'fix', basis: 'guidance', title: `${noOutcome.length - 4} more sentences have no outcome`, detail: 'Filter Activities by “Needs detail” to fix them in one sitting.' });

  for (const check of checksFor(jepes)) {
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
  if (unmeasured.length) findings.push({ id: 'unmeasured', tone: 'consider', basis: 'order', cite: jepes ? APP_E : SECTION_C, title: `${unmeasured.length} ${unmeasured.length === 1 ? 'sentence has' : 'sentences have'} no number`, detail: NUMBER_DETAIL, sources: unmeasured.flatMap((f) => f.sources), action: { kind: 'open' } });

  const inferred = n.facts.filter((f) => f.areaInferred);
  if (inferred.length) findings.push({ id: 'inferred', tone: 'consider', basis: 'data', title: `${inferred.length} ${inferred.length === 1 ? 'entry has' : 'entries have'} no area`, detail: 'The writer placed them by what they say. Tag them so they land where you mean them to.', sources: inferred.flatMap((f) => f.sources), action: { kind: 'tag' } });

  // An outcome left out is worth a look; work with none ranks below it anyway (score.ts).
  const strongLeft = n.left.filter((s) => s.tier >= 1);
  if (strongLeft.length) findings.push({ id: 'left', tone: 'consider', basis: 'data', title: `${strongLeft.length} ${strongLeft.length === 1 ? 'entry with an outcome' : 'entries with an outcome'} did not fit`, detail: 'Pin the ones that matter most, leave out a weaker one, or switch to Compact.' });
  if (n.fits && n.length && n.length < n.limit * 0.5) findings.push({ id: 'room', tone: 'consider', basis: 'data', title: `Room for ${n.limit - n.length} more characters`, detail: 'Log more of the work, with outcomes, and the writer will use the space.' });

  findings.push(...repeats(claims.map((s) => s.verb)));
  const unexplained = acronymsIn(n.text);
  if (!n.spellOut && unexplained.length) findings.push({ id: 'acronyms', tone: 'consider', basis: 'guidance', cite: APP_E, title: `${unexplained.slice(0, 4).join(', ')} not spelled out`, detail: 'The order’s own examples spell an acronym out the first time: “Position Safety Officer (PSO)”. Turn on Spell out acronyms; readers up the chain may not share your section’s shorthand.' });
  if (claims.length && claims.every((s) => s.hasResult)) findings.push({ id: 'good:outcomes', tone: 'good', title: 'Every sentence states an outcome' });
  if (expected.length && covered.length === expected.length) findings.push({ id: 'good:coverage', tone: 'good', title: `All ${expected.length} areas covered` });
  if (n.fits && n.length >= n.limit * 0.6) findings.push({ id: 'good:fit', tone: 'good', title: 'Uses the space well' });

  findings.sort(byTone);
  return { score, grade, parts, findings };
}

const SPECIAL = /[^\x20-\x7e\n]/;
// "I", "my", "we" and the rest, as typed; not the "I" of "Phase I" or "Level I-B".
const FIRST_PERSON_TYPED = /(?<!\b(?:Phase|Level|Tier|Part|Class|Stage|Block|Annex|Appendix|Volume|Book|Chapter|Echelon|Type|Mod|Course|Section|Spiral|Title)\s)\b(?:I|[Mm]e|[Mm]y|[Mm]ine|[Ww]e|[Oo]ur|us|[Mm]yself)\b(?!-)/;

/** What an edit is reviewed with: the track's areas and how the text names them, and the command's value types. */
export interface EditContext { areas: readonly string[]; labels: Record<string, string>; headers?: Record<string, string>; names: AreaNames; track: 'jepes' | 'fitrep'; metrics?: MetricsConfig }

// The writer joins a Result that opens with an "-ing" word after a comma (", helping the section pass the IG"), so after
// a comma one reads as what came of the work, except: a word for a figure or the writer's own for a purpose ("totaling
// $48,250", ", averaging 3 days each", ", supporting the FY26 close", ", including 14 in DAI:"), words that only end like one ("during",
// "pending"), and a role (", working with the S-1", ", serving as the NCOIC").
const NOT_OUTCOME_ING = new Set([
  'totaling', 'totalling', 'valuing', 'obligating', 'amounting', 'averaging', 'costing', 'spanning', 'reconciling', 'supporting', 'including',
  'during', 'pending', 'remaining', 'following', 'according', 'regarding', 'concerning', 'nothing', 'something', 'anything', 'everything',
  'morning', 'evening', 'outstanding',
]);
const ROLE = /^(?:(?:working|assisting|helping|coordinating|partnering|collaborating|liaising|consulting|teaming)\s+(?:with|alongside)|(?:serving|acting|standing in|filling in)\s+as)\b/i;
const MONTH = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b\.?`;
// A dash between two figures or dates is a range, not a join: "12 - 15", "0800 - 1600", "Jun - Aug", "1 Jun - 30 Nov",
// "2025 - Aug 2026". A figure is a word of its own: "M27", "S-4", "FY26" or "3/5" before a dash is a name, not a range.
const FIGURE_END = /(?:^|[\s(])\$?\d[\d,.:]*[KMB%]?$/;
const FIGURE_START = /^\$?\d[\d,.:]*[KMB%]?(?=[\s,;]|$)/;
const MONTH_END = new RegExp(String.raw`\b${MONTH}$`);
const MONTH_START = new RegExp(String.raw`^${MONTH}(?=[\s,;]|$)`);
const DAY_MONTH_START = new RegExp(String.raw`^\d{1,2}\s+${MONTH}(?=[\s,;]|$)`);
const isRange = (before: string, after: string) => (FIGURE_END.test(before) && (FIGURE_START.test(after) || MONTH_START.test(after)))
  || (MONTH_END.test(before) && (MONTH_START.test(after) || DAY_MONTH_START.test(after) || /^\d{4}\b/.test(after)));
// What a verb is followed by when it acts on something: "cleared on the next report", "rerouted through the S-4".
const COMPLEMENT = new Set([
  'on', 'in', 'at', 'by', 'for', 'to', 'from', 'with', 'within', 'under', 'over', 'ahead', 'before', 'after', 'during', 'through', 'across', 'into',
  'of', 'as', 'per', 'without', 'below', 'above', 'again', 'back', 'out', 'up', 'down', 'off', 'early', 'late', 'the', 'a', 'an', 'every', 'each',
  'all', 'both', 'zero', 'no', 'their', 'its',
]);
const bareWord = (w: string | undefined) => (w ?? '').replace(/^[^A-Za-z0-9$]+|[^A-Za-z0-9%]+$/g, '').toLowerCase();
/**
 * Whether a word after a dash is a verb of the outcome's own, not a word that describes a noun: "28 qualified expert"
 * and "all cleared on the next report" have one; "8 tracked vehicles", "crew-served weapons", "30 enlisted",
 * "assigned gear" and "classified and unclassified" do not. A past tense the lexicon knows is a verb unless it stands
 * between a count and the plural it counts; another "-ed" word only when something it acts on follows it.
 */
function actsAsVerb(words: string[], i: number) {
  const w = bareWord(words[i]);
  if (w.includes('-')) return false;
  const next = /[,;:]$/.test(words[i]) ? '' : bareWord(words[i + 1]);
  if (VERB_FORMS.get(w)?.form === 'past') return !(/^\$?\d/.test(bareWord(words[i - 1])) && /^[a-z]{3,}s$/.test(next) && !COMPLEMENT.has(next));
  return /^[a-z]{3,}ed$/.test(w) && (COMPLEMENT.has(next) || /^[a-z]{2,}ly$/.test(next) || /^\$?\d/.test(next));
}
// What follows a dash says what came of the work unless it only lists or breaks down what was done, with no verb of its
// own and no measure: "- weapons, optics and radios", "-- 9 in DAI and 5 in GCSS-MC", "- 10 officers and 30 enlisted".
// "- 100% mission capable, zero mishaps" is a measure.
const MEASURE_OPEN = /^(?:\$?\d[\d,.]*\s*%|(?:zero|no|none|all|every|each|both)\b)/i;
const listOnly = (after: string) => {
  if (!/,|\band\b/.test(after) || MEASURE_OPEN.test(after)) return false;
  const words = after.split(/\s+/);
  return !words.some((_w, i) => actsAsVerb(words, i));
};

/**
 * Where a typed sentence's outcome starts, by the joins the writer uses and a Marine types: after a semicolon or a
 * spaced dash (not a range or a list), "resulting in", ", leading to", ", so that", a total's ", including 14 in DAI:",
 * a grade's ", with a 3.8 GPA", or an "-ing" phrase as the writer joins a Result (", cutting the review to 1 hour"),
 * but not a figure, a purpose or a role (", saving $18,250", ", working with the S-1").
 */
export function splitOutcome(sentence: string): { title: string; result: string } {
  const s = sentence.replace(/[.!?]+$/, '').trim();
  const joins: Array<{ at: number; from: number }> = [];
  const find = (re: RegExp) => { const m = re.exec(s); if (m) joins.push({ at: m.index, from: m.index + m[0].length }); };
  find(/;\s+/);
  find(/,\s+(?:resulting in|which resulted in|leading to|so that)\s+/i);
  find(/\s+(?:resulting in|which resulted in)\s+/i);
  // A dash with a space each side, as typed ("in DAI - all cleared"; piecesOf spaces an em dash and "DAI--all"). A range
  // is no join; of the rest, the last one says what came of it ("3 classes - first aid and comm - all 30 passed"), unless
  // what follows it is one word or only a list ("DTS - GTCC - DAI").
  const dash = [...s.matchAll(/\s+-{1,2}\s+/g)].filter((m) => !isRange(s.slice(0, m.index), s.slice(m.index + m[0].length))).pop();
  if (dash) {
    const after = s.slice(dash.index + dash[0].length);
    if (/[A-Za-z]/.test(s.slice(0, dash.index)) && after.split(/\s+/).length >= 2 && !listOnly(after)) joins.push({ at: dash.index, from: dash.index + dash[0].length });
  }
  find(/,\s+including\s+[^:;]*?:\s+/i);
  find(/,\s+with\s+(?=an?\s+\d)/i);
  // The second of a pair after a figure or purpose that trails the clause: ", saving $18,250 and returning funds to the G-8".
  find(/(?<=,\s+(?:(?:saving|recovering)\s+\$[\d,.]+[KMB]?|supporting\s[^,;]+?))\s+and\s+(?=[a-z]{3,}ing\b)/);
  for (const m of s.matchAll(/,\s+([a-z]{3,}ing)\b(?:\s+(\S+))?/g)) {
    const word = m[1];
    const from = m.index + m[0].indexOf(word);
    if (NOT_OUTCOME_ING.has(word) || !m[2] || ((word === 'saving' || word === 'recovering') && /^\$/.test(m[2])) || ROLE.test(s.slice(from))) continue;
    joins.push({ at: m.index, from });
  }
  const first = joins.sort((a, b) => a.at - b.at)[0];
  return first ? { title: s.slice(0, first.at).trim(), result: s.slice(first.from).trim() } : { title: s, result: '' };
}

/** A sentence the Marine typed, read from its words as an entry would be, with the heading's area when it has one. */
export function readTyped(text: string, area: string | null, ctx: EditContext): { reading: Reading; fact: Fact } {
  const { title, result } = splitOutcome(text);
  const fact = readEntry({ title, result, eval_area: area }, { names: ctx.names, areas: ctx.areas, metrics: ctx.metrics ?? DEFAULT_METRICS, track: ctx.track });
  const met = new Set(strengthOf(fact).met);
  // Opens with what was done only as typed: "I reconciled" and "Processing" are read, but do not open with the verb.
  const first = (text.split(/\s+/)[0] || '').replace(/[^A-Za-z-]/g, '').toLowerCase();
  return { fact, reading: { area: fact.area, claim: true, opens: met.has('opens') && Boolean(fact.opener) && first === fact.opener.toLowerCase(), number: met.has('number'), outcome: met.has('outcome'), from: 'typed' } };
}

const wordsOf = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9$]+/g) ?? []);
/** Two sentences that share most of their words: at least 60% of the words either one uses. */
function alike(a: string, b: string) {
  const x = wordsOf(a);
  const y = wordsOf(b);
  const both = [...x].filter((w) => y.has(w)).length;
  return both / (x.size + y.size - both || 1) >= 0.6;
}

/**
 * Reviews a narrative edited by hand on the one scale (ADR-0045). Each sentence the writer wrote that stands
 * unchanged keeps the reading of its entries, so an untouched edit grades exactly as the written text does; a sentence
 * typed or changed is read from its words. The findings are about the edited text: its entries' notes for what was
 * kept, word checks for what was typed, and its coverage and length.
 */
export function reviewEdit(edit: string, n: Pick<Written, 'sentences' | 'facts' | 'limit'>, ctx: EditContext): Review {
  const jepes = ctx.track === 'jepes';
  const facts = new Map(n.facts.map((f) => [f.key, f]));
  const pieces = piecesOf(edit, n.sentences, ctx);
  const kept: Array<{ sentence: Sentence; facts: Fact[] }> = [];
  const typed: Array<{ id: string; text: string; fact: Fact; reading: Reading }> = [];
  const readings: Reading[] = [];
  const summaries = n.sentences.filter((s) => s.kind === 'summary');
  for (const p of pieces) {
    if (p.kind === 'kept') {
      // Under the heading or label it sits beneath, as the text says; FITREP's text names none, so the entry's own.
      const r = readingOf(p.sentence, facts);
      readings.push(p.area ? { ...r, area: p.area } : r);
      kept.push({ sentence: p.sentence, facts: p.sentence.covers.map((k) => facts.get(k)).filter((f): f is Fact => Boolean(f)) });
    } else {
      const t = readTyped(p.text, p.area, ctx);
      // The rest-of-area summary reworded ("four UMTs" for "4 UMTs") is still the summary, not a claim of its own.
      const summary = t.reading.outcome ? undefined : summaries.find((s) => alike(s.text, p.text));
      const reading = summary ? { ...t.reading, claim: false, area: p.area ?? summary.area } : t.reading;
      readings.push(reading);
      typed.push({ id: `typed:${typed.length}`, text: p.text, fact: t.fact, reading });
    }
  }
  const expected = expectedAreas(ctx.areas, n.facts);
  const covered = expected.filter((a) => readings.some((r) => r.area === a));
  const length = edit.length;
  const fits = length <= n.limit;
  const { score, grade, parts } = gradeOf(readings, { expected, length, limit: n.limit, areaField: areaField(ctx.track), edited: true });

  const findings: Finding[] = [];
  if (!fits) findings.push({ id: 'over', tone: 'fix', basis: 'data', title: `${length - n.limit} characters over the limit`, detail: 'Cut it to fit: Copy and the PDF take the text as you edited it.' });
  const firstPerson = typed.map((t) => ({ t, m: FIRST_PERSON_TYPED.exec(t.text) })).find((x) => x.m);
  if (firstPerson) findings.push({ id: 'first', tone: 'fix', title: `“${firstPerson.m![0]}”: evaluation writing leaves out the first person`, detail: `Start with the verb: “Reconciled…”, not “I reconciled…”. In “${short(firstPerson.t.text.replace(/[.!?]+$/, ''), 48)}”.` });
  for (const area of expected) if (!covered.includes(area)) findings.push(emptyArea(area, ctx.names, jepes));

  // What came of it, sentence by sentence: an entry's Result for what was kept, the typed words for the rest.
  const keptFacts = kept.flatMap((k) => k.facts);
  const noOutcome: Finding[] = [
    ...keptFacts.filter((f) => !f.result).map((f): Finding => ({ id: `outcome:${f.key}`, tone: 'fix', basis: 'guidance', cite: jepes ? APP_E : SECTION_C, title: `Add what came of “${short(`${f.opener} ${f.rest}`.trim())}”`, detail: OUTCOME_DETAIL, sources: f.sources, area: f.area, action: { kind: 'open' } })),
    ...typed.filter((t) => t.reading.claim && !t.reading.outcome).map((t): Finding => ({ id: `outcome:${t.id}`, tone: 'fix', basis: 'guidance', cite: jepes ? APP_E : SECTION_C, title: `Say what came of “${short(t.text)}”`, detail: `${OUTCOME_DETAIL} Put it after a semicolon: “…; all cleared on the next report”.`, area: t.fact.area })),
  ];
  findings.push(...noOutcome.slice(0, 4));
  if (noOutcome.length > 4) findings.push({ id: 'outcome:more', tone: 'fix', basis: 'guidance', title: `${noOutcome.length - 4} more sentences have no outcome`, detail: OUTCOME_DETAIL });

  for (const check of checksFor(jepes)) {
    const hits = [
      ...keptFacts.filter((f) => f.issues.some((i) => i.code === check.code)).map((f) => ({ id: f.key, f, shown: `${f.opener} ${f.rest}`.trim(), sources: f.sources })),
      ...typed.filter((t) => t.fact.issues.some((i) => i.code === check.code)).map((t) => ({ id: t.id, f: t.fact, shown: t.text, sources: [] as string[] })),
    ];
    for (const h of hits.slice(0, 3)) {
      const issue = h.f.issues.find((i) => i.code === check.code)!;
      findings.push({
        id: `${check.code}:${h.id}`, tone: 'consider', basis: check.basis, cite: check.cite, title: `${issue.message}: “${short(h.shown, 48)}”`,
        detail: check.style ? `${issue.advice} ${check.style}` : issue.advice, sources: h.sources, area: h.f.area, ...(h.sources.length ? { action: { kind: 'open' as const } } : {}),
      });
    }
  }
  const unmeasured = [...keptFacts.filter((f) => f.issues.some((i) => i.code === 'unmeasured')).map((f) => f.sources), ...typed.filter((t) => t.reading.claim && !t.reading.number).map(() => [] as string[])];
  if (unmeasured.length) findings.push({ id: 'unmeasured', tone: 'consider', basis: 'order', cite: jepes ? APP_E : SECTION_C, title: `${unmeasured.length} ${unmeasured.length === 1 ? 'sentence has' : 'sentences have'} no number`, detail: NUMBER_DETAIL, sources: unmeasured.flat(), ...(unmeasured.flat().length ? { action: { kind: 'open' as const } } : {}) });
  const inferred = keptFacts.filter((f) => f.areaInferred);
  if (inferred.length) findings.push({ id: 'inferred', tone: 'consider', basis: 'data', title: `${inferred.length} ${inferred.length === 1 ? 'entry has' : 'entries have'} no area`, detail: 'The writer placed them by what they say. Tag them so they land where you mean them to.', sources: inferred.flatMap((f) => f.sources), action: { kind: 'tag' } });

  // What the order keeps out of the input, typed back in.
  for (const t of typed) {
    const annual = t.fact.issues.some((i) => i.code === 'annual_training');
    const reason = annual || PRIOR_AWARD.test(t.text) || IN_PROGRESS.test(t.text) ? t.fact.held?.reason : null;
    if (reason) findings.push({ id: `kept-out:${t.id}`, tone: 'consider', basis: t.fact.held!.basis, cite: t.fact.held!.cite, title: `“${short(t.text, 48)}”`, detail: reason, area: t.fact.area });
  }
  const long = typed.find((t) => t.text.split(/\s+/).length > 40);
  if (long) findings.push({ id: 'long', tone: 'consider', basis: 'style', title: `A ${long.text.split(/\s+/).length}-word sentence`, detail: 'Split it; a reader skims.' });
  if (SPECIAL.test(edit)) findings.push({ id: 'special', tone: 'consider', basis: 'data', title: 'Curly quotes, dashes or symbols', detail: 'Some forms accept plain characters only. Copy uses plain ones.' });
  if (fits && length && length < n.limit * 0.5) findings.push({ id: 'room', tone: 'consider', basis: 'data', title: `Room for ${n.limit - length} more characters`, detail: 'Add what else you did in the period, with what came of it.' });

  const claims = readings.filter((r) => r.claim);
  findings.push(...repeats([...kept.filter((k) => k.sentence.kind !== 'summary').map((k) => k.sentence.verb), ...typed.map((t) => t.fact.verb?.lemma ?? null)]));
  // An acronym is spelled out when its expansion stands before it in brackets: "unliquidated obligations (ULOs)".
  const unexplained = acronymsIn(edit).filter((a) => !new RegExp(`\\(${escapeRe(a)}s?\\)`).test(edit));
  if (unexplained.length) findings.push({ id: 'acronyms', tone: 'consider', basis: 'guidance', cite: APP_E, title: `${unexplained.slice(0, 4).join(', ')} not spelled out`, detail: 'The order’s own examples spell an acronym out the first time: “Position Safety Officer (PSO)”. Readers up the chain may not share your section’s shorthand.' });
  if (claims.length && claims.every((r) => r.outcome)) findings.push({ id: 'good:outcomes', tone: 'good', title: 'Every sentence states an outcome' });
  if (expected.length && covered.length === expected.length) findings.push({ id: 'good:coverage', tone: 'good', title: `All ${expected.length} areas covered` });
  if (fits && length >= n.limit * 0.6) findings.push({ id: 'good:fit', tone: 'good', title: 'Uses the space well' });

  findings.sort(byTone);
  return { score, grade, parts, findings };
}
