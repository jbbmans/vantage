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

/**
 * What an instance measures. The defaults are the G-8 comptroller set the app grew up with; an owner can rename the money
 * metric, redefine the value types (which ones roll into the headline total), and set the categories and unit suggestions
 * for any other shop. Records keep whatever key they were saved with, so retiring a type never rewrites history.
 */
export interface MetricsConfig {
  currency_label: string;
  currency_symbol: string;
  value_types: DollarType[];
  categories: Array<{ name: string; color: string }>;
  unit_suggestions: string[];
}
export const DEFAULT_METRICS: MetricsConfig = {
  currency_label: 'Dollars',
  currency_symbol: '$',
  value_types: DOLLAR_TYPES.map((d) => ({ ...d })),
  categories: CATEGORIES.map((name) => ({ name, color: CATEGORY_COLORS[name] })),
  unit_suggestions: [...UNIT_SUGGESTIONS],
};
export const CATEGORY_PALETTE = ['#1f9d6a', '#d98b1f', '#7c5cf0', '#6b7a8f', '#149ca6', '#c33fb8', '#e0506f', '#7fb31d', '#9264e6', '#54627a', '#2f6fd6', '#b8862b'];

export const summableKeys = (cfg: MetricsConfig = DEFAULT_METRICS) => cfg.value_types.filter((d) => d.summable).map((d) => d.key);
/** A missing type counts toward the headline (it always has); an unknown or non-summable type is tracked separately. */
export const isSummable = (type: string | null | undefined, cfg: MetricsConfig = DEFAULT_METRICS) => !type || summableKeys(cfg).includes(type);
export const valueType = (key: string | null | undefined, cfg: MetricsConfig = DEFAULT_METRICS) => cfg.value_types.find((d) => d.key === key) || null;
export const categoryNames = (cfg: MetricsConfig = DEFAULT_METRICS) => cfg.categories.map((c) => c.name);
export function categoryColor(name: string | null | undefined, cfg: MetricsConfig = DEFAULT_METRICS): string {
  const hit = cfg.categories.find((c) => c.name === (name || 'Other'));
  if (hit) return hit.color;
  let h = 0; for (const ch of String(name || 'Other')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return CATEGORY_PALETTE[h % CATEGORY_PALETTE.length];
}
export function dollarSumRule(cfg: MetricsConfig = DEFAULT_METRICS): string {
  const inn = cfg.value_types.filter((d) => d.summable).map((d) => d.label);
  const out = cfg.value_types.filter((d) => !d.summable).map((d) => d.label);
  const label = cfg.currency_label.toLowerCase();
  if (!out.length) return `Headline totals sum every ${label} type: ${inn.join(', ')}.`;
  return `Headline totals sum ${inn.join(', ')}. ${out.join(' and ')} ${out.length === 1 ? 'is' : 'are'} tracked separately: ${label} crossing your desk are not ${label} you moved.`;
}
/** Normalises anything an operator or an old archive hands us into a usable configuration. */
export function normalizeMetrics(input: unknown): MetricsConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number, fallback: string) => { const s = String(v ?? '').trim().slice(0, max); return s || fallback; };
  const types = Array.isArray(raw.value_types) ? raw.value_types : [];
  const seen = new Set<string>();
  const value_types: DollarType[] = [];
  for (const t of types as Array<Record<string, unknown>>) {
    const key = String(t?.key ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const label = str(t.label, 40, key);
    value_types.push({ key, label, verb: str(t.verb, 40, label.toLowerCase()), summable: t.summable !== false, definition: String(t.definition ?? '').trim().slice(0, 200) });
    if (value_types.length >= 20) break;
  }
  const cats = Array.isArray(raw.categories) ? raw.categories : [];
  const names = new Set<string>();
  const categories: Array<{ name: string; color: string }> = [];
  for (const c of cats as Array<Record<string, unknown> | string>) {
    const name = str(typeof c === 'string' ? c : c?.name, 60, '');
    if (!name || names.has(name)) continue;
    names.add(name);
    const color = typeof c === 'object' && c && /^#[0-9a-f]{6}$/i.test(String(c.color || '')) ? String(c.color).toLowerCase() : CATEGORY_PALETTE[categories.length % CATEGORY_PALETTE.length];
    categories.push({ name, color });
    if (categories.length >= 40) break;
  }
  const units = Array.isArray(raw.unit_suggestions) ? [...new Set((raw.unit_suggestions as unknown[]).map((u) => String(u ?? '').trim().slice(0, 30)).filter(Boolean))].slice(0, 60) : [];
  return {
    currency_label: str(raw.currency_label, 30, DEFAULT_METRICS.currency_label),
    currency_symbol: String(raw.currency_symbol ?? '$').trim().slice(0, 4) || '$',
    value_types: value_types.length ? value_types : DEFAULT_METRICS.value_types.map((d) => ({ ...d })),
    categories: categories.length ? categories : DEFAULT_METRICS.categories.map((c) => ({ ...c })),
    unit_suggestions: units.length ? units : [...DEFAULT_METRICS.unit_suggestions],
  };
}

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
