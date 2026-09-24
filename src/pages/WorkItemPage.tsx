import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, BookOpen, Calculator, Check, CheckCircle2, ChevronDown, Circle, CircleDot, FileSpreadsheet, FlaskConical, Hand,
  History, Info, OctagonAlert, PenLine, Send, SkipForward, UserRoundPlus, Users,
} from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, NumberInput, Panel, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText } from '@/components/common';
import { StageBadge, elapsed, personName } from '@/components/work';
import { ThreadsForItem } from './Workbench';
import { useIdentity, useMetrics, useWorkItem, invalidateWork } from '@/lib/queries';
import * as api from '@/lib/api';
import { cn, timeAgo, todayIso } from '@/lib/utils';
import {
  STAGE_LABEL, WAITING_CATEGORIES, WAITING_LABEL, FUNDS_CHECK_RESULTS, EXTERNAL_EVENTS, VALUE_SOURCES,
  describeEvent, type Stage,
} from '../../shared/caseModel';
import { AUTHORITY_LABEL, type Procedure, type ProcedureStep } from '../../shared/procedures';
import { formatCents } from '../../shared/money';
import { fmraResponsibilitiesForStep, fmraResponsibilityLabel, profileHasResponsibility, type FMRAProfileEntry } from '../../shared/fmra';

