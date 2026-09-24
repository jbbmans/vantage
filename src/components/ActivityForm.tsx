import { useId, useRef } from 'react';
import { Field, Input, NumberInput, Select, Textarea } from '@/components/ui/primitives';
import VisibilityPicker from '@/components/VisibilityPicker';
import { ACTIVITY_STATUS, categoryNames, valueType, type MetricsConfig } from '../../shared/constants';
import { RECORD_KINDS, WORK_KIND, kindFor, shapeForKind, type KindField, type RecordKind } from '../../shared/recordKinds';
import { areaOptions, mapAreaToTrack, trackMeta } from '../../shared/evaluation';
import { useProjects, useTrack, useMetrics } from '@/lib/queries';
import { onText } from '@/components/common';
import { cn, humanize, todayIso } from '@/lib/utils';

export interface ActivityDraft { id?: string; version?: number; title: string; date: string; category: string | null; eval_area: string | null; quantity: number | string | null; unit_label: string; dollar_amount: number | string | null; dollar_type: string | null; result: string; organization: string; system: string; project_id: string | null; status: string; notes: string; evidence_links: Array<{ label?: string | null; url?: string | null }>; details: Record<string, string>; visibility: 'private' | 'unit'; unit_id: string | null }

export const emptyActivity = (defaults: Partial<ActivityDraft> = {}): ActivityDraft => ({
  title: '', date: todayIso(), category: null, eval_area: 'Unassigned', quantity: '', unit_label: '', dollar_amount: '', dollar_type: null, result: '', organization: '', system: '', project_id: null, status: 'completed', notes: '', evidence_links: [], details: {}, visibility: 'private', unit_id: null, ...defaults,
});
export const toActivityDraft = (a: Record<string, any>): ActivityDraft => ({ ...emptyActivity(), ...a, quantity: a.quantity ?? '', dollar_amount: a.dollar_amount ?? '', unit_label: a.unit_label || '', result: a.result || '', organization: a.organization || '', system: a.system || '', notes: a.notes || '', evidence_links: a.evidence_links || [], details: a.details && typeof a.details === 'object' ? a.details : {} });

/** The categories a work record can take: every one that is not itself a kind of its own. */
export const workCategories = (cfg: MetricsConfig) => categoryNames(cfg).filter((c) => kindFor(c).work);

/** The category a draft moves to when its kind changes. Going back to work keeps a work category it already had. */
export function categoryForKind(kind: RecordKind, current: string | null, cfg: MetricsConfig): string | null {
  if (!kind.work) return kind.category;
  if (current && kindFor(current).work) return current;
  const work = workCategories(cfg);
  return work.includes('Fiscal & Financial') ? 'Fiscal & Financial' : work[0] ?? null;
}

const PICKER_KINDS: RecordKind[] = [WORK_KIND, ...RECORD_KINDS];

/**
 * What kind of thing this record is. It is a radio group: one choice, arrow keys move it, and the
 * fields below change to the questions that fit.
 */
