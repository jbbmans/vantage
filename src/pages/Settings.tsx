import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { startRegistration } from '@simplewebauthn/browser';
import { Save, KeyRound, Fingerprint, ShieldCheck, Smartphone, LogOut, Mail, Download, Upload, Sun, Moon, Monitor, Check, Copy, Printer } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Tabs, Panel, Badge, RoleBadge, Switch, Segmented, Skeleton, EmptyState } from '@/components/ui/primitives';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import CsvImportDialog from '@/components/CsvImportDialog';
import { Table, useParam } from '@/components/common';
import { keys, useIdentity, useOrg, usePrefs, useSavePrefs, signOutEverywhere } from '@/lib/queries';
import * as api from '@/lib/api';
import { ACCENTS, VISIBILITIES } from '../../shared/constants';
import { passwordProblem, passwordStrength } from '../../shared/password';
import { copyToClipboard, downloadText, timeAgo, humanize, cn } from '@/lib/utils';

export default function Settings() {
  const { data: identity } = useIdentity();
  const [tab, setTab] = useParam('tab', 'profile');
  const [verify] = useParam('verify');
  const toast = useToast(); const qc = useQueryClient();
  useEffect(() => { if (verify) api.emailConfirm(verify).then((r) => { toast.success(`Email confirmed: ${r.email}`); qc.invalidateQueries({ queryKey: keys.me }); window.history.replaceState(null, '', '/settings?tab=profile'); }).catch((e) => toast.error(api.errorText(e))); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verify]);
  if (!identity) return <Skeleton className="h-64" />;
  return (
    <div className="page max-w-5xl">
      <PageHeader eyebrow="Settings" title={`${identity.user.first_name} ${identity.user.last_name}`} lede={`@${identity.user.username}${identity.user.rank ? ` · ${identity.user.rank.name}` : ''}`} />
      {identity.user.must_change_password ? <div className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink">You signed in with a temporary password. Set a new one under Security before doing anything else.</div> : null}
      <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[{ value: 'profile', label: 'Profile' }, { value: 'security', label: 'Security' }, { value: 'appearance', label: 'Appearance' }, { value: 'digest', label: 'Weekly digest' }, { value: 'data', label: 'Your data' }]} />
      {tab === 'profile' && <Profile />}
      {tab === 'security' && <Security />}
      {tab === 'appearance' && <Appearance />}
      {tab === 'digest' && <Digest />}
      {tab === 'data' && <DataTab />}
    </div>
  );
}

function Profile() {
  const { data: identity } = useIdentity(); const { data: org } = useOrg(); const toast = useToast(); const qc = useQueryClient();
  const u = identity!.user;
  const [form, setForm] = useState({ first_name: u.first_name, last_name: u.last_name, middle_initial: u.middle_initial || '', rank_id: u.rank_id || '', mos: u.mos || '', eas: u.eas || '', email: u.email || '' });
  const [errors, setErrors] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true); setErrors({});
    try {
      const emailChanged = form.email !== (u.email || '');
      const body: Record<string, unknown> = { first_name: form.first_name, last_name: form.last_name, middle_initial: form.middle_initial || null, rank_id: form.rank_id || null, mos: form.mos || null, eas: form.eas || null };
      if (emailChanged && form.email && identity!.instance.emailEnabled) { await withSudo(() => api.emailVerify(form.email)); toast.info(`Confirmation sent to ${form.email}. The address changes once you click the link.`); }
      else if (emailChanged) body.email = form.email || null;
      await withSudo(() => api.updateProfile(body));
      qc.invalidateQueries({ queryKey: keys.me }); toast.success('Profile saved.');
    } catch (e: any) { setErrors(e?.fieldErrors || {}); toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title="Identity" className="lg:col-span-2" action={<Button variant="primary" size="sm" onClick={save} loading={busy}><Save className="h-4 w-4" />Save</Button>}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="First name" error={errors.first_name}><Input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></Field>
          <Field label="Last name" error={errors.last_name}><Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} /></Field>
          <Field label="MI"><Input value={form.middle_initial} maxLength={4} onChange={(e) => setForm({ ...form, middle_initial: e.target.value })} /></Field>
          <Field label="Rank" hint="decides JEPES vs FITREP" error={errors.rank_id}><Select value={form.rank_id || '__none'} onValueChange={(v) => setForm({ ...form, rank_id: v === '__none' ? '' : v })} options={[{ value: '__none', label: 'Not set' }, ...(org?.ranks || []).map((r: any) => ({ value: r.id, label: `${r.abbr} · ${r.name}` }))]} /></Field>
          <Field label="MOS"><Input value={form.mos} onChange={(e) => setForm({ ...form, mos: e.target.value })} /></Field>
          <Field label="EAS"><Input type="date" value={form.eas} onChange={(e) => setForm({ ...form, eas: e.target.value })} /></Field>
          <Field label="Email" className="col-span-2 sm:col-span-3" hint={identity!.instance.emailEnabled ? 'changes are confirmed by a link' : 'reset links and digests need email configured on the server'} error={errors.email}><Input type="email" spellCheck={false} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
        </div>
      </Panel>
      <Panel title="Units"><ul className="space-y-2">{identity!.memberships.map((m) => <li key={m.unit_id} className="rounded-md border border-line px-3 py-2 text-sm"><span className="flex items-center justify-between"><span className="font-medium text-ink">{m.unit_short || m.unit_name}</span>{m.is_primary ? <Badge tone="accent">Primary</Badge> : null}</span><span className="block text-xs text-ink-3">{m.billet || 'No billet'} · joined {timeAgo(m.joined_at)}</span><span className="mt-1 flex flex-wrap gap-1">{identity!.roles.filter((r) => r.unit_id === m.unit_id).map((r) => <RoleBadge key={r.id} color={r.color}>{r.name}</RoleBadge>)}</span></li>)}{!identity!.memberships.length && <li className="text-sm text-ink-3">Not in a unit. Ask a leader for an invitation.</li>}</ul></Panel>
    </div>
  );
}

