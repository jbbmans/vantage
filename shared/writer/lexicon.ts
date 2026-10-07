/**
 * What the writer knows about words: the verbs evaluation writing runs on and what each says about the work, the
 * phrases that pad a sentence without adding a fact, and the units that measure effort rather than count things done.
 * Everything here is used to read an entry or to rewrite it without changing what it claims; a word that would change
 * the claim ("helped" into "led") is only ever suggested, never substituted.
 */

/** What a verb says the Marine did. Each kind leans toward an area (AREA_FOR_KIND) and a FITREP attribute (attributes.ts). */
export type VerbKind =
  | 'execute' | 'finance' | 'fix' | 'analyze' | 'build' | 'improve' | 'plan' | 'lead' | 'develop' | 'care'
  | 'communicate' | 'qualify' | 'learn' | 'serve' | 'support' | 'maintain' | 'admin';

export interface VerbEntry {
  lemma: string;
  past: string;
  kind: VerbKind;
  /** 3 names a result the Marine owned; 2 is plain; 1 hides who did the work ("helped", "assisted"). */
  strength: 1 | 2 | 3;
}

// lemma, past (blank when regular), kind, strength
const VERBS: Array<[string, string, VerbKind, 1 | 2 | 3]> = [
  // Getting the work done.
  ['execute', '', 'execute', 3], ['complete', '', 'execute', 2], ['process', '', 'execute', 2], ['clear', '', 'execute', 3],
  ['close', '', 'execute', 3], ['deliver', '', 'execute', 3], ['accomplish', '', 'execute', 3], ['achieve', '', 'execute', 3],
  ['submit', 'submitted', 'execute', 2], ['finish', '', 'execute', 2], ['conduct', '', 'execute', 2], ['perform', '', 'execute', 2],
  ['run', 'ran', 'execute', 2], ['operate', '', 'execute', 2], ['handle', '', 'execute', 1], ['issue', '', 'execute', 2],
  ['ship', 'shipped', 'execute', 2], ['receive', '', 'execute', 2], ['inventory', 'inventoried', 'execute', 2], ['inspect', '', 'execute', 2],
  ['account', '', 'execute', 2], ['check', '', 'execute', 2], ['dispatch', '', 'execute', 2], ['coordinate', '', 'plan', 2], ['schedule', '', 'plan', 2],
  // Money.
  ['reconcile', '', 'finance', 3], ['obligate', '', 'finance', 3], ['deobligate', '', 'finance', 3], ['commit', 'committed', 'finance', 2],
  ['disburse', '', 'finance', 3], ['certify', 'certified', 'finance', 3], ['validate', '', 'finance', 3], ['audit', '', 'finance', 3],
  ['recover', '', 'finance', 3], ['save', '', 'finance', 3], ['budget', '', 'finance', 2], ['fund', '', 'finance', 2],
  ['liquidate', '', 'finance', 3], ['match', '', 'finance', 2], ['post', '', 'finance', 2], ['reprogram', 'reprogrammed', 'finance', 3],
  ['allocate', '', 'finance', 2], ['track', '', 'admin', 2], ['verify', 'verified', 'finance', 3],
  // Finding and fixing.
  ['resolve', '', 'fix', 3], ['correct', '', 'fix', 3], ['fix', '', 'fix', 3], ['repair', '', 'fix', 3], ['restore', '', 'fix', 3],
  ['recoup', '', 'fix', 3], ['eliminate', '', 'fix', 3], ['prevent', '', 'fix', 3], ['troubleshoot', 'troubleshot', 'fix', 3],
  ['identify', 'identified', 'analyze', 3], ['research', '', 'analyze', 2], ['analyze', '', 'analyze', 3], ['assess', '', 'analyze', 3],
  ['review', '', 'analyze', 2], ['investigate', '', 'analyze', 3], ['diagnose', '', 'analyze', 3], ['evaluate', '', 'analyze', 3],
  ['examine', '', 'analyze', 2], ['determine', '', 'analyze', 3], ['forecast', 'forecast', 'analyze', 3], ['recommend', '', 'analyze', 3],
  ['decide', '', 'analyze', 3],
  // Making and improving.
  ['build', 'built', 'build', 3], ['create', '', 'build', 3], ['design', '', 'build', 3], ['develop', '', 'build', 3],
  ['establish', '', 'build', 3], ['implement', '', 'build', 3], ['launch', '', 'build', 3], ['stand', 'stood', 'build', 2],
  ['automate', '', 'improve', 3], ['streamline', '', 'improve', 3], ['improve', '', 'improve', 3], ['reduce', '', 'improve', 3],
  ['cut', 'cut', 'improve', 3], ['increase', '', 'improve', 3], ['standardize', '', 'improve', 3], ['revamp', 'revamped', 'improve', 3],
  ['modernize', '', 'improve', 3], ['overhaul', '', 'improve', 3], ['simplify', 'simplified', 'improve', 3], ['accelerate', '', 'improve', 3],
  ['update', '', 'improve', 2], ['revise', '', 'improve', 2], ['initiate', '', 'improve', 3], ['pioneer', '', 'improve', 3],
  ['plan', 'planned', 'plan', 3], ['organize', '', 'plan', 2], ['prepare', '', 'plan', 2], ['arrange', '', 'plan', 2],
  // People.
  ['lead', 'led', 'lead', 3], ['supervise', '', 'lead', 3], ['direct', '', 'lead', 3], ['command', '', 'lead', 3],
  ['manage', '', 'lead', 2], ['oversee', 'oversaw', 'lead', 3], ['head', '', 'lead', 3], ['spearhead', '', 'lead', 3],
  ['train', '', 'develop', 3], ['mentor', '', 'develop', 3], ['coach', '', 'develop', 3], ['teach', 'taught', 'develop', 3],
  ['instruct', '', 'develop', 3], ['qualify', 'qualified', 'qualify', 3], ['onboard', '', 'develop', 2],
  ['counsel', 'counseled', 'care', 3], ['advocate', '', 'care', 3], ['sponsor', '', 'care', 3], ['welcome', '', 'care', 2],
  ['care', '', 'care', 2], ['assist', '', 'support', 1], ['help', '', 'support', 1], ['support', '', 'support', 2],
  ['aid', '', 'support', 1], ['participate', '', 'support', 1], ['contribute', '', 'support', 2], ['augment', '', 'support', 2],
  ['volunteer', '', 'serve', 3], ['serve', '', 'serve', 2], ['raise', '', 'serve', 3], ['donate', '', 'serve', 2],
  // Talking and writing.
  ['brief', '', 'communicate', 3], ['present', '', 'communicate', 3], ['write', 'wrote', 'communicate', 3], ['draft', '', 'communicate', 3],
  ['author', '', 'communicate', 3], ['edit', '', 'communicate', 2], ['publish', '', 'communicate', 3], ['report', '', 'communicate', 2],
  ['document', '', 'communicate', 2], ['notify', 'notified', 'communicate', 2], ['explain', '', 'communicate', 2], ['translate', '', 'communicate', 2],
  ['negotiate', '', 'communicate', 3], ['liaise', '', 'communicate', 2], ['represent', '', 'communicate', 2],
  // Earning and learning.
  ['earn', '', 'qualify', 3], ['attain', '', 'qualify', 3], ['pass', '', 'qualify', 2], ['score', '', 'qualify', 3],
  ['graduate', '', 'learn', 3], ['study', 'studied', 'learn', 2], ['learn', '', 'learn', 2], ['attend', '', 'learn', 1],
  ['enroll', 'enrolled', 'learn', 2], ['shoot', 'shot', 'qualify', 2], ['hike', '', 'execute', 2],
  // Keeping things running.
  ['maintain', '', 'maintain', 2], ['monitor', '', 'maintain', 2], ['sustain', '', 'maintain', 2],
  ['secure', '', 'maintain', 2], ['protect', '', 'maintain', 2], ['safeguard', '', 'maintain', 2], ['prioritize', '', 'plan', 2],
  ['file', '', 'admin', 2], ['record', '', 'admin', 2], ['log', 'logged', 'admin', 1], ['enter', '', 'admin', 1], ['input', 'input', 'admin', 1],
  ['compile', '', 'admin', 2], ['consolidate', '', 'admin', 2], ['route', '', 'admin', 2], ['work', '', 'support', 1],
  ['attempt', '', 'support', 1], ['try', 'tried', 'support', 1],
  // Irregular pasts a Marine is likely to type, so "Drove in the convoy" reads as the verb it is.
  ['drive', 'drove', 'execute', 2], ['ride', 'rode', 'execute', 2], ['fly', 'flew', 'execute', 2], ['go', 'went', 'execute', 1],
  ['give', 'gave', 'communicate', 2], ['take', 'took', 'execute', 2], ['make', 'made', 'build', 2], ['keep', 'kept', 'maintain', 2],
  ['hold', 'held', 'maintain', 2], ['sell', 'sold', 'execute', 2], ['buy', 'bought', 'finance', 2], ['bring', 'brought', 'execute', 2],
  ['send', 'sent', 'execute', 2], ['spend', 'spent', 'execute', 1], ['win', 'won', 'qualify', 3], ['meet', 'met', 'execute', 2],
  ['set', 'set', 'execute', 2], ['put', 'put', 'execute', 1], ['find', 'found', 'analyze', 3], ['pay', 'paid', 'finance', 2],
  ['speak', 'spoke', 'communicate', 2], ['tell', 'told', 'communicate', 1], ['get', 'got', 'execute', 1], ['begin', 'began', 'execute', 1],
  ['become', 'became', 'qualify', 2], ['choose', 'chose', 'analyze', 2], ['swim', 'swam', 'qualify', 2], ['lead', 'led', 'lead', 3],
  ['license', '', 'develop', 3], ['turn', '', 'execute', 2], ['load', '', 'execute', 2], ['unload', '', 'execute', 2], ['dispatch', '', 'execute', 2],
  ['guard', '', 'maintain', 2], ['patrol', 'patrolled', 'execute', 2], ['navigate', '', 'execute', 2], ['fire', '', 'execute', 2],
];

