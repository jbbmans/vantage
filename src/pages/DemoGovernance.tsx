import { useQuery } from '@tanstack/react-query';
import { Badge, PageHeader, Panel } from '@/components/ui/primitives';
import { PrivacyConsole } from '@/components/GovernanceConsole';
import * as api from '@/lib/api';

/**
 * The demo has no owner console: every visitor shares one instance, and the console is instance-wide. What an owner
 * governs is shown instead, with the parts that hold nobody's data live.
 */
export default function DemoGovernance() {
  const { data } = useQuery<any>({ queryKey: ['demo-governance'], queryFn: api.demoGovernance });
  const controls: Array<[string, string]> = [
    ['Retention and legal holds', 'Each record type keeps a schedule with the authority it is kept under. A legal hold stops every path that could delete what it covers, and every run leaves disposition evidence.'],
    ['Integrity', 'Every case history and the audit log are hash-chained and signed, and can be sent off the host to a SIEM as they are written, so a rewrite shows.'],
    ['Accounts and sign-in', 'Passkeys, authenticator codes and CAC. Accounts lock after repeated failures, sessions end after 15 idle minutes, and the DoD notice can be required before sign-in.'],
    ['Personnel feed', 'A roster extract from the personnel system becomes the source for rank, unit, MOS and EAS; changes are audited field by field and a sync never deletes anybody.'],
    ['Backups and moving', 'Backups taken on the server, or downloaded by an owner with every other owner told. An instance moves whole to another host.'],
    ['Usage without surveillance', 'Adoption and failures as counts across people, never one person’s activity, and nothing anyone typed.'],
  ];
  return (
    <div className="page">
      <PageHeader eyebrow="Owner console" title="What an owner governs" lede="The console itself is not part of the synthetic demo: it is instance-wide, and every visitor shares this instance. These are the controls it holds; the data inventory below is live, built from the schema." />
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {controls.map(([title, body]) => <Panel key={title} title={title}><p className="text-sm text-ink-2">{body}</p></Panel>)}
      </div>
      {data && <p className="mb-4 flex flex-wrap gap-2 text-sm"><Badge tone={data.auditChain ? 'good' : 'bad'}>Audit chain {data.auditChain ? 'intact' : 'broken'}</Badge><Badge tone={data.caseHistories ? 'good' : 'bad'}>Case histories {data.caseHistories ? 'intact' : 'broken'}</Badge></p>}
      <PrivacyConsole demo />
    </div>
  );
}
