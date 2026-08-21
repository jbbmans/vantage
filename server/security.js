/**
 * Vantage — sign-in protection.
 *
 * v3.2 throttled by IP alone. Behind a base's NAT or a platform proxy, one IP
 * is a whole building, so a single Marine fat-fingering their password could
 * lock the shop out — and a distributed attack rotating IPs never tripped the
 * counter at all. This layers three counters and keeps each one honest about
 * what it protects:
 *
 *   per-IP        stops one machine hammering the endpoint
 *   per-username  stops a distributed guess against one account
 *   global        stops a slow spray across many accounts
 *
 * Only FAILED attempts count. A correct password clears the account's counter,
 * so the lockout-as-denial-of-service trick (spam wrong passwords at someone
 * else's username to lock them out) costs the attacker sustained effort and
 * ends the moment the real owner signs in — and the per-username threshold is
 * deliberately looser than per-IP for the same reason.
 */

const WINDOW_MS = 15 * 60 * 1000;
const IP_MAX = 10;          // failures per IP per window
const USER_MAX = 15;        // failures per username per window (looser: see above)
const GLOBAL_MAX = 300;     // failures across the whole install per window
const counters = { ip: new Map(), user: new Map() };
let globalCount = { count: 0, start: Date.now() };

function bump(map, key, nowMs) {
  const entry = map.get(key) || { count: 0, start: nowMs };
  if (nowMs - entry.start > WINDOW_MS) { entry.count = 0; entry.start = nowMs; }
  entry.count += 1;
  map.set(key, entry);
  return entry;
}

function peek(map, key, nowMs) {
  const entry = map.get(key);
  if (!entry || nowMs - entry.start > WINDOW_MS) return 0;
  return entry.count;
}

const retryAfter = (entry, nowMs) => Math.max(1, Math.ceil((entry.start + WINDOW_MS - nowMs) / 1000));

/**
 * Call before verifying credentials. Returns null to proceed, or
 * { status, retryAfter, message } when the attempt should be refused.
 */
export function checkLoginAllowed(ip, username) {
  const nowMs = Date.now();
  if (nowMs - globalCount.start > WINDOW_MS) globalCount = { count: 0, start: nowMs };

  const ipCount = peek(counters.ip, ip, nowMs);
  if (ipCount >= IP_MAX) {
    const entry = counters.ip.get(ip);
    return { status: 429, retryAfter: retryAfter(entry, nowMs), scope: 'ip', message: 'Too many sign-in attempts from this connection. Try again later.' };
  }
  const userKey = String(username || '').trim().toLowerCase();
  if (userKey) {
    const userCount = peek(counters.user, userKey, nowMs);
    if (userCount >= USER_MAX) {
      const entry = counters.user.get(userKey);
      return { status: 429, retryAfter: retryAfter(entry, nowMs), scope: 'account', message: 'Too many failed attempts for this account. Try again later.' };
    }
  }
  if (globalCount.count >= GLOBAL_MAX) {
    return { status: 429, retryAfter: 60, scope: 'global', message: 'Sign-in is temporarily paused. Try again in a minute.' };
  }
  return null;
}

/** Record a failed attempt. Returns true the first time the account crosses its threshold (for audit). */
export function recordLoginFailure(ip, username) {
  const nowMs = Date.now();
  bump(counters.ip, ip, nowMs);
  globalCount.count += 1;
  const userKey = String(username || '').trim().toLowerCase();
  if (!userKey) return false;
  const entry = bump(counters.user, userKey, nowMs);
  return entry.count === USER_MAX;
}

/** A correct password clears the account and connection counters. */
export function recordLoginSuccess(ip, username) {
  counters.ip.delete(ip);
  counters.user.delete(String(username || '').trim().toLowerCase());
}

/** Housekeeping for a long-lived process. */
export function pruneCounters() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const map of [counters.ip, counters.user]) {
    for (const [key, entry] of map) if (entry.start < cutoff) map.delete(key);
  }
}

/** Test hook. */
export function resetCounters() {
  counters.ip.clear();
  counters.user.clear();
  globalCount = { count: 0, start: Date.now() };
}

export const LOGIN_LIMITS = { WINDOW_MS, IP_MAX, USER_MAX, GLOBAL_MAX };
