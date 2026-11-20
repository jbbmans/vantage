import { z } from 'zod';
import type { AppContext, SessionUser } from '../context.ts';
import { PERMISSIONS, can, detailUnitsFor, isMember, orgOfUnit, scopeFor, type Scope } from '../authz/scope.ts';
import { badRequest, forbidden } from '../lib/errors.ts';
import { REDACTED } from '../../shared/constants.ts';
import {
  CLAIMED_CONDITIONS, DUTY_STATUSES, DUTY_STATUS_LABELS, dutyConditions, dutyFacts, dutyFromActivity, dutyProblems, isDecidedDuty, readsLikeDuty, scoreDuty,
  type DutyScoringVersion, type DutyStatus,
} from '../../shared/duty.ts';
import { isCalendarDay } from '../../shared/metrics.ts';
import { isDrawnFromWork } from '../../shared/recordKinds.ts';
import { listScoringPolicies, scoringToday } from './dutyScoring.ts';
import { holdState, type HoldState } from './holds.ts';
import { periodClause } from './timeframes.ts';
import { auditListedRecords } from './audit.ts';
import { dutyReviewAuthority, readableClause, type RecordRow } from '../authz/records.ts';
import { NO_REVIEW_OPTIONS, dutyReviewOptions, type DutyReviewOptions } from '../../shared/dutyReview.ts';

/**
 * Duty records (ADR-0023). The record itself goes through the record routes and server/services/records.ts
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
 * A duty a retention schedule anonymized: its words are gone, and its row names no one on a list, a Marine's page, an
 * export or the unit's Duty report. Its type, times, length and score still count in a unit's totals (ADR-0023 §8).
 */
export const isAnonymizedDuty = (r: { title?: unknown; notes?: unknown; location?: unknown }) => r.notes === REDACTED || r.title === REDACTED || r.location === REDACTED;

/**
 * Only a retention schedule leaves that marker in a duty's words. A duty that carries it names nobody and is closed to
 * review (ADR-0024 §7), so one saved with it by hand, a form's or a file's, would wait unseen by every reviewer: the
 * words a person gives a duty are never the marker. `data` is what a save sets.
 */
export function assertDutyWords(data: Row): void {
  const fieldErrors: Record<string, string> = {};
  for (const field of ['title', 'location', 'notes']) if (typeof data[field] === 'string' && (data[field] as string).trim() === REDACTED) fieldErrors[field] = 'Say this another way.';
  if (Object.keys(fieldErrors).length) throw badRequest('That wording is what Vantage leaves in place of a duty’s words when a retention schedule clears them. Say it another way.', { fieldErrors });
}

/**
 * What the reader may do to a duty's review, as it stands (ADR-0024 §3): the one rule the review route enforces and
 * every read sends with the duty, so a page offers the decisions the server will take. A duty a retention schedule
 * anonymized is closed: its words are gone, and it stays as it was decided.
 */
export function dutyReviewFor(scope: Scope, userId: string, row: Row): DutyReviewOptions {
  if (isAnonymizedDuty(row)) return NO_REVIEW_OPTIONS;
  const duty = row as Row & RecordRow & { deleted_at?: string | null };
  return dutyReviewOptions({ user_id: duty.user_id, approval_status: String(duty.approval_status), frozen_at: duty.frozen_at, deleted_at: duty.deleted_at }, userId, dutyReviewAuthority(scope, userId, duty));
}

/**
 * What a duty list shows beside each row: its type's name and code, its conditions and scoring basis read back, what the
 * reader may do to its review, and the people on it by name for anyone who may read it: whom it is for (to anyone but
 * them), who recorded it (when not its Marine), who reviewed it and who set its points apart. No names on a duty a
 * retention schedule anonymized, where a name would put back what it took out.
 */
