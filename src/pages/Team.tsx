import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, UserPlus, Link2, Mail, Shield, Building2, Download, Search, Sparkles, ClipboardList, Copy } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, Textarea, Tabs, EmptyState, Badge, Panel, Stat, Skeleton, Switch } from '@/components/ui/primitives';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { AiAction, AiResult } from '@/components/AiPanel';
import { AreaChart, BarList } from '@/components/charts';
import { DateText, Table, useParam } from '@/components/common';
import { keys, useIdentity, useOrg, useRoles, useTeam, unitsWith, can } from '@/lib/queries';
import * as api from '@/lib/api';
import { PERMISSIONS, PERMISSION_LIST, ROLE_TEMPLATE, listPermissions } from '../../shared/permissions';
import { ECHELONS, CATEGORY_COLORS, type Category } from '../../shared/constants';
import { formatDollars, formatNumber } from '../../shared/metrics';
import { copyToClipboard, cn, humanize, fullName } from '@/lib/utils';
import { downloadText } from '@/lib/utils';

export default function Team() {
  const { data: identity } = useIdentity();
  const { data: org } = useOrg();
  const { data: team, isPending } = useTeam();
  const [tab, setTab] = useParam('tab', 'roster');
  const readable = identity?.readableUnitIds || [];
  const [unit, setUnit] = useParam('unit', identity?.primaryUnitId && readable.includes(identity.primaryUnitId) ? identity.primaryUnitId : readable[0] || '');
  const units: any[] = org?.units || [];
  const unitLabel = (id: string) => { const u = units.find((x) => x.id === id); return u ? u.short_name || u.name : id; };
  const manageMembers = unitsWith(identity, PERMISSIONS.MANAGE_MEMBERS);
  const manageRoles = unitsWith(identity, PERMISSIONS.MANAGE_ROLES);
  const manageUnits = unitsWith(identity, PERMISSIONS.MANAGE_UNITS);
  const viewAudit = unitsWith(identity, PERMISSIONS.VIEW_AUDIT);
  const tabs = [{ value: 'roster', label: 'Roster', count: team?.roster?.length }, { value: 'dashboard', label: 'Unit dashboard' }];
  if (manageMembers.length) tabs.push({ value: 'invites', label: 'Invitations' });
  if (manageRoles.length || manageUnits.length || identity?.user.is_operator) tabs.push({ value: 'roles', label: 'Roles' });
  if (manageUnits.length || identity?.user.is_operator) tabs.push({ value: 'units', label: 'Units' });
  if (viewAudit.length) tabs.push({ value: 'audit', label: 'Access log' });

  if (!identity?.canLead) return <div className="page"><PageHeader eyebrow="Team" title="Team" /><div className="card"><EmptyState icon={Users} title="No unit visibility yet" description="Team shows the Marines and shared records of units where you hold a leadership role. Ask your unit leader for a role." /></div></div>;

  return (
    <div className="page">
      <PageHeader eyebrow="Team" title="Leading" lede="Shared records only. Private entries never appear here, and every open of a member's record is logged.">
        {readable.length > 1 && <Select aria-label="Unit" className="w-56" value={unit} onValueChange={setUnit} options={readable.map((id) => ({ value: id, label: unitLabel(id) }))} />}
      </PageHeader>
      <Tabs value={tab} onChange={setTab} className="mb-4" tabs={tabs} />
      {isPending ? <Skeleton className="h-64" /> : (
        <>
          {tab === 'roster' && <Roster team={team} unit={unit} unitLabel={unitLabel} canManage={manageMembers.includes(unit)} />}
          {tab === 'dashboard' && unit && <UnitDashboard unitId={unit} unitLabel={unitLabel(unit)} canExport={can(identity, PERMISSIONS.EXPORT_DATA, unit)} canDetail={can(identity, PERMISSIONS.VIEW_MEMBER_DETAIL, unit)} />}
          {tab === 'invites' && <Invites unitId={manageMembers.includes(unit) ? unit : manageMembers[0]} unitLabel={unitLabel} />}
          {tab === 'roles' && <Roles unitId={unit} unitLabel={unitLabel} />}
          {tab === 'units' && <Units units={units} manageUnits={manageUnits} isOperator={Boolean(identity.user.is_operator)} roster={team?.roster || []} />}
          {tab === 'audit' && <UnitAudit unitId={viewAudit.includes(unit) ? unit : viewAudit[0]} />}
        </>
      )}
    </div>
  );
}

