import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { PERMISSIONS, unitsWith, scopeFor } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { notify } from './notifications.ts';

export const TICKET_STATES = ['open', 'in_progress', 'waiting_on_requester', 'resolved', 'closed'] as const;
export const TICKET_CATEGORIES = ['sign_in', 'account', 'data', 'bug', 'request', 'other'] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export interface TicketRow {
  id: string; requester_id: string | null; requester_email: string | null; requester_name: string | null;
  unit_id: string | null; subject: string; category: string; state: string; priority: string;
  assigned_to: string | null; resolved_at: string | null; closed_at: string | null;
  version: number; deleted_at: string | null; created_at: string; updated_at: string;
}

const supportUnits = (scope: Scope) => unitsWith(scope, PERMISSIONS.VIEW_SUPPORT);

export const worksQueue = (user: SessionUser, scope: Scope) =>
  Boolean(user.is_operator) || supportUnits(scope).length > 0;

/** Whether this person may work *this* ticket. */
export const worksTicket = (user: SessionUser, scope: Scope, row: Pick<TicketRow, 'unit_id'>) =>
  Boolean(user.is_operator) || (Boolean(row.unit_id) && supportUnits(scope).includes(row.unit_id!));

export function raiseTicket(
  ctx: AppContext,
  input: { subject: string; body: string; category?: string; requester_email?: string | null; requester_name?: string | null; unit_id?: string | null },
  user?: SessionUser | null,
  ip?: string,
) {
  const subject = String(input.subject || '').trim();
  if (!subject) throw badRequest('Say what the problem is.', { fieldErrors: { subject: 'Required.' } });
  if (subject.length > 200) throw badRequest('Keep the subject under 200 characters.', { fieldErrors: { subject: 'Limit 200 characters.' } });
  const body = String(input.body || '').trim();
  if (!body) throw badRequest('Describe what happened.', { fieldErrors: { body: 'Required.' } });
  if (body.length > 8000) throw badRequest('Keep the description under 8000 characters.');

  const category = (TICKET_CATEGORIES as readonly string[]).includes(String(input.category)) ? String(input.category) : 'other';
  if (input.unit_id && !(user && ctx.db.prepare('SELECT 1 FROM unit_members WHERE user_id = ? AND unit_id = ?').get(user.id, input.unit_id))) {
    throw badRequest('Send the request to a unit you belong to.', { fieldErrors: { unit_id: 'Not one of your units.' } });
  }
  const email = user?.email || (input.requester_email ? String(input.requester_email).trim().slice(0, 200) : null);
  const name = user ? `${user.first_name} ${user.last_name}`.trim() : (input.requester_name ? String(input.requester_name).trim().slice(0, 120) : null);

  const id = newId();
  const at = now();
  ctx.db.transaction(() => {
    ctx.db.prepare(
      `INSERT INTO support_tickets (id, requester_id, requester_email, requester_name, unit_id, subject, category, state, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'normal', ?, ?)`
    ).run(id, user?.id ?? null, email, name, input.unit_id ?? null, subject, category, at, at);
    ctx.db.prepare('INSERT INTO support_messages (id, ticket_id, author_id, body, internal, created_at) VALUES (?, ?, ?, ?, 0, ?)')
      .run(newId(), id, user?.id ?? null, body, at);
  })();

  audit(ctx, { actor_id: user?.id ?? null, action: 'support_ticket_raised', entity: 'support_ticket', entity_id: id, unit_id: input.unit_id ?? null, ip });
  for (const op of ctx.db.prepare('SELECT id FROM users WHERE is_operator = 1 AND active = 1').all() as Array<{ id: string }>) {
    notify(ctx, op.id, { kind: 'support_ticket', title: 'A new help request', message: subject.slice(0, 160), actionUrl: `/support/${id}`, dedupeKey: `ticket:${id}:${op.id}` });
  }
  return getTicket(ctx, id)!;
}

export const getTicket = (ctx: AppContext, id: string) =>
  (ctx.db.prepare('SELECT * FROM support_tickets WHERE id = ? AND deleted_at IS NULL').get(id) as TicketRow | undefined) || null;

function readable(user: SessionUser, scope: Scope, row: TicketRow) {
  return row.requester_id === user.id || worksTicket(user, scope, row);
}

export function listTickets(ctx: AppContext, user: SessionUser, scope: Scope, opts: { state?: string | null; mine?: boolean } = {}) {
  const where: string[] = ['t.deleted_at IS NULL'];
  const params: unknown[] = [];
  const units = supportUnits(scope);
  if (opts.mine || !worksQueue(user, scope)) {
    where.push('t.requester_id = ?'); params.push(user.id);
  } else if (!user.is_operator) {
    // Their own, plus the units they actually work. Never the unscoped ones.
    where.push(`(t.requester_id = ? OR t.unit_id IN (${units.map(() => '?').join(',') || 'NULL'}))`);
    params.push(user.id, ...units);
  }
  if (opts.state) { where.push('t.state = ?'); params.push(opts.state); }
  return ctx.db.prepare(
    `SELECT t.*, (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id AND m.internal = 0) AS message_count
       FROM support_tickets t WHERE ${where.join(' AND ')}
      ORDER BY CASE t.state WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'waiting_on_requester' THEN 2 ELSE 3 END, t.created_at DESC
      LIMIT 300`
  ).all(...params) as Array<TicketRow & { message_count: number }>;
}

