import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, scopeFor, PERMISSIONS } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { notify } from './notifications.ts';
import {
  STAGE_TO_STATE, STATE_TO_STAGE, CLOSED_STAGES, RESEARCH_KINDS, entrySchema, stageChangeSchema, handoffSchema,
  type Stage, type EntryInput, type WaitingCategory,
} from '../../shared/caseModel.ts';
import {
  procedureFor, progress, candidateAdjustment, latestFundsCheck, latestVerification, observationCents, UMT_FORMULA,
  type CaseEvent,
} from '../../shared/procedures.ts';
import { formatCents } from '../../shared/money.ts';
import { parse } from '../lib/http.ts';
import {
  getItem, mayClaim, mayReassign, mayResolve, mayProgress, mayAct, readable, type WorkItemRow,
} from './work.ts';

/**
 * The case: one work item's append-only history and the rules that keep its distinctions honest.
 *
 * Every change to who holds the work or where it stands writes an event in the same transaction as
 * the change itself, so the history cannot drift from the row. Research, decisions, submissions,
 * system observations, funds checks and verifications are events too, each validated by kind.
 */

export interface EventRow {
  id: string; work_item_id: string; unit_id: string | null; actor_id: string | null; kind: string; step: string | null;
  subject_id: string | null; body: string; supersedes_id: string | null; correlation_id: string | null;
  idempotency_key: string | null; occurred_at: string; created_at: string;
}

export interface AppendInput {
  item: Pick<WorkItemRow, 'id' | 'unit_id'>;
  actorId: string | null;
  kind: string;
  step?: string | null;
  subjectId?: string | null;
  body?: Record<string, unknown>;
  supersedesId?: string | null;
  occurredAt?: string | null;
  idempotencyKey?: string | null;
  correlationId?: string | null;
}

