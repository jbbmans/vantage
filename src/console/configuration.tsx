import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, Building2, CalendarClock, ClipboardList, Download, FileUp, GraduationCap, Plus, RotateCcw, Save, Shield, ShieldAlert, UserPlus, Users } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, NumberInput, Panel, Segmented, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { Table } from '@/components/common';
import AccountImport from '@/components/AccountImport';
import * as api from '@/lib/api';
import { cn, formatStamp, humanize, isoDay } from '@/lib/utils';
import { endOfDay, personName, type OrgMember, type OrgSummary, type OrgUnit } from '@/lib/tenancy';
import { ECHELONS } from '../../shared/constants';
import { PERMISSIONS, PERMISSION_LIST, RECORD_READING_BITS, ROLE_TEMPLATE, listPermissions } from '../../shared/permissions';
import { TEAM_ECHELONS, type Billet, type DutyType, type TrainingRequirement, type UnitSettings } from '../../shared/unitConfig';
import { formatDate, type PeriodKey } from '../../shared/metrics';
import {
  SCORING_COMBINE, SCORING_CONDITIONS, SCORING_LIMITS, SCORING_METHODS, calculatePoints, describeRule, scoringPolicyProblems,
  type ScoringCombine, type ScoringCondition, type ScoringMethod, type ScoringPolicy, type ScoringPolicyContent, type ScoringPolicyStatus,
} from '../../shared/dutyScoring';
import { Failed, useAct, useOrg } from './sections';

/**
 * The Unit Manager console's structure and configuration pages (Task 6, ADR-0012): units and teams, billets, unit roles,
 * duty types, training requirements, work and report settings, and imports and exports. The server decides every change
 * against the caller's Unit Instance permissions; a page only hides what the role cannot use.
 */

export interface EnterpriseControls {
  version: string;
  signIn: { cac: boolean; cacRequired: boolean; organizationSignIn: boolean; passwords: boolean };
  sessions: { idleMinutes: number; consoleIdleMinutes: number; absoluteHours: number; reconfirmMinutes: number };
  attachments: { enabled: boolean; maxMegabytes: number; types: number };
  audit: { tamperEvident: boolean; forwarded: boolean };
  features: { ai: boolean; email: boolean; maradmins: boolean };
}
export interface Configuration {
  billets: Billet[]; dutyTypes: DutyType[]; trainingRequirements: TrainingRequirement[];
  settings: UnitSettings;
  limits: { claimExpiryHours: { min: number; max: number; default: number } };
  catalog: { trainingTypes: string[]; periods: Array<{ value: PeriodKey; label: string }>; standardDutyTypes: Array<{ code: string; name: string }> };
  scoring: { today: string; current: string | null; policies: Array<ScoringPolicy & { status: ScoringPolicyStatus }> };
  enterprise: EnterpriseControls;
}

const useConfiguration = (orgId: string) => useOrg<Configuration>(orgId, 'configuration', () => api.orgConfiguration(orgId));
const useUnits = (orgId: string) => useOrg<{ units: OrgUnit[] }>(orgId, 'units', () => api.orgUnits(orgId));
/** The Unit Instance's members, for the roles that may list them; nobody else asks. */
const useMembers = (org: OrgSummary, wanted = true) => {
  const may = wanted && ['org.members', 'org.owners', 'org.roles'].some((p) => org.permissions.includes(p));
  return useOrg<{ members: OrgMember[] }>(org.id, may ? 'members-all' : 'members-none', () => (may ? api.orgMembers(org.id) : Promise.resolve({ members: [] })));
};
const unitLabel = (u: Pick<OrgUnit, 'name' | 'short_name'>) => u.short_name || u.name;
/** A unit's name for a row that names it, archived or not. */
const unitName = (units: OrgUnit[], id: string) => { const u = units.find((x) => x.id === id); return u ? `${unitLabel(u)}${u.active ? '' : ' (archived)'}` : id; };
/** Tomorrow on the viewer's own calendar: the earliest day a grant can end. */
const localTomorrow = () => { const d = new Date(); d.setDate(d.getDate() + 1); return isoDay(d); };
const NONE = '__none';

/** Units in tree order, each with its depth: a command, then the units beneath it. */
function treeOf(units: OrgUnit[]): Array<OrgUnit & { depth: number }> {
  const known = new Set(units.map((u) => u.id));
  const out: Array<OrgUnit & { depth: number }> = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    units.filter((u) => (parent === null ? !u.parent_id || !known.has(u.parent_id) : u.parent_id === parent)).sort((a, b) => a.name.localeCompare(b.name))
      .forEach((u) => { if (!seen.has(u.id)) { seen.add(u.id); out.push({ ...u, depth }); walk(u.id, depth + 1); } });
  };
  walk(null, 0);
  return out;
}
const unitOptions = (units: OrgUnit[]) => treeOf(units).map((u) => ({ value: u.id, label: `${'· '.repeat(u.depth)}${unitLabel(u)}` }));

const StatusBadge = ({ active }: { active: number }) => (active ? <Badge tone="good">In use</Badge> : <Badge tone="neutral">Retired</Badge>);

// ——— Units and teams ———

type UnitDraft = { id?: string; name: string; short_name: string; echelon: string; location: string; parent_id: string };

