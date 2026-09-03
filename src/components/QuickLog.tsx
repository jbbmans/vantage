import { useContext, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ChevronDown, Sparkles, WifiOff, Zap } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Field, Input, NumberInput, Select, Textarea, Badge, Dot } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { parseQuickLog, primaryQuantity } from '../../shared/quickLog';
import { CATEGORIES, CATEGORY_COLORS, DOLLAR_TYPES, UNIT_SUGGESTIONS, EVAL_AREAS } from '../../shared/constants';
import { formatDollarsExact } from '../../shared/metrics';
import { strength, weaknesses, composeBullet } from '../../shared/bullets';
import { areaOptions, mapAreaToTrack, trackMeta } from '../../shared/evaluation';
import VisibilityPicker from '@/components/VisibilityPicker';
import { AiAction, ModelPicker } from '@/components/AiPanel';
import { useCreateRecord, useIdentity, usePrefs, useTrack } from '@/lib/queries';
import { draftKey, readDraft, writeDraft } from '@/lib/drafts';
import { errorText, isOffline } from '@/lib/api';
import { outbox } from '@/lib/outbox';
import { OutboxContext } from '@/components/AppShell';
import { cn } from '@/lib/utils';

const EXAMPLES = ['Reconciled 30 ULOs totaling $1,118.38 in DAI for G-8', 'Led 22 Marines through 58.5 hours of instruction, 100% graduation', 'Processed 12 MIPRs, zero returns'];

