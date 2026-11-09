import type { AppContext, SessionUser } from '../context.ts';
import { PERMISSIONS, can, detailUnitsFor, isMember, orgOfUnit, scopeFor } from '../authz/scope.ts';
import { badRequest, forbidden } from '../lib/errors.ts';
import { REDACTED } from '../../shared/constants.ts';
import {
  CLAIMED_CONDITIONS, DUTY_STATUS_LABELS, dutyConditions, dutyFacts, dutyFromActivity, dutyProblems, isDecidedDuty, readsLikeDuty, scoreDuty,
  type DutyScoringVersion, type DutyStatus,
} from '../../shared/duty.ts';
import { isDrawnFromWork } from '../../shared/recordKinds.ts';
import { listScoringPolicies, scoringToday } from './dutyScoring.ts';
import { holdState, type HoldState } from './holds.ts';
import type { RecordRow } from '../authz/records.ts';

/**
 * Duty records (Task 17, ADR-0023). The record itself goes through the record routes and server/services/records.ts
 * like every record type; this is what is duty's own: the columns worked out from its start and end and its score,
 * the choices a form offers, and the activities that read like duty for their owner to move.
 */

type Row = Record<string, unknown>;

interface DutyTypeRow { id: string; org_id: string; code: string; name: string; description: string | null; active: number }

/** What a change to means its derived columns and score are worked out again. */
const RESCORED_BY = ['date', 'start_time', 'end_date', 'end_time', 'duty_type_id', 'conditions', 'unit_id'] as const;

const versionsFor = (ctx: AppContext, orgId: string): DutyScoringVersion[] =>
  listScoringPolicies(ctx, orgId).map((p) => ({ id: p.id, version: p.version, effective_from: p.effective_from, withdrawn_at: p.withdrawn_at, rules: p.rules, multipliers: p.multipliers, combine: p.combine }));

const typeById = (ctx: AppContext, id: unknown) =>
  (typeof id === 'string' && id ? ctx.db.prepare('SELECT id, org_id, code, name, description, active FROM duty_types WHERE id = ?').get(id) : undefined) as DutyTypeRow | undefined;

const parseList = (v: unknown): unknown[] => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try { const parsed = JSON.parse(v); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};

/**
 * The conditions someone claimed, in one order. A stored duty's list also holds the weekend and overnight its times
 * give it, which a form never sends back, so only the claimed ones say whether its conditions changed.
 */
const claimedKey = (v: unknown) => JSON.stringify([...new Set(parseList(v).filter((c): c is string => typeof c === 'string' && (CLAIMED_CONDITIONS as readonly string[]).includes(c)))].sort());

/** Whether two lists of a duty's conditions claim the same: the order, and what its times give, do not count. */
export const sameClaims = (a: unknown, b: unknown) => claimedKey(a ?? []) === claimedKey(b ?? []);

/** Whether an edit changes what a duty's derived columns and score are worked out from. */
export const rescoresDuty = (row: Row, data: Row) =>
  RESCORED_BY.some((k) => data[k] !== undefined && (k === 'conditions' ? !sameClaims(data[k], row[k]) : (data[k] ?? null) !== (row[k] ?? null)));

/**
 * The columns a duty is saved with that the server works out: its length, its conditions (as a list, written as the
 * record's JSON field is) and its score, after
 * checking its times and its type. `row` is the duty as it would be saved (for an edit, the stored row with the change
 * over it); `typeChanged` asks that its type be one still in use, which an edit that keeps a since-retired type is not.
 */