function Roster({ team, unit, unitLabel, canManage }: { team: any; unit: string; unitLabel: (id: string) => string; canManage: boolean }) {
  const [q, setQ] = useState('');
  const [enroll, setEnroll] = useState(false);
  const roster: any[] = useMemo(() => (team?.roster || []).filter((p: any) => (!unit || p.memberships.some((m: any) => m.unit_id === unit)) && (!q.trim() || `${p.first_name} ${p.last_name} ${p.mos || ''} ${p.rank_abbr || ''}`.toLowerCase().includes(q.trim().toLowerCase()))), [team, unit, q]);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-3" /><Input aria-label="Search roster" className="pl-8" placeholder="Name, rank, MOS…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {canManage && <Button variant="primary" onClick={() => setEnroll(true)}><UserPlus className="h-4 w-4" />Enroll an existing account</Button>}
      </div>
      {roster.length === 0 ? <div className="card"><EmptyState icon={Users} title="No members here yet" description={canManage ? 'Invite Marines from the Invitations tab, or enroll an account that already exists.' : 'Nobody has joined this unit yet.'} /></div> : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <Table head={<><th>Marine</th><th className="w-28">MOS</th><th>Billet</th><th>Roles</th><th className="w-24"></th></>}>
            {roster.map((p) => { const m = p.memberships.find((x: any) => x.unit_id === unit) || p.memberships[0]; return (
              <tr key={p.id}>
                <td><span className="flex items-center gap-2.5"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-xs font-bold text-ink">{(p.first_name[0] || '') + (p.last_name[0] || '')}</span><span className="min-w-0"><span className="block font-medium text-ink">{p.rank_abbr || ''} {p.last_name}, {p.first_name}</span><span className="block text-xs text-ink-3">{m ? `${m.unit_short || m.unit_name}${m.is_primary ? '' : ' (secondary)'}` : ''}</span></span></span></td>
                <td className="fig text-xs">{p.mos || ''}</td><td className="text-xs text-ink-2">{m?.billet || ''}</td>
                <td><span className="flex flex-wrap gap-1">{p.roles.filter((r: any) => r.unit_id === unit).map((r: any) => <Badge key={r.id} style={{ borderColor: r.color || undefined, color: r.color || undefined }}>{r.name}</Badge>)}</span></td>
                <td className="text-right">{p.canOpen ? <Button size="xs" asChild><Link to={`/team/${p.id}`}>Open</Link></Button> : <span className="text-2xs text-ink-3">roster only</span>}</td>
              </tr>
            ); })}
          </Table>
        </div>
      )}
      <EnrollDialog open={enroll} onOpenChange={setEnroll} unitId={unit} unitLabel={unitLabel(unit)} />
    </>
  );
}