/** The regular past of a verb: "reconcile" → "reconciled", "verify" → "verified", "process" → "processed". */
export function regularPast(lemma: string): string {
  if (lemma.endsWith('e')) return `${lemma}d`;
  if (/[^aeiou]y$/.test(lemma)) return `${lemma.slice(0, -1)}ied`;
  return `${lemma}ed`;
}

function gerund(lemma: string, past: string): string {
  if (lemma.endsWith('ie')) return `${lemma.slice(0, -2)}ying`;
  if (lemma.endsWith('ee')) return `${lemma}ing`;
  if (lemma.endsWith('e')) return `${lemma.slice(0, -1)}ing`;
  // A doubled consonant in the past doubles in the gerund too: "planned" / "planning", "submitted" / "submitting".
  const last = lemma.at(-1)!;
  if (past === `${lemma}${last}ed`) return `${lemma}${last}ing`;
  return `${lemma}ing`;
}

const third = (lemma: string) => (/(s|sh|ch|x|z|o)$/.test(lemma) ? `${lemma}es` : /[^aeiou]y$/.test(lemma) ? `${lemma.slice(0, -1)}ies` : `${lemma}s`);

/** Every form of every verb, keyed by the form: "reconciling", "reconciles", "reconcile" and "reconciled" all find reconcile. */
export const VERB_FORMS = new Map<string, { entry: VerbEntry; form: 'past' | 'base' | 'third' | 'gerund' }>();
export const VERB_BY_LEMMA = new Map<string, VerbEntry>();
for (const [lemma, irregular, kind, strength] of VERBS) {
  if (VERB_BY_LEMMA.has(lemma)) continue;
  const past = irregular || regularPast(lemma);
  const entry: VerbEntry = { lemma, past, kind, strength };
  VERB_BY_LEMMA.set(lemma, entry);
  const forms: Array<[string, 'past' | 'base' | 'third' | 'gerund']> = [[past, 'past'], [lemma, 'base'], [third(lemma), 'third'], [gerund(lemma, past), 'gerund']];
  for (const [form, kindOf] of forms) if (!VERB_FORMS.has(form)) VERB_FORMS.set(form, { entry, form: kindOf });
}

