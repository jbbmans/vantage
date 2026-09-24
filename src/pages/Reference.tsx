import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, BookOpen, CheckCircle2, ChevronRight, CircleDot, FileCheck2, Info, KeyRound, Layers, ScrollText, Search, ShieldAlert, Split,
} from 'lucide-react';
import { PageHeader, Tabs, Input, Segmented, Field, NumberInput } from '@/components/ui/primitives';
import { useParam } from '@/components/common';
import Diagnoser from '@/components/fmra/Diagnoser';
import LifecycleBars from '@/components/fmra/LifecycleBars';
import { cn } from '@/lib/utils';
import {
  FMRAC_SOURCE, STATEMENT_LABEL, citeText, PHASES, PHASE_INFO, GL_NOTE, ACCOUNTING_STATUSES, PENDING_FILE, trueAvailableBalance, TRUE_AVAILABLE_EXAMPLE,
  BUDGET_SEQUENCE, BUDGET_NOTES, FUNDING_LEVELS, DAI, FEEDERS, FEEDER_NOTES, METHODS, METHOD_LIST, PAYMENT_TIMING, REQUIREMENT_ELEMENTS, ROUTING,
  ROUTING_NOTES, PRINTED_THRESHOLDS, THRESHOLD_NOTE, routeRequirement, APPROVAL_CHAIN, KSD_GROUPS, AUDIT_READINESS, RECONCILIATION_CHECKPOINTS,
  RECEIPT_STATES, SERVMART_FUEL_RULE, EVIDENCE_RULES, AUTHORITY_FACTS, PROCUREMENT_PEOPLE, COMPTROLLER_GROUPS, COMPTROLLER_OFFICE, DAI_RESPONSIBILITIES,
  SPECIAL_ROLES, SEPARATION_OF_DUTIES, ROLE_RECORD_FIELDS, FDE, POET, SLOA, GENERATORS, SHARED_SETUP, SETUP_RULE, METHOD_SETUP, FCCCB, JON, MISSION, MAGTF,
  ORG_MODEL, GROUND_UNITS, STAFF_SECTIONS, ORG_NOTE, NORMAL_LIST, REPORT_NOTES, KPI, OAS, RESEARCH_FACTORS, RESEARCH_SEQUENCE, ANALYSIS_TYPES, ABNORMAL,
  MATCHING, MATCHING_NOTE, ERROR_CLASSES, FEEDER_REJECTS, INTERFACE_ERRORS, INVOICE_HOLDS, UMT, UMT_ERRORS, UMT_INSUFFICIENT_FUNDS, UMT_STAGES,
  UMT_RESEARCH_FIELDS, UMT_COMPLETION, ROUTES, ROUTE_LIMIT, CORRECTION_STATES, searchGlossary, DISCREPANCIES, NOT_TAUGHT, STATEMENT_TYPES, INFERENCE_RULE,
  CASE_RECORD, ANSWER_FORMAT, NEVER, type MethodKey, type Cite,
} from '../../shared/fmra';
import { formatCents, parseMoney } from '../../shared/money';
import { PROCEDURE_LIST, AUTHORITY_LABEL } from '../../shared/procedures';

/**
 * The FMRA desk reference.
 *
 * What a 3451 needs within reach while working a queue: how a dollar moves, how each purchase method
 * is evidenced, what an open balance or a UMT means and what to check first, who can act, and where
 * the book itself is uncertain. Every section cites the reference it came from and says whether it
 * is source or editorial, because a clean screen must never look more authoritative than its source.
 */

type Tab = 'diagnose' | 'lifecycle' | 'methods' | 'conditions' | 'abnormal' | 'roles' | 'data' | 'glossary' | 'limits';
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'diagnose', label: 'Diagnose' },
  { value: 'lifecycle', label: 'Lifecycle' },
  { value: 'methods', label: 'Purchase methods' },
  { value: 'conditions', label: 'Open balances' },
  { value: 'abnormal', label: 'Holds, rejects & UMTs' },
  { value: 'roles', label: 'Roles & authority' },
  { value: 'data', label: 'Financial data' },
  { value: 'glossary', label: 'Glossary' },
  { value: 'limits', label: 'Source & limits' },
];

export default function Reference() {
  const [tab, setTab] = useParam('tab', 'diagnose');
  const current = (TABS.some((t) => t.value === tab) ? tab : 'diagnose') as Tab;
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
  }, [current]);

  return (
    <div className="page">
      <PageHeader eyebrow="FMRA desk reference" title="Know what the balance is telling you." lede="The financial lifecycle, the seven purchase methods and their evidence, open balances, holds, rejects and UMTs — with a diagnoser that reads the four figures and says what to check first.">
        <SourceBadge />
      </PageHeader>
      <Tabs value={current} onChange={(v) => setTab(v)} tabs={TABS} />
      <div className="mt-6">
        {current === 'diagnose' && <DiagnoseTab />}
        {current === 'lifecycle' && <LifecycleTab />}
        {current === 'methods' && <MethodsTab />}
        {current === 'conditions' && <ConditionsTab />}
        {current === 'abnormal' && <AbnormalTab />}
        {current === 'roles' && <RolesTab />}
        {current === 'data' && <DataTab />}
        {current === 'glossary' && <GlossaryTab />}
        {current === 'limits' && <LimitsTab />}
      </div>
    </div>
  );
}

/* ── Shared pieces ─────────────────────────────────────────────────────────────────────────── */

