import React, { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Sparkles, ChevronDown, Zap } from 'lucide-react';
import { Dialog } from '@/components/ui/Dialog';
import { Button, Field, Input, NumberInput, Select, Textarea, Badge, Dot } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { parseQuickLog, primaryQuantity } from '@/lib/quickLogParser';
import { createRecord } from '@/store/useStore';
import { errorText, trackExperience } from '@/lib/api';
import { CATEGORIES, CATEGORY_COLORS, JEPES_AREAS, DOLLAR_TYPES, UNIT_SUGGESTIONS } from '@/lib/constants';
import { formatDollarsExact } from '@/lib/metrics';
import { strength, weaknesses, composeBullet } from '@/lib/bullets';
import VisibilityPicker, { DEFAULT_VISIBILITY } from '@/components/VisibilityPicker';
import { areaOptions, mapAreaToTrack, trackMeta } from '@/lib/evaluation';
import { useEvalTrack, useIdentity, usePrefs } from '@/store/useStore';
import { cn } from '@/lib/utils';
import { draftKey } from '@/lib/drafts';

const EXAMPLES = [
  'Reconciled 30 ULOs totaling $1,118.38 in DAI for G-8',
  'Led 22 Marines through 58.5 hours of instruction, 100% graduation',
  'Processed 12 MIPRs, zero returns',
];