/**
 * Words that open a title as a noun, not a verb: "Brief to the CO", "Review of FY26 obligations". The verb a plain
 * statement of that work takes, so the sentence still starts with what was done.
 */
export const NOMINAL_OPENERS: Record<string, string> = {
  brief: 'Delivered', briefing: 'Delivered', presentation: 'Delivered', class: 'Taught', lecture: 'Delivered',
  review: 'Conducted', audit: 'Conducted', inspection: 'Conducted', inventory: 'Conducted', analysis: 'Completed', assessment: 'Completed',
  training: 'Conducted', report: 'Prepared', plan: 'Prepared', study: 'Completed', survey: 'Conducted', drill: 'Conducted',
};

/** A noun-phrase opener: the first word reads as a noun when a preposition or "and" follows it. */
export const NOUN_FOLLOWERS = new Set(['of', 'for', 'on', 'to', 'with', 'at', 'from', 'about', 'regarding', 'and', 'session', 'sessions', 'brief', 'report', 'plan', 'class', 'course']);

/** Openers that hide who did the work. The suggestion names the stronger statement, which only the Marine can make. */
export const WEAK_OPENERS: Array<{ pattern: RegExp; label: string; advice: string }> = [
  { pattern: /^(?:was\s+)?responsible\s+for\b/i, label: '“Responsible for”', advice: 'Say what you did with it: “Processed 40 MIPRs”, not “Responsible for MIPRs”.' },
  { pattern: /^helped(?:\s+to)?\b/i, label: '“Helped”', advice: 'Name your share: “Reconciled 14 of the 30 ULOs”, not “Helped reconcile ULOs”.' },
  { pattern: /^assisted(?:\s+(?:with|in))?\b/i, label: '“Assisted”', advice: 'Say what you did yourself, and how much of it.' },
  { pattern: /^participated\s+in\b/i, label: '“Participated in”', advice: 'Say what your part was and what came of it.' },
  { pattern: /^worked\s+(?:on|with)\b/i, label: '“Worked on”', advice: 'Start with what you finished, not what you worked on.' },
  { pattern: /^(?:was\s+)?involved\s+in\b/i, label: '“Involved in”', advice: 'Say what you did, not that you were there.' },
  { pattern: /^(?:was\s+)?tasked\s+with\b/i, label: '“Tasked with”', advice: 'Being tasked is not the result. Say what you delivered.' },
  { pattern: /^(?:attempted|tried)\s+to\b/i, label: '“Tried to”', advice: 'Record what was done, or what you learned and changed.' },
  { pattern: /^handled\b/i, label: '“Handled”', advice: 'A precise verb reads stronger: processed, resolved, cleared, reconciled.' },
];

