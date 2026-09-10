import type { AppContext, SessionUser } from '../context.ts';
import { sha256 } from '../lib/crypto.ts';
import { randomToken, now } from '../lib/ids.ts';

export const SESSION_COOKIE = 'vantage_session';
export const SIGNED_IN_COOKIE = 'vantage_signed_in';

export const sessionDigest = (token: string) => sha256(`session:${token}`);

export function createSession(ctx: AppContext, userId: string, { ip, userAgent, method = 'password', sudo = false }: { ip?: string | null; userAgent?: string | null; method?: string; sudo?: boolean }) {
  const { db, config } = ctx;
  const token = randomToken(32);
  const id = sessionDigest(token);
  const created = Date.now();
  const idle = new Date(created + config.sessions.idleMinutes * 60_000);
  const absolute = new Date(created + config.sessions.absoluteHours * 3_600_000);
  const sudoUntil = sudo ? new Date(created + config.sessions.sudoMinutes * 60_000).toISOString() : null;
  db.transaction(() => {
    const keep = Math.max(1, config.sessions.maxActive - 1);
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC LIMIT ?)`).run(userId, userId, keep);
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at, absolute_expires_at, sudo_until, method, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, userId, new Date(created).toISOString(), new Date(created).toISOString(), idle.toISOString(), absolute.toISOString(), sudoUntil, method, ip ? String(ip).slice(0, 64) : null, userAgent ? String(userAgent).slice(0, 200) : null);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
  })();
  return { token, id, expires: idle, absoluteExpires: absolute };
}

export function destroySession(ctx: AppContext, id: string) {
  ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function invalidateUserSessions(ctx: AppContext, userId: string, exceptId: string | null = null): number {
  if (exceptId) return ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, exceptId).changes;
  return ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

export function pruneSessions(ctx: AppContext) {
  const t = now();
  ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?').run(t, t);
  ctx.db.prepare('DELETE FROM tokens WHERE expires_at < ? OR used_at IS NOT NULL').run(new Date(Date.now() - 86_400_000).toISOString());
}

export function listSessions(ctx: AppContext, userId: string, currentId: string | null) {
  return (ctx.db.prepare('SELECT id, created_at, last_used_at, expires_at, absolute_expires_at, method, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC').all(userId) as Array<Record<string, string | null>>)
    .map((s) => ({ id: String(s.id).slice(0, 12), current: s.id === currentId, created_at: s.created_at, last_used_at: s.last_used_at, expires_at: s.expires_at, absolute_expires_at: s.absolute_expires_at, method: s.method, ip: s.ip, user_agent: s.user_agent }));
}

export function revokeSessionByPrefix(ctx: AppContext, userId: string, prefix: string): number {
  if (!prefix || prefix.length < 12) return 0;
  const rows = ctx.db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId) as Array<{ id: string }>;
  const hit = rows.find((r) => r.id.startsWith(prefix));
  if (!hit) return 0;
  return ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(hit.id).changes;
}

export function grantSudo(ctx: AppContext, sessionId: string) {
  const until = new Date(Date.now() + ctx.config.sessions.sudoMinutes * 60_000).toISOString();
  ctx.db.prepare('UPDATE sessions SET sudo_until = ? WHERE id = ?').run(until, sessionId);
  return until;
}

export function resolveSession(ctx: AppContext, token: string | undefined): { user: SessionUser; session: { id: string; sudo_until: string | null; method: string } } | null {
  if (!token) return null;
  const { db, config } = ctx;
  const id = sessionDigest(token);
  const row = db.prepare(
    `SELECT s.expires_at, s.absolute_expires_at, s.last_used_at, s.sudo_until, s.method, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.active = 1`
  ).get(id) as (SessionUser & { password_hash: string; totp_secret: string | null; expires_at: string; absolute_expires_at: string; last_used_at: string; sudo_until: string | null; method: string }) | undefined;
  if (!row) return null;
  const nowMs = Date.now();
  if (new Date(row.expires_at).getTime() < nowMs || new Date(row.absolute_expires_at).getTime() < nowMs) {
    destroySession(ctx, id);
    return null;
  }
  if (nowMs - new Date(row.last_used_at).getTime() > 60_000) {
    db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?').run(
      new Date(nowMs).toISOString(),
      new Date(Math.min(nowMs + config.sessions.idleMinutes * 60_000, new Date(row.absolute_expires_at).getTime())).toISOString(),
      id
    );
  }
  const { password_hash: _p, totp_secret: _t, expires_at: _e, absolute_expires_at: _a, last_used_at: _l, sudo_until, method, ...user } = row;
  return { user: user as SessionUser, session: { id, sudo_until, method } };
}
