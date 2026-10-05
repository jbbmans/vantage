import type { NextFunction, Request, Response, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { BlockList, isIP } from 'node:net';
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

// Cloudflare's published edge ranges (https://www.cloudflare.com/ips/). A request whose peer is one of these carries
// the visitor's own address in CF-Connecting-IP, which Cloudflare sets and overwrites; from anyone else it is ignored.
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20',
  '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];
const CLOUDFLARE = new BlockList();
for (const range of CLOUDFLARE_RANGES) { const [address, bits] = range.split('/'); CLOUDFLARE.addSubnet(address, Number(bits), address.includes(':') ? 'ipv6' : 'ipv4'); }

export function fromCloudflare(address: string): boolean {
  const bare = address.replace(/^::ffff:/i, '');
  const family = isIP(bare);
  return family !== 0 && CLOUDFLARE.check(bare, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * The address a request came from, for rate limits and the audit trail. Behind Cloudflare the proxy chain ends at a
 * Cloudflare edge, so every visitor reaching through the same edge would share one address (and one rate limit);
 * with VANTAGE_CLIENT_IP=cloudflare the visitor's own address is used instead, but only when the peer really is
 * Cloudflare, so a request that reaches the origin some other way cannot choose its own address.
 */
export function clientIp(req: Request): string {
  const peer = String(req.ip || req.socket?.remoteAddress || '');
  if (req.ctx?.config.clientIp === 'cloudflare' && fromCloudflare(peer)) {
    const visitor = String(req.get('cf-connecting-ip') || '').trim();
    if (isIP(visitor)) return visitor.slice(0, 64);
  }
  return peer.slice(0, 64);
}

export function sendError(res: Response, error: HttpError) {
  if (typeof error.extra.retryAfter === 'number') res.setHeader('Retry-After', String(error.extra.retryAfter));
  res.status(error.status).json({ error: error.message, code: error.code, ...error.extra });
}
