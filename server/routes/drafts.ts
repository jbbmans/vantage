import { Router } from 'express';
import { wrap, clientIp } from '../lib/http.ts';
import { requireAuth } from '../auth/middleware.ts';
import { scopeFor } from '../authz/scope.ts';
import { createFormDraft, discardFormDraft, listAllDrafts, readFormDraft, updateFormDraft } from '../services/drafts.ts';

/**
 * Drafts (ADR-0030): every draft of the person asking, wherever it is kept, and the forms they save to finish later.
 * Each is its author's alone; another person's is answered as if it did not exist. A saved form is sent through its kind's
 * own route with `?draft=<id>` (records.ts, org.ts), which removes it.
 */
export const draftsRouter = Router();
draftsRouter.use(requireAuth);

draftsRouter.get('/', wrap((req, res) => res.json(listAllDrafts(req.ctx, req.user, scopeFor(req.ctx, req.user, req)))));
draftsRouter.post('/forms', wrap((req, res) => res.status(201).json(createFormDraft(req.ctx, req.user, scopeFor(req.ctx, req.user, req), req.body, clientIp(req)))));
draftsRouter.get('/forms/:id', wrap((req, res) => res.json(readFormDraft(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id)))));
draftsRouter.put('/forms/:id', wrap((req, res) => res.json(updateFormDraft(req.ctx, req.user, scopeFor(req.ctx, req.user, req), String(req.params.id), req.body, clientIp(req)))));
draftsRouter.delete('/forms/:id', wrap((req, res) => { discardFormDraft(req.ctx, req.user, String(req.params.id), clientIp(req)); res.status(204).end(); }));
