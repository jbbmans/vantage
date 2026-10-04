import {
  ANNUAL_TRAINING, ATTRIBUTE_FOR_KIND, CLICHE, FILLER, FIRST_PERSON, IN_PROGRESS, KEEP_CASE, MEASURE_UNIT, NOMINAL_OPENERS, NOUN_FOLLOWERS, PASSIVE,
  PEOPLE_UNIT, PERSONAL_NOUNS, PRAISE_ADVERBS, PRIOR_AWARD, ACRONYMS, NUMBER_WORDS, RESULT_LEADS, RS_JUDGMENT, SPECULATIVE, STRONG_RESULT, SUPERLATIVE, VAGUE, VERB_BY_LEMMA, VERB_FORMS,
  WEAK_OPENERS, type VerbEntry,
} from './lexicon.ts';
import { isTimeUnit, unitKeyOf } from '../metricEngine.ts';
import { DEFAULT_METRICS, isSummable, type MetricsConfig } from '../constants.ts';

/** One logged entry, as the writer receives it. */
export interface EntryInput {
  id?: string; title?: string | null; category?: string | null; eval_area?: string | null; quantity?: number | string | null;
  unit_label?: string | null; dollar_amount?: number | string | null; dollar_type?: string | null; system?: string | null;
  organization?: string | null; result?: string | null; date?: string | null;
}

/** The broad areas evaluation writing sorts work into; a track names them (see AreaNames). */
export type AreaKind = 'mission' | 'leadership' | 'character' | 'intellect';
export type AreaNames = Record<AreaKind, string>;

export type QuantityKind = 'item' | 'time' | 'people' | 'measure';
export type IssueCode = 'outcome' | 'weak_verb' | 'vague' | 'passive' | 'no_verb' | 'unmeasured' | 'long' | 'first_person' | 'area_inferred'
  | 'annual_training' | 'superlative' | 'cliche' | 'speculative' | 'rs_judgment';

export interface Issue { code: IssueCode; message: string; advice?: string }

/** What one entry says, read and cleaned. Every field is something the entry stated; nothing is added. */
export interface Fact {
  key: string;
  sources: string[];
  area: string;
  areaKind: AreaKind;
  areaInferred: boolean;
  date: string | null;
  category: string | null;
  verb: VerbEntry | null;
  /** The opening verb as it will be written: "Reconciled". */
  opener: string;
  /** What follows the opener: "14 ULOs totaling $48,250 in DAI". */
  rest: string;
  /** What the work supported, when the title named only that ("FY26 year-end close"). */
  purpose: string | null;
  quantity: { n: number; unit: string; kind: QuantityKind } | null;
  money: { amount: number; type: string | null; summable: boolean } | null;
  people: number | null;
  result: string | null;
  system: string | null;
  organization: string | null;
  attribute: string;
  /** What reading changed, so the review can say so: "tense", "first person", "filler", "word order". */
  edits: string[];
  issues: Issue[];
  strongResult: boolean;
  /** Why the writer holds this entry back from the input, and what that rests on. The Marine can keep it anyway. */
  held: { reason: string; basis: 'order' | 'guidance' | 'style' | 'data'; cite?: string } | null;
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
const stripEnd = (s: string) => s.replace(/[\s.;,:]+$/, '');
const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const lowerFirst = (s: string) => (!s || KEEP_CASE.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** "marines" is always "Marines". */
const marines = (s: string) => s.replace(/\bmarine(s?)\b/g, 'Marine$1');

function dropFirstPerson(s: string): { text: string; changed: boolean } {
  // "my section's ULOs" is "the section's ULOs": the possessive points at the unit, which still owns the work. "My
  // associates degree" is the Marine's own, and reads as "associates degree".
  let out = s.replace(/^(?:I|We)\s+/, '').replace(/\b(?:my|our|My|Our)\s+(?=(\S+(?:\s+\S+)?))/g, (_m, next: string) => (PERSONAL_NOUNS.test(next) ? '' : 'the ')).replace(/\s+myself\b/gi, '');
  out = out.replace(/^the\s/, 'The ');
  return { text: out, changed: out !== s };
}

function dropFiller(s: string): { text: string; changed: boolean } {
  let out = s.replace(PRAISE_ADVERBS, '');
  for (const [re, to] of FILLER) out = out.replace(re, to);
  out = clean(out);
  return { text: out, changed: out !== clean(s) };
}

const UNTITLED_VERB: Record<string, string> = { reconciled: 'Reconciled', obligated: 'Obligated', saved: 'Recovered', reviewed: 'Reviewed', impact: 'Processed' };

/** A first person the cleanup could not take out ("the squad leader said I was…"). "Phase I" and "Level I" are not. */
const firstPersonLeft = (text: string) => /\b(?:me|my|mine|we|our|us|myself)\b/.test(text)
  || /(?<!\b(?:Phase|Level|Tier|Part|Class|Stage|Block|Annex|Appendix|Volume|Book|Chapter|Echelon|Type|Mod|Course|Section|Spiral|Title)\s)\bI\b(?!-)/.test(text);

/**
 * Text as a Marine typed it, made fit to read: shouting capitals set in sentence case (acronyms kept), a second
 * sentence joined to the first, exclamation marks and symbols gone, small number words as numerals. Nothing it says
 * is changed.
 */
export function tidy(text: string, opts: { numerals?: boolean } = {}): { text: string; changed: boolean } {
  let out = text.replace(/\p{Extended_Pictographic}|\uFE0F/gu, '').replace(/!+/g, '').replace(/\s+/g, ' ').trim();
  const letters = out.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 8 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.8 && out.split(' ').length >= 2) {
    out = out.split(' ').map((w, i) => {
      const bare = w.replace(/[^A-Za-z0-9-]/g, '');
      const plural = /S$/.test(bare) && ACRONYMS.has(bare.slice(0, -1));
      if (ACRONYMS.has(bare) || /\d/.test(bare)) return w;
      if (plural) return w.replace(bare, `${bare.slice(0, -1)}s`);
      const low = w.toLowerCase();
      return i === 0 ? low.charAt(0).toUpperCase() + low.slice(1) : low;
    }).join(' ');
  }
  // "Built the tracker. Also trained the section on it." is one accomplishment told twice; it reads as one sentence.
  out = out.replace(/([a-z0-9)])\.\s+(?=[A-Z][a-z])/g, (_m, c: string) => `${c}; `).replace(/;\s+([A-Z][a-z])/g, (_m, w: string) => `; ${w.toLowerCase()}`);
  if (opts.numerals) out = out.replace(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b(?=\s+[A-Za-z])/gi, (w) => String(NUMBER_WORDS[w.toLowerCase()]));
  return { text: out, changed: out !== text.replace(/\s+/g, ' ').trim() };
}

