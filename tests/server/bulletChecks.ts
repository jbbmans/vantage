import { NOT_VERBS, VERB_FORMS } from '../../shared/writer/lexicon.ts';
import { readEntry, unitIdentity, type EntryInput } from '../../shared/writer/facts.ts';
import { bulletFor } from '../../shared/writer/coach.ts';
import { narrativeConfig, type Track } from '../../shared/evaluation.ts';
import type { WrittenNarrative } from '../../shared/writer/compose.ts';

/**
 * The checks every bullet the writer produces is held to, whatever the entry: it opens with a past-tense verb, has no
 * double parentheses, never puts "resulting in" before a verb, says no number the entries did not give, loses none of
 * the count or dollars, says no figure more often than the entries do, ends with a period and stays within its limit.
 * Plus the joins (no outcome glued on after a semicolon, no verb said twice, no two "-ing" phrases stacked) and plain
 * text: ASCII, no first person, no word twice in a row. Each check returns what it found wrong, so a failure names the
 * bullet and the rule.
 */

/** A single bullet longer than this is a paragraph. A narrative is held to its own limit instead. */
export const BULLET_LIMIT = { characters: 250, words: 40 };

interface Figure {
  value: number; money: boolean; tolerance: number; text: string;
  /** A number of its own, not the digits of "Q4", "G-8", "FY26", "2-Way" or "24-hour". */
  standalone: boolean;
  /** The text that follows it, to read its unit, and where it starts. */
  after: string;
  at: number;
}

// "$48,250", "$48.3K", "1,200", "3.8", "100%", and the digits inside "Q4", "G-8", "FY26" and "2-Way".
const FIGURE = /(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:([KMBT])(?![A-Za-z]))?/g;
const SCALE: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

export function figuresIn(text: string): Figure[] {
  const out: Figure[] = [];
  for (const m of text.matchAll(FIGURE)) {
    const money = Boolean(m[1]);
    const scale = money && m[4] ? SCALE[m[4]] : 1;
    const decimals = m[3] ? m[3].length - 1 : 0;
    const value = Number(`${m[2].replace(/,/g, '')}${m[3] || ''}`) * scale;
    const end = m.index! + m[0].length;
    const standalone = !/[A-Za-z-]/.test(text[m.index! - 1] ?? ' ') && !/^[A-Za-z]|^-[A-Za-z]/.test(text.slice(end, end + 2));
    // What a shown dollar figure could have been rounded from: "$48.3K" is anything within $50 of $48,300. A count,
    // a grade or a percent is said as typed.
    out.push({ value, money, tolerance: money ? (scale * 10 ** -decimals) / 2 + 1e-9 : 1e-9, text: m[0], standalone, after: text.slice(end), at: m.index! });
  }
  return out;
}