export function ticketDetail(ctx: AppContext, user: SessionUser, scope: Scope, id: string) {
  const row = getTicket(ctx, id);
  if (!row) throw notFound('No such ticket.');
  if (!readable(user, scope, row)) throw forbidden('That ticket is not yours to read.');
  const staff = worksTicket(user, scope, row);

  const messages = ctx.db.prepare(
    `SELECT m.id, m.author_id, m.body, m.internal, m.created_at, u.username AS author_username, u.first_name, u.last_name
       FROM support_messages m LEFT JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = ? ${staff ? '' : 'AND m.internal = 0'} ORDER BY m.created_at`
  ).all(id) as Array<Record<string, unknown>>;

  return { ticket: row, messages, delivery: staff ? deliveryFor(ctx, row) : [] };
}

function deliveryFor(ctx: AppContext, row: TicketRow) {
  if (!row.requester_id && !row.requester_email) return [];
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (row.requester_id) { clauses.push('user_id = ?'); params.push(row.requester_id); }
  if (row.requester_email) { clauses.push('lower(to_address) = lower(?)'); params.push(row.requester_email); }
  return ctx.db.prepare(
    `SELECT id, to_address, kind, subject, status, error, created_at FROM email_log
      WHERE ${clauses.join(' OR ')} ORDER BY created_at DESC LIMIT 20`
  ).all(...params) as Array<Record<string, unknown>>;
}

export function replyToTicket(ctx: AppContext, user: SessionUser, scope: Scope, id: string, body: string, internal: boolean, ip?: string) {
  const row = getTicket(ctx, id);
  if (!row) throw notFound('No such ticket.');
  if (!readable(user, scope, row)) throw forbidden('That ticket is not yours.');
  const staff = worksTicket(user, scope, row);
  if (internal && !staff) throw forbidden('Only somebody working the queue can leave an internal note.');
  const text = String(body || '').trim();
  if (!text) throw badRequest('Write something first.', { fieldErrors: { body: 'Required.' } });
  if (text.length > 8000) throw badRequest('Keep a reply under 8000 characters.');

  const at = now();
  ctx.db.prepare('INSERT INTO support_messages (id, ticket_id, author_id, body, internal, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(newId(), id, user.id, text, internal ? 1 : 0, at);
  const nextState = row.state === 'resolved' || row.state === 'closed' ? row.state
    : staff && !internal ? 'waiting_on_requester'
      : row.requester_id === user.id ? 'in_progress' : row.state;
  ctx.db.prepare('UPDATE support_tickets SET state = ?, version = version + 1, updated_at = ? WHERE id = ?').run(nextState, at, id);

  if (!internal) {
    const target = staff ? row.requester_id : row.assigned_to;
    if (target && target !== user.id) {
      notify(ctx, target, { kind: 'support_reply', title: 'A reply on your help request', message: text.slice(0, 160), actionUrl: `/support/${id}`, dedupeKey: `ticket-reply:${id}:${at}` });
    }
  }
  audit(ctx, { actor_id: user.id, action: internal ? 'support_note_added' : 'support_reply_added', entity: 'support_ticket', entity_id: id, ip });
  return ticketDetail(ctx, user, scope, id);
}

export function updateTicket(
  ctx: AppContext, user: SessionUser, scope: Scope, id: string,
  patch: { state?: string; priority?: string; assigned_to?: string | null; version?: number | null }, ip?: string,
) {
  const row = getTicket(ctx, id);
  if (!row) throw notFound('No such ticket.');
  if (!worksTicket(user, scope, row)) throw forbidden('That ticket is not yours to work.');
  if (patch.version != null && row.version !== patch.version) throw conflict('This ticket changed while you were looking at it. Reload and try again.');

  const sets: string[] = ['version = version + 1', 'updated_at = ?'];
  const at = now();
  const params: unknown[] = [at];
  if (patch.state) {
    if (!(TICKET_STATES as readonly string[]).includes(patch.state)) throw badRequest('That is not a state a ticket can be in.');
    sets.push('state = ?'); params.push(patch.state);
    sets.push('resolved_at = ?'); params.push(patch.state === 'resolved' ? at : null);
    sets.push('closed_at = ?'); params.push(patch.state === 'closed' ? at : null);
  }
  if (patch.priority) {
    if (!(TICKET_PRIORITIES as readonly string[]).includes(patch.priority)) throw badRequest('That is not a priority.');
    sets.push('priority = ?'); params.push(patch.priority);
  }
  let assignedTo: string | null = null;
  if (patch.assigned_to !== undefined) {
    if (patch.assigned_to) {
      const who = ctx.db.prepare('SELECT id, is_operator FROM users WHERE id = ? AND active = 1').get(patch.assigned_to) as { id: string; is_operator: number } | undefined;
      if (!who) throw badRequest('No such person.');
      if (!worksTicket({ ...who, id: who.id } as SessionUser, scopeFor(ctx, { id: who.id }), row)) {
        throw badRequest('That person cannot work this queue, so the ticket cannot be assigned to them.');
      }
      sets.push('assigned_to = ?'); params.push(patch.assigned_to);
      if (patch.assigned_to !== row.assigned_to && patch.assigned_to !== user.id) assignedTo = patch.assigned_to;
    } else sets.push('assigned_to = NULL');
  }
  if (sets.length === 2) throw badRequest('Nothing to change.');
  ctx.db.prepare(`UPDATE support_tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  if (assignedTo) {
    notify(ctx, assignedTo, {
      kind: 'support_assigned', title: 'A help request was assigned to you',
      message: row.subject.slice(0, 160), actionUrl: `/support/${id}`, dedupeKey: `ticket-assign:${id}:${at}`,
    });
  }
  audit(ctx, { actor_id: user.id, action: 'support_ticket_updated', entity: 'support_ticket', entity_id: id, subject_id: row.requester_id, ip });
  return ticketDetail(ctx, user, scope, id);
}
