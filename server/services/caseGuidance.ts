/**
 * Guidance on file for the case diagnoser (ADR-0022, migration 030).
 *
 * Each kind of source is kept by the people who answer for it:
 * - A Unit Manager (org.config) puts approved command SOPs and validated SME workflows on file for their Unit Instance.
 * - A unit leader marks a resolved, verified case in their unit as a validated example. They may not be the person who
 *   resolved it, so one person cannot both close a case and hold it up as the way to close the next one.
 * - A Vantage Administrator (platform.settings) puts cited official policy and official system guidance on file for the
 *   service.
 * - The FMRAC training reference and the procedures ship with Vantage and are not kept here.
 *
 * An entry is never edited or removed. A change is a new entry that retires the one it replaces, and a retired entry keeps
 * its words, so what a diagnosis was given on any day can be rebuilt from what was on file that day. Every addition and
 * retirement is audited. A validated example is offered in another case's diagnosis only to a reader who may open the
 * example's own case.
 */
import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, orgOfUnit, PERMISSIONS } from '../authz/scope.ts';
import { audit } from './audit.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { zonedDay } from '../lib/clock.ts';
import { zoneOf } from '../lib/zone.ts';
import { getItem, readable, type WorkItemRow } from './work.ts';
import { caseEventsOf, eventsFor, procedureOf, stageOf } from './cases.ts';
import { decisionOf, resolutionMet, standing, type CaseEvent } from '../../shared/procedures.ts';
import {
  ENTERPRISE_GUIDANCE_AUTHORITIES, GUIDANCE_SECTIONS, UNIT_GUIDANCE_AUTHORITIES, issueForProcedure,
  type GuidanceAuthority, type GuidanceEntry, type GuidanceSection, type IssueKey,
} from '../../shared/caseDiagnosis.ts';
import type { ExampleState, GuidanceInput, GuidanceRecord } from '../../shared/caseGuidance.ts';

export interface GuidanceRow {
  id: string; org_id: string | null; authority: GuidanceAuthority; issue: IssueKey | 'any'; section: GuidanceSection; text: string; citation: string;
  approved_by: string | null; effective_on: string | null; work_item_id: string | null; unit_id: string | null; cause: string | null;
  supersedes_id: string | null; recorded_by: string; recorded_at: string; retired_at: string | null; retired_by: string | null; retired_reason: string | null;
}

const clean = (s: string | null | undefined) => (s == null ? null : String(s).replace(/\s+/g, ' ').trim() || null);
const byId = (ctx: AppContext, id: string) => ctx.db.prepare('SELECT * FROM case_guidance WHERE id = ?').get(id) as GuidanceRow;

