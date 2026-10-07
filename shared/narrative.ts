import { JEPES_CORE, DEFAULT_METRICS, isSummable, type MetricsConfig } from './constants.ts';
import { formatNumber } from './metrics.ts';
import { unitFor, type BulletSource } from './bullets.ts';
import { isTimeUnit } from './metricEngine.ts';
import { writeNarrative, type CaseWork, type WrittenNarrative } from './writer/compose.ts';
import type { AreaNames, EntryInput } from './writer/facts.ts';
import type { Density, Format } from './writer/realize.ts';

export const DEFAULT_LIMIT = 1000;

const AREA_LABEL: Record<string, string> = {
  'Individual Character': 'CHARACTER',
  'MOS / Mission Accomplishment': 'MISSION',
  Leadership: 'LEADERSHIP',
};

// Distance, points and percentages measure an effort rather than count work done.
const MEASURE_UNIT = /^(?:km|kms|kilomet(?:er|re)s?|mi|miles?|met(?:er|re)s?|yards?|yds?|points?|pts|%.*)$/i;

function summarise(list: BulletSource[] = [], metrics: MetricsConfig = DEFAULT_METRICS) {
  const units: Record<string, number> = {};
  const time: Record<string, number> = {};
  const systems = new Set<string>();
  const orgs = new Set<string>();
  let dollars = 0;
  let reviewed = 0;
  for (const a of list) {
    if (a.quantity) {
      const key = (a.unit_label || 'actions').trim();
      if (isTimeUnit(key)) time[key] = (time[key] || 0) + Number(a.quantity);
      else if (!MEASURE_UNIT.test(key)) units[key] = (units[key] || 0) + Number(a.quantity);
    }
    if (a.dollar_amount) {
      if (isSummable(a.dollar_type, metrics)) dollars += Number(a.dollar_amount);
      else reviewed += Number(a.dollar_amount);
    }
    if (a.system) systems.add(a.system);
    if (a.organization) orgs.add(a.organization);
  }
  const listOf = (bag: Record<string, number>) => Object.entries(bag).sort((a, b) => b[1] - a[1]).map(([unit, total]) => `${formatNumber(total)} ${unitFor(unit, total)}`);
  return { unitList: listOf(units), timeList: listOf(time), dollars, reviewed, systems: [...systems], orgs: [...orgs], count: list.length };
}

export interface NarrativeOptions {
  limit?: number; periodLabel?: string; areas?: readonly string[]; labels?: Record<string, string>; fallbackArea?: string; metrics?: MetricsConfig;
  /** Which named area is which kind of work; derived from the area names when not given. */
  names?: AreaNames;
  seed?: number; density?: Density | 'auto'; exclude?: readonly string[]; pin?: readonly string[];
  casework?: CaseWork | null; recentFrom?: string | null;
  format?: Format; headers?: Record<string, string>; headings?: boolean; spellOut?: boolean; track?: 'jepes' | 'fitrep';
}

export type Narrative = WrittenNarrative;

/** The area each kind of work belongs to, read from a track's area names ("Leadership", "MOS / Mission Accomplishment"). */
export function areaNamesFor(areas: readonly string[], fallbackArea?: string): AreaNames {
  const find = (re: RegExp) => areas.find((a) => re.test(a));
  const mission = fallbackArea || find(/mission|mos/i) || areas[0] || 'Mission';
  const character = find(/character/i) || mission;
  return { mission, leadership: find(/leader/i) || mission, character, intellect: find(/intellect|wisdom/i) || character };
}

/**
 * The narrative for an evaluation: the writer (shared/writer) reads the entries, weighs them, and fills the
 * character limit area by area. Kept here under its old name so every caller, server and client, writes the same way.
 */
export function composeNarrative(activities: BulletSource[] = [], opts: NarrativeOptions = {}): Narrative {
  const { limit = DEFAULT_LIMIT, periodLabel = '', areas = JEPES_CORE, labels = AREA_LABEL, fallbackArea = 'MOS / Mission Accomplishment', metrics = DEFAULT_METRICS } = opts;
  return writeNarrative(activities as EntryInput[], {
    areas, labels, limit, periodLabel, metrics, names: opts.names ?? areaNamesFor(areas, fallbackArea),
    seed: opts.seed, density: opts.density, exclude: opts.exclude, pin: opts.pin, casework: opts.casework, recentFrom: opts.recentFrom,
    format: opts.format, headers: opts.headers, headings: opts.headings, spellOut: opts.spellOut, track: opts.track,
  });
}

export function areaBalance(activities: BulletSource[] = [], areas: readonly string[] = JEPES_CORE, metrics: MetricsConfig = DEFAULT_METRICS) {
  return areas.map((area) => {
    const items = activities.filter((a) => a.eval_area === area);
    const s = summarise(items, metrics);
    return {
      area, label: AREA_LABEL[area] || area, count: items.length, dollars: s.dollars,
      withOutcome: items.filter((a) => a.result).length, share: activities.length ? items.length / activities.length : 0,
    };
  });
}
