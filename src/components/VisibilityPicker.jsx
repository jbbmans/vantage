import React from 'react';
import { Lock, Users, GitBranch } from 'lucide-react';
import { useIdentity, useCanLead, unitById, unitPath } from '@/store/useStore';
import { Field, Select } from '@/components/ui/primitives';

/**
 * Who sees this record.
 *
 * Named after what actually happens rather than after a permission level: a
 * Marine choosing "My chain of command" wants their team lead to see the work,
 * not to learn what `chain` means. The server enforces all of this again — this
 * control only shapes what gets asked for.
 */
export const VISIBILITY_OPTIONS = [
  {
    value: 'private',
    label: 'Only me',
    hint: 'Nobody in your chain sees this, including your team lead.',
    icon: Lock,
  },
  {
    value: 'chain',
    label: 'My chain of command',
    hint: 'Your team lead and everyone above them. This is how logged work reaches a JEPES input.',
    icon: GitBranch,
  },
  {
    value: 'unit',
    label: 'Everyone in my unit',
    hint: 'Everyone assigned to this exact unit — no one above it. Leaders see it through chain visibility, not unit.',
    icon: Users,
  },
];

export default function VisibilityPicker({ value = 'chain', onChange, unitId, label = 'Visible to' }) {
  const identity = useIdentity();
  const selected = VISIBILITY_OPTIONS.find((o) => o.value === value) || VISIBILITY_OPTIONS[1];
  const target = unitId || identity?.assignments?.[0]?.unit_id;
  const unit = unitById(target);

  const hint = value === 'private'
    ? selected.hint
    : `${selected.hint}${unit ? ` Scoped to ${unit.short_name || unit.name}.` : ''}`;

  return (
    <Field label={label} hint={hint}>
      <Select
        value={value}
        onValueChange={onChange}
        options={VISIBILITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
      />
    </Field>
  );
}

/**
 * For leaders creating something aimed at a unit rather than at themselves —
 * tasks, projects and goals pushed down the chain.
 */
export function UnitTargetPicker({ value, onChange, label = 'Assign to unit', units = [] }) {
  const canLead = useCanLead();
  const identity = useIdentity();
  if (!canLead) return null;

  const options = units.length
    ? units
    : (identity?.scopeUnitIds || []).map((id) => unitById(id)).filter(Boolean);

  return (
    <Field label={label} hint="Everyone at or beneath this unit will see it.">
      <Select
        value={value || ''}
        onValueChange={onChange}
        placeholder="My own unit"
        options={[
          { value: '', label: 'My own unit' },
          ...options.map((u) => ({
            value: u.id,
            label: unitPath(u.id).map((p) => p.short_name || p.name).join(' › '),
          })),
        ]}
      />
    </Field>
  );
}
