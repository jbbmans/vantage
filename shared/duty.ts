import { PERMISSIONS } from './permissions.ts';
import { calculatePoints, describeRule, policyOn, SCORING_CONDITIONS, type ScoringCondition, type ScoringPolicyContent } from './dutyScoring.ts';

/**
 * A duty a Marine stood (VANTAGE_CLAUDE_MASTER Task 17, ADR-0023): one of the Unit Instance's duty types, from a start
 * day and time to an end day and time, in a unit. What it ran to (hours, duty days, overnight, multi-day, weekend) is
 * worked out here from its start and end, never taken from whoever records it, and its points come from the Unit
 * Instance's scoring version in force on the day it began (ADR-0012), with the same arithmetic the console's Try it
 * shows. Pure, so the form can show what the server will store before anything is sent.
 *
 * Times are the wall clock where it was stood (ADR-0018): nothing is converted between time zones, so a duty across a
 * clock change counts the hours its start and end say.
 */

/** Where a duty stands with its reviewers. Task 17 records duty as submitted; Task 18 approves, returns or rejects it. */
export const DUTY_STATUSES = ['pending', 'approved', 'returned', 'rejected'] as const;
export type DutyStatus = (typeof DUTY_STATUSES)[number];
export const DUTY_STATUS_LABELS: Record<DutyStatus, string> = { pending: 'Submitted', approved: 'Approved', returned: 'Returned', rejected: 'Rejected' };
/** A duty a reviewer has decided stays as decided: nobody edits, moves or deletes it. */
export const isDecidedDuty = (status: unknown) => status === 'approved' || status === 'rejected';

/**
 * Whether the reader may correct a duty, as the server's canEdit decides (ADR-0023 §4), so a page offers Edit only where
 * a save can succeed. Nobody corrects a decided or frozen duty. One a leader recorded for a Marine is theirs to correct
 * while they still counsel in its unit, never its Marine's. Its owner corrects their own while they serve in its unit;
 * otherwise a records manager there. `holds` says whether the reader holds a permission in a unit, and `serves` whether
 * they serve in it.
 */
export function mayCorrectDuty(
  r: { user_id: string; unit_id: string | null; recorded_by?: string | null; approval_status?: unknown; frozen_at?: string | null },
  me: string | null | undefined, holds: (permission: number, unitId: string) => boolean, serves: (unitId: string) => boolean,
): boolean {
  if (!me || r.frozen_at || isDecidedDuty(r.approval_status)) return false;
  if (r.recorded_by && r.recorded_by !== r.user_id) {
    if (r.user_id === me) return false;
    if (r.recorded_by === me && r.unit_id && holds(PERMISSIONS.COUNSEL, r.unit_id)) return true;
  }
  if (r.user_id === me) return !r.unit_id || serves(r.unit_id);
  return Boolean(r.unit_id) && holds(PERMISSIONS.MANAGE_RECORDS, r.unit_id!);
}

/** Conditions the duty's own start and end decide. */
export const DERIVED_CONDITIONS = ['weekend', 'overnight'] as const satisfies readonly ScoringCondition[];
/** Conditions only whoever records it can say, and a reviewer checks (Task 18). */
export const CLAIMED_CONDITIONS = ['holiday', 'short_notice', 'extended', 'consecutive'] as const satisfies readonly ScoringCondition[];
export type ClaimedCondition = (typeof CLAIMED_CONDITIONS)[number];
export const CONDITION_LABELS: Record<ScoringCondition, string> = Object.fromEntries(SCORING_CONDITIONS.map((c) => [c.key, c.label])) as Record<ScoringCondition, string>;
export const CONDITION_HINTS: Record<ClaimedCondition, string> = {
  holiday: 'It fell on a holiday the command observes.',
  short_notice: 'You were put on it at short notice.',
  extended: 'It was extended past its scheduled end.',
  consecutive: 'It followed straight on from another duty.',
};

/** Longer than this is not one duty: record each period. */
export const DUTY_MAX_DAYS = 30;
export const DUTY_MAX_HOURS = DUTY_MAX_DAYS * 24;

export interface DutyTimes { date?: unknown; start_time?: unknown; end_date?: unknown; end_time?: unknown }
export interface DutyFacts {
  /** Hours from start to end, to the minute. */
  hours: number;
  /** Duty days: each 24 hours or part of them, at least one. */
  days: number;
  /** It ran past midnight. */
  overnight: boolean;
  /** It ran longer than a day. */
  multi_day: boolean;
  /** Some part of it fell on a Saturday or Sunday. */
  weekend: boolean;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const dayOf = (v: unknown) => (typeof v === 'string' && DAY.test(v) ? v : null);
const timeOf = (v: unknown) => (typeof v === 'string' && TIME.test(v) ? v : null);
const minutesAt = (day: string, time: string) => Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), Number(time.slice(0, 2)), Number(time.slice(3, 5))) / 60_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
const MS_DAY = 86_400_000;

