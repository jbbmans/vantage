import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { can, isMember, PERMISSIONS } from '../authz/scope.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { parseEml, looksLikeOutlookMsg, EmlError, type ParsedEmail } from '../lib/eml.ts';
import { sanitizeEmailHtml, htmlToText } from '../lib/sanitizeHtml.ts';
import { readableItem } from './work.ts';

/**
 * Correspondence: who was asked, what came back, and whether the thing actually arrived.
 *
 * The state machine is the point. "They replied", "the supporting document arrived" and "the
 * question is settled" are three different facts, and collapsing them is how a queue ends up full
 * of items everyone believes are finished. Each has its own state and its own timestamp.
 *
 * A message is linked to documents, never copied per document. One email about a hundred
 * obligations is one email: it appears on all hundred, and it is stored, counted and shown once.
 */

export const THREAD_STATES = ['draft', 'sent', 'awaiting_reply', 'response_received', 'ksd_received', 'resolved'] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

/**
 * Which moves are allowed, and why.
 *
 * A thread can be resolved from anywhere, because a question can stop mattering. But it cannot jump
 * from "sent" straight to "the document arrived" without someone saying the document arrived, and
 * receiving a reply never implies receiving the document: "we're looking into it" is a response and
 * nothing else.
 */
const TRANSITIONS: Record<ThreadState, ThreadState[]> = {
  draft: ['sent', 'resolved'],
  sent: ['awaiting_reply', 'response_received', 'ksd_received', 'resolved'],
  awaiting_reply: ['response_received', 'ksd_received', 'resolved'],
  response_received: ['awaiting_reply', 'ksd_received', 'resolved'],
  ksd_received: ['awaiting_reply', 'resolved'],
  resolved: ['awaiting_reply'],
};

export interface ThreadRow {
  id: string; owner_id: string; unit_id: string | null; visibility: string;
  contact_id: string | null; subject: string; state: ThreadState;
  follow_up_at: string | null; last_message_at: string | null;
  response_at: string | null; ksd_at: string | null; resolved_at: string | null;
  provider: string | null; provider_thread_id: string | null; connector_id: string | null;
  version: number; deleted_at: string | null; created_at: string; updated_at: string;
}

function assertPlacement(scope: Scope, unitId: string | null, visibility: string) {
  if (visibility === 'private') return;
  if (!unitId) throw badRequest('Choose the unit this correspondence belongs to.');
  if (!isMember(scope, unitId)) throw forbidden('You are not a member of that unit.');
}

const readable = (scope: Scope, user: SessionUser, row: { owner_id: string; unit_id: string | null; visibility: string }) =>
  row.owner_id === user.id || (row.visibility === 'unit' && Boolean(row.unit_id) && isMember(scope, row.unit_id!));

const writable = (scope: Scope, user: SessionUser, row: { owner_id: string; unit_id: string | null; visibility: string }) =>
  row.owner_id === user.id || (Boolean(row.unit_id) && can(scope, PERMISSIONS.MANAGE_RECORDS, row.unit_id!));

// Contacts -------------------------------------------------------------

export function listContacts(ctx: AppContext, user: SessionUser, scope: Scope) {
  const units = scope.unitIds;
  const rows = units.length
    ? ctx.db.prepare(`SELECT * FROM contacts WHERE deleted_at IS NULL AND (owner_id = ? OR (visibility = 'unit' AND unit_id IN (${units.map(() => '?').join(',')}))) ORDER BY name`).all(user.id, ...units)
    : ctx.db.prepare('SELECT * FROM contacts WHERE deleted_at IS NULL AND owner_id = ? ORDER BY name').all(user.id);
  return rows as Array<Record<string, unknown>>;
}

