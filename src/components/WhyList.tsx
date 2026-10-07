import { Badge } from '@/components/ui/primitives';
import { humanize } from '@/lib/utils';
import type { UnitExplanation } from '@/lib/tenancy';

const PERMISSION_LABEL: Record<string, string> = {
  ADMINISTRATOR: 'Everything', VIEW_UNIT: 'See the unit', VIEW_RECORDS: 'Read shared records', VIEW_MEMBER_DETAIL: 'Read member detail', MANAGE_RECORDS: 'Correct shared records',
  CREATE_SHARED_WORK: 'Post unit work', CREATE_SHARED_GOALS: 'Set unit goals', MANAGE_MEMBERS: 'Manage members', MANAGE_ROLES: 'Manage roles', MANAGE_UNITS: 'Manage units',
  VIEW_AUDIT: 'Read the access log', EXPORT_DATA: 'Export', COUNSEL: 'Counsel', CLAIM_WORK: 'Claim work', EDIT_WORK: 'Edit work', RESOLVE_WORK: 'Resolve work', REASSIGN_WORK: 'Reassign work', VIEW_SUPPORT: 'Work support tickets',
};
const SOURCE_TONE = { role: 'neutral', inherited: 'info', owner: 'accent', org: 'warn', vantage: 'bad' } as const;
const SOURCE_LABEL = { role: 'Role', inherited: 'Chain of command', owner: 'Leadership', org: 'Organization', vantage: 'Vantage access' } as const;

/**
 * "Why can they?": unit by unit, every grant behind a person's authority and what each one carries: a role and where
 * it was granted, authority reaching down the chain, unit leadership, organization administration, Vantage access.
 */
export default function WhyList({ units }: { units: UnitExplanation[] }) {
  if (!units.length) return <p className="text-sm text-ink-3">No authority in any unit beyond seeing their own work.</p>;
  return (
    <div className="space-y-3">
      {units.map((u) => (
        <div key={u.unitId} className="rounded-md border border-line p-3">
          <p className="flex items-center justify-between gap-2"><span className="font-medium text-ink">{u.unitName}</span>{u.readsRecords ? <Badge tone="warn">Reads shared records</Badge> : <Badge tone="neutral">Does not read records</Badge>}</p>
          <ul className="mt-2 space-y-1.5">{u.sources.map((s, i) => (
            <li key={i} className="text-xs">
              <Badge tone={SOURCE_TONE[s.kind]}>{SOURCE_LABEL[s.kind]}</Badge> <span className="text-ink">{s.label}</span>{s.expiresAt ? <span className="text-ink-3"> · until {new Date(s.expiresAt).toLocaleDateString()}</span> : null}
              <span className="mt-0.5 block text-ink-3">{s.permissions.map((p) => PERMISSION_LABEL[p] ?? humanize(p)).join(' · ')}</span>
            </li>
          ))}</ul>
        </div>
      ))}
    </div>
  );
}
