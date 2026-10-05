import { formatDollarsExact, formatNumber, formatDTG } from './metrics.ts';
import { JEPES_CORE, DEFAULT_METRICS, isSummable, type MetricsConfig } from './constants.ts';
import { areaAmong } from './evaluation.ts';

export type BulletStyle = 'jepes' | 'fitrep' | 'resume';

export interface BulletSource {
  id?: string; title?: string | null; category?: string | null; eval_area?: string | null; quantity?: number | string | null;
  unit_label?: string | null; dollar_amount?: number | string | null; dollar_type?: string | null; system?: string | null;
  organization?: string | null; result?: string | null; date?: string | null; evidence_links?: unknown[] | null;
}

const VERB_BY_DOLLAR_TYPE: Record<string, string> = { reconciled: 'Reconciled', obligated: 'Obligated', saved: 'Recovered', reviewed: 'Reviewed', impact: 'Processed' };
const VERB_BY_CATEGORY: Record<string, string> = {
  'Fiscal & Financial': 'Executed', Leadership: 'Led', 'Training & PME': 'Completed', Administration: 'Processed', Operations: 'Executed',
  'Project Work': 'Developed', Recognition: 'Earned', 'Volunteer Service': 'Volunteered', Communications: 'Briefed', Other: 'Completed',
};
const RESUME_VERB_BY_DOLLAR_TYPE: Record<string, string> = { reconciled: 'Reconciled', obligated: 'Committed', saved: 'Recovered', reviewed: 'Audited', impact: 'Managed' };
const RESUME_VERB_BY_CATEGORY: Record<string, string> = {
  'Fiscal & Financial': 'Managed', Leadership: 'Led', 'Training & PME': 'Completed', Administration: 'Administered', Operations: 'Coordinated',
  'Project Work': 'Built', Recognition: 'Received', 'Volunteer Service': 'Volunteered', Communications: 'Presented', Other: 'Delivered',
};

export const ACRONYM_GLOSS: Record<string, string> = {
  ULO: 'unliquidated obligation', ULOS: 'unliquidated obligations', UMT: 'unmatched transaction', UMTS: 'unmatched transactions',
  MIPR: 'military interdepartmental purchase request', MIPRS: 'military interdepartmental purchase requests',
  DAI: 'Defense Agencies Initiative (DoD financial system of record)', SABRS: 'Standard Accounting, Budgeting and Reporting System',
  ADVANA: 'ADVANA (DoD enterprise analytics platform)', DTS: 'Defense Travel System', 'GCSS-MC': 'Global Combat Support System',
  PME: 'professional military education', JEPES: 'Junior Enlisted Performance Evaluation System', LOA: 'Letter of Appreciation', FITREP: 'fitness report',
};

function leadVerb(a: BulletSource, style: BulletStyle): string {
  const civilian = style === 'resume';
  if (a.dollar_amount && a.dollar_type) {
    const table = civilian ? RESUME_VERB_BY_DOLLAR_TYPE : VERB_BY_DOLLAR_TYPE;
    return table[a.dollar_type] || (civilian ? 'Managed' : 'Processed');
  }
  const table = civilian ? RESUME_VERB_BY_CATEGORY : VERB_BY_CATEGORY;
  return table[a.category || ''] || 'Completed';
}

const PAST_VERBS =
  /^(led|ran|built|drove|served|stood|held|processed|reconciled|validated|audited|briefed|mentored|completed|developed|executed|obligated|recovered|deobligated|reviewed|coordinated|managed|trained|drafted|authored|created|designed|delivered|earned|volunteered|supervised|maintained|resolved|corrected|cleared|prepared|conducted|organized|instructed|planned|tracked|updated|submitted|attended|assisted|supported)\b/i;

function titleIsAction(title = ''): boolean {
  const first = title.trim().split(/\s+/)[0] || '';
  return PAST_VERBS.test(title) || (/ed$/i.test(first) && first.length > 4);
}

export { unitFor } from './writer/units.ts';
import { readEntry, type EntryInput } from './writer/facts.ts';
import { sentenceFor } from './writer/realize.ts';

const SINGLE = { names: { mission: 'MOS / Mission Accomplishment', leadership: 'Leadership', character: 'Individual Character', intellect: 'Individual Character' }, areas: JEPES_CORE };
import { unitFor } from './writer/units.ts';

const capitalize = (s = '') => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function expandAcronyms(text = ''): string {
  if (!text) return text;
  const seen = new Set<string>();
  return text.replace(/\b([A-Z][A-Z0-9-]{1,9}s?)\b/g, (match) => {
    const key = match.toUpperCase();
    const gloss = ACRONYM_GLOSS[key];
    if (!gloss || seen.has(key)) return match;
    seen.add(key);
    if (gloss.includes('(')) return gloss;
    return `${gloss} (${match})`;
  });
}

