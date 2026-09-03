import type { AppContext } from '../context.ts';
import { hmac } from '../lib/crypto.ts';
import { newId, now } from '../lib/ids.ts';
import { metaGet, metaSet } from '../db/index.ts';

export interface AuditEntry {
  actor_id?: string | null; action: string; entity?: string | null; entity_id?: string | null; subject_id?: string | null;
  unit_id?: string | null; detail?: string | null; ip?: string | null;
}

function entryHash(secret: string, row: Record<string, unknown>, previous: string): string {
  const canonical = JSON.stringify([
    previous || '', row.id, row.actor_id ?? null, row.action, row.entity ?? null, row.entity_id ?? null,
    row.subject_id ?? null, row.unit_id ?? null, row.detail ?? null, row.at,
  ]);
  return hmac(secret, canonical);
}

export function audit(ctx: AppContext, entry: AuditEntry) {
  const { db, config } = ctx;
  const row = {
    id: newId(), actor_id: entry.actor_id ?? null, action: entry.action, entity: entry.entity ?? null, entity_id: entry.entity_id ?? null,
    subject_id: entry.subject_id ?? null, unit_id: entry.unit_id ?? null, detail: entry.detail ? String(entry.detail).slice(0, 1000) : null,
    ip: entry.ip ?? null, at: now(),
  };
  db.transaction(() => {
    const head = JSON.parse(metaGet(db, 'audit_head') || '{"hash":"","count":0}') as { hash: string; count: number };
    const hash = entryHash(config.secret, row, head.hash);
    db.prepare(
      `INSERT INTO audit_log (id, actor_id, action, entity, entity_id, subject_id, unit_id, detail, ip, at, prev_hash, entry_hash)
       VALUES (@id, @actor_id, @action, @entity, @entity_id, @subject_id, @unit_id, @detail, @ip, @at, @prev_hash, @entry_hash)`
    ).run({ ...row, prev_hash: head.hash || null, entry_hash: hash });
    const count = head.count + 1;
    metaSet(db, 'audit_head', JSON.stringify({ hash, count, mac: hmac(config.secret, `audit-head:${hash}:${count}`) }));
  })();
}

export function verifyAuditChain(ctx: AppContext): { ok: boolean; count: number; reason?: string } {
  const { db, config } = ctx;
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY seq').all() as Array<Record<string, unknown>>;
  let previous = '';
  for (const row of rows) {
    const expected = entryHash(config.secret, row, previous);
    if ((row.prev_hash ?? null) !== (previous || null) || row.entry_hash !== expected) {
      return { ok: false, count: rows.length, reason: `audit entry ${row.id} does not match the chain` };
    }
    previous = String(row.entry_hash);
  }
  const head = JSON.parse(metaGet(db, 'audit_head') || '{"hash":"","count":0,"mac":""}') as { hash: string; count: number; mac?: string };
  if (head.hash !== previous || head.count !== rows.length) return { ok: false, count: rows.length, reason: 'audit head does not match the chain' };
  if (rows.length && head.mac !== hmac(config.secret, `audit-head:${head.hash}:${head.count}`)) return { ok: false, count: rows.length, reason: 'audit head signature is invalid' };
  return { ok: true, count: rows.length };
}