function EnrollDialog({ open, onOpenChange, unitId, unitLabel }: { open: boolean; onOpenChange: (o: boolean) => void; unitId: string; unitLabel: string }) {
  const toast = useToast(); const qc = useQueryClient();
  const { data: rolesData } = useRoles(open);
  const [q, setQ] = useState(''); const [results, setResults] = useState<any[]>([]); const [picked, setPicked] = useState<any>(null);
  const [roleId, setRoleId] = useState(''); const [billet, setBillet] = useState(''); const [primary, setPrimary] = useState(false); const [busy, setBusy] = useState(false);
  useEffect(() => { if (!open) { setQ(''); setResults([]); setPicked(null); setRoleId(''); setBillet(''); } }, [open]);
  useEffect(() => { if (q.trim().length < 2) { setResults([]); return; } const t = setTimeout(() => api.directory(unitId, q.trim()).then((r) => setResults(r.results || [])).catch(() => setResults([])), 200); return () => clearTimeout(t); }, [q, unitId]);
  const roles = (rolesData?.roles || []).filter((r: any) => r.unit_id === unitId && r.key !== 'unit-leader' && !r.is_default);
  const submit = async () => { setBusy(true); try { await api.addMember(unitId, { user_id: picked.id, role_id: roleId || null, billet: billet || null, primary }); qc.invalidateQueries({ queryKey: keys.team }); toast.success(`${picked.last_name} enrolled in ${unitLabel}.`); onOpenChange(false); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={`Enroll in ${unitLabel}`} description="For Marines who already have a Vantage account. Their sessions reset so the new membership applies." size="sm" footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={submit} loading={busy} disabled={!picked}>Enroll</Button></>}>
      <div className="space-y-3">
        <Field label="Find by username, last name, or email"><Input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPicked(null); }} /></Field>
        {results.length > 0 && !picked && <ul className="max-h-40 overflow-y-auto rounded-md border border-line">{results.map((r) => <li key={r.id}><button type="button" className="row flex w-full items-center justify-between px-3 py-2 text-left text-sm" onClick={() => { setPicked(r); setQ(`${r.rank_abbr || ''} ${r.last_name}, ${r.first_name}`.trim()); }}><span>{r.rank_abbr || ''} {r.last_name}, {r.first_name}</span><span className="text-xs text-ink-3">@{r.username}</span></button></li>)}</ul>}
        {picked && <><Field label="Role" hint="Marine is always granted"><Select value={roleId || '__none'} onValueChange={(v) => setRoleId(v === '__none' ? '' : v)} options={[{ value: '__none', label: 'Marine (default)' }, ...roles.map((r: any) => ({ value: r.id, label: r.name }))]} /></Field><Field label="Billet"><Input value={billet} onChange={(e) => setBillet(e.target.value)} placeholder="Budget Analyst" /></Field><Switch checked={primary} onChange={setPrimary} label="Make this their primary unit" description="New entries default to sharing here." /></>}
      </div>
    </Dialog>
  );
}

