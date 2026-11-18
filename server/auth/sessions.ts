import type { AppContext, SessionUser } from '../context.ts';
import { sha256 } from '../lib/crypto.ts';
import { randomToken, now } from '../lib/ids.ts';
import { withPlatform } from '../authz/platform.ts';
import { forbidden, HttpError, unauthorized } from '../lib/errors.ts';

export const SESSION_COOKIE = 'vantage_session';
export const SIGNED_IN_COOKIE = 'vantage_signed_in';

export const sessionDigest = (token: string) => sha256(`session:${token}`);
/**
 * The value of the marker cookie the page reads to know a session is open (the session cookie is httpOnly). Each
 * session has its own, so a page can tell a 401 about a session a newer sign-in replaced; it is derived one way from the
 * token under its own label, so it opens nothing and does not give away the session's id.
 */
export const signedInMarker = (token: string) => sha256(`signed-in:${token}`).slice(0, 16);

/** How long a session may sit unused. Vantage staff's is never longer than anyone else's. */
export const idleMinutesFor = (config: AppContext['config'], isStaff: boolean | number) =>
  // A synthetic demo holds nothing real, and its workspace is thrown away when the session ends.
  config.accessMode === 'demo' ? config.demo.ttlHours * 60
    : isStaff ? Math.min(config.sessions.operatorIdleMinutes, config.sessions.idleMinutes) : config.sessions.idleMinutes;

const holdsPlatformRole = (ctx: AppContext, userId: string) => Boolean(ctx.db.prepare('SELECT 1 FROM platform_roles WHERE user_id = ? LIMIT 1').get(userId));

/** What a sign-in hears when the account changed while its proof was being checked (ADR-0035). */
export const credentialsChanged = () => unauthorized('Your sign-in details changed while you were signing in. Sign in again.', 'credentials_changed');

/**
 * Opens a session. `epoch` is the account's authentication epoch when the proof (a password, a code, a passkey, a provider's
 * answer) began to be checked: if a reset, a session wipe or a deactivation moved the account on meanwhile, nothing is
 * opened (ADR-0035). The check and the insert are one transaction, so nothing can slip between them.
 */
export function createSession(ctx: AppContext, userId: string, { ip, userAgent, method = 'password', sudo = false, epoch }: { ip?: string | null; userAgent?: string | null; method?: string; sudo?: boolean; epoch?: number | null }) {
  const { db, config } = ctx;
  const token = randomToken(32);
  const id = sessionDigest(token);
  const created = Date.now();
  const idle = new Date(created + idleMinutesFor(config, holdsPlatformRole(ctx, userId)) * 60_000);
  const absolute = new Date(created + config.sessions.absoluteHours * 3_600_000);
  const sudoUntil = sudo ? new Date(created + config.sessions.sudoMinutes * 60_000).toISOString() : null;
  db.transaction(() => {
    const account = db.prepare('SELECT active, auth_epoch FROM users WHERE id = ?').get(userId) as { active: number; auth_epoch: number } | undefined;
    if (!account || account.active !== 1 || (epoch != null && account.auth_epoch !== epoch)) throw credentialsChanged();
    const keep = Math.max(1, config.sessions.maxActive - 1);
    db.prepare(`DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC LIMIT ?)`).run(userId, userId, keep);
    db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, last_used_at, expires_at, absolute_expires_at, sudo_until, method, ip, user_agent, auth_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, userId, new Date(created).toISOString(), new Date(created).toISOString(), idle.toISOString(), absolute.toISOString(), sudoUntil, method, ip ? String(ip).slice(0, 64) : null, userAgent ? String(userAgent).slice(0, 200) : null, account.auth_epoch);
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId);
  })();
  return { token, id, expires: idle, absoluteExpires: absolute };
}

/** A session past either deadline is over; at the very instant of a deadline it still stands. resolveSession and liveSession share this. */
const pastDeadline = (row: { expires_at: string; absolute_expires_at: string }, nowMs: number) =>
  new Date(row.expires_at).getTime() < nowMs || new Date(row.absolute_expires_at).getTime() < nowMs;

export interface LiveSession { id: string; userId: string; sudoUntil: string | null; method: string; epoch: number }

