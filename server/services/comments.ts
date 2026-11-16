import type { AppContext, SessionUser } from '../context.ts';
import type { Scope } from '../authz/scope.ts';
import { PERMISSIONS, can, ownScope, scopeFor } from '../authz/scope.ts';
import { canRead, dutyReviewAuthority, unfinalized, type RecordRow } from '../authz/records.ts';
import { badRequest, conflict, forbidden, notFound, tooMany } from '../lib/errors.ts';
import { parse } from '../lib/http.ts';
import { newId, now } from '../lib/ids.ts';
import { limiters } from '../auth/limiter.ts';
import { audit } from './audit.ts';
import { holdState } from './holds.ts';
import { entityLabel, notify, recordLink, retractNotice, type NoticeEntity } from './notifications.ts';
import { getRecord, isRecordTable } from './records.ts';
import { stillCounsels } from './counselings.ts';
import { getItem, readable, type WorkItemRow } from './work.ts';
import { REDACTED } from '../../shared/constants.ts';
import type { RecordTable } from '../../shared/schemas.ts';
import {
  MENTION_MAX, PEOPLE_MAX, answerSchema, commentBodySchema, isRequestKind, requestSchema,
  type CommentKind, type DiscussionEntry, type RequestKind, type RequestState, type RequestSummary, type Speaker, type SpeakersResponse, type Told,
} from '../../shared/workflowMessages.ts';

/**
 * Workflow messaging (Task 24, ADR-0031). What is said is said on the record it is about, or on a work case: a comment, a
 * question or a review request to one named person, the answer to one, or the note an assignment carries. Nothing here is
 * a chat. One rule decides who may speak on a record, be asked about it, be named in it or be told what is said on it
 * (speaks); everybody else who reads the record reads its discussion and says nothing.
 */

/** The records that keep a discussion, and the work case, which takes questions and review requests but no comments. */
export const COMMENTABLE = new Set<string>(['activities', 'awards', 'trainings', 'counselings', 'tasks', 'projects', 'goals', 'duties', 'work_items']);

/** Questions and review requests one person may send in an hour. */
export const REQUESTS_PER_HOUR = 30;

export interface CommentRow {
  id: string; record_table: string; record_id: string; author_id: string; unit_id: string | null;
  body: string; mentions: string; edited_at: string | null; deleted_at: string | null; created_at: string;
  kind: CommentKind; addressee_id: string | null; state: RequestState | null; reply_to: string | null;
  closed_by: string | null; closed_at: string | null; private: number;
}

/** What a discussion hangs on: a record or a work case, as one shape. */
export interface Host {
  table: NoticeEntity;
  id: string;
  unitId: string | null;
  orgId: string | null;
  /** The Marine a record is about, or a work case's owner. */
  ownerId: string;
  visibility: string;
  record: (RecordRow & Record<string, unknown>) | null;
  item: WorkItemRow | null;
  /** Frozen (its Marine left the unit) or anonymized under a retention schedule: read, never spoken on. */
  closed: boolean;
}

const orgOf = (ctx: AppContext, unitId: string | null) =>
  unitId ? ((ctx.db.prepare('SELECT org_id FROM units WHERE id = ?').get(unitId) as { org_id: string | null } | undefined)?.org_id ?? null) : null;

export function loadHost(ctx: AppContext, table: string, id: string): Host | null {
  if (!COMMENTABLE.has(table)) return null;
  if (table === 'work_items') {
    const item = getItem(ctx, id);
    if (!item) return null;
    return { table, id, unitId: item.unit_id, orgId: orgOf(ctx, item.unit_id), ownerId: item.owner_id, visibility: item.visibility, record: null, item, closed: false };
  }
  if (!isRecordTable(table)) return null;
  const record = getRecord(ctx, table as RecordTable, id) as (RecordRow & Record<string, unknown>) | undefined;
  if (!record) return null;
  const anonymized = Object.values(record).some((v) => v === REDACTED);
  return {
    table: table as NoticeEntity, id, unitId: record.unit_id, orgId: orgOf(ctx, record.unit_id), ownerId: record.user_id,
    visibility: record.visibility, record, item: null, closed: Boolean(record.frozen_at) || anonymized,
  };
}

const reads = (host: Host, userId: string, scope: Scope) =>
  host.item ? readable(scope, { id: userId } as SessionUser, host.item) : canRead(scope, userId, host.record!);

/** The host as its reader may open it: no such record to one who may not see a counseling still in draft (ADR-0027). */
function openHost(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string): Host {
  if (!COMMENTABLE.has(table) || (table !== 'work_items' && !isRecordTable(table))) throw notFound('That record type does not take comments.');
  const host = loadHost(ctx, table, id);
  if (!host) throw notFound('No such record.');
  if (!reads(host, user.id, scope)) throw host.record && unfinalized(host.record) ? notFound('No such record.') : forbidden('You cannot read that record.');
  return host;
}

/** Each person's own scope (no Vantage access), worked out once per call. */
const scopes = (ctx: AppContext) => {
  const cache = new Map<string, Scope>();
  return (userId: string) => {
    if (!cache.has(userId)) cache.set(userId, ownScope(scopeFor(ctx, { id: userId })));
    return cache.get(userId)!;
  };
};

