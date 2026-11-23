import { formatNumber } from '../metrics.ts';
import { unitFor } from './units.ts';
import { clauseOf, type Fact } from './facts.ts';
import { shortMoney } from './score.ts';
import { GLOSSARY, NOT_VERBS, NUMBER_WORDS, VERB_FORMS, gerundOf, type VerbEntry } from './lexicon.ts';

export type Density = 'full' | 'compact';
/** "bullets" is the form MCO 1616.1 Appendix E shows: a dash, a past-tense verb, the count and context, then the result. */
export type Format = 'paragraph' | 'bullets';
/**
 * Which evaluation the text is for. JEPES command input is written in the full form MCO 1616.1 Appendix E shows. FITREP
 * Section C is one 1,232-character block for every accomplishment of the period, so it takes the shorthand: dollars
 * short ("$48.3K"), a semicolon before a measured outcome, "supporting" for "in support of" (ADR-0043).
 */
export type Track = 'jepes' | 'fitrep';

const PREPOSITIONS = new Set([
  'on', 'for', 'in', 'to', 'with', 'at', 'from', 'of', 'by', 'into', 'onto', 'across', 'through', 'throughout', 'during',
  'under', 'over', 'within', 'between', 'among', 'after', 'before', 'about', 'around', 'against', 'per', 'toward',
  'towards', 'via', 'without', 'upon', 'as', 'than',
]);
/** The particle of a two-word verb: "closed out 14 cases", "set up the tracker". */
const PARTICLES = new Set(['out', 'up', 'down', 'off', 'back', 'away']);
const CONJUNCTIONS = new Set(['and', 'or', 'but', 'nor']);
const ARTICLES = new Set(['the', 'a', 'an']);
/** Words a count follows rather than replaces: "all 22 MIPRs", "their 40 vehicles". */
const BEFORE_COUNT = new Set(['all', 'every', 'each', 'both', 'its', 'their', 'his', 'her', 'these', 'those', 'this', 'that']);

