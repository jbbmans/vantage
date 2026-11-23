import type Database from 'better-sqlite3';
import { Worker } from 'node:worker_threads';
import type { AppContext } from '../context.ts';
import { metaGet, metaSet } from '../db/index.ts';
import { now } from '../lib/ids.ts';
import { audit } from './audit.ts';
import { notifyStaff } from './notifications.ts';
import { MAX_PROBLEMS, type UpkeepStep, type UpkeepWork } from './databaseUpkeepWorker.ts';

/**
 * Scheduled database upkeep (ADR-0042). An hourly tick runs it once the last run is VANTAGE_DB_UPKEEP_HOURS old, so a
 * service restarted every day still runs it; never during maintenance, and never for a database held in memory.
 *
 * A worker thread checks the database for damage and folds in the write-ahead log without taking the write lock
 * (databaseUpkeepWorker.ts). Back on the service's own connection, the two steps that take the write lock run: the
 * statistics of every table where they have gone stale, and a checkpoint that empties the log. There they never meet the
 * service's own transactions, and the planner uses the new statistics at once. The run is kept beside the database and
 * audited. Damage tells the staff who view the platform and fails the health check until a later run finds none.
 */

export interface UpkeepRecord {
  at: string;
  /** done: every step ran and found no damage. damaged: the integrity check found problems. failed: the run stopped. */
  outcome: 'done' | 'damaged' | 'failed';
  problems: number;
  messages: string[];
  /** The tables whose statistics had gone stale and were refreshed. */
  analyzed: string[];
  /** The write-ahead log: pages folded in on the thread, and whether the log was emptied. Null without a log, or on damage. */
  checkpoint: { folded: number; emptied: boolean } | null;
  skipped: string[];
  error: string | null;
  /** The last damage a run found, kept through runs that stop before they can check again, until one finds none. */
  damage: { at: string; problems: number; message: string } | null;
  ms: number;
}

const KEY = 'database_upkeep';

/** The longest one run may take before its thread is stopped and the run recorded as failed. */
export const UPKEEP_TIMEOUT_MS = 60 * 60_000;

const inFlight = new WeakMap<AppContext, { worker: Worker; stopped: boolean }>();

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The integrity check lists at most MAX_PROBLEMS messages, so a count that reaches it is a lower bound. */
export const problemCount = (n: number) => (n >= MAX_PROBLEMS ? `at least ${plural(n, 'problem')}` : plural(n, 'problem'));

export function lastUpkeep(ctx: Pick<AppContext, 'db'>): UpkeepRecord | null {
  const raw = metaGet(ctx.db, KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as UpkeepRecord; } catch { return null; }
}

/** Whether a run is due: never for an in-memory database or during maintenance; else once the last is old enough. */
export function upkeepDue(ctx: AppContext, at = Date.now()): boolean {
  if (ctx.db.name === ':memory:' || ctx.runtime.maintenance) return false;
  const last = lastUpkeep(ctx);
  const when = last ? Date.parse(last.at) : Number.NaN;
  return !Number.isFinite(when) || at - when >= ctx.config.operations.upkeepHours * 3_600_000;
}

/** Whether an upkeep thread is still at work on this database, including one told to stop that is ending its step. */
export function upkeepRunning(ctx: AppContext): boolean {
  return inFlight.has(ctx);
}

const busy = (error: unknown) => String((error as { code?: string }).code ?? '').startsWith('SQLITE_BUSY');
const why = (error: unknown) => (busy(error) ? 'another process held the database, so it waits for the next run' : String((error as Error).message));

/**
 * The steps that take the write lock, on the service's own connection, so they never meet its transactions: the
 * statistics of every table where they have gone stale, each under SQLite's analysis limit, and a checkpoint that
 * empties the log. Neither waits for another process's lock; a lock held now leaves the step for the next run.
 */
