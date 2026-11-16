import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, CalendarClock, HelpCircle, IdCard, KeyRound, LogOut, Save, ShieldAlert, Unlock, UserMinus, UserPlus, Users } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Panel, Select, Skeleton, Stat, Switch, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { Table } from '@/components/common';
import { PersonPicker, type PersonSearch } from '@/components/PersonPicker';
import { InstanceOperationsDetail, type InstanceOperations } from '@/components/InstanceOperations';
import AccountImport from '@/components/AccountImport';
import SharedAuditTrail from '@/components/AuditTrail';
import SignInDetails from '@/components/SignInDetails';
import WhyList from '@/components/WhyList';
import { keys, useIdentity } from '@/lib/queries';
import * as api from '@/lib/api';
import { formatStamp, timeAgo, useMediaQuery } from '@/lib/utils';
import {
  ACCESS_LABEL, ACCESS_TONE, endOfDay, personName, remaining, tomorrowKey,
  type AccessGrant, type OrgCounts, type OrgMember, type OrgMembersPage, type OrgRoleHolder, type OrgRoleKey, type OrgSummary, type OrgUnit, type PermissionCatalogEntry,
  type PublicOrg, type RoleCatalogEntry, type UnitExplanation,
} from '@/lib/tenancy';

/** One organization's data, behind a recent password confirmation like the rest of the console. */
export function useOrg<T>(orgId: string, key: string, fn: () => Promise<T>) {
  return useQuery<T>({ queryKey: ['org', orgId, key], queryFn: () => withSudo(fn), retry: false });
}

export function useAct() {
  const toast = useToast();
  return async <T,>(label: string, fn: () => Promise<T>, after?: () => void): Promise<T | null> => {
    try { const r = await withSudo(fn); toast.success(label); after?.(); return r; } catch (e) { toast.error(api.errorText(e)); return null; }
  };
}

export const Failed = ({ error, retry }: { error: unknown; retry: () => void }) => <div className="card"><EmptyState title="Could not load" description={api.errorText(error)} action={<Button onClick={retry}>Retry</Button>} /></div>;

// ——— Operations (ADR-0014) ———

/** The Unit Instance's version, last upgrade, health, backup, restore and withheld features, as Vantage reports them. */
export function Operations({ orgId }: { orgId: string }) {
  const { data, isPending, error, refetch } = useOrg<InstanceOperations>(orgId, 'operations', () => api.orgOperations(orgId));
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  return <InstanceOperationsDetail instance={data} audience="manager" />;
}

// ——— Overview ———

interface OverviewData {
  organization: PublicOrg; counts: OrgCounts;
  mine: { roles: OrgRoleKey[]; permissions: string[]; expiresAt: string | null };
  holds: number; lastSync: { source: string; at: string; created: number; updated: number; separated: number } | null;
  catalog: { roles: Record<OrgRoleKey, RoleCatalogEntry>; permissions: PermissionCatalogEntry[] };
}

