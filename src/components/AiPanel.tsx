import { useState } from 'react';
import { Sparkles, WandSparkles, ShieldCheck, Copy } from 'lucide-react';
import { Button, Select } from '@/components/ui/primitives';
import { useAiStatus, usePrefs, useSavePrefs } from '@/lib/queries';
import * as api from '@/lib/api';
import { useToast } from '@/components/ui/toast';
import { copyToClipboard, humanize } from '@/lib/utils';

export function useAiModel(): [string, (m: string) => void, string[], boolean] {
  const { data } = useAiStatus();
  const prefs = usePrefs();
  const save = useSavePrefs();
  const models: string[] = data?.models || [];
  const current = prefs.aiModel && models.includes(prefs.aiModel) ? prefs.aiModel : data?.default_model || models[0] || '';
  return [current, (m) => save.mutate({ aiModel: m }), models, Boolean(data?.available)];
}

export function ModelPicker({ className }: { className?: string }) {
  const [model, setModel, models] = useAiModel();
  if (models.length < 2) return null;
  return <Select aria-label="AI model" className={className} value={model} onValueChange={setModel} options={models.map((m) => ({ value: m, label: m }))} />;
}

/** Inline AI action: one button that runs a workflow with the user's chosen model and hands back parsed output. */
export function AiAction({ workflow, input, label = 'Draft with AI', onResult, size = 'sm', disabled }: { workflow: string; input: unknown; label?: string; onResult: (output: Record<string, any>, meta: { model: string; tokens: number }) => void; size?: 'xs' | 'sm' | 'md'; disabled?: boolean }) {
  const [model, , , available] = useAiModel();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (!available) return null;
  const run = async () => {
    setBusy(true);
    try {
      const res = await api.aiAssist(workflow, input, model);
      onResult(res.output || {}, { model: res.model, tokens: res.usage?.total_tokens || 0 });
      toast.success(`Drafted with ${res.model}. Verify every fact before saving.`);
    } catch (err) { toast.error(api.errorText(err)); }
    finally { setBusy(false); }
  };
  return <Button size={size} variant="soft" onClick={run} loading={busy} disabled={disabled}><Sparkles className="h-3.5 w-3.5" />{busy ? 'Drafting…' : label}</Button>;
}

export function AiResultValue({ value }: { value: unknown }) {
  if (value == null || value === '') return <span className="text-ink-3">Not provided</span>;
  if (Array.isArray(value)) return value.length ? <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-2">{value.map((v, i) => <li key={i}>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</li>)}</ul> : <span className="text-ink-3">None</span>;
  if (typeof value === 'object') return <div className="space-y-2">{Object.entries(value as Record<string, unknown>).map(([k, v]) => <div key={k} className="rounded-md border border-line px-3 py-2"><p className="eyebrow">{humanize(k)}</p><div className="mt-1"><AiResultValue value={v} /></div></div>)}</div>;
  return <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-2">{String(value)}</p>;
}

export function AiResult({ output, meta, primaryKey }: { output: Record<string, unknown>; meta?: { model: string; tokens: number }; primaryKey?: string }) {
  const toast = useToast();
  const preferred = primaryKey && output[primaryKey] ? output[primaryKey] : output.draft || output.narrative || output.citation || output.executive_summary || output.summary || output.plain_language;
  return (
    <div className="rounded-lg border border-accent/30 bg-accent-soft/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink"><WandSparkles className="h-4 w-4 text-accent" />AI suggestion{meta && <span className="text-xs font-normal text-ink-3">{meta.model} · {meta.tokens} tokens</span>}</p>
        {Boolean(preferred) && <Button size="xs" variant="ghost" onClick={async () => { if (await copyToClipboard(String(preferred))) toast.success('Copied.'); else toast.error('Could not copy.'); }}><Copy className="h-3.5 w-3.5" />Copy</Button>}
      </div>
      <div className="space-y-3">{Object.entries(output).map(([k, v]) => <section key={k}><h4 className="eyebrow mb-1">{humanize(k)}</h4><AiResultValue value={v} /></section>)}</div>
      <p className="mt-3 flex items-start gap-2 border-t border-accent/20 pt-2 text-2xs leading-relaxed text-ink-3"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />Suggestion only. Check every fact, figure, date, and reference before use. Nothing is saved automatically.</p>
    </div>
  );
}
