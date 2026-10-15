import { Badge, Panel, type Tone } from '@/components/ui/primitives';
import { Table } from '@/components/common';
import { formatStamp, timeAgo } from '@/lib/utils';

/**
 * One Unit Instance's operations (ADR-0014), for the Vantage Administrator console's Unit Instance operations page and the
 * Unit Manager console's Operations page: the version it runs, its schema, its last upgrade and whether the upgrade kept
 * its rows, its health, the backup that holds it, its last restore and what Vantage turned off for it. Both consoles read
 * the same shape; the Unit Manager's has the service's own checks folded into one status, and names Vantage staff only.
 */

export type HealthStatus = 'ok' | 'warn' | 'fail' | 'info';
export interface HealthCheck { id: string; label: string; status: HealthStatus; summary: string }

const STATUS: Record<HealthStatus, { label: string; tone: Tone }> = {
  ok: { label: 'OK', tone: 'good' },
  warn: { label: 'Attention', tone: 'warn' },
  fail: { label: 'Failing', tone: 'bad' },
  info: { label: 'Note', tone: 'info' },
};

export const StatusBadge = ({ status }: { status: HealthStatus }) => <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;

export function CheckList({ checks }: { checks: HealthCheck[] }) {
  if (!checks.length) return <p className="text-sm text-ink-3">Nothing to report.</p>;
  return (
    <ul className="divide-y divide-line">
      {checks.map((c) => (
        // On a phone the summary takes its own line under the state and the check's name.
        <li key={c.id} className="grid grid-cols-[6rem_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0 sm:grid-cols-[6rem_10rem_minmax(0,1fr)]">
          <span><StatusBadge status={c.status} /></span>
          <span className="text-sm font-medium text-ink">{c.label}</span>
          <span className="col-span-2 min-w-0 break-words text-sm text-ink-2 sm:col-span-1">{c.summary}</span>
        </li>
      ))}
    </ul>
  );
}

export type UpgradeState = 'current' | 'attention' | 'failed' | 'ahead' | 'behind';
export type BackupState = 'fresh' | 'stale' | 'never' | 'not_yet';
export type UpgradeStatus = 'verified' | 'changed' | 'failed';
export interface CountChange { table: string; before: number; after: number | null; intended?: boolean }
export interface UpgradeReview { at: string; by?: string; byName: string; note: string }
export interface WithheldFlag { org_id: string; org_name: string; flag: string; label: string; reason: string; set_at: string; set_by?: string | null; set_by_name: string | null }

export interface InstanceOperations {
  id: string; slug: string; name: string; short_name: string | null; status: string; created_at: string;
  version: { version: string; build: string; since: string };
  schema: { database: number; code: number; state: 'current' | 'behind' | 'ahead' };
  upgrade: {
    state: UpgradeState;
    last: { at: string; release: { version: string; build: string; replaced: string | null } | null; schema: { from: number; to: number; status: UpgradeStatus } | null } | null;
    record: { id: string; at: string; status: UpgradeStatus; changes: CountChange[]; failed: { id: number; name: string; error?: string } | null; reviewed: UpgradeReview | null } | null;
  };
  health: { status: HealthStatus; checks: HealthCheck[] };
  backup: { state: BackupState; last: { at: string; method: string; ageHours: number } | null; maxAgeHours: number; changesSince: number | null };
  restore: { last: { id: string; at: string; method: 'script' | 'archive' | 'detected'; restoredTo: string | null; lost: number | null; reason: string | null; by: string | null } | null };
  flags: WithheldFlag[];
}

export const UPGRADE_STATE: Record<UpgradeState, { label: string; tone: Tone }> = {
  current: { label: 'Current', tone: 'good' },
  attention: { label: 'Rows changed', tone: 'warn' },
  failed: { label: 'Failed', tone: 'bad' },
  ahead: { label: 'Ahead of the build', tone: 'warn' },
  behind: { label: 'Behind the build', tone: 'bad' },
};

