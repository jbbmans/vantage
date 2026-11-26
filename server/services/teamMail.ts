import type { AppContext, SessionUser } from '../context.ts';
import { subtreeIds, membersAcross, orgOfUnit, can, PERMISSIONS } from '../authz/scope.ts';
import { freshAuthority } from '../auth/fresh.ts';
import { teamMessage } from './mailMessages.ts';
import { DEFAULT_REPORT_MARKING } from '../../shared/reportMarking.ts';
import { TEAM_MESSAGE_MAX_FILES, TEAM_MESSAGE_RETENTION_DAYS, type TeamAudience, type TeamMessageDelivery, type TeamMessageFileUpload, type TeamMessageResult } from '../../shared/teamMessages.ts';
import { notify } from './notifications.ts';
import { getUnit } from './org.ts';
import { audit } from './audit.ts';
import { featureOn } from './instanceFlags.ts';
import { inspectAttachment } from './attachments.ts';
import { scannerFor, MalwareRejected } from './scanner.ts';
import { databaseRoom } from '../db/size.ts';
import { recipientDomain } from '../lib/recipientDomains.ts';
import { formatFileSize } from '../../shared/attachments.ts';
import { HttpError, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import type { MailAttachment } from './email.ts';

/** One message reaches at most this many Marines. A bigger command is messaged a team at a time, never cut short. */
export const MAX_RECIPIENTS = 300;

interface Recipient { id: string; email: string | null }

function recipients(ctx: AppContext, unitId: string, senderId: string): Recipient[] {
  const members = membersAcross(ctx, subtreeIds(ctx, unitId)).filter((m) => m.id !== senderId);
  const emails = new Map<string, string | null>();
  if (members.length) {
    const rows = ctx.db.prepare(`SELECT id, email FROM users WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(members.map((m) => m.id))) as Array<{ id: string; email: string | null }>;
    for (const r of rows) emails.set(r.id, r.email || null);
  }
  return members.map((m) => ({ id: m.id, email: emails.get(m.id) || null }));
}

/** Files on a message to this unit: on for the service and not withheld from its Unit Instance (ADR-0014). */
const filesAllowed = (ctx: AppContext, unitId: string, senderId: string) => ctx.runtime.attachmentsEnabled && featureOn(ctx, 'attachments', unitId, senderId);

/**
 * Why files cannot go by email to this list now, or null when they can (ADR-0049). Only where the email goes: with email
 * off, or nobody on the list with an address, files stay in Vantage and none of this applies. The relay's TLS is proven
 * apart, by connecting (verifyAttachmentRoute), because that cannot be known without one.
 */
function emailFilesRefusal(ctx: AppContext, list: Recipient[]): { code: string; message: string; detail: string } | null {
  if (!ctx.mailer.enabled || !list.some((r) => r.email)) return null;
  if (!ctx.mailer.allowedDomains) {
    return { code: 'no_allowed_domains', detail: 'no allowed domains are set', message: 'Files go by email only to addresses on this deployment’s allowed domains, and none are set. A Vantage Administrator sets them (VANTAGE_EMAIL_ALLOWED_DOMAINS). Send the message without its files.' };
  }
  const outside = list.filter((r) => r.email && ctx.mailer.refusal(r.email));
  if (outside.length) {
    const domains = [...new Set(outside.map((r) => recipientDomain(r.email!) ?? 'not one address'))].sort();
    const shown = domains.length > 4 ? `${domains.slice(0, 4).join(', ')} and ${domains.length - 4} more` : domains.join(', ');
    const who = outside.length === 1 ? 'One Marine on this message has an address' : `${outside.length} Marines on this message have addresses`;
    return {
      code: 'recipients_outside_allowed_domains',
      detail: `${outside.length} addresses outside the allowed domains (${shown})`.slice(0, 300),
      message: `${who} outside the allowed domains (${shown}), so the files cannot go to ${outside.length === 1 ? 'them' : 'them all'} by email. Send the message without its files, or ask ${outside.length === 1 ? 'that Marine' : 'those Marines'} to use an address on the allowed domains.`,
    };
  }
  const route = ctx.mailer.attachmentRefusal();
  if (route) return { code: 'relay_not_tls', detail: `files need the TLS relay; provider ${ctx.mailer.provider}`, message: `${route} Send the message without its files.` };
  return null;
}

/**
 * Who a message to this unit (and every team beneath it) would reach, and how. An address the mailer refuses (outside
 * VANTAGE_EMAIL_ALLOWED_DOMAINS, or not one plain address) is counted apart: that Marine gets the message in Vantage only.
 * With files, why they cannot go now, so the dialog can say so before the leader writes anything.
 */
export function teamAudience(ctx: AppContext, unitId: string, senderId: string): TeamAudience {
  const list = recipients(ctx, unitId, senderId);
  const onFile = list.filter((r) => r.email);
  const refused = onFile.filter((r) => ctx.mailer.refusal(r.email!)).length;
  const withEmail = onFile.length - refused;
  const allowed = filesAllowed(ctx, unitId, senderId);
  const refusal = !ctx.runtime.attachmentsEnabled ? 'File attachments are off on Vantage right now.'
    : !allowed ? 'Vantage has turned file attachments off for this Unit Instance.'
      : emailFilesRefusal(ctx, list)?.message ?? null;
  return {
    members: list.length, withEmail, refused, appOnly: list.length - withEmail, emailEnabled: ctx.mailer.enabled, limit: MAX_RECIPIENTS,
    files: { refusal, byEmail: ctx.mailer.enabled && onFile.length > 0, maxFiles: TEAM_MESSAGE_MAX_FILES, maxBytes: ctx.config.attachments.maxBytes, allowedTypes: ctx.config.attachments.allowedTypes },
  };
}

/**
 * A send refused before anything is kept (ADR-0049): the code, why, and how many files, never a file's name. Also written
 * by the route for a body larger than its parser takes, where the files were never read (`files` null).
 */
export function auditTeamMessageRefusal(ctx: AppContext, a: { senderId: string; unitId: string; code: string; detail: string; files: number | null; ip: string | null }) {
  const count = a.files === null ? 'files not read' : `${a.files} file${a.files === 1 ? '' : 's'}`;
  audit(ctx, { actor_id: a.senderId, action: 'team_message_refused', entity: 'unit', entity_id: a.unitId, unit_id: a.unitId, detail: `${a.code}: ${a.detail}; ${count}`.slice(0, 600), ip: a.ip ?? undefined });
}

/**
 * Control characters a message's words never need (C0 but tab and line breaks, DEL, and C1, as attachments.ts counts
 * them): no mail client shows them, and SQLite's length() stops at NUL.
 */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

interface CheckedFile { name: string; mime: string; size: number; sha256: string; content: Buffer; scanner: string }

/** Base64 as the dialog sends it, read strictly: one that does not decode exactly is refused, never read loosely. */
function decodeFile(content: string): Buffer | null {
  if (!content || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return null;
  const bytes = Buffer.from(content, 'base64');
  return bytes.toString('base64') === content ? bytes : null;
}

export interface TeamMessageInput { subject: string; body: string; files?: TeamMessageFileUpload[]; confirmFiles?: boolean }

/**
 * A leader's message to their unit (ADR-0049). Vantage keeps it with its files for 180 days; everyone it went to gets a
 * notice that opens it, and those with an email address also get it by email, one message each so no one sees anyone
 * else's address, with the files attached. Replies go to the sender, not to the instance.
 *
 * Files go only once every check has passed, all before anything is kept, notified or emailed: each file scanned clean
 * now, and, where the email goes, an allow-list set with every address on it, and the relay taking TLS. The sender
 * confirms they cannot be withdrawn. Any refusal is audited (team_message_refused, never naming a file) and nothing is
 * kept or sent. `beforeKeep` runs once every check has passed, so the hourly count is used only by a message that goes.
 */
export async function sendTeamMessage(ctx: AppContext, sender: SessionUser, unitId: string, input: TeamMessageInput, opts: { sessionId: string; ip: string | null; beforeKeep?: () => void }): Promise<TeamMessageResult> {
  // A subject becomes a mail header, so it is one line with no control characters, whatever was typed.
  const subject = input.subject.replace(/\p{Cc}/gu, ' ').replace(/ {2,}/g, ' ').trim();
  // Line breaks and tabs stay; anything else below a space goes, so what is kept and emailed is what can be read.
  const body = input.body.replace(UNPRINTABLE, '').trim();
  const uploads = input.files ?? [];
  let unit = getUnit(ctx, unitId);
  if (!unit) throw notFound('No such unit.');
  const unitLabel = unit.short_name || unit.name;
  const orgId = orgOfUnit(ctx, unitId);
  const refuse = (error: HttpError, detail: string): never => {
    auditTeamMessageRefusal(ctx, { senderId: sender.id, unitId, code: error.code ?? 'refused', detail, files: uploads.length, ip: opts.ip });
    throw error;
  };
  // Typed control characters alone make no subject and no message; refused with a reason, before any file is read.
  if (!subject) refuse(new HttpError(400, 'Write a subject in words: control characters alone make none.', 'subject_empty'), 'the subject had only control characters');
  if (!body) refuse(new HttpError(400, 'Write the message in words: control characters alone make none.', 'message_empty'), 'the message had only control characters');
  if (!orgId) refuse(conflict(`${unitLabel} belongs to no Unit Instance, so a message to it cannot be kept. A Unit Manager can check where it sits.`, 'no_instance'), 'the unit has no Unit Instance');

  let list = recipients(ctx, unitId, sender.id);
  // The roster is ordered by rank, so cutting it short would quietly leave out the most junior Marines.
  const tooMany = (n: number) => refuse(new HttpError(400, `${unitLabel} and the teams beneath it hold ${n} Marines; one message reaches at most ${MAX_RECIPIENTS}. Send it to each team beneath instead.`, 'too_many_recipients'), `${n} recipients`);
  if (list.length > MAX_RECIPIENTS) tooMany(list.length);

  const files: CheckedFile[] = [];
  if (uploads.length) {
    if (!ctx.runtime.attachmentsEnabled) refuse(forbidden('File attachments are off on Vantage right now. Send the message without its files.', 'attachments_off'), 'attachments are off');
    if (!featureOn(ctx, 'attachments', unitId, sender.id)) refuse(forbidden('Vantage has turned file attachments off for this Unit Instance. Send the message without its files.', 'feature_withheld'), 'attachments withheld from the Unit Instance');
    if (uploads.length > TEAM_MESSAGE_MAX_FILES) refuse(new HttpError(400, `A message carries at most ${TEAM_MESSAGE_MAX_FILES} files.`, 'too_many_files'), 'too many files');
    if (input.confirmFiles !== true) refuse(new HttpError(400, 'Confirm that files cannot be withdrawn once the message is sent.', 'files_unconfirmed'), 'not confirmed');
    const { maxBytes, allowedTypes } = ctx.config.attachments;
    for (const upload of uploads) {
      const bytes = decodeFile(upload.content);
      if (!bytes) refuse(new HttpError(400, 'A file could not be read. Choose it again.', 'file_unreadable'), 'a file did not decode');
      const inspected = inspectAttachment({ body: bytes, filename: upload.name, contentType: upload.type, allowedTypes, maxBytes });
      if (!inspected.ok) refuse(new HttpError(400, `${String(upload.name).slice(0, 120)}: ${inspected.error}`, 'file_invalid'), inspected.error);
      else files.push({ name: inspected.filename, mime: inspected.mime, size: inspected.size, sha256: inspected.sha256, content: bytes!, scanner: '' });
    }
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > maxBytes) refuse(new HttpError(413, `Together the files are ${formatFileSize(total)}; a message carries at most ${formatFileSize(maxBytes)}.`, 'files_too_large'), `${total} bytes together`);
    if (new Set(files.map((f) => f.sha256)).size !== files.length) refuse(new HttpError(400, 'The same file is chosen twice. Remove one.', 'duplicate_file'), 'a file chosen twice');
    if (total >= databaseRoom(ctx.db, ctx.config.limits.maxDatabaseBytes)) refuse(new HttpError(507, 'The database is too close to its safety threshold for these files. Send the message without them.', 'database_capacity'), `${total} bytes`);
    const route = emailFilesRefusal(ctx, list);
    if (route) refuse(conflict(route.message, route.code), route.detail);

    // Only a clean verdict now lets a file go: no scanner, an error or a timeout is not clean, and a finding refuses it as such.
    const scanner = scannerFor({ clamd: ctx.config.intake.clamd, command: ctx.config.intake.scannerCommand });
    for (const file of files) {
      const result = await scanner.scan(file.content, file.name);
      if (result.verdict === 'rejected') refuse(new MalwareRejected(`${result.detail} Remove it and send again.`, result.finding || 'signature match'), `rejected by the malware scanner: ${result.finding || 'signature match'}`);
      if (result.verdict !== 'clean') refuse(conflict(`${file.name} was not scanned clean. ${result.detail} A file goes with a message only once the malware scanner finds it clean.`, 'file_not_clean'), `not scanned clean (${result.scanner})`);
      file.scanner = result.scanner.slice(0, 40);
    }
    // The relay must take TLS before anything is kept: a connection is opened, and closed without sending. Whether the
    // files go by email at all is read from the list as it is after the scans: from here to the reading again below
    // nothing awaits unless this connection does, so a Marine who gained an address meanwhile is not sent to unproven.
    if (ctx.mailer.enabled && recipients(ctx, unitId, sender.id).some((r) => r.email)) {
      const proven = await ctx.mailer.verifyAttachmentRoute();
      if (!proven.ok) refuse(conflict(proven.reason, 'relay_not_tls'), `the relay did not take TLS${proven.code ? ` (${proven.code})` : ''}`);
    }

    // The scans and the connection awaited. The sender's session, authority and the unit are read as they are now, and
    // the list again, so nothing goes to a unit they no longer lead or to someone who has joined it under an address the
    // files may not go to.
    const fresh = freshAuthority(ctx, opts.sessionId, sender.id);
    unit = getUnit(ctx, unitId);
    if (!unit) throw notFound('No such unit.');
    if (!can(fresh.scope, PERMISSIONS.MANAGE_MEMBERS, unitId)) throw forbidden('Only a leader who manages this unit’s members can message it.');
    if (!ctx.runtime.attachmentsEnabled) refuse(forbidden('Vantage turned file attachments off while the files were being checked. Send the message without its files.', 'attachments_off'), 'attachments turned off meanwhile');
    if (!featureOn(ctx, 'attachments', unitId, sender.id)) refuse(forbidden('Vantage turned file attachments off for this Unit Instance while the files were being checked. Send the message without its files.', 'feature_withheld'), 'attachments withheld from the Unit Instance meanwhile');
    list = recipients(ctx, unitId, sender.id);
    if (list.length > MAX_RECIPIENTS) tooMany(list.length);
    const again = emailFilesRefusal(ctx, list);
    if (again) refuse(conflict(again.message, again.code), again.detail);
  }
  try {
    opts.beforeKeep?.();
  } catch (error) {
    // The hourly count asked again once every check passed: a send that lost the last place meanwhile is refused here.
    if (error instanceof HttpError) refuse(error, 'the hourly count was used up while the message was checked');
    throw error;
  }

  const senderName = [sender.rank_id, sender.first_name, sender.last_name].filter(Boolean).join(' ');
  const marking = ctx.runtime.reportMarking || DEFAULT_REPORT_MARKING;
  const id = newId();
  const at = now();
  const emailing = ctx.mailer.enabled;
  const delivery = new Map<string, TeamMessageDelivery>(list.map((r) => [r.id, emailing && r.email ? 'pending' : 'app_only']));
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  ctx.db.transaction(() => {
    ctx.db.prepare('INSERT INTO team_messages (id, org_id, unit_id, sender_id, sender_name, unit_label, unit_name, subject, body, marking, files_confirmed_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, orgId, unitId, sender.id, senderName.slice(0, 200) || sender.username, unitLabel.slice(0, 200), unit!.name.slice(0, 200), subject, body, marking.slice(0, 200), files.length ? at : null, at);
    const addRecipient = ctx.db.prepare('INSERT INTO team_message_recipients (message_id, user_id, org_id, delivery) VALUES (?, ?, ?, ?)');
    for (const r of list) addRecipient.run(id, r.id, orgId, delivery.get(r.id));
    const addFile = ctx.db.prepare("INSERT INTO team_message_files (id, message_id, org_id, position, original_name, mime_type, size_bytes, sha256, scan_status, scanner, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'clean', ?, ?, ?)");
    // Each file that leaves by email is named in the trail, with its size, digest and verdict (ADR-0049, departing from
    // ADR-0025 §5 for files that leave Vantage). Each Marine it goes to is named as the entry's subject. All of it before
    // any email leaves, so a stop part way through still leaves the record of what was sent and to whom.
    files.forEach((f, i) => {
      const fileId = newId();
      addFile.run(fileId, id, orgId, i + 1, f.name, f.mime, f.size, f.sha256, f.scanner, f.content, at);
      audit(ctx, { actor_id: sender.id, action: 'team_message_file', entity: 'team_messages', entity_id: id, unit_id: unitId, org_id: orgId, detail: `file ${fileId}: ${f.name}; ${f.size} bytes; ${f.mime}; sha256 ${f.sha256}; scan clean (${f.scanner})`, ip: opts.ip ?? undefined });
    });
    for (const r of list) {
      const domain = r.email ? recipientDomain(r.email) : null;
      // An address the mailer's own check refuses (outside the allowed domains, or not one address) is never emailed, so
      // the trail says so rather than naming a route nothing takes. Only a message without files can have one.
      const how = !emailing || !r.email ? 'in Vantage only'
        : ctx.mailer.refusal(r.email) ? `in Vantage only; the address check refuses an address at ${domain ?? 'no readable domain'}`
          : `by email to an address at ${domain ?? 'no readable domain'}`;
      audit(ctx, { actor_id: sender.id, action: 'team_message_recipient', entity: 'team_messages', entity_id: id, subject_id: r.id, unit_id: unitId, org_id: orgId, detail: `${how}${files.length ? `; ${files.length} file${files.length === 1 ? '' : 's'}` : ''}`, ip: opts.ip ?? undefined });
      notify(ctx, r.id, { kind: 'unit', title: `${unitLabel}: ${subject}`.slice(0, 140), message: body.slice(0, 400), actionUrl: `/team/messages/${encodeURIComponent(id)}`, dedupeKey: `team_message:${id}`, orgId, actorId: sender.id });
    }
  })();

  const mail = teamMessage({
    unitLabel, unitName: unit!.name, subject, body, senderName, replies: Boolean(sender.email),
    messageUrl: `${ctx.config.urls.app}/team/messages/${encodeURIComponent(id)}`, marking, origin: ctx.config.urls.app,
    files: files.map((f) => ({ name: f.name, mime: f.mime, size: f.size })), keptDays: TEAM_MESSAGE_RETENTION_DAYS,
  });
  const attachments: MailAttachment[] = files.map((f) => ({ filename: f.name, contentType: f.mime, content: f.content }));
  // A queued copy keeps its mail log row, which the retry settles, so the sender's page reads how it ended.
  const setDelivery = ctx.db.prepare('UPDATE team_message_recipients SET delivery = ?, email_log_id = ? WHERE message_id = ? AND user_id = ?');
  let emailed = 0; let queued = 0; let failed = 0; let refused = 0;
  for (const r of list) {
    if (!r.email || !emailing) continue;
    // Each address goes through the mailer's own check, so one outside the allowed domains is logged and audited.
    const result = await ctx.mailer.send({ to: r.email, subject: mail.subject, text: mail.text, html: mail.html, kind: 'team_message', userId: r.id, replyTo: sender.email || null, orgId, actorId: sender.id, ...(attachments.length ? { attachments } : {}) });
    const how: TeamMessageDelivery = result.ok && result.queued ? 'queued' : result.ok ? 'emailed' : result.refused ? 'refused' : 'failed';
    if (how === 'queued') queued++; else if (how === 'emailed') emailed++; else if (how === 'refused') refused++; else failed++;
    setDelivery.run(how, how === 'queued' ? result.logId ?? null : null, id, r.id);
  }
  const noEmail = list.filter((r) => !r.email).length + (emailing ? 0 : list.filter((r) => r.email).length);
  const result: TeamMessageResult = { id, recipients: list.length, emailed, queued, failed, refused, appOnly: noEmail + refused, files: files.length };
  audit(ctx, {
    actor_id: sender.id, action: 'team_message', entity: 'unit', entity_id: unitId, unit_id: unitId, org_id: orgId, ip: opts.ip ?? undefined,
    detail: `message ${id}; ${result.recipients} recipients: ${emailed} emailed, ${queued} queued, ${failed} failed, ${result.appOnly} in Vantage only (${refused} refused by the address check); ${files.length ? `${files.length} file${files.length === 1 ? '' : 's'}, ${totalBytes} bytes` : 'no files'}; subject: ${subject.slice(0, 80)}`,
  });
  return result;
}
