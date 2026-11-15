import type { AppContext, SessionUser } from '../context.ts';
import { newId, now } from '../lib/ids.ts';
import { staffWith } from '../authz/platform.ts';
import { seatedOrgRole, type Scope } from '../authz/scope.ts';
import { canRead, type RecordRow } from '../authz/records.ts';
import { orgPermissionsOf, type OrgPermission, type PlatformPermission } from '../../shared/permissions.ts';
import {
  NOTICE_KINDS, NOTICE_RETENTION_DAYS, coalesces, groupOf, isMutableGroup, isNoticeKind, kindsIn,
  type NoticeGroup, type NoticeKind, type NoticeRow,
} from '../../shared/notifications.ts';
import { REDACTED } from '../../shared/constants.ts';
import { audit } from './audit.ts';
import { recordDispositionRun } from './holds.ts';

/** What a notice can be about: a record, or a work case. */
export const NOTICE_ENTITIES = ['activities', 'awards', 'trainings', 'counselings', 'tasks', 'projects', 'goals', 'duties', 'work_items'] as const;
export type NoticeEntity = (typeof NOTICE_ENTITIES)[number];
const isNoticeEntity = (e: string): e is NoticeEntity => (NOTICE_ENTITIES as readonly string[]).includes(e);

export interface NoticeInput {
  kind: NoticeKind;
  /** The event and who: never what anybody wrote. */
  title: string;
  /** Only for a notice about no record (a leader's message, a MARADMIN): one about a record names it when it is read. */
  message?: string | null;
  actionUrl?: string | null;
  /** Exactly once per key. A kind that coalesces takes none. */
  dedupeKey?: string | null;
  /** Who acted. Nobody is told about what they did themselves. */
  actorId?: string | null;
  /** The Unit Instance it is about; taken from its record when it names one. */
  orgId?: string | null;
  entity?: NoticeEntity | null;
  entityId?: string | null;
}

/** Where a record or a work case opens. */
export function recordLink(entity: string, id: string): string {
  const open = encodeURIComponent(id);
  switch (entity) {
    case 'activities': return `/records/${open}`;
    case 'awards': return `/career/awards?open=${open}`;
    case 'trainings': return `/career/training?open=${open}`;
    case 'counselings': return `/career/counseling?open=${open}`;
    case 'duties': return `/record/duty?open=${open}`;
    case 'work_items': return `/work/items/${open}`;
    default: return `/records/${entity}/${open}`;
  }
}

function orgOfEntity(ctx: AppContext, entity: NoticeEntity, id: string): string | null {
  const row = ctx.db.prepare(`SELECT u.org_id FROM ${entity} r JOIN units u ON u.id = r.unit_id WHERE r.id = ?`).get(id) as { org_id: string | null } | undefined;
  return row?.org_id ?? null;
}

/** The groups a person turned off, from their preferences. Only groups that may be turned off count. */
export function mutedGroups(prefs: string | null | undefined): Set<NoticeGroup> {
  try {
    const muted = (JSON.parse(prefs || '{}') as { notifications?: { muted?: unknown } }).notifications?.muted;
    return new Set(Array.isArray(muted) ? muted.filter((g): g is NoticeGroup => typeof g === 'string' && isMutableGroup(g)) : []);
  } catch { return new Set(); }
}

/**
 * Tells one person something (ADR-0031). Nobody is told about what they did themselves, nor anybody no longer active, nor
 * anybody who turned the notice's group off. A kind that coalesces adds to the notice its person has not read yet about
 * the same record ("3 new comments") instead of adding another; any other kind is sent once per dedupe key. Returns
 * whether a notice was written or added to.
 */
