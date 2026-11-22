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
  /**
   * Whether the entry is about a private entry, filed under its Unit Instance but no unit (privateEntry). Read from the
   * record when not given; a caller whose record is gone by then (a move) says it from the row that survives.
   */
  privateEntry?: boolean;
}

/**
 * The things a Marine can keep private, each with the question that finds one that is: private, and nobody's but its
 * owner's. Records, cases, work intake and its imports, contacts and correspondence (a message by its thread), report
 * drafts (a revision by its draft) and saved reports. A counseling a leader writes keeps its unit, as the counselor
 * reads it there (ADR-0027).
 */
const PRIVATE_ENTRY: Readonly<Record<string, string>> = {
  activities: "SELECT 1 FROM activities WHERE id = ? AND visibility = 'private'",
  projects: "SELECT 1 FROM projects WHERE id = ? AND visibility = 'private'",
  tasks: "SELECT 1 FROM tasks WHERE id = ? AND visibility = 'private'",
  goals: "SELECT 1 FROM goals WHERE id = ? AND visibility = 'private'",
  trainings: "SELECT 1 FROM trainings WHERE id = ? AND visibility = 'private'",
  awards: "SELECT 1 FROM awards WHERE id = ? AND visibility = 'private'",
  counselings: "SELECT 1 FROM counselings WHERE id = ? AND visibility = 'private' AND (counselor_id IS NULL OR counselor_id = user_id)",
  work_items: "SELECT 1 FROM work_items WHERE id = ? AND visibility = 'private'",
  source_files: "SELECT 1 FROM source_files WHERE id = ? AND visibility = 'private'",
  import_jobs: "SELECT 1 FROM import_jobs WHERE id = ? AND visibility = 'private'",
  contacts: "SELECT 1 FROM contacts WHERE id = ? AND visibility = 'private'",
  threads: "SELECT 1 FROM threads WHERE id = ? AND visibility = 'private'",
  thread_messages: "SELECT 1 FROM thread_messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ? AND t.visibility = 'private'",
  report_drafts: "SELECT 1 FROM report_drafts WHERE id = ? AND visibility = 'private'",
  report_revisions: "SELECT 1 FROM report_revisions r JOIN report_drafts d ON d.id = r.report_id WHERE r.id = ? AND d.visibility = 'private'",
  report_definitions: "SELECT 1 FROM report_definitions WHERE id = ? AND visibility = 'private'",
};

/**
 * Whether a record is a private entry: one a unit's access log never lists (ADR-0040). What is done to it stays in the
 * trail under its Unit Instance, so the instance's own trail and the Marine's keep it; no unit's leaders learn it exists.
 */
