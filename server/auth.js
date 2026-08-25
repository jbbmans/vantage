/**
 * Vantage — authentication.
 *
 * scrypt for password hashing, random opaque session tokens held server-side.
 * Deliberately not JWT: a stateless token can't be revoked, and "this Marine
 * transferred, cut their access now" is a routine request in this setting.
 * A row in `sessions` can be deleted. A signed JWT in someone's pocket cannot.
 *
 * v3.3 session lifecycle, built for the shared duty computer:
 *
 *   - The cookie is a SESSION cookie. No Expires, no Max-Age. Close the
 *     browser and the credential is gone from the machine. v3.2 set a 12-day
 *     cookie, which meant the next Marine at the workstation inherited the
 *     last one's login — directly against the tool's own stated model.
 *   - The server enforces an INACTIVITY timeout (default 60 minutes) and an
 *     ABSOLUTE lifetime (default 12 hours), because a browser left open on a
 *     duty desk defeats a session cookie all by itself.
 *   - Sessions record when they were last used, from where, and with what
 *     browser, so a Marine can look at their own session list and the Instance
 *     Operator can perform account-wide recovery.
 *
 * Bearer tokens exist only in the isolated API test harness, which models
 * several users in one process. Deployed requests authenticate by cookie only.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { passwordProblem } from './passwordPolicy.js';
import { checkMutationAllowed } from './security.js';
import { config } from './config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_ACTIVE_SESSIONS = config.sessions.max_active;

const minutes = (n) => n * 60_000;
const hours = (n) => n * 3_600_000;

export const SESSION_POLICY = {
  idleMs: minutes(config.sessions.idle_minutes),
  absoluteMs: hours(config.sessions.absolute_hours),
};

export function hashPassword(password) {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = scryptSync(password, salt, expected.length, { N: +N, r: +r, p: +p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A real hash of a random password, verified against on unknown usernames so
 * "no such user" and "wrong password" take the same time (finding 17).
 */
const DUMMY_HASH = hashPassword(randomBytes(24).toString('base64url'));
export function burnVerification(password) {
  verifyPassword(password || '', DUMMY_HASH);
}

/**
 * Store only a one-way digest of a session credential. A database snapshot is
 * necessarily sensitive, but it must not also be a bag of immediately usable
 * login tokens. The browser keeps the random token; SQLite keeps this digest.
 */
export function sessionDigest(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

/** Stable, non-secret identifier used by the session-management UI. */
export function sessionIdForToken(token) {
  return sessionDigest(token).slice(0, 8);
}

export function createSession(db, userId, { ip = null, userAgent = null } = {}) {
  const token = randomBytes(32).toString('base64url');
  const digest = sessionDigest(token);
  const created = Date.now();
  const idleDeadline = new Date(created + SESSION_POLICY.idleMs);
  const absoluteDeadline = new Date(created + SESSION_POLICY.absoluteMs);
  db.transaction(() => {
    const keep = Math.max(1, MAX_ACTIVE_SESSIONS - 1);
    db.prepare(
      `DELETE FROM sessions
        WHERE user_id = ? AND token NOT IN (
          SELECT token FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC LIMIT ?
        )`
    ).run(userId, userId, keep);
    db.prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at, absolute_expires_at, last_used_at, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      digest, userId,
      new Date(created).toISOString(),
      idleDeadline.toISOString(),
      absoluteDeadline.toISOString(),
      new Date(created).toISOString(),
      ip ? String(ip).slice(0, 64) : null,
      userAgent ? String(userAgent).slice(0, 200) : null
    );
  })();
  return { token, expires: idleDeadline, absoluteExpires: absoluteDeadline };
}

export function destroySession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(sessionDigest(token));
}

