import type { AppContext, SessionUser } from '../context.ts';
import { subtreeIds, membersAcross, orgOfUnit } from '../authz/scope.ts';
import { teamMessage } from './mailMessages.ts';
import { DEFAULT_REPORT_MARKING } from '../../shared/reportMarking.ts';
import { notify } from './notifications.ts';
import { getUnit } from './org.ts';
import { HttpError } from '../lib/errors.ts';

/** One message reaches at most this many Marines. A bigger command is messaged a team at a time, never cut short. */
export const MAX_RECIPIENTS = 300;

function recipients(ctx: AppContext, unitId: string, senderId: string) {
  const members = membersAcross(ctx, subtreeIds(ctx, unitId)).filter((m) => m.id !== senderId);
  const emails = new Map<string, string | null>();
  if (members.length) {
    const rows = ctx.db.prepare(`SELECT id, email FROM users WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(members.map((m) => m.id))) as Array<{ id: string; email: string | null }>;
    for (const r of rows) emails.set(r.id, r.email || null);
  }
  return members.map((m) => ({ id: m.id, email: emails.get(m.id) || null }));
}

/**
 * Who a message to this unit (and every team beneath it) would reach, and how. An address outside the allowed domains
 * (VANTAGE_EMAIL_ALLOWED_DOMAINS) is counted apart: that Marine gets the message in Vantage only.
 */
export function teamAudience(ctx: AppContext, unitId: string, senderId: string) {
  const list = recipients(ctx, unitId, senderId);
  const onFile = list.filter((r) => r.email);
  const outsideDomains = onFile.filter((r) => ctx.mailer.refusal(r.email!)).length;
  const withEmail = onFile.length - outsideDomains;
  return { members: list.length, withEmail, outsideDomains, appOnly: list.length - withEmail, emailEnabled: ctx.mailer.enabled, limit: MAX_RECIPIENTS };
}

/**
 * A leader's message to their unit. Everyone gets it in Vantage; those with an email address also get it by
 * email, one message each so no one sees anyone else's address. Replies go to the sender, not to the instance.
 */
export async function sendTeamMessage(ctx: AppContext, sender: SessionUser, unitId: string, input: { subject: string; body: string }) {
  // A subject becomes a mail header, so it is one line with no control characters, whatever was typed.
  const subject = [...input.subject].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/ {2,}/g, ' ').trim();
  const message = { subject, body: input.body };
  const unit = getUnit(ctx, unitId)!;
  const unitLabel = unit.short_name || unit.name;
  const senderName = [sender.rank_id, sender.first_name, sender.last_name].filter(Boolean).join(' ');
  const list = recipients(ctx, unitId, sender.id);
  // The roster is ordered by rank, so cutting it short would quietly leave out the most junior Marines.
  if (list.length > MAX_RECIPIENTS) throw new HttpError(400, `${unitLabel} and the teams beneath it hold ${list.length} Marines; one message reaches at most ${MAX_RECIPIENTS}. Send it to each team beneath instead.`, 'too_many_recipients');
  const mail = teamMessage({
    unitLabel, unitName: unit.name, subject: message.subject, body: message.body, senderName, replies: Boolean(sender.email),
    appUrl: ctx.config.urls.app, marking: ctx.runtime.reportMarking || DEFAULT_REPORT_MARKING, origin: ctx.config.urls.app,
  });
  const orgId = orgOfUnit(ctx, unitId);
  let emailed = 0; let queued = 0; let failed = 0; let refused = 0;
  for (const r of list) {
    notify(ctx, r.id, { kind: 'unit', title: `${unitLabel}: ${message.subject}`.slice(0, 140), message: message.body.slice(0, 400), actionUrl: '/team', orgId });
    if (!r.email || !ctx.mailer.enabled) continue;
    // Each address goes through the mailer's own check, so one outside the allowed domains is logged and audited.
    const result = await ctx.mailer.send({ to: r.email, subject: mail.subject, text: mail.text, html: mail.html, kind: 'team_message', userId: r.id, replyTo: sender.email || null, orgId, actorId: sender.id });
    if (result.ok && result.queued) queued++;
    else if (result.ok) emailed++;
    else if (result.refused) refused++;
    else failed++;
  }
  const noEmail = list.filter((r) => !r.email).length + (ctx.mailer.enabled ? 0 : list.filter((r) => r.email).length);
  return { recipients: list.length, emailed, queued, failed, refused, appOnly: noEmail + refused };
}