/**
 * One piece of work, on its own page, with everything needed to decide and act.
 *
 * The procedure shows where the case stands and what comes next; the form below it asks only for
 * what the current step needs. Experienced analysts can go straight to any step, or add any kind of
 * entry, without a wizard in the way. Every entry lands in the history with who made it and where
 * the value came from.
 */

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export default function WorkItemPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { data: identity } = useIdentity();
  const detail = useWorkItem(id);
  const [focusStep, setFocusStep] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [stageOpen, setStageOpen] = useState<Stage | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => invalidateWork(qc, id);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try { await fn(); if (done) toast.success(done); refresh(); return true; }
    catch (e) { toast.error(api.errorText(e)); refresh(); return false; }
    finally { setBusy(false); }
  };

  if (detail.isPending) {
    return <div className="page space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-12 w-2/3" /><div className="grid gap-4 xl:grid-cols-[1fr_340px]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div></div>;
  }
  if (detail.isError || !detail.data) {
    const status = (detail.error as { status?: number } | null)?.status;
    return (
      <div className="page"><div className="card"><EmptyState
        title={status === 403 ? 'This work is not yours to open' : 'This work item is not available'}
        description={status === 403 ? 'It belongs to a unit you are not in, or it was never shared with you.' : api.errorText(detail.error)}
        action={<Button onClick={() => navigate('/work')}>Back to Work</Button>}
      /></div></div>
    );
  }

  const { item, case: c, source, project } = detail.data;
  const me = identity?.user.id;
  const holding = item.claimed_by === me;
  const holder = item.claimed_by ? c.people[item.claimed_by] : null;
  const closed = c.stage === 'resolved' || c.stage === 'not_applicable';
  const procedure: (Procedure & { pinned_version: string }) | null = c.procedure;
  const steps = procedure?.steps || [];
  const progress = c.progress as { steps: Array<{ key: string; status: string; note: string | null; evidence: string[] }>; next: string | null } | null;
  const activeKey = focusStep || progress?.next || null;
  const activeStep = steps.find((s) => s.key === activeKey) || null;
  const activeStatus = progress?.steps.find((s) => s.key === activeKey) || null;
  const flagship = identity?.demo && identity.demo.flagship.reference === item.reference ? identity.demo.flagship : null;
  const iContributed = c.contributors.some((p: any) => p.user_id === me);

  return (
    <div className="page">
      <Link to="/work" className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />Work</Link>

      <header className="mb-5">
        <p className="eyebrow mb-2 flex flex-wrap items-center gap-x-2">
          {project ? <span>{project.name}</span> : null}
          {project ? <span aria-hidden>·</span> : null}
          <span className="fig">{item.reference || item.natural_key}</span>
        </p>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <h1 className="min-w-0 flex-1 basis-[28rem] text-2xl font-semibold leading-tight tracking-tight text-ink">{item.title}</h1>
          <div className="flex flex-wrap items-center gap-2">
            {!item.claimed_by && !closed && c.permissions.claim && (
              <Button variant="primary" loading={busy} onClick={() => run(() => api.claimWorkItem(id, item.version), 'It is yours. It is on your assigned list now.')}><Hand className="h-4 w-4" />Claim</Button>
            )}
            {!closed && c.permissions.hand_off && item.claimed_by && <Button onClick={() => setHandoffOpen(true)}><UserRoundPlus className="h-4 w-4" />Hand off</Button>}
            {holding && !closed && <Button variant="ghost" loading={busy} onClick={() => run(() => api.releaseWorkItem(id, item.version), 'Released back to the queue.')}>Release</Button>}
            {(c.permissions.progress || c.permissions.resolve) && (
              <Select
                key={stageOpen || 'closed'}
                aria-label="Move to stage" placeholder="Move to…" className="w-48" value=""
                onValueChange={(v) => { if (v) setStageOpen(v as Stage); }}
                options={(['researching', 'ready_for_action', 'waiting', 'blocked', 'verification_required', 'resolved', 'not_applicable'] as Stage[])
                  .filter((s) => s !== c.stage || s === 'waiting')
                  .map((s) => ({ value: s, label: STAGE_LABEL[s] }))}
              />
            )}
          </div>
        </div>
        <dl className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <div className="flex items-center gap-2"><dt className="sr-only">Stage</dt><dd><StageBadge stage={c.stage} waiting={c.waiting?.category} /></dd></div>
          {c.waiting?.since && <div className="text-ink-3"><dt className="sr-only">Waiting</dt><dd>Waiting {elapsed(c.waiting.since)} (elapsed, not work)</dd></div>}
          {c.blocked_reason && <div className="text-bad"><dt className="sr-only">Blocked</dt><dd className="flex items-center gap-1.5"><OctagonAlert className="h-4 w-4" aria-hidden />{c.blocked_reason}</dd></div>}
          <div className="text-ink-2"><dt className="inline text-ink-3">Held by </dt><dd className="inline font-medium text-ink">{holding ? 'You' : holder ? personName(holder) : 'Nobody yet'}</dd></div>
          {item.due_date && <div className="text-ink-2"><dt className="inline text-ink-3">Due </dt><dd className="inline"><DateText value={item.due_date} /></dd></div>}
          {item.amount != null && <div className="text-ink-2"><dt className="inline text-ink-3">Amount on the sheet </dt><dd className="fig inline font-medium text-ink">{formatCents(Math.round(Number(item.amount) * 100))}</dd></div>}
        </dl>
      </header>

      {flagship && (
        <section aria-labelledby="synthetic-values" className="mb-4 rounded-lg border border-accent/30 bg-accent-soft/40 p-4">
          <h2 id="synthetic-values" className="flex items-center gap-2 text-sm font-semibold text-ink"><FlaskConical className="h-4 w-4 text-accent" aria-hidden />Synthetic system values for this walkthrough</h2>
          <p className="mt-1 text-xs text-ink-2">{flagship.note} {flagship.scenario}</p>
          <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {flagship.values.map((v) => (
              <div key={v.label} className="rounded-md border border-line bg-surface px-3 py-2">
                <dt className="text-xs text-ink-3">{v.label}</dt>
                <dd className="fig mt-0.5 font-semibold text-ink">{v.display}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-4">
          {!holding && !closed && (
            <div className="card flex flex-wrap items-center gap-3 p-4 text-sm text-ink-2">
              <Info className="h-4 w-4 shrink-0 text-accent" aria-hidden />
              <span className="flex-1">{item.claimed_by ? `${personName(holder)} is working this. You can read everything; recording on it is theirs to do.` : 'Claim this to work it. It goes on your assigned list at once; claiming alone is not credit for anything.'}</span>
            </div>
          )}

          {procedure && activeStep && (
            <StepPanel
              key={activeStep.key}
              itemId={id}
              step={activeStep}
              status={activeStatus}
              caseData={c}
              canAct={c.permissions.act && !closed}
              focused={Boolean(focusStep)}
              onBackToNext={() => setFocusStep(null)}
              onDone={() => { setFocusStep(null); refresh(); }}
              onResolve={() => setStageOpen('resolved')}
            />
          )}

          {c.latest_calculation && <CalculationPanel calc={c.latest_calculation} events={c.events} />}

          {!procedure && holding && !closed && <ActionForm itemId={id} item={item} onDone={refresh} />}

          {c.permissions.act && !closed && <EntryComposer itemId={id} procedure={procedure} onDone={refresh} />}

          <HistoryPanel events={c.events} people={c.people} procedure={procedure} />
        </div>

        <aside className="space-y-4" aria-label="About this work">
          {procedure && progress && (
            <ProcedurePanel procedure={procedure} progress={progress} active={activeKey} profile={identity?.prefs.fmraResponsibilities || []} onPick={(k) => setFocusStep(k === progress.next ? null : k)} />
          )}

          <Panel title="Who worked this" subtitle="Each person’s own entries. Nobody is credited with anyone else’s.">
            {c.contributors.length === 0 ? <p className="text-sm text-ink-3">Nobody has recorded anything on this yet.</p> : (
              <ul className="space-y-2.5">
                {c.contributors.map((p: any) => (
                  <li key={p.user_id} className="text-sm">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium text-ink">{p.user_id === me ? 'You' : [p.rank, p.name].filter(Boolean).join(' ')}</span>
                      <span className="text-xs text-ink-3">last {timeAgo(p.last_at)}</span>
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-3">
                      {[p.research && `${p.research} research`, p.submitted && `${p.submitted} submitted`, p.verified && `${p.verified} verified`, p.handoffs && `${p.handoffs} handed on`, p.resolved && 'resolved'].filter(Boolean).join(' · ') || 'recorded activity'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {iContributed && (
              <Button size="sm" className="mt-3 w-full" onClick={async () => {
                try { const d = await api.draftFromWork(id); toast.success('A private draft is ready in your Record.'); navigate(`/record?tab=drafts&open=${d.id}`); }
                catch (e) { toast.error(api.errorText(e)); }
              }}><PenLine className="h-4 w-4" />Prepare a private draft from my work</Button>
            )}
          </Panel>

          {source && (
            <Panel title="Where this came from">
              <p className="flex items-start gap-2 text-sm text-ink-2"><FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden /><span><span className="font-medium text-ink">{source.filename}</span>, row {item.source_row}. The original file is kept unchanged.</span></p>
              {Object.keys(item.data || {}).length > 0 && (
                <details className="mt-3 rounded-md border border-line">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">Everything the source said</summary>
                  <dl className="px-3 pb-2">
                    {Object.entries(item.data as Record<string, string>).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3 border-b border-line py-1 text-xs last:border-0"><dt className="text-ink-3">{k}</dt><dd className="text-right text-ink">{v || '—'}</dd></div>
                    ))}
                  </dl>
                </details>
              )}
            </Panel>
          )}

          <div className="card p-4"><ThreadsForItem itemId={id} /></div>
        </aside>
      </div>

      {handoffOpen && <HandoffDialog itemId={id} version={item.version} onClose={() => setHandoffOpen(false)} onDone={() => { setHandoffOpen(false); refresh(); }} />}
      {stageOpen && <StageDialog itemId={id} version={item.version} stage={stageOpen} procedure={Boolean(procedure)} onClose={() => setStageOpen(null)} onDone={() => { setStageOpen(null); refresh(); }} />}
    </div>
  );
}

/* ── The procedure checklist ───────────────────────────────────────────────────────────────── */

const STATUS_ICON: Record<string, React.ReactNode> = {
  done: <CheckCircle2 className="h-4 w-4 text-good" aria-hidden />,
  current: <CircleDot className="h-4 w-4 text-accent" aria-hidden />,
  attention: <OctagonAlert className="h-4 w-4 text-warn" aria-hidden />,
  skipped: <SkipForward className="h-4 w-4 text-ink-3" aria-hidden />,
  upcoming: <Circle className="h-4 w-4 text-line-strong" aria-hidden />,
};
const STATUS_TEXT: Record<string, string> = { done: 'done', current: 'next', attention: 'needs attention', skipped: 'not needed', upcoming: 'to do' };

function ProcedurePanel({ procedure, progress, active, profile, onPick }: { procedure: Procedure & { pinned_version: string }; progress: { steps: Array<{ key: string; status: string; note: string | null }>; next: string | null }; active: string | null; profile: FMRAProfileEntry[]; onPick: (key: string) => void }) {
  return (
    <Panel title="Procedure" subtitle={`${procedure.title} · v${procedure.pinned_version}`} bodyClassName="p-0">
      <ol className="py-1">
        {procedure.steps.map((step) => {
          const st = progress.steps.find((s) => s.key === step.key);
          const status = st?.status || 'upcoming';
          const route = fmraResponsibilitiesForStep(procedure.key, step.key);
          const routedKeys = Array.from(new Set([...(route.perform || []), ...(route.approve || []), ...(route.verify || [])]));
          return (
            <li key={step.key}>
              <button type="button" onClick={() => onPick(step.key)} aria-current={active === step.key ? 'step' : undefined}
                className={cn('flex w-full items-start gap-2.5 px-4 py-2 text-left text-sm transition-colors hover:bg-surface-2', active === step.key && 'bg-accent-soft/50')}>
                <span className="mt-0.5 shrink-0">{STATUS_ICON[status]}</span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-ink', status === 'skipped' && 'text-ink-3 line-through')}>{step.title}</span>
                  {st?.note && status !== 'skipped' && <span className="block text-xs text-ink-3">{st.note}</span>}
                  {routedKeys.length > 0 && <span className="mt-1 flex flex-wrap gap-1"><span className="sr-only">Responsibility routing:</span>{routedKeys.map((key) => <Badge key={key} size="xs" tone={profileHasResponsibility(profile, key) ? 'good' : 'neutral'}>{fmraResponsibilityLabel(key)}</Badge>)}</span>}
                </span>
                <span className="sr-only">{STATUS_TEXT[status]}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <details className="border-t border-line px-4 py-3 text-xs text-ink-3">
        <summary className="cursor-pointer font-medium text-ink-2">Source: {AUTHORITY_LABEL[procedure.authority]}</summary>
        <p className="mt-2">{procedure.source}</p>
        <ul className="mt-2 list-disc space-y-1 pl-4">{procedure.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
    </Panel>
  );
}

/* ── The current step ──────────────────────────────────────────────────────────────────────── */

function StepHelp({ step }: { step: ProcedureStep }) {
  return (
    <details className="mt-3 rounded-md border border-line bg-surface-2/40 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 font-medium text-ink-2"><BookOpen className="h-4 w-4 text-ink-3" aria-hidden />How to do this{step.help.system ? ` in ${step.help.system}` : ''}</summary>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 px-3 pb-3 sm:grid-cols-[8rem_1fr]">
        <dt className="text-xs text-ink-3">Why</dt><dd className="text-ink-2">{step.help.objective}</dd>
        <dt className="text-xs text-ink-3">What to do</dt><dd className="text-ink-2">{step.help.what}</dd>
        {step.help.meaning && <><dt className="text-xs text-ink-3">What it means</dt><dd className="text-ink-2">{step.help.meaning}</dd></>}
        <dt className="text-xs text-ink-3">Done when</dt><dd className="text-ink-2">{step.help.done}</dd>
        <dt className="text-xs text-ink-3">Screen path</dt><dd className="text-ink-3">{step.help.path || 'Not documented yet. It will be added once an SME confirms it.'}</dd>
      </dl>
    </details>
  );
}

function StepPanel({ itemId, step, status, caseData, canAct, focused, onBackToNext, onDone, onResolve }: {
  itemId: string; step: ProcedureStep; status: { status: string; note: string | null } | null; caseData: any; canAct: boolean; focused: boolean;
  onBackToNext: () => void; onDone: () => void; onResolve: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [extraInvoices, setExtraInvoices] = useState<Array<{ amount: string; reference: string }>>([]);
  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));
  const [key] = useState(newKey);
  const recorded = (field: string) => caseData.events.filter((e: any) => e.kind === 'observation' && e.body.field === field && !e.superseded);

  const submit = async (bodies: Array<Record<string, unknown>>, message: string) => {
    if (!bodies.length) return;
    setBusy(true);
    try {
      for (let i = 0; i < bodies.length; i++) await api.recordEntry(itemId, { step: step.key, ...bodies[i] }, `${key}-${i}`);
      toast.success(message);
      onDone();
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  const heading = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <p className="eyebrow">{status?.status === 'done' ? 'Done' : status?.status === 'attention' ? 'Needs attention' : status?.status === 'skipped' ? 'Not needed' : focused ? 'Step' : 'Next step'}</p>
        <h2 className="mt-1 text-lg font-semibold text-ink">{step.title}</h2>
        {status?.note && <p className="mt-0.5 text-sm text-warn">{status.note}</p>}
      </div>
      {focused && <Button size="sm" variant="ghost" onClick={onBackToNext}>Back to the next step</Button>}
    </div>
  );

  let form: React.ReactNode = null;
  if (!canAct) {
    form = <p className="mt-3 text-sm text-ink-3">Whoever holds this work records it.</p>;
  } else if (step.kind === 'research') {
    const fields = step.fields || [];
    form = (
      <div className="mt-4 space-y-3">
        {fields.map((f) => {
          const have = recorded(f.key);
          return (
            <div key={f.key}>
              {have.length > 0 && (
                <p className="mb-1.5 text-xs text-ink-3">Recorded: {have.map((e: any) => `${e.body.display}${e.body.reference ? ` (${e.body.reference})` : ''}`).join(', ')}{have[0].body.source === 'source_file' ? ' · from the imported sheet' : ''}</p>
              )}
              {(!have.length || f.multiple) && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem]">
                  <Field label={have.length && f.multiple ? `Another ${f.label.toLowerCase()}` : f.label} hint={f.money ? 'As shown in DAI, e.g. 45,000.00' : undefined}>
                    {f.money ? <NumberInput value={values[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} placeholder="0.00" /> : <Input value={values[f.key] || ''} onChange={(e) => set(f.key, e.target.value)} />}
                  </Field>
                  {f.multiple && <Field label="Reference"><Input value={values[`${f.key}:ref`] || ''} onChange={(e) => set(`${f.key}:ref`, e.target.value)} placeholder="Invoice number" /></Field>}
                </div>
              )}
              {f.multiple && extraInvoices.map((inv, i) => (
                <div key={i} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem]">
                  <Field label={`Invoice ${have.length + i + 2}`}><NumberInput value={inv.amount} onChange={(e) => setExtraInvoices((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder="0.00" /></Field>
                  <Field label="Reference"><Input value={inv.reference} onChange={(e) => setExtraInvoices((p) => p.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} /></Field>
                </div>
              ))}
              {f.multiple && <Button size="xs" variant="ghost" className="mt-1" onClick={() => setExtraInvoices((p) => [...p, { amount: '', reference: '' }])}>+ Add another</Button>}
            </div>
          );
        })}
        <Field label="Where you read it"><Input value={values.system || 'DAI'} onChange={(e) => set('system', e.target.value)} /></Field>
        <div className="flex justify-end">
          <Button variant="primary" loading={busy} onClick={() => {
            const bodies: Array<Record<string, unknown>> = [];
            for (const f of fields) {
              const v = (values[f.key] || '').trim();
              if (v) bodies.push({ kind: 'observation', field: f.key, label: f.label, ...(f.money ? { amount: v } : { value_text: v }), reference: values[`${f.key}:ref`] || null, system: values.system || 'DAI' });
              if (f.multiple) for (const inv of extraInvoices) if (inv.amount.trim()) bodies.push({ kind: 'observation', field: f.key, label: f.label, amount: inv.amount.trim(), reference: inv.reference || null, system: values.system || 'DAI' });
            }
            if (!bodies.length) { toast.error('Enter at least one value.'); return; }
            void submit(bodies, bodies.length === 1 ? 'Recorded.' : `${bodies.length} values recorded.`);
          }}><Check className="h-4 w-4" />Record what you found</Button>
        </div>
      </div>
    );
  } else if (step.kind === 'calculation') {
    form = (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-2">Vantage adds the recorded invoices and the UMT amount, then compares that with the current award. Every input is shown with where it came from.</p>
        <Button variant="primary" loading={busy} onClick={async () => {
          setBusy(true);
          try { await api.calculateCase(itemId); toast.success('Calculated.'); onDone(); }
          catch (e) { toast.error(api.errorText(e)); }
          finally { setBusy(false); }
        }}><Calculator className="h-4 w-4" />Calculate the candidate</Button>
      </div>
    );
  } else if (step.kind === 'decision' && step.decision) {
    form = (
      <div className="mt-4 space-y-3">
        <fieldset>
          <legend className="mb-1.5 text-base font-medium text-ink">Your decision</legend>
          <div className="space-y-1.5">
            {step.decision.choices.map((ch) => (
              <label key={ch.key} className="flex cursor-pointer items-center gap-2.5 rounded-md border border-line px-3 py-2 text-sm hover:border-line-strong has-[:checked]:border-accent has-[:checked]:bg-accent-soft/40">
                <input type="radio" name={`decision-${step.key}`} value={ch.key} checked={values.choice === ch.key} onChange={() => set('choice', ch.key)} />
                <span className="text-ink">{ch.label}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Why" required hint="A reviewer reads this later."><Textarea rows={2} value={values.rationale || ''} onChange={(e) => set('rationale', e.target.value)} placeholder="Requisition shows $1,500.00 available against a candidate increase of $2,775.00." /></Field>
        <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={!values.choice || !values.rationale?.trim()} onClick={() => submit([{ kind: 'decision', decision: step.decision!.key, choice: values.choice, rationale: values.rationale }], 'Decision recorded.')}><Check className="h-4 w-4" />Record the decision</Button></div>
      </div>
    );
  } else if (step.kind === 'action') {
    const prepareOnly = step.key === 'award_modification';
    const needsAck = step.key === 'submit_modification' && caseData.latest_funds_check?.result === 'WARNING';
    const fundsBlocked = step.key === 'submit_modification' && (!caseData.latest_funds_check || ['FAILED', 'NOT_RUN', 'UNKNOWN'].includes(caseData.latest_funds_check.result));
    form = (
      <div className="mt-4 space-y-3">
        {fundsBlocked && (
          <p className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-sm text-ink"><OctagonAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
            {caseData.latest_funds_check ? `The latest funds check is ${caseData.latest_funds_check.result}. Submission waits on a PASSED check.` : 'Record the funds check first. Submission waits on a PASSED check.'}
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Reference" hint="The document or modification number"><Input value={values.reference || ''} onChange={(e) => set('reference', e.target.value)} /></Field>
          <Field label="Note"><Input value={values.text || ''} onChange={(e) => set('text', e.target.value)} /></Field>
        </div>
        {needsAck && <Field label="The funds check warned. Why is submitting still right?" required><Textarea rows={2} value={values.ack || ''} onChange={(e) => set('ack', e.target.value)} /></Field>}
        {!prepareOnly && step.waitsOn && (
          <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={values.wait !== 'no'} onChange={(e) => set('wait', e.target.checked ? 'yes' : 'no')} />Then wait on {WAITING_LABEL[step.waitsOn].toLowerCase()}</label>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button loading={busy} onClick={() => submit([{ kind: 'action_prepared', reference: values.reference || null, text: values.text || null }], 'Recorded as prepared. Nothing is submitted yet.')}>Record as prepared</Button>
          {!prepareOnly && (
            <Button variant="primary" loading={busy} disabled={fundsBlocked} onClick={() => submit([{ kind: 'action_submitted', reference: values.reference || null, text: values.text || null, control_acknowledgement: values.ack || null, then_wait: step.waitsOn && values.wait !== 'no' ? step.waitsOn : null }], 'Recorded as submitted. Submitted is not approved.')}>
              <Send className="h-4 w-4" />Record as submitted
            </Button>
          )}
        </div>
      </div>
    );
  } else if (step.kind === 'external' && step.observes) {
    form = (
      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="What the system shows"><Select value={values.event || ''} placeholder="Choose" onValueChange={(v) => set('event', v)} options={EXTERNAL_EVENTS.map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) }))} /></Field>
          <Field label="Seen on"><Input type="date" value={values.on || ''} onChange={(e) => set('on', e.target.value)} /></Field>
          <Field label="Reference"><Input value={values.reference || ''} onChange={(e) => set('reference', e.target.value)} /></Field>
        </div>
        <p className="text-xs text-ink-3">Record approval and {step.observes.completesOn} separately, each when you see it.</p>
        <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={!values.event} onClick={() => submit([{ kind: 'external_event', step: step.observes!.step, event: values.event, system: 'DAI', reference: values.reference || null, observed_on: values.on || null }], 'Recorded what the system shows.')}><Check className="h-4 w-4" />Record it</Button></div>
      </div>
    );
  } else if (step.kind === 'control') {
    form = (
      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Result"><Select value={values.result || ''} placeholder="Choose the exact result" onValueChange={(v) => set('result', v)} options={FUNDS_CHECK_RESULTS.map((r) => ({ value: r, label: r.replace('_', ' ') }))} /></Field>
          <Field label="Reference"><Input value={values.reference || ''} onChange={(e) => set('reference', e.target.value)} /></Field>
        </div>
        <Field label="What it said"><Input value={values.text || ''} onChange={(e) => set('text', e.target.value)} /></Field>
        <p className="text-xs text-ink-3">A passed funds check does not obligate funds.</p>
        <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={!values.result} onClick={() => submit([{ kind: 'funds_check', result: values.result, system: 'DAI', reference: values.reference || null, text: values.text || null }], 'Funds check recorded.')}><Check className="h-4 w-4" />Record the check</Button></div>
      </div>
    );
  } else if (step.kind === 'verification' && step.check) {
    form = (
      <div className="mt-4 space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Result"><Select value={values.result || ''} placeholder="Choose" onValueChange={(v) => set('result', v)} options={[{ value: 'verified', label: 'Verified' }, { value: 'not_verified', label: 'Checked, not verified' }]} /></Field>
          <Field label="What you checked" required={values.result === 'verified'} hint="Required to mark it verified"><Input value={values.reference || ''} onChange={(e) => set('reference', e.target.value)} placeholder="UMT report 23 Sep, line no longer listed" /></Field>
        </div>
        <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={!values.result || (values.result === 'verified' && !values.reference?.trim())} onClick={() => submit([{ kind: 'verification', check: step.check, result: values.result, reference: values.reference || null }], 'Verification recorded.')}><Check className="h-4 w-4" />Record the verification</Button></div>
      </div>
    );
  } else if (step.kind === 'resolution') {
    form = (
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-2">Resolve once the original condition is verified cleared.</p>
        <Button variant="primary" onClick={onResolve}><CheckCircle2 className="h-4 w-4" />Resolve</Button>
      </div>
    );
  }

  return (
    <section className="card p-4 sm:p-5" aria-label={`Step: ${step.title}`}>
      {heading}
      <StepHelp step={step} />
      {form}
    </section>
  );
}

/* ── The calculation ───────────────────────────────────────────────────────────────────────── */

function CalculationPanel({ calc, events }: { calc: any; events: any[] }) {
  const stale = events.some((e) => e.kind === 'observation' && e.created_at > (events.find((x) => x.id === calc.id)?.created_at || ''));
  return (
    <Panel title="Candidate calculation" subtitle={calc.formula_text} action={<Badge tone={calc.requires_review ? 'warn' : 'accent'}>{calc.requires_review ? 'Needs review' : 'Candidate'}</Badge>}>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-line px-3 py-2"><dt className="text-xs text-ink-3">Invoice total</dt><dd className="fig mt-0.5 text-lg font-semibold text-ink">{formatCents(calc.invoice_total_cents)}</dd></div>
        <div className="rounded-md border border-line px-3 py-2"><dt className="text-xs text-ink-3">Target award</dt><dd className="fig mt-0.5 text-lg font-semibold text-ink">{formatCents(calc.target_award_cents)}</dd></div>
        <div className="rounded-md border border-accent/40 bg-accent-soft/40 px-3 py-2"><dt className="text-xs text-ink-3">Award adjustment ({calc.direction})</dt><dd className="fig mt-0.5 text-lg font-semibold text-ink">{formatCents(calc.adjustment_cents, { signed: true })}</dd></div>
      </dl>
      <table className="mt-3 w-full text-sm">
        <caption className="sr-only">Inputs to the calculation</caption>
        <thead><tr className="text-left text-xs text-ink-3"><th className="py-1 font-medium">Input</th><th className="py-1 font-medium">Source</th><th className="py-1 text-right font-medium">Amount</th></tr></thead>
        <tbody>
          {calc.inputs.map((i: any) => (
            <tr key={i.event_id} className="border-t border-line">
              <td className="py-1.5 text-ink">{i.label}</td>
              <td className="py-1.5 text-xs text-ink-3">{VALUE_SOURCES[i.source as keyof typeof VALUE_SOURCES]}</td>
              <td className="fig py-1.5 text-right text-ink">{formatCents(i.cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 flex items-start gap-2 text-xs text-ink-3"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{calc.applicability}</p>
      {stale && <p className="mt-2 text-xs text-warn">Values were recorded after this calculation. Calculate again to include them.</p>}
    </Panel>
  );
}

/* ── Work without a procedure: what you did, and optionally your record of it ─────────────────── */

/**
 * The original way to record work on a queue row, kept for work that does not follow a modelled
 * procedure: what kind of thing you did, what it moved, and whether it also goes in your own record.
 */
function ActionForm({ itemId, item, onDone }: { itemId: string; item: any; onDone: () => void }) {
  const toast = useToast();
  const cfg = useMetrics();
  const [kind, setKind] = useState('worked');
  const [quantity, setQuantity] = useState('');
  const [unitLabel, setUnitLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [amountType, setAmountType] = useState('');
  const [note, setNote] = useState('');
  const [draftRecord, setDraftRecord] = useState(true);
  const [resolve, setResolve] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newKey);
  const submit = async () => {
    setBusy(true);
    try {
      const res = await api.recordWorkAction(itemId, {
        kind, note: note || null, occurred_at: todayIso(),
        quantity: quantity === '' ? null : Number(quantity), unit_label: unitLabel || null,
        dollar_amount: amount === '' ? null : Number(amount), dollar_type: amount === '' ? null : amountType || null,
        draft_record: draftRecord, resolve,
      }, key);
      toast.success(res.activity_id ? 'Recorded, and added to your own record.' : 'Recorded.');
      setKey(newKey()); setNote(''); setQuantity(''); setAmount('');
      onDone();
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <section className="card space-y-3 p-4 sm:p-5" aria-label="What did you do?">
      <h2 className="text-lg font-semibold text-ink">What did you do?</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Kind">
          <Select value={kind} onValueChange={setKind} options={['worked', 'contacted', 'escalated', 'corrected', 'reconciled', 'validated', 'resolved', 'noted'].map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) }))} />
        </Field>
        <Field label="How many" hint="Leave blank if this did not move a countable amount."><NumberInput value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="30" /></Field>
        <Field label="Of what"><Input value={unitLabel} onChange={(e) => setUnitLabel(e.target.value)} placeholder={item.unit_label || 'ULOs'} list="work-units" /></Field>
        <datalist id="work-units">{cfg.unit_suggestions.map((u) => <option key={u} value={u} />)}</datalist>
        <Field label={`${cfg.currency_label} moved`}><NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1118.38" /></Field>
        <Field label="Which kind of value" hint="An amount with no type cannot be counted toward anything.">
          <Select value={amountType} placeholder="Choose a type" onValueChange={setAmountType} disabled={amount === ''} options={cfg.value_types.map((t) => ({ value: t.key, label: t.summable ? t.label : `${t.label} (tracked separately)` }))} />
        </Field>
      </div>
      <Field label="What happened"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Confirmed the supporting document with the vendor and released the balance." /></Field>
      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={draftRecord} onChange={(e) => setDraftRecord(e.target.checked)} />Also add this to my own record</label>
        <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={resolve} onChange={(e) => setResolve(e.target.checked)} />This closes it out</label>
      </div>
      <div className="flex justify-end"><Button variant="primary" loading={busy} onClick={submit}><Check className="h-4 w-4" />Record what you did</Button></div>
    </section>
  );
}

/* ── Adding any kind of entry ──────────────────────────────────────────────────────────────── */

const FREE_KINDS = [
  { value: 'question', label: 'Question' },
  { value: 'finding', label: 'Finding' },
  { value: 'note', label: 'Note' },
  { value: 'observation', label: 'Observation (a value you read)' },
] as const;

function EntryComposer({ itemId, procedure, onDone }: { itemId: string; procedure: Procedure | null; onDone: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<string>('finding');
  const [text, setText] = useState('');
  const [amount, setAmount] = useState('');
  const [field, setField] = useState('other');
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newKey);
  const fieldOptions = useMemo(() => [{ value: 'other', label: 'Something else' }, ...(procedure?.steps.flatMap((s) => s.fields || []) || []).map((f) => ({ value: f.key, label: f.label }))], [procedure]);

  const submit = async () => {
    setBusy(true);
    try {
      const body = kind === 'observation'
        ? { kind, field, label: field === 'other' ? text.slice(0, 120) || 'Observation' : null, amount: amount || null, value_text: amount ? null : text || null, system: 'DAI' }
        : { kind, text };
      await api.recordEntry(itemId, body, key);
      toast.success('Added to the history.');
      setText(''); setAmount(''); setKey(newKey()); setOpen(false);
      onDone();
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };

  if (!open) {
    return (
      <div className="flex flex-wrap gap-2">
        {FREE_KINDS.map((k) => (
          <Button key={k.value} size="sm" onClick={() => { setKind(k.value); setOpen(true); }}>{k.value === 'observation' ? 'Record a value' : `Add a ${k.label.toLowerCase()}`}</Button>
        ))}
      </div>
    );
  }
  return (
    <section className="card p-4" aria-label="Add to the history">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[14rem_1fr]">
        <Field label="Kind"><Select value={kind} onValueChange={setKind} options={FREE_KINDS.map((k) => ({ value: k.value, label: k.label }))} /></Field>
        {kind === 'observation' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Which value"><Select value={field} onValueChange={setField} options={fieldOptions} /></Field>
            <Field label="Amount" hint="Leave blank to describe it instead"><NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></Field>
          </div>
        ) : <span />}
      </div>
      <Field label={kind === 'observation' ? 'What you saw' : kind === 'question' ? 'What you need to find out' : 'What you found'} className="mt-3">
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </Field>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={kind === 'observation' ? !amount && !text.trim() : !text.trim()} onClick={submit}><Check className="h-4 w-4" />Add</Button>
      </div>
    </section>
  );
}

/* ── History ───────────────────────────────────────────────────────────────────────────────── */

const QUIET = new Set(['created', 'procedure_applied']);

function HistoryPanel({ events, people, procedure }: { events: any[]; people: Record<string, { name: string; rank: string | null }>; procedure: Procedure | null }) {
  const [showAll, setShowAll] = useState(false);
  const { data: identity } = useIdentity();
  const ordered = [...events].reverse();
  const visible = showAll ? ordered : ordered.filter((e) => !QUIET.has(e.kind)).slice(0, 25);
  const stepTitle = (k: string | null) => procedure?.steps.find((s) => s.key === k)?.title;
  const who = (id: string | null) => (id === identity?.user.id ? 'You' : id ? personName(people[id]) : 'Vantage');

  return (
    <Panel title="History" subtitle="Every change, who made it, and where each value came from. Nothing here is edited; corrections are added." action={<History className="h-4 w-4 text-ink-3" aria-hidden />} bodyClassName="p-0">
      <ol className="divide-y divide-line">
        {visible.map((e) => (
          <li key={e.id} className={cn('flex gap-3 px-4 py-2.5 text-sm', e.superseded && 'opacity-60')}>
            <span className="w-28 shrink-0 text-xs text-ink-3" title={new Date(e.created_at).toLocaleString()}>{timeAgo(e.created_at)}</span>
            <span className="min-w-0 flex-1">
              <span className="text-ink">
                <span className="font-medium">{who(e.actor_id)}</span>{' '}
                {e.kind === 'handed_off' ? <>handed this to <span className="font-medium">{who(e.subject_id)}</span></>
                  : e.kind === 'assigned' ? <>assigned this to <span className="font-medium">{who(e.subject_id)}</span></>
                  : e.kind === 'claim_expired' ? <>released {who(e.subject_id)}’s claim after it sat untouched</>
                  : <span className={cn(e.superseded && 'line-through')}>{verb(e.kind)} {describeEvent(e.kind, e.body).replace(/^./, (ch) => ch.toLowerCase())}</span>}
              </span>
              {(e.body.note || e.body.rationale || (e.body.text && !['note', 'finding', 'question'].includes(e.kind)) || e.body.reason) && (
                <span className="mt-0.5 block text-ink-2">“{e.body.note || e.body.rationale || e.body.text || e.body.reason}”</span>
              )}
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                {e.body.source && e.kind === 'observation' && <Badge tone={e.body.source === 'source_file' ? 'neutral' : 'info'}>{e.body.source === 'source_file' ? 'From the imported sheet' : 'Read from DAI by hand'}</Badge>}
                {e.body.reference && e.kind !== 'observation' && <Badge>{e.body.reference}</Badge>}
                {e.body.reference && e.kind === 'observation' && <Badge>{e.body.reference}</Badge>}
                {e.step && stepTitle(e.step) && <span className="text-xs text-ink-3">{stepTitle(e.step)}</span>}
                {e.superseded && <Badge tone="warn">Corrected later</Badge>}
                {e.supersedes_id && <Badge tone="info">Correction</Badge>}
                {e.body.backfilled ? <span className="text-xs text-ink-3">(from before history was kept)</span> : null}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {(ordered.length > visible.length || showAll) && (
        <div className="border-t border-line px-4 py-2 text-right">
          <Button size="xs" variant="ghost" onClick={() => setShowAll((v) => !v)}><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showAll && 'rotate-180')} />{showAll ? 'Show less' : `Show all ${ordered.length}`}</Button>
        </div>
      )}
    </Panel>
  );
}

function verb(kind: string): string {
  switch (kind) {
    case 'observation': return 'recorded';
    case 'question': return 'asked:';
    case 'finding': return 'found:';
    case 'note': return 'noted:';
    case 'decision': return 'decided';
    case 'calculation': return 'ran the';
    case 'funds_check': return 'recorded a';
    case 'verification': return 'checked:';
    case 'external_event': return 'saw';
    case 'action_prepared': return 'prepared';
    case 'action_submitted': return 'submitted';
    case 'claimed': return 'claimed this';
    case 'released': return 'released this';
    case 'resolved': return 'resolved this';
    case 'reopened': return 'reopened this';
    case 'created': return 'brought this in';
    case 'procedure_applied': return 'applied the procedure';
    case 'action_recorded': return 'recorded:';
    default: return '';
  }
}

/* ── Dialogs ───────────────────────────────────────────────────────────────────────────────── */

function HandoffDialog({ itemId, version, onClose, onDone }: { itemId: string; version: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const candidates = useQuery<Array<{ id: string; name: string; rank: string | null }>>({ queryKey: ['handoff-candidates', itemId], queryFn: () => api.handoffCandidates(itemId) });
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title="Hand this off" description="Your entries stay yours. The history records who passed it, to whom, and what you said." size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!to || !note.trim()} onClick={async () => {
        setBusy(true);
        try { await api.handOffWork(itemId, { to_user_id: to, note, version }); toast.success('Handed off.'); onDone(); }
        catch (e) { toast.error(api.errorText(e)); }
        finally { setBusy(false); }
      }}><Users className="h-4 w-4" />Hand off</Button></>}>
      <div className="space-y-3">
        <Field label="To">
          <Select value={to} onValueChange={setTo} placeholder={candidates.isPending ? 'Loading…' : 'Choose a teammate'}
            options={(candidates.data || []).map((p) => ({ value: p.id, label: [p.rank, p.name].filter(Boolean).join(' ') }))} />
        </Field>
        <Field label="What they need to know" required><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Award and invoices recorded. Funding decision next." /></Field>
      </div>
    </Dialog>
  );
}

function StageDialog({ itemId, version, stage, procedure, onClose, onDone }: { itemId: string; version: number; stage: Stage; procedure: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const needsCategory = stage === 'waiting';
  const needsReason = stage === 'blocked';
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Move to ${STAGE_LABEL[stage].toLowerCase()}`} size="sm"
      description={stage === 'resolved' && procedure ? 'This work follows a procedure, so it resolves only once the original condition is verified cleared.' : stage === 'waiting' ? 'Waiting time is tracked as elapsed time, never as work.' : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={(needsCategory && !category) || (needsReason && !reason.trim())} onClick={async () => {
        setBusy(true);
        try { await api.changeStage(itemId, { stage, waiting_category: category || null, reason: reason || null, version }); toast.success(`Moved to ${STAGE_LABEL[stage].toLowerCase()}.`); onDone(); }
        catch (e) { toast.error(api.errorText(e)); }
        finally { setBusy(false); }
      }}>Move it</Button></>}>
      <div className="space-y-3">
        {needsCategory && <Field label="Waiting on" required><Select value={category} onValueChange={setCategory} placeholder="Choose" options={WAITING_CATEGORIES.map((w) => ({ value: w, label: WAITING_LABEL[w] }))} /></Field>}
        <Field label={needsReason ? 'What is blocking it' : 'Reason'} required={needsReason}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}

