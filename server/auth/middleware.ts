import type { NextFunction, Request, Response } from 'express';
import type { AppContext } from '../context.ts';
import { resolveSession, SESSION_COOKIE } from './sessions.ts';
import { limiters } from './limiter.ts';
import { HttpError, unauthorized, forbidden } from '../lib/errors.ts';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function attachContext(ctx: AppContext) {
  return (req: Request, _res: Response, next: NextFunction) => { req.ctx = ctx; next(); };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const ctx = req.ctx;
  const header = req.get('authorization') || '';
  const bearer = ctx.config.test && header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = bearer || (req.cookies?.[SESSION_COOKIE] as string | undefined);
  const resolved = resolveSession(ctx, token);
  if (!resolved) return next(unauthorized());
  if (!bearer && !SAFE.has(req.method) && !req.get('x-vantage-client')) return next(new HttpError(403, 'Request rejected: missing client header.', 'csrf'));
  if (!SAFE.has(req.method)) {
    const limited = limiters.mutations.limited(resolved.user.id);
    if (limited) return next(new HttpError(429, 'Too many changes in a short period. Try again later.', 'mutation_throttled', { retryAfter: limited.retryAfter }));
    limiters.mutations.bump(resolved.user.id);
  }
  if (resolved.user.must_change_password) {
    const allowed = ['/api/me', '/api/me/password', '/api/auth/logout'];
    if (!allowed.includes(req.originalUrl.split('?')[0])) return next(new HttpError(403, 'Change the temporary password before using Vantage.', 'password_change_required'));
  }
  req.user = resolved.user;
  req.sessionId = resolved.session.id;
  req.sessionRow = resolved.session;
  next();
}

export function requireOperator(req: Request, _res: Response, next: NextFunction) {
  if (!req.user?.is_operator) return next(forbidden('That is an Instance Operator action.', 'not_operator'));
  next();
}

/** Step-up: the session must have re-authenticated recently. */
export function requireSudo(req: Request, _res: Response, next: NextFunction) {
  const until = req.sessionRow?.sudo_until;
  if (!until || new Date(until).getTime() < Date.now()) return next(new HttpError(403, 'Confirm your password to continue.', 'sudo_required'));
  next();
}
