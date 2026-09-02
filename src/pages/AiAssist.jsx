import React, { useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, Clipboard, LockKeyhole, ShieldCheck, Sparkles, WandSparkles } from 'lucide-react';
import * as api from '@/lib/api';
import { PERMISSIONS, useEvalTrack, useIdentity, useOrg } from '@/store/useStore';
import { Badge, Button, EmptyState, Field, Input, Panel, Select, Textarea } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';

const WORKFLOWS = [
  { id: 'personal_review', label: 'Personal review', description: 'Turn your own recent activity, goals, and tasks into a factual review.' },
  { id: 'report_narrative', label: 'Evaluation narrative', description: 'Draft a JEPES or FITREP narrative from your own selected-period records.' },
  { id: 'record_quality', label: 'Record quality', description: 'Find weak or incomplete entries without changing them.' },
  { id: 'goal_draft', label: 'Goal builder', description: 'Convert an objective into a measurable goal and milestones.' },
  { id: 'writing', label: 'Writing desk', description: 'Draft an evaluation bullet, award input, counseling, email, or executive summary.' },
  { id: 'command_brief', label: 'Command brief', description: 'Explain exact-unit aggregate totals; no names or private records are sent.' },
];

const WRITING_KINDS = [
  { value: 'evaluation_bullet', label: 'Evaluation bullet' },
  { value: 'award', label: 'Award input' },
  { value: 'counseling', label: 'Counseling draft' },
  { value: 'email', label: 'Professional email' },
  { value: 'executive_summary', label: 'Executive summary' },
];

const human = (value) => String(value || '').replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());

