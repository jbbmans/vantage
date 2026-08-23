import React from 'react';
import { Lock, Users, NotebookPen } from 'lucide-react';
import { useIdentity, unitById } from '@/store/useStore';
import { Field, Select } from '@/components/ui/primitives';

/**
 * Who sees this record.
 *
 * Named after what actually happens rather than after a permission level: a
 * Marine picking an option wants to know who reads it, not to learn what a
 * visibility tier is. The server enforces all of this again — this control
 * only shapes what gets asked for.
 *
 * v3.4 removed "My chain of command" (finding 3). It meant the unit and
 * everyone above and below it, it was the DEFAULT on activities, recognitions
 * and trainings, and it published a Marine's work up the org chart without
 * anyone deciding to send it. Work reaches a level above by someone in this
 * unit generating a share package and sending it — an act with a name, a
 * timestamp and an audit row.
 *
 * That leaves three honest answers, and the hints say plainly which is which.
 */
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
  const selected = VISIBILITY_OPTIONS.find((o) => o.value === value)
    || VISIBILITY_OPTIONS.find((o) => o.value === DEFAULT_VISIBILITY);

  const memberships = identity?.memberships || [];
  const target = unitId || memberships[0]?.unit_id;
  const unit = unitById(target);

  /* Someone with no unit at all — a Marine between commands, or one who has
   * only ever kept their own log — can still record everything. Personal
   * scope is the point of finding 6, so the picker offers it rather than
   * presenting an empty unit dropdown. */
  const options = memberships.length
    ? VISIBILITY_OPTIONS
    : VISIBILITY_OPTIONS.filter((o) => o.value === 'personal');

  const hint = value === 'personal' || value === 'private' || !unit
    ? selected.hint
    : `${selected.hint} Scoped to ${unit.short_name || unit.name}.`;

  return (
    <Field label={label} hint={hint}>
      <Select
        value={value}
        onValueChange={onChange}
        options={options.map((o) => ({ value: o.value, label: o.label }))}
      />
    </Field>
  );
}

/**
 * For leaders creating something aimed at a unit rather than at themselves —
 * tasks, projects and goals.
 *
 * v3.3 offered every unit in the actor's subtree and told the user "everyone at
 * or beneath this unit will see it." Neither half survives: there is no
 * subtree, and posting to a unit reaches that unit only. The list is now the
 * units the actor is actually a member of, which is also the set the server
 * will accept.
 */
export function UnitTargetPicker({ value, onChange, label = 'Assign to unit', units = [] }) {
  const identity = useIdentity();
  const memberships = identity?.memberships || [];
  if (memberships.length < 1) return null;

  const options = units.length
    ? units
    : memberships.map((m) => unitById(m.unit_id) || { id: m.unit_id, name: m.unit_name, short_name: m.unit_short });

  return (
    <Field label={label} hint="Everyone in this unit will see it. Nobody outside it will.">
      <Select
        value={value || ''}
        onValueChange={onChange}
        placeholder="My own unit"
        options={[
          { value: '', label: 'My own unit' },
          ...options.map((u) => ({ value: u.id, label: u.short_name || u.name || u.id })),
        ]}
      />
    </Field>
  );
}
