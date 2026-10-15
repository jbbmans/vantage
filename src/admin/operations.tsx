import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Play, Power, RefreshCw, Wrench } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Panel, Select, Skeleton, Stat, Switch, Textarea, type Tone } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { Table } from '@/components/common';
import { BACKUP_STATE, CheckList, InstanceOperationsDetail, RowChanges, StatusBadge, UPGRADE_STATE, plural, type CountChange, type HealthCheck, type HealthStatus, type InstanceOperations, type UpgradeStatus, type WithheldFlag } from '@/components/InstanceOperations';
import { keys } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatStamp, humanize, timeAgo } from '@/lib/utils';
import { useAdmin } from './sections';
import { usePlatformCan } from './people';

/**
 * The Vantage Administrator console's operations pages (ADR-0011): the service's health, its sign-in health, its feature
 * flags and controlled maintenance. Each describes the service; none shows what a Unit Instance keeps.
 */

const mb = (bytes: number | null | undefined) => (bytes == null ? '—' : bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`);
const every = (ms: number) => (ms >= 86_400_000 ? `every ${ms / 86_400_000} d` : ms >= 3_600_000 ? `every ${ms / 3_600_000} h` : `every ${Math.round(ms / 60_000)} min`);
const uptime = (s: number) => (s >= 86_400 ? `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);

