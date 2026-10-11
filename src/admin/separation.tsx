import { RefreshCw } from 'lucide-react';
import { Badge, Button, EmptyState, Panel, Skeleton } from '@/components/ui/primitives';
import { Table } from '@/components/common';
import * as api from '@/lib/api';
import { formatStamp } from '@/lib/utils';
import { useAdmin } from './sections';

/**
 * The separation-of-duties report (ADR-0013): accounts whose authority crosses a line the role model draws, for Vantage
 * staff who read the audit trail. Read-only: each row is a question for a person, settled where the authority is held.
 */

interface SodPerson { id: string; username: string; name: string; active: boolean }
interface SodInstance { orgId: string; orgName: string; roles: string[] }
interface SeparationReport {
  checkedAt: string;
  platformAndInstance: Array<{ person: SodPerson; platformRoles: string[]; instances: SodInstance[] }>;
  instanceAndRecords: Array<{ person: SodPerson; orgId: string; orgName: string; instanceRoles: string[]; reading: Array<{ unitId: string; unitName: string; role: string }> }>;
  managersAcrossInstances: Array<{ person: SodPerson; instances: SodInstance[] }>;
  leadersNotMembers: Array<{ person: SodPerson; unitId: string; unitName: string; orgId: string | null; orgName: string | null }>;
  unprovenReaders: Array<{ person: SodPerson; unitId: string | null; unitName: string | null; orgId: string | null; orgName: string | null; role: string; grantedBy: SodPerson }>;
}

const Who = ({ person }: { person: SodPerson }) => (
  <><span className="block font-medium text-ink">{person.name}{person.active ? null : <Badge className="ml-1.5">Deactivated</Badge>}</span><span className="block text-xs text-ink-3">@{person.username}</span></>
);
const instances = (list: SodInstance[]) => list.map((i) => `${i.orgName}: ${i.roles.join(', ')}`).join('; ');

/** One finding: a heading the page's outline reads, what it means, and its rows or a plain "none". */
function Finding({ id, title, explain, count, children, head }: { id: string; title: string; explain: string; count: number; children: React.ReactNode; head: React.ReactNode }) {
  return (
    <Panel id={id} title={<span className="flex items-center gap-2">{title}<Badge tone={count ? 'warn' : 'good'}>{count ? `${count} to review` : 'None'}</Badge></span>} subtitle={explain}>
      {count ? <Table minWidth={560} head={head}>{children}</Table> : <p className="text-sm text-ink-3">Nobody.</p>}
    </Panel>
  );
}

export function SeparationOfDuties() {
  const { data, isPending, error, refetch, isFetching } = useAdmin<SeparationReport>('separation-of-duties', api.platformSeparationOfDuties);
  if (isPending) return <Skeleton className="h-64" />;
  if (error || !data) return <div className="card"><EmptyState title="Could not load" description={api.errorText(error)} action={<Button onClick={() => refetch()}>Retry</Button>} /></div>;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-2">Checked {formatStamp(data.checkedAt)}. Nothing here is refused by Vantage; each is for a person to look at, and to change where the authority is held.</p>
        <Button size="sm" variant="ghost" onClick={() => refetch()} loading={isFetching}><RefreshCw className="h-3.5 w-3.5" />Check again</Button>
      </div>
      <Finding id="platform-and-instance" title="Vantage staff with a Unit Instance role" count={data.platformAndInstance.length}
        explain="The service’s authority and a command’s in one account."
        head={<><th>Account</th><th>Vantage role</th><th>Unit Instance roles</th></>}>
        {data.platformAndInstance.map((r) => <tr key={r.person.id}><td><Who person={r.person} /></td><td>{r.platformRoles.join(', ')}</td><td>{instances(r.instances)}</td></tr>)}
      </Finding>
      <Finding id="instance-and-records" title="Unit Instance roles that also read records" count={data.instanceAndRecords.length}
        explain="In the same Unit Instance, a Unit Instance role and a unit role that reads records, or the leadership of a unit."
        head={<><th>Account</th><th>Unit Instance</th><th>Unit Instance roles</th><th>Reads records through</th></>}>
        {data.instanceAndRecords.map((r) => (
          <tr key={`${r.person.id}:${r.orgId}`}><td><Who person={r.person} /></td><td>{r.orgName}</td><td>{r.instanceRoles.join(', ')}</td><td>{r.reading.map((x) => `${x.role} in ${x.unitName}`).join('; ')}</td></tr>
        ))}
      </Finding>
      <Finding id="managers-across-instances" title="Unit Managers in more than one Unit Instance" count={data.managersAcrossInstances.length}
        explain="A Lead Unit Manager or Unit Manager role in two or more Unit Instances."
        head={<><th>Account</th><th>Unit Instances and roles</th></>}>
        {data.managersAcrossInstances.map((r) => <tr key={r.person.id}><td><Who person={r.person} /></td><td>{instances(r.instances)}</td></tr>)}
      </Finding>
      <Finding id="leaders-not-members" title="Unit leaders who are not members" count={data.leadersNotMembers.length}
        explain="Recorded as a unit’s leader but no longer in it, so the leadership confers nothing. A Unit Manager names the unit’s leader."
        head={<><th>Recorded leader</th><th>Unit</th><th>Unit Instance</th></>}>
        {data.leadersNotMembers.map((r) => <tr key={r.unitId}><td><Who person={r.person} /></td><td>{r.unitName}</td><td>{r.orgName ?? '—'}</td></tr>)}
      </Finding>
      <Finding id="unproven-readers" title="Roles from the person who created the account" count={data.unprovenReaders.length}
        explain="Accounts that have not signed in with their own CAC or the organization’s sign-in, holding a role that reads records, or a Unit Instance role, from whoever created or invited them."
        head={<><th>Account</th><th>Role</th><th>Where</th><th>Granted by</th></>}>
        {data.unprovenReaders.map((r) => (
          <tr key={`${r.person.id}:${r.unitId ?? r.orgId}:${r.role}`}><td><Who person={r.person} /></td><td>{r.role}</td><td>{r.unitName ? `${r.unitName}${r.orgName ? `, ${r.orgName}` : ''}` : r.orgName ?? '—'}</td><td><Who person={r.grantedBy} /></td></tr>
        ))}
      </Finding>
    </div>
  );
}
