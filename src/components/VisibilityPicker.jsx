import React, { useEffect } from 'react';
import { Lock, Users, NotebookPen } from 'lucide-react';
import { useIdentity, unitById, preferredUnitId } from '@/store/useStore';
import { Field, Select } from '@/components/ui/primitives';

export const VISIBILITY_OPTIONS = [
  {
    value: 'personal',
    label: 'Just me — my own log',
    hint: 'Kept outside any unit. Nobody else can read it, including your SNCOIC. It stays yours if you transfer.',
    icon: NotebookPen,
  },
  {
    value: 'private',
    label: 'Only me',
    hint: 'Filed under this unit but readable only by you.',
    icon: Lock,
  },
  {
    value: 'unit',
    label: 'Everyone in my unit',
    hint: 'Everyone in this unit sees it. Nobody outside it does — not the unit above, not any other shop.',
    icon: Users,
  },
];

export const DEFAULT_VISIBILITY = 'unit';

export default function VisibilityPicker({ value = DEFAULT_VISIBILITY, onChange, unitId, label = 'Visible to' }) {
  const identity = useIdentity();
  const memberships = identity?.memberships || [];
  const effectiveValue = memberships.length ? value : 'personal';
  const selected = VISIBILITY_OPTIONS.find((o) => o.value === effectiveValue)
    || VISIBILITY_OPTIONS.find((o) => o.value === DEFAULT_VISIBILITY);
  const target = unitId || preferredUnitId(memberships.map((membership) => membership.unit_id));
  const unit = unitById(target);

  useEffect(() => {
    if (!memberships.length && value !== 'personal') onChange?.('personal');
  }, [memberships.length, value, onChange]);

  const options = memberships.length
    ? VISIBILITY_OPTIONS
    : VISIBILITY_OPTIONS.filter((o) => o.value === 'personal');

  const hint = effectiveValue === 'personal' || effectiveValue === 'private' || !unit
    ? selected.hint
    : `${selected.hint} Scoped to ${unit.short_name || unit.name}.`;

  return (
    <Field label={label} hint={hint}>
      <Select
        value={effectiveValue}
        onValueChange={onChange}
        options={options.map((o) => ({ value: o.value, label: o.label }))}
      />
    </Field>
  );
}

export function UnitTargetPicker({ value, onChange, visibility = 'unit', label, units }) {
  const identity = useIdentity();
  const memberships = identity?.memberships || [];
  const options = Array.isArray(units)
    ? units
    : memberships.map((m) => unitById(m.unit_id) || { id: m.unit_id, name: m.unit_name, short_name: m.unit_short });
  const fallback = memberships.length ? preferredUnitId(options.map((unit) => unit.id)) : '';
  const privateRecord = visibility === 'private';
  const fieldLabel = label || (privateRecord ? 'File under unit' : 'Assign to unit');
  const hint = privateRecord
    ? 'Only you can read this record. The unit keeps its command context.'
    : 'Everyone in this unit will see it. Nobody outside it will.';

  useEffect(() => {
    if (!value && fallback) onChange?.(fallback);
  }, [value, fallback, onChange]);

  if (memberships.length < 1) return null;

  return (
    <Field label={fieldLabel} hint={hint}>
      <Select
        value={value || fallback || ''}
        onValueChange={onChange}
        placeholder="Select a unit"
        options={options.map((u) => ({ value: u.id, label: u.short_name || u.name || u.id }))}
      />
    </Field>
  );
}
