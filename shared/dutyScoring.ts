/**
 * Duty scoring policies (VANTAGE_CLAUDE_MASTER §13, Task 18; ADR-0012): how many points a Unit Instance gives each kind
 * of duty. A policy is published as a version with the day it takes effect, and never changed after: a duty is scored
 * under the version in force on the day it was stood, so a later version never recalculates earlier duty.
 *
 * Pure, so the console can show what a draft would give before it is published, and duty records (Task 17) score with
 * the same arithmetic the console showed.
 */

export const SCORING_METHODS = [
  { key: 'fixed', label: 'Fixed', hint: 'points for each duty' },
  { key: 'per_day', label: 'Per day', hint: 'points for each duty day' },
  { key: 'per_hour', label: 'Per hour', hint: 'points for each hour' },
  { key: 'bands', label: 'By length', hint: 'points by how many hours it ran' },
] as const;
export type ScoringMethod = (typeof SCORING_METHODS)[number]['key'];

export const SCORING_CONDITIONS = [
  { key: 'weekend', label: 'Weekend' },
  { key: 'holiday', label: 'Holiday' },
  { key: 'overnight', label: 'Overnight' },
  { key: 'short_notice', label: 'Short notice' },
  { key: 'extended', label: 'Extended duty' },
  { key: 'consecutive', label: 'Consecutive duty' },
] as const;
export type ScoringCondition = (typeof SCORING_CONDITIONS)[number]['key'];

/** How several conditions on one duty combine: the largest multiplier, or all of them multiplied together. */
export const SCORING_COMBINE = [
  { key: 'highest', label: 'The highest one' },
  { key: 'multiply', label: 'All of them, multiplied' },
] as const;
export type ScoringCombine = (typeof SCORING_COMBINE)[number]['key'];

/** The bounds Vantage sets on every Unit Instance's policy. */
export const SCORING_LIMITS = {
  points: { min: 0, max: 100 },
  factor: { min: 1, max: 5 },
  bandHours: { min: 0, max: 168 },
  bands: 12,
  rules: 200,
  note: 300,
} as const;

export interface ScoringBand { from_hours: number; points: number }
export interface ScoringRule { duty_type_id: string; method: ScoringMethod; points: number | null; bands: ScoringBand[] | null }
export interface ScoringMultiplier { condition: ScoringCondition; factor: number }
export interface ScoringPolicyContent { rules: ScoringRule[]; multipliers: ScoringMultiplier[]; combine: ScoringCombine }

export interface ScoringPolicy extends ScoringPolicyContent {
  id: string; org_id: string; version: number; effective_from: string; note: string;
  created_by: string | null; created_by_name?: string | null; created_at: string;
  withdrawn_at: string | null; withdrawn_by: string | null;
}
export type ScoringPolicyStatus = 'in_force' | 'scheduled' | 'superseded' | 'withdrawn';

/** One duty as scoring needs it. Task 17's records derive hours and days from their start and end. */
export interface DutyForScoring { duty_type_id: string; hours: number; days: number; conditions: readonly ScoringCondition[] }
export interface PointsResult { rule: ScoringRule | null; base: number; factor: number; applied: ScoringCondition[]; points: number }

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The points one duty earns under one policy: the rule for its type, then its conditions' multipliers. */
export function calculatePoints(policy: ScoringPolicyContent, duty: DutyForScoring): PointsResult {
  const rule = policy.rules.find((r) => r.duty_type_id === duty.duty_type_id) ?? null;
  const hours = Math.max(0, Number(duty.hours) || 0);
  const days = Math.max(0, Number(duty.days) || 0);
  let base = 0;
  if (rule?.method === 'fixed') base = rule.points ?? 0;
  else if (rule?.method === 'per_day') base = (rule.points ?? 0) * days;
  else if (rule?.method === 'per_hour') base = (rule.points ?? 0) * hours;
  else if (rule?.method === 'bands') base = [...(rule.bands ?? [])].sort((a, b) => a.from_hours - b.from_hours).filter((b) => hours >= b.from_hours).at(-1)?.points ?? 0;
  const applied = policy.multipliers.filter((m) => duty.conditions.includes(m.condition));
  const factor = !applied.length ? 1 : policy.combine === 'multiply' ? applied.reduce((f, m) => f * m.factor, 1) : Math.max(...applied.map((m) => m.factor));
  return { rule, base: round2(base), factor: round2(factor), applied: applied.map((m) => m.condition), points: rule ? round2(base * factor) : 0 };
}