export const BACKUP_STATE: Record<BackupState, { label: string; tone: Tone }> = {
  fresh: { label: 'Fresh', tone: 'good' },
  stale: { label: 'Overdue', tone: 'warn' },
  never: { label: 'None recorded', tone: 'warn' },
  not_yet: { label: 'Not in a backup yet', tone: 'warn' },
};

const RESTORE_METHOD: Record<'script' | 'archive' | 'detected', string> = {
  script: 'restored on the host with npm run restore',
  archive: 'loaded from a service archive',
  detected: 'replaced outside Vantage’s restore command',
};

const short = (build: string) => (build.length > 12 ? build.slice(0, 12) : build);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5"><dt className="text-ink-3">{label}</dt><dd className="min-w-0 text-right text-ink">{children}</dd></div>;
}

/** What an upgrade did to the rows of one Unit Instance: the tables that hold fewer than before. */
export function RowChanges({ changes }: { changes: CountChange[] }) {
  if (!changes.length) return null;
  return (
    <Table className="scroll-x mt-2" minWidth={320} head={<><th>Table</th><th className="text-right">Before</th><th className="text-right">After</th></>}>
      {changes.map((c) => <tr key={c.table}><td className="mono text-2xs">{c.table}</td><td className="fig text-right text-xs">{c.before}</td><td className="fig text-right text-xs text-warn">{c.after ?? 'table gone'}</td></tr>)}
    </Table>
  );
}

