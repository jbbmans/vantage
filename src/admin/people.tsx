import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Copy, KeyRound, LogOut, Plus, Search, Send, ShieldAlert, ShieldCheck, Unlock, UserMinus, UserPlus } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Panel, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { Table } from '@/components/common';
import { useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';
import { copyToClipboard, formatStamp, humanize, timeAgo } from '@/lib/utils';
import {
  ACCESS_LABEL, ACCESS_TONE, ORG_STATUS_TONE, personName, remaining,
  type AccessGrant, type OrgListing, type OrgStatus, type PlatformAccount, type PlatformRoleKey, type RoleCatalogEntry,
} from '@/lib/tenancy';
import { useAdmin } from './sections';

/** What the signed-in staff member may do here, from their platform roles. */
export function usePlatformCan() {
  const { data } = useIdentity();
  const permissions = data?.platform?.permissions ?? [];
  return (permission: string) => permissions.includes(permission);
}

function useAct() {
  const toast = useToast();
  return async <T,>(label: string, fn: () => Promise<T>, after?: () => void): Promise<T | null> => {
    try { const r = await withSudo(fn); toast.success(label); after?.(); return r; } catch (e) { toast.error(api.errorText(e)); return null; }
  };
}

/** Find an account by username, name, email or EDIPI, for naming an owner or a staff member. */
function AccountPicker({ value, onChange, label = 'Account' }: { value: PlatformAccount | null; onChange: (a: PlatformAccount | null) => void; label?: string }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const results = useQuery<{ accounts: PlatformAccount[] }>({ queryKey: ['admin', 'picker', debounced], queryFn: () => withSudo(() => api.platformAccounts(debounced)), enabled: debounced.length >= 2, retry: false });
  if (value) {
    return (
      <Field label={label}>
        <div className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
          <span><span className="font-medium text-ink">{personName(value)}</span> <span className="text-ink-3">@{value.username}</span></span>
          <Button size="xs" variant="ghost" onClick={() => onChange(null)}>Change</Button>
        </div>
      </Field>
    );
  }
  const found = (results.data?.accounts ?? []).filter((a) => a.active).slice(0, 8);
  return (
    <Field label={label} hint="username, name, email or EDIPI">
      <div>
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search accounts…" />
        {debounced.length >= 2 && (
          <ul className="mt-1 max-h-56 overflow-y-auto rounded-md border border-line">
            {results.isPending ? <li className="px-3 py-2 text-xs text-ink-3">Searching…</li>
              : !found.length ? <li className="px-3 py-2 text-xs text-ink-3">No active account matches.</li>
                : found.map((a) => (
                  <li key={a.id}>
                    <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2" onClick={() => onChange(a)}>
                      <span><span className="font-medium text-ink">{personName(a)}</span> <span className="text-ink-3">@{a.username}</span></span>
                      <span className="truncate text-2xs text-ink-3">{a.organizations || 'no Unit Instance'}</span>
                    </button>
                  </li>
                ))}
          </ul>
        )}
      </div>
    </Field>
  );
}

// ——— Organizations ———

export function Organizations() {
  const can = usePlatformCan();
  const { data, isPending, error, refetch } = useAdmin<{ organizations: OrgListing[] }>('orgs', api.platformOrgs);
  const act = useAct();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: '', short_name: '', code: '' });
  const [owner, setOwner] = useState<PlatformAccount | null>(null);
  const [status, setStatus] = useState<{ org: OrgListing; to: OrgStatus; reason: string } | null>(null);
  const [naming, setNaming] = useState<OrgListing | null>(null);
  const [asking, setAsking] = useState<OrgListing | null>(null);
  const [q, setQ] = useState('');
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <div className="card"><EmptyState title="Could not load Unit Instances" description={api.errorText(error)} action={<Button onClick={() => refetch()}>Retry</Button>} /></div>;
  const shown = data.organizations.filter((o) => !q.trim() || `${o.name} ${o.short_name || ''} ${o.slug}`.toLowerCase().includes(q.trim().toLowerCase()));

  const create = async () => {
    const made = await act('Unit Instance created.', () => api.platformCreateOrg({ name: draft.name, short_name: draft.short_name || null, code: draft.code || null, owner_user_id: owner?.id ?? null }), () => refetch());
    if (made) { setCreating(false); setDraft({ name: '', short_name: '', code: '' }); setOwner(null); }
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Input aria-label="Search Unit Instances" placeholder="Search Unit Instances…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <span className="text-xs text-ink-3">{shown.length} of {data.organizations.length}</span>
        {can('platform.orgs') && <Button className="ml-auto" variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" />New Unit Instance</Button>}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {!shown.length ? <EmptyState icon={Building2} title="No Unit Instances" description="A Unit Instance is a command or staff section on Vantage, with its own owners, units, roster feed and audit trail." /> : (
          <Table minWidth={900} head={<><th>Unit Instance</th><th className="w-24">Status</th><th className="w-20 text-right">Members</th><th className="w-16 text-right">Units</th><th className="w-48">Owners</th><th className="w-28">Last active</th><th className="w-60"></th></>}>
            {shown.map((o) => (
              <tr key={o.id}>
                <td>
                  <span className="block font-medium text-ink">{o.name}</span>
                  <span className="block text-xs text-ink-3">{o.short_name ? `${o.short_name} · ` : ''}{o.slug}{o.settings.vantageAccess === 'notify' ? ' · told, not asked, about Vantage access' : ''}</span>
                  {o.status !== 'active' && o.suspended_reason && <span className="block text-xs text-warn">{o.suspended_reason}</span>}
                </td>
                <td><Badge tone={ORG_STATUS_TONE[o.status]}>{humanize(o.status)}</Badge>{o.counts.pendingAccess ? <Badge tone="warn" className="ml-1" title="Vantage access requests waiting on its owners">{o.counts.pendingAccess}</Badge> : null}</td>
                <td className="fig text-right">{o.counts.members}</td>
                <td className="fig text-right">{o.counts.units}</td>
                <td className="text-xs">{o.owners.length ? o.owners.map(personName).join(', ') : <Badge tone="bad">No owner</Badge>}</td>
                <td className="text-xs text-ink-3">{o.counts.lastActive ? timeAgo(o.counts.lastActive) : 'never'}</td>
                <td className="text-right"><span className="flex flex-wrap justify-end gap-1">
                  {can('platform.access') && o.status === 'active' && <Button size="xs" variant="ghost" onClick={() => setAsking(o)}><KeyRound className="h-3 w-3" />Ask for access</Button>}
                  {can('platform.orgs') && !o.owners.length && <Button size="xs" variant="ghost" onClick={() => setNaming(o)}><UserPlus className="h-3 w-3" />Name owner</Button>}
                  {can('platform.orgs') && (o.status === 'active'
                    ? <Button size="xs" variant="ghost" onClick={() => setStatus({ org: o, to: 'suspended', reason: '' })}>Suspend</Button>
                    : <Button size="xs" variant="ghost" onClick={() => setStatus({ org: o, to: 'active', reason: '' })}>Restore</Button>)}
                </span></td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-3">Vantage sees a Unit Instance as a container: its name, its counts and its owners. What is inside it opens only through an access request its owners approve.</p>

      <Dialog open={creating} onOpenChange={setCreating} title="New Unit Instance" description="A command or staff section. Its first owner sets up its units, members, roles and personnel feed in the owner console." size="sm"
        footer={<><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" disabled={!draft.name.trim()} onClick={create}>Create</Button></>}>
        <div className="space-y-3">
          <Field label="Name" required><Input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="MARFORRES G-8 Comptroller" maxLength={120} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Short name"><Input value={draft.short_name} onChange={(e) => setDraft({ ...draft, short_name: e.target.value })} placeholder="G-8" maxLength={40} /></Field>
            <Field label="Code" hint="letters and digits; from the name if blank"><Input value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })} placeholder="MFR-G8" maxLength={40} /></Field>
          </div>
          <AccountPicker label="First owner" value={owner} onChange={setOwner} />
          <p className="text-xs text-ink-3">You are not made its owner. The command’s own people run it.</p>
        </div>
      </Dialog>

      <Dialog open={Boolean(status)} onOpenChange={(o) => { if (!o) setStatus(null); }} title={status?.to === 'active' ? `Restore ${status?.org.name}?` : `Suspend ${status?.org.name}?`} size="sm"
        description={status?.to === 'active' ? 'Its units and roles work again.' : 'Its units and Unit Instance roles confer nothing while suspended, and any Vantage access into it ends. Members keep their own records. Its owners are told why.'}
        footer={<><Button variant="ghost" onClick={() => setStatus(null)}>Cancel</Button><Button variant={status?.to === 'active' ? 'primary' : 'danger'} disabled={status?.to !== 'active' && !status?.reason.trim()} onClick={async () => { if (!status) return; const r = await act(status.to === 'active' ? 'Unit Instance restored.' : 'Unit Instance suspended.', () => api.platformOrgStatus(status.org.id, status.to, status.reason || undefined), () => refetch()); if (r) setStatus(null); }}>{status?.to === 'active' ? 'Restore' : 'Suspend'}</Button></>}>
        {status && status.to !== 'active' && <Field label="Reason" hint="the Unit Instance’s owners read this"><Textarea rows={3} value={status.reason} onChange={(e) => setStatus({ ...status, reason: e.target.value })} maxLength={500} /></Field>}
      </Dialog>

      <NameOwner org={naming} onClose={() => setNaming(null)} onDone={() => refetch()} />
      <AskAccess org={asking} onClose={() => setAsking(null)} />
    </>
  );
}

function NameOwner({ org, onClose, onDone }: { org: OrgListing | null; onClose: () => void; onDone: () => void }) {
  const act = useAct();
  const [who, setWho] = useState<PlatformAccount | null>(null);
  return (
    <Dialog open={Boolean(org)} onOpenChange={(o) => { if (!o) { setWho(null); onClose(); } }} title={`Name an owner for ${org?.name}`} size="sm"
      description="Only for a Unit Instance with no owner left. One that has owners names its own."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!who} onClick={async () => { if (!org || !who) return; const r = await act(`${personName(who)} owns ${org.name}.`, () => api.platformNameOwner(org.id, who.id), onDone); if (r) { setWho(null); onClose(); } }}>Name owner</Button></>}>
      <AccountPicker value={who} onChange={setWho} label="Owner" />
    </Dialog>
  );
}

