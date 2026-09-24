import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, LogOut, MoreHorizontal, Search, ShieldCheck, UserCheck, UserCog, UserMinus, UserPlus, UserX, Users } from 'lucide-react';
import { PageHeader, Button, Field, Input, Select, EmptyState, Badge, Skeleton, Segmented } from '@/components/ui/primitives';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from '@/components/ui/Menu';
import { StatStrip } from '@/components/StatStrip';
import { Table } from '@/components/common';
import { withSudo } from '@/components/SudoDialog';
import { LevelBadge, LEVEL_DOT } from '@/components/AccessLevel';
import { useToast } from '@/components/ui/toast';
import { useIdentity, keys } from '@/lib/queries';
import * as api from '@/lib/api';
import { ACCESS_LEVELS, ACCESS_LABEL, LEVEL_ROLE_KEY, type AccessLevel } from '../../shared/access';
import { cn, copyToClipboard, initials, timeAgo } from '@/lib/utils';

/**
 * People: who is in the organization, what each person can do on each of their teams, and the
 * controls to change it. The three access levels are the whole vocabulary here; the roles behind
 * them stay on the Team page for anyone who builds their own.
 */

interface PersonTeam { unit_id: string; unit_name: string; unit_short: string | null; billet: string | null; is_primary: number; level: AccessLevel; owner: boolean; roles: Array<{ id: string; name: string; color: string | null }>; settable: AccessLevel[]; removable: boolean }
interface Person {
  id: string; first_name: string; last_name: string; rank_abbr: string | null; active: number; level: AccessLevel; org_admin: boolean; teams: PersonTeam[];
  username?: string; email?: string | null; mfa?: boolean; must_change_password?: boolean; last_login_at?: string | null;
}
interface TeamOption { id: string; name: string; short_name: string | null; members: number; canInvite: boolean; grantable: AccessLevel[] }
interface PeopleData { people: Person[]; units: TeamOption[]; orgAdmin: boolean; pendingInvites: number; stats: { people: number; personal: number; leader: number; administrator: number; suspended: number; without_mfa: number | null } }

const teamName = (t: { unit_short?: string | null; unit_name?: string; short_name?: string | null; name?: string }) => t.unit_short || t.short_name || t.unit_name || t.name || '';
const fullName = (p: Person) => [p.rank_abbr, `${p.last_name}, ${p.first_name}`].filter(Boolean).join(' ');

