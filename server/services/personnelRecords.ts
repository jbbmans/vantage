import { z } from 'zod';
import type { AppContext, SessionUser } from '../context.ts';
import { can, PERMISSIONS, positionIn, scopeFor, isUnitOwner, orgOfUnit, detailUnitsFor, subtreeIds, unitTree, seatedLeader, type Scope } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { notify } from './notifications.ts';
import { getUnit, moveMember, primaryOrgOf, setPrimaryUnit } from './org.ts';
import { membershipHistory, noteMembershipChangesBy } from './membership.ts';
import { sourcedFieldsFor } from './personnel.ts';
import { isoDate } from '../../shared/schemas.ts';
import { ORG_ROLES, type OrgRole } from '../../shared/permissions.ts';
import type {
  AccountStatus, PersonnelAssignment, PersonnelBulkResponse, PersonnelEvent, PersonnelInstance, PersonnelPersonRef, PersonnelRecordResponse,
  PersonnelResponsibility, PersonnelRosterResponse, PersonnelRosterRow,
} from '../../shared/types.ts';

/**
 * Personnel as a structured record (ADR-0017). A Marine's account carries who they are (rank, grade, MOS, EAS); each
 * membership carries the unit, the billet it fills from the Unit Instance's catalogue and the dates of the assignment;
 * personnel_records carries their supervisor and check-in in each Unit Instance; personnel_responsibilities the duties
 * they hold besides a billet. Database triggers write the history of each (personnel_events); this module names who
 * made each change and why, decides who may read and change what, and applies changes one at a time or in bulk.
 *
 * Nothing here confers authority. A supervisor, a leadership chain or a responsibility is information about the Marine:
 * what a reader may do is still decided by the roles they hold (ADR-0010, ADR-0013).
 */

export type PersonnelSource = 'self' | 'leader' | 'feed' | 'support' | 'departure';

/** The newest history row now. Changes written after it are the ones the caller is about to name. */
export function personnelMark(ctx: AppContext): number {
  return (ctx.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM personnel_events').get() as { id: number }).id;
}

/**
 * Names who made the personnel changes written since `mark`, how and why, and the bulk change they belong to. Only rows
 * nothing has named yet: statements are synchronous and the server single-threaded, so between a mark and its note the
 * only new rows are the caller's own.
 */
export function notePersonnelChanges(ctx: AppContext, mark: number, note: { actorId: string | null; source: PersonnelSource; reason?: string | null; batchId?: string | null }) {
  ctx.db.prepare(`UPDATE personnel_events SET actor_id = COALESCE(actor_id, ?), source = ?, reason = COALESCE(reason, ?), batch_id = COALESCE(batch_id, ?)
                   WHERE id > ? AND source IS NULL`).run(note.actorId, note.source, note.reason ?? null, note.batchId ?? null, mark);
}

/** Runs `fn` and names the personnel changes it wrote. */
export function withPersonnelNote<T>(ctx: AppContext, note: Parameters<typeof notePersonnelChanges>[2], fn: () => T): T {
  const mark = personnelMark(ctx);
  const out = fn();
  notePersonnelChanges(ctx, mark, note);
  return out;
}

// ——— Reading ———

interface MembershipRow {
  user_id: string; unit_id: string; org_id: string | null; is_primary: number; billet: string | null; billet_id: string | null;
  assignment_start: string | null; assignment_end: string | null; joined_at: string; unit_name: string; unit_short: string | null; echelon: string | null;
}

const MEMBERSHIPS = `SELECT um.user_id, um.unit_id, un.org_id, um.is_primary, um.billet, um.billet_id, um.assignment_start, um.assignment_end, um.joined_at,
                            un.name AS unit_name, un.short_name AS unit_short, un.echelon
                       FROM unit_members um JOIN units un ON un.id = um.unit_id
                      WHERE un.active = 1 AND um.user_id IN (SELECT value FROM json_each(?))`;

function membershipsOf(ctx: AppContext, userIds: string[]): MembershipRow[] {
  return userIds.length ? ctx.db.prepare(MEMBERSHIPS).all(JSON.stringify(userIds)) as MembershipRow[] : [];
}

const PERSON_REF = `SELECT u.id, u.first_name, u.last_name, r.abbr AS rank_abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (SELECT value FROM json_each(?))`;

function peopleById(ctx: AppContext, ids: Array<string | null | undefined>): Map<string, PersonnelPersonRef> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  return new Map((ctx.db.prepare(PERSON_REF).all(JSON.stringify(wanted)) as PersonnelPersonRef[]).map((p) => [p.id, p]));
}

