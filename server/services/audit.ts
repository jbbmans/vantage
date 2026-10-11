import type { AppContext } from '../context.ts';
import { hmac } from '../lib/crypto.ts';
import { newId, now } from '../lib/ids.ts';
import { metaGet, metaSet } from '../db/index.ts';
import { forwardAudit } from './auditSink.ts';
import { auditCategoryOf, type AuditCategory } from '../../shared/auditCatalog.ts';

export interface AuditEntry {
  actor_id?: string | null; action: string; entity?: string | null; entity_id?: string | null; subject_id?: string | null;
  unit_id?: string | null; detail?: string | null; ip?: string | null;
  /** The organization the entry belongs to (ADR-0006). Taken from unit_id when not given; none for the platform's own actions. */
  org_id?: string | null;
  /**
   * User activity, unit administration or enterprise administration (ADR-0013). Taken from the action's place in
   * shared/auditCatalog.ts when not given; a platform route that shares an action with a unit's passes 'enterprise'.
   */
  category?: AuditCategory;
}

function entryHash(secret: string, row: Record<string, unknown>, previous: string): string {
  const canonical = JSON.stringify([
    previous || '', row.id, row.actor_id ?? null, row.action, row.entity ?? null, row.entity_id ?? null,
    row.subject_id ?? null, row.unit_id ?? null, row.detail ?? null, row.at, row.ip ?? null,
    // Sealed in only when set, so every entry written before organizations, or before categories, still verifies as it
    // was written. A categorised entry seals its organization (or none) and its category, in that order.
    ...(row.category ? [row.org_id ?? null, row.category] : row.org_id ? [row.org_id] : []),
  ]);
  return hmac(secret, canonical);
}

/** Actions already warned about, so a production log says it once per action and not on every entry. */
const uncatalogued = new Set<string>();

/**
 * The category an entry seals. An action the catalogue does not know stops the test suite, so it is caught before it
 * ships; in service the entry is still written, without a category, and the log says so once.
 */
function categoryFor(ctx: AppContext, entry: AuditEntry): AuditCategory | null {
  const category = entry.category ?? auditCategoryOf(entry.action);
  if (category) return category;
  if (ctx.config.test) throw new Error(`The audit action "${entry.action}" is not in shared/auditCatalog.ts. Add it there with its category.`);
  if (!uncatalogued.has(entry.action)) {
    uncatalogued.add(entry.action);
    console.warn(`Audit action "${entry.action}" has no category in shared/auditCatalog.ts; it is recorded without one.`);
  }
  return null;
}