/** An outcome that only restates the title ("Hazmat certification; certified") says nothing more. */
function restates(result: string, title: string): boolean {
  const words = result.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 2) return false;
  const stems = new Set(title.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5).map((w) => w.slice(0, 5)));
  return words.every((w) => w.length >= 5 && stems.has(w.slice(0, 5)));
}

const PEOPLE_IN_TEXT = /\b(\d[\d,]*)\s+((?:junior\s+)?(?:Marines?|personnel|students?|subordinates?|NCOs|SNCOs|sailors?|soldiers?|recruits?|trainees?|mentees?|members?|lance corporals?|privates?))\b/i;
const NUMBER = /\d/;

export function quantityKind(unit: string): QuantityKind {
  const u = unit.trim();
  if (PEOPLE_UNIT.test(u)) return 'people';
  if (isTimeUnit(u)) return 'time';
  if (MEASURE_UNIT.test(u)) return 'measure';
  return 'item';
}

const OBJECT_START = /^(?:\d|[A-Z]|(?:the|a|an|all|every|each|this|these|those|their|his|her|its|two|three|four|five|six|seven|eight|nine|ten|over|more|new)\b)/;

/** "14 ULOs reconciled in DAI" opens with a count; its verb comes after. */
const COUNT_FIRST = /^(\d[\d,.]*\s+(?:[A-Za-z][\w/-]*\s+){0,2}?)([a-z]+ed)\b\s*(.*)$/i;

interface Opening { verb: VerbEntry | null; opener: string; rest: string; edit: string | null }

