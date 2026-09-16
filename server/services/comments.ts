import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { PERMISSIONS, can, scopeFor } from '../authz/scope.ts';
import { canRead, type RecordRow } from '../authz/records.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { newId, now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { notify } from './notifications.ts';
import { getRecord, isRecordTable } from './records.ts';
import type { RecordTable } from '../../shared/schemas.ts';

/**
 * Remarks people leave on a record.
 *
 * The whole design rests on one rule: a comment is exactly as visible as the thing it hangs on, and
 * there is no way to say otherwise. `comments` has no visibility column, so there is nothing to set
 * wrong. Every read and every write resolves the host record first and asks the host's own
 * permission functions. Move the host, and its conversation moves with it.
 *
 * The corollary is the part that is easy to get wrong: a mention is a notification, and a
 * notification about a record is a disclosure that the record exists. So a name is only resolved to
 * a mention if that person could already read the host on their own. Naming somebody who cannot see
 * a private counseling does not tell them it is there; the text keeps their name and nothing is
 * sent.
 */

export const COMMENTABLE = new Set<string>(['activities', 'awards', 'counselings', 'trainings', 'tasks', 'projects', 'goals']);

const MAX_BODY = 4000;

export interface CommentRow {
  id: string; record_table: string; record_id: string; author_id: string; unit_id: string | null;
  body: string; mentions: string; edited_at: string | null; deleted_at: string | null; created_at: string;
}

/** The host record, and the caller's standing on it. Throws rather than returning a partial answer. */
function host(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string) {
  if (!isRecordTable(table) || !COMMENTABLE.has(table)) throw notFound('That record type does not take comments.');
  const row = getRecord(ctx, table as RecordTable, id) as RecordRow | undefined;
  if (!row) throw notFound('No such record.');
  if (!canRead(scope, user.id, row)) throw forbidden('You cannot read that record.');
  return { table: table as RecordTable, row };
}

/** Whoever can read a record may discuss it. Reading and commenting are the same gate on purpose. */
function assertCanPost(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string) {
  return host(ctx, user, scope, table, id);
}

/**
 * Turn `@name` into user ids, keeping only people who can already read the host.
 * Matches username, or first/last name with no space, case-insensitively.
 */
function resolveMentions(ctx: AppContext, body: string, hostRow: RecordRow): string[] {
  // Trailing punctuation belongs to the sentence, not the name: "@nguyen." is a mention of nguyen.
  const names = [...new Set(
    (body.match(/@([A-Za-z0-9_.-]{2,64})/g) || [])
      .map((m) => m.slice(1).replace(/[.-]+$/, '').toLowerCase())
      .filter((n) => n.length >= 2)
  )];
  if (!names.length) return [];
  const found = ctx.db.prepare(
    `SELECT id, username, first_name, last_name FROM users WHERE active = 1 AND (
       lower(username) IN (${names.map(() => '?').join(',')})
       OR lower(first_name || last_name) IN (${names.map(() => '?').join(',')})
     )`
  ).all(...names, ...names) as Array<{ id: string; username: string; first_name: string; last_name: string }>;

  // A mention must not become a disclosure. Each candidate is checked against the host with their
  // own authority, not the author's: scopeFor builds the permissions that person actually holds.
  return found
    .filter((u) => (u.id === hostRow.user_id ? true : canRead(scopeFor(ctx, { id: u.id }), u.id, hostRow)))
    .map((u) => u.id);
}

export function listComments(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string) {
  host(ctx, user, scope, table, id);
  const rows = ctx.db.prepare(
    `SELECT c.id, c.record_table, c.record_id, c.author_id, c.body, c.mentions, c.edited_at, c.created_at,
            u.username AS author_username, u.first_name AS author_first_name, u.last_name AS author_last_name,
            r.abbr AS author_rank
       FROM comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE c.record_table = ? AND c.record_id = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at`
  ).all(table, id) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ ...r, mentions: JSON.parse(String(r.mentions || '[]')) as string[] }));
}