function Invites({ unitId, unitLabel }: { unitId: string; unitLabel: (id: string) => string }) {
  const toast = useToast(); const { data: identity } = useIdentity(); const { data: org } = useOrg(); const { data: rolesData } = useRoles();
  const { data, refetch } = useQuery({ queryKey: ['invites', unitId], queryFn: () => api.listInvites(unitId), enabled: Boolean(unitId) });
  const [form, setForm] = useState({ email: '', first_name: '', last_name: '', rank_id: '', billet: '', role_id: '' });
  const [busy, setBusy] = useState(false); const [created, setCreated] = useState<any>(null);
  const roles = (rolesData?.roles || []).filter((r: any) => r.unit_id === unitId && r.key !== 'unit-leader' && !r.is_default);
  const create = async () => { setBusy(true); try { const r = await api.createInvite(unitId, { email: form.email || undefined, first_name: form.first_name || undefined, last_name: form.last_name || undefined, rank_id: form.rank_id || null, billet: form.billet || null, role_id: form.role_id || null }); setCreated(r); refetch(); toast.success(r.emailed ? `Invitation emailed to ${form.email}.` : 'Invitation link created. Copy it and send it yourself.'); setForm({ email: '', first_name: '', last_name: '', rank_id: '', billet: '', role_id: '' }); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Panel title={`Invite to ${unitLabel(unitId)}`} subtitle="a link that works for seven days" className="lg:col-span-1">
        <div className="space-y-3">
          <Field label="Email" hint={identity?.instance.emailEnabled ? 'emailed automatically' : 'optional; email is not configured, so you send the link'}><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3"><Field label="First name"><Input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></Field><Field label="Last name"><Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} /></Field>
            <Field label="Rank"><Select value={form.rank_id || '__none'} onValueChange={(v) => setForm({ ...form, rank_id: v === '__none' ? '' : v })} options={[{ value: '__none', label: 'Not set' }, ...(org?.ranks || []).map((r: any) => ({ value: r.id, label: r.abbr }))]} /></Field><Field label="Billet"><Input value={form.billet} onChange={(e) => setForm({ ...form, billet: e.target.value })} /></Field></div>
          <Field label="Role on arrival"><Select value={form.role_id || '__none'} onValueChange={(v) => setForm({ ...form, role_id: v === '__none' ? '' : v })} options={[{ value: '__none', label: 'Marine (default)' }, ...roles.map((r: any) => ({ value: r.id, label: r.name }))]} /></Field>
          <Button variant="primary" className="w-full" onClick={create} loading={busy}>{form.email && identity?.instance.emailEnabled ? <><Mail className="h-4 w-4" />Send invitation</> : <><Link2 className="h-4 w-4" />Create link</>}</Button>
          {created && <div className="rounded-md border border-good/40 bg-good/5 p-3 text-xs"><p className="font-medium text-ink">Invitation ready{created.emailed ? ' and emailed' : ''}.</p><p className="mt-1 break-all font-mono text-ink-2">{created.url}</p><Button size="xs" className="mt-2" onClick={async () => { if (await copyToClipboard(created.url)) toast.success('Link copied.'); else toast.error('Could not copy.'); }}><Copy className="h-3 w-3" />Copy link</Button></div>}
        </div>
      </Panel>
      <Panel title="Open invitations" className="lg:col-span-2" padded={false}>
        {!data?.invites?.length ? <EmptyState title="No open invitations" /> : (
          <Table head={<><th>Invitee</th><th>Role · billet</th><th className="w-28">Expires</th><th className="w-28">By</th><th className="w-20"></th></>}>
            {data.invites.map((i: any) => <tr key={i.id}><td><span className="block text-ink">{i.email || 'Link invitation'}</span><span className="block text-xs text-ink-3">{[i.payload.first_name, i.payload.last_name].filter(Boolean).join(' ')}</span></td><td className="text-xs text-ink-2">{roles.find((r: any) => r.id === i.payload.role_id)?.name || 'Marine'}{i.payload.billet ? ` · ${i.payload.billet}` : ''}</td><td className="text-xs"><DateText value={i.expires_at?.slice(0, 10)} /></td><td className="text-xs text-ink-3">{i.by_last || ''}</td><td className="text-right">{i.used_at ? <Badge tone="good">Used</Badge> : <Button size="xs" variant="ghost" onClick={async () => { try { await api.revokeInvite(i.id); refetch(); } catch (e) { toast.error(api.errorText(e)); } }}>Revoke</Button>}</td></tr>)}
          </Table>
        )}
      </Panel>
    </div>
  );
}

function Roles({ unitId, unitLabel }: { unitId: string; unitLabel: (id: string) => string }) {
  const toast = useToast(); const qc = useQueryClient();
  const { data, isPending } = useRoles();
  const [editing, setEditing] = useState<any>(null); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState<any>(null);
  const roles: any[] = (data?.roles || []).filter((r: any) => r.unit_id === unitId);
  const myPosition = data?.positions?.[unitId] ?? 0;
  const save = async () => {
    setBusy(true);
    try {
      const body = { unit_id: unitId, name: editing.name, description: editing.description || null, color: editing.color || null, position: Number(editing.position) || 0, permissions: editing.permissions };
      if (editing.id) { const r = await api.updateRole(editing.id, body); if (r.sessionsRevoked) toast.info(`${r.sessionsRevoked} session${r.sessionsRevoked === 1 ? '' : 's'} signed out so the change applies.`); } else await api.createRole(body);
      qc.invalidateQueries({ queryKey: keys.roles }); qc.invalidateQueries({ queryKey: keys.team }); toast.success('Role saved.'); setEditing(null);
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  const togglePerm = (bit: number) => setEditing((e: any) => ({ ...e, permissions: e.permissions & bit ? e.permissions & ~bit : e.permissions | bit }));
  const groups = [...new Set(PERMISSION_LIST.map((p) => p.group))];
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2"><p className="text-sm text-ink-2">Roles in <strong className="text-ink">{unitLabel(unitId)}</strong>. Permissions apply in this unit only. You can only manage roles below your own position ({myPosition}).</p><Button variant="primary" onClick={() => setEditing({ name: '', description: '', color: '#6b7a8f', position: Math.max(0, myPosition - 10), permissions: ROLE_TEMPLATE[1].permissions })}><Shield className="h-4 w-4" />New role</Button></div>
      {isPending ? <Skeleton className="h-40" /> : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {roles.map((r) => (
            <article key={r.id} className="card p-4">
              <div className="flex items-start justify-between gap-2"><div className="flex items-center gap-2"><span className="badge-dot h-3 w-3" style={{ backgroundColor: r.color || '#6b7a8f' }} /><h3 className="text-base font-semibold text-ink">{r.name}</h3>{r.is_default ? <Badge>Default</Badge> : null}{r.key === 'unit-leader' ? <Badge tone="accent">Owner</Badge> : null}</div><span className="fig text-xs text-ink-3">pos {r.position}</span></div>
              {r.description && <p className="mt-1 text-sm text-ink-2">{r.description}</p>}
              <ul className="mt-2 flex flex-wrap gap-1">{listPermissions(r.permissions).map((k) => <li key={k}><Badge tone={k === 'ADMINISTRATOR' ? 'bad' : 'neutral'}>{PERMISSION_LIST.find((p) => p.key === k)?.label}</Badge></li>)}</ul>
              {r.editable && <div className="mt-3 flex justify-end gap-1 border-t border-line pt-2"><Button size="xs" variant="ghost" onClick={() => setEditing({ ...r, description: r.description || '', color: r.color || '#6b7a8f' })}>Edit</Button>{!r.is_default && r.key !== 'unit-leader' && <Button size="xs" variant="ghost" onClick={() => setConfirm(r)}>Delete</Button>}</div>}
            </article>
          ))}
        </div>
      )}
      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} title={editing?.id ? `Edit ${editing.name}` : 'New role'} description="Changing permissions signs out everyone who holds the role so the new scope applies immediately." footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={save} loading={busy} disabled={!editing?.name?.trim()}>Save role</Button></>}>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3"><Field label="Name" required><Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} disabled={editing.key === 'unit-leader' || editing.is_default} /></Field><Field label="Position" hint="0-99"><Input type="number" min={0} max={99} className="w-20" value={editing.position} onChange={(e) => setEditing({ ...editing, position: e.target.value })} /></Field><Field label="Color"><input type="color" className="h-9 w-12 cursor-pointer rounded-md border border-line bg-surface" value={editing.color || '#6b7a8f'} onChange={(e) => setEditing({ ...editing, color: e.target.value })} aria-label="Role color" /></Field></div>
            <Field label="Description"><Textarea rows={2} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
            <div className="flex flex-wrap gap-1.5"><span className="text-xs text-ink-3">Start from:</span>{ROLE_TEMPLATE.filter((t) => !t.owner).map((t) => <button key={t.key} type="button" className="rounded-full border border-line px-2 py-0.5 text-2xs hover:border-line-strong" onClick={() => setEditing({ ...editing, permissions: t.permissions })}>{t.name}</button>)}</div>
            {groups.map((g) => <fieldset key={g}><legend className="eyebrow mb-1.5">{g}</legend><div className="space-y-1">{PERMISSION_LIST.filter((p) => p.group === g).map((p) => <label key={p.key} className={cn('flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2', p.dangerous && 'border border-bad/30')}><input type="checkbox" className="mt-1" checked={Boolean(editing.permissions & PERMISSIONS[p.key])} onChange={() => togglePerm(PERMISSIONS[p.key])} /><span><span className="block text-sm font-medium text-ink">{p.label}</span><span className="block text-xs text-ink-3">{p.hint}</span></span></label>)}</div></fieldset>)}
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title={`Delete the ${confirm?.name} role?`} body="Everyone holding it loses those permissions and is signed out." onConfirm={async () => { try { await api.deleteRole(confirm.id); qc.invalidateQueries({ queryKey: keys.roles }); qc.invalidateQueries({ queryKey: keys.team }); toast.success('Role deleted.'); } catch (e) { toast.error(api.errorText(e)); } }} />
    </>
  );
}