export function dutyColumns(ctx: AppContext, row: Row, opts: { typeChanged: boolean }): Row {
  const problem = dutyProblems(row, scoringToday(ctx));
  if (problem) throw badRequest(problem.message, { fieldErrors: problem.fieldErrors });
  const unitOrg = orgOfUnit(ctx, row.unit_id as string | null);
  const type = typeById(ctx, row.duty_type_id);
  // A type of another Unit Instance is answered as one that is not there: nobody learns of another instance's types.
  if (!type || !unitOrg || type.org_id !== unitOrg) throw badRequest('Choose one of this unit’s duty types.', { fieldErrors: { duty_type_id: 'Not one of this unit’s duty types.' } });
  if (opts.typeChanged && !type.active) throw badRequest(`${type.name} is retired. Choose a duty type in use.`, { fieldErrors: { duty_type_id: 'Retired.' } });
  const facts = dutyFacts(row)!;
  const conditions = dutyConditions(facts, parseList(row.conditions));
  const score = scoreDuty(versionsFor(ctx, unitOrg), { duty_type_id: type.id, date: String(row.date), facts, conditions });
  return {
    hours: facts.hours, days: facts.days, overnight: facts.overnight ? 1 : 0, multi_day: facts.multi_day ? 1 : 0, conditions,
    scoring_policy_id: score.policy_id, scoring_version: score.version, calculated_points: score.points, scoring_basis: JSON.stringify(score.basis),
  };
}

/** A duty a reviewer has decided is refused any change, with words that say why. */
export function assertDutyOpen(row: Row, doing: 'edit' | 'delete' | 'move') {
  if (!isDecidedDuty(row.approval_status)) return;
  const status = DUTY_STATUS_LABELS[row.approval_status as DutyStatus].toLowerCase();
  throw forbidden(`This duty was ${status} by its reviewer, so it stays as it was decided and cannot be ${doing === 'edit' ? 'changed' : doing === 'delete' ? 'deleted' : 'moved'}.`, 'duty_decided');
}

const label = (r: { abbr: string | null; last_name: string; first_name?: string }) => `${r.abbr ? `${r.abbr} ` : ''}${r.last_name}${r.first_name ? `, ${r.first_name}` : ''}`;
const parsedBasis = (v: unknown) => { try { return typeof v === 'string' ? JSON.parse(v) : v ?? null; } catch { return null; } };

/**
 * What a duty list shows beside each row: its type's name and code, its conditions and scoring basis read back, and
 * the people on it by name for anyone who may read it: whom it is for (to anyone but them), who recorded it (when not
 * its Marine), and who reviewed it. No names on a duty a retention schedule anonymized, where a name would put back what
 * it took out.
 */
