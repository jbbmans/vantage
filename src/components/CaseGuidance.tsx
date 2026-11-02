import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Save } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { formatStamp } from '@/lib/utils';
import { ISSUE_TYPES, SECTIONS, type GuidanceAuthority, type GuidanceSection, type IssueKey } from '../../shared/caseDiagnosis';
import { provenanceOf } from '../../shared/procedureTypes';
import type { GuidanceRecord } from '../../shared/caseGuidance';

/**
 * Guidance on file for the case diagnoser (ADR-0022), as the Unit Manager console and the Vantage Administrator console
 * show it: each entry with its rank, what it speaks to, its citation, who approved it, and when it was put on file or
 * retired. An entry is never edited: a new wording replaces it, and retiring keeps it.
 */

export const issueName = (key: IssueKey | 'any') => (key === 'any' ? 'Any issue' : ISSUE_TYPES.find((i) => i.key === key)?.label ?? key);
export const sectionName = (key: string) => SECTIONS.find((s) => s.key === key)?.title ?? key;

export function RankBadge({ authority }: { authority: GuidanceAuthority }) {
  const p = provenanceOf(authority);
  return <Badge tone={p.rank <= 2 ? 'good' : p.rank <= 4 ? 'accent' : 'neutral'} title={p.caution || undefined}>{p.label} · rank {p.rank}</Badge>;
}

