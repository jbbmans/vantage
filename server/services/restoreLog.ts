import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { metaGet, metaSet } from '../db/index.ts';

/**
 * The restores a database has been through, and its lineage (ADR-0014). A restore with `npm run restore` writes its
 * record into the database it puts in place; importing a service archive writes one in the console; and a start that
 * finds its database no longer holds the audit entry the service last noted beside it (the lineage file), with no
 * restore to explain it, records that the database was replaced some other way. The running service writes each into
 * the audit trail. Like backupLog.ts, this imports nothing beyond the database helpers, so the restore script can use it
 * without starting the application.
 */

/** A point in a database's audit chain: its newest entry, how many it holds, and which database it is. */
export interface ChainPoint {
  seq: number | null;
  hash: string | null;
  /** When the newest entry was written. */
  at: string | null;
  count: number;
  database_id: string | null;
  schema: number;
}

/** An account, authority or hold change the restore undid: written after the backup, and gone with the entries after it. */
export interface UndoneChange {
  seq: number; at: string; action: string; subject_id: string | null; org_id: string | null;
  /** The account's username as the replaced database had it: an account opened after the backup is gone with the restore. */
  subject_username?: string | null;
}

export interface RestoreRecord {
  id: string;
  at: string;
  /** script: npm run restore. archive: a service archive imported in the console. detected: a start found the database replaced some other way. */
  method: 'script' | 'archive' | 'detected';
  /** The Lead Vantage Administrator who authorized it; none for a detected replacement. */
  by: { id: string | null; username: string; name: string } | null;
  /** The account on the host that ran the command. */
  hostUser: string | null;
  reason: string | null;
  /** A change or incident record the restore was made under, when one was given. */
  change: string | null;
  /** What was put in place. */
  restored: ChainPoint & { file: string | null; bytes: number | null };
  /** What it replaced, when that could be read. */
  replaced: ChainPoint | null;
  /** True when the copy came from this same database, false from another, null when one of them carries no id. */
  sameDatabase: boolean | null;
  /** The audit entries the replaced database held past the restored one: how much was undone, in total and per Unit Instance. */
  lost: { entries: number; since: string | null; instances: Record<string, number> } | null;
  /** Account, authority and hold changes among them, which are as the backup had them again. */
  undone: { count: number; entries: UndoneChange[] } | null;
  /** What a detected replacement found: another database, or this one without the entry last noted, or with another in its place. */
  finding?: 'other_database' | 'missing_entry' | 'different_entry';
  /** The copy of the replaced database the restore kept, by file name. */
  safetyCopy: string | null;
  audited: boolean;
}

/**
 * Changes to who can sign in, with what authority, and to what is held from disposal. A restore puts each back as the
 * backup had it, so the restore record lists those it undid for Vantage staff and the Lead Unit Managers to make again.
 */
export const RESTORE_REVIEW_ACTIONS = [
  'staff_role_granted', 'staff_role_revoked', 'platform_owner_named', 'platform_manager_assigned', 'platform_manager_removed',
  'org_owner_named', 'org_role_granted', 'org_role_revoked', 'org_role_ended', 'org_role_restored', 'grant_role', 'revoke_role',
  'unit_leader_set', 'unit_leader_ended', 'transfer_ownership', 'remove_member', 'removed_from_organization',
  'deactivate_account', 'reactivate_account', 'personnel_separated', 'personnel_reactivated', 'personnel_link', 'personnel_unlink',
  'edipi_corrected', 'password_change', 'password_reset', 'temporary_password', 'reset_mfa', 'mfa_enabled', 'mfa_disabled',
  'passkey_added', 'passkey_removed', 'recovery_codes_regenerated', 'revoke_sessions', 'force_logout', 'account_unlock',
  'organization_suspended', 'organization_archived', 'organization_restored', 'legal_hold_placed', 'legal_hold_released',
  'retention_schedule_saved', 'instance_feature_withheld', 'instance_feature_restored',
] as const;

const KEPT = 20;
const UNDONE_LISTED = 25;