export function InstanceOperationsDetail({ instance, audience, reviewAction }: { instance: InstanceOperations; audience: 'staff' | 'manager'; reviewAction?: React.ReactNode }) {
  const { version, schema, upgrade, health, backup, restore, flags } = instance;
  const staff = audience === 'staff';
  const record = upgrade.record;
  const restored = restore.last;
  return (
    <div className="space-y-4">
      <Panel title="Health" subtitle={staff ? 'This Unit Instance, and the service it runs on' : 'Your Unit Instance, and the Vantage service it runs on'} action={<StatusBadge status={health.status} />}>
        <CheckList checks={health.checks} />
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Version and upgrades" action={<Badge tone={UPGRADE_STATE[upgrade.state].tone}>{UPGRADE_STATE[upgrade.state].label}</Badge>}>
          <dl className="space-y-1.5 text-sm">
            <Row label="Runs"><span className="fig">Vantage {version.version}</span> <span className="mono text-2xs text-ink-3" title={version.build}>build {short(version.build)}</span></Row>
            <Row label="Since"><span className="fig">{formatStamp(version.since)}</span></Row>
            <Row label="Schema"><span className="fig">{schema.database}</span>{schema.state !== 'current' && <span className="text-warn"> (this build needs {schema.code})</span>}</Row>
            <Row label="Last upgrade">{upgrade.last
              ? <span className="fig">{formatStamp(upgrade.last.at)}</span>
              : <span className="text-ink-3">none since it was created</span>}</Row>
            {upgrade.last?.release && <Row label="Release"><span className="fig">{upgrade.last.release.replaced ? `from ${upgrade.last.release.replaced} to ` : ''}{upgrade.last.release.version}</span></Row>}
            {upgrade.last?.schema && <Row label="Schema change"><span className="fig">{upgrade.last.schema.from} to {upgrade.last.schema.to}</span></Row>}
          </dl>
          {record && record.status === 'verified' && <p className="mt-3 text-xs text-ink-3">Vantage counted this Unit Instance’s rows in every table before and after the last schema upgrade; none were lost.</p>}
          {record && record.status === 'changed' && (
            <div className="mt-3">
              <p className="text-sm text-ink-2">The schema upgrade of {formatStamp(record.at)} left {record.changes.length ? `fewer rows in ${plural(record.changes.length, 'of this Unit Instance’s tables', 'of this Unit Instance’s tables')}` : 'fewer rows elsewhere in the service, none of them this Unit Instance’s'}.{staff ? '' : ' Vantage staff were told when it happened.'}</p>
              <RowChanges changes={record.changes} />
            </div>
          )}
          {record && record.status === 'failed' && (
            <p className="mt-3 text-sm text-ink-2">The schema upgrade of {formatStamp(record.at)} failed{record.failed ? ` at ${record.failed.name}` : ''} and was rolled back, so nothing it started was kept.{staff && record.failed ? <span className="mt-1 block font-mono text-2xs text-ink-3">{record.failed.error}</span> : null}</p>
          )}
          {record?.reviewed && <p className="mt-3 rounded-md border border-line bg-surface-2/60 px-3 py-2 text-xs text-ink-2">Reviewed {timeAgo(record.reviewed.at)} by {record.reviewed.byName}: {record.reviewed.note}</p>}
          {reviewAction}
        </Panel>
        <Panel title="Backup and restore" action={<Badge tone={BACKUP_STATE[backup.state].tone}>{BACKUP_STATE[backup.state].label}</Badge>}>
          <dl className="space-y-1.5 text-sm">
            <Row label="Newest backup">{backup.last ? <span className="fig">{formatStamp(backup.last.at)} ({timeAgo(backup.last.at)})</span> : <span className="text-ink-3">none recorded</span>}</Row>
            <Row label="Expected">every {backup.maxAgeHours} hours</Row>
            {backup.changesSince !== null && <Row label="Since that backup"><span className="fig">{plural(backup.changesSince, 'audited action')}</span></Row>}
            <Row label="Last restore">{restored ? <span className="fig">{formatStamp(restored.at)}</span> : <span className="text-ink-3">none since it was created</span>}</Row>
          </dl>
          {backup.state === 'not_yet' && <p className="mt-3 text-xs text-ink-3">This Unit Instance was created after the newest backup, so restoring that backup would not bring it back.</p>}
          {backup.changesSince !== null && backup.changesSince > 0 && <p className="mt-3 text-xs text-ink-3">Restoring the newest backup would undo the {plural(backup.changesSince, 'audited action')} since it.</p>}
          {restored && (
            <p className="mt-3 text-sm text-ink-2">
              {restored.method === 'detected' ? `On ${formatStamp(restored.at)} the database was ${RESTORE_METHOD.detected}.` : `On ${formatStamp(restored.at)} the database was ${RESTORE_METHOD[restored.method]}${restored.restoredTo ? `, back to its state of ${formatStamp(restored.restoredTo)}` : ''}${restored.by ? `, authorized by ${restored.by}` : ''}.`}
              {restored.lost !== null && ` ${restored.lost ? `${plural(restored.lost, 'audited action')} in this Unit Instance after that point ${restored.lost === 1 ? 'was' : 'were'} undone.` : 'Nothing this Unit Instance did after that point was undone.'}`}
              {restored.reason && <span className="mt-1 block text-xs text-ink-3">Reason: {restored.reason}</span>}
            </p>
          )}
          <p className="mt-3 text-xs text-ink-3">{staff
            ? 'Backups hold the whole service. Restoring one is done on the host, with the service stopped, and puts every Unit Instance back together.'
            : 'Vantage backs up the whole service, and only Vantage staff restore it. The exports under Imports and exports are copies of your data for your own use; they are not backups and restore nothing.'}</p>
        </Panel>
      </div>
      <Panel title="Turned off by Vantage" subtitle={staff ? 'Features withheld from this Unit Instance only' : 'Features Vantage withheld from your Unit Instance'}>
        {!flags.length ? <p className="text-sm text-ink-3">{staff ? 'None. This Unit Instance has every feature the service runs.' : 'None. Your Unit Instance has every feature the Vantage service runs.'}</p> : (
          <ul className="divide-y divide-line">
            {flags.map((f) => (
              <li key={f.flag} className="py-2 text-sm first:pt-0 last:pb-0">
                <p className="font-medium text-ink">{f.label} <Badge className="ml-1" tone="warn">Off</Badge></p>
                <p className="text-ink-2">{f.reason}</p>
                <p className="text-xs text-ink-3">Since {formatStamp(f.set_at)}{f.set_by_name ? `, by ${f.set_by_name}` : ''}.</p>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
