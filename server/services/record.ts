import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, PERMISSIONS } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { RESEARCH_KINDS, describeEvent, humanKey, type Stage } from '../../shared/caseModel.ts';
import { procedureFor, progress } from '../../shared/procedures.ts';
import { CONTRIBUTION_DEFINITIONS, WORKLOAD_LIMITATIONS, draftUpdateSchema } from '../../shared/record.ts';
import { parse } from '../lib/http.ts';
import { eventsFor, toCaseEvent, stageOf } from './cases.ts';
import { readable, type WorkItemRow } from './work.ts';

/**
 * The Record: three things kept apart on purpose.
 *
 *   Assigned work         what a Marine holds right now. Claiming puts work here at once.
 *   Contribution history  what they actually did, read from the case events they authored.
 *   Personal documentation what they wrote themselves: activities, training, private drafts.
 *
 * Claiming is not credit. Moving one document through five stages is one document, not five.
 */

const RESEARCH = RESEARCH_KINDS.map((k) => `'${k}'`).join(',');
const OPEN = "('resolved','not_applicable')";

export interface Window { from: string; to: string }
const bounds = (w: Window) => [`${w.from}T00:00:00.000Z`, `${w.to}T23:59:59.999Z`] as const;

export function defaultWindow(days = 90): Window {
  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function parseWindow(query: Record<string, unknown>, days = 90): Window {
  const fallback = defaultWindow(days);
  const from = typeof query.from === 'string' && query.from ? query.from : fallback.from;
  const to = typeof query.to === 'string' && query.to ? query.to : fallback.to;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw badRequest('Use a valid from/to window.');
  return { from, to };
}

/** One person's contribution counts over a window, from events they authored. */
export function contributionCounts(ctx: AppContext, userId: string, w: Window, unitId: string | null = null) {
  const [lo, hi] = bounds(w);
  const unitClause = unitId ? ' AND unit_id = ?' : '';
  const p = (extra: unknown[] = []) => [userId, lo, hi, ...(unitId ? [unitId] : []), ...extra];
  const one = (sql: string, extra: unknown[] = []) => (ctx.db.prepare(sql).get(...p(extra)) as { n: number }).n;
  return {
    documents_researched: one(`SELECT COUNT(DISTINCT work_item_id) AS n FROM work_events WHERE actor_id = ? AND occurred_at BETWEEN ? AND ?${unitClause} AND kind IN (${RESEARCH})`),
    research_actions: one(`SELECT COUNT(*) AS n FROM work_events WHERE actor_id = ? AND occurred_at BETWEEN ? AND ?${unitClause} AND kind IN (${RESEARCH})`),
    submitted_actions: one(`SELECT COUNT(*) AS n FROM work_events WHERE actor_id = ? AND occurred_at BETWEEN ? AND ?${unitClause} AND kind = 'action_submitted'`),
    verified_outcomes: one(`SELECT COUNT(DISTINCT work_item_id || ':' || json_extract(body, '$.check')) AS n FROM work_events WHERE actor_id = ? AND occurred_at BETWEEN ? AND ?${unitClause} AND kind = 'verification' AND json_extract(body, '$.result') = 'verified'`),
    resolved_work: one(`SELECT COUNT(DISTINCT work_item_id) AS n FROM work_events WHERE actor_id = ? AND occurred_at BETWEEN ? AND ?${unitClause} AND kind = 'resolved'`),
    handoffs: one(`SELECT COUNT(*) AS n FROM work_events WHERE actor_id = ? AND occurred_at BETWEEN ? AND ?${unitClause} AND kind = 'handed_off'`),
  };
}

type ItemRow = WorkItemRow & { project_name?: string | null };

/** What the person holds right now, with where each stands and what comes next. */
export function assignedWork(ctx: AppContext, user: SessionUser) {
  const rows = ctx.db.prepare(
    `SELECT w.*, p.name AS project_name FROM work_items w LEFT JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
      WHERE w.claimed_by = ? AND w.deleted_at IS NULL AND COALESCE(w.stage, '') NOT IN ${OPEN} AND w.state NOT IN ${OPEN}
      ORDER BY (w.due_date IS NULL), w.due_date, w.claimed_at`
  ).all(user.id) as ItemRow[];
  return rows.map((row) => summarizeItem(ctx, row));
}

export function summarizeItem(ctx: AppContext, row: ItemRow) {
  const stage = stageOf(row);
  const procedure = procedureFor(row.procedure_key);
  let nextStep: { key: string; title: string; status: string; note: string | null } | null = null;
  if (procedure) {
    const prog = progress(procedure, eventsFor(ctx, row.id).map(toCaseEvent), { reference: row.reference, stage });
    const step = prog.steps.find((s) => s.key === prog.next);
    const def = procedure.steps.find((s) => s.key === prog.next);
    if (step && def) nextStep = { key: def.key, title: def.title, status: step.status, note: step.note };
  }
  return {
    id: row.id, title: row.title, reference: row.reference, natural_key: row.natural_key, due_date: row.due_date,
    stage, state: row.state, waiting_category: row.waiting_category || null, waiting_since: row.waiting_since || null,
    blocked_reason: row.blocked_reason || null, claimed_at: row.claimed_at, unit_id: row.unit_id,
    project_id: row.project_id || null, project_name: row.project_name || null,
    amount: row.amount, amount_type: row.amount_type, procedure_key: row.procedure_key || null,
    next_step: nextStep, version: row.version,
  };
}

/** The Record's summary: assigned work and contribution counts side by side, never blended. */
export function recordSummary(ctx: AppContext, user: SessionUser, w: Window) {
  const assigned = assignedWork(ctx, user);
  const personal = (table: string, col: string) => (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND deleted_at IS NULL AND ${col} BETWEEN ? AND ?`).get(user.id, w.from, w.to) as { n: number }).n;
  const drafts = (ctx.db.prepare('SELECT COUNT(*) AS n FROM record_drafts WHERE user_id = ? AND deleted_at IS NULL AND activity_id IS NULL').get(user.id) as { n: number }).n;
  return {
    window: w,
    assigned: {
      total: assigned.length,
      waiting: assigned.filter((a) => a.stage === 'waiting').length,
      blocked: assigned.filter((a) => a.stage === 'blocked').length,
    },
    contributions: contributionCounts(ctx, user.id, w),
    personal: { activities: personal('activities', 'date'), trainings: personal('trainings', 'date'), open_drafts: drafts },
    definitions: CONTRIBUTION_DEFINITIONS,
  };
}

/**
 * The person's own events, grouped by the work they were on. A Marine keeps the record of what
 * they did after the work moves on: to another stage, another person, or closed.
 */
export function contributionHistory(ctx: AppContext, user: SessionUser, scope: Scope, w: Window, limit = 60) {
  const [lo, hi] = bounds(w);
  const events = ctx.db.prepare(
    `SELECT e.* FROM work_events e WHERE e.actor_id = ? AND e.occurred_at BETWEEN ? AND ?
       AND e.kind NOT IN ('claimed','released','assigned','claim_expired','created','procedure_applied','stage_changed','waiting_started','waiting_ended')
     ORDER BY e.occurred_at DESC, e.created_at DESC LIMIT 2000`
  ).all(user.id, lo, hi) as Array<{ id: string; work_item_id: string; kind: string; step: string | null; body: string; occurred_at: string; subject_id: string | null; supersedes_id: string | null }>;
  const byItem = new Map<string, typeof events>();
  for (const e of events) {
    const list = byItem.get(e.work_item_id) || [];
    list.push(e);
    byItem.set(e.work_item_id, list);
  }
  const ids = [...byItem.keys()].slice(0, limit);
  if (!ids.length) return [];
  const items = new Map((ctx.db.prepare(`SELECT * FROM work_items WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as ItemRow[]).map((r) => [r.id, r]));
  return ids.map((id) => {
    const item = items.get(id);
    const list = byItem.get(id)!;
    // They did this work, so they keep seeing that they did. Whether they can still open the item
    // itself is decided the ordinary way.
    const canOpen = item ? readable(scope, user, item) : false;
    return {
      item: item ? { id, title: item.title, reference: item.reference, stage: stageOf(item), open: canOpen, procedure_key: item.procedure_key || null } : { id, title: 'Removed work item', reference: null, stage: 'not_applicable' as Stage, open: false, procedure_key: null },
      research: list.filter((e) => RESEARCH_KINDS.includes(e.kind as never)).length,
      submitted: list.filter((e) => e.kind === 'action_submitted').length,
      verified: list.filter((e) => e.kind === 'verification' && JSON.parse(e.body).result === 'verified').length,
      resolved: list.some((e) => e.kind === 'resolved'),
      last_at: list[0].occurred_at,
      events: list.slice(0, 12).map((e) => ({ id: e.id, kind: e.kind, step: e.step, occurred_at: e.occurred_at, summary: describeEvent(e.kind, { ...JSON.parse(e.body), step: e.step }) })),
    };
  });
}