export function KindPicker({ value, onChange, className }: { value: RecordKind; onChange: (k: RecordKind) => void; className?: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const id = useId();
  const index = PICKER_KINDS.findIndex((k) => k.label === value.label);
  const move = (from: number, key: string) => {
    let next: number | null = null;
    if (key === 'ArrowRight' || key === 'ArrowDown') next = (from + 1) % PICKER_KINDS.length;
    else if (key === 'ArrowLeft' || key === 'ArrowUp') next = (from - 1 + PICKER_KINDS.length) % PICKER_KINDS.length;
    else if (key === 'Home') next = 0; else if (key === 'End') next = PICKER_KINDS.length - 1;
    if (next == null) return false;
    onChange(PICKER_KINDS[next]); refs.current[next]?.focus();
    return true;
  };
  return (
    <div className={className}>
      <p id={`${id}-label`} className="mb-1.5 text-xs font-semibold text-ink-2">Kind of record</p>
      <div role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={`${id}-blurb`} className="flex flex-wrap gap-1.5">
        {PICKER_KINDS.map((k, i) => {
          const on = i === index;
          return (
            <button key={k.label} ref={(el) => { refs.current[i] = el; }} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
              onClick={() => onChange(k)} onKeyDown={(e) => { if (move(i, e.key)) e.preventDefault(); }}
              className={cn('rounded-md border px-2.5 py-1 text-sm font-medium transition-colors', on ? 'border-accent bg-accent/10 text-ink' : 'border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink')}>
              {k.label}
            </button>
          );
        })}
      </div>
      <p id={`${id}-blurb`} className="mt-1.5 text-xs text-ink-3">{value.blurb}</p>
    </div>
  );
}

/** One of a kind's own questions, written into the column or detail it belongs to. */
export function KindFieldInput({ field, draft, set, errors }: { field: KindField; draft: ActivityDraft; set: (k: any, v: unknown) => void; errors: Record<string, string> }) {
  if (field.name === 'organization' || field.name === 'result') {
    return <Field label={field.label} hint={field.hint} error={errors[field.name]}><Input value={draft[field.name]} onChange={onText(set, field.name)} placeholder={field.placeholder} /></Field>;
  }
  if (field.name === 'quantity') {
    return <Field label={field.label} hint={field.hint} error={errors.quantity}><NumberInput value={draft.quantity ?? ''} onChange={onText(set, 'quantity')} placeholder={field.placeholder} /></Field>;
  }
  const key = field.name;
  const value = draft.details?.[key] ?? '';
  const put = (v: string) => set('details', { ...(draft.details || {}), [key]: v });
  return (
    <Field label={field.label} hint={field.hint} error={errors[`details.${key}`]}>
      <Input type={field.type === 'date' ? 'date' : 'text'} value={value} onChange={(e) => put(e.target.value)} placeholder={field.placeholder} />
    </Field>
  );
}

export function ActivityFields({ draft, set, errors }: { draft: ActivityDraft; set: (k: any, v: unknown) => void; errors: Record<string, string> }) {
  const track = useTrack();
  const cfg = useMetrics();
  const { data: projects } = useProjects();
  const links = draft.evidence_links || [];
  const setLink = (i: number, patch: Partial<{ label: string; url: string }>) => set('evidence_links', links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const kind = kindFor(draft.category);
  const pickKind = (k: RecordKind) => {
    if (k.label === kind.label) return;
    set('category', categoryForKind(k, draft.category, cfg));
    // A work unit ("ULOs") means nothing on a course, and "credits" nothing on a reconciliation.
    set('unit_label', k.work ? '' : k.unit || '');
  };
  const areaField = <Field label={trackMeta(track).areaLabel}><Select value={mapAreaToTrack(draft.eval_area, track)} onValueChange={(v) => set('eval_area', v)} options={areaOptions(track)} /></Field>;
  const statusField = <Field label="Status"><Select value={draft.status} onValueChange={(v) => set('status', v)} options={ACTIVITY_STATUS.map((s) => ({ value: s, label: humanize(s) }))} /></Field>;
  return (
    <>
      <KindPicker value={kind} onChange={pickKind} />
      {/* One title field for every kind, so changing the kind relabels it rather than rebuilding it. */}
      <Field label={kind.work ? 'Title' : kind.titleLabel} required error={errors.title}><Input autoFocus value={draft.title} onChange={onText(set, 'title')} placeholder={kind.titlePlaceholder} /></Field>
      {kind.work ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Date" error={errors.date}><Input type="date" value={draft.date || ''} onChange={onText(set, 'date')} /></Field>
            {statusField}
            <Field label="Category"><Select value={draft.category} onValueChange={(v) => set('category', v)} options={workCategories(cfg).map((c) => ({ value: c, label: c }))} placeholder="Pick a category" /></Field>
            {areaField}
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
        </>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={kind.dateLabel} error={errors.date}><Input type="date" value={draft.date || ''} onChange={onText(set, 'date')} /></Field>
            {statusField}
            {kind.fields.map((f) => <KindFieldInput key={f.name} field={f} draft={draft} set={set} errors={errors} />)}
            {areaField}
          </div>
        </>
      )}
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

/** What is sent: the draft cleaned up, holding only the answers its kind asks for. */
export const activityPayload = (d: ActivityDraft) => shapeForKind(d.category, {
  ...d,
  quantity: d.quantity === '' || d.quantity == null ? null : Number(String(d.quantity).replace(/[,\s]/g, '')),
  dollar_amount: d.dollar_amount === '' || d.dollar_amount == null ? null : Number(String(d.dollar_amount).replace(/[$,\s]/g, '')),
  evidence_links: (d.evidence_links || []).filter((l) => (l.url || '').trim() || (l.label || '').trim()),
});
