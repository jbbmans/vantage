import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { TEAM_MESSAGE_DELIVERIES, TEAM_MESSAGE_RETENTION_DAYS, type TeamMessageDelivery, type TeamMessageView } from '../../shared/teamMessages.ts';
import { recordDispositionRun } from './holds.ts';
import { audit } from './audit.ts';

interface TeamMessageRow {
  id: string; org_id: string; unit_id: string; sender_id: string; sender_name: string; unit_label: string; unit_name: string;
  subject: string; body: string; marking: string; files_confirmed_at: string | null; created_at: string;
}

/**
 * A kept team message, for someone who may open it (ADR-0049): its sender or a Marine it went to, while they are a member
 * of its Unit Instance. Anyone else, someone who has left the instance, and an id that is not one all get the same
 * nothing, so the page cannot be used to learn which messages exist.
 */
export function openTeamMessage(ctx: AppContext, user: SessionUser, scope: Scope, id: string): TeamMessageRow | null {
  const row = ctx.db.prepare('SELECT * FROM team_messages WHERE id = ?').get(id) as TeamMessageRow | undefined;
  if (!row || !scope.orgIds.includes(row.org_id)) return null;
  if (row.sender_id === user.id) return row;
  return ctx.db.prepare('SELECT 1 FROM team_message_recipients WHERE message_id = ? AND user_id = ?').get(id, user.id) ? row : null;
}

const keptUntil = (sentAt: string) => new Date(new Date(sentAt).getTime() + TEAM_MESSAGE_RETENTION_DAYS * 86_400_000).toISOString();

/** The message as its page shows it. How each Marine was reached is the sender's to see, as counts. */
export function teamMessageView(ctx: AppContext, user: SessionUser, row: TeamMessageRow): TeamMessageView {
  const files = ctx.db.prepare('SELECT id, original_name, mime_type, size_bytes, sha256, position FROM team_message_files WHERE message_id = ? ORDER BY position').all(row.id) as Array<{ id: string; original_name: string; mime_type: string; size_bytes: number; sha256: string; position: number }>;
  let delivery: TeamMessageView['delivery'] = null;
  if (row.sender_id === user.id) {
    const counts = Object.fromEntries(TEAM_MESSAGE_DELIVERIES.map((d) => [d, 0])) as Record<TeamMessageDelivery, number>;
    // A copy the receiving server asked to retry is read as the retry left it in the mail log: sent, given up or refused.
    const settled = ctx.db.prepare(`
      SELECT CASE WHEN r.delivery = 'queued' AND l.status = 'sent' THEN 'emailed'
                  WHEN r.delivery = 'queued' AND l.status = 'failed' THEN 'failed'
                  WHEN r.delivery = 'queued' AND l.status = 'refused' THEN 'refused'
                  ELSE r.delivery END AS delivery, COUNT(*) AS n
      FROM team_message_recipients r LEFT JOIN email_log l ON l.id = r.email_log_id
      WHERE r.message_id = ? GROUP BY 1`).all(row.id) as Array<{ delivery: TeamMessageDelivery; n: number }>;
    for (const r of settled) counts[r.delivery] += r.n;
    delivery = counts;
  }
  return {
    id: row.id, subject: row.subject, body: row.body, senderName: row.sender_name, unitLabel: row.unit_label, unitName: row.unit_name,
    marking: row.marking, sentAt: row.created_at, keptUntil: keptUntil(row.created_at),
    files: files.map((f) => ({ id: f.id, name: f.original_name, mime: f.mime_type, size: f.size_bytes, sha256: f.sha256, scanStatus: 'clean' as const, position: f.position })),
    delivery,
  };
}

/**
 * A copy still 'pending' at start was never sent: the server stopped part way through a send, after the message was kept
 * and its trail written and before that Marine's email went (ADR-0049 §5). Nothing sends it later, so it is recorded as
 * not delivered by email; the Marine has the message in Vantage. Run once at start, before any send can be in flight.
 */
export function settleInterruptedTeamSends(ctx: AppContext): number {
  return ctx.db.prepare("UPDATE team_message_recipients SET delivery = 'failed' WHERE delivery = 'pending'").run().changes;
}

/** One of a kept message's files, with its bytes, for someone who may open the message. */
export function teamMessageFile(ctx: AppContext, row: TeamMessageRow, fileId: string) {
  return ctx.db.prepare('SELECT id, original_name, mime_type, size_bytes, content FROM team_message_files WHERE id = ? AND message_id = ?').get(fileId, row.id) as
    { id: string; original_name: string; mime_type: string; size_bytes: number; content: Buffer } | undefined;
}

/**
 * Removes team messages older than the retention window, with their files and who they went to, except those a legal
 * hold keeps (ADR-0049): a hold on their Unit Instance or on every instance, a hold on the record type team_messages
 * (for one instance or every one), or a hold on the sender or on any Marine a message went to. Recorded as a
 * disposition run, and audited when it removes anything.
 */
export function expireTeamMessages(ctx: AppContext, days = TEAM_MESSAGE_RETENTION_DAYS): { expired: number; held: number; blocked: boolean } {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const due = (ctx.db.prepare('SELECT COUNT(*) AS n FROM team_messages WHERE created_at < ?').get(cutoff) as { n: number }).n;
  if (!due) return { expired: 0, held: 0, blocked: false };
  const holds = ctx.db.prepare(`SELECT scope, subject_id, record_type, org_id FROM legal_holds WHERE released_at IS NULL`).all() as Array<{ scope: string; subject_id: string | null; record_type: string | null; org_id: string | null }>;
  const instanceWide = (h: { scope: string; record_type: string | null }) => h.scope === 'instance' || (h.scope === 'record_type' && h.record_type === 'team_messages');
  const detail = (text: string) => `team messages older than ${days} days: ${text}`;
  if (holds.some((h) => instanceWide(h) && h.org_id === null)) {
    recordDispositionRun(ctx, { actorId: null, recordType: 'team_messages', disposition: 'destroy', eligible: due, acted: 0, held: due, detail: detail('kept under a hold on every Unit Instance') });
    return { expired: 0, held: due, blocked: true };
  }
  const orgs = JSON.stringify([...new Set(holds.filter((h) => instanceWide(h) && h.org_id).map((h) => h.org_id!))]);
  const users = JSON.stringify([...new Set(holds.filter((h) => h.scope === 'user' && h.subject_id).map((h) => h.subject_id!))]);
  // The recipient list and the files go with the message (ON DELETE CASCADE).
  const expired = ctx.db.prepare(
    `DELETE FROM team_messages
      WHERE created_at < ?
        AND org_id NOT IN (SELECT value FROM json_each(?))
        AND sender_id NOT IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM team_message_recipients r WHERE r.message_id = team_messages.id AND r.user_id IN (SELECT value FROM json_each(?)))`
  ).run(cutoff, orgs, users, users).changes;
  const held = due - expired;
  const said = detail(`${expired} removed${held ? `, ${held} kept under hold` : ''}`);
  recordDispositionRun(ctx, { actorId: null, recordType: 'team_messages', disposition: 'destroy', eligible: due, acted: expired, held, detail: said });
  if (expired) audit(ctx, { actor_id: null, action: 'team_messages_expired', entity: 'team_messages', detail: said });
  return { expired, held, blocked: false };
}
