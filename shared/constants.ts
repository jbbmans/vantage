export const CATEGORIES = [
  'Fiscal & Financial',
  'Leadership',
  'Training & PME',
  'Administration',
  'Operations',
  'Project Work',
  'Recognition',
  'Volunteer Service',
  'Communications',
  'Other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_COLORS: Record<Category, string> = {
  'Fiscal & Financial': '#1f9d6a',
  Leadership: '#d98b1f',
  'Training & PME': '#7c5cf0',
  Administration: '#6b7a8f',
  Operations: '#149ca6',
  'Project Work': '#c33fb8',
  Recognition: '#e0506f',
  'Volunteer Service': '#7fb31d',
  Communications: '#9264e6',
  Other: '#54627a',
};

export const JEPES_AREAS = ['Individual Character', 'MOS / Mission Accomplishment', 'Leadership', 'Unassigned'] as const;
export const JEPES_CORE = ['Individual Character', 'MOS / Mission Accomplishment', 'Leadership'] as const;
export const FITREP_AREAS = [
  'Mission Accomplishment',
  'Individual Character',
  'Leadership',
  'Intellect and Wisdom',
  'Evaluation Responsibilities',
] as const;
export const EVAL_AREAS = [...new Set([...JEPES_AREAS, ...FITREP_AREAS])] as readonly string[];

export interface DollarType { key: string; label: string; verb: string; summable: boolean; definition: string }
export const DOLLAR_TYPES: readonly DollarType[] = [
  { key: 'reconciled', label: 'Reconciled', verb: 'reconciled', summable: true, definition: 'Funds you brought into agreement between systems of record.' },
  { key: 'obligated', label: 'Obligated', verb: 'obligated', summable: true, definition: 'Funds committed against a document you processed.' },
  { key: 'saved', label: 'Saved', verb: 'saved', summable: true, definition: 'Funds recovered, deobligated, or avoided as a direct result of your action.' },
  { key: 'reviewed', label: 'Reviewed', verb: 'reviewed', summable: false, definition: 'Funds that passed through your review without a balance change.' },
  { key: 'impact', label: 'Impact', verb: 'impacted', summable: true, definition: 'General fiscal impact that does not fit a narrower type.' },
];
export const DOLLAR_TYPE_KEYS = DOLLAR_TYPES.map((d) => d.key);
export const SUMMABLE_DOLLAR_TYPES = DOLLAR_TYPES.filter((d) => d.summable).map((d) => d.key);
export const DOLLAR_SUM_RULE =
  'Headline totals sum Reconciled, Obligated, Saved, and Impact. Reviewed is tracked separately: funds crossing your desk are not funds you moved.';

export const UNIT_SUGGESTIONS = [
  'ULOs', 'UMTs', 'MIPRs', 'documents', 'transactions', 'validations', 'reconciliations', 'reports',
  'hours', 'Marines', 'personnel', 'briefs', 'audits', 'accounts', 'tickets',
];