/** What a duty ran to, from its start and end; null until all four are given and the end is after the start. */
export function dutyFacts(row: DutyTimes): DutyFacts | null {
  const start = dayOf(row.date), end = dayOf(row.end_date), st = timeOf(row.start_time), et = timeOf(row.end_time);
  if (!start || !end || !st || !et) return null;
  const minutes = minutesAt(end, et) - minutesAt(start, st);
  if (!(minutes > 0)) return null;
  const hours = round2(minutes / 60);
  // A duty that ends at midnight did not stand any of the day that begins then.
  const lastDayMs = Date.parse(`${end}T00:00:00Z`) - (et === '00:00' ? MS_DAY : 0);
  const firstDayMs = Date.parse(`${start}T00:00:00Z`);
  let weekend = false;
  for (let t = firstDayMs; t <= lastDayMs && t - firstDayMs <= (DUTY_MAX_DAYS + 1) * MS_DAY; t += MS_DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) { weekend = true; break; }
  }
  return { hours, days: Math.max(1, Math.ceil(minutes / (24 * 60))), overnight: lastDayMs > firstDayMs, multi_day: minutes > 24 * 60, weekend };
}

/** The conditions a duty is scored with: what its times decide, then what was claimed for it, once each, in a fixed order. */
export function dutyConditions(facts: DutyFacts | null, claimed: readonly unknown[] | null | undefined): ScoringCondition[] {
  const said = new Set((claimed ?? []).filter((c): c is ClaimedCondition => (CLAIMED_CONDITIONS as readonly unknown[]).includes(c)));
  return SCORING_CONDITIONS.map((c) => c.key).filter((k) =>
    k === 'weekend' ? Boolean(facts?.weekend) : k === 'overnight' ? Boolean(facts?.overnight) : said.has(k as ClaimedCondition));
}

export interface DutyProblem { fieldErrors: Record<string, string>; message: string }

/**
 * What is wrong with a duty's times, by field, or null. The general timeframe rules (shared/timeframe.ts) are checked as
 * well; these are duty's own: it has a start and an end, each with a time, it lasts, it is not longer than one duty
 * can be, and it has been stood (its end is today or earlier, in the deployment's zone).
 */
export function dutyProblems(row: DutyTimes, today: string): DutyProblem | null {
  const errors: Record<string, string> = {};
  let message = '';
  const add = (field: string, text: string, summary: string) => { if (!errors[field]) errors[field] = text; if (!message) message = summary; };
  if (!dayOf(row.date)) add('date', 'Required.', 'Give the day the duty began.');
  if (!timeOf(row.start_time)) add('start_time', 'Required.', 'Give the time the duty began.');
  if (!dayOf(row.end_date)) add('end_date', 'Required.', 'Give the day the duty ended.');
  if (!timeOf(row.end_time)) add('end_time', 'Required.', 'Give the time the duty ended.');
  if (message) return { fieldErrors: errors, message };
  const start = row.date as string, end = row.end_date as string;
  const minutes = minutesAt(end, row.end_time as string) - minutesAt(start, row.start_time as string);
  if (minutes <= 0) add(end === start ? 'end_time' : 'end_date', 'After the start. If it ran past midnight, set the end date to the next day.', 'A duty ends after it begins.');
  else if (minutes > DUTY_MAX_HOURS * 60) add('end_date', `At most ${DUTY_MAX_DAYS} days after the start.`, `A duty runs ${DUTY_MAX_DAYS} days at most. Record a longer period as one duty for each part of it.`);
  if (end > today) add('end_date', 'Today or earlier.', 'Duty is recorded once it has been stood. Record it on or after the day it ends.');
  return message ? { fieldErrors: errors, message } : null;
}

/** A scoring version as a duty is scored under it. */
export interface DutyScoringVersion extends ScoringPolicyContent { id: string; version: number; effective_from: string; withdrawn_at: string | null }

/** How a duty's points were worked out, kept with it so its score can be explained after the version is superseded. */
export interface DutyScoringBasis {
  /** The day the version was chosen by: the duty's first day. */
  day: string;
  version: number | null;
  effective_from: string | null;
  /** The rule for its type, in words; null when the version does not score the type, or there was no version. */
  rule: string | null;
  base: number;
  factor: number;
  /** The conditions whose multipliers applied. */
  applied: ScoringCondition[];
  hours: number;
  days: number;
  conditions: ScoringCondition[];
  /** Why it has no points, when it has none to give. */
  reason: 'no_version' | 'type_not_scored' | null;
}

export interface DutyScore { policy_id: string | null; version: number | null; points: number | null; basis: DutyScoringBasis }