const bare = (w: string) => w.toLowerCase().replace(/^[("']+|[)"',;:.]+$/g, '');

/** Words that open or point at a noun phrase: what follows them is a noun, not a verb. */
const DETERMINERS = new Set([
  'the', 'a', 'an', 'all', 'every', 'each', 'both', 'its', 'their', 'his', 'her', 'these', 'those', 'this', 'that', 'no', 'zero',
  'any', 'some', 'many', 'several', 'them', 'it', 'him', 'they',
]);
/** Words that size a number ("collected over 400 toys"), part of the object they lead. */
const APPROXIMATE = new Set(['over', 'about', 'nearly', 'almost', 'approximately', 'roughly', 'under', 'more', 'some']);
/** Words that say when or how, after a verb with no object: "completed ahead of schedule", "cleared early". */
const TIMING = new Set(['ahead', 'early', 'late', 'behind', 'again', 'back', 'on', 'under', 'before', 'after', 'within']);

/** A past tense, by the lexicon or by its "-ed": "ran", "passed", "replaced". Not "Speed" or "hundred". */
const looksPast = (w: string) => VERB_FORMS.get(w)?.form === 'past' || (/^[a-z]{3,}ed$/.test(w) && !NOT_VERBS.has(w));
/** A word a noun phrase can go on with: lower case and not a word that ends or joins one. */
const nounish = (w: string | undefined) => Boolean(w) && /^[a-z][a-z'-]*$/.test(bare(w!)) && !/^[(]/.test(w!)
  && ![PREPOSITIONS, CONJUNCTIONS, ARTICLES, DETERMINERS, PARTICLES].some((set) => set.has(bare(w!)));

/**
 * Whether the word at `i` is a verb of the outcome's own, after a subject: "trained Marines ran the desk", "processed
 * vouchers increased from 40 to 60", "the CO ordered a stand down". A past form before a noun describes it ("4 cracked
 * frames"); a form that spells like a verb after a number, an article or a preposition is a noun ("40 records", "the
 * reports", "in repairs").
 */
function verbAt(words: string[], i: number): boolean {
  const w = bare(words[i]);
  const prev = bare(words[i - 1] || '');
  if (/^(?:was|were|is|are|has|have|had)$/.test(w)) return true;
  if (looksPast(w)) {
    // After a counted subject or a name it is the verb: "35 Marines qualified expert", "the CO approved funding".
    if ((/^\d/.test(words[i - 2] || '') && /s$/.test(prev) && !DETERMINERS.has(prev)) || /^[A-Z]{2,}$/.test((words[i - 1] || '').replace(/[^A-Za-z]/g, ''))) return true;
    return !nounish(words[i + 1]) || /[,;:.]$/.test(words[i]);
  }
  if (VERB_FORMS.get(w)?.form !== 'third') return false;
  const objectBefore = /^\$?\d/.test(words[i - 1] || '') || DETERMINERS.has(prev) || PREPOSITIONS.has(prev) || CONJUNCTIONS.has(prev)
    || /(?:ed|al|ive|ary|ous|ic|ful|less|ing)$/.test(prev);
  if (objectBefore) return false;
  // A third form with nothing after it ends the object ("corrected unit records", "updated old files for the S-1"); one
  // with an object of its own is the verb ("the section passes inspections").
  const next = words[i + 1];
  return Boolean(next) && !/[,;:.]$/.test(words[i]) && (nounish(next) || DETERMINERS.has(bare(next)) || /^\$?\d/.test(next));
}

// An outcome that is a measure ("100% mission readiness", "no incidents") reads as "…, resulting in" it, as the
// order's examples do. Not a count with a verb of its own ("28 Marines passed"), a share ("28 of 30") or a time
// ("2 days early"): those keep their own clause.
const MEASURE_RESULT = /^(?:\d[\d,.]*\s*%?|100%|no|zero)\s+([a-z][a-z-]*)\b/i;
const GRADE_RESULT = /^\d[\d.,]*\s+(?:(?:PFT|CFT|rifle|pistol|range|MCMAP)\s+)?(?:GPA|average|grade point average|score|composite)$/i;
/** "graduated with a 92 average" is the grade: "Completed the course, with a 92 average." */
const GRADUATED = /^(?:graduated|finished|completed|passed)\s+with\s+an?\s+(.+)$/i;
/** "an 85 average", "an 11.2 composite", "a 3.8 GPA": the article the number is read with. */
const gradeArticle = (grade: string) => (/^(?:8|1[18](?![\d,]))/.test(grade) ? 'an' : 'a');

function measured(result: string): boolean {
  const m = MEASURE_RESULT.exec(result);
  if (!m || /ed$/i.test(m[1])) return false;
  const words = result.split(' ');
  if (bare(words[1] || '') === 'of' || (/^(?:hours?|days?|weeks?|months?)$/i.test(bare(words[1] || '')) && TIMING.has(bare(words[2] || '')))) return false;
  for (let i = 1; i < words.length; i += 1) if (verbAt(words, i)) return false;
  return true;
}

/**
 * An outcome that opens with what the Marine did, as the participle that follows the sentence: "cut the weekly review
 * from 3 hours to 1 hour" becomes "cutting the weekly review…". Only a past tense the lexicon knows, with an object after
 * it. "cleared on the next report" and "completed ahead of schedule" say what happened to the work, and keep their own
 * clause; so does a second verb later ("identified 4 errors and replaced the pages") and a clause with a subject of
 * its own ("trained Marines ran the desk", "corrected 12 errors and the battalion passed").
 */
/**
 * The "-ing" form of a past tense: the lexicon's, or by its spelling for a regular verb it does not list ("produced"
 * is "producing", "resubmitted" "resubmitting", "supplied" "supplying").
 */
function gerundOfPast(w: string): string | null {
  const hit = VERB_FORMS.get(w);
  if (hit) return hit.form === 'past' ? gerundOf(hit.entry) : null;
  if (!/^[a-z]{4,}ed$/.test(w) || NOT_VERBS.has(w)) return null;
  if (/ied$/.test(w)) return `${w.slice(0, -3)}ying`;
  if (/eed$/.test(w)) return `${w.slice(0, -1)}ing`;
  return `${w.slice(0, -2)}ing`;
}

/** Whether the word starts what a verb acts on: "the pages", "4 errors", "all", "pending claims". */
const objectStart = (w: string | undefined) => Boolean(w) && (/^\$?\d/.test(w!) || DETERMINERS.has(bare(w!)) || BEFORE_COUNT.has(bare(w!)) || nounish(w));

function participle(result: string): string | null {
  const words = result.split(' ');
  const lead0 = gerundOfPast(bare(words[0]));
  if (!lead0 || words.length < 2 || words[0] !== words[0].toLowerCase() || /[,;:.]$/.test(words[0])) return null;
  // Two verbs on one object: "found and fixed 4 cracked frames" becomes "finding and fixing 4 cracked frames".
  const second = bare(words[1]) === 'and' && words[2] && words[2] === words[2].toLowerCase() ? gerundOfPast(bare(words[2])) : null;
  const lead = second ? [lead0, 'and', second] : [lead0];
  const from = second ? 3 : 1;
  if (from >= words.length) return null;
  let k = from;
  let next = bare(words[k]);
  if (PARTICLES.has(next) && words[k + 1]) { k += 1; next = bare(words[k]); }
  if (APPROXIMATE.has(next) && /^\$?\d/.test(words[k + 1] || '')) { k += 1; next = bare(words[k]); }
  // "completed ahead of schedule", "cleared early": when, not what. "cut late returns" has its object.
  const timing = TIMING.has(next) && !(nounish(words[k + 1]) && !PREPOSITIONS.has(next));
  if (!next || PREPOSITIONS.has(next) || PARTICLES.has(next) || CONJUNCTIONS.has(next) || timing || /ly$/.test(next)) return null;
  // "cleared 2 weeks early" says when, not what: no object to carry.
  if (/^\d/.test(next) && /^(?:hours?|days?|weeks?|months?)$/i.test(bare(words[k + 1] || '')) && TIMING.has(bare(words[k + 2] || ''))) return null;
  const out = [...words];
  for (let i = from; i < words.length; i += 1) {
    const w = bare(words[i]);
    if (/^(?:now|still|also|then)$/.test(w) && words[i + 1] && VERB_FORMS.has(bare(words[i + 1]))) return null;
    // A second verb on its own object, after "and": "identified 4 errors and replaced the pages" becomes "identifying
    // 4 errors and replacing the pages". After a comma it would be a second "-ing" phrase, so it keeps its clause.
    const then = bare(words[i + 1] || '');
    if (w === 'and' && !/,$/.test(words[i - 1] || '') && looksPast(then) && objectStart(words[i + 2]) && gerundOfPast(then)) {
      out[i + 1] = gerundOfPast(then)!;
      i += 1;
      continue;
    }
    if (i > k && verbAt(words, i)) return null;
    // Any other second verb (", corrected all", "and resubmitted"), or a second subject ("and the CO ordered a stand
    // down", caught by its verb), keeps the outcome as a clause of its own.
    if ((CONJUNCTIONS.has(w) || /,$/.test(words[i])) && looksPast(then)) return null;
    // An "-ing" phrase of its own after a comma would stack two: "sorting the delivery, saving 3 hours".
    if (/,$/.test(words[i]) && /^[a-z]{2,}ing$/.test(then)) return null;
  }
  return [...lead, ...out.slice(from)].join(' ');
}

/** An outcome that is already an "-ing" phrase: "covering $2,875 in purchases", "saving the command 40 hours". */
const NOT_GERUND = new Set(['during', 'nothing', 'something', 'anything', 'everything', 'morning', 'evening', 'pending', 'outstanding', 'remaining']);
const doingAlready = (result: string) => {
  const w = result.split(' ')[0];
  return /^[a-z]{3,}ing$/.test(w) && !NOT_GERUND.has(w) && (VERB_FORMS.get(w)?.form === 'gerund' || !VERB_FORMS.has(w));
};

/**
 * How the outcome joins the sentence, by what kind of outcome it is. The same rule in paragraph and bullet form, for
 * every entry, so nothing is left to chance: a grade ("…, with a 3.8 GPA"), something the Marine did ("…, cutting the
 * review to an hour"), a measure (JEPES "…, resulting in 100% mission readiness"; FITREP "…; 100% mission readiness"),
 * or a clause of its own ("…; all cleared on the next report").
 */
function joinResult(clause: string, result: string, track: Track, trailing = false): string {
  const grade = GRADE_RESULT.test(result) ? result : GRADUATED.exec(result)?.[1];
  if (grade && GRADE_RESULT.test(grade)) return `${clause}, with ${gradeArticle(grade)} ${grade}`;
  // Not a second "-ing" phrase after one the clause already ends on (", saving $18,250", ", supporting the close").
  // The figure that trails the clause ends it, and the outcome follows a semicolon.
  // An outcome typed as an "-ing" phrase already joins as one; after a trailing one it is the second of a pair.
  if (doingAlready(result)) return trailing ? `${clause} and ${result}` : `${clause}, ${result}`;
  const doing = trailing ? null : participle(result);
  if (doing) return `${clause}, ${doing}`;
  if (measured(result) && track === 'jepes' && !trailing) return `${clause}, resulting in ${result}`;
  return `${clause}; ${result}`;
}

/**
 * The word that joins a dollar figure to what it was for, by dollar type, so every entry and every total of one type in
 * a text reads the same. A "tail" figure follows the clause after a comma ("…, saving $18,250"); the others follow the
 * count they belong to ("14 ULOs totaling $48,250"). A configured type takes the word for whether it sums. The seed
 * picks one set for the whole text, which is what Another wording changes.
 */
interface ConnectorSet { byType: Record<string, string>; summable: string; tracked: string }
const CONNECTORS: readonly ConnectorSet[] = [
  { byType: { reconciled: 'totaling', obligated: 'obligating', saved: ', saving', reviewed: 'covering', impact: 'valued at' }, summable: 'totaling', tracked: 'covering' },
  // Saved dollars are "saving" in both sets: "recovering" would say money came back that was never spent.
  { byType: { reconciled: 'worth', obligated: 'valued at', saved: ', saving', reviewed: 'covering', impact: 'worth' }, summable: 'worth', tracked: 'covering' },
];

export function connectorFor(type: string | null | undefined, summable: boolean, seed: number, verb?: VerbEntry | null): { word: string; tail: boolean } {
  const set = CONNECTORS[Number.isFinite(seed) ? Math.abs(Math.trunc(seed)) % CONNECTORS.length : 0];
  const word = (type && Object.hasOwn(set.byType, type) ? set.byType[type] : null) ?? (summable ? set.summable : set.tracked);
  const c = word.startsWith(', ') ? { word: word.slice(2), tail: true } : { word, tail: false };
  // Never the opening verb a second time: "Obligated 22 MIPRs totaling $240,000", not "Obligated 22 MIPRs obligating
  // $240,000"; "Saved … totaling $12,000", not "Saved …, saving $12,000". The set's own word for a sum stands in.
  if (verb && (VERB_FORMS.get(c.word)?.entry.lemma === verb.lemma || gerundOf(verb) === c.word)) return { word: set.summable, tail: false };
  return c;
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inParens = (text: string, at: number) => (text.slice(0, at).match(/\(/g) || []).length > (text.slice(0, at).match(/\)/g) || []).length;

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
      // Not inside parentheses: "(2-Way UMT, OCMT)" would nest a second pair. Not right before them either: "OMPFs (85
      // records)" would set two pairs side by side. The next use clear of both is spelled out.
      // Not inside a name ("Staff NCO Career Course", "SNCO Academy"). A possessive is its first use too: "the
      // noncommissioned officer's (NCO's) Marines".
      const re = new RegExp(`(?<![\\w-])${escapeRe(acr)}(s|'s)?(?![\\w'-])`, 'g');
      const named = (at: number, len: number) => {
        const before = out.slice(0, at).trimEnd().split(' ');
        const word = before.length > 1 ? before.at(-1)! : '';
        const after = out.slice(at + len).trimStart().split(' ')[0] || '';
        return /^[A-Z][a-z]/.test(word) || /^[A-Z][a-z]/.test(after);
      };
      const m = [...out.matchAll(re)].find((x) => !inParens(out, x.index!) && !/^\s*\(/.test(out.slice(x.index! + x[0].length)) && !named(x.index!, x[0].length));
      if (!m || m.index === undefined) continue;
      done.add(acr);
      if (out.toLowerCase().includes(words.one.toLowerCase())) continue;
      const owner = m[1] === "'s";
      const plural = m[1] === 's';
      let full = plural ? words.many || `${words.one}s` : owner ? `${words.one}'s` : words.one;
      if (m.index === 0) full = full.charAt(0).toUpperCase() + full.slice(1);
      let head = out.slice(0, m.index);
      // The article goes with the words now read: "an unmatched transaction (UMT)", "a noncommissioned officer (NCO)".
      if (!plural) head = head.replace(/\b([Aa])n? $/, (_x, a: string) => (/^[aeiou]/i.test(full) ? `${a}n ` : `${a} `));
      // A system is "the" system: "in the Defense Travel System (DTS)".
      if (words.the && /\b(?:in|into|through|from|on|via|using|with|to)\s$/i.test(head)) head = `${head}the `;
      out = `${head}${full} (${m[0]})${out.slice(m.index + m[0].length)}`;
    }
    return out;
  });
}

/**
 * Dollars as an evaluation writes them: cents only under a thousand ("$118.38"), whole dollars to a million
 * ("$48,250"), then "$1.2M". Compact and FITREP shorten from ten thousand ("$48.3K").
 */
export function dollars(amount: number, density: Density, track: Track = 'jepes'): string {
  const abs = Math.abs(amount);
  if (density === 'compact' || track === 'fitrep' || abs >= 1e6) return shortMoney(amount);
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
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–\u2014]/g, '-').replace(/…/g, '...').replace(/\u00a0/g, ' ')
    // A fraction keeps its value: "1½" is "1 1/2", never "112".
    .replace(/(\d)([\u00bc-\u00be\u2150-\u215e])/g, '$1 $2')
    // Accents to plain letters ("résumé" → "resume"); symbols and emoji, which a form may refuse, go.
    .normalize('NFKD').replace(/\u2044/g, '/').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e\n]/g, '').replace(/ {2,}/g, ' ');
}