/** A unit's label as menus show it: its short name, else its name. */
function unitLabels(ctx: AppContext, ids: Array<string | null | undefined>): Map<string, string> {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map();
  return new Map((ctx.db.prepare('SELECT id, COALESCE(short_name, name) AS label FROM units WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(wanted)) as Array<{ id: string; label: string }>).map((u) => [u.id, u.label]));
}

/** Where a reader stands with one Marine: in which of the Marine's units they see, manage or open records. */
export interface PersonnelAccess {
  self: boolean;
  /** The Marine's units where the reader sees them on a roster: Read records or Manage members there. */
  seeIn: string[];
  /** The Marine's units where the reader may change their assignment: Manage members there, and above them or leading it. */
  manageIn: string[];
  /** The Marine's units where the reader may open their records (ADR-0015's rule, unchanged). */
  recordsIn: string[];
}

export function personnelAccess(ctx: AppContext, scope: Scope, actorId: string, targetId: string, targetScope = scopeFor(ctx, { id: targetId })): PersonnelAccess {
  const self = actorId === targetId;
  const units = targetScope.unitIds;
  return {
    self,
    seeIn: units.filter((u) => can(scope, PERMISSIONS.VIEW_RECORDS, u) || can(scope, PERMISSIONS.MANAGE_MEMBERS, u)),
    manageIn: self ? [] : units.filter((u) => mayManageIn(ctx, scope, actorId, targetScope, u)),
    recordsIn: self ? [] : detailUnitsFor(ctx, scope, targetId),
  };
}

/** Manage members in the unit, and above the Marine there or its leader: the rule every membership change follows. */
function mayManageIn(ctx: AppContext, scope: Scope, actorId: string, targetScope: Scope, unitId: string) {
  return can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId) && (isUnitOwner(ctx, actorId, unitId) || positionIn(targetScope, unitId) < positionIn(scope, unitId));
}

/** What the account's state says to someone who manages it: whether it can be used, never a secret. */
function accountStatus(row: { active: number; locked_until: string | null; last_login_at: string | null; must_change_password: number }): AccountStatus {
  if (!row.active) return 'deactivated';
  if (row.locked_until && row.locked_until > now()) return 'locked';
  if (!row.last_login_at) return 'never_signed_in';
  if (row.must_change_password) return 'must_change_password';
  return 'active';
}

/** The deepest of these memberships: the Marine's own team, or their unit when they are in no team beneath it. */
function deepest(rows: MembershipRow[], tree: ReturnType<typeof unitTree>): MembershipRow | undefined {
  const depth = (id: string) => { let d = 0; let p = tree.parent.get(id) ?? null; while (p && d < 50) { d++; p = tree.parent.get(p) ?? null; } return d; };
  return rows.reduce<MembershipRow | undefined>((best, m) => (!best || depth(m.unit_id) > depth(best.unit_id) ? m : best), undefined);
}

/** The supervisors above a Marine in one Unit Instance, nearest first, at most ten deep. */
function supervisorChain(ctx: AppContext, orgId: string, userId: string): string[] {
  const out: string[] = [];
  let current: string | null = userId;
  const step = ctx.db.prepare('SELECT supervisor_id FROM personnel_records WHERE org_id = ? AND user_id = ?');
  while (current && out.length < 10) {
    const next: string | null = (step.get(orgId, current) as { supervisor_id: string | null } | undefined)?.supervisor_id ?? null;
    if (!next || next === userId || out.includes(next)) break;
    out.push(next);
    current = next;
  }
  return out;
}

/** The seated leaders of a unit and of every unit above it, nearest first. */
function unitLeaders(ctx: AppContext, unitId: string): Array<{ unit_id: string; leader_id: string }> {
  return ctx.db.prepare(`WITH RECURSIVE up(id, depth) AS (SELECT ?, 0 UNION ALL SELECT u.parent_id, up.depth + 1 FROM units u JOIN up ON u.id = up.id WHERE u.parent_id IS NOT NULL AND up.depth < 50)
    SELECT u.id AS unit_id, u.owner_user_id AS leader_id FROM up JOIN units u ON u.id = up.id WHERE u.active = 1 AND u.owner_user_id IS NOT NULL AND ${seatedLeader('u')} ORDER BY up.depth`).all(unitId) as Array<{ unit_id: string; leader_id: string }>;
}

const RESPONSIBILITIES = `SELECT id, org_id, user_id, unit_id, title, starts_on, ends_on, assigned_by, created_at, ended_at, end_reason FROM personnel_responsibilities`;
interface ResponsibilityRow { id: string; org_id: string; user_id: string; unit_id: string | null; title: string; starts_on: string | null; ends_on: string | null; assigned_by: string | null; created_at: string; ended_at: string | null; end_reason: string | null }

/**
 * One Marine's personnel record as this reader may see it. The Marine sees all of it. Anyone who sees them on a roster
 * (Read records or Manage members in a unit of theirs) sees their assignments, supervisor, leadership chain,
 * responsibilities and roles in the Unit Instances where they do, and only the units there they may see. Account status
 * is for the Marine and those who manage them; history for those and whoever opens their records; counts of records
 * only with the record access Vantage already has (ADR-0015), so a Unit Manager, who never reads records, sees none.
 */
export function personnelRecord(ctx: AppContext, scope: Scope, actorId: string, targetId: string): { body: PersonnelRecordResponse; access: PersonnelAccess } {
  const person = ctx.db.prepare(`SELECT u.id, u.first_name, u.last_name, u.middle_initial, u.rank_id, r.abbr AS rank_abbr, r.name AS rank_name, r.grade AS rank_grade, u.mos, u.eas,
      u.active, u.locked_until, u.last_login_at, u.must_change_password, u.totp_enabled, u.edipi_verified_at
      FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?`).get(targetId) as (PersonnelRecordResponse['person'] & { active: number; locked_until: string | null; last_login_at: string | null; must_change_password: number; totp_enabled: number; edipi_verified_at: string | null }) | undefined;
  if (!person || (!person.active && actorId !== targetId)) throw notFound('No such Marine.');
  const targetScope = scopeFor(ctx, { id: targetId });
  const access = personnelAccess(ctx, scope, actorId, targetId, targetScope);
  if (!access.self && !access.seeIn.length) throw forbidden('You cannot see this Marine’s personnel record.');
  const tree = unitTree(ctx);

  const all = membershipsOf(ctx, [targetId]);
  const visible = access.self ? all : all.filter((m) => access.seeIn.includes(m.unit_id));
  const orgIds = [...new Set(visible.map((m) => m.org_id).filter((o): o is string => Boolean(o)))];
  const historyOrgs = access.self ? null : [...new Set([...access.manageIn, ...access.recordsIn].map((u) => orgOfUnit(ctx, u)).filter((o): o is string => Boolean(o)))];
  const json = JSON.stringify(orgIds);

  const records = ctx.db.prepare('SELECT org_id, supervisor_id, checked_in_on FROM personnel_records WHERE user_id = ? AND org_id IN (SELECT value FROM json_each(?))').all(targetId, json) as Array<{ org_id: string; supervisor_id: string | null; checked_in_on: string | null }>;
  const responsibilities = ctx.db.prepare(`${RESPONSIBILITIES} WHERE user_id = ? AND org_id IN (SELECT value FROM json_each(?)) ORDER BY ended_at IS NOT NULL, created_at DESC`).all(targetId, json) as ResponsibilityRow[];
  const supervised = ctx.db.prepare('SELECT pr.org_id, pr.user_id FROM personnel_records pr JOIN users u ON u.id = pr.user_id WHERE pr.supervisor_id = ? AND u.active = 1 AND pr.org_id IN (SELECT value FROM json_each(?))').all(targetId, json) as Array<{ org_id: string; user_id: string }>;
  const roleRows = ctx.db.prepare('SELECT mr.unit_id, r.name, r.color FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.user_id = ? AND (mr.expires_at IS NULL OR mr.expires_at > ?) ORDER BY r.position DESC').all(targetId, now()) as Array<{ unit_id: string; name: string; color: string | null }>;
  const orgRoles = ctx.db.prepare('SELECT org_id, role FROM org_roles WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)').all(targetId, now()) as Array<{ org_id: string; role: OrgRole }>;
  const orgNames = new Map((ctx.db.prepare('SELECT id, COALESCE(short_name, name) AS name FROM organizations WHERE id IN (SELECT value FROM json_each(?))').all(json) as Array<{ id: string; name: string }>).map((o) => [o.id, o.name]));

  // The chain: the supervisor and theirs, then the leaders of the primary assignment's unit and of those above it.
  const chains = new Map(orgIds.map((o) => {
    const inOrg = visible.filter((m) => m.org_id === o);
    const anchor = inOrg.find((m) => m.is_primary) || deepest(inOrg, tree);
    const leaders = anchor ? unitLeaders(ctx, anchor.unit_id).filter((l) => l.leader_id !== targetId && (access.self || scope.viewableUnitIds.includes(l.unit_id))) : [];
    return [o, { supervisors: supervisorChain(ctx, o, targetId), leaders }];
  }));
  const refs = peopleById(ctx, [...records.map((r) => r.supervisor_id), ...supervised.map((s) => s.user_id), ...responsibilities.map((r) => r.assigned_by),
    ...[...chains.values()].flatMap((c) => [...c.supervisors, ...c.leaders.map((l) => l.leader_id)])]);
  const labels = unitLabels(ctx, [...visible.map((m) => m.unit_id), ...responsibilities.map((r) => r.unit_id), ...roleRows.map((r) => r.unit_id), ...[...chains.values()].flatMap((c) => c.leaders.map((l) => l.unit_id))]);

  const instances: PersonnelInstance[] = orgIds.map((orgId) => {
    const inOrg = visible.filter((m) => m.org_id === orgId);
    const team = deepest(inOrg, tree);
    const rec = records.find((r) => r.org_id === orgId);
    const chain = chains.get(orgId)!;
    const historyHere = access.self || Boolean(historyOrgs?.includes(orgId));
    return {
      org_id: orgId, org_name: orgNames.get(orgId) || orgId,
      assignments: inOrg.map((m) => assignmentOf(m, access.manageIn.includes(m.unit_id))),
      team: team ? { unit_id: team.unit_id, label: labels.get(team.unit_id) || team.unit_name, echelon: team.echelon } : null,
      supervisor: rec?.supervisor_id ? refs.get(rec.supervisor_id) ?? null : null,
      checked_in_on: rec?.checked_in_on ?? null,
      chain: [
        ...chain.supervisors.filter((id) => refs.has(id)).map((id) => ({ ...refs.get(id)!, relation: 'supervisor' as const, unit_label: null })),
        ...chain.leaders.filter((l) => !chain.supervisors.includes(l.leader_id) && refs.has(l.leader_id)).map((l) => ({ ...refs.get(l.leader_id)!, relation: 'leader' as const, unit_label: labels.get(l.unit_id) || null })),
      ],
      supervises: supervised.filter((s) => s.org_id === orgId).map((s) => refs.get(s.user_id)).filter((p): p is PersonnelPersonRef => Boolean(p)),
      responsibilities: responsibilities.filter((r) => r.org_id === orgId && (historyHere || !r.ended_at)).map((r) => responsibilityOf(r, labels, refs)),
      roles: roleRows.filter((r) => inOrg.some((m) => m.unit_id === r.unit_id)).map((r) => ({ unit_id: r.unit_id, unit_label: labels.get(r.unit_id) || r.unit_id, name: r.name, color: r.color })),
      orgRoles: orgRoles.filter((r) => r.org_id === orgId).map((r) => ORG_ROLES[r.role]?.label ?? r.role),
      canManage: inOrg.some((m) => access.manageIn.includes(m.unit_id)),
      // The catalogue to choose a billet from, for those who may set one.
      billets: inOrg.some((m) => access.manageIn.includes(m.unit_id))
        ? ctx.db.prepare('SELECT id, title, unit_id, code FROM unit_billets WHERE org_id = ? AND active = 1 AND (unit_id IS NULL OR unit_id IN (SELECT value FROM json_each(?))) ORDER BY title').all(orgId, JSON.stringify(inOrg.map((m) => m.unit_id))) as PersonnelInstance['billets']
        : [],
    };
  });

  const { active, locked_until, last_login_at, must_change_password, totp_enabled, edipi_verified_at, ...identity } = person;
  const body: PersonnelRecordResponse = {
    person: identity,
    sourced: sourcedFieldsFor(ctx, targetId),
    self: access.self,
    canOpenRecords: access.self || access.recordsIn.length > 0,
    account: access.self || access.manageIn.length
      ? { status: accountStatus({ active, locked_until, last_login_at, must_change_password }), last_login_at, locked_until: locked_until && locked_until > now() ? locked_until : null, mfa: Boolean(totp_enabled), cac: Boolean(edipi_verified_at) }
      : null,
    instances,
    history: access.self || historyOrgs!.length ? historyOf(ctx, targetId, historyOrgs, access.self ? null : scope.viewableUnitIds) : null,
    records: access.self || access.recordsIn.length ? recordCounts(ctx, targetId, access.self ? null : access.recordsIn, actorId) : null,
  };
  return { body, access };
}

function assignmentOf(m: MembershipRow, canManage: boolean): PersonnelAssignment {
  return {
    unit_id: m.unit_id, unit_name: m.unit_name, unit_short: m.unit_short, echelon: m.echelon, is_primary: m.is_primary, billet: m.billet,
    billet_id: m.billet_id, assignment_start: m.assignment_start, assignment_end: m.assignment_end, joined_at: m.joined_at, canManage,
  };
}

function responsibilityOf(r: ResponsibilityRow, labels: Map<string, string>, refs: Map<string, PersonnelPersonRef>): PersonnelResponsibility {
  return {
    id: r.id, title: r.title, unit_id: r.unit_id, unit_label: r.unit_id ? labels.get(r.unit_id) ?? null : null, starts_on: r.starts_on, ends_on: r.ends_on,
    created_at: r.created_at, ended_at: r.ended_at, end_reason: r.end_reason, assigned_by: r.assigned_by ? refs.get(r.assigned_by) ?? null : null,
  };
}

/**
 * The history the reader may see: membership periods (ADR-0009) and personnel events. orgIds limits both to those Unit
 * Instances, and units to those the reader can view, so a leader never learns another command's part. A change to the
 * person (rank, MOS, EAS, account) belongs to no instance: a leader sees those made since the Marine first joined the
 * leader's instance, without the name of whoever made it.
 */
function historyOf(ctx: AppContext, userId: string, orgIds: string[] | null, viewable: string[] | null): NonNullable<PersonnelRecordResponse['history']> {
  const periods = membershipHistory(ctx, userId, orgIds).filter((p) => !viewable || viewable.includes(p.unit_id));
  const since = orgIds ? (ctx.db.prepare('SELECT MIN(p.started_at) AS at FROM unit_membership_periods p JOIN units u ON u.id = p.unit_id WHERE p.user_id = ? AND u.org_id IN (SELECT value FROM json_each(?))').get(userId, JSON.stringify(orgIds)) as { at: string | null }).at : null;
  const rows = ctx.db.prepare(`SELECT id, field, from_value, to_value, org_id, unit_id, source, reason, actor_id, batch_id, at FROM personnel_events
      WHERE user_id = ? ${orgIds ? 'AND (org_id IN (SELECT value FROM json_each(?)) OR (org_id IS NULL AND at >= ?))' : ''} ORDER BY at DESC, id DESC LIMIT 300`)
    .all(...[userId, ...(orgIds ? [JSON.stringify(orgIds), since ?? '9999'] : [])]) as Array<{ id: number; field: string; from_value: string | null; to_value: string | null; org_id: string | null; unit_id: string | null; source: string | null; reason: string | null; actor_id: string | null; batch_id: string | null; at: string }>;
  const kept = rows.filter((r) => !viewable || !r.unit_id || viewable.includes(r.unit_id));
  const people = peopleById(ctx, [...kept.map((r) => r.actor_id), ...kept.filter((r) => r.field === 'supervisor').flatMap((r) => [r.from_value, r.to_value])]);
  const ranks = new Map((ctx.db.prepare('SELECT id, abbr FROM ranks').all() as Array<{ id: string; abbr: string }>).map((r) => [r.id, r.abbr]));
  const labels = unitLabels(ctx, kept.map((r) => r.unit_id));
  const label = (field: string, v: string | null) => {
    if (v == null) return null;
    if (field === 'supervisor') { const p = people.get(v); return p ? `${p.rank_abbr ? `${p.rank_abbr} ` : ''}${p.first_name} ${p.last_name}` : 'A former member'; }
    if (field === 'rank') return ranks.get(v) || v;
    return v;
  };
  const events: PersonnelEvent[] = kept.map((r) => ({
    id: r.id, field: r.field, from_value: r.from_value, to_value: r.to_value, from_label: label(r.field, r.from_value), to_label: label(r.field, r.to_value),
    unit_id: r.unit_id, unit_label: r.unit_id ? labels.get(r.unit_id) ?? null : null, source: r.source, reason: r.reason, batch_id: r.batch_id, at: r.at,
    actor: r.actor_id && (!orgIds || r.org_id) ? people.get(r.actor_id) ?? null : null,
  }));
  return { periods, events };
}

/**
 * How many of each kind of record the reader may open, by the rules the Marine page reads them with (ADR-0015): all of
 * them for the Marine; for anyone else, those shared with a unit the reader may open records in. Duty is counted from
 * Operations activities until duty keeps records of its own (Task 17).
 */
function recordCounts(ctx: AppContext, userId: string, units: string[] | null, readerId: string): NonNullable<PersonnelRecordResponse['records']> {
  const shared = units ? "AND visibility = 'unit' AND unit_id IN (SELECT value FROM json_each(?))" : '';
  const args = units ? [JSON.stringify(units)] : [];
  const count = (sql: string) => (ctx.db.prepare(sql).get(userId, ...args) as { n: number }).n;
  return {
    trainings: count(`SELECT COUNT(*) AS n FROM trainings WHERE user_id = ? AND deleted_at IS NULL AND type <> 'education' ${shared}`),
    education: count(`SELECT COUNT(*) AS n FROM trainings WHERE user_id = ? AND deleted_at IS NULL AND type = 'education' ${shared}`),
    awards: count(`SELECT COUNT(*) AS n FROM awards WHERE user_id = ? AND deleted_at IS NULL ${shared}`),
    counselings: units
      ? (ctx.db.prepare("SELECT COUNT(*) AS n FROM counselings WHERE user_id = ? AND deleted_at IS NULL AND (counselor_id = ? OR (visibility = 'unit' AND unit_id IN (SELECT value FROM json_each(?))))").get(userId, readerId, JSON.stringify(units)) as { n: number }).n
      : count('SELECT COUNT(*) AS n FROM counselings WHERE user_id = ? AND deleted_at IS NULL'),
    duty: count(`SELECT COUNT(*) AS n FROM activities WHERE user_id = ? AND deleted_at IS NULL AND category = 'Operations' ${shared}`),
    activities: count(`SELECT COUNT(*) AS n FROM activities WHERE user_id = ? AND deleted_at IS NULL ${shared}`),
    goals: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM goals WHERE (user_id = ? OR assignee_id = ?) AND deleted_at IS NULL ${shared}`).get(userId, userId, ...args) as { n: number }).n,
    tasks: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE (user_id = ? OR assignee_id = ?) AND deleted_at IS NULL AND status <> 'completed' ${shared}`).get(userId, userId, ...args) as { n: number }).n,
  };
}