export default function QuickLog({ open, onOpenChange, initialText = '' }) {
  const track = useEvalTrack();
  const identity = useIdentity();
  const prefs = usePrefs();
  const toast = useToast();
  const [text, setText] = useState(initialText);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [overrides, setOverrides] = useState({});

  const DRAFT_KEY = draftKey(identity?.user?.id, 'quicklog');
  useEffect(() => {
    if (open) {
      let stored = '';
      try { stored = sessionStorage.getItem(DRAFT_KEY) || ''; } catch {}
      setText(initialText || stored);
      setOverrides({});
      setExpanded(Boolean(prefs.interface?.quickLogExpanded));
    }
  }, [open, initialText, DRAFT_KEY, prefs.interface?.quickLogExpanded]);

  useEffect(() => {
    if (!open) return;
    try {
      if (text.trim()) sessionStorage.setItem(DRAFT_KEY, text);
      else sessionStorage.removeItem(DRAFT_KEY);
    } catch {}
  }, [text, open, DRAFT_KEY]);

  const parsed = useMemo(() => (text.trim() ? parseQuickLog(text) : null), [text]);

  const record = useMemo(() => {
    if (!parsed) return null;
    const { quantity, unit } = primaryQuantity(parsed.quantities);
    return {
      title: parsed.title,
      date: format(parsed.date, 'yyyy-MM-dd'),
      category: parsed.category,
      jepes_area: parsed.jepes_area,
      quantity,
      unit,
      dollar_amount: parsed.dollar_amount,
      dollar_type: parsed.dollar_type,
      system: parsed.system || '',
      organization: '',
      result: '',
      notes: '',
      status: 'completed',
      visibility: DEFAULT_VISIBILITY,
      ...overrides,
    };
  }, [parsed, overrides]);

  const set = (key) => (value) => setOverrides((o) => ({ ...o, [key]: value }));
  const setEvent = (key) => (e) => set(key)(e.target.value);

  const save = async () => {
    if (!record?.title?.trim()) {
      toast.error('Give the entry a title before saving.');
      return;
    }
    setSaving(true);
    try {
      await createRecord('activities', {
        ...record,
        quantity: record.quantity != null && record.quantity !== '' ? Number(record.quantity) : null,
        dollar_amount:
          record.dollar_amount != null && record.dollar_amount !== ''
            ? Number(String(record.dollar_amount).replace(/[$,]/g, ''))
            : null,
      });
      toast.success('Activity logged.');
      trackExperience('quick_log_saved');
      try { sessionStorage.removeItem(DRAFT_KEY); } catch {}
      onOpenChange(false);
    } catch (err) {
      toast.error(`${errorText(err) || 'Could not save that entry.'} Your text is kept right here.`);
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  };

  const s = record ? strength(record) : 0;
  const gaps = record ? weaknesses(record) : [];

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Log activity"
      description="Write it the way you'd say it. Vantage pulls out the numbers."
      size="lg"
      variant="drawer"
      footer={
        <>
          <span className="fig mr-auto text-2xs text-text-3">⌘↵ to save</span>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={save} disabled={saving || !text.trim()}>
            {saving ? 'Saving…' : 'Save activity'}
          </Button>
        </>
      }
    >
      <div onKeyDown={onKeyDown} className="space-y-3">
        <Textarea
          autoFocus
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday"
          className="text-md"
        />

        {!text.trim() && (
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setText(ex)}
                className="rounded border border-rule px-2 py-1 text-left text-xs text-text-3 transition-colors hover:border-rule-strong hover:text-text-2"
              >
                {ex}
              </button>
            ))}
          </div>
        )}

        {parsed && (
          <>

            <div className="flex flex-wrap items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-signal" />
              {parsed.inferred.map((chip) => (
                <Badge key={chip} tone="signal">
                  {chip}
                </Badge>
              ))}
            </div>

            <div className="panel rounded p-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label="Date">
                  <Input type="date" value={record.date} onChange={setEvent('date')} />
                </Field>
                <Field label="Action amount" hint="how many items or actions you completed">
                  <NumberInput
                    value={record.quantity ?? ''}
                    onChange={setEvent('quantity')}
                    placeholder="—"
                  />
                </Field>
                <Field label="Action unit">
                  <Input
                    list="unit-suggestions"
                    value={record.unit ?? ''}
                    onChange={setEvent('unit')}
                    placeholder="ULOs"
                  />
                  <datalist id="unit-suggestions">
                    {UNIT_SUGGESTIONS.map((u) => (
                      <option key={u} value={u} />
                    ))}
                  </datalist>
                </Field>
                <Field label="Transaction value" hint="the dollar value tied to the action — separate from action amount">
                  <NumberInput
                    value={record.dollar_amount ?? ''}
                    onChange={setEvent('dollar_amount')}
                    placeholder="—"
                  />
                </Field>
                <Field label="Category">
                  <Select
                    value={record.category}
                    onValueChange={set('category')}
                    options={CATEGORIES.map((c) => ({ value: c, label: c }))}
                  />
                </Field>
                <Field label={trackMeta(track).areaLabel}>
                  <Select
                    value={mapAreaToTrack(record.jepes_area, track)}
                    onValueChange={set('jepes_area')}
                    options={areaOptions(track)}
                  />
                </Field>
                <Field label="Dollar type" hint="what happened to the transaction value">
                  <Select
                    value={record.dollar_type}
                    onValueChange={set('dollar_type')}
                    options={DOLLAR_TYPES.map((d) => ({ value: d.key, label: d.label }))}
                  />
                </Field>
                <Field label="Organization">
                  <Input value={record.organization} onChange={setEvent('organization')} placeholder="G-8" />
                </Field>
                <Field label="System">
                  <Input value={record.system} onChange={setEvent('system')} placeholder="DAI" />
                </Field>
                <div className="sm:col-span-2">
                  <VisibilityPicker value={record.visibility} onChange={set('visibility')} />
                </div>
              </div>

              <button
                onClick={() => setExpanded((v) => !v)}
                className="mt-3 flex items-center gap-1 text-xs text-text-3 hover:text-text-2"
              >
                <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
                {expanded ? 'Fewer fields' : 'Outcome and notes'}
              </button>

              {expanded && (
                <div className="mt-3 space-y-3">
                  <Field label="Result" hint="the 'so what' — this is what makes the bullet land">
                    <Input
                      value={record.result}
                      onChange={setEvent('result')}
                      placeholder="cleared the section's aged ULO backlog"
                    />
                  </Field>
                  <Field label="Notes">
                    <Textarea rows={2} value={record.notes} onChange={setEvent('notes')} />
                  </Field>
                </div>
              )}
            </div>

            <div className="panel rounded p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="eyebrow">Bullet preview</span>
                <div className="flex items-center gap-1">
                  {[0, 1, 2, 3].map((i) => (
                    <span
                      key={i}
                      className={cn('h-1 w-4 rounded-sm', i < s ? 'bg-signal' : 'bg-rule')}
                      aria-hidden
                    />
                  ))}
                  <span className="fig ml-1 text-2xs text-text-3">{s}/4</span>
                </div>
              </div>
              <p className="flex items-start gap-2 text-base leading-relaxed text-text">
                <Dot color={CATEGORY_COLORS[record.category]} className="mt-1.5" />
                <span>{composeBullet(record)}</span>
              </p>
              {gaps.length > 0 && (
                <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-text-3">
                  <Zap className="mt-0.5 h-3 w-3 shrink-0 text-signal/70" />
                  <span>To strengthen: {gaps.join(' · ')}</span>
                </p>
              )}
              {record.dollar_amount ? (
                <p className="fig mt-2 text-2xs text-text-3">
                  Transaction value recorded to the cent as {formatDollarsExact(Number(String(record.dollar_amount).replace(/[$,]/g, '')) || 0)}
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