export function notify(ctx: AppContext, userId: string, input: NoticeInput): boolean {
  const { kind, title, message = null, actionUrl = null, dedupeKey = null, actorId = null, entity = null, entityId = null } = input;
  if (!isNoticeKind(kind)) throw new Error(`Unknown notice kind "${kind}": add it to shared/notifications.ts.`);
  if ((entity === null) !== (entityId === null)) throw new Error('A notice names a record by its table and its id together.');
  if (entity !== null && !isNoticeEntity(entity)) throw new Error(`A notice cannot be about "${entity}".`);
  const coalescing = coalesces(kind);
  if (coalescing && (dedupeKey || !entity)) throw new Error(`Notice kind "${kind}" coalesces per record: it names a record and takes no dedupe key.`);
  if (actorId && actorId === userId) return false;
  const person = ctx.db.prepare('SELECT active, prefs FROM users WHERE id = ?').get(userId) as { active: number; prefs: string | null } | undefined;
  if (!person || !person.active) return false;
  const group = NOTICE_KINDS[kind].group;
  if (isMutableGroup(group) && mutedGroups(person.prefs).has(group)) return false;
  const orgId = input.orgId ?? (entity && entityId ? orgOfEntity(ctx, entity, entityId) : null);
  const at = now();
  // A notice about a record keeps none of its words: the record's name is read when the notice is.
  const words = entity ? null : message;
  if (coalescing) {
    return ctx.db.prepare(
      `INSERT INTO notifications (id, user_id, kind, title, message, action_url, dedupe_key, created_at, org_id, entity, entity_id, actor_id, count)
       VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(user_id, kind, entity, entity_id) WHERE read_at IS NULL AND count IS NOT NULL
       DO UPDATE SET count = count + 1, title = excluded.title, actor_id = excluded.actor_id, created_at = excluded.created_at,
                     action_url = excluded.action_url, org_id = excluded.org_id`
    ).run(newId(), userId, kind, title, actionUrl, at, orgId, entity, entityId, actorId).changes > 0;
  }
  return ctx.db.prepare(
    `INSERT INTO notifications (id, user_id, kind, title, message, action_url, dedupe_key, created_at, org_id, entity, entity_id, actor_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
  ).run(newId(), userId, kind, title, words, actionUrl, dedupeKey, at, orgId, entity, entityId, actorId).changes > 0;
}

/** Vantage staff who hold a platform permission: the platform's own notices, never an organization's. */
export function notifyStaff(ctx: AppContext, permission: PlatformPermission, payload: NoticeInput, exceptId?: string) {
  for (const id of staffWith(ctx, permission)) if (id !== exceptId) notify(ctx, id, payload);
}

/**
 * A Unit Instance's people who hold a Unit Instance permission there, counting only those still members of it (ADR-0010).
 * Those named in `except` are not told: the person who acted, or one already told in a notice of their own.
 */
export function notifyOrg(ctx: AppContext, orgId: string, permission: OrgPermission, payload: NoticeInput, except?: string | readonly string[]) {
  const rows = ctx.db.prepare(`SELECT DISTINCT r.user_id, r.role FROM org_roles r JOIN users u ON u.id = r.user_id
                               WHERE r.org_id = ? AND u.active = 1 AND (r.expires_at IS NULL OR r.expires_at > ?) AND ${seatedOrgRole('r')}`).all(orgId, now()) as Array<{ user_id: string; role: string }>;
  const ids = new Set(rows.filter((r) => orgPermissionsOf([r.role]).includes(permission)).map((r) => r.user_id));
  const skip = new Set(typeof except === 'string' ? [except] : except ?? []);
  for (const id of ids) if (!skip.has(id)) notify(ctx, id, { orgId, ...payload });
}

/** Takes back a notice its person has not read yet: a request withdrawn or closed before they saw it. */
export function retractNotice(ctx: AppContext, userId: string, dedupeKey: string) {
  ctx.db.prepare('DELETE FROM notifications WHERE user_id = ? AND dedupe_key = ? AND read_at IS NULL').run(userId, dedupeKey);
}

/** A record destroyed or anonymized takes its notices with it. */
export function forgetNotices(ctx: AppContext, entity: NoticeEntity, ids: readonly string[]) {
  if (!ids.length) return 0;
  return ctx.db.prepare('DELETE FROM notifications WHERE entity = ? AND entity_id IN (SELECT value FROM json_each(?))').run(entity, JSON.stringify(ids)).changes;
}

/** A record moved to another type takes its notices along, and they open it where it is now. */
export function moveNotices(ctx: AppContext, from: NoticeEntity, fromId: string, to: NoticeEntity, toId: string) {
  // One unread coalesced notice per person, kind and record: one that would duplicate a notice already about the new
  // record goes, rather than the move failing.
  ctx.db.prepare('UPDATE OR IGNORE notifications SET entity = ?, entity_id = ?, action_url = ? WHERE entity = ? AND entity_id = ?')
    .run(to, toId, recordLink(to, toId), from, fromId);
  ctx.db.prepare('DELETE FROM notifications WHERE entity = ? AND entity_id = ?').run(from, fromId);
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading notices: each is checked again, and a record's name is read now (ADR-0031).

interface StoredNotice {
  id: string; kind: string; title: string; message: string | null; action_url: string | null; read_at: string | null; created_at: string;
  org_id: string | null; entity: string | null; entity_id: string | null; count: number | null;
}

const RETAINED = 'A record its retention schedule anonymized';

function humanize(value: unknown) {
  return String(value ?? '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** What a record or work case is called, for its notices. Its own words only once its reader is known to read it. */
export function entityLabel(ctx: AppContext, entity: NoticeEntity, row: Record<string, unknown>): string {
  const pick = (value: unknown) => {
    const s = String(value ?? '').trim();
    return !s ? null : s === REDACTED ? RETAINED : s.length > 120 ? `${s.slice(0, 119)}…` : s;
  };
  switch (entity) {
    case 'projects': return pick(row.name) ?? 'A project';
    case 'awards': return pick(row.name) ?? 'An award';
    case 'counselings': return `${humanize(row.type) || 'A'} counseling${row.date ? `, ${row.date}` : ''}`;
    case 'duties': {
      const type = row.duty_type_id ? (ctx.db.prepare('SELECT name FROM duty_types WHERE id = ?').get(row.duty_type_id) as { name: string } | undefined)?.name : null;
      return `${type || pick(row.title) || 'Duty'}${row.date ? `, ${row.date}` : ''}`;
    }
    case 'work_items': return pick(row.reference) ?? pick(row.title) ?? 'A work case';
    default: return pick(row.title) ?? 'A record';
  }
}

/**
 * May this person still open the record or work case a notice is about, and what is it called? Null when it is gone,
 * moved out of their reach, back in draft, or they lost the access that let them read it.
 */
export function readableEntity(ctx: AppContext, user: { id: string }, scope: Scope, entity: string, id: string): { label: string; url: string } | null {
  if (!isNoticeEntity(entity)) return null;
  const row = ctx.db.prepare(`SELECT * FROM ${entity} WHERE id = ? AND deleted_at IS NULL`).get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  if (entity === 'work_items') {
    // As work.ts readable(): a shared case is its unit's members', any other its owner's and its holder's.
    const shared = row.visibility === 'unit' && Boolean(row.unit_id);
    const opens = shared ? scope.unitIds.includes(String(row.unit_id)) : row.owner_id === user.id || row.claimed_by === user.id;
    if (!opens) return null;
  } else if (!canRead(scope, user.id, row as unknown as RecordRow)) {
    return null;
  }
  return { label: entityLabel(ctx, entity, row), url: recordLink(entity, id) };
}

type Seen = { label: string; url: string } | null | true;
type Check = (n: StoredNotice) => Seen;

function checker(ctx: AppContext, user: { id: string }, scope: Scope): Check {
  const seen = new Map<string, { label: string; url: string } | null>();
  return (n) => {
    if (!n.entity || !n.entity_id) return true;
    const key = `${n.entity}:${n.entity_id}`;
    if (!seen.has(key)) seen.set(key, readableEntity(ctx, user, scope, n.entity, n.entity_id));
    return seen.get(key)!;
  };
}

const orgNames = (ctx: AppContext) => {
  const cache = new Map<string, string | null>();
  return (orgId: string | null) => {
    if (!orgId) return null;
    if (!cache.has(orgId)) cache.set(orgId, (ctx.db.prepare('SELECT COALESCE(short_name, name) AS name FROM organizations WHERE id = ?').get(orgId) as { name: string } | undefined)?.name ?? null);
    return cache.get(orgId)!;
  };
};

const safeUrl = (url: string | null) => (url && url.startsWith('/') && !url.startsWith('//') ? url : null);

function present(n: StoredNotice, seen: { label: string; url: string } | true, orgName: (id: string | null) => string | null): NoticeRow {
  const spec = isNoticeKind(n.kind) ? NOTICE_KINDS[n.kind] : null;
  const many = spec && 'many' in spec ? spec.many : null;
  const about = seen === true ? null : seen;
  return {
    id: n.id,
    kind: n.kind,
    group: groupOf(n.kind),
    title: many && (n.count ?? 1) > 1 ? `${n.count} ${many}` : n.title,
    message: about ? null : n.message,
    label: about?.label ?? null,
    action_url: safeUrl(n.action_url) ?? about?.url ?? null,
    count: n.count,
    org_name: orgName(n.org_id),
    read_at: n.read_at,
    created_at: n.created_at,
  };
}

const encodeCursor = (n: StoredNotice) => Buffer.from(`${n.created_at}|${n.id}`).toString('base64url');
function decodeCursor(cursor: string | null | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
  return at && id ? { at, id } : null;
}

const SELECT = 'SELECT id, kind, title, message, action_url, read_at, created_at, org_id, entity, entity_id, count FROM notifications';
const BATCH = 200;
/** The most notices one page reads past ones its reader may no longer open before it stops; the next page carries on. */
const SCAN_LIMIT = 2000;
/** Unread notices counted for the badge, at most. */
export const UNREAD_COUNTED = 999;

export interface ListNoticesOptions { limit: number; cursor?: string | null; unread?: boolean; group?: NoticeGroup | null }

function filters(user: { id: string }, opts: { unread?: boolean; group?: NoticeGroup | null }) {
  const where = ['user_id = ?'];
  const params: unknown[] = [user.id];
  if (opts.unread) where.push('read_at IS NULL');
  if (opts.group) { const kinds = kindsIn(opts.group); where.push(`kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
  return { where, params };
}

/** A person's notices, newest first, each checked again; and how many unread ones they may still open. */
export function listNotices(ctx: AppContext, user: SessionUser, scope: Scope, opts: ListNoticesOptions) {
  const check = checker(ctx, user, scope);
  const orgName = orgNames(ctx);
  const { where, params } = filters(user, opts);
  let after = decodeCursor(opts.cursor);
  const rows: NoticeRow[] = [];
  let scanned = 0;
  let last: StoredNotice | null = null;
  let more = false;
  while (!more && scanned < SCAN_LIMIT) {
    const page = ctx.db.prepare(`${SELECT} WHERE ${where.join(' AND ')}${after ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...params, ...(after ? [after.at, after.at, after.id] : []), BATCH) as StoredNotice[];
    for (const n of page) {
      const seen = check(n);
      if (seen && rows.length === opts.limit) { more = true; break; }
      scanned++;
      last = n;
      if (seen) rows.push(present(n, seen, orgName));
      if (scanned >= SCAN_LIMIT) break;
    }
    if (page.length < BATCH) break;
    after = { at: page.at(-1)!.created_at, id: page.at(-1)!.id };
  }
  // A page that stopped reading at its limit says where to go on from, even when it found nothing more to show yet.
  const nextCursor = (more || scanned >= SCAN_LIMIT) && last ? encodeCursor(last) : null;
  return { rows, unread: unreadCount(ctx, user, scope, check), next_cursor: nextCursor };
}

/** Unread notices a person may still open: the badge agrees with the list. */
export function unreadCount(ctx: AppContext, user: { id: string }, scope: Scope, check: Check = checker(ctx, user, scope)): number {
  const plain = (ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL AND entity IS NULL').get(user.id) as { n: number }).n;
  if (plain >= UNREAD_COUNTED) return UNREAD_COUNTED;
  const about = ctx.db.prepare(`${SELECT} WHERE user_id = ? AND read_at IS NULL AND entity IS NOT NULL ORDER BY created_at DESC LIMIT ?`).all(user.id, UNREAD_COUNTED) as StoredNotice[];
  let n = plain;
  for (const row of about) if (check(row) && ++n >= UNREAD_COUNTED) break;
  return n;
}

/** Marks every unread notice read, or those of one group. */
export function markAllRead(ctx: AppContext, user: { id: string }, group?: NoticeGroup | null) {
  const { where, params } = filters(user, { unread: true, group });
  return ctx.db.prepare(`UPDATE notifications SET read_at = ? WHERE ${where.join(' AND ')}`).run(now(), ...params).changes;
}

/** A person's notices for their own export, checked as the list is: nothing about a record they may no longer open. */
export function exportableNotices(ctx: AppContext, user: { id: string }, scope: Scope) {
  const check = checker(ctx, user, scope);
  return (ctx.db.prepare(`${SELECT} WHERE user_id = ? ORDER BY created_at DESC`).all(user.id) as StoredNotice[])
    .flatMap((n) => {
      const seen = check(n);
      if (!seen) return [];
      const about = seen === true ? null : seen;
      return [{ id: n.id, kind: n.kind, title: n.title, message: about ? null : n.message, about: about?.label ?? null, action_url: n.action_url, read_at: n.read_at, created_at: n.created_at }];
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// Keeping notices: 180 days, unless a hold keeps them (ADR-0031).

/**
 * Removes notices older than the retention window, read or not, except those of a person under a legal hold and those
 * of a Unit Instance under an instance hold; a hold on every Unit Instance keeps them all. Recorded as a disposition run,
 * and audited when it removes anything.
 */
export function expireNotifications(ctx: AppContext, days = NOTICE_RETENTION_DAYS): { expired: number; held: number; blocked: boolean } {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const due = (ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE created_at < ?').get(cutoff) as { n: number }).n;
  if (!due) return { expired: 0, held: 0, blocked: false };
  const holds = ctx.db.prepare(`SELECT scope, subject_id, org_id FROM legal_holds WHERE released_at IS NULL AND scope IN ('instance', 'user')`).all() as Array<{ scope: string; subject_id: string | null; org_id: string | null }>;
  const detail = (text: string) => `notifications older than ${days} days: ${text}`;
  if (holds.some((h) => h.scope === 'instance' && h.org_id === null)) {
    recordDispositionRun(ctx, { actorId: null, recordType: 'notifications', disposition: 'destroy', eligible: due, acted: 0, held: due, detail: detail('kept under a hold on every Unit Instance') });
    return { expired: 0, held: due, blocked: true };
  }
  const users = [...new Set(holds.filter((h) => h.scope === 'user' && h.subject_id).map((h) => h.subject_id!))];
  const orgs = [...new Set(holds.filter((h) => h.scope === 'instance' && h.org_id).map((h) => h.org_id!))];
  const kept = 'user_id IN (SELECT value FROM json_each(?)) OR (org_id IS NOT NULL AND org_id IN (SELECT value FROM json_each(?)))';
  const expired = ctx.db.prepare(`DELETE FROM notifications WHERE created_at < ? AND NOT (${kept})`).run(cutoff, JSON.stringify(users), JSON.stringify(orgs)).changes;
  const held = due - expired;
  const said = detail(`${expired} removed${held ? `, ${held} kept under hold` : ''}`);
  recordDispositionRun(ctx, { actorId: null, recordType: 'notifications', disposition: 'destroy', eligible: due, acted: expired, held, detail: said });
  if (expired) audit(ctx, { actor_id: null, action: 'notifications_expired', entity: 'notifications', detail: said });
  return { expired, held, blocked: false };
}
