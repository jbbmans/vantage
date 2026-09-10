import type { NextFunction, Request, Response, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { HttpError } from './errors.ts';
import { fieldErrors } from '../../shared/schemas.ts';

export const wrap = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown): RequestHandler =>
  (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };

export function parse<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const errors = fieldErrors(result.error);
    const message = Object.entries(errors).map(([k, v]) => (k === '_' ? v : `${k}: ${v}`)).join(' ');
    throw new HttpError(400, message || 'Invalid request.', 'validation', { fieldErrors: errors });
  }
  return result.data;
}

export const clientIp = (req: Request) => String(req.ip || req.socket?.remoteAddress || '').slice(0, 64);

export function sendError(res: Response, error: HttpError) {
  if (typeof error.extra.retryAfter === 'number') res.setHeader('Retry-After', String(error.extra.retryAfter));
  res.status(error.status).json({ error: error.message, code: error.code, ...error.extra });
}
