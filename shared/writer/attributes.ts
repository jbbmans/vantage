import type { VerbKind } from './lexicon.ts';

/**
 * Which of the fourteen FITREP attributes (MCO 1610.7B, Sections D to H) an entry gives evidence for, read from its
 * verb and its words. One reading serves the narrative (where a sentence sits and the attribute it shows), the
 * Readiness coverage and the studio, so they never disagree. It flags evidence; the reporting senior marks.
 */

/** The broad area each attribute sits in, by the writer's area kinds (Section D mission, E character, F leadership, G intellect, H evaluations). */
export const ATTRIBUTE_AREA = {
  Performance: 'mission',
  Proficiency: 'mission',
  Courage: 'character',
  'Effectiveness Under Stress': 'character',
  Initiative: 'character',
  'Leading Subordinates': 'leadership',
  'Developing Subordinates': 'leadership',
  'Setting the Example': 'leadership',
  'Ensuring Well-Being of Subordinates': 'leadership',
  'Communication Skills': 'leadership',
  'Professional Military Education (PME)': 'intellect',
  'Decision Making Ability': 'intellect',
  Judgment: 'intellect',
  Evaluations: 'evaluations',
} as const;

export type Attribute = keyof typeof ATTRIBUTE_AREA;

/** The FITREP section names the writer files under, by area kind (as shared/evaluation.ts names them). */
export const FITREP_NAMES = { mission: 'Mission Accomplishment', leadership: 'Leadership', character: 'Individual Character', intellect: 'Intellect and Wisdom', evaluations: 'Evaluation Responsibilities' };
export const FITREP_AREAS = Object.values(FITREP_NAMES);

/** The attribute each kind of work speaks to before its words say more. */
const BY_KIND: Record<VerbKind, Attribute> = {
  execute: 'Performance', finance: 'Performance', fix: 'Performance', maintain: 'Performance', admin: 'Performance', plan: 'Performance',
  support: 'Performance', analyze: 'Proficiency', build: 'Initiative', improve: 'Initiative', qualify: 'Proficiency',
  lead: 'Leading Subordinates', develop: 'Developing Subordinates', care: 'Ensuring Well-Being of Subordinates',
  communicate: 'Communication Skills', learn: 'Professional Military Education (PME)', serve: 'Initiative',
};

/** Analysis that ends in a choice is decision making; analysis that ends in advice is judgment. The rest is skill. */
const DECIDING = new Set(['decide', 'prioritize', 'determine', 'select', 'choose', 'triage', 'allocate']);
const ADVISING = new Set(['recommend', 'assess', 'evaluate', 'forecast', 'advise', 'propose', 'weigh']);

// Words that point at an attribute whatever the verb. Kept narrow: a cue has to name the thing, not hint at it.
const EVALUATION_DUTY = /\b(?:JEPES|FITREPs?|fitness reports?|pro(?:ficiency)?\s*(?:\/|&|and)\s*con(?:duct)?|command input|MROW|MRO worksheets?|reporting senior|reviewing officer|(?:marked|wrote|submitted|completed|reviewed)\s+(?:\d+\s+)?(?:\w+\s+){0,2}evaluations)\b/i;
const PME = /\b(?:PME|MarineNet|DEP|distance education|resident course|(?:\w+\s+)?course|academy|seminar|college|degree|credits?|certificat(?:e|ion)s?|curriculum|EWS|SNCOA|correspondence|professional reading|reading list)\b/i;
const WELL_BEING = /\b(?:checked (?:on|in with)|welfare|well-being|wellbeing|famil(?:y|ies)|barracks|sponsor(?:ed|ship)?|housing|pay (?:problems?|issues?)|morale|suicide|safety brief|liberty brief|leave plans?)\b/i;
const UNDER_STRESS = /\b(?:no[- ]notice|short[- ]notice|\d+[- ]hours? (?:window|deadline|turnaround|notice)|within \d+ hours|overnight|surge|crisis|emergenc(?:y|ies)|under fire|combat|casualt(?:y|ies)|mass casualty|deployed|in theater|while short[- ]handed|understaffed)\b/i;
const COURAGE = /\b(?:reported (?:a |the |an )?(?:safety|misconduct|fraud|hazard|violation|discrepanc)|stood up (?:for|to)|intervened|refused to (?:sign|certify|approve)|raised (?:a |the )?(?:safety )?concern|rescued|saved (?:a|the|his|her|their) life|life[- ]?saving|first aid|CPR)\b/i;
const EXAMPLE = /\b(?:color guard|honor guard|funeral detail|ceremon(?:y|ies)|parade|uniform inspection|drill|Marine of the (?:Month|Quarter|Year)|NCO of the (?:Month|Quarter|Year)|first to)\b/i;
const SPEAKING = /\b(?:briefed|presented|wrote|drafted|authored|published|spoke|translated|negotiated)\b/i;
const TECHNICAL = /\b(?:certified|qualified|licensed|expert|technical|subject matter expert|SME|troubleshot|diagnosed)\b/i;