function SourceBadge() {
  return (
    <Link to="/reference?tab=limits" className="group flex max-w-sm items-center gap-3 rounded-2xl bg-surface p-2 pr-4 shadow-card transition-shadow hover:shadow-lift">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-b from-[#12294A] to-[#0A1B33] text-white shadow-[inset_0_1px_0_rgb(255_255_255/.12)]"><BookOpen className="h-4 w-4" /></span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-ink">{FMRAC_SOURCE.title}</span>
        <span className="block truncate text-xs text-ink-3">Training reference · not current policy</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

const CiteChip = ({ c }: { c: Cite }) => (
  <span className={cn('cite', c.kind === 'discrepancy' && 'bg-warn/10 text-warn', c.kind === 'editorial' && 'bg-info/10 text-info')} title={STATEMENT_LABEL[c.kind || 'source']}>
    {citeText(c)}{c.kind && c.kind !== 'source' ? ` · ${STATEMENT_LABEL[c.kind].toLowerCase()}` : ''}
  </span>
);

function Section({ id, title, lede, cite, children, className }: { id?: string; title: string; lede?: React.ReactNode; cite?: Cite; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={cn('card scroll-mt-24 p-5 sm:p-6', className)}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 max-w-3xl">
          <h2 className="text-lg font-semibold tracking-[-0.015em] text-ink">{title}</h2>
          {lede && <p className="mt-1 text-sm leading-relaxed text-ink-3">{lede}</p>}
        </div>
        {cite && <CiteChip c={cite} />}
      </div>
      {children}
    </section>
  );
}

function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: React.ReactNode }) {
  const Icon = tone === 'info' ? Info : tone === 'warn' ? AlertTriangle : ShieldAlert;
  return (
    <p className={cn('flex gap-2.5 rounded-xl px-3.5 py-2.5 text-sm leading-relaxed ring-1 ring-inset',
      tone === 'info' && 'bg-info/[.06] text-ink-2 ring-info/15', tone === 'warn' && 'bg-warn/[.07] text-ink-2 ring-warn/20', tone === 'bad' && 'bg-bad/[.06] text-ink-2 ring-bad/20')}>
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone === 'info' && 'text-info', tone === 'warn' && 'text-warn', tone === 'bad' && 'text-bad')} aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Bullets({ items, ordered = false }: { items: readonly string[]; ordered?: boolean }) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag className="space-y-2">
      {items.map((t, i) => (
        <li key={t} className="flex gap-3 text-sm leading-relaxed text-ink-2">
          {ordered ? <span className="fig mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-surface-2 text-2xs font-semibold text-ink-3 ring-1 ring-inset ring-line">{i + 1}</span> : <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-ink-3/60" aria-hidden />}
          <span>{t}</span>
        </li>
      ))}
    </Tag>
  );
}