function names(ctx: AppContext, ids: Array<string | null>): Map<string, string> {
  const unique = [...new Set(ids.filter(Boolean) as string[])];
  if (!unique.length) return new Map();
  const rows = ctx.db.prepare(`SELECT id, first_name || ' ' || last_name AS name FROM users WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(unique)) as Array<{ id: string; name: string }>;
  return new Map(rows.map((r) => [r.id, r.name]));
}

/** Entries as the consoles show them. A validated example names its case only when `caseVisible` says the reader may open it. */
function present(ctx: AppContext, rows: GuidanceRow[], caseVisible: (row: WorkItemRow) => boolean): GuidanceRecord[] {
  if (!rows.length) return [];
  const who = names(ctx, rows.flatMap((r) => [r.recorded_by, r.retired_by]));
  const unitIds = [...new Set(rows.map((r) => r.unit_id).filter(Boolean) as string[])];
  const unitNames = new Map(unitIds.length
    ? (ctx.db.prepare('SELECT id, name FROM units WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(unitIds)) as Array<{ id: string; name: string }>).map((u) => [u.id, u.name])
    : []);
  return rows.map((r) => {
    const w = r.work_item_id ? getItem(ctx, r.work_item_id) : null;
    const open = Boolean(w && caseVisible(w));
    // The citation names the case. A console reader who may not open it (a Unit Manager reads no unit's work) sees the
    // lesson and the unit, not which case it was.
    const citation = r.authority === 'historical_case' && !open ? 'A resolved case of the unit' : r.citation;
    return {
      id: r.id, authority: r.authority, issue: r.issue, section: r.section, text: r.text, citation, approved_by: r.approved_by,
      effective_on: r.effective_on, enterprise: r.org_id === null, cause: r.cause, unit: r.unit_id ? unitNames.get(r.unit_id) ?? null : null,
      case: open && w ? { id: w.id, title: w.title, reference: w.reference } : null,
      supersedes_id: r.supersedes_id, recorded_by: who.get(r.recorded_by) ?? 'A former member', recorded_at: r.recorded_at,
      retired_at: r.retired_at, retired_by: r.retired_by ? who.get(r.retired_by) ?? 'A former member' : null, retired_reason: r.retired_reason,
    };
  });
}

function insert(ctx: AppContext, actor: SessionUser, orgId: string | null, input: GuidanceInput, allowed: readonly GuidanceAuthority[]): GuidanceRow {
  if (!allowed.includes(input.authority)) {
    throw badRequest(orgId ? 'A Unit Instance puts approved command SOPs and validated SME workflows on file. Official policy and system guidance are put on file for the whole service by a Vantage Administrator.' : 'The service keeps official policy and official system guidance. A command SOP or SME workflow is put on file by its own Unit Instance.', { fieldErrors: { authority: 'Not a kind of source kept here.' } });
  }
  const text = clean(input.text);
  const citation = clean(input.citation);
  const approvedBy = clean(input.approved_by);
  if (!text) throw badRequest('Say what the source says to do.', { fieldErrors: { text: 'Required.' } });
  if (!citation) throw badRequest('Cite the source: the document and the paragraph, so a reader can look it up.', { fieldErrors: { citation: 'Required.' } });
  if ((input.authority === 'approved_local_sop' || input.authority === 'validated_sme_workflow') && !approvedBy) {
    throw badRequest(input.authority === 'approved_local_sop' ? 'Name who approved the SOP.' : 'Name who validated the workflow.', { fieldErrors: { approved_by: 'Required.' } });
  }
  const id = newId();
  const at = now();
  ctx.db.transaction(() => {
    if (input.supersedes_id) {
      const old = ctx.db.prepare('SELECT * FROM case_guidance WHERE id = ?').get(input.supersedes_id) as GuidanceRow | undefined;
      if (!old || old.org_id !== orgId || old.authority === 'historical_case') throw notFound('No such guidance on file here.');
      if (old.retired_at) throw conflict('That entry is already retired. Put the new wording on file on its own.', 'retired');
      // A new wording retires the old one the moment it is put on file. Taking effect any later than the old one would
      // have would leave neither given to a case in between, so it may not.
      const today = zonedDay(zoneOf(ctx, actor));
      const latest = old.effective_on && old.effective_on > today ? old.effective_on : today;
      if (input.effective_on && input.effective_on > latest) {
        throw badRequest(`A new wording replaces the old one at once, so it must take effect by ${latest === today ? 'today' : latest}. To schedule a later change, put the new entry on file on its own with its effective day, and retire the old one on that day.`, { fieldErrors: { effective_on: `Not after ${latest}.` } });
      }
      ctx.db.prepare('UPDATE case_guidance SET retired_at = ?, retired_by = ?, retired_reason = ? WHERE id = ?').run(at, actor.id, 'Replaced by a new wording.', old.id);
    }
    ctx.db.prepare(
      `INSERT INTO case_guidance (id, org_id, authority, issue, section, text, citation, approved_by, effective_on, supersedes_id, recorded_by, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, orgId, input.authority, input.issue, input.section, text, citation, approvedBy, input.effective_on || null, input.supersedes_id || null, actor.id, at);
  })();
  return byId(ctx, id);
}

