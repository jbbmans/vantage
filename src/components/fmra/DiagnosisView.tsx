import { AlertTriangle, BookOpen, CheckCircle2, FileSearch, ListChecks, Route, ShieldCheck, Stethoscope, Users } from 'lucide-react';
import type { Diagnosis } from '../../../shared/fmra';
import { formatCents } from '../../../shared/money';
import { PROCEDURES } from '../../../shared/procedures';
import { cn } from '@/lib/utils';

/**
 * A diagnosis, laid out the way the FMRAC says an answer should be: what the record shows and what
 * it means first, then causes, research, who can act, what to do, and what proves it — with the
 * references and limits last, and never dropped.
 */
export default function DiagnosisView({ d, compact = false }: { d: Diagnosis; compact?: boolean }) {
  const procedure = d.procedure ? PROCEDURES[d.procedure] : null;
  return (
    <div className="space-y-5">
      <section aria-label="Observed condition">
        <div className="flex flex-wrap gap-2">
          {d.findings.map((f) => (
            <span key={f.condition} className="inline-flex items-center gap-2 rounded-lg bg-warn/10 px-2.5 py-1.5 text-sm font-medium text-ink ring-1 ring-inset ring-warn/25">
              <AlertTriangle className="h-3.5 w-3.5 text-warn" aria-hidden />
              <span className="font-semibold">{f.abbr}</span>
              <span className="text-ink-2">{f.pattern === 'full' ? 'full' : 'partial'}</span>
              <span className="fig font-semibold">{formatCents(f.residualCents)}</span>
            </span>
          ))}
          {d.anomalies.map((a) => (
            <span key={a.key} className="inline-flex items-center gap-2 rounded-lg bg-bad/10 px-2.5 py-1.5 text-sm font-medium text-bad ring-1 ring-inset ring-bad/25">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />{a.title}
            </span>
          ))}
          {d.complete && (
            <span className="inline-flex items-center gap-2 rounded-lg bg-good/10 px-2.5 py-1.5 text-sm font-medium text-good ring-1 ring-inset ring-good/25">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />Nothing open between phases
            </span>
          )}
        </div>
        <p className="mt-3 text-sm leading-relaxed text-ink-2"><span className="font-medium text-ink">Observed.</span> {d.observed}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-2"><span className="font-medium text-ink">Financial meaning.</span> {d.meaning}</p>
        {d.findings.map((f) => <p key={f.condition} className="mt-1 font-mono text-2xs text-ink-3">{f.abbr} = {f.arithmetic}</p>)}
      </section>

      {d.error && (
        <Part icon={Route} n={0} title={`Report error: ${d.error.label}`}>
          <p className="text-sm text-ink">{d.error.correction}</p>
          {d.error.route && <p className="mt-1.5 text-xs text-ink-2">Posting route: <span className="font-semibold text-ink">{d.error.route}</span></p>}
          {d.error.validate && <p className="mt-1.5 text-xs text-ink-3">First: {d.error.validate}</p>}
        </Part>
      )}

      {d.causes.length > 0 && (
        <Part icon={Stethoscope} n={3} title="Possible causes">
          <ul className="grid gap-2 sm:grid-cols-2">
            {d.causes.map((c) => (
              <li key={`${c.condition}-${c.key}`} className="rounded-xl bg-surface-2/70 p-3 ring-1 ring-inset ring-line">
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  {c.label}
                  {c.valid && <span className="rounded-md bg-good/10 px-1.5 py-0.5 text-2xs font-medium text-good">may be valid</span>}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-ink-2"><span className="text-ink-3">Tell it apart: </span>{c.research}</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-2"><span className="text-ink-3">If so: </span>{c.correction}</p>
              </li>
            ))}
          </ul>
        </Part>
      )}

      {!compact && d.research.length > 0 && (
        <Part icon={FileSearch} n={4} title="Required research">
          <List items={d.research} />
        </Part>
      )}

      {d.evidence.length > 0 && (
        <Part icon={ListChecks} n={4} title="Evidence to pull for this method">
          <div className="grid gap-2 sm:grid-cols-3">
            {d.evidence.map((g) => (
              <div key={g.group} className="rounded-xl bg-surface-2/70 p-3 ring-1 ring-inset ring-line">
                <p className="eyebrow">{g.group}</p>
                <ul className="mt-1.5 space-y-1 text-xs text-ink">{g.items.map((i) => <li key={i}>{i}</li>)}</ul>
              </div>
            ))}
          </div>
        </Part>
      )}

      <Part icon={Users} n={5} title="Who can act">
        <div className="flex flex-wrap gap-1.5">{d.roles.map((r) => <span key={r} className="chip">{r}</span>)}</div>
        <p className="mt-2 text-xs text-ink-3">A DAI responsibility is a system capability, not an appointment. Research access never authorizes an award, a receipt or a payment correction.</p>
      </Part>

      <Part icon={Route} n={6} title="Next action">
        <List items={d.next} />
        {procedure && (
          <p className="mt-2 text-xs text-ink-2">Vantage procedure that fits: <span className="font-semibold text-ink">{procedure.title}</span></p>
        )}
      </Part>

      <Part icon={ShieldCheck} n={7} title="Wait and verification">
        <List items={d.verification} />
      </Part>

      <Part icon={BookOpen} n={8} title="References and limits">
        <div className="mb-2 flex flex-wrap gap-1.5">{d.references.map((r) => <span key={r} className="cite">{r}</span>)}</div>
        <List items={d.limits} muted />
      </Part>
    </div>
  );
}

function Part({ icon: Icon, n, title, children }: { icon: React.ComponentType<{ className?: string }>; n: number; title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="border-t border-line pt-4">
      <h3 className="mb-2.5 flex items-center gap-2 text-sm font-semibold text-ink">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-2 text-ink-3 ring-1 ring-inset ring-line"><Icon className="h-3.5 w-3.5" /></span>
        {n > 0 && <span className="fig text-ink-3">{n}.</span>}{title}
      </h3>
      {children}
    </section>
  );
}

function List({ items, muted = false }: { items: string[]; muted?: boolean }) {
  return (
    <ul className="space-y-1.5">
      {items.map((t) => (
        <li key={t} className={cn('flex gap-2 text-sm leading-relaxed', muted ? 'text-ink-3' : 'text-ink-2')}>
          <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-3/60" aria-hidden />{t}
        </li>
      ))}
    </ul>
  );
}