/**
 * May this person speak on this record: write on it, be asked about it, be named in it, be offered in its picker or be
 * told what is said on it? They read it by their own place in units (Vantage access reads, and never speaks), it is
 * neither frozen nor anonymized, and they belong to its Unit Instance, or it is their own record and in none.
 */
export function speaks(ctx: AppContext, host: Host, userId: string, scope?: Scope): boolean {
  if (host.closed) return false;
  const person = ctx.db.prepare('SELECT active FROM users WHERE id = ?').get(userId) as { active: number } | undefined;
  if (!person?.active) return false;
  const own = ownScope(scope ?? scopeFor(ctx, { id: userId }));
  if (!reads(host, userId, own)) return false;
  if (host.orgId && own.orgIds.includes(host.orgId)) return true;
  return host.ownerId === userId && (host.visibility === 'private' || !host.unitId);
}

/** A counseling's two parties: its Marine and its counselor. What was said before it was final is theirs alone. */
const parties = (host: Host) => new Set([host.ownerId, ...(host.record?.counselor_id ? [String(host.record.counselor_id)] : [])]);
const seesPrivate = (host: Host, userId: string) => parties(host).has(userId);
/** Said now, would it be private? On a counseling its counselor has not finalized. */
const privateNow = (host: Host) => host.table === 'counselings' && Boolean(host.record && unfinalized(host.record));

function heldFrom(ctx: AppContext, host: Host, authorId: string) {
  const holds = holdState(ctx, host.orgId ?? undefined);
  return holds.instance || holds.types.has(host.table) || holds.users.has(host.ownerId) || holds.users.has(authorId);
}

