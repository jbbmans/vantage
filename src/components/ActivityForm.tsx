import { Field, Input, NumberInput, Select, Textarea } from '@/components/ui/primitives';
import VisibilityPicker from '@/components/VisibilityPicker';
import { ACTIVITY_STATUS, categoryNames, valueType } from '../../shared/constants';
import { areaOptions, mapAreaToTrack, trackMeta } from '../../shared/evaluation';
import { useProjects, useTrack, useMetrics } from '@/lib/queries';
import { onText } from '@/components/common';
import { humanize, todayIso } from '@/lib/utils';

export interface ActivityDraft { id?: string; version?: number; title: string; date: string; category: string | null; eval_area: string | null; quantity: number | string | null; unit_label: string; dollar_amount: number | string | null; dollar_type: string | null; result: string; organization: string; system: string; project_id: string | null; status: string; notes: string; evidence_links: Array<{ label?: string | null; url?: string | null }>; visibility: 'private' | 'unit'; unit_id: string | null }

export const emptyActivity = (defaults: Partial<ActivityDraft> = {}): ActivityDraft => ({
  title: '', date: todayIso(), category: null, eval_area: 'Unassigned', quantity: '', unit_label: '', dollar_amount: '', dollar_type: null, result: '', organization: '', system: '', project_id: null, status: 'completed', notes: '', evidence_links: [], visibility: 'private', unit_id: null, ...defaults,
});
export const toActivityDraft = (a: Record<string, any>): ActivityDraft => ({ ...emptyActivity(), ...a, quantity: a.quantity ?? '', dollar_amount: a.dollar_amount ?? '', unit_label: a.unit_label || '', result: a.result || '', organization: a.organization || '', system: a.system || '', notes: a.notes || '', evidence_links: a.evidence_links || [] });

export function ActivityFields({ draft, set, errors }: { draft: ActivityDraft; set: (k: any, v: unknown) => void; errors: Record<string, string> }) {
  const track = useTrack();
  const cfg = useMetrics();
  const { data: projects } = useProjects();
  const links = draft.evidence_links || [];
  const setLink = (i: number, patch: Partial<{ label: string; url: string }>) => set('evidence_links', links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <>
      <Field label="Title" required error={errors.title}><Input autoFocus value={draft.title} onChange={onText(set, 'title')} placeholder="Reconciled 30 ULOs in DAI" /></Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Date" error={errors.date}><Input type="date" value={draft.date || ''} onChange={onText(set, 'date')} /></Field>
        <Field label="Status"><Select value={draft.status} onValueChange={(v) => set('status', v)} options={ACTIVITY_STATUS.map((s) => ({ value: s, label: humanize(s) }))} /></Field>
        <Field label="Category"><Select value={draft.category} onValueChange={(v) => set('category', v)} options={categoryNames(cfg).map((c) => ({ value: c, label: c }))} placeholder="Pick a category" /></Field>
        <Field label={trackMeta(track).areaLabel}><Select value={mapAreaToTrack(draft.eval_area, track)} onValueChange={(v) => set('eval_area', v)} options={areaOptions(track)} /></Field>
        <Field label="Action amount" hint="how many" error={errors.quantity}><NumberInput value={draft.quantity ?? ''} onChange={onText(set, 'quantity')} placeholder="30" /></Field>
        <Field label="Action unit"><><Input list="activity-units" value={draft.unit_label} onChange={onText(set, 'unit_label')} placeholder="ULOs" /><datalist id="activity-units">{cfg.unit_suggestions.map((u) => <option key={u} value={u} />)}</datalist></></Field>
        <Field label="Transaction value" hint={`${cfg.currency_label.toLowerCase()} tied to the action`} error={errors.dollar_amount}><NumberInput value={draft.dollar_amount ?? ''} onChange={onText(set, 'dollar_amount')} placeholder="1118.38" /></Field>
        <Field label="Value type" hint={draft.dollar_type ? valueType(draft.dollar_type, cfg)?.definition : undefined}><Select value={draft.dollar_type} onValueChange={(v) => set('dollar_type', v)} options={cfg.value_types.map((d) => ({ value: d.key, label: d.label }))} placeholder="None" /></Field>
      </div>
      <Field label="Result" hint="the so-what: what changed because you did it"><Input value={draft.result} onChange={onText(set, 'result')} placeholder="cleared the aged backlog with zero findings" /></Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Organization"><Input value={draft.organization} onChange={onText(set, 'organization')} placeholder="G-8" /></Field>
        <Field label="System"><Input value={draft.system} onChange={onText(set, 'system')} placeholder="DAI" /></Field>
        <Field label="Project"><Select value={draft.project_id || '__none'} onValueChange={(v) => set('project_id', v === '__none' ? null : v)} options={[{ value: '__none', label: 'No project' }, ...(projects || []).map((p: any) => ({ value: p.id, label: p.name }))]} /></Field>
      </div>
      <Field label="Notes"><Textarea rows={3} value={draft.notes} onChange={onText(set, 'notes')} /></Field>
      <div>
        <div className="mb-1.5 flex items-center justify-between"><span className="text-xs font-semibold text-ink-2">Evidence links</span><button type="button" className="text-xs text-accent hover:underline" onClick={() => set('evidence_links', [...links, { label: '', url: '' }])} disabled={links.length >= 20}>Add link</button></div>
        {links.length === 0 && <p className="text-xs text-ink-3">Point at the ticket, report, or email that proves it. Links only; files attach after saving.</p>}
        <div className="space-y-2">
          {links.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_2fr_auto] gap-2">
              <Input aria-label="Link label" value={l.label || ''} onChange={(e) => setLink(i, { label: e.target.value })} placeholder="Label" />
              <Input aria-label="Link URL" value={l.url || ''} onChange={(e) => setLink(i, { url: e.target.value })} placeholder="https://" inputMode="url" />
              <button type="button" className="text-xs text-ink-3 hover:text-bad" onClick={() => set('evidence_links', links.filter((_, j) => j !== i))} aria-label="Remove link">Remove</button>
            </div>
          ))}
        </div>
      </div>
      <VisibilityPicker value={draft.visibility} unitId={draft.unit_id} onChange={(v) => { set('visibility', v.visibility); set('unit_id', v.unit_id ?? null); }} />
    </>
  );
}

export const activityPayload = (d: ActivityDraft) => ({
  ...d,
  quantity: d.quantity === '' || d.quantity == null ? null : Number(String(d.quantity).replace(/[,\s]/g, '')),
  dollar_amount: d.dollar_amount === '' || d.dollar_amount == null ? null : Number(String(d.dollar_amount).replace(/[$,\s]/g, '')),
  evidence_links: (d.evidence_links || []).filter((l) => (l.url || '').trim() || (l.label || '').trim()),
});