/** Words that pad without adding a fact. Removing them never changes a claim. */
export const FILLER: Array<[RegExp, string]> = [
  [/\b(?:successfully|effectively|efficiently|basically|actually|really|truly|very)\s+/gi, ''],
  [/\bin order to\b/gi, 'to'],
  [/\ba total of\s+/gi, ''],
  [/\bwas able to\s+/gi, ''],
  [/\bfor the purpose of\b/gi, 'to'],
  [/\bon a (daily|weekly|monthly|quarterly) basis\b/gi, '$1'],
  [/\bprior to\b/gi, 'before'],
  [/\bin excess of\b/gi, 'over'],
  [/\bwith regard to\b/gi, 'on'],
  [/\bas well as\b/gi, 'and'],
  [/\butilized\b/gi, 'used'],
  [/\butilizing\b/gi, 'using'],
];

/** Words that stand in for a number. Flagged, never rewritten: only the Marine knows the count. */
export const VAGUE = /\b(several|many|numerous|various|multiple|countless|a lot of|lots of|a number of|a few|some)\b/i;

/** "was completed", "were reconciled by": the doer is missing. */
export const PASSIVE = /\b(?:was|were|been|being|is|are)\s+(?!able\b)[a-z]+(?:ed|en|wn|ung|ought)\b/i;

/** First person, which evaluation writing leaves out. */
export const FIRST_PERSON = /\b(?:I|me|my|mine|we|our|us|myself)\b/;

/** People a Marine leads, trains or looks after. A count of them is a leadership measure, not a quantity of work. */
export const PEOPLE_UNIT = /^(?:marines?|personnel|students?|members?|subordinates?|juniors?|junior marines?|nco'?s|ncos|snco'?s|sncos|sailors?|soldiers?|airmen|people|persons|staff|recruits?|candidates?|trainees?|mentees?|lance corporals?|privates?|corporals?)$/i;