function retire(ctx: AppContext, actor: SessionUser, row: GuidanceRow, reason: string): string {
  const why = clean(reason);
  if (!why) throw badRequest('Say why it is retired.', { fieldErrors: { reason: 'Required.' } });
  if (row.retired_at) throw conflict('That entry is already retired.', 'retired');
  ctx.db.prepare('UPDATE case_guidance SET retired_at = ?, retired_by = ?, retired_reason = ? WHERE id = ? AND retired_at IS NULL').run(now(), actor.id, why.slice(0, 500), row.id);
  return why;
}

const describe = (r: Pick<GuidanceRow, 'authority' | 'issue' | 'section' | 'citation'>) => `${r.authority} · ${r.issue} · ${r.section}: ${r.citation}`;

// ——— A Unit Instance's own: command SOPs, validated SME workflows, and the examples its leaders validated ———

/** What a Unit Instance has on file, the examples its leaders validated, and what the service has on file for everyone. */
export function orgGuidance(ctx: AppContext, user: SessionUser, scope: Scope, orgId: string) {
  const own = ctx.db.prepare('SELECT * FROM case_guidance WHERE org_id = ? ORDER BY retired_at IS NOT NULL, recorded_at DESC').all(orgId) as GuidanceRow[];
  const service = ctx.db.prepare('SELECT * FROM case_guidance WHERE org_id IS NULL AND retired_at IS NULL ORDER BY recorded_at DESC').all() as GuidanceRow[];
  const visible = (w: WorkItemRow) => readable(scope, user, w);
  return {
    entries: present(ctx, own.filter((r) => r.authority !== 'historical_case'), visible),
    examples: present(ctx, own.filter((r) => r.authority === 'historical_case'), visible),
    enterprise: present(ctx, service, visible),
  };
}

export function addOrgGuidance(ctx: AppContext, actor: SessionUser, orgId: string, input: GuidanceInput, ip?: string): GuidanceRecord {
  const row = insert(ctx, actor, orgId, input, UNIT_GUIDANCE_AUTHORITIES);
  audit(ctx, { actor_id: actor.id, action: 'case_guidance_added', entity: 'case_guidance', entity_id: row.id, org_id: orgId, detail: `${describe(row)}${row.supersedes_id ? ' (replaces an earlier wording)' : ''}`, ip });
  return present(ctx, [row], () => false)[0];
}

/** A Unit Manager retires an entry of their own Unit Instance: an SOP or workflow, or an example a leader validated. */
export function retireOrgGuidance(ctx: AppContext, actor: SessionUser, orgId: string, id: string, reason: string, ip?: string): GuidanceRecord {
  const row = ctx.db.prepare('SELECT * FROM case_guidance WHERE id = ? AND org_id = ?').get(id, orgId) as GuidanceRow | undefined;
  if (!row) throw notFound('No such guidance on file here.');
  const why = retire(ctx, actor, row, reason);
  const example = row.authority === 'historical_case';
  audit(ctx, { actor_id: actor.id, action: example ? 'case_example_withdrawn' : 'case_guidance_retired', entity: 'case_guidance', entity_id: row.id, org_id: orgId, unit_id: row.unit_id, detail: `${describe(row)}: ${why}`, ip });
  return present(ctx, [byId(ctx, id)], () => false)[0];
}

// ——— A validated example, marked from the case ———

function exampleRow(ctx: AppContext, itemId: string) {
  return (ctx.db.prepare('SELECT * FROM case_guidance WHERE work_item_id = ? AND retired_at IS NULL').get(itemId) as GuidanceRow | undefined) || null;
}

const leads = (scope: Scope, row: WorkItemRow) => Boolean(row.unit_id) && (can(scope, PERMISSIONS.REASSIGN_WORK, row.unit_id) || can(scope, PERMISSIONS.MANAGE_RECORDS, row.unit_id));

/** Who closed the case: the latest standing resolution, by order of entry. */
function resolverOf(events: CaseEvent[]): string | null {
  const closing = standing(events).filter((e) => e.kind === 'resolved' || (e.kind === 'stage_changed' && e.body.to === 'resolved'));
  return closing.length ? closing[closing.length - 1].actor_id : null;
}

