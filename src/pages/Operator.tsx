import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, RefreshCw, Unlock, Mail, Download, Upload, Database, ShieldCheck, Users, Building2, ScrollText, Wrench, Sparkles, KeyRound, LogOut, Copy } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Textarea, Tabs, Panel, Badge, Switch, Skeleton, Stat, EmptyState } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { Table, useParam } from '@/components/common';
import { keys, useIdentity, signOutEverywhere } from '@/lib/queries';
import * as api from '@/lib/api';
import { copyToClipboard, downloadText, humanize, timeAgo } from '@/lib/utils';
import { DEFAULT_METRICS, CATEGORY_PALETTE, type MetricsConfig } from '../../shared/constants';

export default function Operator() {
  const { data: identity } = useIdentity();
  const [tab, setTab] = useParam('tab', 'overview');
  if (!identity?.user.is_operator) return <div className="page"><div className="card"><EmptyState icon={ShieldCheck} title="Owner console" description="Only the instance owner can open this." /></div></div>;
  return (
    <div className="page">
      <PageHeader eyebrow="Owner console" title="Run this deployment" lede="Instance-wide settings, accounts, and data. Everything here asks for your password again." />
      <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[{ value: 'overview', label: 'Overview' }, { value: 'settings', label: 'Settings' }, { value: 'ai', label: 'AI' }, { value: 'metrics', label: 'Metrics' }, { value: 'users', label: 'Accounts' }, { value: 'units', label: 'Units' }, { value: 'audit', label: 'Audit log' }, { value: 'data', label: 'Backup and move' }]} />
      {tab === 'overview' && <Overview />}
      {tab === 'settings' && <RuntimeSettings />}
      {tab === 'ai' && <AiSettings />}
      {tab === 'metrics' && <MetricsSettings />}
      {tab === 'users' && <Accounts />}
      {tab === 'units' && <UnitsAdmin />}
      {tab === 'audit' && <AuditLog />}
      {tab === 'data' && <DataAdmin />}
    </div>
  );
}

function useAdmin<T = any>(key: string, fn: () => Promise<T>) { return useQuery<T>({ queryKey: ['admin', key], queryFn: () => withSudo(fn), retry: false }); }

function Overview() {
  const { data, isPending, error, refetch } = useAdmin('overview', api.adminOverview);
  const toast = useToast();
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <div className="card"><EmptyState title="Could not load" description={api.errorText(error)} action={<Button onClick={() => refetch()}>Retry</Button>} /></div>;
  const mb = (n: number | null) => (n == null ? '—' : `${(n / 1_048_576).toFixed(1)} MB`);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active accounts" value={data.users} hint={`${data.operators} owner${data.operators === 1 ? '' : 's'} · ${data.inactiveUsers} inactive`} icon={Users} />
        <Stat label="Units" value={data.units} icon={Building2} />
        <Stat label="Records" value={data.records} hint={`${data.attachments} attachments`} icon={ScrollText} />
        <Stat label="Database" value={mb(data.database.sizeBytes)} hint={`of ${mb(data.database.maxBytes)} safety threshold`} icon={Database} tone={data.database.sizeBytes && data.database.sizeBytes > data.database.maxBytes * 0.8 ? 'warn' : undefined} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Instance"><dl className="space-y-1.5 text-sm">{[['Version', `${data.version} · schema ${data.schemaVersion}`], ['Node', data.node], ['Uptime', `${Math.round(data.uptime / 3600)} h`], ['Public URL', data.publicUrl], ['Passkey domain', data.rpId], ['Time zone', data.timezone], ['Sessions open', data.sessions], ['MFA users', `${data.mfaUsers} authenticator · ${data.passkeyUsers} passkey`]].map(([k, v]) => <div key={String(k)} className="flex justify-between gap-3"><dt className="text-ink-3">{k}</dt><dd className="fig truncate text-right text-ink">{String(v)}</dd></div>)}</dl></Panel>
        <Panel title="Email" subtitle={data.email.enabled ? `${data.email.provider} · from ${data.email.from}` : 'not configured'} action={data.email.enabled ? <Button size="sm" onClick={async () => { try { await withSudo(() => api.adminEmailTest()); toast.success('Test email sent to you.'); } catch (e) { toast.error(api.errorText(e)); } }}><Mail className="h-3.5 w-3.5" />Send test</Button> : undefined}>
          {!data.email.enabled ? <p className="text-sm text-ink-2">Set VANTAGE_EMAIL_PROVIDER to resend or smtp with its credentials to enable reset links, invitations, and digests.</p> : !data.email.recent.length ? <p className="text-sm text-ink-3">No email sent yet.</p> : <ul className="space-y-1 text-xs">{data.email.recent.map((m: any, i: number) => <li key={i} className="flex justify-between gap-2"><span className="truncate text-ink">{m.kind} → {m.to_address}</span><span className={m.status === 'sent' ? 'text-good' : 'text-bad'}>{m.status}{m.error ? `: ${m.error}` : ''}</span></li>)}</ul>}
        </Panel>
        <Panel title="Audit chain" subtitle="tamper-evident log">
          <p className="text-sm"><Badge tone={data.audit.ok ? 'good' : 'bad'}>{data.audit.ok ? 'Intact' : 'Broken'}</Badge> <span className="fig text-ink-2">{data.audit.count} entries</span></p>
          {!data.audit.ok && <p className="mt-2 text-xs text-bad">{data.audit.reason}. Restore from a backup taken before that point and investigate.</p>}
          <p className="mt-3 text-sm text-ink-2">MARADMIN feed: {data.maradmins.enabled ? `${data.maradmins.count} cached · last sync ${data.maradmins.lastSuccess ? timeAgo(data.maradmins.lastSuccess) : 'never'}` : 'off'}{data.maradmins.lastError ? <span className="block text-xs text-warn">{data.maradmins.lastError}</span> : null}</p>
          {data.maradmins.enabled && <Button size="sm" className="mt-2" onClick={async () => { try { const r = await withSudo(() => api.adminSyncMaradmins()); toast.success(`Synced: ${r.inserted ?? 0} new, ${r.updated ?? 0} updated.`); refetch(); } catch (e) { toast.error(api.errorText(e)); } }}><RefreshCw className="h-3.5 w-3.5" />Sync now</Button>}
        </Panel>
      </div>
    </div>
  );
}

