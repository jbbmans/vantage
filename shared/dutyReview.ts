import type { DutyStatus } from './duty.ts';

/**
 * Reviewing duty (VANTAGE_CLAUDE_MASTER Task 18, ADR-0024). A duty is submitted, waits for review, and is approved,
 * returned for correction or rejected. Only approved duty counts, at its approved points: the points its scoring version
 * gave it (calculated points, ADR-0023), unless someone with the authority to override them set others and said why.
 *
 * Who may do what is decided here, in one rule the server enforces and sends with each duty (`review`), so a page offers
 * exactly the decisions that will be accepted. Pure: nothing here reads the database.
 */

/** What can be asked of a duty's review. */
export const DUTY_REVIEW_ACTIONS = ['approve', 'return', 'reject', 'resubmit', 'reopen', 'change_points'] as const;
export type DutyReviewAction = (typeof DUTY_REVIEW_ACTIONS)[number];

/** What a duty's review history records: each decision, each change to its approved points, each time it went back for review. */
export const DUTY_REVIEW_EVENTS = ['approved', 'returned', 'rejected', 'resubmitted', 'reopened', 'points_changed'] as const;
export type DutyReviewEvent = (typeof DUTY_REVIEW_EVENTS)[number];
export const DUTY_REVIEW_EVENT_LABELS: Record<DutyReviewEvent, string> = {
  approved: 'Approved', returned: 'Returned for correction', rejected: 'Rejected', resubmitted: 'Submitted again', reopened: 'Reopened for review', points_changed: 'Approved points changed',
};

/**
 * The columns of a duty that hold its review: where it stands, who decided it and why, and what counts. Only a review
 * writes them, or a correction that sends a returned duty back. Never a file, and never a snapshot put back by an undo.
 */
export const DUTY_REVIEW_COLUMNS = ['approval_status', 'submitted_at', 'reviewed_by', 'reviewed_at', 'review_reason', 'approved_points', 'points_override_reason', 'points_overridden_by', 'points_overridden_at'] as const;

/** The bounds on what a reviewer writes: a reason's length, and the points an override may give. */
export const DUTY_REVIEW_LIMITS = { reason: 1000, points: 100_000 } as const;

/** What the reader holds over one duty, worked out by the server from their roles in its unit. */
export interface DutyReviewAuthority {
  /** Review duty in its unit, with View shared records there to read it. */
  review: boolean;
  /** Override duty points in its unit, with View shared records there. */
  override: boolean;
  /** A role they hold names Approve own duty in its unit: explicit self-approval authority. Leading the unit is not it. */
  ownApproval: boolean;
  /** They may correct the duty (its Marine, its recorder or a records manager; ADR-0023 §4). */
  correct: boolean;
}

/** The decisions open to the reader on one duty, as it stands. */
export interface DutyReviewOptions {
  /** Approve it at its calculated points. */
  approve: boolean;
  /** Approve it at other points, with a reason. */
  approve_with_points: boolean;
  /** Send it back to be corrected, with a reason. */
  return: boolean;
  /** Reject it, with a reason. */
  reject: boolean;
  /** Send a returned duty back for review. */
  resubmit: boolean;
  /** Take a decision back, with a reason: the duty waits for review again. */
  reopen: boolean;
  /** Change an approved duty's points, with a reason. */
  change_points: boolean;
}

export const NO_REVIEW_OPTIONS: DutyReviewOptions = { approve: false, approve_with_points: false, return: false, reject: false, resubmit: false, reopen: false, change_points: false };

interface ReviewedDuty { user_id: string; approval_status: DutyStatus | string; frozen_at?: string | null; deleted_at?: string | null }

/**
 * What the reader may do to a duty's review (ADR-0024 §3).
 *
 * - **Somebody else's duty** is decided by a reviewer: approve, return or reject it while it waits, and reopen a decision.
 *   Points other than the calculated ones take the override authority as well, at approval or after.
 * - **One's own duty** is never one's own to return, reject, reopen or give other points, whatever one holds. Approving it
 *   takes explicit self-approval authority (a role that names it; a Unit Leader has none by leading), and then only at
 *   its calculated points, and not once it is frozen: duty in a unit its Marine has left is its reviewers' to decide.
 * - **A returned duty** goes back for review at the hand of whoever may correct it.
 * - **A duty frozen when its Marine left the unit** can be approved or rejected, not returned: nobody could correct it.
 */
export function dutyReviewOptions(row: ReviewedDuty, me: string | null | undefined, a: DutyReviewAuthority): DutyReviewOptions {
  if (!me || row.deleted_at) return NO_REVIEW_OPTIONS;
  const own = row.user_id === me;
  const status = row.approval_status;
  const others = !own && a.review;
  return {
    approve: status === 'pending' && (own ? a.ownApproval && !row.frozen_at : a.review),
    approve_with_points: status === 'pending' && others && a.override,
    return: status === 'pending' && others && !row.frozen_at,
    reject: status === 'pending' && others,
    resubmit: status === 'returned' && a.correct,
    reopen: (status === 'approved' || status === 'rejected' || status === 'returned') && others,
    change_points: status === 'approved' && !own && a.override,
  };
}

/** Whether any decision is open to the reader: the duty shows its review actions. */
export const hasReviewOptions = (o: DutyReviewOptions | null | undefined) => Boolean(o && Object.values(o).some(Boolean));

/** The points a duty counts for: its approved points once approved, and nothing until then (ADR-0024 §1). */
export const countedPoints = (row: { approval_status: DutyStatus | string; approved_points?: number | null }) =>
  (row.approval_status === 'approved' ? Number(row.approved_points) || 0 : 0);

/** Whether an approved duty's points were set by someone other than the scoring: an override, which has its reason. */
export const isOverridden = (row: { approval_status: DutyStatus | string; points_overridden_at?: string | null }) =>
  row.approval_status === 'approved' && Boolean(row.points_overridden_at);

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Points as an override gives them: a number from 0 to the limit, to two places; null when it is not one. */
export function overridePoints(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > DUTY_REVIEW_LIMITS.points) return null;
  return round2(n);
}

/** One entry of a duty's review history, as a read gives it. */
export interface DutyReviewEntry {
  id: string;
  event: DutyReviewEvent;
  at: string;
  /** Who did it, by rank and name; absent on a duty a retention schedule anonymized, and for the reader's own acts. */
  actor_name?: string;
  /** The reader did it. */
  by_me: boolean;
  /** The Marine whose duty it is did it (a self-approval, a resubmission). */
  by_owner: boolean;
  reason: string | null;
  /** The points the scoring gave it when this happened, and the points it counted for after. */
  calculated_points: number | null;
  approved_points: number | null;
  scoring_version: number | null;
  /** Its approved points were set apart from the calculated ones here. */
  override: boolean;
}

/** GET /api/record/duty/review-queue: duty waiting for the reader's decision, the longest-waiting first. */
export interface DutyReviewQueueResponse<D = unknown> {
  items: D[];
  /** How many wait in all; `items` holds the first of them. */
  total: number;
  /** The units they wait in, each with its count, for a reviewer of more than one. */
  units: Array<{ id: string; name: string; count: number }>;
  /** The reader reviews duty in some unit, so the page shows them their queue even when nothing waits in it. */
  reviewer: boolean;
}