function Units({ units, manageUnits, isOperator, roster }: { units: any[]; manageUnits: string[]; isOperator: boolean; roster: any[] }) {
  const toast = useToast(); const qc = useQueryClient(); const { data: identity } = useIdentity();
  const [editing, setEditing] = useState<any>(null); const [busy, setBusy] = useState(false); const [confirm, setConfirm] = useState<any>(null); const [transfer, setTransfer] = useState<any>(null); const [newOwner, setNewOwner] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: keys.org }); qc.invalidateQueries({ queryKey: keys.me }); qc.invalidateQueries({ queryKey: keys.team }); };
  const save = async () => { setBusy(true); try { if (editing.id) await api.updateUnit(editing.id, { name: editing.name, short_name: editing.short_name || null, echelon: editing.echelon, location: editing.location || null, parent_id: editing.parent_id || null }); else await api.createUnit({ name: editing.name, short_name: editing.short_name || null, echelon: editing.echelon, location: editing.location || null, parent_id: editing.parent_id || null }); refresh(); toast.success('Unit saved.'); setEditing(null); } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); } };
  const tree = (parent: string | null, depth = 0): any[] => units.filter((u) => (u.parent_id || null) === parent).flatMap((u) => [{ ...u, depth }, ...tree(u.id, depth + 1)]);
  const rows = tree(null);
  const orphans = units.filter((u) => u.parent_id && !units.some((p) => p.id === u.parent_id)).map((u) => ({ ...u, depth: 0 }));
  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2"><p className="text-sm text-ink-2">Units you can manage. Sub-units inherit nothing upward: leading a parent grants no reach into a child.</p><Button variant="primary" onClick={() => setEditing({ name: '', short_name: '', echelon: 'section', location: '', parent_id: manageUnits[0] || '' })} disabled={!manageUnits.length && !isOperator}><Building2 className="h-4 w-4" />New unit</Button></div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <Table head={<><th>Unit</th><th className="w-36">Echelon</th><th className="w-40">Leader</th><th className="w-40"></th></>}>
          {[...rows, ...orphans].map((u) => { const owner = roster.find((p) => p.id === u.owner_user_id); const canManage = manageUnits.includes(u.id) || isOperator; return (
            <tr key={u.id}><td><span style={{ paddingLeft: `${u.depth * 16}px` }} className="flex items-center gap-2"><span className="font-medium text-ink">{u.name}</span>{u.short_name && <span className="text-xs text-ink-3">{u.short_name}</span>}<span className="fig text-2xs text-ink-3">{u.code}</span></span></td><td className="text-xs text-ink-2">{ECHELONS.find((e) => e.value === u.echelon)?.label || humanize(u.echelon)}</td><td className="text-xs text-ink-2">{owner ? `${owner.rank_abbr || ''} ${owner.last_name}` : u.owner_user_id === identity?.user.id ? 'You' : u.owner_user_id ? 'Set' : <span className="text-warn">Unclaimed</span>}</td>
              <td className="text-right">{canManage && <span className="flex justify-end gap-1"><Button size="xs" variant="ghost" onClick={() => setEditing({ ...u, short_name: u.short_name || '', location: u.location || '', parent_id: u.parent_id || '' })}>Edit</Button>{(u.owner_user_id === identity?.user.id || isOperator) && <Button size="xs" variant="ghost" onClick={() => { setTransfer(u); setNewOwner(''); }}>Transfer</Button>}<Button size="xs" variant="ghost" onClick={() => setConfirm(u)}>Archive</Button></span>}</td></tr>
          ); })}
        </Table>
      </div>
      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} title={editing?.id ? `Edit ${editing.name}` : 'New unit'} size="sm" footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={save} loading={busy} disabled={!editing?.name?.trim()}>Save</Button></>}>
        {editing && <div className="space-y-3"><Field label="Name" required><Input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field><div className="grid grid-cols-2 gap-3"><Field label="Short name"><Input value={editing.short_name} onChange={(e) => setEditing({ ...editing, short_name: e.target.value })} /></Field><Field label="Echelon"><Select value={editing.echelon} onValueChange={(v) => setEditing({ ...editing, echelon: v })} options={ECHELONS.map((e) => ({ value: e.value, label: e.label }))} /></Field></div><Field label="Location"><Input value={editing.location} onChange={(e) => setEditing({ ...editing, location: e.target.value })} /></Field><Field label="Parent unit" hint={isOperator ? 'blank makes a new top-level organization' : 'required'}><Select value={editing.parent_id || '__none'} onValueChange={(v) => setEditing({ ...editing, parent_id: v === '__none' ? '' : v })} options={[{ value: '__none', label: 'None (top level)', disabled: !isOperator }, ...units.filter((u) => u.id !== editing.id && (manageUnits.includes(u.id) || isOperator)).map((u) => ({ value: u.id, label: u.short_name || u.name }))]} /></Field></div>}
      </Dialog>
      <Dialog open={Boolean(transfer)} onOpenChange={(o) => { if (!o) setTransfer(null); }} title={`Transfer leadership of ${transfer?.short_name || transfer?.name}`} description="The new leader receives the Unit Leader role. You keep your other roles." size="sm" footer={<><Button variant="ghost" onClick={() => setTransfer(null)}>Cancel</Button><Button variant="primary" disabled={!newOwner} onClick={async () => { try { await api.transferOwnership(transfer.id, newOwner); refresh(); toast.success('Leadership transferred.'); setTransfer(null); } catch (e) { toast.error(api.errorText(e)); } }}>Transfer</Button></>}>
        <Field label="New leader"><Select value={newOwner} onValueChange={setNewOwner} placeholder="Pick a member" options={roster.filter((p) => p.id !== identity?.user.id && p.memberships.some((m: any) => m.unit_id === transfer?.id)).map((p) => ({ value: p.id, label: `${p.rank_abbr || ''} ${p.last_name}, ${p.first_name}`.trim() }))} /></Field>
      </Dialog>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title={`Archive ${confirm?.name}?`} body="Members keep their records; shared entries in this unit are frozen. Sub-units must be moved or archived first." confirmLabel="Archive" onConfirm={async () => { try { await api.archiveUnit(confirm.id); refresh(); toast.success('Unit archived.'); } catch (e) { toast.error(api.errorText(e)); } }} />
    </>
  );
}

