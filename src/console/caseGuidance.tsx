import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button, Panel, Skeleton } from '@/components/ui/primitives';
import { GuidanceDialog, GuidanceList, RetireDialog, bodyOf, draftFor, type GuidanceDraft } from '@/components/CaseGuidance';
import * as api from '@/lib/api';
import type { OrgSummary } from '@/lib/tenancy';
import { UNIT_GUIDANCE_AUTHORITIES } from '../../shared/caseDiagnosis';
import type { GuidanceRecord } from '../../shared/caseGuidance';
import { Failed, useAct, useOrg } from './sections';

interface OrgGuidance { entries: GuidanceRecord[]; examples: GuidanceRecord[]; enterprise: GuidanceRecord[] }

/**
 * The Unit Manager console's case guidance page (ADR-0022): the command's own approved SOPs and validated SME workflows,
 * which the case diagnoser gives every case of the Unit Instance ranked above the training reference; the past cases its
 * unit leaders validated as examples; and, read-only, the official guidance Vantage keeps for every Unit Instance.
 */
export function CaseGuidance({ org }: { org: OrgSummary }) {
  const can = org.permissions.includes('org.config');
  const qc = useQueryClient();
  const act = useAct();
  const q = useOrg<OrgGuidance>(org.id, 'case-guidance', () => api.orgCaseGuidance(org.id));
  const [draft, setDraft] = useState<GuidanceDraft | null>(null);
  const [retiring, setRetiring] = useState<GuidanceRecord | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['org', org.id, 'case-guidance'] });
  if (q.isPending) return <Skeleton className="h-64" />;
  if (q.isError || !q.data) return <Failed error={q.error} retry={() => q.refetch()} />;
  const { entries, examples, enterprise } = q.data;
  const save = async (d: GuidanceDraft) => {
    const r = await act(d.supersedes_id ? 'New wording on file. The old one is retired and kept.' : 'Guidance on file.', () => api.orgAddCaseGuidance(org.id, bodyOf(d)), refresh);
    if (r) setDraft(null);
  };
  const retire = async (reason: string) => {
    if (!retiring) return;
    const r = await act(retiring.authority === 'historical_case' ? 'Example withdrawn.' : 'Retired. It is kept with your reason.', () => api.orgRetireCaseGuidance(org.id, retiring.id, reason), refresh);
    if (r) setRetiring(null);
  };
  return (
    <div className="space-y-5">
      <Panel title="Command SOPs and SME workflows" subtitle="Ranked above the training reference in every diagnosis in this Unit Instance, below official policy and official system guidance. Each is cited and names who approved it."
        action={can ? <Button size="sm" variant="primary" onClick={() => setDraft(draftFor('approved_local_sop'))}><Plus className="h-4 w-4" />Put guidance on file</Button> : undefined}>
        <GuidanceList entries={entries} label="Command guidance" empty="None on file. Diagnoses here rank the training reference first after any official guidance."
          onReplace={can ? (g) => setDraft(draftFor(g.authority, g)) : undefined} onRetire={can ? setRetiring : undefined} />
      </Panel>
      <Panel title="Validated examples" subtitle="Resolved, verified cases a unit leader held up for the next one like it. A diagnosis offers one only to a reader who may open its case.">
        <GuidanceList entries={examples} label="Validated examples" empty="None yet. A unit leader validates one from a resolved case, never one they resolved themselves."
          onRetire={can ? setRetiring : undefined} retireLabel="Withdraw" />
      </Panel>
      <Panel title="Official guidance" subtitle="Official policy and official system guidance Vantage keeps for every Unit Instance. Vantage Administrators put it on file.">
        <GuidanceList entries={enterprise} label="Official guidance" empty="None on file. A diagnosis says so, rather than treating anything else as policy." />
      </Panel>
      <GuidanceDialog draft={draft} setDraft={setDraft} authorities={UNIT_GUIDANCE_AUTHORITIES} onSave={save} />
      <RetireDialog entry={retiring} title={retiring?.authority === 'historical_case' ? 'Withdraw this example' : 'Retire this guidance'} action={retiring?.authority === 'historical_case' ? 'Withdraw it' : 'Retire it'} onClose={() => setRetiring(null)} onRetire={retire} />
    </div>
  );
}
