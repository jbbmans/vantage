import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { UserPlus, Users, Shield, ChevronRight, Search } from 'lucide-react';
import * as apiClient from '@/lib/api';
import { useOrg, useIdentity, unitOptions, unitPath, displayName, can, PERMISSIONS } from '@/store/useStore';
import { useToast } from '@/components/ui/toast';
import { Dialog } from '@/components/ui/Dialog';
import {
  Panel, EmptyState, Button, Input, Select, Field, Badge, Tooltip,
} from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { errorText } from '@/lib/api';
import { draftKey } from '@/lib/drafts';
import Roles from '@/pages/Roles';

/**
 * The roster.
 *
 * What shows up here is decided entirely by the server — this page renders
 * whatever /api/team returns and never filters for permission itself. A
 * client-side permission check is a suggestion, not a control.
 */
export default function Team() {
  const org = useOrg();
  const identity = useIdentity();
  const toast = useToast();

  const [state, setState] = useState({ roster: [], canLead: false, scopeUnitIds: [], availableRoles: [] });
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editingTeam, setEditingTeam] = useState(null);
  const [memberErrors, setMemberErrors] = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const [teamState, roleState] = await Promise.all([
        apiClient.team(),
        apiClient.roles().catch(() => ({ roles: [] })),
      ]);
      setState({ ...teamState, availableRoles: roleState.roles || [] });
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const units = useMemo(() => unitOptions(org.units), [org.units]);
  const scopedUnits = useMemo(
    () => units.filter((u) => (state.canManageMembers || []).includes(u.id)),
    [units, state.canManageMembers]
  );
  const canManageAny = (state.canManageMembers || []).length > 0;
  const memberDraftKey = draftKey(identity?.user?.id, 'member');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.roster;
    return state.roster.filter((p) =>
      [p.last_name, p.first_name, p.rank_abbr, p.billet_title, p.unit_name, p.unit_short, p.mos]
        .some((f) => String(f || '').toLowerCase().includes(q))
    );
  }, [state.roster, query]);

  // Group by unit so a section head sees their branches, not one flat list.
  const grouped = useMemo(() => {
    const map = new Map();
    for (const p of filtered) {
      const key = p.unit_id || '__none';
      if (!map.has(key)) map.set(key, { unit: p.unit_name || 'Unassigned', short: p.unit_short, people: [] });
      map.get(key).people.push(p);
    }
    return [...map.entries()].sort((a, b) => a[1].unit.localeCompare(b[1].unit));
  }, [filtered]);

  if (!state.canLead && state.roster.length <= 1) {
    return (
      <div className="mx-auto max-w-2xl">
        <Panel title="Team">
          <EmptyState
            icon={Users}
            title="You don't hold a billet with a team"
            description="Team management appears once you're assigned as a fire team leader, section NCOIC, or above. Your own record is on the Command Center."
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="page-canvas team-page">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b border-rule pb-5">
        <div>
          <p className="eyebrow">Authorized people directory</p>
          <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">People &amp; access</h2>
          <p className="mt-1.5 text-base text-text-3">{state.roster.length} {state.roster.length === 1 ? 'person' : 'people'} across {grouped.length} visible {grouped.length === 1 ? 'unit' : 'units'}.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-3" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name, billet, unit…"
            className="w-52 pl-7"
          />
        </div>
        {canManageAny && state.canCreateAccounts && (
          <Button variant="primary" size="sm" onClick={() => setAdding(true)}>
            <UserPlus className="h-3.5 w-3.5" />
            Add Marine
          </Button>
        )}
        {canManageAny && (
          <Button variant={state.canCreateAccounts ? 'default' : 'primary'} size="sm" onClick={() => setEnrolling(true)}>
            <Users className="h-3.5 w-3.5" />
            Enroll existing
          </Button>
        )}
        </div>
      </div>

      {loading ? (
        <p className="py-12 text-center text-sm text-text-3">Loading roster…</p>
      ) : (
        <div>
          {grouped.map(([unitId, group], groupIndex) => (
            <section
              key={unitId}
              className="grid gap-4 border-b border-rule py-6 lg:grid-cols-[230px_minmax(0,1fr)] animate-fade-up"
              style={{ animationDelay: `${Math.min(groupIndex * 55, 220)}ms` }}
            >
              <div>
                <div className="flex items-center gap-2"><h3 className="text-lg font-semibold text-text">{group.unit}</h3><Badge tone="neutral">{group.people.length}</Badge></div>
                <p className="mt-1 text-xs leading-relaxed text-text-3">{unitPath(unitId).slice(0, -1).map((unit) => unit.short_name || unit.name).join(' › ') || 'Independent unit'}</p>
                {unitId !== '__none' && can(PERMISSIONS.MANAGE_ROLES, unitId) && (
                  <Button variant="ghost" size="sm" className="mt-3" onClick={() => setEditingTeam({ id: unitId, name: group.unit })}>
                    <Shield className="h-3.5 w-3.5" />
                    Edit team
                  </Button>
                )}
              </div>
              <div className="rounded-md border border-rule bg-panel">
                {group.people.map((p, personIndex) => (
                  <div
                    key={p.id}
                    className="row flex items-center gap-3 px-3 py-3 animate-fade-up"
                    style={{ animationDelay: `${Math.min((groupIndex * 2 + personIndex) * 28, 280)}ms` }}
                  >
                <Link to={`/team/${p.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <span className="fig w-14 shrink-0 text-xs text-signal">{p.rank_abbr || '—'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base text-text">
                      {p.last_name}, {p.first_name} {p.middle_initial || ''}
                    </span>
                    <span className="block truncate text-2xs text-text-3">
                      {[p.billet_title, p.mos && `MOS ${p.mos}`].filter(Boolean).join(' · ') || 'No billet assigned'}
                    </span>
                  </span>
                </Link>

                {(p.roles || []).filter((r) => r.id !== 'marine').slice(0, 2).map((r) => (
                  <span
                    key={`${r.id}-${r.unit_id}`}
                    className="hidden shrink-0 items-center gap-1 rounded-sm border border-rule px-1.5 py-0.5 text-2xs text-text-2 sm:flex"
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: r.color || '#8D98A8' }} />
                    {r.name}
                  </span>
                ))}
                {(state.canManageMembers || []).includes(p.unit_id) && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                    Reassign
                  </Button>
                )}
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-3" />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {adding && (
        <MemberDialog
          title="Add a Marine"
          units={scopedUnits}
          billets={org.billets}
          ranks={org.ranks}
          roles={state.availableRoles}
          draftStorageKey={memberDraftKey}
          fieldErrors={memberErrors}
          onCancel={() => { setAdding(false); setMemberErrors({}); try { sessionStorage.removeItem(memberDraftKey); } catch { /* fine */ } }}
          onSave={async (draft) => {
            try {
              await apiClient.addMember(draft);
              toast.success(`${draft.last_name} added.`);
              setAdding(false);
              setMemberErrors({});
              try { sessionStorage.removeItem(memberDraftKey); } catch { /* fine */ }
              load();
            } catch (err) {
              setMemberErrors(err.fieldErrors || {});
              toast.error(errorText(err));
            }
          }}
        />
      )}

      {enrolling && (
        <EnrollExistingDialog
          units={scopedUnits}
          onCancel={() => setEnrolling(false)}
          onDone={() => { setEnrolling(false); load(); }}
        />
      )}

      {editing && (
        <MemberDialog
          title={`Reassign ${displayName(editing)}`}
          units={scopedUnits}
          billets={org.billets}
          ranks={org.ranks}
          roles={state.availableRoles}
          initial={{ unit_id: editing.unit_id, role_id: '' }}
          assignmentOnly
          fieldErrors={memberErrors}
          onCancel={() => { setEditing(null); setMemberErrors({}); }}
          onSave={async (draft) => {
            try {
              await apiClient.reassign(editing.id, draft);
              if (draft.role_id) {
                await apiClient.grantRole(editing.id, { role_id: draft.role_id, unit_id: draft.unit_id });
              }
              toast.success('Assignment updated.');
              setEditing(null);
              setMemberErrors({});
              load();
            } catch (err) {
              setMemberErrors(err.fieldErrors || {});
              toast.error(errorText(err));
            }
          }}
        />
      )}

      {editingTeam && (
        <Dialog
          open
          onOpenChange={(open) => !open && setEditingTeam(null)}
          title={`Edit ${editingTeam.name}`}
          description="Roles, permissions, and hierarchy belong to this team. Changes apply only inside this exact unit."
          size="xl"
          footer={<Button variant="primary" size="sm" onClick={() => setEditingTeam(null)}>Done</Button>}
        >
          <Roles embeddedUnit={editingTeam.id} />
        </Dialog>
      )}
    </div>
  );
}

function EnrollExistingDialog({ units, onCancel, onDone }) {
  const toast = useToast();
  const [unitId, setUnitId] = useState(units[0]?.id || '');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [kind, setKind] = useState('member');
  const [expiry, setExpiry] = useState(() => new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);

  const search = async () => {
    if (query.trim().length < 2 || !unitId) return;
    setBusy(true);
    try {
      const data = await apiClient.searchDirectory(unitId, query.trim());
      setResults(data.results || []);
    } catch (err) { toast.error(errorText(err)); }
    finally { setBusy(false); }
  };

  const enroll = async (person) => {
    setBusy(true);
    try {
      await apiClient.enrollExistingMember(unitId, {
        user_id: person.id,
        kind,
        expires_at: kind === 'guest' ? `${expiry}T23:59:59.000Z` : null,
      });
      toast.success(`${person.rank_abbr || ''} ${person.last_name} enrolled.`.trim());
      onDone();
    } catch (err) { toast.error(errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title="Enroll an existing account"
      description="Search is prefix-only and audited. Account creation remains an Instance Operator action."
      footer={<Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}
    >
      <div className="space-y-3">
        <Field label="Destination unit">
          <Select
            value={unitId}
            onValueChange={(value) => { setUnitId(value); setResults([]); }}
            options={units.map((u) => ({ value: u.id, label: `${'  '.repeat(u.depth || 0)}${u.short_name || u.name}` }))}
          />
        </Field>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Membership">
            <Select
              value={kind}
              onValueChange={setKind}
              options={[{ value: 'member', label: 'Member' }, { value: 'guest', label: 'Temporary guest' }]}
            />
          </Field>
          {kind === 'guest' && (
            <Field label="Guest expiry" hint="Maximum 30 days by default">
              <Input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
            </Field>
          )}
        </div>
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            placeholder="Username or last-name prefix"
            autoComplete="off"
          />
          <Button size="sm" onClick={search} disabled={busy || query.trim().length < 2}>Search</Button>
        </div>
        <div className="divide-y divide-rule rounded border border-rule">
          {results.map((person) => (
            <div key={person.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text">{person.rank_abbr || '—'} {person.last_name}, {person.first_name}</p>
                <p className="fig truncate text-2xs text-text-3">{person.username}</p>
              </div>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => enroll(person)}>Enroll</Button>
            </div>
          ))}
          {!busy && query.trim().length >= 2 && results.length === 0 && (
            <p className="px-3 py-3 text-sm text-text-3">No eligible account found. The Instance Operator may need to create it first.</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Shared create/reassign form. Billet choice pre-selects the role it implies. */
function MemberDialog({ title, units, billets, ranks, roles = [], initial = {}, assignmentOnly, draftStorageKey, fieldErrors = {}, onCancel, onSave }) {
  const [draft, setDraft] = useState({
    username: '', password: '', first_name: '', last_name: '', middle_initial: '',
    rank_id: '', mos: '', email: '', eas: '',
    unit_id: units[0]?.id || '', billet_id: '', role_id: '', ...initial,
  });
  // Finding 35: a half-filled member form survives a dropped connection or an
  // accidental Escape. Mirrors to sessionStorage while creating; an explicit
  // Cancel or a successful save clears it (the parent owns the clearing).
  const MEMBER_DRAFT = draftStorageKey || draftKey('unknown', 'member');
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (assignmentOnly || initial.id) return;
    try {
      const stored = JSON.parse(sessionStorage.getItem(MEMBER_DRAFT) || 'null');
      if (stored && (stored.first_name || stored.last_name || stored.username)) {
        setDraft((d) => ({ ...d, ...stored }));
        setRestored(true);
      }
    } catch { /* corrupt or blocked */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k) => (v) => setDraft((d) => {
    const next = { ...d, [k]: v?.target ? v.target.value : v };
    if (!assignmentOnly) {
      try { sessionStorage.setItem(MEMBER_DRAFT, JSON.stringify({ ...next, password: '' })); } catch { /* fine */ }
    }
    return next;
  });

  // Finding 9, Option A: a billet is an organizational position only. Picking
  // one pre-fills the role suggestion below, and that grant — never the billet
  // — is what carries permissions. The server writes no role on assignments.
  const BILLET_ROLE = { team_lead: 'fire-team-leader', unit_leader: 'unit-leader', member: '' };
  const pickBillet = (billetId) => {
    const billet = billets.find((b) => b.id === billetId);
    const suggestedTemplate = BILLET_ROLE[billet?.default_role];
    setDraft((d) => {
      const suggestedRole = suggestedTemplate
        ? roles.find((role) => role.unit_id === d.unit_id && (role.template_key === suggestedTemplate || role.id === suggestedTemplate))
        : null;
      return { ...d, billet_id: billetId, role_id: suggestedRole?.id || '' };
    });
  };

  const byCategory = billets.reduce((acc, b) => {
    (acc[b.category] ||= []).push(b);
    return acc;
  }, {});

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onCancel()}
      title={title}
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => onSave(draft)}>Save</Button>
        </>
      }
    >
      <div className="space-y-3">
        {restored && (
          <p className="rounded border border-signal/40 bg-signal/[0.08] px-2.5 py-1.5 text-2xs leading-relaxed text-text-2">
            Unsaved draft restored — it was never sent to the server. Cancel discards it.
          </p>
        )}
        {!assignmentOnly && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field error={fieldErrors.first_name} label="First name"><Input value={draft.first_name} onChange={set('first_name')} autoFocus /></Field>
              <Field error={fieldErrors.last_name} label="Last name"><Input value={draft.last_name} onChange={set('last_name')} /></Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field error={fieldErrors.rank_id} label="Rank">
                <Select
                  value={draft.rank_id}
                  onValueChange={set('rank_id')}
                  placeholder="Select"
                  options={ranks.map((r) => ({ value: r.id, label: `${r.abbr} · ${r.grade}` }))}
                />
              </Field>
              <Field error={fieldErrors.mos} label="MOS"><Input value={draft.mos} onChange={set('mos')} placeholder="3451" /></Field>
              <Field error={fieldErrors.eas} label="EAS"><Input type="date" value={draft.eas} onChange={set('eas')} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field error={fieldErrors.username} label="Username"><Input value={draft.username} onChange={set('username')} autoComplete="off" /></Field>
              <Field error={fieldErrors.password} label="Temporary password" hint="15 characters minimum">
                <Input type="password" value={draft.password} onChange={set('password')} autoComplete="new-password" />
              </Field>
            </div>
          </>
        )}

        <Field error={fieldErrors.unit_id} label="Unit">
          <Select
            value={draft.unit_id}
            onValueChange={(value) => setDraft((current) => ({ ...current, unit_id: value, role_id: '' }))}
            options={units.map((u) => ({
              value: u.id,
              label: `${'\u00A0\u00A0'.repeat(u.depth)}${u.short_name || u.name}`,
            }))}
          />
        </Field>

        <Field label="Billet">
          <Select
            value={draft.billet_id}
            onValueChange={pickBillet}
            placeholder="No billet"
            options={[
              { value: '', label: 'No billet' },
              ...Object.entries(byCategory).flatMap(([cat, items]) =>
                items.map((b) => ({ value: b.id, label: `${cat} — ${b.title}` }))
              ),
            ]}
          />
        </Field>

        <Field
          label="Role"
          hint="Everyone gets Marine automatically; picking a billet only pre-fills this suggestion. The role grant here is the sole thing that carries permissions — the billet itself grants nothing."
        >
          <Select
            value={draft.role_id || ''}
            onValueChange={set('role_id')}
            placeholder="Marine only"
            options={[
              { value: '', label: 'Marine only' },
              ...roles
                .filter((r) => r.unit_id === draft.unit_id && r.template_key !== 'marine' && r.id !== 'marine')
                .map((r) => ({ value: r.id, label: r.name })),
            ]}
          />
        </Field>
      </div>
    </Dialog>
  );
}