export default function QuickLog({ open, onOpenChange, initialText = '' }: { open: boolean; onOpenChange: (o: boolean) => void; initialText?: string }) {
  const track = useTrack();
  const { data: identity } = useIdentity();
  const prefs = usePrefs();
  const toast = useToast();
  const create = useCreateRecord('activities');
  const { pending } = useContext(OutboxContext);
  const [text, setText] = useState(initialText);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, unknown>>({});
  const key = draftKey(identity?.user.id, 'quicklog');

  useEffect(() => {
    if (!open) return;
    setText(initialText || readDraft<string>(key) || '');
    setOverrides({});
    setExpanded(Boolean(prefs.quickLogExpanded));
  }, [open, initialText, key, prefs.quickLogExpanded]);
  useEffect(() => { if (open) writeDraft(key, text.trim() ? text : null); }, [text, open, key]);

  const parsed = useMemo(() => (text.trim() ? parseQuickLog(text) : null), [text]);
  const record = useMemo(() => {
    if (!parsed) return null;
    const { quantity, unit } = primaryQuantity(parsed.quantities);
    return {
      title: parsed.title, date: format(parsed.date, 'yyyy-MM-dd'), category: parsed.category, eval_area: parsed.eval_area, quantity, unit_label: unit,
      dollar_amount: parsed.dollar_amount, dollar_type: parsed.dollar_type, system: parsed.system || '', organization: '', result: '', notes: '', status: 'completed',
      visibility: prefs.defaultVisibility || (identity?.primaryUnitId ? 'unit' : 'private'), unit_id: identity?.primaryUnitId || null,
      ...overrides,
    } as Record<string, any>;
  }, [parsed, overrides, prefs.defaultVisibility, identity?.primaryUnitId]);

  const set = (k: string) => (v: unknown) => setOverrides((o) => ({ ...o, [k]: v }));
  const setEvent = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(k)(e.target.value);

  const payload = () => record && ({
    ...record,
    quantity: record.quantity != null && record.quantity !== '' ? Number(record.quantity) : null,
    dollar_amount: record.dollar_amount != null && record.dollar_amount !== '' ? Number(String(record.dollar_amount).replace(/[$,]/g, '')) : null,
  });

  const save = async () => {
    if (!record?.title?.trim()) { toast.error('Give the entry a title before saving.'); return; }
    setSaving(true);
    const body = payload()!;
    try {
      await create.mutateAsync(body);
      toast.success('Activity logged.');
      writeDraft(key, null);
      onOpenChange(false);
    } catch (err) {
      if (isOffline(err) || !navigator.onLine) {
        await outbox.add(body, identity?.user.id || '');
        toast.info('You are offline. The entry is queued and will sync when the connection returns.');
        writeDraft(key, null);
        onOpenChange(false);
      } else toast.error(`${errorText(err)} Your text is kept here.`);
    } finally { setSaving(false); }
  };

  const applyAi = (out: Record<string, any>) => {
    const next: Record<string, unknown> = {};
    for (const [src, dst] of [['title', 'title'], ['date', 'date'], ['action_amount', 'quantity'], ['action_unit', 'unit_label'], ['transaction_value', 'dollar_amount'], ['organization', 'organization'], ['system', 'system'], ['result', 'result'], ['status', 'status']]) {
      if (out[src] != null && out[src] !== '') next[dst] = out[src];
    }
    if (CATEGORIES.includes(out.category)) next.category = out.category;
    if (EVAL_AREAS.includes(out.evaluation_area)) next.eval_area = out.evaluation_area;
    if (DOLLAR_TYPES.some((d) => d.key === out.dollar_type)) next.dollar_type = out.dollar_type;
    setOverrides((o) => ({ ...o, ...next }));
    setExpanded(true);
  };

  const s = record ? strength(record) : 0;
  const gaps = record ? weaknesses(record) : [];
  const offline = typeof navigator !== 'undefined' && !navigator.onLine;

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Log activity" description="Write it the way you'd say it. Vantage pulls out the numbers." variant="drawer" footer={
      <>
        <span className="mr-auto hidden text-2xs text-ink-3 sm:inline">⌘↵ to save{pending ? ` · ${pending} queued offline` : ''}</span>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" onClick={save} loading={saving} disabled={!text.trim()}>{offline ? <><WifiOff className="h-4 w-4" />Queue offline</> : 'Save activity'}</Button>
      </>
    }>
      <div className="space-y-4" onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); } }}>
        <Field label="What did you do?" hint="include the result, quantity, and value when you have them">
          <Textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday" className="text-md" />
        </Field>
        {!text.trim() && <div className="flex flex-wrap gap-1.5">{EXAMPLES.map((ex) => <button key={ex} type="button" onClick={() => setText(ex)} className="rounded-md border border-line px-2.5 py-1.5 text-left text-xs text-ink-2 transition-colors hover:border-line-strong hover:bg-surface-2">{ex}</button>)}</div>}
        {parsed && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex flex-wrap items-center gap-1.5"><Zap className="h-3.5 w-3.5 text-accent" />{parsed.inferred.map((chip) => <Badge key={chip} tone="accent">{chip}</Badge>)}</span>
              <span className="ml-auto flex items-center gap-2"><ModelPicker className="h-8 w-44 text-xs" /><AiAction workflow="quick_log" input={{ text }} label="Extract with AI" onResult={applyAi} /></span>
            </div>
            <div className="card p-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Date"><Input type="date" value={record!.date} onChange={setEvent('date')} /></Field>
                <Field label="Category"><Select value={record!.category} onValueChange={set('category')} options={CATEGORIES.map((c) => ({ value: c, label: c }))} /></Field>
                <Field label="Action amount" hint="how many"><NumberInput value={record!.quantity ?? ''} onChange={setEvent('quantity')} placeholder="30" /></Field>
                <Field label="Action unit"><><Input list="quicklog-units" value={record!.unit_label ?? ''} onChange={setEvent('unit_label')} placeholder="ULOs" /><datalist id="quicklog-units">{UNIT_SUGGESTIONS.map((u) => <option key={u} value={u} />)}</datalist></></Field>
                <Field label="Transaction value" hint="dollars tied to the action"><NumberInput value={record!.dollar_amount ?? ''} onChange={setEvent('dollar_amount')} placeholder="1118.38" /></Field>
                <Field label="Dollar type"><Select value={record!.dollar_type} onValueChange={set('dollar_type')} options={DOLLAR_TYPES.map((d) => ({ value: d.key, label: d.label }))} /></Field>
                <Field label={trackMeta(track).areaLabel}><Select value={mapAreaToTrack(record!.eval_area, track)} onValueChange={set('eval_area')} options={areaOptions(track)} /></Field>
                <Field label="Result" hint="the so-what"><Input value={record!.result} onChange={setEvent('result')} placeholder="cleared the aged backlog" /></Field>
              </div>
              <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-3 flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />{expanded ? 'Fewer fields' : 'Organization, system, notes, visibility'}</button>
              {expanded && (
                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Organization"><Input value={record!.organization} onChange={setEvent('organization')} placeholder="G-8" /></Field>
                  <Field label="System"><Input value={record!.system} onChange={setEvent('system')} placeholder="DAI" /></Field>
                  <div className="sm:col-span-2"><Field label="Notes"><Textarea rows={2} value={record!.notes} onChange={setEvent('notes')} /></Field></div>
                  <div className="sm:col-span-2"><VisibilityPicker value={record!.visibility} unitId={record!.unit_id} onChange={(v) => setOverrides((o) => ({ ...o, ...v }))} /></div>
                </div>
              )}
            </div>
            <div className="card p-4">
              <div className="mb-2 flex items-center justify-between"><span className="eyebrow">Bullet preview</span><span className="flex items-center gap-1" aria-label={`Strength ${s} of 4`}>{[0, 1, 2, 3].map((i) => <span key={i} className={cn('h-1.5 w-5 rounded-full', i < s ? 'bg-accent' : 'bg-surface-3')} />)}<span className="fig ml-1 text-2xs text-ink-3">{s}/4</span></span></div>
              <p className="flex items-start gap-2 text-base leading-relaxed text-ink"><Dot color={CATEGORY_COLORS[record!.category as keyof typeof CATEGORY_COLORS]} className="mt-2" /><span>{composeBullet(record!)}</span></p>
              {gaps.length > 0 && <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink-3"><Sparkles className="mt-0.5 h-3 w-3 shrink-0 text-accent" /><span>To strengthen: {gaps.join(' · ')}</span></p>}
              {record!.dollar_amount ? <p className="fig mt-2 text-2xs text-ink-3">Recorded to the cent as {formatDollarsExact(Number(String(record!.dollar_amount).replace(/[$,]/g, '')) || 0)}</p> : null}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
