import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.ts';
import { metaGet, metaSet } from '../db/index.ts';

/**
 * The restore drills run against this database (ADR-0041): `node scripts/restore.ts DRILL --from <backup.db>`, and
 * `REPLACE-DATABASE --dry-run`, which is the same drill. Each restores a backup into a scratch copy beside the database,
 * opens it with this build and checks it, then removes it; the live database is only read, and records the result here.
 * The running service writes each into the audit trail (auditDrills). Like backupLog.ts, this imports nothing beyond the
 * database helpers, so the restore script can use it without starting the application.
 */
export interface DrillRecord {
  id: string;
  at: string;
  /** drill: `restore.ts DRILL`. dry_run: `REPLACE-DATABASE --dry-run`, which also checks who authorized it. */
  kind: 'drill' | 'dry_run';
  ok: boolean;
  /** Why it failed, in a sentence. */
  failure: string | null;
  /** The backup rehearsed: its file name, size and SHA-256, the schema and newest audit entry it holds, and whether this database recorded taking it. */
  backup: { file: string; bytes: number | null; sha256: string | null; schema: number | null; seq: number | null; at: string | null; recorded: boolean };
  /** The upgrade this build ran on the restored copy, when it was at an older schema: from, to, and what the upgrade check found. */
  upgraded: { from: number; to: number; status: string } | null;
  /** The audit entries that verified on the restored copy, opened under VANTAGE_SECRET alone. */
  trail: number | null;
  /** Whether the backup is of this database, as a restore judges it; null when one of them carries no id and the trail cannot say. */
  sameDatabase: boolean | null;
  /** What a restore from it would undo: audit entries, Unit Instances among them, and account, authority and hold changes. */
  wouldUndo: { entries: number; instances: number; changes: number } | null;
  /** The Lead Vantage Administrator a dry run named, by username. */
  by: string | null;
  /** The account on the host that ran it. */
  hostUser: string | null;
  /** The build that ran it. */
  version: string;
  ms: number;
  audited: boolean;
}

const KEPT = 20;

export function drillHistory(db: Db): DrillRecord[] {
  try {
    const parsed = JSON.parse(metaGet(db, 'drill_history') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Adds a drill, under the write lock, so the script and the running service never lose one. */
export function recordDrill(db: Db, record: Omit<DrillRecord, 'id' | 'at' | 'audited'> & { at?: string }): DrillRecord {
  const entry: DrillRecord = { ...record, id: randomUUID(), at: record.at ?? new Date().toISOString(), audited: false };
  db.transaction(() => { metaSet(db, 'drill_history', JSON.stringify([...drillHistory(db), entry].slice(-KEPT))); }).immediate();
  return entry;
}

/** Marks drills audited, inside the caller's transaction, after the caller wrote their entries. */
export function markDrillsAudited(db: Db, ids: Set<string>) {
  if (!metaGet(db, 'drill_history')) return;
  metaSet(db, 'drill_history', JSON.stringify(drillHistory(db).map((r) => (ids.has(r.id) ? { ...r, audited: true } : r))));
}