/**
 * Everyone in a unit and the units beneath it, one row each, with what a personnel roster shows: the assignment the row
 * stands for (their own team beneath the unit, else the unit), billet, supervisor, check-in, responsibilities and roles.
 * Account status only for those the reader manages. Read records or Manage members in the unit is required: a Unit
 * Manager sees the roster they run, and no records through it.
 */
export function personnelRoster(ctx: AppContext, scope: Scope, actorId: string, unitId: string): PersonnelRosterResponse {
  if (!getUnit(ctx, unitId)) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.VIEW_RECORDS, unitId) && !can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot see this unit’s roster.');
  const orgId = orgOfUnit(ctx, unitId);
  const tree = unitTree(ctx);
  const subtree = subtreeIds(ctx, unitId, tree).filter((u) => can(scope, PERMISSIONS.VIEW_RECORDS, u) || can(scope, PERMISSIONS.MANAGE_MEMBERS, u));
  const people = ctx.db.prepare(`SELECT u.id, u.first_name, u.last_name, u.mos, u.eas, u.active, u.locked_until, u.last_login_at, u.must_change_password,
        r.abbr AS rank_abbr, r.grade AS rank_grade, r.sort AS rank_sort
      FROM users u LEFT JOIN ranks r ON r.id = u.rank_id
     WHERE u.active = 1 AND u.id IN (SELECT um.user_id FROM unit_members um WHERE um.unit_id IN (SELECT value FROM json_each(?)))
     ORDER BY r.sort DESC, u.last_name, u.first_name`).all(JSON.stringify(subtree)) as Array<{ id: string; first_name: string; last_name: string; mos: string | null; eas: string | null; active: number; locked_until: string | null; last_login_at: string | null; must_change_password: number; rank_abbr: string | null; rank_grade: string | null; rank_sort: number | null }>;
  const ids = JSON.stringify(people.map((p) => p.id));
  const memberships = membershipsOf(ctx, people.map((p) => p.id)).filter((m) => subtree.includes(m.unit_id));
  const records = orgId ? ctx.db.prepare('SELECT user_id, supervisor_id, checked_in_on FROM personnel_records WHERE org_id = ? AND user_id IN (SELECT value FROM json_each(?))').all(orgId, ids) as Array<{ user_id: string; supervisor_id: string | null; checked_in_on: string | null }> : [];
  const duties = orgId ? ctx.db.prepare('SELECT user_id, title FROM personnel_responsibilities WHERE org_id = ? AND ended_at IS NULL AND user_id IN (SELECT value FROM json_each(?)) ORDER BY title').all(orgId, ids) as Array<{ user_id: string; title: string }> : [];
  const roles = ctx.db.prepare(`SELECT mr.user_id, mr.unit_id, r.id, r.name, r.color FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.user_id IN (SELECT value FROM json_each(?)) AND mr.unit_id IN (SELECT value FROM json_each(?)) AND (mr.expires_at IS NULL OR mr.expires_at > ?) ORDER BY r.position DESC`)
    .all(ids, JSON.stringify(subtree), now()) as Array<{ user_id: string; unit_id: string; id: string; name: string; color: string | null }>;
  const refs = peopleById(ctx, records.map((r) => r.supervisor_id));
  const labels = unitLabels(ctx, memberships.map((m) => m.unit_id));
  const manages = can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId);

  // A membership only in an archived unit puts nobody on the roster.
  const rows: PersonnelRosterRow[] = people.filter((p) => memberships.some((m) => m.user_id === p.id)).map((p) => {
    const row = deepest(memberships.filter((m) => m.user_id === p.id), tree)!;
    const self = p.id === actorId;
    const canManage = !self && mayManageIn(ctx, scope, actorId, scopeFor(ctx, { id: p.id }), row.unit_id);
    const rec = records.find((r) => r.user_id === p.id);
    return {
      id: p.id, first_name: p.first_name, last_name: p.last_name, rank_abbr: p.rank_abbr, rank_grade: p.rank_grade, rank_sort: p.rank_sort, mos: p.mos, eas: p.eas,
      assignment: assignmentOf(row, canManage),
      team_label: labels.get(row.unit_id) || row.unit_name,
      supervisor: rec?.supervisor_id ? refs.get(rec.supervisor_id) ?? null : null,
      checked_in_on: rec?.checked_in_on ?? null,
      responsibilities: duties.filter((d) => d.user_id === p.id).map((d) => d.title),
      roles: roles.filter((r) => r.user_id === p.id && r.unit_id === row.unit_id).map((r) => ({ id: r.id, name: r.name, color: r.color })),
      ...(canManage || self ? { status: accountStatus(p), last_login_at: p.last_login_at } : {}),
      self, canManage,
      canOpenRecords: self || detailUnitsFor(ctx, scope, p.id).length > 0,
    };
  });
  const billets = manages && orgId
    ? ctx.db.prepare('SELECT id, title, unit_id, code FROM unit_billets WHERE org_id = ? AND active = 1 AND (unit_id IS NULL OR unit_id IN (SELECT value FROM json_each(?))) ORDER BY title').all(orgId, JSON.stringify(subtree)) as PersonnelRosterResponse['billets']
    : [];
  return { unit_id: unitId, org_id: orgId, rows, billets, canManage: manages };
}

