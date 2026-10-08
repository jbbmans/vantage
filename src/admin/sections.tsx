import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, RefreshCw, Unlock, Mail, Download, Upload, Database, ShieldCheck, Users, Building2, Wrench, Sparkles, KeyRound, HeartPulse } from 'lucide-react';
import { Button, Field, Input, Textarea, Panel, Badge, Switch, Skeleton, Stat, EmptyState, Select, type Tone } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { Table } from '@/components/common';
import { keys, signOutEverywhere } from '@/lib/queries';
import * as api from '@/lib/api';
import UsageConsole from '@/components/UsageConsole';
export { UsageConsole };
import EmailConsole from '@/components/EmailConsole';
export { EmailConsole };
import { PersonnelConsole, RetentionConsole, PrivacyConsole } from '@/components/GovernanceConsole';
export { PersonnelConsole, RetentionConsole, PrivacyConsole };
import { formatStamp, humanize, timeAgo } from '@/lib/utils';
import { DEFAULT_METRICS, CATEGORY_PALETTE, type MetricsConfig } from '../../shared/constants';

/** Platform data, behind a recent password confirmation like everything in the Vantage Administrator console. */
export function useAdmin<T = any>(key: string, fn: () => Promise<T>) { return useQuery<T>({ queryKey: ['admin', key], queryFn: () => withSudo(fn), retry: false }); }

export function Overview() {
  const { data, isPending, error, refetch } = useAdmin('overview', api.platformOverview);
  const toast = useToast();
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <div className="card"><EmptyState title="Could not load" description={api.errorText(error)} action={<Button onClick={() => refetch()}>Retry</Button>} /></div>;
  const mb = (n: number | null) => (n == null ? '—' : `${(n / 1_048_576).toFixed(1)} MB`);
  return (
    <div className="space-y-4">
      {data.health && <HealthStrip health={data.health} />}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Unit Instances" value={data.organizations.active} hint={`${data.organizations.suspended} suspended · ${data.organizations.archived} archived${data.organizations.withoutOwner ? ` · ${data.organizations.withoutOwner} without an owner` : ''}`} icon={Building2} tone={data.organizations.withoutOwner ? 'warn' : undefined} />
        <Stat label="Active accounts" value={data.users} hint={`${data.inactiveUsers} inactive${data.lockedUsers ? ` · ${data.lockedUsers} locked` : ''} · ${data.staff} Vantage staff`} icon={Users} />
        <Stat label="Vantage access" value={data.access.active} hint={`${data.access.pending} waiting on a Unit Instance · support queue ${data.support.open}`} icon={KeyRound} />
        <Stat label="Database" value={mb(data.database.sizeBytes)} hint={`of ${mb(data.database.maxBytes)} safety threshold`} icon={Database} tone={data.database.sizeBytes && data.database.sizeBytes > data.database.maxBytes * 0.8 ? 'warn' : undefined} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Service"><dl className="space-y-1.5 text-sm">{[['Version', `${data.version} · schema ${data.schemaVersion}`], ...(data.build && data.build !== data.version ? [['Build', String(data.build).slice(0, 12)]] : []), ['Node', data.node], ['Uptime', `${Math.round(data.uptime / 3600)} h`], ...(data.deployment?.publicSite === false ? [] : [['Public site', data.urls.site]]), ['App', data.urls.app], ['Unit Manager console', data.urls.console], ['Vantage Administrator console', data.urls.admin], ['Passkey domain', data.rpId], ['Units', data.units], ['Time zone', data.timezone], ['Sessions open', data.sessions], ['MFA users', `${data.mfaUsers} authenticator · ${data.passkeyUsers} passkey`]].map(([k, v]) => <div key={String(k)} className="flex justify-between gap-3"><dt className="text-ink-3">{k}</dt><dd className="fig truncate text-right text-ink">{String(v)}</dd></div>)}</dl></Panel>
        <Panel title="Email" subtitle={data.email.enabled ? `${data.email.provider} · from ${data.email.from}` : 'not configured'} action={data.email.enabled ? <Button size="sm" onClick={async () => { try { await withSudo(() => api.platformEmailTest()); toast.success('Test email sent to you.'); } catch (e) { toast.error(api.errorText(e)); } }}><Mail className="h-3.5 w-3.5" />Send test</Button> : undefined}>
          {!data.email.enabled ? <p className="text-sm text-ink-2">Turn email on to send reset links, invitations and digests. The Email tab shows how to send from your own domain with no email service.</p> : !data.email.recent.length ? <p className="text-sm text-ink-3">No email sent yet.</p> : <ul className="space-y-1 text-xs">{data.email.recent.map((m: any, i: any) => <li key={i} className="flex justify-between gap-2"><span className="truncate text-ink">{m.kind} → {m.to_address}</span><span className={m.status === 'sent' ? 'text-good' : m.status === 'queued' ? 'text-warn' : 'text-bad'}>{m.status}{m.error ? `: ${m.error}` : ''}</span></li>)}</ul>}
        </Panel>
        <Panel title="Audit chain" subtitle="Tamper-evident log">
          <p className="text-sm"><Badge tone={data.audit.ok ? 'good' : 'bad'}>{data.audit.ok ? 'Intact' : 'Broken'}</Badge> <span className="fig text-ink-2">{data.audit.count} entries</span></p>
          {!data.audit.ok && <p className="mt-2 text-xs text-bad">{data.audit.reason}. Restore from a backup taken before that point and investigate.</p>}
          <AuditForwarding status={data.auditForwarding} />
          <CaseHistories />
          <p className="mt-3 text-sm text-ink-2">MARADMIN feed: {data.maradmins.enabled ? `${data.maradmins.count} cached · last sync ${data.maradmins.lastSuccess ? timeAgo(data.maradmins.lastSuccess) : 'never'}` : 'off'}{data.maradmins.lastError ? <span className="block text-xs text-warn">{data.maradmins.lastError}</span> : null}</p>
          {data.maradmins.enabled && <Button size="sm" className="mt-2" onClick={async () => { try { const r = await withSudo(() => api.platformSyncMaradmins()); toast.success(`Synced: ${r.inserted ?? 0} new, ${r.updated ?? 0} updated.`); refetch(); } catch (e) { toast.error(api.errorText(e)); } }}><RefreshCw className="h-3.5 w-3.5" />Sync now</Button>}
        </Panel>
      </div>
      {data.deployment && <Deployment posture={data.deployment} />}
    </div>
  );
}