export function audit(ctx: AppContext, entry: AuditEntry) {
  const { db, config, chainKey } = ctx;
  const category = categoryFor(ctx, entry);
  const row = {
    id: newId(), actor_id: entry.actor_id ?? null, action: entry.action, entity: entry.entity ?? null, entity_id: entry.entity_id ?? null,
    subject_id: entry.subject_id ?? null, unit_id: entry.unit_id ?? null, detail: entry.detail ? String(entry.detail).slice(0, 1000) : null,
    ip: entry.ip ?? null, at: now(),
    org_id: entry.org_id ?? (entry.unit_id ? ((db.prepare('SELECT org_id FROM units WHERE id = ?').get(entry.unit_id) as { org_id: string | null } | undefined)?.org_id ?? null) : null),
    category,
  };
  let prevHash: string | null = null;
  let hash = '';
  db.transaction(() => {
    const head = JSON.parse(metaGet(db, 'audit_head') || '{"hash":"","count":0}') as { hash: string; count: number };
    hash = entryHash(chainKey, row, head.hash);
    prevHash = head.hash || null;
    db.prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, subject_id, unit_id, detail, ip, at, prev_hash, entry_hash, org_id, category)
       VALUES (@id, @actor_id, @action, @entity, @entity_id, @subject_id, @unit_id, @detail, @ip, @at, @prev_hash, @entry_hash, @org_id, @category)`
    ).run({ ...row, prev_hash: head.hash || null, entry_hash: hash });
    const count = head.count + 1;
    metaSet(db, 'audit_head', JSON.stringify({ hash, count, mac: hmac(chainKey, `audit-head:${hash}:${count}`) }));
  })();
  if (!config.audit.stdout && !config.audit.syslog) return;
  // An audit record is often written inside a larger transaction. Transactions here are synchronous, so by the time
  // a microtask runs the outermost one has committed or rolled back; only a record that is really in the chain is sent.
  const forwarded = { ...row, prev_hash: prevHash, entry_hash: hash };
  queueMicrotask(() => {
    try { if (db.prepare('SELECT 1 FROM audit_log WHERE id = ?').get(row.id)) forwardAudit(ctx, forwarded); } catch { /* database closed */ }
  });
}

export function verifyAuditChain(ctx: AppContext): { ok: boolean; count: number; reason?: string } {
  const { db, chainKey } = ctx;
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as Array<Record<string, unknown>>;
  let previous = '';
  for (const row of rows) {
    const expected = entryHash(chainKey, row, previous);
    if ((row.prev_hash ?? null) !== (previous || null) || row.entry_hash !== expected) {
      return { ok: false, count: rows.length, reason: `audit entry ${row.id} does not match the chain` };
    }
    previous = String(row.entry_hash);
  }
  const head = JSON.parse(metaGet(db, 'audit_head') || '{"hash":"","count":0,"mac":""}') as { hash: string; count: number; mac?: string };
  if (head.hash !== previous || head.count !== rows.length) return { ok: false, count: rows.length, reason: 'audit head does not match the chain' };
  if (rows.length && head.mac !== hmac(chainKey, `audit-head:${head.hash}:${head.count}`)) return { ok: false, count: rows.length, reason: 'audit head signature is invalid' };
  return { ok: true, count: rows.length };
}

// ——— Anchors: the chain's head, kept outside the server (ADR-0013) ———

/** The newest entry of the chain and how many entries it holds. Null for an empty log. */
export interface AuditHead { seq: number; hash: string; count: number }
export interface AuditAnchor extends AuditHead { at: string; actor_id: string | null; anchored_seq: number }

export function auditHead(ctx: AppContext): AuditHead | null {
  const last = ctx.db.prepare('SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; entry_hash: string } | undefined;
  if (!last) return null;
  const head = JSON.parse(metaGet(ctx.db, 'audit_head') || '{"count":0}') as { count: number };
  return { seq: last.seq, hash: last.entry_hash, count: head.count };
}

const ANCHOR_DETAIL = /^head seq (\d+), hash ([0-9a-f]{64}), (\d+) entries/;

/** The last anchor written: the head it named, and when. */
export function lastAuditAnchor(ctx: AppContext): AuditAnchor | null {
  const row = ctx.db.prepare("SELECT seq, at, actor_id, detail FROM audit_log WHERE action = 'audit_chain_anchored' ORDER BY seq DESC LIMIT 1").get() as { seq: number; at: string; actor_id: string | null; detail: string | null } | undefined;
  const m = row?.detail ? ANCHOR_DETAIL.exec(row.detail) : null;
  if (!row || !m) return null;
  return { seq: Number(m[1]), hash: m[2], count: Number(m[3]), at: row.at, actor_id: row.actor_id, anchored_seq: row.seq };
}

/**
 * Writes the chain's head into the chain itself. Each entry is copied off the host as it is written (standard output
 * or syslog, server/services/auditSink.ts), so the anchor lands outside the server too: a copy whoever holds the
 * server cannot rewrite. Checking it later (verifyAuditAnchor) shows whether the chain still holds that entry.
 */
export function anchorAuditChain(ctx: AppContext, actorId: string | null, ip?: string | null): AuditHead | null {
  const head = auditHead(ctx);
  if (!head) return null;
  audit(ctx, { actor_id: actorId, action: 'audit_chain_anchored', entity: 'audit_log', entity_id: String(head.seq), detail: `head seq ${head.seq}, hash ${head.hash}, ${head.count} entries`, ip });
  return head;
}

/** The scheduled anchor: only when something was written since the last one, so a quiet day adds nothing. */
export function anchorAuditChainIfChanged(ctx: AppContext): AuditHead | null {
  const last = lastAuditAnchor(ctx);
  const head = auditHead(ctx);
  if (!head || (last && head.seq <= last.anchored_seq)) return null;
  return anchorAuditChain(ctx, null);
}

export type AnchorFinding = 'match' | 'missing' | 'different';

/**
 * Checks a kept anchor against the chain: whether the entry at that position still carries that hash, and whether the
 * whole chain still verifies. Every check is audited with its result. A missing or different entry, or a broken chain,
 * means the trail was rewritten or replaced since the anchor was taken; the caller tells the Lead Vantage Administrators.
 */
export function verifyAuditAnchor(ctx: AppContext, actorId: string, anchor: { seq: number; entry_hash: string }, ip?: string | null) {
  const hash = anchor.entry_hash.toLowerCase();
  const row = ctx.db.prepare('SELECT entry_hash FROM audit_log WHERE seq = ?').get(anchor.seq) as { entry_hash: string } | undefined;
  const entry: AnchorFinding = !row ? 'missing' : row.entry_hash === hash ? 'match' : 'different';
  const chain = verifyAuditChain(ctx);
  const ok = entry === 'match' && chain.ok;
  audit(ctx, {
    actor_id: actorId, action: 'audit_anchor_verified', entity: 'audit_log', entity_id: String(anchor.seq), ip,
    detail: `seq ${anchor.seq}, hash ${hash}: ${entry === 'match' ? 'the entry matches' : entry === 'missing' ? 'no entry at that position' : 'the entry there has a different hash'}; chain ${chain.ok ? `intact across ${chain.count} entries` : `broken: ${chain.reason}`}`,
  });
  return { ok, entry, chain };
}

/**
 * Seals the chain again after a demo workspace is removed with its entries. Only a synthetic demo database is ever
 * resealed, and only inside the transaction that removed them with the log's append-only triggers lifted
 * (purgeWorkspace in server/services/demo.ts); anywhere else the triggers refuse the rewrite.
 */
export function resealAuditChain(ctx: AppContext) {
  const { db, config, chainKey } = ctx;
  if (config.accessMode !== 'demo' || metaGet(db, 'demo_database') !== '1') throw new Error('The audit chain is only resealed on a synthetic demo database.');
  const update = db.prepare('UPDATE audit_log SET prev_hash = ?, entry_hash = ? WHERE seq = ?');
  db.transaction(() => {
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as Array<Record<string, unknown>>;
    let previous = '';
    for (const row of rows) {
      const hash = entryHash(chainKey, row, previous);
      update.run(previous || null, hash, row.seq);
      previous = hash;
    }
    metaSet(db, 'audit_head', JSON.stringify({ hash: previous, count: rows.length, mac: hmac(chainKey, `audit-head:${previous}:${rows.length}`) }));
  })();
}

/** An organization's audit trail: entries attributed to it, and older entries whose unit is one of its units. */
export function orgAuditClause(alias = 'al'): string {
  return `(${alias}.org_id = ? OR (${alias}.org_id IS NULL AND ${alias}.unit_id IN (SELECT id FROM units WHERE org_id = ?)))`;
}
