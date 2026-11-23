import { formatDTG } from './metrics.ts';
import { JEPES_CORE, DEFAULT_METRICS, type MetricsConfig } from './constants.ts';
import { areaAmong } from './evaluation.ts';
import type { AreaNames, EntryInput } from './writer/facts.ts';
import { bulletFor, entryStrength, resumeFor } from './writer/coach.ts';
import { writePackage, type PackageGroup } from './writer/package.ts';
import { formatTimeframe } from './timeframe.ts';

export type BulletStyle = 'jepes' | 'fitrep' | 'resume';

export interface BulletSource {
  id?: string; title?: string | null; category?: string | null; eval_area?: string | null; quantity?: number | string | null;
  unit_label?: string | null; dollar_amount?: number | string | null; dollar_type?: string | null; system?: string | null;
  organization?: string | null; result?: string | null; date?: string | null; evidence_links?: unknown[] | null;
  end_date?: string | null; start_time?: string | null; end_time?: string | null; ongoing?: number | boolean | null;
}

export { unitFor } from './writer/units.ts';
export { STRENGTH_MAX, STRENGTH_POINTS, STRENGTH_TOOLTIP } from './writer/strength.ts';
export type { PackageGroup, PackageBullet, PackageHeld } from './writer/package.ts';

/**
 * One entry as a bullet, from the narrative writer (shared/writer), so an entry reads the same in Quick Log, on its
 * page, in the package and in the narrative. The résumé is the same sentence with each acronym spelled out.
 */
export function composeBullet(a: BulletSource = {}, opts: { style?: BulletStyle; includeDate?: boolean; metrics?: MetricsConfig } = {}): string {
  const { style = 'jepes', includeDate = false } = opts;
  if (style === 'resume') return resumeFor(a as EntryInput, opts.metrics);
  const text = bulletFor(a as EntryInput, style, 0, opts.metrics);
  // The days it ran, as a DTG writes them: "12 MAY 25", "12 MAY 25 – 16 MAY 25", "3 MAR 25 – present" (ADR-0018).
  return includeDate && a.date ? `${text.replace(/\.$/, '')} (${formatTimeframe('activities', a, { upper: true }) || formatDTG(a.date)}).` : text;
}

/** Points of five (shared/writer/strength.ts): opens with what you did, a number, an outcome, a measured one, an area. */
export function strength(a: BulletSource = {}, track: 'jepes' | 'fitrep' = 'jepes', metrics?: MetricsConfig): number {
  return entryStrength(a as EntryInput, track, metrics).points;
}

export function groupByAreas<T extends BulletSource>(activities: T[] = [], areas: readonly string[] = JEPES_CORE) {
  // By the area's name in this breakdown's track: a Sgt's JEPES-named entries are still Mission Accomplishment.
  const home = activities.map((a) => areaAmong(a.eval_area, areas));
  const groups = areas.map((area) => ({ area, activities: activities.filter((_, i) => home[i] === area) }));
  const unassigned = activities.filter((_, i) => !areas.includes(home[i]));
  if (unassigned.length) groups.push({ area: 'Unassigned', activities: unassigned });
  return groups;
}

/**
 * The bullet package (shared/writer/package.ts): the same work compiled into one total, each area ranked as the
 * narrative ranks it, capped, and what the cap leaves out said once after the bullets.
 */
export function buildPackage(activities: BulletSource[] = [], opts: { style?: BulletStyle; track?: 'jepes' | 'fitrep'; limitPerArea?: number; areas?: readonly string[]; names?: AreaNames; metrics?: MetricsConfig; recentFrom?: string | null } = {}): PackageGroup[] {
  const { style = 'jepes', limitPerArea = 8, areas = JEPES_CORE, metrics = DEFAULT_METRICS } = opts;
  return writePackage(activities as EntryInput[], { form: style, track: opts.track, areas, names: opts.names, limitPerArea, metrics, recentFrom: opts.recentFrom });
}

/**
 * The entries the cap leaves out that no bullet or rollup speaks for, as a line, so the text, the screen and the PDFs
 * never drop one without a word.
 */
export function notShown(group: Pick<PackageGroup, 'rollup' | 'withheld' | 'unlisted'>): string | null {
  const n = group.unlisted ?? (group.rollup ? 0 : group.withheld);
  if (!n) return null;
  return `...and ${n} ${group.rollup ? 'more' : 'further'} ${n === 1 ? 'entry' : 'entries'} not shown at the current limit.`;
}

export function packageToText(pkg: PackageGroup[] = [], header = ''): string {
  const lines: string[] = [];
  if (header) lines.push(header.toUpperCase(), '='.repeat(header.length), '');
  for (const group of pkg) {
    if (!group.count) continue;
    lines.push(group.area.toUpperCase(), '-'.repeat(group.area.length));
    for (const b of group.bullets) lines.push(`  - ${b.text}`);
    // What the cap leaves out, said once after the bullets.
    if (group.rollup) lines.push('', `  ${group.rollup}`);
    const unsaid = notShown(group);
    if (unsaid) lines.push(`  ${unsaid}`);
    if (group.held?.length) {
      lines.push('', '  Held back:');
      for (const h of group.held) lines.push(`  * ${h.text} (${h.reason})`);
    }
    lines.push('');
  }
  if (!pkg.some((g) => g.count)) lines.push('No activities in this period.');
  return lines.join('\n');
}