const FITREP_CUTS: Array<[RegExp, string]> = [
  [/\bin support of\b/gi, 'supporting'], [/\btotaling\b/gi, 'valued at'], [/\bin order to\b/gi, 'to'], [/\ba total of\b/gi, ''],
  [/\bapproximately\b/gi, ''], [/\bin excess of\b/gi, 'over'], [/\bwas responsible for\b/gi, ''],
];

function compress(sentence = ''): string {
  let out = sentence;
  for (const [pattern, replacement] of FITREP_CUTS) out = out.replace(pattern, replacement);
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([,;.])/g, '$1').replace(/,\s*,/g, ',').trim();
}

function lowerFirst(s = ''): string {
  if (!s) return s;
  if (/^[A-Z0-9&/-]{2,}\b/.test(s)) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

/** Whether the title already names this amount ("$48,250", "$1.2 million"), so the bullet does not say it twice. */
function titleStatesAmount(title: string, amount: number): boolean {
  if (!amount) return false;
  for (const m of title.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|mm|m|million|b|billion)?\b/gi)) {
    const value = Number(m[1].replace(/,/g, '')) * (m[2] ? SCALE[m[2].toLowerCase()] : 1);
    if (Math.abs(value - amount) < 0.005) return true;
  }
  return false;
}

/**
 * One entry as a bullet. JEPES and FITREP bullets come from the narrative writer (shared/writer), so an entry reads
 * the same in Quick Log, on its page, in the package and in the narrative; the résumé style keeps civilian phrasing.
 */
export function composeBullet(a: BulletSource = {}, opts: { style?: BulletStyle; includeDate?: boolean } = {}): string {
  const { style = 'jepes', includeDate = false } = opts;
  if (style !== 'resume') {
    const text = sentenceFor(readEntry(a as EntryInput, SINGLE), 'full', 0, 'bullets');
    return includeDate && a.date ? `${text.replace(/\.$/, '')} (${formatDTG(a.date)}).` : text;
  }
  const title = String(a.title || '').trim().replace(/\.$/, '');
  const titleLower = title.toLowerCase();
  const inTitle = (needle: unknown) => Boolean(needle) && titleLower.includes(String(needle).toLowerCase());

  const amount = a.dollar_amount ? Number(a.dollar_amount) : 0;
  const rawMoney = amount ? formatDollarsExact(amount) : null;
  const money = rawMoney && !(inTitle(rawMoney.slice(1)) || inTitle(String(a.dollar_amount)) || titleStatesAmount(title, amount)) ? rawMoney : null;

  const hasQty = a.quantity != null && a.quantity !== '' && (Number(a.quantity) !== 1 || Boolean(rawMoney));
  const unitLabel = unitFor(a.unit_label || 'items', a.quantity);
  const showQty = hasQty && !inTitle(`${formatNumber(Number(a.quantity))} ${unitLabel}`);
  const qty = showQty ? `${formatNumber(Number(a.quantity))} ${unitLabel}` : null;
  // From here on, the résumé: civilian verbs, acronyms written out, the result as a consequence.
  const measure = qty && money ? `${qty} totaling ${money}` : qty || money || null;

  const parts: string[] = [];
  if (title && titleIsAction(title)) {
    parts.push(capitalize(title));
    if (measure) parts.push(`, ${measure},`);
  } else {
    const verb = leadVerb(a, style);
    parts.push(measure ? `${verb} ${measure}` : `${verb} ${lowerFirst(title || 'assigned task')}`);
    if (measure && title) parts.push(`in support of ${lowerFirst(title)}`);
  }
  if (a.system && !inTitle(a.system)) parts.push(`via ${a.system}`);

  let sentence = parts.join(' ').replace(/\s+,/g, ',').replace(/,\s*,/g, ',').replace(/\s+/g, ' ').trim().replace(/,$/, '');
  if (a.result) {
    const result = lowerFirst(String(a.result).trim().replace(/\.$/, ''));
    sentence += `, resulting in ${result}`;
  }
  sentence = expandAcronyms(sentence);
  sentence = capitalize(sentence);
  if (!/[.!?]$/.test(sentence)) sentence += '.';
  return sentence;
}