export function UnitsAndTeams({ org }: { org: OrgSummary }) {
  const can = (p: string) => org.permissions.includes(p);
  const qc = useQueryClient();
  const act = useAct();
  const toast = useToast();
  const { data, isPending, error, refetch } = useUnits(org.id);
  const members = useMembers(org, can('org.units'));
  const [show, setShow] = useState<'all' | 'teams'>('all');
  const [editing, setEditing] = useState<UnitDraft | null>(null);
  const [archiving, setArchiving] = useState<OrgUnit | null>(null);
  const [leading, setLeading] = useState<OrgUnit | null>(null);
  const [leader, setLeader] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id] });
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const active = data.units.filter((u) => u.active);
  const rows = treeOf(data.units).filter((u) => show === 'all' || TEAM_ECHELONS.includes(u.echelon || ''));
  const isRoot = (u: OrgUnit) => u.id === org.root_unit_id || !u.parent_id;
  const save = async () => {
    if (!editing) return;
    const base = { name: editing.name, short_name: editing.short_name || null, echelon: editing.echelon, parent_id: editing.parent_id || null };
    if (editing.id) { if (await act('Unit saved.', () => api.updateUnit(editing.id!, base), refresh)) setEditing(null); return; }
    // Whoever creates a unit through the chain of command leads it; through a Unit Instance role, it is led from above.
    const made = await act(`${editing.name} created.`, () => api.createUnit({ ...base, location: editing.location || null }) as Promise<OrgUnit>, refresh);
    if (made) { if (!made.owner_user_id) toast.info('It is led from above until you name its leader.'); setEditing(null); }
  };
  const start = (echelon: string) => setEditing({ name: '', short_name: '', echelon, location: '', parent_id: org.root_unit_id || active[0]?.id || '' });
  // A unit cannot move beneath itself or a unit beneath it; the server refuses it too.
  const below = (id: string) => { const out = new Set([id]); let grew = true; while (grew) { grew = false; for (const u of active) if (u.parent_id && out.has(u.parent_id) && !out.has(u.id)) { out.add(u.id); grew = true; } } return out; };
  const parents = editing?.id ? active.filter((u) => !below(editing.id!).has(u.id)) : active;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Show" value={show} onChange={setShow} options={[{ value: 'all', label: 'Every unit' }, { value: 'teams', label: 'Teams' }]} size="sm" />
        <span className="text-xs text-ink-3">{rows.length} shown</span>
        {can('org.units') && <span className="ml-auto flex flex-wrap gap-2"><Button size="sm" onClick={() => start('fire_team')}><Users className="h-4 w-4" />New team</Button><Button size="sm" variant="primary" onClick={() => start('section')}><Building2 className="h-4 w-4" />New unit</Button></span>}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {!rows.length ? <EmptyState icon={Users} title={show === 'teams' ? 'No teams yet' : 'No units'} description={show === 'teams' ? 'A team is a squad or fire team. Create one under the unit it belongs to.' : undefined} /> : (
          <Table minWidth={780} head={<><th>Unit</th><th className="w-40">Echelon</th><th className="w-44">Leader</th><th className="w-20 text-right">Members</th><th className="w-24">Status</th><th className="relative w-56"><span className="sr-only">Actions</span></th></>}>
            {rows.map((u) => (
              <tr key={u.id}>
                <td><span className="block font-medium text-ink" style={{ paddingLeft: `${u.depth * 1.25}rem` }}>{u.depth ? '└ ' : ''}{u.name}</span><span className="block text-xs text-ink-3" style={{ paddingLeft: `${u.depth * 1.25}rem` }}>{u.short_name ? `${u.short_name} · ` : ''}{u.code}</span></td>
                <td className="text-xs text-ink-2">{ECHELONS.find((e) => e.value === u.echelon)?.label || humanize(u.echelon || '')}</td>
                <td className="text-xs">{u.owner_user_id ? `${u.owner_first} ${u.owner_last}` : u.parent_id ? <span className="text-ink-3">led from above</span> : <Badge tone="warn">No leader</Badge>}</td>
                <td className="fig text-right">{u.members}</td>
                <td>{u.active ? <Badge tone="good">Active</Badge> : <Badge tone="neutral">Archived</Badge>}</td>
                <td className="text-right">{can('org.units') && u.active ? <span className="flex flex-wrap justify-end gap-1">
                  {!isRoot(u) && <Button size="xs" variant="ghost" aria-label={`Edit ${u.name}`} onClick={() => setEditing({ id: u.id, name: u.name, short_name: u.short_name || '', echelon: u.echelon || 'section', location: '', parent_id: u.parent_id || '' })}>Edit</Button>}
                  <Button size="xs" variant="ghost" aria-label={`Set leader for ${u.name}`} onClick={() => { setLeading(u); setLeader(''); }}>Set leader</Button>
                  {!isRoot(u) && <Button size="xs" variant="ghost" aria-label={`Archive ${u.name}`} onClick={() => setArchiving(u)}><Archive className="h-3 w-3" />Archive</Button>}
                </span> : null}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      <p className="text-xs text-ink-3">A unit you create as a Unit Manager is led from above until you name its leader; one you create where you lead through the chain of command is yours to lead. A leader holds every permission in their unit and the units beneath it. The top unit carries the Unit Instance’s name, which changes in Settings.</p>

      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} size="sm" title={editing?.id ? `Edit ${editing.name}` : TEAM_ECHELONS.includes(editing?.echelon || '') ? 'New team' : 'New unit'}
        description={editing?.id ? 'Moving a unit takes the units beneath it along. It stays in this Unit Instance.' : 'Under one of this Unit Instance’s units.'}
        footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" disabled={!editing?.name.trim() || !editing?.parent_id} onClick={save}><Save className="h-4 w-4" />Save</Button></>}>
        {editing && (
          <div className="space-y-3">
            <Field label="Name" required><Input autoFocus maxLength={120} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Short name"><Input maxLength={40} value={editing.short_name} onChange={(e) => setEditing({ ...editing, short_name: e.target.value })} /></Field>
              <Field label="Echelon"><Select value={editing.echelon} onValueChange={(v) => setEditing({ ...editing, echelon: v })} options={ECHELONS.filter((e) => e.value !== 'command').map((e) => ({ value: e.value, label: e.label }))} /></Field>
            </div>
            <Field label="Beneath"><Select value={editing.parent_id} onValueChange={(v) => setEditing({ ...editing, parent_id: v })} placeholder="Choose a unit" options={unitOptions(parents)} /></Field>
            {!editing.id && <Field label="Location" hint="optional"><Input maxLength={120} value={editing.location} onChange={(e) => setEditing({ ...editing, location: e.target.value })} /></Field>}
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={Boolean(archiving)} onOpenChange={(o) => { if (!o) setArchiving(null); }} title={`Archive ${archiving?.name}?`} confirmLabel="Archive"
        body="It leaves the Unit Instance’s structure and its shared work stays on the record. A unit that still has members or units beneath it is not archived: move them first."
        onConfirm={async () => { if (archiving) await act('Unit archived.', () => api.archiveUnit(archiving.id), refresh); setArchiving(null); }} />
      <Dialog open={Boolean(leading)} onOpenChange={(o) => { if (!o) setLeading(null); }} title={`Leader for ${leading?.name}`} size="sm" description="The leader holds the Unit Leader role. A former leader loses it and is signed out."
        footer={<><Button variant="ghost" onClick={() => setLeading(null)}>Cancel</Button><Button variant="primary" disabled={!leader} onClick={async () => { if (!leading) return; const r = await act('Leader set.', () => api.orgSetLeader(org.id, leading.id, leader), refresh); if (r) setLeading(null); }}>Set leader</Button></>}>
        <Field label="Member"><Select value={leader} onValueChange={setLeader} placeholder="Choose a member" options={(members.data?.members ?? []).filter((m) => m.active).map((m) => ({ value: m.id, label: `${personName(m)} (@${m.username})` }))} /></Field>
      </Dialog>
    </div>
  );
}

// ——— Billets ———

type BilletDraft = { id?: string; title: string; code: string; unit_id: string; description: string };
const sameTitle = (a: string | null | undefined, b: string) => (a || '').trim().toLowerCase() === b.trim().toLowerCase();

export function Billets({ org }: { org: OrgSummary }) {
  const can = (p: string) => org.permissions.includes(p);
  const qc = useQueryClient();
  const act = useAct();
  const config = useConfiguration(org.id);
  const units = useUnits(org.id);
  const members = useMembers(org);
  const [editing, setEditing] = useState<BilletDraft | null>(null);
  const [unitId, setUnitId] = useState('');
  const [assigning, setAssigning] = useState<{ title: string; userId: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id] });
  if (config.isPending || units.isPending) return <Skeleton className="h-64" />;
  if (config.error || !config.data) return <Failed error={config.error} retry={() => config.refetch()} />;
  const active = (units.data?.units ?? []).filter((u) => u.active);
  const nameOf = (id: string | null) => (id ? unitName(units.data?.units ?? [], id) : 'Any unit');
  const shownUnit = unitId || org.root_unit_id || active[0]?.id || '';
  const billets = config.data.billets;
  const forUnit = billets.filter((b) => b.active && (!b.unit_id || b.unit_id === shownUnit));
  const people = (members.data?.members ?? []).filter((m) => m.active && m.units.some((u) => u.unit_id === shownUnit));
  const billetHere = (m: OrgMember) => m.units.find((u) => u.unit_id === shownUnit)?.billet || null;
  const offList = people.filter((m) => !forUnit.some((b) => sameTitle(billetHere(m), b.title)));
  const save = async () => {
    if (!editing) return;
    const body = { title: editing.title, code: editing.code || null, unit_id: editing.unit_id || null, description: editing.description || null };
    const r = await act(editing.id ? 'Billet saved.' : 'Billet added.', () => api.orgSaveBillet(org.id, body, editing.id), refresh);
    if (r) setEditing(null);
  };
  const assign = async () => {
    if (!assigning) return;
    const r = await act(`${assigning.title} assigned.`, () => api.updateMembership(shownUnit, assigning.userId, { billet: assigning.title }), refresh);
    if (r) setAssigning(null);
  };
  const seeRoster = ['org.members', 'org.owners', 'org.roles'].some(can);
  return (
    <div className="space-y-4">
      <Panel title="Billet list" subtitle="The billets this Unit Instance staffs, in one unit or in any. A member’s billet is chosen from it." padded={false}
        action={can('org.config') ? <Button size="sm" variant="primary" onClick={() => setEditing({ title: '', code: '', unit_id: '', description: '' })}><Plus className="h-4 w-4" />New billet</Button> : undefined}>
        {!billets.length ? <EmptyState icon={ClipboardList} title="No billets listed yet" description="Add the billets your table of organization staffs; the empty ones then show as vacant." /> : (
          <Table minWidth={680} head={<><th>Billet</th><th className="w-28">Code</th><th className="w-44">Unit</th><th className="w-24">Status</th><th className="relative w-40"><span className="sr-only">Actions</span></th></>}>
            {billets.map((b) => (
              <tr key={b.id}>
                <td><span className="block font-medium text-ink">{b.title}</span>{b.description && <span className="block text-xs text-ink-3">{b.description}</span>}</td>
                <td className="mono text-xs text-ink-2">{b.code || ''}</td>
                <td className="text-xs text-ink-2">{nameOf(b.unit_id)}</td>
                <td><StatusBadge active={b.active} /></td>
                <td className="text-right">{can('org.config') && <span className="flex justify-end gap-1">
                  {b.active ? <Button size="xs" variant="ghost" aria-label={`Edit ${b.title}`} onClick={() => setEditing({ id: b.id, title: b.title, code: b.code || '', unit_id: b.unit_id || '', description: b.description || '' })}>Edit</Button> : null}
                  {b.active
                    ? <Button size="xs" variant="ghost" aria-label={`Retire ${b.title}`} onClick={() => act('Billet retired. Whoever holds it keeps it until it is changed.', () => api.orgSaveBillet(org.id, { active: false }, b.id), refresh)}>Retire</Button>
                    : <Button size="xs" variant="ghost" aria-label={`Restore ${b.title}`} onClick={() => act('Billet restored.', () => api.orgSaveBillet(org.id, { active: true }, b.id), refresh)}><RotateCcw className="h-3 w-3" />Restore</Button>}
                </span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </Panel>

      {seeRoster && (
        <Panel title="Billet roster" subtitle="Who holds each listed billet in a unit, and which are vacant." action={<Select aria-label="Unit" value={shownUnit} onValueChange={setUnitId} className="w-56" options={unitOptions(active)} />}>
          {members.isPending ? <Skeleton className="h-32" /> : !forUnit.length ? <p className="text-sm text-ink-3">No billets are listed for this unit.</p> : (
            <ul className="divide-y divide-line" aria-label="Billet roster">
              {forUnit.map((b) => {
                const held = people.filter((m) => sameTitle(billetHere(m), b.title));
                return (
                  <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0"><span className="block text-sm font-medium text-ink">{b.title}</span><span className="block text-xs text-ink-2">{held.length ? held.map((m) => personName(m)).join(', ') : <Badge tone="warn">Vacant</Badge>}</span></span>
                    {can('org.members') && <Button size="xs" variant="ghost" aria-label={`Assign ${b.title}`} onClick={() => setAssigning({ title: b.title, userId: '' })}><UserPlus className="h-3 w-3" />Assign</Button>}
                  </li>
                );
              })}
            </ul>
          )}
          {offList.length > 0 && <p className="mt-3 text-xs text-ink-3">Not in a listed billet here: {offList.map((m) => `${personName(m)}${billetHere(m) ? ` (${billetHere(m)})` : ''}`).join(', ')}.</p>}
        </Panel>
      )}

      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} size="sm" title={editing?.id ? `Edit ${editing.title}` : 'New billet'}
        footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" disabled={!editing?.title.trim()} onClick={save}><Save className="h-4 w-4" />Save</Button></>}>
        {editing && (
          <div className="space-y-3">
            <Field label="Title" required><Input autoFocus maxLength={80} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Budget Analyst" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Code" hint="optional, such as a T/O line"><Input maxLength={20} className="mono" value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
              <Field label="Unit"><Select value={editing.unit_id || NONE} onValueChange={(v) => setEditing({ ...editing, unit_id: v === NONE ? '' : v })} options={[{ value: NONE, label: 'Any unit' }, ...unitOptions(active)]} /></Field>
            </div>
            <Field label="Description" hint="optional"><Textarea rows={2} maxLength={300} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
          </div>
        )}
      </Dialog>
      <Dialog open={Boolean(assigning)} onOpenChange={(o) => { if (!o) setAssigning(null); }} size="sm" title={`Assign ${assigning?.title}`} description={`To a member of ${nameOf(shownUnit)}. Their billet history keeps the one it replaces.`}
        footer={<><Button variant="ghost" onClick={() => setAssigning(null)}>Cancel</Button><Button variant="primary" disabled={!assigning?.userId} onClick={assign}>Assign</Button></>}>
        <Field label="Member"><Select value={assigning?.userId ?? ''} onValueChange={(v) => setAssigning((a) => (a ? { ...a, userId: v } : a))} placeholder="Choose a member" options={people.map((m) => ({ value: m.id, label: `${personName(m)}${billetHere(m) ? ` · now ${billetHere(m)}` : ''}` }))} /></Field>
      </Dialog>
    </div>
  );
}

// ——— Unit roles ———

interface UnitRole {
  id: string; unit_id: string; key: string | null; name: string; description: string | null; color: string | null; position: number; permissions: number;
  is_default: number; is_system: number; editable: boolean;
  holders: Array<{ user_id: string; username: string; first_name: string; last_name: string; rank_abbr: string | null; expires_at: string | null }>;
}
type RoleDraft = { id?: string; is_default?: number; name: string; description: string; color: string; position: number; permissions: number };

export function UnitRoles({ org }: { org: OrgSummary }) {
  const can = (p: string) => org.permissions.includes(p);
  const qc = useQueryClient();
  const act = useAct();
  const toast = useToast();
  const { data, isPending, error, refetch } = useOrg<{ roles: UnitRole[] }>(org.id, 'unit-roles', () => api.orgUnitRoles(org.id));
  const units = useUnits(org.id);
  const members = useMembers(org);
  const [unitId, setUnitId] = useState('');
  const [editing, setEditing] = useState<RoleDraft | null>(null);
  const [deleting, setDeleting] = useState<UnitRole | null>(null);
  const [granting, setGranting] = useState<{ role: UnitRole; userId: string; until: string } | null>(null);
  const [revoking, setRevoking] = useState<{ role: UnitRole; userId: string; name: string } | null>(null);
  const groups = useMemo(() => [...new Set(PERMISSION_LIST.map((p) => p.group))], []);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id] });
  if (isPending || units.isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const active = (units.data?.units ?? []).filter((u) => u.active);
  const shownUnit = unitId || org.root_unit_id || active[0]?.id || '';
  const roles = data.roles.filter((r) => r.unit_id === shownUnit);
  const fixed = (r: UnitRole) => Boolean(r.is_default) || r.key === 'unit-leader';
  const save = async () => {
    if (!editing) return;
    const body = { unit_id: shownUnit, name: editing.name, description: editing.description || null, color: editing.color || null, position: Number(editing.position) || 0, permissions: editing.permissions };
    const r = await act('Role saved.', () => (editing.id ? api.updateRole(editing.id, body) : api.createRole(body)), refresh);
    if (r) { if ((r as { sessionsRevoked?: number }).sessionsRevoked) toast.info('Everyone who holds it was signed out so the change applies.'); setEditing(null); }
  };
  const toggle = (bit: number) => setEditing((e) => (e ? { ...e, permissions: e.permissions & bit ? e.permissions & ~bit : e.permissions | bit } : e));
  const unitPeople = (members.data?.members ?? []).filter((m) => m.active && m.units.some((u) => u.unit_id === shownUnit));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Unit" className="w-64"><Select aria-label="Unit" value={shownUnit} onValueChange={setUnitId} options={unitOptions(active)} /></Field>
        {can('org.roles') && <Button className="ml-auto" variant="primary" onClick={() => setEditing({ name: '', description: '', color: '#6b7a8f', position: 20, permissions: ROLE_TEMPLATE[1].permissions })}><Shield className="h-4 w-4" />New role</Button>}
      </div>
      <p className="text-xs text-ink-3">A unit role’s permissions apply in its unit and the units beneath it. A Unit Instance role never reads records, so granting yourself a role that reads them, or reaches further than the chain of command gave you, is refused: another Unit Manager does that.</p>
      {!roles.length ? <div className="card"><EmptyState icon={Shield} title="No roles in this unit" /></div> : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {roles.map((r) => (
            <article key={r.id} className="card p-4" aria-label={r.name}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2"><span className="badge-dot h-3 w-3" style={{ backgroundColor: r.color || '#6b7a8f' }} aria-hidden /><h3 className="text-base font-semibold text-ink">{r.name}</h3>{r.is_default ? <Badge>Everyone</Badge> : null}{r.key === 'unit-leader' ? <Badge tone="accent">Leader</Badge> : null}{r.permissions & RECORD_READING_BITS ? <Badge tone="warn">Reads records</Badge> : null}</div>
                <span className="fig text-xs text-ink-3">position {r.position}</span>
              </div>
              {r.description && <p className="mt-1 text-sm text-ink-2">{r.description}</p>}
              <ul className="mt-2 flex flex-wrap gap-1" aria-label={`${r.name} permissions`}>{listPermissions(r.permissions).map((k) => <li key={k}><Badge tone={k === 'ADMINISTRATOR' ? 'bad' : 'neutral'}>{PERMISSION_LIST.find((p) => p.key === k)?.label}</Badge></li>)}</ul>
              <p className="mt-3 text-xs font-semibold text-ink-2">Held by</p>
              {!r.holders.length ? <p className="text-xs text-ink-3">Nobody.</p> : r.is_default ? <p className="text-xs text-ink-3">Every member of the unit.</p> : (
                <ul className="mt-1 space-y-1">{r.holders.map((h) => (
                  <li key={h.user_id} className="flex items-center justify-between gap-2 text-xs"><span className="text-ink">{personName(h)}{h.expires_at ? <span className="ml-1 inline-flex items-center gap-1 text-ink-3"><CalendarClock className="h-3 w-3" />until {new Date(h.expires_at).toLocaleDateString()}</span> : null}</span>
                    {can('org.roles') && !fixed(r) && <Button size="xs" variant="ghost" aria-label={`Remove ${r.name} from ${personName(h)}`} onClick={() => setRevoking({ role: r, userId: h.user_id, name: personName(h) })}>Remove</Button>}</li>
                ))}</ul>
              )}
              {can('org.roles') && r.key !== 'unit-leader' && (
                <div className="mt-3 flex flex-wrap justify-end gap-1 border-t border-line pt-2">
                  {!r.is_default && <Button size="xs" variant="ghost" aria-label={`Grant ${r.name}`} onClick={() => setGranting({ role: r, userId: '', until: '' })}><UserPlus className="h-3 w-3" />Grant</Button>}
                  {r.editable && <Button size="xs" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditing({ id: r.id, is_default: r.is_default, name: r.name, description: r.description || '', color: r.color || '#6b7a8f', position: r.position, permissions: r.permissions })}>Edit</Button>}
                  {r.editable && !r.is_default && <Button size="xs" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => setDeleting(r)}>Delete</Button>}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} title={editing?.id ? `Edit ${editing.name}` : 'New role'} description="Changing a role’s permissions signs out everyone who holds it, so the change applies at once."
        footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" disabled={!editing?.name.trim()} onClick={save}><Save className="h-4 w-4" />Save role</Button></>}>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_auto_auto] gap-3">
              <Field label="Name" required><Input value={editing.name} maxLength={60} disabled={Boolean(editing.is_default)} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Position" hint="0 to 99"><NumberInput min={0} max={99} className="w-20" value={editing.position} onChange={(e) => setEditing({ ...editing, position: Number(e.target.value) })} /></Field>
              <Field label="Color"><input type="color" className="h-9 w-12 cursor-pointer rounded-md border border-line bg-surface" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} aria-label="Role color" /></Field>
            </div>
            <Field label="Description"><Textarea rows={2} maxLength={300} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
            <div className="flex flex-wrap gap-1.5"><span className="text-xs text-ink-3">Start from:</span>{ROLE_TEMPLATE.filter((t) => !t.owner).map((t) => <button key={t.key} type="button" className="rounded-full border border-line px-2 py-0.5 text-2xs hover:border-line-strong" onClick={() => setEditing({ ...editing, permissions: t.permissions })}>{t.name}</button>)}</div>
            {groups.map((g) => (
              <fieldset key={g}><legend className="eyebrow mb-1.5">{g}</legend><div className="space-y-1">{PERMISSION_LIST.filter((p) => p.group === g).map((p) => (
                <label key={p.key} className={cn('flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2', p.dangerous && 'border border-bad/30')}>
                  <input type="checkbox" className="mt-1" checked={Boolean(editing.permissions & PERMISSIONS[p.key])} onChange={() => toggle(PERMISSIONS[p.key])} />
                  <span><span className="block text-sm font-medium text-ink">{p.label}{PERMISSIONS[p.key] & RECORD_READING_BITS ? <span className="ml-1 text-2xs font-normal text-warn">reads records</span> : null}</span><span className="block text-xs text-ink-3">{p.hint}</span></span>
                </label>
              ))}</div></fieldset>
            ))}
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(o) => { if (!o) setDeleting(null); }} title={`Delete the ${deleting?.name} role?`} body="Everyone who holds it loses those permissions and is signed out."
        onConfirm={async () => { if (deleting) await act('Role deleted.', () => api.deleteRole(deleting.id), refresh); setDeleting(null); }} />
      <ConfirmDialog open={Boolean(revoking)} onOpenChange={(o) => { if (!o) setRevoking(null); }} title={`Remove ${revoking?.role.name} from ${revoking?.name}?`} body="They are signed out and the role ends now." confirmLabel="Remove"
        onConfirm={async () => { if (revoking) await act('Role removed.', () => api.revokeRole(revoking.userId, revoking.role.id), refresh); setRevoking(null); }} />
      <Dialog open={Boolean(granting)} onOpenChange={(o) => { if (!o) setGranting(null); }} size="sm" title={`Grant ${granting?.role.name}`} description="To a member of this unit. They are signed out, and pick it up when they sign in again."
        footer={<><Button variant="ghost" onClick={() => setGranting(null)}>Cancel</Button><Button variant="primary" disabled={!granting?.userId} onClick={async () => {
          if (!granting) return;
          const r = await act('Role granted.', () => api.grantRole(granting.userId, { role_id: granting.role.id, unit_id: granting.role.unit_id, expires_at: endOfDay(granting.until) }), refresh);
          if (r) setGranting(null);
        }}>Grant</Button></>}>
        {granting && (
          <div className="space-y-3">
            <Field label="Member"><Select value={granting.userId} onValueChange={(v) => setGranting({ ...granting, userId: v })} placeholder="Choose a member" options={unitPeople.filter((m) => !granting.role.holders.some((h) => h.user_id === m.id)).map((m) => ({ value: m.id, label: `${personName(m)} (@${m.username})` }))} /></Field>
            <Field label="Until" hint="optional: an acting billet or a leave period, up to a year"><Input type="date" min={localTomorrow()} value={granting.until} onChange={(e) => setGranting({ ...granting, until: e.target.value })} /></Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}

// ——— Duty ———

type DutyDraft = { id?: string; code: string; name: string; description: string };

export function Duty({ org }: { org: OrgSummary }) {
  const can = (p: string) => org.permissions.includes(p);
  const qc = useQueryClient();
  const act = useAct();
  const { data, isPending, error, refetch } = useConfiguration(org.id);
  const [editing, setEditing] = useState<DutyDraft | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id] });
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const save = async () => {
    if (!editing) return;
    const r = await act(editing.id ? 'Duty type saved.' : 'Duty type added.', () => api.orgSaveDutyType(org.id, { code: editing.code || editing.name, name: editing.name, description: editing.description || null }, editing.id), refresh);
    if (r) setEditing(null);
  };
  const missing = data.catalog.standardDutyTypes.filter((s) => !data.dutyTypes.some((d) => d.code === s.code));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="max-w-2xl text-sm text-ink-2">Vantage does not record duty yet. When it does, each duty is scored under the scoring version in force on its day.</p>
        {can('org.config') && <span className="ml-auto flex flex-wrap gap-2">
          {missing.length > 0 && <Button size="sm" onClick={() => act(`Added ${missing.length} duty types.`, () => api.orgAddStandardDutyTypes(org.id), refresh)}>Add the standard list</Button>}
          <Button size="sm" variant="primary" onClick={() => setEditing({ code: '', name: '', description: '' })}><Plus className="h-4 w-4" />New duty type</Button>
        </span>}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {!data.dutyTypes.length ? <EmptyState icon={ShieldAlert} title="No duty types yet" description={`Start from the standard list (${data.catalog.standardDutyTypes.map((d) => d.name).join(', ')}) or add your own.`} /> : (
          <Table minWidth={600} head={<><th className="w-36">Code</th><th>Name</th><th className="w-24">Status</th><th className="relative w-40"><span className="sr-only">Actions</span></th></>}>
            {data.dutyTypes.map((d) => (
              <tr key={d.id}>
                <td className="mono text-xs text-ink">{d.code}</td>
                <td><span className="block text-sm text-ink">{d.name}</span>{d.description && <span className="block text-xs text-ink-3">{d.description}</span>}</td>
                <td><StatusBadge active={d.active} /></td>
                <td className="text-right">{can('org.config') && <span className="flex justify-end gap-1">
                  {d.active ? <Button size="xs" variant="ghost" aria-label={`Edit ${d.name}`} onClick={() => setEditing({ id: d.id, code: d.code, name: d.name, description: d.description || '' })}>Edit</Button> : null}
                  {d.active
                    ? <Button size="xs" variant="ghost" aria-label={`Retire ${d.name}`} onClick={() => act('Duty type retired.', () => api.orgSaveDutyType(org.id, { active: false }, d.id), refresh)}>Retire</Button>
                    : <Button size="xs" variant="ghost" aria-label={`Restore ${d.name}`} onClick={() => act('Duty type restored.', () => api.orgSaveDutyType(org.id, { active: true }, d.id), refresh)}><RotateCcw className="h-3 w-3" />Restore</Button>}
                </span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      <DutyScoring org={org} data={data} />
      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} size="sm" title={editing?.id ? `Edit ${editing.name}` : 'New duty type'}
        footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" disabled={!editing?.name.trim()} onClick={save}><Save className="h-4 w-4" />Save</Button></>}>
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_8rem] gap-3">
              <Field label="Name" required><Input autoFocus maxLength={60} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Barracks Duty" /></Field>
              <Field label="Code" hint="from the name if empty"><Input maxLength={20} className="mono uppercase" value={editing.code} onChange={(e) => setEditing({ ...editing, code: e.target.value })} /></Field>
            </div>
            <Field label="Description" hint="optional"><Textarea rows={2} maxLength={300} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}

// ——— Duty scoring (Task 18 brought forward) ———

type MethodChoice = ScoringMethod | 'none';
type RuleDraft = { method: MethodChoice; points: string; bands: Array<{ from_hours: string; points: string }> };
type ScoringDraft = {
  effective_from: string; note: string; combine: ScoringCombine;
  rules: Record<string, RuleDraft>;
  multipliers: Record<ScoringCondition, { on: boolean; factor: string }>;
};
const STANDARD_BANDS = [{ from_hours: '0', points: '1' }, { from_hours: '4', points: '2' }, { from_hours: '8', points: '3' }, { from_hours: '12', points: '4' }];
const STATUS_BADGE: Record<ScoringPolicyStatus, React.ReactNode> = {
  in_force: <Badge tone="good">In force</Badge>, scheduled: <Badge tone="warn">Scheduled</Badge>,
  superseded: <Badge tone="neutral">Superseded</Badge>, withdrawn: <Badge tone="neutral">Withdrawn</Badge>,
};
/** A number typed into a box; an empty box is no number, not zero. */
const typed = (s: string) => (s.trim() === '' ? Number.NaN : Number(s));
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const conditionLabel = (key: string) => SCORING_CONDITIONS.find((c) => c.key === key)?.label ?? humanize(key);
const describeMultipliers = (p: ScoringPolicyContent) => (!p.multipliers.length ? 'No multipliers.'
  : `${p.multipliers.map((m) => `${conditionLabel(m.condition)} ×${m.factor}`).join(', ')}${p.multipliers.length > 1 ? `; when several apply, ${p.combine === 'multiply' ? 'all of them multiplied' : 'the highest one'}` : ''}.`);

function contentOf(draft: ScoringDraft): ScoringPolicyContent {
  return {
    rules: Object.entries(draft.rules).filter(([, r]) => r.method !== 'none').map(([duty_type_id, r]) => (r.method === 'bands'
      ? { duty_type_id, method: r.method, points: null, bands: r.bands.map((b) => ({ from_hours: typed(b.from_hours), points: typed(b.points) })) }
      : { duty_type_id, method: r.method as ScoringMethod, points: typed(r.points), bands: null })),
    multipliers: SCORING_CONDITIONS.filter((c) => draft.multipliers[c.key].on).map((c) => ({ condition: c.key, factor: typed(draft.multipliers[c.key].factor) })),
    combine: draft.combine,
  };
}

/** A new draft, from the latest version still standing so a change starts from what is there; retired duty types drop out. */
function draftFrom(latest: ScoringPolicy | null, dutyTypes: DutyType[], earliest: string): ScoringDraft {
  const rules: Record<string, RuleDraft> = {};
  for (const d of dutyTypes) {
    const r = latest?.rules.find((x) => x.duty_type_id === d.id);
    rules[d.id] = r
      ? { method: r.method, points: r.points == null ? '' : String(r.points), bands: r.bands?.map((b) => ({ from_hours: String(b.from_hours), points: String(b.points) })) ?? STANDARD_BANDS }
      : { method: 'none', points: '', bands: STANDARD_BANDS };
  }
  const multipliers = Object.fromEntries(SCORING_CONDITIONS.map((c) => {
    const m = latest?.multipliers.find((x) => x.condition === c.key);
    return [c.key, { on: Boolean(m), factor: m ? String(m.factor) : '1.5' }];
  })) as ScoringDraft['multipliers'];
  return { effective_from: earliest, note: '', combine: latest?.combine ?? 'highest', rules, multipliers };
}

function ScoringRules({ policy, names }: { policy: ScoringPolicyContent; names: Map<string, string> }) {
  if (!policy.rules.length) return <p className="text-sm text-ink-3">It scores no duty type.</p>;
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(10rem,auto)_1fr]">
      {policy.rules.map((r) => (
        <div key={r.duty_type_id} className="contents">
          <dt className="text-ink-2">{names.get(r.duty_type_id) ?? 'A duty type since removed'}</dt>
          <dd className="fig text-ink">{describeRule(r)}</dd>
        </div>
      ))}
    </dl>
  );
}

function DutyScoring({ org, data }: { org: OrgSummary; data: Configuration }) {
  const can = (p: string) => org.permissions.includes(p);
  const qc = useQueryClient();
  const act = useAct();
  const [draft, setDraft] = useState<ScoringDraft | null>(null);
  const [withdrawing, setWithdrawing] = useState<ScoringPolicy | null>(null);
  const [trial, setTrial] = useState<{ duty_type_id: string; hours: string; days: string; conditions: ScoringCondition[] }>({ duty_type_id: '', hours: '24', days: '1', conditions: [] });
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id] });
  const { today, current, policies } = data.scoring;
  const names = new Map(data.dutyTypes.map((d) => [d.id, d.name]));
  const inUse = data.dutyTypes.filter((d) => d.active);
  const inUseNames = new Map(inUse.map((d) => [d.id, d.name]));
  const standing = policies.filter((p) => !p.withdrawn_at);
  const latest = standing.reduce<ScoringPolicy | null>((a, p) => (!a || p.effective_from > a.effective_from ? p : a), null);
  // Tomorrow at the soonest, and after the latest version standing (the server holds it to the same).
  const earliest = dayAfter(latest && latest.effective_from > today ? latest.effective_from : today);
  const inForce = policies.find((p) => p.id === current) ?? null;
  const content = draft ? contentOf(draft) : null;
  const problems = draft && content ? [
    ...scoringPolicyProblems(content, inUseNames),
    ...(draft.effective_from < earliest ? [`It takes effect ${earliest} or later.`] : []),
  ] : [];
  const tried = content ? calculatePoints(content, { duty_type_id: trial.duty_type_id || inUse[0]?.id || '', hours: typed(trial.hours), days: typed(trial.days), conditions: trial.conditions }) : null;
  const setRule = (id: string, patch: Partial<RuleDraft>) => draft && setDraft({ ...draft, rules: { ...draft.rules, [id]: { ...draft.rules[id], ...patch } } });
  const publish = async () => {
    if (!draft || !content || problems.length) return;
    const r = await act('Scoring version published.', () => api.orgPublishScoringPolicy(org.id, { ...content, effective_from: draft.effective_from, note: draft.note }), refresh);
    if (r) setDraft(null);
  };
  return (
    <Panel title="Scoring" subtitle="The points each kind of duty earns. A version never changes once published: a new one takes effect on its date, and duty stood before it keeps the points of its day."
      action={can('org.config') && inUse.length ? <Button size="sm" variant="primary" onClick={() => setDraft(draftFrom(latest, inUse, earliest))}><Plus className="h-4 w-4" />New version</Button> : undefined}>
      <div className="space-y-4">
        {inForce ? (
          <div className="space-y-2">
            <p className="text-sm text-ink"><span className="font-medium">Version {inForce.version}</span> is in force, since {formatDate(inForce.effective_from)}.</p>
            <ScoringRules policy={inForce} names={names} />
            <p className="text-xs text-ink-3">{describeMultipliers(inForce)}</p>
          </div>
        ) : <p className="text-sm text-ink-3">{inUse.length ? 'No version is in force, so duty earns no points.' : 'Add duty types first; a version scores the ones in use.'}</p>}
        {policies.length > 0 && (
          <ul aria-label="Scoring versions" className="divide-y divide-line rounded-xl border border-line">
            {policies.map((p) => {
              const { status } = p;
              return (
                <li key={p.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2">
                  <span className="min-w-0 flex-1 basis-56">
                    <span className="flex flex-wrap items-center gap-2 text-sm text-ink"><span className="font-medium">Version {p.version}</span>{STATUS_BADGE[status]}<span className="text-ink-2">from {formatDate(p.effective_from)}</span></span>
                    <span className="block text-xs text-ink-2">{p.note}</span>
                    <span className="block text-xs text-ink-3">Published {formatStamp(p.created_at)}{p.created_by_name ? ` by ${p.created_by_name}` : ''}{p.withdrawn_at ? `; withdrawn ${formatStamp(p.withdrawn_at)}` : ''}</span>
                    {status !== 'in_force' && (
                      <details className="mt-1 text-xs">
                        <summary className="cursor-pointer text-ink-2">What it scores</summary>
                        <div className="mt-1 space-y-1"><ScoringRules policy={p} names={names} /><p className="text-ink-3">{describeMultipliers(p)}</p></div>
                      </details>
                    )}
                  </span>
                  {status === 'scheduled' && can('org.config') && <Button size="xs" variant="ghost" aria-label={`Withdraw version ${p.version}`} onClick={() => setWithdrawing(p)}>Withdraw</Button>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog open={Boolean(draft)} onOpenChange={(o) => { if (!o) setDraft(null); }} size="lg" title="New scoring version"
        description="It starts from the latest version. Once published it cannot be changed; until it takes effect it can be withdrawn."
        footer={<><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" disabled={!draft?.note.trim() || problems.length > 0} onClick={publish}><Save className="h-4 w-4" />Publish</Button></>}>
        {draft && content && (
          <div className="space-y-5">
            <div className="grid gap-3 sm:grid-cols-[11rem_1fr]">
              <Field label="Takes effect" required hint={`${earliest} or later`}><Input type="date" min={earliest} value={draft.effective_from} onChange={(e) => setDraft({ ...draft, effective_from: e.target.value })} /></Field>
              <Field label="Why it changes" required hint="kept with the version and in the audit trail"><Input maxLength={SCORING_LIMITS.note} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="Command policy letter 3-26" /></Field>
            </div>

            <fieldset className="space-y-2">
              <legend className="mb-1 text-base font-medium text-ink">Points by duty type</legend>
              {inUse.map((d) => {
                const r = draft.rules[d.id];
                return (
                  <div key={d.id} className="flex flex-wrap items-start gap-2 rounded-xl border border-line p-2">
                    <span className="min-w-0 flex-1 basis-36 pt-2 text-sm text-ink">{d.name}</span>
                    <Select className="w-36" aria-label={`How ${d.name} is scored`} value={r.method} onValueChange={(v) => setRule(d.id, { method: v as MethodChoice })}
                      options={[{ value: 'none', label: 'Not scored' }, ...SCORING_METHODS.map((m) => ({ value: m.key, label: m.label }))]} />
                    {r.method !== 'none' && r.method !== 'bands' && (
                      <NumberInput className="w-24" aria-label={`Points for ${d.name}`} value={r.points} onChange={(e) => setRule(d.id, { points: e.target.value })} placeholder="points" />
                    )}
                    {r.method === 'bands' && (
                      <div className="w-full space-y-1 sm:w-auto">
                        {r.bands.map((b, i) => (
                          <div key={i} className="flex items-center gap-1 text-xs text-ink-2">
                            <span>From</span>
                            <NumberInput className="w-16" aria-label={`${d.name}, length ${i + 1}, from hours`} value={b.from_hours} onChange={(e) => setRule(d.id, { bands: r.bands.map((x, j) => (j === i ? { ...x, from_hours: e.target.value } : x)) })} />
                            <span>hours:</span>
                            <NumberInput className="w-16" aria-label={`${d.name}, length ${i + 1}, points`} value={b.points} onChange={(e) => setRule(d.id, { bands: r.bands.map((x, j) => (j === i ? { ...x, points: e.target.value } : x)) })} />
                            <span>points</span>
                            {r.bands.length > 1 && <Button size="xs" variant="ghost" aria-label={`Remove ${d.name} length ${i + 1}`} onClick={() => setRule(d.id, { bands: r.bands.filter((_, j) => j !== i) })}>Remove</Button>}
                          </div>
                        ))}
                        {r.bands.length < SCORING_LIMITS.bands && <Button size="xs" variant="ghost" onClick={() => setRule(d.id, { bands: [...r.bands, { from_hours: '', points: '' }] })}><Plus className="h-3 w-3" />Add a length</Button>}
                      </div>
                    )}
                  </div>
                );
              })}
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="mb-1 text-base font-medium text-ink">Multipliers</legend>
              <p className="text-xs text-ink-3">Applied to the points when the duty falls on one of these. Duty records say which apply.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {SCORING_CONDITIONS.map((c) => {
                  const m = draft.multipliers[c.key];
                  const set = (patch: Partial<typeof m>) => setDraft({ ...draft, multipliers: { ...draft.multipliers, [c.key]: { ...m, ...patch } } });
                  return (
                    <div key={c.key} className="flex items-center gap-2">
                      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink"><input type="checkbox" checked={m.on} onChange={(e) => set({ on: e.target.checked })} />{c.label}</label>
                      <span className="text-xs text-ink-3" aria-hidden>×</span>
                      <NumberInput className="w-20" aria-label={`${c.label} multiplier`} disabled={!m.on} value={m.factor} onChange={(e) => set({ factor: e.target.value })} />
                    </div>
                  );
                })}
              </div>
              <Field label="When several apply" className="sm:w-72"><Select value={draft.combine} onValueChange={(v) => setDraft({ ...draft, combine: v as ScoringCombine })} options={SCORING_COMBINE.map((c) => ({ value: c.key, label: c.label }))} /></Field>
            </fieldset>

            {problems.length > 0 && (
              <ul aria-live="polite" aria-label="Before it can be published" className="space-y-0.5 text-xs text-bad">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            )}

            <fieldset className="space-y-2 rounded-xl border border-line p-3">
              <legend className="px-1 text-base font-medium text-ink">Try it</legend>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Duty" className="w-48"><Select value={trial.duty_type_id || inUse[0]?.id} onValueChange={(v) => setTrial({ ...trial, duty_type_id: v })} options={inUse.map((d) => ({ value: d.id, label: d.name }))} /></Field>
                <Field label="Hours" className="w-20"><NumberInput value={trial.hours} onChange={(e) => setTrial({ ...trial, hours: e.target.value })} /></Field>
                <Field label="Days" className="w-20"><NumberInput value={trial.days} onChange={(e) => setTrial({ ...trial, days: e.target.value })} /></Field>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {SCORING_CONDITIONS.map((c) => (
                  <label key={c.key} className="flex items-center gap-1.5 text-xs text-ink-2"><input type="checkbox" checked={trial.conditions.includes(c.key)} onChange={(e) => setTrial({ ...trial, conditions: e.target.checked ? [...trial.conditions, c.key] : trial.conditions.filter((x) => x !== c.key) })} />{c.label}</label>
                ))}
              </div>
              {tried && <p className="text-sm text-ink" aria-live="polite" data-testid="scoring-trial">
                {!tried.rule ? 'Not scored: 0 points.'
                  : <><span className="fig font-medium">{tried.points} points</span><span className="text-ink-2">{tried.factor !== 1 ? ` (${tried.base} × ${tried.factor}, ${tried.applied.map(conditionLabel).join(' and ')})` : ''}</span></>}
              </p>}
            </fieldset>
          </div>
        )}
      </Dialog>

      <ConfirmDialog open={Boolean(withdrawing)} onOpenChange={(o) => { if (!o) setWithdrawing(null); }} title={`Withdraw version ${withdrawing?.version ?? ''}?`} confirmLabel="Withdraw"
        body={`It was to take effect ${withdrawing ? formatDate(withdrawing.effective_from) : ''}. It stays on the record as withdrawn, and duty on and after that day is scored under the version before it.`}
        onConfirm={async () => { if (withdrawing && await act(`Version ${withdrawing.version} withdrawn.`, () => api.orgWithdrawScoringPolicy(org.id, withdrawing.id), refresh)) setWithdrawing(null); }} />
    </Panel>
  );
}

// ——— Training ———

type RequirementDraft = { id?: string; title: string; type: string; course_code: string; interval_months: string; unit_id: string; description: string };
const recurs = (m: number | null) => (!m ? 'Once' : m % 12 === 0 ? (m === 12 ? 'Every year' : `Every ${m / 12} years`) : `Every ${m} months`);

export function Training({ org }: { org: OrgSummary }) {
  const can = (p: string) => org.permissions.includes(p);
  const qc = useQueryClient();
  const act = useAct();
  const { data, isPending, error, refetch } = useConfiguration(org.id);
  const units = useUnits(org.id);
  const [editing, setEditing] = useState<RequirementDraft | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id] });
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const active = (units.data?.units ?? []).filter((u) => u.active);
  const save = async () => {
    if (!editing) return;
    const body = { title: editing.title, type: editing.type, course_code: editing.course_code || null, interval_months: editing.interval_months ? Number(editing.interval_months) : null, unit_id: editing.unit_id || null, description: editing.description || null };
    const r = await act(editing.id ? 'Requirement saved.' : 'Requirement added.', () => api.orgSaveTrainingRequirement(org.id, body, editing.id), refresh);
    if (r) setEditing(null);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="max-w-2xl text-sm text-ink-2">The training this Unit Instance requires, in one unit and the units beneath it or in every unit. Vantage does not check anyone’s training against it yet.</p>
        {can('org.config') && <Button className="ml-auto" size="sm" variant="primary" onClick={() => setEditing({ title: '', type: 'training', course_code: '', interval_months: '12', unit_id: '', description: '' })}><Plus className="h-4 w-4" />New requirement</Button>}
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        {!data.trainingRequirements.length ? <EmptyState icon={GraduationCap} title="No training requirements yet" description="Add the courses, qualifications and annual training your Marines must hold." /> : (
          <Table minWidth={760} head={<><th>Requirement</th><th className="w-32">Kind</th><th className="w-32">Recurs</th><th className="w-40">Applies to</th><th className="w-24">Status</th><th className="relative w-40"><span className="sr-only">Actions</span></th></>}>
            {data.trainingRequirements.map((t) => (
              <tr key={t.id}>
                <td><span className="block text-sm font-medium text-ink">{t.title}</span><span className="block text-xs text-ink-3">{[t.course_code, t.description].filter(Boolean).join(' · ')}</span></td>
                <td className="text-xs text-ink-2">{humanize(t.type)}</td>
                <td className="text-xs text-ink-2">{recurs(t.interval_months)}</td>
                <td className="text-xs text-ink-2">{t.unit_id ? unitName(units.data?.units ?? [], t.unit_id) : 'Every unit'}</td>
                <td><StatusBadge active={t.active} /></td>
                <td className="text-right">{can('org.config') && <span className="flex justify-end gap-1">
                  {t.active ? <Button size="xs" variant="ghost" aria-label={`Edit ${t.title}`} onClick={() => setEditing({ id: t.id, title: t.title, type: t.type, course_code: t.course_code || '', interval_months: t.interval_months ? String(t.interval_months) : '', unit_id: t.unit_id || '', description: t.description || '' })}>Edit</Button> : null}
                  {t.active
                    ? <Button size="xs" variant="ghost" aria-label={`Retire ${t.title}`} onClick={() => act('Requirement retired.', () => api.orgSaveTrainingRequirement(org.id, { active: false }, t.id), refresh)}>Retire</Button>
                    : <Button size="xs" variant="ghost" aria-label={`Restore ${t.title}`} onClick={() => act('Requirement restored.', () => api.orgSaveTrainingRequirement(org.id, { active: true }, t.id), refresh)}><RotateCcw className="h-3 w-3" />Restore</Button>}
                </span>}</td>
              </tr>
            ))}
          </Table>
        )}
      </div>
      <Dialog open={Boolean(editing)} onOpenChange={(o) => { if (!o) setEditing(null); }} size="sm" title={editing?.id ? `Edit ${editing.title}` : 'New training requirement'}
        footer={<><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" disabled={!editing?.title.trim()} onClick={save}><Save className="h-4 w-4" />Save</Button></>}>
        {editing && (
          <div className="space-y-3">
            <Field label="Title" required><Input autoFocus maxLength={120} value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Annual Cyber Awareness" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Kind"><Select value={editing.type} onValueChange={(v) => setEditing({ ...editing, type: v })} options={data.catalog.trainingTypes.map((t) => ({ value: t, label: humanize(t) }))} /></Field>
              <Field label="Course code" hint="optional"><Input maxLength={40} className="mono" value={editing.course_code} onChange={(e) => setEditing({ ...editing, course_code: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Recurs every" hint="months; empty for once"><NumberInput min={1} max={120} value={editing.interval_months} onChange={(e) => setEditing({ ...editing, interval_months: e.target.value })} /></Field>
              <Field label="Applies to"><Select value={editing.unit_id || NONE} onValueChange={(v) => setEditing({ ...editing, unit_id: v === NONE ? '' : v })} options={[{ value: NONE, label: 'Every unit' }, ...unitOptions(active)]} /></Field>
            </div>
            <Field label="Description" hint="optional"><Textarea rows={2} maxLength={300} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} /></Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}

// ——— Work and reports ———

export function WorkAndReports({ org }: { org: OrgSummary }) {
  const can = (p: string) => org.permissions.includes(p);
  const qc = useQueryClient();
  const act = useAct();
  const { data, isPending, error, refetch } = useConfiguration(org.id);
  const [hours, setHours] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodKey | null>(null);
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <Failed error={error} retry={() => refetch()} />;
  const limit = data.limits.claimExpiryHours;
  const shownHours = hours ?? String(data.settings.work.claimExpiryHours);
  const shownPeriod = period ?? data.settings.reports.defaultPeriod;
  const n = Number(shownHours);
  const valid = Number.isInteger(n) && n >= limit.min && n <= limit.max;
  // Each panel saves its own setting and leaves the other's unsaved change as it is.
  const save = (body: unknown, label: string, saved: () => void) => act(label, () => api.orgSaveUnitSettings(org.id, body), () => { saved(); qc.invalidateQueries({ queryKey: ['org', org.id] }); });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Work queue" subtitle="The cases your units work from a queue, financial management work among them.">
        <Field label="A claim lapses after" hint={`hours untouched: ${limit.min} to ${limit.max}; ${limit.default} unless you change it`} error={valid ? null : `Between ${limit.min} and ${limit.max} hours.`}>
          <NumberInput min={limit.min} max={limit.max} disabled={!can('org.config')} value={shownHours} onChange={(e) => setHours(e.target.value)} className="w-28" />
        </Field>
        <p className="mt-2 text-xs text-ink-3">When nobody touches a claimed case for this long, the claim is released and the case goes back to the queue, so the work does not wait on someone who has moved on. The case history and the audit trail record it.</p>
        {can('org.config') && <Button className="mt-3" variant="primary" disabled={!valid || n === data.settings.work.claimExpiryHours} onClick={() => save({ work: { claimExpiryHours: n } }, 'Saved. The next sweep uses it.', () => setHours(null))}><Save className="h-4 w-4" />Save</Button>}
      </Panel>
      <Panel title="Reports" subtitle="Where Reports and Records open for your Marines.">
        <Field label="Default period"><Select value={shownPeriod} disabled={!can('org.config')} onValueChange={(v) => setPeriod(v as PeriodKey)} options={data.catalog.periods.map((p) => ({ value: p.value, label: p.label }))} /></Field>
        <p className="mt-2 text-xs text-ink-3">For the members whose primary unit is in this Unit Instance, until they choose a period themselves. It decides where a page opens, never what anyone can see.</p>
        {can('org.config') && <Button className="mt-3" variant="primary" disabled={shownPeriod === data.settings.reports.defaultPeriod} onClick={() => save({ reports: { defaultPeriod: shownPeriod } }, 'Saved.', () => setPeriod(null))}><Save className="h-4 w-4" />Save</Button>}
      </Panel>
      {!can('org.config') && <p className="text-xs text-ink-3 lg:col-span-2">Your Unit Instance role shows these settings; a Unit Manager changes them.</p>}
    </div>
  );
}

// ——— Imports and exports ———

type Outcome = 'add' | 'restore' | 'exists' | 'skip';
interface ImportPlan { applied?: boolean; lines: Array<{ kind: string; label: string; outcome: Outcome; reason?: string }>; counts: Record<Outcome, number> }
const OUTCOME: Record<Outcome, { label: string; tone: 'good' | 'accent' | 'neutral' | 'warn' }> = {
  add: { label: 'Adds', tone: 'good' }, restore: { label: 'Restores', tone: 'accent' }, exists: { label: 'Already here', tone: 'neutral' }, skip: { label: 'Skipped', tone: 'warn' },
};
const CONFIG_FILE_MAX = 2 * 1024 * 1024;

function Row({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return <li className="flex flex-wrap items-center justify-between gap-2 py-2.5"><span className="min-w-0 flex-1 basis-48"><span className="block text-sm font-medium text-ink">{title}</span><span className="block text-xs text-ink-3">{hint}</span></span>{children}</li>;
}

export function ImportsExports({ org }: { org: OrgSummary }) {
  const can = (p: string) => org.permissions.includes(p);
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState('');
  const [file, setFile] = useState<{ name: string; body: unknown } | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  // Each file chosen gets a number; a plan that comes back for an earlier one is dropped.
  const picks = useRef(0);
  const slug = org.id.toLowerCase();
  const download = async (key: string, url: string, name: string) => {
    setBusy(key);
    try { const n = await withSudo(() => api.downloadFile(url, name)); toast.success(`Downloaded ${n}. The download is in the audit trail.`); }
    catch (e) { toast.error(api.errorText(e)); } finally { setBusy(''); }
  };
  const choose = async (picked: File | undefined) => {
    const pick = ++picks.current;
    setPlan(null); setFile(null);
    if (!picked) return;
    if (picked.size > CONFIG_FILE_MAX) { toast.error('A configuration file is 2 MB at most.'); return; }
    let body: unknown;
    try { body = JSON.parse(await picked.text()); } catch { if (pick === picks.current) toast.error('That file is not a Vantage configuration file.'); return; }
    if (pick !== picks.current) return;
    setFile({ name: picked.name, body });
    setBusy('plan');
    try { const planned = await withSudo(() => api.orgImportConfiguration(org.id, body, false)) as ImportPlan; if (pick === picks.current) setPlan(planned); }
    catch (e) { if (pick === picks.current) { toast.error(api.errorText(e)); setFile(null); } } finally { if (pick === picks.current) setBusy(''); }
  };
  const apply = async () => {
    if (!file) return;
    setBusy('apply');
    try {
      const done = await withSudo(() => api.orgImportConfiguration(org.id, file.body, true)) as ImportPlan;
      toast.success(`Imported: ${done.counts.add} added, ${done.counts.restore} restored.`);
      setPlan(null); setFile(null); qc.invalidateQueries({ queryKey: ['org', org.id] });
    } catch (e) { toast.error(api.errorText(e)); } finally { setBusy(''); }
  };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title="Exports" subtitle="Each download is recorded in the audit trail. None holds what Marines recorded: that is exported from a unit in the app, by those whose unit role allows it.">
        {!can('org.export') && !can('org.audit') ? <p className="text-sm text-ink-3">Your Unit Instance role exports nothing.</p> : (
          <ul className="divide-y divide-line">
            {can('org.export') && <>
              <Row title="Structure" hint="Units, unit roles, members and who holds which role. JSON."><Button size="sm" loading={busy === 'structure'} onClick={() => download('structure', api.orgExportUrl(org.id), `vantage-${slug}.json`)}><Download className="h-4 w-4" />Structure</Button></Row>
              <Row title="Roster" hint="Each member’s units, billets and roles, for a spreadsheet. No EDIPI or email address. CSV."><Button size="sm" loading={busy === 'roster'} onClick={() => download('roster', api.orgRosterUrl(org.id), `vantage-${slug}-roster.csv`)}><Download className="h-4 w-4" />Roster</Button></Row>
              <Row title="Configuration" hint="Billets, duty types, training requirements and settings, to keep or to load into another Unit Instance. JSON."><Button size="sm" loading={busy === 'configuration'} onClick={() => download('configuration', api.orgConfigurationExportUrl(org.id), `vantage-${slug}-configuration.json`)}><Download className="h-4 w-4" />Configuration</Button></Row>
            </>}
            {can('org.audit') && <Row title="Audit trail" hint="Filtered by date, action or unit, as CSV or JSON."><Button size="sm" asChild><Link to={`/${org.id}/audit`}>Open the audit trail</Link></Button></Row>}
          </ul>
        )}
      </Panel>
      <Panel title="Imports" subtitle="Each one shows what it would do first, and changes nothing until you apply it.">
        {!can('org.members') && !can('org.personnel') && !can('org.config') ? <p className="text-sm text-ink-3">Your Unit Instance role imports nothing.</p> : (
          <ul className="divide-y divide-line">
            {can('org.members') && <Row title="Accounts" hint="A roster spreadsheet: one account and unit per Marine."><AccountImport orgId={org.id} onDone={() => qc.invalidateQueries({ queryKey: ['org', org.id] })} /></Row>}
            {can('org.personnel') && <Row title="Personnel feed" hint="The roster extract that keeps names, ranks and EAS dates current."><Button size="sm" asChild><Link to={`/${org.id}/personnel`}>Open the personnel feed</Link></Button></Row>}
            {can('org.config') && (
              <li className="py-2.5">
                <span className="block text-sm font-medium text-ink">Configuration</span>
                <span className="block text-xs text-ink-3">A configuration file exported from Vantage. It adds what is missing and never removes or renames what you have; anything naming a unit outside this Unit Instance is skipped.</span>
                <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm hover:border-line-strong focus-within:ring-2 focus-within:ring-accent">
                  <FileUp className="h-4 w-4" aria-hidden />{file ? file.name : 'Choose a configuration file'}
                  <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {busy === 'plan' && <Skeleton className="mt-2 h-16" />}
                {plan && (
                  <div className="mt-3 space-y-2" role="status" aria-label="Import plan">
                    <p className="text-sm text-ink">{plan.counts.add} to add · {plan.counts.restore} to restore · {plan.counts.exists} already here · {plan.counts.skip} skipped</p>
                    <ul className="max-h-56 space-y-1 overflow-y-auto">{plan.lines.map((l, i) => <li key={i} className="flex items-start gap-2 text-xs"><Badge tone={OUTCOME[l.outcome].tone}>{OUTCOME[l.outcome].label}</Badge><span className="text-ink-2">{humanize(l.kind)}: {l.label}{l.reason ? <span className="text-ink-3"> ({l.reason})</span> : null}</span></li>)}</ul>
                    <span className="flex gap-2"><Button size="sm" variant="ghost" onClick={() => { setPlan(null); setFile(null); }}>Cancel</Button><Button size="sm" variant="primary" disabled={!plan.counts.add && !plan.counts.restore} loading={busy === 'apply'} onClick={apply}>Apply</Button></span>
                  </div>
                )}
              </li>
            )}
          </ul>
        )}
      </Panel>
    </div>
  );
}

// ——— Enterprise-controlled settings, read-only ———

/** What Vantage decides for every Unit Instance, so a Unit Manager sees where their own settings stop (§19). */
export function EnterpriseControlsPanel({ orgId }: { orgId: string }) {
  const { data, error } = useConfiguration(orgId);
  if (error) return null;
  if (!data) return <Skeleton className="h-40" />;
  const e = data.enterprise;
  const onOff = (b: boolean) => (b ? 'On' : 'Off');
  const rows: Array<[string, string]> = [
    ['Vantage version', e.version],
    ['CAC sign-in', e.signIn.cacRequired ? 'Required' : onOff(e.signIn.cac)],
    ['Organization sign-in', onOff(e.signIn.organizationSignIn)],
    ['Passwords', e.signIn.passwords ? 'Accepted' : 'Not accepted'],
    ['Idle sign-out', `${e.sessions.idleMinutes} min in the app, ${e.sessions.consoleIdleMinutes} min in the consoles`],
    ['Longest session', `${e.sessions.absoluteHours} hours`],
    ['Confirm again for sensitive changes', `every ${e.sessions.reconfirmMinutes} min`],
    ['Attachments', e.attachments.enabled ? `Up to ${e.attachments.maxMegabytes} MB, ${e.attachments.types} file types` : 'Off'],
    ['Audit trail', `${e.audit.tamperEvident ? 'Tamper-evident, always on' : 'Always on'}${e.audit.forwarded ? ', copied to the enterprise log' : ''}`],
    ['AI assistance', onOff(e.features.ai)],
    ['Email', onOff(e.features.email)],
    ['MARADMIN feed', onOff(e.features.maradmins)],
  ];
  return (
    <Panel title="Set by Vantage" subtitle="These apply to every Unit Instance. Vantage Administrators set them; no Unit Instance role changes them.">
      <dl className="space-y-1.5 text-sm">{rows.map(([k, v]) => <div key={k} className="flex justify-between gap-3"><dt className="text-ink-3">{k}</dt><dd className="text-right text-ink">{v}</dd></div>)}</dl>
    </Panel>
  );
}