/* ── Leader workload ───────────────────────────────────────────────────────────────────────── */

/**
 * The section's work: what is unassigned, waiting, blocked, aging and overdue, and who has done
 * what in the window. People are never labelled; counts sit beside the context needed to read them.
 * Totals need VIEW_RECORDS. The per-person breakdown needs VIEW_MEMBER_DETAIL, the same line the
 * unit dashboard draws.
 */
export function teamWorkload(ctx: AppContext, user: SessionUser, scope: Scope, unitId: string, w: Window) {
  if (!can(scope, PERMISSIONS.VIEW_RECORDS, unitId)) throw forbidden('You cannot view workload for that unit.');
  const includeMembers = can(scope, PERMISSIONS.VIEW_MEMBER_DETAIL, unitId);
  const [lo, hi] = bounds(w);
  const today = new Date().toISOString().slice(0, 10);
  const items = ctx.db.prepare(
    `SELECT w.*, p.name AS project_name FROM work_items w LEFT JOIN projects p ON p.id = w.project_id AND p.deleted_at IS NULL
      WHERE w.unit_id = ? AND w.visibility = 'unit' AND w.deleted_at IS NULL`
  ).all(unitId) as ItemRow[];
  const open = items.filter((i) => !['resolved', 'not_applicable'].includes(stageOf(i)));
  const ageDays = (i: ItemRow) => Math.floor((Date.now() - Date.parse(i.created_at)) / 86_400_000);
  const waitingHours = (i: ItemRow) => (i.waiting_since ? Math.max(0, (Date.now() - Date.parse(i.waiting_since)) / 3_600_000) : 0);

  const byWaiting: Record<string, { count: number; oldest_hours: number }> = {};
  for (const i of open.filter((x) => stageOf(x) === 'waiting')) {
    const key = i.waiting_category || 'unspecified';
    const cur = byWaiting[key] || { count: 0, oldest_hours: 0 };
    cur.count += 1; cur.oldest_hours = Math.max(cur.oldest_hours, Math.round(waitingHours(i)));
    byWaiting[key] = cur;
  }
  const stages: Record<string, number> = {};
  for (const i of open) stages[stageOf(i)] = (stages[stageOf(i)] || 0) + 1;

  const section = {
    open: open.length,
    unassigned: open.filter((i) => !i.claimed_by).length,
    overdue: open.filter((i) => i.due_date && i.due_date < today).length,
    blocked: open.filter((i) => stageOf(i) === 'blocked').length,
    waiting: open.filter((i) => stageOf(i) === 'waiting').length,
    verification_required: open.filter((i) => stageOf(i) === 'verification_required').length,
    aging: {
      under_7_days: open.filter((i) => ageDays(i) < 7).length,
      from_7_to_30_days: open.filter((i) => ageDays(i) >= 7 && ageDays(i) <= 30).length,
      over_30_days: open.filter((i) => ageDays(i) > 30).length,
    },
    by_stage: stages,
    by_waiting: byWaiting,
    // Distinct documents, counted once for the section however many people touched them.
    documents_researched: (ctx.db.prepare(`SELECT COUNT(DISTINCT work_item_id) AS n FROM work_events WHERE unit_id = ? AND actor_id IS NOT NULL AND occurred_at BETWEEN ? AND ? AND kind IN (${RESEARCH})`).get(unitId, lo, hi) as { n: number }).n,
    resolved: (ctx.db.prepare(`SELECT COUNT(DISTINCT work_item_id) AS n FROM work_events WHERE unit_id = ? AND occurred_at BETWEEN ? AND ? AND kind = 'resolved'`).get(unitId, lo, hi) as { n: number }).n,
    verified: (ctx.db.prepare(`SELECT COUNT(DISTINCT work_item_id || ':' || json_extract(body, '$.check')) AS n FROM work_events WHERE unit_id = ? AND occurred_at BETWEEN ? AND ? AND kind = 'verification' AND json_extract(body, '$.result') = 'verified'`).get(unitId, lo, hi) as { n: number }).n,
    submitted: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM work_events WHERE unit_id = ? AND occurred_at BETWEEN ? AND ? AND kind = 'action_submitted'`).get(unitId, lo, hi) as { n: number }).n,
  };

  const unassigned = open.filter((i) => !i.claimed_by)
    .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'))
    .slice(0, 12).map((i) => summarizeItem(ctx, i));
  const attention = open.filter((i) => stageOf(i) === 'blocked' || (i.due_date && i.due_date < today) || stageOf(i) === 'verification_required')
    .slice(0, 12).map((i) => summarizeItem(ctx, i));

  let members: Array<Record<string, unknown>> = [];
  if (includeMembers) {
    const people = ctx.db.prepare(
      `SELECT u.id, u.first_name, u.last_name, r.abbr AS rank_abbr, um.billet FROM unit_members um JOIN users u ON u.id = um.user_id
         LEFT JOIN ranks r ON r.id = u.rank_id WHERE um.unit_id = ? AND u.active = 1 ORDER BY r.sort DESC, u.last_name`
    ).all(unitId) as Array<{ id: string; first_name: string; last_name: string; rank_abbr: string | null; billet: string | null }>;
    members = people.map((m) => {
      const held = open.filter((i) => i.claimed_by === m.id);
      return {
        id: m.id, name: `${m.first_name} ${m.last_name}`, rank_abbr: m.rank_abbr, billet: m.billet,
        assigned: held.length,
        waiting: held.filter((i) => stageOf(i) === 'waiting').length,
        blocked: held.filter((i) => stageOf(i) === 'blocked').length,
        overdue: held.filter((i) => i.due_date && i.due_date < today).length,
        ...contributionCounts(ctx, m.id, w, unitId),
        last_recorded_at: (ctx.db.prepare('SELECT MAX(occurred_at) AS at FROM work_events WHERE actor_id = ? AND unit_id = ?').get(m.id, unitId) as { at: string | null }).at,
      };
    });
    audit(ctx, { actor_id: user.id, action: 'view_team_workload', entity: 'unit', entity_id: unitId, unit_id: unitId, detail: `${w.from}..${w.to}` });
  }

  return {
    unit_id: unitId, window: w, section, unassigned, attention, members, members_visible: includeMembers,
    definitions: CONTRIBUTION_DEFINITIONS, limitations: WORKLOAD_LIMITATIONS,
  };
}

/* ── Private accomplishment drafts ─────────────────────────────────────────────────────────── */

interface Fact { text: string; date: string; source: { kind: string; event_id: string } }

interface DraftRow { id: string; user_id: string; work_item_id: string | null; title: string; facts: string; wording: string; wording_source: string; activity_id: string | null; version: number; created_at: string; updated_at: string }

const draftRow = (ctx: AppContext, userId: string, id: string) => {
  const row = ctx.db.prepare('SELECT * FROM record_drafts WHERE id = ? AND deleted_at IS NULL').get(id) as DraftRow | undefined;
  // Owner-only. A draft that is not yours does not exist, whatever your role.
  if (!row || row.user_id !== userId) throw notFound('No such draft.');
  return { ...row, facts: JSON.parse(row.facts || '[]') as Fact[] };
};

export function listDrafts(ctx: AppContext, user: SessionUser) {
  return (ctx.db.prepare('SELECT * FROM record_drafts WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC').all(user.id) as Array<Record<string, any>>)
    .map((r) => ({ ...r, facts: JSON.parse(r.facts || '[]') }));
}

/**
 * Builds a draft from the facts on one work item that this person recorded themselves. The facts
 * are cited to their events and never edited; the wording is a starting point the person owns.
 */
export function draftFromWork(ctx: AppContext, user: SessionUser, _scope: Scope, itemId: string) {
  const item = ctx.db.prepare('SELECT * FROM work_items WHERE id = ? AND deleted_at IS NULL').get(itemId) as ItemRow | undefined;
  if (!item) throw notFound('No such work item.');
  const events = eventsFor(ctx, itemId);
  const mine = events.filter((e) => e.actor_id === user.id);
  if (!mine.length) throw forbidden('A draft is built from your own recorded work, and you have none on this item.');
  const superseded = new Set(events.map((e) => e.supersedes_id).filter(Boolean));
  const facts: Fact[] = [];
  const mineStanding = mine.filter((e) => !superseded.has(e.id));
  for (const e of mineStanding) {
    const body = JSON.parse(e.body || '{}');
    const date = e.occurred_at.slice(0, 10);
    const cite = { kind: e.kind, event_id: e.id };
    if (e.kind === 'observation') facts.push({ text: `Recorded ${String(body.label || humanKey(body.field)).toLowerCase()}: ${body.display}${body.system ? ` (${body.system})` : ''}`, date, source: cite });
    else if (e.kind === 'calculation') facts.push({ text: `Calculated a candidate award adjustment of ${body.display}`, date, source: cite });
    else if (e.kind === 'decision') facts.push({ text: `Decided ${humanKey(body.decision).toLowerCase()}: ${humanKey(body.choice).toLowerCase()}`, date, source: cite });
    else if (e.kind === 'action_submitted') facts.push({ text: `Submitted ${humanKey(e.step).toLowerCase()}${body.reference ? ` (${body.reference})` : ''}`, date, source: cite });
    else if (e.kind === 'verification' && body.result === 'verified') facts.push({ text: `Verified ${humanKey(body.check).toLowerCase()} (${body.reference})`, date, source: cite });
    else if (e.kind === 'finding') facts.push({ text: `Finding: ${body.text}`, date, source: cite });
    else if (e.kind === 'resolved') facts.push({ text: 'Resolved the work item', date, source: cite });
    else if (e.kind === 'handed_off') facts.push({ text: `Handed the work on with a note`, date, source: cite });
  }
  // Collaborators are named because the work was shared; their contributions are not claimed.
  const others = [...new Set(events.filter((e) => e.actor_id && e.actor_id !== user.id && !['claimed', 'released', 'created', 'procedure_applied'].includes(e.kind)).map((e) => e.actor_id!))];
  const names = others.length
    ? (ctx.db.prepare(`SELECT u.first_name, u.last_name, r.abbr FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (${others.map(() => '?').join(',')})`).all(...others) as Array<{ first_name: string; last_name: string; abbr: string | null }>)
      .map((p) => [p.abbr, p.first_name, p.last_name].filter(Boolean).join(' '))
    : [];
  const title = `${item.reference || item.natural_key}: ${item.title}`.slice(0, 300);
  const wording = templateWording(item, facts, names);
  const id = newId();
  const at = now();
  ctx.db.prepare(
    `INSERT INTO record_drafts (id, user_id, work_item_id, title, facts, wording, wording_source, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'template', 1, ?, ?)`
  ).run(id, user.id, itemId, title, JSON.stringify(facts.slice(0, 40)), wording, at, at);
  return { ...draftRow(ctx, user.id, id), collaborators: names };
}

/** Assembled from the facts, not generated. Labelled as a suggestion the person edits. */
function templateWording(item: ItemRow, facts: Fact[], collaborators: string[]): string {
  const has = (prefix: string) => facts.some((f) => f.text.startsWith(prefix));
  const verbs: string[] = [];
  if (has('Recorded')) verbs.push('researched the award and invoice values');
  const calc = facts.find((f) => f.text.startsWith('Calculated'));
  if (calc) verbs.push(`identified ${calc.text.replace('Calculated ', '')}`);
  if (has('Submitted')) verbs.push('submitted the required actions');
  if (has('Verified')) verbs.push('verified the outcome in the system of record');
  if (has('Resolved')) verbs.push('closed the case');
  const doc = item.reference || item.natural_key;
  const body = verbs.length ? verbs.join(', ').replace(/, ([^,]*)$/, ', and $1') : 'contributed to the work';
  const withWhom = collaborators.length ? ` Worked alongside ${collaborators.join(', ')}.` : '';
  return `On ${doc} (${item.title}), ${body}.${withWhom}`;
}

export function updateDraft(ctx: AppContext, user: SessionUser, id: string, body: unknown) {
  const input = parse(draftUpdateSchema, body);
  const row = draftRow(ctx, user.id, id);
  if (input.version != null && input.version !== row.version) throw conflict('This draft changed in another window. Reload it.', 'version_conflict');
  const wordingChanged = input.wording !== undefined && input.wording !== row.wording;
  ctx.db.prepare('UPDATE record_drafts SET title = ?, wording = ?, wording_source = ?, version = version + 1, updated_at = ? WHERE id = ?')
    .run(input.title ?? row.title, input.wording ?? row.wording, wordingChanged ? 'person' : row.wording_source, now(), id);
  return draftRow(ctx, user.id, id);
}

/** Keeps a draft as a private entry in the person's own record. Nothing is sent anywhere. */
export function saveDraftToRecord(ctx: AppContext, user: SessionUser, id: string) {
  const row = draftRow(ctx, user.id, id);
  if (row.activity_id) throw conflict('This draft is already in your record.');
  const date = row.facts.map((f) => f.date).sort().at(-1) || now().slice(0, 10);
  const activityId = newId();
  const at = now();
  ctx.db.transaction(() => {
    ctx.db.prepare(
      `INSERT INTO activities (id, user_id, unit_id, visibility, date, title, category, result, status, notes, evidence_links, fingerprint, version, created_at, updated_at)
       VALUES (?, ?, NULL, 'private', ?, ?, NULL, ?, 'completed', ?, '[]', ?, 1, ?, ?)`
    ).run(activityId, user.id, date, row.title.slice(0, 300), row.wording.slice(0, 2000),
      ['Facts from recorded work:', ...row.facts.map((f) => `- ${f.date}: ${f.text}`)].join('\n').slice(0, 8000),
      `draft:${id}`, at, at);
    ctx.db.prepare('UPDATE record_drafts SET activity_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(activityId, at, id);
  })();
  return { draft: draftRow(ctx, user.id, id), activity_id: activityId };
}

export function deleteDraft(ctx: AppContext, user: SessionUser, id: string) {
  draftRow(ctx, user.id, id);
  ctx.db.prepare('UPDATE record_drafts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
}

/* ── Career ────────────────────────────────────────────────────────────────────────────────── */

export function careerOverview(ctx: AppContext, user: SessionUser) {
  const profile = ctx.db.prepare(
    `SELECT u.first_name, u.last_name, u.rank_id, r.name AS rank_name, r.grade, u.mos, u.eas FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id = ?`
  ).get(user.id) as Record<string, unknown>;
  const billet = ctx.db.prepare('SELECT um.billet, u.name AS unit_name FROM unit_members um JOIN units u ON u.id = um.unit_id WHERE um.user_id = ? ORDER BY um.is_primary DESC LIMIT 1').get(user.id) as { billet: string | null; unit_name: string } | undefined;
  const plan = ctx.db.prepare('SELECT military_goal, civilian_interests, updated_at FROM career_profiles WHERE user_id = ?').get(user.id) || null;
  const readiness = ctx.db.prepare('SELECT pme_complete, degree, college_credits, ceus, rifle_qual, mcmap_belt, pft_score, cft_score FROM readiness WHERE user_id = ?').get(user.id) || null;
  const steps = ctx.db.prepare(`SELECT * FROM career_steps WHERE user_id = ? AND deleted_at IS NULL ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'planned' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, (due_date IS NULL), due_date, created_at`).all(user.id);
  const training = ctx.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(hours), 0) AS hours FROM trainings WHERE user_id = ? AND deleted_at IS NULL AND status = 'completed'`).get(user.id);
  return { profile: { ...profile, billet: billet?.billet || null, unit_name: billet?.unit_name || null }, plan, readiness, steps, training };
}