export const VISIBILITIES = ['private', 'unit'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const ACTIVITY_STATUS = ['completed', 'planned'] as const;
export const WORK_STATUS = ['planned', 'active', 'waiting', 'completed'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export const GOAL_TYPES = ['annual', 'quarterly', 'monthly', 'professional', 'developmental', 'performance'] as const;
export const GOAL_STATUS = ['active', 'achieved', 'paused', 'missed'] as const;
export const GOAL_METRICS = ['manual', 'activity_count', 'activity_dollars', 'activity_quantity', 'training_hours'] as const;
export const TRAINING_TYPES = ['pme', 'course', 'qualification', 'certification', 'education', 'skill', 'training'] as const;
export const TRAINING_STATUS = ['completed', 'in_progress', 'scheduled'] as const;
export const AWARD_TYPES = ['personal_award', 'unit_award', 'meritorious_mast', 'certificate', 'loa', 'coin', 'other'] as const;
export const AWARD_STATUS = ['planned', 'recommended', 'submitted', 'approved', 'presented', 'declined'] as const;
export const AWARD_NAMES = [
  'Navy and Marine Corps Achievement Medal',
  'Navy and Marine Corps Commendation Medal',
  'Meritorious Service Medal',
  'Joint Service Achievement Medal',
  'Joint Service Commendation Medal',
  'Marine Corps Good Conduct Medal',
  'Certificate of Commendation',
  'Letter of Appreciation',
  'Meritorious Mast',
  'Meritorious Unit Commendation',
  'Navy Unit Commendation',
];
export const COUNSELING_TYPES = ['initial', 'monthly', 'quarterly', 'semi_annual', 'event', 'career', 'other'] as const;

export const DEGREES = ['associate', 'bachelor', 'master', 'doctorate'] as const;
export const PME_STATUS = ['none', 'distance', 'resident'] as const;
export const MCMAP_BELTS = ['Tan', 'Grey', 'Green', 'Brown', 'Black 1st', 'Black 2nd', 'Black 3rd'] as const;
export const RIFLE_QUALS = ['Unqualified', 'Marksman', 'Sharpshooter', 'Expert'] as const;

export const ECHELONS = [
  { value: 'command', label: 'Command' },
  { value: 'msc', label: 'Major Subordinate Command' },
  { value: 'regiment', label: 'Regiment / Group' },
  { value: 'battalion', label: 'Battalion / Squadron' },
  { value: 'company', label: 'Company / Battery' },
  { value: 'section', label: 'Section / Shop' },
  { value: 'platoon', label: 'Platoon' },
  { value: 'squad', label: 'Squad' },
  { value: 'fire_team', label: 'Fire Team' },
] as const;

export const FISCAL_YEAR_START_MONTH = 9;

const CATEGORY_HINTS: Array<[RegExp, Category]> = [
  [/\bulo\b|\bumt\b|\bmipr\b|reconcil|obligat|deobligat|fiscal|budget|funds?\b|dai\b|advana|sabrs|audit|invoice|disburse|comptroller/i, 'Fiscal & Financial'],
  [/\bloa\b|award|commendat|certificate|meritorious|recogni/i, 'Recognition'],
  [/mentor|counsel|supervis|\bled\b|\bleading\b|\blead\b|billet|charge of|class leader|instruct/i, 'Leadership'],
  [/\bpme\b|course|seminar|school|certif|training|marinenet|belt\b|study|degree/i, 'Training & PME'],
  [/volunteer|community|color guard|funeral detail|charity/i, 'Volunteer Service'],
  [/brief|email|correspond|memo|present|deck\b|slide/i, 'Communications'],
  [/project|initiative|built|develop|tracker|workbook|automat|tool\b/i, 'Project Work'],
  [/exercise|deploy|duty|watch|saf\b|guard|operation|field\b|range\b/i, 'Operations'],
  [/roster|paperwork|filing|admin|process|route|log\b|record/i, 'Administration'],
];

export function suggestCategory(text = ''): Category {
  for (const [pattern, category] of CATEGORY_HINTS) if (pattern.test(text)) return category;
  return 'Other';
}

export function suggestEvalArea(text = '', category = ''): string {
  if (/mentor|counsel|supervis|\bled\b|class leader|\bteam\b|billet/i.test(text)) return 'Leadership';
  if (/integrity|volunteer|conduct|character|community|standard/i.test(text)) return 'Individual Character';
  if (category === 'Leadership') return 'Leadership';
  if (category === 'Volunteer Service') return 'Individual Character';
  if (['Fiscal & Financial', 'Operations', 'Project Work', 'Administration'].includes(category)) return 'MOS / Mission Accomplishment';
  return 'Unassigned';
}

export const ACCENTS = [
  { id: 'scarlet', label: 'Scarlet & Gold', hint: 'Marine Corps colors' },
  { id: 'ocean', label: 'Ocean', hint: 'Signal blue on slate' },
  { id: 'olive', label: 'Olive', hint: 'Woodland green' },
  { id: 'steel', label: 'Steel', hint: 'Neutral graphite' },
  { id: 'ember', label: 'Ember', hint: 'Warm amber' },
] as const;
export type AccentId = (typeof ACCENTS)[number]['id'];