function ResultValue({ value }) {
  if (value == null || value === '') return <span className="text-text-3">Not provided</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-text-3">None</span>;
    return (
      <ul className="space-y-1.5">
        {value.map((item, index) => (
          <li key={index} className="flex items-start gap-2 text-sm leading-relaxed text-text-2">
            <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-signal" />
            <span>{typeof item === 'object' ? JSON.stringify(item) : String(item)}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === 'object') return (
    <div className="space-y-2">
      {Object.entries(value).map(([key, item]) => (
        <div key={key} className="rounded border border-rule px-3 py-2">
          <p className="eyebrow">{human(key)}</p>
          <div className="mt-1"><ResultValue value={item} /></div>
        </div>
      ))}
    </div>
  );
  return <p className="whitespace-pre-wrap text-base leading-relaxed text-text-2">{String(value)}</p>;
}

function AiResult({ result }) {
  const toast = useToast();
  if (!result) return null;
  const copy = async () => {
    const preferred = result.output?.draft || result.output?.narrative || result.output?.executive_summary
      || result.output?.summary || result.output?.plain_language || JSON.stringify(result.output, null, 2);
    try {
      await navigator.clipboard.writeText(String(preferred));
      toast.success('AI suggestion copied.');
    } catch { toast.error('Could not copy the suggestion.'); }
  };
  return (
    <Panel
      title="Generated suggestion"
      subtitle={`${result.model} · ${result.usage?.total_tokens || 0} tokens`}
      action={<Button size="sm" onClick={copy}><Clipboard className="h-3.5 w-3.5" /> Copy</Button>}
    >
      <div className="space-y-4">
        {Object.entries(result.output || {}).map(([key, value]) => (
          <section key={key}>
            <h3 className="eyebrow mb-1.5">{human(key)}</h3>
            <ResultValue value={value} />
          </section>
        ))}
        <p className="flex items-start gap-2 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ledger" />
          Suggestion only. Check every fact, figure, date, policy reference, and conclusion before use.
        </p>
      </div>
    </Panel>
  );
}

export default function AiAssist() {
  const toast = useToast();
  const identity = useIdentity();
  const org = useOrg();
  const track = useEvalTrack();
  const [status, setStatus] = useState(null);
  const [workflow, setWorkflow] = useState('personal_review');
  const [input, setInput] = useState({ days: '30', track, character_limit: '1250', kind: 'evaluation_bullet' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.aiStatus().then(setStatus).catch(() => setStatus({ enabled: false, available: false }));
  }, []);

  const commandUnits = useMemo(() => {
    const exportBit = PERMISSIONS.EXPORT_DATA;
    return (org.units || []).filter((unit) => {
      const bits = identity?.permissions?.[unit.id] || 0;
      return Boolean(bits & PERMISSIONS.ADMINISTRATOR) || Boolean(bits & exportBit);
    }).map((unit) => ({ value: unit.id, label: unit.short_name || unit.name }));
  }, [identity?.permissions, org.units]);

  useEffect(() => {
    if (workflow === 'command_brief' && !input.unit_id && commandUnits[0]) {
      setInput((current) => ({ ...current, unit_id: commandUnits[0].value }));
    }
  }, [workflow, commandUnits, input.unit_id]);

  const selectWorkflow = (id) => {
    setWorkflow(id);
    setResult(null);
  };

  const set = (key, value) => setInput((current) => ({ ...current, [key]: value }));
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      const next = await api.aiAssist(workflow, input);
      setResult(next);
      toast.success('AI suggestion generated. Review it before use.');
    } catch (error) {
      toast.error(api.errorText(error));
      if (['ai_key_locked', 'ai_disabled', 'ai_not_configured'].includes(error.code)) {
        api.aiStatus().then(setStatus).catch(() => {});
      }
    } finally { setBusy(false); }
  };

  const current = WORKFLOWS.find((row) => row.id === workflow);
  const disabled = !status?.available || (workflow === 'command_brief' && !commandUnits.length);

  return (
    <div className="page-canvas">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
        <div>
          <div className="flex items-center gap-2">
            <p className="eyebrow">GenAI.mil · human-reviewed</p>
            <Badge tone={status?.locked ? 'redline' : status?.available ? 'ledger' : 'neutral'}>{status?.locked ? 'Key locked' : status?.available ? 'Available' : 'Unavailable'}</Badge>
          </div>
          <h2 className="mt-2 text-3xl font-medium tracking-tight text-text sm:text-4xl">AI assist</h2>
          <p className="mt-1.5 max-w-2xl text-base text-text-3">Draft, extract, and analyze inside VANTAGE without giving AI authority to save records or make personnel decisions.</p>
        </div>
        <div className="text-right">
          <p className="eyebrow">Your daily use</p>
          <p className="fig mt-1 text-sm text-text-2">{status?.daily?.used_tokens || 0} / {status?.daily?.limit_tokens || '—'} tokens</p>
        </div>
      </div>

      {(!status?.available || status?.locked) && (
        <div className="mt-4 flex items-start gap-3 rounded-xl border border-rule bg-panel p-4">
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-text-3" />
          <div>
            <p className="text-sm font-medium text-text">{status?.locked ? 'GenAI.mil key is locked' : 'AI assistance is not available'}</p>
            <p className="mt-1 text-xs leading-relaxed text-text-3">
              {status?.locked
                ? 'The Instance Operator must use the Owner Console unlock link. After unlocking, retry the request.'
                : 'An Instance Operator must enable AI and configure the server-held GenAI.mil key.'}
            </p>
          </div>
        </div>
      )}

      <div className="mt-5 grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <nav className="space-y-2" aria-label="AI workflows">
          {WORKFLOWS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => selectWorkflow(item.id)}
              className={`w-full rounded-xl border p-3 text-left transition ${workflow === item.id ? 'border-signal bg-signal/10' : 'border-rule bg-panel hover:border-rule-strong'}`}
            >
              <span className="text-sm font-medium text-text">{item.label}</span>
              <span className="mt-1 block text-xs leading-relaxed text-text-3">{item.description}</span>
            </button>
          ))}
        </nav>

        <div className="min-w-0 space-y-4">
          <Panel title={current?.label} subtitle={current?.description}>
            <div className="space-y-4">
              {(workflow === 'personal_review' || workflow === 'record_quality') && (
                <Field label="Review window">
                  <Select value={String(input.days || '30')} onValueChange={(value) => set('days', value)} options={[
                    { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' },
                    { value: '180', label: 'Last 180 days' }, { value: '365', label: 'Last year' },
                  ]} />
                </Field>
              )}

              {workflow === 'report_narrative' && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Evaluation track">
                    <Select value={input.track || track} onValueChange={(value) => set('track', value)} options={[
                      { value: 'jepes', label: 'JEPES' }, { value: 'fitrep', label: 'FITREP' },
                    ]} />
                  </Field>
                  <Field label="Character limit"><Input type="number" min="300" max="5000" value={input.character_limit || ''} onChange={(event) => set('character_limit', event.target.value)} /></Field>
                  <Field label="Period start"><Input type="date" value={input.from || ''} onChange={(event) => set('from', event.target.value)} /></Field>
                  <Field label="Period end"><Input type="date" value={input.to || ''} onChange={(event) => set('to', event.target.value)} /></Field>
                </div>
              )}

              {workflow === 'goal_draft' && (
                <>
                  <Field label="Objective" hint="what success should look like"><Textarea rows={4} value={input.objective || ''} onChange={(event) => set('objective', event.target.value)} placeholder="Improve ULO follow-up speed while maintaining accurate documentation…" /></Field>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Target date"><Input type="date" value={input.target_date || ''} onChange={(event) => set('target_date', event.target.value)} /></Field>
                    <Field label="Current context"><Input value={input.context || ''} onChange={(event) => set('context', event.target.value)} placeholder="Current baseline or constraint" /></Field>
                  </div>
                </>
              )}

              {workflow === 'writing' && (
                <>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Document type"><Select value={input.kind || 'evaluation_bullet'} onValueChange={(value) => set('kind', value)} options={WRITING_KINDS} /></Field>
                    <Field label="Audience"><Input value={input.audience || ''} onChange={(event) => set('audience', event.target.value)} placeholder="SNCOIC, G-8, general officer…" /></Field>
                    <Field label="Maximum characters"><Input type="number" min="100" max="5000" value={input.limit || '1200'} onChange={(event) => set('limit', event.target.value)} /></Field>
                  </div>
                  <Field label="Source facts" hint="AI is instructed not to add facts"><Textarea rows={8} value={input.source || ''} onChange={(event) => set('source', event.target.value)} placeholder="Paste the verified facts, figures, dates, and desired outcome…" /></Field>
                </>
              )}

              {workflow === 'command_brief' && (
                commandUnits.length ? (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Exact unit"><Select value={input.unit_id || ''} onValueChange={(value) => set('unit_id', value)} options={commandUnits} /></Field>
                    <Field label="Period start"><Input type="date" value={input.from || ''} onChange={(event) => set('from', event.target.value)} /></Field>
                    <Field label="Period end"><Input type="date" value={input.to || ''} onChange={(event) => set('to', event.target.value)} /></Field>
                  </div>
                ) : <EmptyState icon={LockKeyhole} title="No authorized unit" description="Command briefs require the Export data permission in one exact unit." />
              )}

              <div className="rounded-lg border border-rule bg-panel-2/45 p-3 text-xs leading-relaxed text-text-3">
                Do not submit classified information or material outside the approved GenAI.mil handling boundary. VANTAGE excludes names, attachments, evidence links, and private notes from record-driven prompts.
              </div>
              <Button variant="primary" size="md" onClick={run} disabled={busy || disabled}>
                {busy ? <Sparkles className="h-4 w-4 animate-pulse" /> : <WandSparkles className="h-4 w-4" />}
                {busy ? 'Generating…' : 'Generate suggestion'}
              </Button>
            </div>
          </Panel>

          {result ? <AiResult result={result} /> : (
            <Panel>
              <EmptyState icon={Bot} title="No AI output yet" description="Choose a workflow, review what data it uses, and generate a suggestion." />
            </Panel>
          )}

          <div className="flex items-start gap-2 text-xs leading-relaxed text-text-3">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ledger" />
            Prompt and response text are not stored in VANTAGE audit logs. Workflow, model, token count, request ID, and success or failure are recorded for accountability.
          </div>
        </div>
      </div>
    </div>
  );
}
