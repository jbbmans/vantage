import React, { useEffect, useMemo, useState } from 'react';
import { Shield, Plus, Trash2, Lock, ChevronDown, ChevronRight, Info } from 'lucide-react';
import * as apiClient from '@/lib/api';
import { useOrg, useIdentity, unitOptions, hydrate } from '@/store/useStore';
import { useToast } from '@/components/ui/toast';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { Panel, PageHeader, EmptyState, Button, Input, Field, Select, Badge, Textarea, Tooltip } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { errorText } from '@/lib/api';
import { draftKey } from '@/lib/drafts';

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

  const [state, setState] = useState({ roles: [], catalogue: [], topPosition: 0, positions: {} });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [roleErrors, setRoleErrors] = useState({});
  const [deleting, setDeleting] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [selectedUnit, setSelectedUnit] = useState('');

  const load = async () => {
    setLoading(true);
    try { setState(await apiClient.roles()); }
    catch (err) { toast.error(errorText(err)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const roleUnitOptions = useMemo(() => {
    const unitIds = [...new Set(state.roles.map((role) => role.unit_id).filter(Boolean))];
    return unitIds.map((unitId) => ({ value: unitId, label: unitLabel(unitId, org.units) }));
  }, [state.roles, org.units]);

  useEffect(() => {
    if (!roleUnitOptions.length) return;
    if (roleUnitOptions.some((option) => option.value === selectedUnit)) return;
    const primary = identity?.assignments?.find((assignment) => assignment.is_primary)?.unit_id;
    setSelectedUnit(roleUnitOptions.some((option) => option.value === primary) ? primary : roleUnitOptions[0].value);
  }, [roleUnitOptions, selectedUnit, identity]);

  const grouped = useMemo(() => {
    const map = {};
    for (const p of state.catalogue) (map[p.group] ||= []).push(p);
    return map;
  }, [state.catalogue]);

  const visibleRoles = state.roles.filter((role) => role.unit_id === selectedUnit);
  const selectedPosition = state.positions?.[selectedUnit] || 0;
  const canCreate = selectedPosition > 0;
  const roleDraftKey = draftKey(identity?.user?.id, 'role');

  return (
    <div className="mx-auto max-w-5xl space-y-3">
      <PageHeader
        title="Roles"
        subtitle="One exact unit at a time. Permissions stack only inside the unit where they are granted."
      >
        {roleUnitOptions.length > 0 && (
          <Select value={selectedUnit} onValueChange={(value) => { setSelectedUnit(value); setExpanded(null); }} options={roleUnitOptions} className="w-48" aria-label="Role unit" />
        )}
        {canCreate && (
          <Button variant="primary" size="sm" onClick={() => setEditing({ isNew: true, permissions: 1, position: 1, color: SWATCHES[0], unit_id: selectedUnit })}>
            <Plus className="h-3.5 w-3.5" />
            New role
          </Button>
        )}
      </PageHeader>

      <Panel bodyClassName="p-0">
        {loading ? (
          <p className="px-3 py-4 text-sm text-text-3">Loading roles…</p>
        ) : (
          visibleRoles.length === 0 ? (
            <EmptyState icon={Shield} title="No roles in this unit" description="Choose another unit or create the first unit-specific role." />
          ) : visibleRoles.map((role) => {
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
                        <Tooltip content="Started from a template. It is your unit's copy — rename, re-permission or delete it freely.">
                          <Badge tone="neutral" className="shrink-0">from template</Badge>
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

                  {role.manageable && (
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
        Position is the hierarchy inside {unitLabel(selectedUnit, org.units)}. You cannot create, edit, or hand out a role at or above your own. Your position here is {selectedPosition || 'not assigned'}.
      </p>

      {editing && (
        <RoleDialog
          role={editing}
          groups={grouped}
          topPosition={state.topPosition}
          positions={state.positions}
          units={unitOptions(org.units)}
          identity={identity}
          fieldErrors={roleErrors}
          draftStorageKey={roleDraftKey}
          onCancel={() => { setEditing(null); setRoleErrors({}); try { sessionStorage.removeItem(roleDraftKey); } catch { /* fine */ } }}
          onSave={async (draft) => {
            try {
              if (draft.isNew) await apiClient.createRole(draft);
              else await apiClient.updateRole(draft.id, draft);
              toast.success(draft.isNew ? 'Role created.' : 'Role updated.');
              setEditing(null);
              setRoleErrors({});
              try { sessionStorage.removeItem(roleDraftKey); } catch { /* fine */ }
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

const unitLabel = (unitId, units = []) => {
  const u = units.find((x) => x.id === unitId);
  return u ? (u.short_name || u.name || u.id) : (unitId || 'this unit');
};

function RoleDialog({ role, groups, topPosition, positions = {}, units, identity, draftStorageKey, fieldErrors = {}, onCancel, onSave }) {
  const [draft, setDraft] = useState({
    name: '', description: '', color: SWATCHES[0], position: 1,
    permissions: 1, unit_id: null, ...role,
  });
  // Finding 35: an in-progress role definition survives an accidental close.
  const ROLE_DRAFT = draftStorageKey || draftKey('unknown', 'role');
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

  /* Role position is a per-unit scale (finding 1). Comparing the draft against
   * a single global "your position" would judge it on a number from a
   * different unit's ladder entirely. */
  const unitTop = positions[draft.unit_id] ?? topPosition;

  /* You cannot hand out what you do not hold; the server refuses it too, so
   * showing an ungrantable box would just produce a confusing error.
   *
   * v3.3 read `globalPermissions` here, which under tenancy would offer a
   * SNCOIC every checkbox in a unit they merely visit. Bits are read from the
   * unit this role belongs to (finding 4). */
  const held = identity?.permissions?.[draft.unit_id] || 0;
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
          <Field
            error={fieldErrors.position}
            label="Position"
            hint={`Must be below yours in this unit (${unitTop}). Positions are per-unit — position 30 here has nothing to do with position 30 in another shop.`}
          >
            <Input
              type="number"
              min={0}
              max={Math.max(0, unitTop - 1)}
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

        {/* v3.4: there is no scope selector, because a role has exactly one
            scope — the unit it belongs to. The cascading option was removed in
            finding 2 along with inherits_down: a role granted at a parent
            conferred authority over every unit beneath it, automatically and
            invisibly to those units. */}
        <Field label="Applies in" hint="A role works in its own unit and nowhere else. To give someone authority in another unit, grant them a role there.">
          <Input value={unitLabel(draft.unit_id, units)} readOnly disabled />
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
