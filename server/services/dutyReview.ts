import { z } from 'zod';
import type { AppContext, SessionUser } from '../context.ts';
import { scopeFor } from '../authz/scope.ts';
import { canRead, dutyReviewAuthority, dutyReviewUnits, recordedByOther, type RecordRow } from '../authz/records.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { parse } from '../lib/http.ts';
import { newId, now } from '../lib/ids.ts';
import { REDACTED } from '../../shared/constants.ts';
import { DUTY_STATUS_LABELS, type DutyStatus } from '../../shared/duty.ts';
import {
  DUTY_REVIEW_ACTIONS, DUTY_REVIEW_LIMITS, overridePoints,
  type DutyReviewAction, type DutyReviewEntry, type DutyReviewEvent, type DutyReviewQueueResponse,
} from '../../shared/dutyReview.ts';
import { audit, auditListedRecords } from './audit.ts';
import { notify } from './notifications.ts';
import { isAnonymizedDuty, withDutyNames } from './duties.ts';

/**
 * Reviewing duty (Task 18, ADR-0024): a duty is submitted, waits for review, and is approved, returned or rejected. Only
 * approved duty counts, at its approved points. This is what decides a duty and what keeps the history of it; who may do
 * what is one rule (shared/dutyReview.ts dutyReviewOptions over server/authz/records.ts dutyReviewAuthority), enforced
 * here and sent with every duty a reader is given.
 *
 * A decision never rescores: approval takes the points the duty was scored when it was recorded or last corrected, under
 * the version in force on its first day (ADR-0023), and freezes them as its approved points. A later scoring version
 * changes neither.
 */

type Row = Record<string, unknown>;
type DutyRow = Row & RecordRow & { approval_status: string; version: number; date: string; duty_type_id: string; calculated_points: number | null; approved_points: number | null; scoring_version: number | null; reviewed_by: string | null; points_overridden_at: string | null; deleted_at: string | null };

const round2 = (n: number) => Math.round(n * 100) / 100;
const points = (n: number | null | undefined) => (n == null ? 'none' : String(round2(n)));

const reviewBody = z.object({
  action: z.enum(DUTY_REVIEW_ACTIONS, { error: 'Choose what to do with this duty.' }),
  reason: z.string().trim().max(DUTY_REVIEW_LIMITS.reason, `Keep it under ${DUTY_REVIEW_LIMITS.reason} characters.`).nullish(),
  points: z.union([z.number(), z.string().max(20)]).nullish(),
  // What the reviewer saw: a decision is for the duty as it stood, never for one that changed since.
  version: z.coerce.number({ error: 'Reload this duty, then decide it.' }).int().min(1),
});

const dutyRow = (ctx: AppContext, id: string) => ctx.db.prepare('SELECT * FROM duties WHERE id = ?').get(id) as DutyRow | undefined;

/** The duty as its reader is given it, with what they may do next. */
const readBack = (ctx: AppContext, user: SessionUser, id: string, reqKey: object) =>
  withDutyNames(ctx, user.id, [dutyRow(ctx, id) as Row], scopeFor(ctx, user, reqKey))[0];