export function AskAccess({ org, onClose }: { org: { id: string; name: string } | null; onClose: () => void }) {
  const act = useAct();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState('4');
  return (
    <Dialog open={Boolean(org)} onOpenChange={(o) => { if (!o) onClose(); }} title={`Ask to look at ${org?.name}`} size="sm"
      description="Its owners decide. Access is read-only (its units and the work shared with them, never member detail or private entries) and ends on its own."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < 10} onClick={async () => {
        if (!org) return;
        const r = await act('Request sent to its owners.', () => api.platformRequestAccess({ org_id: org.id, reason: reason.trim(), minutes: Math.round(Number(hours) * 60) }), () => qc.invalidateQueries({ queryKey: ['admin'] }));
        if (r) { setReason(''); onClose(); }
      }}><Send className="h-4 w-4" />Ask</Button></>}>
      <div className="space-y-3">
        <Field label="Why" hint="name the ticket and what you need to see; the owners read it"><Textarea autoFocus rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="Ticket 1042: the G-8 dashboard total does not match the report. I need to look at September’s shared entries." /></Field>
        <Field label="For"><Select value={hours} onValueChange={setHours} options={[{ value: '0.5', label: '30 minutes' }, { value: '1', label: '1 hour' }, { value: '4', label: '4 hours' }, { value: '8', label: '8 hours' }, { value: '24', label: '24 hours (the most)' }]} /></Field>
      </div>
    </Dialog>
  );
}