function Security() {
  const { data: identity } = useIdentity(); const toast = useToast(); const qc = useQueryClient();
  const [pw, setPw] = useState({ current: '', next: '' }); const [busy, setBusy] = useState(false);
  const { data: sessions, refetch: refetchSessions } = useQuery({ queryKey: ['sessions'], queryFn: api.mySessions });
  const { data: pk, refetch: refetchPk } = useQuery({ queryKey: ['passkeys'], queryFn: api.passkeys });
  const { data: audit } = useQuery({ queryKey: ['my-audit'], queryFn: api.myAudit });
  const [totp, setTotp] = useState<{ secret: string; otpauth: string; qr: string } | null>(null); const [code, setCode] = useState(''); const [codes, setCodes] = useState<string[] | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false); const [pkName, setPkName] = useState('');
  const changePassword = async () => { setBusy(true); try { const r = await api.changePassword(pw.current, pw.next); toast.success(`Password changed. ${r.otherSessionsRevoked} other session${r.otherSessionsRevoked === 1 ? '' : 's'} signed out.`); setPw({ current: '', next: '' }); qc.invalidateQueries({ queryKey: keys.me }); refetchSessions(); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  const startTotp = async () => { try { setTotp(await withSudo(() => api.totpStart())); setCode(''); } catch (e) { toast.error(api.errorText(e)); } };
  const confirmTotp = async () => { try { const r = await withSudo(() => api.totpConfirm(code)); setCodes(r.recoveryCodes); setTotp(null); qc.invalidateQueries({ queryKey: keys.me }); toast.success('Authenticator enabled.'); } catch (e) { toast.error(api.errorText(e)); } };
  const disableTotp = async () => { try { await withSudo(() => api.totpDisable()); qc.invalidateQueries({ queryKey: keys.me }); toast.success('Authenticator disabled.'); } catch (e) { toast.error(api.errorText(e)); } };
  const regen = async () => { try { const r = await withSudo(() => api.regenerateRecovery()); setCodes(r.recoveryCodes); } catch (e) { toast.error(api.errorText(e)); } };
  const addPasskey = async () => {
    try {
      const options = await withSudo(() => api.passkeyRegisterOptions());
      let response; try { response = await startRegistration({ optionsJSON: options }); } catch (e) { throw new Error((e as Error).name === 'NotAllowedError' ? 'Passkey prompt was cancelled.' : (e as Error).message); }
      await withSudo(() => api.passkeyRegister(response, pkName || defaultPasskeyName()));
      setPkName(''); refetchPk(); qc.invalidateQueries({ queryKey: keys.me }); toast.success('Passkey added. Next time, sign in without a password.');
    } catch (e) { toast.error(api.errorText(e)); }
  };
  const removePasskey = async (id: string) => { try { await withSudo(() => api.passkeyDelete(id)); refetchPk(); qc.invalidateQueries({ queryKey: keys.me }); toast.success('Passkey removed.'); } catch (e) { toast.error(api.errorText(e)); } };
  const u = identity!.user;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Password" subtitle="fifteen characters or more; changing it signs out other devices">
        <div className="space-y-3">
          <Field label="Current password"><Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></Field>
          <Field label="New password" hint={pw.next ? passwordStrength(pw.next).label : undefined}><Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
          {pw.next && passwordProblem(pw.next) && <p className="text-xs text-warn">{passwordProblem(pw.next)}</p>}
          <Button variant="primary" onClick={changePassword} loading={busy} disabled={!pw.current || Boolean(passwordProblem(pw.next))}><KeyRound className="h-4 w-4" />Change password</Button>
        </div>
      </Panel>
      <Panel title="Passkeys" subtitle="Face ID, Windows Hello, or a security key. Phishing-resistant." action={<Badge tone={pk?.passkeys?.length ? 'good' : 'neutral'}>{pk?.passkeys?.length || 0} registered</Badge>}>
        <ul className="mb-3 space-y-1.5">{(pk?.passkeys || []).map((p: any) => <li key={p.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"><span className="flex items-center gap-2"><Fingerprint className="h-4 w-4 text-ink-3" /><span><span className="block text-ink">{p.name}</span><span className="block text-2xs text-ink-3">added {timeAgo(p.created_at)}{p.last_used_at ? ` · used ${timeAgo(p.last_used_at)}` : ''}{p.backed_up ? ' · synced' : ''}</span></span></span><Button size="xs" variant="ghost" onClick={() => removePasskey(p.id)}>Remove</Button></li>)}</ul>
        <div className="flex gap-2"><Input aria-label="Passkey name" placeholder="This phone" value={pkName} onChange={(e) => setPkName(e.target.value)} /><Button variant="primary" onClick={addPasskey}><Fingerprint className="h-4 w-4" />Add passkey</Button></div>
        <p className="mt-2 text-2xs text-ink-3">Registered for {pk?.rpId || window.location.hostname}. Add one per device you sign in from.</p>
      </Panel>
      <Panel title="Authenticator app" subtitle="a six-digit code as a second step" action={<Badge tone={u.totp_enabled ? 'good' : 'neutral'}>{u.totp_enabled ? 'On' : 'Off'}</Badge>}>
        {u.totp_enabled ? <div className="flex flex-wrap gap-2"><Button onClick={regen}>New recovery codes</Button><Button variant="danger" onClick={() => setConfirmDisable(true)}>Turn off</Button></div> : <div className="space-y-2"><p className="text-sm text-ink-2">Scan a QR code with any authenticator app. You get ten recovery codes for when the phone is not around.</p><Button variant="primary" onClick={startTotp}><Smartphone className="h-4 w-4" />Set up</Button></div>}
      </Panel>
      <Panel title="Signed-in devices" action={<Button size="sm" variant="ghost" onClick={async () => { try { const r = await api.revokeOtherSessions(); toast.success(`${r.revoked} other session${r.revoked === 1 ? '' : 's'} signed out.`); refetchSessions(); } catch (e) { toast.error(api.errorText(e)); } }}><LogOut className="h-3.5 w-3.5" />Sign out others</Button>}>
        <ul className="space-y-1.5">{(sessions?.sessions || []).map((s: any) => <li key={s.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm"><span><span className="flex items-center gap-2 text-ink">{s.current ? <Badge tone="accent">This device</Badge> : null}<span className="truncate">{describeAgent(s.user_agent)}</span></span><span className="block text-2xs text-ink-3">{s.method} · {s.ip || 'unknown IP'} · active {timeAgo(s.last_used_at || s.created_at)}</span></span>{!s.current && <Button size="xs" variant="ghost" onClick={async () => { try { await api.revokeSession(s.id); refetchSessions(); } catch (e) { toast.error(api.errorText(e)); } }}>Sign out</Button>}</li>)}</ul>
      </Panel>
      <Panel className="lg:col-span-2" title="Who has looked at your record" subtitle="every open of your data by someone else" padded={false}>
        {!audit?.length ? <EmptyState icon={ShieldCheck} title="Nobody but you" description="Leaders opening your shared records will show up here." /> : <Table head={<><th className="w-40">When</th><th className="w-40">Who</th><th>What</th></>}>{audit.map((r: any) => <tr key={r.id}><td className="fig text-xs text-ink-3">{new Date(r.at).toLocaleString()}</td><td className="text-xs">{r.rank_abbr || ''} {r.last_name || 'System'}</td><td className="text-xs text-ink">{humanize(r.action)}{r.entity ? ` · ${r.entity}` : ''}{r.detail ? <span className="text-ink-3"> · {r.detail}</span> : ''}</td></tr>)}</Table>}
      </Panel>

      <Dialog open={Boolean(totp)} onOpenChange={(o) => { if (!o) setTotp(null); }} title="Set up your authenticator" description="Scan, then enter the code the app shows." size="sm" footer={<><Button variant="ghost" onClick={() => setTotp(null)}>Cancel</Button><Button variant="primary" onClick={confirmTotp} disabled={code.replace(/\s/g, '').length < 6}>Turn on</Button></>}>
        {totp && <div className="space-y-3 text-center"><img src={totp.qr} alt="QR code for authenticator app" width={192} height={192} className="mx-auto h-48 w-48 rounded-md border border-line bg-white p-1" /><p className="text-xs text-ink-3">Cannot scan? Enter this key: <code className="mono select-all break-all text-ink">{totp.secret}</code></p><Field label="Code from the app"><Input inputMode="numeric" autoComplete="one-time-code" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} className="fig text-center text-lg tracking-[0.3em]" /></Field></div>}
      </Dialog>
      <Dialog open={Boolean(codes)} onOpenChange={(o) => { if (!o) setCodes(null); }} title="Recovery codes" description="Each works once. Keep them somewhere other than your phone. Old codes no longer work." size="sm" footer={<><Button variant="ghost" onClick={async () => { if (await copyToClipboard((codes || []).join('\n'))) toast.success('Copied.'); }}><Copy className="h-4 w-4" />Copy</Button><Button variant="ghost" onClick={() => downloadText('vantage-recovery-codes.txt', `Vantage recovery codes for ${u.username}\n\n${(codes || []).join('\n')}\n`)}><Download className="h-4 w-4" />Download</Button><Button variant="primary" onClick={() => setCodes(null)}><Check className="h-4 w-4" />I saved them</Button></>}>
        <ul className="grid grid-cols-2 gap-1.5">{(codes || []).map((c) => <li key={c} className="mono rounded-md border border-line bg-surface-2 px-2 py-1.5 text-center text-sm text-ink">{c}</li>)}</ul>
      </Dialog>
      <ConfirmDialog open={confirmDisable} onOpenChange={setConfirmDisable} title="Turn off the authenticator?" body="Sign-in goes back to password only (plus any passkeys). Recovery codes are deleted." confirmLabel="Turn off" onConfirm={disableTotp} />
    </div>
  );
}

function defaultPasskeyName() { const ua = navigator.userAgent; if (/iPhone|iPad/.test(ua)) return 'iPhone'; if (/Android/.test(ua)) return 'Android phone'; if (/Mac/.test(ua)) return 'Mac'; if (/Windows/.test(ua)) return 'Windows PC'; return 'Passkey'; }
function describeAgent(ua?: string | null) { if (!ua) return 'Unknown device'; const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Device'; const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'browser'; return `${browser} on ${os}`; }

function Appearance() {
  const prefs = usePrefs(); const save = useSavePrefs();
  const theme = prefs.theme || 'light';
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Theme">
        <Segmented label="Theme" value={theme} onChange={(v) => save.mutate({ theme: v })} options={[{ value: 'light', label: <span className="flex items-center gap-1.5"><Sun className="h-4 w-4" />Light</span> }, { value: 'dark', label: <span className="flex items-center gap-1.5"><Moon className="h-4 w-4" />Dark</span> }, { value: 'system', label: <span className="flex items-center gap-1.5"><Monitor className="h-4 w-4" />System</span> }]} />
        <div className="mt-5"><p className="mb-2 text-xs font-semibold text-ink-2">Density</p><Segmented label="Density" value={prefs.density || 'comfortable'} onChange={(v) => save.mutate({ density: v })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} /></div>
      </Panel>
      <Panel title="Accent color" subtitle="pre-set palettes tuned for both themes">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{ACCENTS.map((a) => <button key={a.id} type="button" onClick={() => save.mutate({ accent: a.id })} className={cn('flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors', (prefs.accent || 'scarlet') === a.id ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong')}><span className="flex h-8 w-8 items-center justify-center rounded-full border border-line" data-accent={a.id} style={{ backgroundColor: 'rgb(var(--accent))' }}>{(prefs.accent || 'scarlet') === a.id && <Check className="h-4 w-4" style={{ color: 'rgb(var(--accent-ink))' }} />}</span><span><span className="block text-sm font-medium text-ink">{a.label}</span><span className="block text-xs text-ink-3">{a.hint}</span></span></button>)}</div>
      </Panel>
      <Panel title="Defaults" className="lg:col-span-2">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="New entries are"><Select value={prefs.defaultVisibility || 'private'} onValueChange={(v) => save.mutate({ defaultVisibility: v as never })} options={VISIBILITIES.map((v) => ({ value: v, label: v === 'private' ? 'Only me' : 'Shared with my unit' }))} /></Field>
          <div className="pt-5"><Switch checked={Boolean(prefs.quickLogExpanded)} onChange={(v) => save.mutate({ quickLogExpanded: v })} label="Show every field in Quick Log" description="Organization, system, notes, and visibility open by default." /></div>
        </div>
      </Panel>
    </div>
  );
}

function Digest() {
  const { data: identity } = useIdentity(); const prefs = usePrefs(); const save = useSavePrefs(); const toast = useToast();
  const digest = prefs.digest || { enabled: false, weekday: 1, hour: 6 };
  const { data: preview, isPending } = useQuery({ queryKey: ['digest-preview'], queryFn: api.digestPreview });
  const [sending, setSending] = useState(false);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Weekly email" subtitle={identity!.instance.emailEnabled ? 'what you logged, what is overdue, what is closing' : 'email is not configured on this server'}>
        <Switch checked={digest.enabled} onChange={(v) => save.mutate({ digest: { ...digest, enabled: v } })} label="Send me a weekly digest" description={identity!.user.email ? `To ${identity!.user.email}` : 'Add an email in Profile first.'} disabled={!identity!.instance.emailEnabled || !identity!.user.email} />
        <div className="mt-3 grid grid-cols-2 gap-3"><Field label="Day"><Select value={String(digest.weekday)} onValueChange={(v) => save.mutate({ digest: { ...digest, weekday: Number(v) } })} options={days.map((d, i) => ({ value: String(i), label: d }))} /></Field><Field label="Hour" hint="server time zone"><Select value={String(digest.hour)} onValueChange={(v) => save.mutate({ digest: { ...digest, hour: Number(v) } })} options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))} /></Field></div>
        <Button className="mt-3" onClick={async () => { setSending(true); try { await api.digestSendNow(); toast.success('Digest sent.'); } catch (e) { toast.error(api.errorText(e)); } finally { setSending(false); } }} loading={sending} disabled={!identity!.instance.emailEnabled || !identity!.user.email}><Mail className="h-4 w-4" />Send one now</Button>
      </Panel>
      <Panel title="Preview" subtitle={preview?.subject}>{isPending ? <Skeleton className="h-40" /> : <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink-2">{preview?.text}</pre>}</Panel>
    </div>
  );
}

function DataTab() {
  const toast = useToast(); const [importOpen, setImportOpen] = useState(false);
  const exportCsv = async () => { try { const n = await api.downloadFile(api.reportCsvUrl({ period: 'all' }), 'vantage-activities.csv'); toast.success(`Downloaded ${n}.`); } catch (e) { toast.error(api.errorText(e)); } };
  const exportPdf = async () => { try { const n = await api.downloadFile(api.reportPdfUrl({ period: 'fiscalYear', limit: 12 }), 'vantage-report.pdf'); toast.success(`Downloaded ${n}.`); } catch (e) { toast.error(api.errorText(e)); } };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Export" subtitle="your records belong to you">
        <div className="flex flex-wrap gap-2"><Button onClick={exportCsv}><Download className="h-4 w-4" />All activities (CSV)</Button><Button onClick={exportPdf}><Printer className="h-4 w-4" />This FY as PDF</Button></div>
        <p className="mt-3 text-xs leading-relaxed text-ink-3">The CSV includes a Vantage ID column. Edit it in a spreadsheet and import it back: rows with an ID update the original, rows without become new entries.</p>
      </Panel>
      <Panel title="Import" subtitle="from a Vantage export or any spreadsheet">
        <Button variant="primary" onClick={() => setImportOpen(true)}><Upload className="h-4 w-4" />Import CSV</Button>
        <p className="mt-3 text-xs leading-relaxed text-ink-3">Up to 1000 rows per file. Likely duplicates are screened before anything is written.</p>
      </Panel>
      <Panel title="Sign out everywhere" className="lg:col-span-2"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-ink-2">Ends this session and every other one, on every device.</p><Button variant="danger" onClick={() => signOutEverywhere()}><LogOut className="h-4 w-4" />Sign out</Button></div></Panel>
      <CsvImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}
