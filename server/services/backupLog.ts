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
  const entry: BackupRecord = { at: record.at ?? new Date().toISOString(), method: record.method, bytes: record.bytes, by: record.by, file: record.file };
  db.transaction(() => {
    metaSet(db, 'backup_history', JSON.stringify([...backupHistory(db), entry].slice(-KEPT)));
    metaSet(db, 'last_backup_at', entry.at);
  })();
  return entry;
}