/** One line of a duty's review history, written in the transaction that makes the change it records. */
export function recordDutyReview(ctx: AppContext, e: {
  duty: Pick<DutyRow, 'id' | 'user_id' | 'calculated_points' | 'scoring_version'>; unitId: string; actorId: string; event: DutyReviewEvent;
  from: DutyStatus; to: DutyStatus; reason?: string | null; approved?: number | null; override?: boolean; at: string;
}) {
  ctx.db.prepare(`INSERT INTO duty_reviews (id, duty_id, unit_id, actor_id, event, from_status, to_status, reason, calculated_points, approved_points, scoring_version, override, by_owner, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId(), e.duty.id, e.unitId, e.actorId, e.event, e.from, e.to, e.reason ?? null, e.duty.calculated_points ?? null, e.to === 'approved' ? e.approved ?? null : null,
      e.duty.scoring_version ?? null, e.override ? 1 : 0, e.duty.user_id === e.actorId ? 1 : 0, e.at);
}

const typeName = (ctx: AppContext, row: DutyRow) => (ctx.db.prepare('SELECT name FROM duty_types WHERE id = ?').get(row.duty_type_id) as { name: string } | undefined)?.name ?? 'Duty';

/**
 * Tells the people a decision concerns: the duty's Marine, whoever recorded it for them, and the reviewer whose decision
 * was answered or undone. By the duty's type and day, never its words or the reason given (those are read on the duty,
 * by whoever may open it). Someone who can no longer open the duty is not told about it.
 */
function tell(ctx: AppContext, actor: SessionUser, row: DutyRow, event: DutyReviewEvent, extra: { approved?: number | null; version: number }) {
  const who = `${actor.first_name} ${actor.last_name}`;
  const what = `${typeName(ctx, row)} on ${row.date}`;
  const url = `/record/duty?open=${row.id}`;
  const key = (to: string) => `duty:${row.id}:${event}:${extra.version}:${to}`;
  const reads = (id: string) => id === row.user_id || canRead(scopeFor(ctx, { id }), id, row);
  const send = (id: string | null | undefined, title: string, message: string) => {
    if (!id || id === actor.id || !reads(id)) return;
    notify(ctx, id, { kind: 'duty', title, message, actionUrl: url, dedupeKey: key(id) });
  };
  const marine = row.user_id;
  const recorder = recordedByOther(row) ? row.recorded_by : null;
  const previous = row.reviewed_by && row.reviewed_by !== marine && row.reviewed_by !== recorder ? row.reviewed_by : null;
  if (event === 'approved') {
    const counted = extra.approved != null ? ` for ${points(extra.approved)} points` : '';
    send(marine, 'Duty approved', `${who} approved ${what}${counted}.`);
    send(recorder, 'Duty you recorded was approved', `${who} approved ${what}${counted}.`);
  } else if (event === 'returned') {
    send(marine, 'Duty returned for correction', `${who} returned ${what}. Open it to see why${recorder ? '' : ', correct it and send it back for review'}.`);
    send(recorder, 'Duty you recorded was returned', `${who} returned ${what}. Open it to see why, correct it and send it back for review.`);
  } else if (event === 'rejected') {
    send(marine, 'Duty rejected', `${who} rejected ${what}. Open it to see why.`);
    send(recorder, 'Duty you recorded was rejected', `${who} rejected ${what}. Open it to see why.`);
  } else if (event === 'resubmitted') {
    send(row.reviewed_by, 'Duty sent back for review', `${who} sent ${what} back for review after you returned it.`);
  } else if (event === 'reopened') {
    send(marine, 'Duty reopened for review', `${who} reopened ${what}. It waits for review again${row.approval_status === 'approved' ? ' and does not count until it is approved' : ''}.`);
    send(recorder, 'Duty you recorded was reopened', `${who} reopened ${what}. It waits for review again.`);
    send(previous, 'A duty you decided was reopened', `${who} reopened ${what}. It waits for review again.`);
  } else if (event === 'points_changed') {
    send(marine, 'Approved duty points changed', `${who} changed the approved points for ${what} to ${points(extra.approved)}. Open it to see why.`);
    send(previous, 'Points changed on a duty you approved', `${who} changed the approved points for ${what} to ${points(extra.approved)}.`);
  }
}

const OWN_REFUSALS: Record<Exclude<DutyReviewAction, 'approve' | 'resubmit'>, string> = {
  return: 'You cannot return your own duty. Another reviewer decides it.',
  reject: 'You cannot reject your own duty. Another reviewer decides it.',
  reopen: 'You cannot reopen a decision on your own duty. Another reviewer does that.',
  change_points: 'You cannot change the approved points of your own duty. Someone else with that authority does.',
};

/**
 * Decides a duty, or sends it back for review (POST /api/records/duties/:id/review). Authority is checked before the
 * duty's state, so a refusal tells someone without it nothing they could not already read. The change, its line of
 * history and its audit entry are written together or not at all, against the version and status the reviewer saw.
 */
export function reviewDuty(ctx: AppContext, user: SessionUser, id: string, body: unknown, reqKey: object, ip?: string) {
  const input = parse(reviewBody, body);
  const row = dutyRow(ctx, id);
  if (!row || row.deleted_at) throw notFound('No such record.');
  const scope = scopeFor(ctx, user, reqKey);
  if (!canRead(scope, user.id, row)) throw forbidden('You cannot open that record.');
  if (isAnonymizedDuty(row as Row)) throw forbidden('This duty was anonymized under a retention schedule. It stays as it was decided.', 'duty_anonymized');

  const { action } = input;
  const own = row.user_id === user.id;
  const authority = dutyReviewAuthority(scope, user.id, row);
  const status = row.approval_status as DutyStatus;
  const reason = input.reason?.trim() || null;
  const calculated = row.calculated_points == null ? null : round2(Number(row.calculated_points));
  const asked = input.points == null || input.points === '' ? null : overridePoints(input.points);
  if (input.points != null && input.points !== '' && asked == null) {
    throw badRequest(`Points are a number from 0 to ${DUTY_REVIEW_LIMITS.points.toLocaleString('en-US')}.`, { fieldErrors: { points: `A number from 0 to ${DUTY_REVIEW_LIMITS.points.toLocaleString('en-US')}.` } });
  }
  // Points other than the ones the scoring gave are an override, whoever asks and whenever.
  const differs = asked != null && asked !== calculated;

  // 1. Authority.
  if (action === 'approve') {
    if (own) {
      if (!authority.ownApproval) throw forbidden('You cannot approve your own duty. That takes a role that names Approve own duty, which someone else grants. Otherwise another reviewer decides it.', 'duty_own_review');
      if (row.frozen_at) throw forbidden('This duty is frozen because you left its unit. Its reviewers decide it.', 'duty_frozen');
      if (differs) throw forbidden('Your own duty is approved at the points the scoring gives. Someone else with the authority sets other points.', 'duty_own_review');
    } else {
      if (!authority.review) throw forbidden('You cannot review duty in that unit.', 'duty_review_forbidden');
      if (differs && !authority.override) throw forbidden('Approving duty at points other than the scoring gives takes the Override duty points permission in that unit.', 'duty_override_forbidden');
    }
  } else if (action === 'resubmit') {
    if (!authority.correct) throw forbidden(row.frozen_at ? 'That record is frozen because the author left the unit.' : 'That duty is not yours to send back for review.', row.frozen_at ? 'duty_frozen' : 'duty_review_forbidden');
  } else {
    if (own) throw forbidden(OWN_REFUSALS[action], 'duty_own_review');
    if (action === 'change_points' ? !authority.override : !authority.review) {
      throw forbidden(action === 'change_points' ? 'Changing approved points takes the Override duty points permission in that unit.' : 'You cannot review duty in that unit.', action === 'change_points' ? 'duty_override_forbidden' : 'duty_review_forbidden');
    }
  }

  // 2. The duty as the reviewer saw it, and where it stands.
  const current = () => readBack(ctx, user, id, reqKey);
  if (Number(row.version) !== input.version) throw conflict('This duty changed while you were deciding it. Reload to see the latest version.', 'stale', { current: current() });
  const standing = DUTY_STATUS_LABELS[status]?.toLowerCase() ?? status;
  const needs = (ok: boolean, message: string, code: string) => { if (!ok) throw conflict(message, code, { current: current() }); };
  if (action === 'approve' || action === 'return' || action === 'reject') needs(status === 'pending', `This duty is ${standing}, not waiting for review.`, 'duty_not_pending');
  if (action === 'resubmit') needs(status === 'returned', `This duty is ${standing}. Only a returned duty is sent back for review.`, 'duty_not_returned');
  if (action === 'reopen') needs(status !== 'pending', 'This duty is already waiting for review.', 'duty_not_decided');
  if (action === 'change_points') needs(status === 'approved', `This duty is ${standing}. Only an approved duty has approved points to change.`, 'duty_not_approved');
  if (action === 'return' && row.frozen_at) throw forbidden('This duty is frozen because its Marine left the unit, so nobody could correct it. Approve it or reject it.', 'duty_frozen');

  // 3. What was asked.
  const needsReason = action === 'return' || action === 'reject' || action === 'reopen' || action === 'change_points' || (action === 'approve' && differs);
  if (needsReason && !reason) {
    const why = action === 'approve' || action === 'change_points' ? 'Say why these points differ from what the scoring gives. The reason is kept with the duty.' : 'Say why. The reason is kept with the duty and its Marine reads it.';
    throw badRequest(why, { fieldErrors: { reason: 'Required.' } });
  }
  if (action === 'change_points') {
    if (asked == null) throw badRequest('Enter the approved points.', { fieldErrors: { points: 'Required.' } });
    const now_ = row.approved_points == null ? null : round2(Number(row.approved_points));
    if (asked === now_ && differs === Boolean(row.points_overridden_at)) throw badRequest('Those are already its approved points.', { fieldErrors: { points: 'Already its approved points.' } });
  }

  // 4. The change.
  const at = now();
  const event: DutyReviewEvent = action === 'approve' ? 'approved' : action === 'return' ? 'returned' : action === 'reject' ? 'rejected' : action === 'resubmit' ? 'resubmitted' : action === 'reopen' ? 'reopened' : 'points_changed';
  const to: DutyStatus = action === 'approve' || action === 'change_points' ? 'approved' : action === 'return' ? 'returned' : action === 'reject' ? 'rejected' : 'pending';
  // Which event this is, as flags: the audit entry below names its action from them, each spelled out for the catalogue's scan.
  const is = { approved: event === 'approved', returned: event === 'returned', rejected: event === 'rejected', resubmitted: event === 'resubmitted', reopened: event === 'reopened' };
  const override = (action === 'approve' || action === 'change_points') && differs;
  const approved = to === 'approved' ? (override ? asked : calculated) : null;
  const sets: string[] = ['approval_status = ?', 'approved_points = ?', 'updated_at = ?', 'version = version + 1'];
  const vals: unknown[] = [to, approved, at];
  if (to === 'approved') {
    sets.push('points_override_reason = ?', 'points_overridden_by = ?', 'points_overridden_at = ?');
    vals.push(override ? reason : null, override ? user.id : null, override ? at : null);
  } else {
    sets.push('points_override_reason = NULL', 'points_overridden_by = NULL', 'points_overridden_at = NULL');
  }
  if (action === 'approve') { sets.push('reviewed_by = ?', 'reviewed_at = ?', 'review_reason = ?'); vals.push(user.id, at, override ? null : reason); }
  if (action === 'return' || action === 'reject') { sets.push('reviewed_by = ?', 'reviewed_at = ?', 'review_reason = ?'); vals.push(user.id, at, reason); }
  if (action === 'resubmit' || action === 'reopen') sets.push('reviewed_by = NULL', 'reviewed_at = NULL', 'review_reason = NULL');
  if (action === 'resubmit') { sets.push('submitted_at = ?'); vals.push(at); }

  ctx.db.transaction(() => {
    const changed = ctx.db.prepare(`UPDATE duties SET ${sets.join(', ')} WHERE id = ? AND version = ? AND approval_status = ? AND deleted_at IS NULL`).run(...vals, id, input.version, status).changes;
    if (!changed) throw conflict('This duty changed while you were deciding it. Reload to see the latest version.', 'stale', { current: current() });
    recordDutyReview(ctx, { duty: row, unitId: String(row.unit_id), actorId: user.id, event, from: status, to, reason, approved, override, at });
    const detail = event === 'approved' ? `calculated ${points(calculated)}; approved ${points(approved)}${override ? ' (override, reason given)' : ''}; scoring version ${row.scoring_version ?? 'none'}${own ? '; own duty, by self-approval authority' : ''}`
      : event === 'points_changed' ? `calculated ${points(calculated)}; approved ${points(row.approved_points)} to ${points(approved)}${override ? ' (override, reason given)' : ' (override withdrawn, reason given)'}`
        : event === 'reopened' ? `was ${status}${status === 'approved' ? `; approved points ${points(row.approved_points)} withdrawn` : ''}; reason given`
          : event === 'resubmitted' ? `after a return${reason ? '; note given' : ''}`
            : 'reason given';
    audit(ctx, { actor_id: user.id, action: is.approved ? 'duty_approved' : is.returned ? 'duty_returned' : is.rejected ? 'duty_rejected' : is.resubmitted ? 'duty_resubmitted' : is.reopened ? 'duty_reopened' : 'duty_points_changed', entity: 'duties', entity_id: id, subject_id: own ? null : row.user_id, unit_id: row.unit_id, detail, ip });
  })();
  tell(ctx, user, row, event, { approved, version: input.version });
  return current();
}

/**
 * A returned duty that is corrected goes back for review with the correction (ADR-0024 §3): the columns the update that
 * corrects it also sets, and the line of history and audit entry written with it. Called by the record update, inside
 * its transaction, for whoever may correct the duty.
 */
export const RESUBMIT_SETS = ["approval_status = 'pending'", 'reviewed_by = NULL', 'reviewed_at = NULL', 'review_reason = NULL', 'submitted_at = ?'] as const;
export function resubmittedByCorrection(ctx: AppContext, user: SessionUser, before: Row & RecordRow, unitId: string, at: string, ip?: string) {
  // `before` is the duty as it was returned: its reviewer, who is told, is no longer on the row. Its score is read back
  // from the row the correction just wrote, because a correction to its times, type, conditions or unit scores it again
  // (ADR-0023 §3) and the line of history says what it waits at now.
  const row = before as DutyRow;
  const scored = dutyRow(ctx, String(row.id)) ?? row;
  recordDutyReview(ctx, { duty: { id: row.id, user_id: row.user_id, calculated_points: scored.calculated_points, scoring_version: scored.scoring_version }, unitId, actorId: user.id, event: 'resubmitted', from: 'returned', to: 'pending', at });
  audit(ctx, { actor_id: user.id, action: 'duty_resubmitted', entity: 'duties', entity_id: row.id, subject_id: row.user_id === user.id ? null : row.user_id, unit_id: unitId, detail: 'after a return; corrected', ip });
  return () => tell(ctx, user, row, 'resubmitted', { version: Number(row.version) });
}

/**
 * A duty's review history, oldest first, for whoever may read the duty (GET /api/records/duties/:id/reviews). People by
 * rank and name, except the reader, and nobody on a duty a retention schedule anonymized (ADR-0023 §8), whose reasons
 * went with its words.
 */
export function dutyReviewHistory(ctx: AppContext, user: SessionUser, id: string, reqKey: object, ip?: string): { reviews: DutyReviewEntry[] } {
  const row = dutyRow(ctx, id);
  if (!row || (row.deleted_at && row.user_id !== user.id)) throw notFound('No such record.');
  if (!canRead(scopeFor(ctx, user, reqKey), user.id, row)) throw forbidden('You cannot open that record.');
  const rows = ctx.db.prepare(`SELECT v.*, u.last_name, r.abbr FROM duty_reviews v LEFT JOIN users u ON u.id = v.actor_id LEFT JOIN ranks r ON r.id = u.rank_id
                               WHERE v.duty_id = ? ORDER BY v.created_at, v.rowid`).all(id) as Array<Row & { last_name: string | null; abbr: string | null }>;
  const hidden = isAnonymizedDuty(row as Row);
  if (row.user_id !== user.id && rows.length) audit(ctx, { actor_id: user.id, action: 'view_record', entity: 'duties', entity_id: id, subject_id: row.user_id, unit_id: row.unit_id, detail: 'review history', ip });
  return {
    reviews: rows.map((v) => ({
      id: String(v.id), event: v.event as DutyReviewEvent, at: String(v.created_at),
      ...(!hidden && v.actor_id !== user.id && v.last_name ? { actor_name: `${v.abbr ? `${v.abbr} ` : ''}${v.last_name}` } : {}),
      by_me: v.actor_id === user.id, by_owner: v.by_owner === 1,
      reason: hidden && v.reason != null ? REDACTED : (v.reason as string | null) ?? null,
      calculated_points: (v.calculated_points as number | null) ?? null, approved_points: (v.approved_points as number | null) ?? null,
      scoring_version: (v.scoring_version as number | null) ?? null, override: v.override === 1,
    })),
  };
}

const QUEUE_LIMIT = 200;

/**
 * Duty waiting for the caller's decision (GET /api/record/duty/review-queue): submitted duty in the units where they
 * review duty and read shared records, longest-waiting first. Never their own: that is decided by another reviewer, or
 * by them from their own list where they hold self-approval authority. Reading it is a read of those Marines' records,
 * and is audited as any list of them is.
 */
export function dutyReviewQueue(ctx: AppContext, user: SessionUser, reqKey: object, opts: { unitId?: string | null } = {}, ip?: string): DutyReviewQueueResponse<Row> {
  const scope = scopeFor(ctx, user, reqKey);
  const reviewable = dutyReviewUnits(scope);
  const units = opts.unitId ? reviewable.filter((u) => u === opts.unitId) : reviewable;
  if (!units.length) return { items: [], total: 0, units: [], reviewer: reviewable.length > 0 };
  const where = `d.deleted_at IS NULL AND d.approval_status = 'pending' AND d.user_id <> ? AND d.unit_id IN (SELECT value FROM json_each(?))
                 AND NOT (d.title IS ? OR d.notes IS ? OR d.location IS ?)`;
  const params = [user.id, JSON.stringify(units), REDACTED, REDACTED, REDACTED];
  const rows = ctx.db.prepare(`SELECT d.* FROM duties d WHERE ${where} ORDER BY d.submitted_at, d.date, d.id LIMIT ?`).all(...params, QUEUE_LIMIT) as Row[];
  const counts = ctx.db.prepare(`SELECT d.unit_id AS id, COALESCE(u.short_name, u.name) AS name, COUNT(*) AS count FROM duties d JOIN units u ON u.id = d.unit_id
                                 WHERE ${where} GROUP BY d.unit_id ORDER BY name`).all(user.id, JSON.stringify(reviewable), REDACTED, REDACTED, REDACTED) as Array<{ id: string; name: string; count: number }>;
  auditListedRecords(ctx, user.id, 'duties', rows, ip);
  const total = opts.unitId ? counts.find((c) => c.id === opts.unitId)?.count ?? 0 : counts.reduce((n, c) => n + c.count, 0);
  return { items: withDutyNames(ctx, user.id, rows, scope), total, units: counts, reviewer: true };
}