/** Cut every session a user holds — transfer, deactivation, password change. */
export function invalidateUserSessions(db, userId, { exceptToken = null } = {}) {
  if (exceptToken) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?')
      .run(userId, sessionDigest(exceptToken)).changes;
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

/** Drop expired rows so the table doesn't become a list of every login ever. */
export function pruneSessions(db) {
  const nowIso = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?').run(nowIso, nowIso);
}

/**
 * Sessions for one user, tokens masked. What a Marine sees under "your
 * sessions" and what the Instance Operator sees during an access review.
 */
export function listSessions(db, userId, currentToken = null) {
  const currentDigest = currentToken ? sessionDigest(currentToken) : null;
  return db
    .prepare(
      `SELECT token, created_at, last_used_at, expires_at, absolute_expires_at, ip, user_agent
         FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC`
    )
    .all(userId)
    .map((s) => ({
      id: s.token.slice(0, 8),
      current: currentDigest ? s.token === currentDigest : false,
      created_at: s.created_at,
      last_used_at: s.last_used_at,
      expires_at: s.expires_at,
      absolute_expires_at: s.absolute_expires_at,
      ip: s.ip,
      user_agent: s.user_agent,
    }));
}

export function revokeSessionByPrefix(db, userId, prefix) {
  if (!prefix || prefix.length < 8) return 0;
  const rows = db.prepare('SELECT token FROM sessions WHERE user_id = ?').all(userId);
  const hit = rows.find((r) => r.token.startsWith(prefix));
  if (!hit) return 0;
  return db.prepare('DELETE FROM sessions WHERE token = ?').run(hit.token).changes;
}

export function sessionUser(db, token) {
  if (!token) return null;
  const digest = sessionDigest(token);
  const row = db
    .prepare(
      `SELECT s.expires_at, s.absolute_expires_at, s.last_used_at, u.*
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND u.active = 1`
    )
    .get(digest);
  if (!row) return null;
  const nowMs = Date.now();
  if (new Date(row.expires_at).getTime() < nowMs || new Date(row.absolute_expires_at).getTime() < nowMs) {
    destroySession(db, token);
    return null;
  }
  // Roll the inactivity deadline, at most once a minute so a busy page doesn't
  // turn every request into a write. The absolute deadline never moves.
  if (nowMs - new Date(row.last_used_at || row.expires_at).getTime() > 60_000) {
    db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE token = ?').run(
      new Date(nowMs).toISOString(),
      new Date(Math.min(nowMs + SESSION_POLICY.idleMs, new Date(row.absolute_expires_at).getTime())).toISOString(),
      digest
    );
  }
  delete row.password_hash;
  delete row.cac_subject;
  delete row.expires_at;
  delete row.absolute_expires_at;
  delete row.last_used_at;
  return row;
}

/**
 * Express middleware: attaches req.user or 401s.
 *
 * Cookie-authenticated state changes additionally require the client header
 * the SPA always sends. SameSite=Strict already keeps the cookie off
 * cross-site requests; the header is defense in depth so a future SameSite
 * regression or an odd browser doesn't silently reopen CSRF. Test-harness
 * bearer requests are exempt because they are never enabled in deployment.
 */
export function requireAuth(db) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const bearer = process.env.VANTAGE_TEST === '1' && header.startsWith('Bearer ')
      ? header.slice(7)
      : null;
    const token = bearer || req.cookies?.vantage_session;
    const user = sessionUser(db, token);
    if (!user) return res.status(401).json({ error: 'Not signed in.', code: 'unauthenticated' });
    if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.get('x-vantage-client')) {
      return res.status(403).json({ error: 'Request rejected: missing client header.', code: 'csrf' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const limited = checkMutationAllowed(user.id);
      if (limited) {
        res.setHeader('Retry-After', String(limited.retryAfter));
        return res.status(limited.status).json({
          error: 'Too many changes in a short period. Try again later.',
          code: 'mutation_throttled',
        });
      }
    }
    if (user.must_change_password) {
      const allowed = req.path === '/api/me'
        || req.path === '/api/me/password'
        || req.path === '/api/logout';
      if (!allowed) {
        return res.status(403).json({
          error: 'Change the temporary password before using Vantage.',
          code: 'password_change_required',
        });
      }
    }
    req.user = user;
    req.token = token;
    next();
  };
}

export const newToken = () => randomUUID();