export function Overview({ orgId }: { orgId: string }) {
  const { data, isPending, error, refetch } = useOrg<OverviewData>(orgId, 'overview', () => api.orgOverview(orgId));
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const { counts, mine, catalog } = data;
  const may = new Set(mine.permissions);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Members" value={counts.members} hint={counts.lastActive ? `last active ${timeAgo(counts.lastActive)}` : 'nobody has signed in yet'} icon={Users} to="people" />
        <Stat label="Units" value={counts.units} icon={Building2} to="units" />
        <Stat label="Lead Unit Managers" value={counts.owners} hint={counts.owners < 2 ? 'a second one covers leave and moves' : undefined} tone={counts.owners < 2 ? 'warn' : undefined} icon={ShieldAlert} />
        <Stat label="Vantage access" value={counts.pendingAccess} hint={counts.pendingAccess ? 'waiting on your answer' : 'nothing waiting'} tone={counts.pendingAccess ? 'warn' : undefined} icon={KeyRound} to="access" />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title="Your role here" subtitle={mine.expiresAt ? `Until ${new Date(mine.expiresAt).toLocaleDateString()}` : undefined}>
          <ul className="space-y-2">{mine.roles.map((r) => <li key={r}><p className="text-sm font-semibold text-ink">{catalog.roles[r].label}</p><p className="text-xs text-ink-2">{catalog.roles[r].description}</p></li>)}</ul>
          <p className="mt-3 text-xs font-semibold text-ink-2">You can</p>
          <ul className="mt-1 space-y-1">{catalog.permissions.filter((p) => may.has(p.key)).map((p) => <li key={p.key} className="text-xs text-ink-2"><span className="font-medium text-ink">{p.label}.</span> {p.hint}</li>)}</ul>
          <p className="mt-3 text-2xs text-ink-3">A Unit Instance role runs the Unit Instance. It does not read Marines’ records: that comes only from a unit role, in the units it is granted in.</p>
        </Panel>
        <Panel title="Records and the feed">
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Personnel feed</dt><dd className="text-right text-ink">{data.lastSync ? `${data.lastSync.source} · ${timeAgo(data.lastSync.at)}` : 'never loaded'}</dd></div>
            {data.lastSync && <div className="flex justify-between gap-3"><dt className="text-ink-3">Last load</dt><dd className="fig text-right text-ink">{data.lastSync.created} new · {data.lastSync.updated} changed · {data.lastSync.separated} separated</dd></div>}
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Open legal holds</dt><dd className="fig text-right text-ink">{data.holds}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">Vantage access</dt><dd className="text-right text-ink">{data.organization.settings.vantageAccess === 'approval' ? 'Asks a Lead Unit Manager first' : 'Tells the Lead Unit Managers'}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-ink-3">On Vantage since</dt><dd className="text-right text-ink">{new Date(data.organization.created_at).toLocaleDateString()}</dd></div>
          </dl>
        </Panel>
      </div>
    </div>
  );
}

// ——— People: members, organization roles, and "why can they?" ———