// ——— Accounts: sign-in help ———

type AccountAction = 'unlock' | 'logout' | 'temporary-password' | 'reset-mfa' | 'deactivate' | 'reactivate' | 'sign-in';
const ACTION_COPY: Record<AccountAction, { title: string; body: string; confirm: string; danger?: boolean }> = {
  unlock: { title: 'Unlock this account?', body: 'The failed-attempt lock is lifted now.', confirm: 'Unlock' },
  logout: { title: 'Sign them out everywhere?', body: 'Every open session ends. Their account and data are untouched.', confirm: 'Sign out' },
  'temporary-password': { title: 'Set a temporary password?', body: 'Their current password stops working. You see the new one once; they must choose their own at sign-in. They are told it happened.', confirm: 'Set password', danger: true },
  'reset-mfa': { title: 'Reset their second factor?', body: 'Their authenticator, recovery codes and passkeys are removed and every session ends. They set them up again in Settings. They are told it happened.', confirm: 'Reset', danger: true },
  deactivate: { title: 'Deactivate this account?', body: 'They can no longer sign in, in any Unit Instance. Their records stay. Use this for abuse or a confirmed compromise; leaving a command is the Unit Instance’s roster feed’s job.', confirm: 'Deactivate', danger: true },
  reactivate: { title: 'Reactivate this account?', body: 'They can sign in again, with whatever memberships they still hold.', confirm: 'Reactivate' },
  'sign-in': { title: 'Email their sign-in details?', body: 'Their username and a one-time link to choose a password, valid 72 hours. Their current password keeps working until they use it.', confirm: 'Send' },
};

