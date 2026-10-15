import type { AppContext } from '../context.ts';
import { metaGet, SCHEMA_VERSION } from '../db/index.ts';
import { upgradeHistory, type CountChange, type UpgradeRecord } from '../db/upgrades.ts';
import { VERSION } from '../version.ts';
import { now } from '../lib/ids.ts';
import { seatedOrgRole } from '../authz/scope.ts';
import { backupHistory } from './backupLog.ts';
import { restoreHistory, type RestoreRecord } from './restoreLog.ts';
import { healthReport, releaseHistory, versionStatus, type HealthCheck, type HealthStatus } from './operations.ts';
import { withheldFlags, type WithheldFlag } from './instanceFlags.ts';

/**
 * Operations for each Unit Instance (ADR-0014): the version of Vantage it runs and since when, its schema, its last
 * upgrade and whether that upgrade kept its rows, its health, how fresh the backup holding it is, its last restore, and
 * any feature Vantage turned off for it. In a shared deployment every Unit Instance runs the service's one build and
 * schema, so those agree across the list; what differs is what each one went through and holds. In a dedicated
 * deployment the list is of one, and the fleet view comes from each deployment's `npm run operations-report` (I-13).
 * Counts and dates only: nothing here reads a Unit Instance's records.
 */

const worst = (statuses: HealthStatus[]): HealthStatus => (statuses.includes('fail') ? 'fail' : statuses.includes('warn') ? 'warn' : 'ok');
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : 'an unknown day');
/** How long a restore or a replacement of the database shows in the health checks. */
export const RECENT_RESTORE_DAYS = 14;

export type UpgradeState = 'current' | 'attention' | 'failed' | 'ahead' | 'behind';
export type BackupState = 'fresh' | 'stale' | 'never' | 'not_yet';

interface Org { id: string; slug: string; name: string; short_name: string | null; status: string; suspended_reason: string | null; created_at: string }

export interface InstanceOperations {
  id: string; slug: string; name: string; short_name: string | null; status: string; created_at: string;
  version: { version: string; build: string; since: string };
  schema: { database: number; code: number; state: 'current' | 'behind' | 'ahead' };
  upgrade: {
    state: UpgradeState;
    /** The newest upgrade this Unit Instance has been through: a new build, a schema migration, or both. */
    last: { at: string; release: { version: string; build: string; replaced: string | null } | null; schema: { from: number; to: number; status: UpgradeRecord['status'] } | null } | null;
    /** The newest schema upgrade's record, as it concerns this Unit Instance. */
    record: { id: string; at: string; status: UpgradeRecord['status']; changes: CountChange[]; failed: UpgradeRecord['failed'] | null; reviewed: UpgradeRecord['reviewed'] | null } | null;
  };
  health: { status: HealthStatus; checks: HealthCheck[] };
  backup: { state: BackupState; last: { at: string; method: string; ageHours: number } | null; maxAgeHours: number; changesSince: number | null };
  restore: { last: { id: string; at: string; method: RestoreRecord['method']; restoredTo: string | null; lost: number | null; reason: string | null; by: string | null } | null };
  flags: WithheldFlag[];
}

/** The service's own health, read at most once a minute for the Unit Manager console. */
const serviceHealth = new WeakMap<AppContext, { at: number; status: HealthStatus }>();
export function cachedServiceStatus(ctx: AppContext, at = Date.now()): HealthStatus {
  const cached = serviceHealth.get(ctx);
  if (cached && at - cached.at < 60_000) return cached.status;
  const status = healthReport(ctx, at).status;
  serviceHealth.set(ctx, { at, status });
  return status;
}

