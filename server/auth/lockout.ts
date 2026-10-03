import type { AppContext } from '../context.ts';
import { tooMany } from '../lib/errors.ts';
import { now } from '../lib/ids.ts';
import { audit } from '../services/audit.ts';

/**
 * An account locks after a few consecutive failures: a wrong password at sign-in, a wrong second factor, or a wrong
 * password when confirming a sensitive change. The count lives in the database, so a restart does not reset it and
 * every process sees the same lock. A passkey or a CAC still signs the person in: neither can be guessed.
 */

interface LockRow { failed_sign_ins: number; locked_until: string | null }

const row = (ctx: AppContext, userId: string) =>
  ctx.db.prepare('SELECT failed_sign_ins, locked_until FROM users WHERE id = ?').get(userId) as LockRow | undefined;

const hhmm = (iso: string, timeZone: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' });

/** The one answer for a locked name, whether or not an account has it. It names the ways back in that still work. */
const lockedError = (ctx: AppContext, untilIso: string) => tooMany(
  `This account is locked after too many failed attempts. Try again after ${hhmm(untilIso, ctx.config.timezone)}. A passkey, a CAC or a password reset link still signs you in, or ask your administrator to unlock it.`,
  Math.max(1, Math.ceil((Date.parse(untilIso) - Date.now()) / 1000)), 'account_locked');

/** Refuses when the account is locked. Checked before the password, so a locked account cannot keep being guessed. */
export function assertNotLocked(ctx: AppContext, userId: string) {
  const r = row(ctx, userId);
  if (!r?.locked_until) return;
  if (Date.parse(r.locked_until) <= Date.now()) return;
  throw lockedError(ctx, r.locked_until);
}

/**
 * A name that matches no account "locks" exactly as a real one does: the same count, the same answer, the same
 * length of time. Otherwise the third wrong password says "locked" for a real account and "incorrect" for a made-up
 * one, and the lock becomes a way to find out who has an account. Kept in memory: nothing about it needs to last.
 */
const phantoms = new Map<string, { count: number; until: number }>();
const PHANTOM_CAP = 20_000;

export function assertNameNotLocked(ctx: AppContext, name: string) {
  const p = phantoms.get(name);
  if (p?.until && p.until > Date.now()) throw lockedError(ctx, new Date(p.until).toISOString());
}

export function recordNameFailure(ctx: AppContext, name: string) {
  const { lockoutAttempts, lockoutMinutes } = ctx.config.security;
  const nowMs = Date.now();
  const p = phantoms.get(name);
  const count = (p && (!p.until || p.until > nowMs) ? p.count : 0) + 1;
  if (phantoms.size >= PHANTOM_CAP) { for (const [k, v] of phantoms) if (!v.until || v.until <= nowMs) phantoms.delete(k); if (phantoms.size >= PHANTOM_CAP) phantoms.clear(); }
  if (count >= lockoutAttempts) {
    const until = nowMs + lockoutMinutes * 60_000;
    phantoms.set(name, { count: 0, until });
    throw lockedError(ctx, new Date(until).toISOString());
  }
  phantoms.set(name, { count, until: 0 });
}

/** Counts a failure, and locks the account when it reaches the limit. Returns true when this failure locked it. */
export function recordFailure(ctx: AppContext, userId: string, { ip, where }: { ip?: string | null; where: 'password' | 'second_factor' | 'step_up' | 'password_change' }): boolean {
  const { lockoutAttempts, lockoutMinutes } = ctx.config.security;
  const current = row(ctx, userId);
  if (!current) return false;
  const lapsed = current.locked_until && Date.parse(current.locked_until) <= Date.now();
  const count = (lapsed ? 0 : current.failed_sign_ins) + 1;
  if (count >= lockoutAttempts) {
    const until = new Date(Date.now() + lockoutMinutes * 60_000).toISOString();
    ctx.db.prepare('UPDATE users SET failed_sign_ins = 0, locked_until = ? WHERE id = ?').run(until, userId);
    audit(ctx, { actor_id: userId, action: 'login_lockout', ip, detail: `${count} consecutive failures (${where}); locked until ${until}` });
    return true;
  }
  ctx.db.prepare('UPDATE users SET failed_sign_ins = ?, locked_until = CASE WHEN ? THEN NULL ELSE locked_until END WHERE id = ?').run(count, lapsed ? 1 : 0, userId);
  return false;
}

export function clearFailures(ctx: AppContext, userId: string) {
  ctx.db.prepare('UPDATE users SET failed_sign_ins = 0, locked_until = NULL WHERE id = ? AND (failed_sign_ins <> 0 OR locked_until IS NOT NULL)').run(userId);
}

/** An administrator's unlock, audited. */
export function unlockAccount(ctx: AppContext, userId: string, actorId: string, ip?: string | null) {
  const changed = ctx.db.prepare('UPDATE users SET failed_sign_ins = 0, locked_until = NULL WHERE id = ? AND locked_until IS NOT NULL').run(userId).changes;
  if (changed) audit(ctx, { actor_id: actorId, action: 'account_unlock', subject_id: userId, ip, detail: `at ${now()}` });
  return changed > 0;
}
