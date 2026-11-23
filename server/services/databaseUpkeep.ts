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
 * service restarted every day still runs it; never during maintenance, and never for a database held in memory. A worker
 * thread checks the database for damage, refreshes stale query statistics and empties the write-ahead log
 * (databaseUpkeepWorker.ts). Back here, the service's connection takes up the new statistics, and the run is kept beside
 * the database and audited. Damage found tells the staff who view the platform and fails the health check until a later
 * run finds none.
 */

export interface UpkeepRecord {
  at: string;
  /** done: every step ran and found no damage. damaged: the integrity check found problems. failed: the run stopped. */
  outcome: 'done' | 'damaged' | 'failed';
  problems: number;
  messages: string[];
  analyzed: string[];
  /** Whether the service's connection has taken up the refreshed statistics. Each hourly tick tries again until it has. */
  reloaded: boolean;
  checkpoint: UpkeepWork['checkpoint'];
  skipped: string[];
  error: string | null;
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

/**
 * Has this connection read the statistics another connection wrote: until then its planner keeps the ones it loaded.
 * The reload takes the write lock for a moment, so it does not wait for it. When another process holds it, false, and
 * the next tick tries again.
 */
export function reloadStatistics(db: Database.Database): boolean {
  const wait = Number(db.pragma('busy_timeout', { simple: true }));
  db.pragma('busy_timeout = 0');
  try {
    db.exec('ANALYZE sqlite_schema');
    return true;
  } catch (error) {
    if (String((error as { code?: string }).code ?? '').startsWith('SQLITE_BUSY')) return false;
    throw error;
  } finally {
    db.pragma(`busy_timeout = ${wait}`);
  }
}

/** Whether an upkeep thread is still at work on this database, including one told to stop that is ending its step. */
export function upkeepRunning(ctx: AppContext): boolean {
  return inFlight.has(ctx);
}

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
      const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
      settle(() => reject(new Error(`it was still ${step} after ${plural(minutes, 'minute')}, so it was told to stop; SQLite ends that step first`)));
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
  if (r.outcome === 'failed') parts.push(`It stopped: ${r.error}.`);
  else if (r.outcome === 'damaged') parts.push(`SQLite's integrity check found ${problemCount(r.problems)}: ${r.messages[0] ?? 'no message'}.`);
  else parts.push('No damage found.');
  if (r.outcome !== 'failed') {
    parts.push(r.analyzed.length ? `Statistics refreshed for ${plural(r.analyzed.length, 'table')}${r.reloaded ? '' : ', taken up on a later tick'}.` : 'Statistics current.');
    if (r.checkpoint) parts.push(r.checkpoint.emptied ? `Log emptied (${plural(r.checkpoint.folded, 'page')} folded in).` : `${plural(r.checkpoint.folded, 'page')} of ${r.checkpoint.pages} folded in; the log was in use, so it was left for the next run.`);
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
 * One run, now. Resolves with what it recorded, or null when the service stopped it on the way down. Throws when the run
 * stopped or found damage, after recording it, so the scheduled job shows the failure too.
 */
export async function runDatabaseUpkeep(ctx: AppContext, { timeoutMs = UPKEEP_TIMEOUT_MS } = {}): Promise<UpkeepRecord | null> {
  const at = now();
  const started = performance.now();
  let work: UpkeepWork | null;
  try {
    work = await workOffThread(ctx, timeoutMs);
  } catch (error) {
    const r: UpkeepRecord = {
      at, outcome: 'failed', problems: 0, messages: [], analyzed: [], reloaded: true, checkpoint: null, skipped: [],
      error: String((error as Error)?.message || error).slice(0, 300), ms: Math.round(performance.now() - started),
    };
    record(ctx, r);
    throw new Error(`Database upkeep stopped: ${r.error}`);
  }
  if (!work) return null;
  // What the thread found is kept whatever happens here: a reload that fails is retried on the next tick.
  const skipped = [...work.skipped];
  let reloaded = true;
  if (work.analyzed.length) {
    try { reloaded = reloadStatistics(ctx.db); } catch (error) { reloaded = false; skipped.push(`taking up the new statistics: ${(error as Error).message}`); }
  }
  const r: UpkeepRecord = {
    at, outcome: work.integrity.ok ? 'done' : 'damaged', problems: work.integrity.problems, messages: work.integrity.messages,
    analyzed: work.analyzed, reloaded, checkpoint: work.checkpoint, skipped, error: null, ms: work.ms,
  };
  record(ctx, r);
  if (r.outcome === 'damaged') {
    notifyStaff(ctx, 'platform.view', {
      kind: 'system', title: 'The scheduled check found damage in the database',
      message: `SQLite's integrity check found ${problemCount(r.problems)}. Restore from the last good backup and raise it with the hosting team.`,
      actionUrl: '/admin/operations',
    });
    throw new Error(`SQLite's integrity check found ${problemCount(r.problems)} in the database`);
  }
  return r;
}

/**
 * The hourly tick: takes up statistics an earlier run left waiting, then runs the upkeep when it is due. Never while a
 * thread from an earlier run is still ending its step.
 */
export async function databaseUpkeepTick(ctx: AppContext, at = Date.now()): Promise<UpkeepRecord | null> {
  if (ctx.db.name === ':memory:' || ctx.runtime.maintenance || upkeepRunning(ctx)) return null;
  const last = lastUpkeep(ctx);
  // The run that left them recorded why; until the reload works, the run goes on as due.
  let reloadedNow = false;
  if (last && !last.reloaded) { try { reloadedNow = reloadStatistics(ctx.db); } catch { reloadedNow = false; } }
  if (last && reloadedNow) metaSet(ctx.db, KEY, JSON.stringify({ ...last, reloaded: true }));
  if (!upkeepDue(ctx, at)) return null;
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