const nameOf = (u: { first_name?: string | null; last_name?: string | null; username?: string | null; rank?: string | null }) =>
  [u.rank, `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || u.username].filter(Boolean).join(' ');

export const whoActs = (user: Pick<SessionUser, 'first_name' | 'last_name' | 'username'>) => `${user.first_name} ${user.last_name}`.trim() || user.username;

// ---------------------------------------------------------------------------------------------------------------------
// Who can be named or asked: the record's Marine and its Unit Instance's members, never the whole service.

interface Candidate { id: string; username: string; first_name: string; last_name: string; rank: string | null }

/** For a private entry, or one that would be private if said now, the pool is the counseling's two parties alone. */
function pool(ctx: AppContext, host: Host, isPrivate: boolean, where: string, params: unknown[], limit: number, offset = 0): Candidate[] {
  const party = isPrivate ? [...parties(host)] : null;
  const inPool = party
    ? 'u.id IN (SELECT value FROM json_each(?))'
    : '(u.id = ? OR (? IS NOT NULL AND EXISTS (SELECT 1 FROM unit_members m JOIN units un ON un.id = m.unit_id WHERE m.user_id = u.id AND un.org_id = ?)))';
  const poolParams = party ? [JSON.stringify(party)] : [host.ownerId, host.orgId, host.orgId];
  return ctx.db.prepare(
    `SELECT u.id, u.username, u.first_name, u.last_name, r.abbr AS rank FROM users u LEFT JOIN ranks r ON r.id = u.rank_id
      WHERE u.active = 1 AND ${inPool} AND (${where}) ORDER BY u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE, u.id LIMIT ? OFFSET ?`
  ).all(...poolParams, ...params, limit, offset) as Candidate[];
}

/** `@name` not preceded by a letter, digit or name character, so an e-mail address is no mention. */
const MENTION = /(?<![A-Za-z0-9_.-])@([A-Za-z0-9_.-]{2,64})/g;

function mentionNames(body: string): string[] {
  return [...new Set([...body.matchAll(MENTION)].map((m) => m[1].replace(/[.-]+$/, '').toLowerCase()).filter((n) => n.length >= 2))];
}

/**
 * Who a message names: `@username` exactly, or a run-together first and last name when exactly one such person may be
 * named on this record. Everyone else named is "not told", without saying why. A private message, one said before a
 * counseling was final, names only its two parties, even when it is edited once the counseling is final.
 */
function resolveMentions(ctx: AppContext, host: Host, author: SessionUser, body: string, isPrivate: boolean): Told & { ids: string[] } {
  const names = mentionNames(body);
  if (names.length > MENTION_MAX) throw badRequest(`Name at most ${MENTION_MAX} people in one message.`, { fieldErrors: { body: `At most ${MENTION_MAX} @names.` } });
  if (!names.length) return { ids: [], told: [], not_told: [] };
  const marks = names.map(() => '?').join(',');
  const found = pool(ctx, host, isPrivate, `lower(u.username) IN (${marks}) OR lower(u.first_name || u.last_name) IN (${marks})`, [...names, ...names], 200);
  const scopeOf = scopes(ctx);
  const told: Told['told'] = [];
  const notTold: string[] = [];
  for (const name of names) {
    const exact = found.find((u) => u.username.toLowerCase() === name);
    const byName = found.filter((u) => `${u.first_name}${u.last_name}`.toLowerCase() === name);
    const person = exact ?? (byName.length === 1 ? byName[0] : null);
    if (person?.id === author.id) continue;
    if (person && told.some((t) => t.id === person.id)) continue;
    if (person && speaks(ctx, host, person.id, scopeOf(person.id))) told.push({ id: person.id, name: nameOf(person) });
    else notTold.push(`@${name}`);
  }
  return { ids: told.map((t) => t.id), told, not_told: notTold };
}

/** May this person be asked to review this duty: one who may decide it (ADR-0024), never its own Marine. */
const reviewsDuty = (host: Host, userId: string, scope: Scope) => userId !== host.ownerId && dutyReviewAuthority(scope, userId, host.record!).review;

/** How many of a Unit Instance's members the picker reads at a time while it looks for people it may offer. */
const PEOPLE_PAGE = 100;
/** The most members one lookup reads. Past them it stops, says so, and typing more of a name narrows what it reads. */
export const PEOPLE_SCAN = 2000;

/**
 * Who could read a record or case at all, as SQL over `u`: cheap to test, and wider than who does, so the picker works
 * out each member's authority only for those who might have it, not for a whole Unit Instance. `speaks()` still decides.
 * It follows how a record is read (canRead) and a case (readable): a record not shared with its unit is read only by its
 * Marine and counselor; one shared is read also by its assignee, by the members of its unit when it has one, and by
 * whoever holds a role or leads a unit, where View shared records comes from; a case shared with its unit is read by
 * that unit's members, any other by its owner and holder.
 */
function mightRead(host: Host): { where: string; params: unknown[] } {
  const named = (ids: Array<unknown>) => JSON.stringify(ids.filter((v): v is string => typeof v === 'string' && v.length > 0));
  if (host.item) {
    const item = host.item;
    if (item.visibility === 'unit' && item.unit_id) return { where: 'EXISTS (SELECT 1 FROM unit_members cm WHERE cm.user_id = u.id AND cm.unit_id = ?)', params: [item.unit_id] };
    return { where: 'u.id IN (SELECT value FROM json_each(?))', params: [named([item.owner_id, item.claimed_by])] };
  }
  const r = host.record!;
  if (r.visibility !== 'unit' || !r.unit_id) return { where: 'u.id IN (SELECT value FROM json_each(?))', params: [named([r.user_id, r.counselor_id])] };
  return {
    where: `(u.id IN (SELECT value FROM json_each(?)) OR EXISTS (SELECT 1 FROM member_roles mr WHERE mr.user_id = u.id)
             OR EXISTS (SELECT 1 FROM units ou WHERE ou.owner_user_id = u.id)${r.assignee_id ? ' OR EXISTS (SELECT 1 FROM unit_members am WHERE am.user_id = u.id AND am.unit_id = ?)' : ''})`,
    params: [named([r.user_id, r.counselor_id, r.assignee_id]), ...(r.assignee_id ? [r.unit_id] : [])],
  };
}

/**
 * People who may be named or asked on a record, matching what was typed: for the composer's picker. Given the kind of
 * request being written, only those it may go to; any other kind is ignored. Who may be offered is decided before the
 * list is cut to its length, so someone further down the alphabet is offered when those before them may not be.
 * `more` says the lookup stopped at its limit before it had read every match.
 */
export function listSpeakers(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string, q: string, kind?: unknown): SpeakersResponse {
  const host = openHost(ctx, user, scope, table, id);
  const limited = limiters.peopleLookups.limited(user.id);
  if (limited) throw tooMany('Too many lookups in a short time. Try again shortly.', limited.retryAfter);
  limiters.peopleLookups.bump(user.id);
  if (!speaks(ctx, host, user.id, scope)) return { people: [], more: false };
  const term = `%${String(q || '').trim().toLowerCase().slice(0, 60).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const like = `lower(u.username) LIKE ? ESCAPE '\\' OR lower(u.first_name) LIKE ? ESCAPE '\\' OR lower(u.last_name) LIKE ? ESCAPE '\\' OR lower(u.first_name || ' ' || u.last_name) LIKE ? ESCAPE '\\'`;
  const dutyReview = host.table === 'duties' && kind === 'review_request';
  const scopeOf = scopes(ctx);
  const offered = (c: Candidate) => speaks(ctx, host, c.id, scopeOf(c.id)) && (!dutyReview || reviewsDuty(host, c.id, scopeOf(c.id)));
  const reader = mightRead(host);
  const candidates = (limit: number, offset: number) =>
    pool(ctx, host, privateNow(host), `u.id <> ? AND (${like}) AND ${reader.where}`, [user.id, term, term, term, term, ...reader.params], limit, offset);
  const people: Speaker[] = [];
  for (let read = 0; read < PEOPLE_SCAN; read += PEOPLE_PAGE) {
    const page = candidates(PEOPLE_PAGE, read);
    for (const c of page) {
      if (!offered(c)) continue;
      people.push({ id: c.id, username: c.username, name: nameOf(c), rank: c.rank });
      if (people.length === PEOPLE_MAX) return { people, more: false };
    }
    if (page.length < PEOPLE_PAGE) return { people, more: false };
  }
  // Read to the limit: there is more only if someone is left past it.
  return { people, more: candidates(1, PEOPLE_SCAN).length > 0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a discussion.

const ENTRY = `SELECT c.id, c.record_table, c.record_id, c.kind, c.author_id, c.body, c.mentions, c.addressee_id, c.state, c.reply_to,
            c.closed_at, c.private, c.edited_at, c.created_at,
            u.username AS author_username, u.first_name AS author_first_name, u.last_name AS author_last_name, r.abbr AS author_rank,
            a.first_name AS addressee_first_name, a.last_name AS addressee_last_name, a.username AS addressee_username, ar.abbr AS addressee_rank
       FROM comments c
       JOIN users u ON u.id = c.author_id
       LEFT JOIN ranks r ON r.id = u.rank_id
       LEFT JOIN users a ON a.id = c.addressee_id
       LEFT JOIN ranks ar ON ar.id = a.rank_id`;

type EntryRow = Omit<DiscussionEntry, 'mentions' | 'private' | 'addressee_name'> & {
  mentions: string; private: number;
  addressee_first_name: string | null; addressee_last_name: string | null; addressee_username: string | null; addressee_rank: string | null;
};

function shape(row: EntryRow, canAnswer?: boolean): DiscussionEntry {
  const { addressee_first_name, addressee_last_name, addressee_username, addressee_rank, ...rest } = row;
  return {
    ...rest,
    mentions: JSON.parse(String(row.mentions || '[]')) as string[],
    private: Boolean(row.private),
    addressee_name: row.addressee_id ? nameOf({ first_name: addressee_first_name, last_name: addressee_last_name, username: addressee_username, rank: addressee_rank }) : null,
    ...(canAnswer === undefined ? {} : { can_answer: canAnswer }),
  };
}

export function listComments(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string): DiscussionEntry[] {
  const host = openHost(ctx, user, scope, table, id);
  const rows = ctx.db.prepare(`${ENTRY} WHERE c.record_table = ? AND c.record_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at, c.id`).all(host.table, host.id) as EntryRow[];
  const scopeOf = scopes(ctx);
  const answers = new Map<string, boolean>();
  return rows
    .filter((r) => !r.private || seesPrivate(host, user.id))
    .map((r) => {
      if (r.state !== 'open' || !r.addressee_id) return shape(r);
      if (!answers.has(r.addressee_id)) answers.set(r.addressee_id, speaks(ctx, host, r.addressee_id, scopeOf(r.addressee_id)));
      return shape(r, answers.get(r.addressee_id));
    });
}

export function getComment(ctx: AppContext, id: string): DiscussionEntry | null {
  const row = ctx.db.prepare(`${ENTRY} WHERE c.id = ? AND c.deleted_at IS NULL`).get(id) as EntryRow | undefined;
  return row ? shape(row) : null;
}

/** One entry of this host's discussion its reader may see; any other is no such entry. */
function entryOn(ctx: AppContext, host: Host, user: SessionUser, commentId: string): CommentRow {
  const row = ctx.db.prepare('SELECT * FROM comments WHERE id = ? AND record_table = ? AND record_id = ? AND deleted_at IS NULL').get(commentId, host.table, host.id) as CommentRow | undefined;
  if (!row || (row.private && !seesPrivate(host, user.id))) throw notFound('No such comment.');
  return row;
}

function assertSpeaks(ctx: AppContext, host: Host, user: SessionUser, scope: Scope) {
  if (host.closed) throw forbidden(host.record?.frozen_at ? 'This record is frozen because its Marine left the unit. Its discussion is kept as it was.' : 'This record was anonymized under a retention schedule. Its discussion is kept as it was.', 'discussion_closed');
  if (!speaks(ctx, host, user.id, scope)) throw forbidden('You can read this record, but not speak on it.', 'not_a_speaker');
}

// ---------------------------------------------------------------------------------------------------------------------
// Comments.

/**
 * Everyone a new comment is for: the record's Marine, its counselor while they still counsel, its assignee, a case's
 * holder, and everyone who has spoken or been asked in its discussion, while each may still speak on it. A comment said
 * on a counseling before it is final is for its two parties alone.
 */
function audience(ctx: AppContext, host: Host, authorId: string, isPrivate: boolean): string[] {
  const candidates = new Set<string>([host.ownerId]);
  if (host.record?.counselor_id) candidates.add(String(host.record.counselor_id));
  if (host.record?.assignee_id) candidates.add(String(host.record.assignee_id));
  if (host.item?.claimed_by) candidates.add(host.item.claimed_by);
  // Those asked in it, not those an assignment note was for: a former assignee given a note hears no more than one given none.
  const said = ctx.db.prepare(`SELECT author_id AS id FROM comments WHERE record_table = ? AND record_id = ? AND deleted_at IS NULL
                               UNION SELECT addressee_id FROM comments WHERE record_table = ? AND record_id = ? AND addressee_id IS NOT NULL
                                 AND kind IN ('review_request', 'clarification_request') AND deleted_at IS NULL`)
    .all(host.table, host.id, host.table, host.id) as Array<{ id: string }>;
  for (const { id } of said) candidates.add(id);
  candidates.delete(authorId);
  const scopeOf = scopes(ctx);
  return [...candidates].filter((id) => {
    if (isPrivate && !seesPrivate(host, id)) return false;
    const s = scopeOf(id);
    if (!speaks(ctx, host, id, s)) return false;
    // A counselor hears what is said on a counseling while they still counsel its Marine, not because they once wrote it.
    if (host.record?.counselor_id === id && id !== host.ownerId) return stillCounsels(ctx, s, id, host.record);
    return true;
  });
}

function tellMentions(ctx: AppContext, host: Host, actor: SessionUser, commentId: string, targets: readonly string[]) {
  for (const target of targets) {
    notify(ctx, target, {
      kind: 'comment_mention', title: `${whoActs(actor)} mentioned you`, actionUrl: recordLink(host.table, host.id),
      entity: host.table, entityId: host.id, actorId: actor.id, orgId: host.orgId, dedupeKey: `comment-mention:${commentId}:${target}`,
    });
  }
}

export function addComment(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string, rawBody: unknown, ip?: string) {
  const host = openHost(ctx, user, scope, table, id);
  if (host.item) throw badRequest('A case keeps its own notes in its history. Ask a question or ask for a review here instead.', { code: 'case_comment' });
  assertSpeaks(ctx, host, user, scope);
  const { body } = parse(commentBodySchema, { body: typeof rawBody === 'string' ? rawBody : '' });
  const isPrivate = privateNow(host);
  const mentioned = resolveMentions(ctx, host, user, body, isPrivate);
  const commentId = newId();
  ctx.db.transaction(() => {
    ctx.db.prepare(`INSERT INTO comments (id, record_table, record_id, author_id, unit_id, body, mentions, created_at, kind, private)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'comment', ?)`)
      .run(commentId, host.table, host.id, user.id, host.unitId, body, JSON.stringify(mentioned.ids), now(), isPrivate ? 1 : 0);
    tellMentions(ctx, host, user, commentId, mentioned.ids);
    for (const target of audience(ctx, host, user.id, isPrivate)) {
      if (mentioned.ids.includes(target)) continue;
      // What a counselor and their Marine say to each other on a counseling cannot be turned off.
      const between = host.table === 'counselings' && parties(host).has(target) && parties(host).has(user.id);
      notify(ctx, target, {
        kind: between ? 'counseling_comment' : 'comment_added', title: `${whoActs(user)} commented`, actionUrl: recordLink(host.table, host.id),
        entity: host.table, entityId: host.id, actorId: user.id, orgId: host.orgId,
      });
    }
    audit(ctx, { actor_id: user.id, action: 'comment_added', entity: host.table, entity_id: host.id, subject_id: host.ownerId, unit_id: host.unitId, detail: `comment ${commentId}`, ip });
  })();
  return { ...getComment(ctx, commentId)!, told: mentioned.told, not_told: mentioned.not_told };
}

export function editComment(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string, commentId: string, rawBody: unknown, ip?: string) {
  const host = openHost(ctx, user, scope, table, id);
  const existing = entryOn(ctx, host, user, commentId);
  if (existing.author_id !== user.id) throw forbidden('You can only edit your own comment.');
  if (existing.kind !== 'comment') throw forbidden('A request, an answer or an assignment note is kept as it was said. Withdraw a request and ask again instead.', 'kept_as_said');
  assertSpeaks(ctx, host, user, scope);
  if (heldFrom(ctx, host, existing.author_id)) throw forbidden('A legal hold keeps this discussion as it is. It cannot be edited while the hold stands.', 'held');
  const { body } = parse(commentBodySchema, { body: typeof rawBody === 'string' ? rawBody : '' });
  const before = new Set(JSON.parse(existing.mentions || '[]') as string[]);
  // An edit keeps the entry's own privacy: what was said between a counseling's two parties stays theirs once it is final.
  const mentioned = resolveMentions(ctx, host, user, body, Boolean(existing.private));
  ctx.db.transaction(() => {
    ctx.db.prepare('UPDATE comments SET body = ?, mentions = ?, edited_at = ? WHERE id = ?').run(body, JSON.stringify(mentioned.ids), now(), commentId);
    tellMentions(ctx, host, user, commentId, mentioned.ids.filter((t) => !before.has(t)));
    audit(ctx, { actor_id: user.id, action: 'comment_edited', entity: host.table, entity_id: host.id, subject_id: host.ownerId, unit_id: host.unitId, detail: `comment ${commentId}`, ip });
  })();
  return { ...getComment(ctx, commentId)!, told: mentioned.told.filter((t) => !before.has(t.id)), not_told: mentioned.not_told };
}

export function deleteComment(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string, commentId: string, ip?: string) {
  const host = openHost(ctx, user, scope, table, id);
  const existing = entryOn(ctx, host, user, commentId);
  if (existing.kind !== 'comment') throw forbidden('A request, an answer or an assignment note is kept as it was said. A request can be withdrawn while it is open.', 'kept_as_said');
  // A moderator removes others' words by their own place in the unit, never by Vantage access, which only reads.
  const moderator = Boolean(host.unitId) && can(ownScope(scope), PERMISSIONS.MANAGE_RECORDS, host.unitId!);
  if (existing.author_id !== user.id && !moderator) throw forbidden('That comment is not yours to remove.');
  ctx.db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(now(), commentId);
  audit(ctx, {
    actor_id: user.id, action: existing.author_id === user.id ? 'comment_deleted' : 'comment_removed_by_moderator',
    entity: host.table, entity_id: host.id, subject_id: host.ownerId, unit_id: host.unitId, detail: `comment ${commentId}`, ip,
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------------
// Requests: a question or a review request to one named person, and its answer.

const requestNoticeKey = (requestId: string) => `request:${requestId}`;

function requestLimit(userId: string) {
  const limited = limiters.workflowRequests.limited(userId);
  if (limited) throw tooMany(`You can send ${REQUESTS_PER_HOUR} questions and review requests an hour. Try again later.`, limited.retryAfter);
  limiters.workflowRequests.bump(userId);
}

/** Why this person may not be asked this on this record, or null when they may. */
function addresseeProblem(ctx: AppContext, host: Host, kind: RequestKind, addresseeId: string, authorId: string): string | null {
  if (addresseeId === authorId) return 'Ask somebody else.';
  const s = ownScope(scopeFor(ctx, { id: addresseeId }));
  if (!speaks(ctx, host, addresseeId, s)) return 'That person cannot be asked about this record.';
  if (privateNow(host) && !seesPrivate(host, addresseeId)) return 'While a counseling is in draft or review, only its counselor and its Marine speak on it.';
  if (host.table === 'duties' && kind === 'review_request' && !reviewsDuty(host, addresseeId, s)) return 'Ask someone who reviews duty in its unit.';
  return null;
}

export function addRequest(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string, raw: unknown, ip?: string) {
  const host = openHost(ctx, user, scope, table, id);
  assertSpeaks(ctx, host, user, scope);
  const input = parse(requestSchema, raw);
  // A counseling is reviewed by sharing it with its Marine (ADR-0027): there is no second way to ask.
  if (host.table === 'counselings' && input.kind === 'review_request') throw badRequest('A counseling is reviewed by sharing it with its Marine. Ask a question instead.', { fieldErrors: { kind: 'Ask a question instead.' } });
  const problem = addresseeProblem(ctx, host, input.kind, input.addressee_id, user.id);
  if (problem) throw badRequest(problem, { fieldErrors: { addressee_id: problem } });
  const open = ctx.db.prepare(`SELECT 1 FROM comments WHERE record_table = ? AND record_id = ? AND author_id = ? AND addressee_id = ? AND kind = ? AND state = 'open' AND deleted_at IS NULL`)
    .get(host.table, host.id, user.id, input.addressee_id, input.kind);
  if (open) throw conflict(`You already have an open ${input.kind === 'review_request' ? 'review request' : 'question'} to them on this record. Withdraw it or wait for their answer.`, 'request_open');
  requestLimit(user.id);
  const requestId = newId();
  const isPrivate = privateNow(host);
  ctx.db.transaction(() => {
    ctx.db.prepare(`INSERT INTO comments (id, record_table, record_id, author_id, unit_id, body, mentions, created_at, kind, addressee_id, state, private)
                    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, 'open', ?)`)
      .run(requestId, host.table, host.id, user.id, host.unitId, input.body, now(), input.kind, input.addressee_id, isPrivate ? 1 : 0);
    notify(ctx, input.addressee_id, {
      kind: input.kind,
      title: input.kind === 'review_request' ? `${whoActs(user)} asked you to review` : `${whoActs(user)} asked you a question`,
      actionUrl: recordLink(host.table, host.id), entity: host.table, entityId: host.id, actorId: user.id, orgId: host.orgId,
      dedupeKey: requestNoticeKey(requestId),
    });
    audit(ctx, { actor_id: user.id, action: 'request_sent', entity: host.table, entity_id: host.id, subject_id: host.ownerId, unit_id: host.unitId, detail: `comment ${requestId}: ${input.kind} to ${input.addressee_id}`, ip });
  })();
  return getComment(ctx, requestId)!;
}

function requestOn(ctx: AppContext, host: Host, user: SessionUser, requestId: string): CommentRow {
  const row = entryOn(ctx, host, user, requestId);
  if (!isRequestKind(row.kind)) throw notFound('No such request.');
  if (row.state !== 'open') throw conflict('This request is no longer open.', 'request_closed');
  return row;
}

export function answerRequest(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string, requestId: string, raw: unknown, ip?: string) {
  const host = openHost(ctx, user, scope, table, id);
  const request = requestOn(ctx, host, user, requestId);
  if (request.addressee_id !== user.id) throw forbidden('Only the person asked answers a request.');
  assertSpeaks(ctx, host, user, scope);
  const input = parse(answerSchema, raw ?? {});
  const body = input.body?.trim() || null;
  let state: RequestState;
  if (request.kind === 'clarification_request') {
    if (!body) throw badRequest('Write your answer first.', { fieldErrors: { body: 'Required.' } });
    state = 'answered';
  } else {
    if (!input.outcome) throw badRequest('Say whether it looks right or needs changes.', { fieldErrors: { outcome: 'Required.' } });
    if (input.outcome === 'needs_changes' && !body) throw badRequest('Say what needs changing.', { fieldErrors: { body: 'Required when it needs changes.' } });
    state = input.outcome;
  }
  const at = now();
  let answerId: string | null = null;
  ctx.db.transaction(() => {
    const changed = ctx.db.prepare(`UPDATE comments SET state = ?, closed_by = ?, closed_at = ? WHERE id = ? AND state = 'open'`).run(state, user.id, at, requestId).changes;
    if (!changed) throw conflict('This request is no longer open.', 'request_closed');
    if (body) {
      answerId = newId();
      ctx.db.prepare(`INSERT INTO comments (id, record_table, record_id, author_id, unit_id, body, mentions, created_at, kind, reply_to, private)
                      VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'answer', ?, ?)`)
        .run(answerId, host.table, host.id, user.id, host.unitId, body, at, requestId, request.private);
    }
    retractNotice(ctx, user.id, requestNoticeKey(requestId));
    const said = state === 'answered' ? 'answered your question' : state === 'looks_right' ? 'reviewed it: looks right' : 'reviewed it: needs changes';
    notify(ctx, request.author_id, {
      kind: 'request_answered', title: `${whoActs(user)} ${said}`, actionUrl: recordLink(host.table, host.id),
      entity: host.table, entityId: host.id, actorId: user.id, orgId: host.orgId, dedupeKey: `request-answered:${requestId}`,
    });
    audit(ctx, { actor_id: user.id, action: 'request_closed', entity: host.table, entity_id: host.id, subject_id: host.ownerId, unit_id: host.unitId, detail: `comment ${requestId}: ${state}${answerId ? `, answer ${answerId}` : ''}`, ip });
  })();
  return { request: getComment(ctx, requestId)!, answer: answerId ? getComment(ctx, answerId) : null };
}

export function withdrawRequest(ctx: AppContext, user: SessionUser, scope: Scope, table: string, id: string, requestId: string, ip?: string) {
  const host = openHost(ctx, user, scope, table, id);
  const request = requestOn(ctx, host, user, requestId);
  if (request.author_id !== user.id) throw forbidden('Only the person who asked withdraws a request.');
  ctx.db.transaction(() => {
    const changed = ctx.db.prepare(`UPDATE comments SET state = 'withdrawn', closed_by = ?, closed_at = ? WHERE id = ? AND state = 'open'`).run(user.id, now(), requestId).changes;
    if (!changed) throw conflict('This request is no longer open.', 'request_closed');
    retractNotice(ctx, request.addressee_id!, requestNoticeKey(requestId));
    audit(ctx, { actor_id: user.id, action: 'request_closed', entity: host.table, entity_id: host.id, subject_id: host.ownerId, unit_id: host.unitId, detail: `comment ${requestId}: withdrawn`, ip });
  })();
  return getComment(ctx, requestId)!;
}

/**
 * The workflow a request belongs to ended: a duty was decided, a case resolved, a record deleted. Its open requests close,
 * of one kind or all, and a notice of one not yet read is taken back. Returns how many closed.
 */
export function closeRequests(ctx: AppContext, table: NoticeEntity, id: string, actorId: string | null, kind?: RequestKind): number {
  const open = ctx.db.prepare(`SELECT id, addressee_id, unit_id FROM comments WHERE record_table = ? AND record_id = ? AND state = 'open' AND deleted_at IS NULL${kind ? ' AND kind = ?' : ''}`)
    .all(table, id, ...(kind ? [kind] : [])) as Array<{ id: string; addressee_id: string; unit_id: string | null }>;
  if (!open.length) return 0;
  const at = now();
  for (const r of open) {
    ctx.db.prepare(`UPDATE comments SET state = 'closed', closed_by = ?, closed_at = ? WHERE id = ? AND state = 'open'`).run(actorId, at, r.id);
    retractNotice(ctx, r.addressee_id, requestNoticeKey(r.id));
  }
  audit(ctx, { actor_id: actorId, action: 'request_closed', entity: table, entity_id: id, unit_id: open[0].unit_id, detail: `${open.length} closed by its workflow: ${open.map((r) => `comment ${r.id}`).join(', ')}`.slice(0, 1000) });
  return open.length;
}

/** Who asked for a review still open on a record or case: a return for correction tells them too (ADR-0031). */
export function openReviewRequesters(ctx: AppContext, table: NoticeEntity, id: string): string[] {
  return (ctx.db.prepare(`SELECT DISTINCT author_id FROM comments WHERE record_table = ? AND record_id = ? AND kind = 'review_request' AND state = 'open' AND deleted_at IS NULL`)
    .all(table, id) as Array<{ author_id: string }>).map((r) => r.author_id);
}

// ---------------------------------------------------------------------------------------------------------------------
// The note an assignment carries (ADR-0031).

/**
 * Writes the note an assignment carries, in the transaction of the assignment, kept on the record for its assignee. The
 * assignment's own notice tells them; the note is on the record, behind its permissions.
 */
export function addAssignmentNote(ctx: AppContext, actorId: string, table: 'tasks' | 'goals', recordId: string, unitId: string | null, assigneeId: string, note: string) {
  const body = note.trim();
  if (!body) return null;
  const id = newId();
  ctx.db.prepare(`INSERT INTO comments (id, record_table, record_id, author_id, unit_id, body, mentions, created_at, kind, addressee_id)
                  VALUES (?, ?, ?, ?, ?, ?, '[]', ?, 'assignment_note', ?)`).run(id, table, recordId, actorId, unitId, body, now(), assigneeId);
  return id;
}

// ---------------------------------------------------------------------------------------------------------------------
// A person's requests: asked of them, and asked by them (GET /api/me/requests).

type RequestListRow = CommentRow & {
  author_first_name: string; author_last_name: string; author_username: string; author_rank: string | null;
  addressee_first_name: string; addressee_last_name: string; addressee_username: string; addressee_rank: string | null;
};

const REQUEST_LIST = `SELECT c.*, u.first_name AS author_first_name, u.last_name AS author_last_name, u.username AS author_username, r.abbr AS author_rank,
       a.first_name AS addressee_first_name, a.last_name AS addressee_last_name, a.username AS addressee_username, ar.abbr AS addressee_rank
  FROM comments c JOIN users u ON u.id = c.author_id LEFT JOIN ranks r ON r.id = u.rank_id
  JOIN users a ON a.id = c.addressee_id LEFT JOIN ranks ar ON ar.id = a.rank_id`;

/** How long a request someone sent stays in their "You asked" list once it is answered or closed. */
const RECENTLY_CLOSED_DAYS = 14;

/** How many requests each list shows. */
const REQUESTS_LISTED = 100;
/** Requests read at a time while a list looks for ones its reader may still see. */
const REQUESTS_PAGE = 200;
/** The most requests one list reads. A list stops sooner, as soon as it has as many as it shows. */
const REQUESTS_SCANNED = 5000;

const ASKED_OF = `${REQUEST_LIST} WHERE c.addressee_id = ? AND c.kind IN ('review_request', 'clarification_request') AND c.state = 'open' AND c.deleted_at IS NULL
                    ORDER BY c.created_at DESC, c.id DESC`;
const ASKED_BY = `${REQUEST_LIST} WHERE c.author_id = ? AND c.kind IN ('review_request', 'clarification_request') AND c.deleted_at IS NULL
                    AND (c.state = 'open' OR c.closed_at > ?) ORDER BY c.state = 'open' DESC, c.created_at DESC, c.id DESC`;

/**
 * Reads a person's requests a page at a time, each checked as it is read: one on a record they no longer read, or a
 * private one they may not see, is passed over. `visit` is given each that stands, and returns false to stop. The answer
 * says whether reading stopped at the most it reads with rows still to read.
 */
function eachRequest(ctx: AppContext, user: { id: string }, scope: Scope, sql: string, params: unknown[],
  answerer: (host: Host, r: RequestListRow) => boolean, visit: (r: RequestSummary) => boolean): { stopped: boolean } {
  const hosts = new Map<string, Host | null>();
  const hostOf = (table: string, id: string) => {
    const key = `${table}:${id}`;
    if (!hosts.has(key)) {
      const host = loadHost(ctx, table, id);
      hosts.set(key, host && reads(host, user.id, scope) ? host : null);
    }
    return hosts.get(key)!;
  };
  const statement = ctx.db.prepare(`${sql} LIMIT ? OFFSET ?`);
  for (let read = 0; read < REQUESTS_SCANNED; read += REQUESTS_PAGE) {
    const page = statement.all(...params, REQUESTS_PAGE, read) as RequestListRow[];
    for (const r of page) {
      const host = hostOf(r.record_table, r.record_id);
      if (!host || (r.private && !seesPrivate(host, user.id))) continue;
      const row = (host.record ?? host.item) as unknown as Record<string, unknown>;
      const keepGoing = visit({
        id: r.id, kind: r.kind as RequestKind, state: r.state as RequestState, body: r.body, record_table: r.record_table, record_id: r.record_id,
        label: entityLabel(ctx, host.table, row), url: recordLink(host.table, host.id),
        author_name: nameOf({ first_name: r.author_first_name, last_name: r.author_last_name, username: r.author_username, rank: r.author_rank }),
        addressee_name: nameOf({ first_name: r.addressee_first_name, last_name: r.addressee_last_name, username: r.addressee_username, rank: r.addressee_rank }),
        can_answer: r.state === 'open' && answerer(host, r), created_at: r.created_at, closed_at: r.closed_at,
      });
      if (!keepGoing) return { stopped: false };
    }
    if (page.length < REQUESTS_PAGE) return { stopped: false };
  }
  // Read to the limit: it stopped short only if a request is left past it.
  return { stopped: statement.all(...params, 1, REQUESTS_SCANNED).length > 0 };
}

export function myRequests(ctx: AppContext, user: { id: string }, scope: Scope): { asked_of_you: RequestSummary[]; you_asked: RequestSummary[] } {
  const scopeOf = scopes(ctx);
  const since = new Date(Date.now() - RECENTLY_CLOSED_DAYS * 86_400_000).toISOString();
  // Checked as they are read, then cut to the list's length, so a list is short only when there is no more to show.
  const list = (sql: string, params: unknown[], answerer: (host: Host, r: RequestListRow) => boolean) => {
    const rows: RequestSummary[] = [];
    eachRequest(ctx, user, scope, sql, params, answerer, (r) => rows.push(r) < REQUESTS_LISTED);
    return rows;
  };
  return {
    asked_of_you: list(ASKED_OF, [user.id], (host) => speaks(ctx, host, user.id, scope)),
    you_asked: list(ASKED_BY, [user.id, since], (host, r) => speaks(ctx, host, r.addressee_id!, scopeOf(r.addressee_id!))),
  };
}

/**
 * Questions and review requests a person can answer now, for the weekly digest: each one counted, not only those the
 * app lists. `more`: reading stopped at the most it reads, so there may be more.
 */
export function waitingOnYou(ctx: AppContext, user: { id: string }, scope: Scope): { count: number; more: boolean } {
  let count = 0;
  const { stopped } = eachRequest(ctx, user, scope, ASKED_OF, [user.id], (host) => speaks(ctx, host, user.id, scope), (r) => { if (r.can_answer) count++; return true; });
  return { count, more: stopped };
}
