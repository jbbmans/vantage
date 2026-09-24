import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, BookOpen, Calculator, Check, CheckCircle2, ChevronDown, Circle, CircleDot, CircleDashed, FileCheck2, FileSpreadsheet, FlaskConical, GitBranch, Hand,
  History, Info, Lock, OctagonAlert, PenLine, RefreshCw, Send, ShieldAlert, ShieldCheck, SkipForward, Sparkles, UserRoundPlus, Users, Wand2,
} from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, NumberInput, Panel, Select, Skeleton, Textarea } from '@/components/ui/primitives';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/toast';
import { DateText } from '@/components/common';
import { StageBadge, elapsed, personName } from '@/components/work';
import LifecycleBars from '@/components/fmra/LifecycleBars';
import { AiAction, AiResult, useAiModel } from '@/components/AiPanel';
import { ThreadsForItem } from './Workbench';
import { useIdentity, useMetrics, useWorkItem, invalidateWork, invalidateDomains } from '@/lib/queries';
import * as api from '@/lib/api';
import { cn, timeAgo, todayIso } from '@/lib/utils';
import {
  STAGE_LABEL, WAITING_CATEGORIES, WAITING_LABEL, FUNDS_CHECK_RESULTS, EXTERNAL_EVENTS, VALUE_SOURCES,
  describeEvent, type Stage,
} from '../../shared/caseModel';
import {
  AUTHORITY_LABEL, PROCEDURE_LIST, PROCEDURES, observedStep, stepApplies, isVerified, FORMULAS,
  type CaseEvent, type Procedure, type ProcedureField, type ProcedureStep,
} from '../../shared/procedures';
import { diagnose, METHODS, responsibilityName, type MethodKey } from '../../shared/fmra';
import { formatCents } from '../../shared/money';

/**
 * One piece of work, on its own page, with everything needed to decide and act.
 *
 * The procedure shows where the case stands and what comes next; the form below it asks only for
 * what the current step needs. Experienced analysts can go straight to any step, or add any kind of
 * entry, without a wizard in the way. Every entry lands in the history with who made it and where
 * the value came from, and the history carries its own seal.
 */

const newKey = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const LIFECYCLE_FIELDS = ['commitment_amount', 'obligation_amount', 'delivered_amount', 'paid_amount'] as const;