function UnitDashboard({ unitId, unitLabel, canExport, canDetail }: { unitId: string; unitLabel: string; canExport: boolean; canDetail: boolean }) {
  const toast = useToast();
  const [days, setDays] = useState('90');
  const [now] = useState(() => Date.now());
  const to = new Date(now).toISOString().slice(0, 10);
  const from = new Date(now - (Number(days) - 1) * 86_400_000).toISOString().slice(0, 10);
  const { data, isPending } = useQuery({ queryKey: keys.dashboard(unitId, from, to), queryFn: () => api.unitDashboard(unitId, from, to) });
  const [brief, setBrief] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  const exportJson = async () => { try { const r = await api.unitExport(unitId); downloadText(`vantage-${unitId}-${to}.json`, JSON.stringify(r, null, 2), 'application/json'); toast.success('Unit export downloaded.'); } catch (e) { toast.error(api.errorText(e)); } };
  if (isPending || !data) return <Skeleton className="h-64" />;
  const t = data.totals;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2"><Select aria-label="Window" className="w-40" value={days} onValueChange={setDays} options={[{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '180', label: 'Last 180 days' }, { value: '365', label: 'Last year' }]} /><span className="text-xs text-ink-3">Shared entries only · {from} to {to}</span>{canExport && <Button className="ml-auto" onClick={exportJson}><Download className="h-4 w-4" />Export unit data</Button>}</div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Members" value={t.members} hint={`${t.contributors} logged something`} />
        <Stat label="Shared entries" value={formatNumber(t.entries)} hint={`${t.completeness}% with an outcome`} tone={t.completeness < 60 ? 'warn' : undefined} />
        <Stat label="Dollars moved" value={formatDollars(t.dollars)} hint={t.reviewed ? `${formatDollars(t.reviewed)} reviewed` : 'summable types'} tone="accent" />
        <Stat label="Needs attention" value={t.overdue_tasks + t.counseling_due} hint={`${t.overdue_tasks} overdue tasks · ${t.counseling_due} counselings due`} tone={t.overdue_tasks + t.counseling_due ? 'warn' : 'good'} />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title="Entries per week" padded={false} bodyClassName="p-3">{data.weekly.length > 1 ? <AreaChart ariaLabel="Unit entries per week" data={data.weekly.map((w: any) => ({ label: w.week.slice(5), value: w.entries, secondary: Math.round(w.dollars) }))} secondaryLabel="Dollars" /> : <EmptyState title="Not enough shared entries yet" />}</Panel>
        <Panel title="By category"><BarList items={data.by_category.slice(0, 8).map((c: any) => ({ label: c.category, value: c.entries, hint: c.dollars ? formatDollars(c.dollars) : undefined }))} colorFor={(l) => CATEGORY_COLORS[l as Category]} /></Panel>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Panel title="Readiness and pipeline"><dl className="grid grid-cols-2 gap-2 text-sm">{[['Avg PFT', t.avg_pft ?? '—'], ['Avg CFT', t.avg_cft ?? '—'], ['Readiness reported', `${t.readiness_reported}/${t.members}`], ['Active goals', t.active_goals], ['Goals achieved', t.goals_achieved], ['Awards in progress', t.awards_in_progress]].map(([k, v]) => <div key={String(k)} className="rounded-md border border-line px-3 py-2"><dt className="eyebrow">{k}</dt><dd className="fig mt-0.5 font-semibold text-ink">{String(v)}</dd></div>)}</dl></Panel>
        <Panel className="lg:col-span-2" title="Members" subtitle={canDetail ? 'open a Marine to see their shared record' : 'member detail requires the Open member records permission'} padded={false}>
          {!data.members.length ? <EmptyState title={canDetail ? 'No members' : 'Member breakdown hidden'} /> : (
            <Table head={<><th>Marine</th><th className="w-20 text-right">Entries</th><th className="w-28 text-right">Dollars</th><th className="w-24 text-right">Outcome %</th><th className="w-24">Last entry</th><th className="w-28">Counseling</th></>}>
              {data.members.map((m: any) => <tr key={m.id}><td><Link to={`/team/${m.id}`} className="font-medium text-ink hover:underline">{m.rank_abbr || ''} {m.name}</Link>{m.billet && <span className="block text-xs text-ink-3">{m.billet}</span>}</td><td className="fig text-right">{m.entries}</td><td className="fig text-right text-xs">{m.dollars ? formatDollars(m.dollars) : ''}</td><td className={cn('fig text-right text-xs', m.completeness != null && m.completeness < 60 && 'text-warn')}>{m.completeness ?? '—'}</td><td className="text-xs"><DateText value={m.last_entry} fallback="none" /></td><td>{m.counseling_due ? <Badge tone="warn">Due</Badge> : <span className="text-xs text-ink-3"><DateText value={m.last_counseling} fallback="" /></span>}</td></tr>)}
            </Table>
          )}
        </Panel>
      </div>
      {canExport && <Panel title="Command brief" subtitle="AI summarizes aggregate totals only; no names leave the server" action={<AiAction workflow="command_brief" input={{ unit_id: unitId, from, to }} label="Draft brief" onResult={(output, meta) => setBrief({ output, meta })} />}>{brief ? <AiResult output={brief.output} meta={brief.meta} primaryKey="executive_summary" /> : <p className="flex items-center gap-2 text-sm text-ink-3"><Sparkles className="h-4 w-4" />A one-paragraph read of {unitLabel} for the window above.</p>}</Panel>}
    </div>
  );
}