export function Accounts() {
  const can = usePlatformCan();
  const { data: identity } = useIdentity();
  const act = useAct();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const { data, isPending, error, refetch } = useQuery<{ accounts: PlatformAccount[] }>({ queryKey: ['admin', 'accounts', debounced, filter], queryFn: () => withSudo(() => api.platformAccounts(debounced, filter)), retry: false, placeholderData: (prev) => prev });
  const [confirm, setConfirm] = useState<{ kind: AccountAction; user: PlatformAccount } | null>(null);
  const [temp, setTemp] = useState<{ user: PlatformAccount; password: string } | null>(null);
  const [card, setCard] = useState<{ user: PlatformAccount; edipi: string; reason: string } | null>(null);
  const saveCard = async () => {
    if (!card) return;
    const { user, edipi, reason } = card;
    const done = await act(`CAC link changed: ${user.username}.`, () => api.platformCorrectEdipi(user.id, { edipi: edipi.trim() || null, reason: reason.trim() }), () => refetch());
    if (done) setCard(null);
  };

  const run = async () => {
    if (!confirm) return;
    const { kind, user } = confirm;
    setConfirm(null);
    if (kind === 'sign-in') {
      try {
        const { results: [r] } = await withSudo(() => api.platformSendSignInDetails([user.id])) as { results: Array<{ status: string; error?: string }> };
        if (r.status === 'sent' || r.status === 'queued') toast.success(`Sign-in details ${r.status === 'queued' ? 'queued' : 'sent'} to ${user.email}.`);
        else toast.error(r.error || 'The sign-in details could not be sent.');
      } catch (e) { toast.error(api.errorText(e)); }
      return;
    }
    const r = await act(`${humanize(kind.replace('-', ' '))}: ${user.username}.`, () => api.platformAccountAction(user.id, kind), () => refetch()) as { password?: string } | null;
    if (r?.password) setTemp({ user, password: r.password });
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-3" /><Input aria-label="Search accounts" className="pl-8" placeholder="Username, name, email or EDIPI…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <Select aria-label="Show" className="w-44" value={filter} onValueChange={setFilter} options={[{ value: '', label: 'All accounts' }, { value: 'locked', label: 'Locked' }, { value: 'inactive', label: 'Deactivated' }, { value: 'staff', label: 'Vantage staff' }]} />
        <span className="text-xs text-ink-3">{data ? `${data.accounts.length} shown${data.accounts.length === 200 ? ' (first 200)' : ''}` : ''}</span>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {isPending ? <Skeleton className="h-64" /> : error ? <EmptyState title="Could not load accounts" description={api.errorText(error)} /> : (
          <Table minWidth={980} head={<><th>Account</th><th className="w-48">Unit Instances</th><th className="w-32">Second factor</th><th className="w-28">Last sign-in</th><th className="w-24">Status</th><th className="w-72"></th></>}>
            {(data?.accounts ?? []).map((u) => {
              const self = u.id === identity?.user.id;
              return (
                <tr key={u.id}>
                  <td>
                    <span className="block font-medium text-ink">{personName(u)}{u.platform_roles ? <Badge tone="accent" className="ml-2">Vantage {u.platform_roles}</Badge> : null}</span>
                    <span className="block text-xs text-ink-3">@{u.username}{u.email ? ` · ${u.email}` : ''}{u.edipi ? ` · CAC …${u.edipi.slice(-4)} ${u.edipi_verified_at ? '(proven)' : '(not yet proven)'}` : ''}</span>
                  </td>
                  <td className="text-xs text-ink-2">{u.organizations || <span className="text-ink-3">none</span>}</td>
                  <td className="text-xs text-ink-2">{[u.totp_enabled ? 'Authenticator' : '', u.passkeys ? `${u.passkeys} passkey${u.passkeys === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || <span className="text-warn">none</span>}</td>
                  <td className="text-xs text-ink-3">{u.last_login_at ? timeAgo(u.last_login_at) : 'never'}</td>
                  <td>{!u.active ? <Badge tone="bad">Deactivated</Badge> : u.locked_until ? <Badge tone="warn" title={`Locked until ${formatStamp(u.locked_until)}`}>Locked</Badge> : u.must_change_password ? <Badge tone="neutral">Temporary password</Badge> : <Badge tone="good">Active</Badge>}</td>
                  <td className="text-right">{can('platform.accounts') && !self && <span className="flex flex-wrap justify-end gap-1">
                    {u.active && u.locked_until && <Button size="xs" variant="ghost" onClick={() => setConfirm({ kind: 'unlock', user: u })}><Unlock className="h-3 w-3" />Unlock</Button>}
                    {u.active ? <>
                      {u.email && <Button size="xs" variant="ghost" onClick={() => setConfirm({ kind: 'sign-in', user: u })}><Send className="h-3 w-3" />Email sign-in</Button>}
                      <Button size="xs" variant="ghost" onClick={() => setConfirm({ kind: 'logout', user: u })}><LogOut className="h-3 w-3" />Sign out</Button>
                      <Button size="xs" variant="ghost" onClick={() => setConfirm({ kind: 'temporary-password', user: u })}>Temp password</Button>
                      {(u.totp_enabled || u.passkeys) ? <Button size="xs" variant="ghost" onClick={() => setConfirm({ kind: 'reset-mfa', user: u })}>Reset 2FA</Button> : null}
                      <Button size="xs" variant="ghost" onClick={() => setCard({ user: u, edipi: u.edipi || '', reason: '' })}>CAC link</Button>
                      <Button size="xs" variant="ghost" className="text-bad" onClick={() => setConfirm({ kind: 'deactivate', user: u })}>Deactivate</Button>
                    </> : <Button size="xs" variant="ghost" onClick={() => setConfirm({ kind: 'reactivate', user: u })}>Reactivate</Button>}
                  </span>}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-3">Sign-in help only: who someone is and how they sign in. What they keep stays theirs. Every action here is in the platform audit trail and is told to the person it touches.</p>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} title={confirm ? ACTION_COPY[confirm.kind].title : ''} danger={Boolean(confirm && ACTION_COPY[confirm.kind].danger)}
        body={confirm ? <><p className="text-sm text-ink-2">{ACTION_COPY[confirm.kind].body}</p><p className="mt-2 text-sm font-medium text-ink">{personName(confirm.user)} · @{confirm.user.username}</p></> : null}
        confirmLabel={confirm ? ACTION_COPY[confirm.kind].confirm : ''} onConfirm={run} />
      <Dialog open={Boolean(card)} onOpenChange={(o) => { if (!o) setCard(null); }} title={`CAC link for ${card?.user.username}`} description="The EDIPI their card signs in with. Change it only when it is wrong: they are signed out everywhere, told it happened, and prove the new one with their card." size="sm"
        footer={<><Button variant="ghost" onClick={() => setCard(null)}>Cancel</Button><Button variant="primary" disabled={!card || card.reason.trim().length < 10 || (card.edipi.trim() !== '' && !/^\d{10}$/.test(card.edipi.trim()))} onClick={saveCard}>Save</Button></>}>
        {card && <div className="space-y-3">
          <Field label="EDIPI" hint="ten digits; empty removes the card link"><Input inputMode="numeric" className="mono" maxLength={10} value={card.edipi} onChange={(e) => setCard({ ...card, edipi: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label="Why" hint="the ticket and what was wrong; it goes in the audit trail"><Textarea rows={3} maxLength={300} value={card.reason} onChange={(e) => setCard({ ...card, reason: e.target.value })} placeholder="Ticket 2210: the roster typo put another Marine’s DoD ID on this account." /></Field>
        </div>}
      </Dialog>
      <Dialog open={Boolean(temp)} onOpenChange={(o) => { if (!o) setTemp(null); }} title={`Temporary password for ${temp?.user.username}`} description="Shown once. Give it to them by a channel you trust; they choose their own at sign-in." size="sm"
        footer={<Button variant="primary" onClick={async () => { if (temp && await copyToClipboard(temp.password)) toast.success('Copied.'); }}><Copy className="h-4 w-4" />Copy</Button>}>
        <p className="mono select-all rounded-md border border-line bg-surface-2 px-3 py-2 text-md text-ink">{temp?.password}</p>
      </Dialog>
    </>
  );
}

// ——— Vantage staff ———

interface StaffRow { user_id: string; role: PlatformRoleKey; username: string; first_name: string; last_name: string; active: number; totp_enabled: number; passkeys: number; last_login_at: string | null; created_at: string; granted_by_name: string | null }

export function Staff() {
  const can = usePlatformCan();
  const { data: identity } = useIdentity();
  const { data, isPending, refetch } = useAdmin<{ staff: StaffRow[]; roles: Record<PlatformRoleKey, RoleCatalogEntry> }>('staff', api.platformStaff);
  const act = useAct();
  const [granting, setGranting] = useState(false);
  const [who, setWho] = useState<PlatformAccount | null>(null);
  const [role, setRole] = useState<PlatformRoleKey>('support');
  const [revoke, setRevoke] = useState<StaffRow | null>(null);
  if (isPending || !data) return <Skeleton className="h-64" />;
  const roles = Object.entries(data.roles) as Array<[PlatformRoleKey, RoleCatalogEntry]>;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[2fr_1fr]">
      <Panel title="Vantage staff" subtitle="People who run the service. A platform role confers nothing inside any Unit Instance." action={can('platform.staff') ? <Button size="sm" variant="primary" onClick={() => setGranting(true)}><UserPlus className="h-4 w-4" />Add</Button> : undefined}>
        <div className="-mx-4 -mt-1">
          <Table minWidth={620} head={<><th>Person</th><th className="w-28">Role</th><th className="w-32">Second factor</th><th className="w-28">Last sign-in</th><th className="w-24"></th></>}>
            {data.staff.map((s) => (
              <tr key={`${s.user_id}:${s.role}`}>
                <td><span className="block font-medium text-ink">{s.first_name} {s.last_name}</span><span className="block text-xs text-ink-3">@{s.username}{s.granted_by_name ? ` · added by ${s.granted_by_name}` : ''}</span></td>
                <td><Badge tone={s.role === 'owner' ? 'accent' : 'neutral'}>{data.roles[s.role]?.label ?? s.role}</Badge></td>
                <td className="text-xs">{s.totp_enabled || s.passkeys ? <span className="text-ink-2">{s.totp_enabled ? 'Authenticator' : `${s.passkeys} passkey${s.passkeys === 1 ? '' : 's'}`}</span> : <Badge tone="bad">None</Badge>}</td>
                <td className="text-xs text-ink-3">{s.last_login_at ? timeAgo(s.last_login_at) : 'never'}</td>
                <td className="text-right">{can('platform.staff') && s.user_id !== identity?.user.id && <Button size="xs" variant="ghost" onClick={() => setRevoke(s)}><UserMinus className="h-3 w-3" />Remove</Button>}</td>
              </tr>
            ))}
          </Table>
        </div>
      </Panel>
      <Panel title="What each role does">
        <ul className="space-y-3">{roles.map(([key, r]) => <li key={key}><p className="text-sm font-semibold text-ink">{r.label}</p><p className="text-xs text-ink-2">{r.description}</p></li>)}</ul>
      </Panel>
      <Dialog open={granting} onOpenChange={setGranting} title="Add Vantage staff" size="sm" description="Staff sign in with a second factor; they set one up in Settings first. Nobody adds themselves."
        footer={<><Button variant="ghost" onClick={() => setGranting(false)}>Cancel</Button><Button variant="primary" disabled={!who} onClick={async () => { if (!who) return; const r = await act(`${personName(who)} is now Vantage ${data.roles[role].label.toLowerCase()}.`, () => api.platformGrantStaff({ user_id: who.id, role }), () => refetch()); if (r) { setGranting(false); setWho(null); } }}>Add</Button></>}>
        <div className="space-y-3">
          <AccountPicker value={who} onChange={setWho} label="Person" />
          <Field label="Role"><Select value={role} onValueChange={(v) => setRole(v as PlatformRoleKey)} options={roles.map(([key, r]) => ({ value: key, label: r.label }))} /></Field>
          <p className="text-xs text-ink-3">{data.roles[role]?.description}</p>
        </div>
      </Dialog>
      <ConfirmDialog open={Boolean(revoke)} onOpenChange={(o) => { if (!o) setRevoke(null); }} title={`Remove ${revoke?.first_name} ${revoke?.last_name} as ${revoke ? data.roles[revoke.role]?.label : ''}?`}
        body="They are signed out. Any Vantage access they hold into a Unit Instance ends when their last staff role does." confirmLabel="Remove"
        onConfirm={async () => { if (revoke) await act('Removed.', () => api.platformRevokeStaff(revoke.user_id, revoke.role), () => refetch()); setRevoke(null); }} />
    </div>
  );
}

// ——— Vantage access ———

export function Access() {
  const can = usePlatformCan();
  const { data: identity } = useIdentity();
  const { data, isPending, refetch } = useAdmin<{ grants: AccessGrant[]; canRequest: boolean }>('access', () => api.platformAccess());
  const orgs = useAdmin<{ organizations: OrgListing[] }>('orgs', api.platformOrgs);
  const act = useAct();
  const [asking, setAsking] = useState<{ id: string; name: string } | null>(null);
  const [pick, setPick] = useState('');
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  if (isPending || !data) return <Skeleton className="h-64" />;
  const open = data.grants.filter((g) => g.status === 'active' || g.status === 'pending');
  const past = data.grants.filter((g) => g.status !== 'active' && g.status !== 'pending');
  const row = (g: AccessGrant) => (
    <tr key={g.id}>
      <td><span className="block font-medium text-ink">{g.org_name}</span><span className="block text-xs text-ink-2">{g.reason}</span></td>
      <td className="text-xs">{g.staff_name}</td>
      <td><Badge tone={ACCESS_TONE[g.status]}>{ACCESS_LABEL[g.status]}</Badge>{g.decision_note && <span className="mt-0.5 block text-2xs text-ink-3">“{g.decision_note}”</span>}</td>
      <td className="text-xs text-ink-3">{g.status === 'active' ? `ends ${remaining(g.expires_at)}` : g.status === 'pending' ? `asked ${timeAgo(g.requested_at)} for ${g.minutes >= 60 ? `${g.minutes / 60} h` : `${g.minutes} min`}` : timeAgo(g.ended_at || g.decided_at || g.requested_at)}</td>
      <td className="text-right">{g.staff_user_id === identity?.user.id && (g.status === 'active' || g.status === 'pending') && <Button size="xs" variant="ghost" onClick={() => act(g.status === 'active' ? 'Access ended.' : 'Request withdrawn.', () => api.platformEndAccess(g.id), () => refetch())}>{g.status === 'active' ? 'Finish' : 'Withdraw'}</Button>}</td>
    </tr>
  );
  const head = <><th>Unit Instance and reason</th><th className="w-36">Staff</th><th className="w-40">State</th><th className="w-40">When</th><th className="w-24"></th></>;
  return (
    <div className="space-y-4">
      <Panel title="Open" subtitle="Read-only, time-limited, and approved by the Unit Instance’s owners unless it chose to be told instead." action={can('platform.access') ? (
        <span className="flex items-center gap-2">
          <Select aria-label="Unit Instance" className="w-56" value={pick} onValueChange={setPick} placeholder="Choose a Unit Instance" options={(orgs.data?.organizations ?? []).filter((o) => o.status === 'active').map((o) => ({ value: o.id, label: o.name }))} />
          <Button size="sm" variant="primary" disabled={!pick} onClick={() => { const o = orgs.data?.organizations.find((x) => x.id === pick); if (o) setAsking({ id: o.id, name: o.name }); }}><KeyRound className="h-4 w-4" />Ask</Button>
        </span>) : undefined}>
        {!open.length ? <p className="text-sm text-ink-3">No access is open or waiting.</p> : <div className="-mx-4 -mt-1"><Table minWidth={760} head={head}>{open.map(row)}</Table></div>}
      </Panel>
      <Panel title="History" subtitle="Every request, decision and end is also in each Unit Instance’s own audit trail.">
        {!past.length ? <p className="text-sm text-ink-3">None yet.</p> : <div className="-mx-4 -mt-1"><Table minWidth={760} head={head}>{past.map(row)}</Table></div>}
      </Panel>
      <AskAccess org={asking} onClose={() => { setAsking(null); refetch(); }} />
    </div>
  );
}

// ——— Platform-wide legal holds ———

interface HoldRow { id: string; scope: 'instance' | 'user' | 'record_type'; subject_id: string | null; record_type: string | null; reason: string; placed_at: string }

export function PlatformHolds() {
  const { data, isPending, refetch } = useAdmin<{ holds: HoldRow[]; holdableTypes: string[] }>('holds', api.platformHolds);
  const act = useAct();
  const [draft, setDraft] = useState<{ scope: HoldRow['scope']; record_type: string; reason: string; who: PlatformAccount | null } | null>(null);
  if (isPending || !data) return <Skeleton className="h-48" />;
  return (
    <Panel title="Platform legal holds" subtitle="A hold on the service itself binds every Unit Instance: nothing it covers is disposed of, whatever a Unit Instance’s schedule says." action={<Button size="sm" onClick={() => setDraft({ scope: 'instance', record_type: '', reason: '', who: null })}><ShieldAlert className="h-4 w-4" />Place a hold</Button>}>
      {!data.holds.length ? <p className="text-sm text-ink-3">No platform hold is open. Unit Instances place their own in the owner console.</p> : (
        <ul className="divide-y divide-line">{data.holds.map((h) => (
          <li key={h.id} className="flex items-start justify-between gap-3 py-2">
            <span><span className="block text-base font-medium text-ink">{h.scope === 'instance' ? 'Everything on Vantage' : h.scope === 'user' ? 'One person, everywhere' : `Every ${humanize(h.record_type)}`}</span><span className="block text-xs text-ink-2">{h.reason}</span><span className="block text-2xs text-ink-3">placed {timeAgo(h.placed_at)}</span></span>
            <Button size="xs" variant="ghost" onClick={() => act('Hold released.', () => api.platformReleaseHold(h.id), () => refetch())}>Release</Button>
          </li>
        ))}</ul>
      )}
      <Dialog open={Boolean(draft)} onOpenChange={(o) => { if (!o) setDraft(null); }} title="Place a platform hold" size="sm"
        footer={<><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" disabled={!draft?.reason.trim() || (draft.scope === 'user' && !draft.who) || (draft.scope === 'record_type' && !draft.record_type)} onClick={async () => {
          if (!draft) return;
          const r = await act('Hold placed.', () => api.platformPlaceHold({ scope: draft.scope, subject_id: draft.who?.id ?? null, record_type: draft.record_type || null, reason: draft.reason.trim() }), () => refetch());
          if (r) setDraft(null);
        }}><ShieldCheck className="h-4 w-4" />Place hold</Button></>}>
        {draft && <div className="space-y-3">
          <Field label="Covers"><Select value={draft.scope} onValueChange={(v) => setDraft({ ...draft, scope: v as HoldRow['scope'] })} options={[{ value: 'instance', label: 'Everything on Vantage' }, { value: 'record_type', label: 'One kind of record, everywhere' }, { value: 'user', label: 'One person, everywhere' }]} /></Field>
          {draft.scope === 'record_type' && <Field label="Record type"><Select value={draft.record_type} onValueChange={(v) => setDraft({ ...draft, record_type: v })} options={data.holdableTypes.map((t) => ({ value: t, label: humanize(t) }))} /></Field>}
          {draft.scope === 'user' && <AccountPicker value={draft.who} onChange={(who) => setDraft({ ...draft, who })} label="Person" />}
          <Field label="Reason" hint="the matter or authority that requires it"><Textarea rows={3} value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} maxLength={1000} /></Field>
        </div>}
      </Dialog>
    </Panel>
  );
}
