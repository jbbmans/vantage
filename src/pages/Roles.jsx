import React, { useEffect, useMemo, useState } from 'react';
import { Shield, Plus, Trash2, Lock, ChevronDown, ChevronRight, Info } from 'lucide-react';
import * as apiClient from '@/lib/api';
import { useOrg, useIdentity, unitOptions, unitPath, hydrate } from '@/store/useStore';
import { useToast } from '@/components/ui/toast';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { Panel, PageHeader, EmptyState, Button, Input, Field, Select, Badge, Textarea, Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { errorText } from '@/lib/api';

const SWATCHES = ['#8D98A8', '#3DD68C', '#F0A93B', '#4C9DFF', '#A78BFA', '#FB7185', '#22D3EE', '#FACC15'];

/**
 * Roles.
 *
 * Permissions are bits and roles are rows, so a command can describe itself
 * instead of bending to fit three hard-coded levels. A Training NCO who should
 * see everyone's PME but nobody's fiscal work is two checkboxes here rather
 * than a schema change.
 *
 * Two rules make this safe, and both are enforced server-side as well:
 * you cannot touch a role at or above your own, and you cannot grant a
 * permission you do not hold.
 */
export default function Roles() {
  const org = useOrg();
  const identity = useIdentity();
  const toast = useToast();

  const [state, setState] = useState({ roles: [], catalogue: [], topPosition: 0 });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [roleErrors, setRoleErrors] = useState({});
  const [deleting, setDeleting] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = async () => {
    setLoading(true);
    try { setState(await apiClient.roles()); }
    catch (err) { toast.error(errorText(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const grouped = useMemo(() => {
    const map = {};
    for (const p of state.catalogue) (map[p.group] ||= []).push(p);
    return map;
  }, [state.catalogue]);

  const canCreate = state.topPosition > 0;

  return (
    <div className="mx-auto max-w-4xl space-y-3">
      <PageHeader
        title="Roles"
        subtitle="Permissions are per-role and stack. A Marine can hold several."
      >
        {canCreate && (
          <Button variant="primary" size="sm" onClick={() => setEditing({ isNew: true, permissions: 1, position: 1, color: SWATCHES[0] })}>
            <Plus className="h-3.5 w-3.5" />
            New role
          </Button>
        )}
      </PageHeader>

      <Panel bodyClassName="p-0">
        {loading ? (
          <p className="px-3 py-4 text-sm text-text-3">Loading roles…</p>
        ) : (
          state.roles.map((role) => {
            const perms = state.catalogue.filter((p) => role.permissions & p.bit);
            const isOpen = expanded === role.id;
            return (
              <div key={role.id} className="border-b border-rule last:border-0">
                <div className="flex items-center gap-2.5 px-3 py-2">
                  <button
                    onClick={() => setExpanded(isOpen ? null : role.id)}
                    className="text-text-3 hover:text-text"
                    aria-label={isOpen ? 'Collapse' : 'Expand'}
                  >
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </button>

                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: role.color || '#8D98A8' }}
                    aria-hidden
                  />

                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-base text-text">{role.name}</span>
                      {role.is_system ? (
                        <Tooltip content="Built in. Copy it into a new role to change anything.">
                          <Lock className="h-2.5 w-2.5 shrink-0 text-text-3" />
                        </Tooltip>
                      ) : null}
                      {role.inherits_down ? (
                        <Tooltip content="Applies to the unit and every unit beneath it.">
                          <Badge tone="neutral" className="shrink-0">cascades</Badge>
                        </Tooltip>
                      ) : null}
                    </span>
                    <span className="block truncate text-2xs text-text-3">{role.description}</span>
                  </span>

                  <span className="fig hidden shrink-0 text-2xs text-text-3 sm:block">
                    pos {role.position}
                  </span>
                  <Badge tone="neutral" className="shrink-0">
                    {role.permissions & 2048 ? 'all' : perms.length}
                  </Badge>

                  {role.manageable && !role.is_system && (
                    <>
                      <Button variant="ghost" size="sm" onClick={() => setEditing(role)}>Edit</Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => setDeleting(role)} aria-label="Delete role">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>

                {isOpen && (
                  <div className="border-t border-rule bg-panel-2/40 px-10 py-2.5">
                    {role.permissions & 2048 ? (
                      <p className="text-xs text-redline">Every permission, in every unit.</p>
                    ) : perms.length === 0 ? (
                      <p className="text-xs text-text-3">No permissions.</p>
                    ) : (
                      <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                        {perms.map((p) => (
                          <p key={p.key} className="text-xs text-text-2">
                            <span className="text-text">{p.label}</span>
                            <span className="block text-2xs leading-relaxed text-text-3">{p.hint}</span>
                          </p>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </Panel>

      <p className="flex items-start gap-2 px-1 text-xs leading-relaxed text-text-3">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        Position is the hierarchy. You cannot create, edit or hand out a role at or above your own — otherwise anyone
        who can manage roles could make themselves an administrator. Yours is {state.topPosition}.
      </p>

      {editing && (
        <RoleDialog
          role={editing}
          groups={grouped}
          topPosition={state.topPosition}
          units={unitOptions(org.units)}
          identity={identity}
          fieldErrors={roleErrors}
          onCancel={() => { setEditing(null); setRoleErrors({}); try { sessionStorage.removeItem('vantage.draft.role'); } catch { /* fine */ } }}
          onSave={async (draft) => {
            try {
              if (draft.isNew) await apiClient.createRole(draft);
              else await apiClient.updateRole(draft.id, draft);
              toast.success(draft.isNew ? 'Role created.' : 'Role updated.');
              setEditing(null);
              setRoleErrors({});
              try { sessionStorage.removeItem('vantage.draft.role'); } catch { /* fine */ }
              await load();
              await hydrate();
            } catch (err) {
              setRoleErrors(err.fieldErrors || {});
              toast.error(errorText(err));
            }
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`Delete "${deleting?.name}"?`}
        body="Everyone holding this role loses the permissions it granted. Their records are untouched."
        confirmLabel="Delete role"
        onConfirm={async () => {
          try {
            await apiClient.deleteRole(deleting.id);
            toast.success('Role deleted.');
            await load();
            await hydrate();
          } catch (err) { toast.error(errorText(err)); }
        }}
      />
    </div>
  );
}

function RoleDialog({ role, groups, topPosition, units, identity, fieldErrors = {}, onCancel, onSave }) {
  const [draft, setDraft] = useState({
    name: '', description: '', color: SWATCHES[0], position: 1,
    permissions: 1, inherits_down: 0, unit_id: null, ...role,
  });
  // Finding 35: an in-progress role definition survives an accidental close.
  const ROLE_DRAFT = 'vantage.draft.role';
  useEffect(() => {
    if (!role?.isNew) return;
    try {
      const stored = JSON.parse(sessionStorage.getItem(ROLE_DRAFT) || 'null');
      if (stored && stored.name) setDraft((d) => ({ ...d, ...stored }));
    } catch { /* fine */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k, v) => setDraft((d) => {
    const next = { ...d, [k]: v };
    if (role?.isNew) { try { sessionStorage.setItem(ROLE_DRAFT, JSON.stringify(next)); } catch { /* fine */ } }
    return next;
  });

  const toggle = (bit) => set('permissions', draft.permissions & bit ? draft.permissions & ~bit : draft.permissions | bit);

  // You cannot hand out what you do not hold; the server refuses it too, so
  // showing an ungrantable box would just produce a confusing error.
  const held = identity?.globalPermissions || 0;
  const isAdmin = Boolean(held & 2048);

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onCancel()}
      title={draft.isNew ? 'New role' : `Edit ${role.name}`}
      description="Permissions stack across every role a Marine holds."
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => onSave(draft)} disabled={!draft.name}>
            {draft.isNew ? 'Create role' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field error={fieldErrors.name} label="Name">
            <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Accounting Chief" autoFocus />
          </Field>
          <Field error={fieldErrors.position} label="Position" hint={`Must be below yours (${topPosition}).`}>
            <Input
              type="number"
              min={0}
              max={Math.max(0, topPosition - 1)}
              value={draft.position}
              onChange={(e) => set('position', Number(e.target.value))}
            />
          </Field>
        </div>

        <Field label="Description">
          <Textarea rows={2} value={draft.description || ''} onChange={(e) => set('description', e.target.value)} />
        </Field>

        <Field label="Colour">
          <div className="flex flex-wrap gap-1.5">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set('color', c)}
                aria-label={`Colour ${c}`}
                className={cn(
                  'h-6 w-6 rounded-full border-2 transition-transform',
                  draft.color === c ? 'scale-110 border-text' : 'border-transparent'
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </Field>

        <Field label="Scope" hint="Cascading roles reach every unit beneath the one they're granted in.">
          <Select
            value={draft.inherits_down ? 'down' : 'flat'}
            onValueChange={(v) => set('inherits_down', v === 'down' ? 1 : 0)}
            options={[
              { value: 'flat', label: 'That unit only — like a fire team leader' },
              { value: 'down', label: 'That unit and everything beneath it — like a section head' },
            ]}
          />
        </Field>

        <div className="border-t border-rule pt-3">
          <p className="eyebrow mb-2">Permissions</p>
          <div className="space-y-3">
            {Object.entries(groups).map(([group, perms]) => (
              <div key={group}>
                <p className="mb-1 text-2xs uppercase tracking-wider text-text-3">{group}</p>
                <div className="space-y-1">
                  {perms.map((p) => {
                    const on = Boolean(draft.permissions & p.bit);
                    const grantable = isAdmin || Boolean(held & p.bit);
                    return (
                      <label
                        key={p.key}
                        className={cn(
                          'flex cursor-pointer items-start gap-2.5 rounded border border-rule px-2.5 py-1.5',
                          on && 'border-signal/40 bg-signal/[0.06]',
                          !grantable && 'cursor-not-allowed opacity-40'
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!grantable}
                          onChange={() => toggle(p.bit)}
                          className="mt-0.5 h-3 w-3 accent-[rgb(var(--signal))]"
                        />
                        <span className="min-w-0 flex-1">
                          <span className={cn('block text-sm', p.dangerous ? 'text-redline' : 'text-text')}>
                            {p.label}
                          </span>
                          <span className="block text-2xs leading-relaxed text-text-3">
                            {grantable ? p.hint : 'You do not hold this permission, so you cannot grant it.'}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