/**
 * Whether a session is good at this moment, asked without renewing it (ADR-0035): it exists, its account is open,
 * neither its idle nor its absolute deadline has passed, it was opened under its account's current authentication epoch,
 * and it belongs to `userId` when one is given. A request that waited on something outside the database (a malware scan,
 * a password check, a queued export, a rendered file) asks this before it writes or hands anything back; a scanner
 * answering is not the person using Vantage, so it never extends the session. It reads the row whether or not pruning
 * has run, and a session it refuses here is refused by the next request too.
 */
export function liveSession(ctx: AppContext, sessionId: string | null | undefined, userId?: string | null): LiveSession | null {
  if (!sessionId) return null;
  const row = ctx.db.prepare(
    `SELECT s.user_id, s.expires_at, s.absolute_expires_at, s.sudo_until, s.method, s.auth_epoch AS session_epoch, u.auth_epoch AS user_epoch
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.active = 1`
  ).get(sessionId) as { user_id: string; expires_at: string; absolute_expires_at: string; sudo_until: string | null; method: string; session_epoch: number; user_epoch: number } | undefined;
  if (!row || (userId != null && row.user_id !== userId) || row.session_epoch !== row.user_epoch || pastDeadline(row, Date.now())) return null;
  return { id: sessionId, userId: row.user_id, sudoUntil: row.sudo_until, method: row.method, epoch: row.user_epoch };
}

/**
 * After a proof (a password, a passkey response) was checked under `epoch`, whether the session that asked may still act on
 * it (ADR-0035). A session that no longer stands is a 401, as the next request on it would be. A session that stands under
 * a newer epoch (the person changed their password or signed out their other sessions from it meanwhile) stays signed in,
 * but the proof is stale: a 403, so the page asks again rather than signing out.
 */
export function assertProofCurrent(live: LiveSession | null, epoch: number): LiveSession {
  if (!live) throw unauthorized();
  if (live.epoch !== epoch) throw forbidden('Your sign-in details changed while this was being checked. Try again.', 'credentials_changed');
  return live;
}

/**
 * After a proof that needs a confirmed session (adding a passkey): the session is live, under the epoch the proof began
 * under, and its password confirmation has not run out (ADR-0035). 401, 403 `credentials_changed`, 403 `sudo_required`.
 */
export function assertConfirmedProof(ctx: AppContext, sessionId: string | null | undefined, userId: string, epoch: number): LiveSession {
  const live = assertProofCurrent(liveSession(ctx, sessionId, userId), epoch);
  if (!live.sudoUntil || new Date(live.sudoUntil).getTime() < Date.now()) throw new HttpError(403, 'Confirm your password to continue.', 'sudo_required');
  return live;
}

/** liveSession as a yes or no: the check every continuation makes after its wait (attachments, saved messages, imports). */
export const sessionStands = (ctx: AppContext, id: string | null | undefined, userId?: string | null) => Boolean(liveSession(ctx, id, userId));

export function destroySession(ctx: AppContext, id: string) {
  ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

/**
 * Ends a person's sessions, all of them or all but `exceptId`, and advances their authentication epoch in the same
 * transaction (ADR-0035). Every security transition comes through here (a password changed or reset, a second factor
 * reset, an account deactivated or separated, a role or a seat changed), so a proof that was being checked when it
 * happened (a password still hashing, a code challenge issued before it, a provider's answer on its way) can no longer
 * open a session: createSession, resolveSession and liveSession all compare epochs. The one session kept is re-stamped
 * with the new epoch, so the person who made the change stays signed in.
 */
export function invalidateUserSessions(ctx: AppContext, userId: string, exceptId: string | null = null): number {
  return ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE users SET auth_epoch = auth_epoch + 1 WHERE id = ?').run(userId);
    const revoked = exceptId
      ? ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, exceptId).changes
      : ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
    if (exceptId) ctx.db.prepare('UPDATE sessions SET auth_epoch = (SELECT auth_epoch FROM users WHERE id = ?) WHERE id = ? AND user_id = ?').run(userId, exceptId, userId);
    return revoked;
  })();
}