/** Members of this unit's Unit Instance the reader can see, to choose a supervisor from. Never the Marine themselves. */
export function supervisorCandidates(ctx: AppContext, scope: Scope, unitId: string, q: string, exceptId: string | null): PersonnelPersonRef[] {
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot manage members in that unit.');
  const orgId = orgOfUnit(ctx, unitId);
  const term = q.trim().toLowerCase().slice(0, 40);
  if (!orgId || term.length < 2) return [];
  const pattern = `${term.replace(/[\\%_]/g, '\\$&')}%`;
  const units = scope.viewableUnitIds.filter((u) => scope.unitOrg[u] === orgId);
  return ctx.db.prepare(`SELECT DISTINCT u.id, u.first_name, u.last_name, r.abbr AS rank_abbr, r.sort FROM users u LEFT JOIN ranks r ON r.id = u.rank_id
      JOIN unit_members um ON um.user_id = u.id
     WHERE u.active = 1 AND um.unit_id IN (SELECT value FROM json_each(?)) AND u.id IS NOT ?
       AND (u.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE OR u.username LIKE ? ESCAPE '\\')
     ORDER BY r.sort DESC, u.last_name LIMIT 10`).all(JSON.stringify(units), exceptId, pattern, pattern, pattern)
    .map((row) => { const { sort: _sort, ...ref } = row as PersonnelPersonRef & { sort: number | null }; return ref; });
}