/** Writes one event. Callers run it inside the same transaction as the change it describes. */
export function appendEvent(ctx: AppContext, e: AppendInput): EventRow {
  const id = newId();
  const at = now();
  ctx.db.prepare(
    `INSERT INTO work_events (id, work_item_id, unit_id, actor_id, kind, step, subject_id, body, supersedes_id, correlation_id, idempotency_key, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, e.item.id, e.item.unit_id, e.actorId, e.kind, e.step ?? null, e.subjectId ?? null, JSON.stringify(e.body ?? {}),
    e.supersedesId ?? null, e.correlationId ?? null, e.idempotencyKey ?? null, e.occurredAt || at, at);
  return ctx.db.prepare('SELECT * FROM work_events WHERE id = ?').get(id) as EventRow;
}

export const toCaseEvent = (r: EventRow): CaseEvent => ({
  id: r.id, kind: r.kind, actor_id: r.actor_id, occurred_at: r.occurred_at, supersedes_id: r.supersedes_id,
  body: { ...(JSON.parse(r.body || '{}') as Record<string, unknown>), step: r.step ?? undefined },
});

export function eventsFor(ctx: AppContext, itemId: string): EventRow[] {
  // Insertion order is the order things happened on the server. occurred_at can be backdated (an
  // observation read yesterday), so it is shown but does not reorder the history.
  return ctx.db.prepare('SELECT * FROM work_events WHERE work_item_id = ? ORDER BY created_at, rowid').all(itemId) as EventRow[];
}

export const stageOf = (row: Pick<WorkItemRow, 'state'> & { stage?: string | null }): Stage =>
  (row.stage as Stage) || STATE_TO_STAGE[row.state] || 'not_started';

/* ── Reading a case ────────────────────────────────────────────────────────────────────────── */

export function caseView(ctx: AppContext, user: SessionUser, scope: Scope, row: WorkItemRow & { stage?: string | null; procedure_key?: string | null; procedure_version?: string | null; waiting_category?: string | null; waiting_since?: string | null; blocked_reason?: string | null }) {
  const events = eventsFor(ctx, row.id);
  const people = peopleFor(ctx, [...events.flatMap((e) => [e.actor_id, e.subject_id]), row.claimed_by, row.owner_id]);
  const procedure = procedureFor(row.procedure_key);
  const caseEvents = events.map(toCaseEvent);
  const stage = stageOf(row);
  const prog = procedure ? progress(procedure, caseEvents, { reference: row.reference, stage }) : null;
  const calc = caseEvents.filter((e) => e.kind === 'calculation').at(-1) || null;
  const funds = latestFundsCheck(caseEvents);
  const superseded = new Set(events.map((e) => e.supersedes_id).filter(Boolean));
  return {
    stage,
    waiting: row.waiting_category ? { category: row.waiting_category, since: row.waiting_since } : null,
    blocked_reason: row.blocked_reason || null,
    procedure: procedure ? { ...procedure, pinned_version: row.procedure_version || procedure.version } : null,
    progress: prog,
    latest_calculation: calc ? { id: calc.id, ...calc.body } : null,
    latest_funds_check: funds ? { id: funds.id, ...funds.body } : null,
    events: events.map((e) => ({
      id: e.id, kind: e.kind, step: e.step, actor_id: e.actor_id, subject_id: e.subject_id,
      body: JSON.parse(e.body || '{}'), supersedes_id: e.supersedes_id, superseded: superseded.has(e.id),
      occurred_at: e.occurred_at, created_at: e.created_at,
    })),
    people,
    contributors: contributorsFromEvents(events, people),
    permissions: {
      claim: mayClaim(scope, user, row),
      act: mayAct(scope, user, row),
      progress: mayProgress(scope, user, row),
      resolve: mayResolve(scope, user, row),
      reassign: mayReassign(scope, user, row),
      hand_off: row.claimed_by === user.id || mayReassign(scope, user, row),
    },
  };
}

function peopleFor(ctx: AppContext, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter(Boolean) as string[])];
  if (!unique.length) return {} as Record<string, { id: string; name: string; rank: string | null }>;
  const rows = ctx.db.prepare(
    `SELECT u.id, u.first_name, u.last_name, r.abbr AS rank FROM users u LEFT JOIN ranks r ON r.id = u.rank_id WHERE u.id IN (${unique.map(() => '?').join(',')})`
  ).all(...unique) as Array<{ id: string; first_name: string; last_name: string; rank: string | null }>;
  return Object.fromEntries(rows.map((p) => [p.id, { id: p.id, name: `${p.first_name} ${p.last_name}`, rank: p.rank }]));
}

/**
 * Each person's own contribution to this item. Four people touching one document credits each of
 * them with what they did, and never with each other's work.
 */
function contributorsFromEvents(events: EventRow[], people: Record<string, { id: string; name: string; rank: string | null }>) {
  const by = new Map<string, { user_id: string; research: number; submitted: number; verified: number; handoffs: number; resolved: number; actions: number; first_at: string; last_at: string }>();
  for (const e of events) {
    if (!e.actor_id) continue;
    const c = by.get(e.actor_id) || { user_id: e.actor_id, research: 0, submitted: 0, verified: 0, handoffs: 0, resolved: 0, actions: 0, first_at: e.occurred_at, last_at: e.occurred_at };
    const body = JSON.parse(e.body || '{}');
    if (RESEARCH_KINDS.includes(e.kind as never)) c.research += 1;
    if (e.kind === 'action_submitted') c.submitted += 1;
    if (e.kind === 'verification' && body.result === 'verified') c.verified += 1;
    if (e.kind === 'handed_off') c.handoffs += 1;
    if (e.kind === 'resolved') c.resolved += 1;
    if (!['claimed', 'released', 'assigned', 'claim_expired', 'created', 'procedure_applied'].includes(e.kind)) c.actions += 1;
    if (e.occurred_at < c.first_at) c.first_at = e.occurred_at;
    if (e.occurred_at > c.last_at) c.last_at = e.occurred_at;
    by.set(e.actor_id, c);
  }
  return [...by.values()]
    .filter((c) => c.actions > 0)
    .map((c) => ({ ...c, name: people[c.user_id]?.name || 'Former member', rank: people[c.user_id]?.rank || null }))
    .sort((a, b) => b.actions - a.actions);
}

/* ── Writing to a case ─────────────────────────────────────────────────────────────────────── */

function load(ctx: AppContext, user: SessionUser, scope: Scope, id: string) {
  const row = getItem(ctx, id) as (WorkItemRow & { stage?: string | null; procedure_key?: string | null; waiting_category?: string | null; waiting_since?: string | null }) | null;
  if (!row) throw notFound('No such work item.');
  if (!readable(scope, user, row)) throw forbidden('That work is not yours to open.');
  return row;
}

const checkVersion = (row: { version: number }, expected: number | null | undefined) => {
  if (expected != null && row.version !== expected) throw conflict('This work changed while you were looking at it. Reload to see what changed, then try again.', 'version_conflict');
};

/** A research or execution entry. The person must be working the case (or be the leader who may). */
export function recordEntry(ctx: AppContext, user: SessionUser, scope: Scope, id: string, body: unknown, idempotencyKey: string | null) {
  const input = parse(entrySchema, body) as EntryInput;
  const scopedKey = idempotencyKey ? `${user.id}:${id}:${idempotencyKey}` : null;
  if (scopedKey) {
    const prior = ctx.db.prepare('SELECT * FROM work_events WHERE idempotency_key = ?').get(scopedKey) as EventRow | undefined;
    if (prior) return { event: prior, replayed: true };
  }

  return ctx.db.transaction(() => {
    const row = load(ctx, user, scope, id);
    if (!mayAct(scope, user, row)) throw forbidden('Pick this work up before recording on it.');
    const stage = stageOf(row);
    if (CLOSED_STAGES.has(stage)) throw conflict('This work is closed. Reopen it before recording more.', 'closed');
    const events = eventsFor(ctx, id).map(toCaseEvent);
    const procedure = procedureFor(row.procedure_key);
    const payload: Record<string, unknown> = { ...input };
    delete payload.kind; delete payload.supersedes; delete payload.step;

    if (input.supersedes) {
      const target = events.find((e) => e.id === input.supersedes);
      if (!target) throw badRequest('That entry is not on this work item.');
      if (target.kind !== input.kind) throw badRequest('A correction replaces an entry of the same kind.');
      if (events.some((e) => e.supersedes_id === input.supersedes)) throw conflict('That entry was already corrected. Correct the newer entry instead.');
    }

    switch (input.kind) {
      case 'observation': {
        const cents = observationCents(input.amount);
        if (cents && !cents.ok) throw badRequest(cents.error, { fieldErrors: { amount: cents.error } });
        const field = procedure?.steps.flatMap((s) => s.fields || []).find((f) => f.key === input.field);
        if (field?.money && !cents) throw badRequest(`${field.label} needs an amount.`, { fieldErrors: { amount: 'Required.' } });
        if (!cents && !input.value_text) throw badRequest('Record a value: an amount or what you saw.');
        delete payload.amount;
        if (cents?.ok) { payload.amount_cents = cents.cents; payload.currency = 'USD'; payload.display = formatCents(cents.cents); }
        else payload.display = input.value_text;
        payload.label = input.label || field?.label || null;
        // A figure somebody read off DAI is a manual observation of an authoritative system. It is
        // not an authoritative integration, and it is never labelled as one.
        payload.source = 'manual_observation';
        break;
      }
      case 'decision': {
        const decisionStep = procedure?.steps.find((s) => s.decision?.key === input.decision);
        if (decisionStep && !decisionStep.decision!.choices.some((c) => c.key === input.choice)) {
          throw badRequest('That is not one of the choices for this decision.');
        }
        break;
      }
      case 'action_submitted': {
        const step = procedure?.steps.find((s) => s.key === input.step);
        if (step?.key === 'submit_modification') {
          // A failed or inconclusive control cannot silently permit submission.
          const check = latestFundsCheck(events);
          const result = check?.body.result as string | undefined;
          if (!check || result === 'FAILED' || result === 'NOT_RUN' || result === 'UNKNOWN') {
            throw conflict(
              !check ? 'Record the funds check before submitting.' : `The latest funds check is ${result}. Resolve it and record a new check before submitting.`,
              'control_not_passed',
            );
          }
          if (result === 'WARNING' && !input.control_acknowledgement) {
            throw conflict('The latest funds check returned a warning. Say what the warning was and why submission is still right.', 'control_warning', { fieldErrors: { control_acknowledgement: 'Required after a warning.' } });
          }
          payload.funds_check_id = check.id;
          payload.funds_check_result = result;
        }
        delete payload.then_wait;
        break;
      }
      case 'verification': {
        if (input.result === 'verified' && !input.reference) {
          throw badRequest('Say what you checked: a verified result needs a reference.', { fieldErrors: { reference: 'Required for a verified result.' } });
        }
        break;
      }
      default: break;
    }

    const event = appendEvent(ctx, {
      item: row, actorId: user.id, kind: input.kind, step: 'step' in input ? input.step ?? null : null,
      body: payload, supersedesId: input.supersedes ?? null, idempotencyKey: scopedKey,
      occurredAt: 'observed_on' in input && input.observed_on ? `${input.observed_on}T12:00:00.000Z` : null,
    });

    let next: Stage | null = null;
    if (stage === 'not_started') next = 'researching';
    if (input.kind === 'action_submitted') next = input.then_wait ? 'waiting' : 'submitted';
    if (next && next !== stage) {
      moveStage(ctx, row, user.id, next, { reason: null, category: input.kind === 'action_submitted' ? (input.then_wait ?? null) : null, correlationId: event.id });
    } else {
      ctx.db.prepare('UPDATE work_items SET version = version + 1, updated_at = ? WHERE id = ?').run(now(), id);
    }
    return { event, replayed: false };
  })();
}

/**
 * The one place a stage changes. Keeps state in step, opens and closes waiting intervals, and
 * writes the events that record each of those as its own fact.
 */
function moveStage(
  ctx: AppContext,
  row: WorkItemRow & { stage?: string | null; waiting_category?: string | null; waiting_since?: string | null },
  actorId: string | null,
  to: Stage,
  opts: { reason: string | null; category: WaitingCategory | null; expectedBy?: string | null; correlationId?: string | null },
) {
  const from = stageOf(row);
  const at = now();
  if (from === 'waiting' && row.waiting_category && (to !== 'waiting' || opts.category !== row.waiting_category)) {
    const hours = row.waiting_since ? Math.max(0, (Date.parse(at) - Date.parse(row.waiting_since)) / 3_600_000) : null;
    appendEvent(ctx, { item: row, actorId, kind: 'waiting_ended', body: { category: row.waiting_category, since: row.waiting_since, elapsed_hours: hours == null ? null : Math.round(hours * 10) / 10 }, correlationId: opts.correlationId });
  }
  appendEvent(ctx, { item: row, actorId, kind: 'stage_changed', body: { from, to, reason: opts.reason }, correlationId: opts.correlationId });
  if (to === 'waiting' && (from !== 'waiting' || opts.category !== row.waiting_category)) {
    appendEvent(ctx, { item: row, actorId, kind: 'waiting_started', body: { category: opts.category, expected_by: opts.expectedBy ?? null }, correlationId: opts.correlationId });
  }
  if (to === 'resolved') appendEvent(ctx, { item: row, actorId, kind: 'resolved', body: { reason: opts.reason }, correlationId: opts.correlationId });
  if (CLOSED_STAGES.has(from) && !CLOSED_STAGES.has(to)) appendEvent(ctx, { item: row, actorId, kind: 'reopened', body: { reason: opts.reason }, correlationId: opts.correlationId });

  const waiting = to === 'waiting';
  ctx.db.prepare(
    `UPDATE work_items SET stage = ?, state = ?, waiting_category = ?, waiting_since = ?, blocked_reason = ?,
            resolved_at = ?, version = version + 1, updated_at = ? WHERE id = ?`
  ).run(
    to, STAGE_TO_STATE[to],
    waiting ? opts.category : null,
    waiting ? (from === 'waiting' && opts.category === row.waiting_category ? row.waiting_since : at) : null,
    to === 'blocked' ? opts.reason : null,
    to === 'resolved' ? at : null,
    at, row.id,
  );
}

export function changeStage(ctx: AppContext, user: SessionUser, scope: Scope, id: string, body: unknown) {
  const input = parse(stageChangeSchema, body);
  return ctx.db.transaction(() => {
    const row = load(ctx, user, scope, id);
    checkVersion(row, input.version);
    const from = stageOf(row);
    const to = input.stage;
    const closing = CLOSED_STAGES.has(to);
    const reopening = CLOSED_STAGES.has(from) && !closing;
    if (closing || reopening) {
      if (!mayResolve(scope, user, row)) throw forbidden(closing ? 'You can work this but closing it out is not yours to do.' : 'Reopening closed work is not yours to do.');
    } else if (!mayProgress(scope, user, row)) {
      throw forbidden('Pick this work up before moving it.');
    }
    if (from === to && !(to === 'waiting' && input.waiting_category && input.waiting_category !== row.waiting_category)) {
      throw badRequest('The work is already at that stage.');
    }
    if (to === 'waiting' && !input.waiting_category) throw badRequest('Say what the work is waiting on.', { fieldErrors: { waiting_category: 'Required.' } });
    if (to === 'blocked' && !input.reason) throw badRequest('Say what is blocking it.', { fieldErrors: { reason: 'Required.' } });
    if (to === 'resolved') {
      const procedure = procedureFor(row.procedure_key);
      if (procedure) {
        // Following every step is not the same as the condition clearing. Resolution waits on the
        // verification that says it did.
        const cleared = latestVerification(eventsFor(ctx, id).map(toCaseEvent), 'condition_cleared');
        if (!cleared || cleared.body.result !== 'verified') {
          throw conflict('Verify the original condition cleared before resolving this.', 'verification_required');
        }
      }
    }
    moveStage(ctx, row, user.id, to, { reason: input.reason ?? null, category: (input.waiting_category ?? null) as WaitingCategory | null, expectedBy: input.expected_by ?? null });
    if (closing || reopening) audit(ctx, { actor_id: user.id, action: closing ? 'work_closed' : 'work_reopened', entity: 'work_items', entity_id: id, unit_id: row.unit_id, detail: to });
    return getItem(ctx, id)!;
  })();
}

/**
 * Handing work to a teammate. The person holding it may pass it on; a leader who can reassign may
 * move anybody's. Either way the receiver must be able to see the work and pick it up on their own
 * authority, and the history says who passed it, to whom, and what they said.
 */
export function handOff(ctx: AppContext, user: SessionUser, scope: Scope, id: string, body: unknown) {
  const input = parse(handoffSchema, body);
  return ctx.db.transaction(() => {
    const row = load(ctx, user, scope, id);
    checkVersion(row, input.version);
    if (CLOSED_STAGES.has(stageOf(row))) throw conflict('This work is closed.');
    const holding = row.claimed_by === user.id;
    if (!holding && !mayReassign(scope, user, row)) throw forbidden('Only the person holding this work, or a leader who can reassign it, can hand it off.');
    if (input.to_user_id === row.claimed_by) throw badRequest('That person already holds this work.');
    const target = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(input.to_user_id) as SessionUser | undefined;
    if (!target) throw badRequest('No such person to hand this to.');
    const targetScope = scopeFor(ctx, target);
    if (!readable(targetScope, target, row) || !mayClaim(targetScope, target, row)) {
      throw badRequest(`${target.first_name} ${target.last_name} cannot pick this work up, so it cannot be handed to them.`);
    }
    const at = now();
    const fromHolder = row.claimed_by;
    ctx.db.prepare(
      `UPDATE work_items SET claimed_by = ?, claimed_at = ?, version = version + 1, updated_at = ? WHERE id = ?`
    ).run(target.id, at, at, id);
    appendEvent(ctx, { item: row, actorId: user.id, kind: 'handed_off', subjectId: target.id, body: { note: input.note, from: fromHolder } });
    if (stageOf(row) === 'not_started') moveStage(ctx, getItem(ctx, id)!, user.id, 'researching', { reason: null, category: null });
    audit(ctx, { actor_id: user.id, action: 'work_handed_off', entity: 'work_items', entity_id: id, subject_id: target.id, unit_id: row.unit_id });
    notify(ctx, target.id, {
      kind: 'work_assigned', title: `${user.first_name} ${user.last_name} handed you work`,
      message: `${row.reference || row.title}: ${input.note}`.slice(0, 200), actionUrl: `/work/items/${id}`, dedupeKey: `work-handoff:${id}:${at}`,
    });
    return getItem(ctx, id)!;
  })();
}

/** Runs the procedure's candidate calculation over what is on the record, and records it with its inputs. */
export function calculate(ctx: AppContext, user: SessionUser, scope: Scope, id: string) {
  return ctx.db.transaction(() => {
    const row = load(ctx, user, scope, id);
    if (!mayAct(scope, user, row)) throw forbidden('Pick this work up before calculating on it.');
    if (!procedureFor(row.procedure_key)) throw badRequest('This work does not follow a procedure with a calculation.');
    const result = candidateAdjustment(eventsFor(ctx, id).map(toCaseEvent));
    if (!result.ok) throw badRequest(`Record the ${result.missing.join(', ')} first.`, { missing: result.missing });
    const event = appendEvent(ctx, {
      item: row, actorId: user.id, kind: 'calculation', step: 'calculate',
      body: { ...result, title: UMT_FORMULA.title, formula_text: UMT_FORMULA.text, applicability: UMT_FORMULA.applicability, source: 'calculated' },
    });
    if (stageOf(row) === 'not_started') moveStage(ctx, row, user.id, 'researching', { reason: null, category: null, correlationId: event.id });
    else ctx.db.prepare('UPDATE work_items SET version = version + 1, updated_at = ? WHERE id = ?').run(now(), id);
    return event;
  })();
}

/**
 * Puts a work item under a procedure, pinned to the version current now. If the row came off a
 * sheet with an amount, that amount enters the case as a source-file observation, labelled as such,
 * so the calculation can cite it without anybody retyping it.
 */
export function applyProcedure(ctx: AppContext, user: SessionUser | null, scope: Scope | null, id: string, key: string) {
  const procedure = procedureFor(key);
  if (!procedure) throw badRequest('No such procedure.');
  return ctx.db.transaction(() => {
    const row = user && scope ? load(ctx, user, scope, id) : getItem(ctx, id);
    if (!row) throw notFound('No such work item.');
    if (user && scope && !(mayAct(scope, user, row) || can(scope, PERMISSIONS.EDIT_WORK, row.unit_id))) throw forbidden('Applying a procedure to this work is not yours to do.');
    ctx.db.prepare('UPDATE work_items SET procedure_key = ?, procedure_version = ?, version = version + 1, updated_at = ? WHERE id = ?').run(procedure.key, procedure.version, now(), id);
    appendEvent(ctx, { item: row, actorId: user?.id ?? null, kind: 'procedure_applied', body: { procedure: procedure.key, version: procedure.version, authority: procedure.authority } });
    const cents = row.amount == null ? null : observationCents(String(row.amount));
    const hasUmt = procedure.steps.some((s) => s.fields?.some((f) => f.key === 'umt_amount'));
    if (hasUmt && cents?.ok) {
      appendEvent(ctx, {
        item: row, actorId: null, kind: 'observation', step: 'identify',
        body: { field: 'umt_amount', label: 'UMT source amount', amount_cents: cents.cents, currency: 'USD', display: formatCents(cents.cents), source: 'source_file', system: row.source_file_id ? 'Imported sheet' : 'Entered with the work' },
      });
    }
    return getItem(ctx, id)!;
  })();
}