function RuntimeSettings() {
  const { data, isPending, refetch } = useAdmin('overview', api.adminOverview);
  const toast = useToast(); const qc = useQueryClient();
  const [form, setForm] = useState<any>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (data?.runtime && !form) setForm({ ...data.runtime }); }, [data, form]);
  if (isPending || !form) return <Skeleton className="h-64" />;
  const save = async () => { setBusy(true); try { await withSudo(() => api.adminRuntime({ displayName: form.displayName, organizationName: form.organizationName, announcement: form.announcement, selfRegistration: form.selfRegistration, attachmentsEnabled: form.attachmentsEnabled, maradminsEnabled: form.maradminsEnabled, maintenance: form.maintenance })); qc.invalidateQueries({ queryKey: keys.me }); refetch(); toast.success('Settings saved.'); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Identity" action={<Button size="sm" variant="primary" onClick={save} loading={busy}><Save className="h-4 w-4" />Save</Button>}>
        <div className="space-y-3">
          <Field label="Display name" hint="shown on the sign-in page and in authenticator apps"><Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
          <Field label="Organization"><Input value={form.organizationName} onChange={(e) => setForm({ ...form, organizationName: e.target.value })} /></Field>
          <Field label="Announcement" hint="banner for everyone; blank hides it"><Textarea rows={2} value={form.announcement} onChange={(e) => setForm({ ...form, announcement: e.target.value })} maxLength={240} /></Field>
        </div>
      </Panel>
      <Panel title="Switches" action={<Button size="sm" variant="primary" onClick={save} loading={busy}><Save className="h-4 w-4" />Save</Button>}>
        <Switch checked={form.selfRegistration} onChange={(v) => setForm({ ...form, selfRegistration: v })} label="Self-registration" description="Anyone who can reach the site can create an account. Off means invitation only." />
        <Switch checked={form.attachmentsEnabled} onChange={(v) => setForm({ ...form, attachmentsEnabled: v })} label="Attachments" description="PDF and image files on records. Stored in the database; counts toward the size threshold." />
        <Switch checked={form.maradminsEnabled} onChange={(v) => setForm({ ...form, maradminsEnabled: v })} label="MARADMIN feed" description="Fetches public message titles from marines.mil on a schedule." />
        <Switch checked={form.maintenance} onChange={(v) => setForm({ ...form, maintenance: v })} label="Maintenance mode" description="Blocks everyone but owners. Use it around a restore or a move." />
      </Panel>
    </div>
  );
}

