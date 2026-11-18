import type { AppContext, SessionUser } from '../context.ts';
import type { PlatformPermission } from '../../shared/permissions.ts';
import { scopeFor, type Scope } from '../authz/scope.ts';
import { forbidden, HttpError, unauthorized } from '../lib/errors.ts';
import { currentSessionUser, liveSession } from './sessions.ts';

/**
 * The authority a request has now, after a wait (ADR-0035): a queued export's turn, a rendered file, a scan. Its session
 * must still be live (asked without renewing it), and the account is read as it stands, with a scope built afresh rather
 * than from the request's cache. A session that no longer stands is a 401, as a new request on it would be. What the
 * caller may do with the resource is then decided again by the caller's own rule, against what this returns.
 */
export function freshAuthority(ctx: AppContext, sessionId: string | null | undefined, userId: string): { user: SessionUser; scope: Scope } {
  const user = liveSession(ctx, sessionId, userId) ? currentSessionUser(ctx, userId) : null;
  if (!user) throw unauthorized();
  return { user, scope: scopeFor(ctx, user) };
}

/**
 * freshAuthority for the Vantage Administrator console (ADR-0035): after its wait, the session must still be live and
 * still confirmed (every console route sits behind a step-up), and the account must still hold `permission`, as the
 * route's own requirePlatform asked before the wait.
 */
export function freshPlatformAuthority(ctx: AppContext, sessionId: string | null | undefined, userId: string, permission: PlatformPermission): SessionUser {
  const live = liveSession(ctx, sessionId, userId);
  const user = live ? currentSessionUser(ctx, userId) : null;
  if (!live || !user) throw unauthorized();
  if (!user.platformPermissions.includes(permission)) throw forbidden('Your access changed while this was being prepared. Try again.', 'access_changed');
  if (!live.sudoUntil || new Date(live.sudoUntil).getTime() < Date.now()) throw new HttpError(403, 'Confirm your password to continue.', 'sudo_required');
  return user;
}