export function pruneSessions(ctx: AppContext) {
  const t = now();
  ctx.db.prepare('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?').run(t, t);
  ctx.db.prepare('DELETE FROM tokens WHERE expires_at < ? OR used_at IS NOT NULL').run(new Date(Date.now() - 86_400_000).toISOString());
  ctx.db.prepare('DELETE FROM passkey_challenges WHERE expires_at <= ?').run(t);
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

/**
 * Confirms a session for sensitive changes. Given the epoch the confirming proof began under, it is granted only while the
 * session is still live under that epoch (ADR-0035): a password reset during a step-up's check confirms nothing.
 */
export function grantSudo(ctx: AppContext, sessionId: string, epoch?: number | null) {
  const until = new Date(Date.now() + ctx.config.sessions.sudoMinutes * 60_000).toISOString();
  if (epoch == null) {
    ctx.db.prepare('UPDATE sessions SET sudo_until = ? WHERE id = ?').run(until, sessionId);
    return until;
  }
  return ctx.db.transaction(() => {
    assertProofCurrent(liveSession(ctx, sessionId), epoch);
    ctx.db.prepare('UPDATE sessions SET sudo_until = ? WHERE id = ? AND auth_epoch = ?').run(until, sessionId, epoch);
    return until;
  })();
}

/**
 * The session a token names, if it is still live. A request the person made (`touch`) keeps it alive; a background
 * poll does not, or a tab left open with its notification bell would never time out.
 */
export function resolveSession(ctx: AppContext, token: string | undefined, { touch = true }: { touch?: boolean } = {}): { user: SessionUser; session: { id: string; sudo_until: string | null; method: string; expires_at: string } } | null {
  if (!token) return null;
  const { db, config } = ctx;
  const id = sessionDigest(token);
  const row = db.prepare(
    `SELECT s.expires_at, s.absolute_expires_at, s.last_used_at, s.sudo_until, s.method, s.auth_epoch AS session_epoch, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND u.active = 1`
  ).get(id) as (SessionUser & { password_hash: string; totp_secret: string | null; totp_pending: string | null; totp_last_step: number | null; expires_at: string; absolute_expires_at: string; last_used_at: string; sudo_until: string | null; method: string; session_epoch: number; auth_epoch: number }) | undefined;
  if (!row) return null;
  const nowMs = Date.now();
  // Past a deadline, or opened under an epoch its account has since left (ADR-0035): over either way.
  if (pastDeadline(row, nowMs) || row.session_epoch !== row.auth_epoch) {
    destroySession(ctx, id);
    return null;
  }
  let expiresAt = row.expires_at;
  if (touch && nowMs - new Date(row.last_used_at).getTime() > 15_000) {
    expiresAt = new Date(Math.min(nowMs + idleMinutesFor(config, holdsPlatformRole(ctx, row.id)) * 60_000, new Date(row.absolute_expires_at).getTime())).toISOString();
    db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?').run(new Date(nowMs).toISOString(), expiresAt, id);
  }
  const { expires_at: _e, absolute_expires_at: _a, last_used_at: _l, sudo_until, method, session_epoch: _se, ...account } = row;
  return { user: asSessionUser(ctx, account), session: { id, sudo_until, method, expires_at: expiresAt } };
}

/**
 * An account row as a request sees it: never its credentials, lockout or epoch, and with its platform roles. The old
 * Instance Operator flag is no longer read anywhere (ADR-0006): authority comes from the role tables.
 */
function asSessionUser(ctx: AppContext, row: Record<string, unknown>): SessionUser {
  const { password_hash: _p, totp_secret: _t, totp_pending: _tp, totp_last_step: _ts, failed_sign_ins: _f, locked_until: _lu, is_operator: _op, auth_epoch: _ae, ...user } = row;
  return withPlatform(ctx, user as never) as unknown as SessionUser;
}

/** The account as it stands now, as a request would see it, or null if it is closed. For checks made after a wait (fresh.ts). */
export function currentSessionUser(ctx: AppContext, userId: string): SessionUser | null {
  const row = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId) as Record<string, unknown> | undefined;
  return row ? asSessionUser(ctx, row) : null;
}