/** Every Unit Instance's operations, or one's. `service` is the service's health status, read once by the caller. */
export function instanceOperations(ctx: AppContext, { at = Date.now(), service, orgId }: { at?: number; service: HealthStatus; orgId?: string }): InstanceOperations[] {
  const { db } = ctx;
  const orgs = db.prepare(`SELECT id, slug, name, short_name, status, suspended_reason, created_at FROM organizations WHERE (? IS NULL OR id = ?) ORDER BY name`).all(orgId ?? null, orgId ?? null) as Org[];
  if (!orgs.length) return [];
  const atIso = new Date(at).toISOString();

  // ——— What every Unit Instance shares: the build, the schema, the upgrades, the backups and restores ———
  const version = versionStatus(ctx);
  const releases = releaseHistory(ctx);
  // The build this process serves; read from outside it (npm run operations-report), the newest release recorded.
  const build = version.startedAt ? version.build : releases.at(-1)?.build ?? version.build;
  const database = Number(metaGet(db, 'schema_version') || 0);
  const schemaState = database === SCHEMA_VERSION ? 'current' : database < SCHEMA_VERSION ? 'behind' : 'ahead';
  const upgrades = upgradeHistory(db);
  const backups = backupHistory(db);
  const newestBackup = backups.at(-1) ?? null;
  const restores = restoreHistory(db);
  const maxAgeHours = ctx.config.operations.backupMaxAgeHours;

  // ——— Grouped once for every Unit Instance ———
  const seated = new Set((db.prepare(`SELECT DISTINCT r.org_id FROM org_roles r JOIN users u ON u.id = r.user_id
      WHERE r.role = 'owner' AND u.active = 1 AND (r.expires_at IS NULL OR r.expires_at > ?) AND ${seatedOrgRole('r')}`).all(atIso) as Array<{ org_id: string }>).map((r) => r.org_id));
  const since = new Date(at - 86_400_000).toISOString();
  const mail = new Map((db.prepare(`SELECT org_id, SUM(status = 'failed') AS failed, SUM(status = 'sent') AS sent FROM email_log
      WHERE created_at >= ? AND org_id IS NOT NULL GROUP BY org_id`).all(since) as Array<{ org_id: string; failed: number; sent: number }>).map((r) => [r.org_id, r]));
  const changed = newestBackup?.seq
    ? new Map((db.prepare('SELECT org_id, COUNT(*) AS n FROM audit_log WHERE seq > ? AND org_id IS NOT NULL GROUP BY org_id').all(newestBackup.seq) as Array<{ org_id: string; n: number }>).map((r) => [r.org_id, r.n]))
    : null;
  const flags = withheldFlags(ctx, orgId);

  return orgs.map((org): InstanceOperations => {
    // The release it runs, since the later of that release's first start and the Unit Instance's creation.
    const current = releases.at(-1);
    const runningSince = [current?.firstStartedAt, org.created_at].filter((x): x is string => Boolean(x)).sort().at(-1) ?? org.created_at;

    // The newest release and schema upgrade since the Unit Instance was created. The first release a database records is
    // its installation, not an upgrade.
    const releaseIndex = releases.findLastIndex((r, i) => i > 0 && r.firstStartedAt >= org.created_at);
    const release = releaseIndex > 0 ? releases[releaseIndex] : null;
    const record = [...upgrades].reverse().find((u) => u.at >= org.created_at) ?? null;
    const changes = record ? (record.instances.find((i) => i.org_id === org.id)?.changes ?? []).filter((c) => !c.intended) : [];
    const lastAt = [release?.firstStartedAt, record?.at].filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
    // A schema upgrade belongs with the release that ran it when they started within ten minutes of each other.
    const together = release && record && Math.abs(Date.parse(release.firstStartedAt) - Date.parse(record.at)) < 10 * 60_000;
    const lastRelease = release && (together || lastAt === release.firstStartedAt) ? release : null;
    const lastSchema = record && (together || lastAt === record.at) ? record : null;
    const state: UpgradeState = record?.status === 'failed' && !record.reviewed ? 'failed'
      : changes.length && !record?.reviewed ? 'attention'
        : schemaState === 'current' ? 'current' : schemaState;

    // The newest backup holds this Unit Instance only if it existed when the backup was taken.
    const backupState: BackupState = !newestBackup ? 'never' : newestBackup.at < org.created_at ? 'not_yet'
      : (at - Date.parse(newestBackup.at)) / 3_600_000 > maxAgeHours ? 'stale' : 'fresh';
    const ageHours = newestBackup ? Math.round(Math.max(0, (at - Date.parse(newestBackup.at)) / 3_600_000) * 10) / 10 : null;
    const changesSince = backupState === 'fresh' || backupState === 'stale' ? (changed ? changed.get(org.id) ?? 0 : null) : null;

    const restore = [...restores].reverse().find((r) => r.at >= org.created_at) ?? null;
    const own = flags.filter((f) => f.org_id === org.id);

    // ——— Health: the service it runs on, and what is this Unit Instance's own ———
    const checks: HealthCheck[] = [
      { id: 'service', label: 'The service', status: service, summary: service === 'ok' ? 'Every check on the service this Unit Instance runs on passes.' : 'The service this Unit Instance runs on needs attention; Vantage staff see why under Operations.' },
    ];
    if (org.status !== 'active') checks.push({ id: 'status', label: 'Status', status: 'info', summary: `${org.status === 'suspended' ? 'Suspended' : 'Archived'} by Vantage${org.suspended_reason ? `: ${org.suspended_reason}` : '.'}` });
    if (org.status === 'active' && !seated.has(org.id)) checks.push({ id: 'leaders', label: 'Lead Unit Manager', status: 'warn', summary: 'No Lead Unit Manager. A Vantage Administrator can name one from Unit Instances.' });
    if (state === 'failed') checks.push({ id: 'upgrade', label: 'Upgrade', status: 'warn', summary: `The upgrade of ${day(record!.at)} failed at ${record!.failed?.name ?? 'a migration'} and was rolled back; the database stayed at schema ${record!.schema.to}.` });
    else if (state === 'attention') checks.push({ id: 'upgrade', label: 'Upgrade', status: 'warn', summary: `The upgrade to schema ${record!.schema.to} on ${day(record!.at)} left fewer rows in ${changes.map((c) => c.table).join(', ')}. Vantage staff are told; it shows here until one reviews it.` });
    else if (state === 'ahead') checks.push({ id: 'upgrade', label: 'Upgrade', status: 'warn', summary: `The database is at schema ${database}, ahead of this build's ${SCHEMA_VERSION}.` });
    if (backupState === 'never') checks.push({ id: 'backup', label: 'Backup', status: 'warn', summary: 'Vantage has no record of any backup.' });
    else if (backupState === 'not_yet') checks.push({ id: 'backup', label: 'Backup', status: 'warn', summary: `Created ${day(org.created_at)}, after the newest backup (${day(newestBackup!.at)}): no backup Vantage knows of holds it yet.` });
    else checks.push({ id: 'backup', label: 'Backup', status: backupState === 'stale' ? 'warn' : 'ok', summary: `In the backup of ${day(newestBackup!.at)}${changesSince !== null ? `; ${changesSince} audited action${changesSince === 1 ? '' : 's'} since` : ''}.${backupState === 'stale' ? ` Older than the ${maxAgeHours} hours the service expects.` : ''}` });
    const mailRow = mail.get(org.id);
    if (ctx.mailer.enabled && mailRow && mailRow.failed > mailRow.sent && mailRow.failed > 0) checks.push({ id: 'email', label: 'Email', status: 'warn', summary: `Last 24 hours: ${mailRow.sent} sent and ${mailRow.failed} failed for this Unit Instance.` });
    if (restore && at - Date.parse(restore.at) < RECENT_RESTORE_DAYS * 86_400_000) {
      const lost = restore.lost ? restore.lost.instances?.[org.id] ?? 0 : null;
      checks.push(restore.method === 'detected'
        ? { id: 'restore', label: 'Restore', status: 'warn', summary: `On ${day(restore.at)} the database was replaced outside Vantage’s restore command. Vantage staff are told.` }
        : { id: 'restore', label: 'Restore', status: 'info', summary: `Restored on ${day(restore.at)} to the state of ${day(restore.restored.at)}${lost !== null ? `; ${lost} of this Unit Instance’s audited actions after it were undone` : ''}.` });
    }
    for (const f of own) checks.push({ id: `flag_${f.flag}`, label: f.label, status: 'info', summary: `Turned off for this Unit Instance by Vantage on ${day(f.set_at)}: ${f.reason}` });

    return {
      id: org.id, slug: org.slug, name: org.name, short_name: org.short_name, status: org.status, created_at: org.created_at,
      version: { version: VERSION, build, since: runningSince },
      schema: { database, code: SCHEMA_VERSION, state: schemaState },
      upgrade: {
        state,
        last: lastAt ? {
          at: lastAt,
          release: lastRelease ? { version: lastRelease.version, build: lastRelease.build, replaced: releases[releaseIndex - 1] ? `${releases[releaseIndex - 1].version} build ${releases[releaseIndex - 1].build}` : null } : null,
          schema: lastSchema ? { from: lastSchema.schema.from, to: lastSchema.schema.to, status: lastSchema.status } : null,
        } : null,
        record: record ? { id: record.id, at: record.at, status: record.status, changes, failed: record.failed ?? null, reviewed: record.reviewed ?? null } : null,
      },
      health: { status: worst(checks.map((c) => c.status)), checks },
      backup: { state: backupState, last: newestBackup && ageHours !== null ? { at: newestBackup.at, method: newestBackup.method, ageHours } : null, maxAgeHours, changesSince },
      restore: {
        last: restore ? {
          id: restore.id, at: restore.at, method: restore.method, restoredTo: restore.restored.at,
          lost: restore.lost ? restore.lost.instances?.[org.id] ?? 0 : null, reason: restore.reason, by: restore.by?.name ?? null,
        } : null,
      },
      flags: own,
    };
  });
}

/** The fleet view's summary: how many Unit Instances are in each state. */
export function operationsSummary(list: InstanceOperations[]) {
  const count = <K extends string>(pick: (i: InstanceOperations) => K) => list.reduce<Record<string, number>>((acc, i) => { acc[pick(i)] = (acc[pick(i)] ?? 0) + 1; return acc; }, {});
  return { instances: list.length, health: count((i) => i.health.status), upgrade: count((i) => i.upgrade.state), backup: count((i) => i.backup.state), at: now() };
}