export function People({ org }: { org: OrgSummary }) {
  const can = (p: string) => org.permissions.includes(p);
  const { data: identity } = useIdentity();
  const qc = useQueryClient();
  const act = useAct();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  // A page at a time, as the server cuts it: "Show more" reads the next, and the line above the list says how many are shown.
  const members = useInfiniteQuery({
    queryKey: ['org', org.id, 'members', debounced],
    queryFn: ({ pageParam }) => withSudo(() => api.orgMembers(org.id, { q: debounced, cursor: pageParam })),
    initialPageParam: null as string | null,
    getNextPageParam: (last: OrgMembersPage) => (last.more ? last.next : undefined),
    retry: false,
    placeholderData: (prev) => prev,
  });
  const people = useMemo(() => (members.data?.pages ?? []).flatMap((page) => page.members), [members.data]);
  // A phone gets a list: the table's columns and its row of buttons would not fit.
  const wide = useMediaQuery('(min-width: 640px)');
  const [grantee, setGrantee] = useState<{ id: string; name: string } | null>(null);
  // Whom a Unit Instance role may go to: an active member other than oneself, found by name rather than from a list
  // that holds only the first page.
  const granteeSearch = useMemo<PersonSearch>(() => ({
    key: ['org', org.id, 'grantees'],
    load: async (term) => {
      const page = await withSudo(() => api.orgMembers(org.id, { q: term, limit: 20 }));
      return { people: page.members.filter((m) => m.active && m.id !== identity?.user.id).map((m) => ({ id: m.id, username: m.username, name: personName(m), rank: m.rank_abbr })), more: page.more };
    },
    none: 'No active member by that name.',
  }), [org.id, identity?.user.id]);
  const roles = useOrg<{ holders: OrgRoleHolder[]; catalog: { roles: Record<OrgRoleKey, RoleCatalogEntry> } }>(org.id, 'roles', () => api.orgRoles(org.id));
  const [why, setWhy] = useState<OrgMember | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'unlock' | 'logout' | 'remove'; member: OrgMember } | null>(null);
  const [granting, setGranting] = useState(false);
  const [grant, setGrant] = useState<{ user_id: string; role: OrgRoleKey; until: string }>({ user_id: '', role: 'admin', until: '' });
  const [revoke, setRevoke] = useState<OrgRoleHolder | null>(null);
  // CAC sign-in finds an account by its EDIPI alone, so an account made by invitation or registration needs one linked.
  const [cac, setCac] = useState<{ member: OrgMember; edipi: string } | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['org', org.id] }); };
  const saveEdipi = async () => {
    if (!cac) return;
    const edipi = cac.edipi.trim() || null;
    const r = await act(edipi ? `EDIPI linked to ${cac.member.username}.` : `EDIPI cleared from ${cac.member.username}.`, () => api.orgPersonnelLink(org.id, cac.member.id, edipi), refresh);
    if (r) setCac(null);
  };
  const rolesOf = (userId: string) => (roles.data?.holders ?? []).filter((h) => h.user_id === userId);
  // Each member's parts, the same in the table and in the phone list, so the two never offer different things.
  const personCell = (m: OrgMember) => (
    <>
      <span className="block font-medium text-ink">{personName(m)}{rolesOf(m.id).map((h) => <Badge key={h.role} tone="accent" className="ml-2">{roles.data?.catalog.roles[h.role].label}</Badge>)}</span>
      <span className="block text-xs text-ink-3">@{m.username}{m.edipi ? ' · CAC linked' : ''}{m.other_orgs ? ` · also in ${m.other_orgs} other Unit Instance${m.other_orgs === 1 ? '' : 's'}` : ''}</span>
    </>
  );
  const unitsOf = (m: OrgMember) => m.units.map((u) => <span key={u.unit_id} className="block"><span className="font-medium text-ink">{u.unit}</span>{u.billet ? `, ${u.billet}` : ''}{u.roles ? <span className="text-ink-3"> · {u.roles}</span> : ''}</span>);
  const signInOf = (m: OrgMember) => <>{m.last_login_at ? timeAgo(m.last_login_at) : 'never signed in'}<span className="block">{m.totp_enabled || m.passkeys ? 'second factor on' : <span className="text-warn">no second factor</span>}</span></>;
  const statusOf = (m: OrgMember) => (!m.active ? <Badge tone="bad">Off</Badge> : m.locked_until ? <Badge tone="warn" title={`Locked until ${formatStamp(m.locked_until)}`}>Locked</Badge> : <Badge tone="good">Active</Badge>);
  const actionsOf = (m: OrgMember) => (
    <>
      <Button size="xs" variant="ghost" onClick={() => setWhy(m)} aria-label={`Why can they? ${m.username}`}><HelpCircle className="h-3 w-3" />Why can they?</Button>
      {can('org.personnel') && <Button size="xs" variant="ghost" aria-label={`EDIPI for ${m.username}`} onClick={() => setCac({ member: m, edipi: m.edipi || '' })}><IdCard className="h-3 w-3" />EDIPI</Button>}
      {can('org.members') && m.id !== identity?.user.id && <>
        {m.locked_until && <Button size="xs" variant="ghost" aria-label={`Unlock ${m.username}`} onClick={() => setConfirm({ kind: 'unlock', member: m })}><Unlock className="h-3 w-3" />Unlock</Button>}
        <Button size="xs" variant="ghost" aria-label={`Sign out ${m.username}`} onClick={() => setConfirm({ kind: 'logout', member: m })}><LogOut className="h-3 w-3" />Sign out</Button>
        <Button size="xs" variant="ghost" className="text-bad" aria-label={`Remove ${m.username}`} onClick={() => setConfirm({ kind: 'remove', member: m })}><UserMinus className="h-3 w-3" />Remove</Button>
      </>}
    </>
  );

  const run = async () => {
    if (!confirm) return;
    const { kind, member } = confirm;
    setConfirm(null);
    if (kind === 'remove') await act(`${personName(member)} left the Unit Instance.`, () => api.orgRemoveMember(org.id, member.id), refresh);
    else await act(kind === 'unlock' ? 'Unlocked.' : 'Signed out everywhere.', () => api.orgMemberAction(org.id, member.id, kind), refresh);
  };

  return (
    <div className="space-y-4">
      {can('org.owners') || roles.data ? (
        <Panel title="Unit Instance roles" subtitle="Who runs the Unit Instance. These roles manage its structure; none of them reads Marines’ records, and each lasts only while its holder is a member." action={can('org.owners') ? <Button size="sm" variant="primary" onClick={() => setGranting(true)}><UserPlus className="h-4 w-4" />Grant a role</Button> : undefined}>
          {roles.isPending ? <Skeleton className="h-24" /> : !roles.data?.holders.length ? <p className="text-sm text-ink-3">Nobody holds a Unit Instance role.</p> : (
            <div className="-mx-4 -mt-1">
              <Table label="Unit Instance roles" minWidth={620} head={<><th scope="col">Person</th><th scope="col" className="w-36">Role</th><th scope="col" className="w-40">Until</th><th scope="col" className="w-40">Granted by</th><th scope="col" className="relative w-24"><span className="sr-only">Actions</span></th></>}>
                {roles.data.holders.map((h) => (
                  <tr key={`${h.user_id}:${h.role}`}>
                    <td><span className="block font-medium text-ink">{personName(h)}</span><span className="block text-xs text-ink-3">@{h.username}{h.member ? '' : ' · no longer a member, so it confers nothing'}</span></td>
                    <td><Badge tone={h.role === 'owner' ? 'accent' : 'neutral'}>{roles.data!.catalog.roles[h.role].label}</Badge></td>
                    <td className="text-xs text-ink-2">{h.expires_at ? <span className="inline-flex items-center gap-1"><CalendarClock className="h-3 w-3" />{new Date(h.expires_at).toLocaleDateString()}</span> : 'No end date'}</td>
                    <td className="text-xs text-ink-3">{h.granted_by_name || 'Vantage'} · {timeAgo(h.created_at)}</td>
                    <td className="text-right">{can('org.owners') && <Button size="xs" variant="ghost" onClick={() => setRevoke(h)}>Remove</Button>}</td>
                  </tr>
                ))}
              </Table>
            </div>
          )}
        </Panel>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Search people" placeholder="Search by name or username…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
        <p role="status" aria-live="polite" className="text-xs text-ink-3">{!members.data ? '' : `${people.length} ${people.length === 1 ? 'person' : 'people'} shown${members.hasNextPage ? '; more follow' : ''}`}</p>
        {can('org.members') && <span className="flex flex-wrap gap-2 sm:ml-auto"><SignInDetails orgId={org.id} onDone={refresh} /><AccountImport orgId={org.id} onDone={refresh} /></span>}
      </div>
      {members.isPending ? <div className="card"><Skeleton className="h-64" /></div> : members.error && !members.data ? <div className="card"><EmptyState title="Could not load people" description={api.errorText(members.error)} action={<Button onClick={() => members.refetch()}>Retry</Button>} /></div> : !people.length ? <div className="card"><EmptyState icon={Users} title={debounced ? 'Nobody matches' : 'Nobody here yet'} description={debounced ? 'Try another name or username.' : 'Bring people in with a join code or invitation from a unit, or import a roster.'} /></div> : (
        <>
          {wide ? (
            <div className="card" style={{ overflow: 'hidden' }}>
              <Table label="People" minWidth={960} head={<><th scope="col">Person</th><th scope="col">Units and unit roles</th><th scope="col" className="w-32">Sign-in</th><th scope="col" className="w-24">Status</th><th scope="col" className="relative w-72"><span className="sr-only">Actions</span></th></>}>
                {people.map((m) => (
                  <tr key={m.id}>
                    <td>{personCell(m)}</td>
                    <td className="text-xs text-ink-2">{unitsOf(m)}</td>
                    <td className="text-xs text-ink-3">{signInOf(m)}</td>
                    <td>{statusOf(m)}</td>
                    <td className="text-right"><span className="flex flex-wrap justify-end gap-1">{actionsOf(m)}</span></td>
                  </tr>
                ))}
              </Table>
            </div>
          ) : (
            <ul className="card divide-y divide-line overflow-hidden p-0" aria-label="People">
              {people.map((m) => (
                <li key={m.id} className="space-y-1.5 px-4 py-3">
                  <div className="flex items-start justify-between gap-2"><div className="min-w-0 break-words">{personCell(m)}</div><div className="shrink-0">{statusOf(m)}</div></div>
                  <div className="text-xs text-ink-2">{unitsOf(m)}</div>
                  <div className="text-xs text-ink-3">{signInOf(m)}</div>
                  <div className="flex flex-wrap gap-1">{actionsOf(m)}</div>
                </li>
              ))}
            </ul>
          )}
          {members.isFetchNextPageError && <p className="text-sm text-bad" role="alert">More people could not load. {api.errorText(members.error)}</p>}
          {members.hasNextPage && (
            <div className="flex justify-center">
              <Button onClick={() => members.fetchNextPage()} loading={members.isFetchingNextPage}>{members.isFetchNextPageError ? 'Try again' : 'Show more'}</Button>
            </div>
          )}
        </>
      )}
      <p className="text-xs text-ink-3">A forgotten password or a lost authenticator is Vantage support’s to reset, because an account can belong to more than one Unit Instance. You can unlock a member and sign them out; they reset their own password from the sign-in page.</p>

      <WhyDialog orgId={org.id} member={why} onClose={() => setWhy(null)} />
      <Dialog open={Boolean(cac)} onOpenChange={(o) => { if (!o) setCac(null); }} title={`EDIPI for ${cac?.member.username}`} description="The ten-digit DoD ID on their card. Certificate sign-in finds the account by it. Leave it empty to unlink." size="sm"
        footer={<><Button variant="ghost" onClick={() => setCac(null)}>Cancel</Button><Button variant="primary" disabled={Boolean(cac?.edipi.trim()) && !/^\d{10}$/.test(cac?.edipi.trim() || '')} onClick={saveEdipi}>Save</Button></>}>
        <Field label="EDIPI" hint="Ten digits"><Input autoFocus inputMode="numeric" autoComplete="off" maxLength={10} className="mono" value={cac?.edipi ?? ''} onChange={(e) => setCac((c) => (c ? { ...c, edipi: e.target.value.replace(/\D/g, '') } : c))} /></Field>
      </Dialog>
      <ConfirmDialog open={Boolean(confirm)} onOpenChange={(o) => { if (!o) setConfirm(null); }} danger={confirm?.kind === 'remove'}
        title={confirm?.kind === 'remove' ? `Take ${confirm ? personName(confirm.member) : ''} out of the Unit Instance?` : confirm?.kind === 'unlock' ? 'Unlock this account?' : 'Sign them out everywhere?'}
        body={confirm?.kind === 'remove' ? 'They leave every unit of the Unit Instance: their unit roles and Unit Instance roles end, the work they held is released, and what they shared stays with the units. Their account and their own records stay theirs.' : confirm?.kind === 'unlock' ? 'The failed-attempt lock is lifted now.' : 'Every open session ends. Nothing else changes.'}
        confirmLabel={confirm?.kind === 'remove' ? 'Remove' : confirm?.kind === 'unlock' ? 'Unlock' : 'Sign out'} onConfirm={run} />
      <ConfirmDialog open={Boolean(revoke)} onOpenChange={(o) => { if (!o) setRevoke(null); }} title={`Remove ${revoke ? personName(revoke) : ''} as ${revoke ? roles.data?.catalog.roles[revoke.role].label : ''}?`} body="They are signed out and the role ends now. A Unit Instance always keeps at least one Lead Unit Manager." confirmLabel="Remove"
        onConfirm={async () => { if (revoke) await act('Role removed.', () => api.orgRevokeRole(org.id, revoke.user_id, revoke.role), refresh); setRevoke(null); }} />
      <Dialog open={granting} onOpenChange={(o) => { setGranting(o); if (!o) setGrantee(null); }} title="Grant a Unit Instance role" size="sm" description="To a member of the Unit Instance. Another Lead Unit Manager grants your own."
        footer={<><Button variant="ghost" onClick={() => { setGranting(false); setGrantee(null); }}>Cancel</Button><Button variant="primary" disabled={!grant.user_id} onClick={async () => {
          const r = await act('Role granted. They are told, and pick it up at their next sign-in.', () => api.orgGrantRole(org.id, { user_id: grant.user_id, role: grant.role, expires_at: endOfDay(grant.until) }), refresh);
          if (r) { setGranting(false); setGrantee(null); setGrant({ user_id: '', role: 'admin', until: '' }); }
        }}>Grant</Button></>}>
        <div className="space-y-3">
          {grantee ? (
            <div className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
              <span className="font-medium text-ink">{grantee.name}</span>
              <Button size="xs" variant="ghost" aria-label={`Change from ${grantee.name} to someone else`} onClick={() => { setGrantee(null); setGrant({ ...grant, user_id: '' }); }}>Change</Button>
            </div>
          ) : <PersonPicker search={granteeSearch} label="Person" hint="An active member" onChoose={(p) => { setGrantee({ id: p.id, name: p.name }); setGrant({ ...grant, user_id: p.id }); }} />}
          <Field label="Role"><Select value={grant.role} onValueChange={(v) => setGrant({ ...grant, role: v as OrgRoleKey })} options={Object.entries(roles.data?.catalog.roles ?? {}).map(([key, r]) => ({ value: key, label: r.label }))} /></Field>
          <p className="text-xs text-ink-3">{roles.data?.catalog.roles[grant.role]?.description}</p>
          <Field label="Until" hint="optional: for an acting billet or a leave period"><Input type="date" value={grant.until} min={tomorrowKey()} onChange={(e) => setGrant({ ...grant, until: e.target.value })} /></Field>
        </div>
      </Dialog>
    </div>
  );
}

/** "Why can they?": every grant behind a member's authority in the organization's units. */
export function WhyDialog({ orgId, member, onClose }: { orgId: string; member: { id: string; first_name: string; last_name: string; rank_abbr?: string | null } | null; onClose: () => void }) {
  const { data, isPending, error } = useQuery<{ units: UnitExplanation[]; orgRoles: Array<{ role: string; label: string; expires_at: string | null; granted_by_name: string | null }> }>({
    queryKey: ['org', orgId, 'why', member?.id], queryFn: () => withSudo(() => api.orgWhy(orgId, member!.id)), enabled: Boolean(member), retry: false,
  });
  return (
    <Dialog open={Boolean(member)} onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title={member ? `Why can ${personName({ ...member, rank_abbr: member.rank_abbr ?? null })} do what they can?` : ''}
      description="Every grant behind their authority, unit by unit: the role and where it was granted, authority reaching down the chain, unit leadership, Unit Instance administration and Vantage access, each with its end date.">
      {isPending ? <Skeleton className="h-40" /> : error ? <p className="text-sm text-bad">{api.errorText(error)}</p> : (
        <div className="space-y-3">
          {data!.orgRoles.length > 0 && <p className="text-sm text-ink-2">Unit Instance roles: {data!.orgRoles.map((r) => `${r.label}${r.expires_at ? ` until ${new Date(r.expires_at).toLocaleDateString()}` : ''}`).join(', ')}.</p>}
          <WhyList units={data!.units} />
        </div>
      )}
    </Dialog>
  );
}

// ——— Vantage access ———

export function VantageAccess({ org }: { org: OrgSummary }) {
  const can = (p: string) => org.permissions.includes(p);
  const { data, isPending, error, refetch } = useOrg<{ grants: AccessGrant[] }>(org.id, 'access', () => api.orgAccess(org.id));
  const act = useAct();
  const [deciding, setDeciding] = useState<{ grant: AccessGrant; approve: boolean; note: string } | null>(null);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(t); }, []);
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const pending = data.grants.filter((g) => g.status === 'pending');
  const active = data.grants.filter((g) => g.status === 'active');
  const past = data.grants.filter((g) => g.status !== 'pending' && g.status !== 'active');
  const hours = (m: number) => (m >= 60 ? `${Math.round(m / 6) / 10} hours` : `${m} minutes`);
  return (
    <div className="space-y-4">
      <Panel title="Waiting on you" subtitle="Approving opens your units and the work shared with them to this person, read-only, for the time shown. Never member detail, never private entries, never changes.">
        {!pending.length ? <p className="text-sm text-ink-3">No request is waiting.</p> : <ul className="divide-y divide-line">{pending.map((g) => (
          <li key={g.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <span className="min-w-0"><span className="block font-medium text-ink">{g.staff_name}, Vantage support · for {hours(g.minutes)}</span><span className="block text-sm text-ink-2">“{g.reason}”</span><span className="block text-2xs text-ink-3">asked {timeAgo(g.requested_at)} · lapses unanswered after a day</span></span>
            {can('org.access') && <span className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => setDeciding({ grant: g, approve: false, note: '' })}>Deny</Button><Button size="sm" variant="primary" onClick={() => setDeciding({ grant: g, approve: true, note: '' })}>Approve</Button></span>}
          </li>
        ))}</ul>}
      </Panel>
      <Panel title="Open now">
        {!active.length ? <p className="text-sm text-ink-3">Nobody from Vantage can see inside your Unit Instance.</p> : <ul className="divide-y divide-line">{active.map((g) => (
          <li key={g.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
            <span className="min-w-0"><span className="block font-medium text-ink">{g.staff_name} · ends {remaining(g.expires_at)}</span><span className="block text-sm text-ink-2">“{g.reason}”</span><span className="block text-2xs text-ink-3">{g.decided_by_name ? `approved by ${g.decided_by_name}` : 'began at once, as your settings allow'}</span></span>
            {can('org.access') && <Button size="sm" variant="danger" onClick={() => act('Access ended.', () => api.orgRevokeAccess(org.id, g.id), () => refetch())}>End now</Button>}
          </li>
        ))}</ul>}
      </Panel>
      <Panel title="History" subtitle="Every request, decision and end is also in your audit trail.">
        {!past.length ? <p className="text-sm text-ink-3">None yet.</p> : (
          <div className="-mx-4 -mt-1"><Table label="Vantage access history" minWidth={640} head={<><th scope="col">Who and why</th><th scope="col" className="w-44">Outcome</th><th scope="col" className="w-32">When</th></>}>
            {past.map((g) => <tr key={g.id}><td><span className="block text-sm text-ink">{g.staff_name}</span><span className="block text-xs text-ink-3">{g.reason}</span></td><td><Badge tone={ACCESS_TONE[g.status]}>{ACCESS_LABEL[g.status]}</Badge>{g.decided_by_name ? <span className="mt-0.5 block text-2xs text-ink-3">by {g.decided_by_name}</span> : null}</td><td className="text-xs text-ink-3">{timeAgo(g.ended_at || g.decided_at || g.requested_at)}</td></tr>)}
          </Table></div>
        )}
      </Panel>
      <Dialog open={Boolean(deciding)} onOpenChange={(o) => { if (!o) setDeciding(null); }} size="sm" title={deciding?.approve ? `Let ${deciding.grant.staff_name} look, for ${hours(deciding.grant.minutes)}?` : 'Deny this request?'}
        description={deciding?.approve ? 'Read-only: your units and the work shared with them. You can end it at any time.' : 'Vantage support is told. They can ask again.'}
        footer={<><Button variant="ghost" onClick={() => setDeciding(null)}>Cancel</Button><Button variant={deciding?.approve ? 'primary' : 'danger'} onClick={async () => { if (!deciding) return; const r = await act(deciding.approve ? 'Approved.' : 'Denied.', () => api.orgDecideAccess(org.id, deciding.grant.id, deciding.approve, deciding.note || undefined), () => refetch()); if (r) setDeciding(null); }}>{deciding?.approve ? 'Approve' : 'Deny'}</Button></>}>
        {deciding && <Field label="Note" hint="optional; Vantage support reads it"><Textarea rows={2} value={deciding.note} onChange={(e) => setDeciding({ ...deciding, note: e.target.value })} maxLength={500} placeholder={deciding.approve ? 'Only look at September.' : 'Call the S-6 instead.'} /></Field>}
      </Dialog>
    </div>
  );
}

