import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppContext } from '../context.ts';
import { metaGet, metaSet, migrationHistory, MIGRATION_CATALOG, SCHEMA_VERSION } from '../db/index.ts';
import { VERSION } from '../version.ts';
import { now } from '../lib/ids.ts';
import { verifyAuditChain } from './audit.ts';
import { auditForwardingStatus } from './auditSink.ts';
import { backupHistory } from './backupLog.ts';
import { signInChecks } from './signInHealth.ts';
import { seatedOrgRole } from '../authz/scope.ts';

/**
 * The service's operational state for the Vantage Administrator console (ADR-0011): which build runs, whether the
 * database's schema matches it, when it was last backed up, whether the scheduled jobs run, and a health report over all
 * of it. Everything here describes the service. No Unit Instance's records are read: counts of rows at most.
 */

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'info';
export interface HealthCheck { id: string; label: string; status: HealthStatus; summary: string }

const worst = (statuses: HealthStatus[]): HealthStatus => (statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'ok');
const parse = <T>(raw: string | null, fallback: T): T => { try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };

// ——— Releases ———

export interface Release { version: string; build: string; client: string | null; firstStartedAt: string }
const RELEASES_KEPT = 20;
const running = new WeakMap<AppContext, { build: string; client: string | null; startedAt: string }>();

/** Notes the build this process serves, and adds it to the database's release history when it differs from the last. */
export function recordRelease(ctx: AppContext, { build, client }: { build: string; client: string | null }) {
  const startedAt = now();
  running.set(ctx, { build, client, startedAt });
  const history = releaseHistory(ctx);
  const last = history.at(-1);
  if (last && last.version === VERSION && last.build === build) return;
  metaSet(ctx.db, 'release_history', JSON.stringify([...history, { version: VERSION, build, client, firstStartedAt: startedAt }].slice(-RELEASES_KEPT)));
}

export function releaseHistory(ctx: AppContext): Release[] {
  const list = parse<unknown>(metaGet(ctx.db, 'release_history'), []);
  return Array.isArray(list) ? (list as Release[]) : [];
}

export function versionStatus(ctx: AppContext) {
  const self = running.get(ctx);
  const releases = releaseHistory(ctx);
  return {
    version: VERSION,
    build: self?.build ?? VERSION,
    client: self?.client ?? null,
    node: process.version,
    startedAt: self?.startedAt ?? null,
    uptime: Math.round(process.uptime()),
    releases: releases.slice(-10).reverse(),
  };
}

// ——— Schema and migrations ———

export function migrationStatus(ctx: AppContext) {
  const database = Number(metaGet(ctx.db, 'schema_version') || 0);
  const history = migrationHistory(ctx.db);
  const byId = new Map(history.map((run) => [run.id, run]));
  const since = parse<{ at: string; schema: number } | null>(metaGet(ctx.db, 'migration_history_since'), null);
  const orgs = parse<{ at?: string; organizations?: number } | null>(metaGet(ctx.db, 'org_migration'), null);
  const boundary = parse<{ at?: string; found?: Record<string, number> } | null>(metaGet(ctx.db, 'instance_boundary_violations'), null);
  const notes: string[] = [];
  if (orgs?.at) notes.push(`Unit Instances were introduced on ${orgs.at.slice(0, 10)}; ${orgs.organizations ?? 0} were made from the units that existed then.`);
  if (boundary?.found && Object.keys(boundary.found).length) {
    const total = Object.values(boundary.found).reduce((n, v) => n + Number(v || 0), 0);
    notes.push(`${total} rows were already joined across a Unit Instance boundary when isolation began (${Object.keys(boundary.found).join(', ')}). They were kept; only new crossings are refused.`);
  }
  return {
    code: SCHEMA_VERSION,
    database,
    state: database === SCHEMA_VERSION ? 'current' : database < SCHEMA_VERSION ? 'behind' : 'ahead',
    historySince: since,
    catalog: MIGRATION_CATALOG.map((m) => ({ ...m, applied: m.id <= database, run: byId.get(m.id) ?? null })),
    notes,
  };
}

// ——— Backups ———

