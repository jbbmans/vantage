import { Router } from 'express';
import express from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { badRequest } from '../lib/errors.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor } from '../authz/scope.ts';
import { audit } from '../services/audit.ts';
import {
  listContacts, saveContact, listThreads, createThread, threadDetail, setThreadState,
  addMessage, importEml, linkThreadMany, unlinkThread, threadsForItem, THREAD_STATES,
} from '../services/correspondence.ts';
import {
  listConnectors, createConnector, ownedConnector, deleteConnector, authorizationPlan,
  publicView, syncMailbox, MICROSOFT_CLOUDS, READ_ONLY_SCOPES,
} from '../services/connectors.ts';

export const correspondenceRouter = Router();
correspondenceRouter.use(requireAuth);

// Contacts -------------------------------------------------------------
const contactSchema = z.object({
  name: z.string().max(200),
  email: z.string().max(255).nullable().optional(),
  organization: z.string().max(200).nullable().optional(),
  role: z.string().max(120).nullable().optional(),
  phone: z.string().max(60).nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  visibility: z.enum(['private', 'unit']).optional(),
  unit_id: z.string().max(64).nullable().optional(),
});

correspondenceRouter.get('/contacts', wrap((req, res) => {
  res.json(listContacts(req.ctx, req.user, scopeFor(req.ctx, req.user, req)));
}));

correspondenceRouter.post('/contacts', wrap((req, res) => {
  const q = parse(contactSchema, req.body);
  res.status(201).json(saveContact(req.ctx, req.user, scopeFor(req.ctx, req.user, req), q as never));
}));

correspondenceRouter.put('/contacts/:id', wrap((req, res) => {
  const q = parse(contactSchema, req.body);
  res.json(saveContact(req.ctx, req.user, scopeFor(req.ctx, req.user, req), q as never, String(req.params.id)));
}));

// Threads --------------------------------------------------------------
const listSchema = z.object({
  state: z.enum(THREAD_STATES).optional(),
  unit_id: z.string().max(64).optional(),
  contact_id: z.string().max(64).optional(),
  work_item_id: z.string().max(64).optional(),
  due: z.enum(['1']).optional(),
  q: z.string().max(200).optional(),
});

correspondenceRouter.get('/threads', wrap((req, res) => {
  const q = parse(listSchema, req.query);
  res.json(listThreads(req.ctx, req.user, scopeFor(req.ctx, req.user, req), {
    state: q.state ?? null, unitId: q.unit_id ?? null, contactId: q.contact_id ?? null,
    workItemId: q.work_item_id ?? null, dueOnly: q.due === '1', q: q.q ?? null,
  }));
}));

const threadSchema = z.object({
  subject: z.string().max(500),
  unit_id: z.string().max(64).nullable().optional(),
  visibility: z.enum(['private', 'unit']).optional(),
  contact_id: z.string().max(64).nullable().optional(),
  follow_up_at: z.string().max(10).nullable().optional(),
});

correspondenceRouter.post('/threads', wrap((req, res) => {
  const q = parse(threadSchema, req.body);
  const thread = createThread(req.ctx, req.user, scopeFor(req.ctx, req.user, req), q as never);
  audit(req.ctx, { actor_id: req.user.id, action: 'create_thread', entity: 'threads', entity_id: thread.id, unit_id: thread.unit_id, ip: clientIp(req) });
  res.status(201).json(thread);
}));

correspondenceRouter.get('/threads/:id', wrap((req, res) => {
  res.json(threadDetail(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id)));
}));

const stateSchema = z.object({
  state: z.enum(THREAD_STATES),
  at: z.string().max(30).nullable().optional(),
  follow_up_at: z.string().max(10).nullable().optional(),
  version: z.coerce.number().int().optional(),
});

correspondenceRouter.post('/threads/:id/state', wrap((req, res) => {
  const q = parse(stateSchema, req.body);
  const thread = setThreadState(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id), {
    state: q.state, at: q.at ?? null, follow_up_at: q.follow_up_at, version: q.version ?? null,
  });
  audit(req.ctx, { actor_id: req.user.id, action: 'thread_state', entity: 'threads', entity_id: thread.id, unit_id: thread.unit_id, detail: q.state, ip: clientIp(req) });
  res.json(thread);
}));

const messageSchema = z.object({
  direction: z.enum(['outbound', 'inbound']).default('outbound'),
  subject: z.string().max(500).nullable().optional(),
  body_text: z.string().max(100_000).nullable().optional(),
  from_name: z.string().max(200).nullable().optional(),
  from_email: z.string().max(255).nullable().optional(),
  to_emails: z.array(z.string().max(255)).max(100).optional(),
  cc_emails: z.array(z.string().max(255)).max(100).optional(),
  sent_at: z.string().max(30).nullable().optional(),
});

correspondenceRouter.post('/threads/:id/messages', wrap((req, res) => {
  const q = parse(messageSchema, req.body);
  res.status(201).json(addMessage(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id), q as never));
}));