function Failed({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="card"><EmptyState title="Could not load" description={api.errorText(error)} action={<Button onClick={retry}>Retry</Button>} /></div>;
}

// ——— Operations ———

interface MigrationRun { id: number; name: string; at: string; ms: number; version: string }
interface BackupRecord { at: string; method: 'browser' | 'server'; bytes: number | null; by: string | null; file: string | null }
interface JobState { name: string; label: string; everyMs: number; runs: number; failures: number; consecutiveFailures: number; lastRunAt: string | null; lastOkAt: string | null; lastError: string | null; lastMs: number | null; overdue: boolean; status: HealthStatus }
interface OperationsReport {
  health: { checkedAt: string; status: HealthStatus; checks: HealthCheck[]; process: { uptime: number; rssBytes: number; heapUsedBytes: number } };
  version: { version: string; build: string; client: string | null; node: string; startedAt: string | null; uptime: number; releases: Array<{ version: string; build: string; client: string | null; firstStartedAt: string }> };
  schema: { code: number; database: number; state: 'current' | 'behind' | 'ahead'; historySince: { at: string; schema: number } | null; catalog: Array<{ id: number; name: string; applied: boolean; run: MigrationRun | null }>; notes: string[] };
  backups: { state: 'fresh' | 'stale' | 'never'; last: BackupRecord | null; ageHours: number | null; maxAgeHours: number; browserBackups: boolean; history: BackupRecord[]; lastArchiveExport: string | null; lastArchiveImport: string | null };
  jobs: JobState[];
}

const SCHEMA_TONE: Record<OperationsReport['schema']['state'], Tone> = { current: 'good', behind: 'bad', ahead: 'warn' };
const BACKUP_TONE: Record<OperationsReport['backups']['state'], Tone> = { fresh: 'good', stale: 'warn', never: 'warn' };

export function Operations() {
  const { data, isPending, error, refetch, isFetching } = useAdmin<OperationsReport>('operations', api.platformOperations);
  const can = usePlatformCan();
  const [allMigrations, setAllMigrations] = useState(false);
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const { health, version, schema, backups, jobs } = data;
  const migrations = allMigrations ? [...schema.catalog].reverse() : [...schema.catalog].reverse().slice(0, 6);
  return (
    <div className="space-y-4">
      <Panel title="Health" subtitle={`Checked ${formatStamp(health.checkedAt)}`} action={<span className="flex items-center gap-2"><StatusBadge status={health.status} /><Button size="sm" variant="ghost" onClick={() => refetch()} loading={isFetching}><RefreshCw className="h-3.5 w-3.5" />Check again</Button></span>}>
        <CheckList checks={health.checks} />
        <p className="mt-3 text-xs text-ink-3">The public health address (/api/health) says only whether the service and its database answer; this page is the full check, for Vantage staff.</p>
      </Panel>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Build" subtitle={`Vantage ${version.version}`}>
          <dl className="space-y-1.5 text-sm">
            {[['Build', version.build], ['Client', version.client ?? 'not built'], ['Node', version.node], ['Serving since', version.startedAt ? `${formatStamp(version.startedAt)} (${uptime(version.uptime)})` : '—'], ['Memory', `${mb(health.process.rssBytes)} resident · ${mb(health.process.heapUsedBytes)} heap`]].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3"><dt className="text-ink-3">{k}</dt><dd className="fig truncate text-right text-ink" title={v}>{v}</dd></div>
            ))}
          </dl>
          <h3 className="mb-1.5 mt-4 text-xs font-semibold text-ink-2">Releases this database has run</h3>
          {!version.releases.length ? <p className="text-sm text-ink-3">None recorded yet.</p> : (
            <Table minWidth={360} head={<><th>Version</th><th>Build</th><th>First served</th></>}>
              {version.releases.map((r) => <tr key={`${r.version}:${r.build}:${r.firstStartedAt}`}><td className="fig text-xs">{r.version}</td><td className="mono max-w-[10rem] truncate text-2xs" title={r.build}>{r.build}</td><td className="fig text-xs text-ink-3">{formatStamp(r.firstStartedAt)}</td></tr>)}
            </Table>
          )}
        </Panel>

        <Panel title="Schema and migrations" subtitle={`This build needs schema ${schema.code}; the database is at ${schema.database}`} action={<Badge tone={SCHEMA_TONE[schema.state]}>{humanize(schema.state)}</Badge>}>
          {schema.notes.length > 0 && <ul className="mb-3 space-y-1 text-xs text-ink-2">{schema.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <Table minWidth={420} head={<><th className="w-10">#</th><th>Migration</th><th>Ran</th><th className="text-right">Took</th></>}>
            {migrations.map((m) => (
              <tr key={m.id}>
                <td className="fig text-xs text-ink-3">{m.id}</td>
                <td className="mono text-2xs">{m.name}</td>
                <td className="text-xs">{m.run ? <span title={`under Vantage ${m.run.version}`}>{formatStamp(m.run.at)}</span> : m.applied ? <span className="text-ink-3">before the history began</span> : <Badge tone="warn">Not run</Badge>}</td>
                <td className="fig text-right text-xs text-ink-3">{m.run ? `${m.run.ms} ms` : ''}</td>
              </tr>
            ))}
          </Table>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
            <span>{schema.historySince ? `History kept since ${formatStamp(schema.historySince.at)}, from schema ${schema.historySince.schema}.` : ''}</span>
            {schema.catalog.length > 6 && <button type="button" className="link" onClick={() => setAllMigrations(!allMigrations)}>{allMigrations ? 'Show the latest' : `Show all ${schema.catalog.length}`}</button>}
          </div>
        </Panel>

        <Panel title="Backups" subtitle={`Expected every ${backups.maxAgeHours} hours (VANTAGE_BACKUP_MAX_AGE_HOURS)`} action={<Badge tone={BACKUP_TONE[backups.state]}>{backups.state === 'never' ? 'None recorded' : humanize(backups.state)}</Badge>}>
          {backups.last
            ? <p className="text-sm text-ink-2">Last backup {timeAgo(backups.last.at)}, {backups.last.method === 'server' ? 'taken on the server' : 'downloaded from this console'}{backups.last.bytes ? `, ${mb(backups.last.bytes)}` : ''}{backups.last.by ? `, by ${backups.last.by}` : ''}.</p>
            : <p className="text-sm text-ink-2">Vantage has no record of a backup. Run <span className="mono">npm run backup -- /path/to/copy.db</span> on the server.</p>}
          <p className="mt-2 text-xs text-ink-3">Vantage records backups taken with npm run backup and downloads from this console. Snapshots the hosting environment takes on its own do not pass through Vantage and are not listed.</p>
          {backups.history.length > 1 && (
            <Table className="scroll-x mt-3" minWidth={360} head={<><th>When</th><th>How</th><th className="text-right">Size</th></>}>
              {backups.history.slice(0, 10).map((b) => <tr key={b.at}><td className="fig text-xs">{formatStamp(b.at)}</td><td className="text-xs">{b.method === 'server' ? 'Server' : 'Browser'}{b.by ? ` · ${b.by}` : ''}</td><td className="fig text-right text-xs text-ink-3">{mb(b.bytes)}</td></tr>)}
            </Table>
          )}
          <p className="mt-3 text-xs text-ink-3">Service archive: last exported {backups.lastArchiveExport ? timeAgo(backups.lastArchiveExport) : 'never'}, last imported {backups.lastArchiveImport ? timeAgo(backups.lastArchiveImport) : 'never'}.{can('platform.data') && <> <Link className="link" to="/data">Backup and recovery</Link></>}</p>
        </Panel>

        <Panel title="Scheduled jobs" subtitle="In this server process">
          {!jobs.length ? <p className="text-sm text-warn">No scheduled jobs are running in this process.</p> : (
            <Table minWidth={460} head={<><th>Job</th><th>Last run</th><th className="text-right">Runs</th><th>State</th></>}>
              {jobs.map((j) => (
                <tr key={j.name}>
                  <td className="text-xs"><span className="text-ink">{j.label}</span><span className="block text-2xs text-ink-3">{every(j.everyMs)}</span></td>
                  <td className="fig text-xs text-ink-3">{j.lastRunAt ? timeAgo(j.lastRunAt) : 'not yet'}{j.lastMs != null ? ` · ${j.lastMs} ms` : ''}</td>
                  <td className="fig text-right text-xs">{j.runs}{j.failures ? <span className="text-warn"> · {j.failures} failed</span> : ''}</td>
                  <td className="text-xs"><StatusBadge status={j.status} />{j.overdue && <span className="block text-2xs text-warn">overdue</span>}{j.lastError && <span className="block max-w-[14rem] truncate text-2xs text-warn" title={j.lastError}>{j.lastError}</span>}</td>
                </tr>
              ))}
            </Table>
          )}
        </Panel>
      </div>
    </div>
  );
}

// ——— Unit Instance operations (ADR-0014) ———

interface UpgradeRecordView {
  id: string; at: string; version: string; schema: { from: number; to: number }; status: UpgradeStatus; ms: number; migrations: number[];
  failed?: { id: number; name: string; error: string }; service: CountChange[]; instances: Array<{ org_id: string; changes: CountChange[] }>; checked: number;
  reviewed?: { at: string; by: string; byName: string; note: string } | null;
}
interface InstanceOperationsReport {
  service: { health: { checkedAt: string; status: HealthStatus }; version: { version: string; build: string }; schema: { code: number; database: number; state: 'current' | 'behind' | 'ahead' }; upgrades: UpgradeRecordView[] };
  instances: InstanceOperations[];
  summary: { instances: number; health: Record<string, number>; upgrade: Record<string, number>; backup: Record<string, number> };
  canReview: boolean;
}

const UPGRADE_RESULT: Record<UpgradeStatus, { label: string; tone: Tone }> = { verified: { label: 'Rows kept', tone: 'good' }, changed: { label: 'Rows changed', tone: 'warn' }, failed: { label: 'Failed', tone: 'bad' } };
const needsAttention = (i: InstanceOperations) => i.health.status === 'warn' || i.health.status === 'fail' || i.upgrade.state !== 'current' || i.backup.state !== 'fresh';

export function InstanceOperationsPage() {
  const { data, isPending, error, refetch, isFetching } = useAdmin<InstanceOperationsReport>('instance-operations', api.platformInstanceOperations);
  const toast = useToast(); const qc = useQueryClient();
  const [query, setQuery] = useState(''); const [onlyAttention, setOnlyAttention] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<UpgradeRecordView | null>(null); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const { service, instances, summary, canReview } = data;
  const names = new Map(instances.map((i) => [i.id, i.name]));
  const q = query.trim().toLowerCase();
  const shown = instances.filter((i) => (!onlyAttention || needsAttention(i)) && (!q || [i.name, i.short_name ?? '', i.slug].some((v) => v.toLowerCase().includes(q))));
  const open = instances.find((i) => i.id === openId) ?? null;
  const toReview = service.upgrades.filter((u) => u.status !== 'verified' && !u.reviewed);
  const attention = (summary.health.warn ?? 0) + (summary.health.fail ?? 0);
  const notFresh = summary.instances - (summary.backup.fresh ?? 0);
  const review = async () => {
    if (!reviewing) return;
    setBusy(true);
    try { await withSudo(() => api.platformReviewUpgrade(reviewing.id, note.trim())); toast.success('Marked reviewed.'); setReviewing(null); setNote(''); refetch(); qc.invalidateQueries({ queryKey: ['admin'] }); }
    catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const reviewButton = (u: UpgradeRecordView | undefined) => (u && canReview && u.status !== 'verified' && !u.reviewed
    ? <Button size="sm" onClick={() => { setNote(''); setReviewing(u); }}>Mark reviewed</Button> : null);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Unit Instances" value={summary.instances} />
        <Stat label="Need attention" value={attention} tone={attention ? 'warn' : undefined} hint="health, upgrade or backup" />
        <Stat label="Upgrades to review" value={toReview.length} tone={toReview.length ? 'warn' : undefined} hint={toReview.length ? 'failed, or lost rows' : 'every one kept its rows'} />
        <Stat label="Not in a fresh backup" value={notFresh} tone={notFresh ? 'warn' : undefined} />
      </div>

      <Panel title="The service they run on" subtitle={`Checked ${formatStamp(service.health.checkedAt)}`} action={<span className="flex items-center gap-2"><StatusBadge status={service.health.status} /><Button size="sm" variant="ghost" onClick={() => refetch()} loading={isFetching}><RefreshCw className="h-3.5 w-3.5" />Check again</Button></span>}>
        <p className="text-sm text-ink-2">Every Unit Instance here runs Vantage {service.version.version} at schema {service.schema.database}{service.schema.state !== 'current' ? `, while this build needs ${service.schema.code}` : ''}, so they upgrade together. What differs is what each one went through and holds.</p>
        <p className="mt-2 text-xs text-ink-3">A dedicated deployment is a service of its own with its own console; <span className="mono">npm run operations-report</span> on its host prints the same view for it. <Link className="link" to="/operations">Operations</Link> has the service’s own checks.</p>
      </Panel>

      <Panel title="Schema upgrades" subtitle="Each counted, table by table and Unit Instance by Unit Instance, before and after">
        {!service.upgrades.length ? <p className="text-sm text-ink-3">None recorded. Vantage counts rows from the first upgrade this database runs after this release.</p> : (
          <Table minWidth={640} head={<><th>When</th><th>Schema</th><th>Release</th><th>Result</th><th>Unit Instances with fewer rows</th><th /></>}>
            {service.upgrades.map((u) => (
              <tr key={u.id}>
                <td className="fig text-xs">{formatStamp(u.at)}<span className="block text-2xs text-ink-3">{u.ms} ms</span></td>
                <td className="fig text-xs">{u.schema.from} to {u.schema.to}<span className="block text-2xs text-ink-3">{plural(u.migrations.length, 'migration')}</span></td>
                <td className="fig text-xs">{u.version}</td>
                <td className="text-xs"><Badge tone={UPGRADE_RESULT[u.status].tone}>{UPGRADE_RESULT[u.status].label}</Badge>{u.failed && <span className="mono block text-2xs text-ink-3">{u.failed.name}</span>}{u.reviewed && <span className="block text-2xs text-ink-3">reviewed by {u.reviewed.byName}</span>}</td>
                <td className="text-xs">{u.instances.length ? u.instances.map((i) => names.get(i.org_id) ?? 'a Unit Instance since removed').join(', ') : <span className="text-ink-3">none</span>}</td>
                <td className="text-right">{reviewButton(u)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Panel title="Unit Instances" subtitle="Open one for its checks, upgrades, backup and restores"
        action={<div className="flex flex-wrap items-center gap-3"><Input aria-label="Find a Unit Instance" className="h-8 w-48" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find" /><Switch checked={onlyAttention} onChange={setOnlyAttention} label="Needs attention" /></div>}>
        {!shown.length ? <p className="text-sm text-ink-3">{instances.length ? 'None match.' : 'No Unit Instances yet.'}</p> : (
          <Table minWidth={760} head={<><th>Unit Instance</th><th>Health</th><th>Version</th><th>Last upgrade</th><th>Backup</th><th>Last restore</th><th>Withheld</th></>}>
            {shown.map((i) => (
              <tr key={i.id}>
                <td className="text-xs"><button type="button" className="link text-left" onClick={() => setOpenId(i.id)}>{i.name}</button>{i.status !== 'active' && <span className="block text-2xs text-ink-3">{humanize(i.status)}</span>}</td>
                <td><StatusBadge status={i.health.status} /></td>
                <td className="fig text-xs">{i.version.version}<span className="block text-2xs text-ink-3">schema {i.schema.database}</span></td>
                <td className="text-xs">{i.upgrade.last ? <span className="fig">{formatStamp(i.upgrade.last.at)}</span> : <span className="text-ink-3">none yet</span>}<span className="block"><Badge tone={UPGRADE_STATE[i.upgrade.state].tone}>{UPGRADE_STATE[i.upgrade.state].label}</Badge></span></td>
                <td className="text-xs"><Badge tone={BACKUP_STATE[i.backup.state].tone}>{BACKUP_STATE[i.backup.state].label}</Badge>{i.backup.last && <span className="block text-2xs text-ink-3">{timeAgo(i.backup.last.at)}{i.backup.changesSince ? ` · ${i.backup.changesSince} since` : ''}</span>}</td>
                <td className="text-xs">{i.restore.last ? <span className={i.restore.last.method === 'detected' ? 'text-warn' : ''}>{timeAgo(i.restore.last.at)}</span> : <span className="text-ink-3">none</span>}</td>
                <td className="text-xs">{i.flags.length ? i.flags.map((f) => f.label).join(', ') : <span className="text-ink-3">none</span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      <Dialog open={Boolean(open)} onOpenChange={(o) => { if (!o) setOpenId(null); }} title={open?.name ?? ''} description={open ? `Created ${formatStamp(open.created_at)}` : undefined} size="xl">
        {open && <InstanceOperationsDetail instance={open} audience="staff" reviewAction={<div className="mt-3">{reviewButton(service.upgrades.find((u) => u.id === open.upgrade.record?.id))}</div>} />}
      </Dialog>

      <Dialog open={Boolean(reviewing)} onOpenChange={(o) => { if (!o) setReviewing(null); }} title="Mark this upgrade reviewed" size="md"
        footer={<><Button variant="ghost" onClick={() => setReviewing(null)}>Cancel</Button><Button variant="primary" loading={busy} disabled={note.trim().length < 10} onClick={review}>Mark reviewed</Button></>}>
        {reviewing && (
          <div className="space-y-3 text-sm">
            <p className="text-ink-2">The upgrade from schema {reviewing.schema.from} to {reviewing.schema.to} on {formatStamp(reviewing.at)} {reviewing.status === 'failed' ? `failed${reviewing.failed ? ` at ${reviewing.failed.name}` : ''} and was rolled back` : 'left fewer rows than before'}. Say what you found; it goes in the platform audit trail, and each affected Unit Instance stops showing it as needing attention.</p>
            {reviewing.failed && <p className="mono break-words text-2xs text-ink-3">{reviewing.failed.error}</p>}
            {reviewing.service.length > 0 && <div><h3 className="text-xs font-semibold text-ink-2">Across the service</h3><RowChanges changes={reviewing.service} /></div>}
            {reviewing.instances.map((i) => <div key={i.org_id}><h3 className="text-xs font-semibold text-ink-2">{names.get(i.org_id) ?? 'A Unit Instance since removed'}</h3><RowChanges changes={i.changes} /></div>)}
            <Field label="What you found" required hint="ten to 500 characters"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="The migration folded duplicate entries; the counts match the release notes" /></Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}

// ——— Sign-in health ———

interface CrlStatus { file: string; issuer: string | null; thisUpdate: string | null; nextUpdate: string | null; error: string | null; status: HealthStatus }
interface SignInReport {
  checkedAt: string; status: HealthStatus; checks: HealthCheck[];
  methods: { password: boolean; passkey: boolean; cac: { mode: 'off' | 'direct' | 'proxy'; exclusive: boolean; autoProvision: boolean; revocation: string | null; stepUp: boolean }; oidc: { enabled: boolean; exclusive: boolean; linkBy: string; autoProvision: boolean } };
  cac: { mode: 'off' | 'direct' | 'proxy'; revocation: string | null; crls: CrlStatus[]; cas: Array<{ subject: string; validTo: string; status: HealthStatus }>; lastSignIn: string | null; policyOids: number };
  oidc: { enabled: boolean; issuerHost: string | null; label: string | null; linkBy: string; exclusive: boolean; lastSignIn: string | null };
  lockout: { attempts: number; minutes: number; lockedNow: number };
  coverage: { staff: number; staffWithoutSecondFactor: number; managers: number; managersPasswordOnly: number };
  last24h: { signIns: Record<string, number>; lockouts: number; cacRejected: number; oidcRejected: number; consoleRefused: number; stepUpRefused: number };
  sessions: { open: number; byMethod: Record<string, number> };
}
interface ProviderCheck { ok: boolean; issuer?: string; authorizationHost?: string; keys?: number; error?: string; checkedAt: string }

const METHOD_LABEL: Record<string, string> = { password: 'Password', 'password+totp': 'Password and authenticator', passkey: 'Passkey', cac: 'CAC', oidc: 'Organization sign-in' };

export function SignInHealth() {
  const { data, isPending, error, refetch, isFetching } = useAdmin<SignInReport>('sign-in-health', api.platformSignInHealth);
  const toast = useToast();
  const can = usePlatformCan();
  const [probe, setProbe] = useState<ProviderCheck | null>(null); const [probing, setProbing] = useState(false);
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const { methods, cac, oidc, lockout, coverage, last24h, sessions } = data;
  const checkProvider = async () => { setProbing(true); try { setProbe(await withSudo(() => api.platformOidcCheck())); } catch (e) { toast.error(api.errorText(e)); } finally { setProbing(false); } };
  const on = (b: boolean) => <Badge tone={b ? 'good' : undefined}>{b ? 'On' : 'Off'}</Badge>;
  const signIns = Object.entries(last24h.signIns);
  return (
    <div className="space-y-4">
      <Panel title="Sign-in checks" subtitle={`Checked ${formatStamp(data.checkedAt)}`} action={<span className="flex items-center gap-2"><StatusBadge status={data.status} /><Button size="sm" variant="ghost" onClick={() => refetch()} loading={isFetching}><RefreshCw className="h-3.5 w-3.5" />Check again</Button></span>}>
        <CheckList checks={data.checks} />
      </Panel>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Ways in" subtitle="What this deployment accepts">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Passwords</dt><dd>{on(methods.password)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Passkeys</dt><dd>{on(methods.passkey)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">CAC</dt><dd className="text-right">{methods.cac.mode === 'off' ? on(false) : <span className="text-ink">{methods.cac.mode === 'direct' ? 'Checked by this server' : 'Checked by the gateway'}{methods.cac.exclusive ? ' · only way in' : ''}</span>}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Organization sign-in</dt><dd className="text-right">{!oidc.enabled ? on(false) : <span className="text-ink">{oidc.label}{oidc.exclusive ? ' · only way in' : ''}</span>}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Lockout</dt><dd className="text-right text-ink">after {lockout.attempts} failures, for {lockout.minutes} min{lockout.lockedNow ? <span className="text-warn"> · {lockout.lockedNow} locked now</span> : ''}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Sessions open</dt><dd className="fig text-right text-ink">{sessions.open}{Object.keys(sessions.byMethod).length ? ` (${Object.entries(sessions.byMethod).map(([m, n]) => `${n} ${METHOD_LABEL[m]?.toLowerCase() ?? m}`).join(', ')})` : ''}</dd></div>
          </dl>
        </Panel>
        <Panel title="The last 24 hours" subtitle="Counts from the platform audit trail">
          <dl className="space-y-1.5 text-sm">
            {signIns.length ? signIns.map(([m, n]) => <div key={m} className="flex justify-between gap-3"><dt className="text-ink-3">Signed in with {METHOD_LABEL[m]?.toLowerCase() ?? m}</dt><dd className="fig text-ink">{n}</dd></div>) : <p className="text-ink-3">Nobody signed in.</p>}
            {([['Accounts locked', last24h.lockouts], ['Cards refused', last24h.cacRejected], ['Organization sign-ins refused', last24h.oidcRejected], ['Turned away from a console', last24h.consoleRefused], ['Card confirmations refused', last24h.stepUpRefused]] as Array<[string, number]>).map(([k, n]) => (
              <div key={k} className="flex justify-between gap-3"><dt className="text-ink-3">{k}</dt><dd className={`fig ${n ? 'text-warn' : 'text-ink'}`}>{n}</dd></div>
            ))}
          </dl>
        </Panel>
        {cac.mode !== 'off' && (
          <Panel title="CAC" subtitle={cac.mode === 'direct' ? `Revocation: ${cac.revocation === 'crl' ? 'lists in CAC_CRL_DIR' : 'off'}` : 'The gateway checks each card and its revocation'} className="lg:col-span-2">
            <p className="text-sm text-ink-2">Last CAC sign-in {cac.lastSignIn ? timeAgo(cac.lastSignIn) : 'never'}.{cac.policyOids ? ` Cards must carry one of ${cac.policyOids} certificate policies.` : ''}</p>
            {cac.mode === 'proxy' && <p className="mt-2 text-xs text-ink-3">Vantage cannot see the gateway’s revocation lists or trusted CAs. Ask the team that runs it to watch both.</p>}
            {cac.crls.length > 0 && (
              <Table className="scroll-x mt-3" minWidth={560} head={<><th>Revocation list</th><th>Issuer</th><th>Next update</th><th>State</th></>}>
                {cac.crls.map((c, i) => <tr key={`${c.file}:${i}`}><td className="mono text-2xs">{c.file}</td><td className="text-xs">{c.issuer ?? '—'}</td><td className="fig text-xs">{c.error ? <span className="text-bad">{c.error}</span> : c.nextUpdate ? `${formatStamp(c.nextUpdate)} (${timeAgo(c.nextUpdate)})` : 'not given'}</td><td><StatusBadge status={c.status} /></td></tr>)}
              </Table>
            )}
            {cac.cas.length > 0 && (
              <Table className="scroll-x mt-3" minWidth={480} head={<><th>Trusted CA</th><th>Valid until</th><th>State</th></>}>
                {cac.cas.map((c, i) => <tr key={`${c.subject}:${i}`}><td className="text-xs">{c.subject}</td><td className="fig text-xs">{c.validTo ? formatStamp(c.validTo) : '—'}</td><td><StatusBadge status={c.status} /></td></tr>)}
              </Table>
            )}
          </Panel>
        )}
        {oidc.enabled && (
          <Panel title="Organization sign-in" subtitle={oidc.issuerHost ?? undefined} action={can('platform.settings') ? <Button size="sm" onClick={checkProvider} loading={probing}><Fingerprint className="h-3.5 w-3.5" />Check the provider</Button> : undefined}>
            <p className="text-sm text-ink-2">Last organization sign-in {oidc.lastSignIn ? timeAgo(oidc.lastSignIn) : 'never'}. First sign-ins link by {oidc.linkBy === 'none' ? 'nothing: each opens its own account' : oidc.linkBy === 'edipi' ? 'EDIPI' : 'email address'}.</p>
            {probe && <p role="status" className={`mt-3 rounded-md border px-3 py-2 text-sm text-ink ${probe.ok ? 'border-good/40 bg-good/10' : 'border-bad/40 bg-bad/5'}`}>{probe.ok ? `Reached the provider at ${probe.authorizationHost}; it publishes ${probe.keys} signing ${probe.keys === 1 ? 'key' : 'keys'}.` : `Could not use the provider: ${probe.error}`}</p>}
          </Panel>
        )}
        <Panel title="Second factors" subtitle="Who could be signed in with a password alone">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Vantage staff without an authenticator, passkey or proven CAC</dt><dd className={`fig ${coverage.staffWithoutSecondFactor ? 'text-warn' : 'text-ink'}`}>{coverage.staffWithoutSecondFactor} of {coverage.staff}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Unit Managers with a password alone</dt><dd className="fig text-ink">{coverage.managersPasswordOnly} of {coverage.managers}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-ink-3">Counts only. Account support finds the people themselves.</p>
        </Panel>
      </div>
    </div>
  );
}

// ——— Feature flags ———

interface RuntimeFlag { key: string; label: string; hint: string; settings: string[]; on: boolean; blockedBy: string | null; reaches: { destination: string; mcen: 'refused' | 'approval' | 'enterprise' } | null; changedAt: string | null; changedBy: string | null }
interface EnvironmentFlag { key: string; label: string; on: boolean; value?: string; settings: string[]; hint: string }
interface InstanceFlagReport { flags: Array<{ key: string; label: string; hint: string; serviceOn: boolean }>; withheld: WithheldFlag[] }
interface FlagReport { profile: string; runtime: RuntimeFlag[]; selfServiceUnitLimit: number; environment: EnvironmentFlag[]; instances: InstanceFlagReport }

const REACH: Record<NonNullable<RuntimeFlag['reaches']>['mcen'], string> = { enterprise: 'an enterprise service', approval: 'a connection MCEN must approve', refused: 'a connection MCEN refuses' };

export function FeatureFlags() {
  const { data, isPending, error, refetch } = useAdmin<FlagReport>('flags', api.platformFlags);
  const can = usePlatformCan();
  const toast = useToast(); const qc = useQueryClient();
  const [pending, setPending] = useState<{ flag: RuntimeFlag; on: boolean } | null>(null);
  const [limit, setLimit] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const editable = can('platform.settings');
  const apply = async (patch: Record<string, unknown>, done: string) => {
    setBusy(true);
    try { await withSudo(() => api.platformRuntime(patch)); qc.invalidateQueries({ queryKey: keys.me }); qc.invalidateQueries({ queryKey: ['admin'] }); toast.success(done); }
    catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const selfService = data.runtime.find((f) => f.key === 'selfServiceUnits');
  return (
    <div className="space-y-4">
      <Panel title="Switched here" subtitle={editable ? 'Each change takes effect at once and is recorded in the platform audit trail' : 'Changing these takes Platform settings'}>
        <ul className="divide-y divide-line">
          {data.runtime.map((flag) => (
            <li key={flag.key} className="py-3 first:pt-0 last:pb-0">
              <Switch checked={flag.on} disabled={!editable || busy || (!flag.on && Boolean(flag.blockedBy))} onChange={(v) => setPending({ flag, on: v })} label={flag.label} description={flag.hint} />
              <div className="mt-1 space-y-0.5 pl-1 text-xs text-ink-3">
                {flag.blockedBy && !flag.on && <p className="text-warn">{flag.blockedBy}</p>}
                {flag.reaches && <p>Reaches {flag.reaches.destination}, {REACH[flag.reaches.mcen]}.</p>}
                <p>{flag.changedAt ? `Last changed ${timeAgo(flag.changedAt)}${flag.changedBy ? ` by ${flag.changedBy}` : ''}.` : 'Not changed from the console.'}{flag.settings.length ? <> Default from <span className="mono">{flag.settings.join(', ')}</span>.</> : null}</p>
              </div>
              {flag.key === 'selfServiceUnits' && flag.on && (
                <div className="mt-2 flex flex-wrap items-end gap-2 pl-1">
                  <Field label="Unit Instances one person may start"><Input inputMode="numeric" className="w-24" disabled={!editable} value={limit ?? String(data.selfServiceUnitLimit)} onChange={(e) => setLimit(e.target.value.replace(/\D/g, '').slice(0, 3))} /></Field>
                  {editable && limit !== null && Number(limit) !== data.selfServiceUnitLimit && <Button size="sm" variant="primary" loading={busy} onClick={async () => { await apply({ selfServiceUnitLimit: Number(limit) || 0 }, 'Limit saved.'); setLimit(null); refetch(); }}>Save limit</Button>}
                </div>
              )}
            </li>
          ))}
        </ul>
        {selfService && !selfService.on && data.profile === 'mcen' && <p className="mt-3 text-xs text-ink-3">On MCEN, Vantage Administrators provision Unit Instances from Unit Instances.</p>}
      </Panel>
      <Panel title="Set when the service is deployed" subtitle="Changed in the host’s environment and a restart, not here">
        <Table minWidth={560} head={<><th>Flag</th><th>State</th><th>Setting</th></>}>
          {data.environment.map((f) => (
            <tr key={f.key}>
              <td className="text-xs"><span className="text-ink">{f.label}</span><span className="block text-2xs text-ink-3">{f.hint}</span></td>
              <td><Badge tone={f.on ? 'good' : undefined}>{f.value && f.on ? humanize(f.value) : f.on ? 'On' : 'Off'}</Badge></td>
              <td className="mono text-2xs text-ink-3">{f.settings.join(', ')}</td>
            </tr>
          ))}
        </Table>
      </Panel>
      <InstanceFlags report={data.instances} editable={editable} refresh={() => refetch()} />
      <p className="text-xs text-ink-3">These flags are the whole service’s, and the features withheld from one Unit Instance. Each Unit Instance’s own settings belong to its Unit Managers.</p>
      <ConfirmDialog open={Boolean(pending)} onOpenChange={(o) => { if (!o) setPending(null); }} danger={false}
        title={pending ? `Turn ${pending.flag.label.toLowerCase()} ${pending.on ? 'on' : 'off'}?` : ''}
        body={pending ? <><p>{pending.flag.hint}</p><p className="mt-2 text-ink-3">It changes for everyone, in every Unit Instance, as soon as you confirm.</p></> : null}
        confirmLabel={pending?.on ? 'Turn on' : 'Turn off'}
        onConfirm={async () => { if (!pending) return; await apply({ [pending.flag.key]: pending.on }, `${pending.flag.label} ${pending.on ? 'on' : 'off'}.`); setPending(null); refetch(); }} />
    </div>
  );
}

/**
 * A feature withheld from one Unit Instance, with a reason its Lead Unit Managers are told (ADR-0014). Withholding never
 * turns on for one Unit Instance what the service has off.
 */
function InstanceFlags({ report, editable, refresh }: { report: InstanceFlagReport; editable: boolean; refresh: () => void }) {
  const { data: orgs } = useAdmin<{ organizations: Array<{ id: string; name: string; status: string }> }>('orgs', api.platformOrgs);
  const toast = useToast(); const qc = useQueryClient();
  const [draft, setDraft] = useState({ orgId: '', flag: '', reason: '' });
  const [confirm, setConfirm] = useState<null | { orgId: string; orgName: string; flag: string; label: string; withheld: boolean; reason: string }>(null);
  const [busy, setBusy] = useState(false);
  const label = (key: string) => report.flags.find((f) => f.key === key)?.label ?? key;
  const choices = (orgs?.organizations ?? []).filter((o) => o.status !== 'archived');
  const taken = new Set(report.withheld.map((w) => `${w.org_id}:${w.flag}`));
  const ready = draft.orgId && draft.flag && draft.reason.trim().length >= 10 && !taken.has(`${draft.orgId}:${draft.flag}`);
  const apply = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      await withSudo(() => api.platformInstanceFeature(confirm.orgId, confirm.flag, { withheld: confirm.withheld, reason: confirm.reason || null }));
      toast.success(confirm.withheld ? `${confirm.label} off for ${confirm.orgName}. Its Lead Unit Managers are told.` : `${confirm.label} follows the service again for ${confirm.orgName}.`);
      if (confirm.withheld) setDraft({ orgId: '', flag: '', reason: '' });
      setConfirm(null); refresh(); qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Panel title="Withheld from one Unit Instance" subtitle={editable ? 'Turns a feature off for one Unit Instance only; its Lead Unit Managers are told why' : 'Changing these takes Platform settings'}>
      <ul className="mb-3 space-y-1 text-xs text-ink-3">
        {report.flags.map((f) => <li key={f.key}><span className="text-ink">{f.label}</span>: {f.hint}{f.serviceOn ? '' : ' The service has it off for everyone at the moment.'}</li>)}
      </ul>
      {!report.withheld.length ? <p className="text-sm text-ink-3">Nothing is withheld. Every Unit Instance has every feature the service runs.</p> : (
        <Table minWidth={560} head={<><th>Unit Instance</th><th>Feature</th><th>Why</th><th>Since</th><th /></>}>
          {report.withheld.map((w) => (
            <tr key={`${w.org_id}:${w.flag}`}>
              <td className="text-xs">{w.org_name}</td>
              <td className="text-xs">{w.label}</td>
              <td className="max-w-xs text-xs text-ink-2">{w.reason}</td>
              <td className="fig text-xs text-ink-3">{formatStamp(w.set_at)}{w.set_by_name ? <span className="block">{w.set_by_name}</span> : null}</td>
              <td className="text-right">{editable && <Button size="sm" onClick={() => setConfirm({ orgId: w.org_id, orgName: w.org_name, flag: w.flag, label: w.label, withheld: false, reason: '' })}>Give it back</Button>}</td>
            </tr>
          ))}
        </Table>
      )}
      {editable && (
        <form className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); if (ready) { const org = choices.find((o) => o.id === draft.orgId); setConfirm({ orgId: draft.orgId, orgName: org?.name ?? 'the Unit Instance', flag: draft.flag, label: label(draft.flag), withheld: true, reason: draft.reason.trim() }); } }}>
          <Field label="Unit Instance"><Select aria-label="Unit Instance" value={draft.orgId} onValueChange={(v) => setDraft({ ...draft, orgId: v })} options={choices.map((o) => ({ value: o.id, label: o.name }))} placeholder="Choose" /></Field>
          <Field label="Feature"><Select aria-label="Feature" value={draft.flag} onValueChange={(v) => setDraft({ ...draft, flag: v })} options={report.flags.map((f) => ({ value: f.key, label: f.label }))} placeholder="Choose" /></Field>
          <Field label="Why" required hint="its Lead Unit Managers read this; at least ten characters" className="sm:col-span-2"><Textarea rows={2} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} maxLength={500} placeholder="Attachments paused while the command’s records officer reviews spillage" /></Field>
          <div className="sm:col-span-2"><Button type="submit" disabled={!ready}>Turn off for this Unit Instance</Button>{draft.orgId && draft.flag && taken.has(`${draft.orgId}:${draft.flag}`) && <span className="ml-3 text-xs text-ink-3">Already off there.</span>}</div>
        </form>
      )}
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} danger={Boolean(confirm?.withheld)} loading={busy}
        title={confirm ? (confirm.withheld ? `Turn ${confirm.label.toLowerCase()} off for ${confirm.orgName}?` : `Give ${confirm.orgName} ${confirm.label.toLowerCase()} back?`) : ''}
        body={confirm ? (confirm.withheld
          ? <><p>Nobody in {confirm.orgName} can use it until it is given back. What is already there stays readable. Its Lead Unit Managers are told, with your reason.</p><p className="mt-2 text-ink-3">Reason: {confirm.reason}</p></>
          : <p>{confirm.orgName} follows the service’s setting again, and its Lead Unit Managers are told.</p>) : null}
        confirmLabel={confirm?.withheld ? 'Turn off' : 'Give it back'} onConfirm={apply} />
    </Panel>
  );
}

// ——— Controlled maintenance ———

interface MaintenanceWindow { reason: string; message: string | null; until: string | null; startedAt: string; startedBy: string; startedByName: string }
interface TaskResult { task: string; label: string; ok: boolean; summary: string; detail: string[]; ms: number; at: string }
interface MaintenanceReport {
  maintenance: boolean; window: MaintenanceWindow | null; notice: string | null; overrun: boolean; maxHours: number;
  tasks: Array<{ key: string; label: string; hint: string; needsMaintenance: boolean }>;
  history: Array<{ at: string; action: string; task: string | null; detail: string | null; actor: string | null }>;
}

const STEP_LABEL: Record<string, string> = { maintenance_on: 'Started maintenance', maintenance_off: 'Ended maintenance', maintenance_task: 'Ran a task' };

export function Maintenance() {
  const { data, isPending, error, refetch } = useAdmin<MaintenanceReport>('maintenance', api.platformMaintenanceState);
  const can = usePlatformCan();
  const toast = useToast(); const qc = useQueryClient();
  const [draft, setDraft] = useState({ reason: '', message: '', until: '' });
  const [confirmStart, setConfirmStart] = useState(false);
  const [ending, setEnding] = useState(false); const [note, setNote] = useState('');
  const [results, setResults] = useState<Record<string, TaskResult>>({}); const [running, setRunning] = useState(''); const [busy, setBusy] = useState(false);
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const allowed = can('platform.maintenance');
  const refresh = () => { refetch(); qc.invalidateQueries({ queryKey: ['admin'] }); };
  const reasonOk = draft.reason.trim().length >= 10;
  const start = async () => {
    setBusy(true);
    try {
      await withSudo(() => api.platformMaintenance({ enabled: true, reason: draft.reason.trim(), message: draft.message.trim() || null, until: draft.until ? new Date(draft.until).toISOString() : null }));
      toast.success('Maintenance is on. Only Vantage staff can sign in.'); setDraft({ reason: '', message: '', until: '' }); refresh();
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); setConfirmStart(false); }
  };
  const end = async () => {
    setBusy(true);
    try { await withSudo(() => api.platformMaintenance({ enabled: false, note: note.trim() || null })); toast.success('Maintenance is off. Vantage is open again.'); setNote(''); setEnding(false); refresh(); }
    catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const run = async (key: string) => {
    setRunning(key);
    try { const r = await withSudo(() => api.platformMaintenanceTask(key)) as TaskResult; setResults((all) => ({ ...all, [key]: r })); refetch(); }
    catch (e) { toast.error(api.errorText(e)); } finally { setRunning(''); }
  };
  const w = data.window;
  return (
    <div className="space-y-4">
      <Panel title="Maintenance mode" subtitle="Closes Vantage to everyone but Vantage staff, in every Unit Instance" action={<Badge tone={data.maintenance ? 'warn' : 'good'}>{data.maintenance ? 'On' : 'Off'}</Badge>}>
        {data.maintenance ? (
          <div className="space-y-3">
            <dl className="space-y-1.5 text-sm">
              {w && <div className="flex flex-wrap justify-between gap-3"><dt className="text-ink-3">Started</dt><dd className="text-right text-ink">{formatStamp(w.startedAt)} ({timeAgo(w.startedAt)}) by {w.startedByName}</dd></div>}
              {w && <div className="flex flex-wrap justify-between gap-3"><dt className="text-ink-3">Reason</dt><dd className="text-right text-ink">{w.reason}</dd></div>}
              {w?.until && <div className="flex flex-wrap justify-between gap-3"><dt className="text-ink-3">Expected end</dt><dd className={`text-right ${data.overrun ? 'text-warn' : 'text-ink'}`}>{formatStamp(w.until)} ({timeAgo(w.until)}){data.overrun ? ', past' : ''}</dd></div>}
              <div className="flex flex-wrap justify-between gap-3"><dt className="text-ink-3">Everyone else is told</dt><dd className="text-right text-ink">{data.notice}</dd></div>
            </dl>
            {allowed && <Button variant="primary" onClick={() => setEnding(true)}><Power className="h-4 w-4" />End maintenance</Button>}
          </div>
        ) : allowed ? (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (reasonOk) setConfirmStart(true); }}>
            <Field label="Why" required hint="for Vantage staff and the audit trail; at least ten characters"><Textarea rows={2} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} maxLength={300} placeholder="Restoring the database from last night’s backup" /></Field>
            <Field label="What everyone else is told" hint="on the sign-in page and in every refused request; blank says scheduled maintenance"><Input value={draft.message} onChange={(e) => setDraft({ ...draft, message: e.target.value })} maxLength={240} placeholder="Vantage is being upgraded" /></Field>
            <Field label="Expected end" hint={`in your browser’s time zone, within ${Math.round(data.maxHours / 24)} days; maintenance ends only when somebody ends it`}><Input type="datetime-local" className="max-w-xs" value={draft.until} onChange={(e) => setDraft({ ...draft, until: e.target.value })} /></Field>
            <Button type="submit" variant="primary" disabled={!reasonOk} loading={busy}><Wrench className="h-4 w-4" />Start maintenance</Button>
          </form>
        ) : <p className="text-sm text-ink-2">Starting and ending maintenance takes Controlled maintenance, which Vantage Administrators hold.</p>}
      </Panel>

      <Panel title="Database tasks" subtitle="An allowlist; each run is recorded in the platform audit trail">
        <ul className="divide-y divide-line">
          {data.tasks.map((t) => {
            const r = results[t.key];
            const blocked = t.needsMaintenance && !data.maintenance;
            return (
              <li key={t.key} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1"><p className="text-sm font-medium text-ink">{t.label}{t.needsMaintenance && <Badge className="ml-2" tone="warn">During maintenance</Badge>}</p><p className="text-xs text-ink-3">{t.hint}</p></div>
                  {allowed && <Button size="sm" onClick={() => run(t.key)} loading={running === t.key} disabled={Boolean(running) || blocked} aria-label={`Run: ${t.label}`}><Play className="h-3.5 w-3.5" />Run</Button>}
                </div>
                {r && (
                  <div role="status" className={`mt-2 rounded-md border px-3 py-2 text-sm text-ink ${r.ok ? 'border-good/40 bg-good/10' : 'border-warn/40 bg-warn/10'}`}>
                    <p>{r.summary} <span className="fig text-xs text-ink-3">({r.ms} ms)</span></p>
                    {r.detail.length > 0 && <ul className="mt-1 space-y-0.5 font-mono text-2xs text-ink-2">{r.detail.map((d) => <li key={d}>{d}</li>)}</ul>}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel title="Recent maintenance" subtitle="From the platform audit trail">
        {!data.history.length ? <p className="text-sm text-ink-3">Nothing yet.</p> : (
          <Table minWidth={560} head={<><th className="w-36">When</th><th className="w-40">Step</th><th className="w-32">By</th><th>Detail</th></>}>
            {data.history.map((h, i) => <tr key={`${h.at}:${i}`}><td className="fig text-xs text-ink-3">{formatStamp(h.at)}</td><td className="text-xs">{STEP_LABEL[h.action] ?? humanize(h.action)}</td><td className="text-xs">{h.actor ?? 'system'}</td><td className="max-w-md truncate text-xs text-ink-2" title={h.detail ?? ''}>{h.detail}</td></tr>)}
          </Table>
        )}
      </Panel>

      <ConfirmDialog open={confirmStart} onOpenChange={setConfirmStart} danger={false} loading={busy}
        title="Close Vantage to everyone but Vantage staff?"
        body={<><p>People signed in are stopped at their next request, and nobody else can sign in until maintenance ends. Every other Vantage staff member is told.</p><p className="mt-2 text-ink-3">Reason: {draft.reason.trim()}</p></>}
        confirmLabel="Start maintenance" onConfirm={start} />
      <Dialog open={ending} onOpenChange={setEnding} title="End maintenance and open Vantage again?" size="sm"
        footer={<><Button variant="ghost" onClick={() => setEnding(false)}>Cancel</Button><Button variant="primary" loading={busy} onClick={end}>End maintenance</Button></>}>
        <Field label="Note" hint="optional; goes in the audit trail"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="Restore finished; integrity checks passed" /></Field>
      </Dialog>
    </div>
  );
}

/** Across every page of the console while maintenance is on, so nobody forgets it. */
export function MaintenanceBanner() {
  const { data } = useAdmin<MaintenanceReport>('maintenance', api.platformMaintenanceState);
  if (!data?.maintenance) return null;
  return (
    <div role="status" className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-sm text-ink lg:px-8">
      <Wrench className="mr-1.5 inline h-4 w-4 text-warn" aria-hidden />Maintenance is on{data.window ? ` since ${timeAgo(data.window.startedAt)}, started by ${data.window.startedByName}` : ''}. Only Vantage staff can sign in. <Link className="link" to="/maintenance">Maintenance</Link>
    </div>
  );
}