/** The last backups Vantage knows of, and whether the newest is within VANTAGE_BACKUP_MAX_AGE_HOURS. */
export function backupStatus(ctx: AppContext, at = Date.now()) {
  const history = backupHistory(ctx.db);
  const last = history.at(-1) ?? null;
  const maxAgeHours = ctx.config.operations.backupMaxAgeHours;
  const ageHours = last ? Math.max(0, (at - Date.parse(last.at)) / 3_600_000) : null;
  const archive = (action: string) => (ctx.db.prepare('SELECT MAX(at) AS at FROM audit_log WHERE action = ? AND org_id IS NULL AND unit_id IS NULL').get(action) as { at: string | null }).at;
  return {
    state: !last ? 'never' : (ageHours ?? 0) > maxAgeHours ? 'stale' : 'fresh',
    last,
    ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    maxAgeHours,
    browserBackups: ctx.config.security.browserBackups,
    history: [...history].reverse(),
    lastArchiveExport: archive('instance_export'),
    lastArchiveImport: archive('instance_import'),
  };
}

// ——— Scheduled jobs ———

export interface JobState {
  name: string; label: string; everyMs: number; runs: number; failures: number; consecutiveFailures: number;
  lastRunAt: string | null; lastOkAt: string | null; lastError: string | null; lastMs: number | null; registeredAt: string;
}
const jobs = new WeakMap<AppContext, Map<string, JobState>>();

/**
 * Wraps a scheduled job so the console can say when it last ran and whether it failed. A failure is logged as it always
 * was and kept, shortened, for the console; the job runs again on its next tick.
 */
export function trackedJob(ctx: AppContext, name: string, label: string, everyMs: number, fn: () => unknown): () => Promise<void> {
  if (!jobs.has(ctx)) jobs.set(ctx, new Map());
  const state: JobState = { name, label, everyMs, runs: 0, failures: 0, consecutiveFailures: 0, lastRunAt: null, lastOkAt: null, lastError: null, lastMs: null, registeredAt: now() };
  jobs.get(ctx)!.set(name, state);
  return async () => {
    const started = performance.now();
    state.lastRunAt = now();
    try {
      await fn();
      state.lastOkAt = now();
      state.consecutiveFailures = 0;
      state.lastError = null;
    } catch (error) {
      state.failures += 1;
      state.consecutiveFailures += 1;
      state.lastError = String((error as Error)?.message || error).slice(0, 300);
      console.warn(`${label} failed: ${state.lastError}`);
    } finally {
      state.runs += 1;
      state.lastMs = Math.round(performance.now() - started);
    }
  };
}

export function jobStatus(ctx: AppContext, at = Date.now()) {
  return [...(jobs.get(ctx)?.values() ?? [])].map((job) => {
    // Twice the interval and a minute's grace: a job later than that is not running.
    const due = Date.parse(job.lastRunAt ?? job.registeredAt) + job.everyMs * 2 + 60_000;
    const overdue = at > due;
    return { ...job, overdue, status: (job.consecutiveFailures || overdue ? 'warn' : 'ok') as HealthStatus };
  });
}

/** For tests: forget the jobs registered against a context. */
export function clearJobs(ctx: AppContext) { jobs.delete(ctx); }

// ——— Health ———