// ——— Audit trail ———

/** The Unit Instance's trail, filtered and paged on the server, with a unit filter (ADR-0012). */
export function AuditTrail({ orgId }: { orgId: string }) {
  const units = useOrg<{ units: OrgUnit[] }>(orgId, 'units', () => api.orgUnits(orgId));
  return (
    <SharedAuditTrail
      queryKey={['org', orgId]}
      load={(f) => api.orgAudit(orgId, f)}
      exportUrl={(f, format) => api.orgAuditExportUrl(orgId, f, format)}
      fileStem={`vantage-${orgId.toLowerCase()}-audit`}
      units={(units.data?.units ?? []).map((u) => ({ id: u.id, name: u.short_name || u.name }))}
      empty="Nothing recorded yet."
    />
  );
}

// ——— Settings ———

export function Settings({ org, extra }: { org: OrgSummary; extra?: React.ReactNode }) {
  const can = (p: string) => org.permissions.includes(p);
  const { data, isPending, refetch } = useOrg<OverviewData>(org.id, 'overview', () => api.orgOverview(org.id));
  const qc = useQueryClient();
  const act = useAct();
  const [form, setForm] = useState<{ name: string; short_name: string; vantageAccess: 'approval' | 'notify' } | null>(null);
  useEffect(() => { if (data && !form) setForm({ name: data.organization.name, short_name: data.organization.short_name || '', vantageAccess: data.organization.settings.vantageAccess }); }, [data, form]);
  if (isPending || !data || !form) return <Skeleton className="h-64" />;
  const save = (patch: Record<string, unknown>) => act('Saved.', () => api.orgUpdate(org.id, patch), () => { refetch(); qc.invalidateQueries({ queryKey: keys.me }); });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {can('org.settings') && (
        <Panel title="Name" action={<Button size="sm" variant="primary" onClick={() => save({ name: form.name, short_name: form.short_name || null })}><Save className="h-4 w-4" />Save</Button>}>
          <div className="space-y-3">
            <Field label="Unit Instance name" hint="also the name of its top unit"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={120} /></Field>
            <Field label="Short name"><Input value={form.short_name} onChange={(e) => setForm({ ...form, short_name: e.target.value })} maxLength={40} /></Field>
          </div>
        </Panel>
      )}
      <Panel title="Vantage access" subtitle="When Vantage support needs to look inside your Unit Instance to fix something.">
        <Switch checked={form.vantageAccess === 'approval'} disabled={!can('org.owners')} onChange={(v) => { const next = v ? 'approval' : 'notify'; setForm({ ...form, vantageAccess: next }); void save({ settings: { vantageAccess: next } }); }}
          label="Ask a Lead Unit Manager first" description={form.vantageAccess === 'approval' ? 'Support asks; nothing opens until a Lead Unit Manager approves. Recommended.' : 'Support may look at once, read-only, and your Lead Unit Managers are told and can end it.'} />
        {!can('org.owners') && <p className="mt-2 text-xs text-ink-3">Only a Lead Unit Manager changes this.</p>}
      </Panel>
      <Panel title="Your units on Vantage" subtitle="Members bring their own account and keep it when they move.">
        <p className="text-sm text-ink-2">Your Unit Instance’s records are kept apart from every other Unit Instance’s on this Vantage deployment. Vantage staff see your Unit Instance as a name and its counts; anything more opens only through Vantage access, above.</p>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-3"><IdCard className="h-3.5 w-3.5" />To close the Unit Instance or recover a lost Lead Unit Manager account, contact Vantage support.</p>
      </Panel>
      {extra}
    </div>
  );
}