export function saveCareerProfile(ctx: AppContext, user: SessionUser, input: { military_goal: string | null; civilian_interests: string | null }) {
  ctx.db.prepare(
    `INSERT INTO career_profiles (user_id, military_goal, civilian_interests, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET military_goal = excluded.military_goal, civilian_interests = excluded.civilian_interests, updated_at = excluded.updated_at`
  ).run(user.id, input.military_goal, input.civilian_interests, now());
  return careerOverview(ctx, user);
}

const stepRow = (ctx: AppContext, userId: string, id: string) => {
  const row = ctx.db.prepare('SELECT * FROM career_steps WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, any> | undefined;
  if (!row || row.user_id !== userId) throw notFound('No such career step.');
  return row;
};

export function saveCareerStep(ctx: AppContext, user: SessionUser, id: string | null, input: Record<string, any>) {
  const at = now();
  if (id) {
    const row = stepRow(ctx, user.id, id);
    if (input.version != null && input.version !== row.version) throw conflict('This step changed in another window. Reload it.', 'version_conflict');
    ctx.db.prepare(
      `UPDATE career_steps SET title = ?, category = ?, status = ?, due_date = ?, notes = ?, source_label = ?, source_url = ?, source_checked_on = ?, version = version + 1, updated_at = ? WHERE id = ?`
    ).run(input.title, input.category, input.status, input.due_date, input.notes, input.source_label, input.source_url, input.source_checked_on, at, id);
    return stepRow(ctx, user.id, id);
  }
  const newStepId = newId();
  ctx.db.prepare(
    `INSERT INTO career_steps (id, user_id, title, category, status, due_date, notes, source_label, source_url, source_checked_on, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
  ).run(newStepId, user.id, input.title, input.category, input.status, input.due_date, input.notes, input.source_label, input.source_url, input.source_checked_on, at, at);
  return stepRow(ctx, user.id, newStepId);
}

export function deleteCareerStep(ctx: AppContext, user: SessionUser, id: string) {
  stepRow(ctx, user.id, id);
  ctx.db.prepare('UPDATE career_steps SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
}