export function privateEntry(ctx: AppContext, table: string | null | undefined, id: string | null | undefined): boolean {
  const sql = table && id && Object.hasOwn(PRIVATE_ENTRY, table) ? PRIVATE_ENTRY[table] : undefined;
  return Boolean(sql && ctx.db.prepare(sql).get(id));
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

/**
 * Whom an entry is about. A counseling draft is its counselor's alone (ADR-0027 §1): what anyone does to one while it is
 * a draft stays in the trail, but not under its Marine, so their access log and personal export never show it exists.
 */
function subjectOf(ctx: AppContext, entry: AuditEntry): string | null {
  const subject = entry.subject_id ?? null;
  if (!subject || entry.entity !== 'counselings' || !entry.entity_id) return subject;
  const c = ctx.db.prepare('SELECT stage FROM counselings WHERE id = ?').get(entry.entity_id) as { stage: string | null } | undefined;
  return c?.stage === 'draft' ? null : subject;
}

export function audit(ctx: AppContext, entry: AuditEntry) {
  const { db, config, chainKey } = ctx;
  const category = categoryFor(ctx, entry);
  // An entry about a private entry keeps its Unit Instance and loses its unit, decided as it is written: the trail is
  // sealed, so one written before keeps what it had.
  const filedUnder = entry.unit_id && !(entry.privateEntry ?? privateEntry(ctx, entry.entity, entry.entity_id)) ? entry.unit_id : null;
  const row = {
    id: newId(), actor_id: entry.actor_id ?? null, action: entry.action, entity: entry.entity ?? null, entity_id: entry.entity_id ?? null,
    subject_id: subjectOf(ctx, entry), unit_id: filedUnder, detail: entry.detail ? String(entry.detail).slice(0, 1000) : null,
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

/**
 * A list of records that holds somebody else's is a read of theirs: one entry for each Marine and unit on it, and no more
 * than one every five minutes for the same reader, record type, Marine and unit, so a page that refreshes does not fill
 * the trail.
 */
export function auditListedRecords(ctx: AppContext, actorId: string, table: string, rows: ReadonlyArray<Record<string, unknown>>, ip?: string | null) {
  const foreign = new Map<string, { subject: string; unit: string | null; count: number }>();
  for (const r of rows) {
    // A counseling draft in the list is the reader's own working paper, not yet the Marine's (ADR-0027 §1).
    if (r.user_id === actorId || r.stage === 'draft') continue;
    const key = `${r.user_id}|${r.unit_id || ''}`;
    const entry = foreign.get(key) || { subject: String(r.user_id), unit: (r.unit_id as string | null) || null, count: 0 };
    entry.count += 1; foreign.set(key, entry);
  }
  if (!foreign.size) return;
  // What this reader listed in the last five minutes, read once for the whole list. The unary plus keeps the planner on
  // the bounded five-minute range of idx_audit_action: on the reader or a Marine's index it would walk every entry
  // about them, which is longest exactly when nothing recent is found and an entry has to be written.
  const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const recent = new Set((ctx.db.prepare(`SELECT subject_id, unit_id FROM audit_log WHERE action = 'list_records' AND at > ? AND +actor_id = ? AND +entity = ?`)
    .all(cutoff, actorId, table) as Array<{ subject_id: string | null; unit_id: string | null }>).map((r) => `${r.subject_id}|${r.unit_id || ''}`));
  for (const [key, e] of foreign) if (!recent.has(key)) audit(ctx, { actor_id: actorId, action: 'list_records', entity: table, subject_id: e.subject, unit_id: e.unit, detail: `${e.count} rows`, ip });
}

export interface ChainCheck { ok: boolean; count: number; reason?: string }
/** The last answer for each running service, and when it was reached. */
const chainChecks = new WeakMap<AppContext, { at: number; result: ChainCheck }>();

/**
 * The chain walk, oldest first, one entry at a time, so the log is never held in memory whole. The statement cache hands
 * every caller of the same SQL text the same statement, and a statement being iterated cannot run again until the walk
 * ends: this text is the walk's alone. resealAuditChain reads with other text, because it writes while it reads.
 */
const CHAIN_WALK = 'SELECT seq, id, actor_id, action, entity, entity_id, subject_id, unit_id, detail, at, ip, org_id, category, prev_hash, entry_hash FROM audit_log ORDER BY seq';

/**
 * Recomputes every entry's seal and the signed head. This is the explicit check: the integrity page, an anchor check and
 * the maintenance task run it and always get a fresh answer. A page that only shows the chain's state uses
 * recentChainCheck, which reuses an answer for a minute.
 */
export function verifyAuditChain(ctx: AppContext): ChainCheck {
  const { db, chainKey } = ctx;
  let previous = '';
  let count = 0;
  let broken: string | null = null;
  for (const row of db.prepare(CHAIN_WALK).iterate() as IterableIterator<Record<string, unknown>>) {
    const expected = entryHash(chainKey, row, previous);
    if ((row.prev_hash ?? null) !== (previous || null) || row.entry_hash !== expected) { broken = String(row.id); break; }
    previous = String(row.entry_hash);
    count += 1;
  }
  const result = ((): ChainCheck => {
    // A broken chain still reports how many entries the log holds, as it always has.
    if (broken) return { ok: false, count: (db.prepare('SELECT COUNT(*) AS n FROM audit_log').get() as { n: number }).n, reason: `audit entry ${broken} does not match the chain` };
    const head = JSON.parse(metaGet(db, 'audit_head') || '{"hash":"","count":0,"mac":""}') as { hash: string; count: number; mac?: string };
    if (head.hash !== previous || head.count !== count) return { ok: false, count, reason: 'audit head does not match the chain' };
    if (count && head.mac !== hmac(chainKey, `audit-head:${head.hash}:${head.count}`)) return { ok: false, count, reason: 'audit head signature is invalid' };
    return { ok: true, count };
  })();
  // The newest answer is the one a page shows next, so an explicit check that finds the chain broken says so everywhere.
  chainChecks.set(ctx, { at: Date.now(), result });
  return result;
}

/**
 * The chain's state as a page shows it: the last answer if it is under `maxAgeMs` old, otherwise a fresh verification.
 * Verifying reads the whole service's log, so the trail's first page, the overview and the health report share one
 * answer a minute instead of each walking the log on every filter and every refocus. A rewrite shows on them within
 * that minute; the integrity page and an anchor check never wait for it.
 */
export function recentChainCheck(ctx: AppContext, maxAgeMs = 60_000): ChainCheck & { checkedAt: string } {
  const seen = chainChecks.get(ctx);
  if (seen && Date.now() - seen.at < maxAgeMs) return { ...seen.result, checkedAt: new Date(seen.at).toISOString() };
  const result = verifyAuditChain(ctx);
  return { ...result, checkedAt: new Date(chainChecks.get(ctx)!.at).toISOString() };
}

// Anchors: the chain's head, kept outside the server (ADR-0013)

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

/**
 * An organization's audit trail as SQL over `alias`, and its parameters. audit() gives every entry with a unit that
 * unit's organization, so only entries written before Unit Instances, or before their unit joined one, lack it. Most
 * instances hold none, and for them the trail is `org_id = ?` alone, which reads its own entries through idx_audit_org;
 * the OR with the older entries makes SQLite walk the whole service's log back from the newest entry instead. The
 * question is asked on every read, never remembered: a unit that joins an instance brings its older entries with it.
 */
export function orgAuditWhere(ctx: AppContext, orgId: string, alias = 'al'): { where: string; params: unknown[] } {
  const older = ctx.db.prepare('SELECT 1 FROM audit_log al WHERE al.org_id IS NULL AND al.unit_id IN (SELECT id FROM units WHERE org_id = ?) LIMIT 1').get(orgId);
  return older ? { where: orgAuditClause(alias), params: [orgId, orgId] } : { where: `${alias}.org_id = ?`, params: [orgId] };
}