export function addComment(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string, rawBody: string, ip?: string) {
  const { row } = assertCanPost(ctx, user, scope, table, id);
  const body = String(rawBody || '').trim();
  if (!body) throw badRequest('Write something first.', { fieldErrors: { body: 'Required.' } });
  if (body.length > MAX_BODY) throw badRequest(`Keep a comment under ${MAX_BODY} characters.`, { fieldErrors: { body: `Limit ${MAX_BODY} characters.` } });

  const mentions = resolveMentions(ctx, body, row);
  const commentId = newId();
  const at = now();
  ctx.db.prepare(
    'INSERT INTO comments (id, record_table, record_id, author_id, unit_id, body, mentions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(commentId, table, id, user.id, row.unit_id ?? null, body, JSON.stringify(mentions), at);

  const who = `${user.first_name} ${user.last_name}`.trim() || user.username;
  notifyMentions(ctx, { targets: mentions, exclude: user.id, who, body, table, id, commentId });
  // The owner of the record hears about a remark on it, unless they wrote it or were already named.
  if (row.user_id !== user.id && !mentions.includes(row.user_id)) {
    notify(ctx, row.user_id, {
      kind: 'comment_added',
      title: `${who} commented on your record`,
      message: body.slice(0, 160),
      actionUrl: recordUrl(table, id),
      dedupeKey: `comment-owner:${commentId}:${row.user_id}`,
    });
  }

  audit(ctx, { actor_id: user.id, action: 'comment_added', entity: table, entity_id: id, subject_id: row.user_id, unit_id: row.unit_id ?? null, ip });
  return getComment(ctx, commentId)!;
}

/**
 * Tell people they were named. Shared by adding and editing, because a mention added while editing
 * is still a mention — the alternative is that whether somebody hears about it depends on whether
 * the author got the name into the first draft.
 */
function notifyMentions(
  ctx: AppContext,
  opts: { targets: string[]; exclude: string; who: string; body: string; table: string; id: string; commentId: string },
) {
  for (const target of opts.targets) {
    if (target === opts.exclude) continue;
    notify(ctx, target, {
      kind: 'comment_mention',
      title: `${opts.who} mentioned you`,
      message: opts.body.slice(0, 160),
      actionUrl: recordUrl(opts.table, opts.id),
      // Namespaced by kind as well as by comment and person. Sharing one key with the owner
      // notification below meant that being both the record's owner and named in it got you the
      // first of the two and silently dropped the second.
      dedupeKey: `comment-mention:${opts.commentId}:${target}`,
    });
  }
}

/**
 * Where a notification about a record should send somebody.
 *
 * Only tasks, projects and goals have a page of their own at /records/:table/:id. The career
 * records — awards, counselings, training — live under their tab on the Career screen, so a link to
 * the detail route would land them on "nothing to open here".
 */
function recordUrl(table: string, id: string) {
  if (table === 'activities') return `/records/${id}`;
  if (table === 'awards') return `/career?tab=awards#${id}`;
  if (table === 'counselings') return `/career?tab=counseling#${id}`;
  if (table === 'trainings') return `/career#${id}`;
  return `/records/${table}/${id}`;
}

export function getComment(ctx: AppContext, id: string) {
  const row = ctx.db.prepare(
    `SELECT c.id, c.record_table, c.record_id, c.author_id, c.body, c.mentions, c.edited_at, c.created_at,
            u.username AS author_username, u.first_name AS author_first_name, u.last_name AS author_last_name,
            r.abbr AS author_rank
       FROM comments c JOIN users u ON u.id = c.author_id LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE c.id = ? AND c.deleted_at IS NULL`
  ).get(id) as Record<string, unknown> | undefined;
  return row ? { ...row, mentions: JSON.parse(String(row.mentions || '[]')) as string[] } : null;
}

/** Your own words are yours to change. Nobody edits somebody else's remark, at any permission level. */
export function editComment(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string, commentId: string, rawBody: string, ip?: string) {
  const { row } = host(ctx, user, scope, table, id);
  const existing = ctx.db.prepare('SELECT * FROM comments WHERE id = ? AND record_table = ? AND record_id = ? AND deleted_at IS NULL').get(commentId, table, id) as CommentRow | undefined;
  if (!existing) throw notFound('No such comment.');
  if (existing.author_id !== user.id) throw forbidden('You can only edit your own comment.');
  const body = String(rawBody || '').trim();
  if (!body) throw badRequest('Write something first.', { fieldErrors: { body: 'Required.' } });
  if (body.length > MAX_BODY) throw badRequest(`Keep a comment under ${MAX_BODY} characters.`);
  const before = new Set(JSON.parse(existing.mentions || '[]') as string[]);
  const after = resolveMentions(ctx, body, row);
  ctx.db.prepare('UPDATE comments SET body = ?, mentions = ?, edited_at = ? WHERE id = ?')
    .run(body, JSON.stringify(after), now(), commentId);
  // Only the people who were not already named: editing a typo should not re-ping the thread.
  notifyMentions(ctx, {
    targets: after.filter((t) => !before.has(t)), exclude: user.id,
    who: `${user.first_name} ${user.last_name}`.trim() || user.username,
    body, table, id, commentId,
  });
  audit(ctx, { actor_id: user.id, action: 'comment_edited', entity: table, entity_id: id, subject_id: row.user_id, unit_id: row.unit_id ?? null, ip });
  return getComment(ctx, commentId)!;
}

/**
 * Remove a remark. The author always may. Somebody who can correct records in the host's unit may
 * too, because a conversation attached to a record needs a way to take down what should not be
 * there — and that removal is audited under their name.
 */
export function deleteComment(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string, commentId: string, ip?: string) {
  const { row } = host(ctx, user, scope, table, id);
  const existing = ctx.db.prepare('SELECT * FROM comments WHERE id = ? AND record_table = ? AND record_id = ? AND deleted_at IS NULL').get(commentId, table, id) as CommentRow | undefined;
  if (!existing) throw notFound('No such comment.');
  const moderator = Boolean(row.unit_id) && can(scope, PERMISSIONS.MANAGE_RECORDS, row.unit_id!);
  if (existing.author_id !== user.id && !moderator) throw forbidden('That comment is not yours to remove.');
  ctx.db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(now(), commentId);
  audit(ctx, {
    actor_id: user.id, action: existing.author_id === user.id ? 'comment_deleted' : 'comment_removed_by_moderator',
    entity: table, entity_id: id, subject_id: row.user_id, unit_id: row.unit_id ?? null, ip,
  });
  return { ok: true };
}