/** What this instance measures. Everything here used to be hard-coded for the G-8; now any shop can name its money metric and define its own value types and categories. */
function MetricsSettings() {
  const { data, isPending, refetch } = useAdmin('overview', api.adminOverview);
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
      await withSudo(() => api.adminRuntime({ metrics: cleaned }));
      qc.invalidateQueries({ queryKey: keys.me }); refetch(); setForm(cleaned); setDirty(false);
      toast.success('Metrics saved. Forms and reports use the new definitions now.');
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const summable = form.value_types.filter((t) => t.summable).map((t) => t.label).join(', ');
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Money metric" subtitle="the headline number and what it is called" action={<Button size="sm" variant="primary" onClick={save} loading={busy} disabled={!dirty}><Save className="h-4 w-4" />Save metrics</Button>}>
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
        <Panel title="Categories" subtitle="how entries are grouped on dashboards and in reports" action={<Button size="xs" variant="ghost" onClick={() => update({ categories: [...form.categories, { name: '', color: CATEGORY_PALETTE[form.categories.length % CATEGORY_PALETTE.length] }] })} disabled={form.categories.length >= 40}>Add category</Button>}>
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
        <Panel title="Unit suggestions" subtitle="offered while typing an action unit">
          <Textarea aria-label="Unit suggestions" rows={3} value={form.unit_suggestions.join(', ')} onChange={(e) => update({ unit_suggestions: e.target.value.split(/[,\n]/).map((u) => u.trim()).filter(Boolean).slice(0, 60) })} placeholder="ULOs, MIPRs, documents, hours" />
        </Panel>
        <Panel title="Reset">
          <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-ink-2">Back to the G-8 comptroller defaults: dollars, five value types, ten categories.</p><Button onClick={() => { setForm(structuredClone(DEFAULT_METRICS)); setDirty(true); }}>Load defaults</Button></div>
        </Panel>
      </div>
    </div>
  );
}