interface ExampleCheck { ok: boolean; reason: string | null; cause: string | null; issue: IssueKey | null }

/** Whether this reader may validate this case as an example, and why not when they may not. */
function exampleCheck(ctx: AppContext, user: SessionUser, scope: Scope, row: WorkItemRow): ExampleCheck {
  const events = caseEventsOf(eventsFor(ctx, row.id));
  const { procedure } = procedureOf(row);
  const issue = issueForProcedure(row.procedure_key);
  const fail = (reason: string): ExampleCheck => ({ ok: false, reason, cause: null, issue });
  if (row.visibility !== 'unit' || !row.unit_id) return fail('Only a case shared with its unit can be an example.');
  if (!leads(scope, row)) return fail('A unit leader who can reassign this unit’s work validates an example.');
  if (stageOf(row) !== 'resolved') return fail('Only a resolved case can be an example.');
  if (!issue || !procedure) return fail('Only a case that followed a procedure can be an example.');
  if (!resolutionMet(procedure, events).ok) return fail('Its resolution was not verified, so it cannot be an example.');
  const causeStep = procedure.steps.find((s) => s.kind === 'decision' && s.key === 'cause' && s.decision);
  const cause = causeStep ? decisionOf(events, causeStep.decision!.key) : null;
  if (!cause || cause.body.choice === 'refer_for_review') return fail('No cause was decided on it, so it cannot show the next person one.');
  const resolver = resolverOf(events);
  if (resolver && resolver === user.id) return fail('You resolved this case. Another leader of the unit validates it as an example.');
  return { ok: true, reason: null, cause: String(cause.body.choice), issue };
}

export function exampleState(ctx: AppContext, user: SessionUser, scope: Scope, row: WorkItemRow): ExampleState {
  const current = exampleRow(ctx, row.id);
  if (current) return { current: present(ctx, [current], () => true)[0], may_validate: false, reason: null, may_withdraw: leads(scope, row) };
  const check = exampleCheck(ctx, user, scope, row);
  return { current: null, may_validate: check.ok, reason: check.reason, may_withdraw: false };
}