export function composeRollup(activities: BulletSource[] = [], opts: { label?: string; period?: string; style?: BulletStyle; metrics?: MetricsConfig } = {}): string | null {
  const { label = 'fiscal actions', period = '', style = 'jepes', metrics = DEFAULT_METRICS } = opts;
  if (!activities.length) return null;
  const unitTotals: Record<string, number> = {};
  let dollars = 0;
  let reviewed = 0;
  const orgs = new Set<string>();
  const systems = new Set<string>();
  for (const a of activities) {
    if (a.quantity) {
      const unit = (a.unit_label || 'items').trim();
      unitTotals[unit] = (unitTotals[unit] || 0) + Number(a.quantity);
    }
    if (a.dollar_amount) {
      if (isSummable(a.dollar_type, metrics)) dollars += Number(a.dollar_amount);
      else reviewed += Number(a.dollar_amount);
    }
    if (a.organization) orgs.add(a.organization);
    if (a.system) systems.add(a.system);
  }
  const unitPhrase = Object.entries(unitTotals).sort((x, y) => y[1] - x[1]).slice(0, 3)
    .map(([unit, total]) => `${formatNumber(total)} ${unitFor(unit, total)}`).join(', ');
  const segs: string[] = [];
  segs.push(`Across ${activities.length} logged ${activities.length === 1 ? 'action' : 'actions'}${period ? ` in ${period}` : ''}`);
  if (unitPhrase) segs.push(`processed ${unitPhrase}`);
  if (dollars) segs.push(`${unitPhrase ? 'representing' : 'processed'} ${formatDollarsExact(dollars)} in ${label}`);
  if (reviewed) segs.push(`with an additional ${formatDollarsExact(reviewed)} reviewed`);
  if (systems.size) segs.push(`using ${[...systems].slice(0, 3).join(', ')}`);
  if (orgs.size === 1 && style !== 'resume') segs.push(`for ${[...orgs][0]}`);
  let out = segs.join(', ').replace(/,\s*,/g, ',');
  out = out.charAt(0).toUpperCase() + out.slice(1);
  if (style === 'resume') out = expandAcronyms(out);
  if (style === 'fitrep') out = compress(out);
  return out.endsWith('.') ? out : `${out}.`;
}

export function strength(a: BulletSource = {}): number {
  let s = 0;
  if (a.dollar_amount) s += 2;
  if (a.quantity) s += 1;
  if (a.result) s += 1;
  return s;
}

export function weaknesses(a: BulletSource = {}): string[] {
  const gaps: string[] = [];
  if (!a.result) gaps.push('no stated outcome (so what?)');
  if (!a.quantity) gaps.push('no quantity (how many?)');
  if (!a.dollar_amount && a.category === 'Fiscal & Financial') gaps.push('no dollar figure');
  if (!a.eval_area || a.eval_area === 'Unassigned') gaps.push('not mapped to an evaluation area');
  return gaps;
}

export function groupByAreas<T extends BulletSource>(activities: T[] = [], areas: readonly string[] = JEPES_CORE) {
  // By the area's name in this breakdown's track: a Sgt's JEPES-named entries are still Mission Accomplishment.
  const home = activities.map((a) => areaAmong(a.eval_area, areas));
  const groups = areas.map((area) => ({ area, activities: activities.filter((_, i) => home[i] === area) }));
  const unassigned = activities.filter((_, i) => !areas.includes(home[i]));
  if (unassigned.length) groups.push({ area: 'Unassigned', activities: unassigned });
  return groups;
}

export interface PackageGroup {
  area: string; count: number; withheld: number; rollup: string | null;
  bullets: Array<{ id?: string; text: string; date?: string | null; strength: number }>;
}

export function buildPackage(activities: BulletSource[] = [], opts: { periodLabel?: string; style?: BulletStyle; limitPerArea?: number; areas?: readonly string[]; metrics?: MetricsConfig } = {}): PackageGroup[] {
  const { periodLabel = '', style = 'jepes', limitPerArea = 8, areas = JEPES_CORE, metrics = DEFAULT_METRICS } = opts;
  const cap = !limitPerArea || limitPerArea === Infinity ? Infinity : limitPerArea;
  return groupByAreas(activities, areas).map(({ area, activities: items }) => {
    const ranked = [...items].sort((a, b) => strength(b) - strength(a));
    const shown = cap === Infinity ? ranked : ranked.slice(0, cap);
    return {
      area,
      count: items.length,
      withheld: Math.max(0, items.length - shown.length),
      rollup: composeRollup(items, { period: periodLabel, style, metrics }),
      bullets: shown.map((a) => ({ id: a.id, text: composeBullet(a, { style }), date: a.date, strength: strength(a) })),
    };
  });
}

export function packageToText(pkg: PackageGroup[] = [], header = ''): string {
  const lines: string[] = [];
  if (header) lines.push(header.toUpperCase(), '='.repeat(header.length), '');
  for (const group of pkg) {
    if (!group.count) continue;
    lines.push(group.area.toUpperCase(), '-'.repeat(group.area.length));
    if (group.rollup) lines.push(`  ${group.rollup}`, '');
    for (const b of group.bullets) lines.push(`  - ${b.text}`);
    if (group.withheld > 0) lines.push(`  ...and ${group.withheld} further ${group.withheld === 1 ? 'entry' : 'entries'} not shown at the current limit.`);
    lines.push('');
  }
  if (!pkg.some((g) => g.count)) lines.push('No activities in this period.');
  return lines.join('\n');
}