export function restoreHistory(db: Db): RestoreRecord[] {
  try {
    const parsed = JSON.parse(metaGet(db, 'restore_history') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Adds a record, inside the caller's transaction where there is one. */
export function appendRestore(db: Db, record: Omit<RestoreRecord, 'id' | 'at'> & { id?: string; at?: string }): RestoreRecord {
  const entry: RestoreRecord = { ...record, id: record.id ?? randomUUID(), at: record.at ?? new Date().toISOString() };
  metaSet(db, 'restore_history', JSON.stringify([...restoreHistory(db), entry].slice(-KEPT)));
  return entry;
}

export function markRestoreAudited(db: Db, id: string) {
  const history = restoreHistory(db);
  metaSet(db, 'restore_history', JSON.stringify(history.map((r) => (r.id === id ? { ...r, audited: true } : r))));
}

export function chainPoint(db: Db): ChainPoint {
  const last = db.prepare('SELECT seq, entry_hash, at FROM audit_log ORDER BY seq DESC LIMIT 1').get() as { seq: number; entry_hash: string; at: string } | undefined;
  let count = 0;
  try { count = Number((JSON.parse(metaGet(db, 'audit_head') || '{}') as { count?: number }).count ?? 0); } catch { count = 0; }
  return {
    seq: last?.seq ?? null, hash: last?.entry_hash ?? null, at: last?.at ?? null, count,
    database_id: metaGet(db, 'database_id'), schema: Number(metaGet(db, 'schema_version') || 0),
  };
}

/**
 * What the replaced database held past the restored one, read from the replaced database: the audit entries after the
 * restored one's newest, per Unit Instance, and the account, authority and hold changes among them. Only meaningful when both
 * are the same database.
 */
export function lostSince(replaced: Db, restored: ChainPoint) {
  const after = restored.seq ?? 0;
  const entries = (replaced.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE seq > ?').get(after) as { n: number }).n;
  const instances = Object.fromEntries((replaced.prepare('SELECT org_id, COUNT(*) AS n FROM audit_log WHERE seq > ? AND org_id IS NOT NULL GROUP BY org_id').all(after) as Array<{ org_id: string; n: number }>).map((r) => [r.org_id, r.n]));
  const actions = JSON.stringify(RESTORE_REVIEW_ACTIONS);
  const undoneCount = (replaced.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE seq > ? AND action IN (SELECT value FROM json_each(?))').get(after, actions) as { n: number }).n;
  const undone = replaced.prepare(`SELECT a.seq, a.at, a.action, a.subject_id, a.org_id, u.username AS subject_username FROM audit_log a LEFT JOIN users u ON u.id = a.subject_id
                                   WHERE a.seq > ? AND a.action IN (SELECT value FROM json_each(?)) ORDER BY a.seq LIMIT ${UNDONE_LISTED}`).all(after, actions) as UndoneChange[];
  return { lost: { entries, since: restored.at, instances }, undone: { count: undoneCount, entries: undone } };
}

// ——— Lineage: the newest entry the service last saw, kept beside the database ———

export interface Lineage { format: 'vantage-lineage/1'; database_id: string | null; seq: number | null; hash: string | null; count: number; schema: number; at: string }

export function readLineage(file: string | null): Lineage | null {
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Lineage;
    return parsed?.format === 'vantage-lineage/1' ? parsed : null;
  } catch { return null; }
}

/** Writes the lineage file whole or not at all: a temporary file beside it, renamed over it, readable by its owner only. */
export function writeLineageFile(file: string, point: ChainPoint, at = new Date().toISOString()): Lineage {
  const lineage: Lineage = { format: 'vantage-lineage/1', database_id: point.database_id, seq: point.seq, hash: point.hash, count: point.count, schema: point.schema, at };
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(lineage)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  return lineage;
}

/**
 * Compares the database with the lineage last written beside it. The database still holding the entry the lineage names,
 * with the same hash, is the same database at that point or later. Anything else is a replacement: another database, or
 * this one put back to before that entry, or one whose chain was rewritten.
 */
export function lineageFinding(db: Db, lineage: Lineage): RestoreRecord['finding'] | null {
  const id = metaGet(db, 'database_id');
  if (lineage.database_id && id && lineage.database_id !== id) return 'other_database';
  if (!lineage.seq) return null;
  const row = db.prepare('SELECT entry_hash FROM audit_log WHERE seq = ?').get(lineage.seq) as { entry_hash: string } | undefined;
  if (!row) return 'missing_entry';
  return row.entry_hash === lineage.hash ? null : 'different_entry';
}

/**
 * At start, before anything is written: a database that no longer matches its lineage, and that no restore since explains,
 * is recorded as replaced, for the service to audit and tell Vantage staff and the Lead Unit Managers (ADR-0014).
 */
export function checkLineage(db: Db, file: string | null): RestoreRecord | null {
  const lineage = readLineage(file);
  if (!lineage) return null;
  const finding = lineageFinding(db, lineage);
  if (!finding) return null;
  // npm run restore records itself in the copy before it renames it into place, and then writes the lineage; a restore
  // that stopped between the two is explained by its own record.
  if (restoreHistory(db).some((r) => r.method === 'script' && r.at >= lineage.at)) return null;
  const current = chainPoint(db);
  const same = lineage.database_id && current.database_id ? lineage.database_id === current.database_id : null;
  return db.transaction(() => appendRestore(db, {
    method: 'detected', by: null, hostUser: null, reason: null, change: null, finding,
    restored: { ...current, file: null, bytes: null },
    replaced: { seq: lineage.seq, hash: lineage.hash, at: lineage.at, count: lineage.count, database_id: lineage.database_id, schema: Number(lineage.schema) || 0 },
    sameDatabase: same,
    lost: same && lineage.count > current.count ? { entries: lineage.count - current.count, since: current.at, instances: {} } : null,
    undone: null, safetyCopy: null, audited: false,
  })).immediate();
}
