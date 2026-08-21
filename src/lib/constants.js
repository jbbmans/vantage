/**
 * Vantage — domain vocabulary.
 * Rebuilt from call sites; the original module was not recoverable from the archive.
 *
 * Everything the app calls a "category", an "area", or a "dollar type" is defined
 * here and nowhere else. If a term needs to change, it changes once.
 */

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
];

/**
 * Stable per-category hue. Used by charts, dots, and the fiscal tape.
 * Deliberately excludes blue — that hue belongs to the accent alone, so a
 * category dot is never mistaken for an active-state indicator.
 */
export const CATEGORY_COLORS = {
  'Fiscal & Financial': '#3DD68C',
  Leadership: '#F0A93B',
  'Training & PME': '#A78BFA',
  Administration: '#8D98A8',
  Operations: '#2DD4BF',
  'Project Work': '#D946EF',
  Recognition: '#FB7185',
  'Volunteer Service': '#A3E635',
  Communications: '#C084FC',
  Other: '#5C6675',
};

export const CATEGORY_ICONS = {
  'Fiscal & Financial': 'DollarSign',
  Leadership: 'Users',
  'Training & PME': 'GraduationCap',
  Administration: 'FileText',
  Operations: 'Radio',
  'Project Work': 'Layers',
  Recognition: 'Award',
  'Volunteer Service': 'HeartHandshake',
  Communications: 'Send',
  Other: 'Circle',
};

export const JEPES_AREAS = [
  'Individual Character',
  'MOS / Mission Accomplishment',
  'Leadership',
  'Unassigned',
];

/** The three scored areas, excluding the Unassigned bucket. */
export const JEPES_CORE = JEPES_AREAS.filter((a) => a !== 'Unassigned');

/**
 * Dollar types exist so a total is never ambiguous. Money you *reconciled* is
 * not money you *saved*, and a board that catches you conflating the two stops
 * trusting every other figure on the page.
 */
export const DOLLAR_TYPES = [
  { key: 'reconciled', label: 'Reconciled', verb: 'reconciled', summable: true },
  { key: 'obligated', label: 'Obligated', verb: 'obligated', summable: true },
  { key: 'saved', label: 'Saved', verb: 'saved', summable: true },
  { key: 'reviewed', label: 'Reviewed', verb: 'reviewed', summable: false },
  { key: 'impact', label: 'Impact', verb: 'impacted', summable: true },
];

export const DOLLAR_TYPE_DEFINITIONS = {
  reconciled: 'Funds you brought into agreement between systems of record.',
  obligated: 'Funds committed against a document you processed.',
  saved: 'Funds recovered, deobligated, or avoided as a direct result of your action.',
  reviewed: 'Funds that passed through your review without a balance change.',
  impact: 'General fiscal impact that does not fit a narrower type.',
};

/**
 * The rule shown next to every rolled-up dollar figure. Reviewed dollars are
 * excluded from headline totals because reviewing $4M and recovering $4M are
 * not the same accomplishment, and only one of them survives a follow-up question.
 */
export const DOLLAR_SUM_RULE =
  'Headline totals sum Reconciled, Obligated, Saved, and Impact. Reviewed is tracked separately — funds crossing your desk are not funds you moved.';

export const SUMMABLE_DOLLAR_TYPES = DOLLAR_TYPES.filter((d) => d.summable).map((d) => d.key);

export const UNIT_SUGGESTIONS = [
  'ULOs',
  'UMTs',
  'MIPRs',
  'documents',
  'transactions',
  'validations',
  'reconciliations',
  'reports',
  'hours',
  'Marines',
  'personnel',
  'briefs',
  'audits',
  'accounts',
  'tickets',
];

export const ACTIVITY_STATUS = ['completed', 'planned'];
export const WORK_STATUS = ['planned', 'active', 'waiting', 'completed'];
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const GOAL_TYPES = ['annual', 'quarterly', 'monthly', 'professional', 'developmental', 'performance'];
export const GOAL_STATUS = ['active', 'achieved', 'paused', 'missed'];
export const RECOGNITION_TYPES = ['award', 'loa', 'certificate', 'commendation', 'feedback', 'email', 'other'];
export const TRAINING_TYPES = ['pme', 'course', 'qualification', 'certification', 'education', 'skill', 'training'];
export const TRAINING_STATUS = ['completed', 'in_progress', 'scheduled'];

/** Keyword → category. First match wins, so order matters: specific before general. */
const CATEGORY_HINTS = [
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

/** Best-guess category for free text. Always returns something. */
export function suggestCategory(text = '') {
  for (const [pattern, category] of CATEGORY_HINTS) {
    if (pattern.test(text)) return category;
  }
  return 'Other';
}

/** Best-guess JEPES area for free text. */
export function suggestJepesArea(text = '', category = '') {
  if (/mentor|counsel|supervis|\bled\b|class leader|\bteam\b|billet/i.test(text)) return 'Leadership';
  if (/integrity|volunteer|conduct|character|community|standard/i.test(text)) return 'Individual Character';
  if (category === 'Leadership') return 'Leadership';
  if (category === 'Volunteer Service') return 'Individual Character';
  if (['Fiscal & Financial', 'Operations', 'Project Work', 'Administration'].includes(category)) {
    return 'MOS / Mission Accomplishment';
  }
  return 'Unassigned';
}

/** The fiscal year starts 1 October. This is the single source of that truth. */
export const FISCAL_YEAR_START_MONTH = 9; // zero-indexed October

/** Echelons, largest to smallest. Mirrors server/usmc.js. */
export const ECHELON_OPTIONS = [
  { value: 'command', label: 'Command' },
  { value: 'msc', label: 'Major Subordinate Command' },
  { value: 'regiment', label: 'Regiment / Group' },
  { value: 'battalion', label: 'Battalion / Squadron' },
  { value: 'company', label: 'Company / Battery' },
  { value: 'section', label: 'Section / Shop' },
  { value: 'platoon', label: 'Platoon' },
  { value: 'squad', label: 'Squad' },
  { value: 'fire_team', label: 'Fire Team' },
];