function AiSettings() {
  const { data, isPending, refetch } = useAdmin('ai', api.adminAi);
  const toast = useToast(); const qc = useQueryClient();
  const [models, setModels] = useState<string[] | null>(null); const [def, setDef] = useState(''); const [enabled, setEnabled] = useState<boolean | null>(null); const [add, setAdd] = useState(''); const [discovered, setDiscovered] = useState<string[] | null>(null); const [busy, setBusy] = useState(false);
  const [probeKey, setProbeKey] = useState(''); const [probe, setProbe] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null); const [probing, setProbing] = useState(false);
  useEffect(() => { if (data && models == null) { setModels(data.models); setDef(data.default_model); setEnabled(data.enabled); } }, [data, models]);
  if (isPending || !data || models == null) return <Skeleton className="h-64" />;
  const blocked = data.last_error_code === 'network_blocked';
  const lastError = data.last_error_code ? (blocked ? 'GenAI.mil refused the last call because this server is outside DoD networks.' : `The last call failed (${data.last_error_code}) ${timeAgo(data.last_error_at)}.`) : null;
  /** Runs from the browser, not the server: shows whether GenAI.mil is reachable from wherever the operator is sitting. The key is used once and never stored. */
  const probeFromBrowser = async () => {
    setProbing(true); setProbe(null);
    try {
      const res = await fetch(`${data.base_url}/models`, { headers: { authorization: `Bearer ${probeKey.trim()}` } });
      if (res.ok) { const body = await res.json().catch(() => ({})); const n = Array.isArray(body?.data) ? body.data.length : 0; setProbe({ tone: 'good', text: `Reachable from this browser · ${n} models offered. Calls made from a device on this network would work.` }); }
      else setProbe({ tone: res.status === 401 || res.status === 403 ? 'warn' : 'bad', text: res.status === 401 || res.status === 403 ? `Reachable from this browser, but GenAI.mil rejected that key (${res.status}).` : `GenAI.mil answered ${res.status} from this browser. A 503 means this device is outside DoD networks too.` });
    } catch { setProbe({ tone: 'bad', text: 'This browser could not reach GenAI.mil at all: the network blocks it, or the gateway does not allow calls from web pages.' }); }
    finally { setProbing(false); }
  };
  const save = async () => { setBusy(true); try { await withSudo(() => api.adminRuntime({ aiEnabled: Boolean(enabled), aiModels: models, aiDefaultModel: def })); qc.invalidateQueries({ queryKey: keys.me }); qc.invalidateQueries({ queryKey: keys.aiStatus }); refetch(); toast.success('AI settings saved.'); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="GenAI.mil" subtitle={data.configured ? `key ${data.key_fingerprint} · ${data.base_url}` : 'no key configured'} action={<Button size="sm" variant="primary" onClick={save} loading={busy}><Save className="h-4 w-4" />Save</Button>}>
        {!data.configured && <p className="mb-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink">No GenAI.mil key on this server. On Render, open the service → Environment, add VANTAGE_GENAI_API_KEY with your GenAI.mil key, save, and let it redeploy. The switch below unlocks once the key is present.</p>}
        <Switch checked={Boolean(enabled)} onChange={setEnabled} label="AI assistance on" description="Users see drafting help and can pick a model from the list below." disabled={!data.configured} />
        {lastError && <div className={`mt-3 rounded-md border px-3 py-2 text-sm text-ink ${blocked ? 'border-bad/40 bg-bad/5' : 'border-warn/40 bg-warn/10'}`}><p className="font-medium">{lastError}</p>{blocked && <p className="mt-1 text-xs text-ink-2">GenAI.mil only accepts calls from DoD networks. A server on Render, or any commercial host, is outside them, so every AI request fails whatever the key. AI will work once Vantage runs on a DoD-network host. Use the check below to see whether the device you are on can reach the gateway.</p>}</div>}
        {data.locked && <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-sm"><span className="text-ink">Key locked by the gateway since {timeAgo(data.locked_at)}{data.unlock_url ? <a className="link ml-1" href={data.unlock_url} target="_blank" rel="noopener noreferrer">unlock at GenAI.mil</a> : ''}.</span><Button size="sm" onClick={async () => { try { await withSudo(() => api.adminAiUnlock()); refetch(); toast.success('Lock cleared. The next request will tell.'); } catch (e) { toast.error(api.errorText(e)); } }}><Unlock className="h-3.5 w-3.5" />Clear</Button></div>}
        <div className="mt-4">
          <p className="mb-1.5 text-xs font-semibold text-ink-2">Models users may choose</p>
          <ul className="space-y-1">{models.map((m) => <li key={m} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-1.5 text-sm"><span className="mono text-ink">{m}</span><span className="flex items-center gap-2">{def === m ? <Badge tone="accent">Default</Badge> : <button type="button" className="text-xs text-accent hover:underline" onClick={() => setDef(m)}>Make default</button>}<button type="button" className="text-ink-3 hover:text-bad" onClick={() => { const next = models.filter((x) => x !== m); setModels(next); if (def === m) setDef(next[0] || ''); }} aria-label={`Remove ${m}`} disabled={models.length <= 1}>×</button></span></li>)}</ul>
          <div className="mt-2 flex gap-2"><Input aria-label="Model id" placeholder="gemini-2.5-pro" value={add} onChange={(e) => setAdd(e.target.value)} /><Button onClick={() => { const v = add.trim(); if (v && !models.includes(v)) { setModels([...models, v]); if (!def) setDef(v); } setAdd(''); }}>Add</Button><Button onClick={async () => { try { const r = await withSudo(() => api.adminAiDiscover()); setDiscovered(r.models || []); toast.success(`${(r.models || []).length} models offered by the gateway.`); } catch (e) { toast.error(api.errorText(e)); } }}><RefreshCw className="h-4 w-4" />Discover</Button></div>
          {discovered && <div className="mt-2 flex flex-wrap gap-1">{discovered.filter((m) => !models.includes(m)).map((m) => <button key={m} type="button" className="rounded-full border border-line px-2 py-0.5 font-mono text-2xs hover:border-accent" onClick={() => setModels([...models, m])}>+ {m}</button>)}{discovered.every((m) => models.includes(m)) && <span className="text-xs text-ink-3">Everything the gateway offers is already listed.</span>}</div>}
          <p className="mt-2 text-2xs text-ink-3">GenAI.mil fronts several model families (Gemini, Grok, GPT). Discover lists what your key can reach.</p>
        </div>
      </Panel>
      <Panel title="Reach check" subtitle="from this browser, not the server">
        <p className="text-sm text-ink-2">Paste a GenAI.mil key and Vantage asks the gateway for its model list directly from this browser. Nothing is stored; the result only tells you whether this device’s network can reach GenAI.mil.</p>
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void probeFromBrowser(); }}>
          <Input aria-label="GenAI.mil key for the reach check" type="password" autoComplete="off" spellCheck={false} placeholder="genai key…" value={probeKey} onChange={(e) => setProbeKey(e.target.value)} />
          <Button type="submit" loading={probing} disabled={!probeKey.trim()}>Test from this browser</Button>
        </form>
        {probe && <p role="status" className={`mt-3 rounded-md border px-3 py-2 text-sm text-ink ${probe.tone === 'good' ? 'border-good/40 bg-good/10' : probe.tone === 'warn' ? 'border-warn/40 bg-warn/10' : 'border-bad/40 bg-bad/5'}`}>{probe.text}</p>}
        <p className="mt-2 text-2xs text-ink-3">Server: {data.base_url}{data.last_error_at ? ` · last server-side failure ${timeAgo(data.last_error_at)}` : ''}</p>
      </Panel>
      <Panel title="Usage" subtitle="today, across everyone">
        <div className="grid grid-cols-3 gap-3"><Stat label="Requests" value={data.daily.requests} /><Stat label="Tokens" value={Number(data.daily.total_tokens).toLocaleString()} hint={`budget ${Number(data.daily.budget_tokens).toLocaleString()}`} /><Stat label="Failures" value={data.daily.failures} tone={data.daily.failures ? 'warn' : undefined} /></div>
        <h3 className="mb-1.5 mt-4 text-xs font-semibold text-ink-2">Last 30 days by model</h3>
        {!data.by_model_30d?.length ? <p className="text-sm text-ink-3">No requests yet.</p> : <Table minWidth={320} head={<><th>Model</th><th className="text-right">Requests</th><th className="text-right">Tokens</th><th className="text-right">Failures</th></>}>{data.by_model_30d.map((m: any) => <tr key={m.model}><td className="mono text-xs">{m.model}</td><td className="fig text-right">{m.requests}</td><td className="fig text-right">{Number(m.total_tokens).toLocaleString()}</td><td className="fig text-right">{m.failures}</td></tr>)}</Table>}
        {data.last_error_code && <p className="mt-3 text-xs text-warn">Last gateway error: {data.last_error_code} {timeAgo(data.last_error_at)}.</p>}
        <p className="mt-3 flex items-start gap-1.5 text-2xs text-ink-3"><Sparkles className="mt-0.5 h-3 w-3 shrink-0" />Workflows: {data.workflows.map((w: any) => w.label).join(', ')}.</p>
      </Panel>
    </div>
  );
}

function Accounts() {
  const { data, isPending, refetch } = useAdmin('users', api.adminUsers);
  const { data: identity } = useIdentity(); const toast = useToast(); const qc = useQueryClient();
  const [q, setQ] = useState(''); const [temp, setTemp] = useState<{ user: any; password: string } | null>(null); const [confirm, setConfirm] = useState<{ kind: string; user: any } | null>(null);
  if (isPending) return <Skeleton className="h-64" />;
  const users: any[] = (data?.users || []).filter((u: any) => !q.trim() || `${u.username} ${u.first_name} ${u.last_name} ${u.email || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const act = async (label: string, fn: () => Promise<any>) => { try { const r = await withSudo(fn); toast.success(`${label}${r?.sessionsRevoked ? ` · ${r.sessionsRevoked} sessions signed out` : ''}.`); refetch(); qc.invalidateQueries({ queryKey: keys.team }); return r; } catch (e) { toast.error(api.errorText(e)); } };
  const run = async () => {
    if (!confirm) return; const u = confirm.user;
    if (confirm.kind === 'deactivate') await act(`${u.username} deactivated`, () => api.deactivateMember(u.id));
    if (confirm.kind === 'reset-mfa') await act('MFA and passkeys cleared', () => api.resetMemberMfa(u.id));
    if (confirm.kind === 'temp') { const r = await act('Temporary password issued', () => api.temporaryPassword(u.id)); if (r?.password) setTemp({ user: u, password: r.password }); }
    if (confirm.kind === 'operator') await act(u.is_operator ? 'Owner authority removed' : 'Owner authority granted', () => api.setOperator(u.id, !u.is_operator));
  };
  return (
    <>
      <div className="mb-3 flex items-center gap-2"><Input aria-label="Search accounts" placeholder="Search accounts…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" /><span className="text-xs text-ink-3">{users.length} shown</span></div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <Table minWidth={860} head={<><th>Account</th><th className="w-32">Security</th><th className="w-20 text-center">Units</th><th className="w-28">Last sign-in</th><th className="w-24">Status</th><th className="w-64"></th></>}>
          {users.map((u) => (
            <tr key={u.id}>
              <td><span className="block font-medium text-ink">{u.rank_abbr || ''} {u.last_name}, {u.first_name}{u.is_operator ? <Badge tone="accent" className="ml-2">Owner</Badge> : null}</span><span className="block text-xs text-ink-3">@{u.username}{u.email ? ` · ${u.email}` : ''}</span></td>
              <td className="text-xs text-ink-2">{u.totp_enabled ? 'Authenticator' : ''}{u.totp_enabled && u.passkeys ? ' · ' : ''}{u.passkeys ? `${u.passkeys} passkey${u.passkeys === 1 ? '' : 's'}` : ''}{!u.totp_enabled && !u.passkeys ? <span className="text-warn">Password only</span> : ''}{u.must_change_password ? <span className="block text-warn">Temp password</span> : null}</td>
              <td className="fig text-center">{u.units}</td><td className="text-xs text-ink-3">{u.last_login_at ? timeAgo(u.last_login_at) : 'never'}</td><td>{u.active ? <Badge tone="good">Active</Badge> : <Badge tone="bad">Inactive</Badge>}</td>
              <td className="text-right"><span className="flex flex-wrap justify-end gap-1">
                {u.active ? <>{u.id !== identity?.user.id && <Button size="xs" variant="ghost" onClick={() => setConfirm({ kind: 'temp', user: u })}><KeyRound className="h-3 w-3" />Temp password</Button>}<Button size="xs" variant="ghost" onClick={() => setConfirm({ kind: 'reset-mfa', user: u })}>Reset MFA</Button><Button size="xs" variant="ghost" onClick={() => act('Signed out everywhere', () => api.forceLogout(u.id))}><LogOut className="h-3 w-3" /></Button>{u.id !== identity?.user.id && <Button size="xs" variant="ghost" onClick={() => setConfirm({ kind: 'operator', user: u })}>{u.is_operator ? 'Remove owner' : 'Make owner'}</Button>}{u.id !== identity?.user.id && <Button size="xs" variant="ghost" className="text-bad" onClick={() => setConfirm({ kind: 'deactivate', user: u })}>Deactivate</Button>}</> : <Button size="xs" onClick={() => act('Reactivated', () => api.reactivateMember(u.id))}>Reactivate</Button>}
              </span></td>
            </tr>
          ))}
        </Table>
      </div>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} danger={confirm?.kind === 'deactivate'} confirmLabel={confirm?.kind === 'deactivate' ? 'Deactivate' : 'Continue'} title={confirm ? { deactivate: `Deactivate ${confirm.user.username}?`, 'reset-mfa': `Reset MFA for ${confirm.user.username}?`, temp: `Issue a temporary password to ${confirm.user.username}?`, operator: confirm.user.is_operator ? `Remove owner authority from ${confirm.user.username}?` : `Make ${confirm.user.username} an owner?` }[confirm.kind] || '' : ''} body={confirm ? { deactivate: 'They cannot sign in; their records stay. Reactivate any time.', 'reset-mfa': 'Their authenticator, recovery codes, and passkeys are removed and every session signed out. Use this when a phone is lost.', temp: 'Their current password stops working, every session is signed out, and they must set a new password on next sign-in. Hand the temporary password over in person.', operator: 'Owners can open this console, manage every account, and move the instance. Give it to the fewest people possible.' }[confirm.kind] : ''} onConfirm={run} />
      <Dialog open={Boolean(temp)} onOpenChange={(o) => { if (!o) setTemp(null); }} title={`Temporary password for ${temp?.user.username}`} description="Shown once. It expires when they set their own." size="sm" footer={<Button variant="primary" onClick={async () => { if (await copyToClipboard(temp!.password)) toast.success('Copied.'); }}><Copy className="h-4 w-4" />Copy</Button>}><p className="mono select-all rounded-md border border-line bg-surface-2 px-3 py-2 text-center text-lg text-ink">{temp?.password}</p></Dialog>
    </>
  );
}

function UnitsAdmin() {
  const { data, isPending, refetch } = useAdmin('units', api.adminUnits);
  const { data: users } = useAdmin('users', api.adminUsers);
  const toast = useToast(); const qc = useQueryClient();
  const [claim, setClaim] = useState<any>(null); const [owner, setOwner] = useState('');
  if (isPending) return <Skeleton className="h-64" />;
  return (
    <>
      <div className="card" style={{ overflow: 'hidden' }}>
        <Table head={<><th>Unit</th><th className="w-28">Echelon</th><th className="w-20 text-center">Members</th><th className="w-40">Leader</th><th className="w-24">Status</th><th className="w-32"></th></>}>
          {(data?.units || []).map((u: any) => <tr key={u.id}><td><span className="block font-medium text-ink">{u.name}</span><span className="block text-xs text-ink-3">{u.short_name ? `${u.short_name} · ` : ''}{u.code}{u.parent_id ? ` · under ${u.parent_id}` : ''}</span></td><td className="text-xs">{humanize(u.echelon)}</td><td className="fig text-center">{u.members}</td><td className="text-xs">{u.owner_last ? `${u.owner_last}, ${u.owner_first}` : <span className="text-warn">Unclaimed</span>}</td><td>{u.active ? <Badge tone="good">Active</Badge> : <Badge>Archived</Badge>}</td><td className="text-right">{u.active ? <Button size="xs" onClick={() => { setClaim(u); setOwner(''); }}>{u.owner_user_id ? 'Reassign leader' : 'Assign leader'}</Button> : null}</td></tr>)}
        </Table>
      </div>
      <Dialog open={Boolean(claim)} onOpenChange={(o) => { if (!o) setClaim(null); }} title={`Leader for ${claim?.name}`} description="Use this when a unit is orphaned. The chosen account gets the Unit Leader role." size="sm" footer={<><Button variant="ghost" onClick={() => setClaim(null)}>Cancel</Button><Button variant="primary" onClick={async () => { try { await withSudo(() => api.adminClaimUnit(claim.id, owner || undefined)); refetch(); qc.invalidateQueries({ queryKey: keys.me }); toast.success('Leader assigned.'); setClaim(null); } catch (e) { toast.error(api.errorText(e)); } }}>Assign</Button></>}>
        <Field label="Account" hint="blank assigns yourself"><Select value={owner || '__me'} onValueChange={(v) => setOwner(v === '__me' ? '' : v)} options={[{ value: '__me', label: 'Me' }, ...(users?.users || []).filter((x: any) => x.active).map((x: any) => ({ value: x.id, label: `${x.rank_abbr || ''} ${x.last_name}, ${x.first_name} (@${x.username})` }))]} /></Field>
      </Dialog>
    </>
  );
}

function AuditLog() {
  const { data, isPending } = useAdmin('audit', () => api.adminAudit(300));
  const [q, setQ] = useState('');
  if (isPending) return <Skeleton className="h-64" />;
  const rows: any[] = (data?.rows || []).filter((r: any) => !q.trim() || `${r.action} ${r.actor_username || ''} ${r.subject_username || ''} ${r.entity || ''} ${r.detail || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2"><Input aria-label="Filter audit" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" /><Badge tone={data?.chain?.ok ? 'good' : 'bad'}>{data?.chain?.ok ? 'Chain intact' : 'Chain broken'}</Badge><span className="text-xs text-ink-3">latest 300</span><Button size="sm" variant="ghost" className="ml-auto" onClick={() => downloadText(`vantage-audit-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data?.rows || [], null, 2), 'application/json')}><Download className="h-3.5 w-3.5" />Download</Button></div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <Table minWidth={900} head={<><th className="w-14">#</th><th className="w-40">When</th><th className="w-32">Actor</th><th className="w-44">Action</th><th className="w-32">Subject</th><th className="w-28">Unit</th><th>Detail</th><th className="w-28">IP</th></>}>
          {rows.map((r) => <tr key={r.id}><td className="fig text-xs text-ink-3">{r.seq}</td><td className="fig text-xs text-ink-3">{new Date(r.at).toLocaleString()}</td><td className="text-xs">{r.actor_username || 'system'}</td><td className="text-xs text-ink">{humanize(r.action)}{r.entity ? <span className="text-ink-3"> · {r.entity}</span> : ''}</td><td className="text-xs">{r.subject_username || ''}</td><td className="text-xs text-ink-3">{r.unit_id || ''}</td><td className="max-w-xs truncate text-xs text-ink-2" title={r.detail}>{r.detail}</td><td className="fig text-2xs text-ink-3">{r.ip || ''}</td></tr>)}
        </Table>
      </div>
    </>
  );
}

function DataAdmin() {
  const toast = useToast(); const [busy, setBusy] = useState(''); const [importFile, setImportFile] = useState<File | null>(null); const [confirmImport, setConfirmImport] = useState(false);
  const backup = async () => { setBusy('backup'); try { const n = await api.downloadFile('/api/admin/backup', 'vantage-backup.db'); toast.success(`Downloaded ${n}.`); } catch (e: any) { if (e?.code === 'sudo_required') { try { await withSudo(() => api.adminOverview()); const n = await api.downloadFile('/api/admin/backup', 'vantage-backup.db'); toast.success(`Downloaded ${n}.`); } catch (e2) { toast.error(api.errorText(e2)); } } else toast.error(api.errorText(e)); } finally { setBusy(''); } };
  const exportJson = async () => { setBusy('export'); try { await withSudo(() => api.adminOverview()); const n = await api.downloadFile('/api/admin/export', 'vantage-instance.json'); toast.success(`Downloaded ${n}.`); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(''); } };
  const runImport = async () => { if (!importFile) return; setBusy('import'); try { const archive = JSON.parse(await importFile.text()); const r = await withSudo(() => api.adminImport(archive)); toast.success(`Imported: ${Object.entries(r.counts || {}).map(([k, v]) => `${v} ${k}`).join(', ')}. ${r.note}`); setTimeout(() => signOutEverywhere(), 2500); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(''); } };
  const toggleMaintenance = async (on: boolean) => { try { await withSudo(() => api.adminMaintenance(on)); toast.success(on ? 'Maintenance on. Only owners can sign in.' : 'Maintenance off.'); } catch (e) { toast.error(api.errorText(e)); } };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Backup" subtitle="a consistent copy of the SQLite database">
        <p className="text-sm text-ink-2">Render's disk is not backed up for you. Download a copy on a schedule you can live with, and before any upgrade.</p>
        <Button className="mt-3" variant="primary" onClick={backup} loading={busy === 'backup'}><Database className="h-4 w-4" />Download backup (.db)</Button>
      </Panel>
      <Panel title="Move to another host" subtitle="portable JSON of the whole instance">
        <p className="text-sm text-ink-2">Export everything (accounts, units, roles, records, attachments, audit log) as one JSON file. Import it into a fresh Vantage anywhere: Render, a VM, a laptop. Passwords, passkeys, and authenticators carry over.</p>
        <div className="mt-3 flex flex-wrap gap-2"><Button onClick={exportJson} loading={busy === 'export'}><Download className="h-4 w-4" />Export instance</Button><label className="inline-flex"><input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => setImportFile(e.target.files?.[0] || null)} /><Button asChild><span><Upload className="h-4 w-4" />{importFile ? importFile.name : 'Choose export to import'}</span></Button></label>{importFile && <Button variant="danger" onClick={() => setConfirmImport(true)} loading={busy === 'import'}>Import and replace</Button>}</div>
      </Panel>
      <Panel title="Maintenance" className="lg:col-span-2"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-ink-2">Turn maintenance on before restoring or moving so nobody writes into a database you are about to replace.</p><span className="flex gap-2"><Button onClick={() => toggleMaintenance(true)}><Wrench className="h-4 w-4" />Turn on</Button><Button onClick={() => toggleMaintenance(false)}>Turn off</Button></span></div></Panel>
      <ConfirmDialog open={confirmImport} onOpenChange={setConfirmImport} title="Replace this instance with the export?" body="Everything currently here is deleted and replaced by the file's contents. Every session, including yours, is reset. Take a backup first." confirmLabel="Replace everything" onConfirm={runImport} />
    </div>
  );
}
