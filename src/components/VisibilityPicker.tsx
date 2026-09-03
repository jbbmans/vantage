import { Lock, Users } from 'lucide-react';
import { useIdentity } from '@/lib/queries';
import { Select } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

export default function VisibilityPicker({ value, unitId, onChange, compact = false, permission }: { value: 'private' | 'unit'; unitId?: string | null; onChange: (v: { visibility: 'private' | 'unit'; unit_id?: string | null }) => void; compact?: boolean; permission?: number }) {
  const { data: identity } = useIdentity();
  const allowed = (unit: string) => !permission || Boolean(((identity?.permissions[unit] || 0) & (permission | (1 << 12))));
  const memberships = (identity?.memberships || []).filter((m) => allowed(m.unit_id));
  const canShare = memberships.length > 0;
  const options: Array<{ value: 'private' | 'unit'; label: string; icon: typeof Lock; hint: string; disabled?: boolean }> = [
    { value: 'private', label: 'Only me', icon: Lock, hint: 'Never visible to leaders or the unit.' },
    { value: 'unit', label: 'Share with unit', icon: Users, hint: canShare ? 'Readable by leaders with the View shared records permission.' : permission ? 'Your role cannot post shared work here.' : 'Join a unit to share.', disabled: !canShare },
  ];
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-xs font-semibold text-ink-2">Who can see this</p>
      <div className={cn('grid gap-2', compact ? 'grid-cols-2' : 'sm:grid-cols-2')} role="radiogroup" aria-label="Visibility">
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={o.disabled} onClick={() => onChange({ visibility: o.value, unit_id: o.value === 'unit' ? (unitId && allowed(unitId) ? unitId : memberships[0]?.unit_id || null) : unitId })}
            className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-40', value === o.value ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong')}>
            <o.icon className={cn('mt-0.5 h-4 w-4 shrink-0', value === o.value ? 'text-accent' : 'text-ink-3')} />
            <span className="min-w-0"><span className="block text-sm font-medium text-ink">{o.label}</span>{!compact && <span className="block text-xs leading-snug text-ink-3">{o.hint}</span>}</span>
          </button>
        ))}
      </div>
      {value === 'unit' && memberships.length > 1 && (
        <div className="mt-2"><Select aria-label="Unit" value={unitId || identity?.primaryUnitId || ''} onValueChange={(u) => onChange({ visibility: 'unit', unit_id: u })} options={memberships.map((m) => ({ value: m.unit_id, label: m.unit_short || m.unit_name }))} /></div>
      )}
    </div>
  );
}