/**
 * Text written by hand as a PDF prints it: plain characters, printable ASCII and line breaks only, trimmed. The studio
 * and the server both read an edit this way, so they agree on when an edit is empty.
 */
export const printable = (text: string) => plain(text).replace(/[^\x20-\x7e\n]/g, '').trim();

export function finish(sentence: string): string {
  // Punctuation sits against the word before it and has a space after it, except inside a figure ("$1,118", "14:30").
  // A dash, ampersand or slash left hanging at the end of what was typed ("for the G-8 -", "zero returned &") goes.
  let s = plain(sentence).replace(/\s+/g, ' ').replace(/\s+[-&/+]+(?=\s*[;,.]|\s*$)/g, '');
  s = s.replace(/\s+([,;:.])(?!\d)/g, '$1').replace(/([,;:])(?=[A-Za-z(])/g, '$1 ').replace(/;\s*;/g, ';').trim();
  s = s.replace(/[;,:\s]+$/, '');
  // A word twice in a row is a slip, typed or left where a word was taken out ("the I the" without the "I"). Only the
  // same word in the same case, and not before a hyphen: "AT at Camp Lejeune", "in in-processing", "two two-day
  // ranges" and "no no-notice findings" say what they mean, and so do "had had" and "that that".
  // "The the" is the same slip with the sentence's capital; "AT at" is an acronym and a word.
  // The second word keeps its punctuation: "several several," is "several,".
  s = s.split(' ').reduce<string[]>((out, w) => {
    const prev = out[out.length - 1];
    const core = /^([A-Za-z]+)[,;:.]?$/.exec(w)?.[1];
    if (prev && core && /^[A-Za-z]+$/.test(prev) && !/^(?:had|that)$/i.test(core) && (prev === core || (/^[A-Z][a-z]+$/.test(prev) && prev.toLowerCase() === core))) {
      out[out.length - 1] = /^[A-Z]/.test(prev) ? w.charAt(0).toUpperCase() + w.slice(1) : w;
      return out;
    }
    out.push(w);
    return out;
  }, []).join(' ');
  s = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** The count as a number of its own: not the "4" of "Q4", the "8" of "G-8", the "2" of "2-Way" or the "26" of "FY26". */
const countPattern = (n: number) => `(?<![\\w$.,/-])(?:${[...new Set([String(n), formatNumber(n)])].map(escapeRe).join('|')})(?![\\w%/]|[.,]\\d|-[A-Za-z])`;
export const statesCount = (text: string, n: number) => new RegExp(countPattern(n)).test(text);

/** The unit as the plural a title writes it: "MIPRs", "vehicles", "batteries". */
function pluralPattern(unit: string): string {
  const words = unit.trim().split(/\s+/);
  const last = words.pop()!;
  const plural = /s$/i.test(last) ? last : /[^aeiou]y$/i.test(last) ? `${last.slice(0, -1)}ies` : /(?:ch|sh|x|z)$/i.test(last) ? `${last}es` : `${last}s`;
  return [...words, plural].map(escapeRe).join('\\s+');
}

/** Units a Marine shortens: "6 hrs", "3 mos", "12 mi". */
const SHORT_UNITS: Array<[RegExp, string]> = [
  [/^(?:hours?|hrs?)$/i, 'hours?|hrs?'], [/^(?:minutes?|mins?)$/i, 'minutes?|mins?'], [/^(?:months?|mos?)$/i, 'months?|mos?'],
  [/^(?:weeks?|wks?)$/i, 'weeks?|wks?'], [/^(?:years?|yrs?)$/i, 'years?|yrs?'], [/^(?:miles?|mi)$/i, 'miles?|mi'],
  [/^(?:kilometers?|kms?)$/i, 'kilometers?|kms?'],
];

/** The unit however a title or an outcome writes it: plural, singular or short. */
function unitWords(unit: string): string {
  const u = unit.trim();
  const short = SHORT_UNITS.find(([re]) => re.test(u));
  if (short) return short[1];
  return [...new Set([pluralPattern(u), escapeRe(unitFor(u, 1))])].join('|');
}

/**
 * Whether the words state this count of this unit: "22 MIPRs", "22 open MIPRs", "6 hrs", "all 85", "28 of 30", "3 of
 * the section's Marines". A number that counts something else ("all paid within 30 days", "on 3 weapon systems") does not.
 */
function statesCountOf(text: string, n: number, unit: string): boolean {
  const num = countPattern(n);
  return new RegExp(`${num}\\s+(?:[\\w/'-]+\\s+){0,2}?(?:${unitWords(unit)})(?![\\w])`, 'i').test(text)
    || new RegExp(`\\b(?:all|both|of)\\s+(?:the\\s+)?${num}(?![\\w])|${num}\\s+of\\b`, 'i').test(text);
}

/** Words after a unit that mean the unit is the noun, not a word describing the next one. */
const NOT_DESCRIBED = new Set([
  'who', 'that', 'which', 'whose', 'where', 'when', 'while', 'ahead', 'each', 'again', 'then', 'daily', 'weekly', 'monthly', 'worth',
  'valued', 'totaling', 'total', 'early', 'late', 'same', 'apiece', 'total',
]);

/** Whether a word after the unit is the noun the unit describes: "records audit", "weapons maintenance", "MIPR amendments". */
function describes(after: string | undefined): boolean {
  if (!after || !/^[a-z][a-z']*[,;:.)]?$/.test(after)) return false;
  const b = bare(after);
  if ([PREPOSITIONS, CONJUNCTIONS, PARTICLES, ARTICLES, DETERMINERS, NOT_DESCRIBED].some((set) => set.has(b))) return false;
  return !/(?:ly|ed|ing)$/.test(b);
}

function withMoney(clause: string, f: Fact, density: Density, seed: number, track: Track, bareVerb: boolean, result: string | null): { clause: string; tail: string | null } {
  // Dollars the title or the outcome states already ("saved the command $12,000") are said once.
  if (!f.money || statesAmount(clause, f.money.amount) || (result && statesAmount(result, f.money.amount))) return { clause, tail: null };
  const amount = dollars(f.money.amount, density, track);
  // A money verb with nothing after it takes the dollars as its object: "Reconciled $441,300 in support of the close".
  if (bareVerb && f.verb?.kind === 'finance' && !/^\S+ \d/.test(clause)) return { clause: `${f.opener} ${amount}${clause.slice(f.opener.length)}`, tail: null };
  // So does "funds" after one: "Obligated funds for the range upgrade" is "Obligated $45,000 for the range upgrade".
  const funds = f.opener ? new RegExp(`^${escapeRe(f.opener)} (?:the )?(?:funds|money|dollars|monies)(?![\\w'-])`) : null;
  if (funds && f.verb?.kind === 'finance' && funds.test(clause)) return { clause: clause.replace(funds, () => `${f.opener} ${amount}`), tail: null };
  // And "money" after whom it was saved for: "Saved the battalion money by consolidating orders" is "Saved the battalion
  // $12,000 by consolidating orders".
  const savedFor = f.opener && f.verb?.lemma === 'save' ? new RegExp(`^${escapeRe(f.opener)} ((?:the|its|their) (?:[A-Za-z0-9-]+ ){1,2})(?:funds|money|dollars|monies)(?![\\w'-])`).exec(clause) : null;
  if (savedFor) return { clause: `${f.opener} ${savedFor[1]}${amount}${clause.slice(savedFor[0].length)}`, tail: null };
  const c = connectorFor(f.money.type, f.money.summable, seed, f.verb);
  const phrase = `${c.word} ${amount}`;
  // Right after the count it belongs to, when the clause has one: "Reconciled 14 ULOs totaling $48,250 in DAI",
  // "Cleared 4 2-Way UMTs totaling $6,206 on the Q4 report", "Processed 30 MIPR amendments obligating $240,000". A
  // count in parentheses, or none, puts it after the clause.
  if (!c.tail && f.quantity) {
    const at = new RegExp(`${countPattern(f.quantity.n)}\\s+(?:[\\w/'-]+\\s+){0,3}?(?:${unitWords(f.quantity.unit)})(?![\\w])`, 'i').exec(clause);
    if (at && !inParens(clause, at.index)) {
      let end = at.index + at[0].length;
      for (let k = 0; k < 2; k += 1) {
        const next = /^ ([a-z][a-z']*)(?=$|[\s,;:.)])/.exec(clause.slice(end));
        if (!next || !describes(next[1])) break;
        end += next[0].length;
      }
      return { clause: `${clause.slice(0, end)} ${phrase}${clause.slice(end)}`, tail: null };
    }
  }
  return { clause, tail: phrase };
}

/** Verbs whose object can be the people counted: "Trained 3 Marines on DAI", "Briefed 40 Marines on the plan". */
const PEOPLE_VERBS = new Set([
  'train', 'mentor', 'coach', 'teach', 'instruct', 'lead', 'supervise', 'direct', 'command', 'manage', 'oversee', 'spearhead', 'qualify',
  'onboard', 'counsel', 'sponsor', 'welcome', 'brief', 'notify', 'license', 'process', 'inspect', 'evaluate', 'assess', 'prepare',
  'certify', 'move', 'dispatch', 'organize', 'guide', 'screen', 'escort', 'transport', 'recruit', 'interview',
]);
/** Verbs hours follow: "Volunteered 6 hours at the food pantry", "Stood 12 hours on post". */
const TIME_VERBS = new Set(['volunteer', 'serve', 'work', 'study', 'spend', 'train', 'instruct', 'teach', 'coach', 'mentor', 'drive', 'fly', 'patrol', 'guard', 'stand']);
/** Verbs that take no object, so a count of things cannot follow them: no "Volunteered 40 boxes", no "Graduated 30 students". */
const NO_OBJECT = new Set([
  'volunteer', 'participate', 'attend', 'graduate', 'go', 'serve', 'work', 'enroll', 'ride', 'fly', 'liaise', 'advocate', 'care',
  'help', 'assist', 'try', 'attempt', 'contribute', 'begin', 'become', 'swim', 'speak', 'study', 'learn', 'meet', 'win', 'pass',
  'score', 'patrol', 'stand', 'hike', 'report', 'rise',
]);

/**
 * Verbs whose next word is part of the verb ("Turned in excess equipment", "Accounted for serialized gear", "Stood in
 * for the SNCOIC"), so no count can go between them: it goes in parentheses.
 */
const PHRASAL = new Set([
  'turn in', 'turn over', 'turn to', 'hand in', 'hand over', 'hand off', 'check in', 'check on', 'sign for', 'sign in', 'sign over', 'sign up',
  'fill in', 'log in', 'take over', 'take on', 'bring in', 'pass on', 'stand by', 'stand in', 'stand up', 'look into', 'look after',
  'look for', 'run through', 'go through', 'send in', 'account for', 'care for', 'pay for', 'head to', 'head for', 'sort through',
  'present to', 'present at', 'present on', 'brief to', 'brief at', 'support with', 'speak to', 'speak at', 'report on', 'report to',
  'explain to', 'keep on', 'wait for', 'apply for', 'ask for', 'call for', 'work on', 'work with', 'deal with', 'help with',
  'assist with', 'assist in', 'participate in', 'step in', 'fill out',
]);
/** Spans of time that read like hours after a verb of time: "Served 3 months as acting section chief". */
const DURATION_UNIT = /^(?:hours?|hrs?|days?|weeks?|months?|years?)$/i;
const WHOLE_NUMBER = /^\$?\d[\d,]*(?:\.\d+)?%?$/;
/** A count typed as a guess: "40+", "~20", "20-plus". The logged count is the exact one. */
const APPROX_COUNT = /^(?:~\d[\d,]*\+?|\d[\d,]*\+|\d[\d,]*-plus)$/i;
/** Words that stand where a count would ("several MIPRs", "multiple vehicles"): the count takes their place. */
const VAGUE_COUNT = new Set(['several', 'multiple', 'many', 'numerous', 'various', 'countless', 'some']);
/** The same after an article: "a few vehicles", "a dozen Marines", "a couple Marines". */
const VAGUE_AFTER_A = new Set(['few', 'dozen', 'couple', 'handful']);
/** The same before "of": "hundreds of MIPRs", "a couple of Marines", "a number of claims". */
const VAGUE_OF = new Set(['hundreds', 'dozens', 'thousands', 'couple', 'handful', 'number', 'lot', 'lots', 'bunch', 'scores']);
/** Number words tidying leaves as words: "one hundred", "a thousand". */
const SPELLED = new Set(['one', 'hundred', 'thousand', ...Object.keys(NUMBER_WORDS)]);
/** "Page 11 entries", "end of month reports", "change of command packages": names a count goes in front of, whole. */
const FIXED_OF = new Set([
  'end of month', 'end of quarter', 'end of year', 'change of command', 'letter of appreciation', 'letter of instruction', 'statement of work',
  'bill of lading', 'power of attorney', 'chain of command', 'line of duty', 'proof of delivery', 'report of survey', 'notice of',
]);
const PEOPLE_WORD = /^(?:Marines?|Sailors?|Soldiers?|Airm[ae]n)$/;
/** A word in a name ("Memorial", "Habitat"): capital then lower case. Not an acronym, a possessive or "Marines". */
const nameWord = (w: string | undefined) => {
  if (!w) return false;
  const t = w.replace(/^[("']+|[)"',;:.]+$/g, '');
  return /^[A-Z][a-z]/.test(t) && !/'s?$/.test(t) && !PEOPLE_WORD.test(t);
};

/** The value of a count spelled in words: "one hundred" is 100, "a thousand" is 1,000, "2 hundred" is 200. */
function spelledValue(words: string[]): number | null {
  let total = 0;
  let current = 0;
  for (const w of words) {
    const b = bare(w);
    if (/^\d+$/.test(b)) current += Number(b);
    else if (b === 'a' || b === 'an' || b === 'one') current += 1;
    else if (b === 'hundred') current = (current || 1) * 100;
    else if (b === 'thousand') { total += (current || 1) * 1000; current = 0; } else if (NUMBER_WORDS[b] !== undefined) current += NUMBER_WORDS[b];
    else return null;
  }
  return total + current;
}

/** Whether the unit word at `i` is part of a name: "Marines Memorial Club", "Single Marines Program", "Toys for Tots". */
function inName(words: string[], i: number, span: number, first: number): boolean {
  if (nameWord(i - 1 >= first ? words[i - 1] : undefined) || nameWord(words[i + span])) return true;
  const self = words[i].replace(/^[("']+|[)"',;:.]+$/g, '');
  return /^[A-Z][a-z]/.test(self) && !PEOPLE_WORD.test(self) && ['for', 'of', 'and', 'the', 'in', 'on'].includes(bare(words[i + span] || '')) && nameWord(words[i + span + 1]);
}

/**
 * The count in front of the noun phrase that ends at `target`: back over up to two words that describe it ("travel
 * claims", "returned DTS vouchers", "aged and dormant ULOs", "end of month reports"), to the word it follows. A word
 * that stands for a count ("several", "a dozen", "hundreds of", "40+", "one hundred") gives way to it; a different
 * number is the Marine's to correct ("typed"); a name before the noun keeps it out (null).
 */
function placeCount(words: string[], target: number, first: number, n: number): string | 'typed' | null {
  let start = target;
  let described = 0;
  while (start > first && described < 2) {
    const w = words[start - 1];
    const b = bare(w);
    const prev = start - 2 >= first ? words[start - 2] : undefined;
    const pb = bare(prev || '');
    if (b === 'of' && prev && FIXED_OF.has(`${pb} of ${bare(words[start])}`)) { start -= 2; described += 2; continue; }
    if (/[,;:(]$/.test(w) || /'s?$/i.test(w.replace(/[,;:.)]+$/, '')) || PREPOSITIONS.has(b) || PARTICLES.has(b) || ARTICLES.has(b) || BEFORE_COUNT.has(b)) break;
    if (WHOLE_NUMBER.test(w.replace(/[,;:.]+$/, ''))) {
      // "Page 11 entries", "NAVMC 10274 forms": a form's name and number describe the noun.
      if (prev && /^[A-Z]/.test(prev) && !/[,;:]$/.test(prev)) { start -= 2; described += 2; continue; }
      break;
    }
    if (APPROX_COUNT.test(w) || VAGUE_COUNT.has(b) || VAGUE_AFTER_A.has(b) || SPELLED.has(b)) break;
    if (CONJUNCTIONS.has(b)) {
      // "aged and dormant ULOs", "FY25 and FY26 ULOs", "leave and liberty requests", "DTS and GPC reconciliations": two
      // words that describe it, joined. Not two nouns ("trucks and 10 trailers") or two verbs ("Reviewed and approved").
      const describing = /\d/.test(pb) || /(?:ed|ant|ent|al|ive|ic|ous|ary|ful|less|able|ible)$/.test(pb) || /^[A-Z][A-Z0-9-]+$/.test((prev || '').replace(/[,;:.]+$/, ''))
        || (/^[a-z]+$/.test(pb) && nounish(prev) && (!/s$/.test(pb) || /ss$/.test(pb)) && !looksPast(pb));
      if (prev && !/[,;:]$/.test(prev) && describing) { start -= 2; described += 2; continue; }
      break;
    }
    // The second verb of a list: "Reviewed and approved travel claims", "Processed, reconciled and filed".
    if (looksPast(b) && (CONJUNCTIONS.has(pb) || /,$/.test(words[start - 2] || ''))) break;
    // A gerund after a preposition is a verb: "by processing pending claims".
    if (/ing$/.test(b) && PREPOSITIONS.has(pb)) break;
    // A name before the noun ("Habitat for Humanity homes"): a count cannot go between them.
    if (nameWord(w)) return null;
    start -= 1;
    described += 1;
  }
  const w0 = start - 1 >= first ? words[start - 1] : '';
  const b0 = bare(w0);
  const at = (i: number) => (i >= first ? bare(words[i] || '') : '');
  // Another number already counts it ("Processed 40 MIPRs" logged as 22): the words stand as typed. "2-Way" does not.
  if (w0 && WHOLE_NUMBER.test(w0.replace(/[,;:.]+$/, ''))) return 'typed';
  let from = start;
  if (w0 && (APPROX_COUNT.test(w0) || VAGUE_COUNT.has(b0))) from = start - 1;
  else if (VAGUE_AFTER_A.has(b0)) from = start - 1 - (/^an?$/.test(at(start - 2)) ? 1 : 0);
  else if (b0 === 'of' && VAGUE_OF.has(at(start - 2))) from = start - 2 - (/^an?$/.test(at(start - 3)) ? 1 : 0);
  else if (SPELLED.has(b0)) {
    let j = start - 1;
    while (j - 1 >= first && (SPELLED.has(at(j - 1)) || /^\d+$/.test(at(j - 1)) || /^an?$/.test(at(j - 1)))) j -= 1;
    if (spelledValue(words.slice(j, start)) !== n) return 'typed';
    from = j;
  } else if (b0 === 'the' && at(start - 2) !== 'of') from = start - 1;
  return [...words.slice(0, from), formatNumber(n), ...words.slice(start)].join(' ');
}

/**
 * Where the count goes. In front of its noun when the title names the unit ("Processed 22 MIPRs for the G-8",
 * "Conducted PMCS on the battalion's 12 MTVRs", "Processed 22 travel claims"; "the" or a word standing for a count gives
 * way); as the object of a verb that takes one when the title goes straight to a preposition ("Inspected 30 vehicles
 * for corrosion", "Trained 3 Marines on DAI", "Volunteered 6 hours at the pantry"); otherwise in parentheses after the
 * clause. Not in a name, not before a noun the unit describes ("a records audit"), not between a verb and its particle
 * ("Turned in"). A title that states a count of the unit already, even another one, is the Marine's to correct, and is
 * left; so is a count the outcome states ("collected 400 toys"). A distance or a score goes in parentheses.
 */
function withCount(clause: string, f: Fact, result: string | null): string {
  if (!f.quantity) return clause;
  const { n, unit, kind } = f.quantity;
  const shown = `${formatNumber(n)}${/^%/.test(unit.trim()) ? '' : ' '}${kind === 'measure' ? unit : unitFor(unit, n)}`;
  // "(1 Marine)" after "the new PFC" adds nothing; a count of one is in the words already.
  if (n === 1 || statesCountOf(clause, n, unit) || (result && statesCountOf(result, n, unit))) return clause;
  // A percent is stated by its figure: "339%".
  if (/^%/.test(unit.trim()) && (clause.includes(shown) || Boolean(result?.includes(shown)))) return clause;
  const words = clause.split(' ');
  const first = f.opener ? 1 : 0;
  const unitAt = new RegExp(`^(?:${pluralPattern(unit)})$`, 'i');
  const span = unit.trim().split(/\s+/).length;
  const wordAt = (i: number) => words.slice(i, i + span).join(' ').replace(/^[("']+/, '').replace(/[,;:.)"']+$/, '');
  // A name is not the unit: "Toys for Tots" holds no toys.
  const lower = /^[a-z]/.test(unit.trim());
  let mentioned = false;
  if (f.opener && kind !== 'measure') {
    // A bare verb takes its count as its object: "Mentored 2 Marines", not "Mentored (2 Marines)".
    // Not "Saved 1,200 documents": what was saved is the money ("Saved $441,300 (1,200 documents)").
    if (words.length === 1 && !(f.verb?.lemma === 'save' && f.money)) return `${clause} ${shown}`;
    for (let i = first; i + span <= words.length; i += 1) {
      if (!unitAt.test(wordAt(i))) continue;
      mentioned = true;
      if ((lower && /^[A-Z]/.test(wordAt(i))) || inName(words, i, span, first)) continue;
      // "Audited records (OMPFs)": the count goes with the noun the parentheses name.
      const glossed = /^\(/.test(words[i]) && /\)[,;:.]*$/.test(words[i + span - 1]);
      if (!glossed && !/[,;:.)]$/.test(words[i + span - 1]) && describes(words[i + span])) continue;
      const target = glossed ? i - 1 : i;
      if (target < first) continue;
      const placed = placeCount(words, target, first, n);
      if (placed === 'typed') return clause;
      if (placed) return placed;
    }
  }
  // A number the title gives with no unit beside it is the Marine's count as typed: "Processed 40 requests".
  if (!mentioned && statesCount(clause, n)) return clause;
  if (f.opener && kind !== 'measure') {
    const verb = f.verb;
    // Only a verb the lexicon knows takes the count as its object; any other keeps it in parentheses.
    const known = Boolean(verb && VERB_FORMS.get(verb.past)?.entry === verb);
    const next = bare(words[first] || '');
    const time = kind === 'time' || DURATION_UNIT.test(unit.trim());
    const takes = known && (kind === 'people' ? PEOPLE_VERBS.has(verb!.lemma) : time ? TIME_VERBS.has(verb!.lemma) : !NO_OBJECT.has(verb!.lemma) && verb!.kind !== 'learn');
    if (takes && PREPOSITIONS.has(next) && next !== 'of' && !PHRASAL.has(`${verb!.lemma} ${next}`)) return [words[0], shown, ...words.slice(1)].join(' ');
  }
  // A title that ends on its own parentheses takes the count inside them: "(OMPFs; 85 records)", never "(OMPFs) (85
  // records)"; a pair that holds only the unit takes the count in it: "(85 OMPFs)".
  const lone = new RegExp(`\\((?:${pluralPattern(unit)})\\)$`, 'i');
  if (lone.test(clause)) return clause.replace(lone, `(${shown})`);
  return /\)$/.test(clause) ? `${clause.slice(0, -1)}; ${shown})` : `${clause} (${shown})`;
}

/** Shortens a long outcome at its first natural break, when the break leaves the main claim whole. */
function shortResult(result: string): string {
  if (result.length <= 70) return result;
  const cut = result.slice(25).search(/[,;]\s|\s-\s/);
  return cut >= 0 ? result.slice(0, 25 + cut) : result;
}

/** One entry as a sentence. Full keeps the system and who it was for; compact keeps the claim, the count and the outcome. */
export function sentenceFor(f: Fact, density: Density, seed: number, track: Track = 'jepes'): string {
  const result = f.result ? (density === 'compact' ? shortResult(f.result) : f.result) : null;
  const typed = clauseOf(f);
  let clause = withCount(typed, f, result);
  const money = withMoney(clause, f, density, seed, track, Boolean(f.opener) && typed === f.opener, result);
  clause = money.clause;
  if (density === 'full') {
    if (f.system && !has(clause, f.system)) clause += ` in ${f.system}`;
    if (f.organization && !has(clause, f.organization)) clause += ` for ${f.organization}`;
  }
  if (money.tail) clause += `, ${money.tail}`;
  // FITREP's "supporting" is an "-ing" phrase too, so after a trailing figure (", saving $18.3K") it reads "in support of".
  if (f.purpose) clause += track === 'fitrep' && !money.tail ? `, supporting ${f.purpose}` : `, in support of ${f.purpose}`;
  const trailing = Boolean(money.tail || (f.purpose && track === 'fitrep'));
  const text = result ? joinResult(clause, result, track, trailing) : clause;
  return finish(track === 'fitrep' ? shortDollars(text) : text);
}

/**
 * FITREP Section C writes every figure of ten thousand dollars or more short, the ones the Marine typed too, so one
 * block holds one form: "Reconciled 14 ULOs totaling $48,250" is "...totaling $48.3K". The value does not change.
 */
export function shortDollars(text: string): string {
  return text.replace(/\$(\d{1,3}(?:,\d{3})+|\d{5,})(\.\d+)?(?![\d,KMBT]|\s*(?:thousand|million|billion)\b)/g, (all, whole: string, cents?: string) => {
    const value = Number(`${whole.replace(/,/g, '')}${cents || ''}`);
    return value >= 1e4 ? shortMoney(value) : all;
  });
}

/** `paidN` is how much of the count the dollars belong to: all of it, or only the members that carry a figure. */
export interface Group { key: string; members: Fact[]; verbPast: string; unit: string; n: number; money: number; moneyType: string | null; system: string | null; paidN?: number }

const TRAILING_LINKS = new Set(['for', 'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'with', 'and', 'or', 'by', 'from', 'into', 'via', 'during', 'across']);
/**
 * Words that open a new phrase, so the words before them are whole: "MIPRs for the G-8 | within 3 days". An article
 * does not, and neither do "of", "and" and "or", which carry a name or a list on ("the Department | of the Navy", "the
 * G-8 | and G-4"). An "-ing" word or a bracket opens one too ("for the G-8 | using GFEBS", "for the G-8 | ($240K)").
 */
const PHRASE_OPENS = new Set([...[...TRAILING_LINKS].filter((w) => !['the', 'a', 'an', 'of', 'and', 'or'].includes(w)), 'within', 'before', 'after', 'under', 'over', 'ahead', 'than', 'since', 'until', 'through', 'toward', 'towards', 'against', 'among', 'around', 'between', 'beyond', 'without', 'per', 'as', 'while', 'including', 'totaling', 'totalling', 'worth', 'valued', 'valuing', 'obligating', 'saving', 'recovering', 'reconciling', 'amounting']);
/** Where a member's own figures start: a number, a dollar sign or a money word, which a total must not repeat. */
const OWN_FIGURE = (w: string) => /^\(?\$|^\(?\d[\d,.]*(?:%|k|m)?\)?[,;:]?$/i.test(w) || /^(?:totaling|totalling|worth|valued|valuing|obligating|saving|recovering|amounting)$/i.test(w);
const opens = (w: string) => PHRASE_OPENS.has(w.toLowerCase()) || w.startsWith('(') || (/^[a-z]{2,}ing$/.test(w) && !NOT_GERUND.has(w));
/**
 * Whether a comma ends the shared words: an outcome or a clause of the member's own follows ("for the S-4, all passed"),
 * not the rest of a name ("1st Battalion, 6th Marines", "the G-8, Camp Lejeune").
 */
const endsAtComma = (word: string | undefined, next: string | undefined) => Boolean(word && /[,;:]$/.test(word) && !(next && /^(?:\d+(?:st|nd|rd|th|d)\b|[A-Z])/.test(next)));
const balanced = (words: string[]) => words.join(' ').split('(').length === words.join(' ').split(')').length;

/**
 * What every member says around its count, put in the total's number: "Processed 22 MIPRs for the G-8" and
 * "Processed 14 MIPRs for the G-8" share "MIPRs for the G-8"; with "...for the G-1" they share only "MIPRs". The words
 * in front of the unit stay only when every member has them ("leave and liberty requests").
 */
function sharedPhrase(g: Group): { phrase: string; after: string } {
  const unit = unitFor(g.unit, g.n);
  const parts = g.members.map((m) => {
    const clause = withCount(clauseOf(m), m, null);
    const lead = `${m.opener} ${formatNumber(m.quantity!.n)} `;
    if (!clause.startsWith(lead)) return null;
    const words = clause.slice(lead.length).split(' ');
    const span = m.quantity!.unit.trim().split(/\s+/).length;
    const unitAt = new RegExp(`^(?:${pluralPattern(m.quantity!.unit)})$`, 'i');
    const i = words.findIndex((_w, k) => unitAt.test(words.slice(k, k + span).join(' ').replace(/[,;:.)]+$/, '')));
    if (i < 0 || /[,;:.)]$/.test(words[i + span - 1])) return null;
    return { before: words.slice(0, i), after: words.slice(i + span) };
  });
  if (parts.some((x) => !x)) return { phrase: unit, after: '' };
  const all = parts as Array<{ before: string[]; after: string[] }>;
  const key = (w: string[]) => w.join(' ').toLowerCase();
  const before = all.every((x) => key(x.before) === key(all[0].before)) ? all[0].before : [];
  // The words every member has after the unit, up to its own figures ("within 3 days", "totaling $5,000"), which are
  // the member's and not the total's.
  let k = 0;
  while (all.every((x) => k < x.after.length && !OWN_FIGURE(x.after[k]) && x.after[k].toLowerCase() === all[0].after[k].toLowerCase())) k += 1;
  // Kept only where the shared words end a phrase in every member: "for the G-8" from "...for the G-8" and "...for the
  // G-8 within 3 days", never "within" from "within 3 days" and "within 5 days".
  const whole = (n: number) => all.every((x) => n === x.after.length || opens(x.after[n]) || endsAtComma(x.after[n - 1], x.after[n]));
  while (k > 0 && !whole(k)) k -= 1;
  const after = all[0].after.slice(0, k);
  // The comma that ended the shared words is not theirs ("for the S-4," is "for the S-4").
  if (after.length) after[after.length - 1] = after.at(-1)!.replace(/[,;:]+$/, '');
  // Nor does a phrase end on its link: "for the", "before".
  while (after.length && (TRAILING_LINKS.has(after.at(-1)!.toLowerCase()) || opens(after.at(-1)!) || !balanced(after) || /[,;:]$/.test(after.at(-1)!))) after.pop();
  return { phrase: [...before, unit].join(' '), after: after.join(' ') };
}

const sameText = (values: Array<string | null>) => values.every((v) => v && v.toLowerCase() === values[0]!.toLowerCase());

/**
 * The same work as one total, said once (the Marine's record compiled, not listed action by action): "Cleared 100 OCMTs
 * totaling $1.2M in DAI." What every member shares stays: the words after the count, the system, the organization, what
 * it supported. An outcome every member states is said once; otherwise the strongest one is said with the entries it is
 * true for: "..., including 14 in DAI: all cleared on the next report".
 */
export function sentenceForGroup(g: Group, density: Density, seed: number, track: Track = 'jepes'): string {
  const { phrase, after } = sharedPhrase(g);
  let clause = `${g.verbPast.charAt(0).toUpperCase()}${g.verbPast.slice(1)} ${formatNumber(g.n)} ${phrase}`;
  const shorten = (r: string) => (density === 'compact' ? shortResult(r) : r);
  const stated = g.members.filter((m) => m.result);
  const oneOutcome = stated.length > 0 && stated.length === g.members.length && sameText(stated.map((m) => m.result));
  const best = stated.length && !oneOutcome ? [...stated].sort((a, b) => Number(b.strongResult) - Number(a.strongResult) || b.quantity!.n - a.quantity!.n)[0] : null;
  const outcome = oneOutcome ? shorten(stated[0].result!) : best ? shorten(best.result!) : null;
  // An outcome that already states the figure says it once: "including 14: cleared $48,250 in aged obligations".
  const c = g.money && !(outcome && statesAmount(outcome, g.money)) ? connectorFor(g.moneyType, true, seed, g.members[0]?.verb) : null;
  const money = c ? `${c.word} ${dollars(g.money, density, track)}` : '';
  // Dollars that only some members carry are said of those: "Reconciled 24 ULOs in DAI, 14 of them totaling $48,250".
  const part = c && g.paidN != null && g.paidN < g.n ? g.paidN : null;
  // When the entry with the outcome is the one with the dollars, one "including" says both.
  const together = part != null && best != null && best.money != null && best.quantity!.n === part;
  const purposes = g.members.map((m) => m.purpose);
  const purpose = purposes[0] && sameText(purposes) ? purposes[0] : null;
  // With more to say of every member after it, the paid part is set apart, so what follows is not read as theirs alone:
  // "Reconciled 24 ULOs (14 of them totaling $48,250), cutting the backlog to zero".
  const aside = part != null && !together && Boolean(purpose || outcome);
  if (c && part == null && !c.tail) clause += ` ${money}`;
  if (after && density === 'full') clause += ` ${after}`;
  if (density === 'full') {
    if (g.system && !has(clause, g.system)) clause += ` in ${g.system}`;
    const orgs = g.members.map((m) => m.organization);
    if (orgs[0] && sameText(orgs) && !has(clause, orgs[0])) clause += ` for ${orgs[0]}`;
  }
  if (c?.tail && part == null) clause += `, ${money}`;
  if (part != null && !together) clause += aside ? ` (${formatNumber(part)} of them ${money})` : `, ${formatNumber(part)} of them ${money}`;
  if (purpose) clause += track === 'fitrep' && !c?.tail ? `, supporting ${purpose}` : `, in support of ${purpose}`;
  const trailing = Boolean((c?.tail && part == null) || (part != null && !aside && !together) || (purpose && track === 'fitrep'));
  let text = clause;
  if (oneOutcome) text = joinResult(clause, outcome!, track, trailing);
  else if (best) {
    // The outcome is true only of the entries that state it, so it is said with them: "including 14 in DAI: ...". When
    // the dollars are another part's, these are said to be the rest: "(14 of them totaling $48,250), including 10 of the rest".
    const where = best.system && best.system !== g.system ? ` in ${best.system}` : '';
    const rest = part != null && !together && best.money == null ? ' of the rest' : '';
    text = `${clause}, including ${formatNumber(best.quantity!.n)}${rest}${where}${together ? ` ${money}` : ''}: ${outcome}`;
  }
  return finish(track === 'fitrep' ? shortDollars(text) : text);
}

/**
 * The rest of an area, for counted work with no sentence of its own, said once: "Reconciled 31 more ULOs totaling
 * $42,500 and processed 12 MIPRs." Each part opens with its verb, so the sentence does too.
 */
export function restSentence(parts: string[]): string | null {
  if (!parts.length) return null;
  const list = parts.length === 1 ? parts[0] : parts.length === 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return finish(list);
}
