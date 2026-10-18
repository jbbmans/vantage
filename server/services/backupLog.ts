import type { Db } from '../db/index.ts';
import { metaGet, metaSet } from '../db/index.ts';

/**
 * The backups Vantage knows were taken: a download from the Vantage Administrator console, or `npm run backup` on the
 * server. Kept in the database they describe, so the console can say how fresh the last one is. A copy the hosting
 * environment takes on its own (a volume snapshot, storage replication) never passes through Vantage and is not here
 * (I-09). Only this module and scripts/backup.ts write it; it imports nothing beyond the database helpers, so the script
 * can use it without starting the application.
 */
export interface BackupRecord {
  at: string;
  method: 'browser' | 'server';
  bytes: number | null;
  /** Who took it from the console. A server backup is taken by whoever runs the script, which Vantage cannot see. */
  by: string | null;
  /** The copy's file name, without its directory. */
  file: string | null;
  /**
   * The newest audit entry the copy holds: what a restore from it goes back to, and how a Unit Instance's changes since
   * are counted (ADR-0014). Absent on a backup recorded before it was kept.
   */
  seq?: number | null;
  /**
   * False until the backup is in the audit trail. A console backup is audited as it is taken; one taken on the server is
   * audited by the running service, which holds the key the trail is sealed with (auditServerBackups). Absent on a
   * backup recorded before it was kept, which is never audited after the fact.
   */
  audited?: boolean;
}

const KEPT = 20;

export function backupHistory(db: Db): BackupRecord[] {
  try {
    const parsed = JSON.parse(metaGet(db, 'backup_history') || '[]');
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch { /* unreadable: treated as none */ }
  // Before the history was kept, a browser download left only its time.
  const legacy = metaGet(db, 'last_backup_at');
  return legacy ? [{ at: legacy, method: 'browser', bytes: null, by: null, file: null }] : [];
}

export function recordBackup(db: Db, record: Omit<BackupRecord, 'at'> & { at?: string }) {
  const entry: BackupRecord = {
    at: record.at ?? new Date().toISOString(), method: record.method, bytes: record.bytes, by: record.by, file: record.file,
    seq: record.seq ?? null, audited: record.audited ?? false,
  };
  // IMMEDIATE takes the write lock before reading, so the script and the running service cannot interleave and lose one.
  db.transaction(() => {
    metaSet(db, 'backup_history', JSON.stringify([...backupHistory(db), entry].slice(-KEPT)));
    metaSet(db, 'last_backup_at', entry.at);
  }).immediate();
  return entry;
}

/**
 * Marks recorded backups as audited, inside the caller's transaction, after the caller wrote their entries. `pick`
 * chooses which; the history is read again here, so a backup recorded meanwhile is not lost.
 */
export function markBackupsAudited(db: Db, pick: (record: BackupRecord) => boolean) {
  const history = backupHistory(db);
  if (!metaGet(db, 'backup_history')) return;
  metaSet(db, 'backup_history', JSON.stringify(history.map((r) => (pick(r) ? { ...r, audited: true } : r))));
}
