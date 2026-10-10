import type { AppContext, SessionUser } from '../context.ts';
import { badRequest, conflict, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { zonedDay } from '../lib/clock.ts';
import { audit } from './audit.ts';
import {
  SCORING_LIMITS, policyOn, policyStatus, scoringPolicyProblems,
  type ScoringPolicy, type ScoringPolicyContent, type ScoringPolicyStatus,
} from '../../shared/dutyScoring.ts';

/**
 * A Unit Instance's duty scoring policies (Task 18 brought forward, ADR-0012). Each is published once as a version with
 * the day it takes effect and is never changed after; the database refuses a change (duty_scoring_policies_published).
 * A version that has not taken effect may be withdrawn and stays on the record. Duty is scored under the version in
 * force on its day (policyOn), so publishing a new one never rescores earlier duty.
 */

type Row = Omit<ScoringPolicy, keyof ScoringPolicyContent> & { policy: string };

/** The deployment's day: the instance has one timezone, and a policy's day is a day there. */
export const scoringToday = (ctx: AppContext) => zonedDay(ctx.config.timezone);

const round2 = (n: number) => Math.round(n * 100) / 100;

export function listScoringPolicies(ctx: AppContext, orgId: string): ScoringPolicy[] {
  const rows = ctx.db.prepare(`SELECT p.*, TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')) AS created_by_name
      FROM duty_scoring_policies p LEFT JOIN users u ON u.id = p.created_by WHERE p.org_id = ? ORDER BY p.version DESC`).all(orgId) as Row[];
  return rows.map(({ policy, ...row }) => ({ ...row, ...(JSON.parse(policy) as ScoringPolicyContent) }));
}

/** Every version with where it stands today, and the one in force. */
export function scoringOverview(ctx: AppContext, orgId: string) {
  const today = scoringToday(ctx);
  const policies = listScoringPolicies(ctx, orgId);
  return {
    today,
    current: policyOn(policies, today)?.id ?? null,
    policies: policies.map((p) => ({ ...p, status: policyStatus(policies, p, today) as ScoringPolicyStatus })),
  };
}

export interface PublishInput extends ScoringPolicyContent { effective_from: string; note: string }

/**
 * Publish a new version. It takes effect tomorrow or later, and after every version not withdrawn, so the versions run in
 * order, none reaches back over duty already stood, and each can be withdrawn before it takes effect. It scores only duty
 * types the Unit Instance has in use.
 */
export function publishScoringPolicy(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string, input: PublishInput, ip?: string): ScoringPolicy {
  const today = scoringToday(ctx);
  const note = input.note.trim();
  if (!note) throw badRequest('Say why the scoring changes.', { fieldErrors: { note: 'Required.' } });
  if (note.length > SCORING_LIMITS.note) throw badRequest(`Keep the reason under ${SCORING_LIMITS.note} characters.`, { fieldErrors: { note: 'Too long.' } });
  // Tomorrow at the soonest: a version taking effect today would score duty already stood today, and could not be withdrawn.
  if (input.effective_from <= today) throw badRequest('A new version takes effect tomorrow or later; duty already stood keeps the points of its day.', { fieldErrors: { effective_from: 'Tomorrow or later.' } });
  const content: ScoringPolicyContent = {
    rules: input.rules.map((r) => (r.method === 'bands'
      ? { duty_type_id: r.duty_type_id, method: r.method, points: null, bands: (r.bands ?? []).map((b) => ({ from_hours: round2(b.from_hours), points: round2(b.points) })) }
      : { duty_type_id: r.duty_type_id, method: r.method, points: r.points == null ? null : round2(r.points), bands: null })),
    multipliers: input.multipliers.map((m) => ({ condition: m.condition, factor: round2(m.factor) })),
    combine: input.combine,
  };
  const dutyTypes = new Map((ctx.db.prepare('SELECT id, name FROM duty_types WHERE org_id = ? AND active = 1').all(orgId) as Array<{ id: string; name: string }>).map((d) => [d.id, d.name]));
  const problems = scoringPolicyProblems(content, dutyTypes);
  if (problems.length) throw badRequest(problems[0], { problems });
  return ctx.db.transaction(() => {
    const latest = ctx.db.prepare('SELECT MAX(effective_from) AS day FROM duty_scoring_policies WHERE org_id = ? AND withdrawn_at IS NULL').get(orgId) as { day: string | null };
    if (latest.day && input.effective_from <= latest.day) {
      throw conflict(`The latest version takes effect ${latest.day}. A new one takes effect after it; to replace a version that has not taken effect, withdraw it first.`, 'scoring_order');
    }
    const version = ((ctx.db.prepare('SELECT MAX(version) AS v FROM duty_scoring_policies WHERE org_id = ?').get(orgId) as { v: number | null }).v ?? 0) + 1;
    const id = newId();
    ctx.db.prepare('INSERT INTO duty_scoring_policies (id, org_id, version, effective_from, policy, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, orgId, version, input.effective_from, JSON.stringify(content), note, actor.id, now());
    audit(ctx, {
      actor_id: actor.id, action: 'duty_scoring_policy_published', entity: 'duty_scoring_policies', entity_id: id, org_id: orgId,
      detail: `version ${version} from ${input.effective_from}: ${content.rules.length} duty types scored, ${content.multipliers.length} multipliers (${content.combine}); ${note}`, ip,
    });
    return listScoringPolicies(ctx, orgId).find((p) => p.id === id)!;
  })();
}

/** Withdraw a version before it takes effect. One in force, or that was, is history and stays. */
export function withdrawScoringPolicy(ctx: AppContext, actor: Pick<SessionUser, 'id'>, orgId: string, id: string, ip?: string): ScoringPolicy {
  const row = ctx.db.prepare('SELECT * FROM duty_scoring_policies WHERE id = ? AND org_id = ?').get(id, orgId) as Row | undefined;
  if (!row) throw notFound('No such duty scoring policy in this Unit Instance.');
  if (row.withdrawn_at) throw conflict('That version is already withdrawn.', 'withdrawn');
  if (row.effective_from <= scoringToday(ctx)) throw conflict('That version has taken effect. Publish a new version instead; duty already stood keeps the points of its day.', 'in_force');
  ctx.db.prepare('UPDATE duty_scoring_policies SET withdrawn_at = ?, withdrawn_by = ? WHERE id = ?').run(now(), actor.id, id);
  audit(ctx, { actor_id: actor.id, action: 'duty_scoring_policy_withdrawn', entity: 'duty_scoring_policies', entity_id: id, org_id: orgId, detail: `version ${row.version}, which was to take effect ${row.effective_from}`, ip });
  return listScoringPolicies(ctx, orgId).find((p) => p.id === id)!;
}