/** The version in force on a day: the latest one taking effect on or before it that was not withdrawn. */
export function policyOn<T extends { effective_from: string; withdrawn_at: string | null }>(policies: readonly T[], day: string): T | null {
  return policies.filter((p) => !p.withdrawn_at && p.effective_from <= day).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0] ?? null;
}

/** Where each version stands on a day. */
export function policyStatus(policies: readonly ScoringPolicy[], policy: ScoringPolicy, day: string): ScoringPolicyStatus {
  if (policy.withdrawn_at) return 'withdrawn';
  if (policy.effective_from > day) return 'scheduled';
  return policyOn(policies, day)?.id === policy.id ? 'in_force' : 'superseded';
}

const inRange = (n: unknown, { min, max }: { min: number; max: number }) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;

/**
 * What is wrong with a policy, in words a Unit Manager can act on; none when it may be published. `dutyTypes` are the
 * Unit Instance's duty types in use, by id, with their names for the messages.
 */
export function scoringPolicyProblems(content: ScoringPolicyContent, dutyTypes: ReadonlyMap<string, string>): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const { points, factor, bandHours, bands } = SCORING_LIMITS;
  if (!content.rules.length) problems.push('Score at least one duty type.');
  if (content.rules.length > SCORING_LIMITS.rules) problems.push(`A policy scores ${SCORING_LIMITS.rules} duty types at most.`);
  for (const rule of content.rules) {
    const name = dutyTypes.get(rule.duty_type_id);
    if (!name) { problems.push('A rule names a duty type this Unit Instance does not have in use.'); continue; }
    if (seen.has(rule.duty_type_id)) problems.push(`${name} has more than one rule.`);
    seen.add(rule.duty_type_id);
    if (!SCORING_METHODS.some((m) => m.key === rule.method)) { problems.push(`${name}: choose how it is scored.`); continue; }
    if (rule.method === 'bands') {
      const list = rule.bands ?? [];
      if (!list.length || list.length > bands) problems.push(`${name}: give 1 to ${bands} lengths.`);
      if (list.length && list[0].from_hours !== 0) problems.push(`${name}: the first length starts at 0 hours.`);
      list.forEach((b, i) => {
        if (!inRange(b.from_hours, bandHours)) problems.push(`${name}: a length starts between ${bandHours.min} and ${bandHours.max} hours.`);
        if (!inRange(b.points, points)) problems.push(`${name}: points are ${points.min} to ${points.max}.`);
        if (i && b.from_hours <= list[i - 1].from_hours) problems.push(`${name}: each length starts after the one before it.`);
      });
    } else if (!inRange(rule.points, points)) problems.push(`${name}: points are ${points.min} to ${points.max}.`);
  }
  const conditions = new Set<string>();
  for (const m of content.multipliers) {
    const label = SCORING_CONDITIONS.find((c) => c.key === m.condition)?.label;
    if (!label) { problems.push('A multiplier names a condition Vantage does not know.'); continue; }
    if (conditions.has(m.condition)) problems.push(`${label} has more than one multiplier.`);
    conditions.add(m.condition);
    if (!inRange(m.factor, factor)) problems.push(`Multipliers are ${factor.min} to ${factor.max}.`);
  }
  if (!SCORING_COMBINE.some((c) => c.key === content.combine)) problems.push('Choose how several multipliers combine.');
  return [...new Set(problems)];
}

/** A rule in a few words: "2 points", "3 points a day", "0.25 points an hour", "0–4h: 1, 4–8h: 2, 8h+: 3". */
export function describeRule(rule: ScoringRule): string {
  const pts = (n: number) => `${n} ${n === 1 ? 'point' : 'points'}`;
  if (rule.method === 'fixed') return pts(rule.points ?? 0);
  if (rule.method === 'per_day') return `${pts(rule.points ?? 0)} a day`;
  if (rule.method === 'per_hour') return `${pts(rule.points ?? 0)} an hour`;
  const list = [...(rule.bands ?? [])].sort((a, b) => a.from_hours - b.from_hours);
  return list.map((b, i) => `${b.from_hours}${list[i + 1] ? `–${list[i + 1].from_hours}h` : 'h+'}: ${b.points}`).join(', ');
}