export function validateExample(ctx: AppContext, user: SessionUser, scope: Scope, itemId: string, input: { text: string; section?: string | null }, ip?: string): GuidanceRecord {
  const row = getItem(ctx, itemId);
  if (!row || !readable(scope, user, row)) throw notFound('No such work item.');
  if (exampleRow(ctx, row.id)) throw conflict('This case is already a validated example.', 'already_example');
  const check = exampleCheck(ctx, user, scope, row);
  if (!check.ok) throw forbidden(check.reason!, 'example_refused');
  const text = clean(input.text);
  if (!text) throw badRequest('Say what this case shows the next person: what told the cause apart, and what fixed it.', { fieldErrors: { text: 'Required.' } });
  const section = (GUIDANCE_SECTIONS as readonly string[]).includes(String(input.section)) ? (input.section as GuidanceSection) : 'probable_cause';
  const orgId = orgOfUnit(ctx, row.unit_id);
  if (!orgId) throw badRequest('This case’s unit is not in a Unit Instance.');
  const resolvedOn = zonedDay(zoneOf(ctx, user), 0, new Date(row.resolved_at || now()));
  const citation = `Case ${row.reference || row.title}, resolved ${resolvedOn}`.slice(0, 300);
  const id = newId();
  ctx.db.prepare(
    `INSERT INTO case_guidance (id, org_id, authority, issue, section, text, citation, effective_on, work_item_id, unit_id, cause, recorded_by, recorded_at)
     VALUES (?, ?, 'historical_case', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId, check.issue, section, text.slice(0, 1000), citation, zonedDay(zoneOf(ctx, user)), row.id, row.unit_id, check.cause, user.id, now());
  audit(ctx, { actor_id: user.id, action: 'case_example_validated', entity: 'case_guidance', entity_id: id, org_id: orgId, unit_id: row.unit_id, detail: `${check.issue}: cause ${check.cause} (${citation})`, ip });
  return present(ctx, [byId(ctx, id)], () => true)[0];
}

/** A leader of the case's unit withdraws an example: the one who validated it, or another. */
export function withdrawExample(ctx: AppContext, user: SessionUser, scope: Scope, itemId: string, reason: string, ip?: string): GuidanceRecord {
  const row = getItem(ctx, itemId);
  if (!row || !readable(scope, user, row)) throw notFound('No such work item.');
  const current = exampleRow(ctx, row.id);
  if (!current) throw notFound('This case is not a validated example.');
  if (!leads(scope, row)) throw forbidden('A unit leader who can reassign this unit’s work withdraws an example.');
  const why = retire(ctx, user, current, reason);
  audit(ctx, { actor_id: user.id, action: 'case_example_withdrawn', entity: 'case_guidance', entity_id: current.id, org_id: current.org_id, unit_id: row.unit_id, detail: `${describe(current)}: ${why}`, ip });
  return present(ctx, [byId(ctx, current.id)], () => true)[0];
}

// ——— The service's: official policy and official system guidance ———

export function enterpriseGuidance(ctx: AppContext): GuidanceRecord[] {
  const rows = ctx.db.prepare('SELECT * FROM case_guidance WHERE org_id IS NULL ORDER BY retired_at IS NOT NULL, recorded_at DESC').all() as GuidanceRow[];
  return present(ctx, rows, () => false);
}

export function addEnterpriseGuidance(ctx: AppContext, actor: SessionUser, input: GuidanceInput, ip?: string): GuidanceRecord {
  const row = insert(ctx, actor, null, input, ENTERPRISE_GUIDANCE_AUTHORITIES);
  audit(ctx, { actor_id: actor.id, action: 'official_guidance_added', entity: 'case_guidance', entity_id: row.id, detail: `${describe(row)}${row.supersedes_id ? ' (replaces an earlier wording)' : ''}`, ip });
  return present(ctx, [row], () => false)[0];
}

export function retireEnterpriseGuidance(ctx: AppContext, actor: SessionUser, id: string, reason: string, ip?: string): GuidanceRecord {
  const row = ctx.db.prepare('SELECT * FROM case_guidance WHERE id = ? AND org_id IS NULL').get(id) as GuidanceRow | undefined;
  if (!row) throw notFound('No such guidance on file.');
  const why = retire(ctx, actor, row, reason);
  audit(ctx, { actor_id: actor.id, action: 'official_guidance_retired', entity: 'case_guidance', entity_id: row.id, detail: `${describe(row)}: ${why}`, ip });
  return present(ctx, [byId(ctx, id)], () => false)[0];
}

// ——— What a diagnosis is given ———

/**
 * The guidance on file that may speak to this case, for this reader: the service's, and the case's own Unit Instance's,
 * not retired. A validated example is given only when the reader may open its case, and never to the case itself.
 */
export function guidanceForCase(ctx: AppContext, user: SessionUser, scope: Scope, row: WorkItemRow): GuidanceEntry[] {
  const orgId = row.unit_id ? orgOfUnit(ctx, row.unit_id) : null;
  const rows = ctx.db.prepare(
    'SELECT * FROM case_guidance WHERE retired_at IS NULL AND (org_id IS NULL OR org_id = ?) ORDER BY recorded_at'
  ).all(orgId) as GuidanceRow[];
  const out: GuidanceEntry[] = [];
  for (const r of rows) {
    let example: GuidanceEntry['case'] = null;
    if (r.authority === 'historical_case') {
      if (r.work_item_id === row.id) continue;
      const w = r.work_item_id ? getItem(ctx, r.work_item_id) : null;
      if (!w || !readable(scope, user, w)) continue;
      example = { id: w.id, title: w.title };
    }
    out.push({ id: r.id, authority: r.authority, issue: r.issue, section: r.section, text: r.text, citation: r.citation, enterprise: r.org_id === null, effective_on: r.effective_on, cause: r.cause, case: example });
  }
  return out;
}
