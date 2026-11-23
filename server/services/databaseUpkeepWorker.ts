import Database from 'better-sqlite3';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/**
 * The part of the scheduled upkeep (ADR-0042) that reads the whole database, on a thread and a connection of its own:
 * SQLite's integrity check, then a passive checkpoint that folds in what was written while it read. On the service's own
 * thread the check would hold every request while it read every page. Nothing here reads a record: it reports SQLite's
 * own messages and counts.
 *
 * Neither step takes the write lock. On a second connection, a step that did (ANALYZE, a truncating checkpoint) makes the
 * service's transactions that read before they write fail at once with SQLITE_BUSY: SQLite does not wait for a lock a
 * transaction already reading would have to take. Those steps run on the service's own connection (databaseUpkeep.ts).
 */

export interface UpkeepWork {
  /** SQLite's integrity check: its first messages (`ok` alone when sound) and how many it gave, at most MAX_PROBLEMS. */
  integrity: { ok: boolean; problems: number; messages: string[] };
  /** Pages the passive checkpoint folded in. Null when it did not run: no log, damage, or another checkpoint under way. */
  folded: number | null;
  /** A step that could not run this time, with SQLite's reason. */
  skipped: string[];
  ms: number;
}

/** The integrity check stops listing at this many messages, so a count that reaches it means at least this many. */
export const MAX_PROBLEMS = 100;

/**
 * What a step is doing, said as it starts. A worker thread cannot be stopped inside a call into SQLite: told to stop, it
 * ends when the step it is in returns, so a run stopped for its time limit names that step.
 */
export type UpkeepStep = 'checking the database for damage' | 'folding in the write-ahead log';

/** Damage SQLite reports by stopping instead of listing it: a schema it cannot parse, a header that is not a database. */
const STOPPED_BY_DAMAGE = /^SQLITE_(CORRUPT|NOTADB)/;

export function upkeepWork(path: string, onStep: (step: UpkeepStep) => void = () => {}): UpkeepWork {
  const started = performance.now();
  const db = new Database(path, { fileMustExist: true });
  const skipped: string[] = [];
  try {
    // Waiting holds nothing up: this thread has nobody else to answer.
    db.pragma('busy_timeout = 5000');
    onStep('checking the database for damage');
    let integrity: UpkeepWork['integrity'];
    try {
      const messages = (db.pragma(`integrity_check(${MAX_PROBLEMS})`) as Array<{ integrity_check: string }>).map((r) => r.integrity_check);
      const ok = messages.length === 1 && messages[0] === 'ok';
      integrity = { ok, problems: ok ? 0 : messages.length, messages: messages.slice(0, 20).map((m) => m.slice(0, 300)) };
    } catch (error) {
      if (!STOPPED_BY_DAMAGE.test(String((error as { code?: string }).code ?? ''))) throw error;
      integrity = { ok: false, problems: 1, messages: [String((error as Error).message).slice(0, 300)] };
    }

    let folded: number | null = null;
    if (integrity.ok && String(db.pragma('journal_mode', { simple: true })) === 'wal') {
      onStep('folding in the write-ahead log');
      try {
        // Passive: it copies what no reader still needs, and never takes the write lock or waits.
        const [passive] = db.pragma('wal_checkpoint(PASSIVE)') as Array<{ busy: number; log: number; checkpointed: number }>;
        if (passive && passive.checkpointed >= 0) folded = passive.checkpointed;
      } catch (error) {
        skipped.push(`write-ahead log: ${(error as Error).message}`);
      }
    }
    return { integrity, folded, skipped, ms: Math.round(performance.now() - started) };
  } finally {
    db.close();
  }
}

if (!isMainThread && parentPort && (workerData as { upkeep?: string } | null)?.upkeep) {
  const port = parentPort;
  port.postMessage({ done: upkeepWork((workerData as { upkeep: string }).upkeep, (step) => port.postMessage({ step })) });
}
