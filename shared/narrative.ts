import { formatNumber } from './metrics.ts';
import { SUMMABLE_DOLLAR_TYPES, JEPES_CORE } from './constants.ts';
import { strength, unitFor, type BulletSource } from './bullets.ts';

export const DEFAULT_LIMIT = 1000;

const AREA_LABEL: Record<string, string> = {
  'Individual Character': 'CHARACTER',
  'MOS / Mission Accomplishment': 'MISSION',
  Leadership: 'LEADERSHIP',
};

function money(n: number): string | null {
  if (!n) return null;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function summarise(list: BulletSource[] = []) {
  const units: Record<string, number> = {};
  const systems = new Set<string>();
  const orgs = new Set<string>();
  let dollars = 0;
  let reviewed = 0;
  for (const a of list) {
    if (a.quantity) {
      const key = (a.unit_label || 'actions').trim();
      units[key] = (units[key] || 0) + Number(a.quantity);
    }
    if (a.dollar_amount) {
      if (SUMMABLE_DOLLAR_TYPES.includes(a.dollar_type || 'impact')) dollars += Number(a.dollar_amount);
      else reviewed += Number(a.dollar_amount);
    }
    if (a.system) systems.add(a.system);
    if (a.organization) orgs.add(a.organization);
  }
  const unitList = Object.entries(units).sort((a, b) => b[1] - a[1]).map(([unit, total]) => `${formatNumber(total)} ${unitFor(unit, total)}`);
  return { unitList, dollars, reviewed, systems: [...systems], orgs: [...orgs], count: list.length };
}

function series(items: string[] = [], max = 3): string | null {
  const kept = items.slice(0, max);
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0];
  return `${kept.slice(0, -1).join(', ')} and ${kept.at(-1)}`;
}

const trimPeriod = (s = '') => s.trim().replace(/\.$/, '');
const lower = (s = '') => (/^[A-Z0-9&/-]{2,}\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));
const capitalize = (s = '') => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

const AREA_VERB: Record<string, { counted: string; money: string }> = {
  'MOS / Mission Accomplishment': { counted: 'processed', money: 'accounted for' },
  'Mission Accomplishment': { counted: 'processed', money: 'accounted for' },
  Leadership: { counted: 'led', money: 'directed' },
  'Individual Character': { counted: 'supported', money: 'contributed to' },
  'Intellect and Wisdom': { counted: 'completed', money: 'informed' },
  'Evaluation Responsibilities': { counted: 'evaluated', money: 'oversaw' },
};

function headlineSentence(area: string, list: BulletSource[]): string | null {
  const s = summarise(list);
  if (!s.count) return null;
  const verbs = AREA_VERB[area] || AREA_VERB['MOS / Mission Accomplishment'];
  const quantity = series(s.unitList);
  const cash = money(s.dollars);
  const clauses: string[] = [];
  if (quantity && cash) clauses.push(`${verbs.counted} ${quantity} valued at ${cash}`);
  else if (quantity) clauses.push(`${verbs.counted} ${quantity}`);
  else if (cash) clauses.push(`${verbs.money} ${cash}`);
  else clauses.push(`completed ${s.count} documented ${s.count === 1 ? 'action' : 'actions'}`);
  if (s.systems.length) clauses.push(`across ${series(s.systems, 3)}`);
  return clauses.join(' ');
}

function supportingSentences(list: BulletSource[]): string[] {
  return [...list]
    .sort((a, b) => strength(b) - strength(a))
    .filter((a) => a.result || a.quantity || a.dollar_amount)
    .map((a) => {
      const title = trimPeriod(String(a.title || ''));
      if (!title) return null;
      const outcome = a.result ? trimPeriod(String(a.result)) : null;
      return outcome ? `${title}, ${lower(outcome)}` : title;
    })
    .filter((x): x is string => Boolean(x));
}

export interface NarrativeOptions {
  limit?: number; periodLabel?: string; areas?: readonly string[]; labels?: Record<string, string>; fallbackArea?: string;
}

export interface Narrative {
  text: string; length: number; limit: number; fits: boolean; periodLabel?: string; omitted: number; used: number;
  areas: Array<{ area: string; label: string; count: number; included: number; available: number }>;
}

export function composeNarrative(activities: BulletSource[] = [], opts: NarrativeOptions = {}): Narrative {
  const { limit = DEFAULT_LIMIT, periodLabel = '', areas = JEPES_CORE, labels = AREA_LABEL, fallbackArea = 'MOS / Mission Accomplishment' } = opts;

  const byArea = areas
    .map((area) => ({ area, label: labels[area] || area.toUpperCase(), items: activities.filter((a) => a.eval_area === area) }))
    .filter((g) => g.items.length);
  const unmapped = activities.filter((a) => !a.eval_area || !areas.includes(a.eval_area));
  if (unmapped.length) {
    const home = byArea.find((g) => g.area === fallbackArea);
    if (home) home.items = [...home.items, ...unmapped];
    else byArea.push({ area: fallbackArea, label: labels[fallbackArea] || 'MISSION', items: unmapped });
  }
  if (!byArea.length) return { text: '', length: 0, limit, areas: [], omitted: 0, fits: true, used: 0, periodLabel };

  const blocks = byArea
    .map((g) => {
      const headline = headlineSentence(g.area, g.items);
      return { ...g, headline: headline ? `${g.label}: ${capitalize(headline)}.` : null, support: supportingSentences(g.items), used: [] as string[] };
    })
    .filter((b): b is typeof b & { headline: string } => Boolean(b.headline));

  let budget = limit;
  for (const b of blocks) budget -= b.headline.length + 1;
  let added = true;
  let totalUsed = 0;
  while (added && budget > 20) {
    added = false;
    for (const b of blocks) {
      const next = b.support[b.used.length];
      if (!next) continue;
      const cost = next.length + 2;
      if (cost > budget) continue;
      b.used.push(next);
      budget -= cost;
      totalUsed += 1;
      added = true;
    }
  }

  const text = blocks
    .map((b) => {
      const sentences = [b.headline];
      if (b.used.length) sentences.push(`${b.used.map(capitalize).join('. ')}.`);
      return sentences.join(' ');
    })
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\.{2,}/g, '.')
    .trim();
  const totalSupport = blocks.reduce((n, b) => n + b.support.length, 0);
  return {
    text, length: text.length, limit, fits: text.length <= limit, periodLabel,
    omitted: Math.max(0, totalSupport - totalUsed), used: totalUsed,
    areas: blocks.map((b) => ({ area: b.area, label: b.label, count: b.items.length, included: b.used.length, available: b.support.length })),
  };
}

export function areaBalance(activities: BulletSource[] = [], areas: readonly string[] = JEPES_CORE) {
  return areas.map((area) => {
    const items = activities.filter((a) => a.eval_area === area);
    const s = summarise(items);
    return {
      area, label: AREA_LABEL[area] || area, count: items.length, dollars: s.dollars,
      withOutcome: items.filter((a) => a.result).length, share: activities.length ? items.length / activities.length : 0,
    };
  });
}