function openingOf(text: string, category: string | null): Opening {
  const words = text.split(' ');
  const first = (words[0] || '').replace(/[^A-Za-z-]/g, '');
  const lower = first.toLowerCase();
  const next = (words[1] || '').toLowerCase().replace(/[^a-z']/g, '');
  const rest = words.slice(1).join(' ');
  const hit = VERB_FORMS.get(lower);

  if (hit && hit.form === 'past') return { verb: hit.entry, opener: capitalize(hit.entry.past), rest, edit: null };
  // A past tense the lexicon does not list ("Licensed 8 Marines", "Turned in 35 items") is still the verb, when
  // something follows it.
  if (!hit && /^[a-z]{3,}ed$/i.test(first) && words.length > 1 && !NOUN_FOLLOWERS.has(next)) {
    return { verb: { lemma: lower.replace(/ed$/, ''), past: lower, kind: 'execute', strength: 2 }, opener: capitalize(lower), rest, edit: null };
  }
  // "Reconciling 14 ULOs" and "Reconciles ULOs" are verbs; "Process improvement for DTS" is a noun phrase. A bare
  // form only becomes the past tense when an object plainly follows it: a number, a name, "the", "all".
  const objectFollows = OBJECT_START.test(words[1] || '');
  const asVerb = hit && (hit.form === 'third' || (hit.form === 'gerund' && !NOUN_FOLLOWERS.has(next)) || (hit.form === 'base' && objectFollows));
  if (hit && asVerb) return { verb: hit.entry, opener: capitalize(hit.entry.past), rest, edit: 'tense' };
  if (lower in NOMINAL_OPENERS) {
    const verb = NOMINAL_OPENERS[lower];
    return { verb: VERB_FORMS.get(verb.toLowerCase())?.entry ?? null, opener: verb, rest: lowerFirst(text), edit: 'opener' };
  }
  const counted = COUNT_FIRST.exec(text);
  if (counted) {
    const participle = VERB_FORMS.get(counted[2].toLowerCase());
    if (participle?.form === 'past') {
      return { verb: participle.entry, opener: capitalize(participle.entry.past), rest: clean(`${counted[1]}${counted[3]}`), edit: 'word order' };
    }
  }
  // "Was responsible for…", "Assisted…": already a statement, weak or not. Kept as written; the review asks for more.
  if (/^(?:was|were|served|acted)\b/i.test(text) || WEAK_OPENERS.some((w) => w.pattern.test(text))) {
    return { verb: hit?.entry ?? null, opener: '', rest: capitalize(text), edit: null };
  }
  // No verb to start with. Adding one would make a claim the Marine did not ("Completed…" something not finished),
  // so the words stay as written and the review asks for the verb.
  void category;
  return { verb: null, opener: '', rest: capitalize(text), edit: 'no verb' };
}

function inferArea(fact: Pick<Fact, 'verb' | 'people' | 'category' | 'quantity'>): AreaKind {
  if (fact.category === 'Leadership') return 'leadership';
  if (fact.category === 'Volunteer Service') return 'character';
  if (fact.category === 'Training & PME') return 'intellect';
  const kind = fact.verb?.kind;
  if (kind) {
    const area = ATTRIBUTE_FOR_KIND[kind].area;
    if (area === 'leadership' || area === 'character' || area === 'intellect') return area;
  }
  if (fact.people && fact.people > 0) return 'leadership';
  return 'mission';
}

/** Which broad area a named area is, whatever the track calls it. */
export function areaKindOf(name: string | null | undefined, names: AreaNames): AreaKind | null {
  if (!name) return null;
  for (const kind of Object.keys(names) as AreaKind[]) if (names[kind] === name) return kind;
  if (/mission|mos/i.test(name)) return 'mission';
  if (/leader/i.test(name)) return 'leadership';
  if (/character/i.test(name)) return 'character';
  if (/intellect|wisdom/i.test(name)) return 'intellect';
  return null;
}

/**
 * Reads one entry: cleans the title (tense, first person, filler), finds the verb and what it says, sorts the numbers
 * by what they measure, and notes what a reviewer would ask for. An entry with no area gets the one its own words
 * point to, and says so.
 */
export function readEntry(entry: EntryInput, opts: { names: AreaNames; areas: readonly string[]; metrics?: MetricsConfig }): Fact {
  const metrics = opts.metrics ?? DEFAULT_METRICS;
  const edits: string[] = [];
  const issues: Issue[] = [];
  const typed = tidy(stripEnd(clean(String(entry.title ?? ''))), { numerals: true });
  let title = stripEnd(typed.text);
  if (typed.changed) edits.push('typing');

  const person = dropFirstPerson(title);
  if (person.changed) { edits.push('first person'); title = person.text; }
  const weak = WEAK_OPENERS.find((w) => w.pattern.test(title)) || null;
  const filler = dropFiller(title);
  if (filler.changed) { edits.push('filler'); title = filler.text; }
  title = marines(title);
  if (!title) {
    // No title (an import can leave one out): the money's kind or the category gives the verb, the count the object.
    const verb = UNTITLED_VERB[String(entry.dollar_type)] || (entry.category === 'Leadership' ? 'Led' : 'Completed');
    const n = Number(entry.quantity);
    title = Number.isFinite(n) && n > 0 ? `${verb} ${n} ${String(entry.unit_label || 'items').trim() || 'items'}` : `${verb} logged work`;
    issues.push({ code: 'no_verb', message: 'No title', advice: 'Say what you did in a few words, starting with the verb.' });
  }

  const category = entry.category ?? null;
  const opening = openingOf(title, category);
  if (opening.edit === 'tense' || opening.edit === 'word order') edits.push(opening.edit);

  const qty = entry.quantity == null || entry.quantity === '' ? NaN : Number(entry.quantity);
  const unit = tidy(String(entry.unit_label || '').trim()).text.replace(/^([A-Z]{2,})S$/, (_m, a: string) => (ACRONYMS.has(a) ? `${a}s` : `${a}S`));
  let quantity: Fact['quantity'] = Number.isFinite(qty) && qty > 0 ? { n: qty, unit: unit || 'items', kind: quantityKind(unit || 'items') } : null;
  let people = quantity?.kind === 'people' ? quantity.n : null;
  if (!people) {
    const seen = PEOPLE_IN_TEXT.exec(title);
    if (seen) people = Number(seen[1].replace(/,/g, ''));
  }
  if (quantity?.kind === 'people') quantity = { ...quantity, unit: marines(quantity.unit) };

  const amount = entry.dollar_amount == null || entry.dollar_amount === '' ? NaN : Number(entry.dollar_amount);
  const money = Number.isFinite(amount) && amount !== 0 ? { amount, type: entry.dollar_type || null, summable: isSummable(entry.dollar_type, metrics) } : null;

  let result = entry.result ? stripEnd(tidy(clean(String(entry.result))).text) : '';
  if (result) {
    const r = dropFirstPerson(result.replace(RESULT_LEADS, ''));
    const f = dropFiller(r.text);
    result = marines(lowerFirst(f.text));
  }

  if (result && restates(result, title)) { result = ''; edits.push('repeated outcome'); }
  // A title with no verb ("FY26 year-end close") and a count or sum the Marine classified ("reconciled") is that
  // work: "Reconciled 30 ULOs … in support of FY26 year-end close". The verb is the Marine's own classification.
  let purpose: string | null = null;
  const typeVerb = entry.dollar_type && entry.dollar_type !== 'impact' && money ? VERB_FORMS.get(String(metrics.value_types.find((t) => t.key === entry.dollar_type)?.verb || entry.dollar_type).toLowerCase()) : undefined;
  if (opening.edit === 'no verb' && typeVerb?.form === 'past' && (quantity || money)) {
    purpose = lowerFirst(title);
    opening.verb = typeVerb.entry;
    opening.opener = capitalize(typeVerb.entry.past);
    opening.rest = quantity && quantity.kind !== 'measure' ? `${quantity.n} ${quantity.unit}` : '';
    opening.edit = 'from value type';
    edits.push('verb from value type');
  }
  const base = { verb: opening.verb, people, category, quantity };
  const given = opts.areas.includes(String(entry.eval_area)) ? String(entry.eval_area) : null;
  const givenKind = areaKindOf(given, opts.names);
  const areaKind = givenKind ?? inferArea(base);
  const area = given ?? opts.names[areaKind];

  const kind = opening.verb?.kind ?? 'execute';
  const attribute = ATTRIBUTE_FOR_KIND[kind].fitrep;
  const strongResult = Boolean(result && STRONG_RESULT.test(result));

  // What the review should say about this entry.
  if (!result) issues.push({ code: 'outcome', message: 'No outcome', advice: 'Add what came of it: a number that changed, a deadline met, a problem that did not come back.' });
  if (weak) issues.push({ code: 'weak_verb', message: `Opens with ${weak.label}`, advice: weak.advice });
  if (opening.edit === 'no verb' && !purpose) issues.push({ code: 'no_verb', message: 'Does not start with what you did', advice: 'Open with a past-tense verb: reconciled, trained, briefed, built.' });
  const said = `${title} ${result}`;
  if (VAGUE.test(said) && !NUMBER.test(said) && !quantity && !money) issues.push({ code: 'vague', message: `Says “${VAGUE.exec(said)![1]}” instead of a number`, advice: 'Count it. “14 ULOs” is a fact; “several ULOs” is a guess.' });
  if (PASSIVE.test(title)) issues.push({ code: 'passive', message: 'Passive voice', advice: 'Put yourself first: “Reconciled the ledger”, not “The ledger was reconciled”.' });
  if (!quantity && !money && !NUMBER.test(said)) issues.push({ code: 'unmeasured', message: 'No number', advice: 'How many, how much, how fast? One number makes it credible.' });
  if (title.length > 180) issues.push({ code: 'long', message: 'Long title', advice: 'Keep the title to the action; put detail in the result or notes.' });
  if (edits.includes('first person') || FIRST_PERSON.test(String(entry.result || ''))) issues.push({ code: 'first_person', message: 'First person removed', advice: 'Evaluation writing leaves out “I” and “my”; the writer did it for you.' });
  if (!givenKind) issues.push({ code: 'area_inferred', message: `No area; placed under ${area} by what it says`, advice: 'Tag it yourself so it lands where you mean it to.' });
  const raw = `${entry.title ?? ''} ${entry.result ?? ''}`;
  const annual = ANNUAL_TRAINING.exec(raw);
  if (annual) issues.push({ code: 'annual_training', message: `Required annual training (“${annual[0]}”)`, advice: 'MCO 1616.1 Appendix E: performing required annual training is not a billet accomplishment. Held back from the input.' });
  const superlative = SUPERLATIVE.exec(raw);
  if (superlative) issues.push({ code: 'superlative', message: `“${superlative[1]}” rates the work instead of stating it`, advice: 'State the result and let the number carry it. FITREP Section C is to be void of superlatives.' });
  const cliche = CLICHE.exec(raw);
  if (cliche) issues.push({ code: 'cliche', message: `“${cliche[1]}” is a phrase readers skip`, advice: 'Replace it with the specific thing you did.' });
  if (result && SPECULATIVE.test(result)) issues.push({ code: 'speculative', message: 'The outcome is a prediction', advice: 'State what happened, not what may: Section C lists results, not potential impact.' });
  const judgment = RS_JUDGMENT.exec(raw);
  if (judgment) issues.push({ code: 'rs_judgment', message: `“${judgment[0]}” is your reporting senior’s call`, advice: 'Input states what you did; rankings and recommendations are written by your reporting chain.' });

  return {
    key: entry.id || `entry:${title.toLowerCase().slice(0, 40)}`,
    sources: entry.id ? [entry.id] : [],
    area, areaKind, areaInferred: !givenKind, date: entry.date ?? null, category,
    verb: opening.verb, opener: opening.opener, rest: clean(opening.rest), purpose,
    quantity, money, people: people || null, result: result || null,
    system: entry.system ? clean(String(entry.system)) : null,
    organization: entry.organization ? clean(String(entry.organization)) : null,
    attribute, edits, issues, strongResult,
    held: PRIOR_AWARD.test(raw) ? { reason: 'An award for actions in a previous reporting period is not a billet accomplishment (MCO 1616.1, Appendix E).', basis: 'order', cite: 'MCO 1616.1, App. E' }
      : annual ? { reason: 'Required annual training is not a billet accomplishment (MCO 1616.1, Appendix E).', basis: 'order', cite: 'MCO 1616.1, App. E' }
      : IN_PROGRESS.test(clean(String(entry.title ?? ''))) ? { reason: 'Still in progress: log it as an accomplishment when it is done.', basis: 'style' }
      : judgment ? { reason: 'Rankings and recommendations are your reporting chain’s to write; input states what you did.', basis: 'guidance', cite: 'MCO 1610.7B' }
      : firstPersonLeft(`${title} ${result}`) ? { reason: 'Still says “I” or “me” where the writer could not take it out; reword the entry without the first person.', basis: 'guidance', cite: 'MCO 1616.1, App. E' }
      : null,
  };
}

/** The clause as read: "Reconciled 14 ULOs totaling $48,250 in DAI". */
export const clauseOf = (f: Pick<Fact, 'opener' | 'rest'>) => clean(`${f.opener} ${f.rest}`);

/** A unit's identity for grouping: "ULOs" and "ulo" are one unit. */
export const unitIdentity = (unit: string) => unitKeyOf(unit);

export { VERB_BY_LEMMA };
