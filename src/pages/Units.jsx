import React, { useMemo, useState } from 'react';
import { Building2, Plus, Pencil, Archive, ChevronRight } from 'lucide-react';
import * as apiClient from '@/lib/api';
import { useOrg, useIdentity, can, unitsWith, hydrate, PERMISSIONS } from '@/store/useStore';
import { useToast } from '@/components/ui/toast';
import { Dialog, ConfirmDialog } from '@/components/ui/Dialog';
import { Panel, PageHeader, EmptyState, Button, Input, Field, Select, Badge } from '@/components/ui/primitives';
import { ECHELON_OPTIONS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { errorText } from '@/lib/api';

/**
 * The org tree.
 *
 * Units are rows, and anyone holding MANAGE_UNITS on a parent can create
 * beneath it. That's the point: a section head stands up their own fire teams
 * without an administrator in the loop, and without waiting on a code change
 * to add a branch that already exists in real life.
 */
export default function Units() {
  const org = useOrg();
  const identity = useIdentity();
  const toast = useToast();
  const [creating, setCreating] = useState(null);
  const [editing, setEditing] = useState(null);
  const [archiving, setArchiving] = useState(null);

  const tree = useMemo(() => {
    const byParent = new Map();
    for (const u of org.units) {
      const key = u.parent_id || '__root';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(u);
    }
    const walk = (parent, depth) =>
      (byParent.get(parent) || [])
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap((u) => [{ ...u, depth }, ...walk(u.id, depth + 1)]);
    return walk('__root', 0);
  }, [org.units]);

  const manageable = unitsWith(PERMISSIONS.MANAGE_UNITS);
  const memberCounts = useMemo(() => new Map(), []);

  if (!manageable.length) {
    return (
      <div className="mx-auto max-w-2xl">
        <Panel title="Units">
          <EmptyState
            icon={Building2}
            title="You can't change the org structure"
            description="Creating and renaming units needs the Manage units permission. Your section head can grant it."
          />
        </Panel>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader title="Units" subtitle={`${org.units.length} units in the tree`}>
        <Button
          variant="primary"
          size="sm"
          onClick={() => setCreating({ parent_id: manageable[0], echelon: 'fire_team' })}
        >
          <Plus className="h-3.5 w-3.5" />
          New unit
        </Button>
      </PageHeader>

      <Panel bodyClassName="p-0">
        {tree.map((u) => {
          const canManage = can(PERMISSIONS.MANAGE_UNITS, u.id);
          return (
            <div key={u.id} className="row flex items-center gap-2 px-3 py-1.5">
              <span style={{ paddingLeft: `${u.depth * 14}px` }} className="flex min-w-0 flex-1 items-center gap-2">
                {u.depth > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-text-3" />}
                <span className="min-w-0">
                  <span className="block truncate text-base text-text">{u.short_name || u.name}</span>
                  <span className="block truncate text-2xs text-text-3">
                    {u.name}
                    {u.location ? ` · ${u.location}` : ''}
                  </span>
                </span>
              </span>

              <Badge tone="neutral" className="hidden shrink-0 sm:inline-flex">
                {(ECHELON_OPTIONS.find((e) => e.value === u.echelon) || {}).label || u.echelon}
              </Badge>
              <span className="fig hidden w-24 shrink-0 truncate text-2xs text-text-3 md:block">{u.code}</span>

              {canManage && (
                <>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Add a unit under ${u.short_name || u.name}`}
                    onClick={() => setCreating({ parent_id: u.id, echelon: 'fire_team' })}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Edit ${u.name}`} onClick={() => setEditing(u)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" aria-label={`Archive ${u.name}`} onClick={() => setArchiving(u)}>
                    <Archive className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </div>
          );
        })}
      </Panel>

      {(creating || editing) && (
        <UnitDialog
          unit={creating || editing}
          isNew={Boolean(creating)}
          units={tree.filter((u) => can(PERMISSIONS.MANAGE_UNITS, u.id))}
          onCancel={() => { setCreating(null); setEditing(null); }}
          onSave={async (draft) => {
            try {
              if (creating) await apiClient.createUnit(draft);
              else await apiClient.updateUnit(draft.id, draft);
              toast.success(creating ? 'Unit created.' : 'Unit updated.');
              setCreating(null);
              setEditing(null);
              await hydrate();
            } catch (err) { toast.error(errorText(err)); }
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(archiving)}
        onOpenChange={(v) => !v && setArchiving(null)}
        title={`Archive "${archiving?.name}"?`}
        body="The unit stops appearing in pickers and rosters. Records that point at it keep pointing at it, so nothing is lost. Units with sub-units or Marines still assigned cannot be archived."
        confirmLabel="Archive unit"
        onConfirm={async () => {
          try {
            await apiClient.archiveUnit(archiving.id);
            toast.success('Unit archived.');
            await hydrate();
          } catch (err) { toast.error(errorText(err)); }
        }}
      />
    </div>
  );
}

function UnitDialog({ unit, isNew, units, onCancel, onSave }) {
  const [draft, setDraft] = useState({ name: '', short_name: '', code: '', location: '', ...unit });
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v?.target ? v.target.value : v }));

  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onCancel()}
      title={isNew ? 'New unit' : `Edit ${unit.name}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={() => onSave(draft)} disabled={!draft.name}>
            {isNew ? 'Create unit' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Full name">
          <Input value={draft.name} onChange={set('name')} placeholder="Fiscal Management Resource Analysis Cell" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Short name" hint="What shows on a roster line">
            <Input value={draft.short_name || ''} onChange={set('short_name')} placeholder="FMRAC" />
          </Field>
          <Field label="Echelon">
            <Select value={draft.echelon} onValueChange={set('echelon')} options={ECHELON_OPTIONS} />
          </Field>
        </div>
        {isNew && (
          <>
            <Field label="Parent unit">
              <Select
                value={draft.parent_id || ''}
                onValueChange={set('parent_id')}
                options={units.map((u) => ({
                  value: u.id,
                  label: `${'\u00A0\u00A0'.repeat(u.depth || 0)}${u.short_name || u.name}`,
                }))}
              />
            </Field>
            <Field label="Unit code" hint="Optional — a stable key. Generated from the name if left blank.">
              <Input value={draft.code || ''} onChange={set('code')} placeholder="G8-FMRAC" />
            </Field>
          </>
        )}
        <Field label="Location">
          <Input value={draft.location || ''} onChange={set('location')} placeholder="NAS JRB New Orleans" />
        </Field>
      </div>
    </Dialog>
  );
}
