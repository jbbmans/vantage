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

const DUMMY_HASH = hashPassword(randomBytes(24).toString('base64url'));
export function burnVerification(password) {
  verifyPassword(password || '', DUMMY_HASH);
}

export function sessionDigest(token) {
  return createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

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

export function invalidateUserSessions(db, userId, { exceptToken = null } = {}) {
  if (exceptToken) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?')
      .run(userId, sessionDigest(exceptToken)).changes;
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

export function pruneSessions(db) {
  const nowIso = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR absolute_expires_at < ?').run(nowIso, nowIso);
}

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