export function withDutyNames(ctx: AppContext, viewerId: string, rows: Row[], scope: Scope = scopeFor(ctx, { id: viewerId })): Row[] {
  if (!rows.length) return rows;
  const typeIds = [...new Set(rows.map((r) => String(r.duty_type_id)))];
  const types = new Map((ctx.db.prepare('SELECT id, code, name, active FROM duty_types WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(typeIds)) as Array<{ id: string; code: string; name: string; active: number }>).map((t) => [t.id, t]));
  const anonymized = isAnonymizedDuty;
  const people = [...new Set(rows.flatMap((r) => (anonymized(r) ? [] : [r.user_id, r.recorded_by, r.reviewed_by, r.points_overridden_by])).filter((id): id is string => typeof id === 'string' && id !== viewerId))];
  const names = new Map(people.length ? (ctx.db.prepare('SELECT u.id, u.first_name, u.last_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(people)) as Array<{ id: string; first_name: string; last_name: string; abbr: string | null }>).map((u) => [u.id, u]) : []);
  return rows.map((r) => {
    const type = types.get(String(r.duty_type_id));
    // The names are looked up once for the whole list, so a person on another row is in them: an anonymized row is
    // given none of them, whoever else is on the list.
    const hidden = anonymized(r);
    const owner = hidden ? undefined : names.get(String(r.user_id));
    const recorder = !hidden && r.recorded_by && r.recorded_by !== r.user_id ? names.get(String(r.recorded_by)) : undefined;
    const reviewer = !hidden && r.reviewed_by ? names.get(String(r.reviewed_by)) : undefined;
    const overrider = !hidden && r.points_overridden_by ? names.get(String(r.points_overridden_by)) : undefined;
    return {
      ...r,
      conditions: parseList(r.conditions),
      scoring_basis: parsedBasis(r.scoring_basis),
      duty_type_name: type?.name ?? null, duty_type_code: type?.code ?? null, duty_type_active: type ? type.active === 1 : null,
      ...(owner ? { subject_name: label(owner) } : {}),
      ...(recorder ? { recorder_name: label({ abbr: recorder.abbr, last_name: recorder.last_name }) } : {}),
      ...(reviewer ? { reviewer_name: label({ abbr: reviewer.abbr, last_name: reviewer.last_name }) } : {}),
      ...(overrider ? { overrider_name: label({ abbr: overrider.abbr, last_name: overrider.last_name }) } : {}),
      review: dutyReviewFor(scope, viewerId, r),
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

// The Duty page's lists, a page at a time

/** How many duties a page of the Duty page's list holds unless it asks for fewer, and the most one may ask for. */
export const DUTY_PAGE = 50;
const DUTY_PAGE_MAX = 100;
/**
 * Duty counted for a list's size, at most. A battalion's history runs to tens of thousands of duties, and counting them
 * all on every visit is a pass over every one; past this the page says "more than", as the notification badge does.
 */
export const DUTY_COUNTED = 1000;

const listDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'A date: YYYY-MM-DD.').refine(isCalendarDay, 'That date does not exist.');

/**
 * What one page of the Duty page asks for (GET /api/record/duty/list). `who` is the tab: the reader's own duty, the duty
 * they recorded for their Marines, or every duty they may read that is not their own (which holds what they recorded).
 */
export const dutyListQuery = z.object({
  who: z.enum(['mine', 'recorded', 'units']).default('mine'),
  unit_id: z.string().trim().min(1).max(100).optional(),
  from: listDay.optional(),
  to: listDay.optional(),
  status: z.enum(DUTY_STATUSES).optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(DUTY_PAGE_MAX).default(DUTY_PAGE),
});
export type DutyListQuery = z.infer<typeof dutyListQuery>;
export type DutyTab = DutyListQuery['who'];

/** Where a page ends, newest first: the order of idx_duties_live_order, whose last column breaks every tie. */
interface DutyKey { date: string; start_time: string; created_at: string; id: string }
const encodeDutyCursor = (r: DutyKey) => Buffer.from([r.date, r.start_time, r.created_at, r.id].join('|')).toString('base64url');
function decodeDutyCursor(cursor: string): DutyKey {
  const [date, start_time, created_at, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const id = rest.join('|');
  if (!date || !start_time || !created_at || !id) throw badRequest('That page of the list is out of date. Load the list again.', { fieldErrors: { cursor: 'Not a page of this list.' } });
  return { date, start_time, created_at, id };
}

/**
 * Which duties a tab holds, as SQL over `t`. What the reader may read comes first and is never left out: the same
 * readableClause every record list uses, so another Unit Instance's duty, or a unit whose shared records the reader does
 * not view, is out before anything is counted, ordered or cut to a page. The tab, the unit, the period and the status
 * only narrow it further.
 */
export function dutyListWhere(ctx: AppContext, userId: string, scope: Scope, q: Pick<DutyListQuery, 'who'> & Partial<Pick<DutyListQuery, 'unit_id' | 'from' | 'to' | 'status'>>) {
  const readable = readableClause(ctx, scope, userId, 't');
  const where = ['t.deleted_at IS NULL', readable.clause];
  const params: unknown[] = [...readable.params];
  if (q.who === 'mine') { where.push('t.user_id = ?'); params.push(userId); }
  else if (q.who === 'recorded') { where.push('t.user_id <> ?', 't.recorded_by = ?'); params.push(userId, userId); }
  else { where.push('t.user_id <> ?'); params.push(userId); }
  if (q.unit_id) { where.push('t.unit_id = ?'); params.push(q.unit_id); }
  if (q.from || q.to) { const period = periodClause('duties', 't', q.from, q.to); where.push(period.sql); params.push(...period.params); }
  if (q.status) { where.push('t.approval_status = ?'); params.push(q.status); }
  return { where, params };
}

/** One page's SQL: the tab's rows after the cursor, newest first, and one more than the page, which says whether more follow. */
export function dutyPageSql(ctx: AppContext, userId: string, scope: Scope, q: DutyListQuery) {
  const { where, params } = dutyListWhere(ctx, userId, scope, q);
  if (q.cursor) {
    const after = decodeDutyCursor(q.cursor);
    where.push('(t.date, t.start_time, t.created_at, t.id) < (?, ?, ?, ?)');
    params.push(after.date, after.start_time, after.created_at, after.id);
  }
  return { sql: `SELECT t.* FROM duties t WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.start_time DESC, t.created_at DESC, t.id DESC LIMIT ?`, params: [...params, q.limit + 1] };
}

/** How many rows `where` holds, counted up to DUTY_COUNTED, and whether there are more than that. */
function countedDuty(ctx: AppContext, where: string[], params: unknown[]): { n: number; more: boolean } {
  const n = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM duties t WHERE ${where.join(' AND ')} LIMIT ?)`).get(...params, DUTY_COUNTED + 1) as { n: number }).n;
  return { n: Math.min(n, DUTY_COUNTED), more: n > DUTY_COUNTED };
}

/**
 * One page of a tab of the Duty page, newest first, with what each duty shows beside it (withDutyNames). `next` carries
 * on from the last row, and is null on the last page. The first page also says how many the tab holds with its filters,
 * counted up to DUTY_COUNTED. Reading a page is a read of the Marines on it, audited as any list of records is: the rows
 * returned, not the history behind them.
 */
export function dutyList(ctx: AppContext, user: SessionUser, scope: Scope, q: DutyListQuery, ip?: string | null) {
  const page = dutyPageSql(ctx, user.id, scope, q);
  const rows = ctx.db.prepare(page.sql).all(...page.params) as Array<Row & DutyKey>;
  const more = rows.length > q.limit;
  const shown = more ? rows.slice(0, q.limit) : rows;
  let counted: { n: number; more: boolean } | null = null;
  if (!q.cursor) { const { where, params } = dutyListWhere(ctx, user.id, scope, q); counted = countedDuty(ctx, where, params); }
  auditListedRecords(ctx, user.id, 'duties', shown, ip);
  return {
    duties: withDutyNames(ctx, user.id, shown, scope),
    next: more ? encodeDutyCursor(shown.at(-1)!) : null,
    ...(counted ? { total: counted.n, total_more: counted.more } : {}),
  };
}

/**
 * What the Duty page adds up, from all of the reader's duty rather than the page they have open: their own duty's count,
 * hours and points; how many each tab holds (their own and what they recorded exactly, their units' counted up to
 * DUTY_COUNTED); and the units its lists may be narrowed to. Each count is of rows the reader may read, by the clause the
 * lists use. Totals of what the reader already reads, with no names, so nothing is audited.
 */
export function dutySummary(ctx: AppContext, user: SessionUser, scope: Scope) {
  const own = dutyListWhere(ctx, user.id, scope, { who: 'mine' });
  const mine = ctx.db.prepare(`SELECT COUNT(*) AS duties, COALESCE(SUM(t.hours), 0) AS hours, COALESCE(SUM(t.calculated_points), 0) AS calculated_points,
      COALESCE(SUM(CASE WHEN t.approval_status = 'approved' THEN COALESCE(t.approved_points, 0) ELSE 0 END), 0) AS approved_points,
      COALESCE(SUM(t.approval_status = 'pending'), 0) AS pending, COALESCE(SUM(t.approval_status = 'returned'), 0) AS returned
    FROM duties t WHERE ${own.where.join(' AND ')}`).get(...own.params) as { duties: number; hours: number; calculated_points: number; approved_points: number; pending: number; returned: number };
  const byMe = dutyListWhere(ctx, user.id, scope, { who: 'recorded' });
  const recorded = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM duties t WHERE ${byMe.where.join(' AND ')}`).get(...byMe.params) as { n: number }).n;
  const others = dutyListWhere(ctx, user.id, scope, { who: 'units' });
  const units = countedDuty(ctx, others.where, others.params);
  const unitIds = [...new Set([...scope.readableUnitIds, ...scope.unitIds])];
  const named = unitIds.length ? ctx.db.prepare('SELECT id, COALESCE(short_name, name) AS name FROM units WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name, id').all(JSON.stringify(unitIds)) as Array<{ id: string; name: string }> : [];
  return { mine, tabs: { mine: mine.duties, recorded, units: units.n, units_more: units.more }, units: named };
}
