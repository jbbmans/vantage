import { Router } from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { forbidden } from '../lib/errors.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor } from '../authz/scope.ts';
import { limiters } from '../auth/limiter.ts';
import {
  raiseTicket, listTickets, ticketDetail, replyToTicket, updateTicket, worksQueue,
  TICKET_STATES, TICKET_CATEGORIES, TICKET_PRIORITIES,
} from '../services/support.ts';

/**
 * The help queue.
 *
 * Raising a ticket is split in two on purpose. The signed-in route is the ordinary case. The
 * anonymous one exists because the single most common reason to need help is that you cannot sign
 * in, and a queue you must sign in to reach is no use to the person who cannot.
 */
export const supportRouter = Router();

const raiseSchema = z.object({
  subject: z.string().max(200),
  body: z.string().max(8000),
  category: z.enum(TICKET_CATEGORIES).optional(),
  unit_id: z.string().max(64).nullable().optional(),
});

/** Open to somebody who cannot get in. Rate-limited, and it never says whether an account exists. */
export const publicSupportRouter = Router();
publicSupportRouter.post('/tickets', wrap((req, res) => {
  const q = parse(raiseSchema.extend({
    requester_email: z.string().max(200).optional(),
    requester_name: z.string().max(120).optional(),
  }), req.body);
  // The client-header check lives inside requireAuth, which this route deliberately skips, so it
  // has to be asked for here. It is not authority — there is none to borrow on an anonymous
  // endpoint — but it stops a drive-by form POST from another origin filing tickets, since a custom
  // header cannot be set cross-origin without a preflight the browser will refuse.
  if (!req.get('x-vantage-client')) throw forbidden('Request rejected: missing client header.', 'csrf');

  const ip = clientIp(req);
  const limited = limiters.supportIp.limited(ip);
  if (limited) return res.status(429).json({ error: 'Too many requests. Try again shortly.', code: 'rate_limited' });
  limiters.supportIp.bump(ip);
  const ticket = raiseTicket(req.ctx, {
    subject: q.subject, body: q.body, category: q.category,
    requester_email: q.requester_email ?? null, requester_name: q.requester_name ?? null,
  }, null, ip);
  // Deliberately thin: the person is not signed in, so they get an acknowledgement and an id and
  // nothing that could confirm whether an account exists behind the address they typed.
  return res.status(201).json({ ok: true, id: ticket.id });
}));

supportRouter.use(requireAuth);

supportRouter.get('/tickets', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.json({
    tickets: listTickets(req.ctx, req.user, scope, {
      state: typeof req.query.state === 'string' ? req.query.state : null,
      mine: req.query.mine === '1' || req.query.mine === 'true',
    }),
    works_queue: worksQueue(req.user, scope),
  });
}));

supportRouter.post('/tickets', wrap((req, res) => {
  const q = parse(raiseSchema, req.body);
  res.status(201).json(raiseTicket(req.ctx, { ...q, unit_id: q.unit_id ?? null }, req.user, clientIp(req)));
}));

supportRouter.get('/tickets/:id', wrap((req, res) => {
  res.json(ticketDetail(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id)));
}));

supportRouter.post('/tickets/:id/messages', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  res.status(201).json(replyToTicket(req.ctx, req.user, scope, String(req.params.id), String(req.body?.body ?? ''), Boolean(req.body?.internal), clientIp(req)));
}));

const patchSchema = z.object({
  state: z.enum(TICKET_STATES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  assigned_to: z.string().max(64).nullable().optional(),
  version: z.coerce.number().int().optional(),
});

supportRouter.patch('/tickets/:id', wrap((req, res) => {
  const q = parse(patchSchema, req.body);
  const scope = scopeFor(req.ctx, req.user, req);
  res.json(updateTicket(req.ctx, req.user, scope, String(req.params.id), {
    state: q.state, priority: q.priority, assigned_to: q.assigned_to, version: q.version ?? null,
  }, clientIp(req)));
}));