function UnitAudit({ unitId }: { unitId: string }) {
  const { data, isPending } = useQuery({ queryKey: ['unit-audit', unitId], queryFn: () => api.unitAudit(unitId), enabled: Boolean(unitId) });
  if (isPending) return <Skeleton className="h-64" />;
  const rows: any[] = data?.rows || data || [];
  return (
    <Panel title="Who has been reading records in this unit" subtitle="every cross-person open is logged with the actor, the subject, and the time" padded={false}>
      {!rows.length ? <EmptyState icon={ClipboardList} title="No access events yet" /> : (
        <Table head={<><th className="w-40">When</th><th className="w-32">Who</th><th>Action</th><th className="w-32">Subject</th><th>Detail</th></>}>
          {rows.map((r: any) => <tr key={r.id}><td className="fig text-xs text-ink-3">{new Date(r.at).toLocaleString()}</td><td className="text-xs">{r.actor_username || fullName(r) || 'system'}</td><td className="text-xs text-ink">{humanize(r.action)}{r.entity ? <span className="text-ink-3"> · {r.entity}</span> : ''}</td><td className="text-xs">{r.subject_username || ''}</td><td className="truncate text-xs text-ink-3">{r.detail}</td></tr>)}
        </Table>
      )}
    </Panel>
  );
}
