import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Play, Power, RefreshCw, Wrench } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Panel, Skeleton, Switch, Textarea, type Tone } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { Table } from '@/components/common';
import { keys } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatStamp, humanize, timeAgo } from '@/lib/utils';
import { useAdmin } from './sections';
import { usePlatformCan } from './people';

/**
 * The Vantage Administrator console's operations pages (ADR-0011): the service's health, its sign-in health, its feature
 * flags and controlled maintenance. Each describes the service; none shows what a Unit Instance keeps.
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

const mb = (bytes: number | null | undefined) => (bytes == null ? '—' : bytes < 1_048_576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1_048_576).toFixed(1)} MB`);
const every = (ms: number) => (ms >= 86_400_000 ? `every ${ms / 86_400_000} d` : ms >= 3_600_000 ? `every ${ms / 3_600_000} h` : `every ${Math.round(ms / 60_000)} min`);
const uptime = (s: number) => (s >= 86_400 ? `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`);

function Failed({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="card"><EmptyState title="Could not load" description={api.errorText(error)} action={<Button onClick={retry}>Retry</Button>} /></div>;
}

export function CheckList({ checks }: { checks: HealthCheck[] }) {
  if (!checks.length) return <p className="text-sm text-ink-3">Nothing to report.</p>;
  return (
    <ul className="divide-y divide-line">
      {checks.map((c) => (
        <li key={c.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 first:pt-0 last:pb-0">
          <span className="w-24 shrink-0"><StatusBadge status={c.status} /></span>
          <span className="w-40 shrink-0 text-sm font-medium text-ink">{c.label}</span>
          <span className="min-w-0 flex-1 text-sm text-ink-2">{c.summary}</span>
        </li>
      ))}
    </ul>
  );
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
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Vantage staff without an authenticator or passkey</dt><dd className={`fig ${coverage.staffWithoutSecondFactor ? 'text-warn' : 'text-ink'}`}>{coverage.staffWithoutSecondFactor} of {coverage.staff}</dd></div>
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
interface FlagReport { profile: string; runtime: RuntimeFlag[]; selfServiceUnitLimit: number; environment: EnvironmentFlag[] }

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
      <p className="text-xs text-ink-3">These flags are the whole service’s. Each Unit Instance’s own settings belong to its Unit Managers.</p>
      <ConfirmDialog open={Boolean(pending)} onOpenChange={(o) => { if (!o) setPending(null); }} danger={false}
        title={pending ? `Turn ${pending.flag.label.toLowerCase()} ${pending.on ? 'on' : 'off'}?` : ''}
        body={pending ? <><p>{pending.flag.hint}</p><p className="mt-2 text-ink-3">It changes for everyone, in every Unit Instance, as soon as you confirm.</p></> : null}
        confirmLabel={pending?.on ? 'Turn on' : 'Turn off'}
        onConfirm={async () => { if (!pending) return; await apply({ [pending.flag.key]: pending.on }, `${pending.flag.label} ${pending.on ? 'on' : 'off'}.`); setPending(null); refetch(); }} />
    </div>
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
