import { statfsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import type { AppContext, MaintenanceWindow, SessionUser } from '../context.ts';
import { badRequest, conflict } from '../lib/errors.ts';
import { now } from '../lib/ids.ts';
import { pruneSessions } from '../auth/sessions.ts';
import { audit, verifyAuditChain } from './audit.ts';
import { verifyAllCases } from './caseSeal.ts';
import { notifyStaff } from './notifications.ts';

/**
 * Controlled maintenance (ADR-0011): closing the service to everyone but Vantage staff, always with a reason, and the
 * database tasks a Vantage Administrator may run from the console. Each start, end and task is audited, and the other
 * staff are told when the service closes and opens again. Nothing here reads a record: the tasks work on the database's
 * structure and report counts.
 */

/** The longest a planned end may lie ahead. Maintenance itself ends only when somebody ends it. */
export const MAINTENANCE_MAX_HOURS = 7 * 24;

export interface MaintenanceStart { reason: string; message?: string | null; until?: string | null }

const nameOf = (user: SessionUser) => `${user.first_name} ${user.last_name}`.trim() || user.username;

const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** What everyone else is told while maintenance is on: on the sign-in page and in every refused request. */
export function maintenanceNotice(ctx: AppContext): string {
  const window = ctx.runtime.maintenanceWindow;
  const said = window?.message ? sentence(window.message) : 'Vantage is in scheduled maintenance.';
  if (!window?.until) return `${said} Try again shortly.`;
  const by = new Date(window.until).toLocaleString('en-US', { timeZone: ctx.config.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `${said} It is expected to end by ${by}.`;
}

/** The part of the window anyone may see before signing in: never the reason, which is for staff and the audit trail. */
export function publicMaintenance(ctx: AppContext) {
  if (!ctx.runtime.maintenance) return null;
  return { message: maintenanceNotice(ctx), until: ctx.runtime.maintenanceWindow?.until ?? null };
}

export function startMaintenance(ctx: AppContext, actor: SessionUser, input: MaintenanceStart, ip?: string | null): MaintenanceWindow {
  if (ctx.runtime.maintenance) throw conflict('Maintenance is already on. End it before starting another window.', 'maintenance_on');
  const reason = input.reason.trim();
  if (reason.length < 10) throw badRequest('Say why the service is closing, in at least ten characters. It goes in the audit trail.', { fieldErrors: { reason: 'At least ten characters.' } });
  let until: string | null = null;
  if (input.until) {
    const at = Date.parse(input.until);
    if (!Number.isFinite(at)) throw badRequest('The expected end is not a date and time.', { fieldErrors: { until: 'Not a date and time.' } });
    if (at <= Date.now()) throw badRequest('The expected end has already passed.', { fieldErrors: { until: 'Pick a time ahead.' } });
    if (at > Date.now() + MAINTENANCE_MAX_HOURS * 3_600_000) throw badRequest('Plan the end within a week. Maintenance stays on until somebody ends it, whatever the plan said.', { fieldErrors: { until: 'Within a week.' } });
    until = new Date(at).toISOString();
  }
  const window: MaintenanceWindow = { reason, message: input.message?.trim() || null, until, startedAt: now(), startedBy: actor.id, startedByName: nameOf(actor) };
  ctx.runtime.maintenance = true;
  ctx.runtime.maintenanceWindow = window;
  ctx.saveRuntime();
  audit(ctx, { actor_id: actor.id, action: 'maintenance_on', entity: 'platform', detail: `${reason}${until ? `; expected end ${until}` : ''}`, ip });
  notifyStaff(ctx, 'platform.view', { kind: 'system', title: `${window.startedByName} closed Vantage for maintenance`, message: `${reason} Only Vantage staff can sign in until it ends.`, actionUrl: '/admin/maintenance' }, actor.id);
  return window;
}

/** Ends maintenance. Ending it when it is already off changes nothing and records nothing. */
export function endMaintenance(ctx: AppContext, actor: SessionUser, note: string | null, ip?: string | null) {
  if (!ctx.runtime.maintenance) return { changed: false, minutes: null };
  const window = ctx.runtime.maintenanceWindow;
  const minutes = window ? Math.max(0, Math.round((Date.now() - Date.parse(window.startedAt)) / 60_000)) : null;
  ctx.runtime.maintenance = false;
  ctx.runtime.maintenanceWindow = null;
  ctx.saveRuntime();
  const said = note?.trim() || null;
  audit(ctx, { actor_id: actor.id, action: 'maintenance_off', entity: 'platform', detail: [minutes === null ? null : `after ${minutes} min`, said].filter(Boolean).join('; ') || null, ip });
  notifyStaff(ctx, 'platform.view', { kind: 'system', title: `${nameOf(actor)} opened Vantage again`, message: said ?? (minutes === null ? null : `Maintenance lasted ${minutes} minute${minutes === 1 ? '' : 's'}.`), actionUrl: '/admin/maintenance' }, actor.id);
  return { changed: true, minutes };
}

export interface TaskResult { ok: boolean; summary: string; detail: string[] }

interface MaintenanceTask {
  label: string;
  hint: string;
  /** Holds the database for its whole run, so it waits for maintenance mode. */
  needsMaintenance: boolean;
  run: (ctx: AppContext) => TaskResult;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The only work the console runs on the database: an allowlist, never a statement typed in. Each reports what it found
 * as counts and table names.
 */
export const MAINTENANCE_TASKS: Record<string, MaintenanceTask> = {
  database_check: {
    label: 'Check the database for damage',
    hint: 'Reads every page and index of the database file and reports corruption. Changes nothing.',
    needsMaintenance: false,
    run: (ctx) => {
      const rows = (ctx.db.pragma('quick_check') as Array<{ quick_check: string }>).map((r) => r.quick_check);
      const ok = rows.length === 1 && rows[0] === 'ok';
      return { ok, summary: ok ? 'No damage found.' : `${plural(rows.length, 'problem')} found. Restore from the last good backup and raise it with the hosting team.`, detail: ok ? [] : rows.slice(0, 20) };
    },
  },
  foreign_keys: {
    label: 'Check references between tables',
    hint: 'Finds rows that point at something that no longer exists. Changes nothing.',
    needsMaintenance: false,
    run: (ctx) => {
      const rows = ctx.db.pragma('foreign_key_check') as Array<{ table: string; parent: string }>;
      const byTable = new Map<string, number>();
      for (const r of rows) byTable.set(`${r.table} → ${r.parent}`, (byTable.get(`${r.table} → ${r.parent}`) ?? 0) + 1);
      return { ok: rows.length === 0, summary: rows.length ? `${plural(rows.length, 'broken reference')} in ${plural(byTable.size, 'table pair')}.` : 'Every reference resolves.', detail: [...byTable].map(([pair, n]) => `${pair}: ${n}`) };
    },
  },
  checkpoint: {
    label: 'Fold the write-ahead log into the database',
    hint: 'Copies committed changes from the log into the database file and empties the log. Safe while people work.',
    needsMaintenance: false,
    run: (ctx) => {
      const [r] = ctx.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number; checkpointed: number }>;
      if (!r || r.log < 0) return { ok: true, summary: 'This database keeps no write-ahead log.', detail: [] };
      if (r.busy) return { ok: false, summary: `Another connection held the database; ${r.checkpointed} of ${plural(r.log, 'page')} were folded in. Try again.`, detail: [] };
      return { ok: true, summary: `${plural(r.checkpointed, 'page')} folded in; the log is empty.`, detail: [] };
    },
  },
  optimize: {
    label: 'Refresh the query statistics',
    hint: 'Updates what the database knows about its tables where that has gone stale, so queries keep choosing good plans.',
    needsMaintenance: false,
    run: (ctx) => { ctx.db.pragma('optimize'); return { ok: true, summary: 'Query statistics refreshed.', detail: [] }; },
  },
  prune_sessions: {
    label: 'Clear expired sessions',
    hint: 'Removes sessions and one-time links that have expired. Nobody who is signed in is signed out.',
    needsMaintenance: false,
    run: (ctx) => {
      const count = () => (ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
      const before = count();
      pruneSessions(ctx);
      return { ok: true, summary: `${plural(before - count(), 'expired session')} removed.`, detail: [] };
    },
  },
  verify_integrity: {
    label: 'Verify the audit trail and case histories',
    hint: 'Recomputes the audit trail’s chain and every case history’s seal. Changes nothing.',
    needsMaintenance: false,
    run: (ctx) => {
      const chain = verifyAuditChain(ctx);
      const cases = verifyAllCases(ctx);
      return {
        ok: chain.ok && cases.ok,
        summary: `Audit trail ${chain.ok ? `intact across ${plural(chain.count, 'entry', 'entries')}` : `broken: ${chain.reason}`}. ${plural(cases.checked, 'case history', 'case histories')} checked, ${cases.broken.length} broken, ${cases.unsealed} not yet sealed.`,
        detail: [],
      };
    },
  },
  vacuum: {
    label: 'Compact the database',
    hint: 'Rebuilds the database file to give back the space deleted rows left behind. It holds the database for the whole run and needs free disk of about twice the database, so it runs only during maintenance.',
    needsMaintenance: true,
    run: (ctx) => {
      if (ctx.db.name === ':memory:') return { ok: true, summary: 'An in-memory database has nothing to compact.', detail: [] };
      const before = statSync(ctx.db.name).size;
      // VACUUM builds its working copy in SQLite's temporary folder, then writes it back through the write-ahead log
      // beside the database: about the database's size in each place, twice it when they share a disk.
      const home = dirname(ctx.db.name);
      const temp = process.env.SQLITE_TMPDIR || tmpdir();
      const needs: Array<[string, string, number]> = statSync(home).dev === statSync(temp).dev
        ? [[home, 'beside the database', before * 2.2]]
        : [[home, 'beside the database', before * 1.2], [temp, `in ${temp}`, before * 1.2]];
      for (const [dir, where, need] of needs) {
        const disk = statfsSync(dir);
        const free = disk.bavail * disk.bsize;
        if (free < need) return { ok: false, summary: `Not run: compacting needs about ${Math.ceil(need / 1_048_576)} MB free ${where}, and there are ${Math.floor(free / 1_048_576)} MB.`, detail: [] };
      }
      // The connection keeps temporary tables in memory; for this run the working copy goes to disk instead, so a large
      // database is not copied into the server's memory.
      const tempStore = ctx.db.pragma('temp_store', { simple: true }) as number;
      ctx.db.pragma('temp_store = FILE');
      try { ctx.db.exec('VACUUM'); } finally { ctx.db.pragma(`temp_store = ${Number(tempStore)}`); }
      ctx.db.pragma('wal_checkpoint(TRUNCATE)');
      const after = statSync(ctx.db.name).size;
      return { ok: true, summary: `The database file went from ${Math.round(before / 1024)} KB to ${Math.round(after / 1024)} KB.`, detail: [] };
    },
  },
};

export function runMaintenanceTask(ctx: AppContext, actor: SessionUser, key: string, ip?: string | null) {
  const task = Object.hasOwn(MAINTENANCE_TASKS, key) ? MAINTENANCE_TASKS[key] : null;
  if (!task) throw badRequest('No such maintenance task.', { code: 'unknown_task' });
  if (task.needsMaintenance && !ctx.runtime.maintenance) throw conflict(`${task.label} runs only during maintenance. Start maintenance first.`, 'maintenance_required');
  const started = performance.now();
  let result: TaskResult;
  try { result = task.run(ctx); } catch (error) { result = { ok: false, summary: `It stopped: ${(error as Error).message}`.slice(0, 300), detail: [] }; }
  const ms = Math.round(performance.now() - started);
  audit(ctx, { actor_id: actor.id, action: 'maintenance_task', entity: 'database', entity_id: key, detail: `${key}: ${result.ok ? 'ok' : 'attention'}; ${result.summary}`.slice(0, 900), ip });
  return { task: key, label: task.label, ...result, ms, at: now() };
}

/** What the Maintenance page shows: the window, the tasks, and the most recent maintenance steps from the platform trail. */
export function maintenanceState(ctx: AppContext) {
  const history = ctx.db.prepare(`SELECT al.at, al.action, al.entity_id AS task, al.detail, u.first_name || ' ' || u.last_name AS actor
      FROM audit_log al LEFT JOIN users u ON u.id = al.actor_id
     WHERE al.org_id IS NULL AND al.unit_id IS NULL AND al.action IN ('maintenance_on', 'maintenance_off', 'maintenance_task')
     ORDER BY al.seq DESC LIMIT 30`).all();
  return {
    maintenance: ctx.runtime.maintenance,
    window: ctx.runtime.maintenanceWindow,
    notice: ctx.runtime.maintenance ? maintenanceNotice(ctx) : null,
    overrun: Boolean(ctx.runtime.maintenance && ctx.runtime.maintenanceWindow?.until && Date.parse(ctx.runtime.maintenanceWindow.until) < Date.now()),
    maxHours: MAINTENANCE_MAX_HOURS,
    tasks: Object.entries(MAINTENANCE_TASKS).map(([key, t]) => ({ key, label: t.label, hint: t.hint, needsMaintenance: t.needsMaintenance })),
    history,
  };
}
