import { createHash } from 'node:crypto';
import type { AppContext } from '../context.ts';
import { hmac, safeEqual } from '../lib/crypto.ts';
import { now } from '../lib/ids.ts';
import { audit } from './audit.ts';

/**
 * Tamper evidence for case histories.
 *
 * work_events is append-only by database trigger, which stops the application — and anyone using
 * it — from rewriting history. It does not stop someone with write access to the database file from
 * dropping the trigger. So every event is also sealed into its work item's own chain: an HMAC over
 * the complete event (body included) and the previous seal, keyed by the server secret, plus a
 * signed head recording how many events the chain covers.
 *
 * A changed body, a deleted entry, an inserted entry, or a truncated tail all break the chain, and
 * none can be re-sealed without the secret. Once a day the digest of every head is written into the
 * separately chained audit log, anchoring the case histories there too.
 */

interface SealableEvent {
  id: string; work_item_id: string; unit_id: string | null; actor_id: string | null; kind: string; step: string | null;
  subject_id: string | null; body: string; supersedes_id: string | null; correlation_id: string | null;
  idempotency_key: string | null; occurred_at: string; created_at: string;
}

const canonical = (e: SealableEvent, prev: string | null) => JSON.stringify([
  prev || '', e.id, e.work_item_id, e.unit_id ?? null, e.actor_id ?? null, e.kind, e.step ?? null, e.subject_id ?? null,
  e.body, e.supersedes_id ?? null, e.correlation_id ?? null, e.idempotency_key ?? null, e.occurred_at, e.created_at,
]);

const headMac = (secret: string, itemId: string, hash: string, count: number) => hmac(secret, `case-head:${itemId}:${hash}:${count}`);