export function GuidanceList({ entries, label, empty, onReplace, onRetire, retireLabel = 'Retire' }: {
  entries: GuidanceRecord[]; label: string; empty: string;
  onReplace?: (g: GuidanceRecord) => void; onRetire?: (g: GuidanceRecord) => void; retireLabel?: string;
}) {
  if (!entries.length) return <p className="text-sm text-ink-3">{empty}</p>;
  return (
    <ul aria-label={label} className="divide-y divide-line rounded-xl border border-line">
      {entries.map((g) => (
        <li key={g.id} className="flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3 py-2.5">
          <div className="min-w-0 flex-1 basis-72 space-y-1">
            <p className="flex flex-wrap items-center gap-1.5 text-xs">
              <RankBadge authority={g.authority} />
              <Badge>{issueName(g.issue)}</Badge>
              <Badge>{sectionName(g.section)}</Badge>
              {g.retired_at && <Badge tone="warn">Retired</Badge>}
            </p>
            <p className="text-sm text-ink">{g.text}</p>
            <p className="text-xs text-ink-2">
              {g.case ? <Link className="link" to={`/work/items/${g.case.id}`}>{g.citation}</Link> : g.citation}
              {g.approved_by ? ` · ${g.authority === 'validated_sme_workflow' ? 'validated' : 'approved'} by ${g.approved_by}` : ''}
              {g.effective_on ? ` · effective ${g.effective_on}` : ''}
              {g.cause ? ` · cause decided: ${g.cause.replace(/_/g, ' ')}` : ''}
              {g.unit ? ` · ${g.unit}` : ''}
            </p>
            <p className="text-2xs text-ink-3">
              Put on file {formatStamp(g.recorded_at)} by {g.recorded_by}{g.supersedes_id ? ', replacing an earlier wording' : ''}
              {g.retired_at ? `; retired ${formatStamp(g.retired_at)} by ${g.retired_by}: ${g.retired_reason}` : ''}
            </p>
          </div>
          {!g.retired_at && (onReplace || onRetire) && (
            <span className="flex shrink-0 gap-1">
              {onReplace && g.authority !== 'historical_case' && <Button size="xs" variant="ghost" aria-label={`New wording for ${g.citation}`} onClick={() => onReplace(g)}>New wording</Button>}
              {onRetire && <Button size="xs" variant="ghost" aria-label={`${retireLabel} ${g.citation}`} onClick={() => onRetire(g)}>{retireLabel}</Button>}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface GuidanceDraft {
  authority: GuidanceAuthority; issue: IssueKey | 'any'; section: GuidanceSection; text: string; citation: string;
  approved_by: string; effective_on: string; supersedes_id: string | null;
}

export const draftFor = (authority: GuidanceAuthority, from?: GuidanceRecord | null): GuidanceDraft => ({
  authority: from?.authority ?? authority, issue: from?.issue ?? 'any', section: from?.section ?? 'research', text: from?.text ?? '', citation: from?.citation ?? '',
  approved_by: from?.approved_by ?? '', effective_on: from?.effective_on ?? '', supersedes_id: from?.id ?? null,
});

/** The body a draft is sent as: blanks as nothing, never as empty text. */
export const bodyOf = (d: GuidanceDraft) => ({ ...d, approved_by: d.approved_by.trim() || null, effective_on: d.effective_on || null });

const AUTHORITY_HINT: Partial<Record<GuidanceAuthority, string>> = {
  official_policy: 'A DoD or Marine Corps directive, order or regulation in force.',
  official_system_guidance: 'The owning program’s guide or desk procedure for DAI, SABRS, GCSS-MC, DTS or another system.',
  approved_local_sop: 'This command’s signed SOP. It binds this command only.',
  validated_sme_workflow: 'A way of working a subject-matter expert validated for this command, not a signed SOP.',
};

/** Put one cited statement on file, or a new wording that retires the one it replaces. */
export function GuidanceDialog({ draft, setDraft, authorities, onSave }: {
  draft: GuidanceDraft | null; setDraft: (d: GuidanceDraft | null) => void; authorities: readonly GuidanceAuthority[]; onSave: (d: GuidanceDraft) => void;
}) {
  const needsApprover = draft?.authority === 'approved_local_sop' || draft?.authority === 'validated_sme_workflow';
  const ready = Boolean(draft && draft.text.trim() && draft.citation.trim() && (!needsApprover || draft.approved_by.trim()));
  return (
    <Dialog open={Boolean(draft)} onOpenChange={(o) => { if (!o) setDraft(null); }} size="md"
      title={draft?.supersedes_id ? 'New wording' : 'Put guidance on file'}
      description={draft?.supersedes_id ? 'The new wording is put on file and the old one retired with it. The old one is kept, with who retired it and when.' : 'One short statement about one issue type and one part of a diagnosis, cited so a reader can look it up. It is never edited: a change is a new wording.'}
      footer={<><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" disabled={!ready} onClick={() => draft && onSave(draft)}><Save className="h-4 w-4" />Put on file</Button></>}>
      {draft && (
        <div className="space-y-4">
          <Field label="Kind of source" required hint={AUTHORITY_HINT[draft.authority]}>
            <Select value={draft.authority} onValueChange={(v) => setDraft({ ...draft, authority: v as GuidanceAuthority })} disabled={Boolean(draft.supersedes_id)}
              options={authorities.map((a) => ({ value: a, label: `${provenanceOf(a).label} (rank ${provenanceOf(a).rank})` }))} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Issue type" required>
              <Select value={draft.issue} onValueChange={(v) => setDraft({ ...draft, issue: v as IssueKey | 'any' })} options={[{ value: 'any', label: 'Any issue' }, ...ISSUE_TYPES.map((i) => ({ value: i.key, label: i.label }))]} />
            </Field>
            <Field label="Part of the diagnosis" required>
              <Select value={draft.section} onValueChange={(v) => setDraft({ ...draft, section: v as GuidanceSection })} options={SECTIONS.filter((s) => s.key !== 'issue_type').map((s) => ({ value: s.key, label: s.title }))} />
            </Field>
          </div>
          <Field label="What it says to do" required hint="In the source’s own terms. Up to 1,000 characters.">
            <Textarea rows={3} maxLength={1000} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          </Field>
          <Field label="Citation" required hint="The document and the paragraph, so a reader can look it up.">
            <Input maxLength={300} value={draft.citation} onChange={(e) => setDraft({ ...draft, citation: e.target.value })} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            {needsApprover && (
              <Field label={draft.authority === 'validated_sme_workflow' ? 'Validated by' : 'Approved by'} required>
                <Input maxLength={200} value={draft.approved_by} onChange={(e) => setDraft({ ...draft, approved_by: e.target.value })} />
              </Field>
            )}
            <Field label="Effective" hint={draft.supersedes_id ? 'Optional. A new wording replaces the old one at once, so it takes effect no later than the old one would.' : 'Optional. Before this day it is not given to any case.'}>
              <Input type="date" value={draft.effective_on} onChange={(e) => setDraft({ ...draft, effective_on: e.target.value })} />
            </Field>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Ask for the reason an entry is retired, which is kept with it. */
export function RetireDialog({ entry, title, action = 'Retire it', onClose, onRetire }: { entry: GuidanceRecord | null; title: string; action?: string; onClose: () => void; onRetire: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const close = () => { setReason(''); onClose(); };
  return (
    <Dialog open={Boolean(entry)} onOpenChange={(o) => { if (!o) close(); }} size="sm" title={title}
      description="It stops being given to cases. It is kept, with your reason, who retired it and when."
      footer={<><Button variant="ghost" onClick={close}>Cancel</Button><Button variant="danger" disabled={!reason.trim()} onClick={() => { onRetire(reason.trim()); setReason(''); }}>{action}</Button></>}>
      {entry && (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">{entry.text}</p>
          <Field label="Why" required><Input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>
      )}
    </Dialog>
  );
}

export const NoGuidance = ({ title, description, onAdd }: { title: string; description: string; onAdd?: () => void }) => (
  <EmptyState title={title} description={description} action={onAdd ? <Button variant="primary" onClick={onAdd}><Plus className="h-4 w-4" />Put guidance on file</Button> : undefined} />
);
