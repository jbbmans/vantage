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

export const COMMENTABLE = new Set<string>(['activities', 'awards', 'counselings', 'trainings', 'tasks', 'projects', 'goals']);

const MAX_BODY = 4000;

export interface CommentRow {
  id: string; record_table: string; record_id: string; author_id: string; unit_id: string | null;
  body: string; mentions: string; edited_at: string | null; deleted_at: string | null; created_at: string;
}

function host(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string) {
  if (!isRecordTable(table) || !COMMENTABLE.has(table)) throw notFound('That record type does not take comments.');
  const row = getRecord(ctx, table as RecordTable, id) as RecordRow | undefined;
  if (!row) throw notFound('No such record.');
  if (!canRead(scope, user.id, row)) throw forbidden('You cannot read that record.');
  return { table: table as RecordTable, row };
}

function assertCanPost(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string) {
  return host(ctx, user, scope, table, id);
}

function resolveMentions(ctx: AppContext, body: string, hostRow: RecordRow): string[] {
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
      dedupeKey: `comment-mention:${opts.commentId}:${target}`,
    });
  }
}

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
  notifyMentions(ctx, {
    targets: after.filter((t) => !before.has(t)), exclude: user.id,
    who: `${user.first_name} ${user.last_name}`.trim() || user.username,
    body, table, id, commentId,
  });
  audit(ctx, { actor_id: user.id, action: 'comment_edited', entity: table, entity_id: id, subject_id: row.user_id, unit_id: row.unit_id ?? null, ip });
  return getComment(ctx, commentId)!;
}

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
