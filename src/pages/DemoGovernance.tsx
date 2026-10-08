import { useQuery } from '@tanstack/react-query';
import { Badge, PageHeader, Panel } from '@/components/ui/primitives';
import { PrivacyConsole } from '@/components/GovernanceConsole';
import * as api from '@/lib/api';

/**
 * The demo has no Unit Manager console: every visitor shares one instance, and the console is instance-wide. What a Unit
 * Manager governs is shown instead, with the parts that hold nobody's data live.
 */
export default function DemoGovernance() {
  const { data } = useQuery<any>({ queryKey: ['demo-governance'], queryFn: api.demoGovernance });
  // Who holds each control: the Unit Manager console's own, or the service-wide ones Vantage staff run (ADR-0010).
  const controls: Array<[string, string, 'Unit Managers' | 'Vantage staff']> = [
    ['Retention and legal holds', 'Each record type keeps a schedule with the authority it is kept under. A legal hold stops every path that could delete what it covers, and every run leaves disposition evidence.', 'Unit Managers'],
    ['Integrity', 'Every case history and the audit log are hash-chained and signed, and can be sent off the host to a SIEM as they are written, so a rewrite shows. The Unit Manager console shows the Unit Instance’s own trail.', 'Vantage staff'],
    ['Accounts and sign-in', 'Passkeys, authenticator codes and CAC. Accounts lock after repeated failures, sessions end after 15 idle minutes, and the DoD notice can be required before sign-in.', 'Vantage staff'],
    ['Personnel feed', 'A roster extract from the personnel system becomes the source for rank, unit, MOS and EAS; changes are audited field by field and a sync never deletes anybody.', 'Unit Managers'],
    ['Backups and moving', 'Backups taken on the server, or downloaded by a Lead Vantage Administrator with every other one told. The service moves whole to another host.', 'Vantage staff'],
    ['Usage without surveillance', 'Adoption and failures as counts across people, never one person’s activity, and nothing anyone typed.', 'Vantage staff'],
  ];
  return (
    <div className="page">
      <PageHeader eyebrow="Unit Manager console" title="How a Unit Instance is governed" lede="The console itself is not part of the synthetic demo: it is instance-wide, and every visitor shares this instance. These are the controls, and who holds each; the data inventory below is live, built from the schema." />
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {controls.map(([title, body, who]) => <Panel key={title} title={title} action={<Badge tone={who === 'Unit Managers' ? 'accent' : 'neutral'}>{who}</Badge>}><p className="text-sm text-ink-2">{body}</p></Panel>)}
      </div>
      {data && <p className="mb-4 flex flex-wrap gap-2 text-sm"><Badge tone={data.auditChain ? 'good' : 'bad'}>Audit chain {data.auditChain ? 'intact' : 'broken'}</Badge><Badge tone={data.caseHistories ? 'good' : 'bad'}>Case histories {data.caseHistories ? 'intact' : 'broken'}</Badge></p>}
      <PrivacyConsole demo />
    </div>
  );
}