const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} MB`;

function databaseCheck(ctx: AppContext): HealthCheck {
  try { ctx.db.prepare('SELECT 1').get(); } catch (e) { return { id: 'database', label: 'Database', status: 'fail', summary: `The database does not answer: ${(e as Error).message}` }; }
  const pages = ctx.db.pragma('page_count', { simple: true }) as number;
  const pageSize = ctx.db.pragma('page_size', { simple: true }) as number;
  const size = pages * pageSize;
  const max = ctx.config.limits.maxDatabaseBytes;
  const share = size / max;
  return {
    id: 'database', label: 'Database',
    status: share >= 1 ? 'fail' : share >= 0.8 ? 'warn' : 'ok',
    summary: share >= 1 ? `${mb(size)}, at its ${mb(max)} safety threshold: new records are paused. Raise VANTAGE_MAX_DB_BYTES or compact the database.`
      : `${mb(size)} of the ${mb(max)} safety threshold (${Math.round(share * 100)}%).`,
  };
}

function diskCheck(ctx: AppContext): HealthCheck | null {
  if (ctx.db.name === ':memory:') return null;
  try {
    const disk = statfsSync(dirname(ctx.db.name));
    const free = disk.bavail * disk.bsize;
    const share = free / (disk.blocks * disk.bsize);
    return { id: 'disk', label: 'Disk', status: share < 0.05 ? 'fail' : share < 0.15 ? 'warn' : 'ok', summary: `${mb(free)} free where the database lives (${Math.round(share * 100)}%).` };
  } catch (e) { return { id: 'disk', label: 'Disk', status: 'warn', summary: `Free space could not be read: ${(e as Error).message}` }; }
}

function auditChecks(ctx: AppContext, verified?: ReturnType<typeof verifyAuditChain>): HealthCheck[] {
  const chain = verified ?? verifyAuditChain(ctx);
  const checks: HealthCheck[] = [{ id: 'audit_chain', label: 'Audit trail', status: chain.ok ? 'ok' : 'fail', summary: chain.ok ? `Intact across ${chain.count} entries.` : `Broken: ${chain.reason}.` }];
  const forwarding = auditForwardingStatus(ctx);
  const mcen = ctx.config.deployment.profile === 'mcen';
  if (forwarding.syslog) {
    const s = forwarding.syslog;
    const trouble = !s.connected || s.dropped > 0;
    checks.push({ id: 'audit_forwarding', label: 'Audit forwarding', status: trouble ? 'warn' : 'ok', summary: `${s.transport.toUpperCase()} to ${s.target}: ${s.connected ? 'connected' : 'not connected'}, ${s.sent} sent, ${s.queued} waiting, ${s.dropped} dropped.${s.lastError ? ` Last error: ${s.lastError}` : ''}` });
  } else if (forwarding.stdout) checks.push({ id: 'audit_forwarding', label: 'Audit forwarding', status: 'ok', summary: 'Each entry is written to standard output for the host’s log collector.' });
  else checks.push({ id: 'audit_forwarding', label: 'Audit forwarding', status: mcen ? 'warn' : 'info', summary: 'Audit entries stay in the database only. Set VANTAGE_AUDIT_SYSLOG or VANTAGE_AUDIT_STDOUT to send them to the SIEM.' });
  return checks;
}

function backupCheck(ctx: AppContext, at: number): HealthCheck {
  const b = backupStatus(ctx, at);
  if (b.state === 'never') return { id: 'backup', label: 'Backups', status: 'warn', summary: 'Vantage has no record of a backup. Take one with npm run backup on the server; copies the hosting environment makes on its own do not show here.' };
  const age = b.ageHours! < 48 ? `${Math.round(b.ageHours!)} hours` : `${Math.round(b.ageHours! / 24)} days`;
  return { id: 'backup', label: 'Backups', status: b.state === 'stale' ? 'warn' : 'ok', summary: `Last backup ${age} ago (${b.last!.method === 'server' ? 'on the server' : 'downloaded from the console'}). The service expects one every ${b.maxAgeHours} hours.` };
}

function emailCheck(ctx: AppContext, at: number): HealthCheck {
  if (!ctx.mailer.enabled) return { id: 'email', label: 'Email', status: 'info', summary: 'No mail relay is set, so nothing is sent by email.' };
  const since = new Date(at - 86_400_000).toISOString();
  const failed = (ctx.db.prepare("SELECT COUNT(*) AS n FROM email_log WHERE status = 'failed' AND created_at >= ?").get(since) as { n: number }).n;
  const sent = (ctx.db.prepare("SELECT COUNT(*) AS n FROM email_log WHERE status = 'sent' AND created_at >= ?").get(since) as { n: number }).n;
  const queue = ctx.db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM email_queue').get() as { n: number; oldest: string | null };
  const stuck = queue.oldest !== null && at - Date.parse(queue.oldest) > 6 * 3_600_000;
  return {
    id: 'email', label: 'Email',
    status: failed > sent && failed > 0 ? 'warn' : stuck ? 'warn' : 'ok',
    summary: `Last 24 hours: ${sent} sent, ${failed} failed. ${queue.n ? `${queue.n} waiting to retry${stuck ? ', the oldest for more than six hours' : ''}.` : 'Nothing waiting.'}`,
  };
}

function jobsCheck(ctx: AppContext, at: number): HealthCheck {
  const list = jobStatus(ctx, at);
  if (!list.length) return { id: 'jobs', label: 'Scheduled jobs', status: 'warn', summary: 'No scheduled jobs run in this process. Expired access, sessions and queued mail are not being swept.' };
  const failing = list.filter((j) => j.consecutiveFailures);
  const overdue = list.filter((j) => j.overdue);
  return {
    id: 'jobs', label: 'Scheduled jobs',
    status: failing.length || overdue.length ? 'warn' : 'ok',
    summary: failing.length ? `${failing.map((j) => j.label).join(', ')} failed on the last run.` : overdue.length ? `${overdue.map((j) => j.label).join(', ')} ${overdue.length === 1 ? 'is' : 'are'} overdue.` : `${list.length} jobs running on schedule.`,
  };
}

function maintenanceCheck(ctx: AppContext, at: number): HealthCheck | null {
  if (!ctx.runtime.maintenance) return null;
  const w = ctx.runtime.maintenanceWindow;
  const over = w?.until && Date.parse(w.until) < at;
  return { id: 'maintenance', label: 'Maintenance', status: 'warn', summary: `On${w ? ` since ${w.startedAt.slice(0, 16).replace('T', ' ')} UTC, started by ${w.startedByName}` : ''}. Only Vantage staff can sign in.${over ? ' It has run past its expected end.' : ''}` };
}

function instanceChecks(ctx: AppContext): HealthCheck[] {
  const leaderless = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM organizations o WHERE o.status = 'active' AND NOT EXISTS (
      SELECT 1 FROM org_roles r JOIN users u ON u.id = r.user_id
       WHERE r.org_id = o.id AND r.role = 'owner' AND u.active = 1 AND (r.expires_at IS NULL OR r.expires_at > ?) AND ${seatedOrgRole('r')})`).get(now()) as { n: number }).n;
  const checks: HealthCheck[] = [];
  if (leaderless) checks.push({ id: 'instances', label: 'Unit Instances', status: 'warn', summary: `${leaderless} active Unit Instance${leaderless === 1 ? ' has' : 's have'} no Lead Unit Manager. Name one from Unit Instances.` });
  return checks;
}

