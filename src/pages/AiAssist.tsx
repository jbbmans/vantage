import { useState } from 'react';
import { Sparkles, PenLine, ClipboardCheck, Target, ScanSearch } from 'lucide-react';
import { PageHeader, Panel, Field, Input, Select, Textarea, Tabs, EmptyState, Badge, Progress } from '@/components/ui/primitives';
import { AiAction, AiResult, ModelPicker, useAiModel } from '@/components/AiPanel';
import { useParam } from '@/components/common';
import { useAiStatus, useIdentity } from '@/lib/queries';
import { formatNumber } from '../../shared/metrics';

type Out = { output: Record<string, unknown>; meta: { model: string; tokens: number } } | null;

export default function AiAssist() {
  const { data: identity } = useIdentity();
  const { data: status } = useAiStatus();
  const [model] = useAiModel();
  const [tab, setTab] = useParam('tab', 'writing');
  const [kind, setKind] = useState('evaluation_bullet');
  const [source, setSource] = useState('');
  const [audience, setAudience] = useState('');
  const [limit, setLimit] = useState('1200');
  const [days, setDays] = useState('30');
  const [objective, setObjective] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [context, setContext] = useState('');
  const [out, setOut] = useState<Record<string, Out>>({});
  const setResult = (key: string) => (output: Record<string, unknown>, meta: { model: string; tokens: number }) => setOut((o) => ({ ...o, [key]: { output, meta } }));

  if (!identity?.instance.aiEnabled) return <div className="page"><PageHeader eyebrow="AI assist" title="Drafting help" /><div className="card"><EmptyState icon={Sparkles} title="AI assistance is off on this deployment" description="The owner enables it in the Owner console with a GenAI.mil key." /></div></div>;
  const daily = status?.daily;

  return (
    <div className="page max-w-5xl">
      <PageHeader eyebrow="AI assist" title="Drafting help" lede={`Through GenAI.mil, using ${model || 'the default model'}. Every result is a draft. Verify figures, dates, and references before you use them.`}>
        <ModelPicker className="w-52" />
      </PageHeader>
      {status?.locked && <div className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-ink">The GenAI.mil key is locked until the owner clears it. Requests will fail until then.</div>}
      {daily && <div className="mb-4 flex items-center gap-3 text-xs text-ink-3"><span>Today: {formatNumber(daily.requests)} requests · {formatNumber(daily.used_tokens)} of {formatNumber(daily.limit_tokens)} tokens</span><Progress value={daily.used_tokens} max={daily.limit_tokens} className="w-40" /></div>}
      <Tabs value={tab} onChange={setTab} className="mb-4" tabs={[{ value: 'writing', label: 'Writing' }, { value: 'review', label: 'Personal review' }, { value: 'quality', label: 'Record quality' }, { value: 'goal', label: 'Goal drafting' }]} />

      {tab === 'writing' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Turn facts into prose" subtitle="paste the raw facts; get a draft in the right register">
            <div className="space-y-3">
              <Field label="What are you writing?"><Select value={kind} onValueChange={setKind} options={[{ value: 'evaluation_bullet', label: 'Evaluation bullets' }, { value: 'award', label: 'Award citation' }, { value: 'counseling', label: 'Counseling notes' }, { value: 'email', label: 'Email' }, { value: 'executive_summary', label: 'Executive summary' }]} /></Field>
              <Field label="Source facts" required hint="numbers, dates, names, outcomes"><Textarea rows={8} value={source} onChange={(e) => setSource(e.target.value)} placeholder="Reconciled 30 ULOs totaling $1,118.38 in DAI. Closed FY with zero unresolved. Trained two Marines on the process." /></Field>
              <div className="grid grid-cols-2 gap-3"><Field label="Audience"><Input value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Reporting Senior" /></Field><Field label="Length limit (chars)"><Input inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} /></Field></div>
              <AiAction workflow="writing" input={{ kind, source, audience: audience || undefined, limit: Number(limit) || 1200 }} label="Draft" size="md" disabled={!source.trim()} onResult={setResult('writing')} />
            </div>
          </Panel>
          <Panel title="Draft">{out.writing ? <AiResult output={out.writing.output} meta={out.writing.meta} /> : <EmptyState icon={PenLine} title="No draft yet" description="Only the facts you paste are sent." />}</Panel>
        </div>
      )}
      {tab === 'review' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Where do I stand?" subtitle="reads your own entries, goals, and tasks">
            <div className="space-y-3"><Field label="Look back"><Select value={days} onValueChange={setDays} options={[{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '180', label: '180 days' }, { value: '365', label: 'A year' }]} /></Field>
              <AiAction workflow="personal_review" input={{ days: Number(days) }} label="Review my record" size="md" onResult={setResult('review')} />
              <p className="text-xs text-ink-3">Sends your own entries in the window, your goals, and open tasks. Nobody else's data.</p></div>
          </Panel>
          <Panel title="Review">{out.review ? <AiResult output={out.review.output} meta={out.review.meta} /> : <EmptyState icon={ClipboardCheck} title="No review yet" />}</Panel>
        </div>
      )}
      {tab === 'quality' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Which entries are weak?" subtitle="a coach for the last six months of entries">
            <div className="space-y-3"><AiAction workflow="record_quality" input={{ days: 180 }} label="Coach my entries" size="md" onResult={setResult('quality')} /><p className="text-xs text-ink-3">Points at entries missing a quantity, an outcome, or an area, with suggested rewrites. Compare with the rule-based checks on the <Badge>Dashboard</Badge>.</p></div>
          </Panel>
          <Panel title="Coaching">{out.quality ? <AiResult output={out.quality.output} meta={out.quality.meta} /> : <EmptyState icon={ScanSearch} title="No coaching yet" />}</Panel>
        </div>
      )}
      {tab === 'goal' && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Panel title="Make a goal measurable" subtitle="vague intent in, a target with a number out">
            <div className="space-y-3"><Field label="What do you want to accomplish?" required><Textarea rows={3} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Get better at the budget execution side of the job" /></Field>
              <div className="grid grid-cols-2 gap-3"><Field label="By when"><Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></Field><Field label="Context"><Input value={context} onChange={(e) => setContext(e.target.value)} placeholder="new billet, FY close in 2 months" /></Field></div>
              <AiAction workflow="goal_draft" input={{ objective, target_date: targetDate || null, context }} label="Draft goal" size="md" disabled={!objective.trim()} onResult={setResult('goal')} /></div>
          </Panel>
          <Panel title="Draft goal">{out.goal ? <AiResult output={out.goal.output} meta={out.goal.meta} /> : <EmptyState icon={Target} title="No draft yet" description="Add it on the Goals page once you agree with the number." />}</Panel>
        </div>
      )}
    </div>
  );
}