export function saveContact(ctx: AppContext, user: SessionUser, scope: Scope, input: Record<string, unknown>, id?: string) {
  const name = String(input.name || '').trim().slice(0, 200);
  if (!name) throw badRequest('Give the contact a name.');
  const visibility = input.visibility === 'private' ? 'private' : 'unit';
  const unitId = (input.unit_id as string | null) || null;
  assertPlacement(scope, unitId, visibility);
  const email = String(input.email || '').trim().toLowerCase().slice(0, 255) || null;
  if (email && !email.includes('@')) throw badRequest('That does not look like an email address.');
  const at = now();
  const fields = [name, email, String(input.organization || '').slice(0, 200) || null, String(input.role || '').slice(0, 120) || null, String(input.phone || '').slice(0, 60) || null, String(input.notes || '').slice(0, 4000) || null];

  if (id) {
    const existing = ctx.db.prepare('SELECT * FROM contacts WHERE id = ? AND deleted_at IS NULL').get(id) as Record<string, unknown> | undefined;
    if (!existing) throw notFound('No such contact.');
    if (!writable(scope, user, existing as never)) throw forbidden('That contact is not yours to edit.');
    ctx.db.prepare('UPDATE contacts SET name = ?, email = ?, organization = ?, role = ?, phone = ?, notes = ?, visibility = ?, unit_id = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(...fields, visibility, unitId, at, id);
    return ctx.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  }
  const newContactId = newId();
  ctx.db.prepare('INSERT INTO contacts (id, owner_id, unit_id, visibility, name, email, organization, role, phone, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(newContactId, user.id, unitId, visibility, ...fields, at, at);
  return ctx.db.prepare('SELECT * FROM contacts WHERE id = ?').get(newContactId);
}

// Threads --------------------------------------------------------------

export interface ThreadFilters { state?: string | null; unitId?: string | null; contactId?: string | null; workItemId?: string | null; dueOnly?: boolean; q?: string | null }

export function listThreads(ctx: AppContext, user: SessionUser, scope: Scope, filters: ThreadFilters = {}) {
  const units = scope.unitIds;
  const where = ['t.deleted_at IS NULL'];
  const params: unknown[] = [];
  where.push(units.length
    ? `(t.owner_id = ? OR (t.visibility = 'unit' AND t.unit_id IN (${units.map(() => '?').join(',')})))`
    : '(t.owner_id = ?)');
  params.push(user.id, ...units);
  if (filters.state) { where.push('t.state = ?'); params.push(filters.state); }
  if (filters.unitId) { where.push('t.unit_id = ?'); params.push(filters.unitId); }
  if (filters.contactId) { where.push('t.contact_id = ?'); params.push(filters.contactId); }
  if (filters.workItemId) { where.push('t.id IN (SELECT thread_id FROM thread_links WHERE work_item_id = ?)'); params.push(filters.workItemId); }
  if (filters.dueOnly) { where.push("t.follow_up_at IS NOT NULL AND t.follow_up_at <= ? AND t.state NOT IN ('resolved', 'ksd_received')"); params.push(now().slice(0, 10)); }
  if (filters.q?.trim()) { where.push('lower(t.subject) LIKE ?'); params.push(`%${filters.q.trim().toLowerCase()}%`); }

  const rows = ctx.db.prepare(
    `SELECT t.*, c.name AS contact_name, c.organization AS contact_organization,
            (SELECT COUNT(*) FROM thread_messages m WHERE m.thread_id = t.id) AS message_count,
            (SELECT COUNT(*) FROM thread_links l WHERE l.thread_id = t.id) AS linked_items
       FROM threads t LEFT JOIN contacts c ON c.id = t.contact_id
      WHERE ${where.join(' AND ')}
      ORDER BY (t.follow_up_at IS NULL), t.follow_up_at, t.updated_at DESC LIMIT 300`
  ).all(...params) as Array<Record<string, unknown>>;
  return rows;
}

export function createThread(ctx: AppContext, user: SessionUser, scope: Scope, input: Record<string, unknown>) {
  const subject = String(input.subject || '').trim().slice(0, 500);
  if (!subject) throw badRequest('Give the thread a subject.');
  const visibility = input.visibility === 'private' ? 'private' : 'unit';
  const unitId = (input.unit_id as string | null) || null;
  assertPlacement(scope, unitId, visibility);
  const contactId = (input.contact_id as string | null) || null;
  if (contactId) {
    const contact = ctx.db.prepare('SELECT * FROM contacts WHERE id = ? AND deleted_at IS NULL').get(contactId) as Record<string, unknown> | undefined;
    if (!contact) throw notFound('No such contact.');
    if (!readable(scope, user, contact as never)) throw forbidden('That contact is not one you can use.');
  }
  const id = newId();
  const at = now();
  ctx.db.prepare('INSERT INTO threads (id, owner_id, unit_id, visibility, contact_id, subject, state, follow_up_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, user.id, unitId, visibility, contactId, subject, 'draft', (input.follow_up_at as string | null) || null, at, at);
  return getThread(ctx, id)!;
}

export function getThread(ctx: AppContext, id: string): ThreadRow | null {
  return (ctx.db.prepare('SELECT * FROM threads WHERE id = ? AND deleted_at IS NULL').get(id) as ThreadRow | undefined) || null;
}

export function readableThread(ctx: AppContext, user: SessionUser, scope: Scope, id: string): ThreadRow {
  const row = getThread(ctx, id);
  if (!row) throw notFound('No such thread.');
  if (!readable(scope, user, row)) throw forbidden('That correspondence is not yours to read.');
  return row;
}

export function threadDetail(ctx: AppContext, user: SessionUser, scope: Scope, id: string) {
  const thread = readableThread(ctx, user, scope, id);
  const messages = (ctx.db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY COALESCE(sent_at, created_at) ASC').all(id) as Array<Record<string, unknown>>)
    .map((m) => ({ ...m, to_emails: JSON.parse(String(m.to_emails || '[]')), cc_emails: JSON.parse(String(m.cc_emails || '[]')), attachments: JSON.parse(String(m.attachments || '[]')) }));
  const links = ctx.db.prepare(
    `SELECT l.id, l.work_item_id, l.created_at, w.natural_key, w.title, w.state
       FROM thread_links l JOIN work_items w ON w.id = l.work_item_id
      WHERE l.thread_id = ? AND w.deleted_at IS NULL ORDER BY w.natural_key`
  ).all(id) as Array<Record<string, unknown>>;
  const contact = thread.contact_id ? ctx.db.prepare('SELECT * FROM contacts WHERE id = ?').get(thread.contact_id) : null;
  return { thread, messages, links, contact };
}

export interface StateChange { state: ThreadState; at?: string | null; follow_up_at?: string | null; version?: number | null }

/**
 * Moves a thread's state, or refuses and explains.
 *
 * Each of the three "good news" states stamps its own time, so a report can say when the reply came
 * and when the document came, which are usually not the same day and sometimes weeks apart.
 */
export function setThreadState(ctx: AppContext, user: SessionUser, scope: Scope, id: string, change: StateChange) {
  if (!THREAD_STATES.includes(change.state)) throw badRequest('That is not a state a thread can be in.');
  return ctx.db.transaction(() => {
    const thread = getThread(ctx, id);
    if (!thread) throw notFound('No such thread.');
    if (!readable(scope, user, thread)) throw forbidden('That correspondence is not yours.');
    if (!writable(scope, user, thread)) throw forbidden('Only the person who owns this thread, or a leader who can edit shared records, can move it.');
    if (change.version != null && thread.version !== change.version) throw conflict('This thread changed while you were looking at it. Reload and try again.');
    if (thread.state !== change.state && !TRANSITIONS[thread.state].includes(change.state)) {
      throw badRequest(
        change.state === 'ksd_received' && thread.state === 'draft'
          ? 'A supporting document cannot arrive before anything was sent.'
          : `A thread cannot go from "${thread.state.replace(/_/g, ' ')}" to "${change.state.replace(/_/g, ' ')}".`,
      );
    }

    const at = change.at && /^\d{4}-\d{2}-\d{2}/.test(change.at) ? change.at : now();
    const stamps: Record<string, string | null> = {};
    if (change.state === 'response_received') stamps.response_at = at;
    if (change.state === 'ksd_received') stamps.ksd_at = at;
    if (change.state === 'resolved') stamps.resolved_at = at;
    // Reopening clears only the fact that stopped being true.
    if (change.state === 'awaiting_reply') stamps.resolved_at = null;

    const sets = ['state = ?', 'version = version + 1', 'updated_at = ?'];
    const params: unknown[] = [change.state, now()];
    for (const [key, value] of Object.entries(stamps)) { sets.push(`${key} = ?`); params.push(value); }
    if (change.follow_up_at !== undefined) { sets.push('follow_up_at = ?'); params.push(change.follow_up_at || null); }
    ctx.db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return getThread(ctx, id)!;
  })();
}

// Messages -------------------------------------------------------------

export interface MessageInput {
  direction: 'outbound' | 'inbound';
  subject?: string | null;
  body_text?: string | null;
  from_name?: string | null;
  from_email?: string | null;
  to_emails?: string[];
  cc_emails?: string[];
  sent_at?: string | null;
}

export function addMessage(ctx: AppContext, user: SessionUser, scope: Scope, threadId: string, input: MessageInput) {
  const thread = readableThread(ctx, user, scope, threadId);
  if (!writable(scope, user, thread)) throw forbidden('That correspondence is not yours to add to.');
  const direction = input.direction === 'inbound' ? 'inbound' : 'outbound';
  const at = now();
  const sentAt = input.sent_at && /^\d{4}-\d{2}-\d{2}/.test(input.sent_at) ? input.sent_at : at;
  const id = newId();
  ctx.db.prepare(
    `INSERT INTO thread_messages (id, thread_id, direction, source, from_name, from_email, to_emails, cc_emails, sent_at, subject, body_text, created_by, created_at)
     VALUES (?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, threadId, direction,
    String(input.from_name || '').slice(0, 200) || null,
    String(input.from_email || '').toLowerCase().slice(0, 255) || null,
    JSON.stringify((input.to_emails || []).slice(0, 100).map((e) => String(e).toLowerCase().slice(0, 255))),
    JSON.stringify((input.cc_emails || []).slice(0, 100).map((e) => String(e).toLowerCase().slice(0, 255))),
    sentAt, String(input.subject || thread.subject).slice(0, 500), String(input.body_text || '').slice(0, 100_000) || null,
    user.id, at,
  );
  ctx.db.prepare('UPDATE threads SET last_message_at = ?, version = version + 1, updated_at = ? WHERE id = ?').run(sentAt, at, threadId);
  return ctx.db.prepare('SELECT * FROM thread_messages WHERE id = ?').get(id);
}

/** Stores a parsed email against a thread, sanitizing before anything is written. */
export function storeParsedMessage(
  ctx: AppContext,
  threadId: string,
  parsed: ParsedEmail,
  meta: { direction: 'inbound' | 'outbound'; source: 'eml' | 'graph'; connectorId?: string | null; providerMessageId?: string | null; createdBy?: string | null },
) {
  const safe = sanitizeEmailHtml(parsed.html || '');
  const text = parsed.text || htmlToText(safe.html);
  const id = newId();
  const at = now();
  ctx.db.prepare(
    `INSERT INTO thread_messages (id, thread_id, direction, provider_message_id, connector_id, source, from_name, from_email, to_emails, cc_emails,
                                  sent_at, subject, body_text, body_html, blocked_remote_images, blocked_active_content, attachments, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, threadId, meta.direction, meta.providerMessageId || parsed.messageId, meta.connectorId || null, meta.source,
    parsed.from?.name || null, parsed.from?.email || null,
    JSON.stringify(parsed.to.map((a) => a.email)), JSON.stringify(parsed.cc.map((a) => a.email)),
    parsed.date || at, parsed.subject, text.slice(0, 100_000), safe.html.slice(0, 200_000),
    safe.blockedRemoteImages ? 1 : 0, safe.blockedActiveContent ? 1 : 0,
    JSON.stringify(parsed.attachments), meta.createdBy || null, at,
  );
  ctx.db.prepare('UPDATE threads SET last_message_at = ?, version = version + 1, updated_at = ? WHERE id = ?').run(parsed.date || at, at, threadId);
  return ctx.db.prepare('SELECT * FROM thread_messages WHERE id = ?').get(id) as Record<string, unknown>;
}

export interface ImportResult { thread: ThreadRow; message: Record<string, unknown>; created: boolean; replayed: boolean }

/**
 * Brings a saved .eml into a thread.
 *
 * A message already stored under the same provider id is not stored twice: importing the same file
 * again is a no-op, which is what happens when someone forwards a folder of saved mail.
 */
export function importEml(
  ctx: AppContext,
  user: SessionUser,
  scope: Scope,
  buffer: Buffer,
  opts: { threadId?: string | null; unitId?: string | null; visibility?: 'private' | 'unit'; contactId?: string | null; direction?: 'inbound' | 'outbound' },
): ImportResult {
  if (looksLikeOutlookMsg(buffer)) {
    throw badRequest('That is an Outlook .msg file. In Outlook, use Save As and choose the .eml format, then upload that. Vantage does not open .msg files.');
  }
  let parsed: ParsedEmail;
  try { parsed = parseEml(buffer); }
  catch (e) { throw e instanceof EmlError ? badRequest(e.message) : e; }

  const direction = opts.direction === 'outbound' ? 'outbound' : 'inbound';

  return ctx.db.transaction(() => {
    let thread = opts.threadId ? readableThread(ctx, user, scope, opts.threadId) : null;
    let created = false;

    if (thread) {
      if (!writable(scope, user, thread)) throw forbidden('That correspondence is not yours to add to.');
    } else {
      const visibility = opts.visibility === 'private' ? 'private' : 'unit';
      assertPlacement(scope, opts.unitId || null, visibility);
      thread = createThread(ctx, user, scope, {
        subject: parsed.subject, unit_id: opts.unitId || null, visibility, contact_id: opts.contactId || null,
      });
      created = true;
    }

    if (parsed.messageId) {
      const existing = ctx.db.prepare('SELECT * FROM thread_messages WHERE thread_id = ? AND provider_message_id = ?').get(thread.id, parsed.messageId) as Record<string, unknown> | undefined;
      // The same saved message imported twice is the same message.
      if (existing) return { thread: getThread(ctx, thread.id)!, message: existing, created, replayed: true };
    }

    const message = storeParsedMessage(ctx, thread.id, parsed, { direction, source: 'eml', createdBy: user.id });
    // Importing a reply is evidence that they replied, but it is not evidence that anything arrived.
    if (direction === 'inbound' && ['sent', 'awaiting_reply'].includes(thread.state)) {
      ctx.db.prepare("UPDATE threads SET state = 'response_received', response_at = COALESCE(response_at, ?), version = version + 1, updated_at = ? WHERE id = ?")
        .run(parsed.date || now(), now(), thread.id);
    }
    return { thread: getThread(ctx, thread.id)!, message, created, replayed: false };
  })();
}

// Links ----------------------------------------------------------------

/** Links a thread to a piece of work. Repeating the link is a no-op, not a second link. */
export function linkThread(ctx: AppContext, user: SessionUser, scope: Scope, threadId: string, workItemId: string) {
  const thread = readableThread(ctx, user, scope, threadId);
  if (!writable(scope, user, thread)) throw forbidden('That correspondence is not yours to link.');
  const item = readableItem(ctx, user, scope, workItemId);
  const existing = ctx.db.prepare('SELECT id FROM thread_links WHERE thread_id = ? AND work_item_id = ?').get(threadId, workItemId);
  if (existing) return { linked: false, work_item_id: item.id };
  ctx.db.prepare('INSERT INTO thread_links (id, thread_id, work_item_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(newId(), threadId, workItemId, user.id, now());
  return { linked: true, work_item_id: item.id };
}

export function unlinkThread(ctx: AppContext, user: SessionUser, scope: Scope, threadId: string, workItemId: string) {
  const thread = readableThread(ctx, user, scope, threadId);
  if (!writable(scope, user, thread)) throw forbidden('That correspondence is not yours to unlink.');
  ctx.db.prepare('DELETE FROM thread_links WHERE thread_id = ? AND work_item_id = ?').run(threadId, workItemId);
}

/** Links a thread to many pieces of work at once. Still one thread, one message, many links. */
export function linkThreadMany(ctx: AppContext, user: SessionUser, scope: Scope, threadId: string, workItemIds: string[]) {
  const unique = [...new Set(workItemIds.map(String))].slice(0, 500);
  return ctx.db.transaction(() => {
    let linked = 0;
    for (const itemId of unique) if (linkThread(ctx, user, scope, threadId, itemId).linked) linked += 1;
    return { linked, requested: unique.length };
  })();
}

/** Threads touching one piece of work, for the workbench's correspondence panel. */
export function threadsForItem(ctx: AppContext, user: SessionUser, scope: Scope, workItemId: string) {
  readableItem(ctx, user, scope, workItemId);
  return listThreads(ctx, user, scope, { workItemId });
}
