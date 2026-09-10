import type { AppContext } from '../context.ts';
import { newId, now } from '../lib/ids.ts';

export function notify(ctx: AppContext, userId: string, { kind, title, message = null, actionUrl = null, dedupeKey = null }: { kind: string; title: string; message?: string | null; actionUrl?: string | null; dedupeKey?: string | null }) {
  const result = ctx.db.prepare(
    `INSERT INTO notifications (id, user_id, kind, title, message, action_url, dedupe_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
  ).run(newId(), userId, kind, title, message, actionUrl, dedupeKey, now());
  return result.changes > 0;
}

export function notifyOperators(ctx: AppContext, payload: Parameters<typeof notify>[2], exceptId?: string) {
  const ops = ctx.db.prepare('SELECT id FROM users WHERE is_operator = 1 AND active = 1').all() as Array<{ id: string }>;
  for (const op of ops) if (op.id !== exceptId) notify(ctx, op.id, payload);
}
