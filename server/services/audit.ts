import type { AppContext } from '../context.ts';
import { hmac } from '../lib/crypto.ts';
import { newId, now } from '../lib/ids.ts';
import { metaGet, metaSet } from '../db/index.ts';
import { forwardAudit } from './auditSink.ts';

export interface AuditEntry {
  actor_id?: string | null; action: string; entity?: string | null; entity_id?: string | null; subject_id?: string | null;
  unit_id?: string | null; detail?: string | null; ip?: string | null;
  /** The organization the entry belongs to (ADR-0006). Taken from unit_id when not given; none for the platform's own actions. */
  org_id?: string | null;
}

function entryHash(secret: string, row: Record<string, unknown>, previous: string): string {
  const canonical = JSON.stringify([
    previous || '', row.id, row.actor_id ?? null, row.action, row.entity ?? null, row.entity_id ?? null,
    row.subject_id ?? null, row.unit_id ?? null, row.detail ?? null, row.at, row.ip ?? null,
    // Sealed in only when set, so every entry written before organizations still verifies as it was written.
    ...(row.org_id ? [row.org_id] : []),
  ]);
  return hmac(secret, canonical);
}

export function audit(ctx: AppContext, entry: AuditEntry) {
  const { db, config, chainKey } = ctx;
  const row = {
    id: newId(), actor_id: entry.actor_id ?? null, action: entry.action, entity: entry.entity ?? null, entity_id: entry.entity_id ?? null,
    subject_id: entry.subject_id ?? null, unit_id: entry.unit_id ?? null, detail: entry.detail ? String(entry.detail).slice(0, 1000) : null,
    ip: entry.ip ?? null, at: now(),
    org_id: entry.org_id ?? (entry.unit_id ? ((db.prepare('SELECT org_id FROM units WHERE id = ?').get(entry.unit_id) as { org_id: string | null } | undefined)?.org_id ?? null) : null),
  };
  let prevHash: string | null = null;
  let hash = '';
  db.transaction(() => {
    const head = JSON.parse(metaGet(db, 'audit_head') || '{"hash":"","count":0}') as { hash: string; count: number };
    hash = entryHash(chainKey, row, head.hash);
    prevHash = head.hash || null;
    db.prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, subject_id, unit_id, detail, ip, at, prev_hash, entry_hash, org_id)
       VALUES (@id, @actor_id, @action, @entity, @entity_id, @subject_id, @unit_id, @detail, @ip, @at, @prev_hash, @entry_hash, @org_id)`
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

export function resealAuditChain(ctx: AppContext) {
  const { db, config, chainKey } = ctx;
  if (config.accessMode !== 'demo' || metaGet(db, 'demo_database') !== '1') throw new Error('The audit chain is only resealed on a synthetic demo database.');
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as Array<Record<string, unknown>>;
  const update = db.prepare('UPDATE audit_log SET prev_hash = ?, entry_hash = ? WHERE seq = ?');
  db.transaction(() => {
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
