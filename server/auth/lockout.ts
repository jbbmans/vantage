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

/** Refuses when the account is locked. Checked before the password, so a locked account cannot keep being guessed. */
export function assertNotLocked(ctx: AppContext, userId: string) {
  const r = row(ctx, userId);
  if (!r?.locked_until) return;
  const until = Date.parse(r.locked_until);
  if (until <= Date.now()) return;
  throw tooMany(`This account is locked after too many failed attempts. Try again after ${hhmm(r.locked_until, ctx.config.timezone)}, or ask your administrator to unlock it.`, Math.ceil((until - Date.now()) / 1000), 'account_locked');
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
