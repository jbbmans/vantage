import type { AppContext } from '../context.ts';
import { sha256 } from '../lib/crypto.ts';
import { newId, now, randomToken } from '../lib/ids.ts';

export type TokenKind = 'reset' | 'invite' | 'login_mfa' | 'email_change';

export function issueToken(ctx: AppContext, kind: TokenKind, { userId = null, email = null, payload = {}, ttlMinutes, createdBy = null }: { userId?: string | null; email?: string | null; payload?: Record<string, unknown>; ttlMinutes: number; createdBy?: string | null }) {
  const token = randomToken(32);
  const id = newId();
  ctx.db.prepare(
    `INSERT INTO tokens (id, kind, token_hash, user_id, email, payload, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, kind, sha256(`${kind}:${token}`), userId, email, JSON.stringify(payload), new Date(Date.now() + ttlMinutes * 60_000).toISOString(), createdBy, now());
  return { id, token };
}

export interface TokenRow { id: string; kind: TokenKind; user_id: string | null; email: string | null; payload: Record<string, unknown>; expires_at: string; created_by: string | null }

export function peekToken(ctx: AppContext, kind: TokenKind, token: string): TokenRow | null {
  const row = ctx.db.prepare('SELECT * FROM tokens WHERE kind = ? AND token_hash = ? AND used_at IS NULL').get(kind, sha256(`${kind}:${String(token || '')}`)) as (Omit<TokenRow, 'payload'> & { payload: string }) | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return { ...row, payload: JSON.parse(row.payload || '{}') };
}

export function consumeToken(ctx: AppContext, kind: TokenKind, token: string): TokenRow | null {
  const row = peekToken(ctx, kind, token);
  if (!row) return null;
  ctx.db.prepare('UPDATE tokens SET used_at = ? WHERE id = ?').run(now(), row.id);
  return row;
}

export function revokeTokens(ctx: AppContext, kind: TokenKind, userId: string) {
  ctx.db.prepare('UPDATE tokens SET used_at = ? WHERE kind = ? AND user_id = ? AND used_at IS NULL').run(now(), kind, userId);
}