export interface AttributeReading { primary: Attribute; all: Attribute[] }

/**
 * The attributes one entry evidences, the strongest first. `text` is what the entry says (title and outcome);
 * `kind` and `lemma` come from its verb as the writer read it.
 */
export function attributesOf(input: { text: string; kind: VerbKind | null; lemma?: string | null; category?: string | null; people?: number | null }): AttributeReading {
  const { text, kind, lemma, category, people } = input;
  let base: Attribute = kind ? BY_KIND[kind] : 'Performance';
  if (kind === 'analyze' || lemma === 'prioritize') base = lemma && DECIDING.has(lemma) ? 'Decision Making Ability' : lemma && ADVISING.has(lemma) ? 'Judgment' : base;
  const teaching = kind === 'develop' || kind === 'lead';
  const plain = !kind || kind === 'execute' || kind === 'serve' || kind === 'support' || kind === 'admin';

  const cues: Attribute[] = [];
  if (EVALUATION_DUTY.test(text)) cues.push('Evaluations');
  if (COURAGE.test(text)) cues.push('Courage');
  // A course the Marine took, not one they taught.
  const studied = (category === 'Training & PME' || kind === 'learn' || kind === 'qualify' || PME.test(text)) && !teaching && kind !== 'communicate';
  if (studied && (kind === 'learn' || category === 'Training & PME' || (PME.test(text) && (plain || kind === 'qualify')))) cues.push('Professional Military Education (PME)');
  if (WELL_BEING.test(text) && (plain || kind === 'care' || kind === 'plan')) cues.push('Ensuring Well-Being of Subordinates');
  if (EXAMPLE.test(text) && plain) cues.push('Setting the Example');

  const primary = cues[0] ?? base;
  // A plain verb ("submitted", "checked") says nothing of its own once the words have named the attribute.
  const all = new Set<Attribute>(cues.length && plain ? cues : [primary, base, ...cues]);
  if (UNDER_STRESS.test(text)) all.add('Effectiveness Under Stress');
  if (WELL_BEING.test(text)) all.add('Ensuring Well-Being of Subordinates');
  if (EXAMPLE.test(text)) all.add('Setting the Example');
  if (SPEAKING.test(text)) all.add('Communication Skills');
  if (TECHNICAL.test(text)) all.add('Proficiency');
  if (people && people > 0 && !teaching && primary === 'Performance') all.add('Leading Subordinates');
  return { primary, all: [...all] };
}

/**
 * What evidence for each attribute tends to look like, as prompts for what to log. Coaching from the attribute's
 * name, not the order's descriptors: those are the reporting senior's to apply.
 */
export const ATTRIBUTE_PROMPTS: Record<Attribute, string> = {
  Performance: 'what your billet produced: the count, the dollars, the deadline met',
  Proficiency: 'a qualification or certification earned, or a technical problem you solved',
  Courage: 'a time you reported, refused or stopped something wrong',
  'Effectiveness Under Stress': 'work done to a no-notice tasking, a short deadline or short-handed',
  Initiative: 'something you started without being told: a fix, a tool, a duty you volunteered for',
  'Leading Subordinates': 'Marines you directed through a task: the section, a detail, a working party',
  'Developing Subordinates': 'Marines you trained, mentored or counseled, and what they can do now',
  'Setting the Example': 'details, ceremonies and inspections, and the standard you held',
  'Ensuring Well-Being of Subordinates': 'welfare checks, sponsorship, and pay or housing problems you solved for your Marines',
  'Communication Skills': 'briefs you gave and papers you wrote, and what they decided',
  'Professional Military Education (PME)': 'PME, courses and professional reading completed, with the grade',
  'Decision Making Ability': 'a call you made: what you prioritized or chose, and how it turned out',
  Judgment: 'advice or a recommendation you gave, and what came of it',
  Evaluations: 'evaluations you wrote or contributed to, and whether they were on time',
};