function DataTable({ head, rows, minWidth = 560 }: { head: string[]; rows: React.ReactNode[][]; minWidth?: number }) {
  return (
    <div className="scroll-x -mx-1 px-1">
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        <thead><tr className="border-b border-line text-left">{head.map((h) => <th key={h} className="table-head px-3 py-2 first:pl-0">{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="row align-top">{r.map((c, j) => <td key={j} className={cn('px-3 py-2.5 text-ink-2 first:pl-0', j === 0 && 'font-medium text-ink')}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/* ── Diagnose ──────────────────────────────────────────────────────────────────────────────── */

function DiagnoseTab() {
  return (
    <div className="space-y-5">
      <Diagnoser />
      <Section title="Procedures that work these conditions" lede="Apply one to a work item and the case follows its steps, with the book’s evidence rules enforced as controls.">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {PROCEDURE_LIST.map((p) => (
            <div key={p.key} className="rounded-xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line">
              <div className="flex items-center justify-between gap-2">
                <span className="rounded-md bg-surface px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-ink-2 ring-1 ring-inset ring-line">{p.short}</span>
                <span className="fig text-2xs text-ink-3">v{p.version} · {p.steps.length} steps</span>
              </div>
              <p className="mt-2.5 text-sm font-semibold leading-snug text-ink">{p.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-3">{p.trigger}</p>
              <p className="mt-2 text-2xs text-ink-3">{AUTHORITY_LABEL[p.authority]}</p>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

/* ── Lifecycle ─────────────────────────────────────────────────────────────────────────────── */

function LifecycleTab() {
  return (
    <div className="space-y-5">
      <Section title="Four phases, four separate facts" lede="Procurement acquires the good or service; the financial lifecycle records what those events mean in money. A receipt does not prove the DAI receipt posted, and a payment does not prove it matched the intended award." cite={PHASE_INFO.commitment.cite}>
        <ol className="grid gap-3 md:grid-cols-4">
          {PHASES.map((key, i) => {
            const p = PHASE_INFO[key];
            return (
              <li key={key} className="relative rounded-xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line">
                <p className="fig text-2xs font-semibold text-ink-3">0{i + 1}</p>
                <p className="mt-1 text-md font-semibold text-ink">{p.label}</p>
                <p className="mt-1 text-sm leading-relaxed text-ink-2">{p.meaning}</p>
                <dl className="mt-3 space-y-1 border-t border-line pt-3 text-xs">
                  <div className="flex justify-between gap-2"><dt className="text-ink-3">In DAI</dt><dd className="text-right text-ink">{p.dai}</dd></div>
                  <div className="flex justify-between gap-2"><dt className="text-ink-3">GL example</dt><dd className="fig text-right text-ink">{p.gl.account} {p.gl.title}</dd></div>
                </dl>
                {i < 3 && <ArrowRight className="absolute -right-3 top-1/2 hidden h-4 w-4 -translate-y-1/2 text-ink-3 md:block" aria-hidden />}
              </li>
            );
          })}
        </ol>
        <p className="mt-3 text-xs text-ink-3">{GL_NOTE}</p>
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Pending, posted, completed" cite={PENDING_FILE.cite}>
          <div className="space-y-3">
            {ACCOUNTING_STATUSES.map((s) => (
              <div key={s.key} className="flex gap-3">
                <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
                <div><p className="text-sm font-semibold text-ink">{s.label}</p><p className="text-sm text-ink-2">{s.meaning}</p><p className="mt-0.5 text-xs text-ink-3">{s.practice}</p></div>
              </div>
            ))}
            <Note>{PENDING_FILE.meaning} {PENDING_FILE.rule}</Note>
          </div>
        </Section>
        <TrueBalance />
      </div>

      <Section title="Where the money comes from" lede="The book’s simplified budget sequence. Classroom timing labels, not guaranteed enactment dates." cite={BUDGET_NOTES[0].cite}>
        <ol className="relative space-y-3 border-l border-line pl-5">
          {BUDGET_SEQUENCE.map((b, i) => (
            <li key={b.step} className="relative">
              <span className="absolute -left-[26px] top-1 flex h-3 w-3 items-center justify-center rounded-full bg-surface ring-2 ring-accent/60" aria-hidden />
              <p className="text-sm text-ink"><span className="fig mr-2 text-ink-3">{i + 1}</span>{b.step}</p>
              {b.timing && <p className="text-xs text-ink-3">{b.timing}</p>}
            </li>
          ))}
        </ol>
        <div className="mt-4 flex flex-wrap gap-2">{FUNDING_LEVELS.map((l) => <span key={l.level} className="chip"><span className="font-semibold text-ink">{l.level}</span>{l.organization}</span>)}</div>
        <div className="mt-4 space-y-2">{BUDGET_NOTES.map((n) => <Note key={n.text} tone={n.cite.kind === 'discrepancy' ? 'warn' : 'info'}>{n.text}</Note>)}</div>
      </Section>

      <Section title={DAI.name} lede={DAI.summary} cite={DAI.cite}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {DAI.modules.map((m) => <div key={m.key} className="rounded-xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line"><p className="font-mono text-xs font-semibold text-accent">{m.key}</p><p className="mt-1 text-sm font-semibold text-ink">{m.name}</p><p className="mt-1 text-xs leading-relaxed text-ink-2">{m.does}</p></div>)}
        </div>
      </Section>

      <Section title="Business feeder systems" lede="Where each method’s data originates, and how it reaches DAI." cite={FEEDER_NOTES[0].cite}>
        <DataTable head={['Method', 'Source system', 'Tool', 'Posting pattern']} rows={FEEDERS.map((f) => [METHODS[f.method as MethodKey].short, f.source, f.tool, f.posting])} minWidth={760} />
        <div className="mt-4 space-y-2">{FEEDER_NOTES.map((n) => <Note key={n.text}>{n.text}</Note>)}</div>
      </Section>

      <Section title="Evidence and audit readiness" lede={AUDIT_READINESS.definition} cite={AUDIT_READINESS.cite}>
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <p className="eyebrow mb-2.5">Reconciliation checkpoints</p>
            <Bullets ordered items={RECONCILIATION_CHECKPOINTS} />
          </div>
          <div>
            <p className="eyebrow mb-2.5">Keep these states apart</p>
            <ol className="space-y-2">{RECEIPT_STATES.map((r, i) => <li key={r.key} className="flex gap-3 text-sm"><span className="fig w-4 shrink-0 text-ink-3">{i + 1}</span><span><span className="font-medium text-ink">{r.label}.</span> <span className="text-ink-2">{r.meaning}</span></span></li>)}</ol>
            <p className="mt-3 text-xs text-ink-3">Combining these into a single “done” removes the evidence needed to explain an open balance.</p>
          </div>
        </div>
        <div className="mt-5 grid gap-2 md:grid-cols-3">{KSD_GROUPS.map((g) => <div key={g.key} className="rounded-xl bg-surface-2/70 p-3.5 ring-1 ring-inset ring-line"><p className="text-sm font-semibold text-ink">{g.label}</p><p className="mt-0.5 text-xs text-ink-2">{g.proves}</p></div>)}</div>
        <div className="mt-4 space-y-2">
          {EVIDENCE_RULES.map((r) => <Note key={r.text}>{r.text}</Note>)}
          <Note tone="warn">{SERVMART_FUEL_RULE.text}</Note>
        </div>
      </Section>
    </div>
  );
}

function TrueBalance() {
  const [displayed, setDisplayed] = useState('1000.00');
  const [pending, setPending] = useState('150.00');
  const [posted, setPosted] = useState(false);
  const d = parseMoney(displayed); const p = parseMoney(pending);
  const r = d.ok && p.ok ? trueAvailableBalance({ displayedAvailableCents: d.cents, pendingNotReflected: [{ label: 'Pending purchase', cents: p.cents, posted }] }) : null;
  return (
    <Section title="True available balance" lede="What is left after valid execution, including pending items the displayed balance does not show yet." cite={TRUE_AVAILABLE_EXAMPLE.cite}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Displayed available"><NumberInput value={displayed} onChange={(e) => setDisplayed(e.target.value)} /></Field>
        <Field label="Valid pending, not yet reflected"><NumberInput value={pending} onChange={(e) => setPending(e.target.value)} /></Field>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" checked={posted} onChange={(e) => setPosted(e.target.checked)} />It has since posted</label>
      <div className="mt-4 flex items-baseline justify-between rounded-xl bg-surface-2/70 px-4 py-3 ring-1 ring-inset ring-line">
        <span className="text-sm text-ink-2">Adjusted view</span>
        <span className="stat-value text-[26px]">{r ? formatCents(r.adjustedCents) : '—'}</span>
      </div>
      {r?.ignored[0] && <p className="mt-2 text-xs text-ink-3">{r.ignored[0].reason}</p>}
      <p className="mt-3 text-xs leading-relaxed text-ink-3">Use non-overlapping balances: never subtract commitment, obligation, delivery and payment as four separate purchases of the same item.</p>
    </Section>
  );
}

/* ── Methods ───────────────────────────────────────────────────────────────────────────────── */

function MethodsTab() {
  const [key, setKey] = useParam('method', 'servmart');
  const m = METHODS[(METHODS[key as MethodKey] ? key : 'servmart') as MethodKey];
  return (
    <div className="space-y-5">
      <Router />
      <div className="grid gap-5 lg:grid-cols-[260px_minmax(0,1fr)]">
        <nav aria-label="Purchase methods" className="card self-start p-2 lg:sticky lg:top-24">
          {METHOD_LIST.map((x) => (
            <button key={x.key} type="button" onClick={() => setKey(x.key)} aria-current={x.key === m.key ? 'true' : undefined}
              className={cn('flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors', x.key === m.key ? 'bg-accent-soft text-ink' : 'text-ink-2 hover:bg-surface-2')}>
              <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-2xs font-bold', x.key === m.key ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink-3 ring-1 ring-inset ring-line')}>{x.short.slice(0, 3).toUpperCase()}</span>
              <span className="min-w-0"><span className="block truncate text-sm font-medium">{x.name}</span><span className="block truncate text-2xs text-ink-3">{x.tool}</span></span>
            </button>
          ))}
        </nav>
        <article className="min-w-0 space-y-5">
          <section className="card p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="eyebrow">Purchase method</p>
                <h2 className="mt-1.5 text-2xl font-semibold tracking-[-0.025em] text-ink">{m.name}</h2>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-2">{m.use}</p>
              </div>
              <CiteChip c={m.cite} />
            </div>
            <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Fact label="Systems" value={m.systems.join(' · ')} />
              <Fact label="Tool" value={m.tool} />
              <Fact label="Accounting link" value={m.keyLink} />
              <Fact label="Identifier" value={`${m.identifier.id} — ${m.identifier.generator}`} hint={m.identifier.owner} />
            </dl>
            {m.critical && <div className="mt-4"><Note tone="warn">{m.critical}</Note></div>}
          </section>

          <section className="card p-5 sm:p-6" aria-label="Procedure">
            <h3 className="text-md font-semibold text-ink">The procedure</h3>
            <p className="mt-0.5 text-xs text-ink-3">Adds to the shared setup: {m.setup}</p>
            <div className="mt-5 space-y-6">
              {m.phases.map((phase) => (
                <div key={phase.title}>
                  <p className="eyebrow mb-3">{phase.title}</p>
                  <ol className="relative space-y-3 border-l border-line pl-5">
                    {phase.steps.map((st) => (
                      <li key={st.text} className="relative">
                        <span className="absolute -left-[25px] top-1.5 h-2.5 w-2.5 rounded-full bg-surface ring-2 ring-line-strong" aria-hidden />
                        <p className="text-sm leading-relaxed text-ink">{st.text}</p>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {st.actor && <span className="chip">{st.actor}</span>}
                          {st.evidence && <span className="chip bg-good/10 text-good ring-1 ring-inset ring-good/20"><FileCheck2 className="h-3 w-3" />{st.evidence}</span>}
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              ))}
            </div>
          </section>

          <section className="card p-5 sm:p-6" aria-label="Key supporting documentation">
            <h3 className="text-md font-semibold text-ink">Key supporting documentation</h3>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {(['request', 'receipt', 'payment'] as const).map((g) => (
                <div key={g} className="rounded-xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line">
                  <p className="eyebrow">{KSD_GROUPS.find((x) => x.key === g)!.label}</p>
                  <ul className="mt-2 space-y-1.5">{m.ksd[g].map((i) => <li key={i} className="flex gap-2 text-sm text-ink"><FileCheck2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" aria-hidden />{i}</li>)}</ul>
                </div>
              ))}
            </div>
            {m.ksd.note && <div className="mt-3"><Note tone="warn">{m.ksd.note}</Note></div>}
          </section>

          <section className="card p-5 sm:p-6">
            <div className="flex items-center justify-between gap-2"><h3 className="text-md font-semibold text-ink">Verification</h3><span className="cite bg-info/10 text-info">editorial</span></div>
            <p className="mt-2 text-sm leading-relaxed text-ink-2">{m.verification}</p>
            {(m.limits?.length || m.discrepancies.length) ? (
              <div className="mt-4 space-y-2">
                {m.limits?.map((l) => <Note key={l} tone="bad">{l}</Note>)}
                {m.discrepancies.map((d) => <Note key={d.text} tone="warn">{d.text} <CiteChip c={d.cite} /></Note>)}
              </div>
            ) : null}
            <p className="mt-4 text-xs text-ink-3">{PAYMENT_TIMING.text}</p>
          </section>
        </article>
      </div>
    </div>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-surface-2/70 p-3.5 ring-1 ring-inset ring-line">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 text-sm leading-snug text-ink">{value}</dd>
      {hint && <dd className="mt-1 text-2xs leading-snug text-ink-3">{hint}</dd>}
    </div>
  );
}

function Router() {
  const [kind, setKind] = useState<'good' | 'service' | 'fuel' | 'travel'>('good');
  const [nsn, setNsn] = useState<'yes' | 'no'>('no');
  const [use, setUse] = useState<'office' | 'maintenance'>('office');
  const [dod, setDod] = useState(false);
  const [complex, setComplex] = useState(false);
  const [amount, setAmount] = useState('');
  const parsed = amount.trim() ? parseMoney(amount) : null;
  const answer = routeRequirement({ kind, hasNsn: nsn === 'yes', nsnUse: use, fromDodComponent: dod, complex, amountCents: parsed?.ok ? parsed.cents : null });
  return (
    <Section title="Which method?" lede={`A useful requirement states: ${REQUIREMENT_ELEMENTS.join(', ').toLowerCase()}. This walks the book’s teaching router; it narrows the choice, it never decides.`} cite={ROUTING_NOTES[0].cite}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-3">
          <Segmented label="Kind of requirement" value={kind} onChange={setKind} options={[{ value: 'good', label: 'Good' }, { value: 'service', label: 'Service' }, { value: 'fuel', label: 'Fuel' }, { value: 'travel', label: 'Travel' }]} />
          {(kind === 'good' || kind === 'service') && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-ink-2">
              {kind === 'good' && <label className="flex items-center gap-2"><input type="checkbox" checked={nsn === 'yes'} onChange={(e) => setNsn(e.target.checked ? 'yes' : 'no')} />Has an NSN</label>}
              {kind === 'good' && nsn === 'yes' && <Segmented size="sm" label="Use" value={use} onChange={setUse} options={[{ value: 'office', label: 'Office supplies' }, { value: 'maintenance', label: 'Maintenance parts' }]} />}
              <label className="flex items-center gap-2"><input type="checkbox" checked={dod} onChange={(e) => setDod(e.target.checked)} />From another DoD component</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={complex} onChange={(e) => setComplex(e.target.checked)} />Complex requirement</label>
            </div>
          )}
          {(kind === 'good' || kind === 'service') && <Field label="Amount" hint="Optional"><NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" /></Field>}
        </div>
        <div className="rounded-2xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line">
          <p className="eyebrow">Candidates</p>
          <div className="mt-2 flex flex-wrap gap-2">{answer.methods.map((k) => <Link key={k} to={`/reference?tab=methods&method=${k}`} className="inline-flex items-center gap-1.5 rounded-lg bg-surface px-3 py-1.5 text-sm font-semibold text-ink shadow-card hover:shadow-lift"><Split className="h-3.5 w-3.5 text-accent" />{METHODS[k].name}</Link>)}</div>
          <ul className="mt-3 space-y-1 text-sm text-ink-2">{answer.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          <ul className="mt-2 space-y-1 text-xs text-warn">{answer.cautions.map((c) => <li key={c} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />{c}</li>)}</ul>
        </div>
      </div>
      <details className="mt-5 rounded-xl ring-1 ring-inset ring-line">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink">The routing table, printed thresholds and approval chain</summary>
        <div className="space-y-4 px-4 pb-4">
          <DataTable head={['Requirement', 'Method', 'Key condition']} rows={ROUTING.map((r) => [r.requirement, r.methods.map((k) => METHODS[k].short).join(' or '), r.condition])} />
          <div className="flex flex-wrap gap-2">{PRINTED_THRESHOLDS.map((t) => <span key={t.category} className="chip">{t.category}: <span className="fig font-semibold text-ink">{formatCents(t.cents)}</span></span>)}</div>
          <Note tone="warn">{THRESHOLD_NOTE}</Note>
          {ROUTING_NOTES.slice(1).map((n) => <Note key={n.text}>{n.text}</Note>)}
          <ol className="flex flex-wrap items-center gap-2 text-sm">{APPROVAL_CHAIN.map((a, i) => <li key={a.who} className="flex items-center gap-2"><span className="rounded-lg bg-surface-2 px-2.5 py-1 ring-1 ring-inset ring-line"><span className="font-medium text-ink">{a.who}</span> <span className="text-ink-3">{a.does.toLowerCase()}</span></span>{i < APPROVAL_CHAIN.length - 1 && <ChevronRight className="h-3.5 w-3.5 text-ink-3" aria-hidden />}</li>)}</ol>
          <p className="text-xs text-ink-3">Travel uses its own DTS routing and Approving Official.</p>
        </div>
      </details>
    </Section>
  );
}

/* ── Open balances ─────────────────────────────────────────────────────────────────────────── */

function ConditionsTab() {
  return (
    <div className="space-y-5">
      <Note>A report identifies a condition, not its cause. An open balance may be valid while the next lifecycle event is pending. Age, amount, method, documents and system status decide whether an item needs corrective action — age alone never does.</Note>
      {NORMAL_LIST.map((c) => (
        <Section key={c.key} id={c.key} title={`${c.abbr} — ${c.name}`} lede={c.whatIsOpen} cite={c.cite}>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <div className="space-y-4">
              <div className="rounded-xl bg-accent-soft/60 px-4 py-3 ring-1 ring-inset ring-accent/15"><p className="eyebrow text-accent">First question</p><p className="mt-1 text-sm font-medium text-ink">{c.firstQuestion}</p></div>
              {(['full', 'partial'] as const).map((pattern) => {
                const ex = c.examples[pattern];
                return (
                  <div key={pattern} className="rounded-xl bg-surface-2/60 p-4 ring-1 ring-inset ring-line">
                    <p className="mb-3 flex items-center justify-between text-xs"><span className="font-semibold uppercase tracking-wider text-ink-2">{pattern} pattern</span><span className="text-ink-3">classroom example</span></p>
                    <LifecycleBars compact travel={c.key === 'oto'} figures={{ commitment: ex.commitment == null ? null : ex.commitment * 100, obligation: ex.obligation == null ? null : ex.obligation * 100, delivered: ex.delivered == null ? null : ex.delivered * 100, paid: ex.paid == null ? null : ex.paid * 100 }} />
                    <p className="mt-3 text-xs text-ink-2">{ex.explanation}</p>
                  </div>
                );
              })}
              <p className="font-mono text-2xs text-ink-3">{c.abbr} = {c.formula}</p>
            </div>
            <div>
              <p className="eyebrow mb-2.5">Causes, what tells them apart, and the supported path</p>
              <ul className="space-y-2.5">
                {c.causes.map((cause) => (
                  <li key={cause.key} className="rounded-xl p-4 ring-1 ring-inset ring-line">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">{cause.label}
                      <span className="chip">{cause.pattern === 'both' ? 'full or partial' : cause.pattern}</span>
                      {cause.valid && <span className="chip bg-good/10 text-good ring-1 ring-inset ring-good/20">valid — monitor</span>}
                    </p>
                    <p className="mt-1.5 text-sm text-ink-2"><span className="text-ink-3">Research: </span>{cause.research}</p>
                    <p className="mt-1 text-sm text-ink-2"><span className="text-ink-3">Path: </span>{cause.correction}</p>
                  </li>
                ))}
              </ul>
              <div className="mt-4 space-y-2">
                <Note><span className="font-medium text-ink">Verification.</span> {c.verification}</Note>
                {c.guard && <Note tone="bad">{c.guard}</Note>}
              </div>
            </div>
          </div>
        </Section>
      ))}
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Research before action" cite={{ chapter: '9.1', pages: '103-108' }}>
          <p className="eyebrow mb-2">Review</p>
          <div className="mb-4 flex flex-wrap gap-1.5">{RESEARCH_FACTORS.map((f) => <span key={f} className="chip">{f}</span>)}</div>
          <p className="eyebrow mb-2">Sequence</p>
          <Bullets ordered items={RESEARCH_SEQUENCE} />
          <p className="mt-3 text-xs text-ink-3">{ANALYSIS_TYPES.trend} {ANALYSIS_TYPES.rootCause}</p>
        </Section>
        <Section title="Reading a report" cite={KPI.cite}>
          <p className="text-sm leading-relaxed text-ink-2">{KPI.definition}</p>
          <div className="my-3 flex flex-wrap gap-1.5">{KPI.kinds.map((k) => <span key={k.key} className="chip">{k.label}</span>)}</div>
          <p className="text-xs text-ink-3">{KPI.kindsNote}</p>
          <p className="mt-4 text-sm text-ink-2">{OAS.summary}</p>
          <div className="mt-2 grid grid-cols-2 gap-2">{OAS.categories.map((c) => <div key={c.key} className="rounded-lg bg-surface-2/70 px-3 py-2 ring-1 ring-inset ring-line"><span className="font-mono text-xs font-semibold text-accent">{c.key}</span> <span className="text-xs text-ink-2">{c.use}</span></div>)}</div>
          <div className="mt-3"><Note>{OAS.practice}</Note></div>
        </Section>
      </div>
      <Section title="Before you subtract anything">
        <div className="space-y-2">{REPORT_NOTES.map((n) => <Note key={n.text} tone={n.cite.kind === 'discrepancy' ? 'warn' : 'info'}>{n.text}</Note>)}</div>
      </Section>
    </div>
  );
}

/* ── Abnormal conditions and UMTs ──────────────────────────────────────────────────────────── */

function AbnormalTab() {
  return (
    <div className="space-y-5">
      <Section title="Abnormal conditions" lede={`${ABNORMAL.definition} ${ABNORMAL.consequence}`} cite={ABNORMAL.cite}>
        <div className="mb-4 flex flex-wrap gap-1.5">{ABNORMAL.triggers.map((t) => <span key={t} className="chip">{t}</span>)}</div>
        <DataTable head={['Error class', 'Where it appears', 'Why that matters']} rows={ERROR_CLASSES.map((e) => [e.label, e.where, e.why])} />
        <div className="mt-4 grid gap-2 sm:grid-cols-2">{MATCHING.map((m) => <div key={m.key} className="rounded-xl bg-surface-2/70 p-3.5 ring-1 ring-inset ring-line"><p className="text-sm font-semibold text-ink">{m.label}</p><p className="text-xs text-ink-2">Compares {m.compares.charAt(0).toLowerCase()}{m.compares.slice(1)}</p></div>)}</div>
        <p className="mt-2 text-xs text-ink-3">{MATCHING_NOTE}</p>
      </Section>

      <Section id="umt" title="Unmatched transactions" lede={UMT.definition} cite={UMT.cite}>
        <Note tone="warn">{UMT.objective}</Note>
        <ol className="mt-5 grid gap-3 md:grid-cols-4">
          {UMT_STAGES.map((st) => (
            <li key={st.stage} className="rounded-xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line">
              <p className="fig text-2xs font-semibold uppercase tracking-wider text-accent">Stage {st.stage}</p>
              <p className="mt-1 text-sm font-semibold text-ink">{st.title}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-ink-2">{st.detail}</p>
            </li>
          ))}
        </ol>
        <h3 className="mb-3 mt-6 text-md font-semibold text-ink">The five error descriptions, and their corrections</h3>
        <DataTable head={['Report says', 'Correction', 'Route', 'Validate first']} minWidth={760}
          rows={[...UMT_ERRORS.map((e) => [e.label, e.correction, <RouteChip key={e.key} route={e.route} />, e.validate]),
            [UMT_INSUFFICIENT_FUNDS.label, UMT_INSUFFICIENT_FUNDS.correction, <RouteChip key="funds" route="NON-1081" />, 'A source-listed cause outside the five-row p. 117 table.']]} />
        <div className="mt-5 grid gap-3 md:grid-cols-2">
          {(Object.keys(ROUTES) as Array<keyof typeof ROUTES>).map((r) => (
            <div key={r} className="rounded-xl p-4 ring-1 ring-inset ring-line"><RouteChip route={r} /><p className="mt-2 text-sm font-medium text-ink">Performed by {ROUTES[r].performer}</p><p className="mt-1 text-xs text-ink-2">{ROUTES[r].purpose}</p></div>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-3">{ROUTE_LIMIT}</p>
        <div className="mt-5 grid gap-5 lg:grid-cols-3">
          <div><p className="eyebrow mb-2">Common causes</p><Bullets items={UMT.causes} /></div>
          <div><p className="eyebrow mb-2">Research fields</p><div className="flex flex-wrap gap-1.5">{UMT_RESEARCH_FIELDS.map((f) => <span key={f} className="chip">{f}</span>)}</div></div>
          <div><p className="eyebrow mb-2">Done means</p><ul className="space-y-1.5">{UMT_COMPLETION.map((c) => <li key={c} className="flex gap-2 text-sm text-ink-2"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-good" aria-hidden />{c}</li>)}</ul></div>
        </div>
        <div className="mt-5"><Note tone="bad">{UMT.warning}</Note></div>
        <div className="mt-5">
          <p className="eyebrow mb-2">Waiting states that keep separate events separate</p>
          <ol className="flex flex-wrap items-center gap-1.5">{CORRECTION_STATES.map((s, i) => <li key={s.key} className="flex items-center gap-1.5"><span className="chip">{s.label}</span>{i < CORRECTION_STATES.length - 1 && <ChevronRight className="h-3 w-3 text-ink-3" aria-hidden />}</li>)}</ol>
        </div>
      </Section>

      <Section id="holds" title="Invoices on hold" lede={INVOICE_HOLDS.meaning} cite={INVOICE_HOLDS.cite}>
        <DataTable head={['Condition', 'Match', 'Research', 'Correction']} rows={INVOICE_HOLDS.causes.map((c) => [c.label, c.match, c.research, c.correction])} minWidth={720} />
        <div className="mt-4"><Note tone="bad">{INVOICE_HOLDS.guard}</Note></div>
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        {(['dts', 'gcss'] as const).map((k) => (
          <Section key={k} title={`${FEEDER_REJECTS[k].system} rejects`} cite={FEEDER_REJECTS[k].cite}>
            <div className="space-y-3">
              {FEEDER_REJECTS[k].causes.map((c) => (
                <div key={c.key} className="rounded-xl p-4 ring-1 ring-inset ring-line">
                  <p className="text-sm font-semibold text-ink">{c.label}</p>
                  <p className="mt-1 text-sm text-ink-2">{c.research}</p>
                  {c.order && <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-2">{c.order.map((o, i) => <span key={o} className="flex items-center gap-1.5"><span className="chip">{i + 1}. {o}</span>{i < c.order!.length - 1 && <ArrowRight className="h-3 w-3" aria-hidden />}</span>)}</p>}
                  <p className="mt-2 text-xs text-ink-3">{c.correction}</p>
                </div>
              ))}
              <Note>{FEEDER_REJECTS[k].verification}</Note>
            </div>
          </Section>
        ))}
      </div>

      <Section title="ServMart and fuel interface errors" cite={INTERFACE_ERRORS.cite}>
        <div className="grid gap-3 md:grid-cols-3">{INTERFACE_ERRORS.causes.map((c) => <div key={c.key} className="rounded-xl p-4 ring-1 ring-inset ring-line"><p className="text-sm font-semibold text-ink">{c.label}</p><p className="mt-1 text-sm text-ink-2">{c.research}</p><p className="mt-2 text-xs text-ink-3">{c.correction}</p></div>)}</div>
        <div className="mt-4 space-y-2"><Note>{INTERFACE_ERRORS.verification}</Note><Note tone="bad">{INTERFACE_ERRORS.guard}</Note></div>
      </Section>
    </div>
  );
}

const RouteChip = ({ route }: { route: string }) => (
  <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 font-mono text-2xs font-semibold ring-1 ring-inset', route === '1081' ? 'bg-warn/10 text-warn ring-warn/25' : 'bg-accent-soft text-accent ring-accent/20')}>{route}</span>
);

/* ── Roles ─────────────────────────────────────────────────────────────────────────────────── */

function RolesTab() {
  return (
    <div className="space-y-5">
      <Section title="Four facts that look alike" lede="A job title does not establish every permission a transaction needs. Keep these apart — a person, and any tool, should." cite={SEPARATION_OF_DUTIES.cite}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {AUTHORITY_FACTS.map((f) => <div key={f.key} className="rounded-xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line"><KeyRound className="h-4 w-4 text-accent" aria-hidden /><p className="mt-2 text-sm font-semibold text-ink">{f.label}</p><p className="mt-1 text-xs leading-relaxed text-ink-2">{f.meaning}</p></div>)}
        </div>
      </Section>
      <Section title="DAI responsibilities" lede="The book’s role labels and typical users — not a determination of anybody’s current access." cite={{ chapter: '4.3', pages: '59-64' }}>
        <DataTable head={['Responsibility', 'Capability', 'Typical user', '']} minWidth={760}
          rows={DAI_RESPONSIBILITIES.map((r) => [r.name, <span key={r.key}>{r.capability}{r.note && <span className="mt-1 block text-xs text-warn">{r.note}</span>}</span>, r.typical, r.writes ? <span key="w" className="chip bg-warn/10 text-warn">changes records</span> : <span key="r" className="chip">read only</span>])} />
      </Section>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Separation of duties" lede={SEPARATION_OF_DUTIES.definition}>
          <Bullets items={SEPARATION_OF_DUTIES.rules} />
          <p className="mt-3 text-xs text-ink-3">{SEPARATION_OF_DUTIES.access}</p>
          <p className="eyebrow mb-2 mt-5">A useful role record keeps</p>
          <div className="flex flex-wrap gap-1.5">{ROLE_RECORD_FIELDS.map((f) => <span key={f} className="chip">{f}</span>)}</div>
        </Section>
        <Section title="Certifier and proxy">
          <div className="space-y-4">{SPECIAL_ROLES.map((r) => <div key={r.key}><p className="text-sm font-semibold text-ink">{r.name}</p><p className="mt-1 text-sm text-ink-2">{r.meaning}</p><div className="mt-2"><Note tone="warn">{r.rule}</Note></div></div>)}</div>
        </Section>
      </div>
      <Section title="People in the procurement chain" cite={{ chapter: '1.3', pages: '7-10' }}>
        <DataTable head={['Person or billet', 'Responsibility']} rows={PROCUREMENT_PEOPLE.map((p) => [p.who, p.does])} />
      </Section>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="The comptroller organization" lede={COMPTROLLER_OFFICE.mission} cite={COMPTROLLER_OFFICE.cite}>
          <div className="space-y-2.5">{COMPTROLLER_GROUPS.map((g) => <div key={g.title} className="rounded-xl p-3.5 ring-1 ring-inset ring-line"><p className="text-sm font-semibold text-ink">{g.title}</p><p className="font-mono text-2xs text-ink-3">{g.mos}</p><p className="mt-1 text-xs text-ink-2">{g.focus}</p></div>)}</div>
          <p className="eyebrow mb-2 mt-4">Accounting work</p>
          <div className="flex flex-wrap gap-1.5">{COMPTROLLER_OFFICE.accountingWork.map((w) => <span key={w} className="chip">{w}</span>)}</div>
          <p className="mt-3 text-xs text-ink-3">{COMPTROLLER_OFFICE.staffingNote}</p>
        </Section>
        <Section title="The operating environment" lede={MISSION} cite={ORG_MODEL.cite}>
          <div className="grid grid-cols-2 gap-2">{MAGTF.map((e) => <div key={e.key} className="rounded-lg bg-surface-2/70 px-3 py-2 ring-1 ring-inset ring-line"><span className="font-mono text-xs font-semibold text-accent">{e.key}</span> <span className="text-xs font-medium text-ink">{e.name}</span><p className="text-2xs text-ink-2">{e.function}</p></div>)}</div>
          <p className="mt-4 flex flex-wrap items-center gap-1.5 text-xs">{ORG_MODEL.chain.map((c, i) => <span key={c} className="flex items-center gap-1.5"><span className="chip">{c}</span>{i < ORG_MODEL.chain.length - 1 && <ChevronRight className="h-3 w-3 text-ink-3" aria-hidden />}</span>)}</p>
          <p className="mt-2 text-xs text-ink-3">{ORG_MODEL.note}</p>
          <details className="mt-3 rounded-xl ring-1 ring-inset ring-line">
            <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium text-ink">Formations and staff sections</summary>
            <div className="space-y-3 px-3.5 pb-3.5 text-xs text-ink-2">
              <p>{ORG_MODEL.mef}</p><p>{ORG_MODEL.usingUnits}</p>
              {GROUND_UNITS.map((u) => <p key={u.unit}><span className="font-medium text-ink">{u.unit}</span> ({u.led}). {u.detail}</p>)}
              <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">{STAFF_SECTIONS.map((s) => <p key={s.key}><span className="font-mono font-semibold text-ink">{s.key}</span> {s.function}</p>)}</div>
              <p className="text-warn">{ORG_NOTE.text}</p>
            </div>
          </details>
        </Section>
      </div>
    </div>
  );
}

/* ── Financial data ────────────────────────────────────────────────────────────────────────── */

function DataTab() {
  return (
    <div className="space-y-5">
      <Section title="Financial data elements" lede={`${FDE.definition} ${FDE.why}`} cite={FDE.cite}>
        <p className="eyebrow mb-2">POET — training specimens, not live funding data</p>
        <div className="grid gap-3 md:grid-cols-4">{POET.map((p) => <div key={p.element} className="rounded-xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line"><p className="text-sm font-semibold text-ink">{p.element}</p><p className="mt-1 text-xs text-ink-2">{p.meaning}</p><p className="mt-2 break-all font-mono text-2xs text-ink-3">{p.example}</p></div>)}</div>
      </Section>
      <Section title="Standard Line of Accounting" lede={SLOA.definition} cite={SLOA.cite}>
        <div className="flex flex-wrap gap-1.5">{SLOA.namedFields.map((f) => <span key={f} className="chip">{f}</span>)}</div>
        <p className="mt-4 break-all rounded-xl bg-[#0A1B33] px-4 py-3 font-mono text-xs leading-relaxed text-[#bcd0ec]">{SLOA.specimen}</p>
        <div className="mt-3 space-y-2"><Note tone="warn">{SLOA.limit}</Note><Note>{SLOA.translation}</Note></div>
      </Section>
      <Section title="Identifiers and what generates them" lede={JON} cite={{ chapter: '5.2', pages: '65-68, 78' }}>
        <DataTable head={['Method', 'Identifier', 'Generator or mapping', 'Owner']} rows={GENERATORS.map((g) => [g.methods.map((k) => METHODS[k as MethodKey].short).join(', '), g.identifier, g.generator, g.owner])} minWidth={720} />
        <p className="mt-3 text-xs text-ink-3">FCCCB: {FCCCB}</p>
      </Section>
      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Shared setup before execution" cite={SETUP_RULE.cite}>
          <Bullets ordered items={SHARED_SETUP} />
          <div className="mt-4"><Note tone="warn">{SETUP_RULE.text}</Note></div>
        </Section>
        <Section title="What each method adds">
          <div className="space-y-2.5">{METHOD_SETUP.map((m) => <div key={m.adds} className="flex items-start justify-between gap-3 rounded-xl p-3.5 ring-1 ring-inset ring-line"><span className="text-sm text-ink">{m.adds}</span><span className="flex shrink-0 gap-1">{m.methods.map((k) => <span key={k} className="chip">{METHODS[k as MethodKey].short}</span>)}</span></div>)}</div>
        </Section>
      </div>
    </div>
  );
}

/* ── Glossary ──────────────────────────────────────────────────────────────────────────────── */

function GlossaryTab() {
  const [q, setQ] = useParam('q', '');
  const terms = useMemo(() => searchGlossary(q), [q]);
  return (
    <div className="card p-5 sm:p-6">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" aria-hidden />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search terms — UMT, KSD, POET…" className="pl-9" aria-label="Search the glossary" />
      </div>
      <p className="mt-2 text-xs text-ink-3">{terms.length} {terms.length === 1 ? 'term' : 'terms'}</p>
      <dl className="mt-4 grid gap-x-8 md:grid-cols-2">
        {terms.map((t) => (
          <div key={t.term} className="border-b border-line py-3">
            <dt className="text-sm font-semibold text-ink">{t.term}</dt>
            <dd className="mt-0.5 text-sm leading-relaxed text-ink-2">{t.meaning}</dd>
          </div>
        ))}
      </dl>
      {!terms.length && <p className="py-10 text-center text-sm text-ink-3">No term matches “{q}”.</p>}
    </div>
  );
}

/* ── Source and limits ─────────────────────────────────────────────────────────────────────── */

function LimitsTab() {
  return (
    <div className="space-y-5">
      <section className="card overflow-hidden">
        <div className="relative bg-[#0A1B33] px-6 py-7 text-white">
          <div className="pointer-events-none absolute inset-0 [background:radial-gradient(80%_120%_at_100%_0%,rgb(37_99_235/.35),transparent_60%)]" aria-hidden />
          <p className="relative text-2xs font-semibold uppercase tracking-[0.14em] text-white/60">Source</p>
          <h2 className="relative mt-2 text-2xl font-semibold tracking-[-0.025em]">{FMRAC_SOURCE.title}</h2>
          <p className="relative mt-1 text-sm text-white/70">{FMRAC_SOURCE.subtitle}. {FMRAC_SOURCE.basis} {FMRAC_SOURCE.edition}.</p>
          <p className="relative mt-3 inline-flex rounded-full bg-white/10 px-3 py-1 text-xs text-white/80 ring-1 ring-white/15">{FMRAC_SOURCE.marking}</p>
        </div>
        <div className="p-6">
          <p className="text-sm leading-relaxed text-ink-2">{FMRAC_SOURCE.scope}</p>
          <div className="mt-4"><Bullets items={FMRAC_SOURCE.limits} /></div>
          <div className="mt-5 flex flex-wrap gap-2">
            <CiteChip c={{ chapter: '8.3', pages: '100-102' }} /><CiteChip c={{ chapter: '6.3', kind: 'editorial' }} /><CiteChip c={{ chapter: '7.1', pages: '39, 70, 79', kind: 'discrepancy' }} />
          </div>
          <p className="mt-2 text-xs text-ink-3">How a citation reads: the rewritten reference’s chapter, the original guide’s pages, and whether it restates the source, is editorial guidance, or records a discrepancy.</p>
        </div>
      </section>

      <Section title="Discrepancy register" lede="Where the book conflicts with itself or is incomplete, and how Vantage treats it. Kept visible, so a cleaner presentation never looks more certain than its source." cite={{ chapter: '13' }}>
        <DataTable head={['Original pages', 'Issue', 'Treatment']} rows={DISCREPANCIES.map((d) => [<span key={d.pages} className="fig">{d.pages}</span>, d.issue, d.treatment])} minWidth={720} />
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Not taught, and not invented" lede="The book does not fully teach these. Vantage does not fill the gaps with guessed steps.">
          <Bullets items={NOT_TAUGHT} />
        </Section>
        <Section title="Never" lede="What an answer — a person’s, Vantage’s, or an AI’s — must never do." cite={{ chapter: '12.4', kind: 'editorial' }}>
          <ul className="space-y-2">{NEVER.map((n) => <li key={n} className="flex gap-2.5 text-sm text-ink"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-bad" aria-hidden />{n}</li>)}</ul>
        </Section>
      </div>

      <Section title="Keep facts, observations and inferences distinct" lede={INFERENCE_RULE} cite={{ chapter: '12.1', kind: 'editorial' }}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{STATEMENT_TYPES.map((t) => <div key={t.key} className="rounded-xl bg-surface-2/70 p-4 ring-1 ring-inset ring-line"><p className="text-sm font-semibold text-ink">{t.label}</p><p className="mt-1 text-xs text-ink-2">{t.meaning}</p><p className="mt-2 text-2xs italic text-ink-3">“{t.example}”</p></div>)}</div>
      </Section>

      <Section title="The case record, and where Vantage keeps it" cite={{ chapter: '12.2', kind: 'editorial' }}>
        <DataTable head={['Field', 'What to capture', 'In Vantage']} rows={CASE_RECORD.map((c) => [c.field, c.capture, c.vantage])} minWidth={760} />
      </Section>

      <Section title="The answer format" lede="Condition and evidence first, then the supported next action. The diagnoser answers in this order." cite={{ chapter: '12.4', kind: 'editorial' }}>
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">{ANSWER_FORMAT.map((a, i) => <li key={a.key} className="rounded-xl p-3.5 ring-1 ring-inset ring-line"><p className="fig text-2xs font-semibold text-accent">{i + 1}</p><p className="text-sm font-semibold text-ink">{a.label}</p><p className="mt-0.5 text-xs text-ink-2">{a.question}</p></li>)}</ol>
      </Section>

      <p className="flex items-center gap-2 text-xs text-ink-3"><ScrollText className="h-3.5 w-3.5" aria-hidden />{STATEMENT_LABEL.source}, {STATEMENT_LABEL.editorial.toLowerCase()} and {STATEMENT_LABEL.discrepancy.toLowerCase()} are labelled throughout. <Layers className="h-3.5 w-3.5" aria-hidden />Procedures built from this reference carry the authority “{AUTHORITY_LABEL.training_reference}”.</p>
    </div>
  );
}