export default function People() {
  const { data: identity } = useIdentity();
  const toast = useToast();
  const qc = useQueryClient();
  const enabled = Boolean(identity?.canManagePeople);
  const q = useQuery<PeopleData>({ queryKey: ['people'], queryFn: () => withSudo(api.people), retry: false, enabled });
  const [level, setLevel] = useState<'all' | AccessLevel>('all');
  const [team, setTeam] = useState('all');
  const [status, setStatus] = useState<'active' | 'suspended' | 'all'>('active');
  const [text, setText] = useState('');
  const [inviting, setInviting] = useState(false);
  const [change, setChange] = useState<{ person: Person; team: PersonTeam; level: AccessLevel } | null>(null);
  const [removing, setRemoving] = useState<{ person: Person; team: PersonTeam } | null>(null);
  const [adding, setAdding] = useState<Person | null>(null);
  const [account, setAccount] = useState<{ kind: 'suspend' | 'reset-mfa' | 'temp' | 'org-admin'; person: Person } | null>(null);
  const [temp, setTemp] = useState<{ person: Person; password: string } | null>(null);

  const people = useMemo(() => {
    const needle = text.trim().toLowerCase();
    return (q.data?.people || []).filter((p) =>
      (level === 'all' || p.level === level)
      && (team === 'all' || (team === 'none' ? p.teams.length === 0 : p.teams.some((t) => t.unit_id === team)))
      && (status === 'all' || (status === 'active' ? p.active : !p.active))
      && (!needle || `${p.first_name} ${p.last_name} ${p.rank_abbr || ''} ${p.username || ''} ${p.email || ''} ${p.teams.map((t) => `${t.unit_name} ${t.billet || ''}`).join(' ')}`.toLowerCase().includes(needle)));
  }, [q.data, level, team, status, text]);

  if (!enabled) {
    return (
      <div className="page">
        <PageHeader eyebrow="People" title="People" />
        <div className="card"><EmptyState icon={UserCog} title="People is for team leaders and administrators" description="Your access is Personal. Your team, who is on it and where it stands are on Team." action={<Button asChild><Link to="/team">Open Team</Link></Button>} /></div>
      </div>
    );
  }
  if (q.isPending) return <div className="page"><PageHeader eyebrow="People" title="People" /><Skeleton className="h-96" /></div>;
  if (q.isError || !q.data) return <div className="page"><PageHeader eyebrow="People" title="People" /><div className="card"><EmptyState icon={UserCog} title="People could not load" description={api.errorText(q.error)} action={<Button onClick={() => q.refetch()}>Try again</Button>} /></div></div>;

  const d = q.data;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['people'] }); qc.invalidateQueries({ queryKey: keys.team }); };
  const act = async <T,>(fn: () => Promise<T>, done: string) => {
    try { const r = await withSudo(fn); toast.success(done); refresh(); return r; }
    catch (e) { toast.error(api.errorText(e)); return null; }
  };
  // The demo seeds its section's membership and keeps it; access levels can still be changed there.
  const demo = Boolean(identity?.demo);
  const invitable = demo ? [] : d.units.filter((u) => u.canInvite);
  const self = identity?.user.id;

  return (
    <div className="page">
      <PageHeader eyebrow="People" title="People"
        lede={d.orgAdmin
          ? 'Everyone in the organization, what they can do on each team, and their sign-in. Every change is logged and signs the person out so it applies at once.'
          : 'The people on the teams you lead, and what each can do there. Every change is logged and signs the person out so it applies at once.'}>
        {invitable.length > 0 && <Button variant="primary" onClick={() => setInviting(true)}><UserPlus className="h-4 w-4" />Invite someone</Button>}
      </PageHeader>

      {/* The three levels double as the filter: what each one means, how many hold it, and a click narrows the list. */}
      <ul className="cell-grid card mb-4 grid-cols-2 lg:grid-cols-4" aria-label="Access levels">
        {([['all', 'Everyone', `${d.stats.people} active ${d.stats.people === 1 ? 'person' : 'people'} across ${d.units.length} ${d.units.length === 1 ? 'team' : 'teams'}`, d.stats.people] as const, ...ACCESS_LEVELS.map((l) => [l.key, l.label, l.summary, d.stats[l.key]] as const)]).map(([key, label, summary, count]) => (
          <li key={key} className={cn('cell cell-link relative min-w-0', level === key && 'bg-accent-soft/50')}>
            <button type="button" aria-pressed={level === key} onClick={() => setLevel(key)} className="block w-full text-left after:absolute after:inset-0 after:content-['']">
              <span className="flex items-center gap-2 text-sm font-medium text-ink-2">{key !== 'all' && <span className={cn('h-2 w-2 rounded-full', LEVEL_DOT[key])} aria-hidden />}{label}</span>
              <span className="stat-value mt-2 block">{count}</span>
              <span className="mt-1 block text-xs text-ink-3">{summary}</span>
            </button>
          </li>
        ))}
      </ul>

      {d.orgAdmin && (
        <StatStrip label="Sign-in" className="mb-4 grid-cols-1 sm:grid-cols-3" items={[
          { label: 'Password only', value: d.stats.without_mfa ?? 0, tone: d.stats.without_mfa ? 'warn' : 'good', hint: 'Active accounts without two-step sign-in', definition: 'No authenticator app and no passkey. A password alone is the weakest way in.' },
          { label: 'Suspended', value: d.stats.suspended, hint: 'Cannot sign in; records kept' },
          { label: 'Pending invitations', value: d.pendingInvites, hint: 'Sent and not yet accepted' },
        ]} />
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-3" aria-hidden /><Input aria-label="Search people" className="pl-8" placeholder={d.orgAdmin ? 'Name, username, email, team…' : 'Name, team, billet…'} value={text} onChange={(e) => setText(e.target.value)} /></div>
        <Select aria-label="Team" className="w-56" value={team} onValueChange={setTeam} options={[{ value: 'all', label: 'Every team' }, ...d.units.map((u) => ({ value: u.id, label: teamName(u) })), ...(d.orgAdmin ? [{ value: 'none', label: 'On no team' }] : [])]} />
        {d.orgAdmin && <Segmented size="sm" label="Account status" value={status} onChange={setStatus} options={[{ value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }, { value: 'all', label: 'All' }]} />}
        <span className="text-xs text-ink-3" aria-live="polite">{people.length} shown</span>
      </div>

      {people.length === 0 ? <div className="card"><EmptyState icon={Users} title="Nobody matches" description="Clear the search or pick another level or team." /></div> : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <Table minWidth={d.orgAdmin ? 940 : 760} head={<><th>Person</th><th className="w-36">Access</th><th>Teams and access on each</th>{d.orgAdmin && <th className="w-40">Sign-in</th>}<th className="w-12"><span className="sr-only">Actions</span></th></>}>
            {people.map((p) => (
              <tr key={p.id} className={cn(!p.active && 'opacity-60')}>
                <td>
                  <span className="flex items-center gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 text-xs font-bold text-ink" aria-hidden>{initials(p.first_name, p.last_name)}</span>
                    <span className="min-w-0">
                      <span className="block font-medium text-ink">{fullName(p)}{p.id === self && <span className="ml-1.5 text-xs font-normal text-ink-3">(you)</span>}</span>
                      <span className="block truncate text-xs text-ink-3">{d.orgAdmin ? [p.username && `@${p.username}`, p.email].filter(Boolean).join(' · ') : p.teams.find((t) => t.is_primary)?.billet || p.teams[0]?.billet || ''}</span>
                    </span>
                  </span>
                </td>
                <td>
                  <span className="flex flex-col items-start gap-1">
                    <LevelBadge level={p.level} />
                    {p.org_admin && <span className="text-2xs text-ink-3">Organization-wide</span>}
                    {!p.active && <Badge tone="bad">Suspended</Badge>}
                  </span>
                </td>
                <td>
                  {p.teams.length === 0 ? <span className="text-xs text-ink-3">On no team</span> : (
                    <ul className="space-y-1.5">
                      {p.teams.map((t) => (
                        <li key={t.unit_id} className="flex flex-wrap items-center gap-2">
                          <span className="min-w-[88px] text-sm text-ink">{teamName(t)}{t.billet && <span className="block text-2xs text-ink-3">{t.billet}</span>}</span>
                          {t.settable.length > 0 && p.active
                            ? <Select aria-label={`Access for ${p.first_name} ${p.last_name} in ${teamName(t)}`} className="h-8 w-40 text-xs" value={t.level}
                                onValueChange={(v) => { if (v !== t.level) setChange({ person: p, team: t, level: v as AccessLevel }); }}
                                options={[...new Set<AccessLevel>([...t.settable, t.level])].map((l) => ({ value: l, label: ACCESS_LABEL[l], disabled: !t.settable.includes(l) }))} />
                            : <LevelBadge level={t.level} />}
                          {t.owner && <Badge tone="neutral" title="Owns the team. Ownership is transferred, not set.">Owner</Badge>}
                          {t.roles.filter((r) => !['Team Leader', 'Team Administrator', 'Unit Leader'].includes(r.name)).map((r) => <span key={r.id} className="text-2xs text-ink-3">{r.name}</span>)}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                {d.orgAdmin && (
                  <td className="text-xs">
                    {p.mfa ? <span className="flex items-center gap-1 text-good"><ShieldCheck className="h-3.5 w-3.5" aria-hidden />Two-step on</span> : <span className="text-warn">Password only</span>}
                    {p.must_change_password && <span className="block text-warn">Temporary password</span>}
                    <span className="block text-ink-3">{p.last_login_at ? `Signed in ${timeAgo(p.last_login_at)}` : 'Never signed in'}</span>
                  </td>
                )}
                <td className="text-right">
                  <PersonMenu person={demo ? { ...p, teams: p.teams.map((t) => ({ ...t, removable: false })) } : p} orgAdmin={d.orgAdmin} self={p.id === self} canAdd={!demo && (d.orgAdmin || invitable.length > 0) && p.active === 1}
                    onAdd={() => setAdding(p)} onRemove={(t) => setRemoving({ person: p, team: t })} onAccount={(kind) => setAccount({ kind, person: p })}
                    onSignOut={() => act(() => api.forceLogout(p.id), `${p.first_name} ${p.last_name} is signed out everywhere.`)}
                    onRestore={() => act(() => api.reactivateMember(p.id), `${p.first_name} ${p.last_name} can sign in again.`)} />
                </td>
              </tr>
            ))}
          </Table>
        </div>
      )}

      <details className="card mt-4 p-4 text-sm">
        <summary className="cursor-pointer font-medium text-ink">What each access level can do</summary>
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-3">
          {ACCESS_LEVELS.map((l) => (
            <section key={l.key} aria-labelledby={`level-${l.key}`}>
              <h3 id={`level-${l.key}`} className="flex items-center gap-2 font-semibold text-ink"><span className={cn('h-2 w-2 rounded-full', LEVEL_DOT[l.key])} aria-hidden />{l.label}</h3>
              <p className="mt-1 text-ink-2">{l.summary}</p>
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-ink-2">{l.can.map((c) => <li key={c}>{c}</li>)}</ul>
              <p className="mt-2 text-xs font-semibold text-ink-3">Cannot</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-3">{l.cannot.map((c) => <li key={c}>{c}</li>)}</ul>
            </section>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-3">Levels are held per team. Underneath, each is a role, so a team that builds its own roles keeps them; the level shown is what those roles add up to. Nobody changes their own access, and a team’s owner changes by transferring ownership.</p>
      </details>

      <ConfirmDialog open={Boolean(change)} onOpenChange={(o) => { if (!o) setChange(null); }} danger={false} confirmLabel="Set access"
        title={change ? `Make ${change.person.first_name} ${change.person.last_name} ${change.level === 'personal' ? 'Personal' : change.level === 'leader' ? 'a Team leader' : 'an Administrator'} in ${teamName(change.team)}?` : ''}
        body={change ? <>
          <p>{ACCESS_LEVELS.find((l) => l.key === change.level)!.summary} They are signed out so the change applies at once, and it is recorded in the access log.</p>
          {change.level === 'personal' && change.team.level !== 'personal' && <p className="mt-2 text-ink-3">Roles that give more than Personal on this team are removed.</p>}
        </> : ''}
        onConfirm={async () => { if (change) await act(() => api.setPersonLevel(change.person.id, change.team.unit_id, change.level), `${change.person.first_name} ${change.person.last_name} is now ${ACCESS_LABEL[change.level]} in ${teamName(change.team)}.`); }} />

      <ConfirmDialog open={Boolean(removing)} onOpenChange={(o) => { if (!o) setRemoving(null); }} confirmLabel="Remove from team"
        title={removing ? `Remove ${removing.person.first_name} ${removing.person.last_name} from ${teamName(removing.team)}?` : ''}
        body="Their shared records on this team are frozen as they are, and work assigned to them goes back to whoever assigned it. Their account and private records are untouched."
        onConfirm={async () => { if (removing) await act(() => api.removePersonFromTeam(removing.person.id, removing.team.unit_id), `${removing.person.first_name} ${removing.person.last_name} is off ${teamName(removing.team)}.`); }} />

      <ConfirmDialog open={Boolean(account)} onOpenChange={(o) => { if (!o) setAccount(null); }} danger={account?.kind === 'suspend'}
        confirmLabel={account ? { suspend: 'Suspend', 'reset-mfa': 'Reset two-step sign-in', temp: 'Issue password', 'org-admin': account.person.org_admin ? 'Remove' : 'Make administrator' }[account.kind] : 'Continue'}
        title={account ? {
          suspend: `Suspend ${account.person.first_name} ${account.person.last_name}?`,
          'reset-mfa': `Reset two-step sign-in for ${account.person.first_name} ${account.person.last_name}?`,
          temp: `Issue a temporary password to ${account.person.first_name} ${account.person.last_name}?`,
          'org-admin': account.person.org_admin ? `Remove organization administrator from ${account.person.first_name} ${account.person.last_name}?` : `Make ${account.person.first_name} ${account.person.last_name} an organization administrator?`,
        }[account.kind] : ''}
        body={account ? {
          suspend: 'They cannot sign in and every session ends. Their records stay, and you can restore the account at any time.',
          'reset-mfa': 'Their authenticator, recovery codes and passkeys are removed and every session ends. Use this when a phone is lost.',
          temp: 'Their current password stops working, every session ends, and they choose a new password when they next sign in. Hand the temporary password over in person.',
          'org-admin': account.person.org_admin ? 'They keep whatever access their teams give them.' : 'An organization administrator is an Administrator on every team, manages every account, and runs the owner console. Give it to as few people as possible.',
        }[account.kind] : ''}
        onConfirm={async () => {
          if (!account) return;
          const p = account.person;
          if (account.kind === 'suspend') await act(() => api.deactivateMember(p.id), `${p.first_name} ${p.last_name} is suspended.`);
          if (account.kind === 'reset-mfa') await act(() => api.resetMemberMfa(p.id), 'Two-step sign-in reset.');
          if (account.kind === 'org-admin') await act(() => api.setOperator(p.id, !p.org_admin), p.org_admin ? 'Organization administrator removed.' : 'Organization administrator granted.');
          if (account.kind === 'temp') { const r = await act(() => api.temporaryPassword(p.id) as Promise<{ password: string }>, 'Temporary password issued.'); if (r?.password) setTemp({ person: p, password: r.password }); }
        }} />

      <Dialog open={Boolean(temp)} onOpenChange={(o) => { if (!o) setTemp(null); }} title={`Temporary password for ${temp?.person.first_name} ${temp?.person.last_name}`} description="Shown once. It stops working when they choose their own." size="sm"
        footer={<Button variant="primary" onClick={async () => { if (temp && await copyToClipboard(temp.password)) toast.success('Copied.'); }}><Copy className="h-4 w-4" />Copy</Button>}>
        <p className="mono select-all rounded-md border border-line bg-surface-2 px-3 py-2 text-center text-lg text-ink">{temp?.password}</p>
      </Dialog>

      <AddToTeamDialog person={adding} units={d.orgAdmin ? d.units : invitable} onOpenChange={(o) => { if (!o) setAdding(null); }} onDone={refresh} />
      <InviteDialog open={inviting} onOpenChange={setInviting} units={invitable} onDone={refresh} />
    </div>
  );
}

function PersonMenu({ person, orgAdmin, self, canAdd, onAdd, onRemove, onAccount, onSignOut, onRestore }: {
  person: Person; orgAdmin: boolean; self: boolean; canAdd: boolean;
  onAdd: () => void; onRemove: (t: PersonTeam) => void; onAccount: (kind: 'suspend' | 'reset-mfa' | 'temp' | 'org-admin') => void; onSignOut: () => void; onRestore: () => void;
}) {
  const removable = person.teams.filter((t) => t.removable);
  if (self || (!canAdd && !removable.length && !orgAdmin)) return null;
  return (
    <Menu>
      <MenuTrigger asChild><Button size="xs" variant="ghost" aria-label={`Actions for ${person.first_name} ${person.last_name}`}><MoreHorizontal className="h-4 w-4" /></Button></MenuTrigger>
      <MenuContent>
        {canAdd && <MenuItem icon={UserPlus} onSelect={onAdd}>Add to a team…</MenuItem>}
        {removable.map((t) => <MenuItem key={t.unit_id} icon={UserMinus} onSelect={() => onRemove(t)}>Remove from {teamName(t)}…</MenuItem>)}
        {orgAdmin && (
          <>
            {(canAdd || removable.length > 0) && <MenuSeparator />}
            <MenuLabel>Account</MenuLabel>
            {person.active ? (
              <>
                <MenuItem icon={LogOut} onSelect={onSignOut}>Sign out everywhere</MenuItem>
                <MenuItem icon={ShieldCheck} onSelect={() => onAccount('reset-mfa')}>Reset two-step sign-in…</MenuItem>
                <MenuItem icon={KeyRound} onSelect={() => onAccount('temp')}>Issue a temporary password…</MenuItem>
                <MenuItem icon={UserCog} onSelect={() => onAccount('org-admin')}>{person.org_admin ? 'Remove organization administrator…' : 'Make organization administrator…'}</MenuItem>
                <MenuItem icon={UserX} danger onSelect={() => onAccount('suspend')}>Suspend account…</MenuItem>
              </>
            ) : <MenuItem icon={UserCheck} onSelect={onRestore}>Restore account</MenuItem>}
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

function LevelField({ unit, value, onChange }: { unit?: TeamOption; value: AccessLevel; onChange: (l: AccessLevel) => void }) {
  const levels = unit?.grantable?.length ? unit.grantable : (['personal'] as AccessLevel[]);
  return (
    <Field label="Access level" hint={ACCESS_LEVELS.find((l) => l.key === value)?.summary}>
      <Select value={value} onValueChange={(v) => onChange(v as AccessLevel)} options={levels.map((l) => ({ value: l, label: ACCESS_LABEL[l] }))} />
    </Field>
  );
}

function AddToTeamDialog({ person, units, onOpenChange, onDone }: { person: Person | null; units: TeamOption[]; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const toast = useToast();
  const options = units.filter((u) => !person?.teams.some((t) => t.unit_id === u.id));
  const [unitId, setUnitId] = useState('');
  const [level, setLevel] = useState<AccessLevel>('personal');
  const [billet, setBillet] = useState('');
  const [busy, setBusy] = useState(false);
  const unit = options.find((u) => u.id === unitId) || options[0];
  const submit = async () => {
    if (!person || !unit) return;
    setBusy(true);
    try {
      await withSudo(() => api.addPersonToTeam(person.id, { unit_id: unit.id, level, billet: billet.trim() || null }));
      toast.success(`${person.first_name} ${person.last_name} is on ${teamName(unit)} as ${ACCESS_LABEL[level]}.`);
      onDone(); onOpenChange(false); setBillet(''); setLevel('personal'); setUnitId('');
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={Boolean(person)} onOpenChange={onOpenChange} title={person ? `Add ${person.first_name} ${person.last_name} to a team` : ''} description="They are signed out so the new team applies when they next sign in." size="sm"
      footer={<><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button variant="primary" onClick={submit} loading={busy} disabled={!unit}>Add to team</Button></>}>
      {options.length === 0 ? <p className="text-sm text-ink-2">They are already on every team you manage.</p> : (
        <div className="space-y-3">
          <Field label="Team"><Select value={unit?.id} onValueChange={(v) => { setUnitId(v); setLevel('personal'); }} options={options.map((u) => ({ value: u.id, label: teamName(u) }))} /></Field>
          <LevelField unit={unit} value={level} onChange={setLevel} />
          <Field label="Billet" hint="optional"><Input value={billet} onChange={(e) => setBillet(e.target.value)} placeholder="Budget analyst" /></Field>
        </div>
      )}
    </Dialog>
  );
}

function InviteDialog({ open, onOpenChange, units, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; units: TeamOption[]; onDone: () => void }) {
  const toast = useToast();
  const [unitId, setUnitId] = useState('');
  const [level, setLevel] = useState<AccessLevel>('personal');
  const [form, setForm] = useState({ email: '', first_name: '', last_name: '' });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ url: string; emailed: boolean } | null>(null);
  const unit = units.find((u) => u.id === unitId) || units[0];
  const close = (o: boolean) => { onOpenChange(o); if (!o) { setCreated(null); setForm({ email: '', first_name: '', last_name: '' }); setLevel('personal'); } };
  const submit = async () => {
    if (!unit) return;
    setBusy(true);
    try {
      const key = LEVEL_ROLE_KEY[level];
      const r = await api.createInvite(unit.id, { email: form.email.trim() || undefined, first_name: form.first_name.trim() || undefined, last_name: form.last_name.trim() || undefined, role_id: key ? `${unit.id}:${key}`.slice(0, 120) : null }) as { url: string; emailed: boolean };
      setCreated(r); onDone();
      toast.success(r.emailed ? `Invitation emailed to ${form.email}.` : 'Invitation link created. Copy it and send it yourself.');
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onOpenChange={close} title="Invite someone" description="They create their own account from the link, which works for seven days, and join the team at the level you choose." size="sm"
      footer={created
        ? <><Button variant="ghost" onClick={() => setCreated(null)}>Invite another</Button><Button variant="primary" onClick={async () => { if (await copyToClipboard(created.url)) toast.success('Link copied.'); }}><Copy className="h-4 w-4" />Copy link</Button></>
        : <><Button variant="ghost" onClick={() => close(false)}>Cancel</Button><Button variant="primary" onClick={submit} loading={busy} disabled={!unit}>Create invitation</Button></>}>
      {created ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-2">{created.emailed ? 'Sent. The same link is below if they need it again.' : 'Send this link to them yourself. It works once.'}</p>
          <p className="mono select-all break-all rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-ink">{created.url}</p>
        </div>
      ) : (
        <div className="space-y-3">
          <Field label="Team"><Select value={unit?.id} onValueChange={(v) => { setUnitId(v); setLevel('personal'); }} options={units.map((u) => ({ value: u.id, label: teamName(u) }))} /></Field>
          <LevelField unit={unit} value={level} onChange={setLevel} />
          <Field label="Email" hint="optional; without one you get a link to send"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@example.org" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name"><Input value={form.first_name} onChange={(e) => setForm({ ...form, first_name: e.target.value })} /></Field>
            <Field label="Last name"><Input value={form.last_name} onChange={(e) => setForm({ ...form, last_name: e.target.value })} /></Field>
          </div>
        </div>
      )}
    </Dialog>
  );
}