/**
 * The points a duty earns: under the version in force on the day it began, its type's rule and its conditions'
 * multipliers. With no version in force it has no points (null); a version that does not score its type gives none (0).
 */
export function scoreDuty(versions: readonly DutyScoringVersion[], duty: { duty_type_id: string; date: string; facts: DutyFacts; conditions: ScoringCondition[] }): DutyScore {
  const version = policyOn(versions, duty.date);
  const common = { day: duty.date, hours: duty.facts.hours, days: duty.facts.days, conditions: duty.conditions };
  if (!version) return { policy_id: null, version: null, points: null, basis: { ...common, version: null, effective_from: null, rule: null, base: 0, factor: 1, applied: [], reason: 'no_version' } };
  const result = calculatePoints(version, { duty_type_id: duty.duty_type_id, hours: duty.facts.hours, days: duty.facts.days, conditions: duty.conditions });
  return {
    policy_id: version.id, version: version.version, points: result.points,
    basis: { ...common, version: version.version, effective_from: version.effective_from, rule: result.rule ? describeRule(result.rule) : null, base: result.base, factor: result.factor, applied: result.applied, reason: result.rule ? null : 'type_not_scored' },
  };
}

/** "24 h", "7.5 h": a duty's length as the lists show it. */
export const formatHours = (hours: number | null | undefined) => (hours == null ? '' : `${Number.isInteger(hours) ? hours : hours.toFixed(2).replace(/0$/, '')} h`);

/** A score in words: "3 points (version 2)", "No points: version 2 does not score this type", "No scoring version in force". */
export function describeScore(points: number | null | undefined, basis: Partial<DutyScoringBasis> | null | undefined): string {
  if (!basis || basis.reason === 'no_version' || basis.version == null) return 'No scoring version was in force on its day';
  if (basis.reason === 'type_not_scored') return `No points: version ${basis.version} does not score this duty type`;
  const pts = Number(points ?? 0);
  return `${pts} ${pts === 1 ? 'point' : 'points'} under version ${basis.version}`;
}

/** Words that mark an Activity as a duty its owner stood, for the "move it to Duty" suggestions (ADR-0023). */
const DUTY_WORDS = /\b(?:dnco|adnco|sdnco|ood|officer of the day|staff duty|duty nco|duty officer|barracks duty|command duty|saf|squad on duty|color guard|colou?r guard|funeral detail|range support|range safety|working party|event support|fire watch|guard duty|duty)\b/i;
/** Organizing, scheduling or writing up duty for others is work, and stays an Activity. */
const OTHERS_DUTY = /\b(?:scheduled|scheduling|built|building|drafted|drafting|published|publishing|managed|managing|coordinated|coordinating|tracked|tracking|assigned|assigning)\b[^.]*\b(?:roster|duty|watch bill|schedule)\b|\bduty (?:roster|schedule|bill)\b/i;

/** Whether an Activity reads like duty its owner stood. */
export const readsLikeDuty = (text: string | null | undefined) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return Boolean(t) && DUTY_WORDS.test(t) && !OTHERS_DUTY.test(t);
};

/**
 * What an Activity carries to Duty when its owner moves it (ADR-0023): its title, its days and times (one day when it
 * named no end), and what it said in its result and notes. Its type, and any time it did not give, are its owner's to add.
 */
export function dutyFromActivity(row: Record<string, unknown>): Record<string, unknown> {
  const text = [row.result, row.notes].map((v) => String(v ?? '').trim()).filter(Boolean).join('\n\n');
  return {
    title: row.title ? String(row.title).slice(0, 200) : null,
    date: row.date ?? null, end_date: row.end_date ?? row.date ?? null, start_time: row.start_time ?? null, end_time: row.end_time ?? null,
    notes: text ? text.slice(0, 4000) : null,
  };
}

/** GET /api/record/duty/options: what the duty form records with, for the caller or a Marine they may record for. */
export interface DutyOptionsResponse {
  /** Today in the deployment's zone: duty ends on it or before. */
  today: string;
  /** The units duty may be recorded for, the caller's home unit first. */
  units: Array<{ id: string; name: string; org_id: string | null }>;
  /** Each Unit Instance's duty types in use. */
  types: Array<{ id: string; org_id: string; code: string; name: string; description: string | null }>;
  /** Each Unit Instance's published scoring versions, so the form shows the points the server will work out. */
  versions: Array<DutyScoringVersion & { org_id: string }>;
  claimable: readonly ClaimedCondition[];
}

/** An Activity that reads like duty its owner stood, offered to move to Duty (GET /api/record/duty/candidates). */
export interface DutyCandidate { id: string; title: string; date: string | null; end_date: string | null; start_time: string | null; end_time: string | null; unit_id: string | null; notes: string | null; version: number }
export interface DutyCandidatesResponse { candidates: DutyCandidate[]; total: number }