export function upkeepOnServiceConnection(db: Database.Database, skipped: string[]): { analyzed: string[]; emptied: boolean | null } {
  const wait = Number(db.pragma('busy_timeout', { simple: true }));
  db.pragma('busy_timeout = 0');
  try {
    let analyzed: string[] = [];
    try {
      // 0x10003 lists what 0x10012 then runs: every table whose statistics are stale (0x10000 looks past the tables this
      // connection has used), each under the analysis limit (0x10).
      analyzed = (db.pragma('optimize(0x10003)') as Array<{ optimize: string }>)
        .map((r) => /^ANALYZE "main"\."(.+)"$/.exec(r.optimize)?.[1]?.replace(/""/g, '"'))
        .filter((t): t is string => Boolean(t));
      if (analyzed.length) db.pragma('optimize(0x10012)');
    } catch (error) {
      analyzed = [];
      skipped.push(`statistics: ${why(error)}`);
    }
    if (String(db.pragma('journal_mode', { simple: true })) !== 'wal') return { analyzed, emptied: null };
    try {
      const [truncate] = db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number }>;
      return { analyzed, emptied: Boolean(truncate && !truncate.busy && truncate.log === 0) };
    } catch (error) {
      skipped.push(`emptying the write-ahead log: ${why(error)}`);
      return { analyzed, emptied: false };
    }
  } finally {
    db.pragma(`busy_timeout = ${wait}`);
  }
}

const limitText = (ms: number) => (ms >= 60_000 ? plural(Math.round(ms / 60_000), 'minute') : plural(Math.max(1, Math.round(ms / 1000)), 'second'));

/**
 * Runs the work on its own thread. A thread cannot be stopped inside a call into SQLite: told to stop, it ends when that
 * step returns. So the time limit settles the run at once, naming the step it was in, and the thread stays in inFlight
 * until it has ended or closed its connection and handed back what it found, so no other run starts beside it.
 */
function workOffThread(ctx: AppContext, timeoutMs: number): Promise<UpkeepWork | null> {
  return new Promise((resolve, reject) => {
    let step: UpkeepStep | 'starting' = 'starting';
    let failure: Error | null = null;
    let settled = false;
    const worker = new Worker(new URL('./databaseUpkeepWorker.ts', import.meta.url), { workerData: { upkeep: ctx.db.name } });
    const entry = { worker, stopped: false };
    inFlight.set(ctx, entry);
    const settle = (finish: () => void) => { if (!settled) { settled = true; clearTimeout(timer); finish(); } };
    const timer = setTimeout(() => {
      if (entry.stopped) return;
      void worker.terminate();
      settle(() => reject(new Error(`it was still ${step} after ${limitText(timeoutMs)}, so it was told to stop; SQLite ends that step first`)));
    }, timeoutMs);
    timer.unref?.();
    const release = () => { if (inFlight.get(ctx) === entry) inFlight.delete(ctx); };
    worker.on('message', (message: { step: UpkeepStep } | { done: UpkeepWork }) => {
      if ('step' in message) { step = message.step; return; }
      // Its connection is closed before it hands back what it found.
      release();
      settle(() => resolve(message.done));
    });
    worker.once('error', (error) => { failure = error; });
    worker.once('exit', (code) => {
      release();
      settle(() => (entry.stopped ? resolve(null) : reject(failure ?? new Error(`it stopped before it finished (exit code ${code})`))));
    });
  });
}

function describe(r: UpkeepRecord): string {
  const parts: string[] = [];
  if (r.outcome === 'failed') {
    parts.push(`It stopped: ${r.error}.`);
    if (r.damage) parts.push(`The damage found on ${r.damage.at} has not been checked again.`);
  } else if (r.outcome === 'damaged') {
    parts.push(`SQLite's integrity check found ${problemCount(r.problems)}: ${r.messages[0] ?? 'no message'}.`);
  } else {
    parts.push('No damage found.');
    parts.push(r.analyzed.length ? `Statistics refreshed for ${plural(r.analyzed.length, 'table')}.` : 'Statistics current.');
    if (r.checkpoint) parts.push(r.checkpoint.emptied ? `Log emptied (${plural(r.checkpoint.folded, 'page')} folded in).` : `${plural(r.checkpoint.folded, 'page')} folded in; the log was in use, so it was left for the next run.`);
  }
  for (const s of r.skipped) parts.push(`Not run: ${s}.`);
  parts.push(r.ms < 1000 ? `${r.ms} ms.` : `${(r.ms / 1000).toFixed(1)} s.`);
  return parts.join(' ');
}