/** The case's events in the shape the shared procedure rules read. */
const toCaseEvents = (events: any[]): CaseEvent[] => events.map((e, i) => ({ id: e.id, kind: e.kind, actor_id: e.actor_id, occurred_at: e.occurred_at, supersedes_id: e.supersedes_id, seq: i, body: { ...e.body, step: e.step ?? undefined } }));

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
    return <div className="page space-y-3"><Skeleton className="h-6 w-40" /><Skeleton className="h-12 w-2/3" /><div className="grid gap-4 xl:grid-cols-[1fr_360px]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div></div>;
  }
  if (detail.isError || !detail.data) {
    const status = (detail.error as { status?: number } | null)?.status;
    return (
      <div className="page"><div className="card"><EmptyState
        icon={status === 403 ? Lock : Info}
        title={status === 403 ? 'This work is not yours to open' : status === 404 ? 'This work item is not here' : 'This work item could not load'}
        description={status === 403 ? 'It belongs to a unit you are not in, or it was never shared with you.' : api.errorText(detail.error)}
        action={<><Button onClick={() => navigate('/work')}>Back to Work</Button>{status !== 403 && status !== 404 && <Button variant="primary" onClick={() => detail.refetch()}>Try again</Button>}</>}
      /></div></div>
    );
  }

  const { item, case: c, source, project } = detail.data;
  const me = identity?.user.id;
  const holding = item.claimed_by === me;
  const holder = item.claimed_by ? c.people[item.claimed_by] : null;
  const closed = c.stage === 'resolved' || c.stage === 'not_applicable';
  const procedure: (Procedure & { pinned_version: string; newer_version: string | null }) | null = c.procedure;
  const steps = procedure?.steps || [];
  const progress = c.progress as { steps: Array<{ key: string; status: string; note: string | null; evidence: string[] }>; next: string | null } | null;
  const activeKey = focusStep || progress?.next || null;
  const activeStep = steps.find((s) => s.key === activeKey) || null;
  const activeStatus = progress?.steps.find((s) => s.key === activeKey) || null;
  const flagship = identity?.demo && identity.demo.flagship.reference === item.reference ? identity.demo.flagship : null;
  const iContributed = c.contributors.some((p: any) => p.user_id === me);
  const caseEvents = toCaseEvents(c.events);
  const lifecycle = procedure?.family === 'normal_condition';

  return (
    <div className="page">
      <Link to="/work" className="mb-4 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-ink-3 ring-1 ring-line transition-colors hover:bg-surface hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />Work</Link>

      <header className="mb-6">
        <p className="eyebrow mb-2.5 flex flex-wrap items-center gap-x-2">
          {project ? <span>{project.name}</span> : null}
          {project ? <span aria-hidden>·</span> : null}
          <span className="fig">{item.reference || item.natural_key}</span>
          {procedure && <><span aria-hidden>·</span><span className="text-accent">{procedure.short}</span></>}
        </p>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <h1 className="min-w-0 flex-1 basis-[28rem] text-[26px] font-semibold leading-tight tracking-[-0.028em] text-ink">{item.title}</h1>
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
        <dl className="mt-3.5 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <div className="flex items-center gap-2"><dt className="sr-only">Stage</dt><dd><StageBadge stage={c.stage} waiting={c.waiting?.category} /></dd></div>
          {c.waiting?.since && <div className="text-ink-3"><dt className="sr-only">Waiting</dt><dd>Waiting {elapsed(c.waiting.since)} (elapsed, not work)</dd></div>}
          {c.blocked_reason && <div className="text-bad"><dt className="sr-only">Blocked</dt><dd className="flex items-center gap-1.5"><OctagonAlert className="h-4 w-4" aria-hidden />{c.blocked_reason}</dd></div>}
          <div className="text-ink-2"><dt className="inline text-ink-3">Held by </dt><dd className="inline font-medium text-ink">{holding ? 'You' : holder ? personName(holder) : 'Nobody yet'}</dd></div>
          {item.due_date && <div className="text-ink-2"><dt className="inline text-ink-3">Due </dt><dd className="inline"><DateText value={item.due_date} /></dd></div>}
          {item.amount != null && <div className="text-ink-2"><dt className="inline text-ink-3">Amount on the sheet </dt><dd className="fig inline font-medium text-ink">{formatCents(Math.round(Number(item.amount) * 100))}</dd></div>}
          {c.integrity?.count ? <div><dt className="sr-only">History</dt><dd><IntegrityBadge integrity={c.integrity} /></dd></div> : null}
        </dl>
      </header>

      {item.source_changed_at && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-warn/[.07] px-4 py-3 text-sm ring-1 ring-inset ring-warn/25">
          <RefreshCw className="h-4 w-4 shrink-0 text-warn" aria-hidden />
          <span className="min-w-0 flex-1 text-ink">The source sheet changed after this was picked up. The changed values are in the history; anything seeded from the sheet was superseded, and research you recorded was not touched.</span>
          {(c.permissions.progress || c.permissions.act) && <Button size="sm" onClick={() => run(() => api.patchWorkItem(id, { acknowledge_source_change: true, version: item.version }), 'Noted.')}>I have reviewed it</Button>}
        </div>
      )}

      {flagship && (
        <section aria-labelledby="synthetic-values" className="mb-4 rounded-2xl bg-accent-soft/50 p-4 ring-1 ring-inset ring-accent/20">
          <h2 id="synthetic-values" className="flex items-center gap-2 text-sm font-semibold text-ink"><FlaskConical className="h-4 w-4 text-accent" aria-hidden />Synthetic system values for this walkthrough</h2>
          <p className="mt-1 text-xs text-ink-2">{flagship.note} {flagship.scenario}</p>
          <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {flagship.values.map((v) => (
              <div key={v.label} className="rounded-xl bg-surface px-3 py-2 shadow-hairline">
                <dt className="text-xs text-ink-3">{v.label}</dt>
                <dd className="fig mt-0.5 font-semibold text-ink">{v.display}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          {!holding && !closed && (
            <div className="card flex flex-wrap items-center gap-3 px-4 py-3 text-sm text-ink-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent"><Info className="h-4 w-4" aria-hidden /></span>
              <span className="flex-1">{item.claimed_by ? `${personName(holder)} is working this. You can read everything; recording on it is theirs to do.` : 'Claim this to work it. It goes on your assigned list at once; claiming alone is not credit for anything.'}</span>
            </div>
          )}

          {c.procedure_unavailable && (
            <div className="card flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <ShieldAlert className="h-4 w-4 shrink-0 text-warn" aria-hidden />
              <span className="min-w-0 flex-1 text-ink">This case is pinned to procedure version {c.procedure_unavailable.version}, which this build does not have. It will not be run under a different version without somebody saying so.</span>
              {c.permissions.apply_procedure && !closed && c.procedure_unavailable.current && <Button size="sm" onClick={() => run(() => api.applyProcedure(id, c.procedure_unavailable.key), `Moved to v${c.procedure_unavailable.current}.`)}>Move to v{c.procedure_unavailable.current}</Button>}
            </div>
          )}

          {!procedure && !c.procedure_unavailable && !closed && c.permissions.apply_procedure && <ApplyProcedure itemId={id} onDone={refresh} />}

          {procedure?.newer_version && !closed && c.permissions.apply_procedure && (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-surface-2/70 px-4 py-2.5 text-xs text-ink-2 ring-1 ring-inset ring-line">
              <GitBranch className="h-3.5 w-3.5 text-ink-3" aria-hidden />
              <span className="flex-1">This case runs v{procedure.pinned_version}, the version it began under. v{procedure.newer_version} is published{PROCEDURES[procedure.key]?.changes?.length ? `: ${PROCEDURES[procedure.key].changes!.join(' ')}` : '.'}</span>
              <Button size="xs" variant="ghost" onClick={() => run(() => api.applyProcedure(id, procedure.key), `Moved to v${procedure.newer_version}. The history records who moved it.`)}>Move this case to v{procedure.newer_version}</Button>
            </div>
          )}

          {lifecycle && <BalanceReading events={caseEvents} />}

          {procedure && activeStep && (
            <StepPanel
              key={activeStep.key}
              itemId={id}
              procedure={procedure}
              step={activeStep}
              status={activeStatus}
              caseData={c}
              events={caseEvents}
              canAct={c.permissions.act && !closed}
              focused={Boolean(focusStep)}
              onBackToNext={() => setFocusStep(null)}
              onDone={() => { setFocusStep(null); refresh(); }}
              onResolve={() => setStageOpen('resolved')}
              onJump={(k) => setFocusStep(k)}
            />
          )}

          {c.latest_calculation && <CalculationPanel calc={c.latest_calculation} />}

          {procedure && <CaseBrief itemId={id} />}

          {!procedure && holding && !closed && <ActionForm itemId={id} item={item} onDone={refresh} />}

          {c.permissions.act && !closed && <EntryComposer itemId={id} procedure={procedure} onDone={refresh} />}

          <HistoryPanel itemId={id} events={c.events} people={c.people} procedure={procedure} canCorrect={c.permissions.act && !closed} onDone={refresh} integrity={c.integrity} />
        </div>

        <aside className="space-y-5" aria-label="About this work">
          {procedure && progress && (
            <ProcedurePanel procedure={procedure} progress={progress} active={activeKey} resolution={c.resolution} onPick={(k) => setFocusStep(k === progress.next ? null : k)} />
          )}

          {lifecycle && <EvidencePanel events={caseEvents} />}

          <Panel title="Who worked this" subtitle="Each person’s own entries. Nobody is credited with anyone else’s.">
            {c.contributors.length === 0 ? <p className="text-sm text-ink-3">Nobody has recorded anything on this yet.</p> : (
              <ul className="space-y-3">
                {c.contributors.map((p: any) => (
                  <li key={p.user_id} className="flex items-start gap-3 text-sm">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-surface-2 text-2xs font-semibold text-ink-2 ring-1 ring-inset ring-line">{(p.name || '?').split(' ').map((w: string) => w[0]).join('').slice(0, 2)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="font-medium text-ink">{p.user_id === me ? 'You' : [p.rank, p.name].filter(Boolean).join(' ')}</span>
                        <span className="text-2xs text-ink-3">{timeAgo(p.last_at)}</span>
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-3">
                        {[p.research && `${p.research} research`, p.submitted && `${p.submitted} submitted`, p.verified && `${p.verified} verified`, p.handoffs && `${p.handoffs} handed on`, p.resolved && 'resolved'].filter(Boolean).join(' · ') || 'recorded activity'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {iContributed && (
              <Button size="sm" className="mt-4 w-full" onClick={async () => {
                try { const d = await api.draftFromWork(id); invalidateDomains(qc, 'draft'); toast.success('A private draft is ready in your Record.'); navigate(`/record?tab=drafts&open=${d.id}`); }
                catch (e) { toast.error(api.errorText(e)); }
              }}><PenLine className="h-4 w-4" />Prepare a private draft from my work</Button>
            )}
          </Panel>

          {source && (
            <Panel title="Where this came from">
              <p className="flex items-start gap-2.5 text-sm text-ink-2"><FileSpreadsheet className="mt-0.5 h-4 w-4 shrink-0 text-ink-3" aria-hidden /><span><span className="font-medium text-ink">{source.filename}</span>, row {item.source_row}. The original file is kept unchanged.</span></p>
              {Object.keys(item.data || {}).length > 0 && (
                <details className="mt-3 rounded-xl ring-1 ring-inset ring-line">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">Everything the source said</summary>
                  <dl className="px-3 pb-2">
                    {Object.entries(item.data as Record<string, string>).map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3 border-b border-line py-1.5 text-xs last:border-0"><dt className="text-ink-3">{k}</dt><dd className="text-right text-ink">{v || '—'}</dd></div>
                    ))}
                  </dl>
                </details>
              )}
            </Panel>
          )}

          <div className="card p-5"><ThreadsForItem itemId={id} /></div>
        </aside>
      </div>

      {handoffOpen && <HandoffDialog itemId={id} version={item.version} onClose={() => setHandoffOpen(false)} onDone={() => { setHandoffOpen(false); refresh(); }} />}
      {stageOpen && <StageDialog itemId={id} version={item.version} stage={stageOpen} procedure={procedure} resolution={c.resolution} onClose={() => setStageOpen(null)} onDone={() => { setStageOpen(null); refresh(); }} />}
    </div>
  );
}

/* ── Seal, procedure choice, and the balance reading ─────────────────────────────────────────── */

function IntegrityBadge({ integrity }: { integrity: { status: string; count: number; reason?: string } | undefined }) {
  if (!integrity || !integrity.count) return null;
  const ok = integrity.status === 'verified';
  return (
    <div className={cn('flex items-center gap-1.5 text-xs', ok ? 'text-ink-3' : integrity.status === 'broken' ? 'text-bad' : 'text-warn')} title={integrity.reason || 'Every entry is sealed into this case’s chain; a changed, removed or inserted entry would show here.'}>
      {ok ? <ShieldCheck className="h-3.5 w-3.5 text-good" aria-hidden /> : <ShieldAlert className="h-3.5 w-3.5" aria-hidden />}
      <span>{ok ? `History sealed · ${integrity.count} entries` : integrity.status === 'broken' ? 'History seal broken' : 'History not sealed'}</span>
    </div>
  );
}

function ApplyProcedure({ itemId, onDone }: { itemId: string; onDone: () => void }) {
  const toast = useToast();
  const suggestion = useQuery<{ key: string; why: string } | null>({ queryKey: ['procedure-suggestion', itemId], queryFn: () => api.procedureSuggestion(itemId), staleTime: 60_000 });
  const [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const key = choice || suggestion.data?.key || '';
  const apply = async () => {
    if (!key) return;
    setBusy(true);
    try { await api.applyProcedure(itemId, key); toast.success('The case now follows its procedure.'); onDone(); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };
  const suggested = suggestion.data ? PROCEDURES[suggestion.data.key] : null;
  return (
    <section className="card overflow-hidden" aria-label="Put this under a procedure">
      <div className="flex flex-wrap items-start gap-4 p-5">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-[#12294A] to-[#0A1B33] text-white"><Wand2 className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="text-md font-semibold text-ink">Work this under a procedure</h2>
          <p className="mt-0.5 text-sm text-ink-3">A procedure keeps the order and the evidence honest: its steps, its controls, and what counts as resolved. You still decide every step.</p>
          {suggested && <p className="mt-2 flex items-center gap-1.5 text-xs text-accent"><Sparkles className="h-3.5 w-3.5" aria-hidden />Suggested: {suggested.title}. {suggestion.data!.why}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Select className="w-full sm:w-96" value={key} onValueChange={setChoice} placeholder="Choose a procedure"
              options={PROCEDURE_LIST.map((p) => ({ value: p.key, label: `${p.short} — ${p.title}` }))} />
            <Button variant="primary" loading={busy} disabled={!key} onClick={apply}>Apply</Button>
          </div>
          {key && <p className="mt-2 text-2xs text-ink-3">{AUTHORITY_LABEL[PROCEDURES[key].authority]} · v{PROCEDURES[key].version}. The case is pinned to this version.</p>}
        </div>
      </div>
    </section>
  );
}

/** Latest standing lifecycle figures on the case, read through the diagnoser. */
function lifecycleFigures(events: CaseEvent[]) {
  const superseded = new Set(events.map((e) => e.supersedes_id).filter(Boolean));
  const standing = events.filter((e) => !superseded.has(e.id));
  const latest = (field: string) => standing.filter((e) => e.kind === 'observation' && e.body.field === field).at(-1);
  const recorded = LIFECYCLE_FIELDS.map((f) => latest(f));
  const cents = recorded.map((e) => (e && !e.body.not_shown && Number.isSafeInteger(e.body.amount_cents) ? (e.body.amount_cents as number) : null));
  const method = (latest('purchase_method')?.body.value_text || null) as MethodKey | null;
  return { recorded, cents, method, complete: recorded.every(Boolean) };
}

function BalanceReading({ events }: { events: CaseEvent[] }) {
  const { recorded, cents, method, complete } = lifecycleFigures(events);
  const [open, setOpen] = useState(false);
  if (!recorded.some(Boolean)) return null;
  const d = diagnose({ method, commitment: cents[0], obligation: cents[1], delivered: cents[2], paid: cents[3] });
  return (
    <section className="card p-5" aria-label="What the figures show">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-md font-semibold text-ink"><BookOpen className="h-4 w-4 text-accent" aria-hidden />What the figures show</h2>
        <span className="flex items-center gap-1.5">
          {method && <Badge>{METHODS[method]?.short}</Badge>}
          {!complete && <Badge tone="warn">Figures incomplete</Badge>}
        </span>
      </div>
      <LifecycleBars figures={{ commitment: cents[0], obligation: cents[1], delivered: cents[2], paid: cents[3] }} travel={method === 'tdy'} />
      {d.ok && (
        <>
          <p className="mt-4 text-sm leading-relaxed text-ink-2">{d.meaning}</p>
          <button type="button" onClick={() => setOpen((v) => !v)} className="mt-3 flex items-center gap-1.5 text-xs font-medium text-accent hover:underline" aria-expanded={open}>
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />{open ? 'Hide' : 'Show'} the causes the reference offers for these figures
          </button>
          {open && (
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {d.causes.map((c) => (
                <li key={`${c.condition}-${c.key}`} className="rounded-xl bg-surface-2/70 p-3 ring-1 ring-inset ring-line">
                  <p className="text-sm font-semibold text-ink">{c.label}{c.valid && <span className="ml-2 rounded-md bg-good/10 px-1.5 py-0.5 text-2xs font-medium text-good">may be valid</span>}</p>
                  <p className="mt-1 text-xs text-ink-2"><span className="text-ink-3">Tell it apart: </span>{c.research}</p>
                </li>
              ))}
              {d.limits.filter((l) => l.startsWith('Do not')).map((l) => <li key={l} className="flex gap-2 rounded-xl bg-bad/[.06] p-3 text-xs text-ink-2 ring-1 ring-inset ring-bad/20 sm:col-span-2"><ShieldAlert className="h-3.5 w-3.5 shrink-0 text-bad" aria-hidden />{l}</li>)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function EvidencePanel({ events }: { events: CaseEvent[] }) {
  const { method } = lifecycleFigures(events);
  const m = method ? METHODS[method] : null;
  const examined = (field: string) => events.filter((e) => e.kind === 'observation' && e.body.field === field);
  if (!m) return null;
  const groups: Array<{ key: 'request' | 'receipt' | 'payment'; label: string; field: string }> = [
    { key: 'request', label: 'Request and order', field: 'ksd_request' },
    { key: 'receipt', label: 'Receipt and acceptance', field: 'ksd_receipt' },
    { key: 'payment', label: 'Payment', field: 'ksd_payment' },
  ];
  return (
    <Panel title={`Evidence for a ${m.short} purchase`} subtitle="Key supporting documentation, by the event it proves" action={<Link to={`/reference?tab=methods&method=${m.key}`} className="text-xs font-medium text-accent hover:underline">Method</Link>}>
      <ul className="space-y-3.5">
        {groups.map((g) => {
          const seen = examined(g.field);
          return (
            <li key={g.key}>
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
                {seen.length ? <CheckCircle2 className="h-3.5 w-3.5 text-good" aria-hidden /> : <CircleDashed className="h-3.5 w-3.5" aria-hidden />}{g.label}
              </p>
              <ul className="mt-1.5 space-y-1 pl-5">{m.ksd[g.key].map((doc) => <li key={doc} className="text-sm text-ink-2">{doc}</li>)}</ul>
              {seen.map((e) => <p key={e.id} className="mt-1 pl-5 text-xs text-good">Examined: {String(e.body.display || e.body.value_text)}</p>)}
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-2xs text-ink-3">Evidence belongs to its event: an approved request proves authorization, not delivery or payment.</p>
    </Panel>
  );
}

/* ── The procedure checklist ───────────────────────────────────────────────────────────────── */

const STATUS_ICON: Record<string, React.ReactNode> = {
  done: <CheckCircle2 className="h-4 w-4 text-good" aria-hidden />,
  current: <CircleDot className="h-4 w-4 text-accent" aria-hidden />,
  attention: <OctagonAlert className="h-4 w-4 text-warn" aria-hidden />,
  skipped: <SkipForward className="h-4 w-4 text-ink-3" aria-hidden />,
  conditional: <GitBranch className="h-4 w-4 text-ink-3/70" aria-hidden />,
  upcoming: <Circle className="h-4 w-4 text-line-strong" aria-hidden />,
};
const STATUS_TEXT: Record<string, string> = { done: 'done', current: 'next', attention: 'needs attention', skipped: 'not needed', upcoming: 'to do', conditional: 'depends on a decision' };

function ProcedurePanel({ procedure, progress, active, resolution, onPick }: { procedure: Procedure & { pinned_version: string }; progress: { steps: Array<{ key: string; status: string; note: string | null }>; next: string | null }; active: string | null; resolution: any; onPick: (key: string) => void }) {
  const done = progress.steps.filter((s) => s.status === 'done').length;
  const counted = progress.steps.filter((s) => s.status !== 'skipped' && s.status !== 'conditional').length;
  return (
    <Panel title="Procedure" subtitle={`${procedure.title} · v${procedure.pinned_version}`} bodyClassName="p-0">
      <div className="px-5 pb-1 pt-3">
        <div className="flex items-center justify-between text-2xs text-ink-3"><span>{done} of {counted} applicable steps done</span>{resolution?.met?.ok && <span className="font-medium text-good">Resolution condition met</span>}</div>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-accent transition-[width] duration-700 [transition-timing-function:var(--ease-spring)]" style={{ width: `${counted ? (done / counted) * 100 : 0}%` }} /></div>
      </div>
      <ol className="py-2">
        {procedure.steps.map((step) => {
          const st = progress.steps.find((s) => s.key === step.key);
          const status = st?.status || 'upcoming';
          return (
            <li key={step.key}>
              <button type="button" onClick={() => onPick(step.key)} aria-current={active === step.key ? 'step' : undefined}
                className={cn('flex w-full items-start gap-2.5 px-5 py-2 text-left text-sm transition-colors hover:bg-surface-2', active === step.key && 'bg-accent-soft/60', status === 'conditional' && 'opacity-70')}>
                <span className="mt-0.5 shrink-0">{STATUS_ICON[status]}</span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-ink', status === 'skipped' && 'text-ink-3 line-through')}>{step.title}</span>
                  {st?.note && status !== 'skipped' && status !== 'conditional' && <span className="block text-xs text-ink-3">{st.note}</span>}
                </span>
                <span className="sr-only">{STATUS_TEXT[status]}</span>
              </button>
            </li>
          );
        })}
      </ol>
      <details className="border-t border-line px-5 py-3 text-xs text-ink-3">
        <summary className="cursor-pointer font-medium text-ink-2">Source: {AUTHORITY_LABEL[procedure.authority]}</summary>
        <p className="mt-2">{procedure.source}</p>
        {procedure.references?.length ? <div className="mt-2 flex flex-wrap gap-1">{procedure.references.map((r) => <span key={r} className="cite">{r}</span>)}</div> : null}
        <ul className="mt-2 list-disc space-y-1 pl-4">{procedure.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
      </details>
    </Panel>
  );
}

/* ── The current step ──────────────────────────────────────────────────────────────────────── */

function StepHelp({ step }: { step: ProcedureStep }) {
  return (
    <details className="mt-4 rounded-xl bg-surface-2/60 text-sm ring-1 ring-inset ring-line">
      <summary className="flex cursor-pointer items-center gap-2 px-3.5 py-2.5 font-medium text-ink-2"><BookOpen className="h-4 w-4 text-ink-3" aria-hidden />How to do this{step.help.system ? ` in ${step.help.system}` : ''}</summary>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-2 px-3.5 pb-3.5 sm:grid-cols-[8rem_1fr]">
        <dt className="text-xs text-ink-3">Why</dt><dd className="text-ink-2">{step.help.objective}</dd>
        <dt className="text-xs text-ink-3">What to do</dt><dd className="text-ink-2">{step.help.what}</dd>
        {step.help.meaning && <><dt className="text-xs text-ink-3">What it means</dt><dd className="text-ink-2">{step.help.meaning}</dd></>}
        <dt className="text-xs text-ink-3">Done when</dt><dd className="text-ink-2">{step.help.done}</dd>
        {step.responsibility?.length ? <><dt className="text-xs text-ink-3">Needs</dt><dd className="text-ink-2">{step.responsibility.map(responsibilityName).join(' or ')} — and the authority to use it</dd></> : null}
        <dt className="text-xs text-ink-3">Screen path</dt><dd className="text-ink-3">{step.help.path || 'Not documented yet. It will be added once an SME confirms it.'}</dd>
        {step.help.source && <><dt className="text-xs text-ink-3">Source</dt><dd><span className="cite">{step.help.source}</span></dd></>}
      </dl>
    </details>
  );
}

const CALCULATE_LABEL: Record<string, string> = {
  umt2way_award_adjustment: 'Calculate the candidate',
  umt_award_shortfall: 'Calculate the shortfall',
  lifecycle_residual: 'Calculate the open residual',
};

/** A gate the step is waiting on, shown before the person tries and gets refused. */
function GateNotice({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="mt-4 flex flex-wrap items-start gap-2.5 rounded-xl bg-warn/[.07] px-3.5 py-2.5 text-sm text-ink ring-1 ring-inset ring-warn/25">
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden /><span className="min-w-0 flex-1">{message}</span>{action}
    </div>
  );
}

function StepPanel({ itemId, procedure, step, status, caseData, events, canAct, focused, onBackToNext, onDone, onResolve, onJump }: {
  itemId: string; procedure: Procedure; step: ProcedureStep; status: { status: string; note: string | null } | null; caseData: any; events: CaseEvent[]; canAct: boolean; focused: boolean;
  onBackToNext: () => void; onDone: () => void; onResolve: () => void; onJump: (key: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [notShown, setNotShown] = useState<Record<string, boolean>>({});
  const [extra, setExtra] = useState<Array<{ amount: string; reference: string }>>([]);
  const set = (k: string, v: string) => setValues((p) => ({ ...p, [k]: v }));
  const [key] = useState(newKey);
  const recorded = (field: string) => caseData.events.filter((e: any) => e.kind === 'observation' && e.body.field === field && !e.superseded);
  const applies = stepApplies(step, events);
  const requiresMet = step.requires ? isVerified(events, step.requires.check) : true;
  const prerequisite = step.requires ? procedure.steps.find((s) => s.kind === 'verification' && s.check === step.requires!.check) : null;

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
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className={cn('eyebrow', status?.status === 'attention' && 'text-warn', status?.status === 'done' && 'text-good')}>{status?.status === 'done' ? 'Done' : status?.status === 'attention' ? 'Needs attention' : status?.status === 'skipped' ? 'Not needed' : status?.status === 'conditional' ? 'Depends on a decision' : focused ? 'Step' : 'Next step'}</p>
        <h2 className="mt-1.5 text-xl font-semibold tracking-[-0.02em] text-ink">{step.title}</h2>
        {status?.note && status.status !== 'conditional' && <p className="mt-1 text-sm text-warn">{status.note}</p>}
      </div>
      {focused && <Button size="sm" variant="ghost" onClick={onBackToNext}>Back to the next step</Button>}
    </div>
  );

  let form: React.ReactNode = null;
  if (!canAct) {
    form = <p className="mt-4 text-sm text-ink-3">Whoever holds this work records it.</p>;
  } else if (applies === false) {
    form = <p className="mt-4 text-sm text-ink-3">The decision recorded on this case rules this step out.</p>;
  } else if (applies === null) {
    const decision = procedure.steps.find((s) => s.decision?.key === step.onlyWhen?.decision);
    form = <GateNotice message={`This step applies only if the decision is ${step.onlyWhen!.choices.map((ch) => `“${decision?.decision?.choices.find((x) => x.key === ch)?.label || ch}”`).join(' or ')}.`} action={decision ? <Button size="xs" onClick={() => onJump(decision.key)}>Go to the decision</Button> : undefined} />;
  } else if (step.kind === 'research') {
    const fields = step.fields || [];
    const bodies = (): Array<Record<string, unknown>> => {
      const out: Array<Record<string, unknown>> = [];
      for (const f of fields) {
        const v = (values[f.key] || '').trim();
        if (notShown[f.key]) { out.push({ kind: 'observation', field: f.key, label: f.label, not_shown: true, system: values.system || 'DAI' }); continue; }
        if (v) out.push({ kind: 'observation', field: f.key, label: f.label, ...(f.money ? { amount: v } : { value_text: v }), reference: values[`${f.key}:ref`] || null, system: values.system || 'DAI' });
        if (f.multiple) for (const inv of extra) if (inv.amount.trim()) out.push({ kind: 'observation', field: f.key, label: f.label, amount: inv.amount.trim(), reference: inv.reference || null, system: values.system || 'DAI' });
      }
      return out;
    };
    form = (
      <div className="mt-5 space-y-3.5">
        {fields.map((f) => <ResearchField key={f.key} f={f} have={recorded(f.key)} value={values[f.key] || ''} reference={values[`${f.key}:ref`] || ''} notShown={Boolean(notShown[f.key])}
          onValue={(v) => set(f.key, v)} onReference={(v) => set(`${f.key}:ref`, v)} onNotShown={(v) => setNotShown((p) => ({ ...p, [f.key]: v }))}
          extra={f.multiple ? extra : undefined} setExtra={f.multiple ? setExtra : undefined} />)}
        <Field label="Where you read it" hint="The system of record, or the report"><Input value={values.system ?? 'DAI'} onChange={(e) => set('system', e.target.value)} /></Field>
        <div className="flex justify-end">
          <Button variant="primary" loading={busy} onClick={() => {
            const b = bodies();
            if (!b.length) { toast.error('Enter at least one value.'); return; }
            void submit(b, b.length === 1 ? 'Recorded.' : `${b.length} values recorded.`);
          }}><Check className="h-4 w-4" />Record what you found</Button>
        </div>
      </div>
    );
  } else if (step.kind === 'calculation') {
    const formula = FORMULAS[step.formula || 'umt2way_award_adjustment'];
    form = (
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 max-w-xl">
          <p className="text-sm text-ink-2">{formula?.text}</p>
          <p className="mt-1 text-xs text-ink-3">Every input is cited with where it came from. {formula?.applicability}</p>
        </div>
        <Button variant="primary" loading={busy} onClick={async () => {
          setBusy(true);
          try { await api.calculateCase(itemId, step.key); toast.success('Calculated.'); onDone(); }
          catch (e) { toast.error(api.errorText(e)); }
          finally { setBusy(false); }
        }}><Calculator className="h-4 w-4" />{status?.status === 'attention' ? 'Calculate again' : CALCULATE_LABEL[formula?.key || ''] || 'Calculate'}</Button>
      </div>
    );
  } else if (step.kind === 'decision' && step.decision) {
    form = (
      <div className="mt-5 space-y-3.5">
        {!requiresMet && step.requires && <GateNotice message={step.requires.message} action={prerequisite ? <Button size="xs" onClick={() => onJump(prerequisite.key)}>{prerequisite.title}</Button> : undefined} />}
        <fieldset disabled={!requiresMet}>
          <legend className="mb-2 text-base font-medium text-ink">Your decision</legend>
          <div className="grid gap-2">
            {step.decision.choices.map((ch) => (
              <label key={ch.key} className="flex cursor-pointer items-start gap-3 rounded-xl px-3.5 py-3 text-sm ring-1 ring-inset ring-line transition-colors hover:bg-surface-2/60 has-[:checked]:bg-accent-soft/50 has-[:checked]:ring-accent/40">
                <input type="radio" className="mt-0.5" name={`decision-${step.key}`} value={ch.key} checked={values.choice === ch.key} onChange={() => set('choice', ch.key)} />
                <span className="min-w-0"><span className="block font-medium text-ink">{ch.label}</span>{ch.hint && <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{ch.hint}</span>}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <Field label="Why" required hint="A reviewer reads this later."><Textarea rows={2} value={values.rationale || ''} onChange={(e) => set('rationale', e.target.value)} placeholder="What the evidence showed, and where you saw it." /></Field>
        <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={!requiresMet || !values.choice || !values.rationale?.trim()} onClick={() => submit([{ kind: 'decision', decision: step.decision!.key, choice: values.choice, rationale: values.rationale }], 'Decision recorded.')}><Check className="h-4 w-4" />Record the decision</Button></div>
      </div>
    );
  } else if (step.kind === 'action') {
    const prepareOnly = Boolean(step.prepareOnly);
    const gated = step.gate === 'funds_check';
    const needsAck = gated && caseData.latest_funds_check?.result === 'WARNING';
    const fundsBlocked = gated && (!caseData.latest_funds_check || ['FAILED', 'NOT_RUN', 'UNKNOWN'].includes(caseData.latest_funds_check.result));
    const blocked = fundsBlocked || !requiresMet;
    form = (
      <div className="mt-5 space-y-3.5">
        {fundsBlocked && <GateNotice message={caseData.latest_funds_check ? `The latest funds check is ${caseData.latest_funds_check.result}. Submission waits on a PASSED check.` : 'Record the funds check first. Submission waits on a PASSED check.'} />}
        {!requiresMet && step.requires && <GateNotice message={step.requires.message} action={prerequisite ? <Button size="xs" onClick={() => onJump(prerequisite.key)}>{prerequisite.title}</Button> : undefined} />}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Reference" hint="The document, modification or request number"><Input value={values.reference || ''} onChange={(e) => set('reference', e.target.value)} /></Field>
          <Field label="Note"><Input value={values.text || ''} onChange={(e) => set('text', e.target.value)} /></Field>
        </div>
        {needsAck && <Field label="The funds check warned. Why is submitting still right?" required><Textarea rows={2} value={values.ack || ''} onChange={(e) => set('ack', e.target.value)} /></Field>}
        {!prepareOnly && step.waitsOn && (
          <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" checked={values.wait !== 'no'} onChange={(e) => set('wait', e.target.checked ? 'yes' : 'no')} />Then wait on {WAITING_LABEL[step.waitsOn].toLowerCase()}</label>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button loading={busy} onClick={() => submit([{ kind: 'action_prepared', reference: values.reference || null, text: values.text || null }], 'Recorded as prepared. Nothing is submitted yet.')}>Record as prepared</Button>
          {!prepareOnly && (
            <Button variant="primary" loading={busy} disabled={blocked} onClick={() => submit([{ kind: 'action_submitted', reference: values.reference || null, text: values.text || null, control_acknowledgement: values.ack || null, then_wait: step.waitsOn && values.wait !== 'no' ? step.waitsOn : null }], 'Recorded as submitted. Submitted is not approved.')}>
              <Send className="h-4 w-4" />Record as submitted
            </Button>
          )}
        </div>
      </div>
    );
  } else if (step.kind === 'external' && step.observes) {
    const target = observedStep(procedure, step, events) || step.observes.step || '';
    const targetTitle = procedure.steps.find((s) => s.key === target)?.title;
    form = (
      <div className="mt-5 space-y-3.5">
        {targetTitle && <p className="text-sm text-ink-2">Observing: <span className="font-medium text-ink">{targetTitle}</span></p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="What the system shows"><Select value={values.event || ''} placeholder="Choose" onValueChange={(v) => set('event', v)} options={EXTERNAL_EVENTS.map((e) => ({ value: e, label: e[0].toUpperCase() + e.slice(1) }))} /></Field>
          <Field label="Seen on"><Input type="date" value={values.on || ''} onChange={(e) => set('on', e.target.value)} /></Field>
          <Field label="Reference"><Input value={values.reference || ''} onChange={(e) => set('reference', e.target.value)} /></Field>
        </div>
        <p className="text-xs text-ink-3">Record approval and {step.observes.completesOn} separately, each when you see it.</p>
        <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={!values.event || !target} onClick={() => submit([{ kind: 'external_event', step: target, event: values.event, system: 'DAI', reference: values.reference || null, observed_on: values.on || null }], 'Recorded what the system shows.')}><Check className="h-4 w-4" />Record it</Button></div>
      </div>
    );
  } else if (step.kind === 'control') {
    form = (
      <div className="mt-5 space-y-3.5">
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
      <div className="mt-5 space-y-3.5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Result"><Select value={values.result || ''} placeholder="Choose" onValueChange={(v) => set('result', v)} options={[{ value: 'verified', label: 'Verified' }, { value: 'not_verified', label: 'Checked, not verified' }]} /></Field>
          <Field label="What you checked" required={values.result === 'verified'} hint="Required to mark it verified"><Input value={values.reference || ''} onChange={(e) => set('reference', e.target.value)} placeholder="Report and date, the record you looked at" /></Field>
        </div>
        <Field label="What it showed"><Input value={values.text || ''} onChange={(e) => set('text', e.target.value)} /></Field>
        <div className="flex justify-end"><Button variant="primary" loading={busy} disabled={!values.result || (values.result === 'verified' && !values.reference?.trim())} onClick={() => submit([{ kind: 'verification', check: step.check, result: values.result, reference: values.reference || null, text: values.text || null }], 'Verification recorded.')}><Check className="h-4 w-4" />Record the verification</Button></div>
      </div>
    );
  } else if (step.kind === 'resolution') {
    const checks = caseData.resolution?.checks || [];
    const met = caseData.resolution?.met;
    form = (
      <div className="mt-5 space-y-3">
        <ul className="space-y-1.5">
          {checks.map((r: { check: string; label: string }) => (
            <li key={r.check} className="flex items-center gap-2 text-sm">{met?.check === r.check ? <CheckCircle2 className="h-4 w-4 text-good" aria-hidden /> : <CircleDashed className="h-4 w-4 text-ink-3" aria-hidden />}<span className={met?.check === r.check ? 'text-ink' : 'text-ink-2'}>{r.label}</span></li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-ink-2">{met?.ok ? 'The resolution condition is met.' : `Resolves once ${checks.length > 1 ? 'one of these is' : 'this is'} verified.`}</p>
          <Button variant="primary" disabled={!met?.ok} onClick={onResolve}><CheckCircle2 className="h-4 w-4" />Resolve</Button>
        </div>
      </div>
    );
  }

  return (
    <section className="card p-5 sm:p-6" aria-label={`Step: ${step.title}`}>
      {heading}
      <StepHelp step={step} />
      {form}
    </section>
  );
}

function ResearchField({ f, have, value, reference, notShown, onValue, onReference, onNotShown, extra, setExtra }: {
  f: ProcedureField; have: any[]; value: string; reference: string; notShown: boolean;
  onValue: (v: string) => void; onReference: (v: string) => void; onNotShown: (v: boolean) => void;
  extra?: Array<{ amount: string; reference: string }>; setExtra?: (fn: (p: Array<{ amount: string; reference: string }>) => Array<{ amount: string; reference: string }>) => void;
}) {
  const label = have.length && f.multiple ? `Another ${f.label.toLowerCase()}` : f.label;
  const showInput = !have.length || f.multiple;
  return (
    <div>
      {have.length > 0 && (
        <p className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
          <FileCheck2 className="h-3.5 w-3.5 text-good" aria-hidden /><span className="font-medium text-ink-2">{f.label}:</span>
          {have.map((e: any) => `${e.body.display}${e.body.reference ? ` (${e.body.reference})` : ''}`).join(', ')}
          {have[0].body.source === 'source_file' ? <span className="chip">from the imported sheet</span> : null}
        </p>
      )}
      {showInput && (
        <div className={cn('grid grid-cols-1 gap-2', f.multiple && 'sm:grid-cols-[1fr_12rem]', f.allowNotShown && 'sm:grid-cols-[1fr_auto]')}>
          <Field label={<>{label}{f.optional && <span className="ml-1.5 text-xs font-normal text-ink-3">optional</span>}</>} hint={f.hint || (f.money ? 'As shown, e.g. 45,000.00' : undefined)}>
            {f.options
              ? <Select value={value} onValueChange={onValue} placeholder="Choose" options={f.options.map((o) => ({ value: o.key, label: o.label }))} />
              : f.money || f.quantity
                ? <NumberInput value={notShown ? '' : value} disabled={notShown} onChange={(e) => onValue(e.target.value)} placeholder={notShown ? 'Not shown' : f.quantity ? '0' : '0.00'} />
                : <Input value={value} onChange={(e) => onValue(e.target.value)} />}
          </Field>
          {f.multiple && <Field label="Reference"><Input value={reference} onChange={(e) => onReference(e.target.value)} placeholder="Invoice number" /></Field>}
          {f.allowNotShown && (
            <label className="flex cursor-pointer items-center gap-1.5 self-end pb-2.5 text-xs text-ink-3" title="The report shows a dash. That is recorded as its own fact, not as zero.">
              <input type="checkbox" checked={notShown} onChange={(e) => onNotShown(e.target.checked)} />Not shown
            </label>
          )}
        </div>
      )}
      {extra && setExtra && extra.map((inv, i) => (
        <div key={i} className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_12rem]">
          <Field label={`${f.label.replace(/ amount$/i, '')} ${have.length + i + 2}`}><NumberInput value={inv.amount} onChange={(e) => setExtra((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder="0.00" /></Field>
          <Field label="Reference"><Input value={inv.reference} onChange={(e) => setExtra((p) => p.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} /></Field>
        </div>
      ))}
      {extra && setExtra && <Button size="xs" variant="ghost" className="mt-1" onClick={() => setExtra((p) => [...p, { amount: '', reference: '' }])}>+ Add another</Button>}
    </div>
  );
}

/**
 * An AI brief of the case in the reference's answer order: observed condition, meaning, possible
 * causes, research, role, next action, verification, references. Built only from the standing
 * entries and the reference's own reading of the figures; offered only where AI is switched on.
 */
function CaseBrief({ itemId }: { itemId: string }) {
  const [, , , available] = useAiModel();
  const [brief, setBrief] = useState<{ output: Record<string, unknown>; meta: { model: string; tokens: number } } | null>(null);
  if (!available) return null;
  return (
    <Panel title="Case brief" subtitle="A draft reading in the reference’s answer order. Causes are possibilities to research, never findings."
      action={<AiAction workflow="case_brief" surface="case" input={{ item_id: itemId }} label={brief ? 'Brief me again' : 'Brief me on this case'} onResult={(output, meta) => setBrief({ output, meta })} />}>
      {brief ? <AiResult output={brief.output} meta={brief.meta} primaryKey="observed_condition" /> : <p className="text-sm text-ink-3">Reads only what stands on this case. Nothing is saved, and nothing it says changes the case.</p>}
    </Panel>
  );
}

/* ── The calculation ───────────────────────────────────────────────────────────────────────── */

function CalculationPanel({ calc }: { calc: any }) {
  const badge = calc.stale ? <Badge tone="warn">Stale</Badge> : <Badge tone={calc.requires_review ? 'warn' : 'accent'}>{calc.requires_review ? 'Needs review' : 'Candidate'}</Badge>;
  return (
    <Panel title={calc.formula === 'lifecycle_residual' ? 'Open residual' : 'Candidate calculation'} subtitle={[calc.title, calc.formula_text].filter(Boolean).join(' · ')} action={badge}>
      {calc.stale && (
        <p className="mb-4 flex items-start gap-2 rounded-xl bg-warn/[.07] px-3.5 py-2.5 text-sm text-ink ring-1 ring-inset ring-warn/25"><RefreshCw className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />This figure no longer describes the case: {calc.reasons?.join('; ')}. Calculate again to include the current values.</p>
      )}
      <div className={cn(calc.stale && 'opacity-60')}>
        {(!calc.formula || calc.formula === 'umt2way_award_adjustment') && (
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Figure label="Invoice total" cents={calc.invoice_total_cents} />
            <Figure label="Target award" cents={calc.target_award_cents} />
            <Figure label={`Award adjustment (${calc.direction})`} cents={calc.adjustment_cents} signed accent />
          </dl>
        )}
        {calc.formula === 'umt_award_shortfall' && (
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Figure label="PO line" cents={calc.po_line_cents} />
            <Figure label="Billed" cents={calc.billed_cents} />
            <Figure label={`Shortfall (${calc.direction})`} cents={calc.shortfall_cents} signed accent />
          </dl>
        )}
        {calc.formula === 'lifecycle_residual' && (
          <div className="flex flex-wrap gap-2">
            {(calc.findings || []).map((f: any) => <span key={f.condition} className="inline-flex items-center gap-2 rounded-lg bg-warn/10 px-2.5 py-1.5 text-sm ring-1 ring-inset ring-warn/25"><span className="font-semibold text-ink">{f.abbr}</span><span className="text-ink-2">{f.pattern}</span><span className="fig font-semibold text-ink">{formatCents(f.residual_cents)}</span></span>)}
            {(calc.anomalies || []).map((a: any) => <span key={a.key} className="inline-flex items-center gap-2 rounded-lg bg-bad/10 px-2.5 py-1.5 text-sm text-bad ring-1 ring-inset ring-bad/25">{a.title}</span>)}
            {calc.complete && <span className="inline-flex items-center gap-2 rounded-lg bg-good/10 px-2.5 py-1.5 text-sm text-good ring-1 ring-inset ring-good/25">Nothing open between phases</span>}
          </div>
        )}
        <table className="mt-4 w-full text-sm">
          <caption className="sr-only">Inputs to the calculation</caption>
          <thead><tr className="text-left text-xs text-ink-3"><th className="py-1 font-medium">Input</th><th className="py-1 font-medium">Source</th><th className="py-1 text-right font-medium">Amount</th></tr></thead>
          <tbody>
            {(calc.inputs || []).map((i: any) => (
              <tr key={i.event_id} className="border-t border-line">
                <td className="py-2 text-ink">{i.label}</td>
                <td className="py-2 text-xs text-ink-3">{VALUE_SOURCES[i.source as keyof typeof VALUE_SOURCES]}</td>
                <td className="fig py-2 text-right text-ink">{i.field === 'purchase_method' ? (METHODS[calc.method as MethodKey]?.short || '—') : i.not_shown ? 'Not shown' : i.cents == null ? '—' : formatCents(i.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 flex items-start gap-2 text-xs text-ink-3"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />{calc.applicability}</p>
    </Panel>
  );
}

function Figure({ label, cents, signed = false, accent = false }: { label: string; cents: number; signed?: boolean; accent?: boolean }) {
  return (
    <div className={cn('rounded-xl px-3.5 py-2.5 ring-1 ring-inset', accent ? 'bg-accent-soft/60 ring-accent/25' : 'ring-line')}>
      <dt className="text-xs text-ink-3">{label}</dt>
      <dd className="fig mt-0.5 text-xl font-semibold tracking-[-0.02em] text-ink">{formatCents(cents, { signed })}</dd>
    </div>
  );
}

/* ── Work without a procedure: what you did, and optionally your record of it ─────────────────── */

/**
 * The original way to record work on a queue row, kept for work that does not follow a modelled
 * procedure: what kind of thing you did, what it moved, and whether it also goes in your own record.
 */
function ActionForm({ itemId, item, onDone }: { itemId: string; item: any; onDone: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
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
      if (res.activity_id) invalidateDomains(qc, 'activity');
      onDone();
    } catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <section className="card space-y-3.5 p-5 sm:p-6" aria-label="What did you do?">
      <h2 className="text-lg font-semibold tracking-[-0.015em] text-ink">What did you do?</h2>
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
  const fieldOptions = useMemo(() => [{ value: 'other', label: 'Something else' }, ...(procedure?.steps.flatMap((s) => (s.fields || []).filter((f) => !f.options)) || []).map((f) => ({ value: f.key, label: f.label }))], [procedure]);

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
    <section className="card p-5" aria-label="Add to the history">
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

function HistoryPanel({ itemId, events, people, procedure, canCorrect, onDone, integrity }: { itemId: string; events: any[]; people: Record<string, { name: string; rank: string | null }>; procedure: Procedure | null; canCorrect: boolean; onDone: () => void; integrity: any }) {
  const [showAll, setShowAll] = useState(false);
  const [correcting, setCorrecting] = useState<any | null>(null);
  const { data: identity } = useIdentity();
  const ordered = [...events].reverse();
  const visible = showAll ? ordered : ordered.filter((e) => !QUIET.has(e.kind)).slice(0, 25);
  const stepTitle = (k: string | null) => procedure?.steps.find((s) => s.key === k)?.title;
  const who = (id: string | null) => (id === identity?.user.id ? 'You' : id ? personName(people[id]) : 'Vantage');
  const sentence = (e: any) => historySentence(e, procedure);

  return (
    <Panel title="History" subtitle="Every change, who made it, and where each value came from. Nothing is edited; corrections are added." action={<span className="flex items-center gap-2"><IntegrityBadge integrity={integrity} /><History className="h-4 w-4 text-ink-3" aria-hidden /></span>} bodyClassName="p-0">
      <ol className="divide-y divide-line">
        {visible.map((e) => (
          <li key={e.id} className={cn('group flex gap-3 px-5 py-3 text-sm', e.superseded && 'opacity-60')}>
            <span className="w-24 shrink-0 text-xs text-ink-3" title={new Date(e.created_at).toLocaleString()}>{timeAgo(e.created_at)}</span>
            <span className="min-w-0 flex-1">
              <span className="text-ink">
                <span className="font-medium">{who(e.actor_id)}</span>{' '}
                {e.kind === 'handed_off' ? <>handed this to <span className="font-medium">{who(e.subject_id)}</span></>
                  : e.kind === 'assigned' ? <>assigned this to <span className="font-medium">{who(e.subject_id)}</span></>
                  : e.kind === 'claim_expired' ? (e.body.reason === 'left_unit' ? <>released {who(e.subject_id)}’s claim when they left the unit</> : <>released {who(e.subject_id)}’s claim after it sat untouched</>)
                  : <span className={cn(e.superseded && 'line-through')}>{sentence(e)}</span>}
              </span>
              {e.kind === 'source_revised' && Array.isArray(e.body.changes) && (
                <span className="mt-1.5 block space-y-0.5 rounded-lg bg-surface-2/70 px-3 py-2 text-xs ring-1 ring-inset ring-line">
                  {e.body.changes.slice(0, 8).map((ch: any) => <span key={ch.field} className="block text-ink-2"><span className="font-medium text-ink">{ch.field}</span>: <span className="line-through">{ch.from ?? '—'}</span> → {ch.to ?? '—'}</span>)}
                </span>
              )}
              {(e.body.note || e.body.rationale || (e.body.text && !['note', 'finding', 'question'].includes(e.kind)) || e.body.reason) && (
                <span className="mt-0.5 block text-ink-2">“{e.body.note || e.body.rationale || e.body.text || e.body.reason}”</span>
              )}
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                {e.body.source && e.kind === 'observation' && <Badge tone={e.body.source === 'source_file' ? 'neutral' : 'info'}>{e.body.source === 'source_file' ? 'From the imported sheet' : 'Read by hand'}</Badge>}
                {e.body.reference && <Badge>{e.body.reference}</Badge>}
                {e.step && stepTitle(e.step) && <span className="text-xs text-ink-3">{stepTitle(e.step)}</span>}
                {e.superseded && <Badge tone="warn">Corrected later</Badge>}
                {e.supersedes_id && <Badge tone="info">Correction</Badge>}
                {e.body.backfilled ? <span className="text-xs text-ink-3">(from before history was kept)</span> : null}
                {canCorrect && e.kind === 'observation' && !e.superseded && (
                  <button type="button" onClick={() => setCorrecting(e)} className="ml-1 text-xs font-medium text-accent opacity-0 transition-opacity hover:underline focus:opacity-100 group-hover:opacity-100">Correct</button>
                )}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {(ordered.length > visible.length || showAll) && (
        <div className="border-t border-line px-5 py-2 text-right">
          <Button size="xs" variant="ghost" onClick={() => setShowAll((v) => !v)}><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showAll && 'rotate-180')} />{showAll ? 'Show less' : `Show all ${ordered.length}`}</Button>
        </div>
      )}
      {correcting && <CorrectDialog itemId={itemId} entry={correcting} onClose={() => setCorrecting(null)} onDone={() => { setCorrecting(null); onDone(); }} />}
    </Panel>
  );
}

/** Lower-case a leading ordinary word, leaving acronyms (UMT, OCMT, DAI) as they are. */
const lowerFirst = (text: string) => (/^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);

/** One plain sentence per entry, using the procedure's own names for its steps and choices. */
function historySentence(e: any, procedure: Procedure | null): string {
  const b = e.body || {};
  const step = procedure?.steps.find((s) => s.key === (b.step || e.step));
  const stepName = step ? lowerFirst(step.title) : lowerFirst(String(b.step || e.step || 'the step').replace(/_/g, ' '));
  switch (e.kind) {
    case 'observation': return `recorded ${lowerFirst(describeEvent(e.kind, b))}`;
    case 'decision': {
      const d = procedure?.steps.find((s) => s.decision?.key === b.decision)?.decision;
      const choice = d?.choices.find((c) => c.key === b.choice)?.label;
      return `decided: ${choice ? lowerFirst(choice) : lowerFirst(describeEvent(e.kind, b))}`;
    }
    case 'calculation': return `calculated ${lowerFirst(describeEvent(e.kind, b))}`;
    case 'funds_check': return `recorded a funds check: ${b.result}${b.system ? ` in ${b.system}` : ''}`;
    case 'verification': return `${b.result === 'verified' ? 'verified' : 'checked, and could not verify,'} ${step && step.kind === 'verification' ? stepName.replace(/^verify (that )?/, '') : lowerFirst(String(b.check || '').replace(/_/g, ' '))}`;
    case 'external_event': return `saw ${stepName} ${b.event}${b.system ? ` in ${b.system}` : ''}`;
    case 'action_prepared': return `prepared ${stepName}, not submitted yet`;
    case 'action_submitted': return `submitted ${stepName}`;
    case 'question': return `asked: ${b.text || ''}`;
    case 'finding': return `found: ${b.text || ''}`;
    case 'note': return `noted: ${b.text || ''}`;
    case 'action_recorded': return `recorded work: ${String(b.action || 'worked')}${b.quantity != null ? `, ${b.quantity} ${b.unit_label || ''}`.trimEnd() : ''}`;
    case 'claimed': return 'claimed this';
    case 'released': return 'released this';
    case 'resolved': return 'resolved this';
    case 'reopened': return 'reopened this';
    case 'created': return 'brought this in';
    case 'source_revised': return `saw the source sheet change${Array.isArray(b.changes) ? ` (${b.changes.length} value${b.changes.length === 1 ? '' : 's'})` : ''}`;
    case 'procedure_applied': return b.from_version ? `moved this to procedure v${b.version} from v${b.from_version}` : `put this under ${procedure?.title || b.procedure} v${b.version}`;
    default: return lowerFirst(describeEvent(e.kind, b));
  }
}

/* ── Dialogs ───────────────────────────────────────────────────────────────────────────────── */

/** A correction supersedes an observation. The original stays in the history, marked corrected. */
function CorrectDialog({ itemId, entry, onClose, onDone }: { itemId: string; entry: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const money = Number.isSafeInteger(entry.body.amount_cents) || entry.body.not_shown;
  const [value, setValue] = useState('');
  const [notShown, setNotShown] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [key] = useState(newKey);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Correct: ${entry.body.label || entry.body.field}`} size="sm"
      description="The original stays in the history, marked as corrected. Calculations that used it will show as stale."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={(!value.trim() && !notShown) || !reason.trim()} onClick={async () => {
        setBusy(true);
        try {
          await api.recordEntry(itemId, {
            kind: 'observation', field: entry.body.field, label: entry.body.label, step: entry.step ?? null, supersedes: entry.id,
            ...(notShown ? { not_shown: true } : money ? { amount: value } : { value_text: value }),
            system: entry.body.system || 'DAI', reference: entry.body.reference || null, observed_on: null,
          }, key);
          await api.recordEntry(itemId, { kind: 'note', text: `Corrected ${String(entry.body.label || entry.body.field).toLowerCase()}: ${reason}`, step: entry.step ?? null }, `${key}-why`);
          toast.success('Corrected. The original is kept.');
          onDone();
        } catch (e) { toast.error(api.errorText(e)); }
        finally { setBusy(false); }
      }}>Record the correction</Button></>}>
      <div className="space-y-3">
        <p className="text-sm text-ink-2">Recorded: <span className="fig font-medium text-ink">{entry.body.display}</span></p>
        <Field label="Correct value">{money ? <NumberInput value={value} disabled={notShown} onChange={(e) => setValue(e.target.value)} placeholder="0.00" /> : <Input value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        {entry.body.field?.endsWith('_amount') && <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={notShown} onChange={(e) => setNotShown(e.target.checked)} />The source shows no amount</label>}
        <Field label="Why" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Read the wrong line; the award is 91,000.00." /></Field>
      </div>
    </Dialog>
  );
}

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
          <Select value={to} onValueChange={setTo} placeholder={candidates.isPending ? 'Loading…' : candidates.data?.length === 0 ? 'Nobody else can pick this up' : 'Choose a teammate'}
            options={(candidates.data || []).map((p) => ({ value: p.id, label: [p.rank, p.name].filter(Boolean).join(' ') }))} />
        </Field>
        <Field label="What they need to know" required><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Award and invoices recorded. Funding decision next." /></Field>
      </div>
    </Dialog>
  );
}

function StageDialog({ itemId, version, stage, procedure, resolution, onClose, onDone }: { itemId: string; version: number; stage: Stage; procedure: Procedure | null; resolution: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const needsCategory = stage === 'waiting';
  const needsReason = stage === 'blocked' || (stage === 'not_applicable' && Boolean(procedure));
  const blockedResolve = stage === 'resolved' && procedure && !resolution?.met?.ok;
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} title={`Move to ${STAGE_LABEL[stage].toLowerCase()}`} size="sm"
      description={stage === 'resolved' && procedure ? 'This work follows a procedure, so it resolves only once its outcome is verified.' : stage === 'waiting' ? 'Waiting time is tracked as elapsed time, never as work.' : stage === 'not_applicable' && procedure ? 'Closing procedure work as not applicable closes it without verifying it, so say why.' : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={Boolean(blockedResolve) || (needsCategory && !category) || (needsReason && !reason.trim())} onClick={async () => {
        setBusy(true);
        try { await api.changeStage(itemId, { stage, waiting_category: category || null, reason: reason || null, version }); toast.success(`Moved to ${STAGE_LABEL[stage].toLowerCase()}.`); onDone(); }
        catch (e) { toast.error(api.errorText(e)); }
        finally { setBusy(false); }
      }}>Move it</Button></>}>
      <div className="space-y-3">
        {blockedResolve && <p className="flex items-start gap-2 rounded-xl bg-warn/[.07] px-3.5 py-2.5 text-sm text-ink ring-1 ring-inset ring-warn/25"><Lock className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />Not yet: {(resolution?.checks || []).map((r: any) => r.label.toLowerCase()).join(', or ')}.</p>}
        {needsCategory && <Field label="Waiting on" required><Select value={category} onValueChange={setCategory} placeholder="Choose" options={WAITING_CATEGORIES.map((w) => ({ value: w, label: WAITING_LABEL[w] }))} /></Field>}
        <Field label={stage === 'blocked' ? 'What is blocking it' : 'Reason'} required={needsReason}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Dialog>
  );
}