// Links: one thread, many pieces of work.
correspondenceRouter.post('/threads/:id/links', wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const ids = Array.isArray(req.body?.work_item_ids) ? req.body.work_item_ids.map(String)
    : req.body?.work_item_id ? [String(req.body.work_item_id)] : [];
  if (!ids.length) throw badRequest('Name the work this correspondence is about.');
  const result = linkThreadMany(req.ctx, req.user, scope, String(req.params.id), ids);
  audit(req.ctx, { actor_id: req.user.id, action: 'link_thread', entity: 'threads', entity_id: String(req.params.id), detail: `${result.linked} of ${result.requested}`, ip: clientIp(req) });
  res.status(201).json(result);
}));

correspondenceRouter.delete('/threads/:id/links/:workItemId', wrap((req, res) => {
  unlinkThread(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id), String(req.params.workItemId));
  res.status(204).end();
}));

correspondenceRouter.get('/items/:id/threads', wrap((req, res) => {
  res.json(threadsForItem(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id)));
}));

// EML import -----------------------------------------------------------
const emlBody: express.RequestHandler = (req, res, next) =>
  express.raw({ type: () => true, limit: req.ctx.config.intake.maxBytes })(req, res, next);

correspondenceRouter.post('/messages/import', emlBody, wrap((req, res) => {
  const scope = scopeFor(req.ctx, req.user, req);
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!buffer.length) throw badRequest('That file is empty.');
  const result = importEml(req.ctx, req.user, scope, buffer, {
    threadId: req.get('x-thread-id') || null,
    unitId: req.get('x-unit-id') || null,
    visibility: req.get('x-visibility') === 'private' ? 'private' : 'unit',
    contactId: req.get('x-contact-id') || null,
    direction: req.get('x-direction') === 'outbound' ? 'outbound' : 'inbound',
  });
  if (!result.replayed) {
    audit(req.ctx, { actor_id: req.user.id, action: 'import_email', entity: 'thread_messages', entity_id: String(result.message.id), unit_id: result.thread.unit_id, ip: clientIp(req) });
  }
  res.status(result.replayed ? 200 : 201).json(result);
}));

// Connectors -----------------------------------------------------------
correspondenceRouter.get('/connectors', wrap((req, res) => {
  res.json({
    connectors: listConnectors(req.ctx, req.user),
    clouds: Object.entries(MICROSOFT_CLOUDS).map(([value, v]) => ({ value, label: v.label, graph: v.graph, authority: v.authority })),
    scopes: READ_ONLY_SCOPES,
  });
}));

const connectorSchema = z.object({
  provider: z.string().max(40).optional(),
  cloud: z.string().max(20),
  account_label: z.string().max(200),
});

correspondenceRouter.post('/connectors', wrap((req, res) => {
  const q = parse(connectorSchema, req.body);
  const connector = createConnector(req.ctx, req.user, q);
  audit(req.ctx, { actor_id: req.user.id, action: 'create_connector', entity: 'connectors', entity_id: connector.id, detail: `${connector.provider} (${connector.cloud})`, ip: clientIp(req) });
  res.status(201).json(connector);
}));

/** The exact endpoints an authorization would use, so an operator can check them before consenting. */
correspondenceRouter.get('/connectors/:id/authorization', wrap((req, res) => {
  const connector = ownedConnector(req.ctx, req.user, String(req.params.id));
  res.json({ connector: publicView(connector), plan: authorizationPlan(connector) });
}));

correspondenceRouter.delete('/connectors/:id', wrap((req, res) => {
  deleteConnector(req.ctx, req.user, String(req.params.id));
  res.status(204).end();
}));

/**
 * Runs a sync. Live syncing needs a token this build does not yet obtain, so this returns the plan
 * and says so plainly rather than pretending a mailbox was read.
 */
correspondenceRouter.post('/connectors/:id/sync', wrap(async (req, res) => {
  const connector = ownedConnector(req.ctx, req.user, String(req.params.id));
  if (connector.status !== 'connected') {
    res.status(409).json({
      error: 'This mailbox is not authorized yet, so there is nothing to sync. Vantage has no token for it.',
      code: 'connector_not_authorized',
      plan: authorizationPlan(connector),
    });
    return;
  }
  // A connected mailbox is synced through the same code path the tests drive; the fetcher is the
  // only piece that differs between a live tenant and a recorded one.
  const { graphFetcher } = await import('../services/connectors.ts');
  const token = String(req.get('x-graph-access-token') || '');
  if (!token) throw badRequest('No access token was supplied for this sync.');
  const result = await syncMailbox(req.ctx, req.user, connector.id, graphFetcher(connector, token), {
    unitId: req.body?.unit_id || null,
    visibility: req.body?.visibility === 'unit' ? 'unit' : 'private',
  });
  audit(req.ctx, { actor_id: req.user.id, action: 'sync_mailbox', entity: 'connectors', entity_id: connector.id, detail: `${result.stored} stored, ${result.skipped} already held`, ip: clientIp(req) });
  res.json(result);
}));