// ——— Changing ———

const day = isoDate.nullable();
export const assignmentSchema = z.object({
  billet: z.string().trim().max(80).nullish(),
  billet_id: z.string().max(64).nullish(),
  primary: z.boolean().optional(),
  assignment_start: day.optional(),
  assignment_end: day.optional(),
  supervisor_id: z.string().max(64).nullish(),
  checked_in_on: day.optional(),
  reason: z.string().trim().max(200).nullish(),
});
export type AssignmentChange = z.infer<typeof assignmentSchema>;

/** Fields only someone else may change: one's own billet and primary unit stay one's own to correct, as they always have. */
const OTHERS_ONLY = ['billet_id', 'assignment_start', 'assignment_end', 'supervisor_id', 'checked_in_on'] as const;

interface ChangeContext { actor: SessionUser; scope: Scope; batchId?: string | null }

/**
 * Changes one membership and the Marine's personnel record in its Unit Instance. Manage members in the unit, and above
 * the Marine there unless the actor leads it. The Marine may still set their own billet and primary unit, as before;
 * anything else about them is a second person's to change. Returns what changed. The caller audits it as
 * edit_membership; the history rows the triggers write are named here with the actor, the source and the reason.
 */
export function changeAssignment(ctx: AppContext, c: ChangeContext, unitId: string, userId: string, body: AssignmentChange): string[] {
  const { actor, scope } = c;
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot manage members in that unit.');
  const current = ctx.db.prepare('SELECT billet, billet_id, is_primary, assignment_start, assignment_end FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId) as { billet: string | null; billet_id: string | null; is_primary: number; assignment_start: string | null; assignment_end: string | null } | undefined;
  if (!current) throw notFound('That Marine is not a member of this unit.');
  const self = userId === actor.id;
  if (self && OTHERS_ONLY.some((f) => body[f] !== undefined)) throw forbidden('A second authorized person must change your own assignment.', 'self_membership_change');
  if (!self && !isUnitOwner(ctx, actor.id, unitId) && positionIn(scopeFor(ctx, { id: userId }), unitId) >= positionIn(scope, unitId)) throw forbidden('You cannot change the membership of a Marine at or above your own position.', 'hierarchy');
  const orgId = orgOfUnit(ctx, unitId);
  // A primary unit in another Unit Instance is not a leader's here to take (ADR-0008). The refusal does not say where it
  // is: which other commands a Marine serves in is not this leader's to learn.
  const heldIn = primaryOrgOf(ctx, userId)?.orgId;
  if (body.primary && !self && heldIn && heldIn !== orgId) throw forbidden('You cannot make this their primary unit.');

  // A billet from the catalogue is one of this Unit Instance's, active, for this unit or for every unit, and sets the
  // membership's title too. A title typed in instead leaves the catalogue.
  let billet: string | null | undefined = body.billet === undefined ? undefined : body.billet || null;
  const billetId: string | null | undefined = body.billet_id !== undefined ? body.billet_id || null : body.billet !== undefined ? null : undefined;
  if (billetId) {
    const b = ctx.db.prepare('SELECT title, org_id, unit_id, active FROM unit_billets WHERE id = ?').get(billetId) as { title: string; org_id: string; unit_id: string | null; active: number } | undefined;
    if (!b || b.org_id !== orgId || !b.active || (b.unit_id && b.unit_id !== unitId)) throw badRequest('Choose a billet this unit staffs.', { fieldErrors: { billet_id: 'Choose a billet this unit staffs.' } });
    billet = b.title;
  }
  const start = body.assignment_start === undefined ? current.assignment_start : body.assignment_start;
  const end = body.assignment_end === undefined ? current.assignment_end : body.assignment_end;
  if (start && end && end < start) throw badRequest('The assignment cannot end before it starts.', { fieldErrors: { assignment_end: 'On or after the start.' } });
  const supervisor = body.supervisor_id === undefined ? undefined : body.supervisor_id || null;
  if ((supervisor !== undefined || body.checked_in_on !== undefined) && !orgId) throw badRequest('This unit belongs to no Unit Instance.');
  if (supervisor) assertSupervisor(ctx, scope, orgId!, userId, supervisor);

  const changed: string[] = [];
  const mark = personnelMark(ctx);
  const since = now();
  ctx.db.transaction(() => {
    const sets: string[] = []; const vals: unknown[] = [];
    const put = (column: string, value: unknown, was: unknown) => { if (value !== undefined && value !== was) { sets.push(`${column} = ?`); vals.push(value); changed.push(column); } };
    put('billet', billet, current.billet);
    put('billet_id', billetId, current.billet_id);
    put('assignment_start', body.assignment_start, current.assignment_start);
    put('assignment_end', body.assignment_end, current.assignment_end);
    if (sets.length) ctx.db.prepare(`UPDATE unit_members SET ${sets.join(', ')} WHERE user_id = ? AND unit_id = ?`).run(...vals, userId, unitId);
    if (body.primary && !current.is_primary) { setPrimaryUnit(ctx, userId, unitId); changed.push('primary'); }
    if (orgId && (supervisor !== undefined || body.checked_in_on !== undefined)) {
      const rec = ctx.db.prepare('SELECT supervisor_id, checked_in_on FROM personnel_records WHERE org_id = ? AND user_id = ?').get(orgId, userId) as { supervisor_id: string | null; checked_in_on: string | null } | undefined;
      const next = {
        supervisor_id: supervisor === undefined ? rec?.supervisor_id ?? null : supervisor,
        checked_in_on: body.checked_in_on === undefined ? rec?.checked_in_on ?? null : body.checked_in_on,
      };
      if (next.supervisor_id !== (rec?.supervisor_id ?? null)) changed.push('supervisor');
      if (next.checked_in_on !== (rec?.checked_in_on ?? null)) changed.push('checked_in');
      if (changed.includes('supervisor') || changed.includes('checked_in')) {
        ctx.db.prepare(`INSERT INTO personnel_records (org_id, user_id, supervisor_id, checked_in_on, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(org_id, user_id) DO UPDATE SET supervisor_id = excluded.supervisor_id, checked_in_on = excluded.checked_in_on, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
          .run(orgId, userId, next.supervisor_id, next.checked_in_on, now(), actor.id);
      }
    }
    noteMembershipChangesBy(ctx, userId, actor.id, since);
    notePersonnelChanges(ctx, mark, { actorId: actor.id, source: self ? 'self' : 'leader', reason: body.reason, batchId: c.batchId });
  })();
  return changed;
}

/**
 * A supervisor is another active member of the same Unit Instance whom the actor can see, and supervising cannot loop:
 * the Marine is nowhere in the chain above the supervisor.
 */
function assertSupervisor(ctx: AppContext, scope: Scope, orgId: string, userId: string, supervisorId: string) {
  if (supervisorId === userId) throw badRequest('A Marine cannot supervise themselves.', { code: 'supervisor_self', fieldErrors: { supervisor_id: 'Choose someone else.' } });
  const units = scope.viewableUnitIds.filter((u) => scope.unitOrg[u] === orgId);
  const seen = ctx.db.prepare('SELECT 1 FROM unit_members um JOIN users u ON u.id = um.user_id WHERE um.user_id = ? AND u.active = 1 AND um.unit_id IN (SELECT value FROM json_each(?)) LIMIT 1').get(supervisorId, JSON.stringify(units));
  if (!seen) throw badRequest('Choose a supervisor who serves in this Unit Instance.', { code: 'supervisor_outside', fieldErrors: { supervisor_id: 'Choose a supervisor who serves in this Unit Instance.' } });
  if (supervisorChain(ctx, orgId, supervisorId).includes(userId)) throw badRequest('That would make a loop: this Marine already supervises that one, directly or through others.', { code: 'supervisor_cycle', fieldErrors: { supervisor_id: 'They answer to this Marine already.' } });
}

export const responsibilitySchema = z.object({
  title: z.string().trim().min(1, 'Required.').max(80),
  starts_on: day.optional(),
  ends_on: day.optional(),
  reason: z.string().trim().max(200).nullish(),
});
const RESPONSIBILITY_LIMIT = 20;

/** Gives the Marine a functional responsibility in this unit, under the same rule as any other change to their assignment. */
export function addResponsibility(ctx: AppContext, c: ChangeContext, unitId: string, userId: string, body: z.infer<typeof responsibilitySchema>, ip: string | null = null): string {
  const { actor, scope } = c;
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('You cannot manage members in that unit.');
  if (!ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(userId, unitId)) throw notFound('That Marine is not a member of this unit.');
  if (userId === actor.id) throw forbidden('A second authorized person must change your own assignment.', 'self_membership_change');
  if (!isUnitOwner(ctx, actor.id, unitId) && positionIn(scopeFor(ctx, { id: userId }), unitId) >= positionIn(scope, unitId)) throw forbidden('You cannot change the assignment of a Marine at or above your own position.', 'hierarchy');
  const orgId = orgOfUnit(ctx, unitId);
  if (!orgId) throw badRequest('This unit belongs to no Unit Instance.');
  if (body.starts_on && body.ends_on && body.ends_on < body.starts_on) throw badRequest('A responsibility cannot end before it starts.', { fieldErrors: { ends_on: 'On or after the start.' } });
  const held = ctx.db.prepare('SELECT title FROM personnel_responsibilities WHERE org_id = ? AND user_id = ? AND ended_at IS NULL').all(orgId, userId) as Array<{ title: string }>;
  if (held.some((h) => h.title.toLowerCase() === body.title.toLowerCase())) throw conflict('They already hold that responsibility.', 'duplicate_responsibility');
  if (held.length >= RESPONSIBILITY_LIMIT) throw badRequest(`A Marine holds at most ${RESPONSIBILITY_LIMIT} responsibilities at once. End one first.`, { code: 'too_many_responsibilities' });
  const id = newId();
  ctx.db.prepare('INSERT INTO personnel_responsibilities (id, org_id, user_id, unit_id, title, starts_on, ends_on, assigned_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, userId, unitId, body.title, body.starts_on ?? null, body.ends_on ?? null, actor.id, now());
  audit(ctx, { actor_id: actor.id, action: 'add_responsibility', entity: 'personnel_responsibility', entity_id: id, subject_id: userId, unit_id: unitId, detail: `${body.title}${c.batchId ? `; bulk ${c.batchId}` : ''}${body.reason ? `; ${body.reason}` : ''}`, ip });
  return id;
}

/** Ends a responsibility. It stays on the record with when, by whom and why. */
export function endResponsibility(ctx: AppContext, c: ChangeContext, id: string, reason: string | null, ip: string | null = null) {
  const { actor, scope } = c;
  const r = ctx.db.prepare(`${RESPONSIBILITIES} WHERE id = ?`).get(id) as ResponsibilityRow | undefined;
  // Someone who may manage none of the Marine's units there learns nothing about the row, not even that it exists.
  const targetScope = r ? scopeFor(ctx, { id: r.user_id }) : null;
  const units = r && targetScope ? targetScope.unitIds.filter((u) => orgOfUnit(ctx, u) === r.org_id && (!r.unit_id || u === r.unit_id || !targetScope.unitIds.includes(r.unit_id))) : [];
  if (!r || !units.some((u) => can(scope, PERMISSIONS.MANAGE_MEMBERS, u))) throw notFound('No such responsibility.');
  if (r.user_id === actor.id) throw forbidden('A second authorized person must change your own assignment.', 'self_membership_change');
  if (!units.some((u) => mayManageIn(ctx, scope, actor.id, targetScope!, u))) throw forbidden('You cannot change the assignment of a Marine at or above your own position.', 'hierarchy');
  if (r.ended_at) throw conflict('That responsibility has already ended.', 'already_ended');
  ctx.db.prepare('UPDATE personnel_responsibilities SET ended_at = ?, ended_by = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL').run(now(), actor.id, reason || 'ended', id);
  audit(ctx, { actor_id: actor.id, action: 'end_responsibility', entity: 'personnel_responsibility', entity_id: id, subject_id: r.user_id, unit_id: r.unit_id, org_id: r.org_id, detail: `${r.title}${reason ? `; ${reason}` : ''}`, ip });
  return r;
}

/**
 * Leaving a Unit Instance takes the personnel record there with it (ADR-0017): no supervisor and no check-in there, the
 * responsibilities held there ended, and nobody there supervised by them any longer. All of it stays in the history.
 * Called when the last membership in the instance ends; a move between its units never calls it.
 */
export function endPersonnelOnDeparture(ctx: AppContext, userId: string, orgId: string | null, actorId: string | null) {
  const none = { responsibilitiesEnded: 0, supervisionsEnded: 0 };
  if (!orgId) return none;
  if (ctx.db.prepare('SELECT 1 FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id = ? AND u.org_id = ? LIMIT 1').get(userId, orgId)) return none;
  const at = now();
  withPersonnelNote(ctx, { actorId, source: 'departure', reason: 'Left the Unit Instance' }, () =>
    ctx.db.prepare('UPDATE personnel_records SET supervisor_id = NULL, checked_in_on = NULL, updated_at = ?, updated_by = ? WHERE org_id = ? AND user_id = ?').run(at, actorId, orgId, userId));
  const responsibilitiesEnded = ctx.db.prepare("UPDATE personnel_responsibilities SET ended_at = ?, ended_by = ?, end_reason = 'left' WHERE org_id = ? AND user_id = ? AND ended_at IS NULL").run(at, actorId, orgId, userId).changes;
  const supervisionsEnded = withPersonnelNote(ctx, { actorId, source: 'departure', reason: 'Their supervisor left the Unit Instance' }, () =>
    ctx.db.prepare('UPDATE personnel_records SET supervisor_id = NULL, updated_at = ?, updated_by = ? WHERE org_id = ? AND supervisor_id = ?').run(at, actorId, orgId, userId).changes);
  return { responsibilitiesEnded, supervisionsEnded };
}

// ——— Bulk ———

export const BULK_ACTIONS = ['supervisor', 'checked_in', 'assignment_start', 'assignment_end', 'billet', 'responsibility', 'move'] as const;
export const bulkSchema = z.object({
  items: z.array(z.object({ user_id: z.string().max(64), unit_id: z.string().max(64) })).min(1, 'Choose at least one Marine.').max(200, 'At most 200 Marines at once.'),
  action: z.enum(BULK_ACTIONS),
  /** A user id (supervisor), a date (checked_in, assignment_start, assignment_end), a billet id, a responsibility's title or a unit id (move); null clears. */
  value: z.string().trim().max(80).nullable(),
  reason: z.string().trim().max(200).nullish(),
  dry_run: z.boolean().optional(),
});
export type BulkRequest = z.infer<typeof bulkSchema>;
const MEMBERSHIP_ACTIONS = new Set<BulkRequest['action']>(['supervisor', 'checked_in', 'assignment_start', 'assignment_end', 'billet']);

class Rollback extends Error {}
const isBoundaryRefusal = (e: unknown) => e instanceof Error && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_TRIGGER' && e.message.startsWith('cross_instance:');

/**
 * One change to many Marines at once, from a roster view (ADR-0017). Every row is decided exactly as it would be alone,
 * inside one transaction: a preview (dry_run) and any refused row roll all of it back, so a bulk change lands whole or
 * not at all, and the caller sees row by row what would happen and why a row is refused. Each row is audited as its
 * single change would be, and the whole as personnel_bulk with the batch that names every row in the history.
 */
export function bulkPersonnel(ctx: AppContext, c: Omit<ChangeContext, 'batchId'>, viewUnitId: string, req: BulkRequest, ip: string | null): PersonnelBulkResponse {
  const { actor, scope } = c;
  if (!getUnit(ctx, viewUnitId)) throw notFound('No such unit.');
  if (!can(scope, PERMISSIONS.MANAGE_MEMBERS, viewUnitId)) throw forbidden('You cannot manage members in that unit.');
  const subtree = new Set(subtreeIds(ctx, viewUnitId));
  const keys = new Set(req.items.map((i) => i.user_id));
  if (keys.size !== req.items.length) throw badRequest('Each Marine appears once.', { code: 'duplicate_row' });
  const value = req.value || null;
  if (['checked_in', 'assignment_start', 'assignment_end'].includes(req.action) && value && !isoDate.safeParse(value).success) throw badRequest('Enter a date (YYYY-MM-DD).', { fieldErrors: { value: 'Enter a date.' } });
  if (['responsibility', 'move'].includes(req.action) && !value) throw badRequest(req.action === 'move' ? 'Choose the team to move them to.' : 'Name the responsibility.', { fieldErrors: { value: 'Required.' } });
  if (req.action === 'move' && !subtree.has(value!)) throw forbidden('Move them to a team in this view.', 'outside_view');

  const batchId = newId();
  const results: PersonnelBulkResponse['results'] = [];
  const moved: string[] = [];
  const cc: ChangeContext = { actor, scope, batchId };
  const apply = (item: BulkRequest['items'][number]): string[] => {
    if (!subtree.has(item.unit_id)) throw forbidden('That Marine is not in this view.', 'outside_view');
    if (item.user_id === actor.id) throw forbidden('A second authorized person must change your own assignment.', 'self_membership_change');
    switch (req.action) {
      case 'supervisor': return changeAssignment(ctx, cc, item.unit_id, item.user_id, { supervisor_id: value, reason: req.reason });
      case 'checked_in': return changeAssignment(ctx, cc, item.unit_id, item.user_id, { checked_in_on: value, reason: req.reason });
      case 'assignment_start': return changeAssignment(ctx, cc, item.unit_id, item.user_id, { assignment_start: value, reason: req.reason });
      case 'assignment_end': return changeAssignment(ctx, cc, item.unit_id, item.user_id, { assignment_end: value, reason: req.reason });
      case 'billet': return changeAssignment(ctx, cc, item.unit_id, item.user_id, value ? { billet_id: value, reason: req.reason } : { billet: null, reason: req.reason });
      case 'responsibility': addResponsibility(ctx, cc, item.unit_id, item.user_id, { title: value!, reason: req.reason }, ip); return ['responsibility'];
      case 'move': {
        const r = moveMember(ctx, actor, scope, item.user_id, item.unit_id, value!, {});
        audit(ctx, { actor_id: actor.id, action: 'move_member', entity: 'unit', entity_id: value!, subject_id: item.user_id, unit_id: item.unit_id, detail: `bulk ${batchId}; roles kept: ${r.roles.join(', ') || 'none'}; not carried: ${r.rolesSkipped.join(', ') || 'none'}; entries stayed (frozen: ${r.recordsFrozen}); sessions revoked: ${r.sessionsRevoked}`, ip });
        moved.push(item.user_id);
        return ['unit'];
      }
    }
  };
  try {
    ctx.db.transaction(() => {
      for (const item of req.items) {
        try {
          const changed = ctx.db.transaction(() => apply(item))();
          if (changed.length && MEMBERSHIP_ACTIONS.has(req.action)) {
            audit(ctx, { actor_id: actor.id, action: 'edit_membership', entity: 'unit', entity_id: item.unit_id, subject_id: item.user_id, unit_id: item.unit_id, detail: `bulk ${batchId}: ${changed.join(', ')}${req.reason ? `; ${req.reason}` : ''}`, ip });
          }
          results.push({ user_id: item.user_id, unit_id: item.unit_id, ok: true, changed });
        } catch (e) {
          if (!(e instanceof HttpError) && !isBoundaryRefusal(e)) throw e;
          results.push({ user_id: item.user_id, unit_id: item.unit_id, ok: false, changed: [], code: e instanceof HttpError ? e.code : 'cross_instance', error: e instanceof HttpError ? e.message : 'That would join records from two Unit Instances.' });
        }
      }
      if (req.dry_run || results.some((r) => !r.ok)) throw new Rollback();
    })();
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  const refused = results.filter((r) => !r.ok).length;
  const applied = !req.dry_run && !refused;
  if (applied) {
    audit(ctx, { actor_id: actor.id, action: 'personnel_bulk', entity: 'unit', entity_id: viewUnitId, unit_id: viewUnitId, detail: `${req.action} for ${results.length} Marine${results.length === 1 ? '' : 's'}; batch ${batchId}${req.reason ? `; ${req.reason}` : ''}`, ip });
    for (const id of moved) notify(ctx, id, { kind: 'unit', title: 'Moved to a new team', message: `${actor.first_name} ${actor.last_name} moved you to ${getUnit(ctx, value!)?.name}. Sign in again to see it.`, actionUrl: '/team', dedupeKey: `move:${value}:${id}` });
  }
  return { batch_id: applied ? batchId : null, applied, dry_run: Boolean(req.dry_run), results, refused };
}
