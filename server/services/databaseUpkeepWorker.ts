import Database from 'better-sqlite3';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/**
 * The scheduled upkeep's work on the database (ADR-0042), on a thread and a connection of its own. The integrity check
 * reads every page; on the service's own thread it would hold every request while it ran. Nothing here reads a record:
 * it reports SQLite's own messages, table names and counts.
 *
 * The service's connection never waits on this one for longer than one short step. The integrity check only reads. The
 * statistics are refreshed table by table under SQLite's analysis limit, each in a moment. The log is folded in without
 * waiting on anyone, then emptied only if nobody is reading or writing at that instant: the attempt does not wait.
 */

export interface UpkeepWork {
  /** SQLite's integrity check: its first messages (`ok` alone when sound) and how many it gave, at most 100. */
  integrity: { ok: boolean; problems: number; messages: string[] };
  /** The tables whose statistics had gone stale and were refreshed. */
  analyzed: string[];
  /** The write-ahead log: the pages it held, those folded into the database, and whether it was emptied. Null without one. */
  checkpoint: { pages: number; folded: number; emptied: boolean } | null;
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
export type UpkeepStep = 'checking the database for damage' | 'refreshing the query statistics' | 'folding in the write-ahead log';

export function upkeepWork(path: string, onStep: (step: UpkeepStep) => void = () => {}): UpkeepWork {
  const started = performance.now();
  const db = new Database(path, { fileMustExist: true });
  const skipped: string[] = [];
  try {
    // Waiting on the service's connection holds nothing up: this thread has nobody else to answer.
    db.pragma('busy_timeout = 5000');
    // The statistics it replaces are samples of indexed values: overwritten too, like every deletion (ADR-0042).
    db.pragma('secure_delete = ON');
    onStep('checking the database for damage');
    const messages = (db.pragma(`integrity_check(${MAX_PROBLEMS})`) as Array<{ integrity_check: string }>).map((r) => r.integrity_check);
    const ok = messages.length === 1 && messages[0] === 'ok';
    const integrity = { ok, problems: ok ? 0 : messages.length, messages: messages.slice(0, 20).map((m) => m.slice(0, 300)) };

    let analyzed: string[] = [];
    onStep('refreshing the query statistics');
    try {
      // 0x10003 lists what 0x10012 then runs: every table whose statistics are stale (0x10000 looks past the tables this
      // connection has used, which is none), each under the analysis limit (0x10).
      analyzed = (db.pragma('optimize(0x10003)') as Array<{ optimize: string }>)
        .map((r) => /^ANALYZE "main"\."(.+)"$/.exec(r.optimize)?.[1]?.replace(/""/g, '"'))
        .filter((t): t is string => Boolean(t));
      if (analyzed.length) db.pragma('optimize(0x10012)');
    } catch (error) {
      skipped.push(`statistics: ${(error as Error).message}`);
      analyzed = [];
    }

    let checkpoint: UpkeepWork['checkpoint'] = null;
    onStep('folding in the write-ahead log');
    try {
      const [passive] = db.pragma('wal_checkpoint(PASSIVE)') as Array<{ busy: number; log: number; checkpointed: number }>;
      if (passive && passive.log >= 0) {
        db.pragma('busy_timeout = 0');
        const [truncate] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number }>;
        checkpoint = { pages: passive.log, folded: passive.checkpointed, emptied: Boolean(truncate && !truncate.busy && truncate.log === 0) };
      }
    } catch (error) {
      skipped.push(`write-ahead log: ${(error as Error).message}`);
    }
    return { integrity, analyzed, checkpoint, skipped, ms: Math.round(performance.now() - started) };
  } finally {
    db.close();
  }
}

if (!isMainThread && parentPort && (workerData as { upkeep?: string } | null)?.upkeep) {
  const port = parentPort;
  port.postMessage({ done: upkeepWork((workerData as { upkeep: string }).upkeep, (step) => port.postMessage({ step })) });
}