/** Seals one newly written event onto the end of its case's chain. Runs inside the writer's transaction. */
export function sealEvent(ctx: AppContext, e: SealableEvent) {
  const { db, config } = ctx;
  const head = db.prepare('SELECT hash, count FROM work_event_heads WHERE work_item_id = ?').get(e.work_item_id) as { hash: string; count: number } | undefined;
  const prev = head?.hash || null;
  const count = (head?.count || 0) + 1;
  const hash = hmac(config.secret, canonical(e, prev));
  const at = now();
  db.prepare('INSERT INTO work_event_seals (event_id, work_item_id, seq, prev_hash, entry_hash, sealed_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(e.id, e.work_item_id, count, prev, hash, at);
  db.prepare(
    `INSERT INTO work_event_heads (work_item_id, hash, count, mac, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(work_item_id) DO UPDATE SET hash = excluded.hash, count = excluded.count, mac = excluded.mac, updated_at = excluded.updated_at`
  ).run(e.work_item_id, hash, count, headMac(config.secret, e.work_item_id, hash, count), at);
}

/**
 * Seals the history of every case that has events but no chain yet: histories written before
 * sealing existed, and the synthetic demo's seeded cases. A case that already has a chain is never
 * resealed; an unsealed event inside a sealed case is reported, not absorbed.
 */
export function sealBacklog(ctx: AppContext, itemIds?: string[]): number {
  const { db } = ctx;
  const items = itemIds?.length
    ? itemIds
    : (db.prepare('SELECT DISTINCT e.work_item_id AS id FROM work_events e LEFT JOIN work_event_heads h ON h.work_item_id = e.work_item_id WHERE h.work_item_id IS NULL').all() as Array<{ id: string }>).map((r) => r.id);
  let sealed = 0;
  const events = db.prepare('SELECT * FROM work_events WHERE work_item_id = ? ORDER BY created_at, rowid');
  const hasHead = db.prepare('SELECT 1 FROM work_event_heads WHERE work_item_id = ?');
  db.transaction(() => {
    for (const id of items) {
      if (hasHead.get(id)) continue;
      for (const e of events.all(id) as SealableEvent[]) { sealEvent(ctx, e); sealed += 1; }
    }
  })();
  return sealed;
}

export interface CaseIntegrity {
  status: 'verified' | 'broken' | 'unsealed';
  count: number;
  reason?: string;
}

/** Recomputes one case's chain from its events and checks it against the signed head. */
export function caseIntegrity(ctx: AppContext, itemId: string, rows?: SealableEvent[]): CaseIntegrity {
  const { db, config } = ctx;
  const events = rows || (db.prepare('SELECT * FROM work_events WHERE work_item_id = ? ORDER BY created_at, rowid').all(itemId) as SealableEvent[]);
  const seals = db.prepare('SELECT * FROM work_event_seals WHERE work_item_id = ? ORDER BY seq').all(itemId) as Array<{ event_id: string; seq: number; prev_hash: string | null; entry_hash: string }>;
  const head = db.prepare('SELECT * FROM work_event_heads WHERE work_item_id = ?').get(itemId) as { hash: string; count: number; mac: string } | undefined;
  if (!events.length && !seals.length) return { status: 'verified', count: 0 };
  if (!head && !seals.length) return { status: 'unsealed', count: events.length, reason: 'This history was written before sealing and has not been sealed yet.' };
  if (!head) return { status: 'broken', count: events.length, reason: 'The chain head is missing.' };
  if (!safeEqual(head.mac, headMac(config.secret, itemId, head.hash, head.count))) return { status: 'broken', count: events.length, reason: 'The chain head’s signature does not match.' };
  if (seals.length !== head.count) return { status: 'broken', count: events.length, reason: `The head covers ${head.count} entries but ${seals.length} seals exist.` };
  if (events.length !== seals.length) return { status: 'broken', count: events.length, reason: `${events.length} entries exist but ${seals.length} are sealed: an entry was added or removed outside Vantage.` };
  const byId = new Map(events.map((e) => [e.id, e]));
  let prev: string | null = null;
  for (const seal of seals) {
    const e = byId.get(seal.event_id);
    if (!e) return { status: 'broken', count: events.length, reason: `Sealed entry ${seal.seq} is missing.` };
    if ((seal.prev_hash || null) !== (prev || null)) return { status: 'broken', count: events.length, reason: `Entry ${seal.seq} does not follow the one before it.` };
    if (!safeEqual(seal.entry_hash, hmac(config.secret, canonical(e, prev)))) return { status: 'broken', count: events.length, reason: `Entry ${seal.seq} was changed after it was recorded.` };
    prev = seal.entry_hash;
  }
  if (prev !== head.hash) return { status: 'broken', count: events.length, reason: 'The last seal does not match the head.' };
  return { status: 'verified', count: events.length };
}

/** Every case's chain, for the owner console. */
export function verifyAllCases(ctx: AppContext, limit = 5000): { ok: boolean; checked: number; broken: Array<{ work_item_id: string; reason?: string }>; unsealed: number } {
  const ids = (ctx.db.prepare('SELECT DISTINCT work_item_id AS id FROM work_events LIMIT ?').all(limit) as Array<{ id: string }>).map((r) => r.id);
  const broken: Array<{ work_item_id: string; reason?: string }> = [];
  let unsealed = 0;
  for (const id of ids) {
    const r = caseIntegrity(ctx, id);
    if (r.status === 'broken') broken.push({ work_item_id: id, reason: r.reason });
    if (r.status === 'unsealed') unsealed += 1;
  }
  return { ok: broken.length === 0, checked: ids.length, broken: broken.slice(0, 50), unsealed };
}

/** The digest of every case head, written into the audit chain. */
export function anchorCaseHeads(ctx: AppContext): { digest: string; cases: number } {
  const heads = ctx.db.prepare('SELECT work_item_id, hash, count FROM work_event_heads ORDER BY work_item_id').all() as Array<{ work_item_id: string; hash: string; count: number }>;
  const digest = createHash('sha256').update(heads.map((h) => `${h.work_item_id}:${h.hash}:${h.count}`).join('\n')).digest('hex');
  audit(ctx, { actor_id: null, action: 'case_history_anchor', entity: 'work_event_heads', detail: `${heads.length} case histories, digest ${digest}` });
  return { digest, cases: heads.length };
}