function record(ctx: AppContext, r: UpkeepRecord) {
  metaSet(ctx.db, KEY, JSON.stringify(r));
  audit(ctx, { actor_id: null, action: 'database_upkeep', entity: 'database', entity_id: r.outcome, detail: describe(r).slice(0, 900) });
}

/**
 * One run, now. Resolves with what it recorded, or null when the service stopped it, on the way down or as maintenance
 * began. Throws when the run stopped or found damage, after recording it, so the scheduled job shows the failure too.
 */
export async function runDatabaseUpkeep(ctx: AppContext, { timeoutMs = UPKEEP_TIMEOUT_MS } = {}): Promise<UpkeepRecord | null> {
  const at = now();
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  let work: UpkeepWork | null;
  try {
    work = await workOffThread(ctx, timeoutMs);
  } catch (error) {
    const r: UpkeepRecord = {
      at, outcome: 'failed', problems: 0, messages: [], analyzed: [], checkpoint: null, skipped: [],
      error: String((error as Error)?.message || error).slice(0, 300), damage: lastUpkeep(ctx)?.damage ?? null, ms: ms(),
    };
    record(ctx, r);
    throw new Error(`Database upkeep stopped: ${r.error}`);
  }
  // Maintenance began as the thread handed back its work: what is left waits for it to end, like the run.
  if (!work || ctx.runtime.maintenance) return null;
  const skipped = [...work.skipped];
  if (!work.integrity.ok) {
    const r: UpkeepRecord = {
      at, outcome: 'damaged', problems: work.integrity.problems, messages: work.integrity.messages, analyzed: [], checkpoint: null,
      skipped: [...skipped, 'statistics and the write-ahead log, left as they are on a damaged database'], error: null,
      damage: { at, problems: work.integrity.problems, message: work.integrity.messages[0] ?? '' }, ms: ms(),
    };
    record(ctx, r);
    notifyStaff(ctx, 'platform.view', {
      kind: 'system', title: 'The scheduled check found damage in the database',
      message: `SQLite's integrity check found ${problemCount(r.problems)}. Restore from the last good backup and raise it with the hosting team.`,
      actionUrl: '/admin/operations',
    });
    throw new Error(`SQLite's integrity check found ${problemCount(r.problems)} in the database`);
  }
  const { analyzed, emptied } = upkeepOnServiceConnection(ctx.db, skipped);
  const r: UpkeepRecord = {
    at, outcome: 'done', problems: 0, messages: work.integrity.messages, analyzed,
    checkpoint: emptied === null ? null : { folded: work.folded ?? 0, emptied }, skipped, error: null, damage: null, ms: ms(),
  };
  record(ctx, r);
  return r;
}

/** The hourly tick: runs the upkeep when it is due, never while a thread from an earlier run is still ending its step. */
export async function databaseUpkeepTick(ctx: AppContext, at = Date.now()): Promise<UpkeepRecord | null> {
  if (ctx.db.name === ':memory:' || ctx.runtime.maintenance || upkeepRunning(ctx) || !upkeepDue(ctx, at)) return null;
  return runDatabaseUpkeep(ctx);
}

/**
 * Stops a run in flight, as the service stops or maintenance begins: nothing is recorded, and the next tick after runs
 * it when it is due. The thread ends when SQLite returns from the step it is in.
 */
export function stopDatabaseUpkeep(ctx: AppContext) {
  const entry = inFlight.get(ctx);
  if (!entry) return;
  entry.stopped = true;
  void entry.worker.terminate();
}