function schemaCheck(ctx: AppContext): HealthCheck {
  const m = migrationStatus(ctx);
  if (m.state === 'ahead') return { id: 'schema', label: 'Schema', status: 'warn', summary: `The database is at schema ${m.database}, ahead of this build's ${m.code}: a newer build migrated it. Run that build, or restore the backup taken before the upgrade.` };
  if (m.state === 'behind') return { id: 'schema', label: 'Schema', status: 'fail', summary: `The database is at schema ${m.database} and this build needs ${m.code}. Restart to migrate it.` };
  return { id: 'schema', label: 'Schema', status: 'ok', summary: `Schema ${m.code}, current.` };
}

/** Every check, worst first, and the service's status: the worst of them. Informational notes never lower it. */
export function healthReport(ctx: AppContext, at = Date.now(), { chain }: { chain?: ReturnType<typeof verifyAuditChain> } = {}) {
  const checks = [
    databaseCheck(ctx), diskCheck(ctx), schemaCheck(ctx), ...auditChecks(ctx, chain), backupCheck(ctx, at), emailCheck(ctx, at),
    jobsCheck(ctx, at), ...signInChecks(ctx, at), maintenanceCheck(ctx, at), ...instanceChecks(ctx),
  ].filter((c): c is HealthCheck => Boolean(c));
  const rank: Record<HealthStatus, number> = { fail: 0, warn: 1, info: 2, ok: 3 };
  const memory = process.memoryUsage();
  return {
    checkedAt: new Date(at).toISOString(),
    status: worst(checks.map((c) => c.status)),
    checks: checks.map((c, i) => ({ c, i })).sort((a, b) => rank[a.c.status] - rank[b.c.status] || a.i - b.i).map(({ c }) => c),
    process: { uptime: Math.round(process.uptime()), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
  };
}