/** Distance, points and percentages measure an effort; "processed 10 km" says nothing. */
export const MEASURE_UNIT = /^(?:km|kms|kilomet(?:er|re)s?|mi|miles?|met(?:er|re)s?|yards?|yds?|points?|pts|%.*|percent)$/i;

/** Words in a result that mark a measured or decisive outcome: a number, a percentage, a zero, a first. */
export const STRONG_RESULT = /(\d|%|\bzero\b|\bno (?:errors|discrepancies|findings|defects|returns|rejects)\b|\b(?:first|only|record|fastest|ahead of|under budget|on time|before the deadline|100)\b)/i;

/** The broad area each kind of work belongs to on the JEPES lines. FITREP attributes are read in attributes.ts. */
export const AREA_FOR_KIND: Record<VerbKind, 'mission' | 'leadership' | 'character' | 'intellect'> = {
  execute: 'mission', finance: 'mission', fix: 'mission', maintain: 'mission', admin: 'mission', analyze: 'mission',
  build: 'mission', improve: 'mission', plan: 'mission', qualify: 'mission', lead: 'leadership', develop: 'leadership',
  care: 'leadership', communicate: 'leadership', learn: 'intellect', serve: 'character', support: 'mission',
};

/** Lowercase words kept as written at the start of a clause: acronyms and proper nouns are handled by case already. */
export const KEEP_CASE = /^(?:[A-Z0-9&/-]{2,}s?\b|Marines?\b|I\b|[A-Z][a-z]+\s+[A-Z])/;

/** Connectors that open a result clause; the writer supplies its own, so a typed one is dropped. */
export const RESULT_LEADS = /^(?:resulting in|which resulted in|leading to|which|so that|so|this|that|and)\s+/i;

/**
 * Required annual training, which MCO 1616.1 Appendix E says is not a billet accomplishment. Held back from the input,
 * with the reason shown, rather than dropped silently.
 */
export const ANNUAL_TRAINING = /\b(?:(?:annual|required|mandatory|annually required)\s+(?:\w+\s+){0,2}training|cyber ?awareness|SAPR|sexual assault prevention|suicide prevention|equal opportunity training|EO training|OPSEC training|anti-?terrorism(?: level| awareness)?|AT level (?:1|I)\b|PII training|ethics training|hazing (?:prevention )?training|records management training|family advocacy training)\b/i;

/** Praise adverbs: they rate the work rather than state it. Removed like other filler; the claim is unchanged. */
export const PRAISE_ADVERBS = /\b(?:tirelessly|diligently|expertly|flawlessly|meticulously|skillfully|masterfully|superbly|brilliantly|selflessly|enthusiastically|exceptionally|outstandingly|admirably|impeccably|seamlessly)\s+/gi;

/** Superlatives and ratings of the Marine. FITREP Section C is to be "void of superlatives"; input states results. */
export const SUPERLATIVE = /\b(outstanding|exceptional|superb|superior|phenomenal|unparalleled|unmatched|incredible|amazing|extraordinary|stellar|top-notch|world-class|best-in-class|flawless|impeccable|unrivaled|second to none)\b/i;

/** Phrases board readers discount (Marine Corps Gazette, 2019 and 2020). */
export const CLICHE = /\b(valued asset|asset to (?:the|this|his|her) (?:unit|section|command|team)|team player|self-starter|self starter|minimal supervision|hard[- ]charger|go-to (?:marine|person)|consummate professional|above and beyond|promote with (?:his |her )?peers|true professional)\b/i;

/** Impact that has not happened. Section C lists results, not "potential impact". */
export const SPECULATIVE = /\b(will|would|could|should|may|might|expected to|projected to|anticipated|potential(?:ly)?|is set to|poised to)\b/i;

