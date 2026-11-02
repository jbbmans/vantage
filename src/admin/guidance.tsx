import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button, Panel, Skeleton } from '@/components/ui/primitives';
import { withSudo } from '@/components/SudoDialog';
import { useToast } from '@/components/ui/toast';
import { GuidanceDialog, GuidanceList, RetireDialog, bodyOf, draftFor, type GuidanceDraft } from '@/components/CaseGuidance';
import * as api from '@/lib/api';
import { ENTERPRISE_GUIDANCE_AUTHORITIES } from '../../shared/caseDiagnosis';
import type { GuidanceRecord } from '../../shared/caseGuidance';
import { useAdmin } from './sections';

/**
 * Official policy and official system guidance the case diagnoser cites in every Unit Instance (ADR-0022), ranked first.
 * Vantage keeps no policy of its own: an entry here is a citation a Vantage Administrator put on file, never edited, and
 * retired with a reason. A command's own SOPs are its Unit Managers' to keep.
 */
export function OfficialGuidance({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useAdmin<{ entries: GuidanceRecord[] }>('case-guidance', () => api.platformCaseGuidance());
  const [draft, setDraft] = useState<GuidanceDraft | null>(null);
  const [retiring, setRetiring] = useState<GuidanceRecord | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin', 'case-guidance'] });
  const act = async (label: string, fn: () => Promise<unknown>) => {
    try { await withSudo(fn); toast.success(label); refresh(); return true; } catch (e) { toast.error(api.errorText(e)); return false; }
  };
  if (q.isPending) return <Skeleton className="h-64" />;
  if (q.isError || !q.data) return <Panel title="Official guidance"><p className="text-sm text-bad">{api.errorText(q.error)}</p></Panel>;
  const live = q.data.entries.filter((g) => !g.retired_at);
  const retired = q.data.entries.filter((g) => g.retired_at);
  return (
    <div className="space-y-5">
      <Panel title="On file" subtitle="Given to every diagnosis it speaks to, in every Unit Instance, ranked above a command’s SOP and the training reference."
        action={canEdit ? <Button size="sm" variant="primary" onClick={() => setDraft(draftFor('official_policy'))}><Plus className="h-4 w-4" />Put guidance on file</Button> : undefined}>
        <GuidanceList entries={live} label="Official guidance on file" empty="None on file. Every diagnosis says that no official guidance is on file, rather than treating the training reference as policy."
          onReplace={canEdit ? (g) => setDraft(draftFor(g.authority, g)) : undefined} onRetire={canEdit ? setRetiring : undefined} />
      </Panel>
      {retired.length > 0 && (
        <Panel title="Retired" subtitle="Kept with who retired each one, when and why.">
          <GuidanceList entries={retired} label="Retired official guidance" empty="" />
        </Panel>
      )}
      <GuidanceDialog draft={draft} setDraft={setDraft} authorities={ENTERPRISE_GUIDANCE_AUTHORITIES}
        onSave={async (d) => { if (await act(d.supersedes_id ? 'New wording on file. The old one is retired and kept.' : 'Guidance on file.', () => api.platformAddCaseGuidance(bodyOf(d)))) setDraft(null); }} />
      <RetireDialog entry={retiring} title="Retire this guidance" onClose={() => setRetiring(null)}
        onRetire={async (reason) => { if (retiring && await act('Retired. It is kept with your reason.', () => api.platformRetireCaseGuidance(retiring.id, reason))) setRetiring(null); }} />
    </div>
  );
}