type HealthTone = 'ok' | 'warn' | 'fail' | 'info';
const HEALTH: Record<HealthTone, [string, Tone]> = { ok: ['Healthy', 'good'], warn: ['Needs attention', 'warn'], fail: ['Failing', 'bad'], info: ['Healthy', 'good'] };

/** The service's health in one line, with what needs attention; the Operations page has every check (ADR-0011). */
function HealthStrip({ health }: { health: { status: HealthTone; attention: Array<{ id: string; label: string; status: HealthTone; summary: string }> } }) {
  const [label, tone] = HEALTH[health.status];
  return (
    <Panel title={<span className="flex items-center gap-2"><HeartPulse className="h-4 w-4 text-ink-3" aria-hidden />Health <Badge tone={tone}>{label}</Badge></span>} action={<Link className="link text-sm" to="/operations">Operations</Link>}>
      {!health.attention.length ? <p className="text-sm text-ink-2">Every check passes.</p> : (
        <ul className="space-y-1 text-sm">{health.attention.map((c) => <li key={c.id}><Badge tone={c.status === 'fail' ? 'bad' : 'warn'}>{c.label}</Badge> <span className="text-ink-2">{c.summary}</span></li>)}</ul>
      )}
    </Panel>
  );
}

interface DeploymentPosture {
  profile: 'mcen' | 'legacy-public' | 'development'; inferred: boolean; topology: 'shared' | 'dedicated'; publicSite: boolean; unitInstances: number;
  locked: string[]; notes: string[];
  outbound: Array<{ id: string; purpose: string; destination: string; enabled: boolean; settings: string[]; mcen: 'refused' | 'approval' | 'enterprise' }>;
}
const PROFILE_LABEL: Record<DeploymentPosture['profile'], string> = { mcen: 'MCEN', 'legacy-public': 'Legacy public site', development: 'Development' };
const MCEN_LABEL: Record<DeploymentPosture['outbound'][number]['mcen'], [string, 'good' | 'warn' | 'bad']> = { enterprise: ['Enterprise service', 'good'], approval: ['Needs an approved connection', 'warn'], refused: ['Refused on MCEN', 'bad'] };