/** The reporting senior's judgments: rankings, promotion and assignment recommendations. Input states what was done. */
export const RS_JUDGMENT = /(#\s?\d+\s+of\s+\d+|\b(?:top|number one|no\. 1)\s+(?:marine|nco|lcpl|cpl)\b|\bpromote (?:now|ahead|immediately|with)\b|\brecommend(?:ed)? for (?:promotion|meritorious|command|selection)\b|\bmust promote\b|\bmy (?:best|top)\b)/i;

/**
 * Acronyms spelled out on their first use, as MCO 1616.1's own examples do ("Position Safety Officer (PSO)"). Only
 * expansions that are standard; an acronym not listed is left as written.
 */
export const GLOSSARY: Record<string, { one: string; many?: string }> = {
  ULO: { one: 'unliquidated obligation', many: 'unliquidated obligations' },
  UMT: { one: 'unmatched transaction', many: 'unmatched transactions' },
  UDO: { one: 'undelivered order', many: 'undelivered orders' },
  MIPR: { one: 'military interdepartmental purchase request', many: 'military interdepartmental purchase requests' },
  DAI: { one: 'Defense Agencies Initiative' },
  SABRS: { one: 'Standard Accounting, Budgeting and Reporting System' },
  DTS: { one: 'Defense Travel System' },
  'GCSS-MC': { one: 'Global Combat Support System-Marine Corps' },
  PME: { one: 'professional military education' },
  MCMAP: { one: 'Marine Corps Martial Arts Program' },
  PFT: { one: 'physical fitness test' },
  CFT: { one: 'combat fitness test' },
  NCO: { one: 'noncommissioned officer', many: 'noncommissioned officers' },
  SNCO: { one: 'staff noncommissioned officer', many: 'staff noncommissioned officers' },
  DEP: { one: 'Distance Education Program' },
  LOA: { one: 'Letter of Appreciation' },
};

/** Work not finished yet: not an accomplishment until it is done. */
export const IN_PROGRESS = /^(?:working (?:on|towards?)|studying for|preparing for|trying to|attempting to|planning to|going to|currently (?:enrolled|working|studying)|in progress)\b|\bin progress\b/i;

/** What "my" points at when it is the Marine's own, which keeps the possessive out rather than turning it into "the". */
export const PERSONAL_NOUNS = /^(?:(?:associate'?s?|bachelor'?s?|master'?s?)\s+)?(?:degree|license|licence|belt|qualification|certification|certificate|gpa|pft|cft|rifle|score|course|education|class|own|first|promotion|meritorious|award|reenlistment)\b/i;

/** An award for an earlier period, which MCO 1616.1 Appendix E says is not a billet accomplishment. */
export const PRIOR_AWARD = /\b(?:award(?:ed)?|medal|certificate of commendation|letter of (?:appreciation|commendation)|LOA|NAM|commendation)\b.*\b(?:last year'?s?|previous|prior|preceding|earlier)\s+(?:deployment|period|year|tour|reporting period|command)\b/i;

/** Acronyms kept in capitals when a title written in all capitals is set in sentence case. */
export const ACRONYMS = new Set([
  ...Object.keys(GLOSSARY), 'MOS', 'JEPES', 'FITREP', 'USMC', 'MCO', 'MARADMIN', 'CO', 'XO', 'IG', 'DLA', 'IAPS', 'MOL', 'MCTIMS', 'PMCS', 'MTVR',
  'JLTV', 'HMMWV', 'ITX', 'CFT', 'PFT', 'SAPR', 'OPSEC', 'PII', 'BRS', 'TSP', 'EAS', 'SNM', 'MRO', 'RS', 'RO', 'FLS', 'SER', 'NCOIC', 'SNCOIC', 'OIC',
  'S-1', 'S-2', 'S-3', 'S-4', 'S-6', 'G-1', 'G-3', 'G-4', 'G-6', 'G-8', 'HQ', 'HQMC', 'MEF', 'MEU', 'MLG', 'MAW', 'DIV', 'BN', 'CMC', 'DOD', 'DON', 'IT',
  'OCMT', 'ODO', 'UDO', 'NULO', 'DOU', 'GTCC', 'DFAS', 'CAC', 'PCS', 'TAD', 'TDY', 'LES', 'BAH', 'BAS',
]);

/** Number words a bullet writes as numerals ("twelve MIPRs" → "12 MIPRs"). "zero" stays: it reads as the point. */
export const NUMBER_WORDS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
