import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { wrap, parse, clientIp } from '../lib/http.ts';
import { HttpError, forbidden, notFound, tooMany } from '../lib/errors.ts';
import { requireAuth } from '../auth/middleware.ts';
import { limiters } from '../auth/limiter.ts';
import { resolveSession, destroySession, SESSION_COOKIE } from '../auth/sessions.ts';
import { finishSignIn } from './auth.ts';
import { audit } from '../services/audit.ts';
import { createWorkspace, demoStatus, workspaceOf, purgeWorkspace, sampleSheet, type Persona } from '../services/demo.ts';

/**
 * The synthetic demo's entry points. They exist only when the server was started in demo mode;
 * on any other instance every path here is a 404, so there is nothing to probe.
 */
export const demoRouter = Router();

demoRouter.use((req, _res, next) => (req.ctx.config.accessMode === 'demo' ? next() : next(notFound('No such API route.'))));

demoRouter.get('/status', wrap((req, res) => {
  const session = resolveSession(req.ctx, req.cookies?.[SESSION_COOKIE]);
  res.json(demoStatus(req.ctx, session?.user.id ?? null));
}));

/** A fresh workspace for this visitor, and a session as its Marine. No form, no password. */
demoRouter.post('/start', wrap((req, res) => {
  if (!req.get('x-vantage-client')) throw forbidden('Request rejected: missing client header.', 'csrf');
  const ip = clientIp(req);
  // Bounded per connection: each start writes a workspace, and the demo is a shared host.
  const limited = limiters.registerIp.limited(ip);
  if (limited) throw tooMany('Too many demo workspaces from this connection. Try again shortly.', limited.retryAfter, 'demo_throttled');
  limiters.registerIp.bump(ip);
  const ws = createWorkspace(req.ctx);
  const user = req.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(ws.persona_user_id) as { id: string; must_change_password: number };
  return finishSignIn(req, res, user, 'demo', 'demo_start');
}));

const personaSchema = z.object({ persona: z.enum(['marine', 'leader']) });

/** Switch between the Marine and the section lead of the same workspace. Never into another workspace. */
demoRouter.post('/persona', requireAuth, wrap((req, res) => {
  const { persona } = parse(personaSchema, req.body);
  const ws = workspaceOf(req.ctx, req.user.id);
  if (!ws) throw forbidden('Only a demo persona can switch personas.');
  const targetId = (persona as Persona) === 'leader' ? ws.leader_user_id : ws.persona_user_id;
  const target = req.ctx.db.prepare('SELECT * FROM users WHERE id = ? AND demo_workspace_id = ?').get(targetId, ws.id) as { id: string; must_change_password: number } | undefined;
  if (!target) throw notFound('That persona is gone. Reset the demo.');
  destroySession(req.ctx, req.sessionId);
  audit(req.ctx, { actor_id: req.user.id, action: 'demo_persona', subject_id: target.id, unit_id: ws.unit_id, detail: persona });
  return finishSignIn(req, res, target, 'demo', 'demo_persona');
}));

/** Throw this workspace away and start a clean one. */
demoRouter.post('/reset', requireAuth, wrap((req, res) => {
  const ws = workspaceOf(req.ctx, req.user.id);
  if (!ws) throw forbidden('Only a demo persona can reset the demo.');
  destroySession(req.ctx, req.sessionId);
  purgeWorkspace(req.ctx, ws.id);
  const fresh = createWorkspace(req.ctx);
  const user = req.ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(fresh.persona_user_id) as { id: string; must_change_password: number };
  return finishSignIn(req, res, user, 'demo', 'demo_start');
}));

/** The synthetic sheet a section lead can import, to watch a tasker arrive. */
demoRouter.get('/sample.csv', requireAuth, wrap((_req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="FY26-Q4-UMT-batch-2 (synthetic).csv"');
  res.send(sampleSheet());
}));

/**
 * In demo mode, the parts of the product that would let a visitor reach beyond their own synthetic
 * workspace, or that manage real credentials, answer with a plain explanation instead.
 */
const DEMO_CLOSED: Array<[string, RegExp]> = [
  ['POST', /^\/api\/auth\/(login|login\/mfa|register|setup|forgot|reset|invite\/accept|cac|passkey\/options|passkey\/verify|sudo)$/],
  ['*', /^\/api\/me\/(password|mfa|passkeys|email)/],
  ['*', /^\/api\/admin\//],
  ['*', /^\/api\/(public-)?support\//],
  ['POST', /^\/api\/org\/units$/],
  ['*', /^\/api\/org\/units\/[^/]+\/(members|invites|join-codes|owner)/],
  ['*', /^\/api\/org\/(join-codes|invites|directory)/],
  ['*', /^\/api\/org\/team\/[^/]+\/(deactivate|reactivate|reset-mfa|temporary-password|logout|operator)/],
  ['*', /^\/api\/correspondence\/connectors/],
  ['POST', /^\/api\/ai\//],
];

export function demoGuard(req: Request, _res: Response, next: NextFunction) {
  if (req.ctx.config.accessMode !== 'demo') return next();
  const path = req.path;
  for (const [method, pattern] of DEMO_CLOSED) {
    if ((method === '*' || method === req.method) && pattern.test(path)) {
      return next(new HttpError(403, 'That is not part of the synthetic demo. Sign-in, accounts and administration are evaluated on an accounts-mode instance.', 'demo_mode'));
    }
  }
  next();
}