/** Where this deployment runs, how many Unit Instances it may hold, and every connection it can open beyond itself (ADR-0007). */
function Deployment({ posture }: { posture: DeploymentPosture }) {
  return (
    <Panel title="Deployment" subtitle={`${PROFILE_LABEL[posture.profile]}${posture.inferred ? ' (not set, inferred)' : ''} · ${posture.topology === 'dedicated' ? 'dedicated to one Unit Instance' : `shared by ${posture.unitInstances} Unit ${posture.unitInstances === 1 ? 'Instance' : 'Instances'}`}`}>
      {posture.notes.length > 0 && <ul className="mb-3 space-y-0.5 text-xs text-warn">{posture.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      {posture.locked.length > 0 && <p className="mb-3 text-xs text-ink-2">Held off by this profile: {posture.locked.map(humanize).join(', ')}.</p>}
      <p className="text-sm text-ink-2">Outbound connections</p>
      <ul className="mt-1 space-y-1 text-xs">
        {posture.outbound.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-ink">{c.purpose} <span className="fig text-ink-3">{c.enabled ? c.destination : 'off'}</span></span>
            <span className="flex items-center gap-2"><Badge tone={c.enabled ? 'good' : undefined}>{c.enabled ? 'On' : 'Off'}</Badge><Badge tone={MCEN_LABEL[c.mcen][1]}>{MCEN_LABEL[c.mcen][0]}</Badge></span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

/** Where the audit records go besides this database. Without a copy off the host, the chain proves nothing against whoever holds the host. */
function AuditForwarding({ status }: { status?: { stdout: boolean; syslog: null | { target: string; connected: boolean; sent: number; dropped: number; queued: number; lastError: string | null } } }) {
  if (!status) return null;
  const off = !status.stdout && !status.syslog;
  return (
    <div className="mt-3 border-t border-line pt-3 text-sm">
      <p className="text-ink-2">Copies off this host</p>
      {off
        ? <p className="mt-1 text-xs text-warn">None. Somebody holding this server and its secret could rewrite the chain unseen. Set VANTAGE_AUDIT_SYSLOG to your SIEM, or VANTAGE_AUDIT_STDOUT=true where the platform keeps container logs.</p>
        : <ul className="mt-1 space-y-0.5 text-xs text-ink-2">
            {status.stdout && <li>Standard output, one JSON line per record</li>}
            {status.syslog && <li><Badge tone={status.syslog.lastError ? 'warn' : 'good'}>{status.syslog.lastError ? 'Retrying' : 'Sending'}</Badge> <span className="fig">{status.syslog.target} · {status.syslog.sent} sent{status.syslog.queued ? ` · ${status.syslog.queued} waiting` : ''}{status.syslog.dropped ? ` · ${status.syslog.dropped} dropped` : ''}</span>{status.syslog.lastError && <span className="block text-warn">{status.syslog.lastError}</span>}</li>}
          </ul>}
    </div>
  );
}

/** Every case's history is sealed entry by entry, and the heads are written into the audit chain each day. */
function CaseHistories() {
  const toast = useToast();
  const [result, setResult] = useState<any>(null); const [busy, setBusy] = useState(false);
  const check = async () => { setBusy(true); try { setResult((await withSudo(() => api.platformIntegrity())).cases); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  const anchor = async () => { try { const r = await withSudo(() => api.platformAnchorCases()); toast.success(`${r.cases} case ${r.cases === 1 ? 'history' : 'histories'} written into the audit chain.`); } catch (e) { toast.error(api.errorText(e)); } };
  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="text-sm text-ink-2">Case histories</p>
      {result && <p className="mt-1 text-sm"><Badge tone={result.ok ? 'good' : 'bad'}>{result.ok ? 'Intact' : 'Broken'}</Badge> <span className="fig text-ink-2">{result.checked} checked{result.unsealed ? ` · ${result.unsealed} from before sealing` : ''}</span></p>}
      {result && !result.ok && <ul className="mt-1 space-y-0.5 text-xs text-bad">{result.broken.map((b: { work_item_id: string; reason?: string }) => <li key={b.work_item_id}><a className="link" href={`/work/items/${b.work_item_id}`}>Case {b.work_item_id.slice(0, 8)}</a>: {b.reason}</li>)}</ul>}
      <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" onClick={check} loading={busy}><ShieldCheck className="h-3.5 w-3.5" />Check them</Button><Button size="sm" variant="ghost" onClick={anchor}>Anchor now</Button></div>
    </div>
  );
}

export function RuntimeSettings() {
  const { data, isPending, refetch } = useAdmin('overview', api.platformOverview);
  const toast = useToast(); const qc = useQueryClient();
  const [form, setForm] = useState<{ displayName: string; announcement: string } | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (data?.runtime && !form) setForm({ displayName: data.runtime.displayName, announcement: data.runtime.announcement }); }, [data, form]);
  if (isPending || !form) return <Skeleton className="h-64" />;
  const save = async () => { setBusy(true); try { await withSudo(() => api.platformRuntime({ displayName: form.displayName, announcement: form.announcement })); qc.invalidateQueries({ queryKey: keys.me }); refetch(); toast.success('Settings saved.'); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Identity" action={<Button size="sm" variant="primary" onClick={save} loading={busy}><Save className="h-4 w-4" />Save</Button>}>
        <div className="space-y-3">
          <Field label="Display name" hint="shown on the sign-in page and in authenticator apps"><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
          <Field label="Announcement" hint="a banner for everyone, in every Unit Instance; blank hides it"><Textarea rows={2} value={form.announcement} onChange={(e) => setForm({ ...form, announcement: e.target.value })} maxLength={240} /></Field>
        </div>
      </Panel>
      <Panel title="Switches and maintenance">
        <p className="text-sm text-ink-2">Self-registration, self-service Unit Instances, attachments, the MARADMIN feed and AI are on <Link className="link" to="/flags">Feature flags</Link>, beside the flags set when the service is deployed. Maintenance mode, with its reason and the database tasks, is on <Link className="link" to="/maintenance">Maintenance</Link>.</p>
      </Panel>
    </div>
  );
}

export function MetricsSettings() {
  const { data, isPending, refetch } = useAdmin('overview', api.platformOverview);
  const toast = useToast(); const qc = useQueryClient();
  const [form, setForm] = useState<MetricsConfig | null>(null); const [busy, setBusy] = useState(false); const [dirty, setDirty] = useState(false);
  useEffect(() => { if (data?.runtime?.metrics && !form) setForm(structuredClone(data.runtime.metrics)); }, [data, form]);
  if (isPending || !form) return <Skeleton className="h-64" />;
  const update = (patch: Partial<MetricsConfig>) => { setForm({ ...form, ...patch }); setDirty(true); };
  const slug = (label: string) => label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  const save = async () => {
    setBusy(true);
    try {
      const cleaned: MetricsConfig = { ...form, value_types: form.value_types.filter((t) => t.label.trim()).map((t) => ({ ...t, key: t.key || slug(t.label), label: t.label.trim(), verb: (t.verb || t.label).trim().toLowerCase(), definition: (t.definition || '').trim() })), categories: form.categories.filter((c) => c.name.trim()).map((c) => ({ ...c, name: c.name.trim() })), unit_suggestions: form.unit_suggestions.map((u) => u.trim()).filter(Boolean) };
      await withSudo(() => api.platformRuntime({ metrics: cleaned }));
      qc.invalidateQueries({ queryKey: keys.me }); refetch(); setForm(cleaned); setDirty(false);
      toast.success('Metrics saved. Forms and reports use the new definitions now.');
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const summable = form.value_types.filter((t) => t.summable).map((t) => t.label).join(', ');
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Money metric" subtitle="The headline number and what it is called" action={<Button size="sm" variant="primary" onClick={save} loading={busy} disabled={!dirty}><Save className="h-4 w-4" />Save metrics</Button>}>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label="Label" hint="appears on stat cards and reports, e.g. Dollars, Funds, Hours billed"><Input value={form.currency_label} onChange={(e) => update({ currency_label: e.target.value })} maxLength={30} /></Field>
          <Field label="Symbol" hint="prefix"><Input value={form.currency_symbol} onChange={(e) => update({ currency_symbol: e.target.value })} maxLength={4} /></Field>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-ink-3">Headline totals add up the types marked <strong className="text-ink-2">counts toward headline</strong>{summable ? ` (${summable})` : ''}; the rest are shown separately so money that only crossed a desk is never claimed as money moved.</p>
        <div className="mt-4 flex items-center justify-between"><p className="text-xs font-semibold text-ink-2">Value types</p><Button size="xs" variant="ghost" onClick={() => update({ value_types: [...form.value_types, { key: '', label: '', verb: '', summable: true, definition: '' }] })} disabled={form.value_types.length >= 20}>Add type</Button></div>
        <ul className="mt-2 space-y-2">
          {form.value_types.map((t, i) => (
            <li key={i} className="rounded-md border border-line p-2">
              <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                <Field label="Label"><Input aria-label={`Value type ${i + 1} label`} value={t.label} onChange={(e) => { const v = [...form.value_types]; v[i] = { ...t, label: e.target.value, key: t.key || slug(e.target.value) }; update({ value_types: v }); }} placeholder="Reconciled" /></Field>
                <Field label="Verb" hint="in bullets"><Input aria-label={`Value type ${i + 1} verb`} value={t.verb} onChange={(e) => { const v = [...form.value_types]; v[i] = { ...t, verb: e.target.value }; update({ value_types: v }); }} placeholder="reconciled" /></Field>
                <button type="button" className="mb-2 text-xs text-ink-3 hover:text-bad" onClick={() => update({ value_types: form.value_types.filter((_, j) => j !== i) })} aria-label={`Remove value type ${t.label || i + 1}`} disabled={form.value_types.length <= 1}>Remove</button>
              </div>
              <Input aria-label={`Value type ${i + 1} definition`} className="mt-2" value={t.definition} onChange={(e) => { const v = [...form.value_types]; v[i] = { ...t, definition: e.target.value }; update({ value_types: v }); }} placeholder="What counts as this type" maxLength={200} />
              <div className="mt-1 flex items-center justify-between gap-2"><span className="mono text-2xs text-ink-3">key {t.key || slug(t.label) || '…'}</span><Switch checked={t.summable} onChange={(v) => { const list = [...form.value_types]; list[i] = { ...t, summable: v }; update({ value_types: list }); }} label={<span className="text-xs">Counts toward headline</span>} /></div>
            </li>
          ))}
        </ul>
      </Panel>
      <div className="space-y-4">
        <Panel title="Categories" subtitle="How entries are grouped on dashboards and in reports" action={<Button size="xs" variant="ghost" onClick={() => update({ categories: [...form.categories, { name: '', color: CATEGORY_PALETTE[form.categories.length % CATEGORY_PALETTE.length] }] })} disabled={form.categories.length >= 40}>Add category</Button>}>
          <ul className="space-y-1.5">
            {form.categories.map((c, i) => (
              <li key={i} className="flex items-center gap-2">
                <input type="color" aria-label={`Category ${i + 1} color`} value={c.color} onChange={(e) => { const v = [...form.categories]; v[i] = { ...c, color: e.target.value }; update({ categories: v }); }} className="h-8 w-8 shrink-0 cursor-pointer rounded-md border border-line bg-transparent p-0.5" />
                <Input aria-label={`Category ${i + 1} name`} value={c.name} onChange={(e) => { const v = [...form.categories]; v[i] = { ...c, name: e.target.value }; update({ categories: v }); }} placeholder="Category name" maxLength={60} />
                <button type="button" className="text-xs text-ink-3 hover:text-bad" onClick={() => update({ categories: form.categories.filter((_, j) => j !== i) })} aria-label={`Remove category ${c.name || i + 1}`} disabled={form.categories.length <= 1}>Remove</button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-2xs text-ink-3">Existing entries keep their category name even if you remove it here; they simply stop being offered for new entries.</p>
        </Panel>
        <Panel title="Unit suggestions" subtitle="Offered while typing an action unit">
          <Textarea aria-label="Unit suggestions" rows={3} value={form.unit_suggestions.join(', ')} onChange={(e) => update({ unit_suggestions: e.target.value.split(/[,\n]/).map((u) => u.trim()).filter(Boolean).slice(0, 60) })} placeholder="ULOs, MIPRs, documents, hours" />
        </Panel>
        <Panel title="Reset">
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-ink-2">Back to the G-8 comptroller defaults: dollars, five value types, ten categories.</p><Button onClick={() => { setForm(structuredClone(DEFAULT_METRICS)); setDirty(true); }}>Load defaults</Button></div>
        </Panel>
      </div>
    </div>
  );
}

export function AiSettings() {
  const { data, isPending, refetch } = useAdmin('ai', api.platformAi);
  const toast = useToast(); const qc = useQueryClient();
  const [models, setModels] = useState<string[] | null>(null); const [def, setDef] = useState(''); const [enabled, setEnabled] = useState<boolean | null>(null); const [add, setAdd] = useState(''); const [discovered, setDiscovered] = useState<string[] | null>(null); const [busy, setBusy] = useState(false);
  const [probeKey, setProbeKey] = useState(''); const [probe, setProbe] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null); const [probing, setProbing] = useState(false);
  useEffect(() => { if (data && models == null) { setModels(data.models); setDef(data.default_model); setEnabled(data.enabled); } }, [data, models]);
  if (isPending || !data || models == null) return <Skeleton className="h-64" />;
  const blocked = data.last_error_code === 'network_blocked';
  const lastError = data.last_error_code ? (blocked ? 'GenAI.mil refused the last call because this server is outside DoD networks.' : `The last call failed (${data.last_error_code}) ${timeAgo(data.last_error_at)}.`) : null;
  const probeFromBrowser = async () => {
    setProbing(true); setProbe(null);
    try {
      const res = await fetch(`${data.base_url}/models`, { headers: { authorization: `Bearer ${probeKey.trim()}` } });
      if (res.ok) { const body = await res.json().catch(() => ({})); const n = Array.isArray(body?.data) ? body.data.length : 0; setProbe({ tone: 'good', text: `Reachable from this browser · ${n} models offered. Calls made from a device on this network would work.` }); }
      else setProbe({ tone: res.status === 401 || res.status === 403 ? 'warn' : 'bad', text: res.status === 401 || res.status === 403 ? `Reachable from this browser, but GenAI.mil rejected that key (${res.status}).` : `GenAI.mil answered ${res.status} from this browser. A 503 means this device is outside DoD networks too.` });
    } catch { setProbe({ tone: 'bad', text: 'This browser could not reach GenAI.mil at all: the network blocks it, or the gateway does not allow calls from web pages.' }); }
    finally { setProbing(false); }
  };
  const save = async () => { setBusy(true); try { await withSudo(() => api.platformRuntime({ aiEnabled: Boolean(enabled), aiModels: models, aiDefaultModel: def })); qc.invalidateQueries({ queryKey: keys.me }); qc.invalidateQueries({ queryKey: keys.aiStatus }); refetch(); toast.success('AI settings saved.'); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="GenAI.mil" subtitle={data.configured ? `key ${data.key_fingerprint} · ${data.base_url}` : 'no key configured'} action={<Button size="sm" variant="primary" onClick={save} loading={busy}><Save className="h-4 w-4" />Save</Button>}>
        {!data.configured && <p className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink">No GenAI.mil key is set on the service. In the host’s environment settings, add VANTAGE_GENAI_API_KEY with the GenAI.mil key, save, and let it redeploy. The switch below unlocks once the key is present.</p>}
        <Switch checked={Boolean(enabled)} onChange={setEnabled} label="AI assistance on" description="Users see drafting help and can pick a model from the list below." disabled={!data.configured} />
        {lastError && <div className={`mt-3 rounded-md border px-3 py-2 text-sm text-ink ${blocked ? 'border-bad/40 bg-bad/5' : 'border-warn/40 bg-warn/10'}`}><p className="font-medium">{lastError}</p>{blocked && <p className="mt-1 text-xs text-ink-2">GenAI.mil only accepts calls from DoD networks. A server on Render, or any commercial host, is outside them, so every AI request fails whatever the key. AI will work once Vantage runs on a DoD-network host. Use the check below to see whether the device you are on can reach the gateway.</p>}</div>}
        {data.locked && <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-sm"><span className="text-ink">Key locked by the gateway since {timeAgo(data.locked_at)}{data.unlock_url ? <a className="link ml-1" href={data.unlock_url} target="_blank" rel="noopener noreferrer">unlock at GenAI.mil</a> : ''}.</span><Button size="sm" onClick={async () => { try { await withSudo(() => api.platformAiUnlock()); refetch(); toast.success('Lock cleared. The next request will tell.'); } catch (e) { toast.error(api.errorText(e)); } }}><Unlock className="h-3.5 w-3.5" />Clear</Button></div>}
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold text-ink-2">Models users may choose</p>
          <ul className="space-y-1">{models.map((m) => <li key={m} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5 text-sm"><span className="mono text-ink">{m}</span><span className="flex items-center gap-2">{def === m ? <Badge tone="accent">Default</Badge> : <button type="button" className="text-xs text-accent hover:underline" onClick={() => setDef(m)}>Make default</button>}<button type="button" className="text-ink-3 hover:text-bad" onClick={() => { const next = models.filter((x) => x !== m); setModels(next); if (def === m) setDef(next[0] || ''); }} aria-label={`Remove ${m}`} disabled={models.length <= 1}>×</button></span></li>)}</ul>
          <div className="mt-2 flex gap-2"><Input aria-label="Model id" placeholder="gemini-2.5-pro" value={add} onChange={(e) => setAdd(e.target.value)} /><Button onClick={() => { const v = add.trim(); if (v && !models.includes(v)) { setModels([...models, v]); if (!def) setDef(v); } setAdd(''); }}>Add</Button><Button onClick={async () => { try { const r = await withSudo(() => api.platformAiDiscover()); setDiscovered(r.models || []); toast.success(`${(r.models || []).length} models offered by the gateway.`); } catch (e) { toast.error(api.errorText(e)); } }}><RefreshCw className="h-4 w-4" />Discover</Button></div>
          {discovered && <div className="mt-2 flex flex-wrap gap-1">{discovered.filter((m) => !models.includes(m)).map((m) => <button key={m} type="button" className="rounded-full border border-line px-2 py-0.5 font-mono text-2xs hover:border-accent" onClick={() => setModels([...models, m])}>+ {m}</button>)}{discovered.every((m) => models.includes(m)) && <span className="text-xs text-ink-3">Everything the gateway offers is already listed.</span>}</div>}
          <p className="mt-2 text-2xs text-ink-3">GenAI.mil fronts several model families (Gemini, Grok, GPT). Discover lists what your key can reach.</p>
        </div>
      </Panel>
      <Panel title="Reach check" subtitle="From this browser, not the server">
        <p className="text-sm text-ink-2">Paste a GenAI.mil key and Vantage asks the gateway for its model list directly from this browser. Nothing is stored; the result only tells you whether this device’s network can reach GenAI.mil.</p>
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void probeFromBrowser(); }}>
          <Input aria-label="GenAI.mil key for the reach check" type="password" autoComplete="off" spellCheck={false} placeholder="genai key…" value={probeKey} onChange={(e) => setProbeKey(e.target.value)} />
          <Button type="submit" loading={probing} disabled={!probeKey.trim()}>Test from this browser</Button>
        </form>
        {probe && <p role="status" className={`mt-3 rounded-md border px-3 py-2 text-sm text-ink ${probe.tone === 'good' ? 'border-good/40 bg-good/10' : probe.tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-bad/40 bg-bad/5'}`}>{probe.text}</p>}
        <p className="mt-2 text-2xs text-ink-3">Server: {data.base_url}{data.last_error_at ? ` · last server-side failure ${timeAgo(data.last_error_at)}` : ''}</p>
      </Panel>
      <Panel title="Usage" subtitle="Today, across everyone">
        <div className="grid grid-cols-3 gap-3"><Stat label="Requests" value={data.daily.requests} /><Stat label="Tokens" value={Number(data.daily.total_tokens).toLocaleString()} hint={`budget ${Number(data.daily.budget_tokens).toLocaleString()}`} /><Stat label="Failures" value={data.daily.failures} tone={data.daily.failures ? 'warn' : undefined} /></div>
        <h3 className="mb-1.5 mt-4 text-xs font-semibold text-ink-2">Last 30 days by model</h3>
        {!data.by_model_30d?.length ? <p className="text-sm text-ink-3">No requests yet.</p> : <Table minWidth={320} head={<><th>Model</th><th className="text-right">Requests</th><th className="text-right">Tokens</th><th className="text-right">Failures</th></>}>{data.by_model_30d.map((m: any) => <tr key={m.model}><td className="mono text-xs">{m.model}</td><td className="fig text-right">{m.requests}</td><td className="fig text-right">{Number(m.total_tokens).toLocaleString()}</td><td className="fig text-right">{m.failures}</td></tr>)}</Table>}
        {data.last_error_code && <p className="mt-3 text-xs text-warn">Last gateway error: {data.last_error_code} {timeAgo(data.last_error_at)}.</p>}
        <p className="mt-3 flex items-start gap-1.5 text-2xs text-ink-3"><Sparkles className="mt-0.5 h-3 w-3 shrink-0" />Workflows: {data.workflows.map((w: any) => w.label).join(', ')}.</p>
      </Panel>
    </div>
  );
}

interface AuditRow { id: string; seq: number; at: string; action: string; actor_username: string | null; subject_username: string | null; entity: string | null; entity_id: string | null; unit_id: string | null; detail: string | null; ip: string | null }
interface AuditPage { rows: AuditRow[]; next: number | null; chain: { ok: boolean; count: number; reason?: string } | null; actions: string[] | null }
type AuditFilter = { q: string; action: string; from: string; to: string };
const NO_FILTER: AuditFilter = { q: '', action: '', from: '', to: '' };

/** The platform trail, filtered and paged on the server, so nothing older than a page is out of reach (ADR-0011). */
export function AuditLog() {
  const [draft, setDraft] = useState<AuditFilter>(NO_FILTER);
  const [filter, setFilter] = useState<AuditFilter>(NO_FILTER);
  const { data, isPending, error, refetch } = useAdmin<AuditPage>(`audit:${JSON.stringify(filter)}`, () => api.platformAudit({ ...filter, limit: 200 }));
  const [older, setOlder] = useState<{ rows: AuditRow[]; next: number | null }>({ rows: [], next: null });
  const [loading, setLoading] = useState(''); const [actions, setActions] = useState<string[]>([]);
  const toast = useToast();
  useEffect(() => { setOlder({ rows: [], next: null }); if (data?.actions) setActions(data.actions); }, [data]);
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <div className="card"><EmptyState title="Could not load" description={api.errorText(error)} action={<Button onClick={() => refetch()}>Retry</Button>} /></div>;
  const rows = [...data.rows, ...older.rows];
  const next = older.rows.length ? older.next : data.next;
  const loadOlder = async () => {
    if (!next) return;
    setLoading('older');
    try { const page = await withSudo(() => api.platformAudit({ ...filter, limit: 200, before: next })) as AuditPage; setOlder({ rows: [...older.rows, ...page.rows], next: page.next }); }
    catch (e) { toast.error(api.errorText(e)); } finally { setLoading(''); }
  };
  const download = async (format: 'csv' | 'json') => {
    setLoading(format);
    try { const name = await withSudo(() => api.downloadFile(api.platformAuditExportUrl(filter, format), `vantage-platform-audit.${format}`)); toast.success(`Downloaded ${name}. The download is in the audit trail.`); }
    catch (e) { toast.error(api.errorText(e)); } finally { setLoading(''); }
  };
  const filtered = Boolean(filter.q || filter.action || filter.from || filter.to);
  return (
    <>
      <form className="mb-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); setFilter({ ...draft, q: draft.q.trim() }); }}>
        <Field label="Search" className="min-w-[12rem] flex-1"><Input placeholder="Action, detail, username, IP or ID" value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} maxLength={80} /></Field>
        <Field label="Action" className="w-52"><Select aria-label="Action" value={draft.action || 'all'} onValueChange={(v) => setDraft({ ...draft, action: v === 'all' ? '' : v })} options={[{ value: 'all', label: 'Every action' }, ...actions.map((a) => ({ value: a, label: humanize(a) }))]} /></Field>
        <Field label="From (UTC)" className="w-40"><Input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></Field>
        <Field label="To (UTC)" className="w-40"><Input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
        <Button type="submit" variant="primary">Apply</Button>
        {filtered && <Button type="button" variant="ghost" onClick={() => { setDraft(NO_FILTER); setFilter(NO_FILTER); }}>Clear</Button>}
      </form>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {data.chain && <Badge tone={data.chain.ok ? 'good' : 'bad'}>{data.chain.ok ? `Chain intact · ${data.chain.count} entries` : 'Chain broken'}</Badge>}
        <span className="text-xs text-ink-3">{rows.length} shown{filtered ? ', filtered' : ''}, newest first</span>
        <span className="ml-auto flex gap-1"><Button size="sm" variant="ghost" onClick={() => download('csv')} loading={loading === 'csv'}><Download className="h-3.5 w-3.5" />CSV</Button><Button size="sm" variant="ghost" onClick={() => download('json')} loading={loading === 'json'}><Download className="h-3.5 w-3.5" />JSON</Button></span>
      </div>
      {data.chain && !data.chain.ok && <p className="mb-3 text-sm text-bad">{data.chain.reason}. Restore from a backup taken before that point and investigate.</p>}
      <div className="card" style={{ overflow: 'hidden' }}>
        {!rows.length ? <EmptyState title="Nothing matches" description={filtered ? 'Try a wider date range or another action.' : 'The platform trail is empty.'} /> : (
          <Table minWidth={900} head={<><th className="w-14">#</th><th className="w-40">When</th><th className="w-32">Actor</th><th className="w-44">Action</th><th className="w-32">Subject</th><th className="w-28">Unit</th><th>Detail</th><th className="w-28">IP</th></>}>
            {rows.map((r) => <tr key={r.id}><td className="fig text-xs text-ink-3">{r.seq}</td><td className="fig text-xs text-ink-3">{formatStamp(r.at)}</td><td className="text-xs">{r.actor_username || 'system'}</td><td className="text-xs text-ink">{humanize(r.action)}{r.entity ? <span className="text-ink-3"> · {r.entity}</span> : ''}</td><td className="text-xs">{r.subject_username || ''}</td><td className="text-xs text-ink-3">{r.unit_id || ''}</td><td className="max-w-xs truncate text-xs text-ink-2" title={r.detail ?? ''}>{r.detail}</td><td className="fig text-2xs text-ink-3">{r.ip || ''}</td></tr>)}
          </Table>
        )}
      </div>
      {next && <div className="mt-3 flex justify-center"><Button onClick={loadOlder} loading={loading === 'older'}>Load older</Button></div>}
    </>
  );
}

export function DataAdmin() {
  const { data: overview } = useAdmin('overview', api.platformOverview);
  const browserOff = overview?.browserBackups === false;
  const toast = useToast(); const [busy, setBusy] = useState(''); const [importFile, setImportFile] = useState<File | null>(null); const [confirmImport, setConfirmImport] = useState(false);
  const backup = async () => { setBusy('backup'); try { const n = await api.downloadFile('/api/platform/backup', 'vantage-backup.db'); toast.success(`Downloaded ${n}.`); } catch (e: any) { if (e?.code === 'sudo_required') { try { await withSudo(() => api.platformOverview()); const n = await api.downloadFile('/api/platform/backup', 'vantage-backup.db'); toast.success(`Downloaded ${n}.`); } catch (e2) { toast.error(api.errorText(e2)); } } else toast.error(api.errorText(e)); } finally { setBusy(''); } };
  const exportJson = async () => { setBusy('export'); try { await withSudo(() => api.platformOverview()); const n = await api.downloadFile('/api/platform/export', 'vantage-service.json'); toast.success(`Downloaded ${n}.`); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(''); } };
  const runImport = async () => { if (!importFile) return; setBusy('import'); try { const archive = JSON.parse(await importFile.text()); const r = await withSudo(() => api.platformImport(archive)); toast.success(`Imported: ${Object.entries(r.counts || {}).map(([k, v]) => `${v} ${k}`).join(', ')}. ${r.note}`); setTimeout(() => signOutEverywhere(), 2500); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(''); } };
  const { data: operations } = useAdmin<{ backups: { state: 'fresh' | 'stale' | 'never'; last: { at: string; method: 'browser' | 'server' } | null; maxAgeHours: number } }>('operations', api.platformOperations);
  const backups = operations?.backups;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Backup" subtitle="A consistent copy of the SQLite database">
        <p className="text-sm text-ink-2">The file holds every Unit Instance’s records, every password hash and every sealed secret. Every other Lead Vantage Administrator is told each time one is downloaded.</p>
        {backups && <p className="mt-2 text-sm"><Badge tone={backups.state === 'fresh' ? 'good' : 'warn'}>{backups.state === 'never' ? 'No backup recorded' : backups.state === 'fresh' ? 'Recent' : 'Overdue'}</Badge> <span className="text-ink-2">{backups.last ? `Last ${timeAgo(backups.last.at)}, ${backups.last.method === 'server' ? 'on the server' : 'through the browser'}; expected every ${backups.maxAgeHours} hours.` : `Expected every ${backups.maxAgeHours} hours.`}</span></p>}
        {browserOff
          ? <p className="mt-3 text-sm text-warn">Downloading through the browser is turned off (VANTAGE_BROWSER_BACKUPS=false). Backups are taken on the server; see Operations in the documentation.</p>
          : <Button className="mt-3" variant="primary" onClick={backup} loading={busy === 'backup'}><Database className="h-4 w-4" />Download backup (.db)</Button>}
      </Panel>
      <Panel title="Disaster recovery" subtitle="The whole service as one portable file">
        <p className="text-sm text-ink-2">Everything (Unit Instances, accounts, units, roles, records, attachments, the audit trail) as one JSON file, for restoring the service onto a fresh host under the same VANTAGE_SECRET. Passwords, passkeys and authenticators carry over.</p>
        <div className="mt-3 flex flex-wrap gap-2"><Button onClick={exportJson} loading={busy === 'export'}><Download className="h-4 w-4" />Export the service</Button><label className="inline-flex"><input type="file" aria-label="Choose a service export" accept="application/json,.json" className="sr-only" onChange={(e) => setImportFile(e.target.files?.[0] || null)} /><Button asChild><span><Upload className="h-4 w-4" />{importFile ? importFile.name : 'Choose export to import'}</span></Button></label>{importFile && <Button variant="danger" onClick={() => setConfirmImport(true)} loading={busy === 'import'}>Import and replace</Button>}</div>
      </Panel>
      <Panel title="Maintenance" className="lg:col-span-2"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-ink-2">Start maintenance before restoring or moving, so nobody writes into a database you are about to replace. It asks why, and records it.</p><Button asChild><Link to="/maintenance"><Wrench className="h-4 w-4" />Maintenance</Link></Button></div></Panel>
      <ConfirmDialog open={confirmImport} onOpenChange={setConfirmImport} title="Replace the whole service with the export?" body="Everything currently here is deleted and replaced by the file's contents. Every session, including yours, is reset. Take a backup first." confirmLabel="Replace everything" onConfirm={runImport} />
    </div>
  );
}
