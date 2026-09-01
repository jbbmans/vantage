import { config } from './config.js';

const WINDOW_MS = 15 * 60 * 1000;
const IP_MAX = 10;
const USER_MAX = 15;
const GLOBAL_MAX = 300;
const counters = { ip: new Map(), user: new Map() };
const mutationCounters = new Map();
const registrationCounters = new Map();
let globalCount = { count: 0, start: Date.now() };
const MUTATION_MAX = config.limits.mutations_per_15_minutes;

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

export function checkMutationAllowed(userId) {
  const nowMs = Date.now();
  const key = String(userId || '');
  const count = peek(mutationCounters, key, nowMs);
  if (count >= MUTATION_MAX) {
    const entry = mutationCounters.get(key);
    return { status: 429, retryAfter: retryAfter(entry, nowMs) };
  }
  bump(mutationCounters, key, nowMs);
  return null;
}

export function checkRegistrationAllowed(ip) {
  const nowMs = Date.now();
  const key = String(ip || 'unknown');
  const count = peek(registrationCounters, key, nowMs);
  if (count >= config.limits.registrations_per_15_minutes) {
    const entry = registrationCounters.get(key);
    return { status: 429, retryAfter: retryAfter(entry, nowMs) };
  }
  bump(registrationCounters, key, nowMs);
  return null;
}

export function recordLoginFailure(ip, username) {
  const nowMs = Date.now();
  bump(counters.ip, ip, nowMs);
  globalCount.count += 1;
  const userKey = String(username || '').trim().toLowerCase();
  if (!userKey) return false;
  const entry = bump(counters.user, userKey, nowMs);
  return entry.count === USER_MAX;
}

export function recordLoginSuccess(ip, username) {
  counters.ip.delete(ip);
  counters.user.delete(String(username || '').trim().toLowerCase());
}

export function pruneCounters() {
  const cutoff = Date.now() - WINDOW_MS;
  for (const map of [counters.ip, counters.user, mutationCounters, registrationCounters]) {
    for (const [key, entry] of map) if (entry.start < cutoff) map.delete(key);
  }
}

export function resetCounters() {
  counters.ip.clear();
  counters.user.clear();
  mutationCounters.clear();
  registrationCounters.clear();
  globalCount = { count: 0, start: Date.now() };
}

export const LOGIN_LIMITS = { WINDOW_MS, IP_MAX, USER_MAX, GLOBAL_MAX, MUTATION_MAX };