export function withDutyNames(ctx: AppContext, viewerId: string, rows: Row[]): Row[] {
  if (!rows.length) return rows;
  const typeIds = [...new Set(rows.map((r) => String(r.duty_type_id)))];
  const types = new Map((ctx.db.prepare('SELECT id, code, name, active FROM duty_types WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(typeIds)) as Array<{ id: string; code: string; name: string; active: number }>).map((t) => [t.id, t]));
  const anonymized = (r: Row) => r.notes === REDACTED || r.title === REDACTED || r.location === REDACTED;
  const people = [...new Set(rows.flatMap((r) => (anonymized(r) ? [] : [r.user_id, r.recorded_by, r.reviewed_by])).filter((id): id is string => typeof id === 'string' && id !== viewerId))];
  const names = new Map(people.length ? (ctx.db.prepare('SELECT u.id, u.first_name, u.last_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(people)) as Array<{ id: string; first_name: string; last_name: string; abbr: string | null }>).map((u) => [u.id, u]) : []);
  return rows.map((r) => {
    const type = types.get(String(r.duty_type_id));
    const owner = names.get(String(r.user_id));
    const recorder = r.recorded_by && r.recorded_by !== r.user_id ? names.get(String(r.recorded_by)) : undefined;
    const reviewer = r.reviewed_by ? names.get(String(r.reviewed_by)) : undefined;
    return {
      ...r,
      conditions: parseList(r.conditions),
      scoring_basis: parsedBasis(r.scoring_basis),
      duty_type_name: type?.name ?? null, duty_type_code: type?.code ?? null, duty_type_active: type ? type.active === 1 : null,
      ...(owner ? { subject_name: label(owner) } : {}),
      ...(recorder ? { recorder_name: label({ abbr: recorder.abbr, last_name: recorder.last_name }) } : {}),
      ...(reviewer ? { reviewer_name: label({ abbr: reviewer.abbr, last_name: reviewer.last_name }) } : {}),
    };
  });
}

/**
 * Where the caller may record duty, and what with: the units (their own, or for a Marine they may record for, that
 * Marine's units they counsel in), each unit's Unit Instance's duty types in use and the scoring versions it has
 * published, so the form shows the points the server will work out. Only what a version scores, never who published it
 * or why.
 */
export function dutyOptions(ctx: AppContext, user: SessionUser, reqKey: object, subjectId?: string | null) {
  const scope = scopeFor(ctx, user, reqKey);
  const forOther = Boolean(subjectId && subjectId !== user.id);
  const unitIds = forOther ? detailUnitsFor(ctx, scope, String(subjectId)).filter((u) => can(scope, PERMISSIONS.COUNSEL, u)) : scope.unitIds.filter((u) => isMember(scope, u));
  if (forOther && !unitIds.length) throw forbidden('You cannot record duty for that Marine.', 'duty_not_yours');
  const units = unitIds.length ? (ctx.db.prepare('SELECT id, name, short_name, org_id FROM units WHERE id IN (SELECT value FROM json_each(?)) AND active = 1').all(JSON.stringify(unitIds)) as Array<{ id: string; name: string; short_name: string | null; org_id: string | null }>) : [];
  const orgs = [...new Set(units.map((u) => u.org_id).filter((o): o is string => Boolean(o)))];
  const types = orgs.flatMap((org) => ctx.db.prepare('SELECT id, org_id, code, name, description FROM duty_types WHERE org_id = ? AND active = 1 ORDER BY name').all(org) as Array<Omit<DutyTypeRow, 'active'>>);
  const versions = orgs.flatMap((org) => versionsFor(ctx, org).filter((v) => !v.withdrawn_at).map((v) => ({ ...v, org_id: org })));
  const home = forOther ? null : scope.homeUnitId;
  const ordered = [...units].sort((a, b) => Number(b.id === home) - Number(a.id === home) || a.name.localeCompare(b.name));
  return {
    today: scoringToday(ctx),
    units: ordered.map((u) => ({ id: u.id, name: u.short_name || u.name, org_id: u.org_id })),
    types, versions, claimable: CLAIMED_CONDITIONS,
  };
}

/**
 * The person's activities that read like duty they stood (a DNCO, a SAF, a working party), worked out when asked and
 * never stored (ADR-0015, ADR-0023). Each is theirs to move to Duty with its type and times, or to keep. Leaves out
 * what may not move (`problem`, the moves' own check), and what its owner has said is work they did.
 */
export function dutyCandidates(ctx: AppContext, user: SessionUser, problem: (row: RecordRow & Row, holds: HoldState) => unknown) {
  const rows = ctx.db.prepare(`SELECT * FROM activities WHERE user_id = ? AND deleted_at IS NULL AND frozen_at IS NULL AND kind_confirmed_at IS NULL
                               ORDER BY date DESC, created_at DESC LIMIT 5000`).all(user.id) as Array<RecordRow & Row>;
  const holds = new Map<string | null, HoldState>();
  const found: Array<{ id: string; title: string; date: string | null; end_date: string | null; start_time: string | null; end_time: string | null; unit_id: string | null; notes: string | null; version: number }> = [];
  for (const r of rows) {
    if (isDrawnFromWork(r.fingerprint) || !readsLikeDuty([r.title, r.result].filter(Boolean).join('. '))) continue;
    const org = orgOfUnit(ctx, r.unit_id);
    if (!holds.has(org)) holds.set(org, holdState(ctx, org ?? undefined));
    if (problem(r, holds.get(org)!)) continue;
    found.push({
      id: r.id, title: String(r.title), date: (r.date as string | null) ?? null, end_date: (r.end_date as string | null) ?? null,
      // What the move would carry as its notes (its result and its notes), so the form shows and sends the same.
      start_time: (r.start_time as string | null) ?? null, end_time: (r.end_time as string | null) ?? null, unit_id: r.unit_id, notes: (dutyFromActivity(r).notes as string | null) ?? null, version: Number(r.version),
    });
  }
  return { candidates: found.slice(0, 200), total: found.length };
}