const texts = (e: EntryInput) => [e.title, e.result, e.system, e.organization, e.unit_label, e.category].filter((x): x is string => typeof x === 'string');
const num = (x: unknown) => (x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const near = (a: { value: number; money: boolean }, f: Figure) => a.money === f.money && Math.abs(a.value - f.value) <= f.tolerance;

interface Known { value: number; money: boolean }

/** Every number the entries gave: in their words, their count and their dollars, each as what it is. */
function given(entries: EntryInput[]): Known[] {
  const out: Known[] = [];
  for (const e of entries) {
    for (const t of texts(e)) for (const f of figuresIn(t)) out.push({ value: f.value, money: f.money });
    const q = num(e.quantity);
    const d = num(e.dollar_amount);
    if (q !== null) out.push({ value: q, money: false });
    if (d !== null) out.push({ value: d, money: true });
  }
  return out;
}

const SINGLE = { names: narrativeConfig('jepes').names, areas: narrativeConfig('jepes').areas };
const lemmaOf = (e: EntryInput) => readEntry(e, SINGLE).verb?.lemma ?? '';

/**
 * Totals a group or summary can say, of the kind each is: the count of one kind of work ("Reconciled 45 ULOs"), the
 * dollars of one dollar type, alone or on that count. Where few entries share a dollar type, any part of them: the
 * summary says only the dollars no other sentence carries.
 */
function derived(entries: EntryInput[]): Known[] {
  const by = new Map<string, { n: number; d: number[] }>();
  const add = (key: string, e: EntryInput) => {
    const was = by.get(key) ?? { n: 0, d: [] };
    was.n += num(e.quantity) ?? 0;
    const d = num(e.dollar_amount);
    if (d !== null) was.d.push(d);
    by.set(key, was);
  };
  for (const e of entries) {
    const unit = unitIdentity(String(e.unit_label || ''));
    const lemma = lemmaOf(e);
    const type = String(e.dollar_type ?? '');
    add(`n:${lemma}|${unit}`, e);
    add(`u:${unit}`, e);
    add(`t:${type}`, e);
    add(`nt:${lemma}|${unit}|${type}`, e);
  }
  const out: Known[] = [];
  const cents = (x: number) => Math.round(x * 100) / 100;
  for (const [key, { n, d }] of by) {
    if (key.startsWith('n:') || key.startsWith('u:')) out.push({ value: n, money: false });
    if (!d.length) continue;
    out.push({ value: cents(d.reduce((a, b) => a + b, 0)), money: true });
    if (key.startsWith('t:') && d.length <= 12) {
      let sums = new Set<number>([0]);
      for (const x of d) sums = new Set([...sums, ...[...sums].map((s) => cents(s + x))]);
      for (const s of sums) out.push({ value: s, money: true });
    }
  }
  return out;
}

export interface CheckOptions {
  /** The entries this text speaks for. */
  sources: EntryInput[];
  /** A total of several entries (a group or a summary) may say their sums. */
  totals?: boolean;
  /** Characters; a bullet defaults to BULLET_LIMIT. */
  limit?: number;
  /** Rules not to apply: the opener, for an entry that names no work ("FY26 year-end close"), which the review flags instead. */
  skip?: string[];
  /** FITREP Section C writes every figure of $10,000 or more short. */
  track?: Track;
}

const bare = (w: string) => w.toLowerCase().replace(/[^a-z'-]/g, '');
const pastLike = (w: string) => VERB_FORMS.get(w)?.form === 'past' || (/^[a-z]{3,}ed$/.test(w) && !NOT_VERBS.has(w));
const pastVerb = (w: string) => {
  const t = w.replace(/[^A-Za-z'-]+$/, '');
  if (!/^[A-Z]/.test(t)) return false;
  return VERB_FORMS.get(t.toLowerCase())?.form === 'past' || (/^[A-Z][a-z]+ed$/.test(t) && !NOT_VERBS.has(t.toLowerCase()));
};
const lemma = (w: string) => VERB_FORMS.get(bare(w))?.entry.lemma;
const DETERMINER = /^(?:the|a|an|all|each|every|its|their|his|her|this|that|these|those|no|zero|one|\d[\d,.%]*)$/;
/** Words after a verb that say when or how, not what: "completed ahead of schedule", "cleared on the next report". */
const NO_OBJECT_NEXT = /^(?:on|in|at|by|for|to|from|with|within|without|before|after|during|out|up|off|down|over|under|ahead|early|late|again|back|\w+ly)$/;
const PREDICATE_NEXT = /^(?:on|in|at|by|for|to|from|with|within|without|before|after|during|out|up|off|down|over|ahead|early|late|again|the|a|an|all|its|their|\d.*|\w+ly)$/;

/**
 * A finite verb in the words after "resulting in": "28 Marines passed on the first attempt", "no vehicles broke down",
 * "no one was hurt", "35 Marines qualified expert", "the CO approved funding", "the section passes inspections".
 */
function verbAfterResultingIn(words: string[]): string | null {
  for (let i = 0; i < words.length; i += 1) {
    const w = bare(words[i]);
    if (/^(?:was|were|is|are|has|have|had)$/.test(w)) return w;
    const third = VERB_FORMS.get(w)?.form === 'third';
    if (!pastLike(w) && !third) continue;
    if (i === 0) return w;
    const prev = bare(words[i - 1]);
    if (DETERMINER.test(prev)) continue;
    // After a counted subject or a name: "35 Marines qualified", "the CO approved".
    if (pastLike(w) && ((/^\d/.test(words[i - 2] || '') && /s$/.test(prev)) || /^[A-Z]{2,}$/.test(words[i - 1]))) return w;
    const next = bare(words[i + 1] || '');
    if (!next || PREDICATE_NEXT.test(next)) return w;
    // A third form with an object of its own: "the section passes inspections".
    if (third && !/^[a-z]+(?:ed|al|ive|ary|ous|ic|ful|less|ing)$/.test(prev)) return w;
  }
  return null;
}

/** Whether the words after a figure name this unit within a few words: "14 unliquidated obligations (ULOs)", "4 2-Way UMTs". */
function unitNear(f: Figure, unit: string): boolean {
  if (!unit) return true;
  if (/^%/.test(unit) || unit === '%') return /^%/.test(f.after);
  return f.after.split(/\s+/).filter(Boolean).slice(0, 8).some((w) => unitIdentity(w.replace(/^[("']+|[)"',;:.]+$/g, '')) === unit);
}

/** Whether the entry's own words state this count, as the writer leaves it to them: "all 4 earned", "28 of 30". */
function wordsCount(e: EntryInput, q: number, unit: string): boolean {
  for (const t of [e.title, e.result].filter((x): x is string => typeof x === 'string')) {
    for (const f of figuresIn(t)) {
      if (!f.standalone || f.money || f.value !== q) continue;
      const before = t.slice(0, f.at).trim().split(/\s+/).at(-1)?.toLowerCase() || '';
      const next = bare(f.after.trim().split(/\s+/)[0] || '');
      // Right after the title's verb it is the verb's object as typed: "Mentored 2 Cpls" with 2 Marines.
      const object = t === e.title && t.slice(0, f.at).trim().split(/\s+/).length === 1;
      if (object || /^(?:all|both|of|the)$/.test(before) || !next || unitNear(f, unit) || pastLike(next) || /^(?:of|in|on|at|for|to|from|with|by)$/.test(next)) return true;
    }
  }
  return false;
}

// The writer's own reading of a title's "I": "Phase I", "Class I" and "I MEF" are not the first person.
const FIRST_PERSON = /(?<!\b(?:Class|Phase|Tier|Level|Part|Title|Stage|Annex)\s)\bI\b(?!\s+(?:MEF|MHG|MIG|MSB)\b)|\b(?:[Mm]e|[Mm]y|[Ww]e|[Oo]urs?|[Mm]yself)\b|\bus\b/;
const ABBREVIATION = /\b(?:Lt|Col|Capt|Maj|Gen|Sgt|Cpl|Pvt|Mr|Mrs|Ms|Dr|St|No|Vol|Jr|Sr|Co|Bn|vs|etc)\.$/;
const NOT_PARTICIPLE = /^(?:during|nothing|something|anything|everything|morning|evening)$/;

/** A word twice in a row, by the writer's rule: the same word in the same case, or with the sentence's capital. */
function doubled(text: string): string | null {
  const words = text.split(' ');
  for (let i = 1; i < words.length; i += 1) {
    const prev = words[i - 1];
    const core = /^([A-Za-z]+)[,;:.]?$/.exec(words[i])?.[1];
    if (!core || !/^[A-Za-z]+$/.test(prev) || /^(?:had|that)$/i.test(core)) continue;
    if (prev === core || (/^[A-Z][a-z]+$/.test(prev) && prev.toLowerCase() === core)) return core;
  }
  return null;
}

/** What is wrong with one sentence, by rule. Empty when it passes. */
export function checkSentence(text: string, opts: CheckOptions): string[] {
  const bad: string[] = [];
  const say = (rule: string, detail: string) => { if (!opts.skip?.includes(rule)) bad.push(`${rule}: ${detail} in "${text}"`); };
  const words = text.split(/\s+/).filter(Boolean);

  // 1. It opens with what was done, in the past tense, with its capital.
  if (!words.length || !pastVerb(words[0])) say('past-tense opener', `"${words[0] ?? ''}"`);

  // 2. No parentheses inside parentheses, none doubled, none empty, no two pairs side by side.
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (depth > 1 || depth < 0) { say('double parentheses', 'nested or unbalanced'); break; }
  }
  if (depth !== 0 && depth <= 1 && !bad.some((b) => b.startsWith('double'))) say('double parentheses', 'unbalanced');
  if (/\(\s*\(|\)\s*\)|\)\s*\(|\(\s*\)/.test(text)) say('double parentheses', 'doubled, empty or side by side');

  // 3. "resulting in" names an outcome, never another clause ("resulting in reduced", "resulting in 28 Marines passed").
  for (const m of text.matchAll(/\bresulting in ([^;,.]+)/gi)) {
    const verb = verbAfterResultingIn(m[1].split(/\s+/).filter(Boolean));
    if (verb) say('resulting in', `before "${verb}"`);
  }

  // 4. Every number comes from the entries, as what it is (dollars as dollars), rounded at most for dollars; a total
  // may say a sum of one kind, and a group how many entries it speaks for.
  const out = figuresIn(text);
  const from = given(opts.sources);
  const allowed = opts.totals ? [...from, ...derived(opts.sources)] : from;
  const entriesSaid = (f: Figure) => Boolean(opts.totals) && !f.money && f.value === opts.sources.length && /^\s+(?:actions|entries)\b/.test(f.after);
  for (const f of out) if (!entriesSaid(f) && !allowed.some((v) => near(v, f))) say('number provenance', `"${f.text}" is not in the entries`);

  // 5. Nothing of the entry is lost: its count and its dollars are in its bullet. A title that types a count of its own
  // keeps it as typed.
  if (!opts.totals && opts.sources.length === 1) {
    const e = opts.sources[0];
    const q = num(e.quantity);
    const d = num(e.dollar_amount);
    const unit = unitIdentity(String(e.unit_label || ''));
    const typed = figuresIn(String(e.title || '')).some((f) => f.standalone && !f.money && f.value !== q && unit && unitIdentity(f.after.trim().split(/[\s,;.)]/)[0] || '') === unit);
    // The count is with its unit ("22 MIPRs", "(40 Marines)"), or left to the entry's own words that state it ("all 4
    // earned"). The same number counting something else ("serving 4 families" for 4 hours) is not the count.
    const shown = out.some((f) => f.standalone && !f.money && f.value === q && (unitNear(f, unit) || wordsCount(e, q!, unit)));
    if (q !== null && q > 1 && !typed && !shown) say('figure missing', `count ${q}`);
    if (d !== null && d > 0 && !out.some((f) => near({ value: d, money: true }, f))) say('figure missing', `dollars ${d}`);
  }

  // 6. No figure said more often than the entries say it. A count typed in the words and the same count in the count
  // field are one statement ("Reconciled 14 ULOs" with 14 ULOs), unless the words count something else ("a 10 km hike"
  // with 10 Marines).
  const stated: Known[] = [];
  for (const e of opts.sources) {
    const words = texts(e).flatMap((t) => figuresIn(t));
    stated.push(...words);
    const unit = unitIdentity(String(e.unit_label || ''));
    const sameThing = (w: Figure) => {
      const next = w.after.trim().split(/[\s,;.)]/)[0] || '';
      return !next || /^(?:in|on|at|for|to|of|and|or|the|a|an|from|with|by)$/i.test(next) || !/^[A-Za-z]/.test(next) || unitIdentity(next) === unit;
    };
    const q = num(e.quantity);
    const d = num(e.dollar_amount);
    if (q !== null && !words.some((w) => w.standalone && !w.money && w.value === q && sameThing(w))) stated.push({ value: q, money: false });
    if (d !== null && !words.some((w) => w.money && Math.abs(w.value - d) <= w.tolerance)) stated.push({ value: d, money: true });
  }
  const seen = new Set<string>();
  for (const f of out) {
    if (seen.has(f.text) || !f.standalone) continue;
    seen.add(f.text);
    const times = out.filter((g) => g.standalone && g.money === f.money && Math.abs(g.value - f.value) <= Math.max(f.tolerance, g.tolerance)).length;
    const typed = stated.filter((g) => near(g, f)).length;
    if (times > 1 && times > typed) say('figure twice', `"${f.text}" ${times} times`);
  }

  // 7. It ends with one period, after a word, a figure or a closing mark, with nothing left dangling, and is one
  // sentence: "Zero returned. CO was pleased." is two.
  if (!/[A-Za-z0-9%)"']\.$/.test(text)) say('period', 'does not end with one period');
  if (/\s[-&/+]+(?=\s*[;,.]|\s*$)/.test(text)) say('period', 'dangling punctuation');
  for (const m of text.matchAll(/([a-z0-9)])\.\s+(?=[A-Z])/g)) if (!ABBREVIATION.test(text.slice(0, m.index! + 2))) say('period', 'two sentences');

  // 8. Within the limit.
  const limit = opts.limit ?? BULLET_LIMIT.characters;
  if (text.length > limit) say('limit', `${text.length} characters over ${limit}`);
  if (opts.limit === undefined && words.length > BULLET_LIMIT.words) say('limit', `${words.length} words over ${BULLET_LIMIT.words}`);

  // 9. The joins. An outcome the Marine did is an "-ing" phrase, not a clause glued on with a semicolon
  // ("; cut the review" is ", cutting the review"), unless an "-ing" phrase or a figure already ends the clause.
  // An outcome keeps its own clause when it has no object ("; completed ahead of schedule", "; resubmitted and accepted"),
  // a second verb (", corrected all") or a subject of its own ("processed vouchers increased", "and the CO ordered").
  const resultLeads = new Set(opts.sources.map((e) => bare(String(e.result || '').trim().split(/\s+/)[0] || '')).filter(Boolean));
  for (const m of text.matchAll(/; ([^;]+)/g)) {
    const before = text.slice(0, m.index);
    const said = m[1].replace(/\.$/, '').split(/\s+/);
    const lead = bare(said[0]);
    if (!resultLeads.has(lead)) continue;
    if (/^[a-z]{3,}ing$/.test(lead) && !NOT_PARTICIPLE.test(lead)) { say('join', `"; ${said[0]}" is an "-ing" phrase after a semicolon`); continue; }
    if (!pastLike(lead) || /, [a-z]+ing\b[^;]*$/.test(before) || /, supporting\b[^;]*$|in support of\b[^;]*$/.test(before) || /\d[KMBT%]?\)?$/.test(before)) continue;
    const object = said[1] && !NO_OBJECT_NEXT.test(bare(said[1])) && !/^(?:and|or|but)$/.test(bare(said[1])) && !/^(?:hours?|days?|weeks?|months?)$/.test(bare(said[2] || ''));
    const second = said.slice(2).some((w, j) => {
      const b = bare(w);
      const prior = said[j + 1];
      if (/^(?:was|were|is|are|had|has)$/.test(b)) return true;
      return (pastLike(b) || VERB_FORMS.get(b)?.form === 'third') && !DETERMINER.test(bare(prior)) && !/^\d/.test(prior);
    });
    if (object && !second) say('join', `"; ${said[0]}"`);
  }
  // After a semicolon the outcome goes on in lower case: "; the Marines found", not "; The Marines found".
  for (const m of text.matchAll(/; (The|A|An|This|That|It|They|He|She|All|Each|No|Zero|Both)\b/g)) say('join', `"; ${m[1]}" in capitals`);
  // A placeholder is no outcome: "; N/A", "; TBD".
  if (/; (?:N\/?A|TBD|TBC|none|pending|unknown|-+)\.?$/i.test(text)) say('join', 'a placeholder outcome');
  // The opening verb is not said again as the money word ("Obligated 22 MIPRs obligating $240,000").
  const opener = lemma(words[0] || '');
  if (opener) for (let i = 1; i < words.length; i += 1) {
    const w = bare(words[i]);
    if (/ing$/.test(w) && lemma(w) === opener && (/^\$/.test(words[i + 1] || '') || /,$/.test(words[i - 1]))) say('verb twice', `"${words[0]} ... ${words[i]}"`);
  }
  // Two "-ing" phrases in a row read as a list of afterthoughts: ", saving $18,250, supporting the close".
  for (const m of text.matchAll(/, ([a-z]+ing) (?:[^,;]|,(?=\d))+, ([a-z]+ing)\b/g)) if (!NOT_PARTICIPLE.test(m[1]) && !NOT_PARTICIPLE.test(m[2])) say('join', `"${m[1]} ..., ${m[2]}"`);
  // A purpose is a thing, not a clause: "in support of closed out the year" is a verb left over.
  for (const m of text.matchAll(/\b(?:in support of|, supporting) (\S+)(?: (\S+))?/g)) {
    if (pastLike(bare(m[1])) && (!m[2] || PREDICATE_NEXT.test(bare(m[2])))) say('join', `a verb after "support": "${m[1]}"`);
  }

  // 10. The figures are written the way they are read: "$1M", never "$1000K"; on FITREP, "$48.3K", never "$48,250".
  if (/\$\d{4,}(?:\.\d+)?[KMBT]\b/.test(text)) say('number form', 'a scaled figure of 1,000 or more');
  if (opts.track === 'fitrep') for (const f of out) if (f.money && f.value >= 1e4 && /^\$[\d,]+(?:\.\d+)?$/.test(f.text)) say('number form', `"${f.text}" in full on FITREP`);

  // 11. The count is where it reads: not in place of a word that guesses it ("30 several MIPRs", "22 20+ MIPRs"), not
  // inside a verb pair ("Reviewed and 22 approved"), a name ("Toys for 400 Tots") or before a gerund ("by 40 processing"),
  // not after a word that describes the noun ("Reviewed submitted 40 claims", "newly trained 4 Marines"), not before a
  // noun the unit describes ("85 records audit"), not taken by a verb that needs its preposition ("Accounted 300 items").
  // Words the Marine typed that way stand as typed; the rule is for where the writer puts the count.
  const typedAs = (part: string) => opts.sources.some((e) => [e.title, e.result].some((t) => typeof t === 'string' && t.toLowerCase().includes(part.toLowerCase())));
  const counted = (re: RegExp, what: string) => { const m = re.exec(text); if (m && !typedAs(m[0])) say('count placement', `${what}: "${m[0]}"`); };
  counted(/\b\d[\d,]*\+? (?:several|dozens?|hundreds|thousands|few|many|multiple|numerous|various|countless|couple|handful)\b|\b(?:several|multiple|numerous|various|many|hundreds of|dozens of|thousands of|a dozen|a few|a couple(?: of)?|a handful of) \d|\b\d[\d,]* \d[\d,]*\+/i, 'beside a word that guesses it');
  counted(/^\S+ (?:and|or) \d/, 'inside the opening verbs');
  counted(/\b[A-Z][a-z]+ (?:for|of|and) \d[\d,]* [A-Z][a-z]/, 'inside a name');
  counted(/\b(?:by|after|before|while|for) \d[\d,]* [a-z]+ing\b/, 'before a gerund');
  counted(/^\S+ [a-z]{3,}ed \d|\b[a-z]+ly [a-z]{3,}ed \d/, 'after a word that describes the noun');
  counted(/\b\d[\d,]* [a-z]*[^su\W]s (?:audit|class|course|inspection|review|brief|program|drive|board|session|inventory|maintenance|exercise|tracker|plan|report|check)\b/, 'before a noun the unit describes');
  counted(/^(?:Accounted|Cared|Spoke|Stood|Headed|Looked|Waited|Dealt|Applied|Asked|Participated|Stepped) \d/, 'as the object of a verb that needs its preposition');
  const opened = /^\S+ ([a-z]{3,}ed) (\S+)/.exec(text);
  if (opened && pastLike(opened[1]) && /^(?:for|to|on|in|at|with|by|from|the|a|an)$/.test(bare(opened[2]))) say('past-tense opener', `"${words[0]} ${opened[1]}" is two verbs`);
  // A unit said twice in one pair of parentheses: "(OMPFs; 85 OMPFs)".
  if (/\(([A-Za-z]+); \d[\d,]* \1\)/.test(text)) say('figure twice', 'the unit twice in one pair of parentheses');
  // A time or a grade is not a result: "resulting in 2 days early", "resulting in 285 PFT score".
  if (/\bresulting in \d[\d,.]* (?:hours?|days?|weeks?|months?) (?:early|ahead|late|behind)\b|\bresulting in (?:an? )?\d[\d,.]* (?:(?:PFT|CFT|rifle|pistol) )?(?:score|GPA|average)\b/i.test(text)) say('resulting in', 'before a time or a grade');

  // Plain text: what a form field takes, in the Marine's voice but not the first person, no stutter.
  if (/[^\x20-\x7E]/.test(text)) say('plain text', 'a character outside plain ASCII');
  if (FIRST_PERSON.test(text)) say('plain text', 'first person');
  const twice = doubled(text);
  if (twice) say('plain text', `"${twice}" twice in a row`);
  return bad;
}

/**
 * What is wrong with a narrative: every sentence by the rules above against the entries it came from, and the text by
 * its limit. A summary or a total may sum its entries; case work comes from case histories, not entries, so only its
 * form is checked. Each entry is said by one sentence only, and a summary counts only work its entries' own bullets
 * count the same way.
 */
export function checkNarrative(n: WrittenNarrative, entries: Array<EntryInput & { id: string }>, track: Track = 'jepes'): string[] {
  const bad: string[] = [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  for (const s of n.sentences) {
    const sources = s.sources.map((id) => byId.get(id)).filter((e): e is EntryInput & { id: string } => Boolean(e));
    const casework = s.kind === 'casework';
    const totals = s.kind === 'group' || s.kind === 'summary';
    const found = checkSentence(s.text, { sources: casework ? [{ title: s.text }] : sources, totals, limit: n.limit, track, skip: casework ? ['figure missing'] : [] });
    bad.push(...found.map((b) => `${s.kind} ${s.key}: ${b}`));
    if (s.kind === 'summary') {
      // "Checked 6 Marines" from "Checked on every section Marine (6 Marines)" says what the Marine did not.
      const own = sources.map((e) => bulletFor(e, track));
      for (const m of s.text.matchAll(/(?:^|, | and )([A-Za-z]+) [\d,]+ (?:more )?/g)) {
        if (!own.some((b) => new RegExp(`^${m[1]}(?: and [a-z]+)? [\\d,]+ `, 'i').test(b))) bad.push(`summary ${s.key}: "${m[1]} N" is not work its sources count that way`);
      }
      // Each entry it names is in one of its figures: its unit is counted, or its dollars are.
      for (const e of sources) {
        const unit = unitIdentity(String(e.unit_label || ''));
        const inCount = Boolean(num(e.quantity)) && figuresIn(s.text).some((f) => !f.money && unitNear(f, unit));
        const inDollars = Boolean(num(e.dollar_amount)) && figuresIn(s.text).some((f) => f.money);
        if (!inCount && !inDollars) bad.push(`summary ${s.key}: ${e.id} is a source no figure in it counts`);
      }
    }
  }
  if (n.text.length > n.limit) bad.push(`limit: the text is ${n.text.length} characters over ${n.limit}`);
  // What an entry gives is said once: an entry in two sentences (its own and a total) is a claim made twice.
  const owner = new Map<string, string>();
  for (const s of n.sentences) {
    if (s.kind === 'casework') continue;
    for (const id of s.sources) {
      const other = owner.get(id);
      if (other && other !== s.key) bad.push(`figure twice: ${id} is counted in ${other} and ${s.key}`);
      owner.set(id, s.key);
    }
  }
  return bad;
}
