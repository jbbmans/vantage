import type { Recommendation } from './evaluation.ts';
import { jepesLevers, type EstimateOptions } from './jepesEstimate.ts';

export const ARQ_BANDS = [
  { qual: 'Expert', band: '43 to 50 destroys, plus one iteration of all three drills' },
  { qual: 'Sharpshooter', band: '31 to 42 destroys, plus two drill types' },
  { qual: 'Marksman', band: '15 to 30 destroys, plus any one drill type' },
];

export function fitnessClass(score: unknown): string | null {
  if (score === null || score === undefined || String(score).trim() === '') return null;
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  if (n >= 235) return '1st class';
  if (n >= 200) return '2nd class';
  if (n >= 150) return '3rd class';
  return 'below 3rd class';
}

/** A value the Marine entered: blank, missing or spaces only is not one. */
const entered = (v: unknown) => !(v === null || v === undefined || String(v).trim() === '');

const rec = (o: Partial<Recommendation> & { id: string; title: string; detail: string; priority: number }): Recommendation => ({ effort: 'medium', category: 'General', kind: 'heuristic', ...o });

/**
 * What to do next on the JEPES track. First the levers the estimator ranks (ADR-0046): a blank figure, then each step by
 * the points the order's tables say it adds. Then the coaching no table scores: PME for grade, and how the log reads.
 */
export function recommend(profile: Record<string, unknown> = {}, activityStats: { total?: number; withOutcome?: number; thinAreas?: string[] } = {}, opts: EstimateOptions = {}): Recommendation[] {
  const levers = jepesLevers(profile, opts);
  const out: Recommendation[] = levers.map((l, i) => rec({
    id: l.id, title: l.title, detail: l.detail, effort: l.effort, category: l.category,
    kind: l.kind === 'data' ? 'data' : 'estimate', points: l.points, upTo: l.upTo, ...(l.change ? { change: l.change } : {}),
    // Kept in the estimator's order, above the coaching below.
    priority: 1000 - i,
  }));
  const mentalEntered = ['ceus', 'degree', 'associate_degrees', 'courses_in_service', 'courses_in_grade', 'mos_qual_points', 'college_credits'].some((k) => entered(profile[k]));
  // PME for grade is no line on the worksheet; it is tracked for promotion eligibility, so it stays as coaching.
  if (profile.pme_complete === 'none') {
    out.push(rec({ id: 'pme', title: 'Complete the PME for your grade', detail: 'PME for grade is not a line on the JEPES worksheet, but it is tracked separately for promotion eligibility. Finish the distance program for your grade, or enroll in it, and ask what resident seats your command has.', effort: 'high', category: 'Mental', priority: 72 }));
  } else if (profile.pme_complete === 'distance') {
    out.push(rec({ id: 'pme', title: 'Complete the resident PME for your grade', detail: 'PME for grade is not a line on the JEPES worksheet, but it is tracked separately for promotion eligibility, and the resident course is the stronger record. Ask what seats your command has.', effort: 'high', category: 'Mental', priority: 72 }));
  } else if (mentalEntered && profile.pme_complete !== 'resident') {
    out.push(rec({ id: 'pme-unknown', title: 'Enter your PME status', detail: 'Vantage cannot say what PME to plan for until it knows where you stand for your grade: none yet, distance or resident.', kind: 'data', effort: 'trivial', category: 'Data', priority: 72 }));
  }
  const { total = 0, withOutcome = 0, thinAreas = [] } = activityStats;
  if (total >= 5 && withOutcome / total < 0.6) {
    out.push(rec({ id: 'outcomes', title: `Only ${Math.round((withOutcome / total) * 100)}% of your logged entries state an outcome`, detail: 'An entry without a result is a task you did, not an accomplishment. Those are the ones that get cut from a package.', kind: 'data', effort: 'low', category: 'Command', priority: 76 }));
  }
  for (const area of thinAreas) {
    out.push(rec({ id: `thin-${area}`, title: `Nothing logged under ${area}`, detail: 'Command input is marked across all three areas separately. An empty area is marked as an empty area, however strong the other two are.', kind: 'data', effort: 'low', category: 'Command', priority: 74 }));
  }
  return out.sort((a, b) => b.priority - a.priority);
}

export const EFFORT_ORDER: Record<string, number> = { trivial: 0, low: 1, medium: 2, high: 3 };
