import type { AppContext } from '../context.ts';
import { RECORD_TABLE_NAMES } from './records.ts';
import { VERSION } from '../version.ts';
import { now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { hmac } from '../lib/crypto.ts';
import { loadRuntime } from '../runtime.ts';

const keyCheck = (secret: string) => hmac(secret, 'vantage-instance-key-check');

const EXPORT_TABLES = ['ranks', 'users', 'readiness', 'units', 'unit_members', 'roles', 'member_roles', 'passkeys', 'recovery_codes', ...RECORD_TABLE_NAMES, 'attachments', 'audit_log', 'notifications', 'maradmins', 'maradmin_user_state', 'ai_usage_daily', 'email_log', 'meta'] as const;

/** Full-instance JSON archive: everything needed to stand the instance up on another host. Sessions and tokens are deliberately excluded. */
export function exportInstance(ctx: AppContext) {
  const tables: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    const rows = ctx.db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
    tables[table] = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = Buffer.isBuffer(v) ? { $bytes: v.toString('base64') } : v;
      return out;
    });
  }
  return { format: 'vantage-instance/1', version: VERSION, exported_at: now(), key_check: keyCheck(ctx.config.secret), tables };
}

export function importInstance(ctx: AppContext, archive: { format?: string; key_check?: string; tables?: Record<string, Array<Record<string, unknown>>> }, actorId: string) {
  if (archive?.format !== 'vantage-instance/1' || !archive.tables) throw new Error('That file is not a Vantage instance archive.');
  if (archive.key_check && archive.key_check !== keyCheck(ctx.config.secret)) throw new Error('This archive was exported under a different VANTAGE_SECRET. Set the same secret on this host before importing, or authenticator secrets and the audit chain will not verify.');
  const users = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  const activities = (ctx.db.prepare('SELECT COUNT(*) AS n FROM activities').get() as { n: number }).n;
  if (users > 1 || activities > 0) throw new Error('Import only into a fresh instance (one operator account, no records).');
  const counts: Record<string, number> = {};
  ctx.db.pragma('foreign_keys = OFF');
  try {
    ctx.db.transaction(() => {
      for (const table of ['sessions', 'tokens', ...[...EXPORT_TABLES].reverse()]) ctx.db.prepare(`DELETE FROM ${table}`).run();
      for (const table of EXPORT_TABLES) {
        const rows = archive.tables![table] || [];
        if (!rows.length) { counts[table] = 0; continue; }
        const columns = (ctx.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        const insert = ctx.db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of rows) {
          insert.run(...columns.map((c) => {
            const v = row[c];
            if (v && typeof v === 'object' && '$bytes' in (v as object)) return Buffer.from(String((v as { $bytes: string }).$bytes), 'base64');
            return v === undefined ? null : v;
          }));
        }
        counts[table] = rows.length;
      }
      const violations = ctx.db.pragma('foreign_key_check') as unknown[];
      if (violations.length) throw new Error(`Archive has ${violations.length} foreign key violation(s): ${JSON.stringify(violations.slice(0, 3))}`);
    })();
  } finally {
    ctx.db.pragma('foreign_keys = ON');
  }
  // The archive brought its own runtime settings; the in-memory copy must follow or the next save would overwrite them.
  Object.assign(ctx.runtime, loadRuntime(ctx.db, ctx.config));
  // The importing operator's own account was replaced by the archive, so the entry names it in detail rather than by foreign key.
  audit(ctx, { actor_id: null, action: 'instance_import', entity: 'instance', detail: `by ${actorId}; ${JSON.stringify(counts)}`.slice(0, 900) });
  return counts;
}
