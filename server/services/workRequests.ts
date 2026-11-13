import type { AppContext, SessionUser } from '../context.ts';
import { conflict } from '../lib/errors.ts';

/** A retry is bound to its actor, case, operation and original payload; it never appends a second history entry. */
export interface WorkRequest { key: string; fingerprint: string }
export function workRequestKey(userId: string, itemId: string, request: WorkRequest): string {
  return `${userId}:${itemId}:bulk:${request.key}`;
}
export function replayedWorkRequest(ctx: AppContext, user: SessionUser, itemId: string, request: WorkRequest | undefined, kind: string): boolean {
  if (!request) return false;
  const prior = ctx.db.prepare('SELECT kind, actor_id, body FROM work_events WHERE idempotency_key = ?')
    .get(workRequestKey(user.id, itemId, request)) as { kind: string; actor_id: string | null; body: string } | undefined;
  if (!prior) return false;
  const body = JSON.parse(prior.body) as { request_fingerprint?: string };
  if (prior.actor_id !== user.id || prior.kind !== kind || body.request_fingerprint !== request.fingerprint) {
    throw conflict('This request identifier was already used for a different change. Preview again before applying it.', 'idempotency_conflict');
  }
  return true;
}
